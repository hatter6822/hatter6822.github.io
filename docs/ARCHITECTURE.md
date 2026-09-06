# Website Architecture Audit and Growth Plan

> Documentation baseline: website release **0.28.0**.

## Audit summary

### Strengths
- Strict CSP/referrer/permissions policies are present on both pages.
- Data hydration already supports bundled snapshots plus live refresh (the landing page deliberately opts out — see "Landing-page statistics have one source").
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
  - `i18n.js`
  - `theme-init.js`
  - `background-pattern.js`
- `locales/`
  - `en.json`, `es.json`, `fr.json`, `ja.json`, `zh-CN.json`

HTML references were updated in `index.html` and `map.html` with no runtime behavior changes.

## Runtime architecture (post-reorg)

### Pages
- `index.html`: marketing and live repository metrics
- `map.html`: codebase map workspace with filtering, graphing, and interior-symbol inspection

### Data contracts
- `data/site-data.json`: the *only* source of landing-page metrics, projected offline from the kernel's canonical `docs/codebase_map.json`
- `data/map-data.json`: baseline for codebase map

### Internationalization (i18n)
- `i18n.js` loads in `<head>` to detect locale before first paint.
- Locale resolution: URL `?lang=` param > `localStorage` > `navigator.languages` > `en` default.
- HTML elements use `data-i18n` attributes; JS code calls `sele4nI18n.t(key, vars)`.
- Locale bundles are JSON files in `/locales/`, fetched via XHR from `'self'` origin.
- Supported locales: English, Spanish, French, Japanese, Simplified Chinese, Ukrainian.
- Language switcher in the navigation bar allows runtime locale switching.

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
- `declarationModuleOf` now resolves modules for all declarations via a precomputed `declarationIndex` (built during normalization) as a fallback when a declaration is not present in `declarationGraph`, providing O(1) lookups instead of linear scans and ensuring URL parameter restoration and chaining navigation work for declarations with empty `called` arrays.
- Navigable declaration nodes in the flowchart are interactive—clicking them chains into a new declaration context for that declaration's call graph. Node navigability now checks both forward (`declarationGraph`) and reverse (`declarationReverseGraph`) indices, so declarations that are only called by others (but don't call anything themselves) are also chainable.
- A breadcrumb navigation bar (semantic `<nav>` element with `aria-label="Declaration breadcrumb"`) at the top of the declaration flowchart provides a module-name return button for free bidirectional traversal between module and declaration contexts.
- Declaration context is persisted in the URL via a `decl` query parameter. Selecting a module via context search automatically returns to module context. On data load, the `decl` parameter is resolved against both the declaration graph and module metadata to determine the correct module, falling back gracefully if the declaration is no longer present.
- When a lane (calls or callers) exceeds 12 entries, declarations are sorted by module relevance (same-module declarations first, then alphabetically) before the first 10 are rendered with a "+N more" expand button, ensuring the most contextually relevant declarations are always visible. The "+N more" node is an interactive button that fully expands the lane to show all declarations. A "Return to Compact" button appears after expansion to collapse back to the truncated view. Expansion state (`declarationLanesExpanded`) is transient and resets on navigation to a new declaration or return to module context.
- The interior menu highlights the currently selected declaration in declaration context with an accent-colored border and background, providing clear visual feedback about which declaration is being inspected.
- Interior menu items display a clickable name button that enters declaration context for every declaration, keeping panel interactions focused on flow exploration.
- CSS for the declaration context (breadcrumb, navigable items, active declaration highlight) is contained in `assets/css/map.css`.
- New test hooks (`declarationFlowLegendItems`, `declarationCalls`, `declarationCalledBy`, `declarationModuleOf`, `declarationKindOf`, `declarationLineOf`, `declarationLaneCollapseThreshold`, `declarationLaneVisibleLimit`, `assuranceForModule`, `relatedProofModules`, `findNearestLinkedPath`, `buildPairs`, `applyTestState`) are exported for Node-based validation of declaration context and proof-assurance logic.

## Flowchart rendering optimization

- Extracted six shared helpers (`createFlowSvg`, `createFlowLegend`, `flowLaneLabel`, `applyFlowScrollTarget`, `computeFlowLayout`, `buildFlowNodeGroup`) from the duplicated SVG setup, legend rendering, lane labeling, scroll-target, layout computation, and node construction code that was repeated across `renderFlowchart()` and `renderDeclarationFlowchart()`. This eliminates significant duplication and centralizes marker/defs creation, layer ordering, layout math, and SVG node construction into single-source functions.
- Both flowchart renderers now delegate to the shared helpers while preserving their context-specific class composition, aria-label construction, and event wiring logic.
- Eliminated redundant `nodeContentHeight()` calls for proof-pair and external-dependency nodes by pre-computing heights during layout passes and reusing cached values during rendering, avoiding double computation for each node.
- Removed dead ternary expressions `(compactNode ? 22 : 22)` in subtitle positioning where both branches produced identical values.
- Added smooth CSS transitions (`stroke`, `stroke-width`, `filter`) on `.flow-node rect` for visual feedback on hover and focus states.
- Added light-theme-aware assurance fallback colors inside the `@supports not (color-mix)` block to ensure accessible contrast on light backgrounds.
- Built a `declarationIndex` lookup during `normalizeMapData` that maps every declaration name to `{module, kind, line}`, replacing the O(n*m) linear scans in `declarationModuleOf`, `declarationKindOf`, and `declarationLineOf` with O(1) hash lookups. This eliminates redundant full-scan iterations across all modules and all kind buckets that occurred on every declaration metadata query during flowchart rendering and lane sorting.
- `buildFlowNodeGroup` now uses `role="img"` (instead of `role="note"`) for non-interactive SVG node groups, which is the semantically correct role for static graphical content within SVG.
- `createFlowSvg` now sets `aria-roledescription="flowchart"` on the SVG element, giving screen readers a more descriptive context label for the graph visualization.
- `applyFlowScrollTarget` and both flowchart renderers' fallback scroll restoration now temporarily set `scrollBehavior = "auto"` before programmatic scroll positioning, preventing `scroll-behavior: smooth` (set via CSS) from racing with synchronous `scrollLeft`/`scrollTop` assignments and causing incorrect position reads on subsequent renders.

## Accessibility and UX refinements

- Fixed `.sr-only` class mismatch: the interior menu filter label was created with `className = "sr-only"` but `map.css` only defined `.visually-hidden`. Added `.sr-only` as a selector alias alongside `.visually-hidden` so the filter label is correctly hidden visually while remaining accessible to screen readers.
- Added `.flow-node-interior-menu:empty { display: none }` so the interior menu panel hides completely before any module is selected, preventing a visible empty bordered box in the initial page state.
- Consolidated duplicate `.map-status` margin rules in the 640px media query (removed dead `margin-top: 0.55rem` immediately overridden by `margin-top: 0`).
- Cleaned up stray whitespace in `map.html` flowchart shell.
- Added `map-toolbar.test.mjs` assertions for `.sr-only` CSS definition, `:empty` interior menu behavior, empty initial container state, declaration breadcrumb `<nav>` element with `aria-label`, context-aware search label updates, and dynamic `flowchart-wrap` `aria-label` switching between module and declaration contexts.
- The context search bar displays `Module.Declaration` in dot-append format when in declaration context, with dynamic label "Context search — declaration"; in module context, it shows the module name with the label "Context search — module".
- The `flowchart-wrap` container `aria-label` updates dynamically to "Declaration call graph for [name]" in declaration context and restores to "Dependency and proof flow chart" in module context.
- The declaration flowchart now preserves scroll position on re-renders (lane expand/compact) using the same scroll save/restore logic as the module flowchart.
- The center (selected) declaration node is now keyboard-focusable (`tabindex="0"`) even though it is not interactive, allowing keyboard users to tab to the currently inspected declaration.

