# Paddock

A Champions Meeting preparation tool for **Uma Musume Pretty Derby — Global**.

Everything on the site is scoped to what is actually live on the Global server, and
every name uses the Global (EN) wording.

## What it does

**Planner** — set the race: racecourse, direction, distance and surface, running
style, going, **weather**, **season** and field size. Optionally set *who is
running it* — a specific umamusume, her unique at the level you actually have
it, her aptitudes, and the skills you expect to finish training with. Then set
**the rest of the field**: either a headcount per running style, or every rival
built out individually. It returns:

* a course profile — corners, straights, slopes, phase boundaries (the last-spurt
  phase starts at ⅚, not ⅔), the final corner, the home straight, where your last
  spurt starts, and **every stretch where acceleration actually pays**
* the **Stamina you need**, solved from the HP model for a full-length last spurt
  on that exact course, going and running style — plus how much of the last spurt
  your current stats cover, your stamina pool and an estimated finishing time
* **stat targets, and what the next 100 points are worth** in each stat, measured
  by re-running the race with 100 more of it and converting the time saved into
  lengths. That same number prices every green skill
* the **field model**: where your running style sits in *this* field mix at each
  of the four phases, so a skill gated on placing is priced at the phase it fires
  in rather than at the finish
* **what your own run is worth** — every skill you plan to have, valued on this
  race, with the unique scaled to its level
* **every skill ranked for that race**, split into Speed & accel, Recovery,
  Green / passive, Debuffs and Positioning, sortable by lengths or by lengths per
  100 SP, with every factor printed next to it
* the best **uniques** that can fire with that running style, who carries them,
  and their aptitude for this distance and surface
* the **support cards** that hand out the top-ranked skills

**Race sim** — the whole field run forward at 1/15 s, a few hundred times. Your
win rate, top-3 rate, average margin, place spread and stamina at the line, for
you and for every rival. A step-by-step replay of one race showing every runner's
gap to the leader with your skill activations marked on it. And a **check against
the ranking**: pick your skills and the app runs the field with each one and
without it, on identical seeds, and prints what the simulation says next to what
the ranking said.

**Team** — the actual Champions Meeting entry: three umamusume, **a six-card deck each**,
all on one page and all planned against the course above. Per uma: aptitude check for this
course, running-style override, stats, its own stamina requirement, the complete pool of
skills that run can end with (its unique, its own skill list, guaranteed card events and
card hints), and what each of those is worth in lengths. Plus a **priority skill list you
write yourself** — every deck is then scored on how much of it you cover, and what is
missing. Team level: style spread, total expected lengths, and which cards you are running
in more than one deck.

Both pickers are ranked, not alphabetical. Umas are sorted by what their own unique and
skill list is worth on this course, discounted for missing aptitude. Support cards are
sorted by **what they would add to that specific deck** — priority skills first, then
expected lengths — and every card is listed with all of its skills, tagged event or hint,
with priority hits ringed and skills the deck already has dimmed out.

A **What to fix next** panel reads the whole entry and says what to do: stamina shortfalls
with the number of points or the percentage of recovery that would close them, aptitudes
below A, empty slots, unreachable priority skills together with the card that would cover
the most of them, which stat the next 100 points should go into, and whether the three
decks have collapsed into the same list.

Builds are kept automatically between visits, and can be saved by name and switched
between.

**Collection** — tick the umas and support cards you actually own. With the restriction
on, the deck builder offers only those, plus **one borrowed card per deck** — the slot you
fill from a friend.

Click any skill anywhere in the app for the full breakdown: what it does, the exact
condition from the game data, its complete valuation on the current course, and **every
uma and support card that can give it to you** — split into unique, uma skill list,
guaranteed card event and card hint.

**Umas** — all 64 Global umas / 97 outfits, each with its full skill list (unique, gold
and normal kept apart), the 10-way aptitude grid and running style. Filter by minimum
aptitude in any of the ten categories, by running style, by rarity, and by *which skills
they have*. Sort by any aptitude, rarity, gold-skill count or total skill score.

**Support cards** — every Global card indexed by the skills it teaches, with each skill
tagged **event** (guaranteed, from the card's training event) or **hint** (from a random
hint click). Filter by one skill or several, require *all* or *any*, and restrict the
match to event-only or hint-only.

> **Also match the other rank** — on by default. Search for a gold skill and cards that
> only carry its normal version are matched too: *Determined Descent* ⇄ *Straight Descent*.
> This works off the skill group id in the game data, so it covers every rank pair,
> including the ◎/○/× families.

**Skills** — all 591 Global skills as a sortable table: effect, the real activation
condition rendered from the raw game expression, SP cost, score, score-per-SP, duration,
and where the skill can be obtained. Filter by rank, effect type, race phase, running
style, distance, surface, terrain and source.

## Data

