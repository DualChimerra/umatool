// The multi-skill picker shared by the Umas, Support cards and Skills views.

import { db, expandSelection } from './store.mjs';
import { el, esc, on, debounce, skillOption } from './ui.mjs';
import { combobox } from './combobox.mjs';

const TIER_ORDER = { unique: 0, evolved: 1, gold: 2, normal: 3 };

export function createSkillFilter({ onChange, label = 'Skills', hint = '' } = {}) {
  const state = { ids: [], mode: 'all', otherRanks: true };

  const root = el(`
    <section class="panel">
      <div class="panel__head">
        <h3>${esc(label)}</h3>
        <button class="btn btn--ghost btn--sm" data-act="clear" type="button" hidden>Clear</button>
      </div>
      <div class="panel__body">
        ${hint ? `<p class="tiny muted">${esc(hint)}</p>` : ''}
        <div data-role="search"></div>
        <div class="chips" data-role="picked"></div>
        <div class="seg" data-role="mode">
          <button type="button" data-mode="all" aria-pressed="true">Has all</button>
          <button type="button" data-mode="any" aria-pressed="false">Has any</button>
        </div>
        <label class="check">
          <input type="checkbox" data-role="ranks" checked>
          <span>Also match the other rank
            <small>A gold pick also matches its normal version — Determined Descent ⇄ Straight Descent.</small>
          </span>
        </label>
      </div>
    </section>`);

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

  const picker = combobox({
    placeholder: 'Search a skill…',
    search: (needle) => search(needle).filter((x) => !state.ids.includes(x.id)),
    row: skillOption,
    onPick: (skill) => { state.ids.push(skill.id); emit(); },
  });
  root.querySelector('[data-role="search"]').append(picker.element);

  function renderPicked() {
    picked.innerHTML = state.ids.map((id) => {
      const s = db.skillById.get(id);
      if (!s) return '';
      const extra = state.otherRanks
        ? (db.skillsByGroup.get(s.groupId) ?? []).filter((x) => x.id !== id && !x.inherited).length
        : 0;
      return `<span class="chip chip--${s.tier === 'normal' ? '' : s.tier}">
        ${esc(s.name)}${extra ? `<span class="tiny muted">+${extra}</span>` : ''}
        <span class="chip__x" data-remove="${esc(id)}" role="button" aria-label="Remove">×</span>
      </span>`;
    }).join('');
    clearBtn.hidden = state.ids.length === 0;
  }

  function emit() { renderPicked(); onChange?.(api); }

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
