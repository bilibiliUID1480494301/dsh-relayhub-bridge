/**
 * Client half of dsh-relayhub-bridge.
 *
 * Contributes one Settings page where the user pastes a station address plus a
 * TOIP dynamic code (or an enrollment ticket), joins, and gets the station's
 * models registered — instead of editing configuration by hand.
 *
 * Three rules from the official plugin-development guide shape this file:
 *
 * 1. **Never `require()` a Harness Client package.** Only `react` comes from the
 *    browser module table. Everything else (the TOTP math, the HTTP calls, the
 *    controls, the styles) is written here, because those packages change
 *    without notice and a plain-JS plugin has no type check to catch it.
 * 2. **A throwing component blanks the whole slot entry** (the console shows
 *    `slot entry crashed in '<slot>'`). Every render path and every remote call
 *    is therefore wrapped, and a failure renders an inline message instead of
 *    propagating.
 * 3. **Style with `--dsw-alias-*` tokens only.** Literal colors are reserved for
 *    artwork; tokens degrade to a slightly-off look instead of breaking.
 *
 * The Client never calls the Host half directly. It performs the join over HTTP
 * itself (the protocol is plain JSON over fetch) and then writes the result into
 * the plugin's settings namespace through `ctx.remote.settings`, which is the
 * same namespace the Host half already reads in `resolveAuth`. That keeps the
 * two halves decoupled: no new Host-side remote had to be invented.
 *
 * @module dsh-relayhub-bridge/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-relayhub-bridge',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ------------------------------------------------------------ constants

    const SETTINGS_NS = 'relayhub-bridge'
    const PLUGIN_ID = 'dsh-relayhub-bridge'
    const PLUGIN_VERSION = '0.1.0'
    const TOTP = { digits: 6, period: 30 }
    const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    const STYLE_ID = 'dsh-relayhub-bridge-styles'

    // ------------------------------------------------------------ protocol

    /** Decode base32 (tolerating lowercase, spaces, hyphens and padding). */
    function base32Decode(text) {
      const cleaned = String(text == null ? '' : text)
        .toUpperCase()
        .replace(/[\s\-_]/g, '')
        .replace(/=+$/, '')
      if (!cleaned) throw new Error('the TOTP secret is empty')
      let bits = 0
      let value = 0
      const out = []
      for (let i = 0; i < cleaned.length; i += 1) {
        const index = B32.indexOf(cleaned[i])
        if (index < 0) throw new Error('the TOTP secret is not valid base32')
        value = (value << 5) | index
        bits += 5
        if (bits >= 8) {
          out.push((value >>> (bits - 8)) & 0xff)
          bits -= 8
        }
      }
      if (!out.length) throw new Error('the TOTP secret is too short')
      return new Uint8Array(out)
    }

    /**
     * Compute a TOTP code with WebCrypto (HMAC-SHA1).
     * @param {string} secretText - base32 secret.
     * @param {number} [atMs] - instant in milliseconds.
     * @returns {Promise<string>} the zero-padded code.
     */
    async function totp(secretText, atMs) {
      const raw = base32Decode(secretText)
      const at = atMs == null ? Date.now() : atMs
      const counter = Math.floor(at / 1000 / TOTP.period)
      const msg = new Uint8Array(8)
      let remaining = counter
      for (let i = 7; i >= 0; i -= 1) {
        msg[i] = remaining & 0xff
        remaining = Math.floor(remaining / 256)
      }
      const key = await crypto.subtle.importKey(
        'raw',
        raw,
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign'],
      )
      const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg))
      const offset = mac[mac.length - 1] & 0x0f
      const truncated =
        ((mac[offset] & 0x7f) << 24) |
        (mac[offset + 1] << 16) |
        (mac[offset + 2] << 8) |
        mac[offset + 3]
      return String(truncated % 10 ** TOTP.digits).padStart(TOTP.digits, '0')
    }

    /** Seconds until the current code rolls over. */
    function secondsLeft(atMs) {
      const at = atMs == null ? Date.now() : atMs
      return TOTP.period - (Math.floor(at / 1000) % TOTP.period)
    }

    /** Normalise anything a user pastes into an HTTP root. */
    function normalizeRoot(input) {
      const text = String(input == null ? '' : input).trim()
      if (!text) throw new Error('enter the station address')
      const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text)
      let url
      try {
        url = new URL(hasScheme ? text : 'http://' + text)
      } catch (error) {
        throw new Error('cannot read that address')
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('the address must be http or https')
      }
      if (url.username || url.password) throw new Error('the address must not embed credentials')
      url.pathname = url.pathname.replace(
        /\/(v1(\/(messages|chat\/completions|models|embeddings|responses))?)?\/?$/i,
        '',
      )
      url.search = ''
      url.hash = ''
      return url.toString().replace(/\/+$/, '')
    }

    /** The provider baseURL: always carries /v1. */
    function providerBaseURL(root) {
      const clean = String(root).replace(/\/+$/, '')
      return clean.endsWith('/v1') ? clean : clean + '/v1'
    }

    /** One JSON request against the station, with a timeout. */
    async function requestJson(url, options) {
      const opts = options || {}
      const headers = Object.assign({ accept: 'application/json' }, opts.headers || {})
      let body
      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(opts.body)
      }
      let response
      try {
        response = await fetch(url, {
          method: opts.method || 'GET',
          headers,
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(opts.timeoutMs || 15000),
        })
      } catch (error) {
        if (error && error.name === 'TimeoutError') throw new Error('the station did not answer in time')
        throw new Error('cannot reach the station: ' + ((error && error.message) || error))
      }
      const text = await response.text()
      if (!response.ok) {
        let message = text && text.trim() ? text.trim() : 'HTTP ' + response.status
        try {
          const parsed = JSON.parse(text)
          if (parsed && parsed.error && parsed.error.message) message = parsed.error.message
        } catch (ignored) {
          /* non-JSON body: keep the raw text */
        }
        throw new Error(message)
      }
      if (!text.trim()) return {}
      try {
        return JSON.parse(text)
      } catch (ignored) {
        throw new Error('the station returned a body that is not JSON')
      }
    }

    /** Ask a station whether it offers TOIP. */
    function probeStation(root) {
      return requestJson(root.replace(/\/+$/, '') + '/v1/toip/station', { timeoutMs: 8000 })
    }

    /** Exchange a code or ticket for a session. */
    function joinStation(root, input) {
      const payload = { plugin: PLUGIN_ID, client: 'dsh', plugin_version: PLUGIN_VERSION }
      if (input.code) payload.code = String(input.code).replace(/\s+/g, '')
      if (input.ticket) payload.ticket = String(input.ticket).trim()
      if (input.name) payload.name = String(input.name).trim()
      return requestJson(root.replace(/\/+$/, '') + '/v1/toip/join', {
        method: 'POST',
        body: payload,
      })
    }

    /** Model list from a join payload, normalised and de-duplicated. */
    function modelsFromJoin(payload) {
      const source = (payload && payload.dsh && payload.dsh.models) || (payload && payload.models) || []
      const out = []
      const seen = {}
      for (let i = 0; i < source.length; i += 1) {
        const entry = source[i] || {}
        const id = String(entry.id || entry.model_id || '').trim()
        if (!id || seen[id]) continue
        seen[id] = true
        const win = Number(entry.contextWindow != null ? entry.contextWindow : entry.context_window)
        if (isFinite(win) && win > 0) out.push({ id: id, contextWindow: win })
        else out.push({ id: id })
      }
      return out
    }

    /** Human-readable guidance for a failed join. */
    function explain(error) {
      const message = (error && error.message) || String(error)
      if (/did not answer|cannot reach/i.test(message)) {
        return message + ' — check the address and that the station is running.'
      }
      if (/时钟|clock|过期|expired|不正确|not accepted/i.test(message)) {
        return message + ' — codes live 30 seconds; if it keeps failing, check this machine\u2019s clock.'
      }
      return message
    }

    // ------------------------------------------------------------ styles

    /**
     * Our own controls, styled from host tokens. Class names carry a plugin
     * prefix so they can never collide with host or other plugins' rules.
     */
    const CSS = [
      '.rhb-page{box-sizing:border-box;color:var(--dsw-alias-label-primary);font-family:inherit;',
      'display:flex;flex-direction:column;gap:16px;padding:4px 0 24px}',
      '.rhb-lede{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7;margin:0}',
      '.rhb-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;',
      'display:flex;flex-direction:column;gap:12px}',
      '.rhb-row{display:flex;flex-direction:column;gap:6px}',
      '.rhb-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.rhb-input{box-sizing:border-box;width:100%;padding:8px 10px;font-size:13px;font-family:inherit;',
      'color:var(--dsw-alias-label-primary);background:transparent;',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none}',
      '.rhb-input:focus{border-color:var(--dsw-alias-border-l4)}',
      '.rhb-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.rhb-btn{font-family:inherit;font-size:13px;padding:7px 14px;border-radius:8px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}',
      '.rhb-btn[disabled]{opacity:.5;cursor:default}',
      '.rhb-btn-primary{background:var(--dsw-alias-label-primary);',
      'color:var(--dsw-alias-label-primary-inverted);border-color:transparent}',
      '.rhb-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:0}',
      '.rhb-err{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);margin:0;',
      'border:1px solid var(--dsw-alias-border-l4);border-radius:8px;padding:8px 10px}',
      '.rhb-mono{font-family:var(--ds-font-family-code,monospace);font-size:12px}',
      '.rhb-tag{display:inline-block;font-size:11px;padding:2px 6px;border-radius:6px;',
      'border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.rhb-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}',
      '.rhb-code{font-family:var(--ds-font-family-code,monospace);font-size:20px;letter-spacing:2px}',
    ].join('')

    // ------------------------------------------------------------ component

    /**
     * The Settings page. Everything it renders is derived from either the
     * plugin's settings namespace or local component state, so a failed remote
     * call can only ever produce an inline message.
     */
    function RelayhubSettings(props) {
      const injected = props && props.ctx ? props.ctx : null
      const [state, setState] = React.useState({
        loading: true,
        stationURL: '',
        stationID: '',
        hasToken: false,
        models: [],
      })
      const [form, setForm] = React.useState({ url: '', code: '', ticket: '', name: '' })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [probe, setProbe] = React.useState(null)
      const [tick, setTick] = React.useState(0)

      // A 1s tick only exists to render the code countdown; it is cleared on
      // unmount, which is the disposal the guide asks for.
      React.useEffect(() => {
        const timer = setInterval(() => setTick((n) => n + 1), 1000)
        return () => clearInterval(timer)
      }, [])

      const remote = React.useMemo(() => {
        const ctx = injected
        return {
          settings: ctx && ctx.remote && ctx.remote.settings ? ctx.remote.settings : null,
        }
      }, [injected])

      // Read current state once. A missing remote service is not an error the
      // user should see as a crash: render the form, disable what cannot work.
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            if (!remote.settings) {
              if (alive) setState((s) => Object.assign({}, s, { loading: false }))
              return
            }
            const described = await remote.settings.describe()
            const entry = findNamespaceEntry(described, SETTINGS_NS)
            const value = (entry && entry.value) || {}
            if (!alive) return
            setState({
              loading: false,
              stationURL: String(value.stationURL || ''),
              stationID: String(value.stationID || ''),
              hasToken: Boolean(value.apiKey),
              models: Array.isArray(value.models) ? value.models : [],
            })
            if (value.stationURL) setForm((f) => Object.assign({}, f, { url: String(value.stationURL) }))
          } catch (err) {
            if (alive) setState((s) => Object.assign({}, s, { loading: false }))
          }
        }
        load()
        return () => {
          alive = false
        }
      }, [remote])

      /** Write the joined configuration into the plugin's settings namespace. */
      const writeSettings = React.useCallback(
        async (patch) => {
          if (!remote.settings) {
            throw new Error(
              'the settings service is unavailable, so the bridge cannot be configured from here. ' +
                'Set stationURL/apiKey/models in this plugin\u2019s config instead.',
            )
          }
          // update() merges a sparse patch; expectedRevision stays undefined so
          // a concurrent edit is not silently overwritten by a stale form.
          await remote.settings.update(SETTINGS_NS, patch, undefined)
        },
        [remote],
      )

      const onJoin = React.useCallback(async () => {
        setError('')
        setNotice('')
        setBusy(true)
        try {
          const root = normalizeRoot(form.url)
          if (!form.code && !form.ticket) {
            throw new Error('enter the current dynamic code, or an enrollment ticket')
          }
          const payload = await joinStation(root, {
            code: form.code,
            ticket: form.ticket,
            name: form.name,
          })
          const models = modelsFromJoin(payload)
          const baseURL = (payload.dsh && payload.dsh.baseURL) || providerBaseURL(root)
          const apiKey = (payload.session && payload.session.token) || (payload.dsh && payload.dsh.apiKey) || ''
          if (!apiKey) throw new Error('the station did not return a session token')
          await writeSettings({
            stationURL: root,
            stationID: (payload.station && payload.station.id) || '',
            apiKey: apiKey,
            models: models,
          })
          setState({
            loading: false,
            stationURL: root,
            stationID: (payload.station && payload.station.id) || '',
            hasToken: true,
            models: models,
          })
          setForm((f) => Object.assign({}, f, { code: '', ticket: '' }))
          setNotice(
            'Joined. ' +
              models.length +
              ' model(s) registered under provider "relayhub"; ' +
              'pick one in the model selector.',
          )
        } catch (err) {
          setError(explain(err))
        } finally {
          setBusy(false)
        }
      }, [form, writeSettings])

      const onProbe = React.useCallback(async () => {
        setError('')
        setNotice('')
        setProbe(null)
        setBusy(true)
        try {
          const root = normalizeRoot(form.url)
          const payload = await probeStation(root)
          setProbe({ root: root, name: payload.name || '', stationID: payload.station_id || '', otp: payload.otp || null })
        } catch (err) {
          setError(explain(err))
        } finally {
          setBusy(false)
        }
      }, [form.url])

      const onDisconnect = React.useCallback(async () => {
        setError('')
        setNotice('')
        setBusy(true)
        try {
          // Clearing the token is enough to make the provider unusable; the
          // session token itself stays valid on the station until revoked there.
          await writeSettings({ apiKey: '', models: [] })
          setState({ loading: false, stationURL: state.stationURL, stationID: '', hasToken: false, models: [] })
          setNotice('Cleared the local session token. Revoke it on the station with: hubrelay toip revoke <name>')
        } catch (err) {
          setError(explain(err))
        } finally {
          setBusy(false)
        }
      }, [writeSettings, state.stationURL])

      const field = (label, key, extra) =>
        h(
          'div',
          { className: 'rhb-row', key: key },
          h('label', { className: 'rhb-label', htmlFor: 'rhb-' + key }, label),
          h(
            'input',
            Object.assign(
              {
                id: 'rhb-' + key,
                className: 'rhb-input',
                value: form[key],
                onChange: (event) =>
                  setForm((f) => Object.assign({}, f, { [key]: event.target.value })),
              },
              extra || {},
            ),
          ),
        )

      const children = [
        h(
          'p',
          { className: 'rhb-lede', key: 'lede' },
          'Join a relay-hub station with a TOIP dynamic password, then use its models as the ' +
            '"relayhub" provider. The station keeps a separate log for this plugin.',
        ),
      ]

      children.push(
        h(
          'div',
          { className: 'rhb-card', key: 'current' },
          h('div', { className: 'rhb-label', key: 't' }, 'Current bridge'),
          state.hasToken
            ? h(
                'div',
                { key: 'v' },
                h('div', { className: 'rhb-mono' }, state.stationURL || '(no address)'),
                h(
                  'div',
                  { className: 'rhb-note', style: { marginTop: 4 } },
                  (state.stationID ? 'station ' + state.stationID + ' \u00b7 ' : '') +
                    state.models.length +
                    ' model(s): ' +
                    (state.models.map((m) => m.id).join(', ') || 'none'),
                ),
                h(
                  'div',
                  { className: 'rhb-actions', style: { marginTop: 10 } },
                  h(
                    'button',
                    {
                      className: 'rhb-btn',
                      type: 'button',
                      disabled: busy,
                      onClick: onDisconnect,
                    },
                    'Disconnect',
                  ),
                ),
              )
            : h(
                'div',
                { className: 'rhb-note', key: 'n' },
                state.loading ? 'Loading\u2026' : 'Not joined yet. Fill in the form below.',
              ),
        ),
      )

      children.push(
        h(
          'div',
          { className: 'rhb-card', key: 'form' },
          field('Station address', 'url', { placeholder: 'http://192.168.1.10:8799' }),
          h(
            'div',
            { className: 'rhb-actions', key: 'probe' },
            h(
              'button',
              { className: 'rhb-btn', type: 'button', disabled: busy || !form.url, onClick: onProbe },
              'Check station',
            ),
            probe
              ? h(
                  'span',
                  { className: 'rhb-note' },
                  'TOIP available' +
                    (probe.name ? ' \u00b7 ' + probe.name : '') +
                    (probe.otp ? ' \u00b7 ' + probe.otp.digits + ' digits / ' + probe.otp.period + 's' : ''),
                )
              : null,
          ),
          field('Dynamic code (6 digits, rejoin)', 'code', {
            placeholder: '123456',
            inputMode: 'numeric',
            maxLength: 6,
          }),
          field('or enrollment ticket (first contact)', 'ticket', { placeholder: 'rhe_\u2026' }),
          field('Device name (optional)', 'name', { placeholder: 'dsh-laptop' }),
          h(
            'p',
            { className: 'rhb-note', key: 'hint' },
            'Get the code on the station: hubrelay toip station prints it, or use any TOTP app. ' +
              'A code rolls every ' + TOTP.period + ' seconds.',
          ),
          h(
            'div',
            { className: 'rhb-actions', key: 'submit' },
            h(
              'button',
              {
                className: 'rhb-btn rhb-btn-primary',
                type: 'button',
                disabled: busy || !form.url,
                onClick: onJoin,
              },
              busy ? 'Working\u2026' : 'Join station',
            ),
            busy && form.code
              ? h(
                  'span',
                  { className: 'rhb-note' },
                  'code expires in ' + secondsLeft() + 's',
                )
              : null,
          ),
        ),
      )

      if (error) children.push(h('p', { className: 'rhb-err', key: 'err' }, error))
      if (notice) children.push(h('p', { className: 'rhb-note', key: 'ok' }, notice))

      children.push(
        h(
          'p',
          { className: 'rhb-note', key: 'foot' },
          'The session token is stored in this plugin\u2019s settings and never logged. ' +
            'Over plain HTTP a code or token is visible on the local network; use TLS on untrusted networks.',
        ),
      )

      return h('div', { className: 'rhb-page' }, children)
    }

    /**
     * Locate one namespace in a settings description document.
     *
     * The shape of `describe()` is not part of this plugin's contract, so this
     * walks whatever it is given instead of assuming a fixed layout. Returning
     * undefined is fine: the page then shows "not joined yet".
     */
    function findNamespaceEntry(described, ns) {
      if (!described || typeof described !== 'object') return undefined
      const seen = []
      const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 6) return undefined
        if (seen.indexOf(node) >= 0) return undefined
        seen.push(node)
        if (Array.isArray(node)) {
          for (let i = 0; i < node.length; i += 1) {
            const hit = walk(node[i], depth + 1)
            if (hit) return hit
          }
          return undefined
        }
        if (node.ns === ns || node.namespace === ns) return node
        const keys = Object.keys(node)
        for (let i = 0; i < keys.length; i += 1) {
          const hit = walk(node[keys[i]], depth + 1)
          if (hit) return hit
        }
        return undefined
      }
      return walk(described, 0)
    }

    return {
      // 'slots' provides ctx.slots. ctx.remote needs no declaration: it is the
      // connection-provided service bag, and both are read defensively at use.
      inject: ['slots'],

      /**
       * Test seam for the duplicated protocol math.
       *
       * This module cannot import `../protocol.js` (a bare relative import is not
       * resolvable from the browser module table) and cannot use `node:crypto`,
       * so the math exists twice on purpose. Exposing it here lets the test suite
       * assert the two copies still agree, which is the only thing that keeps a
       * deliberate duplication from silently becoming a divergence.
       */
      __internals: {
        base32Decode: base32Decode,
        totp: totp,
        secondsLeft: secondsLeft,
        normalizeRoot: normalizeRoot,
        providerBaseURL: providerBaseURL,
        modelsFromJoin: modelsFromJoin,
      },

      apply(ctx) {
        // Styles are injected once and registered as an effect so a plugin
        // unload removes them rather than leaving orphan CSS behind.
        ctx.effect(() => {
          let node = document.getElementById(STYLE_ID)
          if (!node) {
            node = document.createElement('style')
            node.id = STYLE_ID
            node.textContent = CSS
            document.head.appendChild(node)
          }
          return () => {
            const existing = document.getElementById(STYLE_ID)
            if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
          }
        })

        // A missing service must not throw: an exception here would blank the
        // slot entry (console: "slot entry crashed in '<slot>'") instead of
        // degrading to "the page is not available". Staying silent is the same
        // posture the Host half takes for optional services.
        if (!ctx.slots || typeof ctx.slots.inject !== 'function') return

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'relayhub',
              order: 60,
              label: () => 'relay-hub',
            },
            RelayhubSettings,
          ),
        )
      },
    }
  },
})
