import { encodeAny } from 'lib0/buffer'

const applyIntrinsic = Reflect.apply
const definePropertyIntrinsic = Object.defineProperty
const getOwnPropertyDescriptorIntrinsic = Object.getOwnPropertyDescriptor
const getPrototypeOfIntrinsic = Object.getPrototypeOf
const hasOwnPropertyIntrinsic = Object.prototype.hasOwnProperty
const mapGetIntrinsic = Map.prototype.get
const mapSetIntrinsic = Map.prototype.set
const objectIsIntrinsic = Object.is
const setAddIntrinsic = Set.prototype.add
const setClearIntrinsic = Set.prototype.clear
const setDeleteIntrinsic = Set.prototype.delete
const setForEachIntrinsic = Set.prototype.forEach
const setHasIntrinsic = Set.prototype.has
const setSizeDescriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Set.prototype, 'size'))
const setSizeGetter = /** @type {function():number} */ (setSizeDescriptor.get)
const weakMapDeleteIntrinsic = WeakMap.prototype.delete
const weakMapGetIntrinsic = WeakMap.prototype.get
const weakMapHasIntrinsic = WeakMap.prototype.has
const weakMapSetIntrinsic = WeakMap.prototype.set

/** @type {WeakMap<object,DocLifecycle>} */
const docLifecycles = new WeakMap()
/** @type {WeakMap<object,ConstructionPermit>} */
const constructionPermits = new WeakMap()
/** @type {WeakMap<object,PreparedAuthority>} */
const preparedAuthorities = new WeakMap()
/** @type {WeakMap<object,TransactionLifecycle>} */
const transactionLifecycles = new WeakMap()
/** @type {WeakMap<object,DocDestroyAttempt>} */
const docDestroyAttempts = new WeakMap()
const constructionPermitKey = Symbol('doc-construction-permit')

const constructionFields = [
  '_item',
  'autoLoad',
  'clientID',
  'collectionid',
  'gc',
  'guid',
  'isSuggestionDoc',
  'meta',
  'shouldLoad',
  'sparseExactResolution'
]

/**
 * @typedef {'constructed'|'prepared'|'adopting'|'adopted'|'revoked'|'destroyed'} DocLifecyclePhase
 * @typedef {{parentDoc:object,item:{deleted:boolean,content:object},content:{doc:object|null,opts:object},destroy:function():void,destroyIntrinsic:function():void}|null} DocAttachment
 * @typedef {{phase:DocLifecyclePhase,descriptors:Map<string,PropertyDescriptor>|null,attachment:DocAttachment,authority:object|null,destroyIntrinsic:function():void,subdocs:Set<object>,pendingSubdocs:Set<object>}} DocLifecycle
 * @typedef {{token:object,prototype:object,open:boolean,doc:object|null}} ConstructionPermit
 * @typedef {{doc:object,item:object,content:object,token:object,owner:'preparation'|'transaction'|'attachment'|'revoked',transaction:object|null}} PreparedAuthority
 * @typedef {{doc:object,item:object,content:object,destroy:function():void,token:object|null,shouldLoad:boolean,claimed:boolean,attached:boolean,clientIDDescriptor:PropertyDescriptor,collectionDescriptor:PropertyDescriptor,itemDescriptor:PropertyDescriptor}} SubdocAdoption
 * @typedef {{done:boolean,run:()=>void}} DocDestroyTask
 * @typedef {{doc:object,active:boolean,running:boolean,ownershipCommitted:boolean,attachment:DocAttachment,previousPhase:DocLifecyclePhase,previousAuthority:object|null,isDestroyedDescriptor:PropertyDescriptor,replacement:object|null,tasks:Array<DocDestroyTask>|null}} DocDestroyAttempt
 * @typedef {{doc:object,parentSubdocs:Set<object>|null,parentSubdocsDescriptor:PropertyDescriptor|null,publicAdded:Set<object>,publicRemoved:Set<object>,publicLoaded:Set<object>,publicAddedDescriptor:PropertyDescriptor,publicRemovedDescriptor:PropertyDescriptor,publicLoadedDescriptor:PropertyDescriptor,added:Set<object>|null,removed:Set<object>|null,loaded:Set<object>|null,byItem:Map<object,SubdocAdoption>|null,byDoc:Map<object,SubdocAdoption>|null,records:Array<SubdocAdoption>|null,effectiveClientID:number|null,metadataFinalized:boolean}} TransactionLifecycle
 */

/** @param {object} target @param {PropertyKey} key */
const hasOwn = (target, key) => applyIntrinsic(hasOwnPropertyIntrinsic, target, [key])
/** @template T @param {Array<T>} target @param {T} value */
const appendArrayValue = (target, value) => {
  applyIntrinsic(definePropertyIntrinsic, Object, [target, target.length, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  }])
}

/** @param {object} target @param {PropertyKey} key */
const getOwnDescriptor = (target, key) => applyIntrinsic(getOwnPropertyDescriptorIntrinsic, Object, [target, key])

/** @param {PropertyDescriptor|undefined} left @param {PropertyDescriptor|undefined} right */
const equalDescriptors = (left, right) => {
  if (left === undefined || right === undefined) return left === right
  if (left.configurable !== right.configurable || left.enumerable !== right.enumerable) return false
  const leftData = hasOwn(left, 'value')
  const rightData = hasOwn(right, 'value')
  return leftData === rightData && (leftData
    ? left.writable === right.writable && applyIntrinsic(objectIsIntrinsic, Object, [left.value, right.value])
    : left.get === right.get && left.set === right.set)
}

/** @param {Uint8Array} left @param {Uint8Array} right */
const equalBytes = (left, right) => {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** @param {PropertyDescriptor} current @param {PropertyDescriptor} original */
const sameWritableDataShape = (current, original) => {
  return hasOwn(current, 'value') && hasOwn(original, 'value') && current.writable === true &&
    current.writable === original.writable && current.enumerable === original.enumerable && current.configurable === original.configurable
}

/** @param {object} doc */
const requireDocLifecycle = doc => {
  const lifecycle = applyIntrinsic(weakMapGetIntrinsic, docLifecycles, [doc])
  if (lifecycle === undefined) throw new Error('Document identity is not registered')
  return lifecycle
}

/** @param {object} doc */
const getActiveDestroyAttempt = doc => {
  const attempt = applyIntrinsic(weakMapGetIntrinsic, docDestroyAttempts, [doc])
  return attempt !== undefined && attempt.active ? attempt : null
}

/** @param {object} doc @param {DocLifecycle} lifecycle */
const constructionIsStable = (doc, lifecycle) => {
  if (lifecycle.descriptors === null) return false
  for (let index = 0; index < constructionFields.length; index++) {
    const key = constructionFields[index]
    if (!equalDescriptors(
      applyIntrinsic(mapGetIntrinsic, lifecycle.descriptors, [key]),
      getOwnDescriptor(doc, key)
    )) return false
  }
  return true
}

/** @param {object} target @param {string} key */
const requireWritableDataDescriptor = (target, key) => {
  const descriptor = getOwnDescriptor(target, key)
  if (descriptor === undefined || !hasOwn(descriptor, 'value') || descriptor.writable !== true) {
    throw new Error(`Subdocument ${key} must remain a writable data property`)
  }
  return descriptor
}

/** @param {object} doc */
const requireDestroyMethod = doc => {
  let target = doc
  while (target !== null) {
    const descriptor = getOwnDescriptor(target, 'destroy')
    if (descriptor !== undefined) {
      if (!hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new Error('Subdocument destroy must remain a data function')
      }
      return descriptor.value
    }
    target = applyIntrinsic(getPrototypeOfIntrinsic, Object, [target])
  }
  throw new Error('Subdocument destroy must remain callable')
}

/** @param {object} target @param {string} key @param {PropertyDescriptor} descriptor @param {any} value */
const writeOwnDataValue = (target, key, descriptor, value) => {
  applyIntrinsic(definePropertyIntrinsic, Object, [target, key, { ...descriptor, value }])
}

/** @param {object} doc @param {DocDestroyAttempt} attempt */
const writeDocDestroyedState = (doc, attempt) => {
  const current = getOwnDescriptor(doc, 'isDestroyed')
  if (current !== undefined && hasOwn(current, 'value') && current.writable === true) {
    applyIntrinsic(definePropertyIntrinsic, Object, [doc, 'isDestroyed', { value: true }])
  } else if (current !== undefined && current.configurable === true) {
    writeOwnDataValue(doc, 'isDestroyed', attempt.isDestroyedDescriptor, true)
  } else {
    throw new Error('Document destroyed state cannot be finalized')
  }
}

/** @param {object} target @param {PropertyKey} key @param {PropertyDescriptor} descriptor */
const restoreOwnDescriptor = (target, key, descriptor) => {
  applyIntrinsic(definePropertyIntrinsic, Object, [target, key, descriptor])
}

/** @param {object} transaction */
const requireTransactionLifecycle = transaction => {
  const lifecycle = applyIntrinsic(weakMapGetIntrinsic, transactionLifecycles, [transaction])
  if (lifecycle === undefined) throw new Error('Transaction identity is not registered')
  return lifecycle
}

/** @param {TransactionLifecycle} lifecycle */
const captureParentSubdocs = lifecycle => {
  if (lifecycle.parentSubdocsDescriptor !== null) return
  const descriptor = getOwnDescriptor(lifecycle.doc, 'subdocs')
  if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
    throw new Error('Parent subdocuments must remain an own Set')
  }
  const parentSubdocs = descriptor.value
  applyIntrinsic(setSizeGetter, parentSubdocs, [])
  lifecycle.parentSubdocs = parentSubdocs
  lifecycle.parentSubdocsDescriptor = descriptor
}

