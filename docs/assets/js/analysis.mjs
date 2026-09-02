// Shared analysis for the Team page: what a slot can end up with, what a card
// or an uma would add to it, and the advice that falls out of both.

import { db, isObtainable } from './store.mjs';
import {
  cm, scoringContext, prioritySatisfiers, ownsCard, canPlace, aptitudesFor,
  fieldStyles, DEFAULT_APT,
} from './context.mjs';
import {
  simulateRace, scoreSkill, STRATEGY, statSensitivity,
  BASHIN, APT_GRADE, activationRate, aptWit, isUnique,
} from './model.mjs';

// A hint has to be rolled and paid for, so it is not worth an event skill the
// training run hands you outright.
export const HINT_CONFIDENCE = 0.6;

const KIND_WEIGHT = { unique: 1, own: 1, event: 1, hint: HINT_CONFIDENCE };
const KIND_RANK = { unique: 4, own: 3, event: 2, hint: 1 };

/**
 * What one card actually teaches, one entry per skill.
 *
 * 72 Global cards list the same skill both as their event skill and as a hint.
 * Walking the two arrays back to back therefore counted those skills twice —
 * twice in the deck value, and twice in the pill row, which is what made a card
 * look like it was handing out the same gold skill two times over.
 */
export function cardSkills(card) {
  const out = [];
  const seen = new Set();
  for (const [ids, kind] of [[card.eventSkills, 'event'], [card.hintSkills, 'hint']]) {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const skill = db.skillById.get(id);
      if (skill) out.push({ skill, kind });
    }
  }
  return out;
}

/** Memoised skill valuation for one scoring context. */
export function valuer(full) {
  const cache = new Map();
  return (skill) => {
    if (!skill) return null;
    if (!cache.has(skill.id)) cache.set(skill.id, scoreSkill(skill, full));
    return cache.get(skill.id);
  };
}

/** Readable names for whatever put a skill within reach — cards or the uma. */
export function sourceNames(info) {
  if (!info) return [];
  return info.from
    .map((id) => db.supportById.get(id)?.name ?? db.outfitById.get(id)?.charaName)
    .filter(Boolean);
}

export function analyseSlot(slot) {
  const course = db.courseById.get(cm.courseId);
  const outfit = slot.outfitId ? db.outfitById.get(slot.outfitId) : null;
  const ctx = scoringContext(slot);
  const sim = simulateRace({ ...ctx, recoveryPct: cm.recovery });
  const full = { ...ctx, sim, recoveryPct: cm.recovery };
  const valueOf = valuer(full);

  const origin = new Map();
  const note = (id, kind, from) => {
    if (!db.skillById.has(id)) return;
    const prev = origin.get(id);
    if (!prev) origin.set(id, { kind, from: [from] });
    else if (KIND_RANK[kind] > KIND_RANK[prev.kind]) origin.set(id, { kind, from: [from] });
    else if (prev.kind === kind && !prev.from.includes(from)) prev.from.push(from);
  };

  if (outfit?.uniqueId) note(outfit.uniqueId, 'unique', outfit.id);
  for (const id of outfit?.skillIds ?? []) note(id, 'own', outfit.id);

  const cards = slot.deck.map((id) => (id ? db.supportById.get(id) : null));
  for (const card of cards) {
    if (!card) continue;
    for (const { skill, kind } of cardSkills(card)) note(skill.id, kind, card.id);
  }

  const pool = [];
  for (const [id, info] of origin) {
    const skill = db.skillById.get(id);
    const scored = valueOf(skill);
    pool.push({ skill, ...info, weight: KIND_WEIGHT[info.kind], scored, value: (scored?.bashin ?? 0) * KIND_WEIGHT[info.kind] });
  }
  pool.sort((a, b) => b.value - a.value);

  const usable = pool.filter((p) => p.scored);
  const total = usable.reduce((n, p) => n + p.value, 0);

  const coverage = cm.priority.map((id) => {
    const skill = db.skillById.get(id);
    const satisfiers = prioritySatisfiers(id);
    let hit = null;
    for (const sid of satisfiers) {
      const info = origin.get(sid);
      if (!info) continue;
      if (!hit || KIND_RANK[info.kind] > KIND_RANK[hit.info.kind]) hit = { info, skillId: sid };
    }
    return {
      skill,
      hit,
      via: hit && hit.skillId !== id ? db.skillById.get(hit.skillId) : null,
      from: hit ? sourceNames(hit.info) : [],
      scored: valueOf(db.skillById.get(hit?.skillId ?? id)),
    };
  });
  const covered = coverage.filter((c) => c.hit).length;

  const aptDistance = ['', 'sprint', 'mile', 'medium', 'long'][course.distanceType];
  const aptSurface = course.surface === 1 ? 'turf' : 'dirt';
  const aptStyle = STRATEGY[ctx.strategy]?.key;

  return {
    slot, outfit, ctx, sim, cards, origin, pool, usable, total, coverage, covered, valueOf, full,
    aptitudes: outfit ? {
      distance: outfit.aptitudeGrades[aptDistance], distanceVal: outfit.aptitudes[aptDistance],
      surface: outfit.aptitudeGrades[aptSurface], surfaceVal: outfit.aptitudes[aptSurface],
      style: outfit.aptitudeGrades[aptStyle], styleVal: outfit.aptitudes[aptStyle],
    } : null,
  };
}

