# Ping Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Один MCP channel-сервер на Bun, который собирает вопросы к Илье из Slack, присылает их с разбором и вариантами в Telegram и по механическому решению Ильи отправляет выбранный вариант в Slack от его имени.

**Architecture:** Один процесс `ping-assistant` = Slack-коллектор (poll раз в минуту) + Telegram-бот (grammY) + MCP channel-сервер для сессии Claude Code. Модель получает созревшие айтемы через `notifications/claude/channel`, возвращает разбор и варианты инструментом `propose`; отправку в Slack делает только сервер, только по команде Ильи из Telegram (кнопка или текст), дословно. Состояние — один JSON-файл с атомарной записью.

**Tech Stack:** Bun ≥ 1.1 (runtime + `bun test`), TypeScript strict, `@modelcontextprotocol/sdk`, `grammy`, `zod`; Slack Web API через `fetch` (без SDK). Сессия: Claude Code с `--plugin-dir` + `--channels`.

**Spec:** `docs/superpowers/specs/2026-10-19-ping-assistant-design.md`

## Global Constraints

- Код — TypeScript strict; никакого Python и логики в shell (кроме `bin/ping-assistant-up`, который только запускает процесс).
- Модель **не имеет** инструмента отправки в Slack. Единственная точка `chat.postMessage` — `Orchestrator.sendToSlack`, вызывается только из обработчика команд Telegram.
- Текст, отправляемый в Slack, равен байт в байт тексту варианта, который Илья видел в Telegram (после `slackify`, §Task 4).
- Secrets только из `~/.config/ping-assistant/.env` (`SLACK_USER_TOKEN`, `TELEGRAM_BOT_TOKEN`); файл не в репозитории; `.gitignore` содержит `.env`, `ping-assistant.config.json`, `state.json`.
- Slack user-scopes: `channels:history channels:read groups:history groups:read im:history im:read mpim:history mpim:read users:read search:read chat:write files:read`.
- Значения по умолчанию: `pollSeconds=60`, `settleSeconds=90`, `maxSettleSeconds=300`, `followUpDays=7`, `contextMessages=30`.
- Telegram: только личка, только `telegramChatId` из конфига; сообщения от любого другого chat/user отбрасываются молча. Лимит 4096 символов.
- Новое сообщение в Telegram для всего, на что нужна реакция; правка существующего — только для фиксации исхода.
- Коммиты: `git commit -s`, conventional prefix (`feat:`, `test:`, `chore:`).

## Review Focus

1. Slack-разметка во входящих (`<@U123>`, `<#C1|general>`, `<https://x|текст>`, `&amp;`) должна приходить в Telegram читаемой — тест в Task 4 (`humanizeSlack`).
2. Айтем длиннее 4096 символов не должен терять кнопки и не должен падать — тест в Task 4 (`chunk` держит клавиатуру на последнем куске).
3. Slack 429 с `Retry-After` не должен ронять тик и не должен терять курсор — тест в Task 5 (`SlackClient` ретраит один раз, `Collector.tick` при ошибке источника оставляет его курсор прежним).
4. Служебные сообщения Slack (`subtype: message_changed|message_deleted|channel_join|bot_message`) не становятся айтемами — тест в Task 5 (`Collector` фильтрует subtypes, кроме `thread_broadcast` и `file_share`).
5. Перезапуск посреди `settling` не теряет буфер и айтем созревает после рестарта — тест в Task 3 (`mature` на состоянии, загруженном с диска).

---

## Структура файлов

```
~/projects/ping-assistant/
  .claude-plugin/plugin.json      манифест плагина (name: "ping-assistant")
  .mcp.json                        запуск сервера: bun run src/main.ts
  .claude/settings.json            allowlist инструментов для безнадзорной сессии
  CLAUDE.md                        инструкции сессии (триаж, формат, инструменты)
  package.json tsconfig.json .gitignore
  ping-assistant.config.example.json     образец конфига
  team.md                          факты о команде (шаблон, заполняет Илья)
  bin/ping-assistant-up                  caffeinate + claude --plugin-dir . --channels plugin:ping-assistant
  src/
    main.ts            сборка: config → state → slack → telegram → channel → orchestrator
    config.ts          Config, loadConfig(), loadSecrets()
    state.ts           типы Item/State, StateStore (load/save атомарно)
    items.ts           чистая логика: ingest(), mature(), conversationKey()
    commands.ts        чистый парсер команд Telegram: parseText(), parseCallback()
    format.ts          чистые рендеры: humanizeSlack(), slackify(), renderItem(), renderProposal(), renderThreadChanged(), outcome(), chunk()
    slack/client.ts    SlackClient (fetch, ретраи, пагинация)
    slack/collector.ts Collector.tick(): источники → SlackMsg[] + курсоры
    telegram/bot.ts    TelegramBot: grammY, allowlist, send/edit, inbound → Command
    channel.ts         Channel: MCP-сервер, tools propose/ignore/close/list_items/list_ignored, notify()
    orchestrator.ts    Orchestrator: таймер, созревание → notify, команды → отправка/форвард, follow-ups
  test/*.test.ts       bun test
```

