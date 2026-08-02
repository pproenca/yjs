import * as delta from 'lib0/delta'

import { ContentFormat, ContentType } from '../structs/Item.js'
import { createIdSet, diffIdSet, intersectSets } from './ids.js'
import { readRendererLifecycle, rendererContentLength } from './renderer-helpers.js'
import { transact } from './Transaction.js'

/**
 * @typedef {{ readonly client: number, readonly clock: number, readonly length: number }} StructuralIdRange
 * @typedef {{ readonly rangeCountUpperBound: number }} DeltaMutationReservation
 * @typedef {{
 *   readonly inserts: readonly StructuralIdRange[],
 *   readonly deletes: readonly StructuralIdRange[],
 *   readonly rangeCount: number
 * }} DeltaMutationContent
 * @typedef {{ afterMutation?: (content: DeltaMutationContent) => void }} DeltaMutationApplyOptions
 * @typedef {{
 *   readonly reservation: DeltaMutationReservation,
 *   apply: (options?: DeltaMutationApplyOptions) => delta.DeltaBuilder<any>?,
 *   discard: () => void
 * }} PreparedDeltaMutation
 * @typedef {(transaction: Transaction, mutation: delta.DeltaAny) => delta.DeltaBuilder<any>?} DeltaMutationExecutor
 * @typedef {{ revision: number }} DocumentRevision
 * @typedef {{
 *   status: 'prepared'|'applying'|'consumed'|'discarded',
 *   type: YType<any>,
 *   doc: Doc,
 *   renderer: AbstractRenderer?,
 *   rendererLifecycle: Readonly<{revision:number,active:boolean}>?,
 *   documentRevision: number,
 *   mutation: delta.DeltaAny,
 *   origin: any,
 *   rangeCountUpperBound: number,
 *   executor: DeltaMutationExecutor
 * }} PreparedDeltaMutationState
 * @typedef {{ item: Item?, offset: number }} StructuralCursor
 * @typedef {{ deletes: IdSet, formatHazards: Set<Item>, allocates: boolean }} ReservationScan
 */

export class DeltaMutationPreparationError extends Error {
  /** @param {string} message */
  constructor (message) {
    super(message)
    this.name = 'DeltaMutationPreparationError'
  }
}

export class DeltaMutationCapabilityError extends Error {
  /** @param {string} message */
  constructor (message) {
    super(message)
    this.name = 'DeltaMutationCapabilityError'
  }
}

export class DeltaMutationStaleError extends Error {
  /** @param {string} message */
  constructor (message) {
    super(message)
    this.name = 'DeltaMutationStaleError'
  }
}

export class DeltaMutationInvariantError extends Error {
  /**
   * @param {string} message
   * @param {any} [cause]
   */
  constructor (message, cause) {
    super(message)
    this.name = 'DeltaMutationInvariantError'
    if (cause !== undefined) /** @type {any} */ (this).cause = cause
  }
}

/** @type {WeakMap<Doc, DocumentRevision>} */
const documentRevisions = new WeakMap()

/** @type {WeakMap<object, PreparedDeltaMutationState>} */
const preparedMutations = new WeakMap()

/**
 * @param {Doc} doc
 */
const getDocumentRevision = doc => {
  let revision = documentRevisions.get(doc)
  if (revision === undefined) {
    const tracker = { revision: 0 }
    revision = tracker
    documentRevisions.set(doc, tracker)
    doc.on('beforeObserverCalls', transaction => {
      if (!transaction.insertSet.isEmpty() || !transaction.deleteSet.isEmpty()) {
        tracker.revision++
      }
    })
  }
  return revision.revision
}

/**
 * @param {IdSet} ids
 */
const cloneIdSet = ids => {
  const clone = createIdSet()
  ids.forEach((range, client) => clone.add(client, range.clock, range.len))
  return clone
}

/**
 * @param {IdSet} ids
 */
const countRanges = ids => {
  let count = 0
  ids.clients.forEach(ranges => { count += ranges.getIds().length })
  return count
}

/**
 * @param {IdSet} ids
 * @return {readonly StructuralIdRange[]}
 */
const freezeRanges = ids => {
  /** @type {StructuralIdRange[]} */
  const result = []
  ids.forEach((range, client) => {
    result.push(Object.freeze({ client, clock: range.clock, length: range.len }))
  })
  result.sort((left, right) => left.client - right.client || left.clock - right.clock)
  return Object.freeze(result)
}

