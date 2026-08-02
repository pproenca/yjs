import * as t from 'lib0/testing'
import * as encoding from 'lib0/encoding'

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
import { TerminalCausalHole } from '../src/structs/TerminalCausalHole.js'
import { writeStructsFromIdSetWithCausalHoles } from '../src/utils/encoding-helpers.js'

/**
 * @param {Array<Y.GC|Y.Item|Y.Skip|CausalHole|TerminalCausalHole>} structs
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
 * @param {Array<Array<Y.GC|Y.Item|Y.Skip|CausalHole|TerminalCausalHole>>} groups
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
 * @param {Y.IdSet} deleteSet
 * @param {typeof Y.UpdateEncoderV1|typeof Y.UpdateEncoderV2} Encoder
 */
const encodeDeleteSet = (deleteSet, Encoder) => {
  const encoder = new Encoder()
  encoding.writeVarUint(encoder.restEncoder, 0)
  Y.writeIdSet(encoder, deleteSet)
  return encoder.toUint8Array()
}

const createCausalHoleBase = () => {
  const doc = new Y.Doc({ gc: false })
  doc.clientID = 1
  doc.get('text').insert(0, 'a')
  return doc
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
      const replay = new Y.Doc({ gc: false })
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

    const restored = new Y.Doc({ gc: false })
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

    const consumer = new Y.Doc({ gc: false })
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

export const testCausalHoleMergedExtensionReplay = () => {
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
    const merged = merge([first, second, unrelated])
    const mergedHole = decode(merged).structs.find(struct => struct.constructor === CausalHole)
    t.assert(mergedHole?.id.client === 2 && mergedHole.id.clock === 0 && mergedHole.length === 2)

    const target = createCausalHoleBase()
    apply(target, first)
    let updates = 0
    target.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })
    apply(target, merged)
    t.assert(target.store.causalHoles.has(2, 0) && target.store.causalHoles.has(2, 1))
    t.assert(target.store.pendingStructs === null && target.store.pendingDs === null)
    t.assert(target.get('other').toString() === 'u' && updates === 1)

    const replay = createCausalHoleBase()
    apply(replay, encode(target))
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