/** @param {TransactionLifecycle} lifecycle */
const ensureTransactionSubdocSets = lifecycle => {
  if (lifecycle.added === null) {
    captureParentSubdocs(lifecycle)
    lifecycle.added = new Set()
    lifecycle.removed = new Set()
    lifecycle.loaded = new Set()
    applyIntrinsic(setClearIntrinsic, lifecycle.publicAdded, [])
    applyIntrinsic(setClearIntrinsic, lifecycle.publicRemoved, [])
    applyIntrinsic(setClearIntrinsic, lifecycle.publicLoaded, [])
  }
  return {
    added: lifecycle.added,
    removed: /** @type {Set<object>} */ (lifecycle.removed),
    loaded: /** @type {Set<object>} */ (lifecycle.loaded)
  }
}

/** @param {Set<object>} owned @param {Set<object>} mirror @param {object} value */
const addTransactionSubdocSetValue = (owned, mirror, value) => {
  applyIntrinsic(setAddIntrinsic, owned, [value])
  applyIntrinsic(setAddIntrinsic, mirror, [value])
}

/** @param {Set<object>} owned @param {Set<object>} mirror @param {object} value */
const deleteTransactionSubdocSetValue = (owned, mirror, value) => {
  applyIntrinsic(setDeleteIntrinsic, owned, [value])
  applyIntrinsic(setDeleteIntrinsic, mirror, [value])
}

/** @param {TransactionLifecycle} lifecycle */
const ensureTransactionAdoptions = lifecycle => {
  if (lifecycle.byItem === null) {
    lifecycle.byItem = new Map()
    lifecycle.byDoc = new Map()
    lifecycle.records = []
  }
  return {
    byItem: lifecycle.byItem,
    byDoc: /** @type {Map<object,SubdocAdoption>} */ (lifecycle.byDoc),
    records: /** @type {Array<SubdocAdoption>} */ (lifecycle.records)
  }
}

/** @param {Set<object>} source @param {Set<object>} target */
const replaceSetContents = (source, target) => {
  applyIntrinsic(setClearIntrinsic, target, [])
  applyIntrinsic(setForEachIntrinsic, source, [value => applyIntrinsic(setAddIntrinsic, target, [value])])
}

/** @param {object} transaction @param {string} key @param {Set<object>} value @param {PropertyDescriptor} descriptor */
const restoreTransactionSetReference = (transaction, key, value, descriptor) => {
  const current = getOwnDescriptor(transaction, key)
  if (current !== undefined && hasOwn(current, 'value') && current.value === value) return
  try {
    applyIntrinsic(definePropertyIntrinsic, Object, [transaction, key, { ...descriptor, value }])
  } catch (_failure) {
    // Public mirrors are advisory. Private lifecycle records must still publish.
  }
}

/** @param {object} transaction @param {TransactionLifecycle} lifecycle */
const mirrorTransactionSubdocSets = (transaction, lifecycle) => {
  restoreTransactionSetReference(transaction, 'subdocsAdded', lifecycle.publicAdded, lifecycle.publicAddedDescriptor)
  restoreTransactionSetReference(transaction, 'subdocsRemoved', lifecycle.publicRemoved, lifecycle.publicRemovedDescriptor)
  restoreTransactionSetReference(transaction, 'subdocsLoaded', lifecycle.publicLoaded, lifecycle.publicLoadedDescriptor)
  if (lifecycle.added === null) {
    applyIntrinsic(setClearIntrinsic, lifecycle.publicAdded, [])
    applyIntrinsic(setClearIntrinsic, lifecycle.publicRemoved, [])
    applyIntrinsic(setClearIntrinsic, lifecycle.publicLoaded, [])
  } else {
    replaceSetContents(lifecycle.added, lifecycle.publicAdded)
    replaceSetContents(/** @type {Set<object>} */ (lifecycle.removed), lifecycle.publicRemoved)
    replaceSetContents(/** @type {Set<object>} */ (lifecycle.loaded), lifecycle.publicLoaded)
  }
}

/**
 * @param {TransactionLifecycle} transactionLifecycle
 * @param {object} doc
 * @param {object} item
 * @param {object} content
 */
const createOrdinaryAdoption = (transactionLifecycle, doc, item, content) => {
  if (doc === transactionLifecycle.doc) throw new Error('A document cannot be attached to itself')
  const clientIDDescriptor = requireWritableDataDescriptor(doc, 'clientID')
  const collectionDescriptor = requireWritableDataDescriptor(doc, 'collectionid')
  const itemDescriptor = requireWritableDataDescriptor(doc, '_item')
  const shouldLoadDescriptor = requireWritableDataDescriptor(doc, 'shouldLoad')
  const destroy = requireDestroyMethod(doc)
  const docLifecycle = requireDocLifecycle(doc)
  if (
    itemDescriptor.value !== null || docLifecycle.phase !== 'constructed' || docLifecycle.attachment !== null ||
    getActiveDestroyAttempt(doc) !== null
  ) throw new Error('Subdocument is already attached')
  const parentClientID = transactionLifecycle.effectiveClientID === null
    ? requireWritableDataDescriptor(transactionLifecycle.doc, 'clientID').value
    : transactionLifecycle.effectiveClientID
  const parentCollectionid = requireWritableDataDescriptor(transactionLifecycle.doc, 'collectionid').value
  const collectionid = collectionDescriptor.value == null ? parentCollectionid : collectionDescriptor.value
  writeOwnDataValue(doc, 'clientID', clientIDDescriptor, parentClientID)
  writeOwnDataValue(doc, 'collectionid', collectionDescriptor, collectionid)
  writeOwnDataValue(doc, '_item', itemDescriptor, item)
  const record = /** @type {SubdocAdoption} */ ({
    doc,
    item,
    content,
    destroy,
    token: null,
    shouldLoad: shouldLoadDescriptor.value,
    claimed: true,
    attached: false,
    clientIDDescriptor,
    collectionDescriptor,
    itemDescriptor
  })
  const adoptions = ensureTransactionAdoptions(transactionLifecycle)
  applyIntrinsic(mapSetIntrinsic, adoptions.byItem, [item, record])
  applyIntrinsic(mapSetIntrinsic, adoptions.byDoc, [doc, record])
  appendArrayValue(adoptions.records, record)
  return record
}

