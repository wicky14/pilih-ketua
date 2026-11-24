package main

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const (
	ballotCookie  = "pk_ballot"
	sessionCookie = "pk_sid"
	sessionDays   = 7
)

// ---------------------------------------------------------------- models

type nullableInt struct{ sql.NullInt64 }

func (n nullableInt) MarshalJSON() ([]byte, error) {
	if !n.Valid {
		return []byte("null"), nil
	}
	return json.Marshal(n.Int64)
}

type Election struct {
	ID             int         `json:"id"`
	Title          string      `json:"title"`
	Description    string      `json:"description"`
	Slug           string      `json:"slug"`
	TestMode       bool        `json:"test_mode"`
	OpensAt        int64       `json:"opens_at"`
	ClosesAt       int64       `json:"closes_at"`
	AllowRevote    bool        `json:"allow_revote"`
	RandomizeOrder bool        `json:"randomize_order"`
	ShowResults    bool        `json:"show_results"`
	ExpectedVoters nullableInt `json:"expected_voters"`
	UpdatedAt      int64       `json:"updated_at"`
	Status         string      `json:"status,omitempty"`
}

type PublicElection struct {
	Title          string `json:"title"`
	Description    string `json:"description"`
	Status         string `json:"status"`
	OpensAt        int64  `json:"opens_at"`
	ClosesAt       int64  `json:"closes_at"`
	TestMode       bool   `json:"test_mode"`
	RandomizeOrder bool   `json:"randomize_order"`
}

type Candidate struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	Tagline   string `json:"tagline"`
	PhotoPath string `json:"photo_path"`
	PhotoURL  string `json:"photo_url"`
	Visi      string `json:"visi"`
	Misi      string `json:"misi"`
	SortOrder int    `json:"sort_order"`
	Active    bool   `json:"active"`
	CreatedAt int64  `json:"created_at"`
}

type Announcement struct {
	ID          int         `json:"id"`
	Title       string      `json:"title"`
	Body        string      `json:"body"`
	PublishAt   int64       `json:"publish_at"`
	UnpublishAt nullableInt `json:"unpublish_at"`
	ShowVoter   bool        `json:"show_voter"`
	ShowDisplay bool        `json:"show_display"`
	CreatedAt   int64       `json:"created_at"`
}

type Ballot struct {
	ID          int
	CandidateID int
	TokenHash   string
	IPHash      string
	CreatedAt   int64
	UpdatedAt   int64
}

type TallyRow struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	PhotoPath string `json:"photo_path"`
	PhotoURL  string `json:"photo_url"`
	Active    bool   `json:"active"`
	SortOrder int    `json:"sort_order"`
	Votes     int    `json:"votes"`
}

type ResultRow struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	PhotoPath string `json:"photo_path"`
	PhotoURL  string `json:"photo_url"`
	Votes     int    `json:"votes"`
}

type AuditRow struct {
	Action    string `json:"action"`
	Meta      string `json:"meta"`
	CreatedAt int64  `json:"created_at"`
}

type Admin struct {
	ID       int
	Username string
}

// ---------------------------------------------------------------- store

type store struct {
	db        *sql.DB
	cfg       config
	secret    string
	dummyHash string
	loc       *time.Location
}

func openStore(cfg config, secret string) (*store, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cfg.UploadDir, 0o755); err != nil {
		return nil, err
	}

	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)

	pragmas := []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = NORMAL",
		"PRAGMA busy_timeout = 5000",
		"PRAGMA foreign_keys = ON",
	}
	for _, pragma := range pragmas {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("%s: %w", pragma, err)
		}
	}

	s := &store{
		db:        db,
		cfg:       cfg,
		secret:    secret,
		dummyHash: hashPassword("dummy-password-for-timing"),
		loc:       loadLocation(cfg.Timezone),
	}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	if err := s.bootstrap(); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec("DELETE FROM sessions WHERE expires_at < ?", nowMS()); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func loadLocation(name string) *time.Location {
	if loc, err := time.LoadLocation(name); err == nil {
		return loc
	}
	log.Printf("[init] TZ %q tidak ditemukan, pakai UTC", name)
	return time.UTC
}

