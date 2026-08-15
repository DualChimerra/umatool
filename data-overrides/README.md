# Manual overrides

The automatic Global filter is right for the overwhelming majority of entries,
but the Global client ships data slightly ahead of the banner, and a brand-new
Japanese support card that only reuses old skills can pass the check. These two
files pin anything the inference gets wrong. Both win over the inference *and*
over GameTora.

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

After editing, rebuild with `npm run build:data:offline` (or just let the daily
workflow do it) and commit the regenerated `docs/data/`.
