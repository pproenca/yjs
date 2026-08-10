import * as s from 'lib0/schema'
import * as error from 'lib0/error'
import { ObservableV2 } from 'lib0/observable'

import { createContentAttribute, createIdMap, createIdSet } from './ids.js'

const objectDefineProperty = Object.defineProperty

/** @param {any[]} values @param {any} value */
const appendDense = (values, value) => {
  objectDefineProperty(values, values.length, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
}

/**
 * @typedef {{ revision: number, active: boolean }} RendererLifecycleSnapshot
 */

/**
 * Renderer lifecycle state is deliberately kept outside renderer instances. Consumers can retain
 * the frozen snapshot as an identity token, but cannot mutate or replace the current state.
 *
 * @type {WeakMap<object, Readonly<RendererLifecycleSnapshot>>}
 */
const rendererLifecycles = new WeakMap()

/**
 * Renderer execution is a private projection capability, separate from the caller-visible renderer
 * object. Reserved mutations retain this sealed adapter so later public property changes cannot
 * alter targeting or fail after a write.
 *
 * @type {WeakMap<object, Readonly<{adapter:Readonly<AbstractRenderer>,dependencies:readonly Doc[],readPolicy:(()=>any)|null}>>}
 */
const rendererExecutionAdapters = new WeakMap()

/**
 * @param {object} renderer
 * @param {AbstractRenderer} adapter
 * @param {readonly Doc[]} dependencies
 * @param {()=>any} [readPolicy]
 */
export const registerRendererExecutionAdapter = (renderer, adapter, dependencies, readPolicy) => {
  error.assert(!rendererExecutionAdapters.has(renderer))
  const sealed = Object.freeze({
    hasItem: adapter.hasItem,
    readContent: adapter.readContent,
    contentLength: adapter.contentLength
  })
  /** @type {Doc[]} */
  const ownedDependencies = []
  for (let index = 0; index < dependencies.length; index++) appendDense(ownedDependencies, dependencies[index])
  rendererExecutionAdapters.set(renderer, Object.freeze({
    adapter: /** @type {Readonly<AbstractRenderer>} */ (sealed),
    dependencies: Object.freeze(ownedDependencies),
    readPolicy: readPolicy ?? null
  }))
}

/**
 * @param {object} renderer
 * @return {Readonly<{adapter:Readonly<AbstractRenderer>,dependencies:readonly Doc[]}>?}
 */
export const readRendererExecutionAdapter = renderer => rendererExecutionAdapters.get(renderer) ?? null

/** @param {object} renderer */
export const readRendererPolicySnapshot = renderer => {
  const execution = rendererExecutionAdapters.get(renderer)
  if (execution === undefined || execution.readPolicy === null) return null
  const policy = execution.readPolicy()
  const origins = policy.suggestionOrigins
  let capturedOrigins = null
  if (origins !== null) {
    if (!Array.isArray(origins)) throw new TypeError('suggestionOrigins must be an array or null')
    const length = origins.length
    capturedOrigins = new Array(length)
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(origins, String(index))
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError('suggestionOrigins must contain own data entries')
      }
      objectDefineProperty(capturedOrigins, index, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true
      })
    }
    Object.freeze(capturedOrigins)
  }
  return Object.freeze({ suggestionMode: policy.suggestionMode, suggestionOrigins: capturedOrigins })
}

/** @param {object} renderer @param {any} snapshot */
export const rendererPolicySnapshotIsFresh = (renderer, snapshot) => {
  const current = readRendererPolicySnapshot(renderer)
  if (current === null || snapshot === null || current.suggestionMode !== snapshot.suggestionMode) return current === snapshot
  if (current.suggestionOrigins === null || snapshot.suggestionOrigins === null) return current.suggestionOrigins === snapshot.suggestionOrigins
  if (current.suggestionOrigins.length !== snapshot.suggestionOrigins.length) return false
  for (let index = 0; index < current.suggestionOrigins.length; index++) {
    if (current.suggestionOrigins[index] !== snapshot.suggestionOrigins[index]) return false
  }
  return true
}

/**
 * @param {object} renderer
 */
export const initializeRendererLifecycle = renderer => {
  error.assert(!rendererLifecycles.has(renderer))
  rendererLifecycles.set(renderer, Object.freeze({ revision: 0, active: true }))
}

/**
 * @param {object} renderer
 * @return {Readonly<RendererLifecycleSnapshot>?}
 */
export const readRendererLifecycle = renderer => rendererLifecycles.get(renderer) ?? null

/**
 * @param {object} renderer
 * @return {Readonly<RendererLifecycleSnapshot>}
 */
const requireRendererLifecycle = renderer => {
  const lifecycle = rendererLifecycles.get(renderer)
  if (lifecycle === undefined) error.unexpectedCase()
  return lifecycle
}

/**
 * @param {object} renderer
 */
