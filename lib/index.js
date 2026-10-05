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
export const PLUGIN_VERSION = '0.1.0'

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
  const settingsNamespace = ctx?.fiber?.entry?.options?.id ?? PLUGIN_ID

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
     * Models this route can serve, from the last successful join.
     * @returns {object[]} catalog entries.
     */
    discoverModels() {
      return resolve().models.map((entry) => ({
        provider: PROVIDER,
        id: String(entry.id),
        name: String(entry.id),
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
  }

  ctx.llm.registerAdapter([PROVIDER], adapter)

  // Expose the bridge on the context so other plugins (or a command surface)
  // can drive a join without importing this module directly.
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
