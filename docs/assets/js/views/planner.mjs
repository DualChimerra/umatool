import { db, isObtainable } from '../store.mjs';
import { el, esc, on, skillPill, effectSummary, fmt, collapsible } from '../ui.mjs';
import {
  cm, commitContext, currentCourse, scoringContext, DEFAULT_STATS,
  normaliseField, fieldStyles, fieldSummary, yourSkills, outfitAptitudes,
} from '../context.mjs';
import {
  simulateRace, rankSkills, statGuide, statSensitivity, STRATEGY,
  orderDistribution, orderRate, activationRate, CM_FIELD_SIZE,
  GROUND_NAME, WEATHER_NAME, SEASON_NAME, APT_GRADE, isPassive,
  uniqueScale, atUniqueLevel, scoreSkill,
} from '../model.mjs';
import { clearFieldCache, FIELD_PRESETS } from '../race/field.mjs';
import { openFieldEditor } from './fieldeditor.mjs';
import { pickUma, pickSkill } from './picker.mjs';

const STATS = [['speed', 'Speed'], ['stamina', 'Stamina'], ['power', 'Power'], ['guts', 'Guts'], ['wit', 'Wit']];

/**
 * Skill families. The ranking used to be one flat list, which buried anything
 * that is not a plain speed skill — a Champions Meeting deck is built out of
 * all five of these, not the top ten of one.
 */
const FAMILIES = [
  { key: 'all', name: 'All', test: () => true },
  { key: 'speed', name: 'Speed & accel', test: (s) => s.effects.some((e) => e.target === 1 && ['target_speed', 'current_speed', 'accel'].includes(e.key)) },
  { key: 'recovery', name: 'Recovery', test: (s) => s.effects.some((e) => e.target === 1 && e.key === 'recovery' && e.value > 0) },
  { key: 'green', name: 'Green / passive', test: (s) => isPassive(s) || (s.duration === 0 && s.effects.some((e) => e.kind === 'stat')) },
  { key: 'debuff', name: 'Debuffs', test: (s) => s.effects.some((e) => e.target !== 1) },
  { key: 'traffic', name: 'Positioning', test: (s) => s.effects.some((e) => ['lane_move', 'unblock', 'position_keep'].includes(e.key)) },
];

let family = 'all';
let sortBy = 'value';

