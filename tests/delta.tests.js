import * as Y from '../src/index.js'
import * as delta from 'lib0/delta'
import * as t from 'lib0/testing'
import * as s from 'lib0/schema'
import { ContentAny, ContentString, ContentType, Item } from '../src/structs/Item.js'
import { IdRanges, IdSet, reservedMutationIdSetRuntime } from '../src/utils/ids.js'
import { cloneRendererContentAttribute } from '../src/utils/renderer-helpers.js'
import { IdSetEncoderV1, UpdateEncoderV1, UpdateEncoderV2 } from '../src/utils/UpdateEncoder.js'

/**
 * Delta is a versatile format enabling you to efficiently describe changes. It is part of lib0, so
 * that non-yjs applications can use it without consuming the full Yjs package. It is well suited
 * for efficiently describing state & changesets.
 *
 * Assume we start with the text "hello world". Now we want to delete " world" and add an
 * exclamation mark. The final content should be "hello!" ("hello world" => "hello!")
 *
 * In most editors, you would describe the necessary changes as replace operations using indexes.
 * However, this might become ambiguous when many changes are involved.
 *
 * - delete range 5-11
 * - insert "!" at position 11
 *
 * Using the delta format, you can describe the changes similar to what you would do in an text editor.
 * The "|" describes the current cursor position.
 *
 * - d.retain(5) - "|hello world" => "hello| world" - jump over the next five characters
 * - d.delete(6) - "hello| world" => "hello|" - delete the next 6 characres
 * - d.insert('!') - "hello!|" - insert "!" at the current position
 * => compact form: d.retain(5).delete(6).insert('!')
 *
 * You can also apply the changes in two distinct steps and then rebase the op so that you can apply
 * them in two distinct steps.
 * - delete " world":              d1 = delta.create().retain(5).delete(6)
 * - insert "!":                   d2 = delta.create().retain(11).insert('!')
 * - rebase d2 on-top of d1:       d2.rebase(d1)    == delta.create().retain(5).insert('!')
 * - merge into a single change:   d1.apply(d2)     == delta.create().retain(5).delete(6).insert(!)
 *
 * @param {t.TestCase} _tc
 */
export const testDeltaBasics = _tc => {
  // the state of our text document
  const state = delta.create().insert('hello world')
  // describe changes: delete " world" & insert "!"
  const change = delta.create().retain(5).delete(6).insert('!')
  // apply changes to state
  state.apply(change)
  // compare state to expected state
  t.assert(state.equals(delta.create().insert('hello!').done()))
}

/**
 * lib0 also ships a schema library that can be used to validate JSON objects and custom data types,
 * like Yjs types.
 *
 * As a convention, schemas are usually prefixed with a $ sign. This clarifies the difference
 * between a schema, and an instance of a schema.
 *
 * const $myobj = s.$object({ key: s.$number })
 * let inputValue: any
 * if ($myobj.check(inputValue)) {
 *   inputValue // is validated and of type $myobj
 * }
 *
 * We can also define the expected values on a delta.
 *
 * @param {t.TestCase} _tc
 */
export const testDeltaBasicSchema = _tc => {
  const $d = delta.$delta({ attrs: { key: s.$string }, children: s.$number, text: false })
  const d = delta.create($d)
  // @ts-expect-error
  d.setAttr('key', false) // invalid change: will throw a type error
  t.fails(() => {
    // @ts-expect-error
    d.apply(delta.create().setAttr('key', false)) // invalid delta: will throw a type error
  })
}

/**
 * Deltas can describe changes on attributes and children. Textual insertions are children. But we
 * may also insert json-objects and other deltas as children.
 * Key-value pairs can be represented as attributes. This "convoluted" changeset enables us to
 * describe many changes in the same breath:
 *
 * delta.create().setAttr('a', 42).retain(5).delete(6).insert('!').deleteAttr('b')
 *
 * @param {t.TestCase} _tc
 */
export const testDeltaValues = _tc => {
  const change = delta.create().setAttr('a', 42).deleteAttr('b').retain(5).delete(6).insert('!').insert([{ my: 'custom object' }])
  // iterate through attribute changes
  for (const attrChange of change.attrs) {
    if (delta.$insertOp.check(attrChange)) {
      console.log(`set ${attrChange.key} to ${attrChange.value}`)
    } else if (delta.$deleteOp.check(attrChange)) {
      console.log(`delete ${attrChange.key}`)
    }
  }
  // iterate through child changes
  for (const childChange of change.children) {
    if (delta.$retainOp.check(childChange)) {
      console.log(`retain ${childChange.retain} child items`)
    } else if (delta.$deleteOp.check(childChange)) {
      console.log(`delete ${childChange.delete} child items`)
    } else if (delta.$insertOp.check(childChange)) {
      console.log('insert child items:', childChange.insert)
    } else if (delta.$textOp.check(childChange)) {
      console.log('insert textual content', childChange.insert)
    }
  }
}

/**
 * The new delta defines changes on attributes (key-value) and child elements (list & text), but can
 * also be used to describe the current state of a document.
 *
 * 1. apply a delta to change a yjs type
 * 2. observe deltas to read the differences
 * 3. merge deltas to reflect multiple changes in a single delta
 * 4. All Yjs types fully support the delta format. It is no longer necessary to define the type (such as Y.Array)
 *
 * @param {t.TestCase} _tc
 */
export const testBasics = _tc => {
  const ydoc = new Y.Doc()
  const ytype = ydoc.get('my data')
  /**
   * @type {delta.Delta<{attrs: { a: number }, children: { my: string }, text: true }>}
   */
  let observedDelta = delta.create()
  ytype.observe(event => {
    observedDelta = event.deltaDeep
    console.log('ytype changed:', observedDelta.toJSON())
  })
  // define a change: set attribute: a=42
  const attrChange = delta.create().setAttr('a', 42).done()
  // define a change: insert textual content and an object
  const childChange = delta.create().insert('hello').insert([{ my: 'object' }]).done()
  // merge changes
  const mergedChanges = delta.create(delta.$deltaAny)
  mergedChanges.apply(attrChange)
  mergedChanges.apply(childChange).done()
  console.log('merged changes: ', mergedChanges.toJSON())
  ytype.applyDelta(mergedChanges)
  // the observed change should equal the applied change
  t.assert(observedDelta.equals(mergedChanges))
  // read the current state of the yjs types as a delta
  const currState = ytype.toDeltaDeep()
  t.assert(currState.equals(mergedChanges)) // equal to the changes that we applied
}

export const testDeltaPartialDeleteKeepsSearchMarkerAligned = () => {
  const doc = new Y.Doc()
  doc.clientID = 1
  const type = doc.get('content')
  type.insert(0, [0, 1, 2, 3])
  doc.clientID = 2
  const tail = new Y.Type()
  type.insert(4, [tail])
  t.assert(type.get(4) === tail)

  type.delete(1, 1)

  t.compareArrays(type.toArray(), [0, 2, 3, tail])
  t.assert(type.get(3) === tail, 'partial item splits keep search-marker indexes aligned')
}

/**
 * Deltas allow us to describe the differences between two Yjs documents though "Attributions".
 *
 * - We can attribute changes to a user, or a group of users
 * - There are 'insert', 'delete', and 'format' attributions
 * - When we render attributions, we render inserted & deleted content as an insertions with special
 *   attributes which allow you to..
 * -- Render deleted content using a strikethrough: I.e. `hello w̶o̶r̶l̶d̶!`
 * -- Render attributed insertions using a background color.
 *
 * @param {t.TestCase} _tc
 */
export const testAttributions = _tc => {
  const ydocV1 = new Y.Doc()
  const ytypeV1 = ydocV1.get('txt')
  ytypeV1.applyDelta(delta.create().insert('hello world').done())
  // create a new version with updated content
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(ydocV1))
  const ytype = ydoc.get('txt')
  // delete " world" and insert exclamation mark "!".
  ytype.applyDelta(delta.create().retain(5).delete(6).insert('!').done())
  const renderer = Y.createDiffRenderer(ydocV1, ydoc)
  // get the attributed differences
  const attributedContent = ytype.toDelta({ renderer })
  console.log('attributed content', attributedContent.toJSON())
  t.assert(attributedContent.equals(delta.create().insert('hello').insert(' world', null, { delete: [] }).insert('!', null, { insert: [] }).done()))
  // for editor bindings, it is also necessary to observe changes and get the attributed changes
  ytype.observe(event => {
    const attributedChange = event.getDelta({ renderer })
    console.log('the attributed change', attributedChange.toJSON())
    t.assert(attributedChange.done().equals(delta.create().retain(11).insert('!', null, { insert: [] }).done()))
    const unattributedChange = event.delta
    console.log('the UNattributed change', unattributedChange.toJSON())
    t.assert(unattributedChange.equals(delta.create().retain(5).insert('!').done()))
  })
  /**
   * Content now has different representations.
   * - The UNattributed representation renders the latest state, without history.
   * - The attributed representation renders the differences.
   *
   * Attributed: 'hello<delete> world</delete><insert>!</insert>'
   * UNattributed: 'world!'
   */
  // Apply a change to the attributed content
  ytype.applyDelta(delta.create().retain(11).insert('!').done(), null, { renderer })
  // // Equivalent to applying a change to the UNattributed content:
  // ytype.applyDelta(delta.create().retain(5).insert('!'))
}

/**
 * @param {() => any} run
 * @param {string} name
 */
const assertNamedFailure = (run, name) => {
  /** @type {any} */
  let failure = null
  try {
    run()
  } catch (error) {
    failure = error
  }
  t.assert(failure !== null && failure.name === name, `expected ${name}, got ${failure?.name ?? 'no failure'}`)
}

/**
 * @param {{
 *   inserts: readonly {client:number,clock:number,length:number}[],
 *   deletes: readonly {client:number,clock:number,length:number}[],
 *   rangeCount: number
 * }} content
 * @param {{rangeCountUpperBound:number}} reservation
 */
const assertReservedContent = (content, reservation) => {
  t.assert(content.rangeCount === content.inserts.length + content.deletes.length)
  t.assert(content.rangeCount <= reservation.rangeCountUpperBound)
  for (const ranges of [content.inserts, content.deletes]) {
    for (let index = 0; index < ranges.length; index++) {
      const range = ranges[index]
      t.assert(range.length > 0 && Object.isFrozen(range))
      if (index > 0) {
        const previous = ranges[index - 1]
        t.assert(previous.client < range.client || (previous.client === range.client && previous.clock + previous.length < range.clock))
      }
    }
  }
  t.assert(Object.isFrozen(content) && Object.isFrozen(content.inserts) && Object.isFrozen(content.deletes))
}

/** @param {delta.DeltaBuilder<any>} mutation */
const appendUnsupportedChild = mutation => {
  const children = /** @type {any} */ (mutation.children)
  const unsupported = { clone: () => unsupported, next: null, prev: children.end }
  children.end.next = unsupported
  children.end = unsupported
  children.len++
  mutation.childCnt++
  return mutation
}

/** @param {() => any} run */
const withPoisonedDeltaDispatch = run => {
  const listPrototype = Object.getPrototypeOf(delta.create().children)
  const targets = [
    [listPrototype, Symbol.iterator],
    ...[delta.$deltaAny, delta.$textOp, delta.$insertOp, delta.$retainOp, delta.$deleteOp, delta.$modifyOp, delta.$setAttrOp, delta.$deleteAttrOp, delta.$modifyAttrOp].map(schema => [schema, 'check']),
    ...['insert', 'delete', 'retain', 'modify', 'setAttr', 'deleteAttr', 'modifyAttr', 'useFormats', 'useAttribution', 'done', 'isEmpty'].map(key => [delta.DeltaBuilder.prototype, key])
  ]
  const descriptors = targets.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key))
  try {
    for (let index = 0; index < targets.length; index++) {
      const [target, key] = targets[index]
      Object.defineProperty(target, key, {
        configurable: true,
        value: () => { throw new Error('mutable lib0 delta dispatch') },
        writable: true
      })
    }
    return run()
  } finally {
    for (let index = targets.length - 1; index >= 0; index--) {
      const [target, key] = targets[index]
      const descriptor = descriptors[index]
      if (descriptor === undefined) Reflect.deleteProperty(target, key)
      else Object.defineProperty(target, key, descriptor)
    }
  }
}

export const testReservedDeltaMutationAtomicCapture = () => {
  const doc = new Y.Doc()
  doc.clientID = 11
  const type = doc.get('content')
  const payload = { nested: { value: 'owned' } }
  const bold = { author: 'owned' }
  const mutation = delta.create().insert('abc', { bold }).setAttr('payload', payload)
  const origin = { lane: 'reserved' }
  let updates = 0
  let observed = 0
  let updateOrigin = null
  doc.on('update', (_update, observedOrigin) => {
    updates++
    updateOrigin = observedOrigin
  })
  type.observe(() => { observed++ })

  const prepared = type.reserveDeltaMutation(mutation, origin)
  t.assert(updates === 0 && observed === 0, 'preparation is read-only')
  t.assert(Object.isFrozen(prepared) && Object.isFrozen(prepared.reservation))
  payload.nested.value = 'mutated'
  bold.author = 'mutated'
  mutation.insert('late')

  /** @type {any} */
  let exact = null
  const fix = prepared.apply({
    afterMutation: content => {
      exact = content
      type.setAttr('ledger', 'same transaction')
    }
  })
  t.assert(fix === null)
  const rendered = /** @type {any} */ (type.toDeltaDeep().toJSON())
  t.assert(rendered.children.length === 1 && rendered.children[0].insert === 'abc', 'the prepared capability owns the original delta shape')
  t.assert(type.getAttr('payload').nested.value === 'owned', 'attribute values are de-aliased')
  t.assert(rendered.children[0].format.bold.author === 'owned', 'formats are de-aliased')
  t.assert(type.getAttr('ledger') === 'same transaction')
  t.assert(updates === 1 && observed === 1 && updateOrigin === origin, 'executor and callback share one update/event/origin')
  assertReservedContent(exact, prepared.reservation)
  t.assert(exact.inserts.length === 1 && exact.deletes.length === 0)
  t.assert(exact.inserts[0].client === 11 && exact.inserts[0].clock === 0)
  t.assert(exact.inserts[0].length + 1 === doc.store.getClock(11), 'callback allocation is excluded from exact content')
  t.assert(Reflect.set(exact.inserts[0], 'clock', 42) === false)
  t.assert(Reflect.set(prepared.reservation, 'rangeCountUpperBound', 0) === false)
  assertNamedFailure(() => prepared.apply(), 'DeltaMutationCapabilityError')
  assertNamedFailure(() => prepared.discard(), 'DeltaMutationCapabilityError')
}