export const testUnrelatedCausalHoleDoesNotChangeLateChildUnderGc = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply, event }) => {
    const parentGc = encodeStructs([new Y.GC(Y.createID(1, 0), 1)], Encoder)
    const unrelatedHole = encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 1, null, null, 'unrelated', null)
    ], Encoder)
    const lateChild = encodeStructs([
      new Y.Item(Y.createID(3, 0), null, null, null, null, Y.createID(1, 0), null, new Y.ContentString('x'))
    ], Encoder)

    const plain = new Y.Doc({ gc: false })
    plain.clientID = 99
    apply(plain, parentGc)
    /** @type {Uint8Array<ArrayBuffer>|null} */
    let plainEvent = null
    plain.on(/** @type {'update'|'updateV2'} */ (event), update => { plainEvent = update })
    apply(plain, lateChild)

    const sparse = new Y.Doc({ gc: false })
    sparse.clientID = 99
    apply(sparse, parentGc)
    apply(sparse, unrelatedHole)
    /** @type {Uint8Array<ArrayBuffer>|null} */
    let sparseEvent = null
    sparse.on(/** @type {'update'|'updateV2'} */ (event), update => { sparseEvent = update })
    apply(sparse, lateChild)

    t.assert(plain.store.getStruct(Y.createID(3, 0))?.constructor === Y.GC)
    t.assert(sparse.store.getStruct(Y.createID(3, 0))?.constructor === Y.GC, `${Encoder.name} unrelated hole preserves ordinary GC-parent behavior`)
    t.assert(sparse.store.causalHoles.has(2, 0), `${Encoder.name} unrelated hole stays live`)
    t.compareArrays(
      Array.from(/** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (sparseEvent))),
      Array.from(/** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (plainEvent))),
      `${Encoder.name} unrelated sparse state leaves ordinary event bytes exact`
    )
    t.assert(sparse.store.pendingStructs === null && sparse.store.pendingDs === null)
  })
}

export const testCausalHoleTransportRotatesDuplicateClientBeforeLocalAllocation = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, decode: Y.decodeUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, decode: Y.decodeUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply, decode, event }) => {
    const live = new Y.Doc({ gc: false })
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

    const terminal = new Y.Doc({ gc: false })
    apply(terminal, encodeStructs([new Y.GC(Y.createID(1, 0), 1)], Encoder))
    terminal.clientID = 2
    apply(terminal, encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 1, null, null, Y.createID(1, 0), null)
    ], Encoder))
    const terminalClient = terminal.clientID
    t.assert(terminalClient !== 2, `${Encoder.name} terminal sparse transport rotates a duplicate client`)
    /** @type {Uint8Array<ArrayBuffer>|null} */
    let terminalLocalEvent = null
    terminal.on(/** @type {'update'|'updateV2'} */ (event), update => { terminalLocalEvent = update })
    terminal.get('local').insert(0, 'T')
    const terminalLocalStruct = decode(/** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (terminalLocalEvent))).structs.find(struct => struct.constructor === Y.Item)
    t.assert(terminalLocalStruct?.id.client === terminalClient, `${Encoder.name} terminal rotation precedes local allocation`)
    apply(terminal, encodeStructs([
      new Y.Item(Y.createID(2, 0), null, null, null, null, Y.createID(1, 0), null, new Y.ContentString('late'))
    ], Encoder))
    t.assert(terminal.store.getStruct(Y.createID(2, 0))?.constructor === TerminalCausalHole)
    t.assert(terminal.get('local').toString() === 'T')
    t.assert(terminal.store.pendingStructs === null && terminal.store.pendingDs === null)
  })
}

export const testCausalHoleStructuralParentDominanceAndDependency = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply }) => {
    const target = new Y.Doc({ gc: false })
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
      const target = new Y.Doc({ gc: false })
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
    const sparse = merge([
      encodeCausalHoles([new CausalHole(Y.createID(2, 0), 4, Y.createID(1, 0), null, 'text', null)], Encoder),
      encodeCausalHoles([new CausalHole(Y.createID(3, 0), 1, Y.createID(2, 0), Y.createID(2, 1), 'text', null)], Encoder),
      encodeCausalHoles([new CausalHole(Y.createID(4, 0), 1, Y.createID(3, 0), Y.createID(2, 2), 'text', null)], Encoder),
      consumer
    ])

    const canonical = createCausalHoleBase()
    ;[source, level1, level2, consumer].forEach(update => apply(canonical, update))
    const sparseDoc = createCausalHoleBase()
    apply(sparseDoc, sparse)
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
   * @param {function(Uint8Array<ArrayBuffer>):{structs:Array<Y.GC|Y.Item|Y.Skip|CausalHole|TerminalCausalHole>}} decode
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
    const source = new Y.Doc({ gc: false })
    apply(source, encodeStructGroups([anchors, items], Encoder))
    const known = new Y.Doc({ gc: false })
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

export const testCausalHoleIncomingTerminalLookupIsIndexed = () => {
  /**
   * @param {number} length
   * @param {typeof Y.UpdateEncoderV1|typeof Y.UpdateEncoderV2} Encoder
   * @param {(doc:Y.Doc,update:Uint8Array<ArrayBuffer>)=>void} apply
   */
  const measure = (length, Encoder, apply) => {
    const terminals = Array.from({ length }, (_, clock) => new TerminalCausalHole(
      Y.createID(2, clock), 1, null, null, Y.createID(1, 0), null
    ))
    const items = Array.from({ length }, (_, clock) => new Y.Item(
      Y.createID(3, clock), null, null, null, null, 'live', null, new Y.ContentString('x')
    ))
    const update = encodeStructGroups([
      [new Y.GC(Y.createID(1, 0), 1)],
      terminals,
      items
    ], Encoder)
    const originalFilter = Array.prototype.filter
    let terminalVisits = 0
    /**
     * @this {Array<unknown>}
     * @param {function(unknown,number,Array<unknown>):boolean} predicate
     * @param {unknown} [thisArg]
     */
    const countedFilter = function (predicate, thisArg) {
      if (this.length === length && this[0]?.constructor === TerminalCausalHole) {
        return Reflect.apply(originalFilter, this, [
          (/** @type {unknown} */ value, /** @type {number} */ index, /** @type {Array<unknown>} */ values) => {
            terminalVisits++
            return predicate.call(thisArg, value, index, values)
          }
        ])
      }
      return Reflect.apply(originalFilter, this, arguments)
    }
    const doc = new Y.Doc({ gc: true })
    // eslint-disable-next-line no-extend-native
    Array.prototype.filter = /** @type {typeof Array.prototype.filter} */ (countedFilter)
    try {
      apply(doc, update)
    } finally {
      // eslint-disable-next-line no-extend-native
      Array.prototype.filter = originalFilter
    }
    t.assert(doc.store.terminalCausalHoles.has(2, 0) && doc.store.terminalCausalHoles.has(2, length - 1))
    t.assert(doc.get('live').length === length && doc.store.pendingStructs === null && doc.store.pendingDs === null)
    return terminalVisits
  }

  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const small = measure(128, Encoder, apply)
    const large = measure(512, Encoder, apply)
    t.assert(large < 512 * 4 && large < small * 8 + 512, `${Encoder.name} mixed terminal lookup is indexed (${small} -> ${large} visits)`)
  })
}