export function renderPlanner(root) {
  const layout = el(`<div class="layout">
    <aside class="rail"></aside>
    <section class="stack">
      <div class="page-head">
        <div>
          <h1>Champions Meeting planner</h1>
          <p>Set the race and the field. Everything below — and the Team and Race pages — is derived from it.</p>
        </div>
        <div class="page-head__right" data-role="race-chip"></div>
      </div>
      <nav class="jump" data-role="jump"></nav>
      <div data-role="out" class="stack"></div>
    </section>
  </div>`);

  const rail = layout.querySelector('.rail');
  const out = layout.querySelector('[data-role="out"]');

  /* ------------------------------------------------------------- controls */

  const tracks = [...new Set(db.courses.map((c) => c.trackName))].sort();
  const controls = el(`<section class="panel panel--rail">
    <div class="panel__head"><h3>Race</h3><span class="sk-count" data-role="course-chip"></span></div>
    <div class="panel__body">
      <div class="field">
        <label>Racecourse</label>
        <select class="select" data-role="track">${tracks.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select>
      </div>
      <div class="field">
        <label>Direction</label>
        <div class="toggle-grid toggle-grid--3" data-role="turn">
          <button type="button" data-v="0">Any</button>
          <button type="button" data-v="1">Right</button>
          <button type="button" data-v="2">Left</button>
        </div>
      </div>
      <div class="field"><label>Course</label><select class="select" data-role="course"></select></div>
      <div class="field">
        <label>Running style</label>
        <div class="toggle-grid" data-role="strategy">
          ${Object.entries(STRATEGY).map(([v, s]) => `<button type="button" data-v="${v}" aria-pressed="${Number(v) === cm.strategy}">${esc(s.name)}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Going</label>
        <div class="toggle-grid" data-role="ground">
          ${Object.entries(GROUND_NAME).map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${Number(v) === cm.ground}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Weather</label>
        <div class="toggle-grid" data-role="weather">
          ${Object.entries(WEATHER_NAME).map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${Number(v) === cm.weather}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Season</label>
        <div class="toggle-grid toggle-grid--3" data-role="season">
          ${Object.entries(SEASON_NAME).map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${Number(v) === cm.season}">${l}</button>`).join('')}
        </div>
        <p class="tiny muted">Going, weather, season and the track itself are hard gates on green skills — <b>Sunny Days ○</b> is worth nothing in the rain, and the app now says so instead of pricing it anyway.</p>
      </div>
      <div class="field">
        <label>Field size</label>
        <div class="toggle-grid toggle-grid--3" data-role="field">
          ${[9, 12, 18].map((n) => `<button type="button" data-v="${n}" aria-pressed="${n === cm.fieldSize}">${n}${n === CM_FIELD_SIZE ? ' · CM' : ''}</button>`).join('')}
        </div>
      </div>
    </div>
  </section>`);

  const fieldPanel = el(`<section class="panel panel--rail">
    <div class="panel__head"><h3>The rest of the field</h3><span class="sk-count" data-role="fsum"></span></div>
    <div class="panel__body">
      <div class="seg seg--full" data-role="fmode">
        <button type="button" data-v="simple" aria-pressed="${cm.field.mode !== 'advanced'}">By running style</button>
        <button type="button" data-v="advanced" aria-pressed="${cm.field.mode === 'advanced'}">Build each rival</button>
      </div>
      <div data-role="fsimple" class="stack" style="gap:9px">
        <div class="row" style="gap:5px;flex-wrap:wrap">
          ${FIELD_PRESETS.map((p) => `<button class="btn btn--sm btn--ghost" type="button" data-preset="${p.key}" title="${esc(p.hint)}">${esc(p.name)}</button>`).join('')}
        </div>
        <div class="count-grid" data-role="counts"></div>
        <div class="field">
          <label>Rival strength <span class="muted" data-out="strength"></span></label>
          <input type="range" min="60" max="115" step="1" data-role="strength">
        </div>
        <div class="field">
          <label>Skills each rival carries <span class="muted" data-out="depth"></span></label>
          <input type="range" min="0" max="8" step="1" data-role="depth">
        </div>
      </div>
      <div data-role="fadvanced" class="stack" style="gap:8px" hidden>
        <p class="tiny muted">Every rival gets its own umamusume, stats, running style and skill list. The unique comes with the uma.</p>
        <button class="btn btn--primary btn--sm" type="button" data-act="edit-field">Open the field editor</button>
        <div data-role="fpreview" class="stack" style="gap:4px"></div>
      </div>
    </div>
  </section>`);

  const youPanel = el(`<section class="panel panel--rail">
    <div class="panel__head"><h3>Your umamusume</h3><span class="sk-count" data-role="you-chip"></span></div>
    <div class="panel__body" data-role="you-body"></div>
  </section>`);

  const statsPanel = el(`<section class="panel panel--rail">
    <div class="panel__head"><h3>Your stats</h3><button class="btn btn--ghost btn--sm" data-act="stat-reset" type="button">Reset</button></div>
    <div class="panel__body">
      <div class="field">
        <label>Stat ceiling you play with</label>
        <div class="toggle-grid toggle-grid--3" data-role="cap">
          ${[1200, 1400, 1600, 1800, 2000].map((n) => `<button type="button" data-v="${n}" aria-pressed="${n === cm.statCap}">${n}</button>`).join('')}
        </div>
      </div>
      ${STATS.map(([k, label]) => `
        <div class="field">
          <label>${label}</label>
          <div class="range-row">
            <input type="range" min="100" step="10" data-stat="${k}">
            <input class="input num" type="number" min="100" step="10" data-num="${k}">
          </div>
        </div>`).join('')}
      <div class="field">
        <label>Aptitudes for this race</label>
        <div class="apt-row" data-role="apt"></div>
        <p class="tiny muted">Distance aptitude scales the Speed term in the final leg; surface and running-style aptitude scale acceleration. Below A costs real time, and the model charges for it.</p>
      </div>
      <div class="field">
        <label>Recovery from skills <span class="muted" data-out="recovery">${cm.recovery}%</span></label>
        <input type="range" min="0" max="60" step="1" data-role="recovery" value="${cm.recovery}">
      </div>
    </div>
  </section>`);

  rail.append(
    collapsible(controls, 'plan.race'),
    collapsible(youPanel, 'plan.you'),
    collapsible(fieldPanel, 'plan.field'),
    collapsible(statsPanel, 'plan.stats'),
  );

  const trackSel = controls.querySelector('[data-role="track"]');
  const courseSel = controls.querySelector('[data-role="course"]');
  let turnFilter = 0;

  function coursesFor(trackName) {
    return db.courses.filter((c) => c.trackName === trackName && (!turnFilter || c.turn === turnFilter));
  }

  function fillCourses(trackName, preferId = null) {
    let list = coursesFor(trackName);
    if (!list.length) { turnFilter = 0; list = coursesFor(trackName); }
    courseSel.innerHTML = list.map((c) => `<option value="${esc(c.id)}">${c.distance}m ${esc(c.surfaceName)} · ${esc(c.turnName)} · ${esc(c.distanceTypeName)}</option>`).join('');
    const chosen = preferId && list.some((c) => c.id === preferId) ? preferId : list[0]?.id;
    courseSel.value = chosen;
    cm.courseId = chosen;
    controls.querySelectorAll('[data-role="turn"] button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === turnFilter)));
  }
  trackSel.value = currentCourse().trackName;
  fillCourses(trackSel.value, cm.courseId);

  trackSel.addEventListener('change', () => { fillCourses(trackSel.value); commitContext(); repaint(); });
  courseSel.addEventListener('change', () => { cm.courseId = courseSel.value; commitContext(); repaint(); });
  on(controls, 'click', '[data-role="turn"] button', (e, t) => {
    turnFilter = Number(t.dataset.v);
    fillCourses(trackSel.value, cm.courseId);
    commitContext(); repaint();
  });

  const groupHandler = (scope, selector, apply) => on(scope, 'click', `${selector} button`, (e, t) => {
    apply(Number(t.dataset.v));
    scope.querySelectorAll(`${selector} button`).forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    commitContext(); repaint();
  });
  groupHandler(controls, '[data-role="strategy"]', (v) => { cm.strategy = v; });
  groupHandler(controls, '[data-role="ground"]', (v) => { cm.ground = v; });
  groupHandler(controls, '[data-role="weather"]', (v) => { cm.weather = v; });
  groupHandler(controls, '[data-role="season"]', (v) => { cm.season = v; });
  groupHandler(controls, '[data-role="field"]', (v) => { cm.fieldSize = v; normaliseField(); });

  /* --------------------------------------------------------- your runner */

  function paintYou() {
    const course = currentCourse();
    const outfit = cm.you.outfitId ? db.outfitById.get(cm.you.outfitId) : null;
    const unique = outfit?.uniqueId ? db.skillById.get(outfit.uniqueId) : null;
    const apt = outfit ? outfitAptitudes(outfit, course, cm.strategy) : null;
    const body = youPanel.querySelector('[data-role="you-body"]');
    youPanel.querySelector('[data-role="you-chip"]').textContent = outfit
      ? `${APT_GRADE[apt.distance]}/${APT_GRADE[apt.surface]}/${APT_GRADE[apt.strategy]}`
      : 'generic runner';

    body.innerHTML = `
      ${outfit ? `<div class="you-card">
        <img src="./img/chara/${esc(outfit.id)}.webp" alt="" width="42" height="42" class="av">
        <span style="min-width:0">
          <b>${esc(outfit.charaName)}</b>
          <span class="tiny muted" style="display:block">${esc(outfit.epithet)} &middot; ${esc(outfit.strategyName)}</span>
        </span>
        <button class="icon-btn" type="button" data-act="you-clear" aria-label="Clear">&#10005;</button>
      </div>` : ''}
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <button class="btn btn--sm${outfit ? ' btn--ghost' : ' btn--primary'}" type="button" data-act="you-pick">${outfit ? 'Change uma' : 'Pick an umamusume'}</button>
        ${outfit ? `<label class="check"><input type="checkbox" data-act="you-lock" ${cm.you.lockAptitudes ? 'checked' : ''}> use her aptitudes</label>` : ''}
      </div>
      ${unique ? `<div class="field">
        <label>Unique &middot; level ${cm.you.uniqueLevel} <span class="muted">(&times;${uniqueScale(cm.you.uniqueLevel).toFixed(2)} effect)</span></label>
        <div class="row" style="gap:6px;align-items:center">
          <label class="check"><input type="checkbox" data-act="you-unique" ${cm.you.unique ? 'checked' : ''}></label>
          ${skillPill(unique)}
        </div>
        <div class="toggle-grid toggle-grid--3" data-role="ulevel">
          ${[1, 2, 3, 4, 5, 6].map((n) => `<button type="button" data-v="${n}" aria-pressed="${cm.you.uniqueLevel === n}">Lv${n}</button>`).join('')}
        </div>
        <p class="tiny muted">The dump ships uniques at their base value, so Lv1 is the game&rsquo;s own number. Each level above
        that is taken as +10% of base &mdash; the community reading &mdash; and every score using it says which level it used.</p>
      </div>` : ''}
      <div class="field">
        <label>Skills you expect to finish with</label>
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <button class="btn btn--sm btn--ghost" type="button" data-act="you-add">+ skill</button>
          <button class="btn btn--sm btn--ghost" type="button" data-act="you-best">Best 6 here</button>
          ${outfit ? '<button class="btn btn--sm btn--ghost" type="button" data-act="you-own">Her own list</button>' : ''}
          ${cm.raceSkills.length ? '<button class="btn btn--sm btn--ghost" type="button" data-act="you-clear-skills">Clear</button>' : ''}
        </div>
        <div class="chips" data-role="you-skills"></div>
      </div>`;

    const chips = body.querySelector('[data-role="you-skills"]');
    chips.innerHTML = cm.raceSkills.length
      ? cm.raceSkills.map((id) => {
        const sk = db.skillById.get(id);
        return sk ? `<span class="chip-drop">${skillPill(sk)}<button type="button" class="chip-drop__x" data-you-drop="${esc(id)}" aria-label="remove">&#10005;</button></span>` : '';
      }).join('')
      : '<p class="tiny muted">Nothing yet. The Race page runs whatever is here against the field.</p>';
  }

  on(youPanel, 'click', '[data-act="you-pick"]', () => pickUma((id) => {
    const o = db.outfitById.get(id);
    cm.you.outfitId = id;
    cm.you.unique = true;
    cm.strategy = o.strategy;
    controls.querySelectorAll('[data-role="strategy"] button')
      .forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === cm.strategy)));
    commitContext(); paintYou(); repaint();
  }));
  on(youPanel, 'click', '[data-act="you-clear"]', () => { cm.you.outfitId = null; commitContext(); paintYou(); repaint(); });
  on(youPanel, 'change', '[data-act="you-lock"]', (e, t) => { cm.you.lockAptitudes = t.checked; commitContext(); paintYou(); repaint(); });
  on(youPanel, 'change', '[data-act="you-unique"]', (e, t) => { cm.you.unique = t.checked; commitContext(); repaint(); });
  on(youPanel, 'click', '[data-role="ulevel"] button', (e, t) => {
    cm.you.uniqueLevel = Number(t.dataset.v);
    commitContext(); paintYou(); repaint();
  });
  on(youPanel, 'click', '[data-act="you-add"]', () => pickSkill((id) => {
    if (!cm.raceSkills.includes(id)) cm.raceSkills.push(id);
    commitContext(); paintYou(); repaint();
  }, { exclude: cm.raceSkills }));
  on(youPanel, 'click', '[data-act="you-best"]', () => {
    const ctx = scoringContext();
    ctx.sim = simulateRace({ ...ctx, recoveryPct: cm.recovery });
    const top = rankSkills(db.learnable.filter(isObtainable), ctx, { tiers: ['gold', 'normal'], limit: 6 });
    cm.raceSkills = [...new Set([...cm.raceSkills, ...top.map((r) => r.skill.id)])];
    commitContext(); paintYou(); repaint();
  });
  on(youPanel, 'click', '[data-act="you-own"]', () => {
    const o = db.outfitById.get(cm.you.outfitId);
    cm.raceSkills = [...new Set([...cm.raceSkills, ...(o?.skillIds ?? [])])];
    commitContext(); paintYou(); repaint();
  });
  on(youPanel, 'click', '[data-act="you-clear-skills"]', () => { cm.raceSkills = []; commitContext(); paintYou(); repaint(); });
  on(youPanel, 'click', '[data-you-drop]', (e, t) => {
    cm.raceSkills = cm.raceSkills.filter((id) => id !== t.dataset.youDrop);
    commitContext(); paintYou(); repaint();
  });

  /* ------------------------------------------------------------ the field */

  function paintField() {
    const simple = cm.field.mode !== 'advanced';
    fieldPanel.querySelector('[data-role="fsimple"]').hidden = !simple;
    fieldPanel.querySelector('[data-role="fadvanced"]').hidden = simple;
    fieldPanel.querySelector('[data-role="fsum"]').textContent = fieldSummary();
    fieldPanel.querySelectorAll('[data-role="fmode"] button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v === 'advanced') === !simple)));

    fieldPanel.querySelector('[data-role="counts"]').innerHTML = [1, 2, 3, 4].map((k) => `
      <div class="count-cell">
        <span class="count-cell__name">${esc(STRATEGY[k].short)}</span>
        <div class="stepper">
          <button type="button" data-step="-1" data-style="${k}" aria-label="one fewer ${esc(STRATEGY[k].name)}">−</button>
          <b class="num">${cm.field.counts[k]}</b>
          <button type="button" data-step="1" data-style="${k}" aria-label="one more ${esc(STRATEGY[k].name)}">+</button>
        </div>
      </div>`).join('');

    fieldPanel.querySelector('[data-role="strength"]').value = Math.round((cm.field.strength ?? 0.92) * 100);
    fieldPanel.querySelector('[data-out="strength"]').textContent = `${Math.round((cm.field.strength ?? 0.92) * 100)}% of your stats`;
    fieldPanel.querySelector('[data-role="depth"]').value = cm.field.skillDepth ?? 4;
    fieldPanel.querySelector('[data-out="depth"]').textContent = `${cm.field.skillDepth ?? 4}`;

    const preview = fieldPanel.querySelector('[data-role="fpreview"]');
    preview.innerHTML = cm.field.rivals.map((r, i) => {
      const o = r.outfitId ? db.outfitById.get(r.outfitId) : null;
      return `<div class="mini-row">
        <span class="chip chip--style${r.strategy}">${esc(STRATEGY[r.strategy].short)}</span>
        <span class="mini-row__name">${esc(o ? o.charaName : `Rival ${i + 1}`)}</span>
        <span class="tiny muted num">${r.skills.length + (o && r.unique ? 1 : 0)} sk</span>
      </div>`;
    }).join('');
  }

  on(fieldPanel, 'click', '[data-role="fmode"] button', (e, t) => {
    cm.field.mode = t.dataset.v;
    commitContext(); paintField(); repaint();
  });
  on(fieldPanel, 'click', '[data-preset]', (e, t) => {
    const preset = FIELD_PRESETS.find((p) => p.key === t.dataset.preset);
    if (!preset) return;
    const total = cm.fieldSize - 1;
    const raw = Object.values(preset.counts).reduce((a, b) => a + b, 0);
    cm.field.counts = Object.fromEntries(Object.entries(preset.counts)
      .map(([k, v]) => [k, Math.round((v / raw) * total)]));
    normaliseFieldCounts();
    commitContext(); paintField(); repaint();
  });
  on(fieldPanel, 'click', '[data-step]', (e, t) => {
    const k = t.dataset.style;
    const delta = Number(t.dataset.step);
    const next = cm.field.counts[k] + delta;
    if (next < 0) return;
    const total = [1, 2, 3, 4].reduce((n, j) => n + cm.field.counts[j], 0) + delta;
    if (total > cm.fieldSize - 1) {
      // Take the extra runner off the biggest other group, so the field size
      // the user chose is always the field size that is simulated.
      const donor = [1, 2, 3, 4].filter((j) => String(j) !== k)
        .sort((a, b) => cm.field.counts[b] - cm.field.counts[a])[0];
      if (!cm.field.counts[donor]) return;
      cm.field.counts[donor] -= 1;
    }
    cm.field.counts[k] = next;
    normaliseFieldCounts();
    commitContext(); paintField(); repaint();
  });
  fieldPanel.querySelector('[data-role="strength"]').addEventListener('input', (e) => {
    cm.field.strength = Number(e.target.value) / 100;
    fieldPanel.querySelector('[data-out="strength"]').textContent = `${e.target.value}% of your stats`;
    clearFieldCache(); commitContext();
  });
  fieldPanel.querySelector('[data-role="depth"]').addEventListener('input', (e) => {
    cm.field.skillDepth = Number(e.target.value);
    fieldPanel.querySelector('[data-out="depth"]').textContent = e.target.value;
    clearFieldCache(); commitContext();
  });
  on(fieldPanel, 'click', '[data-act="edit-field"]', () => openFieldEditor(() => { paintField(); repaint(); }));

  function normaliseFieldCounts() {
    const want = cm.fieldSize - 1;
    let total = [1, 2, 3, 4].reduce((n, j) => n + cm.field.counts[j], 0);
    let guard = 40;
    while (total !== want && guard-- > 0) {
      const key = total < want
        ? [2, 3, 1, 4].sort((a, b) => cm.field.counts[a] - cm.field.counts[b])[0]
        : [1, 2, 3, 4].sort((a, b) => cm.field.counts[b] - cm.field.counts[a])[0];
      cm.field.counts[key] += total < want ? 1 : -1;
      total = [1, 2, 3, 4].reduce((n, j) => n + cm.field.counts[j], 0);
    }
    normaliseField();
  }

  /* -------------------------------------------------------------- stats */

  on(statsPanel, 'click', '[data-role="cap"] button', (e, t) => {
    cm.statCap = Number(t.dataset.v);
    statsPanel.querySelectorAll('[data-role="cap"] button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    syncStatInputs(); commitContext(); repaint();
  });

  function syncStatInputs() {
    for (const [k] of STATS) {
      const range = statsPanel.querySelector(`input[data-stat="${k}"]`);
      const num = statsPanel.querySelector(`input[data-num="${k}"]`);
      range.max = cm.statCap;
      num.max = cm.statCap;
      cm.stats[k] = Math.min(cm.stats[k], cm.statCap);
      range.value = cm.stats[k];
      num.value = cm.stats[k];
    }
    statsPanel.querySelector('[data-role="apt"]').innerHTML = [
      ['distance', currentCourse().distanceTypeName],
      ['surface', currentCourse().surfaceName],
      ['strategy', STRATEGY[cm.strategy].short],
    ].map(([k, label]) => `
      <label class="apt-cell">
        <span>${esc(label)}</span>
        <select class="select select--sm" data-apt="${k}">
          ${[8, 7, 6, 5, 4, 3, 2, 1].map((g) => `<option value="${g}" ${cm.aptitudes[k] === g ? 'selected' : ''}>${APT_GRADE[g]}</option>`).join('')}
        </select>
      </label>`).join('');
  }
  syncStatInputs();

  on(statsPanel, 'input', 'input[data-stat]', (e, t) => {
    cm.stats[t.dataset.stat] = Number(t.value);
    statsPanel.querySelector(`input[data-num="${t.dataset.stat}"]`).value = t.value;
    commitContext(); repaint();
  });
  on(statsPanel, 'change', 'input[data-num]', (e, t) => {
    const v = Math.max(100, Math.min(cm.statCap, Number(t.value) || 100));
    cm.stats[t.dataset.num] = v;
    t.value = v;
    statsPanel.querySelector(`input[data-stat="${t.dataset.num}"]`).value = v;
    commitContext(); repaint();
  });
  on(statsPanel, 'change', '[data-apt]', (e, t) => {
    cm.aptitudes[t.dataset.apt] = Number(t.value);
    commitContext(); repaint();
  });
  statsPanel.querySelector('[data-role="recovery"]').addEventListener('input', (e) => {
    cm.recovery = Number(e.target.value);
    statsPanel.querySelector('[data-out="recovery"]').textContent = `${cm.recovery}%`;
    commitContext(); repaint();
  });
  on(statsPanel, 'click', '[data-act="stat-reset"]', () => {
    Object.assign(cm.stats, DEFAULT_STATS);
    syncStatInputs(); commitContext(); repaint();
  });

  /* ----------------------------------------------------------------- paint */

  // Coalesce the repaints a slider fires into one per frame — but fall back to
  // a timer when the tab is in the background, where requestAnimationFrame
  // never runs and the page would otherwise come back showing stale numbers.
  let raf = 0;
  let timer = 0;
  function repaint() {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    if (document.visibilityState === 'hidden') timer = setTimeout(paint, 0);
    else raf = requestAnimationFrame(paint);
  }

  function paint() {
    clearFieldCache();
    const course = currentCourse();
    const ctx = scoringContext();
    const sim = simulateRace({ ...ctx, recoveryPct: cm.recovery });
    const full = { ...ctx, sim, recoveryPct: cm.recovery };

    controls.querySelector('[data-role="course-chip"]').textContent = `${course.distance}m ${course.surfaceName}`;
    layout.querySelector('[data-role="race-chip"]').innerHTML = `
      <div class="race-chip">
        <b>${esc(course.trackName)} ${course.distance}m</b>
        <span>${esc(course.surfaceName)} · ${esc(course.turnName)} · ${esc(GROUND_NAME[cm.ground])} · ${esc(WEATHER_NAME[cm.weather])} · ${esc(SEASON_NAME[cm.season])}</span>
        <span>${esc(STRATEGY[cm.strategy].name)} in a ${cm.fieldSize}-runner field — ${esc(fieldSummary())}</span>
      </div>`;

    const ranked = rankSkills(db.learnable, full);
    const uniques = ranked.filter((r) => r.skill.tier === 'unique' || r.skill.tier === 'evolved');
    const allLearnable = ranked.filter((r) => r.skill.tier === 'gold' || r.skill.tier === 'normal');
    const learnable = cm.obtainableOnly === false ? allLearnable : allLearnable.filter((r) => isObtainable(r.skill));
    const hiddenCount = allLearnable.length - learnable.length;
    const sensitivity = statSensitivity(full, db.learnable);

    layout.querySelector('[data-role="jump"]').innerHTML = [
      ['course', 'Course'], ['stats', 'Stat targets'], ['field', 'Field model'],
      ['you', 'Your run'], ['skills', 'Best skills'], ['uniques', 'Uniques'], ['cards', 'Cards'],
    ].map(([id, label]) => `<a href="#/planner" data-jump="${id}">${label}</a>`).join('');

    out.replaceChildren(
      courseCard(course, sim),
      statCards(course, sim),
      guideCard(course, sim, sensitivity),
      fieldCard(ctx, sim),
      yourRunCard(full),
      rankCard(learnable, hiddenCount),
      uniqueCard(uniques.slice(0, 24), uniques.length),
      cardSourcesCard(learnable.slice(0, 24)),
      scoringExplainer(),
    );
    paintField();
    paintYou();
  }

  /* ------------------------------------------------------------- fragments */

  function yourRunCard(full) {
    const list = yourSkills();
    if (!list.length) return el('<span hidden></span>');
    const rows = list.map((sk) => {
      const scaled = atUniqueLevel(sk, cm.you.uniqueLevel);
      const r = scoreSkill(scaled, full);
      return { sk, r, unique: sk.tier === 'unique' || sk.tier === 'evolved' };
    }).sort((a, b) => (b.r?.bashin ?? -1) - (a.r?.bashin ?? -1));
    const total = rows.reduce((n, x) => n + (x.r?.bashin ?? 0), 0);
    const sp = list.reduce((n, x) => n + (x.cost ?? 0), 0);

    return el(`<section class="panel" data-section="you">
      <div class="panel__head">
        <h3>What your run is worth here</h3>
        <span class="sk-count">${rows.length} skills &middot; ${fmt.int(sp)} SP</span>
      </div>
      <div class="panel__body" style="padding:0">
        <div class="rank-list">
          ${rows.map((x, i) => `<div class="rank-row">
            <span class="rank-row__i">${i + 1}</span>
            <span style="min-width:0">
              <span class="row" style="gap:5px;flex-wrap:wrap">${skillPill(x.sk)}${x.unique ? `<span class="tag tag--green">unique Lv${cm.you.uniqueLevel}</span>` : ''}</span>
              <span class="rank-row__why">${esc(x.r ? [effectSummary(x.sk), ...x.r.reasons].join(' \u00b7 ') : 'cannot fire in this race')}</span>
            </span>
            <span class="rank-row__mid"><span class="tiny muted num">${x.r ? `${fmt.pct(x.r.probability)} of the time` : '\u2014'}</span></span>
            <span class="rank-row__score${x.r ? '' : ' is-neg'}">${x.r ? x.r.bashin.toFixed(2) : '0.00'}</span>
          </div>`).join('')}
        </div>
      </div>
      <div class="panel__foot">
        <p class="tiny muted"><b>${total.toFixed(2)} lengths</b> from this skill list on this race.
        Run it against the field on the <a href="#/race">Race</a> page to see what that is worth in win rate.</p>
      </div>
    </section>`);
  }

  function courseCard(course, sim) {
    const d = course.derived;
    return el(`<section class="panel" data-section="course">
      <div class="panel__head">
        <h3>${esc(course.trackName)} · ${course.distance}m ${esc(course.surfaceName)}</h3>
        <div class="row">
          <span class="chip chip--${course.surface === 1 ? 'turf' : 'dirt'}">${esc(course.surfaceName)}</span>
          <span class="chip">${esc(course.distanceTypeName)}</span>
          <span class="chip">${esc(course.turnName)}-handed</span>
          <a class="btn btn--sm btn--primary" href="#/race">Run the race →</a>
        </div>
      </div>
      <div class="panel__body">
        ${trackSvg(course, sim)}
        <div class="legend">
          <span><i class="sw sw--straight"></i>straight</span>
          <span><i class="sw sw--corner"></i>corner</span>
          <span><i class="sw sw--up"></i>uphill</span>
          <span><i class="sw sw--down"></i>downhill</span>
          <span><i class="sw sw--spurt"></i>last spurt</span>
          <span><i class="sw sw--ramp"></i>where acceleration pays</span>
        </div>
        <div class="row small muted" style="gap:14px;flex-wrap:wrap">
          <span><b class="num">${d.cornerCount}</b> corners (${fmt.int(d.cornerLength)}m)</span>
          <span>final corner at <b class="num">${d.finalCornerStart != null ? fmt.int(d.finalCornerStart) : '—'}</b>m</span>
          <span>home straight <b class="num">${fmt.int(d.lastStraightLength)}</b>m</span>
          <span>uphill <b class="num">${fmt.int(d.uphillLength)}</b>m</span>
          <span>downhill <b class="num">${fmt.int(d.downhillLength)}</b>m</span>
          <span>last spurt from <b class="num">${fmt.int(sim.spurtStart)}</b>m</span>
        </div>
      </div>
    </section>`);
  }

  function trackSvg(course, sim) {
    const W = 1000; const H = 92;
    const x = (m) => (m / course.distance) * W;
    const seg = (a, b, fill, y, h) => `<rect x="${x(a).toFixed(1)}" y="${y}" width="${Math.max(1, x(b) - x(a)).toFixed(1)}" height="${h}" fill="${fill}" rx="1"/>`;

    const straights = course.straights.map((s) => seg(s.start, s.end, 'var(--sw-straight)', 30, 16)).join('');
    const corners = course.corners.map((c) => seg(c.start, c.start + c.length, 'var(--sw-corner)', 30, 16)).join('');
    const up = course.derived.uphill.map((s) => seg(s.start, s.start + s.length, 'var(--sw-up)', 50, 7)).join('');
    const down = course.derived.downhill.map((s) => seg(s.start, s.start + s.length, 'var(--sw-down)', 50, 7)).join('');
    const spurt = seg(sim.spurtStart, course.distance, 'var(--sw-spurt)', 22, 5);
    const ramps = sim.ramps.map((r) => seg(r.at, r.at + Math.max(6, r.length), 'var(--sw-ramp)', 62, 7)).join('');

    const marks = [[course.distance / 6, 'middle'], [(course.distance * 2) / 3, 'final'], [(course.distance * 5) / 6, 'last spurt phase']].map(([m, label]) => `
      <line x1="${x(m).toFixed(1)}" y1="18" x2="${x(m).toFixed(1)}" y2="74" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${(x(m) + 4).toFixed(1)}" y="14" font-size="11" fill="var(--ink-3)">${label}</text>`).join('');

    return `<svg class="track-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Course profile">
      ${straights}${corners}${up}${down}${spurt}${ramps}${marks}
      <text x="2" y="88" font-size="11" fill="var(--ink-3)">start</text>
      <text x="${W - 4}" y="88" font-size="11" fill="var(--ink-3)" text-anchor="end">finish</text>
    </svg>`;
  }

  function statCards(course, sim) {
    const need = sim.requiredStamina;
    const have = cm.stats.stamina;
    const ok = have >= need;
    const coverage = Math.round(sim.spurtCoverage * 100);
    return el(`<div class="plan-grid">
      <div class="stat-tile ${ok ? 'stat-tile--ok' : 'stat-tile--bad'}">
        <h4>Stamina needed</h4>
        <div class="big">${fmt.int(need)}</div>
        <div class="sub">${ok ? `${fmt.int(have - need)} to spare` : `${fmt.int(need - have)} short of a full spurt`}</div>
      </div>
      <div class="stat-tile">
        <h4>Last spurt covered</h4>
        <div class="big">${coverage}%</div>
        <div class="sub">${fmt.int(sim.spurtDistance)}m of the ${fmt.int(course.distance / 3)}m final leg</div>
        <div class="bar" style="margin-top:8px"><i style="width:${coverage}%"></i></div>
      </div>
      <div class="stat-tile">
        <h4>Max stamina pool</h4>
        <div class="big">${fmt.int(sim.maxHp)}</div>
        <div class="sub">${fmt.int(sim.hpBeforeFinal)} spent before the final leg</div>
      </div>
      <div class="stat-tile">
        <h4>Estimated time</h4>
        <div class="big">${formatTime(sim.time)}</div>
        <div class="sub">spurt ${sim.speeds.spurt.toFixed(2)} m/s · cruise ${sim.speeds.v1.toFixed(2)} m/s</div>
      </div>
    </div>`);
  }

  function guideCard(course, sim, sens) {
    const guide = statGuide(course, cm.strategy, cm.statCap);
    const order = ['speed', 'stamina', 'power', 'guts', 'wit'];
    const best = order.filter((k) => sens[k]?.bashin != null).sort((a, b) => sens[b].bashin - sens[a].bashin)[0];

    const rows = order.map((k) => {
      const range = k === 'stamina' ? `${fmt.int(sim.requiredStamina)}+` : `${fmt.int(guide[k][0])} – ${fmt.int(guide[k][1])}`;
      const s = sens[k];
      const marginal = s?.bashin == null ? '—' : `${s.bashin >= 0 ? '+' : '−'}${Math.abs(s.bashin).toFixed(2)} len`;
      const note = k === 'stamina' ? 'solved from this course, style and going'
        : s?.viaSkills ? 'raises the Wit activation roll on checked skills'
          : 'measured on the HP/speed model';
      return `<tr>
        <td style="font-weight:500">${k.charAt(0).toUpperCase() + k.slice(1)}${k === best ? ' <span class="chip chip--accent">best next point</span>' : ''}</td>
        <td class="num">${esc(range)}</td>
        <td class="num">${esc(marginal)}</td>
        <td class="small muted">${esc(note)}</td>
      </tr>`;
    }).join('');

    return el(`<section class="panel" data-section="stats">
      <div class="panel__head"><h3>Stat targets and where the next 100 points go</h3></div>
      <div class="panel__body" style="gap:8px">
        <div class="table-wrap"><table>
          <thead><tr><th>Stat</th><th class="num">Target</th><th class="num">+100 is worth</th><th>How it was worked out</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <p class="note">The “+100 is worth” column is a finite difference on the model — it re-runs the race with 100 more of that
        stat and converts the time saved into lengths at the finish. It is also what prices every green skill: <b>+40 Stamina</b> is
        worth 0.4 × the Stamina row, which is why a racecourse ○ is two lengths when the spurt is short and nothing when it is not.</p>
      </div>
    </section>`);
  }

  function fieldCard(ctx, sim) {
    const styles = fieldStyles();
    const wit = activationRate(ctx.stats.wit);
    const phases = [['Opening', 0], ['Middle', 1], ['Final', 2], ['Last spurt', 3]];
    const dists = phases.map(([, p]) => orderDistribution(ctx.strategy, styles, p));
    const maxW = Math.max(...dists.flatMap((d) => [...d.values()]));

    const rows = [];
    for (let o = 1; o <= cm.fieldSize; o += 1) {
      rows.push(`<tr>
        <td>${o}${o === 1 ? 'st' : o === 2 ? 'nd' : o === 3 ? 'rd' : 'th'}</td>
        <td class="num">${orderRate(o, cm.fieldSize).toFixed(1)}%</td>
        ${dists.map((d) => {
    const w = d.get(o) ?? 0;
    return `<td class="num heat" style="--h:${(w / maxW).toFixed(3)}">${w >= 0.005 ? `${(w * 100).toFixed(0)}%` : '·'}</td>`;
  }).join('')}
      </tr>`);
    }

    return el(`<section class="panel" data-section="field">
      <div class="panel__head">
        <h3>Field model</h3>
        <span class="sk-count">${cm.fieldSize} runners · ${esc(fieldSummary())}</span>
      </div>
      <div class="panel__body">
        <p class="small muted">Where you sit changes through the race, so a skill gated on placing is priced at the phase it fires in —
        not at the finish. With ${esc(fieldSummary())}, <code>order_rate</code> moves in steps of ${(100 / cm.fieldSize).toFixed(1)}%.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Place</th><th class="num">order_rate</th>${phases.map(([n]) => `<th class="num">${n}</th>`).join('')}</tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table></div>
        <p class="small muted">Wit ${ctx.stats.wit} → Wit-checked skills fire <b>${(wit * 100).toFixed(1)}%</b> of the time
        (<code>100 − 9000 / Wit</code>, floored at 20%). Change the field mix on the left and this table, and every positional
        skill's score, moves with it.</p>
      </div>
    </section>`);
  }

  function rankCard(rows, hidden) {
    const fam = FAMILIES.find((f) => f.key === family) ?? FAMILIES[0];
    let list = rows.filter((r) => fam.test(r.skill));
    if (sortBy === 'sp') list = [...list].sort((a, b) => (b.perSp ?? 0) - (a.perSp ?? 0));
    const shown = list.slice(0, 40);
    const max = Math.max(...shown.map((r) => Math.abs(r.bashin)), 0.01);

    const node = el(`<section class="panel" data-section="skills">
      <div class="panel__head panel__head--wrap">
        <h3>Best skills for this race</h3>
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <div class="seg" data-role="sort">
            <button type="button" data-v="value" aria-pressed="${sortBy === 'value'}">By lengths</button>
            <button type="button" data-v="sp" aria-pressed="${sortBy === 'sp'}">By lengths / 100 SP</button>
          </div>
          <div class="seg" data-role="obtainable">
            <button type="button" data-v="1" aria-pressed="${cm.obtainableOnly !== false}">Obtainable</button>
            <button type="button" data-v="0" aria-pressed="${cm.obtainableOnly === false}">All</button>
          </div>
        </div>
      </div>
      <div class="tabs-row" data-role="family">
        ${FAMILIES.map((f) => {
    const n = rows.filter((r) => f.test(r.skill)).length;
    return `<button type="button" data-v="${f.key}" aria-pressed="${f.key === family}">${esc(f.name)}<span class="sk-count">${n}</span></button>`;
  }).join('')}
      </div>
      <div class="panel__body" style="padding:0">
        <div class="rank-list">${shown.map((r, i) => rankRow(r, i, max)).join('') || '<div class="empty empty--sm">Nothing in this family can fire on this race.</div>'}</div>
      </div>
      <div class="panel__foot">
        <p class="tiny muted">${shown.length} of ${list.length} shown.${hidden ? ` ${hidden} more score here but no Global uma or card teaches them — switch to <b>All</b>.` : ''}
        Every row is expected <b>ground gained on the field</b>: your own metres for a buff, the metres your rivals lose for a debuff.</p>
      </div>
    </section>`);

    on(node, 'click', '[data-role="obtainable"] button', (e, t) => { cm.obtainableOnly = t.dataset.v === '1'; commitContext(); repaint(); });
    on(node, 'click', '[data-role="sort"] button', (e, t) => { sortBy = t.dataset.v; repaint(); });
    on(node, 'click', '[data-role="family"] button', (e, t) => { family = t.dataset.v; repaint(); });
    return node;
  }

  function rankRow(r, i, max) {
    const why = [effectSummary(r.skill), ...r.reasons].filter(Boolean).join(' · ');
    const tags = [];
    if (r.debuff) tags.push(`<span class="tag tag--debuff">debuff · ${esc(r.victims.label)}</span>`);
    if (isPassive(r.skill) || (r.skill.duration === 0 && r.skill.effects.some((e) => e.kind === 'stat'))) tags.push('<span class="tag tag--green">passive</span>');
    if (r.skill.wisdomCheck) tags.push('<span class="tag">Wit check</span>');
    const neg = r.bashin < 0;
    return `<div class="rank-row">
      <span class="rank-row__i">${i + 1}</span>
      <span style="min-width:0">
        <span class="row" style="gap:5px;flex-wrap:wrap">${skillPill(r.skill)}${tags.join('')}</span>
        <span class="rank-row__why">${esc(why)}</span>
      </span>
      <span class="rank-row__mid">
        <div class="bar${neg ? ' bar--neg' : ''}"><i style="width:${Math.max(3, (Math.abs(r.bashin) / max) * 100).toFixed(0)}%"></i></div>
        <span class="tiny muted num">${fmt.pct(r.probability)} of the time${r.skill.cost ? ` · ${(r.perSp ?? 0).toFixed(2)}/100 SP` : ''}</span>
      </span>
      <span class="rank-row__score${neg ? ' is-neg' : ''}">${r.bashin.toFixed(2)}</span>
    </div>`;
  }

  function uniqueCard(rows, total) {
    if (!rows.length) return el('<span hidden></span>');
    const course = currentCourse();
    const aptKey = ['', 'sprint', 'mile', 'medium', 'long'][course.distanceType];
    const surfKey = course.surface === 1 ? 'turf' : 'dirt';

    return el(`<section class="panel" data-section="uniques">
      <div class="panel__head"><h3>Uniques that land on this race</h3><span class="sk-count">${rows.length} of ${total}</span></div>
      <div class="panel__body" style="padding:0">
        <div class="rank-list">
          ${rows.map((r, i) => {
    const owners = r.skill.sources.unique.map((id) => db.outfitById.get(id)).filter(Boolean);
    const owner = owners[0];
    const apt = owner ? owner.aptitudeGrades[aptKey] : null;
    const surf = owner ? owner.aptitudeGrades[surfKey] : null;
    return `<div class="rank-row rank-row--uni">
              <span class="rank-row__i">${i + 1}</span>
              ${owner ? `<img src="./img/chara/${esc(owner.id)}.webp" alt="" width="34" height="34" loading="lazy" class="av">` : '<span></span>'}
              <span style="min-width:0">
                ${skillPill(r.skill)}
                <span class="rank-row__why">${esc(owner ? `${owner.charaName} (${owner.epithet}) · ${owner.strategyName}` : 'no Global uma carries this')}${esc(r.reasons.length ? ` · ${r.reasons[0]}` : '')}</span>
              </span>
              <span class="rank-row__mid row" style="gap:4px">
                ${apt ? `<span class="chip">${esc(course.distanceTypeName)} ${esc(apt)}</span>` : ''}
                ${surf ? `<span class="chip chip--${surfKey}">${esc(surf)}</span>` : ''}
              </span>
              <span class="rank-row__score">${r.bashin.toFixed(2)}</span>
            </div>`;
  }).join('')}
        </div>
      </div>
      <div class="panel__foot"><p class="tiny muted">Only uniques that can fire as ${esc(STRATEGY[cm.strategy].name)} on this race, scored the same way as everything else.</p></div>
    </section>`);
  }

  function cardSourcesCard(top) {
    const wanted = new Map(top.map((r) => [r.skill.id, r]));
    const scored = [];
    for (const card of db.supports) {
      if (!card.global) continue;
      const events = card.eventSkills.filter((id) => wanted.has(id));
      const hints = card.hintSkills.filter((id) => wanted.has(id));
      if (!events.length && !hints.length) continue;
      const value = events.reduce((n, id) => n + wanted.get(id).bashin, 0)
        + hints.reduce((n, id) => n + wanted.get(id).bashin * 0.6, 0);
      scored.push({ card, events, hints, value });
    }
    scored.sort((a, b) => b.value - a.value);
    const rows = scored.slice(0, 12);
    if (!rows.length) return el('<span hidden></span>');

    return el(`<section class="panel" data-section="cards">
      <div class="panel__head"><h3>Support cards carrying those skills</h3><span class="sk-count">top ${rows.length}</span></div>
      <div class="panel__body" style="padding:0">
        <div class="rank-list">
          ${rows.map(({ card, events, hints, value }) => `
            <div class="rank-row rank-row--card">
              <img src="./img/support/${esc(card.id)}.webp" alt="" width="40" height="40" loading="lazy" class="av av--card">
              <span style="min-width:0">
                <div style="font-weight:500">${esc(card.name)}</div>
                <div class="chips" style="margin-top:4px">
                  ${events.map((id) => skillPill(db.skillById.get(id), { tag: 'event' })).join('')}
                  ${hints.map((id) => skillPill(db.skillById.get(id), { tag: 'hint' })).join('')}
                </div>
              </span>
              <span class="row" style="justify-content:flex-end">
                <span class="chip chip--accent">${esc(card.rarityName)}</span>
                <span class="chip">${esc(card.typeName)}</span>
              </span>
              <span class="rank-row__score">${value.toFixed(2)}</span>
            </div>`).join('')}
        </div>
      </div>
      <div class="panel__foot"><p class="tiny muted">Event skills count in full because they are guaranteed; hints count at 60% because you still have to roll and buy them.</p></div>
    </section>`);
  }

  function scoringExplainer() {
    return el(`<section class="panel">
      <div class="panel__head"><h3>How the ranking is worked out</h3></div>
      <div class="panel__body">
        <p class="small">Every skill is scored as <b>expected lengths gained on the field</b> for this exact race. In order:</p>
        <ol class="steps">
          <li><b>Can it fire at all?</b> Running style, distance band, surface, handedness, track, going, <b>weather</b> and <b>season</b> are read from the skill's real condition string and applied as hard gates.</li>
          <li><b>Where does it fire?</b> The condition is intersected with the actual course — phase boundaries (the last-spurt phase starts at 5/6, not 2/3), corners, straights, slopes and any <code>distance_rate</code> / <code>remain_distance</code> bound.</li>
          <li><b>How long does it get?</b> Duration scales with race distance, is capped by the run to the line, and a speed bonus loses the seconds it takes to accelerate onto and back off it.</li>
          <li><b>Acceleration is only worth something on a ramp.</b> The model finds every stretch where you are below target speed — the gate, the phase steps, the top of each hill and the run into the last spurt — and asks whether the skill reaches one. On the flat, at target speed, extra acceleration does nothing, and it is now scored that way.</li>
          <li><b>Debuffs are scored as ground the field loses.</b> Slowing the runners ahead of you is worth more per head than slowing the whole field, and slowing the ones behind you is worth almost nothing.</li>
          <li><b>Green skills are stat changes</b>, priced from the same finite difference as the stat table above.</li>
          <li><b>How often?</b> × P(position) from the order model for <em>this</em> field mix at <em>that</em> phase, × the Wit roll, × published odds for anything the closed form cannot check exactly — each one named on the row.</li>
        </ol>
        <p class="tiny muted">Any row can be checked against the full nine-runner simulation on the <a href="#/race">Race</a> page, which runs the field forward at 1/15 s and measures the skill by removing it.</p>
      </div>
    </section>`);
  }

  on(layout, 'click', '[data-jump]', (e, t) => {
    e.preventDefault();
    out.querySelector(`[data-section="${t.dataset.jump}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  paint();
  root.replaceChildren(layout);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`;
}
