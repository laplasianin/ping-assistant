import { test, expect, afterEach, beforeEach, spyOn } from 'bun:test'
import { applyCursors, Collector } from '../src/slack/collector'
import { BudgetExceeded, type RawMsg, type SlackClient } from '../src/slack/client'
import { emptyState } from '../src/state'
import type { Config } from '../src/config'

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)
const NOW_TS = `${NOW / 1000}.000000`

class FakeSlack {
  dms: { id: string; type: 'im' | 'mpim'; user?: string }[] = []
  hist: Record<string, RawMsg[]> = {}
  repl: Record<string, RawMsg[]> = {}
  mentions: RawMsg[] = []
  failHistory = new Set<string>()
  calls: string[] = []
  searchArgs: string[] = []
  budget = Infinity
  used = 0
  private spend() { if (++this.used > this.budget) throw new BudgetExceeded(this.budget) }
  async listDms() { this.spend(); return this.dms }
  resetBudget() { this.used = 0 }
  async history(channel: string, oldest?: string) {
    this.spend()
    this.calls.push(`history ${channel} ${oldest}`)
    if (this.failHistory.has(channel)) throw new Error('boom')
    return this.hist[channel] ?? []
  }
  async replies(channel: string, threadTs: string, oldest?: string) {
    this.spend()
    this.calls.push(`replies ${channel}:${threadTs} ${oldest}`)
    return this.repl[`${channel}:${threadTs}`] ?? []
  }
  async searchMentions(_user: string, after: string) { this.searchArgs.push(after); return this.mentions }
  async channelName(id: string) { return `name-${id}` }
  async userName(id: string) { return `User ${id}` }
  async permalink(c: string, ts: string) { return `https://slack/${c}/${ts}` }
  async downloadFile() {}
}

const cfg = { userId: 'ME', watchChannels: ['C1'], followUpDays: 7 } as Config
let slack: FakeSlack
let state: ReturnType<typeof emptyState>
let stderr: ReturnType<typeof spyOn>
const collector = () => new Collector(slack as unknown as SlackClient, cfg, state, '/tmp/ping-assistant-files-test')
/** Ticks and commits the cursors the way the orchestrator does after a successful ingest. */
const make = () => {
  const c = collector()
  return { tick: async (now: number) => { const r = await c.tick(now); applyCursors(state, r); return r.collected } }
}

