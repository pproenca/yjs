import * as t from 'lib0/testing'
import * as Y from '../src/index.js'
import { init, compare } from './testHelper.js' // eslint-disable-line
import { readBlockSet } from '../src/utils/BlockSet.js'
import { readIdSet, writeIdSet } from '../src/utils/ids.js'
import { UpdateDecoderV2 } from '../src/utils/UpdateDecoder.js'
import { UpdateEncoderV2 } from '../src/utils/UpdateEncoder.js'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as object from 'lib0/object'
import * as delta from 'lib0/delta'
import * as array from 'lib0/array'
import { CausalHole, sameCausalHoleMetadata } from '../src/structs/CausalHole.js'

/**
 * @typedef {Object} Enc
 * @property {function(Array<Uint8Array<ArrayBuffer>>):Uint8Array<ArrayBuffer>} Enc.mergeUpdates
 * @property {function(Y.Doc):Uint8Array<ArrayBuffer>} Enc.encodeStateAsUpdate
 * @property {function(Y.Doc, Uint8Array):void} Enc.applyUpdate
 * @property {function(Uint8Array):void} Enc.logUpdate
 * @property {function(Uint8Array):{deletes:Y.IdSet,inserts:Y.IdSet}} Enc.readUpdateToContentIds
 * @property {function(Y.Doc):Uint8Array<ArrayBuffer>} Enc.encodeStateVector
 * @property {function(Uint8Array):Uint8Array<ArrayBuffer>} Enc.encodeStateVectorFromUpdate
 * @property {'update'|'updateV2'} Enc.updateEventName
 * @property {string} Enc.description
 * @property {function(Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>):Uint8Array<ArrayBuffer>} Enc.diffUpdate
 */

/**
 * @type {Enc}
 */
const encV1 = {
  mergeUpdates: Y.mergeUpdates,
  encodeStateAsUpdate: Y.encodeStateAsUpdate,
  applyUpdate: Y.applyUpdate,
  logUpdate: Y.logUpdate,
  readUpdateToContentIds: Y.createContentIdsFromUpdate,
  encodeStateVectorFromUpdate: Y.encodeStateVectorFromUpdate,
  encodeStateVector: Y.encodeStateVector,
  updateEventName: 'update',
  description: 'V1',
  diffUpdate: Y.diffUpdate
}

/**
 * @type {Enc}
 */
const encV2 = {
  mergeUpdates: Y.mergeUpdatesV2,
  encodeStateAsUpdate: Y.encodeStateAsUpdateV2,
  applyUpdate: Y.applyUpdateV2,
  logUpdate: Y.logUpdateV2,
  readUpdateToContentIds: Y.createContentIdsFromUpdateV2,
  encodeStateVectorFromUpdate: Y.encodeStateVectorFromUpdateV2,
  encodeStateVector: Y.encodeStateVector,
  updateEventName: 'updateV2',
  description: 'V2',
  diffUpdate: Y.diffUpdateV2
}

/**
 * @type {Enc}
 */
const encDoc = {
  mergeUpdates: (updates) => {
    const ydoc = new Y.Doc({ gc: false })
    updates.forEach(update => {
      Y.applyUpdateV2(ydoc, update)
    })
    return Y.encodeStateAsUpdateV2(ydoc)
  },
  encodeStateAsUpdate: Y.encodeStateAsUpdateV2,
  applyUpdate: Y.applyUpdateV2,
  logUpdate: Y.logUpdateV2,
  readUpdateToContentIds: Y.createContentIdsFromUpdateV2,
  encodeStateVectorFromUpdate: Y.encodeStateVectorFromUpdateV2,
  encodeStateVector: Y.encodeStateVector,
  updateEventName: 'updateV2',
  description: 'Merge via Y.Doc',
  /**
   * @param {Uint8Array} update
   * @param {Uint8Array} sv
   */
  diffUpdate: (update, sv) => {
    const ydoc = new Y.Doc({ gc: false })
    Y.applyUpdateV2(ydoc, update)
    return Y.encodeStateAsUpdateV2(ydoc, sv)
  }
}

const encoders = [encV1, encV2, encDoc]

/**
 * @typedef {Enc & {
 *   convert: function(Uint8Array<ArrayBuffer>):Uint8Array<ArrayBuffer>,
 *   decodeUpdate: function(Uint8Array<ArrayBuffer>):{structs:Array<Y.GC|Y.Item|Y.Skip|CausalHole>},
 *   intersectUpdate: function(Uint8Array<ArrayBuffer>,Y.ContentIds):Uint8Array<ArrayBuffer>
 * }} SparseEnc
 */

/** @type {Array<SparseEnc>} */
const sparseEncoders = [
  {
    ...encV1,
    convert: update => update,
    decodeUpdate: Y.decodeUpdate,
    intersectUpdate: Y.intersectUpdateWithContentIds
  },
  {
    ...encV2,
    convert: Y.convertUpdateFormatV1ToV2,
    decodeUpdate: Y.decodeUpdateV2,
    intersectUpdate: (update, ids) => Y.intersectUpdateWithContentIdsV2(update, ids)
  }
]

