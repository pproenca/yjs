/**
 * @module encoding
 */
/*
 * We use the first five bits in the info flag for determining the type of the struct.
 *
 * 0: GC
 * 1: Item with Deleted content
 * 2: Item with JSON content
 * 3: Item with Binary content
 * 4: Item with String content
 * 5: Item with Embed content (for richtext content)
 * 6: Item with Format content (a formatting marker for richtext content)
 * 7: Item with Type
 */

import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as map from 'lib0/map'
import * as math from 'lib0/math'
import * as array from 'lib0/array'

import { capturePendingSnapshot, commitPendingDs, commitPendingStructs, getPendingRevision, getStateVector, hasOrdinaryPendingResolution, matchesPendingSnapshot, readIndexedPendingDs, readIndexedPendingStructs, readPendingDs, readPendingStructs, resyncOrdinaryPendingState, StructStore } from './StructStore.js'
import { getStructuralRevision } from './structural-revision.js'
import { findIndexSS, getItemCleanStart, getItemCleanEnd } from './transaction-helpers.js'
import { createIdSet, equalIdSets, IdRange, readAndApplyDeleteSet, readIdSet, mergeIdSets, writeIdSet } from './ids.js'
import { compareIDs, createID, ID } from './ID.js'
import { UpdateDecoderV1, UpdateDecoderV2, IdSetDecoderV1 } from './UpdateDecoder.js'
import { UpdateEncoderV1, UpdateEncoderV2, IdSetEncoderV1, IdSetEncoderV2 } from './UpdateEncoder.js'
import { convertUpdateFormatV2ToV1, LazyStructReader, LazyStructWriter, writeStructToLazyStructWriter, finishLazyStructWriting } from './updates.js'
import { BlockSet, readBlockSet, writeBlockSet } from './BlockSet.js'
import { Skip } from '../structs/Skip.js'
import { ContentDoc, ContentType, Item, findItemInsertionLeft } from '../structs/Item.js'
import { GC } from '../structs/GC.js'
import { CausalHole, CausalHoleIndex, createCausalHoleFromItem, normalizeCausalHoleParent, sameCausalHoleMetadata, sameCausalHoleParent } from '../structs/CausalHole.js'
import { Doc, getDocTransactionGeneration, installStagedDocRootTypes, normalizeDocOptions, stageDocRootType } from './Doc.js'
import { writeStructs } from './encoding-helpers.js'

const applyIntrinsic = Reflect.apply
const mapGetIntrinsic = Map.prototype.get
const mapHasIntrinsic = Map.prototype.has
const mapSetIntrinsic = Map.prototype.set

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {StructStore} store
 * @param {Map<number,number>} _sm
 *
 * @private
 * @function
 */
export const writeClientsStructs = (encoder, store, _sm) => {
  // we filter all valid _sm entries into sm
  const sm = new Map()
  _sm.forEach((clock, client) => {
    // only write if new structs are available
    if (store.getClock(client) > clock) {
      sm.set(client, clock)
    }
  })
  getStateVector(store).forEach((_clock, client) => {
    if (!_sm.has(client)) {
      sm.set(client, 0)
    }
  })
  // write # states that were updated
  encoding.writeVarUint(encoder.restEncoder, sm.size)
  // Write items with higher client ids first
  // This heavily improves the conflict algorithm.
  array.from(sm.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, clock]) => {
    const structs = /** @type {Array<GC|Item|Skip|CausalHole>} */ (/** @type {unknown} */ (store.clients.get(client)))
    const lastStruct = structs[structs.length - 1]
    writeStructs(encoder, structs, client, [new IdRange(clock, lastStruct.id.clock + lastStruct.length - clock)])
  })
}

/**
 * Upstream one-pass integration for ordinary documents.
 *
 * @param {Transaction} transaction
 * @param {StructStore} store
 * @param {BlockSet} clientsStructRefs
 * @return {null|{update:Uint8Array<ArrayBuffer>,missing:Map<number,number>}}
 */
