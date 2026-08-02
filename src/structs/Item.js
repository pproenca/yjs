import * as error from 'lib0/error'
import * as binary from 'lib0/binary'
import * as encoding from 'lib0/encoding'
import * as env from 'lib0/environment'
import * as object from 'lib0/object'

import { AbstractStruct, addStructToIdSet } from '../structs/AbstractStruct.js'

import { ID, createID, compareIDs, findRootTypeKey } from '../utils/ID.js'
import { GC } from '../structs/GC.js'
import { Skip } from '../structs/Skip.js'
import { readReservedMutationTransactionRuntime, recordReservedMutationTransactionWrite } from '../utils/reserved-mutation-runtime.js'

import {
  replaceStruct,
  getItemCleanEnd,
  addChangedTypeToTransaction,
  findIndexSS
} from '../utils/transaction-helpers.js'

const isDevMode = env.getVariable('node_env') === 'development'
const objectCreate = Object.create
const objectDefineProperty = Object.defineProperty
const objectFreeze = Object.freeze
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const objectGetPrototypeOf = Object.getPrototypeOf
const objectIs = Object.is
const objectKeys = Object.keys
const objectHasOwnProperty = Object.prototype.hasOwnProperty
const reflectApply = Reflect.apply
const arraySlice = Array.prototype.slice
const arrayConcat = Array.prototype.concat
const arraySplice = Array.prototype.splice
const stringCharCodeAt = String.prototype.charCodeAt
const stringSlice = String.prototype.slice
const mapForEach = Map.prototype.forEach
const mapGet = Map.prototype.get
const mapSet = Map.prototype.set
const setAdd = Set.prototype.add
const setClear = Set.prototype.clear
const setDelete = Set.prototype.delete
const setHas = Set.prototype.has
const jsonStringify = JSON.stringify
const mathMax = Math.max
const mathMin = Math.min
const NativeMap = Map
const NativeSet = Set
const deepFreeze = object.deepFreeze
/** @type {Map<object, any>} */
const canonicalContentKernels = new Map()

/** @param {object} value @param {PropertyKey} key */
const hasOwn = (value, key) => reflectApply(objectHasOwnProperty, value, [key])

/** @param {object} value @param {PropertyKey} key */
const readOwnDataCanonical = (value, key) => {
  const descriptor = objectGetOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !hasOwn(descriptor, 'value')) throw new Error('Invalid reserved mutation structural field')
  return descriptor.value
}

/** @param {object} value @param {PropertyKey} key @param {any} next */
const writeOwnDataCanonical = (value, key, next) => {
  const descriptor = objectGetOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !hasOwn(descriptor, 'value') || !descriptor.writable) {
    throw new Error('Invalid reserved mutation writable field')
  }
  objectDefineProperty(value, key, {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    value: next,
    writable: descriptor.writable
  })
}

/** @param {any[]} values @param {any} value */
const appendDense = (values, value) => objectDefineProperty(values, values.length, {
  configurable: true,
  enumerable: true,
  value,
  writable: true
})

/** @param {Transaction} transaction @param {YType} type @param {string|null} parentSub @param {any} runtime */
const addChangedTypeCanonical = (transaction, type, parentSub, runtime) => {
  const item = readOwnDataCanonical(type, '_item')
  if (item !== null && runtime.idSets.hasId(transaction.insertSet, readOwnDataCanonical(item, 'id'))) return
  let subs = reflectApply(mapGet, transaction.changed, [type])
  if (subs === undefined) {
    subs = new NativeSet()
    reflectApply(mapSet, transaction.changed, [type, subs])
  }
  reflectApply(setAdd, subs, [parentSub])
}

/**
 * @todo This should return several items
 *
 * @param {StructStore} store
 * @param {ID} id
 * @return {{item:Item, diff:number}}
 */
export const followRedone = (store, id) => {
  /**
   * @type {ID|null}
   */
  let nextID = id
  let diff = 0
  let item
  do {
    if (diff > 0) {
      nextID = createID(nextID.client, nextID.clock + diff)
    }
    item = store.getItem(nextID)
    diff = nextID.clock - item.id.clock
    nextID = item.redone
  } while (nextID !== null && item.isItem)
  return {
    item, diff
  }
}

/**
 * Abstract class that represents any content.
 */
export class Item extends AbstractStruct {
  /**
   * @param {ID} id
   * @param {Item | null} left
   * @param {ID | null} origin
   * @param {Item | null} right
   * @param {ID | null} rightOrigin
   * @param {YType|ID|string|null} parent Is a type if integrated, is null if it is possible to copy parent from left or right, is ID before integration to search for it, is string if child of top-level-parent
   * @param {string | null} parentSub
   * @param {AbstractContent} content
   */
  constructor (id, left, origin, right, rightOrigin, parent, parentSub, content) {
    super(id, content.getLength())
    /**
     * The item that was originally to the left of this item.
     * @type {ID | null}
     */
    this.origin = origin
    /**
     * The item that is currently to the left of this item.
     * @type {Item | null}
     */
    this.left = left
    /**
     * The item that is currently to the right of this item.
     * @type {Item | null}
     */
    this.right = right
    /**
     * The item that was originally to the right of this item.
     * @type {ID | null}
     */
    this.rightOrigin = rightOrigin
    /**
     * @type {YType|ID|string|null}
     */
    this.parent = parent
    /**
     * If the parent refers to this item with some kind of key (e.g. YMap, the
     * key is specified here. The key is then used to refer to the list in which
     * to insert this item. If `parentSub = null` type._start is the list in
     * which to insert to. Otherwise it is `parent._map`.
     * @type {String | null}
     */
    this.parentSub = parentSub
    /**
     * If this type's effect is redone this type refers to the type that undid
     * this operation.
     * @type {ID | null}
     */
    this.redone = null
    /**
     * @type {AbstractContent}
     */
    this.content = content
    /**
     * bit1: keep
     * bit2: countable
     * bit3: deleted
     * bit4: mark - mark node as fast-search-marker
     * @type {number} byte
     */
    this.info = this.content.isCountable() ? binary.BIT2 : 0
  }

  /**
   * This is used to mark the item as an indexed fast-search marker
   *
   * @type {boolean}
   */
  set marker (isMarked) {
    if (((this.info & binary.BIT4) > 0) !== isMarked) {
      this.info ^= binary.BIT4
    }
  }

  get marker () {
    return (this.info & binary.BIT4) > 0
  }

  /**
   * If true, do not garbage collect this Item.
   */
  get keep () {
    return (this.info & binary.BIT1) > 0
  }

  set keep (doKeep) {
    if (this.keep !== doKeep) {
      this.info ^= binary.BIT1
    }
  }

  get countable () {
    return (this.info & binary.BIT2) > 0
  }

  /**
   * Whether this item was deleted or not.
   * @type {Boolean}
   */
  get deleted () {
    return (this.info & binary.BIT3) > 0
  }

  set deleted (doDelete) {
    if (this.deleted !== doDelete) {
      this.info ^= binary.BIT3
    }
  }

  markDeleted () {
    this.info |= binary.BIT3
  }

  /**
   * @param {Transaction} transaction
   * @param {number} offset
   */
  integrate (transaction, offset) {
    const reservedRuntime = readReservedMutationTransactionRuntime(transaction)
    if (reservedRuntime !== undefined) return integrateItemCanonical(this, transaction, offset, reservedRuntime)
    if (offset > 0) {
      this.id.clock += offset
      this.left = getItemCleanEnd(transaction, transaction.doc.store, createID(this.id.client, this.id.clock - 1))
      this.origin = this.left.lastId
      this.content = reservedRuntime === undefined
        ? this.content.splice(offset)
        : spliceContentCanonical(this.content, offset)
      this.length -= offset
    }

    if (this.parent) {
      if ((!this.left && (!this.right || this.right.left !== null)) || (this.left && this.left.right !== this.right)) {
        /**
         * @type {Item|null}
         */
        let left = this.left

        /**
         * @type {Item|null}
         */
        let o
        // set o to the first conflicting item
        if (left !== null) {
          o = left.right
        } else if (this.parentSub !== null) {
          o = reservedRuntime === undefined
            ? /** @type {YType} */ (this.parent)._map.get(this.parentSub) || null
            : reflectApply(mapGet, /** @type {YType} */ (this.parent)._map, [this.parentSub]) || null
          while (o !== null && o.left !== null) {
            o = o.left
          }
        } else {
          o = /** @type {YType} */ (this.parent)._start
        }
        // TODO: use something like DeleteSet here (a tree implementation would be best)
        // @todo use global set definitions
        /**
         * @type {Set<Item>}
         */
        const conflictingItems = new Set()
        /**
         * @type {Set<Item>}
         */
        const itemsBeforeOrigin = new Set()
        // Let c in conflictingItems, b in itemsBeforeOrigin
        // ***{origin}bbbb{this}{c,b}{c,b}{o}***
        // Note that conflictingItems is a subset of itemsBeforeOrigin
        while (o !== null && o !== this.right) {
          itemsBeforeOrigin.add(o)
          conflictingItems.add(o)
          if (compareIDs(this.origin, o.origin)) {
            // case 1
            if (o.id.client < this.id.client) {
              left = o
              conflictingItems.clear()
            } else if (compareIDs(this.rightOrigin, o.rightOrigin)) {
              // this and o are conflicting and point to the same integration points. The id decides which item comes first.
              // Since this is to the left of o, we can break here
              break
            } // else, o might be integrated before an item that this conflicts with. If so, we will find it in the next iterations
          } else if (o.origin !== null && itemsBeforeOrigin.has(transaction.doc.store.getItem(o.origin))) { // use getItem instead of getItemCleanEnd because we don't want / need to split items.
            // case 2
            if (!conflictingItems.has(transaction.doc.store.getItem(o.origin))) {
              left = o
              conflictingItems.clear()
            }
          } else {
            break
          }
          o = o.right
        }
        this.left = left
      }
      // reconnect left/right + update parent map/start if necessary
      if (this.left !== null) {
        const right = this.left.right
        this.right = right
        this.left.right = this
      } else {
        let r
        if (this.parentSub !== null) {
          r = reservedRuntime === undefined
            ? /** @type {YType} */ (this.parent)._map.get(this.parentSub) || null
            : reflectApply(mapGet, /** @type {YType} */ (this.parent)._map, [this.parentSub]) || null
          while (r !== null && r.left !== null) {
            r = r.left
          }
        } else {
          r = /** @type {YType} */ (this.parent)._start
          ;/** @type {YType} */ (this.parent)._start = this
        }
        this.right = r
      }
      if (this.right !== null) {
        this.right.left = this
      } else if (this.parentSub !== null) {
        // set as current parent value if right === null and this is parentSub
        if (reservedRuntime === undefined) /** @type {YType} */ (this.parent)._map.set(this.parentSub, this)
        else reflectApply(mapSet, /** @type {YType} */ (this.parent)._map, [this.parentSub, this])
        if (this.left !== null) {
          // this is the current attribute value of parent. delete the previous value
          if (reservedRuntime === undefined) this.left.delete(transaction)
          else deleteItemCanonical(this.left, transaction)
        }
      }
      // adjust length of parent
      if (this.parentSub === null && this.countable && !this.deleted) {
        /** @type {YType} */ (this.parent)._length += this.length
      }
      if (reservedRuntime === undefined) addStructToIdSet(transaction.insertSet, this)
      else {
        reservedRuntime.idSets.add(transaction.insertSet, this.id.client, this.id.clock, this.length)
        recordReservedMutationTransactionWrite(transaction, 'insert', this.id.client, this.id.clock, this.length)
      }
      transaction.doc.store.add(this)
      if (reservedRuntime === undefined) this.content.integrate(transaction, this)
      else integrateContentCanonical(this.content, transaction, this, reservedRuntime)
      // add parent to transaction.changed
      if (reservedRuntime === undefined) addChangedTypeToTransaction(transaction, /** @type {YType} */ (this.parent), this.parentSub)
      else addChangedTypeCanonical(transaction, /** @type {YType} */ (this.parent), this.parentSub, reservedRuntime)
      if ((/** @type {YType} */ (this.parent)._item !== null && /** @type {YType} */ (this.parent)._item.deleted) || (this.parentSub !== null && this.right !== null)) {
        // delete if parent is deleted or if this is not the current attribute value of parent
        if (reservedRuntime === undefined) this.delete(transaction)
        else deleteItemCanonical(this, transaction)
      }
    } else {
      // parent is not defined. Integrate GC struct instead
      new GC(this.id, this.length).integrate(transaction, 0)
    }
  }

