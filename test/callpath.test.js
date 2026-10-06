/**
 * Call-path tests: the adapter's generation turn, end to end, against a local
 * SSE fixture station.
 *
 * These exercise the full chain — buildMessagesPayload -> postMessages ->
 * readClaudeStream -> StreamChunk sequence -> finish mapping — over a real
 * HTTP socket, because the failure modes that matter (abort mid-stream, a
 * station that ends the body early, a station that ignores stream:true) only
 * exist at that layer.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { PROVIDER, apply } from '../lib/index.js'

/** SSE frames from event objects. */
const sse = (...events) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')

const messageStart = (usage = { input_tokens: 100, cache_read_input_tokens: 20 }) => ({
  type: 'message_start',
  message: { usage },
})
const blockStart = (index, block) => ({ type: 'content_block_start', index, content_block: block })
const textDelta = (index, text) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
const thinkDelta = (index, thinking) => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } })
const jsonDelta = (index, partialJson) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partialJson } })
const messageDelta = (stopReason, usage) => ({ type: 'message_delta', delta: { stop_reason: stopReason }, usage })
const messageStop = { type: 'message_stop' }

/**
 * A fixture station. `behavior(req, res, body)` decides the reply; `calls`
 * records every parsed request body the adapter sent.
 */
async function startStation(behavior) {
  const calls = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* the adapter always sends JSON */ }
      calls.push(body)
      behavior(req, res, body)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => {
      // fetch keeps sockets alive; without this the close callback stalls.
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

/** Build a configured adapter wired to `stationURL`; warnings are recorded. */
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

/** Drain an adapter stream into an array. */
async function collect(iterator) {
  const chunks = []
  for await (const chunk of iterator) chunks.push(chunk)
  return chunks
}

const userTurn = messages => ({
  model: 'test-model',
  messages: messages ?? [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})

test('a plain text turn projects the exact chunk sequence and usage merge', async () => {
  const station = await startStation((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(
      messageStart(),
      blockStart(0, { type: 'text' }),
      textDelta(0, 'Hello'),
      messageDelta('end_turn', { output_tokens: 5 }),
      messageStop,
    ))
  })
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      // cache_read 20 comes back OUT of the input count (disjoint-count rule),
      // and message_delta's output-only usage merges without erasing it.
      // totalTokens keeps the wire's own semantics: prompt(100) + output(5).
      { type: 'usage', usage: { inputTokens: 80, outputTokens: 5, cacheReadTokens: 20, totalTokens: 105 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    assert.equal(station.calls.length, 1)
    assert.equal(station.calls[0].model, 'test-model')
    assert.equal(station.calls[0].stream, true)
    assert.equal(station.calls[0].max_tokens, 4096, 'max_tokens defaults to 4096 when the harness omits it')
  } finally {
    await station.close()
  }
})

test('a tool-call turn finishes with kind tool-calls, not a stream-cut error', async () => {
  // 回归：0.2.0 初稿的收尾校验只认 stop/end_turn/stop_sequence，把合法的
  // tool_use 收尾误判成 STREAM_CUT——工具调用轮会全军覆没。
  const station = await startStation((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(
      messageStart({ input_tokens: 50 }),
      blockStart(0, { type: 'tool_use', id: 'toolu_1', name: 'get_weather' }),
      jsonDelta(0, '{"city":'),
      jsonDelta(0, '"Beijing"}'),
      messageDelta('tool_use', { output_tokens: 20 }),
      messageStop,
    ))
  })
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'toolu_1', name: 'get_weather', argumentsDelta: '{"city":' },
      { type: 'tool-call-delta', index: 0, id: 'toolu_1', name: 'get_weather', argumentsDelta: '"Beijing"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'toolu_1', name: 'get_weather', arguments: '{"city":"Beijing"}' } },
      { type: 'usage', usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  } finally {
    await station.close()
  }
})

test('a thinking turn yields reasoning blocks', async () => {
  const station = await startStation((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(
      messageStart({ input_tokens: 30 }),
      blockStart(0, { type: 'thinking' }),
      thinkDelta(0, 'Let me think'),
      messageDelta('end_turn', { output_tokens: 9 }),
      messageStop,
    ))
  })
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Let me think' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Let me think' } },
      { type: 'usage', usage: { inputTokens: 30, outputTokens: 9, totalTokens: 39 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  } finally {
    await station.close()
  }
})

