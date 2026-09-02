// Runtime evaluation of the raw skill condition strings.
//
// The build step already turns each condition into readable English and a set
// of coarse `facets`. Facets are good enough to *filter* a list; they are not
// good enough to *run a race*, because they throw away everything the geometry
// does not fit into a bucket: `order_rate>50` is a fact about where you are at
// that instant, `blocked_front_continuetime>=1` is a fact about the field, and
// `activate_count_start>=3` is a fact about your own skill history.
//
// So the simulator goes back to the source. Every skill ships its condition as
// e.g.
//
//     "distance_type==3&phase_firsthalf_random==2&order_rate>=40"
//     "@" separates alternatives (OR), "&" separates requirements (AND).
//
// `compile()` turns that into a predicate over the live race state. Terms fall
// into three classes:
//
//   * exact      — the state carries the value, so the term is checked for real
//   * geometric  — the term picks a stretch of track; the trigger point is
//                  rolled once per race inside it, exactly like the game does
//   * unmodelled — the term depends on something this simulator does not track
//                  (post number, popularity…). Those get a fixed probability,
//                  rolled once per race, and are reported so nothing is hidden.

/* ------------------------------------------------------------------ parsing */

const TERM_RE = /^([a-z_0-9]+)(>=|<=|==|!=|>|<)(-?\d+)$/;

export function parseCondition(expr) {
  if (!expr) return [];
  return expr.split('@').map((alt) => alt.split('&').map((raw) => {
    const m = TERM_RE.exec(raw.trim());
    return m
      ? { key: m[1], op: m[2], value: Number(m[3]), raw: raw.trim() }
      : { key: raw.trim(), op: '?', value: null, raw: raw.trim() };
  }));
}

const cmp = (op, a, b) => {
  switch (op) {
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '<': return a < b;
    case '==': return a === b;
    case '!=': return a !== b;
    default: return true;
  }
};

/* -------------------------------------------------------- trigger geometry */

// Phase boundaries, as the game splits a race. Note phase 3 ("last spurt")
// starts at 5/6, not at 2/3 — getting that wrong moves every phase-3 skill
// hundreds of metres up the track.
export const phaseBounds = (d) => [
  [0, d / 6],
  [d / 6, (d * 2) / 3],
  [(d * 2) / 3, (d * 5) / 6],
  [(d * 5) / 6, d],
];

export const phaseAt = (d, pos) => (pos < d / 6 ? 0 : pos < (d * 2) / 3 ? 1 : pos < (d * 5) / 6 ? 2 : 3);

const clampRange = ([a, b]) => [Math.max(0, a), Math.max(a + 1, b)];

function intersect(a, b) {
  const out = [];
  for (const [s1, e1] of a) {
    for (const [s2, e2] of b) {
      const s = Math.max(s1, s2);
      const e = Math.min(e1, e2);
      if (e - s > 0.5) out.push([s, e]);
    }
  }
  return out;
}

/** Metre ranges on the course matching a terrain keyword. */
export function terrainRanges(course, kind) {
  const d = course.distance;
  switch (kind) {
    case 'corner': return course.corners.map((c) => [c.start, c.start + c.length]);
    case 'final-corner': {
      const c = course.corners[course.corners.length - 1];
      return c ? [[c.start, d]] : [];
    }
    case 'final-corner-late': {
      const c = course.corners[course.corners.length - 1];
      return c ? [[c.start + c.length / 2, d]] : [];
    }
    case 'straight': return course.straights.map((s) => [s.start, s.end]);
    case 'home-straight': {
      const s = course.straights.filter((x) => x.frontType === 1).pop();
      return s ? [[s.start, s.end]] : [];
    }
    case 'back-straight': {
      const s = course.straights.filter((x) => x.frontType === 2)[0];
      return s ? [[s.start, s.end]] : [];
    }
    case 'last-straight': {
      const s = course.straights[course.straights.length - 1];
      return s ? [[s.start, s.end]] : [];
    }
    case 'uphill': return course.derived.uphill.map((s) => [s.start, s.start + s.length]);
    case 'downhill': return course.derived.downhill.map((s) => [s.start, s.start + s.length]);
    case 'flat': {
      const busy = [...course.derived.uphill, ...course.derived.downhill]
        .map((s) => [s.start, s.start + s.length]).sort((a, b) => a[0] - b[0]);
      const out = [];
      let at = 0;
      for (const [s, e] of busy) { if (s > at) out.push([at, s]); at = Math.max(at, e); }
      if (at < d) out.push([at, d]);
      return out;
    }
    default: return [[0, d]];
  }
}