/**
 * Register the raw `this` identity before a subclass can replace the constructor result.
 *
 * @param {object} doc
 * @param {object} options
 * @param {function():void} destroyIntrinsic
 */
export const registerConstructedDoc = (doc, options, destroyIntrinsic) => {
  if (applyIntrinsic(weakMapHasIntrinsic, docLifecycles, [doc])) {
    throw new Error('Document identity is already registered')
  }
  const permitDescriptor = getOwnDescriptor(options, constructionPermitKey)
  const permit = permitDescriptor !== undefined && hasOwn(permitDescriptor, 'value')
    ? applyIntrinsic(weakMapGetIntrinsic, constructionPermits, [permitDescriptor.value])
    : undefined
  const descriptors = permit !== undefined && permit.open && permit.doc === null &&
    permit.prototype === applyIntrinsic(getPrototypeOfIntrinsic, Object, [doc])
    ? new Map()
    : null
  if (descriptors !== null) {
    for (let index = 0; index < constructionFields.length; index++) {
      const key = constructionFields[index]
      const descriptor = getOwnDescriptor(doc, key)
      if (descriptor === undefined) throw new Error(`Document construction did not define ${key}`)
      applyIntrinsic(mapSetIntrinsic, descriptors, [key, descriptor])
    }
  }
  const subdocsDescriptor = getOwnDescriptor(doc, 'subdocs')
  if (
    subdocsDescriptor === undefined || !hasOwn(subdocsDescriptor, 'value') ||
    subdocsDescriptor.writable !== true || applyIntrinsic(setSizeGetter, subdocsDescriptor.value, []) !== 0
  ) throw new Error('Document construction must define an empty writable subdocuments Set')
  if (typeof destroyIntrinsic !== 'function') throw new Error('Document destroy intrinsic must be callable')
  const lifecycle = /** @type {DocLifecycle} */ ({
    phase: 'constructed',
    descriptors,
    attachment: null,
    authority: null,
    destroyIntrinsic,
    subdocs: new Set(),
    pendingSubdocs: new Set()
  })
  applyIntrinsic(weakMapSetIntrinsic, docLifecycles, [doc, lifecycle])
  if (descriptors !== null && permit !== undefined) permit.doc = doc
}

/** @param {object} options @param {object} prototype */
export const createDocConstructionPermit = (options, prototype) => {
  const token = {}
  const permit = /** @type {ConstructionPermit} */ ({ token, prototype, open: true, doc: null })
  applyIntrinsic(definePropertyIntrinsic, Object, [options, constructionPermitKey, {
    value: token,
    enumerable: true,
    writable: false,
    configurable: false
  }])
  applyIntrinsic(weakMapSetIntrinsic, constructionPermits, [token, permit])
  return permit
}

/** @param {ConstructionPermit} permit */
export const revokeDocConstructionPermit = permit => {
  if (!permit.open) return
  permit.open = false
  const current = applyIntrinsic(weakMapGetIntrinsic, constructionPermits, [permit.token])
  if (current === permit) applyIntrinsic(weakMapDeleteIntrinsic, constructionPermits, [permit.token])
  if (permit.doc !== null) {
    const lifecycle = requireDocLifecycle(permit.doc)
    if (lifecycle.phase === 'constructed') lifecycle.phase = 'revoked'
  }
}

/**
 * @param {ConstructionPermit} permit
 * @param {object} returnedDoc
 * @param {object} item
 * @param {object} content
 * @param {{guid:any,gc:any,sparseExactResolution:any,autoLoad:any,shouldLoad:any,meta:any,metaSnapshot:Uint8Array,isSuggestionDoc:any}} expected
 */
export const prepareConstructedSubdoc = (permit, returnedDoc, item, content, expected) => {
  if (!permit.open) throw new Error('Subdocument construction permit is closed')
  permit.open = false
  const current = applyIntrinsic(weakMapGetIntrinsic, constructionPermits, [permit.token])
  if (current === permit) applyIntrinsic(weakMapDeleteIntrinsic, constructionPermits, [permit.token])
  if (permit.doc !== returnedDoc || applyIntrinsic(getPrototypeOfIntrinsic, Object, [returnedDoc]) !== permit.prototype) {
    if (permit.doc !== null) {
      const constructed = requireDocLifecycle(permit.doc)
      if (constructed.phase === 'constructed') constructed.phase = 'revoked'
    }
    throw new Error('Subdocument constructor must return its exact raw construction')
  }
  const lifecycle = requireDocLifecycle(returnedDoc)
  if (lifecycle.phase !== 'constructed' || !constructionIsStable(returnedDoc, lifecycle)) {
    if (lifecycle.phase === 'constructed') lifecycle.phase = 'revoked'
    throw new Error('Subdocument construction identity changed before preparation')
  }
  const constructionDescriptors = /** @type {Map<string,PropertyDescriptor>} */ (lifecycle.descriptors)
  /** @param {string} key */
  const descriptorValue = key => /** @type {PropertyDescriptor} */ (applyIntrinsic(mapGetIntrinsic, constructionDescriptors, [key])).value
  const gcDescriptor = /** @type {PropertyDescriptor} */ (applyIntrinsic(mapGetIntrinsic, constructionDescriptors, ['gc']))
  const gc = hasOwn(gcDescriptor, 'value') ? gcDescriptor.value : false
  const meta = descriptorValue('meta')
  let matchesWire = false
  try {
    matchesWire =
      applyIntrinsic(objectIsIntrinsic, Object, [descriptorValue('guid'), expected.guid]) &&
      applyIntrinsic(objectIsIntrinsic, Object, [gc, expected.gc]) &&
      applyIntrinsic(objectIsIntrinsic, Object, [descriptorValue('sparseExactResolution'), expected.sparseExactResolution]) &&
      applyIntrinsic(objectIsIntrinsic, Object, [descriptorValue('autoLoad'), expected.autoLoad]) &&
      applyIntrinsic(objectIsIntrinsic, Object, [descriptorValue('shouldLoad'), expected.shouldLoad]) &&
      applyIntrinsic(objectIsIntrinsic, Object, [meta, expected.meta]) &&
      equalBytes(encodeAny(meta), expected.metaSnapshot) &&
      applyIntrinsic(objectIsIntrinsic, Object, [descriptorValue('isSuggestionDoc'), expected.isSuggestionDoc])
  } catch (failure) {
    if (lifecycle.phase === 'constructed') lifecycle.phase = 'revoked'
    throw failure
  }
  if (
    lifecycle.phase !== 'constructed' || lifecycle.authority !== null || lifecycle.attachment !== null ||
    !constructionIsStable(returnedDoc, lifecycle)
  ) {
    if (lifecycle.phase === 'constructed') lifecycle.phase = 'revoked'
    throw new Error('Subdocument lifecycle changed during wire validation')
  }
  if (!matchesWire) {
    lifecycle.phase = 'revoked'
    throw new Error('Subdocument construction does not match its wire options')
  }
  const token = {}
  const authority = /** @type {PreparedAuthority} */ ({ doc: returnedDoc, item, content, token, owner: 'preparation', transaction: null })
  lifecycle.phase = 'prepared'
  lifecycle.authority = token
  applyIntrinsic(weakMapSetIntrinsic, preparedAuthorities, [token, authority])
  return token
}

