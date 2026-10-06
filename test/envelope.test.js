/**
 * E2E envelope tests (0.3.0): the crypto core, the params fetch, and the full
 * sealed call path over a real HTTP socket — plus cross-verification against
 * hubrelay's Python implementation, which is the wire-format authority.
 *
 * Named `envelope.test.js` because `e2e.test.js` already hosts the live-station
 * integration suite (plugin ↔ real hubrelay process).
 *
 * The Python direction needs Python 3.11 (with `cryptography`) and the
 * rh-oss-dev source tree on this machine; those tests skip gracefully when the
 * interpreter is absent so the suite stays portable.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  E2E_SCHEME,
  ENVELOPE_CONTENT_TYPE,
  E2eError,
  sealEnvelope,
  openEnvelope,
  generateIdentity,
  fetchE2EParams,
} from '../lib/e2e.js'
import { apply } from '../lib/index.js'

// ---------------------------------------------------------------------------
// helpers

const sse = (...events) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')

const messageStart = (usage = { input_tokens: 100 }) => ({ type: 'message_start', message: { usage } })
const blockStart = (index, block) => ({ type: 'content_block_start', index, content_block: block })
const textDelta = (index, text) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
const messageDelta = (stopReason, usage) => ({ type: 'message_delta', delta: { stop_reason: stopReason }, usage })
const messageStop = { type: 'message_stop' }

function sseReply(res, text = 'sealed-ok') {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(sse(
    messageStart(),
    blockStart(0, { type: 'text' }),
    textDelta(0, text),
    messageDelta('end_turn', { output_tokens: 3 }),
    messageStop,
  ))
}

/**
 * A fixture station that speaks the E2E protocol the way hubrelay does:
 * public params on /v1/e2e/params, envelope requests opened server-side with
 * the credential from the x-api-key header, replay-guarded by (cred, key, nonce).
 */
async function startE2EStation(options = {}) {
  const o = {
    paramsStatus: 200,
    scheme: E2E_SCHEME,
    rotateOnFirstSeal: false,
    nextIdentity: null,
    keyId: '0a1b2c3d',
    ...options,
  }
  const state = {
    identity: generateIdentity(o.keyId),
    rotated: false,
    paramsHits: 0,
    plainPosts: 0,
    sealedOpens: 0,
    rejects: 0,
    openedPayloads: [],
  }
  const replay = new Set()
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0]
      if (url === '/v1/e2e/params') {
        state.paramsHits++
        if (o.paramsStatus !== 200) {
          res.writeHead(o.paramsStatus, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'not offered here' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          scheme: o.scheme,
          key_id: state.identity.keyId,
          server_public: state.identity.publicB64,
          ts_window: 120,
        }))
        return
      }
      if (url === '/v1/messages') {
        const isEnvelope = String(req.headers['content-type'] ?? '').includes('x-relayhub-envelope')
        if (isEnvelope) {
          const envelope = JSON.parse(raw)
          if (o.rotateOnFirstSeal && !state.rotated && o.nextIdentity) {
            // Simulate a station that regenerated its identity between the
            // client's params fetch and this request: reject with the rotation
            // message, then serve the NEW identity from now on.
            state.identity = o.nextIdentity
            state.rotated = true
            state.rejects++
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'key_id 不匹配（站点公钥已轮换？重新 GET /v1/e2e/params）' }))
            return
          }
          try {
            const credential = String(req.headers['x-api-key'] ?? '')
            const payload = openEnvelope(
              { keyId: state.identity.keyId, rawPrivate: state.identity.rawPrivate },
              envelope,
              credential,
              { check: (cred, kid, nonce) => {
                  const key = `${cred}|${kid}|${nonce}`
                  if (replay.has(key)) return false
                  replay.add(key)
                  return true
                } },
            )
            state.sealedOpens++
            state.openedPayloads.push(payload)
          } catch (error) {
            state.rejects++
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
            return
          }
          sseReply(res)
          return
        }
        state.plainPosts++
        sseReply(res)
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'no route' }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

/** Build a configured adapter wired to `stationURL` (mirrors callpath.test.js). */
function adapterFor(stationURL, extraConfig = {}) {
  const warns = []
  const record = { adapters: null }
  const ctx = {
    fiber: { entry: { options: { id: 'relayhub-bridge' } } },
    logger: { warn: message => warns.push(String(message)) },
    llm: {
      registerConfigurableProviders: () => ({ replace() {} }),
      registerAdapter: (_providers, adapter) => { record.adapters = { adapter } },
    },
    set() {},
    effect() {},
  }
  apply(ctx, {
    stationURL,
    apiKey: 'rht_session',
    stationID: 'rst_fixture',
    models: [{ id: 'test-model', contextWindow: 8192 }],
    ...extraConfig,
  })
  return { adapter: record.adapters.adapter, warns }
}

