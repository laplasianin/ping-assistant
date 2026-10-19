import { describe, expect, test } from 'bun:test'
import { chunk, humanizeSlack, outcome, renderItem, renderProposal, renderThreadChanged, renderUpdate, slackify } from '../src/format'
import type { Item, SlackMsg } from '../src/state'

const NOW = 1_760_800_000_000
const msg = (text: string, extra: Partial<SlackMsg> = {}): SlackMsg => ({ channel: 'C1', ts: '1.1', user: 'U1', text, ...extra })
const item = (extra: Partial<Item> = {}): Item => ({
  id: '14', seq: 14, sub: 0, status: 'awaiting', source: 'channel', channel: 'C1', channelName: 'pathfinders',
  author: 'U1', authorName: 'Max Darski', messages: [msg('Привет, <@U2>!', { permalink: 'https://slack/p1' })], context: [],
  lastSeenTs: '1.1', createdAt: NOW - 5 * 60_000, lastMessageAt: NOW - 5 * 60_000,
  analysis: 'Тип: вопрос\nСмысл: просит статус', variants: ['Да', 'Нет', 'Позже'], telegram: {}, ...extra,
})

describe('humanizeSlack', () => {
  test('replaces user, channel, link and entities', () => {
    const users = { U1: 'Ann' }
    const channels = { C2: 'dev' }
    expect(humanizeSlack('<@U1> и <@U9>', users, channels)).toBe('@Ann и @U9')
    expect(humanizeSlack('<#C1|general> <#C2> <#C3>', users, channels)).toBe('#general #dev #C3')
    expect(humanizeSlack('<https://a.b|сайт> <https://c.d>', users, channels)).toBe('сайт (https://a.b) https://c.d')
    expect(humanizeSlack('a &amp; b &lt;c&gt; <!here> <!channel>', users, channels)).toBe('a & b <c> @here @channel')
    expect(humanizeSlack('&lt;@U1&gt;', users, channels)).toBe('<@U1>')
  })
})

describe('renderItem', () => {
  test('variants are shown exactly as they will be sent (slackified)', () => {
    const v = 'Смотри **тут** и **там**'
    const { text } = renderItem(item({ variants: [v] }), {}, {}, NOW)
    expect(text).toContain(`Варианты:\n1. ${slackify(v)}`)
    expect(text).not.toContain('**')
  })

  test('header has id, channel, author, age and N+1 buttons', () => {
    const { text, keyboard } = renderItem(item(), { U2: 'Bob' }, {}, NOW)
    expect(text.startsWith('#14 · #pathfinders · Max Darski · 5 мин назад')).toBe(true)
    expect(text).toContain('Привет, @Bob!')
    expect(text).toContain('https://slack/p1')
    expect(text).toContain('Варианты:\n1. Да\n2. Нет\n3. Позже')
    expect(text).toContain('Ответь: «14 1» · «14 2, но …» · «14: свой текст» · «14 пропустить»')
    expect(keyboard[0].map((b) => b.label)).toEqual(['1', '2', '3', 'Пропустить'])
    expect(keyboard[0].map((b) => b.data)).toEqual(['pa:choose:14:1', 'pa:choose:14:2', 'pa:choose:14:3', 'pa:skip:14'])
  })
  test('IM shows личка and age units', () => {
    const t = (it: Item) => renderItem(it, {}, {}, NOW).text.split('\n')[0]
    expect(t(item({ source: 'im', channelName: undefined }))).toBe('#14 · личка · Max Darski · 5 мин назад')
    expect(t(item({ lastMessageAt: NOW - 2 * 3_600_000 }))).toContain('2 ч назад')
    expect(t(item({ lastMessageAt: NOW - 3 * 86_400_000 }))).toContain('3 д назад')
  })
  test('lists all questions when analysis has several', () => {
    const analysis = 'Тип: вопрос\n1) Когда релиз?\n2) Кто тестирует?'
    const { text } = renderItem(item({ analysis, messages: [msg('Когда релиз?'), msg('Кто тестирует?')] }), {}, {}, NOW)
    expect(text).toContain('1) Когда релиз?\n2) Кто тестирует?')
    expect(text).toContain('Когда релиз?\n\nКто тестирует?')
  })
})

describe('other renders', () => {
  test('renderProposal has Отправить/Отмена with pa:confirm/pa:cancel', () => {
    const { text, keyboard } = renderProposal(item(), 'Готово')
    expect(text).toBe('#14 · финальный текст:\n\nГотово')
    expect(keyboard).toEqual([[{ label: 'Отправить', data: 'pa:confirm:14' }, { label: 'Отмена', data: 'pa:cancel:14' }]])
  })
  test('renderThreadChanged and renderUpdate', () => {
    const { text, keyboard } = renderThreadChanged(item(), [msg('новое')])
    expect(text).toBe('#14 · в треде появилось новое:\n\nновое')
    expect(keyboard).toEqual([[{ label: 'Всё равно отправить', data: 'pa:force:14' }, { label: 'Отмена', data: 'pa:cancel:14' }]])
    expect(renderUpdate(item(), [msg('a'), msg('b')])).toBe('#14 дополнение\n\na\n\nb')
  })
  test('renderUpdate and renderThreadChanged humanize mentions', () => {
    const m = [msg('привет <@U2>')]
    expect(renderUpdate(item(), m, { U2: 'Имя' })).toBe('#14 дополнение\n\nпривет @Имя')
    expect(renderThreadChanged(item(), m, { U2: 'Имя' }).text).toBe('#14 · в треде появилось новое:\n\nпривет @Имя')
  })
  test('outcome', () => {
    expect(outcome(item({ status: 'sent' }), 2)).toBe('✅ отправлен вариант 2')
    expect(outcome(item({ status: 'sent' }))).toBe('✅ отправлено')
    expect(outcome(item({ status: 'sent' }), 'custom')).toBe('✅ отправлено (свой текст)')
    expect(outcome(item({ status: 'skipped' }))).toBe('⏭ пропущен')
    expect(outcome(item({ status: 'answered_manually' }))).toBe('🙈 отвечено вручную')
    expect(outcome(item({ status: 'awaiting' }))).toBe('✏️ правка ниже')
    expect(outcome(item({ status: 'triage' }))).toBe('')
  })
})

describe('slackify', () => {
  test('converts **bold** to *bold* and leaves text otherwise unchanged', () => {
    expect(slackify('**x** и `код` <https://a.b|t> @Имя')).toBe('*x* и `код` <https://a.b|t> @Имя')
  })
})

describe('chunk', () => {
  test('keeps paragraphs and never exceeds limit', () => {
    expect(chunk('a\n\nb', 100)).toEqual(['a\n\nb'])
    expect(chunk('aaaa\n\nbbbb\n\ncccc', 10)).toEqual(['aaaa\n\nbbbb', 'cccc'])
    const parts = chunk(`x\n\n${'y'.repeat(25)}\n\nz`, 10)
    expect(parts).toEqual(['x', 'y'.repeat(10), 'y'.repeat(10), 'yyyyy\n\nz'])
    expect(parts.every((p) => p.length <= 10)).toBe(true)
    expect(chunk('short').length).toBe(1)
  })
})