const integrateOrdinaryStructs = (transaction, store, clientsStructRefs) => {
  /** @type {Array<Item|GC|Skip|CausalHole>} */
  const stack = []
  let clientIds = array.from(clientsStructRefs.clients.keys()).sort((a, b) => a - b)
  if (clientIds.length === 0) return null
  const nextTarget = () => {
    while (clientIds.length > 0) {
      const target = /** @type {{i:number,refs:Array<GC|Item|Skip|CausalHole>}} */ (clientsStructRefs.clients.get(clientIds[clientIds.length - 1]))
      if (target.i < target.refs.length) return target
      clientIds.pop()
    }
    return null
  }
  let target = nextTarget()
  if (target === null) return null
  const rest = new StructStore()
  const missing = new Map()
  const state = new Map()
  /** @type {GC|Item|Skip|CausalHole} */
  let head = target.refs[target.i++]
  /** @param {number} client @param {number} clock */
  const recordMissing = (client, clock) => {
    const current = missing.get(client)
    if (current == null || current > clock) missing.set(client, clock)
  }
  const moveStackToRest = () => {
    for (const struct of stack) {
      const range = clientsStructRefs.clients.get(struct.id.client)
      if (range !== undefined) {
        range.i--
        rest.clients.set(struct.id.client, /** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ (range.refs.slice(range.i))))
        clientsStructRefs.clients.delete(struct.id.client)
        range.i = 0
        range.refs = []
      } else {
        rest.clients.set(struct.id.client, /** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ ([struct])))
      }
      clientIds = clientIds.filter(client => client !== struct.id.client)
    }
    stack.length = 0
  }
  while (true) {
    if (head.constructor !== Skip) {
      const localClock = map.setIfUndefined(state, head.id.client, () => store.getClock(head.id.client))
      const offset = localClock - head.id.clock
      const missingClient = head.constructor === Item || head.constructor === CausalHole
        ? getMissing(/** @type {Item|CausalHole} */ (head), transaction, store, null)
        : null
      if (missingClient !== null) {
        stack.push(head)
        const range = clientsStructRefs.clients.get(missingClient) ?? { refs: [], i: 0 }
        if (range.i === range.refs.length || missingClient === head.id.client || stack.some(struct => struct.id.client === missingClient)) {
          recordMissing(missingClient, store.getClock(missingClient))
          moveStackToRest()
        } else {
          head = range.refs[range.i++]
          continue
        }
      } else {
        if (offset < 0) new Skip(createID(head.id.client, localClock), -offset).integrate(transaction, 0)
        head.integrate(transaction, 0)
        state.set(head.id.client, math.max(head.id.clock + head.length, localClock))
      }
    }
    if (stack.length > 0) {
      head = /** @type {GC|Item|CausalHole} */ (stack.pop())
    } else if (target.i < target.refs.length) {
      head = target.refs[target.i++]
    } else {
      target = nextTarget()
      if (target === null) break
      head = target.refs[target.i++]
    }
  }
  if (rest.clients.size === 0) return null
  const encoder = new UpdateEncoderV2()
  writeClientsStructs(encoder, rest, new Map())
  encoding.writeVarUint(encoder.restEncoder, 0)
  return { missing, update: encoder.toUint8Array() }
}

/**
 * Resume computing structs generated by struct readers.
 *
 * While there is something to do, we integrate structs in this order
 * 1. top element on stack, if stack is not empty
 * 2. next element from current struct reader (if empty, use next struct reader)
 *
 * If struct causally depends on another struct (ref.missing), we put next reader of
 * `ref.id.client` on top of stack.
 *
 * At some point we find a struct that has no causal dependencies,
 * then we start emptying the stack.
 *
 * It is not possible to have circles: i.e. struct1 (from client1) depends on struct2 (from client2)
 * depends on struct3 (from client1). Therefore the max stack size is equal to `structReaders.length`.
 *
 * This method is implemented in a way so that we can resume computation if this update
 * causally depends on another update.
 *
 * @param {StructStore} store
 * @param {BlockSet} clientsStructRefs
 * @param {ReturnType<typeof createSparseIntegrationPlan>} sparsePlan
 * @return {{ordered:Array<{struct:GC|Item|CausalHole,clock:number,gap:number}>,rest:null|{update:Uint8Array<ArrayBuffer>,missing:Map<number,number>}}}
 *
 * @private
 * @function
 */
const scheduleStructs = (store, clientsStructRefs, sparsePlan) => {
  /** @type {Array<Item | GC | CausalHole>} */
  const stack = []
  const activeClients = new Set(clientsStructRefs.clients.keys())
  const indices = new Map(array.from(clientsStructRefs.clients.entries()).map(([client, range]) => [client, range.i]))
  let clientsStructRefsIds = array.from(activeClients).sort((a, b) => a - b)
  const getNextStructTarget = () => {
    while (clientsStructRefsIds.length > 0) {
      const client = clientsStructRefsIds[clientsStructRefsIds.length - 1]
      const range = /** @type {{i:number,refs:Array<GC|Item|Skip|CausalHole>}} */ (clientsStructRefs.clients.get(client))
      if (activeClients.has(client) && /** @type {number} */ (indices.get(client)) < range.refs.length) return { client, range }
      clientsStructRefsIds.pop()
    }
    return null
  }
  let curStructsTarget = getNextStructTarget()
  if (curStructsTarget === null) return { ordered: [], rest: null }

  /** @type {Map<number,Array<GC|Item|Skip|CausalHole>>} */
  const restClients = new Map()
  const missingSV = new Map()
  /** @type {Array<{struct:GC|Item|CausalHole,clock:number,gap:number}>} */
  const ordered = []
  const scheduled = new Set()
  const virtualState = new Map()
  const virtualSkips = createIdSet()
  const virtualMaterial = createIdSet()
  /**
   * @param {number} client
   * @param {number} clock
   */
  const updateMissingSv = (client, clock) => {
    const mclock = missingSV.get(client)
    if (mclock == null || mclock > clock) {
      missingSV.set(client, clock)
    }
  }
  /** @param {{client:number,range:{i:number,refs:Array<GC|Item|Skip|CausalHole>}}} target @return {GC|Item|Skip|CausalHole} */
  const take = target => {
    const index = /** @type {number} */ (indices.get(target.client))
    indices.set(target.client, index + 1)
    return target.range.refs[index]
  }
  /** @type {GC|Item|Skip|CausalHole} */
  let stackHead = take(curStructsTarget)

  /** @param {ID} id */
  const hasSkip = id => virtualSkips.hasId(id) || (store.skips.hasId(id) && !virtualMaterial.hasId(id))
  /** @param {Item|CausalHole} struct */
  const getPureMissing = struct => {
    const structuralParent = sparsePlan?.getStructuralParentDependency(struct) ?? null
    if (structuralParent !== null) {
      const installed = store.getStruct(structuralParent.id)
      if (
        !scheduled.has(structuralParent) &&
        (installed?.constructor !== Item || !(/** @type {Item} */ (installed).content instanceof ContentType))
      ) return structuralParent.id.client
    }
    for (const id of [struct.origin, struct.rightOrigin, struct.parent]) {
      if (!(id instanceof ID)) continue
      const clock = virtualState.get(id.client) ?? store.getClock(id.client)
      if (id.clock >= clock || hasSkip(id)) return id.client
    }
    return null
  }

  const addStackToRestSS = () => {
    for (const item of stack) {
      const client = item.id.client
      const range = clientsStructRefs.clients.get(client)
      if (range !== undefined && activeClients.has(client)) {
        const index = Math.max(0, /** @type {number} */ (indices.get(client)) - 1)
        restClients.set(client, range.refs.slice(index))
      } else if (!restClients.has(client)) {
        restClients.set(client, [item])
      }
      activeClients.delete(client)
      clientsStructRefsIds = clientsStructRefsIds.filter(current => current !== client)
    }
    stack.length = 0
  }

  // iterate over all struct readers until we are done
  while (true) {
    if (stackHead.constructor !== Skip) {
      const material = /** @type {GC|Item|CausalHole} */ (stackHead)
      const localClock = virtualState.get(stackHead.id.client) ?? store.getClock(stackHead.id.client)
      const gap = Math.max(0, stackHead.id.clock - localClock)
      const missing = material.constructor === Item || material.constructor === CausalHole
        ? getPureMissing(/** @type {Item|CausalHole} */ (material))
        : null
      if (missing !== null) {
        stack.push(material)
        const range = clientsStructRefs.clients.get(missing)
        const index = indices.get(missing) ?? 0
        if (range === undefined || !activeClients.has(missing) || range.refs.length === index || missing === stackHead.id.client || stack.some(s => s.id.client === missing)) {
          updateMissingSv(/** @type {number} */ (missing), store.getClock(missing))
          addStackToRestSS()
        } else {
          stackHead = take({ client: missing, range })
          continue
        }
      } else {
        if (gap > 0) virtualSkips.add(stackHead.id.client, localClock, gap)
        ordered.push({ struct: material, clock: localClock, gap })
        scheduled.add(material)
        virtualSkips.delete(material.id.client, material.id.clock, material.length)
        virtualMaterial.add(material.id.client, material.id.clock, material.length)
        virtualState.set(stackHead.id.client, Math.max(stackHead.id.clock + stackHead.length, localClock))
      }
    }
    // iterate to next stackHead
    if (stack.length > 0) {
      stackHead = /** @type {GC|Item|CausalHole} */ (stack.pop())
    } else if (curStructsTarget !== null && activeClients.has(curStructsTarget.client) && /** @type {number} */ (indices.get(curStructsTarget.client)) < curStructsTarget.range.refs.length) {
      stackHead = take(curStructsTarget)
    } else {
      curStructsTarget = getNextStructTarget()
      if (curStructsTarget === null) {
        // we are done!
        break
      } else {
        stackHead = take(curStructsTarget)
      }
    }
  }
  if (restClients.size > 0) {
    const restStructs = new StructStore()
    restClients.forEach((refs, client) => restStructs.clients.set(client, /** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ (refs))))
    const encoder = new UpdateEncoderV2()
    writeClientsStructs(encoder, restStructs, new Map())
    // write empty deleteset
    // writeDeleteSet(encoder, new DeleteSet())
    encoding.writeVarUint(encoder.restEncoder, 0) // => no need for an extra function call, just write 0 deletes
    return { ordered, rest: { missing: missingSV, update: encoder.toUint8Array() } }
  }
  return { ordered, rest: null }
}

/**
 * @param {Uint8Array<ArrayBuffer>} update
 */
const indexPendingStructs = update => {
  const decoder = new UpdateDecoderV2(decoding.createDecoder(update))
  const blocks = readBlockSet(decoder)
  const deletes = readIdSet(decoder)
  return { blocks, deletes }
}

/** @param {IdSet} deletes */
const encodePendingDeletes = deletes => {
  const encoder = new UpdateEncoderV2()
  encoding.writeVarUint(encoder.restEncoder, 0)
  writeIdSet(encoder, deletes)
  return encoder.toUint8Array()
}

/** @param {Uint8Array<ArrayBuffer>} update */
const indexPendingDeletes = update => {
  const decoder = new UpdateDecoderV2(decoding.createDecoder(update))
  const blocks = readBlockSet(decoder)
  if (blocks.clients.size !== 0) throw new Error('Pending delete state must not contain structs')
  return readIdSet(decoder)
}

/**
 * @typedef {{client:number,clock:number,type:typeof Item|typeof GC|typeof CausalHole}} MissingDependencyCoverage
 */

/**
 * Find only missing clocks covered by material structs in this envelope. Driving the lookup from
 * incoming refs avoids scanning all retained missing clients and prevents Skip from causing retry.
 *
 * @param {Map<number,number>} missing
 * @param {BlockSet} incoming
 * @param {boolean} sparse
 * @return {Array<MissingDependencyCoverage>}
 */
const collectMissingDependencyCoverage = (missing, incoming, sparse) => {
  /** @type {Array<MissingDependencyCoverage>} */
  const coverage = []
  incoming.clients.forEach((range, client) => {
    const clock = missing.get(client)
    if (clock === undefined) return
    const struct = range.refs.find(struct =>
      struct.id.clock <= clock && struct.id.clock + struct.length > clock && (
        struct.constructor === Item ||
        (!sparse && struct.constructor === GC) ||
        (sparse && struct.constructor === CausalHole)
      )
    )
    if (struct !== undefined) {
      const type = struct.constructor === Item ? Item : struct.constructor === GC ? GC : CausalHole
      coverage.push({ client, clock, type })
    }
  })
  return coverage
}

/**
 * Failed sparse composite plans are deterministic for a settled authoritative generation, pending
 * revision, and structural envelope. Content payload is deliberately absent because sparse planning
 * observes only ranges, causal metadata, and whether content materializes a nested type.
 *
 * @typedef {{structuralRevision:number,pendingRevision:number,canonical:string,error:Error}} SparseFailedPlan
 * @typedef {{entries:Array<SparseFailedPlan>}} SparseFailedPlanState
 */

/** @type {WeakMap<Doc,SparseFailedPlanState>} */
const sparseFailedPlans = new WeakMap()
/** @type {WeakMap<Doc,number>} */
const sparseFailedPlanRuns = new WeakMap()
const maxSparseFailedPlans = 16
const maxCachedSparseEnvelopeCharacters = 4 * 1024

/** @param {Doc} doc */
export const _testOnlyGetSparseFailedPlanRuns = doc => sparseFailedPlanRuns.get(doc) ?? 0

/** @param {ID|null} id */
const semanticID = id => id === null ? null : [id.client, id.clock]

/** @param {ID|string|import('../ytype.js').YType|null} parent */
const semanticParent = parent => parent === null
  ? null
  : typeof parent === 'string'
    ? ['root', parent]
    : parent instanceof ID
      ? ['id', parent.client, parent.clock]
      : ['type']

/** @param {BlockSet} blocks */
const encodeSemanticEnvelope = blocks => JSON.stringify(
  array.from(blocks.clients.entries())
    .sort((left, right) => right[0] - left[0])
    .map(([client, range]) => [client, range.refs.map(struct => {
      if (struct.constructor === Skip) return ['skip', struct.id.clock, struct.length]
      if (struct.constructor === GC) return ['gc', struct.id.clock, struct.length]
      if (struct.constructor === CausalHole) {
        const hole = /** @type {CausalHole} */ (struct)
        return ['hole', hole.id.clock, hole.length, semanticID(hole.origin), semanticID(hole.rightOrigin), semanticParent(hole.parent), hole.parentSub]
      }
      const item = /** @type {Item} */ (struct)
      return ['item', item.id.clock, item.length, semanticID(item.origin), semanticID(item.rightOrigin), semanticParent(item.parent), item.parentSub, item.content instanceof ContentType ? 'type' : 'value']
    })])
)

/** @param {Doc} doc */
const getSparseFailureCoordinates = doc => ({
  structuralRevision: getStructuralRevision(doc.store),
  pendingRevision: getPendingRevision(doc.store)
})

/**
 * @param {Doc} doc
 * @param {string} canonical
 */
const getCachedSparsePlanFailure = (doc, canonical) => {
  const state = sparseFailedPlans.get(doc)
  if (state === undefined) return null
  const coordinates = getSparseFailureCoordinates(doc)
  const semantic = canonical.length > maxCachedSparseEnvelopeCharacters
    ? undefined
    : state.entries.find(entry =>
      entry.structuralRevision === coordinates.structuralRevision &&
      entry.pendingRevision === coordinates.pendingRevision &&
      entry.canonical === canonical
    )
  if (semantic === undefined) return null
  return semantic.error
}

/**
 * @param {Doc} doc
 * @param {string} canonical
 * @param {unknown} failure
 */
const cacheSparsePlanFailure = (doc, canonical, failure) => {
  const error = failure instanceof Error ? failure : new Error(String(failure))
  const coordinates = getSparseFailureCoordinates(doc)
  const entry = {
    ...coordinates,
    canonical,
    error
  }
  const state = sparseFailedPlans.get(doc) ?? { entries: [] }
  if (canonical.length <= maxCachedSparseEnvelopeCharacters) {
    state.entries.push(entry)
    if (state.entries.length > maxSparseFailedPlans) state.entries.shift()
    sparseFailedPlans.set(doc, state)
  }
  return error
}

/**
 * Construct only subdocuments in the frozen integration schedule. ContentDoc.integrate reuses `doc`.
 *
 * @param {Array<{struct:GC|Item|CausalHole,clock:number,gap:number}>} ordered
 * @param {Doc} target
 * @param {Array<ContentDoc>} prepared
 * @param {()=>boolean} isStable
 */
const prepareContentDocs = (ordered, target, prepared, isStable) => {
  const scheduled = new Set(ordered
    .map(entry => entry.struct)
    .filter(struct => struct.constructor === Item && /** @type {Item} */ (struct).content instanceof ContentDoc)
    .map(struct => /** @type {ContentDoc} */ (/** @type {Item} */ (struct).content)))
  const stale = prepared.filter(content => !scheduled.has(content))
  disposeUnintegratedContentDocs(stale)
  for (let index = prepared.length - 1; index >= 0; index--) {
    if (!scheduled.has(prepared[index])) prepared.splice(index, 1)
  }
  try {
    for (const content of scheduled) {
      normalizeDocOptions(content.opts)
      if (content.doc !== null) continue
      const opts = content.opts
      content.doc = /** @type {Doc} */ (new /** @type {any} */ (target.constructor)({
        guid: content.guid,
        ...opts,
        shouldLoad: opts.shouldLoad || opts.autoLoad || false
      }))
      prepared.push(content)
      if (!isStable()) return false
    }
  } catch (failure) {
    disposeUnintegratedContentDocs(prepared)
    prepared.length = 0
    throw failure
  }
  return true
}

/**
 * Resolve user-dispatched root lookup while the sparse schedule is still restartable. The commit
 * path consumes these exact type references and never calls an overridable Doc method.
 *
 * @param {Array<{struct:GC|Item|CausalHole,clock:number,gap:number}>} ordered
 * @param {Doc} target
 * @param {Map<string,YType>} share
 * @param {ReturnType<typeof createSparseIntegrationPlan>} sparsePlan
 * @param {Map<string,YType>} stagedRoots
 * @param {Map<string,YType>} existingRoots
 */
const prepareStringRootParents = (ordered, target, share, sparsePlan, stagedRoots, existingRoots) => {
  /** @type {Map<Item,YType>} */
  const resolved = new Map()
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index]
    if (entry.struct.constructor !== Item) continue
    const item = /** @type {Item} */ (entry.struct)
    const metadata = typeof item.parent === 'string' ? null : sparsePlan?.getParentMetadata(item) ?? null
    const parent = typeof item.parent === 'string' ? item.parent : metadata?.parent
    if (typeof parent !== 'string') continue
    let type
    if (!applyIntrinsic(mapHasIntrinsic, share, [parent])) {
      if (applyIntrinsic(mapHasIntrinsic, stagedRoots, [parent])) {
        type = /** @type {YType} */ (applyIntrinsic(mapGetIntrinsic, stagedRoots, [parent]))
      } else {
        type = stageDocRootType(target)
        applyIntrinsic(mapSetIntrinsic, stagedRoots, [parent, type])
      }
    } else {
      type = target.get(parent)
      if (target.share !== share) throw new Error('Document root map changed during preparation')
      if (
        !applyIntrinsic(mapHasIntrinsic, share, [parent]) ||
        applyIntrinsic(mapGetIntrinsic, share, [parent]) !== type
      ) {
        throw new Error(`Root type lookup did not preserve ${parent}`)
      }
      if (
        applyIntrinsic(mapHasIntrinsic, existingRoots, [parent]) &&
        applyIntrinsic(mapGetIntrinsic, existingRoots, [parent]) !== type
      ) {
        throw new Error(`Root type lookup changed ${parent}`)
      }
      applyIntrinsic(mapSetIntrinsic, existingRoots, [parent, type])
    }
    applyIntrinsic(mapSetIntrinsic, resolved, [item, type])
  }
  return resolved
}

/** @param {Map<Item,YType>} prepared @param {Item} item */
const readPreparedStringRootParent = (prepared, item) => {
  if (!applyIntrinsic(mapHasIntrinsic, prepared, [item])) {
    throw new Error('Sparse root parent preparation is incomplete')
  }
  return /** @type {YType} */ (applyIntrinsic(mapGetIntrinsic, prepared, [item]))
}

/** @param {Array<ContentDoc>} contents */
const disposeUnintegratedContentDocs = contents => {
  const disposable = contents.filter(content => content.doc?._item === null)
  const docs = disposable.map(content => content.doc)
  disposable.forEach(content => { content.doc = null })
  docs.forEach(doc => {
    try {
      doc?.destroy()
    } catch (_) {}
  })
}

/** @param {GC|Item|Skip|CausalHole} struct */
const cloneWorkingStruct = struct => {
  if (struct.constructor === Item) {
    const item = /** @type {Item} */ (struct)
    const clone = new Item(
      item.id,
      null,
      item.origin,
      null,
      item.rightOrigin,
      item.parent,
      item.parentSub,
      item.content instanceof ContentDoc ? item.content : item.content.copy()
    )
    if (item.deleted) clone.markDeleted()
    clone.keep = item.keep
    clone.redone = item.redone
    return clone
  }
  if (struct.constructor === GC) return new GC(struct.id, struct.length)
  if (struct.constructor === Skip) return new Skip(struct.id, struct.length)
  return /** @type {CausalHole} */ (struct).slice(struct.id.clock, struct.length)
}

/** @param {BlockSet} canonical @param {StructStore} store */
const createSparseWorkingSet = (canonical, store) => {
  const working = new BlockSet()
  canonical.clients.forEach((range, client) => {
    working.clients.set(client, { i: 0, refs: range.refs.map(cloneWorkingStruct), startClock: range.startClock })
  })
  working.exclude(collectKnownStructIds(working, store))
  return working
}

/** @param {BlockSet} blocks @param {StructStore} store */
const collectKnownStructIds = (blocks, store) => {
  const known = createIdSet()
  blocks.clients.forEach((_, client) => {
    const stored = store.clients.get(client)
    if (stored === undefined) return
    const last = stored[stored.length - 1]
    known.add(client, 0, last.id.clock + last.length)
    store.skips.clients.get(client)?.getIds().forEach(range => known.delete(client, range.clock, range.len))
    store.causalHoles.clients.get(client)?.getIds().forEach(range => known.delete(client, range.clock, range.len))
  })
  return known
}

/** @param {Transaction} transaction @param {StructStore} store @param {IdSet} deletes */
const hasMaterializedDeleteTarget = (transaction, store, deletes) => {
  let found = false
  transaction.insertSet.forEach((range, client) => {
    if (found || !deletes.intersects(client, range.clock, range.len)) return
    const structs = store.clients.get(client)
    if (structs === undefined) return
    let index = findIndexSS(structs, range.clock)
    const end = range.clock + range.len
    while (index < structs.length && structs[index].id.clock < end) {
      if (structs[index].constructor === Item && deletes.intersects(client, structs[index].id.clock, structs[index].length)) {
        found = true
        return
      }
      index++
    }
  })
  return found
}

/**
 * Keep ordinary documents on the upstream one-pass path. Sparse planning must never become part of
 * their hot loop or change constructor reentrancy.
 *
 * @param {UpdateDecoderV1|UpdateDecoderV2} structDecoder
 * @param {BlockSet} structs
 * @param {Doc} doc
 * @param {any} origin
 */
const applyOrdinaryUpdate = (structDecoder, structs, doc, origin) => {
  /** @type {ReturnType<typeof collectKnownStructIds>|null} */
  let known = null
  structs.clients.forEach(range => range.refs.forEach(struct => {
    if (
      struct.constructor === Item &&
      /** @type {Item} */ (struct).content instanceof ContentDoc
    ) {
      if (known === null) known = collectKnownStructIds(structs, doc.store)
      if (!known.hasId(struct.id)) {
        normalizeDocOptions(/** @type {ContentDoc} */ (/** @type {Item} */ (struct).content).opts)
      }
    }
  }))
  return doc.transact(transaction => {
    transaction.local = false
    structs.exclude(collectKnownStructIds(structs, doc.store))
    const rest = integrateOrdinaryStructs(transaction, doc.store, structs)
    const pending = readPendingStructs(doc.store)
    if (pending !== null && rest !== null) {
      const missing = new Map(pending.missing)
      rest.missing.forEach((clock, client) => {
        const current = missing.get(client)
        if (current == null || current > clock) missing.set(client, clock)
      })
      commitPendingStructs(doc.store, { missing, update: mergeUpdatesV2([pending.update, rest.update]) })
    } else if (pending === null) {
      commitPendingStructs(doc.store, rest)
    }
    const dsRest = readAndApplyDeleteSet(structDecoder, transaction, doc.store)
    const pendingDs = readPendingDs(doc.store)
    const pendingDeleteIndex = pendingDs === null ? null : indexPendingDeletes(pendingDs.update)
    if (dsRest !== null || pendingDeleteIndex !== null) {
      const deleteRests = []
      if (dsRest !== null) deleteRests.push(indexPendingDeletes(dsRest))
      if (pendingDeleteIndex !== null) {
        const next = applyDecodedDeleteSet(pendingDeleteIndex, transaction, doc.store)
        if (next !== null) deleteRests.push(indexPendingDeletes(next))
      }
      const update = deleteRests.length === 0 ? null : encodePendingDeletes(mergeIdSets(deleteRests))
      commitPendingDs(doc.store, update === null ? null : { update })
    }
    const retry = readPendingStructs(doc.store)
    if (retry !== null && hasOrdinaryPendingResolution(doc.store)) {
      const update = retry.update
      commitPendingStructs(doc.store, null)
      applyUpdateV2(transaction.doc, update)
    }
  }, origin, false)
}

/**
 * Read and apply a document update.
 *
 * This function has the same effect as `applyUpdate` but accepts a decoder.
 *
 * @param {decoding.Decoder} decoder
 * @param {Doc} ydoc
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 * @param {UpdateDecoderV1 | UpdateDecoderV2} [structDecoder]
 *
 * @function
 */
export const readUpdateV2 = (decoder, ydoc, transactionOrigin, structDecoder = new UpdateDecoderV2(decoder)) => {
  let ss = readBlockSet(structDecoder)
  const ranges = array.from(ss.clients.values())
  const hasIncomingHoles = ranges.some(range => range.refs.some(struct => struct.constructor === CausalHole))
  const hasIncomingGc = ranges.some(range => range.refs.some(struct => struct.constructor === GC))
  if (hasIncomingHoles && !ydoc.sparseExactResolution) {
    throw new Error('Sparse exact-resolution update requires an enabled document')
  }
  if (ydoc.sparseExactResolution && hasIncomingGc) {
    throw new Error('Sparse exact-resolution documents reject plain GC')
  }
  const store = ydoc.store
  if (!ydoc.sparseExactResolution) {
    resyncOrdinaryPendingState(store)
    return applyOrdinaryUpdate(structDecoder, ss, ydoc, transactionOrigin)
  }
  const hasSparseCausality = hasIncomingHoles || (!store.causalHoles.isEmpty() && ranges.some(range => range.refs.some(struct =>
    struct.constructor === Item && (
      (struct.origin !== null && store.causalHoles.hasId(struct.origin)) ||
      (struct.rightOrigin !== null && store.causalHoles.hasId(struct.rightOrigin)) ||
      store.causalHoles.intersects(struct.id.client, struct.id.clock, struct.length)
    )
  )))
  // Sparse documents decode the complete envelope before opening a transaction. Besides validating
  // causal-hole updates, this keeps malformed ordinary Item updates from partially mutating them.
  const sparseDeleteSet = ydoc.sparseExactResolution || hasSparseCausality ? readIdSet(structDecoder) : null
  const pendingSnapshot = capturePendingSnapshot(store)
  const pendingBefore = pendingSnapshot.structs
  const missingDependencyCoverage = pendingBefore === null
    ? []
    : collectMissingDependencyCoverage(pendingBefore.missing, ss, ydoc.sparseExactResolution)
  let selectedDeleteSet = sparseDeleteSet
  let consumeSparsePending = false
  let failureCanonical = null
  let sparsePlan = null
  if (ydoc.sparseExactResolution && sparseDeleteSet !== null && pendingBefore !== null && missingDependencyCoverage.length > 0) {
    failureCanonical = encodeSemanticEnvelope(ss)
    const cachedFailure = getCachedSparsePlanFailure(ydoc, failureCanonical)
    if (cachedFailure !== null) throw cachedFailure
    sparseFailedPlanRuns.set(ydoc, (sparseFailedPlanRuns.get(ydoc) ?? 0) + 1)
    try {
      const retained = indexPendingStructs(pendingBefore.update)
      const deletes = [retained.deletes, sparseDeleteSet]
      const pendingDeletes = pendingSnapshot.deletes
      if (pendingDeletes !== null) deletes.push(pendingDeletes.deletes)
      retained.blocks.insertInto(ss)
      ss = retained.blocks
      selectedDeleteSet = mergeIdSets(deletes)
      consumeSparsePending = true
      if (array.from(ss.clients.values()).some(range => range.refs.some(struct => struct.constructor === CausalHole))) {
        normalizeIncomingCausalHoles(ss, store)
      }
    } catch (failure) {
      throw cacheSparsePlanFailure(ydoc, failureCanonical, failure)
    }
  } else {
    if (hasIncomingHoles) normalizeIncomingCausalHoles(ss, store)
  }
  /** @type {Array<ContentDoc>} */
  const preparedContentDocs = []
  const planningTransaction = ydoc._transaction
  const transactionBaseline = planningTransaction === null
    ? { inserts: createIdSet(), deletes: createIdSet() }
    : {
        inserts: mergeIdSets([planningTransaction.insertSet]),
        deletes: mergeIdSets([planningTransaction.deleteSet])
      }
  /** @type {ReturnType<typeof scheduleStructs>} */
  let schedule = { ordered: [], rest: null }
  /** @type {Map<Item,YType>} */
  let preparedStringRootParents = new Map()
  /** @type {Map<string,YType>} */
  let preparedShare = ydoc.share
  /** @type {Map<string,YType>} */
  let stagedStringRoots = new Map()
  /** @type {Map<string,YType>} */
  let existingStringRoots = new Map()
  let stable = false
  let scheduledStructuralRevision = getStructuralRevision(store)
  let scheduledPendingRevision = ydoc.sparseExactResolution ? getPendingRevision(store) : 0
  for (let attempt = 0; attempt < 32 && !stable; attempt++) {
    const attemptShare = ydoc.share
    const structuralRevision = getStructuralRevision(store)
    const pendingRevision = getPendingRevision(store)
    const revisionsStable = () => {
      if (!matchesPendingSnapshot(store, pendingSnapshot)) {
        throw new Error('Pending state changed during sparse integration planning')
      }
      return ydoc.share === attemptShare && structuralRevision === getStructuralRevision(store) && pendingRevision === getPendingRevision(store)
    }
    try {
      const working = createSparseWorkingSet(ss, store)
      const validation = validateCausalHoleEnvelope(working, store)
      sparsePlan = validation === null ? null : createSparseIntegrationPlan(working, store, ydoc, attemptShare, validation)
      sparsePlan?.applySplits()
      schedule = scheduleStructs(store, working, sparsePlan)
    } catch (failure) {
      if (failureCanonical !== null) throw cacheSparsePlanFailure(ydoc, failureCanonical, failure)
      throw failure
    }
    stable = prepareContentDocs(schedule.ordered, ydoc, preparedContentDocs, revisionsStable) && revisionsStable()
    if (stable) {
      let attemptStringRootParents
      const attemptStagedStringRoots = new Map()
      const attemptExistingStringRoots = new Map()
      try {
        attemptStringRootParents = prepareStringRootParents(schedule.ordered, ydoc, attemptShare, sparsePlan, attemptStagedStringRoots, attemptExistingStringRoots)
        stable = revisionsStable()
      } catch (failure) {
        disposeUnintegratedContentDocs(preparedContentDocs)
        preparedContentDocs.length = 0
        throw failure
      }
      if (stable) {
        preparedStringRootParents = attemptStringRootParents
        preparedShare = attemptShare
        stagedStringRoots = attemptStagedStringRoots
        existingStringRoots = attemptExistingStringRoots
        scheduledStructuralRevision = structuralRevision
        scheduledPendingRevision = pendingRevision
      }
    }
  }
  if (!stable) {
    disposeUnintegratedContentDocs(preparedContentDocs)
    throw new Error('Subdocument preparation did not reach a stable document revision')
  }

  const apply = () => ydoc.transact(transaction => {
    // force that transaction.local is set to non-local
    transaction.local = false
    if (
      !matchesPendingSnapshot(store, pendingSnapshot) ||
      scheduledStructuralRevision !== getStructuralRevision(store) ||
      scheduledPendingRevision !== getPendingRevision(store) ||
      (planningTransaction !== null && transaction !== planningTransaction) ||
      !equalIdSets(transaction.insertSet, transactionBaseline.inserts) ||
      !equalIdSets(transaction.deleteSet, transactionBaseline.deletes)
    ) {
      throw new Error('Integration schedule invalidated before commit')
    }
    installStagedDocRootTypes(ydoc, preparedShare, existingStringRoots, stagedStringRoots)
    if (consumeSparsePending) {
      commitPendingStructs(store, null)
      commitPendingDs(store, null)
    }
    for (let index = 0; index < schedule.ordered.length; index++) {
      const entry = schedule.ordered[index]
      const clock = store.getClock(entry.struct.id.client)
      if (entry.gap > 0) new Skip(createID(entry.struct.id.client, clock), entry.gap).integrate(transaction, 0)
      if (entry.struct.constructor === Item || entry.struct.constructor === CausalHole) {
        getMissing(/** @type {Item|CausalHole} */ (entry.struct), transaction, store, sparsePlan, preparedStringRootParents)
      }
      entry.struct.integrate(transaction, 0)
    }
    const restStructs = schedule.rest
    const pending = readPendingStructs(store)
    if (pending) {
      if (restStructs) {
        // merge restStructs into store.pending
        const missing = new Map(pending.missing)
        for (const [client, clock] of restStructs.missing) {
          const mclock = missing.get(client)
          if (mclock == null || mclock > clock) {
            missing.set(client, clock)
          }
        }
        const update = mergeUpdatesV2([pending.update, restStructs.update])
        commitPendingStructs(store, { missing, update }, indexPendingStructs)
      }
    } else {
      commitPendingStructs(store, restStructs, indexPendingStructs)
    }
    // console.log('time to integrate: ', performance.now() - start) // @todo remove
    // start = performance.now()
    const dsRest = selectedDeleteSet === null
      ? readAndApplyDeleteSet(structDecoder, transaction, store)
      : applyDecodedDeleteSet(selectedDeleteSet, transaction, store)
    const pendingDs = readPendingDs(store)
    const pendingDeleteIndex = pendingDs === null
      ? null
      : ydoc.sparseExactResolution
        ? readIndexedPendingDs(store)?.deletes ?? null
        : indexPendingDeletes(pendingDs.update)
    const retryPendingDeletes = pendingDeleteIndex !== null && (ydoc.sparseExactResolution
      ? hasMaterializedDeleteTarget(transaction, store, pendingDeleteIndex)
      : true)
    if (dsRest !== null || retryPendingDeletes) {
      const deleteRests = []
      if (dsRest) deleteRests.push(indexPendingDeletes(dsRest))
      if (pendingDs !== null) {
        if (retryPendingDeletes) {
          const dsRest2 = applyDecodedDeleteSet(/** @type {IdSet} */ (pendingDeleteIndex), transaction, store)
          if (dsRest2) deleteRests.push(indexPendingDeletes(dsRest2))
        } else {
          deleteRests.push(/** @type {IdSet} */ (pendingDeleteIndex))
        }
      }
      const pendingDeleteUpdate = deleteRests.length === 0 ? null : encodePendingDeletes(mergeIdSets(deleteRests))
      commitPendingDs(store, pendingDeleteUpdate === null ? null : { update: pendingDeleteUpdate }, indexPendingDeletes)
    }
    // console.log('time to cleanup: ', performance.now() - start) // @todo remove
    // start = performance.now()

    // console.log('time to resume delete readers: ', performance.now() - start) // @todo remove
    // start = performance.now()
    const retryPending = readPendingStructs(store)
    if (!ydoc.sparseExactResolution && retryPending !== null && hasOrdinaryPendingResolution(store)) {
      const update = retryPending.update
      commitPendingStructs(store, null)
      applyUpdateV2(transaction.doc, update)
    }
  }, transactionOrigin, false)
  try {
    return apply()
  } finally {
    disposeUnintegratedContentDocs(preparedContentDocs)
  }
}

/**
 * @param {IdSet} deleteSet
 * @param {Transaction} transaction
 * @param {StructStore} store
 */
const applyDecodedDeleteSet = (deleteSet, transaction, store) => {
  const encoder = new UpdateEncoderV2()
  encoding.writeVarUint(encoder.restEncoder, 0)
  writeIdSet(encoder, deleteSet)
  const decoder = new UpdateDecoderV2(decoding.createDecoder(encoder.toUint8Array()))
  decoding.readVarUint(decoder.restDecoder)
  return readAndApplyDeleteSet(decoder, transaction, store)
}

/**
 * Split decoded holes at every known store boundary and prove that their known prefix can be
 * replayed without touching the store. Decoded refs are private to this read and remain disposable
 * if a later preflight check rejects the update.
 *
 * @param {BlockSet} blockSet
 * @param {StructStore} store
 */
const normalizeIncomingCausalHoles = (blockSet, store) => {
  blockSet.clients.forEach(range => {
    /** @type {Array<GC|Item|Skip|CausalHole>} */
    const normalized = []
    let structIndex = -1
    for (const decoded of range.refs) {
      if (decoded.constructor !== CausalHole) {
        normalized.push(decoded)
        continue
      }
      const hole = /** @type {CausalHole} */ (decoded)
      const structs = /** @type {Array<GC|Item|Skip|CausalHole>|undefined} */ (/** @type {unknown} */ (store.clients.get(hole.id.client)))
      const knownEnd = Math.min(hole.id.clock + hole.length, store.getClock(hole.id.client))
      if (structs === undefined || hole.id.clock >= knownEnd) {
        normalized.push(hole)
        continue
      }

      let cursor = hole.id.clock
      if (structIndex < 0) {
        structIndex = findIndexSS(/** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ (structs)), Math.max(cursor, structs[0].id.clock))
      }
      while (structIndex < structs.length && structs[structIndex].id.clock + structs[structIndex].length <= cursor) structIndex++
      while (cursor < knownEnd) {
        const existing = structs[structIndex]
        if (existing === undefined || existing.id.clock > cursor || existing.id.clock + existing.length <= cursor) {
          throw new Error('Sparse replay has missing known coverage')
        }
        const end = Math.min(knownEnd, existing.id.clock + existing.length)
        const incomingSlice = hole.slice(cursor, end - cursor)
        if (existing.constructor === CausalHole) {
          const existingSlice = /** @type {CausalHole} */ (existing).slice(cursor, end - cursor)
          if (!sameCausalHoleMetadata(incomingSlice, existingSlice)) throw new Error('Conflicting causal hole metadata')
        } else if (existing.constructor === Item) {
          const existingSlice = createCausalHoleFromItem(/** @type {Item} */ (existing), cursor, end - cursor)
          if (!sameCausalHoleMetadata(incomingSlice, existingSlice)) throw new Error('Conflicting causal hole metadata')
        }
        normalized.push(incomingSlice)
        cursor = end
        if (cursor === existing.id.clock + existing.length) structIndex++
      }
      if (cursor < hole.id.clock + hole.length) normalized.push(hole.slice(cursor, hole.id.clock + hole.length - cursor))
    }
    range.refs = normalized
  })
}

/**
 * @param {BlockSet} blockSet
 * @param {StructStore} store
 */
const validateCausalHoleEnvelope = (blockSet, store) => {
  /** @type {Array<CausalHole>} */
  const incomingHoles = []
  /** @type {Array<Item>} */
  const incomingItems = []
  blockSet.clients.forEach(range => {
    range.refs.forEach(struct => {
      if (struct.constructor === CausalHole) incomingHoles.push(/** @type {CausalHole} */ (struct))
      if (struct.constructor === Item) incomingItems.push(/** @type {Item} */ (struct))
    })
  })
  if (incomingHoles.length === 0 && store.causalHoles.isEmpty()) return null

  /**
   * @param {ID} id
   */
  const incomingAt = id => {
    const refs = blockSet.clients.get(id.client)?.refs
    if (refs === undefined || refs.length === 0 || id.clock < refs[0].id.clock) return null
    const last = refs[refs.length - 1]
    if (id.clock >= last.id.clock + last.length) return null
    let left = 0
    let right = refs.length - 1
    while (left <= right) {
      const middle = (left + right) >>> 1
      const struct = refs[middle]
      if (id.clock < struct.id.clock) right = middle - 1
      else if (id.clock >= struct.id.clock + struct.length) left = middle + 1
      else return struct
    }
    return null
  }
  const assertIncomingSparseAnchorsAcyclic = () => {
    /** @type {Map<CausalHole,0|1|2>} */
    const colors = new Map()
    const sparseStructs = incomingHoles
    for (const root of sparseStructs) {
      if (colors.get(root) === 2) continue
      /** @type {Array<{sparse:CausalHole,next:number}>} */
      const stack = [{ sparse: root, next: 0 }]
      colors.set(root, 1)
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]
        const anchors = [frame.sparse.origin, frame.sparse.rightOrigin]
        if (frame.next >= anchors.length) {
          colors.set(frame.sparse, 2)
          stack.pop()
          continue
        }
        const anchor = anchors[frame.next++]
        if (anchor === null) continue
        const dependency = incomingAt(anchor)
        if (dependency?.constructor !== CausalHole) continue
        const sparse = /** @type {CausalHole} */ (dependency)
        const color = colors.get(sparse) ?? 0
        if (color === 1) throw new Error('Cyclic causal hole metadata')
        if (color === 0) {
          colors.set(sparse, 1)
          stack.push({ sparse, next: 0 })
        }
      }
    }
  }
  assertIncomingSparseAnchorsAcyclic()
  /**
   * @param {ID} id
   */
  const resolve = id => {
    const existing = store.getStruct(id)
    if (existing !== null && existing.constructor !== Skip && existing.constructor !== CausalHole) return existing
    const incoming = incomingAt(id)
    if (incoming !== null && incoming.constructor !== Skip && incoming.constructor !== CausalHole) return incoming
    if (existing?.constructor === CausalHole) return existing
    if (incoming?.constructor === CausalHole) return incoming
    return null
  }
  /** @param {CausalHole} hole */
  const coveredByRealStore = hole => {
    let clock = hole.id.clock
    const end = clock + hole.length
    while (clock < end) {
      const struct = store.getStruct(createID(hole.id.client, clock))
      if (struct?.constructor !== Item && struct?.constructor !== GC) return false
      clock = Math.min(end, struct.id.clock + struct.length)
    }
    return true
  }
  /** @param {CausalHole} hole */
  const coveredByStoredHole = hole => {
    let clock = hole.id.clock
    const end = clock + hole.length
    for (const existing of store.getCausalHoleOverlaps(hole.id.client, clock, hole.length)) {
      if (existing.id.clock > clock) return false
      const overlapEnd = Math.min(end, existing.id.clock + existing.length)
      if (!sameCausalHoleMetadata(hole.slice(clock, overlapEnd - clock), existing.slice(clock, overlapEnd - clock))) {
        throw new Error('Conflicting causal hole metadata')
      }
      clock = overlapEnd
      if (clock === end) return true
    }
    return false
  }

  const liveIncomingHoles = new CausalHoleIndex()
  /** @type {Array<CausalHole>} */
  const effectiveIncomingHoles = []
  for (const hole of incomingHoles) {
    const storedHole = coveredByStoredHole(hole)
    if (coveredByRealStore(hole) || storedHole) continue
    effectiveIncomingHoles.push(hole)
  }

  /** @type {Map<Item|CausalHole,Item>} */
  const structuralParentDependencies = new Map()
  /** @param {CausalHole} hole */
  const classifyHoleStructuralParent = hole => {
    const parent = hole.parent
    if (typeof parent === 'string') return true
    const existing = store.getStruct(parent)
    if (existing !== null && existing.constructor !== Skip && existing.constructor !== CausalHole) {
      if (existing.constructor === Item && /** @type {Item} */ (existing).content instanceof ContentType) return true
      throw new Error('Causal hole parent is not a materialized type')
    }
    const incoming = incomingAt(parent)
    if (incoming?.constructor === Item && /** @type {Item} */ (incoming).content instanceof ContentType) {
      structuralParentDependencies.set(hole, /** @type {Item} */ (incoming))
      return true
    }
    throw new Error('Causal hole parent is not a materialized type')
  }

  /** @type {Map<string,Array<CausalHole>>} */
  const incomingHolesByParentGroup = new Map()
  for (const hole of effectiveIncomingHoles) {
    classifyHoleStructuralParent(hole)
    liveIncomingHoles.add(hole)
    const key = sparseParentKey(hole.parent, hole.parentSub)
    const holes = incomingHolesByParentGroup.get(key) ?? []
    holes.push(hole)
    incomingHolesByParentGroup.set(key, holes)
  }

  /** @param {number} client @param {number} clock @param {number} length */
  const getHoleOverlaps = (client, clock, length) => store.getCausalHoleOverlaps(client, clock, length).concat(liveIncomingHoles.getOverlaps(client, clock, length))

  /** @type {Set<Item>} */
  const sparseConnectedItems = new Set()
  /** @param {Item} item */
  const registerStructuralParentDependency = item => {
    if (item.parent === null) return
    const parent = normalizeCausalHoleParent(item.parent)
    if (typeof parent === 'string') return
    const existing = store.getStruct(parent)
    if (existing?.constructor !== CausalHole && existing?.constructor !== Skip && existing !== null) return
    const incoming = incomingAt(parent)
    if (incoming?.constructor === Item && /** @type {Item} */ (incoming).content instanceof ContentType && incoming !== item) {
      structuralParentDependencies.set(item, /** @type {Item} */ (incoming))
    } else if (existing?.constructor === CausalHole) {
      throw new Error('Sparse item parent has no materialized type replacement')
    }
  }

  /** @type {Array<CausalHole>} */
  const roots = effectiveIncomingHoles.slice()
  for (const item of incomingItems) {
    const overlaps = getHoleOverlaps(item.id.client, item.id.clock, item.length)
    if (overlaps.length > 0) sparseConnectedItems.add(item)
    overlaps.forEach(hole => roots.push(hole))
    for (const anchor of [item.origin, item.rightOrigin]) {
      if (anchor === null) continue
      const dependency = resolve(anchor)
      if (dependency?.constructor === CausalHole) {
        sparseConnectedItems.add(item)
        roots.push(/** @type {CausalHole} */ (dependency))
      }
    }
    if (item.parent !== null) {
      const parent = normalizeCausalHoleParent(item.parent)
      if (typeof parent !== 'string' && store.getStruct(parent)?.constructor === CausalHole) {
        sparseConnectedItems.add(item)
      }
    }
  }
  sparseConnectedItems.forEach(registerStructuralParentDependency)
  if (roots.length === 0 && structuralParentDependencies.size === 0) return null

  /** @type {Map<CausalHole,0|1|2>} */
  const colors = new Map()
  const reachable = new Set()
  for (const root of roots) {
    if (colors.get(root) === 2) continue
    /** @type {Array<{hole:CausalHole,next:number}>} */
    const stack = [{ hole: root, next: 0 }]
    colors.set(root, 1)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      reachable.add(frame.hole)
      const anchors = [frame.hole.origin, frame.hole.rightOrigin]
      if (frame.next >= anchors.length) {
        colors.set(frame.hole, 2)
        stack.pop()
        continue
      }
      const anchor = anchors[frame.next++]
      if (anchor === null) continue
      const dependency = resolve(anchor)
      if (dependency === null || dependency.constructor === Skip) throw new Error('Missing causal hole anchor')
      if (dependency.constructor !== CausalHole) continue
      const next = /** @type {CausalHole} */ (dependency)
      const color = colors.get(next) ?? 0
      if (color === 1) throw new Error('Cyclic causal hole metadata')
      if (color === 0) {
        colors.set(next, 1)
        stack.push({ hole: next, next: 0 })
      }
    }
  }

  /** @typedef {{parent:ID|string,parentSub:string|null}} ParentMetadata */
  /** @type {Map<Item|CausalHole,ParentMetadata>} */
  const parentMemo = new Map()
  /** @param {Item|CausalHole} start */
  const getParentMetadata = start => {
    const cached = parentMemo.get(start)
    if (cached !== undefined) return cached
    /** @type {Array<Item|CausalHole>} */
    const path = []
    const seen = new Set()
    /** @type {Item|CausalHole} */
    let current = start
    /** @type {ParentMetadata|null} */
    let metadata = null
    while (metadata === null) {
      const known = parentMemo.get(current)
      if (known !== undefined) {
        metadata = known
        break
      }
      if (seen.has(current)) throw new Error('Cyclic sparse parent metadata')
      seen.add(current)
      path.push(current)
      if (current.constructor === CausalHole) {
        const hole = /** @type {CausalHole} */ (current)
        metadata = { parent: hole.parent, parentSub: hole.parentSub }
        break
      }
      const item = /** @type {Item} */ (current)
      if (item.parent !== null) {
        metadata = { parent: normalizeCausalHoleParent(item.parent), parentSub: item.parentSub }
        break
      }
      const anchor = item.origin ?? item.rightOrigin
      if (anchor === null) throw new Error('Sparse item parent cannot be inferred')
      const dependency = resolve(anchor)
      if (dependency?.constructor !== Item && dependency?.constructor !== CausalHole) throw new Error('Sparse item parent cannot be inferred')
      current = /** @type {Item|CausalHole} */ (dependency)
    }
    for (const struct of path) parentMemo.set(struct, metadata)
    return metadata
  }
  /** @param {ParentMetadata} actual @param {ParentMetadata} expected */
  const assertParentMetadata = (actual, expected) => {
    if (!sameCausalHoleParent(actual.parent, expected.parent) || actual.parentSub !== expected.parentSub) {
      throw new Error('Conflicting causal hole parent metadata')
    }
  }

  /** @type {Map<CausalHole,Item|null>} */
  const leftTerminal = new Map()
  /** @type {Map<CausalHole,Item|null>} */
  const rightTerminal = new Map()
  /** @param {CausalHole} start @param {boolean} left */
  const getTerminal = (start, left) => {
    const memo = left ? leftTerminal : rightTerminal
    const cached = memo.get(start)
    if (cached !== undefined || memo.has(start)) return cached ?? null
    /** @type {Array<CausalHole>} */
    const path = []
    let current = start
    /** @type {Item|null} */
    let terminal = null
    while (true) {
      if (memo.has(current)) {
        terminal = memo.get(current) ?? null
        break
      }
      path.push(current)
      const anchor = left ? current.origin : current.rightOrigin
      if (anchor === null) break
      const dependency = resolve(anchor)
      if (dependency?.constructor === Item) {
        terminal = /** @type {Item} */ (dependency)
        break
      }
      if (dependency?.constructor !== CausalHole) throw new Error('Missing causal hole anchor')
      current = /** @type {CausalHole} */ (dependency)
    }
    for (const hole of path) memo.set(hole, terminal)
    return terminal
  }

  reachable.forEach(hole => {
    const expected = { parent: hole.parent, parentSub: hole.parentSub }
    const left = getTerminal(hole, true)
    const right = getTerminal(hole, false)
    if (left !== null) assertParentMetadata(getParentMetadata(left), expected)
    if (right !== null) assertParentMetadata(getParentMetadata(right), expected)
    for (const anchor of [hole.origin, hole.rightOrigin]) {
      if (anchor === null) continue
      const dependency = resolve(anchor)
      if (dependency?.constructor === Item || dependency?.constructor === CausalHole) {
        assertParentMetadata(getParentMetadata(/** @type {Item|CausalHole} */ (dependency)), expected)
      }
    }
  })

  for (const item of incomingItems) {
    const dependencies = [item.origin, item.rightOrigin]
      .filter(anchor => anchor !== null)
      .map(anchor => resolve(/** @type {ID} */ (anchor)))
    const hole = dependencies.find(dependency => dependency?.constructor === CausalHole)
    if (hole?.constructor !== CausalHole) continue
    const expected = getParentMetadata(/** @type {CausalHole} */ (hole))
    assertParentMetadata(getParentMetadata(item), expected)
    for (const dependency of dependencies) {
      if (dependency?.constructor === Item || dependency?.constructor === CausalHole) {
        assertParentMetadata(getParentMetadata(/** @type {Item|CausalHole} */ (dependency)), expected)
      }
    }
  }
  for (const item of incomingItems) {
    for (const hole of getHoleOverlaps(item.id.client, item.id.clock, item.length)) {
      const clock = Math.max(item.id.clock, hole.id.clock)
      const end = Math.min(item.id.clock + item.length, hole.id.clock + hole.length)
      const expected = hole.slice(clock, end - clock)
      const origin = clock === item.id.clock ? item.origin : createID(item.id.client, clock - 1)
      if (!compareIDs(origin, expected.origin) || !compareIDs(item.rightOrigin, expected.rightOrigin)) {
        throw new Error('Conflicting causal hole replacement anchors')
      }
      assertParentMetadata(getParentMetadata(item), { parent: expected.parent, parentSub: expected.parentSub })
    }
  }
  return {
    incomingHoles: effectiveIncomingHoles,
    incomingItems,
    resolve,
    getParentMetadata,
    getHoleOverlaps,
    getHolesForParentGroup: (/** @type {ID|string} */ parent, /** @type {string|null} */ parentSub) =>
      Array.from(store.getCausalHolesForParentGroup(parent, parentSub)).concat(incomingHolesByParentGroup.get(sparseParentKey(parent, parentSub)) ?? []),
    structuralParentDependencies
  }
}

