// Wires Slack collection, item state, Telegram and the MCP channel together.
// Invariant: only sendToSlack calls slack.postMessage, and only on Ilya's command from Telegram.
import type { Channel, ChannelHandlers } from './channel'
import type { Command } from './commands'
import type { Config } from './config'
import { outcome, renderItem, renderProposal, renderThreadChanged, renderUpdate, slackify, type Keyboard } from './format'
import { ingest, mature } from './items'
import type { RawMsg, SlackClient } from './slack/client'
import { cmpTs, type Collector } from './slack/collector'
import type { Item, ItemStatus, SlackMsg, State, StateStore } from './state'
import type { Inbound, TelegramBot } from './telegram/bot'

export type OrchestratorDeps = {
  cfg: Config; store: Pick<StateStore, 'save'>; state: State; slack: SlackClient;
  collector: Pick<Collector, 'tick'>; tg: TelegramBot; channel: Pick<Channel, 'notify'>; now?: () => number
}

const CLOSED: ItemStatus[] = ['sent', 'skipped', 'answered_manually']
const DAY_MS = 86_400_000

const log = (kind: string): void => { process.stderr.write(`ping-assistant: ${kind}\n`) }
const errName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown')
const isDm = (item: Item): boolean => item.source === 'im' || item.source === 'mpim'
/** The item's message text without the trailing «Ответь: …» hint line. */
const withoutHint = (text: string): string => text.slice(0, text.lastIndexOf('\n\n'))

const msgJson = (m: SlackMsg) => ({ ts: m.ts, user: m.user, userName: m.userName, text: m.text, ...(m.files ? { files: m.files } : {}) })

function itemJson(item: Item) {
  return {
    id: item.id, source: item.source, channel: item.channel, channelName: item.channelName, threadTs: item.threadTs,
    author: item.author, authorName: item.authorName,
    messages: item.messages.map(msgJson), context: item.context.map(msgJson),
    permalink: item.messages[0]?.permalink, files: item.messages.flatMap((m) => m.files ?? []),
  }
}

export class Orchestrator {
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false

  constructor(private readonly d: OrchestratorDeps) {
    this.now = d.now ?? Date.now
  }

  start(): void {
    const { tg, state, cfg } = this.d
    for (const item of Object.values(state.items)) {
      const { messageId, proposalMessageId } = item.telegram
      if (messageId !== undefined) tg.registerMessage(messageId, item.id)
      if (proposalMessageId !== undefined) tg.registerMessage(proposalMessageId, item.id)
    }
    tg.onInbound((i) => this.handle(i))
    this.timer = setInterval(() => { void this.tick() }, cfg.pollSeconds * 1000)
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    const { state, cfg, collector } = this.d
    try {
      const now = this.now()
      for (const { msg, source } of await collector.tick(now)) {
        const ev = ingest(state, msg, source, now, cfg)
        if (ev.kind === 'dropped') continue
        log(`event ${ev.kind}`)
        await this.safely(ev.kind, async () => {
          if (ev.kind === 'appended') await this.onAppended(state.items[ev.itemId]!, msg)
          if (ev.kind === 'answered_manually') {
            for (const id of ev.itemIds) await this.closeOriginal(state.items[id]!)
          }
        })
      }
      for (const item of mature(state, now, cfg)) await this.deliver(item)
    } catch (err) {
      log(`tick failed: ${errName(err)}`)
    } finally {
      this.save()
      this.ticking = false
    }
  }

  async handle(i: Inbound): Promise<void> {
    log(`command ${i.cmd.kind}`)
    await this.safely(`command ${i.cmd.kind}`, () => this.dispatch(i.cmd, i.messageId))
    this.save()
  }

  handlers(): ChannelHandlers {
    const { tg } = this.d
    const done = (text: string): string => { this.save(); return text }
    return {
      propose: (id, analysis, variants, mode) => this.propose(id, analysis, variants, mode),
      ignore: async (id, reason) => {
        const item = this.openItem(id)
        item.status = 'ignored'
        item.ignoreReason = reason
        return done(`#${id} ignored`)
      },
      close: async (id) => {
        const item = this.openItem(id)
        item.status = 'skipped'
        item.pendingText = undefined
        await this.closeOriginal(item)
        return done(`#${id} closed`)
      },
      listItems: async (status) => {
        const items = this.sorted().filter((i) => !status || i.status === status)
        if (!items.length) return 'нет айтемов'
        return items.map((i) => {
          const text = (i.messages[0]?.text ?? '').replace(/\s+/g, ' ').slice(0, 60)
          return `#${i.id} [${i.status}] #${this.channelName(i)} ${this.authorName(i)}: ${text}`
        }).join('\n')
      },
      listIgnored: async (sinceHours) => {
        const since = this.now() - sinceHours * 3_600_000
        const items = this.sorted().filter((i) => i.status === 'ignored' && i.createdAt >= since)
        if (!items.length) return 'ничего не проигнорировано'
        return items.map((i) => `#${i.id} #${this.channelName(i)} ${this.authorName(i)} — ${i.ignoreReason ?? ''}`).join('\n')
      },
      say: async (text) => {
        await tg.send(text)
        return 'sent to Telegram'
      },
    }
  }

