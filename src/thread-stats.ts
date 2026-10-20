// What the session sees of an item's conversation as a whole: who talks, how long it runs, what Ping Assistant
// already handled in it. Pure: computed from the item and state.items, no Slack calls.
import type { Item, SlackMsg, State } from './state'

/** A conversation with fewer context messages than this (and not a thread) gets no thread block. */
export const THREAD_MIN_CONTEXT = 6
/** At most this many prior items, the latest ones. */
const PRIOR_MAX = 10
const DAY_MS = 86_400_000

export type PriorItem = { id: string; status: Item['status']; sentTs?: string; chosen?: number | 'custom' }
export type ThreadJson = {
  messages: number
  participants: { id: string; name: string; count: number }[]
  my_messages: number
  my_last_at?: string
  first_at: string
  last_at: string
  days_span: number
  prior_items: PriorItem[]
}

const isDm = (i: Item): boolean => i.source === 'im' || i.source === 'mpim'
const tsMs = (ts: string): number => Number(ts) * 1000
const iso = (ms: number): string => new Date(ms).toISOString()

/**
 * The item's conversation: its thread; for a top-level channel message, the thread under it (where the reply goes
 * and where follow-ups come from); for a top-level DM message, the DM itself.
 */
export function threadKey(item: Item): string {
  const thread = item.threadTs ?? (isDm(item) ? undefined : item.messages[0]?.ts)
  return `${item.channel}:${thread ?? ''}`
}

const earlier = (a: Item, b: Item): boolean =>
  a.createdAt < b.createdAt || (a.createdAt === b.createdAt && (a.seq - b.seq || a.sub - b.sub) < 0)

/** Earlier items of the same follow-up chain (seq) or conversation, oldest first. */
function priorItems(item: Item, state: State): PriorItem[] {
  const key = threadKey(item)
  return Object.values(state.items)
    .filter((i) => i !== item && (i.seq === item.seq || threadKey(i) === key) && earlier(i, item))
    .sort((a, b) => (earlier(a, b) ? -1 : 1))
    .slice(-PRIOR_MAX)
    .map((i) => ({
      id: i.id, status: i.status,
      ...(i.sentTs !== undefined ? { sentTs: i.sentTs } : {}),
      ...(i.sentChoice !== undefined ? { chosen: i.sentChoice } : {}),
    }))
}

/** Thread stats for a thread item or one with a long context; undefined for a short top-level conversation. */
export function threadJson(item: Item, state: State, userId: string): ThreadJson | undefined {
  if (item.threadTs === undefined && item.context.length < THREAD_MIN_CONTEXT) return undefined
  const byTs = new Map<string, SlackMsg>()
  for (const m of [...item.context, ...item.messages]) byTs.set(m.ts, m)
  const all = [...byTs.values()].sort((a, b) => tsMs(a.ts) - tsMs(b.ts))
  if (!all.length) return undefined
  const counts = new Map<string, { id: string; name: string; count: number }>()
  for (const m of all) {
    if (!m.user) continue
    const p = counts.get(m.user) ?? { id: m.user, name: m.userName ?? state.users[m.user] ?? m.user, count: 0 }
    p.count++
    counts.set(m.user, p)
  }
  const mine = all.filter((m) => m.user === userId)
  const first = tsMs(all[0]!.ts)
  const last = tsMs(all[all.length - 1]!.ts)
  return {
    messages: all.length,
    participants: [...counts.values()].sort((a, b) => b.count - a.count),
    my_messages: mine.length,
    ...(mine.length ? { my_last_at: iso(tsMs(mine[mine.length - 1]!.ts)) } : {}),
    first_at: iso(first),
    last_at: iso(last),
    days_span: Math.round(((last - first) / DAY_MS) * 10) / 10,
    prior_items: priorItems(item, state),
  }
}
