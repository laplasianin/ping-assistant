import { describe, expect, test } from 'bun:test'
import { callbackData, parseCallback, parseText } from '../src/commands'

describe('parseText', () => {
  test('choose', () => {
    expect(parseText('14 2')).toEqual({ kind: 'choose', itemId: '14', n: 2 })
    expect(parseText('14.2 1')).toEqual({ kind: 'choose', itemId: '14.2', n: 1 })
    expect(parseText('#14 2')).toEqual({ kind: 'choose', itemId: '14', n: 2 })
  })
  test('skip, confirm, custom', () => {
    expect(parseText('14 пропустить')).toEqual({ kind: 'skip', itemId: '14' })
    expect(parseText('14 Skip')).toEqual({ kind: 'skip', itemId: '14' })
    expect(parseText('14: привет, да')).toEqual({ kind: 'custom', itemId: '14', text: 'привет, да' })
    expect(parseText('14 да')).toEqual({ kind: 'confirm', itemId: '14' })
    expect(parseText('14 ДА')).toEqual({ kind: 'confirm', itemId: '14' })
  })
  test('forward', () => {
    expect(parseText('14 2, но без тикета')).toEqual({ kind: 'forward', itemId: '14', text: '2, но без тикета' })
    expect(parseText('14 ещё')).toEqual({ kind: 'forward', itemId: '14', text: 'ещё' })
    expect(parseText('что ты проигнорировал сегодня?')).toEqual({ kind: 'forward', text: 'что ты проигнорировал сегодня?' })
  })
  test('quoted item id applies to the whole text', () => {
    expect(parseText('2', '14')).toEqual({ kind: 'choose', itemId: '14', n: 2 })
    expect(parseText('да', '14')).toEqual({ kind: 'confirm', itemId: '14' })
    expect(parseText('пропустить', '14')).toEqual({ kind: 'skip', itemId: '14' })
    expect(parseText(': свой текст', '14')).toEqual({ kind: 'custom', itemId: '14', text: 'свой текст' })
    expect(parseText('2 но короче', '14')).toEqual({ kind: 'forward', itemId: '14', text: '2 но короче' })
    expect(parseText('2 да', '14')).toEqual({ kind: 'forward', itemId: '14', text: '2 да' })
    expect(parseText('14 2', '14')).toEqual({ kind: 'choose', itemId: '14', n: 2 })
    expect(parseText('14: текст', '14')).toEqual({ kind: 'custom', itemId: '14', text: 'текст' })
    expect(parseText('просто текст', '14')).toEqual({ kind: 'forward', itemId: '14', text: 'просто текст' })
  })
})

describe('callbacks', () => {
  test('parseCallback', () => {
    expect(parseCallback('pa:choose:14:2')).toEqual({ kind: 'choose', itemId: '14', n: 2 })
    expect(parseCallback('pa:skip:14')).toEqual({ kind: 'skip', itemId: '14' })
    expect(parseCallback('pa:confirm:14.2')).toEqual({ kind: 'confirm', itemId: '14.2' })
    expect(parseCallback('pa:cancel:14')).toEqual({ kind: 'cancel', itemId: '14' })
    expect(parseCallback('perm:allow:abcde')).toBeNull()
    expect(parseCallback('pa:bogus:14')).toBeNull()
    expect(parseCallback('pa:choose:14')).toBeNull()
  })
  test('callbackData round-trips', () => {
    expect(parseCallback(callbackData({ kind: 'force', itemId: '14.2' }))).toEqual({ kind: 'force', itemId: '14.2' })
    expect(callbackData({ kind: 'choose', itemId: '14', n: 3 })).toBe('pa:choose:14:3')
  })
})