export const testCausalHoleStoreIndexesAvoidGlobalApplyScans = () => {
  const stored = 512
  const sequential = 128
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const doc = new Y.Doc({ gc: false })
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

export const testCausalHoleNestedParentGcFinalizationMatrix = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2 }
  ].forEach(({ Encoder, apply, encode }) => {
    const parents = encodeStructs([
      new Y.Item(Y.createID(1, 0), null, null, null, null, 'root', null, new Y.ContentType(new Y.Type())),
      new Y.Item(Y.createID(1, 1), null, null, null, null, Y.createID(1, 0), null, new Y.ContentType(new Y.Type()))
    ], Encoder)
    const hole = encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 2, null, null, Y.createID(1, 1), null)
    ], Encoder)
    const dependentHole = encodeCausalHoles([
      new CausalHole(Y.createID(3, 0), 1, Y.createID(2, 0), null, Y.createID(1, 1), null)
    ], Encoder)
    const outerHole = encodeCausalHoles([
      new CausalHole(Y.createID(4, 0), 1, null, null, Y.createID(1, 0), null)
    ], Encoder)
    const source = encodeStructs([
      new Y.Item(Y.createID(2, 0), null, null, null, null, Y.createID(1, 1), null, new Y.ContentString('xy'))
    ], Encoder)
    const dependentSource = encodeStructs([
      new Y.Item(Y.createID(3, 0), null, Y.createID(2, 0), null, null, null, null, new Y.ContentString('z'))
    ], Encoder)
    const outerSource = encodeStructs([
      new Y.Item(Y.createID(4, 0), null, null, null, null, Y.createID(1, 0), null, new Y.ContentString('o'))
    ], Encoder)

    for (const gc of [false, true]) {
      const doc = new Y.Doc({ gc })
      apply(doc, parents)
      apply(doc, hole)
      apply(doc, dependentHole)
      apply(doc, outerHole)
      t.assert(doc.store.causalHoles.has(2, 0) && doc.store.causalHoles.has(2, 1))
      doc.get('root').delete(0, 1)

      if (gc) {
        t.assert(doc.store.causalHoles.isEmpty() && doc.store.causalHolesByParent.size === 0, `${Encoder.name} gc retires nested holes`)
        t.assert(doc.store.getStruct(Y.createID(2, 0))?.constructor === TerminalCausalHole, `${Encoder.name} retired coverage retains terminal provenance`)
        t.assert(doc.store.getStruct(Y.createID(4, 0))?.constructor === TerminalCausalHole, `${Encoder.name} ContentDeleted parent retires its holes`)
      } else {
        t.assert(doc.store.causalHoles.has(2, 0) && doc.store.causalHoles.has(4, 0) && doc.store.causalHolesByParent.size === 2, `${Encoder.name} gc:false preserves nested holes`)
      }

      const reloaded = new Y.Doc({ gc })
      apply(reloaded, encode(doc))
      t.assert(reloaded.store.pendingStructs === null && reloaded.store.pendingDs === null)
      t.assert(reloaded.get('root').length === 0)
      apply(reloaded, source)
      apply(reloaded, dependentSource)
      apply(reloaded, outerSource)
      t.assert(reloaded.store.pendingStructs === null && reloaded.store.pendingDs === null)
      t.assert(reloaded.get('root').length === 0)
      t.assert(reloaded.store.causalHoles.isEmpty(), `${Encoder.name} gc:${gc} late source is materialized or GC-equivalent`)
      if (gc) t.assert(reloaded.store.getStruct(Y.createID(2, 0))?.constructor === TerminalCausalHole)
    }
  })
}

