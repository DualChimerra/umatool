import { db, isObtainable } from '../store.mjs';
import { el, esc, on, skillPill, effectSummary, fmt, turnLabel } from '../ui.mjs';
import { cm, commitContext, currentCourse, scoringContext, DEFAULT_STATS } from '../context.mjs';
import {
  simulateRace, rankSkills, statGuide, statSensitivity, STRATEGY,
  orderDistribution, orderRate, activationRate, effectiveStats, courseSpeedModifier,
  staminaMatrix, raceProfile, BASHIN, CM_FIELD_SIZE,
} from '../model.mjs';
import { cardSkills, rankUniques } from '../analysis.mjs';

const GROUND = [[1, 'Firm'], [2, 'Good'], [3, 'Soft'], [4, 'Heavy']];
const STATS = [['speed', 'Speed'], ['stamina', 'Stamina'], ['power', 'Power'], ['guts', 'Guts'], ['wit', 'Wit']];

export function renderPlanner(root) {
  const layout = el(`<div class="layout">
    <aside class="rail"></aside>
    <section class="stack">
      <div class="page-head">
        <div>
          <h1>Champions Meeting planner</h1>
          <p>Pick the race you are preparing for. Everything below — and the Team page — is derived from it.</p>
        </div>
      </div>
      <nav class="jump" data-role="jump"></nav>
      <div data-role="out" class="stack"></div>
    </section>
  </div>`);

  const rail = layout.querySelector('.rail');
  const out = layout.querySelector('[data-role="out"]');

  /* ------------------------------------------------------------- controls */

  const tracks = [...new Set(db.courses.map((c) => c.trackName))].sort();
  const controls = el(`<section class="panel">
    <div class="panel__head"><h3>Race</h3></div>
    <div class="panel__body">
      <div class="field">
        <label>Racecourse</label>
        <select class="select" data-role="track">${tracks.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select>
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
          ${GROUND.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === cm.ground}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Field size</label>
        <div class="toggle-grid" data-role="field">
          ${[9, 12, 18].map((n) => `<button type="button" data-v="${n}" aria-pressed="${n === cm.fieldSize}">${n}${n === CM_FIELD_SIZE ? ' · CM' : ''}</button>`).join('')}
        </div>
      </div>
    </div>
  </section>`);

  const statsPanel = el(`<section class="panel">
    <div class="panel__head"><h3>Your stats</h3><button class="btn btn--ghost btn--sm" data-act="stat-reset" type="button">Reset</button></div>
    <div class="panel__body">
      <div class="field">
        <label>Stat ceiling</label>
        <div class="toggle-grid" data-role="cap">
          ${[1200, 1400, 1600, 1800, 2000].map((n) => `<button type="button" data-v="${n}" aria-pressed="${n === cm.statCap}">${n}</button>`).join('')}
        </div>
      </div>
      ${STATS.map(([k, label]) => `
        <div class="field">
          <label>${label}</label>
          <div class="range-row">
            <input type="range" min="100" step="10" data-stat="${k}">
            <input class="input num" type="number" min="100" step="10" data-num="${k}" style="width:74px;padding:4px 6px;text-align:right">
          </div>
        </div>`).join('')}
      <div class="field">
        <label>Recovery from skills</label>
        <div class="range-row">
          <input type="range" min="0" max="60" step="1" data-role="recovery" value="${cm.recovery}">
          <output data-out="recovery">${cm.recovery}%</output>
        </div>
      </div>
      <details class="explain">
        <summary>About the ceiling and recovery</summary>
        <p>Scenarios keep raising the stat cap, so nothing here is hardcoded to 1200 — set what your scenario allows and the sliders and target ranges follow.</p>
        <p>Recovery is the total % of max stamina your healing skills give back across the race.</p>
      </details>
    </div>
  </section>`);

  rail.append(controls, statsPanel);

  const trackSel = controls.querySelector('[data-role="track"]');
  const courseSel = controls.querySelector('[data-role="course"]');

  function fillCourses(trackName, preferId = null) {
    const list = db.courses.filter((c) => c.trackName === trackName);
    courseSel.innerHTML = list.map((c) => `<option value="${esc(c.id)}">${c.distance}m ${esc(c.surfaceName)} · ${esc(turnLabel(c.turnName))}</option>`).join('');
    const chosen = preferId && list.some((c) => c.id === preferId) ? preferId : list[0]?.id;
    courseSel.value = chosen;
    cm.courseId = chosen;
  }
  trackSel.value = currentCourse().trackName;
  fillCourses(trackSel.value, cm.courseId);

  trackSel.addEventListener('change', () => { fillCourses(trackSel.value); commitContext(); paint(); });
  courseSel.addEventListener('change', () => { cm.courseId = courseSel.value; commitContext(); paint(); });

  const groupHandler = (selector, apply) => on(controls, 'click', `${selector} button`, (e, t) => {
    apply(Number(t.dataset.v));
    controls.querySelectorAll(`${selector} button`).forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    commitContext(); paint();
  });
  groupHandler('[data-role="strategy"]', (v) => { cm.strategy = v; });
  groupHandler('[data-role="ground"]', (v) => { cm.ground = v; });
  groupHandler('[data-role="field"]', (v) => { cm.fieldSize = v; });

  on(statsPanel, 'click', '[data-role="cap"] button', (e, t) => {
    cm.statCap = Number(t.dataset.v);
    statsPanel.querySelectorAll('[data-role="cap"] button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    syncStatInputs(); commitContext(); paint();
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
  }
  syncStatInputs();

  on(statsPanel, 'input', 'input[data-stat]', (e, t) => {
    cm.stats[t.dataset.stat] = Number(t.value);
    statsPanel.querySelector(`input[data-num="${t.dataset.stat}"]`).value = t.value;
    commitContext(); paint();
  });
  on(statsPanel, 'change', 'input[data-num]', (e, t) => {
    const v = Math.max(100, Math.min(cm.statCap, Number(t.value) || 100));
    cm.stats[t.dataset.num] = v;
    t.value = v;
    statsPanel.querySelector(`input[data-stat="${t.dataset.num}"]`).value = v;
    commitContext(); paint();
  });
  statsPanel.querySelector('[data-role="recovery"]').addEventListener('input', (e) => {
    cm.recovery = Number(e.target.value);
    statsPanel.querySelector('[data-out="recovery"]').textContent = `${cm.recovery}%`;
    commitContext(); paint();
  });
  on(statsPanel, 'click', '[data-act="stat-reset"]', () => {
    Object.assign(cm.stats, DEFAULT_STATS);
    syncStatInputs(); commitContext(); paint();
  });

  /* ----------------------------------------------------------------- paint */

  function paint() {
    const course = currentCourse();
    const ctx = scoringContext();
    const sim = simulateRace({ course, strategy: ctx.strategy, stats: ctx.stats, ground: ctx.ground, aptitudes: ctx.aptitudes, recoveryPct: cm.recovery });
    const full = { ...ctx, sim };

    const ranked = rankSkills(db.learnable, full);
    const uniques = rankUniques();
    const allLearnable = ranked.filter((r) => r.skill.tier === 'gold' || r.skill.tier === 'normal');
    const learnable = cm.obtainableOnly === false ? allLearnable : allLearnable.filter((r) => isObtainable(r.skill));
    const hiddenCount = allLearnable.length - learnable.length;
    const recovery = learnable.filter((r) => r.skill.effects.some((e) => e.kind === 'recovery'));
    const sensitivity = statSensitivity({ ...full, recoveryPct: cm.recovery }, db.learnable);

    layout.querySelector('[data-role="jump"]').innerHTML = [
      ['course', 'Course'], ['stats', 'Stat targets'], ['matrix', 'Going & style'],
      ['skills', 'Best skills'], ['uniques', 'Uniques'], ['cards', 'Cards'],
    ].map(([id, label]) => `<a href="#/planner" data-jump="${id}">${label}</a>`).join('');

    out.replaceChildren(
      courseCard(course, sim),
      statCards(course, sim),
      guideCard(course, sim, sensitivity),
      matrixCard(course),
      rankCard('Best skills for this course', learnable.slice(0, 30), learnable.length, hiddenCount),
      recovery.length ? rankCard('Best recovery skills', recovery.slice(0, 12), recovery.length) : el('<span hidden></span>'),
      uniqueCard(uniques.slice(0, 20), uniques.length),
      cardSourcesCard(learnable.slice(0, 24)),
      fieldCard(ctx),
    );
  }

  /* ------------------------------------------------------------- fragments */

  function courseCard(course, sim) {
    const d = course.derived;
    return el(`<section class="panel" data-section="course">
      <div class="panel__head">
        <h3>${esc(course.trackName)} · ${course.distance}m ${esc(course.surfaceName)}</h3>
        <div class="row">
          <span class="chip chip--${course.surface === 1 ? 'turf' : 'dirt'}">${esc(course.surfaceName)}</span>
          <span class="chip">${esc(course.distanceTypeName)}</span>
          <span class="chip">${esc(turnLabel(course.turnName))}</span>
        </div>
      </div>
      <div class="panel__body">
        ${trackSvg(course)}
        <div class="factlist">
          <span><b class="num">${d.cornerCount}</b> corners (${fmt.int(d.cornerLength)}m)</span>
          <span>final corner at <b class="num">${d.finalCornerStart != null ? fmt.int(d.finalCornerStart) : '—'}</b>m</span>
          <span>home straight <b class="num">${fmt.int(d.lastStraightLength)}</b>m</span>
          <span>uphill <b class="num">${fmt.int(d.uphillLength)}</b>m</span>
          <span>downhill <b class="num">${fmt.int(d.downhillLength)}</b>m</span>
        </div>
      </div>
    </section>`);
  }

  /**
   * The course, and the race run over it. The coloured bands are the track —
   * straights, corners, slopes — and the two curves are this build's speed and
   * remaining stamina at every point, from the same model as the numbers below.
   */
  function trackSvg(course) {
    const W = 1000; const H = 132;
    const profile = raceProfile({
      course, strategy: cm.strategy, stats: cm.stats, ground: cm.ground, recoveryPct: cm.recovery,
    });
    const x = (m) => (m / course.distance) * W;
    const seg = (a, b, fill, y, h) => `<rect x="${x(a).toFixed(1)}" y="${y}" width="${Math.max(1, x(b) - x(a)).toFixed(1)}" height="${h}" fill="${fill}"/>`;

    const straights = course.straights.map((v) => seg(v.start, v.end, 'color-mix(in srgb, var(--accent) 26%, transparent)', 8, 12)).join('');
    const corners = course.corners.map((c) => seg(c.start, c.start + c.length, 'var(--line)', 8, 12)).join('');
    const up = course.derived.uphill.map((v) => seg(v.start, v.start + v.length, 'color-mix(in srgb, var(--danger) 55%, transparent)', 22, 5)).join('');
    const down = course.derived.downhill.map((v) => seg(v.start, v.start + v.length, 'color-mix(in srgb, var(--turf) 60%, transparent)', 22, 5)).join('');

    const top = 34; const bottom = H - 18;
    const vLo = profile.vMin - 0.6; const vHi = profile.vMax + 0.4;
    const ySpeed = (v) => bottom - ((v - vLo) / Math.max(0.01, vHi - vLo)) * (bottom - top);
    const yHp = (r) => bottom - r * (bottom - top);
    const path = (fn, key) => profile.points
      .map((pt, i) => `${i ? 'L' : 'M'}${x(pt.x).toFixed(1)},${fn(pt[key]).toFixed(1)}`).join('');

    const spurtBand = seg(profile.spurtStart, course.distance, 'color-mix(in srgb, var(--gold) 16%, transparent)', top, bottom - top);
    const marks = [[profile.marks.openingEnd, 'middle'], [profile.marks.middleEnd, 'final leg'], [profile.spurtStart, 'spurt']]
      .map(([m, label]) => `
        <line x1="${x(m).toFixed(1)}" y1="${top}" x2="${x(m).toFixed(1)}" y2="${bottom}" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 3"/>
        <text x="${(x(m) + 4).toFixed(1)}" y="${top + 9}" font-size="10" fill="var(--ink-3)">${label}</text>`).join('');

    return `<svg class="track-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="Course profile with this build's speed and stamina">
      ${straights}${corners}${up}${down}${spurtBand}${marks}
      <path d="${path(yHp, 'hpRatio')}" fill="none" stroke="var(--danger)" stroke-width="1.6" opacity=".8"/>
      <path d="${path(ySpeed, 'v')}" fill="none" stroke="var(--accent)" stroke-width="2"/>
      <text x="2" y="${H - 5}" font-size="10" fill="var(--ink-3)">start</text>
      <text x="${W - 4}" y="${H - 5}" font-size="10" fill="var(--ink-3)" text-anchor="end">finish</text>
    </svg>
    <div class="chart-key">
      <span><i class="chart-key__line" style="background:var(--accent)"></i>speed, ${profile.vMin.toFixed(1)}\u2013${profile.vMax.toFixed(1)} m/s</span>
      <span><i class="chart-key__line" style="background:var(--danger)"></i>stamina left, ${fmt.int(profile.maxHp)} at the gate</span>
      <span><i class="chart-key__band"></i>last spurt, from ${fmt.int(profile.spurtStart)}m</span>
    </div>`;
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
    const best = order.filter((k) => sens[k]?.bashin != null)
      .sort((a, b) => sens[b].bashin - sens[a].bashin)[0];

    const rows = order.map((k) => {
      const range = k === 'stamina' ? `${fmt.int(sim.requiredStamina)}+` : `${fmt.int(guide[k][0])} – ${fmt.int(guide[k][1])}`;
      const s = sens[k];
      const marginal = s?.bashin == null ? '—' : `${s.bashin >= 0 ? '+' : '−'}${Math.abs(s.bashin).toFixed(2)} len`;
      const note = k === 'stamina' ? 'solved from this course, style and going'
        : s?.viaSkills ? 'raises the Wit activation roll on checked skills'
          : s?.modelled ? 'measured on the HP/speed model' : 'drives acceleration and lane changes — not simulated here';
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
        <table>
          <thead><tr><th>Stat</th><th class="num">Target</th><th class="num">+100 is worth</th><th>How it was worked out</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <details class="explain">
          <summary>How this was worked out</summary>
          <p>Stamina is solved from the HP model for a full-length last spurt. The “+100 is worth” column is a finite difference on the model — it re-runs the race with 100 more of that stat and converts the time saved into lengths at the finish, so it tells you which stat is actually starved right now.</p>
          <p>Target ranges scale with the stat ceiling you set.</p>
        </details>
      </div>
    </section>`);
  }

  /**
   * What the race actually runs on. The going shifts Speed and Power by a flat
   * amount before anything else, and some courses hand out a Speed bonus for
   * clearing stat thresholds. Both change every number on this page and neither
   * was visible anywhere.
   */
  function effectiveCard(course) {
    const eff = effectiveStats(cm.stats, course, cm.ground);
    const bonus = courseSpeedModifier(course, cm.stats);
    const rows = [['speed', 'Speed'], ['power', 'Power']]
      .map(([k, label]) => [label, Math.round(cm.stats[k]), Math.round(eff[k])])
      .filter(([, a, b]) => a !== b);
    if (!rows.length && bonus === 1) return '';
    return `<details class="explain">
      <summary>What the race actually sees</summary>
      ${bonus === 1 ? '' : `<p>This course awards a set-status bonus, so your Speed is multiplied by <b>×${bonus.toFixed(2)}</b> before the going is applied.</p>`}
      ${rows.length ? `<table class="calc">
        <tbody>${rows.map(([label, a, b]) => `<tr>
          <td>${label}</td><td class="num">${fmt.int(a)}</td>
          <td class="num" style="color:${b < a ? 'var(--danger)' : 'var(--accent)'}">→ ${fmt.int(b)}</td>
          <td class="small muted">${esc(GROUND.find(([v]) => v === cm.ground)?.[1] ?? '')} going${bonus === 1 ? '' : ' + course bonus'}</td>
        </tr>`).join('')}</tbody>
      </table>` : ''}
      <p>Stamina and Guts are never modified. Everything above and below is computed from these adjusted values.</p>
    </details>`;
  }

  /**
   * The going is announced late, so the build that clears the spurt on Firm is
   * worth checking against Heavy before the day.
   */
  function matrixCard(course) {
    const rows = staminaMatrix({ course, stats: cm.stats, recoveryPct: cm.recovery });
    const have = cm.stats.stamina;
    const cell = (c) => {
      const ok = c.short === 0;
      const cls = ok ? 'mx--ok' : c.short > 150 ? 'mx--bad' : 'mx--warn';
      return `<td class="num mx ${cls}" title="needs ${fmt.int(c.required)} Stamina, spurt ${Math.round(c.coverage * 100)}%">
        <b>${fmt.int(c.required)}</b>
        <span>${ok ? `+${fmt.int(have - c.required)}` : `−${fmt.int(c.short)}`}</span>
      </td>`;
    };
    return el(`<section class="panel" data-section="matrix">
      <div class="panel__head">
        <h3>Going and style, against your Stamina</h3>
        <span class="sk-count">you have ${fmt.int(have)}</span>
      </div>
      <div class="panel__body" style="gap:8px">
        <table class="matrix">
          <thead><tr><th>Style</th>${GROUND.map(([v, l]) => `<th class="num${v === cm.ground ? ' is-current' : ''}">${l}</th>`).join('')}</tr></thead>
          <tbody>
            ${rows.map((r) => `<tr>
              <td${r.strategy === cm.strategy ? ' class="is-current"' : ''}>${esc(STRATEGY[r.strategy].name)}</td>
              ${r.cells.map(cell).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
        ${effectiveCard(course)}
        <details class="explain">
          <summary>Reading this table</summary>
          <p>Each cell is the Stamina that going and style need for an unbroken last spurt, with the shortfall or surplus against your current ${fmt.int(have)} underneath. Green clears it; red is more than 150 short.</p>
          <p>Heavy going costs 50 Speed and up to 100 Power outright and raises HP drain, so it moves the requirement the most. Your current selection is the highlighted row and column.</p>
        </details>
      </div>
    </section>`);
  }

  function fieldCard(ctx) {
    const dist = orderDistribution(ctx.strategy, ctx.fieldSize);
    const rows = [...dist.entries()].sort((a, b) => a[0] - b[0]);
    const maxW = Math.max(...rows.map(([, w]) => w));
    const wit = activationRate(ctx.stats.wit);

    return el(`<section class="panel" data-section="field">
      <details class="explain explain--panel">
        <summary>Field and order model · ${ctx.fieldSize} runners, ${esc(STRATEGY[ctx.strategy].name)}</summary>
        <p>Champions Meeting runs ${CM_FIELD_SIZE} umamusume, so <code>order_rate</code> moves in steps of
        ${(100 / ctx.fieldSize).toFixed(1)}%. That is what decides whether a “top 30% of the field” skill is reachable at all.</p>
        <table>
          <thead><tr><th>Place</th><th class="num">order_rate</th><th class="num">Chance</th><th></th></tr></thead>
          <tbody>
            ${rows.map(([o, w]) => `<tr>
              <td>${o}${o === 1 ? 'st' : o === 2 ? 'nd' : o === 3 ? 'rd' : 'th'}</td>
              <td class="num">${orderRate(o, ctx.fieldSize).toFixed(1)}%</td>
              <td class="num">${(w * 100).toFixed(0)}%</td>
              <td style="width:40%"><div class="bar"><i style="width:${((w / maxW) * 100).toFixed(0)}%"></i></div></td>
            </tr>`).join('')}
          </tbody>
        </table>
        <p>Wit ${ctx.stats.wit} → Wit-checked skills fire <b>${(wit * 100).toFixed(1)}%</b> of the time
        (<code>100 − 9000 / Wit</code>, floored at 20%).</p>
      </details>
    </section>`);
  }

  function scoringExplainer() {
    return `<details class="explain">
      <summary>How “best skills” is ranked</summary>
      <p>Every skill is scored as <b>expected lengths gained on this exact course</b>, not by a tier list. In order:</p>
      <ol>
        <li><b>Can it fire at all?</b> Running style, distance band, surface, track handedness, track id, going and required terrain are hard gates — fail one and the skill is dropped, not penalised.</li>
        <li><b>Where does it fire?</b> The trigger window is intersected with the real course: race phase, corners, straights, slopes, and any <code>distance_rate</code> / <code>remain_distance</code> bound. That gives the metre mark it starts at.</li>
        <li><b>How long does it get?</b> Duration scales with race distance, then is capped by the time left to the finish from that point — a 6-second speed skill firing 100m out only gets what fits.</li>
        <li><b>How much ground is that?</b> Speed effects give m/s × seconds. Acceleration is calibrated so +0.2 m/s² over 3s ≈ +0.35 m/s over 3s. Recovery is converted through the HP model into extra last-spurt seconds, and scales with how tight your stamina actually is.</li>
        <li><b>How often does it happen?</b> Multiply by P(position) from the ${cm.fieldSize}-runner order distribution, P(Wit roll) for Wit-checked skills, and a penalty for conditions like being blocked or overtaking.</li>
        <li><b>When does it happen?</b> A weight of 0.55 / 0.78 / 1.25 / 1.45 for opening, middle, final leg and the last 10%.</li>
      </ol>
      <p>Open any skill to see all of those numbers for that specific skill, plus where to get it.</p>
    </details>`;
  }

  function rankCard(title, rows, total, hidden = null) {
    if (!rows.length) return el('<span hidden></span>');
    const max = rows[0].score || 1;
    const node = el(`<section class="panel" data-section="skills">
      <div class="panel__head">
        <h3>${esc(title)}</h3>
        <div class="row">
          ${hidden === null ? '' : `<div class="seg" data-role="obtainable">
            <button type="button" data-v="1" aria-pressed="${cm.obtainableOnly !== false}">Obtainable</button>
            <button type="button" data-v="0" aria-pressed="${cm.obtainableOnly === false}">All</button>
          </div>`}
          <span class="sk-count">${rows.length} of ${total}</span>
        </div>
      </div>
      <div class="panel__body" style="padding:0">
        <div class="rank-list">${rows.map((r, i) => rankRow(r, i, max)).join('')}</div>
      </div>
    </section>`);
    if (hidden !== null) {
      node.insertAdjacentHTML('beforeend', `<div class="panel__foot">
        ${hidden ? `<p class="tiny muted">${hidden} more skills score here but no Global uma or support card teaches them — scenario rewards and the like. Switch to <b>All</b> to see them.</p>` : ''}
        ${scoringExplainer()}
      </div>`);
    }
    on(node, 'click', '[data-role="obtainable"] button', (e, t) => {
      cm.obtainableOnly = t.dataset.v === '1';
      commitContext(); paint();
    });
    return node;
  }

  function rankRow(r, i, max) {
    const why = [effectSummary(r.skill), ...r.reasons].filter(Boolean).join(' · ');
    return `<div class="rank-row">
      <span class="rank-row__i">${i + 1}</span>
      <span style="min-width:0">
        ${skillPill(r.skill)}
        <span class="rank-row__why">${esc(why)}</span>
      </span>
      <span class="rank-row__mid">
        <div class="bar"><i style="width:${Math.max(3, (r.score / max) * 100).toFixed(0)}%"></i></div>
        <span class="tiny muted num">${fmt.pct(r.probability)} × ${(r.metres / BASHIN).toFixed(2)} len</span>
      </span>
      <span class="rank-row__score">${r.bashin.toFixed(2)}</span>
    </div>`;
  }

  function uniqueCard(rows, total) {
    if (!rows.length) return el('<span hidden></span>');
    const course = currentCourse();

    return el(`<section class="panel" data-section="uniques">
      <div class="panel__head">
        <h3>Uniques that land on this course</h3>
        <span class="sk-count">${rows.length} of ${total}</span>
      </div>
      <div class="panel__body" style="padding:0">
        <div class="rank-list">
          ${rows.map((r, i) => {
    const o = r.owner;
    const offStyle = r.strategy !== cm.strategy;
    const grade = (v) => (v >= 7 ? '' : ' chip--warn');
    return `<div class="rank-row rank-row--unique">
              <span class="rank-row__i">${i + 1}</span>
              <img src="./img/chara/${esc(o.id)}.webp" alt="" width="34" height="34" loading="lazy" class="rank-row__face">
              <span style="min-width:0">
                ${skillPill(r.skill)}
                <span class="rank-row__why">${esc(`${o.charaName} · ${o.epithet}`)}</span>
              </span>
              <span class="rank-row__mid chips">
                <span class="chip${offStyle ? ' chip--accent' : ''}">${esc(STRATEGY[r.strategy].short)}</span>
                <span class="chip${grade(r.aptitudes.distance)}">${esc(course.distanceTypeName)} ${esc(o.aptitudeGrades[['', 'sprint', 'mile', 'medium', 'long'][course.distanceType]])}</span>
                <span class="chip${grade(r.aptitudes.surface)}">${esc(course.surfaceName)} ${esc(o.aptitudeGrades[course.surface === 1 ? 'turf' : 'dirt'])}</span>
              </span>
              <span class="rank-row__score">${r.bashin.toFixed(2)}</span>
            </div>`;
  }).join('')}
        </div>
      </div>
      <div class="panel__foot">
        <p class="tiny muted">A unique comes with its uma, so each one is scored the way she would actually run it — her own
        running style and her own aptitudes for this course, not the style set above. Uniques nobody on Global carries are
        left out. The style chip is highlighted when she runs something other than your current ${esc(STRATEGY[cm.strategy].short)} setting.</p>
      </div>
    </section>`);
  }

  function cardSourcesCard(top) {
    const wanted = new Map(top.map((r) => [r.skill.id, r]));
    const scored = [];
    for (const card of db.supports) {
      if (!card.global) continue;
      // cardSkills drops the duplicates: 72 cards list the same skill both as
      // their event skill and as a hint, and it used to be counted twice.
      const taught = cardSkills(card).filter(({ skill }) => wanted.has(skill.id));
      if (!taught.length) continue;
      const events = taught.filter((t) => t.kind === 'event').map((t) => t.skill.id);
      const hints = taught.filter((t) => t.kind === 'hint').map((t) => t.skill.id);
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
            <div class="rank-row" style="grid-template-columns:44px minmax(0,1fr) 92px 64px">
              <img src="./img/support/${esc(card.id)}.webp" alt="" width="40" height="40" loading="lazy" style="border-radius:6px;object-fit:cover;background:var(--sunken)">
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
      <div class="panel__foot">
        <p class="tiny muted">Card value = sum of the expected lengths of the top-ranked skills it teaches. Event skills count in full because they are guaranteed; hints count at 60% because you still have to roll and buy them.</p>
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
