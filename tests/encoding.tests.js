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
      decode: Y.decodeUpdate,
      contentIds: Y.createContentIdsFromUpdate,
      event: 'update'
    },
    {
      Encoder: Y.UpdateEncoderV2,
      apply: Y.applyUpdateV2,
      encode: Y.encodeStateAsUpdateV2,
      decode: Y.decodeUpdateV2,
      contentIds: Y.createContentIdsFromUpdateV2,
      event: 'updateV2'
    }
  ].forEach(({ Encoder, apply, encode, decode, contentIds, event }) => {
    const doc = createCausalHoleBase()
    const prior = encode(doc)
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const updates = []
    /** @type {Y.Transaction|null} */
    let transaction = null
    let semanticEvents = 0
    doc.get('text').observe(() => { semanticEvents++ })
    doc.on('afterTransaction', tr => { transaction = tr })
    doc.on(/** @type {'update'|'updateV2'} */ (event), update => updates.push(update))

    apply(doc, encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 2, Y.createID(1, 0), null, 'text', null)
    ], Encoder))

    t.assert(updates.length === 1 && semanticEvents === 0, `${Encoder.name} emits transport without a type event`)
    const ids = contentIds(updates[0])
    t.assert(ids.inserts.isEmpty() && ids.deletes.isEmpty(), `${Encoder.name} transport update has no semantic ids`)
    t.assert(
      transaction !== null &&
      /** @type {Y.Transaction} */ (transaction).insertSet.isEmpty() &&
      /** @type {Y.Transaction} */ (transaction).deleteSet.isEmpty(),
      `${Encoder.name} transaction sets stay semantic`
    )
    t.assert(decode(updates[0]).structs.some(struct => struct.constructor === CausalHole), `${Encoder.name} emitted update carries the hole`)

    const replay = new Y.Doc({ gc: false })
    apply(replay, prior)
    apply(replay, updates[0])
    const replayHole = replay.store.getCausalHole(Y.createID(2, 0))
    t.assert(replay.get('text').toString() === doc.get('text').toString())
    t.assert(replayHole !== null && replayHole.length === 2, `${Encoder.name} prior plus emitted update reconstructs post-state`)
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

export const testCausalHoleStructuralParentDominanceAndDependency = () => {
  ;[
    { Encoder: Y.UpdateEncoderV1, apply: Y.applyUpdate, encode: Y.encodeStateAsUpdate, event: 'update' },
    { Encoder: Y.UpdateEncoderV2, apply: Y.applyUpdateV2, encode: Y.encodeStateAsUpdateV2, event: 'updateV2' }
  ].forEach(({ Encoder, apply, encode, event }) => {
    const gcTarget = new Y.Doc({ gc: false })
    apply(gcTarget, encodeStructs([new Y.GC(Y.createID(1, 0), 1)], Encoder))
    const duplicateParent = new Y.Item(
      Y.createID(1, 0), null, null, null, null, 'fake', null, new Y.ContentType(new Y.Type())
    )
    const childHole = new CausalHole(Y.createID(2, 0), 1, null, null, Y.createID(1, 0), null)
    const unrelated = new Y.Item(
      Y.createID(9, 0), null, null, null, null, 'other', null, new Y.ContentString('must-not-commit')
    )
    const malformed = encodeStructGroups([[duplicateParent], [childHole], [unrelated]], Encoder)
    const before = encode(gcTarget)
    const clients = new Map(gcTarget.store.clients)
    let updates = 0
    gcTarget.on(/** @type {'update'|'updateV2'} */ (event), () => { updates++ })

    t.fails(() => apply(gcTarget, malformed))
    t.compareArrays(Array.from(encode(gcTarget)), Array.from(before))
    t.assert([...clients].every(([client, structs]) => gcTarget.store.clients.get(client) === structs))
    t.assert(gcTarget.store.getStruct(Y.createID(1, 0))?.constructor === Y.GC, `${Encoder.name} stored GC dominates the duplicate type`)
    t.assert(!gcTarget.store.clients.has(2) && !gcTarget.store.clients.has(9) && updates === 0, `${Encoder.name} parent failure is zero-write`)

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
  const sizes = [100, 200, 400, 800, 1600]
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
    const updates = sizes.map(createUpdate)
    apply(createCausalHoleBase(), createUpdate(25))
    const times = updates.map((update, sizeIndex) => {
      const samples = []
      for (let repetition = 0; repetition < 3; repetition++) {
        const doc = createCausalHoleBase()
        const started = performance.now()
        apply(doc, update)
        samples.push(performance.now() - started)
        t.assert(doc.get('text').length === sizes[sizeIndex] + 1)
      }
      return samples.sort((left, right) => left - right)[1]
    })
    const ratio400To800 = times[3] / times[2]
    const ratio800To1600 = times[4] / times[3]
    t.assert(ratio400To800 < 3.25, `${Encoder.name} 400→800 ratio ${ratio400To800.toFixed(2)} is nonquadratic`)
    t.assert(ratio800To1600 < 3.25, `${Encoder.name} 800→1600 ratio ${ratio800To1600.toFixed(2)} is nonquadratic`)
    t.assert(times[4] < 1000, `${Encoder.name} 1600-consumer apply stays under 1s (${times[4].toFixed(1)}ms)`)
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
        t.assert(doc.store.getStruct(Y.createID(2, 0))?.constructor === Y.GC, `${Encoder.name} retired coverage becomes GC`)
        t.assert(doc.store.getStruct(Y.createID(4, 0))?.constructor === Y.GC, `${Encoder.name} ContentDeleted parent retires its holes`)
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
      if (gc) t.assert(reloaded.store.getStruct(Y.createID(2, 0))?.constructor === Y.GC)
    }
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

export const testCausalHoleSparseMergeValidatesMaterializedMetadata = () => {
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

    const merged = merge([canonicalHoleUpdate, honestItemUpdate])
    const accepted = createCausalHoleBase()
    apply(accepted, merged)
    t.assert(accepted.get('text').toString() === 'aX' && accepted.store.causalHoles.isEmpty(), `${Encoder.name} matching materialized metadata keeps Item precedence`)
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
