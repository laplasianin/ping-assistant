import type { Config } from './config'
import { cmpTs, SEARCH_LAG_S } from './slack/collector'
import { OWN_MSG, type Item, type ItemSource, type ItemStatus, type SlackMsg, type State } from './state'

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
  // A message recovered late (a poll after a socket gap) may be older than ones already in the item.
  item.messages.sort((a, b) => cmpTs(a.ts, b.ts))
  item.lastSeenTs = item.messages[item.messages.length - 1]!.ts
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

/** A top-level item's conversation also includes the thread under its first message. */
function inThread(i: Item, threadTs: string): boolean {
  return i.threadTs === threadTs || (!i.threadTs && i.messages[0]?.ts === threadTs)
}

/** Open items Ilya's own message answers: in an IM every open item; elsewhere only the thread he replied in. */
function answeredBy(state: State, m: SlackMsg, source: ItemSource): Item[] {
  const open = Object.values(state.items)
    .filter((i) => i.channel === m.channel && (i.status === 'settling' || i.status === 'triage' || i.status === 'awaiting'))
  if (m.threadTs) return open.filter((i) => inThread(i, m.threadTs!))
  // A top-level message in a channel or MPIM may address anyone: it closes nothing.
  return source === 'im' ? open : []
}

function latest(items: Item[]): Item | undefined {
  return items.reduce<Item | undefined>((best, i) => (!best || i.createdAt >= best.createdAt ? i : best), undefined)
}

export function ingest(state: State, m: SlackMsg, source: ItemSource, now: number, cfg: Config): IngestEvent {
  if (state.msgIndex[`${m.channel}:${m.ts}`]) return { kind: 'dropped', reason: 'duplicate' }

  const key = conversationKey(m)
  const sameKey = Object.values(state.items).filter((i) => itemKey(i) === key)

  const selfTest = cfg.dryRun && cfg.selfDmTest === true && m.channel === state.selfDmChannel
  if (m.user === cfg.userId && !selfTest) {
    // Indexed, so a replay (a reconcile poll re-reading what the socket delivered) cannot close newer items.
    state.msgIndex[`${m.channel}:${m.ts}`] = OWN_MSG
    const closed = answeredBy(state, m, source)
    if (closed.length === 0) return { kind: 'dropped', reason: 'own' }
    for (const i of closed) i.status = 'answered_manually'
    return { kind: 'answered_manually', itemIds: closed.map((i) => i.id) }
  }
  if (m.user === '') { state.msgIndex[`${m.channel}:${m.ts}`] = OWN_MSG; return { kind: 'dropped', reason: 'bot' } }

  const mine = sameKey.filter((i) => i.author === m.user)
  const settling = latest(mine.filter((i) => i.status === 'settling'))
  if (settling) {
    addMessage(state, settling, m, now)
    return { kind: 'buffered', itemId: settling.id }
  }
  // An addendum while the session triages it (or Ilya decides) belongs to the same item.
  const open = latest(mine.filter((i) => i.status === 'triage' || i.status === 'awaiting'))
  if (open) {
    addMessage(state, open, m, now)
    return { kind: 'appended', itemId: open.id }
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

const TERMINAL: ItemStatus[] = ['ignored', 'skipped', 'sent', 'answered_manually']
const DAY_MS = 86_400_000

/**
 * Bounds state growth. Drops items in a terminal status whose last activity is older than followUpDays
 * (unless their thread is still watched: a follow-up needs its parent) with their msgIndex entries, and any
 * msgIndex entry older than followUpDays that no remaining item refers to (own-message sentinels included).
 * Open items (settling, triage, awaiting) are never touched. Returns whether anything was removed.
 * An entry at or above the search floors (search, dmsearch) minus SEARCH_LAG_S always stays: those searches
 * return such hits again every tick, and only msgIndex keeps them from becoming duplicate items.
 */
export function prune(state: State, now: number, cfg: Config): boolean {
  const cutoff = now - cfg.followUpDays * DAY_MS
  const floors = [state.cursors.search ?? state.cursors.lastTick, state.cursors.dmsearch ?? state.cursors.lastTick]
    .filter((f): f is string => f !== undefined).map(Number)
  const keepAbove = floors.length ? (Math.min(...floors) - SEARCH_LAG_S) * 1000 : Infinity // no search yet: nothing to protect
  const pruned = new Set<string>()
  for (const item of Object.values(state.items)) {
    if (!TERMINAL.includes(item.status) || Math.max(item.createdAt, item.lastMessageAt) >= cutoff) continue
    const watch = item.threadTs ? state.watchedThreads[`${item.channel}:${item.threadTs}`] : undefined
    if (watch && watch.until > now) continue
    delete state.items[item.id]
    pruned.add(item.id)
  }
  let removed = 0
  for (const [key, value] of Object.entries(state.msgIndex)) {
    const at = Number(key.slice(key.lastIndexOf(':') + 1)) * 1000
    if (at >= keepAbove) continue // a pruned item's entry stays too: it still deduplicates the re-read hit
    if (pruned.has(value) || (at < cutoff && (value === OWN_MSG || !state.items[value]))) { delete state.msgIndex[key]; removed++ }
  }
  return pruned.size > 0 || removed > 0
}

export function mature(state: State, now: number, cfg: Config): Item[] {
  const ripe = Object.values(state.items)
    .filter((i) => i.status === 'settling'
      && (now - i.lastMessageAt >= cfg.settleSeconds * 1000 || now - i.createdAt >= cfg.maxSettleSeconds * 1000))
    .sort((a, b) => a.createdAt - b.createdAt)
  for (const i of ripe) { i.status = 'triage'; i.triageAt = now }
  return ripe
}
