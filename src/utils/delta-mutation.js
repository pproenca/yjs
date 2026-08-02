import * as delta from 'lib0/delta'

import { ContentFormat, ContentType, createContentTypeCanonical } from '../structs/Item.js'
import { createIdSet, diffIdSet, intersectSets } from './ids.js'
import { readRendererExecutionAdapter, readRendererLifecycle, rendererContentLength } from './renderer-helpers.js'
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
 * @typedef {(transaction: Transaction, mutation: object, renderer: AbstractRenderer?) => delta.DeltaBuilder<any>?} DeltaMutationExecutor
 * @typedef {(type:YType<any>, renderer:AbstractRenderer?) => DeltaMutationPlan} DeltaMutationPlanRenderer
 * @typedef {{
 *   status: 'prepared'|'applying'|'consumed'|'discarded',
 *   type: YType<any>,
 *   doc: Doc,
 *   renderer: AbstractRenderer?,
 *   executionRenderer: AbstractRenderer?,
 *   rendererLifecycle: Readonly<{revision:number,active:boolean}>?,
 *   documentRevision: number,
 *   mutation: object,
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
 *   guardedTypes: Set<YType<any>>,
 *   createNestedType: (name:null|string) => YType<any>,
 *   renderDeltaPlan: DeltaMutationPlanRenderer
 * }} ReservationScan
 * @typedef {{ readonly name: null|string, readonly children: readonly any[], readonly attrs: readonly any[], readonly preparedFix?: delta.DeltaBuilder<any>? }} DeltaMutationPlan
 */

// Reserved mutation preparation is deliberately finite. These bounds apply only to the privately
// owned plan; ordinary applyDelta remains unbounded and unchanged.
const maxDeltaMutationDepth = 256
const maxDeltaMutationNodes = 4096
const maxDeltaMutationPayloadDepth = 64
const maxDeltaMutationPayloadNodes = 8192

const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const objectGetPrototypeOf = Object.getPrototypeOf
const objectKeys = Object.keys
const objectFreeze = Object.freeze
const objectCreate = Object.create
const objectDefineProperty = Object.defineProperty
const reflectApply = Reflect.apply
const arrayPop = Array.prototype.pop
const objectHasOwnProperty = Object.prototype.hasOwnProperty
/** @param {object} value @param {PropertyKey} key */
const objectHasOwn = (value, key) => reflectApply(objectHasOwnProperty, value, [key])
/** @param {any[]} values @param {number} index @param {any} value */
const defineDenseIndex = (values, index, value) => {
  objectDefineProperty(values, index, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
}
/** @param {any[]} values @param {any} value */
const appendDense = (values, value) => defineDenseIndex(values, values.length, value)
const privateDeltaPlans = new WeakSet()

/** @param {any} value */
const isRecord = value => {
  if (value === null || typeof value !== 'object') return false
  const prototype = objectGetPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** @param {any} value */
const isEmptyDimension = value => value == null || objectKeys(value).length === 0

/**
 * Equality for owned wire values used only by format/attribution inversion. Inputs are finite and
 * accessor-free by admission or renderer capture.
 *
 * @param {any} left
 * @param {any} right
 * @param {Map<object,Set<object>>} [seen]
 */
const equalOwnedValues = (left, right, seen = new Map()) => {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  const leftPrototype = objectGetPrototypeOf(left)
  if (leftPrototype !== objectGetPrototypeOf(right)) return false
  let rights = seen.get(left)
  if (rights?.has(right)) return true
  if (rights === undefined) {
    rights = new Set()
    seen.set(left, rights)
  }
  rights.add(right)
  if (leftPrototype === Uint8Array.prototype) {
    if (left.byteLength !== right.byteLength) return false
    for (let index = 0; index < left.byteLength; index++) {
      if (left[index] !== right[index]) return false
    }
    return true
  }
  if (leftPrototype === Date.prototype) {
    return reflectApply(Date.prototype.getTime, left, []) === reflectApply(Date.prototype.getTime, right, [])
  }
  if (leftPrototype !== Array.prototype && leftPrototype !== Object.prototype && leftPrototype !== null) return false
  const leftKeys = objectKeys(left)
  const rightKeys = objectKeys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (let index = 0; index < leftKeys.length; index++) {
    const key = leftKeys[index]
    if (!objectHasOwn(right, key) || !equalOwnedValues(left[key], right[key], seen)) return false
  }
  return true
}

/** @return {Object<string,any>} */
const createRecord = () => objectCreate(Object.prototype)

/** @param {Object<string,any>} target @param {string} key @param {any} value */
const defineRecordValue = (target, key, value) => {
  objectDefineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
}

/**
 * Resolve a tri-state format/attribution update against stored data. Attribution's `format` key is
 * the sole nested merge dimension, matching lib0 delta semantics without invoking its mutable API.
 *
 * @param {Object<string,any>|null|undefined} stored
 * @param {Object<string,any>} update
 * @param {boolean} deep
 */
const mergeResolvedDimension = (stored, update, deep) => {
  const result = createRecord()
  if (isRecord(stored)) {
    const storedRecord = /** @type {Object<string,any>} */ (stored)
    const keys = objectKeys(storedRecord)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      const value = storedRecord[key]
      if (value === null) continue
      if (deep && key === 'format' && isRecord(value)) {
        const format = mergeResolvedDimension(value, createRecord(), false)
        if (!isEmptyDimension(format)) defineRecordValue(result, key, format)
      } else {
        defineRecordValue(result, key, value)
      }
    }
  }
  const keys = objectKeys(update)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    const value = update[key]
    if (value === undefined) continue
    if (deep && key === 'format' && isRecord(value)) {
      const format = mergeResolvedDimension(result[key], value, false)
      if (isEmptyDimension(format)) Reflect.deleteProperty(result, key)
      else defineRecordValue(result, key, format)
    } else if (value === null) {
      Reflect.deleteProperty(result, key)
    } else {
      defineRecordValue(result, key, value)
    }
  }
  return result
}

/**
 * @param {Object<string,any>|null|undefined} stored
 * @param {Object<string,any>|null|undefined} update
 * @param {boolean} deep
 */
const combineDataDimension = (stored, update, deep) => {
  if (update === null) return null
  if (update === undefined || isEmptyDimension(update)) return isEmptyDimension(stored) ? null : stored
  const merged = mergeResolvedDimension(stored, update, deep)
  return isEmptyDimension(merged) ? null : merged
}

/**
 * @param {Object<string,any>|null|undefined} from
 * @param {Object<string,any>|null|undefined} to
 * @param {boolean} deep
 */
const diffDimension = (from, to, deep) => {
  if (equalOwnedValues(from, to)) return undefined
  if (isEmptyDimension(to) && (deep || from == null)) return null
  const update = createRecord()
  const fromRecord = isRecord(from) ? /** @type {Object<string,any>} */ (from) : null
  const toRecord = isRecord(to) ? /** @type {Object<string,any>} */ (to) : null
  if (toRecord !== null) {
    const keys = objectKeys(toRecord)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      const toValue = toRecord[key]
      const fromValue = fromRecord !== null && objectHasOwn(fromRecord, key) ? fromRecord[key] : null
      if (!equalOwnedValues(toValue, fromValue)) {
        defineRecordValue(
          update,
          key,
          deep && key === 'format' && isRecord(toValue) && isRecord(fromValue)
            ? diffDimension(fromValue, toValue, false)
            : toValue
        )
      }
    }
  }
  if (fromRecord !== null) {
    const keys = objectKeys(fromRecord)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (toRecord === null || !objectHasOwn(toRecord, key)) defineRecordValue(update, key, null)
    }
  }
  return update
}