---

### Task 1: Скаффолд и спайк channel-протокола

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.claude-plugin/plugin.json`, `.mcp.json`, `src/main.ts` (временный спайк), `README.md`

**Interfaces:**
- Produces: рабочий способ запуска сессии с локальным channel-плагином; подтверждённые имена: метод уведомления `notifications/claude/channel`, capability `experimental['claude/channel']`, формат `<channel source="ping-assistant" …>` в сессии.

- [ ] **Step 1: Установить Bun и инициализировать репозиторий**

```bash
curl -fsSL https://bun.sh/install | bash   # или: brew install oven-sh/bun/bun
cd ~/projects/ping-assistant && git init && bun init -y
bun add @modelcontextprotocol/sdk grammy zod && bun add -d @types/bun typescript
```
`tsconfig.json`: `"strict": true, "module": "ESNext", "moduleResolution": "bundler", "types": ["bun-types"]`.
`.gitignore`: `node_modules/ .env ping-assistant.config.json state.json`.
Скопировать `docs/superpowers/specs/2026-10-19-ping-assistant-design.md` и этот план уже лежат в `docs/superpowers/`; закоммитить их вместе со скаффолдом.

- [ ] **Step 2: Манифест плагина и .mcp.json**

`.claude-plugin/plugin.json`: `{ "name": "ping-assistant", "description": "Slack inbox for Ilya: triage, drafts, send-as-me", "version": "0.1.0" }`
`.mcp.json`: `{ "mcpServers": { "ping-assistant": { "command": "bun", "args": ["run", "${CLAUDE_PLUGIN_ROOT}/src/main.ts"] } } }`

- [ ] **Step 3: Спайк-сервер `src/main.ts`**

Минимальный MCP-сервер по образцу `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7/server.ts` (строки 390–420 и 1000+): `new Server({name:'ping-assistant',version:'0.1.0'}, {capabilities:{tools:{}, experimental:{'claude/channel':{}}}, instructions:'…'})`, один инструмент `ping` (возвращает `pong`), и `setInterval` на 20 с, который шлёт `mcp.notification({method:'notifications/claude/channel', params:{content:'tick', meta:{source:'ping-assistant', kind:'tick'}}})`. Завершение по `stdin end/close` как в образце.

- [ ] **Step 4: Проверить, что сессия просыпается от уведомления**

Run: `cd ~/projects/ping-assistant && claude --plugin-dir . --channels plugin:ping-assistant`
Expected: в сессии в течение ~20 с появляется входящее `<channel source="ping-assistant" …>tick</channel>`, и `ping` виден среди инструментов (попросить сессию вызвать `ping` → `pong`).
Если `--channels plugin:ping-assistant` не принимает локальный плагин: попробовать `plugin:ping-assistant@local`, затем значение из `claude plugin details ping-assistant`. Записать работающую команду в `README.md`. Если channel-уведомления не будят сессию никаким способом — остановиться и зафиксировать в README: включается запасной вариант из §4 спеки (`/loop 1m` + инструмент `next_items`), план Task 7/8 меняется соответственно.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -s -m "chore: scaffold ping-assistant plugin with channel spike"
```

---

### Task 2: Конфиг и хранилище состояния

**Files:**
- Create: `src/config.ts`, `src/state.ts`, `ping-assistant.config.example.json`
- Test: `test/config.test.ts`, `test/state.test.ts`

