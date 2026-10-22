import { test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { Channel } from '../src/channel'
import type { Config } from '../src/config'
import { slackify } from '../src/format'
import { Orchestrator, type OrchestratorDeps } from '../src/orchestrator'
import { ReferenceFetcher, type FetchLike, type GhRunner } from '../src/references'
import type { RawMsg, SlackClient } from '../src/slack/client'
import { Collector, type Collected, type TickResult } from '../src/slack/collector'
import * as items from '../src/items'
import { emptyState, type SlackMsg, type State, type StateStore } from '../src/state'
import { TelegramBot, type TelegramApi } from '../src/telegram/bot'

const CHAT = 42
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0)

class FakeSlack {
  repl: Record<string, RawMsg[]> = {}
  hist: Record<string, RawMsg[]> = {}
  posted: { channel: string; text: string; threadTs?: string }[] = []
  private after = (msgs: RawMsg[], oldest?: string) => msgs.filter((m) => !oldest || Number(m.ts) > Number(oldest))
  async replies(channel: string, threadTs: string, oldest?: string) {
    if (this.failReplies) throw new TypeError('network down')
    return this.after(this.repl[`${channel}:${threadTs}`] ?? [], oldest)
  }
  async history(channel: string, oldest?: string) { return this.after(this.hist[channel] ?? [], oldest) }
  recentCalls: { channel: string; latest: string; limit: number }[] = []
  async recent(channel: string, latest: string, limit: number) {
    this.recentCalls.push({ channel, latest, limit })
    return (this.hist[channel] ?? []).filter((m) => Number(m.ts) < Number(latest)).slice(-limit)
  }
  failReplies = false
  // Surface the real Collector needs beyond what the Orchestrator uses.
  async listDms() { return [] as { id: string; type: 'im' | 'mpim'; user?: string }[] }
  resetBudget() {}
  async searchMentions() { return [] as RawMsg[] }
  async channelName(id: string) { return `name-${id}` }
  async userName(id: string) { return `User ${id}` }
  async downloadFile() {}
  async permalink(channel: string, ts: string) { return `https://slack/${channel}/${ts}` }
  async postMessage(channel: string, text: string, threadTs?: string) {
    this.posted.push({ channel, text, ...(threadTs ? { threadTs } : {}) })
    return { ts: '9000.000100' }
  }
}

type Sent = { text: string; opts: Record<string, any>; id: number }
class FakeApi implements TelegramApi {
  sent: Sent[] = []
  failNextSend = false
  edits: { id: number; text: string; opts: Record<string, any> }[] = []
  nextId = 100
  dropped: number[] = []
  async sendMessage(_chat: string, text: string, opts: Record<string, any> = {}) {
    if (this.failNextSend) { this.failNextSend = false; throw new Error('telegram down') }
    if (text.length > 4096) throw new Error('Bad Request: message is too long')
    const id = this.nextId++
    this.sent.push({ text, opts, id })
    return { message_id: id }
  }
  async editMessageText(_chat: string, id: number, text: string, opts: Record<string, any> = {}) {
    if (text.length > 4096) throw new Error('Bad Request: MESSAGE_TOO_LONG')
    this.edits.push({ id, text, opts })
    return true
  }
  async editMessageReplyMarkup(_chat: string, id: number) { this.dropped.push(id); return true }
  async answerCallbackQuery() { return true }
  last(): Sent { return this.sent[this.sent.length - 1]! }
  lastEdit(id: number) { return this.edits.filter((e) => e.id === id).pop() }
}

class FakeCollector {
  queue: Collected[] = []
  async tick(): Promise<TickResult> { return { collected: this.queue.splice(0), cursorUpdates: {}, removeCursors: [] } }
}

const Note = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
})
type NoteParams = z.infer<typeof Note>['params']

const baseCfg: Config = {
  userId: 'ME', watchChannels: ['C1'], telegramChatId: String(CHAT), pollSeconds: 3600, settleSeconds: 90,
  maxSettleSeconds: 300, followUpDays: 7, contextMessages: 30, triageTimeoutSeconds: 600, scentbirdRepoPath: '/tmp', dryRun: false,
  statePath: '/tmp/ping-assistant-test/state.json', drainSeconds: 5, socketReconcileTicks: 10,
  feedbackReviewCron: { weekday: 1, hour: 9, minute: 30 }, briefing: { hour: 9, minute: 30, weekdays: [1, 2, 3, 4, 5] }, github: { defaultRepo: 'scentbird/scentbird' }, jira: { site: 'scentbird.atlassian.net' },
}

let stderr: ReturnType<typeof spyOn>
let env: Awaited<ReturnType<typeof setup>>
beforeEach(() => { stderr = spyOn(process.stderr, 'write').mockImplementation(() => true) })
afterEach(() => { env?.orch.stop(); stderr.mockRestore() })

async function setup(
  cfgOverrides: Partial<Config> = {}, state: State = emptyState(),
  realCollector?: (slack: FakeSlack, cfg: Config) => Collector,
  socket?: { isConnected(): boolean; epoch(): number; reconnect(reason: string): void; lastFrameAt(): number | undefined },
  extra: Partial<OrchestratorDeps> = {},
) {
  const cfg = { ...baseCfg, ...cfgOverrides }
  const slack = new FakeSlack()
  const api = new FakeApi()
  const tg = new TelegramBot('123:fake', String(CHAT), api)
  const collector = new FakeCollector()
  let saves = 0
  const store = { save: () => { saves++ } } as unknown as StateStore
  let clock = T0
  let channel!: Channel
  const orch = new Orchestrator({
    cfg, store, state, slack: slack as unknown as SlackClient, collector: (realCollector?.(slack, cfg) ?? collector) as never, tg,
    channel: { notify: (c: string, m: Record<string, string>) => channel.notify(c, m) } as Channel, now: () => clock, socket, ...extra,
  })
  channel = new Channel(orch.handlers())
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await channel.connect(serverSide)
  const client = new Client({ name: 'session', version: '0.0.0' })
  const notes: NoteParams[] = []
  client.setNotificationHandler(Note, (n) => { notes.push(n.params) })
  await client.connect(clientSide)
  orch.start()
  env = {
    cfg, slack, api, tg, collector, orch, client, notes, state,
    saves: () => saves,
    advance: (ms: number) => { clock += ms },
    // Notifications cross the in-memory transport asynchronously.
    flush: async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) },
    callback: (data: string, messageId: number) => tg.ingest({
      update_id: 1, callback_query: {
        id: 'cb', chat_instance: 'ci', data, from: { id: CHAT, is_bot: false, first_name: 'I' },
        message: { message_id: messageId, date: 0, chat: { id: CHAT, type: 'private' } },
      },
    } as never),
    text: (text: string, replyTo?: number) => tg.ingest({
      update_id: 2, message: {
        message_id: 999, date: 0, text, chat: { id: CHAT, type: 'private' }, from: { id: CHAT, is_bot: false, first_name: 'I' },
        ...(replyTo ? { reply_to_message: { message_id: replyTo, date: 0, chat: { id: CHAT, type: 'private' } } } : {}),
      },
    } as never),
  }
  return env
}

const threadMsg = (ts: string, text: string, user = 'U2'): SlackMsg =>
  ({ channel: 'C1', ts, threadTs: '100.000000', user, userName: `User ${user}`, text, permalink: `https://slack/C1/${ts}` })

/** Drives one Slack thread message from collection to a matured item (notified as kind=item). */
async function matureThreadItem(e: Awaited<ReturnType<typeof setup>>, text = 'Почему падает сборка?') {
  e.collector.queue.push({ msg: threadMsg('105.000000', text), source: 'channel' })
  await e.orch.tick()
  e.advance(91_000)
  await e.orch.tick()
  await e.flush()
  return e.state.items['1']!
}

async function propose(e: Awaited<ReturnType<typeof setup>>, variants: string[], mode: 'variants' | 'final' = 'variants') {
  const res = await e.client.callTool({ name: 'propose', arguments: { item_id: '1', analysis: 'Тип: технический', variants, mode } })
  expect(res.isError).toBeFalsy()
  return e.api.last()
}

const buttons = (s: { opts: Record<string, any> }): string[] =>
  (s.opts.reply_markup?.inline_keyboard ?? []).flat().map((b: { text: string }) => b.text)

test('matured item is notified to the channel as kind=item', async () => {
  const e = await setup()
  e.slack.repl['C1:100.000000'] = [
    { ts: '100.000000', user: 'U3', text: 'root' },
    { ts: '103.000000', user: 'U4', text: 'earlier reply' },
    { ts: '105.000000', user: 'U2', text: 'Почему падает сборка?' },
  ]
  e.collector.queue.push({ msg: threadMsg('105.000000', 'Почему падает сборка?'), source: 'channel' })
  await e.orch.tick()
  await e.flush()
  expect(e.notes).toEqual([]) // still settling

  e.advance(91_000)
  await e.orch.tick()
  await e.flush()
  expect(e.notes).toHaveLength(1)
  const note = e.notes[0]!
  expect(note.meta).toEqual({ kind: 'item', item_id: '1', source: 'ping-assistant' })
  const body = JSON.parse(note.content)
  expect(body).toMatchObject({
    id: '1', source: 'channel', channel: 'C1', threadTs: '100.000000', author: 'U2', authorName: 'User U2',
    messages: [{ ts: '105.000000', user: 'U2', text: 'Почему падает сборка?' }],
    permalink: 'https://slack/C1/105.000000',
  })
  expect(body.context.map((m: SlackMsg) => m.ts)).toEqual(['100.000000', '103.000000'])
  expect(e.state.items['1']!.status).toBe('triage')
  expect(e.saves()).toBeGreaterThanOrEqual(2)
})

test('propose(variants) sends telegram message with buttons and sets awaiting', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['Да, починю', 'Нет, это не моё'])
  expect(sent.text).toContain('Почему падает сборка?')
  expect(sent.text).toContain('1️⃣ Да, починю')
  expect(buttons(sent)).toEqual(['1', '2', 'Пропустить', '👎 разбор'])
  const item = e.state.items['1']!
  expect(item.status).toBe('awaiting')
  expect(item.variants).toEqual(['Да, починю', 'Нет, это не моё'])
  expect(item.telegram.messageId).toBe(sent.id)
  expect(e.tg.resolveItemId(sent.id)).toBe('1')
})

test('a thread item message carries the collapsed thread block, own replies as «Я»', async () => {
  const e = await setup()
  e.slack.repl['C1:100.000000'] = [
    { ts: '100.000000', user: 'U3', text: 'root' },
    { ts: '103.000000', user: 'ME', text: 'мой ответ' },
    { ts: '105.000000', user: 'U2', text: 'Почему падает сборка?' },
  ]
  await matureThreadItem(e)
  const sent = await propose(e, ['Да'])
  expect(sent.text).toContain('<blockquote expandable><b>Тред · 2 сообщения</b>\n')
  expect(sent.text).toContain(' Я: мой ответ')
  expect(sent.text.match(/Почему падает сборка\?/g)).toHaveLength(1)
})

test('choose sends variant verbatim to slack in thread and edits outcome', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['Первый', 'Смотри **тут** <https://x|PR>'])
  await e.callback('pa:choose:1:2', sent.id)

  expect(e.slack.posted).toEqual([{ channel: 'C1', text: slackify('Смотри **тут** <https://x|PR>'), threadTs: '100.000000' }])
  const item = e.state.items['1']!
  expect(item.status).toBe('sent')
  expect(item.sentTs).toBe('9000.000100')
  const edit = e.api.lastEdit(sent.id)!
  expect(edit.text).toContain('✅ отправлен вариант 2')
  expect(edit.text).toContain('2️⃣ Смотри *тут* &lt;https://x|PR&gt;') // escaped: shown as sent
  expect(edit.text).not.toContain('<i>Правка:')
  expect(edit.opts.reply_markup).toEqual({ inline_keyboard: [[{ text: '👎 разбор', callback_data: 'pa:bad:1' }]] }) // only 👎 outlives the item
  expect(e.api.last().text).toBe('✅ отправлено: https://slack/C1/9000.000100')
  expect(e.state.watchedThreads['C1:100.000000']!.until).toBe(T0 + 91_000 + 7 * 86_400_000)
  expect(e.state.cursors['thr:C1:100.000000']).toBe('9000.000100')
  expect(e.state.msgIndex['C1:9000.000100']).toBe('1')
})

