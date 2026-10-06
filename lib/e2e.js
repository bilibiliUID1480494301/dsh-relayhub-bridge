/**
 * E2E envelope client (0.3.0): seals the Messages request body into an
 * `x25519-hkdf-sha256-aesgcm` envelope when the station offers one.
 *
 * Zero new dependencies — node:crypto ships X25519 (RFC 7748), HKDF-SHA256
 * (RFC 5869) and AES-256-GCM, which is the entire protocol. The wire format is
 * byte-compatible with hubrelay's Python implementation
 * (`relayhub/gateway/e2e.py`); the spots where byte equality is load-bearing:
 *
 * * **AAD.** Compact JSON with keys in alphabetical order (`eph, key_id,
 *   nonce, ts, v`) and `ts`/`v` as JSON integers — the Python side builds it
 *   with `json.dumps(..., sort_keys=True, separators=(",", ":"))`, so the JS
 *   object literal must insert its keys in that same order.
 * * **HKDF salt** is the *supplied credential string* (the x-api-key value),
 *   UTF-8 encoded. The envelope is bound to the caller's identity: the same
 *   ciphertext cannot be opened with a different token.
 * * **Ciphertext** is `AESGCM.encrypt()` output — ciphertext || 16-byte GCM
 *   tag — because Node hands them back separately and Python appends them.
 *
 * `openEnvelope` is the server-half mirror. Production traffic only ever
 * seals; the open half exists so tests (and local fixture stations) can verify
 * the client without Python in the loop.
 *
 * @module lib/e2e.js
 */

import crypto from 'node:crypto'
import { CODE } from './stream.js'
import { UpstreamError } from './turn.js'

/** Envelope scheme this module implements; the station advertises the same. */
export const E2E_SCHEME = 'x25519-hkdf-sha256-aesgcm'

/** HKDF info label — shared with the Python side; changing it breaks the wire. */
export const E2E_INFO = 'relayhub-e2e-v1'

/** Content-Type of a sealed request body. */
export const ENVELOPE_CONTENT_TYPE = 'application/x-relayhub-envelope+json'

/** Envelope timestamp tolerance in seconds (matches the station's TS_WINDOW). */
export const E2E_TS_WINDOW = 120

/** Envelope failure. The message is user-facing; the station maps it to 4xx. */
export class E2eError extends Error {
  constructor(message) {
    super(message)
    this.name = 'E2eError'
  }
}

// RFC 8410 DER wrappers around the raw 32-byte X25519 scalars. Node's KeyObject
// API only imports/exports DER, so every raw boundary crossing goes through
// these fixed prefixes.
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

/** Lenient b64 decode with a hard failure on empty input. */
function b64decode(value, field) {
  if (typeof value !== 'string' || value === '') throw new E2eError(`信封字段 ${field} 缺失`)
  const raw = Buffer.from(value, 'base64')
  if (raw.length === 0) throw new E2eError(`信封字段 ${field} 不是合法 base64`)
  return raw
}

/** Raw 32 bytes → X25519 public KeyObject (SPKI DER import). */
export function publicFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new E2eError('X25519 公钥必须是 32 字节')
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

/** Raw 32 bytes → X25519 private KeyObject (PKCS8 DER import). */
export function privateFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new E2eError('X25519 私钥必须是 32 字节')
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' })
}

/** X25519 public KeyObject → raw 32 bytes. */
export function rawFromPublic(keyObject) {
  const der = keyObject.export({ type: 'spki', format: 'der' })
  if (der.length !== 44) throw new E2eError('unexpected SPKI length for X25519')
  return der.subarray(12)
}

/** X25519 private KeyObject → raw 32 bytes. */
export function rawFromPrivate(keyObject) {
  const der = keyObject.export({ type: 'pkcs8', format: 'der' })
  if (der.length !== 48) throw new E2eError('unexpected PKCS8 length for X25519')
  return der.subarray(16)
}

/** Generate a station-side identity — `{ keyId, rawPrivate, rawPublic, publicB64, … }`. */
export function generateIdentity(keyId) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  const rawPublic = rawFromPublic(publicKey)
  return {
    keyId: typeof keyId === 'string' && keyId !== '' ? keyId : crypto.randomBytes(4).toString('hex'),
    privateKey,
    publicKey,
    rawPrivate: rawFromPrivate(privateKey),
    rawPublic,
    publicB64: rawPublic.toString('base64'),
  }
}

