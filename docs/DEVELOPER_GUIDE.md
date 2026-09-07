# Developer Guide: File-by-File Orientation

This guide explains what each major file in the repository is responsible for, how data and control flow through the system, and where to make common changes safely.

It is intended to help a new contributor answer two questions quickly:

1. **Where does a behavior come from?**
2. **Which file should I edit for a given change?**

## 1) Mental model of the project

The repository is a static website with three pages and a data pipeline:

- `index.html` is the marketing/overview page.
- `map.html` is the interactive codebase map page: Lean module workspace, Rust production crates, repository inventory.
- `run.html` is the Simulator.
- `data/*.json` stores local snapshots consumed by the browser.
- `scripts/*.mjs` regenerates and validates those snapshots.

The runtime is intentionally **local-first**:

1. Render from bundled `data/*.json` immediately.
2. Reuse cached payloads when they are newer.
3. On `map.html` / `run.html` only, try a live refresh from GitHub. The landing
   page does not: its statistics come from `data/site-data.json` alone.
4. Keep rendering stable if network refresh fails.

## 2) Top-level files

### `README.md`
Project entrypoint and operational quickstart. Keep this concise and link deeper docs rather than duplicating deep implementation notes.

### `CONTRIBUTING.md`
Contributor policy and required validation commands before commit.

### `CLAUDE.md`
AI-assisted development guidance file. Contains project overview, build commands, validation tiers, large file handling rules, architectural conventions, file ownership reference, and documentation sync requirements.

### `LICENSE`, `THIRD_PARTY_NOTICES.md`, `LICENSE-AUDIT.md`
Licensing and attribution compliance documents. Do not remove third-party notices when refactoring imported/vendor code.

### `CNAME`
Custom domain binding for GitHub Pages deployment.

## 3) HTML entrypoints

### `index.html` (landing page)
Owns:

- SEO metadata (`description`, OpenGraph, Twitter tags, canonical URL).
- security posture (`Content-Security-Policy`, `Permissions-Policy`, `referrer` policy).
- accessible global nav and section anchors.
- placeholders marked with `data-live="..."` that runtime JS updates from `data/site-data.json`, pre-filled at build time with the values from that same snapshot.
- script load order:
  1. `theme-init.js` (early, in `<head>`) to avoid theme flash.
  2. `i18n.js` (early, in `<head>`) for locale detection and DOM translation.
  3. `header-nav.js`, `site.js` (deferred in body).

The landing page includes documentation of the upstream seLe4n Rust syscall wrapper crates (`sele4n-types`, `sele4n-abi`, `sele4n-sys`, `sele4n-hal`) in the architecture diagram, feature grid, comparison table, project structure tree, getting started guide, and roadmap sections.

Edit this file when adding/removing a section, changing metadata defaults, or wiring new live data placeholders.

### `map.html` (interactive map page)
Owns:

- compact hero: status column with the snapshot stamp, one-line stats strip (`data-map="..."` placeholders, including `rustCrates`), section jump links.
- the three page sections in the order tests assert: `#module-graph` (toolbar shell, `.workspace-grid` with `#flowchart-wrap` and the `.declaration-explorer` sidebar holding `#flow-node-interior-menu`), `#rust-crates` (`#rust-crate-grid`, rendered by JS), `#repository-inventory` (`#repository-inventory-groups` and `#inventory-provenance`, rendered by JS).
- compact control surface (context search + reset).
- map status and stat placeholders.
- script load order:
  1. `theme-init.js` in head.
  2. `i18n.js` in head for locale detection and DOM translation.
  3. `header-nav.js`, `map.js` deferred.

Edit this file when adding map controls or changing semantic structure of map UI regions.

### `run.html` (Simulator page)
Owns:

- Simulator hero, transport bar (play/step/scrub), scene tabs, SVG stage, invariant rail, inspector, and sandbox toggle shells.
- fixture-provenance disclaimer copy (the bundled traces are a hand-authored reference fixture until the upstream kernel emits `docs/execution-traces.json`).
- script load order mirrors `map.html`, with `run.js` deferred last.

Edit this file when adding scenes/controls or changing semantic structure of Simulator UI regions. The full design is in `docs/SIMULATOR_SPEC.md`.

