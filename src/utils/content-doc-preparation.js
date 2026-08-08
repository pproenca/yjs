import { ContentDoc, Item } from '../structs/Item.js'
import { captureDocConstructionRevision, isFreshDocConstruction, normalizeDocOptions, revokeFreshDocConstruction } from './Doc.js'

const applyIntrinsic = Reflect.apply
const mapGetIntrinsic = Map.prototype.get
const mapSetIntrinsic = Map.prototype.set
const getOwnPropertyDescriptorIntrinsic = Object.getOwnPropertyDescriptor

/**
 * @typedef {{content:ContentDoc,doc:import('./Doc.js').Doc,constructionRevision:number,shouldLoad:boolean,integrated:boolean}} PreparedContentDoc
 * @typedef {{records:Array<PreparedContentDoc>,byContent:Map<ContentDoc,PreparedContentDoc>}} PreparedContentDocState
 */

/** @param {import('./Doc.js').Doc} doc @param {number} constructionRevision */
const readPreparedContentDocLifecycle = (doc, constructionRevision) => {
  if (!isFreshDocConstruction(doc, constructionRevision)) return null
  const item = getOwnPropertyDescriptorIntrinsic(doc, '_item')
  const shouldLoad = getOwnPropertyDescriptorIntrinsic(doc, 'shouldLoad')
  return item !== undefined && 'value' in item && item.value === null && item.writable === true &&
    shouldLoad !== undefined && 'value' in shouldLoad && typeof shouldLoad.value === 'boolean'
    ? { shouldLoad: shouldLoad.value }
    : null
}

/** @param {PreparedContentDoc} prepared */
const preparedContentDocIsStable = prepared => {
  if (prepared.content.doc !== prepared.doc) return false
  const lifecycle = readPreparedContentDocLifecycle(prepared.doc, prepared.constructionRevision)
  return lifecycle !== null && lifecycle.shouldLoad === prepared.shouldLoad
}

/** @param {Array<PreparedContentDoc>} prepared */
const disposePreparedContentDocRecords = prepared => {
  for (let index = 0; index < prepared.length; index++) {
    const current = prepared[index]
    if (current.integrated) continue
    const stable = preparedContentDocIsStable(current)
    if (current.content.doc === current.doc) current.content.doc = null
    if (stable) revokeFreshDocConstruction(current.doc, current.constructionRevision)
  }
}

/** @returns {PreparedContentDocState} */
export const createPreparedContentDocState = () => ({ records: [], byContent: new Map() })

/**
 * Construct only subdocuments in the frozen integration schedule. ContentDoc.integrate reuses `doc`.
 *
 * @param {Array<{struct:import('../structs/GC.js').GC|Item|import('../structs/CausalHole.js').CausalHole,clock:number,gap:number}>} ordered
 * @param {import('./Doc.js').Doc} target
 * @param {PreparedContentDocState} state
 * @param {()=>boolean} isStable
 */
export const prepareContentDocs = (ordered, target, state, isStable) => {
  const scheduled = new Set(ordered
    .map(entry => entry.struct)
    .filter(struct => struct.constructor === Item && /** @type {Item} */ (struct).content instanceof ContentDoc)
    .map(struct => /** @type {ContentDoc} */ (/** @type {Item} */ (struct).content)))
  const stale = state.records.filter(current => !scheduled.has(current.content))
  disposePreparedContentDocRecords(stale)
  for (let index = state.records.length - 1; index >= 0; index--) {
    if (!scheduled.has(state.records[index].content)) state.records.splice(index, 1)
  }
  try {
    for (const content of scheduled) {
      normalizeDocOptions(content.opts)
      if (content.doc !== null) {
        const current = applyIntrinsic(mapGetIntrinsic, state.byContent, [content])
        if (current === undefined || !preparedContentDocIsStable(current)) {
          throw new Error('Prepared subdocument lifecycle changed during planning')
        }
        continue
      }
      const opts = content.opts
      const constructionRevision = captureDocConstructionRevision()
      const doc = /** @type {import('./Doc.js').Doc} */ (new /** @type {any} */ (target.constructor)({
        guid: content.guid,
        ...opts,
        shouldLoad: opts.shouldLoad || opts.autoLoad || false
      }))
      const lifecycle = readPreparedContentDocLifecycle(doc, constructionRevision)
      if (lifecycle === null) {
        throw new Error('Prepared subdocument must be a fresh document with stable lifecycle fields')
      }
      const current = { content, doc, constructionRevision, shouldLoad: lifecycle.shouldLoad, integrated: false }
      content.doc = doc
      state.records.push(current)
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
    if (current === undefined || current.content !== content) return false
  }
  return true
}

/** @param {PreparedContentDocState} state @param {ContentDoc} content */
export const getPreparedContentDoc = (state, content) => {
  const prepared = applyIntrinsic(mapGetIntrinsic, state.byContent, [content])
  if (prepared === undefined) throw new Error('Prepared subdocument record is missing')
  return prepared
}

/** @param {PreparedContentDoc} prepared */
export const markPreparedContentDocIntegrated = prepared => { prepared.integrated = true }

/** @param {PreparedContentDocState} state */
export const disposePreparedContentDocs = state => disposePreparedContentDocRecords(state.records)
