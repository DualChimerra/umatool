import { db } from '../store.mjs';
import { el, esc, on, skillPill, effectSummary, readState, writeState } from '../ui.mjs';
import { createSkillFilter, toggleGroup, searchField, selectField } from '../filters.mjs';
import { STRATEGY } from '../model.mjs';

const APT = [
  ['sprint', 'Spr', 'Sprint'], ['mile', 'Mil', 'Mile'], ['medium', 'Med', 'Medium'], ['long', 'Lng', 'Long'],
  ['front', 'Frt', 'Front Runner'], ['pace', 'Pce', 'Pace Chaser'], ['late', 'Lte', 'Late Surger'], ['end', 'End', 'End Closer'],
  ['turf', 'Trf', 'Turf'], ['dirt', 'Drt', 'Dirt'],
];
const GRADES = ['-', 'G', 'F', 'E', 'D', 'C', 'B', 'A', 'S'];

const SORTS = [
  { value: 'name', label: 'Имя' },
  { value: 'stars', label: 'Редкость ★' },
  { value: 'gold', label: 'Золото в списке' },
  { value: 'score', label: 'Сумма очков скиллов' },
  // В сетке аптитюдов ячейки узкие, поэтому там сокращения; в выпадающем списке
  // места хватает на полное название из игры.
  ...APT.map(([k, , full]) => ({ value: `apt:${k}`, label: `Аптитюд · ${full}` })),
];

