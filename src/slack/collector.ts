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

type Read = { raws: RawMsg[]; cursors: Record<string, string> }

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
        const { raws, cursors } = await read()
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
      } catch (err) {
        log(name, err)
      }
    }

    for (const dm of await this.listDms()) {
      await run(`${dm.type} ${dm.id}`, dm.type, () => this.readHistory(dm.id, nowTs))
    }
    await run('mentions', 'mention', () => this.readMentions(now))
    for (const channel of this.cfg.watchChannels) {
      await run(`channel ${channel}`, 'channel', () => this.readChannel(channel, nowTs, now))
    }
    for (const key of Object.keys(this.state.watchedThreads)) {
      const i = key.lastIndexOf(':')
      const [channel, threadTs] = [key.slice(0, i), key.slice(i + 1)]
      await run(`thread ${key}`, 'followup', () => this.readThread(channel, threadTs, nowTs))
    }

    return out.sort((a, b) => cmpTs(a.msg.ts, b.msg.ts))
  }

  private async listDms(): Promise<{ id: string; type: 'im' | 'mpim' }[]> {
    try { return await this.slack.listDms() } catch (err) { log('listDms', err); return [] }
  }

  private withChannel(raws: RawMsg[], channel: string): RawMsg[] {
    return raws.map((m) => ({ ...m, channel }))
  }

  private async readHistory(channel: string, nowTs: string): Promise<Read> {
    const key = `hist:${channel}`
    const cursor = this.state.cursors[key]
    if (!cursor) return { raws: [], cursors: { [key]: nowTs } }
    const raws = this.withChannel(await this.slack.history(channel, cursor), channel)
    return { raws, cursors: { [key]: maxTs(cursor, ...raws.map((m) => m.ts))! } }
  }

  private async readThread(channel: string, threadTs: string, nowTs: string, defaultCursor?: string): Promise<Read> {
    const key = `thr:${channel}:${threadTs}`
    const cursor = this.state.cursors[key] ?? defaultCursor
    if (!cursor) return { raws: [], cursors: { [key]: nowTs } }
    const raws = this.withChannel(await this.slack.replies(channel, threadTs, cursor), channel)
    return { raws, cursors: { [key]: maxTs(cursor, threadTs, ...raws.map((m) => m.ts))! } }
  }

  private async readMentions(now: number): Promise<Read> {
    const cursor = this.state.cursors.search
    const today = isoDate(now)
    if (!cursor) return { raws: [], cursors: { search: today } }
    // Slack's `after:` is exclusive, so query from the day before the (inclusive) cursor date.
    const startOfCursor = Date.parse(`${cursor}T00:00:00Z`) / 1000
    const all = await this.slack.searchMentions(this.cfg.userId, isoDate(Date.parse(`${cursor}T00:00:00Z`) - DAY_MS))
    const raws = all.filter((m) => Number(m.ts) >= startOfCursor)
    const latest = maxTs(undefined, ...raws.map((m) => m.ts))
    return { raws, cursors: { search: latest ? isoDate(Number(latest.split('.')[0]) * 1000) : cursor } }
  }

  private async readChannel(channel: string, nowTs: string, now: number): Promise<Read> {
    const histKey = `hist:${channel}`
    const prev = this.state.cursors[histKey]
    if (!prev) return { raws: [], cursors: { [histKey]: nowTs } }
    const hist = await this.readHistory(channel, nowTs)
    const raws = [...hist.raws]
    const cursors = { ...hist.cursors }

    const threads = new Set<string>()
    for (const m of hist.raws) if (m.thread_ts || (m.reply_count ?? 0) > 0) threads.add(m.thread_ts ?? m.ts)
    // Threads already followed, still active within followUpDays (cursor = last reply seen).
    const horizon = `${Math.floor((now - this.cfg.followUpDays * DAY_MS) / 1000)}.000000`
    const prefix = `thr:${channel}:`
    for (const [k, v] of Object.entries(this.state.cursors)) if (k.startsWith(prefix) && cmpTs(v, horizon) >= 0) threads.add(k.slice(prefix.length))

    for (const threadTs of threads) {
      const thr = await this.readThread(channel, threadTs, nowTs, prev)
      raws.push(...thr.raws)
      Object.assign(cursors, thr.cursors)
    }
    return { raws, cursors }
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
      await this.slack.downloadFile(f.url_private_download, path)
      files.push({ id: f.id, name: f.name, path })
    }
    const permalink = await this.soft(`permalink ${channel}:${ts}`, () => this.slack.permalink(channel, ts))
    return {
      channel, ts, threadTs: raw.thread_ts, user, userName: this.state.users[user], text: raw.text,
      ...(files.length ? { files } : {}), ...(permalink ? { permalink } : {}),
    }
  }
}
