// Slack Socket Mode: message events over a WebSocket, so new messages arrive within seconds.
// Logs carry connection states only, never message text.
import type { RawMsg } from './client'

export type ChannelType = 'im' | 'mpim' | 'channel' | 'group'
/** epoch: the connection (SlackSocket.epoch()) it arrived on. */
export type SocketEvent = RawMsg & { channel: string; channelType: ChannelType; epoch: number }
type Outcome = 'hello' | 'refresh' | 'failed'

/** The part of a WebSocket the client uses: Bun's global WebSocket fits, tests inject a fake. */
export type WebSocketLike = {
  send(data: string): void
  close(): void
  onopen: ((ev: any) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number }) => void) | null
  onerror: ((ev: any) => void) | null
  /** Optional (Bun's client WebSocket has them): protocol-level ping and its pong/ping events. */
  ping?: () => void
  addEventListener?: (type: string, fn: (ev: any) => void) => void
  removeEventListener?: (type: string, fn: (ev: any) => void) => void
}

export type SlackSocketOptions = {
  onEvent: (raw: SocketEvent) => void
  fetchImpl?: typeof fetch
  wsFactory?: (url: string) => WebSocketLike
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  now?: () => number
  /** How often to ping() a WebSocket that supports it (60s). */
  pingIntervalMs?: number
}

const OPEN_URL = 'https://slack.com/api/apps.connections.open'
const MIN_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 15_000
const OPEN_TIMEOUT_MS = 30_000
const PING_INTERVAL_MS = 60_000
const CHANNEL_TYPES = new Set<string>(['im', 'mpim', 'channel', 'group'])
/** apps.connections.open errors that retrying cannot fix: log once, stop, keep polling. */
const FATAL_OPEN_ERRORS = new Set(['invalid_auth', 'not_allowed_token_type', 'token_revoked', 'account_inactive', 'missing_scope'])

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref())
const defaultLog = (line: string): void => { process.stderr.write(`ping-assistant: ${line}\n`) }

function frameText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new TextDecoder().decode(data as ArrayBuffer)
  return String(data)
}

/** A Slack message event as the collector's RawMsg; undefined for events it cannot place. */
function toEvent(e: Record<string, any>, epoch: number): SocketEvent | undefined {
  if (e.hidden === true) return undefined // edits, deletions, replied markers: not new messages
  if (typeof e.channel !== 'string' || typeof e.ts !== 'string' || !CHANNEL_TYPES.has(e.channel_type)) return undefined
  const files = Array.isArray(e.files)
    ? e.files.map((f: Record<string, any>) => ({ id: f.id, name: f.name, url_private_download: f.url_private_download }))
    : undefined
  return {
    channel: e.channel, channelType: e.channel_type, ts: e.ts, thread_ts: e.thread_ts, user: e.user, bot_id: e.bot_id,
    subtype: e.subtype, text: typeof e.text === 'string' ? e.text : '', files, latest_reply: undefined, epoch,
  }
}

export class SlackSocket {
  private readonly fetchImpl: typeof fetch
  private readonly wsFactory: (url: string) => WebSocketLike
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: (line: string) => void
  private readonly now: () => number
  private stopped = true
  private gaveUpFlag = false
  private connected = false
  private epochNo = 0
  private lastFrame: number | undefined
  private ws: WebSocketLike | undefined
  /** Ends the current connection's wait; set while a WebSocket is open. */
  private endSession: ((outcome?: Outcome) => void) | undefined

