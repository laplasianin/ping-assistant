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

const quote = (msgs: SlackMsg[], users: Record<string, string>, channels: Record<string, string>): string =>
  msgs.map((m) => humanizeSlack(m.text, users, channels)).join('\n\n')

export function renderItem(
  item: Item, users: Record<string, string>, channels: Record<string, string>, now: number,
): { text: string; keyboard: Keyboard } {
  const where = item.source === 'im' ? 'личка' : `#${item.channelName ?? item.channel}`
  const header = `#${item.id} · ${where} · ${item.authorName ?? item.author} · ${age(now - item.lastMessageAt)}`
  const variants = item.variants ?? []
  const parts = [header, quote(item.messages, users, channels)]
  const link = item.messages[0]?.permalink
  if (link) parts.push(link)
  if (item.analysis) parts.push(item.analysis)
  // Shown exactly as «N k» will send it (sendToSlack posts slackify(variant)).
  if (variants.length) parts.push(`Варианты:\n${variants.map((v, i) => `${i + 1}. ${slackify(v)}`).join('\n')}`)
  parts.push(`Ответь: «${item.id} 1» · «${item.id} 2, но …» · «${item.id}: свой текст» · «${item.id} пропустить»`)
  const keyboard: Keyboard = [[
    ...variants.map((_, i) => ({ label: String(i + 1), data: callbackData({ kind: 'choose', itemId: item.id, n: i + 1 }) })),
    { label: 'Пропустить', data: callbackData({ kind: 'skip', itemId: item.id }) },
  ]]
  return { text: parts.join('\n\n'), keyboard }
}

const plain = (msgs: SlackMsg[], users: Record<string, string>, channels: Record<string, string>): string =>
  quote(msgs, users, channels)

export function renderUpdate(
  item: Item, newMsgs: SlackMsg[], users: Record<string, string> = {}, channels: Record<string, string> = {},
): string {
  return `#${item.id} дополнение\n\n${plain(newMsgs, users, channels)}`
}

export function renderProposal(item: Item, text: string): { text: string; keyboard: Keyboard } {
  return {
    text: `#${item.id} · финальный текст:\n\n${text}`,
    keyboard: [[
      { label: 'Отправить', data: callbackData({ kind: 'confirm', itemId: item.id }) },
      { label: 'Отмена', data: callbackData({ kind: 'cancel', itemId: item.id }) },
    ]],
  }
}

export function renderThreadChanged(
  item: Item, newMsgs: SlackMsg[], users: Record<string, string> = {}, channels: Record<string, string> = {},
): { text: string; keyboard: Keyboard } {
  return {
    text: `#${item.id} · в треде появилось новое:\n\n${plain(newMsgs, users, channels)}`,
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

export function chunk(text: string, limit = 4096): string[] {
  const out: string[] = []
  let cur = ''
  for (const para of text.split('\n\n')) {
    if (cur && cur.length + 2 + para.length <= limit) { cur += `\n\n${para}`; continue }
    if (cur) out.push(cur)
    let rest = para
    while (rest.length > limit) { out.push(rest.slice(0, limit)); rest = rest.slice(limit) }
    cur = rest
  }
  if (cur || out.length === 0) out.push(cur)
  return out
}
