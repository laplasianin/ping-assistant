import { test, expect } from 'bun:test'
import { SlackSocket, type SocketEvent, type WebSocketLike } from '../src/slack/socket'

class FakeWs implements WebSocketLike {
  sent: string[] = []
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(readonly url: string, private readonly log: string[]) {}
  send(data: string) { this.sent.push(data); this.log.push(`send ${data}`) }
  close() { if (this.closed) return; this.closed = true; this.onclose?.({ code: 1000 }) }
  emit(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }) }
  drop(code: number) { this.closed = true; this.onclose?.({ code }) }
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)) }

function setup(opts: { failOpens?: number } = {}) {
  const order: string[] = []
  const opens: { url: string; auth: string | null; method?: string }[] = []
  const sockets: FakeWs[] = []
  const sleeps: number[] = []
  const events: SocketEvent[] = []
  const logs: string[] = []
  let failOpens = opts.failOpens ?? 0
  const fetchImpl = (async (url: string, init: RequestInit) => {
    opens.push({ url, auth: new Headers(init.headers).get('authorization'), method: init.method })
    if (failOpens > 0) { failOpens--; throw new TypeError('network down') }
    return new Response(JSON.stringify({ ok: true, url: `wss://socket/${opens.length}` }))
  }) as unknown as typeof fetch
  const socket = new SlackSocket('xapp-test', {
    onEvent: (raw) => { order.push(`event ${raw.ts}`); events.push(raw) },
    fetchImpl,
    wsFactory: (url) => { const ws = new FakeWs(url, order); sockets.push(ws); return ws },
    sleep: async (ms) => { sleeps.push(ms) },
    log: (line) => logs.push(line),
  })
  return { socket, opens, sockets, sleeps, events, logs, order, last: () => sockets[sockets.length - 1]! }
}

test('start opens a connection with the app token; hello marks it connected', async () => {
  const s = setup()
  s.socket.start()
  await flush()
  expect(s.opens).toEqual([{ url: 'https://slack.com/api/apps.connections.open', auth: 'Bearer xapp-test', method: 'POST' }])
  expect(s.last().url).toBe('wss://socket/1')
  expect(s.socket.isConnected()).toBe(false)
  s.last().emit({ type: 'hello', num_connections: 1 })
  expect(s.socket.isConnected()).toBe(true)
  expect(s.logs).toEqual(['socket: connected'])
  s.socket.stop()
})

test('events_api message: ack with the envelope_id first, then onEvent with the mapped RawMsg', async () => {
  const s = setup()
  s.socket.start()
  await flush()
  s.last().emit({ type: 'hello' })
  s.last().emit({
    envelope_id: 'env-1', type: 'events_api', accepts_response_payload: false,
    payload: { event: {
      type: 'message', channel: 'D1', channel_type: 'im', ts: '101.5', thread_ts: '100.0', user: 'U2', text: 'secret text',
      files: [{ id: 'F1', name: 'a.png', url_private_download: 'https://files/a.png', mimetype: 'image/png' }], latest_reply: '200.0',
    } },
  })
  expect(s.order).toEqual(['send {"envelope_id":"env-1"}', 'event 101.5'])
  expect(s.events).toEqual([{
    channel: 'D1', channelType: 'im', ts: '101.5', thread_ts: '100.0', user: 'U2', bot_id: undefined, subtype: undefined,
    text: 'secret text', files: [{ id: 'F1', name: 'a.png', url_private_download: 'https://files/a.png' }], latest_reply: undefined, epoch: 1,
  }])
  expect(s.logs.join('\n')).not.toContain('secret')
  s.socket.stop()
})

test('a bot message keeps bot_id and subtype for the collector to filter', async () => {
  const s = setup()
  s.socket.start()
  await flush()
  s.last().emit({ envelope_id: 'e', type: 'events_api', payload: { event: { type: 'message', subtype: 'bot_message', bot_id: 'B1', channel: 'C1', channel_type: 'channel', ts: '1.0', text: 'x' } } })
  expect(s.events[0]).toMatchObject({ channel: 'C1', channelType: 'channel', bot_id: 'B1', subtype: 'bot_message' })
  s.socket.stop()
})

test('a non-message event is acked only', async () => {
  const s = setup()
  s.socket.start()
  await flush()
  s.last().emit({ envelope_id: 'env-2', type: 'events_api', payload: { event: { type: 'reaction_added', user: 'U2' } } })
  expect(s.last().sent).toEqual(['{"envelope_id":"env-2"}'])
  expect(s.events).toEqual([])
  s.socket.stop()
})

