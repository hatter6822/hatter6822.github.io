# Codebase Map: End-to-End Guide

> Documentation baseline: website release **0.30.0**.

## Purpose
The map page provides a single operational and proof-aware architecture view of the `seLe4n` codebase. It combines:
- import dependency flow,
- theorem/proof pairing context,
- module metadata,
- source-level symbol interior links,
- the production Rust crates (user-space syscall wrappers and the HAL),
- and an inventory of every file in the repository.

## Page structure (0.30.0)

Three sections, in this order (asserted by `scripts/lib/map-toolbar.test.mjs`):

1. **Lean module workspace** — the toolbar (context search + reset), the flow
   chart, and the declaration sidebar. The section carries a `production ·
   Lean 4` badge.
2. **Rust production crates** — a dependency strip and one card per workspace
   crate, rendered from `map-data.json#rust`.
3. **Repository inventory** — every file in the tree, grouped as production
   Lean, production Rust, tests, scripts, documentation, and project tooling.
   The two production groups open by default and carry a badge; the others are
   closed and muted, and their file lists render on first open.

The hero above them is one compact block: title, lead, live status, the
snapshot timestamp, a one-line stats strip (`Lean modules`, `Theorems`,
`Import edges`, `Ops/Inv pairs`, `Linked pairs`, `Rust crates`, `Files`) and
jump links to the three sections. Every count is thousands-grouped by
`formatCount()`.

### Default view

With no `module=` in the URL the workspace opens on **`SeLe4n.Kernel.API`**,
the syscall surface every other subsystem composes into. `DEFAULT_MODULE` is
declared once in `assets/js/map.js`; `defaultModuleName()` returns it when the
snapshot carries it and the first module in inventory order otherwise. Reset
returns to the same view. The previous default — the module with the highest
degree/theorem score — landed visitors on
`SeLe4n.Kernel.IPC.Invariant.Structural.DualQueueMembership`.

### Subsystem-grouped lanes

`SeLe4n.Kernel.API` imports 46 modules; a lane budget of eight used to show
eight of them and a "+38 more imports" node. Over budget, a lane now groups its
modules by `moduleSubsystem()` — the parent namespace capped at three segments,
so `SeLe4n.Kernel.IPC.Invariant.Defs` files under `SeLe4n.Kernel.IPC` and
`SeLe4n.Kernel.API` under `SeLe4n.Kernel` — and renders one node per group
(largest first; singletons stay plain module nodes). Clicking a group opens it
in place: its members render indented below it on a dotted guide rail and the
scroll position is kept. Group state is transient and resets on module change.
Expanded flow mode (`fullflow=1`) still lists every module flat.

### Declaration sidebar

The interior declaration explorer is a sidebar beside the chart on viewports of
75rem and up (sticky, so a click in it always shows its effect on the chart) and
stacks below it otherwise. It shows the module name with a source link and a
one-line summary (declarations, theorems, fan-in/out, assurance), the filter
box, three tabs (`Objects`, `Contexts/Inits`, `Extensions`, each with its
count) and, for the active tab, the kind selector and the declaration list.
The active tab is remembered across module changes; the first non-empty group
opens by default. Tabs are a `role="tablist"` with Arrow/Home/End roving focus.

## Where the bundled snapshot comes from

`data/map-data.json` is built by `scripts/sync-upstream.mjs`, the site's single
data pipeline, from one verified checkout of seLe4n. It graphs exactly the
production corpus the landing page counts — the canonical
`docs/codebase_map.json` production module list minus the in-tree testing
framework under `SeLe4n/Testing/` (see `docs/ARCHITECTURE.md` §"Scope") — and takes its declarations
from that artifact rather than re-parsing them, because the artifact's parser
tracks nested block-comment depth and strips string literals. Only the import
edges are read from the Lean sources, because only the import edges are missing
from the artifact.

The snapshot also carries the declaration call graph
(`moduleMeta[].symbols.callGraph`), so the declaration-context flowchart works
from bundled data on first paint and offline.

