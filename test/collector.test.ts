import { test, expect, afterEach, beforeEach, spyOn } from 'bun:test'
import { Collector } from '../src/slack/collector'
import type { RawMsg, SlackClient } from '../src/slack/client'
import { emptyState } from '../src/state'
import type { Config } from '../src/config'

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)
const NOW_TS = `${NOW / 1000}.000000`

class FakeSlack {
  dms: { id: string; type: 'im' | 'mpim' }[] = []
  hist: Record<string, RawMsg[]> = {}
  repl: Record<string, RawMsg[]> = {}
  mentions: RawMsg[] = []
  failHistory = new Set<string>()
  calls: string[] = []
  searchArgs: string[] = []
  async listDms() { return this.dms }
  async history(channel: string, oldest?: string) {
    this.calls.push(`history ${channel} ${oldest}`)
    if (this.failHistory.has(channel)) throw new Error('boom')
    return this.hist[channel] ?? []
  }
  async replies(channel: string, threadTs: string, oldest?: string) {
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
const make = () => new Collector(slack as unknown as SlackClient, cfg, state, '/tmp/ping-assistant-files-test')

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
  expect(state.cursors.search).toBe('1792410200.3')
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
  slack.hist = {}
  slack.repl = { [`C1:${T(50)}`]: [{ ts: T(60), thread_ts: T(50), user: 'U3', text: 'reply' }] }
  const out = await c.tick(NOW + 60_000)
  expect(out.map((o) => [o.msg.ts, o.source, o.msg.threadTs])).toEqual([[T(60), 'channel', T(50)]])
  expect(state.cursors[`thr:C1:${T(50)}`]).toBe(T(60))
})

test('followUpDays horizon: old thread cursors are pruned and not fetched', async () => {
  const oldTs = `${NOW / 1000 - 8 * 86400}.000000`
  const freshTs = `${NOW / 1000 - 6 * 86400}.000000`
  state.cursors = { ...base, [`thr:C1:${oldTs}`]: oldTs, [`thr:C1:${freshTs}`]: freshTs }
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
  expect(state.cursors.search).toBe(hit)
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
  state.cursors = { 'hist:C1': T(0), search: '1.0', [`thr:C1:${T(40)}`]: T(40), [`thr:C1:${T(41)}`]: T(41) }
  slack.hist = { C1: [{ ts: T(50), user: 'U2', text: 'new' }] }
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