/**
 * @param {Object<string,any>|null|undefined} stored
 * @param {Object<string,any>|null|undefined} update
 * @param {boolean} deep
 */
const inverseDimension = (stored, update, deep) => {
  if (update === undefined) return undefined
  const merged = update === null ? null : mergeResolvedDimension(stored, update, deep)
  return diffDimension(isEmptyDimension(merged) ? null : merged, stored ?? null, deep)
}

/** @param {null|string} name @param {any[]} children @param {any[]} attrs */
const sealDeltaPlan = (name, children, attrs) => {
  const plan = objectFreeze({
    name,
    children: objectFreeze(children),
    attrs: objectFreeze(attrs),
    preparedFix: null
  })
  privateDeltaPlans.add(plan)
  return /** @type {DeltaMutationPlan} */ (plan)
}

class DeltaMutationPlanBuilder {
  /** @param {null|string} name */
  constructor (name) {
    this.name = name
    /** @type {any[]} */
    this.children = []
    /** @type {any[]} */
    this.attrs = []
    /** @type {Object<string,any>|null} */
    this.usedFormats = null
    /** @type {Object<string,any>|null} */
    this.usedAttribution = null
  }

  /** @param {Object<string,any>|null} formats */
  useFormats (formats) {
    this.usedFormats = formats
    return this
  }

  /** @param {Object<string,any>|null} attribution */
  useAttribution (attribution) {
    this.usedAttribution = attribution
    return this
  }

  /** @param {any} value @param {any} [format] @param {any} [attribution] */
  insert (value, format, attribution) {
    const ownedFormat = combineDataDimension(this.usedFormats, format, false)
    const ownedAttribution = combineDataDimension(this.usedAttribution, attribution, true)
    if (typeof value === 'string') {
      appendDense(this.children, { kind: 'text', insert: value, length: value.length, format: ownedFormat, attribution: ownedAttribution })
    } else {
      /** @type {any[]} */
      const insert = []
      for (let index = 0; index < value.length; index++) {
        const entry = value[index]
        appendDense(insert, objectFreeze(privateDeltaPlans.has(entry) ? { kind: 'nested', value: entry } : { kind: 'value', value: entry }))
      }
      appendDense(this.children, { kind: 'insert', insert: objectFreeze(insert), length: insert.length, format: ownedFormat, attribution: ownedAttribution })
    }
    return this
  }

  /** @param {number} length */
  delete (length) {
    appendDense(this.children, { kind: 'delete', length })
    return this
  }

  /** @param {number} length @param {any} [format] @param {any} [attribution] */
  retain (length, format, attribution) {
    appendDense(this.children, { kind: 'retain', retain: length, length, format, attribution })
    return this
  }

  /** @param {DeltaMutationPlan} value @param {any} [format] @param {any} [attribution] */
  modify (value, format, attribution) {
    appendDense(this.children, { kind: 'modify', value, length: 1, format, attribution })
    return this
  }

  /** @param {string} key @param {any} value @param {any} [attribution] */
  setAttr (key, value, attribution) {
    appendDense(this.attrs, { kind: 'set', key, value, attribution: combineDataDimension(null, attribution, true) })
    return this
  }

  /** @param {string} key @param {any} [attribution] */
  deleteAttr (key, attribution) {
    appendDense(this.attrs, { kind: 'delete', key, attribution: combineDataDimension(null, attribution, true) })
    return this
  }

  /** @param {string} key @param {DeltaMutationPlan} value @param {any} [attribution] */
  modifyAttr (key, value, attribution) {
    appendDense(this.attrs, { kind: 'modify', key, value, attribution })
    return this
  }

  done () {
    for (let index = 0; index < this.children.length; index++) objectFreeze(this.children[index])
    for (let index = 0; index < this.attrs.length; index++) objectFreeze(this.attrs[index])
    return sealDeltaPlan(this.name, this.children, this.attrs)
  }
}

/** @param {null|string} name */
export const createDeltaMutationPlanBuilder = name => new DeltaMutationPlanBuilder(name)

/**
 * Compute a fix over immutable plans. This mirrors delta inversion only; mutation still runs solely
 * through applyDeltaCanonical.
 *
 * @param {DeltaMutationPlan} mutation
 * @param {DeltaMutationPlan} base
 */
const invertDeltaMutationPlan = (mutation, base) => {
  const inverse = new DeltaMutationPlanBuilder(mutation.name === base.name ? mutation.name : null)
  /** @type {Map<string,any>} */
  const baseAttrs = new Map()
  for (let index = 0; index < base.attrs.length; index++) {
    const op = base.attrs[index]
    baseAttrs.set(op.key, op)
  }
  for (let index = 0; index < mutation.attrs.length; index++) {
    const op = mutation.attrs[index]
    const baseOp = baseAttrs.get(op.key)
    if (op.kind === 'modify' && baseOp?.kind === 'set' && privateDeltaPlans.has(baseOp.value)) {
      inverse.modifyAttr(op.key, invertDeltaMutationPlan(op.value, baseOp.value), inverseDimension(baseOp.attribution, op.attribution, true))
    } else if (baseOp?.kind === 'set') {
      inverse.setAttr(op.key, baseOp.value, baseOp.attribution)
    } else if (op.kind !== 'delete') {
      inverse.deleteAttr(op.key)
    }
  }

  let baseIndex = 0
  let baseOffset = 0
  /**
   * @param {number} length
   * @param {(op:any,start:number,end:number) => void} consume
   */
  const consumeBase = (length, consume) => {
    while (length > 0 && baseIndex < base.children.length) {
      const op = base.children[baseIndex]
      if (op.kind !== 'text' && op.kind !== 'insert') {
        throw new DeltaMutationInvariantError('Rendered tombstone plan is not settled content')
      }
      const consumed = Math.min(length, op.length - baseOffset)
      consume(op, baseOffset, baseOffset + consumed)
      length -= consumed
      baseOffset += consumed
      if (baseOffset === op.length) {
        baseIndex++
        baseOffset = 0
      }
    }
    return length
  }

  for (let index = 0; index < mutation.children.length; index++) {
    const op = mutation.children[index]
    if (op.kind === 'text' || op.kind === 'insert') {
      inverse.delete(op.length)
    } else if (op.kind === 'retain') {
      const rest = consumeBase(op.retain, (baseOp, start, end) => {
        inverse.retain(
          end - start,
          inverseDimension(baseOp.format, op.format, false),
          inverseDimension(baseOp.attribution, op.attribution, true)
        )
      })
      if (rest > 0) inverse.retain(rest)
    } else if (op.kind === 'modify') {
      if (baseIndex >= base.children.length) {
        inverse.retain(1)
      } else {
        const baseOp = base.children[baseIndex]
        if (baseOp.kind !== 'insert') {
          throw new DeltaMutationInvariantError('Rendered tombstone modify target is not nested content')
        }
        const entry = baseOp.insert[baseOffset]
        if (entry?.kind !== 'nested') {
          throw new DeltaMutationInvariantError('Rendered tombstone modify target is not nested content')
        }
        inverse.modify(
          invertDeltaMutationPlan(op.value, entry.value),
          inverseDimension(baseOp.format, op.format, false),
          inverseDimension(baseOp.attribution, op.attribution, true)
        )
        consumeBase(1, () => {})
      }
    } else if (op.kind === 'delete') {
      consumeBase(op.length, (baseOp, start, end) => {
        if (baseOp.kind === 'text') {
          inverse.insert(baseOp.insert.slice(start, end), baseOp.format, baseOp.attribution)
        } else {
          /** @type {any[]} */
          const values = []
          for (let insertIndex = start; insertIndex < end; insertIndex++) {
            const entry = baseOp.insert[insertIndex]
            appendDense(values, entry.kind === 'nested' ? entry.value : entry.value)
          }
          inverse.insert(values, baseOp.format, baseOp.attribution)
        }
      })
    } else {
      throw new DeltaMutationInvariantError('Delta mutation plan contains an invalid child operation')
    }
  }
  return inverse.done()
}
const canonicalDeltaPrototypes = new Set([delta.Delta.prototype, delta.DeltaBuilder.prototype])
const canonicalListPrototype = objectGetPrototypeOf(delta.create().children)
/** @type {Map<object,string>} */
const canonicalOpPrototypes = new Map()
canonicalOpPrototypes.set(delta.TextOp.prototype, 'text')
canonicalOpPrototypes.set(delta.InsertOp.prototype, 'insert')
canonicalOpPrototypes.set(delta.RetainOp.prototype, 'retain')
canonicalOpPrototypes.set(delta.DeleteOp.prototype, 'delete')
canonicalOpPrototypes.set(delta.ModifyOp.prototype, 'modify')
canonicalOpPrototypes.set(delta.SetAttrOp.prototype, 'set')
canonicalOpPrototypes.set(delta.DeleteAttrOp.prototype, 'deleteAttr')
canonicalOpPrototypes.set(delta.ModifyAttrOp.prototype, 'modifyAttr')