## Flowchart audit and optimization pass

- Merged duplicate `.control-group` CSS rules (`display: grid` at line 68 and `position: relative` at line 89) into a single declaration block.
- Removed redundant `.flowchart-svg { min-width: 0 }` rule in the 900px media query that was already set globally.
- Cleaned up stray double blank lines in `map.css`.
- Removed unused `moduleName` parameter from `declarationKindOf()` and `declarationLineOf()` — these functions only use `declarationIndex` for lookups and never referenced the parameter.
- Added self-edge guard in `drawFlowEdge()` — if source and target nodes have identical geometry, the edge is skipped to prevent degenerate bezier curves.
- Reordered `drawFlowEdge()` to parse variant options before creating the SVG path element, preventing leaked DOM nodes if option parsing fails.
- Added 200ms cache for `minimumFlowWidth()` to avoid repeated `window.innerWidth` reads during the same render cycle.
- Added CSS `contain: layout style` on `.flowchart-wrap` for browser rendering performance optimization.
- Added `cursor: pointer` on `.interior-menu-item-navigable` to indicate interactive declaration items.
- Added `role="list"` and `role="listitem"` on flow legend for screen reader accessibility, and `aria-hidden="true"` on legend color swatches.
- Added `DocumentFragment` batch insertion for interior menu item lists to reduce DOM thrashing during panel renders.
- Expanded `map-toolbar.test.mjs` with structural assertions for CSS containment, cursor interactivity, legend ARIA roles, self-edge guard, cleaned function signatures, and DocumentFragment usage.

## Interior menu item layout and responsiveness refinements

- Changed `.interior-menu-item` from pill-shaped (`border-radius: 999px`) to a practical rounded rectangle (`border-radius: 0.5rem`) to prevent text wrapping issues with long declaration names on narrow viewports.
- Added `display: flex` and `align-items: center` to `.interior-menu-item` base rule so the `::after` kind label consistently right-aligns via `margin-left: auto` across all viewport sizes.
- Added hover state (`.interior-menu-item:hover`) with kind-color-tinted border and background for visual feedback.
- Added CSS transition (`border-color`, `background`) on `.interior-menu-item` for smooth hover/focus effects.
- Added `min-height: 1.6rem` on desktop items and `min-height: 2.2rem` at the 640px mobile breakpoint for accessible touch targets.
- Added `focus-visible` outlines on `.interior-menu-item-btn` for keyboard navigation accessibility.
- Added `min-width: 0` and `overflow-wrap: anywhere` on `.interior-menu-item-btn` to prevent flex child overflow with long declaration names.
- Added `flex-wrap: nowrap` on `.interior-menu-item-navigable` to keep declaration chips stable on one line.
- Changed `.interior-menu-item::after` kind label to use `margin-left: auto` with `flex-shrink: 0` and `white-space: nowrap` for right-alignment within the flex container.
- Added a scoped `.card .interior-menu-items .interior-menu-item` padding override to neutralize the shared `.card ul li` left-biased padding, restoring symmetric chip insets and stable `::after` right-label positioning.
- Increased `.interior-menu-items` max-height from 12rem to 14rem on desktop for larger declaration lists, and added `scrollbar-width: thin` and `overscroll-behavior: contain` for scroll behavior improvement.
- Removed legacy `.interior-menu-item-src` UI so declaration chips now expose only declaration-context navigation in the interior panel.
- Fixed `.interior-menu-grid` column minimum from `minmax(16rem, 1fr)` to `minmax(min(16rem, 100%), 1fr)` to prevent horizontal overflow on viewports narrower than 16rem.
- Added mobile breakpoint (640px) styles for breadcrumb navigation: larger font, increased min-height touch target on the module return button.
- Added landscape phone breakpoint (900px × 560px) styles for interior menu items with reduced padding and lower max-height to maximize chart visibility in constrained viewports.

## Interior menu DOM management refactoring

- Refactored `repaintList()` in `renderFlowNodeInteriorMenu()` to eliminate the fragile `list.replaceWith(empty)` pattern that could leave the `<ul>` reference orphaned. The empty note and list attachment are now managed by dedicated `showEmptyNote()` and `ensureListAttached()` helpers that cleanly swap between the empty placeholder `<p>` and the declaration list `<ul>` within the column.
- Retained href guards for fallback source anchors in non-navigable rows so empty href values still degrade safely to plain text spans.

## Test coverage expansion

- Added structural assertions in `map-toolbar.test.mjs` for: interior menu item flex layout, hover state, CSS transition, kind label `white-space: nowrap` and `margin-left: auto`, button focus-visible outlines, items list `scrollbar-width: thin`, grid `min()` overflow prevention, navigable item `flex-wrap: nowrap`, span fallback for empty hrefs, a guard that legacy src-link elements are no longer rendered, declaration search function existence and test hook exports (`declarationSearchMatch`, `declarationSearchMatches`, `buildDeclarationSearchIndex`, `searchDeclarationsInModule`), `declarationSearchList` state tracking, and edge layer `aria-hidden` accessibility.

## Dot-append declaration search

The module search bar now supports dot-appended declaration queries (e.g., `SeLe4n.Kernel.API.apiInvariantBundle`) via two complementary strategies:

1. **Module-prefix strategy** (`declarationSearchMatch` / `searchDeclarationsInModule`): Progressively tries shorter dot-separated prefixes as exact module candidates, then matches the remaining suffix against declarations in the matched module's interior symbols and declaration index.

2. **Global declaration index strategy** (`buildDeclarationSearchIndex` / `declarationSearchMatches`): When no exact module prefix matches, searches across all declarations using a pre-built `declarationSearchList` indexed from `state.declarationIndex`. This enables cross-module declaration discovery when the user's query doesn't perfectly align with module boundaries.

Both strategies rank results by: exact match (2000) > qualified prefix (1800) > name prefix (1600) > name exact on suffix (1600) > qualified substring (1200) > suffix prefix (1400) > suffix substring (1000). The `declarationSearchMatches()` (plural) function returns multiple ranked results for dropdown suggestions, while `declarationSearchMatch()` (singular) returns the single best match for immediate selection.

Declaration suggestions appear with distinct italic styling and a left border accent in the dropdown, and carry `data-declaration` attributes for proper selection handling via keyboard and mouse.

## Search scoring optimizations

The `moduleSearchMatches()` scoring cascade was optimized with short-circuit evaluation: once a high-confidence match category is found (exact > prefix > substring), lower categories are skipped entirely. Token-based matching is now only attempted when no direct string match is found, reducing unnecessary work during interactive typing. The label-wrap cache eviction was hardened with explicit `done` checks for robustness across JavaScript engine implementations. The interior menu items list now uses `scrollbar-gutter: stable` for consistent layout regardless of scrollbar visibility.

## Generalized context search and DOM caching optimization

The module search bar was generalized into a unified **context search** bar that searches both modules and internal declarations using a dot-append approach:

- **HTML label** changed from "Current module context" to "Context search" with a placeholder reading "Module or Module.declaration".
- **Dynamic labeling**: the label updates to "Context search — module" or "Context search — declaration" depending on the active flowchart context.
- **Dot-append format**: when a declaration is active, the search bar displays `Module.Declaration` instead of the previous `Module › Declaration` separator, aligning with the dot-append search format users type to find declarations.
- **Flowchart sync**: selecting a declaration from the context search bar, interior menu, or flowchart node click all sync the search bar value and switch the flowchart to declaration context.
- **Reset behavior**: the Reset button now returns from declaration context to module context before applying filter resets.

### DOM element caching

Frequently queried DOM elements were previously re-fetched via `document.getElementById()` on every render cycle. A `DOM` namespace object now caches nine key elements (`flowchartWrap`, `moduleSearch`, `moduleSearchOptions`, `moduleSearchFeedback`, `moduleSearchLabel`, `flowNodeInteriorMenu`, `mapStatus`, `mainContent`, `moduleResults`) once during boot via `cacheDomElements()`. All render functions, status updates, and search handlers use the cached references with fallback to live queries for resilience.

### Label wrap cache batch eviction

The `LABEL_WRAP_CACHE` previously evicted a single entry when at capacity. This was changed to batch eviction of 120 entries (10% of the 1200 limit) per cycle, amortizing the cost of cache maintenance across render frames.

### Test coverage expansion (context search)

- Added `map-runtime.test.mjs` tests: context search dot-append format verification, `selectDeclaration` search bar sync, DOM caching initialization check, batch eviction pattern verification, and reset-to-module-context behavior.
- Added `map-toolbar.test.mjs` assertions: "Context search" label in HTML, "Module or Module.declaration" placeholder, `cacheDomElements` function existence, `DOM.flowchartWrap` and `DOM.moduleSearch` caching, `selectDeclaration` picker sync pattern, `LABEL_WRAP_CACHE_EVICT_BATCH` constant, and `searchDeclSuggestions` cleanup on dropdown close.

## Interior menu color coding and assurance level refinements

### Interior kind color coding standardization

- Standardized `color-mix` saturation percentages across interior-kind-select (62%) and interior-menu-item (62% border, 17% background) for visual consistency; the select option background now uses `var(--surface-2)` instead of `var(--surface)` to match item chip backgrounds.
- Increased interior-kind-select inset box-shadow opacity from 30% to 38% for a more visible kind-color tint on the dropdown border.
- Added smooth CSS transition (`border-color`, `box-shadow`) on `.interior-kind-select` for polished dropdown state changes.
- Replaced the redundant double `box-shadow` on `.interior-menu-item-active` (which used a solid 1px ring) with a single 2px color-mixed ring at 28% opacity, matching the `.detail-pill.is-active` pattern for consistent active-state treatment across the UI.
- Added explicit CSS transition on `.interior-menu-item-active` for smooth activation/deactivation visual feedback.
- Removed the redundant `constants` entry from `INTERIOR_KIND_COLOR_MAP` since `normalizeDeclarationKind()` already normalizes "constants" to "constant" before color lookup.
- Updated `interiorKindColor()` to fall back through `normalizeDeclarationKind()` when a kind is not directly in the color map, ensuring plural forms like "constants" resolve correctly without requiring duplicate map entries.

### Module assurance level upgrade

- Upgraded assurance level computation to include `theoremDensity` on every assurance result, providing quantitative theorem coverage information alongside the qualitative level label.
- Enhanced detail text to be dynamically descriptive: linked pairs now report the exact theorem count ("5 theorems") or note "structural only" when the link has zero theorems; partial pairs report their combined theorem count; local modules report their individual theorem count.
- Linked pair scoring now uses a `densityBonus` formula (`pairTheorems * 2`) instead of adding raw theorem counts, making high-theorem-density pairs score proportionally higher than vacuously-linked zero-theorem pairs.
- Partial pair scoring now includes combined theorem count for meaningful ranking.
- Introduced `ASSURANCE_COLORS` constant as a single source of truth for all four assurance level colors (`linked: #22b573`, `partial: #c47adb`, `local: #5ba8d4`, `none: #8e8e9a`), referenced by the flow legend.
- Replaced the single "Node tint = assurance level" legend entry with four individual assurance level entries ("Linked proof", "Partial proof", "Local theorems", "No proof evidence") with their respective colors for immediate visual reference.
- Updated assurance CSS to use `--assurance-tint` CSS custom properties on each `.flow-node.assurance-*` rule, providing a named reference point for the tint color.
- Graduated assurance tint intensity by level: linked (18%), partial (18%), local (15%), none (12%), reflecting the confidence hierarchy where stronger assurance levels have more prominent visual tinting.
- Added `fill` to the `.flow-node rect` CSS transition list for smooth assurance tint changes when navigating between modules.

### Test coverage expansion (assurance and color coding)

- Added `interiorKindColor` and `normalizeDeclarationKind` to map test hooks for direct validation.
- Added `assuranceColors` test hook exposing `ASSURANCE_COLORS` for legend and color consistency verification.
- New test: `interiorKindColor returns correct colors for known kinds and fallback for unknown` — verifies color resolution for known kinds, plural normalization fallback ("constants" → "constant"), and gray fallback for unknown kinds.
- New test: `normalizeDeclarationKind normalizes plurals and trims whitespace` — verifies plural-to-singular, case normalization, whitespace trimming, and empty/null handling.
- New test: `assuranceForModule includes theoremDensity and descriptive detail text` — verifies linked pairs with theorems report density and descriptive detail, linked pairs with zero theorems report "structural only", and local modules report their theorem count.
- New test: `ASSURANCE_COLORS constant maps all four assurance levels` — verifies all four levels have valid hex color values.
- Updated `flowLegendItems` test to verify the expanded 10-entry legend with individual assurance level colors.

## Comprehensive audit and optimization pass (0.2.0)

### Bug fixes

- **Theorem double-counting**: Fixed `theoremCountFromCodebaseMap` in both `lean-analysis.mjs` and `site.js` to track already-counted module names. When both `modules[]` and `moduleMeta` contained entries for the same module, theorems were counted twice. Now modules counted from `modules[]` are skipped in the `moduleMeta` pass.
- **URLSearchParams fallback**: `syncUrlState()` in `map.js` now guards against browsers lacking `URLSearchParams` support, consistent with the existing fallback in `readUrlState()`.
- **Data fetch race condition**: `refreshLiveData()` in `site.js` now sequences bundled and live data fetches (bundled completes first, then live) instead of running them concurrently. This prevents the slower bundled fetch from overwriting newer live data that resolved first.

### Performance optimizations

- **Search input debounce**: Added 90ms debounce to the map search input handler to prevent O(n) module and declaration scans from firing on every keystroke during rapid typing.
- **Reduced-motion caching**: `header-nav.js` now caches the `prefers-reduced-motion` media query result at initialization and updates it via a `change` listener, eliminating repeated `matchMedia` evaluations on every scroll-triggered navigation.
- **Resize handler batching**: `site.js` now wraps the `syncScrollOffset` resize handler in `requestAnimationFrame` to prevent layout thrashing during drag-resize.

### Accessibility improvements

