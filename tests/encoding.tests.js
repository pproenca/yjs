import * as t from 'lib0/testing'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

import {
  contentRefs,
  readContentDeleted,
  readContentBinary,
  readContentString,
  readContentJSON,
  readContentEmbed,
  readContentType,
  readContentFormat,
  readContentAny,
  readContentDoc
} from '../src/ytype.js'

import * as Y from '../src/index.js'
import { CausalHole, sameCausalHoleMetadata } from '../src/structs/CausalHole.js'
import { normalizeDocOptions } from '../src/utils/Doc.js'
import { readBlockSet, writeBlockSet } from '../src/utils/BlockSet.js'
import { commitPendingDs, commitPendingStructs, getPendingRevision, readIndexedPendingStructs, readPendingStructs } from '../src/utils/StructStore.js'
import { getStructuralRevision } from '../src/utils/structural-revision.js'
import { getItemCleanStart } from '../src/utils/transaction-helpers.js'
import { _testOnlyGetSparseFailedPlanRuns, _testOnlyGetSparsePendingProofRuns, writeStateAsUpdate } from '../src/utils/encoding.js'
import { writeStructsFromIdSetWithCausalHoles } from '../src/utils/encoding-helpers.js'
import { UpdateDecoderV1, UpdateDecoderV2 } from '../src/utils/UpdateDecoder.js'

/**
 * @param {Array<Y.GC|Y.Item|Y.Skip|CausalHole>} structs
 * @param {typeof Y.UpdateEncoderV1|typeof Y.UpdateEncoderV2} Encoder
 */
const encodeStructs = (structs, Encoder) => {
  if (structs.length === 0) throw new Error('Expected structs')
  const client = structs[0].id.client
  let clock = structs[0].id.clock
  const encoder = new Encoder()
  encoding.writeVarUint(encoder.restEncoder, 1)
  encoding.writeVarUint(encoder.restEncoder, structs.length)
  encoder.writeClient(client)
  encoding.writeVarUint(encoder.restEncoder, clock)
  structs.forEach(struct => {
    if (struct.id.client !== client || struct.id.clock !== clock) throw new Error('Structs must be contiguous')
    struct.write(encoder, 0, 0)
    clock += struct.length
  })
  encoding.writeVarUint(encoder.restEncoder, 0)
  return encoder.toUint8Array()
}

/**
 * @param {Array<Array<Y.GC|Y.Item|Y.Skip|CausalHole>>} groups
 * @param {typeof Y.UpdateEncoderV1|typeof Y.UpdateEncoderV2} Encoder
 */
const encodeStructGroups = (groups, Encoder) => {
  const encoder = new Encoder()
  encoding.writeVarUint(encoder.restEncoder, groups.length)
  groups.slice().sort((left, right) => right[0].id.client - left[0].id.client).forEach(structs => {
    const client = structs[0].id.client
    let clock = structs[0].id.clock
    encoding.writeVarUint(encoder.restEncoder, structs.length)
    encoder.writeClient(client)
    encoding.writeVarUint(encoder.restEncoder, clock)
    structs.forEach(struct => {
      if (struct.id.client !== client || struct.id.clock !== clock) throw new Error('Structs must be contiguous')
      struct.write(encoder, 0, 0)
      clock += struct.length
    })
  })
  encoding.writeVarUint(encoder.restEncoder, 0)
  return encoder.toUint8Array()
}

/**
 * @param {Array<CausalHole>} holes
 * @param {typeof Y.UpdateEncoderV1|typeof Y.UpdateEncoderV2} Encoder
 */
const encodeCausalHoles = (holes, Encoder) => encodeStructs(holes, Encoder)

/**
 * @param {12|13} ref
 * @param {typeof Y.UpdateEncoderV1|typeof Y.UpdateEncoderV2} Encoder
 */
const encodeUnsupportedSparseRef = (ref, Encoder) => {
  const encoder = new Encoder()
  encoding.writeVarUint(encoder.restEncoder, 1)
  encoding.writeVarUint(encoder.restEncoder, 1)
  encoder.writeClient(2)
  encoding.writeVarUint(encoder.restEncoder, 0)
  encoder.writeInfo(ref)
  encoding.writeVarUint(encoder.restEncoder, 1)
  encoder.writeParentInfo(true)
  encoder.writeString('text')
  encoding.writeVarUint(encoder.restEncoder, 0)
  return encoder.toUint8Array()
}

/**
 * @param {Y.IdSet} deleteSet
 * @param {typeof Y.UpdateEncoderV1|typeof Y.UpdateEncoderV2} Encoder
 */
const encodeDeleteSet = (deleteSet, Encoder) => {
  const encoder = new Encoder()
  encoding.writeVarUint(encoder.restEncoder, 0)
  Y.writeIdSet(encoder, deleteSet)
  return encoder.toUint8Array()
}

/** @param {Uint8Array<ArrayBuffer>} update */
const decodePendingIndex = update => {
  const decoder = new UpdateDecoderV2(decoding.createDecoder(update))
  return { blocks: readBlockSet(decoder), deletes: Y.readIdSet(decoder) }
}

/** @param {Y.Doc} doc @param {Map<number,number>} missing @param {Uint8Array<ArrayBuffer>} update @param {Uint8Array<ArrayBuffer>} [indexedUpdate] */
const commitPendingUpdate = (doc, missing, update, indexedUpdate = update) => {
  commitPendingStructs(doc.store, { missing, update }, ownedUpdate => decodePendingIndex(indexedUpdate === update ? ownedUpdate : indexedUpdate))
}

/** @param {Y.Doc} doc @param {Uint8Array<ArrayBuffer>} update */
const commitPendingDelete = (doc, update) => {
  commitPendingDs(doc.store, { update }, ownedUpdate => decodePendingIndex(ownedUpdate).deletes)
}

/** @param {Map<number,number>} state */
const encodeStateVectorMap = state => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, state.size)
  state.forEach((clock, client) => {
    encoding.writeVarUint(encoder, client)
    encoding.writeVarUint(encoder, clock)
  })
  return encoding.toUint8Array(encoder)
}

/** @param {Y.Doc} doc @param {Uint8Array<ArrayBuffer>} stateVector @param {typeof Y.UpdateEncoderV1|typeof Y.UpdateEncoderV2} Encoder */
const encodeSparseStateLegacy = (doc, stateVector, Encoder) => {
  const state = Y.decodeStateVector(stateVector)
  const stateEncoder = new Encoder()
  writeStateAsUpdate(stateEncoder, doc, state)
  const Decoder = Encoder === Y.UpdateEncoderV1 ? UpdateDecoderV1 : UpdateDecoderV2
  const stateDecoder = new Decoder(decoding.createDecoder(stateEncoder.toUint8Array()))
  const blocks = readBlockSet(stateDecoder)
  const deletes = [Y.readIdSet(stateDecoder)]
  const pending = readPendingStructs(doc.store)
  if (pending !== null) {
    const pendingDecoder = new UpdateDecoderV2(decoding.createDecoder(Y.diffUpdateV2(pending.update, stateVector)))
    blocks.insertInto(readBlockSet(pendingDecoder))
    deletes.push(Y.readIdSet(pendingDecoder))
  }
  const pendingDeletes = doc.store.pendingDs
  if (pendingDeletes !== null) {
    const pendingDeleteDecoder = new UpdateDecoderV2(decoding.createDecoder(pendingDeletes))
    readBlockSet(pendingDeleteDecoder)
    deletes.push(Y.readIdSet(pendingDeleteDecoder))
  }
  const result = new Encoder()
  writeBlockSet(result, blocks)
  Y.writeIdSet(result, Y.mergeIdSets(deletes))
  return result.toUint8Array()
}

const createCausalHoleBase = () => {
  const doc = new Y.Doc({ gc: false, sparseExactResolution: true })
  doc.clientID = 1
  doc.get('text').insert(0, 'a')
  return doc
}

const c28Transports = [
  { label: 'v1', apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
  { label: 'v2', apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
]

/** @param {Y.Doc} doc @param {(doc:Y.Doc)=>Uint8Array<ArrayBuffer>} encode */
const captureC28State = (doc, encode) => ({
  bytes: Array.from(encode(doc)),
  state: Array.from(Y.encodeStateVector(doc)),
  clients: new Map(doc.store.clients),
  pendingStructs: doc.store.pendingStructs,
  pendingDs: doc.store.pendingDs,
  share: doc.share,
  roots: new Map(doc.share),
  subdocs: new Set(doc.subdocs),
  cleanups: doc._transactionCleanups.length
})

/** @param {Y.Doc} doc @param {(doc:Y.Doc)=>Uint8Array<ArrayBuffer>} encode @param {ReturnType<typeof captureC28State>} before @param {string} label */
const assertC28State = (doc, encode, before, label) => {
  t.compareArrays(Array.from(encode(doc)), before.bytes, `${label} bytes`)
  t.compareArrays(Array.from(Y.encodeStateVector(doc)), before.state, `${label} state`)
  t.assert(doc.store.clients.size === before.clients.size && [...before.clients].every(([client, structs]) => doc.store.clients.get(client) === structs), `${label} store`)
  t.assert(doc.store.pendingStructs === before.pendingStructs && doc.store.pendingDs === before.pendingDs, `${label} pending`)
  t.assert(doc.share === before.share && doc.share.size === before.roots.size && [...before.roots].every(([key, root]) => doc.share.get(key) === root), `${label} roots`)
  t.assert(doc.subdocs.size === before.subdocs.size && [...before.subdocs].every(subdoc => doc.subdocs.has(subdoc)), `${label} subdocs`)
  t.assert(doc._transaction === null && doc._transactionCleanups.length === before.cleanups, `${label} cleanup queue`)
}

/**
 * @param {t.TestCase} _tc
 */
export const testStructReferences = _tc => {
  t.assert(contentRefs.length === 11)
  t.assert(contentRefs[1] === readContentDeleted)
  t.assert(contentRefs[2] === readContentJSON) // TODO: deprecate content json?
  t.assert(contentRefs[3] === readContentBinary)
  t.assert(contentRefs[4] === readContentString)
  t.assert(contentRefs[5] === readContentEmbed)
  t.assert(contentRefs[6] === readContentFormat)
  t.assert(contentRefs[7] === readContentType)
  t.assert(contentRefs[8] === readContentAny)
  t.assert(contentRefs[9] === readContentDoc)
  // contentRefs[10] is reserved for Skip structs
}

export const testSparseExactResolutionRequiresGcFalseAtConstructionAndClone = () => {
  ;[null, [], () => {}].forEach(value => {
    t.fails(() => new Y.Doc(/** @type {any} */ (value)))
  })
  t.fails(() => new Y.Doc({ sparseExactResolution: true }))
  t.fails(() => new Y.Doc({ gc: true, sparseExactResolution: true }))
  ;[0, 1, null, undefined, 'true', {}].forEach(value => {
    t.fails(() => new Y.Doc({ gc: false, sparseExactResolution: /** @type {any} */ (value) }))
  })
  const inheritedInvalid = Object.create({ sparseExactResolution: 'true' })
  inheritedInvalid.gc = false
  const inherited = new Y.Doc(inheritedInvalid)
  t.assert(inherited.sparseExactResolution === false && inherited.gc === false)
  const inheritedPair = new Y.Doc(Object.create({ sparseExactResolution: true, gc: false }))
  t.assert(inheritedPair.sparseExactResolution === false && inheritedPair.gc === false)
  const inheritedGc = Object.create({ gc: false })
  inheritedGc.sparseExactResolution = true
  t.fails(() => new Y.Doc(inheritedGc))

  let sparseReads = 0
  const accessorSparse = { gc: false }
  Object.defineProperty(accessorSparse, 'sparseExactResolution', { get: () => { sparseReads++; return true } })
  t.fails(() => new Y.Doc(/** @type {any} */ (accessorSparse)))
  t.assert(sparseReads === 0)
  let gcReads = 0
  const accessorGc = { sparseExactResolution: true }
  Object.defineProperty(accessorGc, 'gc', { get: () => { gcReads++; return false } })
  t.fails(() => new Y.Doc(/** @type {any} */ (accessorGc)))
  t.assert(gcReads === 0)

  const future = { guid: 'preserved', meta: { ok: true }, futureOption: 42 }
  const normalized = normalizeDocOptions(future)
  t.assert(normalized.opts === future && /** @type {any} */ (normalized.opts).futureOption === 42 && !normalized.sparseExactResolution)

  const ordinary = new Y.Doc()
  ordinary.gc = false
  t.assert(ordinary.gc === false)
  const ordinaryGc = Object.getOwnPropertyDescriptor(ordinary, 'gc')
  const ordinarySparse = Object.getOwnPropertyDescriptor(ordinary, 'sparseExactResolution')
  t.assert(ordinaryGc?.writable === true && ordinaryGc.configurable === true)
  t.assert(ordinarySparse?.writable === false && ordinarySparse.configurable === false)
  t.fails(() => { ordinary.sparseExactResolution = true })

  const source = new Y.Doc({ gc: false, sparseExactResolution: true })
  source.get('text').insert(0, 'x')
  const sparseGc = Object.getOwnPropertyDescriptor(source, 'gc')
  const sparseCapability = Object.getOwnPropertyDescriptor(source, 'sparseExactResolution')
  t.assert(typeof sparseGc?.get === 'function' && typeof sparseGc.set === 'function' && sparseGc.configurable === false)
  t.assert(sparseCapability?.value === true && sparseCapability.writable === false && sparseCapability.configurable === false)
  source.gc = false
  t.assert(source.gc === false)
  t.fails(() => { source.gc = true })
  t.fails(() => { source.gc = /** @type {any} */ (0) })
  t.fails(() => { source.sparseExactResolution = false })
  t.fails(() => Object.defineProperty(source, 'gc', { value: true }))
  t.fails(() => Object.defineProperty(source, 'sparseExactResolution', { value: false }))

  const nested = new Y.Type()
  source.get('nested').insert(0, [nested])
  nested.insert(0, ['payload'])
  source.get('nested').delete(0, 1)
  ;[
    { decode: Y.decodeUpdate, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { decode: Y.decodeUpdateV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ decode, apply, encode }) => {
    const update = encode(source)
    t.assert(!decode(update).structs.some(struct => struct.constructor === Y.GC))
    const reload = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(reload, update)
    t.assert(reload.gc === false && reload.sparseExactResolution === true)
  })
  t.fails(() => Y.cloneDoc(source))
  t.fails(() => Y.cloneDoc(source, { gc: true, sparseExactResolution: true }))
  t.fails(() => Y.cloneDoc(source, { gc: false }))
  t.fails(() => Y.cloneDoc(source, Object.create({ gc: false, sparseExactResolution: true })))
  const clone = Y.cloneDoc(source, { gc: false, sparseExactResolution: true })
  t.assert(clone.get('text').toString() === 'x' && clone.gc === false && clone.sparseExactResolution)
}

export const testSubdocSparseOptionsRejectBeforeMutation = () => {
  ;[
    {
      Encoder: Y.UpdateEncoderV1,
      apply: Y.applyUpdate,
      encode: Y.encodeStateAsUpdate,
      event: 'update'
    },
    {
      Encoder: Y.UpdateEncoderV2,
      apply: Y.applyUpdateV2,
      encode: Y.encodeStateAsUpdateV2,
      event: 'updateV2'
    }
  ].forEach(({ Encoder, apply, encode, event }) => {
    ;[
      null,
      { sparseExactResolution: true },
      { gc: true, sparseExactResolution: true },
      { gc: false, sparseExactResolution: 1 }
    ].forEach((opts, caseIndex) => {
      ;[false, true].forEach(sparseTarget => {
        const target = new Y.Doc(sparseTarget ? { gc: false, sparseExactResolution: true } : { gc: false })
        const invalid = encodeStructs([
          new Y.Item(
            Y.createID(41, 0),
            null,
            null,
            null,
            null,
            'docs',
            null,
            new Y.ContentDoc(`invalid-${caseIndex}`, /** @type {any} */ (opts))
          )
        ], Encoder)
        const corrected = encodeStructs([
          new Y.Item(
            Y.createID(41, 0),
            null,
            null,
            null,
            null,
            'docs',
            null,
            new Y.ContentDoc(`valid-${caseIndex}`, { gc: false, sparseExactResolution: true })
          )
        ], Encoder)
        const before = encode(target)
        const state = Y.encodeStateVector(target)
        let updates = 0
        let transactions = 0
        let subdocEvents = 0
        target.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
        target.on('afterTransaction', () => { transactions++ })
        target.on('subdocs', () => { subdocEvents++ })
        t.fails(() => apply(target, invalid))
        t.compareArrays(Array.from(encode(target)), Array.from(before))
        t.compareArrays(Array.from(Y.encodeStateVector(target)), Array.from(state))
        t.assert(target.share.size === 0 && target.store.clients.size === 0 && target.subdocs.size === 0)
        t.assert(updates === 0 && transactions === 0 && subdocEvents === 0)

        apply(target, corrected)
        const restored = /** @type {Y.Doc} */ (target.get('docs').get(0))
        t.assert(restored.sparseExactResolution && restored.gc === false)
      })
    })
  })
}

export const testSparseCompositeSubdocsMaterializeBeforeTargetMutation = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, event: 'update', apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, event: 'updateV2', apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, event, apply, encode }) => {
    let constructions = 0
    let failConstruction = true
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super(opts)
        if (opts?.guid === 'composite-subdoc') {
          constructions++
          if (failConstruction) throw new Error('subdoc construction failed')
        }
      }
    }
    const createPendingTarget = () => {
      const target = new TargetDoc({ gc: false, sparseExactResolution: true })
      apply(target, encodeStructs([
        new Y.Item(
          Y.createID(2, 0),
          null,
          Y.createID(1, 0),
          null,
          null,
          'docs',
          null,
          new Y.ContentDoc('composite-subdoc', {})
        )
      ], Encoder))
      t.assert(target.store.pendingStructs !== null && constructions === 0)
      return target
    }
    const resolving = encodeCausalHoles([
      new CausalHole(Y.createID(1, 0), 1, null, null, 'docs', null)
    ], Encoder)

    const failed = createPendingTarget()
    const indexedPending = readIndexedPendingStructs(failed.store)
    const pending = /** @type {NonNullable<typeof failed.store.pendingStructs>} */ (failed.store.pendingStructs)
    const pendingBytes = Array.from(pending.update)
    const state = Y.encodeStateVector(failed)
    const snapshot = encode(failed)
    let updatesV1 = 0
    let updatesV2 = 0
    let transactions = 0
    let subdocs = 0
    failed.on('update', () => { updatesV1++ })
    failed.on('updateV2', () => { updatesV2++ })
    failed.on('afterTransaction', () => { transactions++ })
    failed.on('subdocs', () => { subdocs++ })
    t.fails(() => apply(failed, resolving))
    t.assert(constructions === 1)
    t.assert(readIndexedPendingStructs(failed.store) === indexedPending)
    t.compareArrays(Array.from(/** @type {NonNullable<typeof failed.store.pendingStructs>} */ (failed.store.pendingStructs).update), pendingBytes)
    t.compareArrays(Array.from(Y.encodeStateVector(failed)), Array.from(state))
    t.compareArrays(Array.from(encode(failed)), Array.from(snapshot))
    t.assert(failed.store.clients.size === 0 && failed.share.size === 0 && failed.subdocs.size === 0)
    t.assert(updatesV1 === 0 && updatesV2 === 0 && transactions === 0 && subdocs === 0, `${event} constructor failure is zero-event`)

    failConstruction = false
    apply(failed, resolving)
    t.assert(constructions === 2 && failed.store.pendingStructs === null)
    t.assert(/** @type {Y.Doc} */ (failed.get('docs').get(0)).guid === 'composite-subdoc')

    constructions = 0
    const successful = createPendingTarget()
    apply(successful, resolving)
    t.assert(constructions === 1 && successful.store.pendingStructs === null)
    t.assert(/** @type {Y.Doc} */ (successful.get('docs').get(0)).guid === 'composite-subdoc')
  })
}

export const testSubdocPreparationUsesOnlyTheStableIntegrationSchedule = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    let host = /** @type {Y.Doc|null} */ (null)
    let scheduledConstructions = 0
    let excludedConstructions = 0
    let excludedDestructions = 0
    const materializedExcluded = encodeStructs([
      new Y.Item(Y.createID(59, 0), null, null, null, null, 'materialized', null, new Y.ContentString('x'))
    ], Encoder)
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super(opts)
        if (opts?.guid === 'scheduled-once') {
          scheduledConstructions++
          if (host !== null && host.store.getStruct(Y.createID(59, 0)) === null) apply(host, materializedExcluded)
        }
        if (opts?.guid === 'excluded-before-construction') excludedConstructions++
      }

      destroy () {
        if (this.guid === 'excluded-before-construction') excludedDestructions++
        super.destroy()
      }
    }
    host = new TargetDoc({ gc: false, sparseExactResolution: true })
    const update = encodeStructGroups([
      [new Y.Item(Y.createID(60, 0), null, null, null, null, 'docs', null, new Y.ContentDoc('scheduled-once', {}))],
      [new Y.Item(Y.createID(59, 0), null, null, null, null, 'docs', null, new Y.ContentDoc('excluded-before-construction', {}))]
    ], Encoder)
    apply(host, update)
    t.assert(scheduledConstructions === 1, `${Encoder.name} scheduled subdoc constructs once across revision rebuild`)
    t.assert(excludedConstructions === 0 && excludedDestructions === 0, `${Encoder.name} invalidated later subdoc has no lifecycle`)
    t.assert(host.store.getStruct(Y.createID(59, 0))?.constructor === Y.Item)
    t.assert(/** @type {Y.Doc} */ (host.get('docs').get(0)).guid === 'scheduled-once')

    apply(host, update)
    t.assert(scheduledConstructions === 1 && excludedConstructions === 0 && excludedDestructions === 0, `${Encoder.name} duplicate-known subdocs have no lifecycle`)

    apply(host, encodeStructs([
      new Y.Item(Y.createID(58, 0), null, Y.createID(57, 0), null, null, 'docs', null, new Y.ContentDoc('excluded-before-construction', {}))
    ], Encoder))
    t.assert(host.store.pendingStructs !== null)
    t.assert(excludedConstructions === 0 && excludedDestructions === 0, `${Encoder.name} unresolved subdocs have no lifecycle`)
  })
}

export const testSubdocRevisionRebuildPreservesSparseSplitPlan = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    let host = /** @type {Y.Doc|null} */ (null)
    let constructions = 0
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super(opts)
        if (opts?.guid === 'split-rebuild') {
          constructions++
          host?.get('constructor-root')
        }
      }
    }
    host = new TargetDoc({ gc: false, sparseExactResolution: true })
    apply(host, encodeCausalHoles([
      new CausalHole(Y.createID(61, 0), 1, null, null, 'text', null)
    ], Encoder))
    apply(host, encodeStructGroups([
      [new Y.Item(Y.createID(62, 0), null, null, null, null, 'docs', null, new Y.ContentDoc('split-rebuild', {}))],
      [new Y.Item(Y.createID(61, 0), null, null, null, null, 'text', null, new Y.ContentString('xy'))]
    ], Encoder))
    t.assert(constructions === 1, `${Encoder.name} target-mutating constructor constructs once`)
    t.assert(host.get('text').toString() === 'xy' && host.store.causalHoles.isEmpty())
    t.assert(/** @type {Y.Doc} */ (host.get('docs').get(0)).guid === 'split-rebuild')
  })
}

export const testSparseSubdocReentrancyPreservesNewPendingWork = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const nested = encodeStructs([
      new Y.Item(Y.createID(71, 0), null, Y.createID(70, 0), null, null, 'nested', null, new Y.ContentString('n'))
    ], Encoder)
    const dependency = encodeStructs([
      new Y.Item(Y.createID(70, 0), null, null, null, null, 'nested', null, new Y.ContentString('d'))
    ], Encoder)
    let host = /** @type {Y.Doc|null} */ (null)
    let injectConstructor = true
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super(opts)
        if (opts?.guid === 'pending-from-constructor' && host !== null && injectConstructor) {
          injectConstructor = false
          apply(host, nested)
        }
      }
    }
    host = new TargetDoc({ gc: false, sparseExactResolution: true })
    apply(host, encodeStructs([
      new Y.Item(
        Y.createID(2, 0),
        null,
        Y.createID(1, 0),
        null,
        null,
        'docs',
        null,
        new Y.ContentDoc('pending-from-constructor', {})
      )
    ], Encoder))
    const resolving = encodeCausalHoles([
      new CausalHole(Y.createID(1, 0), 1, null, null, 'docs', null)
    ], Encoder)
    t.fails(() => apply(host, resolving))
    t.assert(host.store.getStruct(Y.createID(1, 0)) === null && host.share.size === 0, `${Encoder.name} constructor epoch abort is atomic`)
    t.assert(host.store.pendingStructs !== null, `${Encoder.name} constructor pending survives aborted commit`)
    apply(host, resolving)
    t.assert(host.store.pendingStructs !== null, `${Encoder.name} unresolved constructor work survives fresh retry`)
    t.assert(/** @type {Y.Doc} */ (host.get('docs').get(0)).guid === 'pending-from-constructor')
    apply(host, dependency)
    t.assert(host.get('nested').toString() === 'dn' && host.store.pendingStructs === null)

    const beforeTransaction = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(beforeTransaction, encodeStructs([
      new Y.Item(Y.createID(4, 0), null, Y.createID(3, 0), null, null, 'outer', null, new Y.ContentString('o'))
    ], Encoder))
    const nestedDelete = Y.createIdSet()
    nestedDelete.add(90, 0, 1)
    let inject = true
    beforeTransaction.on('beforeTransaction', () => {
      if (!inject) return
      inject = false
      apply(beforeTransaction, encodeStructs([
        new Y.Item(Y.createID(81, 0), null, Y.createID(80, 0), null, null, 'hook', null, new Y.ContentString('h'))
      ], Encoder))
      apply(beforeTransaction, encodeDeleteSet(nestedDelete, Encoder))
    })
    const resolvesOuter = encodeCausalHoles([
      new CausalHole(Y.createID(3, 0), 1, null, null, 'outer', null)
    ], Encoder)
    t.fails(() => apply(beforeTransaction, resolvesOuter))
    t.assert(beforeTransaction.store.getStruct(Y.createID(3, 0)) === null && beforeTransaction.share.size === 0, `${Encoder.name} beforeTransaction epoch abort is atomic`)
    t.assert(beforeTransaction.store.pendingStructs !== null, `${Encoder.name} beforeTransaction pending survives aborted commit`)
    t.assert(beforeTransaction.store.pendingDs !== null, `${Encoder.name} beforeTransaction pending delete survives aborted commit`)
    apply(beforeTransaction, resolvesOuter)
    t.assert(beforeTransaction.get('outer').toString() === 'o', `${Encoder.name} fresh resolver retry succeeds`)
    apply(beforeTransaction, encodeStructGroups([
      [new Y.Item(Y.createID(90, 0), null, null, null, null, 'deleted', null, new Y.ContentString('x'))],
      [new Y.Item(Y.createID(80, 0), null, null, null, null, 'hook', null, new Y.ContentString('d'))]
    ], Encoder))
    const deleted = beforeTransaction.store.getStruct(Y.createID(90, 0))
    t.assert(beforeTransaction.get('hook').toString() === 'dh' && beforeTransaction.store.pendingStructs === null)
    t.assert(deleted?.constructor === Y.Item && deleted.deleted && beforeTransaction.store.pendingDs === null)
  })
}

export const testSubdocRevisionRebuildKeepsPartialKnownSuffix = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    let host = /** @type {Y.Doc|null} */ (null)
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super(opts)
        if (opts?.guid === 'partial-known-rebuild') host?.get('constructor-root')
      }
    }
    host = new TargetDoc({ gc: false, sparseExactResolution: true })
    apply(host, encodeStructs([
      new Y.Item(Y.createID(2, 0), null, null, null, null, 'text', null, new Y.ContentString('a'))
    ], Encoder))
    const update = encodeStructGroups([
      [new Y.Item(Y.createID(60, 0), null, null, null, null, 'docs', null, new Y.ContentDoc('partial-known-rebuild', {}))],
      [new Y.Item(Y.createID(2, 0), null, null, null, null, 'text', null, new Y.ContentString('ab'))]
    ], Encoder)
    const canonicalBytes = Array.from(update)
    apply(host, update)

    const suffix = host.store.getStruct(Y.createID(2, 1))
    t.compareArrays(Array.from(update), canonicalBytes)
    t.assert(host.get('text').toString() === 'ab', `${Encoder.name} valid partial-known suffix integrates`)
    t.assert(
      suffix?.constructor === Y.Item && suffix.id.clock <= 1 && suffix.id.clock + suffix.length >= 2,
      `${Encoder.name} suffix remains materialized after transaction cleanup`
    )
    t.assert(/** @type {Y.Doc} */ (host.get('docs').get(0)).guid === 'partial-known-rebuild')
    t.assert(host.store.pendingStructs === null && host.store.pendingDs === null)
  })
}

export const testOrdinarySubdocConstructorReentrancyMatchesSequentialApply = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply, encode, event }) => {
    const later = encodeStructs([
      new Y.Item(Y.createID(10, 0), null, null, null, null, 'text', null, new Y.ContentString('x'))
    ], Encoder)
    const composite = encodeStructGroups([
      [new Y.Item(Y.createID(30, 0), null, null, null, null, 'docs', null, new Y.ContentDoc('ordinary-reentrant', {}))],
      [new Y.Item(Y.createID(10, 0), null, null, null, null, 'text', null, new Y.ContentString('x'))]
    ], Encoder)
    const expected = new Y.Doc({ gc: false })
    apply(expected, later)
    apply(expected, composite)

    let host = /** @type {Y.Doc|null} */ (null)
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super(opts)
        if (opts?.guid === 'ordinary-reentrant' && host !== null) apply(host, later)
      }
    }
    host = new TargetDoc({ gc: false })
    /** @type {Array<Array<number>>} */
    const actualEvents = []
    let transactions = 0
    host.on(/** @type {'update'|'updateV2'} */ (event), update => actualEvents.push(Array.from(update)))
    host.on('afterTransaction', () => { transactions++ })
    apply(host, composite)

    t.compareArrays(Array.from(encode(host)), Array.from(encode(expected)), `${Encoder.name} ordinary bytes`)
    t.compareArrays(Array.from(Y.encodeStateVector(host)), Array.from(Y.encodeStateVector(expected)), `${Encoder.name} ordinary state`)
    t.assert(actualEvents.length === 1, `${Encoder.name} reentrant apply remains in the outer transaction`)
    t.compareArrays(actualEvents[0], Array.from(composite), `${Encoder.name} outer event retains upstream bytes`)
    t.assert(transactions === 1 && host.get('text').toString() === 'xx', `${Encoder.name} ordinary linked state matches upstream reentrancy`)
    t.assert(/** @type {Y.Doc} */ (host.get('docs').get(0)).guid === 'ordinary-reentrant')
    t.assert(host.store.pendingStructs === null && host.store.pendingDs === null)
  })
}

export const testOrdinaryLargeApplyBypassesSparseSchedule = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const clients = 512
    const update = encodeStructGroups(Array.from({ length: clients }, (_, index) => [
      new Y.Item(Y.createID(1000 + index, 0), null, null, null, null, `root-${index}`, null, new Y.ContentString('x'))
    ]), Encoder)
    const originalPush = Array.prototype.push
    let sparseScheduleEntries = 0
    /** @this {Array<unknown>} @param {...unknown} values */
    const countedPush = function (...values) {
      values.forEach(value => {
        if (
          value !== null && typeof value === 'object' &&
          Object.prototype.hasOwnProperty.call(value, 'struct') &&
          Object.prototype.hasOwnProperty.call(value, 'clock') &&
          Object.prototype.hasOwnProperty.call(value, 'gap')
        ) sparseScheduleEntries++
      })
      return Reflect.apply(originalPush, this, values)
    }
    // eslint-disable-next-line no-extend-native
    Array.prototype.push = /** @type {typeof Array.prototype.push} */ (countedPush)
    const ordinary = new Y.Doc({ gc: false })
    try {
      apply(ordinary, update)
    } finally {
      // eslint-disable-next-line no-extend-native
      Array.prototype.push = originalPush
    }
    t.assert(sparseScheduleEntries === 0, `${Encoder.name} ordinary apply never builds sparse schedule (${sparseScheduleEntries})`)
    t.assert(ordinary.store.clients.size === clients && ordinary.store.pendingStructs === null)
  })
}

export const testSparseLaterAdjacentFailureIsAtomicAndRetryable = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, apply, encode }) => {
    class ThrowingDoc extends Y.Doc {
      throwOnGet = false

      /** @param {string} name @param {string|null} [typeName] */
      get (name, typeName) {
        if (this.throwOnGet) throw new Error('host get failure')
        return super.get(name, typeName)
      }
    }
    const target = new ThrowingDoc({ gc: false, sparseExactResolution: true })
    target.clientID = 1
    target.get('text').insert(0, 'a')
    const laterAdjacent = encodeStructs([
      new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'text', null),
      new Y.Item(Y.createID(2, 1), null, Y.createID(2, 0), null, null, null, null, new Y.ContentString('Y'))
    ], Encoder)
    const beforeState = Array.from(Y.encodeStateVector(target))
    const beforeUpdate = Array.from(encode(target))
    let updates = 0
    let transactions = 0
    target.on('update', () => { updates++ })
    target.on('updateV2', () => { updates++ })
    target.on('afterTransaction', () => { transactions++ })

    target.throwOnGet = true
    t.fails(() => apply(target, laterAdjacent))
    target.throwOnGet = false
    t.compareArrays(Array.from(Y.encodeStateVector(target)), beforeState)
    t.compareArrays(Array.from(encode(target)), beforeUpdate)
    t.assert(target.get('text').toString() === 'a' && target.store.causalHoles.isEmpty())
    t.assert(updates === 0 && transactions === 0, `${Encoder.name} late dependency failure is zero-event`)

    apply(target, laterAdjacent)
    t.assert(target.get('text').toString() === 'aY', `${Encoder.name} fresh retry integrates later adjacent content`)
    t.assert(target.store.getStruct(Y.createID(2, 0))?.constructor === CausalHole)
    t.assert(target.store.getStruct(Y.createID(2, 1))?.constructor === Y.Item)
  })
}

export const testOrdinaryDuplicateKnownContentDocSkipsInvalidOptions = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, apply, encode }) => {
    ;[null, { sparseExactResolution: true }].forEach((opts, index) => {
      const target = new Y.Doc({ gc: false })
      apply(target, encodeStructs([
        new Y.Item(Y.createID(41, 0), null, null, null, null, 'text', null, new Y.ContentString('x'))
      ], Encoder))
      const beforeState = Array.from(Y.encodeStateVector(target))
      const beforeUpdate = Array.from(encode(target))
      let updates = 0
      let subdocs = 0
      target.on('update', () => { updates++ })
      target.on('updateV2', () => { updates++ })
      target.on('subdocs', () => { subdocs++ })

      apply(target, encodeStructs([
        new Y.Item(
          Y.createID(41, 0),
          null,
          null,
          null,
          null,
          'docs',
          null,
          new Y.ContentDoc(`duplicate-invalid-${index}`, /** @type {any} */ (opts))
        )
      ], Encoder))

      t.compareArrays(Array.from(Y.encodeStateVector(target)), beforeState)
      t.compareArrays(Array.from(encode(target)), beforeUpdate)
      t.assert(target.get('text').toString() === 'x' && target.subdocs.size === 0)
      t.assert(updates === 0 && subdocs === 0, `${Encoder.name} duplicate-known invalid subdoc is inert`)
    })
  })
}

export const testSparseFailedResolverRecomputesWithinOpenTransaction = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const target = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(target, encodeStructs([
      new Y.Item(Y.createID(2, 0), null, Y.createID(1, 0), null, null, Y.createID(4, 0), null, new Y.ContentString('x'))
    ], Encoder))
    const resolver = encodeCausalHoles([
      new CausalHole(Y.createID(1, 0), 1, null, null, Y.createID(4, 0), null)
    ], Encoder)
    const parent = encodeStructs([
      new Y.Item(Y.createID(4, 0), null, null, null, null, 'root', null, new Y.ContentType(new Y.Type()))
    ], Encoder)

    target.transact(() => {
      t.fails(() => apply(target, resolver))
      t.assert(_testOnlyGetSparseFailedPlanRuns(target) === 1)
      apply(target, parent)
      apply(target, resolver)
      const storedParent = target.store.getStruct(Y.createID(4, 0))
      const storedChild = target.store.getStruct(Y.createID(2, 0))
      t.assert(storedParent?.constructor === Y.Item && storedParent.content instanceof Y.ContentType)
      t.assert(
        storedChild?.constructor === Y.Item &&
        storedChild.parent === /** @type {Y.ContentType} */ (/** @type {Y.Item} */ (storedParent).content).type,
        `${Encoder.name} identical resolver recomputes before transaction cleanup`
      )
      t.assert(_testOnlyGetSparseFailedPlanRuns(target) === 2)
      t.assert(target.store.pendingStructs === null)
    })
  })
}

export const testOrdinaryBeforeTransactionSameUpdateIntegratesOnce = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply, encode, event }) => {
    const update = encodeStructs([
      new Y.Item(Y.createID(11, 0), null, null, null, null, 'text', null, new Y.ContentString('x'))
    ], Encoder)
    const target = new Y.Doc({ gc: false })
    let inject = true
    let transactions = 0
    let updates = 0
    target.on('beforeTransaction', () => {
      if (!inject) return
      inject = false
      apply(target, update)
    })
    target.on('afterTransaction', () => { transactions++ })
    target.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })

    apply(target, update)
    const stored = target.store.getStruct(Y.createID(11, 0))
    t.assert(target.get('text').toString() === 'x', `${Encoder.name} reentrant duplicate inserts once`)
    t.assert(stored?.constructor === Y.Item && stored.id.clock === 0 && stored.length === 1)
    t.assert(target.store.clients.get(11)?.length === 1 && Y.decodeStateVector(Y.encodeStateVector(target)).get(11) === 1)
    t.assert(transactions === 1 && updates === 1, `${Encoder.name} reentrant duplicate stays in one transaction/event`)

    const snapshot = encode(target)
    const reload = new Y.Doc({ gc: false })
    apply(reload, snapshot)
    t.compareArrays(Array.from(encode(reload)), Array.from(snapshot))
    t.compareArrays(Array.from(Y.encodeStateVector(reload)), Array.from(Y.encodeStateVector(target)))
    t.assert(reload.get('text').toString() === 'x' && Y.decodeStateVector(Y.encodeStateVector(reload)).get(11) === 1)
  })
}

