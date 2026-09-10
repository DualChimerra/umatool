// Tick-level race simulator for a full field.
//
// The analytic model in `model.mjs` answers "roughly how many lengths is this
// skill worth"; it has to, because it is asked that question about 600 skills
// every time a slider moves. This file answers the harder question — *what
// actually happens in the race* — by running the field forward at 1/15 s and
// letting the rules produce the outcome:
//
//   * every runner has its own stats, aptitudes, running style and skill list
//   * the running order is recomputed every tick, so `order` / `order_rate`
//     conditions are checked against a real position, not a prior distribution
//   * acceleration only converts into ground while you are below target speed,
//     which is the single biggest thing a closed-form score gets wrong
//   * debuffs are applied to the runners they actually target, and cost those
//     runners real time
//   * green skills are stat changes made before the gate opens
//
// What it does not model is listed in `LIMITATIONS` at the bottom and surfaced
// in the UI, because a simulator you cannot audit is just a longer opinion.

import { compile, phaseAt, guessProbability } from './conditions.mjs';

export const DT = 1 / 15;
export const BASHIN = 2.5;

/* ------------------------------------------------------------- coefficients */

export const STRATEGY_PHASE_COEF = {
  1: [1.0, 0.98, 0.962],
  2: [0.978, 0.991, 0.975],
  3: [0.938, 0.998, 0.994],
  4: [0.931, 1.0, 1.0],
};
export const STRATEGY_ACCEL_COEF = {
  1: [1.0, 1.0, 0.996],
  2: [0.985, 1.0, 0.996],
  3: [0.975, 1.0, 1.0],
  4: [0.945, 1.0, 0.997],
};
export const STRATEGY_HP_COEF = { 1: 0.95, 2: 0.89, 3: 1.0, 4: 0.995 };

// The going shifts the effective Speed and Power stats by a flat amount before
// anything else is computed. Indexed [surface][going], going 1..4 = Firm /
// Good / Soft / Heavy.
export const GROUND_HP = {
  1: { 1: 1.0, 2: 1.0, 3: 1.02, 4: 1.02 },
  2: { 1: 1.0, 2: 1.0, 3: 1.01, 4: 1.02 },
};
export const GROUND_SPEED = {
  1: { 1: 0, 2: 0, 3: 0, 4: -50 },
  2: { 1: 0, 2: 0, 3: 0, 4: -50 },
};
export const GROUND_POWER = {
  1: { 1: 0, 2: -50, 3: -50, 4: -50 },
  2: { 1: -100, 2: -50, 3: -100, 4: -100 },
};

/**
 * Aptitude multipliers, indexed by the grade the data stores (1 = G … 8 = S).
 *
 * Distance aptitude scales the Speed stat's contribution to target speed, and
 * separately scales acceleration. Surface aptitude scales acceleration. Style
 * aptitude scales Wit, which is what the skill activation roll is made against
 * — it is not an acceleration term, which is where this used to put it.
 */
export const APT_SPEED = { 8: 1.05, 7: 1.0, 6: 0.9, 5: 0.8, 4: 0.6, 3: 0.4, 2: 0.2, 1: 0.1 };
export const APT_ACCEL_DISTANCE = { 8: 1.0, 7: 1.0, 6: 1.0, 5: 1.0, 4: 1.0, 3: 0.6, 2: 0.5, 1: 0.4 };
export const APT_ACCEL_SURFACE = { 8: 1.05, 7: 1.0, 6: 0.9, 5: 0.8, 4: 0.7, 3: 0.5, 2: 0.3, 1: 0.1 };
export const APT_WIT_STYLE = { 8: 1.1, 7: 1.0, 6: 0.85, 5: 0.75, 4: 0.6, 3: 0.4, 2: 0.2, 1: 0.1 };

export const DEFAULT_APTITUDES = { distance: 7, surface: 7, style: 7 };
export const aptSpeed = (a) => APT_SPEED[a?.distance ?? 7] ?? 1;
export const aptAccel = (a) => (APT_ACCEL_DISTANCE[a?.distance ?? 7] ?? 1) * (APT_ACCEL_SURFACE[a?.surface ?? 7] ?? 1);
export const aptWit = (a) => APT_WIT_STYLE[a?.style ?? 7] ?? 1;

/**
 * Some courses award a flat Speed bonus for carrying stats above thresholds —
 * the course's "set status", which 67 of the 119 courses have. Each listed stat
 * contributes 5 % per full 300 points (counted up to 901), averaged over
 * however many stats the course lists.
 */
export function courseSpeedModifier(course, stats) {
  const list = course.courseSetStatus ?? [];
  if (!list.length) return 1;
  const byIndex = [0, stats.speed, stats.stamina, stats.power, stats.guts, stats.wit];
  const sum = list.reduce((n, stat) => n + (1 + Math.floor(Math.min(byIndex[stat] ?? 0, 901) / 300.01)) * 0.05, 0);
  return 1 + sum / list.length;
}

/** Stats as the race actually sees them: course bonus first, then the going. */
export function effectiveStats(stats, course, ground) {
  const surface = course.surface;
  return {
    ...stats,
    speed: Math.max(1, stats.speed * courseSpeedModifier(course, stats) + (GROUND_SPEED[surface]?.[ground] ?? 0)),
    power: Math.max(1, stats.power + (GROUND_POWER[surface]?.[ground] ?? 0)),
  };
}

/**
 * Target speed per phase, and the last spurt on top of it.
 *
 * The Speed stat only enters the *final* leg. The last spurt is then built on
 * the final-leg target, so the Speed term is counted twice — once inside the
 * ×1.05 and once again after it.
 */
