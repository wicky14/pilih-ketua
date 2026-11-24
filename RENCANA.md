# Rencana Aplikasi Pemilihan Ketua Paguyuban

> Dokumen kerja final versi 1. Model: **polling online** dengan link bersama, bukan pemilihan formal dengan verifikasi identitas.
>
> Stack final: **Go + `net/http` + SQLite murni Go (`modernc.org/sqlite`)**. Frontend vanilla ES modules/CSS/WebAudio di-`go:embed` ke dalam satu binary. Tidak ada Node, npm, atau build step frontend. Panduan pakai ada di [README.md](README.md).

---

## 1. Ringkasan

- Admin mengatur calon, jadwal, pengumuman, dan visibilitas hasil.
- Pemilih membuka satu link rahasia `/vote/<slug>`, melihat profil calon, lalu memilih.
- Satu browser = satu suara lewat cookie; pemilih boleh mengubah pilihan sampai voting ditutup.
- Perolehan suara per calon **tidak pernah** dikirim ke halaman pemilih atau layar publik selama voting.
- Layar publik menampilkan turnout, hitung mundur, dan pengumuman.
- Nuansa arcade pixel 16-bit lean dengan chiptune WebAudio yang bisa dimatikan.

---

## 2. Keputusan yang dikunci

| Topik | Keputusan |
|---|---|
| Jangkauan | Online penuh, 50–300 pemilih |
| Mode akses | **Satu link rahasia bersama** (`/vote/<slug>`) |
| Identitas pemilih | Tidak ada nama, PIN, token unik, QR, atau daftar pemilih |
| Batas suara | Satu browser satu suara lewat cookie `pk_ballot`; duplikat dari incognito/perangkat lain diterima |
| Ubah pilihan | Boleh sampai voting ditutup; revote mengubah baris ballot yang sama |
| Data ke pemilih | Hanya total suara masuk, bukan per calon |
| Data ke admin | Tally live per calon + total suara + audit ringan |
| Layar publik | Turnout + pengumuman + hitung mundur, tanpa tally per calon |
| Pengumuman | Bisa dijadwalkan (`publish_at` / `unpublish_at`) dan dipilih audience-nya |
| Hasil | Muncul setelah ditutup hanya jika `show_results = 1` |
| Backend | Go 1.24+, `net/http`, `modernc.org/sqlite`, `CGO_ENABLED=0` |
| Frontend | Vanilla ES modules + CSS + WebAudio, di-embed via `go:embed` |
| Deploy | Satu binary statis + systemd + Caddy di Debian 13 |
| Dihapus dari scope | QR, export CSV, daftar nama, PIN, token unik, OTP, multi-admin, berita acara |

### Konsekuensi yang diterima

- Ini **polling internal**, bukan pemilihan yang bisa diverifikasi per orang.
- IP tidak dipakai sebagai pembatas suara (NAT/CGNAT/dinamis); hanya untuk rate limit dan disimpan sebagai HMAC.
- Cookie bisa dihapus; incognito atau perangkat lain bisa menambah suara.
- Persentase partisipasi hanya akurat jika admin mengisi perkiraan jumlah pemilih.

---

## 3. Teknologi & arsitektur

| Bagian | Pilihan |
|---|---|
| Bahasa | Go 1.24+ |
| HTTP | `net/http` (tanpa framework) |
| Database | SQLite via `modernc.org/sqlite` (pure Go, tanpa CGO) |
| Frontend | HTML/CSS/JS statis dari `public/`, di-embed ke binary |
| Animasi | CSS + canvas confetti |
| Musik & SFX | WebAudio synth, tanpa file audio |
| Auth admin | scrypt + session cookie HttpOnly 7 hari |
| Reverse proxy | Caddy (TLS otomatis) |
| Proses | systemd |
| Realtime | Polling 3–5 detik |

```
Browser pemilih ──┐
Browser admin  ───┼── HTTPS ── Caddy ── binary Go ── SQLite
Layar publik   ──┘                        │
                                          └── /uploads (foto calon)
```

Satu proses melayani API JSON, halaman, aset statis, dan upload. Frontend tidak dilayani dari disk saat runtime; semua ada di dalam binary. Hanya `DATA_DIR` yang ditulis ke disk.

### Struktur proyek

```
pilih-ketua/
├── main.go                # entrypoint, embed, graceful shutdown
├── api.go                 # routing + semua handler HTTP
├── store.go               # schema, query, session, upload foto
├── helpers.go             # config, crypto, cookie, rate limit, JSON helper
├── public/                # frontend vanilla (embedded)
│   ├── index.html
│   ├── admin.html
│   ├── display.html
│   ├── assets/
│   └── fonts/
├── data/                  # DB, upload, secret (di-gitignore)
├── deploy/
│   ├── Caddyfile
│   ├── env.example
│   └── pilih-ketua.service
├── Makefile
├── go.mod / go.sum
├── README.md
└── RENCANA.md
```

---

## 4. Fitur

### 4.1 Pemilih

- Landing: judul, status voting, hitung mundur, pengumuman aktif.
- Kartu calon: nomor, foto, nama, tagline; tampil tumpuk ke bawah (bukan slide) dan urutannya diacak supaya tidak seolah menyarankan pilihan pertama.
- Profil calon: foto besar, visi, misi.
- Pilih → konfirmasi → layar sukses + confetti + SFX.
- Boleh mengubah pilihan sampai voting ditutup.
- Melihat total suara masuk; tidak pernah melihat tally per calon.
- Melihat status "sudah memilih" saat kembali.