export const testSparsePreparedRootMutationRejectsBeforeAdmission = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, apply, encode }) => {
    ;['delete', 'replace'].forEach(mode => {
      const target = new Y.Doc({ gc: false, sparseExactResolution: true })
      const preparedRoot = target.get('text')
      const update = encodeStructs([
        new CausalHole(Y.createID(21, 0), 1, null, null, 'text', null),
        new Y.Item(Y.createID(21, 1), null, Y.createID(21, 0), null, null, null, null, new Y.ContentString('x'))
      ], Encoder)
      const before = Array.from(encode(target))
      const beforeState = Array.from(Y.encodeStateVector(target))
      const pendingStructs = target.store.pendingStructs
      const pendingDs = target.store.pendingDs
      let inject = true
      let updates = 0
      target.on('beforeTransaction', () => {
        if (!inject) return
        inject = false
        if (mode === 'delete') target.share.delete('text')
        else target.share.set('text', new Y.Type())
      })
      target.on('update', () => { updates++ })
      target.on('updateV2', () => { updates++ })

      t.fails(() => apply(target, update))
      t.compareArrays(Array.from(encode(target)), before, `${Encoder.name} ${mode} root mutation preserves bytes`)
      t.compareArrays(Array.from(Y.encodeStateVector(target)), beforeState)
      t.assert(target.store.clients.size === 0 && target.store.causalHoles.isEmpty())
      t.assert(target.store.pendingStructs === pendingStructs && target.store.pendingDs === pendingDs)
      t.assert(preparedRoot.toString() === '' && updates === 0, `${Encoder.name} ${mode} root receives no invisible insertion`)

      target.share.set('text', preparedRoot)
      apply(target, update)
      t.assert(target.get('text') === preparedRoot && preparedRoot.toString() === 'x')
      t.assert(target.store.getStruct(Y.createID(21, 0))?.constructor === CausalHole)
      t.assert(target.store.getStruct(Y.createID(21, 1))?.constructor === Y.Item)
      t.assert(target.store.pendingStructs === null && target.store.pendingDs === null)
    })
  })
}

export const testSparseAbsentRootInstallationIsAtomicUnderHostileMap = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const target = new Y.Doc({ gc: false, sparseExactResolution: true })
    const update = encodeStructGroups([
      [
        new CausalHole(Y.createID(30, 0), 1, null, null, 'root-a', null),
        new Y.Item(Y.createID(30, 1), null, Y.createID(30, 0), null, null, null, null, new Y.ContentString('a'))
      ],
      [
        new CausalHole(Y.createID(20, 0), 1, null, null, 'root-b', null),
        new Y.Item(Y.createID(20, 1), null, Y.createID(20, 0), null, null, null, null, new Y.ContentString('b'))
      ]
    ], Encoder)
    const share = target.share
    const originalSet = share.set
    let calls = 0
    let failed = false
    share.set = function (key, value) {
      calls++
      if (calls === 2) throw new Error('hostile second root')
      return Reflect.apply(originalSet, this, [key, value])
    }
    try {
      try {
        apply(target, update)
      } catch (_) {
        failed = true
      }
      const roots = Number(share.has('root-a')) + Number(share.has('root-b'))
      t.assert(roots !== 1, `${Encoder.name} staged roots are never partially installed`)
      if (failed) {
        t.assert(roots === 0 && target.store.clients.size === 0 && target.store.causalHoles.isEmpty())
        t.assert(target.store.pendingStructs === null && target.store.pendingDs === null)
      } else {
        t.assert(roots === 2 && share.get('root-a')?.toString() === 'a' && share.get('root-b')?.toString() === 'b')
        t.assert(target.store.getStruct(Y.createID(30, 1))?.constructor === Y.Item)
        t.assert(target.store.getStruct(Y.createID(20, 1))?.constructor === Y.Item)
      }
    } finally {
      share.set = originalSet
    }

    apply(target, update)
    t.assert(target.get('root-a').toString() === 'a' && target.get('root-b').toString() === 'b')
    t.assert(target.store.getStruct(Y.createID(30, 1))?.constructor === Y.Item)
    t.assert(target.store.getStruct(Y.createID(20, 1))?.constructor === Y.Item)
    t.assert(target.store.pendingStructs === null && target.store.pendingDs === null)
  })
}

export const testSparseRootIdentityUsesCapturedMapIntrinsics = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const target = new Y.Doc({ gc: false, sparseExactResolution: true })
    const preparedRoot = target.get('text')
    const replacementRoot = new Y.Type()
    const update = encodeStructs([
      new CausalHole(Y.createID(41, 0), 1, null, null, 'text', null),
      new Y.Item(Y.createID(41, 1), null, Y.createID(41, 0), null, null, null, null, new Y.ContentString('x'))
    ], Encoder)
    const nativeHas = Map.prototype.has
    const nativeGet = Map.prototype.get
    const nativeSet = Map.prototype.set
    let inject = true
    let updates = 0
    target.on('beforeTransaction', () => {
      if (!inject) return
      inject = false
      Reflect.apply(nativeSet, target.share, ['text', replacementRoot])
      Reflect.set(Map.prototype, 'has', /**
       * @this {Map<unknown,unknown>}
       * @param {unknown} key
       */ function (key) {
          return this === target.share && key === 'text' ? true : Reflect.apply(nativeHas, this, [key])
        })
      Reflect.set(Map.prototype, 'get', /**
       * @this {Map<unknown,unknown>}
       * @param {unknown} key
       */ function (key) {
          return this === target.share && key === 'text' ? preparedRoot : Reflect.apply(nativeGet, this, [key])
        })
    })
    target.on('update', () => { updates++ })
    target.on('updateV2', () => { updates++ })

    let failure = null
    try {
      apply(target, update)
    } catch (error) {
      failure = error
    } finally {
      Reflect.set(Map.prototype, 'has', nativeHas)
      Reflect.set(Map.prototype, 'get', nativeGet)
    }
    t.assert(failure instanceof Error, `${Encoder.name} spoofed root identity is rejected`)
    t.assert(target.share.get('text') === replacementRoot)
    t.assert(target.store.clients.size === 0 && target.store.causalHoles.isEmpty())
    t.assert(target.store.pendingStructs === null && target.store.pendingDs === null)
    t.assert(preparedRoot.toString() === '' && replacementRoot.toString() === '' && updates === 0)

    Reflect.apply(nativeSet, target.share, ['text', preparedRoot])
    apply(target, update)
    t.assert(target.get('text') === preparedRoot && preparedRoot.toString() === 'x')
    t.assert(target.store.getStruct(Y.createID(41, 0))?.constructor === CausalHole)
    t.assert(target.store.getStruct(Y.createID(41, 1))?.constructor === Y.Item)
  })
}

export const testSparseRootBatchUsesCapturedMapSet = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const target = new Y.Doc({ gc: false, sparseExactResolution: true })
    const update = encodeStructGroups([
      [
        new CausalHole(Y.createID(50, 0), 1, null, null, 'root-a', null),
        new Y.Item(Y.createID(50, 1), null, Y.createID(50, 0), null, null, null, null, new Y.ContentString('a'))
      ],
      [
        new CausalHole(Y.createID(40, 0), 1, null, null, 'root-b', null),
        new Y.Item(Y.createID(40, 1), null, Y.createID(40, 0), null, null, null, null, new Y.ContentString('b'))
      ]
    ], Encoder)
    const nativeSet = Map.prototype.set
    let inject = true
    let calls = 0
    target.on('beforeTransaction', () => {
      if (!inject) return
      inject = false
      Reflect.set(Map.prototype, 'set', /**
       * @this {Map<unknown,unknown>}
       * @param {unknown} key
       * @param {unknown} value
       */ function (key, value) {
          if (this === target.share && ++calls === 2) throw new Error('hostile second root')
          return Reflect.apply(nativeSet, this, [key, value])
        })
    })

    let failure = null
    try {
      apply(target, update)
    } catch (error) {
      failure = error
    } finally {
      Reflect.set(Map.prototype, 'set', nativeSet)
    }
    t.assert(failure === null && calls === 0, `${Encoder.name} commit uses the captured Map setter`)
    t.assert(target.get('root-a').toString() === 'a' && target.get('root-b').toString() === 'b')
    t.assert(target.store.getStruct(Y.createID(50, 1))?.constructor === Y.Item)
    t.assert(target.store.getStruct(Y.createID(40, 1))?.constructor === Y.Item)

    apply(target, update)
    t.assert(target.get('root-a').toString() === 'a' && target.get('root-b').toString() === 'b')
    t.assert(target.store.pendingStructs === null && target.store.pendingDs === null)
  })
}

export const testSparseLateArrayPushCannotSuppressRootPublication = () => {
  ;[
    { apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ apply, encode }) => {
    const source = new Y.Doc({ gc: false })
    source.get('late-push-root').insert(0, ['x'])
    const update = encode(source)
    const target = new Y.Doc({ gc: false, sparseExactResolution: true })
    const before = Array.from(encode(target))
    const originalPush = Array.prototype.push
    let arm = true
    let suppressed = 0
    let updates = 0
    target.on('beforeTransaction', () => {
      if (!arm) return
      arm = false
      Reflect.set(Array.prototype, 'push', /**
       * @this {Array<unknown>}
       * @param {...unknown} values
       */ function (...values) {
          const value = values[0]
          if (values.length === 1 && Array.isArray(value) && value[0] === 'late-push-root') {
            suppressed++
            return this.length
          }
          return Reflect.apply(originalPush, this, values)
        })
    })
    target.on('update', () => { updates++ })
    target.on('updateV2', () => { updates++ })

    let failure = null
    try {
      apply(target, update)
    } catch (error) {
      failure = error
    } finally {
      Reflect.set(Array.prototype, 'push', originalPush)
    }
    t.assert(Array.prototype.push === originalPush && ['clean'].length === 1)
    if (failure !== null) {
      t.compareArrays(Array.from(encode(target)), before)
      t.assert(!target.share.has('late-push-root') && target.store.clients.size === 0 && updates === 0)
      apply(target, update)
    } else {
      t.assert(suppressed === 0 || target.share.has('late-push-root'), 'successful apply must publish its prepared root')
    }
    t.assert(target.get('late-push-root').toArray()[0] === 'x')
    const snapshot = encode(target)
    const reload = new Y.Doc({ gc: false })
    apply(reload, snapshot)
    t.assert(reload.get('late-push-root').toArray()[0] === 'x')
  })
}

export const testSparseLateArrayIteratorCannotPartiallyPublishOrRedirectRoots = () => {
  ;[
    { apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ apply, encode }) => {
    /** @type {Array<string>} */
    const outcomes = []
    ;['throw', 'substitute'].forEach(mode => {
      const source = new Y.Doc({ gc: false })
      source.get('iterator-root-a').insert(0, ['a'])
      source.get('iterator-root-b').insert(0, ['b'])
      const update = encode(source)
      const target = new Y.Doc({ gc: false, sparseExactResolution: true })
      const before = Array.from(encode(target))
      const originalIterator = Array.prototype[Symbol.iterator]
      let arm = true
      let pairs = 0
      target.on('beforeTransaction', () => {
        if (!arm) return
        arm = false
        Reflect.set(Array.prototype, Symbol.iterator, /** @this {Array<unknown>} */ function () {
          const key = this[0]
          if (this.length === 2 && (key === 'iterator-root-a' || key === 'iterator-root-b') && this[1] instanceof Y.Type) {
            pairs++
            if (mode === 'throw' && pairs === 2) throw new Error('late install iterator failure')
            if (mode === 'substitute' && pairs === 1) {
              return Reflect.apply(originalIterator, ['redirected-root', this[1]], [])
            }
          }
          return Reflect.apply(originalIterator, this, [])
        })
      })

      let failure = null
      try {
        apply(target, update)
      } catch (error) {
        failure = error
      } finally {
        Reflect.set(Array.prototype, Symbol.iterator, originalIterator)
      }
      t.assert(Array.prototype[Symbol.iterator] === originalIterator && Array.from(['clean'])[0] === 'clean')
      const roots = Number(target.share.has('iterator-root-a')) + Number(target.share.has('iterator-root-b'))
      let safe = failure !== null
        ? roots === 0 && !target.share.has('redirected-root') && target.store.clients.size === 0 && Array.from(encode(target)).join(',') === before.join(',')
        : roots === 2 && !target.share.has('redirected-root') && target.get('iterator-root-a').toArray()[0] === 'a' && target.get('iterator-root-b').toArray()[0] === 'b'
      if (safe && failure !== null) {
        apply(target, update)
        safe = target.get('iterator-root-a').toArray()[0] === 'a' && target.get('iterator-root-b').toArray()[0] === 'b'
      }
      if (safe) {
        const reload = new Y.Doc({ gc: false })
        apply(reload, encode(target))
        safe = reload.get('iterator-root-a').toArray()[0] === 'a' && reload.get('iterator-root-b').toArray()[0] === 'b' && !reload.share.has('redirected-root')
      }
      outcomes.push(`${mode}:${safe}`)
    })
    t.assert(outcomes.every(outcome => outcome.endsWith(':true')), outcomes.join(', '))
  })
}

export const testSparsePreparedItemRootAssociationResistsLateMapPoison = () => {
  ;[
    { apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ apply, encode }) => {
    /** @type {Array<string>} */
    const outcomes = []
    ;['get', 'has'].forEach(mode => {
      const source = new Y.Doc({ gc: false })
      source.get('intended-root').insert(0, ['x'])
      const update = encode(source)
      const target = new Y.Doc({ gc: false, sparseExactResolution: true })
      const intendedRoot = target.get('intended-root')
      const redirectedRoot = target.get('redirected-root')
      const before = Array.from(encode(target))
      const originalGet = Map.prototype.get
      const originalHas = Map.prototype.has
      const originalSet = Map.prototype.set
      let arm = true
      target.on('beforeTransaction', () => {
        if (!arm) return
        arm = false
        Reflect.set(Map.prototype, 'get', /** @this {Map<unknown,unknown>} @param {unknown} key */ function (key) {
          if (mode === 'get' && key instanceof Y.Item && key.parent === 'intended-root') return redirectedRoot
          return Reflect.apply(originalGet, this, [key])
        })
        Reflect.set(Map.prototype, 'has', /** @this {Map<unknown,unknown>} @param {unknown} key */ function (key) {
          if (mode === 'has' && key instanceof Y.Item && key.parent === 'intended-root') {
            Reflect.apply(originalSet, this, [key, redirectedRoot])
            return true
          }
          return Reflect.apply(originalHas, this, [key])
        })
      })

      let failure = null
      try {
        apply(target, update)
      } catch (error) {
        failure = error
      } finally {
        Reflect.set(Map.prototype, 'get', originalGet)
        Reflect.set(Map.prototype, 'has', originalHas)
      }
      t.assert(Map.prototype.get === originalGet && Map.prototype.has === originalHas && new Map([['clean', true]]).get('clean') === true)
      let safe = failure !== null
        ? target.store.clients.size === 0 && intendedRoot.length === 0 && redirectedRoot.length === 0 && Array.from(encode(target)).join(',') === before.join(',')
        : intendedRoot.toArray()[0] === 'x' && redirectedRoot.length === 0
      if (safe && failure !== null) {
        apply(target, update)
        safe = intendedRoot.toArray()[0] === 'x' && redirectedRoot.length === 0
      }
      if (safe) {
        const reload = new Y.Doc({ gc: false })
        apply(reload, encode(target))
        safe = reload.get('intended-root').toArray()[0] === 'x' && reload.get('redirected-root').length === 0
      }
      outcomes.push(`${mode}:${safe}`)
    })
    t.assert(outcomes.every(outcome => outcome.endsWith(':true')), outcomes.join(', '))
  })
}

export const testSparseStructuralRevisionWeakMapFailureCannotPublishRoot = () => {
  ;[
    { apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ apply, encode }) => {
    const source = new Y.Doc({ gc: false })
    source.get('revision-root').insert(0, ['x'])
    const update = encode(source)
    const target = new Y.Doc({ gc: false, sparseExactResolution: true })
    const before = Array.from(encode(target))
    const originalSet = WeakMap.prototype.set
    let arm = true
    let updates = 0
    target.on('beforeTransaction', () => {
      if (!arm) return
      arm = false
      Reflect.set(WeakMap.prototype, 'set', /** @this {WeakMap<object,unknown>} @param {object} key @param {unknown} value */ function (key, value) {
        if (key === target.store) throw new Error('late structural revision failure')
        return Reflect.apply(originalSet, this, [key, value])
      })
    })
    target.on('update', () => { updates++ })
    target.on('updateV2', () => { updates++ })

    let failure = null
    try {
      apply(target, update)
    } catch (error) {
      failure = error
    } finally {
      Reflect.set(WeakMap.prototype, 'set', originalSet)
    }
    const weakKey = {}
    t.assert(WeakMap.prototype.set === originalSet && new WeakMap().set(weakKey, true).get(weakKey) === true)
    if (failure !== null) {
      t.assert(!target.share.has('revision-root'), 'failed structural revision must not publish its staged root')
      t.compareArrays(Array.from(encode(target)), before)
      t.assert(target.store.clients.size === 0 && updates === 0)
      apply(target, update)
    }
    t.assert(target.get('revision-root').toArray()[0] === 'x')
    const reload = new Y.Doc({ gc: false })
    apply(reload, encode(target))
    t.assert(reload.get('revision-root').toArray()[0] === 'x')
  })
}

export const testSparseShareAuthorityPropertyIsStableAndOrdinaryCompatible = () => {
  const ordinary = new Y.Doc({ gc: false })
  const ordinaryDescriptor = Object.getOwnPropertyDescriptor(ordinary, 'share')
  const assignedShare = new Map()
  ordinary.share = assignedShare
  const definedShare = new Map()
  Object.defineProperty(ordinary, 'share', { value: definedShare })
  t.assert(
    ordinaryDescriptor?.value instanceof Map && ordinaryDescriptor.writable === true &&
    ordinaryDescriptor.configurable === true && ordinaryDescriptor.enumerable === true &&
    ordinary.share === definedShare
  )

  /** @type {Array<string>} */
  const outcomes = []
  ;[
    { apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ apply, encode, event }) => {
    const source = new Y.Doc({ gc: false })
    source.get('authority-root').insert(0, ['x'])
    const target = new Y.Doc({ gc: false, sparseExactResolution: true })
    const authority = target.share
    const replacement = new Map(authority)
    const descriptor = Object.getOwnPropertyDescriptor(target, 'share')
    let assignmentFailure = null
    let definitionFailure = null
    try {
      target.share = replacement
    } catch (error) {
      assignmentFailure = error
    }
    if (target.share !== authority) target.share = authority
    try {
      Object.defineProperty(target, 'share', { value: replacement })
    } catch (error) {
      definitionFailure = error
    }
    if (target.share !== authority) target.share = authority

    const sealed =
      descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
      descriptor.value === authority && descriptor.writable === false && descriptor.configurable === false &&
      descriptor.enumerable === true && assignmentFailure instanceof Error && definitionFailure instanceof Error &&
      target.share === authority
    apply(target, encode(source))
    const reload = new Y.Doc({ gc: false })
    apply(reload, encode(target))
    outcomes.push(`${event}:${sealed && target.share === authority && target.get('authority-root').toArray()[0] === 'x' && reload.get('authority-root').toArray()[0] === 'x'}`)
  })
  t.assert(outcomes.every(outcome => outcome.endsWith(':true')), outcomes.join(', '))
}

export const testSparseSubdocConstructorCannotReplaceHostShare = () => {
  ;[
    { apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ apply, encode, event }) => {
    let host = /** @type {Y.Doc|null} */ (null)
    let replaceShare = true
    let constructions = 0
    let attemptedShare = /** @type {Map<string,Y.Type>|null} */ (null)
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super(opts)
        if (opts?.guid === 'replace-host-share') {
          constructions++
          if (host !== null && replaceShare) {
            attemptedShare = new Map(host.share)
            host.share = attemptedShare
          }
        }
      }
    }

    const source = new Y.Doc({ gc: false })
    source.get('docs').insert(0, [new Y.Doc({ guid: 'replace-host-share', gc: false })])
    source.get('text').insert(0, ['x'])
    const update = encode(source)
    host = new TargetDoc({ gc: false, sparseExactResolution: true })
    const authority = host.share
    const existing = host.get('existing-root')
    existing.insert(0, ['base'])
    const before = Array.from(encode(host))
    const beforeState = Array.from(Y.encodeStateVector(host))
    const beforeClients = new Map(host.store.clients)
    const pendingStructs = host.store.pendingStructs
    const pendingDs = host.store.pendingDs
    const revision = getStructuralRevision(host.store)
    const failedRuns = _testOnlyGetSparseFailedPlanRuns(host)
    const proofRuns = _testOnlyGetSparsePendingProofRuns(host)
    let updates = 0
    let transactions = 0
    let subdocs = 0
    host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
    host.on('afterTransaction', () => { transactions++ })
    host.on('subdocs', () => { subdocs++ })

    t.fails(() => apply(/** @type {Y.Doc} */ (host), update))
    t.assert(constructions === 1 && host.share === authority && attemptedShare !== authority)
    t.assert(authority.size === 1 && authority.get('existing-root') === existing && existing.toArray()[0] === 'base')
    t.compareArrays(Array.from(encode(host)), before)
    t.compareArrays(Array.from(Y.encodeStateVector(host)), beforeState)
    t.assert(host.store.clients.size === beforeClients.size && [...beforeClients].every(([client, structs]) => host?.store.clients.get(client) === structs))
    t.assert(host.store.pendingStructs === pendingStructs && host.store.pendingDs === pendingDs && host.subdocs.size === 0)
    t.assert(getStructuralRevision(host.store) === revision)
    t.assert(_testOnlyGetSparseFailedPlanRuns(host) === failedRuns && _testOnlyGetSparsePendingProofRuns(host) === proofRuns)
    t.assert(updates === 0 && transactions === 0 && subdocs === 0, `${event} constructor replacement failure is prewrite`)

    replaceShare = false
    apply(host, update)
    t.assert(constructions === 2 && host.share === authority && updates === 1 && transactions === 1 && subdocs === 1)
    t.assert(host.get('text').toArray()[0] === 'x' && existing.toArray()[0] === 'base')
    t.assert(/** @type {Y.Doc} */ (host.get('docs').get(0)).guid === 'replace-host-share')
    const reload = new Y.Doc({ gc: false })
    apply(reload, encode(host))
    t.assert(reload.get('text').toArray()[0] === 'x' && reload.get('existing-root').toArray()[0] === 'base')
    t.assert(/** @type {Y.Doc} */ (reload.get('docs').get(0)).guid === 'replace-host-share')
  })
}

export const testSparsePreparedSubdocAdmissionRejectsHostileResults = () => {
  /** @type {Array<string>} */
  const outcomes = []
  ;[
    { apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ apply, encode, event }) => {
    ;['proxy', 'reused', 'accessors'].forEach(mode => {
      let hostile = false
      let reusedDoc = /** @type {Y.Doc|null} */ (null)
      class TargetDoc extends Y.Doc {
        /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
        constructor (opts) {
          super(opts)
          if (!hostile || opts?.guid !== `hostile-${mode}`) return
          if (mode === 'proxy') {
            return new Proxy(this, {
              get: (target, key, receiver) => key === '_item' ? null : Reflect.get(target, key, receiver)
            })
          }
          if (mode === 'reused' && reusedDoc !== null) return /** @type {any} */ (reusedDoc)
          Object.defineProperty(this, '_item', {
            get: () => null,
            set: (/** @type {unknown} */ _value) => {},
            configurable: true
          })
          Object.defineProperty(this, 'shouldLoad', {
            get: () => { throw new Error('hostile shouldLoad') },
            set: (/** @type {unknown} */ _value) => {},
            configurable: true
          })
        }
      }
      if (mode === 'reused') reusedDoc = new TargetDoc({ guid: `hostile-${mode}`, autoLoad: true })
      hostile = true

      const source = new Y.Doc({ gc: false })
      source.get('docs').insert(0, [new Y.Doc({ guid: `hostile-${mode}`, autoLoad: true })])
      source.get('text').insert(0, ['x'])
      const update = encode(source)
      const host = new TargetDoc({ gc: false, sparseExactResolution: true })
      const authority = host.share
      const existing = host.get('existing-root')
      existing.insert(0, ['base'])
      const before = Array.from(encode(host))
      const beforeState = Array.from(Y.encodeStateVector(host))
      const beforeClients = new Map(host.store.clients)
      const pendingStructs = host.store.pendingStructs
      const pendingDs = host.store.pendingDs
      const revision = getStructuralRevision(host.store)
      const failedRuns = _testOnlyGetSparseFailedPlanRuns(host)
      const proofRuns = _testOnlyGetSparsePendingProofRuns(host)
      let updates = 0
      let transactions = 0
      let subdocs = 0
      host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
      host.on('afterTransaction', () => { transactions++ })
      host.on('subdocs', () => { subdocs++ })

      let failure = null
      try {
        apply(host, update)
      } catch (error) {
        failure = error
      }
      let unchanged = false
      try {
        unchanged =
          failure instanceof Error && host.share === authority && authority.size === 1 &&
          authority.get('existing-root') === existing && existing.toArray()[0] === 'base' &&
          Array.from(encode(host)).join(',') === before.join(',') &&
          Array.from(Y.encodeStateVector(host)).join(',') === beforeState.join(',') &&
          host.store.clients.size === beforeClients.size &&
          [...beforeClients].every(([client, structs]) => host.store.clients.get(client) === structs) &&
          host.store.pendingStructs === pendingStructs && host.store.pendingDs === pendingDs &&
          host.subdocs.size === 0 && getStructuralRevision(host.store) === revision &&
          _testOnlyGetSparseFailedPlanRuns(host) === failedRuns && _testOnlyGetSparsePendingProofRuns(host) === proofRuns &&
          (reusedDoc === null || reusedDoc.isDestroyed === false) &&
          updates === 0 && transactions === 0 && subdocs === 0
      } catch (_) {}

      let retry = false
      if (unchanged) {
        hostile = false
        apply(host, update)
        const visible = host.get('docs').get(0)
        const reload = new Y.Doc({ gc: false })
        apply(reload, encode(host))
        const reloaded = reload.get('docs').get(0)
        retry =
          visible instanceof Y.Doc && visible.guid === `hostile-${mode}` && visible.isDestroyed === false && visible.shouldLoad === true &&
          host.subdocs.size === 1 && host.subdocs.has(visible) && host.get('text').toArray()[0] === 'x' &&
          existing.toArray()[0] === 'base' && updates === 1 && transactions === 1 && subdocs === 1 &&
          reloaded instanceof Y.Doc && reloaded.guid === `hostile-${mode}` && reloaded.isDestroyed === false &&
          reload.subdocs.size === 1 && reload.get('text').toArray()[0] === 'x' && reload.get('existing-root').toArray()[0] === 'base'
      }
      outcomes.push(`${event}-${mode}:${unchanged && retry}`)
    })
  })
  t.assert(outcomes.every(outcome => outcome.endsWith(':true')), outcomes.join(', '))
}

export const testSparsePreparedSubdocCommitTaintRejectsWithoutCleanupDestroy = () => {
  /** @type {Array<string>} */
  const outcomes = []
  ;[
    { apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ apply, encode, event }) => {
    ;['_item', 'shouldLoad'].forEach(property => {
      let taint = true
      let candidateDestroys = 0
      /** @type {Array<Y.Doc>} */
      const candidates = []
      class TargetDoc extends Y.Doc {
        /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
        constructor (opts) {
          super(opts)
          if (opts?.guid === `late-${property}`) {
            candidates.push(this)
            this.on('destroy', () => { candidateDestroys++ })
          }
        }
      }

      const source = new Y.Doc({ gc: false })
      source.get('docs').insert(0, [new Y.Doc({ guid: `late-${property}`, autoLoad: true })])
      source.get('text').insert(0, ['x'])
      const update = encode(source)
      const host = new TargetDoc({ gc: false, sparseExactResolution: true })
      const authority = host.share
      const existing = host.get('existing-root')
      existing.insert(0, ['base'])
      const before = Array.from(encode(host))
      const beforeState = Array.from(Y.encodeStateVector(host))
      const beforeClients = new Map(host.store.clients)
      const pendingStructs = host.store.pendingStructs
      const pendingDs = host.store.pendingDs
      const revision = getStructuralRevision(host.store)
      const failedRuns = _testOnlyGetSparseFailedPlanRuns(host)
      const proofRuns = _testOnlyGetSparsePendingProofRuns(host)
      let hooks = 0
      let updates = 0
      let transactions = 0
      let subdocs = 0
      host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
      host.on('afterTransaction', () => { transactions++ })
      host.on('subdocs', () => { subdocs++ })
      host.on('beforeTransaction', () => {
        hooks++
        if (!taint) return
        const candidate = candidates[candidates.length - 1]
        Object.defineProperty(candidate, property, {
          get: () => { throw new Error(`late ${property} access`) },
          set: (/** @type {unknown} */ _value) => {},
          configurable: true
        })
      })

      let failure = null
      try { apply(host, update) } catch (error) { failure = error }
      const rejected =
        failure instanceof Error && candidates.length === 1 && candidates[0].isDestroyed === false && candidateDestroys === 0 &&
        hooks === 1 && host.share === authority && authority.size === 1 && authority.get('existing-root') === existing &&
        existing.toArray()[0] === 'base' && Array.from(encode(host)).join(',') === before.join(',') &&
        Array.from(Y.encodeStateVector(host)).join(',') === beforeState.join(',') && host.store.clients.size === beforeClients.size &&
        [...beforeClients].every(([client, structs]) => host.store.clients.get(client) === structs) &&
        host.store.pendingStructs === pendingStructs && host.store.pendingDs === pendingDs && host.subdocs.size === 0 &&
        getStructuralRevision(host.store) === revision && _testOnlyGetSparseFailedPlanRuns(host) === failedRuns &&
        _testOnlyGetSparsePendingProofRuns(host) === proofRuns && updates === 0 && transactions === 1 && subdocs === 0

      let retry = false
      if (rejected) {
        taint = false
        apply(host, update)
        const visible = host.get('docs').get(0)
        const reload = new Y.Doc({ gc: false })
        apply(reload, encode(host))
        const reloaded = reload.get('docs').get(0)
        retry =
          candidates.length === 2 && candidates[0] !== candidates[1] && candidateDestroys === 0 &&
          candidates.every(candidate => candidate.isDestroyed === false) && visible === candidates[1] &&
          visible instanceof Y.Doc && visible.guid === `late-${property}` && visible.shouldLoad === true &&
          host.subdocs.size === 1 && host.subdocs.has(visible) && host.get('text').toArray()[0] === 'x' &&
          existing.toArray()[0] === 'base' && hooks === 2 && updates === 1 && transactions === 2 && subdocs === 1 &&
          reloaded instanceof Y.Doc && reloaded.guid === `late-${property}` && reloaded.shouldLoad === true &&
          reload.subdocs.size === 1 && reload.get('text').toArray()[0] === 'x' && reload.get('existing-root').toArray()[0] === 'base'
      }
      outcomes.push(`${event}-${property}:${rejected && retry}`)
    })
  })
  t.assert(outcomes.every(outcome => outcome.endsWith(':true')), outcomes.join(', '))
}

export const testSparsePreparedSubdocCleanupCannotAliasForeignItem = () => {
  /** @type {Array<string>} */
  const outcomes = []
  ;[
    { apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ apply, encode, event }) => {
    const foreignParent = new Y.Doc({ gc: false })
    const foreign = new Y.Doc({ guid: 'foreign', gc: false })
    foreignParent.get('docs').insert(0, [foreign])
    const foreignItem = /** @type {Y.Item} */ (foreign._item)
    const foreignContent = /** @type {Y.ContentDoc} */ (foreignItem.content)
    const foreignBefore = Array.from(encode(foreignParent))
    const foreignState = Array.from(Y.encodeStateVector(foreignParent))
    let foreignUpdates = 0
    let foreignSubdocs = 0
    foreignParent.on('update', () => { foreignUpdates++ })
    foreignParent.on('updateV2', () => { foreignUpdates++ })
    foreignParent.on('subdocs', () => { foreignSubdocs++ })

    /** @type {Array<Y.Doc>} */
    const candidates = []
    let cleanupTraps = 0
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super(opts)
        if (opts?.guid === 'cleanup-candidate') {
          candidates.push(this)
          this.get('cleanup-trap').on('destroy', () => {
            cleanupTraps++
            this._item = foreignItem
          })
        }
      }
    }

    const source = new Y.Doc({ gc: false })
    source.get('docs').insert(0, [new Y.Doc({ guid: 'cleanup-candidate' })])
    source.get('text').insert(0, ['x'])
    const update = encode(source)
    const host = new TargetDoc({ gc: false, sparseExactResolution: true })
    const authority = host.share
    const existing = host.get('existing-root')
    existing.insert(0, ['base'])
    const before = Array.from(encode(host))
    const beforeState = Array.from(Y.encodeStateVector(host))
    const beforeClients = new Map(host.store.clients)
    const pendingStructs = host.store.pendingStructs
    const pendingDs = host.store.pendingDs
    const revision = getStructuralRevision(host.store)
    const failedRuns = _testOnlyGetSparseFailedPlanRuns(host)
    const proofRuns = _testOnlyGetSparsePendingProofRuns(host)
    let hookRoot = /** @type {Y.Type|null} */ (null)
    let hookRevision = revision
    let updates = 0
    let subdocs = 0
    host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
    host.on('subdocs', () => { subdocs++ })
    const invalidatePlan = () => {
      hookRoot = host.get('hook-root')
      hookRevision = getStructuralRevision(host.store)
    }
    host.on('beforeTransaction', invalidatePlan)

    let failure = null
    try { apply(host, update) } catch (error) { failure = error } finally { host.off('beforeTransaction', invalidatePlan) }
    const rejected =
      failure instanceof Error && candidates.length === 1 &&
      candidates[0].isDestroyed === false && cleanupTraps === 0 &&
      foreignContent.doc === foreign && foreignParent.get('docs').get(0) === foreign && foreign.isDestroyed === false &&
      foreignParent.subdocs.size === 1 && foreignParent.subdocs.has(foreign) && foreignUpdates === 0 && foreignSubdocs === 0 &&
      Array.from(encode(foreignParent)).join(',') === foreignBefore.join(',') &&
      Array.from(Y.encodeStateVector(foreignParent)).join(',') === foreignState.join(',') &&
      host.share === authority && authority.size === 2 && authority.get('existing-root') === existing &&
      hookRoot !== null && authority.get('hook-root') === hookRoot && hookRevision > revision &&
      existing.toArray()[0] === 'base' && Array.from(encode(host)).join(',') === before.join(',') &&
      Array.from(Y.encodeStateVector(host)).join(',') === beforeState.join(',') && host.store.clients.size === beforeClients.size &&
      [...beforeClients].every(([client, structs]) => host.store.clients.get(client) === structs) &&
      host.store.pendingStructs === pendingStructs && host.store.pendingDs === pendingDs && host.subdocs.size === 0 &&
      getStructuralRevision(host.store) === hookRevision && _testOnlyGetSparseFailedPlanRuns(host) === failedRuns &&
      _testOnlyGetSparsePendingProofRuns(host) === proofRuns && updates === 0 && subdocs === 0

    let retry = false
    if (rejected) {
      apply(host, update)
      const visible = host.get('docs').get(0)
      const reload = new Y.Doc({ gc: false })
      apply(reload, encode(host))
      const reloaded = reload.get('docs').get(0)
      retry =
        candidates.length === 2 && candidates[0] !== candidates[1] && candidates[1].isDestroyed === false &&
        visible === candidates[1] && visible instanceof Y.Doc && visible.guid === 'cleanup-candidate' &&
        host.subdocs.size === 1 && host.subdocs.has(visible) && host.get('text').toArray()[0] === 'x' &&
        existing.toArray()[0] === 'base' && updates === 1 && subdocs === 1 &&
        reloaded instanceof Y.Doc && reloaded.guid === 'cleanup-candidate' && reload.subdocs.size === 1 &&
        reload.get('text').toArray()[0] === 'x' && reload.get('existing-root').toArray()[0] === 'base' &&
        foreignContent.doc === foreign && foreignParent.get('docs').get(0) === foreign && foreignParent.subdocs.size === 1 &&
        foreignParent.subdocs.has(foreign) && foreignUpdates === 0 && foreignSubdocs === 0 &&
        Array.from(encode(foreignParent)).join(',') === foreignBefore.join(',')
    }
    outcomes.push(`${event}:${rejected && retry}`)
  })
  t.assert(outcomes.every(outcome => outcome.endsWith(':true')), outcomes.join(', '))
}

export const testSparseSubdocConstructorDestroyRejectsWithoutMutation = () => {
  /** @type {Array<string>} */
  const outcomes = []
  ;[
    { apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ apply, encode, event }) => {
    let host = /** @type {Y.Doc|null} */ (null)
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super(opts)
        if (opts?.guid === 'destroy-host-during-plan') host?.destroy()
      }
    }
    const source = new Y.Doc({ gc: false })
    source.get('docs').insert(0, [new Y.Doc({ guid: 'destroy-host-during-plan' })])
    source.get('text').insert(0, ['x'])
    const update = encode(source)
    host = new TargetDoc({ gc: false, sparseExactResolution: true })
    const beforeState = Array.from(Y.encodeStateVector(host))
    const revision = getStructuralRevision(host.store)
    const failedRuns = _testOnlyGetSparseFailedPlanRuns(host)
    const proofRuns = _testOnlyGetSparsePendingProofRuns(host)
    const pendingStructs = host.store.pendingStructs
    const pendingDs = host.store.pendingDs
    let destroys = 0
    let updates = 0
    let transactions = 0
    let subdocs = 0
    host.on('destroy', () => { destroys++ })
    host.on('update', () => { updates++ })
    host.on('updateV2', () => { updates++ })
    host.on('afterTransaction', () => { transactions++ })
    host.on('subdocs', () => { subdocs++ })

    let failure = null
    try { apply(host, update) } catch (error) { failure = error }
    let retryFailure = null
    try { apply(host, update) } catch (error) { retryFailure = error }
    let serializationFailure = null
    try { encode(host) } catch (error) { serializationFailure = error }
    outcomes.push(`${event}:${
      failure instanceof Error && retryFailure instanceof Error && serializationFailure instanceof Error &&
      host.isDestroyed && destroys === 1 && updates === 0 && transactions === 0 && subdocs === 0 &&
      host.share.size === 0 && host.subdocs.size === 0 && host.store.clients.size === 0 &&
      Array.from(Y.encodeStateVector(host)).join(',') === beforeState.join(',') &&
      host.store.pendingStructs === pendingStructs && host.store.pendingDs === pendingDs &&
      getStructuralRevision(host.store) === revision && _testOnlyGetSparseFailedPlanRuns(host) === failedRuns &&
      _testOnlyGetSparsePendingProofRuns(host) === proofRuns
    }`)
  })
  t.assert(outcomes.every(outcome => outcome.endsWith(':true')), outcomes.join(', '))
}