async function collect(iterator) {
  const chunks = []
  for await (const chunk of iterator) chunks.push(chunk)
  return chunks
}

const userTurn = messages => ({
  model: 'test-model',
  messages: messages ?? [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})

const finishChunk = chunks => chunks.find(chunk => chunk.type === 'finish')

// Python cross-verification bridge -------------------------------------------

const PY311 = 'C:/Users/ws/AppData/Local/Programs/Python/Python311-64/python.exe'
const PY_HELPER = fileURLToPath(new URL('./helpers/py_e2e.py', import.meta.url))

function pythonAvailable() {
  return existsSync(PY311)
}

function pyRun(mode, data) {
  const result = spawnSync(PY311, [PY_HELPER, mode], {
    input: JSON.stringify(data),
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  })
  const lines = String(result.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean)
  const last = lines[lines.length - 1]
  if (!last) {
    throw new Error(`python helper produced no output: stderr=${String(result.stderr ?? '').slice(0, 400)}`)
  }
  return JSON.parse(last)
}

// ---------------------------------------------------------------------------
// crypto core

test('seal → open roundtrip keeps the payload and the envelope shape', () => {
  const id = generateIdentity('0a1b2c3d')
  const payload = {
    model: 'test-model',
    messages: [{ role: 'user', content: '你好 E2E' }],
    stream: true,
  }
  const envelope = sealEnvelope(id.publicB64, id.keyId, payload, 'rht_session')
  assert.equal(envelope.v, 1)
  assert.equal(envelope.key_id, '0a1b2c3d')
  assert.equal(Buffer.from(envelope.eph, 'base64').length, 32, 'eph is a 32-byte X25519 public key')
  assert.equal(Buffer.from(envelope.nonce, 'base64').length, 12)
  assert.equal(Number.isInteger(envelope.ts), true)
  assert.equal(typeof envelope.ciphertext, 'string')

  const opened = openEnvelope({ keyId: id.keyId, rawPrivate: id.rawPrivate }, envelope, 'rht_session')
  assert.deepEqual(opened, payload)

  // Every seal uses a fresh ephemeral key and nonce — same input, new envelope.
  const again = sealEnvelope(id.publicB64, id.keyId, payload, 'rht_session')
  assert.notEqual(again.eph, envelope.eph)
  assert.notEqual(again.nonce, envelope.nonce)
})

test('a wrong credential cannot open the envelope (identity binding)', () => {
  const id = generateIdentity()
  const envelope = sealEnvelope(id.publicB64, id.keyId, { a: 1 }, 'rht_session')
  assert.throws(
    () => openEnvelope({ keyId: id.keyId, rawPrivate: id.rawPrivate }, envelope, 'some-other-token'),
    /信封解密失败/,
  )
})

test('AAD binds the envelope fields: ts tamper and ciphertext tamper both fail', () => {
  const id = generateIdentity()
  const envelope = sealEnvelope(id.publicB64, id.keyId, { a: 1 }, 'rht_session')

  // ts+1 stays inside the ±120s window, so only the AAD mismatch can reject it.
  const tsTampered = { ...envelope, ts: envelope.ts + 1 }
  assert.throws(
    () => openEnvelope({ keyId: id.keyId, rawPrivate: id.rawPrivate }, tsTampered, 'rht_session'),
    /信封解密失败/,
  )

  const raw = Buffer.from(envelope.ciphertext, 'base64')
  raw[raw.length - 17] ^= 0x01 // flip one bit inside the ciphertext body
  const ctTampered = { ...envelope, ciphertext: raw.toString('base64') }
  assert.throws(
    () => openEnvelope({ keyId: id.keyId, rawPrivate: id.rawPrivate }, ctTampered, 'rht_session'),
    /信封解密失败/,
  )
})

test('timestamp window and replay guard are enforced', () => {
  const id = generateIdentity()
  const now = Math.floor(Date.now() / 1000)
  const stale = sealEnvelope(id.publicB64, id.keyId, { a: 1 }, 'rht_session', { ts: now - 121 })
  assert.throws(
    () => openEnvelope({ keyId: id.keyId, rawPrivate: id.rawPrivate }, stale, 'rht_session'),
    /时间戳/,
  )

  const fixedNonce = Buffer.alloc(12, 7)
  const first = sealEnvelope(id.publicB64, id.keyId, { a: 1 }, 'rht_session', { nonce: fixedNonce })
  const second = sealEnvelope(id.publicB64, id.keyId, { a: 2 }, 'rht_session', { nonce: fixedNonce })
  const seen = new Set()
  const guard = { check: (_cred, _kid, nonce) => { if (seen.has(nonce)) return false; seen.add(nonce); return true } }
  const identity = { keyId: id.keyId, rawPrivate: id.rawPrivate }
  assert.deepEqual(openEnvelope(identity, first, 'rht_session', guard), { a: 1 })
  assert.throws(() => openEnvelope(identity, second, 'rht_session', guard), /重放/)
})

test('malformed envelopes are rejected with explicit errors', () => {
  const id = generateIdentity()
  const envelope = sealEnvelope(id.publicB64, id.keyId, { a: 1 }, 'rht_session')
  const identity = { keyId: id.keyId, rawPrivate: id.rawPrivate }
  assert.throws(() => openEnvelope(identity, { ...envelope, v: 2 }, 'rht_session'), /版本/)
  assert.throws(
    () => openEnvelope(identity, { ...envelope, key_id: 'ffffffff' }, 'rht_session'),
    /key_id/,
  )
  assert.throws(
    () => openEnvelope(identity, { ...envelope, eph: Buffer.alloc(16).toString('base64') }, 'rht_session'),
    /eph/,
  )
  assert.throws(
    () => openEnvelope(identity, { ...envelope, nonce: Buffer.alloc(8).toString('base64') }, 'rht_session'),
    /nonce/,
  )
})

// ---------------------------------------------------------------------------
// Python cross-verification (the wire-format authority)

test('cross: JS-sealed envelope opens under hubrelay Python', { skip: !pythonAvailable() }, () => {
  const id = generateIdentity('7f3e9d01')
  const payload = {
    model: 'test-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: '中文往返 cross-check' }] }],
    stream: true,
    max_tokens: 4096,
  }
  const envelope = sealEnvelope(id.publicB64, id.keyId, payload, 'cred-1')

  const good = pyRun('open', {
    envelope, credential: 'cred-1', raw_private: id.rawPrivate.toString('hex'), key_id: id.keyId,
  })
  assert.equal(good.ok, true, `python open failed: ${good.error ?? ''}`)
  assert.deepEqual(good.payload, payload)

  // The salt is the supplied credential string — a different token must fail
  // on the Python side too.
  const bad = pyRun('open', {
    envelope, credential: 'cred-2', raw_private: id.rawPrivate.toString('hex'), key_id: id.keyId,
  })
  assert.equal(bad.ok, false, 'wrong credential must not open the envelope')
  assert.match(String(bad.error), /解密失败|decryption|failed/i)
})

test('cross: Python-sealed envelope opens in JS (AAD sort_keys parity)', { skip: !pythonAvailable() }, () => {
  const payload = {
    model: 'test-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Python 封的，JS 开' }] }],
    stream: false,
  }
  const sealed = pyRun('seal', { payload, credential: 'rht_session', key_id: '12345678' })
  assert.equal(sealed.ok, true, `python seal failed: ${sealed.error ?? ''}`)
  const id = { keyId: sealed.key_id, rawPrivate: Buffer.from(sealed.raw_private, 'hex') }
  const opened = openEnvelope(id, sealed.envelope, 'rht_session')
  assert.deepEqual(opened, payload)
})

