/**
 * @module Y
 */

import { ObservableV2 } from 'lib0/observable'
import * as random from 'lib0/random'
import * as map from 'lib0/map'
import * as array from 'lib0/array'
import * as promise from 'lib0/promise'

import { beginPendingTransaction, endPendingTransaction, getPendingRevision, pendingProofAffectedByInserts, StructStore } from './StructStore.js'
import { markStructuralChange } from './structural-revision.js'
import { transact, generateNewClientId } from './Transaction.js'
import { hasSparseTransport } from './sparse-transport.js'
import { beginDocDestroy, cancelDocDestroy, clearDestroyedDocSubdocs, commitDocDestroy, commitDocDestroyAfterParentTermination, commitDocDestroyReplacement, destroyParentIsPreparing, destroyParentIsTerminating, docDestroyOwnershipCommitted, docLifecycleIsDestroyed, getDocDestroyAttachment, getDocSubdocsSnapshot, initializeDocDestroyCleanup, loadTransactionSubdoc, prepareDocDestroyReplacement, reconcileDocDestroyPublicState, registerConstructedDoc, runDocDestroyCleanup } from './doc-lifecycle.js'
import { YType } from '../ytype.js'
import { $ydoc } from './schemas.js'

const applyIntrinsic = Reflect.apply
const definePropertyIntrinsic = Object.defineProperty
const getOwnPropertyDescriptorIntrinsic = Object.getOwnPropertyDescriptor
const hasOwnPropertyIntrinsic = Object.prototype.hasOwnProperty
const mapForEachIntrinsic = Map.prototype.forEach
const mapClearIntrinsic = Map.prototype.clear
const mapGetIntrinsic = Map.prototype.get
const mapHasIntrinsic = Map.prototype.has
const mapSetIntrinsic = Map.prototype.set
const mapSizeDescriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Map.prototype, 'size'))
const mapSizeGetter = /** @type {function():number} */ (mapSizeDescriptor.get)
const setAddIntrinsic = Set.prototype.add
const setHasIntrinsic = Set.prototype.has
const weakMapGetIntrinsic = WeakMap.prototype.get

/** @param {object} target @param {PropertyKey} key */
const hasOwn = (target, key) => applyIntrinsic(hasOwnPropertyIntrinsic, target, [key])
/** @template T @param {Array<T>} target @param {T} value */
const appendArrayValue = (target, value) => {
  applyIntrinsic(definePropertyIntrinsic, Object, [target, target.length, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  }])
}
/** @type {WeakMap<Doc,{generation:number,pendingTransactions:number,destroyed:boolean,pendingBefore:WeakMap<object,number>}>} */
const transactionGenerations = new WeakMap()

/** @param {Doc} doc */
export const getDocTransactionGeneration = doc => {
  const state = transactionGenerations.get(doc)
  return state === undefined
    ? { generation: 0, settled: doc._transaction === null, destroyed: docLifecycleIsDestroyed(doc) }
    : { generation: state.generation, settled: state.pendingTransactions === 0 && doc._transaction === null, destroyed: state.destroyed }
}

/** @param {Doc} doc */
export const stageDocRootType = doc => {
  const type = new YType(null)
  type._integrate(doc, null)
  return type
}

const docRootMapBrandKey = Symbol('doc-root-map-brand')

/**
 * @param {Doc} doc
 * @param {Map<string,YType>} preparedShare
 * @param {Map<string,YType>} existingRoots
 * @param {Map<string,YType>} stagedRoots
 */
export const installStagedDocRootTypes = (doc, preparedShare, existingRoots, stagedRoots) => {
  if (doc.share !== preparedShare) {
    throw new Error('Prepared sparse root map changed before commit')
  }
  const share = preparedShare
  applyIntrinsic(mapHasIntrinsic, share, [docRootMapBrandKey])
  applyIntrinsic(mapForEachIntrinsic, existingRoots, [
    /** @param {YType} type @param {string} key */ (type, key) => {
      if (!applyIntrinsic(mapHasIntrinsic, share, [key]) || applyIntrinsic(mapGetIntrinsic, share, [key]) !== type) {
        throw new Error(`Prepared sparse root changed before commit: ${key}`)
      }
    }
  ])
  let hasInstalls = false
  applyIntrinsic(mapForEachIntrinsic, stagedRoots, [
    /** @param {YType} type @param {string} key */ (type, key) => {
      if (applyIntrinsic(mapHasIntrinsic, share, [key])) {
        throw new Error(`Staged sparse root was installed before commit: ${key}`)
      }
      hasInstalls = true
    }
  ])
  if (hasInstalls) markStructuralChange(doc.store)
  applyIntrinsic(mapForEachIntrinsic, stagedRoots, [
    /** @param {YType} type @param {string} key */ (type, key) => {
      applyIntrinsic(mapSetIntrinsic, share, [key, type])
    }
  ])
}