export const testSparseBeforeTransactionDestroyRejectsWithoutMutation = () => {
  /** @type {Array<string>} */
  const outcomes = []
  ;[
    { apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ apply, encode, event }) => {
    const source = new Y.Doc({ gc: false })
    source.get('docs').insert(0, [new Y.Doc({ guid: 'destroy-host-before-commit' })])
    source.get('text').insert(0, ['x'])
    const update = encode(source)
    const host = new Y.Doc({ gc: false, sparseExactResolution: true })
    const beforeState = Array.from(Y.encodeStateVector(host))
    const revision = getStructuralRevision(host.store)
    const failedRuns = _testOnlyGetSparseFailedPlanRuns(host)
    const proofRuns = _testOnlyGetSparsePendingProofRuns(host)
    const pendingStructs = host.store.pendingStructs
    const pendingDs = host.store.pendingDs
    let hooks = 0
    let destroys = 0
    let updates = 0
    let transactions = 0
    let subdocs = 0
    host.on('destroy', () => { destroys++ })
    host.on('update', () => { updates++ })
    host.on('updateV2', () => { updates++ })
    host.on('afterTransaction', () => { transactions++ })
    host.on('subdocs', () => { subdocs++ })
    host.on('beforeTransaction', () => { hooks++; host.destroy() })

    let failure = null
    try { apply(host, update) } catch (error) { failure = error }
    let retryFailure = null
    try { apply(host, update) } catch (error) { retryFailure = error }
    let serializationFailure = null
    try { encode(host) } catch (error) { serializationFailure = error }
    outcomes.push(`${event}:${
      failure instanceof Error && retryFailure instanceof Error && serializationFailure instanceof Error &&
      host.isDestroyed && hooks === 1 && destroys === 1 && updates === 0 && transactions === 0 && subdocs === 0 &&
      host.share.size === 0 && host.subdocs.size === 0 && host.store.clients.size === 0 &&
      Array.from(Y.encodeStateVector(host)).join(',') === beforeState.join(',') &&
      host.store.pendingStructs === pendingStructs && host.store.pendingDs === pendingDs &&
      getStructuralRevision(host.store) === revision && _testOnlyGetSparseFailedPlanRuns(host) === failedRuns &&
      _testOnlyGetSparsePendingProofRuns(host) === proofRuns
    }`)
  })
  t.assert(outcomes.every(outcome => outcome.endsWith(':true')), outcomes.join(', '))
}

export const testC28PreparedSubdocCleanupOwnsLateIdentityTaint = () => {
  c28Transports.forEach(({ label, apply, encode, event }) => {
    ;['clientID', 'collectionid'].forEach(property => {
      /** @type {Array<Y.Doc>} */
      const candidates = []
      class TargetDoc extends Y.Doc {
        /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
        constructor (opts) {
          super(opts)
          if (opts?.guid === `c28-late-${property}`) candidates.push(this)
        }
      }
      const source = new Y.Doc({ gc: false })
      source.get('docs').insert(0, [new Y.Doc({ guid: `c28-late-${property}`, autoLoad: true })])
      source.get('text').insert(0, ['x'])
      const host = new TargetDoc({ gc: false, sparseExactResolution: true, collectionid: 'c28-collection' })
      let transactions = 0
      let cleanups = 0
      let updates = 0
      let subdocs = 0
      host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
      host.on('subdocs', () => { subdocs++ })
      host.on('afterTransactionCleanup', () => { cleanups++ })
      host.on('afterTransaction', () => {
        transactions++
        const candidate = candidates[candidates.length - 1]
        Object.defineProperty(candidate, property, {
          get: () => { throw new Error(`tainted ${property} getter`) },
          set: () => { throw new Error(`tainted ${property} setter`) },
          configurable: false
        })
      })

      let failure = null
      try { apply(host, encode(source)) } catch (error) { failure = error }
      t.assert(failure === null, `${label} ${property} cleanup must not become a committed error`)
      const child = /** @type {Y.Doc} */ (host.get('docs').get(0))
      t.assert(
        candidates.length === 1 && child === candidates[0] && child.shouldLoad &&
        host.subdocs.size === 1 && host.subdocs.has(child),
        `${label} ${property} child admission`
      )
      t.assert(transactions === 1 && cleanups === 1 && updates === 1 && subdocs === 1, `${label} ${property} events`)
      t.assert(host._transaction === null && host._transactionCleanups.length === 0, `${label} ${property} cleanup queue`)
      const snapshot = encode(host)
      const reload = new Y.Doc({ gc: false, collectionid: 'c28-collection' })
      apply(reload, snapshot)
      const reloaded = /** @type {Y.Doc} */ (reload.get('docs').get(0))
      t.assert(reloaded.guid === child.guid && reload.subdocs.has(reloaded) && reload.get('text').get(0) === 'x')
    })
  })
}

export const testC28ConstructorReturnedSubdocMustMatchWireIdentity = () => {
  c28Transports.forEach(({ label, apply, encode, event }) => {
    ;['guid', 'gc', 'sparse', 'shouldLoad', 'autoLoad', 'meta'].forEach(property => {
      let hostile = true
      /** @type {Array<Y.Doc>} */
      const candidates = []
      class TargetDoc extends Y.Doc {
        /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
        constructor (opts) {
          super(opts)
          if (!hostile || opts?.guid !== `c28-wire-${property}`) return
          const wrong = { ...opts }
          if (property === 'guid') wrong.guid = 'c28-wrong-guid'
          if (property === 'gc') wrong.gc = true
          if (property === 'sparse') {
            wrong.gc = false
            wrong.sparseExactResolution = true
          }
          if (property === 'shouldLoad') wrong.shouldLoad = false
          if (property === 'autoLoad') wrong.autoLoad = false
          if (property === 'meta') wrong.meta = { value: 'wrong' }
          const candidate = new Y.Doc(wrong)
          candidates.push(candidate)
          return candidate
        }
      }
      const source = new Y.Doc({ gc: false })
      source.get('docs').insert(0, [new Y.Doc({ guid: `c28-wire-${property}`, gc: false, autoLoad: true, meta: { value: 'expected' } })])
      source.get('text').insert(0, ['x'])
      const host = new TargetDoc({ gc: false, sparseExactResolution: true })
      const existing = host.get('existing')
      existing.insert(0, ['base'])
      const before = captureC28State(host, encode)
      let updates = 0
      let transactions = 0
      let subdocs = 0
      host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
      host.on('afterTransaction', () => { transactions++ })
      host.on('subdocs', () => { subdocs++ })

      t.fails(() => apply(host, encode(source)))
      assertC28State(host, encode, before, `${label} ${property}`)
      t.assert(candidates.length === 1 && !candidates[0].isDestroyed && updates === 0 && transactions === 0 && subdocs === 0)

      hostile = false
      apply(host, encode(source))
      const child = /** @type {Y.Doc} */ (host.get('docs').get(0))
      t.assert(
        child.guid === `c28-wire-${property}` && child.gc === false && !child.sparseExactResolution &&
        child.shouldLoad && child.autoLoad && child.meta?.value === 'expected' && host.subdocs.has(child) &&
        host.get('text').get(0) === 'x' && existing.get(0) === 'base',
        `${label} ${property} clean retry`
      )
      t.assert(updates === 1 && transactions === 1 && subdocs === 1 && host._transactionCleanups.length === 0)
      const reload = new Y.Doc({ gc: false })
      apply(reload, encode(host))
      t.assert(/** @type {Y.Doc} */ (reload.get('docs').get(0)).guid === child.guid && reload.get('text').get(0) === 'x')
    })
  })
}

export const testC28DestroyedSparseProxyRejectsApplyAndEncode = () => {
  c28Transports.forEach(({ label, apply, encode }) => {
    const source = new Y.Doc({ gc: false })
    source.clientID = 2
    source.get('incoming').insert(0, ['x'])
    const backing = new Y.Doc({ gc: false, sparseExactResolution: true })
    backing.clientID = 1
    const base = backing.get('base')
    base.insert(0, ['kept'])
    const beforeBytes = Array.from(encode(backing))
    const beforeState = Array.from(Y.encodeStateVector(backing))
    const beforeClients = new Map(backing.store.clients)
    const pendingStructs = backing.store.pendingStructs
    const pendingDs = backing.store.pendingDs
    backing.destroy()
    const proxy = new Proxy(backing, {})

    let applyFailure = null
    try { apply(proxy, encode(source)) } catch (error) { applyFailure = error }
    let encodeFailure = null
    try { encode(proxy) } catch (error) { encodeFailure = error }
    t.assert(applyFailure instanceof Error && encodeFailure instanceof Error, `${label} destroyed backing identity`)
    t.compareArrays(Array.from(Y.encodeStateVector(backing)), beforeState)
    t.assert(
      backing.isDestroyed && base.get(0) === 'kept' && !backing.share.has('incoming') &&
      backing.store.clients.size === beforeClients.size && [...beforeClients].every(([client, structs]) => backing.store.clients.get(client) === structs) &&
      backing.store.pendingStructs === pendingStructs && backing.store.pendingDs === pendingDs && backing._transactionCleanups.length === 0 &&
      beforeBytes.length > 0,
      `${label} destroyed backing remains unchanged`
    )
  })
}

export const testC28SparseSubdocAdmissionUsesOwnedSetAdd = () => {
  const nativeAdd = Set.prototype.add
  const nativeClear = Set.prototype.clear
  c28Transports.forEach(({ label, apply, encode, event }) => {
    let candidate = /** @type {Y.Doc|null} */ (null)
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super(opts)
        if (opts?.guid === `c28-owned-${label}`) candidate = this
      }
    }
    const source = new Y.Doc({ gc: false })
    source.get('docs').insert(0, [new Y.Doc({ guid: `c28-owned-${label}`, autoLoad: true })])
    source.get('text').insert(0, ['x'])
    const host = new TargetDoc({ gc: false, sparseExactResolution: true })
    const forged = new Y.Doc({ guid: `c28-forged-${label}` })
    const existing = host.get('existing')
    existing.insert(0, ['base'])
    let hooks = 0
    let taints = 0
    let shadowCalls = 0
    let updates = 0
    let transactions = 0
    let subdocs = 0
    let subdocEvent = /** @type {{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}|null} */ (null)
    /** @param {Y.Transaction} transaction */
    const forgePublicSets = transaction => {
      taints++
      ;[transaction.subdocsAdded, transaction.subdocsLoaded, transaction.subdocsRemoved].forEach(set => {
        Reflect.apply(nativeClear, set, [])
        Reflect.apply(nativeAdd, set, [forged])
      })
    }
    host.on('beforeTransaction', transaction => {
      hooks++
      transaction.subdocsAdded.add = () => {
        shadowCalls++
        throw new Error('shadowed subdoc admission')
      }
    })
    host.on('beforeObserverCalls', forgePublicSets)
    host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
    host.on('afterTransaction', transaction => {
      transactions++
      forgePublicSets(transaction)
      const child = /** @type {Y.Doc} */ (candidate)
      ;['clientID', 'collectionid'].forEach(property => Object.defineProperty(child, property, {
        get: () => { throw new Error(`late ${property} read`) },
        set: () => { throw new Error(`late ${property} write`) },
        configurable: false
      }))
    })
    host.on('subdocs', subdocSets => { subdocs++; subdocEvent = subdocSets })

    let failure = null
    try { apply(host, encode(source)) } catch (error) { failure = error }
    t.assert(failure === null && shadowCalls === 0, `${label} admission bypasses the shadowed add`)
    const child = /** @type {Y.Doc} */ (host.get('docs').get(0))
    const emitted = /** @type {NonNullable<typeof subdocEvent>} */ (subdocEvent)
    t.assert(
      child === candidate && child.guid === `c28-owned-${label}` && host.subdocs.size === 1 && host.subdocs.has(child) && !host.subdocs.has(forged) &&
      emitted.added.size === 1 && emitted.added.has(child) && emitted.loaded.size === 1 && emitted.loaded.has(child) &&
      emitted.removed.size === 0 && !emitted.added.has(forged) && !emitted.loaded.has(forged) &&
      host.get('text').get(0) === 'x' && existing.get(0) === 'base' && host.store.pendingStructs === null && host.store.pendingDs === null,
      `${label} full subdoc commit`
    )
    t.assert(hooks === 1 && taints === 2 && updates === 1 && transactions === 1 && subdocs === 1 && host._transaction === null && host._transactionCleanups.length === 0)
    const reload = new Y.Doc({ gc: false })
    apply(reload, encode(host))
    const reloaded = /** @type {Y.Doc} */ (reload.get('docs').get(0))
    t.assert(reload.subdocs.has(reloaded) && reloaded.guid === child.guid && reload.get('text').get(0) === 'x')
  })
}

export const testC28PreparedSubdocCannotEraseForeignAdmission = () => {
  c28Transports.forEach(({ label, apply, encode, event }) => {
    const foreignParent = new Y.Doc({ gc: false })
    let hostile = true
    let candidate = /** @type {Y.Doc|null} */ (null)
    let foreignBefore = /** @type {ReturnType<typeof captureC28State>|null} */ (null)
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super(opts)
        if (!hostile || opts?.guid !== `c28-foreign-${label}`) return
        const returned = new Y.Doc(opts)
        const clientID = returned.clientID
        const collectionid = returned.collectionid
        foreignParent.get('docs').insert(0, [returned])
        returned.clientID = clientID
        returned.collectionid = collectionid
        returned._item = null
        candidate = returned
        foreignBefore = captureC28State(foreignParent, encode)
        return returned
      }
    }
    const source = new Y.Doc({ gc: false })
    source.get('docs').insert(0, [new Y.Doc({ guid: `c28-foreign-${label}`, gc: false })])
    source.get('text').insert(0, ['x'])
    const host = new TargetDoc({ gc: false, sparseExactResolution: true })
    const existing = host.get('existing')
    existing.insert(0, ['base'])
    const before = captureC28State(host, encode)
    let updates = 0
    let transactions = 0
    let subdocs = 0
    host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
    host.on('afterTransaction', () => { transactions++ })
    host.on('subdocs', () => { subdocs++ })

    t.fails(() => apply(host, encode(source)))
    assertC28State(host, encode, before, `${label} erased foreign admission`)
    t.assert(
      candidate !== null && candidate._item === null && !candidate.isDestroyed && foreignParent.get('docs').get(0) === candidate &&
      foreignParent.subdocs.has(candidate) && updates === 0 && transactions === 0 && subdocs === 0,
      `${label} private _item is not admission authority`
    )
    assertC28State(foreignParent, encode, /** @type {NonNullable<typeof foreignBefore>} */ (foreignBefore), `${label} foreign parent`)

    hostile = false
    apply(host, encode(source))
    const child = /** @type {Y.Doc} */ (host.get('docs').get(0))
    t.assert(child !== candidate && host.subdocs.has(child) && host.get('text').get(0) === 'x' && existing.get(0) === 'base')
    const reload = new Y.Doc({ gc: false })
    apply(reload, encode(host))
    t.assert(/** @type {Y.Doc} */ (reload.get('docs').get(0)).guid === child.guid && reload.get('text').get(0) === 'x')
    assertC28State(foreignParent, encode, /** @type {NonNullable<typeof foreignBefore>} */ (foreignBefore), `${label} foreign parent after retry`)
  })

  const foreignParent = new Y.Doc({ gc: false })
  const child = new Y.Doc({ guid: 'c28-ordinary-foreign', gc: false })
  const clientID = child.clientID
  const collectionid = child.collectionid
  foreignParent.get('docs').insert(0, [child])
  child.clientID = clientID
  child.collectionid = collectionid
  child._item = null
  const foreignBefore = captureC28State(foreignParent, Y.encodeStateAsUpdate)
  const target = new Y.Doc({ gc: false })
  const docs = target.get('docs')
  const before = captureC28State(target, Y.encodeStateAsUpdate)
  let updates = 0
  let subdocs = 0
  target.on('update', () => { updates++ })
  target.on('subdocs', () => { subdocs++ })
  t.fails(() => docs.insert(0, [child]))
  assertC28State(target, Y.encodeStateAsUpdate, before, 'ordinary erased foreign admission')
  assertC28State(foreignParent, Y.encodeStateAsUpdate, foreignBefore, 'ordinary foreign parent')
  t.assert(foreignParent.get('docs').get(0) === child && foreignParent.subdocs.has(child) && updates === 0 && subdocs === 0)
}

export const testC28PreparedSubdocRejectsConstructorIdentityTaint = () => {
  c28Transports.forEach(({ label, apply, encode, event }) => {
    ;['clientID', 'collectionid'].forEach(property => {
      let hostile = true
      /** @type {Array<Y.Doc>} */
      const candidates = []
      class TargetDoc extends Y.Doc {
        /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
        constructor (opts) {
          super(opts)
          if (!hostile || opts?.guid !== `c28-ctor-${property}`) return
          if (property === 'clientID') this.clientID++
          else this.collectionid = 'foreign-collection'
          candidates.push(this)
        }
      }
      const source = new Y.Doc({ gc: false })
      source.get('docs').insert(0, [new Y.Doc({ guid: `c28-ctor-${property}`, autoLoad: true })])
      source.get('text').insert(0, ['x'])
      const host = new TargetDoc({ gc: false, sparseExactResolution: true, collectionid: 'host-collection' })
      const existing = host.get('existing')
      existing.insert(0, ['base'])
      const before = captureC28State(host, encode)
      let updates = 0
      let transactions = 0
      let subdocs = 0
      host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
      host.on('afterTransaction', () => { transactions++ })
      host.on('subdocs', () => { subdocs++ })

      t.fails(() => apply(host, encode(source)))
      assertC28State(host, encode, before, `${label} constructor ${property}`)
      t.assert(candidates.length === 1 && !candidates[0].isDestroyed && updates === 0 && transactions === 0 && subdocs === 0)
      hostile = false
      apply(host, encode(source))
      const child = /** @type {Y.Doc} */ (host.get('docs').get(0))
      t.assert(
        child.clientID === host.clientID && child.collectionid === host.collectionid && host.subdocs.has(child) &&
        host.get('text').get(0) === 'x' && existing.get(0) === 'base' && host._transactionCleanups.length === 0,
        `${label} constructor ${property} clean retry`
      )
      const snapshot = encode(host)
      const reload = new Y.Doc({ gc: false, collectionid: 'host-collection' })
      apply(reload, snapshot)
      t.compareArrays(Array.from(encode(reload)), Array.from(snapshot))
      t.compareArrays(Array.from(Y.encodeStateVector(reload)), Array.from(Y.encodeStateVector(host)))
      t.assert(reload.subdocs.size === 1 && reload.get('text').get(0) === 'x' && reload.get('existing').get(0) === 'base')
    })
  })
}

export const testC28SubdocPublicationSurvivesPostObserverListenerFailure = () => {
  c28Transports.forEach(({ label, apply, encode }) => {
    ;['afterTransactionCleanup', 'update', 'updateV2'].forEach(stage => {
      const guid = `c28-tail-${label}-${stage}`
      let candidate = /** @type {Y.Doc|null} */ (null)
      class TargetDoc extends Y.Doc {
        /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
        constructor (opts) {
          super(opts)
          if (opts?.guid === guid) candidate = this
        }
      }
      const source = new Y.Doc({ gc: false })
      source.get('docs').insert(0, [new Y.Doc({ guid, autoLoad: true })])
      source.get('text').insert(0, ['x'])
      const host = new TargetDoc({ gc: false, sparseExactResolution: true })
      const listenerError = new Error(`${stage} listener`)
      let armed = true
      let stageCalls = 0
      let updatesV1 = 0
      let updatesV2 = 0
      let subdocs = 0
      let subdocEvent = /** @type {{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}|null} */ (null)
      host.on('update', () => { updatesV1++ })
      host.on('updateV2', () => { updatesV2++ })
      host.on('subdocs', event => { subdocs++; subdocEvent = event })
      host.on(/** @type {'afterTransactionCleanup'|'update'|'updateV2'} */ (stage), () => {
        stageCalls++
        if (armed) {
          armed = false
          throw listenerError
        }
      })

      let failure = null
      try { apply(host, encode(source)) } catch (error) { failure = error }
      t.assert(failure === listenerError && stageCalls === 1, `${label} ${stage} preserves exact listener failure`)
      const child = /** @type {Y.Doc} */ (host.get('docs').get(0))
      const emitted = /** @type {NonNullable<typeof subdocEvent>} */ (subdocEvent)
      t.assert(
        candidate !== null && child === candidate && child.guid === guid && child.shouldLoad &&
        host.subdocs.size === 1 && host.subdocs.has(child) && subdocs === 1 &&
        emitted.added.has(child) && emitted.loaded.has(child) && emitted.removed.size === 0,
        `${label} ${stage} publishes the exact committed child`
      )
      t.assert(
        updatesV1 === 1 && updatesV2 === 1 && host.store.pendingStructs === null && host.store.pendingDs === null &&
        host._transaction === null && host._transactionCleanups.length === 0,
        `${label} ${stage} drains the transaction tail`
      )
      const snapshot = encode(host)
      const state = Y.encodeStateVector(host)
      const reload = new Y.Doc({ gc: false })
      apply(reload, snapshot)
      const reloaded = /** @type {Y.Doc} */ (reload.get('docs').get(0))
      t.compareArrays(Array.from(encode(reload)), Array.from(snapshot))
      t.compareArrays(Array.from(Y.encodeStateVector(reload)), Array.from(state))
      t.assert(reload.subdocs.has(reloaded) && reloaded.guid === guid && reload.get('text').get(0) === 'x')

      host.get('next').insert(0, ['ok'])
      t.assert(
        stageCalls === 2 && updatesV1 === 2 && updatesV2 === 2 && subdocs === 1 &&
        host.get('next').get(0) === 'ok' && host._transaction === null && host._transactionCleanups.length === 0,
        `${label} ${stage} next transaction`
      )
    })
  })
}

export const testC28OrdinaryRemoteSubdocAdmissionFailsBeforeOnePassWrite = () => {
  c28Transports.forEach(({ label, apply, encode, event }) => {
    ;['throw', 'clientID', 'collectionid'].forEach(mode => {
      const guid = `c28-ordinary-${label}-${mode}`
      const constructorError = new Error(`${mode} constructor failure`)
      let hostile = true
      let constructions = 0
      class TargetDoc extends Y.Doc {
        /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
        constructor (opts) {
          super(opts)
          if (opts?.guid !== guid) return
          constructions++
          if (!hostile) return
          if (mode === 'throw') throw constructorError
          Object.defineProperty(this, mode, {
            get: () => { throw new Error(`hostile ${mode} read`) },
            set: () => { throw new Error(`hostile ${mode} write`) },
            configurable: true
          })
          return this
        }
      }
      const source = new Y.Doc({ gc: false })
      source.get('docs').insert(0, [new Y.Doc({ guid, autoLoad: true })])
      source.get('text').insert(0, ['x'])
      const update = encode(source)
      const host = new TargetDoc({ gc: false, collectionid: 'ordinary-collection' })
      const existing = host.get('existing')
      existing.insert(0, ['base'])
      const before = captureC28State(host, encode)
      let beforeTransactions = 0
      let afterTransactions = 0
      let updates = 0
      let subdocs = 0
      host.on('beforeTransaction', () => { beforeTransactions++ })
      host.on('afterTransaction', () => { afterTransactions++ })
      host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
      host.on('subdocs', () => { subdocs++ })

      let failure = null
      try { apply(host, update) } catch (error) { failure = error }
      t.assert(mode === 'throw' ? failure === constructorError : failure instanceof Error, `${label} ${mode} admission failure`)
      t.compareArrays(Array.from(encode(host)), before.bytes, `${label} ${mode} bytes`)
      t.compareArrays(Array.from(Y.encodeStateVector(host)), before.state, `${label} ${mode} state`)
      t.assert(host.store.clients.size === before.clients.size && [...before.clients].every(([client, structs]) => host.store.clients.get(client) === structs), `${label} ${mode} store`)
      t.assert(host.store.pendingStructs === before.pendingStructs && host.store.pendingDs === before.pendingDs, `${label} ${mode} pending`)
      const preparedRoot = host.share.get('docs')
      t.assert(
        constructions === 1 && preparedRoot !== undefined && preparedRoot.length === 0 && existing.get(0) === 'base' &&
        beforeTransactions === 1 && afterTransactions === 1 && updates === 0 && subdocs === 0 && host.subdocs.size === 0 &&
        host._transaction === null && host._transactionCleanups.length === 0,
        `${label} ${mode} failure is pre-Item`
      )

      hostile = false
      apply(host, update)
      const child = /** @type {Y.Doc} */ (host.get('docs').get(0))
      t.assert(
        constructions === 2 && host.get('docs') === preparedRoot && child.guid === guid && child.shouldLoad && child.clientID === host.clientID &&
        child.collectionid === host.collectionid && host.subdocs.size === 1 && host.subdocs.has(child) &&
        host.get('text').get(0) === 'x' && existing.get(0) === 'base' &&
        host.store.pendingStructs === null && host.store.pendingDs === null,
        `${label} ${mode} clean one-pass retry`
      )
      t.assert(beforeTransactions === 2 && afterTransactions === 2 && updates === 1 && subdocs === 1 && host._transactionCleanups.length === 0)
      const snapshot = encode(host)
      const state = Y.encodeStateVector(host)
      const reload = new Y.Doc({ gc: false, collectionid: 'ordinary-collection' })
      apply(reload, snapshot)
      const reloaded = /** @type {Y.Doc} */ (reload.get('docs').get(0))
      t.compareArrays(Array.from(encode(reload)), Array.from(snapshot))
      t.compareArrays(Array.from(Y.encodeStateVector(reload)), Array.from(state))
      t.assert(reload.subdocs.has(reloaded) && reloaded.guid === guid && reload.get('text').get(0) === 'x' && reload.get('existing').get(0) === 'base')
    })
  })
}

export const testC28NullParentContentDocRemainsGcWithoutLifecycle = () => {
  let constructions = 0
  class TargetDoc extends Y.Doc {
    /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
    constructor (opts) {
      super(opts)
      if (opts?.guid === 'c28-null-parent') constructions++
    }
  }
  const doc = new TargetDoc({ gc: false })
  const content = new Y.ContentDoc('c28-null-parent', { autoLoad: true })
  const id = Y.createID(280, 0)
  const item = new Y.Item(id, null, null, null, null, null, null, content)
  let updatesV1 = 0
  let updatesV2 = 0
  let transactions = 0
  let subdocs = 0
  doc.on('update', () => { updatesV1++ })
  doc.on('updateV2', () => { updatesV2++ })
  doc.on('afterTransaction', () => { transactions++ })
  doc.on('subdocs', () => { subdocs++ })

  doc.transact(transaction => item.integrate(transaction, 0))
  const stored = doc.store.getStruct(id)
  t.assert(
    constructions === 0 && content.doc === null && stored?.constructor === Y.GC && stored.length === 1 &&
    doc.share.size === 0 && doc.subdocs.size === 0 && subdocs === 0 && updatesV1 === 1 && updatesV2 === 1 && transactions === 1 &&
    doc.store.pendingStructs === null && doc.store.pendingDs === null && doc._transaction === null && doc._transactionCleanups.length === 0,
    'null-parent ContentDoc integrates only its GC shell'
  )
  ;[
    { encode: Y.encodeStateAsUpdate, decode: Y.decodeUpdate, apply: Y.applyUpdate },
    { encode: Y.encodeStateAsUpdateV2, decode: Y.decodeUpdateV2, apply: Y.applyUpdateV2 }
  ].forEach(({ encode, decode, apply }) => {
    const snapshot = encode(doc)
    const decoded = decode(snapshot).structs
    t.assert(decoded.length === 1 && decoded[0].constructor === Y.GC && decoded[0].id.client === id.client && decoded[0].id.clock === 0)
    const reload = new Y.Doc({ gc: false })
    apply(reload, snapshot)
    t.compareArrays(Array.from(encode(reload)), Array.from(snapshot))
    t.compareArrays(Array.from(Y.encodeStateVector(reload)), Array.from(Y.encodeStateVector(doc)))
    t.assert(reload.store.getStruct(id)?.constructor === Y.GC && reload.subdocs.size === 0 && reload.share.size === 0)
  })
}

export const testC28SubdocClientIdFollowsParentCollisionRotation = () => {
  c28Transports.forEach(({ label, apply, encode, event }) => {
    const collisionID = 28_000
    const guid = `c28-collision-${label}`
    let candidate = /** @type {Y.Doc|null} */ (null)
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super(opts)
        if (opts?.guid === guid) candidate = this
      }
    }
    const host = new TargetDoc({ gc: false, sparseExactResolution: true })
    host.clientID = collisionID
    const source = new Y.Doc({ gc: false })
    source.clientID = collisionID
    source.get('docs').insert(0, [new Y.Doc({ guid, autoLoad: true })])
    source.get('text').insert(0, ['x'])
    let beforeObserverID = -1
    let afterTransactionID = -1
    let updateParentID = -1
    let updates = 0
    let subdocs = 0
    let subdocEvent = /** @type {{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}|null} */ (null)
    host.on('beforeObserverCalls', () => { beforeObserverID = host.clientID })
    host.on('afterTransaction', () => { afterTransactionID = host.clientID })
    host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++; updateParentID = host.clientID })
    host.on('subdocs', event => { subdocs++; subdocEvent = event })

    apply(host, encode(source))
    const child = /** @type {Y.Doc} */ (host.get('docs').get(0))
    const emitted = /** @type {NonNullable<typeof subdocEvent>} */ (subdocEvent)
    t.assert(
      beforeObserverID === collisionID && afterTransactionID === collisionID && host.clientID !== collisionID && updateParentID === host.clientID,
      `${label} parent collision rotates after observers and before update`
    )
    t.assert(
      candidate !== null && child === candidate && child.clientID === host.clientID && child.shouldLoad &&
      host.subdocs.size === 1 && host.subdocs.has(child) && emitted.added.size === 1 && emitted.added.has(child) &&
      emitted.loaded.size === 1 && emitted.loaded.has(child) && emitted.removed.size === 0 && updates === 1 && subdocs === 1 &&
      host.get('text').get(0) === 'x' && host.store.pendingStructs === null && host.store.pendingDs === null &&
      host._transaction === null && host._transactionCleanups.length === 0,
      `${label} child follows the rotated parent identity`
    )
    const snapshot = encode(host)
    const state = Y.encodeStateVector(host)
    t.assert(Y.decodeStateVector(state).get(collisionID) === 2)
    const reload = new Y.Doc({ gc: false })
    apply(reload, snapshot)
    const reloaded = /** @type {Y.Doc} */ (reload.get('docs').get(0))
    t.compareArrays(Array.from(encode(reload)), Array.from(snapshot))
    t.compareArrays(Array.from(Y.encodeStateVector(reload)), Array.from(state))
    t.assert(reload.subdocs.has(reloaded) && reloaded.guid === guid && reloaded.clientID === reload.clientID && reload.get('text').get(0) === 'x')
  })
}

export const testC28SparseSubdocPermitSurvivesSubclassOptionClone = () => {
  c28Transports.forEach(({ label, apply, encode, event }) => {
    const guid = `c28-cloned-options-${label}`
    let candidate = /** @type {Y.Doc|null} */ (null)
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super({ ...opts })
        if (opts?.guid === guid) candidate = this
      }
    }
    const source = new Y.Doc({ gc: false })
    source.get('docs').insert(0, [new Y.Doc({ guid, gc: false, autoLoad: true, meta: { cloned: true } })])
    source.get('text').insert(0, ['x'])
    const host = new TargetDoc({ gc: false, sparseExactResolution: true })
    let updates = 0
    let transactions = 0
    let subdocs = 0
    host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
    host.on('afterTransaction', () => { transactions++ })
    host.on('subdocs', () => { subdocs++ })

    apply(host, encode(source))
    const child = /** @type {Y.Doc} */ (host.get('docs').get(0))
    t.assert(
      candidate !== null && child === candidate && child.guid === guid && child.gc === false && child.shouldLoad && child.autoLoad &&
      child.meta?.cloned === true && child.clientID === host.clientID && host.subdocs.size === 1 && host.subdocs.has(child) &&
      host.get('text').get(0) === 'x' && updates === 1 && transactions === 1 && subdocs === 1 &&
      host.store.pendingStructs === null && host.store.pendingDs === null && host._transactionCleanups.length === 0,
      `${label} cloned constructor options retain the preparation permit`
    )
    const snapshot = encode(host)
    const reload = new Y.Doc({ gc: false })
    apply(reload, snapshot)
    const reloaded = /** @type {Y.Doc} */ (reload.get('docs').get(0))
    t.compareArrays(Array.from(encode(reload)), Array.from(snapshot))
    t.assert(reload.subdocs.has(reloaded) && reloaded.guid === guid && reload.get('text').get(0) === 'x')
  })
}

export const testC28ParentCannotInsertItselfAsSubdoc = () => {
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const doc = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = doc.get('docs')
    const before = captureC28State(doc, Y.encodeStateAsUpdateV2)
    let updates = 0
    let subdocs = 0
    doc.on('update', () => { updates++ })
    doc.on('updateV2', () => { updates++ })
    doc.on('subdocs', () => { subdocs++ })

    t.fails(() => docs.insert(0, [doc]))
    assertC28State(doc, Y.encodeStateAsUpdateV2, before, `${label} self insertion`)
    t.assert(docs.length === 0 && doc.subdocs.size === 0 && updates === 0 && subdocs === 0 && !doc.isDestroyed)
  })
}

export const testC28NoSubdocCollisionUsesPostObserverClientId = () => {
  c28Transports.forEach(({ label, apply, encode, event }) => {
    ;['enter', 'leave'].forEach(mode => {
      const collisionID = 28_100
      const safeID = 28_200
      const source = new Y.Doc({ gc: false })
      source.clientID = collisionID
      source.get('text').insert(0, ['x'])
      const host = new Y.Doc({ gc: false, sparseExactResolution: true })
      host.clientID = mode === 'enter' ? safeID : collisionID
      const initialID = host.clientID
      const observerID = mode === 'enter' ? collisionID : safeID
      let beforeObserverID = -1
      let afterTransactionID = -1
      let updateID = -1
      let updates = 0
      let subdocs = 0
      host.on('beforeObserverCalls', () => {
        beforeObserverID = host.clientID
        host.clientID = observerID
      })
      host.on('afterTransaction', () => { afterTransactionID = host.clientID })
      host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++; updateID = host.clientID })
      host.on('subdocs', () => { subdocs++ })

      apply(host, encode(source))
      const expectedFinal = mode === 'leave' ? safeID : host.clientID
      t.assert(
        beforeObserverID === initialID && afterTransactionID === observerID && updateID === host.clientID &&
        (mode === 'enter' ? host.clientID !== collisionID : host.clientID === expectedFinal) &&
        host.get('text').get(0) === 'x' && updates === 1 && subdocs === 0 && host.subdocs.size === 0 &&
        host._transaction === null && host._transactionCleanups.length === 0,
        `${label} observer ${mode} collision`
      )
    })
  })
}

export const testC28OrdinarySubdocMetadataIsCanonicalizedAtCleanup = () => {
  /** @type {Array<{local:boolean,error:string|null,equalClient:boolean,equalCollection:boolean,member:boolean,event:boolean,updatesV1:number,updatesV2:number,queue:number}>} */
  const results = []
  ;[true, false].forEach((local, index) => {
    const parent = new Y.Doc({ gc: false, collectionid: 'c28-parent' })
    parent.clientID = 28_300 + index
    const child = new Y.Doc({ guid: `c28-metadata-${local}` })
    let updatesV1 = 0
    let updatesV2 = 0
    let subdocEvent = /** @type {{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}|null} */ (null)
    parent.on('update', () => { updatesV1++ })
    parent.on('updateV2', () => { updatesV2++ })
    parent.on('subdocs', event => { subdocEvent = event })
    let error = /** @type {Error|null} */ (null)
    try {
      parent.transact(() => {
        parent.get('docs').insert(0, [child])
        child.clientID = 7
        child.collectionid = null
      }, null, local)
    } catch (failure) {
      error = /** @type {Error} */ (failure)
    }
    const emitted = subdocEvent
    results.push({
      local,
      error: error?.message ?? null,
      equalClient: child.clientID === parent.clientID,
      equalCollection: child.collectionid === parent.collectionid,
      member: parent.subdocs.size === 1 && parent.subdocs.has(child),
      event: emitted !== null && emitted.added.size === 1 && emitted.added.has(child) && emitted.loaded.has(child) && emitted.removed.size === 0,
      updatesV1,
      updatesV2,
      queue: parent._transactionCleanups.length
    })
  })
  t.assert(results.every(result =>
    result.error === null && result.equalClient && result.equalCollection && result.member && result.event &&
    result.updatesV1 === 1 && result.updatesV2 === 1 && result.queue === 0
  ), JSON.stringify(results))
}