  /**
   * Returns the next non-deleted item
   */
  get next () {
    let n = this.right
    while (n !== null && n.deleted) {
      n = n.right
    }
    return n
  }

  /**
   * Returns the previous non-deleted item
   */
  get prev () {
    let n = this.left
    while (n !== null && n.deleted) {
      n = n.left
    }
    return n
  }

  /**
   * Computes the last content address of this Item.
   */
  get lastId () {
    // allocating ids is pretty costly because of the amount of ids created, so we try to reuse whenever possible
    return this.length === 1 ? this.id : createID(this.id.client, this.id.clock + this.length - 1)
  }

  /**
   * Try to merge two items
   *
   * @param {Item} right
   * @return {boolean}
   */
  mergeWith (right) {
    if (
      this.constructor === right.constructor &&
      compareIDs(right.origin, this.lastId) &&
      this.right === right &&
      compareIDs(this.rightOrigin, right.rightOrigin) &&
      this.id.client === right.id.client &&
      this.id.clock + this.length === right.id.clock &&
      this.deleted === right.deleted &&
      this.redone === null &&
      right.redone === null &&
      this.content.constructor === right.content.constructor &&
      this.content.mergeWith(right.content)
    ) {
      const searchMarker = /** @type {YType} */ (this.parent)._searchMarker
      if (searchMarker) {
        searchMarker.forEach(marker => {
          if (marker.p === right) {
            // right is going to be "forgotten" so we need to update the marker
            marker.p = this
            // adjust marker index
            if (!this.deleted && this.countable) {
              marker.index -= this.length
            }
          }
        })
      }
      if (right.keep) {
        this.keep = true
      }
      this.right = right.right
      if (this.right !== null) {
        this.right.left = this
      }
      this.length += right.length
      return true
    }
    return false
  }

  /**
   * Mark this Item as deleted.
   *
   * @param {Transaction} transaction
   */
  delete (transaction) {
    const reservedRuntime = readReservedMutationTransactionRuntime(transaction)
    if (reservedRuntime !== undefined) return deleteItemCanonical(this, transaction)
    if (!this.deleted) {
      const parent = /** @type {YType} */ (this.parent)
      // adjust the length of parent
      if (this.countable && this.parentSub === null) {
        parent._length -= this.length
      }
      this.markDeleted()
      if (reservedRuntime === undefined) transaction.deleteSet.add(this.id.client, this.id.clock, this.length)
      else {
        reservedRuntime.idSets.add(transaction.deleteSet, this.id.client, this.id.clock, this.length)
        recordReservedMutationTransactionWrite(transaction, 'delete', this.id.client, this.id.clock, this.length)
      }
      if (reservedRuntime === undefined) addChangedTypeToTransaction(transaction, parent, this.parentSub)
      else addChangedTypeCanonical(transaction, parent, this.parentSub, reservedRuntime)
      if (reservedRuntime === undefined) this.content.delete(transaction)
      else deleteContentCanonical(this.content, transaction, reservedRuntime)
    }
  }

  /**
   * @param {Transaction} tr
   * @param {boolean} parentGCd
   */
  gc (tr, parentGCd) {
    if (!this.deleted) {
      throw error.unexpectedCase()
    }
    this.content.gc(tr)
    if (parentGCd) {
      replaceStruct(tr, this, new GC(this.id, this.length))
    } else {
      this.content = new ContentDeleted(this.length)
    }
  }

  /**
   * Split this into two items
   * @param {Transaction?} transaction
   * @param {number} diff
   * @return {Item}
   */
  split (transaction, diff) {
    const reservedRuntime = transaction === null ? undefined : readReservedMutationTransactionRuntime(transaction)
    if (reservedRuntime !== undefined) return splitItemCanonical(this, transaction, diff)
    const rightContent = reservedRuntime === undefined
      ? this.content.splice(diff)
      : spliceContentCanonical(this.content, diff)
    // create rightItem
    const { client, clock } = this.id
    const itemArgs = [createID(client, clock + diff), this, createID(client, clock + diff - 1), this.right, this.rightOrigin, this.parent, this.parentSub, rightContent]
    const rightItem = reservedRuntime === undefined
      ? new Item(.../** @type {[ID,Item|null,ID|null,Item|null,ID|null,YType|ID|string|null,string|null,AbstractContent]} */(itemArgs))
      : createItemCanonical(.../** @type {[ID,Item|null,ID|null,Item|null,ID|null,YType|ID|string|null,string|null,AbstractContent]} */(itemArgs))
    if (this.deleted) {
      rightItem.markDeleted()
    }
    if (this.keep) {
      rightItem.keep = true
    }
    if (this.redone !== null) {
      rightItem.redone = createID(this.redone.client, this.redone.clock + diff)
    }
    if (transaction != null) {
      // update left (do not set leftItem.rightOrigin as it will lead to problems when syncing)
      this.right = rightItem
      // update right
      if (rightItem.right !== null) {
        rightItem.right.left = rightItem
      }
      // right is more specific.
      transaction._mergeStructs.push(rightItem)
      // update parent._map
      if (rightItem.parentSub !== null && rightItem.right === null) {
        if (reservedRuntime === undefined) /** @type {YType} */ (rightItem.parent)._map.set(rightItem.parentSub, rightItem)
        else reflectApply(mapSet, /** @type {YType} */ (rightItem.parent)._map, [rightItem.parentSub, rightItem])
      }
    } else {
      rightItem.left = null
      rightItem.right = null
    }
    this.length = diff
    return rightItem
  }

  /**
   * Transform the properties of this type to binary and write it to an
   * BinaryEncoder.
   *
   * This is called when this Item is sent to a remote peer.
   *
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
   * @param {number} offset
   * @param {number} offsetEnd
   */
  write (encoder, offset, offsetEnd) {
    const origin = offset > 0 ? createID(this.id.client, this.id.clock + offset - 1) : this.origin
    const rightOrigin = this.rightOrigin
    const parentSub = this.parentSub
    const info = (this.content.getRef() & binary.BITS5) |
      (origin === null ? 0 : binary.BIT8) | // origin is defined
      (rightOrigin === null ? 0 : binary.BIT7) | // right origin is defined
      (parentSub === null ? 0 : binary.BIT6) // parentSub is non-null
    encoder.writeInfo(info)
    if (origin !== null) {
      encoder.writeLeftID(origin)
    }
    if (rightOrigin !== null) {
      encoder.writeRightID(rightOrigin)
    }
    if (origin === null && rightOrigin === null) {
      const parent = /** @type {YType} */ (this.parent)
      if (parent._item !== undefined) {
        const parentItem = parent._item
        if (parentItem === null) {
          // parent type on y._map
          // find the correct key
          const ykey = findRootTypeKey(parent)
          encoder.writeParentInfo(true) // write parentYKey
          encoder.writeString(ykey)
        } else {
          encoder.writeParentInfo(false) // write parent id
          encoder.writeLeftID(parentItem.id)
        }
      } else if (parent.constructor === String) { // this edge case was added by differential updates
        encoder.writeParentInfo(true) // write parentYKey
        encoder.writeString(parent)
      } else if (parent.constructor === ID) {
        encoder.writeParentInfo(false) // write parent id
        encoder.writeLeftID(parent)
      } else {
        error.unexpectedCase()
      }
      if (parentSub !== null) {
        encoder.writeString(parentSub)
      }
    }
    this.content.write(encoder, offset, offsetEnd)
  }

  get ref () {
    return this.content.getRef()
  }
}

/**
 * @type {true}
 */
Item.prototype.isItem = true

/**
 * Do not implement this class!
 */
export class AbstractContent {
  /**
   * @return {number}
   */
  getLength () {
    throw error.methodUnimplemented()
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    throw error.methodUnimplemented()
  }

  /**
   * Should return false if this Item is some kind of meta information
   * (e.g. format information).
   *
   * * Whether this Item should be addressable via `yarray.get(i)`
   * * Whether this Item should be counted when computing yarray.length
   *
   * @return {boolean}
   */
  isCountable () {
    throw error.methodUnimplemented()
  }

  /**
   * @return {AbstractContent}
   */
  copy () {
    throw error.methodUnimplemented()
  }

