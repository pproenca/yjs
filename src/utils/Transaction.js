import * as error from 'lib0/error'
import * as map from 'lib0/map'
import * as math from 'lib0/math'
import * as logging from 'lib0/logging'
import { callAll } from 'lib0/function'

import { ContentFormat } from '../structs/Item.js'
import { getStateVector } from './StructStore.js'
import { callEventHandlerListeners } from './EventHandler.js'
import { createIdSet, isIdSetEmptyCanonical, iterateStructsByIdSet } from './ids.js'
import { GC } from '../structs/GC.js'
import { YEvent } from './YEvent.js'
import { writeUpdateMessageFromTransaction } from './encoding-helpers.js'
import { IdSetEncoderV1, IdSetEncoderV2, UpdateEncoderV1, UpdateEncoderV2 } from './UpdateEncoder.js'
import { findIndexSS, updateCurrentFormats, cleanupFormattingGap, tryGcDeleteSet, tryMerge, tryToMergeWithLefts, cleanupContextlessFormattingGap } from './transaction-helpers.js'
import { activateReservedMutationTransaction, assertReservedMutationTransactionRuntime, beginReservedMutationCleanup, deactivateReservedMutationTransaction, isReservedMutationTransactionActive, readReservedMutationAccounting, readReservedMutationTransactionRuntime, writeReservedMutationUpdate } from './reserved-mutation-runtime.js'
import * as random from 'lib0/random'

export const generateNewClientId = random.uint53

const objectFreeze = Object.freeze
const reflectApply = Reflect.apply
const NativeMap = Map
const NativeSet = Set
const reservedEncoderV1Kernel = objectFreeze({
  toUint8Array: IdSetEncoderV1.prototype.toUint8Array,
  resetIdSetCurVal: IdSetEncoderV1.prototype.resetIdSetCurVal,
  writeIdSetClock: IdSetEncoderV1.prototype.writeIdSetClock,
  writeIdSetLen: IdSetEncoderV1.prototype.writeIdSetLen,
  writeLeftID: UpdateEncoderV1.prototype.writeLeftID,
  writeRightID: UpdateEncoderV1.prototype.writeRightID,
  writeClient: UpdateEncoderV1.prototype.writeClient,
  writeInfo: UpdateEncoderV1.prototype.writeInfo,
  writeString: UpdateEncoderV1.prototype.writeString,
  writeParentInfo: UpdateEncoderV1.prototype.writeParentInfo,
  writeTypeRef: UpdateEncoderV1.prototype.writeTypeRef,
  writeLen: UpdateEncoderV1.prototype.writeLen,
  writeAny: UpdateEncoderV1.prototype.writeAny,
  writeBuf: UpdateEncoderV1.prototype.writeBuf,
  writeJSON: UpdateEncoderV1.prototype.writeJSON,
  writeKey: UpdateEncoderV1.prototype.writeKey
})
const reservedEncoderV2Kernel = objectFreeze({
  toUint8Array: UpdateEncoderV2.prototype.toUint8Array,
  resetIdSetCurVal: IdSetEncoderV2.prototype.resetIdSetCurVal,
  writeIdSetClock: IdSetEncoderV2.prototype.writeIdSetClock,
  writeIdSetLen: IdSetEncoderV2.prototype.writeIdSetLen,
  writeLeftID: UpdateEncoderV2.prototype.writeLeftID,
  writeRightID: UpdateEncoderV2.prototype.writeRightID,
  writeClient: UpdateEncoderV2.prototype.writeClient,
  writeInfo: UpdateEncoderV2.prototype.writeInfo,
  writeString: UpdateEncoderV2.prototype.writeString,
  writeParentInfo: UpdateEncoderV2.prototype.writeParentInfo,
  writeTypeRef: UpdateEncoderV2.prototype.writeTypeRef,
  writeLen: UpdateEncoderV2.prototype.writeLen,
  writeAny: UpdateEncoderV2.prototype.writeAny,
  writeBuf: UpdateEncoderV2.prototype.writeBuf,
  writeJSON: UpdateEncoderV2.prototype.writeJSON,
  writeKey: UpdateEncoderV2.prototype.writeKey
})