test('item text from Slack is HTML-escaped, and the outcome edit keeps it escaped', async () => {
  const e = await setup()
  await matureThreadItem(e, 'if a &lt; b &amp;&amp; *c* <@U7>')
  e.state.users.U7 = 'Ann <QA>'
  const sent = await propose(e, ['x < y', 'b'])
  expect(sent.text).toContain('<blockquote expandable>if a &lt; b &amp;&amp; <b>c</b> @Ann &lt;QA&gt;</blockquote>')
  expect(sent.text).toContain('1️⃣ x &lt; y')
  const stored = e.state.items['1']!.telegram.text!
  expect(stored).toContain('1️⃣ x &lt; y')
  expect(stored).not.toContain('<i>Правка:')
  await e.callback('pa:choose:1:1', sent.id)
  expect(e.slack.posted).toEqual([{ channel: 'C1', text: 'x < y', threadTs: '100.000000' }])
  expect(e.api.lastEdit(sent.id)!.text).toBe(`${stored}\n\n✅ отправлен вариант 1`)
})

test('choose validates the variant number, unknown and closed items', async () => {
  const e = await setup()
  await matureThreadItem(e)
  await propose(e, ['a', 'b'])
  await e.text('1 3')
  expect(e.api.last().text).toBe('Нет варианта 3 у #1')
  await e.text('7 1')
  expect(e.api.last().text).toBe('Не знаю айтем #7')
  await e.text('1 пропустить')
  await e.text('1 1')
  expect(e.api.last().text).toBe('#1 уже закрыт: ⏭ пропущен')
  expect(e.slack.posted).toEqual([])
})

test('choose with new foreign messages after lastSeenTs asks force instead of sending', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  e.slack.repl['C1:100.000000'] = [
    { ts: '105.000000', user: 'U2', text: 'Почему падает сборка?' },
    { ts: '107.000000', user: 'U9', bot_id: 'B1', text: 'bot noise' },
    { ts: '108.000000', user: 'U5', text: 'Уже починил' },
  ]
  await e.callback('pa:choose:1:1', sent.id)

  expect(e.slack.posted).toEqual([])
  const warn = e.api.last()
  expect(warn.text).toContain('в треде появилось новое')
  expect(warn.text).toContain('Уже починил')
  expect(warn.text).not.toContain('bot noise')
  expect(warn.opts.reply_parameters).toEqual({ message_id: sent.id })
  expect(buttons(warn)).toEqual(['Всё равно отправить', 'Отмена'])
  expect(e.tg.resolveItemId(warn.id)).toBe('1')
  expect(e.state.items['1']!.pendingText).toBe('a')
  expect(e.state.items['1']!.status).toBe('awaiting')
})

test('force sends despite new messages', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  e.slack.repl['C1:100.000000'] = [{ ts: '108.000000', user: 'U5', text: 'Уже починил' }]
  await e.callback('pa:choose:1:2', sent.id)
  const warn = e.api.last()
  await e.callback('pa:force:1', warn.id)

  expect(e.slack.posted).toEqual([{ channel: 'C1', text: 'b', threadTs: '100.000000' }])
  expect(e.state.items['1']!.status).toBe('sent')
  expect(e.state.items['1']!.pendingText).toBeUndefined()
})

test('forward with "2, но без тикета" notifies channel kind=revise with current variants', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b с тикетом'])
  e.notes.length = 0
  await e.text('2, но без тикета', sent.id) // quote-reply resolves the item
  await e.text('как дела?')
  await e.flush()

  expect(e.notes[0]).toEqual({
    content: JSON.stringify({ id: '1', request: '2, но без тикета', variants: ['a', 'b с тикетом'], analysis: 'Тип: технический' }),
    meta: { kind: 'revise', item_id: '1', source: 'ping-assistant' },
  })
  expect(e.notes[1]).toEqual({ content: JSON.stringify({ text: 'как дела?', recent_chat: [] }), meta: { kind: 'chat', source: 'ping-assistant' } })
  expect(e.slack.posted).toEqual([])
})

test('propose(final) after revise sends proposal with Отправить/Отмена; confirm sends pendingText', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const original = await propose(e, ['a', 'b с тикетом'])
  const proposal = await propose(e, ['b **без** тикета'], 'final')

  const shown = slackify('b **без** тикета')
  expect(proposal.text).toContain(shown)
  expect(buttons(proposal)).toEqual(['Отправить', 'Отмена'])
  expect(proposal.opts.reply_parameters).toEqual({ message_id: original.id })
  const marked = e.api.lastEdit(original.id)!
  expect(marked.text).toContain('✏️ правка ниже')
  expect(marked.opts.reply_markup).toEqual({ inline_keyboard: [[{ text: '👎 разбор', callback_data: 'pa:bad:1' }]] })
  expect(e.state.items['1']!.pendingText).toBe(shown)

  await e.text('1 да')
  expect(e.slack.posted).toEqual([{ channel: 'C1', text: shown, threadTs: '100.000000' }])
  expect(e.api.lastEdit(proposal.id)!.text).toContain('✅ отправлено')
})

test('cancel on a proposal restores the original buttons and sends nothing', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const original = await propose(e, ['a', 'b'])
  const proposal = await propose(e, ['b2'], 'final')
  await e.callback('pa:cancel:1', proposal.id)

  expect(e.api.lastEdit(proposal.id)!.text).toContain('❌ отменено')
  expect(buttons(e.api.lastEdit(original.id)!)).toEqual(['1', '2', 'Пропустить', '👎 разбор'])
  expect(e.state.items['1']!.pendingText).toBeUndefined()
  expect(e.slack.posted).toEqual([])
})

test('skip closes item and edits outcome, nothing posted', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  await e.callback('pa:skip:1', sent.id)

  expect(e.state.items['1']!.status).toBe('skipped')
  const edit = e.api.lastEdit(sent.id)!
  expect(edit.text).toContain('⏭ пропущен')
  expect(edit.opts.reply_markup).toEqual({ inline_keyboard: [[{ text: '👎 разбор', callback_data: 'pa:bad:1' }]] })
  expect(e.slack.posted).toEqual([])
})

test('dryRun never calls postMessage', async () => {
  const e = await setup({ dryRun: true })
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  await e.callback('pa:choose:1:1', sent.id)
  await e.text('1: свой текст')

  expect(e.slack.posted).toEqual([])
  expect(e.api.sent.some((s) => s.text === '🧪 dry-run, отправил бы в https://slack/C1/105.000000:\na')).toBe(true)
  expect(e.state.items['1']!.status).toBe('sent')
  expect(e.state.items['1']!.sentTs).toBe('dry-run')
  expect(e.api.lastEdit(sent.id)!.text).toContain('✅ отправлен вариант 1')
})

test('own slack reply marks item answered_manually and edits outcome', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  e.collector.queue.push({ msg: threadMsg('110.000000', 'ответил сам', 'ME'), source: 'channel' })
  await e.orch.tick()

  expect(e.state.items['1']!.status).toBe('answered_manually')
  expect(e.api.lastEdit(sent.id)!.text).toContain('🙈 отвечено вручную')
  expect(e.slack.posted).toEqual([])
})

test('appended message is quoted in telegram and notified as kind=update', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  e.notes.length = 0
  e.collector.queue.push({ msg: threadMsg('111.000000', 'и ещё вопрос'), source: 'channel' })
  await e.orch.tick()
  await e.flush()

  const upd = e.api.last()
  expect(upd.text).toContain('<b>#1 · дополнение</b>')
  expect(upd.opts.reply_parameters).toEqual({ message_id: sent.id })
  expect(e.notes).toHaveLength(1)
  expect(e.notes[0]!.meta).toEqual({ kind: 'update', item_id: '1', source: 'ping-assistant' })
  expect(JSON.parse(e.notes[0]!.content)).toMatchObject({ id: '1', newMessages: [{ ts: '111.000000', text: 'и ещё вопрос' }] })
})

test('say goes to Telegram as plain text, with no parse_mode', async () => {
  const e = await setup()
  const res = await e.client.callTool({ name: 'say', arguments: { text: 'if a < b && c > d' } })
  expect(res.isError).toBeFalsy()
  expect(e.api.last().text).toBe('if a < b && c > d')
  expect(e.api.last().opts.parse_mode).toBeUndefined()
})

test('say with format html goes out with parse_mode HTML; format text is plain', async () => {
  const e = await setup()
  const html = '☀️ <b>Брифинг 21.10</b>\n<a href="https://slack/C1/1.0">#1</a> a &amp; b'
  expect((await e.client.callTool({ name: 'say', arguments: { text: html, format: 'html' } })).isError).toBeFalsy()
  expect(e.api.last().text).toBe(html)
  expect(e.api.last().opts.parse_mode).toBe('HTML')
  await e.client.callTool({ name: 'say', arguments: { text: '<b>x</b>', format: 'text' } })
  expect(e.api.last().text).toBe('<b>x</b>')
  expect(e.api.last().opts.parse_mode).toBeUndefined()
})

test('say html that Telegram cannot parse is resent once with the tags stripped', async () => {
  const e = await setup()
  const real = e.api.sendMessage.bind(e.api)
  let rejected = 0
  e.api.sendMessage = async (chat, text, opts = {}) => {
    if (opts.parse_mode === 'HTML') { rejected++; throw new Error("Bad Request: can't parse entities: Unsupported start tag") }
    return real(chat, text, opts)
  }
  const res = await e.client.callTool({ name: 'say', arguments: { text: '<b>Ждут тебя</b> <foo>a</foo> &lt; b', format: 'html' } })
  expect(res.isError).toBeFalsy()
  expect(rejected).toBe(1)
  expect(e.api.sent).toHaveLength(1)
  expect(e.api.last().text).toBe('Ждут тебя a < b')
  expect(e.api.last().opts.parse_mode).toBeUndefined()
})

test('item messages and outcome edits go out with parse_mode HTML', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  expect(sent.opts.parse_mode).toBe('HTML')
  await e.callback('pa:skip:1', sent.id)
  expect(e.api.lastEdit(sent.id)!.opts.parse_mode).toBe('HTML')
})

test('ignore, list_items and list_ignored', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const res = await e.client.callTool({ name: 'ignore', arguments: { item_id: '1', reason: 'благодарность без вопроса' } })
  expect(res.isError).toBeFalsy()
  expect(e.state.items['1']!.status).toBe('ignored')
  expect(e.api.sent).toEqual([])

  const text = async (name: string, args: Record<string, unknown> = {}) =>
    ((await e.client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text
  e.state.channels.C1 = 'pathfinders'
  expect(await text('list_items')).toBe('#1 [ignored] #pathfinders User U2: Почему падает сборка?')
  expect(await text('list_ignored')).toBe('#1 #pathfinders User U2 — благодарность без вопроса')
  e.advance(25 * 3_600_000)
  expect(await text('list_ignored')).toBe('ничего не проигнорировано')
})

test('start re-registers telegram message ids from state', async () => {
  const state = emptyState()
  state.items['5'] = {
    id: '5', seq: 5, sub: 0, status: 'awaiting', source: 'im', channel: 'D1', author: 'U2', messages: [], context: [],
    lastSeenTs: '1.0', createdAt: T0, lastMessageAt: T0, telegram: { messageId: 77, proposalMessageId: 78 },
  }
  const e = await setup({}, state)
  expect(e.tg.resolveItemId(77)).toBe('5')
  expect(e.tg.resolveItemId(78)).toBe('5')
})

test('channel never receives a slack-send tool', async () => {
  const e = await setup()
  const { tools } = await e.client.listTools()
  expect(tools.length).toBeGreaterThan(0)
  expect(tools.filter((t) => /send|post|slack/i.test(t.name))).toEqual([])
})

test('«N да» after a thread-changed warning sends the held text without re-checking', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  e.slack.repl['C1:100.000000'] = [{ ts: '108.000000', user: 'U5', text: 'Уже починил' }]
  await e.callback('pa:choose:1:2', sent.id)
  expect(e.state.items['1']!.forceSend).toBe(true)
  await e.text('1 да')

  expect(e.slack.posted).toEqual([{ channel: 'C1', text: 'b', threadTs: '100.000000' }])
  const item = e.state.items['1']!
  expect(item.status).toBe('sent')
  expect(item.forceSend).toBeUndefined()
  expect(e.api.lastEdit(sent.id)!.text).toContain('✅ отправлен вариант 2')
})

