# CLI WeChat Bridge

**CLI WeChat Bridge** lets one WeChat iLink account or one WeChat smart-bot account drive local CLI agents from a normal project directory. It keeps the local CLI as the main working interface while letting you drive it from a remote chat channel (WeChat, WeCom, Telegram, QQ, or local loopback).

Project home: https://github.com/UNLINEARITY/CLI-WeChat-Bridge  
Package names (identical content): `cli-wechat-bridge` (primary), `@unlinearity/cli-wechat-bridge` (compatibility mirror), `cli-chat-bridge` (upcoming name).  
License: AGPL-3.0-or-later.

---

## What this project does

CLI WeChat Bridge lets one WeChat iLink account or one WeCom smart-bot account drive local CLI agents from a normal project directory. The user-facing npm package is `cli-wechat-bridge`; `@unlinearity/cli-wechat-bridge` is kept as a compatibility mirror for existing users.

One daemon engine (`src/daemon`) runs every bridge; there is no separate standalone bridge runtime. It has two user-facing modes:
- **`wechat-daemon`** (resident service): the preferred long-lived mode. It owns the channel connection, keeps Codex, Claude Code, OpenCode, and Pi slots for several workspaces, and starts with no bridge mode until the first window opens. Remote opens use the current window's workspace, or the home workspace (the daemon's startup directory) while no window is open.
- **`wecom-daemon`**: the equivalent long-lived mode for the official WeCom smart-bot WebSocket channel; it uses the same adapter slots and command grammar with WeCom-specific credentials and conversation state.
- **Direct launchers** (single-bridge mode): `wechat-codex`, `wechat-claude`, `wechat-opencode`, `wechat-pi` and their `wecom-*`/`telegram-*` counterparts run the CLI in the current terminal. They join the channel's running daemon, or start an ephemeral one (`--ephemeral`) whose slots follow their windows and which exits after the last window closes; a second launcher simply joins it.

**Progressive bridge modes** (`src/daemon/bridge-mode.ts`): every bridge starts as a clean single bridge (L0, no prefixes, single-CLI commands only) and only moves up until the daemon exits. In the first window's workspace another CLI type leads to multi-CLI mode (L1, `/codex` etc.), the same type to numbered multi-instance mode (L2, `/1` `/2`, `/open`); L1 and L2 never mix. A window in any other workspace leads to the unrestricted multi-workspace mode (L3, `/cd`).

Runtime data now lives under `~/.cli-bridge` by default. Legacy data is copy-migrated from `~/.claude/channels/wechat` and from `CLAUDE_WECHAT_CHANNEL_DATA_DIR` only as a migration source. Use `CLI_BRIDGE_DATA_DIR` for the active data directory.

---

## Supported CLIs

| Adapter | Status | Notes |
|---------|--------|-------|
| Codex | Validated | Codex validated range: 0.149.x through 0.161.x |
| Claude Code | Latest stable | Validated via capability probes, not version ranges |
| OpenCode | Latest stable | Validated via capability probes |
| Pi | Latest stable | Pi 0.85 requires Node.js >= 22.19.0 |

---

## Remote control commands (channel-neutral)

| Command | Meaning |
|---------|---------|
| `/status` | Bridge/daemon state |
| `/codex`, `/claude`, `/opencode`, `/pi` | Switch to that CLI; optional prompt after name is forwarded |
| `/cd` | Switch current workspace (multi-workspace mode L3) |
| `/cd <number>` / `/cd <name>` | Switch to a numbered or named workspace |
| `/open` | Open current workspace in current directory |
| `/1`, `/2` | Switch to numbered instance 1 or 2 (L2 mode) |
| `/status` | Show daemon and slot status |
| `/think on` / `/off` | Toggle full thinking/tool_call push |
| `/confirm` / `/yes` [n] | Approve approval request |
| `/always` [n] | Auto-approve that request type |
| `/deny` / `/no` [n] [reason] | Reject approval request |
| `/abort` [n] | Abort task |
| `/answer` [text] | Answer pending user-input request |
| `/model` / `/model <name>` | Switch model |
| `/plan` [on/off] | Toggle plan mode |
| `/all <text>` | Broadcast to all active workspaces (L3) |
| `/resume` [session] | Restore an already-persisted session |
| `/reset` | Reset current session |
| `/stop` | Stop the daemon |