const createLaterSparseFixture = () => {
  const base = new Y.Doc({ gc: false, sparseExactResolution: true })
  base.clientID = 1
  base.get('text').insert(0, 'a')
  const baseline = Y.encodeStateAsUpdate(base)
  const suggestion = Y.cloneDoc(base, { gc: false, isSuggestionDoc: true, sparseExactResolution: true })
  suggestion.clientID = 2
  const renderer = Y.createDiffRenderer(base, suggestion)
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const suggestionUpdates = []
  /** @type {Array<Y.ContentIds>} */
  const changes = []
  suggestion.on('update', (update, _origin, _doc, tr) => {
    if (tr.local) {
      suggestionUpdates.push(update)
      changes.push(Y.createContentIdsFromUpdate(update))
    }
  })
  suggestion.get('text').insert(1, 'X')
  suggestion.get('text').insert(2, 'Y')
  /** @type {Uint8Array<ArrayBuffer>|null} */
  let sparseUpdate = null
  base.on('update', update => { sparseUpdate = update })
  renderer.resolveContentIds(changes[1], 'accept', {})
  if (sparseUpdate === null) throw new Error('Expected sparse resolution update')
  return { base, baseline, suggestionUpdates, changes, sparseUpdate }
}

const createSplitSparseFixture = () => {
  const base = new Y.Doc({ gc: false, sparseExactResolution: true })
  base.clientID = 1
  base.get('text').insert(0, 'a')
  const suggestion = Y.cloneDoc(base, { gc: false, isSuggestionDoc: true, sparseExactResolution: true })
  suggestion.clientID = 2
  const renderer = Y.createDiffRenderer(base, suggestion)
  /** @type {Uint8Array<ArrayBuffer>|null} */
  let sourceUpdate = null
  suggestion.on('update', (update, _origin, _doc, tr) => {
    if (tr.local) sourceUpdate = update
  })
  suggestion.get('text').insert(1, 'XYZW')
  const source = /** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (sourceUpdate))
  const sourceIds = Y.createContentIdsFromUpdate(source)
  const selected = Y.createIdSet()
  sourceIds.inserts.forEach((range, client) => selected.add(client, range.clock + range.len - 1, 1))
  renderer.resolveContentIds(Y.createContentIds(selected), 'accept', {})
  return { base, source, sourceIds, selected }
}

/**
 * @param {'origin'|'rightOrigin'} anchorSide
 * @param {number} sourceClient
 * @param {number} concurrentClient
 */
const createVirtualAnchorFixture = (anchorSide, sourceClient, concurrentClient) => {
  const seed = new Y.Doc({ gc: false })
  seed.clientID = 10
  seed.get('text').insert(0, 'a')
  const baseline = Y.encodeStateAsUpdate(seed)
  const base = Y.cloneDoc(seed, { gc: false, sparseExactResolution: true })
  const suggestion = Y.cloneDoc(seed, { gc: false, isSuggestionDoc: true, sparseExactResolution: true })
  suggestion.clientID = sourceClient
  const renderer = Y.createDiffRenderer(base, suggestion)
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const sourceUpdates = []
  /** @type {Array<Y.ContentIds>} */
  const changes = []
  suggestion.on('update', (update, _origin, _doc, tr) => {
    if (tr.local) {
      sourceUpdates.push(update)
      changes.push(Y.createContentIdsFromUpdate(update))
    }
  })
  const text = suggestion.get('text')
  if (anchorSide === 'origin') {
    text.insert(1, 'X')
    text.insert(2, 'Y')
  } else {
    text.insert(0, 'X')
    text.insert(0, 'Y')
  }

  const concurrent = Y.createDocFromUpdate(baseline, { gc: false })
  concurrent.clientID = concurrentClient
  /** @type {Uint8Array<ArrayBuffer>|null} */
  let concurrentUpdate = null
  concurrent.on('update', update => { concurrentUpdate = update })
  concurrent.get('text').insert(anchorSide === 'origin' ? 1 : 0, 'C')
  const concurrentWire = /** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (concurrentUpdate))
  Y.applyUpdate(base, concurrentWire)
  Y.applyUpdate(suggestion, concurrentWire)

  /** @type {Uint8Array<ArrayBuffer>|null} */
  let sparseUpdate = null
  base.on('update', update => { sparseUpdate = update })
  renderer.resolveContentIds(changes[1], 'accept', {})
  const sparseWire = /** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (sparseUpdate))
  return {
    anchorSide,
    sourceClient,
    baseline,
    concurrentUpdate: concurrentWire,
    sourceUpdates,
    changes,
    sparseUpdate: sparseWire
  }
}

const createInteriorConsumerFixture = () => {
  const seed = new Y.Doc({ gc: false })
  seed.clientID = 10
  seed.get('text').insert(0, 'a')
  const baseline = Y.encodeStateAsUpdate(seed)
  const base = Y.cloneDoc(seed, { gc: false, sparseExactResolution: true })
  const suggestion = Y.cloneDoc(seed, { gc: false, isSuggestionDoc: true, sparseExactResolution: true })
  suggestion.clientID = 2
  const renderer = Y.createDiffRenderer(base, suggestion)
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const sourceUpdates = []
  /** @type {Array<Y.ContentIds>} */
  const changes = []
  suggestion.on('update', (update, _origin, _doc, tr) => {
    if (tr.local) {
      sourceUpdates.push(update)
      changes.push(Y.createContentIdsFromUpdate(update))
    }
  })
  const text = suggestion.get('text')
  text.insert(1, 'AB')
  text.insert(2, 'k')
  text.insert(2, 'l')
  text.insert(5, 'm')

  const concurrent = Y.createDocFromUpdate(baseline, { gc: false })
  concurrent.clientID = 6
  /** @type {Uint8Array<ArrayBuffer>|null} */
  let concurrentUpdate = null
  concurrent.on('update', update => { concurrentUpdate = update })
  concurrent.get('text').insert(1, 'C')
  const concurrentWire = /** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (concurrentUpdate))
  Y.applyUpdate(base, concurrentWire)
  Y.applyUpdate(suggestion, concurrentWire)

  const selected = Y.createContentIds(
    Y.mergeIdSets(changes.slice(1).map(change => change.inserts)),
    Y.mergeIdSets(changes.slice(1).map(change => change.deletes))
  )
  /** @type {Uint8Array<ArrayBuffer>|null} */
  let sparseUpdate = null
  base.on('update', update => { sparseUpdate = update })
  renderer.resolveContentIds(selected, 'accept', {})
  const sparseWire = /** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (sparseUpdate))
  return {
    baseline,
    concurrentUpdate: concurrentWire,
    sourceUpdates,
    selected,
    sparseUpdate: sparseWire
  }
}

/** @param {Y.Doc} canonical @param {Y.Doc} actual @param {SparseEnc} enc @param {string} label */
const assertSparseConvergence = (canonical, actual, enc, label) => {
  /** @param {Y.Doc} doc */
  const signature = doc => array.from(doc.store.clients.entries())
    .sort(([left], [right]) => left - right)
    .flatMap(([client, structs]) => structs.map(struct => [client, struct.id.clock, struct.length, struct.constructor.name]))
  /** @param {Y.Doc} doc */
  const linkedOrder = doc => {
    const ids = []
    let item = doc.get('text')._start
    while (item !== null) {
      ids.push([item.id.client, item.id.clock, item.length, item.deleted])
      item = item.right
    }
    return ids
  }
  t.compare(signature(actual), signature(canonical), `${label} store coverage`)
  t.compare(linkedOrder(actual), linkedOrder(canonical), `${label} linked order`)
  t.assert(actual.get('text').toDelta().equals(canonical.get('text').toDelta()), `${label} delta`)
  t.compareArrays(Array.from(Y.encodeStateVector(actual)), Array.from(Y.encodeStateVector(canonical)))
  t.compareArrays(Array.from(enc.encodeStateAsUpdate(actual)), Array.from(enc.encodeStateAsUpdate(canonical)))
  const diff = Y.createDiffRenderer(canonical, actual)
  t.assert(diff.inserts.isEmpty() && diff.deletes.isEmpty(), `${label} structural diff`)
  diff.destroy()
}

/**
 * @param {Array<Y.Doc>} users
 * @param {Enc} enc
 */
const fromUpdates = (users, enc) => {
  const updates = users.map(user =>
    enc.encodeStateAsUpdate(user)
  )
  const ydoc = new Y.Doc()
  enc.applyUpdate(ydoc, enc.mergeUpdates(updates))
  return ydoc
}

/**
 * @param {t.TestCase} tc
 */
export const testMergeUpdates = tc => {
  const { users, array0, array1 } = init(tc, { users: 3 })

  array0.insert(0, [1])
  array1.insert(0, [2])

  compare(users)
  encoders.forEach(enc => {
    const merged = fromUpdates(users, enc)
    t.compareArrays(array0.toArray(), merged.get('array').toArray())
  })
}

export const testSparseCausalHoleCodecMatrix = () => {
  sparseEncoders.forEach(enc => {
    const fixture = createLaterSparseFixture()
    const baseline = enc.convert(fixture.baseline)
    const sparse = enc.convert(fixture.sparseUpdate)
    const selected = fixture.changes[1]
    const sparseIds = enc.readUpdateToContentIds(sparse)
    t.assert(Y.equalIdSets(sparseIds.inserts, selected.inserts))
    t.assert(Y.equalIdSets(sparseIds.deletes, selected.deletes))
    const structs = enc.decodeUpdate(sparse).structs
    const hole = /** @type {CausalHole|undefined} */ (structs.find(struct => struct.constructor === CausalHole))
    const selectedItem = /** @type {Y.Item|undefined} */ (structs.find(struct => struct.id.client === 2 && struct.id.clock === 1))
    t.assert(hole?.id.client === 2 && hole.id.clock === 0 && hole.length === 1)
    t.assert(selectedItem?.id.client === 2 && selectedItem.id.clock === 1)
    t.assert(Y.compareIDs(/** @type {Y.Item} */ (selectedItem).origin, Y.createID(2, 0)), `${enc.description} preserves the selected item's canonical origin`)
    const sparseState = Y.decodeStateVector(enc.encodeStateVectorFromUpdate(sparse))
    t.assert((sparseState.get(2) ?? 0) === 0, `${enc.description} update state vector stops at the hole`)

    /**
     * @param {Y.Doc} doc
     * @param {string} label
     */
    const assertSparse = (doc, label) => {
      t.assert(doc.get('text').toString() === 'aY', `${enc.description} ${label} visible content`)
      t.assert(doc.store.pendingStructs === null && doc.store.pendingDs === null, `${enc.description} ${label} has no pending state`)
      t.assert(doc.store.causalHoles.has(2, 0), `${enc.description} ${label} preserves hole coverage`)
      t.assert(!Y.createInsertSetFromStructStore(doc.store, false).has(2, 0), `${enc.description} ${label} excludes holes from semantic ids`)
      t.assert(Y.createInsertSetFromStructStore(doc.store, false).has(2, 1), `${enc.description} ${label} keeps selected ids`)
      t.assert((Y.decodeStateVector(enc.encodeStateVector(doc)).get(2) ?? 0) === 0, `${enc.description} ${label} requests the hole`)
    }

    const incremental = new Y.Doc({ gc: false, sparseExactResolution: true })
    enc.applyUpdate(incremental, baseline)
    let updateCount = 0
    /** @type {Y.Transaction|null} */
    let sparseTransaction = null
    incremental.on(enc.updateEventName, () => { updateCount++ })
    incremental.on('afterTransaction', tr => { sparseTransaction = tr })
    enc.applyUpdate(incremental, sparse)
    assertSparse(incremental, 'incremental reload')
    t.assert(updateCount === 1)
    t.assert(Y.equalIdSets(/** @type {Y.Transaction} */ (/** @type {unknown} */ (sparseTransaction)).insertSet, selected.inserts), `${enc.description} transaction ids exclude the envelope`)

    const full = enc.encodeStateAsUpdate(fixture.base)
    const fullReload = new Y.Doc({ gc: false, sparseExactResolution: true })
    enc.applyUpdate(fullReload, full)
    assertSparse(fullReload, 'full reload')
    const fullIds = enc.readUpdateToContentIds(full)
    t.assert(!fullIds.inserts.has(2, 0) && fullIds.inserts.has(2, 1), `${enc.description} full content ids exclude holes`)

    t.fails(() => enc.mergeUpdates([baseline, sparse]))
    const merged = enc.encodeStateAsUpdate(incremental)
    const mergedReload = new Y.Doc({ gc: false, sparseExactResolution: true })
    enc.applyUpdate(mergedReload, merged)
    assertSparse(mergedReload, 'context-compacted reload')

    const baselineDoc = new Y.Doc({ gc: false, sparseExactResolution: true })
    enc.applyUpdate(baselineDoc, baseline)
    const diff = enc.diffUpdate(merged, enc.encodeStateVector(baselineDoc))
    const diffReload = new Y.Doc({ gc: false, sparseExactResolution: true })
    enc.applyUpdate(diffReload, baseline)
    enc.applyUpdate(diffReload, diff)
    assertSparse(diffReload, 'diff reload')

    const earlier = enc.convert(fixture.suggestionUpdates[0])
    enc.applyUpdate(incremental, earlier)
    t.assert(incremental.get('text').toString() === 'aXY', `${enc.description} real content replaces its hole`)
    t.assert(incremental.store.causalHoles.isEmpty())
    t.assert(incremental.store.pendingStructs === null && incremental.store.pendingDs === null)
  })
}

export const testSparseCausalHoleSplitArrivalMatrix = () => {
  const permutations = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0]
  ]
  sparseEncoders.forEach(enc => {
    const fixture = createSplitSparseFixture()
    const sparse = enc.encodeStateAsUpdate(fixture.base)
    const source = enc.convert(fixture.source)
    const sourceRange = fixture.sourceIds.inserts.clients.get(2)?.getIds()[0]
    if (sourceRange === undefined) throw new Error('Missing split source range')

    const residual = new Y.Doc({ gc: false, sparseExactResolution: true })
    enc.applyUpdate(residual, sparse)
    const initialHole = residual.store.getCausalHole(Y.createID(2, sourceRange.clock))
    if (initialHole === null) throw new Error('Missing initial causal hole')
    const expectedLeft = initialHole.slice(sourceRange.clock, 1)
    const expectedRight = initialHole.slice(sourceRange.clock + 2, 1)
    const middle = Y.createIdSet()
    middle.add(2, sourceRange.clock + 1, 1)
    enc.applyUpdate(residual, enc.intersectUpdate(source, Y.createContentIds(middle)))
    const left = residual.store.getCausalHole(Y.createID(2, sourceRange.clock))
    const right = residual.store.getCausalHole(Y.createID(2, sourceRange.clock + 2))
    t.assert(left !== null && right !== null)
    t.assert(sameCausalHoleMetadata(/** @type {CausalHole} */ (left), expectedLeft), `${enc.description} preserves left residual metadata`)
    t.assert(sameCausalHoleMetadata(/** @type {CausalHole} */ (right), expectedRight), `${enc.description} preserves right residual metadata`)
    t.assert(residual.get('text').toString() === 'aYW')
    t.assert((Y.decodeStateVector(enc.encodeStateVector(residual)).get(2) ?? 0) === 0)

    permutations.forEach(order => {
      const target = new Y.Doc({ gc: false, sparseExactResolution: true })
      enc.applyUpdate(target, sparse)
      order.forEach(offset => {
        const selected = Y.createIdSet()
        selected.add(2, sourceRange.clock + offset, 1)
        enc.applyUpdate(target, enc.intersectUpdate(source, Y.createContentIds(selected)))
        t.assert(target.store.pendingStructs === null && target.store.pendingDs === null)
      })
      t.assert(target.get('text').toString() === 'aXYZW', `${enc.description} split order ${order.join('')} converges`)
      t.assert(target.store.causalHoles.isEmpty(), `${enc.description} split order ${order.join('')} replaces every hole`)
      t.assert(Y.decodeStateVector(enc.encodeStateVector(target)).get(2) === 4)
    })

    t.fails(() => enc.mergeUpdates([sparse, source]))
    t.fails(() => enc.mergeUpdates([source, sparse]))
    const realPreferred = new Y.Doc({ gc: false, sparseExactResolution: true })
    enc.applyUpdate(realPreferred, sparse)
    enc.applyUpdate(realPreferred, source)
    t.assert(realPreferred.get('text').toString() === 'aXYZW', `${enc.description} context-aware apply prefers real content`)
    t.assert(realPreferred.store.causalHoles.isEmpty())
  })
}

