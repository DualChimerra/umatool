// Заявка на Champions Meeting: три умы, у каждой своя дека из шести карт,
// спланированные под один курс.
//
// Каждая панель показывает свою арифметику — по карте, по скиллу, по уме и по
// команде целиком, — чтобы итог можно было проверить, а не принимать на веру.

import { db, skillIconUrl, isObtainable } from '../store.mjs';
import { el, esc, on, skillPill, fmt, debounce, turnLabel } from '../ui.mjs';
import {
  cm, commitContext, currentCourse, scoringContext, togglePriority, togglePriorityRank,
  priorityAnyRank, priorityLadder, priorityGroupMate, prioritySatisfiers, DEFAULT_STATS, canPlace,
  borrowedIn, borrowedIndex, saveBuild, loadBuild, deleteBuild, clearRoster, BORROWED_ALLOWANCE,
} from '../context.mjs';
import { simulateRace, rankSkills, STRATEGY } from '../model.mjs';
import { analyseSlot, rankCards, rankUmas, recommendations, sourceNames, HINT_CONFIDENCE } from '../analysis.mjs';

const STATS = [['speed', 'Spd'], ['stamina', 'Sta'], ['power', 'Pwr'], ['guts', 'Gut'], ['wit', 'Wit']];
const SEV_LABEL = { blocker: 'Чинить', warn: 'Проверить', tip: 'Совет' };
const KIND_LABEL = { unique: 'уник', own: 'своё', event: 'ивент', hint: 'хинт' };
const CARD_TYPES = [['speed', 'Speed'], ['stamina', 'Stamina'], ['power', 'Power'], ['guts', 'Guts'], ['wit', 'Wit'], ['friend', 'Friend'], ['group', 'Group']];

