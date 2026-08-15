// Разбор строк с условиями, которые приходят вместе с данными скиллов.
//
//   "phase>=2&order_rate<=50@is_finalcorner==1"
//
// `@` разделяет альтернативы (ИЛИ), `&` — требования (И).
// Парсер выдаёт две вещи: читаемую фразу по-русски и набор фасетов, по которым
// интерфейс фильтрует и сортирует.
//
// Названия из игры (Turf, Sprint, Pace Chaser, Firm) остаются как в клиенте —
// это термины, которые игрок видит в самой игре; переводится только связывающий
// их текст.

import {
  RUNNING_STYLE, DISTANCE_TYPE, SURFACE, GROUND_CONDITION,
  WEATHER, SEASON, ROTATION, PHASE,
} from './gamedata.mjs';

const TERM_RE = /^([a-z_0-9]+)(>=|<=|==|!=|>|<)(-?\d+)$/;

export function parseExpression(expr) {
  if (!expr) return [];
  return expr.split('@').map((alt) => alt.split('&').map((term) => {
    const m = TERM_RE.exec(term.trim());
    if (!m) return { key: term.trim(), op: '?', value: null, raw: term.trim() };
    return { key: m[1], op: m[2], value: Number(m[3]), raw: term.trim() };
  }));
}

/** Values of `domain` that satisfy `op value`. */
function resolveSet(domain, op, value) {
  const keys = Object.keys(domain).map(Number);
  switch (op) {
    case '==': return keys.filter((k) => k === value);
    case '!=': return keys.filter((k) => k !== value);
    case '>=': return keys.filter((k) => k >= value);
    case '<=': return keys.filter((k) => k <= value);
    case '>': return keys.filter((k) => k > value);
    case '<': return keys.filter((k) => k < value);
    default: return keys;
  }
}

const listOf = (arr) => {
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  return `${arr.slice(0, -1).join(', ')} или ${arr[arr.length - 1]}`;
};

const cmpWord = { '>=': 'не менее', '<=': 'не более', '>': 'больше', '<': 'меньше', '==': 'ровно', '!=': 'не' };

// Места в забеге сравниваются «выше/ниже», а не «больше/меньше»: order<=3 — это
// тройка лидеров, а не «не более трёх».
const placePhrase = (op, v, { gen, nom }) => {
  switch (op) {
    case '<=': return `не ниже ${v}-го ${gen}`;
    case '<': return `выше ${v}-го ${gen}`;
    case '>=': return `не выше ${v}-го ${gen}`;
    case '>': return `ниже ${v}-го ${gen}`;
    case '!=': return `не ${v}-е ${nom}`;
    default: return `ровно ${v}-е ${nom}`;
  }
};
const PLACE = { gen: 'места', nom: 'место' };
const FAVOURITE = { gen: 'фаворита', nom: 'место в фаворитах' };

// Названия, которые встречаются только в тексте условий.
const PHASE_RU = { 0: 'старт', 1: 'середина', 2: 'финальный отрезок', 3: 'последний спурт' };
const WEATHER_RU = { 1: 'ясно', 2: 'облачно', 3: 'дождь', 4: 'снег' };
const SEASON_RU = { 1: 'весна', 2: 'лето', 3: 'осень', 4: 'зима', 5: 'сезон сакуры' };
const ROTATION_RU = { 1: 'правый круг', 2: 'левый круг' };
const phaseRu = (v) => PHASE_RU[v] ?? `фаза ${v}`;

/**
 * Per-key handlers. `describe` returns a phrase, `apply` records facets.
 * Anything without a handler still shows up as a raw phrase so nothing is
 * silently dropped when the game adds new condition keys.
 */