**Interfaces:**
- Produces:
```ts
// config.ts
export type Config = {
  userId: string; watchChannels: string[]; telegramChatId: string;
  pollSeconds: number; settleSeconds: number; maxSettleSeconds: number;
  followUpDays: number; contextMessages: number; scentbirdRepoPath: string;
  dryRun: boolean; statePath: string;
}
export function loadConfig(path = 'ping-assistant.config.json'): Config   // zod, дефолты из Global Constraints, statePath default ~/.config/ping-assistant/state.json
export function loadSecrets(envPath = '~/.config/ping-assistant/.env'): { slackToken: string; telegramToken: string }  // KEY=VALUE построчно; process.env приоритетнее; отсутствие ключа → throw с именем ключа

// state.ts
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
export function emptyState(): State
export class StateStore { constructor(path: string); load(): State; save(state: State): void /* tmp + rename */ }
```

- [ ] **Step 1: Тесты конфига**

```ts
test('loadConfig applies defaults', ()=> { /* файл с userId, watchChannels, telegramChatId, scentbirdRepoPath */ expect(cfg.pollSeconds).toBe(60); expect(cfg.settleSeconds).toBe(90); expect(cfg.maxSettleSeconds).toBe(300); expect(cfg.followUpDays).toBe(7); expect(cfg.contextMessages).toBe(30); expect(cfg.dryRun).toBe(false) })
test('loadConfig rejects missing userId', ()=> expect(()=>loadConfig(p)).toThrow(/userId/))
test('loadSecrets reads env file and prefers process.env', ...)
test('loadSecrets throws naming the missing key', ()=> expect(()=>loadSecrets(p)).toThrow(/TELEGRAM_BOT_TOKEN/))
```

- [ ] **Step 2: Run → FAIL** `bun test test/config.test.ts`
- [ ] **Step 3: Реализовать `src/config.ts`**
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Тесты состояния**

```ts
test('load on missing file returns emptyState with nextSeq 1')
test('save then load round-trips items and cursors')
test('save is atomic: no .tmp left behind, file parses')
```

- [ ] **Step 6: Run → FAIL; реализовать `src/state.ts`; Run → PASS**
- [ ] **Step 7: Commit** `git add src/config.ts src/state.ts test/ ping-assistant.config.example.json && git commit -s -m "feat: config and state store"`

---

### Task 3: Группировка сообщений в айтемы (чистая логика)

**Files:**
- Create: `src/items.ts`
- Test: `test/items.test.ts`

**Interfaces:**
- Consumes: `State`, `Item`, `SlackMsg`, `Config` (Task 2).
- Produces:
```ts
export function conversationKey(m: SlackMsg): string              // `${channel}:${threadTs ?? ''}`
export type IngestEvent =
  | { kind: 'dropped'; reason: 'duplicate'|'own'|'bot' }
  | { kind: 'buffered'; itemId: string }                           // новый или существующий settling-айтем
  | { kind: 'appended'; itemId: string }                           // к awaiting-айтему → нужен «#N дополнение»
  | { kind: 'answered_manually'; itemIds: string[] }               // сообщение Ильи закрыло settling/awaiting в этом разговоре
  | { kind: 'followup'; itemId: string }                           // новая реплика в наблюдаемом треде → новый айтем `${seq}.${sub+1}`
export function ingest(state: State, m: SlackMsg, source: ItemSource, now: number, cfg: Config): IngestEvent   // мутирует state
export function mature(state: State, now: number, cfg: Config): Item[]   // settling → triage по settleSeconds/maxSettleSeconds; возвращает созревшие
export function nextItemId(state: State): string                   // `${nextSeq++}`
```
Правила: буфер — settling-айтем с тем же `conversationKey` и `author`; `lastMessageAt` обновляется; `appended` — если есть awaiting-айтем того же ключа и автора; `own` — `m.user === cfg.userId` (перед дропом закрывает settling/awaiting того же ключа как `answered_manually`); `followup` — ключ есть в `watchedThreads`, автор не Илья, нет открытого settling/awaiting того же ключа+автора; id follow-up = `${parent.seq}.${maxSub+1}`, где parent — последний sent-айтем этого ключа; `msgIndex` ведётся для каждого принятого сообщения.

- [ ] **Step 1: Тесты**