export function raceSpeeds({ distance, speed, guts, strategy, aptitudes = DEFAULT_APTITUDES }) {
  const base = baseSpeed(distance);
  const coef = STRATEGY_PHASE_COEF[strategy] ?? STRATEGY_PHASE_COEF[2];
  const speedTerm = Math.sqrt(500 * speed) * aptSpeed(aptitudes) * 0.002;
  const v2 = base * coef[2] + speedTerm;
  return {
    base,
    v0: base * coef[0],
    v1: base * coef[1],
    v2,
    spurt: (v2 + 0.01 * base) * 1.05 + speedTerm + (450 * Math.max(1, guts)) ** 0.597 * 0.0001,
    min: base * 0.85 + Math.sqrt(200 * Math.max(1, guts)) * 0.001,
  };
}

/**
 * The last spurt is solved over the final leg minus a 60 m run-out: the game
 * works out where to start spurting so that it lasts to 60 m from the line, and
 * covers that tail at spurt speed regardless.
 */
export const SPURT_RUNOUT = 60;

const DECEL = [-1.2, -1.2, -0.8, -0.8];
const START_DASH_ACCEL = 24;
const UPHILL_BASE_ACCEL = 0.0004;
const FLAT_BASE_ACCEL = 0.0006;
// Time spent standing after the gate. `startdash` skills scale it.
const BASE_START_DELAY = 0.1;
const BAD_START_DELAY = 0.22;

// Downhill acceleration mode: rolled per second, Wit-driven.
const DOWNHILL_ENTER_PER_S = 0.0004;   // × Wit
const DOWNHILL_LEAVE_PER_S = 0.2;
const DOWNHILL_HP_FACTOR = 0.4;

// Pace-up (kakari): the classic 1/(log10(0.1·Wit+1)) curve, ~10 % at 1000 Wit.
export const temptationChance = (wit) => Math.min(0.6, (6.5 / Math.log10(0.1 * wit + 1)) ** 2 / 100);

// Being boxed in is the one thing a one-dimensional track cannot give you for
// free, so runners carry a lane coordinate in [0,1). Only runners whose lanes
// overlap can block each other, and a runner stuck behind one for longer than
// LANE_SWITCH_TIME pulls out — which is why blocking is common but brief.
const BLOCK_LENGTHS = 1.4;   // a runner this close ahead, in your lane, boxes you in
const NEAR_LENGTHS = 2.2;    // "a runner just ahead"
const CROWD_METRES = 6;      // radius for `near_count`
const LANE_WIDTH = 0.10;     // lanes closer than this overlap
const LANE_SWITCH_TIME = 0.7;
const LANE_SWITCH_COST = 0.06;  // m/s while pulling out

export const baseSpeed = (distance) => 20 - (distance - 2000) / 1000;

/* ----------------------------------------------------------------- rng */

const strHash = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

/**
 * Streams are keyed, not sequential. Two runs of the same race with one skill
 * added must differ *only* where that skill acts — if every later dice roll
 * shifted by one draw, the comparison would measure noise instead of the skill.
 * So every source of randomness gets its own stream, addressed by
 * (race seed, runner, purpose).
 */
export const streamSeed = (seed, runnerIdx, purpose) =>
  (Math.imul(seed >>> 0, 2654435761) ^ Math.imul(runnerIdx + 1, 40503) ^ strHash(purpose)) >>> 0;

/**
 * A random value addressed by (stream, index) rather than drawn in sequence.
 * Sequential draws are the enemy of a paired comparison: one extra draw and
 * every later roll in the race shifts, so a skill worth 0.01 lengths looks
 * like it is worth half a length of noise. Indexed rolls stay put.
 */
