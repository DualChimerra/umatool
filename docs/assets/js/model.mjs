// Race model and skill valuation.
//
// Two independent pieces live here:
//
//   1. `simulateRace` — the stamina/HP model. It uses the widely reproduced
//      community formulas for base speed, per-phase target speed, last-spurt
//      speed and HP drain. It is an approximation of the real engine (no
//      positioning, no rivals, no pace-up), which is exactly what you want for
//      "how much Stamina do I need on this course" and nothing more.
//
//   2. `scoreSkill` — turns a skill into an estimate of metres gained on a
//      specific course with a specific running style, so skills can be ranked
//      against each other. Every multiplier it applies is reported back in
//      `reasons` so the number is auditable rather than magic.

export const STRATEGY = {
  1: { key: 'front', name: 'Front Runner' },
  2: { key: 'pace', name: 'Pace Chaser' },
  3: { key: 'late', name: 'Late Surger' },
  4: { key: 'end', name: 'End Closer' },
};

const HP_COEF = { 1: 0.95, 2: 0.89, 3: 1.0, 4: 0.995 };
const SPEED_COEF = {
  1: [1.0, 0.98, 0.962],
  2: [0.978, 0.991, 0.975],
  3: [0.938, 0.998, 0.994],
  4: [0.931, 1.0, 1.0],
};

// HP drain multiplier for the going.
const GROUND_HP = {
  1: { 1: 1.0, 2: 1.0, 3: 1.02, 4: 1.02 }, // turf
  2: { 1: 1.0, 2: 1.0, 3: 1.01, 4: 1.02 }, // dirt
};

/** Where a runner typically sits, used to judge positional skill conditions. */
export const EXPECTED_POSITION = {
  1: { rate: 8, order: 1 },
  2: { rate: 30, order: 4 },
  3: { rate: 58, order: 8 },
  4: { rate: 82, order: 12 },
};

export const baseSpeed = (distance) => 20 - (distance - 2000) / 1000;

export function raceSpeeds({ distance, speed, guts, strategy }) {
  const base = baseSpeed(distance);
  const coef = SPEED_COEF[strategy] ?? SPEED_COEF[2];
  const speedBonus = Math.sqrt(500 * speed) * 0.002;
  const v0 = base * coef[0];
  const v1 = base * coef[1];
  const v2 = base * coef[2] + speedBonus;
  // The last-spurt formula works off the *unmodified* final-leg target speed and
  // adds the Speed bonus once, so it must not be taken from v2.
  const spurt = (base * coef[2] + 0.01 * base) * 1.05 + speedBonus + (450 * guts) ** 0.597 * 0.0001;
  return { base, v0, v1, v2, spurt };
}

const drainPerSecond = (v, base) => (20 * (v - base + 12) ** 2) / 144;

/**
 * @param {object} opts
 * @param {object} opts.course
 * @param {number} opts.strategy
 * @param {{speed:number,stamina:number,power:number,guts:number,wit:number}} opts.stats
 * @param {number} [opts.ground]  1 firm … 4 heavy
 * @param {number} [opts.recoveryPct]  total % of max HP recovered by skills
 */