/**
 * Validate fork-owned document options without changing the supplied record. Sparse capability is
 * enabled only by own data properties so decoded or inherited values cannot opt a document in.
 *
 * @param {DocOpts} opts
 */
export const normalizeDocOptions = opts => {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError('Document options must be a non-null record')
  }
  const sparse = applyIntrinsic(getOwnPropertyDescriptorIntrinsic, Object, [opts, 'sparseExactResolution'])
  if (sparse === undefined) return { opts, sparseExactResolution: false }
  if (!hasOwn(sparse, 'value') || typeof sparse.value !== 'boolean') {
    throw new TypeError('sparseExactResolution must be an own boolean')
  }
  if (sparse.value) {
    const gc = applyIntrinsic(getOwnPropertyDescriptorIntrinsic, Object, [opts, 'gc'])
    if (gc === undefined || !hasOwn(gc, 'value') || gc.value !== false) {
      throw new Error('Sparse exact resolution requires own gc:false')
    }
  }
  return { opts, sparseExactResolution: sparse.value }
}

/**
 * @typedef {Object} DocOpts
 * @property {boolean} [DocOpts.gc=true] Disable garbage collection (default: gc=true)
 * @property {function(Item):boolean} [DocOpts.gcFilter] Will be called before an Item is garbage collected. Return false to keep the Item.
 * @property {string} [DocOpts.guid] Define a globally unique identifier for this document
 * @property {string | null} [DocOpts.collectionid] Associate this document with a collection. This only plays a role if your provider has a concept of collection.
 * @property {any} [DocOpts.meta] Any kind of meta information you want to associate with this document. If this is a subdocument, remote peers will store the meta information as well.
 * @property {boolean} [DocOpts.autoLoad] If a subdocument, automatically load document. If this is a subdocument, remote peers will load the document as well automatically.
 * @property {boolean} [DocOpts.shouldLoad] Whether the document should be synced by the provider now. This is toggled to true when you call ydoc.load()
 * @property {boolean} [DocOpts.isSuggestionDoc] Set to true if this document merely suggests
 * changes. If this flag is not set in a suggestion document, automatic formatting changes will be
 * displayed as suggestions, which might not be intended.
 * @property {boolean} [DocOpts.sparseExactResolution] Enable fork sparse-resolution wire refs.
 */

/**
 * @typedef {Object} DocEvents
 * @property {function(Doc):void} DocEvents.destroy
 * @property {function(Doc):void} DocEvents.load
 * @property {function(boolean, Doc):void} DocEvents.sync
 * @property {function(Uint8Array<ArrayBuffer>, any, Doc, Transaction):void} DocEvents.update
 * @property {function(Uint8Array<ArrayBuffer>, any, Doc, Transaction):void} DocEvents.updateV2
 * @property {function(Doc):void} DocEvents.beforeAllTransactions
 * @property {function(Transaction, Doc):void} DocEvents.beforeTransaction
 * @property {function(Transaction, Doc):void} DocEvents.beforeObserverCalls
 * @property {function(Transaction, Doc):void} DocEvents.afterTransaction
 * @property {function(Transaction, Doc):void} DocEvents.afterTransactionCleanup
 * @property {function(Doc, Array<Transaction>):void} DocEvents.afterAllTransactions
 * @property {function({ loaded: Set<Doc>, added: Set<Doc>, removed: Set<Doc> }, Doc, Transaction):void} DocEvents.subdocs
 */

/**
 * A Yjs instance handles the state of shared data.
 * @extends ObservableV2<DocEvents>
 */
