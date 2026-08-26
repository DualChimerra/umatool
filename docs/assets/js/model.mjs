// Race model and skill valuation.
//
// Three layers, each usable on its own:
//
//   1. `simulateRace` — HP / speed model. Base speed from the distance,
//      per-phase target speeds from the running style, last-spurt speed from
//      Speed and Guts, HP drain of 20·(v − base + 12)²/144 per second with the
//      Guts multiplier in the final leg. No rivals, no positioning: it answers
//      "can I run my own race to the line", which is what Stamina planning is.
//
//   2. Position model — Champions Meeting runs **9 umamusume**, so `order_rate`
//      is quantised in steps of 1/9 ≈ 11.1%. Each running style gets a
//      distribution over finishing-order slots, and a skill's positional
//      condition turns into an actual probability instead of a fudge factor.
//
//   3. `scoreSkill` — expected lengths gained. It works out *where on this
//      course* the skill can fire, how long the effect can still run from
//      there, the chance the position condition holds, and the Wit activation
//      roll. Every one of those is reported back so the number can be audited.

export const BASHIN = 2.5;          // metres in one length
export const CM_FIELD_SIZE = 9;     // Champions Meeting field

export const STRATEGY = {
  1: { key: 'front', name: 'Front Runner', short: 'Front' },
  2: { key: 'pace', name: 'Pace Chaser', short: 'Pace' },
  3: { key: 'late', name: 'Late Surger', short: 'Late' },
  4: { key: 'end', name: 'End Closer', short: 'End' },
};

const HP_COEF = { 1: 0.95, 2: 0.89, 3: 1.0, 4: 0.995 };
const SPEED_COEF = {
  1: [1.0, 0.98, 0.962],
  2: [0.978, 0.991, 0.975],
  3: [0.938, 0.998, 0.994],
  4: [0.931, 1.0, 1.0],
};
const GROUND_HP = {
  1: { 1: 1.0, 2: 1.0, 3: 1.02, 4: 1.02 },
  2: { 1: 1.0, 2: 1.0, 3: 1.01, 4: 1.02 },
};

// Per-phase acceleration coefficients.
const ACCEL_COEF = {
  1: [1.0, 1.0, 0.996],
  2: [0.985, 1.0, 0.996],
  3: [0.975, 1.0, 1.0],
  4: [0.945, 1.0, 0.997],
};

// The going shifts the effective Speed and Power stats by a flat amount before
// anything else is computed. Both tables are indexed [surface][going] with
// going 1..4 = Firm / Good / Soft / Heavy.
const GROUND_SPEED = {
  1: { 1: 0, 2: 0, 3: 0, 4: -50 },
  2: { 1: 0, 2: 0, 3: 0, 4: -50 },
};
const GROUND_POWER = {
  1: { 1: 0, 2: -50, 3: -50, 4: -50 },
  2: { 1: -100, 2: -50, 3: -100, 4: -100 },
};

/**
 * Aptitude multipliers, indexed by the grade value the data stores (1 = G …
 * 8 = S), so the tables read in the same direction as the game's own letters.
 *
 * Distance aptitude scales the Speed stat's contribution to target speed, and
 * separately scales acceleration. Surface aptitude scales acceleration. Style
 * aptitude scales Wit, which is what the skill activation roll is made against.
 */
const APT_SPEED = { 8: 1.05, 7: 1.0, 6: 0.9, 5: 0.8, 4: 0.6, 3: 0.4, 2: 0.2, 1: 0.1 };
const APT_ACCEL_DISTANCE = { 8: 1.0, 7: 1.0, 6: 1.0, 5: 1.0, 4: 1.0, 3: 0.6, 2: 0.5, 1: 0.4 };
const APT_ACCEL_SURFACE = { 8: 1.05, 7: 1.0, 6: 0.9, 5: 0.8, 4: 0.7, 3: 0.5, 2: 0.3, 1: 0.1 };
const APT_WIT_STYLE = { 8: 1.1, 7: 1.0, 6: 0.85, 5: 0.75, 4: 0.6, 3: 0.4, 2: 0.2, 1: 0.1 };