export function simulateRace({ course, strategy, stats, ground = 1, recoveryPct = 0 }) {
  const d = course.distance;
  const { base, v0, v1, v2, spurt } = raceSpeeds({ distance: d, speed: stats.speed, guts: stats.guts, strategy });

  const hpCoef = HP_COEF[strategy] ?? 1;
  const maxHp = d + 0.8 * hpCoef * stats.stamina;
  const groundMul = GROUND_HP[course.surface]?.[ground] ?? 1;
  const gutsMul = 1 + 200 / Math.sqrt(600 * stats.guts);

  const seg = [d / 6, d / 2, d / 3];
  const hpOpening = drainPerSecond(v0, base) * (seg[0] / v0) * groundMul;
  const hpMiddle = drainPerSecond(v1, base) * (seg[1] / v1) * groundMul;
  const before = hpOpening + hpMiddle;

  const available = maxHp * (1 + recoveryPct / 100) - before;
  const rateSpurt = drainPerSecond(spurt, base) * groundMul * gutsMul;
  const rateCruise = drainPerSecond(v2, base) * groundMul * gutsMul;
  const hpFullSpurt = (rateSpurt * seg[2]) / spurt;
  const hpNoSpurt = (rateCruise * seg[2]) / v2;

  // How much of the final leg can actually be run at spurt speed.
  const perMetreSpurt = rateSpurt / spurt;
  const perMetreCruise = rateCruise / v2;
  let spurtDistance = seg[2];
  if (available < hpFullSpurt) {
    spurtDistance = (available - perMetreCruise * seg[2]) / (perMetreSpurt - perMetreCruise);
    spurtDistance = Math.max(0, Math.min(seg[2], spurtDistance));
  }

  const needHp = before + hpFullSpurt;
  const requiredStamina = Math.max(0, (needHp / (1 + recoveryPct / 100) - d) / (0.8 * hpCoef));

  const time = seg[0] / v0 + seg[1] / v1 + (seg[2] - spurtDistance) / v2 + spurtDistance / spurt;

  return {
    maxHp,
    hpUsed: needHp,
    hpBeforeFinal: before,
    hpFullSpurt,
    hpNoSpurt,
    available,
    surplus: available - hpFullSpurt,
    requiredStamina: Math.ceil(requiredStamina),
    spurtDistance,
    spurtCoverage: spurtDistance / seg[2],
    speeds: { base, v0, v1, v2, spurt },
    rates: { spurt: rateSpurt, cruise: rateCruise },
    gutsMul,
    groundMul,
    time,
    staminaPressure: Math.max(0, Math.min(1, 1 - (available - hpFullSpurt) / Math.max(1, hpFullSpurt))),
  };
}

/* ------------------------------------------------------- skill applicability */

export function courseTerrain(course) {
  const t = new Set(['flat']);
  if (course.derived.cornerCount > 0) { t.add('corner'); t.add('final-corner'); }
  if (course.straights.length) { t.add('straight'); t.add('last-straight'); }
  if (course.derived.uphillLength > 0) t.add('uphill');
  if (course.derived.downhillLength > 0) t.add('downhill');
  return t;
}

function positionFit(position, strategy) {
  const exp = EXPECTED_POSITION[strategy] ?? EXPECTED_POSITION[2];
  let fit = 1;
  if (position.rateMax != null && exp.rate > position.rateMax) {
    fit *= Math.max(0.15, 1 - (exp.rate - position.rateMax) / 45);
  }
  if (position.rateMin != null && exp.rate < position.rateMin) {
    fit *= Math.max(0.15, 1 - (position.rateMin - exp.rate) / 45);
  }
  if (position.orderMax != null && exp.order > position.orderMax) {
    fit *= Math.max(0.2, 1 - (exp.order - position.orderMax) / 9);
  }
  if (position.orderMin != null && exp.order < position.orderMin) {
    fit *= Math.max(0.2, 1 - (position.orderMin - exp.order) / 9);
  }
  return fit;
}

const PHASE_WEIGHT = { 0: 0.45, 1: 0.7, 2: 1.3, 3: 1.45 };
const NEED_PENALTY = {
  overtake: 0.72, blocked: 0.5, crowded: 0.6, 'gain-place': 0.75, 'lose-place': 0.75,
};

/**
 * @returns {null|{metres:number, score:number, reasons:string[], phase:number}}
 *   `null` when the skill simply cannot fire on this course / with this style.
 */
