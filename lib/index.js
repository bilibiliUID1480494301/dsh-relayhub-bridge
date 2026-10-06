/**
 * dsh-relayhub-bridge — DeepSeek Harness plugin for relay-hub stations.
 *
 * What it does, in the order a user meets it:
 *
 * 1. **Joins a station.** The user supplies a station address (or lets LAN
 *    discovery find one) plus a TOIP dynamic code or enrollment ticket. The
 *    bridge exchanges it for a session token and the station's model list.
 * 2. **Becomes a provider.** It registers the `relayhub` provider route with
 *    `ctx.llm`, so the joined station shows up as a selectable set of models in
 *    Harness just like a first-party provider.
 * 3. **Tags its traffic.** Every outbound request carries `X-DSH-Plugin-Id`, so
 *    the station can keep a per-plugin log next to its global request log.
 *    That is what makes "how is this plugin behaving?" answerable on the
 *    station side without reading the raw API log.
 *
 * Design notes that are load-bearing:
 *
 * * **Community plugin, minimal imports.** Only `@deepseek-ai/cordis` and
 *   `@deepseek-ai/schemastery` are touched, and both are optional peers. The
 *   harness-internal helper `registerDeepSeekProvider` is deliberately NOT
 *   imported: it lives in a first-party package that a profile-installed plugin
 *   cannot resolve, and depending on internals is how plugins break on upgrade.
 * * **No credentials are logged.** The session token is a real credential; it
 *   goes into configuration, never into the client-side log or a console line.
 * * **The station is the authority on codes.** This plugin computes a code only
 *   to self-check; it never decides whether a code is valid.
 *
 * @module dsh-relayhub-bridge
 */

import Schema from '@deepseek-ai/schemastery'

import {
  PLUGIN_ID,
  PROTOCOL,
  PROTOCOL_VERSION,
  ToipError,
  classifyJoinFailure,
  fetchSession,
  fetchStation,
  identityHeaders,
  join as joinStation,
  normalizeRoot,
  providerBaseURL,
  secondsLeft,
  totp,
} from './protocol.js'
import { discover } from './discovery.js'
import { buildMessagesPayload } from './wire.js'
import { CODE, finishReason, readClaudeStream } from './stream.js'
import { postMessages, UpstreamError } from './turn.js'
import { ENVELOPE_CONTENT_TYPE, fetchE2EParams, sealEnvelope } from './e2e.js'

/** The provider route this plugin owns. */
export const PROVIDER = 'relayhub'

/** Plugin name as Cordis sees it. */
export const name = 'relayhub-bridge'

/**
 * Services this plugin needs. `llm` is the provider registry; `settings` is
 * optional and only used to persist a successful join.
 */
export const inject = ['llm']

/** Semantic version of this plugin, used in the identity header. */
export const PLUGIN_VERSION = '0.3.0'

/** Configuration schema, rendered by the Harness plugin settings page. */
export const Config = Schema.object({
  /** Station HTTP root, e.g. `http://192.168.1.10:8799`. */
  stationURL: Schema.string().default(''),
  /**
   * Session token issued by the station. Written by a successful join; may also
   * be pasted by hand. Marked `secret` so the settings UI renders it write-only
   * and never echoes it back over the wire.
   */
  apiKey: Schema.string().role('secret').default(''),
  /** Station id, recorded for the identity header. */
  stationID: Schema.string().default(''),
  /** Advertised models; each entry is `{ id, contextWindow }`. */
  models: Schema.array(
    Schema.object({
      id: Schema.string().required(),
      contextWindow: Schema.number(),
    }),
  ).default([]),
  /** Headers added to every upstream request (advanced escape hatch). */
  extraHeaders: Schema.dict(Schema.string()).default({}),
  /**
   * E2E envelope mode for the Messages lane. 'auto' (default) seals every
   * request when the station serves /v1/e2e/params; 'off' never seals;
   * 'require' refuses to send plaintext when the station offers no envelope.
   * Sealing is pure node:crypto on this side, zero new dependencies.
   */
  e2e: Schema.string().default('auto'),
})

/**
 * Models advertised by a station payload.
 *
 * @param {object} payload - a TOIP join response.
 * @returns {{id: string, contextWindow?: number}[]} normalised model entries.
 */