export const testC28CollisionObserverReplacementUsesRotatedClientId = () => {
  c28Transports.forEach(({ label, apply, encode }) => {
    const collisionID = 28_400
    const guid = `c28-reentrant-${label}`
    let admitted = /** @type {Y.Doc|null} */ (null)
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super(opts)
        if (opts?.guid === guid) admitted = this
      }
    }
    const source = new Y.Doc({ gc: false })
    source.clientID = collisionID
    source.get('docs').insert(0, [new Y.Doc({ guid })])
    const host = new TargetDoc({ gc: false, sparseExactResolution: true })
    host.clientID = collisionID
    let armed = true
    let events = 0
    host.on('beforeObserverCalls', () => {
      if (armed && admitted !== null) {
        armed = false
        admitted.destroy()
      }
    })
    host.on('subdocs', () => { events++ })

    apply(host, encode(source))
    const replacement = /** @type {Y.Doc} */ (host.get('docs').get(0))
    t.assert(
      admitted !== null && replacement !== admitted && replacement.guid === guid &&
      replacement.clientID === host.clientID && host.clientID !== collisionID &&
      host.subdocs.size === 1 && host.subdocs.has(replacement) && !host.subdocs.has(admitted) &&
      events === 2 && host._transaction === null && host._transactionCleanups.length === 0,
      `${label} observer replacement follows collision rotation`
    )
  })
}

export const testC28AttachedSubdocDestroyRetryRetainsPrivateAttachment = () => {
  ;['root-type', 'nested-subdoc'].forEach(mode => {
    const parent = new Y.Doc({ gc: false })
    const child = new Y.Doc({ guid: `c28-destroy-retry-${mode}`, gc: false })
    const docs = parent.get('docs')
    const listenerError = new Error(`${mode} teardown`)
    let armed = true
    if (mode === 'root-type') {
      child.get('root').on('destroy', () => {
        if (armed) {
          armed = false
          throw listenerError
        }
      })
    } else {
      const nested = new Y.Doc({ guid: 'c28-nested' })
      child.get('nested').insert(0, [nested])
      nested.on('destroy', () => {
        if (armed) {
          armed = false
          throw listenerError
        }
      })
    }
    docs.insert(0, [child])
    let events = 0
    parent.on('subdocs', () => { events++ })

    let failure = null
    try { child.destroy() } catch (error) { failure = error }
    const replacement = /** @type {Y.Doc} */ (docs.get(0))
    t.assert(
      failure === listenerError && replacement !== child && replacement.guid === child.guid &&
      parent.subdocs.size === 1 && parent.subdocs.has(replacement) && !parent.subdocs.has(child) &&
      events === 1 && parent._transaction === null && parent._transactionCleanups.length === 0,
      `${mode} first destroy commits replacement`
    )
    child.destroy()
    t.assert(
      docs.get(0) === replacement && parent.subdocs.size === 1 &&
      parent.subdocs.has(replacement) && !parent.subdocs.has(child) && events === 1 &&
      parent._transaction === null && parent._transactionCleanups.length === 0,
      `${mode} destroy retry is idempotent`
    )
  })
}

