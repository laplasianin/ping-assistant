// Wires Slack collection, item state, Telegram and the MCP channel together.
// Invariant: only sendToSlack calls slack.postMessage, and only on Ilya's command from Telegram.
import type { Channel, ChannelHandlers } from './channel'
import { callbackData, type Command } from './commands'
import type { Config } from './config'
import { outcome, renderItem, renderProposal, renderThreadChanged, renderUpdate, slackify, type Keyboard } from './format'
import { ItemMessages, itemJson, lastPart, msgJson, withoutHint } from './item-messages'
import { ingest, mature, prune } from './items'
import type { RawMsg, SlackClient } from './slack/client'
import { applyCursors, cmpTs, type Collector } from './slack/collector'
import type { SlackSocket } from './slack/socket'
import { OWN_MSG, type Item, type ItemStatus, type SlackMsg, type State, type StateStore } from './state'
import type { Inbound, TelegramBot } from './telegram/bot'

export type OrchestratorDeps = {
  cfg: Config; store: Pick<StateStore, 'save'>; state: State; slack: SlackClient;
  collector: Pick<Collector, 'tick'> & Partial<Pick<Collector, 'socketConnected' | 'socketEpoch'>>; tg: TelegramBot; channel: Pick<Channel, 'notify'>; now?: () => number
  /** Socket Mode: ticks every drainSeconds and mostly drain the socket queue; polling reconciles every socketReconcileTicks. */
  socket?: Pick<SlackSocket, 'isConnected' | 'epoch' | 'reconnect' | 'lastFrameAt'> & Partial<Pick<SlackSocket, 'gaveUp'>>
}

const CLOSED: ItemStatus[] = ['sent', 'skipped', 'answered_manually']
/** No frame of any kind for this long: the connection is presumed half-open and is replaced. */
const SOCKET_SILENCE_MS = 10 * 60_000
/** A tick that changed nothing saves at most this often. */
const IDLE_SAVE_MS = 60_000
const DAY_MS = 86_400_000
/** Old closed items and index entries are pruned at most this often. */
const PRUNE_MS = 3_600_000

const log = (kind: string): void => { process.stderr.write(`ping-assistant: ${kind}\n`) }
const errName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown')
const isDm = (item: Item): boolean => item.source === 'im' || item.source === 'mpim'
export class Orchestrator {
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking: Promise<void> | undefined
  private readonly msgs: ItemMessages
  private lastTickEnd: number | undefined
  private lastSave: number | undefined
  /** The socket gave up for good: ticks run every pollSeconds, as without Socket Mode. */
  private pollingOnly = false
  private lastPrune: number | undefined

  constructor(private readonly d: OrchestratorDeps) {
    this.now = d.now ?? Date.now
    this.msgs = new ItemMessages(d.tg)
  }

  start(): void {
    const { tg, state, cfg } = this.d
    for (const item of Object.values(state.items)) {
      const { messageId, proposalMessageId, warningMessageId } = item.telegram
      for (const id of [messageId, proposalMessageId, warningMessageId]) if (id !== undefined) tg.registerMessage(id, item.id)
      // The session that was triaging it is gone: hand it to the new one on the next tick.
      if (item.status === 'triage') {
        item.status = 'settling'
        item.lastMessageAt = this.now() - cfg.settleSeconds * 1000
        item.telegram.triageAlerted = undefined
      }
    }
    tg.onInbound((i) => this.handle(i))
    this.schedule(this.d.socket ? cfg.drainSeconds : cfg.pollSeconds)
  }