/**
 * Terms that pin *where on the track* the skill may fire. Everything here
 * narrows the eligible region; a `random` flag means the game picks one point
 * inside it at race start rather than firing at the first eligible metre.
 */
const GEOMETRY = {
  phase: (t, d) => ({ ranges: phaseBounds(d).filter((_, i) => cmp(t.op, i, t.value)) }),
  phase_random: (t, d) => ({ ranges: [phaseBounds(d)[t.value]].filter(Boolean), random: true }),
  phase_firsthalf_random: (t, d) => {
    const b = phaseBounds(d)[t.value];
    return { ranges: b ? [[b[0], (b[0] + b[1]) / 2]] : [], random: true };
  },
  phase_laterhalf_random: (t, d) => {
    const b = phaseBounds(d)[t.value];
    return { ranges: b ? [[(b[0] + b[1]) / 2, b[1]]] : [], random: true };
  },
  phase_corner_random: (t, d, c) => {
    const b = phaseBounds(d)[t.value];
    return { ranges: b ? intersect([b], terrainRanges(c, 'corner')) : [], random: true };
  },
  corner: (t, d, c) => ({
    ranges: t.value === 0 && t.op === '!=' ? terrainRanges(c, 'corner')
      : t.value === 0 ? terrainRanges(c, 'straight')
        : (c.corners[t.value - 1] ? [[c.corners[t.value - 1].start, c.corners[t.value - 1].start + c.corners[t.value - 1].length]] : []),
  }),
  corner_random: (t, d, c) => ({ ranges: terrainRanges(c, 'corner'), random: true }),
  all_corner_random: (t, d, c) => ({ ranges: terrainRanges(c, 'corner'), random: true, perCorner: true }),
  is_finalcorner: (t, d, c) => ({ ranges: t.value === 1 ? terrainRanges(c, 'final-corner') : [[0, c.corners.at(-1)?.start ?? d]] }),
  is_finalcorner_random: (t, d, c) => {
    const f = c.corners.at(-1);
    return { ranges: f ? [[f.start, f.start + f.length]] : [], random: true };
  },
  is_finalcorner_laterhalf: (t, d, c) => ({ ranges: terrainRanges(c, 'final-corner-late') }),
  is_last_straight: (t, d, c) => ({ ranges: terrainRanges(c, 'last-straight') }),
  is_last_straight_onetime: (t, d, c) => ({ ranges: terrainRanges(c, 'last-straight') }),
  last_straight_random: (t, d, c) => ({ ranges: terrainRanges(c, 'last-straight'), random: true }),
  straight_random: (t, d, c) => ({ ranges: terrainRanges(c, 'straight'), random: true }),
  straight_front_type: (t, d, c) => ({ ranges: terrainRanges(c, t.value === 1 ? 'home-straight' : 'back-straight') }),
  slope: (t, d, c) => ({ ranges: terrainRanges(c, t.value === 1 ? 'uphill' : t.value === 2 ? 'downhill' : 'flat') }),
  up_slope_random: (t, d, c) => ({ ranges: terrainRanges(c, 'uphill'), random: true }),
  down_slope_random: (t, d, c) => ({ ranges: terrainRanges(c, 'downhill'), random: true }),
  distance_rate: (t, d) => ({
    ranges: [clampRange(t.op.startsWith('>') ? [(t.value / 100) * d, d] : [0, (t.value / 100) * d])],
  }),
  distance_rate_after_random: (t, d) => ({ ranges: [clampRange([(t.value / 100) * d, d])], random: true }),
  remain_distance: (t, d) => ({
    ranges: [clampRange(t.op.startsWith('<') ? [d - t.value, d] : [0, d - t.value])],
  }),
  // The last spurt is a state, but it can never start before the final leg —
  // and knowing that is the difference between "this accel skill fires
  // somewhere in 2200 m" and "this accel skill lands on the spurt ramp".
  is_lastspurt: (t, d) => ({ ranges: t.value === 1 ? [[(d * 2) / 3, d]] : [[0, (d * 2) / 3]] }),
};

/**
 * Terms checked against the live state each tick. `s` is the runtime state of
 * the horse being evaluated.
 */