test('cancel on a thread-changed warning clears the held text and force flag', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  e.slack.repl['C1:100.000000'] = [{ ts: '108.000000', user: 'U5', text: 'Уже починил' }]
  await e.callback('pa:choose:1:1', sent.id)
  const warning = e.api.last()
  await e.callback('pa:cancel:1', warning.id)

  // The warning keeps what it said; only its buttons go.
  const edit = e.api.lastEdit(warning.id)!
  expect(edit.text).toBe(`${warning.text}\n\n❌ отменено`)
  expect(edit.text).toContain('Уже починил')
  expect(edit.opts.reply_markup).toEqual({ inline_keyboard: [] })
  const item = e.state.items['1']!
  expect(item.pendingText).toBeUndefined()
  expect(item.forceSend).toBeUndefined()
  expect(item.status).toBe('awaiting')
  expect(e.slack.posted).toEqual([])
})

test('a failed thread check holds the text and asks to force instead of sending', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  e.slack.failReplies = true
  await e.callback('pa:choose:1:1', sent.id)

  expect(e.slack.posted).toEqual([])
  const warn = e.api.last()
  expect(warn.text).toBe('⚠️ не смог проверить тред #1 (TypeError), нажми «Всё равно отправить» или повтори')
  expect(buttons(warn)).toEqual(['Всё равно отправить', 'Отмена'])
  expect(warn.opts.reply_parameters).toEqual({ message_id: sent.id })
  expect(e.state.items['1']!.pendingText).toBe('a')
  expect(e.state.items['1']!.forceSend).toBe(true)

  await e.callback('pa:force:1', warn.id)
  expect(e.slack.posted).toEqual([{ channel: 'C1', text: 'a', threadTs: '100.000000' }])
  expect(e.api.lastEdit(sent.id)!.text).toContain('✅ отправлен вариант 1')
})

test('propose leaves the item untouched when the telegram send fails', async () => {
  const e = await setup()
  await matureThreadItem(e)
  e.api.failNextSend = true
  const first = await e.client.callTool({ name: 'propose', arguments: { item_id: '1', analysis: 'x', variants: ['a'], mode: 'variants' } })
  expect(first.isError).toBe(true)
  expect((first.content as { text: string }[])[0]!.text).toContain('Telegram')
  let item = e.state.items['1']!
  expect(item.status).toBe('triage')
  expect(item.variants).toBeUndefined()
  expect(item.telegram).toEqual({})

  const sent = await propose(e, ['a', 'b'])
  e.api.failNextSend = true
  expect((await e.client.callTool({ name: 'propose', arguments: { item_id: '1', analysis: 'y', variants: ['c'], mode: 'variants' } })).isError).toBe(true)
  e.api.failNextSend = true
  expect((await e.client.callTool({ name: 'propose', arguments: { item_id: '1', analysis: 'y', variants: ['c'], mode: 'final' } })).isError).toBe(true)

  item = e.state.items['1']!
  expect(item.variants).toEqual(['a', 'b'])
  expect(item.analysis).toBe('Тип: технический')
  expect(item.pendingText).toBeUndefined()
  expect(item.telegram.messageId).toBe(sent.id)
  expect(item.telegram.proposalMessageId).toBeUndefined()
  expect(e.api.lastEdit(sent.id)).toBeUndefined() // old buttons still live
})

test('re-propose marks the previous message «✏️ правка ниже»', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const first = await propose(e, ['a', 'b'])
  const second = await propose(e, ['c', 'd'])
  expect(e.api.lastEdit(first.id)!.text).toEndWith('✏️ правка ниже')
  expect(second.opts.reply_parameters).toEqual({ message_id: first.id })
  expect(e.tg.resolveItemId(second.id)).toBe('1')
})

test('top-level DM item gets recent history before it as context', async () => {
  const e = await setup({ contextMessages: 2 })
  e.state.users.U2 = 'User U2'
  e.slack.hist.D1 = [
    { ts: '90.000000', user: 'U2', text: 'too old' },
    { ts: '95.000000', user: 'ME', text: 'мой вопрос' },
    { ts: '99.000000', user: 'U2', text: 'контекст' },
    { ts: '105.000000', user: 'U2', text: 'сам вопрос' },
  ]
  e.collector.queue.push({ msg: { channel: 'D1', ts: '105.000000', user: 'U2', text: 'сам вопрос' }, source: 'im' })
  await e.orch.tick()
  e.advance(91_000)
  await e.orch.tick()
  await e.flush()

  expect(e.slack.recentCalls).toEqual([{ channel: 'D1', latest: '105.000000', limit: 2 }])
  const body = JSON.parse(e.notes[0]!.content)
  expect(body.context).toEqual([
    { ts: '95.000000', user: 'ME', text: 'мой вопрос' },
    { ts: '99.000000', user: 'U2', userName: 'User U2', text: 'контекст' },
  ])
})

test('reply in a thread ping-assistant answered in creates item 1.1 with full thread context and is notified', async () => {
  const ts = (sec: number) => `${T0 / 1000 + sec}.000000`
  const root = ts(-60)
  const state = emptyState()
  state.cursors = { lastTick: ts(-100), 'hist:C1': ts(-55), search: ts(-100), [`thr:C1:${root}`]: root }
  const e = await setup({}, state, (slack, cfg) => new Collector(slack as never, cfg, state, '/tmp/ping-assistant-test/files'))
  const mine = ts(10)
  e.slack.postMessage = async (channel, text, threadTs) => { e.slack.posted.push({ channel, text, ...(threadTs ? { threadTs } : {}) }); return { ts: mine } }
  const raw = (t: string, user: string, text: string) => ({ ts: t, thread_ts: root, user, text })
  e.slack.repl[`C1:${root}`] = [raw(root, 'U3', 'root'), raw(ts(-30), 'U2', 'Почему падает сборка?')]
  const rootMsg = { ...raw(root, 'U3', 'root'), latest_reply: ts(-30) }
  e.slack.hist.C1 = [rootMsg] // the windowed history shows which threads moved

  await e.orch.tick() // collects the question
  e.advance(91_000)
  await e.orch.tick() // matures it
  await e.flush()
  expect(e.notes.map((n) => n.meta.item_id)).toEqual(['1'])
  await propose(e, ['Починю сегодня'])
  const saved = await e.client.callTool({ name: 'remember_thread', arguments: { item_id: '1', agreements: 'Договорённости: Илья чинит сегодня' } })
  expect(saved.isError).toBeFalsy()
  expect(e.state.threads[`C1:${root}`]).toEqual({ agreements: 'Договорённости: Илья чинит сегодня', updatedAt: T0 + 91_000, itemId: '1' })
  await e.callback('pa:choose:1:1', e.api.last().id)
  expect(e.slack.posted).toHaveLength(1)
  expect(e.state.items['1']!.status).toBe('sent')

  // The thread now holds our message and a foreign reply to it.
  const reply = ts(500)
  e.slack.repl[`C1:${root}`]!.push(raw(mine, 'ME', 'Починю сегодня'), raw(reply, 'U4', 'Спасибо, а когда?'))
  rootMsg.latest_reply = reply
  e.advance(60_000)
  await e.orch.tick()
  const followup = e.state.items['1.1']!
  expect(followup).toMatchObject({ id: '1.1', seq: 1, sub: 1, source: 'followup', status: 'settling', author: 'U4' })
  expect(e.slack.posted).toHaveLength(1) // nothing is sent on its own

  e.advance(91_000)
  await e.orch.tick()
  await e.flush()
  expect(followup.status).toBe('triage')
  expect(e.notes.map((n) => [n.meta.kind, n.meta.item_id])).toEqual([['item', '1'], ['item', '1.1']])
  const body = JSON.parse(e.notes[1]!.content)
  expect(body).toMatchObject({ id: '1.1', source: 'followup', threadTs: root, messages: [{ ts: reply, text: 'Спасибо, а когда?' }] })
  expect(body.context.map((m: SlackMsg) => [m.ts, m.text])).toEqual([[root, 'root'], [ts(-30), 'Почему падает сборка?'], [mine, 'Починю сегодня']])
  expect(body.thread).toMatchObject({ messages: 4, my_messages: 1, prior_items: [{ id: '1', status: 'sent', sentTs: e.state.items['1']!.sentTs, chosen: 1 }] })
  expect(body.thread.agreements).toEqual({ text: 'Договорённости: Илья чинит сегодня', updated_at: new Date(T0 + 91_000).toISOString(), item_id: '1' })
})

test('a stale choose button from a superseded item message posts nothing', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const first = await propose(e, ['old a', 'old b'])
  await propose(e, ['new a', 'new b'])
  await e.callback('pa:choose:1:2', first.id)

  expect(e.slack.posted).toEqual([])
  expect(e.api.last().text).toBe('Кнопка устарела, см. #1 ниже')
  expect(e.state.items['1']!.status).toBe('awaiting')
  await e.text('1 2') // the text command acts on the current variants
  expect(e.slack.posted).toEqual([{ channel: 'C1', text: 'new b', threadTs: '100.000000' }])
})

test('a stale proposal tap posts nothing; the new proposal confirms its own text', async () => {
  const e = await setup()
  await matureThreadItem(e)
  await propose(e, ['a', 'b'])
  const p1 = await propose(e, ['первая правка'], 'final')
  const p2 = await propose(e, ['вторая правка'], 'final')
  expect(e.api.dropped).toContain(p1.id) // old proposal lost its buttons

  await e.callback('pa:confirm:1', p1.id)
  expect(e.slack.posted).toEqual([])
  expect(e.api.last().text).toBe('Кнопка устарела, см. #1 ниже')
  expect(e.state.items['1']!.pendingText).toBe('вторая правка')

  await e.callback('pa:cancel:1', p1.id)
  expect(e.state.items['1']!.pendingText).toBe('вторая правка') // stale cancel changes nothing

  await e.callback('pa:confirm:1', p2.id)
  expect(e.slack.posted).toEqual([{ channel: 'C1', text: 'вторая правка', threadTs: '100.000000' }])
})