  private schedule(seconds: number): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = setInterval(() => { void this.tick() }, seconds * 1000)
  }

  /** Without a socket there is nothing to drain: polling every drainSeconds would only burn Slack's rate limit. */
  private fallBackToPolling(): void {
    this.pollingOnly = true
    log(`socket gave up: polling every ${this.d.cfg.pollSeconds}s`)
    if (this.timer !== undefined) this.schedule(this.d.cfg.pollSeconds)
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Resolves when no tick is running; shutdown awaits it before the final save. */
  async idle(): Promise<void> {
    await this.ticking
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = this.runTick().finally(() => { this.ticking = undefined })
    return this.ticking
  }

  private async runTick(): Promise<void> {
    const { state, cfg, collector } = this.d
    let dirty = false
    try {
      const now = this.now()
      if (this.d.socket) {
        if (!this.pollingOnly && this.d.socket.gaveUp?.()) this.fallBackToPolling()
        if (!this.pollingOnly) this.checkSocket(this.d.socket, now)
        collector.socketConnected = this.d.socket.isConnected() // down: poll every tick
        collector.socketEpoch = this.d.socket.epoch() // a reconnect since the last tick: poll, trust no cursor
      }
      const batch = await collector.tick(now)
      dirty = batch.collected.length > 0 || batch.removeCursors.length > 0
      for (const { msg, source } of batch.collected) {
        const ev = ingest(state, msg, source, now, cfg)
        if (ev.kind === 'dropped') continue
        log(`event ${ev.kind}`)
        await this.safely(ev.kind, async () => {
          if (ev.kind === 'appended') await this.onAppended(state.items[ev.itemId]!, msg)
          if (ev.kind === 'answered_manually') {
            for (const id of ev.itemIds) await this.msgs.closeOriginal(state.items[id]!)
          }
        })
      }
      // Only now: every collected message is in msgIndex, so a restart from these cursors loses nothing.
      if (applyCursors(state, batch)) dirty = true
      const ripe = mature(state, now, cfg)
      if (ripe.length) dirty = true
      for (const item of ripe) await this.deliver(item)
      if (await this.triageWatchdog(now)) dirty = true
      if (this.lastPrune === undefined || now - this.lastPrune >= PRUNE_MS) {
        this.lastPrune = now
        if (prune(state, now, cfg)) dirty = true
      }
    } catch (err) {
      dirty = true
      log(`tick failed: ${errName(err)}`)
    } finally {
      // Socket mode ticks every few seconds and most drain nothing: an unchanged state is not rewritten each time.
      if (dirty || this.lastSave === undefined || this.now() - this.lastSave >= IDLE_SAVE_MS) this.save()
      this.lastTickEnd = this.now()
    }
  }

  /**
   * After sleep or a network change the WebSocket can stay half-open without a close event: a wall-clock gap
   * between ticks, or a connection that has been silent for 10 minutes, replaces it.
   */
  private checkSocket(socket: NonNullable<OrchestratorDeps['socket']>, now: number): void {
    const gap = this.lastTickEnd !== undefined && now - this.lastTickEnd > 2 * this.d.cfg.drainSeconds * 1000
    const frame = socket.lastFrameAt()
    if (gap) socket.reconnect('clock gap')
    else if (frame !== undefined && now - frame > SOCKET_SILENCE_MS) socket.reconnect('silent 10 min')
  }

  async handle(i: Inbound): Promise<void> {
    log(`command ${i.cmd.kind}`)
    await this.safely(`command ${i.cmd.kind}`, () => this.dispatch(i.cmd, i.messageId, i.button === true))
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
        await this.msgs.closeOriginal(item)
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
    // Send first and commit after: «N 2» / «N да» must never act on text Ilya has not seen.
    const show = async (text: string, keyboard: Keyboard): Promise<number> => {
      try {
        return await tg.send(text, keyboard, original)
      } catch (err) {
        throw new Error(`#${id}: Telegram send failed (${errName(err)}), item unchanged`)
      }
    }
    if (mode === 'final') {
      // Show exactly the text that will go to Slack; confirm sends it verbatim.
      const pendingText = slackify(variants[0] ?? '')
      const p = renderProposal(item, pendingText)
      const pid = await show(p.text, p.keyboard)
      await this.msgs.retire(item) // an older proposal or warning must not confirm this text
      Object.assign(item, { analysis, status: 'awaiting', pendingText, forceSend: undefined })
      item.telegram.proposalMessageId = pid
      item.telegram.chosen = undefined
      tg.registerMessage(pid, item.id)
      await this.msgs.annotate(item, '✏️ правка ниже')
      this.save()
      return `#${id}: final text shown to Ilya, waiting for confirmation`
    }
    const r = renderItem({ ...item, analysis, variants }, state.users, state.channels, this.now())
    const mid = await show(r.text, r.keyboard)
    await this.msgs.annotate(item, '✏️ правка ниже') // old message, still described by item.telegram
    await this.msgs.retire(item)
    Object.assign(item, { analysis, variants, status: 'awaiting', pendingText: undefined, forceSend: undefined })
    // Long items arrive in several messages; only the last one (with the buttons) is ever edited.
    item.telegram = { messageId: mid, text: withoutHint(lastPart(r.text)) || `#${item.id}` }
    tg.registerMessage(mid, item.id)
    this.save()
    return `#${id}: variants shown to Ilya`
  }

  /** A button acts only from the message that currently owns that action; older copies are stale. */
  private staleButton(item: Item, c: Command, messageId: number): boolean {
    const { messageId: original, proposalMessageId: proposal, warningMessageId: warning } = item.telegram
    switch (c.kind) {
      case 'choose': return messageId !== original
      // A live warning supersedes the proposal it was raised for.
      case 'confirm': return warning !== undefined || messageId !== proposal
      case 'force': return messageId !== warning
      case 'cancel': return warning !== undefined ? messageId !== warning : messageId !== proposal
      default: return false // skip sends nothing: allowed from any of the item's messages
    }
  }

  private async dispatch(c: Command, messageId: number, button = false): Promise<void> {
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
    const skippable = c.kind === 'skip' && item.status === 'triage' // from the «без разбора» reminder
    if (item.status !== 'awaiting' && !skippable) { await tg.send(`#${item.id} уже закрыт: ${outcome(item) || item.status}`); return }
    if (button && this.staleButton(item, c, messageId)) { await tg.send(`Кнопка устарела, см. #${item.id} ниже`); return }

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
        // «N да» after a thread-changed warning is the confirmation the warning asked for.
        return this.sendToSlack(item, item.pendingText, c.kind === 'force' || item.forceSend === true, item.telegram.chosen ?? 'custom')
      case 'skip':
        item.status = 'skipped'
        this.clearHeld(item)
        await this.msgs.retire(item)
        return this.msgs.closeOriginal(item)
      case 'cancel': {
        // A text «cancel» does not exist: messageId is the proposal or warning that carried the button.
        const isProposal = messageId === item.telegram.proposalMessageId
        const isWarning = messageId === item.telegram.warningMessageId && item.telegram.warningText !== undefined
        const text = isProposal && item.pendingText ? lastPart(renderProposal(item, item.pendingText).text)
          : isWarning ? item.telegram.warningText! : `#${item.id}`
        await this.msgs.edit(messageId, `${text}\n\n❌ отменено`)
        this.clearHeld(item)
        await this.msgs.retire(item, messageId)
        if (item.telegram.messageId !== undefined && item.variants) {
          const r = renderItem(item, state.users, state.channels, this.now())
          await this.msgs.edit(item.telegram.messageId, lastPart(r.text), r.keyboard)
        }
      }
    }
  }

  private async sendToSlack(item: Item, text: string, force: boolean, chosen?: number | 'custom'): Promise<void> {
    const { tg, slack, cfg, state } = this.d
    if (!force) {
      let fresh: SlackMsg[]
      let answered: boolean
      try {
        ({ fresh, answered } = await this.newMessages(item))
      } catch (err) {
        // Fail closed: an unverified conversation is treated like a changed one.
        log(`thread check failed: ${errName(err)}`)
        const warning = `⚠️ не смог проверить тред #${item.id} (${errName(err)}), нажми «Всё равно отправить» или повтори`
        return this.holdForForce(item, text, chosen, warning)
      }
      if (answered) return this.answeredMeanwhile(item)
      if (fresh.length) {
        return this.holdForForce(item, text, chosen, renderThreadChanged(item, fresh, state.users, state.channels).text)
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
    this.clearHeld(item)
    await this.msgs.annotate(item, outcome(item, chosen))
    const proposal = item.telegram.proposalMessageId
    if (proposal !== undefined) await this.msgs.edit(proposal, `${lastPart(renderProposal(item, text).text)}\n\n${outcome(item)}`)
    const warning = item.telegram.warningMessageId
    if (warning !== undefined) await this.msgs.dropKeyboard(warning)
    if (!cfg.dryRun) {
      const link = await slack.permalink(item.channel, item.sentTs).catch(() => undefined)
      await tg.send(`✅ отправлено${link ? `: ${link}` : ''}`, undefined, item.telegram.messageId)
    }
  }

  /** Keeps the text until Ilya forces («Всё равно отправить» / «N да») or cancels. */
  private async holdForForce(item: Item, text: string, chosen: number | 'custom' | undefined, warning: string): Promise<void> {
    const { tg } = this.d
    const { keyboard } = renderThreadChanged(item, [])
    const wid = await tg.send(warning, keyboard, item.telegram.messageId)
    // The new warning supersedes any older proposal or warning: their buttons must not send this text.
    // The proposal id is kept so its outcome can still be written there; staleButton refuses it while a warning is live.
    const { proposalMessageId, warningMessageId } = item.telegram
    for (const id of [proposalMessageId, warningMessageId]) if (id !== undefined) await this.msgs.dropKeyboard(id)
    item.pendingText = text
    item.forceSend = true
    item.telegram.chosen = typeof chosen === 'number' ? chosen : undefined
    item.telegram.warningMessageId = wid
    item.telegram.warningText = lastPart(warning) // a cancel keeps what the warning said
    tg.registerMessage(wid, item.id)
  }

  private clearHeld(item: Item): void {
    item.pendingText = undefined
    item.forceSend = undefined
    item.telegram.chosen = undefined
  }

  private watch(item: Item, threadTs: string, sentTs: string): void {
    const { state, cfg } = this.d
    item.threadTs = threadTs
    state.watchedThreads[`${item.channel}:${threadTs}`] = { until: this.now() + cfg.followUpDays * DAY_MS }
    state.cursors[`thr:${item.channel}:${threadTs}`] = sentTs // collector resumes after our reply
  }

  /**
   * Messages in the item's conversation newer than anything the session saw. Throws on Slack errors.
   * answered: Ilya already replied there himself (in the thread, or anywhere in a 1:1 IM); in an MPIM
   * his top-level message may address someone else, so it only counts as a change.
   */
  private async newMessages(item: Item): Promise<{ fresh: SlackMsg[]; answered: boolean }> {
    const { slack, cfg } = this.d
    // lastSeenTs may regress for out-of-order messages: use the max ts actually in the item.
    const floor = item.messages.reduce((m, x) => (cmpTs(x.ts, m) > 0 ? x.ts : m), item.lastSeenTs)
    const threadTs = item.threadTs ?? (isDm(item) ? undefined : item.messages[0]?.ts)
    const raws = (threadTs ? await slack.replies(item.channel, threadTs, floor) : await slack.history(item.channel, floor))
      .filter((r) => cmpTs(r.ts, floor) > 0 && r.user && !r.bot_id && r.subtype !== 'bot_message')
      // Messages already known (our own sends for sibling items, items already collected) are neither news nor Ilya's manual answer.
      // Ilya's own collected messages (OWN_MSG) still count: they may be his manual answer or a change.
      .filter((r) => { const known = this.d.state.msgIndex[`${item.channel}:${r.ts}`]; return !known || known === OWN_MSG })
    const ownCloses = (threadTs !== undefined || item.source === 'im')
      && !(cfg.dryRun && cfg.selfDmTest === true && item.channel === this.d.state.selfDmChannel) // selfDmTest: own self-DM messages are foreign
    const answered = ownCloses && raws.some((r) => r.user === cfg.userId)
    const fresh = raws.filter((r) => !ownCloses || r.user !== cfg.userId).map((r) => this.toMsg(r, item.channel))
    return { fresh, answered }
  }

  /** The pre-send check found Ilya's own reply: close the item instead of sending a second answer. */
  private async answeredMeanwhile(item: Item): Promise<void> {
    item.status = 'answered_manually'
    this.clearHeld(item)
    await this.msgs.retire(item)
    await this.msgs.closeOriginal(item)
    await this.d.tg.send(`🙈 #${item.id} — ты уже ответил в треде`, undefined, item.telegram.messageId)
  }

  private async onAppended(item: Item, msg: SlackMsg): Promise<void> {
    const { tg, state } = this.d
    // During triage Ilya has nothing to act on yet: only the session hears about the addendum.
    if (item.status === 'awaiting') {
      const id = await tg.send(renderUpdate(item, [msg], state.users, state.channels), undefined, item.telegram.messageId)
      tg.registerMessage(id, item.id)
    }
    await this.d.channel.notify(JSON.stringify({ id: item.id, newMessages: [msgJson(msg)] }), { kind: 'update', item_id: item.id })
  }

  /** Items the session has not answered for triageTimeoutSeconds: remind Ilya once and nudge the session again. */
  /** Returns whether it reminded about any item. */
  private async triageWatchdog(now: number): Promise<boolean> {
    const { cfg, tg } = this.d
    let acted = false
    for (const item of this.sorted()) {
      if (item.status !== 'triage' || item.telegram.triageAlerted) continue
      const since = item.triageAt ?? item.createdAt
      if (now - since < cfg.triageTimeoutSeconds * 1000) continue
      acted = true
      await this.safely('triage watchdog', async () => {
        const text = `⏳ #${item.id} без разбора уже ${Math.floor((now - since) / 60_000)} мин`
        const id = await tg.send(text, [[{ label: 'Пропустить', data: callbackData({ kind: 'skip', itemId: item.id }) }]])
        // The reminder stands in for the item message until propose replaces it: skip edits its outcome there.
        item.telegram = { ...item.telegram, messageId: id, text, triageAlerted: true }
        tg.registerMessage(id, item.id)
        await this.d.channel.notify(JSON.stringify(itemJson(item)), { kind: 'item', item_id: item.id })
      })
    }
    return acted
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

  /** Up to contextMessages before the item's first message: the thread, or one page of the conversation for top-level items. */
  private async context(item: Item): Promise<SlackMsg[]> {
    const first = item.messages[0]?.ts
    if (!first) return []
    const { slack, cfg } = this.d
    try {
      const raws = item.threadTs
        ? await slack.replies(item.channel, item.threadTs)
        : await slack.recent(item.channel, first, cfg.contextMessages)
      return raws.filter((r) => cmpTs(r.ts, first) < 0).slice(-this.d.cfg.contextMessages).map((r) => this.toMsg(r, item.channel))
    } catch (err) {
      log(`context failed: ${errName(err)}`)
      return []
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
    this.lastSave = this.now()
    try { this.d.store.save(this.d.state) } catch (err) { log(`state save failed: ${errName(err)}`) }
  }
}
