/**
 * Plugin-level tests: provider registration and request tagging.
 *
 * These use a stub Cordis context rather than a full Harness boot. That is a
 * deliberate trade: booting Harness in CI is heavy and brittle, while the two
 * things that actually break a provider plugin -- registering the wrong route,
 * and failing to attach the headers the station accounts by -- are fully
 * observable through the context surface the plugin is allowed to use.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  PROVIDER,
  apply,
  inject,
  modelsFromJoin,
  joinStationWith,
  name as pluginName,
  PLUGIN_VERSION,
} from '../lib/index.js'
import { HEADERS, PLUGIN_ID } from '../lib/protocol.js'

/**
 * Build a stub Cordis context recording everything the plugin registers.
 *
 * @param {object} [config] - initial plugin configuration.
 * @returns {{ctx: object, record: object, setConfig: (patch: object) => void}}
 */
function stubContext(config = {}) {
  const live = { ...config }
  const record = { providers: null, adapters: null, services: {} }
  const ctx = {
    fiber: { entry: { options: { id: 'relayhub-bridge' } } },
    llm: {
      registerConfigurableProviders(entries) {
        record.providers = entries
        return { replace(next) { record.providers = next } }
      },
      registerAdapter(providers, adapter) {
        record.adapters = { providers, adapter }
        return { replace() {} }
      },
    },
    set(name, value) {
      record.services[name] = value
    },
    effect() {},
  }
  // Mirror the way Cordis hands volatile fields to a plugin: every access reads
  // the current value, so a config write is visible on the next request.
  const proxy = {}
  for (const key of Object.keys(live)) {
    Object.defineProperty(proxy, key, {
      enumerable: true,
      get: () => live[key],
    })
  }
  return { ctx, record, config: proxy, setConfig: (patch) => Object.assign(live, patch) }
}

test('the plugin declares only the llm service', () => {
  assert.deepEqual(inject, ['llm'])
  assert.equal(pluginName, 'relayhub-bridge')
})

test('apply registers the relayhub route and its adapter', () => {
  const { ctx, record, config } = stubContext({ stationURL: '', apiKey: '', models: [] })
  apply(ctx, config)

  assert.equal(record.providers.length, 1)
  const declared = record.providers[0]
  assert.equal(declared.provider, PROVIDER)
  assert.equal(declared.displayName, 'relay-hub')
  assert.ok(declared.settingsNs.length > 0, 'settingsNs must be non-empty or the registry rejects it')
  assert.deepEqual(declared.settingsPath, [])

  assert.deepEqual(record.adapters.providers, [PROVIDER])
  assert.equal(typeof record.adapters.adapter.resolveAuth, 'function')
  assert.equal(typeof record.adapters.adapter.listModels, 'function')
})

test('the adapter survives the Host registration probe (providerRetryPolicy bug)', () => {
  // 0.1.2 的启用失败根因：dsh-llm 的 prepareRoutes 在注册期**无条件**调用
  // adapter.providerRetryPolicy(provider)，方法缺失 = TypeError = 激活失败。
  // 这里按 Host 的真实调用顺序演练一遍（lib/index.js:1867 附近）。
  const { ctx, record, config } = stubContext({
    apiKey: 'rht_x',
    models: [{ id: 'glm-5.2' }],
  })
  apply(ctx, config)
  const adapter = record.adapters.adapter

  const info = adapter.providerInfo(PROVIDER)
  assert.equal(info.id, PROVIDER)
  assert.equal(info.name, 'relay-hub')
  assert.doesNotThrow(() => adapter.providerRetryPolicy(PROVIDER), 'providerRetryPolicy must exist: the Host calls it unconditionally at registration')
  assert.doesNotThrow(() => adapter.imageRequestPricing(PROVIDER, 'glm-5.2'), 'imageRequestPricing must exist: the token meter resolves it per measurement')
})

test('resolveAuth carries the session token AND the plugin identity headers', () => {
  // This is the contract that makes per-plugin logging work: the station reads
  // X-DSH-Plugin-Id off the inference request. If these headers stop riding
  // along, logging silently degrades to token-level attribution and nothing
  // else visibly breaks -- so it is asserted explicitly.
  const { ctx, record, config } = stubContext({
    stationURL: 'http://station:8799',
    apiKey: 'rht_session',
    stationID: 'rst_abc',
    models: [],
  })
  apply(ctx, config)

  const auth = record.adapters.adapter.resolveAuth()
  assert.equal(auth.headers['x-api-key'], 'rht_session')
  assert.equal(auth.headers[HEADERS.pluginId], PLUGIN_ID)
  assert.equal(auth.headers[HEADERS.pluginVersion], PLUGIN_VERSION)
  assert.equal(auth.headers[HEADERS.stationId], 'rst_abc')
})