/* ------------------------------------------------------------- candidates */

/**
 * Rank support cards by what they would add to this deck — value the deck does
 * not already have, plus priority entries it would newly satisfy.
 *
 * Cards outside the collection are never dropped from the result. One of the six
 * may always be borrowed from a friend, so hiding them makes that slot invisible;
 * they come back flagged `blocked` once the borrow is spent, which the picker
 * renders as a disabled row explaining why.
 *
 * @param {'all'|'mine'|'friend'} own  which side of the collection to list
 */
export function rankCards(analysis, deckIndex, { own = 'all', query = '', type = null } = {}) {
  const { origin, valueOf, slot } = analysis;
  const inDeck = new Set(slot.deck.filter(Boolean));
  const needle = query.trim().toLowerCase();

  const prioritySets = cm.priority.map((id) => ({ id, set: prioritySatisfiers(id) }));
  const alreadyCovered = new Set(prioritySets.filter(({ set }) => [...set].some((s) => origin.has(s))).map((p) => p.id));

  const out = [];
  for (const card of db.supports) {
    if (!card.global) continue;
    if (needle && !card.name.toLowerCase().includes(needle)) continue;
    if (type && card.type !== type) continue;
    const owned = !cm.useOwned || ownsCard(card.id);
    if (cm.useOwned && own === 'mine' && !owned) continue;
    if (cm.useOwned && own === 'friend' && owned) continue;

    let gain = 0;
    let existing = 0;
    const newPriority = [];
    const skills = [];
    for (const { skill, kind } of cardSkills(card)) {
      const scored = valueOf(skill);
      const value = (scored?.bashin ?? 0) * KIND_WEIGHT[kind];
      const held = origin.has(skill.id);
      skills.push({ skill, kind, value, held, scored });
      if (held) { existing += value; continue; }
      gain += value;
      for (const { id: pid, set } of prioritySets) {
        if (!alreadyCovered.has(pid) && set.has(skill.id) && !newPriority.includes(pid)) newPriority.push(pid);
      }
    }
    skills.sort((a, b) => b.value - a.value);
    const blocked = !owned && !canPlace(slot, deckIndex, card.id);
    out.push({
      card, owned, gain, existing, newPriority, skills, blocked,
      inDeck: inDeck.has(card.id),
      // What the card is worth leads the ordering. Ownership is only a
      // tie-breaker: it used to be a flat +1000, which buried every borrowable
      // card below the whole collection where nobody would ever scroll to it.
      rank: newPriority.length * 10 + gain - (blocked ? 1e6 : 0),
    });
  }
  out.sort((a, b) => b.rank - a.rank || Number(b.owned) - Number(a.owned) || b.gain - a.gain);
  return out;
}

/**
 * Rank umamusume by what their own kit is worth on this course.
 * @param {'all'|'mine'} own  'mine' respects the collection restriction
 */
