/**
 * 跨实现端到端：本插件 ↔ 真实 hubrelay 0.3.0（PyPI 安装版）。
 *
 * 这不是 mock：它起一个真的中转站进程，用真 API Key、真上游（假上游服务），
 * 然后让插件的协议层走完「登记 → 接入 → 推理 → 按插件分账」整条链。
 * 目的是证明两件事：
 *   1. 插件的 TOTP 与中转站的服务端实现算出同一枚口令（否则永远接不上）；
 *   2. 插件带的 X-DSH-Plugin-Id 真的让中转站写出了按插件的日志。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fetchStation, join as joinStation, fetchSession } from '../lib/protocol.js'

const PYTHON =
  process.env.RELAYHUB_PYTHON ??
  join(process.env.TEMP ?? tmpdir(), 'rh-venv', 'Scripts', 'python.exe')

/** Skip cleanly when the 0.3.0 test venv is not available. */
function requireStation() {
  const probe = spawnSync(PYTHON, ['-c', 'import relayhub,sys;print(relayhub.__version__)'], {
    encoding: 'utf8',
  })
  if (probe.status !== 0) return null
  const version = probe.stdout.trim()
  return version
}

const version = requireStation()

test('plugin joins a live hubrelay station and is logged per plugin', { skip: version ? false : 'no hubrelay 0.3.0 venv' }, async () => {
  assert.match(version, /^0\.3\./, `station must be >= 0.3.0, got ${version}`)
  const home = mkdtempSync(join(tmpdir(), 'rh-x-e2e-'))
  const env = { ...process.env, RELAYHUB_HOME: home }

  /**
   * Run the station CLI.
   * @param {string[]} args - arguments after `relayhub.gateway`.
   * @returns {string} stdout.
   */
  const cli = (...args) => {
    const run = spawnSync(
      PYTHON,
      ['-X', 'utf8', '-c', 'from relayhub.gateway.__main__ import main;import sys;sys.exit(main(sys.argv[1:]))', ...args],
      { encoding: 'utf8', env },
    )
    assert.equal(run.status, 0, `cli ${args.join(' ')} failed: ${run.stdout}\n${run.stderr}`)
    return run.stdout
  }

  cli('toip', 'station', '--name', 'e2e-station')
  const ticketOut = cli('toip', 'ticket', '--name', 'dsh-laptop', '--plugins', 'dsh-relayhub-bridge')
  const ticket = ticketOut.split('\n').find((l) => l.includes('登记口令')).split('：')[1].trim()
  assert.ok(ticket.startsWith('rhe_'), ticket)

  // Boot a real data-plane server inside the station's own data root.
  const port = 18123
  const serverScript = `
import os, sys, threading, time
from relayhub import paths
from relayhub.gateway import toip as T, pairing as PR
from relayhub.gateway.pool import KeyPool, UpstreamKey, PROTOCOL_ANTHROPIC
from relayhub.gateway.router import KeyPoolRouter
from relayhub.gateway.service import RelayServer
from relayhub.gateway.tokens import TokenStore
from relayhub.gateway import discovery as D

tokens = TokenStore(paths.tokens_path())
pool = KeyPool([UpstreamKey(key_id="k1", label="e2e-upstream", api_key="sk-test",
                            base_url="http://127.0.0.1:9",
                            protocol=PROTOCOL_ANTHROPIC, models=("glm-5.2",), weight=1)])
srv = RelayServer(("127.0.0.1", ${port}), KeyPoolRouter(pool, persist_path=paths.pool_path()),
                  api_key=None, tokens=tokens,
                  pairing=PR.PairingService(tokens=tokens, path=paths.pairing_path()),
                  request_log=paths.requests_log_path(),
                  toip=T.ToipService(T.TicketStore(paths.toip_tickets_path()), tokens,
                                     paths.toip_station_path(),
                                     plugin_log_home=paths.relayhub_home()))
resp = D.DiscoveryResponder(name="e2e-station", data_port=${port},
                            models_count=lambda: len(srv.router.models()),
                            pairing_open=lambda: False, port=0, toip_info=srv.toip_summary)
resp.start()
print("PORT", resp.port, flush=True)
srv.serve_forever()
`
  const child = spawn(PYTHON, ['-X', 'utf8', '-c', serverScript], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let udpPort = 0
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 20000)
    child.stdout.on('data', (d) => {
      const m = /PORT (\d+)/.exec(String(d))
      if (m) {
        udpPort = Number(m[1])
        clearTimeout(timer)
        resolve()
      }
    })
  })

  const root = `http://127.0.0.1:${port}`
  try {
    // 1) 公开能力探测
    const station = await fetchStation(root)
    assert.equal(station.protocol, 'toip')
    assert.equal(station.enabled, true)
    assert.equal(station.otp.digits, 6)
    assert.equal(station.otp.period, 30)
    assert.ok(!JSON.stringify(station).includes('secret'), 'the public probe must not carry the seed')

    // 2) 首接：登记口令
    const first = await joinStation(root, { ticket, name: 'dsh-laptop' }, {
      pluginVersion: '0.1.0',
    })
    assert.equal(first.protocol, 'toip')
    assert.equal(first.plugin.id, 'dsh-relayhub-bridge')
    assert.equal(first.session.rotated, false)
    assert.ok(first.session.token.startsWith('rht_'))
    assert.equal(first.dsh.baseURL, `${root}/v1`)
    assert.equal(first.dsh.apiKey, first.session.token)
    assert.deepEqual(first.dsh.models.map((m) => m.id), ['glm-5.2'])

    // 3) 会话自查
    const session = await fetchSession(root, first.session.token)
    assert.equal(session.plugin_id, 'dsh-relayhub-bridge')
    assert.ok(session.station_id.startsWith('rst_'))

    // 4) 推理请求带插件身份头 -> 中转站按插件分账
    const answer = await fetch(`${first.dsh.baseURL}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': first.dsh.apiKey,
        'X-DSH-Plugin-Id': 'dsh-relayhub-bridge',
        'X-DSH-Plugin-Version': '0.1.0',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'glm-5.2', max_tokens: 16, messages: [] }),
    })
    const body = await answer.text()
    // The fake upstream is unreachable, so an upstream error is a legitimate
    // outcome; what matters is that the station accepted our credentials and
    // recorded the attempt against this plugin.
    assert.ok(answer.status > 0, body)

    const logDir = join(home, 'pluginlogs', 'dsh-relayhub-bridge')
    const files = readdirSync(logDir)
    assert.ok(files.includes('events.jsonl'), `expected events.jsonl in ${files.join(',')}`)
    const events = readFileSync(join(logDir, 'events.jsonl'), 'utf8')
    assert.ok(events.includes('toip.join'), events)
    const flow = files.filter((f) => f.endsWith('.jsonl') && f !== 'events.jsonl')
    assert.ok(flow.length >= 1, `expected a per-plugin call log, got ${files.join(',')}`)
    const line = JSON.parse(readFileSync(join(logDir, flow[0]), 'utf8').trim().split('\n')[0])
    assert.equal(line.plugin, 'dsh-relayhub-bridge')
    assert.equal(line.plugin_version, '0.1.0')
    assert.equal(line.model, 'glm-5.2')
    assert.ok(!JSON.stringify(line).includes(first.session.token), 'the call log must not contain the token')

    // 5) 重接：用动态口令（插件算的 TOTP，中转站必须认）
    const { totp } = await import('../lib/protocol.js')
    // Derive the code from the station's own seed is impossible for a client;
    // instead prove the reverse direction -- ask the station for its current
    // code is not exposed either, so we assert the *server* accepted a code the
    // plugin produced from the seed the operator holds. The e2e station writes
    // the seed to toip.json, so a real client would not have it; here we read it
    // only to prove cross-implementation agreement of the TOTP algorithm.
    const seed = JSON.parse(readFileSync(join(home, 'toip.json'), 'utf8')).secret
    const code = totp(seed)
    const again = await joinStation(root, { code }, { pluginVersion: '0.1.0' })
    assert.equal(again.session.rotated, true, 'a code join must rotate the session')
    assert.notEqual(again.session.token, first.session.token)
  } finally {
    child.kill()
    rmSync(home, { recursive: true, force: true })
  }
})
