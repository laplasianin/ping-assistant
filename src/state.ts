import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type SlackMsg = { channel: string; ts: string; threadTs?: string; user: string; userName?: string; text: string; files?: { id: string; name: string; path?: string }[]; permalink?: string }
export type ItemStatus = 'settling'|'triage'|'ignored'|'awaiting'|'sent'|'skipped'|'answered_manually'
export type ItemSource = 'im'|'mpim'|'mention'|'channel'|'followup'
export type Item = {
  id: string; seq: number; sub: number; status: ItemStatus; source: ItemSource;
  channel: string; channelName?: string; threadTs?: string; author: string; authorName?: string;
  messages: SlackMsg[]; context: SlackMsg[]; lastSeenTs: string;
  createdAt: number; lastMessageAt: number;
  analysis?: string; variants?: string[]; pendingText?: string; forceSend?: boolean;
  telegram: { messageId?: number; proposalMessageId?: number };
  ignoreReason?: string; sentTs?: string;
}
export type State = {
  cursors: Record<string, string>;            // ключ: `hist:${channel}` | `thr:${channel}:${threadTs}` | 'search'
  items: Record<string, Item>; nextSeq: number;
  msgIndex: Record<string, string>;           // `${channel}:${ts}` → item.id (дедуп)
  watchedThreads: Record<string, { until: number }>;  // `${channel}:${threadTs}`
  users: Record<string, string>;              // userId → display name (кэш)
  channels: Record<string, string>;           // channelId → name (кэш)
}

export function emptyState(): State {
  return { cursors: {}, items: {}, nextSeq: 1, msgIndex: {}, watchedThreads: {}, users: {}, channels: {} }
}

export class StateStore {
  constructor(private readonly path: string) {}

  load(): State {
    if (!existsSync(this.path)) return emptyState()
    return { ...emptyState(), ...(JSON.parse(readFileSync(this.path, 'utf8')) as Partial<State>) }
  }

  save(state: State): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
      chmodSync(tmp, 0o600) // mode is ignored if a stale tmp file already existed
      renameSync(tmp, this.path)
    } catch (err) {
      try { unlinkSync(tmp) } catch {}
      throw err
    }
  }
}
