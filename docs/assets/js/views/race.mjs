// The race itself.
//
// Everywhere else in this app a skill is a number. Here it is a horse: the
// whole field is run forward at 1/15 s, hundreds of times, and what comes out
// is the only question that decides a Champions Meeting round — how often do
// you win, and by how much.
//
// It also settles arguments with the ranking. Pick a skill, and the page runs
// the field with it and without it on identical seeds and reports the
// difference. Where that disagrees with the Planner's score, the simulation is
// the one to believe.

import { db, isObtainable } from '../store.mjs';
import { el, esc, on, skillPill, fmt, collapsible, skillOption } from '../ui.mjs';
import { combobox } from '../combobox.mjs';
import {
  cm, commitContext, currentCourse, scoringContext, fieldSummary, yourSkills, normaliseField,
  buildRunner, saveBuild,
} from '../context.mjs';
import {
  STRATEGY, simulateRace, rankSkills, scoreSkill, BASHIN, atUniqueLevel,
  GROUND_NAME, WEATHER_NAME, SEASON_NAME,
} from '../model.mjs';
import { runRace, LIMITATIONS, DT } from '../race/sim.mjs';
import { buildSetup, FIELD_PRESETS, clearFieldCache } from '../race/field.mjs';

/**
 * Hand the page back to the browser between slices.
 *
 * `setTimeout(0)` is clamped — to 4 ms nested, and to a full second once the
 * tab is in the background — which turned a 17-second measurement into a
 * minute of mostly waiting. A MessageChannel message is a plain macrotask and
 * is not clamped, so the loop yields for exactly as long as painting takes.
 */
const yieldToUi = () => new Promise((resolve) => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
  ch.port2.postMessage(0);
});

let lastResult = null;
let lastVerdicts = null;
let lastSweep = null;
let lastDuel = null;
let duelPick = { a: '', b: '' };
let busy = false;

/** Percentage-point half-width of a 95% interval on a paired rate. */
function pairedHalfWidth(sum, sumSq, n) {
  if (n < 2) return Infinity;
  const mean = sum / n;
  const variance = Math.max(0, (sumSq - n * mean * mean) / (n - 1));
  return 1.96 * Math.sqrt(variance / n);
}

