import { Skip } from '../structs/Skip.js'
import { CausalHole, sameCausalHoleMetadata } from '../structs/CausalHole.js'
import { GC } from '../structs/GC.js'
import { createID } from './ID.js'
import { createDeleteSetFromStructStore, createIdSet } from './ids.js'
import { findIndexSS } from './transaction-helpers.js'

/** @param {ID|string} parent @param {string|null} parentSub */
const causalHoleParentGroupKey = (parent, parentSub) => typeof parent === 'string'
  ? `root:${JSON.stringify(parent)}:${JSON.stringify(parentSub)}`
  : `item:${parent.client}:${parent.clock}:${JSON.stringify(parentSub)}`

/**
 * @param {CausalHole} left
 * @param {CausalHole} right
 * @param {number} clock
 * @param {number} end
 */
const sameSparseMetadataAt = (left, right, clock, end) => {
  const leftSlice = left.slice(clock, end - clock)
  const rightSlice = right.slice(clock, end - clock)
  return sameCausalHoleMetadata(/** @type {CausalHole} */ (/** @type {unknown} */ (leftSlice)), /** @type {CausalHole} */ (/** @type {unknown} */ (rightSlice)))
}

export class StructStore {
  constructor () {
    /**
     * Causal holes are an internal sparse extension hidden from the ordinary StructStore contract.
     * @type {Map<number,Array<GC|Item|Skip>>}
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
    /** @type {Map<string,Set<CausalHole>>} */
    this.causalHolesByParent = new Map()
    /** @type {Map<string,Set<CausalHole>>} */
    this.causalHolesByParentGroup = new Map()
  }

  get ds () {
    return createDeleteSetFromStructStore(this)
  }

  /**
   * @param {GC|Item|Skip|CausalHole} struct
   * @function
   */
  add (struct) {
    let structs = /** @type {Array<GC|Item|Skip|CausalHole>|undefined} */ (/** @type {unknown} */ (this.clients.get(struct.id.client)))
    if (structs === undefined) {
      structs = []
      this.clients.set(struct.id.client, /** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ (structs)))
    } else {
      const lastStruct = structs[structs.length - 1]
      if (lastStruct.id.clock + lastStruct.length !== struct.id.clock) {
        this._replaceSparseRange(structs, struct)
        return
      }
    }
    structs.push(struct)
    if (struct.constructor === CausalHole) this._indexCausalHole(/** @type {CausalHole} */ (struct))
  }

  /**
   * Install a decoded struct without transaction semantics.
   *
   * @param {GC|Item|Skip|CausalHole} struct
   */
  addUpdateStruct (struct) {
    this.add(struct)
    if (struct.constructor === Skip) this.skips.add(struct.id.client, struct.id.clock, struct.length)
    if (struct.constructor === CausalHole) {
      this.getCausalHoleOverlaps(struct.id.client, struct.id.clock, struct.length).forEach(hole => {
        this.causalHoles.add(hole.id.client, hole.id.clock, hole.length)
      })
    }
  }

  /**
   * @param {CausalHole} hole
   */
  installCausalHole (hole) {
    const missing = this.causalHoles.slice(hole.id.client, hole.id.clock, hole.length).filter(range => !range.exists)
    this.add(hole)
    const overlaps = this.getCausalHoleOverlaps(hole.id.client, hole.id.clock, hole.length)
    overlaps.forEach(current => this.causalHoles.add(current.id.client, current.id.clock, current.length))
    /** @type {Array<CausalHole>} */
    const installed = []
    for (const range of missing) {
      const rangeEnd = range.clock + range.len
      for (const current of overlaps) {
        const clock = Math.max(range.clock, current.id.clock)
        const end = Math.min(rangeEnd, current.id.clock + current.length)
        if (clock < end) installed.push(current.slice(clock, end - clock))
      }
    }
    return installed
  }

  /**
   * @param {Array<GC|Item|Skip|CausalHole>} structs
   * @param {GC|Item|Skip|CausalHole} struct
   */
  _replaceSparseRange (structs, struct) {
    const start = struct.id.clock
    const end = start + struct.length
    const startIndex = findIndexSS(/** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ (structs)), start)
    let endIndex = startIndex
    while (endIndex < structs.length && structs[endIndex].id.clock < end) endIndex++
    const replaced = structs.slice(startIndex, endIndex)
    if (replaced.length === 0 || replaced[0].id.clock > start || replaced[replaced.length - 1].id.clock + replaced[replaced.length - 1].length < end) {
      throw new Error('Sparse replacement has missing coverage')
    }
    if (struct.constructor === CausalHole) {
      if (replaced.length === 1 && replaced[0].constructor === CausalHole && sameCausalHoleMetadata(/** @type {CausalHole} */ (replaced[0]), /** @type {CausalHole} */ (struct))) return
      if (replaced.some(current => current.constructor !== Skip && current.constructor !== CausalHole)) return
      if (replaced.some(current => current.constructor === CausalHole && !sameSparseMetadataAt(current, struct, Math.max(start, current.id.clock), Math.min(end, current.id.clock + current.length)))) {
        throw new Error('Conflicting causal hole metadata')
      }
    } else {
      if (struct.constructor === GC && replaced.some(current => current.constructor === CausalHole)) {
        throw new Error('Plain GC cannot replace causal-hole coverage')
      }
      if (replaced.some(current => current.constructor !== Skip && current.constructor !== CausalHole)) {
        throw new Error('Sparse replacement overlaps materialized content')
      }
    }

