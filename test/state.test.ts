import { test, expect, afterEach } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyState, StateStore, type Item } from '../src/state'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ping-assistant-state-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const item: Item = {
  id: 'i1', seq: 1, sub: 0, status: 'awaiting', source: 'im',
  channel: 'D1', author: 'U2',
  messages: [{ channel: 'D1', ts: '1.1', user: 'U2', text: 'hi' }],
  context: [], lastSeenTs: '1.1', createdAt: 1, lastMessageAt: 2,
  telegram: { messageId: 5 },
}

test('load on missing file returns emptyState with nextSeq 1', () => {
  const s = new StateStore(join(tmp(), 'state.json')).load()
  expect(s).toEqual(emptyState())
  expect(s.nextSeq).toBe(1)
})

test('save then load round-trips items and cursors', () => {
  const store = new StateStore(join(tmp(), 'nested', 'state.json'))
  const s = emptyState()
  s.items.i1 = item
  s.cursors['hist:C1'] = '1.1'
  s.nextSeq = 2
  store.save(s)
  expect(store.load()).toEqual(s)
})

test('save is atomic: no .tmp left behind, file parses', () => {
  const dir = tmp()
  const path = join(dir, 'state.json')
  new StateStore(path).save(emptyState())
  expect(readdirSync(dir)).toEqual(['state.json'])
  expect(JSON.parse(readFileSync(path, 'utf8')).nextSeq).toBe(1)
})

test('save creates state file 0600 and new directory 0700, tightening an existing wide file', () => {
  const dir = tmp()
  const sub = join(dir, 'nested')
  const path = join(sub, 'state.json')
  const store = new StateStore(path)
  store.save(emptyState())
  expect(statSync(sub).mode & 0o777).toBe(0o700)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  chmodSync(path, 0o644)
  store.save(emptyState())
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('failed save leaves no .tmp file behind', () => {
  const dir = tmp()
  const path = join(dir, 'state.json')
  mkdirSync(path) // renameSync of a file onto a directory throws
  expect(() => new StateStore(path).save(emptyState())).toThrow()
  expect(readdirSync(dir)).toEqual(['state.json'])
})