/** @param {ID|string} parent @param {string|null} parentSub */
const sparseParentKey = (parent, parentSub) =>
  JSON.stringify(typeof parent === 'string'
    ? ['root', parent, parentSub]
    : ['item', parent.client, parent.clock, parentSub])

/** @param {ID} id */
const sparseIDKey = id => `${id.client}:${id.clock}`

/**
 * Build all sparse insertion geometry without mutating decoded refs or the store.
 *
 * @param {BlockSet} blockSet
 * @param {StructStore} store
 * @param {Doc} doc
 * @param {Map<string,YType>} share
 * @param {NonNullable<ReturnType<typeof validateCausalHoleEnvelope>>} validation
 */
const createSparseIntegrationPlan = (blockSet, store, doc, share, validation) => {
  const sparseItems = new Set(validation.incomingItems.filter(item =>
    validation.getHoleOverlaps(item.id.client, item.id.clock, item.length).length > 0 ||
    (item.origin !== null && validation.resolve(item.origin)?.constructor === CausalHole) ||
    (item.rightOrigin !== null && validation.resolve(item.rightOrigin)?.constructor === CausalHole)
  ))
  if (sparseItems.size === 0 && validation.structuralParentDependencies.size === 0) return null

  /** @type {Map<string,{parent:ID|string,parentSub:string|null,items:Array<Item>,itemSet:Set<Item>}>} */
  const groups = new Map()
  sparseItems.forEach(item => {
    const metadata = validation.getParentMetadata(item)
    const key = sparseParentKey(metadata.parent, metadata.parentSub)
    const group = groups.get(key) ?? { ...metadata, items: [], itemSet: new Set() }
    group.items.push(item)
    group.itemSet.add(item)
    groups.set(key, group)
  })
  for (const item of validation.incomingItems) {
    let metadata
    try {
      metadata = validation.getParentMetadata(item)
    } catch (_) {
      continue
    }
    const group = groups.get(sparseParentKey(metadata.parent, metadata.parentSub))
    if (group !== undefined && !group.itemSet.has(item)) {
      group.items.push(item)
      group.itemSet.add(item)
    }
  }

  /** @type {Map<Item,Set<number>>} */
  const itemCuts = new Map()
  /** @param {Item} item @param {number} clock */
  const addItemCut = (item, clock) => {
    if (item.id.clock >= clock || clock >= item.id.clock + item.length) return
    const cuts = itemCuts.get(item) ?? new Set()
    cuts.add(clock)
    itemCuts.set(item, cuts)
  }
  /**
   * @typedef {{
   *   activate:(index:number)=>void,
   *   previous:(index:number)=>({id:ID,length:number}|null),
   *   next:(index:number)=>({id:ID,length:number}|null)
   * }} SparseModel
   */
  /** @type {Map<string,{model:SparseModel,index:number}>} */
  const incomingNodes = new Map()

  for (const group of groups.values()) {
    /**
     * @typedef {{
     *   id:ID,
     *   length:number,
     *   origin:ID|null,
     *   rightOrigin:ID|null,
     *   kind:'actual'|'hole'|'incoming',
     *   item:Item|null
     * }} SparseRange
     */
    /** @type {Array<SparseRange>} */
    const ranges = []
    let parentType = null
    if (typeof group.parent === 'string') {
      parentType = applyIntrinsic(mapHasIntrinsic, share, [group.parent])
        ? /** @type {YType} */ (applyIntrinsic(mapGetIntrinsic, share, [group.parent]))
        : null
    } else {
      const parent = validation.resolve(group.parent)
      if (parent?.constructor === Item && parent.content instanceof ContentType) parentType = parent.content.type
    }
    if (parentType !== null) {
      let item = getParentListStart(parentType, group.parentSub)
      while (item !== null) {
        ranges.push({ id: item.id, length: item.length, origin: item.origin, rightOrigin: item.rightOrigin, kind: 'actual', item })
        item = item.right
      }
    }
    for (const hole of validation.getHolesForParentGroup(group.parent, group.parentSub)) {
      ranges.push({ id: hole.id, length: hole.length, origin: hole.origin, rightOrigin: hole.rightOrigin, kind: 'hole', item: null })
    }
    for (const item of group.items) {
      let clock = item.id.clock
      const end = clock + item.length
      while (clock < end) {
        const existing = store.getStruct(createID(item.id.client, clock))
        const next = existing === null
          ? end
          : Math.min(end, existing.id.clock + existing.length)
        if (
          existing === null || existing.constructor === Skip || existing.constructor === CausalHole
        ) {
          ranges.push({
            id: createID(item.id.client, clock),
            length: next - clock,
            origin: clock === item.id.clock ? item.origin : createID(item.id.client, clock - 1),
            rightOrigin: item.rightOrigin,
            kind: 'incoming',
            item
          })
        }
        addItemCut(item, clock)
        addItemCut(item, next)
        clock = next
      }
    }

    /** @type {Map<number,Set<number>>} */
    const boundaries = new Map()
    /** @param {number} client @param {number} clock */
    const addBoundary = (client, clock) => {
      const clocks = boundaries.get(client) ?? new Set()
      clocks.add(clock)
      boundaries.set(client, clocks)
    }
    for (const range of ranges) {
      addBoundary(range.id.client, range.id.clock)
      addBoundary(range.id.client, range.id.clock + range.length)
      if (range.origin !== null) addBoundary(range.origin.client, range.origin.clock + 1)
      if (range.rightOrigin !== null) addBoundary(range.rightOrigin.client, range.rightOrigin.clock)
    }
    /** @type {Map<number,Array<number>>} */
    const sortedBoundaries = new Map()
    boundaries.forEach((clocks, client) => {
      sortedBoundaries.set(client, Array.from(clocks).sort((left, right) => left - right))
    })
    group.items.forEach(item => {
      const clocks = sortedBoundaries.get(item.id.client) ?? []
      const start = item.id.clock + 1
      const end = item.id.clock + item.length
      let left = 0
      let right = clocks.length
      while (left < right) {
        const middle = (left + right) >>> 1
        if (clocks[middle] < start) left = middle + 1
        else right = middle
      }
      for (; left < clocks.length && clocks[left] < end; left++) addItemCut(item, clocks[left])
    })

    /**
     * @typedef {SparseRange & {
     *   left:ShadowNode|null,
     *   right:ShadowNode|null,
     *   active:boolean
     * }} ShadowNode
     */
    /** @type {Array<ShadowNode>} */
    const nodes = []
    /** @type {Map<number,Array<SparseRange>>} */
    const rangesByClient = new Map()
    for (const range of ranges) {
      const clientRanges = rangesByClient.get(range.id.client) ?? []
      clientRanges.push(range)
      rangesByClient.set(range.id.client, clientRanges)
    }
    const rank = { actual: 3, incoming: 2, hole: 1 }
    rangesByClient.forEach((clientRanges, client) => {
      const clocks = sortedBoundaries.get(client) ?? []
      const starts = clientRanges.slice().sort((left, right) => left.id.clock - right.id.clock || rank[right.kind] - rank[left.kind])
      /** @type {Set<SparseRange>} */
      const active = new Set()
      let nextRange = 0
      for (let clockIndex = 0; clockIndex + 1 < clocks.length; clockIndex++) {
        const clock = clocks[clockIndex]
        const end = clocks[clockIndex + 1]
        while (nextRange < starts.length && starts[nextRange].id.clock <= clock) active.add(starts[nextRange++])
        for (const range of active) {
          if (range.id.clock + range.length <= clock) active.delete(range)
        }
        /** @type {SparseRange|null} */
        let selected = null
        for (const range of active) {
          if (range.id.clock <= clock && end <= range.id.clock + range.length && (selected === null || rank[range.kind] > rank[selected.kind])) selected = range
        }
        if (selected === null || end <= clock) continue
        const range = /** @type {SparseRange} */ (selected)
        nodes.push({
          ...range,
          id: createID(client, clock),
          length: end - clock,
          origin: clock === range.id.clock ? range.origin : createID(client, clock - 1),
          left: null,
          right: null,
          active: range.kind === 'actual'
        })
      }
    })

    /** @type {Map<number,Array<ShadowNode>>} */
    const nodesByClient = new Map()
    for (const node of nodes) {
      const clientNodes = nodesByClient.get(node.id.client) ?? []
      clientNodes.push(node)
      nodesByClient.set(node.id.client, clientNodes)
    }
    nodesByClient.forEach(clientNodes => clientNodes.sort((left, right) => left.id.clock - right.id.clock))
    /** @param {ID} id */
    const getNode = id => {
      const clientNodes = nodesByClient.get(id.client)
      if (clientNodes === undefined) throw new Error(`Missing virtual causal anchor ${id.client}:${id.clock}`)
      let left = 0
      let right = clientNodes.length - 1
      while (left <= right) {
        const middle = (left + right) >>> 1
        const node = clientNodes[middle]
        if (id.clock < node.id.clock) right = middle - 1
        else if (id.clock >= node.id.clock + node.length) left = middle + 1
        else return node
      }
      throw new Error(`Missing virtual causal anchor ${id.client}:${id.clock}`)
    }

    /** @type {Map<ShadowNode,ShadowNode>} */
    const streamPredecessors = new Map()
    nodesByClient.forEach(clientNodes => {
      /** @type {ShadowNode|null} */
      let previous = null
      for (const node of clientNodes) {
        if (node.kind !== 'incoming') continue
        if (previous !== null) streamPredecessors.set(node, previous)
        previous = node
      }
    })

    /** @type {Map<ShadowNode,number>} */
    const indegree = new Map()
    /** @type {Map<ShadowNode,Array<ShadowNode>>} */
    const dependents = new Map()
    for (const node of nodes) {
      const dependencies = new Set()
      for (const anchor of [node.origin, node.rightOrigin]) {
        if (anchor === null) continue
        const dependency = getNode(anchor)
        if (dependency !== node) dependencies.add(dependency)
      }
      const streamPredecessor = streamPredecessors.get(node)
      if (streamPredecessor !== undefined) dependencies.add(streamPredecessor)
      indegree.set(node, dependencies.size)
      dependencies.forEach(dependency => {
        const list = dependents.get(dependency) ?? []
        list.push(node)
        dependents.set(dependency, list)
      })
    }
    /** @type {Array<ShadowNode>} */
    const ready = []
    /** @param {ShadowNode} left @param {ShadowNode} right */
    const compareNodeIDs = (left, right) => left.id.client - right.id.client || right.id.clock - left.id.clock
    /** @param {ShadowNode} node */
    const pushReady = node => {
      let index = ready.length
      ready.push(node)
      while (index > 0) {
        const parent = (index - 1) >>> 1
        if (compareNodeIDs(ready[parent], node) >= 0) break
        ready[index] = ready[parent]
        index = parent
      }
      ready[index] = node
    }
    const popReady = () => {
      const result = /** @type {ShadowNode} */ (ready[0])
      const last = /** @type {ShadowNode} */ (ready.pop())
      if (ready.length > 0) {
        let index = 0
        while (true) {
          const left = index * 2 + 1
          if (left >= ready.length) break
          const right = left + 1
          const child = right < ready.length && compareNodeIDs(ready[right], ready[left]) > 0 ? right : left
          if (compareNodeIDs(ready[child], last) <= 0) break
          ready[index] = ready[child]
          index = child
        }
        ready[index] = last
      }
      return result
    }
    nodes.forEach(node => {
      if (indegree.get(node) === 0) pushReady(node)
    })
    /** @type {ShadowNode|null} */
    let start = null
    let integrated = 0
    const shadowStore = { getItem: getNode }
    while (ready.length > 0) {
      const node = popReady()
      node.left = node.origin === null ? null : getNode(node.origin)
      node.right = node.rightOrigin === null ? null : getNode(node.rightOrigin)
      if ((!node.left && (!node.right || node.right.left !== null)) || (node.left && node.left.right !== node.right)) {
        node.left = findItemInsertionLeft(node, node.left === null ? start : node.left.right, shadowStore)
      }
      if (node.left === null) {
        node.right = start
        start = node
      } else {
        node.right = node.left.right
        node.left.right = node
      }
      if (node.right !== null) node.right.left = node
      integrated++
      for (const dependent of dependents.get(node) ?? []) {
        const remaining = /** @type {number} */ (indegree.get(dependent)) - 1
        indegree.set(dependent, remaining)
        if (remaining === 0) pushReady(dependent)
      }
    }
    if (integrated !== nodes.length) throw new Error('Cyclic virtual causal metadata')

    /** @type {Array<ShadowNode>} */
    const order = []
    for (let node = start; node !== null; node = node.right) order.push(node)
    if (order.length !== nodes.length) throw new Error('Invalid virtual causal geometry')
    const positions = new Map(order.map((node, index) => [node, index]))
    for (const node of nodes) {
      const nodePosition = /** @type {number} */ (positions.get(node))
      if (node.origin !== null && /** @type {number} */ (positions.get(getNode(node.origin))) >= nodePosition) {
        throw new Error('Invalid virtual causal origin geometry')
      }
      if (node.rightOrigin !== null && nodePosition >= /** @type {number} */ (positions.get(getNode(node.rightOrigin)))) {
        throw new Error('Invalid virtual causal right-bound geometry')
      }
    }
    const actualItemOrder = new Map()
    let actualRank = 0
    for (const range of ranges) {
      if (range.kind === 'actual' && !actualItemOrder.has(range.item)) actualItemOrder.set(range.item, actualRank++)
    }
    const expectedActual = nodes.filter(node => node.kind === 'actual').sort((left, right) =>
      /** @type {number} */ (actualItemOrder.get(left.item)) - /** @type {number} */ (actualItemOrder.get(right.item)) || left.id.clock - right.id.clock
    )
    const projectedActual = order.filter(node => node.kind === 'actual')
    if (expectedActual.some((node, index) => projectedActual[index] !== node)) throw new Error('Invalid virtual causal projection')
    const bit = new Array(order.length + 1).fill(0)
    /** @param {number} index @param {number} delta */
    const add = (index, delta) => {
      for (let cursor = index + 1; cursor < bit.length; cursor += cursor & -cursor) bit[cursor] += delta
    }
    /** @param {number} end */
    const sum = end => {
      let total = 0
      for (let cursor = end; cursor > 0; cursor -= cursor & -cursor) total += bit[cursor]
      return total
    }
    /** @param {number} target */
    const select = target => {
      let index = 0
      let mask = 1
      while ((mask << 1) < bit.length) mask <<= 1
      for (; mask > 0; mask >>= 1) {
        const next = index + mask
        if (next < bit.length && bit[next] < target) {
          index = next
          target -= bit[next]
        }
      }
      return index
    }
    order.forEach((node, index) => {
      if (node.active) add(index, 1)
    })
    const model = {
      order,
      activate: /** @param {number} index */ index => {
        if (!order[index].active) {
          order[index].active = true
          add(index, 1)
        }
      },
      previous: /** @param {number} index */ index => {
        const count = sum(index)
        return count === 0 ? null : order[select(count)]
      },
      next: /** @param {number} index */ index => {
        const count = sum(index + 1)
        const total = sum(order.length)
        return count === total ? null : order[select(count + 1)]
      }
    }
    order.forEach((node, index) => {
      if (node.kind !== 'incoming') return
      const key = sparseIDKey(node.id)
      if (incomingNodes.has(key)) throw new Error('Duplicate virtual incoming range')
      incomingNodes.set(key, { model, index })
    })
  }

  sparseItems.forEach(item => {
    const clocks = [item.id.clock, ...Array.from(itemCuts.get(item) ?? []).sort((left, right) => left - right)]
    for (const clock of clocks) {
      const existing = store.getStruct(createID(item.id.client, clock))
      if (
        (existing === null || existing.constructor === Skip || existing.constructor === CausalHole) &&
        !incomingNodes.has(sparseIDKey(createID(item.id.client, clock)))
      ) {
        throw new Error('Incomplete sparse integration geometry')
      }
    }
  })

  return {
    getStructuralParentDependency: (/** @type {Item|CausalHole} */ struct) => validation.structuralParentDependencies.get(struct) ?? null,
    getParentMetadata: (/** @type {Item} */ item) => validation.getParentMetadata(item),
    applySplits: () => {
      blockSet.clients.forEach(range => {
        for (let index = 0; index < range.refs.length; index++) {
          const struct = range.refs[index]
          if (struct.constructor !== Item) continue
          const cuts = Array.from(itemCuts.get(/** @type {Item} */ (struct)) ?? []).sort((left, right) => left - right)
          let current = /** @type {Item} */ (struct)
          for (const clock of cuts) {
            const right = current.split(null, clock - current.id.clock)
            range.refs.splice(++index, 0, right)
            current = right
          }
        }
      })
    },
    getBounds: (/** @type {Item} */ item, /** @type {Transaction} */ transaction) => {
      const entry = incomingNodes.get(sparseIDKey(item.id))
      if (entry === undefined) return null
      const previous = entry.model.previous(entry.index)
      const next = entry.model.next(entry.index)
      entry.model.activate(entry.index)
      return {
        left: previous === null ? null : getItemCleanEnd(transaction, store, createID(previous.id.client, previous.id.clock + previous.length - 1)),
        right: next === null ? null : getItemCleanStart(transaction, createID(next.id.client, next.id.clock))
      }
    }
  }
}