export function scoreSkill(skill, ctx) {
  const { course, strategy, ground = 1, sim } = ctx;
  const f = skill.facets;
  const reasons = [];

  if (f.strategies?.length && !f.strategies.includes(strategy)) return null;
  if (f.distanceTypes?.length && !f.distanceTypes.includes(course.distanceType)) return null;
  if (f.surfaces?.length && !f.surfaces.includes(course.surface)) return null;
  if (f.rotations?.length && course.turn && !f.rotations.includes(course.turn)) return null;
  if (f.trackIds?.length && !f.trackIds.includes(Number(course.trackId))) return null;
  if (f.groundConditions?.length && !f.groundConditions.includes(ground)) return null;

  const terrain = courseTerrain(course);
  for (const t of f.terrain) if (!terrain.has(t)) return null;

  const durSec = Math.max(0.1, skill.duration * (course.distance / 1000));
  const phases = f.phases?.length ? f.phases : [0, 1, 2, 3];
  const phase = phases.reduce((best, p) => (PHASE_WEIGHT[p] > PHASE_WEIGHT[best] ? p : best), phases[0]);
  const phaseWeight = PHASE_WEIGHT[phase] ?? 1;

  let metres = 0;
  for (const e of skill.effects) {
    switch (e.key) {
      case 'target_speed':
        metres += e.value * durSec;
        break;
      case 'current_speed':
      case 'current_speed_decel':
        metres += e.value * Math.min(durSec, 3) * 0.6;
        break;
      case 'accel':
        // Calibrated so +0.2 m/s² over 3s is worth about as much as +0.35 m/s
        // over 3s, which matches how the two are valued in practice.
        metres += e.value * durSec * 1.67;
        break;
      case 'recovery': {
        if (!sim) break;
        const recovered = (e.value / 100) * sim.maxHp;
        const extraSeconds = recovered / Math.max(0.1, sim.rates.spurt);
        const gain = extraSeconds * Math.max(0, sim.speeds.spurt - sim.speeds.v2);
        metres += gain * sim.staminaPressure;
        if (sim.staminaPressure < 0.15) reasons.push('stamina already covered');
        break;
      }
      case 'speed': {
        // +N Speed feeds the final-leg speed bonus √(500·speed)·0.002
        const s = ctx.stats?.speed ?? 1200;
        const perPoint = (0.002 * Math.sqrt(500)) / (2 * Math.sqrt(Math.max(1, s)));
        metres += e.value * perPoint * (course.distance / 3 / Math.max(1, sim?.speeds.v2 ?? 20));
        break;
      }
      case 'guts':
        metres += e.value * 0.0009 * (course.distance / 1000);
        break;
      case 'power':
        metres += e.value * 0.0011 * (course.distance / 1000);
        break;
      case 'stamina':
        metres += e.value * 0.0016 * (sim?.staminaPressure ?? 0.5) * (course.distance / 1000);
        break;
      case 'wit':
        metres += e.value * 0.0004 * (course.distance / 1000);
        break;
      case 'lane_move':
      case 'unblock':
        metres += e.value * 0.4;
        break;
      default:
        break;
    }
  }

  if (metres <= 0) return null;

  let reliability = 1;
  if (f.random) { reliability *= 0.88; reasons.push('random trigger point'); }
  if (skill.wisdomCheck) { reliability *= 0.9; reasons.push('Wit activation check'); }
  for (const need of f.needs) {
    if (NEED_PENALTY[need]) { reliability *= NEED_PENALTY[need]; reasons.push(`needs ${need.replace('-', ' ')}`); }
  }
  const fit = positionFit(f.position ?? {}, strategy);
  if (fit < 0.98) reasons.push(`position fit ${Math.round(fit * 100)}%`);
  reliability *= fit;

  if (f.terrain.includes('downhill')) {
    const share = course.derived.downhillLength / course.distance;
    reliability *= Math.min(1, 0.55 + share * 6);
    reasons.push(`${Math.round(course.derived.downhillLength)}m of downhill`);
  }
  if (f.terrain.includes('uphill')) {
    const share = course.derived.uphillLength / course.distance;
    reliability *= Math.min(1, 0.55 + share * 6);
    reasons.push(`${Math.round(course.derived.uphillLength)}m of uphill`);
  }

  const effective = metres * phaseWeight * reliability;
  return {
    metres,
    phase,
    reliability,
    score: effective,
    reasons,
  };
}

/** Ranks every learnable skill for a course + strategy. */
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

/* --------------------------------------------------------------- stat guide */

// Baselines the Champions Meeting community converges on. Stamina is not in
// here on purpose — it is calculated from the course instead.
const STAT_BASELINE = {
  sprint: { speed: [1100, 1200], power: [1000, 1150], guts: [400, 600], wit: [800, 1000] },
  mile: { speed: [1100, 1200], power: [900, 1050], guts: [400, 600], wit: [800, 1000] },
  medium: { speed: [1050, 1200], power: [850, 1000], guts: [350, 550], wit: [800, 1000] },
  long: { speed: [1000, 1150], power: [800, 950], guts: [350, 500], wit: [800, 1000] },
};

export function statGuide(course, strategy) {
  const key = ['', 'sprint', 'mile', 'medium', 'long'][course.distanceType] ?? 'medium';
  const base = STAT_BASELINE[key];
  const out = { ...base };
  if (course.surface === 2) out.power = [base.power[0] + 100, base.power[1] + 150];
  if (strategy === 1) out.guts = [base.guts[0] + 100, base.guts[1] + 150];
  if (strategy === 4) out.power = [base.power[0] + 50, base.power[1] + 100];
  return out;
}