const HANDLERS = {
  phase: {
    describe: (op, v) => `${listOf(resolveSet(PHASE, op, v).map(phaseRu))}`,
    apply: (op, v, f) => { f.phases = intersect(f.phases, resolveSet(PHASE, op, v)); },
  },
  phase_random: {
    describe: (op, v) => `случайная точка на отрезке «${phaseRu(v)}»`,
    apply: (op, v, f) => { f.phases = intersect(f.phases, resolveSet(PHASE, op, v)); f.random = true; },
  },
  phase_firsthalf_random: {
    describe: (op, v) => `случайная точка в первой половине отрезка «${phaseRu(v)}»`,
    apply: (op, v, f) => { f.phases = intersect(f.phases, resolveSet(PHASE, op, v)); f.random = true; },
  },
  phase_laterhalf_random: {
    describe: (op, v) => `случайная точка во второй половине отрезка «${phaseRu(v)}»`,
    apply: (op, v, f) => { f.phases = intersect(f.phases, resolveSet(PHASE, op, v)); f.random = true; },
  },
  phase_corner_random: {
    describe: (op, v) => `случайный поворот на отрезке «${phaseRu(v)}»`,
    apply: (op, v, f) => { f.phases = intersect(f.phases, resolveSet(PHASE, op, v)); f.terrain.add('corner'); f.random = true; },
  },
  distance_type: {
    describe: (op, v) => `дистанция ${listOf(resolveSet(DISTANCE_TYPE, op, v).map((d) => DISTANCE_TYPE[d].name))}`,
    apply: (op, v, f) => { f.distanceTypes = intersect(f.distanceTypes, resolveSet(DISTANCE_TYPE, op, v)); },
  },
  ground_type: {
    describe: (op, v) => `${listOf(resolveSet(SURFACE, op, v).map((d) => SURFACE[d].name))}`,
    apply: (op, v, f) => { f.surfaces = intersect(f.surfaces, resolveSet(SURFACE, op, v)); },
  },
  running_style: {
    describe: (op, v) => `стилем ${listOf(resolveSet(RUNNING_STYLE, op, v).map((d) => RUNNING_STYLE[d].name))}`,
    apply: (op, v, f) => { f.strategies = intersect(f.strategies, resolveSet(RUNNING_STYLE, op, v)); },
  },
  ground_condition: {
    describe: (op, v) => `грунт ${listOf(resolveSet(GROUND_CONDITION, op, v).map((d) => GROUND_CONDITION[d]))}`,
    apply: (op, v, f) => { f.groundConditions = intersect(f.groundConditions, resolveSet(GROUND_CONDITION, op, v)); },
  },
  weather: {
    describe: (op, v) => `погода: ${listOf(resolveSet(WEATHER, op, v).map((d) => WEATHER_RU[d] ?? WEATHER[d]))}`,
    apply: (op, v, f) => { f.weathers = intersect(f.weathers, resolveSet(WEATHER, op, v)); },
  },
  season: {
    describe: (op, v) => `${listOf(resolveSet(SEASON, op, v).map((d) => SEASON_RU[d] ?? SEASON[d]))}`,
    apply: (op, v, f) => { f.seasons = intersect(f.seasons, resolveSet(SEASON, op, v)); },
  },
  rotation: {
    describe: (op, v) => `${listOf(resolveSet(ROTATION, op, v).map((d) => ROTATION_RU[d] ?? ROTATION[d]))}`,
    apply: (op, v, f) => { f.rotations = intersect(f.rotations, resolveSet(ROTATION, op, v)); },
  },
  track_id: {
    describe: (op, v, ctx) => `на ${ctx.trackName?.(v) ?? `ипподроме ${v}`}`,
    apply: (op, v, f) => { if (op === '==') f.trackIds.add(v); },
  },
  corner: {
    describe: (op, v) => (v === 0 && op === '!=' ? 'на повороте' : v === 0 ? 'не на повороте' : `на повороте ${v}`),
    apply: (op, v, f) => { if (v === 0 && op === '!=') f.terrain.add('corner'); else if (v === 0) f.terrain.add('straight'); else f.terrain.add('corner'); },
  },
  corner_random: {
    describe: () => 'случайная точка на повороте',
    apply: (op, v, f) => { f.terrain.add('corner'); f.random = true; },
  },
  all_corner_random: {
    describe: () => 'случайная точка на каждом повороте',
    apply: (op, v, f) => { f.terrain.add('corner'); f.random = true; },
  },
  is_finalcorner: {
    describe: (op, v) => (v === 1 ? 'от последнего поворота и дальше' : 'до последнего поворота'),
    apply: (op, v, f) => { if (v === 1) { f.terrain.add('final-corner'); f.late = true; } },
  },
  is_finalcorner_random: {
    describe: () => 'случайная точка на последнем повороте',
    apply: (op, v, f) => { f.terrain.add('final-corner'); f.random = true; f.late = true; },
  },
  is_finalcorner_laterhalf: {
    describe: () => 'вторая половина последнего поворота',
    apply: (op, v, f) => { f.terrain.add('final-corner'); f.late = true; },
  },
  is_last_straight: {
    describe: () => 'на финишной прямой',
    apply: (op, v, f) => { f.terrain.add('last-straight'); f.late = true; },
  },
  is_last_straight_onetime: {
    describe: () => 'один раз на финишной прямой',
    apply: (op, v, f) => { f.terrain.add('last-straight'); f.late = true; },
  },
  last_straight_random: {
    describe: () => 'случайная точка на финишной прямой',
    apply: (op, v, f) => { f.terrain.add('last-straight'); f.random = true; f.late = true; },
  },
  straight_random: {
    describe: () => 'случайная точка на прямой',
    apply: (op, v, f) => { f.terrain.add('straight'); f.random = true; },
  },
  straight_front_type: {
    describe: (op, v) => (v === 1 ? 'на финишной прямой' : 'на противоположной прямой'),
    apply: (op, v, f) => { f.terrain.add('straight'); },
  },
  slope: {
    describe: (op, v) => (v === 1 ? 'на подъёме' : v === 2 ? 'на спуске' : 'на ровном'),
    apply: (op, v, f) => { f.terrain.add(v === 1 ? 'uphill' : v === 2 ? 'downhill' : 'flat'); },
  },
  up_slope_random: {
    describe: () => 'случайная точка на подъёме',
    apply: (op, v, f) => { f.terrain.add('uphill'); f.random = true; },
  },
  down_slope_random: {
    describe: () => 'случайная точка на спуске',
    apply: (op, v, f) => { f.terrain.add('downhill'); f.random = true; },
  },
  is_lastspurt: {
    describe: (op, v) => (v === 1 ? 'во время последнего спурта' : 'вне последнего спурта'),
    apply: (op, v, f) => { if (v === 1) { f.late = true; f.phases = intersect(f.phases, [2, 3]); } },
  },
  is_basis_distance: {
    describe: (op, v) => (v === 1 ? 'на стандартной дистанции (кратной 400m)' : 'на нестандартной дистанции'),
    apply: () => {},
  },
  remain_distance: {
    describe: (op, v) => `до финиша ${cmpWord[op]} ${v}m`,
    apply: (op, v, f) => {
      if ((op === '<=' || op === '<') && v <= 600) f.late = true;
      // "at most N metres left" is a lower bound on how far into the race we are.
      if (op === '<=' || op === '<') f.window.remainMax = Math.min(f.window.remainMax ?? Infinity, v);
      if (op === '>=' || op === '>') f.window.remainMin = Math.max(f.window.remainMin ?? 0, v);
    },
  },
  distance_rate: {
    describe: (op, v) => `пройдено ${cmpWord[op]} ${v}% дистанции`,
    apply: (op, v, f) => {
      if ((op === '>=' || op === '>') && v >= 60) f.late = true;
      if (op === '>=' || op === '>') f.window.rateMin = Math.max(f.window.rateMin ?? 0, v / 100);
      if (op === '<=' || op === '<') f.window.rateMax = Math.min(f.window.rateMax ?? 1, v / 100);
    },
  },
  distance_rate_after_random: {
    describe: (op, v) => `случайная точка после ${v}% дистанции`,
    apply: (op, v, f) => { f.random = true; f.window.rateMin = Math.max(f.window.rateMin ?? 0, v / 100); },
  },
  order: {
    describe: (op, v) => placePhrase(op, v, PLACE),
    apply: (op, v, f) => {
      if (op === '<=' || op === '<') f.position.orderMax = Math.min(f.position.orderMax ?? 99, v);
      if (op === '>=' || op === '>') f.position.orderMin = Math.max(f.position.orderMin ?? 0, v);
      if (op === '==') { f.position.orderMax = v; f.position.orderMin = v; }
    },
  },
  order_rate: {
    describe: (op, v) => `в ${op.startsWith('<') ? 'верхних' : 'нижних'} ${op.startsWith('<') ? v : 100 - v}% поля`,
    apply: (op, v, f) => {
      if (op === '<=' || op === '<') f.position.rateMax = Math.min(f.position.rateMax ?? 100, v);
      if (op === '>=' || op === '>') f.position.rateMin = Math.max(f.position.rateMin ?? 0, v);
    },
  },
  order_rate_in20_continue: { describe: (op, v) => `после ${v}s в верхних 20%`, apply: () => {} },
  order_rate_out40_continue: { describe: (op, v) => `после ${v}s вне верхних 40%`, apply: () => {} },
  popularity: { describe: (op, v) => placePhrase(op, v, FAVOURITE), apply: () => {} },
  post_number: { describe: (op, v) => `стартовый бокс ${cmpWord[op]} ${v}`, apply: () => {} },
  is_badstart: { describe: (op, v) => (v === 1 ? 'после плохого старта' : 'без плохого старта'), apply: () => {} },
  is_overtake: {
    describe: (op, v) => (v === 1 ? 'во время обгона' : 'вне обгона'),
    apply: (op, v, f) => { if (v === 1) f.needs.add('overtake'); },
  },
  overtake_target_time: { describe: (op, v) => `после ${v}s преследования цели`, apply: (op, v, f) => f.needs.add('overtake') },
  change_order_onetime: {
    describe: (op, v) => (v < 0 ? 'после отыгранного места' : 'после потерянного места'),
    apply: (op, v, f) => { f.needs.add(v < 0 ? 'gain-place' : 'lose-place'); },
  },
  change_order_up_end_after: {
    describe: (op, v) => `после обгона ${v} соперниц`,
    apply: (op, v, f) => { f.needs.add('gain-place'); },
  },
  blocked_front_continuetime: {
    describe: (op, v) => `после ${v}s зажатости спереди`,
    apply: (op, v, f) => { f.needs.add('blocked'); },
  },
  blocked_side_continuetime: {
    describe: (op, v) => `после ${v}s зажатости сбоку`,
    apply: (op, v, f) => { f.needs.add('blocked'); },
  },
  blocked_all_continuetime: {
    describe: (op, v) => `после ${v}s полной зажатости`,
    apply: (op, v, f) => { f.needs.add('blocked'); },
  },
  infront_near_lane_time: { describe: (op, v) => `после ${v}s с соперницей прямо впереди`, apply: (op, v, f) => f.needs.add('crowded') },
  is_behind_in: { describe: (op, v) => (v === 1 ? 'идя по внутренней позади других' : 'не будучи зажатой внутри'), apply: (op, v, f) => f.needs.add('crowded') },
  is_move_lane: { describe: (op, v) => (v === 1 ? 'во время смены дорожки' : 'удерживая дорожку'), apply: () => {} },
  near_count: { describe: (op, v) => `рядом ${cmpWord[op]} ${v} соперниц`, apply: (op, v, f) => f.needs.add('crowded') },
  lane_type: { describe: (op, v) => `на ${v === 1 ? 'внутренней' : 'внешней'} дорожке`, apply: () => {} },
  bashin_diff_infront: { describe: (op, v) => `${cmpWord[op]} ${v} корп. позади идущей впереди`, apply: () => {} },
  bashin_diff_behind: { describe: (op, v) => `${cmpWord[op]} ${v} корп. впереди идущей сзади`, apply: () => {} },
  distance_diff_top: { describe: (op, v) => `${cmpWord[op]} ${v} корп. от лидера`, apply: () => {} },
  distance_diff_rate: { describe: (op, v) => `${cmpWord[op]} ${v}% отрыва лидера`, apply: () => {} },
  distance_diff_top_float: { describe: (op, v) => `${cmpWord[op]} ${v / 10} корп. от лидера`, apply: () => {} },
  hp_per: { describe: (op, v) => `осталось ${cmpWord[op]} ${v}% выносливости`, apply: () => {} },
  accumulatetime: { describe: (op, v) => `с начала забега прошло ${cmpWord[op]} ${v}s`, apply: () => {} },
  temptation_count: { describe: (op, v) => `уже ${cmpWord[op]} ${v} ускорений темпа`, apply: () => {} },
  is_temptation: { describe: (op, v) => (v === 1 ? 'во время ускорения темпа' : 'вне ускорения темпа'), apply: () => {} },
  activate_count_heal: { describe: (op, v) => `после ${cmpWord[op]} ${v} скиллов на восстановление`, apply: () => {} },
  activate_count_all: { describe: (op, v) => `после ${cmpWord[op]} ${v} скиллов`, apply: () => {} },
  activate_count_start: { describe: (op, v) => `после ${cmpWord[op]} ${v} скиллов на старте`, apply: () => {} },
  activate_count_middle: { describe: (op, v) => `после ${cmpWord[op]} ${v} скиллов в середине`, apply: () => {} },
  activate_count_later_half: { describe: (op, v) => `после ${cmpWord[op]} ${v} скиллов во второй половине`, apply: () => {} },
  is_activate_any_skill: { describe: (op, v) => (v === 1 ? 'после срабатывания любого скилла' : 'до срабатывания любого скилла'), apply: () => {} },
  base_power: { describe: (op, v) => `базовый Power ${cmpWord[op]} ${v}`, apply: () => {} },
  base_speed: { describe: (op, v) => `базовый Speed ${cmpWord[op]} ${v}`, apply: () => {} },
  base_stamina: { describe: (op, v) => `базовый Stamina ${cmpWord[op]} ${v}`, apply: () => {} },
  base_guts: { describe: (op, v) => `базовый Guts ${cmpWord[op]} ${v}`, apply: () => {} },
  base_wiz: { describe: (op, v) => `базовый Wit ${cmpWord[op]} ${v}`, apply: () => {} },
  always: { describe: () => 'всегда активно', apply: (op, v, f) => f.passive = true },
  is_lastspurt_gap: { describe: (op, v) => `${cmpWord[op]} ${v} в последний спурт`, apply: () => {} },
};

