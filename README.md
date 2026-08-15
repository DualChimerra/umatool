# Paddock

A Champions Meeting preparation tool for **Uma Musume Pretty Derby — Global**.

Everything on the site is scoped to what is actually live on the Global server, and
every name uses the Global (EN) wording.

## What it does

**Planner** — pick a racecourse, distance, running style and field size (9 by default,
because that is what a Champions Meeting runs). It returns:

* a course profile — corners, straights, slopes, phase boundaries, final corner, home
  straight, and where your last spurt actually starts
* the **Stamina you need**, solved from the HP model for a full-length last spurt on that
  exact course, going and running style — plus how much of the last spurt your current
  stats cover, your stamina pool and an estimated finishing time
* **stat targets, and what the next 100 points are worth** in each stat, measured by
  re-running the race with 100 more of it and converting the time saved into lengths
* the **field model**: the order distribution for your running style over the 9 slots, the
  `order_rate` each place corresponds to, and your Wit activation rate
* **every skill ranked for that course** as expected lengths gained, with each factor
  (trigger position, effect window, P(position), P(Wit), penalties) printed next to it
* the best **uniques** that can fire with that running style, who carries them, and their
  aptitude for this distance and surface
* the **support cards** that hand out the top-ranked skills

**Team** — the actual Champions Meeting entry: three umamusume, **a six-card deck each**,
all on one page and all planned against the course above. Per uma: aptitude check for this
course, running-style override, stats, its own stamina requirement, the complete pool of
skills that run can end with (its unique, its own skill list, guaranteed card events and
card hints), and what each of those is worth in lengths. Plus a **priority skill list you
write yourself** — every deck is then scored on how much of it you cover, and what is
missing. Team level: style spread, total expected lengths, and which cards you are running
in more than one deck.

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

npm run serve                   # http://localhost:8080
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

## Accuracy notes

* **Stamina needed** uses the standard community HP model: base speed from the distance,
  per-phase target speeds from the running style, last-spurt speed from Speed and Guts,
  and a drain of `20·(v − base + 12)² / 144` per second with the Guts multiplier applied
  in the final leg. It models your own race only — no rivals, no positioning, no pace-ups
  — so read it as a floor.
* **Skill scores** are an estimate, not a simulation. Each effect is converted into
  approximate metres gained on the selected course; the effect window is placed on the real
  track geometry and capped by the distance left to the line; then it is multiplied by the
  chance the position condition holds (from the order distribution for that running style
  in a 9-runner field), the Wit activation roll `100 − 9000 / Wit`, and penalties for
  conditions like being boxed in. Every factor applied is shown next to the skill.
* **Stat ceilings are not hardcoded.** Set the cap your scenario gives you and the inputs
  and target ranges follow it.
* **Power is not modelled.** It drives acceleration and lane changes, which this build does
  not simulate, so its sensitivity column is deliberately blank rather than invented.
* Support card **training effects** (friendship bonus, specialty rate, stat gains),
  character growth bonuses and training event choices are not in the dump this build
  reads, so they are not shown.

## Credits

Game data belongs to Cygames. This is an unaffiliated fan tool.
Master-database dump by [alpha123/uma-tools](https://github.com/alpha123/uma-tools);
release data cross-checked against [GameTora](https://gametora.com/umamusume).
