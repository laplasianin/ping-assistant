// Slack Socket Mode: message events over a WebSocket, so new messages arrive within seconds.
// Logs carry connection states only, never message text.
import type { RawMsg } from './client'

export type ChannelType = 'im' | 'mpim' | 'channel' | 'group'
export type SocketEvent = RawMsg & { channel: string; channelType: ChannelType }

/** The part of a WebSocket the client uses: Bun's global WebSocket fits, tests inject a fake. */
export type WebSocketLike = {
  send(data: string): void
  close(): void
  onopen: ((ev: any) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number }) => void) | null
  onerror: ((ev: any) => void) | null
}

export type SlackSocketOptions = {
  onEvent: (raw: SocketEvent) => void
  fetchImpl?: typeof fetch
  wsFactory?: (url: string) => WebSocketLike
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

const OPEN_URL = 'https://slack.com/api/apps.connections.open'
const MIN_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 15_000
const OPEN_TIMEOUT_MS = 30_000
const CHANNEL_TYPES = new Set<string>(['im', 'mpim', 'channel', 'group'])

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref())
const defaultLog = (line: string): void => { process.stderr.write(`ping-assistant: ${line}\n`) }

function frameText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new TextDecoder().decode(data as ArrayBuffer)
  return String(data)
}

/** A Slack message event as the collector's RawMsg; undefined for events it cannot place. */
function toEvent(e: Record<string, any>): SocketEvent | undefined {
  if (typeof e.channel !== 'string' || typeof e.ts !== 'string' || !CHANNEL_TYPES.has(e.channel_type)) return undefined
  const files = Array.isArray(e.files)
    ? e.files.map((f: Record<string, any>) => ({ id: f.id, name: f.name, url_private_download: f.url_private_download }))
    : undefined
  return {
    channel: e.channel, channelType: e.channel_type, ts: e.ts, thread_ts: e.thread_ts, user: e.user, bot_id: e.bot_id,
    subtype: e.subtype, text: typeof e.text === 'string' ? e.text : '', files, latest_reply: undefined,
  }
}

export class SlackSocket {
  private readonly fetchImpl: typeof fetch
  private readonly wsFactory: (url: string) => WebSocketLike
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: (line: string) => void
  private stopped = true
  private connected = false
  private ws: WebSocketLike | undefined
  /** Ends the current connection's wait; set while a WebSocket is open. */
  private endSession: (() => void) | undefined

  constructor(private readonly appToken: string, private readonly opts: SlackSocketOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike)
    this.sleep = opts.sleep ?? defaultSleep
    this.log = opts.log ?? defaultLog
  }

  isConnected(): boolean {
    return this.connected
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.loop()
  }

  stop(): void {
    this.stopped = true
    this.connected = false
    try { this.ws?.close() } catch {}
    this.endSession?.()
  }

  /** One connection after another; the WebSocket URL is single-use, so every attempt opens a new one. */
  private async loop(): Promise<void> {
    let delay = MIN_BACKOFF_MS
    while (!this.stopped) {
      let outcome: 'hello' | 'refresh' | 'failed' = 'failed'
      try {
        outcome = await this.session(await this.open())
      } catch (err) {
        this.log(`socket: open failed (${err instanceof Error ? err.name : 'unknown'})`)
      }
      if (this.stopped) break
      if (outcome === 'refresh') { delay = MIN_BACKOFF_MS; continue } // Slack asked for it: reconnect right away
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

  /** Resolves when the connection ends: 'hello' if it was established, 'refresh' on a requested disconnect. */
  private session(url: string): Promise<'hello' | 'refresh' | 'failed'> {
    return new Promise((resolve) => {
      let outcome: 'hello' | 'refresh' | 'failed' = 'failed'
      let done = false
      const ws = this.wsFactory(url)
      this.ws = ws
      const end = (): void => {
        if (done) return
        done = true
        this.connected = false
        this.ws = undefined
        this.endSession = undefined
        resolve(outcome)
      }
      this.endSession = end
      ws.onmessage = (ev) => {
        let msg: Record<string, any>
        try { msg = JSON.parse(frameText(ev.data)) as Record<string, any> } catch { return }
        if (msg.type === 'hello') {
          outcome = 'hello'
          this.connected = true
          this.log('socket: connected')
        } else if (msg.type === 'disconnect') {
          this.log('socket: disconnect requested')
          outcome = 'refresh'
          end() // before close(): the close that follows is ours, not news
          try { ws.close() } catch {}
        } else if (typeof msg.envelope_id === 'string') {
          // Ack first: Slack redelivers an envelope that is not acked within 3s.
          ws.send(JSON.stringify({ envelope_id: msg.envelope_id }))
          const event = msg.type === 'events_api' ? msg.payload?.event : undefined
          if (event?.type !== 'message') return
          const raw = toEvent(event)
          if (raw) this.opts.onEvent(raw)
        }
      }
      ws.onclose = (ev) => {
        if (!done && !this.stopped) this.log(`socket: closed (${ev?.code ?? 'unknown'})`)
        end()
      }
      ws.onerror = () => {
        try { ws.close() } catch {}
        end()
      }
    })
  }
}
