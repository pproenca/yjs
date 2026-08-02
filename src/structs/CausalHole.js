import * as binary from 'lib0/binary'
import * as encoding from 'lib0/encoding'

import { AbstractStruct } from './AbstractStruct.js'
import { ID, compareIDs, createID, findRootTypeKey } from '../utils/ID.js'

export const structCausalHoleRefNumber = 11

/**
 * @param {ID|null} id
 */
const copyID = id => id === null ? null : createID(id.client, id.clock)

/**
 * @param {YType|ID|string} parent
 * @return {ID|string}
 */
const normalizeParent = parent => {
  if (typeof parent === 'string') return parent
  if (parent.constructor === ID) return createID(/** @type {ID} */ (parent).client, /** @type {ID} */ (parent).clock)
  const item = /** @type {YType} */ (parent)._item
  return item === null ? findRootTypeKey(/** @type {YType} */ (parent)) : createID(item.id.client, item.id.clock)
}

/**
 * Sparse structural coverage carrying only the canonical metadata required to integrate dependent
 * items. It is never linked into a YType and never enters transaction insert/delete sets.
 */
export class CausalHole extends AbstractStruct {
  /**
   * @param {ID} id
   * @param {number} length
   * @param {ID|null} origin
   * @param {ID|null} rightOrigin
   * @param {ID|string} parent
   * @param {string|null} parentSub
   */
  constructor (id, length, origin, rightOrigin, parent, parentSub) {
    super(id, length)
    if (!Number.isSafeInteger(length) || length <= 0 || (typeof parent !== 'string' && parent.constructor !== ID)) {
      throw new Error('Invalid causal hole')
    }
    this.origin = copyID(origin)
    this.rightOrigin = copyID(rightOrigin)
    this.parent = normalizeParent(parent)
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
    transaction.doc.store.installCausalHole(this)
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
 * @param {Item} item
 * @param {number} clock
 * @param {number} length
 */
export const createCausalHoleFromItem = (item, clock, length) => {
  const offset = clock - item.id.clock
  if (offset < 0 || length <= 0 || offset + length > item.length) {
    throw new Error('Invalid causal hole source slice')
  }
  return new CausalHole(
    createID(item.id.client, clock),
    length,
    offset === 0 ? item.origin : createID(item.id.client, clock - 1),
    item.rightOrigin,
    normalizeParent(item.parent),
    item.parentSub
  )
}
