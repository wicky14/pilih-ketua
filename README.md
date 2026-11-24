# Pilih Ketua

Polling online ketua paguyuban dengan nuansa arcade pixel 16-bit lean. Satu link bersama, satu browser satu suara, perolehan suara per calon hanya terlihat oleh admin.

**Server berupa satu binary Go statis.** Tidak perlu Node, npm, atau build step di server. Frontend sudah di-embed ke dalam binary.

## Ringkas

- **Pemilih:** buka link rahasia, lihat calon + visi/misi, pilih, lalu boleh ubah pilihan sampai voting ditutup.
- **Admin:** kelola calon, jadwal, pengumuman, link, dan kapan hasil ditampilkan; lihat tally live.
- **Layar publik:** turnout, hitung mundur, dan pengumuman. Tidak menampilkan perolehan per calon selama voting.
- **Backend:** Go + `net/http` + SQLite murni Go (`modernc.org/sqlite`), tanpa CGO.

## Build & jalankan

Butuh Go 1.24+ hanya di mesin yang **build**. Binary dihasilkan dengan `CGO_ENABLED=0`, jadi bisa langsung jalan di Debian 13 tanpa install apa-apa.

```bash
make build
./bin/pilih-ketua
```

Atau sekali jalan:

```bash
make run
```

Kalau ingin build langsung di server Debian 13:

```bash
sudo apt-get update
sudo apt-get install -y golang-go make
make build
./bin/pilih-ketua
```

Buka:

- Voting: `http://localhost:3000/vote/<slug>` — slug ada di log server dan dashboard admin
- Admin: `http://localhost:3000/admin`
- Layar publik: `http://localhost:3000/display`
- Health check: `http://localhost:3000/healthz`

Login awal: `admin` / `admin123`. **Ganti password lewat menu Pengaturan sebelum dipakai.** `ADMIN_USER` / `ADMIN_PASSWORD` hanya dipakai saat database pertama kali dibuat.

## Variabel lingkungan

| Variabel | Default | Catatan |
|---|---|---|
| `PORT` | `3000` | Port HTTP. |
| `HOST` | `0.0.0.0` | Pakai `127.0.0.1` jika di belakang reverse proxy. |
| `TZ` | `Asia/Jakarta` | Nama zona IANA untuk tampilan waktu & input jadwal. Contoh: `Asia/Makassar`, `UTC`. Database tz ikut embed di binary. |
| `DATA_DIR` | `./data` | Berisi DB, upload, dan `secret`. |
| `DB_PATH` | `$DATA_DIR/app.db` | Bisa diubah jika perlu. |
| `UPLOAD_DIR` | `$DATA_DIR/uploads` | Foto calon. |
| `APP_SECRET` | auto di `$DATA_DIR/secret` | Jangan berubah-ubah; dipakai untuk HMAC IP. |
| `ADMIN_USER` | `admin` | Hanya untuk bootstrap. |
| `ADMIN_PASSWORD` | `admin123` | Hanya untuk bootstrap. |
| `COOKIE_SECURE` | `0` | Set `1` jika HTTPS termination ada di proxy. |
| `TRUST_PROXY` | `0` | Set `1` jika di belakang Caddy/nginx agar IP pembatas berasal dari `X-Forwarded-For`. |

Contoh:

```bash
PORT=8080 TZ=Asia/Makassar ADMIN_PASSWORD='rahasia-kuat' COOKIE_SECURE=1 TRUST_PROXY=1 ./bin/pilih-ketua
```

Semua tampilan waktu dan input jadwal di admin memakai `TZ` dari server, bukan zona browser. Jadwal tetap disimpan sebagai epoch UTC sehingga aman lintas perangkat.

## Alur pakai

1. Login admin, buka **Pengaturan**: isi judul, deskripsi, jadwal buka/tutup, perkiraan jumlah pemilih, dan atur **Tampilkan hasil setelah ditutup**.
2. Buka **Calon**: tambah nama, tagline, visi, misi, dan foto opsional. Foto otomatis diperkecil di browser ke 640px WebP.
3. Buka **Pengumuman**: tambah pengumuman; atur waktu mulai/berhenti dan apakah tampil di pemilih/layar publik.
4. Salin link voting di **Dashboard**, bagikan ke grup pemilih.
5. Buka `/display` di proyektor saat acara.
6. Setelah voting ditutup, aktifkan hasil (jika belum) agar perolehan muncul di halaman pemilih dan layar publik.

