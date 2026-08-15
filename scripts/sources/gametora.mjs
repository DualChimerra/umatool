// Release-date pass against GameTora.
//
// GameTora keeps its game data in content-hashed JSON files and publishes an
// index of them at /data/manifests/umamusume.json:
//
//   { "support-cards": "4d092416", "character-cards": "785343d8", … }
//   ->  /data/umamusume/support-cards.4d092416.json
//
// That index is what the site itself loads on every page, so it is the same
// data GameTora renders from — no HTML scraping, no bundle spelunking.
//
// What we take from here:
//   * `release_en` on every support card and every character outfit — the
//     authoritative "is it out on Global yet" signal. Everything mechanical
//     (skill conditions, aptitudes, course geometry) comes from the
//     master-database dump instead.
//
// The payloads are small enough to keep a copy of: build-data.mjs snapshots the
// release table so a later build survives GameTora being unreachable.

import { getJson } from '../lib/http.mjs';

const BASE = 'https://gametora.com';
const MANIFEST = `${BASE}/data/manifests/umamusume.json`;
const dataUrl = (name, hash) => `${BASE}/data/umamusume/${name}.${hash}.json`;

const today = () => new Date().toISOString().slice(0, 10);

/** A date string counts as released only once it is actually in the past. */
function released(date, asOf) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= asOf;
}

export async function loadGametora({ log = console.log, asOf = today() } = {}) {
  const result = { ok: false, supports: {}, characters: {}, notes: [], asOf };

  const manifest = await getJson(MANIFEST, { retries: 2, timeout: 45000 });
  const hashOf = (key) => {
    const hash = manifest?.[key];
    if (typeof hash !== 'string') throw new Error(`manifest has no "${key}" entry`);
    return hash;
  };

  const [supportCards, characterCards] = await Promise.all([
    getJson(dataUrl('support-cards', hashOf('support-cards')), { retries: 2, timeout: 45000 }),
    getJson(dataUrl('character-cards', hashOf('character-cards')), { retries: 2, timeout: 45000 }),
  ]);

  if (!Array.isArray(supportCards) || !supportCards.length) throw new Error('support-cards payload is not a list');
  if (!Array.isArray(characterCards) || !characterCards.length) throw new Error('character-cards payload is not a list');

  for (const row of supportCards) {
    const id = String(row.support_id ?? '');
    if (!id) continue;
    result.supports[id] = {
      global: released(row.release_en, asOf),
      release: row.release_en ?? null,
      releaseJp: row.release ?? null,
      name: row.char_name ?? null,
      title: row.title_en ?? null,
    };
  }

  // `card_id` is the outfit id the master dump uses (100101, 100302, …).
  for (const row of characterCards) {
    const id = String(row.card_id ?? '');
    if (!id) continue;
    result.characters[id] = {
      global: released(row.release_en, asOf),
      release: row.release_en ?? null,
      releaseJp: row.release ?? null,
      name: row.name_en ?? null,
      title: row.title_en_gl ?? row.title ?? null,
    };
  }

  const known = (m) => Object.keys(m).length;
  const live = (m) => Object.values(m).filter((v) => v.global).length;
  result.counts = {
    supports: known(result.supports),
    supportsGlobal: live(result.supports),
    outfits: known(result.characters),
    outfitsGlobal: live(result.characters),
  };
  result.ok = result.counts.supports > 0 && result.counts.outfits > 0;

  log(`  gametora: ok ${JSON.stringify(result.counts)}`);
  return result;
}
