import * as delta from 'lib0/delta'

import { ContentFormat, ContentType } from '../structs/Item.js'
import { createIdSet, diffIdSet, intersectSets } from './ids.js'
import { readRendererLifecycle, rendererContentLength } from './renderer-helpers.js'
import { readDocumentStructuralRevision, transact } from './Transaction.js'

/**
 * @typedef {{ readonly client: number, readonly clock: number, readonly length: number }} StructuralIdRange
 * @typedef {{ readonly rangeCountUpperBound: number }} DeltaMutationReservation
 * @typedef {{
 *   readonly inserts: readonly StructuralIdRange[],
 *   readonly deletes: readonly StructuralIdRange[],
 *   readonly rangeCount: number
 * }} DeltaMutationContent
 * @typedef {{ afterMutation?: (content: DeltaMutationContent) => void }} DeltaMutationApplyOptions
 * @typedef {(mutation: delta.DeltaAny, origin?: any, options?: any) => delta.DeltaBuilder<any>?} CanonicalDeltaApply
 * @typedef {{
 *   readonly reservation: DeltaMutationReservation,
 *   apply: (options?: DeltaMutationApplyOptions) => delta.DeltaBuilder<any>?,
 *   discard: () => void
 * }} PreparedDeltaMutation
 * @typedef {(transaction: Transaction, mutation: delta.DeltaAny) => delta.DeltaBuilder<any>?} DeltaMutationExecutor
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
 *   executor: DeltaMutationExecutor,
 *   canonicalApplyDelta: CanonicalDeltaApply,
 *   guardedTypes: Set<YType<any>>
 * }} PreparedDeltaMutationState
 * @typedef {{ item: Item?, offset: number }} StructuralCursor
 * @typedef {{
 *   deletes: IdSet,
 *   formatHazards: Set<Item>,
 *   allocates: boolean,
 *   doc: Doc,
 *   canonicalApplyDelta: CanonicalDeltaApply,
 *   guardedTypes: Set<YType<any>>
 * }} ReservationScan
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

/** @type {WeakMap<object, PreparedDeltaMutationState>} */
const preparedMutations = new WeakMap()

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
  if (type.doc !== scan.doc || type.applyDelta !== scan.canonicalApplyDelta) {
    throw new DeltaMutationPreparationError('Reserved delta mutation requires canonical target types')
  }
  scan.guardedTypes.add(type)
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
    } else {
      throw new DeltaMutationPreparationError('Delta contains an unsupported child operation')
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
    } else if (delta.$modifyAttrOp.check(op)) {
      if (
        item === undefined ||
        item.content.constructor !== ContentType ||
        (item.deleted && rendererContentLength(renderer, item) === 0)
      ) {
        throw new DeltaMutationPreparationError('Delta modifyAttr target is not a structural child type')
      }
      scanDeltaMutation(/** @type {ContentType} */ (item.content).type, op.value, renderer, scan)
    } else {
      throw new DeltaMutationPreparationError('Delta contains an unsupported attribute operation')
    }
  }
}

/**
 * @param {YType<any>} type
 * @param {delta.DeltaAny} mutation
 * @param {AbstractRenderer?} renderer
 * @param {Doc} doc
 * @param {CanonicalDeltaApply} canonicalApplyDelta
 */
const reserveRangeCount = (type, mutation, renderer, doc, canonicalApplyDelta) => {
  /** @type {ReservationScan} */
  const scan = {
    deletes: createIdSet(),
    formatHazards: new Set(),
    allocates: false,
    doc,
    canonicalApplyDelta,
    guardedTypes: new Set()
  }
  scanDeltaMutation(type, mutation, renderer, scan)
  let rangeCount = countRanges(scan.deletes)
  scan.formatHazards.forEach(item => {
    if (!scan.deletes.hasId(item.id)) rangeCount++
  })
  return {
    rangeCountUpperBound: rangeCount + (scan.allocates ? 1 : 0),
    guardedTypes: scan.guardedTypes
  }
}

/** @param {PreparedDeltaMutationState} state */
const assertGuardedTypesFresh = state => {
  for (const type of state.guardedTypes) {
    if (type.doc !== state.doc || type.applyDelta !== state.canonicalApplyDelta) {
      throw new DeltaMutationStaleError('Prepared delta mutation target dispatch changed')
    }
  }
}

