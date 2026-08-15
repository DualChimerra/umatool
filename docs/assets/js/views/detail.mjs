// Skill detail drawer. Opens from any skill pill anywhere in the app and
// answers the two questions a pill cannot: what exactly does this do on the
// race I am preparing for, and where do I get it.

import { db, skillIconUrl, groupSiblings } from '../store.mjs';
import { el, esc, on, effectSummary, TIER_LABEL, fmt } from '../ui.mjs';
import { cm, scoringContext, togglePriority, currentCourse } from '../context.mjs';
import { simulateRace, scoreSkill, BASHIN, STRATEGY } from '../model.mjs';

let drawer = null;
let openId = null;

function ensure() {
  if (drawer) return drawer;
  drawer = el(`<div class="drawer" hidden>
    <div class="drawer__scrim" data-act="close"></div>
    <aside class="drawer__panel" role="dialog" aria-modal="true" aria-label="Skill details"></aside>
  </div>`);
  document.body.append(drawer);
  on(drawer, 'click', '[data-act="close"]', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) close(); });
  return drawer;
}

export function close() {
  if (drawer) drawer.hidden = true;
  openId = null;
}

export function openSkill(id) {
  const skill = db.skillById.get(id);
  if (!skill) return;
  const root = ensure();
  openId = id;
  root.querySelector('.drawer__panel').innerHTML = body(skill);
  root.hidden = false;
  root.querySelector('.drawer__panel').scrollTop = 0;
}

export function initSkillDrawer(scope = document.body) {
  on(scope, 'click', '[data-skill]', (e, t) => {
    if (t.closest('[data-no-drawer]')) return;
    e.preventDefault();
    openSkill(t.dataset.skill);
  });
  ensure();
  on(drawer, 'click', '[data-open-skill]', (e, t) => openSkill(t.dataset.openSkill));
  on(drawer, 'click', '[data-act="priority"]', (e, t) => {
    togglePriority(t.dataset.id);
    openSkill(t.dataset.id);
  });
}

/* ------------------------------------------------------------------- render */

function body(skill) {
  const course = currentCourse();
  const ctx = scoringContext();
  const sim = simulateRace({ course, strategy: ctx.strategy, stats: ctx.stats, ground: ctx.ground, recoveryPct: cm.recovery });
  const evaluated = scoreSkill(skill, { ...ctx, sim });
  const inPriority = cm.priority.includes(skill.id);

  return `
    <header class="drawer__head">
      <img src="${skillIconUrl(skill)}" alt="" width="40" height="40" style="border-radius:50%;background:var(--sunken)">
      <div style="min-width:0;flex:1">
        <h2>${esc(skill.name)}</h2>
        <div class="chips" style="margin-top:5px">
          <span class="chip chip--${skill.tier === 'normal' ? '' : skill.tier}">${TIER_LABEL[skill.tier]}</span>
          ${skill.cost ? `<span class="chip">${skill.cost} SP</span>` : ''}
          ${skill.score ? `<span class="chip">score ${skill.score}</span>` : ''}
          ${skill.duration ? `<span class="chip">${skill.duration}s base</span>` : ''}
          ${skill.wisdomCheck ? '<span class="chip">Wit check</span>' : ''}
        </div>
      </div>
      <button class="icon-btn" data-act="close" type="button" aria-label="Close">✕</button>
    </header>

    <div class="drawer__body">
      <section>
        <h3 class="drawer__h3">Effect</h3>
        <p>${esc(effectSummary(skill))}</p>
        <ul class="cond-list">
          ${skill.variants.map((v) => `<li>${esc(v.text)}<code class="tiny muted">${esc(v.raw.precondition ? `${v.raw.precondition} ⇒ ` : '')}${esc(v.raw.condition)}</code></li>`).join('')}
        </ul>
      </section>

      ${evaluationSection(skill, evaluated, course, ctx, sim)}
      ${siblingsSection(skill)}
      ${sourcesSection(skill)}

      <section>
        <button class="btn ${inPriority ? '' : 'btn--primary'}" type="button" data-act="priority" data-id="${esc(skill.id)}">
          ${inPriority ? 'Remove from priority skills' : 'Add to priority skills'}
        </button>
        <p class="tiny muted" style="margin-top:6px">Priority skills drive the coverage numbers on the Team page.</p>
      </section>
    </div>`;
}

