import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { References } from './references'

/** msgIndex value for a seen message that is in no item (Ilya's own, or user-less): dedup only. */
export const OWN_MSG = 'own'

export type SlackMsg = { channel: string; ts: string; threadTs?: string; user: string; userName?: string; text: string; files?: { id: string; name: string; path?: string }[]; permalink?: string }
export type ItemStatus = 'settling'|'triage'|'ignored'|'awaiting'|'sent'|'skipped'|'answered_manually'
export type ItemSource = 'im'|'mpim'|'mention'|'channel'|'followup'
export type Item = {
  id: string; seq: number; sub: number; status: ItemStatus; source: ItemSource;
  channel: string; channelName?: string; threadTs?: string; author: string; authorName?: string;
  messages: SlackMsg[]; context: SlackMsg[]; lastSeenTs: string;
  createdAt: number; lastMessageAt: number; triageAt?: number;  // triageAt: when it was last handed to the session
  analysis?: string; variants?: string[]; pendingText?: string; forceSend?: boolean;
  // text: the item message's last Telegram chunk without the hint line; chosen: variant held by a force warning;
  // warningMessageId: the live «тред изменился» message whose buttons may force or cancel (warningText: its last chunk);
  // triageAlerted: the «без разбора» reminder was sent (once per triage).
  telegram: { messageId?: number; proposalMessageId?: number; warningMessageId?: number; warningText?: string; text?: string; chosen?: number; triageAlerted?: boolean };
  ignoreReason?: string; sentTs?: string;
  sentChoice?: number | 'custom';            // what was sent: variant N or Ilya's own text (kept for feedback)
  references?: References;                   // Jira/PR lookups at delivery, reused by revise and fresh follow-ups
}
/** A 👎 on an item or a «фидбек: …» note; snapshot of what the session proposed. Never pruned, capped at FEEDBACK_MAX. */
export type FeedbackEntry = {
  itemId: string; at: number; note?: string; analysis?: string; variants?: string[];
  chosen?: number | 'custom'; source: ItemSource; channel: string;
}
export const FEEDBACK_MAX = 500
export type State = {
  cursors: Record<string, string>;            // ключ: `hist:${channel}` | `thr:${channel}:${threadTs}` | 'search' | 'dmsearch' | 'lastTick'
  items: Record<string, Item>; nextSeq: number;
  msgIndex: Record<string, string>;           // `${channel}:${ts}` → item.id, или OWN_MSG для своих/без автора (дедуп)
  watchedThreads: Record<string, { until: number }>;  // `${channel}:${threadTs}`
  users: Record<string, string>;              // userId → display name (кэш)
  tickCount?: number;                         // collector ticks so far (quiet MPIMs swept every 10th, quiet IMs every 30th)
  dmActivity?: Record<string, string>;        // DM id → ts of the newest message actually read from it
  dmSweepAfter?: string;                      // quiet-MPIM sweep in progress: id of the last MPIM it read ('' = none yet)
  imSweepAfter?: string;                      // quiet-IM sweep in progress: id of the last IM it read ('' = none yet)
  selfDmChannel?: string;                   // the IM with the user himself (selfDmTest)
  channels: Record<string, string>;           // channelId → name (кэш)
  feedback: FeedbackEntry[];                  // oldest first
  lastFeedbackReviewAt?: number;              // when the weekly feedback review last ran
}

export function emptyState(): State {
  return { cursors: {}, items: {}, nextSeq: 1, msgIndex: {}, watchedThreads: {}, users: {}, channels: {}, feedback: [] }
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