test('a stale force button from an older warning posts nothing; a live warning supersedes the proposal', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  e.slack.repl['C1:100.000000'] = [{ ts: '108.000000', user: 'U5', text: 'Уже починил' }]
  await e.callback('pa:choose:1:1', sent.id)
  const w1 = e.api.last()
  await e.callback('pa:choose:1:2', sent.id)
  const w2 = e.api.last()
  expect(e.api.dropped).toContain(w1.id)
  expect(e.state.items['1']!.telegram.warningMessageId).toBe(w2.id)

  await e.callback('pa:force:1', w1.id)
  expect(e.slack.posted).toEqual([])
  expect(e.api.last().text).toBe('Кнопка устарела, см. #1 ниже')

  // A proposal whose confirm raised a warning can no longer confirm: only the warning decides.
  const p = await propose(e, ['правка'], 'final')
  await e.callback('pa:confirm:1', p.id)
  const w3 = e.api.last()
  expect(w3.text).toContain('в треде появилось новое')
  expect(e.api.dropped).toContain(p.id)
  await e.callback('pa:confirm:1', p.id)
  expect(e.api.last().text).toBe('Кнопка устарела, см. #1 ниже')
  expect(e.slack.posted).toEqual([])

  await e.callback('pa:force:1', w3.id)
  expect(e.slack.posted).toEqual([{ channel: 'C1', text: 'правка', threadTs: '100.000000' }])
  expect(e.api.lastEdit(p.id)!.text).toContain('✅ отправлено')
  expect(e.api.dropped).toContain(w3.id)
})

test('a long (>4096) item: revision leaves no live old buttons and the outcome edit succeeds', async () => {
  const e = await setup()
  await matureThreadItem(e, "Длинный вопрос. ".repeat(400)) // ~6400 chars: the quote is capped
  const long = 'Длинный вариант. '.repeat(200) // ~3400 chars: with the quote, several Telegram messages
  const sendsBefore = e.api.sent.length
  const first = await propose(e, [long, 'b'])
  expect(e.api.sent.length - sendsBefore).toBeGreaterThan(1)
  expect(e.api.sent.at(-2)!.text).toContain('…</blockquote>')
  expect(buttons(first)).toEqual(['1', '2', 'Пропустить', '👎 разбор'])
  expect(e.state.items['1']!.telegram.text!.length).toBeLessThanOrEqual(4096)

  const second = await propose(e, [long, 'd'])
  const revised = e.api.lastEdit(first.id)!
  expect(revised.text).toEndWith('✏️ правка ниже')
  expect(revised.opts.reply_markup).toEqual({ inline_keyboard: [[{ text: '👎 разбор', callback_data: 'pa:bad:1' }]] }) // no live send buttons; 👎 is harmless

  await e.callback('pa:choose:1:2', second.id)
  expect(e.slack.posted).toEqual([{ channel: 'C1', text: 'd', threadTs: '100.000000' }])
  const done = e.api.lastEdit(second.id)!
  expect(done.text).toEndWith('✅ отправлен вариант 2')
  expect(done.opts.reply_markup).toEqual({ inline_keyboard: [[{ text: '👎 разбор', callback_data: 'pa:bad:1' }]] })
})

test('a tick that fails mid-ingest commits no cursors, and a restart replays the lost message', async () => {
  const sec = (s: number) => `${T0 / 1000 + s}.000000`
  const seed = () => {
    const st = emptyState()
    st.cursors = { lastTick: sec(-100), 'hist:D1': sec(-100), 'hist:D2': sec(-100), 'hist:C1': sec(-100), search: sec(-100) }
    return st
  }
  const fill = (slack: FakeSlack) => {
    slack.listDms = async () => [{ id: 'D1', type: 'im' as const }, { id: 'D2', type: 'im' as const }] as never
    slack.hist = { D1: [{ ts: sec(-50), user: 'U2', text: 'первый' }], D2: [{ ts: sec(-40), user: 'U3', text: 'второй' }] }
  }
  const state = seed()
  const real = (st: State) => (slack: FakeSlack, cfg: Config) => { fill(slack); return new Collector(slack as never, cfg, st, '/tmp/ping-assistant-test/files') }
  const e = await setup({}, state, real(state))
  const before = structuredClone(state.cursors)
  let calls = 0
  const orig = items.ingest
  const spy = spyOn(items, 'ingest').mockImplementation((...a: Parameters<typeof orig>) => {
    if (++calls === 2) throw new Error('disk full')
    return orig(...a)
  })
  let savedMidTick: State | undefined
  e.slack.channelName = async (id: string) => { savedMidTick ??= structuredClone(state); return `name-${id}` }
  try {
    await e.orch.tick()
  } finally {
    spy.mockRestore()
  }
  expect(state.cursors).toEqual(before) // nothing committed
  expect(savedMidTick!.cursors).toEqual(before) // a save racing the tick holds the old cursors too
  expect(Object.values(state.items).map((i) => i.messages[0]!.text)).toEqual(['первый'])

  // Restart from the persisted state: the second message is collected again, the first is deduped.
  e.orch.stop()
  const restarted = structuredClone(state)
  const e2 = await setup({}, restarted, real(restarted))
  await e2.orch.tick()
  expect(Object.values(restarted.items).map((i) => i.messages[0]!.text)).toEqual(['первый', 'второй'])
  expect(restarted.cursors['hist:D2']).toBe(sec(-40))
  expect(restarted.cursors.lastTick).toBe(`${T0 / 1000}.000000`)
})

test('idle() waits for the in-flight tick', async () => {
  const e = await setup()
  let release!: () => void
  e.collector.tick = () => new Promise<TickResult>((r) => { release = () => r({ collected: [], cursorUpdates: { lastTick: '5.0' }, removeCursors: [] }) })
  const ticking = e.orch.tick()
  let idle = false
  const waiting = e.orch.idle().then(() => { idle = true })
  await e.flush()
  expect(idle).toBe(false)
  release()
  await ticking
  await waiting
  expect(idle).toBe(true)
  expect(e.state.cursors.lastTick).toBe('5.0')
})

test('start re-delivers items left in triage by a previous session', async () => {
  const state = emptyState()
  state.items['5'] = {
    id: '5', seq: 5, sub: 0, status: 'triage', source: 'im', channel: 'D1', author: 'U2',
    messages: [{ channel: 'D1', ts: '105.000000', user: 'U2', text: 'вопрос' }], context: [],
    lastSeenTs: '105.000000', createdAt: T0 - 3_600_000, lastMessageAt: T0 - 3_600_000, triageAt: T0 - 3_000_000,
    telegram: { triageAlerted: true },
  }
  const e = await setup({}, state)
  expect(state.items['5']!.status).toBe('settling')
  e.advance(1_000)
  await e.orch.tick()
  await e.flush()
  expect(e.notes.map((n) => [n.meta.kind, n.meta.item_id])).toEqual([['item', '5']])
  expect(state.items['5']!.status).toBe('triage')
  expect(state.items['5']!.triageAt).toBe(T0 + 1_000)
  expect(state.items['5']!.telegram.triageAlerted).toBeUndefined()
})

test('an item stuck in triage gets one reminder with Пропустить and is re-notified to the session', async () => {
  const e = await setup()
  await matureThreadItem(e)
  e.notes.length = 0
  e.advance(599_000)
  await e.orch.tick()
  expect(e.api.sent).toEqual([])

  e.advance(1_000)
  await e.orch.tick()
  await e.flush()
  const alert = e.api.last()
  expect(alert.text).toBe('⏳ #1 без разбора уже 10 мин')
  expect(buttons(alert)).toEqual(['Пропустить'])
  expect(e.notes.map((n) => [n.meta.kind, n.meta.item_id])).toEqual([['item', '1']])

  e.advance(600_000)
  await e.orch.tick()
  await e.flush()
  expect(e.api.sent).toHaveLength(1) // once per triage
  expect(e.notes).toHaveLength(1)

  await e.callback('pa:skip:1', alert.id)
  expect(e.state.items['1']!.status).toBe('skipped')
  expect(e.api.lastEdit(alert.id)!.text).toBe('⏳ #1 без разбора уже 10 мин\n\n⏭ пропущен')
  expect(e.slack.posted).toEqual([])
})

test('propose after a triage reminder replies to it and retires it', async () => {
  const e = await setup()
  await matureThreadItem(e)
  e.advance(600_000)
  await e.orch.tick()
  const alert = e.api.last()
  const sent = await propose(e, ['a', 'b'])
  expect(sent.opts.reply_parameters).toEqual({ message_id: alert.id })
  expect(e.api.lastEdit(alert.id)!.opts.reply_markup).toEqual({ inline_keyboard: [] })
  await e.callback('pa:choose:1:1', sent.id)
  expect(e.slack.posted).toEqual([{ channel: 'C1', text: 'a', threadTs: '100.000000' }])
})

test('own reply in the thread found by the pre-send check closes the item instead of sending', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  e.slack.repl['C1:100.000000'] = [{ ts: '106.000000', user: 'ME', text: 'ответил руками' }, { ts: '107.000000', user: 'U5', text: 'спасибо' }]
  await e.callback('pa:choose:1:1', sent.id)

  expect(e.slack.posted).toEqual([])
  expect(e.state.items['1']!.status).toBe('answered_manually')
  expect(e.api.lastEdit(sent.id)!.text).toEndWith('🙈 отвечено вручную')
  expect(e.api.lastEdit(sent.id)!.opts.reply_markup).toEqual({ inline_keyboard: [[{ text: '👎 разбор', callback_data: 'pa:bad:1' }]] })
  expect(e.api.last().text).toBe('🙈 #1 — ты уже ответил в треде')
})

const channelTop = (ts: string, user: string, text: string, threadTs?: string): SlackMsg =>
  ({ channel: 'C1', ts, user, userName: `User ${user}`, text, ...(threadTs ? { threadTs } : {}) })

test('own thread reply under a top-level channel question closes it; own top-level message closes nothing', async () => {
  const e = await setup()
  e.collector.queue.push({ msg: channelTop('200.000000', 'U2', 'Кто знает, почему CI красный?'), source: 'channel' })
  e.collector.queue.push({ msg: channelTop('201.000000', 'U3', 'А где доки по деплою?'), source: 'channel' })
  await e.orch.tick()
  e.collector.queue.push({ msg: channelTop('202.000000', 'ME', 'Всем привет, я сегодня на созвонах'), source: 'channel' })
  await e.orch.tick()
  expect(Object.values(e.state.items).map((i) => i.status)).toEqual(['settling', 'settling'])

  e.collector.queue.push({ msg: channelTop('203.000000', 'ME', 'Смотрю', '200.000000'), source: 'channel' })
  await e.orch.tick()
  expect(e.state.items['1']!.status).toBe('answered_manually')
  expect(e.state.items['2']!.status).toBe('settling')
})

test('own top-level message in an IM closes that IM\'s items; in an MPIM it does not', async () => {
  const e = await setup()
  const dm = (channel: string, ts: string, user: string): SlackMsg => ({ channel, ts, user, text: `${user} ${ts}` })
  e.collector.queue.push({ msg: dm('D1', '300.000000', 'U2'), source: 'im' }, { msg: dm('G1', '300.000000', 'U2'), source: 'mpim' })
  await e.orch.tick()
  e.collector.queue.push({ msg: dm('D1', '301.000000', 'ME'), source: 'im' }, { msg: dm('G1', '301.000000', 'ME'), source: 'mpim' })
  await e.orch.tick()
  expect(e.state.items['1']).toMatchObject({ channel: 'D1', status: 'answered_manually' })
  expect(e.state.items['2']).toMatchObject({ channel: 'G1', status: 'settling' })
})

test('an addendum during triage joins the item: session gets kind=update, Telegram gets nothing', async () => {
  const e = await setup()
  await matureThreadItem(e)
  e.notes.length = 0
  e.collector.queue.push({ msg: threadMsg('111.000000', 'и ещё: на ветке main'), source: 'channel' })
  await e.orch.tick()
  await e.flush()

  expect(Object.keys(e.state.items)).toEqual(['1'])
  expect(e.state.items['1']!.messages.map((m) => m.ts)).toEqual(['105.000000', '111.000000'])
  expect(e.state.items['1']!.status).toBe('triage')
  expect(e.notes.map((n) => n.meta)).toEqual([{ kind: 'update', item_id: '1', source: 'ping-assistant' }])
  expect(e.api.sent).toEqual([])
})