test('an HTTP 401 error envelope maps to an INVALID_CREDENTIAL finish', async () => {
  const station = await startStation((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad token' } }))
  })
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.deepEqual(chunks, [
      { type: 'finish', reason: { kind: 'error', failure: { message: 'bad token', code: 'INVALID_CREDENTIAL', status: 401 } } },
    ])
  } finally {
    await station.close()
  }
})

test('an in-stream error event maps onto the same classification', async () => {
  const station = await startStation((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }))
  })
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.deepEqual(chunks, [
      { type: 'finish', reason: { kind: 'error', failure: { message: 'slow down', code: 'RATE_LIMIT' } } },
    ])
  } finally {
    await station.close()
  }
})

test('a station that ignored stream:true still yields a working turn', async () => {
  const station = await startStation((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text: 'Hi there' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 3 },
    }))
  })
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hi there' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hi there' } },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  } finally {
    await station.close()
  }
})

test('a stream cut before the finish token maps to STREAM_CUT', async () => {
  const station = await startStation((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(
      messageStart({ input_tokens: 10 }),
      blockStart(0, { type: 'text' }),
      textDelta(0, 'partial'),
    ))
  })
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
    const finish = chunks[chunks.length - 1]
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'STREAM_CUT')
    assert.match(finish.reason.failure.message, /closed the stream/)
  } finally {
    await station.close()
  }
})

test('an empty stop turn maps to EMPTY_RESPONSE', async () => {
  const station = await startStation((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(
      messageStart({ input_tokens: 10 }),
      messageDelta('end_turn', { output_tokens: 0 }),
      messageStop,
    ))
  })
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.deepEqual(chunks, [
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 } },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'relay-hub: the station returned an empty response', code: 'EMPTY_RESPONSE' } } },
    ])
  } finally {
    await station.close()
  }
})

test('an explicit failed status maps to a SERVER error', async () => {
  const station = await startStation((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(
      messageStart({ input_tokens: 5 }),
      messageDelta('failed', { output_tokens: 0 }),
      messageStop,
    ))
  })
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    const finish = chunks[chunks.length - 1]
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'SERVER')
    assert.match(finish.reason.failure.message, /status failed/)
  } finally {
    await station.close()
  }
})

test('tool arguments that never parse are downgraded to max-tokens', async () => {
  const station = await startStation((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(
      messageStart({ input_tokens: 10 }),
      blockStart(0, { type: 'tool_use', id: 'toolu_9', name: 'get_weather' }),
      jsonDelta(0, '{"city":'),
      messageDelta('tool_use', { output_tokens: 40 }),
      messageStop,
    ))
  })
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    // Downgraded, not errored: the harness prunes the call instead of looping.
    assert.deepEqual(chunks[chunks.length - 1], { type: 'finish', reason: { kind: 'max-tokens' } })
    const end = chunks.find(chunk => chunk.type === 'block-end')
    assert.equal(end.block.arguments, '{"city":')
  } finally {
    await station.close()
  }
})

test('aborting mid-stream surfaces an aborted finish', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const station = await startStation((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse(messageStart({ input_tokens: 10 }), blockStart(0, { type: 'text' }), textDelta(0, 'first')))
    req.on('close', release)
    gate.then(() => { try { res.end() } catch { /* socket already gone */ } })
  })
  const { adapter } = adapterFor(station.url)
  try {
    const controller = new AbortController()
    const chunks = []
    for await (const chunk of adapter.stream({ ...userTurn(), signal: controller.signal })) {
      chunks.push(chunk)
      if (chunk.type === 'text-delta') controller.abort()
      // No break: breaking calls iterator.return(), which discards the turn —
      // a consumer that keeps reading must see the aborted finish.
    }
    const finish = chunks[chunks.length - 1]
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'aborted')
    assert.equal(finish.reason.failure.code, 'ABORTED')
  } finally {
    release()
    await station.close()
  }
})

test('prepareCall binds model metadata and returns the dispatch closure', async () => {
  const station = await startStation((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(
      messageStart({ input_tokens: 5 }),
      textDelta(0, 'ok'),
      messageDelta('end_turn', { output_tokens: 1 }),
      messageStop,
    ))
  })
  const { adapter } = adapterFor(station.url)
  try {
    const call = await adapter.prepareCall(PROVIDER, 'test-model')
    assert.equal(call.model.provider, PROVIDER)
    assert.equal(call.model.id, 'test-model')
    assert.equal(call.model.context.contextWindow, 8192)
    assert.equal(typeof call.stream, 'function')
    const chunks = await collect(call.stream(userTurn()))
    assert.equal(chunks[chunks.length - 1].reason.kind, 'stop')
  } finally {
    await station.close()
  }
})