export function modelsFromJoin(payload) {
  const entries = payload?.dsh?.models ?? payload?.models ?? []
  const out = []
  const seen = new Set()
  for (const entry of entries) {
    const id = String(entry?.id ?? entry?.model_id ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const window = Number(entry?.contextWindow ?? entry?.context_window)
    out.push(Number.isFinite(window) && window > 0 ? { id, contextWindow: window } : { id })
  }
  return out
}

/**
 * Join a station and produce the configuration patch that completes the bridge.
 *
 * Exported separately from {@link apply} so it can be driven from a test, a
 * script, or a future command surface without booting a Cordis context.
 *
 * @param {object} input - what the user supplied.
 * @param {string} input.stationURL - station address, in any pasted shape.
 * @param {string} [input.code] - current TOIP dynamic code.
 * @param {string} [input.ticket] - enrollment ticket (first contact).
 * @param {string} [input.name] - device name to show in the station's token list.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<object>} `{ root, baseURL, apiKey, stationID, models, session, raw }`.
 */
export async function joinStationWith(input, options = {}) {
  const root = normalizeRoot(input?.stationURL)
  if (!input?.code && !input?.ticket) {
    throw new ToipError('supply either a dynamic code or an enrollment ticket')
  }
  const payload = await joinStation(
    root,
    { code: input.code, ticket: input.ticket, name: input.name },
    { pluginId: PLUGIN_ID, pluginVersion: PLUGIN_VERSION, timeoutMs: options.timeoutMs },
  )
  return {
    root,
    // Provider baseURL must carry /v1: the Messages adapter appends it only when
    // the path lacks it.
    baseURL: payload?.dsh?.baseURL ?? providerBaseURL(root),
    apiKey: payload?.session?.token ?? payload?.dsh?.apiKey ?? '',
    stationID: payload?.station?.id ?? '',
    models: modelsFromJoin(payload),
    session: payload?.session ?? {},
    raw: payload,
  }
}

/**
 * Resolve the provider settings snapshot, tolerating volatile accessors.
 *
 * @param {object} config - live plugin configuration.
 * @returns {object} plain values.
 */
function plain(config) {
  const get = (key, fallback) => {
    const value = config?.[key]
    if (value === undefined) return fallback
    return typeof value?.get === 'function' ? value.get() : value
  }
  return {
    stationURL: get('stationURL', ''),
    apiKey: get('apiKey', ''),
    stationID: get('stationID', ''),
    models: get('models', []) ?? [],
    extraHeaders: get('extraHeaders', {}) ?? {},
    e2e: get('e2e', 'auto'),
  }
}

/** Sentinel pushed when the upstream request settles without an error. */
const CHANNEL_DONE = Symbol('relayhub-bridge.channel-done')

/**
 * Minimal async channel decoupling the fetch reader (callback-driven) from the
 * SSE projection (async iterator). Values arrive in push order; `CHANNEL_DONE`
 * ends the stream cleanly; a pushed `Error` is re-thrown to the reader —
 * throwing (not yielding) is load-bearing, because the projection skips
 * non-string rows and a yielded error would deadlock the reader forever.
 * @returns {{push: (value: unknown) => void, read: () => AsyncGenerator<unknown>}}
 */
function createChannel() {
  const queue = []
  let wake = null
  async function * read() {
    while (true) {
      if (queue.length === 0) {
        await new Promise(resolve => { wake = resolve })
        continue
      }
      const value = queue.shift()
      if (value === CHANNEL_DONE) return
      if (value instanceof Error) throw value
      yield value
    }
  }
  return {
    push(value) {
      queue.push(value)
      if (wake !== null) {
        const resolve = wake
        wake = null
        resolve()
      }
    },
    read,
  }
}

/**
 * Cordis plugin entry point.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - parsed configuration.
 */
export function apply(ctx, config) {
  const resolve = () => plain(config)
  // Warning surface for content the wire dropped (e.g. images on a text-only
  // lane). The harness StreamChunk vocabulary has no warnings type; the
  // reference adapter surfaces these through a `deps.warn` callback, so mirror
  // that on the context's logger instead of inventing a chunk type the kernel
  // would have to ignore. A failing logger must never kill the turn.
  const warn = message => {
    try {
      if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message)
      else if (typeof ctx?.console?.warn === 'function') ctx.console.warn(message)
      else console.warn(message)
    } catch { /* a failed warning must never kill the turn */ }
  }
  const settingsNamespace = ctx?.fiber?.entry?.options?.id ?? PLUGIN_ID

  // -- E2E envelope state (mirrors hubrelay client.py) -----------------------
  // Positive params are cached per station root; a station without envelopes
  // (404/501) is NOT cached — the client re-probes each turn, exactly like the
  // Python client, so a station that gains or loses the e2e extra is picked up
  // on the next request without a restart.
  let e2eCache = null
  const e2eModeOf = () => {
    const raw = resolve().e2e
    const mode = typeof raw === 'string' ? raw.trim().toLowerCase() : 'auto'
    return mode === 'off' || mode === 'require' ? mode : 'auto'
  }
  const e2eParams = async (refresh, signal) => {
    const root = normalizeRoot(resolve().stationURL)
    if (!refresh && e2eCache && e2eCache.root === root) return e2eCache
    const params = await fetchE2EParams(providerBaseURL(root), { signal })
    e2eCache = params ? { root, ...params } : null
    return e2eCache
  }

  // Declare the route so the Harness Models surface can configure it and the
  // agent model selector can list it.
  const registration = ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'relay-hub',
      settingsNs: settingsNamespace,
      settingsPath: [],
    },
  ])

  const adapter = {
    /**
     * Human-facing provider metadata.
     * @param {string} provider - the route id.
     * @returns {{id: string, name: string}} metadata.
     */
    providerInfo(provider) {
      return { id: provider, name: 'relay-hub' }
    },

    /**
     * Retry policy for this route. Host 的 `prepareRoutes` 在注册时**无条件**
     * 调用本方法（不是可选调用），缺失即 `TypeError: adapter.providerRetryPolicy
     * is not a function`，插件激活直接失败（0.1.2 的启用失败即此因）。
     * 返回 `undefined` 交给 Host 走默认策略。
     * @param {string} _provider - the route id.
     * @returns {undefined} use the harness default retry policy.
     */
    providerRetryPolicy(_provider) {
      return undefined
    },

    /**
     * Per-image request pricing. The token meter resolves this synchronously
     * per measurement; a missing method makes measurement (and therefore
     * compaction) throw. This lane quotes no per-image price.
     * @returns {undefined} no image pricing declared.
     */
    imageRequestPricing(_provider, _model) {
      return undefined
    },

    /**
     * Models this route can serve, from the last successful join. This is the
     * name the harness calls; the earlier `discoverModels` spelling was never
     * invoked by the runtime.
     * @returns {Promise<object[]>} catalog entries.
     */
    async listModels() {
      return resolve().models.map((entry) => ({
        provider: PROVIDER,
        id: String(entry.id),
        name: String(entry.name ?? entry.id),
        inputModalities: ['text'],
      }))
    },

    /**
     * Authentication headers for every upstream request.
     *
     * The plugin identity headers ride along here because this is the one place
     * the adapter merges caller-supplied headers into the outgoing Messages
     * request. That is what makes the station's per-plugin log accounting work
     * without any Harness-side change.
     *
     * @returns {{headers: Record<string,string>}} headers to merge.
     */
    resolveAuth() {
      const current = resolve()
      if (!current.apiKey) {
        throw new Error(
          `${PLUGIN_ID}: no session token yet for provider "${PROVIDER}". Run a join against a ` +
            'relay-hub station (station address + TOIP dynamic code), which fills in the token.',
        )
      }
      return {
        headers: {
          'x-api-key': current.apiKey,
          ...identityHeaders({
            pluginId: PLUGIN_ID,
            pluginVersion: PLUGIN_VERSION,
            stationId: current.stationID,
          }),
          ...current.extraHeaders,
        },
      }
    },

    /**
     * Resolve one model's serving metadata. Unknown ids get a conservative
     * fallback (the station is authoritative; a join refresh updates the list)
     * rather than a rejection — the picker may offer a model before the
     * config caught up with the latest join payload.
     * @param {string} provider - the route id.
     * @param {string} model - model id from the picker.
     * @returns {Promise<object>} resolved model metadata.
     */
    async resolveModel(provider, model) {
      const current = resolve()
      const id = String(model)
      const entry = current.models.find(candidate => String(candidate?.id) === id)
      const window = Number(entry?.contextWindow)
      return {
        provider,
        id,
        name: String(entry?.name ?? id),
        inputModalities: ['text'],
        context: { contextWindow: Number.isFinite(window) && window > 0 ? window : 131072 },
        defaultMaxTokens: 8192,
      }
    },

    /**
     * Bind model metadata and the dispatch closure for one turn. The host
     * calls this, then consumes the returned stream — the adapter owns the
     * HTTP from here on.
     * @param {string} provider - the route id.
     * @param {string} model - model id from the picker.
     * @returns {Promise<{model: object, stream: (options: object) => object}>}
     */
    async prepareCall(provider, model) {
      return {
        model: await this.resolveModel(provider, model),
        stream: options => this.stream(options),
      }
    },

    /**
     * One generation turn: abortable async iterator of harness StreamChunks.
     *
     * The wrapper mirrors the kernel's consumption pattern — native generators
     * order `return` behind a pending `next`, so the upstream request is
     * cancelled first for an immediate exit.
     * @param {object} options - GenerateOptions (messages, tools, maxTokens…).
     * @returns {object} async iterator over StreamChunks.
     */
    stream(options) {
      const controller = new AbortController()
      const onAbort = () => controller.abort(options.signal?.reason)
      if (options.signal?.aborted === true) onAbort()
      else options.signal?.addEventListener('abort', onAbort, { once: true })
      const iterator = this.runStream({ ...options, signal: controller.signal })
      const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
      const step = async (method, value) => {
        try {
          const row = await iterator[method](value)
          if (row.done) cleanup()
          return row
        } catch (error) {
          cleanup()
          throw error
        }
      }
      return {
        [Symbol.asyncIterator]() { return this },
        next: value => step('next', value),
        return: value => { controller.abort(); cleanup(); return step('return', value) },
        throw: error => { controller.abort(error); cleanup(); return step('throw', error) },
      }
    },

    /**
     * The turn itself: one POST /v1/messages with stream:true, the SSE body
     * projected into harness chunks, and every failure mode (HTTP error
     * envelope, in-stream error event, stream cut before message_stop, empty
     * answer, unparseable tool JSON) mapped onto a finish chunk the harness
     * understands. Single attempt — retry policy is the host's.
     * @param {object} options - GenerateOptions with the internal signal.
     */
    async * runStream(options) {
      const current = resolve()
      if (!current.apiKey) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: `${PLUGIN_ID}: no session token yet — run a join (station address + TOIP dynamic code) first`,
              code: CODE.credential,
            },
          },
        }
        return
      }
      if (!current.stationURL) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: `${PLUGIN_ID}: no station address configured`, code: CODE.client } },
        }
        return
      }

      const started = Date.now()
      const modelId = String(options.model)
      const warnings = []
      const payload = buildMessagesPayload(modelId, options, warnings)
      const url = `${providerBaseURL(normalizeRoot(current.stationURL))}/messages`
      const { headers } = this.resolveAuth()

      try {
        // ---- E2E envelope decision (mirrors hubrelay client.py `_post`) ----
        // off / no token -> plaintext. auto -> probe /v1/e2e/params once per
        // turn (404/501 -> plaintext; negatives are not cached). require ->
        // refuse to send plaintext when the station offers no envelope.
        // Sealing is loud: any failure surfaces as an error finish, never a
        // silent downgrade.
        const e2eMode = e2eModeOf()
        let envelope = null
        if (e2eMode !== 'off') {
          const params = await e2eParams(false, options.signal)
          if (params) envelope = params
          else if (e2eMode === 'require') {
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: {
                  message: 'relay-hub: config e2e="require" refuses plaintext, but the station serves no /v1/e2e/params (missing the hubrelay[e2e] extra on the station?)',
                  code: CODE.client,
                },
              },
            }
            return
          }
        }

        let resealed = false
        while (true) {
          const channel = createChannel()
          let body = payload
          let requestHeaders = headers
          if (envelope) {
            body = sealEnvelope(envelope.server_public, envelope.key_id, payload, current.apiKey)
            requestHeaders = { ...headers, 'content-type': ENVELOPE_CONTENT_TYPE }
          }
          const request = postMessages({
            url,
            headers: requestHeaders,
            body,
            signal: options.signal,
            onData: value => channel.push(value),
          })
            .then(() => channel.push(CHANNEL_DONE))
            .catch(error => channel.push(error instanceof Error ? error : new Error(String(error))))

          let outcome
          try {
            const reader = readClaudeStream(channel.read())
            try {
              while (true) {
                const row = await reader.next()
                if (row.done) { outcome = row.value; break }
                if (options.signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
                yield row.value
              }
            } finally {
              await reader.return?.()
            }
          } catch (error) {
            // Key rotation: the station regenerated its X25519 identity and the
            // sealed attempt came back 400 with "key_id" in the message. The
            // failure happens before any SSE data, so nothing was yielded yet —
            // refresh the params once and re-seal invisibly.
            if (
              envelope && !resealed &&
              error instanceof UpstreamError && error.status === 400 &&
              String(error?.message ?? '').includes('key_id')
            ) {
              resealed = true
              const refreshed = await e2eParams(true, options.signal)
              if (!refreshed) throw error // the station dropped E2E mid-flight: loud
              envelope = refreshed
              continue
            }
            throw error
          } finally {
            await request.catch(() => {})
          }

          const usage = outcome.usage
          const sawAnswer = outcome.sawText === true || outcome.sawToolCall === true || outcome.sawReasoning === true
          const reason = outcome.brokenToolCall === true ? { kind: 'max-tokens' } : finishReason(outcome.finish)
          // A `tool_use` or `max_tokens` finish is a legitimate ending — the turn
          // hands control back to the host either way, and misreading it as a cut
          // would kill every tool-call round. Only a cut (no finish frame at all)
          // or the wire's explicit failure statuses are errors; finishReason's
          // stop fallback must never widen that set, which is why the failed
          // endings are checked against the original token.
          const failedEnding = outcome.finish === 'failed' || outcome.finish === 'cancelled'
          if (outcome.sawFinish !== true || failedEnding) {
            const seconds = Math.round((Date.now() - started) / 1000)
            const code = sawAnswer ? 'STREAM_CUT' : failedEnding ? CODE.server : CODE.transport
            const message = !outcome.sawFinish
              ? sawAnswer
                ? `relay-hub: the station closed the stream after ${seconds}s, before its finish token`
                : `relay-hub: the station closed the stream after ${seconds}s, before its finish token, without answering`
              : `relay-hub: the station ended the turn with status ${outcome.finish}`
            if (outcome.sawUsage) yield { type: 'usage', usage }
            yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
            return
          }
          if (!sawAnswer && reason.kind === 'stop') {
            if (outcome.sawUsage) yield { type: 'usage', usage }
            yield {
              type: 'finish',
              reason: { kind: 'error', failure: { message: 'relay-hub: the station returned an empty response', code: CODE.empty } },
            }
            return
          }
          if (outcome.sawUsage) yield { type: 'usage', usage }
          yield { type: 'finish', reason }
          if (warnings.length > 0) {
            // Content the wire could not carry went missing; say so once through
            // the context's logger, where warnings belong — never as a chunk
            // type the harness does not know.
            warn(`relayhub-bridge: dropped content the wire cannot carry for ${modelId}: ${warnings.join(', ')}`)
          }
          return
        }
      } catch (error) {
        const aborted = options.signal?.aborted === true || error?.code === CODE.aborted
        const failure = {
          message: aborted ? 'request aborted' : String(error?.message ?? 'relay-hub request failed'),
          code: aborted ? CODE.aborted : typeof error?.code === 'string' && error.code ? error.code : CODE.transport,
          ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
          ...(Number.isFinite(error?.providerRetryAfterMs) && error.providerRetryAfterMs > 0
            ? { providerRetryAfterMs: error.providerRetryAfterMs }
            : {}),
        }
        yield { type: 'finish', reason: { kind: aborted ? 'aborted' : 'error', failure } }
      }
    },
  }

  ctx.llm.registerAdapter([PROVIDER], adapter)

  // Expose the bridge on the context so other plugins (or a command surface)
  // can drive a join without importing this module directly.
  // Cordis requires the property to be provided by this plugin before it can
  // be set; setting an unprovided property throws "cannot set property ...
  // without provide" and kills activation (second 0.1.2-era enable failure).
  ctx.provide?.('relayhubBridge')
  ctx.set?.('relayhubBridge', {
    provider: PROVIDER,
    /** Join a station and return the configuration patch to persist. */
    join: (input) => joinStationWith(input),
    /** Ask a station whether it offers TOIP, without joining. */
    probe: async (stationURL) => {
      const root = normalizeRoot(stationURL)
      const payload = await fetchStation(root)
      return { root, ...payload }
    },
    /** Report the current session's standing on the station. */
    session: async () => {
      const current = resolve()
      if (!current.stationURL || !current.apiKey) {
        throw new ToipError('the bridge has not joined a station yet')
      }
      return fetchSession(normalizeRoot(current.stationURL), current.apiKey)
    },
    /** Broadcast-probe the local network for stations. */
    discover: (options) => discover(options),
    /** Current code and seconds remaining, for a UI to display. */
    code: (secret) => (secret ? { code: totp(secret), secondsLeft: secondsLeft() } : null),
    /** Turn any failure into user-facing guidance. */
    explain: classifyJoinFailure,
    /** The persisted configuration, without the token. */
    describe: () => {
      const current = resolve()
      return {
        protocol: PROTOCOL,
        version: PROTOCOL_VERSION,
        stationURL: current.stationURL,
        stationID: current.stationID,
        hasToken: Boolean(current.apiKey),
        models: current.models.map((entry) => entry.id),
      }
    },
  })

  // Returning the registration handle lets Cordis dispose it with the fiber.
  void registration
}
