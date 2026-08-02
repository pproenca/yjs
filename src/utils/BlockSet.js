import * as decoding from 'lib0/decoding'
import * as binary from 'lib0/binary'
import * as map from 'lib0/map'
import * as array from 'lib0/array'
import * as math from 'lib0/math'
import * as encoding from 'lib0/encoding'
import * as number from 'lib0/number'

import { createID, ID } from './ID.js'
import { Item } from '../structs/Item.js'
import { readItemContent } from '../ytype.js'
import { findIndexCleanStart } from './transaction-helpers.js'
import { Skip } from '../structs/Skip.js'
import { createIdSet, IdRange } from './ids.js'
import { sliceStruct } from './updates.js'
import { GC } from '../structs/GC.js'
import { CausalHole, normalizeCausalHoleParent, sameCausalHoleItemMetadata, sameCausalHoleMetadata, sameCausalHoleParent } from '../structs/CausalHole.js'
import { TerminalCausalHole } from '../structs/TerminalCausalHole.js'
import { writeStructs } from './encoding-helpers.js'

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder The decoder object to read data from.
 * @return {BlockSet}
 *
 * @private
 * @function
 */
export const readBlockSet = (decoder) => {
  const clientRefs = new BlockSet()
  const numOfStateUpdates = decoding.readVarUint(decoder.restDecoder)
  for (let i = 0; i < numOfStateUpdates; i++) {
    const numberOfBlocks = decoding.readVarUint(decoder.restDecoder)
    /**
     * @type {Array<GC|Item|Skip|CausalHole|TerminalCausalHole>}
     */
    const refs = new Array(numberOfBlocks)
    const client = decoder.readClient()
    let clock = decoding.readVarUint(decoder.restDecoder)
    clientRefs.clients.set(client, new BlockRange(refs))
    for (let i = 0; i < numberOfBlocks; i++) {
      const info = decoder.readInfo()
      switch (binary.BITS5 & info) {
        case 0: { // GC
          const len = decoder.readLen()
          refs[i] = new GC(createID(client, clock), len)
          clock += len
          break
        }
        case 10: { // Skip Block (nothing to apply)
          // @todo we could reduce the amount of checks by adding Skip block to clientRefs so we know that something is missing.
          const len = decoding.readVarUint(decoder.restDecoder)
          refs[i] = new Skip(createID(client, clock), len)
          clock += len
          break
        }
        case 11: {
          const len = decoding.readVarUint(decoder.restDecoder)
          refs[i] = new CausalHole(
            createID(client, clock),
            len,
            (info & binary.BIT8) === binary.BIT8 ? decoder.readLeftID() : null,
            (info & binary.BIT7) === binary.BIT7 ? decoder.readRightID() : null,
            decoder.readParentInfo() ? decoder.readString() : decoder.readLeftID(),
            (info & binary.BIT6) === binary.BIT6 ? decoder.readString() : null
          )
          clock += len
          break
        }
        case 12: {
          const len = decoding.readVarUint(decoder.restDecoder)
          refs[i] = new TerminalCausalHole(
            createID(client, clock),
            len,
            (info & binary.BIT8) === binary.BIT8 ? decoder.readLeftID() : null,
            (info & binary.BIT7) === binary.BIT7 ? decoder.readRightID() : null,
            decoder.readParentInfo() ? decoder.readString() : decoder.readLeftID(),
            (info & binary.BIT6) === binary.BIT6 ? decoder.readString() : null
          )
          clock += len
          break
        }
        default: { // Item with content
          /**
           * The optimized implementation doesn't use any variables because inlining variables is faster.
           * Below a non-optimized version is shown that implements the basic algorithm with
           * a few comments
           */
          const cantCopyParentInfo = (info & (binary.BIT7 | binary.BIT8)) === 0
          // If parent = null and neither left nor right are defined, then we know that `parent` is child of `y`
          // and we read the next string as parentYKey.
          // It indicates how we store/retrieve parent from `y.share`
          // @type {string|null}
          const block = new Item(
            createID(client, clock),
            null, // left
            (info & binary.BIT8) === binary.BIT8 ? decoder.readLeftID() : null, // origin
            null, // right
            (info & binary.BIT7) === binary.BIT7 ? decoder.readRightID() : null, // right origin
            cantCopyParentInfo ? (decoder.readParentInfo() ? decoder.readString() : decoder.readLeftID()) : null, // parent
            cantCopyParentInfo && (info & binary.BIT6) === binary.BIT6 ? decoder.readString() : null, // parentSub
            readItemContent(decoder, info) // item content
          )
          refs[i] = block
          clock += block.length
        }
      }
    }
  }
  return clientRefs
}

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {BlockSet} blocks
 */