export const testCausalHoleTerminalGcTransportOrdering = () => {
  ;[
    {
      Encoder: Y.UpdateEncoderV1,
      apply: Y.applyUpdate,
      encode: Y.encodeStateAsUpdate,
      merge: Y.mergeUpdates,
      decode: Y.decodeUpdate,
      contentIds: Y.createContentIdsFromUpdate,
      event: 'update'
    },
    {
      Encoder: Y.UpdateEncoderV2,
      apply: Y.applyUpdateV2,
      encode: Y.encodeStateAsUpdateV2,
      merge: Y.mergeUpdatesV2,
      decode: Y.decodeUpdateV2,
      contentIds: Y.createContentIdsFromUpdateV2,
      event: 'updateV2'
    }
  ].forEach(({ Encoder, apply, encode, merge, decode, contentIds, event }) => {
    const parents = encodeStructs([
      new Y.Item(Y.createID(1, 0), null, null, null, null, 'root', null, new Y.ContentType(new Y.Type())),
      new Y.Item(Y.createID(1, 1), null, null, null, null, Y.createID(1, 0), null, new Y.ContentType(new Y.Type()))
    ], Encoder)
    const hole = encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 2, null, null, Y.createID(1, 1), null)
    ], Encoder)
    const deleteSet = Y.createIdSet()
    deleteSet.add(1, 0, 1)
    const deletion = encodeDeleteSet(deleteSet, Encoder)

    /** @param {Y.Doc} doc */
    const terminalSignature = doc => (doc.store.clients.get(2) ?? []).map(struct => [struct.constructor.name, struct.id.clock, struct.length])
    /** @param {Y.Doc} expected @param {Uint8Array<ArrayBuffer>} prior @param {Uint8Array<ArrayBuffer>} update @param {string} label */
    const assertReplay = (expected, prior, update, label) => {
      const replay = new Y.Doc({ gc: true })
      apply(replay, prior)
      apply(replay, update)
      t.compare(terminalSignature(replay), terminalSignature(expected), `${Encoder.name} ${label} replay coverage`)
      t.compareArrays(Array.from(Y.encodeStateVector(replay)), Array.from(Y.encodeStateVector(expected)))
      t.assert(replay.store.pendingStructs === null && replay.store.pendingDs === null)
    }

    const holeThenDelete = new Y.Doc({ gc: true })
    apply(holeThenDelete, parents)
    apply(holeThenDelete, hole)
    const holeThenDeletePrior = encode(holeThenDelete)
    /** @type {Uint8Array<ArrayBuffer>|null} */
    let holeThenDeleteEvent = null
    holeThenDelete.on(/** @type {'update'|'updateV2'} */ (event), update => { holeThenDeleteEvent = update })
    apply(holeThenDelete, deletion)
    const firstEvent = /** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (holeThenDeleteEvent))
    t.compare(terminalSignature(holeThenDelete), [['TerminalCausalHole', 0, 2]], `${Encoder.name} parent-hole-delete terminalizes coverage`)
    t.assert(decode(firstEvent).structs.some(struct => struct.constructor === TerminalCausalHole && struct.id.client === 2))
    t.assert(!contentIds(firstEvent).inserts.has(2, 0), `${Encoder.name} retired terminal coverage is not a semantic insert`)
    assertReplay(holeThenDelete, holeThenDeletePrior, firstEvent, 'parent-hole-delete')

    const deleteThenHole = new Y.Doc({ gc: true })
    apply(deleteThenHole, parents)
    apply(deleteThenHole, deletion)
    const deleteThenHolePrior = encode(deleteThenHole)
    /** @type {Uint8Array<ArrayBuffer>|null} */
    let deleteThenHoleEvent = null
    /** @type {Y.Transaction|null} */
    let deleteThenHoleTransaction = null
    deleteThenHole.on('afterTransaction', transaction => { deleteThenHoleTransaction = transaction })
    deleteThenHole.on(/** @type {'update'|'updateV2'} */ (event), update => { deleteThenHoleEvent = update })
    apply(deleteThenHole, hole)
    const secondEvent = /** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (deleteThenHoleEvent))
    t.compare(terminalSignature(deleteThenHole), [['TerminalCausalHole', 0, 2]], `${Encoder.name} parent-delete-hole canonicalizes to terminal coverage`)
    const secondIds = contentIds(secondEvent)
    t.assert(secondIds.inserts.isEmpty() && secondIds.deletes.isEmpty(), `${Encoder.name} terminal-only event has empty semantic ids`)
    t.assert(
      deleteThenHoleTransaction !== null &&
      /** @type {Y.Transaction} */ (deleteThenHoleTransaction).insertSet.isEmpty() &&
      /** @type {Y.Transaction} */ (deleteThenHoleTransaction).deleteSet.isEmpty(),
      `${Encoder.name} terminal-only transaction sets stay empty`
    )
    assertReplay(deleteThenHole, deleteThenHolePrior, secondEvent, 'parent-delete-hole')

    const combined = new Y.Doc({ gc: true })
    apply(combined, parents)
    const combinedPrior = encode(combined)
    /** @type {Uint8Array<ArrayBuffer>|null} */
    let combinedEvent = null
    combined.on(/** @type {'update'|'updateV2'} */ (event), update => { combinedEvent = update })
    apply(combined, merge([hole, deletion]))
    const thirdEvent = /** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (combinedEvent))
    t.compare(terminalSignature(combined), [['TerminalCausalHole', 0, 2]], `${Encoder.name} combined hole-delete terminalizes coverage`)
    t.assert(decode(thirdEvent).structs.some(struct => struct.constructor === TerminalCausalHole && struct.id.client === 2))
    t.assert(!contentIds(thirdEvent).inserts.has(2, 0), `${Encoder.name} combined terminal coverage is not a semantic insert`)
    assertReplay(combined, combinedPrior, thirdEvent, 'combined')

    t.compare(terminalSignature(holeThenDelete), terminalSignature(deleteThenHole))
    t.compare(terminalSignature(deleteThenHole), terminalSignature(combined))
  })
}

export const testCausalHoleBareGcNeverBecomesTerminal = () => {
  ;[
    {
      Encoder: Y.UpdateEncoderV1,
      apply: Y.applyUpdate,
      decode: Y.decodeUpdate,
      encode: Y.encodeStateAsUpdate,
      merge: Y.mergeUpdates,
      contentIds: Y.createContentIdsFromUpdate,
      state: Y.encodeStateVectorFromUpdate,
      convert: Y.convertUpdateFormatV1ToV2,
      roundtrip: Y.convertUpdateFormatV2ToV1
    },
    {
      Encoder: Y.UpdateEncoderV2,
      apply: Y.applyUpdateV2,
      decode: Y.decodeUpdateV2,
      encode: Y.encodeStateAsUpdateV2,
      merge: Y.mergeUpdatesV2,
      contentIds: Y.createContentIdsFromUpdateV2,
      state: Y.encodeStateVectorFromUpdateV2,
      convert: Y.convertUpdateFormatV2ToV1,
      roundtrip: Y.convertUpdateFormatV1ToV2
    }
  ].forEach(({ Encoder, apply, decode, encode, merge, contentIds, state, convert, roundtrip }) => {
    const update = encodeStructs([new Y.GC(Y.createID(8, 0), 2)], Encoder)
    const decoded = decode(update)
    t.assert(decoded.structs.length === 1 && decoded.structs[0].constructor === Y.GC)
    t.assert(contentIds(update).inserts.isEmpty(), `${Encoder.name} bare GC is not an insert without DS coverage`)
    t.assert(contentIds(update).deletes.isEmpty(), `${Encoder.name} empty DS stays empty`)
    t.assert((Y.decodeStateVector(state(update)).get(8) ?? 0) === 2)
    t.compareArrays(Array.from(roundtrip(convert(update))), Array.from(update))

    const doc = new Y.Doc({ gc: true })
    apply(doc, update)
    t.assert(doc.store.getStruct(Y.createID(8, 0))?.constructor === Y.GC)
    t.assert(doc.store.terminalCausalHoles.isEmpty())
    const full = encode(doc)
    t.assert(decode(full).structs.some(struct => struct.constructor === Y.GC && struct.id.client === 8))
    t.assert(!decode(full).structs.some(struct => struct.constructor === TerminalCausalHole))
    t.assert(contentIds(full).inserts.has(8, 0), `${Encoder.name} ordinary GC remains a semantic insert`)

    const gcDeletes = Y.createIdSet()
    gcDeletes.add(8, 0, 2)
    const withDeleteSet = merge([update, encodeDeleteSet(gcDeletes, Encoder)])
    const gcContentIds = contentIds(withDeleteSet)
    t.assert(gcContentIds.inserts.has(8, 0) && gcContentIds.inserts.has(8, 1))
    t.assert(gcContentIds.deletes.has(8, 0) && gcContentIds.deletes.has(8, 1))
    const deleted = new Y.Doc({ gc: true })
    apply(deleted, withDeleteSet)
    t.assert(deleted.store.getStruct(Y.createID(8, 0))?.constructor === Y.GC)
    t.assert(deleted.store.terminalCausalHoles.isEmpty(), `${Encoder.name} GC plus DS is still ordinary GC`)
  })
}

export const testCausalHoleTerminalDurabilityAndSourceDominance = () => {
  ;[
    {
      Encoder: Y.UpdateEncoderV1,
      apply: Y.applyUpdate,
      decode: Y.decodeUpdate,
      encode: Y.encodeStateAsUpdate,
      merge: Y.mergeUpdates,
      contentIds: Y.createContentIdsFromUpdate,
      state: Y.encodeStateVectorFromUpdate,
      convert: Y.convertUpdateFormatV1ToV2,
      decodeConverted: Y.decodeUpdateV2,
      roundtrip: Y.convertUpdateFormatV2ToV1
    },
    {
      Encoder: Y.UpdateEncoderV2,
      apply: Y.applyUpdateV2,
      decode: Y.decodeUpdateV2,
      encode: Y.encodeStateAsUpdateV2,
      merge: Y.mergeUpdatesV2,
      contentIds: Y.createContentIdsFromUpdateV2,
      state: Y.encodeStateVectorFromUpdateV2,
      convert: Y.convertUpdateFormatV2ToV1,
      decodeConverted: Y.decodeUpdate,
      roundtrip: Y.convertUpdateFormatV1ToV2
    }
  ].forEach(({ Encoder, apply, decode, encode, merge, contentIds, state, convert, decodeConverted, roundtrip }) => {
    const parent = encodeStructs([
      new Y.Item(Y.createID(1, 0), null, null, null, null, 'root', null, new Y.ContentType(new Y.Type()))
    ], Encoder)
    const hole = encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 2, null, null, Y.createID(1, 0), null)
    ], Encoder)
    const deletionIds = Y.createIdSet()
    deletionIds.add(1, 0, 1)
    const deletion = encodeDeleteSet(deletionIds, Encoder)
    const source = encodeStructs([
      new Y.Item(Y.createID(2, 0), null, null, null, null, Y.createID(1, 0), null, new Y.ContentString('xy'))
    ], Encoder)

    const terminal = new Y.Doc({ gc: true })
    apply(terminal, parent)
    apply(terminal, merge([hole, deletion]))
    t.assert(terminal.store.getStruct(Y.createID(2, 0))?.constructor === TerminalCausalHole)
    t.assert((Y.decodeStateVector(Y.encodeStateVector(terminal)).get(2) ?? 0) === 2, `${Encoder.name} terminal coverage advances state`)
    t.assert(!Y.createInsertSetFromStructStore(terminal.store, false).has(2, 0))
    t.assert(!terminal.store.ds.has(2, 0))
    t.fails(() => Y.snapshot(terminal))

    const full = encode(terminal)
    const fullStructs = decode(full).structs
    t.assert(fullStructs.some(struct => struct.constructor === TerminalCausalHole && struct.id.client === 2))
    t.assert(!fullStructs.some(struct => struct.constructor === Y.GC && struct.id.client === 2))
    t.assert(!contentIds(full).inserts.has(2, 0) && !contentIds(full).deletes.has(2, 0))
    t.assert((Y.decodeStateVector(state(full)).get(2) ?? 0) === 2)
    const converted = convert(full)
    t.assert(decodeConverted(converted).structs.some(struct => struct.constructor === TerminalCausalHole && struct.id.client === 2))
    t.assert(decode(roundtrip(converted)).structs.some(struct => struct.constructor === TerminalCausalHole && struct.id.client === 2))

    const reloaded = new Y.Doc({ gc: true })
    apply(reloaded, full)
    t.assert(reloaded.store.getStruct(Y.createID(2, 0))?.constructor === TerminalCausalHole)
    const relayed = encode(reloaded)
    t.assert(decode(relayed).structs.some(struct => struct.constructor === TerminalCausalHole && struct.id.client === 2))
    const diff = encode(reloaded, Y.encodeStateVector(terminal))
    t.assert(!decode(diff).structs.some(struct => struct.id.client === 2), `${Encoder.name} acknowledged terminal source is not resent`)

    apply(reloaded, source)
    t.assert(reloaded.store.getStruct(Y.createID(2, 0))?.constructor === TerminalCausalHole, `${Encoder.name} matching late source cannot replace terminal coverage`)
    const terminalDeletes = Y.createIdSet()
    terminalDeletes.add(2, 0, 2)
    apply(reloaded, encodeDeleteSet(terminalDeletes, Encoder))
    t.assert(reloaded.store.getStruct(Y.createID(2, 0))?.constructor === TerminalCausalHole)
    t.assert(reloaded.store.pendingDs === null && !reloaded.store.ds.has(2, 0), `${Encoder.name} terminal coverage consumes non-semantic DS`)
    const before = encode(reloaded)
    const forgedSource = encodeStructs([
      new Y.Item(Y.createID(2, 0), null, null, null, Y.createID(9, 0), Y.createID(1, 0), null, new Y.ContentString('xy'))
    ], Encoder)
    t.fails(() => apply(reloaded, forgedSource))
    t.compareArrays(Array.from(encode(reloaded)), Array.from(before))
  })
}

export const testCausalHoleTerminalForgeryAndArrivalOrdering = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, merge: Y.mergeUpdates },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, merge: Y.mergeUpdatesV2 }
  ].forEach(({ Encoder, apply, encode, merge }) => {
    const parent = encodeStructs([
      new Y.Item(Y.createID(1, 0), null, null, null, null, 'root', null, new Y.ContentType(new Y.Type()))
    ], Encoder)
    const hole = encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 2, null, null, Y.createID(1, 0), null)
    ], Encoder)
    const terminal = encodeStructs([
      new TerminalCausalHole(Y.createID(2, 0), 2, null, null, Y.createID(1, 0), null)
    ], Encoder)
    const source = encodeStructs([
      new Y.Item(Y.createID(2, 0), null, null, null, null, Y.createID(1, 0), null, new Y.ContentString('xy'))
    ], Encoder)

    const live = new Y.Doc({ gc: true })
    apply(live, parent)
    apply(live, hole)
    const liveBefore = encode(live)
    t.fails(() => apply(live, terminal))
    t.compareArrays(Array.from(encode(live)), Array.from(liveBefore))
    t.assert(live.store.getStruct(Y.createID(2, 0))?.constructor === CausalHole)
    t.fails(() => apply(live, encodeStructs([new Y.GC(Y.createID(2, 0), 2)], Encoder)))
    t.fails(() => merge([hole, encodeStructs([new Y.GC(Y.createID(2, 0), 2)], Encoder)]))

    const conflictingParent = new Y.Doc({ gc: true })
    apply(conflictingParent, parent)
    const storedParent = conflictingParent.store.getStruct(Y.createID(1, 0))
    const conflictingBefore = encode(conflictingParent)
    const forgedDeadProof = encodeStructGroups([
      [new Y.GC(Y.createID(1, 0), 1)],
      [new TerminalCausalHole(Y.createID(2, 0), 1, null, null, Y.createID(1, 0), null)]
    ], Encoder)
    t.fails(() => apply(conflictingParent, forgedDeadProof))
    t.compareArrays(Array.from(encode(conflictingParent)), Array.from(conflictingBefore))
    t.assert(conflictingParent.store.getStruct(Y.createID(1, 0)) === storedParent && storedParent?.constructor === Y.Item && !storedParent.deleted)
    t.assert(!conflictingParent.store.clients.has(2) && conflictingParent.store.terminalCausalHoles.isEmpty())
    t.assert(conflictingParent.store.pendingStructs === null && conflictingParent.store.pendingDs === null)

    const missingParentDeletion = Y.createIdSet()
    missingParentDeletion.add(9, 0, 1)
    const unprovedTerminal = encodeStructs([
      new TerminalCausalHole(Y.createID(7, 0), 1, null, null, Y.createID(9, 0), null)
    ], Encoder)
    t.fails(() => apply(new Y.Doc({ gc: true }), merge([
      unprovedTerminal,
      encodeDeleteSet(missingParentDeletion, Encoder)
    ])))
    const rootTerminal = encodeStructs([
      new TerminalCausalHole(Y.createID(6, 0), 1, null, null, 'root', null)
    ], Encoder)
    t.fails(() => apply(new Y.Doc({ gc: true }), rootTerminal))
    t.fails(() => merge([rootTerminal, encodeStructs([
      new Y.Item(Y.createID(6, 0), null, null, null, null, 'root', null, new Y.ContentString('x'))
    ], Encoder)]))

    const deletionIds = Y.createIdSet()
    deletionIds.add(1, 0, 1)
    const deletion = encodeDeleteSet(deletionIds, Encoder)
    const createDeadParent = () => {
      const doc = new Y.Doc({ gc: true })
      apply(doc, parent)
      apply(doc, deletion)
      return doc
    }
    const sourceFirst = createDeadParent()
    apply(sourceFirst, source)
    t.assert(sourceFirst.store.getStruct(Y.createID(2, 0))?.constructor === Y.GC)
    apply(sourceFirst, terminal)

    const terminalFirst = createDeadParent()
    apply(terminalFirst, terminal)
    apply(terminalFirst, source)
    ;[
      merge([source, terminal]),
      merge([terminal, source])
    ].forEach(update => {
      const merged = createDeadParent()
      apply(merged, update)
      t.assert(merged.store.getStruct(Y.createID(2, 0))?.constructor === TerminalCausalHole)
      t.compareArrays(Array.from(encode(merged)), Array.from(encode(terminalFirst)))
    })
    t.assert(sourceFirst.store.getStruct(Y.createID(2, 0))?.constructor === TerminalCausalHole)
    t.compareArrays(Array.from(encode(sourceFirst)), Array.from(encode(terminalFirst)))
  })
}

export const testCausalHoleTerminalSplitsStoredMaterializedBoundaries = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, apply }) => {
    const doc = new Y.Doc({ gc: false })
    apply(doc, encodeStructGroups([
      [new Y.Item(Y.createID(1, 0), null, null, null, null, 'root', null, new Y.ContentType(new Y.Type()))],
      [new Y.Item(Y.createID(2, 0), null, null, null, null, Y.createID(1, 0), null, new Y.ContentString('abcd'))]
    ], Encoder))
    const deletionIds = Y.createIdSet()
    deletionIds.add(1, 0, 1)
    apply(doc, encodeDeleteSet(deletionIds, Encoder))
    const source = doc.store.getStruct(Y.createID(2, 0))
    t.assert(source?.constructor === Y.Item && source.deleted && source.length === 4)

    apply(doc, encodeStructs([
      new TerminalCausalHole(Y.createID(2, 1), 2, Y.createID(2, 0), null, Y.createID(1, 0), null)
    ], Encoder))
    const signature = (doc.store.clients.get(2) ?? []).map(struct => [struct.constructor.name, struct.id.clock, struct.length])
    t.compare(signature, [['Item', 0, 1], ['TerminalCausalHole', 1, 2], ['Item', 3, 1]])
    t.assert(doc.store.terminalCausalHoles.has(2, 1) && doc.store.terminalCausalHoles.has(2, 2))
    t.assert(!Y.createInsertSetFromStructStore(doc.store, false).has(2, 1))
    t.assert(doc.store.pendingStructs === null && doc.store.pendingDs === null)
  })
}

export const testCausalHoleSparseMergeGaps = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, merge: Y.mergeUpdates, decode: Y.decodeUpdate },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, merge: Y.mergeUpdatesV2, decode: Y.decodeUpdateV2 }
  ].forEach(({ Encoder, apply, merge, decode }) => {
    const first = encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'text', null)
    ], Encoder)
    const last = encodeCausalHoles([
      new CausalHole(Y.createID(2, 3), 1, Y.createID(1, 0), null, 'text', null)
    ], Encoder)
    const sequential = createCausalHoleBase()
    apply(sequential, first)
    apply(sequential, last)
    const mergedUpdate = merge([first, last])
    const merged = createCausalHoleBase()
    apply(merged, mergedUpdate)

    /** @param {Y.Doc} doc */
    const signature = doc => (doc.store.clients.get(2) ?? []).map(struct => [struct.constructor.name, struct.id.clock, struct.length])
    t.compare(signature(merged), signature(sequential))
    t.compare(signature(merged), [['CausalHole', 0, 1], ['Skip', 1, 2], ['CausalHole', 3, 1]])
    t.assert(decode(mergedUpdate).structs.some(struct => struct.constructor === Y.Skip && struct.id.clock === 1 && struct.length === 2))
    t.assert(merged.store.pendingStructs === null && merged.store.pendingDs === null)
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
    const explicit = new Y.Doc({ gc: false })
    apply(explicit, merge([explicitHoleUpdate, explicitItemUpdate]))
    t.assert(explicit.get('explicit').toString() === 'E' && explicit.store.causalHoles.isEmpty(), `${Encoder.name} explicit matching parent merges`)

    const baseline = encode(createCausalHoleBase())
    ;[
      merge([baseline, canonicalHoleUpdate, honestItemUpdate]),
      merge([baseline, honestItemUpdate, canonicalHoleUpdate])
    ].forEach(merged => {
      const accepted = new Y.Doc({ gc: false })
      apply(accepted, merged)
      t.assert(accepted.get('text').toString() === 'aX' && accepted.store.causalHoles.isEmpty(), `${Encoder.name} merge-input anchor proves copied parent`)
    })
  })
}

