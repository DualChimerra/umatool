// The Champions Meeting setup shared by every page: the race, the stats you
// are building towards, the skills you decided matter, what you actually own,
// and the three-uma roster with a deck behind each one.
//
// Persisted to localStorage, so nothing is lost by switching tabs or reloading.

import { db, groupLadder, isPenaltySkill } from './store.mjs';
import { CM_FIELD_SIZE, STRATEGY } from './model.mjs';

const STRATEGY_KEY = Object.fromEntries(Object.entries(STRATEGY).map(([v, s]) => [v, s.key]));

const KEY = 'paddock:cm';

// Bumped when the meaning of something already in localStorage changes. v2
// redefined `priorityOpts.anyRank`: it used to mean "any other rank of this
// group counts" and was switched on for every entry, which quietly counted the
// × rank as a match. It now means "a weaker rank also counts" and defaults off,
// so the old values have to be dropped rather than reinterpreted.
const STATE_VERSION = 2;
const listeners = new Set();

export const DEFAULT_STATS = { speed: 1200, stamina: 900, power: 1000, guts: 500, wit: 900 };
export const DEFAULT_APT = { distance: 7, surface: 7, style: 7 };

/** A rival slot in the advanced field editor. */
export function emptyRival(strategy = 2) {
  return { outfitId: null, strategy, stats: { ...DEFAULT_STATS }, skills: [], unique: true };
}

// Each deck may carry one card you do not own — the one borrowed from a friend.
export const BORROWED_ALLOWANCE = 1;

export function emptySlot() {
  return {
    outfitId: null,
    strategy: null,          // null = the outfit's own style
    stats: { ...DEFAULT_STATS },
    deck: [null, null, null, null, null, null],
  };
}

function defaults() {
  return {
    version: STATE_VERSION,
    courseId: null,
    strategy: 2,
    ground: 1,
    weather: 1,
    season: 1,
    aptitudes: { ...DEFAULT_APT },
    // The rest of the field. `simple` is a headcount per running style, which
    // is what you actually know before a Champions Meeting; `advanced` lets
    // every rival be built out in full.
    field: {
      mode: 'simple',
      counts: { 1: 2, 2: 2, 3: 2, 4: 2 },
      strength: 0.92,
      skillDepth: 4,
      rivals: [],
    },
    simRuns: 200,
    // The runner you are planning: optionally a specific umamusume, its unique
    // at whatever level you have it, and the skills you expect to finish with.
    you: { outfitId: null, uniqueLevel: 1, unique: true, lockAptitudes: true },
    raceSkills: [],
    fieldSize: CM_FIELD_SIZE,
    statCap: 1600,
    spBudget: 1200,
    recovery: 0,
    obtainableOnly: true,
    stats: { ...DEFAULT_STATS },
    priority: [],                          // skill ids, in the user's own order
    priorityOpts: {},                      // skillId -> { anyRank: boolean }
    owned: { umas: [], cards: [] },
    useOwned: false,
    roster: [emptySlot(), emptySlot(), emptySlot()],
    builds: [],                            // named saves
  };
}

export const cm = defaults();

export function initContext() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { saved = null; }
  if (saved) merge(cm, saved);

  if (cm.version !== STATE_VERSION) {
    cm.priorityOpts = {};
    cm.version = STATE_VERSION;
  }

  if (!db.courseById.has(cm.courseId)) {
    cm.courseId = db.courses.find((c) => c.trackName === 'Tokyo' && c.distance === 2400 && c.surface === 1)?.id
      ?? db.courses[0].id;
  }
  cm.priority = dedupeByGroup(cm.priority.filter((id) => db.skillById.has(id)));
  cm.raceSkills = (cm.raceSkills ?? []).filter((id) => db.skillById.has(id));
  cm.you = { outfitId: null, uniqueLevel: 1, unique: true, lockAptitudes: true, ...(cm.you ?? {}) };
  if (cm.you.outfitId && !db.outfitById.has(cm.you.outfitId)) cm.you.outfitId = null;
  cm.you.uniqueLevel = Math.max(1, Math.min(6, Number(cm.you.uniqueLevel) || 1));
  cm.spBudget = Math.max(200, Math.min(3000, Number(cm.spBudget) || 1200));
  cm.owned.umas = (cm.owned.umas ?? []).filter((id) => db.outfitById.has(id));
  cm.owned.cards = (cm.owned.cards ?? []).filter((id) => db.supportById.has(id));
  normaliseRoster(cm.roster);
  for (const build of cm.builds ?? []) normaliseRoster(build.roster ?? []);
  normaliseField();
  return cm;
}

