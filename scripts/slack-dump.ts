// Slack channel dump for the local knowledge base (knowledge/ is gitignored).
//   bun run scripts/slack-dump.ts --channel C… [--channel C…] [--since YYYY-MM-DD] [--out knowledge/slack]
// Read-only. Without --since: incremental from the newest message already dumped minus one day.
// The window always starts at a month boundary (Europe/Berlin), so every month file it touches is
// rewritten whole. Progress on stderr is counts only: never message text or tokens.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadSecrets } from '../src/config'
import { SlackClient, type RawMsg } from '../src/slack/client'

export const TZ = 'Europe/Berlin'
export const WORKSPACE = 'https://scentbird.slack.com'
/** Kept besides plain messages; every other subtype (join/leave/topic/purpose/bot…) is skipped. */
const KEPT_SUBTYPES = new Set(['thread_broadcast', 'file_share', 'me_message'])
const DAY_S = 86_400
/** ≤ 40 requests/minute: the live session polls with the same user token. */
export const MIN_INTERVAL_MS = 1_500
const RETRY_BACKOFF_MS = [10_000, 30_000, 60_000]

export type Thread = { root: RawMsg; replies: RawMsg[] }
export type Names = (id: string) => string

// ---------- pure formatting ----------

/** Wall-clock parts of a Slack ts in Europe/Berlin. */
export function berlinParts(ts: string): { date: string; time: string; month: string } {
  const d = new Date(Math.floor(Number(ts) * 1000))
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).map((x) => [x.type, x.value]),
  )
  const date = `${p.year}-${p.month}-${p.day}`
  return { date, time: `${p.hour}:${p.minute}`, month: `${p.year}-${p.month}` }
}

/** Berlin offset from UTC (ms) at a given instant. */
function berlinOffsetMs(utcMs: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(utcMs)).map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - utcMs
}

/** Slack ts (seconds) of Berlin midnight at the first day of the month that contains `ts`. */
export function monthStartTs(ts: number): number {
  const { month } = berlinParts(String(ts))
  const [y, m] = month.split('-').map(Number) as [number, number]
  const guess = Date.UTC(y, m - 1, 1)
  return Math.floor((guess - berlinOffsetMs(guess)) / 1000)
}

/** Slack ts of Berlin midnight on YYYY-MM-DD. */
export function dayStartTs(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) throw new Error(`--since must be YYYY-MM-DD, got ${day}`)
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Math.floor((guess - berlinOffsetMs(guess)) / 1000)
}

const decodeEntities = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** User ids mentioned as <@U…> in a text. */
export function mentionedUsers(text: string): string[] {
  return [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!)
}

/** Slack markup → readable text: <@U>→@Name, <#C|n>→#n, <url|label>→label (url), <!here>→@here. */
export function humanize(text: string, names: Names): string {
  const out = text.replace(/<([^<>]+)>/g, (_all, inner: string) => {
    const [target = '', label] = splitOnce(inner, '|')
    if (target.startsWith('@')) return '@' + names(target.slice(1))
    if (target.startsWith('#')) return '#' + (label ?? target.slice(1))
    if (target.startsWith('!subteam^')) return label ?? '@group'
    if (target.startsWith('!')) return '@' + (label ?? target.slice(1)).replace(/^@/, '')
    if (target.startsWith('mailto:')) return label ?? target.slice(7)
    return label && label !== target ? `${label} (${target})` : target
  })
  return decodeEntities(out)
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep)
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)]
}

export function permalink(channel: string, ts: string, threadTs?: string): string {
  const base = `${WORKSPACE}/archives/${channel}/p${ts.replace('.', '')}`
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base
}

/** Human messages only: no bots, no join/leave/topic and other service subtypes. */
export function isKept(m: RawMsg): boolean {
  if (m.bot_id || m.subtype === 'bot_message') return false
  return m.subtype === undefined || KEPT_SUBTYPES.has(m.subtype)
}