/** @param {object} token @param {object} doc @param {object} item @param {object} content */
export const preparedSubdocIsStable = (token, doc, item, content) => {
  const authority = applyIntrinsic(weakMapGetIntrinsic, preparedAuthorities, [token])
  if (authority === undefined || authority.owner !== 'preparation' || authority.doc !== doc || authority.item !== item || authority.content !== content) return false
  const lifecycle = applyIntrinsic(weakMapGetIntrinsic, docLifecycles, [doc])
  return lifecycle !== undefined && lifecycle.phase === 'prepared' && lifecycle.authority === token && constructionIsStable(doc, lifecycle)
}

/** @param {object} token @param {object} doc @param {object} previousItem @param {object} item @param {object} content */
export const retargetPreparedSubdoc = (token, doc, previousItem, item, content) => {
  if (!preparedSubdocIsStable(token, doc, previousItem, content)) return false
  const authority = /** @type {PreparedAuthority} */ (applyIntrinsic(weakMapGetIntrinsic, preparedAuthorities, [token]))
  authority.item = item
  return true
}

/** @param {object} token */
export const revokePreparedSubdoc = token => {
  const authority = applyIntrinsic(weakMapGetIntrinsic, preparedAuthorities, [token])
  if (authority === undefined || authority.owner !== 'preparation') return false
  const lifecycle = requireDocLifecycle(authority.doc)
  if (lifecycle.phase !== 'prepared' || lifecycle.authority !== token) return false
  lifecycle.phase = 'revoked'
  lifecycle.authority = null
  authority.owner = 'revoked'
  return true
}

/**
 * @param {object} transaction
 * @param {object} doc
 * @param {Set<object>} added
 * @param {Set<object>} removed
 * @param {Set<object>} loaded
 */
export const registerTransactionLifecycle = (transaction, doc, added, removed, loaded) => {
  requireDocLifecycle(doc)
  if (getActiveDestroyAttempt(doc) !== null) throw new Error('A destroying document cannot start a transaction')
  const publicAddedDescriptor = requireWritableDataDescriptor(transaction, 'subdocsAdded')
  const publicRemovedDescriptor = requireWritableDataDescriptor(transaction, 'subdocsRemoved')
  const publicLoadedDescriptor = requireWritableDataDescriptor(transaction, 'subdocsLoaded')
  if (publicAddedDescriptor.value !== added || publicRemovedDescriptor.value !== removed || publicLoadedDescriptor.value !== loaded) {
    throw new Error('Transaction subdocument Set identity changed during registration')
  }
  applyIntrinsic(setSizeGetter, added, [])
  applyIntrinsic(setSizeGetter, removed, [])
  applyIntrinsic(setSizeGetter, loaded, [])
  applyIntrinsic(weakMapSetIntrinsic, transactionLifecycles, [transaction, {
    doc,
    parentSubdocs: null,
    parentSubdocsDescriptor: null,
    publicAdded: added,
    publicRemoved: removed,
    publicLoaded: loaded,
    publicAddedDescriptor,
    publicRemovedDescriptor,
    publicLoadedDescriptor,
    added: null,
    removed: null,
    loaded: null,
    byItem: null,
    byDoc: null,
    records: null,
    effectiveClientID: null,
    metadataFinalized: false
  }])
}

/**
 * Metadata is finalized before any root, link, or store write. All records are validated before the
 * first descriptor change or authority transfer.
 *
 * @param {object} transaction
 * @param {Array<{token:object,doc:object,item:object,content:object,shouldLoad:boolean}>} prepared
 */
export const adoptPreparedSubdocs = (transaction, prepared) => {
  if (prepared.length === 0) return
  const transactionLifecycle = requireTransactionLifecycle(transaction)
  const parentLifecycle = requireDocLifecycle(transactionLifecycle.doc)
  if (getActiveDestroyAttempt(transactionLifecycle.doc) !== null || parentLifecycle.phase === 'destroyed') {
    throw new Error('A terminal document cannot adopt a subdocument')
  }
  captureParentSubdocs(transactionLifecycle)
  const transactionAdoptions = ensureTransactionAdoptions(transactionLifecycle)
  const parentClientID = transactionLifecycle.effectiveClientID === null
    ? requireWritableDataDescriptor(transactionLifecycle.doc, 'clientID').value
    : transactionLifecycle.effectiveClientID
  const parentCollectionid = requireWritableDataDescriptor(transactionLifecycle.doc, 'collectionid').value
  /** @type {Array<{authority:PreparedAuthority,lifecycle:DocLifecycle,record:SubdocAdoption,clientIDDescriptor:PropertyDescriptor,collectionDescriptor:PropertyDescriptor,itemDescriptor:PropertyDescriptor,collectionid:any}>} */
  const validated = []
  for (let index = 0; index < prepared.length; index++) {
    const entry = prepared[index]
    if (entry.doc === transactionLifecycle.doc) throw new Error('A document cannot be attached to itself')
    if (!preparedSubdocIsStable(entry.token, entry.doc, entry.item, entry.content)) {
      throw new Error('Prepared subdocument authority changed before adoption')
    }
    const authority = /** @type {PreparedAuthority} */ (applyIntrinsic(weakMapGetIntrinsic, preparedAuthorities, [entry.token]))
    const lifecycle = requireDocLifecycle(entry.doc)
    const clientIDDescriptor = requireWritableDataDescriptor(entry.doc, 'clientID')
    const collectionDescriptor = requireWritableDataDescriptor(entry.doc, 'collectionid')
    const itemDescriptor = requireWritableDataDescriptor(entry.doc, '_item')
    const destroy = requireDestroyMethod(entry.doc)
    if (!preparedSubdocIsStable(entry.token, entry.doc, entry.item, entry.content)) {
      throw new Error('Prepared subdocument authority changed during destroy capture')
    }
    if (itemDescriptor.value !== null) throw new Error('Prepared subdocument is already attached')
    const collectionid = collectionDescriptor.value == null ? parentCollectionid : collectionDescriptor.value
    appendArrayValue(validated, {
      authority,
      lifecycle,
      clientIDDescriptor,
      collectionDescriptor,
      itemDescriptor,
      collectionid,
      record: {
        doc: entry.doc,
        item: entry.item,
        content: entry.content,
        destroy,
        token: entry.token,
        shouldLoad: entry.shouldLoad,
        claimed: false,
        attached: false,
        clientIDDescriptor,
        collectionDescriptor,
        itemDescriptor
      }
    })
  }
  for (let index = 0; index < validated.length; index++) {
    const entry = validated[index]
    writeOwnDataValue(entry.record.doc, 'clientID', entry.clientIDDescriptor, parentClientID)
    writeOwnDataValue(entry.record.doc, 'collectionid', entry.collectionDescriptor, entry.collectionid)
  }
  for (let index = 0; index < validated.length; index++) {
    const entry = validated[index]
    entry.lifecycle.phase = 'adopting'
    entry.authority.owner = 'transaction'
    entry.authority.transaction = transaction
    applyIntrinsic(mapSetIntrinsic, transactionAdoptions.byItem, [entry.record.item, entry.record])
    applyIntrinsic(mapSetIntrinsic, transactionAdoptions.byDoc, [entry.record.doc, entry.record])
    appendArrayValue(transactionAdoptions.records, entry.record)
  }
}

