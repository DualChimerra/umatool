// Parser for the condition strings that ship with skill data.
//
//   "phase>=2&order_rate<=50@is_finalcorner==1"
//
// `@` separates alternatives (OR), `&` separates requirements (AND).
// The parser produces two things: a readable English sentence and a set of
// facets the UI can filter and sort on.

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

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const listOf = (arr) => {
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  return `${arr.slice(0, -1).join(', ')} or ${arr[arr.length - 1]}`;
};

const cmpWord = { '>=': 'at least', '<=': 'at most', '>': 'over', '<': 'under', '==': 'exactly', '!=': 'not' };

/**
 * Per-key handlers. `describe` returns a phrase, `apply` records facets.
 * Anything without a handler still shows up as a raw phrase so nothing is
 * silently dropped when the game adds new condition keys.
 */
const HANDLERS = {
  phase: {
    describe: (op, v) => `${listOf(resolveSet(PHASE, op, v).map((p) => PHASE[p].name))}`,
    apply: (op, v, f) => { f.phases = intersect(f.phases, resolveSet(PHASE, op, v)); },
  },
  phase_random: {
    describe: (op, v) => `random point in the ${PHASE[v]?.name ?? `phase ${v}`}`,
    apply: (op, v, f) => { f.phases = intersect(f.phases, resolveSet(PHASE, op, v)); f.random = true; },
  },
  phase_firsthalf_random: {
    describe: (op, v) => `random point in the first half of the ${PHASE[v]?.name ?? `phase ${v}`}`,
    apply: (op, v, f) => { f.phases = intersect(f.phases, resolveSet(PHASE, op, v)); f.random = true; },
  },
  phase_laterhalf_random: {
    describe: (op, v) => `random point in the second half of the ${PHASE[v]?.name ?? `phase ${v}`}`,
    apply: (op, v, f) => { f.phases = intersect(f.phases, resolveSet(PHASE, op, v)); f.random = true; },
  },
  phase_corner_random: {
    describe: (op, v) => `random corner during the ${PHASE[v]?.name ?? `phase ${v}`}`,
    apply: (op, v, f) => { f.phases = intersect(f.phases, resolveSet(PHASE, op, v)); f.terrain.add('corner'); f.random = true; },
  },
  distance_type: {
    describe: (op, v) => `${listOf(resolveSet(DISTANCE_TYPE, op, v).map((d) => DISTANCE_TYPE[d].name))} races`,
    apply: (op, v, f) => { f.distanceTypes = intersect(f.distanceTypes, resolveSet(DISTANCE_TYPE, op, v)); },
  },
  ground_type: {
    describe: (op, v) => `${listOf(resolveSet(SURFACE, op, v).map((d) => SURFACE[d].name))}`,
    apply: (op, v, f) => { f.surfaces = intersect(f.surfaces, resolveSet(SURFACE, op, v)); },
  },
  running_style: {
    describe: (op, v) => `running as ${listOf(resolveSet(RUNNING_STYLE, op, v).map((d) => RUNNING_STYLE[d].name))}`,
    apply: (op, v, f) => { f.strategies = intersect(f.strategies, resolveSet(RUNNING_STYLE, op, v)); },
  },
  ground_condition: {
    describe: (op, v) => `${listOf(resolveSet(GROUND_CONDITION, op, v).map((d) => GROUND_CONDITION[d]))} going`,
    apply: (op, v, f) => { f.groundConditions = intersect(f.groundConditions, resolveSet(GROUND_CONDITION, op, v)); },
  },
  weather: {
    describe: (op, v) => `${listOf(resolveSet(WEATHER, op, v).map((d) => WEATHER[d]))} weather`,
    apply: (op, v, f) => { f.weathers = intersect(f.weathers, resolveSet(WEATHER, op, v)); },
  },
  season: {
    describe: (op, v) => `in ${listOf(resolveSet(SEASON, op, v).map((d) => SEASON[d]))}`,
    apply: (op, v, f) => { f.seasons = intersect(f.seasons, resolveSet(SEASON, op, v)); },
  },
  rotation: {
    describe: (op, v) => `${listOf(resolveSet(ROTATION, op, v).map((d) => ROTATION[d]))} tracks`,
    apply: (op, v, f) => { f.rotations = intersect(f.rotations, resolveSet(ROTATION, op, v)); },
  },
  track_id: {
    describe: (op, v, ctx) => `at ${ctx.trackName?.(v) ?? `track ${v}`}`,
    apply: (op, v, f) => { if (op === '==') f.trackIds.add(v); },
  },
  corner: {
    describe: (op, v) => (v === 0 && op === '!=' ? 'on a corner' : v === 0 ? 'not on a corner' : `on corner ${v}`),
    apply: (op, v, f) => { if (v === 0 && op === '!=') f.terrain.add('corner'); else if (v === 0) f.terrain.add('straight'); else f.terrain.add('corner'); },
  },
  corner_random: {
    describe: () => 'random point on a corner',
    apply: (op, v, f) => { f.terrain.add('corner'); f.random = true; },
  },
  all_corner_random: {
    describe: () => 'random point on every corner',
    apply: (op, v, f) => { f.terrain.add('corner'); f.random = true; },
  },
  is_finalcorner: {
    describe: (op, v) => (v === 1 ? 'from the final corner onward' : 'before the final corner'),
    apply: (op, v, f) => { if (v === 1) { f.terrain.add('final-corner'); f.late = true; } },
  },
  is_finalcorner_random: {
    describe: () => 'random point on the final corner',
    apply: (op, v, f) => { f.terrain.add('final-corner'); f.random = true; f.late = true; },
  },
  is_finalcorner_laterhalf: {
    describe: () => 'second half of the final corner',
    apply: (op, v, f) => { f.terrain.add('final-corner'); f.late = true; },
  },
  is_last_straight: {
    describe: () => 'on the final straight',
    apply: (op, v, f) => { f.terrain.add('last-straight'); f.late = true; },
  },
  is_last_straight_onetime: {
    describe: () => 'once on the final straight',
    apply: (op, v, f) => { f.terrain.add('last-straight'); f.late = true; },
  },
  last_straight_random: {
    describe: () => 'random point on the final straight',
    apply: (op, v, f) => { f.terrain.add('last-straight'); f.random = true; f.late = true; },
  },
  straight_random: {
    describe: () => 'random point on a straight',
    apply: (op, v, f) => { f.terrain.add('straight'); f.random = true; },
  },
  straight_front_type: {
    describe: (op, v) => (v === 1 ? 'on the home straight' : 'on the back straight'),
    apply: (op, v, f) => { f.terrain.add('straight'); },
  },
  slope: {
    describe: (op, v) => (v === 1 ? 'on an uphill' : v === 2 ? 'on a downhill' : 'on flat ground'),
    apply: (op, v, f) => { f.terrain.add(v === 1 ? 'uphill' : v === 2 ? 'downhill' : 'flat'); },
  },
  up_slope_random: {
    describe: () => 'random point on an uphill',
    apply: (op, v, f) => { f.terrain.add('uphill'); f.random = true; },
  },
  down_slope_random: {
    describe: () => 'random point on a downhill',
    apply: (op, v, f) => { f.terrain.add('downhill'); f.random = true; },
  },
  is_lastspurt: {
    describe: (op, v) => (v === 1 ? 'while in last spurt' : 'while not in last spurt'),
    apply: (op, v, f) => { if (v === 1) { f.late = true; f.phases = intersect(f.phases, [2, 3]); } },
  },
  is_basis_distance: {
    describe: (op, v) => (v === 1 ? 'in races of a standard distance (multiple of 400m)' : 'in races of a non-standard distance'),
    apply: () => {},
  },
  remain_distance: {
    describe: (op, v) => `${cmpWord[op]} ${v}m left`,
    apply: (op, v, f) => { if ((op === '<=' || op === '<') && v <= 600) f.late = true; },
  },
  distance_rate: {
    describe: (op, v) => `${cmpWord[op]} ${v}% into the race`,
    apply: (op, v, f) => { if ((op === '>=' || op === '>') && v >= 60) f.late = true; },
  },
  distance_rate_after_random: {
    describe: (op, v) => `random point after ${v}% into the race`,
    apply: (op, v, f) => { f.random = true; },
  },
  order: {
    describe: (op, v) => `${cmpWord[op]} ${ordinal(v)} place`,
    apply: (op, v, f) => {
      if (op === '<=' || op === '<') f.position.orderMax = Math.min(f.position.orderMax ?? 99, v);
      if (op === '>=' || op === '>') f.position.orderMin = Math.max(f.position.orderMin ?? 0, v);
      if (op === '==') { f.position.orderMax = v; f.position.orderMin = v; }
    },
  },
  order_rate: {
    describe: (op, v) => `in the ${op.startsWith('<') ? 'top' : 'bottom'} ${op.startsWith('<') ? v : 100 - v}% of the field`,
    apply: (op, v, f) => {
      if (op === '<=' || op === '<') f.position.rateMax = Math.min(f.position.rateMax ?? 100, v);
      if (op === '>=' || op === '>') f.position.rateMin = Math.max(f.position.rateMin ?? 0, v);
    },
  },
  order_rate_in20_continue: { describe: (op, v) => `after ${v}s inside the top 20%`, apply: () => {} },
  order_rate_out40_continue: { describe: (op, v) => `after ${v}s outside the top 40%`, apply: () => {} },
  popularity: { describe: (op, v) => `${cmpWord[op]} ${ordinal(v)} favourite`, apply: () => {} },
  post_number: { describe: (op, v) => `${cmpWord[op]} post ${v}`, apply: () => {} },
  is_badstart: { describe: (op, v) => (v === 1 ? 'after a poor start' : 'without a poor start'), apply: () => {} },
  is_overtake: {
    describe: (op, v) => (v === 1 ? 'while overtaking' : 'while not overtaking'),
    apply: (op, v, f) => { if (v === 1) f.needs.add('overtake'); },
  },
  overtake_target_time: { describe: (op, v) => `after ${v}s of chasing a target`, apply: (op, v, f) => f.needs.add('overtake') },
  change_order_onetime: {
    describe: (op, v) => (v < 0 ? 'after gaining a place' : 'after losing a place'),
    apply: (op, v, f) => { f.needs.add(v < 0 ? 'gain-place' : 'lose-place'); },
  },
  change_order_up_end_after: {
    describe: (op, v) => `after passing ${v} runners`,
    apply: (op, v, f) => { f.needs.add('gain-place'); },
  },
  blocked_front_continuetime: {
    describe: (op, v) => `after being boxed in from the front for ${v}s`,
    apply: (op, v, f) => { f.needs.add('blocked'); },
  },
  blocked_side_continuetime: {
    describe: (op, v) => `after being boxed in on the side for ${v}s`,
    apply: (op, v, f) => { f.needs.add('blocked'); },
  },
  blocked_all_continuetime: {
    describe: (op, v) => `after being fully boxed in for ${v}s`,
    apply: (op, v, f) => { f.needs.add('blocked'); },
  },
  infront_near_lane_time: { describe: (op, v) => `after ${v}s with a runner just ahead`, apply: (op, v, f) => f.needs.add('crowded') },
  is_behind_in: { describe: (op, v) => (v === 1 ? 'while running on the inside behind others' : 'while not boxed inside'), apply: (op, v, f) => f.needs.add('crowded') },
  is_move_lane: { describe: (op, v) => (v === 1 ? 'while changing lane' : 'while holding lane'), apply: () => {} },
  near_count: { describe: (op, v) => `with ${cmpWord[op]} ${v} runners nearby`, apply: (op, v, f) => f.needs.add('crowded') },
  lane_type: { describe: (op, v) => `while in the ${v === 1 ? 'inner' : 'outer'} lane`, apply: () => {} },
  bashin_diff_infront: { describe: (op, v) => `${cmpWord[op]} ${v} length${v === 1 ? '' : 's'} behind the runner ahead`, apply: () => {} },
  bashin_diff_behind: { describe: (op, v) => `${cmpWord[op]} ${v} length${v === 1 ? '' : 's'} ahead of the runner behind`, apply: () => {} },
  distance_diff_top: { describe: (op, v) => `${cmpWord[op]} ${v} lengths off the leader`, apply: () => {} },
  distance_diff_rate: { describe: (op, v) => `${cmpWord[op]} ${v}% of the leader's gap`, apply: () => {} },
  distance_diff_top_float: { describe: (op, v) => `${cmpWord[op]} ${v / 10} lengths off the leader`, apply: () => {} },
  hp_per: { describe: (op, v) => `with ${cmpWord[op]} ${v}% stamina left`, apply: () => {} },
  accumulatetime: { describe: (op, v) => `${cmpWord[op]} ${v}s into the race`, apply: () => {} },
  temptation_count: { describe: (op, v) => `${cmpWord[op]} ${v} pace-up${v === 1 ? '' : 's'} so far`, apply: () => {} },
  is_temptation: { describe: (op, v) => (v === 1 ? 'while paced up' : 'while not paced up'), apply: () => {} },
  activate_count_heal: { describe: (op, v) => `after ${cmpWord[op]} ${v} recovery skills`, apply: () => {} },
  activate_count_all: { describe: (op, v) => `after ${cmpWord[op]} ${v} skills`, apply: () => {} },
  activate_count_start: { describe: (op, v) => `after ${cmpWord[op]} ${v} opening-leg skills`, apply: () => {} },
  activate_count_middle: { describe: (op, v) => `after ${cmpWord[op]} ${v} middle-leg skills`, apply: () => {} },
  activate_count_later_half: { describe: (op, v) => `after ${cmpWord[op]} ${v} second-half skills`, apply: () => {} },
  is_activate_any_skill: { describe: (op, v) => (v === 1 ? 'after any skill has fired' : 'before any skill fires'), apply: () => {} },
  base_power: { describe: (op, v) => `with ${cmpWord[op]} ${v} base Power`, apply: () => {} },
  base_speed: { describe: (op, v) => `with ${cmpWord[op]} ${v} base Speed`, apply: () => {} },
  base_stamina: { describe: (op, v) => `with ${cmpWord[op]} ${v} base Stamina`, apply: () => {} },
  base_guts: { describe: (op, v) => `with ${cmpWord[op]} ${v} base Guts`, apply: () => {} },
  base_wiz: { describe: (op, v) => `with ${cmpWord[op]} ${v} base Wit`, apply: () => {} },
  always: { describe: () => 'always active', apply: (op, v, f) => f.passive = true },
  is_lastspurt_gap: { describe: (op, v) => `${cmpWord[op]} ${v} into the last spurt`, apply: () => {} },
};

for (const [style, key] of [[1, 'nige'], [2, 'senko'], [3, 'sashi'], [4, 'oikomi']]) {
  HANDLERS[`running_style_count_${key}`] = {
    describe: (op, v) => `with ${cmpWord[op]} ${v} ${RUNNING_STYLE[style].name}s in the race`,
    apply: () => {},
  };
  HANDLERS[`running_style_count_${key}_otherself`] = {
    describe: (op, v) => `with ${cmpWord[op]} ${v} other ${RUNNING_STYLE[style].name}s`,
    apply: () => {},
  };
  HANDLERS[`running_style_temptation_opponent_count_${key}`] = {
    describe: (op, v) => `with ${cmpWord[op]} ${v} ${RUNNING_STYLE[style].name} opponents able to pace up`,
    apply: () => {},
  };
  HANDLERS[`running_style_equal_popularity_one_${key}`] = {
    describe: () => `when the favourite is a ${RUNNING_STYLE[style].name}`,
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
    preTexts.length ? `Once ${preTexts.join(' — or — ')}: ` : '',
    altTexts.filter(Boolean).join(' — or — ') || 'No conditions',
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
      random: merged.random,
      late: merged.late,
      passive: merged.passive,
    },
  };
}
