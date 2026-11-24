package main

import (
	"bytes"
	"database/sql"
	"errors"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type server struct {
	store *store
}

func (s *server) handle(fn func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			var apiErr *apiError
			if errors.As(err, &apiErr) {
				writeJSON(w, apiErr.status, map[string]any{"error": apiErr.code})
				return
			}
			log.Println("[error]", err)
			writeJSON(w, 500, map[string]any{"error": "server_error"})
		}
	}
}

// ---------------------------------------------------------------- routing

func securityHeaders(w http.ResponseWriter) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set(
		"Content-Security-Policy",
		"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
	)
}

func notFound(w http.ResponseWriter) {
	body := `<!doctype html><html lang="id"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tidak ditemukan</title>
<style>body{background:#0B0C1A;color:#F5F2E9;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center}h1{font-size:3rem;margin:0 0 8px}p{color:#A6A9C8}</style>
<div><h1>404</h1><p>Halaman atau link voting tidak ditemukan.</p></div></html>`
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(404)
	_, _ = w.Write([]byte(body))
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	securityHeaders(w)

	pathname := r.URL.Path
	if len(pathname) > 1 {
		pathname = strings.TrimRight(pathname, "/")
	}
	method := r.Method

	if pathname == "/healthz" {
		if method != http.MethodGet && method != http.MethodHead {
			s.writeError(w, fail(405, "method_not_allowed"))
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}

	if method != http.MethodGet && method != http.MethodHead {
		if r.Header.Get("X-PK") != "1" {
			s.writeError(w, fail(403, "csrf"))
			return
		}
		if !sameOrigin(r) {
			s.writeError(w, fail(403, "origin"))
			return
		}
	}

	if strings.HasPrefix(pathname, "/api/") {
		s.apiRoute(w, r, pathname)
		return
	}

	if method != http.MethodGet && method != http.MethodHead {
		s.writeError(w, fail(405, "method_not_allowed"))
		return
	}

	if pathname == "/" {
		election, err := s.store.getElection()
		if err != nil {
			s.writeError(w, err)
			return
		}
		http.Redirect(w, r, "/vote/"+election.Slug, http.StatusFound)
		return
	}

	if pathname == "/admin" {
		s.serveEmbedded(w, r, "admin.html", "no-cache")
		return
	}
	if pathname == "/display" {
		s.serveEmbedded(w, r, "display.html", "no-cache")
		return
	}

	if strings.HasPrefix(pathname, "/vote/") {
		slug := strings.TrimPrefix(pathname, "/vote/")
		if slug == "" || strings.Contains(slug, "/") {
			notFound(w)
			return
		}
		election, err := s.store.getElection()
		if err != nil {
			s.writeError(w, err)
			return
		}
		if slug != election.Slug {
			notFound(w)
			return
		}
		s.serveEmbedded(w, r, "index.html", "no-cache")
		return
	}

	if strings.HasPrefix(pathname, "/assets/") || strings.HasPrefix(pathname, "/fonts/") {
		name := strings.TrimPrefix(pathname, "/")
		if strings.Contains(name, "..") {
			notFound(w)
			return
		}
		s.serveEmbedded(w, r, name, "public, max-age=3600")
		return
	}

	if strings.HasPrefix(pathname, "/uploads/") {
		name := strings.TrimPrefix(pathname, "/uploads/")
		if !uploadNamePattern.MatchString(name) {
			notFound(w)
			return
		}
		data, err := os.ReadFile(filepath.Join(s.store.cfg.UploadDir, name))
		if err != nil {
			notFound(w)
			return
		}
		serveBytes(w, r, name, data, "public, max-age=86400")
		return
	}

	if pathname == "/favicon.ico" || pathname == "/favicon.svg" {
		s.serveEmbedded(w, r, "assets/favicon.svg", "public, max-age=86400")
		return
	}

	notFound(w)
}

var mimeTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".webp":  "image/webp",
	".ico":   "image/x-icon",
	".woff2": "font/woff2",
	".woff":  "font/woff",
	".txt":   "text/plain; charset=utf-8",
}