  /**
   * @param {number} _offset
   * @return {AbstractContent}
   */
  splice (_offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {AbstractContent} _right
   * @return {boolean}
   */
  mergeWith (_right) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {Transaction} _transaction
   * @param {Item} _item
   */
  integrate (_transaction, _item) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {Transaction} _transaction
   */
  gc (_transaction) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} _encoder
   * @param {number} _offset
   * @param {number} _offsetEnd
   */
  write (_encoder, _offset, _offsetEnd) {
    throw error.methodUnimplemented()
  }

  /**
   * @return {1|2|3|4|5|6|7|8|9}
   */
  getRef () {
    throw error.methodUnimplemented()
  }
}

export class ContentAny {
  /**
   * @param {Array<any>} arr
   */
  constructor (arr) {
    /**
     * @type {Array<any>}
     */
    this.arr = arr
    isDevMode && object.deepFreeze(arr)
  }

  /**
   * @return {number}
   */
  getLength () {
    return this.arr.length
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return this.arr
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentAny}
   */
  copy () {
    return new ContentAny(this.arr)
  }

  /**
   * @param {number} offset
   * @return {ContentAny}
   */
  splice (offset) {
    const right = new ContentAny(this.arr.slice(offset))
    this.arr = this.arr.slice(0, offset)
    return right
  }

  /**
   * @param {ContentAny} right
   * @return {boolean}
   */
  mergeWith (right) {
    this.arr = this.arr.concat(right.arr)
    return true
  }

  /**
   * @param {Transaction} _transaction
   * @param {Item} _item
   */
  integrate (_transaction, _item) {}
  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {}
  /**
   * @param {Transaction} _tr
   */
  gc (_tr) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   * @param {number} offsetEnd
   */
  write (encoder, offset, offsetEnd) {
    const end = this.arr.length - offsetEnd
    encoder.writeLen(end - offset)
    for (let i = offset; i < end; i++) {
      const c = this.arr[i]
      encoder.writeAny(c)
    }
  }

  /**
   * @return {8}
   */
  getRef () {
    return 8
  }
}

export class ContentBinary {
  /**
   * @param {Uint8Array} content
   */
  constructor (content) {
    this.content = content
  }

  /**
   * @return {number}
   */
  getLength () {
    return 1
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return [this.content]
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentBinary}
   */
  copy () {
    return new ContentBinary(this.content)
  }

  /**
   * @param {number} _offset
   * @return {ContentBinary}
   */
  splice (_offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {ContentBinary} _right
   * @return {boolean}
   */
  mergeWith (_right) {
    return false
  }

  /**
   * @param {Transaction} _transaction
   * @param {Item} _item
   */
  integrate (_transaction, _item) {}
  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {}
  /**
   * @param {Transaction} _tr
   */
  gc (_tr) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} _offset
   * @param {number} _offsetEnd
   */
  write (encoder, _offset, _offsetEnd) {
    encoder.writeBuf(this.content)
  }

  /**
   * @return {3}
   */
  getRef () {
    return 3
  }
}

export class ContentDeleted {
  /**
   * @param {number} len
   */
  constructor (len) {
    this.len = len
  }

  /**
   * @return {number}
   */
  getLength () {
    return this.len
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return []
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return false
  }

  /**
   * @return {ContentDeleted}
   */
  copy () {
    return new ContentDeleted(this.len)
  }

  /**
   * @param {number} offset
   * @return {ContentDeleted}
   */
  splice (offset) {
    const right = new ContentDeleted(this.len - offset)
    this.len = offset
    return right
  }

  /**
   * @param {ContentDeleted} right
   * @return {boolean}
   */
  mergeWith (right) {
    this.len += right.len
    return true
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {
    transaction.deleteSet.add(item.id.client, item.id.clock, this.len)
    item.markDeleted()
  }

  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {}
  /**
   * @param {Transaction} _tr
   */
  gc (_tr) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   * @param {number} offsetEnd
   */
  write (encoder, offset, offsetEnd) {
    encoder.writeLen(this.len - offset - offsetEnd)
  }

  /**
   * @return {1}
   */
  getRef () {
    return 1
  }
}

/**
 * @private
 */
export class ContentDoc {
  /**
   * @param {string} guid
   * @param {Object<string,any>} opts
   */
  constructor (guid, opts) {
    /**
     * @type {Doc?}
     */
    this.doc = null
    this.guid = guid
    this.opts = opts
  }

  /**
   * @return {number}
   */
  getLength () {
    return 1
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return [this.doc]
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentDoc}
   */
  copy () {
    return new ContentDoc(this.guid, this.opts)
  }

  /**
   * @param {number} _offset
   * @return {ContentDoc}
   */
  splice (_offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {ContentDoc} _right
   * @return {boolean}
   */
  mergeWith (_right) {
    return false
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {
    const opts = this.opts
    if (this.doc == null) {
      // we get the constructor from the existing doc to avoid import the doc module, leading to a
      // circular dependency
      this.doc = /** @type {Doc} */ (new /** @type {any} */ (transaction.doc.constructor)({ guid: this.guid, ...this.opts, shouldLoad: opts.shouldLoad || opts.autoLoad || false }))
    }
    this.doc._item = item
    transaction.subdocsAdded.add(this.doc)
    if (this.doc.shouldLoad) {
      transaction.subdocsLoaded.add(this.doc)
    }
  }

  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {
    if (this.doc) {
      if (transaction.subdocsAdded.has(this.doc)) {
        transaction.subdocsAdded.delete(this.doc)
      } else {
        transaction.subdocsRemoved.add(this.doc)
      }
    }
  }

  /**
   * @param {Transaction} _tr
   */
  gc (_tr) {}

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} _offset
   * @param {number} _offsetEnd
   */
  write (encoder, _offset, _offsetEnd) {
    encoder.writeString(this.guid)
    encoder.writeAny(this.opts)
  }

  /**
   * @return {9}
   */
  getRef () {
    return 9
  }
}

/**
 * @param {Doc} ydoc
 */
export const createContentDocFromDoc = ydoc => {
  /**
   * @type {any}
   */
  const opts = {}
  if (!ydoc.gc) {
    opts.gc = false
  }
  if (ydoc.autoLoad) {
    opts.autoLoad = true
  }
  if (ydoc.meta !== null) {
    opts.meta = ydoc.meta
  }
  const c = new ContentDoc(ydoc.guid, opts)
  c.doc = ydoc
  return c
}

/**
 * @private
 */
export class ContentEmbed {
  /**
   * @param {Object} embed
   */
  constructor (embed) {
    this.embed = embed
  }

  /**
   * @return {number}
   */
  getLength () {
    return 1
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return [this.embed]
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentEmbed}
   */
  copy () {
    return new ContentEmbed(this.embed)
  }

  /**
   * @param {number} _offset
   * @return {ContentEmbed}
   */
  splice (_offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {ContentEmbed} _right
   * @return {boolean}
   */
  mergeWith (_right) {
    return false
  }

  /**
   * @param {Transaction} _transaction
   * @param {Item} _item
   */
  integrate (_transaction, _item) {}
  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {}
  /**
   * @param {Transaction} _tr
   */
  gc (_tr) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} _offset
   * @param {number} _offsetEnd
   */
  write (encoder, _offset, _offsetEnd) {
    encoder.writeJSON(this.embed)
  }

  /**
   * @return {5}
   */
  getRef () {
    return 5
  }
}

/**
 * @private
 */
export class ContentFormat {
  /**
   * @param {string} key
   * @param {Object} value
   */
  constructor (key, value) {
    this.key = key
    this.value = value
  }

  /**
   * @return {number}
   */
  getLength () {
    return 1
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return []
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return false
  }

  /**
   * @return {ContentFormat}
   */
  copy () {
    return new ContentFormat(this.key, this.value)
  }

  /**
   * @param {number} _offset
   * @return {ContentFormat}
   */
  splice (_offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {ContentFormat} _right
   * @return {boolean}
   */
  mergeWith (_right) {
    return false
  }

  /**
   * @param {Transaction} _transaction
   * @param {Item} item
   */
  integrate (_transaction, item) {
    // @todo searchmarker are currently unsupported for rich text documents
    const p = /** @type {import('../ytype.js').YType<any>} */ (item.parent)
    p._searchMarker = null
    p._hasFormatting = true
  }

  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {}
  /**
   * @param {Transaction} _tr
   */
  gc (_tr) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} _offset
   * @param {number} _offsetEnd
   */
  write (encoder, _offset, _offsetEnd) {
    encoder.writeKey(this.key)
    encoder.writeJSON(this.value)
  }

  /**
   * @return {6}
   */
  getRef () {
    return 6
  }
}

/**
 * @private
 */
export class ContentJSON {
  /**
   * @param {Array<any>} arr
   */
  constructor (arr) {
    /**
     * @type {Array<any>}
     */
    this.arr = arr
  }

  /**
   * @return {number}
   */
  getLength () {
    return this.arr.length
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return this.arr
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentJSON}
   */
  copy () {
    return new ContentJSON(this.arr)
  }

  /**
   * @param {number} offset
   * @return {ContentJSON}
   */
  splice (offset) {
    const right = new ContentJSON(this.arr.slice(offset))
    this.arr = this.arr.slice(0, offset)
    return right
  }

  /**
   * @param {ContentJSON} right
   * @return {boolean}
   */
  mergeWith (right) {
    this.arr = this.arr.concat(right.arr)
    return true
  }

  /**
   * @param {Transaction} _transaction
   * @param {Item} _item
   */
  integrate (_transaction, _item) {}
  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {}
  /**
   * @param {Transaction} _tr
   */
  gc (_tr) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   * @param {number} offsetEnd
   */
  write (encoder, offset, offsetEnd) {
    const end = this.arr.length - offsetEnd
    encoder.writeLen(end - offset)
    for (let i = offset; i < end; i++) {
      const c = this.arr[i]
      encoder.writeString(c === undefined ? 'undefined' : JSON.stringify(c))
    }
  }

  /**
   * @return {2}
   */
  getRef () {
    return 2
  }
}

/**
 * @private
 */
export class ContentString {
  /**
   * @param {string} str
   */
  constructor (str) {
    /**
     * @type {string}
     */
    this.str = str
  }

  /**
   * @return {number}
   */
  getLength () {
    return this.str.length
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return this.str.split('')
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentString}
   */
  copy () {
    return new ContentString(this.str)
  }

