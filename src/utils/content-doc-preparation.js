import { ContentDoc, Item } from '../structs/Item.js'
import { normalizeDocOptions } from './Doc.js'
import { adoptPreparedSubdocs, createDocConstructionPermit, prepareConstructedSubdoc, preparedSubdocIsStable, retargetPreparedSubdoc, revokeDocConstructionPermit, revokePreparedSubdoc } from './doc-lifecycle.js'
import { decodeAny, encodeAny } from 'lib0/buffer'

const applyIntrinsic = Reflect.apply
const definePropertyIntrinsic = Object.defineProperty
const getOwnPropertyDescriptorIntrinsic = Object.getOwnPropertyDescriptor
const getPrototypeOfIntrinsic = Object.getPrototypeOf
const hasOwnPropertyIntrinsic = Object.prototype.hasOwnProperty
const mapDeleteIntrinsic = Map.prototype.delete
const mapGetIntrinsic = Map.prototype.get
const mapSetIntrinsic = Map.prototype.set
const setAddIntrinsic = Set.prototype.add
const setHasIntrinsic = Set.prototype.has

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

/**
 * @typedef {{item:Item,content:ContentDoc,doc:import('./Doc.js').Doc,token:object,shouldLoad:boolean,transferred:boolean}} PreparedContentDoc
 * @typedef {{records:Array<PreparedContentDoc>,byContent:Map<ContentDoc,PreparedContentDoc>}} PreparedContentDocState
 */

/** @param {object} target @param {string} key */
const readOwnDataValue = (target, key) => {
  const descriptor = applyIntrinsic(getOwnPropertyDescriptorIntrinsic, Object, [target, key])
  if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
    throw new Error(`Prepared ContentDoc ${key} must be an own data property`)
  }
  return descriptor.value
}

/** @param {object} target @param {string} key @param {any} value */
const writeOwnDataValue = (target, key, value) => {
  const descriptor = applyIntrinsic(getOwnPropertyDescriptorIntrinsic, Object, [target, key])
  if (descriptor === undefined || !hasOwn(descriptor, 'value') || descriptor.writable !== true) {
    throw new Error(`Prepared ContentDoc ${key} must remain writable`)
  }
  applyIntrinsic(definePropertyIntrinsic, Object, [target, key, { ...descriptor, value }])
}

/** @param {ContentDoc} content */
const createConstructionOptions = content => {
  const normalized = normalizeDocOptions(readOwnDataValue(content, 'opts'))
  const source = normalized.opts
  const guid = readOwnDataValue(content, 'guid')
  const shouldLoad = source.shouldLoad || source.autoLoad || false
  const options = { ...source, guid, shouldLoad }
  const metaDescriptor = applyIntrinsic(getOwnPropertyDescriptorIntrinsic, Object, [source, 'meta'])
  const canonicalMeta = metaDescriptor === undefined
    ? null
    : hasOwn(metaDescriptor, 'value')
      ? metaDescriptor.value === undefined ? null : metaDescriptor.value
      : (() => { throw new Error('Prepared ContentDoc meta must be an own data property') })()
  const metaSnapshot = encodeAny(canonicalMeta)
  const meta = decodeAny(metaSnapshot)
  if (metaDescriptor !== undefined) {
    applyIntrinsic(definePropertyIntrinsic, Object, [options, 'meta', {
      value: meta,
      enumerable: true,
      writable: true,
      configurable: true
    }])
  }
  const construction = normalizeDocOptions(options)
  return {
    options,
    expected: {
      guid,
      gc: options.gc === undefined ? true : options.gc,
      sparseExactResolution: construction.sparseExactResolution,
      autoLoad: options.autoLoad === undefined ? false : options.autoLoad,
      shouldLoad,
      meta,
      metaSnapshot,
      isSuggestionDoc: options.isSuggestionDoc === undefined ? false : options.isSuggestionDoc
    }
  }
}

/** @param {PreparedContentDoc} prepared */
const preparedContentDocIsStable = prepared => {
  return !prepared.transferred && prepared.content.doc === prepared.doc &&
    preparedSubdocIsStable(prepared.token, prepared.doc, prepared.item, prepared.content)
}

/** @param {Array<PreparedContentDoc>} prepared */
const disposePreparedContentDocRecords = prepared => {
  for (let index = 0; index < prepared.length; index++) {
    const current = prepared[index]
    if (current.transferred) continue
    const revoked = revokePreparedSubdoc(current.token)
    if (revoked && current.content.doc === current.doc) {
      writeOwnDataValue(current.content, 'doc', null)
    }
  }
}

