# Contributing Guide

Thanks for improving the seLe4n website.

> Current release target: **0.1.0**

## Repository principles

- Keep pages static and fast to render.
- Preserve local-first data behavior (`data/*.json` is baseline).
- Maintain strict security headers and safe external link behavior.
- Prefer incremental, test-backed changes.

## Project structure

- `index.html`: landing page
- `map.html`: interactive codebase map
- `assets/css/`: CSS bundles
- `assets/js/`: browser runtime logic
- `scripts/`: snapshot sync and validation tooling
- `docs/`: architecture and operational documentation

## Required checks before committing

Run all checks below from repository root:

```bash
node scripts/lib/lean-analysis.test.mjs
node scripts/lib/data-validation.test.mjs
node scripts/validate-data.mjs
node --check assets/js/map.js
node --check assets/js/site.js
node --check assets/js/background-pattern.js
node --check assets/js/theme-init.js
```

## Front-end change checklist

If you changed UI behavior or layout:

1. Verify desktop rendering in `index.html` and `map.html`.
2. Verify mobile rendering at ~390px width.
3. Confirm keyboard navigation still works on map page (`j`/`k`, Enter, Escape, detail pills).
4. Confirm no security regressions (CSP/referrer/permissions-policy meta tags remain intact).

## Data/sync change checklist

If you changed scripts or map data flow:

1. Run sync scripts if needed:
   - `node scripts/sync-site-data.mjs`
   - `node scripts/sync-map-data.mjs`
2. Run validation script.
3. Ensure generated JSON is committed when intentionally updated.
4. Document behavior changes in `docs/`.

## Documentation best practices

- Prefer task-oriented docs over long narrative prose.
- Keep command examples copy/paste-ready.
- Cross-link docs from `README.md` when adding new guides.
- Keep `docs/DEVELOPER_GUIDE.md` in sync when adding/renaming top-level runtime or script files so new contributors can still navigate the codebase quickly.