  private async propose(id: string, analysis: string, variants: string[], mode: 'variants' | 'final'): Promise<string> {
    const { tg, state } = this.d
    const item = this.openItem(id)
    const original = item.telegram.messageId
    item.analysis = analysis
    item.status = 'awaiting'
    if (mode === 'final') {
      // Show exactly the text that will go to Slack; confirm sends it verbatim.
      item.pendingText = slackify(variants[0] ?? '')
      const p = renderProposal(item, item.pendingText)
      const pid = await tg.send(p.text, p.keyboard, original)
      item.telegram.proposalMessageId = pid
      tg.registerMessage(pid, item.id)
      await this.annotate(item, '✏️ правка ниже')
      this.save()
      return `#${id}: final text shown to Ilya, waiting for confirmation`
    }
    await this.annotate(item, '✏️ новые варианты ниже')
    item.variants = variants
    item.pendingText = undefined
    const r = renderItem(item, state.users, state.channels, this.now())
    const mid = await tg.send(r.text, r.keyboard, original)
    item.telegram = { messageId: mid, text: withoutHint(r.text) }
    tg.registerMessage(mid, item.id)
    this.save()
    return `#${id}: variants shown to Ilya`
  }

  private async dispatch(c: Command, messageId: number): Promise<void> {
    const { state, tg } = this.d
    if (c.kind === 'forward') {
      const item = c.itemId ? state.items[c.itemId] : undefined
      if (item) {
        const body = { id: item.id, request: c.text, variants: item.variants ?? [], analysis: item.analysis ?? '' }
        await this.d.channel.notify(JSON.stringify(body), { kind: 'revise', item_id: item.id })
      } else {
        await this.d.channel.notify(JSON.stringify({ text: c.text, ...(c.itemId ? { itemId: c.itemId } : {}) }), { kind: 'chat' })
      }
      return
    }
    const item = state.items[c.itemId]
    if (!item) { await tg.send(`Не знаю айтем #${c.itemId}`); return }
    if (item.status !== 'awaiting') { await tg.send(`#${item.id} уже закрыт: ${outcome(item) || item.status}`); return }

    switch (c.kind) {
      case 'choose': {
        const variant = item.variants?.[c.n - 1]
        if (c.n < 1 || variant === undefined) { await tg.send(`Нет варианта ${c.n} у #${item.id}`); return }
        return this.sendToSlack(item, slackify(variant), false, c.n)
      }
      case 'custom':
        return this.sendToSlack(item, slackify(c.text), false, 'custom')
      case 'confirm':
      case 'force':
        if (!item.pendingText) { await tg.send(`#${item.id}: нет текста, ожидающего отправки`); return }
        return this.sendToSlack(item, item.pendingText, c.kind === 'force')
      case 'skip':
        item.status = 'skipped'
        item.pendingText = undefined
        return this.closeOriginal(item)
      case 'cancel': {
        const isProposal = messageId === item.telegram.proposalMessageId
        const text = isProposal && item.pendingText ? renderProposal(item, item.pendingText).text : `#${item.id}`
        await this.edit(messageId, `${text}\n\n❌ отменено`)
        item.pendingText = undefined
        if (item.telegram.messageId !== undefined && item.variants) {
          const r = renderItem(item, state.users, state.channels, this.now())
          await this.edit(item.telegram.messageId, r.text, r.keyboard)
        }
      }
    }
  }

  private async sendToSlack(item: Item, text: string, force: boolean, chosen?: number | 'custom'): Promise<void> {
    const { tg, slack, cfg, state } = this.d
    if (!force) {
      const fresh = await this.newForeignMessages(item)
      if (fresh.length) {
        item.pendingText = text
        const r = renderThreadChanged(item, fresh, state.users, state.channels)
        tg.registerMessage(await tg.send(r.text, r.keyboard, item.telegram.messageId), item.id)
        return
      }
    }
    if (cfg.dryRun) {
      const where = item.messages[0]?.permalink ?? `#${this.channelName(item)}`
      await tg.send(`🧪 dry-run, отправил бы в ${where}:\n${text}`, undefined, item.telegram.messageId)
      item.sentTs = 'dry-run'
    } else {
      const threadTs = item.threadTs ?? (isDm(item) ? undefined : item.messages[0]?.ts)
      try {
        item.sentTs = (await slack.postMessage(item.channel, text, threadTs)).ts
      } catch (err) {
        await tg.send(`#${item.id}: не удалось отправить в Slack (${err instanceof Error ? err.message : 'unknown'})`)
        return
      }
      state.msgIndex[`${item.channel}:${item.sentTs}`] = item.id
      if (threadTs) this.watch(item, threadTs, item.sentTs)
    }
    item.status = 'sent'
    item.pendingText = undefined
    await this.annotate(item, outcome(item, chosen))
    const proposal = item.telegram.proposalMessageId
    if (proposal !== undefined) await this.edit(proposal, `${renderProposal(item, text).text}\n\n${outcome(item)}`)
    if (!cfg.dryRun) {
      const link = await slack.permalink(item.channel, item.sentTs).catch(() => undefined)
      await tg.send(`✅ отправлено${link ? `: ${link}` : ''}`, undefined, item.telegram.messageId)
    }
  }