test('a failed postMessage leaves the item awaiting, unwatched, and says so', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  e.slack.postMessage = async () => { throw new Error('slack chat.postMessage: not_in_channel') }
  await e.callback('pa:choose:1:1', sent.id)

  const item = e.state.items['1']!
  expect(item.status).toBe('awaiting')
  expect(item.sentTs).toBeUndefined()
  expect(e.state.watchedThreads).toEqual({})
  expect(e.api.last().text).toBe('#1: не удалось отправить в Slack (slack chat.postMessage: not_in_channel)')
  expect(e.api.lastEdit(sent.id)).toBeUndefined() // buttons still live: Ilya can retry
})

test('a top-level IM item is answered as a plain message: no thread, no watch', async () => {
  const e = await setup()
  e.collector.queue.push({ msg: { channel: 'D1', ts: '105.000000', user: 'U2', text: 'Есть минутка?' }, source: 'im' })
  await e.orch.tick()
  e.advance(91_000)
  await e.orch.tick()
  await e.flush()
  const sent = await propose(e, ['Да, звони'])
  await e.callback('pa:choose:1:1', sent.id)

  expect(e.slack.posted).toEqual([{ channel: 'D1', text: 'Да, звони' }])
  expect(e.state.items['1']!.status).toBe('sent')
  expect(e.state.items['1']!.threadTs).toBeUndefined()
  expect(e.state.watchedThreads).toEqual({})
  expect(Object.keys(e.state.cursors).filter((k) => k.startsWith('thr:'))).toEqual([])
})

test('our own send for one item in a thread does not close a sibling item as answered manually', async () => {
  const e = await setup()
  e.collector.queue.push({ msg: threadMsg('105.000000', 'Вопрос A', 'U2'), source: 'channel' })
  e.collector.queue.push({ msg: threadMsg('106.000000', 'Вопрос B', 'U3'), source: 'channel' })
  await e.orch.tick()
  e.advance(91_000)
  await e.orch.tick()
  const show = async (id: string, v: string) => {
    expect((await e.client.callTool({ name: 'propose', arguments: { item_id: id, analysis: 'x', variants: [v], mode: 'variants' } })).isError).toBeFalsy()
    return e.api.last()
  }
  const a = await show('1', 'Ответ A')
  const b = await show('2', 'Ответ B')
  e.slack.repl['C1:100.000000'] = []
  await e.callback('pa:choose:1:1', a.id)
  expect(e.state.items['1']!.status).toBe('sent')
  // Slack now shows our reply (posted with Ilya's token) in the thread.
  e.slack.repl['C1:100.000000'] = [{ ts: '9000.000100', thread_ts: '100.000000', user: 'ME', text: 'Ответ A' }]

  await e.callback('pa:choose:2:1', b.id)
  expect(e.state.items['2']!.status).toBe('sent')
  expect(e.slack.posted.map((p) => p.text)).toEqual(['Ответ A', 'Ответ B'])
  expect(e.api.sent.some((s) => s.text.includes('ты уже ответил'))).toBe(false)
})

const selfDmMsg = (ts: string, text: string): SlackMsg =>
  ({ channel: 'D9', ts, user: 'ME', userName: 'Me', text, permalink: `https://slack/D9/${ts}` })

test('selfDmTest: self-DM item goes through choose to a dry-run send, nothing posted', async () => {
  const st = emptyState()
  st.selfDmChannel = 'D9'
  const e = await setup({ dryRun: true, selfDmTest: true }, st)
  e.collector.queue.push({ msg: selfDmMsg('105.000000', 'Тестовый вопрос?'), source: 'im' })
  await e.orch.tick()
  e.advance(91_000)
  await e.orch.tick()
  await e.flush()
  expect(e.state.items['1']!.status).toBe('triage')
  const sent = await propose(e, ['a', 'b'])
  await e.callback('pa:choose:1:1', sent.id)

  expect(e.slack.posted).toEqual([])
  expect(e.state.items['1']!.status).toBe('sent')
  expect(e.state.items['1']!.sentTs).toBe('dry-run')
  expect(e.api.sent.some((s) => s.text.startsWith('🧪 dry-run, отправил бы'))).toBe(true)
})

test('selfDmTest: a new own self-DM message counts as foreign in the pre-send check, not as a manual answer', async () => {
  const st = emptyState()
  st.selfDmChannel = 'D9'
  const e = await setup({ dryRun: true, selfDmTest: true }, st)
  e.collector.queue.push({ msg: selfDmMsg('105.000000', 'Тестовый вопрос?'), source: 'im' })
  await e.orch.tick()
  e.advance(91_000)
  await e.orch.tick()
  await e.flush()
  const sent = await propose(e, ['a', 'b'])
  e.slack.hist.D9 = [{ ts: '110.000000', user: 'ME', text: 'ещё одно' }]
  await e.callback('pa:choose:1:1', sent.id)

  expect(e.state.items['1']!.status).not.toBe('answered_manually')
  expect(e.state.items['1']!.status).not.toBe('sent')
})

test('socket mode: an enqueued DM becomes an item and, after the settle window, a kind:item notification without any history read', async () => {
  const ts = (sec: number) => `${T0 / 1000 + sec}.000000`
  const state = emptyState()
  let collector!: Collector
  const sock = { up: true, isConnected() { return this.up }, epoch: () => 1, reconnect() {}, lastFrameAt: () => undefined }
  const intervals: number[] = []
  const spy = spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => { intervals.push(ms); return 0 as never }) as never)
  let e: Awaited<ReturnType<typeof setup>>
  try {
    e = await setup({}, state, (slack, cfg) => (collector = new Collector(slack as never, cfg, state, '/tmp/ping-assistant-test/files')), sock)
  } finally { spy.mockRestore() }
  expect(intervals).toEqual([5000]) // drainSeconds, not pollSeconds
  let historyCalls = 0
  const history = e.slack.history.bind(e.slack)
  e.slack.history = async (c, o) => { historyCalls++; return history(c, o) }

  await e.orch.tick() // connect tick: first-run cursors
  expect(collector.socketConnected).toBe(true)
  collector.enqueue({ channel: 'D7', ts: ts(1), user: 'U2', text: 'Можешь глянуть PR?' }, 'im')
  e.advance(5_000)
  await e.orch.tick()
  expect(e.state.items['1']).toMatchObject({ source: 'im', status: 'settling', channel: 'D7', author: 'U2' })
  e.advance(91_000)
  await e.orch.tick()
  await e.flush()
  expect(e.notes.map((n) => [n.meta.kind, n.meta.item_id])).toEqual([['item', '1']])
  expect(JSON.parse(e.notes[0]!.content)).toMatchObject({ id: '1', source: 'im', messages: [{ ts: ts(1), text: 'Можешь глянуть PR?' }] })
  expect(historyCalls).toBe(0)

  sock.up = false // socket down: the next tick polls again
  await e.orch.tick()
  expect(collector.socketConnected).toBe(false)
})

test('socket mode: a reconcile poll replaying an own socket message does not close the counterpart\'s newer item', async () => {
  const ts = (sec: number) => `${T0 / 1000 + sec}.000000`
  const state = emptyState()
  let collector!: Collector
  const sock = { isConnected: () => true, epoch: () => 1, reconnect() {}, lastFrameAt: () => undefined }
  const e = await setup({ socketReconcileTicks: 3 }, state, (slack, cfg) => (collector = new Collector(slack as never, cfg, state, '/tmp/ping-assistant-test/files')), sock)
  await e.orch.tick() // connect tick: polls, first-run cursors; D7 is not listed yet, so it has no hist: cursor
  const own = { ts: ts(1), user: 'ME', text: 'привет' }
  const theirs = { ts: ts(2), user: 'U2', text: 'Можешь глянуть PR?' }
  collector.enqueue({ ...own, channel: 'D7' }, 'im')
  e.advance(5_000)
  await e.orch.tick()
  collector.enqueue({ ...theirs, channel: 'D7' }, 'im')
  e.advance(5_000)
  await e.orch.tick()
  expect(e.state.items['1']).toMatchObject({ status: 'settling', author: 'U2' })
  // The reconcile poll: D7 is listed now and read from lastTick, so both messages come back.
  e.slack.listDms = async () => [{ id: 'D7', type: 'im' as const }]
  e.slack.hist.D7 = [own, theirs]
  ;(e.slack as unknown as { searchDms: () => Promise<RawMsg[]> }).searchDms = async () => [{ ...own, channel: 'D7' }]
  e.advance(5_000)
  await e.orch.tick()
  expect(e.state.items['1']!.status).toBe('settling')
  expect(Object.keys(e.state.items)).toEqual(['1'])
})

function fakeSocket() {
  return {
    reasons: [] as string[], frameAt: undefined as number | undefined,
    isConnected: () => true, epoch: () => 1,
    reconnect(reason: string) { this.reasons.push(reason) },
    lastFrameAt() { return this.frameAt },
  }
}

test('socket mode: a wall-clock gap of more than 2×drainSeconds between ticks reconnects the socket', async () => {
  const sock = fakeSocket()
  const e = await setup({}, emptyState(), undefined, sock)
  await e.orch.tick()
  e.advance(5_000)
  await e.orch.tick()
  e.advance(10_000) // exactly 2×drainSeconds: still fine
  await e.orch.tick()
  expect(sock.reasons).toEqual([])
  e.advance(10_001) // the Mac slept
  await e.orch.tick()
  expect(sock.reasons).toEqual(['clock gap'])
})

test('socket mode: a connection without any frame for 10 minutes is replaced', async () => {
  const sock = fakeSocket()
  const e = await setup({}, emptyState(), undefined, sock)
  sock.frameAt = T0 - 600_000
  await e.orch.tick()
  expect(sock.reasons).toEqual([])
  e.advance(5_000)
  await e.orch.tick()
  expect(sock.reasons).toEqual(['silent 10 min'])
})

test('a tick that changes nothing does not save; changes save at once; idle ticks save at most once a minute', async () => {
  const e = await setup()
  await e.orch.tick() // the first tick always saves
  const base = e.saves()
  for (let i = 0; i < 5; i++) { e.advance(5_000); await e.orch.tick() }
  expect(e.saves()).toBe(base)
  e.collector.queue.push({ msg: { channel: 'D1', ts: '200.000000', user: 'U2', text: 'hi' }, source: 'im' })
  e.advance(5_000)
  await e.orch.tick()
  expect(e.saves()).toBe(base + 1)
  e.advance(59_000)
  await e.orch.tick()
  expect(e.saves()).toBe(base + 1)
  e.advance(1_000)
  await e.orch.tick()
  expect(e.saves()).toBe(base + 2)
})

test('socket mode: once the socket gives up, the timer switches from drainSeconds to pollSeconds (once) and says so', async () => {
  const sock = { ...fakeSocket(), isConnected: () => false, given: false, gaveUp() { return this.given } }
  const intervals: number[] = []
  const cleared: unknown[] = []
  const setSpy = spyOn(globalThis, 'setInterval').mockImplementation(((_fn: () => void, ms: number) => { intervals.push(ms); return intervals.length as never }) as never)
  const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation(((t: unknown) => { cleared.push(t) }) as never)
  try {
    const e = await setup({}, emptyState(), undefined, sock)
    await e.orch.tick()
    expect(intervals).toEqual([5000])
    sock.given = true
    e.advance(5_000)
    await e.orch.tick()
    expect(intervals).toEqual([5000, 3_600_000])
    expect(cleared).toEqual([1])
    const lines = stderr.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(lines).toContain('ping-assistant: socket gave up: polling every 3600s\n')
    e.advance(3_600_000) // a poll-length gap is no reason to touch the dead socket
    await e.orch.tick()
    expect(intervals).toEqual([5000, 3_600_000])
    expect(sock.reasons).toEqual([])
    e.orch.stop()
  } finally { setSpy.mockRestore(); clearSpy.mockRestore() }
})