export function rankUmas({ own = 'all', query = '', strategy = null } = {}) {
  const course = db.courseById.get(cm.courseId);
  const needle = query.trim().toLowerCase();
  const aptDistance = ['', 'sprint', 'mile', 'medium', 'long'][course.distanceType];
  const aptSurface = course.surface === 1 ? 'turf' : 'dirt';

  // Two umas of the same running style no longer score the same: aptitude feeds
  // into target speed, acceleration and the Wit roll, so the cache has to key on
  // the aptitudes as well as the style.
  const byContext = new Map();
  const out = [];
  for (const outfit of db.globalOutfits) {
    if (needle && !outfit.displayName.toLowerCase().includes(needle)) continue;
    const style = strategy ?? outfit.strategy;
    if (strategy && outfit.strategy !== strategy) continue;
    const owned = !cm.useOwned || cm.owned.umas.includes(outfit.id);
    if (own === 'mine' && !owned) continue;

    const aptitudes = aptitudesFor(outfit, course, style);
    const key = `${style}:${aptitudes.distance}:${aptitudes.surface}:${aptitudes.style}`;
    if (!byContext.has(key)) {
      // The whole context goes in, so the going, weather, season and field mix
      // reach the valuation the same way they do everywhere else.
      const ctx = { ...scoringContext({ outfitId: outfit.id, strategy: style, stats: cm.stats, deck: [] }), aptitudes };
      const sim = simulateRace({ ...ctx, recoveryPct: cm.recovery });
      byContext.set(key, { valueOf: valuer({ ...ctx, sim, recoveryPct: cm.recovery }), sim });
    }
    const { valueOf, sim } = byContext.get(key);

    const ids = [...(outfit.uniqueId ? [outfit.uniqueId] : []), ...outfit.skillIds];
    let value = 0;
    let unique = 0;
    const skills = [];
    for (const id of ids) {
      const skill = db.skillById.get(id);
      const scored = valueOf(skill);
      const v = scored?.bashin ?? 0;
      value += v;
      if (id === outfit.uniqueId) unique = v;
      skills.push({ skill, value: v, scored });
    }
    skills.sort((a, b) => b.value - a.value);

    out.push({
      outfit, value, unique, skills, owned, sim,
      gold: skills.filter((s) => s.skill?.tier === 'gold').length,
      // The aptitude penalty used to be a hand-picked multiplier bolted on here.
      // The model applies the game's own aptitude tables now, so applying a
      // second discount on top would count the same shortfall twice.
      rank: value,
      aptitudes: {
        distance: outfit.aptitudeGrades[aptDistance], distanceVal: outfit.aptitudes[aptDistance],
        surface: outfit.aptitudeGrades[aptSurface], surfaceVal: outfit.aptitudes[aptSurface],
        style: outfit.aptitudeGrades[STRATEGY[style].key], styleVal: outfit.aptitudes[STRATEGY[style].key],
      },
    });
  }
  out.sort((a, b) => b.rank - a.rank);
  return out;
}

/**
 * Rank unique skills the only way they can actually be had: by running the uma
 * they belong to.
 *
 * They used to be scored under whatever running style the Planner was set to,
 * with A aptitudes assumed. Both are wrong for a unique — you cannot take one
 * without taking its owner, so the style is hers and so are the aptitudes. With
 * aptitude now feeding target speed, acceleration and the Wit roll, that moved
 * two of the top eight on Tokyo 2400m and reshuffled the rest.
 *
 * Uniques with no Global owner are dropped rather than listed as unobtainable:
 * 20 of the 117 in the data have nobody to carry them.
 */
export function rankUniques() {
  const course = db.courseById.get(cm.courseId);
  const byContext = new Map();
  const out = [];

  for (const skill of db.skills) {
    if (skill.tier !== 'unique' && skill.tier !== 'evolved') continue;
    const owner = skill.sources.unique
      .map((id) => db.outfitById.get(id))
      .find((o) => o && o.global !== false);
    if (!owner) continue;

    const strategy = owner.strategy;
    const aptitudes = aptitudesFor(owner, course, strategy);
    const key = `${strategy}:${aptitudes.distance}:${aptitudes.surface}:${aptitudes.style}`;
    if (!byContext.has(key)) {
      const sim = simulateRace({ course, strategy, stats: cm.stats, ground: cm.ground, aptitudes, recoveryPct: cm.recovery });
      byContext.set(key, valuer({
        course, strategy, ground: cm.ground, fieldSize: cm.fieldSize,
        recoveryPct: cm.recovery, stats: cm.stats, aptitudes, sim,
      }));
    }
    const scored = byContext.get(key)(skill);
    if (!scored) continue;
    out.push({ skill, owner, strategy, aptitudes, scored, bashin: scored.bashin, reasons: scored.reasons });
  }

  out.sort((a, b) => b.bashin - a.bashin);
  return out;
}

/* ------------------------------------------------- running-style valuation */

/**
 * A unique is a different skill under every running style.
 *
 * Not one of the 117 uniques in the data names a running style in its condition
 * string — the game does not have to, because a unique comes attached to one
 * umamusume who runs one way. Nearly all of them (98 of 117) *are* gated on
 * where you sit in the field, and that is decided almost entirely by how you
 * run: `order<=3` is free for a Front Runner and a coin flip for an End Closer,
 * `order_rate>=40` is the other way round. So the same unique is priced four
 * different ways here, and the style you picked is the one that is shown.
 *
 * On top of the gate there is the question of whether the uma who carries it
 * can be run that way at all. Style aptitude scales the Wit the activation roll
 * is made against, so an End Closer with G Front aptitude does not merely run
 * badly at the front — her skills stop firing.
 */