export const testSparseCausalHoleVirtualAnchorConvergenceMatrix = () => {
  for (const anchorSide of /** @type {const} */ (['origin', 'rightOrigin'])) {
    for (const [sourceClient, concurrentClient] of [[4, 2], [2, 6]]) {
      const fixture = createVirtualAnchorFixture(anchorSide, sourceClient, concurrentClient)
      sparseEncoders.forEach(enc => {
        const canonical = new Y.Doc({ gc: false })
        ;[fixture.baseline, ...fixture.sourceUpdates, fixture.concurrentUpdate].forEach(update => {
          enc.applyUpdate(canonical, enc.convert(update))
        })
        const expected = canonical.get('text').toString()
        const expectedSparse = expected.replace('X', '')
        const sparse = enc.convert(fixture.sparseUpdate)
        const sparseIds = enc.readUpdateToContentIds(sparse)
        t.assert(Y.equalIdSets(sparseIds.inserts, fixture.changes[1].inserts) && Y.equalIdSets(sparseIds.deletes, fixture.changes[1].deletes), `${enc.description} ${anchorSide} sparse ids do not expand`)

        const target = new Y.Doc({ gc: false, sparseExactResolution: true })
        enc.applyUpdate(target, enc.convert(fixture.baseline))
        enc.applyUpdate(target, enc.convert(fixture.concurrentUpdate))
        enc.applyUpdate(target, sparse)
        t.assert(target.get('text').toString() === expectedSparse, `${enc.description} ${anchorSide} sparse order matches canonical projection`)
        t.assert(target.store.pendingStructs === null && target.store.pendingDs === null)

        const reloaded = new Y.Doc({ gc: false, sparseExactResolution: true })
        enc.applyUpdate(reloaded, enc.encodeStateAsUpdate(target))
        t.assert(reloaded.get('text').toString() === expectedSparse, `${enc.description} ${anchorSide} reload preserves virtual placement`)
        enc.applyUpdate(reloaded, enc.convert(fixture.sourceUpdates[0]))

        t.assert(reloaded.get('text').toString() === expected, `${enc.description} ${anchorSide} replacement converges`)
        t.assert(reloaded.store.causalHoles.isEmpty())
        t.assert(reloaded.store.pendingStructs === null && reloaded.store.pendingDs === null)
        assertSparseConvergence(canonical, reloaded, enc, `${enc.description} ${anchorSide}`)
      })
    }
  }
}

