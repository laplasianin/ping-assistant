import { describe, expect, test } from 'bun:test'
import { chunk, escapeHtml, humanizeSlack, outcome, renderItem, renderProposal, renderThreadChanged, renderUpdate, slackify, slackToHtml, stripHtml } from '../src/format'
import type { References } from '../src/references'
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
  test('variants are shown exactly as they will be sent (slackified), escaped', () => {
    const v = 'Смотри **тут** и <там>'
    const { text } = renderItem(item({ variants: [v] }), {}, {}, NOW)
    expect(text).toContain(`<b>Варианты</b>\n1️⃣ ${escapeHtml(slackify(v))}`)
    expect(text).not.toContain('**')
  })

  test('target layout: bold header, expandable quote, link, bold labels, numbered variants, italic hint', () => {
    const analysis = 'Тип: вопрос\nВопросы (2): статус?\nРазбор: <нужен> ответ\nСмысл: просит статус'
    const { text, keyboard } = renderItem(item({ analysis }), { U2: 'Bob' }, {}, NOW)
    expect(text).toBe([
      '<b>#14</b> · #pathfinders · Max Darski · 5 мин назад\n'
        + '<blockquote expandable>Привет, @Bob!</blockquote>\n'
        + '<a href="https://slack/p1">Открыть в Slack</a>',
      '<b>Тип:</b> вопрос\n<b>Вопросы (2):</b> статус?\n<b>Разбор:</b> &lt;нужен&gt; ответ\nСмысл: просит статус',
      '<b>Варианты</b>\n1️⃣ Да',
      '2️⃣ Нет',
      '3️⃣ Позже',
      '<i>Правка: ответь цитатой «2, но …» или «: свой текст»</i>',
    ].join('\n\n'))
    expect(text).not.toContain('Ответь:')
    expect(keyboard[0].map((b) => b.label)).toEqual(['1', '2', '3', 'Пропустить'])
    expect(keyboard[0].map((b) => b.data)).toEqual(['pa:choose:14:1', 'pa:choose:14:2', 'pa:choose:14:3', 'pa:skip:14'])
  })
  test('Slack markup in the quote becomes HTML, names are escaped', () => {
    const { text } = renderItem(item({ channelName: 'a<b', authorName: 'A & B', messages: [msg('*важно* <https://x|PR>')] }), {}, {}, NOW)
    expect(text.split('\n')[0]).toBe('<b>#14</b> · #a&lt;b · A &amp; B · 5 мин назад')
    expect(text).toContain('<blockquote expandable><b>важно</b> <a href="https://x">PR</a></blockquote>')
  })
  test('more than three variants fall back to «4.»', () => {
    const { text } = renderItem(item({ variants: ['a', 'b', 'c', 'd'] }), {}, {}, NOW)
    expect(text).toContain('3️⃣ c\n\n4. d')
  })
  test('IM shows личка and age units', () => {
    const t = (it: Item) => renderItem(it, {}, {}, NOW).text.split('\n')[0]
    expect(t(item({ source: 'im', channelName: undefined }))).toBe('<b>#14</b> · личка · Max Darski · 5 мин назад')
    expect(t(item({ lastMessageAt: NOW - 2 * 3_600_000 }))).toContain('2 ч назад')
    expect(t(item({ lastMessageAt: NOW - 3 * 86_400_000 }))).toContain('3 д назад')
  })
  test('all messages go into one quote; analysis lines are kept', () => {
    const analysis = 'Тип: вопрос\n1) Когда релиз?\n2) Кто тестирует?'
    const { text } = renderItem(item({ analysis, messages: [msg('Когда релиз?'), msg('Кто тестирует?')] }), {}, {}, NOW)
    expect(text).toContain('1) Когда релиз?\n2) Кто тестирует?')
    expect(text).toContain('<blockquote expandable>Когда релиз?\n\nКто тестирует?</blockquote>')
    expect(text.match(/<blockquote/g)).toHaveLength(1)
  })
  test('the quote is capped at 2500 chars on a line boundary, tags stay balanced', () => {
    const line = `*${'ж'.repeat(98)}*`
    const long = Array.from({ length: 60 }, () => line).join('\n')
    const { text } = renderItem(item({ messages: [msg(long, { permalink: 'https://slack/p1' })] }), {}, {}, NOW)
    const quote = text.slice(text.indexOf('<blockquote'), text.indexOf('</blockquote>') + '</blockquote>'.length)
    expect(quote.length).toBeLessThanOrEqual(2500 + 100)
    expect(quote).toEndWith('\n…</blockquote>')
    expect(quote).not.toContain('ж*') // cut between lines: every line still converted whole
    expect(quote.match(/<b>/g)!.length).toBe(quote.match(/<\/b>/g)!.length)
    expect(text).toContain('<a href="https://slack/p1">Открыть в Slack</a>')
  })
  test('a cut inside a code block closes the open tags', () => {
    const long = `\`\`\`\n${Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')}\n\`\`\``
    const { text } = renderItem(item({ messages: [msg(long)] }), {}, {}, NOW)
    expect(text).toContain('</pre>\n…</blockquote>')
  })
})

