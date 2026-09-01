// Race model and skill valuation.
//
// Two engines share this file's vocabulary:
//
//   * `race/sim.mjs` runs the whole field forward at 1/15 s. It is the truth,
//     and it is far too slow to re-run for 600 skills every time a slider
//     moves.
//   * everything here is the closed form that stands in for it — same
//     coefficients, same course geometry, same conditions, collapsed into
//     arithmetic that survives being called a few thousand times a keystroke.
//
// The closed form is calibrated against the simulator, and the UI can check
// any row against it on demand. Where the two disagree, the simulator wins.
//
// Three things this file gets right that a naive "m/s × seconds" score does
// not, and which is why the ranking used to disagree with every published
// Champions Meeting list:
//
//   1. **Acceleration is only worth something while you are below target
//      speed.** A +0.4 m/s² skill on the back straight, where you are already
//      cruising at your target, is worth nothing at all; the same skill fired
//      into the last-spurt ramp is one of the best things you can carry. The
//      model finds the ramps on the actual course and asks whether the skill
//      can reach one.
//   2. **Debuffs count.** Half of a Champions Meeting list is skills that do
//      nothing to you and something to everyone else. Scoring "metres gained"
//      drops them to zero; scoring *ground gained on the field* does not.
//   3. **Green skills are stat changes, and a stat is worth what the race says
//      it is worth.** +40 Stamina is two lengths when the spurt is short and
//      exactly nothing when it is already paid for.

import {
  compile, phaseAt, phaseBounds, terrainRanges,
} from './race/conditions.mjs';
import {
  STRATEGY_PHASE_COEF, STRATEGY_ACCEL_COEF, STRATEGY_HP_COEF,
  GROUND_HP, GROUND_POWER, APT_DISTANCE, APT_SURFACE, APT_STRATEGY,
  TARGET_KIND, isDebuff, isPassive, baseSpeed, BASHIN,
} from './race/sim.mjs';

export { BASHIN, baseSpeed, isDebuff, isPassive, TARGET_KIND };
export const CM_FIELD_SIZE = 9;

export const STRATEGY = {
  1: { key: 'front', name: 'Front Runner', short: 'Front' },
  2: { key: 'pace', name: 'Pace Chaser', short: 'Pace' },
  3: { key: 'late', name: 'Late Surger', short: 'Late' },
  4: { key: 'end', name: 'End Closer', short: 'End' },
};

export const GROUND_NAME = { 1: 'Firm', 2: 'Good', 3: 'Soft', 4: 'Heavy' };
export const WEATHER_NAME = { 1: 'Sunny', 2: 'Cloudy', 3: 'Rainy', 4: 'Snowy' };
export const SEASON_NAME = { 1: 'Spring', 2: 'Summer', 3: 'Autumn', 4: 'Winter', 5: 'Sakura' };
export const APT_GRADE = ['-', 'G', 'F', 'E', 'D', 'C', 'B', 'A', 'S'];

const START_DASH_ACCEL = 24;

/**
 * Unique skill level.
 *
 * The Global master dump ships one row per unique, at its base value — what
 * you see the moment the skill is learned. Raising it (stars, scenario, the
 * unique-level items) raises the effect, and the community reading of that is
 * a flat +10% of base per level. That is what this table is, stated openly:
 * level 1 is the dump's own number and level 6 is one and a half times it.
 * Everything that reads it says which level it used.
 */
export const UNIQUE_LEVEL_SCALE = [1, 1, 1.1, 1.2, 1.3, 1.4, 1.5];
export const uniqueScale = (level) => UNIQUE_LEVEL_SCALE[Math.max(1, Math.min(6, level | 0))] ?? 1;
export const isUnique = (skill) => skill.tier === 'unique' || skill.tier === 'evolved';

/** A copy of a unique with its effects scaled to the level you actually have. */
export function atUniqueLevel(skill, level) {
  const k = uniqueScale(level);
  if (!skill || k === 1 || !isUnique(skill)) return skill;
  const scale = (e) => (typeof e.value === 'number' ? { ...e, value: Math.round(e.value * k * 1000) / 1000 } : e);
  return {
    ...skill,
    uniqueLevel: level,
    effects: skill.effects.map(scale),
    variants: skill.variants.map((v) => ({ ...v, effects: v.effects.map(scale) })),
  };
}

/** Acceleration in m/s², the one place Power enters the speed model. */
export function accelRate(power, strategy, phaseIdx, surface = 1, ground = 1, apt = {}) {
  const effective = Math.max(1, power + (GROUND_POWER[surface]?.[ground] ?? 0));
  return 0.0006 * Math.sqrt(500 * effective)
    * (STRATEGY_ACCEL_COEF[strategy] ?? STRATEGY_ACCEL_COEF[2])[phaseIdx]
    * (APT_SURFACE[apt.surface ?? 7] ?? 1) * (APT_STRATEGY[apt.strategy ?? 7] ?? 1);
}

/** Seconds lost ramping from `from` to `to` at rate `a`, versus an instant change. */
const rampLoss = (from, to, a) => (to <= from || a <= 0 ? 0 : (to - from) ** 2 / (2 * a * to));

/* ------------------------------------------------------------ order model */

