import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config'
import type { ItemSource, SlackMsg, State } from '../state'
import { BudgetExceeded, type RawMsg, type SlackClient } from './client'

export type Collected = { msg: SlackMsg; source: ItemSource }
/**
 * One tick's output. The collector never writes state.cursors itself: the caller applies
 * cursorUpdates (and removes removeCursors) only after every collected message is ingested,
 * so a crash or restart mid-tick replays the messages instead of skipping them.
 */
export type TickResult = { collected: Collected[]; cursorUpdates: Record<string, string>; removeCursors: string[] }

const SKIP_SUBTYPES = new Set(['message_changed', 'message_deleted', 'channel_join', 'channel_leave', 'bot_message', 'channel_topic', 'channel_purpose'])
const DAY_MS = 86_400_000
/** Quiet MPIMs (no activity in 24h) are read on every MPIM_SWEEP_EVERY-th tick only. */
const MPIM_SWEEP_EVERY = 10
/** IMs are read when the `is:dm` search finds something new; this sweep is only the safety net for a stale index. */
const IM_SWEEP_EVERY = 30
/** search.messages indexes with a lag: the floor trails the newest hit so late-indexed messages are still found. */
const SEARCH_LAG_S = 600

export function cmpTs(a: string, b: string): number {
  const [as = '0', af = ''] = a.split('.')
  const [bs = '0', bf = ''] = b.split('.')
  return Number(as) - Number(bs) || (af.padEnd(6, '0') < bf.padEnd(6, '0') ? -1 : af.padEnd(6, '0') > bf.padEnd(6, '0') ? 1 : 0)
}
const maxTs = (a: string | undefined, ...rest: (string | undefined)[]): string | undefined =>
  [a, ...rest].reduce((m, t) => (t && (!m || cmpTs(t, m) > 0) ? t : m), undefined as string | undefined)
const minTs = (a: string, b: string): string => (cmpTs(a, b) <= 0 ? a : b)
const tsOf = (ms: number): string => `${Math.floor(ms / 1000)}.000000`
const shiftTs = (ts: string, seconds: number): string => {
  const [s = '0', f = '000000'] = ts.split('.')
  return `${Number(s) + seconds}.${f.padEnd(6, '0')}`
}
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const log = (source: string, err: unknown): void => {
  process.stderr.write(`ping-assistant: ${source} failed: ${err instanceof Error ? err.message : String(err)}\n`)
}

type Read = { raws: RawMsg[]; cursors: Record<string, string>; remove?: string[] }
/** One tick's DM search: the DMs to read now, and the floor to commit once they are read. */
type Discovery = { active: Set<string>; floor: string }

/** Commits a tick's cursors; a cursor never moves backwards (the orchestrator may have advanced it meanwhile). */
export function applyCursors(state: State, r: Pick<TickResult, 'cursorUpdates' | 'removeCursors'>): void {
  for (const k of r.removeCursors) delete state.cursors[k]
  for (const [k, v] of Object.entries(r.cursorUpdates)) {
    const cur = state.cursors[k]
    if (!cur || cmpTs(v, cur) > 0) state.cursors[k] = v
  }
}

export class Collector {
  constructor(
    private readonly slack: SlackClient,
    private readonly cfg: Config,
    private readonly state: State,
    private readonly filesDir: string,
  ) {}

  /** Set when the tick's Slack request budget runs out: the remaining sources wait for the next tick. */
  private exhausted = false