### 4.2 Admin

- Login username + password.
- Dashboard: total suara, status, sisa waktu, link voting + tombol salin.
- Pengaturan: judul, deskripsi, jadwal buka/tutup, izin ubah suara, acak urutan, tampilkan hasil setelah tutup, perkiraan jumlah pemilih, mode latihan.
- CRUD calon: nama, tagline, foto WebP 640px, visi, misi, urutan, aktif/nonaktif.
- CRUD pengumuman + jadwal tayang + audience (pemilih / layar publik).
- Tally live per calon + tombol sembunyikan angka.
- Ganti link voting (slug baru, link lama langsung mati).
- Reset suara dengan konfirmasi `RESET`.
- Ubah password.

### 4.3 Layar publik

- Halaman `/display`, fullscreen 16:9.
- Counter total suara beranimasi + progress bar opsional.
- Carousel pengumuman aktif.
- Hitung mundur.
- Tanpa tally per calon selama voting.
- Watermark `MODE LATIHAN` jika aktif.

---

## 5. Privasi & keamanan

- Tidak ada data pribadi pemilih: tanpa nama, PIN, token unik, atau daftar.
- Cookie `pk_ballot` (HttpOnly) hanya menandai ballot agar revote mengubah suara yang sama.
- Cookie `pk_sid` (HttpOnly, 7 hari) untuk sesi admin.
- IP disimpan sebagai HMAC dengan `APP_SECRET`, bukan identitas voter.
- Rate limit: login 5/60 menit per IP; vote 20/60 menit per IP.
- Mutasi API wajib `X-PK: 1` + `Origin` sama dengan host; vote wajib `X-Vote-Slug: <slug>`.
- Header keamanan: CSP `default-src 'self'`, `nosniff`, `same-origin`, `X-Frame-Options: DENY`.
- `results` hanya dikirim jika status `closed` dan `show_results = 1`; `tally` tidak pernah masuk public state.
- Default admin `admin` / `admin123` hanya saat bootstrap; `ADMIN_USER` / `ADMIN_PASSWORD` dipakai kalau diset.

---

## 6. Kontrak API ringkas

### Publik

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/public/state` | `server_now`, `election`, `candidates`, `announcements`, `display_announcements`, `total_votes`, `expected_voters`, `allow_revote`, `has_voted`, `my_candidate_id`, `results` |
| GET | `/api/public/me` | `has_voted`, `candidate_id`, `can_change` |
| POST | `/api/public/vote` | Body `{candidate_id}`; respons `{ok, candidate_id, total_votes, changed}` |

Error vote: `voting_ditutup`, `sudah_memilih`, `link_tidak_valid`, `calon_tidak_valid`, `terlalu_banyak_percobaan`.

### Admin (butuh sesi)

| Method | Path |
|---|---|
| POST | `/api/admin/login`, `/api/admin/logout` |
| GET | `/api/admin/state` |
| PUT | `/api/admin/election` |
| POST/PUT/DELETE | `/api/admin/candidates`, `/api/admin/candidates/{id}` |
| POST | `/api/admin/candidates/reorder` |
| POST/PUT/DELETE | `/api/admin/announcements`, `/api/admin/announcements/{id}` |
| POST | `/api/admin/rotate-link` |
| POST | `/api/admin/reset` `{confirm:"RESET"}` |
| POST | `/api/admin/password` `{current, next}` |

Status dihitung server dari waktu: `upcoming` → `open` → `closed`. UI memakai zona dari env `TZ` (default `Asia/Jakarta`), termasuk input jadwal di admin.

---

## 7. Data

Tabel SQLite: `meta`, `admins`, `sessions`, `election`, `candidates`, `announcements`, `ballots`, `audit_log`.

- `ballots.cookie_token_hash` unik; hash SHA-256 dari token cookie.
- `ballots.ip_hash` = HMAC-SHA256(ip) 12 hex.
- `election.slug` unik; bisa dirotasi.
- Foto disimpan sebagai file di `UPLOAD_DIR` dan dirujuk lewat `/uploads/<nama>.webp|png|jpg`.

Bootstrap otomatis saat DB kosong: admin default, 1 election aktif, 2 calon contoh, 1 pengumuman selamat datang.

---

## 8. Deploy Debian 13

Build di lokal (atau di server), copy binary, isi env, jalankan systemd + Caddy. Server tidak perlu Go/NPM saat menjalankan binary sudah jadi. Detail lengkap ada di [README.md](README.md).

```bash
make build
scp bin/pilih-ketua user@server:/tmp/pilih-ketua
# di server: install /opt/pilih-ketua/pilih-ketua, env, service, Caddy
systemctl enable --now pilih-ketua caddy
```

---

## 9. Status pengerjaan

- [x] Frontend voting, admin, display, audio, styling
- [x] Port backend ke Go (`net/http` + SQLite pure Go)
- [x] Embed frontend ke binary
- [x] Auth/session/CSRF/rate limit kompatibel dengan perilaku lama
- [x] Privacy tally & scheduled announcements
- [x] Upload foto WebP/PNG/JPEG
- [x] Makefile, README, deploy systemd/Caddy/env
- [x] Uji HTTP end-to-end 42 skenario
- [x] Reset data uji ke kondisi bersih

---

## 10. Di luar scope v1

QR code, export CSV/PDF, daftar nama pemilih, token unik, PIN, OTP, multi-admin, email/WhatsApp otomatis, PWA offline, berita acara.