export const testSparseCausalHoleInteriorConsumerConvergenceMatrix = () => {
  const fixture = createInteriorConsumerFixture()
  sparseEncoders.forEach(enc => {
    const source = enc.convert(fixture.sourceUpdates[0])
    const sourceStruct = enc.decodeUpdate(source).structs.find(struct => struct.id.client === 2 && struct.id.clock === 0)
    t.assert(sourceStruct?.constructor === Y.Item && sourceStruct.length === 2, `${enc.description} replacement arrives as one unsplit range`)
    const sparse = enc.convert(fixture.sparseUpdate)
    const sparseIds = enc.readUpdateToContentIds(sparse)
    t.assert(Y.equalIdSets(sparseIds.inserts, fixture.selected.inserts) && Y.equalIdSets(sparseIds.deletes, fixture.selected.deletes), `${enc.description} interior selection does not expand`)

    const canonical = new Y.Doc({ gc: false })
    ;[fixture.baseline, ...fixture.sourceUpdates, fixture.concurrentUpdate].forEach(update => {
      enc.applyUpdate(canonical, enc.convert(update))
    })
    t.assert(canonical.get('text').toString() === 'aAlkBmC')

    const sparseDoc = new Y.Doc({ gc: false, sparseExactResolution: true })
    enc.applyUpdate(sparseDoc, enc.convert(fixture.baseline))
    enc.applyUpdate(sparseDoc, enc.convert(fixture.concurrentUpdate))
    enc.applyUpdate(sparseDoc, sparse)
    t.assert(sparseDoc.get('text').toString() === 'alkmC', `${enc.description} interior sparse order matches canonical projection`)

    const reloaded = new Y.Doc({ gc: false, sparseExactResolution: true })
    enc.applyUpdate(reloaded, enc.encodeStateAsUpdate(sparseDoc))
    t.assert(reloaded.get('text').toString() === 'alkmC')
    enc.applyUpdate(reloaded, source)

    t.assert(reloaded.get('text').toString() === 'aAlkBmC', `${enc.description} unsplit replacement converges`)
    t.assert(reloaded.store.causalHoles.isEmpty())
    t.assert(reloaded.store.pendingStructs === null && reloaded.store.pendingDs === null)
    const first = reloaded.store.getStruct(Y.createID(2, 0))
    const second = reloaded.store.getStruct(Y.createID(2, 1))
    t.assert(first?.constructor === Y.Item && first.length === 1 && second?.constructor === Y.Item && second.length === 1, `${enc.description} replacement splits at virtual consumers`)
    assertSparseConvergence(canonical, reloaded, enc, `${enc.description} interior consumers`)
  })
}

