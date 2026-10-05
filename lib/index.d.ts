/**
 * Type surface for dsh-relayhub-bridge.
 *
 * Hand-written rather than generated: the runtime is plain ESM JavaScript with
 * JSDoc, and the public surface is small enough that a generated .d.ts would be
 * more machinery than the plugin is worth.
 *
 * @module dsh-relayhub-bridge
 */

/** Provider route owned by this plugin. */
export declare const PROVIDER: 'relayhub'

/** Cordis plugin name. */
export declare const name: 'relayhub-bridge'

/** Services this plugin injects. */
export declare const inject: readonly string[]

/** Plugin version, sent in the identity header. */
export declare const PLUGIN_VERSION: string

/** One model advertised by a station. */
export interface RelayModel {
  id: string
  contextWindow?: number
}

/** Result of a successful station join. */
export interface JoinResult {
  /** Normalised station HTTP root (no trailing slash). */
  root: string
  /** Value to use as the provider `baseURL`; always ends in `/v1`. */
  baseURL: string
  /** Session token (`rht_…`). A real credential: never log it. */
  apiKey: string
  /** Station id, used for the identity header. */
  stationID: string
  /** Models the station advertises. */
  models: RelayModel[]
  /** Session facts as returned by the station. */
  session: { token?: string; token_hint?: string; expires_at?: number; rotated?: boolean }
  /** The untouched join response. */
  raw: Record<string, unknown>
}

/** What a user supplies to join. */
export interface JoinInput {
  /** Station address, in any pasted shape (`host`, `host:port`, URL, `/v1/messages` URL). */
  stationURL: string
  /** Current TOIP dynamic code (rejoin). */
  code?: string
  /** Enrollment ticket printed by `hubrelay toip ticket` (first contact). */
  ticket?: string
  /** Device name shown in the station's token list. */
  name?: string
}

/** A station found by LAN discovery. */
export interface FoundStation {
  name: string
  host: string
  port: number
  models: number
  pairingOpen: boolean
  toip: Record<string, unknown>
  toipEnabled: boolean
  url: string
}

/** User-facing guidance derived from a join failure. */
export interface JoinFailureGuidance {
  kind: 'no-toip' | 'rejected' | 'locked-out' | 'bad-request' | 'unreachable' | 'http-error'
  retryable: boolean
  message: string
  hint: string
}

/** The object this plugin exposes on the Cordis context as `relayhubBridge`. */
export interface RelayhubBridge {
  provider: string
  join(input: JoinInput): Promise<JoinResult>
  probe(stationURL: string): Promise<Record<string, unknown> & { root: string }>
  session(): Promise<Record<string, unknown>>
  discover(options?: { timeoutMs?: number; port?: number }): Promise<FoundStation[]>
  code(secret: string): { code: string; secondsLeft: number } | null
  explain(error: unknown): JoinFailureGuidance
  describe(): {
    protocol: string
    version: number
    stationURL: string
    stationID: string
    hasToken: boolean
    models: string[]
  }
}

/** Configuration schema for the plugin. */
export declare const Config: unknown

/** Join a station outside a Cordis context (scripts, tests, future UI). */
export declare function joinStationWith(
  input: JoinInput,
  options?: { timeoutMs?: number },
): Promise<JoinResult>

/** Extract and normalise the model list from a join response. */
export declare function modelsFromJoin(payload: unknown): RelayModel[]

/** Cordis plugin entry point. */
export declare function apply(ctx: unknown, config: unknown): void

/** Normalise a pasted station address into an HTTP root. */
export declare function normalizeRoot(input: string, options?: { defaultScheme?: string }): string

/** Build the provider `baseURL` (always ends in `/v1`). */
export declare function providerBaseURL(root: string): string

/** Current TOTP code for a base32 secret. */
export declare function totp(secret: string, atMs?: number): string

/** Seconds until the current code rolls over. */
export declare function secondsLeft(atMs?: number): number