/** @param {UpdateEncoderV1|UpdateEncoderV2} encoder @param {typeof reservedEncoderV1Kernel} kernel */
const createReservedEncoder = (encoder, kernel) => {
  /** @param {Function} method */
  const call = method => /** @param {any} value */ value => reflectApply(method, encoder, [value])
  /** @param {Function} method */
  const callWithoutArguments = method => () => reflectApply(method, encoder, [])
  return objectFreeze({
    restEncoder: encoder.restEncoder,
    toUint8Array: callWithoutArguments(kernel.toUint8Array),
    resetIdSetCurVal: callWithoutArguments(kernel.resetIdSetCurVal),
    writeIdSetClock: call(kernel.writeIdSetClock),
    writeIdSetLen: call(kernel.writeIdSetLen),
    writeLeftID: call(kernel.writeLeftID),
    writeRightID: call(kernel.writeRightID),
    writeClient: call(kernel.writeClient),
    writeInfo: call(kernel.writeInfo),
    writeString: call(kernel.writeString),
    writeParentInfo: call(kernel.writeParentInfo),
    writeTypeRef: call(kernel.writeTypeRef),
    writeLen: call(kernel.writeLen),
    writeAny: call(kernel.writeAny),
    writeBuf: call(kernel.writeBuf),
    writeJSON: call(kernel.writeJSON),
    writeKey: call(kernel.writeKey)
  })
}

/** @type {WeakMap<Doc,{revision:number}>} */
const documentStructuralRevisions = new WeakMap()
/**
 * Internal structural revision used by pre-write capabilities. The entry is allocated lazily so
 * documents without a revision consumer only pay one WeakMap lookup for nonempty cleanup.
 *
 * @param {Doc} doc
 */
export const readDocumentStructuralRevision = doc => {
  let revision = documentStructuralRevisions.get(doc)
  if (revision === undefined) {
    revision = { revision: 0 }
    documentStructuralRevisions.set(doc, revision)
  }
  return revision.revision
}

/** @param {Doc} doc */
const bumpDocumentStructuralRevision = doc => {
  const revision = documentStructuralRevisions.get(doc)
  if (revision !== undefined) revision.revision++
}

/**
 * A transaction is created for every change on the Yjs model. It is possible
 * to bundle changes on the Yjs model in a single transaction to
 * minimize the number on messages sent and the number of observer calls.
 * If possible the user of this library should bundle as many changes as
 * possible. Here is an example to illustrate the advantages of bundling:
 *
 * @example
 * const ydoc = new Y.Doc()
 * const map = ydoc.get('map')
 * // Log content when change is triggered
 * map.observe(() => {
 *   console.log('change triggered')
 * })
 * // Each change on the map type triggers a log message:
 * map.setAttr('a', 0) // => "change triggered"
 * map.setAttr('b', 0) // => "change triggered"
 * // When put in a transaction, it will trigger the log after the transaction:
 * ydoc.transact(() => {
 *   map.setAttr('a', 1)
 *   map.setAttr('b', 1)
 * }) // => "change triggered"
 *
 * @public
 */
export class Transaction {
  /**
   * @param {Doc} doc
   * @param {any} origin
   * @param {boolean} local
   */
  constructor (doc, origin, local) {
    /**
     * The Yjs instance.
     * @type {Doc}
     */
    this.doc = doc
    /**
     * Describes the set of deleted items by ids
     */
    this.deleteSet = createIdSet()
    /**
     * Describes the set of items that are cleaned up / deleted by ids. It is a subset of
     * this.deleteSet
     */
    this.cleanUps = createIdSet()
    /**
     * Describes the set of inserted items by ids
     */
    this.insertSet = createIdSet()
    /**
     * Holds the state before the transaction started.
     * @type {Map<Number,Number>?}
     */
    this._beforeState = null
    /**
     * Holds the state after the transaction.
     * @type {Map<Number,Number>?}
     */
    this._afterState = null
    /**
     * All types that were directly modified (property added or child
     * inserted/deleted). New types are not included in this Set.
     * Maps from type to parentSubs (`item.parentSub = null` for YArray)
     * @type {Map<YType,Set<String|null>>}
     */
    this.changed = new NativeMap()
    /**
     * Stores the events for the types that observe also child elements.
     * It is mainly used by `observeDeep`.
     * @type {Map<YType,Array<YEvent<any>>>}
     */
    this.changedParentTypes = new NativeMap()
    /**
     * @type {Array<AbstractStruct>}
     */
    this._mergeStructs = []
    /**
     * @type {any}
     */
    this.origin = origin
    /**
     * Stores meta information on the transaction
     * @type {Map<any,any>}
     */
    this.meta = new NativeMap()
    /**
     * Whether this change originates from this doc.
     * @type {boolean}
     */
    this.local = local
    /**
     * @type {Set<Doc>}
     */
    this.subdocsAdded = new NativeSet()
    /**
     * @type {Set<Doc>}
     */
    this.subdocsRemoved = new NativeSet()
    /**
     * @type {Set<Doc>}
     */
    this.subdocsLoaded = new NativeSet()
    /**
     * @type {boolean}
     */
    this._needFormattingCleanup = false
    this._done = false
  }

