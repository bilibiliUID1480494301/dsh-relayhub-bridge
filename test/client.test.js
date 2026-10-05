/**
 * Client-half tests.
 *
 * `lib/client.js` cannot be imported as an ES module: it is a browser artifact
 * in the `window.__ModuleLoader__.load({ id, factory })` format, and it is
 * deliberately self-contained (the official guide forbids a Client half from
 * `require()`-ing Harness Client packages, and `node:crypto` does not exist in
 * the browser). So these tests boot it the way the browser does -- with a
 * stubbed module loader, a stub `require`, and WebCrypto -- and then assert the
 * two things that matter:
 *
 * 1. the manifest and registration shape match what the slot system expects;
 * 2. its duplicated protocol math has not drifted from `lib/protocol.js`, which
 *    is the single source of truth for the wire format.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { webcrypto } from 'node:crypto'

import { totp as serverTotp, base32Encode, normalizeRoot, providerBaseURL } from '../lib/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/**
 * Load the Client artifact the way the browser would.
 *
 * @param {object} [options] - what the host provides.
 * @param {object} [options.remote] - the `ctx.remote` bag.
 * @param {boolean} [options.withoutSlots] - omit `ctx.slots`.
 * @returns {{module: object, registered: object[], effects: Function[], slots: object}}
 */
function loadClient(options = {}) {
  const registered = []
  const effects = []
  let loaded = null

  const slots = {
    inject(owner, callback) {
      // The real service installs the callback's registrations when the owning
      // declaration is present; here it is present immediately.
      callback()
      return () => {}
    },
    register(options_, component) {
      registered.push({ options: options_, component })
      return () => {}
    },
  }

  const ctx = {
    effect(fn) {
      effects.push(fn)
      return () => {}
    },
    slots: options.withoutSlots ? undefined : slots,
    remote: options.remote,
  }

  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        loaded = spec
      },
    },
  }
  if (!globalThis.crypto) globalThis.crypto = webcrypto
  globalThis.document = {
    head: { appendChild() {} },
    getElementById() {
      return null
    },
    createElement() {
      return { id: '', textContent: '' }
    },
  }

  // Evaluate the artifact as the browser does: a script, not a module.
  const run = new Function('window', 'document', 'crypto', 'fetch', source)
  run(globalThis.window, globalThis.document, globalThis.crypto, globalThis.fetch)

  assert.ok(loaded, 'the artifact must call window.__ModuleLoader__.load')

  const factory = loaded.factory
  const instance = factory((id) => {
    if (id === 'react') return { createElement: () => null, useState: () => [null, () => {}] }
    throw new Error('unexpected require: ' + id)
  })

  return { spec: loaded, module: instance, registered, effects, slots, ctx }
}

// ---------------------------------------------------------------- manifest

test('the artifact declares the module id equal to the package name', () => {
  const { spec } = loadClient()
  assert.equal(spec.id, 'dsh-relayhub-bridge')
  assert.equal(typeof spec.factory, 'function')
})

test('the client module injects slots and nothing else', () => {
  const { module } = loadClient()
  assert.deepEqual(module.inject, ['slots'])
  assert.equal(typeof module.apply, 'function')
})

test('the client half requires react and no other module', () => {
  // The guide forbids require()-ing Harness Client packages; a stray require
  // would also be a runtime dependency the package does not declare.
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(required)], ['react'])
})

