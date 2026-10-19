import { test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ingest, mature, nextItemId, conversationKey } from '../src/items'
import { emptyState, StateStore, type Item, type SlackMsg } from '../src/state'
import type { Config } from '../src/config'

const cfg: Config = {
  userId: 'UILYA', watchChannels: [], telegramChatId: '1', pollSeconds: 60,
  settleSeconds: 90, maxSettleSeconds: 300, followUpDays: 7, contextMessages: 30, triageTimeoutSeconds: 600,
  scentbirdRepoPath: '/x', dryRun: false, statePath: '/x/state.json',
}
const T0 = 1_760_800_000_000
let n = 0
function msg(over: Partial<SlackMsg> = {}): SlackMsg {
  n += 1
  return { channel: 'D1', ts: `1760800000.${String(n).padStart(6, '0')}`, user: 'UBOB', text: `m${n}`, ...over }
}
function seeded(over: Partial<Item>): Item {
  return {
    id: '14', seq: 14, sub: 0, status: 'sent', source: 'im', channel: 'C1', threadTs: '100.1',
    author: 'UBOB', messages: [], context: [], lastSeenTs: '100.1', createdAt: T0, lastMessageAt: T0,
    telegram: {}, ...over,
  }
}

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

test('conversationKey uses channel and threadTs', () => {
  expect(conversationKey({ channel: 'C1', ts: '1.1', user: 'U', text: '' })).toBe('C1:')
  expect(conversationKey({ channel: 'C1', ts: '1.2', threadTs: '1.1', user: 'U', text: '' })).toBe('C1:1.1')
})

test('nextItemId consumes nextSeq', () => {
  const s = emptyState()
  expect(nextItemId(s)).toBe('1')
  expect(nextItemId(s)).toBe('2')
  expect(s.nextSeq).toBe(3)
})

test('six messages from one author within settle window become one item', () => {
  const s = emptyState()
  const events = Array.from({ length: 6 }, (_, i) => ingest(s, msg(), 'im', T0 + i * 10_000, cfg))
  expect(events[0]!.kind).toBe('buffered')
  const ids = new Set(events.map((e) => (e as { itemId: string }).itemId))
  expect(ids.size).toBe(1)
  const items = Object.values(s.items)
  expect(items).toHaveLength(1)
  expect(items[0]!.messages).toHaveLength(6)
  expect(items[0]!.status).toBe('settling')
  expect(items[0]!.lastMessageAt).toBe(T0 + 50_000)
  expect(items[0]!.createdAt).toBe(T0)
  expect(items[0]!.lastSeenTs).toBe(items[0]!.messages[5]!.ts)
  expect(Object.keys(s.msgIndex)).toHaveLength(6)
})

test('message after settleSeconds silence matures the item', () => {
  const s = emptyState()
  ingest(s, msg(), 'im', T0, cfg)
  expect(mature(s, T0 + 89_000, cfg)).toHaveLength(0)
  const m = mature(s, T0 + 90_000, cfg)
  expect(m).toHaveLength(1)
  expect(m[0]!.status).toBe('triage')
  expect(m[0]!.triageAt).toBe(T0 + 90_000)
  expect(mature(s, T0 + 200_000, cfg)).toHaveLength(0)
})

test('buffer older than maxSettleSeconds matures even if author keeps typing', () => {
  const s = emptyState()
  for (let t = 0; t <= 300_000; t += 60_000) ingest(s, msg(), 'im', T0 + t, cfg)
  const m = mature(s, T0 + 300_000, cfg)
  expect(m).toHaveLength(1)
  expect(m[0]!.status).toBe('triage')
})

test('mature returns items ordered by createdAt', () => {
  const s = emptyState()
  ingest(s, msg({ channel: 'D2' }), 'im', T0 + 5_000, cfg)
  ingest(s, msg({ channel: 'D1' }), 'im', T0, cfg)
  expect(mature(s, T0 + 500_000, cfg).map((i) => i.channel)).toEqual(['D1', 'D2'])
})

test('duplicate channel:ts is dropped', () => {
  const s = emptyState()
  const m = msg()
  ingest(s, m, 'im', T0, cfg)
  expect(ingest(s, m, 'im', T0 + 1, cfg)).toEqual({ kind: 'dropped', reason: 'duplicate' })
  expect(Object.values(s.items)[0]!.messages).toHaveLength(1)
})

