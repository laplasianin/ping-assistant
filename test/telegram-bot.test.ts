import { test, expect } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrammyError } from 'grammy'
import { TelegramBot, isOurProcess, type Inbound, type PollingHooks, type TelegramApi } from '../src/telegram/bot'

const CHAT = '42'

class FakeApi implements TelegramApi {
  calls: { method: string; args: unknown[] }[] = []
  nextId = 100
  async sendMessage(...args: [string, string, object?]) {
    this.calls.push({ method: 'sendMessage', args })
    return { message_id: this.nextId++ }
  }
  async editMessageText(...args: [string, number, string, object?]) {
    this.calls.push({ method: 'editMessageText', args })
    return true
  }
  async editMessageReplyMarkup(...args: [string, number, object?]) {
    this.calls.push({ method: 'editMessageReplyMarkup', args })
    return true
  }
  async answerCallbackQuery(...args: [string, object?]) {
    this.calls.push({ method: 'answerCallbackQuery', args })
    return true
  }
  of(method: string) {
    return this.calls.filter((c) => c.method === method)
  }
}

// Silent by default: polling/409 diagnostics must not leak into test output; the pid file lives in a temp dir.
function setup(hooks: PollingHooks = {}) {
  const api = new FakeApi()
  const pidFile = join(mkdtempSync(join(tmpdir(), 'ping-assistant-pid-')), 'bot.pid')
  const logs: string[] = []
  const bot = new TelegramBot('123:fake', CHAT, api, { pidFile, log: (k) => { logs.push(k) }, ...hooks })
  const inbound: Inbound[] = []
  bot.onInbound(async (i) => { inbound.push(i) })
  return { api, bot, inbound, pidFile, logs }
}

const textUpdate = (id: number, chatId: number, fromId: number, text: string, replyTo?: number) => ({
  update_id: id,
  message: {
    message_id: id, date: 0, text,
    chat: { id: chatId, type: 'private' as const },
    from: { id: fromId, is_bot: false, first_name: 'x' },
    ...(replyTo ? { reply_to_message: { message_id: replyTo, date: 0, chat: { id: chatId, type: 'private' as const } } } : {}),
  },
})