export const testReservedDeltaMutationExactOperations = () => {
  /**
   * @param {(type:Y.Type) => void} initialize
   * @param {(type:Y.Type) => delta.DeltaAny} createMutation
   */
  const run = (initialize, createMutation) => {
    const doc = new Y.Doc()
    doc.clientID = 21
    const type = doc.get('content')
    initialize(type)
    const prepared = type.reserveDeltaMutation(createMutation(type))
    /** @type {any} */
    let exact = null
    prepared.apply({ afterMutation: content => { exact = content } })
    assertReservedContent(exact, prepared.reservation)
    return exact
  }

  let exact = run(() => {}, () => delta.create().insert('abc').done())
  t.assert(exact.inserts.length === 1 && exact.deletes.length === 0)
  exact = run(type => type.applyDelta(delta.create().insert('abc').done()), () => delta.create().delete(3).done())
  t.assert(exact.inserts.length === 0 && exact.deletes.length === 1 && exact.deletes[0].length === 3)
  exact = run(type => type.applyDelta(delta.create().insert('abc').done()), () => delta.create().retain(1).delete(2).insert('XY').done())
  t.assert(exact.inserts.length === 1 && exact.deletes.length === 1)
  exact = run(type => type.applyDelta(delta.create().insert('abc').done()), () => delta.create().retain(3, { bold: {} }).done())
  t.assert(exact.inserts.length === 1 && exact.inserts[0].length === 2 && exact.deletes.length === 0)
  exact = run(type => type.applyDelta(delta.create().insert('abc').done()), () => delta.create().insert('x').delete(1).done())
  t.assert(exact.inserts.length === 1 && exact.deletes.length === 1, 'insert-then-delete never deletes fresh IDs')
  exact = run(type => type.setAttr('key', { old: true }), () => delta.create().setAttr('key', { next: true }).done())
  t.assert(exact.inserts.length === 1 && exact.deletes.length === 1)
  exact = run(type => type.setAttr('key', { old: true }), () => delta.create().deleteAttr('key').done())
  t.assert(exact.inserts.length === 0 && exact.deletes.length === 1)

  exact = run(type => {
    const title = new Y.Type()
    title.applyDelta(delta.create().insert('title').done())
    type.applyDelta(delta.create().insert([delta.create('p').insert('abc').done()]).setAttr('title', title).done())
  }, () => delta.create()
    .modify(delta.create().retain(1).delete(1).insert('X'))
    .modifyAttr('title', delta.create().retain(1).delete(2).insert('Q'))
    .done())
  t.assert(exact.inserts.length === 1 && exact.deletes.length >= 1, 'nested modify and modifyAttr share the fresh range')

  exact = run(type => {
    const nested = new Y.Type()
    nested.applyDelta(delta.create().insert('child').done())
    type.setAttr('nested', nested)
  }, () => delta.create().setAttr('nested', { replacement: true }).done())
  t.assert(exact.inserts.length === 1 && exact.deletes.length === 1, 'map replacement captures the nested descendants')
}

export const testReservedDeltaMutationAuthorityAndStaleness = () => {
  assertNamedFailure(
    () => new Y.Type().reserveDeltaMutation(delta.create().insert('x').done()),
    'DeltaMutationPreparationError'
  )
  const doc = new Y.Doc()
  const type = doc.get('content')
  assertNamedFailure(() => type.reserveDeltaMutation(delta.create().done()), 'DeltaMutationPreparationError')
  doc.transact(() => {
    assertNamedFailure(() => type.reserveDeltaMutation(delta.create().insert('x').done()), 'DeltaMutationPreparationError')
  })

  const discarded = type.reserveDeltaMutation(delta.create().insert('discarded').done())
  discarded.discard()
  assertNamedFailure(() => discarded.apply(), 'DeltaMutationCapabilityError')
  const forged = Object.create(Object.getPrototypeOf(discarded))
  assertNamedFailure(() => forged.apply(), 'DeltaMutationCapabilityError')
  const serialized = JSON.parse(JSON.stringify(discarded))
  t.assert(typeof serialized.apply === 'undefined' && type.toString() === '')

  let updates = 0
  doc.on('update', () => { updates++ })
  const stale = type.reserveDeltaMutation(delta.create().insert('reserved').done())
  type.applyDelta(delta.create().insert('external').done())
  const beforeStale = updates
  assertNamedFailure(() => stale.apply(), 'DeltaMutationStaleError')
  t.assert(updates === beforeStale && type.toString() === 'external')

  const deleteDoc = new Y.Doc()
  const deleteType = deleteDoc.get('content')
  deleteType.applyDelta(delta.create().insert('abc').done())
  const deletionStale = deleteType.reserveDeltaMutation(delta.create().insert('reserved').done())
  deleteType.applyDelta(delta.create().delete(1).done())
  assertNamedFailure(() => deletionStale.apply(), 'DeltaMutationStaleError')

  const unrelated = new Y.Doc()
  const unaffected = type.reserveDeltaMutation(delta.create().insert('ok').done())
  unrelated.get('content').applyDelta(delta.create().insert('unrelated').done())
  unaffected.apply()
  t.assert(type.toString() === 'okexternal', 'unrelated documents do not stale a capability')

  const base = new Y.Doc()
  base.get('content').applyDelta(delta.create().insert('base').done())
  const suggestion = Y.cloneDoc(base)
  const renderer = Y.createDiffRenderer(base, suggestion)
  const renderedType = suggestion.get('content')
  const rendererStale = renderedType.reserveDeltaMutation(delta.create().insert('x').done(), null, { renderer })
  base.get('content').applyDelta(delta.create().insert('changed').done())
  assertNamedFailure(() => rendererStale.apply(), 'DeltaMutationStaleError')
  const destroyedRenderer = Y.createDiffRenderer(base, suggestion)
  const destroyedStale = renderedType.reserveDeltaMutation(delta.create().insert('x').done(), null, { renderer: destroyedRenderer })
  destroyedRenderer.destroy()
  assertNamedFailure(() => destroyedStale.apply(), 'DeltaMutationStaleError')
  assertNamedFailure(
    () => renderedType.reserveDeltaMutation(delta.create().insert('x').done(), null, { renderer: new Y.TwosetRenderer(Y.createIdMap(), Y.createIdMap()) }),
    'DeltaMutationPreparationError'
  )
  assertNamedFailure(
    () => renderedType.reserveDeltaMutation(delta.create().insert('x').done(), null, { renderer: Y.createSnapshotRenderer(Y.snapshot(base)) }),
    'DeltaMutationPreparationError'
  )
}

export const testReservedDeltaMutationAdmissionFailures = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  let updates = 0
  doc.on('update', () => { updates++ })
  /** @type {any} */
  const cyclic = {}
  cyclic.self = cyclic
  const unsafe = delta.create().insert('must not partially apply').setAttr('cyclic', cyclic)
  assertNamedFailure(() => type.reserveDeltaMutation(unsafe), 'DeltaMutationPreparationError')
  t.assert(updates === 0 && type.toString() === '' && type.getAttr('cyclic') === undefined, 'cyclic payload fails before any executor write')
  const lyingEmpty = delta.create()
  Object.defineProperty(lyingEmpty, 'isEmpty', { value: () => false })
  assertNamedFailure(() => type.reserveDeltaMutation(lyingEmpty), 'DeltaMutationPreparationError')
  t.assert(updates === 0 && type.toDeltaDeep().isEmpty(), 'owned emptiness cannot be bypassed by mutable dispatch')

  const unsupportedChild = appendUnsupportedChild(delta.create().insert('must not partially apply'))
  assertNamedFailure(() => type.reserveDeltaMutation(unsupportedChild), 'DeltaMutationPreparationError')
  const unsupportedNested = appendUnsupportedChild(delta.create().insert('nested partial write'))
  const nestedMutation = /** @type {delta.DeltaBuilder<any>} */ (delta.create())
  nestedMutation.insert('outer partial write').insert([unsupportedNested])
  assertNamedFailure(
    () => type.reserveDeltaMutation(nestedMutation),
    'DeltaMutationPreparationError'
  )
  const unsupportedAttr = delta.create().insert('must not partially apply')
  Object.defineProperty(unsupportedAttr.attrs, 'forged', { enumerable: true, value: { key: 'forged' } })
  assertNamedFailure(() => type.reserveDeltaMutation(unsupportedAttr), 'DeltaMutationPreparationError')

  const foreignDoc = new Y.Doc()
  const integrated = foreignDoc.get('integrated')
  const integratedIdentity = delta.create().insert('must not partially apply').insert([integrated])
  assertNamedFailure(() => type.reserveDeltaMutation(integratedIdentity), 'DeltaMutationPreparationError')
  const preliminary = new Y.Type('preliminary')
  const repeatedIdentity = /** @type {delta.DeltaBuilder<any>} */ (delta.create())
  repeatedIdentity.insert('must not partially apply').insert(/** @type {any[]} */ ([preliminary, preliminary]))
  assertNamedFailure(
    () => type.reserveDeltaMutation(repeatedIdentity),
    'DeltaMutationPreparationError'
  )
  const embeddedDocument = /** @type {delta.DeltaBuilder<any>} */ (delta.create())
  embeddedDocument.insert('must not partially apply').insert(/** @type {any[]} */ ([new Y.Doc()]))
  assertNamedFailure(
    () => type.reserveDeltaMutation(embeddedDocument),
    'DeltaMutationPreparationError'
  )
  const unsupportedAttribute = /** @type {delta.DeltaBuilder<any>} */ (delta.create())
  unsupportedAttribute.insert('must not partially apply').setAttr('unsupported', /** @type {any} */ (new Map()))
  assertNamedFailure(
    () => type.reserveDeltaMutation(unsupportedAttribute),
    'DeltaMutationPreparationError'
  )
  t.assert(updates === 0 && type.toDeltaDeep().isEmpty(), 'all malformed and unsafe identities fail before executor writes')

  const sourceChild = new Y.Type('p')
  sourceChild.applyDelta(delta.create().insert('owned child').done())
  assertNamedFailure(
    () => type.reserveDeltaMutation(delta.create().insert(/** @type {any[]} */ ([sourceChild])).done()),
    'DeltaMutationPreparationError'
  )
  t.assert(updates === 0 && type.toDeltaDeep().isEmpty(), 'raw preliminary identities are rejected without writes')
  const nestedSource = delta.create('p').insert('owned child')
  const nestedSyntax = /** @type {delta.DeltaBuilder<any>} */ (delta.create())
  nestedSyntax.insert(/** @type {any[]} */ ([nestedSource]))
  const ownedNested = type.reserveDeltaMutation(nestedSyntax)
  nestedSource.insert('later source mutation')
  ownedNested.apply()
  t.assert(/** @type {Y.Type} */ (type.get(0)).toString() === '<p>owned child</p>', 'nested delta syntax is privately owned')
  type.applyDelta(delta.create().delete(1).done())
  updates = 0

  const tombstoneDoc = new Y.Doc({ gc: false })
  const tombstoneType = tombstoneDoc.get('content')
  tombstoneType.setAttr('gone', new Y.Type())
  tombstoneType.deleteAttr('gone')
  let tombstoneUpdates = 0
  tombstoneDoc.on('update', () => { tombstoneUpdates++ })
  const invisibleModify = delta.create().insert('must not partially apply').modifyAttr('gone', delta.create().insert('x'))
  assertNamedFailure(() => tombstoneType.reserveDeltaMutation(invisibleModify), 'DeltaMutationPreparationError')
  t.assert(tombstoneUpdates === 0 && tombstoneType.toDeltaDeep().children.len === 0, 'invisible modifyAttr tombstones fail before executor writes')

  const malicious = delta.create().insert('reserved')
  let isEmptyCalls = 0
  Object.defineProperty(malicious, 'isEmpty', {
    value: () => {
      isEmptyCalls++
      type.applyDelta(delta.create().insert('caller write').done())
      return false
    }
  })
  const ownedWithoutDispatch = type.reserveDeltaMutation(malicious)
  ownedWithoutDispatch.apply()
  t.assert(isEmptyCalls === 0 && updates === 1 && type.toString() === 'reserved', 'preparation and execution never invoke caller emptiness dispatch')

  const beforeTransactionDoc = new Y.Doc()
  const beforeTransactionType = beforeTransactionDoc.get('content')
  const prepared = beforeTransactionType.reserveDeltaMutation(delta.create().insert('reserved').done())
  let callbackCalled = false
  let observerWrite = false
  beforeTransactionDoc.on('beforeTransaction', () => {
    if (!observerWrite) {
      observerWrite = true
      beforeTransactionType.setAttr('observer', true)
    }
  })
  assertNamedFailure(() => prepared.apply({ afterMutation: () => { callbackCalled = true } }), 'DeltaMutationInvariantError')
  t.assert(!callbackCalled && beforeTransactionType.toDeltaDeep().children.len === 0 && beforeTransactionType.getAttr('observer') === true)
  assertNamedFailure(() => prepared.apply(), 'DeltaMutationCapabilityError')
}

export const testReservedDeltaMutationObserverFailureStillStales = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  doc.on('beforeObserverCalls', () => { throw new Error('observer failure') })
  const prepared = type.reserveDeltaMutation(delta.create().insert('reserved').done())
  t.fails(() => type.applyDelta(delta.create().insert('external').done()))
  assertNamedFailure(() => prepared.apply(), 'DeltaMutationStaleError')
  t.assert(type.toString() === 'external', 'observer failure cannot hide a committed structural revision')
}