for (const [style, key] of [[1, 'nige'], [2, 'senko'], [3, 'sashi'], [4, 'oikomi']]) {
  HANDLERS[`running_style_count_${key}`] = {
    describe: (op, v) => `в забеге ${cmpWord[op]} ${v} ${RUNNING_STYLE[style].name}`,
    apply: () => {},
  };
  HANDLERS[`running_style_count_${key}_otherself`] = {
    describe: (op, v) => `кроме себя ${cmpWord[op]} ${v} ${RUNNING_STYLE[style].name}`,
    apply: () => {},
  };
  HANDLERS[`running_style_temptation_opponent_count_${key}`] = {
    describe: (op, v) => `${cmpWord[op]} ${v} соперниц ${RUNNING_STYLE[style].name}, способных ускорить темп`,
    apply: () => {},
  };
  HANDLERS[`running_style_equal_popularity_one_${key}`] = {
    describe: () => `когда фаворит — ${RUNNING_STYLE[style].name}`,
    apply: () => {},
  };
}

/** Terms that are always true and only add noise to the readable text. */
function isTrivial(term) {
  if (term.key === 'order' && term.op === '>=' && term.value <= 1) return true;
  if (term.key === 'order_rate' && term.op === '<=' && term.value >= 100) return true;
  if (term.key === 'order_rate' && term.op === '>=' && term.value <= 0) return true;
  return false;
}

