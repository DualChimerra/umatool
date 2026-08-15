// The Champions Meeting setup shared by every page: the race, the stats you
// are building towards, the skills you decided matter, what you actually own,
// and the three-uma roster with a deck behind each one.
//
// Persisted to localStorage, so nothing is lost by switching tabs or reloading.

import { db } from './store.mjs';
import { CM_FIELD_SIZE } from './model.mjs';

const KEY = 'paddock:cm';
const listeners = new Set();

export const DEFAULT_STATS = { speed: 1200, stamina: 900, power: 1000, guts: 500, wit: 900 };

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
  cm.owned.umas = (cm.owned.umas ?? []).filter((id) => db.outfitById.has(id));
  cm.owned.cards = (cm.owned.cards ?? []).filter((id) => db.supportById.has(id));
  normaliseRoster(cm.roster);
  for (const build of cm.builds ?? []) normaliseRoster(build.roster ?? []);
  return cm;
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
  return {
    course,
    strategy,
    ground: cm.ground,
    fieldSize: cm.fieldSize,
    recoveryPct: cm.recovery,
    stats,
    sim,
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
    fieldSize: cm.fieldSize,
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
  if (build.fieldSize) cm.fieldSize = build.fieldSize;
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