export const invalidateRendererLifecycle = renderer => {
  const lifecycle = requireRendererLifecycle(renderer)
  rendererLifecycles.set(renderer, Object.freeze({
    revision: lifecycle.revision + 1,
    active: lifecycle.active
  }))
}

/**
 * @param {object} renderer
 */
export const destroyRendererLifecycle = renderer => {
  const lifecycle = requireRendererLifecycle(renderer)
  if (!lifecycle.active) return
  rendererLifecycles.set(renderer, Object.freeze({
    revision: lifecycle.revision + 1,
    active: false
  }))
}

/**
 * Snapshot attribution data without retaining caller-owned mutable values. Cyclic references and
 * values outside the wire-data domain become `undefined`; supported primitives retain exact JS
 * semantics, and shared-memory bytes are copied to isolated backing storage.
 *
 * @param {any} value
 */
const cloneRendererAttributionValue = value => {
  /** @type {Map<object, any>} */
  const clones = new Map()
  /** @type {Set<object>} */
  const active = new Set()
  /**
   * @param {any} current
   * @return {any}
   */
  const clone = current => {
    if ((typeof current !== 'object' || current === null) && typeof current !== 'function') {
      return typeof current === 'symbol' ? undefined : current
    }
    if (typeof current === 'function' || active.has(current)) return undefined
    if (clones.has(current)) return clones.get(current)
    active.add(current)
    try {
      if (current instanceof Uint8Array) {
        let copiedBuffer = clones.get(current.buffer)
        if (copiedBuffer === undefined) {
          const shared = typeof SharedArrayBuffer !== 'undefined' && current.buffer instanceof SharedArrayBuffer
          copiedBuffer = shared ? new SharedArrayBuffer(current.buffer.byteLength) : new ArrayBuffer(current.buffer.byteLength)
          new Uint8Array(copiedBuffer).set(new Uint8Array(current.buffer))
          clones.set(current.buffer, copiedBuffer)
        }
        const copied = new Uint8Array(copiedBuffer, current.byteOffset, current.byteLength)
        clones.set(current, copied)
        return copied
      }
      if (current instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && current instanceof SharedArrayBuffer)) {
        const shared = typeof SharedArrayBuffer !== 'undefined' && current instanceof SharedArrayBuffer
        const copied = shared ? new SharedArrayBuffer(current.byteLength) : new ArrayBuffer(current.byteLength)
        new Uint8Array(copied).set(new Uint8Array(current))
        clones.set(current, copied)
        return copied
      }
      if (current instanceof Date) {
        const copied = new Date(current.getTime())
        clones.set(current, copied)
        return copied
      }
      if (current instanceof RegExp) {
        const copied = new RegExp(current.source, current.flags)
        copied.lastIndex = current.lastIndex
        clones.set(current, copied)
        return copied
      }
      if (current instanceof Map) {
        const copied = new Map()
        clones.set(current, copied)
        current.forEach((entryValue, entryKey) => copied.set(clone(entryKey), clone(entryValue)))
        return copied
      }
      if (current instanceof Set) {
        const copied = new Set()
        clones.set(current, copied)
        current.forEach(entry => copied.add(clone(entry)))
        return copied
      }
      if (Array.isArray(current)) {
        const copied = new Array(current.length)
        clones.set(current, copied)
        for (let index = 0; index < current.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(current, index)
          if (descriptor?.enumerable) {
            let item
            try { item = current[index] } catch {}
            objectDefineProperty(copied, index, {
              configurable: true,
              enumerable: true,
              value: clone(item),
              writable: true
            })
          }
        }
        return copied
      }
      const copied = Object.create(Object.getPrototypeOf(current) === null ? null : Object.prototype)
      clones.set(current, copied)
      Object.keys(current).forEach(key => {
        let propertyValue
        try { propertyValue = current[key] } catch {}
        Object.defineProperty(copied, key, {
          configurable: true,
          enumerable: true,
          value: clone(propertyValue),
          writable: true
        })
      })
      return copied
    } catch {
      clones.set(current, undefined)
      return undefined
    } finally {
      active.delete(current)
    }
  }
  return clone(value)
}

/** @param {ContentAttribute<any>} attr */
export const cloneRendererContentAttribute = attr => createContentAttribute(attr.name, cloneRendererAttributionValue(attr.val))

/**
 * @param {IdMap<any>} idmap
 */
export const cloneRendererIdMap = idmap => {
  const clone = createIdMap()
  /** @type {Map<ContentAttribute<any>, ContentAttribute<any>>} */
  const attributes = new Map()
  idmap.forEach((range, client) => {
    /** @type {Array<ContentAttribute<any>>} */
    const clonedAttributes = []
    for (let index = 0; index < range.attrs.length; index++) {
      const attr = range.attrs[index]
      let cloned = attributes.get(attr)
      if (cloned === undefined) {
        cloned = cloneRendererContentAttribute(attr)
        attributes.set(attr, cloned)
      }
      appendDense(clonedAttributes, cloned)
    }
    clone.add(client, range.clock, range.len, clonedAttributes)
  })
  return clone
}

