# Codebase Map: End-to-End Guide

> Documentation baseline: website release **0.1.0**.

## Purpose
The map page provides a single operational and proof-aware architecture view of the `seLe4n` codebase. It combines:
- import dependency flow,
- theorem/proof pairing context,
- module metadata,
- and source-level symbol interior links.

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
   - Computes module degree, pair linkage, and assurance labels.

4.1 **Modules-array normalization (runtime)**
   - Map hydration now uses `modules[]` as the canonical source of graph nodes. If `modules[]` is missing or empty, hydration fails fast instead of inferring modules from top-level maps.
   - Module entries can be either strings or structured objects (`name/module/id`, `path/file/modulePath`, plus optional `imports`, `externalImports`, and `meta`).
   - Legacy top-level maps (`moduleMap`, `importsFrom`, `externalImportsFrom`, `moduleMeta`) are read only as per-module fallbacks for modules already declared in `modules[]`; they can never create additional nodes.
   - Branch-ref metadata keys (for example `main` URL strings) are therefore excluded from module inventories, flow-chart nodes, and map stats. Runtime filtering now rejects pseudo-module names like `main` and URL/non-`.lean` module paths.
   - Canonical payload extraction now selects the object (top-level or one nested level) with the strongest `modules[]` payload, then normalizes from that branch payload only.
   - Symbol normalization still accepts legacy buckets (`symbols.by_kind`) and declaration aliases (`constant`/`constants`), and `symbolsLoaded` is computed from normalized symbol entries.
  - Runtime normalization now supports declaration-centric canonical payloads (`modules[].declarations`) by projecting declaration entries into interior symbol buckets and deriving theorem totals when explicit counts are missing.
  - When canonical payloads omit import edges, runtime performs a bounded raw-source import reconstruction pass so map stats and the flow chart remain operational instead of collapsing to zero-edge graphs.
  - Sparse import reconstruction is only triggered when a new canonical commit is detected, preventing repeated per-module source fetches during no-op polling cycles.

5. **Rendering lifecycle**
   - Updates stat cards and status text.
   - Renders a compact in-panel control toolbar (context search with search-key hint and reset in a density-compact form).
   - Builds flow chart with an integrated upper-right legend, three-kind dropdown interior menu (Object, Context/Init, Extension), compact filter controls, and traversal trail.
   - Interior declaration normalization now reuses a per-module cache keyed by symbol payload identity, avoiding repeated symbol-list normalization during dense flowchart rerenders while preserving deterministic output.

## Interaction model

- **Context jump:** module/path search + Enter.
- **Keyboard walk:** `j` and `k` outside input controls.
- **Detail levels:** compact/balanced/expanded (Arrow keys cycle; Home/End jump to first/last preset).
- **Toolbar layout:** the module-control toolbar is placed before the interior declaration panel and only includes module context search and reset in a compact density-tagged shell.

- **Integrated flow legend corner:** legend semantics are rendered directly in the flowchart’s upper-right corner so color keys travel with every chart interaction/screenshot while keeping the chart body focused on graph topology.

- **Interior declaration explorer:** the flow chart context now exposes all interior Lean declaration kinds via three dropdowns:
  - Objects (`inductive`, `structure`, `class`, `def`, `theorem`, `lemma`, `example`, `instance`, `opaque`, `abbrev`, `axiom`, `constant`, `constants`)
  - Contexts/Inits (`universe`, `universes`, `variable`, `variables`, `parameter`, `parameters`, `section`, `namespace`, `end`, `initialize`)
  - Extensions (`declare_syntax_cat`, `syntax_cat`, `syntax`, `macro`, `macro_rules`, `notation`, `infix`, `infixl`, `infixr`, `prefix`, `postfix`, `elab`, `elab_rules`, `term_elab`, `command_elab`, `tactic`)
  - Each dropdown now defaults to `All (N)` so Object, Context/Init, and Extension scrollboxes are populated with the full declaration inventory on first render.
  - Interior selector options and declaration list chips are color-coded by declaration kind so the selector acts as a visual key for the panel.
  - Declaration lists are sorted case-insensitively by name (with line-number tiebreakers), including aggregated `All` views.
  - Users can still switch to individual kinds, and each dropdown remembers that selected kind while filtering so analysts can refine queries without losing active context.
  - The interior declaration search box now preserves focus and caret position during live filtering rerenders, preventing one-character input stalls while users type longer symbol queries.
  - The interior declaration panel no longer renders a dedicated header row; declaration filtering controls now anchor the panel start directly.
  - Re-selecting an already active module now forces an interior-panel repaint, preventing stale scrollbox content during rapid graph interactions.

## Accessibility and mobile

- Skip link and landmark regions are present.
- Flow chart container is keyboard focusable and labeled.
- On small screens, touch targets are enlarged and a usage hint is shown.
- Chart scrolling uses touch-optimized overflow behavior.

## Troubleshooting checklist

1. Run data sync scripts and commit refreshed snapshots.
2. Validate snapshots with `node scripts/validate-data.mjs`.
3. Run parser and runtime-map regression tests with `node scripts/lib/lean-analysis.test.mjs` and `node scripts/lib/map-runtime.test.mjs`.
4. Verify `map.html` references `assets/css/map.css` and `assets/js/map.js`.
5. Validate reverse import-edge integrity with `node scripts/validate-data.mjs` (now includes graph symmetry checks).
