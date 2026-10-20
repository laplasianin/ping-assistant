import { describe, expect, test } from 'bun:test'
import {
  adfToText, detectReferences, GhUnavailableError, ReferenceFetcher, type FetchLike, type GhRunner, type References,
} from '../src/references'

const REPO = 'scentbird/scentbird'
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0)

describe('detectReferences', () => {
  test('Jira keys in text, in order, deduped; lowercase ignored', () => {
    const d = detectReferences(['Глянь PF-4282 и TR-12, а ещё pf-1 и PF-4282 снова', 'см. https://scentbird.atlassian.net/browse/WMSH-1586'], REPO)
    expect(d.jira).toEqual(['PF-4282', 'TR-12', 'WMSH-1586'])
  })

  test('at most 5 Jira keys', () => {
    expect(detectReferences(['A1-1 AB-2 AC-3 AD-4 AE-5 AF-6 AG-7'], REPO).jira).toEqual(['A1-1', 'AB-2', 'AC-3', 'AD-4', 'AE-5'])
  })

  test('well-known non-ticket tokens are not Jira keys', () => {
    expect(detectReferences(['UTF-8, ISO-8601, SHA-256, CVE-2024-1234 и PF-1'], REPO).jira).toEqual(['PF-1'])
  })

  test('GitHub PR URLs, including Slack <url|label> form, deduped', () => {
    const d = detectReferences([
      'смотри <https://github.com/scentbird/scentbird/pull/15110|PR> и https://github.com/acme/tool/pull/7/files',
      'опять https://github.com/scentbird/scentbird/pull/15110',
    ], REPO)
    expect(d.prs).toEqual([
      { owner: 'scentbird', repo: 'scentbird', number: 15110 },
      { owner: 'acme', repo: 'tool', number: 7 },
    ])
  })

  test('bare #n counts only with PR/пр/pull on the same line, in the default repo', () => {
    const d = detectReferences(['PR #15110 готов', 'вот пр #15111', 'pull #15112', 'задача #15113 в бэклоге', 'see #15114\nсм. PR выше'], REPO)
    expect(d.prs.map((p) => p.number)).toEqual([15110, 15111, 15112])
    expect(d.prs[0]).toEqual({ owner: 'scentbird', repo: 'scentbird', number: 15110 })
  })

  test('a bare number already given as a URL is not repeated; at most 5 PRs', () => {
    const d = detectReferences(['PR https://github.com/scentbird/scentbird/pull/1 и #1, #2 #3 #4 #5 #6 PR'], REPO)
    expect(d.prs.map((p) => p.number)).toEqual([1, 2, 3, 4, 5])
  })

  test('nothing found', () => {
    expect(detectReferences(['просто вопрос #general', 'prod упал'], REPO)).toEqual({ jira: [], prs: [] })
  })
})

test('adfToText flattens paragraphs, text and mentions', () => {
  const adf = {
    type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }, { type: 'mention', attrs: { text: '@Ann' } }, { type: 'text', text: ', done' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
    ],
  }
  expect(adfToText(adf)).toBe('Hi @Ann, done\nSecond')
  expect(adfToText('plain')).toBe('plain')
  expect(adfToText(null)).toBe('')
})

const PR_JSON = {
  title: 'PF-4282. Send a tax id issue event', state: 'closed', merged: true, draft: false, user: { login: 'AndreiSotnikov' },
  updated_at: '2026-10-14T11:17:33Z', head: { ref: 'feature/PF-4282', sha: 'abc123' }, html_url: 'https://github.com/scentbird/scentbird/pull/15110',
}
const CHECKS_JSON = {
  check_runs: [
    { status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' },
    { status: 'completed', conclusion: 'failure' }, { status: 'in_progress', conclusion: null },
  ],
}
const ISSUE_JSON = {
  fields: {
    summary: 'Tax id event', status: { name: 'In QA' }, assignee: { displayName: 'Philipp K' }, updated: '2026-10-19T10:00:00.000+0000',
    comment: { comments: [
      { author: { displayName: 'Old' }, body: 'first' },
      { author: { displayName: 'Ann' }, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(400) }] }] } },
    ] },
  },
}

function fakeGh(responses: Record<string, unknown>, calls: string[][] = []): GhRunner {
  return async (args) => {
    calls.push(args)
    const path = args[1]!
    if (!(path in responses)) throw new Error('not found')
    return JSON.stringify(responses[path])
  }
}

function fakeFetch(byKey: Record<string, unknown>, calls: { url: string; headers: Record<string, string> }[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, headers: init.headers })
    const key = /issue\/([^?]+)/.exec(url)?.[1] ?? ''
    const body = byKey[key]
    return { ok: body !== undefined, status: body !== undefined ? 200 : 404, json: async () => body }
  }
}

const jira = { site: 'scentbird.atlassian.net', email: 'me@x', token: 'tok' }

