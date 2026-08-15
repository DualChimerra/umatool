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

/** One-line summary of what a skill actually does. */
export function effectSummary(skill) {
  if (!skill.effects.length) return '—';
  return skill.effects.map((e) => {
    if (e.kind === 'stat') return `${e.label} ${fmt.signed(e.value, 0)}`;
    if (e.unit === 'm/s' || e.unit === 'm/s²') return `${e.label} ${fmt.signed(e.value, 2)}${e.unit}`;
    if (e.unit) return `${e.label} ${fmt.signed(e.value, 1)}${e.unit === '% max HP' ? '%' : e.unit}`;
    return `${e.label} ${fmt.signed(e.value, 2)}`;
  }).join(' · ');
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
  ].filter(Boolean).join(' · ') || 'Not obtainable from cards or umas';

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
