import * as binary from 'lib0/binary'
import * as encoding from 'lib0/encoding'

import { ID, compareIDs, createID } from '../utils/ID.js'
import { normalizeCausalHoleParent, sameCausalHoleParent } from './CausalHole.js'

/** @typedef {import('./CausalHole.js').CausalHole} CausalHole */
/** @typedef {import('./GC.js').GC} GC */
/** @typedef {import('./Item.js').Item} Item */
/** @typedef {import('./Skip.js').Skip} Skip */

export const structTerminalCausalHoleRefNumber = 12

/** @param {ID|null} id */
const copyID = id => id === null ? null : createID(id.client, id.clock)

/** @param {ID|null} id */
const validID = id => id === null || (Number.isSafeInteger(id.client) && id.client >= 0 && Number.isSafeInteger(id.clock) && id.clock >= 0)

/**
 * Durable sparse coverage whose source is permanently irrelevant because its structural parent is
 * authoritative dead coverage. It retains the live hole's canonical provenance without entering
 * semantic insert/delete sets.
 */
export class TerminalCausalHole {
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
      throw new Error('Invalid terminal causal hole')
    }
    this.id = id
    this.length = length
    this.origin = copyID(origin)
    this.rightOrigin = copyID(rightOrigin)
    this.parent = normalizeCausalHoleParent(parent)
    this.parentSub = parentSub
  }

  get deleted () { return false }

  get lastId () { return createID(this.id.client, this.id.clock + this.length - 1) }

  delete () {}

  /** @param {number} clock @param {number} length */
  slice (clock, length) {
    const end = clock + length
    if (clock < this.id.clock || length <= 0 || end > this.id.clock + this.length) {
      throw new Error('Invalid terminal causal hole slice')
    }
    return new TerminalCausalHole(
      createID(this.id.client, clock),
      length,
      clock === this.id.clock ? this.origin : createID(this.id.client, clock - 1),
      this.rightOrigin,
      this.parent,
      this.parentSub
    )
  }

  /** @param {TerminalCausalHole|GC|Item|Skip} right */
  mergeWith (right) {
    if (
      right.constructor !== TerminalCausalHole ||
      this.id.client !== right.id.client ||
      this.id.clock + this.length !== right.id.clock ||
      !compareIDs(/** @type {TerminalCausalHole} */ (right).origin, createID(this.id.client, right.id.clock - 1)) ||
      !compareIDs(this.rightOrigin, /** @type {TerminalCausalHole} */ (right).rightOrigin) ||
      !sameCausalHoleParent(this.parent, /** @type {TerminalCausalHole} */ (right).parent) ||
      this.parentSub !== /** @type {TerminalCausalHole} */ (right).parentSub
    ) {
      return false
    }
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
    transaction.doc.store.installTerminalCausalHole(transaction, this)
  }

  /**
   * @param {UpdateEncoderV1|UpdateEncoderV2} encoder
   * @param {number} offset
   * @param {number} offsetEnd
   */
  write (encoder, offset, offsetEnd) {
    const terminal = this.slice(this.id.clock + offset, this.length - offset - offsetEnd)
    const info = structTerminalCausalHoleRefNumber |
      (terminal.origin === null ? 0 : binary.BIT8) |
      (terminal.rightOrigin === null ? 0 : binary.BIT7) |
      (terminal.parentSub === null ? 0 : binary.BIT6)
    encoder.writeInfo(info)
    encoding.writeVarUint(encoder.restEncoder, terminal.length)
    if (terminal.origin !== null) encoder.writeLeftID(terminal.origin)
    if (terminal.rightOrigin !== null) encoder.writeRightID(terminal.rightOrigin)
    if (typeof terminal.parent === 'string') {
      encoder.writeParentInfo(true)
      encoder.writeString(terminal.parent)
    } else {
      encoder.writeParentInfo(false)
      encoder.writeLeftID(terminal.parent)
    }
    if (terminal.parentSub !== null) encoder.writeString(terminal.parentSub)
  }

  /** @param {number} diff */
  splice (diff) {
    const right = this.slice(this.id.clock + diff, this.length - diff)
    this.length = diff
    return right
  }
}

/** @type {12} */
TerminalCausalHole.prototype.ref = structTerminalCausalHoleRefNumber

/** @type {false} */
TerminalCausalHole.prototype.isItem = false

/** @param {TerminalCausalHole} left @param {TerminalCausalHole} right */
export const sameTerminalCausalHoleMetadata = (left, right) =>
  left.id.client === right.id.client &&
  left.id.clock === right.id.clock &&
  left.length === right.length &&
  compareIDs(left.origin, right.origin) &&
  compareIDs(left.rightOrigin, right.rightOrigin) &&
  sameCausalHoleParent(left.parent, right.parent) &&
  left.parentSub === right.parentSub

/** @param {CausalHole} hole */
export const createTerminalCausalHoleFromHole = hole => new TerminalCausalHole(
  createID(hole.id.client, hole.id.clock),
  hole.length,
  hole.origin,
  hole.rightOrigin,
  hole.parent,
  hole.parentSub
)