test('the orchestrator prunes old closed items at most once an hour and saves after pruning', async () => {
  const state = emptyState()
  const at = T0 - 8 * 86_400_000
  state.items['3'] = {
    id: '3', seq: 3, sub: 0, status: 'skipped', source: 'im', channel: 'D1', author: 'U2', messages: [], context: [],
    lastSeenTs: '1.0', createdAt: at, lastMessageAt: at, telegram: {},
  }
  state.msgIndex['D1:1.000000'] = '3'
  const e = await setup({}, state)
  await e.orch.tick()
  expect(state.items['3']).toBeUndefined()
  expect(state.msgIndex).toEqual({})
  state.items['4'] = { id: '4', seq: 4, sub: 0, status: 'ignored', source: 'im', channel: 'D1', author: 'U2', messages: [], context: [], lastSeenTs: '1.0', createdAt: at, lastMessageAt: at, telegram: {} }
  e.advance(30 * 60_000)
  await e.orch.tick()
  expect(state.items['4']).toBeDefined() // less than an hour since the last prune
  const saves = e.saves()
  e.advance(30 * 60_000)
  await e.orch.tick()
  expect(state.items['4']).toBeUndefined()
  expect(e.saves()).toBe(saves + 1)
})

test('a pruned mention item whose hit is still above the search floor is not re-ingested on the next poll', async () => {
  const DAY = 86_400_000
  const ts = (ms: number) => `${ms / 1000}.000000`
  const hit = T0 - 8 * DAY // older than followUpDays, but the newest mention: every search returns it
  const state = emptyState()
  state.cursors = { lastTick: ts(T0 - 60_000), 'hist:C1': ts(T0 - 60_000), search: ts(hit - 600_000), dmsearch: ts(T0 - 60_000) }
  state.items['1'] = {
    id: '1', seq: 1, sub: 0, status: 'ignored', source: 'mention', channel: 'C9', author: 'U2', messages: [], context: [],
    lastSeenTs: ts(hit), createdAt: hit, lastMessageAt: hit, telegram: {},
  }
  state.msgIndex[`C9:${ts(hit)}`] = '1'
  state.nextSeq = 2
  const e = await setup({}, state, (slack, cfg) => new Collector(slack as never, cfg, state, '/tmp/ping-assistant-test/files'))
  e.slack.searchMentions = async () => [{ ts: ts(hit), user: 'U2', text: '<@ME> глянь', channel: 'C9' }]
  ;(e.slack as unknown as { searchDms: () => Promise<RawMsg[]> }).searchDms = async () => []
  await e.orch.tick() // prunes the old ignored item
  expect(state.items['1']).toBeUndefined()
  e.advance(5_000)
  await e.orch.tick() // the same hit comes back from search
  expect(Object.keys(state.items)).toEqual([])
  expect(state.cursors.search).toBe(ts(hit - 600_000))
})

const BAD_REPLY = '👎 записал. Что не так? Ответь цитатой: «фидбек: …»'

test('👎 stores a feedback entry with a snapshot, replies quoting the item, and leaves the item as it was', async () => {
  const e = await setup()
  e.state.channels.C1 = 'pathfinders'
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  expect(buttons(sent)).toEqual(['1', '2', 'Пропустить', '👎 разбор'])
  await e.callback('pa:bad:1', sent.id)
  await e.flush()

  expect(e.state.feedback).toEqual([{
    itemId: '1', at: T0 + 91_000, analysis: 'Тип: технический', variants: ['a', 'b'], source: 'channel', channel: 'pathfinders',
  }])
  const reply = e.api.last()
  expect(reply.text).toBe(BAD_REPLY)
  expect(reply.opts.reply_parameters).toEqual({ message_id: sent.id })
  expect(e.tg.resolveItemId(reply.id)).toBe('1') // a quote-reply to it is about item 1
  expect(e.state.items['1']!.status).toBe('awaiting')
  expect(e.api.edits.filter((x) => x.id === sent.id)).toEqual([]) // its buttons stay
  expect(e.notes.map((n) => n.meta.kind)).toEqual(['item']) // the session is not involved
  expect(e.slack.posted).toEqual([])
})

test('👎 survives closing: a sent item keeps only the 👎 row, and its entry records what was sent', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  await e.callback('pa:choose:1:2', sent.id)
  expect(buttons(e.api.lastEdit(sent.id)!)).toEqual(['👎 разбор'])
  await e.callback('pa:bad:1', sent.id)
  expect(e.state.items['1']!.status).toBe('sent')
  expect(e.state.feedback).toHaveLength(1)
  expect(e.state.feedback[0]).toMatchObject({ itemId: '1', chosen: 2, variants: ['a', 'b'] })
  expect(e.api.last().text).toBe(BAD_REPLY)
})

test('👎 on a skipped item works too; an unknown item gets «Не знаю айтем»', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  await e.callback('pa:skip:1', sent.id)
  expect(buttons(e.api.lastEdit(sent.id)!)).toEqual(['👎 разбор'])
  await e.callback('pa:bad:1', sent.id)
  expect(e.state.items['1']!.status).toBe('skipped')
  expect(e.state.feedback).toHaveLength(1)
  expect(e.state.feedback[0]!.chosen).toBeUndefined()
  await e.callback('pa:bad:9', sent.id)
  expect(e.api.last().text).toBe('Не знаю айтем #9')
  expect(e.state.feedback).toHaveLength(1)
})

test('«фидбек: …» quoting the 👎 reply attaches the note to that entry', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  await e.callback('pa:bad:1', sent.id)
  const reply = e.api.last()
  e.advance(3_600_000)
  await e.text('Фидбек: слишком длинно, пропустил второй вопрос', reply.id)
  await e.flush()

  expect(e.state.feedback).toHaveLength(1)
  expect(e.state.feedback[0]!.note).toBe('слишком длинно, пропустил второй вопрос')
  expect(e.api.last().text).toBe('✍️ фидбек сохранён')
  expect(e.notes.map((n) => n.meta.kind)).toEqual(['item'])
})

test('«N фидбек: …» without a 👎 in the last 24 h creates a new entry', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  await e.callback('pa:bad:1', sent.id)
  e.advance(25 * 3_600_000)
  await e.text('1 fb: wrong tone')
  expect(e.state.feedback).toHaveLength(2)
  expect(e.state.feedback[0]!.note).toBeUndefined()
  expect(e.state.feedback[1]).toMatchObject({ itemId: '1', note: 'wrong tone', variants: ['a', 'b'], source: 'channel' })
  expect(e.api.last().text).toBe('✍️ фидбек сохранён')
  await e.text('7 фидбек: нет такого')
  expect(e.api.last().text).toBe('Не знаю айтем #7')
  expect(e.state.feedback).toHaveLength(2)
})

test('feedback is capped at 500 entries, oldest dropped', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  for (let i = 0; i < 500; i++) e.state.feedback.push({ itemId: `old${i}`, at: T0 - 1000 + i, source: 'im', channel: 'x' })
  await e.callback('pa:bad:1', sent.id)
  expect(e.state.feedback).toHaveLength(500)
  expect(e.state.feedback[0]!.itemId).toBe('old1')
  expect(e.state.feedback.at(-1)!.itemId).toBe('1')
})

test('prune never touches feedback, even for pruned items', async () => {
  const DAY = 86_400_000
  const state = emptyState()
  state.items['1'] = {
    id: '1', seq: 1, sub: 0, status: 'sent', source: 'im', channel: 'D1', author: 'U2', messages: [], context: [],
    lastSeenTs: '1.000000', createdAt: T0 - 30 * DAY, lastMessageAt: T0 - 30 * DAY, telegram: {},
  }
  state.feedback = [{ itemId: '1', at: T0 - 30 * DAY, note: 'old', source: 'im', channel: 'D1' }]
  const e = await setup({}, state)
  await e.orch.tick()
  expect(state.items['1']).toBeUndefined()
  expect(state.feedback).toEqual([{ itemId: '1', at: T0 - 30 * DAY, note: 'old', source: 'im', channel: 'D1' }])
})

test('list_feedback lists recent entries compactly', async () => {
  const e = await setup()
  e.state.channels.C1 = 'pathfinders'
  await matureThreadItem(e)
  const sent = await propose(e, ['Первый вариант', 'Второй'])
  await e.callback('pa:choose:1:2', sent.id)
  await e.callback('pa:bad:1', sent.id)
  await e.text('фидбек: не тот тон', e.api.last().id)
  e.state.feedback.unshift({ itemId: '0', at: T0 - 10 * 86_400_000, note: 'старое', source: 'im', channel: 'D1' })
  const call = async (args: Record<string, unknown>) => {
    const res = await e.client.callTool({ name: 'list_feedback', arguments: args })
    return (res.content as { text: string }[])[0]!.text
  }
  const out = await call({})
  expect(out).toBe([
    '#1 2026-10-19 #pathfinders chosen=2',
    '  note: не тот тон',
    '  analysis: Тип: технический',
    '  variants: 1) Первый вариант | 2) Второй',
  ].join('\n'))
  expect(await call({ since_days: 30 })).toContain('#0 2026-10-09 #D1')
  e.state.feedback = []
  expect(await call({})).toBe('фидбека нет')
})

/** Local-time epoch ms, as the review schedule uses the system time zone. */
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime()

test('weekly feedback review fires once at the configured moment with the last 7 days, then waits a week', async () => {
  const e = await setup()
  // T0 is Monday 2026-10-19; the first tick only arms the schedule.
  await e.orch.tick()
  expect(e.state.lastFeedbackReviewAt).toBe(T0)
  e.state.feedback.push(
    { itemId: '5', at: T0, note: 'длинно', analysis: 'Тип: org', variants: ['a'], chosen: 1, source: 'im', channel: 'личка' },
    { itemId: '4', at: T0 - 8 * 86_400_000, source: 'im', channel: 'личка' }, // older than 7 days at review time
  )
  const moment = local(2026, 9, 26, 9, 30)
  e.advance(moment - 60_000 - T0)
  await e.orch.tick()
  await e.flush()
  expect(e.notes.filter((n) => n.meta.kind === 'feedback-review')).toEqual([])

  e.advance(2 * 60_000)
  await e.orch.tick()
  await e.flush()
  const reviews = e.notes.filter((n) => n.meta.kind === 'feedback-review')
  expect(reviews).toHaveLength(1)
  expect(reviews[0]!.meta).toEqual({ kind: 'feedback-review', source: 'ping-assistant' })
  const body = JSON.parse(reviews[0]!.content)
  expect(body.since).toBe(new Date(moment + 60_000 - 7 * 86_400_000).toISOString())
  expect(body.entries).toEqual([
    { itemId: '5', at: new Date(T0).toISOString(), note: 'длинно', analysis: 'Тип: org', variants: ['a'], chosen: 1, source: 'im', channel: 'личка' },
  ])
  expect(e.state.lastFeedbackReviewAt).toBe(moment + 60_000)

  e.advance(60_000)
  await e.orch.tick()
  e.advance(3 * 86_400_000)
  await e.orch.tick()
  await e.flush()
  expect(e.notes.filter((n) => n.meta.kind === 'feedback-review')).toHaveLength(1)

  // Next Monday: nothing in the last 7 days, so no review, but the week is consumed.
  const next = local(2026, 10, 2, 9, 30)
  e.advance(next + 60_000 - (moment + 2 * 60_000 + 3 * 86_400_000))
  await e.orch.tick()
  await e.flush()
  expect(e.notes.filter((n) => n.meta.kind === 'feedback-review')).toHaveLength(1)
  expect(e.state.lastFeedbackReviewAt).toBe(next + 60_000)

  // A 👎 on Tuesday does not trigger a late review: it waits for the following Monday.
  e.advance(86_400_000)
  e.state.feedback.push({ itemId: '6', at: next + 60_000 + 86_400_000, source: 'im', channel: 'личка' })
  await e.orch.tick()
  await e.flush()
  expect(e.notes.filter((n) => n.meta.kind === 'feedback-review')).toHaveLength(1)
  const third = local(2026, 10, 9, 9, 30)
  e.advance(third - (next + 60_000 + 86_400_000))
  await e.orch.tick()
  await e.flush()
  expect(e.notes.filter((n) => n.meta.kind === 'feedback-review')).toHaveLength(2)
})