  /**
   * Holds the state before the transaction started.
   *
   * @deprecated
   * @type {Map<Number,Number>}
   */
  get beforeState () {
    if (this._beforeState == null) {
      const sv = getStateVector(this.doc.store)
      this.insertSet.clients.forEach((ranges, client) => {
        sv.set(client, ranges.getIds()[0].clock)
      })
      this._beforeState = sv
    }
    return this._beforeState
  }

  /**
   * Holds the state after the transaction.
   *
   * @deprecated
   * @type {Map<Number,Number>}
   */
  get afterState () {
    if (!this._done) error.unexpectedCase()
    if (this._afterState == null) {
      const sv = getStateVector(this.doc.store)
      this.insertSet.clients.forEach((_ranges, client) => {
        const ranges = _ranges.getIds()
        const d = ranges[ranges.length - 1]
        sv.set(client, d.clock + d.len)
      })
      this._afterState = sv
    }
    return this._afterState
  }
}

/**
 * This function is experimental and subject to change / be removed.
 *
 * Ideally, we don't need this function at all. Formats should be cleaned up
 * automatically after each change. This function iterates twice over the complete YText type
 * and removes unnecessary formats. This is also helpful for testing.
 *
 * This function won't be exported anymore as soon as there is confidence that the YText type works as intended.
 *
 * @param {YType} type
 * @return {number} How many formats have been cleaned up.
 */
export const cleanupYTextFormatting = type => {
  if (!type.doc?.cleanupFormatting) return 0
  let res = 0
  transact(/** @type {Doc} */ (type.doc), transaction => {
    let start = /** @type {Item} */ (type._start)
    let end = type._start
    let startFormats = map.create()
    const currentFormats = map.copy(startFormats)
    while (end) {
      if (end.deleted === false) {
        switch (end.content.constructor) {
          case ContentFormat:
            updateCurrentFormats(currentFormats, /** @type {ContentFormat} */ (end.content))
            break
          default:
            res += cleanupFormattingGap(transaction, start, end, startFormats, currentFormats)
            startFormats = map.copy(currentFormats)
            start = end
            break
        }
      }
      end = end.right
    }
  })
  return res
}

/**
 * @param {Array<Transaction>} transactionCleanups
 * @param {number} i
 */