beforeEach(() => {
  slack = new FakeSlack()
  state = emptyState()
  stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => stderr.mockRestore())

test('first tick sets cursors to now and returns nothing', async () => {
  slack.dms = [{ id: 'D1', type: 'im' }]
  slack.hist = { D1: [{ ts: '1.0', user: 'U2', text: 'old' }], C1: [{ ts: '1.0', user: 'U2', text: 'old' }] }
  const out = await make().tick(NOW)
  expect(out).toEqual([])
  expect(state.cursors['hist:D1']).toBe(NOW_TS)
  expect(state.cursors['hist:C1']).toBe(NOW_TS)
  expect(state.cursors.search).toBe(NOW_TS)
  expect(state.cursors.lastTick).toBe(NOW_TS)
  expect(slack.calls).toEqual([])
})

test('dm message is returned with source im and cursor advanced', async () => {
  slack.dms = [{ id: 'D1', type: 'im' }]
  state.cursors = { 'hist:D1': '100.000000', 'hist:C1': '100.000000', search: '1.0' }
  slack.hist = { D1: [{ ts: '101.5', user: 'U2', text: 'hi' }, { ts: '102.5', user: 'ME', text: 'mine' }] }
  const out = await make().tick(NOW)
  expect(out.map((o) => [o.msg.ts, o.source, o.msg.user])).toEqual([['101.5', 'im', 'U2'], ['102.5', 'im', 'ME']])
  expect(out[0]!.msg).toMatchObject({ channel: 'D1', userName: 'User U2', permalink: 'https://slack/D1/101.5', text: 'hi' })
  expect(state.cursors['hist:D1']).toBe('102.5')
  expect(state.channels.D1).toBe('name-D1')
})

test('mention found by search is deduped against msgIndex and other sources', async () => {
  slack.dms = [{ id: 'D1', type: 'im' }]
  state.cursors = { 'hist:D1': '100.000000', 'hist:C1': '100.000000', search: '1.0' }
  state.msgIndex['C9:1792410000.1'] = 'i1'
  slack.hist = { D1: [{ ts: '1792410100.2', user: 'U2', text: 'dm mention' }] }
  slack.mentions = [
    { ts: '0.5', channel: 'C9', user: 'U2', text: 'older than floor' },
    { ts: '1792410000.1', channel: 'C9', user: 'U2', text: 'known' },
    { ts: '1792410100.2', channel: 'D1', user: 'U2', text: 'dm mention' },
    { ts: '1792410200.3', channel: 'C9', user: 'U3', text: 'new' },
  ]
  const out = await make().tick(NOW)
  expect(out.map((o) => [o.msg.ts, o.source])).toEqual([['1792410100.2', 'im'], ['1792410200.3', 'mention']])
  expect(slack.searchArgs).toEqual(['1969-12-30'])
  expect(state.cursors.search).toBe('1792409600.300000') // newest hit minus the 600s index lag
})

test('watched channel thread replies are fetched', async () => {
  state.cursors = { 'hist:C1': '100.000000', search: '1.0' }
  slack.hist = { C1: [{ ts: '150.0', thread_ts: '150.0', reply_count: 1, user: 'U2', text: 'root' }] }
  slack.repl = { 'C1:150.0': [{ ts: '150.0', thread_ts: '150.0', user: 'U2', text: 'root' }, { ts: '160.0', thread_ts: '150.0', user: 'U3', text: 'reply' }] }
  state.watchedThreads['C2:5.0'] = { until: NOW + 1 }
  state.cursors['thr:C2:5.0'] = '5.0'
  slack.repl['C2:5.0'] = [{ ts: '6.0', thread_ts: '5.0', user: 'U4', text: 'follow' }]
  const out = await make().tick(NOW)
  expect(out.map((o) => [o.msg.channel, o.msg.ts, o.source, o.msg.threadTs])).toEqual([
    ['C2', '6.0', 'followup', '5.0'],
    ['C1', '150.0', 'channel', '150.0'],
    ['C1', '160.0', 'channel', '150.0'],
  ].sort((a, b) => Number(a[1]) - Number(b[1])))
  expect(state.cursors['thr:C1:150.0']).toBe('160.0')
  expect(state.cursors['thr:C2:5.0']).toBe('6.0')
  expect(state.cursors['hist:C1']).toBe('150.0')
})

test('subtypes message_changed/channel_join/bot_message are skipped; thread_broadcast kept', async () => {
  slack.dms = [{ id: 'D1', type: 'im' }]
  state.cursors = { 'hist:D1': '1.0', 'hist:C1': '1.0', search: '1.0' }
  slack.hist = {
    D1: [
      { ts: '2.0', subtype: 'message_changed', text: '' },
      { ts: '3.0', subtype: 'channel_join', user: 'U2', text: '' },
      { ts: '4.0', subtype: 'bot_message', text: 'b' },
      { ts: '5.0', bot_id: 'B1', user: 'U9', text: 'bot' },
      { ts: '6.0', subtype: 'thread_broadcast', user: 'U2', thread_ts: '1.5', text: 'bc' },
      { ts: '7.0', subtype: 'file_share', user: 'U2', text: 'f' },
    ],
  }
  const out = await make().tick(NOW)
  expect(out.map((o) => o.msg.ts)).toEqual(['6.0', '7.0'])
  expect(state.cursors['hist:D1']).toBe('7.0')
})

test('failing source keeps its cursor and does not block others', async () => {
  slack.dms = [{ id: 'D1', type: 'im' }, { id: 'D2', type: 'im' }]
  state.cursors = { 'hist:D1': '1.0', 'hist:D2': '1.0', 'hist:C1': '1.0', search: '1.0' }
  slack.failHistory.add('D1')
  slack.hist = { D2: [{ ts: '2.0', user: 'U2', text: 'ok' }] }
  const out = await make().tick(NOW)
  expect(out.map((o) => o.msg.channel)).toEqual(['D2'])
  expect(state.cursors['hist:D1']).toBe('1.0')
  expect(state.cursors['hist:D2']).toBe('2.0')
  expect(stderr).toHaveBeenCalledWith('ping-assistant: im D1 failed: boom\n')
})

const T = (n: number) => `${NOW / 1000 - 5000 + n}.000000`
const base = { 'hist:C1': '100.000000', search: '1.0' }

test('reply in a later tick to a root that had none is returned', async () => {
  state.cursors = { 'hist:C1': T(0), search: '1.0' }
  slack.hist = { C1: [{ ts: T(50), user: 'U2', text: 'root' }] }
  const c = make()
  expect((await c.tick(NOW)).map((o) => o.msg.ts)).toEqual([T(50)])
  expect(state.cursors[`thr:C1:${T(50)}`]).toBe(T(50))
  slack.hist = { C1: [{ ts: T(50), user: 'U2', text: 'root', reply_count: 1, latest_reply: T(60) }] } // still in the window, now with a reply
  slack.repl = { [`C1:${T(50)}`]: [{ ts: T(60), thread_ts: T(50), user: 'U3', text: 'reply' }] }
  const out = await c.tick(NOW + 60_000)
  expect(out.map((o) => [o.msg.ts, o.source, o.msg.threadTs])).toEqual([[T(60), 'channel', T(50)]])
  expect(state.cursors[`thr:C1:${T(50)}`]).toBe(T(60))
})

test('followUpDays horizon: old thread cursors are pruned and not fetched', async () => {
  const oldTs = `${NOW / 1000 - 8 * 86400}.000000`
  const freshTs = `${NOW / 1000 - 6 * 86400}.000000`
  state.cursors = { ...base, [`thr:C1:${oldTs}`]: oldTs, [`thr:C1:${freshTs}`]: freshTs }
  slack.hist = { C1: [{ ts: freshTs, user: 'U2', text: 'root', latest_reply: `${NOW / 1000 - 3600}.000000` }] }
  await make().tick(NOW)
  expect(state.cursors[`thr:C1:${oldTs}`]).toBeUndefined()
  expect(state.cursors[`thr:C1:${freshTs}`]).toBe(freshTs)
  expect(slack.calls.filter((c) => c.startsWith('replies'))).toEqual([`replies C1:${freshTs} ${freshTs}`])
})

test('a DM that appears after the first run is read from lastTick', async () => {
  const c = make()
  await c.tick(NOW)
  slack.dms = [{ id: 'D9', type: 'im' }]
  slack.hist = { D9: [{ ts: `${NOW / 1000 + 5}.000100`, user: 'U2', text: 'first!' }] }
  const out = await c.tick(NOW + 60_000)
  expect(out.map((o) => [o.msg.channel, o.source])).toEqual([['D9', 'im']])
  expect(slack.calls).toContain(`history D9 ${NOW_TS}`)
})

test('watched thread without a cursor starts from lastTick', async () => {
  state.cursors = { ...base, lastTick: '100.000000' }
  state.watchedThreads['C2:5.0'] = { until: NOW + 1 }
  slack.repl['C2:5.0'] = [{ ts: '110.0', thread_ts: '5.0', user: 'U4', text: 'late' }]
  const out = await make().tick(NOW)
  expect(out.map((o) => [o.msg.ts, o.source])).toEqual([['110.0', 'followup']])
  expect(slack.calls).toContain('replies C2:5.0 100.000000')
})

test('search floor is a ts: crosses UTC midnight and ignores older hits', async () => {
  const floor = `${Date.UTC(2026, 9, 19, 23, 59, 30) / 1000}.000000`
  const hit = `${Date.UTC(2026, 9, 20, 0, 0, 10) / 1000}.000000`
  state.cursors = { ...base, search: floor }
  slack.mentions = [{ ts: '5.0', channel: 'C9', user: 'U2', text: 'old' }, { ts: hit, channel: 'C9', user: 'U2', text: 'new' }]
  const out = await make().tick(Date.UTC(2026, 9, 20, 0, 1, 0))
  expect(out.map((o) => o.msg.ts)).toEqual([hit])
  expect(slack.searchArgs).toEqual(['2026-10-17'])
  expect(state.cursors.search).toBe(floor) // hit - 600s is below the old floor: the floor never moves back
  state.msgIndex[`C9:${hit}`] = 'i1' // the orchestrator ingested it
  slack.mentions = [{ ts: hit, channel: 'C9', user: 'U2', text: 'new' }]
  expect(await make().tick(Date.UTC(2026, 9, 20, 0, 2, 0))).toEqual([])
})

test('failing file download is soft: file recorded without path, message kept', async () => {
  state.cursors = { ...base }
  slack.hist = { C1: [{ ts: '150.0', user: 'U2', text: 'f', files: [{ id: 'F1', name: 'a.png', url_private_download: 'u' }] }] }
  slack.downloadFile = async () => { throw new Error('nope') }
  const out = await make().tick(NOW)
  expect(out[0]!.msg.files).toEqual([{ id: 'F1', name: 'a.png' }])
  expect(state.cursors['hist:C1']).toBe('150.0')
})

test('downloaded file path is filesDir/channel-ts-name', async () => {
  state.cursors = { ...base }
  slack.hist = { C1: [{ ts: '150.0', user: 'U2', text: 'f', files: [{ id: 'F1', name: 'a.png', url_private_download: 'u' }] }] }
  const dests: string[] = []
  slack.downloadFile = async (_u?: string, dest?: string) => { dests.push(dest!) }
  const out = await make().tick(NOW)
  expect(dests).toEqual(['/tmp/ping-assistant-files-test/C1-150.0-a.png'])
  expect(out[0]!.msg.files).toEqual([{ id: 'F1', name: 'a.png', path: dests[0] }])
})

test('failing thread does not block the rest of the channel source', async () => {
  state.cursors = { 'hist:C1': T(45), search: '1.0', [`thr:C1:${T(40)}`]: T(40), [`thr:C1:${T(41)}`]: T(41) }
  slack.hist = { C1: [
    { ts: T(40), user: 'U2', text: 'a', latest_reply: T(45) },
    { ts: T(41), user: 'U2', text: 'b', latest_reply: T(42) },
    { ts: T(50), user: 'U2', text: 'new' },
  ] }
  slack.repl = { [`C1:${T(41)}`]: [{ ts: T(42), thread_ts: T(41), user: 'U3', text: 'ok' }] }
  const orig = slack.replies.bind(slack)
  slack.replies = async (c: string, t: string, o?: string) => { if (t === T(40)) throw new Error('thread boom'); return orig(c, t, o) }
  const out = await make().tick(NOW)
  expect(out.map((o) => o.msg.ts)).toEqual([T(42), T(50)])
  expect(state.cursors[`thr:C1:${T(40)}`]).toBe(T(40))
  expect(state.cursors[`thr:C1:${T(41)}`]).toBe(T(42))
  expect(state.cursors['hist:C1']).toBe(T(50))
  expect(stderr).toHaveBeenCalledWith(`ping-assistant: thread C1:${T(40)} failed: thread boom\n`)
})

test('watched thread expires after followUpDays: not polled, entry and old cursor removed', async () => {
  state.cursors = { ...base, 'thr:C2:5.0': '5.0' }
  state.watchedThreads['C2:5.0'] = { until: NOW - 1 }
  state.watchedThreads['C2:6.0'] = { until: NOW + 1 }
  slack.repl['C2:5.0'] = [{ ts: '110.0', thread_ts: '5.0', user: 'U4', text: 'too late' }]
  const out = await make().tick(NOW)
  expect(out).toEqual([])
  expect(state.watchedThreads).toEqual({ 'C2:6.0': { until: NOW + 1 } })
  expect(state.cursors['thr:C2:5.0']).toBeUndefined()
  expect(slack.calls.filter((c) => c.startsWith('replies')).some((c) => c.includes('C2:5.0'))).toBe(false)
})

test('expired watched channel thread keeps its cursor until it is older than the horizon', async () => {
  const recent = `${NOW / 1000 - 2 * 86400}.000000`
  state.cursors = { ...base, [`thr:C1:${recent}`]: recent }
  state.watchedThreads[`C1:${recent}`] = { until: NOW - 1 }
  await make().tick(NOW)
  expect(state.watchedThreads).toEqual({})
  expect(state.cursors[`thr:C1:${recent}`]).toBe(recent) // still a normal tracked channel thread
  await make().tick(NOW + 6 * 86400_000)
  expect(state.cursors[`thr:C1:${recent}`]).toBeUndefined()
})

test('tick stages cursor updates instead of writing state.cursors', async () => {
  slack.dms = [{ id: 'D1', type: 'im' }]
  state.cursors = { 'hist:D1': '100.000000', 'hist:C1': '100.000000', search: '1.0', 'thr:C2:5.0': '5.0' }
  state.watchedThreads['C2:5.0'] = { until: NOW - 1 }
  slack.hist = { D1: [{ ts: '101.5', user: 'U2', text: 'hi' }] }
  const before = structuredClone(state.cursors)
  const r = await collector().tick(NOW)
  expect(state.cursors).toEqual(before)
  expect(r.collected.map((o) => o.msg.ts)).toEqual(['101.5'])
  expect(r.cursorUpdates).toMatchObject({ 'hist:D1': '101.5', lastTick: NOW_TS })
  expect(r.removeCursors).toEqual(['thr:C2:5.0'])
})

test('applyCursors never moves a cursor backwards', () => {
  state.cursors = { 'thr:C1:1.0': '9000.000100', gone: '1.0' }
  applyCursors(state, { cursorUpdates: { 'thr:C1:1.0': '50.0', 'hist:D1': '2.0' }, removeCursors: ['gone'] })
  expect(state.cursors).toEqual({ 'thr:C1:1.0': '9000.000100', 'hist:D1': '2.0' })
})

test('watch channel: one windowed history read; replies only for threads whose latest_reply moved', async () => {
  const horizon = `${NOW / 1000 - 7 * 86400}.000000`
  const [a, b, c] = [T(10), T(20), T(30)]
  state.cursors = { 'hist:C1': T(40), search: '1.0', [`thr:C1:${a}`]: T(15), [`thr:C1:${b}`]: T(25), [`thr:C1:${c}`]: c }
  state.watchedThreads[`C1:${b}`] = { until: NOW + 1 } // answered by us: still read once, via the channel
  slack.hist = { C1: [
    { ts: a, user: 'U2', text: 'a', latest_reply: T(15) }, // unchanged since its cursor
    { ts: b, user: 'U2', text: 'b', latest_reply: T(26) }, // moved
    { ts: c, user: 'U2', text: 'c' },                      // no replies at all
  ] }
  slack.repl = { [`C1:${b}`]: [{ ts: T(26), thread_ts: b, user: 'U3', text: 'new reply' }] }
  const out = await make().tick(NOW)
  expect(slack.calls).toEqual([`history C1 ${horizon}`, `replies C1:${b} ${T(25)}`])
  expect(out.map((o) => o.msg.text)).toEqual(['new reply'])
  expect(state.cursors[`thr:C1:${a}`]).toBe(T(15))
  expect(state.cursors[`thr:C1:${b}`]).toBe(T(26))
  expect(state.cursors['hist:C1']).toBe(T(40))
})

test('search floor trails the newest hit by 600s so a late-indexed mention is still collected', async () => {
  const at = (s: number) => `${NOW / 1000 + s}.000000`
  state.cursors = { ...base, search: at(-3600) }
  slack.mentions = [{ ts: at(-60), channel: 'C9', user: 'U2', text: 'indexed fast' }]
  expect((await make().tick(NOW)).map((o) => o.msg.text)).toEqual(['indexed fast'])
  expect(state.cursors.search).toBe(at(-660))
  state.msgIndex[`C9:${at(-60)}`] = '1'

  // Posted before the first hit but indexed only now.
  slack.mentions = [{ ts: at(-300), channel: 'C9', user: 'U3', text: 'indexed late' }, { ts: at(-60), channel: 'C9', user: 'U2', text: 'indexed fast' }]
  expect((await make().tick(NOW + 60_000)).map((o) => o.msg.text)).toEqual(['indexed late'])
  expect(state.cursors.search).toBe(at(-660))
})

const recent = (s: number) => `${NOW / 1000 + s}.000000`

test('quiet DMs are swept every 10th tick; DMs with real recent activity and new ones every tick', async () => {
  slack.dms = [{ id: 'D1', type: 'im' }, { id: 'D2', type: 'im' }, { id: 'D3', type: 'mpim' }]
  state.cursors = {
    'hist:C1': '100.000000', search: '1.0', lastTick: recent(-60),
    'hist:D1': recent(-3600), 'hist:D2': recent(-3600), // D2's cursor is only a first-run stamp
  } // D3 has no cursor: new
  state.dmActivity = { D1: recent(-3600) } // a message was read from D1 an hour ago
  state.tickCount = 1
  await make().tick(NOW)
  const dmReads = () => slack.calls.filter((c) => c.startsWith('history D')).map((c) => c.split(' ')[1])
  expect(dmReads()).toEqual(['D1', 'D3'])
  slack.calls = []
  state.tickCount = 10
  await make().tick(NOW)
  expect(dmReads()).toEqual(['D1', 'D2', 'D3']) // D3 got a cursor on tick 1 but no message: now quiet, swept in id order
  expect(state.tickCount).toBe(11)
})

test('a DM read that returns messages marks it active', async () => {
  slack.dms = [{ id: 'D1', type: 'im' }]
  state.cursors = { 'hist:C1': '100.000000', search: '1.0', 'hist:D1': recent(-3 * 86400) }
  slack.hist = { D1: [{ ts: recent(-30), user: 'U2', text: 'hi' }] }
  await make().tick(NOW) // tick 0 is a sweep
  expect(state.dmActivity).toEqual({ D1: recent(-30) })
})

test('request budget: mentions and channels go first; remaining DMs are deferred with cursors untouched', async () => {
  slack.dms = [{ id: 'D1', type: 'im' }, { id: 'D2', type: 'im' }]
  state.cursors = { 'hist:D1': recent(-100), 'hist:D2': recent(-100), 'hist:C1': '1.0', search: '1.0' }
  state.dmActivity = { D1: recent(-100), D2: recent(-100) }
  state.tickCount = 1
  slack.hist = { C1: [{ ts: recent(-200), user: 'U4', text: 'channel' }], D1: [{ ts: recent(-50), user: 'U2', text: 'ok' }], D2: [{ ts: recent(-40), user: 'U2', text: 'later' }] }
  slack.budget = 3 // C1 + listDms + D1
  const out = await make().tick(NOW)
  expect(out.map((o) => o.msg.text)).toEqual(['channel', 'ok'])
  expect(state.cursors).toMatchObject({ 'hist:D1': recent(-50), 'hist:D2': recent(-100), 'hist:C1': recent(-200) })
  const lines = stderr.mock.calls.map((c: unknown[]) => String(c[0]))
  expect(lines).toEqual(['ping-assistant: slack request budget exhausted, 1 source(s) deferred to the next tick\n'])

  slack.budget = Infinity // next tick: the deferred DM resumes from its cursor
  const next = await make().tick(NOW + 60_000)
  expect(next.filter((o) => o.msg.channel === 'D2').map((o) => o.msg.text)).toEqual(['later'])
})

test('60 quiet DMs against a budget of 40: the sweep resumes round-robin, so DM #55 is read', async () => {
  const id = (n: number) => `D${String(n).padStart(2, '0')}`
  slack.dms = Array.from({ length: 60 }, (_, n) => ({ id: id(n), type: 'im' as const }))
  state.cursors = { 'hist:C1': '1.0', search: '1.0', lastTick: recent(-60) }
  for (let n = 0; n < 60; n++) state.cursors[`hist:${id(n)}`] = recent(-2 * 86400)
  slack.hist = { [id(55)]: [{ ts: recent(-10), user: 'U2', text: 'ау, ты тут?' }] }
  slack.budget = 40
  state.tickCount = 10 // sweep tick
  const c = make()
  const got: string[] = []
  const read = new Set<string>()
  for (let t = 0; t < 3; t++) {
    slack.calls = []
    got.push(...(await c.tick(NOW + t * 60_000)).map((o) => o.msg.text))
    for (const call of slack.calls) if (call.startsWith('history D')) read.add(call.split(' ')[1]!)
  }
  expect(read.size).toBe(60) // every DM read within two ticks of the sweep starting
  expect(got).toContain('ау, ты тут?')
  expect(state.dmSweepAfter).toBeUndefined() // sweep finished
})

test('fresh install: no DM counts as active, so tick 2 still reads mentions and watch channels', async () => {
  slack.dms = Array.from({ length: 60 }, (_, n) => ({ id: `D${n}`, type: 'im' as const }))
  slack.budget = 40
  const c = make()
  await c.tick(NOW) // first run: stamps cursors, costs no DM history request
  expect(slack.calls.filter((x) => x.startsWith('history D'))).toEqual([])
  slack.calls = []
  slack.mentions = [{ ts: recent(30), channel: 'C9', user: 'U2', text: 'mention' }]
  slack.hist = { C1: [{ ts: recent(40), user: 'U3', text: 'pathfinders' }] }
  const out = await c.tick(NOW + 60_000)
  expect(out.map((o) => o.msg.text)).toEqual(['mention', 'pathfinders'])
  expect(slack.calls.filter((x) => x.startsWith('history D'))).toEqual([])
  expect(stderr).not.toHaveBeenCalled()
})

test('a mention found in a DM keeps the DM source', async () => {
  slack.dms = [{ id: 'D1', type: 'im' }]
  state.cursors = { 'hist:C1': '100.000000', search: '1.0', 'hist:D1': recent(-3 * 86400) }
  state.tickCount = 1 // D1 is quiet: not read this tick
  slack.mentions = [{ ts: recent(-5), channel: 'D1', user: 'U2', text: '<@ME> глянь', dm: 'im' }]
  const out = await make().tick(NOW)
  expect(out.map((o) => [o.msg.channel, o.source])).toEqual([['D1', 'im']])
})

test('stores selfDmChannel when the IM counterpart is the configured user', async () => {
  slack.dms = [{ id: 'D1', type: 'im', user: 'U2' }, { id: 'D9', type: 'im', user: 'ME' }, { id: 'G1', type: 'mpim' }]
  await make().tick(NOW)
  expect(state.selfDmChannel).toBe('D9')
})

test('selfDmChannel stays undefined without a self IM', async () => {
  slack.dms = [{ id: 'D1', type: 'im', user: 'U2' }]
  await make().tick(NOW)
  expect(state.selfDmChannel).toBeUndefined()
})

test('pre-existing thread root: new replies are collected from the hist cursor, old ones are not', async () => {
  state.cursors = { 'hist:C1': T(100), search: '1.0' }
  slack.hist = { C1: [{ ts: T(50), user: 'U2', text: 'old root', reply_count: 2, latest_reply: T(120) }] }
  const all = [
    { ts: T(60), thread_ts: T(50), user: 'U3', text: 'old reply' },
    { ts: T(120), thread_ts: T(50), user: 'U3', text: 'new reply' },
  ]
  slack.replies = async (c: string, t: string, o?: string) => {
    slack.calls.push(`replies ${c}:${t} ${o}`)
    return all.filter((m) => !o || m.ts > o) // like conversations.replies, oldest is exclusive
  }
  const out = await make().tick(NOW)
  expect(slack.calls).toContain(`replies C1:${T(50)} ${T(100)}`)
  expect(out.map((o) => o.msg.ts)).toEqual([T(120)])
  expect(state.cursors[`thr:C1:${T(50)}`]).toBe(T(120))
})

test('pre-existing thread root without new replies gets a cursor at the hist cursor and no replies call', async () => {
  state.cursors = { 'hist:C1': T(100), search: '1.0' }
  slack.hist = { C1: [{ ts: T(50), user: 'U2', text: 'old root', reply_count: 1, latest_reply: T(60) }] }
  const out = await make().tick(NOW)
  expect(out).toEqual([])
  expect(state.cursors[`thr:C1:${T(50)}`]).toBe(T(100))
  expect(slack.calls.some((c) => c.startsWith('replies'))).toBe(false)
})
