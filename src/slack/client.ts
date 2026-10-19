import { writeFileSync } from 'node:fs'

export type RawMsg = {
  ts: string; thread_ts?: string; user?: string; bot_id?: string; subtype?: string; text: string;
  files?: { id: string; name: string; url_private_download?: string }[];
  channel?: string; permalink?: string; reply_count?: number; latest_reply?: string
}

type SlackResponse = Record<string, any> & { ok: boolean; error?: string; response_metadata?: { next_cursor?: string } }
type Sleep = (ms: number) => Promise<void>

const API = 'https://slack.com/api/'
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: Sleep = defaultSleep,
  ) {}

  private async send(method: string, init: RequestInit, url: string): Promise<SlackResponse> {
    let res = await this.fetchImpl(url, init)
    if (res.status === 429) {
      const seconds = Number(res.headers.get('Retry-After'))
      await this.sleep((Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000)
      res = await this.fetchImpl(url, init)
      if (res.status === 429) throw new Error(`slack ${method}: HTTP 429`)
    }
    const body = (await res.json()) as SlackResponse
    if (!body.ok) throw new Error(`slack ${method}: ${body.error ?? 'unknown_error'}`)
    return body
  }

  private get(method: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<SlackResponse> {
    const url = new URL(API + method)
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v))
    return this.send(method, { headers: { Authorization: `Bearer ${this.token}` } }, url.toString())
  }

  private async getCursorPages(method: string, params: Record<string, string | number | boolean | undefined>, key: string): Promise<any[]> {
    const out: any[] = []
    let cursor: string | undefined
    do {
      const res = await this.get(method, { ...params, limit: 200, cursor })
      out.push(...((res[key] as any[] | undefined) ?? []))
      cursor = res.response_metadata?.next_cursor || undefined
    } while (cursor)
    return out
  }

  async history(channel: string, oldestTs?: string): Promise<RawMsg[]> {
    const params = oldestTs ? { channel, oldest: oldestTs, inclusive: false } : { channel }
    const msgs = (await this.getCursorPages('conversations.history', params, 'messages')) as RawMsg[]
    return msgs.reverse() // Slack returns newest-first
  }

  /** One page (at most `limit`) of top-level messages before `latestTs`, oldest first. */
  async recent(channel: string, latestTs: string, limit: number): Promise<RawMsg[]> {
    const res = await this.get('conversations.history', { channel, latest: latestTs, inclusive: false, limit })
    return ((res.messages as RawMsg[] | undefined) ?? []).reverse()
  }

  async replies(channel: string, threadTs: string, oldestTs?: string): Promise<RawMsg[]> {
    const params = oldestTs ? { channel, ts: threadTs, oldest: oldestTs, inclusive: false } : { channel, ts: threadTs }
    const msgs = (await this.getCursorPages('conversations.replies', params, 'messages')) as RawMsg[]
    return oldestTs ? msgs.filter((m) => m.ts !== threadTs) : msgs
  }

  async searchMentions(userId: string, afterDate: string): Promise<RawMsg[]> {
    const out: RawMsg[] = []
    let page = 1
    let pages = 1
    do {
      const res = await this.get('search.messages', { query: `<@${userId}> after:${afterDate}`, sort: 'timestamp', sort_dir: 'asc', count: 100, page })
      for (const m of (res.messages?.matches ?? []) as (Omit<RawMsg, 'channel'> & { channel?: { id: string } | string })[]) {
        if (m.user === userId) continue
        const threadTs = m.thread_ts ?? (m.permalink ? new URL(m.permalink).searchParams.get('thread_ts') ?? undefined : undefined)
        out.push({ ...m, channel: typeof m.channel === 'string' ? m.channel : m.channel?.id, ...(threadTs ? { thread_ts: threadTs } : {}) })
      }
      pages = res.messages?.paging?.pages ?? 1
      page++
    } while (page <= pages)
    return out
  }

  async listDms(): Promise<{ id: string; type: 'im' | 'mpim' }[]> {
    const chans = await this.getCursorPages('users.conversations', { types: 'im,mpim', exclude_archived: true }, 'channels')
    return chans.map((c) => ({ id: c.id as string, type: c.is_im ? 'im' : 'mpim' }))
  }

  async channelName(id: string): Promise<string> {
    const res = await this.get('conversations.info', { channel: id })
    if (res.channel?.is_im) return 'личка'
    return (res.channel?.name as string | undefined) ?? id
  }

  async userName(id: string): Promise<string> {
    const res = await this.get('users.info', { user: id })
    return (res.user?.real_name || res.user?.name || id) as string
  }

  async permalink(channel: string, ts: string): Promise<string> {
    const res = await this.get('chat.getPermalink', { channel, message_ts: ts })
    return res.permalink as string
  }

  async postMessage(channel: string, text: string, threadTs?: string): Promise<{ ts: string }> {
    const body = JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) })
    const res = await this.send('chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body,
    }, API + 'chat.postMessage')
    return { ts: res.ts as string }
  }

  async downloadFile(url: string, dest: string): Promise<void> {
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}` } })
    if (!res.ok) throw new Error(`slack download: HTTP ${res.status}`)
    writeFileSync(dest, new Uint8Array(await res.arrayBuffer()))
  }
}