/**
 * @param {PreparedDeltaMutationState} state
 */
const assertFresh = state => {
  if (state.doc.isDestroyed || state.doc._transaction !== null || state.doc._transactionCleanups.length !== 0) {
    throw new DeltaMutationStaleError('Prepared delta mutation requires a quiescent live document')
  }
  if (readDocumentStructuralRevision(state.doc) !== state.documentRevision) {
    throw new DeltaMutationStaleError('Prepared delta mutation document revision changed')
  }
  assertGuardedTypesFresh(state)
  if (state.renderer !== null) {
    const lifecycle = readRendererLifecycle(state.renderer)
    if (lifecycle === null || lifecycle !== state.rendererLifecycle || !lifecycle.active) {
      throw new DeltaMutationStaleError('Prepared delta mutation renderer revision changed')
    }
  }
}

/**
 * @param {Transaction} transaction
 * @param {PreparedDeltaMutationState} state
 */
const assertFreshInsideTransaction = (transaction, state) => {
  if (state.doc.isDestroyed || state.type.doc !== state.doc) {
    throw new DeltaMutationStaleError('Prepared delta mutation target changed before execution')
  }
  if (transaction.doc !== state.doc || state.doc._transaction !== transaction || transaction._done) {
    throw new DeltaMutationInvariantError('Prepared delta mutation lost its reserved transaction')
  }
  assertGuardedTypesFresh(state)
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
  assertFreshInsideTransaction(transaction, state)
  if (!transaction.insertSet.isEmpty() || !transaction.deleteSet.isEmpty()) {
    throw new DeltaMutationInvariantError('beforeTransaction mutated the reserved document before delta execution')
  }
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

/** @param {any} value */
const assertPositiveLength = value => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DeltaMutationPreparationError('Delta contains an invalid operation length')
  }
}

/**
 * Detach every mutable input the canonical interpreter can consume. Raw shared types and subdocs
 * are rejected because preparation cannot privately own them without mutating preliminary content
 * or cloning a document; callers can express nested shared types with owned delta syntax instead.
 * Every source delta is inspected and rebuilt once. In particular, caller-controlled `op.clone`
 * dispatch is never used.
 *
 * @param {delta.DeltaAny} mutation
 * @param {YType<any>} target
 * @param {Doc} doc
 */