export function renderTeam(root) {
  const layout = el(`<div class="layout">
    <aside class="rail"></aside>
    <section class="stack">
      <div class="page-head">
        <div>
          <h1>Команда</h1>
          <p>Три умы, у каждой своя дека, под курс, выбранный в Планировщике.</p>
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

  /* ------------------------------------------------- рельса: приоритеты */

  const priorityPanel = el(`<section class="panel">
    <div class="panel__head">
      <h3>Приоритетные скиллы</h3>
      <button class="btn btn--ghost btn--sm" data-act="clear" type="button">Очистить</button>
    </div>
    <div class="panel__body">
      <div class="field" style="position:relative">
        <input class="input" type="search" data-role="q" placeholder="Добавить скилл…" autocomplete="off">
        <div class="panel" data-role="results" style="position:fixed;z-index:60;max-height:280px;overflow:auto;box-shadow:var(--shadow-md)" hidden></div>
      </div>
      <button class="btn btn--sm" data-act="auto" type="button">Взять топ-12 для этого курса</button>
      <div data-role="list" class="stack" style="gap:6px"></div>
      <details class="explain">
        <summary>Как это считается</summary>
        <p>Это список скиллов, с которыми команда обязана выйти. По нему меряются покрытие, пробелы, ценность деки и рейтинг карт.</p>
        <p>На одну группу скиллов — одна запись. Ранг повыше засчитывается всегда: если просила ○, а вышло ◎, это не промах. Ранг пониже — только если отметить это галочкой. Ранг × не засчитывается никогда: это та же группа, но обратный эффект.</p>
      </details>
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
    results.innerHTML = list.map((s) => {
      // Одна запись на группу, поэтому выбор другого ранга не добавит вторую
      // строку, а заменит прежнюю — лучше сказать об этом до клика.
      const mate = db.skillById.get(priorityGroupMate(s.id));
      return `<button type="button" class="src-row" data-add="${esc(s.id)}" style="width:100%;border:0;background:transparent;cursor:pointer">
        <img src="${skillIconUrl(s)}" alt="" width="26" height="26">
        <span style="min-width:0"><b>${esc(s.name)}</b><span class="src-row__sub">${mate ? `заменит ${esc(mate.name)}` : esc(s.variants[0]?.text ?? '')}</span></span>
        <span class="chip chip--${s.tier === 'normal' ? '' : s.tier}">${esc(s.tierName)}</span>
      </button>`;
    }).join('');
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
    const sim = simulateRace({ course: currentCourse(), strategy: ctx.strategy, stats: ctx.stats, ground: ctx.ground, recoveryPct: cm.recovery });
    // Больше, чем нужно: из выдачи ещё вылетят дубли по группам, а взять надо 12.
    const top = rankSkills(db.learnable.filter(isObtainable), { ...ctx, sim }, { tiers: ['gold', 'normal'], limit: 60 });
    const groups = new Set(cm.priority.map((id) => db.skillById.get(id)?.groupId).filter(Boolean));
    let added = 0;
    for (const r of top) {
      if (added >= 12) break;
      const g = r.skill.groupId;
      if (cm.priority.includes(r.skill.id) || (g && groups.has(g))) continue;
      if (g) groups.add(g);
      togglePriority(r.skill.id);
      added += 1;
    }
    paint();
  });

  function paintPriority() {
    const list = priorityPanel.querySelector('[data-role="list"]');
    if (!cm.priority.length) {
      list.innerHTML = '<p class="tiny muted">Пока пусто — добавь скиллы вручную или возьми их из рейтинга курса и правь оттуда.</p>';
      return;
    }
    list.innerHTML = cm.priority.map((id) => {
      const { skill, better, worse, penalties } = priorityLadder(id);
      return `<div class="pri-row">
        <div class="row" style="justify-content:space-between;gap:6px;flex-wrap:nowrap">
          ${skillPill(skill)}
          <button class="btn btn--ghost btn--sm" data-drop="${esc(id)}" type="button" aria-label="Убрать">✕</button>
        </div>
        ${better.length ? `<p class="tiny muted" style="margin-top:4px">Засчитывается также: ${esc(better.map((x) => x.name).join(', '))}</p>` : ''}
        ${worse.length ? `<label class="check tiny" style="margin-top:4px">
          <input type="checkbox" data-rank="${esc(id)}" ${priorityAnyRank(id) ? 'checked' : ''}>
          <span>Засчитывать и младший ранг: ${esc(worse.map((x) => x.name).join(', '))}</span>
        </label>` : ''}
        ${penalties.length ? `<p class="tiny muted pri-row__never">Никогда не засчитывается: ${esc(penalties.map((x) => x.name).join(', '))}</p>` : ''}
      </div>`;
    }).join('');
  }

  /* ------------------------------------------------------ рельса: коллекция */

  const collectionPanel = el(`<section class="panel">
    <div class="panel__head"><h3>Коллекция</h3><a class="btn btn--ghost btn--sm" href="#/collection">Отметить</a></div>
    <div class="panel__body">
      <label class="check">
        <input type="checkbox" data-role="useowned" ${cm.useOwned ? 'checked' : ''}>
        <span>Считать только мою коллекцию
          <small data-role="ownsum"></small>
        </span>
      </label>
      <details class="explain">
        <summary>Как работает карта друга</summary>
        <p>Champions Meeting позволяет взять в деку одну карту вне своей коллекции — карту поддержки друга. Поэтому при включённом ограничении дека собирается так: пять карт из твоих, плюс одна любая чужая.</p>
        <p>Карта друга не привязана к шестому слоту: она может стоять на любом месте деки, важно лишь, что она одна. Чужие карты всегда видны в выборе и помечены значком «друг»; когда место друга уже занято, остальные чужие остаются в списке, но становятся недоступными — так видно, чем именно ты пожертвовала.</p>
      </details>
    </div>
  </section>`);

  collectionPanel.querySelector('[data-role="useowned"]').addEventListener('change', (e) => {
    cm.useOwned = e.target.checked;
    commitContext();
    paint();
  });

  function paintCollection() {
    collectionPanel.querySelector('[data-role="ownsum"]').textContent = cm.useOwned
      ? `Отмечено: ${cm.owned.cards.length} карт, ${cm.owned.umas.length} ум. Плюс одна карта друга на деку.`
      : 'Сейчас выбор не ограничен — предлагаются все карты и умы на Global.';
  }

  /* ---------------------------------------------------- рельса: сохранения */

  const buildsPanel = el(`<section class="panel">
    <div class="panel__head"><h3>Сохранённые сборки</h3></div>
    <div class="panel__body">
      <div class="row" style="gap:6px;flex-wrap:nowrap">
        <input class="input" data-role="bname" type="text" placeholder="Название сборки…">
        <button class="btn btn--primary btn--sm" data-act="save" type="button">Сохранить</button>
      </div>
      <div data-role="builds" class="stack" style="gap:4px"></div>
      <button class="btn btn--ghost btn--sm" data-act="clear-roster" type="button">Очистить все три слота</button>
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
      list.innerHTML = '<p class="tiny muted">Три слота ниже сохраняются между заходами сами. Сохраняй сборку, если нужно держать несколько и переключаться.</p>';
      return;
    }
    list.innerHTML = cm.builds.map((b) => {
      const names = (b.roster ?? []).map((s) => db.outfitById.get(s.outfitId)?.charaName).filter(Boolean);
      return `<div class="src-row" style="grid-template-columns:minmax(0,1fr) auto auto;cursor:pointer" data-load="${esc(b.id)}">
        <span style="min-width:0">
          <b>${esc(b.name)}</b>
          <span class="src-row__sub">${esc(names.join(' · ') || 'пусто')} · ${esc(new Date(b.savedAt).toLocaleDateString('ru-RU'))}</span>
        </span>
        <span class="chip">${b.priority?.length ?? 0} пр.</span>
        <button class="btn btn--ghost btn--sm" data-del="${esc(b.id)}" type="button" aria-label="Удалить">✕</button>
      </div>`;
    }).join('');
  }

  rail.append(priorityPanel, collectionPanel, buildsPanel);

  /* ----------------------------------------------------------------- выбор */

  // Рендер страницы может повториться при возврате на вкладку, а панель живёт в
  // body: старую надо снять, иначе накапливаются невидимые копии со своими
  // обработчиками.
  document.getElementById('team-picker')?.remove();
  const picker = el(`<div class="drawer" id="team-picker" hidden>
    <div class="drawer__scrim" data-act="close-picker"></div>
    <aside class="drawer__panel drawer__panel--wide" role="dialog" aria-modal="true">
      <header class="drawer__head">
        <div style="flex:1;min-width:0">
          <h2 data-role="title">Выбор</h2>
          <p class="tiny muted" data-role="subtitle"></p>
        </div>
        <button class="icon-btn" data-act="close-picker" type="button" aria-label="Закрыть">✕</button>
      </header>
      <div class="drawer__body" style="gap:10px">
        <input class="input" type="search" data-role="pq" placeholder="Поиск…" autocomplete="off">
        <div data-role="pown"></div>
        <div class="toggle-grid" data-role="pfilter"></div>
        <div data-role="pnote"></div>
        <div data-role="pgrid" class="stack" style="gap:6px"></div>
      </div>
    </aside>
  </div>`);
  document.body.append(picker);
  on(picker, 'click', '[data-act="close-picker"]', () => { picker.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !picker.hidden) picker.hidden = true; });

  let pickerState = null;

  function openCardPicker(slotIndex, deckIndex) {
    pickerState = {
      kind: 'card', slotIndex, deckIndex, query: '', type: null,
      own: 'all',
    };
    picker.querySelector('[data-role="pfilter"]').innerHTML = CARD_TYPES
      .map(([v, l]) => `<button type="button" data-ptype="${v}" aria-pressed="false">${esc(l)}</button>`).join('');
    picker.querySelector('[data-role="pq"]').value = '';
    paintPicker();
    picker.hidden = false;
    picker.querySelector('[data-role="pq"]').focus();
  }

  function openUmaPicker(slotIndex) {
    pickerState = { kind: 'uma', slotIndex, query: '', type: null, own: 'all' };
    picker.querySelector('[data-role="pfilter"]').innerHTML = Object.entries(STRATEGY)
      .map(([v, s]) => `<button type="button" data-ptype="${v}" aria-pressed="false">${esc(s.name)}</button>`).join('');
    picker.querySelector('[data-role="pq"]').value = '';
    paintPicker();
    picker.hidden = false;
    picker.querySelector('[data-role="pq"]').focus();
  }

  function ownSegment(options) {
    return `<div class="seg" data-role="pown-seg">${options
      .map(([v, l]) => `<button type="button" data-pown="${v}" aria-pressed="${pickerState.own === v}">${esc(l)}</button>`)
      .join('')}</div>`;
  }

  function paintPicker() {
    const grid = picker.querySelector('[data-role="pgrid"]');
    const title = picker.querySelector('[data-role="title"]');
    const subtitle = picker.querySelector('[data-role="subtitle"]');
    const ownEl = picker.querySelector('[data-role="pown"]');
    const noteEl = picker.querySelector('[data-role="pnote"]');
    const slot = cm.roster[pickerState.slotIndex];

    if (pickerState.kind === 'card') {
      const analysis = analyseSlot(slot);
      const spent = borrowedIn(slot, pickerState.deckIndex).length >= BORROWED_ALLOWANCE;
      title.textContent = `Карта поддержки · ума ${pickerState.slotIndex + 1}, слот ${pickerState.deckIndex + 1}`;
      subtitle.textContent = 'Отсортировано по тому, сколько карта добавит именно этой деке: сначала приоритетные скиллы, потом корпуса.';

      ownEl.innerHTML = cm.useOwned
        ? ownSegment([['all', 'Все'], ['mine', 'Мои'], ['friend', 'Карты друга']])
        : '';
      noteEl.innerHTML = cm.useOwned
        ? `<p class="note">${spent
          ? 'Место карты друга в этой деке уже занято. Чужие карты остаются в списке, но поставить их нельзя — сначала убери ту, что взята у друга.'
          : 'Место карты друга свободно: одну карту вне коллекции сюда поставить можно. Такие карты помечены значком «друг».'}</p>`
        : '<p class="note">Ограничение по коллекции выключено — предлагаются все карты на Global. Включи его в панели «Коллекция», чтобы считать пять своих карт плюс одну карту друга.</p>';

      const rows = rankCards(analysis, pickerState.deckIndex, {
        query: pickerState.query, type: pickerState.type, own: pickerState.own,
      }).slice(0, 60);
      grid.innerHTML = rows.map(cardRow).join('') || '<p class="muted small">Ничего не подходит.</p>';
    } else {
      title.textContent = `Умамусуме · слот ${pickerState.slotIndex + 1}`;
      subtitle.textContent = 'Отсортировано по тому, сколько стоят на этом курсе её уник и собственный список скиллов, со скидкой за нехватку аптитюда.';
      ownEl.innerHTML = cm.useOwned ? ownSegment([['all', 'Все'], ['mine', 'Мои']]) : '';
      noteEl.innerHTML = '';
      const rows = rankUmas({
        query: pickerState.query,
        strategy: pickerState.type ? Number(pickerState.type) : null,
        own: pickerState.own,
      }).slice(0, 60);
      grid.innerHTML = rows.map(umaRow).join('')
        || '<p class="muted small">Ничего не подходит. Отметь ум на странице «Коллекция» или сними ограничение.</p>';
    }
  }

  /** Закрывает ли этот скилл одну из приоритетных записей? */
  function priorityHit(skillId) {
    if (!skillId) return false;
    return cm.priority.some((pid) => prioritySatisfiersCache(pid).has(skillId));
  }

  // prioritySatisfiers ходит по группе на каждый вызов, а вызывается он на
  // каждую пилюлю в списке из 60 карт.
  const satisfierCache = new Map();
  function prioritySatisfiersCache(pid) {
    if (!satisfierCache.has(pid)) satisfierCache.set(pid, prioritySatisfiers(pid));
    return satisfierCache.get(pid);
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
          ${r.owned || !cm.useOwned ? '' : '<span class="chip chip--friend">друг</span>'}
          ${r.inDeck ? '<span class="chip chip--accent">уже в этой деке</span>' : ''}
        </div>
        <div class="chips" style="margin-top:5px">
          ${skills.map((s) => skillPill(s.skill, {
    tag: KIND_LABEL[s.kind], match: priorityHit(s.skill.id), dim: s.held || !s.scored,
  })).join('')}
          ${r.skills.length > skills.length ? `<span class="chip">+${r.skills.length - skills.length}</span>` : ''}
        </div>
      </div>
      <div class="pick-row__side">
        <div class="pick-row__value">${r.gain.toFixed(2)}</div>
        <div class="tiny muted">корпусов сверх</div>
        ${r.newPriority.length ? `<div class="chip chip--accent" style="margin-top:4px">+${r.newPriority.length} приоритет</div>` : ''}
        ${r.blocked
    ? '<span class="tiny muted" style="margin-top:6px;display:block">место друга занято</span>'
    : `<button class="btn btn--primary btn--sm" type="button" data-pick="${esc(r.card.id)}" style="margin-top:6px;width:100%;justify-content:center">${r.inDeck ? 'Перенести' : 'Поставить'}</button>`}
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
          ${r.owned ? '' : '<span class="chip chip--friend">не в коллекции</span>'}
        </div>
        <div class="tiny muted">${esc(o.epithet)}</div>
        <div class="chips" style="margin-top:5px">
          ${r.skills.slice(0, 6).map((s) => skillPill(s.skill, { match: priorityHit(s.skill?.id), dim: !s.scored })).join('')}
        </div>
      </div>
      <div class="pick-row__side">
        <div class="pick-row__value">${r.value.toFixed(2)}</div>
        <div class="tiny muted">свой набор, корпусов</div>
        <div class="tiny muted" style="margin-top:3px">уник ${r.unique.toFixed(2)}</div>
        <button class="btn btn--primary btn--sm" type="button" data-pick="${esc(o.id)}" style="margin-top:6px;width:100%;justify-content:center">Выбрать</button>
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
  on(picker, 'click', '[data-pown]', (e, t) => { pickerState.own = t.dataset.pown; paintPicker(); });
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

  /* ---------------------------------------------------------------- отрисовка */

  function paint() {
    satisfierCache.clear();
    const course = currentCourse();
    raceEl.innerHTML = `<a class="chip chip--accent" href="#/planner">${esc(course.trackName)} ${course.distance}m ${esc(course.surfaceName)} · ${esc(turnLabel(course.turnName))} · ${cm.fieldSize} участниц</a>`;
    paintPriority();
    paintCollection();
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
        <h4>Заявка</h4>
        <div class="big">${filled.length}<span style="font-size:15px;font-weight:500"> / 3</span></div>
        <div class="sub">стилей бега: ${styles.size}${styles.size < 2 && filled.length > 1 ? ' — все одинаковые' : ''}</div>
      </div>
      <div class="stat-tile ${cm.priority.length && pct === 1 ? 'stat-tile--ok' : cm.priority.length && pct < 0.5 ? 'stat-tile--bad' : ''}">
        <h4>Приоритеты закрыты</h4>
        <div class="big">${cm.priority.length ? `${teamCovered.length}/${cm.priority.length}` : '—'}</div>
        <div class="sub">${cm.priority.length ? `${Math.round(pct * 100)}% достижимо хоть кем-то в команде` : 'добавь приоритетные скиллы, чтобы это померить'}</div>
        ${cm.priority.length ? `<div class="bar" style="margin-top:8px"><i style="width:${(pct * 100).toFixed(0)}%"></i></div>` : ''}
      </div>
      <div class="stat-tile">
        <h4>Ценность скиллов команды</h4>
        <div class="big">${total.toFixed(1)}<span style="font-size:15px;font-weight:500"> корп.</span></div>
        <div class="sub">ожидаемые корпуса со всех достижимых скиллов, хинты с весом ${Math.round(HINT_CONFIDENCE * 100)}%</div>
      </div>
      <div class="stat-tile">
        <h4>Карты больше чем в одной деке</h4>
        <div class="big">${shared.length}</div>
        <div class="sub">${shared.length ? esc(shared.slice(0, 3).map(([id, n]) => `${db.supportById.get(id)?.name ?? id} ×${n}`).join(', ')) : 'деки не пересекаются'}</div>
      </div>
    </div>`);
  }

  function adviceCard(items) {
    if (!items.length) {
      return el('<section class="panel"><div class="panel__body"><p class="small muted">Замечаний нет — заявка выглядит связной для этого курса.</p></div></section>');
    }
    return el(`<section class="panel">
      <div class="panel__head"><h3>Что поправить дальше</h3><span class="sk-count">${items.length}</span></div>
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

  function deckBlock(a, index) {
    const slot = cm.roster[index];
    const friendAt = cm.useOwned ? borrowedIndex(slot) : -1;

    const cells = slot.deck.map((id, i) => {
      const card = id ? db.supportById.get(id) : null;
      if (!card) {
        return `<button class="deck__slot" type="button" data-deck="${index}:${i}" aria-label="Добавить карту поддержки">+</button>`;
      }
      return `<button class="deck__slot deck__slot--filled${i === friendAt ? ' deck__slot--friend' : ''}" type="button" data-deck="${index}:${i}" title="${esc(card.name)}">
        <img src="./img/support/${esc(card.id)}.webp" alt="${esc(card.name)}" loading="lazy">
        <span class="deck__type">${esc(card.typeName)}</span>
        ${i === friendAt ? '<span class="deck__borrow">друг</span>' : ''}
        <span class="deck__x" data-clear="${index}:${i}" role="button" aria-label="Убрать">✕</span>
      </button>`;
    }).join('');

    const typeCount = {};
    for (const c of a.cards) if (c) typeCount[c.typeName] = (typeCount[c.typeName] ?? 0) + 1;
    const filled = a.cards.filter(Boolean).length;

    return `<div>
      <h4 class="drawer__h3">Дека</h4>
      <div class="deck">${cells}</div>
      <p class="tiny muted" style="margin-top:6px">
        ${filled}/6 карт${Object.keys(typeCount).length ? ` · ${esc(Object.entries(typeCount).map(([t, n]) => `${n} ${t}`).join(', '))}` : ''}
      </p>
      ${cm.useOwned ? `<p class="deck__rule">
        Карта друга: ${friendAt >= 0
    ? `<b>${esc(db.supportById.get(slot.deck[friendAt])?.name ?? '')}</b> в слоте ${friendAt + 1}`
    : '<b>свободна</b> — можно поставить одну карту вне коллекции'}
      </p>` : ''}
    </div>`;
  }

  function slotCard(a, index) {
    const o = a.outfit;
    const course = currentCourse();
    const staminaOk = !o || a.ctx.stats.stamina >= a.sim.requiredStamina;
    const eventCount = a.pool.filter((p) => p.kind === 'event').length;
    const hintCount = a.pool.filter((p) => p.kind === 'hint').length;
    const goldCount = a.pool.filter((p) => p.skill.tier === 'gold').length;

    return el(`<article class="panel">
      <div class="panel__head">
        <h3>Ума ${index + 1}</h3>
        <div class="row">
          ${o ? `<span class="chip">${a.total.toFixed(2)} корп.</span><button class="btn btn--ghost btn--sm" data-uma="${index}" type="button">Заменить</button>` : ''}
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
                <span class="chip ${a.aptitudes.styleVal >= 7 ? '' : 'chip--warn'}">Стиль ${esc(a.aptitudes.style)}</span>
              </div>
            </div>
          </div>
          <div class="field">
            <label>Бежит как</label>
            <div class="toggle-grid" data-role="slot-style" data-slot="${index}">
              ${Object.entries(STRATEGY).map(([v, s]) => `<button type="button" data-v="${v}" aria-pressed="${Number(v) === a.ctx.strategy}">${esc(s.short)}</button>`).join('')}
            </div>
          </div>`
    : `<button class="btn btn--primary" data-uma="${index}" type="button" style="justify-content:center">Выбрать умамусуме</button>`}

        ${deckBlock(a, index)}

        ${o ? `
          <div>
            <h4 class="drawer__h3">Статы</h4>
            <div class="row" style="gap:5px">
              ${STATS.map(([k, label]) => `
                <label class="field" style="flex:1;min-width:0;gap:2px">
                  <span class="tiny muted">${label}</span>
                  <input class="input num" type="number" min="100" max="${cm.statCap}" step="10" value="${a.ctx.stats[k]}" data-slotstat="${index}:${k}" style="padding:4px 5px;text-align:right">
                </label>`).join('')}
            </div>
            <table class="calc" style="margin-top:8px">
              <tbody>
                <tr><td>Нужно Stamina</td><td class="num"${staminaOk ? '' : ' style="color:var(--danger);font-weight:600"'}>${fmt.int(a.sim.requiredStamina)}</td>
                    <td class="small muted">${staminaOk ? `запас ${fmt.int(a.ctx.stats.stamina - a.sim.requiredStamina)}` : `не хватает ${fmt.int(a.sim.requiredStamina - a.ctx.stats.stamina)}`}</td></tr>
                <tr><td>Спурт покрыт</td><td class="num">${Math.round(a.sim.spurtCoverage * 100)}%</td>
                    <td class="small muted">${fmt.int(a.sim.spurtDistance)}m из ${fmt.int(course.distance / 3)}m</td></tr>
                <tr><td>Ускорение</td><td class="num">${a.sim.accel.opening.toFixed(3)} m/s²</td>
                    <td class="small muted">${a.sim.accel.total.toFixed(2)}s теряется на разгонах</td></tr>
                <tr><td>Оценка времени</td><td class="num">${a.sim.time.toFixed(1)}s</td>
                    <td class="small muted">спурт ${a.sim.speeds.spurt.toFixed(2)} m/s</td></tr>
              </tbody>
            </table>
          </div>` : ''}

        ${cm.priority.length ? `
          <div>
            <h4 class="drawer__h3">Покрытие приоритетов <span class="sk-count">${a.covered}/${cm.priority.length}</span></h4>
            ${a.coverage.map(coverRow).join('')}
          </div>` : ''}

        <details class="reach">
          <summary>
            <span>Достижимые скиллы</span>
            <span class="sk-count">${a.usable.length} шт · ${a.total.toFixed(2)} корп.</span>
          </summary>
          <table class="calc" style="margin-top:8px">
            <tbody>
              <tr><td>Гарантированно с ивентов</td><td class="num">${eventCount}</td><td class="small muted">считаются на 100%</td></tr>
              <tr><td>С хинтов</td><td class="num">${hintCount}</td><td class="small muted">считаются на ${Math.round(HINT_CONFIDENCE * 100)}%</td></tr>
              <tr><td>Золота в досягаемости</td><td class="num">${goldCount}</td><td class="small muted">список умы и дека вместе</td></tr>
            </tbody>
          </table>
          <div class="stack" style="gap:3px;margin-top:8px">
            ${a.usable.slice(0, 40).map((p) => `
              <div class="cover-row">
                <span style="min-width:0">
                  ${skillPill(p.skill, { match: priorityHit(p.skill.id) })}
                  <span class="cover-row__src">${esc(sourceNames(p).slice(0, 2).join(', '))}</span>
                </span>
                <span class="row" style="gap:5px;flex-wrap:nowrap">
                  <span class="tiny muted num">${p.value.toFixed(2)}</span>
                  <span class="cover-tag cover-tag--${p.kind === 'own' || p.kind === 'unique' ? 'own' : p.kind}">${KIND_LABEL[p.kind]}</span>
                </span>
              </div>`).join('') || '<p class="tiny muted">Выбери уму и карты, чтобы увидеть, с чем этот прогон может закончиться.</p>'}
          </div>
        </details>
      </div>
    </article>`);
  }

  /**
   * Одна строка покрытия. Показывает не только «закрыто/нет», но и чем именно:
   * каким рангом и с какой карты — иначе метка «хинт» на скилле, которого в деке
   * буквально нет, выглядит как ошибка.
   */
  function coverRow({ skill, hit, via, from, scored }) {
    const detail = hit
      ? [via ? `рангом ${via.name}` : null, from.length ? `с ${from.slice(0, 2).join(', ')}` : null].filter(Boolean).join(' · ')
      : '';
    return `<div class="cover-row">
      <span style="min-width:0">
        ${skillPill(skill, { dim: !hit })}
        ${detail ? `<span class="cover-row__src">${esc(detail)}</span>` : ''}
      </span>
      <span class="row" style="gap:5px;flex-wrap:nowrap">
        ${scored ? `<span class="tiny muted num">${scored.bashin.toFixed(2)}</span>` : '<span class="tiny muted">н/д</span>'}
        <span class="cover-tag cover-tag--${hit ? (hit.info.kind === 'own' || hit.info.kind === 'unique' ? 'own' : hit.info.kind) : 'miss'}">${hit ? KIND_LABEL[hit.info.kind] : 'нет'}</span>
      </span>
    </div>`;
  }

  /* --------------------------------------------------------------- события */

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