// Where each running style sits in the field, as a fraction from the front, at
// each of the four phases, with the spread around it.
//
// These are measured, not guessed: the simulator was run over four courses with
// an identical field and the running order sampled at each phase boundary. That
// is why the first three phases barely move and the fourth explodes — position
// keep holds the field in style order until two thirds of the race, and the
// whole race happens in the last third.
const STYLE_PACE = {
  1: [0.180, 0.167, 0.217, 0.775],
  2: [0.449, 0.445, 0.447, 0.595],
  3: [0.761, 0.733, 0.724, 0.391],
  4: [0.884, 0.932, 0.887, 0.439],
};
const PACE_SPREAD = {
  1: [0.114, 0.060, 0.116, 0.273],
  2: [0.121, 0.094, 0.158, 0.204],
  3: [0.118, 0.079, 0.173, 0.247],
  4: [0.114, 0.077, 0.140, 0.284],
};

const orderCache = new Map();

/**
 * Probability of holding each place, for one running style, in a field with a
 * known mix of styles, at a given phase.
 *
 * This is what makes an `order_rate<=40` skill answerable. Two Front Runners
 * in the field and you are usually 1st or 2nd; five of them and the same skill
 * is a coin flip.
 *
 * @param {number[]} fieldStyles running style of every runner, yours included
 * @returns {Map<number, number>} place (1-based) → probability
 */
export function orderDistribution(strategy, fieldStyles, phase = 3) {
  const key = `${strategy}|${phase}|${[...fieldStyles].sort().join('')}`;
  const hit = orderCache.get(key);
  if (hit) return hit;

  const n = fieldStyles.length;
  const counts = new Array(n + 1).fill(0);
  const draws = 3000;
  // Fixed, cheap Gaussian: two uniforms averaged four times is close enough
  // and keeps the table stable between renders.
  let seed = 20250901;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * 0.7071;

  // Your own slot is the first of your style in the list.
  const others = [...fieldStyles];
  const mine = others.indexOf(strategy) >= 0 ? others.splice(others.indexOf(strategy), 1)[0] : strategy;

  for (let i = 0; i < draws; i += 1) {
    const me = STYLE_PACE[mine][phase] + gauss() * PACE_SPREAD[mine][phase];
    let place = 1;
    for (const s of others) if (STYLE_PACE[s][phase] + gauss() * PACE_SPREAD[s][phase] < me) place += 1;
    counts[place] += 1;
  }
  const out = new Map();
  for (let p = 1; p <= n; p += 1) if (counts[p]) out.set(p, counts[p] / draws);
  orderCache.set(key, out);
  return out;
}

export const orderRate = (order, fieldSize) => (order / fieldSize) * 100;

/** Chance the positional part of a condition holds. */
export function positionProbability(position = {}, strategy, fieldStyles, phase = 3) {
  if (position.orderMin == null && position.orderMax == null
      && position.rateMin == null && position.rateMax == null) return 1;
  const dist = orderDistribution(strategy, fieldStyles, phase);
  const n = fieldStyles.length;
  let p = 0;
  for (const [order, w] of dist) {
    const rate = orderRate(order, n);
    if (position.orderMin != null && order < position.orderMin) continue;
    if (position.orderMax != null && order > position.orderMax) continue;
    if (position.rateMin != null && rate < position.rateMin) continue;
    if (position.rateMax != null && rate > position.rateMax) continue;
    p += w;
  }
  return p;
}

/** Skill activation roll. Skills flagged as Wit-checked fail it sometimes. */
export function activationRate(wit) {
  return Math.min(1, Math.max(0.2, (100 - 9000 / Math.max(1, wit)) / 100));
}

/* ---------------------------------------------------------------- HP model */

export function raceSpeeds({ distance, speed, guts, strategy, aptitudes = {} }) {
  const base = baseSpeed(distance);
  const coef = STRATEGY_PHASE_COEF[strategy] ?? STRATEGY_PHASE_COEF[2];
  const speedTerm = Math.sqrt(500 * speed) * 0.002 * (APT_DISTANCE[aptitudes.distance ?? 7] ?? 1);
  return {
    base,
    v0: base * coef[0],
    v1: base * coef[1],
    v2: base * coef[2] + speedTerm,
    spurt: (base * (coef[2] + 0.01)) * 1.05 + speedTerm + (450 * Math.max(1, guts)) ** 0.597 * 0.0001,
    min: base * 0.85 + Math.sqrt(200 * Math.max(1, guts)) * 0.001,
  };
}

const drainPerSecond = (v, base) => (20 * (v - base + 12) ** 2) / 144;

/**
 * Your own race: can you run it to the line, how much of the last spurt do you
 * pay for, and where does the model think you accelerate.
 */