It also carries the **Rust crate inventory** (`rust`), built from the same
checkout by `scripts/lib/rust-analysis.mjs`: workspace members and inherited
package fields from `rust/Cargo.toml`; per crate the description, edition,
internal/external/dev/build dependencies and features from its manifest, plus
every `.rs` file with its role (crate root, module, binary, build script,
integration test), Rust module path, line count, item list (`fn`, `struct`,
`enum`, `union`, `trait`, `type`, `const`, `static`, `mod`, `impl`, `macro`;
visibility; `unsafe`; inline-module path), public-item count, test-item count,
and `unsafe` sites (`fns`, `impls`, `blocks`). Items under `#[cfg(test)]` /
`#[test]` and in integration-test files are listed with `test: true` and
counted apart from the production items; the cards list them only behind a
per-crate toggle. `validate-data.mjs` checks the block against `files[]`, its
own totals, and that the flagged items match the test counts.
The Rust workspace is outside the artifact's digest, so the block is descriptive
only and feeds no landing-page statistic.

`site-data.json` and `map-data.json` record the same `commitSha` and
`sourceDigest`; `validate-data.mjs` fails when they disagree, when their module
or theorem totals do, or when the call graph is missing entirely. See
`docs/ARCHITECTURE.md` §"One pipeline, one revision".

The steps below describe the **runtime** in `assets/js/map.js`, which still
refreshes its larger payload from GitHub with the bundled snapshot as its
fallback.

## End-to-end pipeline

1. **Bootstrap**
   - Reads URL state (module/layer/detail/toggles).
   - Sets up theme/nav/filter/keyboard handlers.

2. **Local-first load**
   - Attempts cache + bundled `data/map-data.json`.
   - Chooses freshest local dataset by generated timestamp.

3. **Live sync policy**
   - Applies cooldown + jitter guardrails to reduce excess sync traffic.
   - Fetches latest commit SHA and repo tree when policy allows.
   - Uses incremental GitHub compare sync to re-parse only changed `SeLe4n/**/*.lean` modules when possible (with automatic full rebuild fallback when compare payloads are truncated/unreliable).
   - Runs continuous polling (plus visibility/focus/online triggers) for near real-time sync without overwhelming API quotas.

4. **Lean module analysis**
   - Derives module paths from `SeLe4n/**/*.lean`.
   - Parses imports and interior declarations across all Lean code kinds (object, extension, and context/init groups) with line anchors, while preserving theorem/function rollups for backward compatibility.
   - Normalizes imports against the current module inventory and rebuilds reverse import edges for consistency.
   - Computes module degree, pair linkage, and assurance labels with theorem-density tracking. Each assurance result includes `theoremDensity` for quantitative coverage information alongside the qualitative level. Linked pairs with zero theorems are distinguished as "structural only" links. The flow legend displays all four assurance levels individually (linked, partial, local, none) with their respective colors from the `ASSURANCE_COLORS` constant.

4.1 **Modules-array normalization (runtime)**
   - Map hydration now uses `modules[]` as the canonical source of graph nodes. If `modules[]` is missing or empty, hydration fails fast instead of inferring modules from top-level maps.
   - Module entries can be either strings or structured objects (`name/module/id`, `path/file/modulePath`, plus optional `imports`, `externalImports`, and `meta`).
   - Legacy top-level maps (`moduleMap`, `importsFrom`, `externalImportsFrom`, `moduleMeta`) are read only as per-module fallbacks for modules already declared in `modules[]`; they can never create additional nodes.
   - Branch-ref metadata keys (for example `main` URL strings) are therefore excluded from module inventories, flow-chart nodes, and map stats. Runtime filtering now rejects pseudo-module names like `main` and URL/non-`.lean` module paths.
   - Canonical payload extraction now selects the object (top-level or one nested level) with the strongest `modules[]` payload, then normalizes from that branch payload only.
   - Symbol normalization still accepts legacy buckets (`symbols.by_kind`) and declaration aliases (`constant`/`constants`), and `symbolsLoaded` is computed from normalized symbol entries.
  - Runtime normalization now supports declaration-centric canonical payloads (`modules[].declarations`) by projecting declaration entries into interior symbol buckets, preserving per-declaration `called` relationships into a merged declaration call graph with a precomputed reverse index for O(1) caller lookups, and deriving theorem totals when explicit counts are missing.
  - When canonical payloads omit import edges, runtime performs a bounded raw-source import reconstruction pass so map stats and the flow chart remain operational instead of collapsing to zero-edge graphs.
  - Sparse import reconstruction is only triggered when a new canonical commit is detected, preventing repeated per-module source fetches during no-op polling cycles.