/** Style aptitude below this and the uma should not be run this way at all. */
export const MIN_STYLE_APT = 5; // C
/**
 * ...and the same floor on the course itself. A unique is not separable from
 * the uma carrying it, so a dirt sprinter's unique is not a turf 2400m pick,
 * however well the skill itself scores there — and it can score well, because a
 * runner crippled by F surface aptitude spends longer below target speed, which
 * is exactly where an acceleration skill pays.
 */
export const MIN_COURSE_APT = 5; // C

/** Skills an uma realistically ends a run with, out of her own list. */
export const KIT_DEPTH = 6;
/**
 * How much of a skill on her own list is a reason to pick *her*.
 *
 * A skill only she teaches is: there is no other way to get it. A skill three
 * Global support cards also hand out is barely one — you would have ended up
 * with it whoever you ran. Counting both at face value is what made the ranking
 * read as "who has the deepest skill list" and buried the unique, which is the
 * one thing about an umamusume that cannot be obtained any other way.
 */
export const KIT_EXCLUSIVE = 0.9;
export const KIT_SHARED = 0.35;

/** Can a Global support card teach this skill without her? */
function taughtByCard(skill) {
  const s = skill?.sources;
  if (!s) return false;
  return s.event.some((id) => db.supportById.get(id)?.global)
    || s.hint.some((id) => db.supportById.get(id)?.global);
}

// One scoring context per (style, aptitude) pair, thrown away whenever anything
// about the race setup moves. Every uma on the page shares a handful of these.
let ctxCacheKey = '';
let ctxCache = new Map();

function setupSignature() {
  return [
    cm.courseId, cm.ground, cm.weather, cm.season, cm.fieldSize, cm.recovery,
    cm.you.uniqueLevel, fieldStyles().slice(1).join(''),
    cm.stats.speed, cm.stats.stamina, cm.stats.power, cm.stats.guts, cm.stats.wit,
  ].join('|');
}

/**
 * Scoring context for "me, running this style, with these aptitudes".
 *
 * The field mix, going, weather and season are the ones set on the Planner, so
 * a unique is never priced against a race nobody is planning to run.
 */
function ctxFor(strategy, aptitudes) {
  const sig = setupSignature();
  if (sig !== ctxCacheKey) { ctxCacheKey = sig; ctxCache = new Map(); }
  const key = `${strategy}:${aptitudes.distance}:${aptitudes.surface}:${aptitudes.style}`;
  let hit = ctxCache.get(key);
  if (!hit) {
    const styles = fieldStyles();
    styles[0] = strategy;
    const ctx = {
      course: db.courseById.get(cm.courseId),
      strategy,
      ground: cm.ground,
      weather: cm.weather,
      season: cm.season,
      fieldSize: cm.fieldSize,
      fieldStyles: styles,
      aptitudes,
      stats: cm.stats,
      recoveryPct: cm.recovery,
      uniqueLevel: cm.you.uniqueLevel,
    };
    ctx.sim = simulateRace(ctx);
    hit = { ctx, valueOf: valuer(ctx) };
    ctxCache.set(key, hit);
  }
  return hit;
}

/**
 * Lengths handed to the field by running on aptitudes below A, split the way
 * the game splits them.
 *
 * Distance and surface aptitude move target speed and acceleration, so they
 * come out of the race model as a time difference against an A/A/A runner on
 * the same course. Style aptitude does not touch the clock at all — it scales
 * the Wit the activation roll is made against — so it is priced against a
 * typical load of Wit-checked skills instead, exactly as `statValue` does.
 */
export function aptitudeCost(strategy, aptitudes) {
  const mine = ctxFor(strategy, aptitudes).ctx;
  const ideal = ctxFor(strategy, DEFAULT_APT).ctx;
  const clock = ((mine.sim.time - ideal.sim.time) * ideal.sim.speeds.spurt) / BASHIN;
  const wit = (activationRate(cm.stats.wit * aptWit(DEFAULT_APT))
    - activationRate(cm.stats.wit * aptWit(aptitudes))) * 5 * 0.35;
  return { clock, wit, total: clock + wit };
}

/**
 * Every unique that lands on this race, priced for the running style you chose
 * rather than for the one its owner happens to prefer.
 *
 * Both readings are returned: `bashin` is what the unique is worth run your
 * way, `nativeBashin` what it is worth run hers. When those disagree the row
 * says so, because that gap is the whole reason a unique cannot be ranked
 * style-blind.
 */
