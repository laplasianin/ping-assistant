// Jira keys and GitHub PRs mentioned in an item: detection (pure) and a bounded, best-effort lookup.
// Lookups never block delivery: whatever is not fetched in time is listed as unresolved for the session.
// Logs carry error names only, never message text, response bodies or tokens.

export type PrId = { owner: string; repo: string; number: number }
export type Detected = { jira: string[]; prs: PrId[] }

export type JiraRef = {
  key: string; url: string; summary: string; status: string; assignee: string | null; updated: string;
  lastComment?: { author: string; text: string }
}
export type PrState = 'open' | 'merged' | 'closed' | 'draft'
export type PrRef = {
  url: string; repo: string; number: number; title: string; state: PrState; author: string; updated: string; branch: string;
  checks?: { success: number; failure: number; pending: number }
}
/** fetchedAt: when the oldest entry was fetched (ms). unresolved: Jira keys and PR URLs found but not fetched. */
export type References = { jira: JiraRef[]; prs: PrRef[]; unresolved: string[]; fetchedAt: number }

const MAX_JIRA = 5
const MAX_PRS = 5
const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g
/** Uppercase-dash-number tokens that are standards, not tickets. */
const NOT_JIRA = new Set(['UTF', 'ISO', 'SHA', 'CVE', 'RFC', 'HTTP', 'TLS', 'SSL', 'MD', 'COVID', 'GPT'])
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g
const BARE_PR = /(?<![\w/&])#(\d{1,7})\b/g
/** A line that talks about a pull request: PR, PRs, пр, pull (not «prod», «прод»). */
const PR_WORD = /(?<![\p{L}\d])(?:prs?|пр|pull)(?![\p{L}\d])/iu

export const prUrl = (p: PrId): string => `https://github.com/${p.owner}/${p.repo}/pull/${p.number}`

export function detectReferences(texts: string[], defaultRepo: string): Detected {
  const jira: string[] = []
  const prs: PrId[] = []
  const [defOwner = '', defRepo = ''] = defaultRepo.split('/')
  const addPr = (p: PrId): void => {
    if (prs.length < MAX_PRS && !prs.some((x) => x.owner === p.owner && x.repo === p.repo && x.number === p.number)) prs.push(p)
  }
  for (const text of texts) {
    for (const m of text.matchAll(JIRA_KEY)) {
      const key = m[1]!
      if (jira.length < MAX_JIRA && !jira.includes(key) && !NOT_JIRA.has(key.slice(0, key.indexOf('-')))) jira.push(key)
    }
    for (const line of text.split('\n')) {
      for (const m of line.matchAll(PR_URL)) addPr({ owner: m[1]!, repo: m[2]!, number: Number(m[3]) })
      if (!defOwner || !defRepo || !PR_WORD.test(line)) continue
      for (const m of line.matchAll(BARE_PR)) addPr({ owner: defOwner, repo: defRepo, number: Number(m[1]) })
    }
  }
  return { jira, prs }
}

/** Atlassian Document Format to plain text, best effort: text and mention nodes, one line per block. */
export function adfToText(node: unknown): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  const n = node as { type?: string; text?: string; attrs?: { text?: string }; content?: unknown[] }
  if (n.type === 'text') return n.text ?? ''
  if (n.type === 'mention' || n.type === 'emoji') return n.attrs?.text ?? ''
  if (n.type === 'hardBreak') return '\n'
  const parts = (n.content ?? []).map(adfToText)
  const block = n.type === 'doc' || n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'listItem' || n.type === 'table' || n.type === 'tableRow'
  return (block ? parts.filter(Boolean).join('\n') : parts.join('')).trim()
}