```ts
test('six messages from one author within settle window become one item')      // анти-дробление
test('message after settleSeconds silence matures the item')                   // mature → status 'triage', length 1
test('buffer older than maxSettleSeconds matures even if author keeps typing')
test('duplicate channel:ts is dropped')
test('own message closes settling and awaiting items in the conversation as answered_manually')
test('message from same author while awaiting is appended, not a new item')
test('different authors in one thread produce separate items')
test('reply in watched thread creates followup item 14.2 with parent seq')
test('bot message is dropped')                                                 // m.user === '' или m.bot
test('mature works on state loaded from disk')                                 // Review Focus 5: save → load → mature
```

- [ ] **Step 2: Run → FAIL** `bun test test/items.test.ts`
- [ ] **Step 3: Реализовать `src/items.ts`**
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** `git commit -s -m "feat: item grouping and settling"`

---

### Task 4: Парсер команд и рендеры Telegram (чистые)

**Files:**
- Create: `src/commands.ts`, `src/format.ts`
- Test: `test/commands.test.ts`, `test/format.test.ts`

**Interfaces:**
- Produces:
```ts
// commands.ts
export type Command =
  | { kind: 'choose'; itemId: string; n: number }
  | { kind: 'skip'; itemId: string }
  | { kind: 'custom'; itemId: string; text: string }       // «14: текст»
  | { kind: 'confirm'; itemId: string }                    // «14 да» / кнопка Отправить
  | { kind: 'force'; itemId: string }                      // кнопка «Всё равно отправить»
  | { kind: 'cancel'; itemId: string }
  | { kind: 'forward'; itemId?: string; text: string }     // всё остальное → в сессию
export function parseText(text: string, quotedItemId?: string): Command
export function parseCallback(data: string): Command | null   // `pa:choose:14:2` `pa:skip:14` `pa:confirm:14` `pa:force:14` `pa:cancel:14`
export function callbackData(cmd: Exclude<Command,{kind:'forward'|'custom'}>): string

// format.ts
export type Keyboard = { label: string; data: string }[][]
export function humanizeSlack(text: string, users: Record<string,string>, channels: Record<string,string>): string  // <@U1>→@Имя, <#C1|name>→#name, <url|t>→t (url), &amp;&lt;&gt; → символы
export function slackify(text: string): string                 // обратное для исходящего: @Имя остаётся текстом, markdown ** → *, `код` как есть; ничего не изобретать сверх этого
export function renderItem(item: Item, users, channels, now: number): { text: string; keyboard: Keyboard }   // формат из §5.4, кнопки 1..N + «Пропустить»
export function renderUpdate(item: Item, newMsgs: SlackMsg[]): string          // «#14 дополнение»
export function renderProposal(item: Item, text: string): { text: string; keyboard: Keyboard }   // «Отправить»/«Отмена» → pa:confirm / pa:cancel
export function renderThreadChanged(item: Item, newMsgs: SlackMsg[]): { text: string; keyboard: Keyboard }   // «Всё равно отправить»/«Отмена» → pa:force / pa:cancel
export function outcome(item: Item): string                    // '✅ отправлен вариант 2' | '✅ отправлено (свой текст)' | '⏭ пропущен' | '✏️ правка ниже' | '🙈 отвечено вручную'
export function chunk(text: string, limit = 4096): string[]     // по абзацам
```

- [ ] **Step 1: Тесты парсера**

```ts
expect(parseText('14 2')).toEqual({kind:'choose', itemId:'14', n:2})
expect(parseText('14.2 1')).toEqual({kind:'choose', itemId:'14.2', n:1})
expect(parseText('14 пропустить')).toEqual({kind:'skip', itemId:'14'})
expect(parseText('14: привет, да')).toEqual({kind:'custom', itemId:'14', text:'привет, да'})
expect(parseText('14 да')).toEqual({kind:'confirm', itemId:'14'})
expect(parseText('14 2, но без тикета')).toEqual({kind:'forward', itemId:'14', text:'2, но без тикета'})
expect(parseText('14 ещё')).toEqual({kind:'forward', itemId:'14', text:'ещё'})
expect(parseText('2', '14')).toEqual({kind:'choose', itemId:'14', n:2})            // цитата даёт id
expect(parseText('что ты проигнорировал сегодня?')).toEqual({kind:'forward', text:'что ты проигнорировал сегодня?'})
expect(parseCallback('pa:choose:14:2')).toEqual({kind:'choose', itemId:'14', n:2})
expect(parseCallback('perm:allow:abcde')).toBeNull()
expect(parseCallback(callbackData({kind:'force', itemId:'14.2'}))).toEqual({kind:'force', itemId:'14.2'})
```

