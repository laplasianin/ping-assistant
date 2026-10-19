// Protocol-level smoke check of the real server: starts src/main.ts over stdio like Claude Code
// does, verifies the channel capability and that no tool can send to Slack, then disconnects.
// Uses the same config and secrets as a real run (PING_ASSISTANT_CONFIG, ~/.config/ping-assistant/.env).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const client = new Client({ name: 'smoke-check', version: '0.0.0' })
const transport = new StdioClientTransport({ command: 'bun', args: ['run', 'src/main.ts'], stderr: 'inherit',
  env: process.env as Record<string, string>, // the SDK passes only a minimal env by default
})

await client.connect(transport)
const channelCap = client.getServerCapabilities()?.experimental?.['claude/channel']
console.log('claude/channel capability:', channelCap ? 'yes' : 'NO')
const { tools } = await client.listTools()
console.log('tools:', tools.map(t => t.name).join(', '))
const unsafe = tools.filter(t => /send|post|slack/i.test(t.name))
if (!channelCap || unsafe.length) throw new Error(`smoke check failed: ${unsafe.map(t => t.name).join(', ') || 'no channel capability'}`)
console.log('ok')
await client.close()
