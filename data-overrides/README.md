# Manual overrides

What is live on Global is read from GameTora's `release_en` dates, which is right
for the overwhelming majority of entries. These two files pin anything it gets
wrong — a card that went out on Global before GameTora recorded it, or an entry
whose date is simply mistyped upstream. Both win over the release table, over the
snapshot in `data-cache/`, and over the skill-set fallback.

## `supports.json`

Keys are support card ids — the `#30028` number shown on every card in the UI.

```json
{
  "30240": false,
  "30012": true
}
```

## `characters.json`

Keys are outfit ids (`100302`) to pin one outfit, or character ids (`1003`) to
pin every outfit of that character. `false` hides them everywhere: the Umas
page, the team picker and every skill's source list.

```json
{
  "100302": false,
  "1071": false
}
```

After editing, rebuild with `npm run build:data` (or just let the daily workflow
do it) and commit the regenerated `docs/data/`.