const ownDeltaMutation = (mutation, target, doc) => {
  /** @type {Map<object, any>} */
  const values = new Map()
  /** @type {Set<object>} */
  const visitingValues = new Set()
  /**
   * @param {any} value
   * @param {'child'|'attr'|'data'} context
   */
  const cloneValue = (value, context) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      if (typeof value === 'symbol') throw new DeltaMutationPreparationError('Delta contains an unsupported symbol value')
      return value
    }
    if (value instanceof target.constructor) {
      throw new DeltaMutationPreparationError('Raw shared types are unsupported; use nested delta syntax')
    }
    if (value instanceof doc.constructor) {
      throw new DeltaMutationPreparationError('Embedded documents are unsupported by reserved delta mutation')
    }
    if (delta.$deltaAny.check(value)) {
      throw new DeltaMutationPreparationError('Nested deltas are only valid as direct child content')
    }
    if (typeof value === 'function') throw new DeltaMutationPreparationError('Delta contains an unsupported function value')
    if (context === 'attr') {
      const constructor = value.constructor
      if (constructor !== Object && constructor !== Array && constructor !== Date && constructor !== Uint8Array) {
        throw new DeltaMutationPreparationError('Delta attribute contains an unsupported value')
      }
    }
    const existing = values.get(value)
    if (existing !== undefined) {
      if (visitingValues.has(value)) throw new DeltaMutationPreparationError('Delta contains a cyclic value')
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
    if (Array.isArray(value)) {
      const owned = new Array(value.length)
      values.set(value, owned)
      visitingValues.add(value)
      try {
        for (let index = 0; index < value.length; index++) {
          if (Object.prototype.hasOwnProperty.call(value, index)) owned[index] = cloneValue(value[index], 'data')
        }
      } finally {
        visitingValues.delete(value)
      }
      return owned
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DeltaMutationPreparationError('Delta contains an unsupported mutable value')
    }
    const owned = Object.create(prototype)
    values.set(value, owned)
    visitingValues.add(value)
    try {
      Object.keys(value).forEach(key => {
        Object.defineProperty(owned, key, {
          configurable: true,
          enumerable: true,
          value: cloneValue(value[key], 'data'),
          writable: true
        })
      })
    } finally {
      visitingValues.delete(value)
    }
    return owned
  }

  /** @type {Map<delta.DeltaAny,delta.DeltaAny>} */
  const ownedDeltas = new Map()
  /** @type {Map<delta.DeltaAny,0|1|2>} */
  const deltaStates = new Map()
  /** @type {Map<delta.DeltaAny,any>} */
  const records = new Map()
  /** @type {delta.DeltaAny[]} */
  const completed = []

  /** @param {any} key */
  const ownKey = key => {
    if (
      (typeof key !== 'string' && typeof key !== 'number') ||
      (typeof key === 'number' && !Number.isSafeInteger(key))
    ) {
      throw new DeltaMutationPreparationError('Delta contains an invalid attribute key')
    }
    return key
  }

  /** @param {delta.DeltaAny} source */
  const inspectDelta = source => {
    if (!delta.$deltaAny.check(source)) {
      throw new DeltaMutationPreparationError('Delta contains an invalid nested delta')
    }
    const OwnedDeltaBuilder = /** @type {any} */ (delta.DeltaBuilder)
    const owned = /** @type {delta.DeltaAny} */ (new OwnedDeltaBuilder(source.name, source.$schema))
    ownedDeltas.set(source, owned)
    /** @type {any[]} */
    const children = []
    /** @type {any[]} */
    const attrs = []
    /** @type {delta.DeltaAny[]} */
    const nested = []
    for (const op of source.children) {
      if (delta.$textOp.check(op)) {
        const insert = op.insert
        if (typeof insert !== 'string') throw new DeltaMutationPreparationError('Delta contains invalid text content')
        assertPositiveLength(insert.length)
        children.push({
          kind: 'text',
          insert,
          format: cloneValue(op.format, 'data'),
          attribution: cloneValue(op.attribution, 'data')
        })
      } else if (delta.$insertOp.check(op)) {
        const insert = op.insert
        if (!Array.isArray(insert)) throw new DeltaMutationPreparationError('Delta contains invalid inserted content')
        assertPositiveLength(insert.length)
        const content = insert.map(value => {
          if (delta.$deltaAny.check(value)) {
            nested.push(value)
            return value
          }
          return cloneValue(value, 'child')
        })
        children.push({
          kind: 'insert',
          insert: content,
          format: cloneValue(op.format, 'data'),
          attribution: cloneValue(op.attribution, 'data')
        })
      } else if (delta.$retainOp.check(op)) {
        const retain = op.retain
        assertPositiveLength(retain)
        children.push({
          kind: 'retain',
          retain,
          format: cloneValue(op.format, 'data'),
          attribution: cloneValue(op.attribution, 'data')
        })
      } else if (delta.$deleteOp.check(op)) {
        const length = op.delete
        assertPositiveLength(length)
        children.push({ kind: 'delete', length })
      } else if (delta.$modifyOp.check(op)) {
        const value = op.value
        if (!delta.$deltaAny.check(value)) throw new DeltaMutationPreparationError('Delta contains an invalid nested delta')
        nested.push(value)
        children.push({
          kind: 'modify',
          value,
          format: cloneValue(op.format, 'data'),
          attribution: cloneValue(op.attribution, 'data')
        })
      } else {
        throw new DeltaMutationPreparationError('Delta contains an unsupported child operation')
      }
    }
    for (const op of source.attrs) {
      if (delta.$setAttrOp.check(op)) {
        const value = op.value
        if (delta.$deltaAny.check(value)) {
          throw new DeltaMutationPreparationError('Delta attributes cannot be set to a nested delta')
        }
        attrs.push({
          kind: 'set',
          key: ownKey(op.key),
          value: cloneValue(value, 'attr'),
          attribution: cloneValue(op.attribution, 'data')
        })
      } else if (delta.$deleteAttrOp.check(op)) {
        attrs.push({
          kind: 'delete',
          key: ownKey(op.key),
          attribution: cloneValue(op.attribution, 'data')
        })
      } else if (delta.$modifyAttrOp.check(op)) {
        const value = op.value
        if (!delta.$deltaAny.check(value)) throw new DeltaMutationPreparationError('Delta contains an invalid nested delta')
        nested.push(value)
        attrs.push({
          kind: 'modify',
          key: ownKey(op.key),
          value,
          attribution: cloneValue(op.attribution, 'data')
        })
      } else {
        throw new DeltaMutationPreparationError('Delta contains an unsupported attribute operation')
      }
    }
    records.set(source, { owned, children, attrs, nested })
    return nested
  }

  /** @type {Array<{source:delta.DeltaAny,exit:boolean}>} */
  const stack = [{ source: mutation, exit: false }]
  while (stack.length > 0) {
    const frame = /** @type {{source:delta.DeltaAny,exit:boolean}} */ (stack.pop())
    const state = deltaStates.get(frame.source)
    if (frame.exit) {
      deltaStates.set(frame.source, 2)
      completed.push(frame.source)
    } else if (state === 1) {
      throw new DeltaMutationPreparationError('Delta contains a cyclic nested delta')
    } else if (state !== 2) {
      deltaStates.set(frame.source, 1)
      const nested = inspectDelta(frame.source)
      stack.push({ source: frame.source, exit: true })
      for (let index = nested.length - 1; index >= 0; index--) {
        stack.push({ source: nested[index], exit: false })
      }
    }
  }

  for (const source of completed) {
    const { owned, children, attrs } = records.get(source)
    for (const op of children) {
      if (op.kind === 'text') {
        owned.insert(op.insert, op.format, op.attribution)
      } else if (op.kind === 'insert') {
        owned.insert(/** @type {any[]} */ (op.insert).map(value => ownedDeltas.get(value) ?? value), op.format, op.attribution)
      } else if (op.kind === 'retain') {
        owned.retain(op.retain, op.format, op.attribution)
      } else if (op.kind === 'delete') {
        owned.delete(op.length)
      } else {
        owned.modify(ownedDeltas.get(op.value), op.format, op.attribution)
      }
    }
    for (const op of attrs) {
      if (op.kind === 'set') {
        owned.setAttr(op.key, op.value, op.attribution)
      } else if (op.kind === 'delete') {
        owned.deleteAttr(op.key, op.attribution)
      } else {
        owned.modifyAttr(op.key, ownedDeltas.get(op.value), op.attribution)
      }
    }
    owned.origin = source.origin
    owned.isFinal = source.isFinal
  }
  return /** @type {delta.DeltaAny} */ (ownedDeltas.get(mutation))
}