/**
 * Read and apply a document update.
 *
 * This function has the same effect as `applyUpdate` but accepts a decoder.
 *
 * @param {decoding.Decoder} decoder
 * @param {Doc} ydoc
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 *
 * @function
 */
export const readUpdate = (decoder, ydoc, transactionOrigin) => readUpdateV2(decoder, ydoc, transactionOrigin, new UpdateDecoderV1(decoder))

/**
 * Apply a document update created by, for example, `y.on('update', update => ..)` or `update = encodeStateAsUpdate()`.
 *
 * This function has the same effect as `readUpdate` but accepts an Uint8Array instead of a Decoder.
 *
 * @param {Doc} ydoc
 * @param {Uint8Array} update
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 * @param {typeof UpdateDecoderV1 | typeof UpdateDecoderV2} [YDecoder]
 *
 * @function
 */
export const applyUpdateV2 = (ydoc, update, transactionOrigin, YDecoder = UpdateDecoderV2) => {
  const decoder = decoding.createDecoder(update)
  readUpdateV2(decoder, ydoc, transactionOrigin, new YDecoder(decoder))
}

/**
 * Apply a document update created by, for example, `y.on('update', update => ..)` or `update = encodeStateAsUpdate()`.
 *
 * This function has the same effect as `readUpdate` but accepts an Uint8Array instead of a Decoder.
 *
 * @param {Doc} ydoc
 * @param {Uint8Array} update
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 *
 * @function
 */