export function rankUniquesForStyle(strategy = cm.strategy) {
  const course = db.courseById.get(cm.courseId);
  const styleKey = STRATEGY[strategy].key;
  const out = [];

  for (const skill of db.skills) {
    if (!isUnique(skill)) continue;
    const owner = skill.sources.unique
      .map((id) => db.outfitById.get(id))
      .find((o) => o && o.global !== false);
    if (!owner) continue;

    const aptitudes = aptitudesFor(owner, course, strategy);
    const scored = ctxFor(strategy, aptitudes).valueOf(skill);
    if (!scored) continue;

    const nativeApt = aptitudesFor(owner, course, owner.strategy);
    const native = ctxFor(owner.strategy, nativeApt).valueOf(skill);
    const styleApt = owner.aptitudes[styleKey] ?? 7;

    out.push({
      skill,
      owner,
      strategy,
      aptitudes,
      scored,
      bashin: scored.bashin,
      reasons: scored.reasons,
      styleApt,
      styleGrade: APT_GRADE[styleApt],
      native: owner.strategy,
      nativeBashin: native?.bashin ?? 0,
      // Her own style always counts as runnable, whatever the grade table says.
      fitsStyle: owner.strategy === strategy || styleApt >= MIN_STYLE_APT,
      fitsCourse: aptitudes.distance >= MIN_COURSE_APT && aptitudes.surface >= MIN_COURSE_APT,
      fits: (owner.strategy === strategy || styleApt >= MIN_STYLE_APT)
        && aptitudes.distance >= MIN_COURSE_APT && aptitudes.surface >= MIN_COURSE_APT,
    });
  }

  out.sort((a, b) => b.bashin - a.bashin);
  return out;
}

/**
 * The same unique read under all four running styles, so the row can show which
 * style it actually wants. Computed only for the rows on screen — it is four
 * full valuations per skill.
 */
export function uniqueStyleProfile(skill, owner) {
  const course = db.courseById.get(cm.courseId);
  const out = {};
  let best = 0;
  for (const s of [1, 2, 3, 4]) {
    const v = ctxFor(s, aptitudesFor(owner, course, s)).valueOf(skill)?.bashin ?? 0;
    out[s] = v;
    if (v > (out[best] ?? -Infinity)) best = s;
  }
  return { by: out, best };
}

/* ------------------------------------------------------- parent inheritance */

// A unique is handed down as its own weaker white copy, which the data ships as
// a separate skill: unique `100381` → inherited `900381`. All 97 inheritable
// uniques follow that rule, so the link is read off the id rather than guessed
// from the name.
let inheritLinks = null;
function inheritance() {
  if (inheritLinks) return inheritLinks;
  const parentOf = new Map();   // inherited skill id → the unique it copies
  const copyOf = new Map();     // unique skill id → its inherited copy
  for (const s of db.skills) {
    if (!s.inherited) continue;
    const source = db.skillById.get(`1${s.id.slice(1)}`);
    if (!source || !isUnique(source)) continue;
    parentOf.set(s.id, source);
    copyOf.set(source.id, s);
  }
  inheritLinks = { parentOf, copyOf };
  return inheritLinks;
}

/** The inherited copy of a unique, if it has one. Evolved uniques do not. */
export const inheritedCopy = (skill) => (skill ? inheritance().copyOf.get(skill.id) ?? null : null);

/** The unique an inherited white skill is a copy of. */
export const sourceUnique = (skill) => (skill ? inheritance().parentOf.get(skill.id) ?? null : null);

/**
 * Which parent to breed for: every inheritable unique, scored as the white copy
 * you would actually be carrying, in the race and style *you* are running.
 *
 * This is a different question from "which unique is best on this track". You
 * inherit the copy, not the original, and you run it on your own uma's
 * aptitudes and running style — not the parent's. So the ranking is done in the
 * caller's own scoring context, and the parent is only named as the place the
 * skill comes from.
 *
 * @param {object} full the scoring context of the runner doing the inheriting
 */
