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
  const prepared = type.reserveDeltaMutation(mutation, null, { renderer })
  const listPrototype = Object.getPrototypeOf(mutation.children)
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(listPrototype, Symbol.iterator)
  const schemaChecks = [delta.$deltaAny, delta.$modifyOp, delta.$retainOp, delta.$insertOp, delta.$deleteOp]
  const originalFrom = Y.Type.from
  let fix
  try {
    Object.defineProperty(delta.DeltaBuilder.prototype, 'isEmpty', {
      configurable: true,
      value: () => { throw new Error('mutable fix dispatch') }
    })
    Object.defineProperty(listPrototype, Symbol.iterator, {
      configurable: true,
      value: () => { throw new Error('mutable fix list dispatch') }
    })
    for (let index = 0; index < schemaChecks.length; index++) {
      Object.defineProperty(schemaChecks[index], 'check', {
        configurable: true,
        value: () => { throw new Error('mutable schema dispatch') }
      })
    }
    Y.Type.from = () => { throw new Error('mutable type factory') }
    fix = prepared.apply()
  } finally {
    Reflect.deleteProperty(delta.DeltaBuilder.prototype, 'isEmpty')
    Object.defineProperty(listPrototype, Symbol.iterator, /** @type {PropertyDescriptor} */ (iteratorDescriptor))
    for (let index = 0; index < schemaChecks.length; index++) Reflect.deleteProperty(schemaChecks[index], 'check')
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
  const attrFix = attrType.reserveDeltaMutation(
    attrMutation,
    null,
    { renderer: attrRenderer }
  ).apply()
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
  const reservedFix = type.reserveDeltaMutation(createMutation(), null, { renderer }).apply()
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
    doc.on('afterTransaction', () => {
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
