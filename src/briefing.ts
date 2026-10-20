// Morning briefing: what happened since the last one and what still waits, as JSON for the session (kind briefing).
// Carries Slack text (first_line) to the session only; nothing here is ever logged.
import type { BriefingCron, Config } from './config'
import type { Item, State } from './state'

const DAY_MS = 86_400_000
/** A briefing never reaches further back than this, however long ago the previous one ran. */
const SINCE_MAX_MS = 7 * DAY_MS
const MIN_MS = 60_000
/** The session needs a few notable ignores to spot wrong triage, not the whole journal. */
export const BRIEFING_IGNORED_MAX = 20
const FIRST_LINE_MAX = 80

export type Briefing = {
  since: string
  ignored: { id: string; channel: string; author: string; reason: string; at: string }[]
  /** All items ignored since `since`; `ignored` holds only the latest BRIEFING_IGNORED_MAX of them. */
  ignored_total: number
  awaiting: { id: string; channel: string; author: string; age_minutes: number; first_line: string }[]
  stuck: { id: string; status: string; age_minutes: number }[]
  answered: { id: string; channel: string; chosen: number | 'custom' | null; sent_at: string }[]
  manual: { id: string; channel: string }[]
  feedback_count: number
  today: string
}

/**
 * The latest briefing moment at or before now on a configured weekday, in local time (DST-safe: built from local fields).
 * Weekdays are validated non-empty, so a moment exists within the last 7 days.
 */
export function lastBriefingMoment(now: number, cron: BriefingCron): number {
  for (let back = 0; back <= 7; back++) {
    const d = new Date(now)
    d.setDate(d.getDate() - back)
    d.setHours(cron.hour, cron.minute, 0, 0)
    if (cron.weekdays.includes(d.getDay()) && d.getTime() <= now) return d.getTime()
  }
  throw new Error('briefing.weekdays is empty')
}

/** When the item left the open statuses; items closed before closedAt existed fall back to their last known activity. */
const closedAt = (i: Item): number => i.closedAt ?? (i.status === 'ignored' ? i.triageAt ?? i.createdAt : i.lastMessageAt)
const iso = (ms: number): string => new Date(ms).toISOString()
const newestFirst = (a: Item, b: Item): number => b.createdAt - a.createdAt || b.seq - a.seq || b.sub - a.sub
const localDate = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function briefingPayload(state: State, cfg: Config, now: number, lastBriefingAt: number | undefined): Briefing {
  // Everything since the previous briefing (Monday covers the weekend); with none yet, the last 24 h.
  const since = lastBriefingAt === undefined ? now - DAY_MS : Math.max(lastBriefingAt, now - SINCE_MAX_MS)
  const items = Object.values(state.items)
  const channel = (i: Item): string => i.channelName ?? state.channels[i.channel] ?? i.channel
  const author = (i: Item): string => i.authorName ?? state.users[i.author] ?? i.author
  const age = (i: Item): number => Math.floor((now - i.createdAt) / MIN_MS)
  const closedSince = (status: Item['status']): Item[] =>
    items.filter((i) => i.status === status && closedAt(i) >= since).sort((a, b) => closedAt(b) - closedAt(a))
  const ignored = closedSince('ignored')
  return {
    since: iso(since),
    ignored: ignored.slice(0, BRIEFING_IGNORED_MAX)
      .map((i) => ({ id: i.id, channel: channel(i), author: author(i), reason: i.ignoreReason ?? '', at: iso(closedAt(i)) })),
    ignored_total: ignored.length,
    awaiting: items.filter((i) => i.status === 'awaiting').sort(newestFirst).map((i) => ({
      id: i.id, channel: channel(i), author: author(i), age_minutes: age(i),
      first_line: (i.messages[0]?.text ?? '').split('\n')[0]!.trim().slice(0, FIRST_LINE_MAX),
    })),
    stuck: items.filter((i) => (i.status === 'settling' || i.status === 'triage') && now - i.createdAt >= cfg.triageTimeoutSeconds * 1000)
      .sort(newestFirst).map((i) => ({ id: i.id, status: i.status, age_minutes: age(i) })),
    answered: closedSince('sent').map((i) => ({ id: i.id, channel: channel(i), chosen: i.sentChoice ?? null, sent_at: iso(closedAt(i)) })),
    manual: closedSince('answered_manually').map((i) => ({ id: i.id, channel: channel(i) })),
    feedback_count: state.feedback.filter((f) => f.at >= since).length,
    today: localDate(now),
  }
}
