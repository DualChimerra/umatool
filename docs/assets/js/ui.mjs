// Small DOM helpers plus the shared skill pill / tooltip used everywhere.

import { db, skillIconUrl } from './store.mjs';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function on(root, event, selector, handler) {
  root.addEventListener(event, (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) handler(e, target);
  });
}

export function debounce(fn, ms = 140) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const fmt = {
  signed: (n, digits = 2) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}`,
  int: (n) => Math.round(n).toLocaleString('en-US'),
  pct: (n) => `${Math.round(n * 100)}%`,
};

export const TIER_LABEL = { normal: 'Normal', gold: 'Gold', unique: 'Unique', evolved: 'Evolved' };

// Course data spells the turn as Left / Right / Straight. "Straight-handed" is
// not a thing, so the suffix is part of the lookup rather than appended blindly.
const TURN_LABEL = { Left: 'left-handed', Right: 'right-handed', Straight: 'straight' };
export const turnLabel = (turnName) => TURN_LABEL[turnName] ?? turnName;

/** Each effect of a skill as its own readable phrase. */
export function effectParts(skill) {
  return (skill.effects ?? []).map((e) => {
    if (e.kind === 'stat') return `${e.label} ${fmt.signed(e.value, 0)}`;
    if (e.unit === 'm/s' || e.unit === 'm/s²') return `${e.label} ${fmt.signed(e.value, 2)}${e.unit}`;
    if (e.unit) return `${e.label} ${fmt.signed(e.value, 1)}${e.unit === '% max HP' ? '%' : e.unit}`;
    return `${e.label} ${fmt.signed(e.value, 2)}`;
  });
}

/** One-line summary of what a skill actually does. */
export function effectSummary(skill) {
  const parts = effectParts(skill);
  return parts.length ? parts.join(', ') : '—';
}

/** The same phrases as separate tags, for anywhere with room to lay them out. */
export function effectTags(skill) {
  return effectParts(skill).map((t) => `<span class="etag">${esc(t)}</span>`).join('');
}

export function skillPill(skill, { tag = null, match = false, dim = false, count = null } = {}) {
  if (!skill) return '';
  const cls = [
    'skill',
    skill.tier !== 'normal' ? `skill--${skill.tier}` : '',
    match ? 'skill--match' : '',
    dim ? 'skill--dim' : '',
  ].filter(Boolean).join(' ');
  return `<button type="button" class="${cls}" data-skill="${esc(skill.id)}">
    <img src="${skillIconUrl(skill)}" alt="" loading="lazy" width="22" height="22">
    <span class="skill__name">${esc(skill.name)}</span>
    ${tag ? `<span class="skill__tag">${esc(tag)}</span>` : ''}
    ${count != null ? `<span class="sk-count">${count}</span>` : ''}
  </button>`;
}

/* ------------------------------------------------------------------- icons */

/**
 * A small stroked icon set, inline so it inherits colour and needs no request.
 *
 * These replace the typographic stand-ins the interface used to lean on — an
 * up-down arrow for sort, a triangle for a disclosure, a multiplication sign for
 * close. Glyphs render at whatever weight and baseline the font feels like,
 * which is why they never sat straight next to text.
 */
const ICONS = {
  sort: '<path d="M7 4v16m0 0-3-3.5M7 20l3-3.5M17 20V4m0 0-3 3.5M17 4l3 3.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m4 12 5.5 5.5L20 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  spark: '<path d="M12 3v4m0 10v4M3 12h4m10 0h4M5.6 5.6l2.8 2.8m7.2 7.2 2.8 2.8m0-12.8-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
  flag: '<path d="M5 21V4m0 0h11l-2 4 2 4H5"/>',
  gauge: '<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm1.5-3.5L18 7M4 19a9 9 0 1 1 16 0"/>',
  clock: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3.5 2"/>',
  route: '<path d="M6 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm12-11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm0 2.5v1a4 4 0 0 1-4 4h-4a4 4 0 0 0-4 4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm9 11-9 5-9-5"/>',
  warn: '<path d="M12 9v4m0 3h.01M10.3 4.3 2.6 17.6A2 2 0 0 0 4.3 21h15.4a2 2 0 0 0 1.7-3.4L13.7 4.3a2 2 0 0 0-3.4 0Z"/>',
  info: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-9v5m0-8h.01"/>',
};

export function icon(name, { size = 16, cls = '' } = {}) {
  const body = ICONS[name];
  if (!body) return '';
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false">${body}</svg>`;
}

/* --------------------------------------------------------- skill analytics */

const PART_COLOR = {
  speed: 'var(--accent)',
  accel: 'var(--gold)',
  recovery: 'var(--turf)',
  stat: 'var(--unique)',
  utility: 'var(--ink-3)',
};
export const PART_NAME = {
  speed: 'Speed', accel: 'Acceleration', recovery: 'Recovery', stat: 'Stat boost', utility: 'Utility',
};

/**
 * Where the number came from. A skill worth 1.4 lengths made entirely of
 * acceleration is a different thing from one made of raw speed, and the ranking
 * column alone cannot say which.
 */
export function valueBar(parts) {
  const entries = Object.entries(parts ?? {}).filter(([, v]) => v > 0);
  if (!entries.length) return '';
  const total = entries.reduce((n, [, v]) => n + v, 0);
  return `<span class="vbar" role="img" aria-label="${esc(entries.map(([k, v]) => `${PART_NAME[k] ?? k} ${Math.round((v / total) * 100)}%`).join(', '))}">
    ${entries.map(([k, v]) => `<i style="width:${((v / total) * 100).toFixed(1)}%;background:${PART_COLOR[k] ?? 'var(--ink-3)'}"></i>`).join('')}
  </span>`;
}

