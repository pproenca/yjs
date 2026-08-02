import { Skip } from '../structs/Skip.js'
import { Item } from '../structs/Item.js'
import { CausalHole, sameCausalHoleMetadata } from '../structs/CausalHole.js'
import { GC } from '../structs/GC.js'
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
    /** @type {Map<string,Set<CausalHole>>} */
    this.causalHolesByParent = new Map()
    /** @type {Map<number,Map<number,{origin:Map<string,ID>,rightOrigin:Map<string,ID>}>>} */
    this.causalHoleConsumers = new Map()
    /** @type {Map<number,Array<number>>} */
    this.causalHoleConsumerClocks = new Map()
    /** @type {Map<string,Map<string,{client:number,clock:number,side:'origin'|'rightOrigin'}>>} */
    this.causalHoleConsumerAnchors = new Map()
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
    replaced.forEach(current => {
      if (current.constructor === CausalHole) this._unindexCausalHole(/** @type {CausalHole} */ (current))
    })
    structs.splice(startIndex, endIndex - startIndex, ...replacement)
    replacement.forEach(current => {
      if (current.constructor === CausalHole) this._indexCausalHole(/** @type {CausalHole} */ (current))
    })
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

  /** @param {CausalHole} hole */
  _indexCausalHole (hole) {
    if (typeof hole.parent === 'string') return
    const key = `${hole.parent.client}:${hole.parent.clock}`
    let holes = this.causalHolesByParent.get(key)
    if (holes === undefined) {
      holes = new Set()
      this.causalHolesByParent.set(key, holes)
    }
    holes.add(hole)
  }

  /** @param {CausalHole} hole */
  _unindexCausalHole (hole) {
    if (typeof hole.parent === 'string') return
    const key = `${hole.parent.client}:${hole.parent.clock}`
    const holes = this.causalHolesByParent.get(key)
    if (holes === undefined) return
    holes.delete(hole)
    if (holes.size === 0) this.causalHolesByParent.delete(key)
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
   * @param {Item|CausalHole} consumer
   * @param {'origin'|'rightOrigin'} side
   */
  addCausalHoleConsumer (anchor, consumer, side) {
    let buckets = this.causalHoleConsumers.get(anchor.client)
    let clocks = this.causalHoleConsumerClocks.get(anchor.client)
    if (buckets === undefined) {
      buckets = new Map()
      clocks = []
      this.causalHoleConsumers.set(anchor.client, buckets)
      this.causalHoleConsumerClocks.set(anchor.client, clocks)
    }
    let bucket = buckets.get(anchor.clock)
    if (bucket === undefined) {
      bucket = { origin: new Map(), rightOrigin: new Map() }
      buckets.set(anchor.clock, bucket)
      const sortedClocks = /** @type {Array<number>} */ (clocks)
      let left = 0
      let right = sortedClocks.length
      while (left < right) {
        const middle = (left + right) >>> 1
        if (sortedClocks[middle] < anchor.clock) left = middle + 1
        else right = middle
      }
      sortedClocks.splice(left, 0, anchor.clock)
    }
    const consumerKey = `${consumer.id.client}:${consumer.id.clock}`
    bucket[side].set(consumerKey, createID(consumer.id.client, consumer.id.clock))
    const locations = this.causalHoleConsumerAnchors.get(consumerKey) ?? new Map()
    locations.set(`${anchor.client}:${anchor.clock}:${side}`, { client: anchor.client, clock: anchor.clock, side })
    this.causalHoleConsumerAnchors.set(consumerKey, locations)
  }

  /**
   * @param {number} client
   * @param {number} clock
   * @param {number} length
   */
  getCausalHoleConsumerBoundaries (client, clock, length) {
    const clocks = this.causalHoleConsumerClocks.get(client) ?? []
    const buckets = this.causalHoleConsumers.get(client)
    if (buckets === undefined) return []
    const end = clock + length
    let left = 0
    let right = clocks.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (clocks[middle] < clock - 1) left = middle + 1
      else right = middle
    }
    const boundaries = new Set()
    for (; left < clocks.length && clocks[left] < end; left++) {
      const anchorClock = clocks[left]
      const bucket = /** @type {{origin:Map<string,ID>,rightOrigin:Map<string,ID>}} */ (buckets.get(anchorClock))
      if (bucket.rightOrigin.size > 0 && clock < anchorClock && anchorClock < end) boundaries.add(anchorClock)
      if (bucket.origin.size > 0 && clock < anchorClock + 1 && anchorClock + 1 < end) boundaries.add(anchorClock + 1)
    }
    return Array.from(boundaries).sort((left, right) => left - right)
  }

  /**
   * @param {number} client
   * @param {number} clock
   * @param {number} length
   */
  getCausalHoleConsumers (client, clock, length) {
    const clocks = this.causalHoleConsumerClocks.get(client) ?? []
    const buckets = this.causalHoleConsumers.get(client)
    if (buckets === undefined) return []
    const end = clock + length
    let left = 0
    let right = clocks.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (clocks[middle] < clock) left = middle + 1
      else right = middle
    }
    /** @type {Array<{clock:number,item:Item|CausalHole,side:'origin'|'rightOrigin'}>} */
    const consumers = []
    for (; left < clocks.length && clocks[left] < end; left++) {
      const anchorClock = clocks[left]
      const bucket = /** @type {{origin:Map<string,ID>,rightOrigin:Map<string,ID>}} */ (buckets.get(anchorClock))
      for (const side of /** @type {const} */ (['origin', 'rightOrigin'])) {
        for (const consumer of bucket[side].values()) {
          const struct = this.getStruct(consumer)
          if (struct?.constructor === Item || struct?.constructor === CausalHole) {
            consumers.push({ clock: anchorClock, item: /** @type {Item|CausalHole} */ (struct), side })
          }
        }
      }
    }
    return consumers
  }

  /**
   * @param {number} client
   * @param {number} clock
   * @param {number} length
   */
  _deleteCausalHoleConsumers (client, clock, length) {
    this._deleteCausalHoleConsumerRanges(client, [[clock, clock + length]])
  }

  /** @param {number} client @param {Array<[number,number]>} ranges */
  _deleteCausalHoleConsumerRanges (client, ranges) {
    const buckets = this.causalHoleConsumers.get(client)
    const clocks = this.causalHoleConsumerClocks.get(client)
    if (buckets === undefined || clocks === undefined) return
    ranges.sort((left, right) => left[0] - right[0])
    const remaining = []
    let rangeIndex = 0
    for (const anchorClock of clocks) {
      while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= anchorClock) rangeIndex++
      if (rangeIndex < ranges.length && ranges[rangeIndex][0] <= anchorClock && anchorClock < ranges[rangeIndex][1]) {
        const bucket = /** @type {{origin:Map<string,ID>,rightOrigin:Map<string,ID>}} */ (buckets.get(anchorClock))
        for (const side of /** @type {const} */ (['origin', 'rightOrigin'])) {
          for (const consumerKey of bucket[side].keys()) {
            const locations = this.causalHoleConsumerAnchors.get(consumerKey)
            locations?.delete(`${client}:${anchorClock}:${side}`)
            if (locations?.size === 0) this.causalHoleConsumerAnchors.delete(consumerKey)
          }
        }
        buckets.delete(anchorClock)
      } else remaining.push(anchorClock)
    }
    if (remaining.length === 0) {
      this.causalHoleConsumers.delete(client)
      this.causalHoleConsumerClocks.delete(client)
    } else {
      this.causalHoleConsumerClocks.set(client, remaining)
    }
  }

  /** @param {Set<string>} consumers */
  _deleteCausalHoleConsumersByKey (consumers) {
    const affectedClients = new Set()
    consumers.forEach(consumerKey => {
      const locations = this.causalHoleConsumerAnchors.get(consumerKey)
      if (locations === undefined) return
      locations.forEach(location => {
        const buckets = this.causalHoleConsumers.get(location.client)
        const bucket = buckets?.get(location.clock)
        bucket?.[location.side].delete(consumerKey)
        affectedClients.add(location.client)
      })
      this.causalHoleConsumerAnchors.delete(consumerKey)
    })
    affectedClients.forEach(client => {
      const buckets = /** @type {Map<number,{origin:Map<string,ID>,rightOrigin:Map<string,ID>}>} */ (this.causalHoleConsumers.get(client))
      const clocks = /** @type {Array<number>} */ (this.causalHoleConsumerClocks.get(client))
      const remaining = clocks.filter(clock => {
        const bucket = /** @type {{origin:Map<string,ID>,rightOrigin:Map<string,ID>}} */ (buckets.get(clock))
        if (bucket.origin.size > 0 || bucket.rightOrigin.size > 0) return true
        buckets.delete(clock)
        return false
      })
      if (remaining.length > 0) {
        this.causalHoleConsumerClocks.set(client, remaining)
      } else {
        this.causalHoleConsumers.delete(client)
        this.causalHoleConsumerClocks.delete(client)
      }
    })
  }

  /**
   * @param {Transaction} transaction
   * @param {ID} parent
   */
  retireCausalHolesForParent (transaction, parent) {
    const key = `${parent.client}:${parent.clock}`
    const holes = Array.from(this.causalHolesByParent.get(key) ?? [])
    this.causalHolesByParent.delete(key)
    this._deleteCausalHoleConsumersByKey(new Set(holes.map(hole => `${hole.id.client}:${hole.id.clock}`)))
    /** @type {Map<number,Array<[number,number]>>} */
    const retiredRanges = new Map()
    for (const hole of holes) {
      const rawStructs = this.clients.get(hole.id.client)
      if (rawStructs === undefined) continue
      const structs = /** @type {Array<Item|GC|Skip|CausalHole>} */ (/** @type {unknown} */ (rawStructs))
      const index = findIndexSS(/** @type {Array<Item|GC|Skip>} */ (/** @type {unknown} */ (structs)), hole.id.clock)
      if (structs[index] !== hole) continue
      const gc = new GC(createID(hole.id.client, hole.id.clock), hole.length)
      structs[index] = gc
      this.causalHoles.delete(hole.id.client, hole.id.clock, hole.length)
      const ranges = retiredRanges.get(hole.id.client) ?? []
      ranges.push([hole.id.clock, hole.id.clock + hole.length])
      retiredRanges.set(hole.id.client, ranges)
      transaction._mergeStructs.push(gc)
    }
    retiredRanges.forEach((ranges, client) => this._deleteCausalHoleConsumerRanges(client, ranges))
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
