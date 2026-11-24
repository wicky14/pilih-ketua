import { formatDate, fromLocalInput, setTimezone, toLocalInput } from './time.js';

const app = document.getElementById('app');
const TABS = ['dashboard', 'calon', 'pengumuman', 'pengaturan'];
const initialTab = (location.hash || '#dashboard').slice(1);

const state = {
  data: null,
  tab: TABS.includes(initialTab) ? initialTab : 'dashboard',
  busy: false,
  showNumbers: true,
  candidateForm: null,
  candidatePhoto: undefined,
  announcementForm: null,
  loginError: '',
  offset: 0,
  ticker: null,
  poll: null,
};

const ERROR_LABEL = {
  username_atau_password_salah: 'Username atau password salah.',
  password_salah: 'Password saat ini salah.',
  password_terlalu_pendek: 'Password baru minimal 8 karakter.',
  terlalu_banyak_percobaan: 'Terlalu banyak percobaan. Tunggu sebentar.',
  calon_sudah_punya_suara: 'Calon sudah punya suara. Nonaktifkan saja, jangan dihapus.',
  jadwal_tidak_valid: 'Jadwal tutup harus setelah jadwal buka.',
  unauthorized: 'Sesi berakhir. Silakan login lagi.',
  server_error: 'Terjadi kesalahan di server.',
};

const STATUS_LABEL = {
  open: 'Dibuka',
  upcoming: 'Belum dibuka',
  closed: 'Ditutup',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || '')
    .join('')
    .toUpperCase();
}

