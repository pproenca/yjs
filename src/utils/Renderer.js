import { ObservableV2 } from 'lib0/observable'
import * as encoding from 'lib0/encoding'

import { getItemCleanStart } from './transaction-helpers.js'
import { diffIdSet, createInsertSetFromStructStore, createDeleteSetFromStructStore, insertIntoIdSet, mergeIdSets, intersectSets, createIdSet, createIdSetFromIdMap, writeIdSet, createIdMapFromIdSet, insertIntoIdMap, diffIdMap, createIdMap, mergeIdMaps, intersectMaps, createMaybeAttrRange, createContentAttribute, IdMap, IdSet } from './ids.js'
import { ContentAny, ContentBinary, ContentDeleted, ContentDoc, ContentEmbed, ContentFormat, ContentJSON, ContentString, ContentType } from '../structs/Item.js'
import { readPendingDs, readPendingStructs, StructStore } from './StructStore.js'
import { createID } from './ID.js'
import { writeStructsFromIdSet, writeStructsFromIdSetWithCausalHoles } from './encoding-helpers.js'
import { applyUpdate, encodeStateAsUpdate } from './encoding.js'
import { UpdateEncoderV1 } from './UpdateEncoder.js'
import { isReservedMutationTransaction, transact } from './Transaction.js'
import { UndoManager, StackItem } from './UndoManager.js'
import { Doc } from './Doc.js'
import { $renderer, AttributedContent, cloneRendererContentAttribute, cloneRendererIdMap, cloneRendererIdSet, destroyRendererLifecycle, initializeRendererLifecycle, invalidateRendererLifecycle, readRendererLifecycle, registerRendererExecutionAdapter } from './renderer-helpers.js'

export { baseRenderer, AbstractRenderer, rendererContentLength, $renderer } from './renderer-helpers.js'

/**
 * @typedef {{
 *   inserts: IdMap<any>,
 *   deletes: IdMap<any>,
 *   attributed: IdSet,
 *   prevDoc: Doc,
 *   prevDocStore: StructStore,
 *   nextDoc: Doc
 * }} DiffRendererProjection
 */

/** @type {WeakMap<DiffRenderer, DiffRendererProjection>} */
const diffRendererProjections = new WeakMap()
/** @type {WeakMap<DiffRenderer,{suggestionMode:boolean,suggestionOrigins:ReadonlyArray<any>|null}>} */
const diffRendererPolicies = new WeakMap()

/**
 * @param {DiffRenderer} renderer
 */
const getDiffRendererProjection = renderer => {
  const projection = diffRendererProjections.get(renderer)
  if (projection === undefined) throw new Error('DiffRenderer projection is not initialized')
  return projection
}

/** @param {DiffRenderer} renderer */
const getDiffRendererPolicy = renderer => {
  const policy = diffRendererPolicies.get(renderer)
  if (policy === undefined) throw new Error('DiffRenderer policy is not initialized')
  return policy
}

/** @param {ReadonlyArray<any>|null} origins @param {any} origin */
const policyAllowsOrigin = (origins, origin) => {
  if (origins === null) return true
  for (let index = 0; index < origins.length; index++) {
    if (origins[index] === origin) return true
  }
  return false
}

/** @param {ReadonlyArray<any>|null} origins */
const captureSuggestionOrigins = origins => {
  if (origins === null) return null
  if (!Array.isArray(origins)) throw new TypeError('suggestionOrigins must be an array or null')
  const length = origins.length
  const owned = new Array(length)
  for (let index = 0; index < length; index++) {
    const descriptor = objectGetOwnPropertyDescriptor(origins, String(index))
    if (descriptor === undefined || !reflectApply(objectHasOwnProperty, descriptor, ['value'])) {
      throw new TypeError('suggestionOrigins must contain own data entries')
    }
    objectDefineProperty(owned, index, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false
    })
  }
  return objectFreeze(owned)
}

const objectDefineProperty = Object.defineProperty
const objectFreeze = Object.freeze
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const objectGetPrototypeOf = Object.getPrototypeOf
const objectHasOwnProperty = Object.prototype.hasOwnProperty
const reflectApply = Reflect.apply
const idMapSlice = IdMap.prototype.slice
const idMapHas = IdMap.prototype.has
const idSetIntersects = IdSet.prototype.intersects
const structStoreGetItem = StructStore.prototype.getItem
const contentKernels = new Map([ContentAny, ContentBinary, ContentDeleted, ContentDoc, ContentEmbed, ContentFormat, ContentJSON, ContentString, ContentType].map(Content => [Content.prototype, {
  copy: Content.prototype.copy,
  getLength: Content.prototype.getLength,
  isCountable: Content.prototype.isCountable,
  splice: Content.prototype.splice
}]))

/** @param {AbstractContent} content */
const readContentKernel = content => {
  const kernel = contentKernels.get(objectGetPrototypeOf(content))
  if (kernel === undefined) throw new Error('Unsupported renderer content')
  return kernel
}