export const testReservedDeltaMutationRechecksLivenessInsideTransaction = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  const prepared = type.reserveDeltaMutation(delta.create().insert('reserved').done())
  let callbackCalled = false
  doc.on('beforeTransaction', () => { doc.destroy() })
  assertNamedFailure(
    () => prepared.apply({ afterMutation: () => { callbackCalled = true } }),
    'DeltaMutationStaleError'
  )
  t.assert(!callbackCalled && type.toString() === '', 'destroyed admission runs neither executor nor callback')
}

export const testReservedDeltaMutationOwnsCanonicalOperations = () => {
  const textDoc = new Y.Doc()
  const textType = textDoc.get('content')
  const textMutation = delta.create().insert('owned')
  const textOp = /** @type {any} */ (textMutation.children.start)
  textOp.clone = () => textOp
  const textPrepared = textType.reserveDeltaMutation(textMutation)
  textOp.insert = 'mutated'
  textPrepared.apply()
  t.assert(textType.toString() === 'owned', 'text op dispatch and payload are privately owned')

  const deleteDoc = new Y.Doc()
  const deleteType = deleteDoc.get('content')
  deleteType.applyDelta(delta.create().insert('abc').done())
  const deleteMutation = delta.create().delete(1)
  const deleteOp = /** @type {any} */ (deleteMutation.children.start)
  deleteOp.clone = () => deleteOp
  const deletePrepared = deleteType.reserveDeltaMutation(deleteMutation)
  deleteOp.delete = 3
  deletePrepared.apply()
  t.assert(deleteType.toString() === 'bc', 'delete op dispatch and length are privately owned')

  const retainDoc = new Y.Doc()
  const retainType = retainDoc.get('content')
  retainType.applyDelta(delta.create().insert('abc').done())
  const retainMutation = delta.create().retain(1, { bold: {} })
  const retainOp = /** @type {any} */ (retainMutation.children.start)
  retainOp.clone = () => retainOp
  const retainPrepared = retainType.reserveDeltaMutation(retainMutation)
  retainOp.retain = 3
  retainOp.format.bold = { forged: true }
  retainPrepared.apply()
  t.compare(retainType.toDeltaDeep().toJSON(), {
    type: 'delta',
    children: [
      { type: 'insert', insert: 'a', format: { bold: {} } },
      { type: 'insert', insert: 'bc' }
    ]
  })
}

export const testReservedDeltaMutationAvoidsMutableCanonicalDispatch = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  const mutation = delta.create().insert('owned')
  const listPrototype = Object.getPrototypeOf(mutation.children)
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(listPrototype, Symbol.iterator)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(delta.TextOp.prototype, 'length')
  const schemaChecks = [delta.$deltaAny, delta.$textOp, delta.$insertOp, delta.$retainOp, delta.$deleteOp, delta.$modifyOp]
  try {
    Object.defineProperty(delta.DeltaBuilder.prototype, 'isEmpty', {
      configurable: true,
      value: () => { throw new Error('mutable delta dispatch') }
    })
    Object.defineProperty(listPrototype, Symbol.iterator, {
      configurable: true,
      value: () => { throw new Error('mutable list dispatch') }
    })
    Object.defineProperty(delta.TextOp.prototype, 'length', {
      configurable: true,
      get: () => { throw new Error('mutable op dispatch') }
    })
    for (let index = 0; index < schemaChecks.length; index++) {
      Object.defineProperty(schemaChecks[index], 'check', {
        configurable: true,
        value: () => { throw new Error('mutable schema dispatch') }
      })
    }
    const prepared = type.reserveDeltaMutation(mutation)
    prepared.apply()
  } finally {
    Reflect.deleteProperty(delta.DeltaBuilder.prototype, 'isEmpty')
    Object.defineProperty(listPrototype, Symbol.iterator, /** @type {PropertyDescriptor} */ (iteratorDescriptor))
    Object.defineProperty(delta.TextOp.prototype, 'length', /** @type {PropertyDescriptor} */ (lengthDescriptor))
    for (let index = 0; index < schemaChecks.length; index++) Reflect.deleteProperty(schemaChecks[index], 'check')
  }
  t.assert(type.toString() === 'owned')

  const nestedDoc = new Y.Doc()
  const nestedType = nestedDoc.get('content')
  const nestedMutation = delta.create().insert([delta.create('p').insert('child')]).done()
  const originalFrom = Y.Type.from
  let fromCalls = 0
  try {
    Y.Type.from = () => {
      fromCalls++
      return doc.get('foreign')
    }
    const nested = nestedType.reserveDeltaMutation(nestedMutation)
    nested.apply()
  } finally {
    Y.Type.from = originalFrom
  }
  const child = /** @type {Y.Type} */ (nestedType.get(0))
  t.assert(fromCalls === 0 && child.doc === nestedDoc && child.toString() === '<p>child</p>')
}

const createRenderedDeletedPair = () => {
  const base = new Y.Doc({ gc: false })
  base.clientID = 1
  const suggestion = new Y.Doc({ isSuggestionDoc: true, gc: false })
  suggestion.clientID = 2
  const renderer = Y.createDiffRenderer(base, suggestion, { attrs: new Y.Attributions() })
  base.get('content').applyDelta(delta.create().insert([
    delta.create('first').insert('first'),
    delta.create('second').insert('second')
  ]).done())
  const type = suggestion.get('content')
  type.useRenderer(renderer)
  const first = /** @type {Y.Type} */ (type.get(0))
  const second = /** @type {Y.Type} */ (type.get(1))
  type.applyDelta(delta.create().delete(1).done())
  return { suggestion, renderer, type, first, second }
}

export const testReservedDeltaMutationSealsRendererExecution = () => {
  {
    const { renderer, type, first, second } = createRenderedDeletedPair()
    const prepared = type.reserveDeltaMutation(delta.create().modify(delta.create().insert('target:')).done(), null, { renderer })
    let publicCalls = 0
    Object.defineProperties(renderer, {
      hasItem: {
        configurable: true,
        value: () => {
          publicCalls++
          return false
        }
      },
      contentLength: {
        configurable: true,
        value: () => {
          publicCalls++
          throw new Error('public renderer contentLength')
        }
      },
      readContent: {
        configurable: true,
        value: () => {
          publicCalls++
          throw new Error('public renderer readContent')
        }
      }
    })
    let failure = null
    try {
      prepared.apply()
    } catch (error) {
      failure = error
    } finally {
      Reflect.deleteProperty(renderer, 'hasItem')
      Reflect.deleteProperty(renderer, 'contentLength')
      Reflect.deleteProperty(renderer, 'readContent')
    }
    t.assert(failure === null && publicCalls === 0, 'reserved execution never calls public renderer properties')
    t.assert(first.toString() === '<first />', 'rendered tombstone is handled as a fix-only target')
    t.assert(second.toString() === '<second>second</second>', 'live decoy is not retargeted')
  }

  {
    const { renderer, type } = createRenderedDeletedPair()
    const prepared = type.reserveDeltaMutation(delta.create().insert('prefix').delete(1).done(), null, { renderer })
    const hasItem = renderer.hasItem.bind(renderer)
    const contentLength = renderer.contentLength.bind(renderer)
    let publicCalls = 0
    Object.defineProperties(renderer, {
      hasItem: {
        configurable: true,
        value: (/** @type {Item} */ item) => {
          publicCalls++
          return hasItem(item)
        }
      },
      contentLength: {
        configurable: true,
        value: (/** @type {Item} */ item) => {
          publicCalls++
          return contentLength(item)
        }
      },
      readContent: {
        configurable: true,
        value: () => {
          publicCalls++
          throw new Error('public renderer readContent after prefix insert')
        }
      }
    })
    const mapDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'map')
    const spliceDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'splice')
    let mapCalls = 0
    let spliceCalls = 0
    /**
     * @this {any}
     * @param {...any} args
     */
    const guardedMap = function (...args) {
      if (args[0] === cloneRendererContentAttribute) {
        mapCalls++
        throw new Error('mutable renderer attrs map after reserve')
      }
      return Reflect.apply(/** @type {Function} */ (mapDescriptor?.value), this, args)
    }
    /**
     * @this {any}
     * @param {...any} args
     */
    const guardedSplice = function (...args) {
      const inserted = args[2]
      if (args[1] === 0 && inserted != null && typeof inserted === 'object' && 'clock' in inserted && 'len' in inserted && 'attrs' in inserted) {
        spliceCalls++
        throw new Error('mutable renderer slice splice after reserve')
      }
      return Reflect.apply(/** @type {Function} */ (spliceDescriptor?.value), this, args)
    }
    /** @type {any} */
    let failure = null
    try {
      // eslint-disable-next-line no-extend-native
      Object.defineProperties(Array.prototype, {
        map: {
          configurable: true,
          value: guardedMap
        },
        splice: {
          configurable: true,
          value: guardedSplice
        }
      })
      prepared.apply()
    } catch (error) {
      failure = error
    } finally {
      // eslint-disable-next-line no-extend-native
      Object.defineProperty(Array.prototype, 'map', /** @type {PropertyDescriptor} */ (mapDescriptor))
      // eslint-disable-next-line no-extend-native
      Object.defineProperty(Array.prototype, 'splice', /** @type {PropertyDescriptor} */ (spliceDescriptor))
      Reflect.deleteProperty(renderer, 'hasItem')
      Reflect.deleteProperty(renderer, 'contentLength')
      Reflect.deleteProperty(renderer, 'readContent')
    }
    t.assert(failure === null && publicCalls === 0 && mapCalls === 0 && spliceCalls === 0, `renderer mutation cannot fail after a partial insert: ${failure?.message ?? 'no failure'}, public=${publicCalls}, map=${mapCalls}, splice=${spliceCalls}`)
    t.assert(/** @type {any} */ (type.toDelta({ renderer, deep: true }).toJSON()).children[0].insert === 'prefix')
  }
}