- [ ] **Step 2: Run → FAIL; реализовать `src/commands.ts`; Run → PASS**
- [ ] **Step 3: Тесты рендеров**

```ts
test('humanizeSlack replaces user, channel, link and entities')   // Review Focus 1
test('renderItem header has id, channel, author, age and N+1 buttons', ()=> { expect(text.startsWith('#14 · #pathfinders · Max Darski ·')).toBe(true); expect(keyboard[0].map(b=>b.label)).toEqual(['1','2','3','Пропустить']) })
test('renderItem lists all questions when analysis has several')
test('renderProposal has Отправить/Отмена with pa:confirm/pa:cancel')
test('chunk keeps paragraphs and never exceeds limit')            // Review Focus 2 (клавиатура вешается на последний кусок — проверяется в Task 6)
test('slackify converts **bold** to *bold* and leaves text otherwise unchanged')
```

- [ ] **Step 4: Run → FAIL; реализовать `src/format.ts`; Run → PASS**
- [ ] **Step 5: Commit** `git commit -s -m "feat: telegram command parser and renderers"`

---

### Task 5: Slack-клиент и коллектор

**Files:**
- Create: `src/slack/client.ts`, `src/slack/collector.ts`
- Test: `test/slack-client.test.ts`, `test/collector.test.ts`

**Interfaces:**
- Consumes: `SlackMsg`, `State`, `Config`.
- Produces:
```ts
// client.ts — все методы через fetch('https://slack.com/api/<method>'), токен в Authorization: Bearer
export class SlackClient {
  constructor(token: string, fetchImpl: typeof fetch = fetch)
  history(channel: string, oldestTs?: string): Promise<RawMsg[]>             // conversations.history, пагинация по cursor, limit 200
  replies(channel: string, threadTs: string, oldestTs?: string): Promise<RawMsg[]>   // conversations.replies, без корневого сообщения если oldestTs задан
  searchMentions(userId: string, afterDate: string /*YYYY-MM-DD*/): Promise<RawMsg[]>  // search.messages query `<@${userId}> after:${afterDate}`, sort timestamp asc
  listDms(): Promise<{ id: string; type: 'im'|'mpim' }[]>                     // users.conversations types=im,mpim
  channelName(id: string): Promise<string>                                   // conversations.info, кэш в вызывающем
  userName(id: string): Promise<string>                                      // users.info → real_name || name
  permalink(channel: string, ts: string): Promise<string>                    // chat.getPermalink
  postMessage(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>   // chat.postMessage
  downloadFile(url: string, dest: string): Promise<void>                     // url_private_download с Bearer
}
export type RawMsg = { ts: string; thread_ts?: string; user?: string; bot_id?: string; subtype?: string; text: string; files?: {id:string;name:string;url_private_download?:string}[]; channel?: string }
// Ошибки: ok:false → throw Error(`slack ${method}: ${error}`); 429 → ждать Retry-After (сек) и повторить один раз.

// collector.ts
export class Collector {
  constructor(slack: SlackClient, cfg: Config, state: State, filesDir: string)
  tick(now: number): Promise<{ msg: SlackMsg; source: ItemSource }[]>
}
```
`tick`: (1) для каждого IM/MPIM — `history` с `cursors['hist:'+id]`; (2) `searchMentions` с даты `cursors.search` (дата) и дедуп по `msgIndex`; (3) для каждого `watchChannels` — `history` + для корней тредов с активностью за `followUpDays` — `replies`; (4) для `watchedThreads` — `replies`. Фильтр: `subtype` ∈ {`message_changed`,`message_deleted`,`channel_join`,`channel_leave`,`bot_message`,`channel_topic`} → пропуск; `bot_id` → пропуск; файлы скачиваются в `filesDir`; `userName`/`channelName` кэшируются в `state.users/channels`; курсор источника двигается только после успешного чтения источника; ошибка одного источника логируется в stderr и не прерывает остальные. При первом запуске (нет курсора) курсор = `now` без чтения прошлого.

- [ ] **Step 1: Тесты клиента (fetchImpl-мок)**

```ts
test('history paginates on response_metadata.next_cursor')
test('throws on ok:false with method and error')
test('retries once after 429 honoring Retry-After')           // Review Focus 3
test('postMessage sends thread_ts when given')
```