func serveBytes(w http.ResponseWriter, r *http.Request, name string, data []byte, cache string) {
	contentType := mimeTypes[strings.ToLower(path.Ext(name))]
	if contentType == "" {
		contentType = mime.TypeByExtension(path.Ext(name))
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", cache)
	http.ServeContent(w, r, path.Base(name), time.Time{}, bytes.NewReader(data))
}

func (s *server) serveEmbedded(w http.ResponseWriter, r *http.Request, name, cache string) {
	data, err := publicFS.ReadFile("public/" + name)
	if err != nil {
		notFound(w)
		return
	}
	serveBytes(w, r, name, data, cache)
}

func (s *server) writeError(w http.ResponseWriter, err error) {
	var apiErr *apiError
	if errors.As(err, &apiErr) {
		writeJSON(w, apiErr.status, map[string]any{"error": apiErr.code})
		return
	}
	log.Println("[error]", err)
	writeJSON(w, 500, map[string]any{"error": "server_error"})
}

// ---------------------------------------------------------------- api router

func (s *server) apiRoute(w http.ResponseWriter, r *http.Request, pathname string) {
	method := r.Method
	switch {
	case pathname == "/api/public/state" && method == http.MethodGet:
		s.handle(s.publicState)(w, r)
	case pathname == "/api/public/me" && method == http.MethodGet:
		s.handle(s.handleMe)(w, r)
	case pathname == "/api/public/vote" && method == http.MethodPost:
		s.handle(s.handleVote)(w, r)
	case pathname == "/api/admin/login" && method == http.MethodPost:
		s.handle(s.handleLogin)(w, r)
	case pathname == "/api/admin/logout" && method == http.MethodPost:
		s.handle(s.handleLogout)(w, r)
	default:
		s.protectedAdminRoute(w, r, pathname, method)
	}
}

func (s *server) protectedAdminRoute(w http.ResponseWriter, r *http.Request, pathname, method string) {
	admin, err := s.store.currentAdmin(r)
	if err != nil {
		s.writeError(w, err)
		return
	}
	if admin == nil {
		writeJSON(w, 401, map[string]any{"error": "unauthorized"})
		return
	}

	switch {
	case pathname == "/api/admin/state" && method == http.MethodGet:
		s.handle(func(w http.ResponseWriter, r *http.Request) error {
			return s.adminState(w, r, admin)
		})(w, r)
	case pathname == "/api/admin/election" && method == http.MethodPut:
		s.handle(s.handleUpdateElection)(w, r)
	case pathname == "/api/admin/candidates" && method == http.MethodPost:
		s.handle(s.handleCreateCandidate)(w, r)
	case pathname == "/api/admin/candidates/reorder" && method == http.MethodPost:
		s.handle(s.handleReorderCandidates)(w, r)
	case pathname == "/api/admin/announcements" && method == http.MethodPost:
		s.handle(s.handleCreateAnnouncement)(w, r)
	case pathname == "/api/admin/rotate-link" && method == http.MethodPost:
		s.handle(s.handleRotateLink)(w, r)
	case pathname == "/api/admin/reset" && method == http.MethodPost:
		s.handle(s.handleReset)(w, r)
	case pathname == "/api/admin/password" && method == http.MethodPost:
		s.handle(func(w http.ResponseWriter, r *http.Request) error {
			return s.handlePassword(w, r, admin)
		})(w, r)
	default:
		if id, ok := parseID(pathname, "/api/admin/candidates/"); ok {
			switch method {
			case http.MethodPut:
				s.handle(func(w http.ResponseWriter, r *http.Request) error {
					return s.handleUpdateCandidate(w, r, id)
				})(w, r)
			case http.MethodDelete:
				s.handle(func(w http.ResponseWriter, r *http.Request) error {
					return s.handleDeleteCandidate(w, r, id)
				})(w, r)
			default:
				s.writeError(w, fail(404, "not_found"))
			}
			return
		}
		if id, ok := parseID(pathname, "/api/admin/announcements/"); ok {
			switch method {
			case http.MethodPut:
				s.handle(func(w http.ResponseWriter, r *http.Request) error {
					return s.handleUpdateAnnouncement(w, r, id)
				})(w, r)
			case http.MethodDelete:
				s.handle(func(w http.ResponseWriter, r *http.Request) error {
					return s.handleDeleteAnnouncement(w, r, id)
				})(w, r)
			default:
				s.writeError(w, fail(404, "not_found"))
			}
			return
		}
		s.writeError(w, fail(404, "not_found"))
	}
}

func parseID(pathname, prefix string) (int, bool) {
	if !strings.HasPrefix(pathname, prefix) {
		return 0, false
	}
	value := strings.TrimPrefix(pathname, prefix)
	if value == "" || strings.Contains(value, "/") {
		return 0, false
	}
	id, err := strconv.Atoi(value)
	if err != nil || id < 1 {
		return 0, false
	}
	return id, true
}

// ---------------------------------------------------------------- public api

func (s *server) publicState(w http.ResponseWriter, r *http.Request) error {
	election, err := s.store.getElection()
	if err != nil {
		return err
	}
	if values, exists := r.Header["X-Vote-Slug"]; exists {
		if len(values) == 0 || values[0] != election.Slug {
			return fail(403, "link_tidak_valid")
		}
	}

	t := nowMS()
	status := electionStatus(election, t)
	ballot, err := s.store.myBallot(r)
	if err != nil {
		return err
	}
	candidates, err := s.store.publicCandidates()
	if err != nil {
		return err
	}
	announcements, err := s.store.activeAnnouncements(t, "voter")
	if err != nil {
		return err
	}
	displayAnnouncements, err := s.store.activeAnnouncements(t, "display")
	if err != nil {
		return err
	}
	total, err := s.store.totalVotes()
	if err != nil {
		return err
	}

	var results any
	if status == "closed" && election.ShowResults {
		rows, err := s.store.resultRows()
		if err != nil {
			return err
		}
		results = rows
	}
	var myCandidateID any
	if ballot != nil {
		myCandidateID = ballot.CandidateID
	}

	writeJSON(w, 200, map[string]any{
		"server_now": t,
		"timezone":   s.store.loc.String(),
		"tz_offset":  s.store.tzOffset(),
		"election": PublicElection{
			Title:          election.Title,
			Description:    election.Description,
			Status:         status,
			OpensAt:        election.OpensAt,
			ClosesAt:       election.ClosesAt,
			TestMode:       election.TestMode,
			RandomizeOrder: election.RandomizeOrder,
		},
		"candidates":            candidates,
		"announcements":         announcements,
		"display_announcements": displayAnnouncements,
		"total_votes":           total,
		"expected_voters":       election.ExpectedVoters,
		"allow_revote":          election.AllowRevote,
		"has_voted":             ballot != nil,
		"my_candidate_id":       myCandidateID,
		"results":               results,
	})
	return nil
}

func (s *server) handleMe(w http.ResponseWriter, r *http.Request) error {
	election, err := s.store.getElection()
	if err != nil {
		return err
	}
	ballot, err := s.store.myBallot(r)
	if err != nil {
		return err
	}
	var candidateID any
	canChange := false
	if ballot != nil {
		candidateID = ballot.CandidateID
		canChange = election.AllowRevote && electionStatus(election, nowMS()) == "open"
	}
	writeJSON(w, 200, map[string]any{
		"has_voted":    ballot != nil,
		"candidate_id": candidateID,
		"can_change":   canChange,
	})
	return nil
}

func (s *server) handleVote(w http.ResponseWriter, r *http.Request) error {
	election, err := s.store.getElection()
	if err != nil {
		return err
	}
	if r.Header.Get("X-Vote-Slug") != election.Slug {
		return fail(403, "link_tidak_valid")
	}

	ip := clientIP(r, s.store.cfg.TrustProxy)
	if !rateLimit("vote:"+ip, 20, time.Minute) {
		return fail(429, "terlalu_banyak_percobaan")
	}
	if electionStatus(election, nowMS()) != "open" {
		return fail(403, "voting_ditutup")
	}

	body, err := readJSON(w, r)
	if err != nil {
		return err
	}
	candidateID := int(numberOr(body, "candidate_id", 0))

	tx, err := s.store.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var candidateExists int
	err = tx.QueryRow("SELECT 1 FROM candidates WHERE id = ? AND active = 1", candidateID).Scan(&candidateExists)
	if errors.Is(err, sql.ErrNoRows) {
		return fail(400, "calon_tidak_valid")
	}
	if err != nil {
		return err
	}

	var token string
	if cookie, err := r.Cookie(ballotCookie); err == nil {
		token = cookie.Value
	}
	var existing *Ballot
	if token != "" {
		var b Ballot
		err := tx.QueryRow(
			`SELECT id, candidate_id, cookie_token_hash, ip_hash, created_at, updated_at
			 FROM ballots WHERE cookie_token_hash = ?`, sha256Hex(token),
		).Scan(&b.ID, &b.CandidateID, &b.TokenHash, &b.IPHash, &b.CreatedAt, &b.UpdatedAt)
		if err == nil {
			existing = &b
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}

	t := nowMS()
	changed := false
	issuedToken := ""
	if existing != nil {
		if !election.AllowRevote {
			return fail(409, "sudah_memilih")
		}
		if existing.CandidateID != candidateID {
			if _, err := tx.Exec(
				"UPDATE ballots SET candidate_id = ?, ip_hash = ?, updated_at = ? WHERE id = ?",
				candidateID, hmacIP(s.store.secret, ip), t, existing.ID,
			); err != nil {
				return err
			}
			changed = true
		}
	} else {
		issuedToken = randomHex(32)
		if _, err := tx.Exec(
			`INSERT INTO ballots (candidate_id, cookie_token_hash, ip_hash, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)`,
			candidateID, sha256Hex(issuedToken), hmacIP(s.store.secret, ip), t, t,
		); err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	if issuedToken != "" {
		maxAge := 3600
		remaining := (election.ClosesAt - nowMS()) / 1000
		if remaining > 0 {
			maxAge = int(remaining) + 86_400
		}
		if maxAge < 3600 {
			maxAge = 3600
		}
		setCookie(w, r, ballotCookie, issuedToken, maxAge, s.store.cfg.CookieSecure)
	}

	total, err := s.store.totalVotes()
	if err != nil {
		return err
	}
	s.store.auditJSON("vote", map[string]any{"candidate_id": candidateID, "changed": changed})
	writeJSON(w, 200, map[string]any{
		"ok": true, "candidate_id": candidateID, "total_votes": total, "changed": changed,
	})
	return nil
}

// ---------------------------------------------------------------- auth api

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) error {
	ip := clientIP(r, s.store.cfg.TrustProxy)
	if !rateLimit("login:"+ip, 5, time.Minute) {
		return fail(429, "terlalu_banyak_percobaan")
	}
	body, err := readJSON(w, r)
	if err != nil {
		return err
	}
	username := strings.TrimSpace(text(body["username"], 120))
	password := text(body["password"], 1024)

	var admin Admin
	var storedHash string
	err = s.store.db.QueryRow("SELECT id, username, password_hash FROM admins WHERE username = ?", username).
		Scan(&admin.ID, &admin.Username, &storedHash)
	ok := false
	if errors.Is(err, sql.ErrNoRows) {
		verifyPassword(password, s.store.dummyHash)
	} else if err != nil {
		return err
	} else {
		ok = verifyPassword(password, storedHash)
	}
	if !ok {
		s.store.auditJSON("login_gagal", map[string]any{"username": username})
		return fail(401, "username_atau_password_salah")
	}
	if err := s.store.startSession(w, r, admin.ID); err != nil {
		return err
	}
	s.store.auditJSON("login", map[string]any{"username": admin.Username})
	writeJSON(w, 200, map[string]any{"ok": true, "username": admin.Username})
	return nil
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) error {
	s.store.endSession(w, r)
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}

// ---------------------------------------------------------------- admin api

func (s *server) adminState(w http.ResponseWriter, r *http.Request, admin *Admin) error {
	election, err := s.store.getElection()
	if err != nil {
		return err
	}
	election.Status = electionStatus(election, nowMS())
	candidates, err := s.store.allCandidates()
	if err != nil {
		return err
	}
	announcements, err := s.store.allAnnouncements()
	if err != nil {
		return err
	}
	tally, err := s.store.adminTally()
	if err != nil {
		return err
	}
	total, err := s.store.totalVotes()
	if err != nil {
		return err
	}
	audit, err := s.store.auditRows()
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{
		"server_now":    nowMS(),
		"timezone":      s.store.loc.String(),
		"tz_offset":     s.store.tzOffset(),
		"username":      admin.Username,
		"election":      election,
		"candidates":    candidates,
		"announcements": announcements,
		"tally":         tally,
		"total_votes":   total,
		"audit":         audit,
	})
	return nil
}

func (s *server) handleUpdateElection(w http.ResponseWriter, r *http.Request) error {
	current, err := s.store.getElection()
	if err != nil {
		return err
	}
	body, err := readJSON(w, r)
	if err != nil {
		return err
	}

	title := current.Title
	if _, exists := body["title"]; exists {
		title = strings.TrimSpace(text(body["title"], 120))
	}
	if title == "" {
		return fail(400, "judul_wajib")
	}
	description := current.Description
	if _, exists := body["description"]; exists {
		description = text(body["description"], 600)
	}
	opensAt := numberOr(body, "opens_at", current.OpensAt)
	closesAt := numberOr(body, "closes_at", current.ClosesAt)
	if closesAt <= opensAt {
		return fail(400, "jadwal_tidak_valid")
	}

	expected := current.ExpectedVoters
	if value, exists := body["expected_voters"]; exists {
		if value == nil || value == "" {
			expected = nullableInt{}
		} else {
			n := numberOr(body, "expected_voters", 0)
			if n < 1 || n > 1_000_000 {
				return fail(400, "perkiraan_tidak_valid")
			}
			expected = nullableInt{sql.NullInt64{Int64: n, Valid: true}}
		}
	}

	allowRevote := boolOr(body, "allow_revote", current.AllowRevote)
	randomize := boolOr(body, "randomize_order", current.RandomizeOrder)
	showResults := boolOr(body, "show_results", current.ShowResults)
	testMode := boolOr(body, "test_mode", current.TestMode)

	_, err = s.store.db.Exec(
		`UPDATE election SET title = ?, description = ?, opens_at = ?, closes_at = ?,
		        allow_revote = ?, randomize_order = ?, show_results = ?, expected_voters = ?,
		        test_mode = ?, updated_at = ?
		 WHERE id = 1`,
		title, description, opensAt, closesAt,
		boolInt(allowRevote), boolInt(randomize), boolInt(showResults), expected.NullInt64,
		boolInt(testMode), nowMS(),
	)
	if err != nil {
		return err
	}
	s.store.auditJSON("pengaturan_diubah", map[string]any{"title": title, "opensAt": opensAt, "closesAt": closesAt})
	updated, err := s.store.getElection()
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"ok": true, "election": updated})
	return nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func (s *server) handleCreateCandidate(w http.ResponseWriter, r *http.Request) error {
	body, err := readJSON(w, r)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(text(body["name"], 80))
	if name == "" {
		return fail(400, "nama_wajib")
	}
	photoPath := ""
	if value, exists := body["photo_data_url"]; exists && value != nil && value != "" {
		photoPath, err = s.store.savePhoto(text(value, 8_000_000))
		if err != nil {
			return err
		}
	}
	var maxOrder int
	if err := s.store.db.QueryRow("SELECT COALESCE(MAX(sort_order), -1) FROM candidates").Scan(&maxOrder); err != nil {
		return err
	}
	sortOrder := int(numberOr(body, "sort_order", int64(maxOrder+1)))
	active := boolOr(body, "active", true)

	info, err := s.store.db.Exec(
		`INSERT INTO candidates (name, tagline, photo_path, visi, misi, sort_order, active, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		name, text(body["tagline"], 160), photoPath, text(body["visi"], 2000), text(body["misi"], 2000),
		sortOrder, boolInt(active), nowMS(),
	)
	if err != nil {
		return err
	}
	id, _ := info.LastInsertId()
	s.store.auditJSON("calon_ditambah", map[string]any{"id": id, "name": name})
	writeJSON(w, 201, map[string]any{"ok": true, "id": id})
	return nil
}

func (s *server) handleUpdateCandidate(w http.ResponseWriter, r *http.Request, id int) error {
	var current Candidate
	var active int
	err := s.store.db.QueryRow(
		`SELECT id, name, tagline, photo_path, visi, misi, sort_order, active, created_at
		 FROM candidates WHERE id = ?`, id,
	).Scan(&current.ID, &current.Name, &current.Tagline, &current.PhotoPath, &current.Visi, &current.Misi,
		&current.SortOrder, &active, &current.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return fail(404, "calon_tidak_ditemukan")
	}
	if err != nil {
		return err
	}
	current.Active = active != 0

	body, err := readJSON(w, r)
	if err != nil {
		return err
	}
	name := current.Name
	if _, exists := body["name"]; exists {
		name = strings.TrimSpace(text(body["name"], 80))
	}
	if name == "" {
		return fail(400, "nama_wajib")
	}

	photoPath := current.PhotoPath
	if value, exists := body["photo_data_url"]; exists {
		if value == nil || value == "" {
			s.store.removeUpload(photoPath)
			photoPath = ""
		} else {
			newPath, err := s.store.savePhoto(text(value, 8_000_000))
			if err != nil {
				return err
			}
			s.store.removeUpload(photoPath)
			photoPath = newPath
		}
	}

	tagline := current.Tagline
	if _, exists := body["tagline"]; exists {
		tagline = text(body["tagline"], 160)
	}
	visi := current.Visi
	if _, exists := body["visi"]; exists {
		visi = text(body["visi"], 2000)
	}
	misi := current.Misi
	if _, exists := body["misi"]; exists {
		misi = text(body["misi"], 2000)
	}
	activeValue := boolOr(body, "active", current.Active)

	if _, err := s.store.db.Exec(
		"UPDATE candidates SET name = ?, tagline = ?, photo_path = ?, visi = ?, misi = ?, active = ? WHERE id = ?",
		name, tagline, photoPath, visi, misi, boolInt(activeValue), id,
	); err != nil {
		return err
	}
	s.store.auditJSON("calon_diubah", map[string]any{"id": id, "name": name})
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}

func (s *server) handleDeleteCandidate(w http.ResponseWriter, r *http.Request, id int) error {
	var name, photoPath string
	err := s.store.db.QueryRow("SELECT name, photo_path FROM candidates WHERE id = ?", id).Scan(&name, &photoPath)
	if errors.Is(err, sql.ErrNoRows) {
		return fail(404, "calon_tidak_ditemukan")
	}
	if err != nil {
		return err
	}
	var votes int
	if err := s.store.db.QueryRow("SELECT COUNT(*) FROM ballots WHERE candidate_id = ?", id).Scan(&votes); err != nil {
		return err
	}
	if votes > 0 {
		return fail(409, "calon_sudah_punya_suara")
	}
	if _, err := s.store.db.Exec("DELETE FROM candidates WHERE id = ?", id); err != nil {
		return err
	}
	s.store.removeUpload(photoPath)
	s.store.auditJSON("calon_dihapus", map[string]any{"id": id, "name": name})
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}

func (s *server) handleReorderCandidates(w http.ResponseWriter, r *http.Request) error {
	body, err := readJSON(w, r)
	if err != nil {
		return err
	}
	raw, ok := body["ids"].([]any)
	if !ok {
		return fail(400, "urutan_tidak_valid")
	}
	ids := make([]int, 0, len(raw))
	for _, item := range raw {
		ids = append(ids, int(numberOr(map[string]any{"id": item}, "id", 0)))
	}

	tx, err := s.store.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for index, id := range ids {
		if _, err := tx.Exec("UPDATE candidates SET sort_order = ? WHERE id = ?", index, id); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.store.auditJSON("urutan_calon_diubah", map[string]any{"count": len(ids)})
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}

type announcementInput struct {
	title       string
	body        string
	publishAt   int64
	unpublishAt sql.NullInt64
	showVoter   bool
	showDisplay bool
}

func parseAnnouncement(body map[string]any, current *Announcement) (announcementInput, error) {
	var input announcementInput
	input.title = current.Title
	if value, exists := body["title"]; exists {
		input.title = strings.TrimSpace(text(value, 120))
	}
	if input.title == "" {
		return input, fail(400, "judul_wajib")
	}
	input.body = current.Body
	if value, exists := body["body"]; exists {
		input.body = text(value, 4000)
	}
	fallbackPublish := current.PublishAt
	if fallbackPublish == 0 {
		fallbackPublish = nowMS()
	}
	input.publishAt = numberOr(body, "publish_at", fallbackPublish)

	input.unpublishAt = current.UnpublishAt.NullInt64
	if value, exists := body["unpublish_at"]; exists {
		if value == nil || value == "" {
			input.unpublishAt = sql.NullInt64{}
		} else {
			n := numberOr(body, "unpublish_at", 0)
			input.unpublishAt = sql.NullInt64{Int64: n, Valid: true}
		}
	}
	if input.unpublishAt.Valid && input.unpublishAt.Int64 <= input.publishAt {
		return input, fail(400, "jadwal_tidak_valid")
	}

	input.showVoter = current.ShowVoter
	if value, exists := body["show_voter"]; exists {
		input.showVoter = boolOr(map[string]any{"v": value}, "v", current.ShowVoter)
	}
	input.showDisplay = current.ShowDisplay
	if value, exists := body["show_display"]; exists {
		input.showDisplay = boolOr(map[string]any{"v": value}, "v", current.ShowDisplay)
	}
	return input, nil
}

func (s *server) handleCreateAnnouncement(w http.ResponseWriter, r *http.Request) error {
	body, err := readJSON(w, r)
	if err != nil {
		return err
	}
	current := &Announcement{ShowVoter: true, ShowDisplay: true}
	input, err := parseAnnouncement(body, current)
	if err != nil {
		return err
	}
	info, err := s.store.db.Exec(
		`INSERT INTO announcements (title, body, publish_at, unpublish_at, show_voter, show_display, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		input.title, input.body, input.publishAt, input.unpublishAt,
		boolInt(input.showVoter), boolInt(input.showDisplay), nowMS(),
	)
	if err != nil {
		return err
	}
	id, _ := info.LastInsertId()
	s.store.auditJSON("pengumuman_ditambah", map[string]any{"id": id})
	writeJSON(w, 201, map[string]any{"ok": true, "id": id})
	return nil
}

func (s *server) handleUpdateAnnouncement(w http.ResponseWriter, r *http.Request, id int) error {
	current, err := s.store.announcementByID(id)
	if err != nil {
		return err
	}
	body, err := readJSON(w, r)
	if err != nil {
		return err
	}
	input, err := parseAnnouncement(body, current)
	if err != nil {
		return err
	}
	_, err = s.store.db.Exec(
		`UPDATE announcements SET title = ?, body = ?, publish_at = ?, unpublish_at = ?,
		        show_voter = ?, show_display = ? WHERE id = ?`,
		input.title, input.body, input.publishAt, input.unpublishAt,
		boolInt(input.showVoter), boolInt(input.showDisplay), id,
	)
	if err != nil {
		return err
	}
	s.store.auditJSON("pengumuman_diubah", map[string]any{"id": id})
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}

func (s *server) handleDeleteAnnouncement(w http.ResponseWriter, r *http.Request, id int) error {
	if _, err := s.store.announcementByID(id); err != nil {
		return err
	}
	if _, err := s.store.db.Exec("DELETE FROM announcements WHERE id = ?", id); err != nil {
		return err
	}
	s.store.auditJSON("pengumuman_dihapus", map[string]any{"id": id})
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}

func (s *store) announcementByID(id int) (*Announcement, error) {
	var a Announcement
	var unpublish sql.NullInt64
	var showVoter, showDisplay int
	err := s.db.QueryRow(
		`SELECT id, title, body, publish_at, unpublish_at, show_voter, show_display, created_at
		 FROM announcements WHERE id = ?`, id,
	).Scan(&a.ID, &a.Title, &a.Body, &a.PublishAt, &unpublish, &showVoter, &showDisplay, &a.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fail(404, "pengumuman_tidak_ditemukan")
	}
	if err != nil {
		return nil, err
	}
	a.UnpublishAt = nullableInt{unpublish}
	a.ShowVoter = showVoter != 0
	a.ShowDisplay = showDisplay != 0
	return &a, nil
}

func (s *server) handleRotateLink(w http.ResponseWriter, r *http.Request) error {
	var slug string
	for i := 0; i < 10; i++ {
		candidate := randomSlug(10)
		var exists int
		err := s.store.db.QueryRow("SELECT 1 FROM election WHERE slug = ?", candidate).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			slug = candidate
			break
		}
		if err != nil {
			return err
		}
	}
	if slug == "" {
		return fail(500, "server_error")
	}
	if _, err := s.store.db.Exec("UPDATE election SET slug = ?, updated_at = ? WHERE id = 1", slug, nowMS()); err != nil {
		return err
	}
	s.store.audit("link_diganti", "")
	writeJSON(w, 200, map[string]any{"ok": true, "slug": slug})
	return nil
}

