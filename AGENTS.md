# AGENTS.md — sbe-mailer (Письма)

SBE-плагин «Письма»: локальная БД-кэш писем + синхронизация с mailer-service
(сервер — канон), DOCX-экспорт, AI-генерация черновиков через sbe-llm.

**Бэк — в этой же папке** (`backend/`, mailer-service, 2026-08-24, переехал из
`server_back/backend/`) — на отдельной ветке `backend` (main — чистый релизный срез
кода плагина, без бэка; см. правило «Бэки в папках плагинов» в корневом
`plugins/AGENTS.md`).

## Назначение (текущее)

- **Синхронизация** с сервером `https://epyur.fvds.ru` через JWT из ЦУП СБЕ
  (`getService('sbe-apstore').auth.getToken('mailer')`): push `/api/mailer/sync/push`,
  pull `/api/mailer/sync/pull`. Сервер — каноническое хранилище, локальный JSON —
  кэш. Конфликты — LWW по `updated_at` (сервер авторитетен при равном/новом).
- **Локальная БД**: `yourbase/sbe_mailer/mail_data.json` (эмуляции `yourbase/sbe_mailer/`).
  Модель `MailItem` совместима с серверным `Email`.
- **Одноразовая миграция** из legacy-БД монолита `yourbase/mailer_data.json` (пишет его
  плагин `obsidian-yougile`): `importLegacy()` при пустой локальной БД, один раз за всё
  время жизни плагина — гарантируется флагом `legacyMigrated` в настройках (как в
  sbe-documents), а не повторным сканированием на каждом старте (см. историю v0.1.11 —
  раньше это воскрешало удалённые письма).
- **Дедуп кэша**: `dedupe()` удаляет записи с совпавшими id (оставляет самую свежую).
- **DOCX-экспорт**: шаблон с плейсхолдерами `{{Номер}} {{Тема}} {{Текст}} {{Автор}}
  {{Дата}}` (и `{{Год}} {{Месяц}} {{День}} {{Время}}`), fallback-генерация; шаблон
  скачивается с сервера `GET /api/mailer/template` в `yourbase/sbe_mailer/templates/`.
  Путь экспортируемого файла стабилен для одного письма (`Письмо_<номер>_<тема>.docx`,
  без счётчика `_1/_2`) — повторный экспорт перезаписывает тот же файл; открывается
  системным приложением (`electron.shell.openPath`, Obsidian не умеет .docx), что
  позволяет ОС/Word активировать уже открытый документ вместо новой вкладки/окна.
- **AI-генерация черновика**: вся локальная база грузится в LLM (`getService('sbe-llm')` →
  `completeJson`), модель задаётся в настройках (`llmModel`, default `gpt-5.6-luna`).
  Серверный поиск `/api/mailer/search` **отключён** (endpoint на сервере закомментирован,
  метод `search()` в `sync.service.ts` сохранён на случай возврата).
- **UI — фасад «LogicTEAM.Письма»** (как sbe-documents/sbe-requests/sbe-lims): топбар (создание,
  crumb) + сайдбар (сворачивание, группа «Письма», группа «Фильтры» — чекбоксы направлений,
  Синхронизация, Экспорт HTML) + контент. Письма — карточками (как документы в sbe-documents):
  заголовок «номер — тема», чип даты, мета (автор · направление · статус синхронизации),
  превью текста (до 160 символов, 2 строки) и счётчик вложений; клик по карточке открывает
  детали. Поиск и фильтры по дате/автору — как раньше, над списком карточек.
- **Подпись для DOCX**: в настройках — должность, учёная степень/звание (объединяются через
  запятую в `{{Должность}}`), телефон (`{{Телефон}}`), e-mail (`{{Почта}}`). Подстановка через
  `replacePlaceholdersAcrossRuns()` — Word разбивает один плейсхолдер на несколько `<w:t>` ранов,
  побайтовый `xml.replace()` этого не ловил.
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
`position`, `degree`, `rank`, `phone`, `email` (подпись для DOCX, default — пустые),
`docxTemplatePath`, `docxExportFolder` (default `Экспорт писем`), `selectedDirectionIds`,
`llmModel` (default `gpt-5.6-luna`), `legacyMigrated` (default `false`, служебный —
без UI, не трогать вручную).

