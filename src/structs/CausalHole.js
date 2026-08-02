import * as binary from 'lib0/binary'
import * as encoding from 'lib0/encoding'

import { ID, compareIDs, createID, findRootTypeKey } from '../utils/ID.js'

export const structCausalHoleRefNumber = 11

const transactionCausalHoles = Symbol('causal-hole-transport')

/**
 * @param {ID|null} id
 */
const copyID = id => id === null ? null : createID(id.client, id.clock)

/** @param {ID|null} id */
const validID = id => id === null || (Number.isSafeInteger(id.client) && id.client >= 0 && Number.isSafeInteger(id.clock) && id.clock >= 0)

/**
 * @param {YType|ID|string} parent
 * @return {ID|string}
 */
export const normalizeCausalHoleParent = parent => {
  if (typeof parent === 'string') return parent
  if (parent.constructor === ID) return createID(/** @type {ID} */ (parent).client, /** @type {ID} */ (parent).clock)
  const item = /** @type {YType} */ (parent)._item
  return item === null ? findRootTypeKey(/** @type {YType} */ (parent)) : createID(item.id.client, item.id.clock)
}

/**
 * Sparse structural coverage carrying only the canonical metadata required to integrate dependent
 * items. It is never linked into a YType and never enters transaction insert/delete sets.
 */
export class CausalHole {
  /**
   * @param {ID} id
   * @param {number} length
   * @param {ID|null} origin
   * @param {ID|null} rightOrigin
   * @param {ID|string} parent
   * @param {string|null} parentSub
   */
  constructor (id, length, origin, rightOrigin, parent, parentSub) {
    if (
      !validID(id) || !validID(origin) || !validID(rightOrigin) ||
      !Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(id.clock + length) ||
      (typeof parent !== 'string' && (parent.constructor !== ID || !validID(parent))) ||
      (parentSub !== null && typeof parentSub !== 'string')
    ) {
      throw new Error('Invalid causal hole')
    }
    this.id = id
    this.length = length
    this.origin = copyID(origin)
    this.rightOrigin = copyID(rightOrigin)
    this.parent = normalizeCausalHoleParent(parent)
    this.parentSub = parentSub
  }

  get deleted () { return false }

  delete () {}

  /**
   * @param {number} clock
   * @param {number} length
   */
  slice (clock, length) {
    const end = clock + length
    if (clock < this.id.clock || length <= 0 || end > this.id.clock + this.length) {
      throw new Error('Invalid causal hole slice')
    }
    return new CausalHole(
      createID(this.id.client, clock),
      length,
      clock === this.id.clock ? this.origin : createID(this.id.client, clock - 1),
      this.rightOrigin,
      this.parent,
      this.parentSub
    )
  }

  /**
   * @param {CausalHole} right
   */
  mergeWith (right) {
    if (
      right.constructor !== CausalHole ||
      this.id.client !== right.id.client ||
      this.id.clock + this.length !== right.id.clock ||
      !compareIDs(right.origin, createID(this.id.client, right.id.clock - 1)) ||
      !compareIDs(this.rightOrigin, right.rightOrigin) ||
      !sameCausalHoleParent(this.parent, right.parent) ||
      this.parentSub !== right.parentSub
    ) {
      return false
    }
    this.length += right.length
    return true
  }

  /**
   * @param {Transaction} transaction
   * @param {number} offset
   */
  integrate (transaction, offset) {
    if (offset > 0) {
      const sliced = this.slice(this.id.clock + offset, this.length - offset)
      this.id = sliced.id
      this.length = sliced.length
      this.origin = sliced.origin
    }
    const store = transaction.doc.store
    recordInstalledCausalHoles(transaction, store.installCausalHole(this))
  }

  /**
   * @param {UpdateEncoderV1|UpdateEncoderV2} encoder
   * @param {number} offset
   * @param {number} offsetEnd
   */
  write (encoder, offset, offsetEnd) {
    const hole = this.slice(this.id.clock + offset, this.length - offset - offsetEnd)
    const info = structCausalHoleRefNumber |
      (hole.origin === null ? 0 : binary.BIT8) |
      (hole.rightOrigin === null ? 0 : binary.BIT7) |
      (hole.parentSub === null ? 0 : binary.BIT6)
    encoder.writeInfo(info)
    encoding.writeVarUint(encoder.restEncoder, hole.length)
    if (hole.origin !== null) encoder.writeLeftID(hole.origin)
    if (hole.rightOrigin !== null) encoder.writeRightID(hole.rightOrigin)
    if (typeof hole.parent === 'string') {
      encoder.writeParentInfo(true)
      encoder.writeString(hole.parent)
    } else {
      encoder.writeParentInfo(false)
      encoder.writeLeftID(hole.parent)
    }
    if (hole.parentSub !== null) encoder.writeString(hole.parentSub)
  }

  /**
   * @param {number} diff
   */
  splice (diff) {
    const right = this.slice(this.id.clock + diff, this.length - diff)
    this.length = diff
    return right
  }
}

/** @type {11} */
CausalHole.prototype.ref = structCausalHoleRefNumber

/** @type {false} */
CausalHole.prototype.isItem = false

/**
 * @param {ID|string} left
 * @param {ID|string} right
 */
export const sameCausalHoleParent = (left, right) =>
  typeof left === 'string' || typeof right === 'string'
    ? left === right
    : compareIDs(left, right)

/**
 * @param {CausalHole} left
 * @param {CausalHole} right
 */
export const sameCausalHoleMetadata = (left, right) =>
  left.id.client === right.id.client &&
  left.id.clock === right.id.clock &&
  left.length === right.length &&
  compareIDs(left.origin, right.origin) &&
  compareIDs(left.rightOrigin, right.rightOrigin) &&
  sameCausalHoleParent(left.parent, right.parent) &&
  left.parentSub === right.parentSub