/**
 * @param {Item} item
 * @param {ReservationScan} scan
 */
const addDeletedTypeContents = (item, scan) => {
  if (item.content.constructor !== ContentType) return
  const type = /** @type {ContentType} */ (item.content).type
  for (let child = type._start; child !== null; child = child.right) {
    if (!child.deleted) {
      scan.deletes.add(child.id.client, child.id.clock, child.length)
      addDeletedTypeContents(child, scan)
    }
  }
  type._map.forEach(child => {
    if (!child.deleted) {
      scan.deletes.add(child.id.client, child.id.clock, child.length)
      addDeletedTypeContents(child, scan)
    }
  })
}

/**
 * @param {Item} item
 * @param {number} offset
 * @param {number} length
 * @param {ReservationScan} scan
 */
const addDeleteSlice = (item, offset, length, scan) => {
  if (item.deleted || length === 0) return
  scan.deletes.add(item.id.client, item.id.clock + offset, length)
  if (offset === 0 && length === item.length) addDeletedTypeContents(item, scan)
}

/**
 * @param {Item} item
 * @param {ReservationScan} scan
 */
const addFormatHazard = (item, scan) => {
  if (!item.deleted && item.content.constructor === ContentFormat) {
    scan.formatHazards.add(item)
  }
}

/**
 * Advance through a rendered structural slice. This follows the delta cursor without splitting or
 * mutating items. Delete slices are exact; format cleanup candidates remain separate hazards so a
 * false-positive marker cannot bridge two real delete ranges and lower the bound.
 *
 * @param {StructuralCursor} cursor
 * @param {number} length
 * @param {AbstractRenderer?} renderer
 * @param {ReservationScan} scan
 * @param {boolean} deleting
 * @param {boolean} formatting
 */
const advanceStructuralCursor = (cursor, length, renderer, scan, deleting, formatting) => {
  while (length > 0) {
    const item = cursor.item
    if (item === null) throw new DeltaMutationPreparationError('Delta exceeds the rendered content range')
    const renderedLength = rendererContentLength(renderer, item)
    if (renderedLength === 0) {
      if (deleting || formatting) addFormatHazard(item, scan)
      cursor.item = item.right
      cursor.offset = 0
      continue
    }
    const available = renderedLength - cursor.offset
    const consumed = Math.min(length, available)
    if (deleting) addDeleteSlice(item, cursor.offset, consumed, scan)
    length -= consumed
    if (consumed === available) {
      cursor.item = item.right
      cursor.offset = 0
    } else {
      cursor.offset += consumed
    }
  }
}

/**
 * @param {StructuralCursor} cursor
 * @param {AbstractRenderer?} renderer
 * @param {ReservationScan} scan
 */
const collectTrailingFormatHazards = (cursor, renderer, scan) => {
  for (let item = cursor.item; item !== null && rendererContentLength(renderer, item) === 0; item = item.right) {
    addFormatHazard(item, scan)
  }
}

/**
 * @param {StructuralCursor} cursor
 * @param {AbstractRenderer?} renderer
 */
const findRenderedItem = (cursor, renderer) => {
  let item = cursor.item
  while (item !== null && rendererContentLength(renderer, item) === 0) item = item.right
  return item
}

/**
 * @param {YType<any>} type
 * @param {delta.DeltaAny} mutation
 * @param {AbstractRenderer?} renderer
 * @param {ReservationScan} scan
 */