const cleanupTransactions = (transactionCleanups, i) => {
  if (i < transactionCleanups.length) {
    const transaction = transactionCleanups[i]
    transaction._done = true
    const doc = transaction.doc
    const store = doc.store
    const ds = transaction.deleteSet
    const mergeStructs = transaction._mergeStructs
    const reservedRuntime = /** @type {any} */ (readReservedMutationTransactionRuntime(transaction))
    let cleanupFailed = false
    let cleanupFailure
    try {
      // insertIntoIdSet(store.ds, ds)
      if (!isIdSetEmptyCanonical(transaction.insertSet) || !isIdSetEmptyCanonical(transaction.deleteSet)) {
        bumpDocumentStructuralRevision(doc)
      }
      try {
        doc.emit('beforeObserverCalls', [transaction, doc])
        /**
         * An array of event callbacks.
         *
         * Each callback is called even if the other ones throw errors.
         *
         * @type {Array<function():void>}
         */
        const fs = []
        // observe events on changed types. Deleted types are included: `callTypeObservers` tracks
        // the event in `changedParentTypes` unconditionally (so changes inside a deleted type — e.g.
        // a suggestion-deleted tombstone that a custom renderer still renders — bubble to live
        // ancestors) and decides itself whether the type's own observers fire.
        transaction.changed.forEach((subs, itemtype) =>
          fs.push(() => {
            itemtype._callObserver(transaction, subs)
          })
        )
        fs.push(() => {
          // deep observe events + the RDT `'delta'` channel. `changedParentTypes` holds the changed
          // type AND all of its ancestors, so both `observeDeep` and `'delta'` bubble identically.
          transaction.changedParentTypes.forEach((events, type) => {
            // We need to think about the possibility that the user transforms the
            // Y.Doc in the event.
            // Deleted types are tracked (so changes inside them bubble to live ancestors) but fire
            // only while something still renders them — i.e. they have a renderer attached.
            if (type._item !== null && type._item.deleted && type._renderer === null) return
            const hasDeep = type._dEH.l.length > 0
            const hasDeltaListeners = (type._observers.get('delta')?.size ?? 0) > 0
            const maintaining = type._delta !== null
            if (!hasDeep && !hasDeltaListeners && !maintaining) return
            /**
             * @type {YEvent<any>}
             */
            const deepEventHandler = events.find(event => event.target === type) || new YEvent(type, transaction, new Set(null))
            if (hasDeep) {
              callEventHandlerListeners(type._dEH, deepEventHandler, transaction)
            }
            if (hasDeltaListeners || maintaining) {
              // the type-rooted deep delta of this transaction (a nested `modify` chain for ancestors)
              const change = /** @type {any} */ (deepEventHandler.getDelta({ renderer: type._renderer, deep: true }).done())
              // a base-renderer type doesn't render deleted content, so a change that happened
              // entirely inside a deleted subtree renders to an empty delta — don't emit those no-ops
              if (!change.isEmpty()) {
                type._delta?.apply(change) // keep the cache current (incl. ancestors and diff-renderer attributions)
                if (hasDeltaListeners) type.emit('delta', [change, transaction.origin])
              }
            }
          })
        })
        fs.push(() => doc.emit('afterTransaction', [transaction, doc]))
        callAll(fs, [])
        if (reservedRuntime === undefined && transaction._needFormattingCleanup && doc.cleanupFormatting) {
          cleanupYTextAfterTransaction(transaction)
        }
      } finally {
        if (reservedRuntime === undefined) {
          // Replace deleted items with ItemDeleted / GC.
          // This is where content is actually remove from the Yjs Doc.
          if (doc.gc) {
            tryGcDeleteSet(transaction, ds, doc.gcFilter)
          }
          tryMerge(ds, store)

          // on all affected store.clients props, try to merge
          transaction.insertSet.clients.forEach((ids, client) => {
            const firstClock = ids.getIds()[0].clock
            const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client))
            // we iterate from right to left so we can safely remove entries
            const firstChangePos = math.max(findIndexSS(structs, firstClock), 1)
            for (let i = structs.length - 1; i >= firstChangePos;) {
              i -= 1 + tryToMergeWithLefts(structs, i)
            }
          })
          // try to merge mergeStructs
          // @todo: it makes more sense to transform mergeStructs to a DS, sort it, and merge from right to left
          //        but at the moment DS does not handle duplicates
          for (let i = mergeStructs.length - 1; i >= 0; i--) {
            const { client, clock } = mergeStructs[i].id
            const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client))
            const replacedStructPos = findIndexSS(structs, clock)
            if (replacedStructPos + 1 < structs.length) {
              if (tryToMergeWithLefts(structs, replacedStructPos + 1) > 1) {
                continue // no need to perform next check, both are already merged
              }
            }
            if (replacedStructPos > 0) {
              tryToMergeWithLefts(structs, replacedStructPos)
            }
          }
        } else {
          const accounting = readReservedMutationAccounting(transaction, reservedRuntime)
          const inserts = reservedRuntime.idSets.union([
            accounting.preInserts,
            accounting.executorInserts,
            accounting.callbackInserts
          ])
          const deletes = reservedRuntime.idSets.union([
            accounting.preDeletes,
            accounting.executorDeletes,
            accounting.callbackDeletes
          ])
          if (doc.gc && !reservedRuntime.idSets.isEmpty(deletes)) {
            reservedRuntime.items.gcDeleteSet(transaction, deletes, reservedRuntime.gcFilter, reservedRuntime.idSets)
          }
          reservedRuntime.items.mergeCleanup(transaction, inserts, deletes, reservedRuntime.idSets)
        }
        if (!transaction.local && transaction.insertSet.clients.has(doc.clientID)) {
          logging.print(logging.ORANGE, logging.BOLD, '[yjs] ', logging.UNBOLD, logging.RED, 'Changed the client-id because another client seems to be using it.')
          doc.clientID = generateNewClientId()
        }
        // @todo Merge all the transactions into one and provide send the data as a single update message
        doc.emit('afterTransactionCleanup', [transaction, doc])
        if (doc._observers.has('update')) {
          const encoder = new UpdateEncoderV1()
          const reservedEncoder = createReservedEncoder(encoder, reservedEncoderV1Kernel)
          const reservedContent = writeReservedMutationUpdate(/** @type {any} */ (reservedEncoder), transaction)
          const hasContent = reservedContent === null
            ? writeUpdateMessageFromTransaction(encoder, transaction)
            : reservedContent
          if (hasContent) {
            const update = reservedContent === null ? encoder.toUint8Array() : reservedEncoder.toUint8Array()
            doc.emit('update', [update, transaction.origin, doc, transaction])
          }
        }
        if (doc._observers.has('updateV2')) {
          const encoder = new UpdateEncoderV2()
          const reservedEncoder = createReservedEncoder(encoder, reservedEncoderV2Kernel)
          const reservedContent = writeReservedMutationUpdate(/** @type {any} */ (reservedEncoder), transaction)
          const hasContent = reservedContent === null
            ? writeUpdateMessageFromTransaction(encoder, transaction)
            : reservedContent
          if (hasContent) {
            const update = reservedContent === null ? encoder.toUint8Array() : reservedEncoder.toUint8Array()
            doc.emit('updateV2', [update, transaction.origin, doc, transaction])
          }
        }
        const { subdocsAdded, subdocsLoaded, subdocsRemoved } = transaction
        if (subdocsAdded.size > 0 || subdocsRemoved.size > 0 || subdocsLoaded.size > 0) {
          subdocsAdded.forEach(subdoc => {
            subdoc.clientID = doc.clientID
            if (subdoc.collectionid == null) {
              subdoc.collectionid = doc.collectionid
            }
            doc.subdocs.add(subdoc)
          })
          subdocsRemoved.forEach(subdoc => doc.subdocs.delete(subdoc))
          doc.emit('subdocs', [{ loaded: subdocsLoaded, added: subdocsAdded, removed: subdocsRemoved }, doc, transaction])
          subdocsRemoved.forEach(subdoc => subdoc.destroy())
        }
      }
    } catch (error) {
      cleanupFailed = true
      cleanupFailure = error
    }
    let continuationFailed = false
    let continuationFailure
    try {
      if (transactionCleanups.length <= i + 1) {
        doc._transactionCleanups = []
        doc.emit('afterAllTransactions', [doc, transactionCleanups])
      } else {
        cleanupTransactions(transactionCleanups, i + 1)
      }
    } catch (error) {
      continuationFailed = true
      continuationFailure = error
    }
    if (cleanupFailed) throw cleanupFailure
    if (continuationFailed) throw continuationFailure
  }
}