/**
 * @param {YType<any>} type
 * @param {delta.DeltaAny} mutation
 * @param {any} origin
 * @param {AbstractRenderer?} renderer
 * @param {DeltaMutationExecutor} executor
 * @param {CanonicalDeltaApply} canonicalApplyDelta
 * @return {PreparedDeltaMutation}
 */
export const createPreparedDeltaMutation = (type, mutation, origin, renderer, executor, canonicalApplyDelta) => {
  const doc = type.doc
  if (doc === null || doc.isDestroyed) {
    throw new DeltaMutationPreparationError('Delta mutation target must be integrated in a live document')
  }
  if (doc._transaction !== null || doc._transactionCleanups.length !== 0) {
    throw new DeltaMutationPreparationError('Delta mutation preparation requires a quiescent document')
  }
  const documentRevision = readDocumentStructuralRevision(doc)
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
      readDocumentStructuralRevision(doc) !== documentRevision ||
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
  let guardedTypes
  try {
    ownedMutation = ownDeltaMutation(mutation, type, doc)
    if (ownedMutation.isEmpty()) {
      throw new DeltaMutationPreparationError('Cannot reserve an empty delta mutation')
    }
    const reservation = reserveRangeCount(type, ownedMutation, renderer, doc, canonicalApplyDelta)
    rangeCountUpperBound = reservation.rangeCountUpperBound
    guardedTypes = reservation.guardedTypes
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
    executor,
    canonicalApplyDelta,
    guardedTypes
  })
  return capability
}
