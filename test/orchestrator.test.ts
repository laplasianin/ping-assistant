import { test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { Channel } from '../src/channel'
import type { Config } from '../src/config'
import { slackify } from '../src/format'
import { Orchestrator } from '../src/orchestrator'
import type { RawMsg, SlackClient } from '../src/slack/client'
import type { Collected } from '../src/slack/collector'
import { emptyState, type SlackMsg, type State, type StateStore } from '../src/state'
import { TelegramBot, type TelegramApi } from '../src/telegram/bot'

const CHAT = 42
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0)

class FakeSlack {
  repl: Record<string, RawMsg[]> = {}
  hist: Record<string, RawMsg[]> = {}
  posted: { channel: string; text: string; threadTs?: string }[] = []
  private after = (msgs: RawMsg[], oldest?: string) => msgs.filter((m) => !oldest || Number(m.ts) > Number(oldest))
  async replies(channel: string, threadTs: string, oldest?: string) { return this.after(this.repl[`${channel}:${threadTs}`] ?? [], oldest) }
  async history(channel: string, oldest?: string) { return this.after(this.hist[channel] ?? [], oldest) }
  async permalink(channel: string, ts: string) { return `https://slack/${channel}/${ts}` }
  async postMessage(channel: string, text: string, threadTs?: string) {
    this.posted.push({ channel, text, ...(threadTs ? { threadTs } : {}) })
    return { ts: '9000.000100' }
  }
}

type Sent = { text: string; opts: Record<string, any>; id: number }
class FakeApi implements TelegramApi {
  sent: Sent[] = []
  edits: { id: number; text: string; opts: Record<string, any> }[] = []
  nextId = 100
  async sendMessage(_chat: string, text: string, opts: Record<string, any> = {}) {
    const id = this.nextId++
    this.sent.push({ text, opts, id })
    return { message_id: id }
  }
  async editMessageText(_chat: string, id: number, text: string, opts: Record<string, any> = {}) {
    this.edits.push({ id, text, opts })
    return true
  }
  async editMessageReplyMarkup() { return true }
  async answerCallbackQuery() { return true }
  last(): Sent { return this.sent[this.sent.length - 1]! }
  lastEdit(id: number) { return this.edits.filter((e) => e.id === id).pop() }
}

class FakeCollector {
  queue: Collected[] = []
  async tick(): Promise<Collected[]> { return this.queue.splice(0) }
}

const Note = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
})
type NoteParams = z.infer<typeof Note>['params']

const baseCfg: Config = {
  userId: 'ME', watchChannels: ['C1'], telegramChatId: String(CHAT), pollSeconds: 3600, settleSeconds: 90,
  maxSettleSeconds: 300, followUpDays: 7, contextMessages: 30, scentbirdRepoPath: '/tmp', dryRun: false,
  statePath: '/tmp/ping-assistant-test/state.json',
}

let stderr: ReturnType<typeof spyOn>
let env: Awaited<ReturnType<typeof setup>>
beforeEach(() => { stderr = spyOn(process.stderr, 'write').mockImplementation(() => true) })
afterEach(() => { env?.orch.stop(); stderr.mockRestore() })

async function setup(cfgOverrides: Partial<Config> = {}, state: State = emptyState()) {
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
    cfg, store, state, slack: slack as unknown as SlackClient, collector: collector as never, tg,
    channel: { notify: (c: string, m: Record<string, string>) => channel.notify(c, m) } as Channel, now: () => clock,
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
  expect(sent.text).toContain('1. Да, починю')
  expect(buttons(sent)).toEqual(['1', '2', 'Пропустить'])
  const item = e.state.items['1']!
  expect(item.status).toBe('awaiting')
  expect(item.variants).toEqual(['Да, починю', 'Нет, это не моё'])
  expect(item.telegram.messageId).toBe(sent.id)
  expect(e.tg.resolveItemId(sent.id)).toBe('1')
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
  expect(edit.text).not.toContain('Ответь:')
  expect(edit.opts.reply_markup).toEqual({ inline_keyboard: [] })
  expect(e.api.last().text).toBe('✅ отправлено: https://slack/C1/9000.000100')
  expect(e.state.watchedThreads['C1:100.000000']!.until).toBe(T0 + 91_000 + 7 * 86_400_000)
  expect(e.state.cursors['thr:C1:100.000000']).toBe('9000.000100')
  expect(e.state.msgIndex['C1:9000.000100']).toBe('1')
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
    { ts: '106.000000', user: 'ME', text: 'my own' },
    { ts: '107.000000', user: 'U9', bot_id: 'B1', text: 'bot noise' },
    { ts: '108.000000', user: 'U5', text: 'Уже починил' },
  ]
  await e.callback('pa:choose:1:1', sent.id)

  expect(e.slack.posted).toEqual([])
  const warn = e.api.last()
  expect(warn.text).toContain('в треде появилось новое')
  expect(warn.text).toContain('Уже починил')
  expect(warn.text).not.toContain('bot noise')
  expect(warn.text).not.toContain('my own')
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
  expect(e.notes[1]).toEqual({ content: JSON.stringify({ text: 'как дела?' }), meta: { kind: 'chat', source: 'ping-assistant' } })
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
  expect(marked.opts.reply_markup).toEqual({ inline_keyboard: [] })
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
  expect(buttons(e.api.lastEdit(original.id)!)).toEqual(['1', '2', 'Пропустить'])
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
  expect(edit.opts.reply_markup).toEqual({ inline_keyboard: [] })
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
  expect(upd.text).toContain('#1 дополнение')
  expect(upd.opts.reply_parameters).toEqual({ message_id: sent.id })
  expect(e.notes).toHaveLength(1)
  expect(e.notes[0]!.meta).toEqual({ kind: 'update', item_id: '1', source: 'ping-assistant' })
  expect(JSON.parse(e.notes[0]!.content)).toMatchObject({ id: '1', newMessages: [{ ts: '111.000000', text: 'и ещё вопрос' }] })
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