export function simulateRace({ course, strategy, stats, ground = 1, recoveryPct = 0, aptitudes = {} }) {
  const d = course.distance;
  const speeds = raceSpeeds({ distance: d, speed: stats.speed, guts: stats.guts, strategy, aptitudes });
  const { base, v0, v1, v2, spurt } = speeds;

  const hpCoef = STRATEGY_HP_COEF[strategy] ?? 1;
  const maxHp = d + 0.8 * hpCoef * stats.stamina;
  const groundMul = GROUND_HP[course.surface]?.[ground] ?? 1;
  const gutsMul = 1 + 200 / Math.sqrt(600 * Math.max(1, stats.guts));

  const seg = [d / 6, d / 2, d / 3];
  const hpOpening = drainPerSecond(v0, base) * (seg[0] / v0) * groundMul;
  const hpMiddle = drainPerSecond(v1, base) * (seg[1] / v1) * groundMul;
  const before = hpOpening + hpMiddle;

  const available = maxHp * (1 + recoveryPct / 100) - before;
  const rateSpurt = drainPerSecond(spurt, base) * groundMul * gutsMul;
  const rateCruise = drainPerSecond(v2, base) * groundMul * gutsMul;
  const hpFullSpurt = (rateSpurt * seg[2]) / spurt;

  const perMetreSpurt = rateSpurt / spurt;
  const perMetreCruise = rateCruise / v2;
  let spurtDistance = seg[2];
  if (available < hpFullSpurt) {
    spurtDistance = (available - perMetreCruise * seg[2]) / (perMetreSpurt - perMetreCruise);
    spurtDistance = Math.max(0, Math.min(seg[2], spurtDistance));
  }

  const needHp = before + hpFullSpurt;
  const requiredStamina = Math.max(0, (needHp / (1 + recoveryPct / 100) - d) / (0.8 * hpCoef));

  const aOpen = accelRate(stats.power, strategy, 0, course.surface, ground, aptitudes);
  const aMid = accelRate(stats.power, strategy, 1, course.surface, ground, aptitudes);
  const aFinal = accelRate(stats.power, strategy, 2, course.surface, ground, aptitudes);

  const spurtStart = d - spurtDistance;

  // Every stretch of track where the runner is below target speed and climbing.
  // These are the only places acceleration turns into ground.
  const ramps = [];
  const addRamp = (at, from, to, a, why) => {
    if (to <= from + 1e-6 || a <= 0) return;
    const secs = (to - from) / a;
    ramps.push({ at, from, to, a, why, seconds: secs, length: ((from + to) / 2) * secs, loss: rampLoss(from, to, a) });
  };
  addRamp(0, 0.85 * v0, v0, aOpen + START_DASH_ACCEL * 0.0, 'out of the gate');
  if (v1 > v0) addRamp(d / 6, v0, v1, aMid, 'into the middle leg');
  if (v2 > v1) addRamp((d * 2) / 3, v1, v2, aFinal, 'into the final leg');
  if (spurtDistance > 0) addRamp(spurtStart, Math.max(v1, v2), spurt, aFinal, 'into the last spurt');
  // Leaving an uphill: the slope has been holding target speed down.
  for (const up of course.derived.uphill) {
    const drop = ((up.slope / 10000) * 200) / Math.max(1, stats.power + (GROUND_POWER[course.surface]?.[ground] ?? 0));
    const at = up.start + up.length;
    const cruise = at > (d * 2) / 3 ? v2 : at > d / 6 ? v1 : v0;
    addRamp(at, cruise - drop, cruise, at > (d * 2) / 3 ? aFinal : aMid, 'off the uphill');
  }

  const startLoss = (0.85 * v0 / (aOpen + START_DASH_ACCEL))
    - ((0.85 * v0) ** 2) / (2 * (aOpen + START_DASH_ACCEL) * v0);
  const accelLoss = startLoss + ramps.reduce((n, r) => n + r.loss, 0);

  const time = seg[0] / v0 + seg[1] / v1 + (seg[2] - spurtDistance) / v2 + spurtDistance / spurt + accelLoss;

  const surplus = available - hpFullSpurt;
  const spurtCoverage = spurtDistance / seg[2];
  const staminaPressure = spurtCoverage >= 1
    ? Math.max(0, 0.12 * (1 - Math.min(1, surplus / (0.2 * hpFullSpurt))))
    : Math.min(1, 1 - spurtCoverage);

  return {
    maxHp,
    hpUsed: needHp,
    hpBeforeFinal: before,
    hpFullSpurt,
    available,
    surplus,
    requiredStamina: Math.ceil(requiredStamina),
    spurtDistance,
    spurtStart,
    spurtCoverage,
    speeds,
    rates: { spurt: rateSpurt, cruise: rateCruise },
    accel: { opening: aOpen, middle: aMid, final: aFinal, startLoss, total: accelLoss },
    ramps,
    gutsMul,
    groundMul,
    time,
    staminaPressure,
  };
}

/* -------------------------------------------------- course geometry helpers */

export function courseTerrain(course) {
  const t = new Set(['flat']);
  if (course.derived.cornerCount > 0) { t.add('corner'); t.add('final-corner'); }
  if (course.straights.length) { t.add('straight'); t.add('last-straight'); }
  if (course.derived.uphillLength > 0) t.add('uphill');
  if (course.derived.downhillLength > 0) t.add('downhill');
  return t;
}

export { phaseBounds, phaseAt, terrainRanges };

const rangeLength = (rs) => rs.reduce((n, [s, e]) => n + (e - s), 0);

/** Cached compile of a skill against a course. */
const skillCompileCache = new Map();
function compiledFor(skill, course) {
  const key = `${skill.id}|${course.id}`;
  let hit = skillCompileCache.get(key);
  if (!hit) {
    hit = skill.variants.map((v) => ({
      variant: v,
      cond: compile(v.raw.condition, course),
      pre: v.raw.precondition ? compile(v.raw.precondition, course) : null,
    }));
    skillCompileCache.set(key, hit);
  }
  return hit;
}

/**
 * The stretch of track a skill can fire on, taken from the real condition
 * string rather than the coarse facets — which means the phase boundaries, the
 * corner list and the slope list are the ones the course actually has.
 */
