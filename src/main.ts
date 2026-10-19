// Ping Assistant entry point: one process = MCP channel server + Slack poller + Telegram bot.
// Logs carry event kinds only, never message text.
import { dirname, join } from 'node:path'
import { Channel } from './channel'
import { loadConfig, loadSecrets } from './config'
import { Orchestrator } from './orchestrator'
import { SlackClient } from './slack/client'
import { Collector } from './slack/collector'
import { StateStore } from './state'
import { TelegramBot } from './telegram/bot'

const log = (kind: string): void => { process.stderr.write(`ping-assistant: ${kind}\n`) }

const cfg = loadConfig(process.env.PING_ASSISTANT_CONFIG ?? join(import.meta.dir, '..', 'ping-assistant.config.json'))
const secrets = loadSecrets()
const store = new StateStore(cfg.statePath)
const state = store.load()
const slack = new SlackClient(secrets.slackToken)
const collector = new Collector(slack, cfg, state, join(dirname(cfg.statePath), 'files'))
const tg = new TelegramBot(secrets.telegramToken, cfg.telegramChatId)

// The channel needs the orchestrator's handlers and the orchestrator needs channel.notify.
let channel: Channel | undefined
const orchestrator = new Orchestrator({
  cfg, store, state, slack, collector, tg,
  channel: { notify: (content, meta) => channel!.notify(content, meta) },
})
channel = new Channel(orchestrator.handlers())

await channel.connect()
orchestrator.start()
log(`started${cfg.dryRun ? ' (dry-run)' : ''}, polling every ${cfg.pollSeconds}s`)
tg.start().catch((err) => log(`telegram stopped: ${err instanceof Error ? err.name : 'unknown'}`))

// Claude Code closing the connection EOFs stdin; exit instead of lingering as a zombie.
let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down')
  orchestrator.stop()
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
