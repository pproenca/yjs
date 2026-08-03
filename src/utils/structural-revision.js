/** @typedef {import('./StructStore.js').StructStore} StructStore */

/** @type {WeakMap<StructStore,number>} */
const revisions = new WeakMap()

/** @param {StructStore} store */
export const initializeStructuralRevision = store => {
  revisions.set(store, 0)
}

/** @param {StructStore} store */
export const getStructuralRevision = store => revisions.get(store) ?? 0

/** @param {StructStore} store */
export const markStructuralChange = store => {
  const revision = revisions.get(store)
  if (revision !== undefined) revisions.set(store, revision + 1)
}