/** @type {Array<[object,string[]]>} */
const guardedConstructorAssignments = [
  [delta.DeltaBuilder.prototype, ['name', '$schema', 'attrs', 'children', 'childCnt', 'origin', '_fingerprint', 'isDone', 'isFinal', 'marks', 'deleteMarks', 'maybeHasMarks', '_usedFormats', '_usedAttribution', '_usedFormatsData', '_usedAttributionData']],
  [delta.TextOp.prototype, ['next', 'prev', 'insert', 'format', 'attribution', '_fingerprint']],
  [delta.InsertOp.prototype, ['next', 'prev', 'insert', 'format', 'attribution', '_fingerprint']],
  [delta.RetainOp.prototype, ['next', 'prev', 'retain', 'format', 'attribution', '_fingerprint']],
  [delta.DeleteOp.prototype, ['next', 'prev', 'delete', '_fingerprint']],
  [delta.ModifyOp.prototype, ['next', 'prev', 'value', 'format', 'attribution', '_fingerprint']],
  [delta.SetAttrOp.prototype, ['key', 'value', 'attribution', '_fingerprint']],
  [delta.DeleteAttrOp.prototype, ['key', 'attribution', '_fingerprint']],
  [delta.ModifyAttrOp.prototype, ['key', 'value', 'attribution', '_fingerprint']]
]

const deltaConstructorsHaveSafeAssignments = () => {
  for (let guardIndex = 0; guardIndex < guardedConstructorAssignments.length; guardIndex++) {
    const [prototype, keys] = guardedConstructorAssignments[guardIndex]
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      let object = prototype
      while (object !== null) {
        const descriptor = objectGetOwnPropertyDescriptor(object, keys[keyIndex])
        if (descriptor !== undefined) {
          if (!objectHasOwn(descriptor, 'value') || descriptor.writable === false) return false
          break
        }
        object = objectGetPrototypeOf(object)
      }
    }
  }
  return true
}

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
    appendDense(result, objectFreeze({ client, clock: range.clock, length: range.len }))
  })
  for (let index = 1; index < result.length; index++) {
    const range = result[index]
    let insertion = index
    while (
      insertion > 0 &&
      (result[insertion - 1].client > range.client ||
        (result[insertion - 1].client === range.client && result[insertion - 1].clock > range.clock))
    ) {
      defineDenseIndex(result, insertion, result[insertion - 1])
      insertion--
    }
    defineDenseIndex(result, insertion, range)
  }
  return objectFreeze(result)
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
 * @param {delta.DeltaBuilder<any>} target
 * @param {any} node
 * @param {number} length
 */
const appendMaterializedChild = (target, node, length) => {
  const previous = target.children.end
  node.prev = previous
  if (previous === null) target.children.start = node
  else previous.next = node
  target.children.end = node
  target.children.len++
  target.childCnt += length
}

/**
 * Give every nested delta insertion its own canonical preliminary type and ContentType before the
 * capability can enter a transaction. Repeated delta syntax therefore creates repeated fresh types.
 *
 * @param {DeltaMutationPlan} mutation
 * @param {ReservationScan} scan
 */
const prepareInsertedTypes = (mutation, scan) => {
  const children = new Array(mutation.children.length)
  for (let index = 0; index < mutation.children.length; index++) {
    const op = mutation.children[index]
    if (op.kind !== 'insert') {
      defineDenseIndex(children, index, op)
      continue
    }
    const insert = new Array(op.insert.length)
    for (let insertIndex = 0; insertIndex < op.insert.length; insertIndex++) {
      const entry = op.insert[insertIndex]
      if (entry.kind === 'nested') {
        const value = prepareInsertedTypes(entry.value, scan)
        const type = scan.createNestedType(value.name)
        defineDenseIndex(insert, insertIndex, objectFreeze({ kind: entry.kind, value, type, content: createContentTypeCanonical(type) }))
      } else {
        defineDenseIndex(insert, insertIndex, entry)
      }
    }
    defineDenseIndex(children, index, objectFreeze({ ...op, insert: objectFreeze(insert) }))
  }
  return objectFreeze({
    name: mutation.name,
    children: objectFreeze(children),
    attrs: mutation.attrs,
    preparedFix: null
  })
}

/**
 * @param {YType<any>} type
 * @param {DeltaMutationPlan} mutation
 * @param {AbstractRenderer?} renderer
 * @param {ReservationScan} scan
 */