// A missing aptitude is treated as A, which is what a planned Champions Meeting
// runner is assumed to have unless the Team page says otherwise.
const DEFAULT_APTITUDES = { distance: 7, surface: 7, style: 7 };
const aptSpeed = (a) => APT_SPEED[a?.distance ?? 7] ?? 1;
const aptAccel = (a) => (APT_ACCEL_DISTANCE[a?.distance ?? 7] ?? 1) * (APT_ACCEL_SURFACE[a?.surface ?? 7] ?? 1);
export const aptWit = (a) => APT_WIT_STYLE[a?.style ?? 7] ?? 1;

// The opening dash adds a large flat bonus until ~85% of the opening target
// speed is reached, which is why the start is over in about a second.
const START_DASH_ACCEL = 24;
const UPHILL_BASE_ACCEL = 0.0004;
const FLAT_BASE_ACCEL = 0.0006;

/**
 * Some courses award a flat speed bonus for having stats above thresholds — the
 * course's "set status". Each listed stat contributes 5% per full 300 points
 * (counted up to 901), averaged over however many stats the course lists.
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

/** Acceleration in m/s², the one place Power enters the model. */
export function accelRate(power, strategy, phaseIdx, aptitudes = DEFAULT_APTITUDES, uphill = false) {
  const base = uphill ? UPHILL_BASE_ACCEL : FLAT_BASE_ACCEL;
  return base * Math.sqrt(500 * Math.max(1, power))
    * (ACCEL_COEF[strategy] ?? ACCEL_COEF[2])[phaseIdx]
    * aptAccel(aptitudes);
}

/**
 * Seconds lost ramping from `from` to `to` at rate `a`, compared with an
 * instant change. Distance covered while accelerating is (v²−u²)/2a, so the
 * penalty is (v−u)² / (2·a·v).
 */
const rampLoss = (from, to, a) => (to <= from ? 0 : (to - from) ** 2 / (2 * a * to));

/**
 * Where each style sits, as bands over the field expressed in fractions of the
 * field from the front. Discretised onto the actual field size at run time, so
 * the same table works for a 9-runner Champions Meeting and an 18-runner race.
 */
const POSITION_BANDS = {
  1: [[0.00, 0.12, 0.55], [0.12, 0.24, 0.30], [0.24, 0.36, 0.15]],
  2: [[0.12, 0.24, 0.20], [0.24, 0.36, 0.30], [0.36, 0.50, 0.30], [0.50, 0.62, 0.20]],
  3: [[0.36, 0.50, 0.15], [0.50, 0.62, 0.25], [0.62, 0.74, 0.25], [0.74, 0.86, 0.20], [0.86, 1.00, 0.15]],
  4: [[0.56, 0.68, 0.15], [0.68, 0.80, 0.25], [0.80, 0.90, 0.30], [0.90, 1.00, 0.30]],
};

/**
 * Probability of finishing in each order slot, for one running style in a field
 * of `fieldSize`. Returns a Map of order (1-based) to probability.
 */
export function orderDistribution(strategy, fieldSize = CM_FIELD_SIZE) {
  const bands = POSITION_BANDS[strategy] ?? POSITION_BANDS[2];
  const weights = new Map();
  for (const [lo, hi, w] of bands) {
    const first = Math.max(1, Math.ceil(lo * fieldSize + 1e-9));
    const last = Math.min(fieldSize, Math.max(first, Math.ceil(hi * fieldSize - 1e-9)));
    const share = w / (last - first + 1);
    for (let o = first; o <= last; o += 1) weights.set(o, (weights.get(o) ?? 0) + share);
  }
  const total = [...weights.values()].reduce((a, b) => a + b, 0) || 1;
  for (const [o, w] of weights) weights.set(o, w / total);
  return weights;
}

/** In-game `order_rate` for a given placing. */
export const orderRate = (order, fieldSize) => (order / fieldSize) * 100;

/**
 * Chance the positional part of a skill condition holds, given the style and
 * field size. Handles both absolute placings and order_rate percentages.
 */
