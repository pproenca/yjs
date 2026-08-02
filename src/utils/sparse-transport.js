/** @typedef {import('../structs/CausalHole.js').CausalHole} CausalHole */

/**
 * Transaction-private sparse transport state. Weak keys keep it outside the public Transaction
 * metadata contract and release it with the transaction.
 *
 * @typedef {{clock:number,length:number}} TransportRange
 * @typedef {{ranges:Array<TransportRange>,normalized:boolean}} TransportRanges
 * @typedef {{liveHoles:Map<number,Array<CausalHole>>,terminalGc:Map<number,TransportRanges>}} SparseTransport
 */

/** @type {WeakMap<Transaction,SparseTransport>} */
const sparseTransport = new WeakMap()

/** @param {Transaction} transaction */
const getOrCreate = transaction => {
  let transport = sparseTransport.get(transaction)
  if (transport === undefined) {
    transport = { liveHoles: new Map(), terminalGc: new Map() }
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

/** @param {Transaction} transaction @param {number} client @param {number} clock @param {number} length */
export const recordTerminalGc = (transaction, client, clock, length) => {
  if (length <= 0) return
  const terminalGc = getOrCreate(transaction).terminalGc
  const clientRanges = terminalGc.get(client) ?? { ranges: [], normalized: true }
  clientRanges.ranges.push({ clock, length })
  clientRanges.normalized = false
  terminalGc.set(client, clientRanges)
}

/** @param {TransportRanges} clientRanges */
const normalizeRanges = clientRanges => {
  if (clientRanges.normalized) return clientRanges.ranges
  const ranges = clientRanges.ranges.sort((left, right) => left.clock - right.clock)
  let write = 0
  for (const current of ranges) {
    const previous = ranges[write - 1]
    if (previous !== undefined && current.clock <= previous.clock + previous.length) {
      previous.length = Math.max(previous.clock + previous.length, current.clock + current.length) - previous.clock
    } else {
      ranges[write++] = current
    }
  }
  ranges.length = write
  clientRanges.normalized = true
  return ranges
}

/** @param {Transaction} transaction @param {(hole:CausalHole)=>void} f */
export const forEachLiveCausalHole = (transaction, f) => {
  sparseTransport.get(transaction)?.liveHoles.forEach(holes => holes.forEach(f))
}

/** @param {Transaction} transaction @param {(client:number,clock:number,length:number)=>void} f */
export const forEachTerminalGcRange = (transaction, f) => {
  sparseTransport.get(transaction)?.terminalGc.forEach((clientRanges, client) => {
    normalizeRanges(clientRanges).forEach(range => f(client, range.clock, range.length))
  })
}

/** @param {Transaction} transaction */
export const hasSparseTransport = transaction => {
  const transport = sparseTransport.get(transaction)
  return transport !== undefined && (transport.liveHoles.size > 0 || transport.terminalGc.size > 0)
}

/** @param {Transaction} transaction @param {number} client */
export const hasSparseTransportClient = (transaction, client) => {
  const transport = sparseTransport.get(transaction)
  return transport !== undefined && (transport.liveHoles.has(client) || transport.terminalGc.has(client))
}