/**
 * @param {CausalHole} hole
 * @param {Item} item
 * @param {number} clock
 * @param {number} length
 */
export const sameCausalHoleItemMetadata = (hole, item, clock, length) => {
  if (
    item.id.client !== hole.id.client ||
    clock < item.id.clock || clock < hole.id.clock ||
    clock + length > item.id.clock + item.length ||
    clock + length > hole.id.clock + hole.length
  ) return false
  const expected = hole.slice(clock, length)
  const origin = clock === item.id.clock ? item.origin : createID(item.id.client, clock - 1)
  if (!compareIDs(origin, expected.origin) || !compareIDs(item.rightOrigin, expected.rightOrigin)) return false
  if (item.parent !== null) {
    return sameCausalHoleParent(normalizeCausalHoleParent(item.parent), expected.parent) && item.parentSub === expected.parentSub
  }
  return true
}

/**
 * @param {Item} item
 * @param {number} clock
 * @param {number} length
 */
export const createCausalHoleFromItem = (item, clock, length) => {
  const offset = clock - item.id.clock
  if (offset < 0 || length <= 0 || offset + length > item.length) {
    throw new Error('Invalid causal hole source slice')
  }
  if (item.parent === null) throw new Error('Causal hole source has no parent')
  return new CausalHole(
    createID(item.id.client, clock),
    length,
    offset === 0 ? item.origin : createID(item.id.client, clock - 1),
    item.rightOrigin,
    normalizeCausalHoleParent(item.parent),
    item.parentSub
  )
}

export class CausalHoleIndex {
  constructor () {
    /** @type {Map<number,Array<CausalHole>>} */
    this.clients = new Map()
  }

  get size () {
    let size = 0
    this.clients.forEach(holes => { size += holes.length })
    return size
  }

  /** @param {ID} id */
  get (id) {
    const holes = this.clients.get(id.client)
    if (holes === undefined) return null
    let left = 0
    let right = holes.length - 1
    while (left <= right) {
      const middle = (left + right) >>> 1
      const hole = holes[middle]
      if (id.clock < hole.id.clock) right = middle - 1
      else if (id.clock >= hole.id.clock + hole.length) left = middle + 1
      else return hole
    }
    return null
  }

  /** @param {number} client @param {number} clock @param {number} length */
  getOverlaps (client, clock, length) {
    const holes = this.clients.get(client)
    if (holes === undefined || length <= 0) return []
    const end = clock + length
    let left = 0
    let right = holes.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (holes[middle].id.clock + holes[middle].length <= clock) left = middle + 1
      else right = middle
    }
    const overlaps = []
    while (left < holes.length && holes[left].id.clock < end) overlaps.push(holes[left++])
    return overlaps
  }

  /** @param {CausalHole} hole */
  add (hole) {
    const candidate = hole.slice(hole.id.clock, hole.length)
    const holes = this.clients.get(hole.id.client) ?? []
    const start = candidate.id.clock
    const end = start + candidate.length
    let left = 0
    let right = holes.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (holes[middle].id.clock + holes[middle].length <= start) left = middle + 1
      else right = middle
    }
    const overlapStart = left
    /** @type {Array<CausalHole>} */
    const pending = []
    let cursor = start
    while (left < holes.length && holes[left].id.clock < end) {
      const existing = holes[left]
      if (cursor < existing.id.clock) pending.push(candidate.slice(cursor, existing.id.clock - cursor))
      const overlapClock = Math.max(start, existing.id.clock)
      const overlapEnd = Math.min(end, existing.id.clock + existing.length)
      if (!sameCausalHoleMetadata(existing.slice(overlapClock, overlapEnd - overlapClock), candidate.slice(overlapClock, overlapEnd - overlapClock))) {
        throw new Error('Conflicting causal hole metadata')
      }
      cursor = Math.max(cursor, overlapEnd)
      left++
    }
    if (cursor < end) pending.push(candidate.slice(cursor, end - cursor))
    if (pending.length === 0) return
    const replaceStart = overlapStart > 0 && holes[overlapStart - 1].id.clock + holes[overlapStart - 1].length === start ? overlapStart - 1 : overlapStart
    const replaceEnd = left < holes.length && holes[left].id.clock === end ? left + 1 : left
    const merged = holes.slice(replaceStart, replaceEnd).concat(pending).sort((left, right) => left.id.clock - right.id.clock).reduce((result, current) => {
      const previous = result[result.length - 1]
      if (previous === undefined || !previous.mergeWith(current)) result.push(current)
      return result
    }, /** @type {Array<CausalHole>} */ ([]))
    holes.splice(replaceStart, replaceEnd - replaceStart, ...merged)
    this.clients.set(hole.id.client, holes)
  }

  /** @param {(hole:CausalHole)=>void} f */
  forEach (f) {
    this.clients.forEach(holes => holes.forEach(f))
  }

  values () {
    /** @type {Array<CausalHole>} */
    const holes = []
    this.forEach(hole => holes.push(hole))
    return holes
  }
}

/** @param {Transaction} transaction @param {Array<CausalHole>} holes */
const recordInstalledCausalHoles = (transaction, holes) => {
  if (holes.length === 0) return
  let index = /** @type {CausalHoleIndex|undefined} */ (transaction.meta.get(transactionCausalHoles))
  if (index === undefined) {
    index = new CausalHoleIndex()
    transaction.meta.set(transactionCausalHoles, index)
  }
  holes.forEach(hole => index.add(hole))
}

/** @param {Transaction} transaction @return {CausalHoleIndex|null} */
export const getTransactionCausalHoles = transaction => /** @type {CausalHoleIndex|null} */ (transaction.meta.get(transactionCausalHoles) ?? null)