const scanDeltaMutation = (type, mutation, renderer, scan) => {
  if (type.doc !== scan.doc || !hasCanonicalApplyDelta(type, scan.canonicalApplyDelta)) {
    throw new DeltaMutationPreparationError('Reserved delta mutation requires canonical target types')
  }
  scan.guardedTypes.add(type)
  const typeItem = type._item
  if (typeItem !== null && typeItem.deleted) {
    let preparedFix = null
    if (rendererContentLength(renderer, typeItem) > 0) {
      const rendered = scan.renderDeltaPlan(type, renderer)
      const inverse = invertDeltaMutationPlan(mutation, rendered)
      if (inverse.children.length > 0 || inverse.attrs.length > 0) {
        preparedFix = materializeDeltaMutationPlan(inverse)
      }
    }
    return objectFreeze({
      name: mutation.name,
      children: mutation.children,
      attrs: mutation.attrs,
      preparedFix
    })
  }
  /** @type {delta.DeltaBuilder<any>?} */
  let preparedFix = null
  let fixLength = 0
  let expectedIndex = 0
  /** @param {delta.DeltaBuilder<any>?} childFix @param {Object<string,any>|undefined} inverseFormat */
  const appendModifyFix = (childFix, inverseFormat) => {
    const fix = preparedFix ?? (preparedFix = new delta.DeltaBuilder(null, null))
    if (expectedIndex > fixLength) {
      appendMaterializedChild(fix, new delta.RetainOp(expectedIndex - fixLength, undefined, undefined), expectedIndex - fixLength)
    }
    appendMaterializedChild(
      fix,
      new delta.ModifyOp(/** @type {any} */ (childFix ?? new delta.DeltaBuilder(null, null)), inverseFormat, undefined),
      1
    )
    fixLength = expectedIndex + 1
  }
  const children = new Array(mutation.children.length)
  /** @type {StructuralCursor} */
  const cursor = { item: type._start, offset: 0 }
  for (let index = 0; index < mutation.children.length; index++) {
    const op = mutation.children[index]
    if (op.kind === 'text' || op.kind === 'insert') {
      scan.allocates = true
      expectedIndex += op.length
      defineDenseIndex(children, index, op.kind === 'insert' ? prepareInsertedTypes(objectFreeze({ name: null, children: objectFreeze([op]), attrs: objectFreeze([]) }), scan).children[0] : op)
    } else if (op.kind === 'retain') {
      const formatting = op.format != null && objectKeys(op.format).length > 0
      if (formatting) scan.allocates = true
      advanceStructuralCursor(cursor, op.retain, renderer, scan, false, formatting)
      if (formatting) collectTrailingFormatHazards(cursor, renderer, scan)
      expectedIndex += op.length
      defineDenseIndex(children, index, op)
    } else if (op.kind === 'delete') {
      advanceStructuralCursor(cursor, op.length, renderer, scan, true, false)
      collectTrailingFormatHazards(cursor, renderer, scan)
      defineDenseIndex(children, index, op)
    } else if (op.kind === 'modify') {
      const item = findRenderedItem(cursor, renderer)
      if (item === null || item.content.constructor !== ContentType || cursor.offset !== 0) {
        throw new DeltaMutationPreparationError('Delta modify target is not a structural child type')
      }
      const value = scanDeltaMutation(/** @type {ContentType} */ (item.content).type, op.value, renderer, scan)
      const formatting = op.format != null && objectKeys(op.format).length > 0
      if (formatting) scan.allocates = true
      let inverseFormat
      if (item.deleted && formatting) {
        inverseFormat = {}
        const keys = objectKeys(op.format)
        for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
          objectDefineProperty(inverseFormat, keys[keyIndex], {
            configurable: true,
            enumerable: true,
            value: null,
            writable: true
          })
        }
      }
      if (value.preparedFix !== null || inverseFormat !== undefined) appendModifyFix(value.preparedFix, inverseFormat)
      defineDenseIndex(children, index, objectFreeze({ ...op, value, inverseFormat }))
      advanceStructuralCursor(cursor, 1, renderer, scan, false, formatting)
      if (formatting) collectTrailingFormatHazards(cursor, renderer, scan)
      expectedIndex++
    } else {
      throw new DeltaMutationPreparationError('Delta contains an unsupported child operation')
    }
  }
  const attrs = new Array(mutation.attrs.length)
  for (let index = 0; index < mutation.attrs.length; index++) {
    const op = mutation.attrs[index]
    const item = type._map.get(op.key)
    if (op.kind === 'set') {
      scan.allocates = true
      if (item !== undefined && !item.deleted) {
        scan.deletes.add(item.id.client, item.id.clock, item.length)
        addDeletedTypeContents(item, scan)
      }
      defineDenseIndex(attrs, index, op)
    } else if (op.kind === 'delete') {
      if (item !== undefined && !item.deleted) {
        scan.deletes.add(item.id.client, item.id.clock, item.length)
        addDeletedTypeContents(item, scan)
      }
      defineDenseIndex(attrs, index, op)
    } else if (op.kind === 'modify') {
      if (
        item === undefined ||
        item.content.constructor !== ContentType ||
        (item.deleted && rendererContentLength(renderer, item) === 0)
      ) {
        throw new DeltaMutationPreparationError('Delta modifyAttr target is not a structural child type')
      }
      const value = scanDeltaMutation(/** @type {ContentType} */ (item.content).type, op.value, renderer, scan)
      if (value.preparedFix !== null) {
        const fix = preparedFix ?? (preparedFix = new delta.DeltaBuilder(null, null))
        objectDefineProperty(fix.attrs, op.key, {
          configurable: true,
          enumerable: true,
          value: new delta.ModifyAttrOp(op.key, value.preparedFix, undefined),
          writable: true
        })
      }
      defineDenseIndex(attrs, index, objectFreeze({ ...op, value }))
    } else {
      throw new DeltaMutationPreparationError('Delta contains an unsupported attribute operation')
    }
  }
  return objectFreeze({
    name: mutation.name,
    children: objectFreeze(children),
    attrs: objectFreeze(attrs),
    preparedFix
  })
}

/**
 * @param {YType<any>} type
 * @param {DeltaMutationPlan} mutation
 * @param {AbstractRenderer?} renderer
 * @param {Doc} doc
 * @param {CanonicalDeltaApply} canonicalApplyDelta
 * @param {(name:null|string) => YType<any>} createNestedType
 * @param {DeltaMutationPlanRenderer} renderDeltaPlan
 */
const reserveRangeCount = (type, mutation, renderer, doc, canonicalApplyDelta, createNestedType, renderDeltaPlan) => {
  /** @type {ReservationScan} */
  const scan = {
    deletes: createIdSet(),
    formatHazards: new Set(),
    allocates: false,
    doc,
    canonicalApplyDelta,
    guardedTypes: new Set(),
    createNestedType,
    renderDeltaPlan
  }
  const plan = scanDeltaMutation(type, mutation, renderer, scan)
  let rangeCount = countRanges(scan.deletes)
  scan.formatHazards.forEach(item => {
    if (!scan.deletes.hasId(item.id)) rangeCount++
  })
  return {
    rangeCountUpperBound: rangeCount + (scan.allocates ? 1 : 0),
    guardedTypes: scan.guardedTypes,
    plan
  }
}

/**
 * Inspect the descriptor chain without invoking caller-controlled accessors.
 *
 * @param {YType<any>} type
 * @param {CanonicalDeltaApply} canonicalApplyDelta
 */