const LIVE = {
  order: (t, s) => cmp(t.op, s.order, t.value),
  order_rate: (t, s) => cmp(t.op, s.orderRate, t.value),
  hp_per: (t, s) => cmp(t.op, (s.hp / s.maxHp) * 100, t.value),
  accumulatetime: (t, s) => cmp(t.op, s.t, t.value),
  is_lastspurt: (t, s) => cmp(t.op, s.lastSpurt ? 1 : 0, t.value),
  is_temptation: (t, s) => cmp(t.op, s.temptation ? 1 : 0, t.value),
  temptation_count: (t, s) => cmp(t.op, s.temptationCount, t.value),
  is_overtake: (t, s) => cmp(t.op, s.overtaking ? 1 : 0, t.value),
  overtake_target_time: (t, s) => cmp(t.op, s.overtakeTime, t.value),
  change_order_onetime: (t, s) => (t.value < 0 ? s.gainedPlace : s.lostPlace),
  change_order_up_end_after: (t, s) => cmp(t.op, s.placesGained, t.value),
  blocked_front_continuetime: (t, s) => cmp(t.op, s.blockedFrontTime, t.value),
  blocked_side_continuetime: (t, s) => cmp(t.op, s.blockedSideTime, t.value),
  blocked_all_continuetime: (t, s) => cmp(t.op, Math.min(s.blockedFrontTime, s.blockedSideTime), t.value),
  infront_near_lane_time: (t, s) => cmp(t.op, s.nearFrontTime, t.value),
  is_behind_in: (t, s) => cmp(t.op, s.nearFrontTime > 0.5 ? 1 : 0, t.value),
  near_count: (t, s) => cmp(t.op, s.nearCount, t.value),
  bashin_diff_infront: (t, s) => cmp(t.op, s.gapFront, t.value),
  bashin_diff_behind: (t, s) => cmp(t.op, s.gapBehind, t.value),
  distance_diff_top: (t, s) => cmp(t.op, s.gapToLeader, t.value),
  distance_diff_top_float: (t, s) => cmp(t.op, s.gapToLeader * 10, t.value),
  distance_diff_rate: (t, s) => cmp(t.op, s.gapRate, t.value),
  activate_count_all: (t, s) => cmp(t.op, s.fired.all, t.value),
  activate_count_heal: (t, s) => cmp(t.op, s.fired.heal, t.value),
  activate_count_start: (t, s) => cmp(t.op, s.fired.opening, t.value),
  activate_count_middle: (t, s) => cmp(t.op, s.fired.middle, t.value),
  activate_count_later_half: (t, s) => cmp(t.op, s.fired.lateHalf, t.value),
  is_activate_any_skill: (t, s) => cmp(t.op, s.fired.all > 0 ? 1 : 0, t.value),
  order_rate_in20_continue: (t, s) => cmp(t.op, s.inTop20Time, t.value),
  order_rate_out40_continue: (t, s) => cmp(t.op, s.outTop40Time, t.value),
  is_lastspurt_gap: (t, s) => cmp(t.op, s.lastSpurt ? s.pos - s.spurtStart : -1, t.value),
  is_move_lane: (t, s) => cmp(t.op, s.movingLane ? 1 : 0, t.value),
  lane_type: (t, s) => cmp(t.op, s.laneType, t.value),
  is_badstart: (t, s) => cmp(t.op, s.badStart ? 1 : 0, t.value),
  post_number: (t, s) => cmp(t.op, s.postNumber, t.value),
  popularity: (t, s) => cmp(t.op, s.popularity, t.value),
};

/** Terms decided once, before the gate opens, from the race setup. */
const SETUP = {
  distance_type: (t, r) => cmp(t.op, r.course.distanceType, t.value),
  ground_type: (t, r) => cmp(t.op, r.course.surface, t.value),
  running_style: (t, r, h) => cmp(t.op, h.strategy, t.value),
  ground_condition: (t, r) => cmp(t.op, r.ground, t.value),
  weather: (t, r) => cmp(t.op, r.weather, t.value),
  season: (t, r) => cmp(t.op, r.season, t.value),
  rotation: (t, r) => cmp(t.op, r.course.turn, t.value),
  track_id: (t, r) => cmp(t.op, Number(r.course.trackId), t.value),
  is_basis_distance: (t, r) => cmp(t.op, r.course.distance % 400 === 0 ? 1 : 0, t.value),
  base_speed: (t, r, h) => cmp(t.op, h.base.speed, t.value),
  base_stamina: (t, r, h) => cmp(t.op, h.base.stamina, t.value),
  base_power: (t, r, h) => cmp(t.op, h.base.power, t.value),
  base_guts: (t, r, h) => cmp(t.op, h.base.guts, t.value),
  base_wiz: (t, r, h) => cmp(t.op, h.base.wit, t.value),
  always: () => true,
};