| What | Where from |
| --- | --- |
| Ids, names, aptitudes, skill conditions and effects, course geometry | Dump of the **Global** client master database, published by [alpha123/uma-tools](https://github.com/alpha123/uma-tools) (`umalator-global/`) |
| Release dates, canonical Global naming | [GameTora](https://gametora.com/umamusume), best-effort |

Because the dump is generated from the *Global* client and not the Japanese one, anything
in it is by definition already released on Global. That is what the release filter is
built on:

* skills and courses need no filtering — they come from the Global dump directly;
* support cards are published as one combined list, so a card counts as Global when every
  skill it teaches exists in the Global skill set. Cards that pass but sit past the current
  release frontier are flagged **unverified** instead of trusted silently;
* the Global client ships card data slightly ahead of the banner, so an outfit can appear
  before it is playable.

`data-overrides/supports.json` and `data-overrides/characters.json` pin any card or outfit
either way and win over everything else; GameTora's release dates take priority over the
inference whenever that pass succeeds. If something shows up that is not on Global yet,
those two files are where to correct it.

`.github/workflows/refresh-data.yml` re-runs the whole pipeline daily and commits only
when something changed. The **Data** tab in the site reports the last rebuild, the counts
and whether the GameTora pass applied.

### Rebuilding locally

```bash
npm run build:data              # fetch + rebuild docs/data/*.json
npm run build:data:offline      # same, skipping the GameTora pass

# icons (needs a checkout of alpha123/uma-tools and Pillow)
python3 scripts/build_icons.py /path/to/uma-tools

npm run serve                   # http://localhost:8080 (no-store, so edits show up)
```

The site is plain static files — ES modules, no bundler, no dependencies.

## Hosting on GitHub Pages

The whole site lives in `docs/`. Two ways to publish it:

* **Deploy from a branch** (simplest): *Settings → Pages → Source: Deploy from a branch →
  pick the branch, folder **`/docs`***. No workflow needed, and it works from any branch —
  it does not have to be the default one.
* **GitHub Actions** (what `.github/workflows/pages.yml` does): *Settings → Pages →
  Source: GitHub Actions*. That workflow deploys on every push to `main` touching `docs/`,
  so it only fires once `main` exists.

Either way the site ends up at `https://<user>.github.io/umatool/`.

If the folder is left on `/ (root)` instead of `/docs`, the root `index.html` in this
repository redirects to `docs/` so the site still opens — but `/docs` is the correct
setting and avoids the extra hop. The `.nojekyll` files stop Pages from running the
content through Jekyll, which it has no reason to do here.

## How skills are valued

There are two engines, and they agree.

**The ranking** (`docs/assets/js/model.mjs`) is closed form, because it is asked
about 600 skills every time a slider moves. It reads each skill's real condition
string, intersects it with the actual course geometry, and works out expected
**ground gained on the field**.

**The simulator** (`docs/assets/js/race/`) runs all nine runners forward at
1/15 s with the real conditions checked per tick. It is the reference. Over a
basket of thirty-odd skills on Kyoto 2200 m the two correlate at **r ≈ 0.95** with
a scale factor of ≈ 1.0, and any row can be re-checked against the simulator from
the Race page.

Three things the ranking gets right that a plain “m/s × seconds” score does not,
and which is why it used to disagree with every published Champions Meeting list:

* **Acceleration only pays on a ramp.** A +0.4 m/s² skill fired on the back
  straight, where you are already at target speed, is worth almost nothing; the
  same skill fired into the last-spurt ramp is one of the best things you can
  carry. The model finds every stretch where you are below target speed — the
  gate, the phase steps, the top of each hill, the run into the last spurt — and
  asks whether the skill can reach one.
* **Debuffs count.** Roughly a fifth of the obtainable skill pool does nothing to
  you and something to everyone else. Scored as “metres gained” they come out at
  zero and vanish from the list; scored as *ground gained on the field* they do
  not. Slowing the runners ahead of you is worth more per head than slowing the
  whole field, and slowing the ones behind you is worth almost nothing.
* **Green skills are stat changes**, priced from the same finite difference as the
  stat table — so a racecourse ○ is two lengths when the last spurt is short and
  exactly nothing when it is already paid for, and Sunny Days ○ is worth nothing
  in the rain because weather is now a hard gate.

## Accuracy notes

* **Race conditions are hard gates.** Running style, distance band, surface,
  handedness, track, going, weather and season are read from the skill's own
  condition string. Fail one and the skill is dropped, not discounted.
* **Aptitudes are modelled.** Distance aptitude scales the Speed term in the final
  leg; surface and running-style aptitude scale acceleration. Below A costs real
  time and the model charges for it.
* **Position keep is why early skills are cheap.** For the first two thirds of the
  race every runner behind the leader is holding a slot, so ground stolen there is
  largely handed back. Measured against the simulator, an early speed skill keeps
  about half its nominal value and a last-spurt one keeps all of it. It is also
  why a front runner needs the field to be stamina-tight to win: with stamina to
  spare the closers simply out-spurt it, and the Race page shows that happening.
* **Unique skill level.** The dump ships uniques at their base value, so level 1
  is the game's own number. Levels above that are applied as +10 % of base each —
  the community reading — and everything that uses it says which level it used.
* **Stat ceilings are not hardcoded.** Set the cap your scenario gives you and the
  inputs and target ranges follow it.
* **Recovery is scored against how tight your stamina actually is.** Once the last
  spurt is fully paid for, healing buys almost nothing and drops down the ranking
  by itself.
* **What the simulator does not model** is listed on the Race page itself: lanes
  are one-dimensional, skill ordering inside a tick is list order, position keep is
  a per-style nudge rather than the full four-mode state machine, and a handful of
  conditions (post number, favourite, lane side) are rolled at a fixed probability
  and named on the skill rather than simulated.
* Support card **training effects** (friendship bonus, specialty rate, stat gains),
  character growth bonuses and training event choices are not in the dump this
  build reads, so they are not shown.

## Credits

Game data belongs to Cygames. This is an unaffiliated fan tool.
Master-database dump by [alpha123/uma-tools](https://github.com/alpha123/uma-tools);
release data cross-checked against [GameTora](https://gametora.com/umamusume).
