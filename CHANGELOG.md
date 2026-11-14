# Changelog

All notable changes to this project are documented in this file.

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