/**
 * This will be called by the transaction once the event handlers are called to potentially cleanup
 * formats.
 *
 * @param {Transaction} transaction
 */
export const cleanupYTextAfterTransaction = transaction => {
  /**
   * @type {Set<YType>}
   */
  const needFullCleanup = new Set()
  // check if another formatting item was inserted
  const doc = transaction.doc
  iterateStructsByIdSet(transaction, transaction.insertSet, (item) => {
    if (
      !item.deleted && /** @type {Item} */ (item).content.constructor === ContentFormat && item.constructor !== GC
    ) {
      needFullCleanup.add(/** @type {any} */ (item).parent)
    }
  })
  // cleanup in a new transaction
  transact(doc, (t) => {
    iterateStructsByIdSet(transaction, transaction.deleteSet, item => {
      if (item instanceof GC || !(/** @type {YType} */ (item.parent)._hasFormatting) || needFullCleanup.has(/** @type {YType} */ (item.parent))) {
        return
      }
      const parent = /** @type {YType} */ (item.parent)
      if (item.content.constructor === ContentFormat) {
        needFullCleanup.add(parent)
      } else {
        // If no format was inserted or deleted, we can make due with contextless
        // formatting cleanups.
        // Contextless: it is not necessary to compute currentFormats for the affected position.
        cleanupContextlessFormattingGap(t, item)
      }
    })
    // If a formatting item was inserted, we simply clean the whole type.
    // We need to compute currentFormats for the current position anyway.
    for (const yText of needFullCleanup) {
      cleanupYTextFormatting(yText)
    }
  })
}