export const testSparseCausalHoleLargeRangeCoalescing = () => {
  const length = 100000
  const base = new Y.Doc({ gc: false, sparseExactResolution: true })
  base.clientID = 1
  base.get('text').insert(0, 'a')
  const suggestion = Y.cloneDoc(base, { gc: false, isSuggestionDoc: true, sparseExactResolution: true })
  suggestion.clientID = 2
  const renderer = Y.createDiffRenderer(base, suggestion)
  suggestion.get('text').insert(1, 'X'.repeat(length - 1) + 'Z')
  const selected = Y.createIdSet()
  selected.add(2, length - 1, 1)
  /** @type {Uint8Array<ArrayBuffer>|null} */
  let sparse = null
  base.on('update', update => { sparse = update })
  renderer.resolveContentIds(Y.createContentIds(selected), 'accept', {})
  const v1 = /** @type {Uint8Array<ArrayBuffer>} */ (/** @type {unknown} */ (sparse))

  ;[
    Y.decodeUpdate(v1).structs,
    Y.decodeUpdateV2(Y.convertUpdateFormatV1ToV2(v1)).structs
  ].forEach(structs => {
    const holes = structs.filter(struct => struct.constructor === CausalHole)
    t.assert(holes.length === 1)
    t.assert(holes[0].id.clock === 0 && holes[0].length === length - 1)
  })
  t.assert(base.get('text').toString() === 'aZ')
  t.assert(base.store.causalHoles.clients.get(2)?.getIds().length === 1)
  t.assert(base.store.pendingStructs === null && base.store.pendingDs === null)
}

