import { test, expect } from 'bun:test'
import { CHAT_LOG_MAX, RECENT_CHAT, logChat, needsAck, pruneChatLog, recentChat } from '../src/chat'
import { prune } from '../src/items'
import type { Config } from '../src/config'
import { emptyState } from '../src/state'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0)

test('ack only for texts longer than 12 characters or ending with ?', () => {
  expect(needsAck('ок')).toBe(false)
  expect(needsAck('спасибо, понял')).toBe(true) // 14 chars
  expect(needsAck('ровно 12 сим')).toBe(false) // exactly 12
  expect(needsAck('а второй?')).toBe(true)
  expect(needsAck('  что?  ')).toBe(true)
})

test('chat log is capped at CHAT_LOG_MAX entries, oldest dropped', () => {
  const s = emptyState()
  for (let i = 0; i < CHAT_LOG_MAX + 5; i++) logChat(s, i % 2 ? 'assistant' : 'user', `m${i}`, T0 + i)
  expect(s.chatLog).toHaveLength(CHAT_LOG_MAX)
  expect(s.chatLog[0]!.text).toBe('m5')
  expect(s.chatLog.at(-1)!.text).toBe(`m${CHAT_LOG_MAX + 4}`)
})

test('recent_chat is the last RECENT_CHAT entries with ISO times', () => {
  const s = emptyState()
  for (let i = 0; i < 20; i++) logChat(s, i % 2 ? 'assistant' : 'user', `m${i}`, T0 + i * 1000)
  const recent = recentChat(s)
  expect(recent).toHaveLength(RECENT_CHAT)
  expect(recent.at(-1)).toEqual({ at: new Date(T0 + 19_000).toISOString(), from: 'assistant', text: 'm19' })
  expect(recent[0]!.text).toBe(`m${20 - RECENT_CHAT}`)
})

test('chat log entries older than 7 days are pruned, also by the hourly prune', () => {
  const s = emptyState()
  logChat(s, 'user', 'old', T0 - 8 * DAY)
  logChat(s, 'assistant', 'fresh', T0 - DAY)
  expect(pruneChatLog(s, T0)).toBe(true)
  expect(s.chatLog.map((e) => e.text)).toEqual(['fresh'])
  expect(pruneChatLog(s, T0)).toBe(false)

  const t = emptyState()
  logChat(t, 'user', 'old', T0 - 8 * DAY)
  expect(prune(t, T0, { followUpDays: 7 } as Config)).toBe(true)
  expect(t.chatLog).toEqual([])
})

test('a state file without chatLog loads with an empty log', () => {
  const s = { ...emptyState(), chatLog: undefined as never }
  expect(recentChat(s)).toEqual([])
  logChat(s, 'user', 'x', T0)
  expect(s.chatLog).toHaveLength(1)
})
