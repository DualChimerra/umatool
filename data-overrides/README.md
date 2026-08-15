# Manual overrides

`supports.json` pins the Global availability of individual support cards, for the
rare case where the automatic inference gets one wrong.

```json
{
  "30240": false,
  "30012": true
}
```

Keys are support card ids (the number printed on each card in the UI), values are
`true` for "released on Global" and `false` for "not released". Anything listed
here wins over both the skill-set inference and GameTora.