export function triggerWindow(skill, ctx) {
  const chosen = chooseAlternative(skill, ctx);
  if (!chosen) return null;
  const { alt } = chosen;
  const length = rangeLength(alt.ranges);
  if (length <= 0) return null;
  const centroid = alt.ranges.reduce((n, [s, e]) => n + ((s + e) / 2) * (e - s), 0) / length;
  return { ranges: alt.ranges, length, centroid, share: length / ctx.course.distance, random: alt.random };
}

/** A synthetic race + runner, enough for the setup-time condition terms. */
function conditionEnv(ctx) {
  const styleCount = {};
  for (const s of ctx.fieldStyles ?? [ctx.strategy]) styleCount[s] = (styleCount[s] ?? 0) + 1;
  return [
    {
      course: ctx.course,
      ground: ctx.ground ?? 1,
      weather: ctx.weather ?? 1,
      season: ctx.season ?? 1,
      styleCount,
      favouriteStyle: ctx.favouriteStyle ?? 0,
    },
    { strategy: ctx.strategy, base: ctx.stats, stats: ctx.stats },
  ];
}

/**
 * The alternative this race setup allows *and* which is easiest to satisfy.
 *
 * A condition string separated by `@` fires if any branch holds, so taking the
 * first one is wrong whenever a later branch drops a requirement — several
 * uniques are written as "…and no pace-up yet @ …" and the second branch is
 * the one that actually decides the skill.
 */
function chooseAlternative(skill, ctx) {
  const [race, runner] = conditionEnv(ctx);
  let best = null;
  for (const c of compiledFor(skill, ctx.course)) {
    // A precondition is a gate on the whole variant: if this race cannot
    // satisfy it, the skill never arms, whatever its main condition says.
    const pre = preOdds(c.pre, race, runner);
    if (pre.blocked) continue;
    for (const alt of c.cond.alts) {
      if (!alt.setup.every((fn) => fn(race, runner))) continue;
      if (!alt.ranges.length || rangeLength(alt.ranges) <= 0) continue;
      let odds = pre.odds;
      for (const g of [...alt.liveKeys, ...alt.guesses]) {
        const key = g.split(/[<>=!]/)[0];
        if (key !== 'order' && key !== 'order_rate') odds *= termOdds(g);
      }
      if (!best || odds > best.odds) best = { alt, variant: c.variant, cond: c.cond, odds, pre };
    }
  }
  return best;
}

/**
 * How likely the precondition is to have armed the skill, and whether this race
 * rules it out entirely. Positional preconditions get the field model; the rest
 * get their published odds, discounted a little less than a live condition
 * because a precondition only has to be true *once*, not at the trigger.
 */
function preOdds(pre, race, runner) {
  if (!pre) return { blocked: false, odds: 1, terms: [] };
  let best = null;
  for (const alt of pre.alts) {
    if (!alt.setup.every((fn) => fn(race, runner))) continue;
    if (alt.ranges.length && rangeLength(alt.ranges) <= 0) continue;
    let odds = 1;
    const terms = [];
    for (const g of [...alt.liveKeys, ...alt.guesses]) {
      const key = g.split(/[<>=!]/)[0];
      if (key === 'order' || key === 'order_rate') continue;
      odds *= Math.min(1, termOdds(g) + 0.15);
      if (LIVE_LABEL[key]) terms.push(LIVE_LABEL[key]);
    }
    if (!best || odds > best.odds) best = { blocked: false, odds, terms, position: alt.position ?? {} };
  }
  return best ?? { blocked: true, odds: 0, terms: [] };
}

/* --------------------------------------------------------------- valuation */

// Live condition terms the closed form cannot check, and how often they hold.
// The simulator checks them for real; this is the stand-in, and every row it
// uses is named on the skill so the discount is visible rather than baked in.
//
// A few of them flip on the operator: `temptation_count==0` ("no pace-up has
// happened") is nearly always true, while `temptation_count>=1` almost never
// is. Treating both as one number was quietly halving the score of a dozen
// perfectly good skills.
const LIVE_ODDS = {
  blocked_front_continuetime: 0.4,
  blocked_side_continuetime: 0.3,
  blocked_all_continuetime: 0.22,
  infront_near_lane_time: 0.72,
  is_behind_in: (op, v) => (v === 1 ? 0.6 : 0.4),
  near_count: (op, v) => (op.startsWith('>') ? Math.max(0.25, 1 - v * 0.08) : 0.7),
  is_overtake: (op, v) => (v === 1 ? 0.72 : 0.28),
  overtake_target_time: 0.8,
  change_order_onetime: 0.65,
  change_order_up_end_after: (op, v) => Math.max(0.2, 0.8 - v * 0.12),
  bashin_diff_infront: 0.6,
  bashin_diff_behind: 0.55,
  distance_diff_top: 0.85,
  distance_diff_rate: 0.8,
  distance_diff_top_float: 0.85,
  hp_per: (op, v) => (op.startsWith('>') ? Math.max(0.15, 1 - v / 110) : Math.min(0.9, v / 90)),
  temptation_count: (op, v) => (v === 0 && (op === '==' || op === '<=') ? 0.88 : 0.12),
  is_temptation: (op, v) => (v === 1 ? 0.12 : 0.88),
  activate_count_all: (op, v) => Math.max(0.2, 1 - v * 0.1),
  activate_count_heal: (op, v) => Math.max(0.15, 0.9 - v * 0.25),
  activate_count_start: (op, v) => Math.max(0.1, 0.85 - v * 0.22),
  activate_count_middle: (op, v) => Math.max(0.15, 0.9 - v * 0.2),
  activate_count_later_half: (op, v) => Math.max(0.15, 0.9 - v * 0.2),
  is_activate_any_skill: (op, v) => (v === 1 ? 0.92 : 0.08),
  order_rate_in20_continue: 0.5,
  order_rate_out40_continue: 0.5,
  is_lastspurt: (op, v) => (v === 1 ? 1 : 0.5),
  is_lastspurt_gap: 0.6,
  is_move_lane: 0.3,
  lane_type: 0.5,
  is_badstart: (op, v) => (v === 1 ? 0.05 : 0.95),
  popularity: 0.4,
  post_number: 0.4,
  accumulatetime: 0.97,
  order: 1,
  order_rate: 1,
};