/** @param {object} transaction @param {object} item @param {{doc:object|null}} content */
export const claimSubdocItem = (transaction, item, content) => {
  const doc = content.doc
  if (doc === null) return
  const transactionLifecycle = requireTransactionLifecycle(transaction)
  const parentLifecycle = requireDocLifecycle(transactionLifecycle.doc)
  if (getActiveDestroyAttempt(transactionLifecycle.doc) !== null || parentLifecycle.phase === 'destroyed') {
    throw new Error('A terminal document cannot adopt a subdocument')
  }
  captureParentSubdocs(transactionLifecycle)
  const prepared = transactionLifecycle.byItem === null
    ? undefined
    : applyIntrinsic(mapGetIntrinsic, transactionLifecycle.byItem, [item])
  const lifecycle = requireDocLifecycle(doc)
  if (prepared !== undefined) {
    const authority = applyIntrinsic(weakMapGetIntrinsic, preparedAuthorities, [prepared.token])
    if (
      prepared.doc !== doc || prepared.content !== content || prepared.item !== item ||
      authority === undefined || authority.owner !== 'transaction' || authority.transaction !== transaction ||
      lifecycle.phase !== 'adopting' || lifecycle.authority !== prepared.token || lifecycle.attachment !== null
    ) throw new Error('Prepared subdocument adoption authority does not match the Item')
    const itemDescriptor = requireWritableDataDescriptor(doc, '_item')
    if (itemDescriptor.value !== null) throw new Error('Prepared subdocument attachment changed before integration')
    writeOwnDataValue(doc, '_item', itemDescriptor, item)
    prepared.claimed = true
    return
  }
  if (lifecycle.phase !== 'constructed' || lifecycle.attachment !== null) {
    throw new Error('Subdocument is already attached')
  }
  createOrdinaryAdoption(transactionLifecycle, doc, item, content)
  lifecycle.phase = 'adopting'
}

/** @param {object} transaction @param {object} item @param {{doc:object|null}} content */
export const integrateSubdocContent = (transaction, item, content) => {
  const doc = content.doc
  if (doc === null) throw new Error('Subdocument construction is missing')
  const transactionLifecycle = requireTransactionLifecycle(transaction)
  const lifecycle = requireDocLifecycle(doc)
  const adoption = transactionLifecycle.byItem === null
    ? undefined
    : applyIntrinsic(mapGetIntrinsic, transactionLifecycle.byItem, [item])
  if (
    adoption === undefined || adoption.doc !== doc || adoption.item !== item || adoption.content !== content ||
    !adoption.claimed || adoption.attached || lifecycle.phase !== 'adopting' || lifecycle.attachment !== null
  ) throw new Error('Subdocument adoption record is not ready to commit')
  if (adoption.token !== null) {
    const authority = applyIntrinsic(weakMapGetIntrinsic, preparedAuthorities, [adoption.token])
    if (authority === undefined || authority.owner !== 'transaction' || authority.transaction !== transaction) {
      throw new Error('Prepared subdocument transaction authority changed before commit')
    }
    authority.owner = 'attachment'
  }
  lifecycle.attachment = {
    parentDoc: transactionLifecycle.doc,
    item,
    content,
    destroy: adoption.destroy,
    destroyIntrinsic: lifecycle.destroyIntrinsic
  }
  lifecycle.phase = 'adopted'
  adoption.attached = true
  applyIntrinsic(setAddIntrinsic, requireDocLifecycle(transactionLifecycle.doc).pendingSubdocs, [doc])
  const sets = ensureTransactionSubdocSets(transactionLifecycle)
  addTransactionSubdocSetValue(sets.added, transactionLifecycle.publicAdded, doc)
  if (adoption.shouldLoad) addTransactionSubdocSetValue(sets.loaded, transactionLifecycle.publicLoaded, doc)
}

/** @param {object} transaction @param {object} doc */
export const deleteTransactionSubdoc = (transaction, doc) => {
  const lifecycle = requireTransactionLifecycle(transaction)
  const sets = ensureTransactionSubdocSets(lifecycle)
  if (applyIntrinsic(setHasIntrinsic, sets.added, [doc])) {
    deleteTransactionSubdocSetValue(sets.added, lifecycle.publicAdded, doc)
  } else {
    addTransactionSubdocSetValue(sets.removed, lifecycle.publicRemoved, doc)
  }
}

/** @param {object} transaction */
export const prepareSubdocDeletion = transaction => {
  captureParentSubdocs(requireTransactionLifecycle(transaction))
}

/** @param {object} transaction */
export const transactionHasSubdocs = transaction => {
  const lifecycle = requireTransactionLifecycle(transaction)
  return lifecycle.records !== null || lifecycle.added !== null
}

/** @param {object} transaction */
export const transactionHasAddedSubdocs = transaction => {
  const lifecycle = requireTransactionLifecycle(transaction)
  return lifecycle.added !== null && applyIntrinsic(setSizeGetter, lifecycle.added, []) > 0
}

/**
 * Validate every net-added identity before changing the first child, then finalize all metadata
 * while the transaction still owns the child descriptors.
 *
 * @param {object} transaction
 * @param {number} effectiveClientID
 */
export const prefinalizeTransactionSubdocMetadata = (transaction, effectiveClientID) => {
  const lifecycle = requireTransactionLifecycle(transaction)
  if (lifecycle.added === null || applyIntrinsic(setSizeGetter, lifecycle.added, []) === 0) return
  const parentCollectionid = requireWritableDataDescriptor(lifecycle.doc, 'collectionid').value
  /** @type {Array<{doc:object,clientIDDescriptor:PropertyDescriptor,collectionDescriptor:PropertyDescriptor,collectionid:any}>} */
  const validated = []
  applyIntrinsic(setForEachIntrinsic, lifecycle.added, [doc => {
    const adoption = lifecycle.byDoc === null ? undefined : applyIntrinsic(mapGetIntrinsic, lifecycle.byDoc, [doc])
    const docLifecycle = requireDocLifecycle(doc)
    const attachment = docLifecycle.attachment
    const clientIDDescriptor = requireWritableDataDescriptor(doc, 'clientID')
    const collectionDescriptor = requireWritableDataDescriptor(doc, 'collectionid')
    const itemDescriptor = requireWritableDataDescriptor(doc, '_item')
    const contentDocDescriptor = getOwnDescriptor(adoption === undefined ? {} : adoption.content, 'doc')
    const authority = adoption === undefined || adoption.token === null
      ? undefined
      : applyIntrinsic(weakMapGetIntrinsic, preparedAuthorities, [adoption.token])
    if (
      adoption === undefined || !adoption.attached || adoption.doc !== doc ||
      docLifecycle.phase !== 'adopted' || attachment === null ||
      attachment.parentDoc !== lifecycle.doc || attachment.item !== adoption.item || attachment.content !== adoption.content ||
      !sameWritableDataShape(clientIDDescriptor, adoption.clientIDDescriptor) ||
      !sameWritableDataShape(collectionDescriptor, adoption.collectionDescriptor) ||
      !sameWritableDataShape(itemDescriptor, adoption.itemDescriptor) || itemDescriptor.value !== adoption.item ||
      contentDocDescriptor === undefined || !hasOwn(contentDocDescriptor, 'value') || contentDocDescriptor.value !== doc ||
      (adoption.token !== null && (authority === undefined || authority.owner !== 'attachment' || authority.transaction !== transaction || docLifecycle.authority !== adoption.token))
    ) throw new Error('Added subdocument metadata is not authoritative')
    appendArrayValue(validated, {
      doc,
      clientIDDescriptor,
      collectionDescriptor,
      collectionid: collectionDescriptor.value == null ? parentCollectionid : collectionDescriptor.value
    })
  }])
  lifecycle.effectiveClientID = effectiveClientID
  for (let index = 0; index < validated.length; index++) {
    const entry = validated[index]
    writeOwnDataValue(entry.doc, 'clientID', entry.clientIDDescriptor, effectiveClientID)
    writeOwnDataValue(entry.doc, 'collectionid', entry.collectionDescriptor, entry.collectionid)
  }
  lifecycle.metadataFinalized = true
}

/** @param {object} transaction */
export const getTransactionSubdocSets = transaction => {
  const lifecycle = requireTransactionLifecycle(transaction)
  mirrorTransactionSubdocSets(transaction, lifecycle)
  return { added: lifecycle.publicAdded, removed: lifecycle.publicRemoved, loaded: lifecycle.publicLoaded }
}

