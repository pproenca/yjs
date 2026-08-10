const objectFreeze = Object.freeze
const reflectApply = Reflect.apply
const weakMapDelete = WeakMap.prototype.delete
const weakMapGet = WeakMap.prototype.get
const weakMapHas = WeakMap.prototype.has
const weakMapSet = WeakMap.prototype.set

/**
 * @typedef {'pre-executor'|'executor'|'callback'|'cleanup'} ReservedMutationPhase
 * @typedef {{
 *   createIdSet: () => IdSet,
 *   addId: (set:IdSet,client:number,clock:number,length:number) => void,
 *   cloneIdSet: (set:IdSet) => IdSet,
 *   differenceIdSet: (set:IdSet,excluded:IdSet) => IdSet,
 *   writeUpdate: (encoder:UpdateEncoderV1|UpdateEncoderV2,transaction:Transaction) => boolean
 * }} ReservedMutationHooks
 * @typedef {{
 *   runtime: object,
 *   hooks: Readonly<ReservedMutationHooks>,
 *   phase: ReservedMutationPhase,
 *   preInserts: IdSet,
 *   preDeletes: IdSet,
 *   executorInserts: IdSet,
 *   executorDeletes: IdSet,
 *   callbackInserts: IdSet,
 *   callbackDeletes: IdSet,
 *   phaseBaselineInserts: IdSet,
 *   phaseBaselineDeletes: IdSet
 * }} ReservedMutationTransactionState
 */

/** @type {WeakMap<object,Readonly<ReservedMutationHooks>>} */
const runtimeHooks = new WeakMap()
/** @type {WeakMap<Transaction,ReservedMutationTransactionState>} */
const transactionStates = new WeakMap()

/** @param {WeakMap<any,any>} target @param {any} key */
const weakGet = (target, key) => reflectApply(weakMapGet, target, [key])
/** @param {WeakMap<any,any>} target @param {any} key @param {any} value */
const weakSet = (target, key, value) => reflectApply(weakMapSet, target, [key, value])
/** @param {WeakMap<any,any>} target @param {any} key */
const weakHas = (target, key) => reflectApply(weakMapHas, target, [key])
/** @param {WeakMap<any,any>} target @param {any} key */
const weakDelete = (target, key) => reflectApply(weakMapDelete, target, [key])

/**
 * Register the sealed hooks owned by one prepared capability.
 *
 * @internal
 * @param {object} runtime
 * @param {ReservedMutationHooks} hooks
 */
export const registerReservedMutationRuntime = (runtime, hooks) => {
  if (weakHas(runtimeHooks, runtime)) throw new Error('Reserved mutation runtime already registered')
  weakSet(runtimeHooks, runtime, objectFreeze({
    createIdSet: hooks.createIdSet,
    addId: hooks.addId,
    cloneIdSet: hooks.cloneIdSet,
    differenceIdSet: hooks.differenceIdSet,
    writeUpdate: hooks.writeUpdate
  }))
}

/**
 * Activate before beforeAllTransactions/beforeTransaction can run.
 *
 * @internal
 * @param {Transaction} transaction
 * @param {object} runtime
 */
export const activateReservedMutationTransaction = (transaction, runtime) => {
  if (weakHas(transactionStates, transaction)) throw new Error('Reserved mutation transaction already active')
  const hooks = weakGet(runtimeHooks, runtime)
  if (hooks === undefined) throw new Error('Reserved mutation runtime is not registered')
  weakSet(transactionStates, transaction, {
    runtime,
    hooks,
    phase: 'pre-executor',
    preInserts: hooks.createIdSet(),
    preDeletes: hooks.createIdSet(),
    executorInserts: hooks.createIdSet(),
    executorDeletes: hooks.createIdSet(),
    callbackInserts: hooks.createIdSet(),
    callbackDeletes: hooks.createIdSet(),
    phaseBaselineInserts: hooks.cloneIdSet(transaction.insertSet),
    phaseBaselineDeletes: hooks.cloneIdSet(transaction.deleteSet)
  })
}

/** @internal @param {Transaction} transaction */
export const deactivateReservedMutationTransaction = transaction => weakDelete(transactionStates, transaction)

/** @internal @param {Transaction} transaction */
export const readReservedMutationTransactionRuntime = transaction => weakGet(transactionStates, transaction)?.runtime

