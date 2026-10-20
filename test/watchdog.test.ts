import { test, expect } from 'bun:test'
import { ALERT_INTERVAL_MS, decide, parseState } from '../scripts/watchdog'

const T = 1_000_000_000_000

test('server down, no prior alert: alert and remember the time', () => {
  expect(decide(false, T, {})).toEqual({ action: 'alert', next: { lastAlertAt: T } })
})

test('server down, alerted recently: stay quiet and keep state', () => {
  const s = { lastAlertAt: T - ALERT_INTERVAL_MS + 1000 }
  expect(decide(false, T, s)).toEqual({ action: 'none', next: s })
})

test('server down, exactly 60 minutes: still quiet; past 60 minutes: alert again', () => {
  const s = { lastAlertAt: T - ALERT_INTERVAL_MS }
  expect(decide(false, T, s).action).toBe('none')
  expect(decide(false, T + 1, s)).toEqual({ action: 'alert', next: { lastAlertAt: T + 1 } })
})

test('server up with a prior alert: recover once and clear state', () => {
  expect(decide(true, T, { lastAlertAt: T - 5000 })).toEqual({ action: 'recover', next: {} })
})

test('server up, no prior alert: nothing', () => {
  expect(decide(true, T, {})).toEqual({ action: 'none', next: {} })
})

test('parseState tolerates garbage', () => {
  expect(parseState('not json')).toEqual({})
  expect(parseState('{"lastAlertAt":"x"}')).toEqual({})
  expect(parseState('null')).toEqual({})
  expect(parseState('{"lastAlertAt":5}')).toEqual({ lastAlertAt: 5 })
})
