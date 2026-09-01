// Turning "the race I am preparing for" into a field the simulator can run.
//
// A Champions Meeting is not a time trial. Which running styles are in front of
// you decides whether an `order_rate<=40` skill ever fires, whether you spend
// the back straight boxed in, and whether a debuff aimed at Front Runners has
// anybody to land on. So the field is a first-class input, with two ways in:
//
//   * **simple** — how many of each running style. That is what you actually
//     know before a Champions Meeting round, and it is enough to move every
//     positional number in the app.
//   * **advanced** — build each rival out: the umamusume (its unique comes
//     along automatically), stats, running style and the skills it is carrying.
//
// Rivals left generic are given a plausible kit rather than an empty one: a
// field of nine runners with no skills at all would make your own skills look
// twice as good as they are.

import { db, isObtainable } from '../store.mjs';
import { cm, fieldStyles, outfitAptitudes, yourSkills, DEFAULT_STATS, DEFAULT_APT } from '../context.mjs';
import { rankSkills, simulateRace, STRATEGY, atUniqueLevel } from '../model.mjs';

/** Skills a generic rival of this style would plausibly have finished with. */
const genericCache = new Map();
function genericKit(course, strategy, ctx, depth) {
  const key = `${course.id}|${strategy}|${ctx.ground}|${ctx.weather}|${ctx.season}|${depth}`;
  let hit = genericCache.get(key);
  if (hit) return hit;
  const sub = { ...ctx, strategy, sim: null };
  sub.sim = simulateRace(sub);
  hit = rankSkills(db.learnable.filter(isObtainable), sub, { tiers: ['gold', 'normal'], limit: depth })
    .map((r) => r.skill);
  genericCache.set(key, hit);
  return hit;
}

export function clearFieldCache() { genericCache.clear(); }

function statsFor(base, strength) {
  const out = {};
  for (const [k, v] of Object.entries(base)) out[k] = Math.max(100, Math.round(v * strength));
  return out;
}

/**
 * Build a simulator setup from the current context.
 *
 * @param {object} you  { name, strategy, stats, aptitudes, skills } — overrides
 *                      for the runner being planned. Defaults to the planner's
 *                      own stat line and running style.
 * @returns {{setup: object, playerIndex: number, notes: string[]}}
 */
export function buildSetup(you = {}, ctx) {
  const course = ctx.course;
  const notes = [];
  const strategy = you.strategy ?? ctx.strategy;

  const myOutfit = cm.you.outfitId ? db.outfitById.get(cm.you.outfitId) : null;
  const player = {
    id: 'you',
    name: you.name ?? (myOutfit ? myOutfit.charaName : 'You'),
    player: true,
    outfit: myOutfit,
    strategy,
    stats: you.stats ?? ctx.stats,
    aptitudes: you.aptitudes ?? ctx.aptitudes ?? { ...DEFAULT_APT },
    skills: (you.skills ?? yourSkills()).map((s) => atUniqueLevel(s, cm.you.uniqueLevel)),
  };

  const runners = [player];
  const f = cm.field;

  if (f.mode === 'advanced') {
    for (const [i, r] of f.rivals.entries()) {
      const outfit = r.outfitId ? db.outfitById.get(r.outfitId) : null;
      const style = r.strategy ?? outfit?.strategy ?? 2;
      const skills = [];
      if (outfit && r.unique && outfit.uniqueId && db.skillById.has(outfit.uniqueId)) {
        skills.push(atUniqueLevel(db.skillById.get(outfit.uniqueId), r.uniqueLevel ?? 3));
      }
      for (const id of r.skills ?? []) { const s = db.skillById.get(id); if (s) skills.push(s); }
      runners.push({
        id: `rival${i}`,
        name: outfit ? outfit.charaName : `${STRATEGY[style].short} ${i + 1}`,
        outfit,
        strategy: style,
        stats: r.stats ?? { ...DEFAULT_STATS },
        aptitudes: outfit ? outfitAptitudes(outfit, course, style) : { ...DEFAULT_APT },
        skills,
      });
    }
  } else {
    const styles = fieldStyles().slice(1);
    const depth = Math.max(0, Math.round(f.skillDepth ?? 4));
    for (const [i, style] of styles.entries()) {
      runners.push({
        id: `rival${i}`,
        name: `${STRATEGY[style].short} ${styles.slice(0, i).filter((s) => s === style).length + 1}`,
        strategy: style,
        stats: statsFor(ctx.stats, f.strength ?? 0.92),
        aptitudes: { ...DEFAULT_APT },
        skills: depth ? genericKit(course, style, ctx, depth) : [],
      });
    }
    notes.push(`Rivals run at ${Math.round((f.strength ?? 0.92) * 100)}% of your stat line, A aptitudes, and the ${depth} best skills for their style on this course.`);
  }

  return {
    setup: {
      course,
      ground: ctx.ground ?? 1,
      weather: ctx.weather ?? 1,
      season: ctx.season ?? 1,
      runners: runners.slice(0, cm.fieldSize),
    },
    playerIndex: 0,
    notes,
  };
}

/** Presets for the simple field editor. */
export const FIELD_PRESETS = [
  { key: 'balanced', name: 'Balanced', counts: { 1: 2, 2: 2, 3: 2, 4: 2 }, hint: 'Two of each — the default read on an unknown round.' },
  { key: 'front', name: 'Front-heavy', counts: { 1: 4, 2: 2, 3: 1, 4: 1 }, hint: 'A fast pace: positional skills fire lower down the field.' },
  { key: 'closer', name: 'Closer-heavy', counts: { 1: 1, 2: 1, 3: 3, 4: 3 }, hint: 'A slow pace with a crowded finish.' },
  { key: 'pace', name: 'Pace-heavy', counts: { 1: 1, 2: 4, 3: 2, 4: 1 }, hint: 'The usual shape of a Global Champions Meeting.' },
];