test('resolveModel falls back conservatively for unknown ids', async () => {
  const { adapter } = adapterFor('http://127.0.0.1:9') // never reached
  const known = await adapter.resolveModel(PROVIDER, 'test-model')
  assert.equal(known.context.contextWindow, 8192)
  assert.equal(known.defaultMaxTokens, 8192)
  assert.deepEqual(known.inputModalities, ['text'])
  const unknown = await adapter.resolveModel(PROVIDER, 'never-seen')
  assert.equal(unknown.id, 'never-seen')
  assert.equal(unknown.context.contextWindow, 131072)
})

test('the outgoing body translates system, tools, and tool results', async () => {
  const station = await startStation((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(
      messageStart({ input_tokens: 5 }),
      textDelta(0, 'ok'),
      messageDelta('end_turn', { output_tokens: 1 }),
      messageStop,
    ))
  })
  const { adapter } = adapterFor(station.url)
  try {
    await collect(adapter.stream({
      model: 'test-model',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
        { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'toolu_1', name: 'get_weather', arguments: '{"city":"Beijing"}' }] },
        { role: 'tool', toolCallId: 'toolu_1', content: [{ type: 'text', text: '20C' }] },
      ],
      tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
      temperature: 0.3,
      stop: ['END'],
    }))
    const body = station.calls[0]
    assert.equal(body.system, 'be brief')
    assert.deepEqual(body.tools[0].input_schema, { type: 'object', properties: { city: { type: 'string' } } })
    assert.equal(body.temperature, 0.3)
    assert.deepEqual(body.stop_sequences, ['END'])
    assert.deepEqual(body.messages.map(message => message.role), ['user', 'assistant', 'user'])
    const resultTurn = body.messages[2]
    assert.equal(resultTurn.content[0].type, 'tool_result')
    assert.equal(resultTurn.content[0].tool_use_id, 'toolu_1')
    assert.equal(resultTurn.content[0].content[0].text, '20C')
  } finally {
    await station.close()
  }
})

test('a missing session token finishes with INVALID_CREDENTIAL without touching the network', async () => {
  const station = await startStation((req, res) => { res.destroy() })
  const { adapter } = adapterFor(station.url, { apiKey: '' })
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    assert.equal(station.calls.length, 0, 'no request may leave the machine without a token')
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'finish')
    assert.equal(chunks[0].reason.kind, 'error')
    assert.equal(chunks[0].reason.failure.code, 'INVALID_CREDENTIAL')
    assert.match(chunks[0].reason.failure.message, /no session token yet/)
  } finally {
    await station.close()
  }
})

test('dropped content is reported through the logger, never as an unknown chunk type', async () => {
  const station = await startStation((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(
      messageStart({ input_tokens: 5 }),
      textDelta(0, 'ok'),
      messageDelta('end_turn', { output_tokens: 1 }),
      messageStop,
    ))
  })
  const { adapter, warns } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn([
      { role: 'user', content: [
        { type: 'text', text: 'look:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
      ] },
    ])))
    assert.ok(chunks.every(chunk => chunk.type !== 'finish-warnings'), 'no invented chunk types may reach the kernel')
    assert.equal(chunks[chunks.length - 1].reason.kind, 'stop')
    assert.equal(warns.length, 1)
    assert.match(warns[0], /image-dropped/)
  } finally {
    await station.close()
  }
})

test('DSML control markup leaked into content is scrubbed in-stream', async () => {
  const station = await startStation((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(
      messageStart({ input_tokens: 5 }),
      textDelta(0, 'done\n\n<｜DSML｜ calls>\n'),
      textDelta(0, 'and <｜DSM'),
      textDelta(0, 'L｜ tail> gone'),
      messageDelta('end_turn', { output_tokens: 4 }),
      messageStop,
    ))
  })
  const { adapter } = adapterFor(station.url)
  try {
    const chunks = await collect(adapter.stream(userTurn()))
    const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
    assert.ok(!text.includes('DSML'), `DSML leak reached the kernel: ${text}`)
    const end = chunks.find(chunk => chunk.type === 'block-end')
    // Frame 2 holds an unterminated tag open across the delta boundary; the
    // scrubber must carry it and drop the whole tag once it completes.
    assert.equal(end.block.text, 'done\n\n\nand  gone')
  } finally {
    await station.close()
  }
})
