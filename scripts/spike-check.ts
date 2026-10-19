// Protocol-level check of the spike server: tools/list, tools/call, and one channel tick.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'

const client = new Client({ name: 'spike-check', version: '0.0.0' })
const transport = new StdioClientTransport({ command: 'bun', args: ['run', 'src/main.ts'] })

const ChannelNotification = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.unknown()) }),
})
const tick = new Promise<z.infer<typeof ChannelNotification>['params']>((resolve, reject) => {
  client.setNotificationHandler(ChannelNotification, n => resolve(n.params))
  setTimeout(() => reject(new Error('no channel tick within 25s')), 25_000)
})

await client.connect(transport)
console.log('capabilities:', JSON.stringify(client.getServerCapabilities()))
const tools = await client.listTools()
console.log('tools:', tools.tools.map(t => t.name))
if (!tools.tools.some(t => t.name === 'ping')) throw new Error('ping tool missing')
const res = await client.callTool({ name: 'ping', arguments: {} })
console.log('ping ->', JSON.stringify(res.content))
console.log('tick ->', JSON.stringify(await tick))
await client.close()