  /**
   * @param {number} offset
   * @return {ContentString}
   */
  splice (offset) {
    const right = new ContentString(this.str.slice(offset))
    this.str = this.str.slice(0, offset)

    // Prevent encoding invalid documents because of splitting of surrogate pairs: https://github.com/yjs/yjs/issues/248
    const firstCharCode = this.str.charCodeAt(offset - 1)
    if (firstCharCode >= 0xD800 && firstCharCode <= 0xDBFF) {
      // Last character of the left split is the start of a surrogate utf16/ucs2 pair.
      // We don't support splitting of surrogate pairs because this may lead to invalid documents.
      // Replace the invalid character with a unicode replacement character (� / U+FFFD)
      this.str = this.str.slice(0, offset - 1) + '�'
      // replace right as well
      right.str = '�' + right.str.slice(1)
    }
    return right
  }

  /**
   * @param {ContentString} right
   * @return {boolean}
   */
  mergeWith (right) {
    this.str += right.str
    return true
  }

  /**
   * @param {Transaction} _transaction
   * @param {Item} _item
   */
  integrate (_transaction, _item) {}
  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {}
  /**
   * @param {Transaction} _tr
   */
  gc (_tr) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   * @param {number} offsetEnd
   */
  write (encoder, offset, offsetEnd) {
    encoder.writeString((offset === 0 && offsetEnd === 0) ? this.str : this.str.slice(offset, this.str.length - offsetEnd))
  }

  /**
   * @return {4}
   */
  getRef () {
    return 4
  }
}

export const YArrayRefID = 0
export const YMapRefID = 1
export const YTextRefID = 2
export const YXmlElementRefID = 3
export const YXmlFragmentRefID = 4
export const YXmlHookRefID = 5
export const YXmlTextRefID = 6

/**
 * @private
 */
export class ContentType {
  /**
   * @param {import('../ytype.js').YType} type
   */
  constructor (type) {
    /**
     * @type {import('../ytype.js').YType}
     */
    this.type = type
  }

  /**
   * @return {number}
   */
  getLength () {
    return 1
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return [this.type]
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentType}
   */
  copy () {
    return new ContentType(this.type._copy())
  }

