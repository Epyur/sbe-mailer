# AGENTS.md — backend (mailer-service)

Go-бэкенд «mailer-service» — серверная часть почтового модуля SBE. Контейнер `backend`,
БД `mailers` (postgres), авторизация — JWT HS256 (общий `JWT_SECRET` с auth-service) + роли из
таблицы `mailer_permissions`. Деплой: `/opt/mailers/backend/`.

## Назначение (текущее)

- `POST /api/mailer/sync/push` — приём/обновление писем `{emails:[...]}`, upsert по `id`,
  LWW по `updated_at`, ответ `{inserted:N, updated:M}`.
- `GET /api/mailer/sync/pull` — выгрузка писем (поля совместимы с `Email`-моделью).
- `GET /api/mailer/template` — DOCX-шаблон письма (`MAILER_TEMPLATE_DIR`).
- `GET /api/health`.
- ~~`POST /api/mailer/search`~~ — **отключён** (код сохранён; см. «История»).
- Таблицы: `emails`, `mailer_permissions(app, email, role)`.
- Авторизация: `requirePerm("user")` — JWT → email → роль в `mailer_permissions`;
  роли: `user`(1) / `admin`(2), отсутствие роли → 403, плохой/просроченный JWT → 401.
- При старте: `POST /apps/register` в auth-service (service_secret, owner_email), seed
  `owner_email=admin` в `mailer_permissions`. `tokens`/`INIT_TOKEN`/`/api/sync/*` удалены.
- CORS `*`. Сборка статик (`CGO_ENABLED=0`).

## Конфиг (env)

`DATABASE_URL`, `PORT`, `JWT_SECRET`, `MAILER_APP_ID` (default `mailer`), `MAILER_APP_NAME`,
`MAILER_OWNER_EMAIL`, `MAILER_SERVICE_SECRET`, `AUTH_SERVICE_URL` (default `http://auth-service:3000`).

## Модель синхронизации (согласовано 2026-08-17)

- Сервер — **каноническое хранилище** писем; локальный JSON (`yourbase/sbe_mailer/`) — кэш
  на каждой машине. Межмашинная синхронизация — только push/pull через сервер, без YouGile.
- Конфликты: сервер авторитетен, «последняя правка wins» по `updated_at`, pull — merge по `id`.
- Миграция существующих писем (из YouGile-задач `type:"email"` / `mailer_data.json`) — одноразовый
  импорт на первом запуске `sbe-mailer` (Этап 4).

## Сборка / проверка

```
docker compose up -d --build backend        # на сервере
docker compose exec backend wget -qO- http://localhost:3000/api/health
```

## История

- **2026-08-16 и ранее:** легаси-бэкенд синхронизации писем (Bearer API_TOKEN, `/api/sync/*`).
  См. [process.md](../../process.md).
- **2026-08-17:** перенесено в `server_back/backend` как рабочая копия; без изменений кода.
- **2026-08-17 — Этап 3 плана авторизации (mailer-service):**
  `tokens`/`INIT_TOKEN`/`requireAuth`/`/api/sync/*` удалены. Добавлены `jwt.go` (`parseJWT`,
  `requirePerm`), `register.go` (`registerApp` → `/apps/register`, `seedOwner`),
  таблица `mailer_permissions`, маршруты `/api/mailer/sync/push|pull`. Upsert по `id` с LWW
  по `updated_at` (новое поле в `emails`), `bumpSequence` после вставки с явным `id`.
  `go.mod`: + `golang-jwt/jwt/v5`. `docker-compose.yml`: env `JWT_SECRET`/`MAILER_*`/`AUTH_SERVICE_URL`,
  `INIT_TOKEN` убран, `depends_on` auth-service. `.env.example`: `API_TOKEN` убран.
  Проверено E2E (скрипты на сервере): health 200; pull без JWT → 401; JWT из `/auth/token`
  (`polishchuk@tn.ru`) → pull 200, push `inserted:1`; LWW: новее `updated_at` → `updated:1`,
  старее → `updated:0` (сервер побеждает); JWT без роли (`nobody@tn.ru`) → 403;
  плохая подпись → 401. Старый `/api/sync/pull` → 404. Тестовое письмо удалено (в БД 3 письма).
  `mailer_permissions`: `mailer/polishchuk@tn.ru/admin`. В auth-service apps: `mailer` с секретом.
