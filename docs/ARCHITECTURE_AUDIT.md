# Website Architecture Audit and Growth Plan

## Scope

Audit targets:

- Static page architecture (`index.html`, `map.html`).
- Browser runtime organization (`assets/js/*`).
- Data synchronization scripts (`scripts/*`).
- Reliability, maintainability, and growth-readiness.

## Findings

## 1) Monolithic runtime logic (High priority)

### Observation
The codemap runtime (`assets/js/map.js`) is feature-rich but large, with cross-cutting concerns (UI state, data fetching, data parsing, rendering, cache policy) in one file.

### Risk
As feature count grows, regression risk rises and onboarding speed drops.

### Mitigation implemented
- Shared parsing logic was extracted into `scripts/lib/map-analysis.mjs`.
- Shared site metrics parsing was extracted into `scripts/lib/site-metrics.mjs`.
- Tests now lock behavior for parser-critical logic.

### Next phase recommendation
Split map runtime into focused modules:
- `map/data-client.js`
- `map/state.js`
- `map/render-flowchart.js`
- `map/ui-controls.js`

## 2) Flat asset layout (Medium priority)

### Observation
CSS and JS were previously in the repository root, reducing clarity and making future scaling noisy.

### Mitigation implemented
- Reorganized assets into `assets/css` and `assets/js`.
- Updated HTML references accordingly.

## 3) Test coverage gap in parsing/sync path (High priority)

### Observation
There were no automated tests for extraction/parsing logic used to generate production snapshots.

### Mitigation implemented
Added Node-based tests in `tests/` to validate:
- module/layer/kind helpers
- import token extraction
- interior symbol/theorem extraction
- README metrics parsing and theorem counting

## 4) Documentation coverage gap (High priority)

### Observation
Top-level README was concise but lacked architecture contracts, verification routines, and growth guidance.

### Mitigation implemented
- Rewrote README with architecture map, test flow, and operational guidance.
- Added dedicated map optimization playbook (`docs/MAP_PAGE_OPTIMIZATION.md`).

## Operational quality gates

Use these checks before merging:

1. `npm test` must pass.
2. `node scripts/sync-site-data.mjs` and `node scripts/sync-map-data.mjs` should run without runtime errors.
3. After sync, validate JSON snapshots are structurally complete and commit them.

## Growth-oriented roadmap

1. **Map runtime modularization**: Break `assets/js/map.js` by concern boundaries.
2. **Schema contracts**: Add a JSON Schema for `data/map-data.json` and `data/site-data.json`.
3. **CI expansion**: Add a dedicated workflow to run `npm test` and schema validation on pull requests.
4. **Render performance budgets**: Track map first-render timings on a fixed sample snapshot.