export function rankParentUniques(full) {
  const course = db.courseById.get(cm.courseId);
  const styleKey = STRATEGY[full.strategy].key;
  const value = valuer(full);
  const out = [];

  for (const skill of db.skills) {
    if (!skill.inherited) continue;
    const source = sourceUnique(skill);
    if (!source) continue;
    const parents = source.sources.unique
      .map((id) => db.outfitById.get(id))
      .filter((o) => o && o.global !== false);
    if (!parents.length) continue;

    const scored = value(skill);
    if (!scored) continue;

    // A parent is worth more than its unique: the same run also passes down
    // aptitude sparks, and the ones that matter here are the course's own.
    const sparks = [];
    for (const p of parents) {
      const apt = aptitudesFor(p, course, full.strategy);
      if (apt.distance >= 8) sparks.push(`${p.charaName}: S ${course.distanceTypeName}`);
      else if (apt.surface >= 8) sparks.push(`${p.charaName}: S ${course.surfaceName}`);
      else if ((p.aptitudes[styleKey] ?? 0) >= 8) sparks.push(`${p.charaName}: S ${STRATEGY[full.strategy].short}`);
    }

    out.push({
      skill, source, parents, parent: parents[0], scored,
      bashin: scored.bashin,
      reasons: scored.reasons,
      sparks,
      // What the full-strength original is worth in the same race, so the cost
      // of taking the copy instead of the uma is visible.
      fullBashin: value(source)?.bashin ?? 0,
    });
  }

  out.sort((a, b) => b.bashin - a.bashin);
  return out;
}

/* ---------------------------------------------------- best uma for a track */

/**
 * Which umamusume this course actually wants, and why.
 *
 * Four things decide it and all four are measured in the same unit — lengths
 * on the field at the line — so they can simply be added up:
 *
 *   * her unique, priced on this course under the running style in play;
 *   * the best of her own skill list, discounted because a training run does
 *     not hand you all of it;
 *   * what her distance and surface aptitudes cost against the clock;
 *   * what her style aptitude costs the activation roll.
 *
 * @param {object} opts
 * @param {number} opts.strategy   the style to judge her in
 * @param {boolean} opts.ownStyle  judge every uma in her own style instead
 */
export function rateUmasForRace({ strategy = cm.strategy, ownStyle = false, own = 'all' } = {}) {
  const course = db.courseById.get(cm.courseId);
  const out = [];

  for (const outfit of db.globalOutfits) {
    const owned = !cm.useOwned || cm.owned.umas.includes(outfit.id);
    if (own === 'mine' && !owned) continue;

    const style = ownStyle ? outfit.strategy : strategy;
    const styleKey = STRATEGY[style].key;
    const aptitudes = aptitudesFor(outfit, course, style);
    const { ctx, valueOf } = ctxFor(style, aptitudes);
    const cost = aptitudeCost(style, aptitudes);

    const uniqueSkill = outfit.uniqueId ? db.skillById.get(outfit.uniqueId) : null;
    const uniqueScored = uniqueSkill ? valueOf(uniqueSkill) : null;
    const uniqueValue = uniqueScored?.bashin ?? 0;

    const kit = outfit.skillIds
      .map((id) => db.skillById.get(id))
      .filter(Boolean)
      .map((skill) => {
        const scored = valueOf(skill);
        const shared = taughtByCard(skill);
        const bashin = scored?.bashin ?? 0;
        return { skill, scored, bashin, shared, worth: bashin * (shared ? KIT_SHARED : KIT_EXCLUSIVE) };
      })
      .sort((a, b) => b.worth - a.worth);
    const kitTop = kit.slice(0, KIT_DEPTH).filter((x) => x.worth > 0);
    const kitValue = kitTop.reduce((n, x) => n + x.worth, 0);

    const styleApt = outfit.aptitudes[styleKey] ?? 7;
    const total = uniqueValue + kitValue - cost.total;

    out.push({
      outfit, style, styleApt, aptitudes, owned,
      sim: ctx.sim,
      unique: uniqueSkill, uniqueScored, uniqueValue,
      kit, kitTop, kitValue,
      cost,
      total,
      fits: (outfit.strategy === style || styleApt >= MIN_STYLE_APT)
        && aptitudes.distance >= MIN_COURSE_APT && aptitudes.surface >= MIN_COURSE_APT,
      grades: {
        distance: APT_GRADE[aptitudes.distance],
        surface: APT_GRADE[aptitudes.surface],
        style: APT_GRADE[styleApt],
      },
      reasons: umaReasons({ outfit, course, style, aptitudes, styleApt, cost, uniqueSkill, uniqueScored, kitTop, sim: ctx.sim }),
    });
  }

  out.sort((a, b) => b.total - a.total);
  return out;
}