export const applyUpdate = (ydoc, update, transactionOrigin) => applyUpdateV2(ydoc, update, transactionOrigin, UpdateDecoderV1)

/**
 * Write all the document as a single update message. If you specify the state of the remote client (`targetStateVector`) it will
 * only write the operations that are missing.
 *
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Doc} doc
 * @param {Map<number,number>} [targetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 *
 * @function
 */
export const writeStateAsUpdate = (encoder, doc, targetStateVector = new Map()) => {
  if (doc.sparseExactResolution && getDocTransactionGeneration(doc).destroyed) {
    throw new Error('Cannot encode a destroyed sparse exact-resolution document')
  }
  writeClientsStructs(encoder, doc.store, targetStateVector)
  writeIdSet(encoder, doc.store.ds)
}

/**
 * Write all the document as a single update message that can be applied on the remote document. If you specify the state of the remote client (`targetState`) it will
 * only write the operations that are missing.
 *
 * Use `writeStateAsUpdate` instead if you are working with lib0/encoding.js#Encoder
 *
 * @param {Doc} doc
 * @param {Uint8Array} [encodedTargetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 * @param {UpdateEncoderV1 | UpdateEncoderV2} [encoder]
 * @return {Uint8Array<ArrayBuffer>}
 *
 * @function
 */
