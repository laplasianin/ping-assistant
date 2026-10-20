import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export type Config = {
  userId: string; watchChannels: string[]; telegramChatId: string;
  pollSeconds: number; settleSeconds: number; maxSettleSeconds: number;
  followUpDays: number; contextMessages: number; scentbirdRepoPath: string; triageTimeoutSeconds: number;
  dryRun: boolean; selfDmTest?: boolean; statePath: string;
  drainSeconds: number; socketReconcileTicks: number;
  /** Weekly feedback review, local time (system TZ): weekday 0 = Sunday … 6 = Saturday. */
  feedbackReviewCron: ReviewCron;
  /** Morning briefing, local time (system TZ), on these weekdays (0 = Sunday … 6 = Saturday). */
  briefing: BriefingCron;
  /** References enrichment: bare «PR #123» numbers resolve to defaultRepo (owner/repo); Jira keys link to jira.site. */
  github: { defaultRepo: string }; jira: { site: string };
}
export type ReviewCron = { weekday: number; hour: number; minute: number }
export type BriefingCron = { hour: number; minute: number; weekdays: number[] }

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
  drainSeconds: z.number().min(1).default(5),
  socketReconcileTicks: z.number().int().positive().default(10),
  feedbackReviewCron: z.object({
    weekday: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }).default({ weekday: 1, hour: 9, minute: 30 }),
  briefing: z.object({
    hour: z.number().int().min(0).max(23).default(9),
    minute: z.number().int().min(0).max(59).default(30),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1)
      .refine((d) => new Set(d).size === d.length, 'weekdays must not repeat').default([1, 2, 3, 4, 5]),
  }).prefault({}),
  github: z.object({ defaultRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/repo') }).default({ defaultRepo: 'scentbird/scentbird' }),
  jira: z.object({ site: z.string().regex(/^[\w.-]+$/, 'must be a host name') }).default({ site: 'scentbird.atlassian.net' }),
})

export function loadConfig(path = 'ping-assistant.config.json'): Config {
  let text: string
  try {
    text = readFileSync(expandHome(path), 'utf8')
  } catch (err) {
    throw new Error(`Cannot read config ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`Invalid config ${path}: malformed JSON (${err instanceof Error ? err.message : String(err)})`)
  }
  const result = ConfigSchema.safeParse(raw)
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new Error(`Invalid config ${path}: ${details}`)
  }
  if (result.data.selfDmTest && !result.data.dryRun) throw new Error(`Invalid config ${path}: selfDmTest requires dryRun: true`)
  return { ...result.data, statePath: expandHome(result.data.statePath) }
}

/** A quoted value ends at its closing quote; an unquoted one at ` #` (a trailing comment). */
function envValue(value: string): string {
  const q = value[0]
  if (q === '"' || q === "'") {
    const close = value.indexOf(q, 1)
    if (close > 0 && /^\s*(#.*)?$/.test(value.slice(close + 1))) return value.slice(1, close)
    return value
  }
  return value.replace(/\s+#.*$/, '')
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^export\s+/, '') // shell-style `export KEY=value`
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    out[trimmed.slice(0, eq).trim()] = envValue(trimmed.slice(eq + 1).trim())
  }
  return out
}

export type Secrets = { slackToken: string; telegramToken: string; slackAppToken?: string; jiraEmail?: string; jiraApiToken?: string }

/**
 * slackAppToken (`xapp-…`, Socket Mode) is optional: without it the server polls only.
 * JIRA_EMAIL + JIRA_API_TOKEN are optional too: without both, Jira keys are left to the session's Atlassian MCP.
 */
export function loadSecrets(envPath = '~/.config/ping-assistant/.env'): Secrets {
  const file = parseEnvFile(expandHome(envPath))
  const get = (key: string): string => {
    const v = process.env[key] || file[key]
    if (!v) throw new Error(`Missing secret ${key} (set it in the environment or in ${envPath})`)
    return v
  }
  const optional = (key: string): string | undefined => process.env[key] || file[key] || undefined
  const slackAppToken = optional('SLACK_APP_TOKEN')
  const jiraEmail = optional('JIRA_EMAIL')
  const jiraApiToken = optional('JIRA_API_TOKEN')
  return {
    slackToken: get('SLACK_USER_TOKEN'), telegramToken: get('TELEGRAM_BOT_TOKEN'), ...(slackAppToken ? { slackAppToken } : {}),
    ...(jiraEmail && jiraApiToken ? { jiraEmail, jiraApiToken } : {}),
  }
}
