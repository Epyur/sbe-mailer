# AGENTS.md — sbe-mailer (Письма)

SBE-плагин «Письма»: локальная БД-кэш писем + синхронизация с mailer-service
(сервер — канон), DOCX-экспорт, AI-генерация черновиков через sbe-llm.

## Назначение (текущее)

- **Синхронизация** с сервером `https://epyur.fvds.ru` через JWT из ЦУП СБЕ
  (`getService('sbe-apstore').auth.getToken('mailer')`): push `/api/mailer/sync/push`,
  pull `/api/mailer/sync/pull`. Сервер — каноническое хранилище, локальный JSON —
  кэш. Конфликты — LWW по `updated_at` (сервер авторитетен при равном/новом).
- **Локальная БД**: `yourbase/sbe_mailer/mail_data.json` (эмуляции `yourbase/sbe_mailer/`).
  Модель `MailItem` совместима с серверным `Email`.
- **Одноразовая/повторная миграция** из legacy-БД монолита `yourbase/mailer_data.json`
  (пишет его плагин `obsidian-yougile`): `importLegacy` при пустой БД, затем
  `importMissingLegacy` с subject-guard (не импортирует письма, темы которых уже есть
  локально — защита от дублей, когда легаси-письмо уже на сервере под другим id).
  Перед повторным импортом выполняется `pullAndMerge` (свежий серверный снимок).
- **Дедуп кэша**: `dedupe()` удаляет записи с совпавшими id (оставляет самую свежую).
- **DOCX-экспорт**: шаблон с плейсхолдерами `{{Номер}} {{Тема}} {{Текст}} {{Автор}}
  {{Дата}}` (и `{{Год}} {{Месяц}} {{День}} {{Время}}`), fallback-генерация; шаблон
  скачивается с сервера `GET /api/mailer/template` в `yourbase/sbe_mailer/templates/`.
- **AI-генерация черновика**: вся локальная база грузится в LLM (`getService('sbe-llm')` →
  `completeJson`), модель задаётся в настройках (`llmModel`, default `gpt-5.6-luna`).
  Серверный поиск `/api/mailer/search` **отключён** (endpoint на сервере закомментирован,
  метод `search()` в `sync.service.ts` сохранён на случай возврата).
- **Точка входа** — магазин: «Установленные → Открыть» (`publishService('sbe-mailer', {open})`).

## Структура

| Файл | Что это |
|---|---|
| `src/main.ts` | `SbeMailPlugin`: настройки, БД, syncService, llmGenerator, миграция, view, publishService |
| `src/database/mail-db.ts` | `MailDatabase`: кэш JSON, mergeFromServer, importLegacy/importMissingLegacy, dedupe, resolveDirectionId |
| `src/services/sync.service.ts` | `MailSyncService`: push/pull/search/downloadTemplate, JWT из ЦУП, 401/403, таймауты |
| `src/services/llm-generator.ts` | `LlmGenerator`: контекст из всей локальной БД → sbe-llm → JSON-черновик |
| `src/services/document-service.ts` | `DocumentService`: экспорт DOCX по шаблону/fallback, изображения |
| `src/ui/mail-view.ts` | `MailView`: таблица (с колонкой «Направление»), фильтры, детали, create/edit, AI, экспорт HTML |
| `src/ui/settings-tab.ts` | Настройки: apiUrl, автор, модель LLM, DOCX-шаблон/папка, кнопка скачивания шаблона |
| `src/types/mail.ts` | `MailItem`, `MailDirection`, `MailDbData`, `PushResponse`, `PullResponse`, `SearchResultItem` |
| `src/styles.css` | Классы `tn-mail-*` на семантических токенах |

## Настройки (data.json)

`apiUrl` (default `https://epyur.fvds.ru`), `defaultAuthor` (default `И.И. Иванов`),
`docxTemplatePath`, `docxExportFolder` (default `Экспорт писем`), `selectedDirectionIds`,
`llmModel` (default `gpt-5.6-luna`).

## Правила

- `catch(e: unknown)` + `errorMessage()`; `requestUrl()`; `window.setTimeout()`; без `any`;
  UI на русском; автор — Полищук Евгений (polishchuk@tn.ru). Классы `tn-mail-*` / `tn-btn*`
  / `tn-table` на семантических токенах sbe-core.