### `404.html` (not-found page)
Minimal branded page served by GitHub Pages for unknown paths. Uses absolute asset URLs (it renders at arbitrary paths), the shared hero styling, `theme-init.js` only, and `noindex`. Covered by `csp-html.test.mjs`.

## 4) Browser runtime scripts (`assets/js/`)

### `assets/js/theme-init.js`
Very small boot script executed before first paint. Responsibilities:

- read saved theme from `localStorage` key `sele4n-theme`.
- if missing, resolve against `prefers-color-scheme`.
- set `data-theme` on `<html>` as early as possible.

Design goal: avoid a dark/light flash while keeping failure-safe behavior if storage is unavailable.

### `assets/js/i18n.js`
Internationalization runtime for multi-language support. Responsibilities:

- detects preferred locale from URL param (`?lang=`), `localStorage`, or browser `navigator.languages`.
- fetches the appropriate locale JSON bundle from `/locales/<code>.json`.
- walks the DOM translating elements with `data-i18n`, `data-i18n-placeholder`, `data-i18n-aria-label`, `data-i18n-title`, and `data-i18n-content` attributes.
- exposes `window.sele4nI18n` API for JS-side translations: `t(key, vars)`, `setLocale(locale)`, `locale()`, `onReady(cb)`, `translateDOM()`.
- supports interpolation via `{{variable}}` placeholders in locale strings.
- initializes and manages the language switcher dropdown UI in the navigation bar.
- fires `sele4n:locale-changed` CustomEvent when the locale changes.
- supported locales: `en`, `es`, `fr`, `ja`, `zh-CN`.

### `locales/*.json`
Locale string bundles organized by page section. Structure mirrors the site's section hierarchy (`nav`, `hero`, `about`, `architecture`, `comparison`, `features`, `security`, `verification`, `api`, `structure`, `getting_started`, `roadmap`, `footer`, `map`). Each key maps to a translated string with optional `{{variable}}` interpolation.

### `assets/js/site.js`
Main runtime for `index.html`. Responsibilities:

- applies live site metrics from bundled/cached/fetched payloads.
- updates SEO description content based on live theorem counts.
- updates JSON-LD script metadata (`version`, optional `dateModified`).
- manages theme toggle behavior and OS theme-change reactions.
- manages navigation behavior (mobile toggle, active-section state, hash offset logic).
- handles local cache policy and network fetch timeout behavior.

If a landing-page behavior looks dynamic, start here first.

### `assets/js/header-nav.js`
Navigation stability controller shared by both pages. Responsibilities:

- deterministic hash-link navigation behavior.
- stable `aria-current` updates under smooth scroll/layout shifts.
- fixed-header offset compensation so linked sections are not hidden.
- prevention of active-link oscillation in rapid click/scroll sequences.

Use this file when changing same-page hash behavior or accessibility semantics of active nav state.

### `assets/js/map.js`
Largest runtime module; owns map page data and rendering behavior. Responsibilities:

