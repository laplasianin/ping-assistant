import { test, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, loadSecrets } from '../src/config'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ping-assistant-config-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  delete process.env.SLACK_USER_TOKEN
  delete process.env.TELEGRAM_BOT_TOKEN
})

function writeJson(obj: unknown): string {
  const p = join(tmp(), 'config.json')
  writeFileSync(p, JSON.stringify(obj))
  return p
}

const base = {
  userId: 'U1',
  watchChannels: ['C1'],
  telegramChatId: '123',
  scentbirdRepoPath: '/repo',
}

test('loadConfig applies defaults', () => {
  const cfg = loadConfig(writeJson(base))
  expect(cfg.pollSeconds).toBe(60)
  expect(cfg.settleSeconds).toBe(90)
  expect(cfg.maxSettleSeconds).toBe(300)
  expect(cfg.followUpDays).toBe(7)
  expect(cfg.contextMessages).toBe(30)
  expect(cfg.triageTimeoutSeconds).toBe(600)
  expect(cfg.dryRun).toBe(false)
  expect(cfg.statePath).toBe(join(homedir(), '.config/ping-assistant/state.json'))
})

test('loadConfig keeps explicit values and expands ~ in statePath', () => {
  const cfg = loadConfig(writeJson({ ...base, pollSeconds: 5, dryRun: true, statePath: '~/x/state.json' }))
  expect(cfg.pollSeconds).toBe(5)
  expect(cfg.dryRun).toBe(true)
  expect(cfg.statePath).toBe(join(homedir(), 'x/state.json'))
})

test('loadConfig rejects missing userId', () => {
  const { userId: _u, ...rest } = base
  expect(() => loadConfig(writeJson(rest))).toThrow(/userId/)
})

test('loadSecrets reads env file and prefers process.env', () => {
  const p = join(tmp(), '.env')
  writeFileSync(p, '# comment\n\nSLACK_USER_TOKEN=xoxp-file\nTELEGRAM_BOT_TOKEN=tg-file\n')
  expect(loadSecrets(p)).toEqual({ slackToken: 'xoxp-file', telegramToken: 'tg-file' })
  process.env.TELEGRAM_BOT_TOKEN = 'tg-env'
  expect(loadSecrets(p)).toEqual({ slackToken: 'xoxp-file', telegramToken: 'tg-env' })
})

test('loadSecrets throws naming the missing key', () => {
  const p = join(tmp(), '.env')
  writeFileSync(p, 'SLACK_USER_TOKEN=xoxp-file\n')
  expect(() => loadSecrets(p)).toThrow(/TELEGRAM_BOT_TOKEN/)
})

test('loadSecrets tolerates a missing file when env has both keys', () => {
  process.env.SLACK_USER_TOKEN = 's'
  process.env.TELEGRAM_BOT_TOKEN = 't'
  expect(loadSecrets(join(tmp(), 'nope.env'))).toEqual({ slackToken: 's', telegramToken: 't' })
})

test('loadSecrets strips matching quotes and a leading export', () => {
  const p = join(tmp(), '.env')
  writeFileSync(p, `export SLACK_USER_TOKEN="xoxp-quoted"\nTELEGRAM_BOT_TOKEN='tg-single'\n`)
  expect(loadSecrets(p)).toEqual({ slackToken: 'xoxp-quoted', telegramToken: 'tg-single' })
  writeFileSync(p, `SLACK_USER_TOKEN="xoxp-unbalanced\nTELEGRAM_BOT_TOKEN=tg'mid'\n`)
  expect(loadSecrets(p)).toEqual({ slackToken: '"xoxp-unbalanced', telegramToken: "tg'mid'" })
})
