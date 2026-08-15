// The multi-skill picker shared by the Umas, Support cards and Skills views.

import { db, expandSelection } from './store.mjs';
import { el, esc, on, debounce, skillPill, TIER_LABEL } from './ui.mjs';

const TIER_ORDER = { unique: 0, evolved: 1, gold: 2, normal: 3 };

export function createSkillFilter({ onChange, label = 'Скиллы', hint = '' } = {}) {
  const state = { ids: [], mode: 'all', otherRanks: true, query: '' };

  const root = el(`
    <section class="panel">
      <div class="panel__head">
        <h3>${esc(label)}</h3>
        <button class="btn btn--ghost btn--sm" data-act="clear" type="button" hidden>Очистить</button>
      </div>
      <div class="panel__body">
        ${hint ? `<p class="tiny muted">${esc(hint)}</p>` : ''}
        <div class="field" style="position:relative">
          <input class="input" type="search" data-role="q" placeholder="Поиск скилла, например Determined Descent" autocomplete="off">
          <div data-role="results" class="panel" style="position:fixed;z-index:60;max-height:300px;overflow:auto;box-shadow:var(--shadow-md)" hidden></div>
        </div>
        <div class="chips" data-role="picked"></div>
        <div class="seg" data-role="mode">
          <button type="button" data-mode="all" aria-pressed="true">Все сразу</button>
          <button type="button" data-mode="any" aria-pressed="false">Любой из них</button>
        </div>
        <label class="check">
          <input type="checkbox" data-role="ranks" checked>
          <span>Засчитывать и другой ранг
            <small>Золотой скилл совпадёт и со своей обычной версией — Determined Descent ⇄ Straight Descent.</small>
          </span>
        </label>
      </div>
    </section>`);

  const q = root.querySelector('[data-role="q"]');
  const results = root.querySelector('[data-role="results"]');
  const picked = root.querySelector('[data-role="picked"]');
  const clearBtn = root.querySelector('[data-act="clear"]');

  function search(text) {
    const needle = text.trim().toLowerCase();
    if (!needle) return [];
    const scored = [];
    for (const s of db.learnable) {
      const name = s.name.toLowerCase();
      const at = name.indexOf(needle);
      if (at < 0) continue;
      scored.push([at === 0 ? 0 : 1, TIER_ORDER[s.tier] ?? 9, name.length, s]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    return scored.slice(0, 24).map((x) => x[3]);
  }

  function renderResults() {
    const list = search(state.query);
    if (!list.length) { results.hidden = true; results.innerHTML = ''; return; }
    results.innerHTML = list.map((s) => `
      <button type="button" class="rank-row" data-add="${esc(s.id)}" style="width:100%;text-align:left;border:0;background:transparent;cursor:pointer;grid-template-columns:minmax(0,1fr) auto">
        <span>
          <span style="font-weight:500">${esc(s.name)}</span>
          <span class="rank-row__why">${esc(s.variants[0]?.text ?? '')}</span>
        </span>
        <span class="chip chip--${s.tier === 'normal' ? '' : s.tier}">${TIER_LABEL[s.tier]}</span>
      </button>`).join('');
    results.hidden = false;
    placeResults();
  }

  // The rail scrolls, so an absolutely positioned dropdown would be clipped by
  // it. Pin the list to the viewport instead and track the input.
  function placeResults() {
    if (results.hidden) return;
    const r = q.getBoundingClientRect();
    results.style.left = `${r.left}px`;
    results.style.width = `${r.width}px`;
    const below = window.innerHeight - r.bottom - 12;
    if (below < 180 && r.top > below) {
      results.style.top = 'auto';
      results.style.bottom = `${window.innerHeight - r.top + 4}px`;
      results.style.maxHeight = `${r.top - 16}px`;
    } else {
      results.style.bottom = 'auto';
      results.style.top = `${r.bottom + 4}px`;
      results.style.maxHeight = `${Math.max(140, below)}px`;
    }
  }

  function renderPicked() {
    picked.innerHTML = state.ids.map((id) => {
      const s = db.skillById.get(id);
      if (!s) return '';
      const extra = state.otherRanks
        ? (db.skillsByGroup.get(s.groupId) ?? []).filter((x) => x.id !== id && !x.inherited).length
        : 0;
      return `<span class="chip chip--${s.tier === 'normal' ? '' : s.tier}">
        ${esc(s.name)}${extra ? `<span class="tiny muted">+${extra}</span>` : ''}
        <span class="chip__x" data-remove="${esc(id)}" role="button" aria-label="Убрать">×</span>
      </span>`;
    }).join('');
    clearBtn.hidden = state.ids.length === 0;
  }

  function emit() { renderPicked(); onChange?.(api); }

  q.addEventListener('input', debounce(() => { state.query = q.value; renderResults(); }, 110));
  q.addEventListener('focus', renderResults);
  document.addEventListener('click', (e) => { if (!root.contains(e.target)) results.hidden = true; });
  window.addEventListener('resize', placeResults);
  window.addEventListener('scroll', placeResults, true);

  on(root, 'click', '[data-add]', (e, t) => {
    const id = t.dataset.add;
    if (!state.ids.includes(id)) state.ids.push(id);
    q.value = ''; state.query = ''; results.hidden = true;
    emit();
  });
  on(root, 'click', '[data-remove]', (e, t) => {
    state.ids = state.ids.filter((x) => x !== t.dataset.remove);
    emit();
  });
  on(root, 'click', '[data-mode] button', (e, t) => {
    state.mode = t.dataset.mode;
    root.querySelectorAll('[data-mode] button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    emit();
  });
  on(root, 'click', '[data-act="clear"]', () => { state.ids = []; emit(); });
  root.querySelector('[data-role="ranks"]').addEventListener('change', (e) => {
    state.otherRanks = e.target.checked;
    emit();
  });

  const api = {
    element: root,
    state,
    get active() { return state.ids.length > 0; },
    /** ids that count as a hit, mapped back to the skill the user picked */
    expanded() { return expandSelection(state.ids, state.otherRanks); },
    /**
     * @param {Iterable<string>} skillIds  the skills an uma/card actually has
     * @returns {{ok: boolean, hits: Map<string, string[]>}}
     */
    test(skillIds) {
      if (!state.ids.length) return { ok: true, hits: new Map() };
      const expanded = this.expanded();
      const owned = new Set(skillIds);
      const hits = new Map();
      for (const [id, info] of expanded) {
        if (!owned.has(id)) continue;
        if (!hits.has(info.root)) hits.set(info.root, []);
        hits.get(info.root).push(id);
      }
      const ok = state.mode === 'all' ? hits.size === state.ids.length : hits.size > 0;
      return { ok, hits };
    },
    setSelection(ids) { state.ids = ids.filter((id) => db.skillById.has(id)); emit(); },
  };

  renderPicked();
  return api;
}

/* ------------------------------------------------------------- tiny widgets */

export function toggleGroup({ title, options, value = [], onChange, multi = true }) {
  const root = el(`<div class="field">
    <label>${esc(title)}</label>
    <div class="toggle-grid"></div>
  </div>`);
  const grid = root.querySelector('.toggle-grid');
  const selected = new Set(value);

  const paint = () => {
    grid.innerHTML = options.map((o) => `
      <button type="button" data-v="${esc(o.value)}" aria-pressed="${selected.has(o.value)}">${esc(o.label)}</button>
    `).join('');
  };
  paint();

  on(root, 'click', 'button[data-v]', (e, t) => {
    const v = t.dataset.v;
    if (!multi) { selected.clear(); selected.add(v); } else if (selected.has(v)) selected.delete(v); else selected.add(v);
    paint();
    onChange([...selected]);
  });

  return { element: root, get value() { return [...selected]; } };
}

export function selectField({ title, options, value, onChange }) {
  const root = el(`<div class="field">
    <label>${esc(title)}</label>
    <select class="select">${options.map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
  </div>`);
  root.querySelector('select').addEventListener('change', (e) => onChange(e.target.value));
  return { element: root, get el() { return root.querySelector('select'); } };
}

export function searchField({ placeholder, value = '', onChange }) {
  const root = el(`<div class="field"><input class="input" type="search" placeholder="${esc(placeholder)}" value="${esc(value)}"></div>`);
  root.querySelector('input').addEventListener('input', debounce((e) => onChange(e.target.value), 130));
  return { element: root };
}