export const testC28ParentTerminationCannotRepublishDestroyReplacement = () => {
  /** @type {Array<{label:string,error:boolean,parent:boolean,replacement:boolean,event:boolean,terminal:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    ;['beforeObserverCalls', 'afterTransaction', 'afterTransactionCleanup'].forEach(stage => {
      const label = `${sparse ? 'sparse' : 'ordinary'}-${stage}`
      const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
      const docs = parent.get('docs')
      const child = new Y.Doc({ guid: `c28-parent-termination-${label}`, gc: false })
      docs.insert(0, [child])
      let armed = true
      let subdocEvents = 0
      let destroys = 0
      const terminate = () => {
        if (!armed) return
        armed = false
        parent.destroy()
      }
      if (stage === 'beforeObserverCalls') parent.on('beforeObserverCalls', terminate)
      if (stage === 'afterTransaction') parent.on('afterTransaction', terminate)
      if (stage === 'afterTransactionCleanup') parent.on('afterTransactionCleanup', terminate)
      parent.on('subdocs', () => { subdocEvents++ })
      parent.on('destroy', () => { destroys++ })

      let failure = null
      try { child.destroy() } catch (error) { failure = error }
      const replacement = /** @type {Y.Doc} */ (docs.get(0))
      const fresh = new Y.Doc({ gc: false })
      let attachFailure = null
      try { fresh.get('docs').insert(0, [replacement]) } catch (error) { attachFailure = error }
      parent.destroy()
      child.destroy()
      results.push({
        label,
        error: failure === null,
        parent: parent.isDestroyed && parent.subdocs instanceof Set && parent.subdocs.size === 0 && parent.getSubdocs().size === 0,
        replacement: replacement !== child && docs.get(0) === replacement && child.isDestroyed && replacement.isDestroyed,
        event: subdocEvents === 0 && destroys === 1,
        terminal: attachFailure instanceof Error && fresh.get('docs').length === 0 && fresh.subdocs.size === 0,
        cleanup: parent._transaction === null && parent._transactionCleanups.length === 0 &&
          child._transaction === null && child._transactionCleanups.length === 0 && replacement._transactionCleanups.length === 0
      })
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28DestroyTracksRootsCreatedDuringCleanup = () => {
  /** @type {Array<{label:string,error:boolean,late:boolean,retry:boolean,event:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const doc = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const creator = doc.get('creator')
    const throwing = doc.get('throwing')
    const teardownError = new Error(`${label} root teardown`)
    let late = /** @type {any} */ (null)
    let creatorCalls = 0
    let throwingCalls = 0
    let lateCalls = 0
    let destroyEvents = 0
    let armed = true
    creator.on('destroy', () => {
      creatorCalls++
      late = doc.get('late')
      late.on('destroy', () => { lateCalls++ })
    })
    throwing.on('destroy', () => {
      throwingCalls++
      if (armed) {
        armed = false
        throw teardownError
      }
    })
    doc.on('destroy', () => { destroyEvents++ })

    let failure = null
    try { doc.destroy() } catch (error) { failure = error }
    let retryFailure = null
    try { doc.destroy() } catch (error) { retryFailure = error }
    const sameLate = late !== null && doc.get('late') === late
    doc.destroy()
    results.push({
      label,
      error: failure === teardownError && doc.isDestroyed,
      late: sameLate && creatorCalls === 1 && throwingCalls === 2 && lateCalls === 1,
      retry: retryFailure === null && creatorCalls === 1 && throwingCalls === 2 && lateCalls === 1,
      event: destroyEvents === 1,
      cleanup: doc._transaction === null && doc._transactionCleanups.length === 0
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28IsDestroyedAccessorCannotWedgeCleanup = () => {
  /** @type {Array<{label:string,error:boolean,commit:boolean,retry:boolean,event:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    ;[false, true].forEach(attached => {
      const label = `${sparse ? 'sparse' : 'ordinary'}-${attached ? 'attached' : 'root'}`
      const parent = attached
        ? new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
        : null
      const docs = parent?.get('docs') ?? null
      const doc = new Y.Doc({ guid: `c28-destroy-setter-${label}`, gc: false })
      const root = doc.get('root')
      if (docs !== null) docs.insert(0, [doc])
      const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(doc, 'isDestroyed'))
      const setterError = new Error(`${label} isDestroyed setter`)
      let rootDestroys = 0
      let docDestroys = 0
      let subdocEvents = 0
      let setterCalls = 0
      let installed = false
      root.on('destroy', () => { rootDestroys++ })
      doc.on('destroy', () => { docDestroys++ })
      if (parent !== null) parent.on('subdocs', () => { subdocEvents++ })
      const install = () => {
        if (installed) return
        installed = true
        Object.defineProperty(doc, 'isDestroyed', {
          configurable: true,
          enumerable: descriptor.enumerable,
          get: () => false,
          set: () => {
            setterCalls++
            throw setterError
          }
        })
      }
      if (parent === null) install()
      else parent.on('afterTransaction', install)

      let failure = null
      try { doc.destroy() } catch (error) { failure = error }
      const replacement = docs === null ? null : /** @type {Y.Doc} */ (docs.get(0))
      let first = false
      let committed = false
      if (parent === null || docs === null) {
        first = failure instanceof Error && failure !== setterError && setterCalls === 0
        committed = !doc.isDestroyed && rootDestroys === 0 && docDestroys === 0
        Object.defineProperty(doc, 'isDestroyed', descriptor)
      } else {
        first = failure === null && setterCalls === 0 && doc.isDestroyed
        committed = replacement !== doc && replacement !== null && parent.subdocs.size === 1 &&
          parent.subdocs.has(replacement) && !parent.subdocs.has(doc) && subdocEvents === 1
      }
      let retryFailure = null
      try { doc.destroy() } catch (error) { retryFailure = error }
      doc.destroy()
      const stable = parent === null || docs === null
        ? true
        : replacement !== null && docs.get(0) === replacement && parent.subdocs.size === 1 && parent.subdocs.has(replacement) && subdocEvents === 1
      results.push({
        label,
        error: first,
        commit: committed,
        retry: retryFailure === null && doc.isDestroyed && rootDestroys === 1 && docDestroys === 1,
        event: stable,
        cleanup: doc._transaction === null && doc._transactionCleanups.length === 0 &&
          (parent === null || (parent._transaction === null && parent._transactionCleanups.length === 0))
      })
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28DestroyBeforeTransactionMembershipFailureIsRetryable = () => {
  /** @type {Array<{label:string,error:boolean,state:boolean,live:boolean,retry:boolean,event:boolean,stable:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    const child = new Y.Doc({ guid: `c28-destroy-before-${label}`, gc: false })
    docs.insert(0, [child])
    const publicSubdocs = parent.subdocs
    const before = captureC28State(parent, Y.encodeStateAsUpdateV2)
    let armed = true
    let updates = 0
    let updatesV2 = 0
    /** @type {Array<{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}>} */
    const events = []
    parent.on('beforeTransaction', () => {
      if (armed) {
        armed = false
        parent.subdocs = /** @type {any} */ ({})
      }
    })
    parent.on('update', () => { updates++ })
    parent.on('updateV2', () => { updatesV2++ })
    parent.on('subdocs', event => { events.push(event) })

    let failure = null
    try { child.destroy() } catch (error) { failure = error }
    parent.subdocs = publicSubdocs
    const unchanged =
      Array.from(Y.encodeStateAsUpdateV2(parent)).join(',') === before.bytes.join(',') &&
      Array.from(Y.encodeStateVector(parent)).join(',') === before.state.join(',') &&
      parent.store.clients.size === before.clients.size && [...before.clients].every(([client, structs]) => parent.store.clients.get(client) === structs) &&
      parent.store.pendingStructs === before.pendingStructs && parent.store.pendingDs === before.pendingDs &&
      parent.share === before.share && parent.share.size === before.roots.size && [...before.roots].every(([key, root]) => parent.share.get(key) === root)
    const live = docs.get(0) === child && !child.isDestroyed && parent.subdocs.size === 1 && parent.subdocs.has(child) &&
      events.length === 0 && updates === 0 && updatesV2 === 0 && parent._transaction === null && parent._transactionCleanups.length === 0

    let retryFailure = null
    try { child.destroy() } catch (error) { retryFailure = error }
    const replacement = /** @type {Y.Doc} */ (docs.get(0))
    const event = events[0]
    const retry = retryFailure === null && replacement !== child && replacement.guid === child.guid &&
      child.isDestroyed && !replacement.isDestroyed && parent.subdocs.size === 1 && parent.subdocs.has(replacement) && !parent.subdocs.has(child)
    const exactEvent = events.length === 1 && event.added.size === 1 && event.added.has(replacement) &&
      event.removed.size === 1 && event.removed.has(child) && event.loaded.size === 0
    child.destroy()
    const reload = new Y.Doc({ gc: false })
    Y.applyUpdateV2(reload, Y.encodeStateAsUpdateV2(parent))
    const loaded = /** @type {Y.Doc} */ (reload.get('docs').get(0))
    results.push({
      label,
      error: failure instanceof Error,
      state: unchanged,
      live,
      retry,
      event: exactEvent,
      stable: docs.get(0) === replacement && events.length === 1 && updates === 0 && updatesV2 === 0 &&
        loaded.guid === child.guid && reload.subdocs.size === 1 && reload.subdocs.has(loaded) &&
        parent._transaction === null && parent._transactionCleanups.length === 0
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28DestroyBeforeTransactionThrowCancelsAndRetries = () => {
  /** @type {Array<{label:string,error:boolean,state:boolean,live:boolean,retry:boolean,event:boolean,reload:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    const child = new Y.Doc({ guid: `c28-destroy-before-throw-${label}`, gc: false })
    docs.insert(0, [child])
    const before = captureC28State(parent, Y.encodeStateAsUpdateV2)
    const listenerError = new Error(`${label} before transaction`)
    let armed = true
    let updates = 0
    let updatesV2 = 0
    /** @type {Array<{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}>} */
    const events = []
    parent.on('beforeTransaction', () => {
      if (armed) {
        armed = false
        throw listenerError
      }
    })
    parent.on('update', () => { updates++ })
    parent.on('updateV2', () => { updatesV2++ })
    parent.on('subdocs', event => { events.push(event) })

    let failure = null
    try { child.destroy() } catch (error) { failure = error }
    const unchanged =
      Array.from(Y.encodeStateAsUpdateV2(parent)).join(',') === before.bytes.join(',') &&
      Array.from(Y.encodeStateVector(parent)).join(',') === before.state.join(',') &&
      parent.store.clients.size === before.clients.size && [...before.clients].every(([client, structs]) => parent.store.clients.get(client) === structs) &&
      parent.store.pendingStructs === before.pendingStructs && parent.store.pendingDs === before.pendingDs &&
      parent.share === before.share && parent.share.size === before.roots.size && [...before.roots].every(([key, root]) => parent.share.get(key) === root)
    const live = docs.get(0) === child && !child.isDestroyed && parent.subdocs.size === 1 && parent.subdocs.has(child) &&
      events.length === 0 && updates === 0 && updatesV2 === 0 && parent._transaction === null && parent._transactionCleanups.length === 0

    let retryFailure = null
    try { child.destroy() } catch (error) { retryFailure = error }
    const replacement = /** @type {Y.Doc} */ (docs.get(0))
    const event = events[0]
    const retried = retryFailure === null && replacement !== child && child.isDestroyed && !replacement.isDestroyed &&
      parent.subdocs.size === 1 && parent.subdocs.has(replacement) && !parent.subdocs.has(child) &&
      parent._transaction === null && parent._transactionCleanups.length === 0
    const exactEvent = events.length === 1 && event.added.size === 1 && event.added.has(replacement) &&
      event.removed.size === 1 && event.removed.has(child) && event.loaded.size === 0
    child.destroy()
    const reload = new Y.Doc({ gc: false })
    Y.applyUpdateV2(reload, Y.encodeStateAsUpdateV2(parent))
    const loaded = /** @type {Y.Doc} */ (reload.get('docs').get(0))
    results.push({
      label,
      error: failure === listenerError,
      state: unchanged,
      live,
      retry: retried,
      event: exactEvent && events.length === 1 && updates === 0 && updatesV2 === 0 && docs.get(0) === replacement,
      reload: loaded.guid === child.guid && reload.subdocs.size === 1 && reload.subdocs.has(loaded)
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28NullCleanupFailureIsSurfacedAndRetried = () => {
  /** @type {Array<{label:string,error:boolean,commit:boolean,retry:boolean,event:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    ;[false, true].forEach(attached => {
      const label = `${sparse ? 'sparse' : 'ordinary'}-${attached ? 'attached' : 'root'}`
      const parent = attached
        ? new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
        : null
      const docs = parent?.get('docs') ?? null
      const doc = new Y.Doc({ guid: `c28-null-cleanup-${label}`, gc: false })
      const root = doc.get('root')
      if (docs !== null) docs.insert(0, [doc])
      const cleanupFailure = /** @type {null} */ (null)
      let armed = true
      let rootDestroys = 0
      let docDestroys = 0
      let subdocEvents = 0
      root.on('destroy', () => {
        rootDestroys++
        if (armed) {
          armed = false
          throw cleanupFailure
        }
      })
      doc.on('destroy', () => { docDestroys++ })
      if (parent !== null) parent.on('subdocs', () => { subdocEvents++ })

      let threw = false
      let failure = /** @type {unknown} */ (false)
      try { doc.destroy() } catch (error) {
        threw = true
        failure = error
      }
      const replacement = docs === null ? null : /** @type {Y.Doc} */ (docs.get(0))
      const committed = parent === null
        ? doc.isDestroyed
        : replacement !== doc && replacement !== null && parent.subdocs.size === 1 && parent.subdocs.has(replacement) && !parent.subdocs.has(doc) && subdocEvents === 1
      const firstRootDestroys = rootDestroys
      let retryFailure = null
      try { doc.destroy() } catch (error) { retryFailure = error }
      doc.destroy()
      let stable = true
      if (parent !== null && docs !== null) {
        stable = replacement !== null && docs.get(0) === replacement && parent.subdocs.size === 1 && parent.subdocs.has(replacement) && subdocEvents === 1
      }
      results.push({
        label,
        error: threw && failure === null,
        commit: committed && firstRootDestroys === 1 && docDestroys === 1,
        retry: retryFailure === null && rootDestroys === 2 && docDestroys === 1,
        event: stable,
        cleanup: doc._transaction === null && doc._transactionCleanups.length === 0 &&
          (parent === null || (parent._transaction === null && parent._transactionCleanups.length === 0))
      })
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28PoisonedPendingReplacementDestroyCannotOrphan = () => {
  /** @type {Array<{label:string,error:boolean,terminal:boolean,event:boolean,poison:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    const child = new Y.Doc({ guid: `c28-poisoned-replacement-${label}`, gc: false })
    docs.insert(0, [child])
    let replacement = /** @type {Y.Doc|null} */ (null)
    let poisonCalls = 0
    let subdocEvents = 0
    let destroyEvents = 0
    let armed = true
    parent.on('beforeObserverCalls', () => {
      if (!armed) return
      armed = false
      replacement = /** @type {Y.Doc} */ (docs.get(0))
      Object.defineProperty(replacement, 'destroy', {
        configurable: true,
        value: () => {
          poisonCalls++
          throw new Error(`${label} poisoned destroy`)
        }
      })
      parent.destroy()
    })
    parent.on('subdocs', () => { subdocEvents++ })
    parent.on('destroy', () => { destroyEvents++ })

    let failure = null
    try { child.destroy() } catch (error) { failure = error }
    const fresh = new Y.Doc({ gc: false })
    let attachFailure = null
    if (replacement !== null) {
      try { fresh.get('docs').insert(0, [replacement]) } catch (error) { attachFailure = error }
    }
    parent.destroy()
    child.destroy()
    results.push({
      label,
      error: failure === null,
      terminal: replacement !== null && replacement !== child && docs.get(0) === replacement &&
        parent.isDestroyed && child.isDestroyed && replacement.isDestroyed && parent.subdocs.size === 0 && parent.getSubdocs().size === 0 &&
        attachFailure instanceof Error && fresh.get('docs').length === 0 && fresh.subdocs.size === 0,
      event: subdocEvents === 0 && destroyEvents === 1,
      poison: poisonCalls === 0,
      cleanup: parent._transaction === null && parent._transactionCleanups.length === 0 &&
        child._transaction === null && child._transactionCleanups.length === 0 &&
        (replacement === null || replacement._transactionCleanups.length === 0)
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28NestedDestroyRollbackKeepsDescendantsRetryable = () => {
  /** @type {Array<{label:string,error:boolean,rollback:boolean,retry:boolean,event:boolean,reload:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const opts = sparse ? { gc: false, sparseExactResolution: true } : { gc: false }
    const grandparent = new Y.Doc(opts)
    const parent = new Y.Doc({ ...opts, guid: `c28-nested-rollback-parent-${label}` })
    const child = new Y.Doc({ ...opts, guid: `c28-nested-rollback-child-${label}` })
    const parents = grandparent.get('docs')
    const children = parent.get('docs')
    children.insert(0, [child])
    parents.insert(0, [parent])
    const beforeGrandparent = captureC28State(grandparent, Y.encodeStateAsUpdateV2)
    const beforeParent = captureC28State(parent, Y.encodeStateAsUpdateV2)
    const listenerError = new Error(`${label} grandparent before transaction`)
    let armed = true
    let grandparentEvents = 0
    let parentEvents = 0
    let parentDestroys = 0
    let childDestroys = 0
    grandparent.on('beforeTransaction', () => {
      if (!armed) return
      armed = false
      child.destroy()
      throw listenerError
    })
    grandparent.on('subdocs', () => { grandparentEvents++ })
    parent.on('subdocs', () => { parentEvents++ })
    parent.on('destroy', () => { parentDestroys++ })
    child.on('destroy', () => { childDestroys++ })

    let failure = null
    try { parent.destroy() } catch (error) { failure = error }
    const stateUnchanged =
      Array.from(Y.encodeStateAsUpdateV2(grandparent)).join(',') === beforeGrandparent.bytes.join(',') &&
      Array.from(Y.encodeStateAsUpdateV2(parent)).join(',') === beforeParent.bytes.join(',')
    const rolledBack = parents.get(0) === parent && children.get(0) === child && !parent.isDestroyed && !child.isDestroyed &&
      grandparent.subdocs.size === 1 && grandparent.subdocs.has(parent) && parent.subdocs.size === 1 && parent.subdocs.has(child) &&
      grandparentEvents === 0 && parentEvents === 0 && parentDestroys === 0 && childDestroys === 0
    let retryFailure = null
    try { parent.destroy() } catch (error) { retryFailure = error }
    const replacement = /** @type {Y.Doc} */ (parents.get(0))
    parent.destroy()
    child.destroy()
    const reload = new Y.Doc({ gc: false })
    Y.applyUpdateV2(reload, Y.encodeStateAsUpdateV2(grandparent))
    const loaded = /** @type {Y.Doc} */ (reload.get('docs').get(0))
    results.push({
      label,
      error: failure === listenerError,
      rollback: stateUnchanged && rolledBack,
      retry: retryFailure === null && replacement !== parent && replacement.guid === parent.guid && !replacement.isDestroyed &&
        parent.isDestroyed && child.isDestroyed && grandparent.subdocs.size === 1 && grandparent.subdocs.has(replacement) &&
        !grandparent.subdocs.has(parent) && parent.subdocs.size === 0,
      event: grandparentEvents === 1 && parentEvents === 0 && parentDestroys === 1 && childDestroys === 1,
      reload: loaded.guid === parent.guid && reload.subdocs.size === 1 && reload.subdocs.has(loaded),
      cleanup: grandparent._transaction === null && grandparent._transactionCleanups.length === 0 &&
        parent._transaction === null && parent._transactionCleanups.length === 0 && child._transactionCleanups.length === 0
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28ParentTerminationDuringChildPrecommitIsMonotonic = () => {
  /** @type {Array<{label:string,error:boolean,terminal:boolean,event:boolean,retry:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    const child = new Y.Doc({ guid: `c28-parent-terminal-precommit-${label}`, gc: false })
    docs.insert(0, [child])
    const listenerError = new Error(`${label} parent termination`)
    let armed = true
    let subdocEvents = 0
    let parentDestroys = 0
    let childDestroys = 0
    parent.on('beforeTransaction', () => {
      if (!armed) return
      armed = false
      parent.destroy()
      throw listenerError
    })
    parent.on('subdocs', () => { subdocEvents++ })
    parent.on('destroy', () => { parentDestroys++ })
    child.on('destroy', () => { childDestroys++ })

    let failure = null
    try { child.destroy() } catch (error) { failure = error }
    const firstTerminal = parent.isDestroyed && child.isDestroyed && docs.get(0) === child &&
      parent.subdocs.size === 0 && parent.getSubdocs().size === 0
    const fresh = new Y.Doc({ gc: false })
    let attachFailure = null
    try { fresh.get('docs').insert(0, [child]) } catch (error) { attachFailure = error }
    let parentRetry = null
    let childRetry = null
    try { parent.destroy() } catch (error) { parentRetry = error }
    try { child.destroy() } catch (error) { childRetry = error }
    results.push({
      label,
      error: failure === listenerError,
      terminal: firstTerminal && attachFailure instanceof Error && fresh.get('docs').length === 0 && fresh.subdocs.size === 0,
      event: subdocEvents === 0 && parentDestroys === 1 && childDestroys === 1,
      retry: parentRetry === null && childRetry === null && parent.isDestroyed && child.isDestroyed &&
        docs.get(0) === child && parent.subdocs.size === 0 && parentDestroys === 1 && childDestroys === 1,
      cleanup: parent._transaction === null && parent._transactionCleanups.length === 0 &&
        child._transaction === null && child._transactionCleanups.length === 0
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28DeletedChildUsesCapturedDestroy = () => {
  /** @type {Array<{label:string,error:boolean,terminal:boolean,event:boolean,poison:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    const child = new Y.Doc({ guid: `c28-deleted-captured-destroy-${label}` })
    docs.insert(0, [child])
    let armed = true
    let poisonCalls = 0
    let updates = 0
    let updatesV2 = 0
    /** @type {Array<{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}>} */
    const events = []
    parent.on('beforeObserverCalls', () => {
      if (!armed) return
      armed = false
      Object.defineProperty(child, 'destroy', {
        configurable: true,
        value: () => {
          poisonCalls++
          throw new Error(`${label} poisoned deleted destroy`)
        }
      })
    })
    parent.on('update', () => { updates++ })
    parent.on('updateV2', () => { updatesV2++ })
    parent.on('subdocs', event => { events.push(event) })
    let failure = null
    try { docs.delete(0, 1) } catch (error) { failure = error }
    const fresh = new Y.Doc({ gc: false })
    let attachFailure = null
    try { fresh.get('docs').insert(0, [child]) } catch (error) { attachFailure = error }
    results.push({
      label,
      error: failure === null,
      terminal: child.isDestroyed && docs.length === 0 && parent.subdocs.size === 0 && attachFailure instanceof Error && fresh.get('docs').length === 0,
      event: updates === 1 && updatesV2 === 1 && events.length === 2 &&
        events.every(event => event.added.size === 0 && event.loaded.size === 0 && event.removed.size === 1 && event.removed.has(child)),
      poison: poisonCalls === 0,
      cleanup: parent._transaction === null && parent._transactionCleanups.length === 0 && child._transactionCleanups.length === 0
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28DestroyUsesOriginalShareAfterObserverReplacement = () => {
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    const child = new Y.Doc({ guid: `c28-original-share-${label}` })
    const root = child.get('root')
    const originalShare = child.share
    const forgedShare = new Map()
    docs.insert(0, [child])
    let rootDestroys = 0
    let childDestroys = 0
    let events = 0
    let armed = true
    root.on('destroy', () => { rootDestroys++ })
    child.on('destroy', () => { childDestroys++ })
    parent.on('afterTransaction', () => {
      if (armed) {
        armed = false
        child.share = forgedShare
      }
    })
    parent.on('subdocs', () => { events++ })
    child.destroy()
    const replacement = /** @type {Y.Doc} */ (docs.get(0))
    child.destroy()
    t.assert(
      replacement !== child && parent.subdocs.size === 1 && parent.subdocs.has(replacement) &&
      child.isDestroyed && child.share === forgedShare && originalShare.get('root') === root &&
      rootDestroys === 1 && childDestroys === 1 && events === 1 &&
      parent._transaction === null && parent._transactionCleanups.length === 0 && child._transactionCleanups.length === 0,
      `${label} original share cleanup`
    )
  })
}

export const testC28DestroyUsesCapturedRootCallableAfterObserverPoison = () => {
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    const child = new Y.Doc({ guid: `c28-captured-root-destroy-${label}` })
    const root = child.get('root')
    docs.insert(0, [child])
    let armed = true
    let poisonCalls = 0
    let rootDestroys = 0
    let childDestroys = 0
    let events = 0
    root.on('destroy', () => { rootDestroys++ })
    child.on('destroy', () => { childDestroys++ })
    parent.on('afterTransaction', () => {
      if (!armed) return
      armed = false
      Object.defineProperty(root, 'destroy', {
        configurable: true,
        value: () => {
          poisonCalls++
          throw new Error(`${label} poisoned root destroy`)
        }
      })
    })
    parent.on('subdocs', () => { events++ })

    let failure = null
    try { child.destroy() } catch (error) { failure = error }
    const replacement = /** @type {Y.Doc} */ (docs.get(0))
    let retryFailure = null
    try { child.destroy() } catch (error) { retryFailure = error }
    child.destroy()
    t.assert(
      failure === null && retryFailure === null && replacement !== child && docs.get(0) === replacement &&
      child.isDestroyed && !replacement.isDestroyed && parent.subdocs.size === 1 && parent.subdocs.has(replacement) &&
      poisonCalls === 0 && rootDestroys === 1 && childDestroys === 1 && events === 1 &&
      parent._transaction === null && parent._transactionCleanups.length === 0 && child._transactionCleanups.length === 0,
      `${label} captured root destroy callable`
    )
  })
}

export const testC28ReplacementAdoptionIgnoresArrayPrototypeSetter = () => {
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    const child = new Y.Doc({ guid: `c28-array-setter-adoption-${label}` })
    docs.insert(0, [child])
    const originalZero = Object.getOwnPropertyDescriptor(Array.prototype, '0')
    const poisonError = new Error(`${label} array zero setter`)
    let armed = true
    let poisonCalls = 0
    let events = 0
    let delivered = /** @type {{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}|null} */ (null)
    /** @this {Array<any>} @param {any} value */
    const setZero = function (value) {
      if (value?.doc instanceof Y.Doc && value.doc !== child && value.doc.guid === child.guid) {
        poisonCalls++
        throw poisonError
      }
      Object.defineProperty(this, '0', { configurable: true, enumerable: true, writable: true, value })
    }
    parent.on('beforeTransaction', () => {
      if (!armed) return
      armed = false
      // eslint-disable-next-line no-extend-native, accessor-pairs
      Reflect.defineProperty(Array.prototype, '0', { configurable: true, get: () => undefined, set: setZero })
    })
    parent.on('subdocs', event => {
      events++
      delivered = event
    })

    let failure = null
    try {
      child.destroy()
    } catch (error) {
      failure = error
    } finally {
      if (originalZero === undefined) Reflect.deleteProperty(Array.prototype, '0')
      // eslint-disable-next-line no-extend-native
      else Reflect.defineProperty(Array.prototype, '0', originalZero)
    }
    const replacement = /** @type {Y.Doc} */ (docs.get(0))
    const event = /** @type {NonNullable<typeof delivered>} */ (delivered)
    let retryFailure = null
    try { child.destroy() } catch (error) { retryFailure = error }
    child.destroy()
    t.assert(
      failure === null && retryFailure === null && poisonCalls === 0 && replacement !== child && docs.get(0) === replacement &&
      child.isDestroyed && !replacement.isDestroyed && parent.subdocs.size === 1 && parent.subdocs.has(replacement) &&
      events === 1 && event.added.size === 1 && event.added.has(replacement) && event.loaded.size === 0 &&
      event.removed.size === 1 && event.removed.has(child) && parent._transaction === null &&
      parent._transactionCleanups.length === 0 && child._transactionCleanups.length === 0,
      `${label} array prototype setter is not dispatched`
    )
  })
}

export const testC28DestroyRetryUsesCapturedPrivateShare = () => {
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    const child = new Y.Doc({ guid: `c28-private-share-retry-${label}` })
    const root = child.get('root')
    docs.insert(0, [child])
    const listenerError = new Error(`${label} root share poison`)
    const shareDescriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(child, 'share'))
    let armed = true
    let rootDestroys = 0
    let childDestroys = 0
    let events = 0
    root.on('destroy', () => {
      rootDestroys++
      if (armed) {
        armed = false
        Object.defineProperty(child, 'share', { ...shareDescriptor, value: {} })
        throw listenerError
      }
    })
    child.on('destroy', () => { childDestroys++ })
    parent.on('subdocs', () => { events++ })

    let failure = null
    try { child.destroy() } catch (error) { failure = error }
    const replacement = /** @type {Y.Doc} */ (docs.get(0))
    let retryFailure = null
    try { child.destroy() } catch (error) { retryFailure = error }
    let finalFailure = null
    try { child.destroy() } catch (error) { finalFailure = error }
    t.assert(
      failure === listenerError && retryFailure === null && finalFailure === null && replacement !== child && docs.get(0) === replacement &&
      child.isDestroyed && !replacement.isDestroyed && parent.subdocs.size === 1 && parent.subdocs.has(replacement) &&
      rootDestroys === 2 && childDestroys === 1 && events === 1 && parent._transaction === null &&
      parent._transactionCleanups.length === 0 && child._transactionCleanups.length === 0,
      `${label} private share retry`
    )
  })
}

export const testC28HostilePublicStateCannotWedgePrivateCleanup = () => {
  /** @type {Array<{label:string,error:boolean,terminal:boolean,event:boolean,retry:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    ;['accessor', 'freeze'].forEach(mode => {
      const label = `${sparse ? 'sparse' : 'ordinary'}-${mode}`
      const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
      const docs = parent.get('docs')
      const child = new Y.Doc({ guid: `c28-hostile-public-state-${label}` })
      const root = child.get('root')
      docs.insert(0, [child])
      let rootDestroys = 0
      let childDestroys = 0
      let events = 0
      let armed = true
      root.on('destroy', () => { rootDestroys++ })
      child.on('destroy', () => { childDestroys++ })
      parent.on('subdocs', () => { events++ })
      parent.on('afterTransaction', () => {
        if (!armed) return
        armed = false
        if (mode === 'accessor') Object.defineProperty(child, 'isDestroyed', { configurable: false, get: () => false })
        else Object.freeze(child)
      })
      let failure = null
      try { child.destroy() } catch (error) { failure = error }
      const replacement = /** @type {Y.Doc} */ (docs.get(0))
      const fresh = new Y.Doc({ gc: false })
      let attachFailure = null
      try { fresh.get('docs').insert(0, [child]) } catch (error) { attachFailure = error }
      let retryFailure = null
      try { child.destroy() } catch (error) { retryFailure = error }
      results.push({
        label,
        error: failure === null,
        terminal: replacement !== child && parent.subdocs.has(replacement) && attachFailure instanceof Error,
        event: rootDestroys === 1 && childDestroys === 1 && events === 1,
        retry: retryFailure === null && docs.get(0) === replacement && rootDestroys === 1 && childDestroys === 1 && events === 1,
        cleanup: parent._transaction === null && parent._transactionCleanups.length === 0 && child._transactionCleanups.length === 0
      })
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28ParentTerminationIgnoresHostileItemMirror = () => {
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    const child = new Y.Doc({ guid: `c28-hostile-item-terminal-${label}` })
    docs.insert(0, [child])
    const listenerError = new Error(`${label} hostile item termination`)
    let armed = true
    let parentDestroys = 0
    let childDestroys = 0
    parent.on('beforeTransaction', () => {
      if (!armed) return
      armed = false
      const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(child, '_item'))
      Object.defineProperty(child, '_item', { ...descriptor, writable: false })
      parent.destroy()
      throw listenerError
    })
    parent.on('destroy', () => { parentDestroys++ })
    child.on('destroy', () => { childDestroys++ })
    let failure = null
    try { child.destroy() } catch (error) { failure = error }
    const fresh = new Y.Doc({ gc: false })
    let attachFailure = null
    try { fresh.get('docs').insert(0, [child]) } catch (error) { attachFailure = error }
    let retryFailure = null
    try { child.destroy() } catch (error) { retryFailure = error }
    parent.destroy()
    t.assert(
      failure === listenerError && retryFailure === null && parent.isDestroyed && child.isDestroyed &&
      docs.get(0) === child && parent.subdocs.size === 0 && attachFailure instanceof Error &&
      parentDestroys === 1 && childDestroys === 1 && parent._transaction === null &&
      parent._transactionCleanups.length === 0 && child._transactionCleanups.length === 0,
      `${label} hostile item mirror is advisory`
    )
  })
}

export const testC28SubdocOverrideIsNotRepeatedAfterBaseFailure = () => {
  ;[false, true].forEach(sparse => {
    ;['base', 'override'].forEach(failureMode => {
      const label = `${sparse ? 'sparse' : 'ordinary'}-${failureMode}`
      const listenerError = new Error(`${label} cleanup`)
      let overrideCalls = 0
      class ChildDoc extends Y.Doc {
        destroy () {
          overrideCalls++
          if (failureMode === 'override') throw listenerError
        }
      }
      const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
      const child = new ChildDoc({ guid: `c28-override-base-retry-${label}` })
      const root = child.get('root')
      parent.get('docs').insert(0, [child])
      let armed = true
      let rootDestroys = 0
      let parentDestroys = 0
      let childDestroys = 0
      root.on('destroy', () => {
        rootDestroys++
        if (failureMode === 'base' && armed) {
          armed = false
          throw listenerError
        }
      })
      parent.on('destroy', () => { parentDestroys++ })
      child.on('destroy', () => { childDestroys++ })
      let failure = null
      try { parent.destroy() } catch (error) { failure = error }
      let retryFailure = null
      try { parent.destroy() } catch (error) { retryFailure = error }
      parent.destroy()
      t.assert(
        failure === listenerError && retryFailure === null && parent.isDestroyed && child.isDestroyed &&
        overrideCalls === 1 && rootDestroys === (failureMode === 'base' ? 2 : 1) && parentDestroys === 1 && childDestroys === 1 &&
        parent._transactionCleanups.length === 0 && child._transactionCleanups.length === 0,
        `${label} override runs once`
      )
    })
  })
}

export const testC28DestroyListenerTailSurvivesRetry = () => {
  /** @type {Array<{label:string,error:boolean,first:boolean,retry:boolean,stable:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    ;[false, true].forEach(attached => {
      const label = `${sparse ? 'sparse' : 'ordinary'}-${attached ? 'attached' : 'root'}`
      const parent = attached
        ? new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
        : null
      const docs = parent?.get('docs') ?? null
      const doc = new Y.Doc({ guid: `c28-destroy-listener-tail-${label}`, gc: false })
      if (docs !== null) docs.insert(0, [doc])
      const listenerError = new Error(`${label} first destroy listener`)
      let armed = true
      let firstCalls = 0
      let secondCalls = 0
      let subdocEvents = 0
      doc.on('destroy', () => {
        firstCalls++
        if (armed) {
          armed = false
          throw listenerError
        }
      })
      doc.on('destroy', () => { secondCalls++ })
      if (parent !== null) parent.on('subdocs', () => { subdocEvents++ })

      let failure = null
      try { doc.destroy() } catch (error) { failure = error }
      const replacement = docs === null ? null : /** @type {Y.Doc} */ (docs.get(0))
      const committed = parent === null
        ? doc.isDestroyed
        : replacement !== null && replacement !== doc && parent.subdocs.size === 1 && parent.subdocs.has(replacement) && subdocEvents === 1
      const first = firstCalls === 1 && secondCalls === 0
      let retryFailure = null
      try { doc.destroy() } catch (error) { retryFailure = error }
      doc.destroy()
      let stable = true
      if (parent !== null && docs !== null) {
        stable = replacement !== null && docs.get(0) === replacement && parent.subdocs.size === 1 && parent.subdocs.has(replacement) && subdocEvents === 1
      }
      results.push({
        label,
        error: failure === listenerError,
        first: committed && first,
        retry: retryFailure === null && firstCalls === 2 && secondCalls === 1,
        stable,
        cleanup: doc._transaction === null && doc._transactionCleanups.length === 0 &&
          (parent === null || (parent._transaction === null && parent._transactionCleanups.length === 0))
      })
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28DestroyGetterIsNotDispatchedDuringAdoption = () => {
  {
    const parent = new Y.Doc({ gc: false })
    const docs = parent.get('docs')
    const child = new Y.Doc({ guid: 'c28-destroy-getter-ordinary' })
    const before = captureC28State(parent, Y.encodeStateAsUpdateV2)
    let getterCalls = 0
    let events = 0
    Object.defineProperty(child, 'destroy', {
      configurable: true,
      get: () => {
        getterCalls++
        if (getterCalls === 1) parent.get('reentrant').insert(0, [child])
        return Y.Doc.prototype.destroy
      }
    })
    parent.on('subdocs', () => { events++ })
    let failure = null
    try { docs.insert(0, [child]) } catch (error) { failure = error }
    t.assert(failure instanceof Error && getterCalls === 0 && !parent.share.has('reentrant') && !child.isDestroyed)
    assertC28State(parent, Y.encodeStateAsUpdateV2, before, 'ordinary destroy getter')
    Reflect.deleteProperty(child, 'destroy')
    docs.insert(0, [child])
    t.assert(docs.get(0) === child && parent.subdocs.has(child) && events === 1 && parent._transactionCleanups.length === 0)
  }

  c28Transports.forEach(({ label, apply, encode, event }) => {
    const guid = `c28-destroy-getter-sparse-${label}`
    let hostile = true
    let getterCalls = 0
    let candidate = /** @type {Y.Doc|null} */ (null)
    let host = /** @type {Y.Doc|null} */ (null)
    class TargetDoc extends Y.Doc {
      /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
      constructor (opts) {
        super(opts)
        if (!hostile || opts?.guid !== guid) return
        candidate = this
        Object.defineProperty(this, 'destroy', {
          configurable: true,
          get: () => {
            getterCalls++
            if (getterCalls === 1 && host !== null) host.get('reentrant').insert(0, [this])
            return Y.Doc.prototype.destroy
          }
        })
      }
    }
    const source = new Y.Doc({ gc: false })
    source.get('docs').insert(0, [new Y.Doc({ guid })])
    const update = encode(source)
    host = new TargetDoc({ gc: false, sparseExactResolution: true })
    const before = captureC28State(host, encode)
    let updates = 0
    let subdocs = 0
    host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
    host.on('subdocs', () => { subdocs++ })
    let failure = null
    try { apply(host, update) } catch (error) { failure = error }
    t.assert(failure instanceof Error && candidate !== null && getterCalls === 0 && !host.share.has('reentrant'), `${label} destroy getter rejection`)
    assertC28State(host, encode, before, `${label} destroy getter`)
    hostile = false
    apply(host, update)
    const child = /** @type {Y.Doc} */ (host.get('docs').get(0))
    t.assert(child !== candidate && host.subdocs.has(child) && updates === 1 && subdocs === 1 && host._transactionCleanups.length === 0, `${label} destroy getter retry`)
  })
}

export const testC28DestroyPostCommitListenerFailuresResumeCleanup = () => {
  /** @type {Array<{label:string,error:boolean,replacement:boolean,stages:boolean,cleanup:boolean,retry:boolean,reload:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    ;['afterTransactionCleanup', 'update', 'updateV2', 'subdocs'].forEach(stage => {
      const label = `${sparse ? 'sparse' : 'ordinary'}-${stage}`
      const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
      const docs = parent.get('docs')
      const trigger = parent.get('trigger')
      const child = new Y.Doc({ guid: `c28-destroy-tail-${label}`, gc: false })
      const root = child.get('root')
      docs.insert(0, [child])
      let triggerArmed = true
      parent.on('beforeTransaction', () => {
        if (triggerArmed) {
          triggerArmed = false
          trigger.insert(0, ['x'])
        }
      })
      const listenerError = new Error(`${label} listener`)
      let listenerArmed = true
      let stageCalls = 0
      const failStage = () => {
        stageCalls++
        if (listenerArmed) {
          listenerArmed = false
          throw listenerError
        }
      }
      parent.on(/** @type {'afterTransactionCleanup'|'update'|'updateV2'|'subdocs'} */ (stage), failStage)
      let updates = 0
      let updatesV2 = 0
      /** @type {Array<{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}>} */
      const events = []
      parent.on('update', () => { updates++ })
      parent.on('updateV2', () => { updatesV2++ })
      parent.on('subdocs', event => { events.push(event) })
      const cleanupError = new Error(`${label} cleanup`)
      let cleanupArmed = true
      let cleanupCalls = 0
      root.on('destroy', () => {
        cleanupCalls++
        if (cleanupArmed) {
          cleanupArmed = false
          throw cleanupError
        }
      })

      let failure = null
      try { child.destroy() } catch (error) { failure = error }
      const replacement = /** @type {Y.Doc} */ (docs.get(0))
      const subdocAttempts = events.length + (stage === 'subdocs' ? stageCalls : 0)
      const updateAttempts = updates + (stage === 'update' ? stageCalls : 0)
      const updateV2Attempts = updatesV2 + (stage === 'updateV2' ? stageCalls : 0)
      const firstCleanupCalls = cleanupCalls
      let retryFailure = null
      try { child.destroy() } catch (error) { retryFailure = error }
      const retryCalls = cleanupCalls
      child.destroy()
      const reload = new Y.Doc({ gc: false })
      Y.applyUpdateV2(reload, Y.encodeStateAsUpdateV2(parent))
      const loaded = /** @type {Y.Doc} */ (reload.get('docs').get(0))
      results.push({
        label,
        error: failure === listenerError,
        replacement: replacement !== child && docs.get(0) === replacement && child.isDestroyed && !replacement.isDestroyed &&
          parent.subdocs.size === 1 && parent.subdocs.has(replacement) && !parent.subdocs.has(child),
        stages: stageCalls === 1 && updateAttempts === 1 && updateV2Attempts === 1 && subdocAttempts === 1 && trigger.get(0) === 'x',
        cleanup: firstCleanupCalls === 1 && parent._transaction === null && parent._transactionCleanups.length === 0,
        retry: retryFailure === null && retryCalls === 2 && cleanupCalls === 2 && docs.get(0) === replacement &&
          stageCalls === 1 && updateAttempts === 1 && updateV2Attempts === 1 && subdocAttempts === 1,
        reload: loaded.guid === child.guid && reload.subdocs.size === 1 && reload.subdocs.has(loaded)
      })
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28DestroyCleanupReentrancyDoesNotReplaceTwice = () => {
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    const child = new Y.Doc({ guid: `c28-destroy-reentrant-${label}`, gc: false })
    const root = child.get('root')
    docs.insert(0, [child])
    let cleanupCalls = 0
    let events = 0
    root.on('destroy', () => {
      cleanupCalls++
      child.destroy()
    })
    parent.on('subdocs', () => { events++ })

    child.destroy()
    const replacement = /** @type {Y.Doc} */ (docs.get(0))
    child.destroy()
    t.assert(
      replacement !== child && docs.get(0) === replacement && child.isDestroyed && !replacement.isDestroyed &&
      parent.subdocs.size === 1 && parent.subdocs.has(replacement) && !parent.subdocs.has(child) &&
      cleanupCalls === 1 && events === 1 && parent._transaction === null && parent._transactionCleanups.length === 0,
      `${label} reentrant destroy is idempotent`
    )
  })
}

export const testC28ParentDestroyDoesNotReplaceNestedSubdocs = () => {
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const child = new Y.Doc({ guid: `c28-parent-nested-child-${label}`, gc: false })
    const grandchild = new Y.Doc({ guid: `c28-parent-nested-grandchild-${label}`, gc: false })
    const nested = child.get('nested')
    const docs = parent.get('docs')
    nested.insert(0, [grandchild])
    docs.insert(0, [child])
    let parentEvents = 0
    let childEvents = 0
    let parentDestroys = 0
    let childDestroys = 0
    let grandchildDestroys = 0
    parent.on('subdocs', () => { parentEvents++ })
    child.on('subdocs', () => { childEvents++ })
    parent.on('destroy', () => { parentDestroys++ })
    child.on('destroy', () => { childDestroys++ })
    grandchild.on('destroy', () => { grandchildDestroys++ })

    parent.destroy()
    parent.destroy()
    child.destroy()
    grandchild.destroy()
    t.assert(
      parent.isDestroyed && child.isDestroyed && grandchild.isDestroyed && docs.get(0) === child && nested.get(0) === grandchild &&
      parent.subdocs instanceof Set && parent.subdocs.size === 0 && child.subdocs instanceof Set && child.subdocs.size === 0 &&
      parentEvents === 0 && childEvents === 0 && parentDestroys === 1 && childDestroys === 1 && grandchildDestroys === 1 &&
      parent._transaction === null && parent._transactionCleanups.length === 0 &&
      child._transaction === null && child._transactionCleanups.length === 0 &&
      grandchild._transaction === null && grandchild._transactionCleanups.length === 0,
      `${label} parent teardown preserves nested identities`
    )
  })
}

export const testC28OrdinaryClaimRollbackAllowsSameChildRetry = () => {
  const parent = new Y.Doc({ gc: false })
  const docs = parent.get('docs')
  const child = new Y.Doc({ guid: 'c28-ordinary-claim-retry' })
  const before = captureC28State(parent, Y.encodeStateAsUpdateV2)
  const listenerError = new Error('between claim and integrate')
  let armed = true
  const proxy = new Proxy(docs, {
    set: (target, property, value, receiver) => {
      if (armed && property === '_start') {
        armed = false
        throw listenerError
      }
      return Reflect.set(target, property, value, receiver)
    }
  })
  let updates = 0
  let subdocs = 0
  parent.on('update', () => { updates++ })
  parent.on('subdocs', () => { subdocs++ })

  let failure = null
  try { proxy.insert(0, [child]) } catch (error) { failure = error }
  t.assert(failure === listenerError && docs.length === 0 && child._item === null, 'ordinary post-claim failure')
  assertC28State(parent, Y.encodeStateAsUpdateV2, before, 'ordinary post-claim failure')

  docs.insert(0, [child])
  t.assert(docs.get(0) === child && parent.subdocs.has(child) && updates === 1 && subdocs === 1 && parent._transactionCleanups.length === 0)
  const snapshot = Y.encodeStateAsUpdateV2(parent)
  const reload = new Y.Doc({ gc: false })
  Y.applyUpdateV2(reload, snapshot)
  t.assert(/** @type {Y.Doc} */ (reload.get('docs').get(0)).guid === child.guid && reload.subdocs.size === 1)
}

export const testC28SparseWireMetaUsesCanonicalSameValue = () => {
  c28Transports.forEach(({ label, apply, encode }) => {
    const nanSource = new Y.Doc({ gc: false })
    nanSource.get('docs').insert(0, [new Y.Doc({ guid: `c28-meta-nan-${label}`, meta: NaN })])
    const nanHost = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(nanHost, encode(nanSource))
    const nanChild = /** @type {Y.Doc} */ (nanHost.get('docs').get(0))
    t.assert(Number.isNaN(nanChild.meta) && nanHost.subdocs.has(nanChild), `${label} NaN meta`)

    ;['in-place', 'object-is'].forEach(mode => {
      const guid = `c28-meta-${mode}-${label}`
      const nativeObjectIs = Object.is
      let hostile = true
      class TargetDoc extends Y.Doc {
        /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
        constructor (opts) {
          super(opts)
          if (!hostile || opts?.guid !== guid) return
          if (mode === 'in-place') this.meta.value = 'forged'
          else {
            Reflect.set(Object, 'is', () => true)
            this.meta = { value: 'forged' }
          }
        }
      }
      const source = new Y.Doc({ gc: false })
      source.get('docs').insert(0, [new Y.Doc({ guid, meta: { value: 'wire' } })])
      const update = encode(source)
      const host = new TargetDoc({ gc: false, sparseExactResolution: true })
      const before = captureC28State(host, encode)
      let failure = null
      try { apply(host, update) } catch (error) { failure = error } finally {
        Reflect.set(Object, 'is', nativeObjectIs)
      }
      t.assert(Object.is === nativeObjectIs && Object.is(NaN, NaN), `${label} ${mode} restores Object.is`)
      t.assert(failure instanceof Error, `${label} ${mode} rejects constructor meta mutation`)
      assertC28State(host, encode, before, `${label} ${mode} canonical meta`)

      hostile = false
      apply(host, update)
      const child = /** @type {Y.Doc} */ (host.get('docs').get(0))
      t.assert(child.meta.value === 'wire' && host.subdocs.has(child) && host._transactionCleanups.length === 0, `${label} ${mode} retry`)
    })
  })
}

export const testC28SubdocsReferenceAndTransactionMirrorsAreRebuilt = () => {
  c28Transports.forEach(({ label, apply, encode }) => {
    const guid = `c28-subdocs-reference-${label}`
    const source = new Y.Doc({ gc: false })
    source.get('docs').insert(0, [new Y.Doc({ guid, autoLoad: true })])
    const host = new Y.Doc({ gc: false, sparseExactResolution: true })
    const forged = new Y.Doc({ guid: `c28-forged-reference-${label}` })
    let replacement = /** @type {Set<Y.Doc>|null} */ (null)
    let delivered = /** @type {{event:{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>},transaction:Y.Transaction}|null} */ (null)
    /** @param {Y.Transaction} transaction */
    const replaceTransactionSets = transaction => {
      transaction.subdocsAdded = new Set([forged])
      transaction.subdocsLoaded = new Set([forged])
      transaction.subdocsRemoved = new Set([forged])
    }
    host.on('beforeObserverCalls', transaction => {
      replacement = new Set()
      host.subdocs = replacement
      replaceTransactionSets(transaction)
    })
    host.on('afterTransaction', replaceTransactionSets)
    host.on('subdocs', (event, _doc, transaction) => { delivered = { event, transaction } })

    apply(host, encode(source))
    const child = /** @type {Y.Doc} */ (host.get('docs').get(0))
    const result = /** @type {NonNullable<typeof delivered>} */ (delivered)
    t.assert(
      replacement !== null && host.subdocs === replacement && replacement.size === 1 && replacement.has(child) && !replacement.has(forged) &&
      result.event.added.size === 1 && result.event.added.has(child) && result.event.loaded.has(child) && result.event.removed.size === 0 &&
      result.transaction.subdocsAdded.size === 1 && result.transaction.subdocsAdded.has(child) &&
      result.transaction.subdocsLoaded.size === 1 && result.transaction.subdocsLoaded.has(child) &&
      result.transaction.subdocsRemoved.size === 0 && host._transactionCleanups.length === 0,
      `${label} public subdoc mirrors`
    )
  })
}

export const testC28SubdocsReplacementRebuildsExistingMembership = () => {
  const results = /** @type {Array<{label:string,membership:boolean,event:boolean,update:boolean,reload:boolean,cleanup:boolean}>} */ ([])
  c28Transports.forEach(({ label, apply, encode, event }) => {
    const existingGuid = `c28-existing-membership-${label}`
    const incomingGuid = `c28-incoming-membership-${label}`
    const host = new Y.Doc({ gc: false, sparseExactResolution: true })
    const existing = new Y.Doc({ guid: existingGuid })
    host.get('docs').insert(0, [existing])
    const source = new Y.Doc({ gc: false })
    apply(source, encode(host))
    source.get('docs').insert(1, [new Y.Doc({ guid: incomingGuid, autoLoad: true })])
    const update = encode(source, Y.encodeStateVector(host))
    const forged = new Y.Doc({ guid: `c28-forged-membership-${label}` })
    let replacement = /** @type {Set<Y.Doc>|null} */ (null)
    let delivered = /** @type {{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}|null} */ (null)
    let updates = 0
    host.on('beforeObserverCalls', () => {
      replacement = new Set([forged])
      host.subdocs = replacement
    })
    host.on('subdocs', event => { delivered = event })
    host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })

    apply(host, update)
    const incoming = /** @type {Y.Doc} */ (host.get('docs').toArray().find(doc => doc.guid === incomingGuid))
    const exactMembership =
      replacement !== null && host.subdocs === replacement && replacement.size === 2 &&
      replacement.has(existing) && replacement.has(incoming) && !replacement.has(forged)
    const exactEvent = delivered !== null && delivered.added.size === 1 && delivered.added.has(incoming) &&
      delivered.loaded.size === 1 && delivered.loaded.has(incoming) && delivered.removed.size === 0
    const reload = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(reload, encode(host))
    const reloadGuids = new Set(Array.from(reload.subdocs, doc => doc.guid))
    results.push({
      label,
      membership: exactMembership,
      event: exactEvent,
      update: updates === 1,
      reload:
      reload.subdocs.size === 2 && reloadGuids.has(existingGuid) && reloadGuids.has(incomingGuid) &&
        !reloadGuids.has(forged.guid),
      cleanup: host._transaction === null && host._transactionCleanups.length === 0 && reload._transactionCleanups.length === 0
    })
  })
  t.assert(results.every(result => result.membership && result.event && result.update && result.reload && result.cleanup), JSON.stringify(results))
}

export const testC28FrozenTransactionRetainsCapturedSubdocSets = () => {
  /** @type {Array<{label:string,error:boolean,frozen:boolean,member:boolean,sets:boolean,event:boolean,update:boolean,cleanup:boolean}>} */
  const results = []
  c28Transports.forEach(({ label, apply, encode, event }) => {
    const guid = `c28-frozen-transaction-${label}`
    const source = new Y.Doc({ gc: false })
    source.get('docs').insert(0, [new Y.Doc({ guid, autoLoad: true })])
    const host = new Y.Doc({ gc: false, sparseExactResolution: true })
    host.get('docs')
    let captured = /** @type {{transaction:Y.Transaction,added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}|null} */ (null)
    let delivered = /** @type {{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}|null} */ (null)
    let updates = 0
    host.on('afterTransaction', transaction => {
      captured = {
        transaction,
        added: transaction.subdocsAdded,
        loaded: transaction.subdocsLoaded,
        removed: transaction.subdocsRemoved
      }
      Object.freeze(transaction)
    })
    host.on('subdocs', subdocs => { delivered = subdocs })
    host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
    let failure = null
    try { apply(host, encode(source)) } catch (error) { failure = error }
    const child = /** @type {Y.Doc} */ (host.get('docs').get(0))
    const exactCaptured = captured !== null &&
      captured.transaction.subdocsAdded === captured.added && captured.transaction.subdocsLoaded === captured.loaded &&
      captured.transaction.subdocsRemoved === captured.removed && captured.added.size === 1 && captured.added.has(child) &&
      captured.loaded.size === 1 && captured.loaded.has(child) && captured.removed.size === 0
    const exactEvent = delivered !== null && delivered.added.size === 1 && delivered.added.has(child) &&
      delivered.loaded.size === 1 && delivered.loaded.has(child) && delivered.removed.size === 0
    results.push({
      label,
      error: failure === null,
      frozen: captured !== null && Object.isFrozen(captured.transaction),
      member: child !== undefined && host.subdocs.size === 1 && host.subdocs.has(child),
      sets: exactCaptured,
      event: exactEvent,
      update: updates === 1,
      cleanup: host._transaction === null && host._transactionCleanups.length === 0
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28ReservedParentClientIdIsNotReadAfterHooks = () => {
  /** @type {Array<{label:string,error:boolean,reads:boolean,writes:boolean,restored:boolean,commit:boolean,event:boolean,cleanup:boolean}>} */
  const results = []
  c28Transports.forEach(({ label, apply, encode, event }) => {
    const guid = `c28-reserved-parent-id-${label}`
    const source = new Y.Doc({ gc: false })
    source.get('docs').insert(0, [new Y.Doc({ guid, autoLoad: true })])
    const host = new Y.Doc({ gc: false, sparseExactResolution: true })
    host.get('docs')
    const reserved = host.clientID
    const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(host, 'clientID'))
    const accessError = new Error(`${label} late parent clientID access`)
    let poisoned = false
    let restored = false
    let reads = 0
    let writes = 0
    let updates = 0
    let subdocs = 0
    const restore = () => {
      if (!poisoned || restored) return
      Object.defineProperty(host, 'clientID', { ...descriptor, value: reserved })
      restored = true
    }
    host.on('beforeObserverCalls', () => {
      poisoned = true
      Object.defineProperty(host, 'clientID', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: () => { reads++; throw accessError },
        set: () => { writes++; throw accessError }
      })
    })
    host.on('afterTransactionCleanup', restore)
    host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
    host.on('subdocs', () => { subdocs++ })
    let failure = null
    try { apply(host, encode(source)) } catch (error) { failure = error } finally { restore() }
    const child = /** @type {Y.Doc|undefined} */ (host.get('docs').get(0))
    results.push({
      label,
      error: failure === null,
      reads: reads === 0,
      writes: writes === 0,
      restored,
      commit: child !== undefined && child.clientID === reserved && host.clientID === reserved && host.subdocs.has(child),
      event: updates === 1 && subdocs === 1,
      cleanup: host._transaction === null && host._transactionCleanups.length === 0
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28SparseMetaProofFailureRevokesCandidate = () => {
  /** @type {Array<{label:string,mode:string,error:boolean,prewrite:boolean,content:boolean,terminal:boolean,destroyed:boolean,retry:boolean,events:boolean,cleanup:boolean}>} */
  const results = []
  c28Transports.forEach(({ label, apply, encode, event }) => {
    ;['throw', 'destroy'].forEach(mode => {
      const guid = `c28-meta-proof-${label}-${mode}`
      const proofError = new Error(`${label} ${mode} meta proof`)
      let hostile = true
      /** @type {Array<Y.Doc>} */
      const candidates = []
      class TargetDoc extends Y.Doc {
        /** @param {import('../src/utils/Doc.js').DocOpts} [opts] */
        constructor (opts) {
          super(opts)
          if (opts?.guid !== guid) return
          candidates.push(this)
          if (!hostile) return
          Object.defineProperty(this.meta, 'value', {
            configurable: true,
            enumerable: true,
            get: () => {
              if (mode === 'destroy') {
                this.destroy()
                return 'wire'
              }
              throw proofError
            }
          })
        }
      }
      const source = new Y.Doc({ gc: false })
      source.get('docs').insert(0, [new Y.Doc({ guid, meta: { value: 'wire' }, autoLoad: true })])
      source.get('text').insert(0, ['x'])
      const update = encode(source)
      const host = new TargetDoc({ gc: false, sparseExactResolution: true })
      host.get('existing').insert(0, ['base'])
      const before = captureC28State(host, encode)
      let updates = 0
      let subdocs = 0
      host.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
      host.on('subdocs', () => { subdocs++ })
      const contents = /** @type {Array<Y.ContentDoc>} */ ([])
      const contentPrototype = Y.ContentDoc.prototype
      const previousDocDescriptor = Object.getOwnPropertyDescriptor(contentPrototype, 'doc')
      Object.defineProperty(contentPrototype, 'doc', {
        configurable: true,
        get: function () { return null },
        /** @this {Y.ContentDoc} @param {Y.Doc|null} value */
        set: function (value) {
          Object.defineProperty(this, 'doc', { value, writable: true, enumerable: true, configurable: true })
          contents.push(this)
        }
      })
      let failure = null
      try { apply(host, update) } catch (error) { failure = error } finally {
        if (previousDocDescriptor === undefined) Reflect.deleteProperty(contentPrototype, 'doc')
        else Object.defineProperty(contentPrototype, 'doc', previousDocDescriptor)
      }
      const candidate = candidates[0]
      if (candidate !== undefined) {
        Object.defineProperty(candidate.meta, 'value', { value: 'wire', writable: true, enumerable: true, configurable: true })
      }
      /** @param {Array<number>} left @param {Array<number>} right */
      const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index])
      const prewrite = same(Array.from(encode(host)), before.bytes) && same(Array.from(Y.encodeStateVector(host)), before.state) &&
        host.store.clients.size === before.clients.size && [...before.clients].every(([client, structs]) => host.store.clients.get(client) === structs) &&
        host.store.pendingStructs === before.pendingStructs && host.store.pendingDs === before.pendingDs &&
        host.share === before.share && host.share.size === before.roots.size && [...before.roots].every(([key, root]) => host.share.get(key) === root) &&
        host.subdocs.size === before.subdocs.size
      const contentCleared = contents.length > 0 && contents.every(content => content.doc === null)
      const probe = new Y.Doc({ gc: false })
      let attachFailure = null
      try { probe.get('docs').insert(0, [candidate]) } catch (error) { attachFailure = error }
      const terminal = attachFailure instanceof Error && probe.get('docs').length === 0 && probe.subdocs.size === 0
      hostile = false
      let retryFailure = null
      try { apply(host, update) } catch (error) { retryFailure = error }
      const child = /** @type {Y.Doc|undefined} */ (host.get('docs').get(0))
      results.push({
        label,
        mode,
        error: mode === 'throw' ? failure === proofError : failure instanceof Error,
        prewrite,
        content: contentCleared,
        terminal,
        destroyed: mode === 'throw' || (candidate !== undefined && candidate.isDestroyed),
        retry: retryFailure === null && candidates.length === 2 && child === candidates[1] && child !== candidate && host.subdocs.has(child),
        events: updates === 1 && subdocs === 1,
        cleanup: host._transaction === null && host._transactionCleanups.length === 0
      })
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || key === 'mode' || value === true)), JSON.stringify(results))
}

export const testC28DestroyedParentRejectsLocalSubdocAdmission = () => {
  /** @type {Array<{label:string,error:boolean,state:boolean,event:boolean,child:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    parent.destroy()
    const beforeState = Array.from(Y.encodeStateVector(parent))
    const beforeClients = new Map(parent.store.clients)
    const pendingStructs = parent.store.pendingStructs
    const pendingDs = parent.store.pendingDs
    const child = new Y.Doc({ guid: `c28-destroyed-parent-${label}` })
    let updates = 0
    let updatesV2 = 0
    let subdocs = 0
    parent.on('update', () => { updates++ })
    parent.on('updateV2', () => { updatesV2++ })
    parent.on('subdocs', () => { subdocs++ })
    let failure = null
    try { docs.insert(0, [child]) } catch (error) { failure = error }
    const fresh = new Y.Doc({ gc: false })
    let retryFailure = null
    try { fresh.get('docs').insert(0, [child]) } catch (error) { retryFailure = error }
    const afterState = Array.from(Y.encodeStateVector(parent))
    results.push({
      label,
      error: failure instanceof Error,
      state: beforeState.length === afterState.length && beforeState.every((value, index) => value === afterState[index]) &&
        parent.store.clients.size === beforeClients.size && [...beforeClients].every(([client, structs]) => parent.store.clients.get(client) === structs) &&
        parent.store.pendingStructs === pendingStructs && parent.store.pendingDs === pendingDs && docs.length === 0 && parent.subdocs.size === 0,
      event: updates === 0 && updatesV2 === 0 && subdocs === 0,
      child: retryFailure === null && !child.isDestroyed && fresh.get('docs').get(0) === child && fresh.subdocs.has(child),
      cleanup: parent._transaction === null && parent._transactionCleanups.length === 0
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28InvalidParentSubdocsRejectsLocalMutationPrewrite = () => {
  /** @type {Array<{label:string,error:boolean,state:boolean,silent:boolean,child:boolean,retry:boolean,event:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    ;['insert', 'delete'].forEach(operation => {
      const label = `${sparse ? 'sparse' : 'ordinary'}-${operation}`
      const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
      const docs = parent.get('docs')
      const child = new Y.Doc({ guid: `c28-invalid-parent-membership-${label}`, shouldLoad: false })
      if (operation === 'delete') docs.insert(0, [child])
      const parentSubdocs = parent.subdocs
      const before = captureC28State(parent, Y.encodeStateAsUpdateV2)
      let updates = 0
      let updatesV2 = 0
      let subdocs = 0
      const delivered = /** @type {Array<{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}>} */ ([])
      let armed = true
      parent.on('beforeTransaction', () => {
        if (armed) {
          armed = false
          parent.subdocs = /** @type {any} */ ({})
        }
      })
      parent.on('update', () => { updates++ })
      parent.on('updateV2', () => { updatesV2++ })
      parent.on('subdocs', event => { subdocs++; delivered.push(event) })
      const mutate = () => operation === 'insert' ? docs.insert(0, [child]) : docs.delete(0, 1)
      let failure = null
      try { mutate() } catch (error) { failure = error }
      parent.subdocs = parentSubdocs
      /** @param {Array<number>} left @param {Array<number>} right */
      const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index])
      let state = false
      try {
        state = same(Array.from(Y.encodeStateAsUpdateV2(parent)), before.bytes) && same(Array.from(Y.encodeStateVector(parent)), before.state) &&
          parent.store.clients.size === before.clients.size && [...before.clients].every(([client, structs]) => parent.store.clients.get(client) === structs) &&
          parent.store.pendingStructs === before.pendingStructs && parent.store.pendingDs === before.pendingDs &&
          parent.share === before.share && parent.share.size === before.roots.size && [...before.roots].every(([key, root]) => parent.share.get(key) === root) &&
          parent.subdocs.size === before.subdocs.size && [...before.subdocs].every(subdoc => parent.subdocs.has(subdoc))
      } catch (_error) {}
      const childIntact = operation === 'insert'
        ? child._item === null && docs.length === 0 && !parent.subdocs.has(child) && !child.isDestroyed
        : child._item !== null && !child._item.deleted && docs.length === 1 && docs.get(0) === child && parent.subdocs.has(child) && !child.isDestroyed
      const silent = updates === 0 && updatesV2 === 0 && subdocs === 0
      let retryFailure = null
      try { mutate() } catch (error) { retryFailure = error }
      const exactEvent = operation === 'insert'
        ? delivered.length === 1 && delivered[0].added.size === 1 && delivered[0].added.has(child) && delivered[0].loaded.size === 0 && delivered[0].removed.size === 0
        : delivered.length === 2 && delivered.every(event => event.added.size === 0 && event.loaded.size === 0 && event.removed.size === 1 && event.removed.has(child))
      const retry = operation === 'insert'
        ? retryFailure === null && docs.length === 1 && docs.get(0) === child && parent.subdocs.size === 1 && parent.subdocs.has(child)
        : retryFailure === null && docs.length === 0 && parent.subdocs.size === 0
      results.push({
        label,
        error: failure instanceof Error,
        state,
        silent,
        child: childIntact,
        retry,
        event: updates === 1 && updatesV2 === 1 && subdocs === (operation === 'insert' ? 1 : 2) && exactEvent,
        cleanup: parent._transaction === null && parent._transactionCleanups.length === 0
      })
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28QueuedSubdocReplacementRebuildsForgedMembership = () => {
  /** @type {Array<{label:string,root:boolean,member:boolean,event:boolean,update:boolean,reload:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    const existing = new Y.Doc({ guid: `c28-queued-existing-${label}`, shouldLoad: false })
    const incoming = new Y.Doc({ guid: `c28-queued-incoming-${label}`, shouldLoad: false })
    const forged = new Y.Doc({ guid: `c28-queued-forged-${label}` })
    docs.insert(0, [existing])
    const originalSubdocs = parent.subdocs
    let replacement = /** @type {Set<Y.Doc>|null} */ (null)
    let armed = true
    let updates = 0
    let updatesV2 = 0
    /** @type {Array<{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}>} */
    const events = []
    parent.on('beforeObserverCalls', () => {
      if (!armed) return
      armed = false
      originalSubdocs.clear()
      replacement = new Set([forged])
      parent.subdocs = replacement
      parent.transact(() => {
        docs.insert(docs.length, [incoming])
        docs.delete(docs.toArray().indexOf(existing), 1)
      })
    })
    parent.on('update', () => { updates++ })
    parent.on('updateV2', () => { updatesV2++ })
    parent.on('subdocs', event => events.push(event))

    parent.get('trigger').insert(0, ['x'])
    const exactEvents = events.length === 2 &&
      events[0].added.size === 1 && events[0].added.has(incoming) && events[0].removed.size === 1 && events[0].removed.has(existing) && events[0].loaded.size === 0 &&
      events[1].added.size === 0 && events[1].removed.size === 1 && events[1].removed.has(existing) && events[1].loaded.size === 0
    const snapshot = Y.encodeStateAsUpdateV2(parent)
    const reload = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    Y.applyUpdateV2(reload, snapshot)
    const reloaded = /** @type {Y.Doc} */ (reload.get('docs').get(0))
    results.push({
      label,
      root: docs.length === 1 && docs.get(0) === incoming && incoming._item !== null && !incoming._item.deleted && existing.isDestroyed,
      member: replacement !== null && parent.subdocs === replacement && replacement.size === 1 && replacement.has(incoming) &&
        !replacement.has(existing) && !replacement.has(forged) && originalSubdocs.size === 0 && forged._item === null,
      event: exactEvents,
      update: updates === 2 && updatesV2 === 2,
      reload: reload.get('docs').length === 1 && reloaded.guid === incoming.guid && reload.subdocs.size === 1 && reload.subdocs.has(reloaded) &&
        !Array.from(reload.subdocs, doc => doc.guid).includes(existing.guid) && !Array.from(reload.subdocs, doc => doc.guid).includes(forged.guid) &&
        reload.get('trigger').get(0) === 'x',
      cleanup: parent._transaction === null && parent._transactionCleanups.length === 0 && reload._transactionCleanups.length === 0
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28NestedQueuedSubdocsShareCanonicalMembership = () => {
  /** @type {Array<{label:string,root:boolean,member:boolean,event:boolean,update:boolean,reload:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    const childA = new Y.Doc({ guid: `c28-queued-a-${label}`, shouldLoad: false })
    const childB = new Y.Doc({ guid: `c28-queued-b-${label}`, shouldLoad: false })
    let armed = true
    let updates = 0
    let updatesV2 = 0
    /** @type {Array<{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}>} */
    const events = []
    parent.on('beforeObserverCalls', () => {
      if (!armed) return
      armed = false
      parent.transact(() => docs.insert(docs.length, [childB]))
    })
    parent.on('update', () => { updates++ })
    parent.on('updateV2', () => { updatesV2++ })
    parent.on('subdocs', event => events.push(event))

    docs.insert(0, [childA])
    const exactEvents = events.length === 2 &&
      events[0].added.size === 1 && events[0].added.has(childA) && events[0].loaded.size === 0 && events[0].removed.size === 0 &&
      events[1].added.size === 1 && events[1].added.has(childB) && events[1].loaded.size === 0 && events[1].removed.size === 0
    const snapshot = Y.encodeStateAsUpdateV2(parent)
    const reload = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    Y.applyUpdateV2(reload, snapshot)
    const reloadGuids = new Set(Array.from(reload.subdocs, doc => doc.guid))
    results.push({
      label,
      root: docs.length === 2 && docs.toArray().includes(childA) && docs.toArray().includes(childB) &&
        childA._item !== null && !childA._item.deleted && childB._item !== null && !childB._item.deleted,
      member: parent.subdocs.size === 2 && parent.subdocs.has(childA) && parent.subdocs.has(childB),
      event: exactEvents,
      update: updates === 2 && updatesV2 === 2,
      reload: reload.get('docs').length === 2 && reload.subdocs.size === 2 && reloadGuids.has(childA.guid) && reloadGuids.has(childB.guid),
      cleanup: parent._transaction === null && parent._transactionCleanups.length === 0 && reload._transactionCleanups.length === 0
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28WritableNonconfigurableSubdocsMirrorIsReconciled = () => {
  /** @type {Array<{label:string,error:boolean,mirror:boolean,root:boolean,event:boolean,update:boolean,reload:boolean,cleanup:boolean}>} */
  const results = []
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const parent = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const docs = parent.get('docs')
    const childA = new Y.Doc({ guid: `c28-mirror-a-${label}`, shouldLoad: false })
    const childB = new Y.Doc({ guid: `c28-mirror-b-${label}`, shouldLoad: false })
    let armed = true
    let updates = 0
    let updatesV2 = 0
    /** @type {Array<{added:Set<Y.Doc>,loaded:Set<Y.Doc>,removed:Set<Y.Doc>}>} */
    const events = []
    parent.on('afterTransaction', () => {
      if (!armed) return
      armed = false
      Object.defineProperty(parent, 'subdocs', { value: {}, writable: true, enumerable: true, configurable: false })
    })
    parent.on('update', () => { updates++ })
    parent.on('updateV2', () => { updatesV2++ })
    parent.on('subdocs', event => events.push(event))

    let firstFailure = null
    try { docs.insert(0, [childA]) } catch (error) { firstFailure = error }
    const firstDescriptor = Object.getOwnPropertyDescriptor(parent, 'subdocs')
    const firstMirror = firstDescriptor?.value instanceof Set && firstDescriptor.value.size === 1 && firstDescriptor.value.has(childA)
    let secondFailure = null
    try { docs.insert(docs.length, [childB]) } catch (error) { secondFailure = error }
    const descriptor = Object.getOwnPropertyDescriptor(parent, 'subdocs')
    const mirror = descriptor?.value instanceof Set && descriptor.writable === true && descriptor.configurable === false &&
      descriptor.value.size === 2 && descriptor.value.has(childA) && descriptor.value.has(childB)
    const exactEvents = events.length === 2 &&
      events[0].added.size === 1 && events[0].added.has(childA) && events[0].loaded.size === 0 && events[0].removed.size === 0 &&
      events[1].added.size === 1 && events[1].added.has(childB) && events[1].loaded.size === 0 && events[1].removed.size === 0
    const snapshot = Y.encodeStateAsUpdateV2(parent)
    const reload = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    Y.applyUpdateV2(reload, snapshot)
    const reloadGuids = new Set(Array.from(reload.subdocs, doc => doc.guid))
    results.push({
      label,
      error: firstFailure === null && secondFailure === null,
      mirror: firstMirror && mirror,
      root: docs.length === 2 && docs.toArray().includes(childA) && docs.toArray().includes(childB) &&
        childA._item !== null && !childA._item.deleted && childB._item !== null && !childB._item.deleted,
      event: exactEvents,
      update: updates === 2 && updatesV2 === 2,
      reload: reload.get('docs').length === 2 && reload.subdocs.size === 2 && reloadGuids.has(childA.guid) && reloadGuids.has(childB.guid),
      cleanup: parent._transaction === null && parent._transactionCleanups.length === 0 && reload._transactionCleanups.length === 0
    })
  })
  t.assert(results.every(result => Object.entries(result).every(([key, value]) => key === 'label' || value === true)), JSON.stringify(results))
}

export const testC28ParentProxyCannotBypassSelfAdmission = () => {
  ;[false, true].forEach(sparse => {
    const label = sparse ? 'sparse' : 'ordinary'
    const raw = new Y.Doc(sparse ? { gc: false, sparseExactResolution: true } : { gc: false })
    const proxy = new Proxy(raw, {})
    const docs = proxy.get('docs')
    const before = captureC28State(raw, Y.encodeStateAsUpdateV2)
    let updates = 0
    let subdocs = 0
    let destroys = 0
    raw.on('update', () => { updates++ })
    raw.on('subdocs', () => { subdocs++ })
    raw.on('destroy', () => { destroys++ })
    let failure = null
    try { docs.insert(0, [raw]) } catch (error) { failure = error }
    t.assert(failure instanceof Error, `${label} proxy parent self admission`)
    assertC28State(raw, Y.encodeStateAsUpdateV2, before, `${label} proxy parent self admission`)
    t.assert(docs.length === 0 && raw._item === null && updates === 0 && subdocs === 0)
    raw.destroy()
    t.assert(raw.isDestroyed && destroys === 1 && raw.subdocs.size === 0 && raw._transactionCleanups.length === 0, `${label} finite destroy`)
  })
}

export const testSparsePreparationMapSetPoisonCannotRedirectRoot = () => {
  ;[
    { apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ apply, encode, event }) => {
    const source = new Y.Doc({ gc: false })
    source.get('intended-root').insert(0, ['x'])
    const update = encode(source)
    const target = new Y.Doc({ gc: false, sparseExactResolution: true })
    const intendedRoot = target.get('intended-root')
    const redirectedRoot = target.get('redirected-root')
    const before = Array.from(encode(target))
    const beforeState = Array.from(Y.encodeStateVector(target))
    const originalGet = target.get
    const originalSet = Map.prototype.set
    let arm = true
    let poisonedWrites = 0
    let events = 0
    target.get = /** @param {string} name @param {string|null} [typeName] */ function (name, typeName) {
      const type = Reflect.apply(originalGet, this, [name, typeName])
      if (arm && name === 'intended-root') {
        arm = false
        Reflect.set(Map.prototype, 'set', /** @this {Map<unknown,unknown>} @param {unknown} key @param {unknown} value */ function (key, value) {
          if (key instanceof Y.Item && key.parent === 'intended-root') {
            poisonedWrites++
            return Reflect.apply(originalSet, this, [key, redirectedRoot])
          }
          return Reflect.apply(originalSet, this, [key, value])
        })
      }
      return type
    }
    target.on(/** @type {'update'|'updateV2'} */ (event), () => { events++ })

    let failure = null
    try {
      apply(target, update)
    } catch (error) {
      failure = error
    } finally {
      target.get = originalGet
      Reflect.set(Map.prototype, 'set', originalSet)
    }
    t.assert(target.get === originalGet && Map.prototype.set === originalSet && new Map([['clean', true]]).get('clean') === true)
    if (failure !== null) {
      t.compareArrays(Array.from(encode(target)), before)
      t.compareArrays(Array.from(Y.encodeStateVector(target)), beforeState)
      t.assert(intendedRoot.length === 0 && redirectedRoot.length === 0 && target.store.clients.size === 0 && events === 0)
      apply(target, update)
    }
    t.assert(poisonedWrites === 0 || (intendedRoot.toArray()[0] === 'x' && redirectedRoot.length === 0))
    t.assert(intendedRoot.toArray()[0] === 'x' && redirectedRoot.length === 0 && events === 1)
    t.compareArrays(Array.from(Y.encodeStateVector(target)), Array.from(Y.encodeStateVector(source)))
    const reload = new Y.Doc({ gc: false })
    apply(reload, encode(target))
    t.assert(reload.get('intended-root').toArray()[0] === 'x' && reload.get('redirected-root').length === 0)
  })
}

export const testSparseLateArrayIteratorCannotSuppressIntegrationSchedule = () => {
  ;[
    { apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ apply, encode, event }) => {
    const source = new Y.Doc({ gc: false })
    source.get('scheduled-root').insert(0, ['x'])
    const update = encode(source)
    const target = new Y.Doc({ gc: false, sparseExactResolution: true })
    const before = Array.from(encode(target))
    const beforeState = Array.from(Y.encodeStateVector(target))
    const originalIterator = Array.prototype[Symbol.iterator]
    let arm = true
    let suppressed = 0
    let events = 0
    target.on('beforeTransaction', () => {
      if (!arm) return
      arm = false
      Reflect.set(Array.prototype, Symbol.iterator, /** @this {Array<unknown>} */ function () {
        const entry = this[0]
        if (
          this.length > 0 && entry !== null && typeof entry === 'object' &&
          Object.prototype.hasOwnProperty.call(entry, 'struct') &&
          Object.prototype.hasOwnProperty.call(entry, 'clock') &&
          Object.prototype.hasOwnProperty.call(entry, 'gap')
        ) {
          suppressed++
          return Reflect.apply(originalIterator, [], [])
        }
        return Reflect.apply(originalIterator, this, [])
      })
    })
    target.on(/** @type {'update'|'updateV2'} */ (event), () => { events++ })

    let failure = null
    try {
      apply(target, update)
    } catch (error) {
      failure = error
    } finally {
      Reflect.set(Array.prototype, Symbol.iterator, originalIterator)
    }
    t.assert(Array.prototype[Symbol.iterator] === originalIterator && Array.from(['clean'])[0] === 'clean')
    if (failure !== null) {
      t.compareArrays(Array.from(encode(target)), before)
      t.compareArrays(Array.from(Y.encodeStateVector(target)), beforeState)
      t.assert(!target.share.has('scheduled-root') && target.store.clients.size === 0 && events === 0)
      apply(target, update)
    }
    t.assert(suppressed === 0 || target.get('scheduled-root').toArray()[0] === 'x')
    t.assert(target.get('scheduled-root').toArray()[0] === 'x' && events === 1)
    t.compareArrays(Array.from(Y.encodeStateVector(target)), Array.from(Y.encodeStateVector(source)))
    const reload = new Y.Doc({ gc: false })
    apply(reload, encode(target))
    t.assert(reload.get('scheduled-root').toArray()[0] === 'x')
  })
}

export const testSparsePendingStateSerializesWithDocumentContext = () => {
  ;[
    {
      Encoder: Y.UpdateEncoderV1,
      apply: Y.applyUpdate,
      encode: Y.encodeStateAsUpdate,
      convert: (/** @type {Uint8Array<ArrayBuffer>} */ update) => update
    },
    {
      Encoder: Y.UpdateEncoderV2,
      apply: Y.applyUpdateV2,
      encode: Y.encodeStateAsUpdateV2,
      convert: Y.convertUpdateFormatV1ToV2
    }
  ].forEach(({ Encoder, apply, encode, convert }) => {
    const source = new Y.Doc({ gc: false })
    source.clientID = 2
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const sourceUpdates = []
    source.on('update', update => sourceUpdates.push(update))
    source.get('text').insert(0, 'a')
    source.get('text').insert(1, 'b')

    const sparse = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(sparse, encodeCausalHoles([
      new CausalHole(Y.createID(3, 0), 1, null, null, 'unrelated', null)
    ], Encoder))
    apply(sparse, convert(sourceUpdates[1]))
    t.assert(!sparse.store.causalHoles.isEmpty() && sparse.store.pendingStructs !== null)

    const snapshot = encode(sparse)
    const reloaded = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(reloaded, snapshot)
    t.assert(!reloaded.store.causalHoles.isEmpty() && reloaded.store.pendingStructs !== null)
    t.assert(reloaded.get('text').toString() === '')
    apply(reloaded, convert(sourceUpdates[0]))
    t.assert(reloaded.store.pendingStructs === null && reloaded.get('text').toString() === 'ab')

    const deletes = new Y.Doc({ gc: false })
    deletes.clientID = 4
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const deleteUpdates = []
    deletes.on('update', update => deleteUpdates.push(update))
    deletes.get('deleted').insert(0, 'x')
    deletes.get('deleted').delete(0, 1)

    const pendingDelete = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(pendingDelete, encodeCausalHoles([
      new CausalHole(Y.createID(6, 0), 1, null, null, 'unrelated', null)
    ], Encoder))
    pendingDelete.clientID = 5
    pendingDelete.get('local').insert(0, 'z')
    pendingDelete.get('local').delete(0, 1)
    apply(pendingDelete, convert(deleteUpdates[1]))
    t.assert(pendingDelete.store.pendingDs !== null && pendingDelete.store.ds.has(5, 0))
    t.assert(!pendingDelete.store.causalHoles.isEmpty())

    const deleteSnapshot = encode(pendingDelete)
    const deleteReload = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(deleteReload, deleteSnapshot)
    t.assert(deleteReload.store.pendingDs !== null && deleteReload.store.ds.has(5, 0))
    t.assert(!deleteReload.store.causalHoles.isEmpty())
    apply(deleteReload, convert(deleteUpdates[0]))
    t.assert(deleteReload.store.pendingDs === null)
    t.assert(deleteReload.store.ds.has(4, 0) && deleteReload.store.ds.has(5, 0))
    t.assert(deleteReload.get('deleted').toString() === '')
  })
}

export const testSparsePendingStateRejectsInvalidInternalTransport = () => {
  ;[Y.encodeStateAsUpdate, Y.encodeStateAsUpdateV2].forEach(encode => {
    const withGc = createCausalHoleBase()
    const gcUpdate = encodeStructs([new Y.GC(Y.createID(7, 0), 1)], Y.UpdateEncoderV2)
    commitPendingUpdate(withGc, new Map(), gcUpdate)
    t.fails(() => encode(withGc))

    const withUnsupportedRef = createCausalHoleBase()
    commitPendingUpdate(withUnsupportedRef, new Map(), encodeUnsupportedSparseRef(12, Y.UpdateEncoderV2), Y.encodeStateAsUpdateV2(new Y.Doc()))
    t.fails(() => encode(withUnsupportedRef))

    const withConflict = createCausalHoleBase()
    Y.applyUpdateV2(withConflict, encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'text', null)
    ], Y.UpdateEncoderV2))
    const conflict = encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 1, null, null, 'other', null)
    ], Y.UpdateEncoderV2)
    commitPendingUpdate(withConflict, new Map(), conflict)
    t.fails(() => encode(withConflict))
  })
}

export const testSparsePendingStateRejectsForgedMissingPairsBeforeFiltering = () => {
  const targetState = new Y.Doc({ gc: false })
  targetState.clientID = 2
  targetState.get('text').insert(0, 'known')
  const dishonestStateVector = Y.encodeStateVector(targetState)
  const pendingItem = encodeStructs([
    new Y.Item(
      Y.createID(2, 0),
      null,
      Y.createID(1, 0),
      null,
      null,
      'text',
      null,
      new Y.ContentString('X')
    )
  ], Y.UpdateEncoderV2)
  const pendingDeleteIds = Y.createIdSet()
  pendingDeleteIds.add(77, 0, 1)
  const pendingDelete = encodeDeleteSet(pendingDeleteIds, Y.UpdateEncoderV2)

  ;[Y.encodeStateAsUpdate, Y.encodeStateAsUpdateV2].forEach(encode => {
    ;[false, true].forEach(withPendingDelete => {
      ;[new Uint8Array([0]), dishonestStateVector].forEach(stateVector => {
        const doc = createCausalHoleBase()
        Y.applyUpdateV2(doc, encodeCausalHoles([
          new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'text', null)
        ], Y.UpdateEncoderV2))
        commitPendingUpdate(doc, new Map([[99, 0]]), pendingItem)
        if (withPendingDelete) commitPendingDelete(doc, pendingDelete)
        const hole = doc.store.getCausalHole(Y.createID(2, 0))
        const pendingStructs = doc.store.pendingStructs
        const pendingDs = doc.store.pendingDs
        t.fails(() => encode(doc, stateVector))
        t.assert(doc.store.getCausalHole(Y.createID(2, 0)) === hole)
        const pendingStructsAfter = doc.store.pendingStructs
        const pendingDsAfter = doc.store.pendingDs
        t.assert(
          pendingStructs !== null && pendingStructsAfter !== null &&
          pendingStructs.missing.size === pendingStructsAfter.missing.size &&
          pendingStructs.update.every((value, index) => pendingStructsAfter.update[index] === value) &&
          (pendingDs === null ? pendingDsAfter === null : pendingDsAfter !== null && pendingDs.every((value, index) => pendingDsAfter[index] === value))
        )
        t.assert(doc.get('text').toString() === 'a')
      })
    })
  })
}

export const testSparseCombinedPendingStateRoundtrips = () => {
  ;[
    {
      apply: Y.applyUpdate,
      encode: Y.encodeStateAsUpdate,
      convert: (/** @type {Uint8Array<ArrayBuffer>} */ update) => update
    },
    {
      apply: Y.applyUpdateV2,
      encode: Y.encodeStateAsUpdateV2,
      convert: Y.convertUpdateFormatV1ToV2
    }
  ].forEach(({ apply, encode, convert }) => {
    const inserts = new Y.Doc({ gc: false })
    inserts.clientID = 12
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const insertUpdates = []
    inserts.on('update', update => insertUpdates.push(update))
    inserts.get('later').insert(0, 'a')
    inserts.get('later').insert(1, 'b')

    const deletes = new Y.Doc({ gc: false })
    deletes.clientID = 13
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const deleteUpdates = []
    deletes.on('update', update => deleteUpdates.push(update))
    deletes.get('deleted').insert(0, 'x')
    deletes.get('deleted').delete(0, 1)

    const doc = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(doc, convert(encodeCausalHoles([
      new CausalHole(Y.createID(14, 0), 1, null, null, 'unrelated', null)
    ], Y.UpdateEncoderV1)))
    apply(doc, convert(insertUpdates[1]))
    apply(doc, convert(deleteUpdates[1]))
    t.assert(!doc.store.causalHoles.isEmpty() && doc.store.pendingStructs !== null && doc.store.pendingDs !== null)
    const snapshot = encode(doc)

    const reload = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(reload, snapshot)
    t.assert(!reload.store.causalHoles.isEmpty() && reload.store.pendingStructs !== null && reload.store.pendingDs !== null)
    apply(reload, convert(insertUpdates[0]))
    apply(reload, convert(deleteUpdates[0]))
    t.assert(reload.store.pendingStructs === null && reload.store.pendingDs === null)
    t.assert(reload.get('later').toString() === 'ab' && reload.get('deleted').toString() === '')
  })
}

export const testIndexedPendingFilterPreservesSameClientPrefixes = () => {
  ;[
    { event: 'update', apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { event: 'updateV2', apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ event, apply, encode }) => {
    const source = new Y.Doc({ gc: false })
    source.clientID = 2
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const updates = []
    source.on(/** @type {'update'} */ (event), update => updates.push(update))
    source.get('text').insert(0, 'a')
    source.get('text').insert(1, 'b')
    source.get('text').insert(2, 'c')

    const doc = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(doc, updates[0])
    apply(doc, updates[2])
    t.assert(doc.get('text').toString() === 'a' && doc.store.pendingStructs !== null)

    const reload = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(reload, encode(doc))
    t.assert(reload.get('text').toString() === 'a' && reload.store.pendingStructs !== null)

    const known = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(known, updates[0])
    apply(known, encode(doc, Y.encodeStateVector(known)))
    t.assert(known.get('text').toString() === 'a' && known.store.pendingStructs !== null)
  })
}

export const testOrdinaryPendingFieldsKeepUpstreamDescriptors = () => {
  const store = new Y.Doc().store
  const pendingStructs = { missing: new Map([[1, 0]]), update: new Uint8Array([0, 0]) }
  const pendingDs = new Uint8Array([0, 0])
  const structsDescriptor = Object.getOwnPropertyDescriptor(store, 'pendingStructs')
  const deletesDescriptor = Object.getOwnPropertyDescriptor(store, 'pendingDs')

  t.assert(
    structsDescriptor?.value === null && structsDescriptor.writable && structsDescriptor.enumerable && structsDescriptor.configurable &&
    deletesDescriptor?.value === null && deletesDescriptor.writable && deletesDescriptor.enumerable && deletesDescriptor.configurable
  )
  store.pendingStructs = pendingStructs
  store.pendingDs = pendingDs
  t.assert(store.pendingStructs === pendingStructs && store.pendingDs === pendingDs)
  t.compareArrays(Object.keys(store).slice(0, 3), ['clients', 'pendingStructs', 'pendingDs'])
  t.assert(Reflect.deleteProperty(store, 'pendingStructs') && store.pendingStructs === undefined)
  t.assert(Reflect.deleteProperty(store, 'pendingDs') && store.pendingDs === undefined)
  store.pendingStructs = pendingStructs
  store.pendingDs = pendingDs
  t.assert(store.pendingStructs === pendingStructs && store.pendingDs === pendingDs)

  const sparseStore = new Y.Doc({ gc: false, sparseExactResolution: true }).store
  const sparseStructsDescriptor = Object.getOwnPropertyDescriptor(sparseStore, 'pendingStructs')
  const sparseDeletesDescriptor = Object.getOwnPropertyDescriptor(sparseStore, 'pendingDs')
  t.assert(
    typeof sparseStructsDescriptor?.get === 'function' && typeof sparseStructsDescriptor.set === 'function' &&
    sparseStructsDescriptor.enumerable && !sparseStructsDescriptor.configurable &&
    typeof sparseDeletesDescriptor?.get === 'function' && typeof sparseDeletesDescriptor.set === 'function' &&
    sparseDeletesDescriptor.enumerable && !sparseDeletesDescriptor.configurable
  )
  t.fails(() => { sparseStore.pendingStructs = pendingStructs })
  t.fails(() => { sparseStore.pendingDs = pendingDs })
}

export const testIndexedPendingFilterMatchesLegacySparseEncoding = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, event: 'update', apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, event: 'updateV2', apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, event, apply, encode }) => {
    const doc = new Y.Doc({ gc: false, sparseExactResolution: true })
    ;[40, 41].forEach(client => {
      const source = new Y.Doc({ gc: false })
      source.clientID = client
      /** @type {Array<Uint8Array<ArrayBuffer>>} */
      const updates = []
      source.on(/** @type {'update'} */ (event), update => updates.push(update))
      source.get(`client-${client}`).insert(0, 'abcd')
      source.get(`client-${client}`).insert(4, 'efgh')
      source.get(`client-${client}`).insert(8, 'ijkl')
      apply(doc, updates[0])
      apply(doc, updates[2])
    })
    apply(doc, encodeCausalHoles([
      new CausalHole(Y.createID(42, 0), 2, null, null, 'holes', null)
    ], Encoder))
    const pendingDelete = Y.createIdSet()
    pendingDelete.add(99, 0, 2)
    apply(doc, encodeDeleteSet(pendingDelete, Encoder))

    ;[
      new Map(),
      new Map([[40, 2], [41, 6], [42, 1]]),
      new Map([[40, 10], [41, 9], [42, 2]]),
      new Map([[40, 99], [41, 99], [42, 99]])
    ].forEach(state => {
      const stateVector = encodeStateVectorMap(state)
      t.compareArrays(Array.from(encode(doc, stateVector)), Array.from(encodeSparseStateLegacy(doc, stateVector, Encoder)))
    })
  })

  const leadingSkip = encodeStructs([
    new Y.Skip(Y.createID(50, 0), 2),
    new Y.Item(Y.createID(50, 2), null, null, null, null, 'text', null, new Y.ContentString('abcdef'))
  ], Y.UpdateEncoderV2)
  const indexed = decodePendingIndex(leadingSkip)
  ;[0, 1, 2, 3, 7, 99].forEach(clock => {
    const stateVector = encodeStateVectorMap(new Map([[50, clock]]))
    const encoder = new Y.UpdateEncoderV2()
    writeBlockSet(encoder, indexed.blocks.filterStateVector(Y.decodeStateVector(stateVector)))
    Y.writeIdSet(encoder, indexed.deletes)
    t.compareArrays(Array.from(encoder.toUint8Array()), Array.from(Y.diffUpdateV2(leadingSkip, stateVector)))
  })
}

export const testSparseSkipAndIndexedPendingScalingInvariants = () => {
  ;[2_000_000, 16_000_000].forEach(size => {
    const doc = new Y.Doc({ gc: false, sparseExactResolution: true })
    doc.clientID = 60
    doc.get('large').insert(0, 'a'.repeat(size))

    const source = new Y.Doc({ gc: false })
    source.clientID = 61
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const updates = []
    source.on('update', update => updates.push(update))
    source.get('pending').insert(0, 'a')
    source.get('pending').insert(1, 'b')
    Y.applyUpdate(doc, updates[1])

    const skip = encodeStructs([new Y.Skip(Y.createID(62, 0), 1)], Y.UpdateEncoderV1)
    t.assert(skip.byteLength === 7)
    Y.applyUpdate(doc, skip)
    const stateVector = encodeStateVectorMap(new Map([[60, size], [61, 2], [62, 1]]))
    t.assert(Y.encodeStateAsUpdate(doc, stateVector).byteLength < 256)
    const revision = getPendingRevision(doc.store)
    const proofRuns = _testOnlyGetSparsePendingProofRuns(doc)
    const pending = readIndexedPendingStructs(doc.store)
    const blocks = pending?.blocks
    for (let index = 0; index < 50; index++) Y.applyUpdate(doc, skip)
    t.assert(getPendingRevision(doc.store) === revision)
    t.assert(Y.encodeStateAsUpdate(doc, stateVector).byteLength < 256)
    t.assert(Y.encodeStateAsUpdateV2(doc, stateVector).byteLength < 256)
    t.assert(_testOnlyGetSparsePendingProofRuns(doc) === proofRuns)
    t.assert(readIndexedPendingStructs(doc.store)?.blocks === blocks)
  })

  ;[8_000_000, 16_000_000].forEach(size => {
    const source = new Y.Doc({ gc: false })
    source.clientID = 63
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const updates = []
    source.on('update', update => updates.push(update))
    source.get('pending').insert(0, 'a')
    source.get('pending').insert(1, 'x'.repeat(size))
    const doc = new Y.Doc({ gc: false, sparseExactResolution: true })
    Y.applyUpdate(doc, updates[1])
    Y.encodeStateAsUpdate(doc, encodeStateVectorMap(new Map([[63, size + 1]])))
    const pending = readIndexedPendingStructs(doc.store)
    const revision = getPendingRevision(doc.store)
    const proofRuns = _testOnlyGetSparsePendingProofRuns(doc)
    ;[size - 2, size - 1, size, size + 1].forEach(clock => {
      Y.encodeStateAsUpdateV2(doc, encodeStateVectorMap(new Map([[63, clock]])))
      t.assert(readIndexedPendingStructs(doc.store)?.blocks === pending?.blocks)
    })
    t.assert(getPendingRevision(doc.store) === revision && _testOnlyGetSparsePendingProofRuns(doc) === proofRuns)
  })
}

export const testSparsePendingProofCacheTracksTransactionsAndDefensiveSnapshots = () => {
  const doc = new Y.Doc({ gc: false, sparseExactResolution: true })
  doc.clientID = 21
  doc.get('large').insert(0, 'x'.repeat(2_000_000))

  const source = new Y.Doc({ gc: false })
  source.clientID = 22
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const sourceUpdates = []
  source.on('update', update => sourceUpdates.push(update))
  source.get('pending').insert(0, 'a')
  source.get('pending').insert(1, 'b')
  Y.applyUpdate(doc, sourceUpdates[1])
  t.assert(doc.store.pendingStructs !== null)

  const currentState = Y.encodeStateVector(doc)
  const first = Y.encodeStateAsUpdate(doc, currentState)
  t.assert(first.byteLength < 256 && _testOnlyGetSparsePendingProofRuns(doc) === 1)
  for (let index = 0; index < 8; index++) {
    const update = index % 2 === 0
      ? Y.encodeStateAsUpdate(doc, currentState)
      : Y.encodeStateAsUpdateV2(doc, currentState)
    t.assert(update.byteLength < 256)
  }
  Y.encodeStateAsUpdateV2(doc)
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 1)

  doc.transact(() => {})
  Y.applyUpdate(doc, new Uint8Array([0, 0]))
  Y.applyUpdate(doc, sourceUpdates[1])
  Y.applyUpdateV2(doc, Y.convertUpdateFormatV1ToV2(sourceUpdates[1]))
  Y.encodeStateAsUpdate(doc, currentState)
  Y.encodeStateAsUpdateV2(doc, currentState)
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 1)

  const pending = /** @type {NonNullable<typeof doc.store.pendingStructs>} */ (doc.store.pendingStructs)
  pending.update[pending.update.byteLength - 1] ^= 1
  pending.missing.set(999, 0)
  t.assert(Y.encodeStateAsUpdate(doc, currentState).byteLength < 256)
  t.assert(Y.encodeStateAsUpdateV2(doc, currentState).byteLength < 256)
  t.fails(() => { doc.store.pendingStructs = pending })
  t.fails(() => { doc.store.pendingStructs = null })
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 1)

  const deletes = Y.createIdSet()
  deletes.add(88, 0, 1)
  Y.applyUpdateV2(doc, encodeDeleteSet(deletes, Y.UpdateEncoderV2))
  t.assert(doc.store.pendingDs !== null)
  Y.encodeStateAsUpdate(doc, currentState)
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 2)
  const pendingDelete = /** @type {Uint8Array<ArrayBuffer>} */ (doc.store.pendingDs)
  pendingDelete[pendingDelete.byteLength - 1] ^= 1
  Y.encodeStateAsUpdateV2(doc, currentState)
  t.fails(() => { doc.store.pendingDs = pendingDelete })
  t.fails(() => { doc.store.pendingDs = null })
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 2)

  doc.get('unrelated').insert(0, 'z')
  Y.encodeStateAsUpdateV2(doc, currentState)
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 2)

  doc.transact(() => {
    Y.encodeStateAsUpdate(doc, currentState)
    Y.encodeStateAsUpdateV2(doc, currentState)
  })
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 4)
  Y.encodeStateAsUpdate(doc, currentState)
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 4)

  doc.clientID = 22
  Y.applyUpdate(doc, sourceUpdates[0])
  t.assert(doc.store.pendingStructs === null && doc.get('pending').toString() === 'ab')
  Y.encodeStateAsUpdateV2(doc, currentState)
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 5)
}

