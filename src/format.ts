import { callbackData } from './commands'
import type { Item, SlackMsg } from './state'

export type Keyboard = { label: string; data: string }[][]

export function humanizeSlack(text: string, users: Record<string, string>, channels: Record<string, string>): string {
  return text
    .replace(/<([^<>]+)>/g, (whole, inner: string) => {
      if (inner.startsWith('@')) {
        const id = inner.slice(1).split('|')[0] ?? ''
        return `@${users[id] ?? id}`
      }
      if (inner.startsWith('#')) {
        const [id = '', name] = inner.slice(1).split('|')
        return `#${name ?? channels[id] ?? id}`
      }
      if (inner.startsWith('!')) {
        const name = inner.slice(1).split('|')[0] ?? ''
        return ['here', 'channel', 'everyone'].includes(name) ? `@${name}` : whole
      }
      const bar = inner.indexOf('|')
      return bar === -1 ? inner : `${inner.slice(bar + 1)} (${inner.slice(0, bar)})`
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Escapes text for Telegram's HTML parse mode. */
export const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const escapeAttr = (text: string): string => escapeHtml(text).replace(/"/g, '&quot;')

const decodeSlack = (text: string): string => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** Telegram HTML back to plain text: tags dropped, entities unescaped. */
export function stripHtml(html: string): string {
  return html
    .replace(/<\/?[a-zA-Z][^<>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

/** One Slack `<…>` token as Telegram HTML. */
function slackToken(inner: string, users: Record<string, string>, channels: Record<string, string>): string {
  const bar = inner.indexOf('|')
  const target = decodeSlack(bar === -1 ? inner : inner.slice(0, bar))
  const label = bar === -1 ? undefined : decodeSlack(inner.slice(bar + 1))
  if (target.startsWith('@')) {
    const id = target.slice(1)
    return escapeHtml(`@${users[id] ?? label ?? id}`)
  }
  if (target.startsWith('#')) {
    const id = target.slice(1)
    return escapeHtml(`#${label ?? channels[id] ?? id}`)
  }
  if (target.startsWith('!')) {
    const name = target.slice(1)
    if (['here', 'channel', 'everyone'].includes(name)) return `@${name}`
    return escapeHtml(label ?? `<${decodeSlack(inner)}>`)
  }
  return `<a href="${escapeAttr(target)}">${escapeHtml(label ?? target)}</a>`
}

/**
 * Slack mrkdwn as Telegram HTML: *bold*, _italic_, ~strike~, `code`, ```pre```, mentions, channels and links.
 * Everything else is escaped, so the result is always safe for parse_mode HTML.
 */
export function slackToHtml(text: string, users: Record<string, string>, channels: Record<string, string>): string {
  const held: string[] = []
  const hold = (html: string): string => `\u0000${held.push(html) - 1}\u0000`
  let s = text
    .replace(/```([\s\S]*?)```/g, (_, code: string) => hold(`<pre>${escapeHtml(decodeSlack(code))}</pre>`))
    .replace(/`([^`\n]+)`/g, (_, code: string) => hold(`<code>${escapeHtml(decodeSlack(code))}</code>`))
    .replace(/<([^<>\n]+)>/g, (_, inner: string) => hold(slackToken(inner, users, channels)))
  s = escapeHtml(decodeSlack(s))
  for (const [mark, tag] of [['\\*', 'b'], ['_', 'i'], ['~', 's']] as const) {
    const re = new RegExp(`(^|[^\\w${mark}])${mark}(?=\\S)([^\\n]*?\\S)${mark}(?![\\w${mark}])`, 'g')
    s = s.replace(re, (_, pre: string, body: string) => `${pre}<${tag}>${body}</${tag}>`)
  }
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)] ?? '')
}

export function slackify(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/gs, '*$1*')
}

function age(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes} мин назад`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ч назад`
  return `${Math.floor(hours / 24)} д назад`
}

type Users = Record<string, string>

/** The quote of an item is capped; the full text stays one tap away behind the Slack link. */
export const QUOTE_MAX = 2500
const HINT = '<i>Правка: ответь цитатой «2, но …» или «: свой текст»</i>'
const LABEL = /^(Тип|Вопросы|Разбор|Контекст|Уверенность)[^:\n]*:/
const NUMBERS = ['1️⃣', '2️⃣', '3️⃣']

const TAG = /<(\/?)([a-zA-Z]+)[^<>]*>/g
type Open = { name: string; tag: string }

/** The tags still open after `html`, starting from `stack` (outermost first). */
function openTags(html: string, stack: Open[] = []): Open[] {
  const open = [...stack]
  for (const [tag, close, name = ''] of html.matchAll(TAG)) {
    if (!close) open.push({ name, tag })
    else if (open.at(-1)?.name === name) open.pop()
  }
  return open
}

const closers = (open: Open[]): string => open.map((t) => `</${t.name}>`).reverse().join('')

/** Moves a cut at `end` back so it never lands inside a tag or an entity. */
function safeCut(html: string, end: number): number {
  const lt = html.lastIndexOf('<', end - 1)
  if (lt > html.lastIndexOf('>', end - 1)) end = lt
  const amp = html.lastIndexOf('&', end - 1)
  if (amp >= 0 && /^&[#a-zA-Z0-9]{1,8};/.test(html.slice(amp)) && html.indexOf(';', amp) >= end) end = amp
  return end
}

/** Cuts HTML to about `max` chars at a line boundary, closing whatever is open and marking the cut with «…». */
function capHtml(html: string, max: number): string {
  if (html.length <= max) return html
  const nl = html.lastIndexOf('\n', max)
  const prefix = html.slice(0, nl > 0 ? nl : safeCut(html, max)).trimEnd()
  return `${prefix}${closers(openTags(prefix))}\n…`
}

const quote = (msgs: SlackMsg[], users: Users, channels: Users): string =>
  msgs.map((m) => slackToHtml(m.text, users, channels)).join('\n\n')

const analysisHtml = (analysis: string): string =>
  escapeHtml(analysis).split('\n').map((line) => line.replace(LABEL, '<b>$&</b>')).join('\n')

export function renderItem(
  item: Item, users: Users, channels: Users, now: number,
): { text: string; keyboard: Keyboard } {
  const where = item.source === 'im' ? 'личка' : `#${item.channelName ?? item.channel}`
  const header = `<b>#${escapeHtml(item.id)}</b> · ${escapeHtml(where)} · ${escapeHtml(item.authorName ?? item.author)} · ${age(now - item.lastMessageAt)}`
  const variants = item.variants ?? []
  // Header, quote and link stay one paragraph: chunk() never splits it, and the cap keeps it well under 4096.
  const top = [header]
  const q = capHtml(quote(item.messages, users, channels), QUOTE_MAX)
  if (q) top.push(`<blockquote expandable>${q}</blockquote>`)
  const link = item.messages[0]?.permalink
  if (link) top.push(`<a href="${escapeAttr(link)}">Открыть в Slack</a>`)
  const parts = [top.join('\n')]
  if (item.analysis) parts.push(analysisHtml(item.analysis))
  // Shown exactly as «N k» will send it (sendToSlack posts slackify(variant)).
  if (variants.length) {
    parts.push(`<b>Варианты</b>\n${variants.map((v, i) => `${NUMBERS[i] ?? `${i + 1}.`} ${escapeHtml(slackify(v))}`).join('\n\n')}`)
  }
  parts.push(HINT)
  const keyboard: Keyboard = [[
    ...variants.map((_, i) => ({ label: String(i + 1), data: callbackData({ kind: 'choose', itemId: item.id, n: i + 1 }) })),
    { label: 'Пропустить', data: callbackData({ kind: 'skip', itemId: item.id }) },
  ]]
  return { text: parts.join('\n\n'), keyboard }
}

const quoted = (title: string, msgs: SlackMsg[], users: Users, channels: Users): string =>
  `<b>${escapeHtml(title)}</b>\n<blockquote>${quote(msgs, users, channels)}</blockquote>`

export function renderUpdate(item: Item, newMsgs: SlackMsg[], users: Users = {}, channels: Users = {}): string {
  return quoted(`#${item.id} · дополнение`, newMsgs, users, channels)
}

export function renderProposal(item: Item, text: string): { text: string; keyboard: Keyboard } {
  return {
    text: `<b>#${escapeHtml(item.id)} · финальный текст</b>\n\n${escapeHtml(text)}`,
    keyboard: [[
      { label: 'Отправить', data: callbackData({ kind: 'confirm', itemId: item.id }) },
      { label: 'Отмена', data: callbackData({ kind: 'cancel', itemId: item.id }) },
    ]],
  }
}

export function renderThreadChanged(
  item: Item, newMsgs: SlackMsg[], users: Users = {}, channels: Users = {},
): { text: string; keyboard: Keyboard } {
  return {
    text: quoted(`#${item.id} · в треде появилось новое`, newMsgs, users, channels),
    keyboard: [[
      { label: 'Всё равно отправить', data: callbackData({ kind: 'force', itemId: item.id }) },
      { label: 'Отмена', data: callbackData({ kind: 'cancel', itemId: item.id }) },
    ]],
  }
}

export function outcome(item: Item, chosen?: number | 'custom'): string {
  switch (item.status) {
    case 'sent':
      if (chosen === undefined) return '✅ отправлено'
      return chosen === 'custom' ? '✅ отправлено (свой текст)' : `✅ отправлен вариант ${chosen}`
    case 'skipped': return '⏭ пропущен'
    case 'answered_manually': return '🙈 отвечено вручную'
    case 'awaiting': return '✏️ правка ниже'
    default: return ''
  }
}

/** Blank-line paragraphs, rejoined wherever a blank line falls inside an open tag (a quote of several messages). */
function htmlParagraphs(text: string): string[] {
  const out: string[] = []
  let acc: string | undefined
  for (const piece of text.split('\n\n')) {
    acc = acc === undefined ? piece : `${acc}\n\n${piece}`
    if (openTags(acc).length === 0) { out.push(acc); acc = undefined }
  }
  if (acc !== undefined) out.push(acc)
  return out
}

/** An HTML paragraph over the limit: cut at line breaks where possible, tags closed at each cut and reopened after it. */
function splitHtml(para: string, limit: number): string[] {
  const out: string[] = []
  let stack: Open[] = []
  let pos = 0
  for (;;) {
    const prefix = stack.map((t) => t.tag).join('')
    if (prefix.length + para.length - pos <= limit) { out.push(prefix + para.slice(pos)); return out }
    let budget = limit - prefix.length
    for (;;) {
      const end = pos + Math.max(1, budget)
      const nl = para.lastIndexOf('\n', end - 1)
      let cut = nl > pos ? nl : safeCut(para, end)
      if (cut <= pos) cut = Math.max(end, para.indexOf('>', pos) + 1) // a single tag longer than the budget
      const piece = para.slice(pos, cut)
      const next = openTags(piece, stack)
      const over = prefix.length + piece.length + closers(next).length - limit
      if (over <= 0 || budget <= 1) {
        out.push(prefix + piece + closers(next))
        stack = next
        pos = nl > pos && cut === nl ? cut + 1 : cut
        break
      }
      budget -= over
    }
  }
}

/**
 * Splits text into Telegram-sized messages on blank lines. In HTML mode a paragraph is never split inside a tag:
 * an oversized one is cut at line breaks with its open tags closed and reopened, and never inside an entity.
 */
export function chunk(text: string, limit = 4096, html = true): string[] {
  const out: string[] = []
  let cur = ''
  for (const para of html ? htmlParagraphs(text) : text.split('\n\n')) {
    if (cur && cur.length + 2 + para.length <= limit) { cur += `\n\n${para}`; continue }
    if (cur) out.push(cur)
    let rest = para
    if (html && rest.length > limit) {
      const pieces = splitHtml(rest, limit)
      rest = pieces.pop() ?? ''
      out.push(...pieces)
    }
    while (rest.length > limit) { out.push(rest.slice(0, limit)); rest = rest.slice(limit) }
    cur = rest
  }
  if (cur || out.length === 0) out.push(cur)
  return out
}