export const testReservedDeltaMutationSnapshotsRendererDependenciesAndPolicy = () => {
  {
    const base = new Y.Doc({ gc: false })
    const suggestion = new Y.Doc({ gc: false })
    base.on('beforeObserverCalls', () => { throw new Error('base listener failed before renderer projection') })
    const renderer = Y.createDiffRenderer(base, suggestion, { attrs: new Y.Attributions() })
    const type = suggestion.get('content')
    const prepared = type.reserveDeltaMutation(delta.create().insert('reserved').done(), null, { renderer })
    t.fails(() => base.get('base').applyDelta(delta.create().insert('changed').done()))
    assertNamedFailure(() => prepared.apply(), 'DeltaMutationStaleError')
    t.assert(type.toString() === '', 'direct base dependency revision rejects despite a throwing listener')
  }

  {
    const base = new Y.Doc({ gc: false })
    const suggestion = new Y.Doc({ gc: false })
    const renderer = Y.createDiffRenderer(base, suggestion, { attrs: new Y.Attributions() })
    const origin = { trusted: true }
    const type = suggestion.get('content')
    const staleMode = type.reserveDeltaMutation(delta.create().insert('stale').done(), origin, { renderer })
    renderer.suggestionMode = false
    assertNamedFailure(() => staleMode.apply(), 'DeltaMutationStaleError')

    renderer.suggestionMode = true
    const forged = { forged: true }
    let proxyCalls = 0
    /** @type {any[]} */
    const originValues = [origin]
    const origins = new Proxy(originValues, {
      get: (target, key, receiver) => {
        proxyCalls++
        return Reflect.get(target, key, receiver)
      },
      getOwnPropertyDescriptor: (target, key) => {
        proxyCalls++
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    renderer.suggestionOrigins = origins
    const ownedOrigins = renderer.suggestionOrigins
    t.assert(ownedOrigins !== origins && Object.isFrozen(ownedOrigins) && ownedOrigins?.[0] === origin, 'renderer owns immutable origin policy')
    const callsAfterSetter = proxyCalls
    const stableOrigins = type.reserveDeltaMutation(delta.create().insert('stable origins').done(), origin, { renderer })
    originValues[0] = forged
    stableOrigins.apply()
    t.assert(proxyCalls === callsAfterSetter && type.toString() === 'stable origins', 'capability never rereads caller policy')

    const staleOrigins = type.reserveDeltaMutation(delta.create().insert('stale origins').done(), origin, { renderer })
    renderer.suggestionOrigins = [forged]
    assertNamedFailure(() => staleOrigins.apply(), 'DeltaMutationStaleError')
    renderer.suggestionOrigins = [origin]
    const prepared = type.reserveDeltaMutation(delta.create().insert('owned').done(), origin, { renderer })
    prepared.apply({
      afterMutation: () => {
        renderer.suggestionMode = false
        renderer.suggestionOrigins = [origin]
      }
    })
    t.assert(type.toString() === 'ownedstable origins' && base.get('content').toString() === '', 'reserved update never forwards after cleanup policy flip')

    suggestion.get('local').applyDelta(delta.create().insert('allowed').done(), origin)
    t.assert(base.get('local').toString() === 'allowed', 'explicit owned policy remains live for ordinary local updates')
    const remote = new Y.Doc()
    remote.get('remote').applyDelta(delta.create().insert('remote').done())
    Y.applyUpdate(suggestion, Y.encodeStateAsUpdate(remote), origin)
    t.assert(base.get('remote').toString() === '' && proxyCalls === callsAfterSetter, 'remote updates and ordinary policy never dispatch caller Proxy traps')
  }
}

export const testReservedDeltaMutationAccountsCallbackGcWire = () => {
  /** @type {Array<['update'|'updateV2',typeof Y.encodeStateAsUpdate,typeof Y.applyUpdate]>} */
  const formats = [
    ['update', Y.encodeStateAsUpdate, Y.applyUpdate],
    ['updateV2', Y.encodeStateAsUpdateV2, Y.applyUpdateV2]
  ]
  for (let index = 0; index < formats.length; index++) {
    const [event, encode, apply] = formats[index]
    const source = new Y.Doc()
    source.clientID = 77
    const nested = new Y.Type()
    source.get('remote').insert(0, [nested])
    nested.insert(0, ['a', 'b', 'c', 'd'])
    source.get('remote').delete(0, 1)
    const callbackUpdate = encode(source)
    const sourceStructs = /** @type {any[]} */ (source.store.clients.get(77))
    t.assert(sourceStructs.length === 2 && sourceStructs[0].constructor.name === 'Item' && sourceStructs[1].constructor.name === 'GC')

    const doc = new Y.Doc()
    doc.clientID = 88
    const type = doc.get('content')
    const mirror = new Y.Doc()
    mirror.clientID = 99
    /** @type {Uint8Array|null} */
    let emitted = null
    doc.on(event, update => { emitted = update })
    type.reserveDeltaMutation(delta.create().insert('local').done()).apply({
      afterMutation: () => { apply(doc, callbackUpdate) }
    })

    t.assert(doc.store.getClock(77) === 5, `${event} callback integrates Item and GC locally`)
    if (emitted === null) throw new Error(`${event} callback update was not emitted`)
    apply(mirror, emitted)
    t.assert(mirror.store.getClock(77) === 5, `${event} callback emits complete Item and GC wire coverage`)
  }
}

export const testReservedDeltaMutationInitializesEmissionContextsBeforeCleanupHooks = () => {
  /** @type {Array<[object,'update'|'updateV2',typeof Y.applyUpdate]>} */
  const formats = [
    [UpdateEncoderV1.prototype, 'update', Y.applyUpdate],
    [UpdateEncoderV2.prototype, 'updateV2', Y.applyUpdateV2]
  ]
  for (let index = 0; index < formats.length; index++) {
    const [prototype, event, apply] = formats[index]
    const doc = new Y.Doc()
    const type = doc.get('content')
    const mirror = new Y.Doc()
    const prepared = type.reserveDeltaMutation(delta.create().insert('wire').done())
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'restEncoder')
    let setterCalls = 0
    let failure = null
    /** @type {Uint8Array|null} */
    let emitted = null
    doc.on(event, update => { emitted = update })
    doc.on('afterTransactionCleanup', () => {
      Object.defineProperty(prototype, 'restEncoder', {
        configurable: true,
        get: () => undefined,
        set: () => { setterCalls++ }
      })
    })
    try {
      prepared.apply()
    } catch (error) {
      failure = error
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(prototype, 'restEncoder')
      else Object.defineProperty(prototype, 'restEncoder', descriptor)
    }
    t.assert(failure === null && setterCalls === 0, `${event} encoder is fully initialized before cleanup hooks`)
    t.assert(type.toString() === 'wire' && doc._transactionCleanups.length === 0, `${event} leaves committed state and a drained queue`)
    assertNamedFailure(() => prepared.apply(), 'DeltaMutationCapabilityError')
    if (emitted === null) throw new Error(`${event} was not emitted`)
    apply(mirror, emitted)
    t.assert(mirror.get('content').toString() === 'wire')
  }
}

export const testReservedDeltaMutationCleanupUsesCapturedWeakMapKernel = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  const prepared = type.reserveDeltaMutation(delta.create().insert('wire').done())
  const target = WeakMap.prototype
  const descriptor = Object.getOwnPropertyDescriptor(target, 'get')
  /** @type {Uint8Array|null} */
  let updateV1 = null
  /** @type {Uint8Array|null} */
  let updateV2 = null
  let poisonCalls = 0
  let failure = null
  doc.on('update', update => { updateV1 = update })
  doc.on('updateV2', update => { updateV2 = update })
  try {
    prepared.apply({
      afterMutation: () => {
        Object.defineProperty(target, 'get', {
          configurable: true,
          value: () => {
            poisonCalls++
            throw new Error('poison weak get')
          }
        })
      }
    })
  } catch (error) {
    failure = error
  } finally {
    Object.defineProperty(target, 'get', /** @type {PropertyDescriptor} */ (descriptor))
  }
  t.assert(failure === null && poisonCalls === 0, 'reserved cleanup uses its captured WeakMap kernel')
  t.assert(type.toString() === 'wire' && doc._transactionCleanups.length === 0, 'WeakMap poison leaves committed state and a drained queue')
  assertNamedFailure(() => prepared.apply(), 'DeltaMutationCapabilityError')
  if (updateV1 === null || updateV2 === null) throw new Error('WeakMap poison lost an update format')
}

export const testReservedDeltaMutationContentAnyUsesCapturedBinaryKernel = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  const prepared = type.reserveDeltaMutation(delta.create().setAttr('payload', { owned: true }).done())
  const descriptor = Object.getOwnPropertyDescriptor(Uint8Array, Symbol.hasInstance)
  /** @type {Uint8Array|null} */
  let updateV1 = null
  /** @type {Uint8Array|null} */
  let updateV2 = null
  let poisonCalls = 0
  let failure = null
  doc.on('update', update => { updateV1 = update })
  doc.on('updateV2', update => { updateV2 = update })
  try {
    prepared.apply({
      afterMutation: () => {
        Object.defineProperty(Uint8Array, Symbol.hasInstance, {
          configurable: true,
          value: () => {
            poisonCalls++
            throw new Error('poison Uint8Array hasInstance')
          }
        })
      }
    })
  } catch (error) {
    failure = error
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(Uint8Array, Symbol.hasInstance)
    else Object.defineProperty(Uint8Array, Symbol.hasInstance, descriptor)
  }
  t.assert(failure === null && poisonCalls === 0, 'ContentAny wire encoding uses captured binary dispatch')
  t.assert(type.getAttr('payload').owned === true && doc._transactionCleanups.length === 0)
  if (updateV1 === null || updateV2 === null) throw new Error('ContentAny poison lost an update format')
}

export const testReservedDeltaMutationRootNameUsesCapturedMapKernel = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  const prepared = type.reserveDeltaMutation(delta.create().insert('wire').done())
  const target = Map.prototype
  const descriptor = Object.getOwnPropertyDescriptor(target, 'entries')
  /** @type {Uint8Array|null} */
  let updateV1 = null
  /** @type {Uint8Array|null} */
  let updateV2 = null
  let poisonCalls = 0
  let failure = null
  doc.on('update', update => { updateV1 = update })
  doc.on('updateV2', update => { updateV2 = update })
  try {
    prepared.apply({
      afterMutation: () => {
        Object.defineProperty(target, 'entries', {
          configurable: true,
          value: () => {
            poisonCalls++
            throw new Error('poison map entries')
          }
        })
      }
    })
  } catch (error) {
    failure = error
  } finally {
    Object.defineProperty(target, 'entries', /** @type {PropertyDescriptor} */ (descriptor))
  }
  t.assert(failure === null && poisonCalls === 0, 'root-name lookup uses a captured Map kernel')
  t.assert(type.toString() === 'wire' && doc._transactionCleanups.length === 0)
  if (updateV1 === null || updateV2 === null) throw new Error('Map poison lost an update format')
}

export const testReservedDeltaMutationChargesUtf8PayloadBytes = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  const key = '€'.repeat(199990)
  assertNamedFailure(
    () => type.reserveDeltaMutation(delta.create().setAttr(key, true).done()),
    'DeltaMutationPreparationError'
  )
  t.assert(type.toDeltaDeep().isEmpty() && doc.store.clients.size === 0, 'UTF-8 budget rejection is prewrite')
}

export const testReservedDeltaMutationNeverForwardsAttributedDeletes = () => {
  /** @param {boolean} throwing */
  const run = throwing => {
    const base = new Y.Doc({ gc: false })
    base.clientID = 1
    const suggestion = new Y.Doc({ gc: false })
    suggestion.clientID = 2
    const renderer = Y.createDiffRenderer(base, suggestion, { attrs: new Y.Attributions() })
    base.get('content').applyDelta(delta.create().insert('base').done())
    const type = suggestion.get('content')
    type.useRenderer(renderer)
    type.applyDelta(delta.create().delete(4).done())
    const prepared = type.reserveDeltaMutation(delta.create().delete(4).done(), null, { renderer })
    const apply = () => prepared.apply({
      afterMutation: () => {
        renderer.suggestionMode = false
        if (throwing) throw new Error('trusted cleanup callback failed')
      }
    })
    if (throwing) assertNamedFailure(apply, 'DeltaMutationInvariantError')
    else apply()
    t.assert(base.get('content').toString() === 'base', `reserved attributed deletes stay private${throwing ? ' after callback failure' : ''}`)
  }
  run(false)
  run(true)
}

export const testReservedDeltaMutationUsesCanonicalNestedIntegration = () => {
  const typeDescriptor = Object.getOwnPropertyDescriptor(ContentType.prototype, 'type')
  const contentIntegrateDescriptor = Object.getOwnPropertyDescriptor(ContentType.prototype, 'integrate')
  const decoyDoc = new Y.Doc()
  const decoy = decoyDoc.get('decoy')
  let setterCalls = 0
  let contentIntegrateCalls = 0
  let failure = null
  const doc = new Y.Doc()
  const type = doc.get('content')
  try {
    Object.defineProperty(ContentType.prototype, 'type', {
      configurable: true,
      get () { return decoy },
      set (_value) { setterCalls++ }
    })
    const prepared = type.reserveDeltaMutation(delta.create().insert([delta.create('child').insert('owned')]).done())
    Object.defineProperty(ContentType.prototype, 'integrate', {
      configurable: true,
      value: () => {
        contentIntegrateCalls++
        throw new Error('mutable ContentType integration')
      }
    })
    prepared.apply()
  } catch (error) {
    failure = error
  } finally {
    if (typeDescriptor === undefined) Reflect.deleteProperty(ContentType.prototype, 'type')
    else Object.defineProperty(ContentType.prototype, 'type', typeDescriptor)
    Object.defineProperty(ContentType.prototype, 'integrate', /** @type {PropertyDescriptor} */ (contentIntegrateDescriptor))
  }
  t.assert(failure === null && setterCalls === 0 && contentIntegrateCalls === 0, 'private ContentType construction and integration bypass mutable prototypes')
  const child = /** @type {Y.Type} */ (type.get(0))
  t.assert(child.doc === doc && child.name === 'child' && child.toString() === '<child>owned</child>')
  t.assert(decoy.doc === decoyDoc && decoy._item === null, 'decoy type stays detached from the reserved item')

  const itemDoc = new Y.Doc()
  const itemType = itemDoc.get('content')
  const itemPrepared = itemType.reserveDeltaMutation(delta.create().insert([delta.create('child').insert('owned')]).done())
  const itemIntegrateDescriptor = Object.getOwnPropertyDescriptor(Item.prototype, 'integrate')
  let itemIntegrateCalls = 0
  failure = null
  try {
    Object.defineProperty(Item.prototype, 'integrate', {
      configurable: true,
      value: () => {
        itemIntegrateCalls++
        throw new Error('mutable Item integration')
      }
    })
    itemPrepared.apply()
  } catch (error) {
    failure = error
  } finally {
    Object.defineProperty(Item.prototype, 'integrate', /** @type {PropertyDescriptor} */ (itemIntegrateDescriptor))
  }
  t.assert(failure === null && itemIntegrateCalls === 0, 'reserved inserts use the private Item integration kernel')
  t.assert(/** @type {Y.Type} */ (itemType.get(0)).toString() === '<child>owned</child>')
}

export const testReservedDeltaMutationCanonicalWireSurvivesPrototypePoison = () => {
  /** @param {'delete'|'write'} poison */
  const run = poison => {
    const doc = new Y.Doc()
    const type = doc.get('content')
    const remoteV1 = new Y.Doc()
    const remoteV2 = new Y.Doc()
    /** @type {Uint8Array|null} */
    let updateV1 = null
    /** @type {Uint8Array|null} */
    let updateV2 = null
    let callbackCalled = false
    doc.on('update', update => { updateV1 = update })
    doc.on('updateV2', update => { updateV2 = update })
    const prepared = type.reserveDeltaMutation(delta.create().insert('wire').setAttr('owned', true).done())
    const target = poison === 'delete' ? WeakMap.prototype : ContentString.prototype
    const key = poison === 'delete' ? 'delete' : 'write'
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    let failure = null
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        value: () => { throw new Error(`poisoned ${poison}`) }
      })
      prepared.apply({ afterMutation: () => { callbackCalled = true } })
    } catch (error) {
      failure = error
    } finally {
      Object.defineProperty(target, key, /** @type {PropertyDescriptor} */ (descriptor))
    }
    t.assert(failure === null && callbackCalled, `${poison} poison cannot fail after a reserved write`)
    if (updateV1 === null || updateV2 === null) throw new Error(`${poison} poison lost a canonical update format`)
    Y.applyUpdate(remoteV1, updateV1)
    Y.applyUpdateV2(remoteV2, updateV2)
    t.compare(remoteV1.get('content').toDeltaDeep().toJSON(), type.toDeltaDeep().toJSON())
    t.compare(remoteV2.get('content').toDeltaDeep().toJSON(), type.toDeltaDeep().toJSON())
  }
  run('delete')
  run('write')
}

export const testReservedDeltaMutationCanonicalEncoderSurvivesCleanupPoison = () => {
  /** @type {Array<[object,PropertyKey,'before'|'afterTransaction'|'afterTransactionCleanup','update'|'updateV2',typeof Y.applyUpdate]>} */
  const cases = [
    [UpdateEncoderV1.prototype, 'writeInfo', 'before', 'update', Y.applyUpdate],
    [UpdateEncoderV2.prototype, 'writeInfo', 'afterTransaction', 'updateV2', Y.applyUpdateV2],
    [IdSetEncoderV1.prototype, 'toUint8Array', 'afterTransactionCleanup', 'update', Y.applyUpdate],
    [UpdateEncoderV2.prototype, 'toUint8Array', 'before', 'updateV2', Y.applyUpdateV2]
  ]
  for (let index = 0; index < cases.length; index++) {
    const [prototype, key, phase, event, applyUpdate] = cases[index]
    const doc = new Y.Doc()
    const type = doc.get('content')
    const remote = new Y.Doc()
    const prepared = type.reserveDeltaMutation(delta.create().insert('wire').done())
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
    /** @type {Uint8Array|null} */
    let update = null
    let poisonCalls = 0
    let failure = null
    const poison = () => {
      poisonCalls++
      throw new Error(`poisoned encoder ${String(key)}`)
    }
    const install = () => Object.defineProperty(prototype, key, { configurable: true, value: poison })
    doc.on(event, value => { update = value })
    if (phase !== 'before') doc.on(phase, install)
    try {
      if (phase === 'before') install()
      prepared.apply()
    } catch (error) {
      failure = error
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(prototype, key)
      else Object.defineProperty(prototype, key, descriptor)
    }
    t.assert(failure === null && poisonCalls === 0, `${event} ${String(key)} stays on the captured encoder kernel`)
    if (update === null) throw new Error(`${event} was not emitted`)
    applyUpdate(remote, update)
    t.assert(remote.get('content').toString() === 'wire')
  }
}