  /**
   * @param {number} _offset
   * @return {ContentType}
   */
  splice (_offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {ContentType} _right
   * @return {boolean}
   */
  mergeWith (_right) {
    return false
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {
    this.type._integrate(transaction.doc, item)
  }

  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {
    let item = this.type._start
    while (item !== null) {
      if (!item.deleted) {
        item.delete(transaction)
      } else if (!transaction.insertSet.hasId(item.id)) {
        // This will be gc'd later and we want to merge it if possible
        // We try to merge all deleted items after each transaction,
        // but we have no knowledge about that this needs to be merged
        // since it is not in transaction.ds. Hence we add it to transaction._mergeStructs
        transaction._mergeStructs.push(item)
      }
      item = item.right
    }
    this.type._map.forEach(item => {
      if (!item.deleted) {
        item.delete(transaction)
      } else if (!transaction.insertSet.hasId(item.id)) {
        // same as above
        transaction._mergeStructs.push(item)
      }
    })
  }

  /**
   * @param {Transaction} tr
   */
  gc (tr) {
    let item = this.type._start
    while (item !== null) {
      item.gc(tr, true)
      item = item.right
    }
    this.type._start = null
    this.type._map.forEach(/** @param {Item | null} item */ (item) => {
      while (item !== null) {
        item.gc(tr, true)
        item = item.left
      }
    })
    this.type._map = new Map()
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} _offset
   * @param {number} _offsetEnd
   */
  write (encoder, _offset, _offsetEnd) {
    this.type._write(encoder)
  }

  /**
   * @return {7}
   */
  getRef () {
    return 7
  }
}

/** @type {Array<[object, string[], number, boolean, 'array'|'deleted'|'string'|null]>} */
const contentKernelDefinitions = [
  [ContentAny.prototype, ['arr'], 8, true, 'array'],
  [ContentBinary.prototype, ['content'], 3, true, null],
  [ContentDeleted.prototype, ['len'], 1, false, 'deleted'],
  [ContentDoc.prototype, ['doc', 'guid', 'opts'], 9, true, null],
  [ContentEmbed.prototype, ['embed'], 5, true, null],
  [ContentFormat.prototype, ['key', 'value'], 6, false, null],
  [ContentJSON.prototype, ['arr'], 2, true, 'array'],
  [ContentString.prototype, ['str'], 4, true, 'string'],
  [ContentType.prototype, ['type'], 7, true, null]
]

for (let index = 0; index < contentKernelDefinitions.length; index++) {
  const [prototype, fields, ref, countable, splice] = contentKernelDefinitions[index]
  canonicalContentKernels.set(prototype, objectFreeze({ fields: objectFreeze(fields), ref, countable, splice }))
}

/** @param {AbstractContent} content */
const readContentKernel = content => {
  const kernel = reflectApply(mapGet, canonicalContentKernels, [objectGetPrototypeOf(content)])
  if (kernel === undefined) throw new Error('Unsupported reserved mutation content')
  return kernel
}

/** @param {AbstractContent} content @param {string} key */
const readContentFieldCanonical = (content, key) => readOwnDataCanonical(content, key)

/** @param {object} prototype @param {Record<string,any>} values */
const createContentCanonical = (prototype, values) => {
  const content = /** @type {AbstractContent} */ (objectCreate(prototype))
  const keys = objectKeys(values)
  for (let index = 0; index < keys.length; index++) {
    objectDefineProperty(content, keys[index], {
      configurable: true,
      enumerable: true,
      value: values[keys[index]],
      writable: true
    })
  }
  return content
}

/** @param {Array<any>} values */
const createContentAnyCanonical = values => {
  isDevMode && reflectApply(deepFreeze, object, [values])
  return /** @type {ContentAny} */ (createContentCanonical(ContentAny.prototype, { arr: values }))
}

/** @param {Uint8Array} value */
const createContentBinaryCanonical = value => /** @type {ContentBinary} */ (createContentCanonical(ContentBinary.prototype, { content: value }))

/** @param {number} length */
const createContentDeletedCanonical = length => /** @type {ContentDeleted} */ (createContentCanonical(ContentDeleted.prototype, { len: length }))

/** @param {string} key @param {any} value */
const createContentFormatCanonical = (key, value) => /** @type {ContentFormat} */ (createContentCanonical(ContentFormat.prototype, { key, value }))

/** @param {Array<any>} values */
const createContentJSONCanonical = values => /** @type {ContentJSON} */ (createContentCanonical(ContentJSON.prototype, { arr: values }))

/** @param {string} value */
const createContentStringCanonical = value => /** @type {ContentString} */ (createContentCanonical(ContentString.prototype, { str: value }))

/**
 * Construct nested content without inherited setter dispatch.
 *
 * @param {import('../ytype.js').YType} type
 */
export const createContentTypeCanonical = type => /** @type {ContentType} */ (createContentCanonical(ContentType.prototype, { type }))

/** @param {AbstractContent} content */
const getContentLengthCanonical = content => {
  const prototype = objectGetPrototypeOf(content)
  if (prototype === ContentAny.prototype || prototype === ContentJSON.prototype) {
    return readOwnDataCanonical(readContentFieldCanonical(content, 'arr'), 'length')
  }
  if (prototype === ContentDeleted.prototype) return readContentFieldCanonical(content, 'len')
  if (prototype === ContentString.prototype) return readContentFieldCanonical(content, 'str').length
  readContentKernel(content)
  return 1
}

/** @param {AbstractContent} content */
const isContentCountableCanonical = content => readContentKernel(content).countable

/** @param {AbstractContent} content @param {number} offset */
const spliceContentCanonical = (content, offset) => {
  const kernel = readContentKernel(content)
  if (kernel.splice === 'array') {
    const values = readContentFieldCanonical(content, 'arr')
    const rightValues = reflectApply(arraySlice, values, [offset])
    const leftValues = reflectApply(arraySlice, values, [0, offset])
    writeOwnDataCanonical(content, 'arr', leftValues)
    return objectGetPrototypeOf(content) === ContentAny.prototype
      ? createContentAnyCanonical(rightValues)
      : createContentJSONCanonical(rightValues)
  }
  if (kernel.splice === 'deleted') {
    const length = readContentFieldCanonical(content, 'len')
    writeOwnDataCanonical(content, 'len', offset)
    return createContentDeletedCanonical(length - offset)
  }
  if (kernel.splice === 'string') {
    const value = readContentFieldCanonical(content, 'str')
    let left = reflectApply(stringSlice, value, [0, offset])
    let right = reflectApply(stringSlice, value, [offset])
    const firstCharCode = reflectApply(stringCharCodeAt, left, [offset - 1])
    if (firstCharCode >= 0xD800 && firstCharCode <= 0xDBFF) {
      left = reflectApply(stringSlice, left, [0, offset - 1]) + '�'
      right = '�' + reflectApply(stringSlice, right, [1])
    }
    writeOwnDataCanonical(content, 'str', left)
    return createContentStringCanonical(right)
  }
  throw new Error('Reserved mutation cannot split this content')
}

/** @param {number} client @param {number} clock */
const createIdCanonical = (client, clock) => {
  const id = /** @type {ID} */ (objectCreate(ID.prototype))
  objectDefineProperty(id, 'client', { configurable: true, enumerable: true, value: client, writable: true })
  objectDefineProperty(id, 'clock', { configurable: true, enumerable: true, value: clock, writable: true })
  return id
}

/** @param {ID} id @param {'client'|'clock'} key */
const readIdFieldCanonical = (id, key) => {
  if (objectGetPrototypeOf(id) !== ID.prototype) throw new Error('Invalid reserved mutation ID')
  return readOwnDataCanonical(id, key)
}

/** @param {Item} item @param {string} key */
const readItemFieldCanonical = (item, key) => {
  if (objectGetPrototypeOf(item) !== Item.prototype) throw new Error('Invalid reserved mutation Item')
  return readOwnDataCanonical(item, key)
}

/** @param {Item} item @param {string} key @param {any} value */
const writeItemFieldCanonical = (item, key, value) => {
  if (objectGetPrototypeOf(item) !== Item.prototype) throw new Error('Invalid reserved mutation Item')
  writeOwnDataCanonical(item, key, value)
}

/** @param {Item} item */
const itemIsDeletedCanonical = item => (readItemFieldCanonical(item, 'info') & binary.BIT3) !== 0

/** @param {Item} item */
const itemIsCountableCanonical = item => (readItemFieldCanonical(item, 'info') & binary.BIT2) !== 0

/** @param {Item} item */
const markItemDeletedCanonical = item => writeItemFieldCanonical(item, 'info', readItemFieldCanonical(item, 'info') | binary.BIT3)

/** @param {Item} item */
const itemLastIdCanonical = item => {
  const id = readItemFieldCanonical(item, 'id')
  const length = readItemFieldCanonical(item, 'length')
  return length === 1 ? id : createIdCanonical(readIdFieldCanonical(id, 'client'), readIdFieldCanonical(id, 'clock') + length - 1)
}

/**
 * @param {AbstractContent} content
 * @param {Transaction} transaction
 * @param {Item} item
 * @param {any} runtime
 */
const integrateContentCanonical = (content, transaction, item, runtime) => {
  const prototype = objectGetPrototypeOf(content)
  if (prototype === ContentType.prototype) {
    runtime.integrateType(readContentFieldCanonical(content, 'type'), transaction.doc, item)
  } else if (prototype === ContentDeleted.prototype) {
    const id = readItemFieldCanonical(item, 'id')
    const client = readIdFieldCanonical(id, 'client')
    const clock = readIdFieldCanonical(id, 'clock')
    const length = readContentFieldCanonical(content, 'len')
    runtime.idSets.add(transaction.deleteSet, client, clock, length)
    recordReservedMutationTransactionWrite(transaction, 'delete', client, clock, length)
    markItemDeletedCanonical(item)
  } else if (prototype === ContentFormat.prototype) {
    const parent = readItemFieldCanonical(item, 'parent')
    writeOwnDataCanonical(parent, '_searchMarker', null)
    writeOwnDataCanonical(parent, '_hasFormatting', true)
  } else if (prototype === ContentDoc.prototype) {
    reflectApply(ContentDoc.prototype.integrate, content, [transaction, item])
  } else {
    readContentKernel(content)
  }
}

/**
 * @param {AbstractContent} content
 * @param {Transaction} transaction
 * @param {any} runtime
 */
const deleteContentCanonical = (content, transaction, runtime) => {
  const prototype = objectGetPrototypeOf(content)
  if (prototype === ContentType.prototype) {
    const type = readContentFieldCanonical(content, 'type')
    let item = readOwnDataCanonical(type, '_start')
    while (item !== null) {
      if (!itemIsDeletedCanonical(item)) {
        deleteItemCanonical(item, transaction)
      } else if (!runtime.idSets.hasId(transaction.insertSet, readItemFieldCanonical(item, 'id'))) {
        appendDense(transaction._mergeStructs, item)
      }
      item = readItemFieldCanonical(item, 'right')
    }
    reflectApply(mapForEach, readOwnDataCanonical(type, '_map'), [(mapItem) => {
      if (!itemIsDeletedCanonical(mapItem)) {
        deleteItemCanonical(mapItem, transaction)
      } else if (!runtime.idSets.hasId(transaction.insertSet, readItemFieldCanonical(mapItem, 'id'))) {
        appendDense(transaction._mergeStructs, mapItem)
      }
    }])
  } else if (prototype === ContentDoc.prototype) {
    const doc = readContentFieldCanonical(content, 'doc')
    if (doc !== null) {
      if (reflectApply(setHas, transaction.subdocsAdded, [doc])) reflectApply(setDelete, transaction.subdocsAdded, [doc])
      else reflectApply(setAdd, transaction.subdocsRemoved, [doc])
    }
  } else {
    readContentKernel(content)
  }
}

/**
 * Construct an Item without dispatching through caller-mutable content methods or inherited field
 * setters. The resulting object is a canonical Item and encodes identically.
 *
 * @param {ID} id
 * @param {Item|null} left
 * @param {ID|null} origin
 * @param {Item|null} right
 * @param {ID|null} rightOrigin
 * @param {YType|ID|string|null} parent
 * @param {string|null} parentSub
 * @param {AbstractContent} content
 */
const createItemCanonical = (id, left, origin, right, rightOrigin, parent, parentSub, content) => {
  const item = /** @type {Item} */ (objectCreate(Item.prototype))
  /** @type {Record<string,any>} */
  const values = {
    id,
    length: getContentLengthCanonical(content),
    origin,
    left,
    right,
    rightOrigin,
    parent,
    parentSub,
    redone: null,
    content,
    info: isContentCountableCanonical(content) ? binary.BIT2 : 0
  }
  const keys = objectKeys(values)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    objectDefineProperty(item, key, {
      configurable: true,
      enumerable: true,
      value: values[key],
      writable: true
    })
  }
  return item
}

/** @param {YType} type @param {string} key */
const readTypeFieldCanonical = (type, key) => readOwnDataCanonical(type, key)

/** @param {YType} type @param {string} key @param {any} value */
const writeTypeFieldCanonical = (type, key, value) => writeOwnDataCanonical(type, key, value)

/** @param {any[]} values @param {number} index @param {any} value */
const insertDense = (values, index, value) => {
  for (let current = values.length; current > index; current--) {
    objectDefineProperty(values, current, {
      configurable: true,
      enumerable: true,
      value: values[current - 1],
      writable: true
    })
  }
  objectDefineProperty(values, index, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
}

/** @param {StructStore} store @param {ID} id */
const getStoreItemCanonical = (store, id) => {
  const structs = reflectApply(mapGet, readOwnDataCanonical(store, 'clients'), [readIdFieldCanonical(id, 'client')])
  if (structs === undefined) throw new Error('Reserved mutation structural ID is unavailable')
  return structs[findIndexSS(structs, readIdFieldCanonical(id, 'clock'))]
}

/** @param {StructStore} store @param {Item} item */
const addStoreItemCanonical = (store, item) => {
  const clients = readOwnDataCanonical(store, 'clients')
  const id = readItemFieldCanonical(item, 'id')
  const client = readIdFieldCanonical(id, 'client')
  const clock = readIdFieldCanonical(id, 'clock')
  let structs = reflectApply(mapGet, clients, [client])
  if (structs === undefined) {
    structs = []
    reflectApply(mapSet, clients, [client, structs])
  } else if (structs.length > 0) {
    const last = structs[structs.length - 1]
    const lastId = readOwnDataCanonical(last, 'id')
    if (readIdFieldCanonical(lastId, 'clock') + readOwnDataCanonical(last, 'length') !== clock) {
      throw new Error('Reserved mutation cannot replace a structural skip')
    }
  }
  appendDense(structs, item)
}

/** @param {Transaction} transaction @param {ID} id */
const getItemCleanStartCanonical = (transaction, id) => {
  const structs = reflectApply(mapGet, readOwnDataCanonical(transaction.doc.store, 'clients'), [readIdFieldCanonical(id, 'client')])
  if (structs === undefined) throw new Error('Reserved mutation split target is unavailable')
  const clock = readIdFieldCanonical(id, 'clock')
  const index = findIndexSS(structs, clock)
  const item = structs[index]
  const itemClock = readIdFieldCanonical(readItemFieldCanonical(item, 'id'), 'clock')
  if (itemClock < clock) {
    const right = splitItemCanonical(item, transaction, clock - itemClock)
    insertDense(structs, index + 1, right)
    return right
  }
  return item
}

/** @param {Transaction} transaction @param {StructStore} store @param {ID} id */
const getItemCleanEndCanonical = (transaction, store, id) => {
  const structs = reflectApply(mapGet, readOwnDataCanonical(store, 'clients'), [readIdFieldCanonical(id, 'client')]) || []
  const index = findIndexSS(structs, readIdFieldCanonical(id, 'clock'))
  const item = structs[index]
  const itemId = readItemFieldCanonical(item, 'id')
  const itemClock = readIdFieldCanonical(itemId, 'clock')
  const itemLength = readItemFieldCanonical(item, 'length')
  if (readIdFieldCanonical(id, 'clock') !== itemClock + itemLength - 1) {
    insertDense(structs, index + 1, splitItemCanonical(item, transaction, readIdFieldCanonical(id, 'clock') - itemClock + 1))
  }
  return item
}

/** @param {ID|null} left @param {ID|null} right */
const idsEqualCanonical = (left, right) => left === right || (left !== null && right !== null &&
  readIdFieldCanonical(left, 'client') === readIdFieldCanonical(right, 'client') &&
  readIdFieldCanonical(left, 'clock') === readIdFieldCanonical(right, 'clock'))

/** @param {Item} item @param {Transaction} transaction @param {number} offset @param {any} runtime */
const integrateItemCanonical = (item, transaction, offset, runtime) => {
  if (offset > 0) {
    const id = readItemFieldCanonical(item, 'id')
    const nextClock = readIdFieldCanonical(id, 'clock') + offset
    writeOwnDataCanonical(id, 'clock', nextClock)
    const left = getItemCleanEndCanonical(transaction, transaction.doc.store, createIdCanonical(readIdFieldCanonical(id, 'client'), nextClock - 1))
    writeItemFieldCanonical(item, 'left', left)
    writeItemFieldCanonical(item, 'origin', itemLastIdCanonical(left))
    writeItemFieldCanonical(item, 'content', spliceContentCanonical(readItemFieldCanonical(item, 'content'), offset))
    writeItemFieldCanonical(item, 'length', readItemFieldCanonical(item, 'length') - offset)
  }
  const parent = readItemFieldCanonical(item, 'parent')
  if (parent === null) throw new Error('Reserved mutation Item requires a parent')
  let left = readItemFieldCanonical(item, 'left')
  let right = readItemFieldCanonical(item, 'right')
  const parentSub = readItemFieldCanonical(item, 'parentSub')
  if ((!left && (!right || readItemFieldCanonical(right, 'left') !== null)) || (left && readItemFieldCanonical(left, 'right') !== right)) {
    let cursor
    if (left !== null) cursor = readItemFieldCanonical(left, 'right')
    else if (parentSub !== null) {
      cursor = reflectApply(mapGet, readTypeFieldCanonical(parent, '_map'), [parentSub]) || null
      while (cursor !== null && readItemFieldCanonical(cursor, 'left') !== null) cursor = readItemFieldCanonical(cursor, 'left')
    } else cursor = readTypeFieldCanonical(parent, '_start')
    const conflicting = new NativeSet()
    const beforeOrigin = new NativeSet()
    while (cursor !== null && cursor !== right) {
      reflectApply(setAdd, beforeOrigin, [cursor])
      reflectApply(setAdd, conflicting, [cursor])
      if (idsEqualCanonical(readItemFieldCanonical(item, 'origin'), readItemFieldCanonical(cursor, 'origin'))) {
        if (readIdFieldCanonical(readItemFieldCanonical(cursor, 'id'), 'client') < readIdFieldCanonical(readItemFieldCanonical(item, 'id'), 'client')) {
          left = cursor
          reflectApply(setClear, conflicting, [])
        } else if (idsEqualCanonical(readItemFieldCanonical(item, 'rightOrigin'), readItemFieldCanonical(cursor, 'rightOrigin'))) break
      } else {
        const cursorOrigin = readItemFieldCanonical(cursor, 'origin')
        if (cursorOrigin !== null && reflectApply(setHas, beforeOrigin, [getStoreItemCanonical(transaction.doc.store, cursorOrigin)])) {
          if (!reflectApply(setHas, conflicting, [getStoreItemCanonical(transaction.doc.store, cursorOrigin)])) {
            left = cursor
            reflectApply(setClear, conflicting, [])
          }
        } else break
      }
      cursor = readItemFieldCanonical(cursor, 'right')
    }
    writeItemFieldCanonical(item, 'left', left)
  }
  left = readItemFieldCanonical(item, 'left')
  if (left !== null) {
    right = readItemFieldCanonical(left, 'right')
    writeItemFieldCanonical(item, 'right', right)
    writeItemFieldCanonical(left, 'right', item)
  } else {
    if (parentSub !== null) {
      right = reflectApply(mapGet, readTypeFieldCanonical(parent, '_map'), [parentSub]) || null
      while (right !== null && readItemFieldCanonical(right, 'left') !== null) right = readItemFieldCanonical(right, 'left')
    } else {
      right = readTypeFieldCanonical(parent, '_start')
      writeTypeFieldCanonical(parent, '_start', item)
    }
    writeItemFieldCanonical(item, 'right', right)
  }
  if (right !== null) writeItemFieldCanonical(right, 'left', item)
  else if (parentSub !== null) {
    reflectApply(mapSet, readTypeFieldCanonical(parent, '_map'), [parentSub, item])
    if (left !== null) deleteItemCanonical(left, transaction)
  }
  if (parentSub === null && itemIsCountableCanonical(item) && !itemIsDeletedCanonical(item)) {
    writeTypeFieldCanonical(parent, '_length', readTypeFieldCanonical(parent, '_length') + readItemFieldCanonical(item, 'length'))
  }
  const id = readItemFieldCanonical(item, 'id')
  const client = readIdFieldCanonical(id, 'client')
  const clock = readIdFieldCanonical(id, 'clock')
  const length = readItemFieldCanonical(item, 'length')
  runtime.idSets.add(transaction.insertSet, client, clock, length)
  recordReservedMutationTransactionWrite(transaction, 'insert', client, clock, length)
  addStoreItemCanonical(transaction.doc.store, item)
  integrateContentCanonical(readItemFieldCanonical(item, 'content'), transaction, item, runtime)
  addChangedTypeCanonical(transaction, parent, parentSub, runtime)
  const parentItem = readTypeFieldCanonical(parent, '_item')
  if ((parentItem !== null && itemIsDeletedCanonical(parentItem)) || (parentSub !== null && readItemFieldCanonical(item, 'right') !== null)) {
    deleteItemCanonical(item, transaction)
  }
}

/** @param {Item} item @param {Transaction} transaction */
const deleteItemCanonical = (item, transaction) => {
  if (itemIsDeletedCanonical(item)) return
  const runtime = readReservedMutationTransactionRuntime(transaction)
  if (runtime === undefined) throw new Error('Reserved mutation runtime is unavailable')
  const parent = readItemFieldCanonical(item, 'parent')
  const parentSub = readItemFieldCanonical(item, 'parentSub')
  const length = readItemFieldCanonical(item, 'length')
  if (itemIsCountableCanonical(item) && parentSub === null) {
    writeTypeFieldCanonical(parent, '_length', readTypeFieldCanonical(parent, '_length') - length)
  }
  markItemDeletedCanonical(item)
  const id = readItemFieldCanonical(item, 'id')
  const client = readIdFieldCanonical(id, 'client')
  const clock = readIdFieldCanonical(id, 'clock')
  runtime.idSets.add(transaction.deleteSet, client, clock, length)
  recordReservedMutationTransactionWrite(transaction, 'delete', client, clock, length)
  addChangedTypeCanonical(transaction, parent, parentSub, runtime)
  deleteContentCanonical(readItemFieldCanonical(item, 'content'), transaction, runtime)
}

/** @param {Item} item @param {Transaction?} transaction @param {number} diff */
const splitItemCanonical = (item, transaction, diff) => {
  const content = readItemFieldCanonical(item, 'content')
  const rightContent = spliceContentCanonical(content, diff)
  const id = readItemFieldCanonical(item, 'id')
  const client = readIdFieldCanonical(id, 'client')
  const clock = readIdFieldCanonical(id, 'clock')
  const rightItem = createItemCanonical(
    createIdCanonical(client, clock + diff),
    item,
    createIdCanonical(client, clock + diff - 1),
    readItemFieldCanonical(item, 'right'),
    readItemFieldCanonical(item, 'rightOrigin'),
    readItemFieldCanonical(item, 'parent'),
    readItemFieldCanonical(item, 'parentSub'),
    rightContent
  )
  if (itemIsDeletedCanonical(item)) markItemDeletedCanonical(rightItem)
  if ((readItemFieldCanonical(item, 'info') & binary.BIT1) !== 0) {
    writeItemFieldCanonical(rightItem, 'info', readItemFieldCanonical(rightItem, 'info') | binary.BIT1)
  }
  const redone = readItemFieldCanonical(item, 'redone')
  if (redone !== null) writeItemFieldCanonical(rightItem, 'redone', createIdCanonical(readIdFieldCanonical(redone, 'client'), readIdFieldCanonical(redone, 'clock') + diff))
  if (transaction !== null) {
    writeItemFieldCanonical(item, 'right', rightItem)
    const right = readItemFieldCanonical(rightItem, 'right')
    if (right !== null) writeItemFieldCanonical(right, 'left', rightItem)
    appendDense(transaction._mergeStructs, rightItem)
    const parentSub = readItemFieldCanonical(rightItem, 'parentSub')
    if (parentSub !== null && right === null) {
      reflectApply(mapSet, readTypeFieldCanonical(readItemFieldCanonical(rightItem, 'parent'), '_map'), [parentSub, rightItem])
    }
  } else {
    writeItemFieldCanonical(rightItem, 'left', null)
    writeItemFieldCanonical(rightItem, 'right', null)
  }
  writeItemFieldCanonical(item, 'length', diff)
  return rightItem
}

/** @param {YType} type @param {UpdateEncoderV1|UpdateEncoderV2} encoder */
const writeTypeCanonical = (type, encoder) => {
  const ref = readTypeFieldCanonical(type, '_legacyTypeRef')
  encoder.writeTypeRef(ref)
  if (ref === 3 || ref === 5) encoder.writeKey(readTypeFieldCanonical(type, 'name'))
}

/** @param {AbstractContent} content @param {UpdateEncoderV1|UpdateEncoderV2} encoder @param {number} offset @param {number} offsetEnd */
const writeContentCanonical = (content, encoder, offset, offsetEnd) => {
  const prototype = objectGetPrototypeOf(content)
  if (prototype === ContentAny.prototype) {
    const values = readContentFieldCanonical(content, 'arr')
    const end = values.length - offsetEnd
    encoder.writeLen(end - offset)
    for (let index = offset; index < end; index++) encoder.writeAny(values[index])
  } else if (prototype === ContentBinary.prototype) encoder.writeBuf(readContentFieldCanonical(content, 'content'))
  else if (prototype === ContentDeleted.prototype) encoder.writeLen(readContentFieldCanonical(content, 'len') - offset - offsetEnd)
  else if (prototype === ContentDoc.prototype) {
    encoder.writeString(readContentFieldCanonical(content, 'guid'))
    encoder.writeAny(readContentFieldCanonical(content, 'opts'))
  } else if (prototype === ContentEmbed.prototype) encoder.writeJSON(readContentFieldCanonical(content, 'embed'))
  else if (prototype === ContentFormat.prototype) {
    encoder.writeKey(readContentFieldCanonical(content, 'key'))
    encoder.writeJSON(readContentFieldCanonical(content, 'value'))
  } else if (prototype === ContentJSON.prototype) {
    const values = readContentFieldCanonical(content, 'arr')
    const end = values.length - offsetEnd
    encoder.writeLen(end - offset)
    for (let index = offset; index < end; index++) encoder.writeString(values[index] === undefined ? 'undefined' : jsonStringify(values[index]))
  } else if (prototype === ContentString.prototype) {
    const value = readContentFieldCanonical(content, 'str')
    encoder.writeString(offset === 0 && offsetEnd === 0 ? value : reflectApply(stringSlice, value, [offset, value.length - offsetEnd]))
  } else if (prototype === ContentType.prototype) writeTypeCanonical(readContentFieldCanonical(content, 'type'), encoder)
  else throw new Error('Unsupported reserved mutation content')
}

/** @param {Item} item @param {UpdateEncoderV1|UpdateEncoderV2} encoder @param {number} offset @param {number} offsetEnd */
const writeItemCanonical = (item, encoder, offset, offsetEnd) => {
  const id = readItemFieldCanonical(item, 'id')
  const origin = offset > 0
    ? createIdCanonical(readIdFieldCanonical(id, 'client'), readIdFieldCanonical(id, 'clock') + offset - 1)
    : readItemFieldCanonical(item, 'origin')
  const rightOrigin = readItemFieldCanonical(item, 'rightOrigin')
  const parentSub = readItemFieldCanonical(item, 'parentSub')
  const content = readItemFieldCanonical(item, 'content')
  const info = (readContentKernel(content).ref & binary.BITS5) |
    (origin === null ? 0 : binary.BIT8) |
    (rightOrigin === null ? 0 : binary.BIT7) |
    (parentSub === null ? 0 : binary.BIT6)
  encoder.writeInfo(info)
  if (origin !== null) encoder.writeLeftID(origin)
  if (rightOrigin !== null) encoder.writeRightID(rightOrigin)
  if (origin === null && rightOrigin === null) {
    const parent = readItemFieldCanonical(item, 'parent')
    if (parent !== null && typeof parent === 'object' && objectGetOwnPropertyDescriptor(parent, '_item') !== undefined) {
      const parentItem = readTypeFieldCanonical(parent, '_item')
      if (parentItem === null) {
        encoder.writeParentInfo(true)
        encoder.writeString(findRootTypeKey(parent))
      } else {
        encoder.writeParentInfo(false)
        encoder.writeLeftID(readItemFieldCanonical(parentItem, 'id'))
      }
    } else if (typeof parent === 'string') {
      encoder.writeParentInfo(true)
      encoder.writeString(parent)
    } else if (parent !== null && objectGetPrototypeOf(parent) === ID.prototype) {
      encoder.writeParentInfo(false)
      encoder.writeLeftID(parent)
    } else throw new Error('Invalid reserved mutation parent')
    if (parentSub !== null) encoder.writeString(parentSub)
  }
  writeContentCanonical(content, encoder, offset, offsetEnd)
}

/** @param {UpdateEncoderV1|UpdateEncoderV2} encoder @param {Transaction} transaction @param {IdSet} inserts @param {IdSet} deletes @param {any} idSets */
const writeReservedUpdateCanonical = (encoder, transaction, inserts, deletes, idSets) => {
  if (idSets.isEmpty(inserts) && idSets.isEmpty(deletes)) return false
  const buckets = idSets.snapshotBuckets(inserts)
  encoding.writeVarUint(encoder.restEncoder, buckets.length)
  for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
    const bucket = buckets[bucketIndex]
    const structs = reflectApply(mapGet, readOwnDataCanonical(transaction.doc.store, 'clients'), [bucket.client])
    if (structs === undefined || structs.length === 0) throw new Error('Reserved mutation update references missing structs')
    /** @type {Array<{start:number,end:number,startClock:number,endClock:number}>} */
    const indexRanges = []
    const firstId = readOwnDataCanonical(structs[0], 'id')
    const last = structs[structs.length - 1]
    const firstClock = readIdFieldCanonical(firstId, 'clock')
    const lastClock = readIdFieldCanonical(readOwnDataCanonical(last, 'id'), 'clock') + readOwnDataCanonical(last, 'length')
    let structCount = 0
    for (let rangeIndex = 0; rangeIndex < bucket.ranges.length; rangeIndex++) {
      const range = bucket.ranges[rangeIndex]
      const bounds = { clock: readOwnDataCanonical(range, 'clock'), len: readOwnDataCanonical(range, 'len') }
      const startClock = mathMax(bounds.clock, firstClock)
      const endClock = mathMin(bounds.clock + bounds.len, lastClock)
      if (startClock >= endClock) continue
      const start = findIndexSS(structs, startClock)
      const end = findIndexSS(structs, endClock - 1) + 1
      structCount += end - start
      appendDense(indexRanges, { start, end, startClock, endClock })
    }
    if (indexRanges.length === 0) throw new Error('Reserved mutation update contains no stored structs')
    structCount += indexRanges.length - 1
    let clock = indexRanges[0].startClock
    encoding.writeVarUint(encoder.restEncoder, structCount)
    encoder.writeClient(bucket.client)
    encoding.writeVarUint(encoder.restEncoder, clock)
    for (let rangeIndex = 0; rangeIndex < indexRanges.length; rangeIndex++) {
      const range = indexRanges[rangeIndex]
      const skip = range.startClock - clock
      if (skip > 0) {
        encoder.writeInfo(10)
        encoding.writeVarUint(encoder.restEncoder, skip)
        clock += skip
      }
      for (let index = range.start; index < range.end; index++) {
        const struct = structs[index]
        const structClock = readIdFieldCanonical(readOwnDataCanonical(struct, 'id'), 'clock')
        const structLength = readOwnDataCanonical(struct, 'length')
        const structEnd = structClock + structLength
        const trailing = mathMax(structEnd - range.endClock, 0)
        if (objectGetPrototypeOf(struct) === Item.prototype) writeItemCanonical(struct, encoder, clock - structClock, trailing)
        else if (objectGetPrototypeOf(struct) === GC.prototype) {
          encoder.writeInfo(0)
          encoder.writeLen(structLength - (clock - structClock) - trailing)
        } else throw new Error('Unsupported reserved mutation struct')
        clock = structEnd - trailing
      }
    }
  }
  idSets.write(encoder, deletes)
  return true
}

/** @param {object} value @param {object} prototype */
const captureCanonicalOwnData = (value, prototype) => {
  if (objectGetPrototypeOf(value) !== prototype) throw new Error('Invalid reserved mutation structural prototype')
  const keys = objectKeys(value)
  const descriptors = objectCreate(null)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    const descriptor = objectGetOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !hasOwn(descriptor, 'value')) throw new Error('Invalid reserved mutation structural descriptor')
    objectDefineProperty(descriptors, key, {
      configurable: false,
      enumerable: true,
      value: objectFreeze({
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        value: descriptor.value,
        writable: descriptor.writable
      }),
      writable: false
    })
  }
  return objectFreeze({ keys: objectFreeze(keys), descriptors: objectFreeze(descriptors), prototype, value })
}

/** @param {any} snapshot */
const canonicalOwnDataIsFresh = snapshot => {
  if (objectGetPrototypeOf(snapshot.value) !== snapshot.prototype) return false
  const keys = objectKeys(snapshot.value)
  if (keys.length !== snapshot.keys.length) return false
  for (let index = 0; index < snapshot.keys.length; index++) {
    const key = snapshot.keys[index]
    if (keys[index] !== key) return false
    const expected = snapshot.descriptors[key]
    const descriptor = objectGetOwnPropertyDescriptor(snapshot.value, key)
    if (descriptor === undefined || !hasOwn(descriptor, 'value') ||
      descriptor.configurable !== expected.configurable ||
      descriptor.enumerable !== expected.enumerable ||
      descriptor.writable !== expected.writable ||
      !objectIs(descriptor.value, expected.value)) return false
  }
  return true
}

/** @param {Item} item */
const captureItemCanonical = item => {
  const itemSnapshot = captureCanonicalOwnData(item, Item.prototype)
  const content = readItemFieldCanonical(item, 'content')
  const contentPrototype = objectGetPrototypeOf(content)
  readContentKernel(content)
  /** @type {any[]} */
  const ids = []
  const idKeys = ['id', 'origin', 'rightOrigin', 'redone']
  for (let index = 0; index < idKeys.length; index++) {
    const key = idKeys[index]
    const id = readItemFieldCanonical(item, key)
    if (id !== null) appendDense(ids, captureCanonicalOwnData(id, ID.prototype))
  }
  return objectFreeze({
    item: itemSnapshot,
    content: captureCanonicalOwnData(content, contentPrototype),
    ids: objectFreeze(ids)
  })
}

/** @param {any} snapshot */
const itemSnapshotIsFreshCanonical = snapshot => {
  if (!canonicalOwnDataIsFresh(snapshot.item) || !canonicalOwnDataIsFresh(snapshot.content)) return false
  for (let index = 0; index < snapshot.ids.length; index++) {
    if (!canonicalOwnDataIsFresh(snapshot.ids[index])) return false
  }
  return true
}

/** @param {ID} id @param {number} length */
const createGCCanonical = (id, length) => {
  const struct = /** @type {GC} */ (objectCreate(GC.prototype))
  objectDefineProperty(struct, 'id', { configurable: true, enumerable: true, value: id, writable: true })
  objectDefineProperty(struct, 'length', { configurable: true, enumerable: true, value: length, writable: true })
  return struct
}

/** @param {Transaction} transaction @param {Item} item @param {GC} replacement */
const replaceItemWithGCCanonical = (transaction, item, replacement) => {
  const id = readItemFieldCanonical(item, 'id')
  const structs = reflectApply(mapGet, readOwnDataCanonical(transaction.doc.store, 'clients'), [readIdFieldCanonical(id, 'client')])
  if (structs === undefined) throw new Error('Reserved mutation GC target is unavailable')
  const index = findIndexSS(structs, readIdFieldCanonical(id, 'clock'))
  if (structs[index] !== item) throw new Error('Reserved mutation GC target changed')
  objectDefineProperty(structs, index, {
    configurable: true,
    enumerable: true,
    value: replacement,
    writable: true
  })
  appendDense(transaction._mergeStructs, replacement)
}

/** @param {Item} item @param {Transaction} transaction @param {boolean} parentGCd */
const gcItemCanonical = (item, transaction, parentGCd) => {
  if (!itemIsDeletedCanonical(item)) throw error.unexpectedCase()
  const content = readItemFieldCanonical(item, 'content')
  if (objectGetPrototypeOf(content) === ContentType.prototype) {
    const type = readContentFieldCanonical(content, 'type')
    let child = readTypeFieldCanonical(type, '_start')
    while (child !== null) {
      const right = readItemFieldCanonical(child, 'right')
      gcItemCanonical(child, transaction, true)
      child = right
    }
    writeTypeFieldCanonical(type, '_start', null)
    /** @param {Item|null} mapItem */
    const gcMapItems = mapItem => {
      while (mapItem !== null) {
        const left = readItemFieldCanonical(mapItem, 'left')
        gcItemCanonical(mapItem, transaction, true)
        mapItem = left
      }
    }
    reflectApply(mapForEach, readTypeFieldCanonical(type, '_map'), [gcMapItems])
    writeTypeFieldCanonical(type, '_map', new NativeMap())
  } else {
    readContentKernel(content)
  }
  const length = readItemFieldCanonical(item, 'length')
  if (parentGCd) {
    replaceItemWithGCCanonical(transaction, item, createGCCanonical(readItemFieldCanonical(item, 'id'), length))
  } else {
    writeItemFieldCanonical(item, 'content', createContentDeletedCanonical(length))
  }
}

/**
 * @param {Transaction} transaction
 * @param {IdSet} deletes
 * @param {(item:Item)=>boolean} gcFilter
 * @param {any} idSets
 */
const gcDeleteSetCanonical = (transaction, deletes, gcFilter, idSets) => {
  const buckets = idSets.snapshotBuckets(deletes)
  const clients = readOwnDataCanonical(transaction.doc.store, 'clients')
  for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
    const bucket = buckets[bucketIndex]
    const structs = reflectApply(mapGet, clients, [bucket.client])
    if (structs === undefined || structs.length === 0) throw new Error('Reserved mutation GC range is unavailable')
    for (let rangeIndex = bucket.ranges.length - 1; rangeIndex >= 0; rangeIndex--) {
      const range = bucket.ranges[rangeIndex]
      const startClock = readOwnDataCanonical(range, 'clock')
      const endClock = startClock + readOwnDataCanonical(range, 'len')
      for (let index = findIndexSS(structs, startClock); index < structs.length; index++) {
        const struct = structs[index]
        const id = readOwnDataCanonical(struct, 'id')
        const clock = readIdFieldCanonical(id, 'clock')
        if (clock >= endClock) break
        if (
          objectGetPrototypeOf(struct) === Item.prototype &&
          itemIsDeletedCanonical(struct) &&
          (readItemFieldCanonical(struct, 'info') & binary.BIT1) === 0 &&
          reflectApply(gcFilter, undefined, [struct])
        ) gcItemCanonical(struct, transaction, false)
      }
    }
  }
}