// ---------------------------------------------------------------------------
// params fetch

test('fetchE2EParams: happy path, 404/501 → null, 500 and bad scheme → loud', async () => {
  const station = await startE2EStation({})
  try {
    const params = await fetchE2EParams(`${station.url}/v1`)
    assert.equal(params.scheme, E2E_SCHEME)
    assert.equal(params.key_id, '0a1b2c3d')
    assert.equal(typeof params.server_public, 'string')
    assert.equal(Buffer.from(params.server_public, 'base64').length, 32)
    assert.equal(params.ts_window, 120)
  } finally {
    await station.close()
  }

  for (const status of [404, 501]) {
    const plain = await startE2EStation({ paramsStatus: status })
    try {
      assert.equal(await fetchE2EParams(`${plain.url}/v1`), null)
    } finally {
      await plain.close()
    }
  }

  const broken = await startE2EStation({ paramsStatus: 500 })
  try {
    await assert.rejects(() => fetchE2EParams(`${broken.url}/v1`), /HTTP 500/)
  } finally {
    await broken.close()
  }

  const alien = await startE2EStation({ scheme: 'xor-otp-v9' })
  try {
    await assert.rejects(() => fetchE2EParams(`${alien.url}/v1`), /unsupported scheme/)
  } finally {
    await alien.close()
  }
})

