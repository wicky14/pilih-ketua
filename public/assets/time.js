// Satu sumber waktu untuk voter, admin, dan layar publik.
// Zona diambil dari state server (env TZ), bukan dari browser pemakai.

const FALLBACK_ZONE = 'Asia/Jakarta';
const FALLBACK_OFFSET = 7 * 3600;

let timezone = FALLBACK_ZONE;
let tzOffset = FALLBACK_OFFSET;

export function setTimezone(name, offsetSeconds) {
  if (typeof name === 'string' && name.trim()) timezone = name.trim();
  if (Number.isFinite(offsetSeconds)) tzOffset = offsetSeconds;
}

export function getTimezone() {
  return timezone;
}

function zoneParts(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
  };
}

export function formatDate(ms) {
  if (!ms) return '—';
  try {
    return new Intl.DateTimeFormat('id-ID', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(new Date(ms));
  } catch {
    const d = new Date(ms + tzOffset * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
}

// Nilai untuk input datetime-local: wall-clock di zona server, bukan zona browser.
export function toLocalInput(ms) {
  if (!ms) return '';
  try {
    const p = zoneParts(ms);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  } catch {
    return new Date(ms + tzOffset * 1000).toISOString().slice(0, 16);
  }
}

// Balikkan wall-clock datetime-local menjadi epoch ms di zona server.
export function fromLocalInput(value) {
  if (!value) return null;
  const wall = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(wall)) return null;

  let guess = wall - tzOffset * 1000;
  for (let i = 0; i < 4; i += 1) {
    const rendered = toLocalInput(guess);
    if (!rendered) return null;
    const actualWall = Date.parse(`${rendered}:00Z`);
    const diff = wall - actualWall;
    if (!Number.isFinite(diff) || diff === 0) break;
    guess += diff;
  }
  return Number.isFinite(guess) ? guess : null;
}

export function timezoneLabel() {
  try {
    const parts = new Intl.DateTimeFormat('id-ID', {
      timeZone: timezone,
      timeZoneName: 'short',
    }).formatToParts(new Date());
    return parts.find((part) => part.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
}