  private watch(item: Item, threadTs: string, sentTs: string): void {
    const { state, cfg } = this.d
    item.threadTs = threadTs
    state.watchedThreads[`${item.channel}:${threadTs}`] = { until: this.now() + cfg.followUpDays * DAY_MS }
    state.cursors[`thr:${item.channel}:${threadTs}`] = sentTs // collector resumes after our reply
  }

  /** Messages from others in the item's conversation newer than anything the session saw. */
  private async newForeignMessages(item: Item): Promise<SlackMsg[]> {
    const { slack, cfg } = this.d
    // lastSeenTs may regress for out-of-order messages: use the max ts actually in the item.
    const floor = item.messages.reduce((m, x) => (cmpTs(x.ts, m) > 0 ? x.ts : m), item.lastSeenTs)
    const threadTs = item.threadTs ?? (isDm(item) ? undefined : item.messages[0]?.ts)
    try {
      const raws = threadTs ? await slack.replies(item.channel, threadTs, floor) : await slack.history(item.channel, floor)
      return raws
        .filter((r) => cmpTs(r.ts, floor) > 0 && r.user && r.user !== cfg.userId && !r.bot_id && r.subtype !== 'bot_message')
        .map((r) => this.toMsg(r, item.channel))
    } catch (err) {
      log(`thread check failed: ${errName(err)}`)
      return []
    }
  }

  private async onAppended(item: Item, msg: SlackMsg): Promise<void> {
    const { tg, state } = this.d
    const id = await tg.send(renderUpdate(item, [msg], state.users, state.channels), undefined, item.telegram.messageId)
    tg.registerMessage(id, item.id)
    await this.d.channel.notify(JSON.stringify({ id: item.id, newMessages: [msgJson(msg)] }), { kind: 'update', item_id: item.id })
  }

  private async deliver(item: Item): Promise<void> {
    item.channelName ??= this.d.state.channels[item.channel]
    item.context = await this.context(item)
    try {
      await this.d.channel.notify(JSON.stringify(itemJson(item)), { kind: 'item', item_id: item.id })
    } catch (err) {
      item.status = 'settling' // matures again on the next tick
      log(`notify item failed: ${errName(err)}`)
    }
  }

  /** v1: thread history up to the item's first message; top-level conversations get no context. */
  private async context(item: Item): Promise<SlackMsg[]> {
    const first = item.messages[0]?.ts
    if (!item.threadTs || !first) return []
    try {
      const raws = await this.d.slack.replies(item.channel, item.threadTs)
      return raws.filter((r) => cmpTs(r.ts, first) < 0).slice(-this.d.cfg.contextMessages).map((r) => this.toMsg(r, item.channel))
    } catch (err) {
      log(`context failed: ${errName(err)}`)
      return []
    }
  }

  /** Edits the item's Telegram message to its final outcome (buttons removed). */
  private closeOriginal(item: Item): Promise<void> {
    return this.annotate(item, outcome(item))
  }

  private async annotate(item: Item, line: string): Promise<void> {
    const { messageId, text } = item.telegram
    if (messageId === undefined || !text) return
    await this.edit(messageId, `${text}\n\n${line}`)
  }

  private async edit(messageId: number, text: string, keyboard?: Keyboard): Promise<void> {
    try {
      await this.d.tg.edit(messageId, text, keyboard)
    } catch (err) {
      if (err instanceof Error && err.message.includes('message is not modified')) return
      log(`telegram edit failed: ${errName(err)}`)
    }
  }

  private async safely(what: string, fn: () => Promise<void>): Promise<void> {
    try { await fn() } catch (err) { log(`${what} failed: ${errName(err)}`) }
  }

  private openItem(id: string): Item {
    const item = this.d.state.items[id]
    if (!item) throw new Error(`unknown item #${id}`)
    if (CLOSED.includes(item.status)) throw new Error(`#${id} is already ${item.status}`)
    return item
  }

  private toMsg(r: RawMsg, channel: string): SlackMsg {
    const user = r.user ?? ''
    return { channel, ts: r.ts, threadTs: r.thread_ts, user, userName: this.d.state.users[user], text: r.text }
  }

  private sorted(): Item[] {
    return Object.values(this.d.state.items).sort((a, b) => a.seq - b.seq || a.sub - b.sub)
  }

  private channelName(i: Item): string {
    return i.channelName ?? this.d.state.channels[i.channel] ?? i.channel
  }

  private authorName(i: Item): string {
    return i.authorName ?? this.d.state.users[i.author] ?? i.author
  }

  private save(): void {
    try { this.d.store.save(this.d.state) } catch (err) { log(`state save failed: ${errName(err)}`) }
  }
}
