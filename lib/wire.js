/**
 * Harness message vocabulary -> Anthropic Messages wire (`/v1/messages`).
 *
 * Projection ported from the same author's `dsh-our-free-model` (MIT), claude
 * lane only — relay-hub's station answers `/v1/messages` natively, so the
 * bridge speaks exactly one wire and lets the station do any upstream
 * translation. Deliberately text-only: the adapter declares
 * `inputModalities: ['text']`, and image blocks are dropped with a warning
 * instead of being half-supported.
 *
 * @module lib/wire.js
 */

/** Text of a content block list, joining every text-bearing block. */
function textOf(blocks) {
  const parts = []
  for (const block of blocks ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Normalise a message's content into a block list. The harness always supplies
 * blocks, but a bare string is accepted the way the kernel's own Messages
 * adapter tolerates one.
 */
function blocksOf(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return { type: 'text', text: part }
        if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') {
          return { type: 'text', text: String(part.text ?? '') }
        }
        return part
      })
      .filter(block => block !== null && typeof block === 'object')
  }
  return []
}

/** The tool results one message carries, in whichever vocabulary the kernel wrote it. */
function toolResultsOf(message) {
  if (message?.role === 'tool') {
    const id = String(message?.toolCallId ?? message?.source?.callId ?? '')
    return id === ''
      ? []
      : [{ callId: id, content: blocksOf(message.content), isError: message.isError === true }]
  }
  const out = []
  for (const block of blocksOf(message?.content)) {
    if (block?.type !== 'tool-result') continue
    const id = String(block.toolCallId ?? message?.source?.callId ?? '')
    if (id === '') continue
    out.push({ callId: id, content: blocksOf(block.content), isError: block.isError === true })
  }
  return out
}

/**
 * Drop tool calls that were never answered, and answers with no call.
 *
 * Every supported wire enforces that a tool call is followed by its result,
 * and a turn interrupted between the two leaves exactly that in the durable
 * history. Replaying it is not merely untidy: the Messages wire answers
 * `400 invalid_request_error`, which then fails every later turn in that
 * session, not just the one that broke.
 */
export function repairToolPairing(messages) {
  const list = messages ?? []
  const answered = new Set()
  for (const message of list) {
    for (const result of toolResultsOf(message)) answered.add(result.callId)
  }

  const keptCalls = new Set()
  const out = []
  for (const message of list) {
    const results = toolResultsOf(message)
    if (results.length > 0) {
      if (message.role === 'tool') {
        if (keptCalls.has(results[0].callId)) out.push(message)
        continue
      }
      const kept = new Set(
        results.filter(result => keptCalls.has(result.callId)).map(result => result.callId),
      )
      const blocks = blocksOf(message.content)
      const rest = blocks.filter(
        block => block?.type !== 'tool-result'
          || kept.has(String(block.toolCallId ?? message.source?.callId ?? '')),
      )
      if (rest.length === blocks.length) out.push(message)
      else if (rest.length > 0) out.push({ ...message, content: rest })
      continue
    }
    if (message?.role === 'tool') continue
    if (message?.role !== 'assistant') {
      out.push(message)
      continue
    }
    const blocks = blocksOf(message.content)
    const toolBlocks = blocks.filter(block => block?.type === 'tool-call')
    const calls = toolBlocks.filter(block => answered.has(String(block.id ?? '')))
    for (const call of calls) keptCalls.add(String(call.id))
    if (calls.length === toolBlocks.length) {
      if (calls.length > 0 || blocks.some(block => block?.type === 'text' && block.text)) out.push(message)
      continue
    }
    if (calls.length === 0) {
      if (blocks.some(block => block?.type === 'text' && block.text)) {
        out.push({ ...message, content: blocks.filter(block => block?.type !== 'tool-call') })
      }
      continue
    }
    out.push({ ...message, content: blocks.filter(block => block?.type !== 'tool-call' || calls.includes(block)) })
  }

  return out
}

