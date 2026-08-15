// The Champions Meeting setup shared by every page: which race you are
// preparing for, the stats you are building towards, the skills you have
// decided matter, and the three-uma roster with a deck behind each one.
//
// Persisted to localStorage so switching tabs never loses the setup.

import { db } from './store.mjs';
import { CM_FIELD_SIZE } from './model.mjs';

const KEY = 'paddock:cm';
const listeners = new Set();

export const DEFAULT_STATS = { speed: 1200, stamina: 900, power: 1000, guts: 500, wit: 900 };

function emptySlot() {
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
    priority: [],            // skill ids the user wants to prioritise
    roster: [emptySlot(), emptySlot(), emptySlot()],
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
  while (cm.roster.length < 3) cm.roster.push(emptySlot());
  cm.roster = cm.roster.slice(0, 3);
  for (const slot of cm.roster) {
    if (slot.outfitId && !db.outfitById.has(slot.outfitId)) slot.outfitId = null;
    slot.deck = [...(slot.deck ?? []), null, null, null, null, null, null].slice(0, 6)
      .map((id) => (id && db.supportById.has(id) ? id : null));
    slot.stats = { ...DEFAULT_STATS, ...(slot.stats ?? {}) };
  }
  return cm;
}

function merge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') merge(target[k], v);
    else target[k] = v;
  }
}

export function updateContext(patch = {}) {
  merge(cm, patch);
  save();
  listeners.forEach((fn) => fn(cm));
}

/** Mutate `cm` directly, then call this. */
export function commitContext() {
  save();
  listeners.forEach((fn) => fn(cm));
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cm)); } catch { /* storage full or blocked */ }
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

export function togglePriority(skillId) {
  const i = cm.priority.indexOf(skillId);
  if (i >= 0) cm.priority.splice(i, 1); else cm.priority.push(skillId);
  commitContext();
}
