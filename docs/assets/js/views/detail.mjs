// Skill detail drawer. Opens from any skill pill anywhere in the app and
// answers the two questions a pill cannot: what exactly does this do on the
// race I am preparing for, and where do I get it.

import { db, skillIconUrl, groupSiblings } from '../store.mjs';
import {
  el, esc, on, icon, effectTags, valueBar, skillTrack, PART_NAME, TIER_LABEL, fmt,
} from '../ui.mjs';
import { cm, scoringContext, togglePriority, currentCourse, fieldSummary } from '../context.mjs';
import {
  simulateRace, scoreSkill, skillFiring, BASHIN, STRATEGY, TARGET_KIND, isPassive,
  GROUND_NAME, WEATHER_NAME, SEASON_NAME,
} from '../model.mjs';

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
  const sim = simulateRace({ ...ctx, recoveryPct: cm.recovery });
  const evaluated = scoreSkill(skill, { ...ctx, sim, recoveryPct: cm.recovery });
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
      <button class="icon-btn" data-act="close" type="button" aria-label="Close">${icon('close', { size: 18 })}</button>
    </header>

    <div class="drawer__body">
      <section>
        <h3 class="drawer__h3">${icon('spark', { size: 13 })}Effect</h3>
        <div class="facts">${effectTags(skill)}</div>
        <ul class="cond-list">
          ${skill.variants.map((v) => `<li>
            <span>${esc(v.text)}</span>
            <code class="tiny muted">${esc(v.raw.precondition ? `${v.raw.precondition} then ` : '')}${esc(v.raw.condition)}</code>
          </li>`).join('')}
        </ul>
      </section>

      ${evaluationSection(skill, evaluated, course, ctx, sim)}
      ${siblingsSection(skill)}
      ${sourcesSection(skill)}

      <section>
        <button class="btn ${inPriority ? '' : 'btn--primary'}" type="button" data-act="priority" data-id="${esc(skill.id)}">
          ${inPriority ? 'Remove from priority skills' : 'Add to priority skills'}
        </button>
        <p class="tiny muted" style="margin-top:6px">Priority skills drive the coverage numbers on the Team page. One entry per skill group: picking another rank moves the target rather than adding a second row.</p>
      </section>
    </div>`;
}

function evaluationSection(skill, r, course, ctx, sim) {
  const head = `<h3 class="drawer__h3">${icon('gauge', { size: 13 })}On ${esc(course.trackName)} ${course.distance}m
    ${esc(course.surfaceName)}, ${esc(GROUND_NAME[cm.ground])} / ${esc(WEATHER_NAME[cm.weather])} /
    ${esc(SEASON_NAME[cm.season])}, as ${esc(STRATEGY[ctx.strategy].name)}</h3>`;
  if (!r) {
    return `<section>${head}<p class="note">Cannot fire here. One of its hard gates &mdash; running style, distance
      band, surface, handedness, track, going, weather or season &mdash; is not met by this race, so it is dropped
      rather than discounted.</p></section>`;
  }

  const firing = skillFiring(skill, r, course, sim);
  const nominal = skill.duration * (course.distance / 1000);
  const target = skill.effects.find((e) => e.target !== 1)?.target;

  // Every multiplier between the raw effect and the number on the card, shown
  // as the chain it actually is rather than a single opaque total.
  const chain = [
    ['Raw effect', `${((r.metres + r.rivalMetres) / BASHIN).toFixed(2)} len`,
      r.rivalMetres
        ? `${r.metres.toFixed(2)} m of your own ground, ${r.rivalMetres.toFixed(2)} m off the field`
        : `${r.metres.toFixed(2)} m of ground`],
    ['Race-position weight', `\u00d7${r.weight.toFixed(2)}`, `fires ${Math.round(r.fraction * 100)}% into the race`],
    ['Position condition', `\u00d7${r.pPosition.toFixed(2)}`, positionText(r, ctx)],
    ['Wit activation', `\u00d7${r.pWit.toFixed(2)}`, skill.wisdomCheck ? `at ${ctx.stats.wit} Wit` : 'not Wit-checked'],
    ['Other requirements', `\u00d7${r.pOther.toFixed(2)}`,
      r.reasons.find((x) => x.startsWith('needs ')) ?? 'no further conditions'],
  ];
  if ((r.pPre ?? 1) < 0.999) {
    chain.push(['Precondition', `\u00d7${r.pPre.toFixed(2)}`, 'has to have been true once before the skill arms']);
  }
  if (target != null) {
    chain.splice(1, 0, ['Lands on', esc(TARGET_KIND[target]?.label ?? 'rivals'),
      `${r.victims.n} runner${r.victims.n === 1 ? '' : 's'} in this field`]);
  }

  const partRows = Object.entries(r.parts)
    .filter(([, v]) => Math.abs(v) > 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([k, v]) => `<tr><td>${esc(PART_NAME[k] ?? k)}</td><td class="num">${(v / BASHIN).toFixed(2)} len</td>
      <td class="num small muted">${Math.round((v / (r.metres + r.rivalMetres)) * 100)}%</td></tr>`).join('');

  return `<section>
    ${head}
    <div class="headline">
      <div class="headline__num">${r.bashin.toFixed(2)}<span>lengths</span></div>
      <div class="headline__side">
        ${valueBar(r.parts)}
        <div class="facts" style="margin-top:8px">
          <span class="fact">fires <b>${fmt.pct(r.probability)}</b> of the time</span>
          <span class="fact">runs <b>${r.durSec.toFixed(1)}s</b>${firing ? ` over <b>${Math.round(firing.length)}m</b>` : ''}</span>
          ${skill.cost ? `<span class="fact"><b>${(r.perSp ?? 0).toFixed(2)}</b> per 100 SP</span>` : ''}
          ${r.rivalBashin ? `<span class="fact"><b>${r.rivalBashin.toFixed(2)}</b> of it taken off rivals</span>` : ''}
        </div>
      </div>
    </div>

    ${firing ? `<div class="timeline">
      <div class="timeline__head">
        <span>${icon('route', { size: 13 })}Where it happens</span>
        <span class="sk-count">${Math.round(firing.start)}m to ${Math.round(firing.end)}m of ${course.distance}m</span>
      </div>
      ${skillTrack(firing, course, { height: 26 })}
      <div class="legend">
        <span><i style="background:var(--accent)"></i>effect is live</span>
        <span><i style="background:var(--line-strong)"></i>eligible stretch</span>
        <span><i style="background:var(--line-soft)"></i>leg boundaries</span>
      </div>
      <div class="facts" style="margin-top:8px">
        <span class="fact">starts in the <b>${esc(firing.phase === 'spurt' ? 'last spurt' : `${firing.phase} leg`)}</b></span>
        ${firing.random ? '<span class="fact">lands <b>somewhere</b> in the eligible stretch</span>' : '<span class="fact">start point is <b>fixed</b></span>'}
        ${firing.inSpurt ? '<span class="fact">overlaps the <b>last spurt</b></span>' : ''}
        ${firing.secondsClipped > 0.05 ? `<span class="fact">line cuts it <b>${firing.secondsClipped.toFixed(1)}s</b> short of ${nominal.toFixed(1)}s</span>` : ''}
      </div>
    </div>` : ''}

    <h4 class="drawer__h4">What the ground is made of</h4>
    <table class="calc"><tbody>${partRows}</tbody></table>

    <h4 class="drawer__h4">How the number is reached</h4>
    <table class="calc">
      <tbody>${chain.map(([a, b, c]) => `<tr><td>${esc(a)}</td><td class="num">${b}</td><td class="small muted">${esc(c)}</td></tr>`).join('')}</tbody>
    </table>
    ${r.reasons.length ? `<ul class="cond-list" style="margin-top:9px">${r.reasons.map((x) => `<li class="small muted">${esc(x)}</li>`).join('')}</ul>` : ''}
    <p class="tiny muted" style="margin-top:8px">
      ${isPassive(skill) || skill.duration === 0
    ? 'A passive: priced from the same finite difference as the stat table on the Planner, so it is worth what the stat is worth in <em>this</em> race.'
    : `Multiply the chain together and divide by ${BASHIN} m to get the ${r.bashin.toFixed(2)} lengths above.`}
      Check it against the full field on the <a href="#/race">Race</a> page.
    </p>
  </section>`;
}

/** What the positional requirement is, and how often this field satisfies it. */
function positionText(r, ctx) {
  const p = r.position ?? {};
  const bits = [];
  if (p.orderMin != null) bits.push(`${p.orderMin}th or further back`);
  if (p.orderMax != null) bits.push(`${p.orderMax}th or better`);
  if (p.rateMin != null) bits.push(`bottom ${100 - p.rateMin}%`);
  if (p.rateMax != null) bits.push(`top ${p.rateMax}%`);
  if (!bits.length) return `no positional requirement (${ctx.fieldSize} runners)`;
  return `${bits.join(', ')} in a field of ${fieldSummary()}`;
}

function siblingsSection(skill) {
  const sibs = groupSiblings(skill.id).filter((s) => s.id !== skill.id && !s.inherited);
  if (!sibs.length) return '';
  return `<section>
    <h3 class="drawer__h3">${icon('layers', { size: 13 })}Same skill group</h3>
    <div class="chips">${sibs.map((s) => `
      <button type="button" class="skill skill--${s.tier === 'normal' ? '' : s.tier}" data-open-skill="${esc(s.id)}">
        <img src="${skillIconUrl(s)}" alt="" width="22" height="22">
        <span class="skill__name">${esc(s.name)}</span>
        <span class="skill__tag">${TIER_LABEL[s.tier]}</span>
      </button>`).join('')}</div>
    <p class="tiny muted" style="margin-top:6px">On the Team page a <b>better</b> rank always satisfies a priority entry, a weaker one only when the entry opts in, and the × rank never does — it is the same group with the opposite effect.</p>
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
        <span class="src-row__sub">${esc(o.epithet)}, ${esc(o.strategyName)}</span>
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
        <span class="src-row__sub">${esc(c.rarityName)} ${esc(c.typeName)}, #${esc(c.id)}</span>
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
    <h3 class="drawer__h3">${icon('flag', { size: 13 })}Where to get it</h3>
    ${blocks.map(([title, rows]) => `
      <h4 class="drawer__h4">${esc(title)}</h4>
      <div class="src-list">${rows}</div>`).join('')}
  </section>`;
}