export const testCausalHoleSparseMergeUsesIncludedRightProof = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, merge: Y.mergeUpdates },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, merge: Y.mergeUpdatesV2 }
  ].forEach(({ Encoder, apply, merge }) => {
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

    ;[
      merge([hole, proof]),
      merge([proof, hole])
    ].forEach(update => {
      const doc = new Y.Doc({ gc: false })
      apply(doc, baseline)
      apply(doc, update)
      t.assert(doc.get('text').toString() === 'LXR', `${Encoder.name} included right anchor proves copied parent`)
      t.assert(doc.store.causalHoles.isEmpty() && doc.store.pendingStructs === null && doc.store.pendingDs === null)
    })

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
    /** @type {Uint8Array<ArrayBuffer>} */
    let merged
    // eslint-disable-next-line no-extend-native
    Set.prototype.add = /** @type {typeof Set.prototype.add} */ (countedAdd)
    try {
      merged = merge([holeUpdate, itemUpdate])
    } finally {
      // eslint-disable-next-line no-extend-native
      Set.prototype.add = originalAdd
    }
    t.assert(itemVisits < length * 3, `${Encoder.name} parent proof path-compresses ${length} fragments (${itemVisits} visits)`)
    const doc = new Y.Doc({ gc: false })
    apply(doc, merged)
    t.assert(doc.get('text').toString() === 'x'.repeat(length))
    t.assert(doc.store.causalHoles.isEmpty() && doc.store.pendingStructs === null)
  })
}