/** Keep the field description consistent with the field size. */
export function normaliseField() {
  const f = cm.field;
  f.counts = { 1: 0, 2: 0, 3: 0, 4: 0, ...(f.counts ?? {}) };
  for (const k of [1, 2, 3, 4]) f.counts[k] = Math.max(0, Math.min(17, Number(f.counts[k]) || 0));
  const rivalsWanted = Math.max(0, cm.fieldSize - 1);
  const total = [1, 2, 3, 4].reduce((n, k) => n + f.counts[k], 0);
  if (total !== rivalsWanted) {
    // Re-spread proportionally rather than silently dropping the tail.
    const base = Math.floor(rivalsWanted / 4);
    const out = { 1: base, 2: base, 3: base, 4: base };
    let left = rivalsWanted - base * 4;
    for (const k of [2, 3, 1, 4]) { if (left <= 0) break; out[k] += 1; left -= 1; }
    f.counts = out;
  }
  f.rivals = (f.rivals ?? []).slice(0, 17).map((r) => ({
    ...emptyRival(),
    ...r,
    stats: { ...DEFAULT_STATS, ...(r.stats ?? {}) },
    skills: (r.skills ?? []).filter((id) => db.skillById.has(id)),
    outfitId: r.outfitId && db.outfitById.has(r.outfitId) ? r.outfitId : null,
  }));
  while (f.rivals.length < rivalsWanted) f.rivals.push(emptyRival(styleForIndex(f.rivals.length)));
  f.rivals.length = rivalsWanted;
}

function styleForIndex(i) {
  const order = [];
  for (const k of [1, 2, 3, 4]) for (let n = 0; n < (cm.field?.counts?.[k] ?? 0); n += 1) order.push(k);
  return order[i] ?? 2;
}

/** The running style of every runner in the race, yours first. */
export function fieldStyles() {
  const out = [cm.strategy];
  if (cm.field.mode === 'advanced') {
    for (const r of cm.field.rivals) out.push(r.strategy);
  } else {
    for (const k of [1, 2, 3, 4]) for (let n = 0; n < cm.field.counts[k]; n += 1) out.push(Number(k));
  }
  return out.slice(0, cm.fieldSize);
}

/** Human-readable summary of the field, e.g. "2 Front · 2 Pace · 3 Late · 2 End". */
export function fieldSummary() {
  const styles = fieldStyles();
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const s of styles) counts[s] += 1;
  return [1, 2, 3, 4].filter((k) => counts[k]).map((k) => `${counts[k]} ${STRATEGY[k].short}`).join(' · ');
}

function normaliseRoster(roster) {
  while (roster.length < 3) roster.push(emptySlot());
  roster.length = 3;
  for (let i = 0; i < roster.length; i += 1) {
    const slot = { ...emptySlot(), ...roster[i] };
    if (slot.outfitId && !db.outfitById.has(slot.outfitId)) slot.outfitId = null;
    slot.deck = [...(slot.deck ?? [])].slice(0, 6);
    while (slot.deck.length < 6) slot.deck.push(null);
    slot.deck = slot.deck.map((id) => (id && db.supportById.has(id) ? id : null));
    slot.stats = { ...DEFAULT_STATS, ...(slot.stats ?? {}) };
    roster[i] = slot;
  }
}

