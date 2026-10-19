import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config'
import type { ItemSource, SlackMsg, State } from '../state'
import type { RawMsg, SlackClient } from './client'

export type Collected = { msg: SlackMsg; source: ItemSource }

const SKIP_SUBTYPES = new Set(['message_changed', 'message_deleted', 'channel_join', 'channel_leave', 'bot_message', 'channel_topic', 'channel_purpose'])
const DAY_MS = 86_400_000

function cmpTs(a: string, b: string): number {
  const [as = '0', af = ''] = a.split('.')
  const [bs = '0', bf = ''] = b.split('.')
  return Number(as) - Number(bs) || (af.padEnd(6, '0') < bf.padEnd(6, '0') ? -1 : af.padEnd(6, '0') > bf.padEnd(6, '0') ? 1 : 0)
}
const maxTs = (a: string | undefined, ...rest: (string | undefined)[]): string | undefined =>
  [a, ...rest].reduce((m, t) => (t && (!m || cmpTs(t, m) > 0) ? t : m), undefined as string | undefined)
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const log = (source: string, err: unknown): void => {
  process.stderr.write(`ping-assistant: ${source} failed: ${err instanceof Error ? err.message : String(err)}\n`)
}

type Read = { raws: RawMsg[]; cursors: Record<string, string>; remove?: string[] }

export class Collector {
  constructor(
    private readonly slack: SlackClient,
    private readonly cfg: Config,
    private readonly state: State,
    private readonly filesDir: string,
  ) {}

  async tick(now: number): Promise<Collected[]> {
    const nowTs = `${Math.floor(now / 1000)}.000000`
    const out: Collected[] = []
    const seen = new Set<string>()

    const run = async (name: string, source: ItemSource, read: () => Promise<Read>): Promise<void> => {
      try {
        const { raws, cursors, remove } = await read()
        const built: Collected[] = []
        const local = new Set<string>()
        for (const raw of raws) {
          const key = `${raw.channel}:${raw.ts}`
          if (SKIP_SUBTYPES.has(raw.subtype ?? '') || raw.bot_id || !raw.channel) continue
          if (seen.has(key) || local.has(key) || this.state.msgIndex[key]) continue
          local.add(key)
          built.push({ msg: await this.toMsg(raw as RawMsg & { channel: string }), source })
        }
        for (const k of local) seen.add(k)
        out.push(...built)
        Object.assign(this.state.cursors, cursors)
        for (const k of remove ?? []) delete this.state.cursors[k]
      } catch (err) {
        log(name, err)
      }
    }

    for (const dm of await this.listDms()) {
      await run(`${dm.type} ${dm.id}`, dm.type, () => this.readHistory(dm.id, nowTs))
    }
    await run('mentions', 'mention', () => this.readMentions(nowTs))
    for (const channel of this.cfg.watchChannels) {
      await run(`channel ${channel}`, 'channel', () => this.readChannel(channel, nowTs, now))
    }
    for (const key of Object.keys(this.state.watchedThreads)) {
      const i = key.lastIndexOf(':')
      const [channel, threadTs] = [key.slice(0, i), key.slice(i + 1)]
      await run(`thread ${key}`, 'followup', () => this.readThread(channel, threadTs, nowTs))
    }

    this.state.cursors.lastTick = nowTs
    return out.sort((a, b) => cmpTs(a.msg.ts, b.msg.ts))
  }

  private async listDms(): Promise<{ id: string; type: 'im' | 'mpim' }[]> {
    try { return await this.slack.listDms() } catch (err) { log('listDms', err); return [] }
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
    return { raws, cursors: { search: maxTs(floor, ...raws.map((m) => m.ts))! } }
  }

  private async readChannel(channel: string, nowTs: string, now: number): Promise<Read> {
    const hist = await this.readHistory(channel, nowTs)
    const raws = [...hist.raws]
    const cursors = { ...hist.cursors }
    const remove: string[] = []
    if (!this.state.cursors[`hist:${channel}`] && !this.state.cursors.lastTick) return hist

    // Any top-level message can become a thread root: track every one from the moment it is seen.
    const prefix = `thr:${channel}:`
    for (const m of hist.raws) {
      const key = `${prefix}${m.thread_ts ?? m.ts}`
      if (!(key in this.state.cursors)) cursors[key] = m.thread_ts ?? m.ts
    }

    const horizon = `${Math.floor((now - this.cfg.followUpDays * DAY_MS) / 1000)}.000000`
    const tracked = new Set<string>(Object.keys(cursors).filter((k) => k.startsWith(prefix)))
    for (const k of Object.keys(this.state.cursors)) {
      if (!k.startsWith(prefix)) continue
      const threadTs = k.slice(prefix.length)
      if (cmpTs(threadTs, horizon) < 0 && !this.state.watchedThreads[`${channel}:${threadTs}`]) remove.push(k)
      else tracked.add(k)
    }

    for (const key of tracked) {
      const threadTs = key.slice(prefix.length)
      const cursor = cursors[key] ?? this.state.cursors[key]!
      try {
        const replies = this.withChannel(await this.slack.replies(channel, threadTs, cursor), channel)
        raws.push(...replies)
        cursors[key] = maxTs(cursor, ...replies.map((m) => m.ts))!
      } catch (err) {
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
