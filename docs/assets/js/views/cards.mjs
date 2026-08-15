import { db } from '../store.mjs';
import { el, esc, on, skillPill, readState, writeState } from '../ui.mjs';
import { createSkillFilter, toggleGroup, searchField, selectField } from '../filters.mjs';

const TYPES = [
  ['speed', 'Speed'], ['stamina', 'Stamina'], ['power', 'Power'],
  ['guts', 'Guts'], ['wit', 'Wit'], ['friend', 'Friend'], ['group', 'Group'],
];
const RARITIES = [[2, 'SSR'], [1, 'SR'], [0, 'R']];

const SORTS = [
  { value: 'match', label: 'Совпавшие скиллы' },
  { value: 'rarity', label: 'Редкость' },
  { value: 'name', label: 'Название' },
  { value: 'gold', label: 'Золотые хинты' },
  { value: 'hints', label: 'Число хинтов' },
  { value: 'score', label: 'Сумма очков хинтов' },
  { value: 'newest', label: 'Номер карты' },
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
    label: 'Фильтр по скиллам',
    hint: 'Найти карты, которые дают нужный скилл. Значок на пилюле говорит, приходит он с ивента карты или со случайного хинта.',
    onChange: () => paint(),
  });

  const layout = el(`<div class="layout">
    <aside class="rail"></aside>
    <section>
      <div class="page-head">
        <div>
          <h1>Карты поддержки</h1>
          <p>Все карты поддержки на Global, разложенные по скиллам, которые они дают: ивент-скиллы и хинты — отдельно.</p>
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
    searchField({ placeholder: 'Поиск по названию карты…', value: state.q, onChange: (v) => { state.q = v; paint(); } }).element,
    toggleGroup({
      title: 'Тип карты',
      options: TYPES.map(([v, l]) => ({ value: v, label: l })),
      value: state.types,
      onChange: (v) => { state.types = v; paint(); },
    }).element,
    toggleGroup({
      title: 'Редкость',
      options: RARITIES.map(([v, l]) => ({ value: String(v), label: l })),
      value: state.rarities.map(String),
      onChange: (v) => { state.rarities = v.map(Number); paint(); },
    }).element,
  );

  const whereField = el(`<div class="field">
    <label>Скилл должен приходить с</label>
    <div class="seg" data-role="where">
      <button type="button" data-w="any" aria-pressed="${state.where === 'any'}">Любого</button>
      <button type="button" data-w="event" aria-pressed="${state.where === 'event'}">Ивента</button>
      <button type="button" data-w="hint" aria-pressed="${state.where === 'hint'}">Хинта</button>
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
    <span>Только релизы Global<small>Карты, которых ещё нет на сервере Global, скрыты.</small></span>
  </label>`);
  globalToggle.querySelector('input').addEventListener('change', (e) => { state.globalOnly = e.target.checked; paint(); });
  const hideUnverified = el(`<label class="check">
    <input type="checkbox" ${state.hideUnverified ? 'checked' : ''}>
    <span>Скрыть непроверенные релизы<small>Карты за текущей границей Global, которые проходят автопроверку только потому, что переиспользуют старые скиллы.</small></span>
  </label>`);
  hideUnverified.querySelector('input').addEventListener('change', (e) => { state.hideUnverified = e.target.checked; paint(); });
  body.append(globalToggle, hideUnverified);

  rail.append(basics, skillFilter.element);

  const sortSel = selectField({ title: 'Сортировка', options: SORTS, value: state.sort, onChange: (v) => { state.sort = v; paint(); } });
  const dirBtn = el('<button class="btn btn--sm" type="button" title="Обратный порядок">↕</button>');
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

    count.textContent = `карт: ${rows.length}`
      + (skillFilter.active ? ` · совпадений по скиллам: ${skillFilter.state.ids.length}` : '');
    grid.innerHTML = rows.length ? rows.map(cardHtml).join('') : '<div class="empty">Под эти фильтры не подходит ни одна карта.</div>';
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
            ${card.global ? '' : '<span class="chip chip--warn">Нет на Global</span>'}
            ${card.unverified ? '<span class="chip chip--warn" title="Проходит проверку по набору скиллов, но находится за текущей границей релизов Global — верить с осторожностью, пока не подтвердит проход по GameTora">не проверено</span>' : ''}
          </div>
        </div>
      </div>
      <div class="card__body">
        ${events.length ? `<div class="card__section">
          <h4>Ивент-скиллы <span class="sk-count">${events.length}</span></h4>
          <div class="chips">${pills(events, 'ивент')}</div>
        </div>` : ''}
        ${goldHints.length ? `<div class="card__section">
          <h4>Золотые хинты <span class="sk-count">${goldHints.length}</span></h4>
          <div class="chips">${pills(goldHints, 'хинт')}</div>
        </div>` : ''}
        ${normalHints.length ? `<div class="card__section">
          <h4>Хинты <span class="sk-count">${normalHints.length}</span></h4>
          <div class="chips">${pills(normalHints, 'хинт')}</div>
        </div>` : ''}
        ${!events.length && !hints.length ? '<p class="tiny muted">Эта карта не даёт скиллов.</p>' : ''}
      </div>
    </article>`;
  }

  paint();
  root.replaceChildren(layout);
}