/**
 * @param {t.TestCase} tc
 */
export const testKeyEncoding = tc => {
  const { users, text0, text1 } = init(tc, { users: 2 })

  text0.insert(0, 'a', { italic: true })
  text0.insert(0, 'b')
  text0.insert(0, 'c', { italic: true })

  const update = Y.encodeStateAsUpdateV2(users[0])
  Y.applyUpdateV2(users[1], update)

  const c = text1.toDelta()
  t.compare(
    c,
    delta.create()
      .insert('c', { italic: true })
      .insert('b')
      .insert('a', { italic: true })
      .done()
  )

  compare(users)
}

/**
 * @param {Y.Doc} ydoc
 * @param {Array<Uint8Array<ArrayBuffer>>} updates - expecting at least 4 updates
 * @param {Enc} enc
 * @param {boolean} hasDeletes
 */
const checkUpdateCases = (ydoc, updates, enc, hasDeletes) => {
  const cases = []
  // Case 1: Simple case, simply merge everything
  cases.push(enc.mergeUpdates(updates))

  // Case 2: Overlapping updates
  cases.push(enc.mergeUpdates([
    enc.mergeUpdates(updates.slice(2)),
    enc.mergeUpdates(updates.slice(0, 2))
  ]))

  // Case 3: Overlapping updates
  cases.push(enc.mergeUpdates([
    enc.mergeUpdates(updates.slice(2)),
    enc.mergeUpdates(updates.slice(1, 3)),
    updates[0]
  ]))

  // Case 4: Separated updates (containing skips)
  cases.push(enc.mergeUpdates([
    enc.mergeUpdates([updates[0], updates[2]]),
    enc.mergeUpdates([updates[1], updates[3]]),
    enc.mergeUpdates(updates.slice(4))
  ]))

  // Case 5: overlapping with many duplicates
  cases.push(enc.mergeUpdates(cases))

  // const targetState = enc.encodeStateAsUpdate(ydoc)
  // t.info('Target State: ')
  // enc.logUpdate(targetState)

  cases.forEach((mergedUpdates, i) => {
    t.info(`State Case $${i} (${enc.description}):`)
    // enc.logUpdate(updates)
    const merged = new Y.Doc({ gc: false })
    enc.applyUpdate(merged, mergedUpdates)
    t.compareArrays(merged.get().toArray(), ydoc.get().toArray())
    t.compare(enc.encodeStateVector(merged), enc.encodeStateVectorFromUpdate(mergedUpdates))
    if (enc.updateEventName !== 'update') { // @todo should this also work on legacy updates?
      for (let j = 1; j < updates.length; j++) {
        const partMerged = enc.mergeUpdates(updates.slice(j))
        const partMeta = enc.readUpdateToContentIds(partMerged)
        const targetSV = enc.encodeStateVectorFromUpdate(enc.mergeUpdates(updates.slice(0, j)))
        const diffed = enc.diffUpdate(mergedUpdates, targetSV)
        const diffedMeta = enc.readUpdateToContentIds(diffed)
        t.compare(partMeta.inserts, diffedMeta.inserts)
        {
          // We can'd do the following
          //  - t.compare(diffed, mergedDeletes)
          // because diffed contains the set of all deletes.
          // So we add all deletes from `diffed` to `partDeletes` and compare then
          const decoder = decoding.createDecoder(diffed)
          const updateDecoder = new UpdateDecoderV2(decoder)
          readBlockSet(updateDecoder)
          const ds = readIdSet(updateDecoder)
          const updateEncoder = new UpdateEncoderV2()
          encoding.writeVarUint(updateEncoder.restEncoder, 0) // 0 structs
          writeIdSet(updateEncoder, ds)
          const deletesUpdate = updateEncoder.toUint8Array()
          const mergedDeletes = Y.mergeUpdatesV2([deletesUpdate, partMerged])
          if (!hasDeletes || enc !== encDoc) {
            // deletes will almost definitely lead to different encoders because of the mergeStruct feature that is present in encDoc
            t.compare(diffed, mergedDeletes)
          }
        }
      }
    }
    const meta = enc.readUpdateToContentIds(mergedUpdates)
    meta.inserts.clients.forEach(range => { t.assert(range.getIds()[0].clock === 0) })
    meta.inserts.clients.forEach((range, client) => {
      const structs = /** @type {Array<Y.Item>} */ (merged.store.clients.get(client))
      const lastStruct = structs[structs.length - 1]
      const lastIdRange = array.last(range.getIds())
      t.assert(lastStruct.id.clock + lastStruct.length === lastIdRange.clock + lastIdRange.len)
    })
  })
}

