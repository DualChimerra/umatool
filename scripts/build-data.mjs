#!/usr/bin/env node
// Builds every JSON file the site reads.
//
//   node scripts/build-data.mjs [--local <path to uma-tools checkout>] [--no-gametora]
//
// Two sources feed the build:
//   1. the Global client's master-database dump (structure + the release filter)
//   2. GameTora (release dates + canonical Global spellings), best-effort
//
// Output lands in docs/data/. Everything is precomputed here so the browser
// only ever loads flat arrays.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMasterDump } from './sources/masterdump.mjs';
import { loadGametora } from './sources/gametora.mjs';
import { analyseCondition } from './lib/conditions.mjs';
import {
  APTITUDE_COLUMNS, APTITUDE_GRADE, SUPPORT_TYPE, SUPPORT_RARITY,
  SKILL_RARITY, effectType, DISTANCE_TYPE, SURFACE, RUNNING_STYLE,
} from './lib/gamedata.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'data');

const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const localRoot = argOf('--local');
const useGametora = !args.includes('--no-gametora');

const log = (...a) => console.log(...a);

/* ------------------------------------------------------------------ skills */

/**
 * Global unique skills are derived from the outfit id, mirroring how the game
 * numbers them: outfit 100101 -> unique 100011, outfit 100302 -> unique 110031.
 */
function uniqueSkillForOutfit(outfitId) {
  const id = String(outfitId);
  const chara = Number(id.slice(1, -2));
  const variant = Number(id.slice(-2));
  return String(100000 + 10000 * (variant - 1) + chara * 10 + 1);
}

function buildSkills(dump, trackName) {
  const { skillData, skillMeta, skillNames } = dump;
  const skills = [];

  for (const [id, data] of Object.entries(skillData)) {
    const meta = skillMeta[id] || {};
    const name = skillNames[id]?.[0] ?? `Skill ${id}`;
    const tier = SKILL_RARITY[data.rarity] || { key: 'normal', name: 'Normal', rank: 1 };

    const variants = data.alternatives.map((alt) => {
      const analysis = analyseCondition(alt.condition, alt.precondition, { trackName });
      return {
        text: analysis.text,
        facets: analysis.facets,
        duration: alt.baseDuration / 10000,
        effects: alt.effects.map((e) => {
          const t = effectType(e.type);
          return {
            type: e.type, key: t.key, label: t.label, kind: t.kind, unit: t.unit,
            value: Number((e.modifier * t.scale).toFixed(4)),
            target: e.target,
          };
        }),
        raw: { condition: alt.condition, precondition: alt.precondition },
      };
    });

    // Union the facets of every alternative: a skill is "usable on dirt" if any
    // of its branches works on dirt.
    const facets = mergeVariantFacets(variants.map((v) => v.facets));
    const effects = mergeEffects(variants.flatMap((v) => v.effects));
    variants.forEach((v) => { delete v.facets; });

    skills.push({
      id,
      name,
      groupId: meta.groupId ?? null,
      tier: tier.key,
      tierName: tier.name,
      tierRank: tier.rank,
      cost: meta.baseCost ?? 0,
      score: meta.score ?? 0,
      iconId: meta.iconId ?? null,
      order: meta.order ?? 0,
      wisdomCheck: !!data.wisdomCheck,
      duration: Math.max(...variants.map((v) => v.duration), 0),
      effects,
      facets,
      variants,
      inherited: id.startsWith('9'),
    });
  }

  skills.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return skills;
}

function mergeVariantFacets(list) {
  if (list.length === 1) return list[0];
  const out = {
    phases: [], strategies: [], distanceTypes: [], surfaces: [], groundConditions: [],
    weathers: [], seasons: [], rotations: [], trackIds: [], terrain: [], needs: [],
    position: {}, window: {}, random: false, late: false, passive: false,
  };
  let firstWindow = true;
  for (const f of list) {
    for (const k of ['phases', 'strategies', 'distanceTypes', 'surfaces', 'groundConditions', 'weathers', 'seasons', 'rotations', 'trackIds', 'terrain', 'needs']) {
      out[k] = [...new Set([...(out[k] || []), ...(f[k] || [])])];
    }
    for (const k of ['random', 'late', 'passive']) out[k] = out[k] || f[k];
    for (const [k, v] of Object.entries(f.position || {})) {
      if (out.position[k] === undefined) out.position[k] = v;
      else out.position[k] = k.endsWith('Max') ? Math.max(out.position[k], v) : Math.min(out.position[k], v);
    }
    // Alternatives are OR-ed, so a bound only survives if every branch has it,
    // and then the loosest one wins.
    const w = f.window || {};
    if (firstWindow) { Object.assign(out.window, w); firstWindow = false; } else {
      for (const k of ['rateMin', 'rateMax', 'remainMin', 'remainMax']) {
        if (w[k] === undefined || out.window[k] === undefined) { delete out.window[k]; continue; }
        out.window[k] = (k === 'rateMin' || k === 'remainMin')
          ? Math.min(out.window[k], w[k]) : Math.max(out.window[k], w[k]);
      }
    }
  }
  for (const k of ['phases', 'strategies', 'distanceTypes', 'surfaces', 'groundConditions', 'weathers', 'seasons', 'rotations']) {
    out[k].sort((a, b) => a - b);
  }
  return out;
}