export const testCausalHoleSparseMergeKeepsDominantItemWhole = () => {
  const length = 256
  ;[
    { Encoder: Y.UpdateEncoderV1, merge: Y.mergeUpdates, decode: Y.decodeUpdate, apply: Y.applyUpdate },
    { Encoder: Y.UpdateEncoderV2, merge: Y.mergeUpdatesV2, decode: Y.decodeUpdateV2, apply: Y.applyUpdateV2 }
  ].forEach(({ Encoder, merge, decode, apply }) => {
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
    /** @type {Uint8Array<ArrayBuffer>} */
    let merged = item
    try {
      holes.forEach((hole, index) => {
        merged = index % 2 === 0 ? merge([merged, hole]) : merge([hole, merged])
      })
    } finally {
      Y.ContentString.prototype.copy = originalCopy
      Y.ContentString.prototype.splice = originalSplice
    }

    const materialized = decode(merged).structs.filter(struct => struct.constructor === Y.Item)
    t.assert(materialized.length === 1 && materialized[0].id.clock === 0 && materialized[0].length === length, `${Encoder.name} dominant Item stays one range`)
    t.assert(copies === 0 && splices === 0, `${Encoder.name} lower-rank one-clock folds make no Item content copies`)
    const doc = new Y.Doc({ gc: false })
    apply(doc, merged)
    t.assert(doc.get('text').toString() === 'x'.repeat(length))
    t.assert(doc.store.causalHoles.isEmpty() && doc.store.pendingStructs === null && doc.store.pendingDs === null)
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

/**
 * Reported here: https://github.com/yjs/yjs/issues/308
 * @param {t.TestCase} _tc
 */
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