const scanDeltaMutation = (type, mutation, renderer, scan) => {
  /** @type {StructuralCursor} */
  const cursor = { item: type._start, offset: 0 }
  for (const op of mutation.children) {
    if (delta.$textOp.check(op) || delta.$insertOp.check(op)) {
      if (op.length > 0) scan.allocates = true
    } else if (delta.$retainOp.check(op)) {
      const formatting = op.format != null && Object.keys(op.format).length > 0
      if (formatting) scan.allocates = true
      advanceStructuralCursor(cursor, op.retain, renderer, scan, false, formatting)
      if (formatting) collectTrailingFormatHazards(cursor, renderer, scan)
    } else if (delta.$deleteOp.check(op)) {
      advanceStructuralCursor(cursor, op.delete, renderer, scan, true, false)
      collectTrailingFormatHazards(cursor, renderer, scan)
    } else if (delta.$modifyOp.check(op)) {
      const item = findRenderedItem(cursor, renderer)
      if (item === null || item.content.constructor !== ContentType || cursor.offset !== 0) {
        throw new DeltaMutationPreparationError('Delta modify target is not a structural child type')
      }
      scanDeltaMutation(/** @type {ContentType} */ (item.content).type, op.value, renderer, scan)
      const formatting = op.format != null && Object.keys(op.format).length > 0
      if (formatting) scan.allocates = true
      advanceStructuralCursor(cursor, 1, renderer, scan, false, formatting)
      if (formatting) collectTrailingFormatHazards(cursor, renderer, scan)
    }
  }
  for (const op of mutation.attrs) {
    const item = type._map.get(/** @type {any} */ (op.key))
    if (delta.$setAttrOp.check(op)) {
      scan.allocates = true
      if (item !== undefined && !item.deleted) {
        scan.deletes.add(item.id.client, item.id.clock, item.length)
        addDeletedTypeContents(item, scan)
      }
    } else if (delta.$deleteAttrOp.check(op)) {
      if (item !== undefined && !item.deleted) {
        scan.deletes.add(item.id.client, item.id.clock, item.length)
        addDeletedTypeContents(item, scan)
      }
    } else {
      if (item === undefined || item.content.constructor !== ContentType) {
        throw new DeltaMutationPreparationError('Delta modifyAttr target is not a structural child type')
      }
      scanDeltaMutation(/** @type {ContentType} */ (item.content).type, op.value, renderer, scan)
    }
  }
}

/**
 * @param {YType<any>} type
 * @param {delta.DeltaAny} mutation
 * @param {AbstractRenderer?} renderer
 */
const reserveRangeCount = (type, mutation, renderer) => {
  /** @type {ReservationScan} */
  const scan = { deletes: createIdSet(), formatHazards: new Set(), allocates: false }
  scanDeltaMutation(type, mutation, renderer, scan)
  let rangeCount = countRanges(scan.deletes)
  scan.formatHazards.forEach(item => {
    if (!scan.deletes.hasId(item.id)) rangeCount++
  })
  return rangeCount + (scan.allocates ? 1 : 0)
}

/**
 * @param {PreparedDeltaMutationState} state
 */
const assertFresh = state => {
  if (state.doc.isDestroyed || state.doc._transaction !== null || state.doc._transactionCleanups.length !== 0) {
    throw new DeltaMutationStaleError('Prepared delta mutation requires a quiescent live document')
  }
  if (getDocumentRevision(state.doc) !== state.documentRevision) {
    throw new DeltaMutationStaleError('Prepared delta mutation document revision changed')
  }
  if (state.renderer !== null) {
    const lifecycle = readRendererLifecycle(state.renderer)
    if (lifecycle === null || lifecycle !== state.rendererLifecycle || !lifecycle.active) {
      throw new DeltaMutationStaleError('Prepared delta mutation renderer revision changed')
    }
  }
}

/**
 * @param {PreparedDeltaMutationState} state
 */
const assertRendererFreshInsideTransaction = state => {
  if (state.renderer !== null) {
    const lifecycle = readRendererLifecycle(state.renderer)
    if (lifecycle === null || lifecycle !== state.rendererLifecycle || !lifecycle.active) {
      throw new DeltaMutationStaleError('Prepared delta mutation renderer revision changed before execution')
    }
  }
}

/**
 * @param {Transaction} transaction
 * @param {PreparedDeltaMutationState} state
 * @param {((content: DeltaMutationContent) => void)|undefined} afterMutation
 */
const applyInTransaction = (transaction, state, afterMutation) => {
  if (!transaction.insertSet.isEmpty() || !transaction.deleteSet.isEmpty()) {
    throw new DeltaMutationInvariantError('beforeTransaction mutated the reserved document before delta execution')
  }
  assertRendererFreshInsideTransaction(state)
  const beforeInserts = cloneIdSet(transaction.insertSet)
  const beforeDeletes = cloneIdSet(transaction.deleteSet)
  const fix = state.executor(transaction, state.mutation)
  const inserts = diffIdSet(transaction.insertSet, beforeInserts)
  const deletes = diffIdSet(transaction.deleteSet, beforeDeletes)
  if (!intersectSets(inserts, deletes).isEmpty()) {
    throw new DeltaMutationInvariantError('Reserved delta inserted and deleted the same structural IDs')
  }
  const frozenInserts = freezeRanges(inserts)
  const frozenDeletes = freezeRanges(deletes)
  const rangeCount = frozenInserts.length + frozenDeletes.length
  if (rangeCount > state.rangeCountUpperBound) {
    throw new DeltaMutationInvariantError(`Reserved delta range underbound: ${rangeCount} > ${state.rangeCountUpperBound}`)
  }
  const content = Object.freeze({ inserts: frozenInserts, deletes: frozenDeletes, rangeCount })
  if (afterMutation !== undefined) {
    try {
      afterMutation(content)
    } catch (cause) {
      throw new DeltaMutationInvariantError('Reserved delta afterMutation callback failed', cause)
    }
  }
  return fix
}

