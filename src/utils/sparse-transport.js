/** @typedef {import('../structs/CausalHole.js').CausalHole} CausalHole */

/**
 * Transaction-private sparse transport state. Weak keys keep it outside the public Transaction
 * metadata contract and release it with the transaction.
 *
 * @typedef {{liveHoles:Map<number,Array<CausalHole>>}} SparseTransport
 */

/** @type {WeakMap<Transaction,SparseTransport>} */
const sparseTransport = new WeakMap()

/** @param {Transaction} transaction */
const getOrCreate = transaction => {
  let transport = sparseTransport.get(transaction)
  if (transport === undefined) {
    transport = { liveHoles: new Map() }
    sparseTransport.set(transaction, transport)
  }
  return transport
}

/** @param {Transaction} transaction @param {Array<CausalHole>} holes */
export const recordLiveCausalHoles = (transaction, holes) => {
  if (holes.length === 0) return
  const transport = getOrCreate(transaction)
  for (const hole of holes) {
    const clientHoles = transport.liveHoles.get(hole.id.client) ?? []
    clientHoles.push(hole)
    transport.liveHoles.set(hole.id.client, clientHoles)
  }
}

/** @param {Transaction} transaction @param {(hole:CausalHole)=>void} f */
export const forEachLiveCausalHole = (transaction, f) => {
  sparseTransport.get(transaction)?.liveHoles.forEach(holes => holes.forEach(f))
}

/** @param {Transaction} transaction */
export const hasSparseTransport = transaction => {
  const transport = sparseTransport.get(transaction)
  return transport !== undefined && transport.liveHoles.size > 0
}

/** @param {Transaction} transaction @param {number} client */
export const hasSparseTransportClient = (transaction, client) => {
  const transport = sparseTransport.get(transaction)
  return transport !== undefined && transport.liveHoles.has(client)
}
