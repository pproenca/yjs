import { Skip } from '../structs/Skip.js'
import { CausalHole, sameCausalHoleMetadata } from '../structs/CausalHole.js'
import { GC } from '../structs/GC.js'
import { createID, ID } from './ID.js'
import { createDeleteSetFromStructStore, createIdSet } from './ids.js'
import { findIndexSS } from './transaction-helpers.js'
import { initializeStructuralRevision, markStructuralChange } from './structural-revision.js'

/** @typedef {import('./BlockSet.js').BlockSet} BlockSet */
/** @typedef {import('./ids.js').IdSet} IdSet */

/**
 * @typedef {{missing:Map<number,number>,update:Uint8Array<ArrayBuffer>}} PendingStructs
 * @typedef {PendingStructs & {blocks:BlockSet,deletes:IdSet,sensitive:IdSet}} IndexedPendingStructs
 * @typedef {{update:Uint8Array<ArrayBuffer>}} PendingDeletes
 * @typedef {PendingDeletes & {deletes:IdSet}} IndexedPendingDeletes
 * @typedef {{structs:IndexedPendingStructs|null,deletes:IndexedPendingDeletes|null,revision:number,mutationEpoch:number,batchDepth:number,batchBase:{structs:IndexedPendingStructs|null,deletes:IndexedPendingDeletes|null}|null}} PendingState
 * @typedef {{structs:IndexedPendingStructs|null,deletes:IndexedPendingDeletes|null,mutationEpoch:number}} PendingSnapshot
 */

/** @type {WeakMap<StructStore,PendingState>} */
const pendingStates = new WeakMap()

/** @type {WeakMap<StructStore,{pending:PendingStructs,resolved:boolean}>} */
const ordinaryPendingStates = new WeakMap()

/** @param {GC|Item|Skip|CausalHole} struct */
const isOrdinaryPendingMaterial = struct => struct.constructor === GC || struct.isItem

/**
 * Ordinary stores retain their public upstream fields. Build the retry index only while an exact
 * pending object is installed; local integration can then mark a dependency in constant time.
 *
 * @param {StructStore} store
 */
export const resyncOrdinaryPendingState = store => {
  if (pendingStates.has(store)) return
  const pending = /** @type {PendingStructs|null|undefined} */ (store.pendingStructs)
  if (pending == null) {
    if (pending !== null || !Object.prototype.hasOwnProperty.call(store, 'pendingStructs')) {
      store.pendingStructs = null
    }
    ordinaryPendingStates.delete(store)
    return
  }
  if (ordinaryPendingStates.get(store)?.pending === pending) return
  let resolved = false
  for (const [client, clock] of pending.missing) {
    const struct = store.getStruct(createID(client, clock))
    if (struct !== null && isOrdinaryPendingMaterial(struct)) {
      resolved = true
      break
    }
  }
  ordinaryPendingStates.set(store, { pending, resolved })
}

/** @param {StructStore} store */
export const hasOrdinaryPendingResolution = store => ordinaryPendingStates.get(store)?.resolved === true

/** @param {StructStore} store @param {GC|Item|Skip|CausalHole} struct */
const markOrdinaryPendingResolution = (store, struct) => {
  const pending = ordinaryPendingStates.get(store)
  if (pending === undefined || pending.resolved || !isOrdinaryPendingMaterial(struct)) return
  const clock = pending.pending.missing.get(struct.id.client)
  if (clock !== undefined && struct.id.clock <= clock && struct.id.clock + struct.length > clock) pending.resolved = true
}