- hydrates graph state from `data/map-data.json` and optional live sync.
- normalizes legacy/new payload shapes for compatibility.
- preserves declaration call-graph relationships (`called` field) into a merged `declarationGraph` and precomputed `declarationReverseGraph` for O(1) caller lookups during declaration context navigation. Also builds a `declarationIndex` mapping every declaration name to `{module, kind, line}` for O(1) metadata lookups.
- resolves declaration module ownership via `declarationGraph` first, then falls back to `declarationIndex` for O(1) lookup (replacing the previous O(n*m) `moduleMeta` symbol scan).
- computes filtered graph neighborhood based on selected module and detail mode.
- renders module-context node/edge flowchart and legend semantics.
- renders declaration-context call-graph flowchart with breadcrumb navigation (`<nav>` element with `aria-label`) for bidirectional module/declaration context switching, including informative empty-state hints for declarations with zero relationships. Declaration flowchart preserves scroll position across re-renders.
- both flowchart renderers share six extracted helpers (`createFlowSvg`, `createFlowLegend`, `flowLaneLabel`, `applyFlowScrollTarget`, `computeFlowLayout`, `buildFlowNodeGroup`) to eliminate SVG setup, legend, layout, scroll-target, and node construction duplication. Node heights for proof and external sections are pre-computed during layout to avoid redundant recalculation. `buildFlowNodeGroup` clips all text content to the node rect via SVG `<clipPath>` to prevent overflow on mobile viewports.
- sorts large declaration lanes by module relevance (same-module first) before collapsing to keep contextually relevant declarations visible; collapsed "+N more" nodes are interactive expand buttons that fully reveal all declarations, with "Return to Compact" buttons to collapse back.
- declaration flow-node `flow-meta` line numbers now render as clickable links to the exact upstream source line in `hatter6822/seLe4n` (using current `commitSha` when available, else fallback ref), opening in a new tab with keyboard-accessible focus behavior.
- builds the tabbed declaration sidebar (Objects, Contexts/Inits, Extensions) with all declarations navigable to declaration context; highlights the currently selected declaration with a visual accent indicator; remembers the active tab across module changes.
- opens on `DEFAULT_MODULE` (`SeLe4n.Kernel.API`) when the URL names no module (`defaultModuleName()`), on load, after a tree rebuild, and on Reset.
- groups over-budget lanes by subsystem (`moduleSubsystem`, `groupLaneModules`, `buildLaneEntries`, `toggleLaneGroup`, `drawLaneGuide`) and opens groups in place.
- renders the Rust crate section (`renderRustCrates`, `renderRustDependencyStrip`, `renderRustCrateCard`, `renderRustFile`, `renderRustItemList`) and the repository inventory (`classifyRepositoryPath`, `buildRepositoryInventory`, `renderRepositoryGroups`, `renderInventorySubgroup`, `renderInventoryList`) from `state.rust` and `state.files`, once per data load (`renderInventory`) and again on locale change.
- keeps the file tree and Rust inventory across live refreshes that carry neither (`retainInventory`, `normalizeRustInventory`), tracking `inventoryCommit` / `rustCommit`.
- scopes live payloads and the tree-rebuild path the way the bundle is scoped (`isOutsideProductionScope`, `isLeanModulePath`: nothing under `tests/` or `SeLe4n/Testing/`, plus `Main.lean`), labels in-repository imports outside that scope as such rather than "external dependency" (`isInRepoOutsideScope`), and lists Rust test items only behind each card's toggle (`state.rustShowTests`, `visibleRustItems`, `rerenderRustCrateCard`).
- handles keyboard navigation, search, reset, and URL-state synchronization (including `decl` parameter for declaration context persistence). The generalized context search bar is context-aware: in declaration context it displays `Module.Declaration` in dot-append format with the label "Context search — declaration"; in module context it shows the module name with the label "Context search — module". The `flowchart-wrap` `aria-label` updates dynamically per context. The Reset button returns from declaration context to module context. Supports dot-append declaration search (e.g., `SeLe4n.Kernel.API.apiInvariantBundle`) via two complementary strategies: (1) `declarationSearchMatch()` progressively tries shorter dot-separated module prefixes and matches the remaining suffix against interior symbols via `searchDeclarationsInModule()`; (2) when no exact module prefix matches, a global search across all declarations uses a pre-built `declarationSearchList` index (constructed by `buildDeclarationSearchIndex()` during data load). `declarationSearchMatches()` returns multiple ranked results for dropdown suggestions. Exact matches navigate immediately; partial matches appear as styled suggestions with `data-declaration` attributes. The search flow integrates `tryDeclarationSearch` as a fallback when no module match is found.
- caches frequently queried DOM elements (`flowchartWrap`, `moduleSearch`, `moduleSearchOptions`, `moduleSearchFeedback`, `moduleSearchLabel`, `flowNodeInteriorMenu`, `mapStatus`, `mainContent`, `moduleResults`) once at boot in a `DOM` namespace object via `cacheDomElements()` to avoid repeated `getElementById` calls during render cycles. All DOM-accessing functions use `DOM.xxx || document.getElementById(...)` fallback pattern.
- uses batch eviction (120 entries per cycle via `LABEL_WRAP_CACHE_EVICT_BATCH`) for the label-wrap cache to amortize eviction cost and prevent single-entry churn on cache-full renders.
- manages map status messaging and sync lifecycle feedback.

If the map visualization, interactions, or data compatibility changes, this is the primary file.

## 5) Stylesheets (`assets/css/`)