const TERM_RE = /^([a-z_0-9]+)(>=|<=|==|!=|>|<)(-?\d+)$/;

/** Odds that one unmodelled term holds, read from its operator and value. */
function termOdds(raw) {
  const m = TERM_RE.exec(raw);
  if (!m) return 0.5;
  const entry = LIVE_ODDS[m[1]];
  if (entry == null) return 0.5;
  return typeof entry === 'function' ? entry(m[2], Number(m[3])) : entry;
}

const LIVE_LABEL = {
  blocked_front_continuetime: 'boxed in from the front',
  blocked_side_continuetime: 'boxed in on the side',
  blocked_all_continuetime: 'fully boxed in',
  infront_near_lane_time: 'a runner just ahead',
  is_behind_in: 'running behind others on the inside',
  near_count: 'runners packed around you',
  is_overtake: 'overtaking',
  overtake_target_time: 'chasing a target',
  change_order_onetime: 'a place changed hands',
  change_order_up_end_after: 'places passed',
  bashin_diff_infront: 'a gap to the runner ahead',
  bashin_diff_behind: 'a gap to the runner behind',
  distance_diff_top: 'a gap to the leader',
  distance_diff_rate: 'a share of the leader’s gap',
  distance_diff_top_float: 'a gap to the leader',
  hp_per: 'stamina left',
  temptation_count: 'a pace-up already happened',
  is_temptation: 'currently paced up',
  activate_count_heal: 'recovery skills already fired',
  activate_count_start: 'opening-leg skills already fired',
  activate_count_middle: 'middle-leg skills already fired',
  activate_count_later_half: 'second-half skills already fired',
  activate_count_all: 'other skills already fired',
  is_badstart: 'a poor start',
  popularity: 'a particular favourite ranking',
  post_number: 'a particular post',
};

/**
 * How much a metre gained at this point in the race is worth at the line.
 * Ground made up in the final leg sticks; ground made up early is partly given
 * back through pace and stamina.
 */
/**
 * How much a metre gained at this point in the race is worth at the line.
 *
 * Far less early than you would think, and the reason is position keep: for the
 * first two thirds of the race everyone behind the leader is actively holding a
 * slot, so ground you steal there is mostly handed back. Measured against the
 * simulator, an early speed skill keeps about half of its nominal value and a
 * last-spurt one keeps all of it.
 */
function positionWeight(fraction) {
  if (fraction < 1 / 6) return 0.45;
  if (fraction < 2 / 3) return 0.62;
  if (fraction < 5 / 6) return 0.96;
  return 1;
}

/** Marginal value of one stat point, in lengths, from the HP/speed model. */
function statValue(ctx, key) {
  const cache = ctx._statCache ?? (ctx._statCache = new Map());
  if (cache.has(key)) return cache.get(key);
  const step = 100;
  const base = ctx.sim ?? simulateRace(ctx);
  let v;
  if (key === 'wit') {
    // Wit buys activation rate, not speed: 100 more Wit lifts every Wit-checked
    // skill you carry. Priced against a typical five-skill Wit-checked load.
    const d = activationRate(ctx.stats.wit + step) - activationRate(ctx.stats.wit);
    v = d * 5 * 0.35;
  } else {
    const bumped = simulateRace({
      ...ctx, stats: { ...ctx.stats, [key]: ctx.stats[key] + step },
    });
    v = ((base.time - bumped.time) * base.speeds.spurt) / BASHIN;
  }
  const per = v / step;
  cache.set(key, per);
  return per;
}

/**
 * How much ground an extra `da` of acceleration is worth, given where on the
 * course the skill fires and for how long.
 *
 * This is the correction that reorders the whole table. Acceleration pays out
 * on the ramps — the gate, the phase steps, the top of a hill, and above all
 * the run-up into the last spurt — and pays nothing at all anywhere else.
 */
