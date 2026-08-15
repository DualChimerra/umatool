// Loads the generated data set once and hands out the indexes every view needs.

const files = ['skills', 'characters', 'supports', 'courses', 'groups', 'meta'];

export const db = {
  skills: [], characters: [], supports: [], courses: [], groups: {}, meta: {},
  skillById: new Map(),
  skillsByGroup: new Map(),
  outfitById: new Map(),
  supportById: new Map(),
  courseById: new Map(),
  globalOutfits: [],
  learnable: [],
};

export async function loadData() {
  const loaded = await Promise.all(files.map(async (name) => {
    const res = await fetch(`./data/${name}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Could not load data/${name}.json (${res.status})`);
    return [name, await res.json()];
  }));
  for (const [name, value] of loaded) db[name] = value;

  for (const s of db.skills) {
    db.skillById.set(s.id, s);
    if (s.groupId) {
      if (!db.skillsByGroup.has(s.groupId)) db.skillsByGroup.set(s.groupId, []);
      db.skillsByGroup.get(s.groupId).push(s);
    }
  }
  for (const list of db.skillsByGroup.values()) list.sort((a, b) => b.tierRank - a.tierRank);

  db.learnable = db.skills.filter((s) => !s.inherited);

  for (const c of db.characters) {
    for (const o of c.outfits) {
      o.charaName = c.name;
      o.charaId = c.id;
      o.displayName = `${c.name} (${o.epithet})`;
      db.outfitById.set(o.id, o);
    }
  }
  db.globalOutfits = [...db.outfitById.values()].filter((o) => o.global !== false);
  for (const s of db.supports) db.supportById.set(s.id, s);
  for (const c of db.courses) db.courseById.set(c.id, c);

  return db;
}

/** Every skill sharing a rank group — Determined Descent ⇄ Straight Descent. */
export function groupSiblings(skillId) {
  const skill = db.skillById.get(skillId);
  if (!skill || !skill.groupId) return skill ? [skill] : [];
  return db.skillsByGroup.get(skill.groupId) ?? [skill];
}

/**
 * Expand a set of selected skill ids into the ids that should count as a match.
 * With `includeOtherRanks`, picking the gold version also matches the normal
 * version of the same skill (and the other way round).
 */
export function expandSelection(ids, includeOtherRanks) {
  const out = new Map();
  for (const id of ids) {
    const skill = db.skillById.get(id);
    if (!skill) continue;
    out.set(id, { id, via: 'exact', root: id });
    if (!includeOtherRanks) continue;
    for (const sib of groupSiblings(id)) {
      if (sib.id === id || sib.inherited) continue;
      if (!out.has(sib.id)) out.set(sib.id, { id: sib.id, via: 'rank', root: id });
    }
  }
  return out;
}

/**
 * Can this skill actually be acquired in a training run on Global? Scenario
 * rewards and inherited uniques score well but no card or uma teaches them, so
 * they are separated out rather than sitting at the top of a planning list.
 */
export function isObtainable(skill) {
  const s = skill?.sources;
  if (!s) return false;
  return s.unique.length > 0 || s.characters.length > 0
    || s.event.some((id) => db.supportById.get(id)?.global)
    || s.hint.some((id) => db.supportById.get(id)?.global);
}

export function skillIconUrl(skill) {
  return skill?.iconId ? `./img/skill/${skill.iconId}.webp` : './img/skill/placeholder.webp';
}