- **SVG role semantics**: Changed flowchart SVG `role` from `"img"` to `"group"` so screen readers can discover interactive child nodes (flow nodes with `tabindex="0"` and `role="button"`) instead of treating the entire SVG as a single opaque image.
- **Interior kind select labels**: Added `aria-label="Filter [group] by kind"` to dynamically created interior kind `<select>` elements so screen readers announce the purpose of each filter dropdown.
- **Breadcrumb separator**: Added `aria-hidden="true"` to the declaration breadcrumb separator character (`›`) to prevent screen readers from announcing it as punctuation.
- **Section tracking semantics**: In-page section tracking sets `aria-current="location"` (the ARIA token for "current location within the page") in both `header-nav.js` and `site.js`, while links to a different page — the Code Map and Simulator entries on their own pages, and `refreshCurrentPageAria` matches without a hash — carry `aria-current="page"`. The interim `aria-current="true"` token has been retired. CSS styles both tokens (`.nav-links a[aria-current="page"], .nav-links a[aria-current="location"]`), and the Tier 4 probe samples the `"location"` token for section links.

### Test coverage expansion

- Added `isLikelyModuleToken` standalone test (valid paths, invalid paths, null/empty).
- Added `theoremCount` edge cases (zero theorems, empty source, null input).
- Added `theoremCountFromCodebaseMap` deduplication test (overlapping `modules[]` and `moduleMeta`).
- Added `theoremCountFromCodebaseMap` null/undefined/string input test.
- Added `extractImportTokens` empty source test.
- Added `validateSiteDataObject` null/non-object root rejection test.
- Added `validateMapDataObject` null/non-object root rejection test.
- Added `validateSiteDataObject` wrong types on numeric fields test.
- Added `validateMapDataObject` duplicate modules detection test.
- Added `assuranceForModule` partial assurance level test (invariant exists but does not import operations).

## Comprehensive audit and refinement pass (0.3.0)

### Data pipeline fixes

- **Stale `site-data.json` version**: The bundled `data/site-data.json` had `version: "0.1.0"` while the website was at 0.2.0. Corrected to `0.3.0` with the version bump.
- **`sync-site-data.mjs` missing fields**: The sync script did not write `admitted`, `sourceRepo`, or `sourceRef` fields. Added `admitted` defaulting to 0 if absent, and `sourceRepo`/`sourceRef` sourced from the script's `REPO`/`REF` constants.
- **CI workflow theorem undercounting**: The GitHub Actions workflow (`sync-sele4n-data.yml`) only matched `^theorem ` at line start, missing attributed theorems (`@[simp] theorem`), private/protected theorems, and all lemma declarations. Updated the grep pattern to match the same regex used by `lean-analysis.mjs` for consistency.

### Version bump to 0.3.0

All version references across the project were updated:
- `data/site-data.json`, `index.html` JSON-LD schema, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`
- Documentation baselines in `docs/ARCHITECTURE.md`, `docs/CODEBASE_MAP.md`, `docs/TESTING.md`

### Bug fixes

- **Scroll behavior restoration**: Fixed three instances in `map.js` where `wrap.style.scrollBehavior` was saved and restored after instant-positioning scroll writes. If scroll-behavior was set via CSS (not inline), the restore wrote an empty string to inline style which did not revert to the CSS value. Changed to `wrap.style.removeProperty("scroll-behavior")` to correctly fall back to the stylesheet rule.
- **Version fallback mismatch**: All `data-live="version"` fallback spans in `index.html` showed `0.1.0` instead of the current version. Users with JS disabled or slow connections saw the wrong version. Updated to `0.3.0`.
- **JSON parse error context**: `validate-data.mjs` now catches `JSON.parse` errors and reports which file has malformed JSON, rather than throwing an unhandled exception.

### SEO and social sharing

- **Map page Open Graph tags**: Added `og:title`, `og:description`, `og:type`, `og:url`, `twitter:card`, `twitter:title`, and `twitter:description` meta tags to `map.html`. Previously the map page had no social sharing metadata, resulting in blank previews on social platforms.

### Documentation accuracy

- Updated `CLAUDE.md` large file line counts to match actual values (map.js ~4,295, site.js ~754, header-nav.js ~738, style.css ~1,824, map.css ~718).

## Comprehensive audit and optimization pass (post-0.3.0)

### Lean analysis fixes

- **Noncomputable theorem counting**: The `theoremCount` regex in `lean-analysis.mjs` did not match `noncomputable theorem` or `noncomputable lemma` declarations. This caused theorem counts to be undercounted when modules used the `noncomputable` modifier. Added `(?:noncomputable\s+)?` to the theorem counting regex to match the same pattern already used in `extractInteriorCodeItems`.

### WebGL background optimization

- **GPU shader memory leak**: `createProgram()` in `background-pattern.js` did not delete vertex/fragment shader objects after linking. In WebGL, shader objects should be deleted after program linking because the program holds the compiled code. Added `gl.deleteShader(vs)` and `gl.deleteShader(fs)` after linking, and proper cleanup of the surviving shader when one fails to compile.
- **Animation frame cancellation**: The `requestAnimationFrame` return value was never stored, making it impossible to cancel the animation loop when the page became hidden or the WebGL context was lost. Added `rafId` tracking with proper `cancelAnimationFrame` calls on context loss and visibility change.
- **Page visibility detection**: Added `visibilitychange` listener that pauses the animation loop when the tab is hidden and resumes when visible. This prevents unnecessary GPU/CPU usage when the page is not visible, improving battery life on mobile devices.
- **User animation control path**: Added an explicit navigation toggle (`#bg-animation-toggle`) that persists paused/running state in `localStorage` (`sele4n-bg-animation-paused-v1`) and synchronizes runtime state through a custom `sele4n:bg-animation-toggle` event + `storage` listener. This enables immediate battery-saving animation suspension on mobile without sacrificing visual fidelity for users who keep animation enabled.

### Test coverage expansion

- Added `theoremCount supports noncomputable theorem declarations` test verifying the regex handles `noncomputable theorem`, attributed noncomputable theorems, and noncomputable lemmas correctly.
- Added `theoremCountFromCodebaseMap returns zero for module with empty declarations array` edge case test.
- Added `parseCurrentStateMetrics returns empty metrics for non-numeric value cells` robustness test for markdown rows containing only text (no numbers).
- Added `extractImportTokens handles comment-only continuation lines` test verifying that import parsing correctly skips comment-only continuation lines and resumes parsing subsequent continuation imports.
- Added `validateMapDataObject rejects non-string entries in modules array` test covering mixed-type entries (numbers, null) in the modules array.

### Documentation accuracy

- Updated `CLAUDE.md` large file line counts to match actual values (map.js ~4,760, background-pattern.js ~806, map.css ~756).

## Mobile flow-node overflow fix

Flow-node content could overflow its SVG rect boundary on mobile devices due to a mismatch between the character width estimate used for text wrapping and the actual rendered glyph advance at mobile font sizes.

### Root cause

The `wrapLabelLines()` function used a fixed 6.4px per-character estimate (matching 11.5px monospace), but the CSS scales `.flow-node text` to 12px at ≤640px and 12.5px at ≤420px. At these larger sizes, actual glyph advance is ~7.0px, causing wrapped lines to exceed node width.

### Fixes applied