5. **Rendering lifecycle**
   - `applyData()` merges the incoming inventory through `retainInventory()`,
     rebuilds indices and pairs, selects the default module, renders the Rust
     crate cards and the repository inventory once (`renderInventory()`), then
     renders the workspace (`renderAll()`).
   - Updates the stats strip and status text.
   - Renders a compact in-panel control toolbar (context search with search-key hint and reset in a density-compact form).
   - Builds the flow chart with an integrated upper-right legend and subsystem-grouped lanes, and the tabbed declaration sidebar.
   - Interior declaration normalization reuses a per-module cache keyed by symbol payload identity, avoiding repeated symbol-list normalization during dense flowchart rerenders while preserving deterministic output.
   - A locale switch (`sele4n:locale-changed`) repaints the inventory and the workspace; every label is looked up through `t()` at render time.

5.1 **Inventory retention across live refresh**
   - The canonical artifact lists Lean modules only, so a canonical refresh
     arrives with a `files[]` made of module paths and no `rust` block. A tree
     rebuild (`fetchAndBuildData`) carries every file but still no Rust
     inventory. `retainInventory()` keeps whichever the previous data had and
     records `inventoryCommit` / `rustCommit`; the inventory section's
     provenance line says which commit each was taken at when it differs from
     the module graph's. The `localStorage` cache (schema 4) round-trips both.

## Interaction model

- **Context search:** the unified context search bar accepts both module names and dot-appended declaration queries (e.g., `SeLe4n.Kernel.API.apiInvariantBundle`). The label updates dynamically ("Context search — module" / "Context search — declaration") to indicate the current context. Selecting a declaration via the search bar automatically syncs the flowchart to declaration context.
- **Dot-append declaration search:** type `Module.Name.declarationName` in the context search bar to navigate directly to a declaration within a module. The search progressively tries shorter module prefixes, then matches the remaining suffix against declarations in that module. Exact matches select immediately; partial/prefix matches appear as suggestions with distinct italic styling and a left border accent. Declaration suggestions are also selectable via keyboard (Arrow keys + Enter) and mouse click.
- **Keyboard walk:** `j` and `k` outside input controls.
- **Detail levels:** compact/balanced/expanded (Arrow keys cycle; Home/End jump to first/last preset).
- **Toolbar layout:** the context search toolbar is placed before the interior declaration panel and only includes context search and reset in a compact density-tagged shell.

- **Integrated flow legend corner:** legend semantics are rendered directly in the flowchart’s upper-right corner so color keys travel with every chart interaction/screenshot while keeping the chart body focused on graph topology.

- **Declaration context:** clicking any declaration item in the interior panel switches the flowchart to declaration context, showing the selected declaration as a center node with outgoing calls (left lane) and incoming callers (right lane). Declarations with zero relationships display a centered node with an informative empty-state hint. Each callee/caller node is color-coded by declaration kind. Navigable declarations (those with forward or reverse call-graph entries) can be clicked to chain into further declaration contexts. A breadcrumb trail (semantic `<nav>` element with `aria-label`) at the top of the flowchart provides a module-name link to return to the module-level flowchart. The module-search bar updates contextually: in declaration context it displays `ModuleName › DeclarationName` and the label changes to "Current declaration context"; selecting a module via search returns to module context. Declaration context is persisted in the URL via a `decl` parameter. The `flowchart-wrap` container `aria-label` updates dynamically to reflect the current context. The context search bar syncs to `Module.Declaration` dot-append format when a declaration is selected (from any entry point: interior menu, search bar, or node click). Caller lookups use a precomputed reverse graph index for O(1) performance. When a lane exceeds 12 entries, declarations are sorted by module relevance (same-module first, then alphabetically) before the first 10 are shown with a "+N more" expand button. Clicking this button fully expands the lane to show all declarations, and a "Return to Compact" button appears to collapse back. The expansion state is transient and resets when navigating to a new declaration or returning to module context. Scroll position is preserved across declaration flowchart re-renders (lane expand/compact). The interior menu highlights the currently selected declaration with an accent-colored visual indicator.

