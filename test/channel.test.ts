import { test, expect } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { Channel, type ChannelHandlers } from '../src/channel'

type Call = { method: string; args: unknown[] }

function fakeHandlers(calls: Call[], overrides: Partial<ChannelHandlers> = {}): ChannelHandlers {
  const rec = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args })
    return `${method} ok`
  }
  return {
    propose: rec('propose'),
    ignore: rec('ignore'),
    close: rec('close'),
    listItems: rec('listItems'),
    listIgnored: rec('listIgnored'),
    say: rec('say'),
    ...overrides,
  }
}

async function setup(overrides: Partial<ChannelHandlers> = {}) {
  const calls: Call[] = []
  const channel = new Channel(fakeHandlers(calls, overrides))
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await channel.connect(serverSide)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientSide)
  return { channel, client, calls }
}

function text(res: Awaited<ReturnType<Client['callTool']>>): string {
  const content = res.content as { type: string; text: string }[]
  return content.map(c => c.text).join('')
}

test('lists exactly six tools: propose, ignore, close, list_items, list_ignored, say', async () => {
  const { client } = await setup()
  const { tools } = await client.listTools()
  expect(tools.map(t => t.name).sort()).toEqual(['close', 'ignore', 'list_ignored', 'list_items', 'propose', 'say'])
  expect(tools.some(t => /slack|send|post/i.test(t.name))).toBe(false)
})

test('advertises the claude/channel capability and instructions', async () => {
  const { client } = await setup()
  expect(client.getServerCapabilities()?.experimental?.['claude/channel']).toEqual({})
  const instructions = client.getInstructions() ?? ''
  expect(instructions).toContain('<channel source="ping-assistant"')
  expect(instructions).toContain('CLAUDE.md')
})

test('propose rejects variants outside 1..3', async () => {
  const { client, calls } = await setup()
  for (const variants of [[], ['a', 'b', 'c', 'd']]) {
    const res = await client.callTool({
      name: 'propose',
      arguments: { item_id: '14', analysis: 'x', variants, mode: 'variants' },
    })
    expect(res.isError).toBe(true)
  }
  expect(calls).toEqual([])
})

test('propose in final mode requires exactly one variant', async () => {
  const { client, calls } = await setup()
  const res = await client.callTool({
    name: 'propose',
    arguments: { item_id: '14', analysis: 'x', variants: ['a', 'b'], mode: 'final' },
  })
  expect(res.isError).toBe(true)
  expect(calls).toEqual([])
})

test('propose passes arguments to the handler and returns its text', async () => {
  const { client, calls } = await setup()
  const res = await client.callTool({
    name: 'propose',
    arguments: { item_id: '14', analysis: 'why', variants: ['a', 'b'], mode: 'variants' },
  })
  expect(res.isError).toBeFalsy()
  expect(text(res)).toBe('propose ok')
  expect(calls).toEqual([{ method: 'propose', args: ['14', 'why', ['a', 'b'], 'variants'] }])
})

test('routes ignore, close, list_items, list_ignored and say to handlers', async () => {
  const { client, calls } = await setup()
  await client.callTool({ name: 'ignore', arguments: { item_id: '3', reason: 'thanks only' } })
  await client.callTool({ name: 'close', arguments: { item_id: '4' } })
  await client.callTool({ name: 'list_items', arguments: { status: 'awaiting' } })
  await client.callTool({ name: 'list_items', arguments: {} })
  await client.callTool({ name: 'list_ignored', arguments: {} })
  await client.callTool({ name: 'list_ignored', arguments: { since_hours: 2 } })
  await client.callTool({ name: 'say', arguments: { text: 'hi' } })
  expect(calls).toEqual([
    { method: 'ignore', args: ['3', 'thanks only'] },
    { method: 'close', args: ['4'] },
    { method: 'listItems', args: ['awaiting'] },
    { method: 'listItems', args: [undefined] },
    { method: 'listIgnored', args: [24] },
    { method: 'listIgnored', args: [2] },
    { method: 'say', args: ['hi'] },
  ])
})

test('rejects unknown status and missing arguments', async () => {
  const { client, calls } = await setup()
  expect((await client.callTool({ name: 'list_items', arguments: { status: 'bogus' } })).isError).toBe(true)
  expect((await client.callTool({ name: 'say', arguments: {} })).isError).toBe(true)
  expect((await client.callTool({ name: 'send_to_slack', arguments: {} })).isError).toBe(true)
  expect(calls).toEqual([])
})

test('handler exceptions become isError results with the message', async () => {
  const { client } = await setup({
    close: async () => {
      throw new Error('unknown item 99')
    },
  })
  const res = await client.callTool({ name: 'close', arguments: { item_id: '99' } })
  expect(res.isError).toBe(true)
  expect(text(res)).toContain('unknown item 99')
})

test('notify emits notifications/claude/channel with meta.source=ping-assistant', async () => {
  const { channel, client } = await setup()
  const Notification = z.object({
    method: z.literal('notifications/claude/channel'),
    params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
  })
  const received = new Promise<z.infer<typeof Notification>['params']>(resolve => {
    client.setNotificationHandler(Notification, n => resolve(n.params))
  })
  await channel.notify('{"id":"14"}', { kind: 'item', item_id: '14' })
  expect(await received).toEqual({
    content: '{"id":"14"}',
    meta: { source: 'ping-assistant', kind: 'item', item_id: '14' },
  })
})

test('selftest notification carries meta.kind=selftest and meta.source=ping-assistant', async () => {
  const { channel, client } = await setup()
  const Notification = z.object({
    method: z.literal('notifications/claude/channel'),
    params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
  })
  const received = new Promise<z.infer<typeof Notification>['params']>(resolve => {
    client.setNotificationHandler(Notification, n => resolve(n.params))
  })
  await channel.notify(JSON.stringify({ text: 'selftest' }), { kind: 'selftest' })
  const params = await received
  expect(params.meta).toEqual({ source: 'ping-assistant', kind: 'selftest' })
  expect(JSON.parse(params.content)).toEqual({ text: 'selftest' })
})