export const encodeStateAsUpdateV2 = (doc, encodedTargetStateVector = new Uint8Array([0]), encoder = new UpdateEncoderV2()) => {
  const targetStateVector = decodeStateVector(encodedTargetStateVector)
  writeStateAsUpdate(encoder, doc, targetStateVector)
  const stateUpdate = encoder.toUint8Array()
  const pendingStructs = readPendingStructs(doc.store)
  const pendingDs = readPendingDs(doc.store)
  if (doc.sparseExactResolution && (pendingDs !== null || pendingStructs !== null)) {
    return encodeSparseStateWithPending(doc, stateUpdate, targetStateVector, encoder)
  }
  const updates = [stateUpdate]
  // also add the pending updates (if there are any)
  if (pendingDs !== null) {
    updates.push(pendingDs.update)
  }
  if (pendingStructs !== null) {
    updates.push(diffUpdateV2(pendingStructs.update, encodedTargetStateVector))
  }
  if (updates.length > 1) {
    if (encoder.constructor === UpdateEncoderV1) {
      return mergeUpdates(updates.map((update, i) => i === 0 ? update : convertUpdateFormatV2ToV1(update)))
    } else if (encoder.constructor === UpdateEncoderV2) {
      return mergeUpdatesV2(updates)
    }
  }
  return updates[0]
}

