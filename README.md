# Ping Assistant

Bun/TypeScript MCP channel server for Claude Code: watches Slack, pushes items into a
session via `notifications/claude/channel`, talks to the user through a Telegram bot.
Design: `docs/superpowers/specs/2026-10-19-ping-assistant-design.md`.

## Setup

```bash
bun install
bunx tsc --noEmit
```

## Run a session with the local plugin

```bash
claude --plugin-dir . --channels plugin:ping-assistant@local
```

`bun` must be on `PATH` of the shell that launches `claude`.

## Channel protocol spike (Task 1, historical)

The spike server has since been replaced by the real server, and `scripts/spike-check.ts`
by `scripts/smoke-check.ts`; the findings below still hold.

Confirmed names: notification method `notifications/claude/channel`, capability
`experimental['claude/channel']`, params `{ content, meta }`.
The spike server (`src/main.ts`) exposes a `ping` tool (returns `pong`) and emits a
`tick` notification every 20 s (`PING_TICK_MS` overrides).

Results:
- Protocol level (`bun run scripts/spike-check.ts`): server advertises the capability,
  `tools/list` returns `ping`, `ping` returns `pong`, and a `notifications/claude/channel`
  tick (`content: "tick"`, `meta: {source: "ping-assistant", kind: "tick"}`) arrives.
- `--channels plugin:ping-assistant` is rejected by the CLI ("entries must be tagged:
  plugin:<name>@<marketplace>"). `plugin:ping-assistant@local` is accepted with `--plugin-dir .`.
- Headless `claude -p` with the plugin loaded: the `ping` tool is reachable (the plugin
  tool name is `mcp__plugin_ping-assistant_ping-assistant__ping`). Without an allow rule it
  is denied by the permission prompt; with
  `--allowedTools mcp__plugin_ping-assistant_ping-assistant__ping` the reply was `pong`.
- NOT verified: the `<channel source="ping-assistant" ...>tick</channel>` message waking an
  interactive session (needs a human terminal; `-p` mode ends after the turn). Check manually
  once with the command above before relying on it; fallback is spec section 4
  (`/loop 1m` + `next_items` tool).

## Проверка dry-run

В dry-run сервер делает всё, кроме отправки в Slack: вместо `chat.postMessage` в Telegram
приходит «🧪 dry-run, отправил бы в <ссылка>: <текст>». Slack читается по-настоящему.

1. **Slack-приложение.** На api.slack.com/apps создать приложение, в *OAuth & Permissions*
   добавить **User Token Scopes**: `channels:history channels:read groups:history groups:read
   im:history im:read mpim:history mpim:read users:read search:read chat:write files:read`,
   установить в воркспейс, скопировать *User OAuth Token* (`xoxp-…`).
2. **Telegram-бот.** В @BotFather `/newbot`, скопировать токен. Свой user ID узнать, например,
   у @userinfobot; это `telegramChatId` (бот отвечает только в личке с этим ID).
3. **Секреты** — `~/.config/ping-assistant/.env` (права `600`):
   ```
   SLACK_USER_TOKEN=xoxp-…
   TELEGRAM_BOT_TOKEN=123456:…
   ```
4. **Конфиг.** `cp ping-assistant.config.example.json ping-assistant.config.json`, заполнить
   `userId` (свой Slack ID: профиль → ⋯ → *Copy member ID*), `watchChannels`, `telegramChatId`,
   `scentbirdRepoPath`, и поставить `"dryRun": true`. Другой путь к конфигу — переменная
   `PING_ASSISTANT_CONFIG`.
5. **Смоук без Claude.** `bun run scripts/smoke-check.ts` поднимает `src/main.ts` по stdio и
   ожидает в выводе `started (dry-run)`, `claude/channel capability: yes`, список инструментов
   `propose, ignore, close, list_items, list_ignored, say` и `ok`. В Telegram смоук ничего не шлёт.
6. **Сессия.** Из корня проекта: `claude --plugin-dir . --channels plugin:ping-assistant@local`.
   Первый тик (через `pollSeconds`) ставит курсоры на «сейчас»: прошлое не разбирается.
7. **Сценарий.** Попросить коллегу написать в личку два сообщения подряд. Ожидается:
   - через `settleSeconds` (90 с) после последнего — **одно** сообщение в Telegram: шапка
     `#N · личка · Автор`, обе реплики, разбор, 2–3 варианта и кнопки `1 2 3 Пропустить`;
   - нажатие «1» → кнопки у айтема гаснут, в конце строка «✅ отправлен вариант 1», и приходит
     «🧪 dry-run, отправил бы в https://…slack.com/…: <текст варианта>»; в Slack ничего нет;
   - ответ цитатой «2, но короче» → новое сообщение «финальный текст» с кнопками
     «Отправить/Отмена»; у исходного — «✏️ правка ниже»;
   - если коллега успел написать ещё что-то до нажатия — вместо отправки придёт «в треде
     появилось новое» с кнопками «Всё равно отправить/Отмена»;
   - ответ в Slack руками → айтем помечается «🙈 отвечено вручную».
8. Логи — stderr сервера (Claude Code пишет его в логи MCP-сервера, видно с `claude --debug`); в них только виды событий,
   без текста сообщений. Состояние — `~/.config/ping-assistant/state.json`.

Когда сценарий прошёл, записать наблюдения в раздел «Проверено» ниже и выключить `dryRun`.

## Проверено

Пока ничего: живой прогон dry-run с настоящими токенами ещё не делался. Автоматически
проверено (`bun test`, `test/orchestrator.test.ts`): весь поток от сбора до отправки на
фейковых Slack и Telegram API и настоящем MCP-канале; смоук `scripts/smoke-check.ts`
с фиктивными токенами проходит.