### `assets/css/style.css`
Global stylesheet for shared layout/design system:

- base tokens, colors, typography, and spacing.
- shared nav, buttons, cards, sections, utilities.
- responsive behavior used by both pages.

### `assets/css/map.css`
Map-page-only styles:

- compact hero (status column, stats strip, section jump links) and section headings with the `production-badge`.
- workspace grid: single column by default, chart + sticky declaration sidebar at `min-width: 75rem`.
- tabbed declaration sidebar (`.interior-menu-tabs`, `.interior-menu-tab[aria-selected]`).
- flowchart workspace and toolbar layout; subsystem group nodes (`.flow-node.lane-group`, `.lane-member`, `.lane-guide`).
- Rust section: dependency strip SVG, crate cards, per-file `<details>`, item chips coloured by kind via `--rust-kind-color`.
- repository inventory: group and subgroup `<details>`, production highlighting via `[data-production="true"]`, lazy file/module lists.
- graph node/edge visual semantics.
- interior declaration panel styling with flex layout, hover states, CSS transitions, and kind label right-alignment.
- `.sr-only` / `.visually-hidden` screen-reader utility class.
- `:empty` state hiding for interior menu pre-selection.
- CSS `contain: layout style` on flowchart container for rendering performance.
- `focus-visible` outlines on interior menu buttons and source links for keyboard accessibility.
- responsive breakpoints for interior menu items (mobile touch targets, landscape compaction, narrow viewport overflow prevention).
- map-specific responsive/mobile tuning.

### `assets/css/run.css`
Simulator-page-only styles: stage/scene layout, transport bar, invariant rail states, inspector, and sandbox banner.

Rule of thumb: shared primitive in `style.css`; map-only styling in `map.css`; Simulator-only styling in `run.css`.

## 6) Runtime data snapshots (`data/`)

### `data/site-data.json`
The only source of the landing page's statistics. Fields:

- versioning (`version`, `leanVersion`)
- counts (`modules`, `theorems`, `lines`, `scripts`, `docs`, `admitted`)
- provenance (`commitSha`, `updatedAt`, `sourceRepo`, `sourceRef`,
  `metricsSource`, `metricsScope`, `schemaVersion`, `sourceDigest`)
- timestamps (`updatedAt`, `generatedAt`)

`metricsSource`, `metricsScope`, `sourceRepo` and `sourceRef` are checked
against fixed values by `validate-data.mjs`, which makes "these figures came
from the canonical artifact" a claim CI verifies rather than a comment. Scope is
production Lean: `theorems`, `lines` and `modules` describe one corpus — the
artifact's production set (everything outside `tests/`) minus the in-tree
testing framework `SeLe4n/Testing/`. `commitSha` and `updatedAt` name the commit the
statistics were *measured* at — the artifact's own `repository.head` — not the
tip of `main`. `lines` is the one metric published pre-grouped (`"325,346"`) so
the static fallback and the hydrated value render identically.

Generated by `scripts/sync-upstream.mjs`; validated by `scripts/validate-data.mjs`.

### `data/map-data.json`
Bundled graph snapshot used by map runtime. Includes:

- `modules` inventory.
- `moduleMap` module -> file path.
- `importsFrom` and `importsTo` dependency edges.
- `externalImportsFrom` external dependencies per module.
- `moduleMeta` theorem/symbol metadata by module, including
  `symbols.callGraph` — each declaration mapped to the identifiers it
  references. This is what drives the declaration-context flowchart (outgoing
  calls, and incoming callers via the reverse index the runtime builds from
  it). Before it was bundled, that view was empty until a live GitHub fetch
  completed, and empty forever offline.
- `rust` — the production crate inventory built by `scripts/lib/rust-analysis.mjs`
  from the same checkout: workspace members and inherited package fields, and
  per crate the manifest facts (description, edition, dependencies split into
  internal/external/dev/build, features, `deniesUnsafe`) plus every `.rs` file
  with role, module path, line count, listed items (`kind`, `name`, `line`,
  `visibility`, `unsafe`, inline `module`), `publicItems`, `testItems` and
  `unsafe` site counts. Test items are listed with `test: true` and counted
  apart (`testItems`); the cards show them behind a toggle. About 273 KB raw /
  38 KB gzipped on the current workspace. Descriptive only — no landing-page
  metric may come from it.
