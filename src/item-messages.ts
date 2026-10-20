// Keeping the Telegram messages of an item in step with its state, and the item's JSON for the session.
// Every edit is best-effort: a failed edit is logged (kind only) and never blocks a state change.
import { chunk, feedbackKeyboard, outcome, type Keyboard } from './format'
import type { Item, SlackMsg } from './state'
import type { TelegramBot } from './telegram/bot'

export const TG_LIMIT = 4096

const log = (kind: string): void => { process.stderr.write(`ping-assistant: ${kind}\n`) }
const errName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown')
const notModified = (err: unknown): boolean => err instanceof Error && err.message.includes('message is not modified')

/** The text of the last Telegram message a long text is split into: the one carrying the buttons. */
export const lastPart = (text: string): string => chunk(text, TG_LIMIT).pop() ?? ''

/** The item's message text without its trailing paragraph: the italic «Правка: …» hint. */
export const withoutHint = (text: string): string => {
  const cut = text.lastIndexOf('\n\n')
  return cut < 0 ? '' : text.slice(0, cut)
}

export const msgJson = (m: SlackMsg) => ({ ts: m.ts, user: m.user, userName: m.userName, text: m.text, ...(m.files ? { files: m.files } : {}) })

export function itemJson(item: Item) {
  return {
    id: item.id, source: item.source, channel: item.channel, channelName: item.channelName, threadTs: item.threadTs,
    author: item.author, authorName: item.authorName,
    messages: item.messages.map(msgJson), context: item.context.map(msgJson),
    permalink: item.messages[0]?.permalink, files: item.messages.flatMap((m) => m.files ?? []),
  }
}

export class ItemMessages {
  constructor(private readonly tg: Pick<TelegramBot, 'edit' | 'dropKeyboard' | 'send'>) {}

  /** Edits the item's Telegram message to its final outcome (buttons removed). */
  closeOriginal(item: Item): Promise<void> {
    return this.annotate(item, outcome(item))
  }

  /**
   * Appends a status line to the item's message, removing its buttons except 👎 (once variants were shown:
   * feedback stays possible after the item closes). A last chunk too full for the line loses its buttons,
   * and the line (with the 👎 row) goes out as a short reply to it instead of being dropped.
   */
  async annotate(item: Item, line: string): Promise<void> {
    const { messageId, text } = item.telegram
    if (messageId === undefined || !text) return
    const keep = item.variants?.length ? feedbackKeyboard(item.id) : undefined
    const full = `${text}\n\n${line}`
    if (full.length <= TG_LIMIT) { await this.edit(messageId, full, keep); return }
    await this.dropKeyboard(messageId)
    try {
      await this.tg.send(`#${item.id} · ${line}`, keep, messageId)
    } catch (err) {
      log(`telegram send failed: ${errName(err)}`)
    }
  }

  /** Strips the buttons of the item's proposal and warning messages (except `keep`) and forgets them. */
  async retire(item: Item, keep?: number): Promise<void> {
    for (const key of ['proposalMessageId', 'warningMessageId'] as const) {
      const id = item.telegram[key]
      if (id === undefined) continue
      if (id !== keep) await this.dropKeyboard(id)
      item.telegram[key] = undefined
      if (key === 'warningMessageId') item.telegram.warningText = undefined
    }
  }

  async edit(messageId: number, text: string, keyboard?: Keyboard): Promise<void> {
    // Telegram rejects a longer edit outright; still make sure the old buttons go away.
    if (text.length > TG_LIMIT) { if (!keyboard) await this.dropKeyboard(messageId); return }
    try {
      await this.tg.edit(messageId, text, keyboard)
    } catch (err) {
      if (!notModified(err)) log(`telegram edit failed: ${errName(err)}`)
    }
  }

  async dropKeyboard(messageId: number): Promise<void> {
    try {
      await this.tg.dropKeyboard(messageId)
    } catch (err) {
      if (!notModified(err)) log(`telegram keyboard removal failed: ${errName(err)}`)
    }
  }
}
