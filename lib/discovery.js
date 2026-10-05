/**
 * LAN discovery: find relay-hub stations on the local segment.
 *
 * Uses the same UDP broadcast scheme the station's responder implements
 * (`RELAYHUB-DISCOVER-v2`, default port 8795). The v2 probe asks for the TOIP
 * capability block, so one broadcast yields both "where is the station" and
 * "how do I join it" without a second round trip.
 *
 * Why UDP broadcast rather than mDNS: the station deliberately ships a
 * stdlib-only, dependency-free responder (see relay-hub's `discovery.py`), and
 * broadcast is equivalent within one segment. It does not cross subnets, which
 * is the documented trade-off -- for a remote station the user supplies a URL.
 *
 * @module dsh-relayhub-bridge/discovery
 */

import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

import { DISCOVERY_PORT, PROBE_V1, PROBE_V2 } from './protocol.js'

/** Maximum reply size we are willing to read. */
const RECV_BUFFER = 4096

/**
 * One station found on the network.
 * @typedef {object} FoundStation
 * @property {string} name - the operator's label for the station.
 * @property {string} host - the address the reply came from (never the one it claims).
 * @property {number} port - HTTP port.
 * @property {number} models - how many models the station advertises.
 * @property {boolean} pairingOpen - whether a pairing window is open.
 * @property {object} toip - TOIP capability block (empty for a v1 reply).
 * @property {boolean} toipEnabled - convenience flag from `toip.enabled`.
 * @property {string} url - ready-to-use HTTP root.
 */

/**
 * Compute broadcast destinations: the global broadcast address, each local
 * IPv4 /24 broadcast, and loopback.
 *
 * Loopback looks redundant but is what makes single-machine use reliable:
 * broadcast delivery to a listener on the same host is not dependable on
 * Windows, while 127.0.0.1 always works.
 *
 * @param {number} port - target port.
 * @returns {string[]} unique destination addresses.
 */
export function broadcastTargets(port = DISCOVERY_PORT) {
  const targets = new Set(['255.255.255.255', '127.0.0.1'])
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const octets = entry.address.split('.')
      if (octets.length !== 4) continue
      targets.add(`${octets[0]}.${octets[1]}.${octets[2]}.255`)
    }
  }
  return [...targets].map((host) => `${host}:${port}`)
}

/**
 * Parse one reply datagram.
 *
 * @param {Buffer} data - raw reply.
 * @param {string} host - the source address.
 * @returns {FoundStation|null} the parsed station, or null when it is not ours.
 */
export function parseReply(data, host) {
  let payload
  try {
    payload = JSON.parse(data.toString('utf8'))
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object' || payload.protocol !== 'relay-hub') return null
  const port = Number.parseInt(payload.port, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  const toip = payload.toip && typeof payload.toip === 'object' ? payload.toip : {}
  return {
    name: String(payload.name || 'unnamed'),
    host,
    port,
    models: Number.parseInt(payload.models, 10) || 0,
    pairingOpen: Boolean(payload.pairing),
    toip,
    toipEnabled: Boolean(toip.enabled),
    url: `http://${host}:${port}`,
  }
}

/**
 * Broadcast a discovery probe and collect replies.
 *
 * @param {{timeoutMs?: number, port?: number, wantToip?: boolean}} [options]
 * @returns {Promise<FoundStation[]>} stations, deduplicated by host:port.
 */
export function discover(options = {}) {
  const timeoutMs = options.timeoutMs ?? 3000
  const port = options.port ?? DISCOVERY_PORT
  // v2 asks for the TOIP block; v1 is smaller and keeps older stations happy.
  const probe = Buffer.from(options.wantToip === false ? PROBE_V1 : PROBE_V2, 'utf8')

  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    const found = new Map()
    let settled = false

    /** @param {FoundStation[]} stations */
    const finish = (stations) => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        // already closed
      }
      resolve(stations)
    }

    socket.on('error', () => finish([...found.values()]))
    socket.on('message', (data, remote) => {
      const station = parseReply(data, remote.address)
      if (station) found.set(`${station.host}:${station.port}`, station)
    })

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true)
      } catch {
        // Some stacks refuse this; the loopback target still works.
      }
      for (const target of broadcastTargets(port)) {
        const [host, targetPort] = target.split(':')
        socket.send(probe, Number.parseInt(targetPort, 10), host, () => {
          // Per-destination send failures are expected (no route on that
          // interface); other destinations still deliver.
        })
      }
      setTimeout(() => finish([...found.values()]), timeoutMs)
    })
  })
}
