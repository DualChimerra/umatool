// Optional enrichment pass against GameTora.
//
// GameTora is a Next.js site: every page embeds a `__NEXT_DATA__` blob and the
// same payload is served as static JSON under `/_next/data/<buildId>/...`.
// This adapter grabs whichever of the two works, then walks the payload looking
// for the arrays it recognises. It is deliberately defensive — if GameTora
// changes shape, or is unreachable from the runner, the build keeps the data it
// already has instead of failing.
//
// What we take from here:
//   * global release dates (`release_en`) — the authoritative "is it out on
//     Global yet" signal, and the canonical Global spelling of every name.
//
// Everything mechanical (skill conditions, aptitudes, course geometry) comes
// from the master-database dump instead.

import { getText } from '../lib/http.mjs';

const BASE = 'https://gametora.com';
const PAGES = ['/umamusume/supports', '/umamusume/characters', '/umamusume/skills'];

function extractNextData(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** Depth-first walk collecting every array of plain objects. */
function* arrays(node, depth = 0) {
  if (depth > 12 || node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === 'object' && node[0] !== null && !Array.isArray(node[0])) yield node;
    for (const v of node.slice(0, 200)) yield* arrays(v, depth + 1);
    return;
  }
  for (const v of Object.values(node)) yield* arrays(v, depth + 1);
}

const has = (o, ...keys) => keys.some((k) => Object.prototype.hasOwnProperty.call(o, k));

function classify(arr) {
  const s = arr[0];
  if (has(s, 'support_id')) return 'supports';
  if (has(s, 'char_id', 'charaId') && !has(s, 'support_id')) return 'characters';
  if (has(s, 'iconid', 'icon_id') && has(s, 'id')) return 'skills';
  return null;
}

const pick = (o, ...keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return null; };

export async function loadGametora({ log = console.log } = {}) {
  const result = { ok: false, supports: {}, characters: {}, skills: {}, notes: [] };

  let buildId = null;
  for (const page of PAGES) {
    let payload = null;
    try {
      const html = await getText(BASE + page, { retries: 2, timeout: 45000 });
      const next = extractNextData(html);
      if (next) {
        buildId = buildId || next.buildId;
        payload = next.props?.pageProps ?? next.props ?? next;
      }
    } catch (err) {
      result.notes.push(`${page}: ${err.message}`);
    }

    if (!payload && buildId) {
      try {
        payload = JSON.parse(await getText(`${BASE}/_next/data/${buildId}${page}.json`, { retries: 2, timeout: 45000 }));
        payload = payload.pageProps ?? payload;
      } catch (err) {
        result.notes.push(`${page} (_next/data): ${err.message}`);
      }
    }
    if (!payload) continue;

    for (const arr of arrays(payload)) {
      const kind = classify(arr);
      if (!kind) continue;
      for (const row of arr) {
        const id = String(pick(row, 'support_id', 'char_id', 'charaId', 'id') ?? '');
        if (!id) continue;
        const entry = {
          name: pick(row, 'name_en', 'nameEn', 'name'),
          titleEn: pick(row, 'title_en', 'titleEn'),
          release: pick(row, 'release_en', 'releaseEn'),
          releaseJp: pick(row, 'release', 'release_jp'),
        };
        if (entry.name || entry.release) result[kind][id] = { ...result[kind][id], ...entry };
      }
    }
  }

  const counts = Object.fromEntries(['supports', 'characters', 'skills'].map((k) => [k, Object.keys(result[k]).length]));
  result.ok = Object.values(counts).some((n) => n > 0);
  result.counts = counts;
  log(`  gametora: ${result.ok ? 'ok' : 'unavailable'} ${JSON.stringify(counts)}`);
  if (result.notes.length) result.notes.slice(0, 4).forEach((n) => log(`    note: ${n}`));
  return result;
}