## Правила

- `catch(e: unknown)` + `errorMessage()`; `requestUrl()`; `window.setTimeout()`; без `any`;
  UI на русском; автор — Полищук Евгений (polishchuk@tn.ru). Классы `tn-mail-*` / `tn-btn*`
  / `tn-table` на семантических токенах sbe-core.
- Коммиты/пуши — только по явной команде пользователя.
- **«Фиксируй» = поднять версию (+0.0.1 в `manifest.json` и `package.json`), обновить
  документацию (AGENTS.md/specification.md), подготовить сообщение для коммита и
  СПРОСИТЬ подтверждение коммита и пуша.** Не поднимать версию плагина при коммите
  чисто бэковых изменений в `backend/` (ветка `backend`), если сам плагин не менялся.
  Без явного подтверждения пользователя
  коммит/push не выполнять.

## История работ

### 2026-08-20 — v0.1.13 (пересборка за sbe-core: SbeContactsApi)
- `sbe-core`: добавлены `SbeContactsApi` и `'sbe-contacts'` в `SbeServiceMap` — пересборка `main.js`, исходники плагина не менялись. Версия 0.1.12 → **0.1.13** (manifest + package.json).
- `npx tsc --noEmit` EXIT=0; `npm run build` OK.

### 2026-08-19 — v0.1.12 (карточки писем: превью текста и вложения)
- **Карточки письма обогащены до уровня документов sbe-documents**: добавлено превью текста
  (`tn-mail-card-snippet`, до 160 символов, обрезка до 2 строк через `-webkit-line-clamp`)
  и строка вложений (`tn-mail-card-files`, 📎 N файлов + первые 3 имени). Мета/чип даты/заголовок
  остались как в v0.1.10.
- Новые классы в `src/styles.css`: `tn-mail-card-snippet`, `tn-mail-card-files`.
- Версия 0.1.11 → **0.1.12** (manifest + package.json). `npx tsc --noEmit` EXIT=0;
  `npm run build` OK. Коммит и пуш сделаны.

### 2026-08-19 — v0.1.11 (фикс воскрешения удалённых писем при перезапуске Obsidian)
- **Найдена причина**: `migrateLegacyOnce()` в `main.ts`, несмотря на название, запускалась
  на **каждом** `onload()`. При непустой БД она делала `pullAndMerge()` (это корректно
  подчищало удалённые письма — фикс из v0.1.9), но затем ВСЕГДА вызывала
  `importMissingLegacy()` по статичному `yourbase/mailer_data.json` с guard'ом «нет по
  id/теме в текущей БД». После удаления письма его тема пропадала из guard'а — легаси-копия
  того же письма реимпортировалась как новая (`sync_status='local'`), следующий push
  возвращал «удалённое» письмо на сервер и на все машины при их pull.
- **Фикс**: флаг `legacyMigrated` в настройках (как в sbe-documents, v0.1.4) — импорт из
  legacy теперь возможен максимум один раз за всё время жизни плагина, а не при каждом
  старте. Ветка «докачать с сервера → доимпортировать недостающее» убрана целиком — она
  принципиально не отличает «не мигрировано» от «удалено».
- Удалён ставший мёртвым код: `importMissingLegacy()` (`mail-db.ts`), `pullAndMerge()`
  (`sync.service.ts`).
- ⚠️ Письма, уже «воскрешённые» этим багом до фикса и разъехавшиеся по машинам через
  синхронизацию, нужно удалить ещё раз вручную — фикс останавливает будущие воскрешения,
  но не убирает уже случившиеся дубли задним числом.
- Версия 0.1.10 → **0.1.11** (manifest + package.json). `npx tsc --noEmit` EXIT=0;
  `npm run build` OK.

