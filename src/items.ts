import type { Config } from './config'
import type { Item, ItemSource, SlackMsg, State } from './state'

export function conversationKey(m: SlackMsg): string {
  return `${m.channel}:${m.threadTs ?? ''}`
}

export type IngestEvent =
  | { kind: 'dropped'; reason: 'duplicate' | 'own' | 'bot' }
  | { kind: 'buffered'; itemId: string }
  | { kind: 'appended'; itemId: string }
  | { kind: 'answered_manually'; itemIds: string[] }
  | { kind: 'followup'; itemId: string }

export function nextItemId(state: State): string {
  return `${state.nextSeq++}`
}

function itemKey(i: Item): string {
  return `${i.channel}:${i.threadTs ?? ''}`
}

function addMessage(state: State, item: Item, m: SlackMsg, now: number): void {
  item.messages.push(m)
  item.lastSeenTs = m.ts
  item.lastMessageAt = now
  state.msgIndex[`${m.channel}:${m.ts}`] = item.id
}

function newItem(state: State, m: SlackMsg, source: ItemSource, now: number, id: string, seq: number, sub: number): Item {
  const item: Item = {
    id, seq, sub, status: 'settling', source, channel: m.channel, threadTs: m.threadTs,
    author: m.user, authorName: m.userName, messages: [], context: [], lastSeenTs: m.ts,
    createdAt: now, lastMessageAt: now, telegram: {},
  }
  state.items[id] = item
  addMessage(state, item, m, now)
  return item
}

function latest(items: Item[]): Item | undefined {
  return items.reduce<Item | undefined>((best, i) => (!best || i.createdAt >= best.createdAt ? i : best), undefined)
}

export function ingest(state: State, m: SlackMsg, source: ItemSource, now: number, cfg: Config): IngestEvent {
  if (state.msgIndex[`${m.channel}:${m.ts}`]) return { kind: 'dropped', reason: 'duplicate' }

  const key = conversationKey(m)
  const sameKey = Object.values(state.items).filter((i) => itemKey(i) === key)

  if (m.user === cfg.userId) {
    const closed = sameKey.filter((i) => i.status === 'settling' || i.status === 'awaiting')
    if (closed.length === 0) return { kind: 'dropped', reason: 'own' }
    for (const i of closed) i.status = 'answered_manually'
    return { kind: 'answered_manually', itemIds: closed.map((i) => i.id) }
  }
  if (m.user === '') return { kind: 'dropped', reason: 'bot' }

  const mine = sameKey.filter((i) => i.author === m.user)
  const settling = latest(mine.filter((i) => i.status === 'settling'))
  if (settling) {
    addMessage(state, settling, m, now)
    return { kind: 'buffered', itemId: settling.id }
  }
  const awaiting = latest(mine.filter((i) => i.status === 'awaiting'))
  if (awaiting) {
    addMessage(state, awaiting, m, now)
    return { kind: 'appended', itemId: awaiting.id }
  }

  if (m.threadTs && state.watchedThreads[key]) {
    const parent = latest(sameKey.filter((i) => i.status === 'sent')) ?? latest(sameKey)
    if (parent) {
      const maxSub = Math.max(...Object.values(state.items).filter((i) => i.seq === parent.seq).map((i) => i.sub))
      const sub = maxSub + 1
      const item = newItem(state, m, 'followup', now, `${parent.seq}.${sub}`, parent.seq, sub)
      return { kind: 'followup', itemId: item.id }
    }
  }

  const id = nextItemId(state)
  const item = newItem(state, m, source, now, id, Number(id), 0)
  return { kind: 'buffered', itemId: item.id }
}

export function mature(state: State, now: number, cfg: Config): Item[] {
  const ripe = Object.values(state.items)
    .filter((i) => i.status === 'settling'
      && (now - i.lastMessageAt >= cfg.settleSeconds * 1000 || now - i.createdAt >= cfg.maxSettleSeconds * 1000))
    .sort((a, b) => a.createdAt - b.createdAt)
  for (const i of ripe) i.status = 'triage'
  return ripe
}