/** Runs `gh <args>` and returns stdout; throws GhUnavailableError when gh is missing or not logged in. */
export type GhRunner = (args: string[]) => Promise<string>
export class GhUnavailableError extends Error {
  override name = 'GhUnavailableError'
}
export class JiraHttpError extends Error {
  override name = 'JiraHttpError'
}
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** The real gh: PATH gains Homebrew's bin (launchd starts with a minimal PATH); killed after timeoutMs. */
export function spawnGh(timeoutMs = 6000): GhRunner {
  return async (args) => {
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn(['gh', ...args], {
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}`, GH_PROMPT_DISABLED: '1' },
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs,
      })
    } catch {
      throw new GhUnavailableError('gh not found')
    }
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited,
    ])
    if (code === 0) return out
    // gh exits 4 when authentication is required; stderr then mentions «gh auth login».
    if (code === 4 || /gh auth login|authenticat/i.test(err)) throw new GhUnavailableError('gh not authenticated')
    throw new Error(`gh exited ${code}`)
  }
}

export type ReferenceFetcherDeps = {
  gh?: GhRunner; fetch?: FetchLike; jira?: { site: string; email: string; token: string };
  timeoutMs?: number; now?: () => number; log?: (kind: string) => void
}

type Gh = { title?: string; state?: string; merged?: boolean; draft?: boolean; user?: { login?: string }; updated_at?: string; head?: { ref?: string; sha?: string }; html_url?: string }
type CheckRuns = { check_runs?: { status?: string; conclusion?: string | null }[] }
type JiraIssue = { fields?: {
  summary?: string; status?: { name?: string }; assignee?: { displayName?: string } | null; updated?: string;
  comment?: { comments?: { author?: { displayName?: string }; body?: unknown }[] }
} }

const SUCCESS = ['success', 'neutral', 'skipped']
const FAILURE = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']
const errName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown')

export class ReferenceFetcher {
  private ghWarned = false
  private readonly now: () => number
  private readonly log: (kind: string) => void

  constructor(private readonly d: ReferenceFetcherDeps = {}) {
    this.now = d.now ?? Date.now
    this.log = d.log ?? ((kind) => { process.stderr.write(`ping-assistant: ${kind}\n`) })
  }

  /** Looks up what is detected and not in `cached` (entries there are reused as they are); bounded by timeoutMs in total. */
  async fetch(detected: Detected, cached?: References): Promise<References> {
    const started = this.now()
    const jira: (JiraRef | undefined)[] = detected.jira.map((key) => cached?.jira.find((j) => j.key === key))
    const prs: (PrRef | undefined)[] = detected.prs.map((p) => cached?.prs.find((x) => x.repo === `${p.owner}/${p.repo}` && x.number === p.number))
    const reused = [...jira, ...prs].some(Boolean)
    const controller = new AbortController()
    const jobs: Promise<void>[] = []
    const { jira: creds, fetch, gh } = this.d
    if (creds && fetch) {
      detected.jira.forEach((key, i) => {
        if (!jira[i]) jobs.push(this.jiraIssue(key, creds, fetch, controller.signal).then((r) => { jira[i] = r }, (err) => this.failed('jira', err)))
      })
    }
    if (gh) {
      detected.prs.forEach((p, i) => {
        if (!prs[i]) jobs.push(this.pr(p, gh).then((r) => { prs[i] = r }, (err) => this.failed('pr', err)))
      })
    }
    if (jobs.length) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.d.timeoutMs ?? 6000) })
      await Promise.race([Promise.allSettled(jobs), deadline])
      clearTimeout(timer)
      controller.abort() // late Jira answers are not waited for
    }
    // Snapshot now: a lookup finishing after the deadline must not change what was returned.
    const doneJira = jira.filter((j): j is JiraRef => j !== undefined)
    const donePrs = prs.filter((p): p is PrRef => p !== undefined)
    const unresolved = [
      ...detected.jira.filter((_, i) => !jira[i]),
      ...detected.prs.filter((_, i) => !prs[i]).map(prUrl),
    ]
    return {
      jira: doneJira.map((j) => ({ ...j })), prs: donePrs.map((p) => ({ ...p })), unresolved,
      fetchedAt: reused && cached ? Math.min(cached.fetchedAt, started) : started,
    }
  }

  private failed(what: 'jira' | 'pr', err: unknown): void {
    if (err instanceof GhUnavailableError) {
      if (!this.ghWarned) this.log('references: gh unavailable, PRs omitted')
      this.ghWarned = true
      return
    }
    this.log(`references: ${what} fetch failed: ${errName(err)}`)
  }

  private async jiraIssue(key: string, creds: NonNullable<ReferenceFetcherDeps['jira']>, fetch: FetchLike, signal: AbortSignal): Promise<JiraRef> {
    const url = `https://${creds.site}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,updated,comment`
    const res = await fetch(url, { headers: { Authorization: `Basic ${btoa(`${creds.email}:${creds.token}`)}`, Accept: 'application/json' }, signal })
    if (!res.ok) throw new JiraHttpError(`HTTP ${res.status}`)
    const f = ((await res.json()) as JiraIssue).fields ?? {}
    const last = f.comment?.comments?.at(-1)
    const text = last ? adfToText(last.body).replace(/\s+/g, ' ').trim().slice(0, 300) : ''
    return {
      key, url: `https://${creds.site}/browse/${key}`, summary: f.summary ?? '', status: f.status?.name ?? '',
      assignee: f.assignee?.displayName ?? null, updated: f.updated ?? '',
      ...(last ? { lastComment: { author: last.author?.displayName ?? '', text } } : {}),
    }
  }

  private async pr(p: PrId, gh: GhRunner): Promise<PrRef> {
    const repo = `${p.owner}/${p.repo}`
    const j = JSON.parse(await gh(['api', `repos/${repo}/pulls/${p.number}`])) as Gh
    const state: PrState = j.merged ? 'merged' : j.state === 'closed' ? 'closed' : j.draft ? 'draft' : 'open'
    const ref: PrRef = {
      url: j.html_url ?? prUrl(p), repo, number: p.number, title: j.title ?? '', state, author: j.user?.login ?? '',
      updated: j.updated_at ?? '', branch: j.head?.ref ?? '',
    }
    if (j.head?.sha) {
      try {
        const runs = (JSON.parse(await gh(['api', `repos/${repo}/commits/${j.head.sha}/check-runs?per_page=100`])) as CheckRuns).check_runs ?? []
        ref.checks = {
          success: runs.filter((r) => r.status === 'completed' && SUCCESS.includes(r.conclusion ?? '')).length,
          failure: runs.filter((r) => r.status === 'completed' && FAILURE.includes(r.conclusion ?? '')).length,
          pending: runs.filter((r) => r.status !== 'completed').length,
        }
      } catch {} // checks are optional
    }
    return ref
  }
}
