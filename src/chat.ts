// Free-form requests from Telegram (kind chat): the server's «👀 смотрю…» ack and the chat log that lets the
// session continue a multi-turn request after a restart. Message text is stored in state, never logged.
import type { Channel } from './channel'
import type { ChatEntry, State } from './state'
import type { TelegramBot } from './telegram/bot'

/** Entries kept in state.chatLog (user chat texts and the session's say replies), oldest dropped first. */
export const CHAT_LOG_MAX = 40
/** Entries handed to the session as recent_chat: about the last 6 exchanges. */
export const RECENT_CHAT = 12
/** The hourly prune drops entries older than this. */
export const CHAT_LOG_MS = 7 * 86_400_000
/** One entry's text is cut to this (a say answer is at most ~3000 chars; a briefing may be longer). */
export const CHAT_ENTRY_MAX = 3000
export const CHAT_ACK = '👀 смотрю…'
/** Asks the session answers from list_feedback at once: no ack, as before. */
const FEEDBACK_ASK = /^что по фидбеку[.!?]?$/i

/** A request that will take the session a while: longer than 12 characters, or a question. */
export function needsAck(text: string): boolean {
  const t = text.trim()
  return (t.length > 12 || t.endsWith('?')) && !FEEDBACK_ASK.test(t)
}

export function logChat(state: State, from: ChatEntry['from'], text: string, at: number): void {
  const log = (state.chatLog ??= [])
  log.push({ at, from, text: text.length > CHAT_ENTRY_MAX ? `${text.slice(0, CHAT_ENTRY_MAX)}…` : text })
  if (log.length > CHAT_LOG_MAX) log.splice(0, log.length - CHAT_LOG_MAX)
}

export function recentChat(state: State): { at: string; from: ChatEntry['from']; text: string }[] {
  return (state.chatLog ?? []).slice(-RECENT_CHAT).map((e) => ({ at: new Date(e.at).toISOString(), from: e.from, text: e.text }))
}

/** Returns whether anything was dropped. */
export function pruneChatLog(state: State, now: number): boolean {
  const log = state.chatLog ?? []
  const kept = log.filter((e) => e.at >= now - CHAT_LOG_MS)
  if (kept.length === log.length) return false
  state.chatLog = kept
  return true
}

/**
 * A forward with no item: ack it in Telegram (quoting Ilya's message) when it looks like a real request, then hand
 * it to the session as kind chat with recent_chat (the log before this message). A failed ack does not stop it.
 */
export async function forwardChat(
  d: { state: State; tg: Pick<TelegramBot, 'send'>; channel: Pick<Channel, 'notify'> },
  text: string, itemId: string | undefined, messageId: number, now: number,
  onAckError: (err: unknown) => void,
): Promise<void> {
  if (needsAck(text)) {
    try { await d.tg.send(CHAT_ACK, undefined, messageId, { plain: true }) } catch (err) { onAckError(err) }
  }
  const recent_chat = recentChat(d.state)
  logChat(d.state, 'user', text, now)
  await d.channel.notify(JSON.stringify({ text, ...(itemId ? { itemId } : {}), recent_chat }), { kind: 'chat' })
}