function mergeEffects(effects) {
  const byKey = new Map();
  for (const e of effects) {
    const prev = byKey.get(e.key);
    if (!prev || Math.abs(e.value) > Math.abs(prev.value)) byKey.set(e.key, e);
  }
  return [...byKey.values()];
}

/* -------------------------------------------------------------- characters */

function buildCharacters(dump, skillById, overrides = {}) {
  const out = [];
  for (const [charaId, chara] of Object.entries(dump.umas)) {
    const outfits = [];
    for (const [outfitId, o] of Object.entries(chara.outfits)) {
      const aptitudes = {};
      APTITUDE_COLUMNS.forEach((key, i) => { aptitudes[key] = o.aptitudes[i]; });

      const uniqueId = uniqueSkillForOutfit(outfitId);
      const skillIds = (o.awakenings || []).filter((s) => skillById.has(s));

      // The Global client ships data slightly ahead of the banner, so an
      // outfit can be present here before it is playable. Overrides pin those.
      const pinned = overrides[outfitId] ?? overrides[charaId];
      outfits.push({
        id: outfitId,
        global: pinned === undefined ? true : !!pinned,
        epithet: (o.epithet || '').replace(/^\[|\]$/g, ''),
        stars: o.rarity,
        strategy: o.strategy,
        strategyName: RUNNING_STYLE[o.strategy]?.name ?? '—',
        aptitudes,
        aptitudeGrades: Object.fromEntries(Object.entries(aptitudes).map(([k, v]) => [k, APTITUDE_GRADE[v] ?? '-'])),
        uniqueId: skillById.has(uniqueId) ? uniqueId : null,
        skillIds,
      });
    }
    outfits.sort((a, b) => a.id.localeCompare(b.id));
    out.push({ id: charaId, name: chara.name[1] || chara.name[0], outfits, global: outfits.some((o) => o.global) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/* ------------------------------------------------------------- support cards */

function buildSupports(dump, globalSkillIds, overrides, gametora) {
  const out = [];
  for (const [id, card] of Object.entries(dump.cards)) {
    const eventSkills = card.event || [];
    const hintSkills = card.hints || [];
    const all = [...eventSkills, ...hintSkills];
    const missing = all.filter((s) => !globalSkillIds.has(s));

    let isGlobal = missing.length === 0;
    let releaseSource = 'skill-set inference';
    let release = null;

    const gt = gametora?.supports?.[id];
    if (gt && (gt.release !== undefined)) {
      isGlobal = !!gt.release;
      release = gt.release;
      releaseSource = 'gametora';
    }
    if (Object.prototype.hasOwnProperty.call(overrides, id)) {
      isGlobal = !!overrides[id];
      releaseSource = 'manual override';
    }

    // Cards released long after the Global frontier that only pass because they
    // reuse old skills are flagged rather than silently trusted.
    const unverified = releaseSource === 'skill-set inference' && isGlobal && Number(id.slice(1)) > 200;

    out.push({
      id,
      seq: Number(id.slice(1)),
      unverified,
      name: card.name[1] || card.name[0],
      type: SUPPORT_TYPE[card.type]?.key ?? 'other',
      typeName: SUPPORT_TYPE[card.type]?.name ?? '—',
      rarity: card.rarity,
      rarityName: SUPPORT_RARITY[card.rarity] ?? '?',
      eventSkills,
      hintSkills,
      global: isGlobal,
      release,
      releaseSource,
      missingSkills: missing.length,
    });
  }
  out.sort((a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name));
  return out;
}

/* ------------------------------------------------------------------ courses */

function buildCourses(dump) {
  const out = [];
  for (const [id, c] of Object.entries(dump.courses)) {
    const d = c.distance;
    const straights = c.straights || [];
    const corners = c.corners || [];
    const slopes = c.slopes || [];

    const lastStraight = straights.length ? straights[straights.length - 1] : null;
    const finalCorner = corners.length ? corners[corners.length - 1] : null;
    const uphill = slopes.filter((s) => s.slope > 0);
    const downhill = slopes.filter((s) => s.slope < 0);

    out.push({
      id,
      trackId: String(c.raceTrackId),
      trackName: dump.trackNames[c.raceTrackId]?.[1] ?? `Track ${c.raceTrackId}`,
      course: c.course,
      distance: d,
      distanceType: c.distanceType,
      distanceTypeName: DISTANCE_TYPE[c.distanceType]?.name ?? '—',
      surface: c.surface,
      surfaceName: SURFACE[c.surface]?.name ?? '—',
      turn: c.turn,
      turnName: c.turn === 1 ? 'Right' : c.turn === 2 ? 'Left' : 'Straight',
      corners,
      straights,
      slopes,
      courseSetStatus: c.courseSetStatus || [],
      phases: { opening: [0, d / 6], middle: [d / 6, (d * 2) / 3], final: [(d * 2) / 3, d] },
      derived: {
        cornerLength: corners.reduce((s, c2) => s + c2.length, 0),
        cornerCount: corners.length,
        finalCornerStart: finalCorner ? finalCorner.start : null,
        finalCornerEnd: finalCorner ? finalCorner.start + finalCorner.length : null,
        lastStraightLength: lastStraight ? lastStraight.end - lastStraight.start : 0,
        lastStraightStart: lastStraight ? lastStraight.start : null,
        uphillLength: uphill.reduce((s, x) => s + x.length, 0),
        downhillLength: downhill.reduce((s, x) => s + x.length, 0),
        uphill,
        downhill,
      },
    });
  }
  out.sort((a, b) => a.trackName.localeCompare(b.trackName) || a.distance - b.distance);
  return out;
}

/* --------------------------------------------------------------------- main */

async function readOverrides(file) {
  try {
    return JSON.parse(await readFile(path.join(ROOT, 'data-overrides', file), 'utf8'));
  } catch { return {}; }
}

async function main() {
  log('Loading master-database dump…');
  const dump = await loadMasterDump({ localRoot, log });

  const trackName = (id) => dump.trackNames[id]?.[1] ?? `track ${id}`;

  let gametora = null;
  if (useGametora) {
    log('Checking GameTora…');
    try {
      gametora = await loadGametora({ log });
    } catch (err) {
      log(`  gametora: failed (${err.message}) — continuing with dump data`);
    }
  }

  log('Building skills…');
  const skills = buildSkills(dump, trackName);
  const skillById = new Map(skills.map((s) => [s.id, s]));

  log('Building characters…');
  const characterOverrides = await readOverrides('characters.json');
  const characters = buildCharacters(dump, skillById, characterOverrides);

  log('Building support cards…');
  const globalSkillIds = new Set(Object.keys(dump.skillMeta));
  const overrides = await readOverrides('supports.json');
  const supports = buildSupports(dump, globalSkillIds, overrides, gametora);

  log('Building courses…');
  const courses = buildCourses(dump);

  // Reverse index: where can this skill be obtained?
  const sources = new Map();
  const bucket = (id) => {
    if (!sources.has(id)) sources.set(id, { characters: [], event: [], hint: [], unique: [] });
    return sources.get(id);
  };
  for (const c of characters) {
    for (const o of c.outfits) {
      if (!o.global) continue;
      if (o.uniqueId) bucket(o.uniqueId).unique.push(o.id);
      for (const s of o.skillIds) bucket(s).characters.push(o.id);
    }
  }
  for (const card of supports.filter((c) => c.global)) {
    for (const s of card.eventSkills) bucket(s).event.push(card.id);
    for (const s of card.hintSkills) bucket(s).hint.push(card.id);
  }
  for (const s of skills) s.sources = sources.get(s.id) ?? { characters: [], event: [], hint: [], unique: [] };

  // Names used by the "also match the other rank of this skill" toggle.
  const groups = new Map();
  for (const s of skills) {
    if (!s.groupId) continue;
    if (!groups.has(s.groupId)) groups.set(s.groupId, []);
    groups.get(s.groupId).push(s.id);
  }

  const globalSupports = supports.filter((s) => s.global);
  const meta = {
    generatedAt: new Date().toISOString(),
    counts: {
      skills: skills.length,
      learnableSkills: skills.filter((s) => !s.inherited).length,
      characters: characters.length,
      outfits: characters.reduce((n, c) => n + c.outfits.length, 0),
      supports: globalSupports.length,
      supportsAll: supports.length,
      supportsUnverified: globalSupports.filter((s) => s.unverified).length,
      outfitsHidden: characters.reduce((n, c) => n + c.outfits.filter((o) => !o.global).length, 0),
      courses: courses.length,
    },
    gametora: gametora ? { ok: gametora.ok, counts: gametora.counts, notes: gametora.notes.slice(0, 6) } : { ok: false, notes: ['skipped'] },
    sources: [
      { name: 'Global master database dump', via: 'alpha123/uma-tools (umalator-global)' },
      { name: 'GameTora', via: 'release dates and Global naming', ok: !!gametora?.ok },
    ],
  };

  await mkdir(OUT, { recursive: true });
  const write = async (file, data) => {
    await writeFile(path.join(OUT, file), JSON.stringify(data));
    log(`  wrote data/${file} (${(JSON.stringify(data).length / 1024).toFixed(0)} kB)`);
  };
  await write('skills.json', skills);
  await write('characters.json', characters);
  await write('supports.json', supports);
  await write('courses.json', courses);
  await write('groups.json', Object.fromEntries(groups));
  await write('meta.json', meta);

  log(`\nDone. ${meta.counts.learnableSkills} skills, ${meta.counts.outfits} outfits, ${meta.counts.supports} Global support cards.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
