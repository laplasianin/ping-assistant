import { writeFileSync } from 'node:fs'

export type RawMsg = {
  ts: string; thread_ts?: string; user?: string; bot_id?: string; subtype?: string; text: string;
  files?: { id: string; name: string; url_private_download?: string }[];
  channel?: string; permalink?: string; reply_count?: number; latest_reply?: string;
  dm?: 'im' | 'mpim' // search hits only: the match is in a DM, so it is a DM item, not a channel mention
}

type SlackResponse = Record<string, any> & { ok: boolean; error?: string; response_metadata?: { next_cursor?: string } }
type Sleep = (ms: number) => Promise<void>

const API = 'https://slack.com/api/'
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The polling reads (Slack tier 2-3): the only calls that count against the per-tick budget. */
const BUDGETED = new Set(['conversations.history', 'conversations.replies', 'users.conversations', 'search.messages'])
export const DEFAULT_REQUEST_BUDGET = 40
/** A hung Slack request must not freeze the tick (and with it shutdown's final save). */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Thrown instead of calling Slack once a tick has used its request budget. */
export class BudgetExceeded extends Error {
  constructor(limit: number) {
    super(`slack request budget of ${limit} per tick exhausted`)
    this.name = 'BudgetExceeded'
  }
}

/** Search hits carry thread_ts only in the permalink query; a malformed permalink means «not in a thread». */
function threadFromPermalink(permalink: string | undefined): string | undefined {
  if (!permalink) return undefined
  try {
    return new URL(permalink).searchParams.get('thread_ts') ?? undefined
  } catch {
    return undefined
  }
}

type SearchMatch = Omit<RawMsg, 'channel'> & { channel?: { id: string; is_im?: boolean; is_mpim?: boolean } | string }

/** search.messages matches as RawMsg: channel object → id, thread_ts from the permalink, DM kind in `dm`. */
function searchMatches(res: SlackResponse): RawMsg[] {
  return ((res.messages?.matches ?? []) as SearchMatch[]).map((m) => {
    const threadTs = m.thread_ts ?? threadFromPermalink(m.permalink)
    const ch = typeof m.channel === 'string' ? { id: m.channel } : m.channel
    const dm = ch?.is_im ? 'im' : ch?.is_mpim ? 'mpim' : undefined
    return { ...m, channel: ch?.id, ...(threadTs ? { thread_ts: threadTs } : {}), ...(dm ? { dm } : {}) }
  })
}

export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: Sleep = defaultSleep,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * Runs one request (fetch and body) under a deadline. The signal aborts a real fetch; the race also
   * covers an implementation that ignores it.
   */
  private timed<T>(what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.timeout(this.timeoutMs)
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const err = new Error(`slack ${what}: timed out after ${this.timeoutMs}ms`)
        err.name = 'TimeoutError'
        reject(err)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      fn(signal).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  private used = 0
  private limit = Infinity

  /** Starts a new budget window (the collector calls it at the start of each tick). Unbudgeted until first called. */
  resetBudget(limit = DEFAULT_REQUEST_BUDGET): void {
    this.used = 0
    this.limit = limit
  }

  private async send(method: string, init: RequestInit, url: string): Promise<SlackResponse> {
    const once = () => this.timed(method, async (signal) => {
      const res = await this.fetchImpl(url, { ...init, signal })
      if (res.status === 429) return { limited: true as const, retryAfter: res.headers.get('Retry-After') }
      return { limited: false as const, body: (await res.json()) as SlackResponse }
    })
    let r = await once()
    if (r.limited) {
      const seconds = Number(r.retryAfter)
      await this.sleep((Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000)
      r = await once()
      if (r.limited) throw new Error(`slack ${method}: HTTP 429`)
    }
    const body = r.body
    if (!body.ok) throw new Error(`slack ${method}: ${body.error ?? 'unknown_error'}`)
    return body
  }

  private get(method: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<SlackResponse> {
    if (BUDGETED.has(method)) {
      if (this.used >= this.limit) return Promise.reject(new BudgetExceeded(this.limit))
      this.used++
    }
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
      for (const m of searchMatches(res)) if (m.user !== userId) out.push(m)
      pages = res.messages?.paging?.pages ?? 1
      page++
    } while (page <= pages)
    return out
  }

  /**
   * Every IM message (the user's own included) after `afterDate`, oldest first. Pages newest-first and
   * stops at the first page that reaches `floorTs`, so a tick normally costs one request; hits at or
   * below the floor may still be returned and are the caller's to filter.
   */
  async searchDms(afterDate: string, floorTs: string): Promise<RawMsg[]> {
    const out: RawMsg[] = []
    let page = 1
    let pages = 1
    do {
      const res = await this.get('search.messages', { query: `is:dm after:${afterDate}`, sort: 'timestamp', sort_dir: 'desc', count: 100, page })
      const matches = searchMatches(res)
      out.push(...matches)
      const oldest = matches.at(-1)?.ts
      if (oldest === undefined || Number(oldest) <= Number(floorTs)) break
      pages = res.messages?.paging?.pages ?? 1
      page++
    } while (page <= pages)
    return out.reverse()
  }

  async listDms(): Promise<{ id: string; type: 'im' | 'mpim'; user?: string }[]> {
    const chans = await this.getCursorPages('users.conversations', { types: 'im,mpim', exclude_archived: true }, 'channels')
    return chans.map((c) => (c.is_im ? { id: c.id as string, type: 'im' as const, ...(typeof c.user === 'string' ? { user: c.user } : {}) } : { id: c.id as string, type: 'mpim' as const }))
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
    const bytes = await this.timed('download', async (signal) => {
      const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}` }, signal })
      if (!res.ok) throw new Error(`slack download: HTTP ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    })
    writeFileSync(dest, bytes)
  }
}