  async tick(now: number): Promise<TickResult> {
    const nowTs = tsOf(now)
    const out: Collected[] = []
    const seen = new Map<string, Collected>()
    const cursorUpdates: Record<string, string> = {}
    const removeCursors = this.expireWatched(now)
    this.slack.resetBudget()
    this.exhausted = false
    let deferred = 0
    const tickNo = this.state.tickCount ?? 0
    this.state.tickCount = tickNo + 1

    /** Resolves true when the source was read (its cursors staged), false when it failed or was deferred. */
    const run = async (name: string, source: ItemSource, read: () => Promise<Read>): Promise<boolean> => {
      if (this.exhausted) { deferred++; return false } // cursors untouched: read next tick
      try {
        const { raws, cursors, remove } = await read()
        const built: Collected[] = []
        const local = new Map<string, Collected>()
        for (const raw of raws) {
          const key = `${raw.channel}:${raw.ts}`
          if (SKIP_SUBTYPES.has(raw.subtype ?? '') || raw.bot_id || !raw.channel) continue
          const earlier = seen.get(key)
          // Mentions are read before DMs: a DM read of the same message decides that it is a DM item.
          if (earlier?.source === 'mention' && (source === 'im' || source === 'mpim')) earlier.source = source
          if (earlier || local.has(key) || this.state.msgIndex[key]) continue
          const c: Collected = { msg: await this.toMsg(raw as RawMsg & { channel: string }), source: source === 'mention' && raw.dm ? raw.dm : source }
          local.set(key, c)
          built.push(c)
        }
        for (const [k, c] of local) seen.set(k, c)
        out.push(...built)
        Object.assign(cursorUpdates, cursors)
        removeCursors.push(...(remove ?? []))
        return true
      } catch (err) {
        if (err instanceof BudgetExceeded) { this.exhausted = true; deferred++; return false }
        log(name, err)
        return false
      }
    }

    // Fixed-cost sources first: however many DMs there are, they cannot starve mentions, channels or follow-ups.
    await run('mentions', 'mention', () => this.readMentions(nowTs))
    for (const channel of this.cfg.watchChannels) {
      await run(`channel ${channel}`, 'channel', () => this.readChannel(channel, nowTs, now))
    }
    for (const key of Object.keys(this.state.watchedThreads)) {
      const i = key.lastIndexOf(':')
      const [channel, threadTs] = [key.slice(0, i), key.slice(i + 1)]
      if (this.cfg.watchChannels.includes(channel)) continue // readChannel tracks it through its thr: cursor
      await run(`thread ${key}`, 'followup', () => this.readThread(channel, threadTs, nowTs))
    }

    const dms = this.exhausted ? [] : await this.listDms()
    // One search per tick tells which DMs have something new; only those are read (mark-and-read: the hit
    // only triggers the history read, so files, subtypes and ordering stay those of the history path).
    let discovery: Discovery | undefined
    if (dms.length && !this.exhausted) {
      try { discovery = await this.discoverDms(nowTs) } catch (err) {
        if (err instanceof BudgetExceeded) { this.exhausted = true; deferred++ } else log('dm search', err)
      }
    }
    const readDm = (dm: { id: string; type: 'im' | 'mpim' }) => run(`${dm.type} ${dm.id}`, dm.type, () => this.readDm(dm.id, nowTs))
    // IMs are hot only on a search hit (or, if the search failed, on 24h activity as before); MPIMs keep the
    // 24h tiering because `is:dm` is not known to cover group DMs, and are also read on a hit.
    const hot = (dm: { id: string; type: 'im' | 'mpim' }): boolean =>
      !this.state.cursors[`hist:${dm.id}`] || this.isSelfTestDm(dm.id) || discovery?.active.has(dm.id) === true
      || ((dm.type === 'mpim' || !discovery) && this.recentlyActive(dm.id, now))
    const quiet: typeof dms = []
    let hitsRead = true
    for (const dm of dms) {
      if (!hot(dm)) { quiet.push(dm); continue }
      const ok = await readDm(dm) // a new DM on the very first run costs no request
      if (discovery?.active.has(dm.id) && !ok && this.exhausted) hitsRead = false
    }
    // The search floor holds while a DM it pointed at is deferred by the budget, so the hit is found again next
    // tick. A DM whose read fails outright does not hold it (it would pin the floor); its hist: cursor stays.
    if (discovery && hitsRead) cursorUpdates.dmsearch = discovery.floor
    await this.sweep('dmSweepAfter', quiet.filter((d) => d.type === 'mpim'), tickNo % MPIM_SWEEP_EVERY === 0, readDm)
    await this.sweep('imSweepAfter', quiet.filter((d) => d.type === 'im'), tickNo % IM_SWEEP_EVERY === 0, readDm)

    if (this.exhausted) process.stderr.write(`ping-assistant: slack request budget exhausted, ${deferred} source(s) deferred to the next tick\n`)
    cursorUpdates.lastTick = nowTs
    return { collected: out.sort((a, b) => cmpTs(a.msg.ts, b.msg.ts)), cursorUpdates, removeCursors }
  }

  /**
   * Quiet DMs: a round-robin sweep when due; one cut short by the budget (even before its first read) resumes
   * next tick after the last DM it read, so no DM is starved by those listed before it.
   */
  private async sweep(key: 'dmSweepAfter' | 'imSweepAfter', quiet: { id: string; type: 'im' | 'mpim' }[], due: boolean, readDm: (dm: { id: string; type: 'im' | 'mpim' }) => Promise<boolean>): Promise<void> {
    if (this.state[key] === undefined && due) this.state[key] = ''
    const after = this.state[key]
    if (after === undefined) return
    for (const dm of quiet.sort((a, b) => (a.id < b.id ? -1 : 1)).filter((d) => d.id > after)) {
      await readDm(dm)
      if (this.exhausted) return
      this.state[key] = dm.id
    }
    this.state[key] = undefined
  }

