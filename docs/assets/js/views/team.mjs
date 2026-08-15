// The Champions Meeting entry: three umamusume, each with its own six-card
// training deck, planned against one course.
//
// Every panel shows its own arithmetic — per card, per skill, per uma and for
// the team as a whole — so the totals are traceable rather than a verdict.

import { db, skillIconUrl, isObtainable } from '../store.mjs';
import { el, esc, on, skillPill, fmt, debounce } from '../ui.mjs';
import { cm, commitContext, currentCourse, scoringContext, togglePriority, DEFAULT_STATS } from '../context.mjs';
import { simulateRace, scoreSkill, rankSkills, STRATEGY, BASHIN } from '../model.mjs';

const STATS = [['speed', 'Spd'], ['stamina', 'Sta'], ['power', 'Pwr'], ['guts', 'Gut'], ['wit', 'Wit']];

// A hint still has to be rolled and paid for, so it is worth less than an
// event skill the training run hands you outright.
const HINT_CONFIDENCE = 0.6;

export function renderTeam(root) {
  const layout = el(`<div class="layout">
    <aside class="rail"></aside>
    <section class="stack">
      <div class="page-head">
        <div>
          <h1>Team</h1>
          <p>Three umamusume, a deck each, planned against the course set on the Planner.</p>
        </div>
        <div class="page-head__right" data-role="race"></div>
      </div>
      <div data-role="summary"></div>
      <div class="slots" data-role="slots"></div>
    </section>
  </div>`);

  const rail = layout.querySelector('.rail');
  const slotsEl = layout.querySelector('[data-role="slots"]');
  const summaryEl = layout.querySelector('[data-role="summary"]');
  const raceEl = layout.querySelector('[data-role="race"]');

  /* -------------------------------------------------------- priority rail */

  const priorityPanel = el(`<section class="panel">
    <div class="panel__head">
      <h3>Priority skills</h3>
      <button class="btn btn--ghost btn--sm" data-act="clear" type="button">Clear</button>
    </div>
    <div class="panel__body">
      <p class="tiny muted">The skills you have decided this team has to end up with. Coverage, gaps and deck value below are all measured against this list.</p>
      <div class="field" style="position:relative">
        <input class="input" type="search" data-role="q" placeholder="Add a skill…" autocomplete="off">
        <div class="panel" data-role="results" style="position:fixed;z-index:60;max-height:280px;overflow:auto;box-shadow:var(--shadow-md)" hidden></div>
      </div>
      <div class="row">
        <button class="btn btn--sm" data-act="auto" type="button">Fill from top 12 for this course</button>
      </div>
      <div data-role="list" class="stack" style="gap:5px"></div>
    </div>
  </section>`);
  rail.append(priorityPanel);

  const q = priorityPanel.querySelector('[data-role="q"]');
  const results = priorityPanel.querySelector('[data-role="results"]');

  function placeResults() {
    if (results.hidden) return;
    const r = q.getBoundingClientRect();
    results.style.left = `${r.left}px`;
    results.style.width = `${r.width}px`;
    results.style.top = `${r.bottom + 4}px`;
    results.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - 16)}px`;
  }

  function renderResults() {
    const needle = q.value.trim().toLowerCase();
    if (!needle) { results.hidden = true; return; }
    const list = db.learnable
      .filter((s) => s.name.toLowerCase().includes(needle) && !cm.priority.includes(s.id))
      .slice(0, 20);
    if (!list.length) { results.hidden = true; return; }
    results.innerHTML = list.map((s) => `
      <button type="button" class="src-row" data-add="${esc(s.id)}" style="width:100%;border:0;background:transparent;cursor:pointer">
        <img src="${skillIconUrl(s)}" alt="" width="26" height="26">
        <span style="min-width:0"><b>${esc(s.name)}</b><span class="src-row__sub">${esc(s.variants[0]?.text ?? '')}</span></span>
        <span class="chip chip--${s.tier === 'normal' ? '' : s.tier}">${esc(s.tierName)}</span>
      </button>`).join('');
    results.hidden = false;
    placeResults();
  }

  q.addEventListener('input', debounce(renderResults, 110));
  window.addEventListener('scroll', placeResults, true);
  document.addEventListener('click', (e) => { if (!priorityPanel.contains(e.target)) results.hidden = true; });

  on(priorityPanel, 'click', '[data-add]', (e, t) => {
    togglePriority(t.dataset.add);
    q.value = ''; results.hidden = true;
    paint();
  });
  on(priorityPanel, 'click', '[data-drop]', (e, t) => { togglePriority(t.dataset.drop); paint(); });
  on(priorityPanel, 'click', '[data-act="clear"]', () => { cm.priority = []; commitContext(); paint(); });
  on(priorityPanel, 'click', '[data-act="auto"]', () => {
    const ctx = scoringContext();
    const sim = simulateRace({ course: currentCourse(), strategy: ctx.strategy, stats: ctx.stats, ground: ctx.ground, recoveryPct: cm.recovery });
    const top = rankSkills(db.learnable.filter(isObtainable), { ...ctx, sim }, { tiers: ['gold', 'normal'], limit: 12 });
    cm.priority = [...new Set([...cm.priority, ...top.map((r) => r.skill.id)])];
    commitContext(); paint();
  });

  function paintPriority() {
    const list = priorityPanel.querySelector('[data-role="list"]');
    if (!cm.priority.length) {
      list.innerHTML = '<p class="tiny muted">Nothing chosen yet — add skills by hand, or fill from the course ranking and edit from there.</p>';
      return;
    }
    list.innerHTML = cm.priority.map((id) => {
      const s = db.skillById.get(id);
      return `<div class="row" style="justify-content:space-between;gap:6px;flex-wrap:nowrap">
        ${skillPill(s)}
        <button class="btn btn--ghost btn--sm" data-drop="${esc(id)}" type="button" aria-label="Remove">✕</button>
      </div>`;
    }).join('');
  }

  /* --------------------------------------------------------------- pickers */

  const picker = el(`<div class="drawer" hidden>
    <div class="drawer__scrim" data-act="close-picker"></div>
    <aside class="drawer__panel" role="dialog" aria-modal="true">
      <header class="drawer__head">
        <div style="flex:1"><h2 data-role="title">Pick</h2></div>
        <button class="icon-btn" data-act="close-picker" type="button" aria-label="Close">✕</button>
      </header>
      <div class="drawer__body">
        <input class="input" type="search" data-role="pq" placeholder="Search…" autocomplete="off">
        <div class="toggle-grid" data-role="pfilter"></div>
        <div class="pick-grid" data-role="pgrid"></div>
      </div>
    </aside>
  </div>`);
  document.body.append(picker);
  on(picker, 'click', '[data-act="close-picker"]', () => { picker.hidden = true; });

  let pickerState = null;

  function openCardPicker(slotIndex, deckIndex) {
    pickerState = { kind: 'card', slotIndex, deckIndex, query: '', type: null };
    picker.querySelector('[data-role="title"]').textContent = `Support card · uma ${slotIndex + 1}, slot ${deckIndex + 1}`;
    picker.querySelector('[data-role="pfilter"]').innerHTML = ['speed', 'stamina', 'power', 'guts', 'wit', 'friend', 'group']
      .map((t) => `<button type="button" data-ptype="${t}" aria-pressed="false">${t[0].toUpperCase() + t.slice(1)}</button>`).join('');
    picker.querySelector('[data-role="pq"]').value = '';
    paintPicker();
    picker.hidden = false;
    picker.querySelector('[data-role="pq"]').focus();
  }

  function openUmaPicker(slotIndex) {
    pickerState = { kind: 'uma', slotIndex, query: '', type: null };
    picker.querySelector('[data-role="title"]').textContent = `Umamusume · slot ${slotIndex + 1}`;
    picker.querySelector('[data-role="pfilter"]').innerHTML = Object.entries(STRATEGY)
      .map(([v, s]) => `<button type="button" data-ptype="${v}" aria-pressed="false">${esc(s.name)}</button>`).join('');
    picker.querySelector('[data-role="pq"]').value = '';
    paintPicker();
    picker.hidden = false;
    picker.querySelector('[data-role="pq"]').focus();
  }

  function paintPicker() {
    const grid = picker.querySelector('[data-role="pgrid"]');
    const needle = pickerState.query.trim().toLowerCase();
    if (pickerState.kind === 'card') {
      const rows = db.supports.filter((c) => c.global
        && (!needle || c.name.toLowerCase().includes(needle))
        && (!pickerState.type || c.type === pickerState.type))
        .slice(0, 200);
      grid.innerHTML = rows.map((c) => `
        <button class="pick" type="button" data-pick="${esc(c.id)}">
          <img src="./img/support/${esc(c.id)}.webp" alt="" loading="lazy">
          <span>${esc(c.rarityName)} ${esc(c.name)}</span>
        </button>`).join('') || '<p class="muted small">Nothing matches.</p>';
    } else {
      const rows = db.globalOutfits.filter((o) => (!needle || o.displayName.toLowerCase().includes(needle))
        && (!pickerState.type || o.strategy === Number(pickerState.type)))
        .slice(0, 200);
      grid.innerHTML = rows.map((o) => `
        <button class="pick" type="button" data-pick="${esc(o.id)}">
          <img src="./img/chara/${esc(o.id)}.webp" alt="" loading="lazy">
          <span>${esc(o.charaName)}</span>
        </button>`).join('') || '<p class="muted small">Nothing matches.</p>';
    }
  }

  picker.querySelector('[data-role="pq"]').addEventListener('input', debounce((e) => {
    pickerState.query = e.target.value; paintPicker();
  }, 110));
  on(picker, 'click', '[data-ptype]', (e, t) => {
    const v = pickerState.kind === 'card' ? t.dataset.ptype : t.dataset.ptype;
    pickerState.type = pickerState.type === v ? null : v;
    picker.querySelectorAll('[data-ptype]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ptype === pickerState.type)));
    paintPicker();
  });
  on(picker, 'click', '[data-pick]', (e, t) => {
    const slot = cm.roster[pickerState.slotIndex];
    if (pickerState.kind === 'card') slot.deck[pickerState.deckIndex] = t.dataset.pick;
    else slot.outfitId = t.dataset.pick;
    commitContext();
    picker.hidden = true;
    paint();
  });

  /* ------------------------------------------------------------ slot maths */

  /**
   * Everything a slot can end the run with, and what it is worth on this
   * course: the uma's own list, its unique, guaranteed card events, and hints.
   */
  function analyseSlot(slot) {
    const course = currentCourse();
    const outfit = slot.outfitId ? db.outfitById.get(slot.outfitId) : null;
    const ctx = scoringContext(slot);
    const sim = simulateRace({ course, strategy: ctx.strategy, stats: ctx.stats, ground: ctx.ground, recoveryPct: cm.recovery });
    const full = { ...ctx, sim };

    const origin = new Map();   // skillId -> {kind, weight, from:[]}
    const note = (id, kind, weight, from) => {
      if (!db.skillById.has(id)) return;
      const prev = origin.get(id);
      if (!prev || weight > prev.weight) origin.set(id, { kind, weight, from: [from] });
      else if (prev.kind === kind) prev.from.push(from);
    };

    if (outfit?.uniqueId) note(outfit.uniqueId, 'unique', 1, outfit.id);
    for (const id of outfit?.skillIds ?? []) note(id, 'own', 1, outfit.id);

    const cards = slot.deck.map((id) => (id ? db.supportById.get(id) : null));
    for (const card of cards) {
      if (!card) continue;
      for (const id of card.eventSkills) note(id, 'event', 1, card.id);
      for (const id of card.hintSkills) note(id, 'hint', HINT_CONFIDENCE, card.id);
    }

    const pool = [];
    for (const [id, info] of origin) {
      const skill = db.skillById.get(id);
      const scored = scoreSkill(skill, full);
      pool.push({ skill, ...info, scored, value: (scored?.bashin ?? 0) * info.weight });
    }
    pool.sort((a, b) => b.value - a.value);

    const usable = pool.filter((p) => p.scored);
    const total = usable.reduce((n, p) => n + p.value, 0);

    const coverage = cm.priority.map((id) => {
      const skill = db.skillById.get(id);
      const info = origin.get(id);
      const scored = skill ? scoreSkill(skill, full) : null;
      return { skill, info, scored };
    });
    const covered = coverage.filter((c) => c.info).length;

    const aptKeyDistance = ['', 'sprint', 'mile', 'medium', 'long'][course.distanceType];
    const aptKeySurface = course.surface === 1 ? 'turf' : 'dirt';
    const styleKey = STRATEGY[ctx.strategy]?.key;

    return {
      outfit, ctx, sim, cards, pool, usable, total, coverage, covered,
      aptitudes: outfit ? {
        distance: outfit.aptitudeGrades[aptKeyDistance],
        surface: outfit.aptitudeGrades[aptKeySurface],
        style: outfit.aptitudeGrades[styleKey],
        distanceVal: outfit.aptitudes[aptKeyDistance],
        surfaceVal: outfit.aptitudes[aptKeySurface],
        styleVal: outfit.aptitudes[styleKey],
      } : null,
    };
  }

  /* ------------------------------------------------------------------ paint */

  function paint() {
    const course = currentCourse();
    raceEl.innerHTML = `<a class="chip chip--accent" href="#/planner">${esc(course.trackName)} ${course.distance}m ${esc(course.surfaceName)} · ${esc(course.turnName)} · ${cm.fieldSize} runners</a>`;
    paintPriority();

    const analyses = cm.roster.map(analyseSlot);
    summaryEl.replaceChildren(teamSummary(analyses));
    slotsEl.replaceChildren(...analyses.map((a, i) => slotCard(a, i)));
  }

  function teamSummary(analyses) {
    const filled = analyses.filter((a) => a.outfit);
    const styles = new Set(filled.map((a) => a.ctx.strategy));
    const total = analyses.reduce((n, a) => n + a.total, 0);

    const teamCovered = cm.priority.filter((id) => analyses.some((a) => a.coverage.find((c) => c.skill?.id === id && c.info)));
    const pct = cm.priority.length ? teamCovered.length / cm.priority.length : 0;

    const cardUse = new Map();
    for (const a of analyses) for (const c of a.cards) if (c) cardUse.set(c.id, (cardUse.get(c.id) ?? 0) + 1);
    const shared = [...cardUse.entries()].filter(([, n]) => n > 1);

    return el(`<div class="plan-grid">
      <div class="stat-tile ${filled.length === 3 ? 'stat-tile--ok' : ''}">
        <h4>Entry</h4>
        <div class="big">${filled.length}<span style="font-size:15px;font-weight:500"> / 3</span></div>
        <div class="sub">${styles.size} running style${styles.size === 1 ? '' : 's'} covered${styles.size < 2 && filled.length > 1 ? ' — all on the same style' : ''}</div>
      </div>
      <div class="stat-tile ${cm.priority.length && pct === 1 ? 'stat-tile--ok' : cm.priority.length && pct < 0.5 ? 'stat-tile--bad' : ''}">
        <h4>Priority skills covered</h4>
        <div class="big">${cm.priority.length ? `${teamCovered.length}/${cm.priority.length}` : '—'}</div>
        <div class="sub">${cm.priority.length ? `${Math.round(pct * 100)}% of the list reachable somewhere in the team` : 'add priority skills to measure this'}</div>
        ${cm.priority.length ? `<div class="bar" style="margin-top:8px"><i style="width:${(pct * 100).toFixed(0)}%"></i></div>` : ''}
      </div>
      <div class="stat-tile">
        <h4>Team skill value</h4>
        <div class="big">${total.toFixed(1)}<span style="font-size:15px;font-weight:500"> len</span></div>
        <div class="sub">expected lengths from every reachable skill, hints at ${Math.round(HINT_CONFIDENCE * 100)}%</div>
      </div>
      <div class="stat-tile">
        <h4>Cards in more than one deck</h4>
        <div class="big">${shared.length}</div>
        <div class="sub">${shared.length ? shared.map(([id, n]) => `${db.supportById.get(id)?.name ?? id} ×${n}` ).slice(0, 3).join(', ') : 'no overlap between the three decks'}</div>
      </div>
    </div>`);
  }

  function slotCard(a, index) {
    const slot = cm.roster[index];
    const o = a.outfit;

    const deckHtml = slot.deck.map((id, i) => {
      const card = id ? db.supportById.get(id) : null;
      return card
        ? `<button class="deck__slot deck__slot--filled" type="button" data-deck="${index}:${i}" title="${esc(card.name)}">
             <img src="./img/support/${esc(card.id)}.webp" alt="${esc(card.name)}" loading="lazy">
             <span class="deck__type">${esc(card.typeName)}</span>
             <span class="deck__x" data-clear="${index}:${i}" role="button" aria-label="Remove">✕</span>
           </button>`
        : `<button class="deck__slot" type="button" data-deck="${index}:${i}" aria-label="Add a support card">+</button>`;
    }).join('');

    const typeCount = {};
    for (const c of a.cards) if (c) typeCount[c.typeName] = (typeCount[c.typeName] ?? 0) + 1;

    const eventCount = a.pool.filter((p) => p.kind === 'event').length;
    const hintCount = a.pool.filter((p) => p.kind === 'hint').length;
    const goldCount = a.pool.filter((p) => p.skill.tier === 'gold').length;

    const staminaOk = o ? a.ctx.stats.stamina >= a.sim.requiredStamina : true;

    return el(`<article class="panel">
      <div class="panel__head">
        <h3>Uma ${index + 1}</h3>
        ${o ? `<button class="btn btn--ghost btn--sm" data-uma="${index}" type="button">Change</button>` : ''}
      </div>
      <div class="panel__body">

        ${o ? `
          <div class="row" style="gap:10px;flex-wrap:nowrap">
            <img src="./img/chara/${esc(o.id)}.webp" alt="" width="52" height="52" loading="lazy" style="border-radius:9px;background:var(--sunken);flex:none">
            <div style="min-width:0;flex:1">
              <div style="font-weight:600">${esc(o.charaName)}</div>
              <div class="tiny muted">${esc(o.epithet)}</div>
              <div class="chips" style="margin-top:4px">
                <span class="chip chip--accent">${esc(STRATEGY[a.ctx.strategy].name)}</span>
                <span class="chip ${a.aptitudes.distanceVal >= 7 ? '' : 'chip--warn'}">${esc(currentCourse().distanceTypeName)} ${esc(a.aptitudes.distance)}</span>
                <span class="chip ${a.aptitudes.surfaceVal >= 7 ? '' : 'chip--warn'}">${esc(currentCourse().surfaceName)} ${esc(a.aptitudes.surface)}</span>
                <span class="chip ${a.aptitudes.styleVal >= 7 ? '' : 'chip--warn'}">Style ${esc(a.aptitudes.style)}</span>
              </div>
            </div>
          </div>
          <div class="field">
            <label>Run as</label>
            <div class="toggle-grid" data-role="slot-style" data-slot="${index}">
              ${Object.entries(STRATEGY).map(([v, s]) => `<button type="button" data-v="${v}" aria-pressed="${Number(v) === a.ctx.strategy}">${esc(s.short ?? s.name)}</button>`).join('')}
            </div>
          </div>`
    : `<button class="btn btn--primary" data-uma="${index}" type="button" style="justify-content:center">Choose an umamusume</button>`}

        <div class="divider"></div>

        <div>
          <h4 class="drawer__h3">Deck</h4>
          <div class="deck">${deckHtml}</div>
          <p class="tiny muted" style="margin-top:6px">
            ${a.cards.filter(Boolean).length}/6 cards${Object.keys(typeCount).length ? ` · ${Object.entries(typeCount).map(([t, n]) => `${n} ${t}`).join(', ')}` : ''}
          </p>
        </div>

        ${o ? `
          <div class="divider"></div>
          <div>
            <h4 class="drawer__h3">Stats</h4>
            <div class="row" style="gap:5px">
              ${STATS.map(([k, label]) => `
                <label class="field" style="flex:1;min-width:0;gap:2px">
                  <span class="tiny muted">${label}</span>
                  <input class="input num" type="number" min="100" max="${cm.statCap}" step="10" value="${a.ctx.stats[k]}" data-slotstat="${index}:${k}" style="padding:4px 5px;text-align:right">
                </label>`).join('')}
            </div>
            <table class="calc" style="margin-top:8px">
              <tbody>
                <tr><td>Stamina needed</td><td class="num ${staminaOk ? '' : 'chip--warn'}">${fmt.int(a.sim.requiredStamina)}</td>
                    <td class="small muted">${staminaOk ? `${fmt.int(a.ctx.stats.stamina - a.sim.requiredStamina)} to spare` : `${fmt.int(a.sim.requiredStamina - a.ctx.stats.stamina)} short`}</td></tr>
                <tr><td>Last spurt covered</td><td class="num">${Math.round(a.sim.spurtCoverage * 100)}%</td>
                    <td class="small muted">${fmt.int(a.sim.spurtDistance)}m of ${fmt.int(currentCourse().distance / 3)}m</td></tr>
                <tr><td>Estimated time</td><td class="num">${a.sim.time.toFixed(1)}s</td>
                    <td class="small muted">spurt ${a.sim.speeds.spurt.toFixed(2)} m/s</td></tr>
              </tbody>
            </table>
          </div>` : ''}

        ${cm.priority.length ? `
          <div class="divider"></div>
          <div>
            <h4 class="drawer__h3">Priority coverage <span class="sk-count">${a.covered}/${cm.priority.length}</span></h4>
            ${a.coverage.map(({ skill, info, scored }) => `
              <div class="cover-row">
                <span style="min-width:0">${skillPill(skill, { dim: !info })}</span>
                <span class="row" style="gap:5px;flex-wrap:nowrap">
                  ${scored ? `<span class="tiny muted num">${scored.bashin.toFixed(2)} len</span>` : '<span class="tiny muted">n/a here</span>'}
                  <span class="cover-tag cover-tag--${info ? info.kind === 'own' ? 'own' : info.kind === 'unique' ? 'own' : info.kind : 'miss'}">${info ? info.kind : 'missing'}</span>
                </span>
              </div>`).join('')}
          </div>` : ''}

        <div class="divider"></div>
        <div>
          <h4 class="drawer__h3">Reachable skills <span class="sk-count">${a.usable.length} usable · ${a.pool.length} total</span></h4>
          <table class="calc">
            <tbody>
              <tr><td>Guaranteed from events</td><td class="num">${eventCount}</td><td class="small muted">counted at 100%</td></tr>
              <tr><td>From hints</td><td class="num">${hintCount}</td><td class="small muted">counted at ${Math.round(HINT_CONFIDENCE * 100)}%</td></tr>
              <tr><td>Gold skills in reach</td><td class="num">${goldCount}</td><td class="small muted">across uma list and deck</td></tr>
              <tr><td><b>Expected value</b></td><td class="num"><b>${a.total.toFixed(2)} len</b></td><td class="small muted">on this course, as ${esc(STRATEGY[a.ctx.strategy]?.name ?? '—')}</td></tr>
            </tbody>
          </table>
          <div class="stack" style="gap:3px;margin-top:8px;max-height:320px;overflow:auto">
            ${a.usable.slice(0, 40).map((p) => `
              <div class="cover-row">
                <span style="min-width:0">${skillPill(p.skill)}</span>
                <span class="row" style="gap:5px;flex-wrap:nowrap">
                  <span class="tiny muted num">${p.value.toFixed(2)}</span>
                  <span class="cover-tag cover-tag--${p.kind === 'own' || p.kind === 'unique' ? 'own' : p.kind}">${p.kind}</span>
                </span>
              </div>`).join('') || '<p class="tiny muted">Pick an uma and some cards to see what this run can end up with.</p>'}
          </div>
        </div>
      </div>
    </article>`);
  }

  /* --------------------------------------------------------------- events */

  on(slotsEl, 'click', '[data-uma]', (e, t) => openUmaPicker(Number(t.dataset.uma)));
  on(slotsEl, 'click', '[data-clear]', (e, t) => {
    e.stopPropagation();
    const [s, i] = t.dataset.clear.split(':').map(Number);
    cm.roster[s].deck[i] = null;
    commitContext(); paint();
  });
  on(slotsEl, 'click', '[data-deck]', (e, t) => {
    if (e.target.closest('[data-clear]')) return;
    const [s, i] = t.dataset.deck.split(':').map(Number);
    openCardPicker(s, i);
  });
  on(slotsEl, 'click', '[data-role="slot-style"] button', (e, t) => {
    const slot = cm.roster[Number(t.closest('[data-slot]').dataset.slot)];
    slot.strategy = Number(t.dataset.v);
    commitContext(); paint();
  });
  on(slotsEl, 'change', 'input[data-slotstat]', (e, t) => {
    const [s, key] = t.dataset.slotstat.split(':');
    const slot = cm.roster[Number(s)];
    slot.stats = { ...DEFAULT_STATS, ...slot.stats, [key]: Math.max(100, Math.min(cm.statCap, Number(t.value) || 100)) };
    commitContext(); paint();
  });

  paint();
  root.replaceChildren(layout);
}
