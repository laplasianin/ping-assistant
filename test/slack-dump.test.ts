import { test, expect } from 'bun:test'
import type { RawMsg } from '../src/slack/client'
import {
  berlinParts, buildThreads, bucketByMonth, dayStartTs, formatIndex, formatMonth, formatThread, humanize, isKept,
  mentionedUsers, monthStats, monthStartTs, newestDumpedTs, pacedFetch, parseArgs, permalink, safeName, windowStart, withRetry,
} from '../scripts/slack-dump'

const names = (id: string) => ({ U1: 'Andrei Sotnikov', U2: 'Valeria Pokrovskaia' } as Record<string, string>)[id] ?? id
// 2026-10-19 16:50 CEST = 14:50 UTC
const TS = String(Date.UTC(2026, 9, 19, 14, 50) / 1000) + '.000100'
const TS2 = String(Date.UTC(2026, 9, 19, 14, 52) / 1000) + '.000200'

test('humanize: mentions, channels, links, specials, entities', () => {
  expect(humanize('hi <@U1> and <@U2|val>', names)).toBe('hi @Andrei Sotnikov and @Valeria Pokrovskaia')
  expect(humanize('see <#C9|general>', names)).toBe('see #general')
  expect(humanize('doc <https://x.io/a|the doc> and <https://y.io>', names)).toBe('doc the doc (https://x.io/a) and https://y.io')
  expect(humanize('<!here> <!channel> <!subteam^S1|@devs>', names)).toBe('@here @channel @devs')
  expect(humanize('<mailto:a@b.c|a@b.c> 1 &lt; 2 &amp;&amp; 3 &gt; 2', names)).toBe('a@b.c 1 < 2 && 3 > 2')
  expect(humanize('<@U404>', names)).toBe('@U404')
})

test('mentionedUsers collects ids with and without labels', () => {
  expect(mentionedUsers('<@U1> <@W2|x> <#C1>')).toEqual(['U1', 'W2'])
})

test('berlinParts uses Europe/Berlin (CEST and CET)', () => {
  expect(berlinParts(TS)).toEqual({ date: '2026-10-19', time: '16:50', month: '2026-10' })
  expect(berlinParts(String(Date.UTC(2026, 11, 31, 23, 30) / 1000))).toEqual({ date: '2027-01-01', time: '00:30', month: '2027-01' })
})

test('dayStartTs / monthStartTs are Berlin midnights', () => {
  expect(dayStartTs('2026-07-01')).toBe(Date.UTC(2026, 5, 30, 22) / 1000)
  expect(monthStartTs(Number(TS))).toBe(Date.UTC(2026, 8, 30, 22) / 1000)
  expect(monthStartTs(Date.UTC(2026, 11, 15) / 1000)).toBe(Date.UTC(2026, 10, 30, 23) / 1000)
  expect(() => dayStartTs('July')).toThrow()
})

test('permalink for root and reply', () => {
  expect(permalink('C1', '1700000000.000100')).toBe('https://scentbird.slack.com/archives/C1/p1700000000000100')
  expect(permalink('C1', '1700000001.000200', '1700000000.000100')).toBe('https://scentbird.slack.com/archives/C1/p1700000001000200?thread_ts=1700000000.000100&cid=C1')
})

test('isKept skips bots and service subtypes, keeps broadcasts and file shares', () => {
  const m = (o: Partial<RawMsg>): RawMsg => ({ ts: '1', text: '', ...o })
  expect(isKept(m({ user: 'U1' }))).toBe(true)
  expect(isKept(m({ subtype: 'thread_broadcast' }))).toBe(true)
  expect(isKept(m({ subtype: 'file_share' }))).toBe(true)
  for (const st of ['channel_join', 'channel_leave', 'channel_topic', 'bot_message']) expect(isKept(m({ subtype: st }))).toBe(false)
  expect(isKept(m({ bot_id: 'B1' }))).toBe(false)
})

test('formatThread: heading, humanized text, files, permalink, indented replies', () => {
  const md = formatThread('C1', {
    root: { ts: TS, user: 'U1', text: 'ping <@U2>', files: [{ id: 'F1', name: 'a.png' }] },
    replies: [{ ts: TS2, user: 'U2', text: 'line1\nline2', thread_ts: TS }],
  }, names)
  expect(md).toBe([
    '### 2026-10-19 16:50 · Andrei Sotnikov',
    'ping @Valeria Pokrovskaia',
    '[a.png]',
    `https://scentbird.slack.com/archives/C1/p${TS.replace('.', '')}`,
    '',
    '    ↳ 2026-10-19 16:52 · Valeria Pokrovskaia',
    '    line1',
    '    line2',
    `    https://scentbird.slack.com/archives/C1/p${TS2.replace('.', '')}?thread_ts=${TS}&cid=C1`,
  ].join('\n'))
})