  /**
   * DMs with a search hit newer than both the dmsearch floor and the DM's own hist: cursor. Thread replies are
   * skipped: a history read would not surface them. The floor trails the newest hit like the mentions floor.
   */
  private async discoverDms(nowTs: string): Promise<Discovery> {
    const floor = this.start('dmsearch')
    if (!floor) return { active: new Set(), floor: nowTs }
    const after = isoDate(Number(floor.split('.')[0]) * 1000 - 2 * DAY_MS)
    const hits = (await this.slack.searchDms(after, floor)).filter((m) => m.channel && cmpTs(m.ts, floor) > 0)
    const active = new Set<string>()
    for (const h of hits) {
      const channel = h.channel!
      const hist = this.state.cursors[`hist:${channel}`]
      if (h.thread_ts && h.thread_ts !== h.ts) continue
      if (this.state.msgIndex[`${channel}:${h.ts}`] || (hist && cmpTs(h.ts, hist) <= 0)) continue
      active.add(channel)
    }
    const newest = maxTs(undefined, ...hits.map((m) => m.ts))
    return { active, floor: newest ? maxTs(floor, shiftTs(newest, -SEARCH_LAG_S))! : floor }
  }

  /** Drops watched threads whose follow-up window has passed, along with the cursor nobody else will track. */
  private expireWatched(now: number): string[] {
    const remove: string[] = []
    const horizon = `${Math.floor((now - this.cfg.followUpDays * DAY_MS) / 1000)}.000000`
    for (const [key, { until }] of Object.entries(this.state.watchedThreads)) {
      if (until >= now) continue
      delete this.state.watchedThreads[key]
      const i = key.lastIndexOf(':')
      const [channel, threadTs] = [key.slice(0, i), key.slice(i + 1)]
      if (cmpTs(threadTs, horizon) < 0 || !this.cfg.watchChannels.includes(channel)) remove.push(`thr:${key}`)
    }
    return remove
  }

  private async listDms(): Promise<{ id: string; type: 'im' | 'mpim'; user?: string }[]> {
    try {
      const dms = await this.slack.listDms()
      const self = dms.find((d) => d.type === 'im' && d.user === this.cfg.userId)
      if (self) this.state.selfDmChannel = self.id
      return dms
    } catch (err) {
      if (err instanceof BudgetExceeded) this.exhausted = true
      else log('listDms', err)
      return []
    }
  }

  /** Active: a message was actually read from it in the last 24h (a first-run cursor stamp is not activity). */
  private recentlyActive(id: string, now: number): boolean {
    const last = this.state.dmActivity?.[id]
    return last !== undefined && Number(last.split('.')[0]) * 1000 >= now - DAY_MS
  }

  /** selfDmTest: the self-DM is the test inbox, so it is always treated as active. */
  private isSelfTestDm(id: string): boolean {
    return this.cfg.dryRun && this.cfg.selfDmTest === true && id === this.state.selfDmChannel
  }

  private async readDm(id: string, nowTs: string): Promise<Read> {
    const read = await this.readHistory(id, nowTs)
    const newest = maxTs(undefined, ...read.raws.map((m) => m.ts))
    if (newest) (this.state.dmActivity ??= {})[id] = maxTs(this.state.dmActivity?.[id], newest)!
    return read
  }

  private withChannel(raws: RawMsg[], channel: string): RawMsg[] {
    return raws.map((m) => ({ ...m, channel }))
  }

  /** A source without a cursor starts at the previous tick; only the very first run starts at now. */
  private start(key: string): string | undefined {
    return this.state.cursors[key] ?? this.state.cursors.lastTick
  }

  private async readHistory(channel: string, nowTs: string): Promise<Read> {
    const key = `hist:${channel}`
    const cursor = this.start(key)
    if (!cursor) return { raws: [], cursors: { [key]: nowTs } }
    const raws = this.withChannel(await this.slack.history(channel, cursor), channel)
    return { raws, cursors: { [key]: maxTs(cursor, ...raws.map((m) => m.ts))! } }
  }

  private async readThread(channel: string, threadTs: string, nowTs: string): Promise<Read> {
    const key = `thr:${channel}:${threadTs}`
    const cursor = this.start(key)
    if (!cursor) return { raws: [], cursors: { [key]: nowTs } }
    const raws = this.withChannel(await this.slack.replies(channel, threadTs, cursor), channel)
    return { raws, cursors: { [key]: maxTs(cursor, ...raws.map((m) => m.ts))! } }
  }

  private async readMentions(nowTs: string): Promise<Read> {
    const floor = this.start('search')
    if (!floor) return { raws: [], cursors: { search: nowTs } }
    // Slack evaluates `after:` in the user's local zone: query two days earlier, filter by exact ts.
    const after = isoDate(Number(floor.split('.')[0]) * 1000 - 2 * DAY_MS)
    const raws = (await this.slack.searchMentions(this.cfg.userId, after)).filter((m) => cmpTs(m.ts, floor) > 0)
    // Hits inside the trailing window come back next tick too; msgIndex and the seen set drop them.
    const newest = maxTs(undefined, ...raws.map((m) => m.ts))
    return { raws, cursors: { search: newest ? maxTs(floor, shiftTs(newest, -SEARCH_LAG_S))! : floor } }
  }