/** @param {Uint8Array} left @param {Uint8Array} right */
const equalPendingBytes = (left, right) => {
  if (left === right) return true
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * @param {{ missing: Map<number, number>, update: Uint8Array }} left
 * @param {{ missing: Map<number, number>, update: Uint8Array }} right
 */
const equalPendingStructs = (left, right) => {
  if (left === right) return true
  if (left.missing.size !== right.missing.size || !equalPendingBytes(left.update, right.update)) return false
  for (const [client, clock] of left.missing) {
    if (right.missing.get(client) !== clock) return false
  }
  return true
}

/** @param {StructStore} store */
const getPendingState = store => {
  const state = pendingStates.get(store)
  if (state === undefined) throw new Error('StructStore pending state is unavailable')
  return state
}

/** @param {null|{missing:Map<number,number>,update:Uint8Array}} left @param {null|{missing:Map<number,number>,update:Uint8Array}} right */
const equalPendingStructState = (left, right) => left === null || right === null
  ? left === right
  : equalPendingStructs(left, right)

/** @param {null|{update:Uint8Array}} left @param {null|{update:Uint8Array}} right */
const equalPendingDeleteState = (left, right) => left === null || right === null
  ? left === right
  : equalPendingBytes(left.update, right.update)

/** @param {StructStore} store */
export const getPendingRevision = store => getPendingState(store).revision

/** @param {StructStore} store @returns {PendingSnapshot} */
export const capturePendingSnapshot = store => {
  const state = getPendingState(store)
  return { structs: state.structs, deletes: state.deletes, mutationEpoch: state.mutationEpoch }
}

/** @param {StructStore} store @param {PendingSnapshot} snapshot */
export const matchesPendingSnapshot = (store, snapshot) => {
  const state = getPendingState(store)
  return state.mutationEpoch === snapshot.mutationEpoch && state.structs === snapshot.structs && state.deletes === snapshot.deletes
}

/** @param {StructStore} store @returns {PendingStructs|null} */
export const readPendingStructs = store => {
  const state = pendingStates.get(store)
  return state === undefined
    ? /** @type {PendingStructs|null|undefined} */ (store.pendingStructs) ?? null
    : state.structs
}

/** @param {StructStore} store @returns {PendingDeletes|null} */
export const readPendingDs = store => {
  const state = pendingStates.get(store)
  if (state !== undefined) return state.deletes
  const pending = /** @type {Uint8Array<ArrayBuffer>|null|undefined} */ (store.pendingDs)
  return pending == null ? null : { update: pending }
}

/** @param {StructStore} store @returns {IndexedPendingStructs|null} */
export const readIndexedPendingStructs = store => getPendingState(store).structs

/** @param {StructStore} store @returns {IndexedPendingDeletes|null} */
export const readIndexedPendingDs = store => getPendingState(store).deletes

/** @param {Map<number,number>} missing @param {BlockSet} blocks @param {IdSet} deletes */
const createPendingSensitivity = (missing, blocks, deletes) => {
  const sensitive = createIdSet()
  missing.forEach((clock, client) => sensitive.add(client, clock, 1))
  blocks.clients.forEach(range => {
    range.refs.forEach(struct => {
      if (struct.constructor !== Skip) sensitive.add(struct.id.client, struct.id.clock, struct.length)
      const anchors = 'origin' in struct
        ? [struct.origin, struct.rightOrigin, struct.parent]
        : []
      for (const anchor of anchors) {
        if (anchor instanceof ID) {
          sensitive.add(anchor.client, anchor.clock, 1)
        }
      }
    })
  })
  deletes.forEach((range, client) => sensitive.add(client, range.clock, range.len))
  return sensitive
}

/** @param {StructStore} store @param {IdSet} inserts */
export const pendingProofAffectedByInserts = (store, inserts) => {
  const state = getPendingState(store)
  const structSensitivity = state.structs?.sensitive ?? null
  const deleteSensitivity = state.deletes?.deletes ?? null
  for (const [client, ranges] of inserts.clients) {
    for (const range of ranges.getIds()) {
      if (
        structSensitivity?.intersects(client, range.clock, range.len) ||
        deleteSensitivity?.intersects(client, range.clock, range.len)
      ) return true
    }
  }
  return false
}

/** @param {StructStore} store */
export const beginPendingTransaction = store => {
  const state = getPendingState(store)
  if (state.batchDepth++ === 0) {
    state.batchBase = { structs: state.structs, deletes: state.deletes }
  }
}

/** @param {StructStore} store */
export const endPendingTransaction = store => {
  const state = getPendingState(store)
  if (state.batchDepth === 0) throw new Error('StructStore pending transaction is not open')
  if (--state.batchDepth !== 0) return
  const base = /** @type {NonNullable<PendingState['batchBase']>} */ (state.batchBase)
  const structsEqual = equalPendingStructState(base.structs, state.structs)
  const deletesEqual = equalPendingDeleteState(base.deletes, state.deletes)
  if (structsEqual) state.structs = base.structs
  if (deletesEqual) state.deletes = base.deletes
  if (!structsEqual || !deletesEqual) state.revision++
  state.batchBase = null
}

/**
 * @param {StructStore} store
 * @param {null|{missing:Map<number,number>,update:Uint8Array<ArrayBuffer>}} pending
 * @param {(update:Uint8Array<ArrayBuffer>)=>{blocks:BlockSet,deletes:IdSet}} [index]
 */
export const commitPendingStructs = (store, pending, index) => {
  const state = pendingStates.get(store)
  if (state === undefined) {
    store.pendingStructs = pending
    resyncOrdinaryPendingState(store)
    return
  }
  if (equalPendingStructState(state.structs, pending)) return
  if (pending === null) {
    state.structs = null
  } else {
    if (index === undefined) throw new TypeError('Pending structs require a decoder index')
    const update = pending.update.slice()
    const indexed = index(update)
    state.structs = {
      missing: new Map(pending.missing),
      update,
      blocks: indexed.blocks,
      deletes: indexed.deletes,
      sensitive: createPendingSensitivity(pending.missing, indexed.blocks, indexed.deletes)
    }
  }
  state.mutationEpoch++
  if (state.batchDepth === 0) state.revision++
}

/**
 * @param {StructStore} store
 * @param {null|{update:Uint8Array<ArrayBuffer>}} pending
 * @param {(update:Uint8Array<ArrayBuffer>)=>IdSet} [index]
 */
export const commitPendingDs = (store, pending, index) => {
  const state = pendingStates.get(store)
  if (state === undefined) {
    store.pendingDs = pending?.update ?? null
    return
  }
  if (equalPendingDeleteState(state.deletes, pending)) return
  if (pending === null) {
    state.deletes = null
  } else {
    if (index === undefined) throw new TypeError('Pending deletes require a decoder index')
    const update = pending.update.slice()
    state.deletes = { update, deletes: index(update) }
  }
  state.mutationEpoch++
  if (state.batchDepth === 0) state.revision++
}

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
  /** @param {boolean} [indexedPending] */
  constructor (indexedPending = false) {
    /**
     * Causal holes are an internal sparse extension hidden from the ordinary StructStore contract.
     * @type {Map<number,Array<GC|Item|Skip>>}
     */
    this.clients = new Map()
    /** @type {PendingStructs|null} */
    this.pendingStructs = null
    /** @type {Uint8Array<ArrayBuffer>|null} */
    this.pendingDs = null
    if (indexedPending) {
      /** @type {PendingState} */
      const state = { structs: null, deletes: null, revision: 0, mutationEpoch: 0, batchDepth: 0, batchBase: null }
      pendingStates.set(this, state)
      initializeStructuralRevision(this)
      Object.defineProperties(this, {
        pendingStructs: {
          get: () => state.structs === null
            ? null
            : { missing: new Map(state.structs.missing), update: state.structs.update.slice() },
          set: () => { throw new TypeError('pendingStructs is read-only') },
          enumerable: true,
          configurable: false
        },
        pendingDs: {
          get: () => state.deletes?.update.slice() ?? null,
          set: () => { throw new TypeError('pendingDs is read-only') },
          enumerable: true,
          configurable: false
        }
      })
    }
    // this.ds = new IdSet()
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
        if (!pendingStates.has(this)) {
          let index = findIndexSS(/** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ (structs)), struct.id.clock)
          const skipped = structs[index]
          const before = struct.id.clock - skipped.id.clock
          const after = skipped.id.clock + skipped.length - struct.id.clock - struct.length
          if (before > 0) structs.splice(index++, 0, new Skip(createID(struct.id.client, skipped.id.clock), before))
          if (after > 0) structs.splice(index + 1, 0, new Skip(createID(struct.id.client, struct.id.clock + struct.length), after))
          structs[index] = struct
          this.skips.delete(struct.id.client, struct.id.clock, struct.length)
          markOrdinaryPendingResolution(this, struct)
          return
        }
        const replaced = this._replaceSparseRange(structs, struct)
        if (replaced) markStructuralChange(this)
        markOrdinaryPendingResolution(this, struct)
        return
      }
    }
    structs.push(struct)
    if (struct.constructor === CausalHole) this._indexCausalHole(/** @type {CausalHole} */ (struct))
    if (struct.constructor === Skip || struct.constructor === CausalHole) markStructuralChange(this)
    markOrdinaryPendingResolution(this, struct)
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
      if (replaced.length === 1 && replaced[0].constructor === CausalHole && sameCausalHoleMetadata(/** @type {CausalHole} */ (replaced[0]), /** @type {CausalHole} */ (struct))) return false
      if (replaced.some(current => current.constructor !== Skip && current.constructor !== CausalHole)) return false
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
    return true
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