/**
 * @param {t.TestCase} _tc
 */
export const testMergeUpdates1 = _tc => {
  encoders.forEach((enc) => {
    t.info(`Using encoder: ${enc.description}`)
    const ydoc = new Y.Doc({ gc: false })
    const updates = /** @type {Array<Uint8Array<ArrayBuffer>>} */ ([])
    ydoc.on(enc.updateEventName, update => { updates.push(update) })
    const array = ydoc.get()
    array.insert(0, [1])
    array.insert(0, [2])
    array.insert(0, [3])
    array.insert(0, [4])
    checkUpdateCases(ydoc, updates, enc, false)
  })
}

/**
 * @param {t.TestCase} _tc
 */
export const testMergeUpdates2 = _tc => {
  encoders.forEach((enc, _i) => {
    t.info(`Using encoder: ${enc.description}`)
    const ydoc = new Y.Doc({ gc: false })
    const updates = /** @type {Array<Uint8Array<ArrayBuffer>>} */ ([])
    ydoc.on(enc.updateEventName, update => { updates.push(update) })
    const array = ydoc.get()
    array.insert(0, [1, 2])
    array.delete(1, 1)
    array.insert(0, [3, 4])
    array.delete(1, 2)
    checkUpdateCases(ydoc, updates, enc, true)
  })
}

/**
 * @param {t.TestCase} _tc
 */
export const testMergeUpdatesStressTest = _tc => {
  const N = 100
  const M = 100
  encoders.forEach((enc, _i) => {
    t.info(`Using encoder: ${enc.description}`)
    const ydoc = new Y.Doc({ gc: false })
    const updates = /** @type {Array<Uint8Array<ArrayBuffer>>} */ ([])
    ydoc.on(enc.updateEventName, update => { updates.push(update) })
    const array = ydoc.get()
    for (let clientid = 0; clientid < N; clientid++) {
      ydoc.clientID = clientid
      for (let i = 0; i < M; i++) {
        array.push([i])
      }
    }
    t.measureTime('merge via Y.mergeUpdates', () => {
      enc.mergeUpdates(updates)
    })
    t.measureTime('merge via Y.applyUpdate on Y.Doc', () => {
      const ydoc = new Y.Doc()
      updates.forEach(update => {
        enc.applyUpdate(ydoc, update)
      })
    })
  })
}

/**
 * @param {t.TestCase} _tc
 */
export const testMergePendingUpdates = _tc => {
  const yDoc = new Y.Doc()
  /**
   * @type {Array<Uint8Array>}
   */
  const serverUpdates = []
  yDoc.on('update', (update, _origin, _c) => {
    serverUpdates.splice(serverUpdates.length, 0, update)
  })
  const yText = yDoc.get('textBlock')
  yText.applyDelta(delta.create().insert('r').done())
  yText.applyDelta(delta.create().insert('o').done())
  yText.applyDelta(delta.create().insert('n').done())
  yText.applyDelta(delta.create().insert('e').done())
  yText.applyDelta(delta.create().insert('n').done())

  const yDoc1 = new Y.Doc()
  Y.applyUpdate(yDoc1, serverUpdates[0])
  const update1 = Y.encodeStateAsUpdate(yDoc1)

  const yDoc2 = new Y.Doc()
  Y.applyUpdate(yDoc2, update1)
  Y.applyUpdate(yDoc2, serverUpdates[1])
  const update2 = Y.encodeStateAsUpdate(yDoc2)

  const yDoc3 = new Y.Doc()
  Y.applyUpdate(yDoc3, update2)
  Y.applyUpdate(yDoc3, serverUpdates[3])
  const update3 = Y.encodeStateAsUpdate(yDoc3)

  const yDoc4 = new Y.Doc()
  Y.applyUpdate(yDoc4, update3)
  Y.applyUpdate(yDoc4, serverUpdates[2])
  const update4 = Y.encodeStateAsUpdate(yDoc4)

  const yDoc5 = new Y.Doc()
  Y.applyUpdate(yDoc5, update4)
  Y.applyUpdate(yDoc5, serverUpdates[4])
  Y.encodeStateAsUpdate(yDoc5)

  const yText5 = yDoc5.get('textBlock')
  t.compareStrings(yText5.toString(), 'nenor')
}