1. **Viewport-aware character width**: `wrapLabelLines()` now uses 7.0px per character on compact viewports (≤900px) instead of the fixed 6.4px, producing more conservative line breaks that stay within node boundaries.
2. **SVG clipPath clipping**: `buildFlowNodeGroup()` now creates a `<clipPath>` element matching the node rect (including rounded corners) and wraps all text and assurance indicators in a clipped `<g>` group. Any text that still marginally exceeds the boundary is cleanly clipped rather than visually overflowing.
3. **Wider minimum flow canvas**: The `minimumFlowWidth()` thresholds were raised from 680/780/900px to 720/820/920px at the ≤420/≤640/≤900 breakpoints, giving side lanes more room for content.
4. **Increased minimum side lane width**: The minimum side lane width on compact viewports was raised from 180px to 200px, ensuring assurance-indicator nodes have enough text area (200px - 36px inset = 164px usable) for readable wrapped content.
5. **CSS overflow clipping**: Added `overflow: hidden` on `.flow-node` and `min-width: 0` on `.interior-menu-column` to prevent grid blowout on narrow viewports.
6. **Clip ID management**: The `flowClipIdCounter` is reset to 0 at the start of each flowchart render cycle to prevent unbounded ID growth across re-renders.

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

## Upstream seLe4n architecture evolution (reflected in website)

The upstream seLe4n codebase has undergone significant architectural changes now reflected in the website content:

### Robin Hood hash map subsystem

A fully verified Robin Hood hash table implementation (`SeLe4n/Kernel/RobinHood/`) serves as the algebraic foundation for all kernel hash-based data structures. 8 modules, 186 theorems:

- **Core** (`Core.lean`): `RHTable` data type with O(1) amortized insert, lookup, erase, and resize. 10 theorems including `insertLoop_preserves_len` and `RHTable.empty_wf`.
- **Bridge** (`Bridge.lean`): 46 theorems connecting the implementation to `HashMap`-compatible semantics (`getElem?_insert_self`, `getElem?_erase_self`, `mem_iff_isSome_getElem?`).
- **Set** (`Set.lean`): `RHSet` verified hash set — a newtype wrapper around `RHTable κ Unit` replacing `Std.HashSet` for state-persistent set fields. 15 theorems.
- **Invariant/Defs**: Well-formedness definitions and 7 foundational theorems.
- **Invariant/Lookup**: 44 lookup correctness theorems including `getLoop_none_of_absent` and `findLoop_some_has_key`.
- **Invariant/Preservation**: 64 preservation proofs including `insertLoop_countOccupied` and `backshiftLoop_countOccupied`.

Imported by `Model.Object.Types` — the entire kernel object type system builds on verified hash operations.

### Architecture layer expansion (31 files, 1,019 theorems)

- **RegisterDecode** (`RegisterDecode.lean`): 24 roundtrip proofs for register encode/decode (CapPtr, SyscallId, MsgInfo, MessageRegisters).
- **SyscallArgDecode** (`SyscallArgDecode.lean`): 59 determinism proofs for verified syscall argument parsing across all syscall types.
- **TlbModel** (`TlbModel.lean`): 38 TLB consistency proofs including flush-after-modify theorems.
- **VSpaceInvariant** (`VSpaceInvariant.lean`): 20 VSpace invariant proofs separated from operations.

### Deep modularization

Subsystems have been decomposed into focused sub-modules:

- **IPC**: 52 files, 1,659 theorems — DualQueue/{Core, Transport, WithCaps}, Operations/{CapTransfer, Donation, Endpoint, NotificationBind, SchedulerLemmas, Timeout}, Invariant/{Structural, EndpointPreservation, NotificationPreservation, CallReplyRecv, Defs, PerCore}, and an 18-module CrossCore/ suite for SMP cross-core IPC.
- **Capability**: 12 files, 244 theorems — Invariant/{Authority(24), Defs(62), PerCore(12)} and a six-module Preservation/ tree.
- **InformationFlow**: 14 files — Enforcement/{Soundness, Wrappers}, Invariant/{Composition, Helpers, Operations}.
- **Scheduler**: 46 files — Operations/{Core, Preservation, Selection} plus deep invariant, liveness, and per-core SMP trees.
- **Service**: 7 files — Invariant/{Acyclicity, Policy}.

### Object model split

`Model/Object.lean` split into `Object/Types.lean` (type definitions importing RobinHood) and `Object/Structures.lean` (structural operations).

### In-Lean testing framework

New testing modules: `Testing/InvariantChecks.lean`, `Testing/MainTraceHarness.lean`, `Testing/RuntimeContractFixtures.lean`, `Testing/StateBuilder.lean`.

## Rust syscall wrapper layer

The upstream seLe4n repository includes a `rust/` workspace (v0.33.6 — tracking the kernel version, Rust 2021 edition, GPL-3.0-or-later) providing safe, `no_std` user-space bindings for the kernel's 30-syscall ABI (27 of the 30 syscalls have typed safe wrappers in `sele4n-sys`; `TcbBindNotification`, `TcbUnbindNotification`, and `MintReplyCap` are modeled in `sele4n-types` but not yet wrapped). The website now documents these crates in the architecture diagram, feature grid, comparison table, project structure tree, getting started guide, and roadmap.

### Crate architecture

The workspace contains four crates. Three form a layered user-space dependency chain:

1. **`sele4n-types`** — Zero-dependency foundation. 16 `#[repr(transparent)]` newtype identifiers mirroring `SeLe4n/Prelude.lean` (ObjId, ThreadId, CPtr, Slot, ASID, VAddr, PAddr, etc.), a 55-variant `KernelError` enum matching the Lean kernel model, bitmask-based `AccessRights` (Read/Write/Grant/GrantReply/Retype), and a 30-variant `SyscallId` enum with `#[repr(u64)]` discriminants. Enforces `#![deny(unsafe_code)]`.

2. **`sele4n-abi`** — ARM64 register ABI layer. `MessageInfo` bitfield encoding/decoding, syscall request/response marshalling via `encode`/`decode` modules, IPC buffer overflow handling for messages exceeding the 4-register inline limit (x2–x5), and `TypeTag`/`PagePerms` enums. Contains exactly **one** `unsafe` block: the inline `svc #0` instruction in `trap.rs`. Non-AArch64 targets get a mock trap returning `InvalidSyscallNumber` for host-based testing.

3. **`sele4n-sys`** — Safe high-level wrappers. Organized into eight modules:
   - `ipc.rs` — `endpoint_send`, `endpoint_receive`, `endpoint_call`, `endpoint_reply`, `notification_signal`, `notification_wait`
   - `cspace.rs` — `cspace_mint`, `cspace_copy`, `cspace_move`, `cspace_delete`
   - `lifecycle.rs` — `lifecycle_retype` with convenience wrappers (`retype_tcb`, `retype_endpoint`, etc.)
   - `vspace.rs` — `vspace_map` (with W^X pre-check), `vspace_unmap`, plus `vspace_map_read_only`/`read_write`/`read_execute` helpers
   - `service.rs` — `service_register`, `service_revoke`, `service_query`
   - `sched_context.rs` — `sched_context_configure`, `sched_context_bind`, `sched_context_unbind`
   - `tcb.rs` — `tcb_suspend`, `tcb_resume`, `tcb_set_priority`, `tcb_set_mcp`, `tcb_set_ipc_buffer`, `tcb_set_affinity`
   - `cap.rs` — Phantom-typed `Cap<Obj, Rts>` with sealed marker traits, compile-time rights tracking, and safe `restrict()` (the insecure `downgrade()` was removed)

   Zero `unsafe` code — all unsafe is isolated in `sele4n-abi`.