export const testReservedDeltaMutationCanonicalCleanupSurvivesPrototypePoison = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  const remote = new Y.Doc()
  type.applyDelta(delta.create().insert('owned').done())
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc))
  const prepared = type.reserveDeltaMutation(delta.create().delete(5).done())
  const gcDescriptor = Object.getOwnPropertyDescriptor(ContentString.prototype, 'gc')
  const mergeDescriptor = Object.getOwnPropertyDescriptor(Item.prototype, 'mergeWith')
  /** @type {Uint8Array|null} */
  let update = null
  let poisonCalls = 0
  let failure = null
  doc.on('update', value => { update = value })
  try {
    Object.defineProperty(ContentString.prototype, 'gc', {
      configurable: true,
      value: () => {
        poisonCalls++
        throw new Error('poisoned ContentString.gc')
      }
    })
    Object.defineProperty(Item.prototype, 'mergeWith', {
      configurable: true,
      value: () => {
        poisonCalls++
        throw new Error('poisoned Item.mergeWith')
      }
    })
    prepared.apply()
  } catch (error) {
    failure = error
  } finally {
    Object.defineProperty(ContentString.prototype, 'gc', /** @type {PropertyDescriptor} */ (gcDescriptor))
    Object.defineProperty(Item.prototype, 'mergeWith', /** @type {PropertyDescriptor} */ (mergeDescriptor))
  }
  t.assert(failure === null && poisonCalls === 0 && type.toString() === '', 'reserved GC and merge cleanup use closed kernels')
  if (update === null) throw new Error('reserved delete update was not emitted')
  Y.applyUpdate(remote, update)
  t.assert(remote.get('content').toString() === '', 'canonical cleanup update converges')

  const mergeDoc = new Y.Doc()
  mergeDoc.clientID = 41
  const mergeType = mergeDoc.get('content')
  const mergeRemote = new Y.Doc()
  mergeType.applyDelta(delta.create().insert('a').done())
  Y.applyUpdate(mergeRemote, Y.encodeStateAsUpdate(mergeDoc))
  const mergePrepared = mergeType.reserveDeltaMutation(delta.create().retain(1).insert('b').done())
  const itemMergeDescriptor = Object.getOwnPropertyDescriptor(Item.prototype, 'mergeWith')
  const contentMergeDescriptor = Object.getOwnPropertyDescriptor(ContentString.prototype, 'mergeWith')
  /** @type {Uint8Array|null} */
  let mergeUpdate = null
  poisonCalls = 0
  failure = null
  mergeDoc.on('update', value => { mergeUpdate = value })
  try {
    Object.defineProperty(Item.prototype, 'mergeWith', {
      configurable: true,
      value: () => {
        poisonCalls++
        throw new Error('poisoned Item.mergeWith')
      }
    })
    Object.defineProperty(ContentString.prototype, 'mergeWith', {
      configurable: true,
      value: () => {
        poisonCalls++
        throw new Error('poisoned ContentString.mergeWith')
      }
    })
    mergePrepared.apply()
  } catch (error) {
    failure = error
  } finally {
    Object.defineProperty(Item.prototype, 'mergeWith', /** @type {PropertyDescriptor} */ (itemMergeDescriptor))
    Object.defineProperty(ContentString.prototype, 'mergeWith', /** @type {PropertyDescriptor} */ (contentMergeDescriptor))
  }
  t.assert(failure === null && poisonCalls === 0 && mergeType.toString() === 'ab', 'reserved merge cleanup bypasses Item and content prototypes')
  t.assert(mergeDoc.store.clients.get(41)?.length === 1, 'canonical merge compacts adjacent reserved content')
  if (mergeUpdate === null) throw new Error('reserved merge update was not emitted')
  Y.applyUpdate(mergeRemote, mergeUpdate)
  t.assert(mergeRemote.get('content').toString() === 'ab')
}

export const testReservedDeltaMutationRepeatedAppendCleanupParity = () => {
  const ordinary = new Y.Doc()
  const reserved = new Y.Doc()
  ordinary.clientID = 43
  reserved.clientID = 43
  const ordinaryType = ordinary.get('content')
  const reservedType = reserved.get('content')
  /** @type {Array<{update:Uint8Array,origin:any}>} */
  const ordinaryV1 = []
  /** @type {Array<{update:Uint8Array,origin:any}>} */
  const reservedV1 = []
  /** @type {Array<{update:Uint8Array,origin:any}>} */
  const ordinaryV2 = []
  /** @type {Array<{update:Uint8Array,origin:any}>} */
  const reservedV2 = []
  /** @type {string[]} */
  const ordinaryEvents = []
  /** @type {string[]} */
  const reservedEvents = []
  ordinary.on('update', (update, origin) => ordinaryV1.push({ update, origin }))
  reserved.on('update', (update, origin) => reservedV1.push({ update, origin }))
  ordinary.on('updateV2', (update, origin) => ordinaryV2.push({ update, origin }))
  reserved.on('updateV2', (update, origin) => reservedV2.push({ update, origin }))
  ordinaryType.observe((event, transaction) => ordinaryEvents.push(JSON.stringify({ delta: event.delta.toJSON(), origin: transaction.origin })))
  reservedType.observe((event, transaction) => reservedEvents.push(JSON.stringify({ delta: event.delta.toJSON(), origin: transaction.origin })))
  const origin = 'append-parity'
  const count = 128
  for (let index = 0; index < count; index++) {
    ordinaryType.applyDelta(delta.create().retain(index).insert('x').done(), origin)
    reservedType.reserveDeltaMutation(delta.create().retain(index).insert('x').done(), origin).apply()
    t.compare(Array.from(ordinaryV1[index].update), Array.from(reservedV1[index].update))
    t.compare(Array.from(ordinaryV2[index].update), Array.from(reservedV2[index].update))
    t.assert(ordinaryV1[index].origin === origin && reservedV1[index].origin === origin)
    t.assert(ordinaryEvents[index] === reservedEvents[index], `append observer parity at ${index}`)
  }
  const ordinaryStructs = ordinary.store.clients.get(43)
  const reservedStructs = reserved.store.clients.get(43)
  t.assert(ordinaryStructs?.length === 1 && reservedStructs?.length === 1, 'equivalent appends compact to one struct')
  t.compare(Array.from(Y.encodeStateAsUpdate(ordinary)), Array.from(Y.encodeStateAsUpdate(reserved)))
  t.compare(Array.from(Y.encodeStateAsUpdateV2(ordinary)), Array.from(Y.encodeStateAsUpdateV2(reserved)))
}

export const testReservedDeltaMutationSplitDeleteFormatCleanupParity = () => {
  const ordinary = new Y.Doc()
  const reserved = new Y.Doc()
  ordinary.clientID = 47
  reserved.clientID = 47
  const ordinaryType = ordinary.get('content')
  const reservedType = reserved.get('content')
  /** @type {Uint8Array[]} */
  const ordinaryUpdates = []
  /** @type {Uint8Array[]} */
  const reservedUpdates = []
  ordinary.on('update', update => ordinaryUpdates.push(update))
  reserved.on('update', update => reservedUpdates.push(update))
  const operations = [
    () => delta.create().insert('abc').done(),
    () => delta.create().retain(1).retain(1, { bold: {} }).done(),
    () => delta.create().retain(1).delete(1).done(),
    () => delta.create().retain(1).insert('XYZ').done(),
    () => delta.create().retain(2).delete(1).done()
  ]
  for (let index = 0; index < operations.length; index++) {
    ordinaryType.applyDelta(operations[index]())
    reservedType.reserveDeltaMutation(operations[index]()).apply()
    t.compare(ordinaryType.toDeltaDeep().toJSON(), reservedType.toDeltaDeep().toJSON())
    t.compare(Array.from(ordinaryUpdates[index]), Array.from(reservedUpdates[index]))
    t.compare(Array.from(Y.encodeStateAsUpdate(ordinary)), Array.from(Y.encodeStateAsUpdate(reserved)))
    t.compare(Array.from(Y.encodeStateAsUpdateV2(ordinary)), Array.from(Y.encodeStateAsUpdateV2(reserved)))
    t.assert(ordinary.store.clients.get(47)?.length === reserved.store.clients.get(47)?.length, `cleanup struct parity at ${index}`)
  }
}

export const testReservedDeltaMutationGcFilterFailureIsFatalAndConsumed = () => {
  const sentinel = new Error('gcFilter must be noexcept')
  let filterCalls = 0
  const doc = new Y.Doc({
    gc: true,
    gcFilter: () => {
      filterCalls++
      throw sentinel
    }
  })
  const type = doc.get('content')
  type.applyDelta(delta.create().insert('abc').done())
  const prepared = type.reserveDeltaMutation(delta.create().delete(3).done())
  let updates = 0
  doc.on('update', () => { updates++ })
  let caught = null
  try {
    prepared.apply()
  } catch (error) {
    caught = error
  }
  t.assert(caught === sentinel && filterCalls === 1, 'gcFilter failure remains authoritative')
  t.assert(type.toString() === '' && updates === 0, 'gcFilter failure is fatal after the logical write and suppresses replication')
  t.assert(doc._transaction === null && doc._transactionCleanups.length === 0, 'gcFilter failure clears transaction state')
  assertNamedFailure(() => prepared.apply(), 'DeltaMutationCapabilityError')
  t.assert(filterCalls === 1, 'a failed reserved mutation is consumed and never retries gcFilter')
}

export const testReservedDeltaMutationModifyAttrIgnoresMutableHasInstance = () => {
  const doc = new Y.Doc()
  const root = doc.get('content')
  const child = new Y.Type('child')
  root.setAttr('child', child)
  child.applyDelta(delta.create().insert('a').done())
  const remote = new Y.Doc()
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc))
  const prepared = root.reserveDeltaMutation(delta.create()
    .insert('x')
    .modifyAttr('child', delta.create().insert('b'))
    .done())
  const descriptor = Object.getOwnPropertyDescriptor(Y.Type, Symbol.hasInstance)
  /** @type {Uint8Array|null} */
  let update = null
  let poisonCalls = 0
  let failure = null
  doc.on('update', value => { update = value })
  try {
    Object.defineProperty(Y.Type, Symbol.hasInstance, {
      configurable: true,
      value: () => {
        poisonCalls++
        throw new Error('poisoned Y.Type Symbol.hasInstance')
      }
    })
    prepared.apply()
  } catch (error) {
    failure = error
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(Y.Type, Symbol.hasInstance)
    else Object.defineProperty(Y.Type, Symbol.hasInstance, descriptor)
  }
  t.assert(failure === null && poisonCalls === 0 && root.get(0) === 'x', 'reserved mixed write never dispatches mutable hasInstance')
  t.assert(/** @type {Y.Type} */ (root.getAttr('child')).toString() === '<child>ba</child>')
  if (update === null) throw new Error('reserved mixed update was not emitted')
  Y.applyUpdate(remote, update)
  t.assert(remote.get('content').toString() === root.toString(), 'mixed attr update converges')
}

export const testReservedDeltaMutationCapturesNativeSetConstructor = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  const remote = new Y.Doc()
  const prepared = type.reserveDeltaMutation(delta.create().insert('owned').done())
  const NativeSet = globalThis.Set
  /** @type {Uint8Array|null} */
  let update = null
  let poisonCalls = 0
  let failure = null
  doc.on('update', value => { update = value })
  doc.on('beforeTransaction', () => {
    const PoisonedSet = function () {
      poisonCalls++
      throw new Error('poisoned global Set')
    }
    globalThis.Set = /** @type {any} */ (PoisonedSet)
  })
  try {
    prepared.apply()
  } catch (error) {
    failure = error
  } finally {
    globalThis.Set = NativeSet
  }
  t.assert(failure === null && poisonCalls === 0 && type.toString() === 'owned', 'reserved execution captures native Set construction')
  if (update === null) throw new Error('reserved Set-poison update was not emitted')
  Y.applyUpdate(remote, update)
  t.assert(remote.get('content').toString() === 'owned')
}

export const testReservedDeltaMutationCanonicalSplitAndFactories = () => {
  {
    const doc = new Y.Doc()
    const type = doc.get('content')
    type.applyDelta(delta.create().insert('prefix').done())
    const prepared = type.reserveDeltaMutation(delta.create().insert('P').delete(1).done())
    const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'slice')
    let failure = null
    try {
      // eslint-disable-next-line no-extend-native
      Object.defineProperty(String.prototype, 'slice', {
        configurable: true,
        value: () => { throw new Error('poisoned String.slice') }
      })
      prepared.apply()
    } catch (error) {
      failure = error
    } finally {
      // eslint-disable-next-line no-extend-native
      Object.defineProperty(String.prototype, 'slice', /** @type {PropertyDescriptor} */ (descriptor))
    }
    t.assert(failure === null && type.toString() === 'Prefix', 'reserved splits use the captured string kernel')
  }

  {
    const doc = new Y.Doc()
    const type = doc.get('content')
    const prepared = type.reserveDeltaMutation(delta.create().insert('prefix').insert([{ owned: true }]).done())
    const anyDescriptor = Object.getOwnPropertyDescriptor(ContentAny.prototype, 'arr')
    const leftDescriptor = Object.getOwnPropertyDescriptor(Item.prototype, 'left')
    let setterCalls = 0
    let failure = null
    try {
      Object.defineProperty(ContentAny.prototype, 'arr', {
        configurable: true,
        get: () => undefined,
        set: () => {
          setterCalls++
          throw new Error('inherited ContentAny setter')
        }
      })
      Object.defineProperty(Item.prototype, 'left', {
        configurable: true,
        get: () => undefined,
        set: () => {
          setterCalls++
          throw new Error('inherited Item setter')
        }
      })
      prepared.apply()
    } catch (error) {
      failure = error
    } finally {
      if (anyDescriptor === undefined) Reflect.deleteProperty(ContentAny.prototype, 'arr')
      else Object.defineProperty(ContentAny.prototype, 'arr', anyDescriptor)
      if (leftDescriptor === undefined) Reflect.deleteProperty(Item.prototype, 'left')
      else Object.defineProperty(Item.prototype, 'left', leftDescriptor)
    }
    t.assert(failure === null && setterCalls === 0, 'reserved Item and content factories define canonical own fields')
    t.compare(type.toDeltaDeep().toJSON(), delta.create().insert('prefix').insert([{ owned: true }]).done().toJSON())
  }
}