- Коммиты/пуши — только по явной команде пользователя.
- **«Фиксируй» = поднять версию (+0.0.1 в `manifest.json` и `package.json`), обновить
  документацию (AGENTS.md/specification.md), подготовить сообщение для коммита и
  СПРОСИТЬ подтверждение коммита и пуша.** Без явного подтверждения пользователя
  коммит/push не выполнять.

## История работ

### 2026-08-17 — v0.1.1
- Версия 0.1.0 → 0.1.1 (manifest + package.json), пересборка `main.js`.
- Правило «Фиксируй»: поднятие версии + документация + подготовка сообщения коммита
  с запросом подтверждения commit/push (добавлено в раздел «Правила»).

### 2026-08-17 — v0.1.0 (создание)
- Плагин вынесен из монолита `yougile-tntn` (модуль «Письма»). Полный скаффолд:
  manifest, package (deps `docx`, `jszip`), esbuild (бандл sbe-core + styles), tsconfig.
- БД-кэш + LWW-синхронизация + миграция из `mailer_data.json`, DOCX-экспорт, view,
  settings. `publishService('sbe-mailer')`.
- Инициирующий коммит `1e9bf65` в `Epyur/sbe-mailer`.

### 2026-08-17 — шаблон письма (standard.docx)
- На сервер залит `/opt/mailers/templates/standard.docx` и в S3
  `firstvds:mailers-backup/templates/standard.docx`.
- Backend: `GET /api/mailer/template` (JWT user), env `MAILER_TEMPLATE_DIR`, compose
  mount `./templates:/app/templates:ro`. E2E: 401 без токена / 200 с токеном (MD5 совпал).
- Плагин: `downloadTemplate()` + `ensureDefaultTemplate()` на старте + кнопка в настройках.

### 2026-08-17 — направления + синхронизация баз
- Обнаружено: легаси 867 писем/6 направлений, сервер — 565, кэш — 570 (с коллизиями id);
  298 легаси-писем отсутствовали на сервере. Причина: легаси содержит письма с одинаковыми
  id (баг `Date.now()+random`), сервер `ON CONFLICT DO NOTHING` сохранил только первые.
- До-залито на сервер 298 писем (268 с legacy-id + 27 + 4 с новыми id через `id=0`).
  Итог: сервер = 868, кэш = 868, 0 расхождений, 0 дублей, направления сохранены.
- Плагин: `dedupe()`, `importMissingLegacy` (subject-guard), `pullAndMerge` перед миграцией,
  колонка «Направление» в таблице списка.

### 2026-08-17 — AI-генерация (серверный поиск)
- Backend: `POST /api/mailer/search` (tsvector + pg_trgm, extension + GIN-индексы).
  E2E: 401/200/400. Поиск находит письма по одному слову.
- Плагин: `search()` в sync.service, `llm-generator.ts` (поиск → контекст → sbe-llm),
  кнопка «✨ Сгенерировать черновик (AI)» в форме создания, настройка `llmModel`.
- Выявлено: естественно-языковые запросы не находились (`plainto_tsquery` = AND).
  SQL переписан на `websearch_to_tsquery` (OR) + per-word ILIKE + trigram `%` + `hits`.

### 2026-08-17 — LLM по локальной базе; серверный поиск отключён
- По решению: генерация черновика грузит **всю локальную БД** в LLM (контекст из
  `getEmails()`), серверный поиск убран из потока.
- Backend: маршрут `/api/mailer/search` закомментирован (код `handleSearch` сохранён),
  задеплоено: search → 404, template/pull → 200.
- Плагин: `LlmGenerator` переведён на локальную базу; `search()` сохранён (документирован
  как выключенный). Настройки: автор по умолчанию → `И.И. Иванов`.

## Статистика ошибок и отступлений

- Нарушений правил нет: 0 `any`, 0 `fetch`, 0 инлайн-стилей, `window.setTimeout` корректен,
  все `catch(e: unknown)` + `errorMessage()`.
- `npx tsc --noEmit` EXIT=0, `npm run build` OK (без предупреждений).
- Серверный поиск `/api/mailer/search` — отключён, метод `search()` в `sync.service.ts`
  не вызывается (задокументировано как ожидаемое состояние, не нарушение).