4. **`sele4n-hal`** — Kernel-side, bare-metal Raspberry Pi 5 (BCM2712, Cortex-A76) hardware abstraction layer, deliberately outside the user-space chain (zero runtime dependencies; only a test-only dev-dependency on `sele4n-types` to cross-check its hand-mirrored `SyscallId`): GIC-400 interrupt controller, ARM Generic Timer, ARMv8 MMU configuration, TLB maintenance and cross-core shootdown, per-CPU state, PSCI-based SMP bring-up, ticket/RW locks, PL011 UART, typed SVC dispatch, and the FFI bridge exporting into the Lean kernel (`ffi.rs`).

### Website integration

- Architecture diagram: new "Rust User-Space Wrappers" layer at the top of the diagram (above the Lean kernel API surface) with `.arch-rust` CSS styling, reflecting that these crates represent the user-space side of the syscall boundary
- Architecture cards: detailed Rust crate description card
- Comparison table: "User-space bindings" row contrasting C headers vs safe Rust wrappers
- Features grid: "Safe Rust Syscall Wrappers" feature card
- Project structure tree: `rust/` directory with three crate entries
- Getting Started: Step 5 with `cargo build && cargo test` instructions
- Roadmap: completed "Rust Syscall Wrappers" milestone entry
- Meta tags: updated descriptions across both pages to mention Rust

## Comprehensive audit and optimization pass (0.27.0)

Started from a reported defect — the `.arch-stat` annotations in the Core
Subsystems and Foundations layers rendered as mangled fragments — which turned
out to be one instance of a repeating pattern. The pass generalized from there.

### Architecture diagram grid rebuild

The layer block grids sized themselves with `flex: 1 1 auto` plus percentage
`max-width` caps. Core Subsystems and Foundations added per-layer caps as
`.arch-core .arch-blocks .arch-block` / `.arch-model .arch-blocks .arch-block`
(three classes). The responsive reset inside `@media (max-width: 48rem)` was
written as `.arch-blocks .arch-block` (two classes), and media queries add no
specificity, so the desktop quarter-width cap survived into the tablet and phone
layouts. Blocks were pinned to 25% of the container inside half-width and
full-width grid cells: labels broke mid-word ("Schedule/r", "FrozenSt/ate",
"Concurre/ncy") and stat text collapsed into three cramped lines. Every other
layer, which had no per-layer cap, rendered correctly — which is why the defect
read as specific to those two layers.

Replaced with a single grid mechanism:

- `.arch-blocks` is `grid-template-columns: repeat(var(--arch-cols), minmax(0, 1fr))`.
- Layers declare their own `--arch-cols`; the responsive overrides re-declare it
  on `.arch-blocks` itself, so the element consuming the value always carries the
  winning declaration and the specificity trap cannot recur.
- Track counts divide each layer's block count evenly (rust 3, core 9, hw 6 over
  3 tracks; security 4, platform 4 over 4 tracks). This also removed the orphaned
  single-block row that Core Subsystems rendered on desktop, where 9 blocks over
  4 tracks left "Concurrency" alone on a third row.
- Foundations carries 7 blocks, so its last block spans the spare track; the
  1-track layout resets the span, which would otherwise add an implicit column.
- Blocks became column flex containers that centre their content, so a block with
  no `.arch-stat` no longer pins its label to the top of a row stretched by a
  taller sibling (visible in Information Flow, Foundations, Platform Bindings).
- `overflow-wrap: break-word` now applies at every width, not only below 48rem.

Verified with headless Chromium at 1440, 1024, 769, 768, 481, 480, 390, and
360px: no block clips or overflows its box at any width.

### Remaining specificity traps

An automated sweep — walk the CSSOM at four viewports, match every rule against
the live DOM, and flag any in-media rule outranked for a shared property by a
non-media rule matching the same elements — found four more instances:

- **Mobile nav CTA**: `.nav-links a.nav-cta` kept its desktop pill padding inside
  `@media (max-width: 48rem)`, producing a 29.8px touch target in a menu where
  every sibling row was 44.2px. All ten rows now measure 44.2px.
- **Map declaration chips**: the `@media (max-width: 640px)` and landscape rules
  used `.interior-menu-item` (0,1,0) against a base of
  `.card .interior-menu-items .interior-menu-item` (0,3,0), so chips kept desktop
  insets on phones. The `.card` prefix was unnecessary — two classes already
  outrank `.card ul li` (0,1,2) — so dropping it lets the responsive rules win on
  source order.
- **Sticky map toolbar**: the `@supports not (backdrop-filter)` opaque fallback
  was declared before the light-theme refinements and lost to them at equal
  weight, so browsers without backdrop-filter fell back to a 90% translucent bar
  with no blur in light theme. Moved to the end of `map.css` with a note that it
  must stay last.
- **Print**: `a` and `code` lost to roughly twenty component rules, so links
  printed in accent blue and `.btn-primary` printed light-on-white — invisible
  once browsers drop the background fill. Marked `!important`, the canonical use
  for a print reset, and added explicit button normalization. All 320 links on
  index.html now compute to `#222` under print media.

`CLAUDE.md` gained a "CSS override weight" convention section so the pattern is
documented rather than rediscovered.

### Payload reduction

- **`assets/images/favicon.png` 93.6 KB -> 27.3 KB** (-71%). It was the
  second-largest asset on every page: the nav logo `<img>`, `rel="icon"`,
  `rel="apple-touch-icon"`, and `og:image` all point at it. Palette-encoded;
  measured against the original composited over white, mean channel delta is
  0.75/255 with 92.7% of subpixels within 2/255 — no visible change at the 40px
  and 16-32px sizes it renders at.
- **`data/map-data.json` 3,092 KB -> 1,646 KB** (255 KB -> 153 KB gzipped), which
  was 83% of map.html's transfer. `sync-map-data.mjs` now writes it compact so
  refreshes stay minified. `site-data.json` and `execution-traces.json` stay
  indented — they are small and people read them.

### Accessibility

- map.html's document outline jumped h1 -> h4 at the declaration-menu column
  headings, the only other headings on the page. They are now h2, with the CSS
  selectors updated; computed size, weight, colour, and margin are unchanged.
- The mobile nav CTA touch-target fix above.

### Audit findings with no action needed

Recorded so the next pass does not re-derive them:

- **No dead CSS.** Every class in all three stylesheets is referenced from HTML
  or JS. The apparent orphans are constructed at runtime (`"assurance-" + level`)
  or driven by values in `execution-traces.json` (`data-op`, `data-kind`).
- **No console errors, duplicate IDs, dead internal anchors, unlabeled controls,
  unhardened `target="_blank"` links, or horizontal overflow** on any of the four
  pages.
- `content-visibility: auto` on sections means `getComputedStyle` returns stale
  values for offscreen subtrees. Any future style audit must force layout (or
  disable the property via CSSOM insertion — CSP blocks `addStyleTag`) before
  trusting computed styles below the fold.

### Footer

Removed the X/Twitter link from the Resources list.

## Animated background removal (0.27.0)

The fixed-position WebGL layer behind all three pages rendered a large, moving,
high-contrast fractal at full opacity. It competed with body copy for attention
and made text harder to read, which is the opposite of what a background should
do — so it was removed outright rather than tuned down.