/** The short, checkable "why" a row carries. Strongest claim first. */
function umaReasons({ outfit, course, style, aptitudes, styleApt, cost, uniqueSkill, uniqueScored, kitTop, sim }) {
  const why = [];

  if (uniqueScored && uniqueSkill) {
    const where = uniqueScored.at != null ? Math.round(uniqueScored.at) : null;
    const inSpurt = where != null && where >= sim.spurtStart;
    why.push(`${uniqueSkill.name} is worth ${uniqueScored.bashin.toFixed(2)} here${
      inSpurt ? ', and it lands inside the last spurt' : where != null ? `, firing around ${where}m` : ''}`);
    const ramp = uniqueScored.reasons.find((r) => r.startsWith('lands on the ramp'));
    if (ramp) why.push(`her unique ${ramp}`);
    else if (uniqueScored.reasons.includes('no acceleration to gain here — already at target speed')) {
      why.push('her unique is mostly acceleration, and this course gives it nowhere to spend it');
    }
    if (uniqueScored.probability < 0.5) {
      why.push(`but it only fires ${Math.round(uniqueScored.probability * 100)}% of the time as ${STRATEGY[style].name}`);
    }
  } else if (!uniqueSkill) {
    why.push('no unique in the data for this outfit');
  }

  if (outfit.strategy !== style) {
    why.push(`built as a ${STRATEGY[outfit.strategy].name}; ${APT_GRADE[styleApt]} aptitude for ${STRATEGY[style].name}`);
  }
  const aptLabel = `${APT_GRADE[aptitudes.distance]} ${course.distanceTypeName} / ${APT_GRADE[aptitudes.surface]} ${course.surfaceName}`;
  if (cost.clock > 0.15) {
    why.push(`gives up ${cost.clock.toFixed(2)} lengths to ${aptLabel}`);
  } else if (cost.clock < -0.05) {
    // Aptitude coming out *ahead* of A means one of two very different things,
    // and saying "S pays above A" for a B-grade runner would be a lie.
    if (aptitudes.distance >= 8 || aptitudes.surface >= 8) {
      why.push(`${Math.abs(cost.clock).toFixed(2)} lengths of it is her S aptitude, which pays above A`);
    } else {
      why.push(`${aptLabel} is worth ${Math.abs(cost.clock).toFixed(2)} lengths here — below A she runs slower, and at ${cm.stats.stamina} Stamina that buys back more spurt than it costs in speed`);
    }
  }
  if (cost.wit > 0.05) {
    why.push(`${APT_GRADE[styleApt]} style aptitude costs ${cost.wit.toFixed(2)} lengths of skill activation`);
  }

  const golds = kitTop.filter((x) => x.skill.tier === 'gold');
  if (golds.length) {
    why.push(golds.length > 1
      ? `her own list carries ${golds.length} gold skills that land here`
      : 'her own list carries a gold skill that lands here');
  }
  const only = kitTop.filter((x) => !x.shared);
  if (only.length) {
    why.push(only.length > 1
      ? `${only.length} of her best skills here come from nobody else`
      : 'one of her best skills here comes from nobody else');
  }
  if (sim.spurtCoverage < 0.999) {
    why.push(`at these stats she only spurts the last ${Math.round(sim.spurtCoverage * 100)}% of the final leg`);
  }
  return why;
}

/* ----------------------------------------------------------- the advisor */

const SEV = { blocker: 0, warn: 1, tip: 2 };

/**
 * Reads the whole entry and returns concrete, ordered advice. Every item says
 * what it measured, so none of it has to be taken on faith.
 */