/** @param {object} transaction */
export const getRemovedSubdocDestroyers = transaction => {
  const lifecycle = requireTransactionLifecycle(transaction)
  const entries = /** @type {Array<{doc:object,destroy:function():void,destroyIntrinsic:function():void}>} */ ([])
  if (lifecycle.removed === null) return entries
  applyIntrinsic(setForEachIntrinsic, lifecycle.removed, [doc => {
    const subdocLifecycle = requireDocLifecycle(doc)
    const attachment = subdocLifecycle.attachment
    appendArrayValue(entries, attachment !== null && attachment.parentDoc === lifecycle.doc
      ? { doc, destroy: attachment.destroy, destroyIntrinsic: attachment.destroyIntrinsic }
      : { doc, destroy: subdocLifecycle.destroyIntrinsic, destroyIntrinsic: subdocLifecycle.destroyIntrinsic })
  }])
  return entries
}

/** @param {object} transaction */
export const publishTransactionSubdocs = transaction => {
  const lifecycle = requireTransactionLifecycle(transaction)
  if (lifecycle.added === null) return
  mirrorTransactionSubdocSets(transaction, lifecycle)
  if (applyIntrinsic(setSizeGetter, lifecycle.added, []) > 0 && !lifecycle.metadataFinalized) {
    throw new Error('Added subdocument metadata was not finalized')
  }
  const parentLifecycle = requireDocLifecycle(lifecycle.doc)
  const parentAttempt = getActiveDestroyAttempt(lifecycle.doc)
  if (parentLifecycle.phase === 'destroyed' || (parentAttempt !== null && parentAttempt.ownershipCommitted)) {
    applyIntrinsic(setForEachIntrinsic, lifecycle.added, [doc => {
      const subdocLifecycle = requireDocLifecycle(doc)
      if (subdocLifecycle.phase !== 'destroyed' && getActiveDestroyAttempt(doc) === null) {
        throw new Error('Terminal parent retained a live pending subdocument')
      }
      deleteTransactionSubdocSetValue(lifecycle.added, lifecycle.publicAdded, doc)
      deleteTransactionSubdocSetValue(/** @type {Set<object>} */ (lifecycle.loaded), lifecycle.publicLoaded, doc)
    }])
  }
  const canonicalSubdocs = parentLifecycle.subdocs
  const accepted = new Set()
  applyIntrinsic(setForEachIntrinsic, canonicalSubdocs, [doc => applyIntrinsic(setAddIntrinsic, accepted, [doc])])
  applyIntrinsic(setForEachIntrinsic, lifecycle.added, [doc => {
    const adoption = lifecycle.byDoc === null ? undefined : applyIntrinsic(mapGetIntrinsic, lifecycle.byDoc, [doc])
    if (adoption === undefined) throw new Error('Added subdocument has no prefinalized adoption')
    applyIntrinsic(setAddIntrinsic, accepted, [doc])
  }])
  applyIntrinsic(setForEachIntrinsic, /** @type {Set<object>} */ (lifecycle.removed), [doc => {
    applyIntrinsic(setDeleteIntrinsic, accepted, [doc])
  }])
  const capturedParentSubdocs = lifecycle.parentSubdocs
  const capturedDescriptor = lifecycle.parentSubdocsDescriptor
  if (capturedParentSubdocs === null || capturedDescriptor === null) {
    throw new Error('Parent subdocument membership was not captured')
  }
  replaceSetContents(accepted, canonicalSubdocs)
  const liveDescriptor = getOwnDescriptor(lifecycle.doc, 'subdocs')
  let parentSubdocs = liveDescriptor !== undefined && hasOwn(liveDescriptor, 'value') ? liveDescriptor.value : null
  let liveSet = true
  try {
    applyIntrinsic(setSizeGetter, parentSubdocs, [])
  } catch (_failure) {
    liveSet = false
  }
  if (!liveSet) {
    parentSubdocs = capturedParentSubdocs
    try {
      if (liveDescriptor !== undefined && hasOwn(liveDescriptor, 'value') && liveDescriptor.writable === true) {
        applyIntrinsic(definePropertyIntrinsic, Object, [lifecycle.doc, 'subdocs', { value: parentSubdocs }])
      } else if (liveDescriptor === undefined || liveDescriptor.configurable === true) {
        applyIntrinsic(definePropertyIntrinsic, Object, [lifecycle.doc, 'subdocs', { ...capturedDescriptor, value: parentSubdocs }])
      }
    } catch (_failure) {}
  }
  replaceSetContents(accepted, parentSubdocs)
}

/** @param {object} transaction */
export const finalizeTransactionSubdocs = transaction => {
  const lifecycle = applyIntrinsic(weakMapGetIntrinsic, transactionLifecycles, [transaction])
  if (lifecycle === undefined) return
  if (lifecycle.records === null) return
  const parentLifecycle = requireDocLifecycle(lifecycle.doc)
  for (let index = 0; index < lifecycle.records.length; index++) {
    const record = lifecycle.records[index]
    applyIntrinsic(setDeleteIntrinsic, parentLifecycle.pendingSubdocs, [record.doc])
    const docLifecycle = requireDocLifecycle(record.doc)
    const authority = record.token === null
      ? undefined
      : applyIntrinsic(weakMapGetIntrinsic, preparedAuthorities, [record.token])
    if (
      !record.attached && docLifecycle.phase === 'adopting' && docLifecycle.attachment === null &&
      (record.token === null || (authority !== undefined && authority.owner === 'transaction' && authority.transaction === transaction))
    ) {
      restoreOwnDescriptor(record.doc, 'clientID', record.clientIDDescriptor)
      restoreOwnDescriptor(record.doc, 'collectionid', record.collectionDescriptor)
      restoreOwnDescriptor(record.doc, '_item', record.itemDescriptor)
      docLifecycle.authority = null
      if (record.token === null) {
        docLifecycle.phase = 'constructed'
      } else {
        docLifecycle.phase = 'revoked'
        if (authority !== undefined) {
          authority.owner = 'revoked'
          authority.transaction = null
        }
        const descriptor = getOwnDescriptor(record.content, 'doc')
        if (descriptor !== undefined && hasOwn(descriptor, 'value') && descriptor.value === record.doc && descriptor.writable === true) {
          writeOwnDataValue(record.content, 'doc', descriptor, null)
        }
      }
    } else if (record.attached && docLifecycle.phase === 'adopted' && docLifecycle.authority === record.token) {
      docLifecycle.authority = null
    }
  }
}

/** @param {object} doc */
export const docLifecycleIsDestroyed = doc => {
  const lifecycle = applyIntrinsic(weakMapGetIntrinsic, docLifecycles, [doc])
  return lifecycle === undefined || lifecycle.phase === 'destroyed' || getActiveDestroyAttempt(doc) !== null
}

/** @param {object} doc @returns {DocDestroyAttempt|null} */
export const beginDocDestroy = doc => {
  const lifecycle = requireDocLifecycle(doc)
  const current = getActiveDestroyAttempt(doc)
  if (current !== null) {
    if (current.running) return null
    current.running = true
    return current
  }
  if (lifecycle.phase === 'destroyed') return null
  const isDestroyedDescriptor = requireWritableDataDescriptor(doc, 'isDestroyed')
  const attempt = /** @type {DocDestroyAttempt} */ ({
    doc,
    active: true,
    running: true,
    ownershipCommitted: false,
    attachment: lifecycle.attachment,
    previousPhase: lifecycle.phase,
    previousAuthority: lifecycle.authority,
    isDestroyedDescriptor,
    replacement: null,
    tasks: null
  })
  lifecycle.authority = attempt
  applyIntrinsic(weakMapSetIntrinsic, docDestroyAttempts, [doc, attempt])
  return attempt
}