test('a review moment missed while asleep fires on the first tick after it', async () => {
  const state = emptyState()
  state.lastFeedbackReviewAt = local(2026, 9, 12, 9, 31) // the previous Monday's review ran
  state.feedback.push({ itemId: '1', at: T0 - 86_400_000, source: 'im', channel: 'личка' })
  const e = await setup({}, state)
  const wake = local(2026, 9, 19, 12, 0) // Monday, after 09:30 local
  e.advance(wake - T0)
  await e.orch.tick()
  await e.flush()
  expect(e.notes.filter((n) => n.meta.kind === 'feedback-review')).toHaveLength(1)
  expect(state.lastFeedbackReviewAt).toBe(wake)
})

test('a second 👎 on the same item within 24 h refreshes the entry instead of adding one', async () => {
  const e = await setup()
  await matureThreadItem(e)
  const sent = await propose(e, ['a', 'b'])
  await e.callback('pa:bad:1', sent.id)
  e.advance(3_600_000)
  await e.callback('pa:bad:1', sent.id)
  expect(e.state.feedback).toHaveLength(1)
  expect(e.state.feedback[0]!.at).toBe(T0 + 91_000 + 3_600_000)
  expect(e.api.last().text).toBe(BAD_REPLY)
  e.advance(25 * 3_600_000)
  await e.callback('pa:bad:1', sent.id)
  expect(e.state.feedback).toHaveLength(2)
})

test('list_feedback is bounded: since_days clamped to 1..90, latest 50 entries, long variants and notes cut', async () => {
  const e = await setup()
  const DAY = 86_400_000
  for (let i = 0; i < 60; i++) e.state.feedback.push({ itemId: `n${i}`, at: T0 - 60_000 + i, source: 'im', channel: 'D1' })
  e.state.feedback.unshift({ itemId: 'ancient', at: T0 - 100 * DAY, source: 'im', channel: 'D1' })
  e.state.feedback.unshift({ itemId: 'old89', at: T0 - 89 * DAY, source: 'im', channel: 'D1' })
  e.state.feedback.push({ itemId: 'long', at: T0, note: 'н'.repeat(400), variants: ['в'.repeat(200), 'short'], source: 'im', channel: 'D1' })
  const call = async (args: Record<string, unknown>) => {
    const res = await e.client.callTool({ name: 'list_feedback', arguments: args })
    return (res.content as { text: string }[])[0]!.text
  }
  const out = await call({ since_days: 1000 })
  const heads = out.split('\n').filter((l) => l.startsWith('#'))
  expect(heads).toHaveLength(50)
  expect(heads[0]).toStartWith('#n11 ')
  expect(heads.at(-1)).toStartWith('#long ')
  expect(out).toContain(`  note: ${'н'.repeat(300)}…\n`)
  expect(out).toContain(`  variants: 1) ${'в'.repeat(160)}… | 2) short`)
  e.state.feedback = e.state.feedback.filter((x) => x.itemId === 'ancient' || x.itemId === 'old89')
  expect(await call({ since_days: 1000 })).toStartWith('#old89 ') // 90 days at most
  expect(await call({ since_days: 1000 })).not.toContain('ancient')
  e.state.feedback.push({ itemId: 'today', at: T0 - 3_600_000, source: 'im', channel: 'D1' }, { itemId: 'twodays', at: T0 - 2 * DAY, source: 'im', channel: 'D1' })
  expect(await call({ since_days: 0.01 })).toBe('#today 2026-10-19 #D1') // at least 1 day
})

test('a failing review notify is retried at most once a minute and logged once per failure streak', async () => {
  const state = emptyState()
  state.lastFeedbackReviewAt = local(2026, 9, 12, 9, 31)
  state.feedback.push({ itemId: '1', at: T0 - 86_400_000, source: 'im', channel: 'личка' })
  const e = await setup({}, state)
  e.advance(local(2026, 9, 19, 12, 0) - T0)
  let attempts = 0
  let fail = true
  const real = Channel.prototype.notify
  const spy = spyOn(Channel.prototype, 'notify').mockImplementation(async function (this: Channel, c: string, m: Record<string, string>) {
    if (m.kind !== 'feedback-review') return real.call(this, c, m)
    attempts++
    if (fail) throw new Error('session gone')
  })
  const failures = () => stderr.mock.calls.filter((c: unknown[]) => String(c[0]).includes('feedback-review failed')).length
  try {
    await e.orch.tick()
    expect(attempts).toBe(1)
    for (let i = 0; i < 11; i++) { e.advance(5_000); await e.orch.tick() } // 55 s later
    expect(attempts).toBe(1)
    e.advance(5_000)
    await e.orch.tick() // 60 s after the failure
    expect(attempts).toBe(2)
    expect(failures()).toBe(1)
    fail = false
    e.advance(60_000)
    await e.orch.tick()
    expect(attempts).toBe(3)
    expect(state.lastFeedbackReviewAt).toBe(local(2026, 9, 19, 12, 2))
    e.advance(60_000)
    await e.orch.tick()
    expect(attempts).toBe(3)
  } finally {
    spy.mockRestore()
  }
})

// --- references enrichment ---

const PR_15110 = {
  title: 'PF-4282. Tax id event', state: 'closed', merged: true, draft: false, user: { login: 'Andrei' },
  updated_at: '2026-10-14T11:17:33Z', head: { ref: 'feature/PF-4282', sha: 'abc' }, html_url: 'https://github.com/scentbird/scentbird/pull/15110',
}
const ISSUE_4282 = { fields: { summary: 'Tax <id>', status: { name: 'In QA' }, assignee: { displayName: 'Philipp K' }, updated: '2026-10-19', comment: { comments: [] } } }

function refFakes() {
  const ghCalls: string[][] = []
  const fetchCalls: string[] = []
  const gh: GhRunner = async (args) => {
    ghCalls.push(args)
    if (args[1] === 'repos/scentbird/scentbird/pulls/15110') return JSON.stringify(PR_15110)
    if (args[1]?.startsWith('repos/scentbird/scentbird/commits/abc/check-runs')) return JSON.stringify({ check_runs: [{ status: 'completed', conclusion: 'success' }] })
    throw new Error('not found')
  }
  const fetch: FetchLike = async (url) => {
    fetchCalls.push(url)
    return { ok: url.includes('PF-4282'), status: url.includes('PF-4282') ? 200 : 404, json: async () => ISSUE_4282 }
  }
  return { gh, fetch, ghCalls, fetchCalls }
}

const REF_TEXT = 'Глянь PF-4282 и https://github.com/scentbird/scentbird/pull/15110, почему не задеплоено?'

test('matured item with a Jira key and a PR URL: item JSON carries fetched references, Telegram shows 🔗 lines', async () => {
  const f = refFakes()
  const references = new ReferenceFetcher({ gh: f.gh, fetch: f.fetch, jira: { site: 'scentbird.atlassian.net', email: 'e', token: 't' }, now: () => T0 })
  const e = await setup({}, emptyState(), undefined, undefined, { references })
  await matureThreadItem(e, REF_TEXT)
  const body = JSON.parse(e.notes[0]!.content)
  expect(body.references).toEqual({
    jira: [{ key: 'PF-4282', url: 'https://scentbird.atlassian.net/browse/PF-4282', summary: 'Tax <id>', status: 'In QA', assignee: 'Philipp K', updated: '2026-10-19' }],
    prs: [{
      url: 'https://github.com/scentbird/scentbird/pull/15110', repo: 'scentbird/scentbird', number: 15110, title: 'PF-4282. Tax id event',
      state: 'merged', author: 'Andrei', updated: '2026-10-14T11:17:33Z', branch: 'feature/PF-4282', checks: { success: 1, failure: 0, pending: 0 },
    }],
    unresolved: [],
  })
  expect(e.state.items['1']!.references!.fetchedAt).toBe(T0)

  const sent = await propose(e, ['a', 'b'])
  expect(sent.text).toContain('🔗 <a href="https://scentbird.atlassian.net/browse/PF-4282">PF-4282</a> · In QA · Philipp')
  expect(sent.text).toContain('🔗 <a href="https://github.com/scentbird/scentbird/pull/15110">PR #15110</a> · merged · Andrei')

  // revise reuses the stored references: no new lookup
  const before = f.ghCalls.length + f.fetchCalls.length
  e.notes.length = 0
  await e.text('2, но короче', sent.id)
  await e.flush()
  expect(JSON.parse(e.notes[0]!.content).references.prs[0].number).toBe(15110)
  expect(f.ghCalls.length + f.fetchCalls.length).toBe(before)
})

test('without Jira credentials the key is unresolved and Jira is never called; nothing detected → no references', async () => {
  const f = refFakes()
  const e = await setup({}, emptyState(), undefined, undefined, { references: new ReferenceFetcher({ gh: f.gh, fetch: f.fetch, now: () => T0 }) })
  await matureThreadItem(e, REF_TEXT)
  const body = JSON.parse(e.notes[0]!.content)
  expect(body.references.jira).toEqual([])
  expect(body.references.unresolved).toEqual(['PF-4282'])
  expect(body.references.prs).toHaveLength(1)
  expect(f.fetchCalls).toEqual([])
  e.orch.stop()

  const plain = await setup()
  await matureThreadItem(plain)
  expect(JSON.parse(plain.notes[0]!.content).references).toBeUndefined()
})

test('a follow-up reuses fresh references from its thread and refetches stale ones', async () => {
  for (const [age, refetched] of [[10 * 60_000, false], [31 * 60_000, true]] as const) {
    const f = refFakes()
    const state = emptyState()
    const prRef = { url: PR_15110.html_url, repo: 'scentbird/scentbird', number: 15110, title: 'cached', state: 'open' as const, author: 'x', updated: 'u', branch: 'b' }
    state.items['1'] = {
      id: '1', seq: 1, sub: 0, status: 'sent', source: 'channel', channel: 'C1', threadTs: '100.000000', author: 'U2',
      messages: [threadMsg('101.000000', 'PR https://github.com/scentbird/scentbird/pull/15110')], context: [], lastSeenTs: '101.000000',
      createdAt: T0 - age, lastMessageAt: T0 - age, telegram: {}, references: { jira: [], prs: [prRef], unresolved: [], fetchedAt: T0 - age },
    }
    state.nextSeq = 2
    state.watchedThreads['C1:100.000000'] = { until: T0 + 86_400_000 }
    const e = await setup({}, state, undefined, undefined, { references: new ReferenceFetcher({ gh: f.gh, now: () => T0 }) })
    e.slack.repl['C1:100.000000'] = [{ ts: '101.000000', user: 'U2', text: 'PR https://github.com/scentbird/scentbird/pull/15110' }]
    e.collector.queue.push({ msg: threadMsg('105.000000', 'ну что там?', 'U4'), source: 'channel' })
    await e.orch.tick()
    e.advance(91_000)
    await e.orch.tick()
    await e.flush()
    const body = JSON.parse(e.notes[0]!.content)
    expect(body.id).toBe('1.1')
    expect(body.references.prs[0].title).toBe(refetched ? 'PF-4282. Tax id event' : 'cached')
    expect(f.ghCalls.length > 0).toBe(refetched)
    e.orch.stop()
  }
})

