# Changelog

All notable changes to this project are documented in this file.

## [1.1.0] - 2026-11-20

### Added

- **免绑定**：未绑定用户的第一条普通消息会在 Host 内自动开一条新会话并直接投递
  （工作目录默认沿用最近一条会话的 cwd，可用 `newSessionCwd` /
  `DSH_WECOM_NEW_SESSION_CWD` 覆盖），并推送一条「已自动开新会话」说明。
  创建与接回冷会话都走 `sessionController`（桌面「新建会话」的同一条路：
  预设组合、默认模型、shell 等工具齐全）；没有该服务的宿主退回
  `agents.create/resume` + `agentPresets` 手工组合。
- 绑定持久化到 `~/.dsh/wecom-plugin-bindings.json`（可用 `bindingsPath` /
  `DSH_WECOM_BINDINGS_PATH` 覆盖）：桌面重启后自动接回；旧会话已不存在时自动换新。
- **追问转发**：绑定会话的 `user-questions/request`（`ask_user_question`，如
  「ssh 到哪台机器」的选项）推到手机逐题作答——回序号、多选逗号分隔或自定义
  文本；`questionTimeoutMs`（默认 3 分钟，可用 `DSH_WECOM_QUESTION_TIMEOUT_MS`
  覆盖）内未答则交回桌面端。
- 新增 `lib/bindings.js`（串行化原子落盘；损坏文件按空处理并自动重建；
  load 与 set 并发时内存更新优先）与 `test/autobind.test.mjs`、
  `test/bindings.test.mjs`、`test/questions.test.mjs`。

### Changed

- `/use`、`/unuse` 现在同步更新持久化绑定；`/help`、`/status`、`/sessions`
  的文案说明自动绑定行为；`/use` 不再是开始讨论的前置条件。
- `install.ps1` 新增 `-NewSessionCwd`、`-BindingsPath` 参数。
- README（中英）与 `cordis.patch.yml` 注释同步新配置项。

### Fixed

- 桌面版重启后绑定全部丢失、必须重新 `/use` 才能继续讨论的问题。
- **自动开的会话没有 shell 能力**：此前直连 `agents.create` 绕过了预设组合，
  工具没有挂载；现在创建与接回都走 `sessionController`，与桌面新建会话一致。
- **桌面端弹出审批时企业微信收不到**：`dsh-api-remotes` 把 `approval/request`
  桥接成远程瀑布事件，Web UI 先注册并在弹窗期间挂住瀑布流，插件永远排在后
  面；监听器现以 `prepend` 注册，绑定会话的审批优先到达企业微信（投票期间
  桌面端不再弹同一个请求），未绑定会话照旧交回桌面 UI。
- **桌面端弹出「选择方案」追问时企业微信收不到**：此前插件只接
  `approval/request`，没接 `user-questions/request`；现在同样以 `prepend`
  注册追问应答者，行为与审批一致（未绑定 / 微信掉线 / 超时均交回桌面端）。
- `BindingsStore.load()` 会用磁盘内容整体覆盖内存，导致「启动瞬间就收到
  `/use`」时刚设置的绑定被冲掉；现改为合并、内存更新优先。

## [1.0.0] - 2026-11-14

First public release.

### Added

- Public npm metadata: `engines.dsh` compatibility range, `dsh` manifest with
  `cordis.patch.yml` bundle patch, DSH peer dependencies, `publishConfig`.
- Bilingual README (English + 中文) with install, config, security, and
  publishing guides.
- `install.ps1` `-Package` mode (install the published package by name),
  `-WsUrl` / `-Provider` / `-Model` options, and dsh CLI auto-detection.
- Offline `node:test` suite: pure helpers, aibot queue/ack semantics, approval
  delegation, and an end-to-end fake-socket command routing test.
- GitHub Actions CI workflow; `.editorconfig`; `CHANGELOG.md`.

### Changed

- Pure session-rendering helpers moved to `lib/session-format.js`; logger moved
  to `lib/log.js` with an injectable path (tests no longer touch the real
  `~/.dsh/wecom-plugin.log`).
- Removed module-load side effects: the log no longer records "module imported"
  every time the file is imported (e.g. by tests).
- `allowUsers` now normalizes YAML lists, comma-separated strings, and the
  `DSH_WECOM_ALLOW_USERS` env var; a plain string no longer substring-matches.
- Replies are threaded per inbound `req_id` instead of per user, so interleaved
  messages no longer cross their streaming bubbles.
- Handler failures now surface an error message in WeCom instead of being
  silently swallowed.
- Renamed `lib/aibot.mjs` → `lib/aibot.js`, `lib/ws-client.mjs` →
  `lib/ws-client.js` (the package is ESM throughout).

### Fixed

- `AibotClient`: frames still queued (not yet sent) when the connection drops
  are now rejected — callers' promises can no longer hang.
- `AibotClient`: late events from a replaced socket are ignored (socket identity
  guard), so a reconnect can no longer be disturbed or new frames rejected by
  the old connection's close event.
- `WsSocket`: `close()` during the HTTP handshake now aborts the request
  instead of leaking a half-open connection.
- `WsSocket`: inbound frames are capped (16 MiB default) against unbounded
  memory growth; `ws://` is supported for local testing.
- Approval flow: the vote window opens immediately after the prompt is queued
  instead of waiting on the gateway ack; a second pending approval for the same
  user is delegated to the desktop UI instead of silently dropping the first.

## [0.3.0] - 2026-11

- Phase 3: continue sessions from WeCom (`/use` + plain text via
  `ctx.agents.resume` / `agent.followup`) and approval forwarding to WeCom.

## [0.2.0] - 2026-11

- Phase 2: `/use` binding, `/read` history, `/status`, `/unuse`.

## [0.1.0] - 2026-11

- Phase 1: in-process plugin boots inside the Desktop host, `/sessions`
  read-only discovery, `/debug`, `/ping`.