/** @param {object} doc @param {DocDestroyAttempt} attempt */
export const cancelDocDestroy = (doc, attempt) => {
  if (!attempt.active || attempt.ownershipCommitted) return
  const lifecycle = requireDocLifecycle(doc)
  if (
    attempt.doc !== doc || lifecycle.phase !== attempt.previousPhase || lifecycle.authority !== attempt ||
    lifecycle.attachment !== attempt.attachment || !attempt.running
  ) {
    throw new Error('Document destroy authority changed before cancellation')
  }
  if (attempt.replacement !== null) {
    const replacementLifecycle = requireDocLifecycle(attempt.replacement)
    if (replacementLifecycle.phase === 'constructed' && replacementLifecycle.attachment === null) {
      replacementLifecycle.phase = 'revoked'
    }
  }
  lifecycle.authority = attempt.previousAuthority
  attempt.active = false
  attempt.running = false
  applyIntrinsic(weakMapDeleteIntrinsic, docDestroyAttempts, [doc])
}

/** @param {DocDestroyAttempt} attempt */
export const destroyParentIsTerminating = attempt => {
  if (attempt.attachment === null) return false
  const parentLifecycle = requireDocLifecycle(attempt.attachment.parentDoc)
  const parentAttempt = getActiveDestroyAttempt(attempt.attachment.parentDoc)
  return parentLifecycle.phase === 'destroyed' || (parentAttempt !== null && parentAttempt.ownershipCommitted)
}

/** @param {DocDestroyAttempt} attempt */
export const destroyParentIsPreparing = attempt => {
  if (attempt.attachment === null) return false
  const parentAttempt = getActiveDestroyAttempt(attempt.attachment.parentDoc)
  return parentAttempt !== null && !parentAttempt.ownershipCommitted
}

/** @param {DocDestroyAttempt} attempt */
export const getDocDestroyAttachment = attempt => attempt.attachment

/** @param {object} doc @param {DocDestroyAttempt} attempt @param {object} replacement */
export const prepareDocDestroyReplacement = (doc, attempt, replacement) => {
  const lifecycle = requireDocLifecycle(doc)
  const replacementLifecycle = requireDocLifecycle(replacement)
  const replacementItemDescriptor = requireWritableDataDescriptor(replacement, '_item')
  if (
    attempt.doc !== doc || !attempt.active || !attempt.running || attempt.ownershipCommitted || attempt.replacement !== null ||
    lifecycle.phase !== attempt.previousPhase || lifecycle.authority !== attempt || lifecycle.attachment !== attempt.attachment ||
    replacement === doc || getActiveDestroyAttempt(replacement) !== null || replacementLifecycle.phase !== 'constructed' ||
    replacementLifecycle.authority !== null || replacementLifecycle.attachment !== null || replacementItemDescriptor.value !== null
  ) throw new Error('Document replacement preparation authority is invalid')
  attempt.replacement = replacement
}

/** @param {object} doc @param {DocDestroyAttempt} attempt */
export const commitDocDestroy = (doc, attempt) => {
  if (!attempt.active || attempt.ownershipCommitted) return
  const lifecycle = requireDocLifecycle(doc)
  if (
    attempt.doc !== doc || lifecycle.phase !== attempt.previousPhase || lifecycle.authority !== attempt ||
    lifecycle.attachment !== attempt.attachment || !attempt.running
  ) {
    throw new Error('Document destroy authority changed before commit')
  }
  writeDocDestroyedState(doc, attempt)
  if (attempt.attachment !== null) {
    const itemDescriptor = requireWritableDataDescriptor(doc, '_item')
    if (itemDescriptor.value !== attempt.attachment.item) {
      throw new Error('Document attachment changed before terminal destroy')
    }
    writeOwnDataValue(doc, '_item', itemDescriptor, null)
  }
  lifecycle.phase = 'destroyed'
  lifecycle.attachment = null
  lifecycle.authority = attempt
  attempt.ownershipCommitted = true
}

/** @param {object} doc @param {DocDestroyAttempt} attempt */
export const commitDocDestroyAfterParentTermination = (doc, attempt) => {
  const lifecycle = requireDocLifecycle(doc)
  if (
    attempt.doc !== doc || !attempt.active || !attempt.running || attempt.ownershipCommitted ||
    lifecycle.phase !== attempt.previousPhase || lifecycle.authority !== attempt || lifecycle.attachment !== attempt.attachment ||
    attempt.attachment === null || !destroyParentIsTerminating(attempt)
  ) throw new Error('Parent-terminal document destroy authority is invalid')
  try {
    writeDocDestroyedState(doc, attempt)
  } catch (_failure) {}
  const itemDescriptor = getOwnDescriptor(doc, '_item')
  if (
    itemDescriptor !== undefined && hasOwn(itemDescriptor, 'value') && itemDescriptor.writable === true &&
    itemDescriptor.value === attempt.attachment.item
  ) {
    try {
      applyIntrinsic(definePropertyIntrinsic, Object, [doc, '_item', { value: null }])
    } catch (_failure) {}
  }
  lifecycle.phase = 'destroyed'
  lifecycle.attachment = null
  lifecycle.authority = attempt
  attempt.ownershipCommitted = true
}

/**
 * @param {object} transaction
 * @param {object} oldDoc
 * @param {DocDestroyAttempt} attempt
 * @param {object} replacement
 */