function intersect(a, b) {
  if (a == null) return [...b];
  const set = new Set(b);
  return a.filter((x) => set.has(x));
}

function emptyFacets() {
  return {
    phases: null,
    strategies: null,
    distanceTypes: null,
    surfaces: null,
    groundConditions: null,
    weathers: null,
    seasons: null,
    rotations: null,
    trackIds: new Set(),
    terrain: new Set(),
    needs: new Set(),
    position: {},
    window: {},
    random: false,
    late: false,
    passive: false,
  };
}

function mergeFacets(target, alt) {
  for (const key of ['phases', 'strategies', 'distanceTypes', 'surfaces', 'groundConditions', 'weathers', 'seasons', 'rotations']) {
    if (alt[key] == null) target[key] = null;
    else if (target[key] !== null) target[key] = [...new Set([...(target[key] || []), ...alt[key]])];
  }
  for (const key of ['trackIds', 'terrain', 'needs']) alt[key].forEach((v) => target[key].add(v));
  for (const key of ['random', 'late', 'passive']) target[key] = target[key] || alt[key];
  for (const [k, v] of Object.entries(alt.position)) {
    if (target.position[k] === undefined) target.position[k] = v;
    else if (k.endsWith('Max')) target.position[k] = Math.max(target.position[k], v);
    else target.position[k] = Math.min(target.position[k], v);
  }
  // A skill fires if *any* branch matches, so the window is the union: the
  // loosest bound on each side wins.
  for (const k of ['rateMin', 'rateMax', 'remainMin', 'remainMax']) {
    if (alt.window[k] === undefined) { delete target.window[k]; continue; }
    if (target.window[k] === undefined) continue;
    target.window[k] = k === 'rateMin' || k === 'remainMin'
      ? Math.min(target.window[k], alt.window[k])
      : Math.max(target.window[k], alt.window[k]);
  }
  return target;
}