- **Interior declaration explorer (sidebar):** the declaration sidebar exposes all interior Lean declaration kinds in three tabs:
  - Objects (`inductive`, `structure`, `class`, `def`, `theorem`, `lemma`, `example`, `instance`, `opaque`, `abbrev`, `axiom`, `constant`, `constants`)
  - Contexts/Inits (`universe`, `universes`, `variable`, `variables`, `parameter`, `parameters`, `section`, `namespace`, `end`, `initialize`)
  - Extensions (`declare_syntax_cat`, `syntax_cat`, `syntax`, `macro`, `macro_rules`, `notation`, `infix`, `infixl`, `infixr`, `prefix`, `postfix`, `elab`, `elab_rules`, `term_elab`, `command_elab`, `tactic`)
  - The active tab's kind selector defaults to `All (N)` so the list opens with the full group inventory; each group remembers its selected kind while filtering.
  - Selector options and declaration chips are color-coded by declaration kind so the selector acts as a visual key for the list.
  - Declaration lists are sorted case-insensitively by name (with line-number tiebreakers), including aggregated `All` views.
  - The filter box preserves focus and caret position during live filtering rerenders, preventing one-character input stalls while users type longer symbol queries.
  - Re-selecting the already active module repaints the sidebar only when it shows another module. An unconditional repaint rebuilt the list under the pointer — the search field's `change` event fires on blur, i.e. on the mousedown of a declaration click — so the click never landed.
  - All declarations display a clickable name that enters declaration context, providing uniform navigation regardless of call-graph presence.

## Rust production crates

`renderRustCrates()` paints the section from `state.rust` alone. The dependency
strip is a small inline SVG: one node per crate in workspace order, arrows from
a crate to each internal dependency it declares (`sele4n-sys → sele4n-abi →
sele4n-types`; `sele4n-hal` stands alone), green when the crate declares
`#![deny(unsafe_code)]`. Each card shows the crate's description, source-file
and line counts, item count with the public share, and an `unsafe` cell that
reads `none · deny(unsafe_code)` or the counted `fn`/`blocks`/`impl` sites;
below it the manifest facts (internal and external dependencies, features,
edition, test-item count) and one `<details>` per source file — crate root
first, then modules, binaries, build scripts, integration tests — whose item
list renders on first open, sorted types-before-functions-before-impls and by
line within a kind, each item linking to its line at the snapshot commit.
Item kinds reuse the Lean declaration palette so one colour means one thing
across both halves of the production code. Each card with test code carries a
"Show N test items" toggle (`aria-pressed`); switching it re-renders that card
alone, keeps the files the reader had open, and lists the flagged items with a
`test` tag. Integration-test files, whose every item is test code, show a
"test items hidden" note until the toggle is on.

External imports — tokens the production graph does not contain — read
"external dependency" for Lean/Std libraries and "in-repo · outside production
scope" for in-repository modules the scope leaves out: the `SeLe4n` library
root that `Main` imports, and the `SeLe4n.Testing.*` framework.

## Repository inventory

`classifyRepositoryPath()` files every path into one of six groups and a
subgroup: `lean` (`SeLe4n/**/*.lean` except the testing framework, `Main.lean`,
`SeLe4n.lean`; subgroup = `moduleSubsystem()` of the module name), `rust`
(`rust/**`; subgroup = crate directory or `workspace`), `tests` (`tests/**` and
the in-tree framework `SeLe4n/Testing/**`), `scripts` (subgrouped by language at the
top level, by directory below), `docs` (`docs/**` plus root Markdown and
`LICENSE`), and `project` (`.github`, `.claude`, `assets`, toolchain and build
manifests). `buildRepositoryInventory()` attaches module names to Lean
subgroups so the production Lean group can list modules with their theorem
count and assurance dot, each a button that selects the module and scrolls the
workspace into view. Every other list is plain file links to the source at the
inventory commit. Lists render on the first `toggle` of their `<details>`, so
866 anchors are not built for a section most visitors never expand.

## Accessibility and mobile