func (s *store) tzOffset() int {
	_, offset := time.Now().In(s.loc).Zone()
	return offset
}

func (s *store) migrate() error {
	const schema = `
	CREATE TABLE IF NOT EXISTS meta (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS admins (
		id            INTEGER PRIMARY KEY,
		username      TEXT NOT NULL UNIQUE,
		password_hash TEXT NOT NULL,
		created_at    INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS sessions (
		id         TEXT PRIMARY KEY,
		admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
		expires_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS election (
		id              INTEGER PRIMARY KEY CHECK (id = 1),
		title           TEXT NOT NULL,
		description     TEXT NOT NULL DEFAULT '',
		slug            TEXT NOT NULL UNIQUE,
		test_mode       INTEGER NOT NULL DEFAULT 0,
		opens_at        INTEGER NOT NULL,
		closes_at       INTEGER NOT NULL,
		allow_revote    INTEGER NOT NULL DEFAULT 1,
		randomize_order INTEGER NOT NULL DEFAULT 1,
		show_results    INTEGER NOT NULL DEFAULT 0,
		expected_voters INTEGER,
		updated_at      INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS candidates (
		id         INTEGER PRIMARY KEY,
		name       TEXT NOT NULL,
		tagline    TEXT NOT NULL DEFAULT '',
		photo_path TEXT NOT NULL DEFAULT '',
		visi       TEXT NOT NULL DEFAULT '',
		misi       TEXT NOT NULL DEFAULT '',
		sort_order INTEGER NOT NULL DEFAULT 0,
		active     INTEGER NOT NULL DEFAULT 1,
		created_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS announcements (
		id           INTEGER PRIMARY KEY,
		title        TEXT NOT NULL,
		body         TEXT NOT NULL,
		publish_at   INTEGER NOT NULL,
		unpublish_at INTEGER,
		show_voter   INTEGER NOT NULL DEFAULT 1,
		show_display INTEGER NOT NULL DEFAULT 1,
		created_at   INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS ballots (
		id                INTEGER PRIMARY KEY,
		candidate_id      INTEGER NOT NULL REFERENCES candidates(id),
		cookie_token_hash TEXT NOT NULL UNIQUE,
		ip_hash           TEXT NOT NULL DEFAULT '',
		created_at        INTEGER NOT NULL,
		updated_at        INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS audit_log (
		id         INTEGER PRIMARY KEY,
		action     TEXT NOT NULL,
		meta       TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_ballots_candidate ON ballots(candidate_id);
	CREATE INDEX IF NOT EXISTS idx_announcements_time ON announcements(publish_at, unpublish_at);
	`
	_, err := s.db.Exec(schema)
	return err
}

func (s *store) bootstrap() error {
	var count int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM admins").Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		username := s.cfg.AdminUser
		password := s.cfg.AdminPass
		if _, err := s.db.Exec(
			"INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)",
			username, hashPassword(password), nowMS(),
		); err != nil {
			return err
		}
		log.Printf("[init] admin dibuat: %s / %s", username, password)
	}

	_, err := s.getElection()
	if errors.Is(err, sql.ErrNoRows) {
		t := nowMS()
		slug := randomSlug(10)
		if _, err := s.db.Exec(
			`INSERT INTO election
			 (id, title, description, slug, test_mode, opens_at, closes_at,
			  allow_revote, randomize_order, show_results, expected_voters, updated_at)
			 VALUES (1, ?, ?, ?, 0, ?, ?, 1, 1, 0, NULL, ?)`,
			"Pemilihan Ketua Paguyuban",
			"Masa bakti 2026–2029",
			slug,
			t-60_000,
			t+7*86_400_000,
			t,
		); err != nil {
			return err
		}
		if err := s.db.QueryRow("SELECT COUNT(*) FROM candidates").Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			insert := `INSERT INTO candidates
				(name, tagline, photo_path, visi, misi, sort_order, active, created_at)
				VALUES (?, ?, '', ?, ?, ?, 1, ?)`
			if _, err := s.db.Exec(insert,
				"Budi Santoso",
				"Merawat yang ada, membangun yang belum",
				"Paguyuban yang guyub, transparan, dan aktif.",
				"Mengaktifkan kegiatan rutin\nMembuka laporan keuangan tiap bulan\nMerangkul anggota baru",
				0, t,
			); err != nil {
				return err
			}
			if _, err := s.db.Exec(insert,
				"Sari Dewi",
				"Dari kita, untuk kita semua",
				"Paguyuban yang inklusif dan mandiri.",
				"Program usaha bersama\nKegiatan sosial tiap kuartal\nDana darurat anggota",
				1, t,
			); err != nil {
				return err
			}
		}
		if _, err := s.db.Exec(
			`INSERT INTO announcements
			 (title, body, publish_at, unpublish_at, show_voter, show_display, created_at)
			 VALUES (?, ?, ?, NULL, 1, 1, ?)`,
			"Selamat datang",
			"Pemilihan dibuka. Pilih satu calon, dan suara bisa diubah sampai waktu ditutup.",
			t, t,
		); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	return nil
}