export function renderRace(root) {
  const layout = el(`<div class="layout">
    <aside class="rail"></aside>
    <section class="stack">
      <div class="page-head">
        <div>
          <h1>Race simulation</h1>
          <p>The whole field, run forward tick by tick. Set it up on the Planner; this page runs it.</p>
        </div>
        <div class="page-head__right" data-role="chip"></div>
      </div>
      <div data-role="out" class="stack"></div>
    </section>
  </div>`);

  const rail = layout.querySelector('.rail');
  const out = layout.querySelector('[data-role="out"]');

  const runnerPanel = el(`<section class="panel panel--rail">
    <div class="panel__head"><h3>Your runner</h3><span class="sk-count" data-role="you"></span></div>
    <div class="panel__body">
      <div class="btn-row">
        <button class="btn btn--sm" type="button" data-act="fill">Top 6</button>
        <button class="btn btn--sm btn--ghost" type="button" data-act="fill-priority">Priority list</button>
        <button class="btn btn--sm btn--ghost" type="button" data-act="clear">Clear</button>
      </div>
      <div class="field" style="position:relative">
        <div data-role="search"></div>
      </div>
      <div class="chips" data-role="mine"></div>
    </div>
  </section>`);

  const runPanel = el(`<section class="panel panel--rail">
    <div class="panel__head"><h3>Simulation</h3></div>
    <div class="panel__body">
      <div class="field">
        <label>Races to run <span class="muted" data-out="runs">${cm.simRuns}</span></label>
        <input type="range" min="40" max="600" step="20" data-role="runs" value="${cm.simRuns}">
      </div>
      <button class="btn btn--primary" type="button" data-act="run">Run the race</button>
      <div class="progress" data-role="prog" hidden><i></i><span></span></div>
    </div>
  </section>`);

  rail.append(collapsible(runnerPanel, 'race.you'), collapsible(runPanel, 'race.run'));

  /* ------------------------------------------------------- skill picking */

  runnerPanel.querySelector('[data-role="search"]').append(combobox({
    placeholder: 'Add a skill…',
    search: (needle) => db.learnable
      .filter((s) => s.name.toLowerCase().includes(needle.toLowerCase()) && !cm.raceSkills.includes(s.id))
      .slice(0, 24),
    row: skillOption,
    onPick: (skill) => { cm.raceSkills.push(skill.id); commitContext(); paintMine(); },
  }).element);

  on(runnerPanel, 'click', '[data-drop]', (e, t) => {
    cm.raceSkills = cm.raceSkills.filter((id) => id !== t.dataset.drop);
    commitContext(); paintMine();
  });
  on(runnerPanel, 'click', '[data-act="clear"]', () => { cm.raceSkills = []; commitContext(); paintMine(); });
  on(runnerPanel, 'click', '[data-act="fill-priority"]', () => {
    cm.raceSkills = [...new Set([...cm.raceSkills, ...cm.priority])];
    commitContext(); paintMine();
  });
  on(runnerPanel, 'click', '[data-act="fill"]', () => {
    const ctx = scoringContext();
    ctx.sim = simulateRace({ ...ctx, recoveryPct: cm.recovery });
    const top = rankSkills(db.learnable.filter(isObtainable), ctx, { tiers: ['gold', 'normal'], limit: 6 });
    cm.raceSkills = [...new Set([...cm.raceSkills, ...top.map((r) => r.skill.id)])];
    commitContext(); paintMine();
  });

  function paintMine() {
    const mine = runnerPanel.querySelector('[data-role="mine"]');
    const outfit = cm.you.outfitId ? db.outfitById.get(cm.you.outfitId) : null;
    const unique = outfit?.uniqueId && cm.you.unique ? db.skillById.get(outfit.uniqueId) : null;
    const bits = [];
    if (unique) bits.push(`<span class="chip-drop">${skillPill(unique, { tag: `Lv${cm.you.uniqueLevel}` })}</span>`);
    for (const id of cm.raceSkills) {
      const s = db.skillById.get(id);
      if (s) bits.push(`<span class="chip-drop">${skillPill(s)}<button type="button" class="chip-drop__x" data-drop="${esc(id)}" aria-label="remove">\u2715</button></span>`);
    }
    mine.innerHTML = bits.length ? bits.join('')
      : '<p class="hint-line">No skills picked yet.</p>';
    const ctx = scoringContext();
    runnerPanel.querySelector('[data-role="you"]').textContent =
      `${outfit ? `${outfit.charaName} · ` : ''}${STRATEGY[ctx.strategy].short} · ${yourSkills().length} skills`;
  }
  paintMine();

  runPanel.querySelector('[data-role="runs"]').addEventListener('input', (e) => {
    cm.simRuns = Number(e.target.value);
    runPanel.querySelector('[data-out="runs"]').textContent = cm.simRuns;
    commitContext();
  });
  on(runPanel, 'click', '[data-act="run"]', () => run());

  /* ------------------------------------------------------------- running */

  function setup() {
    const ctx = scoringContext();
    ctx.sim = simulateRace({ ...ctx, recoveryPct: cm.recovery });
    // No skill override: buildSetup takes your uma, its unique at the level
    // you set, and the list you built on the Planner.
    return buildSetup({}, ctx);
  }

  const progress = runPanel.querySelector('[data-role="prog"]');
  function showProgress(done, total, label) {
    progress.hidden = false;
    progress.querySelector('i').style.width = `${Math.round((done / total) * 100)}%`;
    progress.querySelector('span').textContent = label;
  }

  /** Run in slices so the page keeps breathing. */
  async function chunked(total, step, fn, label) {
    for (let i = 0; i < total; i += step) {
      const n = Math.min(step, total - i);
      fn(i, n);
      showProgress(i + n, total, `${label} ${i + n}/${total}`);
      // eslint-disable-next-line no-await-in-loop
      await yieldToUi();
    }
    progress.hidden = true;
  }

  async function run() {
    if (busy) return;
    busy = true;
    const btn = runPanel.querySelector('[data-act="run"]');
    btn.disabled = true;
    try {
      const { setup: s, notes } = setup();
      const runs = cm.simRuns;
      const n = s.runners.length;
      const acc = s.runners.map((r) => ({
        def: r, name: r.name, wins: 0, top3: 0, places: new Array(n).fill(0),
        time: 0, margin: 0, hp: 0, spurt: 0, outOfHp: 0,
      }));
      let done = 0;
      await chunked(runs, 20, (start, count) => {
        for (let i = 0; i < count; i += 1) {
          const { order, runners } = runRace(s, 12345 + (start + i) * 7919);
          const winner = order[0].finishTime;
          for (let k = 0; k < runners.length; k += 1) {
            const r = runners[k]; const a = acc[k];
            a.places[r.place - 1] += 1;
            if (r.place === 1) a.wins += 1;
            if (r.place <= 3) a.top3 += 1;
            a.time += r.finishTime;
            a.margin += (r.finishTime - winner) * r.speeds.spurt / BASHIN;
            a.hp += r.hp;
            a.spurt += Math.min(1, (s.course.distance - r.spurtStart) / (s.course.distance / 3));
            if (r.hp <= 0) a.outOfHp += 1;
          }
          done += 1;
        }
      }, 'racing');
      for (const a of acc) {
        a.winRate = a.wins / done;
        a.top3Rate = a.top3 / done;
        a.meanTime = a.time / done;
        a.meanMargin = a.margin / done;
        a.meanHp = a.hp / done;
        a.meanSpurt = a.spurt / done;
        a.outOfHpRate = a.outOfHp / done;
        a.placeRates = a.places.map((c) => c / done);
      }
      const replay = runRace(s, 12345, { trace: true });
      lastResult = { setup: s, acc, runs: done, replay, notes };
      lastVerdicts = null;
      paint();
    } finally {
      busy = false;
      btn.disabled = false;
    }
  }

  /* ------------------------------------------------- field-mix sensitivity */

  /**
   * The same build against the fields you might actually draw.
   *
   * Every other number on the site is conditioned on one exact field mix, and
   * in a Champions Meeting you do not get one — you get a draw. A build that
   * wins 61% against a balanced field and 34% against four front runners is a
   * worse pick than a flatter one, and nothing here could say so before.
   *
   * Each scenario is raced on the *same seeds*, so the differences between
   * them are differences in the field rather than in the dice.
   */
  async function sweepField() {
    if (busy) return;
    busy = true;
    const btn = layout.querySelector('[data-act="sweep"]');
    if (btn) btn.disabled = true;

    const savedCounts = { ...cm.field.counts };
    const savedMode = cm.field.mode;
    const rivals = Math.max(1, cm.fieldSize - 1);
    // Presets are written for an eight-rival field, so they are re-proportioned
    // to whatever field size is actually set rather than silently truncated.
    const scaleTo = (counts) => {
      const raw = Object.values(counts).reduce((a, b) => a + b, 0);
      return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round((v / raw) * rivals)]));
    };
    const scenarios = [
      { key: 'yours', name: 'The field you set', counts: { ...savedCounts }, hint: 'What the rest of the app is scored against.' },
      ...FIELD_PRESETS.map((p) => ({ key: p.key, name: p.name, counts: scaleTo(p.counts), hint: p.hint })),
    ];

    const runs = Math.max(40, Math.round(cm.simRuns / 2));
    const results = [];
    try {
      // The sweep has to vary the field, and the field is read off `cm` deep
      // inside buildSetup — so it is set, raced, and put back.
      cm.field.mode = 'simple';
      for (const sc of scenarios) {
        cm.field.counts = { ...sc.counts };
        normaliseField();
        clearFieldCache();
        const { setup: s } = setup();
        let wins = 0; let top3 = 0; let margin = 0;
        // eslint-disable-next-line no-await-in-loop
        await chunked(runs, 20, (start, count) => {
          for (let i = 0; i < count; i += 1) {
            const { order, runners } = runRace(s, 4242 + (start + i) * 7919);
            const me = runners[0];
            if (me.place === 1) wins += 1;
            if (me.place <= 3) top3 += 1;
            margin += (me.finishTime - order[0].finishTime) * me.speeds.spurt / BASHIN;
          }
        }, `${sc.name} —`);
        results.push({
          ...sc,
          winRate: wins / runs,
          top3Rate: top3 / runs,
          meanMargin: margin / runs,
          summary: fieldSummary(),
        });
      }
    } finally {
      cm.field.counts = savedCounts;
      cm.field.mode = savedMode;
      normaliseField();
      clearFieldCache();
      busy = false;
      if (btn) btn.disabled = false;
      progress.hidden = true;
    }

    lastSweep = { rows: results, runs };
    paint();
  }

  /* --------------------------------------------------------- build duel */

  /**
   * Two saved builds, same race, same seeds, one answer.
   *
   * Not "which scored higher on the Planner" — both are actually run against
   * the same field on the same draws, and the difference is reported with the
   * interval that says whether it is a difference at all.
   */
  async function duel() {
    if (busy) return;
    const a = cm.builds.find((x) => x.id === duelPick.a);
    const b = cm.builds.find((x) => x.id === duelPick.b);
    if (!a || !b) return;
    busy = true;
    const btn = layout.querySelector('[data-act="duel"]');
    if (btn) btn.disabled = true;

    try {
      const { setup: s } = setup();
      const runs = Math.max(40, Math.round(cm.simRuns / 2));
      const sides = [buildRunner(a), buildRunner(b)];
      const acc = sides.map(() => ({ wins: 0, top3: 0, time: 0, lead: 0 }));
      let dw = 0; let dw2 = 0; let dl = 0; let dl2 = 0;

      await chunked(runs, 10, (start, count) => {
        for (let i = 0; i < count; i += 1) {
          const seed = 777 + (start + i) * 7919;
          const lead = [0, 0];
          const won = [0, 0];
          for (let k = 0; k < 2; k += 1) {
            const who = sides[k];
            const trial = {
              ...s,
              runners: s.runners.map((r, idx) => (idx === 0 ? {
                ...r,
                name: who.name,
                outfit: who.outfit,
                strategy: who.strategy,
                stats: who.stats,
                aptitudes: who.aptitudes,
                skills: who.skills.map((sk) => atUniqueLevel(sk, who.uniqueLevel)),
              } : r)),
            };
            const { runners } = runRace(trial, seed);
            const me = runners[0];
            let rival = 0;
            for (let j = 1; j < runners.length; j += 1) rival += runners[j].finishTime;
            rival /= (runners.length - 1);
            const speed = s.course.distance / Math.max(1, me.finishTime);
            lead[k] = (rival - me.finishTime) * speed / BASHIN;
            won[k] = me.place === 1 ? 1 : 0;
            acc[k].wins += won[k];
            if (me.place <= 3) acc[k].top3 += 1;
            acc[k].time += me.finishTime;
            acc[k].lead += lead[k];
          }
          const w = won[0] - won[1];
          const l = lead[0] - lead[1];
          dw += w; dw2 += w * w; dl += l; dl2 += l * l;
        }
      }, 'racing both builds —');

      lastDuel = {
        runs,
        a: { build: a, ...acc[0] },
        b: { build: b, ...acc[1] },
        winDiff: dw / runs,
        winCi: pairedHalfWidth(dw, dw2, runs),
        leadDiff: dl / runs,
        leadCi: pairedHalfWidth(dl, dl2, runs),
      };
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
      progress.hidden = true;
    }
    paint();
  }

  /* -------------------------------------------------- skill verification */

  /**
   * Measure a list of skills against the same field, on the same seeds.
   *
   * The loop is over seeds, not over skills: for one seed every variant of the
   * runner is raced back to back. That keeps the paired comparison exact, lets
   * the progress bar move smoothly, and — because a slice is a few dozen
   * milliseconds rather than a couple of seconds — keeps the page responsive.
   */
  async function verify() {
    if (busy) return;
    busy = true;
    try {
      const { setup: s } = setup();
      const ctx = scoringContext();
      ctx.sim = simulateRace({ ...ctx, recoveryPct: cm.recovery });

      const candidates = [];
      for (const id of cm.raceSkills) { const sk = db.skillById.get(id); if (sk) candidates.push(sk); }
      const top = rankSkills(db.learnable.filter(isObtainable), ctx, { tiers: ['gold', 'normal'], limit: 14 });
      for (const r of top) if (!candidates.some((c) => c.id === r.skill.id)) candidates.push(r.skill);

      const kit = s.runners[0].skills ?? [];
      const has = new Set(kit.map((k) => k.id));
      const variants = [{ skills: kit }, ...candidates.map((sk) => ({
        skill: sk,
        carried: has.has(sk.id),
        skills: has.has(sk.id) ? kit.filter((k) => k.id !== sk.id) : [...kit, sk],
      }))];
      // Each variant is run on the same seed as the baseline, so the honest
      // statistic is the *per-seed difference*, not the gap between two means:
      // the shared draw cancels and the variance collapses. Accumulating its
      // square as well is what turns "+0.05" into "+0.05 ± 0.11, not separable".
      const acc = variants.map(() => ({ lead: 0, mine: 0, rival: 0, wins: 0, d: 0, d2: 0, dw: 0, dw2: 0 }));

      const runsEach = Math.max(30, Math.min(140, Math.round(cm.simRuns / 2)));
      const budget = variants.length * runsEach;
      const n = s.runners.length;
      for (let i = 0; i < runsEach; i += 1) {
        const seed = 999 + i * 7919;
        const lead = new Array(variants.length);
        const won = new Array(variants.length);
        for (let v = 0; v < variants.length; v += 1) {
          const trial = { ...s, runners: s.runners.map((r, k) => (k === 0 ? { ...r, skills: variants[v].skills } : r)) };
          const { runners } = runRace(trial, seed);
          const me = runners[0];
          let rival = 0;
          for (let k = 1; k < n; k += 1) rival += runners[k].finishTime;
          rival /= (n - 1);
          const speed = s.course.distance / Math.max(1, me.finishTime);
          lead[v] = (rival - me.finishTime) * speed / BASHIN;
          won[v] = me.place === 1 ? 1 : 0;
          acc[v].lead += lead[v];
          acc[v].mine += me.finishTime;
          acc[v].rival += rival;
          acc[v].wins += won[v];
        }
        // Pair every variant against the baseline on this one seed.
        for (let v = 1; v < variants.length; v += 1) {
          const sign = variants[v].carried ? -1 : 1;
          const d = (lead[v] - lead[0]) * sign;
          const dw = (won[v] - won[0]) * sign;
          acc[v].d += d; acc[v].d2 += d * d;
          acc[v].dw += dw; acc[v].dw2 += dw * dw;
        }
        showProgress(i + 1, runsEach, `measuring ${variants.length - 1} skills · ${(i + 1) * variants.length} of ${budget} races`);
        // eslint-disable-next-line no-await-in-loop
        await yieldToUi();
      }
      progress.hidden = true;

      const speed = s.course.distance / (acc[0].mine / runsEach);
      // 95% half-width of a paired mean: 1.96 · s / √n, with s the sample
      // standard deviation of the per-seed differences.
      const halfWidth = (sum, sumSq) => {
        if (runsEach < 2) return Infinity;
        const mean = sum / runsEach;
        const variance = Math.max(0, (sumSq - runsEach * mean * mean) / (runsEach - 1));
        return 1.96 * Math.sqrt(variance / runsEach);
      };
      const rows = variants.slice(1).map((v, i) => {
        const a = acc[i + 1];
        const withSkill = v.carried ? acc[0] : a;
        const without = v.carried ? a : acc[0];
        const ci = halfWidth(a.d, a.d2);
        const bashin = a.d / runsEach;
        return {
          skill: v.skill,
          held: v.carried,
          analytic: scoreSkill(v.skill, ctx)?.bashin ?? 0,
          sim: {
            bashin,
            ci,
            separable: Number.isFinite(ci) && Math.abs(bashin) > ci,
            selfBashin: ((without.mine - withSkill.mine) / runsEach) * speed / BASHIN,
            rivalBashin: ((withSkill.rival - without.rival) / runsEach) * speed / BASHIN,
            winRate: a.dw / runsEach,
            winCi: halfWidth(a.dw, a.dw2),
          },
        };
      });
      rows.sort((a, b) => b.sim.bashin - a.sim.bashin);
      lastVerdicts = { rows, runsEach };
      paint();
    } finally {
      busy = false;
      progress.hidden = true;
    }
  }

  /* ------------------------------------------------------------- painting */

  function paint() {
    const course = currentCourse();
    layout.querySelector('[data-role="chip"]').innerHTML = `
      <div class="race-chip">
        <b>${esc(course.trackName)} ${course.distance}m</b>
        <span>${esc(course.surfaceName)} · ${esc(course.turnName)} · ${esc(GROUND_NAME[cm.ground])} · ${esc(WEATHER_NAME[cm.weather])} · ${esc(SEASON_NAME[cm.season])}</span>
        <span>${cm.fieldSize} runners — ${esc(fieldSummary())}</span>
      </div>`;

    if (!lastResult) {
      out.replaceChildren(el(`<section class="panel"><div class="panel__body">
        <div class="empty">
          <h3>Nothing has run yet</h3>
          <p class="muted small">Pick the skills your runner finishes with, then press <b>Run the race</b>.</p>
        </div>
      </div></section>`), limitations());
      return;
    }

    out.replaceChildren(
      headline(),
      resultTable(),
      sweepCard(),
      duelCard(),
      replayCard(),
      verifyCard(),
      limitations(),
    );
    const vb = out.querySelector('[data-act="verify"]');
    if (vb) vb.addEventListener('click', verify);
    const sb = out.querySelector('[data-act="sweep"]');
    if (sb) sb.addEventListener('click', sweepField);
    const db2 = out.querySelector('[data-act="duel"]');
    if (db2) db2.addEventListener('click', duel);
    const sv = out.querySelector('[data-act="save-build"]');
    if (sv) {
      sv.addEventListener('click', () => {
        saveBuild(`${currentCourse().trackName} ${currentCourse().distance}m · ${STRATEGY[cm.strategy].short} · ${cm.raceSkills.length} skills`);
        paint();
      });
    }
  }

  function headline() {
    const me = lastResult.acc[0];
    const best = [...lastResult.acc].sort((a, b) => b.winRate - a.winRate)[0];
    return el(`<div class="plan-grid">
      <div class="stat-tile ${me.winRate >= 0.3 ? 'stat-tile--ok' : me.winRate < 0.12 ? 'stat-tile--bad' : ''}">
        <h4>You win</h4>
        <div class="big">${(me.winRate * 100).toFixed(1)}%</div>
        <div class="sub">${best === me ? 'best in the field' : `${esc(best.name)} wins ${(best.winRate * 100).toFixed(0)}%`}</div>
      </div>
      <div class="stat-tile">
        <h4>Top 3</h4>
        <div class="big">${(me.top3Rate * 100).toFixed(0)}%</div>
        <div class="sub">over ${lastResult.runs} races</div>
      </div>
      <div class="stat-tile">
        <h4>Behind the winner</h4>
        <div class="big">${me.meanMargin.toFixed(2)}</div>
        <div class="sub">lengths on average · ${me.meanTime.toFixed(2)}s</div>
      </div>
      <div class="stat-tile ${me.outOfHpRate > 0.15 ? 'stat-tile--bad' : ''}">
        <h4>Stamina at the line</h4>
        <div class="big">${fmt.int(me.meanHp)}</div>
        <div class="sub">${me.outOfHpRate > 0.005 ? `empty in ${(me.outOfHpRate * 100).toFixed(0)}% of races` : 'never runs dry'} · spurt ${(me.meanSpurt * 100).toFixed(0)}%</div>
      </div>
    </div>`);
  }

  function resultTable() {
    const rows = lastResult.acc.map((a, i) => {
      const maxPlace = Math.max(...a.placeRates);
      return `<tr class="${i === 0 ? 'is-you' : ''}">
        <td>${i === 0 ? '<b>You</b>' : esc(a.name)}</td>
        <td><span class="chip chip--style${a.def.strategy}">${esc(STRATEGY[a.def.strategy].short)}</span></td>
        <td class="num">${(a.winRate * 100).toFixed(1)}%</td>
        <td class="num">${(a.top3Rate * 100).toFixed(0)}%</td>
        <td class="num">${a.meanTime.toFixed(2)}</td>
        <td class="num">${a.meanMargin.toFixed(2)}</td>
        <td><div class="place-strip">${a.placeRates.map((p, k) => `<i style="--h:${(p / maxPlace).toFixed(3)}" title="${k + 1}${k === 0 ? 'st' : k === 1 ? 'nd' : k === 2 ? 'rd' : 'th'}: ${(p * 100).toFixed(0)}%"></i>`).join('')}</div></td>
      </tr>`;
    }).join('');

    return el(`<section class="panel">
      <div class="panel__head"><h3>Every runner</h3><span class="sk-count">${lastResult.runs} races</span></div>
      <div class="panel__body" style="padding:0">
        <div class="table-wrap"><table>
          <thead><tr><th>Runner</th><th>Style</th><th class="num">Wins</th><th class="num">Top 3</th><th class="num">Time</th><th class="num">Margin</th><th>Place spread (1st → last)</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
      ${lastResult.notes.length ? `<div class="panel__foot">
        <p class="tiny muted">${esc(lastResult.notes.join(' '))}</p>
      </div>` : ''}
    </section>`);
  }

  function replayCard() {
    const { replay, setup: s } = lastResult;
    const d = s.course.distance;
    const W = 1000;
    const H = 240;
    const maxGap = Math.max(6, ...replay.runners.flatMap((r) => r.trace.map((p) => p.gap)));
    const x = (pos) => (pos / d) * W;
    const y = (gap) => 12 + (gap / maxGap) * (H - 34);

    const paths = replay.runners.map((r, i) => {
      const pts = r.trace.map((p) => `${x(p.pos).toFixed(1)},${y(p.gap).toFixed(1)}`).join(' ');
      return `<polyline points="${pts}" fill="none"
        stroke="${i === 0 ? 'var(--accent)' : `var(--style${r.strategy})`}"
        stroke-width="${i === 0 ? 2.6 : 1.1}" stroke-opacity="${i === 0 ? 1 : 0.45}" stroke-linejoin="round"/>`;
    }).join('');

    const me = replay.runners[0];
    const marks = me.log.filter((l) => l.pos > 0).map((l) => `
      <line x1="${x(l.pos).toFixed(1)}" y1="8" x2="${x(l.pos).toFixed(1)}" y2="${H - 20}" stroke="var(--gold)" stroke-width="1" stroke-dasharray="2 3"/>
      <circle cx="${x(l.pos).toFixed(1)}" cy="8" r="3" fill="var(--gold)"><title>${esc(l.skill.name)} at ${Math.round(l.pos)}m</title></circle>`).join('');

    const spurt = `<rect x="${x(me.spurtStart).toFixed(1)}" y="6" width="${(W - x(me.spurtStart)).toFixed(1)}" height="${H - 24}" fill="var(--sw-spurt)" opacity=".18"/>`;

    return el(`<section class="panel">
      <div class="panel__head">
        <h3>One race, step by step</h3>
        <span class="sk-count">seed 12345 · ${me.place}${me.place === 1 ? 'st' : me.place === 2 ? 'nd' : me.place === 3 ? 'rd' : 'th'}</span>
      </div>
      <div class="panel__body">
        <svg class="replay" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Gap to the leader through the race">
          ${spurt}
          <line x1="0" y1="${y(0)}" x2="${W}" y2="${y(0)}" stroke="var(--line)" stroke-width="1"/>
          ${paths}${marks}
          <text x="4" y="${y(0) - 4}" font-size="11" fill="var(--ink-3)">leader</text>
          <text x="4" y="${H - 6}" font-size="11" fill="var(--ink-3)">${maxGap.toFixed(0)} lengths back</text>
        </svg>
        <div class="legend">
          <span><i class="sw" style="background:var(--accent)"></i>you</span>
          ${[1, 2, 3, 4].map((k) => `<span><i class="sw" style="background:var(--style${k})"></i>${esc(STRATEGY[k].short)}</span>`).join('')}
          <span><i class="sw" style="background:var(--gold)"></i>your skill fired</span>
        </div>
        <div class="fire-log">
          ${me.log.length ? me.log.map((l) => `<span class="fire">${skillPill(l.skill)}<b class="num">${l.pos > 0 ? `${Math.round(l.pos)}m` : 'pre-race'}</b></span>`).join('')
    : '<p class="tiny muted">Nothing fired — this runner has no skills yet.</p>'}
        </div>
      </div>
    </section>`);
  }

  function verifyCard() {
    if (!lastVerdicts) {
      return el(`<section class="panel">
        <div class="panel__head"><h3>Check against the race</h3></div>
        <div class="panel__body">
          <button class="btn btn--primary" type="button" data-act="verify">Measure the top 14 against the race</button>
        </div>
      </section>`);
    }
    const noise = lastVerdicts.rows.filter((r) => !r.sim.separable).length;
    const rows = lastVerdicts.rows.map((r) => {
      const diff = r.analytic - r.sim.bashin;
      // A gap is only a real disagreement if the simulated number is itself
      // separable from zero — otherwise the "gap" is measuring the noise.
      const flag = r.sim.separable && Math.abs(diff) > Math.max(0.12, Math.abs(r.sim.bashin) * 0.5, r.sim.ci);
      return `<tr class="${r.held ? 'is-you' : ''}${r.sim.separable ? '' : ' is-noise'}">
        <td>${skillPill(r.skill)}${r.held ? '<span class="tag">carried</span>' : ''}</td>
        <td class="num">${r.sim.bashin.toFixed(2)}</td>
        <td class="num muted">&plusmn;${Number.isFinite(r.sim.ci) ? r.sim.ci.toFixed(2) : '—'}${r.sim.separable ? '' : ' <span class="tag tag--muted">noise</span>'}</td>
        <td class="num muted">${r.analytic.toFixed(2)}</td>
        <td class="num ${flag ? 'is-neg' : ''}">${diff >= 0 ? '+' : '−'}${Math.abs(diff).toFixed(2)}</td>
        <td class="num">${r.sim.selfBashin.toFixed(2)}</td>
        <td class="num">${r.sim.rivalBashin.toFixed(2)}</td>
        <td class="num">${(r.sim.winRate * 100 >= 0 ? '+' : '−')}${Math.abs(r.sim.winRate * 100).toFixed(1)}pp</td>
      </tr>`;
    }).join('');

    return el(`<section class="panel">
      <div class="panel__head">
        <h3>Measured against the race</h3>
        <div class="row"><span class="sk-count">${lastVerdicts.runsEach} paired races each</span>
        <button class="btn btn--sm btn--ghost" type="button" data-act="verify">Re-measure</button></div>
      </div>
      <div class="panel__body" style="padding:0">
        <div class="table-wrap"><table>
          <thead><tr><th>Skill</th><th class="num">Simulated</th><th class="num">95% CI</th><th class="num">Ranking said</th><th class="num">Gap</th><th class="num">Your metres</th><th class="num">Their metres</th><th class="num">Win rate</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
      <div class="panel__foot"><p class="tiny muted">“Your metres” is ground you gain; “their metres” is ground the field loses — the column that makes a debuff readable.
      Every variant runs on the <b>same seeds</b> as the baseline, so the interval is the paired one: the shared draw cancels out and
      ±0.05 here would take thousands of unpaired races to reach.
      ${noise ? `<b>${noise} of ${lastVerdicts.rows.length} rows are marked <i>noise</i></b> — their interval straddles zero, so at
      ${lastVerdicts.runsEach} races this run cannot tell them from doing nothing. Re-measure for a tighter bound rather than reading the order.`
    : 'Every row here is separable from zero at this sample size.'}
      A gap larger than the interval means the closed form is off for that skill, not that the skill is bad.</p></div>
    </section>`);
  }

  function sweepCard() {
    if (!lastSweep) {
      return el(`<section class="panel" data-section="sweep">
        <div class="panel__head"><h3>How much does the field shape matter?</h3></div>
        <div class="panel__body">
          <p class="small muted" style="margin-bottom:10px">Race this exact build against four other plausible field shapes on the
          same seeds. In a Champions Meeting you do not know the draw — this is what that uncertainty is worth.</p>
          <button class="btn btn--primary" type="button" data-act="sweep">Run the field sweep</button>
        </div>
      </section>`);
    }
    const { rows, runs } = lastSweep;
    const best = rows.reduce((a, b) => (b.winRate > a.winRate ? b : a));
    const worst = rows.reduce((a, b) => (b.winRate < a.winRate ? b : a));
    const mean = rows.reduce((n, r) => n + r.winRate, 0) / rows.length;
    const spread = best.winRate - worst.winRate;
    const max = Math.max(...rows.map((r) => r.winRate), 0.01);
    // At n races a win rate p carries this much 95% noise, so a spread inside
    // it is a draw rather than a finding.
    const noise = 1.96 * Math.sqrt(Math.max(0.01, mean * (1 - mean)) / runs);

    return el(`<section class="panel" data-section="sweep">
      <div class="panel__head panel__head--wrap">
        <h3>How much does the field shape matter?</h3>
        <div class="row"><span class="sk-count">${runs} races per shape</span>
        <button class="btn btn--sm btn--ghost" type="button" data-act="sweep">Re-run</button></div>
      </div>
      <div class="panel__body">
        <div class="kpi-row" style="margin-bottom:14px">
          <div class="kpi"><span class="kpi__v">${(mean * 100).toFixed(1)}%</span><span class="kpi__k">mean win rate across all five</span></div>
          <div class="kpi kpi--${worst.winRate < mean - noise ? 'bad' : 'good'}"><span class="kpi__v">${(worst.winRate * 100).toFixed(1)}%</span><span class="kpi__k">worst case &mdash; ${esc(worst.name)}</span></div>
          <div class="kpi kpi--${spread > noise * 2 ? 'warn' : 'good'}"><span class="kpi__v">${(spread * 100).toFixed(1)}pp</span><span class="kpi__k">spread between best and worst</span></div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Field shape</th><th>Mix</th><th class="num">Win</th><th></th><th class="num">Top 3</th><th class="num">Margin</th></tr></thead>
          <tbody>${rows.map((r) => `<tr class="${r.key === 'yours' ? 'is-you' : ''}">
            <td><b>${esc(r.name)}</b><div class="tiny muted">${esc(r.hint ?? '')}</div></td>
            <td class="tiny muted">${[1, 2, 3, 4].filter((k) => r.counts[k]).map((k) => `${r.counts[k]} ${esc(STRATEGY[k].short)}`).join(' · ')}</td>
            <td class="num">${(r.winRate * 100).toFixed(1)}%</td>
            <td style="width:120px"><span class="bar"><i style="width:${((r.winRate / max) * 100).toFixed(0)}%"></i></span></td>
            <td class="num muted">${(r.top3Rate * 100).toFixed(1)}%</td>
            <td class="num muted">${r.meanMargin <= 0 ? '—' : `−${r.meanMargin.toFixed(2)}`}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="panel__foot"><p class="tiny muted">
        ${spread > noise * 2
    ? `This build is <b>${spread > 0.15 ? 'sharply' : 'noticeably'} field-dependent</b>: ${(spread * 100).toFixed(1)}pp separates
       <b>${esc(best.name)}</b> from <b>${esc(worst.name)}</b>, well outside the ±${(noise * 100).toFixed(1)}pp noise floor at
       ${runs} races. If you cannot predict the round, the number to plan against is the worst case, not the one you set.`
    : `This build is <b>robust</b>: every shape lands within ±${(noise * 100).toFixed(1)}pp of the others, which at ${runs} races
       is a draw. The field shape is not what decides this round — build for the course instead.`}
        Same seeds across every shape, so the differences are the field and not the dice.</p></div>
    </section>`);
  }

  function duelCard() {
    const builds = cm.builds ?? [];
    const opts = (sel) => builds.map((b) => `<option value="${esc(b.id)}" ${b.id === sel ? 'selected' : ''}>${esc(b.name)}</option>`).join('');

    if (builds.length < 2) {
      return el(`<section class="panel" data-section="duel">
        <div class="panel__head"><h3>Build against build</h3></div>
        <div class="panel__body">
          <p class="small muted" style="margin-bottom:10px">Race two saved builds against the same field on the same seeds.
          ${builds.length === 1 ? 'One build saved — save a second to compare them.' : 'Nothing saved yet.'}</p>
          <button class="btn btn--sm" type="button" data-act="save-build">Save the current build as “${esc(currentCourse().trackName)} ${currentCourse().distance}m”</button>
        </div>
      </section>`);
    }

    const body = lastDuel ? (() => {
      const { a, b, runs, winDiff, winCi, leadDiff, leadCi } = lastDuel;
      const separable = Math.abs(winDiff) > winCi;
      const winner = winDiff > 0 ? a : b;
      return `
        <div class="kpi-row" style="margin-bottom:14px">
          <div class="kpi"><span class="kpi__v">${((a.wins / runs) * 100).toFixed(1)}%</span><span class="kpi__k">${esc(a.build.name)} wins</span></div>
          <div class="kpi"><span class="kpi__v">${((b.wins / runs) * 100).toFixed(1)}%</span><span class="kpi__k">${esc(b.build.name)} wins</span></div>
          <div class="kpi kpi--${separable ? 'good' : 'warn'}">
            <span class="kpi__v">${winDiff >= 0 ? '+' : '−'}${Math.abs(winDiff * 100).toFixed(1)}pp</span>
            <span class="kpi__k">&plusmn;${(winCi * 100).toFixed(1)}pp &mdash; ${separable ? `${esc(winner.build.name)} is genuinely ahead` : 'too close to separate'}</span>
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Build</th><th>Runner</th><th class="num">Win</th><th class="num">Top 3</th><th class="num">Time</th><th class="num">Lead on field</th></tr></thead>
          <tbody>
            ${[a, b].map((x) => {
    const who = buildRunner(x.build);
    return `<tr class="${x === winner && separable ? 'is-you' : ''}">
              <td><b>${esc(x.build.name)}</b></td>
              <td class="tiny muted">${esc(who?.outfit ? who.outfit.charaName : 'generic')} · ${esc(STRATEGY[who?.strategy ?? 2].short)} · ${who?.skills.length ?? 0} skills</td>
              <td class="num">${((x.wins / runs) * 100).toFixed(1)}%</td>
              <td class="num muted">${((x.top3 / runs) * 100).toFixed(1)}%</td>
              <td class="num muted">${(x.time / runs).toFixed(2)}s</td>
              <td class="num">${(x.lead / runs).toFixed(2)}</td>
            </tr>`;
  }).join('')}
          </tbody>
        </table></div>
        <p class="tiny muted" style="margin-top:10px">
          ${separable
    ? `<b>${esc(winner.build.name)}</b> takes it by ${Math.abs(winDiff * 100).toFixed(1)}pp of win rate and
       ${Math.abs(leadDiff).toFixed(2)} lengths (±${leadCi.toFixed(2)}) over ${runs} paired races.`
    : `At ${runs} races these two are <b>not separable</b>: the gap is ${Math.abs(winDiff * 100).toFixed(1)}pp against a
       ±${(winCi * 100).toFixed(1)}pp interval. Raise the race count or accept that the choice does not matter here.`}
        </p>`;
    })() : '<p class="small muted">Pick two and run them.</p>';

    const node = el(`<section class="panel" data-section="duel">
      <div class="panel__head panel__head--wrap">
        <h3>Build against build</h3>
        ${lastDuel ? `<span class="sk-count">${lastDuel.runs} paired races</span>` : ''}
      </div>
      <div class="panel__body">
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <select class="select" data-role="duel-a" aria-label="First build">${opts(duelPick.a || builds[0].id)}</select>
          <span class="muted tiny">vs</span>
          <select class="select" data-role="duel-b" aria-label="Second build">${opts(duelPick.b || builds[1].id)}</select>
          <button class="btn btn--primary btn--sm" type="button" data-act="duel">Race them</button>
          <button class="btn btn--ghost btn--sm" type="button" data-act="save-build">Save current</button>
        </div>
        ${body}
      </div>
    </section>`);

    duelPick.a = duelPick.a || builds[0].id;
    duelPick.b = duelPick.b || builds[1].id;
    node.querySelector('[data-role="duel-a"]').addEventListener('change', (e) => { duelPick.a = e.target.value; });
    node.querySelector('[data-role="duel-b"]').addEventListener('change', (e) => { duelPick.b = e.target.value; });
    return node;
  }

  function limitations() {
    return el(`<section class="panel">
      <details class="explain explain--panel">
        <summary>What is not modelled</summary>
        <ul class="steps">${LIMITATIONS.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        <p class="tiny muted">Ticks are ${(1 / DT).toFixed(0)} per second. Everything else — phase target speeds, the HP curve, the last-spurt
        solve, slopes, aptitudes, the Wit roll, pace-ups and every skill condition — is run for real, per runner, per tick.</p>
      </details>
    </section>`);
  }

  paint();
  root.replaceChildren(layout);
}