const callbackUpdate = (id: number, chatId: number, fromId: number, data: string, messageId: number) => ({
  update_id: id,
  callback_query: {
    id: `cb${id}`, chat_instance: 'ci', data,
    from: { id: fromId, is_bot: false, first_name: 'x' },
    message: { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' as const } },
  },
})

test('ignores messages from other chats', async () => {
  const { bot, api, inbound } = setup()
  await bot.ingest(textUpdate(1, 99, 99, '14 1'))
  await bot.ingest(textUpdate(2, 42, 99, '14 1'))
  expect(inbound).toEqual([])
  expect(api.calls).toEqual([])
  await bot.ingest(callbackUpdate(3, 99, 99, 'pa:skip:14', 5))
  expect(inbound).toEqual([])
  expect(api.of('answerCallbackQuery')).toEqual([{ method: 'answerCallbackQuery', args: ['cb3', { text: 'Not authorized' }] }])
})

test('text reply quoting an item message resolves itemId', async () => {
  const { bot, inbound } = setup()
  bot.registerMessage(77, '14')
  expect(bot.resolveItemId(77)).toBe('14')
  expect(bot.resolveItemId(78)).toBeUndefined()
  await bot.ingest(textUpdate(10, 42, 42, '2', 77))
  expect(inbound).toEqual([{ cmd: { kind: 'choose', itemId: '14', n: 2 }, messageId: 10, quotedMessageId: 77 }])
})

test('callback pa:choose:14:2 yields choose command and answers the callback', async () => {
  const { bot, api, inbound } = setup()
  await bot.ingest(callbackUpdate(11, 42, 42, 'pa:choose:14:2', 55))
  expect(inbound).toEqual([{ cmd: { kind: 'choose', itemId: '14', n: 2 }, messageId: 55 }])
  expect(api.of('answerCallbackQuery')).toEqual([{ method: 'answerCallbackQuery', args: ['cb11', undefined] }])
  await bot.ingest(callbackUpdate(12, 42, 42, 'garbage', 55))
  expect(inbound).toHaveLength(1)
  expect(api.of('answerCallbackQuery')).toHaveLength(2)
})

test('send splits long text and attaches keyboard to the last chunk', async () => {
  const { bot, api } = setup()
  const text = Array.from({ length: 3 }, () => 'a'.repeat(3000)).join('\n\n')
  const id = await bot.send(text, [[{ label: 'Skip', data: 'pa:skip:14' }]], 9)
  const sends = api.of('sendMessage')
  expect(sends.length).toBeGreaterThan(1)
  const opts = sends.map((c) => c.args[2] as Record<string, unknown>)
  expect(opts[0]?.reply_parameters).toEqual({ message_id: 9 })
  expect(opts.slice(1).every((o) => !('reply_parameters' in o))).toBe(true)
  expect(opts.slice(0, -1).every((o) => !('reply_markup' in o))).toBe(true)
  expect(opts.at(-1)?.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Skip', callback_data: 'pa:skip:14' }]] })
  expect(id).toBe(100 + sends.length - 1)
  expect(sends.every((c) => c.args[0] === CHAT && c.args[1] !== '')).toBe(true)
})

test('edit without keyboard removes reply_markup', async () => {
  const { bot, api } = setup()
  await bot.edit(5, 'done')
  await bot.edit(6, 'again', [[{ label: 'X', data: 'pa:cancel:1' }]])
  const edits = api.of('editMessageText')
  expect(edits[0]?.args).toEqual([CHAT, 5, 'done', { reply_markup: { inline_keyboard: [] } }])
  expect(edits[1]?.args).toEqual([CHAT, 6, 'again', { reply_markup: { inline_keyboard: [[{ text: 'X', callback_data: 'pa:cancel:1' }]] } }])
})

test('callback from the right chat but wrong sender is rejected', async () => {
  const { bot, api, inbound } = setup()
  await bot.ingest(callbackUpdate(20, 42, 99, 'pa:skip:14', 5))
  expect(inbound).toEqual([])
  expect(api.calls).toEqual([{ method: 'answerCallbackQuery', args: ['cb20', { text: 'Not authorized' }] }])
})

test('text from a group chat is dropped', async () => {
  const { bot, api, inbound } = setup()
  await bot.ingest(textUpdate(21, -1001234, 42, '14 1'))
  expect(inbound).toEqual([])
  expect(api.calls).toEqual([])
})

test('/start from a wrong sender gets no reply, from the owner gets one', async () => {
  const { bot, api } = setup()
  const cmd = (from: number) => ({
    ...textUpdate(22, 42, from, '/start'),
  })
  const wrong = cmd(99)
  ;(wrong.message as { entities?: unknown }).entities = [{ type: 'bot_command', offset: 0, length: 6 }]
  await bot.ingest(wrong)
  expect(api.calls).toEqual([])
  const own = cmd(42)
  ;(own.message as { entities?: unknown }).entities = [{ type: 'bot_command', offset: 0, length: 6 }]
  await bot.ingest(own)
  expect(api.of('sendMessage')).toHaveLength(1)
})

test('unparseable callback is answered with the query id and not dispatched', async () => {
  const { bot, api, inbound } = setup()
  await bot.ingest(callbackUpdate(23, 42, 42, 'garbage', 5))
  expect(inbound).toEqual([])
  expect(api.calls).toEqual([{ method: 'answerCallbackQuery', args: ['cb23', undefined] }])
})

test('a failing answerCallbackQuery does not drop the command', async () => {
  const { bot, api, inbound } = setup()
  api.answerCallbackQuery = async () => { throw new Error('400 query is too old') }
  await bot.ingest(callbackUpdate(24, 42, 42, 'pa:skip:14', 5))
  expect(inbound).toEqual([{ cmd: { kind: 'skip', itemId: '14' }, messageId: 5 }])
})

test('isOurProcess matches only our entry point', () => {
  const entry = '/Users/me/ping-assistant/src/main.ts'
  expect(isOurProcess(`bun run ${entry}`, entry)).toBe(true)
  expect(isOurProcess('bun run /other/project/src/main.ts', entry)).toBe(false)
  expect(isOurProcess('node something', '')).toBe(false)
})

const conflict = () => new GrammyError('x', { ok: false, error_code: 409, description: 'Conflict' }, 'getUpdates', {})

test('gives up after 8 consecutive 409s even though onStart fires each time', async () => {
  let calls = 0
  const sleeps: number[] = []
  const { bot } = setup({
    startPolling: async (onStart) => { calls++; onStart(); throw conflict() },
    sleep: async (ms) => { sleeps.push(ms) },
  })
  await bot.poll()
  expect(calls).toBe(8)
  expect(sleeps).toEqual([1000, 2000, 3000, 4000, 5000, 6000, 7000])
})

test('stop() during backoff prevents another start', async () => {
  let calls = 0
  let sleeping!: () => void
  const entered = new Promise<void>((r) => { sleeping = r })
  const { bot } = setup({
    startPolling: async () => { calls++; throw new Error('ETIMEDOUT') },
    sleep: (_ms, signal) => new Promise((resolve) => {
      sleeping()
      signal.addEventListener('abort', () => resolve(), { once: true })
    }),
  })
  const loop = bot.poll()
  await entered
  await bot.stop()
  await loop
  expect(calls).toBe(1)
})

test('stop() removes our own bot.pid even when polling never started', async () => {
  const { bot, pidFile } = setup()
  writeFileSync(pidFile, String(process.pid))
  await bot.stop()
  expect(existsSync(pidFile)).toBe(false)
})

test('stop() removes our own bot.pid even when bot.stop() throws', async () => {
  const { bot, pidFile } = setup()
  writeFileSync(pidFile, String(process.pid))
  ;(bot as unknown as { bot: { stop: () => Promise<void> } }).bot.stop = async () => { throw new Error('boom') }
  await expect(bot.stop()).rejects.toThrow('boom')
  expect(existsSync(pidFile)).toBe(false)
})

test('stop() leaves a pid file that belongs to another process', async () => {
  const { bot, pidFile } = setup()
  writeFileSync(pidFile, String(process.pid + 1))
  await bot.stop()
  expect(readFileSync(pidFile, 'utf8')).toBe(String(process.pid + 1))
})

test('polling diagnostics go to the injected logger', async () => {
  const { bot, logs } = setup({ startPolling: async (onStart) => { onStart() }, sleep: async () => {} })
  await bot.poll()
  expect(logs).toEqual(['polling'])
})
