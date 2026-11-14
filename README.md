# dsh-wecom-plugin

> Connect WeCom (WeChat Work) to DeepSeek Harness Desktop, **inside the host process**: list, read, continue, and approve the sessions that live in your desktop app — from your phone.

[中文说明](#中文说明) · A [Cordis](https://github.com/cordiverse/cordis) plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). The WeCom side uses the **Smart Robot (智能机器人) WebSocket long connection** — outbound only, so it needs no public IP, callback URL, TLS certificate, or trusted IP.

---

## Why a plugin instead of a bridge service

DSH Desktop sessions are owned by the host process's write handle. Any **other process** that tries to `resume` the same session is refused:

```
session "..." is already owned by an active write handle
```

The only place a phone can join the desktop session is therefore **inside the Desktop host process**. A plugin shares the desktop UI's Cordis container and Agent Runtime, so it naturally sees the same sessions and the same message stream, with no cross-process writes.

## How it works

```
WeCom app
   │  ① send a message
   ▼
openws.work.weixin.qq.com ──② long connection (outbound from this machine)──▶ dsh-wecom-plugin
                                                                             (inside the Desktop host process)
                                                                                │ ③ ctx.sessionQuery
                                                                                │    ctx.agents
                                                                                ▼
                                                                        Desktop Agent Runtime
                                                                                │
                                                                        ④ session events / tool runs
```

| Capability | Host API used |
|---|---|
| List sessions | `ctx.sessionQuery.listSessions()` |
| Read history | `ctx.sessionQuery.readSession(id)` |
| Get the live agent | `ctx.agents.get(sessionId)` |
| Resume a cold session | `ctx.agents.resume({ resumeSessionId, agentOptions })` |
| Deliver one turn of input | `agent.followup({ id, role: 'user', content, source: { kind: 'user' } })` |
| Approvals | `approval/request` waterfall responder |

## Requirements

- **DSH Desktop** `>=0.2.2-rc.1 <0.3.0` (tested on 0.2.2-rc.1, Windows) — declared via `engines.dsh`.
- **Node** `>=18.17` (bundled with DSH).
- A **WeCom Smart Robot** (企业微信 → 智能机器人): create one in the WeCom admin console and note its **BotId** and **Secret**.

## Installation

### A. Local checkout (development)

```powershell
cd dsh-wecom-plugin
.\install.ps1 -BotId "aib..." -Secret "gPJ..." -AllowUsers "zhangsan"
# or interactively:
.\install.ps1
```

The script links this checkout into `~/.dsh/profiles/desktop/node_modules` and appends a managed `insert:` block to `~/.dsh/profiles/desktop/cordis.patch.yml`. Uninstall with `.\install.ps1 -Uninstall`.

### B. Published package

Works on any DSH host (Windows Desktop, macOS, Linux, WSL, headless). Replace `<profile>` with the profile you use (`desktop`, `web`, `headless`, `acp`, …):

```bash
# Linux / macOS / WSL
dsh plugin --profile <profile> add dsh-wecom-plugin
```

```powershell
# Windows PowerShell
dsh plugin --profile <profile> add dsh-wecom-plugin
```

Then make the profile load it. Either use the DSH **Plugin Manager** (which reads this package's `dsh.bundle.patch`, i.e. [`cordis.patch.yml`](cordis.patch.yml), and composes it into the profile), or append the block manually to `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: wecom-bridge
      name: "dsh-wecom-plugin"
      config:
        botId: "aib..."
        secret: "gPJ..."
        allowUsers: ["<your WeCom UserID>"]
```

> A new plugin **must** go through `- insert:`; a bare top-level `- id:` row is treated by the loader as an override of a non-existent entry and silently ignored.

Restart the DSH host. Load diagnostics are written to `~/.dsh/wecom-plugin.log`:

```
apply() called; botId=set secret=set allowUsers=<your UserID>
正在连接 wss://openws.work.weixin.qq.com …
企业微信认证成功，开始接收消息
```

### C. Linux / WSL / headless hosts

The plugin is pure Node and fully cross-platform. Example for a WSL `web` profile, configured with environment variables instead of editing YAML:

```bash
export DSH_WECOM_BOT_ID=aib...
export DSH_WECOM_SECRET=gPJ...
export DSH_WECOM_ALLOW_USERS=LinTao   # comma separated; empty = allow everyone

dsh plugin --profile web add dsh-wecom-plugin
# insert the block above with an empty config: {}, then restart dsh
tail -f ~/.dsh/wecom-plugin.log      # expect: apply() called … 认证成功
```

Two things to keep in mind when running this on several hosts:

- **One WeCom bot = one connection.** The gateway kicks the older connection when a new one subscribes with the same BotId/Secret. Stop the plugin on the other host first, or use a separate bot per host.
- **Sessions are per host.** Each DSH installation has its own `~/.dsh` session store; `/sessions` lists the sessions of the host the plugin runs in, not another machine's.

## Configuration

Every value can come from the patch `config:` or from an environment variable (useful when installing as a bundle, which ships an empty config):

| Config key | Environment variable | Meaning | Default |
|---|---|---|---|
| `botId` | `DSH_WECOM_BOT_ID` | Smart Robot BotId | — (required) |
| `secret` | `DSH_WECOM_SECRET` | Smart Robot Secret | — (required) |
| `allowUsers` | `DSH_WECOM_ALLOW_USERS` (comma separated) | WeCom UserID whitelist; empty = allow everyone | `[]` |
| `wsUrl` | `DSH_WECOM_WS_URL` | Gateway URL (only if WeCom ever changes it) | `wss://openws.work.weixin.qq.com` |
| `provider` | `DSH_WECOM_PROVIDER` | Provider id used when resuming cold sessions | `deepseek-official` |
| `model` | `DSH_WECOM_MODEL` | Model id used when resuming cold sessions | `deepseek-flash` |
| `logPath` | `DSH_WECOM_LOG_PATH` | Diagnostic log location | `~/.dsh/wecom-plugin.log` |

## Commands

| Command | Effect |
|---|---|
| `/sessions` | List all Desktop sessions (title / short id / time / running / persisted / format status / cwd) |
| `/read <index> [count]` | Read a session's conversation history (read-only; runtime-injected context filtered out) |
| `/use <index\|sessionId>` | Bind a session; plain text is then delivered into it |
| `/status` | Current binding and running state |
| `/unuse` | Clear the binding |
| `/ping` `/id` `/debug` `/help` | Connectivity and diagnostics |

Approvals: tool operations that hit the `ask` policy are pushed to WeCom — reply `1` to allow once, `2` to reject (3 minutes without a reply cancels). Approvals for sessions nobody bound here stay answered by the desktop UI; the plugin does not take them over.

## Security

- `allowUsers` whitelist; non-whitelisted users are rejected before any session operation.
- Credentials live only in the profile's `cordis.patch.yml` (`~/.dsh/profiles/<profile>/cordis.patch.yml`, your machine, never committed). The log only records `set` / `MISSING`, never values.
- No inbound HTTP listener; a single outbound WSS connection.
- High-risk operations still go through the host's approval seam — the plugin only relays the question to a human.
- `/debug` prints session metadata (e.g. working directories). Only use it in trusted chats.

## Known limitations

- **No live two-way sync**: the phone sees the result after the turn finishes, not the desktop's in-progress stream.
- Approvals are visible on both ends; first answer wins.
- `/read` shows at most 30 messages, no pagination.
- One bound session per WeCom user.

## Development

```bash
npm test   # zero-dependency node:test suite, fully offline
```

```
lib/index.js         Cordis plugin: command routing, approval responder, session read/write
lib/session-format.js Pure helpers that render session events into WeCom-friendly text
lib/log.js           Diagnostic logger (path injectable for tests)
lib/aibot.js         WeCom Smart Robot client (auth / heartbeat / reconnect / streaming replies)
lib/ws-client.js     Zero-dependency RFC 6455 client (Node's built-in WebSocket fails the gateway handshake)
cordis.patch.yml     Bundle patch layer applied when installed as a bundle
install.ps1          Windows installer for local checkouts (also supports -Package and -Uninstall)
test/*.test.mjs      Offline unit + end-to-end tests (fake socket, no network)
docs/PHASES.md       Development history and pitfalls we hit
```

## Publishing a new version

1. Bump `version`, keep the `CHANGELOG.md` entry in sync.
2. Run `npm test`, then `npm publish` (the package is scoped-public by `publishConfig.access`).
3. The DSH plugin manager checks `engines.dsh` (and the DSH peer dependencies) against the running version before installing/activating; widen those ranges deliberately, not accidentally.
4. Optional: add an entry to a DSH **plugin market index** (format 1: `name`, localized `title`/`description`, `icon`, `versions` with `source`/`engines`) so the GUI can offer it.

## Compatibility

Tested against DSH Desktop **0.2.2-rc.1** (Windows). The plugin depends on the host-internal `sessionQuery` / `agents` / `approval` seams, which may change across versions — after a DSH upgrade, check `~/.dsh/wecom-plugin.log` for `认证成功`, and mind the `engines.dsh` range in `package.json`.

## License

[MIT](LICENSE)

---

<a id="中文说明"></a>
## 中文说明

在 **DSH Desktop Host 进程内**接入企业微信智能机器人，让手机能列出、查看、续跑桌面上的那条会话，并把需要审批的工具操作推到你手机上投票（回 `1` 允许一次、回 `2` 拒绝，3 分钟不回按取消）。

**为什么必须是进程内插件**：Desktop 的会话由它自己的进程持有写句柄，任何另一个进程去 `resume` 同一条会话都会被拒绝（`already owned by an active write handle`）。插件与桌面 UI 共享同一个 Cordis 容器与 Agent Runtime，天然看到同一批会话，也不会产生跨进程写入。

**通道**：企业微信「智能机器人」的 WebSocket 长连接，本机主动连出，不需要公网 IP / 回调 URL / TLS 证书 / 可信 IP。

**安装**（本地开发，Windows）：

```powershell
cd dsh-wecom-plugin
.\install.ps1 -BotId "aib..." -Secret "gPJ..." -AllowUsers "zhangsan"
# 或不带参数，脚本交互式询问；发布版可用 -Package "dsh-wecom-plugin"
```

脚本把本仓库 link 进 `~/.dsh/profiles/desktop/node_modules`，并向 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加受管理的 `- insert:` 配置块（新插件必须走 `- insert:`，顶层 `- id:` 会被 loader 静默忽略）。卸载：`.\install.ps1 -Uninstall`。

**发布包安装**（适用于任意 DSH 主机：Windows / macOS / Linux / WSL / headless，`<profile>` 换成你用的 profile 名，如 `desktop`、`web`、`headless`）：

```bash
dsh plugin --profile <profile> add dsh-wecom-plugin
```

然后用 DSH 插件管理页（会读取本包的 `dsh.bundle.patch`，即 `cordis.patch.yml`）或手工追加 insert 块。凭据也可用环境变量 `DSH_WECOM_BOT_ID` / `DSH_WECOM_SECRET` / `DSH_WECOM_ALLOW_USERS` 提供（headless / WSL 场景推荐）。

**Linux / WSL 注意**：插件是纯 Node，全平台可用；日志同样在 `~/.dsh/wecom-plugin.log`。同一个企业微信机器人只允许一条长连接——多台主机同时连会互踢，请停掉另一端或给每台主机各建一个机器人；每套 DSH 有独立的会话库，`/sessions` 列的是本机（本容器）的会话。

**命令**：`/sessions`（列表）、`/read <序号> [条数]`（只读历史）、`/use <序号|sessionId>`（绑定）、`/status`、`/unuse`、`/ping`、`/id`、`/debug`、`/help`。绑定后直接发文字即投递进该会话，与桌面端共用同一个 Runtime。

**已知边界**：没有实时双向同步（手机看到的是这一轮结束后的结果）；审批双端并存、先答先得；`/read` 一次最多 30 条；一次只能绑定一条会话。

**安全**：`allowUsers` 白名单；凭据只在本机 profile 配置里（日志只记 `set/MISSING`，不落明文）；无任何入站监听，只有一条出站 WSS；高风险操作仍走 Host 的审批 seam，插件只把询问转发给人。`/debug` 会回显会话元数据（如工作目录），请只在受信任的聊天里使用。

**开发**：`npm test`（零依赖 node:test，完全离线）。加载日志在 `~/.dsh/wecom-plugin.log`；升级 DSH 后先确认日志里仍出现「认证成功」。

License：MIT