- Skip link and landmark regions are present.
- Flow chart container is keyboard focusable and labeled; `aria-label` updates dynamically between module and declaration contexts.
- Declaration breadcrumb uses semantic `<nav>` element with `aria-label="Declaration breadcrumb"`.
- Context search label updates dynamically ("Context search — module" vs "Context search — declaration").
- Center declaration node is keyboard-focusable for tab navigation.
- Interior menu filter label uses `.sr-only` (aliased with `.visually-hidden`) for screen-reader accessibility.
- Interior menu panel hides via `:empty` pseudo-class before a module is selected, preventing a visible empty box.
- The declaration group switcher is a `role="tablist"` of `role="tab"` buttons with `aria-selected`, `aria-controls` and Arrow/Home/End roving focus; the list panel is the `role="tabpanel"`.
- Subsystem group nodes are `role="button"` flow nodes (Enter/Space toggle them); the member guide rail lives in the `aria-hidden` edge layer.
- The Rust and inventory sections use native `<details>`/`<summary>` for every collapsible, so keyboard and screen-reader behaviour comes from the browser; every summary has a `focus-visible` outline.
- The three sections are `aria-labelledby` their headings and reachable from jump links in the hero.
- On small screens, touch targets are enlarged and a usage hint is shown.
- Chart scrolling uses touch-optimized overflow behavior.
- Flow-node text wrapping uses viewport-aware character width estimates (7.0px on mobile vs 6.4px on desktop) to prevent content overflow when CSS scales SVG text to 12–12.5px.
- Flow-node groups use SVG `<clipPath>` clipping to ensure text never visually overflows node boundaries even with variable font rendering across devices.

## Flowchart rendering architecture

### Interior menu item layout

Interior menu items use flex layout with the kind label (`::after` pseudo-element) right-aligned via `margin-left: auto`. Items have hover states with kind-color tinting, CSS transitions for smooth feedback, and `focus-visible` outlines on buttons and source links for keyboard accessibility. The grid column minimum uses `min(16rem, 100%)` to prevent overflow on narrow viewports. Interior menu items list uses `scrollbar-gutter: stable` for consistent layout regardless of scrollbar visibility. Mobile breakpoints increase touch target sizes (`min-height: 2.2rem`) and breadcrumb button targets. Landscape phone breakpoints compact item padding and reduce list max-height to maximize chart visibility. The `repaintList()` function uses stable DOM management via `showEmptyNote()`/`ensureListAttached()` helpers rather than `replaceWith()` to prevent orphaned DOM references. Source links are only rendered when `symbolSourceHref()` returns a valid href; items without a resolvable path render a plain `<span>` instead of an empty anchor.

## Flowchart rendering architecture

Both the module-context and declaration-context flowchart renderers share six extracted helpers to eliminate duplication:

- `createFlowSvg()` — SVG element creation with marker defs and layer ordering.
- `createFlowLegend()` — Legend chip rendering with swatch colors.
- `flowLaneLabel()` — SVG lane label placement.
- `applyFlowScrollTarget()` — Scroll-to-target centering after navigation; temporarily disables smooth scrolling for instant programmatic positioning.
- `computeFlowLayout()` — Three-lane layout geometry computation.
- `buildFlowNodeGroup()` — SVG node construction (rect, title wrapping, subtitle, keyboard/click handlers) using `role="img"` for non-interactive node elements and `role="button"` for interactive ones. All text and assurance indicators are rendered inside a `<clipPath>`-clipped `<g>` group matching the node rect to prevent content overflow on mobile viewports where font scaling can cause text to exceed node boundaries.

Each renderer delegates to the shared helpers for setup, then applies its own context-specific class composition, aria-label construction, and event wiring via `buildFlowNodeGroup`. Node heights for proof-pair and external-dependency sections are pre-computed during layout passes to avoid redundant recalculation. The SVG element carries `aria-roledescription="flowchart"` for screen reader context. Declaration metadata lookups (`declarationModuleOf`, `declarationKindOf`, `declarationLineOf`) use a precomputed `declarationIndex` for O(1) performance instead of scanning all module symbol buckets. The flowchart container uses CSS `contain: layout style` for browser rendering optimization. `drawFlowEdge` includes a self-edge guard to prevent degenerate bezier curves. `minimumFlowWidth` caches results for 200ms to avoid redundant `window.innerWidth` reads during a render cycle. Flow legend uses `role="list"`/`role="listitem"` semantics with `aria-hidden` swatches for screen reader accessibility. Interior menu items use `DocumentFragment` for batch DOM insertion.

### Search scoring optimizations