// ---------------------------------------------------------------------------
// full call path

test('auto mode seals every turn; params are fetched once and cached', async () => {
  const station = await startE2EStation({})
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.equal(finishChunk(chunks).reason.kind, 'stop')
    assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'sealed-ok'))
    assert.equal(station.state.plainPosts, 0, 'no plaintext may reach an envelope station')
    assert.equal(station.state.sealedOpens, 1)
    assert.equal(station.state.paramsHits, 1)
    assert.equal(station.state.openedPayloads[0].model, 'test-model')
    assert.equal(station.state.openedPayloads[0].stream, true)

    // Second turn reuses the cached params — exactly one params GET across turns.
    const chunks2 = await collect(adapter.stream(userTurn()))
    assert.equal(finishChunk(chunks2).reason.kind, 'stop')
    assert.equal(station.state.sealedOpens, 2)
    assert.equal(station.state.paramsHits, 1)
  } finally {
    await station.close()
  }
})

test('auto mode falls back to plaintext on a non-E2E station, re-probing each turn', async () => {
  const station = await startE2EStation({ paramsStatus: 404 })
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.equal(finishChunk(chunks).reason.kind, 'stop')
    assert.equal(station.state.plainPosts, 1)
    assert.equal(station.state.sealedOpens, 0)

    // Negatives are NOT cached — the Python client re-probes every turn.
    await collect(adapter.stream(userTurn()))
    assert.equal(station.state.paramsHits, 2)
    assert.equal(station.state.plainPosts, 2)
  } finally {
    await station.close()
  }
})

test('auto mode also falls back on a 501 (station without cryptography)', async () => {
  const station = await startE2EStation({ paramsStatus: 501 })
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.equal(finishChunk(chunks).reason.kind, 'stop')
    assert.equal(station.state.plainPosts, 1)
  } finally {
    await station.close()
  }
})

test('require mode refuses to send plaintext to a non-E2E station', async () => {
  const station = await startE2EStation({ paramsStatus: 404 })
  const { adapter } = adapterFor(station.url, { e2e: 'require' })
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.equal(chunks.length, 1, 'only the error finish is produced')
    const finish = finishChunk(chunks)
    assert.equal(finish.reason.kind, 'error')
    assert.match(finish.reason.failure.message, /refuses plaintext/)
    assert.equal(station.state.plainPosts, 0, 'nothing may leave in plaintext')
    assert.equal(station.state.paramsHits, 1)
  } finally {
    await station.close()
  }
})

test('off mode never touches the params endpoint', async () => {
  const station = await startE2EStation({})
  const { adapter } = adapterFor(station.url, { e2e: 'off' })
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.equal(finishChunk(chunks).reason.kind, 'stop')
    assert.equal(station.state.paramsHits, 0)
    assert.equal(station.state.plainPosts, 1)
  } finally {
    await station.close()
  }
})

test('key rotation: 400 with key_id → refresh params once → re-seal invisibly', async () => {
  const nextIdentity = generateIdentity('deadbeef')
  const station = await startE2EStation({ rotateOnFirstSeal: true, nextIdentity })
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.equal(finishChunk(chunks).reason.kind, 'stop', 'the retry must be invisible to the caller')
    assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'sealed-ok'))
    assert.equal(station.state.paramsHits, 2, 'initial fetch + rotation refresh')
    assert.equal(station.state.rejects, 1, 'exactly one rejected seal (the rotation 400)')
    assert.equal(station.state.sealedOpens, 1, 'the re-sealed envelope opened')
    assert.equal(station.state.openedPayloads[0].model, 'test-model')
  } finally {
    await station.close()
  }
})

test('E2eError carries the envelope vocabulary', () => {
  const error = new E2eError('test')
  assert.equal(error.name, 'E2eError')
  assert.equal(error instanceof Error, true)
  assert.equal(ENVELOPE_CONTENT_TYPE, 'application/x-relayhub-envelope+json')
})
