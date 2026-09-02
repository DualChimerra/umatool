// The one dropdown in the app.
//
// A native <select> paints its popup with the operating system: a square white
// list in the platform's own font, hanging wherever the OS decides, ignoring
// every token in app.css and the dark theme with it. Every other floating
// surface here — the autocomplete, the tooltip, the pickers — is drawn by the
// app, and this makes the dropdowns match them.
//
// The original <select> stays in the DOM as the source of truth: `.value`,
// `.options`, `innerHTML` rewrites and `change` listeners all keep working
// exactly as they did, so no view had to learn a new API. This only replaces
// what the user sees and clicks.

import { el, esc } from './ui.mjs';

/** One popup, reused: only one dropdown can be open at a time. */
let pop = null;
let open = null; // { select, box, button, cursor }

function ensurePop() {
  if (pop) return pop;
  pop = el('<div class="sel__pop" role="listbox" hidden></div>');
  document.body.append(pop);

  pop.addEventListener('pointerdown', (e) => e.preventDefault());
  pop.addEventListener('click', (e) => {
    const opt = e.target.closest('.sel__opt');
    if (opt) commit(Number(opt.dataset.i));
  });
  pop.addEventListener('pointermove', (e) => {
    const opt = e.target.closest('.sel__opt');
    if (!opt || !open) return;
    const i = Number(opt.dataset.i);
    if (i !== open.cursor) { open.cursor = i; highlight(); }
  });

  document.addEventListener('pointerdown', (e) => {
    if (open && !pop.contains(e.target) && !open.box.contains(e.target)) close();
  });
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  return pop;
}

function place() {
  if (!open) return;
  if (!open.button.isConnected) { close(); return; }
  const r = open.button.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 12;
  // Course names are longer than the rail they sit in, so the list may be
  // wider than its button — pinned to the left edge and kept on screen.
  const width = Math.min(Math.max(r.width, 240), window.innerWidth - 16);
  pop.style.width = `${Math.round(width)}px`;
  pop.style.left = `${Math.round(Math.min(Math.max(8, r.left), window.innerWidth - width - 8))}px`;
  if (below < 168 && above > below) {
    pop.style.top = 'auto';
    pop.style.bottom = `${Math.round(window.innerHeight - r.top + 5)}px`;
    pop.style.maxHeight = `${Math.round(Math.min(320, above))}px`;
  } else {
    pop.style.bottom = 'auto';
    pop.style.top = `${Math.round(r.bottom + 5)}px`;
    pop.style.maxHeight = `${Math.round(Math.min(320, Math.max(140, below)))}px`;
  }
}

function highlight() {
  if (!open) return;
  for (const node of pop.querySelectorAll('.sel__opt')) {
    const on = Number(node.dataset.i) === open.cursor;
    node.classList.toggle('is-active', on);
    node.setAttribute('aria-selected', String(on));
    if (!on) continue;
    const top = node.offsetTop;
    const bottom = top + node.offsetHeight;
    if (top < pop.scrollTop) pop.scrollTop = top;
    else if (bottom > pop.scrollTop + pop.clientHeight) pop.scrollTop = bottom - pop.clientHeight;
  }
}

function close() {
  if (!open) return;
  open.button.setAttribute('aria-expanded', 'false');
  open.box.classList.remove('is-open');
  pop.hidden = true;
  open = null;
}

function commit(i) {
  if (!open) return;
  const { select, button } = open;
  const option = select.options[i];
  close();
  button.focus();
  if (!option || option.disabled || select.selectedIndex === i) return;
  select.selectedIndex = i;
  sync(select);
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function openFor(select) {
  const box = select.closest('.sel');
  const button = box.querySelector('.sel__btn');
  if (open && open.select === select) { close(); return; }
  close();
  ensurePop();
  pop.innerHTML = [...select.options].map((o, i) => `
    <div class="sel__opt${o.disabled ? ' is-disabled' : ''}" role="option" data-i="${i}"
      aria-selected="${i === select.selectedIndex}">
      <span class="sel__opt-text">${esc(o.textContent)}</span>
      <svg class="sel__tick" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m4 12 5.5 5.5L20 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>`).join('') || '<div class="sel__empty">Nothing to choose</div>';
  open = { select, box, button, cursor: Math.max(0, select.selectedIndex) };
  pop.hidden = false;
  box.classList.add('is-open');
  button.setAttribute('aria-expanded', 'true');
  place();
  highlight();
}

function move(step) {
  if (!open) return;
  const n = open.select.options.length;
  if (!n) return;
  open.cursor = (open.cursor + step + n) % n;
  highlight();
}

/** Repaint the button from whatever the <select> currently holds. */
function sync(select) {
  const box = select.closest('.sel');
  if (!box) return;
  const option = select.options[select.selectedIndex];
  box.querySelector('.sel__value').textContent = option ? option.textContent : '—';
  box.querySelector('.sel__btn').disabled = select.disabled || !select.options.length;
  if (open && open.select === select && !pop.hidden) {
    for (const node of pop.querySelectorAll('.sel__opt')) {
      node.classList.toggle('is-picked', Number(node.dataset.i) === select.selectedIndex);
    }
  }
}

/**
 * Wrap one <select> in the styled control. Idempotent — an element already
 * upgraded is only re-synced, which is what a re-rendered view needs.
 */
export function enhanceSelect(select) {
  if (!(select instanceof HTMLSelectElement)) return;
  if (select.dataset.selUi === '1') { sync(select); return; }
  select.dataset.selUi = '1';

  const box = el(`<div class="sel${select.classList.contains('select--sm') ? ' sel--sm' : ''}">
    <button class="sel__btn" type="button" aria-haspopup="listbox" aria-expanded="false">
      <span class="sel__value"></span>
      <svg class="sel__chev" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="m4 6.5 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>`);
  select.replaceWith(box);
  box.append(select);

  const button = box.querySelector('.sel__btn');
  const label = select.closest('label')?.querySelector('span, label');
  if (label && !button.getAttribute('aria-label')) button.setAttribute('aria-label', label.textContent.trim());
  else if (select.getAttribute('aria-label')) button.setAttribute('aria-label', select.getAttribute('aria-label'));

  button.addEventListener('click', () => openFor(select));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open || open.select !== select) openFor(select);
      else move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (open && open.select === select) commit(open.cursor);
      else openFor(select);
    } else if (e.key === 'Escape' && open && open.select === select) {
      e.preventDefault(); e.stopPropagation(); close();
    } else if (e.key === 'Home' && open) { e.preventDefault(); open.cursor = 0; highlight(); } else if (e.key === 'End' && open) { e.preventDefault(); open.cursor = select.options.length - 1; highlight(); }
  });

  // Views rewrite a select's options wholesale (the Planner refills the course
  // list every time the racecourse or direction changes) and set `.value`
  // straight afterwards. Watching the element keeps the button honest without
  // every call site having to remember to tell us.
  new MutationObserver(() => sync(select)).observe(select, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['value', 'disabled'],
  });
  select.addEventListener('change', () => sync(select));

  sync(select);
}

/**
 * Upgrade every styled <select> on the page, now and as views render.
 *
 * Views replace their whole subtree on each paint, so this watches the document
 * rather than asking each one to opt in.
 */
export function initSelects(root = document.body) {
  const scan = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches?.('select.select')) enhanceSelect(node);
    for (const s of node.querySelectorAll?.('select.select') ?? []) enhanceSelect(s);
  };
  scan(root);
  new MutationObserver((records) => {
    for (const rec of records) for (const node of rec.addedNodes) scan(node);
  }).observe(root, { childList: true, subtree: true });
}