- [ ] **Step 2: Run → FAIL; реализовать `src/slack/client.ts`; Run → PASS**
- [ ] **Step 3: Тесты коллектора (fake SlackClient)**

```ts
test('first tick sets cursors to now and returns nothing')
test('dm message is returned with source im and cursor advanced')
test('mention found by search is deduped against msgIndex')
test('watched channel thread replies are fetched')
test('subtypes message_changed/channel_join/bot_message are skipped; thread_broadcast kept')   // Review Focus 4
test('failing source keeps its cursor and does not block others')                           // Review Focus 3
```

- [ ] **Step 4: Run → FAIL; реализовать `src/slack/collector.ts`; Run → PASS**
- [ ] **Step 5: Commit** `git commit -s -m "feat: slack client and collector"`

---

### Task 6: Telegram-бот

**Files:**
- Create: `src/telegram/bot.ts`
- Test: `test/telegram-bot.test.ts` (grammY `Bot` с `botInfo` и подменённым `api.config.use`-transformer, либо тонкая обёртка `TelegramApi` интерфейсом с моком)

**Interfaces:**
- Consumes: `Command`, `parseText`, `parseCallback`, `Keyboard`, `chunk`.
- Produces:
```ts
export type Inbound = { cmd: Command; messageId: number; quotedMessageId?: number }
export class TelegramBot {
  constructor(token: string, chatId: string, api?: TelegramApi)             // TelegramApi = { sendMessage, editMessageText, editMessageReplyMarkup, answerCallbackQuery } — для тестов
  onInbound(handler: (i: Inbound) => Promise<void>): void
  send(text: string, keyboard?: Keyboard, replyTo?: number): Promise<number>   // chunk(); клавиатура на последнем куске; возвращает id последнего
  edit(messageId: number, text: string, keyboard?: Keyboard): Promise<void>  // keyboard undefined → убрать кнопки
  resolveItemId(quotedMessageId: number): string | undefined                 // по карте messageId→itemId, которую заполняет Orchestrator через registerMessage(messageId, itemId)
  registerMessage(messageId: number, itemId: string): void
  start(): Promise<void>; stop(): Promise<void>
}
```
Правила: сообщения с `chat.id !== chatId` отбрасываются без ответа; callback от чужого пользователя → `answerCallbackQuery('Not authorized')`; текст → `parseText(text, resolveItemId(reply_to_message?.message_id))`; callback → `parseCallback(data)`; PID-файл и 409-ретраи как в официальном плагине (`~/.config/ping-assistant/bot.pid`).

- [ ] **Step 1: Тесты**

```ts
test('ignores messages from other chats')
test('text reply quoting an item message resolves itemId')
test('callback pa:choose:14:2 yields choose command and answers the callback')
test('send splits long text and attaches keyboard to the last chunk')   // Review Focus 2
test('edit without keyboard removes reply_markup')
```

- [ ] **Step 2: Run → FAIL; реализовать `src/telegram/bot.ts`; Run → PASS**
- [ ] **Step 3: Commit** `git commit -s -m "feat: telegram bot with inline buttons"`

---

### Task 7: MCP channel-сервер и инструкции сессии

**Files:**
- Create: `src/channel.ts`, `CLAUDE.md`, `.claude/settings.json`
- Modify: `src/main.ts` (убрать спайк, оставить сборку — финализируется в Task 8)

**Interfaces:**
- Produces:
```ts
export type ChannelHandlers = {
  propose(itemId: string, analysis: string, variants: string[], mode: 'variants'|'final'): Promise<string>  // 'variants' → renderItem с кнопками 1..N; 'final' → renderProposal (ровно один variant)
  ignore(itemId: string, reason: string): Promise<string>
  close(itemId: string): Promise<string>                                   // skipped без уведомления
  listItems(status?: ItemStatus): Promise<string>                          // краткий список
  listIgnored(sinceHours: number): Promise<string>
  say(text: string): Promise<string>                                       // текст в Telegram без кнопок
}
export class Channel {
  constructor(handlers: ChannelHandlers)
  notify(content: string, meta: Record<string, string>): Promise<void>     // notifications/claude/channel
  connect(): Promise<void>                                                 // StdioServerTransport
}
```
Инструменты MCP (zod-схемы): `propose {item_id, analysis, variants: string[1..3], mode}`, `ignore {item_id, reason}`, `close {item_id}`, `list_items {status?}`, `list_ignored {since_hours?}`. Отправки в Slack среди инструментов **нет**.