export class Doc extends ObservableV2 {
  /**
   * @param {DocOpts} opts configuration
   */
  constructor (opts = {}) {
    const normalized = normalizeDocOptions(opts)
    const { guid = random.uuidv4(), collectionid = null, gc = true, gcFilter = () => true, meta = null, autoLoad = false, shouldLoad = true, isSuggestionDoc = false } = normalized.opts
    const sparseExactResolution = normalized.sparseExactResolution
    super()
    this.gc = gc
    if (sparseExactResolution) {
      applyIntrinsic(definePropertyIntrinsic, Object, [this, 'gc', {
        get: () => false,
        set: value => {
          if (value !== false) {
            throw new Error('Sparse exact resolution requires gc:false')
          }
        },
        enumerable: true,
        configurable: false
      }])
    }
    this.gcFilter = gcFilter
    this.clientID = generateNewClientId()
    this.guid = guid
    this.collectionid = collectionid
    this.isSuggestionDoc = isSuggestionDoc
    this.sparseExactResolution = sparseExactResolution
    applyIntrinsic(definePropertyIntrinsic, Object, [this, 'sparseExactResolution', {
      value: sparseExactResolution,
      enumerable: true,
      writable: false,
      configurable: false
    }])
    this.cleanupFormatting = !isSuggestionDoc
    if (sparseExactResolution) {
      applyIntrinsic(definePropertyIntrinsic, Object, [this, 'share', {
        value: /** @type {Map<string, YType>} */ (new Map()),
        enumerable: true,
        writable: false,
        configurable: false
      }])
    } else {
      /**
       * @type {Map<string, YType>}
       */
      this.share = new Map()
    }
    this.store = new StructStore(sparseExactResolution)
    /**
     * @type {Transaction | null}
     */
    this._transaction = null
    /**
     * @type {Array<Transaction>}
     */
    this._transactionCleanups = []
    /**
     * @type {Set<Doc>}
     */
    this.subdocs = new Set()
    /**
     * If this document is a subdocument - a document integrated into another document - then _item is defined.
     * @type {Item?}
     */
    this._item = null
    this.shouldLoad = shouldLoad
    this.autoLoad = autoLoad
    this.meta = meta
    if (sparseExactResolution) {
      const transactionGeneration = { generation: 0, pendingTransactions: 0, destroyed: false, pendingBefore: new WeakMap() }
      transactionGenerations.set(this, transactionGeneration)
      this.on('beforeTransaction', transaction => {
        beginPendingTransaction(this.store)
        transactionGeneration.pendingTransactions++
        transactionGeneration.pendingBefore.set(transaction, getPendingRevision(this.store))
      })
      this.on('beforeObserverCalls', transaction => {
        endPendingTransaction(this.store)
        const pendingBefore = transactionGeneration.pendingBefore.get(transaction)
        if (
          pendingProofAffectedByInserts(this.store, transaction.insertSet) ||
          transaction.deleteSet.clients.size > 0 ||
          hasSparseTransport(transaction) ||
          pendingBefore === undefined ||
          pendingBefore !== getPendingRevision(this.store)
        ) {
          transactionGeneration.generation++
        }
        if (!transaction.deleteSet.isEmpty()) markStructuralChange(this.store)
      })
      this.on('afterTransactionCleanup', transaction => {
        transactionGeneration.pendingTransactions--
        transactionGeneration.pendingBefore.delete(transaction)
      })
    }
    /**
     * This is set to true when the persistence provider loaded the document from the database or when the `sync` event fires.
     * Note that not all providers implement this feature. Provider authors are encouraged to fire the `load` event when the doc content is loaded from the database.
     *
     * @type {boolean}
     */
    this.isLoaded = false
    /**
     * This is set to true when the connection provider has successfully synced with a backend.
     * Note that when using peer-to-peer providers this event may not provide very useful.
     * Also note that not all providers implement this feature. Provider authors are encouraged to fire
     * the `sync` event when the doc has been synced (with `true` as a parameter) or if connection is
     * lost (with false as a parameter).
     */
    this.isSynced = false
    this.isDestroyed = false
    /**
     * Promise that resolves once the document has been loaded from a persistence provider.
     */
    this.whenLoaded = promise.create(resolve => {
      this.on('load', () => {
        this.isLoaded = true
        resolve(this)
      })
    })
    const provideSyncedPromise = () => promise.create(resolve => {
      /**
       * @param {boolean} isSynced
       */
      const eventHandler = (isSynced) => {
        if (isSynced === undefined || isSynced === true) {
          this.off('sync', eventHandler)
          resolve()
        }
      }
      this.on('sync', eventHandler)
    })
    this.on('sync', isSynced => {
      if (isSynced === false && this.isSynced) {
        this.whenSynced = provideSyncedPromise()
      }
      this.isSynced = isSynced === undefined || isSynced === true
      if (this.isSynced && !this.isLoaded) {
        this.emit('load', [this])
      }
    })
    /**
     * Promise that resolves once the document has been synced with a backend.
     * This promise is recreated when the connection is lost.
     * Note the documentation about the `isSynced` property.
     */
    this.whenSynced = provideSyncedPromise()
    registerConstructedDoc(this, normalized.opts, docDestroyIntrinsic)
  }