/**
 * HKDF-SHA256 over the X25519 shared secret. Salt is the supplied credential
 * string (UTF-8), info is the fixed protocol label, output 32 bytes —
 * byte-compatible with `e2e.derive_key`.
 * @param {Buffer} shared - X25519 shared secret.
 * @param {string} credential - the session token exactly as sent in x-api-key.
 * @returns {Buffer} 32-byte AES-256 key.
 */
export function deriveKey(shared, credential) {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    shared,
    Buffer.from(credential, 'utf8'),
    Buffer.from(E2E_INFO, 'utf8'),
    32,
  ))
}

/**
 * Client half: seal `payload` into an envelope (mirror of `e2e.seal_envelope`).
 * Stateless — a fresh ephemeral X25519 keypair per call, safe to run concurrently.
 *
 * @param {string} serverPublicB64 - station's X25519 public key (b64, from /v1/e2e/params).
 * @param {string} keyId - the key_id that came with those params.
 * @param {object} payload - the JSON request body to protect.
 * @param {string} credential - session token; HKDF salt, binds envelope to identity.
 * @param {{ts?: number, nonce?: Buffer|Uint8Array}} [injection] - test hooks only.
 * @returns {object} `{ v, key_id, eph, nonce, ts, ciphertext }`.
 */
export function sealEnvelope(serverPublicB64, keyId, payload, credential, injection = {}) {
  if (typeof credential !== 'string' || credential === '') {
    throw new E2eError('E2E 需要非空凭证（会话令牌）作为 HKDF 盐')
  }
  const serverRaw = b64decode(serverPublicB64, 'server_public')
  if (serverRaw.length !== 32) throw new E2eError('server_public 不是 32 字节的 X25519 公钥')
  const nonceBuf = injection.nonce === undefined ? crypto.randomBytes(12) : Buffer.from(injection.nonce)
  if (nonceBuf.length !== 12) throw new E2eError('nonce 必须是 12 字节')
  const tsVal = Number.isInteger(injection.ts) ? injection.ts : Math.floor(Date.now() / 1000)
  const keyIdText = String(keyId ?? '')

  const eph = crypto.generateKeyPairSync('x25519')
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromRaw(serverRaw) })
  const key = deriveKey(shared, credential)
  const ephB64 = rawFromPublic(eph.publicKey).toString('base64')
  const nonceB64 = nonceBuf.toString('base64')

  // AAD: compact JSON, alphabetical key order, integer ts/v — byte-identical to
  // Python's json.dumps(..., sort_keys=True, separators=(",", ":")).
  const aad = Buffer.from(JSON.stringify({
    eph: ephB64,
    key_id: keyIdText,
    nonce: nonceB64,
    ts: tsVal,
    v: 1,
  }), 'utf8')

  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonceBuf)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final(),
    cipher.getAuthTag(), // Python's AESGCM output appends the 16-byte tag
  ])

  return {
    v: 1,
    key_id: keyIdText,
    eph: ephB64,
    nonce: nonceB64,
    ts: tsVal,
    ciphertext: ciphertext.toString('base64'),
  }
}

/**
 * Server-half mirror of hubrelay's `open_envelope` — validates the envelope the
 * same way (version, key_id, key sizes, timestamp window, replay) and returns
 * the original payload. Any violation throws E2eError.
 *
 * @param {{keyId: string, rawPrivate: Buffer}} identity - fixture station identity.
 * @param {object} envelope - parsed envelope JSON body.
 * @param {string} credential - the credential this request was authenticated with.
 * @param {{check: (credential: string, keyId: string, nonce: string) => boolean}} [replay]
 * @returns {object} the sealed payload.
 */
