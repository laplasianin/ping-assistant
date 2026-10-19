import type { Config } from '../config'
import type { ItemSource, State } from '../state'
import type { RawMsg } from './client'
import type { ChannelType } from './socket'

export type Queued = { raw: RawMsg & { channel: string }; channelType: ChannelType }

const isReply = (raw: RawMsg): boolean => raw.thread_ts !== undefined && raw.thread_ts !== raw.ts

/**
 * Socket Mode events waiting for the next collector tick, and the bookkeeping that lets polling slow down
 * while the socket is up: how often to reconcile, and which cursors a socket message may advance.
 */
export class SocketQueue {
  private pending: Queued[] = []
  private up = false
  /** Connected since the last tick: poll at once, to read what arrived while the socket was down. */
  private reconnected = false
  private skipped = 0
  /**
   * Cursor values staged by polls made while connected. A socket message may advance a cursor only when it is
   * at least that value: then a poll read the conversation after the socket came up, so nothing between the
   * cursor and the socket message was missed. Any other cursor keeps waiting for the poll.
   */
  private polled = new Map<string, string>()

  get connected(): boolean { return this.up }
  set connected(v: boolean) {
    if (v && !this.up) this.reconnected = true
    if (v !== this.up) this.polled.clear()
    this.up = v
  }

  push(raw: RawMsg & { channel: string }, channelType: ChannelType): void {
    this.pending.push({ raw, channelType })
  }

  take(): Queued[] {
    return this.pending.splice(0)
  }

  /** Disconnected: every tick. Connected: right after (re)connecting, then every `every`-th tick. */
  shouldPoll(every: number): boolean {
    if (!this.up || this.reconnected || this.skipped + 1 >= every) {
      this.reconnected = false
      this.skipped = 0
      return true
    }
    this.skipped++
    return false
  }

  notePolled(cursors: Record<string, string>): void {
    if (!this.up) return
    for (const [k, v] of Object.entries(cursors)) if (k.startsWith('hist:') || k.startsWith('thr:')) this.polled.set(k, v)
  }

  /** The item source of a queued message, or undefined when no polling source would have collected it. */
  source(q: Queued, cfg: Config, state: State): ItemSource | undefined {
    const { raw, channelType } = q
    if (channelType === 'im' || channelType === 'mpim') return channelType
    if (cfg.watchChannels.includes(raw.channel)) return 'channel'
    if (raw.text.includes(`<@${cfg.userId}>`)) return 'mention'
    if (raw.thread_ts && state.watchedThreads[`${raw.channel}:${raw.thread_ts}`]) return 'followup'
    return undefined
  }

  /** The cursor a collected socket message may advance (see `polled`), or undefined. */
  cursorKey(q: Queued, source: ItemSource, state: State, cmpTs: (a: string, b: string) => number): string | undefined {
    const { raw } = q
    let key: string | undefined
    if (source === 'im' || source === 'mpim') key = isReply(raw) ? undefined : `hist:${raw.channel}` // history never shows DM thread replies
    else if (source === 'channel') key = isReply(raw) ? `thr:${raw.channel}:${raw.thread_ts}` : `hist:${raw.channel}`
    else if (source === 'followup') key = `thr:${raw.channel}:${raw.thread_ts}`
    if (!key) return undefined
    const cur = state.cursors[key]
    const floor = this.polled.get(key)
    return cur !== undefined && floor !== undefined && cmpTs(cur, floor) >= 0 ? key : undefined
  }
}