const hasCanonicalApplyDelta = (type, canonicalApplyDelta) => {
  let object = type
  while (object !== null) {
    const descriptor = objectGetOwnPropertyDescriptor(object, 'applyDelta')
    if (descriptor !== undefined) {
      return objectHasOwn(descriptor, 'value') && descriptor.value === canonicalApplyDelta
    }
    object = objectGetPrototypeOf(object)
  }
  return false
}

/** @param {PreparedDeltaMutationState} state */
const assertGuardedTypesFresh = state => {
  for (const type of state.guardedTypes) {
    if (type.doc !== state.doc || !hasCanonicalApplyDelta(type, state.canonicalApplyDelta)) {
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
  assertGuardedTypesFresh(state)
  if (!deltaConstructorsHaveSafeAssignments()) {
    throw new DeltaMutationStaleError('Prepared delta mutation constructor dispatch changed')
  }
  if (state.renderer !== null) {
    const lifecycle = readRendererLifecycle(state.renderer)
    if (lifecycle === null || lifecycle !== state.rendererLifecycle || !lifecycle.active) {
      throw new DeltaMutationStaleError('Prepared delta mutation renderer revision changed')
    }
  }
  if (
    state.doc.isDestroyed ||
    state.doc._transaction !== null ||
    state.doc._transactionCleanups.length !== 0 ||
    readDocumentStructuralRevision(state.doc) !== state.documentRevision
  ) {
    throw new DeltaMutationStaleError('Prepared delta mutation document revision changed')
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
  if (!deltaConstructorsHaveSafeAssignments()) {
    throw new DeltaMutationStaleError('Prepared delta mutation constructor dispatch changed before execution')
  }
  if (state.renderer !== null) {
    const lifecycle = readRendererLifecycle(state.renderer)
    if (lifecycle === null || lifecycle !== state.rendererLifecycle || !lifecycle.active) {
      throw new DeltaMutationStaleError('Prepared delta mutation renderer revision changed before execution')
    }
  }
  if (readDocumentStructuralRevision(state.doc) !== state.documentRevision) {
    throw new DeltaMutationStaleError('Prepared delta mutation document revision changed before execution')
  }
}

/**
 * @param {Transaction} transaction
 * @param {PreparedDeltaMutationState} state
 * @param {((content: DeltaMutationContent) => void)|undefined} afterMutation
 */
const applyInTransaction = (transaction, state, afterMutation) => {
  assertFreshInsideTransaction(transaction, state)
  if (transaction.insertSet.clients.size !== 0 || transaction.deleteSet.clients.size !== 0) {
    throw new DeltaMutationInvariantError('beforeTransaction mutated the reserved document before delta execution')
  }
  const beforeInserts = cloneIdSet(transaction.insertSet)
  const beforeDeletes = cloneIdSet(transaction.deleteSet)
  const fix = state.executor(transaction, state.mutation, state.executionRenderer)
  const inserts = diffIdSet(transaction.insertSet, beforeInserts)
  const deletes = diffIdSet(transaction.deleteSet, beforeDeletes)
  if (intersectSets(inserts, deletes).clients.size !== 0) {
    throw new DeltaMutationInvariantError('Reserved delta inserted and deleted the same structural IDs')
  }
  const frozenInserts = freezeRanges(inserts)
  const frozenDeletes = freezeRanges(deletes)
  const rangeCount = frozenInserts.length + frozenDeletes.length
  if (rangeCount > state.rangeCountUpperBound) {
    throw new DeltaMutationInvariantError(`Reserved delta range underbound: ${rangeCount} > ${state.rangeCountUpperBound}`)
  }
  const content = objectFreeze({ inserts: frozenInserts, deletes: frozenDeletes, rangeCount })
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
    objectFreeze(this)
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
      preparedMutations.delete(this)
    }
  }

  discard () {
    const state = preparedMutations.get(this)
    if (state === undefined || state.status !== 'prepared') {
      throw new DeltaMutationCapabilityError('Prepared delta mutation is invalid or already used')
    }
    state.status = 'discarded'
    preparedMutations.delete(this)
  }
}

/** @param {any} value */
const assertPositiveLength = value => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DeltaMutationPreparationError('Delta contains an invalid operation length')
  }
}

/**
 * @param {object} value
 * @param {PropertyKey} key
 */
const readOwnData = (value, key) => {
  const descriptor = objectGetOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !objectHasOwn(descriptor, 'value')) {
    throw new DeltaMutationPreparationError('Delta contains an accessor or missing structural field')
  }
  return descriptor.value
}

/** @param {any} value */
const isCanonicalDelta = value => value !== null && typeof value === 'object' && canonicalDeltaPrototypes.has(objectGetPrototypeOf(value))

/**
 * Detach the complete mutation into a finite, immutable operation plan. Source lists and operations
 * are read through own data descriptors and exact canonical prototypes, never through their mutable
 * public iterators, schemas, getters, clone methods, or builder methods.
 *
 * @param {delta.DeltaAny} mutation
 */
