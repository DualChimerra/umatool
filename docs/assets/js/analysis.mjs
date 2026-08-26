// Shared analysis for the Team page: what a slot can end up with, what a card
// or an uma would add to it, and the advice that falls out of both.

import { db, isObtainable } from './store.mjs';
import { cm, scoringContext, prioritySatisfiers, ownsCard, canPlace, aptitudesFor } from './context.mjs';
import { simulateRace, scoreSkill, STRATEGY, statSensitivity } from './model.mjs';

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
  const sim = simulateRace({ course, strategy: ctx.strategy, stats: ctx.stats, ground: ctx.ground, aptitudes: ctx.aptitudes, recoveryPct: cm.recovery });
  const full = { ...ctx, sim };
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
      const ctx = scoringContext({ outfitId: outfit.id, strategy: style, stats: cm.stats, deck: [] });
      const sim = simulateRace({ course, strategy: style, stats: cm.stats, ground: cm.ground, aptitudes, recoveryPct: cm.recovery });
      byContext.set(key, { valueOf: valuer({ ...ctx, aptitudes, sim }), sim });
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
    const label = `Uma ${i + 1} · ${a.outfit.charaName}`;

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

    const sens = statSensitivity({ ...a.full, recoveryPct: cm.recovery }, db.learnable.filter(isObtainable));
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