/**
 * Serialize a sparse document's authoritative state and unresolved transport as one update without
 * relaxing the public merge API. Pending refs are decoded, checked against the live sparse store,
 * and merged only after the sparse envelope and virtual geometry validate.
 *
 * @param {Doc} doc
 * @param {Uint8Array<ArrayBuffer>} stateUpdate
 * @param {Map<number,number>} targetStateVector
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 */
const encodeSparseStateWithPending = (doc, stateUpdate, targetStateVector, encoder) => {
  validateSparsePendingState(doc)
  const isV1 = encoder.constructor === UpdateEncoderV1
  const Decoder = isV1 ? UpdateDecoderV1 : UpdateDecoderV2
  const stateDecoder = new Decoder(decoding.createDecoder(stateUpdate))
  const blocks = readBlockSet(stateDecoder).filterStateVector(targetStateVector)
  const deleteSets = [readIdSet(stateDecoder)]

  const pendingStructs = readIndexedPendingStructs(doc.store)
  if (pendingStructs !== null) {
    const pendingBlocks = pendingStructs.blocks.filterStateVector(targetStateVector)
    const pendingRanges = array.from(pendingBlocks.clients.values())
    if (pendingRanges.some(range => range.refs.some(struct => struct.constructor === GC))) {
      throw new Error('Sparse exact-resolution pending state rejects plain GC')
    }
    const hasPendingHoles = pendingRanges.some(range => range.refs.some(struct => struct.constructor === CausalHole))
    if (hasPendingHoles) normalizeIncomingCausalHoles(pendingBlocks, doc.store)
    const validation = validateCausalHoleEnvelope(pendingBlocks, doc.store)
    if (validation !== null) createSparseIntegrationPlan(pendingBlocks, doc.store, doc, doc.share, validation)
    blocks.insertInto(pendingBlocks)
    deleteSets.push(pendingStructs.deletes)
  }

  const pendingDs = readIndexedPendingDs(doc.store)
  if (pendingDs !== null) deleteSets.push(pendingDs.deletes)

  const result = isV1 ? new UpdateEncoderV1() : new UpdateEncoderV2()
  writeBlockSet(result, blocks)
  writeIdSet(result, mergeIdSets(deleteSets))
  return result.toUint8Array()
}

/** @param {Uint8Array} left @param {Uint8Array} right */
const equalBytes = (left, right) => left.byteLength === right.byteLength && left.every((value, index) => value === right[index])

/** @param {Map<number,number>} left @param {Map<number,number>} right */
const equalMissing = (left, right) => left.size === right.size && array.from(left.entries()).every(([client, clock]) => right.get(client) === clock)

/** @type {WeakMap<Doc,{generation:number,pendingRevision:number}>} */
const sparsePendingProofs = new WeakMap()

/** @type {WeakMap<Doc,number>} */
const sparsePendingProofRuns = new WeakMap()

/** @param {Doc} doc */
export const _testOnlyGetSparsePendingProofRuns = doc => sparsePendingProofRuns.get(doc) ?? 0

/** @param {Doc} doc */
const encodeAuthoritativeSparseState = doc => {
  const encoder = new UpdateEncoderV2()
  writeStateAsUpdate(encoder, doc)
  return encoder.toUint8Array()
}

/**
 * Prove that stored pending transport is still unresolved against a copy of the authoritative
 * sparse state. A forged missing map cannot therefore hide a materializable Item or delete.
 *
 * @param {Doc} doc
 */
const validateSparsePendingState = doc => {
  const transaction = getDocTransactionGeneration(doc)
  const pendingRevision = getPendingRevision(doc.store)
  const proof = sparsePendingProofs.get(doc)
  if (transaction.settled && proof?.generation === transaction.generation && proof.pendingRevision === pendingRevision) return
  const authoritative = encodeAuthoritativeSparseState(doc)
  const scratch = new Doc({ guid: doc.guid, gc: false, sparseExactResolution: true })
  const occupied = new Set(doc.store.clients.keys())
  const pendingStructs = readIndexedPendingStructs(doc.store)
  const pendingDs = readIndexedPendingDs(doc.store)
  if (pendingStructs !== null) {
    pendingStructs.blocks.clients.forEach((_, client) => occupied.add(client))
  }
  let scratchClientID = Number.MAX_SAFE_INTEGER
  while (occupied.has(scratchClientID)) scratchClientID--
  try {
    scratch.clientID = scratchClientID
    applyUpdateV2(scratch, authoritative)
    const share = array.from(scratch.share.keys())
    const subdocs = array.from(scratch.subdocs, subdoc => subdoc.guid).sort()
    const stateVector = encodeStateVector(scratch)

    if (pendingStructs !== null) applyUpdateV2(scratch, pendingStructs.update)
    if (pendingDs !== null) applyUpdateV2(scratch, pendingDs.update)

    const scratchPendingStructs = readIndexedPendingStructs(scratch.store)
    const scratchPendingDs = readIndexedPendingDs(scratch.store)
    const pendingStructsMatch = pendingStructs === null
      ? scratchPendingStructs === null
      : scratchPendingStructs !== null &&
        equalMissing(pendingStructs.missing, scratchPendingStructs.missing) &&
        equalBytes(pendingStructs.update, scratchPendingStructs.update)
    const pendingDeletesMatch = pendingDs === null
      ? scratchPendingDs === null
      : scratchPendingDs !== null && equalBytes(pendingDs.update, scratchPendingDs.update)
    const indexedPending = pendingStructs === null
      ? null
      : (() => {
          const encoder = new UpdateEncoderV2()
          writeBlockSet(encoder, /** @type {BlockSet} */ (pendingStructs.blocks))
          writeIdSet(encoder, /** @type {IdSet} */ (pendingStructs.deletes))
          return encoder.toUint8Array()
        })()
    if (
      !equalBytes(authoritative, encodeAuthoritativeSparseState(scratch)) ||
      !equalBytes(stateVector, encodeStateVector(scratch)) ||
      share.length !== scratch.share.size || share.some((key, index) => key !== array.from(scratch.share.keys())[index]) ||
      subdocs.join('\u0000') !== array.from(scratch.subdocs, subdoc => subdoc.guid).sort().join('\u0000') ||
      (indexedPending !== null && (pendingStructs === null || !equalBytes(indexedPending, pendingStructs.update))) ||
      !pendingStructsMatch ||
      !pendingDeletesMatch
    ) {
      throw new Error('Sparse pending state is not authentic unresolved transport')
    }
    sparsePendingProofRuns.set(doc, (sparsePendingProofRuns.get(doc) ?? 0) + 1)
    if (transaction.settled) {
      sparsePendingProofs.set(doc, { generation: transaction.generation, pendingRevision })
    }
  } finally {
    scratch.destroy()
  }
}

/**
 * Write all the document as a single update message that can be applied on the remote document. If you specify the state of the remote client (`targetState`) it will
 * only write the operations that are missing.
 *
 * Use `writeStateAsUpdate` instead if you are working with lib0/encoding.js#Encoder
 *
 * @param {Doc} doc
 * @param {Uint8Array} [encodedTargetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 * @return {Uint8Array<ArrayBuffer>}
 *
 * @function
 */
export const encodeStateAsUpdate = (doc, encodedTargetStateVector) => encodeStateAsUpdateV2(doc, encodedTargetStateVector, new UpdateEncoderV1())

