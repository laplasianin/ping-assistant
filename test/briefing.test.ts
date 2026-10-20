import { test, expect } from 'bun:test'
import { briefingPayload, lastBriefingMoment } from '../src/briefing'
import type { Config } from '../src/config'
import { emptyState, type Item, type State } from '../src/state'

const cfg: Config = {
  userId: 'ME', watchChannels: [], telegramChatId: '1', pollSeconds: 60, settleSeconds: 90, maxSettleSeconds: 300,
  followUpDays: 7, contextMessages: 30, triageTimeoutSeconds: 600, scentbirdRepoPath: '/x', dryRun: false,
  statePath: '/x/state.json', drainSeconds: 5, socketReconcileTicks: 10, feedbackReviewCron: { weekday: 1, hour: 9, minute: 30 },
  briefing: { hour: 9, minute: 30, weekdays: [1, 2, 3, 4, 5] }, github: { defaultRepo: 'o/r' }, jira: { site: 'x.atlassian.net' },
}
/** Local-time epoch ms: the schedule uses the system time zone. */
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime()
const MIN = 60_000
const HOUR = 60 * MIN
// Tuesday 2026-10-20, 09:30 local.
const NOW = local(2026, 9, 20, 9, 30)

let seq = 0
function item(over: Partial<Item>): Item {
  seq++
  return {
    id: String(seq), seq, sub: 0, status: 'awaiting', source: 'im', channel: 'D1', author: 'U2',
    messages: [{ channel: 'D1', ts: '1.0', user: 'U2', text: `msg ${seq}` }], context: [], lastSeenTs: '1.0',
    createdAt: NOW - HOUR, lastMessageAt: NOW - HOUR, telegram: {}, ...over,
  }
}
function stateWith(...items: Item[]): State {
  const s = emptyState()
  s.users = { U2: 'Anna', U3: 'Boris' }
  s.channels = { C1: 'pathfinders' }
  for (const i of items) s.items[i.id] = i
  return s
}

test('lastBriefingMoment: the latest configured weekday moment at or before now', () => {
  const cron = cfg.briefing
  expect(lastBriefingMoment(NOW, cron)).toBe(NOW) // exactly at the moment
  expect(lastBriefingMoment(NOW - 1, cron)).toBe(local(2026, 9, 19, 9, 30)) // Monday's
  // Sunday evening and Saturday: Friday's moment.
  expect(lastBriefingMoment(local(2026, 9, 18, 20, 0), cron)).toBe(local(2026, 9, 16, 9, 30))
  expect(lastBriefingMoment(local(2026, 9, 17, 12, 0), cron)).toBe(local(2026, 9, 16, 9, 30))
  // Monday before 09:30: still Friday's.
  expect(lastBriefingMoment(local(2026, 9, 19, 9, 0), cron)).toBe(local(2026, 9, 16, 9, 30))
  expect(lastBriefingMoment(local(2026, 9, 18, 12, 0), { hour: 8, minute: 0, weekdays: [0] })).toBe(local(2026, 9, 18, 8, 0))
  expect(lastBriefingMoment(local(2026, 9, 18, 7, 0), { hour: 8, minute: 0, weekdays: [0] })).toBe(local(2026, 9, 11, 8, 0))
})

test('since is the later of the previous briefing and 24 h ago', () => {
  const s = stateWith()
  expect(briefingPayload(s, cfg, NOW, undefined).since).toBe(new Date(NOW - 24 * HOUR).toISOString())
  expect(briefingPayload(s, cfg, NOW, NOW - 3 * 24 * HOUR).since).toBe(new Date(NOW - 24 * HOUR).toISOString())
  expect(briefingPayload(s, cfg, NOW, NOW - 2 * HOUR).since).toBe(new Date(NOW - 2 * HOUR).toISOString())
  expect(briefingPayload(s, cfg, NOW, undefined).today).toBe('2026-10-20')
})

