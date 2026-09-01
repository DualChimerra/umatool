// The Champions Meeting setup shared by every page: the race, the stats you
// are building towards, the skills you decided matter, what you actually own,
// and the three-uma roster with a deck behind each one.
//
// Persisted to localStorage, so nothing is lost by switching tabs or reloading.

import { db } from './store.mjs';
import { CM_FIELD_SIZE, STRATEGY } from './model.mjs';

const KEY = 'paddock:cm';
const listeners = new Set();

export const DEFAULT_STATS = { speed: 1200, stamina: 900, power: 1000, guts: 500, wit: 900 };
export const DEFAULT_APT = { distance: 7, surface: 7, strategy: 7 };

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

  if (!db.courseById.has(cm.courseId)) {
    cm.courseId = db.courses.find((c) => c.trackName === 'Tokyo' && c.distance === 2400 && c.surface === 1)?.id
      ?? db.courses[0].id;
  }
  cm.priority = cm.priority.filter((id) => db.skillById.has(id));
  cm.raceSkills = (cm.raceSkills ?? []).filter((id) => db.skillById.has(id));
  cm.you = { outfitId: null, uniqueLevel: 1, unique: true, lockAptitudes: true, ...(cm.you ?? {}) };
  if (cm.you.outfitId && !db.outfitById.has(cm.you.outfitId)) cm.you.outfitId = null;
  cm.you.uniqueLevel = Math.max(1, Math.min(6, Number(cm.you.uniqueLevel) || 1));
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
  const apt = outfit ? outfitAptitudes(outfit, course, strategy)
    : own && cm.you.lockAptitudes ? outfitAptitudes(own, course, strategy)
      : { ...cm.aptitudes };
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

/** An outfit's aptitude for this exact race, as grades 1 (G) … 8 (S). */
export function outfitAptitudes(outfit, course = currentCourse(), strategy = null) {
  const dist = ['', 'sprint', 'mile', 'medium', 'long'][course.distanceType];
  const surf = course.surface === 1 ? 'turf' : 'dirt';
  const style = STRATEGY[strategy ?? outfit.strategy]?.key ?? 'pace';
  return {
    distance: outfit.aptitudes[dist] ?? 7,
    surface: outfit.aptitudes[surf] ?? 7,
    strategy: outfit.aptitudes[style] ?? 7,
  };
}

/* ------------------------------------------------------------- priorities */

export function togglePriority(skillId) {
  const i = cm.priority.indexOf(skillId);
  if (i >= 0) {
    cm.priority.splice(i, 1);
    delete cm.priorityOpts[skillId];
  } else {
    cm.priority.push(skillId);
    cm.priorityOpts[skillId] = { anyRank: true };
  }
  commitContext();
}

export const priorityAnyRank = (skillId) => cm.priorityOpts[skillId]?.anyRank !== false;

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

/**
 * Every skill id that satisfies a priority entry — the skill itself, plus the
 * other ranks of its group when the entry accepts them.
 */
export function prioritySatisfiers(skillId) {
  const skill = db.skillById.get(skillId);
  if (!skill) return new Set();
  if (!priorityAnyRank(skillId) || !skill.groupId) return new Set([skillId]);
  return new Set((db.skillsByGroup.get(skill.groupId) ?? [skill]).filter((s) => !s.inherited).map((s) => s.id));
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

/** Can this card go in that slot without breaking the one-borrowed rule? */
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
  cm.priority = [...(build.priority ?? [])];
  cm.priorityOpts = clone(build.priorityOpts ?? {});
  commitContext();
  return true;
}

export function deleteBuild(id) {
  cm.builds = cm.builds.filter((b) => b.id !== id);
  commitContext();
}

export function clearRoster() {
  cm.roster = [emptySlot(), emptySlot(), emptySlot()];
  commitContext();
}
