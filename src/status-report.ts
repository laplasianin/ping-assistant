// Telegram startup/shutdown reports. Plain text only; logs carry error names, never message text.
export type SlackMode = 'connected' | 'disconnected' | 'polling-only'
export type StartupInfo = {
  dryRun: boolean
  slack: SlackMode
  /** auth.test outcome: the account, or the error text. */
  account: { user: string; team?: string } | { error: string }
  /** PING_ASSISTANT_MODEL when the launcher exported it. */
  model?: string
  openItems: number
}

export const STARTUP_DELAY_MS = 20_000
export const SHUTDOWN_TIMEOUT_MS = 2_000
export const SHUTDOWN_TEXT = '⏹ Ping Assistant остановлен'

const SLACK_LINE: Record<SlackMode, string> = {
  connected: 'сокет подключён',
  disconnected: 'сокет не подключён, работаю опросом',
  'polling-only': 'опрос (SLACK_APP_TOKEN не задан)',
}

export function startupReport(info: StartupInfo): string {
  const account = 'error' in info.account
    ? `Slack: ошибка авторизации (${info.account.error})`
    : `Slack-аккаунт: ${info.account.user}`
  return [
    '✅ Ping Assistant запущен',
    `режим: ${info.dryRun ? 'dry-run (в Slack ничего не уходит)' : 'боевой'}`,
    `Slack: ${SLACK_LINE[info.slack]}`,
    account,
    `модель сессии: ${info.model || 'по умолчанию (см. лаунчер)'}`,
    `открытых вопросов: ${info.openItems}`,
  ].join('\n')
}

export type Timers = {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}
const realTimers: Timers = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/**
 * Sends the startup report once: after Telegram polls AND (Slack said hello OR delayMs passed since construction).
 * A failed send is logged by error name and never propagates.
 */
export class StartupReporter {
  private telegramUp = false
  private slackReady = false
  private fired = false
  private readonly timer: unknown

  constructor(private readonly o: {
    collect: () => Promise<StartupInfo>
    send: (text: string) => Promise<unknown>
    log: (kind: string) => void
    delayMs?: number
    timers?: Timers
  }) {
    const timers = o.timers ?? realTimers
    this.timer = timers.set(() => { this.slackReady = true; this.maybeFire() }, o.delayMs ?? STARTUP_DELAY_MS)
    this.timers = timers
  }
  private readonly timers: Timers

  telegramStarted(): void { this.telegramUp = true; this.maybeFire() }
  slackHello(): void { this.slackReady = true; this.maybeFire() }

  private maybeFire(): void {
    if (this.fired || !this.telegramUp || !this.slackReady) return
    this.fired = true
    this.timers.clear(this.timer)
    void (async () => {
      try { await this.o.send(startupReport(await this.o.collect())) } catch (err) {
        this.o.log(`startup report failed: ${err instanceof Error ? err.name : 'unknown'}`)
      }
    })()
  }
}

/** Best-effort stop notice: never throws, never waits longer than timeoutMs. */
export async function notifyStopped(
  send: (text: string) => Promise<unknown>, timeoutMs = SHUTDOWN_TIMEOUT_MS, timers: Timers = realTimers,
): Promise<void> {
  let handle: unknown
  const timeout = new Promise<void>((r) => { handle = timers.set(r, timeoutMs) })
  try { await Promise.race([send(SHUTDOWN_TEXT).then(() => {}, () => {}), timeout]) } finally { timers.clear(handle) }
}