/**
 * @param {string} condition  main activation condition
 * @param {string} precondition  gate that must have been satisfied earlier
 * @param {{trackName?: (id:number)=>string}} ctx
 */
export function analyseCondition(condition, precondition, ctx = {}) {
  const alts = parseExpression(condition);
  const pre = parseExpression(precondition);

  const merged = emptyFacets();
  merged.phases = null; merged.strategies = null;

  const altTexts = [];
  let first = true;
  for (const alt of alts) {
    const f = emptyFacets();
    f.phases = Object.keys(PHASE).map(Number);
    f.strategies = Object.keys(RUNNING_STYLE).map(Number);
    f.distanceTypes = Object.keys(DISTANCE_TYPE).map(Number);
    f.surfaces = Object.keys(SURFACE).map(Number);
    f.groundConditions = Object.keys(GROUND_CONDITION).map(Number);
    f.weathers = Object.keys(WEATHER).map(Number);
    f.seasons = Object.keys(SEASON).map(Number);
    f.rotations = Object.keys(ROTATION).map(Number);

    const phrases = [];
    for (const term of alt) {
      if (isTrivial(term)) continue;
      const h = HANDLERS[term.key];
      if (h) {
        h.apply(term.op, term.value, f);
        const phrase = h.describe(term.op, term.value, ctx);
        if (phrase) phrases.push(phrase);
      } else if (term.op === '?') {
        phrases.push(term.raw);
      } else {
        phrases.push(`${term.key.replace(/_/g, ' ')} ${cmpWord[term.op] ?? term.op} ${term.value}`);
      }
    }
    altTexts.push(phrases.join(', '));
    if (first) { Object.assign(merged, f); first = false; } else mergeFacets(merged, f);
  }

  const preTexts = pre.map((alt) => alt.map((term) => {
    const h = HANDLERS[term.key];
    return h ? h.describe(term.op, term.value, ctx) : `${term.key.replace(/_/g, ' ')} ${cmpWord[term.op] ?? term.op} ${term.value}`;
  }).filter(Boolean).join(', ')).filter(Boolean);

  const text = [
    preTexts.length ? `После того как ${preTexts.join(' — или — ')}: ` : '',
    altTexts.filter(Boolean).join(' — или — ') || 'Без условий',
  ].join('');

  return {
    text: text.charAt(0).toUpperCase() + text.slice(1),
    facets: {
      phases: merged.phases,
      strategies: merged.strategies,
      distanceTypes: merged.distanceTypes,
      surfaces: merged.surfaces,
      groundConditions: merged.groundConditions,
      weathers: merged.weathers,
      seasons: merged.seasons,
      rotations: merged.rotations,
      trackIds: [...merged.trackIds],
      terrain: [...merged.terrain],
      needs: [...merged.needs],
      position: merged.position,
      window: merged.window,
      random: merged.random,
      late: merged.late,
      passive: merged.passive,
    },
  };
}