/** @param {any[]} values @param {any} value */
const appendDense = (values, value) => {
  objectDefineProperty(values, values.length, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
}

/** @param {any[]} values @param {number} index @param {any} value */
const insertDense = (values, index, value) => {
  for (let current = values.length; current > index; current--) {
    objectDefineProperty(values, current, {
      configurable: true,
      enumerable: true,
      value: values[current - 1],
      writable: true
    })
  }
  objectDefineProperty(values, index, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
}

/** @param {DiffRenderer} renderer @param {Item} item */
const diffRendererHasItem = (renderer, item) =>
  reflectApply(idSetIntersects, getDiffRendererProjection(renderer).attributed, [item.id.client, item.id.clock, item.length])

/**
 * @param {DiffRenderer} renderer
 * @param {Array<AttributedContent<any>>} contents
 * @param {number} client
 * @param {number} clock
 * @param {boolean} deleted
 * @param {AbstractContent} initialContent
 * @param {0|1|2|3} shouldRender
 */
const readDiffRendererContent = (renderer, contents, client, clock, deleted, initialContent, shouldRender) => {
  const projection = getDiffRendererProjection(renderer)
  const initialKernel = readContentKernel(initialContent)
  const slice = reflectApply(idMapSlice, deleted ? projection.deletes : projection.inserts, [
    client,
    clock,
    reflectApply(initialKernel.getLength, initialContent, [])
  ])
  /** @type {AbstractContent?} */
  let content = slice.length === 1 ? initialContent : reflectApply(initialKernel.copy, initialContent, [])
  for (let index = 0; index < slice.length; index++) {
    const range = slice[index]
    if (content == null || objectGetPrototypeOf(content) === ContentDeleted.prototype) {
      if ((!shouldRender && range.attrs == null) || reflectApply(idMapHas, projection.inserts, [client, range.clock])) {
        continue
      }
      const prevItem = reflectApply(structStoreGetItem, projection.prevDocStore, [createID(client, range.clock)])
      const diffStart = range.clock - prevItem.id.clock
      const previousKernel = readContentKernel(prevItem.content)
      content = prevItem.length > 1 ? reflectApply(previousKernel.copy, prevItem.content, []) : prevItem.content
      if (diffStart > 0) {
        const currentContent = /** @type {AbstractContent} */ (content)
        content = reflectApply(readContentKernel(currentContent).splice, currentContent, [diffStart])
      }
    }
    const current = /** @type {AbstractContent} */ (content)
    const currentKernel = readContentKernel(current)
    const contentLength = reflectApply(currentKernel.getLength, current, [])
    if (contentLength < range.len) {
      insertDense(slice, index + 1, createMaybeAttrRange(range.clock + contentLength, range.len - contentLength, range.attrs))
      range.len = contentLength
    }
    content = range.len < contentLength ? reflectApply(currentKernel.splice, current, [range.len]) : null
    if (!deleted || range.attrs != null || (shouldRender !== 0 && shouldRender !== 3)) {
      /** @type {Array<ContentAttribute<any>>?} */
      let attrs = null
      if (range.attrs != null) {
        attrs = []
        for (let attrIndex = 0; attrIndex < range.attrs.length; attrIndex++) {
          appendDense(attrs, cloneRendererContentAttribute(range.attrs[attrIndex]))
        }
      }
      appendDense(contents, new AttributedContent(current, range.clock, deleted, attrs, shouldRender))
    }
  }
}

/** @param {DiffRenderer} renderer @param {Item} item */
const diffRendererContentLength = (renderer, item) => {
  if (!item.deleted) {
    return reflectApply(readContentKernel(item.content).isCountable, item.content, []) ? item.length : 0
  }
  /** @type {Array<AttributedContent<any>>} */
  const contents = []
  readDiffRendererContent(renderer, contents, item.id.client, item.id.clock, true, item.content, 0)
  let length = 0
  for (let index = 0; index < contents.length; index++) {
    const content = contents[index]
    const kernel = readContentKernel(content.content)
    if (content.attrs != null && reflectApply(kernel.isCountable, content.content, [])) {
      length += reflectApply(kernel.getLength, content.content, [])
    }
  }
  return length
}

/**
 * @implements AbstractRenderer
 *
 * @extends {ObservableV2<{change:(idset:IdSet,origin:any,local:boolean)=>void}>}
 */
export class TwosetRenderer extends ObservableV2 {
  /**
   * @param {IdMap<any>} inserts
   * @param {IdMap<any>} deletes
   */
  constructor (inserts, deletes) {
    super()
    this.inserts = inserts
    this.deletes = deletes
    /**
     * Raw coverage of the two maps — `readContent` remains authoritative for what actually
     * renders. See {@link AbstractRenderer#attributed}.
     * @type {IdSet}
     */
    this.attributed = mergeIdSets([createIdSetFromIdMap(inserts), createIdSetFromIdMap(deletes)])
  }

  get $type () { return $renderer }

  /**
   * @param {Item} item
   * @return {boolean}
   */
  hasItem (item) {
    return this.attributed.intersects(item.id.client, item.id.clock, item.length)
  }

  /**
   * @param {Array<AttributedContent<any>>} contents - where to write the result
   * @param {number} client
   * @param {number} clock
   * @param {boolean} deleted
   * @param {AbstractContent} content
   * @param {0|1|2|3} shouldRender - whether this should render or just result in a `retain` operation (see AbstractRenderer#readContent)
   */
  readContent (contents, client, clock, deleted, content, shouldRender) {
    const slice = (deleted ? this.deletes : this.inserts).slice(client, clock, content.getLength())
    content = slice.length === 1 ? content : content.copy()
    slice.forEach(s => {
      const c = content
      if (s.len < c.getLength()) {
        content = c.splice(s.len)
      }
      // see DiffRenderer#readContent: mode 3 renders unattributed deleted content as nothing
      if (!deleted || s.attrs != null || (shouldRender !== 0 && shouldRender !== 3)) {
        contents.push(new AttributedContent(c, s.clock, deleted, s.attrs, shouldRender))
      }
    })
  }

  /**
   * @param {Item} item
   * @return {number}
   */
  contentLength (item) {
    if (!item.content.isCountable()) {
      return 0
    } else if (!item.deleted) {
      return item.length
    } else {
      return this.deletes.sliceId(item.id, item.length).reduce((len, s) => s.attrs != null ? len + s.len : len, 0)
    }
  }
}

/**
 * @param {StructStore} store
 * @param {number} client
 * @param {number} clock
 * @param {number} len
 */
const getItemContent = (store, client, clock, len) => {
  // Retrieved item is never more fragmented than the newer item.
  const prevItem = store.getItem(createID(client, clock))
  const diffStart = clock - prevItem.id.clock
  let content = prevItem.length > 1 ? prevItem.content.copy() : prevItem.content
  // trim itemContent to the correct size.
  if (diffStart > 0) {
    content = content.splice(diffStart)
  }
  if (len < content.getLength()) {
    content.splice(len)
  }
  return content
}

/**
 * @param {Transaction?} tr - only specify this if you want to fill the content of deleted content
 * @param {DiffRenderer} renderer
 * @param {ID} start
 * @param {ID} end
 * @param {boolean} collectAll - collect as many items as possible. Accept adding redundant changes.
 */
const collectSuggestedChanges = (tr, renderer, start, end, collectAll) => {
  const inserts = createIdSet()
  const deletes = createIdSet()
  const projection = getDiffRendererProjection(renderer)
  const store = projection.nextDoc.store
  /**
   * make sure to collect suggestions until all formats are closed
   * @type {Set<string>}
   */
  const openedCollectedFormats = new Set()
  /**
   * @type {Item?}
   */
  let item = store.getItem(start)
  const endItem = start === end ? item : (end == null ? null : store.getItem(end))

  // walk to the left and find first un-attributed change that is rendered
  while (item.left != null) {
    item = item.left
    if (item.content instanceof ContentFormat && item.content.value == null) {
      item = item.right
      break
    }
    if (!item.deleted) {
      const slice = projection.inserts.slice(item.id.client, item.id.clock, item.length)
      if (slice.some(s => s.attrs === null)) {
        for (let i = slice.length - 1; i >= 0; i--) {
          const s = slice[i]
          if (s.attrs == null) break
          inserts.add(item.id.client, s.clock, s.len)
        }
        item = item.right
        break
      }
    }
  }
  let foundEndItem = false
  // eslint-disable-next-line
  itemLoop: while (item != null) {
    const itemClient = item.id.client
    const slice = (item.deleted ? projection.deletes : projection.inserts).slice(itemClient, item.id.clock, item.length)
    foundEndItem ||= item === endItem
    if (item.deleted) {
      // item probably gc'd content. Need to split item and fill with content again
      for (let i = slice.length - 1; i >= 0; i--) {
        const s = slice[i]
        if (s.attrs != null || collectAll) {
          deletes.add(itemClient, s.clock, s.len)
          if (collectAll) {
            // in case item has been added and deleted this might be necessary. the forked document
            // will automatically filter this if it doesn't have it already.
            inserts.add(itemClient, s.clock, s.len)
          }
        }
        if (tr != null) {
          const splicedItem = getItemCleanStart(tr, createID(itemClient, s.clock))
          if (s.attrs != null) {
            splicedItem.content = getItemContent(projection.prevDocStore, itemClient, s.clock, s.len)
          }
        }
      }
    } else {
      if (item.content instanceof ContentFormat) {
        const { key, value } = item.content
        if (value == null) {
          openedCollectedFormats.delete(key)
        } else {
          openedCollectedFormats.add(key)
        }
      }
      for (let i = 0; i < slice.length; i++) {
        const s = slice[i]
        if (s.attrs != null) {
          inserts.add(itemClient, s.clock, s.len)
        } else if (foundEndItem && openedCollectedFormats.size === 0) {
          // eslint-disable-next-line
          break itemLoop
        }
      }
    }
    item = item.right
  }
  return { inserts, deletes }
}

const diffResolutionReceipts = new WeakMap()

const createResolutionReceipt = () => ({ inserts: createIdSet(), deletes: createIdSet() })

/**
 * @param {ContentIds} ids
 */
const copyContentIds = ids => {
  if (ids == null || ids.inserts == null || ids.deletes == null || typeof ids.inserts.forEach !== 'function' || typeof ids.deletes.forEach !== 'function') {
    throw new Error('Invalid ContentIds')
  }
  /**
   * @param {IdSet} source
   */
  const copy = source => {
    const result = createIdSet()
    source.forEach((range, client) => {
      const end = range.clock + range.len
      if (!Number.isSafeInteger(client) || client < 0 || !Number.isSafeInteger(range.clock) || range.clock < 0 || !Number.isSafeInteger(range.len) || range.len <= 0 || !Number.isSafeInteger(end)) {
        throw new Error('Invalid ContentIds range')
      }
      result.add(client, range.clock, range.len)
    })
    // Normalize duplicates/overlaps on the defensive copy.
    result.forEach(() => {})
    return result
  }
  return { inserts: copy(ids.inserts), deletes: copy(ids.deletes) }
}

/**
 * @param {IdSet} left
 * @param {IdSet|IdMap<any>} right
 */
const isSubset = (left, right) => diffIdSet(left, right).isEmpty()

/**
 * @param {IdSet} left
 * @param {IdSet} right
 */
const overlaps = (left, right) => !intersectSets(left, right).isEmpty()

/**
 * Visit the exact slices of `ids`, failing on holes before callers mutate a document.
 *
 * @param {StructStore} store
 * @param {IdSet} ids
 * @param {(struct:GC|Item|Skip, offset:number, len:number)=>boolean} predicate
 * @param {string} message
 */
const assertStructCoverage = (store, ids, predicate, message) => {
  ids.forEach((range, client) => {
    const structs = store.clients.get(client)
    if (structs == null || structs.length === 0) throw new Error(message)
    let left = 0
    let right = structs.length - 1
    while (left <= right) {
      const middle = (left + right) >>> 1
      const struct = structs[middle]
      if (range.clock < struct.id.clock) {
        right = middle - 1
      } else if (range.clock >= struct.id.clock + struct.length) {
        left = middle + 1
      } else {
        left = middle
        break
      }
    }
    let index = left
    let clock = range.clock
    const end = range.clock + range.len
    while (clock < end) {
      const struct = structs[index++]
      if (struct == null || struct.id.clock > clock || struct.id.clock + struct.length <= clock) throw new Error(message)
      const offset = clock - struct.id.clock
      const len = Math.min(struct.length - offset, end - clock)
      if (!predicate(struct, offset, len)) throw new Error(message)
      clock += len
    }
  })
}

/**
 * @param {Item} struct
 * @param {Doc} doc
 */
const isIntegratedItem = (struct, doc) => struct.isItem && struct.parent != null && typeof struct.parent !== 'string' && /** @type {YType} */ (struct.parent).doc === doc

/**
 * Build the exact reject update on an isolated non-GC merge. Applying the base state first is
 * what preserves canonical deleted payload when the suggestion store contains ContentDeleted/GC.
 *
 * @param {DiffRenderer} renderer
 * @param {ContentIds} ids
 */
const prepareRejectUpdate = (renderer, ids) => {
  const inserts = diffIdSet(ids.inserts, ids.deletes)
  const deletes = diffIdSet(ids.deletes, ids.inserts)
  const { prevDoc, nextDoc } = getDiffRendererProjection(renderer)
  const scratch = new Doc({ gc: false, isSuggestionDoc: true })
  try {
    applyUpdate(scratch, encodeStateAsUpdate(prevDoc))
    applyUpdate(scratch, encodeStateAsUpdate(nextDoc))
    scratch.clientID = nextDoc.clientID

    assertStructCoverage(scratch.store, deletes, struct => isIntegratedItem(/** @type {Item} */ (struct), scratch) && struct.deleted && !(/** @type {Item} */ (struct).content instanceof ContentDeleted), 'Missing canonical deletion preimage')

    const undoManager = new UndoManager(scratch)
    /** @type {Transaction?} */
    let undoTransaction = null
    /** @param {Transaction} tr */
    const capture = tr => {
      if (tr.origin === undoManager) undoTransaction = tr
    }
    scratch.on('afterTransaction', capture)
    try {
      undoManager.undoStack.push(new StackItem(inserts, deletes))
      undoManager.undo()
    } finally {
      scratch.off('afterTransaction', capture)
      undoManager.destroy()
    }
    if (undoTransaction == null) throw new Error('Diff resolution invariant failed')
    const tr = /** @type {Transaction} */ (undoTransaction)
    if (!isSubset(tr.deleteSet, inserts)) throw new Error('ContentIds resolve outside their exact scope')
    assertStructCoverage(scratch.store, inserts, struct => struct.deleted, 'ContentIds insert could not be rejected')
    assertStructCoverage(scratch.store, deletes, struct => struct.isItem && /** @type {Item} */ (struct).redone != null, 'ContentIds delete could not be rejected')

    const encoder = new UpdateEncoderV1()
    const projection = getDiffRendererProjection(renderer)
    writeStructsFromIdSetWithCausalHoles(encoder, scratch.store, mergeIdSets([ids.inserts, tr.insertSet]), [projection.prevDoc.store, projection.nextDoc.store])
    writeIdSet(encoder, mergeIdSets([ids.inserts, ids.deletes]))
    return encoder.toUint8Array()
  } finally {
    scratch.destroy()
  }
}

export class Attributions {
  constructor () {
    this.inserts = createIdMap()
    this.deletes = createIdMap()
  }
}

/**
 * @param {IdMap<any>|undefined} attrs
 * @param {IdSet} slice
 *
 */
const extractAttributions = (attrs, slice) => attrs == null ? createIdMapFromIdSet(slice, []) : mergeIdMaps([intersectMaps(attrs, slice), createIdMapFromIdSet(slice, [])])

/**
 * Capture caller-owned attribution definitions into the private renderer projection.
 *
 * @param {IdMap<any>|undefined} attrs
 * @param {IdSet} slice
 */
const captureAttributions = (attrs, slice) => cloneRendererIdMap(extractAttributions(attrs, slice))

/**
 * @implements AbstractRenderer
 *
 * @extends {ObservableV2<{change:(idset:IdSet,origin:any,local:boolean)=>void}>}
 */
export class DiffRenderer extends ObservableV2 {
  /**
   * @param {Doc} prevDoc
   * @param {Doc} nextDoc
   * @param {Object} [options] - options for the renderer
   * @param {Attributions?} [options.attrs] - the attributes to apply to the diff
   */
  constructor (prevDoc, nextDoc, { attrs = null } = {}) {
    super()
    initializeRendererLifecycle(this)
    const _nextDocInserts = createInsertSetFromStructStore(nextDoc.store, false) // unmaintained
    const _prevDocInserts = createInsertSetFromStructStore(prevDoc.store, false) // unmaintained
    const nextDocDeletes = createDeleteSetFromStructStore(nextDoc.store) // maintained
    const prevDocDeletes = createDeleteSetFromStructStore(prevDoc.store) // maintained
    const insertDiff = diffIdSet(_nextDocInserts, _prevDocInserts)
    const deleteDiff = diffIdSet(nextDocDeletes, prevDocDeletes)
    const projection = {
      inserts: captureAttributions(attrs?.inserts, insertDiff),
      deletes: captureAttributions(attrs?.deletes, deleteDiff),
      attributed: mergeIdSets([insertDiff, deleteDiff]),
      prevDoc,
      prevDocStore: prevDoc.store,
      nextDoc
    }
    diffRendererProjections.set(this, projection)
    diffResolutionReceipts.set(this, { accepted: createResolutionReceipt(), rejected: createResolutionReceipt() })
    registerRendererExecutionAdapter(this, /** @type {any} */ ({
      hasItem: (/** @type {Item} */ item) => diffRendererHasItem(this, item),
      readContent: (/** @type {Array<AttributedContent<any>>} */ contents, /** @type {number} */ client, /** @type {number} */ clock, /** @type {boolean} */ deleted, /** @type {AbstractContent} */ content, /** @type {0|1|2|3} */ shouldRender) => {
        readDiffRendererContent(this, contents, client, clock, deleted, content, shouldRender)
      },
      contentLength: (/** @type {Item} */ item) => diffRendererContentLength(this, item)
    }), [prevDoc, nextDoc], () => getDiffRendererPolicy(this))

    // update before observer calls fired
    this._nextBOH = nextDoc.on('beforeObserverCalls', tr => {
      const diffInserts = diffIdSet(tr.insertSet, _prevDocInserts)
      const diffDeletes = diffIdSet(diffIdSet(diffIdSet(tr.deleteSet, prevDocDeletes), projection.inserts), diffInserts)
      const changed = !tr.insertSet.isEmpty() || !tr.deleteSet.isEmpty()
      if (!changed) return
      try {
        // Prepare both snapshots before publishing either into the private projection.
        const capturedInserts = captureAttributions(attrs?.inserts, diffInserts)
        const capturedDeletes = captureAttributions(attrs?.deletes, diffDeletes)
        insertIntoIdMap(projection.inserts, capturedInserts)
        insertIntoIdMap(projection.deletes, capturedDeletes)
        insertIntoIdSet(projection.attributed, diffInserts)
        insertIntoIdSet(projection.attributed, diffDeletes)
      } catch {
        // The document has already changed when beforeObserverCalls runs. Retire a renderer whose
        // projection cannot publish atomically, but do not abort the document's observer pipeline.
        this.destroy()
        return
      }
      invalidateRendererLifecycle(this)
      // @todo fire update ranges on `diffInserts` and `diffDeletes`
    })
    this._prevBOH = prevDoc.on('beforeObserverCalls', tr => {
      insertIntoIdSet(_prevDocInserts, tr.insertSet)
      insertIntoIdSet(prevDocDeletes, tr.deleteSet)
      if (tr.insertSet.clients.size < 2) {
        tr.insertSet.forEach((attrRange, client) => {
          projection.inserts.delete(client, attrRange.clock, attrRange.len)
        })
      } else {
        projection.inserts = diffIdMap(projection.inserts, tr.insertSet)
      }
      // insertIntoIdMap(this.deletes, createIdMapFromIdSet(intersectSets(tr.deleteSet, this.deletes), [createAttributionItem('acceptDelete', 'unknown')]))
      if (tr.deleteSet.clients.size < 2) {
        tr.deleteSet.forEach((attrRange, client) => {
          projection.deletes.delete(client, attrRange.clock, attrRange.len)
        })
      } else {
        projection.deletes = diffIdMap(projection.deletes, tr.deleteSet)
      }
      // evict the accepted/rejected ranges from the coverage set, then re-add whatever the maps
      // still claim: `tr.insertSet` only evicts insert-attributions and `tr.deleteSet` only evicts
      // delete-attributions, but a single range can be covered by both maps (e.g. an accepted
      // insert with a still-pending delete suggestion on the same ids must stay attributed).
      const evicted = mergeIdSets([tr.insertSet, tr.deleteSet])
      projection.attributed = diffIdSet(projection.attributed, evicted)
      insertIntoIdSet(projection.attributed, intersectSets(evicted, projection.inserts))
      insertIntoIdSet(projection.attributed, intersectSets(evicted, projection.deletes))
      if (tr.insertSet.clients.size > 0 || tr.deleteSet.clients.size > 0) {
        invalidateRendererLifecycle(this)
      }
      // fire event of "changed" attributions. exclude items that were added & deleted in the same
      // transaction
      const changed = diffIdSet(mergeIdSets([tr.insertSet, tr.deleteSet]), intersectSets(tr.insertSet, tr.deleteSet))
      this.emit('change', [cloneRendererIdSet(changed), tr.origin, tr.local])
    })
    // changes from prevDoc should always flow into suggestionDoc
    // changes from suggestionDoc only flow into ydoc if suggestion-mode is disabled
    this._prevUpdateListener = prevDoc.on('update', (update, origin) => {
      origin !== this && applyUpdate(nextDoc, update)
    })
    this._ndUpdateListener = nextDoc.on('update', (update, origin, _doc, tr) => {
      if (isReservedMutationTransaction(tr)) return
      const policy = getDiffRendererPolicy(this)
      // only if event is local and suggestion mode is enabled
      if (!policy.suggestionMode && tr.local && policyAllowsOrigin(policy.suggestionOrigins, origin)) {
        applyUpdate(prevDoc, update, this)
      }
    })
    this._afterTrListener = nextDoc.on('afterTransaction', (tr) => {
      if (isReservedMutationTransaction(tr)) return
      const policy = getDiffRendererPolicy(this)
      // apply deletes on attributed deletes (content that is already deleted, but is rendered by
      // the renderer)
      if (!policy.suggestionMode && tr.local && policyAllowsOrigin(policy.suggestionOrigins, tr.origin)) {
        const attributedDeletes = tr.meta.get('attributedDeletes')
        if (attributedDeletes != null) {
          transact(prevDoc, () => {
            // apply attributed deletes if there are any
            const ds = new UpdateEncoderV1()
            encoding.writeVarUint(ds.restEncoder, 0) // encode 0 structs
            writeIdSet(ds, attributedDeletes)
            applyUpdate(prevDoc, ds.toUint8Array())
          }, this)
        }
      }
    })
    diffRendererPolicies.set(this, objectFreeze({ suggestionMode: true, suggestionOrigins: null }))
    this._destroyHandler = nextDoc.on('destroy', this.destroy.bind(this))
    prevDoc.on('destroy', this._destroyHandler)
  }

  get $type () { return $renderer }

  get suggestionMode () { return getDiffRendererPolicy(this).suggestionMode }

  /** @param {boolean} value */
  set suggestionMode (value) {
    if (typeof value !== 'boolean') throw new TypeError('suggestionMode must be a boolean')
    const policy = getDiffRendererPolicy(this)
    diffRendererPolicies.set(this, objectFreeze({ suggestionMode: value, suggestionOrigins: policy.suggestionOrigins }))
    invalidateRendererLifecycle(this)
  }

  /** @return {ReadonlyArray<any>|null} */
  get suggestionOrigins () { return getDiffRendererPolicy(this).suggestionOrigins }

  /** @param {ReadonlyArray<any>|null} value */
  set suggestionOrigins (value) {
    const policy = getDiffRendererPolicy(this)
    diffRendererPolicies.set(this, objectFreeze({ suggestionMode: policy.suggestionMode, suggestionOrigins: captureSuggestionOrigins(value) }))
    invalidateRendererLifecycle(this)
  }

  /**
   * A detached snapshot of pending insert attributions.
   *
   * @return {IdMap<any>}
   */
  get inserts () { return cloneRendererIdMap(getDiffRendererProjection(this).inserts) }

  /**
   * A detached snapshot of pending delete attributions.
   *
   * @return {IdMap<any>}
   */
  get deletes () { return cloneRendererIdMap(getDiffRendererProjection(this).deletes) }

  /**
   * A detached snapshot of the raw attribution coverage.
   *
   * @return {IdSet}
   */
  get attributed () { return cloneRendererIdSet(getDiffRendererProjection(this).attributed) }

  /**
   * Atomically replace attribution values over the current pending projection.
   *
   * @param {ContentMap} attrs
   */
  replaceAttributions (attrs) {
    const lifecycle = readRendererLifecycle(this)
    if (lifecycle == null || !lifecycle.active) throw new Error('DiffRenderer is inactive')
    const projection = getDiffRendererProjection(this)
    const inserts = captureAttributions(attrs.inserts, createIdSetFromIdMap(projection.inserts))
    const deletes = captureAttributions(attrs.deletes, createIdSetFromIdMap(projection.deletes))
    const currentLifecycle = readRendererLifecycle(this)
    if (currentLifecycle !== lifecycle || !currentLifecycle.active) throw new Error('DiffRenderer changed while capturing attributions')
    projection.inserts = inserts
    projection.deletes = deletes
    invalidateRendererLifecycle(this)
  }

  /**
   * @param {Item} item
   * @return {boolean}
   */
  hasItem (item) {
    return diffRendererHasItem(this, item)
  }

  destroy () {
    const projection = getDiffRendererProjection(this)
    destroyRendererLifecycle(this)
    super.destroy()
    projection.nextDoc.off('destroy', this._destroyHandler)
    projection.prevDoc.off('destroy', this._destroyHandler)
    projection.nextDoc.off('beforeObserverCalls', this._nextBOH)
    projection.prevDoc.off('beforeObserverCalls', this._prevBOH)
    projection.prevDoc.off('update', this._prevUpdateListener)
    projection.nextDoc.off('update', this._ndUpdateListener)
    projection.nextDoc.off('afterTransaction', this._afterTrListener)
  }

  acceptAllChanges () {
    const { prevDoc, nextDoc } = getDiffRendererProjection(this)
    applyUpdate(prevDoc, encodeStateAsUpdate(nextDoc))
  }

  rejectAllChanges () {
    const { prevDoc, nextDoc } = getDiffRendererProjection(this)
    prevDoc.transact(tr => {
      applyUpdate(prevDoc, encodeStateAsUpdate(nextDoc))
      const um = new UndoManager(prevDoc)
      um.undoStack.push(new StackItem(tr.insertSet, tr.deleteSet))
      um.undo()
      um.destroy()
    })
  }

  /**
   * @param {ID} start
   * @param {ID} end
   */
  acceptChanges (start, end = start) {
    const { prevDoc, nextDoc } = getDiffRendererProjection(this)
    const { inserts, deletes } = collectSuggestedChanges(null, this, start, end, true)
    const encoder = new UpdateEncoderV1()
    writeStructsFromIdSet(encoder, nextDoc.store, inserts)
    writeIdSet(encoder, deletes)
    applyUpdate(prevDoc, encoder.toUint8Array())
  }

  /**
   * @param {ID} start
   * @param {ID} end
   */
  rejectChanges (start, end = start) {
    const { nextDoc } = getDiffRendererProjection(this)
    nextDoc.transact(tr => {
      const { inserts, deletes } = collectSuggestedChanges(tr, this, start, end, false)
      const encoder = new UpdateEncoderV1()
      writeStructsFromIdSet(encoder, nextDoc.store, inserts)
      writeIdSet(encoder, deletes)
      const um = new UndoManager(nextDoc)
      um.undoStack.push(new StackItem(inserts, deletes))
      um.undo()
      um.destroy()
    })
    this.acceptChanges(start, end)
  }

  /**
   * Resolve exactly the supplied structural IDs without positional expansion.
   *
   * @param {ContentIds} ids
   * @param {'accept'|'reject'} disposition
   * @param {unknown} [origin]
   */
  resolveContentIds (ids, disposition, origin) {
    if (disposition !== 'accept' && disposition !== 'reject') throw new Error('Invalid diff resolution disposition')
    const requested = copyContentIds(ids)
    const projection = getDiffRendererProjection(this)
    const receipts = /** @type {{accepted:ContentIds,rejected:ContentIds}} */ (diffResolutionReceipts.get(this))
    const receipt = disposition === 'accept' ? receipts.accepted : receipts.rejected
    const opposite = disposition === 'accept' ? receipts.rejected : receipts.accepted
    if (overlaps(requested.inserts, opposite.inserts) || overlaps(requested.deletes, opposite.deletes)) {
      throw new Error('ContentIds already resolved with the opposite disposition')
    }

    const actionable = {
      inserts: diffIdSet(requested.inserts, receipt.inserts),
      deletes: diffIdSet(requested.deletes, receipt.deletes)
    }
    if (actionable.inserts.isEmpty() && actionable.deletes.isEmpty()) return
    if (!isSubset(actionable.inserts, projection.inserts) || !isSubset(actionable.deletes, projection.deletes)) {
      throw new Error('ContentIds are unknown or outside this renderer')
    }
    if (projection.prevDoc.store !== projection.prevDocStore) throw new Error('Canonical base store mismatch')
    if (
      readPendingStructs(projection.prevDoc.store) !== null || readPendingDs(projection.prevDoc.store) !== null ||
      readPendingStructs(projection.nextDoc.store) !== null || readPendingDs(projection.nextDoc.store) !== null
    ) {
      throw new Error('Diff resolution requires complete document stores')
    }

    const inserts = diffIdSet(actionable.inserts, actionable.deletes)
    const deletes = diffIdSet(actionable.deletes, actionable.inserts)
    assertStructCoverage(projection.nextDoc.store, actionable.inserts, struct => struct.isItem ? isIntegratedItem(/** @type {Item} */ (struct), projection.nextDoc) : disposition === 'reject', 'Missing or out-of-scope suggestion source')
    assertStructCoverage(projection.nextDoc.store, actionable.deletes, struct => struct.deleted && (!struct.isItem || isIntegratedItem(/** @type {Item} */ (struct), projection.nextDoc)), 'Missing or out-of-scope suggestion deletion')
    if (disposition === 'accept') {
      assertStructCoverage(projection.nextDoc.store, inserts, struct => isIntegratedItem(/** @type {Item} */ (struct), projection.nextDoc) && !struct.deleted && !(/** @type {Item} */ (struct).content instanceof ContentDeleted), 'Missing suggested insertion payload')
    }
    assertStructCoverage(projection.prevDocStore, deletes, struct => isIntegratedItem(/** @type {Item} */ (struct), projection.prevDoc) && !struct.deleted && !(/** @type {Item} */ (struct).content instanceof ContentDeleted), 'Missing canonical deletion preimage')

    const encoder = new UpdateEncoderV1()
    let update
    if (disposition === 'accept') {
      writeStructsFromIdSetWithCausalHoles(encoder, projection.nextDoc.store, actionable.inserts, [projection.prevDoc.store])
      writeIdSet(encoder, actionable.deletes)
      update = encoder.toUint8Array()
    } else {
      update = prepareRejectUpdate(this, actionable)
    }

    const recordReceipt = () => {
      if (
        readPendingStructs(projection.prevDoc.store) !== null || readPendingDs(projection.prevDoc.store) !== null ||
        readPendingStructs(projection.nextDoc.store) !== null || readPendingDs(projection.nextDoc.store) !== null
      ) {
        throw new Error('Diff resolution produced incomplete document stores')
      }
      insertIntoIdSet(receipt.inserts, actionable.inserts)
      insertIntoIdSet(receipt.deletes, actionable.deletes)
    }
    if (disposition === 'accept') {
      projection.prevDoc.transact(() => {
        applyUpdate(projection.prevDoc, update, origin)
        recordReceipt()
      }, origin, false)
    } else {
      projection.nextDoc.transact(tr => {
        applyUpdate(projection.nextDoc, update)
        try {
          projection.prevDoc.transact(() => {
            applyUpdate(projection.prevDoc, update, origin)
            recordReceipt()
          }, origin, false)
        } finally {
          // Base observers may feed the update back into this enclosing suggestion transaction.
          // It remains the local reject transaction even when either document's cleanup throws.
          tr.local = true
        }
      }, origin)
    }
  }

  /**
   * @param {Array<AttributedContent<any>>} contents - where to write the result
   * @param {number} client
   * @param {number} clock
   * @param {boolean} deleted
   * @param {AbstractContent} _content
   * @param {0|1|2|3} shouldRender - whether this should render or just result in a `retain` operation (see AbstractRenderer#readContent)
   */
  readContent (contents, client, clock, deleted, _content, shouldRender) {
    readDiffRendererContent(this, contents, client, clock, deleted, _content, shouldRender)
  }

  /**
   * @param {Item} item
   * @return {number}
   */
  contentLength (item) {
    return diffRendererContentLength(this, item)
  }
}

/**
 * Attribute changes from ydoc1 to ydoc2.
 *
 * @param {Doc} prevDoc
 * @param {Doc} nextDoc
 * @param {Object} [options] - options for the renderer
 * @param {ContentMap?} [options.attrs] - the attributes to apply to the diff
 */
export const createDiffRenderer = (prevDoc, nextDoc, options) => new DiffRenderer(prevDoc, nextDoc, options)

/**
 * Intended for projects that used the v13 snapshot feature. With this renderer you can
 * read content similar to the previous snapshot api. Requires that `ydoc.gc` is turned off.
 *
 * @implements AbstractRenderer
 *
 * @extends {ObservableV2<{change:(idset:IdSet,origin:any,local:boolean)=>void}>}
 */
export class SnapshotRenderer extends ObservableV2 {
  /**
   * @param {Snapshot} prevSnapshot
   * @param {Snapshot} nextSnapshot
   * @param {Object} [options] - options for the renderer
   * @param {Array<ContentAttribute>} [options.attrs] - the attributes to apply to the diff
   */
  constructor (prevSnapshot, nextSnapshot) {
    super()
    this.prevSnapshot = prevSnapshot
    this.nextSnapshot = nextSnapshot
    const inserts = createIdMap()
    const deletes = createIdMapFromIdSet(diffIdSet(nextSnapshot.ds, prevSnapshot.ds), [createContentAttribute('change', '')])
    nextSnapshot.sv.forEach((clock, client) => {
      const prevClock = prevSnapshot.sv.get(client) || 0
      inserts.add(client, 0, prevClock, []) // content is included in prevSnapshot is rendered without attributes
      inserts.add(client, prevClock, clock - prevClock, [createContentAttribute('change', '')]) // content is rendered as "inserted"
    })
    this.attrs = mergeIdMaps([diffIdMap(inserts, prevSnapshot.ds), deletes])
    /**
     * Coverage of `attrs` (everything up to `nextSnapshot`). Content *after* the snapshot must be
     * hidden rather than rendered normally, which a finite set cannot express — `hasItem`
     * additionally claims all future content. See {@link AbstractRenderer#attributed}.
     * @type {IdSet}
     */
    this.attributed = createIdSetFromIdMap(this.attrs)
  }

  get $type () { return $renderer }

  /**
   * @param {Item} item
   * @return {boolean}
   */
  hasItem (item) {
    // claim future content (item ids at/after the snapshot's state vector, including clients the
    // snapshot has never seen) — `readContent` hides it, the generic path would render it
    return (this.nextSnapshot.sv.get(item.id.client) ?? 0) < item.id.clock + item.length ||
      this.attributed.intersects(item.id.client, item.id.clock, item.length)
  }

  /**
   * @param {Array<AttributedContent<any>>} contents - where to write the result
   * @param {number} client
   * @param {number} clock
   * @param {boolean} _deleted
   * @param {AbstractContent} content
   * @param {0|1|2|3} shouldRender - whether this should render or just result in a `retain` operation (see AbstractRenderer#readContent)
   */
  readContent (contents, client, clock, _deleted, content, shouldRender) {
    if ((this.nextSnapshot.sv.get(client) ?? 0) <= clock) return // future item that should not be displayed
    const slice = this.attrs.slice(client, clock, content.getLength())
    content = slice.length === 1 ? content : content.copy()
    slice.forEach(s => {
      const deleted = this.nextSnapshot.ds.has(client, s.clock)
      const nonExistend = (this.nextSnapshot.sv.get(client) ?? 0) <= s.clock
      const c = content
      if (s.len < c.getLength()) {
        content = c.splice(s.len)
      }
      if (nonExistend) return
      if (shouldRender || !deleted || (s.attrs != null && s.attrs.length > 0)) {
        let attrsWithoutChange = s.attrs?.filter(attr => attr.name !== 'change') ?? null
        if (s.attrs?.length === 0) {
          attrsWithoutChange = null
        }
        contents.push(new AttributedContent(c, s.clock, deleted, attrsWithoutChange, shouldRender))
      }
    })
  }

  /**
   * @param {Item} item
   * @return {number}
   */
  contentLength (item) {
    return item.content.isCountable()
      ? (item.deleted
          ? this.attrs.sliceId(item.id, item.length).reduce((len, s) => s.attrs != null ? len + s.len : len, 0)
          : item.length
        )
      : 0
  }
}

/**
 * @param {Snapshot} prevSnapshot
 * @param {Snapshot} nextSnapshot
 */
export const createSnapshotRenderer = (prevSnapshot, nextSnapshot = prevSnapshot) => new SnapshotRenderer(prevSnapshot, nextSnapshot)
