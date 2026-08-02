import * as binary from 'lib0/binary'
import * as encoding from 'lib0/encoding'

import { ID, compareIDs, createID } from '../utils/ID.js'
import { normalizeCausalHoleParent, sameCausalHoleParent } from './CausalHole.js'

export const structProvenanceGCRefNumber = 13

/** @param {ID|null} id */
const copyID = id => id === null ? null : createID(id.client, id.clock)

/** @param {ID|null} id */
const validID = id => id === null || (Number.isSafeInteger(id.client) && id.client >= 0 && Number.isSafeInteger(id.clock) && id.clock >= 0)

/** Garbage-collected source coverage retaining canonical Item provenance. */
export class ProvenanceGC {
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
    ) throw new Error('Invalid provenance GC')
    this.id = id
    this.length = length
    this.origin = copyID(origin)
    this.rightOrigin = copyID(rightOrigin)
    this.parent = normalizeCausalHoleParent(parent)
    this.parentSub = parentSub
  }

  get deleted () { return true }

  get lastId () { return createID(this.id.client, this.id.clock + this.length - 1) }

  delete () {}

  /** @param {number} clock @param {number} length */
  slice (clock, length) {
    const end = clock + length
    if (clock < this.id.clock || length <= 0 || end > this.id.clock + this.length) throw new Error('Invalid provenance GC slice')
    return new ProvenanceGC(
      createID(this.id.client, clock),
      length,
      clock === this.id.clock ? this.origin : createID(this.id.client, clock - 1),
      this.rightOrigin,
      this.parent,
      this.parentSub
    )
  }

  /** @param {ProvenanceGC} right */
  mergeWith (right) {
    if (
      right.constructor !== ProvenanceGC || this.id.client !== right.id.client ||
      this.id.clock + this.length !== right.id.clock ||
      !compareIDs(right.origin, createID(this.id.client, right.id.clock - 1)) ||
      !compareIDs(this.rightOrigin, right.rightOrigin) ||
      !sameCausalHoleParent(this.parent, right.parent) || this.parentSub !== right.parentSub
    ) return false
    this.length += right.length
    return true
  }

  /** @param {Transaction} transaction @param {number} offset */
  integrate (transaction, offset) {
    if (offset > 0) {
      const sliced = this.slice(this.id.clock + offset, this.length - offset)
      this.id = sliced.id
      this.length = sliced.length
      this.origin = sliced.origin
    }
    transaction.doc.store.installProvenanceGC(transaction, this)
  }

  /** @param {UpdateEncoderV1|UpdateEncoderV2} encoder @param {number} offset @param {number} offsetEnd */
  write (encoder, offset, offsetEnd) {
    const gc = this.slice(this.id.clock + offset, this.length - offset - offsetEnd)
    const info = structProvenanceGCRefNumber |
      (gc.origin === null ? 0 : binary.BIT8) |
      (gc.rightOrigin === null ? 0 : binary.BIT7) |
      (gc.parentSub === null ? 0 : binary.BIT6)
    encoder.writeInfo(info)
    encoding.writeVarUint(encoder.restEncoder, gc.length)
    if (gc.origin !== null) encoder.writeLeftID(gc.origin)
    if (gc.rightOrigin !== null) encoder.writeRightID(gc.rightOrigin)
    if (typeof gc.parent === 'string') {
      encoder.writeParentInfo(true)
      encoder.writeString(gc.parent)
    } else {
      encoder.writeParentInfo(false)
      encoder.writeLeftID(gc.parent)
    }
    if (gc.parentSub !== null) encoder.writeString(gc.parentSub)
  }

  /** @param {number} diff */
  splice (diff) {
    const right = this.slice(this.id.clock + diff, this.length - diff)
    this.length = diff
    return right
  }
}

/** @type {13} */
ProvenanceGC.prototype.ref = structProvenanceGCRefNumber
/** @type {false} */
ProvenanceGC.prototype.isItem = false

/** @param {ProvenanceGC} left @param {ProvenanceGC} right */
export const sameProvenanceGCMetadata = (left, right) =>
  left.id.client === right.id.client && left.id.clock === right.id.clock && left.length === right.length &&
  compareIDs(left.origin, right.origin) && compareIDs(left.rightOrigin, right.rightOrigin) &&
  sameCausalHoleParent(left.parent, right.parent) && left.parentSub === right.parentSub

/** @param {Item} item */
export const createProvenanceGCFromItem = item => new ProvenanceGC(
  createID(item.id.client, item.id.clock), item.length, item.origin, item.rightOrigin,
  item.parent === null ? (() => { throw new Error('Cannot preserve provenance without a parent') })() : normalizeCausalHoleParent(item.parent),
  item.parentSub
)