function body(m: RawMsg, names: Names): string {
  const text = humanize(m.text ?? '', names).trim()
  const files = (m.files ?? []).map((f) => f.name).filter(Boolean)
  const fileLine = files.length ? `[${files.join(', ')}]` : ''
  return [text, fileLine].filter(Boolean).join('\n') || '(пусто)'
}

function author(m: RawMsg, names: Names): string {
  return m.user ? names(m.user) : 'unknown'
}

/** One thread as Markdown: root heading + text + permalink, replies indented under it. */
export function formatThread(channel: string, t: Thread, names: Names): string {
  const r = berlinParts(t.root.ts)
  const lines = [`### ${r.date} ${r.time} · ${author(t.root, names)}`, body(t.root, names), permalink(channel, t.root.ts)]
  for (const rep of t.replies) {
    const p = berlinParts(rep.ts)
    lines.push('')
    lines.push(`    ↳ ${p.date} ${p.time} · ${author(rep, names)}`)
    for (const l of body(rep, names).split('\n')) lines.push(`    ${l}`)
    lines.push(`    ${permalink(channel, rep.ts, t.root.ts)}`)
  }
  return lines.join('\n')
}

/**
 * Builds threads from channel history and fetched replies: kept messages only, deduped by ts,
 * chronological. A thread_broadcast whose root is in the window shows only as a reply.
 */
export function buildThreads(history: RawMsg[], replies: Map<string, RawMsg[]>): Thread[] {
  const roots = new Map<string, RawMsg>()
  for (const m of history) if (isKept(m) && (!m.thread_ts || m.thread_ts === m.ts)) roots.set(m.ts, m)
  // Thread replies broadcast to the channel whose root is outside the window stand alone.
  const inWindow = new Set(history.map((h) => h.ts))
  for (const m of history) if (isKept(m) && m.thread_ts && m.thread_ts !== m.ts && !inWindow.has(m.thread_ts)) roots.set(m.ts, m)
  const threads: Thread[] = []
  for (const root of roots.values()) {
    const seen = new Set<string>([root.ts])
    const reps: RawMsg[] = []
    for (const r of replies.get(root.ts) ?? []) {
      if (seen.has(r.ts) || !isKept(r)) continue
      seen.add(r.ts)
      reps.push(r)
    }
    reps.sort((a, b) => Number(a.ts) - Number(b.ts))
    threads.push({ root, replies: reps })
  }
  return threads.sort((a, b) => Number(a.root.ts) - Number(b.root.ts))
}

/** Threads bucketed by the Berlin month of their root. */
export function bucketByMonth(threads: Thread[]): Map<string, Thread[]> {
  const out = new Map<string, Thread[]>()
  for (const t of threads) {
    const { month } = berlinParts(t.root.ts)
    const list = out.get(month) ?? []
    list.push(t)
    out.set(month, list)
  }
  return out
}

export function formatMonth(channel: string, channelName: string, month: string, threads: Thread[], names: Names): string {
  return [`# #${channelName} — ${month}`, '', ...threads.map((t) => formatThread(channel, t, names) + '\n')].join('\n')
}

export type MonthStats = { messages: number; replies: number; threads: number; first?: string; last?: string }

/** Counts from a written month file: roots, replies, threads with replies, first/last date. */
export function monthStats(md: string): MonthStats {
  const s: MonthStats = { messages: 0, replies: 0, threads: 0 }
  let inThread = false
  for (const line of md.split('\n')) {
    const h = /^### (\d{4}-\d{2}-\d{2})/.exec(line)
    if (h) {
      s.messages++
      inThread = false
      s.first ??= h[1]
      s.last = h[1]
    } else if (/^    ↳ /.test(line)) {
      s.replies++
      if (!inThread) s.threads++
      inThread = true
    }
  }
  return s
}