/** @internal @param {Transaction} transaction @param {object} runtime */
export const assertReservedMutationTransactionRuntime = (transaction, runtime) => weakGet(transactionStates, transaction)?.runtime === runtime

/** @internal @param {Transaction} transaction */
export const isReservedMutationTransactionActive = transaction => weakHas(transactionStates, transaction)

/**
 * Account without consulting transaction IdSet methods. The public transaction sets remain the
 * ordinary observer/wire surface; these private sets are the capability's exact phase ledger.
 *
 * @internal
 * @param {Transaction} transaction
 * @param {'insert'|'delete'} kind
 * @param {number} client
 * @param {number} clock
 * @param {number} length
 */
export const recordReservedMutationTransactionWrite = (transaction, kind, client, clock, length) => {
  const state = weakGet(transactionStates, transaction)
  if (state === undefined) return
  let target
  if (state.phase === 'pre-executor') target = kind === 'insert' ? state.preInserts : state.preDeletes
  else if (state.phase === 'executor') target = kind === 'insert' ? state.executorInserts : state.executorDeletes
  else if (state.phase === 'callback') target = kind === 'insert' ? state.callbackInserts : state.callbackDeletes
  else return
  state.hooks.addId(target, client, clock, length)
}

/** @internal @param {Transaction} transaction @param {object} runtime */
export const beginReservedMutationExecutor = (transaction, runtime) => {
  const state = weakGet(transactionStates, transaction)
  if (state === undefined || state.runtime !== runtime || state.phase !== 'pre-executor') {
    throw new Error('Reserved mutation executor phase is unavailable')
  }
  state.preInserts = state.hooks.differenceIdSet(transaction.insertSet, state.phaseBaselineInserts)
  state.preDeletes = state.hooks.differenceIdSet(transaction.deleteSet, state.phaseBaselineDeletes)
  state.phase = 'executor'
}

/** @internal @param {Transaction} transaction @param {object} runtime */
export const beginReservedMutationCallback = (transaction, runtime) => {
  const state = weakGet(transactionStates, transaction)
  if (state === undefined || state.runtime !== runtime || state.phase !== 'executor') {
    throw new Error('Reserved mutation callback phase is unavailable')
  }
  state.phaseBaselineInserts = state.hooks.cloneIdSet(transaction.insertSet)
  state.phaseBaselineDeletes = state.hooks.cloneIdSet(transaction.deleteSet)
  state.phase = 'callback'
}

/** @internal @param {Transaction} transaction */
export const beginReservedMutationCleanup = transaction => {
  const state = weakGet(transactionStates, transaction)
  if (state === undefined) return
  if (state.phase === 'pre-executor') {
    state.preInserts = state.hooks.differenceIdSet(transaction.insertSet, state.phaseBaselineInserts)
    state.preDeletes = state.hooks.differenceIdSet(transaction.deleteSet, state.phaseBaselineDeletes)
  } else if (state.phase === 'callback') {
    state.callbackInserts = state.hooks.differenceIdSet(transaction.insertSet, state.phaseBaselineInserts)
    state.callbackDeletes = state.hooks.differenceIdSet(transaction.deleteSet, state.phaseBaselineDeletes)
  }
  state.phase = 'cleanup'
}

/**
 * @internal
 * @param {Transaction} transaction
 * @param {object} runtime
 */
export const readReservedMutationAccounting = (transaction, runtime) => {
  const state = weakGet(transactionStates, transaction)
  if (state === undefined || state.runtime !== runtime) throw new Error('Reserved mutation accounting is unavailable')
  return objectFreeze({
    preInserts: state.preInserts,
    preDeletes: state.preDeletes,
    executorInserts: state.executorInserts,
    executorDeletes: state.executorDeletes,
    callbackInserts: state.callbackInserts,
    callbackDeletes: state.callbackDeletes
  })
}

/**
 * @internal
 * @param {UpdateEncoderV1|UpdateEncoderV2} encoder
 * @param {Transaction} transaction
 * @return {boolean|null}
 */
export const writeReservedMutationUpdate = (encoder, transaction) => {
  const state = weakGet(transactionStates, transaction)
  return state === undefined ? null : state.hooks.writeUpdate(encoder, transaction)
}
