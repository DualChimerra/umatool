import { loadData, db } from './store.mjs';
import { initTooltips, initImageFallback, esc, el } from './ui.mjs';
import { initContext } from './context.mjs';
import { initSelects } from './select.mjs';
import { initSkillDrawer } from './views/detail.mjs';
import { renderPlanner } from './views/planner.mjs';
import { renderTeam } from './views/team.mjs';
import { renderRace } from './views/race.mjs';
import { renderUmas } from './views/umas.mjs';
import { renderCards } from './views/cards.mjs';
import { renderSkills } from './views/skills.mjs';
import { renderCollection } from './views/collection.mjs';
import { renderData } from './views/data.mjs';

const views = {
  planner: renderPlanner,
  team: renderTeam,
  race: renderRace,
  umas: renderUmas,
  cards: renderCards,
  skills: renderSkills,
  collection: renderCollection,
  data: renderData,
};

/* ------------------------------------------------------------------- theme */

const media = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const pref = localStorage.getItem('paddock:theme') ?? 'auto';
  const resolved = pref === 'auto' ? (media.matches ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePref = pref;
}

media.addEventListener('change', applyTheme);
document.getElementById('theme-toggle').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(localStorage.getItem('paddock:theme') ?? 'auto') + 1) % 3];
  localStorage.setItem('paddock:theme', next);
  applyTheme();
});
applyTheme();

/* ------------------------------------------------------------------ router */

const app = document.getElementById('app');

function currentView() {
  const name = (location.hash.split('?')[0] || '').replace(/^#\/?/, '');
  return views[name] ? name : 'planner';
}

function route() {
  const name = currentView();
  for (const a of document.querySelectorAll('#tabs a')) {
    a.classList.toggle('is-active', a.dataset.view === name);
  }
  // Overlays live on <body>, so nothing else would take them down when the
  // page under them is replaced.
  for (const overlay of document.querySelectorAll('.drawer:not([hidden]), .picker-pop:not([hidden])')) {
    overlay.hidden = true;
  }
  // The page itself is the scroll container, so a section change has to reset
  // the window — not <main>, which never scrolls on its own.
  window.scrollTo({ top: 0, behavior: 'instant' });
  try {
    views[name](app);
    setupMobileRail(app);
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="empty">Something went wrong rendering this page.<br><code>${esc(err.message)}</code></div>`;
  }
}

/**
 * On narrow screens the filter rail would push the results a screen and a half
 * down, so it collapses behind a button. The CSS keeps it always open above
 * 1080px, where the button is hidden.
 */
function setupMobileRail(root) {
  const rail = root.querySelector('.rail');
  if (!rail || !rail.children.length) return;
  rail.classList.add('rail--collapsible');
  const btn = el('<button class="btn filters-toggle" type="button" aria-expanded="false">Filters &amp; options</button>');
  btn.addEventListener('click', () => {
    btn.setAttribute('aria-expanded', String(rail.classList.toggle('rail--open')));
  });
  rail.before(btn);
}

window.addEventListener('hashchange', () => {
  // Filter changes rewrite the query string with replaceState; only re-render
  // when the section itself changed.
  if (currentView() !== app.dataset.view) { app.dataset.view = currentView(); route(); }
});

/* -------------------------------------------------------------------- boot */

loadData().then(() => {
  initContext();
  initTooltips(document.body);
  initImageFallback(document);
  initSelects(document.body);
  initSkillDrawer(document.body);
  const meta = db.meta;
  if (meta.generatedAt) {
    document.getElementById('footer-meta').textContent =
      ` Data rebuilt ${new Date(meta.generatedAt).toISOString().slice(0, 10)} — ${meta.counts.learnableSkills} skills, ${meta.counts.supports} Global support cards, ${meta.counts.outfits} outfits.`;
  }
  if (!location.hash) location.hash = '#/planner';
  app.dataset.view = currentView();
  route();
}).catch((err) => {
  console.error(err);
  app.innerHTML = `<div class="empty">Could not load the data set.<br><code>${esc(err.message)}</code></div>`;
});