export const writeBlockSet = (encoder, blocks) => {
  // write # states that were updated
  encoding.writeVarUint(encoder.restEncoder, blocks.clients.size)
  // Write items with higher client ids first
  // This heavily improves the conflict algorithm.
  array.from(blocks.clients.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, blockrange]) => {
    writeStructs(encoder, blockrange.refs, client, [new IdRange(0, number.MAX_SAFE_INTEGER)])
  })
}

class BlockRange {
  /**
   * @param {Array<Item|GC|Skip|CausalHole|TerminalCausalHole>} refs
   */
  constructor (refs) {
    this.i = 0
    /**
     * @type {Array<Item | GC | Skip | CausalHole | TerminalCausalHole>}
     */
    this.refs = refs
  }
}

export class BlockSet {
  constructor () {
    /**
     * @type {Map<number, BlockRange>}
     */
    this.clients = map.create()
  }

  toIdSet () {
    const inserts = createIdSet()
    this.clients.forEach((ranges, clientid) => {
      let lastClock = 0
      let lastLen = 0
      ranges.refs.forEach(block => {
        if (block instanceof Skip || block instanceof CausalHole || block instanceof TerminalCausalHole) return
        if (lastClock + lastLen === block.id.clock) {
          // default case: extend prev entry
          lastLen += block.length
        } else {
          lastLen > 0 && inserts.add(clientid, lastClock, lastLen)
          lastClock = block.id.clock
          lastLen = block.length
        }
      })
      inserts.add(clientid, lastClock, lastLen)
    })
    return inserts
  }

