import { db } from '../store.mjs';
import { el, esc, fmt } from '../ui.mjs';

// The counters from the last GameTora pass arrive as an object; printing it
// with JSON.stringify dropped a brace-and-quote blob into the middle of a
// sentence.
const COUNT_LABEL = {
  supports: 'cards total', supportsGlobal: 'cards on Global',
  outfits: 'outfits total', outfitsGlobal: 'outfits on Global',
  characters: 'umas', skills: 'skills',
};
const formatCounts = (counts) => Object.entries(counts)
  .map(([k, v]) => `${COUNT_LABEL[k] ?? k} ${v}`)
  .join(', ');

export function renderData(root) {
  const m = db.meta;
  const when = m.generatedAt ? new Date(m.generatedAt) : null;
  const gt = m.gametora ?? {};

  const counts = [
    ['Skills live on Global', m.counts?.learnableSkills],
    ['Umas', m.counts?.characters],
    ['Outfits', m.counts?.outfits],
    ['Support cards on Global', m.counts?.supports],
    ['Support cards known in total', m.counts?.supportsAll],
    ['Courses', m.counts?.courses],
  ];

  const jpOnly = db.supports.filter((s) => !s.global).length;
  const unverified = db.supports.filter((s) => s.global && s.unverified).length;
  const hiddenOutfits = m.counts?.outfitsHidden ?? 0;

  root.replaceChildren(el(`<div class="layout" style="grid-template-columns:minmax(0,1fr)">
    <section class="stack" style="max-width:820px">
      <div class="page-head">
        <div>
          <h1>Where the data comes from</h1>
          <p>Last rebuilt ${when ? esc(when.toUTCString()) : 'unknown'}.</p>
        </div>
      </div>

      <div class="plan-grid">
        ${counts.map(([label, n]) => `
          <div class="stat-tile">
            <h4>${esc(label)}</h4>
            <div class="big">${n == null ? '—' : fmt.int(n)}</div>
          </div>`).join('')}
      </div>

      <section class="panel">
        <div class="panel__head"><h3>Sources</h3></div>
        <div class="panel__body">
          <p><b>Global client master database.</b> Ids, names, aptitudes, skill conditions, skill effects and course
          geometry are read out of a dump of the <i>Global</i> client's master database, published by
          <a href="https://github.com/alpha123/uma-tools" style="color:var(--accent)">alpha123/uma-tools</a>. Because that
          dump is generated from the Global client rather than the Japanese one, anything present in it is by definition
          already live on Global — that is what the release filter is built on.</p>
          <p style="margin-top:8px"><b>GameTora.</b> The refresh job also checks
          <a href="https://gametora.com/umamusume" style="color:var(--accent)">gametora.com</a> for release dates and the
          canonical Global spelling of every name. Status of the last attempt:
          <b>${gt.ok ? 'succeeded' : 'not applied'}</b>${gt.counts ? ` (${esc(formatCounts(gt.counts))})` : ''}.
          When it does not apply, the master-database filter below is used on its own and names stay as they are in the
          Global client, which is the same wording GameTora shows.</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel__head"><h3>How "on Global" is decided</h3></div>
        <div class="panel__body">
          <p>Umas, skills and courses come from the Global dump directly, so they need no filtering.</p>
          <p style="margin-top:8px">Support cards are published as one combined list, so each card is checked against the
          Global skill set: a card counts as released on Global when every skill it teaches — its event skill and all of
          its hints — exists in the Global client. ${fmt.int(jpOnly)} cards fail that test and are hidden behind the
          <i>Global releases only</i> switch on the Support cards page.</p>
          <p style="margin-top:8px">Cards that pass the check but sit past the current Global release frontier are
          flagged <b>unverified</b> rather than trusted silently — ${fmt.int(unverified)} of them right now. The Support
          cards page can hide them with one switch.</p>
          <p style="margin-top:8px">Umas come straight from the Global dump, but the client ships card data a little
          ahead of the banner, so an outfit can appear before it is playable.
          ${hiddenOutfits ? `${fmt.int(hiddenOutfits)} outfits are currently pinned as not-yet-released.` : 'Nothing is pinned as unreleased at the moment.'}</p>
          <p style="margin-top:8px" class="note">Both lists are correctable by hand:
          <code>data-overrides/supports.json</code> and <code>data-overrides/characters.json</code> pin any card or outfit
          either way, and when the GameTora check succeeds its release dates take priority over the inference. If you spot
          something on the site that is not on Global yet, that is the file to add it to.</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel__head"><h3>What the numbers mean</h3></div>
        <div class="panel__body">
          <p><b>Activation conditions</b> are rendered from the raw condition expressions in the game data, not from
          flavour text, so they say exactly what the engine checks.</p>
          <p style="margin-top:8px"><b>Stamina needed</b> on the planner is solved from the standard HP model: base speed
          from the distance, per-phase target speeds from the running style, last-spurt speed from Speed and Guts, and HP
          drain of <code>20·(v − base + 12)² / 144</code> per second with the Guts multiplier applied in the final leg.
          It ignores rivals, positioning and pace-ups, so read it as the stamina floor for running your own race.</p>
          <p style="margin-top:8px"><b>Skill scores</b> are expected <b>lengths</b> gained on the selected course. The
          trigger window is intersected with the real track geometry, the effect duration is capped by the distance left
          to the line, and the result is multiplied by the chance the position condition holds in a 9-runner Champions
          Meeting field, the Wit activation roll (<code>100 − 9000 / Wit</code>) and a penalty for conditions like being
          boxed in. Open any skill to see every one of those numbers for that skill.</p>
          <p style="margin-top:8px"><b>Stat sensitivity</b> on the planner is a finite difference: the race is re-run with
          100 more of a stat and the time saved is converted into lengths at the finish. Power is deliberately blank —
          it drives acceleration and lane changes, which this build does not simulate, so pretending to measure it would
          be worse than saying so.</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel__head"><h3>Not included</h3></div>
        <div class="panel__body">
          <p>Support card training effects (friendship bonus, specialty rate, stat gains), character growth bonuses and
          training event choices are not in the master-database dump this build reads, so they are not shown. For those,
          GameTora's own pages remain the reference.</p>
        </div>
      </section>
    </section>
  </div>`));
}