/**
 * Read state vector from Decoder and return as Map
 *
 * @param {IdSetDecoderV1 | IdSetDecoderV2} decoder
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
export const readStateVector = decoder => {
  const ss = new Map()
  const ssLength = decoding.readVarUint(decoder.restDecoder)
  for (let i = 0; i < ssLength; i++) {
    const client = decoding.readVarUint(decoder.restDecoder)
    const clock = decoding.readVarUint(decoder.restDecoder)
    ss.set(client, clock)
  }
  return ss
}

/**
 *
 * This function works similarly to `readUpdateV2`.
 *
 * @param {Array<Uint8Array<ArrayBuffer>>} updates
 * @param {typeof UpdateDecoderV1 | typeof UpdateDecoderV2} [YDecoder]
 * @param {typeof UpdateEncoderV1 | typeof UpdateEncoderV2} [YEncoder]
 * @return {Uint8Array<ArrayBuffer>}
 */
export const mergeUpdatesV2 = (updates, YDecoder = UpdateDecoderV2, YEncoder = UpdateEncoderV2) => {
  if (updates.length === 0) {
    return encodeStateAsUpdateV2(new Doc(), new Uint8Array([0]), new YEncoder())
  }
  const updateDecoders = updates.map(update => new YDecoder(decoding.createDecoder(update)))
  const blocksets = updateDecoders.map(dec => readBlockSet(dec))
  if (blocksets.some(blockset => array.from(blockset.clients.values()).some(range =>
    range.refs.some(struct => struct.constructor === CausalHole)
  ))) {
    throw new Error('Generic update merge rejects causal-hole transport')
  }
  if (updates.length === 1) return updates[0]

  const mergedBlockset = blocksets[0]
  for (let i = 1; i < blocksets.length; i++) {
    mergedBlockset.insertInto(blocksets[i])
  }
  const updateEncoder = new YEncoder()
  writeBlockSet(updateEncoder, mergedBlockset)
  const dss = updateDecoders.map(decoder => readIdSet(decoder))
  const ds = mergeIdSets(dss)
  writeIdSet(updateEncoder, ds)
  return updateEncoder.toUint8Array()
}

/**
 * @param {Array<Uint8Array<ArrayBuffer>>} updates
 * @return {Uint8Array<ArrayBuffer>}
 */
export const mergeUpdates = updates => mergeUpdatesV2(updates, UpdateDecoderV1, UpdateEncoderV1)

/**
 * @deprecated
 * @param {Uint8Array} update
 * @param {Uint8Array} sv
 * @param {typeof UpdateDecoderV1 | typeof UpdateDecoderV2} [YDecoder]
 * @param {typeof UpdateEncoderV1 | typeof UpdateEncoderV2} [YEncoder]
 */
export const diffUpdateV2 = (update, sv, YDecoder = UpdateDecoderV2, YEncoder = UpdateEncoderV2) => {
  const state = decodeStateVector(sv)
  const encoder = new YEncoder()
  const lazyStructWriter = new LazyStructWriter(encoder)
  const decoder = new YDecoder(decoding.createDecoder(update))
  const reader = new LazyStructReader(decoder, false)
  while (reader.curr) {
    const curr = reader.curr
    const currClient = curr.id.client
    const svClock = state.get(currClient) || 0
    if (reader.curr.constructor === Skip) {
      // the first written struct shouldn't be a skip
      reader.next()
      continue
    }
    if (curr.id.clock + curr.length > svClock) {
      writeStructToLazyStructWriter(lazyStructWriter, curr, math.max(svClock - curr.id.clock, 0), 0)
      reader.next()
      while (reader.curr && reader.curr.id.client === currClient) {
        writeStructToLazyStructWriter(lazyStructWriter, reader.curr, 0, 0)
        reader.next()
      }
    } else {
      // read until something new comes up
      while (reader.curr && reader.curr.id.client === currClient && reader.curr.id.clock + reader.curr.length <= svClock) {
        reader.next()
      }
    }
  }
  finishLazyStructWriting(lazyStructWriter)
  // write ds
  const ds = readIdSet(decoder)
  writeIdSet(encoder, ds)
  return encoder.toUint8Array()
}

/**
 * @deprecated
 * @todo remove this in favor of intersectupdate
 *
 * @param {Uint8Array<ArrayBuffer>} update
 * @param {Uint8Array<ArrayBuffer>} sv
 */
export const diffUpdate = (update, sv) => diffUpdateV2(update, sv, UpdateDecoderV1, UpdateEncoderV1)

/**
 * Read decodedState and return State as Map.
 *
 * @param {Uint8Array} decodedState
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
// export const decodeStateVectorV2 = decodedState => readStateVector(new DSDecoderV2(decoding.createDecoder(decodedState)))

/**
 * Read decodedState and return State as Map.
 *
 * @param {Uint8Array} decodedState
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
export const decodeStateVector = decodedState => readStateVector(new IdSetDecoderV1(decoding.createDecoder(decodedState)))

/**
 * @param {IdSetEncoderV1 | IdSetEncoderV2} encoder
 * @param {Map<number,number>} sv
 * @function
 */
export const writeStateVector = (encoder, sv) => {
  encoding.writeVarUint(encoder.restEncoder, sv.size)
  array.from(sv.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, clock]) => {
    encoding.writeVarUint(encoder.restEncoder, client) // @todo use a special client decoder that is based on mapping
    encoding.writeVarUint(encoder.restEncoder, clock)
  })
  return encoder
}

/**
 * @param {IdSetEncoderV1 | IdSetEncoderV2} encoder
 * @param {Doc} doc
 *
 * @function
 */
export const writeDocumentStateVector = (encoder, doc) => writeStateVector(encoder, getStateVector(doc.store))

/**
 * Encode State as Uint8Array.
 *
 * @param {Doc|Map<number,number>} doc
 * @param {IdSetEncoderV1 | IdSetEncoderV2} [encoder]
 * @return {Uint8Array<ArrayBuffer>}
 *
 * @function
 */
export const encodeStateVectorV2 = (doc, encoder = new IdSetEncoderV2()) => {
  if (doc instanceof Map) {
    writeStateVector(encoder, doc)
  } else {
    writeDocumentStateVector(encoder, doc)
  }
  return encoder.toUint8Array()
}

/**
 * Encode State as Uint8Array.
 *
 * @param {Doc|Map<number,number>} doc
 * @return {Uint8Array<ArrayBuffer>}
 *
 * @function
 */
export const encodeStateVector = doc => encodeStateVectorV2(doc, new IdSetEncoderV1())

/**
 * Return the creator clientID of the missing op or define missing items and return null.
 *
 * @param {Item|CausalHole} struct
 * @param {Transaction} transaction
 * @param {StructStore} store
 * @param {ReturnType<typeof createSparseIntegrationPlan>} sparsePlan
 * @param {Map<Item,YType>|null} [preparedStringRootParents]
 * @return {null | number}
 */
const getMissing = (struct, transaction, store, sparsePlan, preparedStringRootParents = null) => {
  if (struct.constructor !== Item && struct.constructor !== CausalHole) return null
  // we may not access these variables anymore after they have been written!
  const origin = struct.origin
  const rightOrigin = struct.rightOrigin
  const parent = struct.parent
  const structuralParentDependency = sparsePlan?.getStructuralParentDependency(struct) ?? null
  if (structuralParentDependency !== null) {
    const installedParent = store.getStruct(structuralParentDependency.id)
    if (installedParent?.constructor !== Item || !(/** @type {Item} */ (installedParent).content instanceof ContentType)) {
      return structuralParentDependency.id.client
    }
  }
  if (origin && (origin.clock >= store.getClock(origin.client) || store.skips.hasId(origin))) {
    return origin.client
  }
  if (rightOrigin && (rightOrigin.clock >= store.getClock(rightOrigin.client) || store.skips.hasId(rightOrigin))) {
    return rightOrigin.client
  }
  if (parent && parent.constructor === ID && (parent.clock >= store.getClock(parent.client) || store.skips.hasId(parent))) {
    return parent.client
  }
  if (struct.constructor === CausalHole) return null
  const item = /** @type {Item} */ (struct)
  // We have all missing ids, now find the items
  const originHole = origin === null ? null : store.getCausalHole(origin)
  const rightOriginHole = rightOrigin === null ? null : store.getCausalHole(rightOrigin)
  const replacesHole = store.causalHoles.intersects(item.id.client, item.id.clock, item.length)
  if (origin) {
    if (originHole === null) {
      item.left = getItemCleanEnd(transaction, store, origin)
      // copy left id to so that the original id can be gc'd
      item.origin = item.left.lastId
    }
  }
  if (rightOrigin) {
    if (rightOriginHole === null) {
      item.right = getItemCleanStart(transaction, rightOrigin)
      item.rightOrigin = item.right.id
    }
  }
  if ((item.left && item.left.constructor === GC) || (item.right && item.right.constructor === GC)) {
    item.parent = null
  } else if (originHole !== null || rightOriginHole !== null) {
    const hole = /** @type {CausalHole} */ (originHole ?? rightOriginHole)
    if (typeof hole.parent === 'string') {
      if (preparedStringRootParents === null) {
        item.parent = transaction.doc.get(hole.parent)
      } else {
        item.parent = readPreparedStringRootParent(preparedStringRootParents, item)
      }
    } else {
      item.parent = resolveCausalHoleParent(transaction, store, hole)
    }
    item.parentSub = hole.parentSub
  } else if (parent == null) {
    // only set parent if this shouldn't be garbage collected
    if (item.left && item.left.constructor === Item) {
      item.parent = item.left.parent
      item.parentSub = item.left.parentSub
    } else if (item.right && item.right.constructor === Item) {
      item.parent = item.right.parent
      item.parentSub = item.right.parentSub
    }
  } else if (parent.constructor === ID) {
    const parentItem = store.getStruct(parent)
    if (
      parentItem === null || parentItem.constructor === GC ||
      (parentItem.constructor === Item && !(/** @type {Item} */ (parentItem).content instanceof ContentType))
    ) {
      item.parent = null
    } else {
      item.parent = /** @type {ContentType} */ (/** @type {Item} */ (parentItem).content).type
    }
  } else if (typeof parent === 'string') {
    if (preparedStringRootParents === null) {
      item.parent = transaction.doc.get(parent)
    } else {
      item.parent = readPreparedStringRootParent(preparedStringRootParents, item)
    }
  }
  const bounds = sparsePlan?.getBounds(item, transaction) ?? null
  if (bounds !== null) {
    item.left = bounds.left
    item.right = bounds.right
  } else if (
    (originHole !== null || rightOriginHole !== null || replacesHole) &&
    item.parent !== null && typeof item.parent !== 'string' && item.parent.constructor !== ID
  ) {
    throw new Error(`Missing sparse integration plan for ${item.id.client}:${item.id.clock} (${sparsePlan === null ? 'absent' : 'unmapped'})`)
  }
  return null
}

/** @param {YType} parent @param {string|null} parentSub */
const getParentListStart = (parent, parentSub) => {
  if (parentSub === null) return parent._start
  let item = parent._map.get(parentSub) ?? null
  while (item !== null && item.left !== null) item = item.left
  return item
}

/**
 * @param {Transaction} transaction
 * @param {StructStore} store
 * @param {CausalHole} hole
 * @return {YType}
 */
const resolveCausalHoleParent = (transaction, store, hole) => {
  if (typeof hole.parent === 'string') return transaction.doc.get(hole.parent)
  if (store.getCausalHole(hole.parent) !== null) throw new Error('Causal hole parent is not materialized')
  const parentItem = store.getItem(hole.parent)
  if (parentItem.constructor !== Item || !(parentItem.content instanceof ContentType)) throw new Error('Causal hole parent is not a materialized type')
  return parentItem.content.type
}

/**
 * @param {Uint8Array} update
 * @param {import('./Doc.js').DocOpts} opts
 */
export const createDocFromUpdate = (update, opts = {}) => {
  const ydoc = new Doc(opts)
  applyUpdate(ydoc, update)
  return ydoc
}

/**
 * @param {Uint8Array} update
 * @param {import('./Doc.js').DocOpts} opts
 */
export const createDocFromUpdateV2 = (update, opts = {}) => {
  const ydoc = new Doc(opts)
  applyUpdateV2(ydoc, update)
  return ydoc
}

/**
 * @param {Doc} ydoc
 * @param {import('./Doc.js').DocOpts} [opts]
 */
export const cloneDoc = (ydoc, opts) => {
  const normalized = normalizeDocOptions(opts === undefined ? {} : opts)
  if (ydoc.sparseExactResolution && !normalized.sparseExactResolution) {
    throw new Error('Cloning a sparse exact-resolution document requires gc:false and sparseExactResolution:true')
  }
  const clone = new Doc(normalized.opts)
  applyUpdate(clone, encodeStateAsUpdate(ydoc))
  return clone
}
