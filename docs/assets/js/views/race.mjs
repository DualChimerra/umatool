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
  cm, commitContext, currentCourse, scoringContext, fieldSummary, yourSkills,
} from '../context.mjs';
import {
  STRATEGY, simulateRace, rankSkills, scoreSkill, BASHIN,
  GROUND_NAME, WEATHER_NAME, SEASON_NAME,
} from '../model.mjs';
import { runRace, LIMITATIONS, DT } from '../race/sim.mjs';
import { buildSetup } from '../race/field.mjs';

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
let busy = false;

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
      <p class="tiny muted">Your umamusume, stats, running style, aptitudes and the field all come from the Planner —
      this is the same skill list, editable from either side.</p>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <button class="btn btn--sm" type="button" data-act="fill">Fill from the top 6</button>
        <button class="btn btn--sm btn--ghost" type="button" data-act="fill-priority">Use priority list</button>
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
        <p class="tiny muted">More races, tighter numbers. 200 puts the margin within about ±0.05 lengths.</p>
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
      : '<p class="tiny muted">No skills yet — an unskilled runner is a fair baseline, but not a plan.</p>';
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
      const acc = variants.map(() => ({ lead: 0, mine: 0, rival: 0, wins: 0 }));

      const runsEach = Math.max(30, Math.min(140, Math.round(cm.simRuns / 2)));
      const budget = variants.length * runsEach;
      const n = s.runners.length;
      for (let i = 0; i < runsEach; i += 1) {
        const seed = 999 + i * 7919;
        for (let v = 0; v < variants.length; v += 1) {
          const trial = { ...s, runners: s.runners.map((r, k) => (k === 0 ? { ...r, skills: variants[v].skills } : r)) };
          const { runners } = runRace(trial, seed);
          const me = runners[0];
          let rival = 0;
          for (let k = 1; k < n; k += 1) rival += runners[k].finishTime;
          rival /= (n - 1);
          const speed = s.course.distance / Math.max(1, me.finishTime);
          acc[v].lead += (rival - me.finishTime) * speed / BASHIN;
          acc[v].mine += me.finishTime;
          acc[v].rival += rival;
          if (me.place === 1) acc[v].wins += 1;
        }
        showProgress(i + 1, runsEach, `measuring ${variants.length - 1} skills · ${(i + 1) * variants.length} of ${budget} races`);
        // eslint-disable-next-line no-await-in-loop
        await yieldToUi();
      }
      progress.hidden = true;

      const speed = s.course.distance / (acc[0].mine / runsEach);
      const rows = variants.slice(1).map((v, i) => {
        const withSkill = v.carried ? acc[0] : acc[i + 1];
        const without = v.carried ? acc[i + 1] : acc[0];
        return {
          skill: v.skill,
          held: v.carried,
          analytic: scoreSkill(v.skill, ctx)?.bashin ?? 0,
          sim: {
            bashin: (withSkill.lead - without.lead) / runsEach,
            selfBashin: ((without.mine - withSkill.mine) / runsEach) * speed / BASHIN,
            rivalBashin: ((withSkill.rival - without.rival) / runsEach) * speed / BASHIN,
            winRate: (withSkill.wins - without.wins) / runsEach,
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
          <p class="muted small">Pick the skills your runner will finish with, then press <b>Run the race</b>.
          The field is the one set on the Planner — ${esc(fieldSummary())}.</p>
        </div>
      </div></section>`), limitations());
      return;
    }

    out.replaceChildren(
      headline(),
      resultTable(),
      replayCard(),
      verifyCard(),
      limitations(),
    );
    const vb = out.querySelector('[data-act="verify"]');
    if (vb) vb.addEventListener('click', verify);
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
      <div class="panel__foot">
        <p class="tiny muted">${esc(lastResult.notes.join(' '))}
        Running styles are not equal at equal stats, and that is the game&rsquo;s own coefficients rather than a thumb on the scale:
        a Late Surger or End Closer runs the final leg faster than a Front Runner does. What flips it is stamina — drop everyone&rsquo;s
        Stamina until the last spurt stops being fully paid for and the front of the field starts winning, because it is the only
        part of it still able to spurt.</p>
      </div>
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
      <div class="panel__foot"><p class="tiny muted">Distance along the track against how many lengths behind the leader each runner is. The shaded band is your last spurt.</p></div>
    </section>`);
  }

  function verifyCard() {
    if (!lastVerdicts) {
      return el(`<section class="panel">
        <div class="panel__head"><h3>Check the ranking against the race</h3></div>
        <div class="panel__body">
          <p class="small">The Planner scores 600 skills in a few milliseconds by doing arithmetic. This measures them the slow,
          honest way: run the field with the skill and without it, on identical seeds, and take the difference.</p>
          <button class="btn btn--primary" type="button" data-act="verify">Measure your skills and the top 14</button>
        </div>
      </section>`);
    }
    const rows = lastVerdicts.rows.map((r) => {
      const diff = r.analytic - r.sim.bashin;
      const flag = Math.abs(diff) > Math.max(0.12, Math.abs(r.sim.bashin) * 0.5);
      return `<tr class="${r.held ? 'is-you' : ''}">
        <td>${skillPill(r.skill)}${r.held ? '<span class="tag">carried</span>' : ''}</td>
        <td class="num">${r.sim.bashin.toFixed(2)}</td>
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
          <thead><tr><th>Skill</th><th class="num">Simulated</th><th class="num">Ranking said</th><th class="num">Gap</th><th class="num">Your metres</th><th class="num">Their metres</th><th class="num">Win rate</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
      <div class="panel__foot"><p class="tiny muted">“Your metres” is ground you gain; “their metres” is ground the field loses — the column that makes a debuff readable.
      A gap larger than the noise floor (about ±0.1 lengths at this sample size) means the closed form is off for that skill, not that the skill is bad.</p></div>
    </section>`);
  }

  function limitations() {
    return el(`<section class="panel">
      <div class="panel__head"><h3>What this simulator does not model</h3></div>
      <div class="panel__body">
        <ul class="steps">${LIMITATIONS.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        <p class="tiny muted">Ticks are ${(1 / DT).toFixed(0)} per second. Everything else — phase target speeds, the HP curve, the last-spurt
        solve, slopes, aptitudes, the Wit roll, pace-ups and every skill condition — is run for real, per runner, per tick.</p>
      </div>
    </section>`);
  }

  paint();
  root.replaceChildren(layout);
}