test('resolveAuth explains itself when no join has happened yet', () => {
  const { ctx, record, config } = stubContext({ stationURL: '', apiKey: '', models: [] })
  apply(ctx, config)
  assert.throws(
    () => record.adapters.adapter.resolveAuth(),
    /no session token yet/,
  )
})

test('listModels advertises exactly what the station granted', async () => {
  const { ctx, record, config } = stubContext({
    apiKey: 'rht_x',
    models: [{ id: 'glm-5.2', contextWindow: 1000000 }, { id: 'deepseek-v4-pro' }],
  })
  apply(ctx, config)
  const models = await record.adapters.adapter.listModels()
  assert.deepEqual(models.map((m) => m.id), ['glm-5.2', 'deepseek-v4-pro'])
  assert.ok(models.every((m) => m.provider === PROVIDER))
  assert.ok(models.every((m) => Array.isArray(m.inputModalities)))
})

test('extraHeaders can be layered on but cannot displace the token or identity', () => {
  const { ctx, record, config } = stubContext({
    apiKey: 'rht_session',
    stationID: 'rst_abc',
    models: [],
    extraHeaders: { 'x-custom': 'yes' },
  })
  apply(ctx, config)
  const auth = record.adapters.adapter.resolveAuth()
  assert.equal(auth.headers['x-custom'], 'yes')
  assert.equal(auth.headers['x-api-key'], 'rht_session')
})

test('the bridge service is exposed with no token in describe()', () => {
  const { ctx, record, config } = stubContext({
    stationURL: 'http://station:8799',
    apiKey: 'rht_secret_value',
    stationID: 'rst_abc',
    models: [{ id: 'glm-5.2' }],
  })
  apply(ctx, config)
  const bridge = record.services.relayhubBridge
  assert.ok(bridge, 'relayhubBridge must be published on the context')
  assert.equal(bridge.provider, PROVIDER)
  const described = bridge.describe()
  assert.equal(described.stationURL, 'http://station:8799')
  assert.equal(described.hasToken, true)
  assert.deepEqual(described.models, ['glm-5.2'])
  // describe() is the thing a UI or a log would render: it must not carry the token.
  assert.ok(!JSON.stringify(described).includes('rht_secret_value'))
})

test('modelsFromJoin normalises both join shapes and drops junk', () => {
  assert.deepEqual(
    modelsFromJoin({ dsh: { models: [{ id: 'a', contextWindow: 1000 }, { id: 'a' }, { id: '' }] } }),
    [{ id: 'a', contextWindow: 1000 }],
    'duplicates and empty ids are dropped, first window wins',
  )
  assert.deepEqual(
    modelsFromJoin({ models: [{ model_id: 'b', context_window: 2000 }] }),
    [{ id: 'b', contextWindow: 2000 }],
    'the generic onboarding shape is accepted too',
  )
  assert.deepEqual(modelsFromJoin({}), [])
  assert.deepEqual(modelsFromJoin({ models: [{ model_id: 'c', context_window: 0 }] }), [{ id: 'c' }])
})

test('joinStationWith produces the provider configuration from a live station', async () => {
  const station = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      const sent = JSON.parse(body)
      // Assert the station-side contract from the wire, not from our own code.
      assert.equal(sent.plugin, PLUGIN_ID)
      // Compare against the exported constant rather than a literal: a hardcoded
      // version here only breaks on every release and proves nothing extra.
      assert.equal(sent.plugin_version, PLUGIN_VERSION)
      assert.equal(sent.ticket, 'rhe_ticket')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          protocol: 'toip',
          version: 1,
          station: { id: 'rst_live' },
          session: { token: 'rht_live', rotated: false },
          dsh: {
            provider: 'relayhub',
            baseURL: 'http://station/v1',
            apiKey: 'rht_live',
            models: [{ id: 'deepseek-v4-pro', contextWindow: 1000000 }],
          },
        }),
      )
    })
  })
  await new Promise((r) => station.listen(0, '127.0.0.1', r))
  const { port } = station.address()
  try {
    const joined = await joinStationWith({
      stationURL: `127.0.0.1:${port}`,
      ticket: 'rhe_ticket',
      name: 'laptop',
    })
    assert.equal(joined.root, `http://127.0.0.1:${port}`)
    // The station told us /v1; we must pass it through untouched.
    assert.equal(joined.baseURL, 'http://station/v1')
    assert.equal(joined.apiKey, 'rht_live')
    assert.equal(joined.stationID, 'rst_live')
    assert.deepEqual(joined.models, [{ id: 'deepseek-v4-pro', contextWindow: 1000000 }])
  } finally {
    await new Promise((r) => station.close(r))
  }
})

test('joinStationWith refuses a request with no credential at all', async () => {
  await assert.rejects(
    () => joinStationWith({ stationURL: 'http://127.0.0.1:9' }),
    /dynamic code or an enrollment ticket/,
  )
})