/**
 * Implements the functionality of `y.transact(()=>{..})`
 *
 * @template T
 * @param {Doc} doc
 * @param {function(Transaction):T} f
 * @param {any} origin
 * @param {boolean} local
 * @param {object|null} reservedRuntime
 * @return {T}
 *
 * @function
 */
const transactInternal = (doc, f, origin, local, reservedRuntime) => {
  const transactionCleanups = doc._transactionCleanups
  let initialCall = false
  /**
   * @type {any}
   */
  let result = null
  let setupFailed = false
  let setupError
  if (doc._transaction === null) {
    initialCall = true
    doc._transaction = new Transaction(doc, origin, local)
    if (reservedRuntime !== null) activateReservedMutationTransaction(doc._transaction, reservedRuntime)
    transactionCleanups.push(doc._transaction)
    try {
      if (transactionCleanups.length === 1) {
        doc.emit('beforeAllTransactions', [doc])
      }
      doc.emit('beforeTransaction', [doc._transaction, doc])
    } catch (error) {
      setupFailed = true
      setupError = error
    }
  }
  const finishInitialCall = () => {
    const finishCleanup = doc._transaction === transactionCleanups[0]
    if (finishCleanup && reservedRuntime !== null) beginReservedMutationCleanup(transactionCleanups[0])
    doc._transaction = null
    if (finishCleanup) {
      // The first transaction ended, now process observer calls.
      // Observer call may create new transactions for which we need to call the observers and do cleanup.
      // We don't want to nest these calls, so we execute these calls one after
      // another.
      // Also we need to ensure that all cleanups are called, even if the
      // observes throw errors.
      // This file is full of hacky try {} finally {} blocks to ensure that an
      // event can throw errors and also that the cleanup is called.
      try {
        cleanupTransactions(transactionCleanups, 0)
      } finally {
        if (reservedRuntime !== null) deactivateReservedMutationTransaction(transactionCleanups[0])
      }
    }
  }
  if (setupFailed) {
    try {
      finishInitialCall()
    } catch (_) {
      // A setup hook's original failure is authoritative; cleanup still ran to completion.
    }
    throw setupError
  }
  try {
    result = f(doc._transaction)
  } finally {
    if (initialCall) {
      finishInitialCall()
    }
  }
  return result
}

/**
 * @template T
 * @param {Doc} doc
 * @param {function(Transaction):T} f
 * @param {any} [origin]
 * @param {boolean} [local]
 * @return {T}
 */
export const transact = (doc, f, origin = null, local = true) => transactInternal(doc, f, origin, local, null)

/**
 * Open the one transaction owned by a reserved mutation capability.
 *
 * @internal
 * @template T
 * @param {Doc} doc
 * @param {function(Transaction):T} f
 * @param {any} origin
 * @param {object} runtime
 * @return {T}
 */
export const transactReservedMutation = (doc, f, origin, runtime) => {
  if (doc._transaction !== null) throw new Error('Reserved mutation requires a fresh transaction')
  return transactInternal(doc, f, origin, true, runtime)
}

/** @internal @param {Transaction} transaction @param {object} runtime */
export const assertReservedMutationTransaction = (transaction, runtime) => assertReservedMutationTransactionRuntime(transaction, runtime)

/** @internal @param {Transaction} transaction */
export const isReservedMutationTransaction = transaction => isReservedMutationTransactionActive(transaction)