export const commitDocDestroyReplacement = (transaction, oldDoc, attempt, replacement) => {
  const oldLifecycle = requireDocLifecycle(oldDoc)
  const transactionLifecycle = requireTransactionLifecycle(transaction)
  const attachment = attempt.attachment
  if (
    attachment === null || attempt.doc !== oldDoc || !attempt.active || !attempt.running || attempt.ownershipCommitted ||
    attempt.replacement !== replacement ||
    oldLifecycle.phase !== attempt.previousPhase || oldLifecycle.authority !== attempt || oldLifecycle.attachment !== attachment ||
    transactionLifecycle.doc !== attachment.parentDoc
  ) throw new Error('Document replacement authority changed before commit')

  const parentLifecycle = requireDocLifecycle(attachment.parentDoc)
  const parentAttempt = getActiveDestroyAttempt(attachment.parentDoc)
  if (parentLifecycle.phase === 'destroyed' || (parentAttempt !== null && parentAttempt.ownershipCommitted)) {
    const replacementLifecycle = requireDocLifecycle(replacement)
    if (replacementLifecycle.phase === 'constructed' && replacementLifecycle.attachment === null) replacementLifecycle.phase = 'revoked'
    commitDocDestroy(oldDoc, attempt)
    return
  }

  captureParentSubdocs(transactionLifecycle)
  const sets = ensureTransactionSubdocSets(transactionLifecycle)
  const { item, content, parentDoc } = attachment
  const replacementLifecycle = requireDocLifecycle(replacement)
  const oldItemDescriptor = requireWritableDataDescriptor(oldDoc, '_item')
  if (item.deleted) {
    if (oldItemDescriptor.value !== item || replacementLifecycle.phase !== 'constructed' || replacementLifecycle.attachment !== null) {
      throw new Error('Deleted document replacement state changed before commit')
    }
    writeDocDestroyedState(oldDoc, attempt)
    replacementLifecycle.phase = 'revoked'
    writeOwnDataValue(oldDoc, '_item', oldItemDescriptor, null)
    addTransactionSubdocSetValue(sets.removed, transactionLifecycle.publicRemoved, oldDoc)
    oldLifecycle.phase = 'destroyed'
    oldLifecycle.attachment = null
    oldLifecycle.authority = attempt
    attempt.ownershipCommitted = true
    return
  }

  const adoptions = ensureTransactionAdoptions(transactionLifecycle)
  const replacementItemDescriptor = requireWritableDataDescriptor(replacement, '_item')
  const replacementClientIDDescriptor = requireWritableDataDescriptor(replacement, 'clientID')
  const replacementCollectionDescriptor = requireWritableDataDescriptor(replacement, 'collectionid')
  const replacementShouldLoadDescriptor = requireWritableDataDescriptor(replacement, 'shouldLoad')
  const replacementDestroy = requireDestroyMethod(replacement)
  const parentClientIDDescriptor = requireWritableDataDescriptor(parentDoc, 'clientID')
  const parentCollectionDescriptor = requireWritableDataDescriptor(parentDoc, 'collectionid')
  const contentDocDescriptor = requireWritableDataDescriptor(content, 'doc')
  if (
    replacement === oldDoc || getActiveDestroyAttempt(replacement) !== null || replacementLifecycle.phase !== 'constructed' ||
    replacementLifecycle.authority !== null || replacementLifecycle.attachment !== null || replacementItemDescriptor.value !== null ||
    replacementShouldLoadDescriptor.value !== false ||
    oldItemDescriptor.value !== item || contentDocDescriptor.value !== oldDoc || item.content !== content
  ) throw new Error('Document replacement state changed before commit')

  const collectionid = replacementCollectionDescriptor.value == null
    ? parentCollectionDescriptor.value
    : replacementCollectionDescriptor.value
  const record = /** @type {SubdocAdoption} */ ({
    doc: replacement,
    item,
    content,
    destroy: replacementDestroy,
    token: null,
    shouldLoad: false,
    claimed: true,
    attached: true,
    clientIDDescriptor: replacementClientIDDescriptor,
    collectionDescriptor: replacementCollectionDescriptor,
    itemDescriptor: replacementItemDescriptor
  })
  writeDocDestroyedState(oldDoc, attempt)
  applyIntrinsic(mapSetIntrinsic, adoptions.byItem, [item, record])
  applyIntrinsic(mapSetIntrinsic, adoptions.byDoc, [replacement, record])
  appendArrayValue(adoptions.records, record)

  writeOwnDataValue(replacement, 'clientID', replacementClientIDDescriptor, parentClientIDDescriptor.value)
  writeOwnDataValue(replacement, 'collectionid', replacementCollectionDescriptor, collectionid)
  writeOwnDataValue(replacement, '_item', replacementItemDescriptor, item)
  replacementLifecycle.phase = 'adopted'
  replacementLifecycle.attachment = {
    parentDoc,
    item,
    content,
    destroy: replacementDestroy,
    destroyIntrinsic: replacementLifecycle.destroyIntrinsic
  }
  applyIntrinsic(setAddIntrinsic, parentLifecycle.pendingSubdocs, [replacement])
  writeOwnDataValue(content, 'doc', contentDocDescriptor, replacement)
  writeOwnDataValue(oldDoc, '_item', oldItemDescriptor, null)
  addTransactionSubdocSetValue(sets.added, transactionLifecycle.publicAdded, replacement)
  addTransactionSubdocSetValue(sets.removed, transactionLifecycle.publicRemoved, oldDoc)
  oldLifecycle.phase = 'destroyed'
  oldLifecycle.attachment = null
  oldLifecycle.authority = attempt
  attempt.replacement = replacement
  attempt.ownershipCommitted = true
}

/** @param {DocDestroyAttempt} attempt */
export const docDestroyOwnershipCommitted = attempt => attempt.ownershipCommitted

/** @param {object} doc @param {DocDestroyAttempt} attempt */
export const reconcileDocDestroyPublicState = (doc, attempt) => {
  const lifecycle = requireDocLifecycle(doc)
  if (
    attempt.doc !== doc || !attempt.active || !attempt.running || !attempt.ownershipCommitted ||
    lifecycle.phase !== 'destroyed' || lifecycle.authority !== attempt
  ) throw new Error('Document destroy public state authority is invalid')
  try {
    writeDocDestroyedState(doc, attempt)
  } catch (_failure) {}
}

/** @param {object} doc @param {DocDestroyAttempt} attempt @param {Array<()=>void>} runs */
export const initializeDocDestroyCleanup = (doc, attempt, runs) => {
  const lifecycle = requireDocLifecycle(doc)
  if (
    attempt.doc !== doc || !attempt.active || !attempt.running || !attempt.ownershipCommitted ||
    lifecycle.phase !== 'destroyed' || lifecycle.authority !== attempt
  ) throw new Error('Document destroy cleanup authority is invalid')
  if (attempt.tasks !== null) return
  const tasks = /** @type {Array<DocDestroyTask>} */ ([])
  for (let index = 0; index < runs.length; index++) appendArrayValue(tasks, { done: false, run: runs[index] })
  attempt.tasks = tasks
}

/** @param {object} doc @param {DocDestroyAttempt} attempt */
export const runDocDestroyCleanup = (doc, attempt) => {
  const lifecycle = requireDocLifecycle(doc)
  if (
    attempt.doc !== doc || !attempt.active || !attempt.running || !attempt.ownershipCommitted || attempt.tasks === null ||
    lifecycle.phase !== 'destroyed' || lifecycle.authority !== attempt
  ) throw new Error('Document destroy cleanup authority changed before execution')
  let hasFailure = false
  let firstFailure = null
  for (let index = 0; index < attempt.tasks.length; index++) {
    const task = attempt.tasks[index]
    if (task.done) continue
    try {
      task.run()
      task.done = true
    } catch (failure) {
      if (!hasFailure) {
        hasFailure = true
        firstFailure = failure
      }
    }
  }
  if (hasFailure) {
    attempt.running = false
    throw firstFailure
  }
  lifecycle.authority = null
  attempt.active = false
  attempt.running = false
  applyIntrinsic(weakMapDeleteIntrinsic, docDestroyAttempts, [doc])
}

/** @param {object} doc */
export const getDocSubdocsSnapshot = doc => {
  const lifecycle = requireDocLifecycle(doc)
  const snapshot = /** @type {Array<{doc:object,destroy:function():void,destroyIntrinsic:function():void}>} */ ([])
  const seen = new Set()
  /** @param {object} subdoc */
  const add = subdoc => {
    if (applyIntrinsic(setHasIntrinsic, seen, [subdoc])) return
    const subdocLifecycle = requireDocLifecycle(subdoc)
    const attachment = subdocLifecycle.attachment
    if (attachment === null || attachment.parentDoc !== doc) return
    applyIntrinsic(setAddIntrinsic, seen, [subdoc])
    appendArrayValue(snapshot, {
      doc: subdoc,
      destroy: attachment.destroy,
      destroyIntrinsic: attachment.destroyIntrinsic
    })
  }
  applyIntrinsic(setForEachIntrinsic, lifecycle.subdocs, [add])
  applyIntrinsic(setForEachIntrinsic, lifecycle.pendingSubdocs, [add])
  return snapshot
}

/** @param {object} doc */
export const clearDestroyedDocSubdocs = doc => {
  const lifecycle = requireDocLifecycle(doc)
  applyIntrinsic(setClearIntrinsic, lifecycle.subdocs, [])
  applyIntrinsic(setClearIntrinsic, lifecycle.pendingSubdocs, [])
  const descriptor = getOwnDescriptor(doc, 'subdocs')
  if (descriptor !== undefined && hasOwn(descriptor, 'value')) {
    try {
      applyIntrinsic(setClearIntrinsic, descriptor.value, [])
    } catch (_failure) {}
  }
}

/** @param {object} transaction @param {object} doc */
export const loadTransactionSubdoc = (transaction, doc) => {
  const lifecycle = requireTransactionLifecycle(transaction)
  const sets = ensureTransactionSubdocSets(lifecycle)
  addTransactionSubdocSetValue(sets.loaded, lifecycle.publicLoaded, doc)
}
