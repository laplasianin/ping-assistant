// Ping Assistant entry point: one process = MCP channel server + Slack poller + Telegram bot.
// Logs carry event kinds only, never message text.
import { dirname, join } from 'node:path'
import { Channel } from './channel'
import { loadConfig, loadSecrets } from './config'
import { Orchestrator } from './orchestrator'
import { SlackClient } from './slack/client'
import { Collector } from './slack/collector'
import { SlackSocket } from './slack/socket'
import { StateStore } from './state'
import { TelegramBot } from './telegram/bot'

const log = (kind: string): void => { process.stderr.write(`ping-assistant: ${kind}\n`) }

const cfg = loadConfig(process.env.PING_ASSISTANT_CONFIG ?? join(import.meta.dir, '..', 'ping-assistant.config.json'))
const secrets = loadSecrets()
const store = new StateStore(cfg.statePath)
const state = store.load()
const slack = new SlackClient(secrets.slackToken)
// The collector gets its own client: its per-tick request budget must never block a send or a pre-send thread check.
const collector = new Collector(new SlackClient(secrets.slackToken), cfg, state, join(dirname(cfg.statePath), 'files'))
const tg = new TelegramBot(secrets.telegramToken, cfg.telegramChatId)
// Socket Mode delivers messages within seconds; polling stays as reconciliation and as the fallback while it is down.
const socket = secrets.slackAppToken
  ? new SlackSocket(secrets.slackAppToken, { onEvent: (raw) => collector.enqueue(raw, raw.channelType) })
  : undefined
if (!socket) log('SLACK_APP_TOKEN not set, polling only')

// The channel needs the orchestrator's handlers and the orchestrator needs channel.notify.
let channel: Channel | undefined
const orchestrator = new Orchestrator({
  cfg, store, state, slack, collector, tg, socket,
  channel: { notify: (content, meta) => channel!.notify(content, meta) },
})
channel = new Channel(orchestrator.handlers())

await channel.connect()
orchestrator.start()
socket?.start()
log(`started${cfg.dryRun ? ' (dry-run)' : ''}, ${socket
  ? `socket mode: draining every ${cfg.drainSeconds}s, polling every ${cfg.socketReconcileTicks} ticks while connected`
  : `polling every ${cfg.pollSeconds}s`}`)
if (cfg.dryRun && cfg.selfDmTest) log('selfDmTest ON (dry-run): own messages in the self-DM become items')
tg.start().catch((err) => log(`telegram stopped: ${err instanceof Error ? err.name : 'unknown'}`))

// Self-test hook: one synthetic notification, to check that a channel event reaches the session.
if (process.env.PING_ASSISTANT_SELFTEST === '1') {
  setTimeout(() => { void channel!.notify(JSON.stringify({ text: 'selftest' }), { kind: 'selftest' }).then(() => log('selftest notification sent')).catch((err) => log('selftest notify failed: ' + (err instanceof Error ? err.name : 'error'))) }, 10_000).unref()
}

// Claude Code closing the connection EOFs stdin; exit instead of lingering as a zombie.
let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down')
  orchestrator.stop()
  socket?.stop()
  // A tick commits its cursors only at its end: let it finish, so the final save holds them (bounded: Slack calls time out at 30s).
  await Promise.race([orchestrator.idle(), new Promise((r) => setTimeout(r, 40_000).unref())])
  try { await tg.stop() } catch {}
  try { store.save(state) } catch (err) { log(`state save failed: ${err instanceof Error ? err.name : 'unknown'}`) }
  process.exit(0)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// Orphan watchdog: belt and braces for the stdin handlers above.
setInterval(() => {
  if (process.stdin.destroyed || process.stdin.readableEnded) void shutdown()
}, 5000).unref()
