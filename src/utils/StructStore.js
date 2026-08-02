import { Skip } from '../structs/Skip.js'
import { CausalHole, sameCausalHoleMetadata } from '../structs/CausalHole.js'
import { createID } from './ID.js'
import { createDeleteSetFromStructStore, createIdSet } from './ids.js'
import { findIndexSS } from './transaction-helpers.js'

export class StructStore {
  constructor () {
    /**
     * @type {Map<number,Array<GC|Item|Skip|CausalHole>>}
     */
    this.clients = new Map()
    // this.ds = new IdSet()
    /**
     * @type {null | { missing: Map<number, number>, update: Uint8Array<ArrayBuffer> }}
     */
    this.pendingStructs = null
    /**
     * @type {null | Uint8Array<ArrayBuffer>}
     */
    this.pendingDs = null
    this.skips = createIdSet()
    this.causalHoles = createIdSet()
  }

  get ds () {
    return createDeleteSetFromStructStore(this)
  }

  /**
   * @param {GC|Item|Skip|CausalHole} struct
   * @function
   */
  add (struct) {
    let structs = this.clients.get(struct.id.client)
    if (structs === undefined) {
      structs = []
      this.clients.set(struct.id.client, structs)
    } else {
      const lastStruct = structs[structs.length - 1]
      if (lastStruct.id.clock + lastStruct.length !== struct.id.clock) {
        this._replaceSparseRange(structs, struct)
        return
      }
    }
    structs.push(struct)
  }

  /**
   * @param {CausalHole} hole
   */
  installCausalHole (hole) {
    this.add(hole)
    this.causalHoles.add(hole.id.client, hole.id.clock, hole.length)
  }

  /**
   * @param {Array<GC|Item|Skip|CausalHole>} structs
   * @param {GC|Item|Skip|CausalHole} struct
   */
  _replaceSparseRange (structs, struct) {
    const start = struct.id.clock
    const end = start + struct.length
    let startIndex = findIndexSS(structs, start)
    let endIndex = startIndex
    while (endIndex < structs.length && structs[endIndex].id.clock < end) endIndex++
    const replaced = structs.slice(startIndex, endIndex)
    if (replaced.length === 0 || replaced[0].id.clock > start || replaced[replaced.length - 1].id.clock + replaced[replaced.length - 1].length < end) {
      throw new Error('Sparse replacement has missing coverage')
    }
    if (struct.constructor === CausalHole) {
      if (replaced.length === 1 && replaced[0].constructor === CausalHole && sameCausalHoleMetadata(/** @type {CausalHole} */ (replaced[0]), /** @type {CausalHole} */ (struct))) return
      if (replaced.some(current => current.constructor !== Skip && current.constructor !== CausalHole)) return
      if (replaced.some(current => current.constructor === CausalHole && !sameCausalHoleMetadata(
        /** @type {CausalHole} */ (current).slice(Math.max(start, current.id.clock), Math.min(end, current.id.clock + current.length) - Math.max(start, current.id.clock)),
        /** @type {CausalHole} */ (struct).slice(Math.max(start, current.id.clock), Math.min(end, current.id.clock + current.length) - Math.max(start, current.id.clock))
      ))) {
        throw new Error('Conflicting causal hole metadata')
      }
    } else if (replaced.some(current => current.constructor !== Skip && current.constructor !== CausalHole)) {
      throw new Error('Sparse replacement overlaps materialized content')
    }

    const first = replaced[0]
    const last = replaced[replaced.length - 1]
    /** @type {Array<GC|Item|Skip|CausalHole>} */
    const replacement = []
    if (first.id.clock < start) replacement.push(this._sliceSparse(first, first.id.clock, start - first.id.clock))
    replacement.push(struct)
    const lastEnd = last.id.clock + last.length
    if (lastEnd > end) replacement.push(this._sliceSparse(last, end, lastEnd - end))
    structs.splice(startIndex, endIndex - startIndex, ...replacement)
    this.skips.delete(struct.id.client, start, struct.length)
    this.causalHoles.delete(struct.id.client, start, struct.length)
  }

  /**
   * @param {Skip|CausalHole} struct
   * @param {number} clock
   * @param {number} length
   */
  _sliceSparse (struct, clock, length) {
    return struct.constructor === CausalHole
      ? /** @type {CausalHole} */ (struct).slice(clock, length)
      : new Skip(createID(struct.id.client, clock), length)
  }

  /**
   * @param {ID} id
   * @return {CausalHole|null}
   */
  getCausalHole (id) {
    if (!this.causalHoles.hasId(id)) return null
    const structs = this.clients.get(id.client)
    if (structs === undefined) return null
    const struct = structs[findIndexSS(structs, id.clock)]
    return struct.constructor === CausalHole ? /** @type {CausalHole} */ (struct) : null
  }

  /**
   * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
   *
   * @param {ID} id
   * @return {GC|Item}
   */
  get (id) {
    const structs = /** @type {Array<GC|Item>} */ (this.clients.get(id.client))
    return structs[findIndexSS(structs, id.clock)]
  }

  /**
   * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
   *
   * @param {ID} id
   * @return {Item}
   */
  getItem (id) {
    const structs = /** @type {Array<GC|Item>} */ (this.clients.get(id.client))
    return /** @type {Item} */ (structs[findIndexSS(structs, id.clock)])
  }

  /**
   * Get the next expected clock for a specific client.
   *
   * @param {number} client
   * @return {number}
   *
   * @public
   * @function
   */
  getClock (client) {
    const structs = this.clients.get(client)
    if (structs === undefined) {
      return 0
    }
    const lastStruct = structs[structs.length - 1]
    return lastStruct.id.clock + lastStruct.length
  }

  /**
   * Perform a binary search on a sorted array
   * @param {ID} id
   * @return {{ structs: Array<GC|Item|Skip>, index: number }}
   *
   * @function
   */
  getIndex (id) {
    const structs = this.clients.get(id.client) || []
    const index = findIndexSS(structs, id.clock)
    return { structs, index }
  }
}

/**
 * Return the states as a Map<client,clock>.
 * Note that clock refers to the next expected clock id.
 *
 * @param {StructStore} store
 * @return {Map<number,number>}
 *
 * @public
 * @function
 */
export const getStateVector = store => {
  const sm = new Map()
  store.clients.forEach((structs, client) => {
    const struct = structs[structs.length - 1]
    sm.set(client, struct.id.clock + struct.length)
  })
  store.skips.clients.forEach((range, client) => {
    sm.set(client, range.getIds()[0].clock)
  })
  store.causalHoles.clients.forEach((range, client) => {
    const clock = range.getIds()[0].clock
    sm.set(client, Math.min(sm.get(client) ?? clock, clock))
  })
  return sm
}

/**
 * @param {StructStore} store
 *
 * @private
 * @function
 */
export const integrityCheck = store => {
  store.clients.forEach(structs => {
    for (let i = 1; i < structs.length; i++) {
      const l = structs[i - 1]
      const r = structs[i]
      if (l.id.clock + l.length !== r.id.clock) {
        throw new Error('StructStore failed integrity check')
      }
    }
  })
}