/** @param {AbstractContent} left @param {AbstractContent} right */
const mergeContentCanonical = (left, right) => {
  const prototype = objectGetPrototypeOf(left)
  if (prototype !== objectGetPrototypeOf(right)) return false
  if (prototype === ContentAny.prototype || prototype === ContentJSON.prototype) {
    const values = reflectApply(arrayConcat, readContentFieldCanonical(left, 'arr'), [readContentFieldCanonical(right, 'arr')])
    writeOwnDataCanonical(left, 'arr', values)
    return true
  }
  if (prototype === ContentDeleted.prototype) {
    writeOwnDataCanonical(left, 'len', readContentFieldCanonical(left, 'len') + readContentFieldCanonical(right, 'len'))
    return true
  }
  if (prototype === ContentString.prototype) {
    writeOwnDataCanonical(left, 'str', readContentFieldCanonical(left, 'str') + readContentFieldCanonical(right, 'str'))
    return true
  }
  readContentKernel(left)
  return false
}

/** @param {Item} left @param {Item} right */
const mergeItemsCanonical = (left, right) => {
  if (objectGetPrototypeOf(left) !== Item.prototype || objectGetPrototypeOf(right) !== Item.prototype) return false
  const leftId = readItemFieldCanonical(left, 'id')
  const rightId = readItemFieldCanonical(right, 'id')
  const leftLength = readItemFieldCanonical(left, 'length')
  const leftContent = readItemFieldCanonical(left, 'content')
  const rightContent = readItemFieldCanonical(right, 'content')
  if (
    !idsEqualCanonical(readItemFieldCanonical(right, 'origin'), itemLastIdCanonical(left)) ||
    readItemFieldCanonical(left, 'right') !== right ||
    !idsEqualCanonical(readItemFieldCanonical(left, 'rightOrigin'), readItemFieldCanonical(right, 'rightOrigin')) ||
    readIdFieldCanonical(leftId, 'client') !== readIdFieldCanonical(rightId, 'client') ||
    readIdFieldCanonical(leftId, 'clock') + leftLength !== readIdFieldCanonical(rightId, 'clock') ||
    itemIsDeletedCanonical(left) !== itemIsDeletedCanonical(right) ||
    readItemFieldCanonical(left, 'redone') !== null ||
    readItemFieldCanonical(right, 'redone') !== null ||
    objectGetPrototypeOf(leftContent) !== objectGetPrototypeOf(rightContent) ||
    !mergeContentCanonical(leftContent, rightContent)
  ) return false

  const parent = readItemFieldCanonical(left, 'parent')
  if (parent !== null && typeof parent === 'object' && objectGetOwnPropertyDescriptor(parent, '_searchMarker') !== undefined) {
    const searchMarkers = readTypeFieldCanonical(parent, '_searchMarker')
    if (searchMarkers !== null) {
      for (let index = 0; index < searchMarkers.length; index++) {
        const marker = searchMarkers[index]
        if (readOwnDataCanonical(marker, 'p') === right) {
          writeOwnDataCanonical(marker, 'p', left)
          if (!itemIsDeletedCanonical(left) && itemIsCountableCanonical(left)) {
            writeOwnDataCanonical(marker, 'index', readOwnDataCanonical(marker, 'index') - leftLength)
          }
        }
      }
    }
  }
  if ((readItemFieldCanonical(right, 'info') & binary.BIT1) !== 0) {
    writeItemFieldCanonical(left, 'info', readItemFieldCanonical(left, 'info') | binary.BIT1)
  }
  const next = readItemFieldCanonical(right, 'right')
  writeItemFieldCanonical(left, 'right', next)
  if (next !== null) writeItemFieldCanonical(next, 'left', left)
  writeItemFieldCanonical(left, 'length', leftLength + readItemFieldCanonical(right, 'length'))
  return true
}