Уведомления в сессию (`meta.kind`):
- `item` — созревший айтем: `content` = JSON `{id, source, channel, channelName, threadTs, author, authorName, messages[], context[], permalink, files[]}`.
- `update` — дополнение к awaiting-айтему: `{id, newMessages[]}`.
- `revise` — Илья попросил переделать: `{id, request, variants, analysis}`.
- `chat` — свободный текст Ильи: `{text, itemId?}`. Сессия отвечает инструментом `say {text}` (сервер шлёт текст в Telegram без кнопок); если это оказалась правка варианта — через `propose(itemId, …, 'final')`. `say` не умеет отправлять в Slack.

`CLAUDE.md` сессии — перенести §5.3 и §5.4 спеки как правила: источники и правило «нужен ли ответ» (`ignore` с причиной, при сомнении присылать), классификация, перечисление вопросов, ресёрч по типу (technical → субагент Explore в `scentbirdRepoPath`, product → Atlassian MCP + Slack-поиск, org → `team.md`), 2–3 различных варианта в голосе `voice.md` (если файла нет — пометить в analysis «voice.md не найден»), бюджет ~5 мин, язык варианта = язык вопроса. Явно: «Никогда не проси сервер отправить что-либо в Slack; у тебя нет такого инструмента, и это намеренно».

`.claude/settings.json`: `permissions.allow` для `mcp__ping-assistant__*`, `Read`, `Grep`, `Glob`, `Agent`, `mcp__plugin_atlassian_atlassian__*` (чтение), `mcp__claude_ai_Slack__slack_search_*`, `mcp__claude_ai_Slack__slack_read_*`; `deny` для `Bash(git push*)`, `Edit`, `Write` вне каталога проекта.

- [ ] **Step 1: Тест Channel с in-memory транспортом**

```ts
test('lists exactly six tools: propose, ignore, close, list_items, list_ignored, say')
test('propose rejects variants outside 1..3')
test('notify emits notifications/claude/channel with meta.source=ping-assistant')
```
(использовать `InMemoryTransport.createLinkedPair()` из `@modelcontextprotocol/sdk/inMemory.js` и `Client` из SDK)

- [ ] **Step 2: Run → FAIL; реализовать `src/channel.ts`; Run → PASS**
- [ ] **Step 3: Написать `CLAUDE.md` и `.claude/settings.json`**
- [ ] **Step 4: Commit** `git commit -s -m "feat: mcp channel server and session instructions"`

---

### Task 8: Оркестратор, dry-run и сквозная проверка

**Files:**
- Create: `src/orchestrator.ts`
- Modify: `src/main.ts`
- Test: `test/orchestrator.test.ts` (fake SlackClient, fake TelegramApi, Channel с in-memory транспортом)

**Interfaces:**
- Consumes: всё выше.
- Produces:
```ts
export class Orchestrator {
  constructor(deps: { cfg: Config; store: StateStore; state: State; slack: SlackClient; collector: Collector; tg: TelegramBot; channel: Channel; now?: () => number })
  start(): void                      // setInterval(pollSeconds) → tick(); tg.onInbound → handle()
  tick(): Promise<void>              // collector.tick → ingest → events: appended → tg.send(renderUpdate) + channel.notify('update'); answered_manually → tg.edit(outcome); затем mature() → channel.notify('item') для каждого; store.save
  handle(i: Inbound): Promise<void>  // choose/custom/confirm/force → sendToSlack; skip → status skipped + edit outcome; cancel → убрать pending; forward → channel.notify('revise'|'chat')
  handlers(): ChannelHandlers        // propose → tg.send(render…) + registerMessage + status awaiting; ignore → status ignored + ignoreReason; close; list*; say → tg.send
  private sendToSlack(item: Item, text: string, force: boolean): Promise<void>
}
```
`sendToSlack`: если `!force` — `slack.replies/history` после `item.lastSeenTs`; есть чужие новые → `item.pendingText = text`, `tg.send(renderThreadChanged)`, выход. Иначе: `cfg.dryRun` → `tg.send('🧪 dry-run, отправил бы в <permalink>:\n' + text)`; иначе `slack.postMessage(item.channel, slackify(text), threadTs)` где `threadTs = item.threadTs ?? (source !== 'im' && source !== 'mpim' ? item.messages[0].ts : undefined)`; затем `status='sent'`, `sentTs`, `watchedThreads[key] = { until: now + followUpDays*86400e3 }`, `tg.edit(item.telegram.messageId, text + '\n\n' + outcome(item))`, `tg.send('✅ отправлено: ' + permalink)`.

