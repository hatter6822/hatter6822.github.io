# Testing and Validation Matrix

This repository uses lightweight Node-based checks.

> Documentation baseline: website release **0.1.0**.

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
- map toolbar structural integrity (toolbar placement before interior menu, compact-density semantics, flowchart aria-controls ownership, removed legacy controls, `.sr-only` CSS definition for screen-reader elements, `:empty` interior menu hiding, empty initial container state, declaration breadcrumb `<nav>` element and `aria-label`, context-aware search label updates, dynamic `flowchart-wrap` `aria-label` switching, flowchart-shell container structure, mobile hint element presence, flow node rect CSS transition, light-theme assurance fallback colors, `buildFlowNodeGroup` shared helper existence, `role="img"` for non-interactive SVG nodes, `aria-roledescription="flowchart"` on SVG element, `declarationIndex` presence in normalization output, instant scroll positioning via `scrollBehavior = "auto"`, CSS `contain: layout style` on flowchart container, `cursor: pointer` on navigable interior items, legend `role="list"`/`role="listitem"` and `aria-hidden` swatches, self-edge guard in `drawFlowEdge`, clean function signatures without unused parameters, `DocumentFragment` batch DOM insertion, interior menu item flex layout and hover state, interior menu item CSS transitions, kind label `white-space: nowrap` and `margin-left: auto` right-alignment, `focus-visible` outlines on interior buttons and src links, items list `scrollbar-width: thin`, grid `min()` overflow prevention, navigable item `flex-wrap: nowrap`, span fallback for empty hrefs, and href guard for src links)
- search bar context correctness (declaration name appended with › separator in declaration context, scroll preservation in declaration flowchart re-renders)

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
- Confirm header navigation active-link stability: clicking a same-page nav hash keeps the selected nav item marked (`aria-current="page"`) while smooth scrolling settles, with no rapid oscillation to adjacent sections.
- Stress-test long hash jumps (top-to-lower sections and back) in Chromium: active nav state should transition once per section boundary and stay stable near boundaries (no alternating flicker), including after repeated clicks on links whose sections are near midpoint boundaries.
- While a lower section is active (for example `/#verification`), trigger an asynchronous layout shift (expand/collapse content above the fold using DevTools or temporary DOM edits): active nav selection should remain deterministic (no back-and-forth oscillation) and converge to the true in-focus section after layout settles.
- Verify hash-near-header behavior: when the URL hash matches a section whose heading is currently inside the fixed-header focus window, that section's nav link remains active even if tiny scroll jitter is present.
- Verify repeated same-page hash clicks (especially `/#verification`, `/#api`, `/#roadmap`) do not produce alternating `aria-current` assignments in Chrome after smooth-scroll completes.
- Verify rapid alternating clicks across multiple hash links (for example `/#features` → `/#security` → `/#verification` → `/#getting-started`) converge to the final clicked section without post-settle `aria-current` oscillation.
- Confirm only one nav controller is active on `index.html`: with normal script order (`site.js` before `header-nav.js`), `header-nav.js` should own same-page hash behavior and no duplicate `aria-current` toggling should be observable in DevTools event listener traces.
- Test map page on mobile viewport (~390px width).
- Confirm the compact toolbar is rendered before the interior declaration panel and contains only current module context search and reset, with compact-density toolbar semantics.
- Confirm map context-search keyboard navigation (Arrow/Home/End) and keyboard traversal still function.
- Confirm flow legend chips render in the flowchart upper-right corner (not as detached panels) and remain visible while panning/scrolling the chart.
- Confirm reset clears any search validity errors and preserves a minimal toolbar footprint across desktop/mobile breakpoints.
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
- Confirm the module-search bar shows `ModuleName › DeclarationName` in declaration context and the label reads "Current declaration context"; in module context, it shows only the module name with label "Current module context".
- Confirm the `flowchart-wrap` container `aria-label` updates to "Declaration call graph for [name]" in declaration context and "Dependency and proof flow chart" in module context.
- Confirm the center (selected) declaration node is keyboard-focusable (tabindex="0") so keyboard users can navigate to it.
- Confirm declaration flowchart scroll position is preserved when expanding/compacting lanes.
- Confirm that navigable declaration nodes in the declaration flowchart (those with forward or reverse call-graph entries) can be clicked to chain into further declaration contexts.
- Confirm the `decl` URL parameter is set when entering declaration context and cleared when returning to module context.
- Confirm that all declarations in the interior panel display both a clickable name button and a "src" link for uniform navigation.
- Confirm that when a declaration has more than 12 calls or callers, same-module declarations are prioritized in the visible first 10, with an interactive "+N more" expand button for the remainder.
- Confirm that clicking the "+N more" expand button fully expands the declaration lane to show all declarations, and a "Return to Compact" button appears to collapse back.
- Confirm that the declaration lane expansion state resets when navigating to a new declaration or returning to module context.
- Confirm the currently selected declaration is visually highlighted in the interior menu with an accent-colored border and background.
- Confirm the "Selected declaration" lane label is always visible in declaration context (even when no calls/callers exist).
- Confirm interior menu items show a visible hover state (kind-color-tinted border and background) on mouse hover.
- Confirm interior menu item kind labels (e.g., "theorem", "def") are right-aligned and do not wrap to the next line.
- Confirm interior menu buttons and src links show a visible focus outline when navigated via keyboard (Tab key).
- Confirm interior menu items have adequate touch target size on mobile (~390px width) — items should be at least 2.2rem tall.
- Confirm the interior menu grid does not cause horizontal overflow on narrow viewports (< 420px).
- Confirm the breadcrumb module-return button has adequate touch target size on mobile.
- Confirm interior menu items without a resolvable source path display the declaration name as plain text (not a broken link).
- Confirm the interior menu items list scrolls smoothly with a thin scrollbar when the list exceeds the container height.

### Cross-browser nav stability probe (optional, Playwright)

If Playwright browsers are available in your environment, run a smoke probe that clicks a hash nav link and samples active nav state over time (requires Python Playwright package and browser binaries).

```bash
# serve the repository root
python3 -m http.server 4173 --bind 0.0.0.0

# in another shell, use Playwright (chromium/firefox/webkit)
python3 scripts/nav-stability-smoke.py
```

Expected: for each tested nav hash (`/#features`, `/#security`, `/#verification`, `/#getting-started`), the selected link remains active through the full sample window **and** the corresponding section remains in-focus under the fixed header offset window, with no unexpected active-link transitions after initial settle. The probe also injects a synthetic asynchronous layout shift while `/#verification` is active; `aria-current` must remain stable and the target section must stay aligned under the fixed header window. Finally, a rapid alternating-click stress sequence must converge to the final clicked link with stable `aria-current` and stable in-focus alignment after settle, and each sample must show the currently active link's own section aligned within the fixed-header focus window.