export const testReservedDeltaMutationRejectsStructuralAccessorsWithoutDispatch = () => {
  {
    const doc = new Y.Doc()
    const type = doc.get('content')
    type.applyDelta(delta.create().insert('base').done())
    const descriptor = Object.getOwnPropertyDescriptor(Item.prototype, 'deleted')
    let getterCalls = 0
    try {
      Object.defineProperty(Item.prototype, 'deleted', {
        configurable: true,
        get: () => {
          getterCalls++
          type.setAttr('side-effect', true)
          return false
        }
      })
      assertNamedFailure(() => type.reserveDeltaMutation(delta.create().delete(1).done()), 'DeltaMutationStaleError')
    } finally {
      Object.defineProperty(Item.prototype, 'deleted', /** @type {PropertyDescriptor} */ (descriptor))
    }
    t.assert(getterCalls === 0 && type.getAttr('side-effect') === undefined && type.toString() === 'base', 'Item.deleted admission never invokes a poisoned getter')
  }

  {
    const doc = new Y.Doc()
    const root = doc.get('content')
    root.applyDelta(delta.create().insert([delta.create('child').insert('owned')]).done())
    const child = /** @type {Y.Type} */ (root.get(0))
    const startDescriptor = Object.getOwnPropertyDescriptor(child, '_start')
    let getterCalls = 0
    try {
      Object.defineProperty(child, '_start', {
        configurable: true,
        get: () => {
          getterCalls++
          root.setAttr('side-effect', true)
          return null
        }
      })
      assertNamedFailure(
        () => root.reserveDeltaMutation(delta.create().modify(delta.create().insert('x')).done()),
        'DeltaMutationPreparationError'
      )
    } finally {
      Object.defineProperty(child, '_start', /** @type {PropertyDescriptor} */ (startDescriptor))
    }
    t.assert(getterCalls === 0 && root.getAttr('side-effect') === undefined, 'descendant preparation reads own descriptors only')

    const prepared = root.reserveDeltaMutation(delta.create().modify(delta.create().insert('x')).done())
    let callbackCalled = false
    getterCalls = 0
    try {
      Object.defineProperty(child, '_start', {
        configurable: true,
        get: () => {
          getterCalls++
          return null
        }
      })
      assertNamedFailure(
        () => prepared.apply({ afterMutation: () => { callbackCalled = true } }),
        'DeltaMutationStaleError'
      )
    } finally {
      Object.defineProperty(child, '_start', /** @type {PropertyDescriptor} */ (startDescriptor))
    }
    t.assert(getterCalls === 0 && !callbackCalled && child.toString() === '<child>owned</child>', 'descendant descriptor changes fail before execution')

    const item = /** @type {Item} */ (root._start)
    const content = /** @type {ContentType} */ (item.content)
    const typeDescriptor = Object.getOwnPropertyDescriptor(content, 'type')
    const contentFieldPrepared = root.reserveDeltaMutation(delta.create().modify(delta.create().insert('x')).done())
    getterCalls = 0
    try {
      Object.defineProperty(content, 'type', {
        configurable: true,
        get: () => {
          getterCalls++
          return doc.get('foreign')
        }
      })
      assertNamedFailure(() => contentFieldPrepared.apply(), 'DeltaMutationStaleError')
    } finally {
      Object.defineProperty(content, 'type', /** @type {PropertyDescriptor} */ (typeDescriptor))
    }
    t.assert(getterCalls === 0 && child.toString() === '<child>owned</child>', 'ContentType retargeting accessors fail before execution')

    const leftDescriptor = Object.getOwnPropertyDescriptor(item, 'left')
    const ownFieldPrepared = root.reserveDeltaMutation(delta.create().insert('prefix').done())
    getterCalls = 0
    try {
      Object.defineProperty(item, 'left', {
        configurable: true,
        get: () => {
          getterCalls++
          return item
        }
      })
      assertNamedFailure(() => ownFieldPrepared.apply(), 'DeltaMutationStaleError')
    } finally {
      Object.defineProperty(item, 'left', /** @type {PropertyDescriptor} */ (leftDescriptor))
    }
    t.assert(getterCalls === 0 && root.get(0) === child, 'Item retargeting accessors fail without dispatch or writes')
  }
}

export const testReservedDeltaMutationChargesSerializedOccurrencesAndNames = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  let updates = 0
  doc.on('update', () => { updates++ })
  const shared = { payload: 'x'.repeat(1000) }
  const occurrences = new Array(1000).fill(shared)
  assertNamedFailure(
    () => type.reserveDeltaMutation(delta.create().insert(occurrences).done()),
    'DeltaMutationPreparationError'
  )
  assertNamedFailure(
    () => type.reserveDeltaMutation(delta.create().setAttr('k'.repeat(300000), true).done()),
    'DeltaMutationPreparationError'
  )
  assertNamedFailure(
    () => type.reserveDeltaMutation(delta.create('n'.repeat(300000)).insert('x').done()),
    'DeltaMutationPreparationError'
  )
  const sharedName = delta.create('n'.repeat(60000)).insert('x').done()
  assertNamedFailure(
    () => type.reserveDeltaMutation(delta.create().insert([sharedName, sharedName, sharedName, sharedName]).done()),
    'DeltaMutationPreparationError'
  )
  const sharedAttribute = delta.create('child')
    .setAttr('k'.repeat(30000), 'v'.repeat(30000))
    .done()
  assertNamedFailure(
    () => type.reserveDeltaMutation(delta.create().insert([sharedAttribute, sharedAttribute, sharedAttribute, sharedAttribute]).done()),
    'DeltaMutationPreparationError'
  )
  t.assert(updates === 0 && type.toDeltaDeep().isEmpty(), 'wire-size accounting rejects repeated payloads, keys, and names prewrite')
}

export const testReservedDeltaMutationPrivateAccountingSurvivesIdSetPoison = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  const remoteV1 = new Y.Doc()
  const remoteV2 = new Y.Doc()
  const prepared = type.reserveDeltaMutation(delta.create().insert('reserved').done())
  const descriptor = Object.getOwnPropertyDescriptor(IdSet.prototype, 'add')
  /** @type {Uint8Array|null} */
  let updateV1 = null
  /** @type {Uint8Array|null} */
  let updateV2 = null
  let callbackCalled = false
  let poisoned = false
  doc.on('update', update => { updateV1 = update })
  doc.on('updateV2', update => { updateV2 = update })
  doc.on('beforeTransaction', () => {
    if (poisoned) return
    poisoned = true
    Object.defineProperty(IdSet.prototype, 'add', { configurable: true, value: () => {} })
    type.setAttr('external', 'durable')
  })
  try {
    assertNamedFailure(
      () => prepared.apply({ afterMutation: () => { callbackCalled = true } }),
      'DeltaMutationStaleError'
    )
  } finally {
    Object.defineProperty(IdSet.prototype, 'add', /** @type {PropertyDescriptor} */ (descriptor))
  }
  t.assert(!callbackCalled && type.toString() === '< external="durable" />', 'hidden pre-executor writes reject reserved execution')
  if (updateV1 === null || updateV2 === null) throw new Error('private phase accounting lost the pre-executor write')
  Y.applyUpdate(remoteV1, updateV1)
  Y.applyUpdateV2(remoteV2, updateV2)
  t.assert(remoteV1.get('content').getAttr('external') === 'durable' && remoteV2.get('content').getAttr('external') === 'durable', 'both remote formats converge despite public IdSet poisoning')
}

export const testReservedDeltaMutationRejectsActiveRendererDependencies = () => {
  const base = new Y.Doc({ gc: false })
  const suggestion = new Y.Doc({ gc: false })
  base.get('content').applyDelta(delta.create().insert('base').done())
  const renderer = Y.createDiffRenderer(base, suggestion, { attrs: new Y.Attributions() })
  const type = suggestion.get('content')
  const prepared = type.reserveDeltaMutation(delta.create().insert('reserved').done(), null, { renderer })
  let updates = 0
  suggestion.on('update', () => { updates++ })
  base.transact(() => {
    assertNamedFailure(() => prepared.apply(), 'DeltaMutationStaleError')
  })
  t.assert(updates === 0 && type.toString() === '', 'active renderer dependencies cannot retarget a reserved cursor')
}

export const testReservedDeltaMutationRejectsPoisonedExecutionKernelsPrewrite = () => {
  /** @type {Array<[object, PropertyKey, boolean]>} */
  const cases = [
    [IdSet.prototype, 'add', false],
    [IdSet.prototype, 'forEach', false],
    [IdSet.prototype, 'isEmpty', false],
    [IdRanges.prototype, 'getIds', false],
    [Item.prototype, 'delete', true],
    [ContentString.prototype, 'getLength', false]
  ]
  for (let index = 0; index < cases.length; index++) {
    const [prototype, key, deleting] = cases[index]
    const doc = new Y.Doc()
    const type = doc.get('content')
    type.applyDelta(delta.create().insert('a').done())
    const createMutation = () => deleting ? delta.create().delete(1).done() : delta.create().insert('x').done()
    const rejected = type.reserveDeltaMutation(createMutation())
    const survivor = type.reserveDeltaMutation(createMutation())
    const staleAfterCommit = type.reserveDeltaMutation(createMutation())
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
    let rejectedCallback = false
    /** @type {any} */
    let survivorCapture = null
    let updates = 0
    doc.on('update', () => { updates++ })
    try {
      Object.defineProperty(prototype, key, {
        configurable: true,
        value: () => { throw new Error(`poisoned ${String(key)}`) }
      })
      assertNamedFailure(
        () => rejected.apply({ afterMutation: () => { rejectedCallback = true } }),
        'DeltaMutationStaleError'
      )
    } finally {
      Object.defineProperty(prototype, key, /** @type {PropertyDescriptor} */ (descriptor))
    }
    t.assert(!rejectedCallback && updates === 0 && type.toString() === 'a', `${String(key)} poisoning is zero-write`)
    survivor.apply({ afterMutation: content => { survivorCapture = content } })
    assertReservedContent(survivorCapture, survivor.reservation)
    t.assert(updates === 1 && type.toString() === (deleting ? '' : 'xa'), `${String(key)} rejection preserves capture, update, and revision accounting`)
    assertNamedFailure(() => staleAfterCommit.apply(), 'DeltaMutationStaleError')
  }
}

export const testReservedDeltaMutationOwnsNestedIntegrationAndGuardsChildFields = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  const integrateDescriptor = Object.getOwnPropertyDescriptor(Y.Type.prototype, '_integrate')
  /** @type {any} */
  let prepared
  try {
    Object.defineProperty(Y.Type.prototype, '_integrate', {
      configurable: true,
      value: () => { throw new Error('mutable nested integration') }
    })
    prepared = type.reserveDeltaMutation(delta.create().insert([delta.create('child').insert('owned')]).done())
  } finally {
    Object.defineProperty(Y.Type.prototype, '_integrate', /** @type {PropertyDescriptor} */ (integrateDescriptor))
  }
  prepared.apply()
  const child = /** @type {Y.Type} */ (type.get(0))
  t.assert(child.doc === doc && child.toString() === '<child>owned</child>', 'prepared nested types use the captured YType integration kernel')

  const guarded = type.reserveDeltaMutation(delta.create().modify(delta.create().insert('x')).done())
  const itemDescriptor = Object.getOwnPropertyDescriptor(child, '_item')
  let getterCalls = 0
  let callbackCalls = 0
  let updates = 0
  doc.on('update', () => { updates++ })
  try {
    Object.defineProperty(child, '_item', {
      configurable: true,
      get: () => {
        getterCalls++
        throw new Error('guarded child getter')
      }
    })
    assertNamedFailure(
      () => guarded.apply({ afterMutation: () => { callbackCalls++ } }),
      'DeltaMutationStaleError'
    )
  } finally {
    Object.defineProperty(child, '_item', /** @type {PropertyDescriptor} */ (itemDescriptor))
  }
  t.assert(getterCalls === 0 && callbackCalls === 0 && updates === 0 && child.toString() === '<child>owned</child>', 'own-data guards reject without invoking child accessors')
}

