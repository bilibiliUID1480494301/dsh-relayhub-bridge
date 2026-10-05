# dsh-relayhub-bridge

**English** | [中文](#dsh-relayhub-bridge-中文)

A DeepSeek Harness plugin that connects Harness to a
[relay-hub](https://github.com/bilibiliUID1480494301/relay-hub) station — a
self-hosted LLM relay/gateway (`pip install hubrelay`) — using **TOIP dynamic
passwords**, and that arranges for the station to keep a **separate log per
plugin**.

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-yes-blue)](https://github.com/topics/dsh-plugin)
![Python station](https://img.shields.io/badge/station-hubrelay%20%3E%3D%200.3.0-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

## What it does

1. **Joins a station with a URL and a rolling 6-digit code.** No CLI on the
   gateway, no pairing window, no asking an admin for a one-time code. The code
   is an RFC 6238 TOTP value that rolls every 30 seconds.
2. **Becomes a provider.** It registers the `relayhub` provider route, so the
   joined station's models appear in Harness like any other provider.
3. **Tags its traffic for per-plugin accounting.** Every request carries
   `X-DSH-Plugin-Id`, so the station writes
   `pluginlogs/dsh-relayhub-bridge/<date>.jsonl` alongside its global request
   log. You get "what did this plugin do" without grepping the raw API log.

## Requirements

- DeepSeek Harness **0.2.0-rc.2 or newer, within the 0.2.x line**.
  `verifiedAgainst: 0.2.0-rc.2` (the exact build this plugin was developed and
  tested against; the peer range it declares is `@deepseek-ai/cordis ~4.0.4`,
  `@deepseek-ai/schemastery ~3.18.4`).
  *This plugin is written against the 0.2.x plugin contract
  (`ctx.llm.registerAdapter` / `registerConfigurableProviders`, `dsh.bundle.patch`).
  Harness is in developer preview and its plugin API can change; a bump to 0.3.x
  may require a matching release here. Pin the Harness version if you need
  stability.*
- A relay-hub station running **hubrelay ≥ 0.3.0** (TOIP was added in 0.3.0).
  The cross-implementation suite in this repo runs against
  `verifiedAgainst: hubrelay 0.3.1`.
- Node.js ≥ 18 (the plugin uses `fetch`, `AbortSignal.timeout`, and `node:dgram`).

## Declared services (`inject`)

```js
export const inject = ['llm']
```

`llm` is the provider registry this plugin registers `relayhub` with. Nothing
else is required, and in particular the plugin does **not** depend on any
Harness-internal package — only `@deepseek-ai/cordis` and
`@deepseek-ai/schemastery`, both optional peers. That is deliberate: internal
packages are not resolvable from a profile's `node_modules`, and depending on
them is how plugins break on upgrade.

## Install

```bash
# <profile> is your Harness profile name — e.g. desktop, web
dsh plugin --profile <profile> add dsh-relayhub-bridge

# concrete examples
dsh plugin --profile desktop add dsh-relayhub-bridge
dsh plugin --profile web add dsh-relayhub-bridge
```

Or install straight from this repository (no registry involved):

```bash
dsh plugin --profile <profile> add github:bilibiliUID1480494301/dsh-relayhub-bridge
```

From a local checkout (an absolute path is required):

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-relayhub-bridge
```

Verify it was picked up:

```bash
node scripts/check-package.cjs     # the packaging contract, 19 checks
node --test test/                  # 21 protocol tests
```

## Usage

### 1. On the station (once)

```bash
hubrelay toip station --name lab-hub          # prints a code + otpauth:// URI
hubrelay toip ticket --name dsh-laptop --plugins dsh-relayhub-bridge
#   -> prints an enrollment secret (rhe_…) exactly once
```

### 2. From the plugin

Settings → **relay-hub** gives you the whole flow in the UI: paste the station
address, click **Check station** to confirm TOIP is offered, paste the current
6-digit code (or an enrollment ticket), and press **Join station**. The page then
shows which station you are on, how many models were registered, and a
**Disconnect** action that clears the stored token.

Under the hood that page performs the same join and writes the result
(`baseURL`, `apiKey`, `stationID`, `models`) into this plugin's settings
namespace — the same one the provider reads — so there is nothing else to
configure by hand.

The same join is also available programmatically:

```js
// enrollment (first contact)
const joined = await bridge.join({
  stationURL: 'http://192.168.1.10:8799',
  ticket: 'rhe_…',
  name: 'dsh-laptop',
})

// rejoin: the rolling code from the station console or a TOTP app
const again = await bridge.join({
  stationURL: 'http://192.168.1.10:8799',
  code: '123456',
})
```

`bridge` is the object the plugin exposes on the Cordis context as
`relayhubBridge`. A join returns exactly what the provider needs:

```js
{
  root:    'http://192.168.1.10:8799',
  baseURL: 'http://192.168.1.10:8799/v1',   // always ends in /v1
  apiKey:  'rht_…',                          // session token — treat as a credential
  stationID: 'rst_…',
  models:  [{ id: 'deepseek-v4-pro', contextWindow: 1000000 }],
}
```

Persist `baseURL`, `apiKey`, `stationID` and `models` into the plugin's config
(the same values the Harness models settings page edits), then select a model.

> **Why `baseURL` always ends in `/v1`:** the Harness Messages adapter appends
> `/v1` only when the path does not already end with it, so `/v1` is the one
> unambiguous spelling. The plugin never hands you anything else.

### 3. Find a station automatically (LAN)

```js
const stations = await bridge.discover({ timeoutMs: 3000 })
// [{ name: 'lab-hub', url: 'http://192.168.1.10:8799', toipEnabled: true, models: 3 }]
```

This broadcasts the same `RELAYHUB-DISCOVER-v2` probe the station answers, and
the reply carries the TOIP capability block — so one broadcast yields both the
address and whether it can be joined with a code. Broadcast does not cross
subnets; for a remote station, supply the URL.

## Per-plugin logs on the station

With the bridge in place, the station keeps a per-plugin view:

```bash
hubrelay toip logs list                      # every plugin with logs
hubrelay toip logs show dsh-relayhub-bridge  # enrollment events + summary + recent calls
```

or open the station's admin console → **插件 / Plugins**.

Log lines contain metadata only — model, protocol, status, token counts,
latency, IP. Prompt and completion text are never written, on either side.

## Security notes

- The **session token is a real credential.** It goes into configuration and is
  never logged by this plugin. The station stores only its SHA-256.
- The plugin **never computes the enrollment secret** and never needs the TOTP
  seed: it accepts a rolling code that expires in 30 seconds. If you do keep a
  seed for convenience, treat it like a password.
- Codes and tokens cross the network in the clear over plain HTTP, which is the
  same residual risk as relay-hub's pairing codes. Put TLS in front for
  untrusted networks.
- To revoke: `hubrelay toip revoke <name>` on the station (which also reclaims
  the session token). To rotate the station secret without disturbing live
  sessions: `hubrelay toip station --force`.

## How it is verified

- `node --test test/` — 21 tests covering the RFC 6238 SHA-1 vectors (proving
  codes are byte-identical to the station's), window tolerance, base32
  hand-typing tolerance, URL normalisation, the `baseURL` rule, real-HTTP join
  and error paths, and failure classification.
- `node scripts/check-package.cjs` — the Harness plugin packaging contract:
  `dsh-` prefix, `dsh-plugin` keyword, ESM, a `dsh.bundle.patch` that is
  relative and non-escaping, shipping entries, and no harness-internal deps.

## License

[MIT](./LICENSE)

---

# dsh-relayhub-bridge 中文

**中文** | [English](#dsh-relayhub-bridge)

一个 DeepSeek Harness 插件：用 **TOIP 动态口令**把 Harness 接到
[relay-hub](https://github.com/bilibiliUID1480494301/relay-hub) 中转站
（自托管大模型中转站，`pip install hubrelay`），并让中转站**按插件分开记日志**。

## 它做什么

1. **一个网址 + 一枚滚动 6 位口令就能接入。** 不需要在网关执行 `pair begin`，
   不需要开配对窗口，不需要找人要一次性配对码。口令是 RFC 6238 TOTP，
   每 30 秒滚动一次。
2. **变成一个 provider。** 它注册 `relayhub` provider 路由，接入后中转站的模型
   会像其他 provider 一样出现在 Harness 里。
3. **给自己的流量打标签，实现按插件分账。** 每个请求带 `X-DSH-Plugin-Id`，
   于是中转站会在全局请求日志之外，另写
   `pluginlogs/dsh-relayhub-bridge/<日期>.jsonl`。想知道「这个插件整体干了什么」
   就不必去翻原始 API 日志了。

## 兼容性

- DeepSeek Harness **0.2.0-rc.2 及以上、0.2.x 线内**。
  *本插件按 0.2.x 的插件契约编写
  （`ctx.llm.registerAdapter` / `registerConfigurableProviders`、`dsh.bundle.patch`）。
  Harness 处于开发者预览期，插件 API 可能变更；升到 0.3.x 可能需要对应的新版本。
  需要稳定的话请锁住 Harness 版本。*
- 中转站需 **hubrelay ≥ 0.3.0**（TOIP 是 0.3.0 加入的）。
- Node.js ≥ 18（用到 `fetch`、`AbortSignal.timeout`、`node:dgram`）。

## 声明的服务（`inject`）

```js
export const inject = ['llm']
```

`llm` 是 provider 注册表，本插件用它注册 `relayhub`。除此之外不需要别的服务；
特别地，本插件**不依赖任何 Harness 内部包**——只用 `@deepseek-ai/cordis` 与
`@deepseek-ai/schemastery`，且都是可选 peer。这是刻意的：内部包在 profile 的
`node_modules` 里解析不到，依赖内部实现正是插件「一升级就坏」的原因。

## 安装

```bash
# <profile> 是你的 Harness profile 名，例如 desktop、web
dsh plugin --profile <profile> add dsh-relayhub-bridge

# 可直接复制的例子
dsh plugin --profile desktop add dsh-relayhub-bridge
dsh plugin --profile web add dsh-relayhub-bridge
```

也可以直接从本仓库安装（不经过 npm registry）：

```bash
dsh plugin --profile <profile> add github:bilibiliUID1480494301/dsh-relayhub-bridge
```

从本地目录安装（路径必须绝对）：

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-relayhub-bridge
```

自检：

```bash
node scripts/check-package.cjs     # 打包契约，19 项检查
node --test test/                  # 21 个协议测试
```

## 用法

### 1. 中转站侧（一次性）

```bash
hubrelay toip station --name lab-hub          # 打印当前口令与 otpauth:// 链接
hubrelay toip ticket --name dsh-laptop --plugins dsh-relayhub-bridge
#   -> 打印登记口令（rhe_…），只显示这一次
```

### 2. 插件侧

设置页 → **relay-hub** 里可以走完整个流程：填中转站地址 → 点 **Check station**
确认该站支持 TOIP → 填入当前 6 位口令（或一枚登记口令）→ 点 **Join station**。
页面随后显示你在哪个站、注册进了几个模型，并提供 **Disconnect** 清掉已存的令牌。

这个页面做的就是同一套接入，并把结果（`baseURL` / `apiKey` / `stationID` /
`models`）写进本插件的 settings 命名空间——也就是 provider 读取的那一份，
所以不需要再手工配任何东西。

同样的接入也可以用代码调：

```js
// 首接：用登记口令
const joined = await bridge.join({
  stationURL: 'http://192.168.1.10:8799',
  ticket: 'rhe_…',
  name: 'dsh-laptop',
})

// 重接：用滚动口令（控制台或验证器 App 读到的 6 位）
const again = await bridge.join({
  stationURL: 'http://192.168.1.10:8799',
  code: '123456',
})
```

`bridge` 是插件挂在 Cordis 上下文上的对象，名字是 `relayhubBridge`。接入结果
正好就是 provider 需要的四样东西：`baseURL`、`apiKey`、`stationID`、`models`
（`baseURL` 一定以 `/v1` 结尾，理由见英文部分）。

设置页会自动把它们写进配置；用代码调的话，自己把这四样填进插件配置即可。

### 3. 局域网自动发现

```js
const stations = await bridge.discover({ timeoutMs: 3000 })
```

广播的是中转站会应答的 `RELAYHUB-DISCOVER-v2` 探测包，应答里带 TOIP 能力块，
所以一次广播同时拿到「地址」与「能不能用口令接入」。广播不跨网段；
远端站点请直接填网址。

## 中转站上的插件日志

```bash
hubrelay toip logs list                      # 列出所有有日志的插件
hubrelay toip logs show dsh-relayhub-bridge  # 接入事件 + 汇总 + 最近调用
```

或打开中转站管理控制台的 **插件 / Plugins** 页。

日志行只有元数据：模型、协议、状态、token 数、延迟、IP。**两侧都不写
prompt/completion 文本。**

## 安全须知

- **会话令牌是真凭证**：它只进配置，本插件从不把它写进日志。中转站只存它的
  SHA-256。
- 本插件**不保存口令种子**，也从不自己算登记口令：它接受的是 30 秒后就过期的
  滚动口令。如果你为了省事存了种子，请像对待密码一样对待它。
- 明文 HTTP 下口令与令牌可被同网段看到——与 relay-hub 配对码相同的残余风险。
  不可信网络请在前面加 TLS。
- 吊销：在中转站执行 `hubrelay toip revoke <名称>`（会一并收回会话令牌）。
  轮换站点种子而不打扰在线会话：`hubrelay toip station --force`。

## 许可证

[MIT](./LICENSE)
