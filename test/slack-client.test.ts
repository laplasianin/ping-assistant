import { test, expect } from 'bun:test'
import { BudgetExceeded, SlackClient } from '../src/slack/client'

type Call = { url: URL; init?: RequestInit }

function fake(responses: (() => Response)[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init })
    const next = responses.shift()
    if (!next) throw new Error('unexpected extra fetch')
    return next()
  }) as typeof fetch
  return { fetchImpl, calls }
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers })

test('history paginates on response_metadata.next_cursor', async () => {
  const { fetchImpl, calls } = fake([
    json({ ok: true, messages: [{ ts: '3', text: 'c' }, { ts: '2', text: 'b' }], response_metadata: { next_cursor: 'abc' } }),
    json({ ok: true, messages: [{ ts: '1', text: 'a' }], response_metadata: { next_cursor: '' } }),
  ])
  const c = new SlackClient('xoxp-test', fetchImpl)
  const msgs = await c.history('C1', '0.5')
  expect(msgs.map((m) => m.ts)).toEqual(['1', '2', '3'])
  expect(calls).toHaveLength(2)
  expect(calls[0]!.url.pathname).toBe('/api/conversations.history')
  expect(calls[0]!.url.searchParams.get('limit')).toBe('200')
  expect(calls[0]!.url.searchParams.get('oldest')).toBe('0.5')
  expect(calls[0]!.url.searchParams.get('inclusive')).toBe('false')
  expect(calls[0]!.url.searchParams.get('cursor')).toBeNull()
  expect(calls[1]!.url.searchParams.get('cursor')).toBe('abc')
  expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer xoxp-test')
})

test('throws on ok:false with method and error', async () => {
  const { fetchImpl } = fake([json({ ok: false, error: 'channel_not_found' })])
  const c = new SlackClient('t', fetchImpl)
  await expect(c.history('C1')).rejects.toThrow('slack conversations.history: channel_not_found')
})

test('retries once after 429 honoring Retry-After', async () => {
  const { fetchImpl, calls } = fake([
    json({}, 429, { 'Retry-After': '3' }),
    json({ ok: true, user: { real_name: 'Ann', name: 'ann' } }),
  ])
  const waits: number[] = []
  const c = new SlackClient('t', fetchImpl, async (ms) => { waits.push(ms) })
  expect(await c.userName('U1')).toBe('Ann')
  expect(waits).toEqual([3000])
  expect(calls).toHaveLength(2)
})

test('second 429 throws', async () => {
  const { fetchImpl } = fake([json({}, 429), json({}, 429, { 'Retry-After': '1' })])
  const c = new SlackClient('t', fetchImpl, async () => {})
  await expect(c.userName('U1')).rejects.toThrow('slack users.info: HTTP 429')
})

test('postMessage sends thread_ts when given', async () => {
  const { fetchImpl, calls } = fake([json({ ok: true, ts: '9.1' }), json({ ok: true, ts: '9.2' })])
  const c = new SlackClient('t', fetchImpl)
  expect(await c.postMessage('C1', 'hi', '1.0')).toEqual({ ts: '9.1' })
  expect(calls[0]!.init!.method).toBe('POST')
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ channel: 'C1', text: 'hi', thread_ts: '1.0' })
  await c.postMessage('C1', 'yo')
  expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ channel: 'C1', text: 'yo' })
})

test('replies drops the root when oldestTs is given', async () => {
  const { fetchImpl } = fake([
    json({ ok: true, messages: [{ ts: '1.0', thread_ts: '1.0', text: 'root' }, { ts: '1.1', thread_ts: '1.0', text: 'r' }] }),
  ])
  const c = new SlackClient('t', fetchImpl)
  expect((await c.replies('C1', '1.0', '1.0')).map((m) => m.ts)).toEqual(['1.1'])
})