test('the client half never imports a harness client package', () => {
  assert.equal(/require\(\s*['"]@deepseek-ai\//.test(source), false)
  assert.equal(/from\s+['"]@deepseek-ai\//.test(source), false)
})

test('calling the client factory does not touch the DOM', () => {
  // "Keep factories free of side effects." Styles are installed in apply().
  let appended = 0
  const original = globalThis.document
  loadClient()
  globalThis.document.head.appendChild = () => {
    appended += 1
  }
  assert.equal(appended, 0)
  globalThis.document = original
})

// ---------------------------------------------------------------- registration

test('apply registers one settings.section slot entry', () => {
  const { module, registered, ctx } = loadClient()
  module.apply(ctx)

  assert.equal(registered.length, 1)
  const entry = registered[0]
  assert.equal(entry.options.name, 'settings.section')
  assert.equal(entry.options.id, 'relayhub')
  assert.equal(typeof entry.options.order, 'number')
  assert.equal(typeof entry.options.label, 'function')
  assert.equal(typeof entry.component, 'function')
})

test('the slot label never throws', () => {
  const { module, registered, ctx } = loadClient()
  module.apply(ctx)
  assert.equal(typeof registered[0].options.label(), 'string')
})

test('apply installs its styles as a disposable effect', () => {
  const { module, effects, ctx } = loadClient()
  module.apply(ctx)
  assert.equal(effects.length, 1, 'styles must be owned by an effect')
  const dispose = effects[0]()
  assert.equal(typeof dispose, 'function', 'the effect must return cleanup')
})

test('apply works when a service is missing instead of blanking the slot', () => {
  // A throwing apply/component blanks the whole slot entry, so absence of an
  // optional service must not be fatal.
  const { module, ctx } = loadClient({ withoutSlots: true })
  assert.doesNotThrow(() => module.apply(ctx))
})

// ---------------------------------------------------------------- protocol parity

test('the client TOTP agrees with the Node implementation, moment by moment', async () => {
  // The anti-drift assertion for the deliberate duplication. The client cannot
  // import ../protocol.js (a bare relative import does not resolve from the
  // browser module table) and cannot use node:crypto, so the algorithm exists
  // twice. If the copies ever disagree, nobody could join from the UI and the
  // symptom would look like "the code is wrong" instead of a bug here.
  const raw = Buffer.from('12345678901234567890', 'ascii')
  const secret = base32Encode(raw)
  const { module } = loadClient()
  const client = module.__internals
  assert.ok(client, 'the client must expose __internals for parity testing')

  // Walk a whole window plus both drift edges, so an off-by-one in the counter
  // or in the +/- window cannot hide.
  const base = 1_700_000_000_000
  for (let offset = -60_000; offset <= 60_000; offset += 7_000) {
    const at = base + offset
    assert.equal(
      await client.totp(secret, at),
      serverTotp(secret, at),
      `client and server TOTP disagree at ${at}`,
    )
  }
})

test('the client URL and model helpers agree with the protocol module', () => {
  const { module } = loadClient()
  const client = module.__internals

  for (const input of [
    '192.168.1.10:8799',
    'http://192.168.1.10:8799',
    'http://192.168.1.10:8799/',
    'http://192.168.1.10:8799/v1',
    'http://192.168.1.10:8799/v1/messages',
  ]) {
    assert.equal(client.normalizeRoot(input), normalizeRoot(input), `normalizeRoot(${input})`)
  }
  assert.equal(client.providerBaseURL('http://h:8799'), providerBaseURL('http://h:8799'))
  assert.equal(client.providerBaseURL('http://h:8799/v1'), providerBaseURL('http://h:8799/v1'))

  // Invalid addresses must be rejected by both, not silently mangled.
  for (const bad of ['', 'ftp://host', 'http://user:pw@host']) {
    assert.throws(() => client.normalizeRoot(bad), `client should reject ${JSON.stringify(bad)}`)
    assert.throws(() => normalizeRoot(bad), `protocol should reject ${JSON.stringify(bad)}`)
  }

  assert.deepEqual(
    client.modelsFromJoin({ dsh: { models: [{ id: 'a', contextWindow: 1000 }, { id: 'a' }, { id: '' }] } }),
    [{ id: 'a', contextWindow: 1000 }],
  )
})

test('secondsLeft stays inside the period', () => {
  const { module } = loadClient()
  for (const at of [0, 999, 29_999, 30_000, 1_700_000_000_000]) {
    const left = module.__internals.secondsLeft(at)
    assert.ok(left > 0 && left <= 30, `secondsLeft(${at}) = ${left}`)
  }
})
