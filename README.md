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
| Create a session | `ctx.sessionController.create({ cwd })` — the Desktop UI's own "new session" path: preset composition, default model, shell and other tools |
| Get / resume the live agent | `ctx.sessionController.resolveAgent(sessionId)` |
| Deliver one turn of input | `agent.followup({ id, role: 'user', content, source: { kind: 'user' } })` |
| Approvals | `approval/request` waterfall responder |

Hosts without a session controller (headless profiles) degrade to `ctx.agents`
plus manual `agentPresets` composition, and to `ctx.agents` alone when no preset
roster is mounted.

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
| `provider` | `DSH_WECOM_PROVIDER` | Provider id for sessions the plugin resumes itself (hosts without a session controller; the Desktop path uses the host default) | `deepseek-official` |
| `model` | `DSH_WECOM_MODEL` | Model id, same fallback scope as `provider` | `deepseek-flash` |
| `newSessionCwd` | `DSH_WECOM_NEW_SESSION_CWD` | Working directory for auto-created sessions (absolute path) | newest session's cwd |
| `bindingsPath` | `DSH_WECOM_BINDINGS_PATH` | Where user bindings persist | `~/.dsh/wecom-plugin-bindings.json` |
| `questionTimeoutMs` | `DSH_WECOM_QUESTION_TIMEOUT_MS` | How long a user question waits for a WeCom answer before being handed back to the Desktop UI | `180000` |
| `logPath` | `DSH_WECOM_LOG_PATH` | Diagnostic log location | `~/.dsh/wecom-plugin.log` |

## Commands

| Command | Effect |
|---|---|
| `/sessions` | List all Desktop sessions (title / short id / time / running / persisted / format status / cwd) |
| `/read <index> [count]` | Read a session's conversation history (read-only; runtime-injected context filtered out) |
| `/use <index\|sessionId>` | Switch the binding (optional — see below) |
| `/status` | Current binding and running state |
| `/unuse` | Clear the binding |
| `/ping` `/id` `/debug` `/help` | Connectivity and diagnostics |

**No binding ceremony.** The first plain-text message from a user with no binding
auto-creates a new session inside the host — through the Desktop's own
`sessionController` path, so it gets the same preset composition (shell and other
tools) and default model as a Desktop session (working directory inherited from
the newest session, or `newSessionCwd`) — and delivers the message into it.
Bindings are persisted to `~/.dsh/wecom-plugin-bindings.json`; after a Desktop
restart the plugin re-binds automatically, or creates a fresh session if the old
one is gone. `/unuse` clears the binding — the next plain message auto-creates
again.

Approvals: tool operations that hit the `ask` policy are pushed to WeCom for every
session bound to a WeCom user — reply `1` to allow once, `2` to reject (3 minutes
without a reply cancels). The plugin's waterfall listener is registered with
`prepend`, so for bound sessions the approval reaches WeCom **before** the Web UI
bridge can hold it; while the vote is open the Desktop UI does not pop the same
request. Approvals for sessions nobody bound here stay answered by the desktop
UI; the plugin does not take them over.

User questions (`ask_user_question` — e.g. choosing among several options, as
when a command is ambiguous) follow the same route: bound sessions receive the
numbered choices on WeCom and answer with a number (comma-separated numbers for
multi-select) or free text; unanswered questions are handed back to the Desktop
UI after `questionTimeoutMs`.

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
- One bound session per WeCom user (auto-created on first message, re-bound automatically after a restart).

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

在 **DSH Desktop Host 进程内**接入企业微信智能机器人，让手机能列出、查看、续跑桌面上的那条会话，并把需要审批的工具操作**优先**推到你手机上投票（回 `1` 允许一次、回 `2` 拒绝，3 分钟不回按取消；投票期间桌面端不再弹同一个请求，未绑定会话的审批仍由桌面 UI 处理）。

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

**命令**：`/sessions`（列表）、`/read <序号> [条数]`（只读历史）、`/use <序号|sessionId>`（换绑，可省略）、`/status`、`/unuse`、`/ping`、`/id`、`/debug`、`/help`。**免绑定**：没有绑定时直接发文字，插件会走**桌面「新建会话」同一条路**（`sessionController`）在 Host 内自动开一条新会话——预设组合、默认模型、shell 等工具与桌面端一致（工作目录默认沿用最近一条会话的 cwd，可用 `newSessionCwd` / `DSH_WECOM_NEW_SESSION_CWD` 覆盖），并回一条「已自动开新会话」说明；绑定关系落盘在 `~/.dsh/wecom-plugin-bindings.json`（可用 `bindingsPath` / `DSH_WECOM_BINDINGS_PATH` 覆盖），桌面重启后自动接回（接回同样走 `sessionController.resolveAgent`，带预设），旧会话已不存在时自动换新。`/use` 仍可用于手动切换，`/unuse` 解除后下一条消息会重新自动开会话。

**审批与追问**：绑定会话的审批和 `ask_user_question` 追问（比如「ssh 到哪台机器」要选方案）都会**先**推到手机——审批回 `1` 允许一次 / `2` 拒绝，追问回序号（多选逗号分隔）或自定义内容。插件的监听器以 `prepend` 注册，抢在 Web UI 的远程瀑布桥前面，作答期间桌面端不再弹同一个请求。未绑定会话、微信掉线、或超时（审批 3 分钟；追问 `questionTimeoutMs`，默认 3 分钟）未答时，请求交回桌面 UI。

**已知边界**：没有实时双向同步（手机看到的是这一轮结束后的结果）；`/read` 一次最多 30 条；每个用户一次只绑定一条会话（未绑定时发消息会自动开会话）。

**安全**：`allowUsers` 白名单；凭据只在本机 profile 配置里（日志只记 `set/MISSING`，不落明文）；无任何入站监听，只有一条出站 WSS；高风险操作仍走 Host 的审批 seam，插件只把询问转发给人。`/debug` 会回显会话元数据（如工作目录），请只在受信任的聊天里使用。

**开发**：`npm test`（零依赖 node:test，完全离线）。加载日志在 `~/.dsh/wecom-plugin.log`；升级 DSH 后先确认日志里仍出现「认证成功」。

License：MIT
