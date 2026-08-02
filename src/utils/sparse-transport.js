/** @typedef {import('../structs/CausalHole.js').CausalHole} CausalHole */
/** @typedef {import('../structs/TerminalCausalHole.js').TerminalCausalHole} TerminalCausalHole */

/**
 * Transaction-private sparse transport state. Weak keys keep it outside the public Transaction
 * metadata contract and release it with the transaction.
 *
 * @typedef {{liveHoles:Map<number,Array<CausalHole>>,terminalHoles:Map<number,Array<TerminalCausalHole>>}} SparseTransport
 */

/** @type {WeakMap<Transaction,SparseTransport>} */
const sparseTransport = new WeakMap()

/** @param {Transaction} transaction */
const getOrCreate = transaction => {
  let transport = sparseTransport.get(transaction)
  if (transport === undefined) {
    transport = { liveHoles: new Map(), terminalHoles: new Map() }
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

/** @param {Transaction} transaction @param {Array<TerminalCausalHole>} terminals */
export const recordTerminalCausalHoles = (transaction, terminals) => {
  if (terminals.length === 0) return
  const transport = getOrCreate(transaction)
  for (const terminal of terminals) {
    const clientTerminals = transport.terminalHoles.get(terminal.id.client) ?? []
    clientTerminals.push(terminal)
    transport.terminalHoles.set(terminal.id.client, clientTerminals)
  }
}

/** @param {Transaction} transaction @param {(hole:CausalHole)=>void} f */
export const forEachLiveCausalHole = (transaction, f) => {
  sparseTransport.get(transaction)?.liveHoles.forEach(holes => holes.forEach(f))
}

/** @param {Transaction} transaction @param {(terminal:TerminalCausalHole)=>void} f */
export const forEachTerminalCausalHole = (transaction, f) => {
  sparseTransport.get(transaction)?.terminalHoles.forEach(terminals => terminals.forEach(f))
}

/** @param {Transaction} transaction */
export const hasSparseTransport = transaction => {
  const transport = sparseTransport.get(transaction)
  return transport !== undefined && (transport.liveHoles.size > 0 || transport.terminalHoles.size > 0)
}

/** @param {Transaction} transaction @param {number} client */
export const hasSparseTransportClient = (transaction, client) => {
  const transport = sparseTransport.get(transaction)
  return transport !== undefined && (transport.liveHoles.has(client) || transport.terminalHoles.has(client))
}
