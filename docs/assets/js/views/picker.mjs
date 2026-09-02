// The two small pickers — an umamusume, or a skill — shared by the Planner and
// the field editor so they behave identically wherever they are opened from.

import { db, skillIconUrl } from '../store.mjs';
import { el, esc, on, debounce } from '../ui.mjs';
import { currentCourse } from '../context.mjs';

let pop = null;

function ensure() {
  if (pop) return pop;
  pop = el(`<div class="picker-pop" hidden>
    <div class="picker-pop__scrim" data-act="pclose"></div>
    <div class="picker-pop__panel" role="dialog" aria-modal="true">
      <header><h3 data-role="ptitle"></h3><button class="icon-btn" type="button" data-act="pclose" aria-label="Close">✕</button></header>
      <input class="input" type="search" data-role="pq" placeholder="Search…" autocomplete="off">
      <div class="picker-pop__list" data-role="plist"></div>
    </div>
  </div>`);
  document.body.append(pop);
  on(pop, 'click', '[data-act="pclose"]', () => { pop.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop && !pop.hidden) pop.hidden = true; });
  return pop;
}

export const pickerOpen = () => !!pop && !pop.hidden;

function open(title, render, onPick, attr) {
  const root = ensure();
  root.querySelector('[data-role="ptitle"]').textContent = title;
  const q = root.querySelector('[data-role="pq"]');
  const list = root.querySelector('[data-role="plist"]');
  q.value = '';
  const run = () => { list.innerHTML = render(q.value.trim().toLowerCase()); };
  q.oninput = debounce(run, 90);
  list.onclick = (e) => {
    const b = e.target.closest(`[${attr}]`);
    if (!b) return;
    root.hidden = true;
    onPick(b.getAttribute(attr));
  };
  run();
  root.hidden = false;
  q.focus();
}

/** Pick an umamusume, sorted by how well it suits the race being planned. */
export function pickUma(onPick, { title = 'Pick an umamusume' } = {}) {
  const course = currentCourse();
  const distKey = ['', 'sprint', 'mile', 'medium', 'long'][course.distanceType];
  const surfKey = course.surface === 1 ? 'turf' : 'dirt';
  open(title, (needle) => db.globalOutfits
    .filter((o) => !needle || o.displayName.toLowerCase().includes(needle))
    .sort((a, b) => (b.aptitudes[distKey] + b.aptitudes[surfKey]) - (a.aptitudes[distKey] + a.aptitudes[surfKey]))
    .slice(0, 90)
    .map((o) => `<button type="button" class="src-row" data-uma="${esc(o.id)}">
      <img src="./img/chara/${esc(o.id)}.webp" alt="" width="34" height="34" loading="lazy">
      <span style="min-width:0"><b>${esc(o.charaName)}</b><span class="src-row__sub">${esc(o.epithet)} · ${esc(o.strategyName)}</span></span>
      <span class="chip">${esc(o.aptitudeGrades[distKey])}/${esc(o.aptitudeGrades[surfKey])}</span>
    </button>`).join(''), onPick, 'data-uma');
}

/** Pick a skill. `pool` defaults to everything learnable. */
export function pickSkill(onPick, { title = 'Add a skill', pool = null, exclude = [] } = {}) {
  const skip = new Set(exclude);
  const list = pool ?? db.learnable.filter((s) => s.tier !== 'evolved');
  open(title, (needle) => list
    .filter((s) => !skip.has(s.id) && (!needle || s.name.toLowerCase().includes(needle)))
    .slice(0, 90)
    .map((s) => `<button type="button" class="src-row" data-skill="${esc(s.id)}">
      <img src="${skillIconUrl(s)}" alt="" width="26" height="26">
      <span style="min-width:0"><b>${esc(s.name)}</b><span class="src-row__sub">${esc(s.variants[0]?.text ?? '')}</span></span>
      <span class="chip chip--${s.tier === 'normal' ? '' : s.tier}">${esc(s.tierName)}</span>
    </button>`).join(''), onPick, 'data-skill');
}
