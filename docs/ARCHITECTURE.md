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

## Declaration context flowchart

- Added a second flowchart context mode ("declaration") alongside the existing module context. When a user clicks a declaration in the interior panel, the flowchart switches to show the selected declaration as a center node, its outgoing calls in the left lane, and incoming callers in the right lane.
- All declarations are now navigable to declaration context from the interior panel, regardless of whether they have call-graph entries. Declarations with zero relationships display a centered node with an informative "No internal call relationships detected" hint, providing a consistent declaration context experience.
- Declaration call-graph data is sourced from the `called` field on each declaration entry in `modules[].declarations` from the upstream `docs/codebase_map.json` schema. During normalization, call relationships are merged into a `declarationGraph` lookup keyed by declaration name with module provenance. A precomputed `declarationReverseGraph` index maps each callee to its callers for O(1) reverse lookups.
- `declarationModuleOf` now resolves modules for all declarations by searching `moduleMeta` symbol entries as a fallback when a declaration is not present in `declarationGraph`, ensuring URL parameter restoration and chaining navigation work for declarations with empty `called` arrays.
- Navigable declaration nodes in the flowchart are interactive—clicking them chains into a new declaration context for that declaration's call graph. Node navigability now checks both forward (`declarationGraph`) and reverse (`declarationReverseGraph`) indices, so declarations that are only called by others (but don't call anything themselves) are also chainable.
- A breadcrumb navigation bar at the top of the declaration flowchart provides module-name and "Module Context" return buttons for free bidirectional traversal between module and declaration contexts.
- Declaration context is persisted in the URL via a `decl` query parameter. Selecting a module via context search automatically returns to module context. On data load, the `decl` parameter is resolved against both the declaration graph and module metadata to determine the correct module, falling back gracefully if the declaration is no longer present.
- When a lane (calls or callers) exceeds 12 entries, declarations are sorted by module relevance (same-module declarations first, then alphabetically) before the first 10 are rendered with a "+N more" expand button, ensuring the most contextually relevant declarations are always visible. The "+N more" node is an interactive button that fully expands the lane to show all declarations. A "Return to Compact" button appears after expansion to collapse back to the truncated view. Expansion state (`declarationLanesExpanded`) is transient and resets on navigation to a new declaration or return to module context.
- The interior menu highlights the currently selected declaration in declaration context with an accent-colored border and background, providing clear visual feedback about which declaration is being inspected.
- Interior menu items now all display a clickable name button (entering declaration context) alongside a compact "src" link (opening GitHub source), providing uniform navigation access for every declaration.
- CSS for the declaration context (breadcrumb, navigable items, source links, active declaration highlight) is contained in `assets/css/map.css`.
- New test hooks (`declarationFlowLegendItems`, `declarationCalls`, `declarationCalledBy`, `declarationModuleOf`, `declarationKindOf`, `declarationLineOf`, `declarationLaneCollapseThreshold`, `declarationLaneVisibleLimit`, `applyTestState`) are exported for Node-based validation of declaration context logic.

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
