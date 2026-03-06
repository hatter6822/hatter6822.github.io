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
- Rebuilt map hydration around `modules[]` as the only source of module identity; top-level maps are now fallback metadata only for modules explicitly listed in the array.
- Removed map-shape scoring heuristics and replaced canonical payload selection with a deterministic modules-array-first branch chooser, preventing ref metadata (for example top-level `main` URLs) from entering flow-chart nodes or stats.
- Added canonical sparse-graph recovery: if canonical payloads ship declarations without import edges, the runtime reconstructs imports from raw Lean sources so the flow chart and map-stats remain complete.
- Added a boot-disable test hook for `assets/js/map.js` so runtime normalization logic can be validated in Node tests without DOM bootstrapping.
- Preserved deterministic rendering behavior while reducing repeated list recomputation.
- Consolidated symbol-entry normalization into a shared helper and added per-module interior-symbol memoization to avoid redundant normalization work during rerenders.
- Integrated the flow legend into the flowchart container’s upper-right corner so semantic keys travel with the graph while preserving node/layout space.
- Added render-pass local interior caching in flowchart rendering to reduce repeated declaration aggregation calls while preserving deterministic node metadata.
- Added mobile interaction hint and improved touch/scroll behavior in chart container.
- Repositioned and simplified the map toolbar into the flow panel header region, removing subsystem/full-flow/proof-linked toggles in favor of a compact context-search + detail + reset control surface with explicit flowchart ownership (`aria-controls`), compact-density tagging, and stronger detail-preset keyboard navigation (Arrow/Home/End).

## Mobile hardening decisions

- Raised touch target minimum heights for pills/inputs/buttons on small screens.
- Reduced chart container padding and adjusted viewport-constrained min-height.
- Enabled smooth touch overflow behavior and constrained overscroll to chart container.
- Added chart region focusability (`tabindex="0"`) for keyboard and assistive navigation.

## Header navigation stability hardening

- Refined the **nav selection session** state machine to track deterministic lifecycle fields (`hash`, section index, last scroll tick, user interruption flag, and bounded max-hold timeout).
- During a same-page hash selection, the state machine keeps `aria-current` pinned to the clicked link until scroll becomes idle and a short mismatch dwell threshold confirms the viewport has actually settled into a different section.
- Rebuilt section geometry tracking into precomputed section tops + midpoint boundaries, refreshed on resize/orientation/load so section detection uses a stable topology snapshot.
- Increased adjacent-boundary hysteresis and added hash-near-header anchoring so tiny smooth-scroll jitter near section boundaries cannot ping-pong `aria-current` between neighboring links.
- Preserved user override semantics by marking trusted wheel/touch/keyboard navigation as an immediate user interruption and releasing lock ownership on the next detection pass, ensuring explicit input always wins over automatic locking.
- Result: deterministic active-link transitions with no random nav-link/section oscillation during hash jumps, including long-distance transitions that previously produced occasional active-link/section mismatches.
- Eliminated dual nav-controller races by deferring `site.js` fallback nav initialization to the next animation frame and rechecking for `header-nav.js`; this prevents both scripts from mutating `aria-current` concurrently when script load order places `site.js` first.

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
