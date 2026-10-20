import { test, expect } from 'bun:test'
import { threadJson, threadKey } from '../src/thread-stats'
import { emptyState, type Item, type SlackMsg, type State } from '../src/state'

const DAY_S = 86_400
const T = 1_760_800_000 // seconds

const m = (sec: number, user: string, userName?: string, extra: Partial<SlackMsg> = {}): SlackMsg =>
  ({ channel: 'C1', ts: `${sec}.000100`, threadTs: `${T}.000100`, user, ...(userName ? { userName } : {}), text: 'x', ...extra })

function item(over: Partial<Item> = {}): Item {
  return {
    id: '14', seq: 14, sub: 0, status: 'triage', source: 'channel', channel: 'C1', threadTs: `${T}.000100`,
    author: 'U2', messages: [], context: [], lastSeenTs: '0', createdAt: 5_000, lastMessageAt: 5_000, telegram: {}, ...over,
  }
}

function stateWith(...items: Item[]): State {
  const s = emptyState()
  s.users = { U3: 'Max' }
  for (const i of items) s.items[i.id] = i
  return s
}

test('thread item: message count, participants by count, my messages, span', () => {
  const it = item({
    context: [m(T, 'U3'), m(T + 60, 'ME', 'Ilya'), m(T + 120, 'U2', 'Bob'), m(T + 3_600, 'U3')],
    messages: [m(T + 2 * DAY_S, 'U2', 'Bob'), m(T + 2 * DAY_S + 30, 'U2', 'Bob')],
  })
  const t = threadJson(it, stateWith(it), 'ME')!
  expect(t.messages).toBe(6)
  expect(t.participants).toEqual([
    { id: 'U2', name: 'Bob', count: 3 }, { id: 'U3', name: 'Max', count: 2 }, { id: 'ME', name: 'Ilya', count: 1 },
  ])
  expect(t.my_messages).toBe(1)
  expect(t.my_last_at).toBe(new Date((T + 60) * 1000).toISOString())
  expect(t.first_at).toBe(new Date(T * 1000).toISOString())
  expect(t.last_at).toBe(new Date((T + 2 * DAY_S + 30) * 1000).toISOString())
  expect(t.days_span).toBe(2)
  expect(t.prior_items).toEqual([])
})

test('a message present in both context and messages is counted once; no own message: no my_last_at', () => {
  const dup = m(T + 10, 'U2')
  const it = item({ context: [m(T, 'U3'), dup], messages: [dup] })
  const t = threadJson(it, stateWith(it), 'ME')!
  expect(t.messages).toBe(2)
  expect(t.my_messages).toBe(0)
  expect('my_last_at' in t).toBe(false)
  expect(t.participants.find((p) => p.id === 'U2')).toEqual({ id: 'U2', name: 'U2', count: 1 })
})

test('short top-level DM: no thread block', () => {
  const dm = item({ source: 'im', channel: 'D1', threadTs: undefined, messages: [m(T, 'U2', 'Bob', { channel: 'D1', threadTs: undefined })] })
  expect(threadJson(dm, stateWith(dm), 'ME')).toBeUndefined()
})

test('top-level DM with a long context gets the thread block', () => {
  const ctx = Array.from({ length: 6 }, (_, i) => m(T + i, i % 2 ? 'ME' : 'U2', undefined, { channel: 'D1', threadTs: undefined }))
  const dm = item({ source: 'im', channel: 'D1', threadTs: undefined, context: ctx, messages: [m(T + 10, 'U2', undefined, { channel: 'D1', threadTs: undefined })] })
  const t = threadJson(dm, stateWith(dm), 'ME')!
  expect(t.messages).toBe(7)
  expect(t.my_messages).toBe(3)
})

test('prior_items: earlier items of the follow-up chain (seq) and of the same conversation, oldest first', () => {
  const parent = item({ id: '14', seq: 14, sub: 0, status: 'sent', sentTs: '9.1', sentChoice: 2, createdAt: 1_000 })
  const sibling = item({ id: '14.1', seq: 14, sub: 1, status: 'skipped', createdAt: 2_000 })
  const otherAuthor = item({ id: '16', seq: 16, status: 'sent', sentChoice: 'custom', sentTs: '9.2', createdAt: 3_000 })
  const elsewhere = item({ id: '17', seq: 17, channel: 'C9', createdAt: 3_500 })
  const later = item({ id: '14.3', seq: 14, sub: 3, createdAt: 9_000 })
  const current = item({ id: '14.2', seq: 14, sub: 2, source: 'followup', createdAt: 5_000, messages: [m(T + 5, 'U4')] })
  const t = threadJson(current, stateWith(parent, sibling, otherAuthor, elsewhere, later, current), 'ME')!
  expect(t.prior_items).toEqual([
    { id: '14', status: 'sent', sentTs: '9.1', chosen: 2 },
    { id: '14.1', status: 'skipped' },
    { id: '16', status: 'sent', sentTs: '9.2', chosen: 'custom' },
  ])
})

test('threadKey: a top-level channel item is keyed by the thread under its first message; a DM by the channel', () => {
  expect(threadKey(item())).toBe(`C1:${T}.000100`)
  expect(threadKey(item({ threadTs: undefined, messages: [m(T + 7, 'U2', undefined, { threadTs: undefined })] }))).toBe(`C1:${T + 7}.000100`)
  expect(threadKey(item({ source: 'im', channel: 'D1', threadTs: undefined }))).toBe('D1:')
})