/**
 * A skill drawn against the course: the stretch it is eligible on, and the
 * stretch the effect is actually live over.
 */
export function skillTrack(firing, course, { height = 20, showPhases = true } = {}) {
  if (!firing) return '';
  const W = 300;
  const x = (m) => (m / course.distance) * W;
  const mid = height / 2;
  const eligible = firing.eligible
    .map(([a, b]) => `<rect x="${x(a).toFixed(1)}" y="${mid - 4}" width="${Math.max(1, x(b) - x(a)).toFixed(1)}" height="8" rx="2" fill="var(--line-strong)"/>`)
    .join('');
  const phases = showPhases
    ? [course.distance / 6, (course.distance * 2) / 3]
      .map((m) => `<line x1="${x(m).toFixed(1)}" y1="1" x2="${x(m).toFixed(1)}" y2="${height - 1}" stroke="var(--line-soft)" stroke-width="1"/>`)
      .join('')
    : '';
  // An instant effect — recovery, a stat boost — occupies no stretch of track, so
  // it is drawn as a marker rather than a bar three pixels wide pretending to be one.
  const w = x(firing.end) - x(firing.start);
  const live = w < 3
    ? `<rect x="${(x(firing.start) - 1.5).toFixed(1)}" y="${mid - 7}" width="3" height="14" rx="1.5" fill="var(--accent)"/>`
    : `<rect x="${x(firing.start).toFixed(1)}" y="${mid - 6}" width="${w.toFixed(1)}" height="12" rx="3" fill="var(--accent)"/>`;
  return `<svg class="strack" viewBox="0 0 ${W} ${height}" preserveAspectRatio="none" role="img"
    aria-label="Fires from ${Math.round(firing.start)} to ${Math.round(firing.end)} metres">
    ${phases}${eligible}${live}
  </svg>`;
}

/* ------------------------------------------------------- missing artwork */

/**
 * Not every card in the data set has artwork. The icon build only generates
 * images for cards released on Global, so the 200-odd Japan-only cards the
 * Support cards page can show — and any card whose source PNG the build could
 * not find — used to render as the browser's broken-image glyph.
 *
 * `error` does not bubble, so this listens in the capture phase and marks the
 * element instead; the CSS then draws a neutral tile in its place. One listener
 * covers every image in the app, including ones rendered later.
 */
export function initImageFallback(root = document) {
  root.addEventListener('error', (e) => {
    const img = e.target;
    if (img?.tagName !== 'IMG' || img.dataset.fallback) return;
    img.dataset.fallback = '1';
    img.classList.add('img--missing');
    // Stop the request being retried, and free the alt text to show through.
    img.removeAttribute('src');
  }, true);
}

/* ------------------------------------------------------------------ tooltip */

const tip = () => document.getElementById('tooltip');

function tooltipHtml(skill) {
  const cond = skill.variants.map((v) => `<div>${esc(v.text)}</div>`).join('');
  const sources = skill.sources || { characters: [], event: [], hint: [], unique: [] };
  const where = [
    sources.unique.length ? `${sources.unique.length} uma unique` : '',
    sources.characters.length ? `${sources.characters.length} uma skill lists` : '',
    sources.event.length ? `${sources.event.length} card events` : '',
    sources.hint.length ? `${sources.hint.length} card hints` : '',
  ].filter(Boolean).join(', ') || 'Not obtainable from cards or umas';

  return `<h5>${esc(skill.name)}</h5>
    <div class="chips" style="margin-bottom:6px">
      <span class="chip chip--${skill.tier === 'normal' ? '' : skill.tier}">${TIER_LABEL[skill.tier]}</span>
      ${skill.cost ? `<span class="chip">${skill.cost} SP</span>` : ''}
      ${skill.duration ? `<span class="chip">${skill.duration}s base</span>` : ''}
      ${skill.wisdomCheck ? '<span class="chip">Wit check</span>' : ''}
    </div>
    <div>${esc(effectSummary(skill))}</div>
    <div class="muted" style="margin-top:6px">${cond}</div>
    <div class="muted tiny" style="margin-top:6px">${esc(where)}</div>`;
}

export function initTooltips(root = document.body) {
  const show = (e, target) => {
    const skill = db.skillById.get(target.dataset.skill);
    if (!skill) return;
    const t = tip();
    t.innerHTML = tooltipHtml(skill);
    t.hidden = false;
    position(t, target);
  };
  const hide = () => { tip().hidden = true; };

  on(root, 'pointerenter', '[data-skill]', show);
  on(root, 'focusin', '[data-skill]', show);
  on(root, 'pointerleave', '[data-skill]', hide);
  on(root, 'focusout', '[data-skill]', hide);
  window.addEventListener('scroll', hide, true);
}

function position(t, target) {
  const r = target.getBoundingClientRect();
  const box = t.getBoundingClientRect();
  let top = r.bottom + 8;
  if (top + box.height > window.innerHeight - 8) top = Math.max(8, r.top - box.height - 8);
  let left = r.left;
  if (left + box.width > window.innerWidth - 8) left = window.innerWidth - box.width - 8;
  t.style.top = `${top}px`;
  t.style.left = `${Math.max(8, left)}px`;
}

/* -------------------------------------------------------------- url state */

export function readState() {
  const q = location.hash.split('?')[1] ?? '';
  return Object.fromEntries(new URLSearchParams(q));
}

export function writeState(patch) {
  const [route] = location.hash.split('?');
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '' || v === false) params.delete(k);
    else params.set(k, String(v));
  }
  const q = params.toString();
  history.replaceState(null, '', `${route}${q ? `?${q}` : ''}`);
}