/** @param {IdSet} idset */
export const cloneRendererIdSet = idset => {
  const clone = createIdSet()
  idset.forEach((range, client) => {
    clone.add(client, range.clock, range.len)
  })
  return clone
}

export const attributionJsonSchema = s.$object({
  insert: s.$array(s.$string).optional,
  insertAt: s.$number.optional,
  delete: s.$array(s.$string).optional,
  deleteAt: s.$number.optional,
  format: s.$record(s.$string, s.$array(s.$string)).optional,
  formatAt: s.$number.optional
})

/**
 * @todo rename this to `insertBy`, `insertAt`, ..
 *
 * @typedef {s.Unwrap<typeof attributionJsonSchema>} Attribution
 */

/**
 * @template T
 */
export class AttributedContent {
  /**
   * @param {AbstractContent} content
   * @param {number} clock
   * @param {boolean} deleted
   * @param {Array<ContentAttribute<T>> | null} attrs
   * @param {0|1|2|3} renderBehavior
   */
  constructor (content, clock, deleted, attrs, renderBehavior) {
    this.content = content
    this.clock = clock
    this.deleted = deleted
    this.attrs = attrs
    this.render = renderBehavior === 0 ? false : (renderBehavior === 1 ? (!deleted || attrs != null) : true)
    /**
     * Fresh content that was deleted in the same transaction (mode `3`): even in a
     * `retainDeletes` render it must produce an *insert* — the consuming state (e.g. the
     * maintained `delta` cache) has never seen this content, so there is nothing to retain.
     */
    this.fresh = renderBehavior === 3
  }
}

/**
 * Abstract base class for renderers. A renderer renders Content (with Attributions) to a delta.
 *
 * Should fire an event when the attributions changed _after_ the original change happens. This
 * Event will be used to update the attribution on the current content.
 *
 * Only items claimed via {@link AbstractRenderer#hasItem} reach the renderer — everything else is
 * rendered by the generic fast path (as-is, without attributions, deleted content invisible).
 *
 * @extends {ObservableV2<{change:(idset:IdSet,origin:any,local:boolean)=>void}>}
 */
export class AbstractRenderer extends ObservableV2 {
  constructor () {
    super()
    /**
     * Ids of the content this renderer may render non-normally (attributed, restored, hidden, …).
     * May over-approximate — {@link AbstractRenderer#readContent} remains authoritative for what
     * is actually rendered. Content outside this set is rendered by the generic fast path without
     * consulting the renderer.
     *
     * @type {IdSet}
     */
    this.attributed = createIdSet()
  }

  /**
   * Whether `item` (any part of its id range) must be rendered by this renderer. Items for which
   * this returns `false` are rendered by the generic fast path.
   *
   * @param {Item} item
   * @return {boolean}
   */
  hasItem (item) {
    return this.attributed.intersects(item.id.client, item.id.clock, item.length)
  }

  /**
   * @param {Array<AttributedContent<any>>} _contents - where to write the result
   * @param {number} _client
   * @param {number} _clock
   * @param {boolean} _deleted
   * @param {AbstractContent} _content
   * @param {0|1|2|3} _shouldRender - 0: if undeleted or attributed, render as a retain operation. 1: render only if undeleted or attributed. 2: render as insert operation (if unattributed and deleted, render as delete). 3: fresh content deleted in the same transaction, marked {@link AttributedContent#fresh} — render as insert where attributed (it must insert even in a `retainDeletes` render: the consuming state has never seen it), as *nothing* where unattributed (invisible; a delete op would misapply).
   */
  readContent (_contents, _client, _clock, _deleted, _content, _shouldRender) {
    error.methodUnimplemented()
  }

  /**
   * Calculate the length of the attributed content. This is used by iterators that walk through the
   * content.
   *
   * If the content is not countable, it should return 0.
   *
   * @param {Item} _item
   * @return {number}
   */
  contentLength (_item) {
    error.methodUnimplemented()
  }
}

export const $renderer = AbstractRenderer.prototype.$type = s.$type('y:r', AbstractRenderer)

/**
 * The absence of a renderer: content renders as-is via the generic fast path, without any
 * attribution lookups.
 *
 * @deprecated pass `null` (or omit the renderer option) instead — kept as an alias for downstream
 * code that referenced the former base-renderer object.
 * @type {null}
 */
export const baseRenderer = null

/**
 * Rendered length of `item` under `renderer`: the generic rule — alive countable content renders
 * at full length, everything else at length `0` — unless the renderer claims the item.
 *
 * @param {AbstractRenderer?} renderer
 * @param {Item} item
 * @return {number}
 */
export const rendererContentLength = (renderer, item) =>
  renderer !== null && renderer.hasItem(item)
    ? renderer.contentLength(item)
    : ((item.deleted || !item.content.isCountable()) ? 0 : item.length)