describe('other renders', () => {
  test('renderProposal has Отправить/Отмена with pa:confirm/pa:cancel', () => {
    const { text, keyboard } = renderProposal(item(), 'Готово <b>')
    expect(text).toBe('<b>#14 · финальный текст</b>\n\nГотово &lt;b&gt;')
    expect(keyboard).toEqual([[{ label: 'Отправить', data: 'pa:confirm:14' }, { label: 'Отмена', data: 'pa:cancel:14' }]])
  })
  test('renderThreadChanged and renderUpdate', () => {
    const { text, keyboard } = renderThreadChanged(item(), [msg('новое')])
    expect(text).toBe('<b>#14 · в треде появилось новое</b>\n<blockquote expandable>новое</blockquote>')
    expect(keyboard).toEqual([[{ label: 'Всё равно отправить', data: 'pa:force:14' }, { label: 'Отмена', data: 'pa:cancel:14' }]])
    expect(renderUpdate(item(), [msg('a'), msg('b')])).toBe('<b>#14 · дополнение</b>\n<blockquote expandable>a\n\nb</blockquote>')
  })
  test('renderUpdate and renderThreadChanged convert mentions and markup', () => {
    const m = [msg('привет <@U2> *срочно*')]
    expect(renderUpdate(item(), m, { U2: 'Имя' })).toBe('<b>#14 · дополнение</b>\n<blockquote expandable>привет @Имя <b>срочно</b></blockquote>')
    expect(renderThreadChanged(item(), m, { U2: 'Имя' }).text).toBe('<b>#14 · в треде появилось новое</b>\n<blockquote expandable>привет @Имя <b>срочно</b></blockquote>')
  })
  test('renderUpdate and renderThreadChanged cap the quote like an item: one expandable blockquote, cut on a line', () => {
    const long = Array.from({ length: 60 }, () => `*${'ж'.repeat(98)}*`).join('\n')
    for (const text of [renderUpdate(item(), [msg(long)]), renderThreadChanged(item(), [msg(long)]).text]) {
      expect(text.match(/<blockquote/g)).toHaveLength(1)
      expect(text).toContain('<blockquote expandable>')
      expect(text).toEndWith('\n…</blockquote>')
      expect(text.length).toBeLessThanOrEqual(2500 + 100)
      expect(text).not.toContain('ж*')
      expect(chunk(text)).toHaveLength(1)
    }
  })
  test('a non-http permalink is shown as escaped text, not a link', () => {
    const { text } = renderItem(item({ messages: [msg('x', { permalink: 'javascript:alert("1")<b>' })] }), {}, {}, NOW)
    expect(text).not.toContain('<a href')
    expect(text).toContain('javascript:alert("1")&lt;b&gt;')
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

const balanced = (part: string): boolean => {
  const stack: string[] = []
  for (const [, close, name] of part.matchAll(/<(\/?)([a-z]+)[^<>]*>/g)) {
    if (!close) stack.push(name!)
    else if (stack.pop() !== name) return false
  }
  return stack.length === 0
}

describe('chunk', () => {
  test('keeps paragraphs and never exceeds limit', () => {
    expect(chunk('a\n\nb', 100)).toEqual(['a\n\nb'])
    expect(chunk('aaaa\n\nbbbb\n\ncccc', 10)).toEqual(['aaaa\n\nbbbb', 'cccc'])
    const parts = chunk(`x\n\n${'y'.repeat(25)}\n\nz`, 10)
    expect(parts).toEqual(['x', 'y'.repeat(10), 'y'.repeat(10), 'yyyyy\n\nz'])
    expect(parts.every((p) => p.length <= 10)).toBe(true)
    expect(chunk('short').length).toBe(1)
  })
  test('never splits a blockquote or a tag at its blank lines', () => {
    const quote = `<blockquote expandable>${'q'.repeat(30)}\n\n${'r'.repeat(30)}</blockquote>`
    const parts = chunk(`<b>#1</b>\n${quote}\n\n${'a'.repeat(50)}`, 120)
    expect(parts).toEqual([`<b>#1</b>\n${quote}`, 'a'.repeat(50)])
  })
  test('an oversized tagged paragraph is split with its tags closed and reopened', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} &amp; <b>bold</b>`)
    const para = `<blockquote>${lines.join('\n')}</blockquote>`
    const parts = chunk(`head\n\n${para}`, 200)
    expect(parts.length).toBeGreaterThan(3)
    expect(parts.every((p) => p.length <= 200 && balanced(p))).toBe(true)
    expect(parts.slice(1).every((p) => p.startsWith('<blockquote>') && p.endsWith('</blockquote>'))).toBe(true)
    expect(parts.map(stripHtml).join('\n').replace(/^head\n/, '')).toBe(stripHtml(para))
  })
  test('a hard cut never lands inside a tag or an entity', () => {
    const para = `<b>${'x'.repeat(5)}&amp;${'y'.repeat(30)}</b>`
    const parts = chunk(para, 20)
    expect(parts.every((p) => p.length <= 20 && balanced(p) && !/&[a-z]*$/.test(p.replace(/<[^>]*>$/g, '')))).toBe(true)
    expect(parts.map(stripHtml).join('')).toBe(stripHtml(para))
  })
  test('plain mode keeps the old behaviour for text with stray <', () => {
    expect(chunk('a <b\n\nc', 5, false)).toEqual(['a <b', 'c'])
  })
})

describe('escapeHtml / stripHtml', () => {
  test('escapes &, <, > and strips back to plain text', () => {
    expect(escapeHtml('a & b <c> d')).toBe('a &amp; b &lt;c&gt; d')
    expect(stripHtml('<b>#1</b> a &amp; b &lt;c&gt; <a href="https://x?a=1&amp;b=2">link</a>')).toBe('#1 a & b <c> link (https://x?a=1&b=2)')
    expect(stripHtml('<a href="https://slack/p1">Открыть в Slack</a>')).toBe('Открыть в Slack (https://slack/p1)')
    expect(stripHtml('<a href="https://c.d/?q=&quot;1&quot;">https://c.d/?q="1"</a>')).toBe('https://c.d/?q="1"')
    expect(stripHtml('<blockquote expandable>q</blockquote>\n<i>x &quot;y&quot;</i>')).toBe('q\nx "y"')
    expect(stripHtml('&amp;lt;')).toBe('&lt;')
  })
})

describe('slackToHtml', () => {
  const users = { U1: 'Ann' }
  const channels = { C2: 'dev' }
  const h = (t: string) => slackToHtml(t, users, channels)
  test('formatting', () => {
    expect(h('*bold* _it_ ~gone~ `code`')).toBe('<b>bold</b> <i>it</i> <s>gone</s> <code>code</code>')
    expect(h('```\nconst a = 1 < 2\n```')).toBe('<pre>\nconst a = 1 &lt; 2\n</pre>')
    expect(h('snake_case_name and 2*3*4')).toBe('snake_case_name and 2*3*4')
    expect(h('`*not bold*`')).toBe('<code>*not bold*</code>')
  })
  test('mentions, channels, specials and links', () => {
    expect(h('<@U1> и <@U9>')).toBe('@Ann и @U9')
    expect(h('<#C1|general> <#C2> <#C3>')).toBe('#general #dev #C3')
    expect(h('<!here> <!channel>')).toBe('@here @channel')
    expect(h('<https://a.b/?x=1&amp;y=2|сайт &amp; ко> <https://c.d>'))
      .toBe('<a href="https://a.b/?x=1&amp;y=2">сайт &amp; ко</a> <a href="https://c.d">https://c.d</a>')
    expect(h('*<@U1>* посмотри')).toBe('<b>@Ann</b> посмотри')
  })
  test('entities are decoded then re-escaped, raw markup can never leak', () => {
    expect(h('a &amp; b &lt;script&gt;')).toBe('a &amp; b &lt;script&gt;')
    expect(h('&lt;@U1&gt;')).toBe('&lt;@U1&gt;')
    expect(slackToHtml('<@U1>', { U1: '<Evil & Co>' }, {})).toBe('@&lt;Evil &amp; Co&gt;')
    expect(h('<https://x|a"b>')).toBe('<a href="https://x">a"b</a>')
    expect(h('<https://x?q="1">')).toBe('<a href="https://x?q=&quot;1&quot;">https://x?q="1"</a>')
  })
  test('only http(s) links become <a href>; other schemes are escaped text', () => {
    expect(h('<javascript:alert(1)|x>')).toBe('x')
    expect(h('<javascript:alert(1)>')).toBe('javascript:alert(1)')
    expect(h('<tg://user?id=1|"t">')).toBe('"t"')
    expect(h('<data:text/html,&lt;b&gt;|d>')).toBe('d')
    expect(h('<mailto:a@b.c>')).toBe('mailto:a@b.c')
    expect(h('<HTTPS://A.B|ok> <http://c.d>')).toBe('<a href="HTTPS://A.B">ok</a> <a href="http://c.d">http://c.d</a>')
    expect(h('<data:text/html,&lt;b&gt;>')).toBe('data:text/html,&lt;b&gt;')
  })
  const balanced = (html: string): boolean => {
    const stack: string[] = []
    for (const [, close, name = ''] of html.matchAll(/<(\/?)([a-z]+)[^<>]*>/g)) {
      if (!close) stack.push(name)
      else if (stack.pop() !== name) return false
    }
    return stack.length === 0
  }
  test('misnested bold/italic falls back to escaped text with mentions and links kept', () => {
    for (const t of ['*a _b* c_', '_a *b_ c*', '*a ~b* c~ <@U1> <https://x|l>']) {
      const out = h(t)
      expect(balanced(out)).toBe(true)
      expect(out).not.toMatch(/<[bis]>/)
    }
    expect(h('*a _b* c_')).toBe('*a _b* c_')
    expect(h('_a *b_ c* <@U1> <https://x|l>')).toBe('_a *b_ c* @Ann <a href="https://x">l</a>')
    expect(h('*a _b_ c*')).toBe('<b>a <i>b</i> c</b>')
  })
  test('bold spanning a code block does not wrap <pre>', () => {
    const out = h('*a ```x\ny``` b*')
    expect(out).not.toContain('<b><pre>')
    expect(out).not.toMatch(/<b>[^]*<pre>/)
    expect(balanced(out)).toBe(true)
    expect(out).toContain('<pre>x\ny</pre>')
  })
})

describe('feedback button', () => {
  test('item messages carry a second row with 👎 разбор', () => {
    const { keyboard } = renderItem(item(), {}, {}, NOW)
    expect(keyboard).toHaveLength(2)
    expect(keyboard[1]).toEqual([{ label: '👎 разбор', data: 'pa:bad:14' }])
  })
  test('proposal and thread-changed warning have no feedback row', () => {
    const datas = (kb: { data: string }[][]) => kb.flat().map((b) => b.data)
    expect(renderProposal(item(), 'x').keyboard).toHaveLength(1)
    expect(datas(renderProposal(item(), 'x').keyboard)).not.toContain('pa:bad:14')
    expect(renderThreadChanged(item(), [msg('n')]).keyboard).toHaveLength(1)
    expect(datas(renderThreadChanged(item(), [msg('n')]).keyboard)).not.toContain('pa:bad:14')
  })
})

describe('reference lines', () => {
  const refs = (n: number): References => ({
    jira: Array.from({ length: n }, (_, i) => ({
      key: `PF-${i + 1}`, url: `https://j/browse/PF-${i + 1}`, summary: 's', status: 'In <QA>', assignee: 'Philipp & Co', updated: 'u',
    })),
    prs: [{ url: 'https://github.com/a/b/pull/7', repo: 'a/b', number: 7, title: 't', state: 'merged', author: 'an<dr>ei', updated: 'u', branch: 'x' }],
    unresolved: ['XX-1'], fetchedAt: NOW,
  })

  test('🔗 lines sit under the quote, linked and escaped', () => {
    const { text } = renderItem(item({ references: refs(1) }), { U2: 'Bob' }, {}, NOW)
    expect(text.split('\n\n')[0]).toBe([
      '<b>#14</b> · #pathfinders · Max Darski · 5 мин назад',
      '<blockquote expandable>Привет, @Bob!</blockquote>',
      '🔗 <a href="https://j/browse/PF-1">PF-1</a> · In &lt;QA&gt; · Philipp',
      '🔗 <a href="https://github.com/a/b/pull/7">PR #7</a> · merged · an&lt;dr&gt;ei',
      '<a href="https://slack/p1">Открыть в Slack</a>',
    ].join('\n'))
  })

  test('at most 3 lines; unresolved and empty references show nothing', () => {
    const { text } = renderItem(item({ references: refs(5) }), {}, {}, NOW)
    expect(text.match(/🔗/g)).toHaveLength(3)
    expect(text).not.toContain('PR #7')
    expect(renderItem(item({ references: { jira: [], prs: [], unresolved: ['PF-1'], fetchedAt: NOW } }), {}, {}, NOW).text).not.toContain('🔗')
  })
})