export function positionProbability(position = {}, strategy, fieldSize = CM_FIELD_SIZE) {
  const dist = orderDistribution(strategy, fieldSize);
  let p = 0;
  for (const [order, w] of dist) {
    const rate = orderRate(order, fieldSize);
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

export const baseSpeed = (distance) => 20 - (distance - 2000) / 1000;

/**
 * Target speed per phase, and the last-spurt speed.
 *
 * The Speed stat only enters the *final* leg — the opening and middle target
 * speeds are pure base-speed × running-style coefficient. The last spurt is then
 * built on top of the final-leg target, so the Speed term is counted twice: once
 * inside the ×1.05 and once again after it. Dropping the first of those was
 * understating the spurt by about 1.05 × the whole Speed contribution, which at
 * 1200 Speed is over 1.6 m/s.
 */
export function raceSpeeds({ distance, speed, guts, strategy, aptitudes = DEFAULT_APTITUDES }) {
  const base = baseSpeed(distance);
  const coef = SPEED_COEF[strategy] ?? SPEED_COEF[2];
  const speedBonus = Math.sqrt(500 * speed) * aptSpeed(aptitudes) * 0.002;
  const v2 = base * coef[2] + speedBonus;
  return {
    base,
    v0: base * coef[0],
    v1: base * coef[1],
    v2,
    spurt: (v2 + 0.01 * base) * 1.05 + speedBonus + (450 * guts) ** 0.597 * 0.0001,
  };
}

const drainPerSecond = (v, base) => (20 * (v - base + 12) ** 2) / 144;

/**
 * The last spurt is solved over the final leg minus a 60 m run-out: the game
 * works out where to start spurting so that it lasts to 60 m from the line, and
 * covers that tail at spurt speed regardless. Charging stamina for the full
 * third of the race overstated what a full spurt costs.
 */
const SPURT_RUNOUT = 60;

export function simulateRace({ course, strategy, stats: rawStats, ground = 1, recoveryPct = 0, aptitudes = DEFAULT_APTITUDES }) {
  const d = course.distance;
  const stats = effectiveStats(rawStats, course, ground);
  const { base, v0, v1, v2, spurt } = raceSpeeds({
    distance: d, speed: stats.speed, guts: stats.guts, strategy, aptitudes,
  });

  const hpCoef = HP_COEF[strategy] ?? 1;
  // Stamina is not touched by the going or the course bonus, so the raw stat is
  // what pays for the HP pool.
  const maxHp = d + 0.8 * hpCoef * rawStats.stamina;
  const groundMul = GROUND_HP[course.surface]?.[ground] ?? 1;
  const gutsMul = 1 + 200 / Math.sqrt(600 * stats.guts);

  const seg = [d / 6, d / 2, d / 3];
  const hpOpening = drainPerSecond(v0, base) * (seg[0] / v0) * groundMul;
  const hpMiddle = drainPerSecond(v1, base) * (seg[1] / v1) * groundMul;
  const before = hpOpening + hpMiddle;

  const available = maxHp * (1 + recoveryPct / 100) - before;
  const rateSpurt = drainPerSecond(spurt, base) * groundMul * gutsMul;
  const rateCruise = drainPerSecond(v2, base) * groundMul * gutsMul;
  const spurtSolved = Math.max(0, seg[2] - SPURT_RUNOUT);
  const hpFullSpurt = (rateSpurt * spurtSolved) / spurt;

  const perMetreSpurt = rateSpurt / spurt;
  const perMetreCruise = rateCruise / v2;
  let spurtDistance = seg[2];
  if (available < hpFullSpurt) {
    spurtDistance = (available - perMetreCruise * spurtSolved) / (perMetreSpurt - perMetreCruise);
    spurtDistance = Math.max(0, Math.min(seg[2], spurtDistance + SPURT_RUNOUT));
  }

  const needHp = before + hpFullSpurt;
  const requiredStamina = Math.max(0, (needHp / (1 + recoveryPct / 100) - d) / (0.8 * hpCoef));

  // Acceleration: the opening dash out of the gate and the ramp into the last
  // spurt. Both are paid in seconds and both get cheaper with Power.
  const aOpen = accelRate(stats.power, strategy, 0, aptitudes);
  const aFinal = accelRate(stats.power, strategy, 2, aptitudes);
  const dashTarget = 0.85 * v0;
  const startLoss = (dashTarget / (aOpen + START_DASH_ACCEL) + (v0 - dashTarget) / aOpen)
    - ((dashTarget ** 2) / (2 * (aOpen + START_DASH_ACCEL)) + (v0 ** 2 - dashTarget ** 2) / (2 * aOpen)) / v0;
  const spurtLoss = spurtDistance > 0 ? rampLoss(v2, spurt, aFinal) : 0;
  const accelLoss = startLoss + spurtLoss;

  const time = seg[0] / v0 + seg[1] / v1 + (seg[2] - spurtDistance) / v2 + spurtDistance / spurt + accelLoss;

  // Recovery is only worth something while the last spurt is not fully paid
  // for. Once it is, extra healing buys nothing but a small buffer against
  // pace-ups, so it must not dominate a ranking.
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
    spurtCoverage,
    speeds: { base, v0, v1, v2, spurt },
    rates: { spurt: rateSpurt, cruise: rateCruise },
    accel: { opening: aOpen, final: aFinal, startLoss, spurtLoss, total: accelLoss },
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

/** Metre ranges on the course matching a terrain keyword. */
function terrainSegments(course, kind) {
  const d = course.distance;
  switch (kind) {
    case 'corner': return course.corners.map((c) => [c.start, c.start + c.length]);
    case 'final-corner': {
      const c = course.corners[course.corners.length - 1];
      return c ? [[c.start, d]] : [];
    }
    case 'straight': return course.straights.map((s) => [s.start, s.end]);
    case 'last-straight': {
      const s = course.straights[course.straights.length - 1];
      return s ? [[s.start, s.end]] : [];
    }
    case 'uphill': return course.derived.uphill.map((s) => [s.start, s.start + s.length]);
    case 'downhill': return course.derived.downhill.map((s) => [s.start, s.start + s.length]);
    default: return [[0, d]];
  }
}

const PHASE_BOUNDS = (d) => [[0, d / 6], [d / 6, (d * 2) / 3], [(d * 2) / 3, d], [(d * 2) / 3, d]];

function intersectRanges(a, b) {
  const out = [];
  for (const [s1, e1] of a) {
    for (const [s2, e2] of b) {
      const s = Math.max(s1, s2); const e = Math.min(e1, e2);
      if (e - s > 1) out.push([s, e]);
    }
  }
  return out;
}

const rangeLength = (rs) => rs.reduce((n, [s, e]) => n + (e - s), 0);

/**
 * The stretch of track on which a skill can actually fire, from its phases,
 * terrain requirement and any distance_rate / remain_distance bound.
 */
export function triggerWindow(skill, course) {
  const d = course.distance;
  const f = skill.facets;
  let ranges = [[0, d]];

  if (f.phases?.length && f.phases.length < 4) {
    const bounds = PHASE_BOUNDS(d);
    const phaseRanges = [...new Set(f.phases)].map((p) => bounds[p]).filter(Boolean);
    ranges = intersectRanges(ranges, phaseRanges);
  }
  for (const kind of f.terrain ?? []) {
    if (kind === 'flat') continue;
    ranges = intersectRanges(ranges, terrainSegments(course, kind));
  }
  const w = f.window ?? {};
  const lo = Math.max(w.rateMin != null ? w.rateMin * d : 0, w.remainMin != null ? 0 : 0);
  const hi = Math.min(
    w.rateMax != null ? w.rateMax * d : d,
    w.remainMax != null ? d - w.remainMax : d,
  );
  const loFinal = Math.max(lo, w.remainMin != null ? 0 : 0);
  const hiFinal = Math.min(hi, w.remainMin != null ? d - w.remainMin : d);
  if (loFinal > 0 || hiFinal < d) ranges = intersectRanges(ranges, [[loFinal, Math.max(loFinal + 1, hiFinal)]]);

  if (!ranges.length) return null;
  const length = rangeLength(ranges);
  const centroid = ranges.reduce((n, [s, e]) => n + ((s + e) / 2) * (e - s), 0) / Math.max(1, length);
  return { ranges, length, centroid, share: length / d };
}

/**
 * How much a metre gained at this point in the race is worth. Ground made up
 * in the final leg sticks; ground made up early is partly given back through
 * pace and stamina.
 */
function positionWeight(fraction) {
  if (fraction < 1 / 6) return 0.55;
  if (fraction < 2 / 3) return 0.78;
  if (fraction < 0.9) return 1.25;
  return 1.45;
}

const NEED_PENALTY = {
  overtake: 0.72, blocked: 0.5, crowded: 0.6, 'gain-place': 0.75, 'lose-place': 0.75,
};

/**
 * @returns {null|{bashin:number, metres:number, score:number, parts:object, reasons:string[]}}
 *   `null` when the skill cannot fire on this course with this running style.
 */
export function scoreSkill(skill, ctx) {
  const { course, strategy, ground = 1, sim, fieldSize = CM_FIELD_SIZE, stats } = ctx;
  const f = skill.facets;
  const reasons = [];

  if (f.strategies?.length && !f.strategies.includes(strategy)) return null;
  if (f.distanceTypes?.length && !f.distanceTypes.includes(course.distanceType)) return null;
  if (f.surfaces?.length && !f.surfaces.includes(course.surface)) return null;
  if (f.rotations?.length && course.turn && !f.rotations.includes(course.turn)) return null;
  if (f.trackIds?.length && !f.trackIds.includes(Number(course.trackId))) return null;
  if (f.groundConditions?.length && !f.groundConditions.includes(ground)) return null;

  const terrain = courseTerrain(course);
  for (const t of f.terrain) if (t !== 'flat' && !terrain.has(t)) return null;

  const win = triggerWindow(skill, course);
  if (!win) return null;

  // Where the effect starts, and therefore how much of it the race still has
  // room for.
  const at = f.random ? win.centroid : win.ranges[0][0];
  const fraction = at / course.distance;
  const speedHere = fraction < 1 / 6 ? sim.speeds.v0 : fraction < 2 / 3 ? sim.speeds.v1 : sim.speeds.spurt;
  const secondsLeft = (course.distance - at) / speedHere;

  const nominal = Math.max(0.1, skill.duration * (course.distance / 1000));
  const durSec = Math.min(nominal, secondsLeft);
  if (durSec < nominal - 0.05 && skill.duration > 0) {
    reasons.push(`only ${durSec.toFixed(1)}s of ${nominal.toFixed(1)}s fits before the line`);
  }

  let metres = 0;
  const parts = {};
  const add = (key, m) => { if (m) { parts[key] = (parts[key] ?? 0) + m; metres += m; } };

  for (const e of skill.effects) {
    switch (e.key) {
      case 'target_speed':
        add('speed', e.value * durSec);
        break;
      case 'current_speed':
      case 'current_speed_decel':
        add('speed', e.value * Math.min(durSec, 3) * 0.6);
        break;
      case 'accel':
        // Calibrated so +0.2 m/s² over 3s is worth about as much as +0.35 m/s
        // over the same 3s, which is how the two are valued in practice.
        add('accel', e.value * durSec * 1.67);
        break;
      case 'recovery': {
        const recovered = (e.value / 100) * sim.maxHp;
        const extraSeconds = recovered / Math.max(0.1, sim.rates.spurt);
        const gain = extraSeconds * Math.max(0, sim.speeds.spurt - sim.speeds.v2);
        add('recovery', gain * sim.staminaPressure);
        if (sim.staminaPressure < 0.15) reasons.push('stamina already covered, so recovery scores low');
        break;
      }
      case 'speed': {
        const s = stats?.speed ?? 1200;
        const perPoint = (0.002 * Math.sqrt(500)) / (2 * Math.sqrt(Math.max(1, s)));
        add('stat', e.value * perPoint * ((course.distance / 3) / Math.max(1, sim.speeds.v2)));
        break;
      }
      case 'stamina':
        add('stat', e.value * 0.0016 * sim.staminaPressure * (course.distance / 1000));
        break;
      case 'power': add('stat', e.value * 0.0011 * (course.distance / 1000)); break;
      case 'guts': add('stat', e.value * 0.0009 * (course.distance / 1000)); break;
      case 'wit': add('stat', e.value * 0.0004 * (course.distance / 1000)); break;
      case 'lane_move':
      case 'unblock': add('utility', e.value * 0.4); break;
      default: break;
    }
  }

  if (metres <= 0) return null;

  // --- probability that it actually fires, and fires usefully ---
  const pPosition = positionProbability(f.position, strategy, fieldSize);
  if (pPosition < 0.999) {
    reasons.push(`position holds ${Math.round(pPosition * 100)}% of the time in a ${fieldSize}-runner field`);
  }
  // Style aptitude scales Wit before the activation roll is made against it.
  const pWit = skill.wisdomCheck ? activationRate((stats?.wit ?? 900) * aptWit(ctx.aptitudes)) : 1;
  if (pWit < 1) reasons.push(`Wit activation ${Math.round(pWit * 100)}%`);

  let pOther = 1;
  for (const need of f.needs) {
    if (NEED_PENALTY[need]) { pOther *= NEED_PENALTY[need]; reasons.push(`needs ${need.replace('-', ' ')}`); }
  }
  if (f.random && win.share < 0.25) {
    reasons.push(`fires somewhere in ${Math.round(win.length)}m of eligible track`);
  }

  const weight = positionWeight(fraction);
  const probability = pPosition * pWit * pOther;
  const expected = metres * weight * probability;

  return {
    metres,
    bashin: expected / BASHIN,
    score: expected,
    probability,
    parts,
    reasons,
    at,
    fraction,
    durSec,
    window: win,
    pPosition,
    pWit,
    pOther,
    weight,
  };
}

/** Speed at a point on the course, for this build. */
export function speedAt(course, sim, metres) {
  if (metres < course.distance / 6) return sim.speeds.v0;
  if (metres < (course.distance * 2) / 3) return sim.speeds.v1;
  return metres >= course.distance - sim.spurtDistance ? sim.speeds.spurt : sim.speeds.v2;
}

/**
 * Where a skill actually happens, in metres.
 *
 * `scoreSkill` already works out the eligible window and how many seconds of the
 * effect fit before the line; this turns that into something drawable: the
 * stretch of track the skill is allowed to fire on, and the stretch it is
 * actually running over. Those are different — a skill eligible across 800m of
 * corner fires once, somewhere in it — and the difference is most of what makes
 * a ranking number hard to trust.
 */
export function skillFiring(skill, scored, course, sim) {
  if (!scored) return null;
  const d = course.distance;
  const start = Math.min(d, Math.max(0, scored.at));
  // Walk the distance covered while the effect runs, since speed changes under it.
  let x = start;
  let left = scored.durSec;
  while (left > 0 && x < d) {
    const v = speedAt(course, sim, x);
    const stepSeconds = Math.min(left, 0.25);
    x = Math.min(d, x + v * stepSeconds);
    left -= stepSeconds;
  }
  const end = x;
  const phaseOf = (m) => (m < d / 6 ? 'opening' : m < (d * 2) / 3 ? 'middle' : m >= d - sim.spurtDistance ? 'spurt' : 'final');
  return {
    start,
    end,
    length: end - start,
    eligible: (scored.window?.ranges ?? []).map(([a, b]) => [a, b]),
    random: !!skill.facets.random,
    phase: phaseOf(start),
    inSpurt: end >= d - sim.spurtDistance,
    secondsClipped: Math.max(0, (skill.duration * (d / 1000)) - scored.durSec),
  };
}

/**
 * Skills whose effects are live at the same time.
 *
 * Two speed skills overlapping stack into one bigger push; a speed skill and an
 * acceleration skill overlapping are worth more together than apart, because the
 * acceleration reaches the higher target sooner. Skills that never overlap are
 * spread across the race, which is usually what you want for recovery and
 * usually not what you want in the last 200m.
 */
export function skillOverlaps(entries) {
  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      if (!a.firing || !b.firing) continue;
      const from = Math.max(a.firing.start, b.firing.start);
      const to = Math.min(a.firing.end, b.firing.end);
      if (to - from <= 1) continue;
      // A random-window skill only *might* land here, so say so rather than
      // presenting a coincidence as a plan.
      const certain = !a.firing.random && !b.firing.random;
      out.push({ a, b, from, to, metres: to - from, certain });
    }
  }
  out.sort((x, y) => y.metres - x.metres);
  return out;
}

export function rankSkills(skills, ctx, { tiers = null, limit = 0 } = {}) {
  const out = [];
  for (const s of skills) {
    if (s.inherited) continue;
    if (tiers && !tiers.includes(s.tier)) continue;
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
 *
 * Speed, Stamina and Guts move the HP/speed model directly. Wit moves the
 * expected value of every Wit-checked skill, so it is measured against the
 * ranked skill list instead. Power is not in the model — it drives
 * acceleration and lane changes, which this build does not simulate.
 */
export function statSensitivity(ctx, skills, step = 100) {
  const { course, strategy, ground, stats, aptitudes } = ctx;
  const base = simulateRace({ course, strategy, stats, ground, aptitudes, recoveryPct: ctx.recoveryPct ?? 0 });
  const out = {};

  for (const key of ['speed', 'stamina', 'guts', 'power']) {
    const bumped = simulateRace({
      course, strategy, ground, aptitudes, recoveryPct: ctx.recoveryPct ?? 0,
      stats: { ...stats, [key]: stats[key] + step },
    });
    const metres = (base.time - bumped.time) * base.speeds.spurt;
    out[key] = { bashin: metres / BASHIN, seconds: base.time - bumped.time, modelled: true };
  }

  const valueAt = (wit) => {
    const c = { ...ctx, sim: base, stats: { ...stats, wit } };
    return rankSkills(skills, c, { limit: 12 }).reduce((n, r) => n + r.bashin, 0);
  };
  out.wit = { bashin: valueAt(stats.wit + step) - valueAt(stats.wit), modelled: true, viaSkills: true };
  out.power.viaAccel = true;
  return out;
}

/**
 * The race as a curve rather than a verdict: speed and remaining HP sampled
 * along the course.
 *
 * The numbers on the rest of the page are endpoints — required Stamina, spurt
 * coverage, a finishing time. They say a build is 200 Stamina short without
 * showing where it runs out, which is the thing you actually plan around. This
 * walks the same model the endpoints come from, so the curve and the numbers
 * cannot disagree.
 */
export function raceProfile({ course, strategy, stats: rawStats, ground = 1, aptitudes, recoveryPct = 0, samples = 200 }) {
  const d = course.distance;
  const sim = simulateRace({ course, strategy, stats: rawStats, ground, aptitudes, recoveryPct });
  const { base, v0, v1, v2, spurt } = sim.speeds;
  const groundMul = GROUND_HP[course.surface]?.[ground] ?? 1;
  const stats = effectiveStats(rawStats, course, ground);
  const gutsMul = 1 + 200 / Math.sqrt(600 * stats.guts);

  const openingEnd = d / 6;
  const middleEnd = (d * 2) / 3;
  const spurtStart = d - sim.spurtDistance;
  // Recovery is spread across the race rather than pinned to a skill, which is
  // all the planner knows about it.
  const pool = sim.maxHp * (1 + recoveryPct / 100);

  const speedAt = (x) => {
    if (x < openingEnd) return v0;
    if (x < middleEnd) return v1;
    return x >= spurtStart ? spurt : v2;
  };

  const points = [];
  let hp = pool;
  let prev = 0;
  for (let i = 0; i <= samples; i += 1) {
    const x = (d * i) / samples;
    const v = speedAt(x);
    if (i > 0) {
      const mid = speedAt((x + prev) / 2);
      const phaseGuts = (x + prev) / 2 >= middleEnd ? gutsMul : 1;
      const seconds = (x - prev) / mid;
      hp -= drainPerSecond(mid, base) * groundMul * phaseGuts * seconds;
    }
    prev = x;
    points.push({ x, v, hp: Math.max(0, hp), hpRatio: Math.max(0, hp) / pool });
  }

  const emptyAt = points.find((pt) => pt.hp <= 0)?.x ?? null;
  return {
    sim, points, spurtStart, emptyAt, maxHp: pool,
    vMin: Math.min(v0, v1, v2), vMax: spurt,
    marks: { openingEnd, middleEnd },
  };
}

/**
 * The same build read across every going, and across every running style.
 *
 * The going is announced late in a Champions Meeting and a build that clears the
 * spurt on Firm can be short of it on Heavy, which is exactly the kind of thing
 * that is invisible until it costs a race. Only the HP and speed parts of the
 * model are used here — the parts checked term by term against the reference
 * solver — so the numbers carry the same weight as the ones on the rest of the
 * page.
 */
export function staminaMatrix({ course, stats, aptitudes, recoveryPct = 0, strategies = [1, 2, 3, 4], grounds = [1, 2, 3, 4] }) {
  return strategies.map((strategy) => ({
    strategy,
    cells: grounds.map((ground) => {
      const sim = simulateRace({ course, strategy, stats, ground, aptitudes, recoveryPct });
      return {
        ground,
        required: sim.requiredStamina,
        coverage: sim.spurtCoverage,
        short: Math.max(0, sim.requiredStamina - stats.stamina),
        time: sim.time,
      };
    }),
  }));
}

// Ranges players converge on. Scaled by the stat ceiling the user is playing
// with, since scenarios keep raising it.
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
