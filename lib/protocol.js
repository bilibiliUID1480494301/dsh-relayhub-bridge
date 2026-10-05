/**
 * TOIP client core for the relay-hub bridge.
 *
 * Everything here is dependency-free and side-effect-light on purpose: it is the
 * part that must be provably correct (a wrong TOTP means no one can ever join),
 * and the part that is unit-testable without booting DeepSeek Harness.
 *
 * Wire contract: https://github.com/bilibiliUID1480494301/relay-hub/blob/main/docs/TOIP.md
 *
 * @module dsh-relayhub-bridge/protocol
 */

import { createHmac } from 'node:crypto'

/** Protocol identifier echoed by every TOIP response. */
export const PROTOCOL = 'toip'

/** Protocol version this client implements. */
export const PROTOCOL_VERSION = 1

/** TOTP parameters fixed by the protocol (RFC 6238, SHA-1, 6 digits, 30 s). */
export const TOTP = Object.freeze({
  algorithm: 'sha1',
  digits: 6,
  period: 30,
  // The station accepts +/- one window, so clocks up to 30 s apart still work.
  window: 1,
})

/** Header names the station understands; also returned by the join response. */
export const HEADERS = Object.freeze({
  pluginId: 'X-DSH-Plugin-Id',
  pluginVersion: 'X-DSH-Plugin-Version',
  stationId: 'X-Relayhub-Station-Id',
})

/** Our plugin id: the station uses it as the log-accounting directory name. */
export const PLUGIN_ID = 'dsh-relayhub-bridge'

/** UDP discovery probe magics. v2 additionally asks for the TOIP block. */
export const PROBE_V1 = 'RELAYHUB-DISCOVER-v1'
export const PROBE_V2 = 'RELAYHUB-DISCOVER-v2'
export const DISCOVERY_PORT = 8795

/** A TOIP error that carries the HTTP status, so callers can react per status. */
export class ToipError extends Error {
  /**
   * @param {string} message - human-readable reason.
   * @param {{status?: number, type?: string}} [meta] - transport facts.
   */
  constructor(message, meta = {}) {
    super(message)
    this.name = 'ToipError'
    this.status = meta.status ?? 0
    this.type = meta.type ?? ''
  }
}

// ---------------------------------------------------------------- base32

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Decode an RFC 4648 base32 secret, tolerating lowercase, spaces and hyphens
 * (an operator copying the secret by hand will introduce all three).
 *
 * @param {string} text - the secret as printed by `hubrelay toip station`.
 * @returns {Buffer} the raw shared secret.
 * @throws {ToipError} when the text is not valid base32.
 */