export function formatIndex(channel: string, channelName: string, months: [string, MonthStats][]): string {
  const sorted = [...months].sort(([a], [b]) => a.localeCompare(b))
  const firsts = sorted.map(([, s]) => s.first).filter(Boolean) as string[]
  const lasts = sorted.map(([, s]) => s.last).filter(Boolean) as string[]
  const total = sorted.reduce((a, [, s]) => ({ m: a.m + s.messages, r: a.r + s.replies, t: a.t + s.threads }), { m: 0, r: 0, t: 0 })
  return [
    `# #${channelName} (${channel})`,
    '',
    `Период: ${firsts[0] ?? '—'} … ${lasts.at(-1) ?? '—'}`,
    `Всего: ${total.m} сообщений, ${total.r} ответов в ${total.t} тредах`,
    '',
    '| Месяц | Сообщений | Тредов | Ответов |',
    '|---|---|---|---|',
    ...sorted.map(([m, s]) => `| [${m}](${m}.md) | ${s.messages} | ${s.threads} | ${s.replies} |`),
    '',
  ].join('\n')
}

/** Newest ts referenced by any permalink in the dumped files, or undefined. */
export function newestDumpedTs(texts: string[]): number | undefined {
  let max: number | undefined
  for (const t of texts) {
    for (const m of t.matchAll(/\/archives\/[A-Z0-9]+\/p(\d{10})(\d{6})/g)) {
      const ts = Number(`${m[1]}.${m[2]}`)
      if (max === undefined || ts > max) max = ts
    }
  }
  return max
}

/** Start of the window: explicit --since, else newest dumped − 1 day; always floored to a month start. */
export function windowStart(since: string | undefined, newest: number | undefined): number | undefined {
  if (since) return monthStartTs(dayStartTs(since))
  if (newest === undefined) return undefined
  return monthStartTs(newest - DAY_S)
}

export type Args = { channels: string[]; since?: string; out: string }

export function parseArgs(argv: string[]): Args {
  const a: Args = { channels: [], out: 'knowledge/slack' }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    if ((k === '--channel' || k === '--since' || k === '--out') && v === undefined) throw new Error(`${k} needs a value`)
    if (k === '--channel') a.channels.push(v!), i++
    else if (k === '--since') a.since = v!, i++
    else if (k === '--out') a.out = v!, i++
    else throw new Error(`unknown argument ${k}`)
  }
  if (!a.channels.length) throw new Error('at least one --channel is required')
  if (a.since) dayStartTs(a.since)
  return a
}

/** Directory-safe channel name. */
export function safeName(name: string): string {
  return name.replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'channel'
}

// ---------- network ----------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** fetch that spaces every request (429 retries included) at least MIN_INTERVAL_MS apart. */
export function pacedFetch(inner: typeof fetch = fetch, interval = MIN_INTERVAL_MS, wait = sleep, now = Date.now): typeof fetch {
  let next = 0
  let requests = 0
  const f = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const t = now()
    const at = Math.max(t, next)
    next = at + interval
    if (at > t) await wait(at - t)
    requests++
    return inner(input, init)
  }) as typeof fetch
  Object.defineProperty(f, 'requests', { get: () => requests })
  return f
}

const RETRYABLE = /HTTP 429|HTTP 5\d\d|timed out|fetch failed|ECONNRESET|ETIMEDOUT|network|ratelimited/i

/** Outer retry with backoff (the client itself retries a 429 once). */
export async function withRetry<T>(what: string, fn: () => Promise<T>, wait = sleep, backoff = RETRY_BACKOFF_MS, log = (s: string) => { process.stderr.write(s) }): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt >= backoff.length || !RETRYABLE.test(msg)) throw err
      log(`  retry ${attempt + 1}/${backoff.length} ${what} after ${msg.slice(0, 60)}\n`)
      await wait(backoff[attempt]!)
    }
  }
}

