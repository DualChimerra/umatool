// The advanced field editor: every rival built out by hand.
//
// The simple headcount answers "how many Front Runners am I up against". This
// answers the harder version — *which* Front Runners, on what stats, carrying
// what. Picking an umamusume pulls in its unique and its aptitudes for this
// exact race, so the only thing left to decide is the stat line and the skills.

import { db, isObtainable } from '../store.mjs';
import { el, esc, on, skillPill } from '../ui.mjs';
import {
  cm, commitContext, currentCourse, scoringContext, emptyRival,
  normaliseField, aptitudesFor,
} from '../context.mjs';
import { STRATEGY, APT_GRADE, simulateRace, rankSkills } from '../model.mjs';
import { clearFieldCache } from '../race/field.mjs';
import { pickUma, pickSkill, pickerOpen } from './picker.mjs';

const STAT_KEYS = [['speed', 'Spd'], ['stamina', 'Sta'], ['power', 'Pwr'], ['guts', 'Gut'], ['wit', 'Wit']];

let drawer = null;
let onDone = null;
let openIndex = 0;

export function openFieldEditor(done) {
  onDone = done;
  cm.field.mode = 'advanced';
  normaliseField();
  ensure();
  paint();
  drawer.hidden = false;
}

function close() {
  if (drawer) drawer.hidden = true;
  commitContext();
  clearFieldCache();
  onDone?.();
}

function ensure() {
  if (drawer) return drawer;
  drawer = el(`<div class="drawer" hidden>
    <div class="drawer__scrim" data-act="close"></div>
    <aside class="drawer__panel drawer__panel--wide" role="dialog" aria-modal="true" aria-label="Field editor">
      <header class="drawer__head">
        <div style="flex:1;min-width:0">
          <h2>The field</h2>
          <p class="tiny muted" data-role="sub"></p>
        </div>
        <button class="icon-btn" data-act="close" type="button" aria-label="Close">✕</button>
      </header>
      <div class="drawer__tools">
        <button class="btn btn--sm" type="button" data-act="auto">Fill from the best umas here</button>
        <button class="btn btn--sm btn--ghost" type="button" data-act="spread">Even style spread</button>
        <button class="btn btn--sm btn--ghost" type="button" data-act="clear">Clear all</button>
      </div>
      <div class="drawer__scroll" data-role="list"></div>
    </aside>
  </div>`);
  document.body.append(drawer);
  on(drawer, 'click', '[data-act="close"]', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer && !drawer.hidden && !pickerOpen()) close();
  });

  on(drawer, 'click', '[data-rival-head]', (e, t) => {
    openIndex = openIndex === Number(t.dataset.rivalHead) ? -1 : Number(t.dataset.rivalHead);
    paint();
  });
  on(drawer, 'click', '[data-style-set]', (e, t) => {
    const [i, v] = t.dataset.styleSet.split(':').map(Number);
    cm.field.rivals[i].strategy = v;
    commitContext(); paint();
  });
  on(drawer, 'click', '[data-pick-uma]', (e, t) => chooseUma(Number(t.dataset.pickUma)));
  on(drawer, 'click', '[data-clear-uma]', (e, t) => {
    cm.field.rivals[Number(t.dataset.clearUma)].outfitId = null;
    commitContext(); paint();
  });
  on(drawer, 'click', '[data-toggle-unique]', (e, t) => {
    const r = cm.field.rivals[Number(t.dataset.toggleUnique)];
    r.unique = !r.unique;
    commitContext(); paint();
  });
  on(drawer, 'input', 'input[data-rstat]', (e, t) => {
    const [i, key] = t.dataset.rstat.split(':');
    cm.field.rivals[i].stats[key] = Number(t.value);
    t.parentElement.querySelector('output').textContent = t.value;
    commitContext();
  });
  on(drawer, 'click', '[data-copy-stats]', (e, t) => {
    const src = cm.field.rivals[Number(t.dataset.copyStats)].stats;
    for (const r of cm.field.rivals) r.stats = { ...src };
    commitContext(); paint();
  });
  on(drawer, 'click', '[data-add-skill]', (e, t) => chooseSkill(Number(t.dataset.addSkill)));
  on(drawer, 'click', '[data-drop-skill]', (e, t) => {
    const [i, id] = t.dataset.dropSkill.split(':');
    const r = cm.field.rivals[i];
    r.skills = r.skills.filter((s) => s !== id);
    commitContext(); paint();
  });
  on(drawer, 'click', '[data-auto-skills]', (e, t) => {
    const i = Number(t.dataset.autoSkills);
    const r = cm.field.rivals[i];
    const ctx = scoringContext();
    const sub = { ...ctx, strategy: r.strategy, stats: r.stats };
    sub.sim = simulateRace(sub);
    r.skills = rankSkills(db.learnable.filter(isObtainable), sub, { tiers: ['gold', 'normal'], limit: 6 })
      .map((x) => x.skill.id);
    commitContext(); paint();
  });

  on(drawer, 'click', '[data-act="auto"]', autoFill);
  on(drawer, 'click', '[data-act="spread"]', () => {
    cm.field.rivals.forEach((r, i) => { r.strategy = [1, 2, 3, 4][i % 4]; });
    commitContext(); paint();
  });
  on(drawer, 'click', '[data-act="clear"]', () => {
    cm.field.rivals = cm.field.rivals.map((r, i) => emptyRival([1, 2, 3, 4][i % 4]));
    commitContext(); paint();
  });
  return drawer;
}