- `commitSha`, `generatedAt` provenance.

Written **compact** (no indentation): at ~4.6 MB (459 KB gzipped) it is the
dominant payload on map.html, and indenting it costs roughly 100 KB of gzipped
transfer for a generated file no one reads as text. `site-data.json` and
`execution-traces.json` stay indented.

The call graph is ~262 KB of that gzipped total, and it is stored inline rather
than in an interned string table. Measured on the real corpus — 119,506 edges
over ~10,000 distinct targets — interning halves the raw file but saves only
23 KB gzipped, because gzip already captures the repetition; dropping the
derived `symbols.theorems`/`functions` arrays saves another 21 KB. Neither is
worth a bespoke format and a decoder in the runtime, and `symbols.callGraph` is
a shape `assets/js/map.js` already reads in three places.

Generated by `scripts/sync-upstream.mjs`; validated by `scripts/validate-data.mjs`.

Graphs the same production corpus `site-data.json` counts, from the same
checkout: `modules` mirrors the canonical artifact's production module list, and
`moduleMeta[].symbols` is projected from its declaration inventory rather than
re-parsed. Only the import edges are read from the Lean sources, because only
the import edges are missing from the artifact. `commitSha` and `sourceDigest`
match `site-data.json`, which `validateCrossFile` requires.

### `data/execution-traces.json`
Bundled Simulator trace snapshot (schema-versioned; `source: "fixture"` until the upstream kernel emits the artifact). Contains the invariant catalog and per-scenario step sequences consumed by `assets/js/run.js`'s fold engine. Schema and fold semantics are specified in `docs/SIMULATOR_SPEC.md`.

Synced by `scripts/sync-upstream.mjs`; validated by `scripts/validate-traces.mjs`.

## 7) Data-generation scripts (`scripts/`)

### `scripts/sync-upstream.mjs`
The website's whole data pipeline. One shallow clone of seLe4n at one revision
produces all three bundled snapshots:

```
git clone --depth 1 seLe4n@main
  └─ docs/codebase_map.json  ─┬─→ data/site-data.json          (landing page)
     Lean sources            ─┤   data/map-data.json           (code map)
     docs/execution-traces.json ─→ data/execution-traces.json  (simulator)
```

**Verification first.** The artifact is generated at one commit and committed at
another, so the tree it ships in can contain Lean sources it never saw.
`source_sync.source_digest` — a sha256 over the artifact's declared source scope
— is recomputed over the checkout before anything is written. If it does not
match, the sync fetches the commit the artifact names and re-verifies there; if
that also fails, it aborts rather than blending two revisions. Reproducing the
digest requires ordering paths the way Python's `PurePath` does, component by
component: a flat string compare puts `SeLe4n/Kernel.lean` before
`SeLe4n/Kernel/API.lean` and every digest then mismatches plausibly.

**Projection.** Every published statistic comes from the artifact.
`canonicalMetricsIssues()` gates the write: a missing key aborts the sync naming
what it feeds, so an upstream schema change surfaces as a red build instead of a
plausible-looking wrong number. The Lean sources contribute exactly two things
the artifact does not record — the import graph, and the full identifiers behind
the artifact's truncated declaration names. The repository's non-Lean inventory
(`scripts`, `docs`) is counted from the same checkout's git tree.

**Coherence.** Both snapshots record the same `commitSha` and `sourceDigest`,
and `map-data.json` graphs exactly the production corpus `site-data.json`
counts. `validate-data.mjs` fails when they disagree.

Network shape: one shallow clone, plus one commit fetch on the rare path where
upstream has committed Lean changes without regenerating the artifact. No REST
calls, so no anonymous rate limit and no token.

Run when any upstream data needs refreshing.

### `scripts/apply-static-values.mjs`
Rewrites the static fallback values in `index.html` (mapped `data-live` spans, JSON-LD version, snapshot `<time>` stamp) **and in every `locales/*.json` bundle** from `data/site-data.json` via `scripts/lib/static-values.mjs`. Locales need stamping because `data-i18n-html` replaces an element's innerHTML wholesale, so each translation carries its own copy of the spans — they once said "546 build jobs" while `index.html` said 574. Idempotent; run after `sync-upstream.mjs`. The committed tree must stay in sync — `static-values.test.mjs` fails otherwise.

