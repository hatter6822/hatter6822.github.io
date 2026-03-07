# Developer Guide: File-by-File Orientation

This guide explains what each major file in the repository is responsible for, how data and control flow through the system, and where to make common changes safely.

It is intended to help a new contributor answer two questions quickly:

1. **Where does a behavior come from?**
2. **Which file should I edit for a given change?**

## 1) Mental model of the project

The repository is a static website with two pages and a data pipeline:

- `index.html` is the marketing/overview page.
- `map.html` is the interactive codebase map page.
- `data/*.json` stores local snapshots consumed by the browser.
- `scripts/*.mjs` regenerates and validates those snapshots.

The runtime is intentionally **local-first**:

1. Render from bundled `data/*.json` immediately.
2. Reuse cached payloads when they are newer.
3. Try live refresh from GitHub APIs.
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
- placeholders marked with `data-live="..."` that runtime JS updates from `data/site-data.json`.
- script load order:
  1. `theme-init.js` (early, in `<head>`) to avoid theme flash.
  2. `header-nav.js`, `background-pattern.js`, `site.js` (deferred in body).

Edit this file when adding/removing a section, changing metadata defaults, or wiring new live data placeholders.

### `map.html` (interactive map page)
Owns:

- map-specific hero, summary stats, and toolbar shell.
- `#flowchart-wrap` rendering target for graph content.
- compact control surface (context search + reset).
- map status and stat placeholders (`data-map="..."`).
- script load order:
  1. `theme-init.js` in head.
  2. `header-nav.js`, `background-pattern.js`, `map.js` deferred.

Edit this file when adding map controls or changing semantic structure of map UI regions.

## 4) Browser runtime scripts (`assets/js/`)

### `assets/js/theme-init.js`
Very small boot script executed before first paint. Responsibilities:

- read saved theme from `localStorage` key `sele4n-theme`.
- if missing, resolve against `prefers-color-scheme`.
- set `data-theme` on `<html>` as early as possible.

Design goal: avoid a dark/light flash while keeping failure-safe behavior if storage is unavailable.

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

### `assets/js/background-pattern.js`
Canvas/WebGL animated background. Responsibilities:

- shader setup + rendering loop.
- theme-aware palette/alpha behavior.
- scroll/mouse reactive geometry and motion.
- graceful fallback behavior when graphics capabilities are constrained.

Contains third-party simplex-noise GLSL implementation (licensed and attributed in notices).

### `assets/js/map.js`
Largest runtime module; owns map page data and rendering behavior. Responsibilities:

- hydrates graph state from `data/map-data.json` and optional live sync.
- normalizes legacy/new payload shapes for compatibility.
- preserves declaration call-graph relationships (`called` field) into a merged `declarationGraph` and precomputed `declarationReverseGraph` for O(1) caller lookups during declaration context navigation. Also builds a `declarationIndex` mapping every declaration name to `{module, kind, line}` for O(1) metadata lookups.
- resolves declaration module ownership via `declarationGraph` first, then falls back to `declarationIndex` for O(1) lookup (replacing the previous O(n*m) `moduleMeta` symbol scan).
- computes filtered graph neighborhood based on selected module and detail mode.
- renders module-context node/edge flowchart and legend semantics.
- renders declaration-context call-graph flowchart with breadcrumb navigation (`<nav>` element with `aria-label`) for bidirectional module/declaration context switching, including informative empty-state hints for declarations with zero relationships. Declaration flowchart preserves scroll position across re-renders.
- both flowchart renderers share six extracted helpers (`createFlowSvg`, `createFlowLegend`, `flowLaneLabel`, `applyFlowScrollTarget`, `computeFlowLayout`, `buildFlowNodeGroup`) to eliminate SVG setup, legend, layout, scroll-target, and node construction duplication. Node heights for proof and external sections are pre-computed during layout to avoid redundant recalculation.
- sorts large declaration lanes by module relevance (same-module first) before collapsing to keep contextually relevant declarations visible; collapsed "+N more" nodes are interactive expand buttons that fully reveal all declarations, with "Return to Compact" buttons to collapse back.
- builds interior declaration panels (Objects, Contexts/Inits, Extensions) with all declarations navigable to declaration context; highlights the currently selected declaration in declaration context with a visual accent indicator.
- handles keyboard navigation, search, reset, and URL-state synchronization (including `decl` parameter for declaration context persistence). The module-search bar is context-aware, displaying `ModuleName › DeclarationName` and updating the label in declaration context. The `flowchart-wrap` `aria-label` updates dynamically per context.
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