/**
 * @param {t.TestCase} _tc
 */
export const testObfuscateUpdates = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.get('text')
  const ymap = ydoc.get('map')
  const yarray = ydoc.get('array')
  // test ytext
  ytext.applyDelta(delta.create().insert('text', { bold: true }).insert([{ href: 'supersecreturl' }]).done())
  // test ymap
  ymap.setAttr('key', 'secret1')
  ymap.setAttr('key', 'secret2')
  // test yarray with subtype & subdoc
  const subtype = new Y.Type('secretnodename')
  const subdoc = new Y.Doc({ guid: 'secret' })
  subtype.setAttr('attr', 'val')
  yarray.insert(0, ['teststring', 42, subtype, subdoc])
  // obfuscate the content and put it into a new document
  const obfuscatedUpdate = Y.obfuscateUpdate(Y.encodeStateAsUpdate(ydoc))
  const odoc = new Y.Doc()
  Y.applyUpdate(odoc, obfuscatedUpdate)
  const otext = odoc.get('text')
  const omap = odoc.get('map')
  const oarray = odoc.get('array')
  // test ytext
  const d = /** @type {any} */ (otext.toDelta().toJSON().children)
  t.assert(d.length === 2)
  t.assert(d[0].insert !== 'text' && d[0].insert.length === 4)
  t.assert(object.length(d[0].format) === 1)
  t.assert(!object.hasProperty(d[0].format, 'bold'))
  t.assert(object.length(d[1].insert) === 1)
  t.assert(object.hasProperty(d[1], 'insert'))
  // test ymap
  t.assert(omap.attrSize === 1)
  t.assert(!omap.hasAttr('key'))
  // test yarray with subtype & subdoc
  const result = oarray.toArray()
  t.assert(result.length === 4)
  t.assert(result[0] !== 'teststring')
  t.assert(result[1] !== 42)
  const osubtype = /** @type {Y.Type} */ (result[2])
  const osubdoc = result[3]
  // test subtype
  t.assert(osubtype.name !== subtype.name)
  t.assert(object.length(osubtype.getAttrs()) === 1)
  t.assert(osubtype.getAttr('attr') === undefined)
  // test subdoc
  t.assert(osubdoc.guid !== subdoc.guid)
}

export const testIntersectDoc = () => {
  const ydoc = new Y.Doc()
  ydoc.get().setAttr('k', 1)
  const c1 = Y.createContentIdsFromDoc(ydoc)
  ydoc.get().setAttr('k', 2)

  const v1 = Y.intersectUpdateWithContentIds(Y.encodeStateAsUpdate(ydoc), c1)
  const y1 = new Y.Doc()
  Y.applyUpdate(y1, v1)
  t.assert(ydoc.get().getAttr('k'))
}

/**
 * Selecting a sparse mid-stream range of content-ids must not drop the selection
 * just because earlier structs of the same client were not selected.
 *
 * @see https://github.com/yjs/yjs/issues/781
 */
export const testIntersectSparseContentIds = () => {
  const src = new Y.Doc()
  src.transact(() => {
    const m = src.get('m')
    for (let i = 0; i < 10; i++) m.setAttr(`k${i}`, i) // clocks 0..9, single client
  })
  const update = Y.encodeStateAsUpdate(src)
  const cids = Y.createContentIdsFromUpdate(update)
  /**
   * @type {number}
   */
  let client = 0
  cids.inserts.clients.forEach((_r, c) => { client = c })

  // Select ONLY clocks [5, 7) — a mid-stream range.
  const sel = Y.createIdSet()
  sel.add(client, 5, 2)
  const chunk = Y.intersectUpdateWithContentIds(update, {
    inserts: sel,
    deletes: Y.createIdSet()
  })
  // Each map key is a separate length-1 item, so clocks [5,7) yield two structs.
  const structs = Y.decodeUpdate(chunk).structs.filter(s => !(s instanceof Y.Skip))
  t.assert(structs.every(s => s.id.client === client))
  t.compare(structs.map(s => [s.id.clock, s.length]), [[5, 1], [6, 1]])

  // A selection split across a gap must round-trip both ranges with a Skip in between.
  const sel2 = Y.createIdSet()
  sel2.add(client, 1, 2) // clocks 1,2
  sel2.add(client, 7, 1) // clock 7
  const chunk2 = Y.intersectUpdateWithContentIds(update, {
    inserts: sel2,
    deletes: Y.createIdSet()
  })
  const structs2 = Y.decodeUpdate(chunk2).structs.filter(s => !(s instanceof Y.Skip))
  t.compare(structs2.map(s => [s.id.clock, s.length]), [[1, 1], [2, 1], [7, 1]])

  // A full-coverage selection must round-trip byte-identically to the source update.
  const selAll = Y.createIdSet()
  cids.inserts.clients.forEach((ranges, c) => {
    ranges.getIds().forEach(r => selAll.add(c, r.clock, r.len))
  })
  const chunkAll = Y.intersectUpdateWithContentIds(update, {
    inserts: selAll,
    deletes: Y.createIdSet()
  })
  t.compare(chunkAll, update)
}
