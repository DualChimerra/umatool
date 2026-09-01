// The Champions Meeting entry: three umamusume, each with its own six-card
// training deck, planned against one course.
//
// Every panel shows its own arithmetic — per card, per skill, per uma and for
// the team as a whole — so the totals are traceable rather than a verdict.

import { db, skillIconUrl, isObtainable } from '../store.mjs';
import { el, esc, on, skillPill, fmt, debounce, collapsible } from '../ui.mjs';
import {
  cm, commitContext, currentCourse, scoringContext, togglePriority, togglePriorityRank,
  priorityAnyRank, DEFAULT_STATS, ownsCard, canPlace, borrowedIn,
  saveBuild, loadBuild, deleteBuild, clearRoster, BORROWED_ALLOWANCE,
} from '../context.mjs';
import { simulateRace, rankSkills, STRATEGY } from '../model.mjs';
import { analyseSlot, rankCards, rankUmas, recommendations, HINT_CONFIDENCE } from '../analysis.mjs';

const STATS = [['speed', 'Spd'], ['stamina', 'Sta'], ['power', 'Pwr'], ['guts', 'Gut'], ['wit', 'Wit']];
const SEV_LABEL = { blocker: 'Fix', warn: 'Check', tip: 'Tip' };

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
      <div data-role="advice"></div>
      <div class="slots" data-role="slots"></div>
    </section>
  </div>`);

  const rail = layout.querySelector('.rail');
  const slotsEl = layout.querySelector('[data-role="slots"]');
  const summaryEl = layout.querySelector('[data-role="summary"]');
  const adviceEl = layout.querySelector('[data-role="advice"]');
  const raceEl = layout.querySelector('[data-role="race"]');

  /* -------------------------------------------------------- priority rail */

  const priorityPanel = el(`<section class="panel">
    <div class="panel__head">
      <h3>Priority skills</h3>
      <button class="btn btn--ghost btn--sm" data-act="clear" type="button">Clear</button>
    </div>
    <div class="panel__body">
      <p class="tiny muted">The skills you have decided this team has to end up with. Coverage, gaps, deck value and the card ranking are all measured against this list.</p>
      <div class="field" style="position:relative">
        <input class="input" type="search" data-role="q" placeholder="Add a skill…" autocomplete="off">
        <div class="panel" data-role="results" style="position:fixed;z-index:60;max-height:280px;overflow:auto;box-shadow:var(--shadow-md)" hidden></div>
      </div>
      <button class="btn btn--sm" data-act="auto" type="button">Fill from top 12 for this course</button>
      <div data-role="list" class="stack" style="gap:6px"></div>
    </div>
  </section>`);

  const q = priorityPanel.querySelector('[data-role="q"]');
  const results = priorityPanel.querySelector('[data-role="results"]');

  function placeResults() {
    if (results.hidden) return;
    const r = q.getBoundingClientRect();
    Object.assign(results.style, {
      left: `${r.left}px`, width: `${r.width}px`, top: `${r.bottom + 4}px`,
      maxHeight: `${Math.max(160, window.innerHeight - r.bottom - 16)}px`,
    });
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
  on(priorityPanel, 'change', '[data-rank]', (e, t) => { togglePriorityRank(t.dataset.rank); paint(); });
  on(priorityPanel, 'click', '[data-act="clear"]', () => { cm.priority = []; cm.priorityOpts = {}; commitContext(); paint(); });
  on(priorityPanel, 'click', '[data-act="auto"]', () => {
    const ctx = scoringContext();
    const sim = simulateRace({ ...ctx, recoveryPct: cm.recovery });
    const top = rankSkills(db.learnable.filter(isObtainable), { ...ctx, sim, recoveryPct: cm.recovery }, { tiers: ['gold', 'normal'], limit: 12 });
    for (const r of top) if (!cm.priority.includes(r.skill.id)) togglePriority(r.skill.id);
    paint();
  });

  function paintPriority() {
    const list = priorityPanel.querySelector('[data-role="list"]');
    if (!cm.priority.length) {
      list.innerHTML = '<p class="tiny muted">Nothing chosen yet — add skills by hand, or fill from the course ranking and edit from there.</p>';
      return;
    }
    list.innerHTML = cm.priority.map((id) => {
      const s = db.skillById.get(id);
      const sibs = (db.skillsByGroup.get(s?.groupId) ?? []).filter((x) => x.id !== id && !x.inherited);
      return `<div class="pri-row">
        <div class="row" style="justify-content:space-between;gap:6px;flex-wrap:nowrap">
          ${skillPill(s)}
          <button class="btn btn--ghost btn--sm" data-drop="${esc(id)}" type="button" aria-label="Remove">✕</button>
        </div>
        ${sibs.length ? `<label class="check tiny" style="margin-top:4px">
          <input type="checkbox" data-rank="${esc(id)}" ${priorityAnyRank(id) ? 'checked' : ''}>
          <span>${esc(sibs.map((x) => x.name).join(', '))} counts too</span>
        </label>` : ''}
      </div>`;
    }).join('');
  }

  /* ------------------------------------------------------------ saved builds */

  const buildsPanel = el(`<section class="panel">
    <div class="panel__head"><h3>Saved builds</h3></div>
    <div class="panel__body">
      <div class="row" style="gap:6px;flex-wrap:nowrap">
        <input class="input" data-role="bname" type="text" placeholder="Name this build…">
        <button class="btn btn--primary btn--sm" data-act="save" type="button">Save</button>
      </div>
      <div data-role="builds" class="stack" style="gap:4px"></div>
      <button class="btn btn--ghost btn--sm" data-act="clear-roster" type="button">Empty the three slots</button>
    </div>
  </section>`);

  on(buildsPanel, 'click', '[data-act="save"]', () => {
    const input = buildsPanel.querySelector('[data-role="bname"]');
    saveBuild(input.value.trim());
    input.value = '';
    paint();
  });
  on(buildsPanel, 'click', '[data-load]', (e, t) => {
    if (e.target.closest('[data-del]')) return;
    loadBuild(t.dataset.load);
    paint();
  });
  on(buildsPanel, 'click', '[data-del]', (e, t) => { e.stopPropagation(); deleteBuild(t.dataset.del); paint(); });
  on(buildsPanel, 'click', '[data-act="clear-roster"]', () => { clearRoster(); paint(); });

  function paintBuilds() {
    const list = buildsPanel.querySelector('[data-role="builds"]');
    if (!cm.builds.length) {
      list.innerHTML = '<p class="tiny muted">The three slots below are kept automatically between visits. Save a build to keep several and switch between them.</p>';
      return;
    }
    list.innerHTML = cm.builds.map((b) => {
      const names = (b.roster ?? []).map((s) => db.outfitById.get(s.outfitId)?.charaName).filter(Boolean);
      return `<div class="src-row" style="grid-template-columns:minmax(0,1fr) auto auto;cursor:pointer" data-load="${esc(b.id)}">
        <span style="min-width:0">
          <b>${esc(b.name)}</b>
          <span class="src-row__sub">${esc(names.join(' · ') || 'empty')} · ${esc(new Date(b.savedAt).toLocaleDateString())}</span>
        </span>
        <span class="chip">${b.priority?.length ?? 0} pri</span>
        <button class="btn btn--ghost btn--sm" data-del="${esc(b.id)}" type="button" aria-label="Delete">✕</button>
      </div>`;
    }).join('');
  }

  rail.append(collapsible(priorityPanel, 'team.priority'), collapsible(buildsPanel, 'team.builds'));

  /* --------------------------------------------------------------- pickers */

  const picker = el(`<div class="drawer" hidden>
    <div class="drawer__scrim" data-act="close-picker"></div>
    <aside class="drawer__panel drawer__panel--wide" role="dialog" aria-modal="true">
      <header class="drawer__head">
        <div style="flex:1;min-width:0">
          <h2 data-role="title">Pick</h2>
          <p class="tiny muted" data-role="subtitle"></p>
        </div>
        <button class="icon-btn" data-act="close-picker" type="button" aria-label="Close">✕</button>
      </header>
      <div class="drawer__body" style="gap:10px">
        <input class="input" type="search" data-role="pq" placeholder="Search…" autocomplete="off">
        <div class="toggle-grid" data-role="pfilter"></div>
        <div data-role="pgrid" class="stack" style="gap:6px"></div>
      </div>
    </aside>
  </div>`);
  document.body.append(picker);
  on(picker, 'click', '[data-act="close-picker"]', () => { picker.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !picker.hidden) picker.hidden = true; });

  let pickerState = null;

  function openCardPicker(slotIndex, deckIndex) {
    pickerState = { kind: 'card', slotIndex, deckIndex, query: '', type: null };
    picker.querySelector('[data-role="pfilter"]').innerHTML = ['speed', 'stamina', 'power', 'guts', 'wit', 'friend', 'group']
      .map((t) => `<button type="button" data-ptype="${t}" aria-pressed="false">${t[0].toUpperCase() + t.slice(1)}</button>`).join('');
    picker.querySelector('[data-role="pq"]').value = '';
    paintPicker();
    picker.hidden = false;
    picker.querySelector('[data-role="pq"]').focus();
  }

  function openUmaPicker(slotIndex) {
    pickerState = { kind: 'uma', slotIndex, query: '', type: null };
    picker.querySelector('[data-role="pfilter"]').innerHTML = Object.entries(STRATEGY)
      .map(([v, s]) => `<button type="button" data-ptype="${v}" aria-pressed="false">${esc(s.name)}</button>`).join('');
    picker.querySelector('[data-role="pq"]').value = '';
    paintPicker();
    picker.hidden = false;
    picker.querySelector('[data-role="pq"]').focus();
  }

  function paintPicker() {
    const grid = picker.querySelector('[data-role="pgrid"]');
    const title = picker.querySelector('[data-role="title"]');
    const subtitle = picker.querySelector('[data-role="subtitle"]');
    const slot = cm.roster[pickerState.slotIndex];

    if (pickerState.kind === 'card') {
      const analysis = analyseSlot(slot);
      const borrowed = borrowedIn(slot, pickerState.deckIndex).length;
      title.textContent = `Support card · uma ${pickerState.slotIndex + 1}, slot ${pickerState.deckIndex + 1}`;
      subtitle.textContent = cm.useOwned
        ? `Sorted by what it would add to this deck. ${borrowed >= BORROWED_ALLOWANCE ? 'The borrowed slot is already taken, so only cards you own are offered.' : 'One card you do not own may be borrowed from a friend.'}`
        : 'Sorted by what it would actually add to this deck — priority skills first, then expected lengths.';
      const rows = rankCards(analysis, pickerState.deckIndex, { query: pickerState.query, type: pickerState.type }).slice(0, 60);
      grid.innerHTML = rows.map(cardRow).join('') || '<p class="muted small">Nothing matches.</p>';
    } else {
      title.textContent = `Umamusume · slot ${pickerState.slotIndex + 1}`;
      subtitle.textContent = 'Sorted by what their own unique and skill list is worth on this course, discounted for missing aptitude.';
      const rows = rankUmas({ query: pickerState.query, strategy: pickerState.type ? Number(pickerState.type) : null }).slice(0, 60);
      grid.innerHTML = rows.map(umaRow).join('')
        || '<p class="muted small">Nothing matches. Tick some umas on the Collection page, or turn the restriction off there.</p>';
    }
  }

  /** Does this skill satisfy one of the priority entries, allowing rank swaps? */
  function priorityHit(skillId) {
    return cm.priority.some((pid) => {
      if (pid === skillId) return true;
      const s = db.skillById.get(pid);
      if (!priorityAnyRank(pid) || !s?.groupId) return false;
      return (db.skillsByGroup.get(s.groupId) ?? []).some((x) => x.id === skillId);
    });
  }

  function cardRow(r) {
    const skills = r.skills.slice(0, 10);
    return `<div class="pick-row${r.inDeck ? ' pick-row--in' : ''}${r.blocked ? ' pick-row--blocked' : ''}">
      <img src="./img/support/${esc(r.card.id)}.webp" alt="" width="48" height="48" loading="lazy">
      <div style="min-width:0">
        <div class="row" style="gap:5px">
          <b>${esc(r.card.name)}</b>
          <span class="chip chip--accent">${esc(r.card.rarityName)}</span>
          <span class="chip">${esc(r.card.typeName)}</span>
          ${r.owned || !cm.useOwned ? '' : '<span class="chip chip--warn">borrowed</span>'}
          ${r.inDeck ? '<span class="chip chip--accent">already in this deck</span>' : ''}
        </div>
        <div class="chips" style="margin-top:5px">
          ${skills.map((s) => skillPill(s.skill, {
    tag: s.kind, match: priorityHit(s.skill.id), dim: s.held || !s.scored,
  })).join('')}
          ${r.skills.length > skills.length ? `<span class="chip">+${r.skills.length - skills.length}</span>` : ''}
        </div>
      </div>
      <div class="pick-row__side">
        <div class="pick-row__value">${r.gain.toFixed(2)}</div>
        <div class="tiny muted">lengths added</div>
        ${r.newPriority.length ? `<div class="chip chip--accent" style="margin-top:4px">+${r.newPriority.length} priority</div>` : ''}
        ${r.blocked
    ? '<span class="tiny muted" style="margin-top:6px;display:block">borrow slot used</span>'
    : `<button class="btn btn--primary btn--sm" type="button" data-pick="${esc(r.card.id)}" style="margin-top:6px;width:100%;justify-content:center">${r.inDeck ? 'Move here' : 'Add'}</button>`}
      </div>
    </div>`;
  }

  function umaRow(r) {
    const o = r.outfit;
    return `<div class="pick-row">
      <img src="./img/chara/${esc(o.id)}.webp" alt="" width="48" height="48" loading="lazy">
      <div style="min-width:0">
        <div class="row" style="gap:5px">
          <b>${esc(o.charaName)}</b>
          <span class="chip chip--accent">${esc(o.strategyName)}</span>
          <span class="chip ${r.aptitudes.distanceVal >= 7 ? '' : 'chip--warn'}">${esc(r.aptitudes.distance)}</span>
          <span class="chip ${r.aptitudes.surfaceVal >= 7 ? '' : 'chip--warn'}">${esc(r.aptitudes.surface)}</span>
        </div>
        <div class="tiny muted">${esc(o.epithet)}</div>
        <div class="chips" style="margin-top:5px">
          ${r.skills.slice(0, 6).map((s) => skillPill(s.skill, { match: priorityHit(s.skill?.id), dim: !s.scored })).join('')}
        </div>
      </div>
      <div class="pick-row__side">
        <div class="pick-row__value">${r.value.toFixed(2)}</div>
        <div class="tiny muted">own kit, lengths</div>
        <div class="tiny muted" style="margin-top:3px">unique ${r.unique.toFixed(2)}</div>
        <button class="btn btn--primary btn--sm" type="button" data-pick="${esc(o.id)}" style="margin-top:6px;width:100%;justify-content:center">Choose</button>
      </div>
    </div>`;
  }

  picker.querySelector('[data-role="pq"]').addEventListener('input', debounce((e) => {
    pickerState.query = e.target.value; paintPicker();
  }, 130));
  on(picker, 'click', '[data-ptype]', (e, t) => {
    pickerState.type = pickerState.type === t.dataset.ptype ? null : t.dataset.ptype;
    picker.querySelectorAll('[data-ptype]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ptype === pickerState.type)));
    paintPicker();
  });
  on(picker, 'click', '[data-pick]', (e, t) => {
    const slot = cm.roster[pickerState.slotIndex];
    if (pickerState.kind === 'card') {
      if (!canPlace(slot, pickerState.deckIndex, t.dataset.pick)) return;
      slot.deck[pickerState.deckIndex] = t.dataset.pick;
    } else {
      slot.outfitId = t.dataset.pick;
    }
    commitContext();
    picker.hidden = true;
    paint();
  });

  /* ------------------------------------------------------------------ paint */

  function paint() {
    const course = currentCourse();
    raceEl.innerHTML = `<a class="chip chip--accent" href="#/planner">${esc(course.trackName)} ${course.distance}m ${esc(course.surfaceName)} · ${esc(course.turnName)} · ${cm.fieldSize} runners</a>`;
    paintPriority();
    paintBuilds();

    const analyses = cm.roster.map(analyseSlot);
    summaryEl.replaceChildren(teamSummary(analyses));
    adviceEl.replaceChildren(adviceCard(recommendations(analyses)));
    slotsEl.replaceChildren(...analyses.map((a, i) => slotCard(a, i)));
  }

  function teamSummary(analyses) {
    const filled = analyses.filter((a) => a.outfit);
    const styles = new Set(filled.map((a) => a.ctx.strategy));
    const total = analyses.reduce((n, a) => n + a.total, 0);
    const teamCovered = cm.priority.filter((id) => analyses.some((a) => a.coverage.find((c) => c.skill?.id === id && c.hit)));
    const pct = cm.priority.length ? teamCovered.length / cm.priority.length : 0;
    const cardUse = new Map();
    for (const a of analyses) for (const c of a.cards) if (c) cardUse.set(c.id, (cardUse.get(c.id) ?? 0) + 1);
    const shared = [...cardUse.entries()].filter(([, n]) => n > 1);

    return el(`<div class="plan-grid">
      <div class="stat-tile ${filled.length === 3 ? 'stat-tile--ok' : ''}">
        <h4>Entry</h4>
        <div class="big">${filled.length}<span style="font-size:15px;font-weight:500"> / 3</span></div>
        <div class="sub">${styles.size} running style${styles.size === 1 ? '' : 's'}${styles.size < 2 && filled.length > 1 ? ' — all the same' : ''}</div>
      </div>
      <div class="stat-tile ${cm.priority.length && pct === 1 ? 'stat-tile--ok' : cm.priority.length && pct < 0.5 ? 'stat-tile--bad' : ''}">
        <h4>Priority skills covered</h4>
        <div class="big">${cm.priority.length ? `${teamCovered.length}/${cm.priority.length}` : '—'}</div>
        <div class="sub">${cm.priority.length ? `${Math.round(pct * 100)}% reachable somewhere in the team` : 'add priority skills to measure this'}</div>
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
        <div class="sub">${shared.length ? shared.slice(0, 3).map(([id, n]) => `${db.supportById.get(id)?.name ?? id} ×${n}`).join(', ') : 'no overlap between the three decks'}</div>
      </div>
    </div>`);
  }

  function adviceCard(items) {
    if (!items.length) {
      return el('<section class="panel"><div class="panel__body"><p class="small muted">Nothing to flag — the entry looks coherent for this course.</p></div></section>');
    }
    return el(`<section class="panel">
      <div class="panel__head"><h3>What to fix next</h3><span class="sk-count">${items.length}</span></div>
      <div class="panel__body" style="padding:0">
        <div class="rank-list">
          ${items.map((r) => `<div class="advice advice--${r.severity}">
            <span class="advice__tag">${SEV_LABEL[r.severity]}</span>
            <span style="min-width:0">
              <b>${esc(r.title)}</b>
              <span class="advice__detail">${esc(r.detail)}</span>
            </span>
          </div>`).join('')}
        </div>
      </div>
    </section>`);
  }

  function slotCard(a, index) {
    const slot = cm.roster[index];
    const o = a.outfit;
    const course = currentCourse();

    const deckHtml = slot.deck.map((id, i) => {
      const card = id ? db.supportById.get(id) : null;
      const borrowed = card && cm.useOwned && !ownsCard(card.id);
      return card
        ? `<button class="deck__slot deck__slot--filled" type="button" data-deck="${index}:${i}" title="${esc(card.name)}">
             <img src="./img/support/${esc(card.id)}.webp" alt="${esc(card.name)}" loading="lazy">
             <span class="deck__type">${esc(card.typeName)}</span>
             ${borrowed ? '<span class="deck__borrow">friend</span>' : ''}
             <span class="deck__x" data-clear="${index}:${i}" role="button" aria-label="Remove">✕</span>
           </button>`
        : `<button class="deck__slot" type="button" data-deck="${index}:${i}" aria-label="Add a support card">+</button>`;
    }).join('');

    const typeCount = {};
    for (const c of a.cards) if (c) typeCount[c.typeName] = (typeCount[c.typeName] ?? 0) + 1;
    const eventCount = a.pool.filter((p) => p.kind === 'event').length;
    const hintCount = a.pool.filter((p) => p.kind === 'hint').length;
    const goldCount = a.pool.filter((p) => p.skill.tier === 'gold').length;
    const staminaOk = !o || a.ctx.stats.stamina >= a.sim.requiredStamina;

    return el(`<article class="panel">
      <div class="panel__head">
        <h3>Uma ${index + 1}</h3>
        <div class="row">
          ${o ? `<span class="chip">${a.total.toFixed(2)} len</span><button class="btn btn--ghost btn--sm" data-uma="${index}" type="button">Change</button>` : ''}
        </div>
      </div>
      <div class="panel__body">

        ${o ? `
          <div class="row" style="gap:10px;flex-wrap:nowrap">
            <img src="./img/chara/${esc(o.id)}.webp" alt="" width="52" height="52" loading="lazy" style="border-radius:9px;background:var(--sunken);flex:none">
            <div style="min-width:0;flex:1">
              <div style="font-weight:600">${esc(o.charaName)}</div>
              <div class="tiny muted">${esc(o.epithet)}</div>
              <div class="card__meta">
                <span class="chip ${a.aptitudes.distanceVal >= 7 ? '' : 'chip--warn'}">${esc(course.distanceTypeName)} ${esc(a.aptitudes.distance)}</span>
                <span class="chip ${a.aptitudes.surfaceVal >= 7 ? '' : 'chip--warn'}">${esc(course.surfaceName)} ${esc(a.aptitudes.surface)}</span>
                <span class="chip ${a.aptitudes.styleVal >= 7 ? '' : 'chip--warn'}">Style ${esc(a.aptitudes.style)}</span>
              </div>
            </div>
          </div>
          <div class="field">
            <label>Run as</label>
            <div class="toggle-grid" data-role="slot-style" data-slot="${index}">
              ${Object.entries(STRATEGY).map(([v, s]) => `<button type="button" data-v="${v}" aria-pressed="${Number(v) === a.ctx.strategy}">${esc(s.short)}</button>`).join('')}
            </div>
          </div>`
    : `<button class="btn btn--primary" data-uma="${index}" type="button" style="justify-content:center">Choose an umamusume</button>`}

        <div>
          <h4 class="drawer__h3">Deck</h4>
          <div class="deck">${deckHtml}</div>
          <p class="tiny muted" style="margin-top:6px">
            ${a.cards.filter(Boolean).length}/6 cards${Object.keys(typeCount).length ? ` · ${Object.entries(typeCount).map(([t, n]) => `${n} ${t}`).join(', ')}` : ''}
            ${cm.useOwned ? ` · ${borrowedIn(slot).length}/${BORROWED_ALLOWANCE} borrowed` : ''}
          </p>
        </div>

        ${o ? `
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
                <tr><td>Stamina needed</td><td class="num"${staminaOk ? '' : ' style="color:var(--danger);font-weight:600"'}>${fmt.int(a.sim.requiredStamina)}</td>
                    <td class="small muted">${staminaOk ? `${fmt.int(a.ctx.stats.stamina - a.sim.requiredStamina)} to spare` : `${fmt.int(a.sim.requiredStamina - a.ctx.stats.stamina)} short`}</td></tr>
                <tr><td>Last spurt covered</td><td class="num">${Math.round(a.sim.spurtCoverage * 100)}%</td>
                    <td class="small muted">${fmt.int(a.sim.spurtDistance)}m of ${fmt.int(course.distance / 3)}m</td></tr>
                <tr><td>Acceleration</td><td class="num">${a.sim.accel.opening.toFixed(3)} m/s²</td>
                    <td class="small muted">${a.sim.accel.total.toFixed(2)}s lost on ramps</td></tr>
                <tr><td>Estimated time</td><td class="num">${a.sim.time.toFixed(1)}s</td>
                    <td class="small muted">spurt ${a.sim.speeds.spurt.toFixed(2)} m/s</td></tr>
              </tbody>
            </table>
          </div>` : ''}

        ${cm.priority.length ? `
          <div>
            <h4 class="drawer__h3">Priority coverage <span class="sk-count">${a.covered}/${cm.priority.length}</span></h4>
            ${a.coverage.map(({ skill, hit, via, scored }) => `
              <div class="cover-row">
                <span style="min-width:0">
                  ${skillPill(skill, { dim: !hit })}
                  ${via ? `<span class="tiny muted" style="display:block;margin-top:2px">via ${esc(via.name)}</span>` : ''}
                </span>
                <span class="row" style="gap:5px;flex-wrap:nowrap">
                  ${scored ? `<span class="tiny muted num">${scored.bashin.toFixed(2)}</span>` : '<span class="tiny muted">n/a</span>'}
                  <span class="cover-tag cover-tag--${hit ? (hit.info.kind === 'own' || hit.info.kind === 'unique' ? 'own' : hit.info.kind) : 'miss'}">${hit ? hit.info.kind : 'missing'}</span>
                </span>
              </div>`).join('')}
          </div>` : ''}

        <details class="reach">
          <summary>
            <span>Reachable skills</span>
            <span class="sk-count">${a.usable.length} usable · ${a.total.toFixed(2)} len</span>
          </summary>
          <table class="calc" style="margin-top:8px">
            <tbody>
              <tr><td>Guaranteed from events</td><td class="num">${eventCount}</td><td class="small muted">counted at 100%</td></tr>
              <tr><td>From hints</td><td class="num">${hintCount}</td><td class="small muted">counted at ${Math.round(HINT_CONFIDENCE * 100)}%</td></tr>
              <tr><td>Gold in reach</td><td class="num">${goldCount}</td><td class="small muted">uma list and deck combined</td></tr>
            </tbody>
          </table>
          <div class="stack" style="gap:3px;margin-top:8px">
            ${a.usable.slice(0, 40).map((p) => `
              <div class="cover-row">
                <span style="min-width:0">${skillPill(p.skill, { match: priorityHit(p.skill.id) })}</span>
                <span class="row" style="gap:5px;flex-wrap:nowrap">
                  <span class="tiny muted num">${p.value.toFixed(2)}</span>
                  <span class="cover-tag cover-tag--${p.kind === 'own' || p.kind === 'unique' ? 'own' : p.kind}">${p.kind}</span>
                </span>
              </div>`).join('') || '<p class="tiny muted">Pick an uma and some cards to see what this run can end up with.</p>'}
          </div>
        </details>
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
    cm.roster[Number(t.closest('[data-slot]').dataset.slot)].strategy = Number(t.dataset.v);
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