describe('ReferenceFetcher', () => {
  test('fetches PRs via gh (with checks) and Jira via REST', async () => {
    const ghCalls: string[][] = []
    const fetchCalls: { url: string; headers: Record<string, string> }[] = []
    const f = new ReferenceFetcher({
      gh: fakeGh({ 'repos/scentbird/scentbird/pulls/15110': PR_JSON, 'repos/scentbird/scentbird/commits/abc123/check-runs?per_page=100': CHECKS_JSON }, ghCalls),
      fetch: fakeFetch({ 'PF-4282': ISSUE_JSON }, fetchCalls), jira, now: () => NOW, log: () => {},
    })
    const r = await f.fetch({ jira: ['PF-4282'], prs: [{ owner: 'scentbird', repo: 'scentbird', number: 15110 }] })
    expect(r.prs).toEqual([{
      url: 'https://github.com/scentbird/scentbird/pull/15110', repo: 'scentbird/scentbird', number: 15110,
      title: 'PF-4282. Send a tax id issue event', state: 'merged', author: 'AndreiSotnikov', updated: '2026-10-14T11:17:33Z',
      branch: 'feature/PF-4282', checks: { success: 2, failure: 1, pending: 1 },
    }])
    expect(r.jira).toEqual([{
      key: 'PF-4282', url: 'https://scentbird.atlassian.net/browse/PF-4282', summary: 'Tax id event', status: 'In QA',
      assignee: 'Philipp K', updated: '2026-10-19T10:00:00.000+0000', lastComment: { author: 'Ann', text: 'x'.repeat(300) },
    }])
    expect(r.unresolved).toEqual([])
    expect(r.fetchedAt).toBe(NOW)
    expect(ghCalls[0]).toEqual(['api', 'repos/scentbird/scentbird/pulls/15110'])
    expect(fetchCalls[0]!.url).toBe('https://scentbird.atlassian.net/rest/api/3/issue/PF-4282?fields=summary,status,assignee,updated,comment')
    expect(fetchCalls[0]!.headers.Authorization).toBe(`Basic ${btoa('me@x:tok')}`)
  })

  test('PR state: draft and open; failed checks call omits checks', async () => {
    const f = new ReferenceFetcher({
      gh: fakeGh({
        'repos/a/b/pulls/1': { ...PR_JSON, state: 'open', merged: false, draft: true },
        'repos/a/b/pulls/2': { ...PR_JSON, state: 'open', merged: false, draft: false },
        'repos/a/b/pulls/3': { ...PR_JSON, state: 'closed', merged: false },
      }),
      now: () => NOW, log: () => {},
    })
    const r = await f.fetch({ jira: [], prs: [1, 2, 3].map((number) => ({ owner: 'a', repo: 'b', number })) })
    expect(r.prs.map((p) => p.state)).toEqual(['draft', 'open', 'closed'])
    expect(r.prs.every((p) => p.checks === undefined)).toBe(true)
  })

  test('without Jira credentials: no Jira request, keys go to unresolved', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const f = new ReferenceFetcher({ fetch: fakeFetch({ 'PF-1': ISSUE_JSON }, calls), now: () => NOW, log: () => {} })
    const r = await f.fetch({ jira: ['PF-1'], prs: [] })
    expect(calls).toEqual([])
    expect(r).toEqual({ jira: [], prs: [], unresolved: ['PF-1'], fetchedAt: NOW })
  })

  test('failures are omitted, listed in unresolved and logged by error name only', async () => {
    const logs: string[] = []
    const f = new ReferenceFetcher({ gh: fakeGh({}), fetch: fakeFetch({}), jira, now: () => NOW, log: (k) => logs.push(k) })
    const r = await f.fetch({ jira: ['PF-404'], prs: [{ owner: 'a', repo: 'b', number: 9 }] })
    expect(r.jira).toEqual([])
    expect(r.prs).toEqual([])
    expect(r.unresolved).toEqual(['PF-404', 'https://github.com/a/b/pull/9'])
    expect(logs.sort()).toEqual(['references: jira fetch failed: JiraHttpError', 'references: pr fetch failed: Error'])
  })

  test('gh missing or unauthenticated: PRs unresolved, logged once per fetcher', async () => {
    const logs: string[] = []
    const gh: GhRunner = async () => { throw new GhUnavailableError('missing') }
    const f = new ReferenceFetcher({ gh, now: () => NOW, log: (k) => logs.push(k) })
    const pr = { owner: 'a', repo: 'b', number: 1 }
    expect((await f.fetch({ jira: [], prs: [pr, { ...pr, number: 2 }] })).unresolved).toHaveLength(2)
    await f.fetch({ jira: [], prs: [pr] })
    expect(logs).toEqual(['references: gh unavailable, PRs omitted'])
  })

  test('the total time is bounded: slow lookups end up unresolved', async () => {
    const gh: GhRunner = () => new Promise(() => {})
    const slowFetch: FetchLike = () => new Promise(() => {})
    const f = new ReferenceFetcher({
      gh, fetch: slowFetch, jira, timeoutMs: 30, now: () => NOW, log: () => {},
    })
    const t = performance.now()
    const r = await f.fetch({ jira: ['PF-1'], prs: [{ owner: 'a', repo: 'b', number: 1 }] })
    expect(performance.now() - t).toBeLessThan(500)
    expect(r.unresolved).toEqual(['PF-1', 'https://github.com/a/b/pull/1'])
  })

  test('cached entries are reused without refetching; only new ones are fetched', async () => {
    const ghCalls: string[][] = []
    const f = new ReferenceFetcher({ gh: fakeGh({ 'repos/a/b/pulls/2': PR_JSON }, ghCalls), now: () => NOW, log: () => {} })
    const cached: References = {
      jira: [], unresolved: [], fetchedAt: NOW - 60_000,
      prs: [{ url: 'https://github.com/a/b/pull/1', repo: 'a/b', number: 1, title: 'old', state: 'open', author: 'x', updated: 'u', branch: 'b' }],
    }
    const r = await f.fetch({ jira: [], prs: [{ owner: 'a', repo: 'b', number: 1 }, { owner: 'a', repo: 'b', number: 2 }] }, cached)
    expect(ghCalls.map((c) => c[1]).filter((p) => p!.includes('/pulls/'))).toEqual(['repos/a/b/pulls/2'])
    expect(r.prs.map((p) => p.title)).toEqual(['old', PR_JSON.title])
    expect(r.fetchedAt).toBe(NOW - 60_000) // as old as its oldest entry
  })
})