  /**
   * Notify the parent document that you request to load data into this subdocument (if it is a subdocument).
   *
   * `load()` might be used in the future to request any provider to load the most current data.
   *
   * It is safe to call `load()` multiple times.
   */
  load () {
    const item = this._item
    if (item !== null && !this.shouldLoad) {
      transact(/** @type {any} */ (item.parent).doc, transaction => {
        loadTransactionSubdoc(transaction, this)
      }, null, true)
    }
    this.shouldLoad = true
  }

  getSubdocs () {
    return this.subdocs
  }

  getSubdocGuids () {
    return new Set(array.from(this.subdocs).map(doc => doc.guid))
  }

  /**
   * Changes that happen inside of a transaction are bundled. This means that
   * the observer fires _after_ the transaction is finished and that all changes
   * that happened inside of the transaction are sent as one message to the
   * other peers.
   *
   * @template T
   * @param {function(Transaction):T} f The function that should be executed as a transaction
   * @param {any} [origin] Origin of who started the transaction. Will be stored on transaction.origin
   * @param {boolean} [local]
   * @return T
   */
  transact (f, origin = null, local = true) {
    return transact(this, f, origin, local)
  }

  /**
   * Define a shared data type.
   *
   * Multiple calls of `ydoc.get(name)` yield the same result
   * and do not overwrite each other. I.e.
   * `ydoc.get(name) === ydoc.get(name)`
   *
   * After this method is called, the type is also available on `ydoc.share.get(name)`.
   *
   * @param {string} key
   * @param {string?} name Type-name
   *
   * @return {YType}
   */
  get (key = '', name = null) {
    let created = false
    const type = map.setIfUndefined(this.share, key, () => {
      created = true
      const type = new YType(name)
      type._integrate(this, null)
      return type
    })
    if (created && this.sparseExactResolution) markStructuralChange(this.store)
    return type
  }

  /**
   * Converts the entire document into a js object, recursively traversing each yjs type
   * Doesn't log types that have not been defined (using ydoc.getType(..)).
   *
   * @deprecated Do not use this method and rather call toJSON directly on the shared types.
   *
   * @return {Object<string, any>}
   */
  toJSON () {
    /**
     * @type {Object<string, any>}
     */
    const doc = {}
    this.share.forEach((value, key) => {
      doc[key] = value.toJSON()
    })
    return doc
  }