export const testSparsePendingProofInvalidatesOnlyForDependencies = () => {
  const source = new Y.Doc({ gc: false })
  source.clientID = 70
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const updates = []
  source.on('updateV2', update => updates.push(update))
  source.get('text').insert(0, 'abcd')
  source.get('text').insert(4, 'e')

  const doc = new Y.Doc({ gc: false, sparseExactResolution: true })
  Y.applyUpdateV2(doc, updates[1])
  Y.encodeStateAsUpdateV2(doc)
  t.assert(doc.store.pendingStructs !== null && _testOnlyGetSparsePendingProofRuns(doc) === 1)
  const revision = getPendingRevision(doc.store)

  const unrelated = new Y.Doc({ gc: false })
  unrelated.clientID = 71
  unrelated.get('other').insert(0, 'x')
  Y.applyUpdateV2(doc, Y.encodeStateAsUpdateV2(unrelated))
  Y.encodeStateAsUpdateV2(doc)
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 1)

  Y.applyUpdateV2(doc, updates[0])
  Y.encodeStateAsUpdateV2(doc)
  t.assert(doc.store.pendingStructs === null && doc.get('text').toString() === 'abcde')
  t.assert(getPendingRevision(doc.store) > revision && _testOnlyGetSparsePendingProofRuns(doc) === 1)

  const deleteSource = new Y.Doc({ gc: false })
  deleteSource.clientID = 72
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const deleteUpdates = []
  deleteSource.on('updateV2', update => deleteUpdates.push(update))
  deleteSource.get('text').insert(0, 'a')
  deleteSource.get('text').delete(0, 1)

  const deleteDoc = new Y.Doc({ gc: false, sparseExactResolution: true })
  Y.applyUpdateV2(deleteDoc, deleteUpdates[1])
  Y.encodeStateAsUpdateV2(deleteDoc)
  t.assert(deleteDoc.store.pendingDs !== null && _testOnlyGetSparsePendingProofRuns(deleteDoc) === 1)
  const deleteRevision = getPendingRevision(deleteDoc.store)
  Y.applyUpdateV2(deleteDoc, Y.encodeStateAsUpdateV2(unrelated))
  Y.encodeStateAsUpdateV2(deleteDoc)
  t.assert(_testOnlyGetSparsePendingProofRuns(deleteDoc) === 1)
  Y.applyUpdateV2(deleteDoc, deleteUpdates[0])
  Y.encodeStateAsUpdateV2(deleteDoc)
  t.assert(deleteDoc.store.pendingDs === null && deleteDoc.get('text').toString() === '')
  t.assert(getPendingRevision(deleteDoc.store) > deleteRevision && _testOnlyGetSparsePendingProofRuns(deleteDoc) === 1)
}

export const testPendingStructsRetryForGcAndCausalHoleCoverage = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, event: 'update', apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, event: 'updateV2', apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, event, apply }) => {
    const source = new Y.Doc({ gc: false })
    source.clientID = 73
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const updates = []
    source.on(/** @type {'update'|'updateV2'} */ (event), update => updates.push(update))
    source.get('pending').insert(0, 'a')
    source.get('pending').insert(1, 'b')

    const item = new Y.Doc({ gc: false })
    apply(item, updates[1])
    t.assert(item.store.pendingStructs !== null)
    apply(item, updates[0])
    t.assert(item.store.pendingStructs === null && item.get('pending').toString() === 'ab')

    const ordinary = new Y.Doc({ gc: false })
    apply(ordinary, updates[1])
    t.assert(ordinary.store.pendingStructs !== null)
    apply(ordinary, encodeStructs([new Y.GC(Y.createID(73, 0), 1)], Encoder))
    t.assert(ordinary.store.pendingStructs === null)

    const sparse = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(sparse, updates[1])
    t.assert(sparse.store.pendingStructs !== null)
    apply(sparse, encodeCausalHoles([
      new CausalHole(Y.createID(73, 0), 1, null, null, 'pending', null)
    ], Encoder))
    t.assert(sparse.store.pendingStructs === null && sparse.get('pending').toString() === 'b')
  })
}

export const testSparsePendingReplayFailureIsAtomic = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, event: 'update', apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, event: 'updateV2', apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, event, apply, encode }) => {
    const target = new Y.Doc({ gc: false, sparseExactResolution: true })
    const dependent = encodeStructs([
      new Y.Item(
        Y.createID(2, 0),
        null,
        Y.createID(1, 0),
        null,
        Y.createID(1, 0),
        'text',
        null,
        new Y.ContentString('b')
      )
    ], Encoder)
    apply(target, dependent)
    const pendingDeleteSet = Y.createIdSet()
    pendingDeleteSet.add(9, 0, 1)
    apply(target, encodeDeleteSet(pendingDeleteSet, Encoder))
    const pending = /** @type {NonNullable<typeof target.store.pendingStructs>} */ (target.store.pendingStructs)
    const pendingDeletes = /** @type {Uint8Array<ArrayBuffer>} */ (target.store.pendingDs)
    const pendingBytes = Array.from(pending.update)
    const pendingDeleteBytes = Array.from(pendingDeletes)
    const pendingMissing = Array.from(pending.missing.entries())
    const state = Y.encodeStateVector(target)
    const snapshot = encode(target)
    let updateEvents = 0
    let transactions = 0
    target.on(/** @type {'update'|'updateV2'} */ (event), () => { updateEvents++ })
    target.on('afterTransaction', () => { transactions++ })

    const resolvingHole = encodeCausalHoles([
      new CausalHole(Y.createID(1, 0), 1, null, null, 'text', null)
    ], Encoder)
    t.fails(() => apply(target, resolvingHole))

    const retained = /** @type {NonNullable<typeof target.store.pendingStructs>} */ (target.store.pendingStructs)
    const retainedDeletes = /** @type {Uint8Array<ArrayBuffer>} */ (target.store.pendingDs)
    t.compareArrays(Array.from(retained.update), pendingBytes, `${Encoder.name} pending bytes`)
    t.compareArrays(Array.from(retainedDeletes), pendingDeleteBytes, `${Encoder.name} pending delete bytes`)
    t.assert(JSON.stringify(Array.from(retained.missing.entries())) === JSON.stringify(pendingMissing))
    t.compareArrays(Array.from(Y.encodeStateVector(target)), Array.from(state), `${Encoder.name} state vector`)
    t.compareArrays(Array.from(encode(target)), Array.from(snapshot), `${Encoder.name} snapshot`)
    t.assert(target.store.getStruct(Y.createID(1, 0)) === null)
    t.assert(target.store.causalHoles.isEmpty() && target.get('text').toString() === '')
    t.assert(updateEvents === 0 && transactions === 0, `${Encoder.name} emits no target events`)
  })
}

export const testSparseFailedCompositePlansCacheExactSemanticEnvelopes = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const target = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(target, encodeStructs([
      new Y.Item(Y.createID(3, 0), null, null, null, null, 'text', null, new Y.ContentString('c'))
    ], Encoder))
    apply(target, encodeStructs([
      new Y.Item(Y.createID(2, 0), null, Y.createID(1, 0), null, Y.createID(3, 0), null, null, new Y.ContentString('b'))
    ], Encoder))
    const badHole = new CausalHole(Y.createID(1, 0), 1, null, null, 'other', null)
    const bad = encodeCausalHoles([badHole], Encoder)
    t.fails(() => apply(target, bad))
    t.assert(_testOnlyGetSparseFailedPlanRuns(target) === 1)
    t.fails(() => apply(target, bad))
    t.assert(_testOnlyGetSparseFailedPlanRuns(target) === 1, `${Encoder.name} exact retry uses cache`)

    const noisyBad = encodeStructGroups([
      [new CausalHole(Y.createID(1, 0), 1, null, null, 'other', null)],
      [new Y.Item(Y.createID(9, 0), null, null, null, null, 'unrelated', null, new Y.ContentString('noise'))]
    ], Encoder)
    t.fails(() => apply(target, noisyBad))
    t.assert(_testOnlyGetSparseFailedPlanRuns(target) === 2, `${Encoder.name} distinct semantic envelope runs a fresh plan`)
    t.assert(target.store.getStruct(Y.createID(9, 0)) === null)

    const good = encodeCausalHoles([
      new CausalHole(Y.createID(1, 0), 1, null, null, 'text', null)
    ], Encoder)
    apply(target, good)
    t.assert(_testOnlyGetSparseFailedPlanRuns(target) === 3, `${Encoder.name} distinct resolver runs a fresh plan`)
    t.assert(target.store.pendingStructs === null && target.get('text').toString() === 'bc')
  })
}

export const testSparseFailedPlanDoesNotLatchSameResolverWithRelevantMaterial = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const target = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(target, encodeStructs([
      new Y.Item(Y.createID(2, 0), null, Y.createID(1, 0), null, null, null, null, new Y.ContentString('b'))
    ], Encoder))
    const resolver = new CausalHole(Y.createID(1, 0), 1, null, null, Y.createID(4, 0), null)
    t.fails(() => apply(target, encodeCausalHoles([resolver], Encoder)))
    t.assert(_testOnlyGetSparseFailedPlanRuns(target) === 1)

    const resolverWithParent = encodeStructGroups([
      [new CausalHole(Y.createID(1, 0), 1, null, null, Y.createID(4, 0), null)],
      [new Y.Item(Y.createID(4, 0), null, null, null, null, 'root', null, new Y.ContentType(new Y.Type()))]
    ], Encoder)
    apply(target, resolverWithParent)
    t.assert(_testOnlyGetSparseFailedPlanRuns(target) === 2)
    t.assert(target.store.pendingStructs === null && target.store.getStruct(Y.createID(4, 0))?.constructor === Y.Item)
  })
}

export const testSparseFailedPlanCacheInvalidatesForSeparateParentAndRootArrival = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const target = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(target, encodeStructs([
      new Y.Item(Y.createID(2, 0), null, Y.createID(1, 0), null, null, null, null, new Y.ContentString('b'))
    ], Encoder))
    const resolver = encodeCausalHoles([
      new CausalHole(Y.createID(1, 0), 1, null, null, Y.createID(4, 0), null)
    ], Encoder)
    t.fails(() => apply(target, resolver))
    t.fails(() => apply(target, resolver))
    t.assert(_testOnlyGetSparseFailedPlanRuns(target) === 1, `${Encoder.name} exact unchanged retry is cached`)

    apply(target, encodeStructs([
      new Y.Item(Y.createID(4, 0), null, null, null, null, 'root', null, new Y.ContentType(new Y.Type()))
    ], Encoder))
    apply(target, resolver)
    t.assert(_testOnlyGetSparseFailedPlanRuns(target) === 2, `${Encoder.name} separate parent arrival invalidates failure`)
    t.assert(target.store.pendingStructs === null && target.store.getStruct(Y.createID(1, 0))?.constructor === CausalHole)

    const conflicting = encodeCausalHoles([
      new CausalHole(Y.createID(8, 0), 1, null, null, 'wrong', null)
    ], Encoder)
    apply(target, encodeStructs([
      new Y.Item(Y.createID(10, 0), null, null, null, null, 'right', null, new Y.ContentString('r'))
    ], Encoder))
    apply(target, encodeStructs([
      new Y.Item(Y.createID(9, 0), null, Y.createID(8, 0), null, Y.createID(10, 0), null, null, new Y.ContentString('x'))
    ], Encoder))
    t.fails(() => apply(target, conflicting))
    const beforeRoot = _testOnlyGetSparseFailedPlanRuns(target)
    t.fails(() => apply(target, conflicting))
    t.assert(_testOnlyGetSparseFailedPlanRuns(target) === beforeRoot)
    target.get('cache-root')
    t.fails(() => apply(target, conflicting))
    t.assert(_testOnlyGetSparseFailedPlanRuns(target) === beforeRoot + 1, `${Encoder.name} root creation invalidates failure`)
  })
}