/** @returns {PreparedContentDocState} */
export const createPreparedContentDocState = () => ({ records: [], byContent: new Map() })

/**
 * @param {Array<{struct:import('../structs/GC.js').GC|Item|import('../structs/CausalHole.js').CausalHole,clock:number,gap:number}>} ordered
 * @param {import('./Doc.js').Doc} target
 * @param {PreparedContentDocState} state
 * @param {()=>boolean} isStable
 */
export const prepareContentDocs = (ordered, target, state, isStable) => {
  const SubdocConstructor = target.constructor
  const subdocPrototype = applyIntrinsic(getPrototypeOfIntrinsic, Object, [target])
  const scheduled = new Set()
  for (let index = 0; index < ordered.length; index++) {
    const struct = ordered[index].struct
    if (struct.constructor === Item && /** @type {Item} */ (struct).content instanceof ContentDoc) {
      applyIntrinsic(setAddIntrinsic, scheduled, [(/** @type {Item} */ (struct).content)])
    }
  }
  for (let index = state.records.length - 1; index >= 0; index--) {
    const current = state.records[index]
    if (!applyIntrinsic(setHasIntrinsic, scheduled, [current.content])) {
      disposePreparedContentDocRecords([current])
      state.records.splice(index, 1)
      applyIntrinsic(mapDeleteIntrinsic, state.byContent, [current.content])
    }
  }
  try {
    for (let index = 0; index < ordered.length; index++) {
      const struct = ordered[index].struct
      if (struct.constructor !== Item || !(/** @type {Item} */ (struct).content instanceof ContentDoc)) continue
      const item = /** @type {Item} */ (struct)
      const content = /** @type {ContentDoc} */ (item.content)
      const existing = applyIntrinsic(mapGetIntrinsic, state.byContent, [content])
      if (existing !== undefined) {
        if (existing.item !== item) {
          if (!retargetPreparedSubdoc(existing.token, existing.doc, existing.item, item, content)) {
            throw new Error('Prepared subdocument schedule changed after ownership transfer')
          }
          existing.item = item
        }
        if (!preparedContentDocIsStable(existing)) {
          throw new Error('Prepared subdocument lifecycle changed during planning')
        }
        continue
      }
      if (content.doc !== null) throw new Error('Scheduled subdocument already has an unowned document')
      const { options, expected } = createConstructionOptions(content)
      const permit = createDocConstructionPermit(options, subdocPrototype)
      let doc
      try {
        doc = /** @type {import('./Doc.js').Doc} */ (new /** @type {any} */ (SubdocConstructor)(options))
      } catch (failure) {
        revokeDocConstructionPermit(permit)
        throw failure
      }
      let token
      try {
        token = prepareConstructedSubdoc(permit, doc, item, content, expected)
      } catch (failure) {
        revokeDocConstructionPermit(permit)
        throw failure
      }
      const current = { item, content, doc, token, shouldLoad: expected.shouldLoad, transferred: false }
      writeOwnDataValue(content, 'doc', doc)
      appendArrayValue(state.records, current)
      applyIntrinsic(mapSetIntrinsic, state.byContent, [content, current])
      if (!isStable()) return false
    }
  } catch (failure) {
    disposePreparedContentDocRecords(state.records)
    state.records.length = 0
    throw failure
  }
  return true
}

/**
 * @param {Array<{struct:import('../structs/GC.js').GC|Item|import('../structs/CausalHole.js').CausalHole,clock:number,gap:number}>} ordered
 * @param {PreparedContentDocState} state
 */
export const preparedContentDocScheduleIsStable = (ordered, state) => {
  for (let index = 0; index < state.records.length; index++) {
    if (!preparedContentDocIsStable(state.records[index])) return false
  }
  for (let index = 0; index < ordered.length; index++) {
    const struct = ordered[index].struct
    if (struct.constructor !== Item || !(/** @type {Item} */ (struct).content instanceof ContentDoc)) continue
    const content = /** @type {ContentDoc} */ (/** @type {Item} */ (struct).content)
    const current = applyIntrinsic(mapGetIntrinsic, state.byContent, [content])
    if (current === undefined || current.item !== struct || current.content !== content) return false
  }
  return true
}

/** @param {PreparedContentDocState} state @param {object} transaction */
export const transferPreparedContentDocs = (state, transaction) => {
  adoptPreparedSubdocs(transaction, state.records)
  for (let index = 0; index < state.records.length; index++) state.records[index].transferred = true
}

/** @param {PreparedContentDocState} state */
export const disposePreparedContentDocs = state => disposePreparedContentDocRecords(state.records)