- [ ] **Step 1: Тесты**

```ts
test('matured item is notified to the channel as kind=item')
test('propose(variants) sends telegram message with buttons and sets awaiting')
test('choose sends variant verbatim to slack in thread and edits outcome')     // проверить текст postMessage === slackify(variants[1])
test('choose with new foreign messages after lastSeenTs asks force instead of sending')
test('force sends despite new messages')
test('forward with "2, но без тикета" notifies channel kind=revise with current variants')
test('propose(final) after revise sends proposal with Отправить/Отмена; confirm sends pendingText')
test('skip closes item and edits outcome, nothing posted')
test('dryRun never calls postMessage')
test('own slack reply marks item answered_manually and edits outcome')
test('channel never receives a slack-send tool')   // listTools не содержит ничего с "send"/"post"
```

- [ ] **Step 2: Run → FAIL; реализовать `src/orchestrator.ts` и собрать `src/main.ts`; Run → PASS**
- [ ] **Step 3: Сквозная проверка в dry-run**

Заполнить `ping-assistant.config.json` (`dryRun: true`), `~/.config/ping-assistant/.env`; создать Slack-приложение со scope-ами из Global Constraints и установить; создать бота в BotFather. Run: `claude --plugin-dir . --channels plugin:ping-assistant`. Попросить коллегу написать в личку два сообщения подряд; ожидается одно сообщение в Telegram с разбором и кнопками, нажатие «1» даёт «🧪 dry-run, отправил бы…», ничего не появляется в Slack. Записать наблюдения в `README.md` (раздел «Проверено»).

- [ ] **Step 4: Commit** `git commit -s -m "feat: orchestrator wiring and dry-run"`

---

### Task 9: Боевая отправка, follow-ups, запуск

**Files:**
- Create: `bin/ping-assistant-up`, `team.md` (шаблон), `README.md` (установка)
- Modify: `src/orchestrator.ts` (если что-то вскрылось в dry-run), `src/slack/collector.ts`

**Interfaces:** без новых.

- [ ] **Step 1: Тест follow-up сквозь коллектор и оркестратор**

```ts
test('reply in a thread ping-assistant answered in creates item 14.2 with full thread context and is notified')
test('watched thread expires after followUpDays')
```

- [ ] **Step 2: Run → FAIL; доделать; Run → PASS**
- [ ] **Step 3: `bin/ping-assistant-up`**

```bash
#!/bin/sh
cd "$(dirname "$0")/.." && exec caffeinate -i claude --plugin-dir . --channels plugin:ping-assistant "$@"
```
`chmod +x`. `team.md`: заголовки «Состав», «Регулярные встречи», «Процессы», «Ссылки» с пометкой «заполняет Илья».

- [ ] **Step 4: Боевая проверка**

`dryRun: false`. Ответить на один реальный вопрос через кнопку. Expected: в Slack сообщение от Ильи без бейджа, в Telegram исход «✅ отправлен вариант N» и ссылка. Проверить самоответ: ответить в Slack вручную на другой вопрос → в Telegram «🙈 отвечено вручную».

- [ ] **Step 5: Commit** `git commit -s -m "feat: live send, follow-ups, launcher"`

---

### Task 10: Финальный проход

- [ ] **Step 1:** `bun test` → все зелёные; `bunx tsc --noEmit` → без ошибок.
- [ ] **Step 2:** README: установка (bun, Slack app + scopes, BotFather, конфиг, .env, `bin/ping-assistant-up`), команды Telegram, где смотреть логи (stderr сессии), как посмотреть проигнорированное («что ты проигнорировал за сегодня?»).
- [ ] **Step 3:** Commit `chore: readme and setup notes`.

Отдельно, вне плана (§7 спеки): `voice.md` — Илья запускает разбор своих сообщений в Slack и кладёт гайд в корень проекта.