function accelValue(sim, da, ranges, durSec, random, at, zone = 0) {
  let total = 0;
  let hit = null;
  let best = 0;
  const window = ranges.reduce((n, [s, e]) => n + (e - s), 0);

  for (const ramp of sim.ramps) {
    const speed = ramp.to;
    // The stretch of track a trigger can sit on and still have the effect
    // running while the ramp is being climbed.
    const reachFrom = ramp.at - durSec * speed;
    const reachTo = ramp.at + ramp.seconds * speed;

    let p;
    if (random) {
      // Rolled trigger: the chance the roll lands inside the reaching stretch.
      let cover = 0;
      for (const [s, e] of ranges) {
        const lo = Math.max(s, reachFrom);
        const hi = Math.min(e, reachTo);
        if (hi > lo) cover += hi - lo;
      }
      p = window > 0 ? Math.min(1, cover / window) : 0;
    } else if (zone > 0) {
      // Fixed trigger, but gated on something live — it fires at the first
      // moment the condition holds, which is somewhere in the early part of the
      // eligible stretch rather than exactly at its first metre.
      const lo = Math.max(at, reachFrom);
      const hi = Math.min(at + zone, reachTo);
      p = hi > lo ? (hi - lo) / zone : 0;
    } else {
      // Fixed, ungated trigger: either the one point it fires at reaches the
      // ramp, or it does not. This is the test that stops a gate-ramp bonus
      // being handed to every skill whose condition has no geometry in it.
      p = at >= reachFrom && at <= reachTo ? 1 : 0;
    }
    if (p <= 0) continue;

    const saved = ramp.loss - rampLoss(ramp.from, ramp.to, ramp.a + da);
    const gain = saved * speed * p;
    total += gain;
    if (gain > best) { best = gain; hit = ramp.why; }
  }

  // Real races are never exactly at target speed — traffic, corners and lane
  // changes keep nibbling at it — so a little survives with no ramp in range.
  const residual = da * Math.min(durSec, 3) * 0.05;
  return { metres: total + residual, ramp: hit, offRamp: total <= 0 };
}

/** Expected ground a rival loses from a speed cut, per rival. */
function rivalSpeedLoss(value, durSec) {
  return Math.abs(value) * durSec;
}

/**
 * @returns {null|object} `null` when the skill cannot fire on this course with
 *   this running style, going, weather and season.
 */
