/**
 * Type surface for the protocol helpers.
 * @module dsh-relayhub-bridge/protocol
 */

export declare const PROTOCOL: 'toip'
export declare const PROTOCOL_VERSION: number
export declare const TOTP: Readonly<{
  algorithm: string
  digits: number
  period: number
  window: number
}>
export declare const HEADERS: Readonly<{
  pluginId: 'X-DSH-Plugin-Id'
  pluginVersion: 'X-DSH-Plugin-Version'
  stationId: 'X-Relayhub-Station-Id'
}>
export declare const PLUGIN_ID: string
export declare const PROBE_V1: string
export declare const PROBE_V2: string
export declare const DISCOVERY_PORT: number

/** A TOIP failure carrying the HTTP status and error type. */
export declare class ToipError extends Error {
  constructor(message: string, meta?: { status?: number; type?: string })
  status: number
  type: string
}

/** Decode RFC 4648 base32, tolerating lowercase, spaces, hyphens and padding. */
export declare function base32Decode(text: string): Buffer

/** Encode bytes as unpadded base32. */
export declare function base32Encode(raw: Buffer | Uint8Array): string

/** HOTP truncation for one counter. */
export declare function hotp(secret: Buffer, counter: number, digits?: number): string

/** TOTP code for an instant. */
export declare function totp(secret: string | Buffer, atMs?: number): string

/** Seconds until the current code rolls over. */
export declare function secondsLeft(atMs?: number): number

/** Verify a code the way the station does (current window +/- 1). */
export declare function verifyTotp(secret: string | Buffer, code: string, atMs?: number): boolean

/** Normalise a pasted station address into an HTTP root. */
export declare function normalizeRoot(input: string, options?: { defaultScheme?: string }): string

/** Build the provider `baseURL` (always ends in `/v1`). */
export declare function providerBaseURL(root: string): string

/** Join a relative path onto a station root. */
export declare function resolvePath(root: string, path: string): string

/** One JSON request against a station. */
export declare function requestJson(
  url: string,
  options?: {
    method?: string
    body?: unknown
    headers?: Record<string, string>
    timeoutMs?: number
  },
): Promise<Record<string, unknown>>

/** Read the station's public TOIP capability declaration. */
export declare function fetchStation(
  root: string,
  options?: { timeoutMs?: number },
): Promise<Record<string, unknown>>

/** Exchange a dynamic code or enrollment ticket for a session. */
export declare function join(
  root: string,
  input: { code?: string; ticket?: string; name?: string },
  options?: {
    pluginId?: string
    pluginVersion?: string
    client?: string
    timeoutMs?: number
  },
): Promise<Record<string, unknown>>

/** Read the current session's standing on the station. */
export declare function fetchSession(
  root: string,
  sessionToken: string,
  options?: { timeoutMs?: number },
): Promise<Record<string, unknown>>

/** Headers that tag inference traffic for per-plugin accounting. */
export declare function identityHeaders(options?: {
  pluginId?: string
  pluginVersion?: string
  stationId?: string
}): Record<string, string>

/** Turn a join failure into user-facing guidance. */
export declare function classifyJoinFailure(error: unknown): {
  kind: string
  retryable: boolean
  message: string
  hint: string
}
