import { test, expect } from 'bun:test'
import { ALERT_INTERVAL_MS, MISSING_GRACE_MS, decide, parseState } from '../scripts/watchdog'

const T = 1_000_000_000_000

const G = MISSING_GRACE_MS

test('first missing run: no alert, missingSince recorded', () => {
  expect(decide(false, T, {})).toEqual({ action: 'none', next: { missingSince: T } })
})

test('still missing just under 5 minutes: no alert, missingSince kept', () => {
  const s = { missingSince: T - G + 1 }
  expect(decide(false, T, s)).toEqual({ action: 'none', next: s })
})

test('still missing after 5 minutes: alert', () => {
  expect(decide(false, T, { missingSince: T - G })).toEqual({
    action: 'alert',
    next: { lastAlertAt: T, missingSince: T - G },
  })
})

test('back within 5 minutes: no alert, no recovery, missingSince cleared', () => {
  expect(decide(true, T, { missingSince: T - 1000 })).toEqual({ action: 'none', next: {} })
})

test('recovery after an alert: recover and clear state', () => {
  expect(decide(true, T, { lastAlertAt: T - 5000, missingSince: T - G - 5000 })).toEqual({ action: 'recover', next: {} })
})

test('server down, alerted recently: stay quiet and keep state', () => {
  const s = { lastAlertAt: T - ALERT_INTERVAL_MS + 1000, missingSince: T - ALERT_INTERVAL_MS - 1000 }
  expect(decide(false, T, s)).toEqual({ action: 'none', next: s })
})

test('server down, exactly 60 minutes: still quiet; past 60 minutes: alert again', () => {
  const s = { lastAlertAt: T - ALERT_INTERVAL_MS, missingSince: T - 2 * ALERT_INTERVAL_MS }
  expect(decide(false, T, s).action).toBe('none')
  expect(decide(false, T + 1, s)).toEqual({
    action: 'alert',
    next: { lastAlertAt: T + 1, missingSince: s.missingSince },
  })
})

test('server up, no prior alert or outage: nothing', () => {
  expect(decide(true, T, {})).toEqual({ action: 'none', next: {} })
})

test('parseState tolerates garbage', () => {
  expect(parseState('not json')).toEqual({})
  expect(parseState('{"lastAlertAt":"x"}')).toEqual({})
  expect(parseState('null')).toEqual({})
  expect(parseState('{"lastAlertAt":5}')).toEqual({ lastAlertAt: 5 })
  expect(parseState('{"lastAlertAt":5,"missingSince":3}')).toEqual({ lastAlertAt: 5, missingSince: 3 })
  expect(parseState('{"missingSince":"x"}')).toEqual({})
})