    const first = replaced[0]
    const last = replaced[replaced.length - 1]
    if (
      (first.isItem && first.id.clock < start) ||
      (last.isItem && last.id.clock + last.length > end)
    ) {
      throw new Error('Causal hole replacement requires materialized boundary split')
    }
    /** @type {Array<GC|Item|Skip|CausalHole>} */
    const replacement = []
    if (first.id.clock < start) replacement.push(this._sliceSparse(/** @type {GC|Skip|CausalHole} */ (first), first.id.clock, start - first.id.clock))
    replacement.push(struct)
    const lastEnd = last.id.clock + last.length
    if (lastEnd > end) replacement.push(this._sliceSparse(/** @type {GC|Skip|CausalHole} */ (last), end, lastEnd - end))
    replaced.forEach(current => {
      if (current.constructor === CausalHole) this._unindexCausalHole(/** @type {CausalHole} */ (current))
    })
    structs.splice(startIndex, endIndex - startIndex, ...replacement)
    replacement.forEach(current => {
      if (current.constructor === CausalHole) this._indexCausalHole(/** @type {CausalHole} */ (current))
    })
    this.skips.delete(struct.id.client, start, struct.length)
    this.causalHoles.delete(struct.id.client, start, struct.length)
  }

  /**
   * @param {GC|Skip|CausalHole} struct
   * @param {number} clock
   * @param {number} length
   */
  _sliceSparse (struct, clock, length) {
    if (struct.constructor === CausalHole) return /** @type {CausalHole} */ (struct).slice(clock, length)
    if (struct.constructor === GC) return new GC(createID(struct.id.client, clock), length)
    return new Skip(createID(struct.id.client, clock), length)
  }

  /** @param {CausalHole} hole */
  _indexCausalHole (hole) {
    if (typeof hole.parent !== 'string') {
      const key = `${hole.parent.client}:${hole.parent.clock}`
      let holes = this.causalHolesByParent.get(key)
      if (holes === undefined) {
        holes = new Set()
        this.causalHolesByParent.set(key, holes)
      }
      holes.add(hole)
    }
    const groupKey = causalHoleParentGroupKey(hole.parent, hole.parentSub)
    let group = this.causalHolesByParentGroup.get(groupKey)
    if (group === undefined) {
      group = new Set()
      this.causalHolesByParentGroup.set(groupKey, group)
    }
    group.add(hole)
  }

  /** @param {CausalHole} hole */
  _unindexCausalHole (hole) {
    if (typeof hole.parent !== 'string') {
      const key = `${hole.parent.client}:${hole.parent.clock}`
      const holes = this.causalHolesByParent.get(key)
      holes?.delete(hole)
      if (holes?.size === 0) this.causalHolesByParent.delete(key)
    }
    const groupKey = causalHoleParentGroupKey(hole.parent, hole.parentSub)
    const group = this.causalHolesByParentGroup.get(groupKey)
    group?.delete(hole)
    if (group?.size === 0) this.causalHolesByParentGroup.delete(groupKey)
  }

  /**
   * @param {number} client
   * @param {number} clock
   * @param {number} length
   * @return {Array<CausalHole>}
   */
  getCausalHoleOverlaps (client, clock, length) {
    if (length <= 0) return []
    const rawStructs = this.clients.get(client)
    if (rawStructs === undefined || rawStructs.length === 0) return []
    const structs = /** @type {Array<GC|Item|Skip|CausalHole>} */ (/** @type {unknown} */ (rawStructs))
    const end = clock + length
    const firstClock = structs[0].id.clock
    const last = structs[structs.length - 1]
    if (end <= firstClock || clock >= last.id.clock + last.length) return []
    let index = findIndexSS(/** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ (structs)), Math.max(clock, structs[0].id.clock))
    /** @type {Array<CausalHole>} */
    const overlaps = []
    for (let struct = structs[index]; struct !== undefined && struct.id.clock < end; struct = structs[++index]) {
      if (struct.constructor === CausalHole && struct.id.clock + struct.length > clock) overlaps.push(/** @type {CausalHole} */ (struct))
    }
    return overlaps
  }

  /** @param {ID|string} parent @param {string|null} parentSub */
  getCausalHolesForParentGroup (parent, parentSub) {
    return this.causalHolesByParentGroup.get(causalHoleParentGroupKey(parent, parentSub)) ?? new Set()
  }

  /**
   * @param {ID} id
   * @return {CausalHole|null}
   */
  getCausalHole (id) {
    if (!this.causalHoles.hasId(id)) return null
    const structs = this.clients.get(id.client)
    if (structs === undefined) return null
    const struct = /** @type {GC|Item|Skip|CausalHole} */ (structs[findIndexSS(structs, id.clock)])
    return struct.constructor === CausalHole ? /** @type {CausalHole} */ (struct) : null
  }

  /**
   * @param {ID} id
   * @return {GC|Item|Skip|CausalHole|null}
   */
  getStruct (id) {
    const structs = this.clients.get(id.client)
    if (structs === undefined || structs.length === 0 || id.clock < structs[0].id.clock || id.clock >= this.getClock(id.client)) return null
    return /** @type {GC|Item|Skip|CausalHole} */ (/** @type {unknown} */ (structs[findIndexSS(structs, id.clock)]))
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