### `scripts/validate-data.mjs`
Schema/consistency gate for the site and map snapshots. Fails non-zero if either payload violates required invariants.

### `scripts/validate-traces.mjs`
Schema gate plus fold dry-run for `data/execution-traces.json`; warns when the bundled traces are fixtures rather than a kernel export.

### `scripts/nav-stability-smoke.py`
Optional Playwright smoke probe for nav-hash stability and active-link determinism across browsers.

## 8) Script libraries and tests (`scripts/lib/`)

### `scripts/lib/canonical-map.mjs`
The contract with seLe4n's canonical `docs/codebase_map.json`: the schema it
targets, the production scope the site reports, the source-digest reproduction
that proves an artifact and a checkout are one corpus, the metric projection,
the admitted-proof derivation, and the declaration→symbol projection the code
map renders.

It also documents why the theorem count comes from the artifact's comment-aware
`modules[].declarations` inventory rather than `readme_sync.proved_theorem_lemma_decls`:
that field is a bare per-line regex, and on the current artifact it counts 78
prose lines inside doc comments while missing 15 `protected`/`noncomputable`
declarations.

### `scripts/lib/lean-analysis.mjs`
Lean source parsing. Two roles:

- `extractImportTokens` is used by the pipeline — import edges are the one thing
  the canonical artifact does not record.
- the declaration parsers mirror the copies inside `assets/js/map.js`, which the
  map runtime uses when it fetches an individual `.lean` file. The pipeline no
  longer calls them; keeping them here keeps that runtime logic under test.

The site's production scope also lives here: `isArtifactProductionModule`
(outside `tests/`), `isProductionModule` (also outside `SeLe4n/Testing/`),
`artifactProductionModules`, `productionModules`, `excludedFrameworkModules`,
and the `lines` subtraction in `siteMetricsFromCodebaseMap` driven by the
`lineCount` option the sync script supplies.

### `scripts/lib/rust-analysis.mjs`
The Rust workspace scanner behind `map-data.json#rust`: `stripRustCommentsAndStrings`
(nested block comments, raw/byte strings, char literals), `scanRustSource` (item
headers at item scope with visibility, `unsafe`, inline-module path and
`#[test]`/`#[cfg(test)]` marking; `unsafe` site counts; line counts),
`parseCargoManifest` (package fields, workspace inheritance, dependency tables,
features, `[[bin]]`), `rustFileRole` / `rustModulePath`, and
`buildRustInventory`, which assembles the crates in workspace order from a file
list and a reader. Not a Rust parser; it lists a crate's surface the way a
rustdoc sidebar does.

### `scripts/lib/data-validation.mjs`
Pure validation utilities for site/map payload objects. Centralizes schema checks used in tests and CI checks, including the optional `rust` inventory block (paths must exist in `files[]`, item kinds/visibilities/lines, per-crate totals equal per-file sums).

### `scripts/map-smoke.mjs`
Optional headless-Chromium probe for `map.html` (needs `playwright-core` and a
static server): default module, grouped lanes, sidebar-driven declaration
context, Rust cards, inventory, no horizontal overflow, clean console, at three
viewport widths and in both themes, plus a Spanish deep link.

### `scripts/lib/trace-analysis.mjs`
Trace schema validation and the deterministic fold engine (`reconstructState`/`scenarioStates`) shared by `validate-traces.mjs`, `sync-upstream.mjs`, and the Simulator tests.

### `scripts/lib/static-values.mjs`
The `data/site-data.json` → `index.html` + `locales/*.json` static-fallback mapping used by `scripts/apply-static-values.mjs` and the weekly sync workflow. Single source of truth for which spans are rewritten, and for how a value renders: counts are comma-grouped here exactly as `assets/js/site.js` groups them on hydration, so the figure does not visibly rewrite itself on load.

### `scripts/lib/*.test.mjs`
Node tests for parser and validation correctness:

