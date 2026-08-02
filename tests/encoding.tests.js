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
import { normalizeDocOptions } from '../src/utils/Doc.js'
import { _testOnlyGetSparsePendingProofRuns } from '../src/utils/encoding.js'
import { writeStructsFromIdSetWithCausalHoles } from '../src/utils/encoding-helpers.js'

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

const createCausalHoleBase = () => {
  const doc = new Y.Doc({ gc: false, sparseExactResolution: true })
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
    withGc.store.pendingStructs = {
      missing: new Map(),
      update: encodeStructs([new Y.GC(Y.createID(7, 0), 1)], Y.UpdateEncoderV2)
    }
    t.fails(() => encode(withGc))

    const withUnsupportedRef = createCausalHoleBase()
    withUnsupportedRef.store.pendingStructs = {
      missing: new Map(),
      update: encodeUnsupportedSparseRef(12, Y.UpdateEncoderV2)
    }
    t.fails(() => encode(withUnsupportedRef))

    const withConflict = createCausalHoleBase()
    Y.applyUpdateV2(withConflict, encodeCausalHoles([
      new CausalHole(Y.createID(2, 0), 1, Y.createID(1, 0), null, 'text', null)
    ], Y.UpdateEncoderV2))
    withConflict.store.pendingStructs = {
      missing: new Map(),
      update: encodeCausalHoles([
        new CausalHole(Y.createID(2, 0), 1, null, null, 'other', null)
      ], Y.UpdateEncoderV2)
    }
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
        doc.store.pendingStructs = {
          missing: new Map([[99, 0]]),
          update: pendingItem
        }
        if (withPendingDelete) doc.store.pendingDs = pendingDelete
        const hole = doc.store.getCausalHole(Y.createID(2, 0))
        const pendingStructs = doc.store.pendingStructs
        const pendingDs = doc.store.pendingDs
        t.fails(() => encode(doc, stateVector))
        t.assert(doc.store.getCausalHole(Y.createID(2, 0)) === hole)
        t.assert(doc.store.pendingStructs === pendingStructs && doc.store.pendingDs === pendingDs)
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

  const pending = /** @type {NonNullable<typeof doc.store.pendingStructs>} */ (doc.store.pendingStructs)
  const originalByte = pending.update[pending.update.byteLength - 1]
  pending.update[pending.update.byteLength - 1] ^= 1
  t.fails(() => Y.encodeStateAsUpdate(doc, currentState))
  pending.update[pending.update.byteLength - 1] = originalByte
  pending.missing.set(999, 0)
  t.fails(() => Y.encodeStateAsUpdateV2(doc, currentState))
  pending.missing.delete(999)
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 1)

  const deletes = Y.createIdSet()
  deletes.add(88, 0, 1)
  Y.applyUpdateV2(doc, encodeDeleteSet(deletes, Y.UpdateEncoderV2))
  t.assert(doc.store.pendingDs !== null)
  Y.encodeStateAsUpdate(doc, currentState)
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 2)
  const pendingDelete = /** @type {Uint8Array<ArrayBuffer>} */ (doc.store.pendingDs)
  const deleteByte = pendingDelete[pendingDelete.byteLength - 1]
  pendingDelete[pendingDelete.byteLength - 1] ^= 1
  t.fails(() => Y.encodeStateAsUpdateV2(doc, currentState))
  pendingDelete[pendingDelete.byteLength - 1] = deleteByte

  doc.get('unrelated').insert(0, 'z')
  Y.encodeStateAsUpdateV2(doc, currentState)
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 3)

  doc.transact(() => {
    Y.encodeStateAsUpdate(doc, currentState)
    Y.encodeStateAsUpdateV2(doc, currentState)
  })
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 5)
  Y.encodeStateAsUpdate(doc, currentState)
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 6)

  doc.clientID = 22
  Y.applyUpdate(doc, sourceUpdates[0])
  t.assert(doc.store.pendingStructs === null && doc.get('pending').toString() === 'ab')
  Y.encodeStateAsUpdateV2(doc, currentState)
  t.assert(_testOnlyGetSparsePendingProofRuns(doc) === 7)
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
