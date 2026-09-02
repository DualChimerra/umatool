// The one autocomplete in the app.
//
// There used to be three near-copies of this — the skill filter, the priority
// list and the race runner — and none of them could be driven from the
// keyboard, none said anything when nothing matched, and each pinned its own
// list to the viewport with document and window listeners that were added
// again on every render and never taken down. This is that widget, once.

import { el, esc, debounce } from './ui.mjs';

/** Only one list is ever open, so the page-level listeners belong to it. */
let active = null;
let seq = 0;

function place() {
  if (!active) return;
  if (!active.root.isConnected) { active = null; return; }
  const { input, list } = active;
  const r = input.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 12;
  // Skill names do not fit a 290px rail, so the list is allowed to be wider
  // than the box it hangs off — pinned to its left edge, kept on screen.
  const width = Math.min(Math.max(r.width, 340), window.innerWidth - 16);
  list.style.width = `${Math.round(width)}px`;
  list.style.left = `${Math.round(Math.min(Math.max(8, r.left), window.innerWidth - width - 8))}px`;
  if (below < 176 && above > below) {
    list.style.top = 'auto';
    list.style.bottom = `${Math.round(window.innerHeight - r.top + 5)}px`;
    list.style.maxHeight = `${Math.round(Math.min(320, above))}px`;
  } else {
    list.style.bottom = 'auto';
    list.style.top = `${Math.round(r.bottom + 5)}px`;
    list.style.maxHeight = `${Math.round(Math.min(320, Math.max(140, below)))}px`;
  }
}

document.addEventListener('pointerdown', (e) => {
  if (active && !active.root.contains(e.target)) active.close();
});
window.addEventListener('resize', place);
window.addEventListener('scroll', place, true);

/**
 * @param {object}   o
 * @param {string}   o.placeholder
 * @param {Function} o.search   (needle) => items[]
 * @param {Function} o.row      (item) => inner HTML of one option
 * @param {Function} o.onPick   (item) => void
 */
export function combobox({
  placeholder = 'Search…', emptyText = 'No matches', search, row, onPick,
}) {
  const id = `ac${(seq += 1)}`;
  const root = el(`<div class="ac">
    <input class="input" type="search" role="combobox" autocomplete="off" spellcheck="false"
      aria-expanded="false" aria-controls="${id}" aria-autocomplete="list"
      placeholder="${esc(placeholder)}">
    <div class="ac__list" id="${id}" role="listbox" hidden></div>
  </div>`);
  const input = root.querySelector('input');
  const list = root.querySelector('.ac__list');

  let items = [];
  let cursor = -1;

  const self = { root, input, list, close };

  function open() {
    if (active && active !== self) active.close();
    active = self;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    place();
  }

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    cursor = -1;
    if (active === self) active = null;
  }

  function highlight() {
    for (const node of list.querySelectorAll('.ac__opt')) {
      const isOn = Number(node.dataset.i) === cursor;
      node.classList.toggle('is-active', isOn);
      node.setAttribute('aria-selected', String(isOn));
      if (!isOn) continue;
      input.setAttribute('aria-activedescendant', node.id);
      // Keep the cursor in view without letting scrollIntoView move the page.
      const top = node.offsetTop;
      const bottom = top + node.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }
  }

  function paint() {
    const needle = input.value.trim();
    if (!needle) { items = []; list.innerHTML = ''; close(); return; }
    items = search(needle);
    list.innerHTML = items.length
      ? items.map((it, i) => `<div class="ac__opt" role="option" id="${id}-${i}" data-i="${i}" aria-selected="false">${row(it)}</div>`).join('')
      : `<div class="ac__empty">${esc(emptyText)}</div>`;
    cursor = items.length ? 0 : -1;
    open();
    highlight();
  }

  function move(step) {
    if (!items.length) return;
    if (list.hidden) open();
    cursor = (cursor + step + items.length) % items.length;
    highlight();
  }

  function pick(i = cursor) {
    const item = items[i];
    if (!item) return;
    input.value = '';
    items = [];
    list.innerHTML = '';
    close();
    onPick(item);
  }

  input.addEventListener('input', debounce(paint, 110));
  input.addEventListener('focus', () => { if (input.value.trim()) paint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); } else if (e.key === 'Enter' && !list.hidden) { e.preventDefault(); pick(); } else if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); e.stopPropagation(); close(); } else if (e.key === 'Tab') close();
  });

  // Clicking an option must not blur the input first, or the list closes
  // under the pointer before the click lands.
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const opt = e.target.closest('.ac__opt');
    if (opt) pick(Number(opt.dataset.i));
  });
  list.addEventListener('pointermove', (e) => {
    const opt = e.target.closest('.ac__opt');
    if (!opt) return;
    const i = Number(opt.dataset.i);
    if (i !== cursor) { cursor = i; highlight(); }
  });

  return { element: root, input, close };
}