  /**
   * Remove id-ranges from update - convert them to skip if applicable.
   *
   * @param {IdSet} exclude
   */
  exclude (exclude) {
    const clientids = this.clients.size < exclude.clients.size ? this.clients.keys() : exclude.clients.keys()
    for (const client of clientids) {
      const range = exclude.clients.get(client)
      const structs = this.clients.get(client)?.refs
      if (range == null || structs == null) return
      const firstStruct = structs[0]
      const lastStruct = structs[structs.length - 1]
      const idranges = range.getIds()
      for (let i = 0; i < idranges.length; i++) {
        const range = idranges[i]
        let startIndex = 0
        if (range.clock >= lastStruct.id.clock + lastStruct.length) continue
        if (range.clock > firstStruct.id.clock) {
          startIndex = findIndexCleanStart(null, /** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ (structs)), range.clock)
        }
        let endIndex = structs.length // must be set here, after structs is modified
        if (range.clock + range.len <= firstStruct.id.clock) continue
        if (range.clock + range.len < lastStruct.id.clock + lastStruct.length) {
          endIndex = findIndexCleanStart(null, /** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ (structs)), range.clock + range.len)
        }
        if (startIndex < endIndex) {
          structs[startIndex] = new Skip(new ID(client, range.clock), range.len)
          const d = endIndex - startIndex
          if (d > 1) {
            structs.splice(startIndex + 1, d - 1)
          }
        }
      }
    }
  }

  /**
   * @param {BlockSet} inserts
   */
  insertInto (inserts) {
    /** @param {ID} id */
    const resolveMergeInput = id => dominantBlock(
      findBlockAt(this.clients.get(id.client)?.refs, id.clock),
      findBlockAt(inserts.clients.get(id.client)?.refs, id.clock)
    )
    inserts.clients.forEach((newranges, clientid) => {
      const ranges = this.clients.get(clientid)
      if (ranges == null) {
        this.clients.set(clientid, newranges)
      } else {
        if (
          ranges.refs.some(block => block.constructor === CausalHole || block.constructor === TerminalCausalHole) ||
          newranges.refs.some(block => block.constructor === CausalHole || block.constructor === TerminalCausalHole)
        ) {
          ranges.refs = mergeSparseRefs(ranges.refs, newranges.refs, resolveMergeInput)
          return
        }
        const localIsLeft = ranges.refs[0].id.clock < newranges.refs[0].id.clock
        const leftRanges = /** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ ((localIsLeft ? ranges : newranges).refs))
        const rightRanges = /** @type {Array<GC|Item|Skip>} */ (/** @type {unknown} */ ((localIsLeft ? newranges : ranges).refs))
        const lastBlockLeft = array.last(leftRanges)
        const firstBlockRight = rightRanges[0]
        const gapSize = firstBlockRight.id.clock - lastBlockLeft.id.clock - lastBlockLeft.length
        if (gapSize >= 0) {
          // we can do a simple efficient merge
          if (gapSize > 0) {
            leftRanges.push(new Skip(new ID(clientid, lastBlockLeft.id.clock + lastBlockLeft.length), gapSize))
          }
          for (let i = 0; i < rightRanges.length; i++) {
            leftRanges.push(rightRanges[i])
          }
          ranges.refs = leftRanges
        } else {
          // requires more computation because we need to filter duplicates
          /**
           * @type {Array<GC|Item|Skip>}
           */
          const result = []
          let nextExpectedClock = leftRanges[0].id.clock
          /**
           * @param {Item|GC|Skip} block
           */
          const addToResult = block => {
            result.push(block)
            nextExpectedClock = block.id.clock + block.length
          }
          let li = 0
          let ri = 0
          /**
           * @type {Item|GC|Skip|undefined}
           */
          let lblock = leftRanges[li]
          /**
           * @type {Item|GC|Skip|undefined}
           */
          let rblock = rightRanges[ri]
          const applyLeft = () => {
            if (lblock === undefined) return
            // first try to consume left
            // left: filter skips and known ops
            while (lblock !== undefined && (lblock.constructor === Skip || lblock.id.clock + lblock.length <= nextExpectedClock)) {
              lblock = leftRanges[++li]
            }
            // left: trim first op
            if (lblock !== undefined && lblock.id.clock < nextExpectedClock && lblock.id.clock + lblock.length > nextExpectedClock) {
              lblock = /** @type {GC|Item|Skip} */ (sliceStruct(lblock, lblock.id.clock + lblock.length - nextExpectedClock))
            }
            // left: add to result
            while (lblock !== undefined && lblock.id.clock === nextExpectedClock && lblock.constructor !== Skip) {
              addToResult(lblock)
              lblock = leftRanges[++li]
            }
          }
          const applyRight = () => {
            // right: filter skips and known ops
            while (rblock !== undefined && (rblock.constructor === Skip || rblock.id.clock + rblock.length <= nextExpectedClock)) {
              rblock = rightRanges[++ri]
            }
            // right: trim first op
            if (rblock !== undefined && rblock.id.clock < nextExpectedClock && rblock.id.clock + rblock.length > nextExpectedClock) {
              rblock = /** @type {GC|Item|Skip} */ (sliceStruct(rblock, rblock.id.clock + rblock.length - nextExpectedClock))
            }
            // right: add to result
            while (rblock !== undefined && rblock.id.clock === nextExpectedClock && rblock.constructor !== Skip) {
              addToResult(rblock)
              rblock = rightRanges[++ri]
            }
          }
          for (; li < leftRanges.length && ri < rightRanges.length;) {
            applyLeft()
            applyRight()
            // add skip if necessary
            const minNextClock = math.min(lblock?.id.clock || 0, rblock?.id.clock || 0)
            const gapSize = minNextClock - nextExpectedClock
            if (gapSize > 0) {
              addToResult(new Skip(new ID(clientid, nextExpectedClock), gapSize))
            }
          }
          while (li < leftRanges.length) {
            applyLeft()
            if (lblock !== undefined) {
              const gapSize = lblock.id.clock - nextExpectedClock
              if (gapSize > 0) {
                addToResult(new Skip(new ID(clientid, nextExpectedClock), gapSize))
              }
            }
          }
          while (ri < rightRanges.length) {
            applyRight()
            if (rblock !== undefined) {
              const gapSize = rblock.id.clock - nextExpectedClock
              if (gapSize > 0) {
                addToResult(new Skip(new ID(clientid, nextExpectedClock), gapSize))
              }
            }
          }
          ranges.refs = result
        }
      }
    })
    inserts.clients.clear()
  }
}

/**
 * @param {Item|GC|Skip|CausalHole|TerminalCausalHole} block
 * @param {number} clock
 * @param {number} length
 * @return {Item|GC|Skip|CausalHole|TerminalCausalHole}
 */
const sliceBlock = (block, clock, length) => {
  if (block.constructor === Skip) return new Skip(createID(block.id.client, clock), length)
  if (block.constructor === CausalHole) return /** @type {CausalHole} */ (block).slice(clock, length)
  if (block.constructor === TerminalCausalHole) return /** @type {TerminalCausalHole} */ (block).slice(clock, length)
  if (block.constructor === GC) return new GC(createID(block.id.client, clock), length)
  const item = /** @type {Item} */ (block)
  if (clock === item.id.clock && length === item.length) return item
  const offset = clock - item.id.clock
  let content = item.content.copy()
  if (offset > 0) content = content.splice(offset)
  if (length < content.getLength()) content.splice(length)
  return new Item(
    createID(item.id.client, clock),
    null,
    offset === 0 ? item.origin : createID(item.id.client, clock - 1),
    null,
    item.rightOrigin,
    item.parent,
    item.parentSub,
    content
  )
}

/** @param {Item|GC|Skip|CausalHole|TerminalCausalHole|null} block */
const blockRank = block => {
  if (block === null || block.constructor === Skip) return 0
  if (block.constructor === CausalHole) return 1
  if (block.constructor === Item) return 2
  if (block.constructor === GC) return 3
  return 4
}

/**
 * @param {Item|GC|Skip|CausalHole|TerminalCausalHole|null} left
 * @param {Item|GC|Skip|CausalHole|TerminalCausalHole|null} right
 */
const dominantBlock = (left, right) => {
  if (left?.constructor === TerminalCausalHole || right?.constructor === TerminalCausalHole) {
    return left?.constructor === TerminalCausalHole ? left : right
  }
  if (left?.constructor === GC || right?.constructor === GC) return left?.constructor === GC ? left : right
  if (left?.constructor === Item || right?.constructor === Item) return left?.constructor === Item ? left : right
  if (left?.constructor === CausalHole || right?.constructor === CausalHole) return left?.constructor === CausalHole ? left : right
  return left ?? right
}

/**
 * @param {Array<Item|GC|Skip|CausalHole|TerminalCausalHole>|undefined} refs
 * @param {number} clock
 * @return {Item|GC|Skip|CausalHole|TerminalCausalHole|null}
 */
const findBlockAt = (refs, clock) => {
  if (refs === undefined) return null
  let left = 0
  let right = refs.length - 1
  while (left <= right) {
    const middle = (left + right) >>> 1
    const block = refs[middle]
    if (clock < block.id.clock) right = middle - 1
    else if (clock >= block.id.clock + block.length) left = middle + 1
    else return block
  }
  return null
}

/**
 * Infer copied parent metadata only from structs present in the merge inputs. Missing external
 * anchors deliberately fail closed.
 *
 * @param {(id:ID) => Item|GC|Skip|CausalHole|TerminalCausalHole|null} resolveMergeInput
 * @return {(item:Item) => {parent:ID|string,parentSub:string|null}|null}
 */
const createMergeItemParentResolver = resolveMergeInput => {
  /** @typedef {{parent:ID|string,parentSub:string|null}} ParentMetadata */
  /** @type {Map<Item,ParentMetadata|null|false>} */
  const memo = new Map()
  const visiting = new Set()
  /** @param {ParentMetadata} left @param {ParentMetadata} right */
  const sameParent = (left, right) => sameCausalHoleParent(left.parent, right.parent) && left.parentSub === right.parentSub
  /** @param {Item} item @return {ParentMetadata|null} */
  const infer = item => {
    const cached = memo.get(item)
    if (cached === false) throw new Error('Conflicting merge item parent proofs')
    if (cached !== undefined) return cached
    if (item.parent !== null) {
      const explicit = { parent: normalizeCausalHoleParent(item.parent), parentSub: item.parentSub }
      memo.set(item, explicit)
      return explicit
    }
    if (visiting.has(item)) {
      memo.set(item, false)
      throw new Error('Cyclic merge item parent proof')
    }
    visiting.add(item)
    /** @type {ParentMetadata|null} */
    let proof = null
    try {
      for (const anchor of [item.origin, item.rightOrigin]) {
        if (anchor === null) continue
        const source = resolveMergeInput(anchor)
        if (source?.constructor !== Item) continue
        const candidate = infer(/** @type {Item} */ (source))
        if (candidate === null) continue
        if (proof !== null && !sameParent(proof, candidate)) {
          memo.set(item, false)
          throw new Error('Conflicting merge item parent proofs')
        }
        proof = candidate
      }
      memo.set(item, proof)
      return proof
    } catch (error) {
      memo.set(item, false)
      throw error
    } finally {
      visiting.delete(item)
    }
  }
  return infer
}

/**
 * Validate every original sparse overlap before dominance can erase its evidence.
 *
 * @param {Array<Item|GC|Skip|CausalHole|TerminalCausalHole>} left
 * @param {Array<Item|GC|Skip|CausalHole|TerminalCausalHole>} right
 * @param {(item:Item) => {parent:ID|string,parentSub:string|null}|null} inferParent
 */
const validateSparseOverlaps = (left, right, inferParent) => {
  let li = 0
  let ri = 0
  while (li < left.length && ri < right.length) {
    const l = left[li]
    const r = right[ri]
    const start = math.max(l.id.clock, r.id.clock)
    const lend = l.id.clock + l.length
    const rend = r.id.clock + r.length
    const end = math.min(lend, rend)
    if (start < end) {
      const lSparse = l.constructor === CausalHole || l.constructor === TerminalCausalHole
      const rSparse = r.constructor === CausalHole || r.constructor === TerminalCausalHole
      const lTerminal = l.constructor === TerminalCausalHole
      const rTerminal = r.constructor === TerminalCausalHole
      if ((lTerminal && typeof l.parent === 'string') || (rTerminal && typeof r.parent === 'string')) {
        throw new Error('Terminal causal hole cannot target a live root')
      }
      const hole = lSparse && r.constructor === Item
        ? /** @type {CausalHole|TerminalCausalHole} */ (l)
        : rSparse && l.constructor === Item
          ? /** @type {CausalHole|TerminalCausalHole} */ (r)
          : null
      const item = l.constructor === Item && rSparse
        ? /** @type {Item} */ (l)
        : r.constructor === Item && lSparse
          ? /** @type {Item} */ (r)
          : null
      if (hole !== null && item !== null && !sameCausalHoleItemMetadata(
        /** @type {CausalHole} */ (/** @type {unknown} */ (hole)),
        item,
        start,
        end - start,
        inferParent(item)
      )) {
        throw new Error(hole.constructor === TerminalCausalHole ? 'Conflicting terminal causal hole replacement metadata' : 'Conflicting causal hole replacement metadata')
      }
      if (lSparse && rSparse) {
        const ls = /** @type {CausalHole|TerminalCausalHole} */ (l).slice(start, end - start)
        const rs = /** @type {CausalHole|TerminalCausalHole} */ (r).slice(start, end - start)
        if (!sameCausalHoleMetadata(
          /** @type {CausalHole} */ (/** @type {unknown} */ (ls)),
          /** @type {CausalHole} */ (/** @type {unknown} */ (rs))
        )) throw new Error('Conflicting sparse causal metadata')
      }
      if (
        (l.constructor === CausalHole && r.constructor === GC) ||
        (r.constructor === CausalHole && l.constructor === GC)
      ) {
        throw new Error('GC cannot replace live causal hole coverage')
      }
    }
    if (lend <= rend) li++
    if (rend <= lend) ri++
  }
}

/**
 * Merge ranges containing causal holes. Materialized structs win; conflicting overlapping hole
 * metadata fails closed. The ordinary no-hole path above remains byte-for-byte unchanged.
 *
 * @param {Array<Item|GC|Skip|CausalHole|TerminalCausalHole>} left
 * @param {Array<Item|GC|Skip|CausalHole|TerminalCausalHole>} right
 * @param {(id:ID) => Item|GC|Skip|CausalHole|TerminalCausalHole|null} resolveMergeInput
 */
const mergeSparseRefs = (left, right, resolveMergeInput) => {
  const inferParent = createMergeItemParentResolver(resolveMergeInput)
  validateSparseOverlaps(left, right, inferParent)
  const boundaries = new Set()
  for (const block of left.concat(right)) {
    boundaries.add(block.id.clock)
    boundaries.add(block.id.clock + block.length)
  }
  const clocks = Array.from(boundaries).sort((a, b) => a - b)
  /** @type {Array<{block:Item|GC|Skip|CausalHole|TerminalCausalHole,clock:number,length:number}>} */
  const selections = []
  /**
   * @param {Item|GC|Skip|CausalHole|TerminalCausalHole} block
   * @param {number} clock
   * @param {number} length
   */
  const select = (block, clock, length) => {
    const previous = selections[selections.length - 1]
    if (previous?.block === block && previous.clock + previous.length === clock) {
      previous.length += length
    } else {
      selections.push({ block, clock, length })
    }
  }
  let li = 0
  let ri = 0
  for (let i = 0; i + 1 < clocks.length; i++) {
    const clock = clocks[i]
    const length = clocks[i + 1] - clock
    if (length === 0) continue
    while (li < left.length && left[li].id.clock + left[li].length <= clock) li++
    while (ri < right.length && right[ri].id.clock + right[ri].length <= clock) ri++
    const l = left[li]?.id.clock <= clock && clock < left[li].id.clock + left[li].length ? left[li] : null
    const r = right[ri]?.id.clock <= clock && clock < right[ri].id.clock + right[ri].length ? right[ri] : null
    const lrank = blockRank(l)
    const rrank = blockRank(r)
    if (lrank === 0 && rrank === 0 && l === null && r === null) {
      const skip = new Skip(createID(left[0]?.id.client ?? right[0].id.client, clock), length)
      select(skip, clock, length)
      continue
    }
    const chosen = dominantBlock(l, r)
    if (chosen === null) continue
    select(chosen, clock, length)
  }
  /** @type {Array<Item|GC|Skip|CausalHole|TerminalCausalHole>} */
  const result = []
  for (const selection of selections) {
    const sliced = sliceBlock(selection.block, selection.clock, selection.length)
    const previous = result[result.length - 1]
    let merged = false
    if (previous?.constructor === CausalHole && sliced.constructor === CausalHole) {
      merged = /** @type {CausalHole} */ (previous).mergeWith(/** @type {CausalHole} */ (sliced))
    } else if (previous?.constructor === TerminalCausalHole && sliced.constructor === TerminalCausalHole) {
      merged = /** @type {TerminalCausalHole} */ (previous).mergeWith(/** @type {TerminalCausalHole} */ (sliced))
    } else if (previous?.constructor === Skip && sliced.constructor === Skip) {
      merged = /** @type {Skip} */ (previous).mergeWith(/** @type {Skip} */ (sliced))
    } else if (previous?.constructor === GC && sliced.constructor === GC) {
      merged = /** @type {GC} */ (previous).mergeWith(/** @type {GC} */ (sliced))
    }
    if (!merged) result.push(sliced)
  }
  return result
}
