# Ping Assistant

Bun/TypeScript MCP channel server for Claude Code: watches Slack, pushes items into a
session via `notifications/claude/channel`, talks to the user through a Telegram bot.
Design: `docs/superpowers/specs/2026-10-19-ping-assistant-design.md`.

## Setup

```bash
bun install
bunx tsc --noEmit
```

## Run a session with the local plugin

```bash
claude --plugin-dir . --channels plugin:ping-assistant@local
```

`bun` must be on `PATH` of the shell that launches `claude`.

## Channel protocol spike (Task 1)

Confirmed names: notification method `notifications/claude/channel`, capability
`experimental['claude/channel']`, params `{ content, meta }`.
The spike server (`src/main.ts`) exposes a `ping` tool (returns `pong`) and emits a
`tick` notification every 20 s (`PING_TICK_MS` overrides).

Results:
- Protocol level (`bun run scripts/spike-check.ts`): server advertises the capability,
  `tools/list` returns `ping`, `ping` returns `pong`, and a `notifications/claude/channel`
  tick (`content: "tick"`, `meta: {source: "ping-assistant", kind: "tick"}`) arrives.
- `--channels plugin:ping-assistant` is rejected by the CLI ("entries must be tagged:
  plugin:<name>@<marketplace>"). `plugin:ping-assistant@local` is accepted with `--plugin-dir .`.
- Headless `claude -p` with the plugin loaded: the `ping` tool is reachable (the plugin
  tool name is `mcp__plugin_ping-assistant_ping-assistant__ping`). Without an allow rule it
  is denied by the permission prompt; with
  `--allowedTools mcp__plugin_ping-assistant_ping-assistant__ping` the reply was `pong`.
- NOT verified: the `<channel source="ping-assistant" ...>tick</channel>` message waking an
  interactive session (needs a human terminal; `-p` mode ends after the turn). Check manually
  once with the command above before relying on it; fallback is spec section 4
  (`/loop 1m` + `next_items` tool).
