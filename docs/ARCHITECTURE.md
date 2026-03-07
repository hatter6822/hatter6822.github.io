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

- Replaced the previous mismatch-driven nav-selection session flow with a simpler **selection lock + monotonic boundary model** in `header-nav.js`.
- A same-page hash click now opens a short-lived lock that pins `aria-current` to the selected hash while smooth scrolling is still in motion, then releases once the target is in the fixed-header focus band and scrolling is idle; if a different section stays focused long enough, lock ownership is released early so `aria-current` can converge to the true in-focus section.
- Active section detection now derives from cached document-top geometry and a monotonic scroll anchor (`scrollY + nav offset`) so section ownership changes are stable and directional.
- Added explicit midpoint hysteresis for forward/backward boundary crossings, plus two-pass candidate confirmation, to suppress near-boundary ping-pong under tiny scroll jitter.
- Kept hash-near-header anchoring so if the URL hash target is already in the focus window, that section remains authoritative.
- Kept debounced `MutationObserver` and per-section `ResizeObserver` geometry refresh to survive asynchronous layout shifts without stale section boundaries.
- Result: active-link assignment converges deterministically through long jumps, rapid repeated selections, and async layout movement, while avoiding prolonged stale lock ownership when viewport focus clearly shifts.

## Audit refinements (post-0.1.0)

- Fixed `data-validation.mjs` `updatedAt` check from `typeof` comparison to direct value comparison for correct undefined handling.
- Fixed `map.js` `enrichSparseMapData` calling undefined `emptySymbols()` instead of `makeEmptyInteriorSymbols()`, which would have caused a runtime error during sparse import reconstruction.
- Removed deprecated `block-all-mixed-content` CSP directive from both HTML pages (redundant with `upgrade-insecure-requests`).
- Added `CLAUDE.md` project guidance file for AI-assisted development.
- Expanded test coverage with `updatedAt` undefined/valid ISO timestamp tests.
- Updated `CONTRIBUTING.md` required checks to include all four test suites and `header-nav.js` syntax check.

## Declaration context graph (post-0.1.0)

- Added dual-context flowchart views: **module context** (inter-module dependency graph) and **declaration context** (intra-module call graph).
- Declaration context builds a directed graph from `modules[].declarations[].called` arrays in the upstream `docs/codebase_map.json` schema, showing which declarations reference which others within a single module.
- Nodes are color-coded by declaration kind (theorem/lemma → gold, def/abbrev → green, inductive/structure → blue, class/instance → teal) and sorted by reference-score (in-degree × 2 + out-degree).
- A view-context switcher bar allows free navigation between module and declaration contexts. The declaration button disables itself for modules lacking call-graph data.
- URL state extended with `context=declaration` and `declmodule=ModuleName` parameters for deep-linkable declaration views.
- CSS added for context switcher, declaration-kind node tinting, and responsive mobile layout.
- Declaration kind colors reuse the existing `INTERIOR_KIND_COLOR_MAP` (no separate color map) via `declKindColor()`, keeping a single source of truth for kind → color mapping.
- New test hooks exposed: `buildDeclarationGraph`, `declFlowLegendItems`, `declKindColor`.
- Nine unit tests covering declaration graph construction, edge filtering (self-references, unknown targets, namespace/end-kind exclusion), duplicate-name last-wins behavior, node scoring and sorting, legend entries, kind coloring, and normalization of `called` arrays.

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
