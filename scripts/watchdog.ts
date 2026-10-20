// Telegram watchdog: run from launchd every few minutes. Alerts when the Ping Assistant server
// (`bun run src/main.ts`) is not running, at most once per hour; announces recovery once.
// Exits 0 always. Never logs tokens or message text.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { loadConfig, loadSecrets } from '../src/config'

export const ALERT_TEXT = '⚠️ Ping Assistant не запущен. Открой «Ping Assistant.command» или запусти bin/ping-assistant-session'
export const RECOVERY_TEXT = '✅ Ping Assistant снова работает'
export const ALERT_INTERVAL_MS = 60 * 60 * 1000

export type WatchdogState = { lastAlertAt?: number }
export type Decision = { action: 'alert' | 'recover' | 'none'; next: WatchdogState }

/** Pure decision: `next` is the state to persist once the action's message was delivered. */
export function decide(running: boolean, now: number, state: WatchdogState): Decision {
  if (running) {
    return state.lastAlertAt === undefined ? { action: 'none', next: state } : { action: 'recover', next: {} }
  }
  if (state.lastAlertAt === undefined || now - state.lastAlertAt > ALERT_INTERVAL_MS) {
    return { action: 'alert', next: { lastAlertAt: now } }
  }
  return { action: 'none', next: state }
}

export function parseState(text: string): WatchdogState {
  try {
    const v: unknown = JSON.parse(text)
    const at = (v as { lastAlertAt?: unknown } | null)?.lastAlertAt
    return typeof at === 'number' && Number.isFinite(at) ? { lastAlertAt: at } : {}
  } catch {
    return {}
  }
}

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(p.stdout).text()
  return { code: await p.exited, out }
}

/** A `bun run src/main.ts` process whose cwd is this repo. If the cwd can't be read, count it as ours. */
export async function serverRunning(repo: string): Promise<boolean> {
  const pg = await run(['pgrep', '-f', 'bun run src/main.ts'])
  const pids = pg.out.split(/\s+/).filter((s) => /^\d+$/.test(s) && Number(s) !== process.pid)
  for (const pid of pids) {
    const l = await run(['lsof', '-a', '-d', 'cwd', '-p', pid, '-Fn'])
    const cwd = l.out.split('\n').find((x) => x.startsWith('n'))?.slice(1)
    if (!cwd || resolve(cwd) === repo) return true
  }
  return false
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const repo = resolve(dirname(import.meta.path), '..')
  const statePath = join(homedir(), '.config', 'ping-assistant', 'watchdog.json')
  let state: WatchdogState = {}
  try { state = parseState(readFileSync(statePath, 'utf8')) } catch { /* no state yet */ }

  const running = await serverRunning(repo)
  const decision = decide(running, Date.now(), state)
  if (decision.action === 'none') return

  const config = loadConfig(join(repo, 'ping-assistant.config.json'))
  const { telegramToken } = loadSecrets()
  const ok = await sendTelegram(telegramToken, config.telegramChatId, decision.action === 'alert' ? ALERT_TEXT : RECOVERY_TEXT)
  console.log(`watchdog: ${decision.action} ${ok ? 'sent' : 'send failed'}`)
  if (!ok) return // keep the state, so the next run retries
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify(decision.next))
}

if (import.meta.main) {
  try { await main() } catch (err) { console.error('watchdog error:', err instanceof Error ? err.message : 'unknown') }
  process.exit(0)
}
