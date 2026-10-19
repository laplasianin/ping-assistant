import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Bot, GrammyError } from 'grammy'
import type { Update, UserFromGetMe } from 'grammy/types'
import { parseCallback, parseText, type Command } from '../commands'
import { chunk, type Keyboard } from '../format'

export type Inbound = { cmd: Command; messageId: number; quotedMessageId?: number }

type Opts = Record<string, unknown>
export interface TelegramApi {
  sendMessage(chatId: string, text: string, opts?: Opts): Promise<{ message_id: number }>
  editMessageText(chatId: string, messageId: number, text: string, opts?: Opts): Promise<unknown>
  editMessageReplyMarkup(chatId: string, messageId: number, opts?: Opts): Promise<unknown>
  answerCallbackQuery(id: string, opts?: Opts): Promise<unknown>
}

const DEFAULT_PID_FILE = join(homedir(), '.config', 'ping-assistant', 'bot.pid')
const HELP = 'Ping Assistant: отвечай на вопросы из Slack кнопками или текстом («14 1», «14: свой текст», «14 пропустить»).'

const STABLE_MS = 60_000
const MAX_CONFLICTS = 8

export type PollingHooks = {
  startPolling?: (onStart: () => void) => Promise<void>
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  pidFile?: string
  log?: (kind: string) => void
}

const markup = (kb: Keyboard) => ({
  inline_keyboard: kb.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data }))),
})

const defaultLog = (kind: string): void => { process.stderr.write(`telegram: ${kind}\n`) }

export class TelegramBot {
  private readonly bot: Bot
  private readonly api: TelegramApi
  private readonly items = new Map<number, string>()
  private handler: (i: Inbound) => Promise<void> = async () => {}
  private stopping = false
  private abort: AbortController | undefined
  private readonly startPolling: (onStart: () => void) => Promise<void>
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly pidFile: string
  private readonly log: (kind: string) => void