/** Fill the field with the umamusume this course actually rewards. */
function autoFill() {
  const course = currentCourse();
  const ctx = scoringContext();
  const aptDistance = ['', 'sprint', 'mile', 'medium', 'long'][course.distanceType];
  const aptSurface = course.surface === 1 ? 'turf' : 'dirt';
  const byStyle = new Map();
  for (const o of db.globalOutfits) {
    if ((o.aptitudes[aptDistance] ?? 0) < 6 || (o.aptitudes[aptSurface] ?? 0) < 6) continue;
    const list = byStyle.get(o.strategy) ?? [];
    list.push(o);
    byStyle.set(o.strategy, list);
  }
  const used = new Set();
  for (const [i, r] of cm.field.rivals.entries()) {
    const pool = (byStyle.get(r.strategy) ?? []).filter((o) => !used.has(o.charaId));
    const pick = pool[i % Math.max(1, pool.length)];
    if (!pick) continue;
    used.add(pick.charaId);
    r.outfitId = pick.id;
    r.unique = true;
    const sub = { ...ctx, strategy: r.strategy, stats: r.stats };
    sub.sim = simulateRace(sub);
    r.skills = rankSkills(db.learnable.filter(isObtainable), sub, { tiers: ['gold', 'normal'], limit: 5 })
      .map((x) => x.skill.id);
  }
  commitContext();
  paint();
}

/* --------------------------------------------------------------- painting */

function paint() {
  if (!drawer) return;
  const course = currentCourse();
  drawer.querySelector('[data-role="sub"]').textContent =
    `${cm.field.rivals.length} rivals · ${course.trackName} ${course.distance}m ${course.surfaceName}`;

  drawer.querySelector('[data-role="list"]').innerHTML = cm.field.rivals.map((r, i) => {
    const o = r.outfitId ? db.outfitById.get(r.outfitId) : null;
    const apt = o ? aptitudesFor(o, course, r.strategy) : null;
    const unique = o?.uniqueId ? db.skillById.get(o.uniqueId) : null;
    const open = i === openIndex;
    return `<section class="rival ${open ? 'is-open' : ''}">
      <button class="rival__head" type="button" data-rival-head="${i}" aria-expanded="${open}">
        ${o ? `<img src="./img/chara/${esc(o.id)}.webp" alt="" width="34" height="34" class="av">` : '<span class="av av--empty">?</span>'}
        <span class="rival__title">
          <b>${esc(o ? o.charaName : `Rival ${i + 1}`)}</b>
          <span class="tiny muted">${esc(o ? o.epithet : 'no umamusume picked')}</span>
        </span>
        <span class="chip chip--style${r.strategy}">${esc(STRATEGY[r.strategy].short)}</span>
        ${apt ? `<span class="chip">${esc(APT_GRADE[apt.distance])}/${esc(APT_GRADE[apt.surface])}/${esc(APT_GRADE[apt.style])}</span>` : ''}
        <span class="tiny muted num">${r.skills.length + (unique && r.unique ? 1 : 0)} skills</span>
        <span class="rival__chev" aria-hidden="true">▾</span>
      </button>
      ${open ? `<div class="rival__body">
        <div class="field">
          <label>Umamusume</label>
          <div class="row" style="gap:6px">
            <button class="btn btn--sm" type="button" data-pick-uma="${i}">${o ? 'Change' : 'Pick an uma'}</button>
            ${o ? `<button class="btn btn--sm btn--ghost" type="button" data-clear-uma="${i}">Clear</button>` : ''}
            ${unique ? `<label class="check"><input type="checkbox" ${r.unique ? 'checked' : ''} data-toggle-unique="${i}"> carries ${esc(unique.name)}</label>` : ''}
          </div>
        </div>
        <div class="field">
          <label>Running style</label>
          <div class="toggle-grid">
            ${[1, 2, 3, 4].map((v) => `<button type="button" data-style-set="${i}:${v}" aria-pressed="${r.strategy === v}">${esc(STRATEGY[v].short)}</button>`).join('')}
          </div>
        </div>
        <div class="field">
          <label>Stats <button class="btn btn--ghost btn--xs" type="button" data-copy-stats="${i}">copy to every rival</button></label>
          ${STAT_KEYS.map(([k, label]) => `
            <div class="range-row range-row--tight">
              <span class="range-row__label">${label}</span>
              <input type="range" min="100" max="${cm.statCap}" step="10" value="${r.stats[k]}" data-rstat="${i}:${k}">
              <output class="num">${r.stats[k]}</output>
            </div>`).join('')}
        </div>
        <div class="field">
          <label>Skills <button class="btn btn--ghost btn--xs" type="button" data-auto-skills="${i}">best 6 for this style</button></label>
          <div class="chips">
            ${unique && r.unique ? skillPill(unique, { tag: 'unique' }) : ''}
            ${r.skills.map((id) => {
    const s = db.skillById.get(id);
    return s ? `<span class="chip-drop">${skillPill(s)}<button type="button" class="chip-drop__x" data-drop-skill="${i}:${esc(id)}" aria-label="remove">✕</button></span>` : '';
  }).join('')}
            <button class="btn btn--sm btn--ghost" type="button" data-add-skill="${i}">+ skill</button>
          </div>
        </div>
      </div>` : ''}
    </section>`;
  }).join('');
}

/* ----------------------------------------------------------- sub-pickers */

function chooseUma(index) {
  pickUma((id) => {
    const o = db.outfitById.get(id);
    const r = cm.field.rivals[index];
    r.outfitId = o.id;
    r.strategy = o.strategy;
    r.unique = true;
    commitContext();
    paint();
  }, { title: `Rival ${index + 1}` });
}

function chooseSkill(index) {
  const r = cm.field.rivals[index];
  pickSkill((id) => {
    if (!r.skills.includes(id)) r.skills.push(id);
    commitContext();
    paint();
  }, { title: `Add a skill to rival ${index + 1}`, exclude: r.skills });
}