const ownDeltaMutation = mutation => {
  /** @type {Map<object, any>} */
  const valueCopies = new Map()
  /** @type {Map<object, 1|2>} */
  const valueStates = new Map()
  let payloadNodeCount = 0

  /** @param {object} target @param {PropertyKey} key @param {any} value */
  const assignValue = (target, key, value) => {
    objectDefineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    })
  }

  /**
   * Iterative ownership avoids recursive-stack RangeErrors. Accessors, cycles, foreign mutable
   * prototypes, and payloads beyond the documented depth/node budget fail before any document write.
   *
   * @param {any} root
   */
  const cloneValue = root => {
    const holder = objectCreate(null)
    /** @type {any[]} */
    const stack = [{ source: root, target: holder, key: 'value', depth: 0, exit: false }]
    while (stack.length > 0) {
      const frame = reflectApply(arrayPop, stack, [])
      const source = frame.source
      if (frame.exit) {
        valueStates.set(source, 2)
        continue
      }
      if (source === null || (typeof source !== 'object' && typeof source !== 'function')) {
        if (typeof source === 'symbol') throw new DeltaMutationPreparationError('Delta contains an unsupported symbol value')
        assignValue(frame.target, frame.key, source)
        continue
      }
      if (typeof source === 'function') throw new DeltaMutationPreparationError('Delta contains an unsupported function value')
      if (frame.depth > maxDeltaMutationPayloadDepth) {
        throw new DeltaMutationPreparationError(`Delta payload exceeds depth limit ${maxDeltaMutationPayloadDepth}`)
      }
      if (isCanonicalDelta(source)) {
        throw new DeltaMutationPreparationError('Nested deltas are only valid as direct child content')
      }
      const state = valueStates.get(source)
      if (state === 1) throw new DeltaMutationPreparationError('Delta contains a cyclic value')
      if (state === 2) {
        assignValue(frame.target, frame.key, valueCopies.get(source))
        continue
      }
      payloadNodeCount++
      if (payloadNodeCount > maxDeltaMutationPayloadNodes) {
        throw new DeltaMutationPreparationError(`Delta payload exceeds node limit ${maxDeltaMutationPayloadNodes}`)
      }
      const prototype = objectGetPrototypeOf(source)
      if (prototype === Uint8Array.prototype) {
        const owned = new Uint8Array(source)
        valueCopies.set(source, owned)
        valueStates.set(source, 2)
        assignValue(frame.target, frame.key, owned)
        continue
      }
      if (prototype === Date.prototype) {
        const owned = new Date(reflectApply(Date.prototype.getTime, source, []))
        valueCopies.set(source, owned)
        valueStates.set(source, 2)
        assignValue(frame.target, frame.key, owned)
        continue
      }
      const isArray = prototype === Array.prototype
      if (!isArray && prototype !== Object.prototype && prototype !== null) {
        throw new DeltaMutationPreparationError('Delta contains an unsupported mutable value')
      }
      let owned
      /** @type {string[]} */
      let keys
      if (isArray) {
        const length = readOwnData(source, 'length')
        if (!Number.isSafeInteger(length) || length < 0) throw new DeltaMutationPreparationError('Delta contains an invalid array value')
        owned = new Array(length)
        keys = objectKeys(source)
        for (let index = 0; index < keys.length; index++) {
          const key = keys[index]
          const numeric = Number(key)
          if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric >= length || String(numeric) !== key) {
            throw new DeltaMutationPreparationError('Delta arrays cannot contain custom enumerable properties')
          }
        }
      } else {
        owned = objectCreate(prototype)
        keys = objectKeys(source)
      }
      valueCopies.set(source, owned)
      valueStates.set(source, 1)
      assignValue(frame.target, frame.key, owned)
      appendDense(stack, { source, exit: true })
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index]
        appendDense(stack, { source: readOwnData(source, key), target: owned, key, depth: frame.depth + 1, exit: false })
      }
    }
    return holder.value
  }

  /** @param {any} value @param {string} field */
  const cloneDimension = (value, field) => {
    if (value == null) return value
    if (typeof value !== 'object') throw new DeltaMutationPreparationError(`Delta contains an invalid ${field}`)
    const prototype = objectGetPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DeltaMutationPreparationError(`Delta contains an invalid ${field}`)
    }
    const cloned = cloneValue(value)
    if (prototype === null) return cloned
    const owned = objectCreate(null)
    const keys = objectKeys(cloned)
    for (let index = 0; index < keys.length; index++) {
      objectDefineProperty(owned, keys[index], /** @type {PropertyDescriptor} */ (objectGetOwnPropertyDescriptor(cloned, keys[index])))
    }
    return owned
  }

  /** @type {Map<delta.DeltaAny, 1|2>} */
  const deltaStates = new Map()
  /** @type {Map<delta.DeltaAny, any>} */
  const records = new Map()
  /** @type {Map<delta.DeltaAny, DeltaMutationPlan>} */
  const plans = new Map()
  /** @type {Map<delta.DeltaAny, number>} */
  const expandedCosts = new Map()
  /** @type {Map<delta.DeltaAny, number>} */
  const freshTypeCosts = new Map()
  /** @type {delta.DeltaAny[]} */
  const completed = []
  let planNodeCount = 0

  const addPlanNode = () => {
    planNodeCount++
    if (planNodeCount > maxDeltaMutationNodes) {
      throw new DeltaMutationPreparationError(`Delta mutation exceeds node limit ${maxDeltaMutationNodes}`)
    }
  }

  /** @param {number} left @param {number} right */
  const saturatingAdd = (left, right) => Math.min(maxDeltaMutationNodes + 1, left + right)
  /** @param {Map<delta.DeltaAny,number>} costs @param {delta.DeltaAny} source */
  const readCost = (costs, source) => {
    const cost = costs.get(source)
    if (cost === undefined) throw new DeltaMutationPreparationError('Delta contains an inconsistent nested graph')
    return cost
  }

  /** @param {any} value */
  const readInsertedArray = value => {
    if (value === null || typeof value !== 'object' || objectGetPrototypeOf(value) !== Array.prototype) {
      throw new DeltaMutationPreparationError('Delta contains invalid inserted content')
    }
    const length = readOwnData(value, 'length')
    assertPositiveLength(length)
    /** @type {any[]} */
    const result = new Array(length)
    for (let index = 0; index < length; index++) {
      if (!objectHasOwn(value, index)) throw new DeltaMutationPreparationError('Delta contains sparse inserted content')
      defineDenseIndex(result, index, readOwnData(value, String(index)))
    }
    return result
  }

  /** @param {delta.DeltaAny} source */
  const inspectDelta = source => {
    if (!isCanonicalDelta(source)) throw new DeltaMutationPreparationError('Delta contains an invalid nested delta')
    addPlanNode()
    const name = readOwnData(source, 'name')
    if (name !== null && typeof name !== 'string') {
      throw new DeltaMutationPreparationError('Delta names must be null or strings')
    }
    if (readOwnData(source, 'marks') !== null || readOwnData(source, 'deleteMarks') !== null) {
      throw new DeltaMutationPreparationError('Reserved delta mutation does not support marks')
    }
    const childrenList = readOwnData(source, 'children')
    if (childrenList === null || typeof childrenList !== 'object' || objectGetPrototypeOf(childrenList) !== canonicalListPrototype) {
      throw new DeltaMutationPreparationError('Delta contains an invalid child list')
    }
    const listLength = readOwnData(childrenList, 'len')
    if (!Number.isSafeInteger(listLength) || listLength < 0) throw new DeltaMutationPreparationError('Delta contains an invalid child list')
    /** @type {any[]} */
    const children = []
    /** @type {delta.DeltaAny[]} */
    const nested = []
    let node = readOwnData(childrenList, 'start')
    const end = readOwnData(childrenList, 'end')
    let previous = null
    let childLength = 0
    while (node !== null) {
      if (children.length >= listLength || node === null || typeof node !== 'object') {
        throw new DeltaMutationPreparationError('Delta contains a cyclic or inconsistent child list')
      }
      if (readOwnData(node, 'prev') !== previous) throw new DeltaMutationPreparationError('Delta contains an inconsistent child list')
      const kind = canonicalOpPrototypes.get(objectGetPrototypeOf(node))
      addPlanNode()
      if (kind === 'text') {
        const insert = readOwnData(node, 'insert')
        if (typeof insert !== 'string') throw new DeltaMutationPreparationError('Delta contains invalid text content')
        assertPositiveLength(insert.length)
        childLength += insert.length
        appendDense(children, {
          kind,
          insert,
          length: insert.length,
          format: cloneDimension(readOwnData(node, 'format'), 'format'),
          attribution: cloneDimension(readOwnData(node, 'attribution'), 'attribution')
        })
      } else if (kind === 'insert') {
        const insert = readInsertedArray(readOwnData(node, 'insert'))
        childLength += insert.length
        /** @type {any[]} */
        const content = new Array(insert.length)
        for (let index = 0; index < insert.length; index++) {
          const value = insert[index]
          if (isCanonicalDelta(value)) {
            appendDense(nested, value)
            defineDenseIndex(content, index, { kind: 'nested', value })
          } else {
            defineDenseIndex(content, index, { kind: 'value', value: cloneValue(value) })
          }
        }
        appendDense(children, {
          kind,
          insert: content,
          length: insert.length,
          format: cloneDimension(readOwnData(node, 'format'), 'format'),
          attribution: cloneDimension(readOwnData(node, 'attribution'), 'attribution')
        })
      } else if (kind === 'retain') {
        const retain = readOwnData(node, 'retain')
        assertPositiveLength(retain)
        childLength += retain
        appendDense(children, {
          kind,
          retain,
          length: retain,
          format: cloneDimension(readOwnData(node, 'format'), 'format'),
          attribution: cloneDimension(readOwnData(node, 'attribution'), 'attribution')
        })
      } else if (kind === 'delete') {
        const length = readOwnData(node, 'delete')
        assertPositiveLength(length)
        childLength += length
        appendDense(children, { kind, length })
      } else if (kind === 'modify') {
        const value = readOwnData(node, 'value')
        if (!isCanonicalDelta(value)) throw new DeltaMutationPreparationError('Delta contains an invalid nested delta')
        appendDense(nested, value)
        childLength++
        appendDense(children, {
          kind,
          value,
          length: 1,
          format: cloneDimension(readOwnData(node, 'format'), 'format'),
          attribution: cloneDimension(readOwnData(node, 'attribution'), 'attribution')
        })
      } else {
        throw new DeltaMutationPreparationError('Delta contains an unsupported child operation')
      }
      previous = node
      node = readOwnData(node, 'next')
    }
    if (children.length !== listLength || previous !== end || childLength !== readOwnData(source, 'childCnt')) {
      throw new DeltaMutationPreparationError('Delta contains an inconsistent child list')
    }

    const sourceAttrs = readOwnData(source, 'attrs')
    if (sourceAttrs === null || typeof sourceAttrs !== 'object' || objectGetPrototypeOf(sourceAttrs) !== Object.prototype) {
      throw new DeltaMutationPreparationError('Delta contains an invalid attribute collection')
    }
    /** @type {any[]} */
    const attrs = []
    const attrNames = objectKeys(sourceAttrs)
    for (let index = 0; index < attrNames.length; index++) {
      const attrName = attrNames[index]
      const op = readOwnData(sourceAttrs, attrName)
      if (op === null || typeof op !== 'object') throw new DeltaMutationPreparationError('Delta contains an unsupported attribute operation')
      const kind = canonicalOpPrototypes.get(objectGetPrototypeOf(op))
      const key = readOwnData(op, 'key')
      if (typeof key !== 'string' || key !== attrName) {
        throw new DeltaMutationPreparationError('Reserved delta attribute keys must be strings')
      }
      addPlanNode()
      if (kind === 'set') {
        const value = readOwnData(op, 'value')
        if (isCanonicalDelta(value)) throw new DeltaMutationPreparationError('Delta attributes cannot be set to a nested delta')
        appendDense(attrs, {
          kind,
          key,
          value: cloneValue(value),
          attribution: cloneDimension(readOwnData(op, 'attribution'), 'attribution')
        })
      } else if (kind === 'deleteAttr') {
        appendDense(attrs, {
          kind: 'delete',
          key,
          attribution: cloneDimension(readOwnData(op, 'attribution'), 'attribution')
        })
      } else if (kind === 'modifyAttr') {
        const value = readOwnData(op, 'value')
        if (!isCanonicalDelta(value)) throw new DeltaMutationPreparationError('Delta contains an invalid nested delta')
        appendDense(nested, value)
        appendDense(attrs, {
          kind: 'modify',
          key,
          value,
          attribution: cloneDimension(readOwnData(op, 'attribution'), 'attribution')
        })
      } else {
        throw new DeltaMutationPreparationError('Delta contains an unsupported attribute operation')
      }
    }
    records.set(source, { name, children, attrs, nested })
    return nested
  }

  /** @type {Array<{source:delta.DeltaAny,depth:number,exit:boolean}>} */
  const stack = [{ source: mutation, depth: 0, exit: false }]
  while (stack.length > 0) {
    const frame = /** @type {{source:delta.DeltaAny,depth:number,exit:boolean}} */ (reflectApply(arrayPop, stack, []))
    if (frame.depth > maxDeltaMutationDepth) {
      throw new DeltaMutationPreparationError(`Delta mutation exceeds nested depth limit ${maxDeltaMutationDepth}`)
    }
    const state = deltaStates.get(frame.source)
    if (frame.exit) {
      deltaStates.set(frame.source, 2)
      appendDense(completed, frame.source)
    } else if (state === 1) {
      throw new DeltaMutationPreparationError('Delta contains a cyclic nested delta')
    } else if (state !== 2) {
      deltaStates.set(frame.source, 1)
      const nested = inspectDelta(frame.source)
      appendDense(stack, { source: frame.source, depth: frame.depth, exit: true })
      for (let index = nested.length - 1; index >= 0; index--) {
        appendDense(stack, { source: nested[index], depth: frame.depth + 1, exit: false })
      }
    }
  }

  for (let sourceIndex = 0; sourceIndex < completed.length; sourceIndex++) {
    const source = completed[sourceIndex]
    const record = records.get(source)
    let expandedCost = saturatingAdd(1, record.children.length + record.attrs.length)
    let freshTypeCost = 0
    for (let childIndex = 0; childIndex < record.children.length; childIndex++) {
      const op = record.children[childIndex]
      if (op.kind === 'insert') {
        for (let insertIndex = 0; insertIndex < op.insert.length; insertIndex++) {
          const entry = op.insert[insertIndex]
          if (entry.kind === 'nested') {
            expandedCost = saturatingAdd(expandedCost, readCost(expandedCosts, entry.value))
            freshTypeCost = saturatingAdd(freshTypeCost, saturatingAdd(1, readCost(freshTypeCosts, entry.value)))
          }
        }
      } else if (op.kind === 'modify') {
        expandedCost = saturatingAdd(expandedCost, readCost(expandedCosts, op.value))
        freshTypeCost = saturatingAdd(freshTypeCost, readCost(freshTypeCosts, op.value))
      }
    }
    for (let attrIndex = 0; attrIndex < record.attrs.length; attrIndex++) {
      const op = record.attrs[attrIndex]
      if (op.kind === 'modify') {
        expandedCost = saturatingAdd(expandedCost, readCost(expandedCosts, op.value))
        freshTypeCost = saturatingAdd(freshTypeCost, readCost(freshTypeCosts, op.value))
      }
    }
    if (expandedCost > maxDeltaMutationNodes || freshTypeCost > maxDeltaMutationNodes) {
      throw new DeltaMutationPreparationError(`Delta mutation expanded occurrences exceed limit ${maxDeltaMutationNodes}`)
    }
    expandedCosts.set(source, expandedCost)
    freshTypeCosts.set(source, freshTypeCost)
    /** @type {any[]} */
    const children = new Array(record.children.length)
    for (let childIndex = 0; childIndex < record.children.length; childIndex++) {
      const op = record.children[childIndex]
      if (op.kind === 'insert') {
        const insert = new Array(op.insert.length)
        for (let insertIndex = 0; insertIndex < op.insert.length; insertIndex++) {
          const entry = op.insert[insertIndex]
          defineDenseIndex(insert, insertIndex, objectFreeze(entry.kind === 'nested'
            ? { kind: entry.kind, value: plans.get(entry.value) }
            : entry))
        }
        defineDenseIndex(children, childIndex, objectFreeze({ ...op, insert: objectFreeze(insert) }))
      } else if (op.kind === 'modify') {
        defineDenseIndex(children, childIndex, objectFreeze({ ...op, value: plans.get(op.value) }))
      } else {
        defineDenseIndex(children, childIndex, objectFreeze(op))
      }
    }
    const attrs = new Array(record.attrs.length)
    for (let attrIndex = 0; attrIndex < record.attrs.length; attrIndex++) {
      const op = record.attrs[attrIndex]
      defineDenseIndex(attrs, attrIndex, op.kind === 'modify'
        ? objectFreeze({ ...op, value: plans.get(op.value) })
        : objectFreeze(op))
    }
    plans.set(source, objectFreeze({
      name: record.name,
      children: objectFreeze(children),
      attrs: objectFreeze(attrs),
      preparedFix: null
    }))
  }
  return /** @type {DeltaMutationPlan} */ (plans.get(mutation))
}