  constructor(private readonly appToken: string, private readonly opts: SlackSocketOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike)
    this.sleep = opts.sleep ?? defaultSleep
    this.log = opts.log ?? defaultLog
    this.now = opts.now ?? Date.now
  }

  isConnected(): boolean {
    return this.connected
  }

  /** Incremented on every hello: events of different epochs may have a gap between them. */
  epoch(): number {
    return this.epochNo
  }

  /** When the current connection last received a frame of any kind (undefined while not connected). */
  lastFrameAt(): number | undefined {
    return this.connected ? this.lastFrame : undefined
  }

  /** A fatal open error stopped the socket for good: only polling is left. */
  gaveUp(): boolean {
    return this.gaveUpFlag
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.loop()
  }

  stop(): void {
    this.stopped = true
    this.connected = false
    const ws = this.ws
    this.endSession?.()
    try { ws?.close() } catch {}
  }

  /** Drops the current connection (it may be half-open after sleep or a network change) and opens a new one. */
  reconnect(reason: string): void {
    const ws = this.ws
    if (!ws || this.stopped) return
    this.log(`socket: reconnect (${reason})`)
    this.endSession?.('refresh')
    try { ws.close() } catch {}
  }

  /** One connection after another; the WebSocket URL is single-use, so every attempt opens a new one. */
  private async loop(): Promise<void> {
    let delay = MIN_BACKOFF_MS
    while (!this.stopped) {
      let outcome: Outcome = 'failed'
      try {
        const url = await this.open()
        if (this.stopped) break // stopped while the open was in flight
        outcome = await this.session(url)
      } catch (err) {
        const name = err instanceof Error ? err.name : 'unknown'
        if (FATAL_OPEN_ERRORS.has(name)) {
          this.log(`socket: open failed (${name}), giving up: polling only`)
          this.stopped = true
          this.gaveUpFlag = true
          break
        }
        this.log(`socket: open failed (${name})`)
      }
      if (this.stopped) break
      if (outcome === 'refresh') {
        // Requested reconnects (Slack's disconnect, a stale connection) are not failures, but never back to back.
        delay = MIN_BACKOFF_MS
        await this.sleep(MIN_BACKOFF_MS)
        continue
      }
      if (outcome === 'hello') delay = MIN_BACKOFF_MS
      this.log(`socket: reconnecting in ${delay / 1000}s`)
      await this.sleep(delay)
      delay = Math.min(delay * 2, MAX_BACKOFF_MS)
    }
  }

  private async open(): Promise<string> {
    const res = await this.fetchImpl(OPEN_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.appToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
    })
    const body = (await res.json()) as { ok?: boolean; url?: string; error?: string }
    if (!body.ok || !body.url) {
      const err = new Error('apps.connections.open failed')
      err.name = body.error ?? `http_${res.status}`
      throw err
    }
    return body.url
  }

  /** Resolves when the connection ends: 'hello' if it was established, 'refresh' on a requested reconnect. */
  private session(url: string): Promise<Outcome> {
    return new Promise((resolve) => {
      let outcome: Outcome = 'failed'
      let done = false
      const ws = this.wsFactory(url)
      this.ws = ws
      const end = (final?: Outcome): void => {
        if (done) return
        done = true
        if (final) outcome = final
        // A replaced or closed socket must not ack, refresh liveness or deliver anything any more.
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
        if (pinger !== undefined) clearInterval(pinger)
        if (pingable) for (const type of ['pong', 'ping']) ws.removeEventListener?.(type, onPong)
        this.connected = false
        this.ws = undefined
        this.endSession = undefined
        resolve(outcome)
      }
      this.endSession = end
      // Feature-detected liveness: a pong (or Slack's own ping) proves the connection is not half-open.
      const onPong = (): void => { if (!done) this.lastFrame = this.now() }
      const pingable = typeof ws.ping === 'function' && typeof ws.addEventListener === 'function'
      let pinger: ReturnType<typeof setInterval> | undefined
      if (pingable) {
        for (const type of ['pong', 'ping']) ws.addEventListener!(type, onPong)
        pinger = setInterval(() => {
          if (!this.connected || this.ws !== ws) return
          try { ws.ping!() } catch {}
        }, this.opts.pingIntervalMs ?? PING_INTERVAL_MS)
        pinger.unref?.()
      }
      const onFrame = (data: unknown): void => {
        this.lastFrame = this.now()
        let msg: Record<string, any>
        try { msg = JSON.parse(frameText(data)) as Record<string, any> } catch { return }
        if (msg.type === 'hello') {
          outcome = 'hello'
          this.epochNo++
          this.connected = true
          this.log('socket: connected')
        } else if (msg.type === 'disconnect') {
          this.log('socket: disconnect requested')
          end('refresh') // before close(): the close that follows is ours, not news
          try { ws.close() } catch {}
        } else if (typeof msg.envelope_id === 'string') {
          // Ack first: Slack redelivers an envelope that is not acked within 3s.
          ws.send(JSON.stringify({ envelope_id: msg.envelope_id }))
          const event = msg.type === 'events_api' ? msg.payload?.event : undefined
          if (event?.type !== 'message') return
          const raw = toEvent(event, this.epochNo)
          if (raw) this.opts.onEvent(raw)
        }
      }
      ws.onmessage = (ev) => {
        try { onFrame(ev?.data) } catch (err) { this.log(`socket: frame failed (${err instanceof Error ? err.name : 'unknown'})`) }
      }
      ws.onclose = (ev) => {
        if (!done && !this.stopped) this.log(`socket: closed (${ev?.code ?? 'unknown'})`)
        end()
      }
      ws.onerror = () => {
        end()
        try { ws.close() } catch {}
      }
    })
  }
}