What stays: `--bg-pattern`, the soft two-radial-gradient wash that sat *under*
the canvas. It carries the page's colour depth without any moving parts, and now
paints directly on a single fixed `#bg-wash` div (previously `#bg-canvas-wrap` >
`#bg-canvas-mover` > `canvas`, a three-element nest that existed only to host and
position the canvas).

Removed:

- `assets/js/background-pattern.js` (884 lines: shader setup, RAF loop, noise
  field, pointer/scroll reactivity, visibility handling).
- The `#bg-animation-toggle` pause/resume control from the nav on all three
  pages, and its `setupBackgroundAnimationToggle()` implementation duplicated
  across `site.js`, `map.js`, and `run.js` — roughly 5 KB of near-identical
  code, plus the `sele4n-bg-animation-paused-v1` localStorage key, the
  `sele4n:bg-animation-toggle` custom event, and the `data-bg-animation` root
  attribute that coordinated them.
- `.math-bg-layer` and `.bg-animation-toggle` styles, including the
  `prefers-reduced-motion` transition guard and the `prefers-reduced-data` rule
  that hid the canvas — both existed solely to tame the animation.
- `nav.pause_bg` / `nav.resume_bg` from all six locale bundles.

The control was itself an accommodation for the animation being distracting; with
the animation gone there is nothing to pause, so the accessibility and
data-saver guards it needed disappear with it.

Transfer per page drops by roughly 40 KB (the shader script), on top of the
0.27.0 payload work: index.html 527 -> 358 KB, map.html 3,707 -> 2,094 KB,
run.html 575 -> 406 KB against the 0.26.0 baseline.

`THIRD_PARTY_NOTICES.md` previously covered an Ashima Arts / Stefan Gustavson
simplex-noise GLSL implementation vendored inside the shader. That code is no
longer distributed, so the notice was moved to a "Removed" section retained for
the audit trail, and the repository now bundles no third-party code.

## Print palette neutralization (0.27.0)

Follow-up to the print fixes above, from a review finding on the 0.27.0 pull
request. Forcing link text to `#222` was only half the job: the print block
patched individual components but never touched the palette tokens, so printing
from the **dark** theme kept dark surfaces under the newly-dark text. Measured
with `Background graphics` enabled, `.arch-block` printed #222 on #192338
(1.01:1) and `.tier-script` #222 on #080c15 (1.23:1) — effectively invisible.
With backgrounds disabled the same gap showed up in the other direction:
`.comparison-table td` and `.api-table td` printed dark-theme greys on white.

Fixed at the token level instead of per selector — `@media print` now redefines
`--bg`, `--bg-alt`, `--surface`, `--surface-2`, `--border`, `--text`,
`--text-muted`, `--text-bright`, and `--heading`, so every consumer inherits a
print-safe value including ones added later. The screen accents (`--accent`,
`--green`, `--yellow`, `--red`, `--purple`) sat at 2.1-2.7:1 on white and carry
section labels, card headings, and badges, so they are darkened rather than
flattened to black, preserving the colour coding. `.tier-badge` and
`.step-number` join the buttons in the light-text-on-coloured-fill reset.

A scan of every leaf text node under print emulation now reports zero elements
below 4.5:1 against white, in both themes; filled links measure 14.6-15.9:1.

## Mobile hero stats and drop-down menu layout (0.27.0)

Two reported mobile defects, both from a box-model assumption rather than a
specificity conflict.

### Drop-down menu rows never left the inline formatting context

`.nav-links a` carries no `display` declaration, so the anchors stayed **inline**
inside the `@media (max-width: 48rem)` panel. On an inline box `width`,
`min-height`, and vertical padding contribute nothing to layout: the mobile rule
set all three and none of them took effect. Measured at 390px before the fix,
ten rows occupied 305px of flow — 30.5px each — while each anchor *painted* a
44px box, so all nine consecutive pairs overlapped. The `.nav-cta` pill, being
the only row with a filled background, made it obvious by covering the "Get
Started" row above it. The tap target was the text width (48px for "About"), not
the row.

