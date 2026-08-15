import { db, skillIconUrl } from '../store.mjs';
import { el, esc, on, effectSummary, readState, writeState } from '../ui.mjs';
import { toggleGroup, searchField } from '../filters.mjs';
import { STRATEGY } from '../model.mjs';

const TIERS = [['unique', 'Unique'], ['evolved', 'Evolved'], ['gold', 'Gold'], ['normal', 'Normal']];
const KINDS = [['speed', 'Speed'], ['accel', 'Accel'], ['recovery', 'Recovery'], ['stat', 'Stat'], ['utility', 'Utility'], ['debuff', 'Debuff']];
const PHASES = [[0, 'Opening'], [1, 'Middle'], [2, 'Final'], [3, 'Last spurt']];
const DISTANCES = [[1, 'Sprint'], [2, 'Mile'], [3, 'Medium'], [4, 'Long']];
const SURFACES = [[1, 'Turf'], [2, 'Dirt']];
const TERRAIN = [['corner', 'Corner'], ['straight', 'Straight'], ['final-corner', 'Final corner'], ['last-straight', 'Final straight'], ['uphill', 'Uphill'], ['downhill', 'Downhill']];
const FROM = [['unique', 'Uma unique'], ['characters', 'Uma skill list'], ['event', 'Card event'], ['hint', 'Card hint']];

const COLUMNS = [
  { key: 'name', label: 'Skill', sort: (a, b) => a.name.localeCompare(b.name) },
  { key: 'effect', label: 'Effect', sort: null },
  { key: 'cond', label: 'Activates when', sort: null },
  { key: 'cost', label: 'SP', num: true, sort: (a, b) => a.cost - b.cost },
  { key: 'score', label: 'Score', num: true, sort: (a, b) => a.score - b.score },
  { key: 'eff', label: 'Score/SP', num: true, sort: (a, b) => scorePerSp(a) - scorePerSp(b) },
  { key: 'dur', label: 'Dur', num: true, sort: (a, b) => a.duration - b.duration },
  { key: 'src', label: 'Sources', num: true, sort: (a, b) => sourceCount(a) - sourceCount(b) },
];

const scorePerSp = (s) => (s.cost ? s.score / s.cost : 0);
const sourceCount = (s) => s.sources.event.length + s.sources.hint.length + s.sources.characters.length + s.sources.unique.length;

