# Contributing Guide

Thanks for improving the seLe4n website.

> Current release target: **0.27.0**

## Repository principles

- Keep pages static and fast to render.
- Preserve local-first data behavior (`data/*.json` is baseline).
- Maintain strict security headers and safe external link behavior.
- Prefer incremental, test-backed changes.

## Project structure

- `index.html`: landing page
- `map.html`: interactive codebase map
- `run.html`: Simulator (kernel-in-action replay)
- `assets/css/`: CSS bundles
- `assets/js/`: browser runtime logic
- `scripts/`: snapshot sync and validation tooling
- `docs/`: architecture and operational documentation

## Required checks before committing

Run all checks below from repository root:

```bash
node scripts/lib/lean-analysis.test.mjs
node scripts/lib/canonical-map.test.mjs
node scripts/lib/data-validation.test.mjs
node scripts/lib/map-runtime.test.mjs
node scripts/lib/map-toolbar.test.mjs
node scripts/lib/trace-analysis.test.mjs
node scripts/lib/run-runtime.test.mjs
node scripts/lib/csp-html.test.mjs
node scripts/lib/static-values.test.mjs
node scripts/lib/i18n-locales.test.mjs
node scripts/validate-data.mjs
node scripts/validate-traces.mjs
node --check assets/js/map.js
node --check assets/js/run.js
node --check assets/js/header-nav.js
node --check assets/js/site.js
node --check assets/js/i18n.js
node --check assets/js/theme-init.js
```

## Front-end change checklist

If you changed UI behavior or layout:

1. Verify desktop rendering in `index.html`, `map.html`, and `run.html`.
2. Verify mobile rendering at ~390px width, **and at each breakpoint boundary**
   (1024/768/480px, both sides). Media queries add no specificity, so a
   responsive rule written with fewer classes than the base rule it overrides
   silently loses and the desktop value leaks into the mobile layout — the most
   common source of layout defects in this repo. See the "CSS override weight"
   section in `CLAUDE.md` before adding a rule inside `@media` or `@supports`.
3. Confirm keyboard navigation still works on map page (`j`/`k`, Enter, Escape, detail pills).
4. Confirm declaration context switching works (click declaration → flowchart shows calls/callers → breadcrumb navigation returns to module).
5. On the Simulator (`run.html`): confirm transport controls (play/step/scrub, `Space`/`←`/`→`), scenario switching, the invariant rail, the inspector, and the sandbox toggle all work; confirm `prefers-reduced-motion` disables animation.
6. Confirm no security regressions (CSP/referrer/permissions-policy meta tags remain intact).

## Data/sync change checklist

If you changed scripts or map data flow:

1. Run the sync pipeline if needed:
   - `node scripts/sync-upstream.mjs` (one clone → all three `data/*.json` snapshots)
   - `node scripts/apply-static-values.mjs` (stamps index.html **and** every `locales/*.json` bundle)
2. Run validation script.
3. Ensure generated JSON is committed when intentionally updated — `index.html`,
   `data/`, and `locales/` move together.
4. Document behavior changes in `docs/`.

Published statistics are projected from the kernel's canonical
`docs/codebase_map.json` and from nothing else. If a figure is missing from that
artifact, the sync must fail rather than substitute an estimate — a README
parse, a byte-count heuristic, or an arithmetic guess. See the scope and
substitution rules in `scripts/lib/canonical-map.mjs`.

Keep it one pipeline. The landing page and the code map describe the same
production corpus at the same revision, and `validate-data.mjs` enforces it: do
not add a second script that fetches upstream on its own.

## Documentation best practices

- Prefer task-oriented docs over long narrative prose.
- Keep command examples copy/paste-ready.
- Cross-link docs from `README.md` when adding new guides.
- Keep `docs/DEVELOPER_GUIDE.md` in sync when adding/renaming top-level runtime or script files so new contributors can still navigate the codebase quickly.