export const testSparseStructuralRevisionTracksOnlyAuthoritativeChanges = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const sparse = new Y.Doc({ gc: false, sparseExactResolution: true })
    const empty = Encoder === Y.UpdateEncoderV1
      ? Y.encodeStateAsUpdate(new Y.Doc())
      : Y.encodeStateAsUpdateV2(new Y.Doc())
    apply(sparse, empty)
    t.assert(getStructuralRevision(sparse.store) === 0, `${Encoder.name} empty update is structurally inert`)

    const unresolved = encodeStructs([
      new Y.Item(Y.createID(21, 0), null, Y.createID(20, 0), null, null, 'text', null, new Y.ContentString('x'))
    ], Encoder)
    apply(sparse, unresolved)
    t.assert(sparse.store.pendingStructs !== null && getStructuralRevision(sparse.store) === 0, `${Encoder.name} unresolved-only update is structurally inert`)

    const material = encodeStructs([
      new Y.Item(Y.createID(30, 2), null, null, null, null, 'text', null, new Y.ContentString('m'))
    ], Encoder)
    apply(sparse, material)
    const materialRevision = getStructuralRevision(sparse.store)
    t.assert(materialRevision >= 2, `${Encoder.name} generated Skip and material insert advance revision`)
    apply(sparse, material)
    t.assert(getStructuralRevision(sparse.store) === materialRevision, `${Encoder.name} duplicate-known update is structurally inert`)

    sparse.get('new-root')
    t.assert(getStructuralRevision(sparse.store) === materialRevision + 1, `${Encoder.name} root creation advances revision once`)

    const split = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(split, encodeStructs([
      new Y.Item(Y.createID(31, 0), null, null, null, null, 'text', null, new Y.ContentString('ab'))
    ], Encoder))
    const beforeSplit = getStructuralRevision(split.store)
    split.transact(transaction => { getItemCleanStart(transaction, Y.createID(31, 1)) })
    t.assert(getStructuralRevision(split.store) === beforeSplit + 1, `${Encoder.name} store split advances revision once`)
    const beforeDelete = getStructuralRevision(split.store)
    split.get('text').delete(0, 1)
    t.assert(getStructuralRevision(split.store) > beforeDelete, `${Encoder.name} authoritative delete advances revision`)

    const replacement = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(replacement, encodeCausalHoles([
      new CausalHole(Y.createID(32, 0), 1, null, null, 'text', null)
    ], Encoder))
    const beforeReplacement = getStructuralRevision(replacement.store)
    apply(replacement, encodeStructs([
      new Y.Item(Y.createID(32, 0), null, null, null, null, 'text', null, new Y.ContentString('r'))
    ], Encoder))
    t.assert(getStructuralRevision(replacement.store) > beforeReplacement, `${Encoder.name} sparse replacement advances revision`)
    t.assert(replacement.get('text').toString() === 'r' && replacement.store.causalHoles.isEmpty())

    const ordinary = new Y.Doc({ gc: false })
    ordinary.get('text').insert(0, 'x')
    t.assert(getStructuralRevision(ordinary.store) === 0, `${Encoder.name} ordinary stores have no revision state`)
  })
}

export const testSparseFailedPlanCacheIgnoresBulkContentSize = () => {
  const target = new Y.Doc({ gc: false, sparseExactResolution: true })
  Y.applyUpdateV2(target, encodeStructs([
    new Y.Item(Y.createID(3, 0), null, null, null, null, 'text', null, new Y.ContentString('c'))
  ], Y.UpdateEncoderV2))
  Y.applyUpdateV2(target, encodeStructs([
    new Y.Item(Y.createID(2, 0), null, Y.createID(1, 0), null, Y.createID(3, 0), null, null, new Y.ContentString('b'))
  ], Y.UpdateEncoderV2))

  ;[250_000, 1_000_000, 4_000_000, 16_000_000].forEach((size, index) => {
    const update = encodeStructGroups([
      [new CausalHole(Y.createID(1, 0), 1, null, null, 'other', null)],
      [new Y.Item(Y.createID(9, 0), null, null, null, null, 'bulk', null, new Y.ContentString('x'.repeat(size)))]
    ], Y.UpdateEncoderV2)
    t.fails(() => Y.applyUpdateV2(target, update))
    t.assert(_testOnlyGetSparseFailedPlanRuns(target) === index + 1)
    t.fails(() => Y.applyUpdateV2(target, update))
    t.assert(_testOnlyGetSparseFailedPlanRuns(target) === index + 1, `${size} byte exact semantic retry uses bounded plan cache`)
  })
}

export const testOrdinaryPendingRetryIgnoresSkipAndUnrelatedMissingClients = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, event: 'update', apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, event: 'updateV2', apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, event, apply, encode }) => {
    const source = new Y.Doc({ gc: false })
    source.clientID = 74
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const updates = []
    source.on(/** @type {'update'|'updateV2'} */ (event), update => updates.push(update))
    source.get('pending').insert(0, 'a')
    source.get('pending').insert(1, 'x'.repeat(2_000_000))

    const target = new Y.Doc({ gc: false })
    apply(target, updates[1])
    const pending = /** @type {NonNullable<typeof target.store.pendingStructs>} */ (target.store.pendingStructs)
    const pendingBytes = Array.from(pending.update)
    const pendingMissing = Array.from(pending.missing.entries())
    apply(target, encodeStructs([new Y.Skip(Y.createID(74, 0), 1)], Encoder))
    t.assert(target.store.pendingStructs === pending, `${Encoder.name} Skip retains pending identity`)
    t.compareArrays(Array.from(pending.update), pendingBytes, `${Encoder.name} Skip retains pending bytes`)
    t.assert(JSON.stringify(Array.from(pending.missing.entries())) === JSON.stringify(pendingMissing))

    const missing = new Map()
    for (let client = 1_000; client < 11_000; client++) missing.set(client, 0)
    let missingIterations = 0
    Object.defineProperty(missing, Symbol.iterator, {
      value: () => {
        missingIterations++
        return Map.prototype[Symbol.iterator].call(missing)
      }
    })
    const retained = { missing, update: Y.encodeStateAsUpdateV2(new Y.Doc()) }
    target.store.pendingStructs = retained
    const unrelated = new Y.Doc({ gc: false })
    unrelated.clientID = 20_000
    unrelated.get('other').insert(0, 'z')
    apply(target, encode(unrelated))
    t.assert(target.store.pendingStructs === retained && missingIterations === 1)
    t.assert(target.get('other').toString() === 'z')
  })
}

export const testOrdinaryPendingResyncNormalizesDeletedAndUndefinedFields = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, event: 'update', apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, event: 'updateV2', apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, event, apply }) => {
    const source = new Y.Doc({ gc: false })
    source.clientID = 74
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const updates = []
    source.on(/** @type {'update'|'updateV2'} */ (event), update => updates.push(update))
    source.get('pending').insert(0, 'a')
    source.get('pending').insert(1, 'b')

    const descriptor = Object.getOwnPropertyDescriptor(new Y.Doc().store, 'pendingStructs')
    const deleted = new Y.Doc({ gc: false })
    apply(deleted, updates[1])
    delete /** @type {{pendingStructs?:unknown}} */ (deleted.store).pendingStructs
    apply(deleted, encodeStructs([new Y.GC(Y.createID(74, 0), 1)], Encoder))
    const deletedDescriptor = Object.getOwnPropertyDescriptor(deleted.store, 'pendingStructs')
    t.assert(deleted.store.pendingStructs === null && JSON.stringify(deletedDescriptor) === JSON.stringify(descriptor), `${Encoder.name} deleted field normalizes to upstream own null`)

    const undefinedField = new Y.Doc({ gc: false })
    apply(undefinedField, updates[1])
    ;/** @type {{pendingStructs:unknown}} */ (undefinedField.store).pendingStructs = undefined
    apply(undefinedField, encodeStructs([new Y.GC(Y.createID(74, 0), 1)], Encoder))
    const undefinedDescriptor = Object.getOwnPropertyDescriptor(undefinedField.store, 'pendingStructs')
    t.assert(undefinedField.store.pendingStructs === null && JSON.stringify(undefinedDescriptor) === JSON.stringify(descriptor), `${Encoder.name} undefined field normalizes and clears retry marker`)
  })
}

export const testOrdinaryPendingRetryWaitsForNextRemoteEnvelopeAfterLocalMaterialization = () => {
  ;[
    { event: 'update', apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { event: 'updateV2', apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ event, apply, encode }) => {
    const source = new Y.Doc({ gc: false })
    source.clientID = 75
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const updates = []
    source.on(/** @type {'update'|'updateV2'} */ (event), update => updates.push(update))
    source.get('pending').insert(0, 'a')
    source.get('pending').insert(1, 'b')

    const target = new Y.Doc({ gc: false })
    apply(target, updates[1])
    target.clientID = 75
    target.get('pending').insert(0, 'a')
    t.assert(target.store.pendingStructs !== null && target.get('pending').toString() === 'a')

    const remote = new Y.Doc({ gc: false })
    remote.clientID = 76
    remote.get('other').insert(0, 'x')
    let events = 0
    target.on(/** @type {'update'|'updateV2'} */ (event), () => { events++ })
    apply(target, encode(remote))
    t.assert(target.store.pendingStructs === null)
    t.assert(target.get('pending').toString() === 'ab' && target.get('other').toString() === 'x')
    t.assert(events === 1, `${event} retry coalesces into the remote transaction`)
  })
}

export const testLargePendingTransportIgnoresEmptyTransactions = () => {
  const source = new Y.Doc({ gc: false })
  source.clientID = 24
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const updates = []
  source.on('update', update => updates.push(update))
  source.get('pending').insert(0, 'a')
  source.get('pending').insert(1, 'x'.repeat(2_000_000))

  const doc = new Y.Doc({ gc: false, sparseExactResolution: true })
  Y.applyUpdate(doc, updates[1])
  t.assert(doc.store.pendingStructs !== null && doc.store.pendingStructs.update.byteLength > 2_000_000)

  const targetState = Y.encodeStateVector(source)
  const first = Y.encodeStateAsUpdate(doc, targetState)
  t.assert(first.byteLength < 256 && _testOnlyGetSparsePendingProofRuns(doc) === 1)
  const pendingRevision = getPendingRevision(doc.store)

  for (let index = 0; index < 50; index++) {
    Y.applyUpdate(doc, new Uint8Array([0, 0]))
  }

  t.assert(getPendingRevision(doc.store) === pendingRevision)
  t.assert(Y.encodeStateAsUpdate(doc, targetState).byteLength < 256)
  t.assert(Y.encodeStateAsUpdateV2(doc, targetState).byteLength < 256)
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 1)
}

export const testDestroyedSparseDocumentsCannotReusePendingProofs = () => {
  const createPending = () => {
    const source = new Y.Doc({ gc: false })
    source.clientID = 31
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const updates = []
    source.on('update', update => updates.push(update))
    source.get('pending').insert(0, 'a')
    source.get('pending').insert(1, 'b')
    const doc = new Y.Doc({ gc: false, sparseExactResolution: true })
    Y.applyUpdate(doc, updates[1])
    return doc
  }

  const cached = createPending()
  Y.encodeStateAsUpdate(cached)
  t.assert(_testOnlyGetSparsePendingProofRuns(cached) === 1)
  cached.destroy()
  cached.isDestroyed = false
  cached.clientID = 31
  cached.get('pending').insert(0, 'a')
  t.fails(() => Y.encodeStateAsUpdate(cached))
  t.fails(() => Y.encodeStateAsUpdateV2(cached))
  t.fails(() => writeStateAsUpdate(new Y.UpdateEncoderV1(), cached))
  t.fails(() => writeStateAsUpdate(new Y.UpdateEncoderV2(), cached))
  t.assert(_testOnlyGetSparsePendingProofRuns(cached) === 1)

  const uncached = createPending()
  uncached.destroy()
  uncached.isDestroyed = false
  uncached.clientID = 31
  uncached.get('pending').insert(0, 'a')
  t.fails(() => Y.encodeStateAsUpdate(uncached))
  t.fails(() => Y.encodeStateAsUpdateV2(uncached))
  t.fails(() => writeStateAsUpdate(new Y.UpdateEncoderV1(), uncached))
  t.fails(() => writeStateAsUpdate(new Y.UpdateEncoderV2(), uncached))
  t.assert(_testOnlyGetSparsePendingProofRuns(uncached) === 0)

  const ordinary = new Y.Doc({ gc: false })
  ordinary.get('text').insert(0, 'ordinary')
  const before = Y.encodeStateAsUpdate(ordinary)
  ordinary.destroy()
  t.compareArrays(Array.from(Y.encodeStateAsUpdate(ordinary)), Array.from(before))
  const ordinaryV2 = Y.encodeStateAsUpdateV2(ordinary)
  const reload = new Y.Doc({ gc: false })
  Y.applyUpdateV2(reload, ordinaryV2)
  t.assert(reload.get('text').toString() === 'ordinary')
}

export const testSparseSubdocWirePreservesCapability = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, apply, encode }) => {
    const parent = new Y.Doc({ gc: false, sparseExactResolution: true })
    const child = new Y.Doc({ guid: `sparse-${Encoder.name}`, gc: false, sparseExactResolution: true })
    parent.get('docs').insert(0, [child])

    const reload = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(reload, encode(parent))
    const restored = /** @type {Y.Doc} */ (reload.get('docs').get(0))
    t.assert(restored.gc === false && restored.sparseExactResolution === true)
    t.assert(typeof Object.getOwnPropertyDescriptor(restored, 'gc')?.set === 'function')

    const baseline = createCausalHoleBase()
    apply(restored, encode(baseline))
    apply(restored, encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'text', null)
    ], Encoder))
    t.assert(restored.store.getCausalHole(Y.createID(2, 0)) !== null)
  })
}

export const testSparseMalformedOrdinaryItemsFailBeforeTransaction = () => {
  ;[
    {
      Encoder: Y.UpdateEncoderV1,
      apply: Y.applyUpdate,
      encode: Y.encodeStateAsUpdate,
      convert: (/** @type {Uint8Array<ArrayBuffer>} */ update) => update,
      event: 'update'
    },
    {
      Encoder: Y.UpdateEncoderV2,
      apply: Y.applyUpdateV2,
      encode: Y.encodeStateAsUpdateV2,
      convert: Y.convertUpdateFormatV1ToV2,
      event: 'updateV2'
    }
  ].forEach(({ Encoder, apply, encode, convert, event }) => {
    const source = new Y.Doc({ gc: false })
    source.clientID = 8
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const updates = []
    source.on('update', update => updates.push(update))
    source.get('text').insert(0, 'a')
    source.get('text').insert(1, 'b')
    const first = convert(updates[0])
    const second = convert(updates[1])

    const initial = new Y.Doc({ gc: false, sparseExactResolution: true })
    const unrelated = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(unrelated, encodeCausalHoles([
      new CausalHole(Y.createID(9, 0), 1, null, null, 'unrelated', null)
    ], Encoder))
    const matching = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(matching, first)

    ;[
      { target: initial, update: first, label: 'initial' },
      { target: unrelated, update: first, label: 'unrelated' },
      { target: matching, update: second, label: 'matching source' }
    ].forEach(({ target, update, label }) => {
      const truncated = update.subarray(0, update.byteLength - 1)
      const before = encode(target)
      const state = Y.encodeStateVector(target)
      const clients = target.store.clients.size
      const pendingStructs = target.store.pendingStructs
      const pendingDs = target.store.pendingDs
      let updatesSeen = 0
      let transactions = 0
      target.on(/** @type {'update'|'updateV2'} */ (event), () => { updatesSeen++ })
      target.on('afterTransaction', () => { transactions++ })
      t.fails(() => apply(target, truncated))
      t.compareArrays(Array.from(encode(target)), Array.from(before), `${Encoder.name} ${label} bytes`)
      t.compareArrays(Array.from(Y.encodeStateVector(target)), Array.from(state), `${Encoder.name} ${label} state vector`)
      t.assert(target.store.clients.size === clients, `${Encoder.name} ${label} clients`)
      t.assert(target.store.pendingStructs === pendingStructs && target.store.pendingDs === pendingDs)
      t.assert(updatesSeen === 0 && transactions === 0, `${Encoder.name} ${label} emits no events`)
    })
  })
}

export const testUnsupportedSparseWireRefsRejectBeforeMutation = () => {
  ;[
    {
      Encoder: Y.UpdateEncoderV1,
      apply: Y.applyUpdate,
      decode: Y.decodeUpdate,
      merge: Y.mergeUpdates,
      convert: Y.convertUpdateFormatV1ToV2,
      encode: Y.encodeStateAsUpdate,
      event: 'update'
    },
    {
      Encoder: Y.UpdateEncoderV2,
      apply: Y.applyUpdateV2,
      decode: Y.decodeUpdateV2,
      merge: Y.mergeUpdatesV2,
      convert: Y.convertUpdateFormatV2ToV1,
      encode: Y.encodeStateAsUpdateV2,
      event: 'updateV2'
    }
  ].forEach(({ Encoder, apply, decode, merge, convert, encode, event }) => {
    ;[12, 13].forEach(ref => {
      const update = encodeUnsupportedSparseRef(/** @type {12|13} */ (ref), Encoder)
      t.fails(() => decode(update))
      t.fails(() => convert(update))
      t.fails(() => merge([update]))

      ;[
        new Y.Doc({ gc: false }),
        new Y.Doc({ gc: false, sparseExactResolution: true })
      ].forEach(doc => {
        const before = encode(doc)
        const state = Y.encodeStateVector(doc)
        let events = 0
        doc.on(/** @type {'update'|'updateV2'} */ (event), () => { events++ })
        t.fails(() => apply(doc, update))
        t.compareArrays(Array.from(encode(doc)), Array.from(before))
        t.compareArrays(Array.from(Y.encodeStateVector(doc)), Array.from(state))
        t.assert(events === 0 && doc.store.clients.size === 0)
        t.assert(doc.store.pendingStructs === null && doc.store.pendingDs === null)
      })
    })
  })
}

export const testCausalHoleMergePermutationsRejectBeforeFold = () => {
  /**
   * @param {Array<Uint8Array<ArrayBuffer>>} values
   * @return {Array<Array<Uint8Array<ArrayBuffer>>>}
   */
  const permutations = values => values.flatMap((value, index) => {
    if (values.length === 1) return [[value]]
    return permutations(values.slice(0, index).concat(values.slice(index + 1))).map(rest => [value, ...rest])
  })

  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, merge: Y.mergeUpdates, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, merge: Y.mergeUpdatesV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, apply, merge, encode }) => {
    const item = encodeStructs([
      new Y.Item(Y.createID(2, 0), null, null, null, null, 'text', null, new Y.ContentString('X'))
    ], Encoder)
    const hole = encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 1, null, null, 'text', null)
    ], Encoder)
    const gc = encodeStructs([new Y.GC(Y.createID(2, 0), 1)], Encoder)

    const disabled = new Y.Doc({ gc: false })
    const disabledBefore = encode(disabled)
    let disabledEvents = 0
    disabled.on('update', () => { disabledEvents++ })
    disabled.on('updateV2', () => { disabledEvents++ })
    t.fails(() => apply(disabled, hole))
    t.compareArrays(Array.from(encode(disabled)), Array.from(disabledBefore))
    t.assert(disabledEvents === 0 && disabled.store.clients.size === 0)

    permutations([item, hole, gc]).forEach(parts => t.fails(() => merge(parts)))
    t.fails(() => merge([hole]))
    t.fails(() => merge([item, hole]))
    t.fails(() => merge([hole, item]))
    const ordinaryFold = merge([item, gc])
    t.fails(() => merge([ordinaryFold, hole]))
    t.fails(() => merge([hole, ordinaryFold]))

    const holeFirst = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(holeFirst, hole)
    apply(holeFirst, item)
    const itemFirst = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(itemFirst, item)
    apply(itemFirst, hole)
    ;[holeFirst, itemFirst].forEach(doc => {
      t.assert(doc.get('text').toString() === 'X')
      t.assert(doc.store.getStruct(Y.createID(2, 0))?.constructor === Y.Item)
      t.assert(doc.store.causalHoles.isEmpty())
      const before = encode(doc)
      let events = 0
      doc.on('update', () => { events++ })
      doc.on('updateV2', () => { events++ })
      t.fails(() => apply(doc, gc))
      t.compareArrays(Array.from(encode(doc)), Array.from(before))
      t.assert(events === 0)
    })
    t.compareArrays(Array.from(encode(holeFirst)), Array.from(encode(itemFirst)))
  })
}

export const testCausalHoleParentDeletionRetainsSourceSemantics = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, decode: Y.decodeUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, decode: Y.decodeUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply, decode, encode, event }) => {
    const doc = new Y.Doc({ gc: false, sparseExactResolution: true })
    const parent = encodeStructs([
      new Y.Item(Y.createID(1, 0), null, null, null, null, 'root', null, new Y.ContentType(new Y.Type()))
    ], Encoder)
    const hole = encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 1, null, null, Y.createID(1, 0), null)
    ], Encoder)
    const source = encodeStructs([
      new Y.Item(Y.createID(2, 0), null, null, null, null, Y.createID(1, 0), null, new Y.ContentString('x'))
    ], Encoder)
    apply(doc, parent)
    apply(doc, hole)

    const deletion = Y.createIdSet()
    deletion.add(1, 0, 1)
    /** @type {Uint8Array<ArrayBuffer>|null} */
    let deletionEvent = null
    doc.on(/** @type {'update'|'updateV2'} */ (event), update => { deletionEvent = update })
    apply(doc, encodeDeleteSet(deletion, Encoder))
    const retainedParent = doc.store.getStruct(Y.createID(1, 0))
    t.assert(retainedParent?.constructor === Y.Item && retainedParent.deleted)
    t.assert(doc.store.getStruct(Y.createID(2, 0))?.constructor === CausalHole)
    t.assert(!decode(/** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (deletionEvent))).structs.some(struct => struct.constructor === CausalHole))

    /** @type {Y.Transaction|null} */
    let sourceTransaction = null
    doc.on('afterTransaction', transaction => { sourceTransaction = transaction })
    apply(doc, source)
    const materialized = doc.store.getStruct(Y.createID(2, 0))
    t.assert(materialized?.constructor === Y.Item && materialized.deleted)
    t.assert(doc.store.causalHoles.isEmpty())
    const transaction = /** @type {Y.Transaction} */ (/** @type {unknown} */ (sourceTransaction))
    t.assert(transaction.insertSet.has(2, 0) && transaction.deleteSet.has(2, 0))

    const reloaded = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(reloaded, encode(doc))
    const reloadedSource = reloaded.store.getStruct(Y.createID(2, 0))
    t.assert(reloadedSource?.constructor === Y.Item && reloadedSource.deleted)
    t.assert(reloaded.store.causalHoles.isEmpty())
  })
}

export const testCausalHoleFormatConversion = () => {
  const canonical = new CausalHole(Y.createID(2, 0), 2, Y.createID(1, 0), null, 'text', null)
  const v1 = encodeCausalHoles([canonical], Y.UpdateEncoderV1)
  const v2 = Y.convertUpdateFormatV1ToV2(v1)
  const roundtrip = Y.convertUpdateFormatV2ToV1(v2)
  ;[
    { update: v1, decode: Y.decodeUpdate, apply: Y.applyUpdate, state: Y.encodeStateVectorFromUpdate },
    { update: v2, decode: Y.decodeUpdateV2, apply: Y.applyUpdateV2, state: Y.encodeStateVectorFromUpdateV2 },
    { update: roundtrip, decode: Y.decodeUpdate, apply: Y.applyUpdate, state: Y.encodeStateVectorFromUpdate }
  ].forEach(({ update, decode, apply, state }) => {
    const decoded = /** @type {CausalHole} */ (decode(update).structs[0])
    t.assert(decoded.constructor === CausalHole && sameCausalHoleMetadata(decoded, canonical))
    const ids = update === v2 ? Y.createContentIdsFromUpdateV2(update) : Y.createContentIdsFromUpdate(update)
    t.assert(ids.inserts.isEmpty() && ids.deletes.isEmpty(), 'causal holes are absent from content ids')
    t.assert((Y.decodeStateVector(state(update)).get(2) ?? 0) === 0, 'causal holes are absent from contiguous state')
    const doc = createCausalHoleBase()
    let updates = 0
    doc.on(update === v2 ? 'updateV2' : 'update', () => { updates++ })
    apply(doc, update)
    t.assert(doc.get('text').toString() === 'a')
    t.assert(doc.store.causalHoles.has(2, 0) && doc.store.causalHoles.has(2, 1))
    t.assert(Y.createInsertSetFromStructStore(doc.store, false).clients.size === 1, 'causal holes do not add semantic inserts')
    t.assert(updates === 1, 'causal-hole-only integration emits transport coverage')
  })
}

export const testCausalHoleTransportOnlyUpdateRoundtrip = () => {
  ;[
    {
      Encoder: Y.UpdateEncoderV1,
      apply: Y.applyUpdate,
      encode: Y.encodeStateAsUpdate,
      decode: Y.decodeUpdate
    },
    {
      Encoder: Y.UpdateEncoderV2,
      apply: Y.applyUpdateV2,
      encode: Y.encodeStateAsUpdateV2,
      decode: Y.decodeUpdateV2
    }
  ].forEach(({ Encoder, apply, encode }) => {
    const doc = createCausalHoleBase()
    const prior = encode(doc)
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const updatesV1 = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const updatesV2 = []
    /** @type {Y.Transaction|null} */
    let transaction = null
    let semanticEvents = 0
    doc.get('text').observe(() => { semanticEvents++ })
    doc.on('afterTransaction', tr => { transaction = tr })
    doc.on('beforeObserverCalls', tr => { tr.meta.clear() })
    doc.on('update', update => updatesV1.push(update))
    doc.on('updateV2', update => updatesV2.push(update))

    apply(doc, encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 2, Y.createID(1, 0), null, 'text', null)
    ], Encoder))

    t.assert(updatesV1.length === 1 && updatesV2.length === 1 && semanticEvents === 0, `${Encoder.name} emits both transports after meta.clear`)
    t.assert(
      transaction !== null &&
      /** @type {Y.Transaction} */ (transaction).insertSet.isEmpty() &&
      /** @type {Y.Transaction} */ (transaction).deleteSet.isEmpty(),
      `${Encoder.name} transaction sets stay semantic`
    )
    ;[
      { update: updatesV1[0], decode: Y.decodeUpdate, contentIds: Y.createContentIdsFromUpdate, replayApply: Y.applyUpdate },
      { update: updatesV2[0], decode: Y.decodeUpdateV2, contentIds: Y.createContentIdsFromUpdateV2, replayApply: Y.applyUpdateV2 }
    ].forEach(({ update, decode, contentIds, replayApply }) => {
      const ids = contentIds(update)
      t.assert(ids.inserts.isEmpty() && ids.deletes.isEmpty(), `${Encoder.name} transport update has no semantic ids`)
      t.assert(decode(update).structs.some(struct => struct.constructor === CausalHole), `${Encoder.name} emitted update carries the hole`)
      const replay = new Y.Doc({ gc: false, sparseExactResolution: true })
      apply(replay, prior)
      replayApply(replay, update)
      const replayHole = replay.store.getCausalHole(Y.createID(2, 0))
      t.assert(replay.get('text').toString() === doc.get('text').toString())
      t.assert(replayHole !== null && replayHole.length === 2, `${Encoder.name} prior plus emitted update reconstructs post-state`)
    })
  })
}

export const testCausalHoleSnapshotsFailClosed = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const doc = createCausalHoleBase()
    const denseSnapshot = Y.snapshot(doc)
    apply(doc, encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 2, Y.createID(1, 0), null, 'text', null)
    ], Encoder))
    const state = Y.decodeStateVector(Y.encodeStateVector(doc))
    t.assert((state.get(2) ?? 0) === 0, `${Encoder.name} scalar state stops before the hole`)
    t.fails(() => Y.snapshot(doc))

    const restored = new Y.Doc({ gc: false, sparseExactResolution: true })
    t.fails(() => Y.createDocFromSnapshot(doc, denseSnapshot, restored))
    t.assert(restored.store.clients.size === 0 && restored.share.size === 0, `${Encoder.name} sparse restore fails before writes`)
  })
}

export const testCausalHoleForgedEnvelopesFailAtomically = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply, event }) => {
    /**
     * @param {Y.Doc} doc
     * @param {Uint8Array<ArrayBuffer>} update
     */
    const expectFailure = (doc, update) => {
      const text = doc.get('text').toString()
      const clients = new Map(doc.store.clients)
      const holes = doc.store.causalHoles.clients.size
      let updateCount = 0
      doc.on(/** @type {'update'|'updateV2'} */ (event), () => { updateCount++ })
      t.fails(() => apply(doc, update))
      t.assert(doc.get('text').toString() === text)
      t.assert(doc.store.clients.size === clients.size && [...clients].every(([client, structs]) => doc.store.clients.get(client) === structs))
      t.assert(doc.store.causalHoles.clients.size === holes)
      t.assert(doc.store.pendingStructs === null && doc.store.pendingDs === null)
      t.assert(updateCount === 0)
    }

    const missingAnchor = new CausalHole(Y.createID(2, 1), 1, Y.createID(2, 0), null, 'text', null)
    expectFailure(new Y.Doc({ gc: false }), encodeCausalHoles([missingAnchor], Encoder))

    const cycle = new CausalHole(Y.createID(2, 0), 1, Y.createID(2, 0), null, 'text', null)
    expectFailure(new Y.Doc({ gc: false }), encodeCausalHoles([cycle], Encoder))

    const missingParent = new CausalHole(Y.createID(2, 0), 1, null, null, Y.createID(9, 0), null)
    expectFailure(new Y.Doc({ gc: false }), encodeCausalHoles([missingParent], Encoder))

    const conflicted = createCausalHoleBase()
    const canonical = new CausalHole(Y.createID(2, 0), 2, Y.createID(1, 0), null, 'text', null)
    apply(conflicted, encodeCausalHoles([canonical], Encoder))
    const before = conflicted.store.getCausalHole(Y.createID(2, 0))
    const overlap = new CausalHole(Y.createID(2, 1), 1, Y.createID(1, 0), null, 'text', null)
    expectFailure(conflicted, encodeCausalHoles([overlap], Encoder))
    const after = conflicted.store.getCausalHole(Y.createID(2, 0))
    t.assert(before !== null && after !== null && sameCausalHoleMetadata(before, after))

    const truncatedBase = createCausalHoleBase()
    const valid = encodeCausalHoles([new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'text', null)], Encoder)
    expectFailure(truncatedBase, valid.slice(0, valid.length - 1))
  })
}

export const testCausalHoleParentMetadataValidation = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply, event }) => {
    /**
     * @param {Y.Doc} doc
     * @param {Uint8Array<ArrayBuffer>} update
     */
    const expectFailure = (doc, update) => {
      const before = Y.encodeStateAsUpdate(doc)
      let updates = 0
      doc.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
      t.fails(() => apply(doc, update))
      t.compareArrays(Array.from(Y.encodeStateAsUpdate(doc)), Array.from(before))
      t.assert(updates === 0)
      t.assert(doc.store.pendingStructs === null && doc.store.pendingDs === null)
    }

    const scalarParent = new Y.Doc({ gc: false })
    scalarParent.clientID = 1
    scalarParent.get('text').insert(0, 'a')
    expectFailure(
      scalarParent,
      encodeCausalHoles([new CausalHole(Y.createID(2, 0), 1, null, null, Y.createID(1, 0), null)], Encoder)
    )

    const crossRoot = new Y.Doc({ gc: false })
    crossRoot.clientID = 1
    crossRoot.get('left').insert(0, 'a')
    crossRoot.get('right').insert(0, 'b')
    expectFailure(
      crossRoot,
      encodeCausalHoles([new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 1), null, 'left', null)], Encoder)
    )

    const crossMap = new Y.Doc({ gc: false })
    crossMap.clientID = 1
    crossMap.get('map').setAttr('actual', 'value')
    expectFailure(
      crossMap,
      encodeCausalHoles([new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'map', 'forged')], Encoder)
    )

    const consumer = new Y.Doc({ gc: false, sparseExactResolution: true })
    consumer.clientID = 1
    consumer.get('left').insert(0, 'a')
    consumer.get('right').insert(0, 'b')
    apply(consumer, encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'left', null)
    ], Encoder))
    expectFailure(
      consumer,
      encodeStructs([
        new Y.Item(
          Y.createID(3, 0),
          null,
          Y.createID(2, 0),
          null,
          Y.createID(1, 1),
          null,
          null,
          new Y.ContentString('x')
        )
      ], Encoder)
    )
  })
}

export const testCausalHoleReplacementMetadataFailsWholeUpdateAtomically = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, merge: Y.mergeUpdates, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, merge: Y.mergeUpdatesV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply, merge, event }) => {
    const target = createCausalHoleBase()
    apply(target, encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 2, Y.createID(1, 0), null, 'text', null)
    ], Encoder))
    const forged = encodeStructs([
      new Y.Item(
        Y.createID(2, 0),
        null,
        Y.createID(1, 0),
        null,
        Y.createID(1, 0),
        null,
        null,
        new Y.ContentString('XY')
      )
    ], Encoder)
    const unrelated = encodeStructs([
      new Y.Item(Y.createID(9, 0), null, null, null, null, 'other', null, new Y.ContentString('committed-first-before-preflight'))
    ], Encoder)
    const bundled = merge([forged, unrelated])
    const before = Y.encodeStateAsUpdate(target)
    const clients = new Map(target.store.clients)
    let updates = 0
    target.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })

    t.fails(() => apply(target, bundled))
    t.compareArrays(Array.from(Y.encodeStateAsUpdate(target)), Array.from(before))
    t.assert([...clients].every(([client, structs]) => target.store.clients.get(client) === structs))
    t.assert(!target.store.clients.has(9), `${Encoder.name} unrelated client is not partially committed`)
    t.assert(target.store.pendingStructs === null && target.store.pendingDs === null && updates === 0)

    const honest = encodeStructs([
      new Y.Item(Y.createID(2, 0), null, Y.createID(1, 0), null, null, null, null, new Y.ContentString('XY'))
    ], Encoder)
    apply(target, honest)
    t.assert(target.get('text').toString() === 'aXY' && target.store.causalHoles.isEmpty())
  })
}

export const testCausalHoleContextAwareCompactionAndReplay = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, merge: Y.mergeUpdates, decode: Y.decodeUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, merge: Y.mergeUpdatesV2, decode: Y.decodeUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply, merge, decode, encode, event }) => {
    const first = encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'text', null)
    ], Encoder)
    const second = encodeCausalHoles([
      new CausalHole(Y.createID(2, 1), 1, Y.createID(2, 0), null, 'text', null)
    ], Encoder)
    const unrelated = encodeStructs([
      new Y.Item(Y.createID(9, 0), null, null, null, null, 'other', null, new Y.ContentString('u'))
    ], Encoder)
    t.fails(() => merge([first, second, unrelated]))
    t.fails(() => merge([unrelated, second, first]))

    const target = createCausalHoleBase()
    apply(target, first)
    let updates = 0
    target.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
    apply(target, second)
    apply(target, unrelated)
    t.assert(target.store.causalHoles.has(2, 0) && target.store.causalHoles.has(2, 1))
    t.assert(target.store.pendingStructs === null && target.store.pendingDs === null)
    t.assert(target.get('other').toString() === 'u' && updates === 2)

    const compacted = encode(target)
    const compactedHoles = decode(compacted).structs.filter(struct => struct.constructor === CausalHole)
    t.assert(compactedHoles.some(hole => hole.id.client === 2 && hole.id.clock === 0))
    t.assert(compactedHoles.some(hole => hole.id.client === 2 && hole.id.clock <= 1 && hole.id.clock + hole.length > 1))
    const replay = createCausalHoleBase()
    apply(replay, compacted)
    t.assert(replay.store.causalHoles.has(2, 0) && replay.store.causalHoles.has(2, 1))
    t.assert(replay.get('other').toString() === 'u')
  })
}

export const testCausalHoleTransitivePeerGeometry = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, apply, encode }) => {
    const x = new Y.Item(Y.createID(2, 0), null, Y.createID(1, 0), null, null, null, null, new Y.ContentString('X'))
    const p = new Y.Item(Y.createID(3, 0), null, null, null, null, 'text', null, new Y.ContentString('P'))
    const s = new Y.Item(Y.createID(4, 0), null, Y.createID(2, 0), null, null, null, null, new Y.ContentString('S'))
    const source = encodeStructs([x], Encoder)

    const canonical = createCausalHoleBase()
    apply(canonical, encodeStructGroups([[x], [p], [s]], Encoder))
    t.assert(canonical.get('text').toString() === 'aXSP')

    const sparse = createCausalHoleBase()
    apply(sparse, encodeStructGroups([
      [new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'text', null)],
      [p],
      [s]
    ], Encoder))
    t.assert(sparse.get('text').toString() === 'aSP', `${Encoder.name} transitive peers use virtual bounds`)
    apply(sparse, source)
    t.assert(sparse.get('text').toString() === 'aXSP' && sparse.store.causalHoles.isEmpty())
    t.assert(sparse.store.pendingStructs === null && sparse.store.pendingDs === null)

    const canonicalSnapshot = encode(canonical)
    const sparseSnapshot = encode(sparse)
    apply(canonical, sparseSnapshot)
    apply(sparse, canonicalSnapshot)
    t.assert(canonical.get('text').toString() === 'aXSP' && sparse.get('text').toString() === 'aXSP')
  })
}

