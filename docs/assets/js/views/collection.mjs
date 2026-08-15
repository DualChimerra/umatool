// Что у тебя реально есть. Отмеченное здесь — это то, что сборщик деки вправе
// предлагать; сверх того на каждую деку берётся одна карта друга.

import { db } from '../store.mjs';
import { el, esc, on, skillPill, debounce, readState, writeState } from '../ui.mjs';
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
          <h1>Коллекция</h1>
          <p>Отметь, что у тебя есть. Тогда сборщик деки предлагает только это — плюс одну карту друга на каждую деку.</p>
        </div>
        <div class="page-head__right" data-role="tools"></div>
      </div>
      <details class="explain">
        <summary>Как считается карта друга</summary>
        <p>В деке шесть слотов. При включённом ограничении пять карт берутся из отмеченных здесь, а шестой картой можно поставить любую чужую — ту, что берётся у друга.</p>
        <p>Слот друга не фиксирован: чужая карта может стоять на любом месте, ограничение только одно — такая карта в деке одна. В выборе карт на странице «Команда» чужие карты видны всегда и помечены значком «друг»; когда место друга занято, они остаются в списке, но недоступны.</p>
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
    <span>Ограничить сборщик деки моей коллекцией</span>
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
            <button type="button" data-t="cards" aria-pressed="${state.tab === 'cards'}">Карты · ${ownedCards}</button>
            <button type="button" data-t="umas" aria-pressed="${state.tab === 'umas'}">Умы · ${ownedUmas}</button>
          </div>
          <div class="row">
            <button class="btn btn--sm" data-act="all" type="button">Отметить всё видимое</button>
            <button class="btn btn--sm" data-act="none" type="button">Снять со всего видимого</button>
          </div>
        </div>
        <div class="row" style="gap:8px">
          <input class="input" data-role="q" type="search" placeholder="Поиск…" value="${esc(state.q)}" style="max-width:280px">
          <div class="toggle-grid" data-role="filters"></div>
          <label class="check" style="align-items:center;margin-left:auto">
            <input type="checkbox" data-role="showowned" ${state.showOwned ? 'checked' : ''}>
            <span>Только моё</span>
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
      <p class="small muted">показано: ${rows.length} · отмечено всего: ${cm.owned[state.tab].length}</p>
      <div class="own-grid">${rows.map(tile).join('') || '<div class="empty">Ничего не найдено.</div>'}</div>
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
    if (tab) tab.textContent = state.tab === 'cards' ? `Карты · ${cm.owned.cards.length}` : `Умы · ${cm.owned.umas.length}`;
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
      <span class="own-tile__tick" aria-hidden="true">✓</span>
    </button>`;
  }

  paint();
  root.replaceChildren(layout);
}