export function renderSkills(root) {
  const saved = readState();
  const state = {
    q: saved.q ?? '',
    tiers: saved.tier ? saved.tier.split(',') : [],
    kinds: saved.kind ? saved.kind.split(',') : [],
    phases: saved.ph ? saved.ph.split(',').map(Number) : [],
    strategies: saved.st ? saved.st.split(',').map(Number) : [],
    distances: saved.dt ? saved.dt.split(',').map(Number) : [],
    surfaces: saved.sf ? saved.sf.split(',').map(Number) : [],
    terrain: saved.tr ? saved.tr.split(',') : [],
    from: saved.from ? saved.from.split(',') : [],
    sort: saved.sort ?? 'score',
    dir: saved.dir ?? 'desc',
  };

  const layout = el(`<div class="layout">
    <aside class="rail"></aside>
    <section>
      <div class="page-head">
        <div>
          <h1>Skills</h1>
          <p>Every skill live on Global, with its real activation conditions read straight out of the game data.</p>
        </div>
      </div>
      <div data-role="count" class="small muted" style="margin-bottom:10px"></div>
      <div class="table-wrap"><table><thead></thead><tbody data-role="rows"></tbody></table></div>
    </section>
  </div>`);

  const rail = layout.querySelector('.rail');
  const tbody = layout.querySelector('[data-role="rows"]');
  const thead = layout.querySelector('thead');
  const count = layout.querySelector('[data-role="count"]');

  const mk = (title, options, key, cast = (v) => v) => toggleGroup({
    title,
    options: options.map(([v, l]) => ({ value: String(v), label: l })),
    value: state[key].map(String),
    onChange: (v) => { state[key] = v.map(cast); paint(); },
  }).element;

  const p1 = el('<section class="panel"><div class="panel__body"></div></section>');
  p1.querySelector('.panel__body').append(
    searchField({ placeholder: 'Search skills…', value: state.q, onChange: (v) => { state.q = v; paint(); } }).element,
    mk('Rank', TIERS, 'tiers'),
    mk('Effect', KINDS, 'kinds'),
  );

  const p2 = el('<section class="panel"><div class="panel__head"><h3>Activation</h3></div><div class="panel__body"></div></section>');
  p2.querySelector('.panel__body').append(
    mk('Race phase', PHASES, 'phases', Number),
    mk('Running style', Object.entries(STRATEGY).map(([v, s]) => [v, s.name]), 'strategies', Number),
    mk('Distance', DISTANCES, 'distances', Number),
    mk('Surface', SURFACES, 'surfaces', Number),
    mk('Terrain', TERRAIN, 'terrain'),
  );

  const p3 = el('<section class="panel"><div class="panel__head"><h3>Where to get it</h3></div><div class="panel__body"></div></section>');
  p3.querySelector('.panel__body').append(mk('Source', FROM, 'from'));

  rail.append(p1, p2, p3);

  function paintHead() {
    thead.innerHTML = `<tr>${COLUMNS.map((c) => {
      const sortable = !!c.sort;
      const aria = state.sort === c.key ? (state.dir === 'desc' ? 'descending' : 'ascending') : 'none';
      return `<th class="${c.num ? 'num' : ''}" ${sortable ? `data-sort="${c.key}" aria-sort="${aria}"` : 'style="cursor:default"'}>${esc(c.label)}</th>`;
    }).join('')}</tr>`;
  }

  on(thead, 'click', 'th[data-sort]', (e, t) => {
    const key = t.dataset.sort;
    if (state.sort === key) state.dir = state.dir === 'desc' ? 'asc' : 'desc';
    else { state.sort = key; state.dir = key === 'name' ? 'asc' : 'desc'; }
    paint();
  });

  function paint() {
    writeState({
      q: state.q,
      tier: state.tiers.join(','),
      kind: state.kinds.join(','),
      ph: state.phases.join(','),
      st: state.strategies.join(','),
      dt: state.distances.join(','),
      sf: state.surfaces.join(','),
      tr: state.terrain.join(','),
      from: state.from.join(','),
      sort: state.sort === 'score' ? '' : state.sort,
      dir: state.dir === 'desc' ? '' : state.dir,
    });

    const needle = state.q.trim().toLowerCase();
    const rows = db.learnable.filter((s) => {
      if (needle && !(s.name.toLowerCase().includes(needle) || s.variants.some((v) => v.text.toLowerCase().includes(needle)))) return false;
      if (state.tiers.length && !state.tiers.includes(s.tier)) return false;
      if (state.kinds.length && !s.effects.some((e) => state.kinds.includes(e.kind))) return false;
      if (state.phases.length && !state.phases.some((p) => s.facets.phases?.includes(p))) return false;
      if (state.strategies.length && !state.strategies.some((x) => s.facets.strategies?.includes(x))) return false;
      if (state.distances.length && !state.distances.some((x) => s.facets.distanceTypes?.includes(x))) return false;
      if (state.surfaces.length && !state.surfaces.some((x) => s.facets.surfaces?.includes(x))) return false;
      if (state.terrain.length && !state.terrain.some((x) => s.facets.terrain?.includes(x))) return false;
      if (state.from.length && !state.from.some((x) => (s.sources[x] ?? []).length > 0)) return false;
      return true;
    });

    const col = COLUMNS.find((c) => c.key === state.sort);
    const dir = state.dir === 'desc' ? -1 : 1;
    if (col?.sort) rows.sort((a, b) => dir * col.sort(a, b) || a.name.localeCompare(b.name));

    count.textContent = `${rows.length} of ${db.learnable.length} skills`;
    paintHead();
    tbody.innerHTML = rows.map(rowHtml).join('') || '<tr><td colspan="8"><div class="empty">No skill matches these filters.</div></td></tr>';
  }

  function rowHtml(s) {
    const src = s.sources;
    const parts = [
      src.unique.length ? [`${src.unique.length} uma unique`, `${src.unique.length}·uniq`] : null,
      src.characters.length ? [`${src.characters.length} uma skill lists`, `${src.characters.length}·uma`] : null,
      src.event.length ? [`${src.event.length} card events`, `${src.event.length}·evt`] : null,
      src.hint.length ? [`${src.hint.length} card hints`, `${src.hint.length}·hint`] : null,
    ].filter(Boolean);

    return `<tr>
      <td>
        <div class="row" style="gap:7px;flex-wrap:nowrap">
          <img src="${skillIconUrl(s)}" alt="" width="26" height="26" loading="lazy" style="border-radius:50%;background:var(--sunken);flex:none">
          <div style="min-width:0">
            <div data-skill="${esc(s.id)}" style="font-weight:500">${esc(s.name)}</div>
            <span class="chip chip--${s.tier === 'normal' ? '' : s.tier}" style="margin-top:2px">${esc(s.tierName)}</span>
          </div>
        </div>
      </td>
      <td>${esc(effectSummary(s))}</td>
      <td class="small muted" style="max-width:340px">${s.variants.map((v) => esc(v.text)).join('<br>')}</td>
      <td class="num">${s.cost || '—'}</td>
      <td class="num">${s.score || '—'}</td>
      <td class="num">${s.cost ? scorePerSp(s).toFixed(2) : '—'}</td>
      <td class="num">${s.duration ? `${s.duration}s` : '—'}</td>
      <td class="num small muted" title="${esc(parts.map((p) => p[0]).join(', '))}">${parts.length ? parts.map((p) => esc(p[1])).join('<br>') : '—'}</td>
    </tr>`;
  }

  paint();
  root.replaceChildren(layout);
}
