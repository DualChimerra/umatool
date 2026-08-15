// Панель скилла. Открывается с любой пилюли скилла в приложении и отвечает на
// два вопроса, на которые пилюля ответить не может: что именно этот скилл даёт
// в забеге, к которому я готовлюсь, и где его взять.

import { db, skillIconUrl, groupSiblings } from '../store.mjs';
import { el, esc, on, effectSummary, TIER_LABEL, PART_LABEL, NEED_LABEL, fmt } from '../ui.mjs';
import { cm, scoringContext, togglePriority, currentCourse } from '../context.mjs';
import { simulateRace, scoreSkill, BASHIN, STRATEGY } from '../model.mjs';

let drawer = null;
let openId = null;

function ensure() {
  if (drawer) return drawer;
  drawer = el(`<div class="drawer" hidden>
    <div class="drawer__scrim" data-act="close"></div>
    <aside class="drawer__panel" role="dialog" aria-modal="true" aria-label="Подробности скилла"></aside>
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
          ${skill.score ? `<span class="chip">очки ${skill.score}</span>` : ''}
          ${skill.duration ? `<span class="chip">база ${skill.duration}s</span>` : ''}
          ${skill.wisdomCheck ? '<span class="chip">проверка Wit</span>' : ''}
        </div>
      </div>
      <button class="icon-btn" data-act="close" type="button" aria-label="Закрыть">✕</button>
    </header>

    <div class="drawer__body">
      <section>
        <h3 class="drawer__h3">Эффект</h3>
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
          ${inPriority ? 'Убрать из приоритетных' : 'Добавить в приоритетные'}
        </button>
        <p class="tiny muted" style="margin-top:6px">По приоритетным скиллам считается покрытие на странице «Команда». На одну группу скиллов идёт одна запись: выбор другого ранга заменит прежний.</p>
      </section>
    </div>`;
}

function evaluationSection(skill, r, course, ctx, sim) {
  const head = `<h3 class="drawer__h3">На ${esc(course.trackName)} ${course.distance}m ${esc(course.surfaceName)}, стилем ${esc(STRATEGY[ctx.strategy].name)}</h3>`;
  if (!r) {
    return `<section>${head}<p class="note">Здесь не сработает — исключается курсом, покрытием, дистанционной категорией или стилем бега.</p></section>`;
  }

  const rows = [
    ['Чистый эффект', `${r.metres.toFixed(2)} m (${(r.metres / BASHIN).toFixed(2)} корп.)`, Object.entries(r.parts).map(([k, v]) => `${PART_LABEL[k] ?? k} ${v.toFixed(2)}m`).join(', ')],
    ['Окно эффекта', `${r.durSec.toFixed(1)} s`, `начинается примерно на ${Math.round(r.at)}m из ${course.distance}m`],
    ['Условие по позиции', fmt.pct(r.pPosition), `поле из ${ctx.fieldSize}, ${STRATEGY[ctx.strategy].name}`],
    ['Срабатывание Wit', fmt.pct(r.pWit), skill.wisdomCheck ? `при ${ctx.stats.wit} Wit` : 'без проверки Wit'],
    ['Прочие требования', fmt.pct(r.pOther), skill.facets.needs.map((n) => NEED_LABEL[n] ?? n).join(', ') || 'нет'],
    ['Вес по месту в забеге', `×${r.weight.toFixed(2)}`, `срабатывает на ${Math.round(r.fraction * 100)}% дистанции`],
  ];

  return `<section>
    ${head}
    <div class="stat-tile" style="margin-bottom:10px">
      <h4>Ожидаемый выигрыш</h4>
      <div class="big">${r.bashin.toFixed(2)} <span style="font-size:15px;font-weight:500">корпуса</span></div>
      <div class="sub">${(r.score).toFixed(2)} m после весов · срабатывает в ${fmt.pct(r.probability)} случаев</div>
    </div>
    <table class="calc">
      <tbody>
        ${rows.map(([a, b, c]) => `<tr><td>${esc(a)}</td><td class="num">${esc(b)}</td><td class="small muted">${esc(c)}</td></tr>`).join('')}
      </tbody>
    </table>
    <p class="tiny muted" style="margin-top:6px">
      Ожидаемый выигрыш = чистый эффект × вес по месту в забеге × P(позиции) × P(Wit) × P(прочих требований), переведённый в корпуса по ${BASHIN} m каждый.
    </p>
  </section>`;
}

function siblingsSection(skill) {
  const sibs = groupSiblings(skill.id).filter((s) => s.id !== skill.id && !s.inherited);
  if (!sibs.length) return '';
  return `<section>
    <h3 class="drawer__h3">Та же группа скиллов</h3>
    <div class="chips">${sibs.map((s) => `
      <button type="button" class="skill skill--${s.tier === 'normal' ? '' : s.tier}" data-open-skill="${esc(s.id)}">
        <img src="${skillIconUrl(s)}" alt="" width="22" height="22">
        <span class="skill__name">${esc(s.name)}</span>
        <span class="skill__tag">${TIER_LABEL[s.tier]}</span>
      </button>`).join('')}</div>
    <p class="tiny muted" style="margin-top:6px">Ранг выше засчитывается за этот скилл всегда, ранг ниже — только если это отмечено в приоритетах. Ранг × не засчитывается никогда: это обратный эффект.</p>
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
      <span class="chip ${tag === 'ивент' ? 'chip--accent' : ''}">${esc(tag)}</span>
    </a>`;
  };

  const globalCards = (ids) => ids.filter((id) => db.supportById.get(id)?.global);
  const events = globalCards(src.event);
  const hints = globalCards(src.hint);

  const blocks = [
    src.unique.length ? ['Уник этих ум', src.unique.map((id) => umaRow(id, 'уник')).join('')] : null,
    src.characters.length ? ['В собственных списках этих ум', src.characters.map((id) => umaRow(id, 'список')).join('')] : null,
    events.length ? [`Гарантированно с ивентов карт (${events.length})`, events.map((id) => cardRow(id, 'ивент')).join('')] : null,
    hints.length ? [`С хинтов карт (${hints.length})`, hints.map((id) => cardRow(id, 'хинт')).join('')] : null,
  ].filter(Boolean);

  if (!blocks.length) {
    return '<section><h3 class="drawer__h3">Где взять</h3><p class="note">Этому скиллу не учит ни одна ума и ни одна карта поддержки на Global — он приходит из сценария, унаследованного уника или ивента вне пула карт.</p></section>';
  }

  return `<section>
    <h3 class="drawer__h3">Где взять</h3>
    ${blocks.map(([title, rows]) => `
      <h4 class="drawer__h4">${esc(title)}</h4>
      <div class="src-list">${rows}</div>`).join('')}
  </section>`;
}