export function hashRand(stream, index) {
  let h = (stream ^ Math.imul(index + 1, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Deterministic PRNG so a run can be replayed and compared like-for-like. */
export function makeRng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/* -------------------------------------------------------- skill preparation */

// Which rivals a non-self effect lands on. The master data only gives a
// numeric target type, so the mapping is spelled out here and shown in the UI.
export const TARGET_KIND = {
  1: { key: 'self', label: 'self' },
  4: { key: 'ahead-near', label: 'the runners just ahead' },
  9: { key: 'ahead', label: 'runners ahead of you' },
  10: { key: 'nearby', label: 'runners around you' },
  18: { key: 'style', label: 'runners of one running style' },
  19: { key: 'behind', label: 'runners behind you' },
  20: { key: 'ahead', label: 'runners ahead of you' },
  21: { key: 'style', label: 'runners of one running style (pace-up)' },
  23: { key: 'nearby', label: 'runners around you' },
};

export const isDebuff = (skill) => skill.effects.some((e) => e.target !== 1);
export const isPassive = (skill) => skill.duration === 0
  && skill.effects.every((e) => e.target === 1)
  && skill.effects.some((e) => ['speed', 'stamina', 'power', 'guts', 'wit', 'startdash', 'hp_drain', 'vision'].includes(e.key));

/** Compile every variant of a skill against one course, once. */
const compileCache = new Map();
export function compileSkill(skill, course) {
  const key = `${skill.id}|${course.id}`;
  let hit = compileCache.get(key);
  if (hit) return hit;
  hit = {
    skill,
    variants: skill.variants.map((v) => ({
      variant: v,
      cond: compile(v.raw.condition, course),
      pre: v.raw.precondition ? compile(v.raw.precondition, course) : null,
    })),
  };
  compileCache.set(key, hit);
  return hit;
}

/* -------------------------------------------------------------- the runner */

/** Acceleration in m/s², the one place Power enters the model. */
export function accelRate(power, strategy, phaseIdx, aptitudes = DEFAULT_APTITUDES, uphill = false) {
  return (uphill ? UPHILL_BASE_ACCEL : FLAT_BASE_ACCEL) * Math.sqrt(500 * Math.max(1, power))
    * (STRATEGY_ACCEL_COEF[strategy] ?? STRATEGY_ACCEL_COEF[2])[phaseIdx]
    * aptAccel(aptitudes);
}

/**
 * @param {object} def  { id, name, strategy, stats, aptitudes, skills, player }
 */
export function prepareRunner(def, race, seed, index) {
  const { course, ground } = race;
  const d = course.distance;
  const rng = makeRng(streamSeed(seed, index, 'runner'));

  // Green skills are stat changes settled before the race, so they are folded
  // into the stat line here rather than during the run.
  const base = { ...def.stats };
  const stats = { ...def.stats };
  const passives = [];
  const timed = [];

  for (const skill of def.skills ?? []) {
    const c = compileSkill(skill, course);
    // One instance per runner: the compiled condition is shared and immutable,
    // the rolled trigger points and the "already fired" flag are not.
    if (isPassive(skill)) passives.push({ c, skill });
    // `armed` is the precondition latch. A skill written as "A => B" cannot
    // fire on B alone: A has to have been true at some point first, and until
    // it has, the skill is not in the race at all.
    else timed.push({ c, skill, rolls: null, done: false, armed: !c.pre });
  }

  const runner = {
    def,
    id: def.id,
    name: def.name,
    player: !!def.player,
    strategy: def.strategy,
    base,
    stats,
    aptitudes: def.aptitudes ?? { ...DEFAULT_APTITUDES },
    passives,
    timed,
    pos: 0,
    v: 3,
    hp: 0,
    maxHp: 0,
    finished: false,
    finishTime: 0,
    order: 1,
    orderRate: 100 / race.fieldSize,
    lastSpurt: false,
    spurtStart: Infinity,
    temptation: 0,
    temptationCount: 0,
    downhill: false,
    blockedFrontTime: 0,
    blockedSideTime: 0,
    nearFrontTime: 0,
    inTop20Time: 0,
    outTop40Time: 0,
    nearCount: 0,
    gapFront: 99,
    gapBehind: 99,
    gapToLeader: 0,
    gapRate: 0,
    overtaking: false,
    overtakeTime: 0,
    placesGained: 0,
    gainedPlace: false,
    lostPlace: false,
    prevOrder: 0,
    movingLane: false,
    laneType: 1,
    badStart: false,
    postNumber: def.postNumber ?? 1,
    popularity: def.popularity ?? 1,
    lane: 0,
    laneShiftUntil: -1,
    rngRace: rng,
    seedDown: streamSeed(seed, index, 'downhill'),
    seedLane: streamSeed(seed, index, 'lane'),
    laneSwitches: 0,
    startFactor: 1,
    startDelay: 0,
    delayLeft: 0,
    tick: 0,
    fired: { all: 0, heal: 0, opening: 0, middle: 0, lateHalf: 0 },
    active: [],
    log: [],
    trace: [],
    mods: { speed: 0, accel: 0, hpDrain: 0, unblockUntil: -1 },
    activationBonus: 0,
    t: 0,
  };

  // Front runners hug the rail, closers start wider — the usual shape of a
  // field, and it decides who ends up boxed in.
  const laneBias = { 1: 0.12, 2: 0.3, 3: 0.55, 4: 0.72 }[def.strategy] ?? 0.5;
  runner.lane = Math.min(0.98, Math.max(0, laneBias + (hashRand(runner.seedLane, 0) - 0.5) * 0.44));

  // Passives first — they change the stats every later formula reads.
  for (const { c, skill } of passives) {
    const v = pickVariant(c, race, runner);
    if (!v) continue;
    const own = skill.variants[c.variants.indexOf(v)] ?? v.variant;
    for (const e of own.effects) {
      if (e.target !== 1) continue;
      if (['speed', 'stamina', 'power', 'guts', 'wit'].includes(e.key)) stats[e.key] = Math.max(1, stats[e.key] + e.value);
      // `startdash` is a multiplier on the delay coming out of the gate:
      // Concentration is 0.4 (four tenths of the usual delay), Gatekept is 1.5.
      else if (e.key === 'startdash') runner.startFactor *= e.value;
      else if (e.key === 'hp_drain') runner.mods.hpDrain += e.value / 100;
    }
    runner.log.push({ at: 0, pos: 0, t: 0, skill, kind: 'passive' });
    runner.passiveApplied = (runner.passiveApplied ?? 0) + 1;
  }

  const hpCoef = STRATEGY_HP_COEF[def.strategy] ?? 1;
  // The going and the course bonus move Speed and Power, not Stamina, so the
  // raw stat is what pays for the HP pool.
  runner.maxHp = d + 0.8 * hpCoef * stats.stamina;
  runner.hp = runner.maxHp;
  runner.groundHp = GROUND_HP[course.surface]?.[ground] ?? 1;
  runner.eff = effectiveStats(stats, course, ground);
  runner.gutsMul = 1 + 200 / Math.sqrt(600 * Math.max(1, runner.eff.guts));
  runner.powerEff = runner.eff.power;
  runner.aptAccel = aptAccel(runner.aptitudes);
  runner.witEff = runner.eff.wit * aptWit(runner.aptitudes);

  runner.speeds = raceSpeeds({
    distance: d, speed: runner.eff.speed, guts: runner.eff.guts, strategy: def.strategy, aptitudes: runner.aptitudes,
  });

  // Roll the trigger point of every random-trigger skill, the way the game
  // does when the gate opens.
  for (const inst of timed) {
    const srng = makeRng(streamSeed(seed, index, `skill:${inst.skill.id}`));
    inst.rolls = inst.c.variants.map((v) => rollTrigger(v.cond, srng));
    inst.rng = srng;
    // The earliest metre the skill could possibly fire at, and the last. Most
    // skills are eligible on a short stretch of track, so checking these two
    // numbers first keeps the tick loop from evaluating conditions that cannot
    // hold yet — which is most of them, most of the time.
    let lo = Infinity;
    let hi = 0;
    inst.c.variants.forEach((v, vi) => {
      v.cond.alts.forEach((alt, ai) => {
        const roll = inst.rolls[vi][ai];
        if (!roll.ok || !roll.guess) return;
        lo = Math.min(lo, roll.at);
        for (const [, e] of alt.ranges) hi = Math.max(hi, e);
      });
    });
    inst.minAt = lo;
    inst.maxAt = hi || d;
    if (!Number.isFinite(lo)) inst.done = true;
  }

  const startRoll = hashRand(streamSeed(seed, index, 'start'), 0);
  runner.badStart = startRoll < 0.05 * runner.startFactor;
  runner.startDelay = (BASE_START_DELAY + (runner.badStart ? BAD_START_DELAY : 0)) * runner.startFactor;
  runner.delayLeft = runner.startDelay;

  return runner;
}

/** Pick the trigger position for one compiled alternative set. */
function rollTrigger(cond, rng) {
  return cond.alts.map((alt) => {
    const total = alt.ranges.reduce((n, [s, e]) => n + (e - s), 0);
    if (total <= 0) return { at: Infinity, ok: false, guess: 1 };
    let at = alt.ranges[0][0];
    if (alt.random) {
      let pick = rng() * total;
      for (const [s, e] of alt.ranges) {
        if (pick <= e - s) { at = s + pick; break; }
        pick -= e - s;
      }
    }
    return { at, ok: true, guess: alt.guesses.length ? (rng() < guessProbability(alt.guesses) ? 1 : 0) : 1 };
  });
}

function pickVariant(c, race, runner) {
  for (const v of c.variants) {
    for (const alt of v.cond.alts) if (alt.setup.every((fn) => fn(race, runner))) return v;
  }
  return null;
}

/* ------------------------------------------------------------- the race run */

function courseFlags(course) {
  const d = course.distance;
  const step = 1;                       // metre resolution is plenty
  const n = Math.ceil(d / step) + 2;
  const slope = new Float32Array(n);
  for (const s of course.slopes) {
    const a = Math.max(0, Math.floor(s.start));
    const b = Math.min(d, Math.ceil(s.start + s.length));
    for (let i = a; i < b; i += 1) slope[i] = s.slope / 10000;   // → percent
  }
  return { slope, n };
}

const flagCache = new Map();
const flagsFor = (course) => {
  let f = flagCache.get(course.id);
  if (!f) { f = courseFlags(course); flagCache.set(course.id, f); }
  return f;
};

/**
 * Run one race.
 * @returns {{order: runner[], runners: runner[], time: number}}
 */
export function runRace(setup, seed = 1, { trace = false, traceStep = 20 } = {}) {
  const { course, ground = 1, weather = 1, season = 1 } = setup;
  const d = course.distance;
  const flags = flagsFor(course);

  const styleCount = {};
  for (const r of setup.runners) styleCount[r.strategy] = (styleCount[r.strategy] ?? 0) + 1;

  const race = {
    course, ground, weather, season,
    fieldSize: setup.runners.length,
    styleCount,
    favouriteStyle: setup.runners[0]?.strategy ?? 0,
  };

  const runners = setup.runners.map((def, i) =>
    prepareRunner({ postNumber: i + 1, popularity: i + 1, ...def }, race, seed, i));

  // Last-spurt planning, recomputed when the final leg starts.
  const planSpurt = (r) => {
    const remain = d - r.pos;
    // The game solves the spurt so that it lasts to 60 m from the line and
    // covers that tail at spurt speed regardless, so the tail is not charged
    // for twice.
    const solved = Math.max(0, remain - SPURT_RUNOUT);
    const perMetre = (v) => ((20 * (v - r.speeds.base + 12) ** 2) / 144 * r.groundHp * r.gutsMul) / v;
    const cruise = perMetre(r.speeds.v2);
    const spurt = perMetre(r.speeds.spurt);
    const budget = r.hp;
    if (budget >= spurt * solved) { r.spurtStart = r.pos; return; }
    const x = (budget - cruise * solved) / Math.max(1e-6, spurt - cruise);
    r.spurtStart = d - Math.max(0, Math.min(remain, x + SPURT_RUNOUT));
  };

  let t = 0;
  let done = 0;
  const maxT = 400;
  const sorted = [...runners];
  const live = [];

  while (done < runners.length && t < maxT) {
    // ---- order and field geometry -------------------------------------
    live.length = 0;
    for (const r of runners) if (!r.finished) live.push(r);
    sorted.sort((a, b) => b.pos - a.pos);
    const leaderPos = sorted[0].pos;
    for (let i = 0; i < sorted.length; i += 1) {
      const r = sorted[i];
      r.prevOrder = r.order;
      r.order = i + 1;
      r.orderRate = (r.order / race.fieldSize) * 100;
      const ahead = sorted[i - 1];
      const behind = sorted[i + 1];
      r.gapFront = ahead ? (ahead.pos - r.pos) / BASHIN : 99;
      r.gapBehind = behind ? (r.pos - behind.pos) / BASHIN : 99;
      r.gapToLeader = (leaderPos - r.pos) / BASHIN;
      r.gapRate = leaderPos > 0 ? ((leaderPos - r.pos) / leaderPos) * 100 : 0;
      let near = 0;
      for (const o of sorted) if (o !== r && Math.abs(o.pos - r.pos) <= CROWD_METRES) near += 1;
      r.nearCount = near;
      if (r.prevOrder && r.order < r.prevOrder) { r.gainedPlace = true; r.placesGained += r.prevOrder - r.order; }
      if (r.prevOrder && r.order > r.prevOrder) r.lostPlace = true;
    }

    for (const r of live) {
      r.t = t;
      // Time still owed to the gate. Charged as a fraction of the tick rather
      // than whole skipped ticks, so a start skill worth six hundredths of a
      // second is worth six hundredths of a second and not nothing.
      const dt = DT - Math.min(DT, r.delayLeft);
      r.delayLeft = Math.max(0, r.delayLeft - DT);
      if (dt <= 0) continue;
      const phase = phaseAt(d, r.pos);
      const pi = Math.min(2, phase);

      // ---- crowding / blocking ---------------------------------------
      let blocker = null;
      let blockerGap = Infinity;
      let nearAhead = false;
      for (const o of sorted) {
        if (o === r || o.finished) continue;
        const gap = (o.pos - r.pos) / BASHIN;
        if (gap <= 0 || gap > NEAR_LENGTHS) continue;
        if (Math.abs(o.lane - r.lane) > LANE_WIDTH) continue;
        nearAhead = true;
        if (gap <= BLOCK_LENGTHS && gap < blockerGap) { blocker = o; blockerGap = gap; }
      }
      const unblocked = t <= r.mods.unblockUntil || t <= r.laneShiftUntil;
      // Graded, not binary: the closer the runner ahead, the more of your
      // target speed it eats. A hard on/off switch would make the whole race
      // hinge on a centimetre, and every measurement after it noise.
      const crowding = blocker && !unblocked ? Math.max(0, 1 - blockerGap / BLOCK_LENGTHS) : 0;
      const boxed = crowding > 0.45;
      r.nearFrontTime = nearAhead ? r.nearFrontTime + DT : 0;
      r.blockedFrontTime = boxed ? r.blockedFrontTime + DT : 0;
      r.blockedSideTime = r.nearCount >= 3 && boxed ? r.blockedSideTime + DT : 0;
      // Stuck long enough and the runner pulls out into clear air, which costs
      // a little speed but ends the block.
      if (r.blockedFrontTime >= LANE_SWITCH_TIME) {
        r.laneSwitches += 1;
        const dir = hashRand(r.seedLane, r.laneSwitches) < 0.75 ? 1 : -1;
        r.lane = Math.min(0.99, Math.max(0.01, r.lane + dir * (LANE_WIDTH * 1.6)));
        r.laneShiftUntil = t + 0.8;
        r.movingLane = true;
        r.blockedFrontTime = 0;
      } else r.movingLane = t < r.laneShiftUntil;
      if (r.orderRate <= 20) r.inTop20Time += DT; else r.inTop20Time = 0;
      if (r.orderRate > 40) r.outTop40Time += DT; else r.outTop40Time = 0;
      r.overtaking = r.gapFront < 3 && r.v > (r.speeds.v2);
      r.overtakeTime = r.overtaking ? r.overtakeTime + DT : 0;

      // ---- last spurt -------------------------------------------------
      if (!r.spurtPlanned && r.pos >= (d * 2) / 3) { planSpurt(r); r.spurtPlanned = true; }
      r.lastSpurt = r.pos >= r.spurtStart;

      // ---- pace-up (kakari) -------------------------------------------
      if (!r.temptationRolled && phase >= 1) {
        r.temptationRolled = true;
        if (r.rngRace() < temptationChance(r.witEff)) {
          r.temptation = 3 + r.rngRace() * 9;
          r.temptationCount += 1;
        }
      }
      if (r.temptation > 0) r.temptation -= DT;

      // ---- downhill mode ----------------------------------------------
      const slope = flags.slope[Math.min(flags.n - 1, Math.floor(r.pos))] ?? 0;
      if (slope < -0.01) {
        const roll = hashRand(r.seedDown, Math.floor(r.pos));
        if (!r.downhill && roll < DOWNHILL_ENTER_PER_S * r.witEff * DT) r.downhill = true;
        else if (r.downhill && roll > 1 - DOWNHILL_LEAVE_PER_S * DT) r.downhill = false;
      } else r.downhill = false;

      // ---- skills ------------------------------------------------------
      tickSkills(r, race, runners, sorted, t, phase);

      // ---- speed --------------------------------------------------------
      let target = r.lastSpurt ? r.speeds.spurt
        : pi === 2 ? r.speeds.v2
          : pi === 1 ? r.speeds.v1 : r.speeds.v0;

      // Position keep, active until two thirds of the race. It is why a front
      // runner still leads at the final corner despite having the lowest target
      // speed in the field by then: everyone behind is holding station rather
      // than racing. It is a mode a runner drops in and out of, though, not a
      // servo — left on permanently it erases everything that happens before
      // the final leg, and a bad start or an early debuff would cost nothing.
      if (phase <= 1 && (r.strategy === 1
        || hashRand(r.seedLane, 500 + Math.floor(r.pos / 60)) < KEEP_DUTY)) {
        target *= positionKeep(r);
      }

      if (slope > 0.01) target -= (slope * 200) / r.powerEff;
      if (r.downhill) target += 0.3 + slope * -1 * 0.1;
      if (r.temptation > 0) target *= 1.04;
      target += r.mods.speed;
      if (r.hp <= 0) target = Math.min(target, r.speeds.min);
      // On the run to the line the field fans out, so traffic bites less.
      if (crowding > 0) target -= crowding * (r.lastSpurt ? 0.5 : 1) * Math.max(0, target - blocker.v);
      if (r.movingLane) target -= LANE_SWITCH_COST;
      target = Math.max(target, r.speeds.min * (r.hp <= 0 ? 1 : 0.8));

      // Acceleration only exists while the runner is below target speed. Above
      // it, the runner coasts down at the phase's deceleration rate. Clamping
      // is done against the direction of travel rather than the sign of `a`,
      // so an acceleration debuff cannot flip a runner into speeding up.
      const rising = r.v < target;
      let a;
      if (rising) {
        // Climbing costs acceleration as well as target speed: the base term
        // drops from 0.0006 to 0.0004 while on an uphill.
        a = accelRate(r.powerEff, r.strategy, pi, r.aptitudes, slope > 0.01) + r.mods.accel;
        if (r.v < 0.85 * r.speeds.base) a += START_DASH_ACCEL;
        a = Math.max(0.02, a);
      } else {
        a = DECEL[phase];
      }
      r.v = Math.max(0.5, r.v + a * dt);
      r.v = rising ? Math.min(r.v, target) : Math.max(r.v, target);

      // ---- HP -------------------------------------------------------------
      let drain = (20 * (r.v - r.speeds.base + 12) ** 2) / 144 * r.groundHp;
      if (phase >= 2) drain *= r.gutsMul;
      if (r.downhill) drain *= DOWNHILL_HP_FACTOR;
      if (r.temptation > 0) drain *= 1.6;
      drain += r.mods.hpDrain * r.maxHp / 100;
      r.hp = Math.max(0, r.hp - drain * dt);

      r.pos += r.v * dt;
      if (trace && r.pos - (r.lastTrace ?? -1e9) >= traceStep) {
        r.lastTrace = r.pos;
        r.trace.push({
          pos: r.pos, t, v: r.v, hp: r.hp / r.maxHp, order: r.order,
          gap: r.gapToLeader, spurt: r.lastSpurt ? 1 : 0, down: r.downhill ? 1 : 0,
          block: crowding,
        });
      }
      if (r.pos >= d) {
        r.finished = true;
        r.finishTime = t + (d - (r.pos - r.v * dt)) / r.v;
        done += 1;
      }
      r.gainedPlace = false;
      r.lostPlace = false;
    }
    t += DT;
  }

  for (const r of runners) if (!r.finished) { r.finishTime = maxT; r.hpOut = true; }
  const order = [...runners].sort((a, b) => a.finishTime - b.finishTime || b.pos - a.pos);
  order.forEach((r, i) => { r.place = i + 1; });
  return { order, runners, time: order[0].finishTime };
}

// The slot each running style tries to hold, in lengths behind the leader,
// while position keep is active.
const KEEP_BAND = { 2: [1.2, 3], 3: [4, 6.5], 4: [5.5, 8.5] };
const KEEP_DUTY = 0.55;   // share of the first two thirds spent holding station

/** Holding station through the first two thirds of the race. */
function positionKeep(r) {
  if (r.strategy === 1) {
    // Front runners contest the lead, then ease once clear of the next runner.
    if (r.order !== 1) return 1.04;
    return r.gapBehind > 5 ? 0.995 : 1;
  }
  const [lo, hi] = KEEP_BAND[r.strategy] ?? [3, 6.5];
  if (r.gapToLeader > hi) return 1.03;
  if (r.gapToLeader < lo) return 0.985;
  return 1;
}

/* ------------------------------------------------------------ skill engine */

function tickSkills(r, race, runners, sorted, t, phase) {
  // Expire what is running.
  if (r.active.length) {
    let changed = false;
    for (const a of r.active) if (t >= a.until) { changed = true; }
    if (changed) {
      r.active = r.active.filter((a) => t < a.until);
      recomputeMods(r, t);
    }
  }

  for (const inst of r.timed) {
    if (inst.done) continue;
    if (!inst.armed && !(inst.armed = holds(inst.c.pre, race, r))) continue;
    if (r.pos < inst.minAt) continue;
    if (r.pos > inst.maxAt) { inst.done = true; continue; }
    const c = inst.c;
    for (let vi = 0; vi < c.variants.length; vi += 1) {
      const { cond } = c.variants[vi];
      const rolls = inst.rolls[vi];
      let hit = -1;
      for (let ai = 0; ai < cond.alts.length; ai += 1) {
        const alt = cond.alts[ai];
        const roll = rolls[ai];
        if (!roll.ok || !roll.guess) continue;
        if (r.pos < roll.at) continue;
        if (!alt.setup.every((fn) => fn(race, r))) continue;
        if (!alt.live.every((fn) => fn(r))) continue;
        // A non-random trigger must also still be inside its eligible stretch.
        if (!alt.random && !alt.ranges.some(([s, e]) => r.pos >= s && r.pos <= e)) continue;
        hit = ai;
        break;
      }
      if (hit < 0) continue;

      // Wit roll, once, at the moment the condition first holds.
      if (inst.skill.wisdomCheck) {
        // Style aptitude scales the Wit the roll is made against.
        const rate = Math.min(1, Math.max(0.2, (100 - 9000 / Math.max(1, r.witEff)) / 100)) + r.activationBonus;
        if (inst.rng() > rate) { inst.done = true; break; }
      }
      // the instance's own skill, so a level-scaled unique keeps its numbers
      fire(inst, inst.skill.variants[vi] ?? c.variants[vi].variant, r, race, runners, sorted, t);
      inst.done = true;
      break;
    }
  }
}

/** Does any alternative of a compiled expression hold right now? */
function holds(cond, race, r) {
  if (!cond) return true;
  for (const alt of cond.alts) {
    if (!alt.setup.every((fn) => fn(race, r))) continue;
    if (!alt.live.every((fn) => fn(r))) continue;
    if (alt.ranges.length && !alt.ranges.some(([s, e]) => r.pos >= s && r.pos <= e)) continue;
    return true;
  }
  return false;
}

function fire(inst, variant, r, race, runners, sorted, t) {
  const c = inst.c;
  const d = race.course.distance;
  const seconds = variant.duration > 0 ? variant.duration * (d / 1000) : 0;
  const until = t + seconds;
  r.fired.all += 1;
  const phase = phaseAt(d, r.pos);
  if (phase === 0) r.fired.opening += 1;
  if (phase === 1) r.fired.middle += 1;
  if (phase >= 2) r.fired.lateHalf += 1;
  if (variant.effects.some((e) => e.key === 'recovery' && e.value > 0 && e.target === 1)) r.fired.heal += 1;
  r.log.push({ at: r.pos, pos: r.pos, t, skill: inst.skill, seconds });

  const touched = new Set();
  for (const e of variant.effects) {
    const victims = e.target === 1 ? [r] : resolveTargets(e, c, r, race, runners, sorted);
    for (const v of victims) { applyEffect(v, e, until, t, r === v); touched.add(v); }
  }
  recomputeMods(r, t);
  for (const v of touched) if (v !== r) recomputeMods(v, t);
}

/** Who a non-self effect lands on. */
function resolveTargets(e, c, r, race, runners, sorted) {
  const kind = TARGET_KIND[e.target]?.key ?? 'nearby';
  const others = runners.filter((o) => o !== r && !o.finished);
  switch (kind) {
    case 'style': {
      const style = c.variants.map((v) => v.cond.targetStyle).find(Boolean);
      return style ? others.filter((o) => o.strategy === style) : others;
    }
    case 'ahead': return others.filter((o) => o.pos > r.pos);
    case 'ahead-near': return others.filter((o) => o.pos > r.pos && o.pos - r.pos < 12);
    case 'behind': return others.filter((o) => o.pos < r.pos);
    case 'nearby': return others.filter((o) => Math.abs(o.pos - r.pos) < 15);
    default: return others;
  }
}

function applyEffect(target, e, until, t, onSelf) {
  switch (e.key) {
    case 'target_speed':
      target.active.push({ key: 'speed', value: e.value, until });
      break;
    case 'current_speed':
    case 'current_speed_decel':
      // A current-speed effect moves the runner's speed now and holds the
      // offset while it lasts; a zero-duration one is a pure kick.
      target.v = Math.max(0.5, target.v + e.value);
      if (until > t) target.active.push({ key: 'speed', value: e.value, until });
      break;
    case 'accel':
      target.active.push({ key: 'accel', value: e.value, until });
      break;
    case 'recovery':
      target.hp = Math.max(0, Math.min(target.maxHp, target.hp + (e.value / 100) * target.maxHp));
      break;
    case 'hp_drain':
      target.active.push({ key: 'hpDrain', value: e.value, until });
      break;
    case 'lane_move':
    case 'unblock':
      target.mods.unblockUntil = Math.max(target.mods.unblockUntil, until);
      break;
    case 'activation':
      target.activationBonus += e.value / 100;
      break;
    case 'opp_temptation':
      if (!onSelf && !target.temptation) { target.temptation = 3 + 6 * 0.5; target.temptationCount += 1; }
      break;
    case 'speed': case 'stamina': case 'power': case 'guts': case 'wit':
      // Mid-race stat changes are rare; treat them as a speed nudge so they
      // are not silently dropped.
      target.active.push({ key: 'speed', value: e.value * 0.0005, until });
      break;
    default: break;
  }
}

function recomputeMods(r, t) {
  let speed = 0; let accel = 0; let hpDrain = 0;
  for (const a of r.active) {
    if (t >= a.until) continue;
    if (a.key === 'speed') speed += a.value;
    else if (a.key === 'accel') accel += a.value;
    else if (a.key === 'hpDrain') hpDrain += a.value;
  }
  r.mods.speed = speed;
  r.mods.accel = accel;
  r.mods.hpDrain = hpDrain + (r.def.passiveDrain ?? 0);
}

/* ------------------------------------------------------------- monte carlo */

/**
 * Repeat a race and summarise it.
 * @returns per-runner win rate, place distribution, mean time and margin.
 */
export function monteCarlo(setup, runs = 200, seed0 = 12345) {
  const n = setup.runners.length;
  const stat = setup.runners.map((r) => ({
    def: r,
    name: r.name,
    wins: 0,
    top2: 0,
    top3: 0,
    places: new Array(n).fill(0),
    time: 0,
    timeSq: 0,
    margin: 0,
    spurt: 0,
    hpLeft: 0,
    outOfHp: 0,
  }));

  for (let i = 0; i < runs; i += 1) {
    const { order, runners } = runRace(setup, seed0 + i * 7919);
    const winnerTime = order[0].finishTime;
    for (let k = 0; k < runners.length; k += 1) {
      const r = runners[k];
      const s = stat[k];
      s.places[r.place - 1] += 1;
      if (r.place === 1) s.wins += 1;
      if (r.place <= 2) s.top2 += 1;
      if (r.place <= 3) s.top3 += 1;
      s.time += r.finishTime;
      s.timeSq += r.finishTime * r.finishTime;
      s.margin += (r.finishTime - winnerTime) * r.speeds.spurt / BASHIN;
      s.spurt += Math.min(1, (setup.course.distance - r.spurtStart) / (setup.course.distance / 3));
      s.hpLeft += r.hp;
      if (r.hpOut || r.hp <= 0) s.outOfHp += 1;
    }
  }

  for (const s of stat) {
    s.winRate = s.wins / runs;
    s.top2Rate = s.top2 / runs;
    s.top3Rate = s.top3 / runs;
    s.meanTime = s.time / runs;
    s.sdTime = Math.sqrt(Math.max(0, s.timeSq / runs - s.meanTime ** 2));
    s.meanMargin = s.margin / runs;
    s.meanSpurt = s.spurt / runs;
    s.meanHpLeft = s.hpLeft / runs;
    s.outOfHpRate = s.outOfHp / runs;
    s.placeRates = s.places.map((c) => c / runs);
  }
  return { runs, stat };
}

/**
 * Aggregate a field of runs into the two numbers that decide a Champions
 * Meeting: how far ahead of the field you finish, and how often you win.
 *
 * `margin` is measured against the field rather than against the clock, which
 * is the only way a debuff can score at all — slowing three rivals does not
 * make you one metre faster, it moves them behind you.
 */
function summarise(setup, runnerIndex, runs, seed0) {
  const mc = monteCarlo(setup, runs, seed0);
  const me = mc.stat[runnerIndex];
  const d = setup.course.distance;
  let rivalTime = 0;
  let n = 0;
  for (let i = 0; i < mc.stat.length; i += 1) {
    if (i === runnerIndex) continue;
    rivalTime += mc.stat[i].meanTime;
    n += 1;
  }
  const speed = d / Math.max(1, me.meanTime);
  return {
    me,
    all: mc.stat,
    meanTime: me.meanTime,
    rivalMean: n ? rivalTime / n : me.meanTime,
    lead: ((n ? rivalTime / n : me.meanTime) - me.meanTime) * speed / BASHIN,
    speed,
  };
}

/**
 * What one skill is worth to one runner, measured the only way that cannot be
 * argued with: run the field with it and without it, on the same seeds.
 *
 * Because every dice roll lives in its own keyed stream, removing the skill
 * perturbs nothing else — the two runs stay paired, and the difference is the
 * skill rather than the weather.
 */
export function skillDelta(setup, runnerIndex, skill, runs = 48, seed0 = 4242) {
  const strip = (r) => (r.skills ?? []).filter((s) => s.id !== skill.id);
  const withOut = {
    ...setup,
    runners: setup.runners.map((r, i) => (i === runnerIndex ? { ...r, skills: strip(r) } : r)),
  };
  const withIn = {
    ...setup,
    runners: setup.runners.map((r, i) => (i === runnerIndex ? { ...r, skills: [...strip(r), skill] } : r)),
  };
  const a = summarise(withOut, runnerIndex, runs, seed0);
  const b = summarise(withIn, runnerIndex, runs, seed0);
  return {
    // Ground gained on the field: self-buffs move your own time, debuffs move
    // theirs, and both land in the same currency.
    bashin: b.lead - a.lead,
    selfBashin: (a.meanTime - b.meanTime) * a.speed / BASHIN,
    rivalBashin: (b.rivalMean - a.rivalMean) * a.speed / BASHIN,
    seconds: a.meanTime - b.meanTime,
    winRate: b.me.winRate - a.me.winRate,
    top3: b.me.top3Rate - a.me.top3Rate,
    before: a.me,
    after: b.me,
    runs,
  };
}

/** Baseline for a field, plus the two rates the UI leads with. */
export function evaluateField(setup, runnerIndex, runs = 200, seed0 = 4242) {
  return summarise(setup, runnerIndex, runs, seed0);
}

/**
 * Measure a list of skills against one field, sharing the baseline.
 *
 * Doing this one skill at a time would run the reference race once per skill.
 * The reference only changes for a skill the runner already carries — there the
 * comparison is kit vs kit-minus-one — so everything else is measured against a
 * single shared baseline and the work roughly halves.
 *
 * `onStep` is called after each skill so a caller can yield to the UI.
 */
export function* skillDeltaBatch(setup, runnerIndex, skills, runs = 60, seed0 = 4242) {
  const kit = setup.runners[runnerIndex].skills ?? [];
  const has = new Set(kit.map((s) => s.id));
  const withKit = summarise(setup, runnerIndex, runs, seed0);
  const swap = (list) => ({
    ...setup,
    runners: setup.runners.map((r, i) => (i === runnerIndex ? { ...r, skills: list } : r)),
  });

  for (const skill of skills) {
    const carried = has.has(skill.id);
    const other = summarise(
      swap(carried ? kit.filter((s) => s.id !== skill.id) : [...kit, skill]),
      runnerIndex, runs, seed0,
    );
    const a = carried ? other : withKit;   // without the skill
    const b = carried ? withKit : other;   // with it
    yield {
      skill,
      carried,
      bashin: b.lead - a.lead,
      selfBashin: (a.meanTime - b.meanTime) * a.speed / BASHIN,
      rivalBashin: (b.rivalMean - a.rivalMean) * a.speed / BASHIN,
      winRate: b.me.winRate - a.me.winRate,
      top3: b.me.top3Rate - a.me.top3Rate,
      runs,
    };
  }
}

export const LIMITATIONS = [
  'Lanes are one-dimensional: being boxed in is derived from the gap to the runner ahead and how many runners are within 6 m, not from a real lane grid.',
  'Skill activation order inside a single tick is list order, not the game’s internal priority.',
  'Position keep in the opening leg is a gentle nudge per running style, not the full four-mode state machine.',
  'Pace-up (kakari) uses the community 1/log₁₀(0.1·Wit+1) curve for the chance and a flat 1.04 speed / 1.6 drain while it lasts.',
  'Downhill acceleration mode is rolled from Wit at 0.04 %·Wit per tick-second, leaving at 20 % per second.',
  'Conditions the model has no state for (post number, favourite, lane side) are rolled once per race at a fixed probability and listed on the skill.',
];
