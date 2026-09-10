// Every course in the game, read against one build.
//
// The rest of the app answers "what wins on this course". This page answers the
// inverse — "where does this runner belong" — which is the question you have
// before a Champions Meeting round is announced, and the one the per-course
// pages structurally could not reach.
//
// Nothing here is new physics. It is the same closed-form model the Planner
// uses, run 119 × 4 times, which takes long enough to be worth a progress bar
// and not long enough to be worth a worker.

import { db } from '../store.mjs';
import { el, esc, on, fmt, collapsible, icon } from '../ui.mjs';
import { cm, commitContext, fieldStyles, DEFAULT_APT, aptitudesFor } from '../context.mjs';
import {
  STRATEGY, simulateRace, scoreSkill, valueDeck, atUniqueLevel,
  GROUND_NAME, APT_GRADE, temptationChance, aptWit, BASHIN,
} from '../model.mjs';

const STAT_KEYS = ['speed', 'stamina', 'power', 'guts', 'wit'];

let sortBy = 'fit';
let surfaceFilter = 0;
let distanceFilter = 0;
let rows = null;

export function renderCourses(root) {
  const layout = el(`<div class="layout">
    <aside class="rail"></aside>
    <section class="stack">
      <div class="page-head">
        <div>
          <h1>Where this runner belongs</h1>
          <p>Every course on the Global server, scored against the build in the rail — and which running style each one wants.</p>
        </div>
      </div>
      <div data-role="out" class="stack"></div>
    </section>
  </div>`);

  const rail = layout.querySelector('.rail');
  const out = layout.querySelector('[data-role="out"]');

  const controls = el(`<section class="panel panel--rail">
    <div class="panel__head"><h3>The runner</h3><span class="sk-count" data-role="who"></span></div>
    <div class="panel__body">
      <div class="field">
        <label>Running style</label>
        <div class="toggle-grid toggle-grid--row toggle-grid--2" data-role="strategy">
          <button type="button" data-v="0" aria-pressed="false">Best of the four</button>
          ${Object.entries(STRATEGY).map(([v, s]) => `<button type="button" data-v="${v}" aria-pressed="${Number(v) === cm.strategy}">${esc(s.name)}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Going</label>
        <div class="toggle-grid toggle-grid--row" data-role="ground">
          ${Object.entries(GROUND_NAME).map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${Number(v) === cm.ground}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Surface</label>
        <div class="toggle-grid toggle-grid--row" data-role="surface">
          <button type="button" data-v="0" aria-pressed="true">Both</button>
          <button type="button" data-v="1" aria-pressed="false">Turf</button>
          <button type="button" data-v="2" aria-pressed="false">Dirt</button>
        </div>
      </div>
      <div class="field">
        <label>Distance</label>
        <div class="toggle-grid toggle-grid--row toggle-grid--wrap" data-role="distance">
          <button type="button" data-v="0" aria-pressed="true">All</button>
          ${['Sprint', 'Mile', 'Medium', 'Long'].map((n, i) => `<button type="button" data-v="${i + 1}" aria-pressed="false">${n}</button>`).join('')}
        </div>
      </div>
      <p class="hint-line">Stats, aptitudes and the skill list come from the <a href="#/planner">Planner</a>.</p>
    </div>
  </section>`);

  rail.append(collapsible(controls, 'courses.setup'));

  // "Best of the four" is a fifth mode rather than a fifth style, so the strip
  // has to track it separately from cm.strategy.
  let styleMode = cm.strategy;

  on(controls, 'click', '[data-role="strategy"] button', (e, t) => {
    styleMode = Number(t.dataset.v);
    if (styleMode) { cm.strategy = styleMode; commitContext(); }
    controls.querySelectorAll('[data-role="strategy"] button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    rows = null; paint();
  });
  on(controls, 'click', '[data-role="ground"] button', (e, t) => {
    cm.ground = Number(t.dataset.v);
    controls.querySelectorAll('[data-role="ground"] button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    commitContext(); rows = null; paint();
  });
  on(controls, 'click', '[data-role="surface"] button', (e, t) => {
    surfaceFilter = Number(t.dataset.v);
    controls.querySelectorAll('[data-role="surface"] button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    paint();
  });
  on(controls, 'click', '[data-role="distance"] button', (e, t) => {
    distanceFilter = Number(t.dataset.v);
    controls.querySelectorAll('[data-role="distance"] button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    paint();
  });

  /* ------------------------------------------------------------ scoring */

  /**
   * One course, one style: what this build's whole kit is worth on it, priced
   * as a deck rather than as a pile of independent skills, plus the two things
   * that decide whether the course is survivable at all — the stamina it asks
   * for and the share of the last spurt these stats can actually pay for.
   */
  function readCourse(course, strategy, kit) {
    const outfit = cm.you.outfitId ? db.outfitById.get(cm.you.outfitId) : null;
    const aptitudes = outfit && cm.you.lockAptitudes
      ? aptitudesFor(outfit, course, strategy)
      : { ...cm.aptitudes };
    const styles = fieldStyles();
    styles[0] = strategy;
    const ctx = {
      course,
      strategy,
      ground: cm.ground,
      weather: cm.weather,
      season: cm.season,
      fieldSize: cm.fieldSize,
      fieldStyles: styles,
      aptitudes,
      stats: cm.stats,
      recoveryPct: cm.recovery,
      uniqueLevel: cm.you.uniqueLevel,
    };
    ctx.sim = simulateRace(ctx);
    const deck = kit.length ? valueDeck(kit, ctx) : { total: 0, naive: 0, rows: [] };
    return {
      strategy,
      aptitudes,
      sim: ctx.sim,
      skills: deck.total,
      // A course you cannot run to the line is not a course you belong on,
      // whatever the skills are worth: the shortfall is charged in the same
      // unit as everything else rather than shown as a separate warning.
      staminaGap: Math.max(0, ctx.sim.requiredStamina - cm.stats.stamina),
      spurt: ctx.sim.spurtCoverage,
      kakari: temptationChance(cm.stats.wit * aptWit(aptitudes)),
      fit: deck.total - staminaPenalty(ctx.sim),
    };
  }

  /** Lengths given up by not being able to spurt the whole final leg. */
  function staminaPenalty(sim) {
    if (sim.spurtCoverage >= 0.999) return 0;
    const lost = (1 - sim.spurtCoverage) * (sim.speeds.spurt - sim.speeds.v2);
    return (lost * (sim.time / 3)) / BASHIN;
  }

  function build() {
    const kit = [];
    const outfit = cm.you.outfitId ? db.outfitById.get(cm.you.outfitId) : null;
    if (outfit?.uniqueId && cm.you.unique) {
      const u = db.skillById.get(outfit.uniqueId);
      if (u) kit.push(atUniqueLevel(u, cm.you.uniqueLevel));
    }
    for (const id of cm.raceSkills) { const s = db.skillById.get(id); if (s) kit.push(s); }

    const styles = styleMode ? [styleMode] : [1, 2, 3, 4];
    return db.courses.map((course) => {
      const reads = styles.map((s) => readCourse(course, s, kit));
      const best = reads.reduce((a, b) => (b.fit > a.fit ? b : a));
      return { course, reads, best };
    });
  }

  /* ------------------------------------------------------------- painting */

  function paint() {
    controls.querySelector('[data-role="who"]').textContent = cm.you.outfitId
      ? db.outfitById.get(cm.you.outfitId).charaName
      : `${fmt.int(cm.stats.speed)} spd · ${fmt.int(cm.stats.stamina)} sta`;

    if (!rows) rows = build();
    let list = rows;
    if (surfaceFilter) list = list.filter((r) => r.course.surface === surfaceFilter);
    if (distanceFilter) list = list.filter((r) => r.course.distanceType === distanceFilter);

    const sorted = [...list].sort((a, b) => {
      if (sortBy === 'stamina') return a.best.staminaGap - b.best.staminaGap || b.best.fit - a.best.fit;
      if (sortBy === 'distance') return a.course.distance - b.course.distance;
      if (sortBy === 'track') return a.course.trackName.localeCompare(b.course.trackName) || a.course.distance - b.course.distance;
      return b.best.fit - a.best.fit;
    });

    const max = Math.max(...sorted.map((r) => r.best.fit), 0.01);
    const runnable = sorted.filter((r) => r.best.staminaGap <= 0).length;

    out.replaceChildren(
      summaryCard(sorted, runnable),
      tableCard(sorted, max),
    );
  }

  function summaryCard(sorted, runnable) {
    if (!sorted.length) return el('<span hidden></span>');
    const top = sorted.slice().sort((a, b) => b.best.fit - a.best.fit)[0];
    const worst = sorted.slice().sort((a, b) => a.best.fit - b.best.fit)[0];
    const kit = cm.raceSkills.length + (cm.you.outfitId && cm.you.unique ? 1 : 0);

    return el(`<section class="panel">
      <div class="panel__head">
        <h3>${icon('route', { size: 14 })}${sorted.length} courses read</h3>
        <span class="sk-count">${kit} skill${kit === 1 ? '' : 's'} · ${styleMode ? esc(STRATEGY[styleMode].name) : 'best style per course'}</span>
      </div>
      <div class="panel__body">
        <div class="kpi-row">
          <div class="kpi kpi--good">
            <span class="kpi__v">${top.course.distance}m</span>
            <span class="kpi__k">best fit — ${esc(top.course.trackName)} ${esc(top.course.surfaceName)}
            as ${esc(STRATEGY[top.best.strategy].short)}, ${top.best.fit.toFixed(2)} lengths</span>
          </div>
          <div class="kpi kpi--${runnable === sorted.length ? 'good' : 'warn'}">
            <span class="kpi__v">${runnable}/${sorted.length}</span>
            <span class="kpi__k">you can run to the line at ${fmt.int(cm.stats.stamina)} Stamina</span>
          </div>
          <div class="kpi kpi--bad">
            <span class="kpi__v">${worst.course.distance}m</span>
            <span class="kpi__k">worst fit — ${esc(worst.course.trackName)} ${esc(worst.course.surfaceName)},
            ${worst.best.fit.toFixed(2)} lengths</span>
          </div>
        </div>
        <details class="explain">
          <summary>What “fit” is</summary>
          <p>The whole kit you have set on the Planner, <b>priced as a deck</b> on that course — so two heals or three
          acceleration skills are charged once for the stamina hole and once for the ramp, not once each —
          <b>minus what falling short of a full last spurt costs you</b> on that course at these stats.
          It is the same unit as everywhere else: lengths on the field at the line.</p>
          <p>With <b>best style per course</b> selected, each course is read four times and keeps its best; the
          style column says which one won. That is not always the style you would run — check the aptitude before
          believing it.</p>
        </details>
      </div>
    </section>`);
  }

  function tableCard(sorted, max) {
    const node = el(`<section class="panel">
      <div class="panel__head panel__head--wrap">
        <h3>Course by course</h3>
        <div class="seg" data-role="sort">
          <button type="button" data-v="fit" aria-pressed="${sortBy === 'fit'}">By fit</button>
          <button type="button" data-v="stamina" aria-pressed="${sortBy === 'stamina'}">By stamina need</button>
          <button type="button" data-v="distance" aria-pressed="${sortBy === 'distance'}">By distance</button>
          <button type="button" data-v="track" aria-pressed="${sortBy === 'track'}">By track</button>
        </div>
      </div>
      <div class="panel__body" style="padding:0">
        <div class="table-wrap"><table>
          <thead><tr>
            <th>Course</th><th>Style</th><th class="num">Fit</th><th></th>
            <th class="num">Stamina</th><th class="num">Spurt</th><th class="num">Kakari</th>
          </tr></thead>
          <tbody>${sorted.slice(0, 140).map((r) => {
    const b = r.best;
    const short = b.staminaGap > 0;
    return `<tr>
              <td>
                <b>${esc(r.course.trackName)} ${r.course.distance}m</b>
                <div class="tiny muted">${esc(r.course.surfaceName)} · ${esc(r.course.turnName)} · ${esc(r.course.distanceTypeName)}</div>
              </td>
              <td><span class="chip chip--style${b.strategy}">${esc(STRATEGY[b.strategy].short)}</span></td>
              <td class="num${b.fit < 0 ? ' is-neg' : ''}">${b.fit.toFixed(2)}</td>
              <td style="width:110px"><span class="bar${b.fit < 0 ? ' bar--neg' : ''}"><i style="width:${Math.max(0, Math.min(100, (b.fit / max) * 100)).toFixed(0)}%"></i></span></td>
              <td class="num${short ? ' is-neg' : ''}">${short ? `+${fmt.int(b.staminaGap)} short` : fmt.int(b.sim.requiredStamina)}</td>
              <td class="num${b.spurt < 0.999 ? ' is-neg' : ''}">${Math.round(b.spurt * 100)}%</td>
              <td class="num muted">${(b.kakari * 100).toFixed(1)}%</td>
            </tr>`;
  }).join('')}</tbody>
        </table></div>
      </div>
      <div class="panel__foot"><p class="tiny muted">
        <b>Stamina</b> is what this course asks for at this going and style — or how far short you are.
        <b>Spurt</b> is the share of the final leg you can run flat out; below 100% the fit column has already been
        charged for it. <b>Kakari</b> is the pace-up chance from your Wit and style aptitude, which does not move
        between courses but does move between styles.
        ${sorted.length > 140 ? `Showing the first 140 of ${sorted.length}.` : ''}</p></div>
    </section>`);

    on(node, 'click', '[data-role="sort"] button', (e, t) => { sortBy = t.dataset.v; paint(); });
    return node;
  }

  rows = null;
  paint();
  root.replaceChildren(layout);
}