export function base32Decode(text) {
  const cleaned = String(text ?? '')
    .toUpperCase()
    .replace(/[\s\-_]/g, '')
    .replace(/=+$/, '')
  if (cleaned.length === 0) throw new ToipError('the TOTP secret is empty')
  let bits = 0
  let value = 0
  const out = []
  for (const char of cleaned) {
    const index = B32_ALPHABET.indexOf(char)
    if (index < 0) {
      throw new ToipError(`the TOTP secret contains a character that is not base32: ${JSON.stringify(char)}`)
    }
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  if (out.length === 0) throw new ToipError('the TOTP secret is too short to be usable')
  return Buffer.from(out)
}

/**
 * Encode a raw secret as base32 without padding.
 *
 * @param {Buffer|Uint8Array} raw - the shared secret bytes.
 * @returns {string} unpadded base32.
 */
export function base32Encode(raw) {
  const bytes = Buffer.from(raw)
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

// ---------------------------------------------------------------- TOTP

/**
 * Compute the HOTP truncation for one counter value.
 *
 * @param {Buffer} secret - raw shared secret.
 * @param {number} counter - the 8-byte big-endian counter.
 * @param {number} [digits] - code length.
 * @returns {string} the zero-padded code.
 */
export function hotp(secret, counter, digits = TOTP.digits) {
  const counterBytes = Buffer.alloc(8)
  counterBytes.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac(TOTP.algorithm, secret).update(counterBytes).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const truncated =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(truncated % 10 ** digits).padStart(digits, '0')
}

/**
 * Compute the TOTP code for an instant.
 *
 * @param {string|Buffer} secret - base32 text or raw secret bytes.
 * @param {number} [atMs] - instant in milliseconds (default: now).
 * @returns {string} the 6-digit code.
 */
export function totp(secret, atMs = Date.now()) {
  const raw = typeof secret === 'string' ? base32Decode(secret) : Buffer.from(secret)
  const counter = Math.floor(atMs / 1000 / TOTP.period)
  return hotp(raw, counter, TOTP.digits)
}

/**
 * Seconds until the current code rolls over.
 *
 * Surfaced in the UI so a user is not caught entering a code one second before
 * it expires -- the single most common cause of a failed join.
 *
 * @param {number} [atMs] - instant in milliseconds.
 * @returns {number} seconds left in the current window.
 */
export function secondsLeft(atMs = Date.now()) {
  return TOTP.period - (Math.floor(atMs / 1000) % TOTP.period)
}

/**
 * Verify a code the way the station does (current window +/- TOTP.window).
 * Exposed for tests and self-checks; the station is the authority.
 *
 * @param {string|Buffer} secret - base32 text or raw secret bytes.
 * @param {string} code - candidate code.
 * @param {number} [atMs] - instant in milliseconds.
 * @returns {boolean} whether the station would accept it.
 */
export function verifyTotp(secret, code, atMs = Date.now()) {
  const supplied = String(code ?? '').replace(/\D/g, '')
  if (supplied.length !== TOTP.digits) return false
  const raw = typeof secret === 'string' ? base32Decode(secret) : Buffer.from(secret)
  const base = Math.floor(atMs / 1000 / TOTP.period)
  for (let shift = -TOTP.window; shift <= TOTP.window; shift += 1) {
    if (hotp(raw, base + shift, TOTP.digits) === supplied) return true
  }
  return false
}

// ---------------------------------------------------------------- URLs

/**
 * Normalise a user-typed station address into an HTTP root.
 *
 * Accepts `host`, `host:port`, `http://host:port/`, and even a full
 * `/v1/messages` URL, because people paste all four.
 *
 * @param {string} input - anything the user typed.
 * @param {{defaultScheme?: string}} [options] - scheme for bare host input.
 * @returns {string} an HTTP(S) root with no trailing slash.
 * @throws {ToipError} when the value cannot be understood.
 */
export function normalizeRoot(input, options = {}) {
  const text = String(input ?? '').trim()
  if (text === '') throw new ToipError('the station address is empty')
  const scheme = options.defaultScheme ?? 'http'
  // Only prepend a scheme when the input does not already carry one. Without
  // this check `ftp://host` becomes `http://ftp://host` -- a *valid* URL whose
  // host is literally "ftp", so the typo would sail through and fail later with
  // a baffling connection error instead of a clear rejection.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text)
  const withScheme = hasScheme ? text : `${scheme}://${text}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new ToipError(`cannot read the station address: ${JSON.stringify(input)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToipError(`the station address must be http or https, got ${url.protocol.replace(':', '')}`)
  }
  if (url.username || url.password) {
    throw new ToipError('the station address must not embed credentials')
  }
  // Strip a pasted endpoint path down to the root; /v1/messages and /v1 are the
  // two things people actually paste.
  url.pathname = url.pathname.replace(/\/(v1(\/(messages|chat\/completions|models|embeddings|responses))?)?\/?$/i, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

/**
 * Build the exact value a DeepSeek Harness provider expects as `baseURL`.
 *
 * The Messages adapter appends `/v1` only when the path does not already end
 * with it, so the unambiguous spelling always carries `/v1`.
 *
 * @param {string} root - HTTP root from {@link normalizeRoot}.
 * @returns {string} the provider base URL.
 */
export function providerBaseURL(root) {
  const clean = String(root).replace(/\/+$/, '')
  return clean.endsWith('/v1') ? clean : `${clean}/v1`
}

/**
 * Join a relative TOIP path onto a station root.
 *
 * @param {string} root - HTTP root.
 * @param {string} path - a path that may or may not start with '/'.
 * @returns {string} the absolute URL.
 */
export function resolvePath(root, path) {
  return `${String(root).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`
}

// ---------------------------------------------------------------- HTTP

/**
 * Parse a station error body into a message this plugin can show a user.
 *
 * @param {number} status - HTTP status.
 * @param {string} body - raw response text.
 * @returns {ToipError} a populated error.
 */
function toipErrorFrom(status, body) {
  let message = body?.trim() || `the station returned HTTP ${status}`
  let type = ''
  try {
    const parsed = JSON.parse(body)
    const error = parsed?.error
    if (error && typeof error === 'object') {
      if (typeof error.message === 'string' && error.message) message = error.message
      if (typeof error.type === 'string') type = error.type
    } else if (typeof parsed?.detail === 'string') {
      message = parsed.detail
    }
  } catch {
    // Non-JSON body (a proxy's HTML error page, say): keep the raw text.
  }
  return new ToipError(message, { status, type })
}

/**
 * Perform one JSON request against a station.
 *
 * @param {string} url - absolute URL.
 * @param {{method?: string, body?: unknown, headers?: Record<string,string>, timeoutMs?: number}} [options]
 * @returns {Promise<object>} the parsed JSON body.
 * @throws {ToipError} on transport failure or a non-2xx status.
 */
export async function requestJson(url, options = {}) {
  const method = options.method ?? 'GET'
  const headers = { accept: 'application/json', ...(options.headers ?? {}) }
  let body
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  // A join that hangs forever is worse than one that fails: the user is staring
  // at a code that expires in 30 seconds.
  const timeoutMs = options.timeoutMs ?? 15000
  const signal = AbortSignal.timeout(timeoutMs)
  let response
  try {
    response = await fetch(url, { method, headers, body, signal, redirect: 'error' })
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new ToipError(`the station did not answer within ${timeoutMs} ms: ${url}`)
    }
    throw new ToipError(`cannot reach the station at ${url}: ${error?.message ?? error}`)
  }
  const text = await response.text()
  if (!response.ok) throw toipErrorFrom(response.status, text)
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ToipError(`the station returned a body that is not JSON: ${url}`)
  }
}

/**
 * Read the station's public TOIP capability declaration.
 *
 * @param {string} root - HTTP root.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<object>} the station payload (includes `enabled`, `otp`, `endpoints`).
 * @throws {ToipError} with status 404 when the station has TOIP disabled.
 */
export function fetchStation(root, options = {}) {
  return requestJson(resolvePath(root, '/v1/toip/station'), options)
}

/**
 * Exchange a dynamic code or an enrollment ticket for a session.
 *
 * @param {string} root - HTTP root.
 * @param {object} input - the credential and identity to send.
 * @param {string} [input.code] - current TOTP code (rejoin / rotate).
 * @param {string} [input.ticket] - enrollment secret (first contact).
 * @param {string} [input.name] - device name shown in the station's token list.
 * @param {{pluginId?: string, pluginVersion?: string, client?: string, timeoutMs?: number}} [options]
 * @returns {Promise<object>} the join payload (`session`, `dsh`, `models`, ...).
 */
export function join(root, input, options = {}) {
  const pluginId = options.pluginId ?? PLUGIN_ID
  const payload = {
    plugin: pluginId,
    client: options.client ?? 'dsh',
  }
  if (input?.code) payload.code = String(input.code).replace(/\s+/g, '')
  if (input?.ticket) payload.ticket = String(input.ticket).trim()
  if (input?.name) payload.name = String(input.name).trim()
  if (options.pluginVersion) payload.plugin_version = options.pluginVersion
  return requestJson(resolvePath(root, '/v1/toip/join'), {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
  })
}

/**
 * Ask the station who we are and when the session expires.
 *
 * @param {string} root - HTTP root.
 * @param {string} sessionToken - the `rht_…` session token.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<object>} the session description.
 */
export function fetchSession(root, sessionToken, options = {}) {
  return requestJson(resolvePath(root, '/v1/toip/session'), {
    headers: { 'x-api-key': sessionToken },
    timeoutMs: options.timeoutMs,
  })
}

/**
 * Headers that tag inference traffic for per-plugin accounting.
 *
 * The token is already bound to the plugin, so these are not credentials; they
 * only disambiguate several plugins behind one token.
 *
 * @param {{pluginId?: string, pluginVersion?: string, stationId?: string}} [options]
 * @returns {Record<string,string>} header name/value pairs.
 */
export function identityHeaders(options = {}) {
  const headers = { [HEADERS.pluginId]: options.pluginId ?? PLUGIN_ID }
  if (options.pluginVersion) headers[HEADERS.pluginVersion] = String(options.pluginVersion)
  if (options.stationId) headers[HEADERS.stationId] = String(options.stationId)
  return headers
}

/**
 * Classify a join failure so the UI can tell the user what to actually do.
 *
 * @param {unknown} error - anything thrown by {@link join}.
 * @returns {{kind: string, retryable: boolean, message: string, hint: string}} guidance.
 */
export function classifyJoinFailure(error) {
  const status = error instanceof ToipError ? error.status : 0
  const message = error instanceof Error ? error.message : String(error)
  if (status === 404) {
    return {
      kind: 'no-toip',
      retryable: false,
      message,
      hint: 'This station does not offer TOIP. Ask the operator for a pairing code instead (hubrelay pair begin).',
    }
  }
  if (status === 403) {
    // Wrong code, or too many attempts. A lockout needs a wait, not a retry.
    const locked = /尝试次数|too many|lock/i.test(message)
    return {
      kind: locked ? 'locked-out' : 'rejected',
      retryable: !locked,
      message,
      hint: locked
        ? 'Too many failed attempts from this address. Wait about 5 minutes, then try a fresh code.'
        : 'The code was not accepted. Codes live 30 seconds -- get a fresh one. If it keeps failing, check that this machine\'s clock matches the station\'s.',
    }
  }
  if (status === 400) {
    return {
      kind: 'bad-request',
      retryable: true,
      message,
      hint: 'The request was rejected as malformed. Re-copy the value and try again.',
    }
  }
  return {
    kind: status === 0 ? 'unreachable' : 'http-error',
    retryable: true,
    message,
    hint: 'Check the station address and that the station is running and reachable.',
  }
}
