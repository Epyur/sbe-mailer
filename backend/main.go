package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Email struct {
	ID           int64    `json:"id"`
	Number       string   `json:"number"`
	Subject      string   `json:"subject"`
	Text         string   `json:"text"`
	Author       string   `json:"author"`
	Date         string   `json:"date"`
	DirectionID  int64    `json:"direction_id"`
	DirectionName string  `json:"direction_name"`
	Images       []string `json:"images"`
	MDFilePath   string   `json:"mdFilePath"`
	MDFileHash   string   `json:"mdFileHash"`
	LastSyncTime string   `json:"lastSyncTime"`
	SyncStatus   string   `json:"sync_status"`
	CreatedAt    string   `json:"created_at"`
	UpdatedAt    string   `json:"updated_at"`
}

type PushRequest struct {
	Emails []Email `json:"emails"`
}

type Server struct {
	pool         *pgxpool.Pool
	templatePath string
}

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	if err := loadJWTSecret(); err != nil {
		log.Fatalf("JWT: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("ping: %v", err)
	}

	s := &Server{pool: pool}
	templatePath := os.Getenv("MAILER_TEMPLATE_DIR")
	if templatePath == "" {
		templatePath = "/app/templates/standard.docx"
	}
	s.templatePath = templatePath
	if err := s.migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	if err := s.seedOwner(ctx); err != nil {
		log.Fatalf("seedOwner: %v", err)
	}
	regCtx, regCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer regCancel()
	if err := s.registerApp(regCtx); err != nil {
		log.Printf("registerApp (non-fatal): %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("POST /api/mailer/sync/push", s.requirePerm("editor")(s.handlePush))
	mux.HandleFunc("GET /api/mailer/sync/pull", s.requirePerm("viewer")(s.handlePull))
	mux.HandleFunc("GET /api/mailer/template", s.requirePerm("viewer")(s.handleTemplate))
	mux.HandleFunc("GET /api/mailer/permissions", s.requirePerm("admin")(s.handleListPermissions))
	mux.HandleFunc("POST /api/mailer/permissions", s.requirePerm("admin")(s.handleSetPermission))
	mux.HandleFunc("GET /api/mailer/permissions/me", s.requirePerm("viewer")(s.handleMyPermission))
	mux.HandleFunc("GET /api/mailer/common-access", s.requirePerm("admin")(s.handleGetCommonAccess))
	mux.HandleFunc("POST /api/mailer/common-access", s.requirePerm("admin")(s.handleSetCommonAccess))
	mux.HandleFunc("POST /api/mailer/delete", s.requirePerm("admin")(s.handleDeleteEmail))
	// Поиск по базе отключён (LLM-генерация работает по локальной базе). Код
	// handleSearch сохранён ниже — вернуть при решении вопроса с подключением LLM к серверу.
	// mux.HandleFunc("POST /api/mailer/search", s.requirePerm("user")(s.handleSearch))

	httpServer := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("mailer-service listening on :%s", port)
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatalf("ListenAndServe: %v", err)
	}
}

func (s *Server) migrate(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `CREATE EXTENSION IF NOT EXISTS pg_trgm`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS emails (
	id           BIGSERIAL PRIMARY KEY,
	number       TEXT NOT NULL DEFAULT '',
	subject      TEXT NOT NULL DEFAULT '',
	text         TEXT NOT NULL DEFAULT '',
	author       TEXT NOT NULL DEFAULT '',
	date         TEXT NOT NULL DEFAULT '',
	direction_id BIGINT NOT NULL DEFAULT 0,
	images       JSONB NOT NULL DEFAULT '[]',
	created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
)`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
ALTER TABLE emails ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
ALTER TABLE emails ADD COLUMN IF NOT EXISTS direction_name TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS mailer_permissions (
	app   TEXT NOT NULL,
	email TEXT NOT NULL,
	role  TEXT NOT NULL,
	PRIMARY KEY (app, email)
)`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS mailer_common_access (
	app    TEXT PRIMARY KEY,
	level  TEXT NOT NULL DEFAULT ''
)`); err != nil {
		return err
	}
	// Миграция старых ролей: user → editor (admin остаётся).
	if _, err := s.pool.Exec(ctx, `
UPDATE mailer_permissions SET role = 'editor' WHERE role = 'user'`); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `DROP TABLE IF EXISTS tokens`)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `CREATE INDEX IF NOT EXISTS emails_subject_trgm_idx ON emails USING gin (subject gin_trgm_ops)`)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `CREATE INDEX IF NOT EXISTS emails_text_trgm_idx ON emails USING gin (text gin_trgm_ops)`)
	return err
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	var req PushRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if len(req.Emails) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"inserted": 0, "updated": 0})
		return
	}

	now := time.Now().UTC()
	inserted := 0
	updated := 0
	for _, e := range req.Emails {
		images := e.Images
		if images == nil {
			images = []string{}
		}
		imagesJSON, err := json.Marshal(images)
		if err != nil {
			imagesJSON = []byte("[]")
		}
		updatedAt := parseTime(e.UpdatedAt, now)

		if e.ID > 0 {
			tag, err := s.pool.Exec(r.Context(), `
UPDATE emails SET
	number = $2, subject = $3, text = $4, author = $5, date = $6,
	direction_id = $7, direction_name = $8, images = $9, updated_at = $10
WHERE id = $1 AND updated_at < $10`, e.ID, e.Number, e.Subject, e.Text, e.Author,
				e.Date, e.DirectionID, e.DirectionName, imagesJSON, updatedAt)
			if err != nil {
				log.Printf("push update: %v", err)
				continue
			}
			if tag.RowsAffected() > 0 {
				updated++
				continue
			}
			insTag, err := s.pool.Exec(r.Context(), `
INSERT INTO emails (id, number, subject, text, author, date, direction_id, direction_name, images, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
ON CONFLICT (id) DO NOTHING`, e.ID, e.Number, e.Subject, e.Text, e.Author,
				e.Date, e.DirectionID, e.DirectionName, imagesJSON, updatedAt)
			if err != nil {
				log.Printf("push insert by id: %v", err)
				continue
			}
			if insTag.RowsAffected() > 0 {
				inserted++
				s.bumpSequence(r.Context())
			}
			continue
		}

		_, err = s.pool.Exec(r.Context(), `
INSERT INTO emails (number, subject, text, author, date, direction_id, direction_name, images, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`, e.Number, e.Subject, e.Text, e.Author,
			e.Date, e.DirectionID, e.DirectionName, imagesJSON, updatedAt)
		if err != nil {
			log.Printf("push insert: %v", err)
			continue
		}
		inserted++
	}

	writeJSON(w, http.StatusOK, map[string]any{"inserted": inserted, "updated": updated})
}

func (s *Server) handlePull(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
SELECT id, number, subject, text, author, date, direction_id, direction_name, images, created_at, updated_at
FROM emails ORDER BY id`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()

	emails := make([]Email, 0, 64)
	for rows.Next() {
		var e Email
		var imagesRaw []byte
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&e.ID, &e.Number, &e.Subject, &e.Text, &e.Author, &e.Date,
			&e.DirectionID, &e.DirectionName, &imagesRaw, &createdAt, &updatedAt); err != nil {
			log.Printf("pull scan: %v", err)
			continue
		}
		e.CreatedAt = createdAt.Format(time.RFC3339)
		e.UpdatedAt = updatedAt.Format(time.RFC3339)
		if len(imagesRaw) > 0 && string(imagesRaw) != "[]" {
			_ = json.Unmarshal(imagesRaw, &e.Images)
		}
		if e.Images == nil {
			e.Images = []string{}
		}
		e.MDFilePath = ""
		e.MDFileHash = ""
		e.LastSyncTime = e.UpdatedAt
		e.SyncStatus = "synced"
		emails = append(emails, e)
	}
	if err := rows.Err(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"emails": emails})
}

// handleDeleteEmail удаляет письмо по id (только admin).
func (s *Server) handleDeleteEmail(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID int64 `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if req.ID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "id is required"})
		return
	}
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM emails WHERE id = $1`, req.ID)
	if err != nil {
		log.Printf("delete email: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": tag.RowsAffected()})
}