test('disconnect envelope: closes and reconnects with a fresh apps.connections.open', async () => {
  const s = setup()
  s.socket.start()
  await flush()
  const first = s.last()
  first.emit({ type: 'hello' })
  first.emit({ type: 'disconnect', reason: 'refresh_requested' })
  await flush()
  expect(first.closed).toBe(true)
  expect(s.opens.length).toBe(2)
  expect(s.sockets.length).toBe(2)
  expect(s.last().url).toBe('wss://socket/2')
  expect(s.socket.isConnected()).toBe(false)
  expect(s.logs).toContain('socket: disconnect requested')
  s.socket.stop()
})

test('a dropped connection reconnects after a backoff that doubles up to 15s and resets after hello', async () => {
  const s = setup({ failOpens: 0 })
  s.socket.start()
  await flush()
  s.last().emit({ type: 'hello' })
  s.last().drop(1006)
  await flush()
  expect(s.socket.isConnected()).toBe(false)
  expect(s.sleeps).toEqual([1000])
  expect(s.opens.length).toBe(2)
  expect(s.logs).toEqual(['socket: connected', 'socket: closed (1006)', 'socket: reconnecting in 1s'])
  for (let i = 0; i < 5; i++) { s.last().drop(1006); await flush() } // never said hello: backoff grows
  expect(s.sleeps).toEqual([1000, 2000, 4000, 8000, 15000, 15000])
  s.last().emit({ type: 'hello' })
  s.last().drop(1006)
  await flush()
  expect(s.sleeps.at(-1)).toBe(1000)
  s.socket.stop()
})

test('an error event closes the socket and reconnects', async () => {
  const s = setup()
  s.socket.start()
  await flush()
  const first = s.last()
  first.onerror?.({})
  await flush()
  expect(first.closed).toBe(true)
  expect(s.opens.length).toBe(2)
  s.socket.stop()
})

test('a failing apps.connections.open is retried with backoff, logging only the error name', async () => {
  const s = setup({ failOpens: 2 })
  s.socket.start()
  await flush()
  expect(s.opens.length).toBe(3)
  expect(s.sleeps).toEqual([1000, 2000])
  expect(s.logs.slice(0, 2)).toEqual(['socket: open failed (TypeError)', 'socket: reconnecting in 1s'])
  s.socket.stop()
})

test('a retryable ok:false open response is a failure named by its Slack error, retried', async () => {
  const logs: string[] = []
  let calls = 0
  const socket = new SlackSocket('xapp-x', {
    onEvent: () => {},
    fetchImpl: (async () => { calls++; return new Response(JSON.stringify({ ok: false, error: 'ratelimited' })) }) as unknown as typeof fetch,
    wsFactory: () => { throw new Error('must not connect') },
    sleep: async () => { if (calls >= 2) socket.stop() },
    log: (l) => logs.push(l),
  })
  socket.start()
  await flush()
  expect(logs[0]).toBe('socket: open failed (ratelimited)')
  expect(calls).toBe(2)
})

test('a fatal open error (invalid_auth) is logged once and not retried', async () => {
  const logs: string[] = []
  let calls = 0
  const socket = new SlackSocket('xapp-bad', {
    onEvent: () => {},
    fetchImpl: (async () => { calls++; return new Response(JSON.stringify({ ok: false, error: 'invalid_auth' })) }) as unknown as typeof fetch,
    wsFactory: () => { throw new Error('must not connect') },
    sleep: async () => { if (calls >= 2) socket.stop() },
    log: (l) => logs.push(l),
  })
  socket.start()
  await flush()
  expect(logs).toEqual(['socket: open failed (invalid_auth), giving up: polling only'])
  expect(calls).toBe(1)
  expect(socket.isConnected()).toBe(false)
})

test('stop() closes the socket and prevents reconnecting', async () => {
  const s = setup()
  s.socket.start()
  await flush()
  s.last().emit({ type: 'hello' })
  s.socket.stop()
  await flush()
  expect(s.last().closed).toBe(true)
  expect(s.socket.isConnected()).toBe(false)
  expect(s.opens.length).toBe(1)
  expect(s.sleeps).toEqual([])
})

test('malformed frames are ignored', async () => {
  const s = setup()
  s.socket.start()
  await flush()
  s.last().onmessage?.({ data: 'not json' })
  s.last().emit({ type: 'events_api', payload: { event: { type: 'message', channel: 'C1', ts: '1.0', text: 'x' } } }) // no envelope_id
  expect(s.last().sent).toEqual([])
  expect(s.events).toEqual([]) // an envelope that cannot be acked is not processed
  s.socket.stop()
})