### 2026-08-19 — v0.1.10 (карточки писем, фикс новой вкладки при экспорте в Word)
- **Карточки вместо таблицы**: `renderEmailsView()` рендерит `renderCard()` для каждого письма
  (заголовок «номер — тема», чип даты, мета: автор/направление/статус синхронизации) — как
  документы в sbe-documents. Старые классы `tn-mail-row`/`tn-mail-center`/`tn-table` в списке
  писем убраны (мёртвый CSS удалён), добавлены `tn-mail-card`/`tn-mail-card-head`/
  `tn-mail-card-title`/`tn-mail-chip`/`tn-mail-card-meta`.
- **Фикс «каждый экспорт открывает новую вкладку»**: причина — `document-service.ts` при
  каждом экспорте письма подбирал новое имя файла (`while (exists) → _1, _2, ...`), т.е. каждый
  экспорт того же письма физически создавал новый файл, поэтому Word/ОС не могли считать это
  «тем же документом». Плюс сам механизм переиспользования вкладки был мёртвым кодом:
  `workspace.getLeavesOfType('file')` — `'file'` не является зарегистрированным view type в
  Obsidian (валидные типы — `'markdown'`, `'pdf'`, `'image'` и т.п.), поиск всегда возвращал
  пустой массив. Исправлено: путь экспорта стабилен (`Письмо_<номер>_<тема>.docx`, без
  счётчика — перезапись), открытие — через `electron.shell.openPath()` (как `openLocalFile` в
  sbe-documents для не-Obsidian-типов), а не через `leaf.openFile()`, у которого нет реального
  вьюера для `.docx`. `esbuild.config.mjs`: `external` дополнен `'electron'`.
- Версия 0.1.9 → **0.1.10** (manifest + package.json). `npx tsc --noEmit` EXIT=0; `npm run build` OK.

### 2026-08-19 — v0.1.9 (фасад, подпись для DOCX, фикс плейсхолдеров, чистка кэша)
- **Фасад «LogicTEAM.Письма»** (как sbe-documents/sbe-requests/sbe-lims): топбар + сайдбар
  (сворачивание, группа «Письма», группа «Фильтры» — чекбоксы направлений вынесены из
  блока над таблицей в сайдбар) + контент. `renderView()` → `renderEmailsView()`/`renderPage()`.
- **Подпись для DOCX**: новые настройки `position`/`degree`/`rank`/`phone`/`email` (раздел
  «Подпись»); подставляются в шаблон как `{{Должность}}` (степень+звание через запятую),
  `{{Телефон}}`, `{{Почта}}`; те же поля добавлены в fallback-генерацию DOCX.
- **Фикс подстановки плейсхолдеров**: `document-service.ts` — `replacePlaceholdersAcrossRuns()`
  склеивает текст всех `<w:t>` в логическую строку перед заменой и пересобирает XML, т.к. Word
  часто разбивает один плейсхолдер на несколько ранов (старый `xml.replace()` такие не находил).
  `{{Текст}}` (в шаблоне целиком в одном `<w:t>`) заменяется как раньше, отдельно.
- **Переиспользование вкладки** при повторном экспорте DOCX — ищет открытую `.docx`-вкладку
  вместо создания новой при каждом экспорте.