function countdownText(closesAt) {
  const remaining = closesAt - (Date.now() + state.offset);
  if (remaining <= 0) return 'Ditutup';
  const total = Math.floor(remaining / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}h ${String(h).padStart(2, '0')}j ${String(m).padStart(2, '0')}m`;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function toast(message, kind = '') {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.borderColor = kind === 'error' ? 'var(--red)' : kind === 'success' ? 'var(--green)' : '';
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toast.hideTimer);
  toast.hideTimer = setTimeout(() => el.classList.remove('show'), 3400);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      Accept: 'application/json',
      'X-PK': '1',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'server_error');
    error.code = data.error || 'server_error';
    error.status = response.status;
    throw error;
  }
  return data;
}

async function fileToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const max = 640;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return canvas.toDataURL('image/webp', 0.82);
}

// ------------------------------------------------------------ data

function applyData(data) {
  setTimezone(data.timezone, data.tz_offset);
  state.data = data;
  state.offset = data.server_now - Date.now();
}

async function load() {
  const data = await api('/api/admin/state');
  applyData(data);
  renderApp();
}

async function refresh() {
  try {
    const data = await api('/api/admin/state');
    applyData(data);
    if (state.tab === 'dashboard') renderPage();
    updateClock();
  } catch (error) {
    if (error.status === 401) {
      state.data = null;
      renderLogin();
    }
  }
}

function startTimers() {
  if (state.ticker) clearInterval(state.ticker);
  if (state.poll) clearInterval(state.poll);
  state.ticker = setInterval(updateClock, 1000);
  state.poll = setInterval(refresh, 5000);
  updateClock();
}

function stopTimers() {
  if (state.ticker) clearInterval(state.ticker);
  if (state.poll) clearInterval(state.poll);
  state.ticker = null;
  state.poll = null;
}

function updateClock() {
  if (!state.data) return;
  document.querySelectorAll('[data-admin-clock]').forEach((el) => {
    el.textContent = countdownText(state.data.election.closes_at);
  });
}

// ------------------------------------------------------------ login

function renderLogin() {
  stopTimers();
  app.innerHTML = `<div class="login-wrap">
    <div class="login-card">
      <div class="login-mark">PK</div>
      <h1 class="login-title">Admin<br>Kotak Suara</h1>
      <p class="login-sub">Masuk untuk mengatur calon, jadwal, dan pengumuman.</p>
      <form data-form="login" autocomplete="on">
        <div class="field">
          <label for="login-user">Username</label>
          <input class="input" id="login-user" name="username" autocomplete="username" required>
        </div>
        <div class="field">
          <label for="login-pass">Password</label>
          <input class="input" id="login-pass" name="password" type="password" autocomplete="current-password" required>
        </div>
        <button class="btn btn-primary btn-block" type="submit">Masuk</button>
        ${state.loginError ? `<p class="error-text">${escapeHtml(state.loginError)}</p>` : ''}
      </form>
    </div>
  </div>`;
  document.getElementById('login-user')?.focus();
}

// ------------------------------------------------------------ shell

function navButton(tab, label) {
  return `<button class="nav-btn ${state.tab === tab ? 'active' : ''}" data-tab="${tab}" type="button">
    <span class="ico" aria-hidden="true"></span>${label}
  </button>`;
}

function renderApp() {
  if (!state.data) {
    renderLogin();
    return;
  }
  const election = state.data.election;
  app.innerHTML = `<div class="admin-shell">
    <aside class="sidebar">
      <div class="side-brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <div><b>Kotak Suara</b><span>Admin panel</span></div>
      </div>
      <nav class="nav" aria-label="Navigasi admin">
        ${navButton('dashboard', 'Dashboard')}
        ${navButton('calon', 'Calon')}
        ${navButton('pengumuman', 'Pengumuman')}
        ${navButton('pengaturan', 'Pengaturan')}
      </nav>
      <div class="side-foot">
        <span class="who">${escapeHtml(state.data.username)}</span>
        <button class="btn btn-small btn-ghost" data-action="logout" type="button">Keluar</button>
      </div>
    </aside>
    <main class="admin-main">
      <header class="admin-top">
        <div>
          <h1 class="admin-title" id="page-title">${titleForTab()}</h1>
          <p class="admin-sub">${escapeHtml(election.title)}</p>
        </div>
        <div class="admin-actions">
          <a class="btn btn-small btn-ghost" href="/vote/${encodeURIComponent(election.slug)}" target="_blank" rel="noopener">Halaman voting</a>
          <a class="btn btn-small btn-ghost" href="/display" target="_blank" rel="noopener">Layar publik</a>
        </div>
      </header>
      <div id="page"></div>
    </main>
  </div>`;
  renderPage();
  startTimers();
}

function titleForTab() {
  return {
    dashboard: 'Dashboard',
    calon: 'Kelola Calon',
    pengumuman: 'Pengumuman',
    pengaturan: 'Pengaturan',
  }[state.tab];
}

function renderPage() {
  const page = document.getElementById('page');
  if (!page) return;
  if (state.tab === 'dashboard') page.innerHTML = pageDashboard();
  else if (state.tab === 'calon') page.innerHTML = pageCandidates();
  else if (state.tab === 'pengumuman') page.innerHTML = pageAnnouncements();
  else page.innerHTML = pageSettings();
  updateClock();
  bindPhotoInput();
}

// ------------------------------------------------------------ dashboard

function pageDashboard() {
  const data = state.data;
  const election = data.election;
  const total = data.total_votes;
  const tally = data.tally || [];
  const max = Math.max(1, ...tally.map((row) => row.votes));
  const status = election.status;
  const voteUrl = `${location.origin}/vote/${election.slug}`;
  const expected = election.expected_voters;
  const progress = expected ? Math.min(100, Math.round((total / expected) * 100)) : null;

  return `<section class="stats">
    <div class="stat">
      <div class="stat-label">Suara masuk</div>
      <div class="stat-value" data-live-total>${total}</div>
      <div class="stat-foot">${expected ? `dari ${expected} perkiraan` : 'tanpa perkiraan'}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Status</div>
      <div class="stat-value small" style="color:${status === 'open' ? 'var(--green)' : status === 'upcoming' ? 'var(--yellow)' : 'var(--red)'}">
        ${STATUS_LABEL[status]}
      </div>
      <div class="stat-foot">${status === 'open' ? 'Menerima suara' : status === 'upcoming' ? formatDate(election.opens_at) : 'Sudah ditutup'}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Sisa waktu</div>
      <div class="stat-value small" data-admin-clock>${countdownText(election.closes_at)}</div>
      <div class="stat-foot">Tutup ${formatDate(election.closes_at)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Calon aktif</div>
      <div class="stat-value cyan">${tally.filter((row) => row.active).length}</div>
      <div class="stat-foot">${tally.length} total calon</div>
    </div>
  </section>

  ${
    progress !== null
      ? `<div class="panel" style="margin-bottom:16px">
          <div class="panel-head"><div class="panel-title">Partisipasi</div><span class="panel-sub">${progress}%</span></div>
          <div class="result-track"><div class="result-fill green" style="width:${progress}%"></div></div>
        </div>`
      : ''
  }

  <div class="admin-grid">
    <div class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">Perolehan suara</div>
          <div class="panel-sub">Hanya terlihat oleh admin</div>
        </div>
        <button class="btn btn-small btn-ghost" data-action="toggle-numbers" type="button">
          ${state.showNumbers ? 'Sembunyikan angka' : 'Tampilkan angka'}
        </button>
      </div>
      ${
        tally.length
          ? `<div class="tally ${state.showNumbers ? '' : 'hide-numbers'}">${tally
              .map(
                (row, index) => `<div class="tally-row">
                  <div class="tally-top">
                    <span class="tally-name">${escapeHtml(row.name)}${row.active ? '' : ' · nonaktif'}</span>
                    <span class="tally-votes" data-vote-count>${row.votes}</span>
                  </div>
                  <div class="tally-track"><div class="tally-fill" style="width:${(row.votes / max) * 100}%"></div></div>
                </div>`
              )
              .join('')}</div>`
          : '<div class="empty">Belum ada calon. Tambahkan di tab Calon.</div>'
      }
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">Link voting</div></div>
      <div class="link-box">
        <input class="input" readonly value="${escapeHtml(voteUrl)}" data-link-input aria-label="Link voting">
        <button class="btn btn-small btn-cyan" data-action="copy-link" type="button">Salin</button>
      </div>
      <p class="form-note" style="margin-top:8px">Bagikan link ini ke pemilih. Siapa pun yang punya link bisa memilih satu kali per browser.</p>
      <div class="panel-head" style="margin-top:18px"><div class="panel-title">Aktivitas terakhir</div></div>
      <div class="list">
        ${
          (data.audit || []).length
            ? data.audit
                .map(
                  (item) => `<div class="list-item">
                    <div class="list-main">
                      <div class="list-title">${escapeHtml(item.action.replaceAll('_', ' '))}</div>
                      <div class="list-sub">${formatDate(item.created_at)}</div>
                    </div>
                  </div>`
                )
                .join('')
            : '<div class="empty">Belum ada aktivitas.</div>'
        }
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------ candidates

function pageCandidates() {
  const candidates = state.data.candidates;
  const form = state.candidateForm;

  return `${form ? candidateFormHtml(form) : ''}
  <div class="panel">
    <div class="panel-head">
      <div>
        <div class="panel-title">Daftar calon</div>
        <div class="panel-sub">${candidates.length} calon</div>
      </div>
      ${form ? '' : `<button class="btn btn-small btn-primary" data-action="new-candidate" type="button">Tambah calon</button>`}
    </div>
    ${
      candidates.length
        ? `<div class="list">${candidates
            .map(
              (candidate, index) => `<div class="list-item">
                ${
                  candidate.photo_url
                    ? `<img class="thumb" src="${escapeHtml(candidate.photo_url)}" alt="">`
                    : `<div class="thumb-fallback">${escapeHtml(initials(candidate.name))}</div>`
                }
                <div class="list-main">
                  <div class="list-title">${escapeHtml(candidate.name)}</div>
                  <div class="list-sub">${escapeHtml(candidate.tagline || 'Tanpa tagline')}</div>
                </div>
                <div class="list-actions">
                  <span class="pill ${candidate.active ? 'green' : 'muted'}">${candidate.active ? 'Aktif' : 'Nonaktif'}</span>
                  <button class="btn btn-small btn-ghost" data-action="move-candidate" data-id="${candidate.id}" data-dir="-1" ${index === 0 ? 'disabled' : ''} type="button" aria-label="Naikkan">↑</button>
                  <button class="btn btn-small btn-ghost" data-action="move-candidate" data-id="${candidate.id}" data-dir="1" ${index === candidates.length - 1 ? 'disabled' : ''} type="button" aria-label="Turunkan">↓</button>
                  <button class="btn btn-small" data-action="edit-candidate" data-id="${candidate.id}" type="button">Edit</button>
                  <button class="btn btn-small btn-ghost" data-action="toggle-candidate" data-id="${candidate.id}" type="button">${candidate.active ? 'Nonaktifkan' : 'Aktifkan'}</button>
                  <button class="btn btn-small btn-danger" data-action="delete-candidate" data-id="${candidate.id}" type="button">Hapus</button>
                </div>
              </div>`
            )
            .join('')}</div>`
        : '<div class="empty">Belum ada calon. Klik “Tambah calon”.</div>'
    }
  </div>`;
}

function candidateFormHtml(candidate) {
  const editing = Boolean(candidate?.id);
  const photo =
    state.candidatePhoto === undefined
      ? candidate?.photo_url || ''
      : state.candidatePhoto || '';
  return `<div class="panel" style="margin-bottom:16px">
    <div class="panel-head">
      <div class="panel-title">${editing ? 'Edit calon' : 'Calon baru'}</div>
      <button class="btn btn-small btn-ghost" data-action="cancel-candidate" type="button">Tutup</button>
    </div>
    <form data-form="candidate" data-id="${candidate?.id || ''}">
      <div class="grid-2">
        <div class="field">
          <label for="cand-name">Nama</label>
          <input class="input" id="cand-name" name="name" maxlength="80" required value="${escapeHtml(candidate?.name || '')}">
        </div>
        <div class="field">
          <label for="cand-tagline">Tagline</label>
          <input class="input" id="cand-tagline" name="tagline" maxlength="160" value="${escapeHtml(candidate?.tagline || '')}" placeholder="Satu kalimat singkat">
        </div>
      </div>
      <div class="field">
        <label for="cand-visi">Visi</label>
        <textarea class="textarea" id="cand-visi" name="visi" maxlength="2000" placeholder="Visi calon">${escapeHtml(candidate?.visi || '')}</textarea>
      </div>
      <div class="field">
        <label for="cand-misi">Misi</label>
        <textarea class="textarea" id="cand-misi" name="misi" maxlength="2000" placeholder="Satu poin per baris">${escapeHtml(candidate?.misi || '')}</textarea>
        <span class="form-note">Tulis satu poin per baris.</span>
      </div>
      <div class="field">
        <span class="field-label">Foto</span>
        <div class="photo-picker">
          ${
            photo
              ? `<img class="photo-preview" id="photo-preview" src="${escapeHtml(photo)}" alt="Pratinjau foto">`
              : `<div class="photo-preview empty" id="photo-preview">Belum ada</div>`
          }
          <div style="flex:1">
            <input class="input" type="file" accept="image/png,image/jpeg,image/webp" data-photo>
            <div class="row" style="margin-top:8px">
              <button class="btn btn-small btn-ghost" data-action="remove-photo" type="button">Hapus foto</button>
            </div>
            <span class="form-note">Otomatis diperkecil ke 640px.</span>
          </div>
        </div>
      </div>
      <label class="switch">
        <input type="checkbox" name="active" ${candidate?.active === false ? '' : 'checked'}>
        <span class="switch-track"></span>
        <span class="switch-text"><b>Tampilkan calon</b><span>Calon nonaktif tidak muncul di halaman pemilih.</span></span>
      </label>
      <div class="row">
        <button class="btn btn-primary" type="submit">${editing ? 'Simpan perubahan' : 'Tambah calon'}</button>
        <button class="btn btn-ghost" data-action="cancel-candidate" type="button">Batal</button>
      </div>
    </form>
  </div>`;
}

// ------------------------------------------------------------ announcements

function announcementStatus(item) {
  const now = Date.now() + state.offset;
  if (item.publish_at > now) return ['Terjadwal', 'yellow'];
  if (item.unpublish_at && item.unpublish_at <= now) return ['Berakhir', 'muted'];
  return ['Aktif', 'green'];
}

function pageAnnouncements() {
  const items = state.data.announcements;
  const form = state.announcementForm;

  return `${form ? announcementFormHtml(form) : ''}
  <div class="panel">
    <div class="panel-head">
      <div>
        <div class="panel-title">Daftar pengumuman</div>
        <div class="panel-sub">Bisa dijadwalkan tampil dan berhenti otomatis</div>
      </div>
      ${form ? '' : `<button class="btn btn-small btn-primary" data-action="new-announcement" type="button">Tambah pengumuman</button>`}
    </div>
    ${
      items.length
        ? `<div class="list">${items
            .map((item) => {
              const [label, color] = announcementStatus(item);
              return `<div class="list-item">
                <div class="list-main">
                  <div class="list-title">${escapeHtml(item.title)}</div>
                  <div class="list-sub">${formatDate(item.publish_at)}${item.unpublish_at ? ` → ${formatDate(item.unpublish_at)}` : ''} · ${item.show_voter ? 'pemilih' : ''}${item.show_voter && item.show_display ? ' + ' : ''}${item.show_display ? 'layar' : ''}</div>
                </div>
                <div class="list-actions">
                  <span class="pill ${color}">${label}</span>
                  <button class="btn btn-small" data-action="edit-announcement" data-id="${item.id}" type="button">Edit</button>
                  <button class="btn btn-small btn-danger" data-action="delete-announcement" data-id="${item.id}" type="button">Hapus</button>
                </div>
              </div>`;
            })
            .join('')}</div>`
        : '<div class="empty">Belum ada pengumuman.</div>'
    }
  </div>`;
}

function announcementFormHtml(item) {
  const editing = Boolean(item?.id);
  const publish = item?.publish_at || Date.now();
  return `<div class="panel" style="margin-bottom:16px">
    <div class="panel-head">
      <div class="panel-title">${editing ? 'Edit pengumuman' : 'Pengumuman baru'}</div>
      <button class="btn btn-small btn-ghost" data-action="cancel-announcement" type="button">Tutup</button>
    </div>
    <form data-form="announcement" data-id="${item?.id || ''}">
      <div class="field">
        <label for="ann-title">Judul</label>
        <input class="input" id="ann-title" name="title" maxlength="120" required value="${escapeHtml(item?.title || '')}">
      </div>
      <div class="field">
        <label for="ann-body">Isi</label>
        <textarea class="textarea" id="ann-body" name="body" maxlength="4000">${escapeHtml(item?.body || '')}</textarea>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="ann-publish">Mulai tampil</label>
          <input class="input" id="ann-publish" name="publish_at" type="datetime-local" value="${toLocalInput(publish)}" required>
        </div>
        <div class="field">
          <label for="ann-unpublish">Berhenti tampil (opsional)</label>
          <input class="input" id="ann-unpublish" name="unpublish_at" type="datetime-local" value="${item?.unpublish_at ? toLocalInput(item.unpublish_at) : ''}">
        </div>
      </div>
      <label class="switch">
        <input type="checkbox" name="show_voter" ${item?.show_voter === false ? '' : 'checked'}>
        <span class="switch-track"></span>
        <span class="switch-text"><b>Tampil di halaman pemilih</b><span>Muncul di kartu pengumuman halaman voting.</span></span>
      </label>
      <label class="switch">
        <input type="checkbox" name="show_display" ${item?.show_display === false ? '' : 'checked'}>
        <span class="switch-track"></span>
        <span class="switch-text"><b>Tampil di layar publik</b><span>Muncul di bagian bawah layar proyektor.</span></span>
      </label>
      <div class="row" style="margin-top:8px">
        <button class="btn btn-primary" type="submit">${editing ? 'Simpan perubahan' : 'Tambah pengumuman'}</button>
        <button class="btn btn-ghost" data-action="cancel-announcement" type="button">Batal</button>
      </div>
    </form>
  </div>`;
}

// ------------------------------------------------------------ settings

function pageSettings() {
  const election = state.data.election;
  return `<div class="admin-grid">
    <div class="panel">
      <div class="panel-head"><div class="panel-title">Pemilihan</div></div>
      <form data-form="settings">
        <div class="field">
          <label for="set-title">Judul</label>
          <input class="input" id="set-title" name="title" maxlength="120" required value="${escapeHtml(election.title)}">
        </div>
        <div class="field">
          <label for="set-desc">Deskripsi</label>
          <textarea class="textarea" id="set-desc" name="description" maxlength="600" style="min-height:80px">${escapeHtml(election.description)}</textarea>
        </div>
        <div class="grid-2">
          <div class="field">
            <label for="set-opens">Dibuka</label>
            <input class="input" id="set-opens" name="opens_at" type="datetime-local" value="${toLocalInput(election.opens_at)}" required>
          </div>
          <div class="field">
            <label for="set-closes">Ditutup</label>
            <input class="input" id="set-closes" name="closes_at" type="datetime-local" value="${toLocalInput(election.closes_at)}" required>
          </div>
        </div>
        <div class="field">
          <label for="set-expected">Perkiraan jumlah pemilih (opsional)</label>
          <input class="input" id="set-expected" name="expected_voters" type="number" min="1" max="1000000" value="${election.expected_voters ?? ''}" placeholder="Contoh: 120">
          <span class="form-note">Dipakai untuk persentase partisipasi. Kosongkan jika tidak perlu.</span>
        </div>

        <label class="switch">
          <input type="checkbox" name="allow_revote" ${election.allow_revote ? 'checked' : ''}>
          <span class="switch-track"></span>
          <span class="switch-text"><b>Izinkan ubah pilihan</b><span>Pemilih bisa mengganti suara sampai voting ditutup.</span></span>
        </label>
        <label class="switch">
          <input type="checkbox" name="randomize_order" ${election.randomize_order ? 'checked' : ''}>
          <span class="switch-track"></span>
          <span class="switch-text"><b>Acak urutan calon</b><span>Urutan kartu diacak per sesi untuk mengurangi bias.</span></span>
        </label>
        <label class="switch">
          <input type="checkbox" name="show_results" ${election.show_results ? 'checked' : ''}>
          <span class="switch-track"></span>
          <span class="switch-text"><b>Tampilkan hasil setelah ditutup</b><span>Perolehan suara muncul di halaman pemilih setelah voting selesai.</span></span>
        </label>
        <label class="switch">
          <input type="checkbox" name="test_mode" ${election.test_mode ? 'checked' : ''}>
          <span class="switch-track"></span>
          <span class="switch-text"><b>Mode latihan</b><span>Menampilkan penanda di layar. Data tetap nyata, reset manual.</span></span>
        </label>

        <div class="row" style="margin-top:12px">
          <button class="btn btn-primary" type="submit">Simpan pengaturan</button>
        </div>
      </form>
    </div>

    <div>
      <div class="panel">
        <div class="panel-head"><div class="panel-title">Link & akses</div></div>
        <div class="field">
          <span class="field-label">Link voting saat ini</span>
          <div class="link-box">
            <input class="input" readonly value="${escapeHtml(`${location.origin}/vote/${election.slug}`)}" aria-label="Link voting">
            <button class="btn btn-small btn-cyan" data-action="copy-link" type="button">Salin</button>
          </div>
        </div>
        <button class="btn btn-ghost btn-small" data-action="rotate-link" type="button">Ganti link voting</button>
        <p class="form-note" style="margin-top:8px">Link lama langsung mati. Pemilih yang masih membuka halaman lama harus memakai link baru.</p>
      </div>

      <div class="panel" style="margin-top:16px">
        <div class="panel-head"><div class="panel-title">Ganti password</div></div>
        <form data-form="password">
          <div class="field">
            <label for="pw-current">Password saat ini</label>
            <input class="input" id="pw-current" name="current" type="password" autocomplete="current-password" required>
          </div>
          <div class="field">
            <label for="pw-next">Password baru</label>
            <input class="input" id="pw-next" name="next" type="password" autocomplete="new-password" minlength="8" required>
          </div>
          <button class="btn btn-small btn-primary" type="submit">Simpan password</button>
        </form>
      </div>

      <div class="danger-zone">
        <div class="panel-title">Zona berbahaya</div>
        <p class="form-note">Reset menghapus semua suara. Calon dan pengumuman tetap ada.</p>
        <button class="btn btn-small btn-danger" data-action="reset" type="button" style="margin-top:10px">Reset semua suara</button>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------ photo

function bindPhotoInput() {
  const input = document.querySelector('[data-photo]');
  if (!input) return;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 8_000_000) {
      toast('Foto terlalu besar. Maksimal 8 MB.', 'error');
      input.value = '';
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      state.candidatePhoto = dataUrl;
      const preview = document.getElementById('photo-preview');
      if (preview) {
        if (preview.tagName === 'IMG') preview.src = dataUrl;
        else {
          const img = document.createElement('img');
          img.className = 'photo-preview';
          img.id = 'photo-preview';
          img.alt = 'Pratinjau foto';
          img.src = dataUrl;
          preview.replaceWith(img);
        }
      }
    } catch {
      toast('Gagal membaca foto.', 'error');
    }
  });
}

// ------------------------------------------------------------ actions

function currentCandidate(id) {
  return state.data.candidates.find((candidate) => candidate.id === Number(id));
}

function currentAnnouncement(id) {
  return state.data.announcements.find((item) => item.id === Number(id));
}

async function submitCandidate(form) {
  const data = new FormData(form);
  const id = form.dataset.id ? Number(form.dataset.id) : null;
  const payload = {
    name: String(data.get('name') || '').trim(),
    tagline: String(data.get('tagline') || ''),
    visi: String(data.get('visi') || ''),
    misi: String(data.get('misi') || ''),
    active: data.get('active') === 'on',
  };
  if (state.candidatePhoto !== undefined) payload.photo_data_url = state.candidatePhoto;

  try {
    if (id) await api(`/api/admin/candidates/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/admin/candidates', { method: 'POST', body: JSON.stringify(payload) });
    state.candidateForm = null;
    state.candidatePhoto = undefined;
    await load();
    toast('Calon disimpan.', 'success');
  } catch (error) {
    toast(ERROR_LABEL[error.code] || error.message, 'error');
  }
}

async function submitAnnouncement(form) {
  const data = new FormData(form);
  const id = form.dataset.id ? Number(form.dataset.id) : null;
  const publish = fromLocalInput(String(data.get('publish_at') || ''));
  const unpublish = fromLocalInput(String(data.get('unpublish_at') || ''));
  if (!publish) {
    toast('Waktu mulai wajib diisi.', 'error');
    return;
  }
  const payload = {
    title: String(data.get('title') || '').trim(),
    body: String(data.get('body') || ''),
    publish_at: publish,
    unpublish_at: unpublish,
    show_voter: data.get('show_voter') === 'on',
    show_display: data.get('show_display') === 'on',
  };
  try {
    if (id) await api(`/api/admin/announcements/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/admin/announcements', { method: 'POST', body: JSON.stringify(payload) });
    state.announcementForm = null;
    await load();
    toast('Pengumuman disimpan.', 'success');
  } catch (error) {
    toast(ERROR_LABEL[error.code] || error.message, 'error');
  }
}

async function submitSettings(form) {
  const data = new FormData(form);
  const opens = fromLocalInput(String(data.get('opens_at') || ''));
  const closes = fromLocalInput(String(data.get('closes_at') || ''));
  const expectedRaw = String(data.get('expected_voters') || '').trim();
  const payload = {
    title: String(data.get('title') || '').trim(),
    description: String(data.get('description') || ''),
    opens_at: opens,
    closes_at: closes,
    expected_voters: expectedRaw ? Number(expectedRaw) : null,
    allow_revote: data.get('allow_revote') === 'on',
    randomize_order: data.get('randomize_order') === 'on',
    show_results: data.get('show_results') === 'on',
    test_mode: data.get('test_mode') === 'on',
  };
  try {
    await api('/api/admin/election', { method: 'PUT', body: JSON.stringify(payload) });
    await load();
    toast('Pengaturan disimpan.', 'success');
  } catch (error) {
    toast(ERROR_LABEL[error.code] || error.message, 'error');
  }
}

async function submitPassword(form) {
  const data = new FormData(form);
  try {
    await api('/api/admin/password', {
      method: 'POST',
      body: JSON.stringify({
        current: String(data.get('current') || ''),
        next: String(data.get('next') || ''),
      }),
    });
    form.reset();
    toast('Password diganti.', 'success');
  } catch (error) {
    toast(ERROR_LABEL[error.code] || error.message, 'error');
  }
}

async function login(form) {
  const data = new FormData(form);
  state.loginError = '';
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        username: String(data.get('username') || '').trim(),
        password: String(data.get('password') || ''),
      }),
    });
    await load();
  } catch (error) {
    state.loginError = ERROR_LABEL[error.code] || error.message;
    renderLogin();
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link disalin.', 'success');
  } catch {
    const input = document.querySelector('[data-link-input]');
    if (input) {
      input.select();
      document.execCommand('copy');
      toast('Link disalin.', 'success');
    }
  }
}

async function moveCandidate(id, direction) {
  const ids = state.data.candidates.map((candidate) => candidate.id);
  const index = ids.indexOf(Number(id));
  const next = index + Number(direction);
  if (index < 0 || next < 0 || next >= ids.length) return;
  [ids[index], ids[next]] = [ids[next], ids[index]];
  try {
    await api('/api/admin/candidates/reorder', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
    await load();
  } catch (error) {
    toast(ERROR_LABEL[error.code] || error.message, 'error');
  }
}

// ------------------------------------------------------------ events

app.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  if (kind === 'login') login(form);
  else if (kind === 'candidate') submitCandidate(form);
  else if (kind === 'announcement') submitAnnouncement(form);
  else if (kind === 'settings') submitSettings(form);
  else if (kind === 'password') submitPassword(form);
});

app.addEventListener('click', async (event) => {
  const tab = event.target.closest('[data-tab]');
  if (tab) {
    state.tab = tab.dataset.tab;
    location.hash = state.tab;
    state.candidateForm = null;
    state.candidatePhoto = undefined;
    state.announcementForm = null;
    renderApp();
    return;
  }

  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;

  switch (action) {
    case 'logout':
      await api('/api/admin/logout', { method: 'POST', body: '{}' }).catch(() => {});
      state.data = null;
      renderLogin();
      break;

    case 'new-candidate':
      state.candidateForm = {};
      state.candidatePhoto = undefined;
      renderPage();
      break;

    case 'edit-candidate':
      state.candidateForm = { ...currentCandidate(id) };
      state.candidatePhoto = undefined;
      renderPage();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      break;

    case 'cancel-candidate':
      state.candidateForm = null;
      state.candidatePhoto = undefined;
      renderPage();
      break;

    case 'remove-photo':
      state.candidatePhoto = null;
      renderPage();
      break;

    case 'toggle-candidate': {
      const candidate = currentCandidate(id);
      if (!candidate) break;
      try {
        await api(`/api/admin/candidates/${candidate.id}`, {
          method: 'PUT',
          body: JSON.stringify({ active: !candidate.active }),
        });
        await load();
      } catch (error) {
        toast(ERROR_LABEL[error.code] || error.message, 'error');
      }
      break;
    }

    case 'delete-candidate': {
      const candidate = currentCandidate(id);
      if (!candidate) break;
      if (!confirm(`Hapus calon “${candidate.name}”?`)) break;
      try {
        await api(`/api/admin/candidates/${candidate.id}`, { method: 'DELETE' });
        await load();
        toast('Calon dihapus.', 'success');
      } catch (error) {
        toast(ERROR_LABEL[error.code] || error.message, 'error');
      }
      break;
    }

    case 'move-candidate':
      moveCandidate(id, target.dataset.dir);
      break;

    case 'new-announcement':
      state.announcementForm = {};
      renderPage();
      break;

    case 'edit-announcement':
      state.announcementForm = { ...currentAnnouncement(id) };
      renderPage();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      break;

    case 'cancel-announcement':
      state.announcementForm = null;
      renderPage();
      break;

    case 'delete-announcement': {
      const item = currentAnnouncement(id);
      if (!item) break;
      if (!confirm(`Hapus pengumuman “${item.title}”?`)) break;
      try {
        await api(`/api/admin/announcements/${item.id}`, { method: 'DELETE' });
        await load();
        toast('Pengumuman dihapus.', 'success');
      } catch (error) {
        toast(ERROR_LABEL[error.code] || error.message, 'error');
      }
      break;
    }

    case 'copy-link': {
      const input = document.querySelector('[data-link-input]');
      const value = input ? input.value : `${location.origin}/vote/${state.data.election.slug}`;
      copyText(value);
      break;
    }

    case 'rotate-link':
      if (!confirm('Ganti link voting? Link lama langsung tidak berlaku.')) break;
      try {
        const result = await api('/api/admin/rotate-link', { method: 'POST', body: '{}' });
        await load();
        toast('Link baru dibuat.', 'success');
        console.log('Link baru:', `${location.origin}/vote/${result.slug}`);
      } catch (error) {
        toast(ERROR_LABEL[error.code] || error.message, 'error');
      }
      break;

    case 'reset': {
      const answer = prompt('Ketik RESET untuk menghapus semua suara:');
      if (answer !== 'RESET') break;
      try {
        await api('/api/admin/reset', { method: 'POST', body: JSON.stringify({ confirm: 'RESET' }) });
        await load();
        toast('Semua suara dihapus.', 'success');
      } catch (error) {
        toast(ERROR_LABEL[error.code] || error.message, 'error');
      }
      break;
    }

    case 'toggle-numbers':
      state.showNumbers = !state.showNumbers;
      renderPage();
      break;

    default:
      break;
  }
});

window.addEventListener('hashchange', () => {
  const tab = location.hash.slice(1);
  if (['dashboard', 'calon', 'pengumuman', 'pengaturan'].includes(tab) && tab !== state.tab) {
    state.tab = tab;
    state.candidateForm = null;
    state.announcementForm = null;
    renderApp();
  }
});

async function boot() {
  try {
    await load();
  } catch (error) {
    if (error.status === 401) renderLogin();
    else {
      app.innerHTML = `<div class="login-wrap"><div class="login-card">
        <div class="login-mark">!</div>
        <h1 class="login-title">Server<br>Bermasalah</h1>
        <p class="login-sub">${escapeHtml(ERROR_LABEL[error.code] || error.message)}</p>
        <a class="btn btn-primary btn-block" href="/admin">Muat ulang</a>
      </div></div>`;
    }
  }
}

boot();
