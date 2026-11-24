import { music } from './audio.js';
import { formatDate, setTimezone } from './time.js';

const app = document.getElementById('app');
const canvas = document.getElementById('fx');
const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');

const state = {
  data: null,
  view: 'loading',
  selectedId: null,
  order: [],
  orderIds: '',
  offset: 0,
  busy: false,
  error: '',
  musicEnabled: localStorage.getItem('pk_music') === '1',
  signature: '',
  timer: null,
  poll: null,
};

const STATUS_LABEL = {
  open: 'Dibuka',
  upcoming: 'Belum dibuka',
  closed: 'Ditutup',
};

const ERROR_LABEL = {
  link_tidak_valid: 'Link sudah tidak berlaku.',
  voting_ditutup: 'Voting sudah ditutup.',
  sudah_memilih: 'Suara sudah tercatat.',
  calon_tidak_valid: 'Calon tidak valid.',
  terlalu_banyak_percobaan: 'Terlalu banyak percobaan. Coba lagi sebentar.',
  server_error: 'Terjadi kesalahan. Coba lagi.',
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

function colorFor(index) {
  return ['', 'pink', 'cyan', 'green'][index % 4];
}

function photoHtml(candidate, index, fallbackClass = 'avatar-fallback') {
  if (candidate.photo_url) {
    return `<img src="${escapeHtml(candidate.photo_url)}" alt="Foto ${escapeHtml(candidate.name)}" loading="lazy">`;
  }
  return `<div class="${fallbackClass} ${colorFor(index)}" aria-hidden="true">${escapeHtml(initials(candidate.name))}</div>`;
}

function countdownParts(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    d: Math.floor(total / 86400),
    h: Math.floor((total % 86400) / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60,
  };
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function countdownHtml() {
  return `<div class="countdown" role="timer" aria-label="Sisa waktu voting">
    <div class="cd-cell"><span class="cd-value" data-cd="d">00</span><span class="cd-label">Hari</span></div>
    <div class="cd-cell"><span class="cd-value" data-cd="h">00</span><span class="cd-label">Jam</span></div>
    <div class="cd-cell"><span class="cd-value" data-cd="m">00</span><span class="cd-label">Menit</span></div>
    <div class="cd-cell seconds"><span class="cd-value" data-cd="s">00</span><span class="cd-label">Detik</span></div>
  </div>`;
}

function statusPill() {
  const status = state.data?.election.status || 'closed';
  return `<span class="pill ${status === 'open' ? 'green' : status === 'upcoming' ? 'yellow' : 'red'}">
    <span class="dot ${status === 'open' ? 'live' : ''}"></span>${STATUS_LABEL[status]}
  </span>`;
}

function musicIcon(on) {
  if (on) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5Z" fill="currentColor" stroke="none"/>
      <path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12" stroke-linecap="square"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true">
    <path d="M11 5 6 9H2v6h4l5 4V5Z" fill="currentColor" stroke="none"/>
    <path d="m16 9 6 6m0-6-6 6" stroke-linecap="square"/>
  </svg>`;
}

function topbar() {
  return `<header class="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span>Paguyuban</div>
    <div class="topbar-actions">
      ${statusPill()}
      <button class="icon-btn" type="button" data-action="music" aria-label="Nyalakan atau matikan musik" aria-pressed="false">${musicIcon(false)}</button>
    </div>
  </header>`;
}

function footer() {
  return `<footer class="footer">
    <span>Satu perangkat satu suara</span>
    <span>${new Date().getFullYear()} · Kotak Suara</span>
  </footer>`;
}

function latestNotice() {
  const notice = state.data?.announcements?.[0];
  if (!notice) return '';
  return `<div class="notice">
    <div class="notice-label"><span aria-hidden="true">▸</span> Pengumuman</div>
    <div class="notice-title">${escapeHtml(notice.title)}</div>
    <div class="notice-body">${escapeHtml(notice.body)}</div>
  </div>`;
}

function alreadyVotedBanner() {
  if (!state.data?.has_voted) return '';
  const candidate = state.data.candidates.find((c) => c.id === state.data.my_candidate_id);
  const canChange = state.data.allow_revote && state.data.election.status === 'open';
  return `<div class="banner">
    <span aria-hidden="true">✓</span>
    <span>Suara tercatat${candidate ? `: ${escapeHtml(candidate.name)}` : ''}${canChange ? ' · bisa diubah' : ''}</span>
  </div>`;
}

function testBanner() {
  return state.data?.election.test_mode
    ? `<div class="banner test"><span aria-hidden="true">!</span><span>Mode latihan — data bisa direset</span></div>`
    : '';
}

// ------------------------------------------------------------ views

function renderLanding() {
  const election = state.data.election;
  const status = election.status;
  const canVote = status === 'open';
  const hasVoted = state.data.has_voted;
  const canChange = hasVoted && state.data.allow_revote && canVote;

  let primary = '';
  if (status === 'open') {
    if (hasVoted) {
      primary = canChange
        ? `<button class="btn btn-primary" data-action="change">Ubah pilihan</button>`
        : `<button class="btn btn-primary" disabled>Suara sudah tercatat</button>`;
    } else {
      primary = `<button class="btn btn-primary" data-action="start">Mulai memilih <span aria-hidden="true">→</span></button>`;
    }
  } else if (status === 'upcoming') {
    primary = `<button class="btn btn-primary" disabled>Belum dibuka</button>`;
  } else {
    primary = `<button class="btn" data-action="results">Lihat status</button>`;
  }

  return `${topbar()}
  <section class="hero fade-up">
    ${testBanner()}
    ${alreadyVotedBanner()}
    <h1 class="hero-title">Pilih<br><span class="accent">Ketua</span><br>Paguyuban</h1>
    <p class="hero-sub">${escapeHtml(election.description || 'Tentukan ketua untuk masa bakti berikutnya.')}</p>
  </section>

  ${status !== 'closed' ? countdownHtml() : ''}

  ${latestNotice()}

  <div class="cta-row">
    ${primary}
    ${status === 'open' ? `<button class="btn btn-ghost" data-action="start">Lihat calon dulu</button>` : ''}
    ${status === 'upcoming' ? `<div class="meta-line">Dibuka ${escapeHtml(formatDate(election.opens_at))}</div>` : ''}
    ${status === 'closed' ? `<div class="meta-line">Ditutup ${escapeHtml(formatDate(election.closes_at))}</div>` : ''}
  </div>

  <div class="meta-line">
    <span>${state.data.candidates.length} calon</span>
    <span class="sep"></span>
    <span class="votes-count" data-live-total>${state.data.total_votes} suara masuk</span>
  </div>

  ${footer()}`;
}

function renderCandidates() {
  const hasVoted = state.data.has_voted;
  const canChange = state.data.allow_revote && state.data.election.status === 'open';
  const locked = hasVoted && !state.data.allow_revote;
  const cards = state.order
    .map((candidate, index) => {
      const selected = state.data.my_candidate_id === candidate.id;
      return `<article class="candidate-card ${selected ? 'selected' : ''}" data-id="${candidate.id}">
        <span class="card-number">${pad(index + 1)}</span>
        <div class="photo-frame">${photoHtml(candidate, index)}</div>
        <div class="card-body">
          <h2 class="card-name">${escapeHtml(candidate.name)}</h2>
          <p class="card-tagline">${escapeHtml(candidate.tagline || 'Calon ketua paguyuban')}</p>
        </div>
        <div class="card-foot">
          <button class="btn btn-small" data-action="profile" data-id="${candidate.id}">Lihat profil</button>
          <button class="btn btn-small ${selected ? 'btn-cyan' : 'btn-primary'}" data-action="choose" data-id="${candidate.id}" ${locked ? 'disabled' : ''}>${locked ? 'Sudah memilih' : selected ? 'Pilihanmu' : hasVoted && canChange ? 'Ganti' : 'Pilih'}</button>
        </div>
      </article>`;
    })
    .join('');

  return `${topbar()}
  <button class="btn btn-small btn-ghost back-btn" data-action="back">← Kembali</button>
  <div class="section-head fade-up">
    <div>
      <h1 class="section-title">Kenali<br>Calonmu</h1>
      <p class="section-sub">Semua calon tampil di bawah. Urutan diacak — pilih siapa saja.</p>
    </div>
  </div>
  <div class="cards" data-cards>${cards}</div>
  ${footer()}`;
}

function renderProfile() {
  const index = state.order.findIndex((c) => c.id === state.selectedId);
  const candidate = state.order[index];
  if (!candidate) {
    state.view = 'candidates';
    return renderCandidates();
  }
  const selected = state.data.my_candidate_id === candidate.id;
  const locked = state.data.has_voted && !state.data.allow_revote;
  const misi = String(candidate.misi || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return `${topbar()}
  <button class="btn btn-small btn-ghost back-btn" data-action="back">← Calon</button>
  <section class="profile fade-up">
    <div class="profile-head">
      <div class="profile-photo">${photoHtml(candidate, index)}</div>
      <div class="profile-info">
        <span class="pill ${selected ? 'green' : 'muted'}">Calon ${pad(index + 1)}${selected ? ' · pilihanmu' : ''}</span>
        <h1 class="card-name">${escapeHtml(candidate.name)}</h1>
        <p class="profile-tagline">${escapeHtml(candidate.tagline || '')}</p>
      </div>
    </div>

    ${candidate.visi ? `<div class="profile-section"><h3>Visi</h3><p>${escapeHtml(candidate.visi)}</p></div>` : ''}
    ${
      misi.length
        ? `<div class="profile-section"><h3>Misi</h3><ul class="misi-list">${misi
            .map((line) => `<li>${escapeHtml(line)}</li>`)
            .join('')}</ul></div>`
        : ''
    }

    <div class="cta-row">
      <button class="btn btn-primary btn-block" data-action="choose" data-id="${candidate.id}" ${locked ? 'disabled' : ''}>
        ${locked ? 'Suara sudah tercatat' : selected ? 'Tetap pilih calon ini' : 'Pilih calon ini'}
      </button>
    </div>
  </section>
  ${footer()}`;
}

function renderSuccess() {
  const candidate = state.data.candidates.find((c) => c.id === state.data.my_candidate_id);
  const canChange = state.data.allow_revote && state.data.election.status === 'open';
  return `${topbar()}
  <section class="success fade-up">
    <svg class="mascot" viewBox="0 0 32 32" shape-rendering="crispEdges" aria-hidden="true">
      <rect x="4" y="9" width="24" height="17" fill="#FFD23F"/>
      <rect x="6" y="11" width="20" height="13" fill="#161936"/>
      <rect x="12" y="6" width="8" height="4" fill="#FFD23F"/>
      <rect x="14" y="13" width="4" height="7" fill="#FF5C8A"/>
      <rect x="9" y="22" width="3" height="5" fill="#FFD23F"/>
      <rect x="20" y="22" width="3" height="5" fill="#FFD23F"/>
      <rect x="7" y="14" width="2" height="2" fill="#4DE1FF"/>
      <rect x="23" y="14" width="2" height="2" fill="#4DE1FF"/>
    </svg>
    <h1 class="success-title">Suara<br>Tercatat!</h1>
    <p class="success-sub">Terima kasih${candidate ? `, pilihanmu untuk <b>${escapeHtml(candidate.name)}</b>` : ''} sudah masuk.</p>
    <div class="success-stats">
      <div class="success-stat"><b data-live-total>${state.data.total_votes}</b><span>Suara masuk</span></div>
      <div class="success-stat"><b>${state.data.candidates.length}</b><span>Calon</span></div>
    </div>
    ${canChange ? `<button class="btn btn-ghost" data-action="change">Ubah pilihan</button>` : `<button class="btn btn-ghost" data-action="home">Kembali</button>`}
  </section>
  ${footer()}`;
}

function renderClosed() {
  const election = state.data.election;
  const results = state.data.results;
  const total = state.data.total_votes;
  let resultsHtml = '';

  if (results && results.length) {
    const max = Math.max(1, ...results.map((r) => r.votes));
    resultsHtml = `<div class="results">${results
      .map((r, i) => {
        const pct = total > 0 ? Math.round((r.votes / total) * 100) : 0;
        return `<div class="result-row">
          <div class="result-top">
            <span>${escapeHtml(r.name)}</span>
            <span class="votes">${r.votes} suara · ${pct}%</span>
          </div>
          <div class="result-track"><div class="result-fill ${colorFor(i)}" style="width:${(r.votes / max) * 100}%"></div></div>
        </div>`;
      })
      .join('')}</div>`;
  }

  return `${topbar()}
  <section class="state-card fade-up">
    <span class="stamp">Closed</span>
    <h1 class="state-title red">Voting<br>Ditutup</h1>
    <p class="state-sub">Voting berakhir ${escapeHtml(formatDate(election.closes_at))}.</p>
    <div class="meta-line" style="justify-content:flex-start">
      <span class="votes-count" data-live-total>${total} suara masuk</span>
    </div>
    ${resultsHtml}
    ${
      results
        ? ''
        : `<p class="state-sub">Hasil perolehan suara akan diumumkan oleh panitia.</p>`
    }
    <button class="btn btn-ghost btn-small" data-action="home">Kembali ke awal</button>
  </section>
  ${footer()}`;
}

function renderInvalid() {
  return `${topbar()}
  <section class="state-card fade-up">
    <span class="stamp">404</span>
    <h1 class="state-title red">Link Tidak<br>Valid</h1>
    <p class="state-sub">${escapeHtml(state.error || 'Link voting sudah diganti atau tidak dikenal.')}</p>
    <p class="state-sub">Minta link terbaru ke panitia paguyuban.</p>
  </section>`;
}

function renderLoading() {
  return `<div class="success" style="margin:auto">
    <div class="hero-eyebrow">Memuat</div>
    <h1 class="hero-title">Kotak<br><span class="accent">Suara</span></h1>
    <span class="pill muted"><span class="dot live"></span>Menyiapkan</span>
  </div>`;
}

// ------------------------------------------------------------ modal & confetti

function openConfirm(candidateId) {
  const index = state.order.findIndex((c) => c.id === candidateId);
  const candidate = state.order[index];
  if (!candidate) return;
  const selected = state.data.my_candidate_id === candidate.id;
  const note = state.data.allow_revote
    ? 'Pilihan bisa diubah sampai voting ditutup.'
    : 'Pilihan tidak bisa diubah setelah dikirim.';

  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop';
  overlay.dataset.modal = 'confirm';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
    <h2 class="modal-title" id="confirm-title">${selected ? 'Tetap pilih?' : 'Yakin pilih?'}</h2>
    <div class="modal-choice">
      ${photoHtml(candidate, index)}
      <div>
        <div class="modal-choice-name">${escapeHtml(candidate.name)}</div>
        <div class="list-sub">${escapeHtml(candidate.tagline || '')}</div>
      </div>
    </div>
    <p class="modal-note">${note}</p>
    <div class="modal-actions">
      <button class="btn btn-primary" data-action="submit" data-id="${candidate.id}">Ya, pilih</button>
      <button class="btn btn-ghost" data-action="close-modal">Batal</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  music.select();
}

function closeModal() {
  document.querySelector('[data-modal]')?.remove();
}

function runConfetti() {
  if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const colors = ['#FFD23F', '#FF5C8A', '#4DE1FF', '#6BFF8E', '#F5F2E9'];
  const pieces = Array.from({ length: 70 }, () => ({
    x: width / 2 + (Math.random() - 0.5) * width * 0.5,
    y: height * 0.42 + (Math.random() - 0.5) * 80,
    vx: (Math.random() - 0.5) * 9,
    vy: -Math.random() * 11 - 3,
    size: 4 + Math.random() * 6,
    color: colors[Math.floor(Math.random() * colors.length)],
    rotation: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.3,
    life: 0,
  }));

  let frame = 0;
  function tick() {
    frame += 1;
    ctx.clearRect(0, 0, width, height);
    let alive = false;
    for (const piece of pieces) {
      piece.life += 1;
      piece.vy += 0.42;
      piece.x += piece.vx;
      piece.y += piece.vy;
      piece.rotation += piece.spin;
      if (piece.y < height + 30 && piece.life < 120) {
        alive = true;
        ctx.save();
        ctx.translate(piece.x, piece.y);
        ctx.rotate(piece.rotation);
        ctx.fillStyle = piece.color;
        ctx.fillRect(-piece.size / 2, -piece.size / 2, piece.size, piece.size);
        ctx.restore();
      }
    }
    if (alive && frame < 150) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, width, height);
  }
  requestAnimationFrame(tick);
}

// ------------------------------------------------------------ data

async function fetchState() {
  const response = await fetch('/api/public/state', {
    headers: { 'X-Vote-Slug': slug, Accept: 'application/json' },
    cache: 'no-store',
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

function syncOrder() {
  const ids = state.data.candidates.map((c) => c.id).join(',');
  if (ids === state.orderIds) return;
  state.orderIds = ids;
  const list = [...state.data.candidates];
  if (state.data.election.randomize_order) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  state.order = list;
}

function signatureOf(data) {
  return JSON.stringify([
    data.election.status,
    data.election.title,
    data.has_voted,
    data.my_candidate_id,
    data.allow_revote,
    data.candidates.map((c) => c.id).join(','),
    data.announcements.map((a) => `${a.id}:${a.title}`),
    data.results ? data.results.map((r) => r.votes) : null,
  ]);
}

function applyState(data) {
  setTimezone(data.timezone, data.tz_offset);
  state.data = data;
  state.offset = data.server_now - Date.now();
  syncOrder();
  state.signature = signatureOf(data);
}

async function boot() {
  try {
    const data = await fetchState();
    applyState(data);
    state.view = data.election.status === 'closed' ? 'closed' : 'landing';
    render();
    startTimers();
  } catch (error) {
    state.error = ERROR_LABEL[error.code] || 'Link voting tidak valid.';
    state.view = 'invalid';
    render();
  }
}

async function refresh() {
  try {
    const data = await fetchState();
    const previous = state.data;
    const prevSignature = signatureOf(previous);
    applyState(data);
    if (state.signature === prevSignature) {
      updateLive();
      return;
    }
    if (data.election.status === 'closed' && state.view !== 'success') {
      state.view = 'closed';
      render();
      return;
    }
    if (state.view === 'landing' || state.view === 'candidates' || state.view === 'closed') {
      if (state.view === 'landing' && data.election.status === 'upcoming') {
        state.view = 'landing';
      }
      render();
      return;
    }
    updateLive();
  } catch (error) {
    if (error.status === 403) {
      state.error = ERROR_LABEL[error.code] || 'Link voting sudah diganti.';
      state.view = 'invalid';
      render();
    }
  }
}

function startTimers() {
  if (state.timer) clearInterval(state.timer);
  if (state.poll) clearInterval(state.poll);
  state.timer = setInterval(tickCountdown, 1000);
  state.poll = setInterval(refresh, 5000);
  tickCountdown();
}

function tickCountdown() {
  if (!state.data) return;
  const remaining = state.data.election.closes_at - (Date.now() + state.offset);
  const parts = countdownParts(remaining);
  document.querySelectorAll('[data-cd]').forEach((el) => {
    const key = el.dataset.cd;
    el.textContent = key === 'd' ? String(parts.d) : pad(parts[key]);
  });
}

function updateLive() {
  document.querySelectorAll('[data-live-total]').forEach((el) => {
    el.textContent = state.data.total_votes;
  });
}

// ------------------------------------------------------------ actions

async function submitVote(candidateId) {
  if (state.busy) return;
  state.busy = true;
  const button = document.querySelector('[data-action="submit"]');
  if (button) {
    button.disabled = true;
    button.textContent = 'Mengirim...';
  }

  try {
    const response = await fetch('/api/public/vote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PK': '1',
        'X-Vote-Slug': slug,
      },
      body: JSON.stringify({ candidate_id: candidateId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = data.error || 'server_error';
      if (code === 'voting_ditutup') {
        closeModal();
        state.view = 'closed';
        state.data.election.status = 'closed';
        render();
        return;
      }
      if (code === 'link_tidak_valid') {
        closeModal();
        state.view = 'invalid';
        state.error = ERROR_LABEL[code];
        render();
        return;
      }
      throw new Error(code);
    }

    closeModal();
    state.data.total_votes = data.total_votes;
    state.data.has_voted = true;
    state.data.my_candidate_id = data.candidate_id;
    state.view = 'success';
    render();
    music.confirm();
    setTimeout(() => {
      music.success();
      runConfetti();
    }, 220);
  } catch (error) {
    music.error();
    closeModal();
    toast(ERROR_LABEL[error.message] || 'Gagal mengirim suara. Coba lagi.');
  } finally {
    state.busy = false;
  }
}

function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toast.hideTimer);
  toast.hideTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function setMusicUi() {
  const buttons = document.querySelectorAll('[data-action="music"]');
  buttons.forEach((button) => {
    button.classList.toggle('active', state.musicEnabled);
    button.setAttribute('aria-pressed', String(state.musicEnabled));
    button.innerHTML = musicIcon(state.musicEnabled);
  });
}

function goHome() {
  state.view = state.data?.election.status === 'closed' ? 'closed' : 'landing';
  render();
}

// ------------------------------------------------------------ render

function render() {
  if (!state.data && state.view !== 'invalid' && state.view !== 'loading') state.view = 'loading';
  switch (state.view) {
    case 'landing':
      app.innerHTML = renderLanding();
      break;
    case 'candidates':
      app.innerHTML = renderCandidates();
      break;
    case 'profile':
      app.innerHTML = renderProfile();
      break;
    case 'success':
      app.innerHTML = renderSuccess();
      break;
    case 'closed':
      app.innerHTML = renderClosed();
      break;
    case 'invalid':
      app.innerHTML = renderInvalid();
      break;
    default:
      app.innerHTML = renderLoading();
  }
  setMusicUi();
  tickCountdown();
}

// ------------------------------------------------------------ events

// Modal konfirmasi ditambahkan ke document.body, jadi delegation harus di document.
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  switch (action) {
    case 'start':
      state.view = 'candidates';
      render();
      music.click();
      break;
    case 'back':
      if (state.view === 'profile') {
        state.view = 'candidates';
      } else {
        state.view = 'landing';
      }
      render();
      music.click();
      break;
    case 'profile':
      state.selectedId = Number(target.dataset.id);
      state.view = 'profile';
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      music.click();
      break;
    case 'choose':
      openConfirm(Number(target.dataset.id));
      break;
    case 'submit':
      submitVote(Number(target.dataset.id));
      break;
    case 'close-modal':
      closeModal();
      music.click();
      break;
    case 'change':
      state.view = 'candidates';
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      music.click();
      break;
    case 'home':
      goHome();
      break;
    case 'results':
      state.view = 'closed';
      render();
      break;
    case 'music':
      if (music.playing) {
        music.stop();
        state.musicEnabled = false;
      } else {
        music.start();
        state.musicEnabled = true;
      }
      localStorage.setItem('pk_music', state.musicEnabled ? '1' : '0');
      setMusicUi();
      break;
    default:
      break;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModal();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    music.stop();
  } else if (state.musicEnabled) {
    music.start();
  }
});

if (state.musicEnabled) {
  const unlock = () => {
    music.start();
    state.musicEnabled = true;
    setMusicUi();
    document.removeEventListener('pointerdown', unlock);
  };
  document.addEventListener('pointerdown', unlock, { once: true });
}

boot();
