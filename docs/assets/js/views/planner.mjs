import { db, isObtainable } from '../store.mjs';
import { el, esc, on, skillPill, effectSummary, fmt, turnLabel } from '../ui.mjs';
import { cm, commitContext, currentCourse, scoringContext, DEFAULT_STATS } from '../context.mjs';
import {
  simulateRace, rankSkills, statGuide, statSensitivity, STRATEGY,
  orderDistribution, orderRate, activationRate, BASHIN, CM_FIELD_SIZE,
} from '../model.mjs';
import { cardSkills } from '../analysis.mjs';

const GROUND = [[1, 'Firm'], [2, 'Good'], [3, 'Soft'], [4, 'Heavy']];
const STATS = [['speed', 'Speed'], ['stamina', 'Stamina'], ['power', 'Power'], ['guts', 'Guts'], ['wit', 'Wit']];
const STAT_RU = { speed: 'Speed', stamina: 'Stamina', power: 'Power', guts: 'Guts', wit: 'Wit' };

export function renderPlanner(root) {
  const layout = el(`<div class="layout">
    <aside class="rail"></aside>
    <section class="stack">
      <div class="page-head">
        <div>
          <h1>Планировщик</h1>
          <p>Выбери забег, к которому готовишься. Всё ниже — и страница «Команда» — считается от него.</p>
        </div>
      </div>
      <nav class="jump" data-role="jump"></nav>
      <div data-role="out" class="stack"></div>
    </section>
  </div>`);

  const rail = layout.querySelector('.rail');
  const out = layout.querySelector('[data-role="out"]');

  /* ---------------------------------------------------------- управление */

  const tracks = [...new Set(db.courses.map((c) => c.trackName))].sort();
  const controls = el(`<section class="panel">
    <div class="panel__head"><h3>Забег</h3></div>
    <div class="panel__body">
      <div class="field">
        <label>Ипподром</label>
        <select class="select" data-role="track">${tracks.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Дистанция</label><select class="select" data-role="course"></select></div>
      <div class="field">
        <label>Стиль бега</label>
        <div class="toggle-grid" data-role="strategy">
          ${Object.entries(STRATEGY).map(([v, s]) => `<button type="button" data-v="${v}" aria-pressed="${Number(v) === cm.strategy}">${esc(s.name)}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Состояние грунта</label>
        <div class="toggle-grid" data-role="ground">
          ${GROUND.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === cm.ground}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Участниц в забеге</label>
        <div class="toggle-grid" data-role="field">
          ${[9, 12, 18].map((n) => `<button type="button" data-v="${n}" aria-pressed="${n === cm.fieldSize}">${n}${n === CM_FIELD_SIZE ? ' · CM' : ''}</button>`).join('')}
        </div>
      </div>
    </div>
  </section>`);

  const statsPanel = el(`<section class="panel">
    <div class="panel__head"><h3>Твои статы</h3><button class="btn btn--ghost btn--sm" data-act="stat-reset" type="button">Сброс</button></div>
    <div class="panel__body">
      <div class="field">
        <label>Потолок статов</label>
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
        <label>Восстановление со скиллов</label>
        <div class="range-row">
          <input type="range" min="0" max="60" step="1" data-role="recovery" value="${cm.recovery}">
          <output data-out="recovery">${cm.recovery}%</output>
        </div>
      </div>
      <details class="explain">
        <summary>Про потолок и восстановление</summary>
        <p>Сценарии продолжают поднимать потолок статов, поэтому здесь ничего не зашито в 1200: поставь то, что позволяет твой сценарий, — ползунки и целевые диапазоны подстроятся.</p>
        <p>Восстановление — суммарный процент от запаса выносливости, который лечащие скиллы возвращают за забег.</p>
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

  /* ---------------------------------------------------------------- отрисовка */

  function paint() {
    const course = currentCourse();
    const ctx = scoringContext();
    const sim = simulateRace({ course, strategy: ctx.strategy, stats: ctx.stats, ground: ctx.ground, recoveryPct: cm.recovery });
    const full = { ...ctx, sim };

    const ranked = rankSkills(db.learnable, full);
    const uniques = ranked.filter((r) => r.skill.tier === 'unique' || r.skill.tier === 'evolved');
    const allLearnable = ranked.filter((r) => r.skill.tier === 'gold' || r.skill.tier === 'normal');
    const learnable = cm.obtainableOnly === false ? allLearnable : allLearnable.filter((r) => isObtainable(r.skill));
    const hiddenCount = allLearnable.length - learnable.length;
    const recovery = learnable.filter((r) => r.skill.effects.some((e) => e.kind === 'recovery'));
    const sensitivity = statSensitivity({ ...full, recoveryPct: cm.recovery }, db.learnable);

    layout.querySelector('[data-role="jump"]').innerHTML = [
      ['course', 'Курс'], ['stats', 'Цели по статам'],
      ['skills', 'Лучшие скиллы'], ['uniques', 'Уники'], ['cards', 'Карты'],
    ].map(([id, label]) => `<a href="#/planner" data-jump="${id}">${label}</a>`).join('');

    out.replaceChildren(
      courseCard(course, sim),
      statCards(course, sim),
      guideCard(course, sim, sensitivity),
      rankCard('Лучшие скиллы для этого курса', learnable.slice(0, 30), learnable.length, hiddenCount),
      recovery.length ? rankCard('Лучшие скиллы на восстановление', recovery.slice(0, 12), recovery.length) : el('<span hidden></span>'),
      uniqueCard(uniques.slice(0, 24), uniques.length),
      cardSourcesCard(learnable.slice(0, 24)),
      fieldCard(ctx),
    );
  }

  /* ------------------------------------------------------------- фрагменты */

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
        ${trackSvg(course, sim)}
        <div class="factlist">
          <span>поворотов <b class="num">${d.cornerCount}</b> (${fmt.int(d.cornerLength)}m)</span>
          <span>последний поворот на <b class="num">${d.finalCornerStart != null ? fmt.int(d.finalCornerStart) : '—'}</b>m</span>
          <span>финишная прямая <b class="num">${fmt.int(d.lastStraightLength)}</b>m</span>
          <span>подъём <b class="num">${fmt.int(d.uphillLength)}</b>m</span>
          <span>спуск <b class="num">${fmt.int(d.downhillLength)}</b>m</span>
          <span>спурт с <b class="num">${fmt.int(course.distance - sim.spurtDistance)}</b>m</span>
        </div>
      </div>
    </section>`);
  }

  function trackSvg(course, sim) {
    const W = 1000; const H = 74;
    const x = (m) => (m / course.distance) * W;
    const seg = (a, b, fill, y, h) => `<rect x="${x(a).toFixed(1)}" y="${y}" width="${Math.max(1, x(b) - x(a)).toFixed(1)}" height="${h}" fill="${fill}"/>`;

    const straights = course.straights.map((s) => seg(s.start, s.end, 'color-mix(in srgb, var(--accent) 28%, transparent)', 26, 16)).join('');
    const corners = course.corners.map((c) => seg(c.start, c.start + c.length, 'var(--line)', 26, 16)).join('');
    const up = course.derived.uphill.map((s) => seg(s.start, s.start + s.length, 'color-mix(in srgb, var(--danger) 55%, transparent)', 46, 7)).join('');
    const down = course.derived.downhill.map((s) => seg(s.start, s.start + s.length, 'color-mix(in srgb, var(--turf) 60%, transparent)', 46, 7)).join('');
    const spurt = seg(course.distance - sim.spurtDistance, course.distance, 'color-mix(in srgb, var(--gold) 45%, transparent)', 20, 4);

    const marks = [[course.distance / 6, 'середина'], [(course.distance * 2) / 3, 'финальный отрезок']].map(([m, label]) => `
      <line x1="${x(m).toFixed(1)}" y1="18" x2="${x(m).toFixed(1)}" y2="60" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${(x(m) + 4).toFixed(1)}" y="14" font-size="11" fill="var(--ink-3)">${label}</text>`).join('');

    return `<svg class="track-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Профиль курса">
      ${straights}${corners}${up}${down}${spurt}${marks}
      <text x="2" y="70" font-size="11" fill="var(--ink-3)">старт</text>
      <text x="${W - 4}" y="70" font-size="11" fill="var(--ink-3)" text-anchor="end">финиш</text>
    </svg>`;
  }

  function statCards(course, sim) {
    const need = sim.requiredStamina;
    const have = cm.stats.stamina;
    const ok = have >= need;
    const coverage = Math.round(sim.spurtCoverage * 100);
    return el(`<div class="plan-grid">
      <div class="stat-tile ${ok ? 'stat-tile--ok' : 'stat-tile--bad'}">
        <h4>Нужно Stamina</h4>
        <div class="big">${fmt.int(need)}</div>
        <div class="sub">${ok ? `запас ${fmt.int(have - need)}` : `не хватает ${fmt.int(need - have)} на полный спурт`}</div>
      </div>
      <div class="stat-tile">
        <h4>Спурт покрыт</h4>
        <div class="big">${coverage}%</div>
        <div class="sub">${fmt.int(sim.spurtDistance)}m из ${fmt.int(course.distance / 3)}m финального отрезка</div>
        <div class="bar" style="margin-top:8px"><i style="width:${coverage}%"></i></div>
      </div>
      <div class="stat-tile">
        <h4>Запас выносливости</h4>
        <div class="big">${fmt.int(sim.maxHp)}</div>
        <div class="sub">${fmt.int(sim.hpBeforeFinal)} тратится до финального отрезка</div>
      </div>
      <div class="stat-tile">
        <h4>Оценка времени</h4>
        <div class="big">${formatTime(sim.time)}</div>
        <div class="sub">спурт ${sim.speeds.spurt.toFixed(2)} m/s · крейсер ${sim.speeds.v1.toFixed(2)} m/s</div>
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
      const marginal = s?.bashin == null ? '—' : `${s.bashin >= 0 ? '+' : '−'}${Math.abs(s.bashin).toFixed(2)} корп.`;
      const note = k === 'stamina' ? 'решено из курса, стиля и грунта'
        : s?.viaSkills ? 'поднимает шанс срабатывания скиллов с проверкой Wit'
          : s?.modelled ? 'измерено на модели HP/скорости' : 'влияет на ускорение и смену дорожек — здесь не моделируется';
      return `<tr>
        <td style="font-weight:500">${STAT_RU[k]}${k === best ? ' <span class="chip chip--accent">сюда следующие очки</span>' : ''}</td>
        <td class="num">${esc(range)}</td>
        <td class="num">${esc(marginal)}</td>
        <td class="small muted">${esc(note)}</td>
      </tr>`;
    }).join('');

    return el(`<section class="panel" data-section="stats">
      <div class="panel__head"><h3>Цели по статам и куда пойдут следующие 100 очков</h3></div>
      <div class="panel__body" style="gap:8px">
        <table>
          <thead><tr><th>Стат</th><th class="num">Цель</th><th class="num">+100 стоят</th><th>Откуда это</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <details class="explain">
          <summary>Как это посчитано</summary>
          <p>Stamina решается из модели HP так, чтобы хватило на последний спурт целиком. Колонка «+100 стоят» — конечная разность по модели: забег прогоняется заново со 100 очками сверху, а сэкономленное время переводится в корпуса на финише. Так видно, какого стата сейчас реально не хватает.</p>
          <p>Целевые диапазоны масштабируются вместе с выставленным потолком статов.</p>
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
        <summary>Модель поля и порядка · ${ctx.fieldSize} участниц, ${esc(STRATEGY[ctx.strategy].name)}</summary>
        <p>В Champions Meeting бегут ${CM_FIELD_SIZE} умамусуме, поэтому <code>order_rate</code> меняется шагами по
        ${(100 / ctx.fieldSize).toFixed(1)}%. Именно это решает, достижим ли вообще скилл с условием «в топ-30% поля».</p>
        <table>
          <thead><tr><th>Место</th><th class="num">order_rate</th><th class="num">Шанс</th><th></th></tr></thead>
          <tbody>
            ${rows.map(([o, w]) => `<tr>
              <td>${o}</td>
              <td class="num">${orderRate(o, ctx.fieldSize).toFixed(1)}%</td>
              <td class="num">${(w * 100).toFixed(0)}%</td>
              <td style="width:40%"><div class="bar"><i style="width:${((w / maxW) * 100).toFixed(0)}%"></i></div></td>
            </tr>`).join('')}
          </tbody>
        </table>
        <p>Wit ${ctx.stats.wit} → скиллы с проверкой Wit срабатывают в <b>${(wit * 100).toFixed(1)}%</b> случаев
        (<code>100 − 9000 / Wit</code>, но не ниже 20%).</p>
      </details>
    </section>`);
  }

  function scoringExplainer() {
    return `<details class="explain">
      <summary>Как ранжируются «лучшие скиллы»</summary>
      <p>Каждый скилл оценивается как <b>ожидаемые корпуса именно на этом курсе</b>, а не по тир-листу. По порядку:</p>
      <ol>
        <li><b>Может ли он сработать вообще?</b> Стиль бега, дистанционная категория, покрытие, направление круга, ипподром, грунт и требуемый рельеф — жёсткие условия: не прошло хоть одно, и скилл выбрасывается, а не штрафуется.</li>
        <li><b>Где он сработает?</b> Окно срабатывания пересекается с реальным курсом: фаза забега, повороты, прямые, уклоны и любые границы <code>distance_rate</code> / <code>remain_distance</code>. Отсюда берётся метр, с которого он начинается.</li>
        <li><b>Сколько времени ему достанется?</b> Длительность масштабируется от дистанции, а затем обрезается тем, сколько осталось до финиша: шестисекундный скилл на скорость, сработавший за 100m до линии, получит только то, что влезло.</li>
        <li><b>Сколько это в метрах?</b> Скорость даёт m/s × секунды. Ускорение откалибровано так, что +0.2 m/s² за 3s ≈ +0.35 m/s за 3s. Восстановление переводится через модель HP в лишние секунды спурта и зависит от того, насколько туго с выносливостью на самом деле.</li>
        <li><b>Как часто это случится?</b> Умножается на P(позиции) из распределения порядка для ${cm.fieldSize} участниц, на P(проверки Wit) и на штраф за условия вроде «зажали» или «обгоняешь».</li>
        <li><b>Когда это случится?</b> Вес 0.55 / 0.78 / 1.25 / 1.45 для старта, середины, финального отрезка и последних 10%.</li>
      </ol>
      <p>Открой любой скилл, чтобы увидеть все эти числа для него отдельно и где его взять.</p>
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
            <button type="button" data-v="1" aria-pressed="${cm.obtainableOnly !== false}">Доступные</button>
            <button type="button" data-v="0" aria-pressed="${cm.obtainableOnly === false}">Все</button>
          </div>`}
          <span class="sk-count">${rows.length} из ${total}</span>
        </div>
      </div>
      <div class="panel__body" style="padding:0">
        <div class="rank-list">${rows.map((r, i) => rankRow(r, i, max)).join('')}</div>
      </div>
    </section>`);
    if (hidden !== null) {
      node.insertAdjacentHTML('beforeend', `<div class="panel__foot">
        ${hidden ? `<p class="tiny muted">Ещё ${hidden} скиллов набирают очки здесь, но их не даёт ни одна ума и ни одна карта на Global — награды сценариев и подобное. Переключись на <b>Все</b>, чтобы увидеть их.</p>` : ''}
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
        <span class="tiny muted num">${fmt.pct(r.probability)} × ${(r.metres / BASHIN).toFixed(2)} корп.</span>
      </span>
      <span class="rank-row__score">${r.bashin.toFixed(2)}</span>
    </div>`;
  }

  function uniqueCard(rows, total) {
    if (!rows.length) return el('<span hidden></span>');
    const course = currentCourse();
    const aptKey = ['', 'sprint', 'mile', 'medium', 'long'][course.distanceType];
    const surfKey = course.surface === 1 ? 'turf' : 'dirt';

    return el(`<section class="panel" data-section="uniques">
      <div class="panel__head"><h3>Уники, которые заходят на этом курсе</h3><span class="sk-count">${rows.length} из ${total}</span></div>
      <div class="panel__body" style="padding:0">
        <div class="rank-list">
          ${rows.map((r, i) => {
    const owners = r.skill.sources.unique.map((id) => db.outfitById.get(id)).filter(Boolean);
    const owner = owners[0];
    const apt = owner ? owner.aptitudeGrades[aptKey] : null;
    const surf = owner ? owner.aptitudeGrades[surfKey] : null;
    const styleOk = owner ? (owner.strategy === r.skill.facets.strategies?.[0] || !r.skill.facets.strategies || r.skill.facets.strategies.length === 4) : true;
    return `<div class="rank-row" style="grid-template-columns:26px 38px minmax(0,1fr) 104px 64px">
              <span class="rank-row__i">${i + 1}</span>
              ${owner ? `<img src="./img/chara/${esc(owner.id)}.webp" alt="" width="34" height="34" loading="lazy" style="border-radius:7px;background:var(--sunken)">` : '<span></span>'}
              <span style="min-width:0">
                ${skillPill(r.skill)}
                <span class="rank-row__why">${esc(owner ? `${owner.charaName} (${owner.epithet}) · ${owner.strategyName}` : 'нет умы на Global с этим уником')}${esc(r.reasons.length ? ` · ${r.reasons[0]}` : '')}</span>
              </span>
              <span class="rank-row__mid row" style="gap:4px">
                ${apt ? `<span class="chip">${esc(course.distanceTypeName)} ${esc(apt)}</span>` : ''}
                ${surf ? `<span class="chip chip--${surfKey}">${esc(surf)}</span>` : ''}
                ${styleOk ? '' : '<span class="chip chip--warn">стиль</span>'}
              </span>
              <span class="rank-row__score">${r.bashin.toFixed(2)}</span>
            </div>`;
  }).join('')}
        </div>
      </div>
      <div class="panel__foot">
        <p class="tiny muted">Перечислены только уники, способные сработать со стилем ${esc(STRATEGY[cm.strategy].name)} на этом курсе, и оценены они так же, как всё остальное. Чипы показывают аптитюд этой умы к дистанции и покрытию — сразу видно, нужен ли ей предмет, чтобы бежать здесь.</p>
      </div>
    </section>`);
  }

  function cardSourcesCard(top) {
    const wanted = new Map(top.map((r) => [r.skill.id, r]));
    const scored = [];
    for (const card of db.supports) {
      if (!card.global) continue;
      // cardSkills убирает дубли: у 72 карт один и тот же скилл лежит и в
      // ивенте, и в хинтах, и раньше он считался дважды.
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
      <div class="panel__head"><h3>Карты поддержки с этими скиллами</h3><span class="sk-count">топ ${rows.length}</span></div>
      <div class="panel__body" style="padding:0">
        <div class="rank-list">
          ${rows.map(({ card, events, hints, value }) => `
            <div class="rank-row" style="grid-template-columns:44px minmax(0,1fr) 92px 64px">
              <img src="./img/support/${esc(card.id)}.webp" alt="" width="40" height="40" loading="lazy" style="border-radius:6px;object-fit:cover;background:var(--sunken)">
              <span style="min-width:0">
                <div style="font-weight:500">${esc(card.name)}</div>
                <div class="chips" style="margin-top:4px">
                  ${events.map((id) => skillPill(db.skillById.get(id), { tag: 'ивент' })).join('')}
                  ${hints.map((id) => skillPill(db.skillById.get(id), { tag: 'хинт' })).join('')}
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
        <p class="tiny muted">Ценность карты = сумма ожидаемых корпусов с топовых скиллов, которым она учит. Ивент-скиллы считаются полностью, потому что они гарантированы; хинты — на 60%, потому что их ещё надо выбить и купить.</p>
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