function evaluationSection(skill, r, course, ctx, sim) {
  const head = `<h3 class="drawer__h3">On ${esc(course.trackName)} ${course.distance}m ${esc(course.surfaceName)}, as ${esc(STRATEGY[ctx.strategy].name)}</h3>`;
  if (!r) {
    return `<section>${head}<p class="note">Cannot fire here — the course, surface, distance band or running style rules it out.</p></section>`;
  }

  const rows = [
    ['Raw effect', `${r.metres.toFixed(2)} m (${(r.metres / BASHIN).toFixed(2)} lengths)`, Object.entries(r.parts).map(([k, v]) => `${k} ${v.toFixed(2)}m`).join(', ')],
    ['Effect window', `${r.durSec.toFixed(1)} s`, `starts around ${Math.round(r.at)}m of ${course.distance}m`],
    ['Position condition', fmt.pct(r.pPosition), `${ctx.fieldSize}-runner field, ${STRATEGY[ctx.strategy].name}`],
    ['Wit activation', fmt.pct(r.pWit), skill.wisdomCheck ? `at ${ctx.stats.wit} Wit` : 'not Wit-checked'],
    ['Other requirements', fmt.pct(r.pOther), [...skill.facets.needs].join(', ') || 'none'],
    ['Race-position weight', `×${r.weight.toFixed(2)}`, `fires at ${Math.round(r.fraction * 100)}% into the race`],
  ];

  return `<section>
    ${head}
    <div class="stat-tile" style="margin-bottom:10px">
      <h4>Expected gain</h4>
      <div class="big">${r.bashin.toFixed(2)} <span style="font-size:15px;font-weight:500">lengths</span></div>
      <div class="sub">${(r.score).toFixed(2)} m after weighting · fires ${fmt.pct(r.probability)} of the time</div>
    </div>
    <table class="calc">
      <tbody>
        ${rows.map(([a, b, c]) => `<tr><td>${esc(a)}</td><td class="num">${esc(b)}</td><td class="small muted">${esc(c)}</td></tr>`).join('')}
      </tbody>
    </table>
    <p class="tiny muted" style="margin-top:6px">
      Expected gain = raw effect × position weight × P(position) × P(Wit) × P(other requirements), converted to lengths at ${BASHIN} m each.
    </p>
  </section>`;
}

function siblingsSection(skill) {
  const sibs = groupSiblings(skill.id).filter((s) => s.id !== skill.id && !s.inherited);
  if (!sibs.length) return '';
  return `<section>
    <h3 class="drawer__h3">Same skill group</h3>
    <div class="chips">${sibs.map((s) => `
      <button type="button" class="skill skill--${s.tier === 'normal' ? '' : s.tier}" data-open-skill="${esc(s.id)}">
        <img src="${skillIconUrl(s)}" alt="" width="22" height="22">
        <span class="skill__name">${esc(s.name)}</span>
        <span class="skill__tag">${TIER_LABEL[s.tier]}</span>
      </button>`).join('')}</div>
    <p class="tiny muted" style="margin-top:6px">Cards and umas carrying any of these count as a match when “also match the other rank” is on.</p>
  </section>`;
}

function sourcesSection(skill) {
  const src = skill.sources ?? { unique: [], characters: [], event: [], hint: [] };

  const umaRow = (outfitId, tag) => {
    const o = db.outfitById.get(outfitId);
    if (!o) return '';
    return `<a class="src-row" href="#/umas?q=${encodeURIComponent(o.charaName)}">
      <img src="./img/chara/${esc(o.id)}.webp" alt="" width="34" height="34" loading="lazy">
      <span style="min-width:0">
        <b>${esc(o.charaName)}</b>
        <span class="src-row__sub">${esc(o.epithet)} · ${esc(o.strategyName)}</span>
      </span>
      <span class="chip">${esc(tag)}</span>
    </a>`;
  };

  const cardRow = (cardId, tag) => {
    const c = db.supportById.get(cardId);
    if (!c) return '';
    return `<a class="src-row" href="#/cards?q=${encodeURIComponent(c.name)}">
      <img src="./img/support/${esc(c.id)}.webp" alt="" width="34" height="34" loading="lazy">
      <span style="min-width:0">
        <b>${esc(c.name)}</b>
        <span class="src-row__sub">${esc(c.rarityName)} ${esc(c.typeName)} · #${esc(c.id)}</span>
      </span>
      <span class="chip ${tag === 'event' ? 'chip--accent' : ''}">${esc(tag)}</span>
    </a>`;
  };

  const globalCards = (ids) => ids.filter((id) => db.supportById.get(id)?.global);
  const events = globalCards(src.event);
  const hints = globalCards(src.hint);

  const blocks = [
    src.unique.length ? ['Unique skill of', src.unique.map((id) => umaRow(id, 'unique')).join('')] : null,
    src.characters.length ? ['In these umas’ own skill lists', src.characters.map((id) => umaRow(id, 'skill list')).join('')] : null,
    events.length ? [`Guaranteed from card events (${events.length})`, events.map((id) => cardRow(id, 'event')).join('')] : null,
    hints.length ? [`From card hints (${hints.length})`, hints.map((id) => cardRow(id, 'hint')).join('')] : null,
  ].filter(Boolean);

  if (!blocks.length) {
    return '<section><h3 class="drawer__h3">Where to get it</h3><p class="note">No Global uma or support card teaches this one — it comes from a scenario, an inherited unique or an event outside the card pool.</p></section>';
  }

  return `<section>
    <h3 class="drawer__h3">Where to get it</h3>
    ${blocks.map(([title, rows]) => `
      <h4 class="drawer__h4">${esc(title)}</h4>
      <div class="src-list">${rows}</div>`).join('')}
  </section>`;
}