class PreparedDeltaMutationCapability {
  /** @param {DeltaMutationReservation} reservation */
  constructor (reservation) {
    /** @readonly */
    this.reservation = reservation
    Object.freeze(this)
  }

  /**
   * @param {DeltaMutationApplyOptions} [options]
   */
  apply (options = {}) {
    const state = preparedMutations.get(this)
    if (state === undefined || state.status !== 'prepared') {
      throw new DeltaMutationCapabilityError('Prepared delta mutation is invalid or already used')
    }
    state.status = 'applying'
    try {
      if (options === null || typeof options !== 'object') {
        throw new DeltaMutationCapabilityError('Delta mutation apply options must be an object')
      }
      const { afterMutation } = options
      if (afterMutation !== undefined && typeof afterMutation !== 'function') {
        throw new DeltaMutationCapabilityError('afterMutation must be a function')
      }
      assertFresh(state)
      return transact(state.doc, transaction => applyInTransaction(transaction, state, afterMutation), state.origin)
    } finally {
      state.status = 'consumed'
    }
  }

  discard () {
    const state = preparedMutations.get(this)
    if (state === undefined || state.status !== 'prepared') {
      throw new DeltaMutationCapabilityError('Prepared delta mutation is invalid or already used')
    }
    state.status = 'discarded'
  }
}

/**
 * Detach all mutable values the canonical interpreter can consume while preserving embedded Yjs
 * types/documents as identity-bearing integration inputs.
 *
 * @param {delta.DeltaAny} mutation
 * @param {YType<any>} target
 * @param {Doc} doc
 */
const ownDeltaMutation = (mutation, target, doc) => {
  /** @type {Map<object, any>} */
  const values = new Map()
  /** @type {Set<object>} */
  const visiting = new Set()
  /** @type {Set<delta.DeltaAny>} */
  const visitedDeltas = new Set()
  /** @param {any} value */
  const cloneValue = value => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      if (typeof value === 'symbol') throw new DeltaMutationPreparationError('Delta contains an unsupported symbol value')
      return value
    }
    if (value instanceof target.constructor || value instanceof doc.constructor) return value
    if (delta.$deltaAny.check(value)) {
      const owned = /** @type {delta.DeltaAny} */ (/** @type {any} */ (delta.cloneDeep)(value))
      ownDelta(owned)
      return owned
    }
    if (typeof value === 'function') throw new DeltaMutationPreparationError('Delta contains an unsupported function value')
    const existing = values.get(value)
    if (existing !== undefined) {
      if (visiting.has(value)) throw new DeltaMutationPreparationError('Delta contains a cyclic value')
      return existing
    }
    if (value instanceof Uint8Array) {
      const owned = new Uint8Array(value)
      values.set(value, owned)
      return owned
    }
    if (value instanceof Date) {
      const owned = new Date(value.getTime())
      values.set(value, owned)
      return owned
    }
    if (value instanceof RegExp) {
      const owned = new RegExp(value.source, value.flags)
      owned.lastIndex = value.lastIndex
      values.set(value, owned)
      return owned
    }
    if (value instanceof Map) {
      const owned = new Map()
      values.set(value, owned)
      visiting.add(value)
      try {
        value.forEach((entry, key) => owned.set(cloneValue(key), cloneValue(entry)))
      } finally {
        visiting.delete(value)
      }
      return owned
    }
    if (value instanceof Set) {
      const owned = new Set()
      values.set(value, owned)
      visiting.add(value)
      try {
        value.forEach(entry => owned.add(cloneValue(entry)))
      } finally {
        visiting.delete(value)
      }
      return owned
    }
    if (Array.isArray(value)) {
      const owned = new Array(value.length)
      values.set(value, owned)
      visiting.add(value)
      try {
        for (let index = 0; index < value.length; index++) {
          if (Object.prototype.hasOwnProperty.call(value, index)) owned[index] = cloneValue(value[index])
        }
      } finally {
        visiting.delete(value)
      }
      return owned
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DeltaMutationPreparationError('Delta contains an unsupported mutable value')
    }
    const owned = Object.create(prototype)
    values.set(value, owned)
    visiting.add(value)
    try {
      Object.keys(value).forEach(key => {
        Object.defineProperty(owned, key, {
          configurable: true,
          enumerable: true,
          value: cloneValue(value[key]),
          writable: true
        })
      })
    } finally {
      visiting.delete(value)
    }
    return owned
  }
  /** @param {delta.DeltaAny} owned */
  const ownDelta = owned => {
    if (visitedDeltas.has(owned)) return
    visitedDeltas.add(owned)
    for (const op of owned.children) {
      if (delta.$insertOp.check(op)) {
        for (let index = 0; index < op.insert.length; index++) op.insert[index] = cloneValue(op.insert[index])
      } else if (delta.$modifyOp.check(op)) {
        ownDelta(op.value)
      }
      if ('format' in op) /** @type {any} */ (op).format = cloneValue(op.format)
      if ('attribution' in op) /** @type {any} */ (op).attribution = cloneValue(op.attribution)
    }
    for (const op of owned.attrs) {
      if (delta.$setAttrOp.check(op)) {
        /** @type {any} */ (op).value = cloneValue(op.value)
      } else if (delta.$modifyAttrOp.check(op)) {
        ownDelta(op.value)
      }
      if ('attribution' in op) /** @type {any} */ (op).attribution = cloneValue(op.attribution)
    }
  }
  const owned = /** @type {delta.DeltaAny} */ (/** @type {any} */ (delta.cloneDeep)(mutation))
  ownDelta(owned)
  return owned
}

