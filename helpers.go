package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/scrypt"
)

// ---------------------------------------------------------------- config

type config struct {
	Port         int
	Host         string
	Timezone     string
	DataDir      string
	DBPath       string
	UploadDir    string
	AdminUser    string
	AdminPass    string
	CookieSecure bool
	TrustProxy   bool
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envBool(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func loadConfig() config {
	cfg := config{
		Port:         envInt("PORT", 3000),
		Host:         env("HOST", "0.0.0.0"),
		Timezone:     env("TZ", "Asia/Jakarta"),
		DataDir:      env("DATA_DIR", "data"),
		AdminUser:    env("ADMIN_USER", "admin"),
		AdminPass:    env("ADMIN_PASSWORD", "admin123"),
		CookieSecure: envBool("COOKIE_SECURE"),
		TrustProxy:   envBool("TRUST_PROXY"),
	}
	cfg.DBPath = env("DB_PATH", filepath.Join(cfg.DataDir, "app.db"))
	cfg.UploadDir = env("UPLOAD_DIR", filepath.Join(cfg.DataDir, "uploads"))
	return cfg
}

// ---------------------------------------------------------------- errors / json

type apiError struct {
	status int
	code   string
}

func (e *apiError) Error() string { return e.code }

func fail(status int, code string) error {
	return &apiError{status: status, code: code}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func readJSON(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	r.Body = http.MaxBytesReader(w, r.Body, 8_000_000)
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()
	var body map[string]any
	if err := decoder.Decode(&body); err != nil {
		if errors.Is(err, io.EOF) {
			return map[string]any{}, nil
		}
		return nil, fail(400, "invalid_json")
	}
	if body == nil {
		body = map[string]any{}
	}
	return body, nil
}

func nowMS() int64 { return time.Now().UnixMilli() }

func text(value any, max int) string {
	if value == nil {
		return ""
	}
	s := fmt.Sprint(value)
	runes := []rune(s)
	if len(runes) > max {
		s = string(runes[:max])
	}
	return s
}

func numberOr(body map[string]any, key string, fallback int64) int64 {
	value, ok := body[key]
	if !ok || value == nil || value == "" {
		return fallback
	}
	var parsed float64
	switch v := value.(type) {
	case float64:
		parsed = v
	case json.Number:
		n, err := v.Float64()
		if err != nil {
			return fallback
		}
		parsed = n
	default:
		n, err := strconv.ParseFloat(strings.TrimSpace(fmt.Sprint(value)), 64)
		if err != nil {
			return fallback
		}
		parsed = n
	}
	return int64(parsed)
}

func boolOr(body map[string]any, key string, fallback bool) bool {
	value, ok := body[key]
	if !ok || value == nil {
		return fallback
	}
	switch v := value.(type) {
	case bool:
		return v
	case float64:
		return v != 0
	case json.Number:
		n, err := v.Float64()
		return err == nil && n != 0
	case string:
		b, err := strconv.ParseBool(strings.TrimSpace(v))
		return err == nil && b
	default:
		return fallback
	}
}

// ---------------------------------------------------------------- crypto

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func hmacIP(secret, ip string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ip))
	return hex.EncodeToString(mac.Sum(nil))[:12]
}

// Format kompatibel dengan implementasi Node sebelumnya: salt disimpan sebagai
// string hex dan dipakai apa adanya (bukan di-decode ke byte mentah).
func hashPassword(password string) string {
	salt := randomHex(16)
	derived, err := scrypt.Key([]byte(password), []byte(salt), 16384, 8, 1, 64)
	if err != nil {
		panic(err)
	}
	return fmt.Sprintf("scrypt$%s$%x", salt, derived)
}

func verifyPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 3 || parts[0] != "scrypt" {
		return false
	}
	expected, err := hex.DecodeString(parts[2])
	if err != nil {
		return false
	}
	actual, err := scrypt.Key([]byte(password), []byte(parts[1]), 16384, 8, 1, 64)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(expected, actual) == 1
}

func randomHex(bytes int) string {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buf)
}

func randomSlug(length int) string {
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
	buf := make([]byte, length)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	out := make([]byte, length)
	for i, b := range buf {
		out[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(out)
}

func loadSecret(dataDir string) string {
	if secret := os.Getenv("APP_SECRET"); secret != "" {
		return secret
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		panic(err)
	}
	path := filepath.Join(dataDir, "secret")
	if existing, err := os.ReadFile(path); err == nil {
		if secret := strings.TrimSpace(string(existing)); secret != "" {
			return secret
		}
	}
	secret := randomHex(32)
	if err := os.WriteFile(path, []byte(secret), 0o600); err != nil {
		panic(err)
	}
	return secret
}

// ---------------------------------------------------------------- request helpers

func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			return strings.TrimSpace(strings.Split(forwarded, ",")[0])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return parsed.Host == r.Host
}

func isHTTPS(r *http.Request, force bool) bool {
	return force || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func setCookie(w http.ResponseWriter, r *http.Request, name, value string, maxAge int, forceSecure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   isHTTPS(r, forceSecure),
		SameSite: http.SameSiteLaxMode,
	})
}

func clearCookie(w http.ResponseWriter, r *http.Request, name string, forceSecure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   isHTTPS(r, forceSecure),
		SameSite: http.SameSiteLaxMode,
	})
}

// ---------------------------------------------------------------- rate limit

type limitBucket struct {
	count int
	reset time.Time
}

var (
	rateMu     sync.Mutex
	rateBucket = make(map[string]*limitBucket)
)

func rateLimit(key string, max int, window time.Duration) bool {
	rateMu.Lock()
	defer rateMu.Unlock()
	t := time.Now()
	bucket, ok := rateBucket[key]
	if !ok || t.After(bucket.reset) {
		bucket = &limitBucket{reset: t.Add(window)}
		rateBucket[key] = bucket
	}
	bucket.count++
	return bucket.count <= max
}

func startRateCleanup() {
	ticker := time.NewTicker(time.Minute)
	go func() {
		for t := range ticker.C {
			rateMu.Lock()
			for key, bucket := range rateBucket {
				if t.After(bucket.reset) {
					delete(rateBucket, key)
				}
			}
			rateMu.Unlock()
		}
	}()
}