/**
 * Build a conventional delta result without invoking any mutable builder, operation, or list method.
 * Used only for renderer fix computation and for returning an already-computed fix to the caller.
 *
 * @param {DeltaMutationPlan} plan
 */
export const materializeDeltaMutationPlan = plan => {
  const result = /** @type {delta.DeltaBuilder<any>} */ (new delta.DeltaBuilder(plan.name, null))
  for (let index = 0; index < plan.children.length; index++) {
    const op = plan.children[index]
    let node
    if (op.kind === 'text') {
      node = new delta.TextOp(op.insert, op.format, op.attribution)
    } else if (op.kind === 'insert') {
      const insert = new Array(op.insert.length)
      for (let insertIndex = 0; insertIndex < op.insert.length; insertIndex++) {
        const entry = op.insert[insertIndex]
        defineDenseIndex(insert, insertIndex, entry.kind === 'nested' ? materializeDeltaMutationPlan(entry.value) : entry.value)
      }
      node = new delta.InsertOp(insert, op.format, op.attribution)
    } else if (op.kind === 'retain') {
      node = new delta.RetainOp(op.retain, op.format, op.attribution)
    } else if (op.kind === 'delete') {
      node = new delta.DeleteOp(op.length)
    } else if (op.kind === 'modify') {
      node = new delta.ModifyOp(/** @type {any} */ (materializeDeltaMutationPlan(op.value)), op.format, op.attribution)
    } else {
      throw new DeltaMutationInvariantError('Reserved delta mutation plan contains an invalid child operation')
    }
    const previous = result.children.end
    node.prev = previous
    if (previous === null) result.children.start = node
    else previous.next = node
    result.children.end = node
    result.children.len++
    result.childCnt += op.length
  }
  for (let index = 0; index < plan.attrs.length; index++) {
    const op = plan.attrs[index]
    let node
    if (op.kind === 'set') {
      node = new delta.SetAttrOp(op.key, op.value, op.attribution)
    } else if (op.kind === 'delete') {
      node = new delta.DeleteAttrOp(op.key, op.attribution)
    } else if (op.kind === 'modify') {
      node = new delta.ModifyAttrOp(op.key, materializeDeltaMutationPlan(op.value), op.attribution)
    } else {
      throw new DeltaMutationInvariantError('Reserved delta mutation plan contains an invalid attribute operation')
    }
    objectDefineProperty(result.attrs, op.key, {
      configurable: true,
      enumerable: true,
      value: node,
      writable: true
    })
  }
  return result
}