export const testCausalHoleMalformedRightBoundFailsPrewrite = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply, encode, event }) => {
    const target = new Y.Doc({ gc: false })
    target.clientID = 1
    target.get('text').insert(0, 'ab')
    const reversed = new CausalHole(
      Y.createID(2, 0), 1, Y.createID(1, 1), Y.createID(1, 0), 'text', null
    )
    const consumer = new Y.Item(
      Y.createID(3, 0), null, Y.createID(2, 0), null, null, null, null, new Y.ContentString('x')
    )
    const unrelated = new Y.Item(
      Y.createID(9, 0), null, null, null, null, 'other', null, new Y.ContentString('must-not-commit')
    )
    const malformed = encodeStructGroups([[reversed], [consumer], [unrelated]], Encoder)
    const before = encode(target)
    const clients = new Map(target.store.clients)
    let updates = 0
    target.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })

    t.fails(() => apply(target, malformed))
    t.compareArrays(Array.from(encode(target)), Array.from(before))
    t.assert([...clients].every(([client, structs]) => target.store.clients.get(client) === structs))
    t.assert(!target.store.clients.has(2) && !target.store.clients.has(3) && !target.store.clients.has(9))
    t.assert(target.store.pendingStructs === null && target.store.pendingDs === null && updates === 0, `${Encoder.name} malformed geometry is zero-write`)
  })
}

export const testCausalHoleSameClientCanonicalOrdering = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, apply, encode }) => {
    const sourceItem = new Y.Item(
      Y.createID(2, 0), null, Y.createID(1, 0), null, null, null, null, new Y.ContentString('H')
    )
    const peers = [
      new Y.Item(Y.createID(3, 0), null, Y.createID(2, 0), null, null, null, null, new Y.ContentString('x')),
      new Y.Item(Y.createID(3, 1), null, Y.createID(2, 0), null, null, null, null, new Y.ContentString('y'))
    ]
    const source = encodeStructs([sourceItem], Encoder)
    const canonical = createCausalHoleBase()
    apply(canonical, encodeStructGroups([[sourceItem], peers], Encoder))
    t.assert(canonical.get('text').toString() === 'aHyx')

    const sparse = createCausalHoleBase()
    apply(sparse, encodeStructGroups([
      [new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'text', null)],
      peers
    ], Encoder))
    t.assert(sparse.get('text').toString() === 'ayx', `${Encoder.name} shadow preserves ascending client stream`)
    apply(sparse, source)
    t.assert(sparse.get('text').toString() === 'aHyx' && sparse.store.causalHoles.isEmpty())
    t.assert(sparse.store.pendingStructs === null && sparse.store.pendingDs === null)

    const canonicalSnapshot = encode(canonical)
    const sparseSnapshot = encode(sparse)
    apply(canonical, sparseSnapshot)
    apply(sparse, canonicalSnapshot)
    t.assert(canonical.get('text').toString() === 'aHyx' && sparse.get('text').toString() === 'aHyx')
  })
}

export const testCausalHoleForgedDuplicateParentFailsAtomically = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply, encode, event }) => {
    const forgedParent = new Y.Item(
      Y.createID(1, 0), null, null, null, null, 'fake', null, new Y.ContentType(new Y.Type())
    )
    const hole = new CausalHole(Y.createID(2, 0), 1, null, null, Y.createID(1, 0), null)
    const bundled = encodeStructGroups([[forgedParent], [hole]], Encoder)
    const target = createCausalHoleBase()
    const before = encode(target)
    const clients = new Map(target.store.clients)
    let updates = 0
    target.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })

    t.fails(() => apply(target, bundled))
    t.compareArrays(Array.from(encode(target)), Array.from(before))
    t.assert([...clients].every(([client, structs]) => target.store.clients.get(client) === structs))
    t.assert(!target.store.causalHoles.has(2, 0) && !target.store.clients.has(2))
    t.assert(target.store.pendingStructs === null && target.store.pendingDs === null && updates === 0)

    const replay = new Y.Doc({ gc: false })
    apply(replay, encode(target))
    t.assert(replay.get('text').toString() === 'a' && replay.store.causalHoles.isEmpty())
  })
}

export const testSparseEnabledDocumentRejectsPlainGcAtomically = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply, encode, event }) => {
    const update = encodeStructs([new Y.GC(Y.createID(4, 0), 2)], Encoder)
    const sparse = new Y.Doc({ gc: false, sparseExactResolution: true })
    const before = encode(sparse)
    const beforeState = Y.encodeStateVector(sparse)
    let events = 0
    sparse.on(/** @type {'update'|'updateV2'} */ (event), () => { events++ })
    t.fails(() => apply(sparse, update))
    t.compareArrays(Array.from(encode(sparse)), Array.from(before))
    t.compareArrays(Array.from(Y.encodeStateVector(sparse)), Array.from(beforeState))
    t.assert(events === 0 && sparse.store.clients.size === 0)
    t.assert(sparse.store.pendingStructs === null && sparse.store.pendingDs === null)

    const ordinary = new Y.Doc({ gc: false })
    apply(ordinary, update)
    t.assert(ordinary.store.getStruct(Y.createID(4, 0))?.constructor === Y.GC)
  })
}

export const testCausalHoleTransportRotatesDuplicateClientBeforeLocalAllocation = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, decode: Y.decodeUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, decode: Y.decodeUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply, decode, event }) => {
    const live = new Y.Doc({ gc: false, sparseExactResolution: true })
    live.clientID = 2
    apply(live, encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 1, null, null, 'text', null)
    ], Encoder))
    const liveClient = live.clientID
    t.assert(liveClient !== 2, `${Encoder.name} live sparse transport rotates a duplicate client`)
    /** @type {Uint8Array<ArrayBuffer>|null} */
    let liveLocalEvent = null
    live.on(/** @type {'update'|'updateV2'} */ (event), update => { liveLocalEvent = update })
    live.get('text').insert(0, 'L')
    const liveLocalStruct = decode(/** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (liveLocalEvent))).structs.find(struct => struct.constructor === Y.Item)
    t.assert(liveLocalStruct?.id.client === liveClient, `${Encoder.name} next local allocation uses rotated client`)
    apply(live, encodeStructs([
      new Y.Item(Y.createID(2, 0), null, null, null, null, 'text', null, new Y.ContentString('X'))
    ], Encoder))
    t.assert(live.store.getStruct(Y.createID(2, 0))?.constructor === Y.Item)
    t.assert(live.get('text').toString().includes('L') && live.get('text').toString().includes('X'))
    t.assert(live.store.causalHoles.isEmpty() && live.store.pendingStructs === null && live.store.pendingDs === null)
  })
}

export const testCausalHoleStructuralParentDominanceAndDependency = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply }) => {
    const target = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(target, encodeCausalHoles([
      new CausalHole(Y.createID(1, 0), 1, null, null, 'root', null)
    ], Encoder))
    const parent = new Y.Item(
      Y.createID(1, 0), null, null, null, null, 'root', null, new Y.ContentType(new Y.Type())
    )
    const child = new Y.Item(
      Y.createID(2, 0), null, null, null, null, Y.createID(1, 0), null, new Y.ContentString('x')
    )
    apply(target, encodeStructGroups([[parent], [child]], Encoder))

    const storedParent = target.store.getStruct(Y.createID(1, 0))
    const storedChild = target.store.getStruct(Y.createID(2, 0))
    if (storedParent?.constructor !== Y.Item || !(storedParent.content instanceof Y.ContentType)) throw new Error('Missing materialized parent')
    t.assert(storedChild?.constructor === Y.Item && storedChild.parent === storedParent.content.type, `${Encoder.name} replacement integrates before its child`)
    t.assert(storedParent.content.type.length === 1 && target.store.causalHoles.isEmpty())
    t.assert(target.store.pendingStructs === null && target.store.pendingDs === null)
  })
}

export const testCausalHoleExplicitStoredParentRequiresBundledType = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, merge: Y.mergeUpdates },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, merge: Y.mergeUpdatesV2 }
  ].forEach(({ Encoder, apply, encode, merge }) => {
    const createTarget = () => {
      const target = new Y.Doc({ gc: false, sparseExactResolution: true })
      apply(target, encodeCausalHoles([
        new CausalHole(Y.createID(1, 0), 1, null, null, 'root', null)
      ], Encoder))
      return target
    }
    const parent = encodeStructs([
      new Y.Item(Y.createID(1, 0), null, null, null, null, 'root', null, new Y.ContentType(new Y.Type()))
    ], Encoder)
    const child = encodeStructs([
      new Y.Item(Y.createID(2, 0), null, null, null, null, Y.createID(1, 0), null, new Y.ContentString('x'))
    ], Encoder)

    const standalone = createTarget()
    const before = encode(standalone)
    t.fails(() => apply(standalone, child))
    t.compareArrays(Array.from(encode(standalone)), Array.from(before))
    t.assert(standalone.store.getStruct(Y.createID(1, 0))?.constructor === CausalHole)
    t.assert(standalone.store.getStruct(Y.createID(2, 0)) === null)

    ;[
      encodeStructGroups([
        [new Y.Item(Y.createID(1, 0), null, null, null, null, 'root', null, new Y.ContentType(new Y.Type()))],
        [new Y.Item(Y.createID(2, 0), null, null, null, null, Y.createID(1, 0), null, new Y.ContentString('x'))]
      ], Encoder),
      merge([parent, child]),
      merge([child, parent])
    ].forEach(update => {
      const bundled = createTarget()
      apply(bundled, update)
      const storedParent = bundled.store.getStruct(Y.createID(1, 0))
      const storedChild = bundled.store.getStruct(Y.createID(2, 0))
      t.assert(storedParent?.constructor === Y.Item && storedParent.content instanceof Y.ContentType)
      t.assert(storedChild?.constructor === Y.Item && storedChild.parent === /** @type {Y.ContentType} */ (/** @type {Y.Item} */ (storedParent).content).type)
      t.assert(bundled.store.pendingStructs === null && bundled.store.pendingDs === null)
    })
  })
}

export const testCausalHoleLongChainValidation = () => {
  const length = 10000
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const base = createCausalHoleBase()
    /** @type {Array<CausalHole>} */
    const holes = []
    for (let clock = 0; clock < length; clock++) {
      holes.push(new CausalHole(
        Y.createID(2, clock),
        1,
        clock === 0 ? Y.createID(1, 0) : Y.createID(2, clock - 1),
        clock % 2 === 0 ? null : Y.createID(1, 0),
        'text',
        null
      ))
    }
    apply(base, encodeCausalHoles(holes, Encoder))
    t.assert(base.get('text').toString() === 'a')
    t.assert(base.store.pendingStructs === null && base.store.pendingDs === null)
    t.assert(base.store.clients.get(2)?.length === length)
    t.assert(base.store.causalHoles.clients.get(2)?.getIds().length === 1)
  })
}

export const testCausalHoleKnownBoundaryNormalizationIsLinear = () => {
  const length = 2048
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const target = createCausalHoleBase()
    const materialized = Array.from({ length }, (_, clock) => new Y.Item(
      Y.createID(2, clock),
      null,
      clock === 0 ? Y.createID(1, 0) : Y.createID(2, clock - 1),
      null,
      null,
      null,
      null,
      clock % 2 === 0 ? new Y.ContentString('x') : new Y.ContentEmbed(clock)
    ))
    apply(target, encodeStructs(materialized, Encoder))
    t.assert(target.store.clients.get(2)?.length === length)

    const duplicate = encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), length, Y.createID(1, 0), null, 'text', null)
    ], Encoder)
    const originalSplice = Array.prototype.splice
    let splices = 0
    /**
     * @this {Array<unknown>}
     * @param {number} _start
     * @param {number} [_deleteCount]
     * @param {...unknown} _items
     */
    const countedSplice = function (_start, _deleteCount, ..._items) {
      splices++
      return Reflect.apply(originalSplice, this, arguments)
    }
    // eslint-disable-next-line no-extend-native
    Array.prototype.splice = /** @type {typeof Array.prototype.splice} */ (countedSplice)
    try {
      apply(target, duplicate)
    } finally {
      // eslint-disable-next-line no-extend-native
      Array.prototype.splice = originalSplice
    }
    t.assert(splices < 16, `${Encoder.name} normalization rebuilds once (${splices} splices for ${length} boundaries)`)
    t.assert(target.store.clients.get(2)?.length === length && target.store.causalHoles.isEmpty())
  })
}

export const testCausalHoleMultilevelConsumersReloadAndSplit = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, merge: Y.mergeUpdates, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, merge: Y.mergeUpdatesV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, apply, merge, encode }) => {
    const source = encodeStructs([
      new Y.Item(Y.createID(2, 0), null, Y.createID(1, 0), null, null, null, null, new Y.ContentString('WXYZ'))
    ], Encoder)
    const level1 = encodeStructs([
      new Y.Item(Y.createID(3, 0), null, Y.createID(2, 0), null, Y.createID(2, 1), null, null, new Y.ContentString('B'))
    ], Encoder)
    const level2 = encodeStructs([
      new Y.Item(Y.createID(4, 0), null, Y.createID(3, 0), null, Y.createID(2, 2), null, null, new Y.ContentString('C'))
    ], Encoder)
    const consumer = encodeStructs([
      new Y.Item(Y.createID(5, 0), null, Y.createID(4, 0), null, null, null, null, new Y.ContentString('D'))
    ], Encoder)
    const sparseParts = [
      encodeCausalHoles([new CausalHole(Y.createID(2, 0), 4, Y.createID(1, 0), null, 'text', null)], Encoder),
      encodeCausalHoles([new CausalHole(Y.createID(3, 0), 1, Y.createID(2, 0), Y.createID(2, 1), 'text', null)], Encoder),
      encodeCausalHoles([new CausalHole(Y.createID(4, 0), 1, Y.createID(3, 0), Y.createID(2, 2), 'text', null)], Encoder),
      consumer
    ]
    t.fails(() => merge(sparseParts))

    const canonical = createCausalHoleBase()
    ;[source, level1, level2, consumer].forEach(update => apply(canonical, update))
    const sparseDoc = createCausalHoleBase()
    sparseParts.forEach(update => apply(sparseDoc, update))
    const reloaded = createCausalHoleBase()
    apply(reloaded, encode(sparseDoc))

    apply(reloaded, source)
    ;[level1, level2].forEach(update => apply(reloaded, update))
    t.assert(reloaded.store.causalHoles.isEmpty())
    t.assert(reloaded.store.pendingStructs === null && reloaded.store.pendingDs === null)
    t.assert(reloaded.get('text').toString() === canonical.get('text').toString(), `${Encoder.name} multilevel materialization converges`)
    apply(reloaded, encode(canonical))
    apply(canonical, encode(reloaded))
    t.assert(reloaded.get('text').toString() === canonical.get('text').toString())
  })
}

export const testCausalHoleSameAnchorRemoteScaling = () => {
  const sizes = [400, 800, 1600]
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    /** @param {number} size */
    const createUpdate = size => encodeStructGroups([
      [new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'text', null)],
      ...Array.from({ length: size }, (_, index) => [
        new Y.Item(
          Y.createID(100 + index, 0),
          null,
          Y.createID(2, 0),
          null,
          null,
          null,
          null,
          new Y.ContentString('x')
        )
      ])
    ], Encoder)
    /** @param {Uint8Array<ArrayBuffer>} update @param {number} size */
    const countOrderingWork = (update, size) => {
      const originalAdd = Set.prototype.add
      let work = 0
      /**
       * @this {Set<unknown>}
       * @param {unknown} value
       */
      const countedAdd = function (value) {
        if (
          value !== null && typeof value === 'object' &&
          typeof /** @type {{kind?:unknown}} */ (value).kind === 'string' &&
          typeof /** @type {{active?:unknown}} */ (value).active === 'boolean'
        ) work++
        return Reflect.apply(originalAdd, this, arguments)
      }
      const doc = createCausalHoleBase()
      // eslint-disable-next-line no-extend-native
      Set.prototype.add = /** @type {typeof Set.prototype.add} */ (countedAdd)
      try {
        apply(doc, update)
      } finally {
        // eslint-disable-next-line no-extend-native
        Set.prototype.add = originalAdd
      }
      t.assert(doc.get('text').length === size + 1)
      return work
    }
    const updates = sizes.map(createUpdate)
    const work = updates.map((update, index) => countOrderingWork(update, sizes[index]))
    t.assert(work.every((count, index) => count === sizes[index] * 3 - 1), `${Encoder.name} same-anchor ordering exact work: ${work.join(',')}`)
    t.assert(work[2] === work[1] * 2 + 1, `${Encoder.name} same-anchor 2x work is linear: ${work.join(',')}`)

    apply(createCausalHoleBase(), createUpdate(25))
    const samples = []
    for (let repetition = 0; repetition < 3; repetition++) {
      const doc = createCausalHoleBase()
      const started = performance.now()
      apply(doc, updates[2])
      samples.push(performance.now() - started)
      t.assert(doc.get('text').length === sizes[2] + 1)
    }
    const smoke = samples.sort((left, right) => left - right)[1]
    t.assert(smoke < 2000, `${Encoder.name} 1600-consumer apply stays under 2s (${smoke.toFixed(1)}ms)`)
  })
}

export const testCausalHoleSameClientBoundaryScaling = () => {
  const timingSizes = [8000, 16000, 32000]
  const workSizes = [500, 1000, 2000]
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    /** @param {number} size */
    const createUpdate = size => encodeStructGroups([
      [new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'text', null)],
      Array.from({ length: size }, (_, clock) => new Y.Item(
        Y.createID(3, clock),
        null,
        clock === 0 ? Y.createID(2, 0) : Y.createID(3, clock - 1),
        null,
        null,
        null,
        null,
        new Y.ContentString('x')
      ))
    ], Encoder)
    /** @param {Uint8Array<ArrayBuffer>} update */
    const countSetIterations = update => {
      const original = Set.prototype[Symbol.iterator]
      let iterations = 0
      // Count structural Set iteration without exposing a production test hook.
      // eslint-disable-next-line no-extend-native
      Set.prototype[Symbol.iterator] = function () {
        const iterator = original.call(this)
        return {
          next: () => {
            const result = iterator.next()
            if (!result.done) iterations++
            return result
          },
          [Symbol.iterator] () { return this }
        }
      }
      try {
        apply(createCausalHoleBase(), update)
      } finally {
        // eslint-disable-next-line no-extend-native
        Set.prototype[Symbol.iterator] = original
      }
      return iterations
    }

    const work = workSizes.map(size => countSetIterations(createUpdate(size)))
    const workRatio = work[2] / work[1]
    t.assert(work.every((count, index) => count < workSizes[index] * 6), `${Encoder.name} boundary work stays linear: ${work.join(',')}`)
    t.assert(workRatio < 3.25, `${Encoder.name} boundary work is nonquadratic: ${work.join(',')} (${workRatio.toFixed(2)}x)`)
    const updates = timingSizes.map(createUpdate)
    apply(createCausalHoleBase(), createUpdate(100))
    const times = updates.map(update => {
      const samples = []
      for (let repetition = 0; repetition < 3; repetition++) {
        const doc = createCausalHoleBase()
        const started = performance.now()
        apply(doc, update)
        samples.push(performance.now() - started)
      }
      return samples.sort((left, right) => left - right)[1]
    })
    const ratio8To16 = times[1] / times[0]
    const ratio16To32 = times[2] / times[1]
    t.assert(ratio8To16 < 3.25, `${Encoder.name} 8k→16k ratio ${ratio8To16.toFixed(2)} is nonquadratic`)
    t.assert(ratio16To32 < 3.25, `${Encoder.name} 16k→32k ratio ${ratio16To32.toFixed(2)} is nonquadratic`)
    t.assert(times[2] < 2000, `${Encoder.name} 32k-item apply stays under 2s (${times[2].toFixed(1)}ms)`)
  })
}

export const testCausalHoleReverseDiscoveryCollectsOnce = () => {
  /**
   * @param {number} length
   * @param {typeof Y.UpdateEncoderV1|typeof Y.UpdateEncoderV2} Encoder
   * @param {(doc:Y.Doc,update:Uint8Array<ArrayBuffer>)=>void} apply
   * @param {(doc:Y.Doc)=>Uint8Array<ArrayBuffer>} encode
   * @param {function(Uint8Array<ArrayBuffer>):{structs:Array<Y.GC|Y.Item|Y.Skip|CausalHole>}} decode
   */
  const run = (length, Encoder, apply, encode, decode) => {
    const anchors = Array.from({ length }, (_, clock) => new Y.Item(
      Y.createID(3, clock), null, null, null, null, 'text', null, new Y.ContentString('a')
    ))
    const items = Array.from({ length }, (_, clock) => new Y.Item(
      Y.createID(2, clock),
      null,
      clock === 0 ? null : Y.createID(2, clock - 1),
      null,
      Y.createID(3, clock),
      null,
      null,
      new Y.ContentString('x')
    ))
    const source = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(source, encodeStructGroups([anchors, items], Encoder))
    const known = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(known, encodeStructs(anchors.map((_, clock) => new Y.Item(
      Y.createID(3, clock), null, null, null, null, 'text', null, new Y.ContentString('a')
    )), Encoder))
    const selected = Y.createIdSet()
    selected.add(2, length - 1, 1)
    const encoder = new Encoder()
    const originalSplice = Array.prototype.splice
    let shifted = 0
    /**
     * @this {Array<unknown>}
     * @param {number} start
     * @param {number} [deleteCount]
     * @param {...unknown} _items
     */
    const countedSplice = function (start, deleteCount, ..._items) {
      if (this.some(value => value?.constructor === CausalHole)) {
        const normalizedStart = start < 0 ? Math.max(this.length + start, 0) : Math.min(start, this.length)
        const removed = deleteCount === undefined ? this.length - normalizedStart : Math.min(Math.max(deleteCount, 0), this.length - normalizedStart)
        shifted += this.length - normalizedStart - removed
      }
      return Reflect.apply(originalSplice, this, arguments)
    }
    // eslint-disable-next-line no-extend-native
    Array.prototype.splice = /** @type {typeof Array.prototype.splice} */ (countedSplice)
    try {
      writeStructsFromIdSetWithCausalHoles(encoder, source.store, selected, [known.store])
    } finally {
      // eslint-disable-next-line no-extend-native
      Array.prototype.splice = originalSplice
    }
    Y.writeIdSet(encoder, Y.createIdSet())
    const sparse = encoder.toUint8Array()
    t.assert(decode(sparse).structs.filter(struct => struct.constructor === CausalHole).length === length - 1)
    apply(known, sparse)
    t.assert(known.store.pendingStructs === null && known.store.pendingDs === null)
    apply(known, encode(source))
    t.assert(known.get('text').toString() === source.get('text').toString())
    t.compareArrays(Array.from(Y.encodeStateVector(known)), Array.from(Y.encodeStateVector(source)))
    return shifted
  }

  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, decode: Y.decodeUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, decode: Y.decodeUpdateV2 }
  ].forEach(({ Encoder, apply, encode, decode }) => {
    const small = run(500, Encoder, apply, encode, decode)
    const large = run(4000, Encoder, apply, encode, decode)
    t.assert(large < 4000 * 8 && large < small * 16 + 4000, `${Encoder.name} reverse discovery avoids shifted quadratic work (${small} -> ${large})`)
  })
}

export const testCausalHoleStoreIndexesAvoidGlobalApplyScans = () => {
  const stored = 512
  const sequential = 128
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const doc = new Y.Doc({ gc: false, sparseExactResolution: true })
    apply(doc, encodeStructGroups(Array.from({ length: stored }, (_, index) => [
      new CausalHole(Y.createID(1000 + index, 0), 1, null, null, `unrelated-${index}`, null)
    ]), Encoder))
    t.assert(doc.store.causalHolesByParentGroup.size === stored)

    const originalForEach = doc.store.clients.forEach
    doc.store.clients.forEach = () => { throw new Error('global store scan') }
    try {
      for (let index = 0; index < sequential; index++) {
        apply(doc, encodeCausalHoles([
          new CausalHole(Y.createID(2000 + index, 0), 1, null, null, `sequential-${index}`, null)
        ], Encoder))
      }
      apply(doc, encodeStructGroups([
        [new CausalHole(Y.createID(9000, 0), 1, null, null, 'touched', null)],
        [new Y.Item(Y.createID(9001, 0), null, Y.createID(9000, 0), null, null, null, null, new Y.ContentString('x'))]
      ], Encoder))
    } finally {
      doc.store.clients.forEach = originalForEach
    }

    t.assert(doc.get('touched').toString() === 'x', `${Encoder.name} touched group plans without global enumeration`)
    t.assert(doc.store.causalHolesByParentGroup.size === stored + sequential + 1)
    t.assert(doc.store.pendingStructs === null && doc.store.pendingDs === null)
  })
}

export const testCausalHoleRetainedParentArrivalPermutations = () => {
  const orders = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2],
    [1, 2, 0], [2, 0, 1], [2, 1, 0]
  ]
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, apply, encode }) => {
    const parent = encodeStructs([
      new Y.Item(Y.createID(1, 0), null, null, null, null, 'root', null, new Y.ContentType(new Y.Type()))
    ], Encoder)
    const hole = encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 2, null, null, Y.createID(1, 0), null)
    ], Encoder)
    const source = encodeStructs([
      new Y.Item(Y.createID(2, 0), null, null, null, null, Y.createID(1, 0), null, new Y.ContentString('xy'))
    ], Encoder)
    const deletionIds = Y.createIdSet()
    deletionIds.add(1, 0, 1)
    const updates = [hole, encodeDeleteSet(deletionIds, Encoder), source]
    /** @type {Array<number>|null} */
    let canonical = null
    orders.forEach(order => {
      const doc = new Y.Doc({ gc: false, sparseExactResolution: true })
      apply(doc, parent)
      order.forEach(index => apply(doc, updates[index]))
      const materialized = doc.store.getStruct(Y.createID(2, 0))
      t.assert(materialized?.constructor === Y.Item && materialized.deleted && materialized.length === 2, `${Encoder.name} ${order.join('')} materializes deleted source`)
      t.assert(doc.store.causalHoles.isEmpty())
      t.assert(doc.store.pendingStructs === null && doc.store.pendingDs === null)
      const encoded = Array.from(encode(doc))
      if (canonical === null) canonical = encoded
      else t.compareArrays(encoded, canonical)
      Y.snapshot(doc)
    })
  })
}

export const testCausalHoleSparseMergeParentProofIsStackSafe = () => {
  const length = 20000
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, merge: Y.mergeUpdates },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, merge: Y.mergeUpdatesV2 }
  ].forEach(({ Encoder, apply, merge }) => {
    const items = Array.from({ length }, (_, clock) => new Y.Item(
      Y.createID(7, clock),
      null,
      clock === 0 ? null : Y.createID(7, clock - 1),
      null,
      null,
      clock === 0 ? 'text' : null,
      null,
      new Y.ContentString('x')
    ))
    const sparseTail = encodeCausalHoles([
      new CausalHole(Y.createID(7, length - 1), 1, Y.createID(7, length - 2), null, 'text', null)
    ], Encoder)
    const source = encodeStructs(items, Encoder)
    ;[[source, sparseTail], [sparseTail, source]].forEach(parts => t.fails(() => merge(parts)))
  })
}

export const testCausalHoleSparseMergeGapsRejectBeforeFold = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, merge: Y.mergeUpdates },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, merge: Y.mergeUpdatesV2 }
  ].forEach(({ Encoder, apply, merge }) => {
    const first = encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'text', null)
    ], Encoder)
    const last = encodeCausalHoles([
      new CausalHole(Y.createID(2, 3), 1, Y.createID(1, 0), null, 'text', null)
    ], Encoder)
    const sequential = createCausalHoleBase()
    apply(sequential, first)
    apply(sequential, last)
    t.fails(() => merge([first, last]))
    t.fails(() => merge([last, first]))
    t.assert(sequential.store.causalHoles.has(2, 0) && sequential.store.causalHoles.has(2, 3))
    t.assert(sequential.store.pendingStructs === null && sequential.store.pendingDs === null)
  })
}

export const testCausalHoleSparseMergeRequiresProvableParentMetadata = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, merge: Y.mergeUpdates, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, merge: Y.mergeUpdatesV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, apply, merge, encode }) => {
    const canonicalHole = new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'text', null)
    const forgedHole = new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), Y.createID(1, 0), 'text', null)
    const honestItem = new Y.Item(
      Y.createID(2, 0), null, Y.createID(1, 0), null, null, null, null, new Y.ContentString('X')
    )
    const forgedItem = new Y.Item(
      Y.createID(2, 0), null, Y.createID(1, 0), null, Y.createID(1, 0), null, null, new Y.ContentString('X')
    )
    const canonicalHoleUpdate = encodeCausalHoles([canonicalHole], Encoder)
    const forgedHoleUpdate = encodeCausalHoles([forgedHole], Encoder)
    const honestItemUpdate = encodeStructs([honestItem], Encoder)
    const forgedItemUpdate = encodeStructs([forgedItem], Encoder)

    const holeFirst = createCausalHoleBase()
    apply(holeFirst, canonicalHoleUpdate)
    const holeFirstBefore = encode(holeFirst)
    t.fails(() => apply(holeFirst, forgedItemUpdate))
    t.compareArrays(Array.from(encode(holeFirst)), Array.from(holeFirstBefore))

    const itemFirst = createCausalHoleBase()
    apply(itemFirst, honestItemUpdate)
    const itemFirstBefore = encode(itemFirst)
    t.fails(() => apply(itemFirst, forgedHoleUpdate))
    t.compareArrays(Array.from(encode(itemFirst)), Array.from(itemFirstBefore))

    t.fails(() => merge([canonicalHoleUpdate, forgedItemUpdate]))
    t.fails(() => merge([forgedItemUpdate, canonicalHoleUpdate]))
    t.fails(() => merge([forgedHoleUpdate, honestItemUpdate]))
    t.fails(() => merge([honestItemUpdate, forgedHoleUpdate]))

    // The matching parent is not encoded on honestItem; without its external anchor merge cannot prove it.
    t.fails(() => merge([canonicalHoleUpdate, honestItemUpdate]))
    t.fails(() => merge([honestItemUpdate, canonicalHoleUpdate]))

    const explicitHoleUpdate = encodeCausalHoles([
      new CausalHole(Y.createID(5, 0), 1, null, null, 'explicit', null)
    ], Encoder)
    const explicitItemUpdate = encodeStructs([
      new Y.Item(Y.createID(5, 0), null, null, null, null, 'explicit', null, new Y.ContentString('E'))
    ], Encoder)
    t.fails(() => merge([explicitHoleUpdate, explicitItemUpdate]))
    t.fails(() => merge([explicitItemUpdate, explicitHoleUpdate]))

    const baseline = encode(createCausalHoleBase())
    t.fails(() => merge([baseline, canonicalHoleUpdate, honestItemUpdate]))
    t.fails(() => merge([baseline, honestItemUpdate, canonicalHoleUpdate]))
  })
}

export const testCausalHoleSparseMergeUsesIncludedRightProof = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, merge: Y.mergeUpdates },
    { Encoder: Y.UpdateEncoderV2, merge: Y.mergeUpdatesV2 }
  ].forEach(({ Encoder, merge }) => {
    const right = new Y.Item(
      Y.createID(3, 0), null, null, null, null, 'text', null, new Y.ContentString('R')
    )
    const external = new Y.Item(
      Y.createID(1, 0), null, null, null, Y.createID(3, 0), null, null, new Y.ContentString('L')
    )
    const baseline = encodeStructGroups([[right], [external]], Encoder)
    const source = new Y.Item(
      Y.createID(2, 0), null, Y.createID(1, 0), null, Y.createID(3, 0), null, null, new Y.ContentString('X')
    )
    const proof = encodeStructGroups([[
      new Y.Item(Y.createID(3, 0), null, null, null, null, 'text', null, new Y.ContentString('R'))
    ], [source]], Encoder)
    const hole = encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), Y.createID(3, 0), 'text', null)
    ], Encoder)

    t.fails(() => merge([baseline, hole, proof]))
    t.fails(() => merge([baseline, proof, hole]))

    const conflictSource = new Y.Item(
      Y.createID(6, 0), null, Y.createID(4, 0), null, Y.createID(5, 0), null, null, new Y.ContentString('!')
    )
    const conflictingProofs = encodeStructGroups([
      [new Y.Item(Y.createID(4, 0), null, null, null, null, 'left', null, new Y.ContentString('l'))],
      [new Y.Item(Y.createID(5, 0), null, null, null, null, 'right', null, new Y.ContentString('r'))],
      [conflictSource]
    ], Encoder)
    const conflictHole = encodeCausalHoles([
      new CausalHole(Y.createID(6, 0), 1, Y.createID(4, 0), Y.createID(5, 0), 'left', null)
    ], Encoder)
    t.fails(() => merge([conflictHole, conflictingProofs]))
    t.fails(() => merge([conflictingProofs, conflictHole]))
  })
}

export const testCausalHoleSparseMergeParentProofIsLinear = () => {
  const length = 768
  ;[
    { Encoder: Y.UpdateEncoderV1, merge: Y.mergeUpdates },
    { Encoder: Y.UpdateEncoderV2, merge: Y.mergeUpdatesV2 }
  ].forEach(({ Encoder, merge }) => {
    const items = Array.from({ length }, (_, clock) => new Y.Item(
      Y.createID(7, clock),
      null,
      clock === 0 ? null : Y.createID(7, clock - 1),
      null,
      null,
      clock === 0 ? 'text' : null,
      null,
      new Y.ContentString('x')
    ))
    const holes = Array.from({ length }, (_, clock) => new CausalHole(
      Y.createID(7, clock),
      1,
      clock === 0 ? null : Y.createID(7, clock - 1),
      null,
      'text',
      null
    ))
    const itemUpdate = encodeStructs(items, Encoder)
    const holeUpdate = encodeCausalHoles(holes, Encoder)
    const originalAdd = Set.prototype.add
    let itemVisits = 0
    /**
     * @this {Set<unknown>}
     * @param {unknown} value
     */
    const countedAdd = function (value) {
      if (value !== null && typeof value === 'object' && value.constructor === Y.Item) itemVisits++
      return Reflect.apply(originalAdd, this, arguments)
    }
    // eslint-disable-next-line no-extend-native
    Set.prototype.add = /** @type {typeof Set.prototype.add} */ (countedAdd)
    try {
      t.fails(() => merge([holeUpdate, itemUpdate]))
    } finally {
      // eslint-disable-next-line no-extend-native
      Set.prototype.add = originalAdd
    }
    t.assert(itemVisits < length * 3, `${Encoder.name} parent proof path-compresses ${length} fragments (${itemVisits} visits)`)
  })
}

export const testCausalHoleSparseMergeKeepsDominantItemWhole = () => {
  const length = 256
  ;[
    { Encoder: Y.UpdateEncoderV1, merge: Y.mergeUpdates },
    { Encoder: Y.UpdateEncoderV2, merge: Y.mergeUpdatesV2 }
  ].forEach(({ Encoder, merge }) => {
    const item = encodeStructs([
      new Y.Item(Y.createID(7, 0), null, null, null, null, 'text', null, new Y.ContentString('x'.repeat(length)))
    ], Encoder)
    const holes = Array.from({ length }, (_, clock) => encodeCausalHoles([
      new CausalHole(
        Y.createID(7, clock),
        1,
        clock === 0 ? null : Y.createID(7, clock - 1),
        null,
        'text',
        null
      )
    ], Encoder))
    const originalCopy = Y.ContentString.prototype.copy
    const originalSplice = Y.ContentString.prototype.splice
    let copies = 0
    let splices = 0
    Y.ContentString.prototype.copy = function () {
      copies++
      return originalCopy.call(this)
    }
    Y.ContentString.prototype.splice = function (/** @type {number} */ offset) {
      splices++
      return originalSplice.call(this, offset)
    }
    try {
      holes.forEach(hole => {
        t.fails(() => merge([item, hole]))
        t.fails(() => merge([hole, item]))
      })
    } finally {
      Y.ContentString.prototype.copy = originalCopy
      Y.ContentString.prototype.splice = originalSplice
    }

    t.assert(copies === 0 && splices === 0, `${Encoder.name} rejected sparse folds make no Item content copies`)
  })
}

export const testOrdinaryUpdateEncodingExcludesCausalHoles = () => {
  const doc = new Y.Doc({ gc: false })
  doc.clientID = 7
  /** @type {Uint8Array<ArrayBuffer>|null} */
  let update = null
  doc.on('update', value => { update = value })
  doc.get('text').insert(0, 'ordinary')
  const v1 = /** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (update))
  const v2 = Y.convertUpdateFormatV1ToV2(v1)
  const roundtrip = Y.convertUpdateFormatV2ToV1(v2)

  t.compareArrays(Array.from(v1), [1, 1, 7, 0, 4, 1, 4, 116, 101, 120, 116, 8, 111, 114, 100, 105, 110, 97, 114, 121, 0])
  t.assert(!Y.decodeUpdate(v1).structs.some(struct => struct.constructor === CausalHole))
  t.assert(!Y.decodeUpdateV2(v2).structs.some(struct => struct.constructor === CausalHole))
  t.compareArrays(Array.from(v1), Array.from(roundtrip))
  const reload = new Y.Doc({ gc: false })
  let updateCount = 0
  reload.on('update', () => { updateCount++ })
  Y.applyUpdate(reload, roundtrip)
  t.assert(reload.get('text').toString() === 'ordinary' && updateCount === 1)
}

/** @param {t.TestCase} _tc */
export const testDiffStateVectorOfUpdateIsEmpty = _tc => {
  const ydoc = new Y.Doc()
  /**
   * @type {any}
   */
  let sv = null
  ydoc.get().insert(0, 'a')
  ydoc.on('update', update => {
    sv = Y.encodeStateVectorFromUpdate(update)
  })
  // should produce an update with an empty state vector (because previous ops are missing)
  ydoc.get().insert(0, 'a')
  t.assert(sv !== null && sv.byteLength === 1 && sv[0] === 0)
}

/**
 * Reported here: https://github.com/yjs/yjs/issues/308
 * @param {t.TestCase} _tc
 */
export const testDiffStateVectorOfUpdateIgnoresSkips = _tc => {
  const ydoc = new Y.Doc()
  /**
   * @type {Array<Uint8Array<ArrayBuffer>>}
   */
  const updates = []
  ydoc.on('update', update => {
    updates.push(update)
  })
  ydoc.get().insert(0, 'a')
  ydoc.get().insert(0, 'b')
  ydoc.get().insert(0, 'c')
  const update13 = Y.mergeUpdates([updates[0], updates[2]])
  const sv = Y.encodeStateVectorFromUpdate(update13)
  const state = Y.decodeStateVector(sv)
  t.assert(state.get(ydoc.clientID) === 1)
  t.assert(state.size === 1)
}