  constructor(token: string, private readonly chatId: string, api?: TelegramApi, hooks: PollingHooks = {}) {
    // With an injected api no network is needed: give grammY fake botInfo so handleUpdate works without init.
    const botInfo = { id: 1, is_bot: true, first_name: 'test', username: 'test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false } as unknown as UserFromGetMe
    this.bot = new Bot(token, api ? { botInfo } : {})
    this.api = api ?? (this.bot.api as unknown as TelegramApi)
    this.startPolling = hooks.startPolling ?? ((onStart) => this.bot.start({ onStart }))
    this.sleep = hooks.sleep ?? abortableSleep
    this.pidFile = hooks.pidFile ?? DEFAULT_PID_FILE
    this.log = hooks.log ?? defaultLog
    this.wire()
  }

  onInbound(handler: (i: Inbound) => Promise<void>): void {
    this.handler = handler
  }

  registerMessage(messageId: number, itemId: string): void {
    this.items.set(messageId, itemId)
  }

  resolveItemId(quotedMessageId: number): string | undefined {
    return this.items.get(quotedMessageId)
  }

  async send(text: string, keyboard?: Keyboard, replyTo?: number): Promise<number> {
    const parts = chunk(text)
    let last = 0
    for (const [i, part] of parts.entries()) {
      const opts: Opts = {}
      if (i === 0 && replyTo !== undefined) opts.reply_parameters = { message_id: replyTo }
      if (i === parts.length - 1 && keyboard) opts.reply_markup = markup(keyboard)
      last = (await this.api.sendMessage(this.chatId, part, opts)).message_id
    }
    return last
  }

  async edit(messageId: number, text: string, keyboard?: Keyboard): Promise<void> {
    // An explicit empty keyboard is the documented way to drop the buttons.
    await this.api.editMessageText(this.chatId, messageId, text, { reply_markup: markup(keyboard ?? []) })
  }

  /** Feed a raw Telegram update through the same handlers production polling uses. */
  async ingest(update: Update): Promise<void> {
    await this.bot.handleUpdate(update)
  }

  private wire(): void {
    const allowed = (chatId: number | undefined, fromId: number | undefined) =>
      String(chatId) === this.chatId && String(fromId) === this.chatId

    this.bot.command(['start', 'help'], async (ctx) => {
      if (!allowed(ctx.chat.id, ctx.from?.id)) return
      await this.api.sendMessage(this.chatId, HELP)
    })

    this.bot.on('message:text', async (ctx) => {
      const { message } = ctx
      if (!allowed(message.chat.id, message.from?.id)) return
      if (message.text.startsWith('/')) return
      const quotedMessageId = message.reply_to_message?.message_id
      const quotedItem = quotedMessageId === undefined ? undefined : this.resolveItemId(quotedMessageId)
      await this.handler({
        cmd: parseText(message.text, quotedItem),
        messageId: message.message_id,
        ...(quotedMessageId !== undefined ? { quotedMessageId } : {}),
      })
    })

    this.bot.on('callback_query:data', async (ctx) => {
      const q = ctx.callbackQuery
      if (!allowed(q.message?.chat.id, q.from.id)) {
        await this.api.answerCallbackQuery(q.id, { text: 'Not authorized' })
        return
      }
      const cmd = parseCallback(q.data)
      try {
        await this.api.answerCallbackQuery(q.id)
      } catch (err) {
        this.log(`answerCallbackQuery failed: ${err instanceof Error ? err.name : 'unknown'}`) // stale query must not drop the command
      }
      if (!cmd || !q.message) return
      await this.handler({ cmd, messageId: q.message.message_id })
    })

    this.bot.catch((err) => this.log(`handler error (polling continues): ${err.error instanceof Error ? err.error.name : 'unknown'}`))
  }

  async start(): Promise<void> {
    this.claimPidFile()
    await this.poll()
  }

  /** Polling loop with backoff; gives up after 8 consecutive 409s. Exposed for tests (no PID file side effects). */
  async poll(): Promise<void> {
    this.stopping = false
    this.abort = new AbortController()
    const { signal } = this.abort
    let failures = 0
    let conflicts = 0
    let stable: ReturnType<typeof setTimeout> | undefined
    try {
      while (!this.stopping) {
        try {
          await this.startPolling(() => {
            // onStart fires before the first getUpdates, so a 409 can still follow: only forgive after a quiet period.
            stable = setTimeout(() => { failures = 0; conflicts = 0 }, STABLE_MS)
            stable.unref?.()
            this.log('polling')
          })
          return
        } catch (err) {
          clearTimeout(stable)
          if (this.stopping) return
          failures++
          const is409 = err instanceof GrammyError && err.error_code === 409
          if (is409 && ++conflicts >= MAX_CONFLICTS) {
            this.log('409 Conflict persists, another poller holds the token; giving up')
            return
          }
          const delay = Math.min(1000 * failures, 15_000)
          this.log(`${is409 ? '409 Conflict' : 'polling error'}, retrying in ${delay / 1000}s`)
          await this.sleep(delay, signal)
        }
      }
    } finally {
      clearTimeout(stable)
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.abort?.abort()
    try {
      await this.bot.stop()
    } finally {
      try {
        if (parseInt(readFileSync(this.pidFile, 'utf8'), 10) === process.pid) rmSync(this.pidFile)
      } catch {}
    }
  }

  // Telegram allows one getUpdates consumer per token; an orphaned previous run would cause 409 forever.
  private claimPidFile(): void {
    mkdirSync(dirname(this.pidFile), { recursive: true, mode: 0o700 })
    try {
      const stale = parseInt(readFileSync(this.pidFile, 'utf8'), 10)
      if (stale > 1 && stale !== process.pid) {
        process.kill(stale, 0)
        const cmd = execFileSync('ps', ['-p', String(stale), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        if (isOurProcess(cmd, entryPath())) {
          this.log(`replacing stale poller pid=${stale}`)
          process.kill(stale, 'SIGTERM')
        }
      }
    } catch {}
    writeFileSync(this.pidFile, String(process.pid))
  }
}

/** PIDs get recycled: a stale holder is ours only if its command line runs our entry point. */
export function isOurProcess(cmdline: string, entryPath: string): boolean {
  return entryPath !== '' && cmdline.includes(entryPath)
}

function entryPath(): string {
  const arg = process.argv[1]
  if (!arg) return ''
  try { return realpathSync(arg) } catch { return '' }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}
