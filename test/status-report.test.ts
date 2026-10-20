import { test, expect } from 'bun:test'
import { notifyStopped, SHUTDOWN_TEXT, StartupReporter, startupReport, type StartupInfo, type Timers } from '../src/status-report'

const info: StartupInfo = { dryRun: false, slack: 'connected', account: { user: 'ilya', team: 'sb' }, model: 'claude-opus-5-5', openItems: 3 }

test('startupReport: live, connected', () => {
  expect(startupReport(info)).toBe([
    '✅ Ping Assistant запущен', 'режим: боевой', 'Slack: сокет подключён', 'Slack-аккаунт: ilya',
    'модель сессии: claude-opus-5-5', 'открытых вопросов: 3',
  ].join('\n'))
})

test('startupReport: dry-run, socket down, no model', () => {
  const t = startupReport({ ...info, dryRun: true, slack: 'disconnected', model: undefined, openItems: 0 })
  expect(t).toContain('режим: dry-run (в Slack ничего не уходит)')
  expect(t).toContain('Slack: сокет не подключён, работаю опросом')
  expect(t).toContain('модель сессии: по умолчанию (см. лаунчер)')
  expect(t).toContain('открытых вопросов: 0')
})

test('startupReport: polling only and auth failure', () => {
  const t = startupReport({ ...info, slack: 'polling-only', account: { error: 'slack auth.test: invalid_auth' } })
  expect(t).toContain('Slack: опрос (SLACK_APP_TOKEN не задан)')
  expect(t).toContain('Slack: ошибка авторизации (slack auth.test: invalid_auth)')
  expect(t).not.toContain('Slack-аккаунт')
})

class FakeTimers implements Timers {
  pending = new Map<number, { fn: () => void; ms: number }>()
  private n = 0
  set(fn: () => void, ms: number) { this.pending.set(++this.n, { fn, ms }); return this.n }
  clear(h: unknown) { this.pending.delete(h as number) }
  fireAll() { for (const [k, v] of [...this.pending]) { this.pending.delete(k); v.fn() } }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

function reporter(over: { send?: (t: string) => Promise<unknown> } = {}) {
  const sent: string[] = []
  const logs: string[] = []
  const timers = new FakeTimers()
  const r = new StartupReporter({
    collect: async () => info, log: (k) => logs.push(k), timers,
    send: over.send ?? (async (t) => { sent.push(t) }),
  })
  return { r, sent, logs, timers }
}

test('report waits for Telegram and Slack hello', async () => {
  const { r, sent } = reporter()
  r.slackHello(); await tick()
  expect(sent).toEqual([])
  r.telegramStarted(); await tick()
  expect(sent).toEqual([startupReport(info)])
})

test('report goes out after the 20s timer without hello, once Telegram is up', async () => {
  const { r, sent, timers } = reporter()
  expect([...timers.pending.values()][0]!.ms).toBe(20_000)
  r.telegramStarted(); await tick()
  expect(sent).toEqual([])
  timers.fireAll(); await tick()
  expect(sent).toHaveLength(1)
})

test('timer before Telegram: waits for Telegram', async () => {
  const { r, sent, timers } = reporter()
  timers.fireAll(); await tick()
  expect(sent).toEqual([])
  r.telegramStarted(); await tick()
  expect(sent).toHaveLength(1)
})

test('sent exactly once across hello, timer and repeated polling starts', async () => {
  const { r, sent, timers } = reporter()
  r.telegramStarted(); r.slackHello(); r.slackHello(); r.telegramStarted(); timers.fireAll(); await tick()
  expect(sent).toHaveLength(1)
  expect(timers.pending.size).toBe(0)
})

test('a failed send is logged by name and does not throw', async () => {
  const { r, logs } = reporter({ send: async () => { throw new TypeError('secret detail') } })
  r.telegramStarted(); r.slackHello(); await tick()
  expect(logs).toEqual(['startup report failed: TypeError'])
})

test('notifyStopped sends the stop text', async () => {
  const sent: string[] = []
  await notifyStopped(async (t) => { sent.push(t) }, 2000, new FakeTimers())
  expect(sent).toEqual([SHUTDOWN_TEXT])
})

test('notifyStopped gives up after the timeout and swallows send errors', async () => {
  const timers = new FakeTimers()
  const hung = notifyStopped(() => new Promise(() => {}), 2000, timers)
  expect([...timers.pending.values()][0]!.ms).toBe(2000)
  timers.fireAll()
  await hung
  await notifyStopped(async () => { throw new Error('down') }, 2000, new FakeTimers())
})
