# specification.md — sbe-mailer (Письма)

Форматы обмена между плагином «Письма» (sbe-mailer) и mailer-service на сервере
(`https://epyur.fvds.ru`), а также между sbe-mailer и sbe-llm.

## Авторизация

Все запросы к mailer-service — JWT Bearer. JWT берётся из ЦУП СБЕ:
`getService('sbe-apstore').auth.getToken('mailer')`. При 401 — «Ключ доступа
недействителен» (запросить новый ключ в ЦУП), при 403 — «Нет прав доступа».

## Модель письма (MailItem / Email)

```jsonc
{
  "id": 1784635133242,          // int64; новые локальные = Date.now()+random
  "number": "ТД/К/014",         // исходящий номер
  "subject": "О номенклатуре…",
  "text": "…",
  "author": "Мишакин Д.В.",
  "date": "2025-09-15T00:00:00",
  "direction_id": 1783940772767,
  "direction_name": "Комплектация",   // только локально (сервер не хранит имя)
  "images": [],                 // локальные имена файлов (вложения не загружаются)
  "mdFilePath": "", "mdFileHash": "",
  "lastSyncTime": "2026-07-21T11:58:52.283Z",
  "sync_status": "local | synced",     // "conflict" зарезервирован
  "created_at": "…", "updated_at": "…" // ISO8601; LWW по updated_at
}
```

Направления (`MailDirection`): `{id, name, description, created_at}` — хранятся
**только локально** в `directions[]` БД; сервер держит только `direction_id`.

## Endpoints

### POST /api/mailer/sync/push — приём/обновление писем
- Тело: `{"emails": [MailItem, ...]}` (без `direction_name`/`updated_at` — сервер не требует).
- Семантика: `id>0` → UPDATE по `WHERE id=$1 AND updated_at < $9` (иначе INSERT
  `ON CONFLICT (id) DO NOTHING`); `id=0` → INSERT (сервер назначает id).
- Ответ: `{"inserted": N, "updated": M}`.

### GET /api/mailer/sync/pull — выгрузка всех писем
- Ответ: `{"emails": [Email, ...]}`. Поля сервера: `id, number, subject, text, author,
  date, direction_id, images, created_at, updated_at`; `mdFilePath="" mdFileHash=""
  lastSyncTime=updated_at sync_status="synced"` (дополняются на сервере).
- `mergeFromServer` также удаляет из локального кэша письма со `sync_status="synced"`,
  отсутствующие в ответе (удалены на сервере admin'ом); письма `local`/`conflict` не трогает —
  их отправит следующий push.

### GET /api/mailer/template — DOCX-шаблон письма
- Ответ 200: байты `.docx` (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`).
- 401/403/404. Плагин сохраняет его в `yourbase/sbe_mailer/templates/standard.docx`
  и ставит в `docxTemplatePath`.
- Плейсхолдеры шаблона: `{{Номер}} {{Тема}} {{Текст}} {{Автор}} {{Дата}} {{Год}} {{Месяц}}
  {{День}} {{Время}} {{Должность}} {{Телефон}} {{Почта}}`. Последние три — подпись из настроек
  плагина (`position`+`degree`+`rank` объединяются через запятую в `{{Должность}}`, пустые
  значения не подставляются). Подстановка идёт на уровне `<w:t>`-ранов документа
  (`replacePlaceholdersAcrossRuns`), а не по всей строке XML — Word может разбить один
  плейсхолдер на несколько ранов. `{{Текст}}` — блочная вставка абзацев, заменяется отдельно.
- **Экспортированный файл**: `Экспорт писем/Письмо_<номер>_<тема>.docx` — путь стабилен для
  одного письма (перезаписывается при повторном экспорте, без счётчика `_1/_2`); открывается
  системным приложением (`electron.shell.openPath`) — Obsidian не рендерит `.docx` нативно.

### POST /api/mailer/search — ⛔ ОТКЛЮЧЁН
- Endpoint закомментирован на сервере (код `handleSearch` сохранён). Метод `search()`
  в `sync.service.ts` не вызывается. Возврат — при решении вопроса с подключением LLM
  к серверу.
- Прежний контракт: `{"query": "…", "limit": N}` → `{"results": [{id, number, subject,
  text, author, date, direction_id, rank, similarity, hits}]}`, сортировка по
  `hits DESC, rank DESC, sim DESC`.

## LLM-генерация черновика (sbe-mailer → sbe-llm)

- Сервис: `getService('sbe-llm')`, метод `completeJson<T>(system, user, {model})`.
- Контекст: **вся локальная БД** (`mail_data.json`) — каждая запись
  `[Письмо N] №number (author) / Направление: direction_name / Тема: subject /
  Содержимое: text[0..500]`.
- Промт требует JSON: `{"subject": "...", "text": "..."}`.
- Модель: из настроек `llmModel` (default `gpt-5.6-luna`).

## Локальная БД

- Путь: `yourbase/sbe_mailer/mail_data.json` → `{"emails": [MailItem], "directions": [MailDirection]}`.
- Миграция из `yourbase/mailer_data.json` (монолит `obsidian-yougile`): полный импорт
  (`sync_status=local`) только если локальная БД пуста, максимум один раз за всё время
  жизни плагина — гарантируется флагом `legacyMigrated` в настройках. Повторного
  доимпорта по guard'у нет (убран в v0.1.11 — конфликтовал с удалением писем: guard по
  теме не отличал «письмо ещё не мигрировано» от «письмо удалено», и удалённые письма
  реимпортировались из статичного legacy-файла при каждом перезапуске плагина).