async function dumpChannel(slack: SlackClient, channel: string, args: Args, outRoot: string, nameOf: (id: string) => Promise<string>): Promise<void> {
  const channelName = await withRetry('conversations.info', () => slack.channelName(channel))
  const dir = join(outRoot, safeName(channelName))
  mkdirSync(dir, { recursive: true })
  const existing = readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.md$/.test(f))
  const newest = newestDumpedTs(existing.map((f) => readFileSync(join(dir, f), 'utf8')))
  const start = windowStart(args.since, newest)
  if (start === undefined) throw new Error(`#${channelName}: nothing dumped yet, pass --since YYYY-MM-DD`)
  const startTs = `${start - 1}.999999` // history `oldest` is exclusive
  process.stderr.write(`#${channelName} (${channel}): from ${berlinParts(String(start)).date}\n`)

  const history = await withRetry('conversations.history', () => slack.history(channel, startTs))
  process.stderr.write(`  history: ${history.length} messages\n`)
  const replies = new Map<string, RawMsg[]>()
  const withReplies = history.filter((m) => (m.reply_count ?? 0) > 0 && (!m.thread_ts || m.thread_ts === m.ts))
  let done = 0
  for (const m of withReplies) {
    const reps = await withRetry('conversations.replies', () => slack.replies(channel, m.ts))
    replies.set(m.ts, reps.filter((r) => r.ts !== m.ts))
    done++
    if (done % 10 === 0 || done === withReplies.length) process.stderr.write(`  threads: ${done}/${withReplies.length}\n`)
  }

  const threads = buildThreads(history, replies)
  // Resolve every author and mention before formatting (formatting is synchronous).
  const ids = new Set<string>()
  for (const t of threads) for (const m of [t.root, ...t.replies]) {
    if (m.user) ids.add(m.user)
    for (const u of mentionedUsers(m.text ?? '')) ids.add(u)
  }
  const resolved = new Map<string, string>()
  for (const id of ids) resolved.set(id, await nameOf(id))
  const names: Names = (id) => resolved.get(id) ?? id

  const months = bucketByMonth(threads)
  for (const [month, list] of months) writeFileSync(join(dir, `${month}.md`), formatMonth(channel, channelName, month, list, names))

  const allMonths = readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.md$/.test(f))
  const stats = allMonths.map((f) => [f.slice(0, 7), monthStats(readFileSync(join(dir, f), 'utf8'))] as [string, MonthStats])
  writeFileSync(join(dir, 'index.md'), formatIndex(channel, channelName, stats))
  const tot = stats.reduce((a, [, s]) => ({ m: a.m + s.messages, r: a.r + s.replies, t: a.t + s.threads }), { m: 0, r: 0, t: 0 })
  process.stderr.write(`  wrote ${months.size} month file(s); channel total: ${tot.m} messages, ${tot.t} threads, ${tot.r} replies, ${allMonths.length} months\n`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const repo = resolve(dirname(import.meta.path), '..')
  const outRoot = resolve(repo, args.out)
  const { slackToken } = loadSecrets()
  const fetchImpl = pacedFetch()
  // No resetBudget(): the client stays unbudgeted, so a long export is never cut short.
  const slack = new SlackClient(slackToken, fetchImpl)
  const cache = new Map<string, string>()
  const nameOf = async (id: string): Promise<string> => {
    const hit = cache.get(id)
    if (hit) return hit
    let name = id
    try { name = await withRetry('users.info', () => slack.userName(id)) } catch { /* unknown user: keep the id */ }
    cache.set(id, name)
    return name
  }
  for (const channel of args.channels) await dumpChannel(slack, channel, args, outRoot, nameOf)
  process.stderr.write(`done: ${(fetchImpl as unknown as { requests: number }).requests} Slack requests\n`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (err) {
    process.stderr.write(`slack-dump error: ${err instanceof Error ? err.message : 'unknown'}\n`)
    process.exit(1)
  }
}
