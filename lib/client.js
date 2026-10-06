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
    const PLUGIN_VERSION = '0.3.0'
    const TOTP = { digits: 6, period: 30 }
    const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    const STYLE_ID = 'dsh-relayhub-bridge-styles'

    // ------------------------------------------------------------ copy

    /**
     * Built-in copy, English and Chinese.
     *
     * The Client locale service is the documented way to route visible text, and
     * `t()` prefers it. It is nevertheless optional here: a missing locale
     * service must not turn the page into an English-only or crashing surface, so
     * these tables are the fallback and the language is resolved from the locale
     * service, then the document, then the browser.
     */
    const COPY = {
      en: {
        title: 'relay-hub',
        lede:
          'Join a relay-hub station with a TOIP dynamic password, then use its models as the ' +
          '"relayhub" provider. The station keeps a separate log for this plugin.',
        current: 'Current bridge',
        notJoined: 'Not joined yet. Fill in the form below.',
        loading: 'Loading\u2026',
        noAddress: '(no address)',
        station: 'station',
        models: 'model(s)',
        none: 'none',
        disconnect: 'Disconnect',
        address: 'Station address',
        check: 'Check station',
        toipAvailable: 'TOIP available',
        digits: 'digits',
        code: 'Dynamic code (6 digits, rejoin)',
        ticket: 'or enrollment ticket (first contact)',
        deviceName: 'Device name (optional)',
        hint:
          'Get the code on the station: hubrelay toip station prints it, or use any TOTP app. ' +
          'A code rolls every 30 seconds.',
        join: 'Join station',
        working: 'Working\u2026',
        expiresIn: 'code expires in',
        joined: 'Joined.',
        registered: 'model(s) registered under provider "relayhub"; pick one in the model selector.',
        cleared:
          'Cleared the local session token. Revoke it on the station with: hubrelay toip revoke <name>',
        foot:
          'The session token is stored in this plugin\u2019s settings and never logged. ' +
          'Over plain HTTP a code or token is visible on the local network; use TLS on untrusted networks.',
        errEnterAddress: 'enter the station address',
        errBadAddress: 'cannot read that address',
        errScheme: 'the address must be http or https',
        errCredentials: 'the address must not embed credentials',
        errNoCredential: 'enter the current dynamic code, or an enrollment ticket',
        errNoToken: 'the station did not return a session token',
        errTimeout: 'the station did not answer in time',
        errUnreachable: 'cannot reach the station',
        errBadJson: 'the station returned a body that is not JSON',
        errNoSettings:
          'the settings service is unavailable, so the bridge cannot be configured from here. ' +
          'Set stationURL/apiKey/models in this plugin\u2019s config instead.',
        checkAddress: 'check the address and that the station is running.',
        checkClock:
          'codes live 30 seconds; if it keeps failing, check this machine\u2019s clock.',
      },
      zh: {
        title: 'relay-hub',
        lede:
          '用 TOIP 动态口令接入 relay-hub 中转站，然后把它的模型当作 "relayhub" provider 使用。' +
          '中转站会为本插件单独保留一份日志。',
        current: '当前接入',
        notJoined: '尚未接入。请在下面填写。',
        loading: '加载中\u2026',
        noAddress: '（无地址）',
        station: '站点',
        models: '个模型',
        none: '无',
        disconnect: '断开',
        address: '中转站地址',
        check: '检查站点',
        toipAvailable: '支持 TOIP',
        digits: '位',
        code: '动态口令（6 位，重接用）',
        ticket: '或登记口令（首接用）',
        deviceName: '设备名（可选）',
        hint:
          '口令在中转站获取：hubrelay toip station 会打印当前口令，也可用任意验证器 App。' +
          '口令每 30 秒滚动一次。',
        join: '接入站点',
        working: '处理中\u2026',
        expiresIn: '口令剩余',
        joined: '已接入。',
        registered: '个模型已注册到 provider "relayhub"，在模型选择器里选一个即可。',
        cleared: '已清除本地会话令牌。要同时作废它，请在中转站执行：hubrelay toip revoke <名称>',
        foot:
          '会话令牌只存在本插件的设置里，从不写日志。' +
          '走明文 HTTP 时口令与令牌在局域网内可见；不可信网络请使用 TLS。',
        errEnterAddress: '请填写中转站地址',
        errBadAddress: '无法识别该地址',
        errScheme: '地址必须是 http 或 https',
        errCredentials: '地址里不能内嵌凭证',
        errNoCredential: '请填写当前动态口令，或一枚登记口令',
        errNoToken: '站点没有返回会话令牌',
        errTimeout: '站点响应超时',
        errUnreachable: '无法连接站点',
        errBadJson: '站点返回的内容不是 JSON',
        errNoSettings:
          'settings 服务不可用，无法从这里配置桥接。请改为在本插件配置里填写 ' +
          'stationURL / apiKey / models。',
        checkAddress: '请检查地址，并确认站点正在运行。',
        checkClock: '口令有效期 30 秒；若持续失败，请检查本机时钟。',
      },
    }

    /** Normalise anything locale-ish ("zh-CN", "zh_Hans") to a copy table key. */
    function pickLang(raw) {
      const text = String(raw == null ? '' : raw).toLowerCase()
      if (text.startsWith('zh') || text.includes('hans') || text.includes('hant')) return 'zh'
      return 'en'
    }

    /** Best-effort language detection, preferring the host's own choice. */
    function detectLang(ctx) {
      try {
        const locale = ctx && ctx.get ? ctx.get('locale') : null
        const current = locale && typeof locale.current === 'string' ? locale.current : ''
        if (current) return pickLang(current)
      } catch (ignored) {
        /* the locale service is optional */
      }
      try {
        if (typeof navigator !== 'undefined' && navigator.language) return pickLang(navigator.language)
      } catch (ignored) {
        /* no navigator outside a browser */
      }
      return 'en'
    }

    /** Look up one key for a language, falling back to English then the key. */
    function translate(lang, key) {
      const table = COPY[lang] || COPY.en
      if (Object.prototype.hasOwnProperty.call(table, key)) return table[key]
      if (Object.prototype.hasOwnProperty.call(COPY.en, key)) return COPY.en[key]
      return key
    }

    /**
     * Build an error that carries a copy key instead of a finished sentence.
     *
     * The throwing helpers have no access to the host locale; the component that
     * renders them does. Raising a key and translating at render is what makes a
     * message follow the user's language instead of freezing at whatever was
     * active when it was thrown.
     *
     * @param {string} key - a key in COPY.
     * @param {string} [detail] - extra text (from the station) appended verbatim.
     * @returns {Error} the sentinel error.
     */
    function copyError(key, detail) {
      const error = new Error(key)
      error.copyKey = key
      if (detail) error.copyDetail = String(detail)
      return error
    }

    /**
     * Render any thrown value as a sentence in the active language.
     *
     * @param {unknown} thrown - the caught value.
     * @param {(key: string) => string} t - translator.
     * @returns {string} user-facing text.
     */
    function renderError(thrown, t) {
      if (thrown && thrown.copyKey) {
        const base = t(thrown.copyKey)
        return thrown.copyDetail ? base + ': ' + thrown.copyDetail : base
      }
      const message = (thrown && thrown.message) || String(thrown)
      // Station-supplied messages (relay-hub answers in Chinese) pass through
      // untouched; only our own generic transport wording gains a hint.
      if (/cannot reach|did not answer|无法连接|超时/i.test(message)) {
        return message + ' \u2014 ' + t('checkAddress')
      }
      if (/过期|不正确|expired|not accepted|clock/i.test(message)) {
        return message + ' \u2014 ' + t('checkClock')
      }
      return message
    }

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
      if (!text) throw copyError('errEnterAddress')
      const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text)
      let url
      try {
        url = new URL(hasScheme ? text : 'http://' + text)
      } catch (error) {
        throw copyError('errBadAddress')
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw copyError('errScheme')
      }
      if (url.username || url.password) throw copyError('errCredentials')
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
        if (error && error.name === 'TimeoutError') throw copyError('errTimeout')
        throw copyError('errUnreachable', (error && error.message) || String(error))
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
        throw copyError('errBadJson')
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
      const lang = React.useMemo(() => detectLang(injected), [injected])
      const t = React.useCallback((key) => translate(lang, key), [lang])

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
            throw copyError('errNoSettings')
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
            throw copyError('errNoCredential')
          }
          const payload = await joinStation(root, {
            code: form.code,
            ticket: form.ticket,
            name: form.name,
          })
          const models = modelsFromJoin(payload)
          const baseURL = (payload.dsh && payload.dsh.baseURL) || providerBaseURL(root)
          const apiKey = (payload.session && payload.session.token) || (payload.dsh && payload.dsh.apiKey) || ''
          if (!apiKey) throw copyError('errNoToken')
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
            t('joined') + ' ' + models.length + ' ' + t('registered'),
          )
        } catch (err) {
          setError(renderError(err, t))
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
          setError(renderError(err, t))
        } finally {
          setBusy(false)
        }
      }, [form.url, t])

      const onDisconnect = React.useCallback(async () => {
        setError('')
        setNotice('')
        setBusy(true)
        try {
          // Clearing the token is enough to make the provider unusable; the
          // session token itself stays valid on the station until revoked there.
          await writeSettings({ apiKey: '', models: [] })
          setState({ loading: false, stationURL: state.stationURL, stationID: '', hasToken: false, models: [] })
          setNotice(t('cleared'))
        } catch (err) {
          setError(renderError(err, t))
        } finally {
          setBusy(false)
        }
      }, [writeSettings, state.stationURL, t])

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
          t('lede'),
        ),
      ]

      children.push(
        h(
          'div',
          { className: 'rhb-card', key: 'current' },
          h('div', { className: 'rhb-label', key: 't' }, t('current')),
          state.hasToken
            ? h(
                'div',
                { key: 'v' },
                h('div', { className: 'rhb-mono' }, state.stationURL || t('noAddress')),
                h(
                  'div',
                  { className: 'rhb-note', style: { marginTop: 4 } },
                  (state.stationID ? t('station') + ' ' + state.stationID + ' \u00b7 ' : '') +
                    state.models.length + ' ' + t('models') + ': ' +
                    (state.models.map((m) => m.id).join(', ') || t('none')),
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
                    t('disconnect'),
                  ),
                ),
              )
            : h(
                'div',
                { className: 'rhb-note', key: 'n' },
                state.loading ? t('loading') : t('notJoined'),
              ),
        ),
      )

      children.push(
        h(
          'div',
          { className: 'rhb-card', key: 'form' },
          field(t('address'), 'url', { placeholder: 'http://192.168.1.10:8799' }),
          h(
            'div',
            { className: 'rhb-actions', key: 'probe' },
            h(
              'button',
              { className: 'rhb-btn', type: 'button', disabled: busy || !form.url, onClick: onProbe },
              t('check'),
            ),
            probe
              ? h(
                  'span',
                  { className: 'rhb-note' },
                  t('toipAvailable') +
                    (probe.name ? ' \u00b7 ' + probe.name : '') +
                    (probe.otp
                      ? ' \u00b7 ' + probe.otp.digits + ' ' + t('digits') + ' / ' + probe.otp.period + 's'
                      : ''),
                )
              : null,
          ),
          field(t('code'), 'code', {
            placeholder: '123456',
            inputMode: 'numeric',
            maxLength: 6,
          }),
          field(t('ticket'), 'ticket', { placeholder: 'rhe_\u2026' }),
          field(t('deviceName'), 'name', { placeholder: 'dsh-laptop' }),
          h(
            'p',
            { className: 'rhb-note', key: 'hint' },
            t('hint'),
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
              busy ? t('working') : t('join'),
            ),
            busy && form.code
              ? h(
                  'span',
                  { className: 'rhb-note' },
                  t('expiresIn') + ' ' + secondsLeft() + 's',
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
          t('foot'),
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
        COPY: COPY,
        pickLang: pickLang,
        detectLang: detectLang,
        translate: translate,
        renderError: renderError,
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
