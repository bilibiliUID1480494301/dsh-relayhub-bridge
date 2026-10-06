/**
 * Anthropic Messages SSE -> harness `StreamChunk` projection.
 *
 * The harness contract (`@deepseek-ai/dsh-llm` StreamChunk) is a flat indexed
 * block protocol: every block opens with `block-start`, is fed deltas, and
 * closes with `block-end` carrying the assembled block. Indices are allocated
 * in arrival order — which is what reasoning-then-text already is on this wire.
 *
 * Token accounting follows the harness's disjoint-count rule: `inputTokens`
 * is uncached input only, so `message_start`'s total has its cache reads
 * subtracted back out.
 *
 * Ported from the same author's `dsh-our-free-model` (MIT), claude lane,
 * minus the fingerprint rename pass (relay-hub runs no tool-name decoys).
 *
 * @module lib/stream.js
 */

import crypto from 'node:crypto'

/** Mint a tool-call id for blocks that stream arguments before an id arrives. */
function mintToolCallId() {
  return `call_${crypto.randomBytes(12).toString('hex')}`
}

/** DeepSeek v4-family models occasionally leak internal DSML control markup
 * into the visible content at the reasoning→action boundary (observed live
 * 2026-10-04 on the free lane: `\n\n<｜DSML｜ calls>\n` streamed as content
 * right before a legitimate tool call). relay-hub proxies DeepSeek-family
 * models, so the scrubber travels with the projection. */
const DSML_OPENING = '<｜DSML｜'
const DSML_TAG = /<｜DSML｜[^>]*>/g

function createDsmlScrubber() {
  let held = ''
  return {
    push(delta) {
      let text = held + delta
      held = ''
      const cut = text.lastIndexOf('<')
      if (cut !== -1) {
        const tail = text.slice(cut)
        if (DSML_OPENING.startsWith(tail) || (tail.startsWith(DSML_OPENING) && !tail.includes('>'))) {
          held = tail
          text = text.slice(0, cut)
        }
      }
      return text.replace(DSML_TAG, '')
    },
    flush() {
      const out = held
      held = ''
      if (out === '' || DSML_OPENING.startsWith(out) || (out.startsWith(DSML_OPENING) && !out.includes('>'))) return ''
      return out.replace(DSML_TAG, '')
    },
  }
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

class BlockSink {
  constructor(yieldChunk) {
    this.emit = yieldChunk
    this.next = 0
    /** @type {Map<string, {index:number, kind:string, text:string, id?:string, name?:string, args?:string}>} */
    this.open = new Map()
    this.sawReasoning = false
    this.sawText = false
    this.sawToolCall = false
    this.reasoningText = ''
    this.brokenToolCall = false
    this.lastToolKey = 'b0'
    this.dsml = createDsmlScrubber()
  }

  slot(key, kind) {
    if (kind === 'tool-call') this.sawToolCall = true
    const existing = this.open.get(key)
    if (existing !== undefined) return existing
    // A tool call without a provider id would come back next turn with an
    // empty toolCallId, which the pairing repair drops on both sides — the
    // model never sees its own result and re-issues the call forever.
    const block = { index: this.next++, kind, text: '', args: '', id: kind === 'tool-call' ? mintToolCallId() : '', name: '' }
    this.open.set(key, block)
    this.emit({ type: 'block-start', index: block.index, blockType: kind === 'reasoning' ? 'reasoning' : kind === 'tool-call' ? 'tool-call' : 'text' })
    return block
  }

  text(key, delta) {
    if (delta === undefined || delta === null || delta === '') return
    const scrubbed = this.dsml.push(delta)
    if (scrubbed === '') return
    this.sawText = true
    const block = this.slot(key, 'text')
    block.text += scrubbed
    this.emit({ type: 'text-delta', index: block.index, text: scrubbed })
  }

  reasoning(key, delta) {
    if (delta === undefined || delta === null || delta === '') return
    this.sawReasoning = true
    const text = String(delta)
    this.reasoningText += text
    const block = this.slot(key, 'reasoning')
    block.text += text
    this.emit({ type: 'reasoning-delta', index: block.index, text })
  }

  toolStart(key, id, name) {
    const block = this.slot(key, 'tool-call')
    if (id) block.id = id
    if (name) block.name = name
  }

  toolArgs(key, delta) {
    this.sawToolCall = true
    if (!delta) return
    const block = this.slot(key, 'tool-call')
    block.args += delta
    // Arguments can arrive before the wire has named the call. The harness
    // re-reads every chunk through a lossless-JSON snapshot, which rejects an
    // own `undefined` field outright — an unknown name is omitted, never sent
    // as undefined.
    const name = typeof block.name === 'string' && block.name !== '' ? { name: block.name } : {}
    this.emit({ type: 'tool-call-delta', index: block.index, id: block.id ?? '', ...name, argumentsDelta: delta })
  }

  closeAll() {
    const spill = this.dsml.flush()
    let spilled = false
    for (const block of this.open.values()) {
      if (block.kind === 'text' && !spilled && spill !== '') {
        spilled = true
        block.text += spill
        this.emit({ type: 'text-delta', index: block.index, text: spill })
      }
      if (block.kind === 'text' && block.text !== '') {
        this.emit({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } })
      } else if (block.kind === 'reasoning' && block.text !== '') {
        this.emit({ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } })
      } else if (block.kind === 'tool-call') {
        // Arguments that never parse are an unexecutable call. The upstream
        // reports finish "tool_calls" even when the output ceiling cut the
        // JSON mid-string, so the finish token alone cannot be trusted; the
        // adapter downgrades such a turn to max-tokens, which makes the
        // harness's assembler prune the call instead of executing it and
        // looping on the model's retry.
        try { JSON.parse(block.args === '' ? '{}' : block.args) } catch { this.brokenToolCall = true }
        this.emit({
          type: 'block-end',
          index: block.index,
          block: { type: 'tool-call', id: block.id ?? '', name: block.name ?? '', arguments: block.args === '' ? '{}' : block.args },
        })
      }
    }
    this.open.clear()
  }
}