Module search scoring uses a short-circuit cascade: once a high-confidence match category is found (exact > prefix > substring), lower-priority categories are skipped entirely. Token-based matching is only attempted when no direct string match is found. The label-wrap cache uses spec-guaranteed `Map` insertion-order iteration for FIFO eviction with batch eviction (120 entries per cycle) to amortize eviction cost and prevent single-entry churn on cache-full renders. Frequently queried DOM elements (flowchart-wrap, module-search, search options, feedback, label, interior menu, status, main-content, module-results) are cached once at boot in a `DOM` namespace object to avoid repeated `getElementById` calls during render cycles.

### Declaration search (dot-append)

The declaration search system enables searching for declarations using module-qualified dot notation (e.g., `SeLe4n.Kernel.API.apiInvariantBundle`). It operates through two complementary strategies:

1. **Module-prefix strategy** (`declarationSearchMatch` / `searchDeclarationsInModule`): Progressively tries shorter dot-separated prefixes as exact module candidates, then matches the remaining suffix against declarations in the matched module's interior symbols and declaration index.

2. **Global declaration index strategy** (`buildDeclarationSearchIndex` / `declarationSearchMatches`): When no exact module prefix matches, searches across all declarations using a pre-built `declarationSearchList` indexed from `state.declarationIndex`. This enables cross-module declaration discovery when the user's query doesn't perfectly align with module boundaries.

Both strategies rank results by: exact match (2000) > qualified prefix (1800) > name prefix (1600) > name exact on suffix (1600) > qualified substring (1200) > suffix prefix (1400) > suffix substring (1000). The `declarationSearchMatches()` (plural) function returns multiple ranked results for dropdown suggestions, while `declarationSearchMatch()` (singular) returns the single best match for immediate selection.

Declaration search suggestions are rendered with distinct styling (italic text, left accent border) and carry `data-declaration` attributes for proper selection handling via keyboard and mouse. Multiple declaration suggestions can appear simultaneously in the dropdown when the query contains dots.

## Upstream module structure (reflected in map data)

The published production corpus comprises 303 modules across 4 layers (the
eight `SeLe4n.Testing.*` framework modules are inventoried under Tests):

| Layer | Module count | Description |
|-------|-------------|-------------|
| kernel | 268 | Core kernel subsystems |
| platform | 17 | Simulator and RPi5 bindings |
| model | 14 | Object types, structures, state |
| other | 4 | `Main`, `SeLe4n.Prelude`, `SeLe4n.Machine`, `SeLe4n.PackedString` |

Key structural features visible in the map:

- **Robin Hood** (`SeLe4n.Kernel.RobinHood.*`): 8 modules, 186 theorems — verified hash map foundation imported by `Model.Object.Types`.
- **Deep IPC modularization**: 52 files covering DualQueue/{Core, Transport, WithCaps}, Operations/{CapTransfer, Donation, Endpoint, NotificationBind, SchedulerLemmas, Timeout}, Invariant/{Structural, EndpointPreservation, NotificationPreservation, CallReplyRecv, Defs, PerCore}, and an 18-module CrossCore/ suite.
- **Architecture expansion**: 31 files including RegisterDecode, SyscallArgDecode, TlbModel, VSpaceInvariant alongside the existing VSpace/VSpaceBackend/Adapter triad.
- **Capability invariant decomposition**: Authority, Defs, PerCore, and a six-module Preservation/ tree with 203 total theorems.

## Troubleshooting checklist

1. Run `node scripts/sync-upstream.mjs` and commit refreshed snapshots (`data/`, `index.html`, `locales/` move together).
2. Validate snapshots with `node scripts/validate-data.mjs`.
3. Run parser and runtime-map regression tests with `node scripts/lib/lean-analysis.test.mjs`, `node scripts/lib/rust-analysis.test.mjs`, `node scripts/lib/canonical-map.test.mjs`, `node scripts/lib/map-runtime.test.mjs`, and `node scripts/lib/map-toolbar.test.mjs`.
   For a browser-level check, serve the repository root and run `node scripts/map-smoke.mjs` (needs `playwright-core`).
4. Verify `map.html` references `assets/css/map.css` and `assets/js/map.js`.
5. Validate reverse import-edge integrity with `node scripts/validate-data.mjs` (now includes graph symmetry checks).