- `lean-analysis.test.mjs`: parser behavior, edge cases, `isLikelyModuleToken` validation, theorem deduplication, null/empty input guards, noncomputable theorem counting, comment-only continuation line handling, non-numeric metric cell robustness.
- `rust-analysis.test.mjs`: comment/string stripping with line structure preserved, item scanning (kinds, visibility, `unsafe`, nested-body exclusion, inline modules, multi-line signatures, `static mut`, test marking), manifest parsing (workspace inheritance, dependency tables, `[[bin]]`), file roles and module paths, and `buildRustInventory` assembly with test-item exclusion.
- `data-validation.test.mjs`: schema and invariant validation checks, null/non-object root rejection, type enforcement, duplicate module detection, non-string module array entries.
- `map-runtime.test.mjs`: map runtime compatibility, behavior checks, all four assurance levels (linked/partial/local/none), the default module rule, `moduleSubsystem`, subsystem-grouped lane entries (collapsed/opened/within budget/expanded mode), repository path classification and inventory grouping, inventory retention across canonical and tree refreshes, `rust` block pass-through, Rust item colouring/ordering, tab selection, and count formatting.
- `map-toolbar.test.mjs`: structural assertions for map toolbar placement, accessibility labels, removed controls, `.sr-only` CSS definition, `:empty` interior menu behavior, empty initial container state, CSS containment, cursor interactivity, legend ARIA roles, self-edge guard, clean function signatures, DocumentFragment usage, interior menu item flex layout and hover state, CSS transitions, kind label alignment, `focus-visible` outlines, scrollbar styling, grid overflow prevention, navigable item flex-wrap, href guards, declaration search function exports (`declarationSearchMatch`, `declarationSearchMatches`, `buildDeclarationSearchIndex`, `searchDeclarationsInModule`), `declarationSearchList` state tracking, and edge layer `aria-hidden` accessibility.
- `trace-analysis.test.mjs`: trace schema validation and fold-engine determinism (see `docs/TESTING.md`).
- `run-runtime.test.mjs`: boots the real `assets/js/run.js` in a `vm` DOM shim and exercises the Simulator end-to-end (see `docs/TESTING.md`).
- `csp-html.test.mjs`: asserts no inline `style="…"` attributes on any HTML page (the strict CSP would silently drop them).
- `static-values.test.mjs`: pins the static-fallback rewriter mapping and asserts that the committed `index.html` *and* every locale bundle match `data/site-data.json`.
- `i18n-locales.test.mjs`: locale key parity with `en.json`, no empty values, and every `data-i18n*` key referenced by the pages resolves.

## 9) Documentation folder (`docs/`)

### `docs/ARCHITECTURE.md`
System architecture and evolution notes. Use for bigger design decisions and invariants.

### `docs/CODEBASE_MAP.md`
Deep map-specific pipeline and runtime behavior reference.

### `docs/TESTING.md`
Manual and scripted testing matrix.

### `docs/DEVELOPER_GUIDE.md` (this file)
Fast onboarding and file-by-file “what belongs where” reference.

## 10) Common change recipes

### A) “I need to update a number on the landing page”

1. Update snapshot source logic in `scripts/sync-upstream.mjs` if the source changed.
2. Regenerate with `node scripts/sync-upstream.mjs`.
3. Validate with `node scripts/validate-data.mjs`.
4. If rendering logic changed, adjust `assets/js/site.js` and maybe `index.html` placeholders.

### B) “I need to adjust map graph behavior or controls”

1. Edit `assets/js/map.js` (logic) and possibly `assets/css/map.css` (presentation).
2. If control structure changed, update `map.html`.
3. Run map-related tests and data validation.

### C) “I changed parsing/validation logic”

1. Update `scripts/lib/canonical-map.mjs` (artifact contract),
   `scripts/lib/lean-analysis.mjs` (Lean source parsing), or
   `scripts/lib/data-validation.mjs` (snapshot schema).
2. Update/add tests in matching `*.test.mjs`.
3. Run all parser/validation test commands from `CONTRIBUTING.md`.

## 11) What to read first as a new developer

Suggested order:

1. `README.md` (workflow + constraints)
2. `docs/ARCHITECTURE.md` (system-level model)
3. `docs/CODEBASE_MAP.md` (map-specific deep dive)
4. `docs/DEVELOPER_GUIDE.md` (file ownership lookup while coding)
5. Source files relevant to the feature area.

This sequence gives context first, then implementation detail, then quick lookup while making edits.
