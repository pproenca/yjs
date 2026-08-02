import * as encoding from 'lib0/encoding'
import * as math from 'lib0/math'
import * as array from 'lib0/array'

import { findIndexSS } from './transaction-helpers.js'
import { Skip } from '../structs/Skip.js'
import { Item } from '../structs/Item.js'
import { CausalHole, CausalHoleIndex, createCausalHoleFromItem, getTransactionCausalHoles, sameCausalHoleMetadata } from '../structs/CausalHole.js'
import { createID } from './ID.js'
import { createIdSet, intersectSets, mergeIdSets, writeIdSet } from './ids.js'

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Array<GC|Item|Skip|CausalHole>} structs All structs by `client`
 * @param {number} client
 * @param {Array<IdRange>} idranges
 *
 * @function
 */
export const writeStructs = (encoder, structs, client, idranges) => {
  let structsToWrite = 0 // this accounts for the skips
  /**
   * @type {Array<{ start: number, end: number, startClock: number, endClock: number }>}
   */
  const indexRanges = []
  const firstPossibleClock = structs[0].id.clock
  const lastStruct = array.last(structs)
  const lastPossibleClock = lastStruct.id.clock + lastStruct.length
  idranges.forEach(idrange => {
    const startClock = math.max(idrange.clock, firstPossibleClock)
    const endClock = math.min(idrange.clock + idrange.len, lastPossibleClock)
    if (startClock >= endClock) return // structs for this range do not exist
    // inclusive start
    const start = findIndexSS(/** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ (structs)), startClock)
    // exclusive end
    const end = findIndexSS(/** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ (structs)), endClock - 1) + 1
    structsToWrite += end - start
    indexRanges.push({
      start,
      end,
      startClock,
      endClock
    })
  })
  structsToWrite += idranges.length - 1
  // start writing with this clock. this is updated to the next clock that we expect to write
  let clock = indexRanges[0].startClock
  // write # encoded structs
  encoding.writeVarUint(encoder.restEncoder, structsToWrite)
  encoder.writeClient(client)
  // write clock
  encoding.writeVarUint(encoder.restEncoder, clock)
  indexRanges.forEach(indexRange => {
    const skipLen = indexRange.startClock - clock
    if (skipLen > 0) {
      new Skip(createID(client, clock), skipLen).write(encoder, 0)
      clock += skipLen
    }
    for (let i = indexRange.start; i < indexRange.end; i++) {
      const struct = structs[i]
      const structEnd = struct.id.clock + struct.length
      const offsetEnd = math.max(structEnd - indexRange.endClock, 0)
      struct.write(encoder, clock - struct.id.clock, offsetEnd)
      clock = structEnd - offsetEnd
    }
  })
}

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {StructStore} store
 * @param {IdSet} idset
 *
 * @todo at the moment this writes the full deleteset range
 *
 * @private
 * @function
 */
export const writeStructsFromIdSet = (encoder, store, idset) => {
  // write # states that were updated
  encoding.writeVarUint(encoder.restEncoder, idset.clients.size)
  // Write items with higher client ids first
  // This heavily improves the conflict algorithm.
  array.from(idset.clients.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, ids]) => {
    const idRanges = ids.getIds()
    const structs = /** @type {Array<GC|Item|Skip|CausalHole>} */ (/** @type {unknown} */ (store.clients.get(client)))
    writeStructs(encoder, structs, client, idRanges)
  })
}

/**
 * Write selected semantic structs plus metadata-only causal coverage for unavailable anchors.
 *
 * @param {UpdateEncoderV1|UpdateEncoderV2} encoder
 * @param {StructStore} sourceStore
 * @param {IdSet} selected
 * @param {Array<StructStore>} knownStores
 */
export const writeStructsFromIdSetWithCausalHoles = (encoder, sourceStore, selected, knownStores) => {
  const holes = collectCausalHoles(sourceStore, selected, knownStores, true)
  writeSparseSelection(encoder, sourceStore, selected, holes)
}

/**
 * Preserve an already-present causal envelope without synthesizing omitted real payload metadata.
 *
 * @param {UpdateEncoderV1|UpdateEncoderV2} encoder
 * @param {StructStore} sourceStore
 * @param {IdSet} selected
 */
export const writeStructsFromIdSetWithExistingCausalHoles = (encoder, sourceStore, selected) => {
  const holes = collectCausalHoles(sourceStore, selected, [], false)
  writeSparseSelection(encoder, sourceStore, selected, holes)
}

/**
 * @param {StructStore} sourceStore
 * @param {IdSet} selected
 * @param {Array<StructStore>} knownStores
 * @param {boolean} synthesize
 */
const collectCausalHoles = (sourceStore, selected, knownStores, synthesize) => {
  const holes = new CausalHoleIndex()
  /** @type {IdSet|null} */
  let known = null
  for (const store of knownStores) {
    const materialized = createIdSet()
    store.clients.forEach((structs, client) => {
      for (const struct of structs) {
        if (struct.constructor === Item) materialized.add(client, struct.id.clock, struct.length)
      }
    })
    known = known === null ? materialized : intersectSets(known, materialized)
  }
  const available = mergeIdSets(known === null ? [selected] : [selected, known])
  /** @param {ID} id */
  const isKnown = id => known?.hasId(id) ?? false
  /** @param {ID} id */
  const isSourceMaterialized = id => id.clock < sourceStore.getClock(id.client) &&
    !sourceStore.skips.hasId(id) && !sourceStore.causalHoles.hasId(id) && sourceStore.getStruct(id)?.constructor === Item
  /**
   * @param {ID|string} parent
   */
  const requireParent = parent => {
    if (typeof parent === 'string' || selected.hasId(parent) || isKnown(parent) || (!synthesize && isSourceMaterialized(parent))) return
    throw new Error('Selected content has an unavailable structural parent')
  }
  /** @type {Array<ID>} */
  const pending = []
  const processed = new Set()
  /** @param {ID|null} id */
  const queueAnchor = id => {
    if (id !== null && !available.hasId(id)) pending.push(id)
  }
  selected.forEach((range, client) => {
    const structs = sourceStore.clients.get(client)
    if (structs === undefined) throw new Error('Selected content is missing')
    let index = findIndexSS(structs, range.clock)
    const end = range.clock + range.len
    let clock = range.clock
    while (clock < end) {
      const struct = structs[index++]
      if (struct === undefined || struct.id.clock > clock || struct.constructor !== Item) {
        throw new Error('Selected content is not materialized')
      }
      const sliceEnd = Math.min(end, struct.id.clock + struct.length)
      const metadata = createCausalHoleFromItem(/** @type {Item} */ (struct), clock, sliceEnd - clock)
      requireParent(metadata.parent)
      queueAnchor(metadata.origin)
      queueAnchor(metadata.rightOrigin)
      clock = sliceEnd
    }
  })
  while (pending.length > 0) {
    const id = /** @type {ID} */ (pending.pop())
    const key = `${id.client}:${id.clock}`
    if (processed.has(key) || available.hasId(id)) continue
    processed.add(key)
    const source = sourceStore.getStruct(id)
    if (!synthesize && (source === null || source.constructor === Skip || source.constructor !== CausalHole)) continue
    if (source === null || source.constructor === Skip || (source.constructor !== Item && source.constructor !== CausalHole)) {
      throw new Error('Missing causal anchor')
    }
    const segment = available.slice(source.id.client, source.id.clock, source.length)
      .find(slice => !slice.exists && slice.clock <= id.clock && id.clock < slice.clock + slice.len)
    if (segment === undefined) continue
    const hole = source.constructor === CausalHole
      ? /** @type {CausalHole} */ (source).slice(segment.clock, segment.len)
      : createCausalHoleFromItem(/** @type {Item} */ (source), segment.clock, segment.len)
    holes.add(hole)
    requireParent(hole.parent)
    queueAnchor(hole.origin)
    queueAnchor(hole.rightOrigin)
  }
  assertAcyclicCausalHoles(holes)
  return holes
}

/** @param {CausalHoleIndex} holes */
const assertAcyclicCausalHoles = holes => {
  /** @type {Map<CausalHole,0|1|2>} */
  const colors = new Map()
  for (const root of holes.values()) {
    if (colors.get(root) === 2) continue
    /** @type {Array<{hole:CausalHole,next:number}>} */
    const stack = [{ hole: root, next: 0 }]
    colors.set(root, 1)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const anchors = [frame.hole.origin, frame.hole.rightOrigin]
      if (frame.next >= anchors.length) {
        colors.set(frame.hole, 2)
        stack.pop()
        continue
      }
      const anchor = anchors[frame.next++]
      if (anchor === null) continue
      const dependency = holes.get(anchor)
      if (dependency === null) continue
      const color = colors.get(dependency) ?? 0
      if (color === 1) throw new Error('Cyclic causal hole metadata')
      if (color === 0) {
        colors.set(dependency, 1)
        stack.push({ hole: dependency, next: 0 })
      }
    }
  }
}

/**
 * @param {UpdateEncoderV1|UpdateEncoderV2} encoder
 * @param {StructStore} sourceStore
 * @param {IdSet} selected
 * @param {CausalHoleIndex} holes
 */
const writeSparseSelection = (encoder, sourceStore, selected, holes) => {
  /** @type {Map<number,Array<{struct:Item|CausalHole,start:number,end:number}>>} */
  const blocks = new Map()
  /**
   * @param {Item|CausalHole} struct
   * @param {number} start
   * @param {number} end
   */
  const add = (struct, start, end) => {
    let clientBlocks = blocks.get(struct.id.client)
    if (clientBlocks === undefined) {
      clientBlocks = []
      blocks.set(struct.id.client, clientBlocks)
    }
    clientBlocks.push({ struct, start, end })
  }
  selected.forEach((range, client) => {
    const structs = /** @type {Array<GC|Item|Skip|CausalHole>} */ (/** @type {unknown} */ (sourceStore.clients.get(client)))
    let index = findIndexSS(/** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ (structs)), range.clock)
    const end = range.clock + range.len
    let clock = range.clock
    while (clock < end) {
      const struct = structs[index++]
      if (struct === undefined || struct.constructor !== Item || struct.id.clock > clock) throw new Error('Selected content is not materialized')
      const sliceEnd = Math.min(end, struct.id.clock + struct.length)
      add(/** @type {Item} */ (struct), clock, sliceEnd)
      clock = sliceEnd
    }
  })
  holes.forEach(hole => add(hole, hole.id.clock, hole.id.clock + hole.length))
  encoding.writeVarUint(encoder.restEncoder, blocks.size)
  array.from(blocks.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, unsortedBlocks]) => {
    const clientBlocks = unsortedBlocks.sort((a, b) => a.start - b.start).reduce((result, block) => {
      const previous = result[result.length - 1]
      if (
        previous !== undefined && previous.end === block.start &&
        previous.struct.constructor === CausalHole && block.struct.constructor === CausalHole &&
        /** @type {CausalHole} */ (previous.struct).mergeWith(/** @type {CausalHole} */ (block.struct))
      ) {
        previous.end = block.end
      } else {
        result.push(block)
      }
      return result
    }, /** @type {Array<{struct:Item|CausalHole,start:number,end:number}>} */ ([]))
    let count = clientBlocks.length
    let clock = clientBlocks[0].start
    for (let i = 1; i < clientBlocks.length; i++) {
      if (clientBlocks[i].start > clientBlocks[i - 1].end) count++
    }
    encoding.writeVarUint(encoder.restEncoder, count)
    encoder.writeClient(client)
    encoding.writeVarUint(encoder.restEncoder, clock)
    for (const block of clientBlocks) {
      if (block.start > clock) {
        new Skip(createID(client, clock), block.start - clock).write(encoder, 0)
        clock = block.start
      }
      block.struct.write(encoder, block.start - block.struct.id.clock, block.struct.id.clock + block.struct.length - block.end)
      clock = block.end
    }
  })
}