/**
 * @param {YType<any>} type
 * @param {delta.DeltaAny} mutation
 * @param {any} origin
 * @param {AbstractRenderer?} renderer
 * @param {DeltaMutationExecutor} executor
 * @return {PreparedDeltaMutation}
 */
export const createPreparedDeltaMutation = (type, mutation, origin, renderer, executor) => {
  const doc = type.doc
  if (doc === null || doc.isDestroyed) {
    throw new DeltaMutationPreparationError('Delta mutation target must be integrated in a live document')
  }
  if (doc._transaction !== null || doc._transactionCleanups.length !== 0) {
    throw new DeltaMutationPreparationError('Delta mutation preparation requires a quiescent document')
  }
  const documentRevision = getDocumentRevision(doc)
  let rendererLifecycle = null
  if (renderer !== null) {
    rendererLifecycle = readRendererLifecycle(renderer)
    if (rendererLifecycle === null || !rendererLifecycle.active) {
      throw new DeltaMutationPreparationError('Delta mutation renderer must be a live tracked DiffRenderer')
    }
  }
  const assertPreparationFresh = () => {
    if (
      doc.isDestroyed ||
      doc._transaction !== null ||
      doc._transactionCleanups.length !== 0 ||
      getDocumentRevision(doc) !== documentRevision ||
      (renderer !== null && readRendererLifecycle(renderer) !== rendererLifecycle)
    ) {
      throw new DeltaMutationStaleError('Delta mutation state changed during preparation')
    }
  }
  let isEmpty
  try {
    isEmpty = mutation.isEmpty()
  } catch (cause) {
    assertPreparationFresh()
    throw cause
  }
  assertPreparationFresh()
  if (isEmpty) {
    throw new DeltaMutationPreparationError('Cannot reserve an empty delta mutation')
  }
  let ownedMutation
  let rangeCountUpperBound
  try {
    ownedMutation = ownDeltaMutation(mutation, type, doc)
    rangeCountUpperBound = reserveRangeCount(type, ownedMutation, renderer)
  } catch (cause) {
    assertPreparationFresh()
    throw cause
  }
  assertPreparationFresh()
  const reservation = Object.freeze({ rangeCountUpperBound })
  const capability = new PreparedDeltaMutationCapability(reservation)
  preparedMutations.set(capability, {
    status: 'prepared',
    type,
    doc,
    renderer,
    rendererLifecycle,
    documentRevision,
    mutation: ownedMutation,
    origin,
    rangeCountUpperBound,
    executor
  })
  return capability
}
