/**
 * Protocol tests. Run with `node --test test/`.
 *
 * The TOTP vectors are the important ones: if these drift, no plugin can ever
 * join a station, and the failure looks like "the code is wrong" rather than
 * "the implementation is wrong".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  HEADERS,
  PLUGIN_ID,
  TOTP,
  ToipError,
  base32Decode,
  base32Encode,
  classifyJoinFailure,
  fetchSession,
  fetchStation,
  hotp,
  identityHeaders,
  join,
  normalizeRoot,
  providerBaseURL,
  resolvePath,
  secondsLeft,
  totp,
  verifyTotp,
} from '../lib/protocol.js'

// ---------------------------------------------------------------- base32

test('base32 round-trips and tolerates hand-typed input', () => {
  const raw = Buffer.from('0123456789abcdefghij', 'utf8')
  const text = base32Encode(raw)
  assert.equal(base32Decode(text).toString('utf8'), raw.toString('utf8'))
  // lowercase, spaces and hyphens must all be forgiven
  assert.deepEqual(base32Decode(text.toLowerCase()), raw)
  assert.deepEqual(base32Decode(`${text.slice(0, 4)} ${text.slice(4)}`), raw)
  assert.deepEqual(base32Decode(`${text.slice(0, 4)}-${text.slice(4)}`), raw)
})

test('base32 rejects junk instead of guessing', () => {
  for (const bad of ['', '   ', '!!!', '0189']) {
    assert.throws(() => base32Decode(bad), ToipError, `should reject ${JSON.stringify(bad)}`)
  }
})

// ---------------------------------------------------------------- TOTP

test('TOTP matches the RFC 6238 SHA-1 vectors', () => {
  // RFC 6238 Appendix B uses the ASCII secret "12345678901234567890" (20 bytes)
  // for SHA-1. Those vectors are published as 8-digit codes; the last 6 digits
  // of each are this implementation's 6-digit code, which is exactly how a
  // 6-digit TOTP relates to the 8-digit reference value.
  const secret = Buffer.from('12345678901234567890', 'ascii')
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]
  for (const [seconds, expected] of vectors) {
    const full = hotp(secret, Math.floor(seconds / TOTP.period), 8)
    assert.equal(full, expected, `RFC 6238 vector at T=${seconds}`)
    // our 6-digit code is the truncated remainder of the same value
    const six = hotp(secret, Math.floor(seconds / TOTP.period), 6)
    assert.equal(six, expected.slice(-6), `6-digit form at T=${seconds}`)
  }
})

test('TOTP agrees with the station server-side implementation shape', () => {
  // Same secret and instant must give the same code from base32 text or bytes,
  // and the code must be exactly 6 digits.
  const raw = Buffer.from('12345678901234567890', 'ascii')
  const text = base32Encode(raw)
  const at = 1_700_000_000_000
  const code = totp(text, at)
  assert.match(code, /^\d{6}$/)
  assert.equal(totp(raw, at), code)
  assert.equal(code, hotp(raw, Math.floor(at / 1000 / TOTP.period), 6))
})

test('a code stays valid across its own window and changes across windows', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'))
  const start = 1_000_000_000_000 - ((1_000_000_000_000 / 1000) % TOTP.period) * 1000
  assert.equal(totp(secret, start), totp(secret, start + TOTP.period * 1000 - 1))
  assert.notEqual(totp(secret, start), totp(secret, start + TOTP.period * 1000))
})

test('verifyTotp tolerates one window of clock drift each way', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'))
  const now = 1_700_000_000_000
  assert.ok(verifyTotp(secret, totp(secret, now), now))
  assert.ok(verifyTotp(secret, totp(secret, now - TOTP.period * 1000), now))
  assert.ok(verifyTotp(secret, totp(secret, now + TOTP.period * 1000), now))
  assert.ok(!verifyTotp(secret, totp(secret, now - 5 * TOTP.period * 1000), now))
})

test('verifyTotp rejects malformed codes', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'))
  for (const bad of ['', 'abc', '12345', '1234567', '12 34 56']) {
    assert.equal(verifyTotp(secret, bad), false, `should reject ${JSON.stringify(bad)}`)
  }
})

test('secondsLeft is within the period and never zero', () => {
  for (const at of [0, 1, 29_999, 30_000, 1_700_000_000_000]) {
    const left = secondsLeft(at)
    assert.ok(left > 0 && left <= TOTP.period, `secondsLeft(${at}) = ${left}`)
  }
})

// ---------------------------------------------------------------- URLs

test('normalizeRoot accepts everything a user actually pastes', () => {
  const expected = 'http://192.168.1.10:8799'
  assert.equal(normalizeRoot('192.168.1.10:8799'), expected)
  assert.equal(normalizeRoot('http://192.168.1.10:8799'), expected)
  assert.equal(normalizeRoot('http://192.168.1.10:8799/'), expected)
  assert.equal(normalizeRoot('http://192.168.1.10:8799/v1'), expected)
  assert.equal(normalizeRoot('http://192.168.1.10:8799/v1/messages'), expected)
  assert.equal(normalizeRoot('https://relay.example.com/'), 'https://relay.example.com')
  assert.equal(normalizeRoot('relay.example.com', { defaultScheme: 'https' }), 'https://relay.example.com')
})

test('normalizeRoot refuses values it cannot trust', () => {
  assert.throws(() => normalizeRoot(''), ToipError)
  assert.throws(() => normalizeRoot('   '), ToipError)
  assert.throws(() => normalizeRoot('ftp://host'), ToipError)
  assert.throws(() => normalizeRoot('http://user:pass@host'), ToipError, 'embedded credentials')
})

test('providerBaseURL always ends in /v1', () => {
  // The DeepSeek Messages adapter only appends /v1 when the path lacks it, so
  // this must be idempotent and always produce the unambiguous spelling.
  assert.equal(providerBaseURL('http://h:8799'), 'http://h:8799/v1')
  assert.equal(providerBaseURL('http://h:8799/'), 'http://h:8799/v1')
  assert.equal(providerBaseURL('http://h:8799/v1'), 'http://h:8799/v1')
  assert.equal(providerBaseURL('http://h:8799/v1/'), 'http://h:8799/v1')
})

test('resolvePath joins without doubling slashes', () => {
  assert.equal(resolvePath('http://h:8799', '/v1/toip/join'), 'http://h:8799/v1/toip/join')
  assert.equal(resolvePath('http://h:8799/', 'v1/toip/join'), 'http://h:8799/v1/toip/join')
})

test('identityHeaders only emits what it is given', () => {
  assert.deepEqual(identityHeaders(), { [HEADERS.pluginId]: PLUGIN_ID })
  assert.deepEqual(identityHeaders({ pluginVersion: '1.2.3', stationId: 'rst_x' }), {
    [HEADERS.pluginId]: PLUGIN_ID,
    [HEADERS.pluginVersion]: '1.2.3',
    [HEADERS.stationId]: 'rst_x',
  })
})

// ---------------------------------------------------------------- HTTP (real server)

/**
 * Boot a tiny stand-in station so the client is exercised over real HTTP
 * rather than against a mock.
 *
 * @param {(req: import('node:http').IncomingMessage, body: string) => {status: number, body: unknown}} handler
 * @returns {Promise<{root: string, close: () => Promise<void>, seen: object[]}>}
 */