// ---------------------------------------------------------------- queries

type scanner interface{ Scan(dest ...any) error }

func scanElection(row scanner) (*Election, error) {
	var e Election
	var testMode, allowRevote, randomize, showResults int
	var expected sql.NullInt64
	err := row.Scan(
		&e.ID, &e.Title, &e.Description, &e.Slug,
		&testMode, &e.OpensAt, &e.ClosesAt,
		&allowRevote, &randomize, &showResults, &expected, &e.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	e.TestMode = testMode != 0
	e.AllowRevote = allowRevote != 0
	e.RandomizeOrder = randomize != 0
	e.ShowResults = showResults != 0
	e.ExpectedVoters = nullableInt{expected}
	return &e, nil
}

func (s *store) getElection() (*Election, error) {
	return scanElection(s.db.QueryRow(
		`SELECT id, title, description, slug, test_mode, opens_at, closes_at,
		        allow_revote, randomize_order, show_results, expected_voters, updated_at
		 FROM election WHERE id = 1`,
	))
}

func electionStatus(e *Election, t int64) string {
	if t < e.OpensAt {
		return "upcoming"
	}
	if t >= e.ClosesAt {
		return "closed"
	}
	return "open"
}

func (s *store) totalVotes() (int, error) {
	var count int
	err := s.db.QueryRow("SELECT COUNT(*) FROM ballots").Scan(&count)
	return count, err
}

func scanCandidate(rows scanner) (Candidate, error) {
	var c Candidate
	var active int
	err := rows.Scan(&c.ID, &c.Name, &c.Tagline, &c.PhotoPath, &c.Visi, &c.Misi, &c.SortOrder, &active, &c.CreatedAt)
	c.Active = active != 0
	c.PhotoURL = c.PhotoPath
	return c, err
}

func (s *store) publicCandidates() ([]Candidate, error) {
	rows, err := s.db.Query(
		`SELECT id, name, tagline, photo_path, visi, misi, sort_order, active, created_at
		 FROM candidates WHERE active = 1 ORDER BY sort_order, id`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []Candidate
	for rows.Next() {
		candidate, err := scanCandidate(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, candidate)
	}
	return list, rows.Err()
}

func (s *store) allCandidates() ([]Candidate, error) {
	rows, err := s.db.Query(
		`SELECT id, name, tagline, photo_path, visi, misi, sort_order, active, created_at
		 FROM candidates ORDER BY sort_order, id`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []Candidate
	for rows.Next() {
		candidate, err := scanCandidate(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, candidate)
	}
	return list, rows.Err()
}

func (s *store) activeAnnouncements(t int64, audience string) ([]Announcement, error) {
	column := "show_voter"
	if audience == "display" {
		column = "show_display"
	}
	query := fmt.Sprintf(
		`SELECT id, title, body, publish_at, unpublish_at, show_voter, show_display, created_at
		 FROM announcements
		 WHERE publish_at <= ? AND (unpublish_at IS NULL OR unpublish_at > ?) AND %s = 1
		 ORDER BY publish_at DESC`, column,
	)
	rows, err := s.db.Query(query, t, t)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []Announcement
	for rows.Next() {
		var a Announcement
		var unpublish sql.NullInt64
		var showVoter, showDisplay int
		if err := rows.Scan(&a.ID, &a.Title, &a.Body, &a.PublishAt, &unpublish, &showVoter, &showDisplay, &a.CreatedAt); err != nil {
			return nil, err
		}
		a.UnpublishAt = nullableInt{unpublish}
		a.ShowVoter = showVoter != 0
		a.ShowDisplay = showDisplay != 0
		list = append(list, a)
	}
	return list, rows.Err()
}

func (s *store) allAnnouncements() ([]Announcement, error) {
	rows, err := s.db.Query(
		`SELECT id, title, body, publish_at, unpublish_at, show_voter, show_display, created_at
		 FROM announcements ORDER BY publish_at DESC, id DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []Announcement
	for rows.Next() {
		var a Announcement
		var unpublish sql.NullInt64
		var showVoter, showDisplay int
		if err := rows.Scan(&a.ID, &a.Title, &a.Body, &a.PublishAt, &unpublish, &showVoter, &showDisplay, &a.CreatedAt); err != nil {
			return nil, err
		}
		a.UnpublishAt = nullableInt{unpublish}
		a.ShowVoter = showVoter != 0
		a.ShowDisplay = showDisplay != 0
		list = append(list, a)
	}
	return list, rows.Err()
}

func scanBallot(row scanner) (*Ballot, error) {
	var b Ballot
	err := row.Scan(&b.ID, &b.CandidateID, &b.TokenHash, &b.IPHash, &b.CreatedAt, &b.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &b, nil
}

func (s *store) ballotByToken(token string) (*Ballot, error) {
	if token == "" {
		return nil, nil
	}
	ballot, err := scanBallot(s.db.QueryRow(
		`SELECT id, candidate_id, cookie_token_hash, ip_hash, created_at, updated_at
		 FROM ballots WHERE cookie_token_hash = ?`, sha256Hex(token),
	))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return ballot, err
}

func (s *store) myBallot(r *http.Request) (*Ballot, error) {
	cookie, err := r.Cookie(ballotCookie)
	if errors.Is(err, http.ErrNoCookie) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.ballotByToken(cookie.Value)
}

func (s *store) resultRows() ([]ResultRow, error) {
	rows, err := s.db.Query(
		`SELECT c.id, c.name, c.photo_path,
		        (SELECT COUNT(*) FROM ballots b WHERE b.candidate_id = c.id) AS votes
		 FROM candidates c WHERE c.active = 1 ORDER BY c.sort_order, c.id`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []ResultRow
	for rows.Next() {
		var row ResultRow
		if err := rows.Scan(&row.ID, &row.Name, &row.PhotoPath, &row.Votes); err != nil {
			return nil, err
		}
		row.PhotoURL = row.PhotoPath
		list = append(list, row)
	}
	return list, rows.Err()
}

func (s *store) adminTally() ([]TallyRow, error) {
	rows, err := s.db.Query(
		`SELECT c.id, c.name, c.photo_path, c.active, c.sort_order,
		        (SELECT COUNT(*) FROM ballots b WHERE b.candidate_id = c.id) AS votes
		 FROM candidates c ORDER BY c.sort_order, c.id`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []TallyRow
	for rows.Next() {
		var row TallyRow
		var active int
		if err := rows.Scan(&row.ID, &row.Name, &row.PhotoPath, &active, &row.SortOrder, &row.Votes); err != nil {
			return nil, err
		}
		row.Active = active != 0
		row.PhotoURL = row.PhotoPath
		list = append(list, row)
	}
	return list, rows.Err()
}

func (s *store) audit(action, meta string) {
	payload := meta
	if payload == "" {
		payload = "{}"
	}
	if len(payload) > 2000 {
		payload = payload[:2000]
	}
	if _, err := s.db.Exec(
		"INSERT INTO audit_log (action, meta, created_at) VALUES (?, ?, ?)",
		action, payload, nowMS(),
	); err != nil {
		log.Println("[audit]", err)
	}
}

func (s *store) auditJSON(action string, meta any) {
	encoded, err := json.Marshal(meta)
	if err != nil {
		s.audit(action, "{}")
		return
	}
	s.audit(action, string(encoded))
}

func (s *store) auditRows() ([]AuditRow, error) {
	rows, err := s.db.Query("SELECT action, meta, created_at FROM audit_log ORDER BY id DESC LIMIT 20")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []AuditRow
	for rows.Next() {
		var row AuditRow
		if err := rows.Scan(&row.Action, &row.Meta, &row.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, row)
	}
	return list, rows.Err()
}

// ---------------------------------------------------------------- sessions

func (s *store) currentAdmin(r *http.Request) (*Admin, error) {
	cookie, err := r.Cookie(sessionCookie)
	if errors.Is(err, http.ErrNoCookie) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var admin Admin
	var expiresAt int64
	err = s.db.QueryRow(
		`SELECT s.admin_id, s.expires_at, a.username
		 FROM sessions s JOIN admins a ON a.id = s.admin_id
		 WHERE s.id = ?`, sha256Hex(cookie.Value),
	).Scan(&admin.ID, &expiresAt, &admin.Username)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && expiresAt < nowMS()) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &admin, nil
}

func (s *store) startSession(w http.ResponseWriter, r *http.Request, adminID int) error {
	token := randomHex(32)
	if _, err := s.db.Exec(
		"INSERT INTO sessions (id, admin_id, expires_at) VALUES (?, ?, ?)",
		sha256Hex(token), adminID, nowMS()+sessionDays*86_400_000,
	); err != nil {
		return err
	}
	setCookie(w, r, sessionCookie, token, sessionDays*86_400, s.cfg.CookieSecure)
	return nil
}

func (s *store) endSession(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookie); err == nil {
		_, _ = s.db.Exec("DELETE FROM sessions WHERE id = ?", sha256Hex(cookie.Value))
	}
	clearCookie(w, r, sessionCookie, s.cfg.CookieSecure)
}

// ---------------------------------------------------------------- photos

var (
	photoDataURLPattern = regexp.MustCompile(`^data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$`)
	uploadNamePattern   = regexp.MustCompile(`^[a-f0-9-]+\.(png|jpg|webp)$`)
)

func detectImage(buffer []byte) string {
	if len(buffer) > 8 && buffer[0] == 0x89 && buffer[1] == 0x50 && buffer[2] == 0x4e && buffer[3] == 0x47 {
		return "png"
	}
	if len(buffer) > 3 && buffer[0] == 0xff && buffer[1] == 0xd8 && buffer[2] == 0xff {
		return "jpg"
	}
	if len(buffer) > 12 && string(buffer[:4]) == "RIFF" && string(buffer[8:12]) == "WEBP" {
		return "webp"
	}
	return ""
}

func (s *store) savePhoto(dataURL string) (string, error) {
	match := photoDataURLPattern.FindStringSubmatch(strings.TrimSpace(dataURL))
	if match == nil {
		return "", fail(400, "foto_tidak_valid")
	}
	buffer, err := base64.StdEncoding.DecodeString(match[2])
	if err != nil {
		return "", fail(400, "foto_tidak_valid")
	}
	if len(buffer) > 2_500_000 {
		return "", fail(413, "foto_terlalu_besar")
	}
	ext := detectImage(buffer)
	if ext == "" {
		return "", fail(400, "foto_tidak_valid")
	}
	filename := randomHex(24) + "." + ext
	if err := os.WriteFile(filepath.Join(s.cfg.UploadDir, filename), buffer, 0o644); err != nil {
		return "", err
	}
	return "/uploads/" + filename, nil
}

func (s *store) removeUpload(photoPath string) {
	if !strings.HasPrefix(photoPath, "/uploads/") {
		return
	}
	filename := strings.TrimPrefix(photoPath, "/uploads/")
	if !uploadNamePattern.MatchString(filename) {
		return
	}
	_ = os.Remove(filepath.Join(s.cfg.UploadDir, filename))
}