export function scoreSkill(skill, ctx) {
  const { course, strategy, stats } = ctx;
  const sim = ctx.sim ?? simulateRace(ctx);
  const fieldStyles = ctx.fieldStyles ?? defaultFieldStyles(ctx.fieldSize ?? CM_FIELD_SIZE, strategy);
  const chosen = chooseAlternative(skill, ctx);
  if (!chosen) return null;
  const { alt } = chosen;
  // A unique is worth what your unique is worth, not what a level-1 one is.
  const levelScale = isUnique(skill) ? uniqueScale(ctx.uniqueLevel ?? 1) : 1;
  const variant = levelScale === 1 ? chosen.variant
    : { ...chosen.variant, effects: chosen.variant.effects.map((e) => ({ ...e, value: e.value * levelScale })) };

  const reasons = [];
  const d = course.distance;
  const window = rangeLength(alt.ranges);
  const at = alt.random
    ? alt.ranges.reduce((n, [s, e]) => n + ((s + e) / 2) * (e - s), 0) / window
    : alt.ranges[0][0];
  const fraction = at / d;
  const phase = phaseAt(d, at);
  const speedHere = at >= sim.spurtStart ? sim.speeds.spurt
    : phase >= 2 ? sim.speeds.v2 : phase === 1 ? sim.speeds.v1 : sim.speeds.v0;
  const secondsLeft = (d - at) / speedHere;

  // A fixed trigger with a live gate ("once a runner is just ahead", "after
  // two seconds of chasing") does not fire at the first metre of its stretch —
  // it fires somewhere in the early part of it.
  const gated = alt.liveKeys.some((k) => !k.startsWith('order'));
  const spanEnd = alt.ranges.length ? alt.ranges[alt.ranges.length - 1][1] : d;
  const fireZone = !alt.random && gated ? Math.min(spanEnd - at, Math.max(150, window * 0.3)) : 0;

  const nominal = variant.duration > 0 ? Math.max(0.1, variant.duration * (d / 1000)) : 0;
  const durSec = Math.min(nominal, secondsLeft);
  if (nominal > 0 && durSec < nominal - 0.05) {
    reasons.push(`only ${durSec.toFixed(1)}s of ${nominal.toFixed(1)}s fits before the line`);
  }

  let metres = 0;
  let rivalMetres = 0;
  const parts = {};
  const add = (key, m) => { if (m) { parts[key] = (parts[key] ?? 0) + m; metres += m; } };
  const addRival = (key, m) => { if (m) { parts[key] = (parts[key] ?? 0) + m; rivalMetres += m; } };

  const victims = rivalCount(skill, chosen, fieldStyles, strategy);

  for (const e of variant.effects) {
    const onSelf = e.target === 1;
    switch (e.key) {
      case 'target_speed': {
        // A target-speed bonus is not free: you have to accelerate up to it and
        // you give it back when it lapses, which costs roughly Δv/a seconds of
        // the window at both ends.
        const eff = effectiveSpeedSeconds(sim, e.value, durSec, at);
        if (onSelf) add('speed', e.value * eff);
        else addRival('debuff-speed', rivalSpeedLoss(e.value, eff) * victims.weight);
        break;
      }
      case 'current_speed':
      case 'current_speed_decel': {
        const eff = Math.max(durSec, 1);
        if (onSelf) add('speed', e.value * eff * 0.9);
        else addRival('debuff-speed', rivalSpeedLoss(e.value, eff) * 0.9 * victims.weight);
        break;
      }
      case 'accel': {
        if (onSelf) {
          const a = accelValue(sim, e.value, alt.ranges, durSec, alt.random, at, fireZone);
          add('accel', a.metres);
          if (a.ramp) reasons.push(`lands on the ramp ${a.ramp}`);
          else if (a.offRamp) reasons.push('no acceleration to gain here — already at target speed');
        } else {
          addRival('debuff-accel', Math.abs(e.value) * durSec * 0.5 * victims.weight);
        }
        break;
      }
      case 'recovery': {
        if (onSelf) {
          const recovered = (e.value / 100) * sim.maxHp;
          const extraSeconds = recovered / Math.max(0.1, sim.rates.spurt);
          const gain = extraSeconds * Math.max(0, sim.speeds.spurt - sim.speeds.v2);
          add('recovery', gain * sim.staminaPressure);
          if (sim.staminaPressure < 0.15 && e.value > 0) reasons.push('stamina already covered, so recovery scores low');
        } else {
          // Stamina taken off a rival only bites if that rival is tight — this
          // is why a lone drain debuff is weak and six of them are not.
          addRival('debuff-hp', Math.abs(e.value) * 0.045 * (d / 1000) * victims.weight);
        }
        break;
      }
      case 'speed': case 'stamina': case 'power': case 'guts': case 'wit': {
        const per = statValue(ctx, e.key);
        const lengths = per * e.value * (nominal > 0 ? Math.min(1, durSec / Math.max(1, sim.time)) : 1);
        if (onSelf) add('stat', lengths * BASHIN);
        else addRival('debuff-stat', Math.abs(lengths) * BASHIN * victims.weight);
        break;
      }
      case 'lane_move':
      case 'unblock': {
        // Getting out of traffic is only worth the time traffic was costing.
        const cost = blockingCost(sim, at, durSec);
        add('utility', cost);
        break;
      }
      case 'startdash':
        // A multiplier on the delay out of the gate: 0.4 is good, 1.5 is a
        // handicap. Worth (1 − factor) × the delay it scales.
        add('utility', (1 - e.value) * 0.025 * sim.speeds.v0);
        break;
      case 'hp_drain':
        add('recovery', -Math.abs(e.value) * 0.03 * (d / 1000) * sim.staminaPressure * 10);
        break;
      case 'activation':
        add('utility', e.value * 0.012 * (d / 1000));
        break;
      case 'opp_temptation':
        addRival('debuff-pace', 0.35 * (d / 1000) * victims.weight);
        break;
      case 'position_keep':
        add('utility', 0.25 * (d / 1000));
        break;
      case 'vision':
        add('utility', 0);
        break;
      default: break;
    }
  }

  const gross = metres + rivalMetres;
  if (Math.abs(gross) < 1e-6) return null;

  /* ---- how often does it actually happen ---- */
  const position = alt.position ?? {};
  const pPosition = positionProbability(position, strategy, fieldStyles, phase);
  if (pPosition < 0.999) {
    reasons.push(`position holds ${Math.round(pPosition * 100)}% of the time in this field`);
  }
  const pPre = chosen.pre && !chosen.pre.blocked
    ? chosen.pre.odds * positionProbability(chosen.pre.position ?? {}, strategy, fieldStyles, phase)
    : 1;
  if (pPre < 0.999) {
    reasons.push(`needs ${[chosen.pre.terms.join(', ') || 'its precondition'].join('')} first`);
  }
  const pWit = skill.wisdomCheck ? activationRate(stats.wit) : 1;
  if (pWit < 1) reasons.push(`Wit activation ${Math.round(pWit * 100)}%`);

  // Every term the closed form cannot check exactly gets its published odds,
  // and says so. `order` / `order_rate` are excluded: they are already priced
  // by the field model above, and charging for them twice would bury every
  // positional skill.
  let pOther = 1;
  const unmodelled = [];
  for (const g of [...alt.liveKeys, ...alt.guesses]) {
    const key = g.split(/[<>=!]/)[0];
    if (key === 'order' || key === 'order_rate') continue;
    const odds = termOdds(g);
    pOther *= odds;
    if (odds < 0.95 && LIVE_LABEL[key]) unmodelled.push(LIVE_LABEL[key]);
  }
  if (unmodelled.length) reasons.push(`needs ${[...new Set(unmodelled)].join(', ')}`);
  if (alt.random && window < d * 0.25) {
    reasons.push(`fires somewhere in ${Math.round(window)}m of eligible track`);
  }

  // A passive is not "gained at a point in the race" — it is a different race
  // from the gate onwards, and the stat difference already priced it over the
  // whole distance. Only timed effects get the where-in-the-race discount.
  const weight = nominal > 0 ? positionWeight(fraction) : 1;
  const probability = pPosition * pWit * pOther * pPre;
  const selfExpected = metres * weight * probability;
  const rivalExpected = rivalMetres * probability * 0.85;
  const expected = selfExpected + rivalExpected;

  return {
    metres,
    rivalMetres,
    bashin: expected / BASHIN,
    selfBashin: selfExpected / BASHIN,
    rivalBashin: rivalExpected / BASHIN,
    perSp: skill.cost ? (expected / BASHIN) / skill.cost * 100 : null,
    score: expected,
    probability,
    parts,
    reasons,
    levelScale,
    at,
    fraction,
    phase,
    durSec,
    nominal,
    window: { ranges: alt.ranges, length: window, centroid: at, share: window / d, random: alt.random },
    position,
    pPosition,
    pWit,
    pOther,
    pPre,
    weight,
    victims,
    debuff: rivalMetres !== 0,
    variant,
  };
}

