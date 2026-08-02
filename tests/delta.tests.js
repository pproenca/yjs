import * as Y from '../src/index.js'
import * as delta from 'lib0/delta'
import * as t from 'lib0/testing'
import * as s from 'lib0/schema'

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
  Object.defineProperty(malicious, 'isEmpty', {
    value: () => {
      type.applyDelta(delta.create().insert('caller write').done())
      return false
    }
  })
  assertNamedFailure(() => type.reserveDeltaMutation(malicious), 'DeltaMutationStaleError')
  t.assert(updates === 1 && type.toString() === 'caller write', 'pre-scan revision capture rejects caller reentrancy')

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
  const ordinaryUpdates = []
  /** @type {Uint8Array[]} */
  const reservedUpdates = []
  /** @type {any[]} */
  const ordinaryOrigins = []
  /** @type {any[]} */
  const reservedOrigins = []
  let ordinaryEvents = 0
  let reservedEvents = 0
  ordinary.doc.on('update', (update, observedOrigin) => {
    ordinaryUpdates.push(update)
    ordinaryOrigins.push(observedOrigin)
  })
  reserved.doc.on('update', (update, observedOrigin) => {
    reservedUpdates.push(update)
    reservedOrigins.push(observedOrigin)
  })
  ordinary.type.observe(() => { ordinaryEvents++ })
  reserved.type.observe(() => { reservedEvents++ })
  const ordinaryFix = ordinary.type.applyDelta(createMutation(), origin)
  const prepared = reserved.type.reserveDeltaMutation(createMutation(), origin)
  const reservedFix = prepared.apply()
  t.assert(ordinaryFix === null && reservedFix === null)
  t.assert(ordinaryUpdates.length === 1 && reservedUpdates.length === 1)
  t.compare(Array.from(ordinaryUpdates[0]), Array.from(reservedUpdates[0]))
  t.compare(Array.from(Y.encodeStateAsUpdate(ordinary.doc)), Array.from(Y.encodeStateAsUpdate(reserved.doc)))
  t.assert(ordinaryOrigins[0] === origin && reservedOrigins[0] === origin)
  t.assert(ordinaryEvents === 1 && reservedEvents === 1)
  t.compare(ordinary.type.toDeltaDeep().toJSON(), reserved.type.toDeltaDeep().toJSON())
}