/** @param {GC|Skip} left @param {GC|Skip} right */
const mergeSimpleStructsCanonical = (left, right) => {
  if (objectGetPrototypeOf(left) !== objectGetPrototypeOf(right)) return false
  writeOwnDataCanonical(left, 'length', readOwnDataCanonical(left, 'length') + readOwnDataCanonical(right, 'length'))
  return true
}

/** @param {Array<GC|Item|Skip>} structs @param {number} position */
const tryToMergeWithLeftsCanonical = (structs, position) => {
  let right = structs[position]
  let left = structs[position - 1]
  let index = position
  for (; index > 0; right = left, left = structs[--index - 1]) {
    const leftPrototype = objectGetPrototypeOf(left)
    const rightPrototype = objectGetPrototypeOf(right)
    const sameDeleted = leftPrototype === Item.prototype
      ? rightPrototype === Item.prototype && itemIsDeletedCanonical(/** @type {Item} */ (left)) === itemIsDeletedCanonical(/** @type {Item} */ (right))
      : leftPrototype === rightPrototype
    if (!sameDeleted) break
    const merged = leftPrototype === Item.prototype
      ? mergeItemsCanonical(/** @type {Item} */ (left), /** @type {Item} */ (right))
      : (leftPrototype === GC.prototype || leftPrototype === Skip.prototype)
          ? mergeSimpleStructsCanonical(/** @type {GC|Skip} */ (left), /** @type {GC|Skip} */ (right))
          : false
    if (!merged) break
    if (rightPrototype === Item.prototype) {
      const rightItem = /** @type {Item} */ (right)
      const parentSub = readItemFieldCanonical(rightItem, 'parentSub')
      if (parentSub !== null) {
        const parent = readItemFieldCanonical(rightItem, 'parent')
        const parentMap = readTypeFieldCanonical(parent, '_map')
        if (reflectApply(mapGet, parentMap, [parentSub]) === rightItem) reflectApply(mapSet, parentMap, [parentSub, left])
      }
    }
  }
  const merged = position - index
  if (merged > 0) reflectApply(arraySplice, structs, [position + 1 - merged, merged])
  return merged
}

