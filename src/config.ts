import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export type Config = {
  userId: string; watchChannels: string[]; telegramChatId: string;
  pollSeconds: number; settleSeconds: number; maxSettleSeconds: number;
  followUpDays: number; contextMessages: number; scentbirdRepoPath: string; triageTimeoutSeconds: number;
  dryRun: boolean; selfDmTest?: boolean; statePath: string;
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

const ConfigSchema = z.object({
  userId: z.string().min(1),
  watchChannels: z.array(z.string()),
  telegramChatId: z.string().min(1),
  pollSeconds: z.number().positive().default(60),
  settleSeconds: z.number().positive().default(90),
  maxSettleSeconds: z.number().positive().default(300),
  followUpDays: z.number().positive().default(7),
  contextMessages: z.number().int().positive().default(30),
  triageTimeoutSeconds: z.number().positive().default(600),
  scentbirdRepoPath: z.string().min(1),
  dryRun: z.boolean().default(false),
  selfDmTest: z.boolean().default(false),
  statePath: z.string().default('~/.config/ping-assistant/state.json'),
})

export function loadConfig(path = 'ping-assistant.config.json'): Config {
  const raw: unknown = JSON.parse(readFileSync(expandHome(path), 'utf8'))
  const result = ConfigSchema.safeParse(raw)
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new Error(`Invalid config ${path}: ${details}`)
  }
  if (result.data.selfDmTest && !result.data.dryRun) throw new Error(`Invalid config ${path}: selfDmTest requires dryRun: true`)
  return { ...result.data, statePath: expandHome(result.data.statePath) }
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^export\s+/, '') // shell-style `export KEY=value`
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const value = trimmed.slice(eq + 1).trim()
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]
    out[trimmed.slice(0, eq).trim()] = quoted ? value.slice(1, -1) : value
  }
  return out
}

export function loadSecrets(envPath = '~/.config/ping-assistant/.env'): { slackToken: string; telegramToken: string } {
  const file = parseEnvFile(expandHome(envPath))
  const get = (key: string): string => {
    const v = process.env[key] || file[key]
    if (!v) throw new Error(`Missing secret ${key} (set it in the environment or in ${envPath})`)
    return v
  }
  return { slackToken: get('SLACK_USER_TOKEN'), telegramToken: get('TELEGRAM_BOT_TOKEN') }
}
