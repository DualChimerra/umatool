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

/* ------------------------------------------------------------- collapsing */

const OPEN_KEY = 'paddock:open';

function openState() {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY) || '{}'); } catch { return {}; }
}

/**
 * Make a rail panel fold away at its header.
 *
 * The rail carries four or five panels now, and on a laptop that is more than
 * one screen of controls sitting inside a sticky column — which is exactly the
 * shape that ends up with half of it unreachable. Folding the ones you are not
 * using is the fix, and which ones you folded is remembered.
 */
export function collapsible(panel, key, { open = true } = {}) {
  const state = openState();
  const isOpen = state[key] ?? open;
  panel.classList.add('panel--fold');
  panel.classList.toggle('is-closed', !isOpen);

  const head = panel.querySelector('.panel__head');
  if (!head || head.querySelector('.fold-btn')) return panel;
  const btn = el(`<button class="fold-btn" type="button" aria-expanded="${isOpen}" aria-label="Collapse section">
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>`);
  head.append(btn);
  head.addEventListener('click', (e) => {
    if (e.target.closest('button:not(.fold-btn), input, select, a')) return;
    const next = panel.classList.toggle('is-closed');
    btn.setAttribute('aria-expanded', String(!next));
    const all = openState();
    all[key] = !next;
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(all)); } catch { /* ignore */ }
  });
  return panel;
}