/** @param {Transaction} transaction @param {IdSet} inserts @param {IdSet} deletes @param {any} idSets */
const mergeCleanupCanonical = (transaction, inserts, deletes, idSets) => {
  const clients = readOwnDataCanonical(transaction.doc.store, 'clients')
  const deleteBuckets = idSets.snapshotBuckets(deletes)
  for (let bucketIndex = 0; bucketIndex < deleteBuckets.length; bucketIndex++) {
    const bucket = deleteBuckets[bucketIndex]
    const structs = reflectApply(mapGet, clients, [bucket.client])
    if (structs === undefined || structs.length === 0) throw new Error('Reserved mutation merge range is unavailable')
    for (let rangeIndex = bucket.ranges.length - 1; rangeIndex >= 0; rangeIndex--) {
      const range = bucket.ranges[rangeIndex]
      const clock = readOwnDataCanonical(range, 'clock')
      const length = readOwnDataCanonical(range, 'len')
      let position = mathMin(structs.length - 1, 1 + findIndexSS(structs, clock + length - 1))
      while (position > 0 && readIdFieldCanonical(readOwnDataCanonical(structs[position], 'id'), 'clock') >= clock) {
        position -= 1 + tryToMergeWithLeftsCanonical(structs, position)
      }
    }
  }

  const insertBuckets = idSets.snapshotBuckets(inserts)
  for (let bucketIndex = 0; bucketIndex < insertBuckets.length; bucketIndex++) {
    const bucket = insertBuckets[bucketIndex]
    if (bucket.ranges.length === 0) continue
    const structs = reflectApply(mapGet, clients, [bucket.client])
    if (structs === undefined || structs.length === 0) throw new Error('Reserved mutation insert merge range is unavailable')
    const firstClock = readOwnDataCanonical(bucket.ranges[0], 'clock')
    const firstChangePosition = mathMax(findIndexSS(structs, firstClock), 1)
    for (let position = structs.length - 1; position >= firstChangePosition;) {
      position -= 1 + tryToMergeWithLeftsCanonical(structs, position)
    }
  }

  const mergeStructs = transaction._mergeStructs
  for (let index = mergeStructs.length - 1; index >= 0; index--) {
    const id = readOwnDataCanonical(mergeStructs[index], 'id')
    const structs = reflectApply(mapGet, clients, [readIdFieldCanonical(id, 'client')])
    if (structs === undefined || structs.length === 0) throw new Error('Reserved mutation replacement merge target is unavailable')
    const replacedPosition = findIndexSS(structs, readIdFieldCanonical(id, 'clock'))
    if (replacedPosition + 1 < structs.length && tryToMergeWithLeftsCanonical(structs, replacedPosition + 1) > 1) continue
    if (replacedPosition > 0) tryToMergeWithLeftsCanonical(structs, replacedPosition)
  }
}

/**
 * Module-captured Item/content kernels for the reserved mutation runtime.
 *
 * @internal
 */
export const reservedMutationItemRuntime = objectFreeze({
  create: createItemCanonical,
  createId: createIdCanonical,
  createAny: createContentAnyCanonical,
  createBinary: createContentBinaryCanonical,
  createFormat: createContentFormatCanonical,
  createString: createContentStringCanonical,
  createContentType: createContentTypeCanonical,
  delete: deleteItemCanonical,
  gcDeleteSet: gcDeleteSetCanonical,
  getContentLength: getContentLengthCanonical,
  integrate: /** @param {Item} item @param {Transaction} transaction @param {number} offset */ (item, transaction, offset) => integrateItemCanonical(item, transaction, offset, /** @type {any} */ (readReservedMutationTransactionRuntime(transaction))),
  isContentCountable: isContentCountableCanonical,
  isDeleted: itemIsDeletedCanonical,
  isCountable: itemIsCountableCanonical,
  lastId: itemLastIdCanonical,
  mergeCleanup: mergeCleanupCanonical,
  read: readItemFieldCanonical,
  readContent: readContentFieldCanonical,
  readId: readIdFieldCanonical,
  readType: readTypeFieldCanonical,
  writeType: writeTypeFieldCanonical,
  cleanStart: getItemCleanStartCanonical,
  capture: captureItemCanonical,
  isFresh: itemSnapshotIsFreshCanonical,
  split: splitItemCanonical,
  writeUpdate: writeReservedUpdateCanonical
})