export function recommendations(analyses) {
  const course = db.courseById.get(cm.courseId);
  const out = [];
  const push = (severity, title, detail, extra = {}) => out.push({ severity, title, detail, ...extra });

  const filled = analyses.filter((a) => a.outfit);

  if (filled.length < 3) {
    push('blocker', `${3 - filled.length} slot${filled.length === 2 ? '' : 's'} still empty`,
      'A Champions Meeting entry runs three umamusume. Fill the remaining slots to get a team reading.');
  }

  const styles = new Set(filled.map((a) => a.ctx.strategy));
  if (filled.length === 3 && styles.size === 1) {
    push('warn', 'All three run the same style',
      `Three ${STRATEGY[[...styles][0]].name}s fight each other for the same positions. In a ${cm.fieldSize}-runner field that also means all three sit in the same slice of the order, so any skill gated on placing works — or fails — for the whole team at once.`);
  }

  for (const [i, a] of analyses.entries()) {
    if (!a.outfit) continue;
    const label = `Uma ${i + 1}, ${a.outfit.charaName}`;

    const deficit = a.sim.requiredStamina - a.ctx.stats.stamina;
    if (deficit > 0) {
      const recoveryNeeded = (deficit * 0.8 * 0.95) / a.sim.maxHp * 100;
      push('blocker', `${label}: ${Math.round(deficit)} Stamina short`,
        `Only ${Math.round(a.sim.spurtCoverage * 100)}% of the last spurt is paid for. Either add ${Math.round(deficit)} Stamina, or cover it with roughly ${recoveryNeeded.toFixed(0)}% of max stamina in recovery skills.`,
        { slot: i });
    } else if (a.sim.surplus > a.sim.hpFullSpurt * 0.35) {
      push('tip', `${label}: Stamina well past what the course asks`,
        `${Math.round(a.ctx.stats.stamina - a.sim.requiredStamina)} points above the requirement. That surplus buys nothing here — recovery skills are already scored near zero for this build, and the points would do more in Speed or Power.`,
        { slot: i });
    }

    for (const [key, label2, min] of [['distance', course.distanceTypeName, 7], ['surface', course.surfaceName, 7], ['style', 'the chosen running style', 7]]) {
      if (a.aptitudes[`${key}Val`] < min) {
        push('warn', `${label}: ${label2} aptitude only ${a.aptitudes[key]}`,
          'Below A costs speed and stamina outright. Fix it with the matching aptitude item, or run a different uma here.', { slot: i });
      }
    }

    const empties = a.slot.deck.filter((x) => !x).length;
    if (empties) {
      push('warn', `${label}: ${empties} empty deck slot${empties === 1 ? '' : 's'}`,
        'Open the slot to see the cards ranked by what they would actually add to this deck.', { slot: i });
    }

    const missing = a.coverage.filter((c) => !c.hit);
    if (cm.priority.length && missing.length) {
      const best = rankCards(a, a.slot.deck.indexOf(null) >= 0 ? a.slot.deck.indexOf(null) : 5, {})
        .filter((c) => c.newPriority.length && !c.inDeck && !c.blocked)[0];
      const names = `${missing.slice(0, 3).map((m) => m.skill.name).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}`;
      push(missing.length > cm.priority.length / 2 ? 'warn' : 'tip',
        `${label}: ${missing.length} priority skill${missing.length === 1 ? '' : 's'} unreachable`,
        best
          ? `Nothing in this run teaches ${names}. ${best.card.name} (${best.card.rarityName} ${best.card.typeName}) would newly cover ${best.newPriority.length} of them and add ${best.gain.toFixed(2)} lengths.`
          : `Nothing in this run teaches ${names}, and no Global card covers them either.`,
        { slot: i, card: best?.card.id });
    }

    const sens = statSensitivity(a.full, db.learnable.filter(isObtainable));
    const ordered = Object.entries(sens).filter(([, v]) => v.bashin != null).sort((x, y) => y[1].bashin - x[1].bashin);
    if (ordered.length) {
      const [bestStat, bestVal] = ordered[0];
      const [worstStat, worstVal] = ordered[ordered.length - 1];
      // The stat keys are lowercase, but on screen these are the game's own
      // names — Speed, Wit — so they only ever go into prose capitalised.
      const statName = (k) => k.charAt(0).toUpperCase() + k.slice(1);
      push('tip', `${label}: next points go into ${statName(bestStat)}`,
        `+100 ${statName(bestStat)} is worth ${bestVal.bashin.toFixed(2)} lengths here, against ${worstVal.bashin.toFixed(2)} for ${statName(worstStat)}. Measured by re-running the race with the extra points.`,
        { slot: i });
    }

    const goldInReach = a.pool.filter((p) => p.skill.tier === 'gold').length;
    if (a.cards.filter(Boolean).length >= 5 && goldInReach < 4) {
      push('tip', `${label}: only ${goldInReach} gold skills in reach`,
        'A full deck usually puts more gold within range. Sorting the card picker by what it adds will surface the ones that do.', { slot: i });
    }
  }

  const teamMissing = cm.priority.filter((id) => !analyses.some((a) => a.coverage.find((c) => c.skill?.id === id && c.hit)));
  if (cm.priority.length && teamMissing.length) {
    push('warn', `${teamMissing.length} priority skill${teamMissing.length === 1 ? '' : 's'} nobody in the team can get`,
      teamMissing.slice(0, 6).map((id) => db.skillById.get(id)?.name).join(', ') + (teamMissing.length > 6 ? '…' : ''));
  }

  const cardUse = new Map();
  for (const a of analyses) for (const c of a.cards) if (c) cardUse.set(c.id, (cardUse.get(c.id) ?? 0) + 1);
  const overused = [...cardUse.entries()].filter(([, n]) => n === 3);
  if (overused.length >= 3) {
    push('tip', 'The three decks are nearly identical',
      `${overused.length} cards appear in all three decks. That is legal, but it means all three umamusume end up with the same skill pool — spreading the decks widens what the team can cover.`);
  }

  out.sort((a, b) => SEV[a.severity] - SEV[b.severity]);
  return out;
}