test('own message closes settling and awaiting items in the conversation as answered_manually', () => {
  const s = emptyState()
  ingest(s, msg(), 'im', T0, cfg)
  ingest(s, msg({ user: 'UCAROL' }), 'im', T0, cfg)
  const awaiting = Object.values(s.items).find((i) => i.author === 'UCAROL')!
  awaiting.status = 'awaiting'
  const own = msg({ user: 'UILYA' })
  const ev = ingest(s, own, 'im', T0 + 1000, cfg)
  expect(ev.kind).toBe('answered_manually')
  expect((ev as { itemIds: string[] }).itemIds.sort()).toEqual(Object.keys(s.items).sort())
  expect(Object.values(s.items).every((i) => i.status === 'answered_manually')).toBe(true)
  expect(s.msgIndex[`${own.channel}:${own.ts}`]).toBeUndefined()
})

test('own message with nothing to close is dropped as own', () => {
  const s = emptyState()
  expect(ingest(s, msg({ user: 'UILYA' }), 'im', T0, cfg)).toEqual({ kind: 'dropped', reason: 'own' })
})

test('message from same author while awaiting is appended, not a new item', () => {
  const s = emptyState()
  ingest(s, msg(), 'im', T0, cfg)
  const item = Object.values(s.items)[0]!
  item.status = 'awaiting'
  const ev = ingest(s, msg(), 'im', T0 + 1000, cfg)
  expect(ev).toEqual({ kind: 'appended', itemId: item.id })
  expect(Object.values(s.items)).toHaveLength(1)
  expect(item.messages).toHaveLength(2)
  expect(item.status).toBe('awaiting')
})

test('different authors in one thread produce separate items', () => {
  const s = emptyState()
  ingest(s, msg({ channel: 'C1', threadTs: '1.0', user: 'UBOB' }), 'channel', T0, cfg)
  ingest(s, msg({ channel: 'C1', threadTs: '1.0', user: 'UCAROL' }), 'channel', T0, cfg)
  expect(Object.values(s.items)).toHaveLength(2)
})

test('reply in watched thread creates followup item 14.2 with parent seq', () => {
  const s = emptyState()
  s.nextSeq = 20
  s.items['14'] = seeded({ id: '14', sub: 0 })
  s.items['14.1'] = seeded({ id: '14.1', sub: 1, createdAt: T0 + 1 })
  s.watchedThreads['C1:100.1'] = { until: T0 + 1e9 }
  const ev = ingest(s, msg({ channel: 'C1', threadTs: '100.1', user: 'UBOB' }), 'followup', T0 + 5000, cfg)
  expect(ev).toEqual({ kind: 'followup', itemId: '14.2' })
  const f = s.items['14.2']!
  expect(f.seq).toBe(14)
  expect(f.sub).toBe(2)
  expect(f.status).toBe('settling')
  expect(f.source).toBe('followup')
  expect(s.nextSeq).toBe(20)
  // next message from same author buffers into the followup
  expect(ingest(s, msg({ channel: 'C1', threadTs: '100.1', user: 'UBOB' }), 'followup', T0 + 6000, cfg))
    .toEqual({ kind: 'buffered', itemId: '14.2' })
})

test('watched thread reply with no sent parent falls back to any item, else new item', () => {
  const s = emptyState()
  s.items['5'] = seeded({ id: '5', seq: 5, status: 'ignored' })
  s.watchedThreads['C1:100.1'] = { until: T0 + 1e9 }
  expect(ingest(s, msg({ channel: 'C1', threadTs: '100.1' }), 'followup', T0, cfg)).toEqual({ kind: 'followup', itemId: '5.1' })
  const s2 = emptyState()
  s2.watchedThreads['C1:100.1'] = { until: T0 + 1e9 }
  expect(ingest(s2, msg({ channel: 'C1', threadTs: '100.1' }), 'followup', T0, cfg)).toEqual({ kind: 'buffered', itemId: '1' })
})

test('bot message is dropped', () => {
  const s = emptyState()
  expect(ingest(s, msg({ user: '' }), 'im', T0, cfg)).toEqual({ kind: 'dropped', reason: 'bot' })
  expect(Object.keys(s.items)).toHaveLength(0)
})

test('mature works on state loaded from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ping-assistant-items-'))
  dirs.push(dir)
  const store = new StateStore(join(dir, 'state.json'))
  const s = emptyState()
  ingest(s, msg(), 'im', T0, cfg)
  store.save(s)
  const loaded = store.load()
  const m = mature(loaded, T0 + 100_000, cfg)
  expect(m).toHaveLength(1)
  expect(m[0]!.status).toBe('triage')
})