/** How many rivals a non-self effect lands on, and how much that is worth. */
function rivalCount(skill, chosen, fieldStyles, strategy) {
  const target = skill.effects.find((e) => e.target !== 1)?.target;
  if (target == null) return { n: 0, weight: 0, label: 'self' };
  const kind = TARGET_KIND[target]?.key ?? 'nearby';
  const n = fieldStyles.length;
  let count;
  switch (kind) {
    case 'style': {
      const style = chosen.cond.targetStyle;
      count = style ? fieldStyles.filter((s) => s === style).length - (strategy === style ? 1 : 0) : n - 1;
      break;
    }
    case 'ahead': case 'ahead-near': count = Math.max(1, Math.round((n - 1) * 0.4)); break;
    case 'behind': count = Math.max(1, Math.round((n - 1) * 0.4)); break;
    default: count = Math.max(1, Math.round((n - 1) * 0.45));
  }
  // Only the rivals actually racing you for a place convert into positions.
  // Slowing the horse in front of you is worth far more than slowing the whole
  // field, and slowing the runners behind you is worth almost nothing.
  const PER_HEAD = { ahead: 0.30, 'ahead-near': 0.30, nearby: 0.22, style: 0.18, behind: 0.05 };
  const weight = Math.min(count, 4) * (PER_HEAD[kind] ?? 0.2);
  return { n: count, weight, label: TARGET_KIND[target]?.label ?? 'rivals', target, kind };
}

/** Seconds of traffic a skill in this window can undo, converted to metres. */
function blockingCost(sim, at, durSec) {
  // A boxed-in runner loses roughly 0.2 m/s, and traffic is only there part of
  // the time — so clearing it is worth a fraction of the window, not all of it.
  return 0.2 * Math.min(durSec, 3.5) * 0.35 * (at >= sim.spurtStart ? 1.3 : 1);
}

/**
 * Seconds of a speed bonus that actually turn into ground. Ramping up to the
 * higher target and dropping back off it eat the ends of the window.
 */
function effectiveSpeedSeconds(sim, delta, durSec, at) {
  const a = at >= (sim.spurtStart ?? Infinity) || at > 0 ? sim.accel.final : sim.accel.middle;
  const ramp = Math.abs(delta) / Math.max(0.05, a);
  return Math.max(durSec * 0.35, durSec - ramp);
}

export function defaultFieldStyles(fieldSize, yourStrategy) {
  // A neutral Champions Meeting field: two of each style, then yours.
  const out = [yourStrategy];
  const cycle = [1, 2, 3, 4];
  let i = 0;
  while (out.length < fieldSize) { out.push(cycle[i % 4]); i += 1; }
  return out;
}

export function rankSkills(skills, ctx, { tiers = null, limit = 0, filter = null } = {}) {
  const out = [];
  for (const s of skills) {
    if (s.inherited) continue;
    if (tiers && !tiers.includes(s.tier)) continue;
    if (filter && !filter(s)) continue;
    const r = scoreSkill(s, ctx);
    if (r) out.push({ skill: s, ...r });
  }
  out.sort((a, b) => b.score - a.score);
  return limit ? out.slice(0, limit) : out;
}

/* ------------------------------------------------------------- stat guidance */

/**
 * Marginal value of each stat, by finite difference on the model: how much
 * faster (in lengths at the finish) does +100 of a stat make you?
 */
export function statSensitivity(ctx, skills, step = 100) {
  const base = ctx.sim ?? simulateRace(ctx);
  const out = {};
  for (const key of ['speed', 'stamina', 'guts', 'power']) {
    const bumped = simulateRace({ ...ctx, stats: { ...ctx.stats, [key]: ctx.stats[key] + step } });
    const metres = (base.time - bumped.time) * base.speeds.spurt;
    out[key] = { bashin: metres / BASHIN, seconds: base.time - bumped.time, modelled: true };
  }
  // Wit buys activation, so it is measured against the skills that actually
  // roll for it — a top-12 list full of uniques (which never roll) would show
  // Wit as worth exactly nothing.
  const witPool = (skills ?? []).filter((s) => s.wisdomCheck && (s.tier === 'gold' || s.tier === 'normal'));
  const valueAt = (wit) => rankSkills(witPool, { ...ctx, sim: base, stats: { ...ctx.stats, wit }, _statCache: undefined }, { limit: 12 })
    .reduce((n, r) => n + r.bashin, 0);
  out.wit = { bashin: skills ? valueAt(ctx.stats.wit + step) - valueAt(ctx.stats.wit) : 0, modelled: true, viaSkills: true };
  return out;
}

// Ranges players converge on, scaled by the stat ceiling in play.
const STAT_BASELINE = {
  sprint: { speed: [1100, 1200], power: [1000, 1150], guts: [400, 600], wit: [800, 1000] },
  mile: { speed: [1100, 1200], power: [900, 1050], guts: [400, 600], wit: [800, 1000] },
  medium: { speed: [1050, 1200], power: [850, 1000], guts: [350, 550], wit: [800, 1000] },
  long: { speed: [1000, 1150], power: [800, 950], guts: [350, 500], wit: [800, 1000] },
};

export function statGuide(course, strategy, cap = 1200) {
  const key = ['', 'sprint', 'mile', 'medium', 'long'][course.distanceType] ?? 'medium';
  const base = STAT_BASELINE[key];
  const scale = Math.max(1, cap / 1200);
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(base)) out[k] = [Math.round(lo * scale), Math.round(hi * scale)];
  if (course.surface === 2) out.power = [Math.round(out.power[0] + 100 * scale), Math.round(out.power[1] + 150 * scale)];
  if (strategy === 1) out.guts = [Math.round(out.guts[0] + 100 * scale), Math.round(out.guts[1] + 150 * scale)];
  if (strategy === 4) out.power = [Math.round(out.power[0] + 50 * scale), Math.round(out.power[1] + 100 * scale)];
  return out;
}
