import { db } from '../store.mjs';
import { el, esc, on, skillPill, effectSummary, fmt, readState, writeState } from '../ui.mjs';
import { simulateRace, rankSkills, statGuide, STRATEGY, scoreSkill } from '../model.mjs';

const GROUND = [[1, 'Firm'], [2, 'Good'], [3, 'Soft'], [4, 'Heavy']];
const STATS = [
  ['speed', 'Speed'], ['stamina', 'Stamina'], ['power', 'Power'], ['guts', 'Guts'], ['wit', 'Wit'],
];

export function renderPlanner(root) {
  const saved = readState();
  const defaultCourse = db.courseById.has(saved.c) ? saved.c
    : (db.courses.find((c) => c.trackName === 'Tokyo' && c.distance === 2400 && c.surface === 1)?.id ?? db.courses[0].id);

  const state = {
    courseId: defaultCourse,
    strategy: Number(saved.st ?? 2),
    ground: Number(saved.gr ?? 1),
    recovery: Number(saved.rc ?? 0),
    stats: {
      speed: Number(saved.sp ?? 1200),
      stamina: Number(saved.sa ?? 900),
      power: Number(saved.pw ?? 1000),
      guts: Number(saved.gu ?? 500),
      wit: Number(saved.wi ?? 900),
    },
  };

  const layout = el(`<div class="layout">
    <aside class="rail"></aside>
    <section class="stack">
      <div class="page-head">
        <div>
          <h1>Champions Meeting planner</h1>
          <p>Pick the course and running style you are preparing for. Everything below is derived from that.</p>
        </div>
      </div>
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
        <select class="select" data-role="track">
          ${tracks.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Course</label>
        <select class="select" data-role="course"></select>
      </div>
      <div class="field">
        <label>Running style</label>
        <div class="toggle-grid" data-role="strategy">
          ${Object.entries(STRATEGY).map(([v, s]) => `<button type="button" data-v="${v}" aria-pressed="${Number(v) === state.strategy}">${esc(s.name)}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Going</label>
        <div class="toggle-grid" data-role="ground">
          ${GROUND.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === state.ground}">${l}</button>`).join('')}
        </div>
      </div>
    </div>
  </section>`);

  const statsPanel = el(`<section class="panel">
    <div class="panel__head"><h3>Your stats</h3><button class="btn btn--ghost btn--sm" data-act="stat-reset" type="button">Reset</button></div>
    <div class="panel__body">
      ${STATS.map(([k, label]) => `
        <div class="field">
          <label>${label}</label>
          <div class="range-row">
            <input type="range" min="200" max="1800" step="10" data-stat="${k}" value="${state.stats[k]}">
            <output data-out="${k}">${state.stats[k]}</output>
          </div>
        </div>`).join('')}
      <div class="field">
        <label>Recovery from skills</label>
        <div class="range-row">
          <input type="range" min="0" max="40" step="1" data-role="recovery" value="${state.recovery}">
          <output data-out="recovery">${state.recovery}%</output>
        </div>
      </div>
      <p class="tiny muted">Recovery counts the total % of max stamina your healing skills give back over the race.</p>
    </div>
  </section>`);

  rail.append(controls, statsPanel);

  const trackSel = controls.querySelector('[data-role="track"]');
  const courseSel = controls.querySelector('[data-role="course"]');

  function fillCourses(trackName, preferId = null) {
    const list = db.courses.filter((c) => c.trackName === trackName);
    courseSel.innerHTML = list.map((c) => `
      <option value="${esc(c.id)}">${c.distance}m ${esc(c.surfaceName)} · ${esc(c.turnName)}</option>`).join('');
    const chosen = preferId && list.some((c) => c.id === preferId) ? preferId : list[0]?.id;
    courseSel.value = chosen;
    state.courseId = chosen;
  }

  trackSel.value = db.courseById.get(state.courseId).trackName;
  fillCourses(trackSel.value, state.courseId);

  trackSel.addEventListener('change', () => { fillCourses(trackSel.value); paint(); });
  courseSel.addEventListener('change', () => { state.courseId = courseSel.value; paint(); });

  on(controls, 'click', '[data-role="strategy"] button', (e, t) => {
    state.strategy = Number(t.dataset.v);
    controls.querySelectorAll('[data-role="strategy"] button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    paint();
  });
  on(controls, 'click', '[data-role="ground"] button', (e, t) => {
    state.ground = Number(t.dataset.v);
    controls.querySelectorAll('[data-role="ground"] button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    paint();
  });

  on(statsPanel, 'input', 'input[data-stat]', (e, t) => {
    state.stats[t.dataset.stat] = Number(t.value);
    statsPanel.querySelector(`[data-out="${t.dataset.stat}"]`).textContent = t.value;
    paint();
  });
  statsPanel.querySelector('[data-role="recovery"]').addEventListener('input', (e) => {
    state.recovery = Number(e.target.value);
    statsPanel.querySelector('[data-out="recovery"]').textContent = `${state.recovery}%`;
    paint();
  });
  on(statsPanel, 'click', '[data-act="stat-reset"]', () => {
    state.stats = { speed: 1200, stamina: 900, power: 1000, guts: 500, wit: 900 };
    STATS.forEach(([k]) => {
      statsPanel.querySelector(`input[data-stat="${k}"]`).value = state.stats[k];
      statsPanel.querySelector(`[data-out="${k}"]`).textContent = state.stats[k];
    });
    paint();
  });

  /* ----------------------------------------------------------------- paint */

  function paint() {
    const course = db.courseById.get(state.courseId);
    writeState({
      c: state.courseId, st: state.strategy, gr: state.ground === 1 ? '' : state.ground,
      rc: state.recovery || '', sp: state.stats.speed, sa: state.stats.stamina,
      pw: state.stats.power, gu: state.stats.guts, wi: state.stats.wit,
    });

    const sim = simulateRace({ course, strategy: state.strategy, stats: state.stats, ground: state.ground, recoveryPct: state.recovery });
    const ctx = { course, strategy: state.strategy, ground: state.ground, sim, stats: state.stats };

    const ranked = rankSkills(db.learnable, ctx);
    const uniques = ranked.filter((r) => r.skill.tier === 'unique' || r.skill.tier === 'evolved');
    const learnable = ranked.filter((r) => r.skill.tier === 'gold' || r.skill.tier === 'normal');
    const recovery = learnable.filter((r) => r.skill.effects.some((e) => e.kind === 'recovery'));

    out.replaceChildren(
      courseCard(course, sim),
      statCards(course, sim),
      guideCard(course, sim),
      rankCard('Best skills for this course', learnable.slice(0, 30), learnable.length,
        'Ranked by estimated metres gained, then adjusted for how reliably the skill fires with this running style.'),
      recovery.length ? rankCard('Best recovery skills', recovery.slice(0, 12), recovery.length,
        sim.surplus > 0
          ? 'You already have stamina to spare, so recovery is scored low here — it climbs as soon as stamina gets tight.'
          : 'Stamina is short on this setup, so recovery converts directly into a longer last spurt.') : el('<span hidden></span>'),
      rankCard('Best uniques to bring', uniques.slice(0, 20), uniques.length,
        'Only uniques that can actually fire with this running style are listed. The uma carrying each one is shown underneath.', true),
      cardSourcesCard(learnable.slice(0, 24)),
    );
  }

  /* ------------------------------------------------------------- fragments */

  function courseCard(course, sim) {
    const d = course.derived;
    const node = el(`<section class="panel">
      <div class="panel__head">
        <h3>${esc(course.trackName)} · ${course.distance}m ${esc(course.surfaceName)}</h3>
        <div class="row">
          <span class="chip chip--${course.surface === 1 ? 'turf' : 'dirt'}">${esc(course.surfaceName)}</span>
          <span class="chip">${esc(course.distanceTypeName)}</span>
          <span class="chip">${esc(course.turnName)}-handed</span>
        </div>
      </div>
      <div class="panel__body">
        ${trackSvg(course)}
        <div class="row small muted" style="gap:16px">
          <span><b class="num">${d.cornerCount}</b> corners (${fmt.int(d.cornerLength)}m)</span>
          <span>final corner at <b class="num">${d.finalCornerStart != null ? fmt.int(d.finalCornerStart) : '—'}</b>m</span>
          <span>home straight <b class="num">${fmt.int(d.lastStraightLength)}</b>m</span>
          <span>uphill <b class="num">${fmt.int(d.uphillLength)}</b>m</span>
          <span>downhill <b class="num">${fmt.int(d.downhillLength)}</b>m</span>
        </div>
      </div>
    </section>`);
    return node;
  }

  function trackSvg(course) {
    const W = 1000; const H = 74;
    const x = (m) => (m / course.distance) * W;
    const seg = (a, b, cls, y, h) => `<rect x="${x(a).toFixed(1)}" y="${y}" width="${Math.max(1, x(b) - x(a)).toFixed(1)}" height="${h}" fill="${cls}" />`;

    const corners = course.corners.map((c) => seg(c.start, c.start + c.length, 'var(--line)', 26, 16)).join('');
    const straights = course.straights.map((s) => seg(s.start, s.end, 'color-mix(in srgb, var(--accent) 28%, transparent)', 26, 16)).join('');
    const up = course.derived.uphill.map((s) => seg(s.start, s.start + s.length, 'color-mix(in srgb, var(--danger) 55%, transparent)', 46, 7)).join('');
    const down = course.derived.downhill.map((s) => seg(s.start, s.start + s.length, 'color-mix(in srgb, var(--turf) 60%, transparent)', 46, 7)).join('');

    const phaseMarks = [course.distance / 6, (course.distance * 2) / 3].map((m, i) => `
      <line x1="${x(m).toFixed(1)}" y1="18" x2="${x(m).toFixed(1)}" y2="60" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${(x(m) + 4).toFixed(1)}" y="14" font-size="11" fill="var(--ink-3)">${i === 0 ? 'middle leg' : 'final leg'}</text>`).join('');

    return `<svg class="track-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Course profile">
      ${straights}${corners}${up}${down}${phaseMarks}
      <text x="2" y="70" font-size="11" fill="var(--ink-3)">start</text>
      <text x="${W - 4}" y="70" font-size="11" fill="var(--ink-3)" text-anchor="end">finish</text>
    </svg>`;
  }

  function statCards(course, sim) {
    const need = sim.requiredStamina;
    const have = state.stats.stamina;
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

  function guideCard(course, sim) {
    const guide = statGuide(course, state.strategy);
    const rows = [
      ['Stamina', `${fmt.int(sim.requiredStamina)}+`, 'calculated from this course, style and going'],
      ...Object.entries(guide).map(([k, [lo, hi]]) => [
        k.charAt(0).toUpperCase() + k.slice(1), `${fmt.int(lo)} – ${fmt.int(hi)}`, 'common Champions Meeting baseline',
      ]),
    ];
    return el(`<section class="panel">
      <div class="panel__head"><h3>Stat targets</h3></div>
      <div class="panel__body" style="gap:8px">
        <table>
          <tbody>
            ${rows.map(([a, b, c]) => `<tr><td style="font-weight:500">${esc(a)}</td><td class="num">${esc(b)}</td><td class="small muted">${esc(c)}</td></tr>`).join('')}
          </tbody>
        </table>
        <p class="note">Stamina is solved from the HP model for a full-length last spurt. The other four are the ranges players converge on for this distance, surface and style — treat them as a starting point, not a rule.</p>
      </div>
    </section>`);
  }

  function rankCard(title, rows, total, note, showOwners = false) {
    if (!rows.length) return el('<span hidden></span>');
    const max = rows[0].score || 1;
    const node = el(`<section class="panel">
      <div class="panel__head"><h3>${esc(title)}</h3><span class="sk-count">${rows.length} of ${total}</span></div>
      <div class="panel__body" style="padding:0">
        <div class="rank-list">${rows.map((r, i) => rankRow(r, i, max, showOwners)).join('')}</div>
      </div>
    </section>`);
    if (note) node.querySelector('.panel__body').insertAdjacentHTML('afterend', `<div style="padding:11px 13px;border-top:1px solid var(--line-soft)"><p class="tiny muted">${esc(note)}</p></div>`);
    return node;
  }

  function rankRow(r, i, max, showOwners) {
    const owners = showOwners
      ? (r.skill.sources.unique.map((id) => db.outfitById.get(id)).filter(Boolean).map((o) => o.displayName).join(', '))
      : '';
    const why = owners || [effectSummary(r.skill), ...r.reasons].filter(Boolean).join(' · ');
    return `<div class="rank-row">
      <span class="rank-row__i">${i + 1}</span>
      <span style="min-width:0">
        ${skillPill(r.skill)}
        <span class="rank-row__why">${esc(why)}</span>
      </span>
      <span class="rank-row__mid">
        <div class="bar"><i style="width:${Math.max(3, (r.score / max) * 100).toFixed(0)}%"></i></div>
        <span class="tiny muted num">≈ ${r.metres.toFixed(2)} m raw</span>
      </span>
      <span class="rank-row__score">${(r.score * 100).toFixed(0)}</span>
    </div>`;
  }

  function cardSourcesCard(top) {
    const wanted = new Map(top.map((r) => [r.skill.id, r]));
    const scored = [];
    for (const card of db.supports) {
      if (!card.global) continue;
      const events = card.eventSkills.filter((id) => wanted.has(id));
      const hints = card.hintSkills.filter((id) => wanted.has(id));
      if (!events.length && !hints.length) continue;
      const value = events.reduce((n, id) => n + wanted.get(id).score, 0)
        + hints.reduce((n, id) => n + wanted.get(id).score * 0.6, 0);
      scored.push({ card, events, hints, value });
    }
    scored.sort((a, b) => b.value - a.value);
    const rows = scored.slice(0, 12);
    if (!rows.length) return el('<span hidden></span>');

    return el(`<section class="panel">
      <div class="panel__head"><h3>Support cards carrying those skills</h3><span class="sk-count">top ${rows.length}</span></div>
      <div class="panel__body" style="padding:0">
        <div class="rank-list">
          ${rows.map(({ card, events, hints }) => `
            <div class="rank-row" style="grid-template-columns:44px minmax(0,1fr) 92px">
              <img src="./img/support/${esc(card.id)}.webp" alt="" width="40" height="32" loading="lazy" style="border-radius:5px;object-fit:cover;background:var(--sunken)">
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
            </div>`).join('')}
        </div>
      </div>
    </section>`);
  }

  paint();
  root.replaceChildren(layout);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`;
}