  /**
  * Emit `destroy` event and unregister all event handlers.
  */
  destroy () {
    const attempt = beginDocDestroy(this)
    if (attempt === null) return
    if (docDestroyOwnershipCommitted(attempt)) {
      runDocDestroyCleanup(this, attempt)
      return
    }
    /** @type {Map<string,YType>} */
    let share
    /** @type {Map<YType,function():void>} */
    let rootDestroyers
    /** @type {Map<string,Set<function(...any):any>>} */
    let observers
    try {
      const shareDescriptor = applyIntrinsic(getOwnPropertyDescriptorIntrinsic, Object, [this, 'share'])
      if (shareDescriptor === undefined || !hasOwn(shareDescriptor, 'value')) {
        throw new Error('Document roots must remain an own Map')
      }
      share = shareDescriptor.value
      applyIntrinsic(mapSizeGetter, share, [])
      rootDestroyers = new Map()
      applyIntrinsic(mapForEachIntrinsic, share, [type => {
        const destroy = type.destroy
        if (typeof destroy !== 'function') {
          throw new Error('Document root destroy must remain callable')
        }
        applyIntrinsic(mapSetIntrinsic, rootDestroyers, [type, destroy])
      }])
      const observersDescriptor = applyIntrinsic(getOwnPropertyDescriptorIntrinsic, Object, [this, '_observers'])
      if (observersDescriptor === undefined || !hasOwn(observersDescriptor, 'value')) {
        throw new Error('Document observers must remain an own Map')
      }
      observers = observersDescriptor.value
      applyIntrinsic(mapSizeGetter, observers, [])
    } catch (failure) {
      cancelDocDestroy(this, attempt)
      throw failure
    }
    const transactionGeneration = applyIntrinsic(weakMapGetIntrinsic, transactionGenerations, [this])
    let hasOwnershipFailure = false
    let ownershipFailure = null
    if (!docDestroyOwnershipCommitted(attempt)) {
      const attachment = getDocDestroyAttachment(attempt)
      if (attachment !== null && destroyParentIsPreparing(attempt)) {
        cancelDocDestroy(this, attempt)
        return
      }
      try {
        if (attachment !== null && !destroyParentIsTerminating(attempt)) {
          const { content, parentDoc } = attachment
          const replacement = new Doc({ guid: this.guid, ...content.opts, shouldLoad: false })
          prepareDocDestroyReplacement(this, attempt, replacement)
          transact(/** @type {any} */ (parentDoc), transaction => {
            commitDocDestroyReplacement(transaction, this, attempt, replacement)
          }, null, true)
        } else {
          commitDocDestroy(this, attempt)
        }
      } catch (failure) {
        if (!docDestroyOwnershipCommitted(attempt)) {
          if (attachment !== null && destroyParentIsTerminating(attempt)) {
            commitDocDestroyAfterParentTermination(this, attempt)
          } else {
            cancelDocDestroy(this, attempt)
            throw failure
          }
        }
        hasOwnershipFailure = true
        ownershipFailure = failure
      }
    }
    /** @type {Array<()=>void>} */
    const cleanup = []
    appendArrayValue(cleanup, () => {
      if (transactionGeneration !== undefined) transactionGeneration.destroyed = true
      reconcileDocDestroyPublicState(this, attempt)
    })
    const destroyedTypes = new Set()
    appendArrayValue(cleanup, () => {
      let hasFailure = false
      /** @type {any} */
      let firstFailure = null
      applyIntrinsic(mapForEachIntrinsic, share, [type => {
        if (applyIntrinsic(setHasIntrinsic, destroyedTypes, [type])) return
        try {
          let destroy = applyIntrinsic(mapGetIntrinsic, rootDestroyers, [type])
          if (destroy === undefined && !applyIntrinsic(mapHasIntrinsic, rootDestroyers, [type])) {
            destroy = type.destroy
            if (typeof destroy !== 'function') {
              throw new Error('Document root destroy must remain callable')
            }
            applyIntrinsic(mapSetIntrinsic, rootDestroyers, [type, destroy])
          }
          applyIntrinsic(destroy, type, [])
          applyIntrinsic(setAddIntrinsic, destroyedTypes, [type])
        } catch (failure) {
          if (!hasFailure) {
            hasFailure = true
            firstFailure = failure
          }
        }
      }])
      if (hasFailure) throw firstFailure
    })
    const subdocs = getDocSubdocsSnapshot(this)
    for (let index = 0; index < subdocs.length; index++) {
      const subdoc = subdocs[index]
      let overrideDone = subdoc.destroy === subdoc.destroyIntrinsic
      let intrinsicDone = false
      appendArrayValue(cleanup, () => {
        let hasFailure = false
        let firstFailure = null
        if (!overrideDone) {
          try {
            applyIntrinsic(subdoc.destroy, subdoc.doc, [])
            overrideDone = true
          } catch (failure) {
            hasFailure = true
            firstFailure = failure
          }
        }
        if (!intrinsicDone) {
          try {
            applyIntrinsic(subdoc.destroyIntrinsic, subdoc.doc, [])
            intrinsicDone = true
            if (hasFailure) overrideDone = true
          } catch (failure) {
            if (!hasFailure) {
              hasFailure = true
              firstFailure = failure
            }
          }
        }
        if (hasFailure) throw firstFailure
      })
    }
    appendArrayValue(cleanup, () => clearDestroyedDocSubdocs(this))
    appendArrayValue(cleanup, () => {
      this.emit('destroy', [this])
      applyIntrinsic(mapClearIntrinsic, observers, [])
      try {
        super.destroy()
      } catch (_failure) {}
    })
    initializeDocDestroyCleanup(this, attempt, cleanup)
    if (hasOwnershipFailure) {
      try {
        runDocDestroyCleanup(this, attempt)
      } catch (_cleanupFailure) {}
      throw ownershipFailure
    }
    runDocDestroyCleanup(this, attempt)
  }
}

const docDestroyIntrinsic = Doc.prototype.destroy
Doc.prototype.$type = $ydoc