/** Anthropic Messages usage -> the harness's disjoint TokenUsage. */
export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const prompt = number(usage.input_tokens)
  const completion = number(usage.output_tokens)
  const cached = number(usage.cache_read_input_tokens) ?? 0
  const cacheWrite = number(usage.cache_creation_input_tokens)
  if (prompt === undefined && completion === undefined) return undefined
  const out = { inputTokens: Math.max(0, (prompt ?? 0) - cached), outputTokens: completion ?? 0 }
  if (cached > 0) out.cacheReadTokens = cached
  if (cacheWrite > 0) out.cacheWriteTokens = cacheWrite
  out.totalTokens = (prompt ?? 0) + (completion ?? 0)
  return out
}

/** Map a provider finish token onto the harness finish reason. */
export function finishReason(token) {
  if (token === 'tool_use' || token === 'tool_calls') return { kind: 'tool-calls' }
  if (token === 'max_tokens' || token === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/** Consume one parsed Anthropic Messages SSE event. */
function feedClaude(sink, event, onFinish) {
  if (event.type === 'content_block_start') {
    const block = event.content_block
    if (block?.type === 'tool_use') sink.toolStart(`b${event.index}`, block.id ?? '', block.name ?? '')
    return
  }
  if (event.type === 'content_block_delta') {
    const part = event.delta
    if (part?.type === 'text_delta') sink.text(`b${event.index}`, part.text)
    else if (part?.type === 'thinking_delta') sink.reasoning(`b${event.index}`, part.thinking)
    else if (part?.type === 'input_json_delta') sink.toolArgs(`b${event.index}`, part.partial_json)
    return
  }
  // A station that ignored `stream:true` answers with one complete message
  // object instead of the event sequence. Project it exactly as if it had
  // streamed — blocks, usage, stop_reason — so the JSON fallback lane in
  // turn.js yields a working turn instead of a mysterious empty failure.
  if (event.type === 'message' && Array.isArray(event.content)) {
    for (let i = 0; i < event.content.length; i++) {
      const block = event.content[i]
      if (block?.type === 'text') sink.text(`c${i}`, block.text)
      else if (block?.type === 'thinking') sink.reasoning(`c${i}`, block.thinking)
      else if (block?.type === 'tool_use') {
        sink.toolStart(`c${i}`, block.id ?? '', block.name ?? '')
        sink.toolArgs(`c${i}`, JSON.stringify(block.input ?? {}))
      }
    }
    if (event.usage) {
      const mapped = mapUsage(event.usage)
      if (mapped) onFinish(mapped, 'usage')
    }
    onFinish(undefined, 'finish', event.stop_reason)
    onFinish(undefined, 'finish', undefined)
    return
  }
  if (event.type === 'message_start') {
    const usage = event.message?.usage
    if (usage) {
      const mapped = mapUsage(usage)
      if (mapped) onFinish(mapped, 'usage')
    }
    return
  }
  if (event.type === 'message_delta') {
    const usage = event.usage
    if (usage && number(usage.output_tokens) !== undefined) {
      onFinish({ outputTokens: number(usage.output_tokens) }, 'usage')
    }
    const stop = event.delta?.stop_reason
    if (stop) onFinish(undefined, 'finish', stop)
    return
  }
  // `message_stop` is the wire's own end-of-turn frame. A stream that carried
  // it was closed on purpose, so it must not be read as a cut one even in the
  // rare case where the stop_reason frame was the one that went missing.
  if (event.type === 'message_stop') onFinish(undefined, 'finish', undefined)
}

/**
 * Read one streamed response: SSE `data:` payloads in, harness chunks out.
 *
 * @param {AsyncIterable<string>} lines - decoded `data:` payload strings.
 * @param {() => number} [now] - clock for the first-delivered-delta stamp.
 * @yields {object} harness StreamChunk
 * @returns {Promise<{usage: object, finish?: string, sawFinish: boolean, sawUsage: boolean,
 *   sawToolCall: boolean, sawReasoning: boolean, sawText: boolean, brokenToolCall: boolean,
 *   reasoningText: string}>}
 */
export async function * readClaudeStream(lines, now = () => Date.now()) {
  const outbox = []
  const sink = new BlockSink(chunk => outbox.push(chunk))
  const state = {
    usage: undefined, finish: undefined, sawFinish: false, sawUsage: false,
    sawToolCall: false, sawReasoning: false, sawText: false, brokenToolCall: false,
    firstDeltaAt: undefined,
  }
  const snapshot = () => ({
    ...state,
    reasoningText: sink.reasoningText,
    brokenToolCall: sink.brokenToolCall,
    usage: state.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  })
  const onFinish = (usage, kind, token) => {
    if (kind === 'usage' && usage !== undefined) {
      state.sawUsage = true
      const carried = state.usage
      // A usage report with no input side is `message_delta`: it carries only
      // the output count, and taking it whole dropped the prompt counts
      // `message_start` had already given for every turn.
      state.usage = carried !== undefined && usage.inputTokens === undefined
        ? {
            ...carried,
            ...usage,
            totalTokens: Math.max(0, (carried.totalTokens ?? 0) - (carried.outputTokens ?? 0)) + (usage.outputTokens ?? 0),
          }
        : usage
    }
    if (kind !== 'finish') return
    state.sawFinish = true
    // A terminal frame with no reason (`message_stop`) marks the end but must
    // not erase a finish token a status-carrying frame already gave.
    if (token !== undefined) state.finish = token
  }

  try {
    for await (const raw of lines) {
      if (typeof raw !== 'string') continue
      const text = raw.trim()
      if (!text.startsWith('{')) continue
      let payload
      try { payload = JSON.parse(text) } catch { continue }
      if (payload.type === 'error' || payload.error) {
        // An in-stream refusal is classified exactly like an error envelope,
        // because everything downstream decides off `code`.
        const failure = payload.error ?? payload
        const error = new Error(typeof failure.message === 'string' ? failure.message : 'station error')
        error.code = classify(failure, undefined)
        error.upstream = payload
        throw error
      }
      if (state.firstDeltaAt === undefined
        && (payload.type === 'content_block_delta' || payload.type === 'content_block_start')) {
        state.firstDeltaAt = now()
      }
      feedClaude(sink, payload, onFinish)
      if (sink.sawReasoning) state.sawReasoning = true
      if (sink.sawText) state.sawText = true
      if (sink.sawToolCall) state.sawToolCall = true
      if (sink.brokenToolCall) state.brokenToolCall = true
      while (outbox.length > 0) yield outbox.shift()
    }
    sink.closeAll()
    if (sink.brokenToolCall) state.brokenToolCall = true
    while (outbox.length > 0) yield outbox.shift()
    return snapshot()
  } catch (error) {
    throw error
  }
}

/** Failure codes in the harness's vocabulary. */
export const CODE = {
  credential: 'INVALID_CREDENTIAL',
  quota: 'RATE_LIMIT',
  client: 'CLIENT_ERROR',
  server: 'SERVER',
  transport: 'TRANSPORT',
  timeout: 'TIMEOUT',
  empty: 'EMPTY_RESPONSE',
  aborted: 'ABORTED',
}

/** Classify a station failure (error envelope or HTTP status) into a code. */
export function classify(error, status) {
  const type = typeof error?.type === 'string' ? error.type : ''
  const flat = String(error?.message ?? '').toLowerCase()
  if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error') {
    return CODE.credential
  }
  if (status === 429 || type === 'rate_limit_error' || /rate limit|usage limit/.test(flat)) {
    return CODE.quota
  }
  if (type === 'not_found_error' || type === 'invalid_request_error') return CODE.client
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) return CODE.client
  return CODE.server
}