func (s *server) handleReset(w http.ResponseWriter, r *http.Request) error {
	body, err := readJSON(w, r)
	if err != nil {
		return err
	}
	if text(body["confirm"], 20) != "RESET" {
		return fail(400, "konfirmasi_salah")
	}
	if _, err := s.store.db.Exec("DELETE FROM ballots"); err != nil {
		return err
	}
	s.store.audit("data_direset", "")
	writeJSON(w, 200, map[string]any{"ok": true, "total_votes": 0})
	return nil
}

func (s *server) handlePassword(w http.ResponseWriter, r *http.Request, admin *Admin) error {
	body, err := readJSON(w, r)
	if err != nil {
		return err
	}
	current := text(body["current"], 1024)
	next := text(body["next"], 1024)
	if utf8.RuneCountInString(next) < 8 {
		return fail(400, "password_terlalu_pendek")
	}
	var stored string
	if err := s.store.db.QueryRow("SELECT password_hash FROM admins WHERE id = ?", admin.ID).Scan(&stored); err != nil {
		return err
	}
	if !verifyPassword(current, stored) {
		return fail(401, "password_salah")
	}
	if _, err := s.store.db.Exec("UPDATE admins SET password_hash = ? WHERE id = ?", hashPassword(next), admin.ID); err != nil {
		return err
	}
	s.store.audit("password_diubah", "")
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}