export function renderUmas(root) {
  const saved = readState();
  const state = {
    q: saved.q ?? '',
    strategies: saved.st ? saved.st.split(',').map(Number) : [],
    stars: saved.stars ? saved.stars.split(',').map(Number) : [],
    apt: JSON.parse(saved.apt ?? '{}'),
    sort: saved.sort ?? 'name',
    dir: saved.dir ?? 'desc',
  };

  const skillFilter = createSkillFilter({
    label: 'Фильтр по скиллам',
    hint: 'Выбери скиллы, которые должны быть в собственном списке умы (уники тоже считаются).',
    onChange: () => paint(),
  });

  const layout = el(`<div class="layout">
    <aside class="rail"></aside>
    <section>
      <div class="page-head">
        <div>
          <h1>Умы</h1>
          <p>Все умы на Global с полным списком скиллов, аптитюдами и стилем бега.</p>
        </div>
        <div class="page-head__right" data-role="sortbar"></div>
      </div>
      <div data-role="count" class="small muted" style="margin-bottom:10px"></div>
      <div class="grid grid--umas" data-role="grid"></div>
    </section>
  </div>`);

  const rail = layout.querySelector('.rail');
  const grid = layout.querySelector('[data-role="grid"]');
  const count = layout.querySelector('[data-role="count"]');
  const sortbar = layout.querySelector('[data-role="sortbar"]');

  const basics = el(`<section class="panel"><div class="panel__body"></div></section>`);
  const basicsBody = basics.querySelector('.panel__body');
  basicsBody.append(
    searchField({ placeholder: 'Поиск по уме или наряду…', value: state.q, onChange: (v) => { state.q = v; paint(); } }).element,
    toggleGroup({
      title: 'Стиль бега',
      options: Object.entries(STRATEGY).map(([v, s]) => ({ value: v, label: s.name })),
      value: state.strategies.map(String),
      onChange: (v) => { state.strategies = v.map(Number); paint(); },
    }).element,
    toggleGroup({
      title: 'Редкость',
      options: [1, 2, 3].map((n) => ({ value: String(n), label: '★'.repeat(n) })),
      value: state.stars.map(String),
      onChange: (v) => { state.stars = v.map(Number); paint(); },
    }).element,
  );

  const aptPanel = el(`<section class="panel">
    <div class="panel__head"><h3>Минимальный аптитюд</h3><button class="btn btn--ghost btn--sm" data-act="apt-clear" type="button">Сброс</button></div>
    <div class="panel__body" style="display:grid;grid-template-columns:1fr 1fr;gap:7px"></div>
  </section>`);
  const aptBody = aptPanel.querySelector('.panel__body');
  const paintApt = () => {
    aptBody.innerHTML = APT.map(([key, label]) => `
      <label class="field" style="gap:3px">
        <span style="font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-3)">${esc(label)}</span>
        <select class="select" data-apt="${key}">
          ${GRADES.map((g, i) => `<option value="${i}"${(state.apt[key] ?? 0) === i ? ' selected' : ''}>${g}</option>`).join('')}
        </select>
      </label>`).join('');
  };
  paintApt();
  on(aptPanel, 'change', 'select[data-apt]', (e, t) => {
    const v = Number(t.value);
    if (v) state.apt[t.dataset.apt] = v; else delete state.apt[t.dataset.apt];
    paint();
  });
  on(aptPanel, 'click', '[data-act="apt-clear"]', () => { state.apt = {}; paintApt(); paint(); });

  rail.append(basics, skillFilter.element, aptPanel);

  const sortSel = selectField({
    title: 'Сортировка', options: SORTS, value: state.sort,
    onChange: (v) => { state.sort = v; paint(); },
  });
  const dirBtn = el(`<button class="btn btn--sm" type="button" title="Обратный порядок">↕</button>`);
  dirBtn.addEventListener('click', () => { state.dir = state.dir === 'desc' ? 'asc' : 'desc'; paint(); });
  sortbar.append(sortSel.element, dirBtn);

  function outfitSkills(outfit) {
    const ids = [...(outfit.uniqueId ? [outfit.uniqueId] : []), ...outfit.skillIds];
    return ids.map((id) => db.skillById.get(id)).filter(Boolean);
  }

  function paint() {
    writeState({
      q: state.q,
      st: state.strategies.join(','),
      stars: state.stars.join(','),
      apt: Object.keys(state.apt).length ? JSON.stringify(state.apt) : '',
      sort: state.sort === 'name' ? '' : state.sort,
      dir: state.dir === 'desc' ? '' : state.dir,
    });

    const needle = state.q.trim().toLowerCase();
    const rows = [];

    for (const chara of db.characters) {
      for (const outfit of chara.outfits) {
        if (outfit.global === false) continue;
        if (needle && !`${chara.name} ${outfit.epithet}`.toLowerCase().includes(needle)) continue;
        if (state.strategies.length && !state.strategies.includes(outfit.strategy)) continue;
        if (state.stars.length && !state.stars.includes(outfit.stars)) continue;

        let aptOk = true;
        for (const [key, min] of Object.entries(state.apt)) {
          if ((outfit.aptitudes[key] ?? 0) < min) { aptOk = false; break; }
        }
        if (!aptOk) continue;

        const skills = outfitSkills(outfit);
        const test = skillFilter.test(skills.map((s) => s.id));
        if (!test.ok) continue;

        rows.push({
          chara, outfit, skills, hits: new Set([...test.hits.values()].flat()),
          gold: skills.filter((s) => s.tier === 'gold').length,
          score: skills.reduce((n, s) => n + (s.score || 0), 0),
        });
      }
    }

    const dir = state.dir === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      if (state.sort === 'name') return dir * -a.outfit.displayName.localeCompare(b.outfit.displayName);
      if (state.sort === 'stars') return dir * (a.outfit.stars - b.outfit.stars) || a.outfit.displayName.localeCompare(b.outfit.displayName);
      if (state.sort === 'gold') return dir * (a.gold - b.gold) || a.outfit.displayName.localeCompare(b.outfit.displayName);
      if (state.sort === 'score') return dir * (a.score - b.score) || a.outfit.displayName.localeCompare(b.outfit.displayName);
      if (state.sort.startsWith('apt:')) {
        const k = state.sort.slice(4);
        return dir * ((a.outfit.aptitudes[k] ?? 0) - (b.outfit.aptitudes[k] ?? 0)) || a.outfit.displayName.localeCompare(b.outfit.displayName);
      }
      return 0;
    });

    count.textContent = `нарядов: ${rows.length} · ум: ${new Set(rows.map((r) => r.chara.id)).size}`;
    grid.innerHTML = rows.length ? rows.map(cardHtml).join('') : '';
    if (!rows.length) grid.innerHTML = '<div class="empty">Под эти фильтры ничего не подходит.</div>';
  }

  function cardHtml({ chara, outfit, skills, hits }) {
    const unique = outfit.uniqueId ? db.skillById.get(outfit.uniqueId) : null;
    const rest = skills.filter((s) => s.id !== outfit.uniqueId);
    const gold = rest.filter((s) => s.tier === 'gold');
    const normal = rest.filter((s) => s.tier !== 'gold');

    const aptCells = APT.map(([key, label]) => {
      const g = outfit.aptitudeGrades[key];
      const hit = state.apt[key] ? 1 : 0;
      return `<div class="apt__cell" data-g="${g}" data-hit="${hit}"><b>${g}</b><span>${label}</span></div>`;
    }).join('');

    const section = (title, list) => (list.length ? `
      <div class="card__section">
        <h4>${esc(title)} <span class="sk-count">${list.length}</span></h4>
        <div class="chips">${list.map((s) => skillPill(s, { match: hits.has(s.id) })).join('')}</div>
      </div>` : '');

    return `<article class="card">
      <div class="card__head">
        <img class="card__art" src="./img/chara/${esc(outfit.id)}.webp" alt="" loading="lazy" width="58" height="58">
        <div class="card__title">
          <h3>${esc(chara.name)}</h3>
          <div class="epithet">${esc(outfit.epithet)}</div>
          <div class="card__meta">
            <span class="stars">${'★'.repeat(outfit.stars)}</span>
            <span class="chip chip--accent">${esc(outfit.strategyName)}</span>
          </div>
        </div>
      </div>
      <div class="card__body">
        <div class="apt">${aptCells}</div>
        ${unique ? `<div class="card__section">
          <h4>Уник</h4>
          <div class="chips">${skillPill(unique, { match: hits.has(unique.id) })}</div>
          <p class="tiny muted" style="margin-top:5px">${esc(effectSummary(unique))}</p>
        </div>` : ''}
        ${section('Золотые скиллы', gold)}
        ${section('Список скиллов', normal)}
      </div>
    </article>`;
  }

  paint();
  root.replaceChildren(layout);
}
