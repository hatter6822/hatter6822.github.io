# Testing and Validation Matrix

This repository uses lightweight Node-based checks.

> Documentation baseline: website release **0.3.1**.

## Automated checks

### Parser and extraction regression tests

```bash
node scripts/lib/lean-analysis.test.mjs
node scripts/lib/data-validation.test.mjs
node scripts/lib/map-runtime.test.mjs
node scripts/lib/map-toolbar.test.mjs
```

Validates:
- Lean import token extraction
- interior symbol extraction across all supported declaration kinds and line tracking
- theorem counting behavior, including declaration-first theorem derivation from `docs/codebase_map.json` payloads
- README metric table parsing
- data schema and graph consistency validation behavior, including `updatedAt` undefined/empty/valid ISO handling
- map runtime normalization (modules-array-first hydration, branch-wrapper payload extraction, rejection of payloads that omit `modules[]`, filtering of branch-ref pseudo-modules and URL module paths, declaration-centric canonical payload support, declaration projection into symbol buckets, theorem/function fallback derivation from `byKind` when explicit arrays are empty, path-based dependency normalization, deterministic module/file ordering, stable per-module defaults, `symbolsLoaded` correctness, interior-kind group aggregation/default-selection behavior, interior search caret-range normalization used by live filter rerenders, declaration call-graph preservation and cross-module merging from `modules[].declarations[].called`, precomputed reverse graph index for O(1) caller lookups, declaration-context legend entries, reverse call-graph resolution for caller lookup, `declarationModuleOf` fallback resolution via `declarationIndex` for declarations not in `declarationGraph`, zero-relationship declaration context validation with kind/line resolution, reverse-graph-only declaration module resolution and metadata access, large declaration lane sorting verification for module-relevance prioritization, declaration lane collapse threshold/visible limit exposure via test hooks, `applyTestState` acceptance of `declarationLanesExpanded`/`flowContext`/`selectedDeclaration`, interior menu active-declaration tracking in declaration context, declaration lane expansion logic for fully expanding collapsed lanes, assurance level computation for linked/local/none proof pair states, related proof module neighbor detection for Operations/Invariant pairs, external import deduplication and internal module exclusion, nearest linked-proof path discovery via BFS, and `declarationIndex` construction and O(1) lookup verification for module/kind/line resolution)
- map toolbar structural integrity (toolbar placement before interior menu, compact-density semantics, flowchart aria-controls ownership, removed legacy controls, `.sr-only` CSS definition for screen-reader elements, `:empty` interior menu hiding, empty initial container state, declaration breadcrumb `<nav>` element and `aria-label`, context-aware search label updates, dynamic `flowchart-wrap` `aria-label` switching, flowchart-shell container structure, mobile hint element presence, flow node rect CSS transition, light-theme assurance fallback colors, `buildFlowNodeGroup` shared helper existence, `role="img"` for non-interactive SVG nodes, `aria-roledescription="flowchart"` on SVG element, `declarationIndex` presence in normalization output, instant scroll positioning via `scrollBehavior = "auto"`, CSS `contain: layout style` on flowchart container, `cursor: pointer` on navigable interior items, legend `role="list"`/`role="listitem"` and `aria-hidden` swatches, self-edge guard in `drawFlowEdge`, clean function signatures without unused parameters, `DocumentFragment` batch DOM insertion, interior menu item flex layout and hover state, interior menu item CSS transitions, kind label `white-space: nowrap` and `margin-left: auto` right-alignment, `focus-visible` outlines on interior buttons, items list `scrollbar-width: thin`, grid `min()` overflow prevention, navigable item `flex-wrap: nowrap`, span fallback for empty hrefs, legacy src-link removal guard, `declarationSearchMatch` function existence and test hook export, `moduleSearchMatches` test hook export, `tryDeclarationSearch` fallback in search flow, `.module-search-option-decl` CSS styling for declaration suggestions, `scrollbar-gutter: stable` on interior menu items, `searchDeclSuggestions` state tracking, `data-declaration` attribute support in option list, `declarationSearchMatches` function existence and test hook export, `buildDeclarationSearchIndex` pre-indexing function, `declarationSearchList` state tracking, `searchDeclarationsInModule` helper, and edge layer `aria-hidden` for screen reader exclusion)
- search bar context correctness (context search uses dot-append format `Module.Declaration` in declaration context with dynamic "Context search — declaration"/"Context search — module" labeling, `selectDeclaration` syncs search bar value, Reset button returns to module context from declaration view, scroll preservation in declaration flowchart re-renders)
- DOM element caching (`cacheDomElements` initialization on boot, `DOM` namespace for flowchartWrap/moduleSearch and other frequently accessed elements)
- label wrap cache batch eviction (`LABEL_WRAP_CACHE_EVICT_BATCH` constant, 120-entry batch eviction cycle)
- declaration search via dot-append notation (`declarationSearchMatch` exact/prefix/substring matching, module-qualified declaration resolution, cross-module search via pre-built `declarationSearchList` global index, edge cases for missing dots and module-only queries, `declarationSearchMatches` multi-result ranked search for dropdown suggestions, `buildDeclarationSearchIndex` pre-indexing pipeline verification, `searchDeclarationsInModule` module-scoped declaration matching)
- module search scoring algorithm (`moduleSearchMatches` exact match ranking, prefix-before-substring ordering, empty query behavior returning first 10 modules)
- accessibility: edge layer `aria-hidden` attribute on flowchart SVG group for screen reader exclusion of decorative edges
- interior kind color coding (`interiorKindColor` known kind resolution, plural normalization fallback via `normalizeDeclarationKind`, gray fallback for unknown kinds, `normalizeDeclarationKind` plural-to-singular/case/whitespace normalization)
- assurance level computation (`assuranceForModule` theorem density tracking, descriptive detail text with theorem counts, structural-only detail for zero-theorem linked pairs, `ASSURANCE_COLORS` constant validation for all four levels with hex color format verification, partial assurance level detection for proof pairs where invariant exists but does not import operations)
- flow legend expansion (10-entry legend with individual assurance level colors verified against `assuranceColors` hook)
- `isLikelyModuleToken` standalone validation (valid module paths accepted, lowercase/empty/null/malformed rejected)
- theorem deduplication (`theoremCountFromCodebaseMap` skips modules in `moduleMeta` already counted from `modules[]`)
- edge case robustness (zero-theorem sources, null/undefined/string inputs to `theoremCount` and `theoremCountFromCodebaseMap`, empty import sources)
- data validation root guards (`validateSiteDataObject` and `validateMapDataObject` reject null/non-object roots, wrong types on numeric fields, duplicate module entries, non-string entries in modules array)
- noncomputable theorem counting (`theoremCount` correctly matches `noncomputable theorem` and `noncomputable lemma` declarations with attributes)
- empty declarations array edge case (`theoremCountFromCodebaseMap` returns zero for modules with empty `declarations: []`)
- non-numeric metric cell robustness (`parseCurrentStateMetrics` returns empty object when table cells contain only text without numbers)
- import continuation with comment-only lines (`extractImportTokens` skips comment-only continuation lines and resumes parsing subsequent continuation imports)
- service proof-pair detection (`SeLe4n.Kernel.Service.Operations`/`Invariant` linked pair with correct assurance level and theorem density)
- IPC multi-module proof-pair detection (`SeLe4n.Kernel.IPC.Operations`/`Invariant` linked pair with `DualQueue` getting independent local assurance)
- service declaration context (`declarationIndex` mapping for `serviceStart`/`serviceStop`/`serviceRestart` operations, call graph edges, reverse graph callers, invariant theorem index entries)
- IPC message transfer declarations (`endpointSendDual`/`endpointReceiveDual`/`endpointReply`/`endpointCall`/`endpointReplyRecv` call graph edges, message population helper reverse lookups, compound operation reverse edges, module resolution)

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
node --check assets/js/header-nav.js
node --check assets/js/site.js
node --check assets/js/background-pattern.js
node --check assets/js/theme-init.js
```

## Manual verification recommendations

- Confirm `index.html` and `map.html` load from a static server.
- Confirm header navigation active-link stability: clicking a same-page nav hash keeps the selected nav item marked (`aria-current="true"` for section tracking, `aria-current="page"` for page-level nav) while smooth scrolling settles, with no rapid oscillation to adjacent sections.
- Stress-test long hash jumps (top-to-lower sections and back) in Chromium: active nav state should transition once per section boundary and stay stable near boundaries (no alternating flicker), including after repeated clicks on links whose sections are near midpoint boundaries.
- While a lower section is active (for example `/#verification`), trigger an asynchronous layout shift (expand/collapse content above the fold using DevTools or temporary DOM edits): active nav selection should remain deterministic (no back-and-forth oscillation) and converge to the true in-focus section after layout settles.
- Verify hash-near-header behavior: when the URL hash matches a section whose heading is currently inside the fixed-header focus window, that section's nav link remains active even if tiny scroll jitter is present.
- Verify repeated same-page hash clicks (especially `/#verification`, `/#api`, `/#roadmap`) do not produce alternating `aria-current` assignments in Chrome after smooth-scroll completes.
- Verify rapid alternating clicks across multiple hash links (for example `/#features` → `/#security` → `/#verification` → `/#getting-started`) converge to the final clicked section without post-settle `aria-current` oscillation.
- Confirm only one nav controller is active on `index.html`: with normal script order (`site.js` before `header-nav.js`), `header-nav.js` should own same-page hash behavior and no duplicate `aria-current` toggling should be observable in DevTools event listener traces.
- Test map page on mobile viewport (~390px width). Verify flow-node text does not overflow node boundaries — text should wrap within the node rect and be clipped cleanly at node edges.
- Confirm the compact toolbar is rendered before the interior declaration panel and contains only current module context search and reset, with compact-density toolbar semantics.
- Confirm map context-search keyboard navigation (Arrow/Home/End) and keyboard traversal still function.
- Confirm flow legend chips render in the flowchart upper-right corner (not as detached panels) and remain visible while panning/scrolling the chart.
- Confirm reset clears any search validity errors and preserves a minimal toolbar footprint across desktop/mobile breakpoints.
- On `index.html`, verify the background animation toggle in the header pauses the WebGL background immediately, updates `aria-pressed`, and resumes animation when toggled again (test on desktop and ~390px mobile viewport).
- Confirm each interior dropdown (Object, Context/Init, Extension) defaults to `All (N)`, can switch kinds, and deep-link declarations to source lines.
- Confirm interior declaration chips and kind-select options are color-coded consistently by declaration kind (selector serves as key for chip colors).
- Confirm interior declaration ordering is case-insensitive alphabetical within each dropdown selection, including `All` aggregation.
- Confirm the `Filter declarations across all kinds…` search box accepts multi-character typing without dropping focus/caret after each keystroke.
- Confirm selecting a different module node in the flow chart updates all three interior declaration scrollboxes (Object/Context-Init/Extension) to the newly selected module.
- Confirm modules-array payload compatibility by testing both string and object module entries, including branch-wrapper payloads where top-level `main` metadata must not become a module node.
- Confirm legacy symbol compatibility with snapshots that use `symbols.by_kind` and/or `constant` declaration keys.
- Confirm map live status messaging remains coherent during load/refresh.
- Confirm that clicking any declaration in the interior panel switches the flowchart to declaration context, showing the declaration as a center node with calls (left) and callers (right).
- Confirm that declarations with zero relationships display a centered node with an informative "No internal call relationships detected" hint text below the node.
- Confirm the declaration context breadcrumb displays "ModuleName › DeclarationName" using a semantic `<nav>` element with `aria-label="Declaration breadcrumb"`, and clicking the module name returns to module context.
- Confirm the context search bar shows `Module.Declaration` in dot-append format in declaration context and the label reads "Context search — declaration"; in module context, it shows only the module name with label "Context search — module". Confirm the Reset button returns to module context from declaration context.
- Confirm the `flowchart-wrap` container `aria-label` updates to "Declaration call graph for [name]" in declaration context and "Dependency and proof flow chart" in module context.
- Confirm the center (selected) declaration node is keyboard-focusable (tabindex="0") so keyboard users can navigate to it.
- Confirm declaration flowchart scroll position is preserved when expanding/compacting lanes.
- Confirm that navigable declaration nodes in the declaration flowchart (those with forward or reverse call-graph entries) can be clicked to chain into further declaration contexts.
- Confirm the `decl` URL parameter is set when entering declaration context and cleared when returning to module context.
- Confirm that all declarations in the interior panel display a clickable name button for uniform declaration-context navigation.
- Confirm that when a declaration has more than 12 calls or callers, same-module declarations are prioritized in the visible first 10, with an interactive "+N more" expand button for the remainder.
- Confirm that clicking the "+N more" expand button fully expands the declaration lane to show all declarations, and a "Return to Compact" button appears to collapse back.
- Confirm that the declaration lane expansion state resets when navigating to a new declaration or returning to module context.
- Confirm the currently selected declaration is visually highlighted in the interior menu with an accent-colored border and background.
- Confirm the "Selected declaration" lane label is always visible in declaration context (even when no calls/callers exist).
- Confirm interior menu items show a visible hover state (kind-color-tinted border and background) on mouse hover.
- Confirm interior menu item kind labels (e.g., "theorem", "def") are right-aligned and do not wrap to the next line.
- Confirm interior menu declaration chips have symmetric left/right padding so kind labels remain visually aligned to the right edge.
- Confirm interior menu declaration buttons show a visible focus outline when navigated via keyboard (Tab key).
- Confirm interior menu items have adequate touch target size on mobile (~390px width) — items should be at least 2.2rem tall.
- Confirm the interior menu grid does not cause horizontal overflow on narrow viewports (< 420px).
- Confirm the breadcrumb module-return button has adequate touch target size on mobile.
- Confirm interior menu items without a resolvable source path display the declaration name as plain text (not a broken link).
- Confirm the interior menu items list scrolls smoothly with a thin scrollbar when the list exceeds the container height.
- Confirm that typing a dot-appended query like `Module.Name.declarationName` in the search bar navigates to the declaration context for that declaration within the specified module.
- Confirm that partial dot-appended queries (e.g., `Module.Name.api`) show declaration suggestions in the dropdown with distinct italic styling and a left border accent.
- Confirm that selecting a declaration suggestion via keyboard (Enter) or mouse click navigates to declaration context and displays the search feedback "Declaration: name in Module".
- Confirm that the search bar correctly falls back to declaration search when no module match is found, with an appropriate error message when no declaration match exists either.

### Cross-browser nav stability probe (optional, Playwright)

If Playwright browsers are available in your environment, run a smoke probe that clicks a hash nav link and samples active nav state over time (requires Python Playwright package and browser binaries).

```bash
# serve the repository root
python3 -m http.server 4173 --bind 0.0.0.0

# in another shell, use Playwright (chromium/firefox/webkit)
python3 scripts/nav-stability-smoke.py
```

Expected: for each tested nav hash (`/#features`, `/#security`, `/#verification`, `/#getting-started`), the selected link remains active through the full sample window **and** the corresponding section remains in-focus under the fixed header offset window, with no unexpected active-link transitions after initial settle. The probe also injects a synthetic asynchronous layout shift while `/#verification` is active; `aria-current` must remain stable and the target section must stay aligned under the fixed header window. Finally, a rapid alternating-click stress sequence must converge to the final clicked link with stable `aria-current` and stable in-focus alignment after settle, and each sample must show the currently active link's own section aligned within the fixed-header focus window.