export function openEnvelope(identity, envelope, credential, replay) {
  if (typeof credential !== 'string' || credential === '') {
    throw new E2eError('E2E 需要非空凭证（会话令牌）作为 HKDF 盐')
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new E2eError('信封不是 JSON 对象')
  }
  if (Number(envelope.v) !== 1) throw new E2eError('信封版本不支持（本站只认 v=1）')
  if (typeof identity?.keyId !== 'string' || String(envelope.key_id ?? '') !== identity.keyId) {
    throw new E2eError('key_id 不匹配（站点公钥已轮换？重新 GET /v1/e2e/params）')
  }
  const ephRaw = b64decode(envelope.eph, 'eph')
  if (ephRaw.length !== 32) throw new E2eError('eph 必须是 32 字节的 X25519 公钥')
  const nonceBuf = b64decode(envelope.nonce, 'nonce')
  if (nonceBuf.length !== 12) throw new E2eError('nonce 必须是 12 字节')
  const tsVal = Number(envelope.ts)
  if (!Number.isInteger(tsVal) || Math.abs(Math.floor(Date.now() / 1000) - tsVal) > E2E_TS_WINDOW) {
    throw new E2eError('信封时间戳超出容差（±120 秒），检查本机时钟')
  }
  const nonceB64 = nonceBuf.toString('base64')
  if (replay?.check?.(credential, identity.keyId, nonceB64) === false) {
    throw new E2eError('检测到重放：同一信封 nonce 已被使用')
  }
  const ciphertext = b64decode(envelope.ciphertext, 'ciphertext')
  if (ciphertext.length < 16) throw new E2eError('ciphertext 过短')

  const shared = crypto.diffieHellman({
    privateKey: privateFromRaw(identity.rawPrivate),
    publicKey: publicFromRaw(ephRaw),
  })
  const key = deriveKey(shared, credential)
  // AAD strings are re-encoded from the decoded raw bytes — same canonical
  // form the Python side reconstructs inside _aad().
  const aad = Buffer.from(JSON.stringify({
    eph: ephRaw.toString('base64'),
    key_id: identity.keyId,
    nonce: nonceB64,
    ts: tsVal,
    v: 1,
  }), 'utf8')

  let plaintext
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonceBuf)
    decipher.setAAD(aad)
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
    plaintext = Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
      decipher.final(),
    ])
  } catch {
    // The concrete crypto failure is information for an attacker; uniform answer.
    throw new E2eError('信封解密失败：确认凭证、key_id 与参数接口返回一致')
  }

  let payload
  try {
    payload = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new E2eError('信封明文不是合法 JSON')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new E2eError('信封明文必须是 JSON 对象')
  }
  return payload
}

/**
 * Fetch the station's envelope parameters from `GET {baseURL}/e2e/params`
 * (baseURL ends in `/v1`). Returns `null` when the station does not offer
 * envelopes (404/501 — the Python client's "auto → plaintext" rule); throws
 * UpstreamError for anything else, so a broken or scheme-mismatched station
 * fails the turn loudly instead of silently downgrading.
 *
 * @param {string} baseURL - provider base URL ending in `/v1`.
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{scheme: string, key_id: string, server_public: string, ts_window: number} | null>}
 */
export async function fetchE2EParams(baseURL, options = {}) {
  const get = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch
  const signal = options.signal
  let response
  try {
    response = await get(`${baseURL}/e2e/params`, { method: 'GET', redirect: 'error', signal })
  } catch (error) {
    if (signal?.aborted === true || error?.name === 'AbortError') {
      throw new UpstreamError('request aborted', CODE.aborted)
    }
    throw new UpstreamError(`relay-hub: e2e params request failed: ${error?.message ?? error}`, CODE.transport)
  }
  if (response.status === 404 || response.status === 501) return null
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new UpstreamError(
      `relay-hub: e2e params HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      response.status >= 500 ? CODE.server : CODE.client,
      { status: response.status },
    )
  }
  let body
  try {
    body = await response.json()
  } catch {
    throw new UpstreamError('relay-hub: e2e params response is not JSON', CODE.server)
  }
  const scheme = typeof body?.scheme === 'string' ? body.scheme : E2E_SCHEME
  if (scheme !== E2E_SCHEME) {
    throw new UpstreamError(`relay-hub: e2e params advertises unsupported scheme "${scheme}"`, CODE.client)
  }
  const serverPublic = typeof body?.server_public === 'string' ? body.server_public : ''
  const keyId = typeof body?.key_id === 'string' ? body.key_id : ''
  if (!serverPublic || !keyId) {
    throw new UpstreamError('relay-hub: e2e params is missing server_public/key_id', CODE.server)
  }
  if (Buffer.from(serverPublic, 'base64').length !== 32) {
    throw new UpstreamError('relay-hub: e2e params server_public is not a 32-byte key', CODE.server)
  }
  const tsWindow = Number(body?.ts_window)
  return {
    scheme,
    key_id: keyId,
    server_public: serverPublic,
    ts_window: Number.isFinite(tsWindow) && tsWindow > 0 ? tsWindow : E2E_TS_WINDOW,
  }
}