test('remember_thread on an unknown item is an error and stores nothing', async () => {
  const e = await setup()
  const res = await e.client.callTool({ name: 'remember_thread', arguments: { item_id: '404', agreements: 'x' } })
  expect(res.isError).toBe(true)
  expect(e.state.threads).toEqual({})
})

// --- morning briefing ---

const MIN_MS = 60_000
const HOUR_MS = 60 * MIN_MS
const DAY_MS = 24 * HOUR_MS
const briefings = (e: Awaited<ReturnType<typeof setup>>) => e.notes.filter((n) => n.meta.kind === 'briefing')

test('briefing fires once at the configured weekday moment, then waits for the next one', async () => {
  const e = await setup()
  // T0 is Monday 2026-10-19 (after 09:30 local); the first tick only arms the schedule.
  await e.orch.tick()
  await e.flush()
  expect(e.state.lastBriefingAt).toBe(T0)
  expect(briefings(e)).toEqual([])

  const moment = local(2026, 9, 20, 9, 30) // Tuesday
  e.advance(moment - MIN_MS - T0)
  await e.orch.tick()
  await e.flush()
  expect(briefings(e)).toEqual([])

  e.advance(MIN_MS)
  await e.orch.tick()
  await e.flush()
  expect(briefings(e)).toHaveLength(1)
  expect(briefings(e)[0]!.meta).toEqual({ kind: 'briefing', source: 'ping-assistant' })
  const body = JSON.parse(briefings(e)[0]!.content)
  expect(body.since).toBe(new Date(T0).toISOString()) // the previous run
  expect(body.today).toBe('2026-10-20')
  expect(e.state.lastBriefingAt).toBe(moment)

  for (let i = 0; i < 3; i++) { e.advance(HOUR_MS); await e.orch.tick() }
  await e.flush()
  expect(briefings(e)).toHaveLength(1)

  e.advance(local(2026, 9, 21, 9, 30) - (moment + 3 * HOUR_MS)) // Wednesday
  await e.orch.tick()
  await e.flush()
  expect(briefings(e)).toHaveLength(2)
  expect(JSON.parse(briefings(e)[1]!.content).since).toBe(new Date(local(2026, 9, 20, 9, 30)).toISOString())
})

test('no briefing on a weekend; Monday\'s covers everything since Friday\'s', async () => {
  const state = emptyState()
  const friday = local(2026, 9, 23, 9, 31)
  state.lastBriefingAt = friday
  const fridayEvening = local(2026, 9, 23, 19, 0)
  state.items['7'] = {
    id: '7', seq: 7, sub: 0, status: 'ignored', source: 'im', channel: 'D1', author: 'U2', messages: [], context: [], lastSeenTs: '1.0',
    createdAt: fridayEvening, lastMessageAt: fridayEvening, closedAt: fridayEvening, ignoreReason: 'FYI', telegram: {},
  }
  const e = await setup({}, state)
  e.advance(local(2026, 9, 24, 9, 31) - T0) // Saturday
  await e.orch.tick()
  e.advance(DAY_MS) // Sunday
  await e.orch.tick()
  await e.flush()
  expect(briefings(e)).toEqual([])
  expect(state.lastBriefingAt).toBe(friday)
  e.advance(DAY_MS) // Monday 09:31
  await e.orch.tick()
  await e.flush()
  expect(briefings(e)).toHaveLength(1)
  expect(JSON.parse(briefings(e)[0]!.content).since).toBe(new Date(friday).toISOString())
  expect(JSON.parse(briefings(e)[0]!.content).ignored.map((i: { id: string }) => i.id)).toEqual(['7']) // Friday evening, > 24 h ago
})

test('a briefing moment missed while asleep fires once on the first tick after it', async () => {
  const state = emptyState()
  state.lastBriefingAt = local(2026, 9, 15, 9, 31) // Thursday; Friday and Monday were missed
  const e = await setup({}, state)
  const wake = local(2026, 9, 19, 12, 0)
  e.advance(wake - T0)
  await e.orch.tick()
  e.advance(MIN_MS)
  await e.orch.tick()
  await e.flush()
  expect(briefings(e)).toHaveLength(1)
  expect(state.lastBriefingAt).toBe(wake)
})

test('a failing briefing notify is retried at most once a minute and logged once per failure streak', async () => {
  const state = emptyState()
  state.lastBriefingAt = local(2026, 9, 16, 9, 31)
  state.lastFeedbackReviewAt = T0 + DAY_MS // keep the review out of it
  const e = await setup({}, state)
  e.advance(local(2026, 9, 19, 12, 0) - T0)
  let attempts = 0
  let fail = true
  const real = Channel.prototype.notify
  const spy = spyOn(Channel.prototype, 'notify').mockImplementation(async function (this: Channel, c: string, m: Record<string, string>) {
    if (m.kind !== 'briefing') return real.call(this, c, m)
    attempts++
    if (fail) throw new Error('session gone')
  })
  const failures = () => stderr.mock.calls.filter((c: unknown[]) => String(c[0]).includes('notify briefing failed')).length
  try {
    await e.orch.tick()
    expect(attempts).toBe(1)
    for (let i = 0; i < 11; i++) { e.advance(5_000); await e.orch.tick() } // 55 s later
    expect(attempts).toBe(1)
    e.advance(5_000)
    await e.orch.tick() // 60 s after the failure
    expect(attempts).toBe(2)
    expect(failures()).toBe(1)
    expect(state.lastBriefingAt).toBe(local(2026, 9, 16, 9, 31))
    fail = false
    e.advance(60_000)
    await e.orch.tick()
    expect(attempts).toBe(3)
    expect(state.lastBriefingAt).toBe(local(2026, 9, 19, 12, 2))
    e.advance(60_000)
    await e.orch.tick()
    expect(attempts).toBe(3)
    expect(failures()).toBe(1)
  } finally {
    spy.mockRestore()
  }
})

test('«брифинг» in chat sends the briefing now without moving the schedule; closed items carry closedAt', async () => {
  const e = await setup()
  await e.orch.tick()
  await matureThreadItem(e)
  e.advance(MIN_MS)
  const res = await e.client.callTool({ name: 'ignore', arguments: { item_id: '1', reason: 'благодарность' } })
  expect(res.isError).toBeFalsy()
  expect(e.state.items['1']!.closedAt).toBe(T0 + 91_000 + MIN_MS)
  e.state.feedback.push({ itemId: '1', at: T0, source: 'channel', channel: 'C1' })
  e.advance(MIN_MS)
  await e.text('Брифинг')
  await e.flush()
  expect(e.notes.filter((n) => n.meta.kind === 'chat')).toEqual([])
  expect(briefings(e)).toHaveLength(1)
  const body = JSON.parse(briefings(e)[0]!.content)
  expect(body.ignored).toEqual([{ id: '1', channel: 'C1', author: 'User U2', reason: 'благодарность', at: new Date(T0 + 91_000 + MIN_MS).toISOString(),
    channel_short: 'C1', permalink: 'https://slack/C1/105.000000' }])
  expect(body.feedback_count).toBe(1)
  expect(e.state.lastBriefingAt).toBe(T0)
  // Anything else is still chat.
  await e.text('брифинг завтра?')
  await e.flush()
  expect(e.notes.filter((n) => n.meta.kind === 'chat')).toHaveLength(1)
})

test('sent, skipped and manually answered items record when they closed', async () => {
  const e = await setup()
  const item = await matureThreadItem(e)
  const shown = await propose(e, ['Ответ'])
  e.advance(MIN_MS)
  await e.callback('pa:choose:1:1', shown.id)
  expect(item.status).toBe('sent')
  expect(item.closedAt).toBe(T0 + 91_000 + MIN_MS)

  e.collector.queue.push({ msg: threadMsg('120.000000', 'Ещё вопрос', 'U5'), source: 'channel' })
  await e.orch.tick()
  e.advance(91_000)
  await e.orch.tick()
  const followup = Object.values(e.state.items).find((i) => i.id !== '1')!
  await e.client.callTool({ name: 'propose', arguments: { item_id: followup.id, analysis: 'a', variants: ['x', 'y'], mode: 'variants' } })
  await e.callback(`pa:skip:${followup.id}`, e.api.last().id)
  expect(followup.status).toBe('skipped')
  expect(followup.closedAt).toBe(T0 + 91_000 + MIN_MS + 91_000)
})

// --- free-form chat requests ---

const chats = (e: Awaited<ReturnType<typeof setup>>) => e.notes.filter((n) => n.meta.kind === 'chat').map((n) => JSON.parse(n.content))

test('a long or question chat text is acked «👀 смотрю…» quoting it, before the session is notified', async () => {
  const e = await setup()
  await e.text('подбери мне тикет из PF')
  await e.flush()
  expect(e.api.sent).toHaveLength(1)
  expect(e.api.last().text).toBe('👀 смотрю…')
  expect(e.api.last().opts.reply_parameters).toEqual({ message_id: 999 })
  expect(chats(e)).toEqual([{ text: 'подбери мне тикет из PF', recent_chat: [] }])

  await e.text('а второй?')
  await e.flush()
  expect(e.api.sent).toHaveLength(2)
  expect(e.api.last().text).toBe('👀 смотрю…')
})

test('a short chat text is forwarded without an ack', async () => {
  const e = await setup()
  await e.text('спасибо')
  await e.flush()
  expect(e.api.sent).toEqual([])
  expect(chats(e)).toEqual([{ text: 'спасибо', recent_chat: [] }])
})

test('a failed ack still forwards the request to the session', async () => {
  const e = await setup()
  e.api.failNextSend = true
  await e.text('что происходит с релизом мексики?')
  await e.flush()
  expect(chats(e)).toHaveLength(1)
})

test('«брифинг» is still intercepted (no ack, no chat, no log); «что по фидбеку?» still reaches the session without an ack', async () => {
  const e = await setup()
  await e.text('брифинг')
  await e.flush()
  expect(e.notes.map((n) => n.meta.kind)).toEqual(['briefing'])
  expect(e.api.sent).toEqual([])
  expect(e.state.chatLog).toEqual([])

  await e.text('что по фидбеку?')
  await e.flush()
  expect(e.api.sent).toEqual([])
  expect(chats(e)).toEqual([{ text: 'что по фидбеку?', recent_chat: [] }])
})

test('chat payload carries recent_chat: earlier chat texts and say replies, oldest first', async () => {
  const e = await setup()
  await e.text('подбери мне тикет из PF')
  e.advance(1000)
  await e.client.callTool({ name: 'say', arguments: { text: '<b>PF-1</b> и PF-2', format: 'html' } })
  e.advance(1000)
  await e.text('а второй?')
  await e.flush()

  expect(e.state.chatLog.map((x) => x.from)).toEqual(['user', 'assistant', 'user'])
  expect(chats(e)[1]).toEqual({
    text: 'а второй?',
    recent_chat: [
      { at: new Date(T0).toISOString(), from: 'user', text: 'подбери мне тикет из PF' },
      { at: new Date(T0 + 1000).toISOString(), from: 'assistant', text: '<b>PF-1</b> и PF-2' },
    ],
  })
})

test('say appends to chatLog; the log is capped and the payload holds only the last entries', async () => {
  const e = await setup()
  for (let i = 0; i < 45; i++) await e.client.callTool({ name: 'say', arguments: { text: `ответ ${i}` } })
  expect(e.state.chatLog).toHaveLength(40)
  expect(e.state.chatLog[0]!.text).toBe('ответ 5')
  await e.text('и что дальше?')
  await e.flush()
  const recent = chats(e)[0].recent_chat
  expect(recent).toHaveLength(12)
  expect(recent.at(-1)).toMatchObject({ from: 'assistant', text: 'ответ 44' })
})

test('chat log older than 7 days is dropped by the hourly prune', async () => {
  const e = await setup()
  await e.text('старый вопрос?')
  e.advance(8 * 86_400_000)
  await e.orch.tick()
  expect(e.state.chatLog).toEqual([])
})
