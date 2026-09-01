// Shared analysis for the Team page: what a slot can end up with, what a card
// or an uma would add to it, and the advice that falls out of both.

import { db, isObtainable } from './store.mjs';
import { cm, scoringContext, prioritySatisfiers, ownsCard, canPlace, outfitAptitudes } from './context.mjs';
import { simulateRace, scoreSkill, STRATEGY, statSensitivity } from './model.mjs';

// A hint has to be rolled and paid for, so it is not worth an event skill the
// training run hands you outright.
export const HINT_CONFIDENCE = 0.6;

const KIND_WEIGHT = { unique: 1, own: 1, event: 1, hint: HINT_CONFIDENCE };
const KIND_RANK = { unique: 4, own: 3, event: 2, hint: 1 };

/** Memoised skill valuation for one scoring context. */
export function valuer(full) {
  const cache = new Map();
  return (skill) => {
    if (!skill) return null;
    if (!cache.has(skill.id)) cache.set(skill.id, scoreSkill(skill, full));
    return cache.get(skill.id);
  };
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
    for (const id of card.eventSkills) note(id, 'event', card.id);
    for (const id of card.hintSkills) note(id, 'hint', card.id);
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
 */
export function rankCards(analysis, deckIndex, { ownedOnly = cm.useOwned, query = '', type = null } = {}) {
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
    const owned = ownsCard(card.id);
    if (ownedOnly && !owned && !canPlace(slot, deckIndex, card.id)) continue;

    let gain = 0;
    let existing = 0;
    const newPriority = [];
    const skills = [];
    for (const [ids, kind] of [[card.eventSkills, 'event'], [card.hintSkills, 'hint']]) {
      for (const id of ids) {
        const skill = db.skillById.get(id);
        if (!skill) continue;
        const scored = valueOf(skill);
        const value = (scored?.bashin ?? 0) * KIND_WEIGHT[kind];
        const held = origin.has(id);
        skills.push({ skill, kind, value, held, scored });
        if (held) existing += value; else gain += value;
        if (!held) {
          for (const { id: pid, set } of prioritySets) {
            if (!alreadyCovered.has(pid) && set.has(id) && !newPriority.includes(pid)) newPriority.push(pid);
          }
        }
      }
    }
    skills.sort((a, b) => b.value - a.value);
    out.push({
      card, owned, gain, existing, newPriority, skills,
      inDeck: inDeck.has(card.id),
      blocked: !owned && !canPlace(slot, deckIndex, card.id),
      // Priorities lead the ordering; when the collection restriction is on,
      // cards you actually own outrank the one you could borrow.
      rank: (ownedOnly && owned ? 1000 : 0) + newPriority.length * 10 + gain,
    });
  }
  out.sort((a, b) => b.rank - a.rank || b.gain - a.gain);
  return out;
}

/** Rank umamusume by what their own kit is worth on this course. */
export function rankUmas({ ownedOnly = cm.useOwned, query = '', strategy = null } = {}) {
  const course = db.courseById.get(cm.courseId);
  const needle = query.trim().toLowerCase();
  const aptDistance = ['', 'sprint', 'mile', 'medium', 'long'][course.distanceType];
  const aptSurface = course.surface === 1 ? 'turf' : 'dirt';

  const byStrategy = new Map();
  const out = [];
  for (const outfit of db.globalOutfits) {
    if (needle && !outfit.displayName.toLowerCase().includes(needle)) continue;
    const style = strategy ?? outfit.strategy;
    if (strategy && outfit.strategy !== strategy) continue;
    if (ownedOnly && !cm.owned.umas.includes(outfit.id)) continue;

    const cacheKey = `${style}|${outfit.aptitudes[aptDistance]}|${outfit.aptitudes[aptSurface]}|${outfit.aptitudes[STRATEGY[style].key]}`;
    if (!byStrategy.has(cacheKey)) {
      const ctx = scoringContext({ outfitId: outfit.id, strategy: style, stats: cm.stats, deck: [] });
      ctx.aptitudes = outfitAptitudes(outfit, course, style);
      const sim = simulateRace({ ...ctx, recoveryPct: cm.recovery });
      byStrategy.set(cacheKey, valuer({ ...ctx, sim, recoveryPct: cm.recovery }));
    }
    const valueOf = byStrategy.get(cacheKey);

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

    const aptOk = (outfit.aptitudes[aptDistance] >= 7 ? 1 : 0.75)
      * (outfit.aptitudes[aptSurface] >= 7 ? 1 : 0.7)
      * (outfit.aptitudes[STRATEGY[style].key] >= 7 ? 1 : 0.8);

    out.push({
      outfit, value, unique, skills, aptOk,
      gold: skills.filter((s) => s.skill?.tier === 'gold').length,
      rank: value * aptOk,
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
          `Below A costs speed and stamina outright. Fix it with the matching aptitude item, or run a different uma here.`, { slot: i });
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
        .filter((c) => c.newPriority.length && !c.inDeck)[0];
      push(missing.length > cm.priority.length / 2 ? 'warn' : 'tip',
        `${label}: ${missing.length} priority skill${missing.length === 1 ? '' : 's'} unreachable`,
        best
          ? `Nothing in this run teaches ${missing.slice(0, 3).map((m) => m.skill.name).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}. ${best.card.name} (${best.card.rarityName} ${best.card.typeName}) would newly cover ${best.newPriority.length} of them and add ${best.gain.toFixed(2)} lengths.`
          : `Nothing in this run teaches ${missing.slice(0, 3).map((m) => m.skill.name).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}, and no Global card covers them either.`,
        { slot: i, card: best?.card.id });
    }

    const sens = statSensitivity(a.full, db.learnable.filter(isObtainable));
    const ordered = Object.entries(sens).filter(([, v]) => v.bashin != null).sort((x, y) => y[1].bashin - x[1].bashin);
    if (ordered.length) {
      const [bestStat, bestVal] = ordered[0];
      const [worstStat, worstVal] = ordered[ordered.length - 1];
      push('tip', `${label}: next points go into ${bestStat.charAt(0).toUpperCase() + bestStat.slice(1)}`,
        `+100 ${bestStat} is worth ${bestVal.bashin.toFixed(2)} lengths here, against ${worstVal.bashin.toFixed(2)} for ${worstStat}. Measured by re-running the race with the extra points.`,
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
