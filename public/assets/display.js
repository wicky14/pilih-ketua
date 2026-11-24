import { formatDate, setTimezone, timezoneLabel } from './time.js';

const root = document.getElementById('display');

const state = {
  data: null,
  offset: 0,
  noticeIndex: 0,
  total: 0,
  raf: null,
  lastNoticeAt: 0,
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function shell() {
  root.innerHTML = `<section class="display-top">
    <div class="display-brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <div>
        <b data-title>Pemilihan Ketua Paguyuban</b>
        <span data-subtitle>Kotak Suara · Live</span>
      </div>
    </div>
    <div class="display-countdown">
      <div class="label" data-status>Memuat</div>
      <div class="value" data-cd>--:--:--</div>
    </div>
  </section>

  <section class="display-center">
    <div class="display-label" data-main-label>Suara Masuk</div>
    <div class="display-count" data-count>0</div>
    <div class="display-sub" data-sub>&nbsp;</div>
    <div class="display-progress">
      <div class="progress-track"><div class="progress-fill" data-progress></div></div>
    </div>
    <div class="display-results" data-results hidden></div>
    <div class="display-sub" data-note></div>
  </section>

  <section class="display-bottom">
    <div class="display-notice">
      <span class="tag">Pengumuman</span>
      <span class="text" data-notice>Memuat pengumuman...</span>
    </div>
    <div class="display-footer">
      <span data-footer-left>Satu perangkat satu suara</span>
      <span data-footer-right></span>
    </div>
  </section>

  <div class="display-test hidden" data-test>Mode latihan</div>`;
}

function setText(selector, value) {
  const el = root.querySelector(selector);
  if (el) el.textContent = value;
}

function animateTotal(to) {
  const el = root.querySelector('[data-count]');
  if (!el) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    state.total = to;
    el.textContent = to;
    return;
  }
  const from = state.total;
  if (from === to) {
    el.textContent = to;
    return;
  }
  const start = performance.now();
  cancelAnimationFrame(state.raf);
  function step(now) {
    const progress = Math.min(1, (now - start) / 700);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = Math.round(from + (to - from) * eased);
    state.total = value;
    el.textContent = value;
    if (progress < 1) state.raf = requestAnimationFrame(step);
    else {
      state.total = to;
      el.textContent = to;
    }
  }
  state.raf = requestAnimationFrame(step);
}

function renderResults(results, total) {
  const box = root.querySelector('[data-results]');
  if (!box) return;
  if (!results || !results.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const max = Math.max(1, ...results.map((row) => row.votes));
  box.hidden = false;
  box.innerHTML = results
    .map((row, index) => {
      const pct = total > 0 ? Math.round((row.votes / total) * 100) : 0;
      const color = ['', 'pink', 'cyan', 'green'][index % 4];
      return `<div class="result-row">
        <div class="result-top">
          <span>${escapeHtml(row.name)}</span>
          <span class="votes">${row.votes} suara · ${pct}%</span>
        </div>
        <div class="result-track"><div class="result-fill ${color}" style="width:${(row.votes / max) * 100}%"></div></div>
      </div>`;
    })
    .join('');
}

function notices() {
  return state.data?.display_announcements || state.data?.announcements || [];
}

function renderNotice() {
  const items = notices();
  if (!items.length) {
    setText('[data-notice]', 'Belum ada pengumuman.');
    return;
  }
  const index = state.noticeIndex % items.length;
  const notice = items[index];
  setText('[data-notice]', `${notice.title} — ${notice.body}`);
}

function apply() {
  if (!state.data) return;
  const { election, total_votes: total, expected_voters: expected, results } = state.data;

  setText('[data-title]', election.title);
  setText('[data-subtitle]', election.description || 'Kotak Suara · Live');

  const statusLabel =
    election.status === 'open'
      ? 'Voting dibuka'
      : election.status === 'upcoming'
        ? 'Segera dibuka'
        : 'Voting ditutup';
  setText('[data-status]', statusLabel);

  setText(
    '[data-main-label]',
    election.status === 'open'
      ? 'Suara Masuk'
      : election.status === 'upcoming'
        ? 'Menuju Voting'
        : 'Voting Ditutup'
  );

  animateTotal(total);
  setText(
    '[data-sub]',
    expected ? `dari ${expected} pemilih · ${Math.round((total / expected) * 100)}%` : 'suara tercatat'
  );

  const progress = expected ? Math.min(100, (total / expected) * 100) : 0;
  const fill = root.querySelector('[data-progress]');
  if (fill) fill.style.width = `${progress}%`;

  const note = root.querySelector('[data-note]');
  if (note) {
    if (election.status === 'closed' && !results) {
      note.textContent = 'Hasil perolehan suara diumumkan oleh panitia.';
    } else if (election.status === 'upcoming') {
      note.textContent = `Dibuka ${formatDate(election.opens_at)} ${timezoneLabel()}`;
    } else {
      note.textContent = '';
    }
  }

  renderResults(results, total);

  const test = root.querySelector('[data-test]');
  if (test) test.classList.toggle('hidden', !election.test_mode);

  setText('[data-footer-right]', election.status === 'closed' ? 'Selesai' : `Tutup ${formatDate(election.closes_at)} ${timezoneLabel()}`);
  renderNotice();
}

function tick() {
  if (!state.data) return;
  const election = state.data.election;
  const el = root.querySelector('[data-cd]');
  if (!el) return;
  if (election.status === 'closed') {
    el.textContent = 'SELESAI';
    return;
  }
  const remaining = election.closes_at - (Date.now() + state.offset);
  if (remaining <= 0) {
    el.textContent = '00:00:00';
    return;
  }
  const total = Math.floor(remaining / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  el.textContent = d > 0 ? `${d}h ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
}

async function fetchState() {
  const response = await fetch('/api/public/state', { cache: 'no-store' });
  if (!response.ok) throw new Error('gagal');
  return response.json();
}

async function refresh() {
  try {
    const data = await fetchState();
    setTimezone(data.timezone, data.tz_offset);
    state.data = data;
    state.offset = data.server_now - Date.now();
    apply();
    tick();
  } catch {
    setText('[data-status]', 'Menunggu koneksi');
  }
}

shell();
refresh();
setInterval(refresh, 3000);
setInterval(tick, 1000);
setInterval(() => {
  const count = notices().length;
  if (count > 1) {
    state.noticeIndex = (state.noticeIndex + 1) % count;
    renderNotice();
  }
}, 7000);