- **2026-08-17 — шаблон письма (`GET /api/mailer/template`):**
  Новый endpoint (JWT `user`) отдаёт DOCX-шаблон `standard.docx`. Файл — на сервере
  `/opt/mailers/templates/standard.docx` (pscp) и в S3 `firstvds:mailers-backup/templates/`
  (rclone). Путь — env `MAILER_TEMPLATE_DIR` (default `/app/templates/standard.docx`),
  compose: mount `./templates:/app/templates:ro`. E2E: 401 без токена, 200 + DOCX
  content-type, размер/MD5 совпали с исходником. Бэкап `main.go.bak4`.
- **2026-08-17 — серверный поиск (`POST /api/mailer/search`): добавлен и отключён.**
  `CREATE EXTENSION IF NOT EXISTS pg_trgm` + GIN-индексы на `subject`/`text`
  (`gin_trgm_ops`). `handleSearch`: tsvector (рус.) + pg_trgm, сначала
  `plainto_tsquery` (AND — естественно-языковые запросы не находились), затем переписано
  на `websearch_to_tsquery` (OR) + per-word `ILIKE ANY` + trigram `%` + счётчик `hits`
  (сортировка `hits DESC, rank DESC, sim DESC`). E2E: 401/200/400.
  ⚠️ **Решение 2026-08-17:** LLM-генерация переведена на локальную базу плагина,
  маршрут `/api/mailer/search` **закомментирован** (код `handleSearch` сохранён), на
  сервере endpoint → 404. Возврат — при решении вопроса с подключением LLM к серверу.
  Бэкапы `main.go.bak5..bak8`.
- **2026-08-17 — синхронизация баз (одноразовая):**
  В БД до-залито 298 легаси-писем (скрипты push через API): 268 с legacy-id, 27 + 4
  с новыми id (`id=0`; legacy-дубли по subject/id коллизировали с существующими строками).
  Итог: `emails` = 868, направления: Пожарная безопасность 334, Кровли и фасады 317,
  Гидроизоляция 117, Комплектация 82, Объектная поддержка 10, Сертификация 3, `0` 1.
- **2026-08-17 — `direction_name` в `emails` (sbe-mailer v0.1.3):**
  Колонка `direction_name TEXT NOT NULL DEFAULT ''` (ALTER TABLE в migrate). Модель `Email`
  + push (update/insert) + pull передают `direction_name`. Цель — имя направления приходит
  вместе с письмом, чтобы на другом компьютере оно появлялось в списке выбора.
  E2E: push с direction_name → inserted:1, pull возвращает имя; тест удалён. Бэкап `main.go.bak9`.
- **2026-08-17 — Права доступа (Этап 5, sbe-mailer):**
  `permissions.go`: `GET /api/mailer/permissions/me` (user) → `{email, role, hasAccess}`;
  `GET /api/mailer/permissions` (admin) → `{permissions}`; `POST /api/mailer/permissions
  {email, role}` (admin) — role user/admin/"" (отзыв), владельца отозвать нельзя.
  E2E: me → admin, list, set user → ok, revoke → ok (тест-пользователь удалён).
  Бэкапы `main.go.bak10`, `permissions.go.bak1`.
- **2026-08-17 — Роли + общий доступ (расширение Этапа 5):**
  Роли `viewer`(1) < `commenter`(2) < `editor`(3) < `admin`(4). `effectiveRole` —
  персональная роль или уровень общего доступа. Таблица `mailer_common_access(app, level)`,
  миграция `user`→`editor`. Endpoints: push→editor, pull/template→viewer,
  permissions→admin, `GET/POST /api/mailer/common-access`. E2E: me→admin, common set viewer,
  роли editor/viewer, list. Бэкапы `main.go.bak11`, `jwt.go.bak2`, `permissions.go.bak2`.
- **2026-08-17 — удаление писем (sbe-mailer v0.1.6):**
  `POST /api/mailer/delete {id}` (requirePerm admin) — DELETE из `emails`, ответ `{deleted:N}`.
  E2E: push → delete deleted:1 → исчезло. Бэкап `main.go.bak11` (тот же).

## Статистика ошибок и отступлений

- Правило проекта: импорты без неиспользуемых. Замечаний на текущий момент нет.
- Локальной Go-сборки нет (на машине отсутствует тулчейн) — компиляция проверяется
  сборкой в Docker на сервере (`mailers-backend:latest` собран успешно).