export const testReservedDeltaMutationAvoidsInheritedArraySetters = () => {
  const indexDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, '0')
  /** @param {any[]} target @param {any} value */
  const defineIndex = (target, value) => Object.defineProperty(target, '0', {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
  {
    const doc = new Y.Doc()
    const type = doc.get('content')
    const sentinel = 'reserved-array-value-c3'
    const prepared = type.reserveDeltaMutation(delta.create().insert([sentinel]).done())
    let setterCalls = 0
    let failure = null
    try {
      // eslint-disable-next-line no-extend-native
      Object.defineProperty(Array.prototype, '0', {
        configurable: true,
        get () { return undefined },
        set (value) {
          if (value === sentinel) {
            setterCalls++
            throw new Error('reserved value setter')
          }
          defineIndex(this, value)
        }
      })
      prepared.apply()
    } catch (error) {
      failure = error
    } finally {
      if (indexDescriptor === undefined) Reflect.deleteProperty(Array.prototype, '0')
      // eslint-disable-next-line no-extend-native
      else Object.defineProperty(Array.prototype, '0', indexDescriptor)
    }
    t.assert(failure === null && setterCalls === 0, 'reserved value grouping defines dense own indices')
    t.compare(type.toArray(), [sentinel])
  }

  {
    const doc = new Y.Doc()
    const type = doc.get('content')
    const prepared = type.reserveDeltaMutation(delta.create().insert('range').done())
    let setterCalls = 0
    let failure = null
    let exact = null
    try {
      // eslint-disable-next-line no-extend-native
      Object.defineProperty(Array.prototype, '0', {
        configurable: true,
        get () { return undefined },
        set (value) {
          if (value !== null && typeof value === 'object' && Number.isSafeInteger(value.client) && Number.isSafeInteger(value.clock) && Number.isSafeInteger(value.length)) {
            setterCalls++
            throw new Error('reserved range setter')
          }
          defineIndex(this, value)
        }
      })
      prepared.apply({ afterMutation: content => { exact = content } })
    } catch (error) {
      failure = error
    } finally {
      if (indexDescriptor === undefined) Reflect.deleteProperty(Array.prototype, '0')
      // eslint-disable-next-line no-extend-native
      else Object.defineProperty(Array.prototype, '0', indexDescriptor)
    }
    t.assert(failure === null && setterCalls === 0, 'exact range freezing defines dense own indices')
    assertReservedContent(/** @type {any} */ (exact), prepared.reservation)
  }
}

export const testReservedDeltaMutationRenderedTombstoneFixParity = () => {
  const base = new Y.Doc({ gc: false })
  base.clientID = 1
  const suggestion = new Y.Doc({ isSuggestionDoc: true, gc: false })
  suggestion.clientID = 2
  const renderer = Y.createDiffRenderer(base, suggestion, { attrs: new Y.Attributions() })
  base.get('content').applyDelta(delta.create().insert([delta.create('paragraph').insert('hello')]).done())
  const type = suggestion.get('content')
  type.useRenderer(renderer)
  t.assert(type.delta !== null)
  const deletedParagraph = /** @type {Y.Type} */ (type.get(0))
  type.applyDelta(delta.create().delete(1).done())
  const mutation = delta.create().modify(delta.create().retain(2).insert('XY')).done()
  let updates = 0
  suggestion.on('update', () => { updates++ })
  const before = Array.from(Y.encodeStateAsUpdate(suggestion))
  const ordinaryFix = type.applyDelta(mutation, null, { renderer })
  const originalFrom = Y.Type.from
  let fix
  try {
    Y.Type.from = () => { throw new Error('mutable type factory') }
    fix = withPoisonedDeltaDispatch(() => type.reserveDeltaMutation(mutation, null, { renderer }).apply())
  } finally {
    Y.Type.from = originalFrom
  }
  t.compare(
    /** @type {delta.DeltaBuilder<any>} */ (fix).toJSON(),
    /** @type {delta.DeltaBuilder<any>} */ (ordinaryFix).toJSON()
  )
  t.assert(updates === 0)
  t.compare(Array.from(Y.encodeStateAsUpdate(suggestion)), before)

  const directMutation = delta.create().retain(2).insert('Q').done()
  const directOrdinaryFix = deletedParagraph.applyDelta(directMutation, null, { renderer })
  const direct = deletedParagraph.reserveDeltaMutation(directMutation, null, { renderer })
  t.compare(
    /** @type {delta.DeltaBuilder<any>} */ (direct.apply()).toJSON(),
    /** @type {delta.DeltaBuilder<any>} */ (directOrdinaryFix).toJSON()
  )

  const attrBase = new Y.Doc({ gc: false })
  const attrSuggestion = new Y.Doc({ isSuggestionDoc: true, gc: false })
  const attrRenderer = Y.createDiffRenderer(attrBase, attrSuggestion, { attrs: new Y.Attributions() })
  const title = attrBase.get('content').setAttr('title', new Y.Type())
  title.applyDelta(delta.create().insert('hi').done())
  const attrType = attrSuggestion.get('content')
  attrType.useRenderer(attrRenderer)
  t.assert(attrType.delta !== null)
  attrType.applyDelta(delta.create().deleteAttr('title').done())
  const attrMutation = delta.create().modifyAttr('title', delta.create().insert('X')).done()
  const attrOrdinaryFix = attrType.applyDelta(attrMutation, null, { renderer: attrRenderer })
  const attrFix = withPoisonedDeltaDispatch(() => attrType.reserveDeltaMutation(
    attrMutation,
    null,
    { renderer: attrRenderer }
  ).apply())
  t.compare(
    /** @type {delta.DeltaBuilder<any>} */ (attrFix).toJSON(),
    /** @type {delta.DeltaBuilder<any>} */ (attrOrdinaryFix).toJSON()
  )
}

export const testReservedDeltaMutationRejectsPostPrepareConstructorSetterBeforeMixedWrite = () => {
  const base = new Y.Doc({ gc: false })
  base.clientID = 1
  const suggestion = new Y.Doc({ isSuggestionDoc: true, gc: false })
  suggestion.clientID = 2
  const renderer = Y.createDiffRenderer(base, suggestion, { attrs: new Y.Attributions() })
  base.get('content').applyDelta(delta.create().insert([
    delta.create('paragraph', {}, 'aa'),
    delta.create('paragraph', {}, 'hello'),
    delta.create('paragraph', {}, 'cc')
  ]).done())
  const type = suggestion.get('content')
  type.useRenderer(renderer)
  t.assert(type.delta !== null)
  type.applyDelta(delta.create().retain(1).delete(1).done())

  const prepared = type.reserveDeltaMutation(delta.create()
    .insert([delta.create('paragraph', {}, 'nn')])
    .retain(1)
    .modify(delta.create().retain(2).insert('XY'))
    .done(), null, { renderer })
  const before = Array.from(Y.encodeStateAsUpdate(suggestion))
  let updates = 0
  let callbackCalls = 0
  let setterCalls = 0
  suggestion.on('update', () => { updates++ })
  const descriptor = Object.getOwnPropertyDescriptor(delta.ModifyOp.prototype, 'value')
  try {
    Object.defineProperty(delta.ModifyOp.prototype, 'value', {
      configurable: true,
      get: () => { throw new Error('mutable constructor dispatch') },
      set: () => {
        setterCalls++
        throw new Error('mutable constructor dispatch')
      }
    })
    assertNamedFailure(
      () => prepared.apply({ afterMutation: () => { callbackCalls++ } }),
      'DeltaMutationStaleError'
    )
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(delta.ModifyOp.prototype, 'value')
    else Object.defineProperty(delta.ModifyOp.prototype, 'value', descriptor)
  }
  t.assert(setterCalls === 0 && updates === 0 && callbackCalls === 0, 'setter admission fails before executor dispatch')
  t.compare(Array.from(Y.encodeStateAsUpdate(suggestion)), before)
  const rendered = JSON.stringify(type.toDelta({ deep: true }).toJSON())
  t.assert(!rendered.includes('nn') && !rendered.includes('XY'), 'mixed live and tombstone mutation performs no partial write')
  assertNamedFailure(() => prepared.apply(), 'DeltaMutationCapabilityError')
}

export const testReservedDeltaMutationRenderedTombstoneNodeFormatFixParity = () => {
  const base = new Y.Doc({ gc: false })
  base.clientID = 1
  const suggestion = new Y.Doc({ isSuggestionDoc: true, gc: false })
  suggestion.clientID = 2
  const renderer = Y.createDiffRenderer(base, suggestion, { attrs: new Y.Attributions() })
  const baseType = base.get('content')
  baseType.applyDelta(delta.create().insert([
    delta.create('paragraph', {}, 'aa'),
    delta.create('paragraph', {}, 'bb')
  ]).done())
  baseType.applyDelta(delta.create().retain(2, { align: 'x' }).done())
  const type = suggestion.get('content')
  type.useRenderer(renderer)
  t.assert(type.delta !== null)
  type.applyDelta(delta.create().retain(1).delete(1).done())

  const createMutation = () => delta.create()
    .retain(1)
    .modify(delta.create(), { align: 'y' })
    .done()
  const before = Array.from(Y.encodeStateAsUpdate(suggestion))
  let updates = 0
  suggestion.on('update', () => { updates++ })
  const ordinaryFix = type.applyDelta(createMutation(), null, { renderer })
  const reservedMutation = createMutation()
  const reservedFix = withPoisonedDeltaDispatch(() => type.reserveDeltaMutation(reservedMutation, null, { renderer }).apply())
  t.compare(
    /** @type {delta.DeltaBuilder<any>} */ (reservedFix).toJSON(),
    /** @type {delta.DeltaBuilder<any>} */ (ordinaryFix).toJSON()
  )
  t.compare(
    /** @type {delta.DeltaBuilder<any>} */ (reservedFix).toJSON(),
    delta.create().retain(1).modify(delta.create(), { align: 'x' }).done().toJSON()
  )
  t.assert(updates === 0)
  t.compare(Array.from(Y.encodeStateAsUpdate(suggestion)), before)
}

export const testReservedDeltaMutationRejectsMalformedNamesKeysAndOversizeGraphs = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  let updates = 0
  doc.on('update', () => { updates++ })

  const invalidName = delta.create().insert('x')
  invalidName.name = /** @type {any} */ (42)
  assertNamedFailure(() => type.reserveDeltaMutation(invalidName), 'DeltaMutationPreparationError')
  const invalidNestedName = delta.create().insert([delta.create('p').insert('x')])
  const invalidNestedOp = /** @type {any} */ (invalidNestedName.children.start)
  invalidNestedOp.insert[0].name = 42
  assertNamedFailure(() => type.reserveDeltaMutation(invalidNestedName), 'DeltaMutationPreparationError')
  assertNamedFailure(
    () => type.reserveDeltaMutation(delta.create().setAttr(/** @type {any} */ (1), true).done()),
    'DeltaMutationPreparationError'
  )

  /** @type {any} */
  let nested = delta.create('leaf').insert('x')
  for (let index = 0; index < 300; index++) nested = delta.create(`n${index}`).insert([nested])
  assertNamedFailure(
    () => type.reserveDeltaMutation(delta.create().insert([nested]).done()),
    'DeltaMutationPreparationError'
  )

  const structuralNodes = delta.create()
  for (let index = 0; index < 2100; index++) structuralNodes.insert('x').delete(1)
  assertNamedFailure(
    () => type.reserveDeltaMutation(structuralNodes.done()),
    'DeltaMutationPreparationError'
  )

  /** @type {any} */
  let payload = { leaf: true }
  for (let index = 0; index < 10000; index++) payload = { child: payload }
  assertNamedFailure(
    () => type.reserveDeltaMutation(delta.create().setAttr('payload', payload).done()),
    'DeltaMutationPreparationError'
  )
  const payloadNodes = new Array(8200)
  for (let index = 0; index < payloadNodes.length; index++) payloadNodes[index] = {}
  assertNamedFailure(
    () => type.reserveDeltaMutation(delta.create().setAttr('payload', payloadNodes).done()),
    'DeltaMutationPreparationError'
  )

  const primitiveInsert = new Array(250000).fill(0)
  assertNamedFailure(
    () => type.reserveDeltaMutation(delta.create().insert(primitiveInsert).done()),
    'DeltaMutationPreparationError'
  )

  /** @type {any} */
  let shared = delta.create('leaf').insert('x').done()
  for (let depth = 0; depth < 16; depth++) {
    shared = delta.create(`shared${depth}`).insert([shared, shared]).done()
  }
  const sharedStart = Date.now()
  assertNamedFailure(
    () => type.reserveDeltaMutation(delta.create().insert([shared]).done()),
    'DeltaMutationPreparationError'
  )
  t.assert(Date.now() - sharedStart < 2000, 'expanded shared-DAG cost rejects without exponential materialization')
  t.assert(updates === 0 && type.toDeltaDeep().isEmpty(), 'all resource and shape failures are prewrite')
}

export const testReservedDeltaMutationDispatchGuardDoesNotInvokeGetter = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  const prepared = type.reserveDeltaMutation(delta.create().insert('reserved').done())
  let getterCalls = 0
  Object.defineProperty(type, 'applyDelta', {
    configurable: true,
    get: () => {
      getterCalls++
      Y.Type.prototype.applyDelta.call(type, delta.create().insert('external').done())
      return Y.Type.prototype.applyDelta
    }
  })
  try {
    assertNamedFailure(() => prepared.apply(), 'DeltaMutationStaleError')
  } finally {
    Reflect.deleteProperty(type, 'applyDelta')
  }
  t.assert(getterCalls === 0 && type.toString() === '', 'dispatch admission is side-effect-free')
}

export const testTransactionSetupHookFailuresCleanUp = () => {
  for (const event of /** @type {Array<'beforeAllTransactions'|'beforeTransaction'>} */ (['beforeAllTransactions', 'beforeTransaction'])) {
    const doc = new Y.Doc()
    const type = doc.get('content')
    const sentinel = new Error(event)
    let callbackCalls = 0
    let throwHook = true
    let throwCleanup = true
    let updates = 0
    doc.on('update', () => { updates++ })
    doc.on(event, () => {
      if (throwHook) throw sentinel
    })
    doc.on('afterTransactionCleanup', () => {
      if (throwCleanup) {
        throwCleanup = false
        throw new Error('cleanup failure must not replace setup failure')
      }
    })
    let caught = null
    try {
      doc.transact(() => { callbackCalls++ })
    } catch (error) {
      caught = error
    }
    t.assert(caught === sentinel && callbackCalls === 0, `${event} preserves the setup error`)
    t.assert(doc._transaction === null && doc._transactionCleanups.length === 0, `${event} leaves no transaction state`)
    throwHook = false
    type.applyDelta(delta.create().insert('usable').done())
    t.assert(type.toString() === 'usable' && updates === 1, `${event} leaves the document usable`)
  }
}