async function fakeStation(handler) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      const result = handler(req, body)
      const text = typeof result.body === 'string' ? result.body : JSON.stringify(result.body)
      res.writeHead(result.status, { 'content-type': 'application/json' })
      res.end(text)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    root: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('fetchStation reads the capability declaration', async () => {
  const station = await fakeStation(() => ({
    status: 200,
    body: {
      protocol: 'toip',
      version: 1,
      enabled: true,
      station_id: 'rst_abc',
      otp: { algorithm: 'SHA1', digits: 6, period: 30, window: 1 },
      endpoints: { join: '/v1/toip/join' },
    },
  }))
  try {
    const payload = await fetchStation(station.root)
    assert.equal(payload.enabled, true)
    assert.equal(payload.station_id, 'rst_abc')
    assert.equal(station.seen[0].url, '/v1/toip/station')
  } finally {
    await station.close()
  }
})

test('join sends plugin identity and returns the dsh block', async () => {
  const station = await fakeStation(() => ({
    status: 200,
    body: {
      protocol: 'toip',
      version: 1,
      session: { token: 'rht_deadbeef', rotated: false },
      dsh: {
        provider: 'relayhub',
        baseURL: 'http://station/v1',
        apiKey: 'rht_deadbeef',
        models: [{ id: 'glm-5.2', contextWindow: 1000000 }],
      },
      otp: { seconds_left: 12.5 },
    },
  }))
  try {
    const payload = await join(station.root, { ticket: 'rhe_secret', name: 'laptop' }, {
      pluginVersion: '0.1.0',
    })
    assert.equal(payload.session.token, 'rht_deadbeef')
    assert.equal(payload.dsh.baseURL, 'http://station/v1')
    const sent = JSON.parse(station.seen[0].body)
    assert.equal(sent.plugin, PLUGIN_ID)
    assert.equal(sent.ticket, 'rhe_secret')
    assert.equal(sent.name, 'laptop')
    assert.equal(sent.client, 'dsh')
    assert.equal(sent.plugin_version, '0.1.0')
    assert.equal(station.seen[0].url, '/v1/toip/join')
  } finally {
    await station.close()
  }
})

