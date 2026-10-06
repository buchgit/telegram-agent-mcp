# Telegram Agent MCP

Работайте с Codex в своих проектах через Telegram: отправьте задачу из чата, получите ответ агента, а результат сохранится в файлах проекта на компьютере.

Telegram Agent MCP — локальный MCP-сервер для двусторонней связи Telegram и Codex CLI. Проект на экране демонстрационного видео — пример: инструмент можно установить в другой выбранный проект.

```text
Telegram → Bot API → Telegram Agent MCP → Codex CLI → ваш проект
Telegram ←          ответ агента                   ← результат
```

## Скачать и установить

1. Скачайте **[telegram_agent_mcp.zip из последнего релиза](https://github.com/buchgit/telegram-agent-mcp/releases/latest/download/telegram_agent_mcp.zip)**.
2. Распакуйте папку `telegram_agent_mcp` в корень нужного проекта.
3. Откройте PowerShell в этой папке и выполните `./setup.ps1`.
4. Введите токен своего Telegram-бота, ID чата и префикс команды.
5. Подключите `dist/index.js` как локальный stdio MCP-сервер в вашем MCP-клиенте, перезапустите подключение и вызовите `telegram_status`.

Нужны Node.js 20+, npm, установленный и настроенный Codex CLI, Telegram-бот и чат. Компьютер с проектом должен быть включён. Установщик создаёт локальные настройки и ставит зависимости из lock-файла.

**[Полная инструкция для пользователя и агента](telegram_agent_mcp/INSTRUCTIONS.md)** · **[Настройки MCP-клиента](telegram_agent_mcp/mcp-config.example.json)** · **[Изменения версии](telegram_agent_mcp/RELEASE_NOTES.md)**

Если скачиваете исходники через **Code → Download ZIP**, извлеките из них внутреннюю папку `telegram_agent_mcp` и поместите её в свой проект.

## Как пользоваться

При префиксе `cod` отправьте сообщение:

```text
cod проверь изменения в проекте и обнови его документацию
```

Обычные сообщения без префикса не запускают задачу при включённом фильтре. Следующие команды продолжают дочернюю сессию агента; смена префикса сбрасывает эту сессию. Актуальный префикс показывает `telegram_status`.

Инструменты сервера: `telegram_status`, `telegram_send_message`, `telegram_read_commands`. Последний предназначен для ручного чтения при выключенном встроенном мониторе. Одновременно запускайте только один принимающий монитор для бота.

## Стек и исходники

Node.js / TypeScript, MCP SDK, Telegram Bot API и Codex CLI. Основные файлы:

- [`src/index.ts`](telegram_agent_mcp/src/index.ts) — MCP-инструменты и монитор Telegram;
- [`src/codex-launch.ts`](telegram_agent_mcp/src/codex-launch.ts) — запуск Codex без shell на Windows;
- [`src/command.ts`](telegram_agent_mcp/src/command.ts) — разбор префикса;
- [`tests/`](telegram_agent_mcp/tests/) — проверки префиксов, argv и передачи текста через stdin.

## Сборка и проверка

```powershell
cd telegram_agent_mcp
npm ci
npm test
./build-package.ps1
```

Версия **0.4.1**: исправление запуска Codex в Windows с пробелами и кириллицей в путях, обновление зависимостей. На 2026-10-06: сборка и 7/7 тестов прошли, `npm audit` — 0 известных уязвимостей. Новая живая установка с обменом командами через Telegram на этом этапе не проверялась.

В репозитории и установочном архиве находятся пример настроек и код; локальные `.env`, данные сессий, журналы и `node_modules` исключены.
