import { test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { ItemMessages, TG_LIMIT } from '../src/item-messages'
import type { Keyboard } from '../src/format'
import type { Item } from '../src/state'

class FakeTg {
  edits: { id: number; text: string; keyboard?: Keyboard }[] = []
  dropped: number[] = []
  sent: { text: string; keyboard?: Keyboard; replyTo?: number }[] = []
  async edit(id: number, text: string, keyboard?: Keyboard) {
    if (text.length > TG_LIMIT) throw new Error('Bad Request: MESSAGE_TOO_LONG')
    this.edits.push({ id, text, keyboard })
  }
  async dropKeyboard(id: number) { this.dropped.push(id) }
  async send(text: string, keyboard?: Keyboard, replyTo?: number) { this.sent.push({ text, keyboard, replyTo }); return 500 }
}

const item = (text: string): Item => ({
  id: '14', seq: 14, sub: 0, status: 'sent', source: 'im', channel: 'D1', author: 'U2', messages: [], context: [],
  lastSeenTs: '1.0', createdAt: 0, lastMessageAt: 0, telegram: { messageId: 77, text },
})

let stderr: ReturnType<typeof spyOn>
beforeEach(() => { stderr = spyOn(process.stderr, 'write').mockImplementation(() => true) })
afterEach(() => { stderr.mockRestore() })

test('annotate edits the outcome line into the item message when it fits', async () => {
  const tg = new FakeTg()
  await new ItemMessages(tg).annotate(item('#14 · вопрос'), '✅ отправлен вариант 2')
  expect(tg.edits).toEqual([{ id: 77, text: '#14 · вопрос\n\n✅ отправлен вариант 2', keyboard: undefined }])
  expect(tg.sent).toEqual([])
})

test('annotate on a full last chunk: drops only the keyboard and sends the outcome as a short reply', async () => {
  const tg = new FakeTg()
  const full = 'x'.repeat(TG_LIMIT - 5)
  await new ItemMessages(tg).annotate(item(full), '✅ отправлен вариант 2')
  expect(tg.edits).toEqual([])
  expect(tg.dropped).toEqual([77])
  expect(tg.sent).toEqual([{ text: '#14 · ✅ отправлен вариант 2', keyboard: undefined, replyTo: 77 }])
})

test('closeOriginal on a full last chunk still reports the outcome', async () => {
  const tg = new FakeTg()
  const i = item('y'.repeat(TG_LIMIT))
  i.status = 'skipped'
  await new ItemMessages(tg).closeOriginal(i)
  expect(tg.sent.map((s) => s.text)).toEqual(['#14 · ⏭ пропущен'])
})
