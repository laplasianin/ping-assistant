import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

const STATE_DIR = join(homedir(), '.config', 'ping-assistant')
const PID_FILE = join(STATE_DIR, 'bot.pid')
const HELP = 'Ping Assistant: отвечай на вопросы из Slack кнопками или текстом («14 1», «14: свой текст», «14 пропустить»).'

const markup = (kb: Keyboard) => ({
  inline_keyboard: kb.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data }))),
})

const log = (kind: string) => process.stderr.write(`telegram: ${kind}\n`)

export class TelegramBot {
  private readonly bot: Bot
  private readonly api: TelegramApi
  private readonly items = new Map<number, string>()
  private handler: (i: Inbound) => Promise<void> = async () => {}
  private stopping = false

  constructor(token: string, private readonly chatId: string, api?: TelegramApi) {
    // With an injected api no network is needed: give grammY fake botInfo so handleUpdate works without init.
    const botInfo = { id: 1, is_bot: true, first_name: 'test', username: 'test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false } as unknown as UserFromGetMe
    this.bot = new Bot(token, api ? { botInfo } : {})
    this.api = api ?? (this.bot.api as unknown as TelegramApi)
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
      await this.api.answerCallbackQuery(q.id)
      if (!cmd || !q.message) return
      await this.handler({ cmd, messageId: q.message.message_id })
    })

    this.bot.catch((err) => log(`handler error (polling continues): ${err.error instanceof Error ? err.error.name : 'unknown'}`))
  }

  async start(): Promise<void> {
    this.claimPidFile()
    this.stopping = false
    for (let attempt = 1; ; attempt++) {
      try {
        await this.bot.start({ onStart: (info) => { attempt = 0; log(`polling as @${info.username}`) } })
        return
      } catch (err) {
        if (this.stopping || (err instanceof Error && err.message === 'Aborted delay')) return
        const is409 = err instanceof GrammyError && err.error_code === 409
        if (is409 && attempt >= 8) {
          log('409 Conflict persists, another poller holds the token; giving up')
          return
        }
        const delay = Math.min(1000 * attempt, 15_000)
        log(`${is409 ? '409 Conflict' : 'polling error'}, retrying in ${delay / 1000}s`)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    await this.bot.stop()
    try {
      if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) rmSync(PID_FILE)
    } catch {}
  }

  // Telegram allows one getUpdates consumer per token; an orphaned previous run would cause 409 forever.
  private claimPidFile(): void {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    try {
      const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
      if (stale > 1 && stale !== process.pid) {
        process.kill(stale, 0)
        // PIDs get recycled: only terminate if the holder really is our server.
        const cmd = execFileSync('ps', ['-p', String(stale), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        if (cmd.includes('main.ts') && cmd.includes('bun')) {
          log(`replacing stale poller pid=${stale}`)
          process.kill(stale, 'SIGTERM')
        }
      }
    } catch {}
    writeFileSync(PID_FILE, String(process.pid))
  }
}
