/**
 * One streamed turn against the station: `POST {baseURL}/messages`, SSE in,
 * `data:` payload strings out.
 *
 * The adapter owns the HTTP because that is the adapter contract: the host
 * calls `prepareCall` and consumes the stream the adapter returns. Error
 * envelopes (HTTP status or in-stream `error` events) are classified into the
 * harness failure vocabulary by {@link module:lib/stream.js}.
 *
 * @module lib/turn.js
 */

import { CODE } from './stream.js'

export class UpstreamError extends Error {
  /**
   * @param {string} message - user-facing text.
   * @param {string} code - harness failure code.
   * @param {{status?: number, retryAfterMs?: number}} [detail]
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    if (Number.isInteger(detail.status)) this.status = detail.status
    if (Number.isFinite(detail.retryAfterMs) && detail.retryAfterMs > 0) {
      this.providerRetryAfterMs = Math.trunc(detail.retryAfterMs)
    }
  }
}

/** SSE `data:` lines from a fetch Response body (or a plain JSON body). */
async function * sseLines(response, signal) {
  const contentType = String(response.headers?.get?.('content-type') ?? '')
  if (!contentType.includes('text/event-stream')) {
    // A station that ignores `stream:true` answers with one complete JSON
    // message — feed it once and let the projection treat it as the whole turn.
    const text = await response.text()
    yield text
    return
  }
  const reader = response.body?.getReader?.()
  if (!reader) throw new UpstreamError('relay-hub station returned no body', CODE.empty)
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw new UpstreamError('request aborted', CODE.aborted)
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) yield line.slice(5).trimStart()
        newline = buffer.indexOf('\n')
      }
    }
    const tail = buffer.replace(/\r$/, '')
    if (tail.startsWith('data:')) yield tail.slice(5).trimStart()
  } finally {
    reader.cancel?.().catch?.(() => {})
  }
}

/**
 * POST one Messages request and push every SSE payload to `onData`.
 *
 * @param {object} input
 * @param {string} input.url - absolute endpoint (baseURL already carries /v1).
 * @param {Record<string, string>} input.headers - auth + identity headers.
 * @param {object} input.body - the Messages request body.
 * @param {AbortSignal} [input.signal] - caller's abort signal.
 * @param {(payload: string) => void} input.onData - raw `data:` payloads.
 * @returns {Promise<void>} resolves when the body is fully consumed.
 */
export async function postMessages({ url, headers, body, signal, onData }) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    })
  } catch (error) {
    // The signal's own reason is what fetch rejects with; testing the name
    // alone mis-reports a cancelled turn as TRANSPORT (retryable).
    if (signal?.aborted === true || error?.name === 'AbortError') {
      throw new UpstreamError('request aborted', CODE.aborted)
    }
    throw new UpstreamError(`relay-hub: station request failed: ${error?.message ?? error}`, CODE.transport)
  }

  const retryAfterMs = Number(response.headers?.get?.('retry-after')) * 1000
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 300) || `HTTP ${response.status}` } } }
    const failure = payload?.error ?? payload ?? {}
    // hubrelay answers some 4xx with its own envelope shape (`{ok:false,
    // error:"<text>"}`) where Anthropic bodies use `{error:{message}}` — the
    // key-rotation signal ("key_id 不匹配…") travels in that string, so accept
    // both spellings.
    const messageText = typeof failure?.message === 'string' && failure.message !== ''
      ? failure.message
      : typeof failure === 'string' && failure !== '' ? failure : ''
    throw new UpstreamError(
      messageText !== '' ? messageText : `station HTTP ${response.status}`,
      classifyStatus(response.status, failure),
      { status: response.status, retryAfterMs },
    )
  }
  for await (const payload of sseLines(response, signal)) onData(payload)
}

function classifyStatus(status, failure) {
  const type = typeof failure?.type === 'string' ? failure.type : ''
  if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error') return CODE.credential
  if (status === 429 || type === 'rate_limit_error') return CODE.quota
  if (status >= 400 && status < 500 && status !== 408) return CODE.client
  return CODE.server
}