/** @type {WeakMap<object, DeltaMutationPlan>} */
const deltaMutationPlans = new WeakMap()

/** @param {object} token */
export const readDeltaMutationPlan = token => {
  const plan = deltaMutationPlans.get(token)
  if (plan === undefined) throw new DeltaMutationInvariantError('Reserved delta mutation plan is unavailable')
  return plan
}

/**
 * @param {YType<any>} type
 * @param {delta.DeltaAny} mutation
 * @param {any} origin
 * @param {AbstractRenderer?} renderer
 * @param {DeltaMutationExecutor} executor
 * @param {CanonicalDeltaApply} canonicalApplyDelta
 * @param {(name:null|string) => YType<any>} createNestedType
 * @param {DeltaMutationPlanRenderer} renderDeltaPlan
 * @return {PreparedDeltaMutation}
 */
export const createPreparedDeltaMutation = (type, mutation, origin, renderer, executor, canonicalApplyDelta, createNestedType, renderDeltaPlan) => {
  const doc = type.doc
  if (doc === null || doc.isDestroyed) {
    throw new DeltaMutationPreparationError('Delta mutation target must be integrated in a live document')
  }
  if (doc._transaction !== null || doc._transactionCleanups.length !== 0) {
    throw new DeltaMutationPreparationError('Delta mutation preparation requires a quiescent document')
  }
  if (!deltaConstructorsHaveSafeAssignments()) {
    throw new DeltaMutationPreparationError('Reserved delta mutation requires canonical constructor dispatch')
  }
  const documentRevision = readDocumentStructuralRevision(doc)
  let rendererLifecycle = null
  let executionRenderer = null
  if (renderer !== null) {
    rendererLifecycle = readRendererLifecycle(renderer)
    executionRenderer = readRendererExecutionAdapter(renderer)
    if (rendererLifecycle === null || !rendererLifecycle.active || executionRenderer === null) {
      throw new DeltaMutationPreparationError('Delta mutation renderer must be a live tracked DiffRenderer')
    }
  }
  const assertPreparationFresh = () => {
    if (
      doc.isDestroyed ||
      doc._transaction !== null ||
      doc._transactionCleanups.length !== 0 ||
      (renderer !== null && readRendererLifecycle(renderer) !== rendererLifecycle) ||
      readDocumentStructuralRevision(doc) !== documentRevision
    ) {
      throw new DeltaMutationStaleError('Delta mutation state changed during preparation')
    }
  }
  let ownedPlan
  let executionPlan
  let rangeCountUpperBound
  let guardedTypes
  try {
    ownedPlan = ownDeltaMutation(mutation)
    if (ownedPlan.children.length === 0 && ownedPlan.attrs.length === 0) {
      throw new DeltaMutationPreparationError('Cannot reserve an empty delta mutation')
    }
    const reservation = reserveRangeCount(type, ownedPlan, executionRenderer, doc, canonicalApplyDelta, createNestedType, renderDeltaPlan)
    rangeCountUpperBound = reservation.rangeCountUpperBound
    guardedTypes = reservation.guardedTypes
    executionPlan = reservation.plan
  } catch (cause) {
    assertPreparationFresh()
    if (cause instanceof RangeError) {
      throw new DeltaMutationPreparationError('Delta mutation exceeds a preparation resource limit')
    }
    throw cause
  }
  assertPreparationFresh()
  const token = objectFreeze({})
  deltaMutationPlans.set(token, executionPlan)
  const reservation = objectFreeze({ rangeCountUpperBound })
  const capability = new PreparedDeltaMutationCapability(reservation)
  preparedMutations.set(capability, {
    status: 'prepared',
    type,
    doc,
    renderer,
    executionRenderer,
    rendererLifecycle,
    documentRevision,
    mutation: token,
    origin,
    rangeCountUpperBound,
    executor,
    canonicalApplyDelta,
    guardedTypes
  })
  return capability
}