test('searchMentions pages, sets channel and excludes own messages', async () => {
  const { fetchImpl, calls } = fake([
    json({ ok: true, messages: { matches: [{ ts: '1', user: 'U2', text: 'a', channel: { id: 'C1' } }, { ts: '2', user: 'U1', text: 'own', channel: { id: 'C1' } }], paging: { page: 1, pages: 2 } } }),
    json({ ok: true, messages: { matches: [{ ts: '3', user: 'U3', text: 'b', channel: { id: 'D1' } }], paging: { page: 2, pages: 2 } } }),
  ])
  const c = new SlackClient('t', fetchImpl)
  const out = await c.searchMentions('U1', '2026-10-01')
  expect(out.map((m) => [m.ts, m.channel])).toEqual([['1', 'C1'], ['3', 'D1']])
  expect(calls[0]!.url.searchParams.get('query')).toBe('<@U1> after:2026-10-01')
  expect(calls[1]!.url.searchParams.get('page')).toBe('2')
})

test('listDms maps is_im to im and the rest to mpim', async () => {
  const { fetchImpl } = fake([json({ ok: true, channels: [{ id: 'D1', is_im: true }, { id: 'G1', is_mpim: true }] })])
  expect(await new SlackClient('t', fetchImpl).listDms()).toEqual([{ id: 'D1', type: 'im' }, { id: 'G1', type: 'mpim' }])
})

test('channelName returns личка for IM, name otherwise', async () => {
  const { fetchImpl } = fake([json({ ok: true, channel: { is_im: true } }), json({ ok: true, channel: { name: 'dev' } })])
  const c = new SlackClient('t', fetchImpl)
  expect(await c.channelName('D1')).toBe('личка')
  expect(await c.channelName('C1')).toBe('dev')
})

test('searchMentions parses thread_ts from the match permalink', async () => {
  const { fetchImpl } = fake([
    json({ ok: true, messages: { matches: [{ ts: '2', user: 'U2', text: 'x', channel: { id: 'C1' }, permalink: 'https://x.slack.com/archives/C1/p2?thread_ts=1.5&cid=C1' }, { ts: '3', user: 'U2', text: 'y', channel: { id: 'C1' }, permalink: 'https://x.slack.com/archives/C1/p3' }], paging: { page: 1, pages: 1 } } }),
  ])
  const out = await new SlackClient('t', fetchImpl).searchMentions('U1', '2026-10-01')
  expect(out.map((m) => m.thread_ts)).toEqual(['1.5', undefined])
})

test('recent fetches one page of history before a ts, oldest first', async () => {
  const { fetchImpl, calls } = fake([
    json({ ok: true, messages: [{ ts: '9', text: 'c' }, { ts: '8', text: 'b' }], response_metadata: { next_cursor: 'more' } }),
  ])
  const msgs = await new SlackClient('t', fetchImpl).recent('D1', '10.000000', 2)
  expect(msgs.map((m) => m.ts)).toEqual(['8', '9'])
  expect(calls).toHaveLength(1)
  expect(calls[0]!.url.pathname).toBe('/api/conversations.history')
  expect(calls[0]!.url.searchParams.get('latest')).toBe('10.000000')
  expect(calls[0]!.url.searchParams.get('inclusive')).toBe('false')
  expect(calls[0]!.url.searchParams.get('limit')).toBe('2')
})

test('request budget counts polling reads only and resets per tick', async () => {
  const ok = json({ ok: true, messages: [], channel: { name: 'x' }, permalink: 'p', ts: '1.0' })
  const { fetchImpl, calls } = fake([ok, ok, ok, ok, ok, ok])
  const c = new SlackClient('t', fetchImpl)
  c.resetBudget(2)
  await c.history('C1')
  await c.replies('C1', '1.0')
  await expect(c.history('C1')).rejects.toBeInstanceOf(BudgetExceeded)
  expect(calls).toHaveLength(2) // the refused call never reached Slack
  await c.channelName('C1') // metadata and sending are not budgeted
  await c.permalink('C1', '1.0')
  await c.postMessage('C1', 'hi')
  expect(calls).toHaveLength(5)
  c.resetBudget(2)
  await c.history('C1')
  expect(calls).toHaveLength(6)
})
