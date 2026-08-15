// Structural game data extracted from the Global client's master database and
// published by alpha123/uma-tools. The `umalator-global` folder is generated
// from the *Global* master.mdb, so everything it contains is already live on
// the Global server — that is what makes it usable as a release filter.
//
// Everything here is raw fact data (ids, names, numbers); the tool ships its
// own presentation and analysis on top.

import { getJson } from '../lib/http.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const RAW = 'https://raw.githubusercontent.com/alpha123/uma-tools/master';

export const FILES = {
  skillNames: 'umalator-global/skillnames.json',
  skillMeta: 'umalator-global/skill_meta.json',
  skillData: 'umalator-global/skill_data.json',
  umas: 'umalator-global/umas.json',
  courses: 'umalator-global/course_data.json',
  trackNames: 'umalator-global/tracknames.json',
  // Support cards are only published as a combined dump; the release filter is
  // applied afterwards using the Global skill set.
  cards: 'build-planner/cards.json',
  icons: 'icons.json',
};

export async function loadMasterDump({ localRoot = null, log = console.log } = {}) {
  const out = {};
  for (const [key, file] of Object.entries(FILES)) {
    if (localRoot) {
      out[key] = JSON.parse(await readFile(path.join(localRoot, file), 'utf8'));
      log(`  local  ${file}`);
    } else {
      out[key] = await getJson(`${RAW}/${file}`);
      log(`  fetch  ${file}`);
    }
  }
  return out;
}
