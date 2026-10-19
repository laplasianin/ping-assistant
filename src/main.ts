// Temporary spike: proves the Claude Code channel protocol end to end.
// Replaced by the real server in later tasks.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const mcp = new Server(
  { name: 'ping-assistant', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions:
      'Spike server. Every 20 seconds a <channel source="ping-assistant" kind="tick"> message arrives. Call the ping tool to check connectivity; it returns "pong".',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ping',
      description: 'Connectivity check. Returns "pong".',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'ping') return { content: [{ type: 'text', text: 'pong' }] }
  return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
})

await mcp.connect(new StdioServerTransport())

const TICK_MS = Number(process.env.PING_TICK_MS ?? 20_000)
const tick = setInterval(() => {
  mcp
    .notification({
      method: 'notifications/claude/channel',
      params: { content: 'tick', meta: { source: 'ping-assistant', kind: 'tick' } },
    })
    .catch(err => process.stderr.write(`ping-assistant: tick failed: ${err}\n`))
}, TICK_MS)

// Claude Code closing the connection EOFs stdin; exit instead of lingering as a zombie.
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(tick)
  process.stderr.write('ping-assistant: shutting down\n')
  process.exit(0)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// Orphan watchdog: belt and braces for the stdin handlers above.
setInterval(() => {
  if (process.stdin.destroyed || process.stdin.readableEnded) shutdown()
}, 5000).unref()