/**
 * Project harness messages onto `{ system?, messages }` for the Messages wire.
 *
 * One turn per role, merged: consecutive same-role turns are the shape the
 * `messages` wire rejects, and both a V4 `tool` answer and a pre-V4
 * `tool-result` wrapper land as user turns here.
 *
 * @param {object[]} messages - harness history.
 * @param {string[]} warnings - accumulator for dropped-content notices.
 * @returns {{system?: string, messages: object[]}}
 */
export function toClaudeMessages(messages, warnings) {
  const out = []
  let systemText = ''
  const push = (role, blocks) => {
    const previous = out[out.length - 1]
    if (previous?.role === role) previous.content.push(...blocks)
    else out.push({ role, content: [...blocks] })
  }
  for (const message of messages ?? []) {
    const results = toolResultsOf(message)
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(blocksOf(message.content))
      if (text) systemText = systemText ? `${systemText}\n\n${text}` : text
      continue
    }
    if (results.length > 0) {
      const lead = []
      for (const result of results) {
        const inner = []
        for (const block of result.content) {
          if (block?.type === 'text' && block.text) inner.push({ type: 'text', text: block.text })
          else if (block?.type === 'image') warnings.push('image-dropped')
        }
        lead.push({
          type: 'tool_result',
          tool_use_id: result.callId,
          content: inner.length > 0 ? inner : [{ type: 'text', text: '(no output)' }],
          is_error: result.isError,
        })
      }
      push('user', lead)
      // A V4 tool message's content *is* the result, and all of it just went
      // out inside `tool_result` — falling through would append it twice.
      if (message.role === 'tool') continue
    }
    const blocks = blocksOf(message.content).filter(block => block?.type !== 'tool-result')
    const content = []
    for (const block of blocks) {
      if (block?.type === 'text' && block.text) content.push({ type: 'text', text: block.text })
      else if (block?.type === 'tool-call') {
        let input = {}
        try { input = JSON.parse(block.arguments || '{}') } catch { input = {} }
        content.push({ type: 'tool_use', id: String(block.id ?? ''), name: String(block.name ?? ''), input })
      } else if (block?.type === 'image') warnings.push('image-dropped')
    }
    if (content.length === 0) continue
    push(message.role === 'assistant' ? 'assistant' : 'user', content)
  }
  return { system: systemText || undefined, messages: out }
}

/**
 * Harness tool schemas -> Anthropic `tools` defs.
 *
 * Both spellings work: flat `{name, description, parameters}` (the harness)
 * and OpenAI-style `{type:'function', function:{…}}` (anything re-fed from an
 * OpenAI caller).
 */
export function toToolDefs(tools) {
  const list = []
  for (const tool of tools ?? []) {
    const source = tool && typeof tool.function === 'object' && tool.function !== null && !Array.isArray(tool.function)
      ? tool.function
      : tool
    const name = String(source?.name ?? '').trim()
    if (!name) continue
    const parameters = source.parameters && typeof source.parameters === 'object' && !Array.isArray(source.parameters)
      ? source.parameters
      : { type: 'object', properties: {} }
    list.push({
      name,
      description: typeof source.description === 'string' ? source.description : '',
      input_schema: parameters,
    })
  }
  return list
}

/**
 * Build the `POST /v1/messages` body for one turn.
 *
 * @param {string} modelId - exact model id on the station.
 * @param {object} options - harness GenerateOptions.
 * @param {string[]} warnings - dropped-content accumulator.
 * @returns {object} request body (stream always true).
 */
export function buildMessagesPayload(modelId, options, warnings) {
  const messages = repairToolPairing(options.messages ?? [])
  const shaped = toClaudeMessages(messages, warnings)
  const payload = {
    model: modelId,
    messages: shaped.messages,
    stream: true,
    max_tokens: Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : 4096,
  }
  if (shaped.system !== undefined) payload.system = shaped.system
  const tools = toToolDefs(options.tools)
  if (tools.length > 0) payload.tools = tools
  if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) {
    payload.temperature = options.temperature
  }
  if (Array.isArray(options.stop) && options.stop.length > 0) payload.stop_sequences = options.stop
  return payload
}
