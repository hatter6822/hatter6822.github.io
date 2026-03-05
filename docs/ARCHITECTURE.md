# Website Architecture Audit and Growth Plan

> Documentation baseline: website release **0.1.0**.

## Audit summary

### Strengths
- Strict CSP/referrer/permissions policies are present on both pages.
- Data hydration already supports bundled snapshots plus live refresh.
- The code map is feature rich and includes keyboard navigation, URL state sync, and caching.

### Primary growth constraints identified
1. **Flat asset layout** made future expansion harder (global files mixed at repo root).
2. **Map-page rendering hot paths** repeatedly recalculated filtered module lists during interactive operations.
3. **Mobile discoverability** for chart interaction was implicit; users had no mobile-specific guidance.
4. **Contributor onboarding** lacked architecture-level documentation for runtime data flow and page boundaries.

## Implemented architecture reorganization

To prepare for future growth, static assets were moved from root into explicit domains:

- `assets/css/`
  - `style.css`
  - `map.css`
- `assets/js/`
  - `site.js`
  - `map.js`
  - `theme-init.js`
  - `background-pattern.js`

HTML references were updated in `index.html` and `map.html` with no runtime behavior changes.

## Runtime architecture (post-reorg)

### Pages
- `index.html`: marketing and live repository metrics
- `map.html`: codebase map workspace with filtering, graphing, and interior-symbol inspection

### Data contracts
- `data/site-data.json`: baseline for site metrics
- `data/map-data.json`: baseline for codebase map

### Runtime refresh strategy
1. Load bundled snapshot.
2. Optionally hydrate from local cache.
3. Reconcile with live GitHub API data under rate/timeout policies.
4. Preserve snapshot fallback on network failure.

## Code map optimization changes

- Added derived-cache invalidation helpers to centralize state reset when filters/data change.
- Added memoization for `filteredModules()` keyed by active filter state, including correct caching of empty-result filter states.
- Hardened map hydration by sanitizing module maps/import indexes, unwrapping branch-keyed canonical exports, and normalizing symbol metadata before graph rebuild.
- Canonical map normalization now treats the `modules` array as authoritative when present, preventing branch metadata keys (for example `main` refs) from polluting module inventories, flow-chart nodes, and map stat aggregates.
- Added a boot-disable test hook for `assets/js/map.js` so runtime normalization logic can be validated in Node tests without DOM bootstrapping.
- Preserved deterministic rendering behavior while reducing repeated list recomputation.
- Added mobile interaction hint and improved touch/scroll behavior in chart container.

## Mobile hardening decisions

- Raised touch target minimum heights for pills/inputs/buttons on small screens.
- Reduced chart container padding and adjusted viewport-constrained min-height.
- Enabled smooth touch overflow behavior and constrained overscroll to chart container.
- Added chart region focusability (`tabindex="0"`) for keyboard and assistive navigation.

## Future growth recommendations

1. Split `assets/js/map.js` into module-scoped files:
   - data adapters
   - graph layout
   - UI rendering
   - keyboard/navigation bindings
2. Introduce CI jobs for:
   - HTML/CSS linting
   - headless smoke checks for `index.html` + `map.html`
3. Add visual diff tests for map page breakpoints (desktop/tablet/mobile).
4. Add JSON schema validation for `data/map-data.json` and `data/site-data.json`.