function merge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      merge(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

export function updateContext(patch = {}) {
  merge(cm, patch);
  commitContext();
}

/** Mutate `cm` directly, then call this. */
export function commitContext() {
  try { localStorage.setItem(KEY, JSON.stringify(cm)); } catch { /* storage full or blocked */ }
  listeners.forEach((fn) => fn(cm));
}

export function onContextChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const currentCourse = () => db.courseById.get(cm.courseId);

/**
 * The aptitude grades that matter for one course and running style, as the
 * numeric 1 = G … 8 = S the data stores. An empty slot has no uma, so it falls
 * back to A, which is what a planned Champions Meeting runner is assumed to be
 * brought up to.
 */
export function aptitudesFor(outfit, course = currentCourse(), strategy = null) {
  if (!outfit) return null;
  const distanceKey = ['', 'sprint', 'mile', 'medium', 'long'][course.distanceType];
  const surfaceKey = course.surface === 1 ? 'turf' : 'dirt';
  const styleKey = STRATEGY_KEY[strategy ?? outfit.strategy];
  return {
    distance: outfit.aptitudes[distanceKey] ?? 7,
    surface: outfit.aptitudes[surfaceKey] ?? 7,
    style: outfit.aptitudes[styleKey] ?? 7,
  };
}

/** Scoring context for the model, optionally for one roster slot. */
export function scoringContext(slot = null, sim = null) {
  const course = currentCourse();
  const outfit = slot?.outfitId ? db.outfitById.get(slot.outfitId) : null;
  const strategy = slot ? (slot.strategy ?? outfit?.strategy ?? cm.strategy) : cm.strategy;
  const stats = slot ? slot.stats : cm.stats;
  const styles = fieldStyles();
  if (styles[0] !== strategy) styles[0] = strategy;
  // On the Planner there is no roster slot, so "your uma" is whatever the You
  // panel has been set to — its aptitudes are the ones the race is scored with
  // unless they have been unlocked and overridden by hand.
  const own = slot ? null : (cm.you.outfitId ? db.outfitById.get(cm.you.outfitId) : null);
  const apt = aptitudesFor(outfit, course, strategy)
    ?? (own && cm.you.lockAptitudes ? aptitudesFor(own, course, strategy) : { ...cm.aptitudes });
  return {
    course,
    strategy,
    ground: cm.ground,
    weather: cm.weather,
    season: cm.season,
    fieldSize: cm.fieldSize,
    fieldStyles: styles,
    outfit: outfit ?? own,
    uniqueLevel: cm.you.uniqueLevel,
    aptitudes: apt,
    recoveryPct: cm.recovery,
    stats,
    sim,
  };
}

/* ------------------------------------------------------------- priorities */

/**
 * One priority entry per skill group. Aiming at both Determined Descent and
 * Straight Descent is not two goals, it is one goal written twice — and it used
 * to be counted twice everywhere coverage was measured.
 */
function dedupeByGroup(ids) {
  const seenGroups = new Set();
  const out = [];
  for (const id of ids) {
    const skill = db.skillById.get(id);
    const key = skill?.groupId;
    if (key) {
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The priority entry already covering this skill's group, if there is one. */
export function priorityGroupMate(skillId) {
  const skill = db.skillById.get(skillId);
  if (!skill?.groupId) return null;
  return cm.priority.find((id) => id !== skillId && db.skillById.get(id)?.groupId === skill.groupId) ?? null;
}

export function togglePriority(skillId) {
  const i = cm.priority.indexOf(skillId);
  if (i >= 0) {
    cm.priority.splice(i, 1);
    delete cm.priorityOpts[skillId];
    commitContext();
    return;
  }
  // Picking another rank of a group already on the list moves the target to that
  // rank instead of adding a second entry for the same skill.
  const mate = priorityGroupMate(skillId);
  if (mate) {
    cm.priority.splice(cm.priority.indexOf(mate), 1, skillId);
    cm.priorityOpts[skillId] = { ...(cm.priorityOpts[mate] ?? {}) };
    delete cm.priorityOpts[mate];
  } else {
    cm.priority.push(skillId);
    cm.priorityOpts[skillId] = { anyRank: false };
  }
  commitContext();
}

/** Does this entry also accept a *weaker* rank of the same group? */
export const priorityAnyRank = (skillId) => cm.priorityOpts[skillId]?.anyRank === true;

export function togglePriorityRank(skillId) {
  cm.priorityOpts[skillId] = { ...(cm.priorityOpts[skillId] ?? {}), anyRank: !priorityAnyRank(skillId) };
  commitContext();
}

/** The full skill list your own runner takes into the race. */
export function yourSkills() {
  const out = [];
  const outfit = cm.you.outfitId ? db.outfitById.get(cm.you.outfitId) : null;
  if (outfit?.uniqueId && cm.you.unique) {
    const u = db.skillById.get(outfit.uniqueId);
    if (u) out.push(u);
  }
  for (const id of cm.raceSkills) { const s = db.skillById.get(id); if (s) out.push(s); }
  return out;
}

/** The ranks of this entry's group split into what counts and what does not. */
export function priorityLadder(skillId) {
  const skill = db.skillById.get(skillId);
  const ladder = groupLadder(skill);
  const at = ladder.findIndex((s) => s.id === skillId);
  const better = at > 0 ? ladder.slice(0, at) : [];
  const worse = at >= 0 ? ladder.slice(at + 1).filter((s) => !isPenaltySkill(s)) : [];
  const penalties = at >= 0 ? ladder.slice(at + 1).filter(isPenaltySkill) : [];
  return { skill, ladder, better, worse, penalties };
}

/**
 * Every skill id that satisfies a priority entry.
 *
 * A better rank always counts — ending a run with Right-Handed ◎ when you asked
 * for Right-Handed ○ is not a miss. A weaker rank counts only when the entry
 * says so. The × rank never counts for a positive pick, however the entry is
 * configured: it is the same skill group but the opposite effect, and treating
 * it as a match is what made green skills report themselves as already trained.
 */
export function prioritySatisfiers(skillId) {
  const { skill, better, worse } = priorityLadder(skillId);
  if (!skill) return new Set();
  const out = new Set([skillId]);
  const wantPenalty = isPenaltySkill(skill);
  for (const s of better) if (wantPenalty || !isPenaltySkill(s)) out.add(s.id);
  if (priorityAnyRank(skillId)) for (const s of worse) out.add(s.id);
  return out;
}

/* ---------------------------------------------------------------- ownership */

export const ownsUma = (id) => !cm.useOwned || cm.owned.umas.includes(id);
export const ownsCard = (id) => cm.owned.cards.includes(id);

export function toggleOwned(kind, id) {
  const list = cm.owned[kind];
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1); else list.push(id);
  commitContext();
}

export function setOwned(kind, ids) {
  cm.owned[kind] = [...new Set(ids)];
  commitContext();
}

/** Cards in this deck that are not in the collection. */
export function borrowedIn(slot, exceptIndex = -1) {
  return slot.deck.filter((id, i) => id && i !== exceptIndex && !ownsCard(id));
}

/** Which deck position currently holds the borrowed card, or -1. */
export function borrowedIndex(slot) {
  return slot.deck.findIndex((id) => id && !ownsCard(id));
}

/**
 * Can this card go in that slot without breaking the one-borrowed rule?
 * The borrowed card is not tied to a fixed position — any of the six may be the
 * friend's, there just cannot be two of them.
 */
export function canPlace(slot, deckIndex, cardId) {
  if (!cm.useOwned || ownsCard(cardId)) return true;
  return borrowedIn(slot, deckIndex).length < BORROWED_ALLOWANCE;
}

/* ------------------------------------------------------------- saved builds */

const clone = (v) => JSON.parse(JSON.stringify(v));

export function saveBuild(name) {
  const id = `b${Date.now().toString(36)}`;
  cm.builds.unshift({
    id,
    name: name || `${currentCourse().trackName} ${currentCourse().distance}m`,
    savedAt: new Date().toISOString(),
    courseId: cm.courseId,
    ground: cm.ground,
    weather: cm.weather,
    season: cm.season,
    fieldSize: cm.fieldSize,
    field: clone(cm.field),
    roster: clone(cm.roster),
    priority: [...cm.priority],
    priorityOpts: clone(cm.priorityOpts),
    // The runner herself. A saved build used to keep the race and the team but
    // not the person running it, so loading one left whatever runner happened
    // to be set — which made two builds impossible to compare.
    you: clone(cm.you),
    strategy: cm.strategy,
    stats: clone(cm.stats),
    aptitudes: clone(cm.aptitudes),
    raceSkills: [...cm.raceSkills],
    recovery: cm.recovery,
  });
  cm.builds = cm.builds.slice(0, 24);
  commitContext();
  return id;
}

export function loadBuild(id) {
  const build = cm.builds.find((b) => b.id === id);
  if (!build) return false;
  if (db.courseById.has(build.courseId)) cm.courseId = build.courseId;
  if (build.ground) cm.ground = build.ground;
  if (build.weather) cm.weather = build.weather;
  if (build.season) cm.season = build.season;
  if (build.fieldSize) cm.fieldSize = build.fieldSize;
  if (build.field) { cm.field = clone(build.field); normaliseField(); }
  cm.roster = clone(build.roster);
  normaliseRoster(cm.roster);
  cm.priority = dedupeByGroup((build.priority ?? []).filter((id) => db.skillById.has(id)));
  cm.priorityOpts = clone(build.priorityOpts ?? {});
  // Builds saved before the runner was part of a build simply have no runner
  // to restore, so the current one is left alone rather than blanked.
  if (build.you) cm.you = { ...cm.you, ...clone(build.you) };
  if (build.strategy) cm.strategy = build.strategy;
  if (build.stats) cm.stats = { ...DEFAULT_STATS, ...clone(build.stats) };
  if (build.aptitudes) cm.aptitudes = { ...DEFAULT_APT, ...clone(build.aptitudes) };
  if (build.raceSkills) cm.raceSkills = build.raceSkills.filter((id) => db.skillById.has(id));
  if (build.recovery != null) cm.recovery = build.recovery;
  commitContext();
  return true;
}

/**
 * The runner a saved build describes, without loading it.
 *
 * Comparing two builds means racing both, and racing one must not disturb the
 * live context — so this hands back just the pieces `buildSetup` needs.
 */
export function buildRunner(build) {
  if (!build) return null;
  const outfit = build.you?.outfitId ? db.outfitById.get(build.you.outfitId) : null;
  const strategy = build.strategy ?? cm.strategy;
  const course = db.courseById.get(build.courseId) ?? currentCourse();
  const skills = [];
  if (outfit?.uniqueId && build.you?.unique !== false) {
    const u = db.skillById.get(outfit.uniqueId);
    if (u) skills.push(u);
  }
  for (const id of build.raceSkills ?? []) { const s = db.skillById.get(id); if (s) skills.push(s); }
  return {
    name: build.name,
    outfit,
    strategy,
    stats: { ...DEFAULT_STATS, ...(build.stats ?? cm.stats) },
    aptitudes: outfit && build.you?.lockAptitudes !== false
      ? aptitudesFor(outfit, course, strategy)
      : { ...DEFAULT_APT, ...(build.aptitudes ?? cm.aptitudes) },
    uniqueLevel: build.you?.uniqueLevel ?? 1,
    skills,
  };
}

export function deleteBuild(id) {
  cm.builds = cm.builds.filter((b) => b.id !== id);
  commitContext();
}

export function clearRoster() {
  cm.roster = [emptySlot(), emptySlot(), emptySlot()];
  commitContext();
}