test('join strips whitespace a user pasted with the code', async () => {
  const station = await fakeStation(() => ({ status: 200, body: { session: { token: 't' } } }))
  try {
    await join(station.root, { code: ' 123 456 ' })
    assert.equal(JSON.parse(station.seen[0].body).code, '123456')
  } finally {
    await station.close()
  }
})

test('station errors surface the operator-facing message', async () => {
  const station = await fakeStation(() => ({
    status: 403,
    body: { error: { type: 'permission_error', message: '动态口令不正确或已过期（剩余 2 次尝试）' } },
  }))
  try {
    await assert.rejects(
      () => join(station.root, { code: '000000' }),
      (error) => {
        assert.ok(error instanceof ToipError)
        assert.equal(error.status, 403)
        assert.equal(error.type, 'permission_error')
        assert.match(error.message, /动态口令/)
        return true
      },
    )
  } finally {
    await station.close()
  }
})

test('a non-JSON error body still produces a usable error', async () => {
  const station = await fakeStation(() => ({ status: 502, body: '<html>bad gateway</html>' }))
  try {
    await assert.rejects(
      () => fetchStation(station.root),
      (error) => {
        assert.equal(error.status, 502)
        assert.match(error.message, /bad gateway/)
        return true
      },
    )
  } finally {
    await station.close()
  }
})

test('fetchSession authenticates with x-api-key', async () => {
  const station = await fakeStation(() => ({
    status: 200,
    body: { protocol: 'toip', plugin_id: PLUGIN_ID, expires_in: 100 },
  }))
  try {
    const payload = await fetchSession(station.root, 'rht_token')
    assert.equal(payload.plugin_id, PLUGIN_ID)
    assert.equal(station.seen[0].headers['x-api-key'], 'rht_token')
  } finally {
    await station.close()
  }
})

test('an unreachable station fails fast with an actionable message', async () => {
  // Port 1 on loopback: nothing listens, connection is refused immediately.
  await assert.rejects(
    () => fetchStation('http://127.0.0.1:1', { timeoutMs: 2000 }),
    (error) => {
      assert.ok(error instanceof ToipError)
      assert.equal(error.status, 0)
      assert.match(error.message, /cannot reach the station/)
      return true
    },
  )
})

// ---------------------------------------------------------------- failure guidance

test('classifyJoinFailure tells the user what to do per status', () => {
  const noToip = classifyJoinFailure(new ToipError('nope', { status: 404 }))
  assert.equal(noToip.kind, 'no-toip')
  assert.equal(noToip.retryable, false)

  const rejected = classifyJoinFailure(new ToipError('口令不正确', { status: 403 }))
  assert.equal(rejected.kind, 'rejected')
  assert.equal(rejected.retryable, true)
  assert.match(rejected.hint, /30 seconds|clock/)

  const locked = classifyJoinFailure(new ToipError('尝试次数已用尽', { status: 403 }))
  assert.equal(locked.kind, 'locked-out')
  assert.equal(locked.retryable, false)

  const unreachable = classifyJoinFailure(new ToipError('boom'))
  assert.equal(unreachable.kind, 'unreachable')
  assert.equal(unreachable.retryable, true)

  const malformed = classifyJoinFailure(new ToipError('missing plugin', { status: 400 }))
  assert.equal(malformed.kind, 'bad-request')
})