  /**
   * One windowed history read per tick (oldest = followUpDays ago) yields both the new top-level messages
   * (after the hist: cursor) and latest_reply of every recent root, so conversations.replies is called only
   * for threads that moved since their thr: cursor. Watched roots older than the window are always read.
   */
  private async readChannel(channel: string, nowTs: string, now: number): Promise<Read> {
    const histKey = `hist:${channel}`
    const cursor = this.start(histKey)
    if (!cursor) return { raws: [], cursors: { [histKey]: nowTs } }
    const horizon = tsOf(now - this.cfg.followUpDays * DAY_MS)
    const window = this.withChannel(await this.slack.history(channel, minTs(cursor, horizon)), channel)
    const fresh = window.filter((m) => cmpTs(m.ts, cursor) > 0)
    const raws = [...fresh]
    const cursors: Record<string, string> = { [histKey]: maxTs(cursor, ...fresh.map((m) => m.ts))! }
    const remove: string[] = []
    const latestReply = new Map<string, string>()
    for (const m of window) if (m.latest_reply && (m.thread_ts ?? m.ts) === m.ts) latestReply.set(m.ts, m.latest_reply)

    // Any top-level message can become a thread root: track every one from the moment it is seen.
    const prefix = `thr:${channel}:`
    // Roots already in the window at first sight start at the hist: cursor, so only later replies are collected.
    for (const m of window) {
      const isFresh = cmpTs(m.ts, cursor) > 0
      if (!isFresh && m.thread_ts && m.thread_ts !== m.ts) continue // old broadcast reply, not a root
      const rootTs = m.thread_ts ?? m.ts
      const key = `${prefix}${rootTs}`
      if (!(key in this.state.cursors)) cursors[key] = isFresh ? rootTs : cursor
    }

    const tracked = new Set<string>(Object.keys(cursors).filter((k) => k.startsWith(prefix)))
    for (const k of Object.keys(this.state.cursors)) {
      if (!k.startsWith(prefix)) continue
      const threadTs = k.slice(prefix.length)
      if (cmpTs(threadTs, horizon) < 0 && !this.state.watchedThreads[`${channel}:${threadTs}`]) remove.push(k)
      else tracked.add(k)
    }

    for (const key of tracked) {
      const threadTs = key.slice(prefix.length)
      const threadCursor = cursors[key] ?? this.state.cursors[key]!
      const latest = latestReply.get(threadTs)
      const inWindow = cmpTs(threadTs, horizon) >= 0
      if (inWindow && (latest === undefined || cmpTs(latest, threadCursor) <= 0)) continue // thread unchanged
      try {
        const replies = this.withChannel(await this.slack.replies(channel, threadTs, threadCursor), channel)
        raws.push(...replies)
        cursors[key] = maxTs(threadCursor, ...replies.map((m) => m.ts))!
      } catch (err) {
        if (err instanceof BudgetExceeded) { this.exhausted = true; break } // the rest keep their cursors
        log(`thread ${channel}:${threadTs}`, err)
      }
    }
    return { raws, cursors, remove }
  }

  private async soft<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    try { return await fn() } catch (err) { log(what, err); return undefined }
  }

  private async toMsg(raw: RawMsg & { channel: string }): Promise<SlackMsg> {
    const { channel, ts } = raw
    const user = raw.user ?? ''
    if (!this.state.channels[channel]) {
      const name = await this.soft(`channelName ${channel}`, () => this.slack.channelName(channel))
      if (name) this.state.channels[channel] = name
    }
    if (user && !this.state.users[user]) {
      const name = await this.soft(`userName ${user}`, () => this.slack.userName(user))
      if (name) this.state.users[user] = name
    }
    const files: NonNullable<SlackMsg['files']> = []
    for (const f of raw.files ?? []) {
      if (!f.url_private_download) { files.push({ id: f.id, name: f.name }); continue }
      mkdirSync(this.filesDir, { recursive: true })
      const path = join(this.filesDir, `${channel}-${ts}-${f.name.replace(/[\\/]/g, '_')}`)
      try {
        await this.slack.downloadFile(f.url_private_download, path)
        files.push({ id: f.id, name: f.name, path })
      } catch (err) {
        log(`file ${f.id}`, err)
        files.push({ id: f.id, name: f.name })
      }
    }
    const permalink = await this.soft(`permalink ${channel}:${ts}`, () => this.slack.permalink(channel, ts))
    return {
      channel, ts, threadTs: raw.thread_ts, user, userName: this.state.users[user], text: raw.text,
      ...(files.length ? { files } : {}), ...(permalink ? { permalink } : {}),
    }
  }
}