test('buildThreads: dedupe, filter, chronological, broadcast placement', () => {
  const root = { ts: '100.000001', user: 'U1', text: 'r', reply_count: 2 }
  const later = { ts: '300.000001', user: 'U1', text: 'later' }
  const bcast = { ts: '150.000001', user: 'U2', text: 'b', thread_ts: '100.000001', subtype: 'thread_broadcast' }
  const orphanBcast = { ts: '200.000001', user: 'U2', text: 'o', thread_ts: '50.000001', subtype: 'thread_broadcast' }
  const join = { ts: '250.000001', user: 'U3', text: 'joined', subtype: 'channel_join' }
  const bot = { ts: '260.000001', bot_id: 'B', text: 'bot' }
  const reps = new Map([['100.000001', [
    { ts: '160.000001', user: 'U1', text: 'r2', thread_ts: '100.000001' },
    bcast, bcast,
    { ts: '170.000001', bot_id: 'B', text: 'bot', thread_ts: '100.000001' },
  ]]])
  const threads = buildThreads([later, join, bot, orphanBcast, bcast, root], reps)
  expect(threads.map((t) => t.root.ts)).toEqual(['100.000001', '200.000001', '300.000001'])
  expect(threads[0]!.replies.map((r) => r.ts)).toEqual(['150.000001', '160.000001'])
})

test('bucketByMonth groups by Berlin month of the root', () => {
  const endJul = String(Date.UTC(2026, 6, 31, 22, 30) / 1000) // 00:30 Aug 1 in Berlin
  const b = bucketByMonth([{ root: { ts: endJul, text: '' }, replies: [] }, { root: { ts: TS, text: '' }, replies: [] }])
  expect([...b.keys()]).toEqual(['2026-08', '2026-10'])
})

test('formatMonth → monthStats round trip and index', () => {
  const md = formatMonth('C1', 'puff-finders', '2026-10', [
    { root: { ts: TS, user: 'U1', text: 'a' }, replies: [{ ts: TS2, user: 'U2', text: 'b' }, { ts: TS2 + '1', user: 'U2', text: 'c' }] },
    { root: { ts: TS2, user: 'U2', text: 'd' }, replies: [] },
  ], names)
  expect(md.startsWith('# #puff-finders — 2026-10\n')).toBe(true)
  const s = monthStats(md)
  expect(s).toEqual({ messages: 2, replies: 2, threads: 1, first: '2026-10-19', last: '2026-10-19' })
  const idx = formatIndex('C1', 'puff-finders', [['2026-10', s], ['2026-09', { messages: 1, replies: 0, threads: 0, first: '2026-09-02', last: '2026-09-02' }]])
  expect(idx).toContain('Период: 2026-09-02 … 2026-10-19')
  expect(idx).toContain('Всего: 3 сообщений, 2 ответов в 1 тредах')
  expect(idx.indexOf('2026-09')).toBeLessThan(idx.indexOf('[2026-10]'))
})

test('newestDumpedTs and windowStart (incremental floors to month start)', () => {
  const md = `x https://scentbird.slack.com/archives/C1/p1700000000000100\n y https://scentbird.slack.com/archives/C1/p1700000500000200?thread_ts=1`
  expect(newestDumpedTs([md, ''])).toBe(1700000500.0002)
  expect(newestDumpedTs([''])).toBeUndefined()
  expect(windowStart('2026-07-15', undefined)).toBe(Date.UTC(2026, 5, 30, 22) / 1000)
  // Oct 1 12:00 Berlin minus a day → September
  expect(windowStart(undefined, Date.UTC(2026, 9, 1, 10) / 1000)).toBe(Date.UTC(2026, 7, 31, 22) / 1000)
  expect(windowStart(undefined, undefined)).toBeUndefined()
})

test('parseArgs', () => {
  expect(parseArgs(['--channel', 'C1', '--channel', 'C2', '--since', '2026-07-01'])).toEqual({ channels: ['C1', 'C2'], since: '2026-07-01', out: 'knowledge/slack' })
  expect(() => parseArgs([])).toThrow()
  expect(() => parseArgs(['--channel'])).toThrow()
  expect(() => parseArgs(['--channel', 'C1', '--since', '07/01'])).toThrow()
  expect(() => parseArgs(['--bogus'])).toThrow()
})

test('safeName keeps channel names directory-safe', () => {
  expect(safeName('puff-finders')).toBe('puff-finders')
  expect(safeName('a/b c')).toBe('a-b-c')
})

test('pacedFetch spaces requests', async () => {
  let clock = 0
  const waits: number[] = []
  const f = pacedFetch((async () => new Response('{}')) as unknown as typeof fetch, 1500, async (ms) => { waits.push(ms); clock += ms }, () => clock)
  await f('a'); await f('b'); await f('c')
  expect(waits).toEqual([1500, 1500])
})

test('withRetry retries rate limits up to 3 times, not other errors', async () => {
  let n = 0
  const waits: number[] = []
  const w = async (ms: number) => { waits.push(ms) }
  const r = await withRetry('x', async () => { if (++n < 3) throw new Error('slack x: HTTP 429'); return 'ok' }, w, [1, 2, 3], () => {})
  expect(r).toBe('ok')
  expect(waits).toEqual([1, 2])
  await expect(withRetry('x', async () => { throw new Error('slack x: HTTP 429') }, w, [1, 2, 3], () => {})).rejects.toThrow('429')
  let m = 0
  await expect(withRetry('x', async () => { m++; throw new Error('slack x: channel_not_found') }, w, [1], () => {})).rejects.toThrow('channel_not_found')
  expect(m).toBe(1)
})
