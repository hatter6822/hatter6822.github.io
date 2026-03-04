# Testing and Validation Matrix

This repository uses lightweight Node-based checks.

## Automated checks

### Parser and extraction regression tests

```bash
node scripts/lib/lean-analysis.test.mjs
```

Validates:
- Lean import token extraction
- interior symbol extraction and line tracking
- theorem counting behavior
- README metric table parsing

### Bundled data integrity

```bash
node scripts/validate-data.mjs
```

Validates:
- `data/site-data.json` shape/content
- `data/map-data.json` shape/content

### JavaScript syntax checks

```bash
node --check assets/js/map.js
node --check assets/js/site.js
node --check assets/js/background-pattern.js
node --check assets/js/theme-init.js
```

## Manual verification recommendations

- Confirm `index.html` and `map.html` load from a static server.
- Test map page on mobile viewport (~390px width).
- Confirm map filtering/search and keyboard traversal still function.
- Confirm map live status messaging remains coherent during load/refresh.
