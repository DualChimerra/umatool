import { db } from '../store.mjs';
import { el, esc, on, skillPill, icon, readState, writeState, collapsible } from '../ui.mjs';
import { createSkillFilter, toggleGroup, searchField, selectField } from '../filters.mjs';

const TYPES = [
  ['speed', 'Speed'], ['stamina', 'Stamina'], ['power', 'Power'],
  ['guts', 'Guts'], ['wit', 'Wit'], ['friend', 'Friend'], ['group', 'Group'],
];
const RARITIES = [[2, 'SSR'], [1, 'SR'], [0, 'R']];

const SORTS = [
  { value: 'match', label: 'Matched skills' },
  { value: 'rarity', label: 'Rarity' },
  { value: 'name', label: 'Name' },
  { value: 'gold', label: 'Gold hints' },
  { value: 'hints', label: 'Hint count' },
  { value: 'score', label: 'Total hint score' },
  { value: 'newest', label: 'Card number' },
];

export function renderCards(root) {
  const saved = readState();
  const state = {
    q: saved.q ?? '',
    types: saved.t ? saved.t.split(',') : [],
    rarities: saved.r ? saved.r.split(',').map(Number) : [],
    where: saved.w ?? 'any', // any | event | hint
    globalOnly: saved.g !== '0',
    hideUnverified: saved.uv === '1',
    sort: saved.sort ?? 'match',
    dir: saved.dir ?? 'desc',
  };

  const skillFilter = createSkillFilter({
    label: 'Filter by skills',
    hint: 'Find the cards that carry a skill — the badge on each pill says whether it comes from the card event or from a random hint.',
    onChange: () => paint(),
  });

  const layout = el(`<div class="layout">
    <aside class="rail"></aside>
    <section>
      <div class="page-head">
        <div>
          <h1>Support cards</h1>
          <p>Every Global support card indexed by the skills it hands out — event skills and hint skills kept apart.</p>
        </div>
        <div class="page-head__right" data-role="sortbar"></div>
      </div>
      <div data-role="count" class="small muted" style="margin-bottom:10px"></div>
      <div class="grid grid--cards" data-role="grid"></div>
    </section>
  </div>`);

  const rail = layout.querySelector('.rail');
  const grid = layout.querySelector('[data-role="grid"]');
  const count = layout.querySelector('[data-role="count"]');

  const basics = el('<section class="panel"><div class="panel__body"></div></section>');
  const body = basics.querySelector('.panel__body');
  body.append(
    searchField({ placeholder: 'Search card name…', value: state.q, onChange: (v) => { state.q = v; paint(); } }).element,
    toggleGroup({
      title: 'Card type',
      options: TYPES.map(([v, l]) => ({ value: v, label: l })),
      value: state.types,
      onChange: (v) => { state.types = v; paint(); },
    }).element,
    toggleGroup({
      title: 'Rarity',
      options: RARITIES.map(([v, l]) => ({ value: String(v), label: l })),
      value: state.rarities.map(String),
      onChange: (v) => { state.rarities = v.map(Number); paint(); },
    }).element,
  );

  const whereField = el(`<div class="field">
    <label>Skill has to come from</label>
    <div class="seg" data-role="where">
      <button type="button" data-w="any" aria-pressed="${state.where === 'any'}">Either</button>
      <button type="button" data-w="event" aria-pressed="${state.where === 'event'}">Event</button>
      <button type="button" data-w="hint" aria-pressed="${state.where === 'hint'}">Hint</button>
    </div>
  </div>`);
  on(whereField, 'click', 'button[data-w]', (e, t) => {
    state.where = t.dataset.w;
    whereField.querySelectorAll('button[data-w]').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    paint();
  });
  body.append(whereField);

  const globalToggle = el(`<label class="check">
    <input type="checkbox" ${state.globalOnly ? 'checked' : ''}>
    <span>Global releases only<small>Cards not yet on the Global server are hidden.</small></span>
  </label>`);
  globalToggle.querySelector('input').addEventListener('change', (e) => { state.globalOnly = e.target.checked; paint(); });
  const hideUnverified = el(`<label class="check">
    <input type="checkbox" ${state.hideUnverified ? 'checked' : ''}>
    <span>Hide unverified releases<small>Cards past the current Global frontier that only pass the automatic check because they reuse old skills.</small></span>
  </label>`);
  hideUnverified.querySelector('input').addEventListener('change', (e) => { state.hideUnverified = e.target.checked; paint(); });
  body.append(globalToggle, hideUnverified);

  rail.append(collapsible(basics, 'cards.basics'), collapsible(skillFilter.element, 'cards.skills'));

  const sortSel = selectField({ title: 'Sort by', options: SORTS, value: state.sort, onChange: (v) => { state.sort = v; paint(); } });
  const dirBtn = el(`<button class="btn btn--sm" type="button" title="Reverse order" aria-label="Reverse order">${icon('sort')}</button>`);
  dirBtn.addEventListener('click', () => { state.dir = state.dir === 'desc' ? 'asc' : 'desc'; paint(); });
  layout.querySelector('[data-role="sortbar"]').append(sortSel.element, dirBtn);

  function paint() {
    writeState({
      q: state.q,
      t: state.types.join(','),
      r: state.rarities.join(','),
      w: state.where === 'any' ? '' : state.where,
      g: state.globalOnly ? '' : '0',
      uv: state.hideUnverified ? '1' : '',
      sort: state.sort === 'match' ? '' : state.sort,
      dir: state.dir === 'desc' ? '' : state.dir,
    });

    const needle = state.q.trim().toLowerCase();
    const rows = [];

    for (const card of db.supports) {
      if (state.globalOnly && !card.global) continue;
      if (state.hideUnverified && card.unverified) continue;
      if (needle && !card.name.toLowerCase().includes(needle)) continue;
      if (state.types.length && !state.types.includes(card.type)) continue;
      if (state.rarities.length && !state.rarities.includes(card.rarity)) continue;

      const pool = state.where === 'event' ? card.eventSkills
        : state.where === 'hint' ? card.hintSkills
          : [...card.eventSkills, ...card.hintSkills];
      const test = skillFilter.test(pool);
      if (!test.ok) continue;

      const hints = card.hintSkills.map((id) => db.skillById.get(id)).filter(Boolean);
      const events = card.eventSkills.map((id) => db.skillById.get(id)).filter(Boolean);

      rows.push({
        card, hints, events,
        hits: new Set([...test.hits.values()].flat()),
        matches: test.hits.size,
        gold: [...hints, ...events].filter((s) => s.tier === 'gold').length,
        score: [...hints, ...events].reduce((n, s) => n + (s.score || 0), 0),
      });
    }

    const dir = state.dir === 'desc' ? -1 : 1;
    const byName = (a, b) => a.card.name.localeCompare(b.card.name) || a.card.id.localeCompare(b.card.id);
    rows.sort((a, b) => {
      switch (state.sort) {
        case 'name': return dir * -byName(a, b);
        case 'rarity': return dir * (a.card.rarity - b.card.rarity) || byName(a, b);
        case 'gold': return dir * (a.gold - b.gold) || byName(a, b);
        case 'hints': return dir * (a.hints.length - b.hints.length) || byName(a, b);
        case 'score': return dir * (a.score - b.score) || byName(a, b);
        case 'newest': return dir * (a.card.seq - b.card.seq) || byName(a, b);
        default: return dir * (a.matches - b.matches) || (b.card.rarity - a.card.rarity) || byName(a, b);
      }
    });

    count.textContent = `${rows.length} card${rows.length === 1 ? '' : 's'}`
      + (skillFilter.active ? ` matching ${skillFilter.state.ids.length} skill${skillFilter.state.ids.length === 1 ? '' : 's'}` : '');
    grid.innerHTML = rows.length ? rows.map(cardHtml).join('') : '<div class="empty">No support card matches these filters.</div>';
  }

  function cardHtml({ card, hints, events, hits }) {
    const pills = (list, tag) => list.map((s) => skillPill(s, { tag, match: hits.has(s.id) })).join('');
    const goldHints = hints.filter((s) => s.tier === 'gold');
    const normalHints = hints.filter((s) => s.tier !== 'gold');

    return `<article class="card">
      <div class="card__head">
        <img class="card__art" src="./img/support/${esc(card.id)}.webp" alt="" loading="lazy" width="58" height="58">
        <div class="card__title">
          <h3>${esc(card.name)}</h3>
          <div class="card__meta">
            <span class="chip chip--accent">${esc(card.rarityName)}</span>
            <span class="chip">${esc(card.typeName)}</span>
            <span class="chip">#${esc(card.id)}</span>
            ${card.global ? '' : '<span class="chip chip--warn">Not on Global</span>'}
            ${card.unverified ? '<span class="chip chip--warn" title="Passes the skill-set check but sits past the current Global release frontier — treat with suspicion until the GameTora pass confirms it">unverified</span>' : ''}
          </div>
        </div>
      </div>
      <div class="card__body">
        ${events.length ? `<div class="card__section">
          <h4>Event skills <span class="sk-count">${events.length}</span></h4>
          <div class="chips">${pills(events, 'event')}</div>
        </div>` : ''}
        ${goldHints.length ? `<div class="card__section">
          <h4>Gold hints <span class="sk-count">${goldHints.length}</span></h4>
          <div class="chips">${pills(goldHints, 'hint')}</div>
        </div>` : ''}
        ${normalHints.length ? `<div class="card__section">
          <h4>Hints <span class="sk-count">${normalHints.length}</span></h4>
          <div class="chips">${pills(normalHints, 'hint')}</div>
        </div>` : ''}
        ${!events.length && !hints.length ? '<p class="tiny muted">This card teaches no skills.</p>' : ''}
      </div>
    </article>`;
  }

  paint();
  root.replaceChildren(layout);
}
