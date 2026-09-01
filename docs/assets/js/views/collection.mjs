// What you actually own. Everything ticked here is what the deck builder is
// allowed to offer — apart from the one card per deck you borrow from a friend.

import { db } from '../store.mjs';
import { el, esc, on, skillPill, icon, debounce, readState, writeState } from '../ui.mjs';
import { cm, commitContext, toggleOwned, setOwned } from '../context.mjs';
import { STRATEGY } from '../model.mjs';

const TYPES = [['speed', 'Speed'], ['stamina', 'Stamina'], ['power', 'Power'], ['guts', 'Guts'], ['wit', 'Wit'], ['friend', 'Friend'], ['group', 'Group']];
const RARITIES = [[2, 'SSR'], [1, 'SR'], [0, 'R']];

export function renderCollection(root) {
  const saved = readState();
  const state = {
    tab: saved.tab === 'umas' ? 'umas' : 'cards',
    q: saved.q ?? '',
    type: null,
    rarity: null,
    strategy: null,
    showOwned: saved.own === '1',
  };

  const layout = el(`<div class="layout" style="grid-template-columns:minmax(0,1fr)">
    <section class="stack">
      <div class="page-head">
        <div>
          <h1>Collection</h1>
          <p>Tick what you own. The deck builder then offers only these, plus one borrowed card per deck.</p>
        </div>
        <div class="page-head__right" data-role="tools"></div>
      </div>
      <details class="explain">
        <summary>How the friend's card counts</summary>
        <p>A deck has six slots. With the restriction on, five of them come from what is ticked here and the sixth may be any card you do not own — the one borrowed from a friend.</p>
        <p>That slot is not a fixed position: the borrowed card can sit anywhere in the deck, the only limit is that there is one of them. In the card picker on the Team page, cards outside your collection are always listed and badged <i>friend</i>; once the borrow is spent they stay in the list but are disabled.</p>
      </details>
      <div data-role="bar"></div>
      <div data-role="body"></div>
    </section>
  </div>`);

  const tools = layout.querySelector('[data-role="tools"]');
  const bar = layout.querySelector('[data-role="bar"]');
  const body = layout.querySelector('[data-role="body"]');

  const useOwned = el(`<label class="check" style="align-items:center">
    <input type="checkbox" ${cm.useOwned ? 'checked' : ''}>
    <span>Restrict the deck builder to my collection</span>
  </label>`);
  useOwned.querySelector('input').addEventListener('change', (e) => {
    cm.useOwned = e.target.checked;
    commitContext();
  });
  tools.append(useOwned);

  function paint() {
    writeState({ tab: state.tab, q: state.q, own: state.showOwned ? '1' : '' });

    const ownedCards = cm.owned.cards.length;
    const ownedUmas = cm.owned.umas.length;

    bar.replaceChildren(el(`<div class="panel">
      <div class="panel__body" style="gap:10px">
        <div class="row" style="justify-content:space-between">
          <div class="seg" data-role="tab" style="max-width:320px">
            <button type="button" data-t="cards" aria-pressed="${state.tab === 'cards'}">Support cards <b>${ownedCards}</b></button>
            <button type="button" data-t="umas" aria-pressed="${state.tab === 'umas'}">Umas <b>${ownedUmas}</b></button>
          </div>
          <div class="row">
            <button class="btn btn--sm" data-act="all" type="button">Tick everything shown</button>
            <button class="btn btn--sm" data-act="none" type="button">Untick everything shown</button>
          </div>
        </div>
        <div class="row" style="gap:8px">
          <input class="input" data-role="q" type="search" placeholder="Search…" value="${esc(state.q)}" style="max-width:280px">
          <div class="toggle-grid" data-role="filters"></div>
          <label class="check" style="align-items:center;margin-left:auto">
            <input type="checkbox" data-role="showowned" ${state.showOwned ? 'checked' : ''}>
            <span>Only what I own</span>
          </label>
        </div>
      </div>
    </div>`));

    const filters = bar.querySelector('[data-role="filters"]');
    filters.innerHTML = state.tab === 'cards'
      ? [...RARITIES.map(([v, l]) => `<button type="button" data-f="r:${v}" aria-pressed="${state.rarity === v}">${l}</button>`),
        ...TYPES.map(([v, l]) => `<button type="button" data-f="t:${v}" aria-pressed="${state.type === v}">${l}</button>`)].join('')
      : Object.entries(STRATEGY).map(([v, s]) => `<button type="button" data-f="s:${v}" aria-pressed="${state.strategy === Number(v)}">${esc(s.name)}</button>`).join('');

    bar.querySelector('[data-role="q"]').addEventListener('input', debounce((e) => { state.q = e.target.value; paint(); }, 130));
    bar.querySelector('[data-role="showowned"]').addEventListener('change', (e) => { state.showOwned = e.target.checked; paint(); });

    const rows = visible();
    body.replaceChildren(el(`<div class="stack">
      <p class="small muted">${rows.length} shown, ${cm.owned[state.tab].length} owned in total</p>
      <div class="own-grid">${rows.map(tile).join('') || '<div class="empty">Nothing matches.</div>'}</div>
    </div>`));

  }

  // Registered once: `paint` replaces the children of these containers, not the
  // containers themselves, so delegation set up inside it would stack.
  on(bar, 'click', '[data-t]', (e, t) => { state.tab = t.dataset.t; paint(); });
  on(bar, 'click', '[data-f]', (e, t) => {
    const [kind, value] = t.dataset.f.split(':');
    if (kind === 'r') state.rarity = state.rarity === Number(value) ? null : Number(value);
    if (kind === 't') state.type = state.type === value ? null : value;
    if (kind === 's') state.strategy = state.strategy === Number(value) ? null : Number(value);
    paint();
  });
  on(bar, 'click', '[data-act="all"]', () => {
    setOwned(state.tab, [...cm.owned[state.tab], ...visible().map((r) => r.id)]);
    paint();
  });
  on(bar, 'click', '[data-act="none"]', () => {
    const drop = new Set(visible().map((r) => r.id));
    setOwned(state.tab, cm.owned[state.tab].filter((id) => !drop.has(id)));
    paint();
  });
  on(body, 'click', '[data-own]', (e, t) => {
    toggleOwned(state.tab, t.dataset.own);
    t.setAttribute('aria-pressed', String(cm.owned[state.tab].includes(t.dataset.own)));
    const tab = bar.querySelector(`[data-t="${state.tab}"]`);
    if (tab) tab.innerHTML = state.tab === 'cards' ? `Support cards <b>${cm.owned.cards.length}</b>` : `Umas <b>${cm.owned.umas.length}</b>`;
  });

  function visible() {
    const needle = state.q.trim().toLowerCase();
    if (state.tab === 'cards') {
      return db.supports.filter((c) => c.global
        && (!needle || c.name.toLowerCase().includes(needle))
        && (state.rarity === null || c.rarity === state.rarity)
        && (!state.type || c.type === state.type)
        && (!state.showOwned || cm.owned.cards.includes(c.id)));
    }
    return db.globalOutfits.filter((o) => (!needle || o.displayName.toLowerCase().includes(needle))
      && (!state.strategy || o.strategy === state.strategy)
      && (!state.showOwned || cm.owned.umas.includes(o.id)));
  }

  function tile(row) {
    const owned = cm.owned[state.tab].includes(row.id);
    const img = state.tab === 'cards' ? `./img/support/${esc(row.id)}.webp` : `./img/chara/${esc(row.id)}.webp`;
    const title = state.tab === 'cards' ? row.name : row.charaName;
    const sub = state.tab === 'cards' ? `${row.rarityName} ${row.typeName}` : row.epithet;
    return `<button class="own-tile" type="button" data-own="${esc(row.id)}" aria-pressed="${owned}">
      <img src="${img}" alt="" loading="lazy">
      <span class="own-tile__name">${esc(title)}</span>
      <span class="own-tile__sub">${esc(sub)}</span>
      <span class="own-tile__tick" aria-hidden="true">${icon('check', { size: 13 })}</span>
    </button>`;
  }

  paint();
  root.replaceChildren(layout);
}