export const testReservedDeltaMutationNestedPolymorphism = () => {
  let overrideCalls = 0
  let liveCalls = 0
  class PolymorphicType extends Y.Type {
    /**
     * @param {delta.DeltaAny} mutation
     * @param {any} [origin]
     * @param {any} [options]
     */
    applyDelta (mutation, origin, options) {
      overrideCalls++
      if (this.doc?._transaction !== null) liveCalls++
      return super.applyDelta(mutation, origin, options)
    }
  }
  const doc = new Y.Doc()
  const type = doc.get('content')
  const child = new PolymorphicType('child')
  const attr = new PolymorphicType('attr')
  child.applyDelta(delta.create().insert('a').done())
  attr.applyDelta(delta.create().insert('b').done())
  type.applyDelta(delta.create().insert([child]).setAttr('nested', attr).done())
  overrideCalls = 0
  liveCalls = 0
  const mutation = delta.create()
    .modify(delta.create().insert('x'))
    .modifyAttr('nested', delta.create().insert('y'))
    .done()
  type.applyDelta(mutation)
  t.assert(overrideCalls === 2 && liveCalls === 2, 'ordinary nested overrides run in the parent transaction')
  t.assert(child.toString() === '<child>xa</child>' && attr.toString() === '<attr>yb</attr>')

  let updates = 0
  doc.on('update', () => { updates++ })
  const before = Y.encodeStateAsUpdate(doc)
  assertNamedFailure(
    () => type.reserveDeltaMutation(delta.create()
      .modify(delta.create().insert('reserved'))
      .modifyAttr('nested', delta.create().insert('reserved'))
      .done()),
    'DeltaMutationPreparationError'
  )
  t.assert(updates === 0, 'reserved custom dispatch fails before writes')
  t.compare(Array.from(Y.encodeStateAsUpdate(doc)), Array.from(before))

  const guardedDoc = new Y.Doc()
  const guardedRoot = guardedDoc.get('content')
  const guardedChild = new Y.Type('child')
  guardedChild.applyDelta(delta.create().insert('a').done())
  guardedRoot.applyDelta(delta.create().insert([guardedChild]).done())
  const prepared = guardedRoot.reserveDeltaMutation(delta.create().modify(delta.create().insert('x')).done())
  let callbackCalled = false
  guardedChild.applyDelta = () => { throw new Error('unsafe override') }
  assertNamedFailure(
    () => prepared.apply({ afterMutation: () => { callbackCalled = true } }),
    'DeltaMutationStaleError'
  )
  t.assert(!callbackCalled && guardedChild.toString() === '<child>a</child>', 'post-prepare dispatch mutation runs no executor')
}

export const testReservedDeltaMutationDeepGraphOwnedOnce = () => {
  const depth = 128
  /** @type {any} */
  let nested = delta.create('leaf').insert('x')
  let cloneCalls = 0
  const nestedTextOp = /** @type {any} */ (nested.children.start)
  nestedTextOp.clone = () => {
    cloneCalls++
    throw new Error('caller clone dispatch')
  }
  for (let index = 0; index < depth; index++) {
    nested = delta.create(`n${index}`).insert([nested])
  }
  const doc = new Y.Doc()
  const type = doc.get('content')
  const prepared = type.reserveDeltaMutation(delta.create().insert([nested]).done())
  prepared.apply()
  t.assert(cloneCalls === 0, 'deep ownership reconstructs each structural op without caller clone dispatch')
}

export const testReservedDeltaMutationCallbackFailureIsFatal = () => {
  const doc = new Y.Doc()
  const type = doc.get('content')
  const prepared = type.reserveDeltaMutation(delta.create().insert('content').done())
  assertNamedFailure(() => prepared.apply({
    afterMutation: () => {
      type.setAttr('ledger', true)
      throw new Error('trusted callback violated noexcept contract')
    }
  }), 'DeltaMutationInvariantError')
  const committed = type.toDeltaDeep().children.start
  t.assert(delta.$textOp.check(committed) && committed.insert === 'content' && type.getAttr('ledger') === true, 'trusted callback failure is fatal with no rollback')
  assertNamedFailure(() => prepared.apply(), 'DeltaMutationCapabilityError')
}

export const testReservedDeltaMutationScaleProbes = () => {
  const text = 'x'.repeat(100000)
  const insertDoc = new Y.Doc()
  insertDoc.clientID = 31
  const insertType = insertDoc.get('content')
  const insert = insertType.reserveDeltaMutation(delta.create().insert(text).done())
  /** @type {any} */
  let exact = null
  insert.apply({ afterMutation: content => { exact = content } })
  assertReservedContent(exact, insert.reservation)
  t.assert(insert.reservation.rangeCountUpperBound === 1 && exact.inserts.length === 1 && exact.inserts[0].length === 100000)

  const deleteDoc = new Y.Doc()
  deleteDoc.clientID = 32
  const deleteType = deleteDoc.get('content')
  deleteType.applyDelta(delta.create().insert(text).done())
  const deletion = deleteType.reserveDeltaMutation(delta.create().delete(100000).done())
  deletion.apply({ afterMutation: content => { exact = content } })
  assertReservedContent(exact, deletion.reservation)
  t.assert(deletion.reservation.rangeCountUpperBound === 1 && exact.deletes.length === 1 && exact.deletes[0].length === 100000)

  const formatDoc = new Y.Doc()
  formatDoc.clientID = 33
  const formatType = formatDoc.get('content')
  formatType.applyDelta(delta.create().insert(text).done())
  const formatting = formatType.reserveDeltaMutation(delta.create().retain(100000, { bold: {} }).done())
  formatting.apply({ afterMutation: content => { exact = content } })
  assertReservedContent(exact, formatting.reservation)
  t.assert(formatting.reservation.rangeCountUpperBound === 1 && exact.inserts.length === 1 && exact.inserts[0].length === 2)
}

export const testReservedDeltaMutationRangeSnapshotScaling = () => {
  const sizes = [2000, 4000, 8000]
  for (let sizeIndex = 0; sizeIndex < sizes.length; sizeIndex++) {
    const size = sizes[sizeIndex]
    const ids = reservedMutationIdSetRuntime.create()
    for (let client = size; client > 0; client--) {
      reservedMutationIdSetRuntime.add(ids, client, 0, 1)
      reservedMutationIdSetRuntime.add(ids, client, 1, 1)
    }
    const snapshot = reservedMutationIdSetRuntime.snapshotRanges(ids)
    t.assert(snapshot.length === size && snapshot[0].client === 1 && snapshot[size - 1].client === size)
    for (let index = 1; index < snapshot.length; index++) {
      t.assert(snapshot[index - 1].client < snapshot[index].client, 'range snapshot has deterministic client ordering')
    }
  }

  /** @type {number[]} */
  const descriptorReads = []
  for (let sizeIndex = 0; sizeIndex < sizes.length; sizeIndex++) {
    const size = sizes[sizeIndex]
    const ids = reservedMutationIdSetRuntime.create()
    for (let range = size; range > 0; range--) reservedMutationIdSetRuntime.add(ids, 1, range * 2, 1)
    const ranges = ids.clients.get(1)
    if (ranges === undefined) throw new Error('missing range scaling fixture')
    const rangeValues = /** @type {any[]} */ (/** @type {any} */ (ranges)._ids)
    let reads = 0
    for (let index = 0; index < rangeValues.length; index++) {
      const range = rangeValues[index]
      Object.defineProperty(rangeValues, index, {
        configurable: true,
        enumerable: true,
        value: new Proxy(range, {
          getOwnPropertyDescriptor: (target, key) => {
            if (key === 'clock' || key === 'len') reads++
            return Reflect.getOwnPropertyDescriptor(target, key)
          }
        }),
        writable: true
      })
    }
    const snapshot = reservedMutationIdSetRuntime.snapshotRanges(ids)
    descriptorReads.push(reads)
    t.assert(snapshot.length === size && snapshot[0].clock === 2 && snapshot[size - 1].clock === size * 2)
    t.assert(reads <= size * 20, `range snapshot descriptor work is linear: ${size} ranges, ${reads} reads`)
  }
  t.assert(
    descriptorReads[1] <= descriptorReads[0] * 2 + 32 && descriptorReads[2] <= descriptorReads[1] * 2 + 32,
    `doubling ranges only doubles descriptor work: ${descriptorReads.join(', ')}`
  )
}

export const testReservedDeltaMutationDeterministicFuzz = () => {
  let seed = 0xA2001
  /** @param {number} bound */
  const random = bound => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % bound
  }
  const doc = new Y.Doc()
  const type = doc.get('content')
  type.applyDelta(delta.create().insert('abcdefghij').done())
  let length = 10
  for (let iteration = 0; iteration < 128; iteration++) {
    const mutation = delta.create()
    if (random(3) === 0 && length > 0) {
      const start = random(length)
      const formatted = 1 + random(length - start)
      if (start > 0) mutation.retain(start)
      mutation.retain(formatted, { fuzz: iteration % 2 === 0 ? {} : null })
    } else {
      const start = random(length + 1)
      const removed = random(length - start + 1)
      const inserted = random(5)
      if (start > 0) mutation.retain(start)
      if (removed > 0) mutation.delete(removed)
      const text = String(iteration).slice(0, Math.max(1, inserted))
      mutation.insert(text)
      length += text.length - removed
    }
    const prepared = type.reserveDeltaMutation(mutation.done())
    /** @type {any} */
    let exact = null
    prepared.apply({ afterMutation: content => { exact = content } })
    assertReservedContent(exact, prepared.reservation)
  }
}

export const testReservedDeltaMutationOrdinaryParity = () => {
  const createState = () => {
    const doc = new Y.Doc({ guid: 'ordinary-parity' })
    doc.clientID = 41
    const type = doc.get('content')
    type.applyDelta(delta.create().insert('abcdef').setAttr('old', true).done())
    return { doc, type }
  }
  const createMutation = () => delta.create()
    .retain(1)
    .delete(2)
    .insert('XY')
    .retain(2, { italic: {} })
    .setAttr('meta', { value: 1 })
    .deleteAttr('old')
    .done()
  const ordinary = createState()
  const reserved = createState()
  const origin = { parity: true }
  /** @type {Uint8Array[]} */
  const ordinaryUpdatesV1 = []
  /** @type {Uint8Array[]} */
  const reservedUpdatesV1 = []
  /** @type {Uint8Array[]} */
  const ordinaryUpdatesV2 = []
  /** @type {Uint8Array[]} */
  const reservedUpdatesV2 = []
  /** @type {any[]} */
  const ordinaryOriginsV1 = []
  /** @type {any[]} */
  const reservedOriginsV1 = []
  /** @type {any[]} */
  const ordinaryOriginsV2 = []
  /** @type {any[]} */
  const reservedOriginsV2 = []
  /** @type {any[]} */
  const ordinaryEvents = []
  /** @type {any[]} */
  const reservedEvents = []
  /** @type {any[]} */
  const ordinaryEventOrigins = []
  /** @type {any[]} */
  const reservedEventOrigins = []
  ordinary.doc.on('update', (update, observedOrigin) => {
    ordinaryUpdatesV1.push(update)
    ordinaryOriginsV1.push(observedOrigin)
  })
  reserved.doc.on('update', (update, observedOrigin) => {
    reservedUpdatesV1.push(update)
    reservedOriginsV1.push(observedOrigin)
  })
  ordinary.doc.on('updateV2', (update, observedOrigin) => {
    ordinaryUpdatesV2.push(update)
    ordinaryOriginsV2.push(observedOrigin)
  })
  reserved.doc.on('updateV2', (update, observedOrigin) => {
    reservedUpdatesV2.push(update)
    reservedOriginsV2.push(observedOrigin)
  })
  ordinary.type.observe(event => {
    ordinaryEvents.push({
      childListChanged: /** @type {any} */ (event).childListChanged,
      delta: event.delta.toJSON(),
      deltaDeep: event.deltaDeep.toJSON(),
      keysChanged: Array.from(event.keysChanged)
    })
    ordinaryEventOrigins.push(event.transaction.origin)
  })
  reserved.type.observe(event => {
    reservedEvents.push({
      childListChanged: /** @type {any} */ (event).childListChanged,
      delta: event.delta.toJSON(),
      deltaDeep: event.deltaDeep.toJSON(),
      keysChanged: Array.from(event.keysChanged)
    })
    reservedEventOrigins.push(event.transaction.origin)
  })
  const ordinaryFix = ordinary.type.applyDelta(createMutation(), origin)
  const prepared = reserved.type.reserveDeltaMutation(createMutation(), origin)
  const reservedFix = prepared.apply()
  t.assert(ordinaryFix === null && reservedFix === null)
  t.assert(ordinaryUpdatesV1.length === 1 && reservedUpdatesV1.length === 1)
  t.assert(ordinaryUpdatesV2.length === 1 && reservedUpdatesV2.length === 1)
  t.compare(Array.from(ordinaryUpdatesV1[0]), Array.from(reservedUpdatesV1[0]))
  t.compare(Array.from(ordinaryUpdatesV2[0]), Array.from(reservedUpdatesV2[0]))
  t.compare(Array.from(Y.encodeStateAsUpdate(ordinary.doc)), Array.from(Y.encodeStateAsUpdate(reserved.doc)))
  t.compare(Array.from(Y.encodeStateAsUpdateV2(ordinary.doc)), Array.from(Y.encodeStateAsUpdateV2(reserved.doc)))
  t.compare(Array.from(Y.encodeStateVector(ordinary.doc)), Array.from(Y.encodeStateVector(reserved.doc)))
  t.assert(ordinaryOriginsV1[0] === origin && reservedOriginsV1[0] === origin)
  t.assert(ordinaryOriginsV2[0] === origin && reservedOriginsV2[0] === origin)
  t.assert(ordinaryEventOrigins[0] === origin && reservedEventOrigins[0] === origin)
  t.compare(ordinaryEvents, reservedEvents)
  t.compare(ordinary.type.toDeltaDeep().toJSON(), reserved.type.toDeltaDeep().toJSON())
}
