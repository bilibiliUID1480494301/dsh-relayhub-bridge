/**
 * Type surface for the Client half.
 *
 * This artifact is not a normal ES module: the browser loads it as a script
 * through `window.__ModuleLoader__.load()`, and the loader instantiates the
 * factory. The declarations below describe the factory's return value, which is
 * what the slot system consumes.
 *
 * @module dsh-relayhub-bridge/client
 */

/** TOTP parameters the station advertises and this client assumes. */
export interface TotpParams {
  digits: number
  period: number
}

/** One model advertised by a station. */
export interface ClientRelayModel {
  id: string
  contextWindow?: number
}

/**
 * The module object the Client factory returns to the loader.
 *
 * `inject` names the services this module needs; `apply` registers the Settings
 * page as an effect-owned slot registration.
 */
export interface RelayhubClientModule {
  /** Services this client module injects, as the slot system names them. */
  inject: string[]
  /** Register styles and the Settings section on the given client context. */
  apply(ctx: { effect(fn: () => () => void): unknown; slots?: unknown }): void
  /**
   * Protocol helpers exposed for parity testing.
   *
   * The Client cannot import `../protocol.js` (a bare relative import does not
   * resolve from the browser module table) and cannot use `node:crypto`, so the
   * algorithm exists twice on purpose. This seam is what lets the test suite
   * prove the copies have not diverged.
   */
  __internals: {
    base32Decode(text: string): Uint8Array
    totp(secretText: string, atMs?: number): Promise<string>
    secondsLeft(atMs?: number): number
    normalizeRoot(input: string): string
    providerBaseURL(root: string): string
    modelsFromJoin(payload: unknown): ClientRelayModel[]
  }
}

declare const module: RelayhubClientModule
export default module
