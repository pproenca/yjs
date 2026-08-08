/** @typedef {import('./StructStore.js').StructStore} StructStore */

const applyIntrinsic = Reflect.apply
const weakMapGetIntrinsic = WeakMap.prototype.get
const weakMapSetIntrinsic = WeakMap.prototype.set

/** @type {WeakMap<StructStore,number>} */
const revisions = new WeakMap()

/** @param {StructStore} store */
export const initializeStructuralRevision = store => {
  applyIntrinsic(weakMapSetIntrinsic, revisions, [store, 0])
}

/** @param {StructStore} store */
export const getStructuralRevision = store => applyIntrinsic(weakMapGetIntrinsic, revisions, [store]) ?? 0

/** @param {StructStore} store */
export const markStructuralChange = store => {
  const revision = applyIntrinsic(weakMapGetIntrinsic, revisions, [store])
  if (revision !== undefined) applyIntrinsic(weakMapSetIntrinsic, revisions, [store, revision + 1])
}