/**
 * @param {StructStore} store
 * @param {Transaction} transaction
 * @param {CausalHoleIndex} holes
 */
const addTransactionCausalHoles = (store, transaction, holes) => {
  const installed = getTransactionCausalHoles(transaction)
  if (installed === null) return
  installed.forEach(recorded => {
    for (const current of store.getCausalHoleOverlaps(recorded.id.client, recorded.id.clock, recorded.length)) {
      const clock = Math.max(recorded.id.clock, current.id.clock)
      const end = Math.min(recorded.id.clock + recorded.length, current.id.clock + current.length)
      if (clock >= end) continue
      const actual = current.slice(clock, end - clock)
      if (sameCausalHoleMetadata(recorded.slice(clock, end - clock), actual)) holes.add(actual)
    }
  })
}

/** @param {StructStore} store @param {Transaction} transaction */
const hasTransactionCausalHoles = (store, transaction) => {
  const holes = new CausalHoleIndex()
  addTransactionCausalHoles(store, transaction, holes)
  return holes.size > 0
}

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Transaction} transaction
 *
 * @private
 * @function
 */
export const writeStructsFromTransaction = (encoder, transaction) => {
  const store = transaction.doc.store
  const holes = store.causalHoles.clients.size === 0
    ? new CausalHoleIndex()
    : collectCausalHoles(store, transaction.insertSet, [], false)
  addTransactionCausalHoles(store, transaction, holes)
  if (holes.size === 0) {
    writeStructsFromIdSet(encoder, store, transaction.insertSet)
  } else {
    writeSparseSelection(encoder, store, transaction.insertSet, holes)
  }
}

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Transaction} transaction
 * @return {boolean} Whether data was written.
 */
export const writeUpdateMessageFromTransaction = (encoder, transaction) => {
  if (
    transaction.deleteSet.clients.size === 0 &&
    transaction.insertSet.clients.size === 0 &&
    !hasTransactionCausalHoles(transaction.doc.store, transaction)
  ) {
    return false
  }
  writeStructsFromTransaction(encoder, transaction)
  writeIdSet(encoder, transaction.deleteSet)
  return true
}