test('payload sorts items into ignored, awaiting, stuck, answered and manual by status and time', () => {
  const s = stateWith(
    item({ status: 'ignored', ignoreReason: 'FYI', channel: 'C1', author: 'U3', closedAt: NOW - 2 * HOUR }),
    item({ status: 'ignored', ignoreReason: 'old', closedAt: NOW - 25 * HOUR }), // before since
    item({ status: 'ignored', ignoreReason: 'legacy', createdAt: NOW - 3 * HOUR, triageAt: NOW - 3 * HOUR + MIN }), // no closedAt
    item({ status: 'awaiting', createdAt: NOW - 30 * MIN, messages: [{ channel: 'D1', ts: '1.0', user: 'U2', text: `Первая строка ${'x'.repeat(100)}\nвторая` }] }),
    item({ status: 'awaiting', createdAt: NOW - 3 * 24 * HOUR, authorName: 'Old Name' }), // still awaiting: no since bound
    item({ status: 'triage', createdAt: NOW - 11 * MIN }), // stuck: older than 600 s
    item({ status: 'settling', createdAt: NOW - 5 * MIN }), // young: not stuck
    item({ status: 'settling', createdAt: NOW - 20 * MIN }),
    item({ status: 'sent', sentChoice: 2, channel: 'C1', closedAt: NOW - HOUR }),
    item({ status: 'sent', sentChoice: 'custom', closedAt: NOW - 30 * HOUR }), // before since
    item({ status: 'answered_manually', closedAt: NOW - 4 * HOUR }),
    item({ status: 'skipped', closedAt: NOW - HOUR }), // in no list
  )
  s.feedback.push(
    { itemId: '1', at: NOW - HOUR, source: 'im', channel: 'D1' },
    { itemId: '2', at: NOW - 2 * HOUR, source: 'im', channel: 'D1' },
    { itemId: '3', at: NOW - 30 * HOUR, source: 'im', channel: 'D1' },
  )
  const p = briefingPayload(s, cfg, NOW, undefined)
  expect(p.ignored).toEqual([
    { id: '1', channel: 'pathfinders', author: 'Boris', reason: 'FYI', at: new Date(NOW - 2 * HOUR).toISOString() },
    { id: '3', channel: 'D1', author: 'Anna', reason: 'legacy', at: new Date(NOW - 3 * HOUR + MIN).toISOString() },
  ])
  expect(p.awaiting).toEqual([
    { id: '4', channel: 'D1', author: 'Anna', age_minutes: 30, first_line: `Первая строка ${'x'.repeat(66)}` },
    { id: '5', channel: 'D1', author: 'Old Name', age_minutes: 3 * 24 * 60, first_line: 'msg 5' },
  ])
  expect(p.stuck).toEqual([
    { id: '6', status: 'triage', age_minutes: 11 },
    { id: '8', status: 'settling', age_minutes: 20 },
  ])
  expect(p.answered).toEqual([{ id: '9', channel: 'pathfinders', chosen: 2, sent_at: new Date(NOW - HOUR).toISOString() }])
  expect(p.manual).toEqual([{ id: '11', channel: 'D1' }])
  expect(p.feedback_count).toBe(2)
  expect(p).not.toHaveProperty('threads_with_news') // not derivable from state: omitted
})

test('ignored holds at most the 20 most recent', () => {
  const items = Array.from({ length: 25 }, (_, k) => item({ status: 'ignored', ignoreReason: `r${k}`, closedAt: NOW - (k + 1) * MIN }))
  const p = briefingPayload(stateWith(...items), cfg, NOW, undefined)
  expect(p.ignored).toHaveLength(20)
  expect(p.ignored[0]!.reason).toBe('r0')
  expect(p.ignored[19]!.reason).toBe('r19')
})

test('an empty state gives empty lists', () => {
  expect(briefingPayload(stateWith(), cfg, NOW, NOW - HOUR)).toEqual({
    since: new Date(NOW - HOUR).toISOString(), ignored: [], awaiting: [], stuck: [], answered: [], manual: [],
    feedback_count: 0, today: '2026-10-20',
  })
})