See `docs/command-audit.md` for the full command audit.

---

## Installation

```bash
npm install -g cli-wechat-bridge@latest
```

or use the compatibility mirror / upcoming name:

```bash
npm install -g @unlinearity/cli-wechat-bridge@latest
npm install -g cli-chat-bridge@latest
```

All three packages expose the same commands; install only one. Switching names requires uninstalling the current package first (npm otherwise fails with `EEXIST`). Reinstall hints name the package you actually installed.

After every code build, install the fresh build to global so the owner always tests the newest code:

```bash
npm install -g .
```

When npm blocks the package postinstall script with `allowScripts`, restore the node-pty spawn-helper permission manually:

```bash
node "$(npm root -g)/cli-wechat-bridge/scripts/ensure-node-pty-permissions.mjs"
```

---

## Quick start

### 1. Pair your channel

**WeChat** (iLink setup):
```bash
wechat-setup
```

**WeCom** (smart-bot WebSocket):
```bash
wecom-setup
```

**Telegram** (Bot API long-poll):
```bash
telegram-setup
```

**Telegram** (Bot API long-poll):
```bash
telegram-setup
```

**Local** (credential-free loopback for tests):
No credentials needed; uses inbox/transcript files.

### 2. Start in your project directory

```bash
cd /path/to/your/workspace
wechat-codex        # or wechat-claude, wechat-opencode, wechat-pi
```

The first direct launcher starts an ephemeral daemon if none answers. Direct launchers never replace a running daemon: they join it, or start an ephemeral daemon when none answers.

Or start the resident daemon first:
```bash
wechat-daemon       # or wecom-daemon, telegram-daemon
```

Then in the remote chat channel:

```
/codex
/claude
/opencode
/pi
```

---

## Key behaviors

- **Think output**: OpenCode-style thinking fragments are buffered and sent with a `[思考]` / `[Thinking]` prefix. Default mode buffers; `/think on` pushes full text immediately.
- **Tool calls**: Emitted immediately with tool name and preview args. Tool buffers flush before final replies so output order matches actual event order.
- **Session following**: Codex 0.155+ persists threads lazily; visible clients start fresh (`new`) by default. Restores available through `--session-start-mode restore`, `/resume`, and reuse of already connected windows.
- **Daemon switching**: Direct launchers join a running daemon instead of replacing it. Stale daemon endpoints are auto-cleared.

---

## Development

```bash
bun install
npm run setup
npm run check
npm run lint
npm run typecheck:src
npm run build
npm run quality
bun test test
```

---

## Package publishing

Three names with identical content: `cli-wechat-bridge`, `@unlinearity/cli-wechat-bridge`, `cli-chat-bridge`.

```bash
npm run publish:dual -- --dry-run
npm run publish:dual -- --otp <code>
```

## License

This repository is AGPL-3.0-or-later. Every source file starts with an SPDX copyright header that must be kept intact in new files and modifications; never remove or alter it. Any contributor or AI agent making modifications that are later distributed or served over a network must release the complete corresponding source under AGPL-3.0-or-later (see README License section).

See `LICENSE.txt`.

---

## Documentation

- `docs/releases/<version>.md` — release notes
- `docs/releases/<version>_CN.md` — Chinese release notes
- `docs/architecture.md` — architecture overview
- `docs/development.md` — development commands
- `docs/configuration.md` — configuration
- `docs/command-audit.md` — command audit

---

## Commit guidance

All commits require explicit owner approval first. Use Conventional Commit prefixes such as `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `build:`, `chore:`. Keep subjects imperative and behavior-focused.

---

## Quality gates

```bash
npm run lint
npm run typecheck:src
bun test test
npm run build
npm run quality
```

---

*Internal planning/audit/research documents are local-only and must never be staged, committed, pushed, or packaged.*