// handleTemplate отдаёт DOCX-шаблон письма (файл из MAILER_TEMPLATE_DIR).
func (s *Server) handleTemplate(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(s.templatePath)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "template not found"})
		return
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	w.Header().Set("Content-Disposition", `attachment; filename="standard.docx"`)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// handleSearch — полнотекстовый поиск по письмам (tsvector + pg_trgm).
// Тело: {"query": "...", "limit": N}. Возвращает {results: [{id, number, subject,
// text, author, date, direction_id, rank, similarity}]}, сортировка по релевантности.
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Query = strings.TrimSpace(req.Query)
	if req.Query == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "query is required"})
		return
	}
	if req.Limit <= 0 || req.Limit > 50 {
		req.Limit = 10
	}

	// Строим tsquery с OR-семантикой: любое слово запроса уже даёт совпадение.
	// websearch_to_tsquery поддерживает « OR »; слова-стоп-токены отбрасываются.
	orQuery := strings.Join(strings.Fields(req.Query), " OR ")
	words := strings.Fields(req.Query)
	quoted := make([]string, 0, len(words))
	for _, w := range words {
		if w == "" {
			continue
		}
		quoted = append(quoted, `"%`+strings.ReplaceAll(w, `"`, `""`)+`%"`)
	}
	wordArray := "{}"
	if len(quoted) > 0 {
		wordArray = "{" + strings.Join(quoted, ",") + "}"
	}

	rows, err := s.pool.Query(r.Context(), `
SELECT id, number, subject, text, author, date, direction_id,
	ts_rank(to_tsvector('russian', coalesce(subject,'') || ' ' || coalesce(text,'')),
		websearch_to_tsquery('russian', $2)) AS rank,
	COALESCE(GREATEST(similarity(subject, $1), similarity(text, $1)), 0) AS sim,
	(SELECT count(*) FROM unnest($3::text[]) AS w(word)
	 WHERE (coalesce(subject,'') || ' ' || coalesce(text,'')) ILIKE w.word) AS hits
FROM emails
WHERE to_tsvector('russian', coalesce(subject,'') || ' ' || coalesce(text,''))
	@@ websearch_to_tsquery('russian', $2)
   OR subject ILIKE ANY($3)
   OR text ILIKE ANY($3)
   OR subject % $1
   OR text % $1
ORDER BY hits DESC, rank DESC, sim DESC, id DESC
LIMIT $4`, req.Query, orQuery, wordArray, req.Limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()

	type result struct {
		ID          int64   `json:"id"`
		Number      string  `json:"number"`
		Subject     string  `json:"subject"`
		Text        string  `json:"text"`
		Author      string  `json:"author"`
		Date        string  `json:"date"`
		DirectionID int64   `json:"direction_id"`
		Rank        float64 `json:"rank"`
		Similarity  float64 `json:"similarity"`
		Hits        int     `json:"hits"`
	}
	results := make([]result, 0, req.Limit)
	for rows.Next() {
		var res result
		if err := rows.Scan(&res.ID, &res.Number, &res.Subject, &res.Text, &res.Author, &res.Date,
			&res.DirectionID, &res.Rank, &res.Similarity, &res.Hits); err != nil {
			log.Printf("search scan: %v", err)
			continue
		}
		if res.Date != "" {
			if t, err := time.Parse(time.RFC3339, res.Date); err == nil {
				res.Date = t.Format(time.RFC3339)
			}
		}
		results = append(results, res)
	}
	if err := rows.Err(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (s *Server) bumpSequence(ctx context.Context) {
	_, _ = s.pool.Exec(ctx, `
SELECT setval(pg_get_serial_sequence('emails', 'id'),
	GREATEST((SELECT COALESCE(MAX(id), 0) FROM emails), (SELECT last_value FROM emails_id_seq)), true)`)
}

func parseTime(v string, fallback time.Time) time.Time {
	if v == "" {
		return fallback
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return fallback
	}
	return t
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: %v", err)
	}
}
