import { Skip } from '../structs/Skip.js'
import { Item } from '../structs/Item.js'
import { CausalHole, sameCausalHoleMetadata } from '../structs/CausalHole.js'
import { createID } from './ID.js'
import { createDeleteSetFromStructStore, createIdSet } from './ids.js'
import { findIndexSS } from './transaction-helpers.js'

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
    /** @type {Map<number,Array<{clock:number,consumer:ID,side:'origin'|'rightOrigin'}>>} */
    this.causalHoleConsumers = new Map()
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
  }

  /**
   * Install a decoded struct without transaction semantics.
   *
   * @param {GC|Item|Skip|CausalHole} struct
   */
  addUpdateStruct (struct) {
    this.add(struct)
    if (struct.constructor === Skip) this.skips.add(struct.id.client, struct.id.clock, struct.length)
    if (struct.constructor === CausalHole) this.causalHoles.add(struct.id.client, struct.id.clock, struct.length)
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
    if (first.id.clock < start) replacement.push(this._sliceSparse(/** @type {Skip|CausalHole} */ (first), first.id.clock, start - first.id.clock))
    replacement.push(struct)
    const lastEnd = last.id.clock + last.length
    if (lastEnd > end) replacement.push(this._sliceSparse(/** @type {Skip|CausalHole} */ (last), end, lastEnd - end))
    structs.splice(startIndex, endIndex - startIndex, ...replacement)
    this.skips.delete(struct.id.client, start, struct.length)
    this.causalHoles.delete(struct.id.client, start, struct.length)
    if (struct.constructor !== CausalHole && struct.constructor !== Skip) this._deleteCausalHoleConsumers(struct.id.client, start, struct.length)
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
    return /** @type {GC|Item|Skip|CausalHole} */ (structs[findIndexSS(structs, id.clock)])
  }

  /**
   * @param {ID} anchor
   * @param {Item} consumer
   * @param {'origin'|'rightOrigin'} side
   */
  addCausalHoleConsumer (anchor, consumer, side) {
    let entries = this.causalHoleConsumers.get(anchor.client)
    if (entries === undefined) {
      entries = []
      this.causalHoleConsumers.set(anchor.client, entries)
    }
    let left = 0
    let right = entries.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (entries[middle].clock < anchor.clock) left = middle + 1
      else right = middle
    }
    while (left < entries.length && entries[left].clock === anchor.clock) {
      const entry = entries[left]
      if (entry.side === side && entry.consumer.client === consumer.id.client && entry.consumer.clock === consumer.id.clock) return
      left++
    }
    entries.splice(left, 0, { clock: anchor.clock, consumer: createID(consumer.id.client, consumer.id.clock), side })
  }

  /**
   * @param {number} client
   * @param {number} clock
   * @param {number} length
   */
  getCausalHoleConsumers (client, clock, length) {
    const entries = this.causalHoleConsumers.get(client) ?? []
    const end = clock + length
    let left = 0
    let right = entries.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (entries[middle].clock < clock) left = middle + 1
      else right = middle
    }
    /** @type {Array<{clock:number,item:Item,side:'origin'|'rightOrigin'}>} */
    const consumers = []
    for (let index = left; index < entries.length && entries[index].clock < end; index++) {
      const entry = entries[index]
      const struct = this.getStruct(entry.consumer)
      if (struct?.constructor === Item) consumers.push({ clock: entry.clock, item: /** @type {Item} */ (struct), side: entry.side })
    }
    return consumers
  }

  /**
   * @param {number} client
   * @param {number} clock
   * @param {number} length
   */
  _deleteCausalHoleConsumers (client, clock, length) {
    const entries = this.causalHoleConsumers.get(client)
    if (entries === undefined) return
    const end = clock + length
    const remaining = entries.filter(entry => entry.clock < clock || entry.clock >= end)
    if (remaining.length === 0) this.causalHoleConsumers.delete(client)
    else this.causalHoleConsumers.set(client, remaining)
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