Status voting dihitung otomatis dari waktu server: `upcoming` → `open` → `closed`.

## Privasi dan batasan

- Data pemilih tidak disimpan: tidak ada nama, PIN, token unik, atau daftar pemilih.
- Cookie `pk_ballot` hanya menandai ballot agar revote mengubah suara yang sama, bukan menambah suara.
- Alamat IP hanya dipakai untuk rate limit dan disimpan sebagai HMAC, bukan sebagai identitas pemilih.
- Incognito/perangkat lain bisa menambah suara. Ini **polling internal**, bukan pemilihan formal yang terverifikasi.
- Selama voting berlangsung, API publik tidak pernah mengirim jumlah suara per calon. `results` hanya dikirim jika status `closed` dan `show_results` aktif.
- Mutasi API wajib membawa header `X-PK: 1` dan Origin yang sama; cookie admin/voter bersifat HttpOnly + SameSite=Lax.
- Jika link bocor, klik **Ganti link voting**: link lama langsung mati.

## Deploy di Debian 13

Build di komputer Anda, lalu copy binary ke server. Server tidak perlu Go terpasang.

```bash
make build
scp bin/pilih-ketua user@server:/tmp/pilih-ketua
```

Di server (domain contoh: `pilih.contoh.id`):

```bash
sudo useradd --system --home /var/lib/pilih-ketua --shell /usr/sbin/nologin pilihketua
sudo mkdir -p /opt/pilih-ketua /var/lib/pilih-ketua /etc/pilih-ketua
sudo install -m 0755 /tmp/pilih-ketua /opt/pilih-ketua/pilih-ketua
sudo chown -R pilihketua:pilihketua /var/lib/pilih-ketua
sudo chmod 700 /etc/pilih-ketua

openssl rand -hex 32
sudo tee /etc/pilih-ketua/env >/dev/null <<'EOF'
PORT=3000
HOST=127.0.0.1
TZ=Asia/Jakarta
DATA_DIR=/var/lib/pilih-ketua
TRUST_PROXY=1
COOKIE_SECURE=1
ADMIN_USER=admin
ADMIN_PASSWORD=ganti-dengan-password-kuat
APP_SECRET=tempel-hasil-openssl-rand-di-sini
EOF
sudo chmod 600 /etc/pilih-ketua/env

sudo cp deploy/pilih-ketua.service /etc/systemd/system/
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now pilih-ketua caddy
```

Caddy contoh:

```caddyfile
pilih.contoh.id {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
```

Session admin berlaku 7 hari. HTTPS disarankan karena cookie voting memakai `Secure` saat `COOKIE_SECURE=1`.

## Backup dan reset

Data ada di `DATA_DIR` (`app.db`, `app.db-wal`, `app.db-shm`, `uploads/`, `secret`). Cara aman:

```bash
sudo systemctl stop pilih-ketua
sudo tar czf backup-pilih-ketua-$(date +%F).tar.gz -C /var/lib/pilih-ketua .
sudo systemctl start pilih-ketua
```

Reset suara bisa lewat menu **Pengaturan → Zona berbahaya** (konfirmasi `RESET`). Calon dan pengumuman tetap ada. Untuk mengulang dari nol, stop service lalu hapus isi `DATA_DIR`; database beserta admin dan slug baru akan dibuat ulang saat start.

## Troubleshooting

- **Binary tidak bisa dieksekusi:** pastikan `chmod +x /opt/pilih-ketua/pilih-ketua`.
- **Port sudah dipakai:** cek `ss -ltnp | grep 3000` atau ganti `PORT` di env.
- **Link voting 404:** slug diganti atau salah. Ambil link terbaru di dashboard admin.
- **Tidak bisa login:** cek env `ADMIN_USER`/`ADMIN_PASSWORD` hanya saat bootstrap; setelah itu pakai password yang sudah diganti di Pengaturan.
- **Vote ditolak "terlalu banyak percobaan":** rate limit IP 20 vote/menit; tunggu sebentar.
- **Pengumuman tidak muncul:** cek waktu mulai/berhenti dan pilihan audience (pemilih / layar publik). Waktu ditampilkan dalam zona WIB di UI.
- **Foto tidak tersimpan:** maksimal 8 MB dan harus PNG/JPEG/WebP; akan ditolak jika bukan gambar yang dikenali.