test('own thread reply closes thread-matched items only, including a top-level item whose thread it is', () => {
  const s = emptyState()
  ingest(s, msg({ channel: 'C1', ts: '10.000000', user: 'UBOB' }), 'channel', T0, cfg) // top-level question
  ingest(s, msg({ channel: 'C1', ts: '11.000000', user: 'UCAROL' }), 'channel', T0, cfg) // another top-level
  ingest(s, msg({ channel: 'C1', ts: '12.000000', threadTs: '5.000000', user: 'UDAN' }), 'channel', T0, cfg) // other thread
  expect(ingest(s, msg({ channel: 'C1', ts: '13.000000', user: 'UILYA' }), 'channel', T0, cfg)).toEqual({ kind: 'dropped', reason: 'own' })
  const ev = ingest(s, msg({ channel: 'C1', ts: '14.000000', threadTs: '10.000000', user: 'UILYA' }), 'channel', T0, cfg)
  expect(ev).toEqual({ kind: 'answered_manually', itemIds: ['1'] })
  expect(Object.values(s.items).map((i) => i.status)).toEqual(['answered_manually', 'settling', 'settling'])
})

test('own top-level IM message closes every open item of that IM; MPIM top-level closes nothing', () => {
  const s = emptyState()
  ingest(s, msg({ channel: 'D1', user: 'UBOB' }), 'im', T0, cfg)
  ingest(s, msg({ channel: 'D1', threadTs: '1.0', user: 'UBOB' }), 'im', T0, cfg)
  ingest(s, msg({ channel: 'G1', user: 'UBOB' }), 'mpim', T0, cfg)
  expect(ingest(s, msg({ channel: 'G1', user: 'UILYA' }), 'mpim', T0, cfg)).toEqual({ kind: 'dropped', reason: 'own' })
  expect(ingest(s, msg({ channel: 'D1', user: 'UILYA' }), 'im', T0, cfg)).toEqual({ kind: 'answered_manually', itemIds: ['1', '2'] })
})

test('same-author message while the item is in triage is appended', () => {
  const s = emptyState()
  ingest(s, msg(), 'im', T0, cfg)
  const item = Object.values(s.items)[0]!
  item.status = 'triage'
  expect(ingest(s, msg(), 'im', T0 + 1000, cfg)).toEqual({ kind: 'appended', itemId: item.id })
  expect(Object.values(s.items)).toHaveLength(1)
  expect(item.status).toBe('triage')
})

const selfCfg: Config = { ...cfg, dryRun: true, selfDmTest: true }
const selfDm = (over: Partial<SlackMsg> = {}) => msg({ channel: 'DSELF', user: 'UILYA', ...over })

test('selfDmTest: own messages in the self-DM become one item', () => {
  const s = emptyState()
  s.selfDmChannel = 'DSELF'
  const events = [0, 1].map((i) => ingest(s, selfDm(), 'im', T0 + i * 1000, selfCfg))
  expect(events[0]!.kind).toBe('buffered')
  expect(events[1]!.kind).toBe('buffered')
  const items = Object.values(s.items)
  expect(items).toHaveLength(1)
  expect(items[0]!.messages).toHaveLength(2)
  expect(items[0]!.author).toBe('UILYA')
})

test('selfDmTest off: own messages in the self-DM are dropped as own', () => {
  const s = emptyState()
  s.selfDmChannel = 'DSELF'
  expect(ingest(s, selfDm(), 'im', T0, { ...cfg, dryRun: true })).toEqual({ kind: 'dropped', reason: 'own' })
  expect(Object.values(s.items)).toHaveLength(0)
})

test('selfDmTest on without dryRun is ignored defensively', () => {
  const s = emptyState()
  s.selfDmChannel = 'DSELF'
  expect(ingest(s, selfDm(), 'im', T0, { ...cfg, selfDmTest: true })).toEqual({ kind: 'dropped', reason: 'own' })
})

test('selfDmTest: an own message in another DM still closes items', () => {
  const s = emptyState()
  s.selfDmChannel = 'DSELF'
  ingest(s, msg({ channel: 'D1', user: 'UBOB' }), 'im', T0, selfCfg)
  const ev = ingest(s, msg({ channel: 'D1', user: 'UILYA' }), 'im', T0 + 1000, selfCfg)
  expect(ev.kind).toBe('answered_manually')
  expect(Object.values(s.items)[0]!.status).toBe('answered_manually')
})
