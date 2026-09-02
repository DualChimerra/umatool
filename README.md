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
* the **pace-up (kakari) risk** your Wit and style aptitude buy you, and what it
  is expected to cost in lengths on this course
* **what your own run is worth** — every skill you plan to have, valued on this
  race as a *deck* rather than as a pile of independent skills, with the unique
  scaled to its level and each row saying what it is worth alone and what it is
  worth next to everything above it
* the **best deck for an SP budget you set**, picked by marginal lengths per SP
* **every skill ranked for that race**, split into Speed & accel, Recovery,
  Green / passive, Debuffs and Positioning, sortable by lengths or by lengths per
  100 SP, with every factor printed next to it
* the best **uniques** that can fire with that running style — scored under the
  style *you* picked rather than the one their owner prefers, each with the same
  skill read under all four styles, and gated on whether the owner can run this
  race at all
* the best **unique to inherit from a parent**, ranked as the weaker white copy
  you would actually be carrying, on your own runner's style and aptitudes
* the **best umamusume for this race**, added up from her unique, her own skill
  list, and what her aptitudes cost against the clock and the activation roll
* the **support cards** that hand out the top-ranked skills

**Race sim** — the whole field run forward at 1/15 s, a few hundred times. Your
win rate, top-3 rate, average margin, place spread and stamina at the line, for
you and for every rival. A step-by-step replay of one race showing every runner's
gap to the leader with your skill activations marked on it. And a **check against
the ranking**: pick your skills and the app runs the field with each one and
without it, on identical seeds, and prints what the simulation says next to what
the ranking said — with a **95% confidence interval on every row**, so a result
the sample size cannot separate from zero is labelled *noise* rather than ranked.
Because every variant runs on the same seeds, that interval is the paired one and
is far tighter than the gap between two independent win rates.

It also answers the question a Champions Meeting actually asks. The **field-shape
sweep** races the same build against five plausible field compositions on
identical seeds and reports the spread: a build that wins 80% against a
closer-heavy field and 25% against a front-heavy one is a worse pick than a
flatter one, and the worst case is the number to plan against when the round is
not announced yet. **Build against build** does the same for two saved builds,
head to head, with the interval that says whether the difference is real.

**Courses** — every course on the Global server read against one build: what your
kit is worth there priced as a deck, which of the four running styles each course
wants, the Stamina it asks for at this going, how much of the last spurt your
stats can pay for, and the pace-up risk. Sort by fit, by stamina need, by distance
or by track. It is the inverse of the Planner: not *what wins on this course* but
*where does this runner belong*.

**Team** — the actual Champions Meeting entry: three umamusume, **a six-card deck each**,
all on one page and all planned against the course above. Per uma: aptitude check for this
course, running-style override, stats, its own stamina requirement, the complete pool of
skills that run can end with (its unique, its own skill list, guaranteed card events and
card hints), and what each of those is worth in lengths. Plus a **priority skill list you
write yourself** — every deck is then scored on how much of it you cover, what is missing,
and for anything covered, which rank closed it and off which card. Team level: style
spread, total expected lengths, and which cards you are running in more than one deck.

The priority list holds **one entry per skill group**, so aiming at both ranks of the same
skill cannot be counted as two goals; picking another rank moves the target rather than
adding a second row. A **better** rank always satisfies an entry — finishing with
*Right-Handed ◎* when you asked for *Right-Handed ○* is not a miss. A weaker rank counts
only if you tick it. The **× rank never counts**: it lives in the same group but has the
opposite effect, so a card handing out *Corner Recovery ×* does not cover
*Corner Recovery ○*.

Cards that list the same skill both as their event skill and as a hint — 72 of the Global
ones do — are counted once, at the event's full weight, rather than twice.

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
on, a deck is five of your own cards plus **one borrowed from a friend**. That borrowed
card is not pinned to a fixed position — any of the six may be it, there just cannot be
two. Cards outside the collection therefore stay visible in the picker, badged *friend*,
and are ranked by what they would add like everything else; once the borrow is spent they
remain listed but disabled, so it is clear what taking the friend's card cost. An
**All / Mine / Friend's** switch narrows the list either way.

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
> including the ◎/○/× families. It is a *search* filter, deliberately symmetric and
> deliberately including ×, which is not how the Team page's priority coverage treats
> ranks — that one only ever counts equal-or-better, and never ×.

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
basket of thirty-odd skills on Kyoto 2200 m the two correlate at **r ≈ 0.94**, with
the closed form running about 15 % high in absolute terms. Any row can be
re-checked against the simulator from the Race page, which prints both numbers
side by side.

Underneath both of them the physics is checked against a third thing: an
independent transcription of `RaceSolver.ts` and `HpPolicy.ts` from
alpha123/uma-skill-tools. `npm run verify:model` runs every course, running
style, going and a spread of aptitudes through both and fails on any drift —
5712 combinations, currently zero.

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

And one thing a per-skill score cannot do at all: **a deck is not the sum of its
skills.** Skills compete for finite things — there is one stamina hole, each ramp
is one climb, and a stat only crosses a regime boundary once. Four recovery skills
scored independently on Tokyo 2400 m at 900 Stamina come to 2.74 lengths; scored
in sequence they are 1.40, and the fourth is worth exactly nothing. Four
acceleration skills that each reach the run-up into the last spurt come to 3.63
independently and 2.89 as a deck, because that ramp is 6.97 seconds long and there
is only one of it. Every total on the site is now a deck valuation: skills are
scored greedily, each one against the state the ones above it leave behind, and
each row reports both what it is worth alone and what it is worth in place.
Greedy is exact rather than approximate here, because both resources are convex —
the next skill onto a ramp always saves less than the last, so no later pick can
overtake an earlier one.

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
  by itself — and inside a deck, each heal is priced against the hole the ones
  before it already filled, so the third one is charged what it is really worth.
* **Position keep in the opening leg is a per-style nudge, not the game's
  four-mode state machine.** This is the largest remaining fidelity gap and it is
  deliberately still open: the reference implementation is not vendored here, and
  `verify:model` covers the speed, acceleration and HP formulas rather than
  position keep, so a hand-written state machine could not be checked against
  anything. A calibrated approximation that is disclosed beats an unvalidated
  guess that is not.
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