- flowchart workspace and toolbar layout.
- graph node/edge visual semantics.
- interior declaration panel styling.
- `.sr-only` / `.visually-hidden` screen-reader utility class.
- `:empty` state hiding for interior menu pre-selection.
- map-specific responsive/mobile tuning.

Rule of thumb: shared primitive in `style.css`; map-only styling in `map.css`.

## 6) Runtime data snapshots (`data/`)

### `data/site-data.json`
Bundled summary metrics displayed on landing page. Typical fields:

- versioning (`version`, `leanVersion`)
- counts (`modules`, `theorems`, `scripts`, `docs`, `buildJobs`, `admitted`)
- provenance (`commitSha`, `sourceRepo`, `sourceRef`)
- timestamps (`updatedAt`, `generatedAt`)

Generated by `scripts/sync-site-data.mjs`; validated by `scripts/validate-data.mjs`.

### `data/map-data.json`
Bundled graph snapshot used by map runtime. Includes:

- `modules` inventory.
- `moduleMap` module -> file path.
- `importsFrom` and `importsTo` dependency edges.
- `externalImportsFrom` external dependencies per module.
- `moduleMeta` theorem/symbol metadata by module.
- `commitSha`, `generatedAt` provenance.

Generated by `scripts/sync-map-data.mjs`; validated by `scripts/validate-data.mjs`.

## 7) Data-generation scripts (`scripts/`)

### `scripts/sync-site-data.mjs`
Builds `data/site-data.json` by combining:
- theorem totals derived from `docs/codebase_map.json` (prefers declaration/symbol-derived per-module counts from `modules[]` and `moduleMeta`; uses top-level aggregate theorem counts only as fallback),
- repo metadata via GitHub APIs,
- markdown metrics from upstream project docs,
- repository tree-derived counts (modules/scripts/docs),
- formatting/normalization.

Run when dashboard metrics need refreshing.

### `scripts/sync-map-data.mjs`
Builds `data/map-data.json` from Lean sources by:

- enumerating `SeLe4n/**/*.lean` files from upstream repo tree,
- fetching source blobs,
- parsing imports and declarations,
- constructing module metadata and dependency adjacency maps.

Run when module graph shape or declaration metadata changes upstream.

### `scripts/validate-data.mjs`
Schema/consistency gate for both snapshots. Fails non-zero if either payload violates required invariants.

### `scripts/nav-stability-smoke.py`
Optional Playwright smoke probe for nav-hash stability and active-link determinism across browsers.

## 8) Script libraries and tests (`scripts/lib/`)

### `scripts/lib/lean-analysis.mjs`
Lean parsing helpers used by sync scripts:

- import token extraction,
- theorem counting,
- interior declaration extraction grouped by semantic kind,
- markdown metric extraction.

### `scripts/lib/data-validation.mjs`
Pure validation utilities for site/map payload objects. Centralizes schema checks used in tests and CI checks.

### `scripts/lib/*.test.mjs`
Node tests for parser and validation correctness:

- `lean-analysis.test.mjs`: parser behavior and edge cases.
- `data-validation.test.mjs`: schema and invariant validation checks.
- `map-runtime.test.mjs`: map runtime compatibility and behavior checks.
- `map-toolbar.test.mjs`: structural assertions for map toolbar placement, accessibility labels, removed controls, `.sr-only` CSS definition, `:empty` interior menu behavior, and empty initial container state.

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

1. Update snapshot source logic in `scripts/sync-site-data.mjs` if the source changed.
2. Regenerate with `node scripts/sync-site-data.mjs`.
3. Validate with `node scripts/validate-data.mjs`.
4. If rendering logic changed, adjust `assets/js/site.js` and maybe `index.html` placeholders.

### B) “I need to adjust map graph behavior or controls”

1. Edit `assets/js/map.js` (logic) and possibly `assets/css/map.css` (presentation).
2. If control structure changed, update `map.html`.
3. Run map-related tests and data validation.

### C) “I changed parsing/validation logic”

1. Update `scripts/lib/lean-analysis.mjs` or `scripts/lib/data-validation.mjs`.
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