test('epoch increments on every hello and tags the events; lastFrameAt tracks any frame', async () => {
  let clock = 1000
  const events: number[] = []
  const sockets: FakeWs[] = []
  const socket = new SlackSocket('xapp', {
    onEvent: (raw) => events.push(raw.epoch),
    fetchImpl: (async () => new Response(JSON.stringify({ ok: true, url: 'wss://x' }))) as unknown as typeof fetch,
    wsFactory: (url) => { const ws = new FakeWs(url, []); sockets.push(ws); return ws },
    sleep: async () => {}, log: () => {}, now: () => clock,
  })
  const msg = (id: string) => ({ envelope_id: id, type: 'events_api', payload: { event: { type: 'message', channel: 'D1', channel_type: 'im', ts: '1.0', text: '' } } })
  socket.start()
  await flush()
  expect(socket.epoch()).toBe(0)
  expect(socket.lastFrameAt()).toBeUndefined()
  sockets.at(-1)!.emit({ type: 'hello' })
  sockets.at(-1)!.emit(msg('a'))
  expect(socket.lastFrameAt()).toBe(1000)
  clock = 5000
  sockets.at(-1)!.emit({ type: 'ping-ish' })
  expect(socket.lastFrameAt()).toBe(5000)
  sockets.at(-1)!.drop(1006)
  await flush()
  expect(socket.lastFrameAt()).toBeUndefined()
  sockets.at(-1)!.emit({ type: 'hello' })
  sockets.at(-1)!.emit(msg('b'))
  expect(socket.epoch()).toBe(2)
  expect(events).toEqual([1, 2])
  socket.stop()
})

test('reconnect() drops the current connection and opens a new one after 1s', async () => {
  const s = setup()
  s.socket.start()
  await flush()
  const first = s.last()
  first.emit({ type: 'hello' })
  s.socket.reconnect('stale')
  await flush()
  expect(first.closed).toBe(true)
  expect(s.opens.length).toBe(2)
  expect(s.sleeps).toEqual([1000])
  expect(s.logs).toContain('socket: reconnect (stale)')
  expect(s.logs.some((l) => l.startsWith('socket: closed'))).toBe(false)
  s.socket.stop()
})

test('repeated disconnect frames: at least 1s between refreshes', async () => {
  const s = setup()
  s.socket.start()
  await flush()
  for (let i = 0; i < 3; i++) { s.last().emit({ type: 'disconnect', reason: 'refresh_requested' }); await flush() }
  expect(s.opens.length).toBe(4)
  expect(s.sleeps).toEqual([1000, 1000, 1000])
  s.socket.stop()
})

test('stop() while apps.connections.open is in flight creates no socket', async () => {
  let release!: (r: Response) => void
  let created = 0
  const socket = new SlackSocket('xapp', {
    onEvent: () => {},
    fetchImpl: (() => new Promise<Response>((r) => { release = r })) as unknown as typeof fetch,
    wsFactory: (url) => { created++; return new FakeWs(url, []) },
    sleep: async () => {}, log: () => {},
  })
  socket.start()
  await flush()
  socket.stop()
  release(new Response(JSON.stringify({ ok: true, url: 'wss://x' })))
  await flush()
  expect(created).toBe(0)
})

test('a throwing onEvent is logged by error name and the socket keeps working', async () => {
  const logs: string[] = []
  let n = 0
  const sockets: FakeWs[] = []
  const socket = new SlackSocket('xapp', {
    onEvent: () => { n++; if (n === 1) throw new RangeError('boom secret') },
    fetchImpl: (async () => new Response(JSON.stringify({ ok: true, url: 'wss://x' }))) as unknown as typeof fetch,
    wsFactory: (url) => { const ws = new FakeWs(url, []); sockets.push(ws); return ws },
    sleep: async () => {}, log: (l) => logs.push(l),
  })
  const msg = (id: string) => ({ envelope_id: id, type: 'events_api', payload: { event: { type: 'message', channel: 'D1', channel_type: 'im', ts: '1.0', text: '' } } })
  socket.start()
  await flush()
  sockets[0]!.emit(msg('a'))
  sockets[0]!.emit(msg('b'))
  expect(n).toBe(2)
  expect(sockets[0]!.sent.length).toBe(2)
  expect(logs).toEqual(['socket: frame failed (RangeError)'])
  socket.stop()
})

test('hidden message events (edits, message_replied) are acked and not delivered', async () => {
  const s = setup()
  s.socket.start()
  await flush()
  s.last().emit({ envelope_id: 'h', type: 'events_api', payload: { event: { type: 'message', subtype: 'message_replied', hidden: true, channel: 'C1', channel_type: 'channel', ts: '1.0', message: { text: 'x' } } } })
  expect(s.last().sent).toEqual(['{"envelope_id":"h"}'])
  expect(s.events).toEqual([])
  s.socket.stop()
})