- **`mergeFromServer`**: удаляет из локального кэша письма со `sync_status='synced'`,
  отсутствующие в ответе сервера (удалены admin'ом) — раньше такие письма зависали в кэше
  после удаления на сервере. Письма `local`/`conflict` не трогает.
- Версия 0.1.8 → **0.1.9** (manifest + package.json). `npx tsc --noEmit` EXIT=0; `npm run build` OK.

### 2026-08-18 — v0.1.8 (пересборка за sbe-core: sbe-lims в service-map)
- `sbe-core`: добавлены `SbeLimsApi` и `'sbe-lims'` в `SbeServiceMap` — пересборка `main.js`,
  исходники плагина не менялись. Версия 0.1.7 → **0.1.8** (manifest + package.json).
- `npx tsc --noEmit` EXIT=0; `npm run build` OK. Коммит и пуш сделаны.

### 2026-08-18 — v0.1.7 (пересборка за sbe-core: SbeEknApi)
- `sbe-core`: добавлены `SbeEknApi` и `'sbe-ekn'` в `SbeServiceMap` — пересборка `main.js`,
  исходники не менялись. Версия 0.1.6 → **0.1.7** (manifest + package.json).

### 2026-08-17 — v0.1.6 (сортировка, автоподстановка номера, удаление писем)
- Сортировка писем по **дате** (сначала новые) в таблице и экспорте HTML — хелпер
  `compareDatesDesc` (невалидные даты — в конец).
- Форма создания: поле «Направление» перенесено выше «Исходящего номера»; при выборе
  направления в номер подставляется номер последнего письма этого направления
  (подсказка-описание под полем).
- **Удаление писем для admin**: сервер `POST /api/mailer/delete` (requirePerm admin);
  кнопка «🗑 Удалить письмо» в деталях (только admin, с подтверждением), удаляет на сервере
  и в локальном кэше.
- Сервер задеплоен (E2E: push → delete deleted:1 → исчезло). Версия 0.1.5 → **0.1.6**.
  tsc EXIT=0, build OK.

### 2026-08-17 — v0.1.5 (Этап 5: роли + общий доступ)
- **Расширенная модель ролей**: `viewer` < `commenter` < `editor` < `admin` (вместо user/admin).
  Сервер (backend): `effectiveRole` (персональная роль или уровень общего доступа), таблица
  `mailer_common_access`, миграция `user`→`editor`. Endpoints: push→editor, pull→viewer,
  + `GET/POST /api/mailer/common-access`.
- **Общий доступ**: в настройках «Права доступа» — селектор уровня (нет/просмотр/
  просмотр+комментарии/редактор) + таблица ролей с выпадающим списком 4 ролей и кнопкой
  «✖ Убрать». UI учитывает роль: кнопки «Новое письмо»/«Редактировать» только для editor+.
- Версия 0.1.4 → **0.1.5** (manifest + package.json). tsc EXIT=0, build OK.

### 2026-08-17 — v0.1.4 (Этап 5: Права доступа)
- Настройки: раздел «Права доступа» — для admin таблица ролей (смена user↔admin, добавление
  по email), для user — «Ваша роль: …», без доступа — подсказка.
- `sync.service.ts`: `getMyPermission`, `listPermissions`, `setPermission`.
- Сервер (backend): `/api/mailer/permissions/me|list|set` (см. server_back/backend).
- Версия 0.1.3 → **0.1.4** (manifest + package.json). tsc EXIT=0, build OK.

### 2026-08-17 — v0.1.3 (направления: создание из UI + синхронизация)
- Кнопка «➕ Создать направление» в формах создания и редактирования письма —
  создаёт направление в локальном реестре `directions[]` (метод `createDirectionFromField`),
  обновляет datalist.
- Сервер (backend/main.go): колонка `direction_name` в `emails` + push/pull передают её.
- `mergeFromServer`/`fromServer`: при pull письма с новым `direction_name` добавляет его
  в `directions[]` (метод `ensureDirection`) — на другом компьютере направление появляется
  и в деталях, и в списке выбора. Push шлёт `direction_name`.
- E2E: push с direction_name → inserted:1, pull возвращает имя; тестовое письмо удалено.
- Версия 0.1.2 → **0.1.3** (manifest + package.json). tsc EXIT=0, build OK.

### 2026-08-17 — v0.1.2 (источник реестра)
- `sbe-core`: `DEFAULT_REGISTRY_URL` → `https://epyur.fvds.ru/registry.json`
  (raw.githubusercontent.com отдавал 429). Пересборка `main.js`, исходники не менялись.
- Версия 0.1.1 → **0.1.2** (manifest + package.json).
- `npx tsc --noEmit` EXIT=0; `npm run build` OK.

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
