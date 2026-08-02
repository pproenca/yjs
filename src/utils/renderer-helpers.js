import * as s from 'lib0/schema'
import * as error from 'lib0/error'
import { ObservableV2 } from 'lib0/observable'

import { createIdSet } from './ids.js'

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
  rendererLifecycles.set(renderer, Object.freeze({
    revision: lifecycle.revision + 1,
    active: false
  }))
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