The 0.27.0 specificity sweep recorded this rule as fixed ("All ten rows now
measure 44.2px"). That number is `getBoundingClientRect().height` on an inline
box — the union of its painted fragments, which *does* include vertical padding.
It is not the row's contribution to flow, so the padding fix it was meant to
confirm had never landed. When auditing a row height, measure the gap between
consecutive rows, not one element's own rect.

`display: flex` on the mobile rule gives the padding and `min-height` somewhere
to go. Rows now measure 49px of flow with zero overlapping pairs, and each
anchor fills its `li` (358px at a 390px viewport) so the whole row is the target.
`white-space: normal` joins it: the base rule sets `nowrap` for the horizontal
desktop bar, which silently disabled the `overflow-wrap: anywhere` the mobile
block already declared, and the longest localized entry ("Карта кодової бази")
needs to be free to wrap. The CTA's `text-align: center` became
`justify-content: center`, the flex-context equivalent.

Verified on `index.html`, `map.html`, and `run.html` in `en` and `uk`: 0
overlaps, 49px minimum row height, full-width rows, and the 547px panel fits a
390x844 viewport without scrolling.

### Hero stats sat flush left, and orphaned a stat between breakpoints

Below 30rem `.hero-stats` switched to `flex-direction: column`. `justify-content:
center` from the base rule then governed the *block* axis, and the unset
`align-items` left each `.stat` stretched to full width with its row content
packed at `flex-start` — so the block hugged the container's left padding inside
an otherwise centred hero. The value column's fixed `min-width: 5rem` was also
narrower than "255,085", so that row's label started 3px right of the other
three (label lefts 108/111/108/108).

Between 30rem and ~37rem the four flex items needed roughly 570px of content
width against the 448-548px available, so the fourth stat wrapped alone onto a
second row at every width from 481 to 580px.

Rebuilt as one grid, following the `--arch-cols` convention:

- `.hero-stats` is `repeat(var(--stat-cols), minmax(0, max-content))`, declared
  `4` on the base rule and re-declared `2` on the element itself under 48rem.
  The 0 track minimum lets long localized labels ("Teoremas Demostrados",
  "Припущень (admitted)") wrap inside their track instead of pushing the row past
  the container — the widest locale would otherwise have orphaned a stat at
  769px, the one width the old flex layout had left to chance.
- Under 30rem `.stat` becomes `display: contents`, promoting the value and the
  label to grid items so all four rows share the same two columns. The seam is
  sized to the widest *live* value, which a per-row `min-width` cannot be: the
  numbers are refreshed at runtime from `site-data.json`.

Verified across `en`/`es`/`uk`/`ja` at 390, 500, 800, and 1280px: no page or
container overflow at any combination, the stat block centres on the container
axis to within 0px, label lefts are identical across all four rows (175px at
390px, was 108/111/108/108), and the layout resolves to 4 rows / 2x2 / one row
at 390 / 500 / 800px. Desktop rendering is unchanged.

## Desktop nav single-line budget (0.27.0)

### The budget is fixed, not proportional to the window

`.nav-inner` is `auto minmax(0, 1fr) auto` and `.nav-links` is `justify-self:
center`, so the menu is sized to its content and clamped to the middle track.
That track grows with the window only until `.container`'s max-width caps it:

| viewport | 1024px | 1100px | 1152px | 1280px and above |
|----------|--------|--------|--------|------------------|
| track    | 804px  | 880px  | 932px  | 932px            |

**932px is the ceiling.** A locale whose ten menu items exceed it wraps to two
lines at *every* desktop width, including 2560px — widening the window cannot
help. English occupies 816px, so it is single-line from 1035px up and has 116px
of headroom against the cap.

Measured before this pass, three locales overshot: `es` at 943px and `uk` at
989px were both past the ceiling and wrapped everywhere, and `fr` at 902px only
unwrapped above 1120px. The widest single item in any locale was Ukrainian
`Карта кодової бази` at 139px — nearly triple English `About` at 53px.

### Shortened where the label, not the layout, was the problem

Menu labels are independent of the section headings they scroll to in every
locale (English `Features` links to a section titled "Key Innovations"), so
compacting them costs no consistency. Nine `nav.*` values changed:

| locale | key | was | now | saved |
|--------|-----|-----|-----|-------|
| es | `features` | Características | Funciones | 29px |
| es | `code_map` | Mapa del Código | Mapa | 71px |
| es | `get_started` | Comenzar | Empezar | 9px |
| es | `comparison` | Comparación | Comparativa | 4px |
| fr | `features` | Fonctionnalités | Fonctions | 34px |
| fr | `code_map` | Carte du code | Carte | 54px |
| uk | `features` | Можливості | Функції | 30px |
| uk | `code_map` | Карта кодової бази | Карта коду | 53px |
| uk | `get_started` | Початок роботи | Початок | 49px |

Ukrainian `Верифікація` and `Про проєкт` were deliberately kept: both are the
precise terms, and trimming either was the only way to reach English's exact
footprint. Ukrainian therefore lands at 857px — inside the 932px ceiling with
75px to spare, single-line from 1077px — rather than at parity.

Result, single-line from: `zh-CN` 799px, `ja` 995px, `fr` 1033px, `en` 1035px,
`es` 1049px, `uk` 1077px. Every locale is now single-line at every common
desktop width, where `es` and `uk` previously wrapped at all of them. `en`,
`ja`, and `zh-CN` are untouched.

### `nav.*` keys are width-constrained and must not be reused elsewhere

`run.html`'s compact footer rendered its Code Map link from `nav.code_map`, the
same key as the header menu. That is DRY, and it is exactly why shortening the
menu label silently rewrote the footer too: the footer has no width pressure,
and "Mapa" / "Carte" read worse there than "Mapa del Código" / "Carte du code".

Split into a `footer.code_map` key carrying the descriptive label, leaving
`nav.code_map` free to be as terse as the menu track demands. Ukrainian is
identical in both (`Карта коду`) because that change was a translation
improvement rather than a space compromise. `nav.github` stays shared by both
surfaces: "GitHub" is a proper noun, identical in all six locales, and immune to
the width pressure that makes the other keys diverge.

Treat any `nav.*` value as a layout-constrained string. If a second surface
needs the same words, give it its own key.


## Landing-page statistics have one source (0.28.0)

Every figure on `index.html` — proven theorems, lines of Lean 4, Lean modules,
admitted proofs, version, toolchain — is projected from one artifact:
`docs/codebase_map.json` in the seLe4n repository. The kernel's
`scripts/generate_codebase_map.py` emits it, and the kernel's own README
"Current state" table is rendered from the same `readme_sync` block. Reading the
artifact is what keeps the site and the kernel from contradicting each other.

### What went wrong

The site published `8,472` theorems, `495,973` lines and `287` modules while the
artifact said `11,000`, `330,569` and `311`. Three independent faults stacked:

1. **The projection was written against a schema that does not exist.** It read
   `readme_sync.lean_version`, `readme_sync.build_jobs`, `stats.*` and a
   top-level `files[]`. The artifact has never carried any of them; the real
   keys are `lean_toolchain`, `production_files`, `production_loc`,
   `proved_theorem_lemma_decls` and `summary.module_count`. Every miss fell
   through to a fallback. Its unit tests passed because their fixtures were
   built in the same invented shape.

2. **The fallbacks were fabrications, not degradations.** `lines` came from
   `GET /languages`, dividing Lean bytes by an empirical constant of 38.
   `modules` came from a git-tree scan of `SeLe4n/Kernel/**` — a third
   definition, 249, alongside the snapshot's 287 and the artifact's 311.
   `buildJobs` was `modules × 2`, and "574 parallel build jobs" appeared twice
   in the page's copy; upstream publishes no build-job count anywhere.
   `admitted: 0` was a literal in the source.

3. **Nothing asserted provenance.** `validate-data.mjs` checked that every field
   had the right type, and it did. A snapshot assembled entirely from README
   prose and byte estimates validated cleanly, so the drift was invisible in CI.
   The fix commit that repaired the projection hand-edited
   `metricsSource: docs/codebase_map.json` into the snapshot without re-running
   the sync, and the wrong numbers shipped under a label claiming otherwise.

A fourth fault was latent: each `locales/*.json` bakes the metric literals into
its translated HTML, because `data-i18n-html` replaces an element's innerHTML
wholesale. Those copies said `546` build jobs while `index.html` said `574`.

### The invariants now

- **The browser derives nothing.** `assets/js/site.js` fetches
  `data/site-data.json` and renders it. The five GitHub endpoints, the README
  parse, the byte estimate and the 30-day `localStorage` cache are gone; the
  legacy cache key is purged on load so returning visitors stop carrying a
  stored snapshot of the heuristics. `index.html` sets `connect-src 'self'`,
  which makes this a rule the browser enforces rather than a convention.
- **Substitution stays inside the artifact.** A metric may fall back to another
  key of the same artifact; it may never fall back to a source outside it. When
  a required key is missing, `canonicalMetricsIssues()` aborts the sync and
  names the statistic it feeds, so an upstream schema change is a red build.
- **Scope is production Lean.** `proved_theorem_lemma_decls` is production-only
  by construction upstream, so modules (`production_files`) and lines
  (`production_loc`) are taken production-only too. The three headline figures
  describe one corpus and match the README exactly. `metricsScope: "production"`
  records the decision in the data.
- **Provenance is checkable.** The snapshot carries `metricsSource`,
  `metricsScope`, `sourceRepo`, `sourceRef`, `schemaVersion` and `sourceDigest`,
  and `validate-data.mjs` pins the first four to exact values. `commitSha` and
  `updatedAt` come from the artifact's own `repository.head` — the commit the
  statistics were *measured* at, not the tip of `main`.
- **Every literal copy is stamped from the snapshot.**
  `apply-static-values.mjs` rewrites `index.html` and all six locale bundles,
  and `static-values.test.mjs` fails if the committed tree drifts. Counts are
  comma-grouped identically on both sides so hydration does not visibly rewrite
  a figure.
- **`admitted` is derived, not asserted.** It counts `axiom` declarations plus
  declarations whose `called` list reaches `sorry`/`sorryAx`, and returns
  `undefined` rather than a published `0` when the artifact carries no
  declaration inventory — an absent inventory is not evidence of zero.

### Consequences accepted

The page no longer states a build-job count; the Tier 1 and quick-start copy
cite the canonical Lean-module count instead, in all six locales. Statistics are
now as fresh as the last CI sync, which runs weekly and on every upstream
release via `repository_dispatch` — in exchange, a visitor no longer downloads
574 KB of canonical map to read six integers, and no render path can produce a
figure the kernel never asserted.