for (const [style, key] of [[1, 'nige'], [2, 'senko'], [3, 'sashi'], [4, 'oikomi']]) {
  SETUP[`running_style_count_${key}`] = (t, r) => cmp(t.op, r.styleCount[style] ?? 0, t.value);
  SETUP[`running_style_count_${key}_otherself`] = (t, r, h) =>
    cmp(t.op, (r.styleCount[style] ?? 0) - (h.strategy === style ? 1 : 0), t.value);
  SETUP[`running_style_temptation_opponent_count_${key}`] = (t, r, h) =>
    cmp(t.op, (r.styleCount[style] ?? 0) - (h.strategy === style ? 1 : 0), t.value);
  SETUP[`running_style_equal_popularity_one_${key}`] = (t, r) => (r.favouriteStyle ?? 0) === style;
  // Which rivals a strategy-targeted debuff hits is read straight off the
  // condition, so "Subdued Front Runners" knows it means front runners.
  SETUP[`running_style_count_${key}`].targets = style;
  SETUP[`running_style_count_${key}_otherself`].targets = style;
  SETUP[`running_style_temptation_opponent_count_${key}`].targets = style;
}

/** Probability used for a term the simulator has no state for. */
const GUESS = {
  default: 0.5,
};

/* ---------------------------------------------------------------- compiling */

/**
 * Compile one skill's condition against one course.
 *
 * @returns {{
 *   alts: Array<{ranges:[number,number][], random:boolean, perCorner:boolean,
 *                 setup:Function[], live:Function[], guesses:string[]}>,
 *   targetStyle: number|null, unmodelled: string[]
 * }}
 */
export function compile(expr, course) {
  const d = course.distance;
  const alts = [];
  const unmodelled = new Set();
  let targetStyle = null;

  for (const terms of parseCondition(expr)) {
    let ranges = [[0, d]];
    let random = false;
    let perCorner = false;
    const setup = [];
    const live = [];
    const guesses = [];
    const liveKeys = [];
    const position = {};

    for (const t of terms) {
      // Positional bounds are pulled out as data as well as compiled into a
      // predicate: the simulator checks them, the closed-form scorer needs to
      // know what they *are* so it can price the chance of holding them.
      if (t.key === 'order') {
        if (t.op === '==') { position.orderMin = t.value; position.orderMax = t.value; }
        else if (t.op.startsWith('>')) position.orderMin = Math.max(position.orderMin ?? 0, t.value);
        else if (t.op.startsWith('<')) position.orderMax = Math.min(position.orderMax ?? 99, t.value);
      } else if (t.key === 'order_rate') {
        if (t.op.startsWith('>')) position.rateMin = Math.max(position.rateMin ?? 0, t.value);
        else if (t.op.startsWith('<')) position.rateMax = Math.min(position.rateMax ?? 100, t.value);
      }
      if (GEOMETRY[t.key]) {
        const g = GEOMETRY[t.key](t, d, course);
        ranges = intersect(ranges, g.ranges.length ? g.ranges : [[0, -1]]);
        random = random || !!g.random;
        perCorner = perCorner || !!g.perCorner;
        // A few terms are both a stretch of track and a live state; they fall
        // through so the simulator still checks them tick by tick.
        if (!LIVE[t.key]) continue;
      }
      if (SETUP[t.key]) {
        const fn = SETUP[t.key];
        if (fn.targets) targetStyle = fn.targets;
        setup.push((race, horse) => fn(t, race, horse));
        continue;
      }
      if (LIVE[t.key]) { live.push((s) => LIVE[t.key](t, s)); liveKeys.push(t.raw); continue; }
      guesses.push(t.raw);
      unmodelled.add(t.key);
    }
    alts.push({ ranges, random, perCorner, setup, live, guesses, liveKeys, position });
  }

  return { alts, targetStyle, unmodelled: [...unmodelled] };
}

/** Probability that the unmodelled part of an alternative holds. */
export function guessProbability(guesses) {
  let p = 1;
  for (const g of guesses) p *= GUESS[g.split(/[<>=!]/)[0]] ?? GUESS.default;
  return p;
}
