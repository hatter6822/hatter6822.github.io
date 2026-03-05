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

4.1 **Schema-compat normalization (runtime)**
   - Map hydration now tolerates legacy payload shapes from older snapshots/canonical exports:
     - symbol buckets in either `symbols.byKind` or `symbols.by_kind`
     - declaration aliases like `constant`/`constants`
     - module lists provided as strings, structured objects, or inferred from `moduleMap`/`moduleMeta`/`importsFrom`
   - This normalization ensures that selecting any flow-chart node consistently repaints all three interior declaration columns.
   - Runtime sanitization now filters malformed module/import keys during hydration, preventing invalid payload entries from polluting flow-graph state.
   - Normalization seeds empty import/external-import buckets and default module metadata for every discovered module, so rendering paths can rely on stable object shapes.
   - Canonical payload hydration now also unwraps branch-keyed exports (for example `{ "main": { ...mapPayload } }`) before schema normalization so branch names are never misclassified as Lean modules.
   - Canonical payload selection now scores top-level and nested candidates by map-shape strength (modules/moduleMap/imports/moduleMeta), so weak top-level metadata cannot eclipse a valid nested branch payload.
   - Canonical hydration now prioritizes the explicit `modules` array when it is present, so branch-ref metadata keys like `main` can never leak into the flow graph or map stats cards as faux module nodes.
   - `symbolsLoaded` now keys off normalized symbol buckets, avoiding unnecessary source refetches when payloads use legacy `by_kind` aliases.

5. **Rendering lifecycle**
   - Updates stat cards and status text.
   - Renders filter chooser + options.
   - Builds flow chart, context strip, three-kind dropdown interior menu (Object, Extension, Context/Init), and traversal trail.

## Interaction model

- **Context jump:** module/path search + Enter.
- **Keyboard walk:** `j` and `k` outside input controls.
- **Detail levels:** compact/balanced/expanded.
- **Graph scope toggles:** full flow and proof-linked-only.

- **Interior declaration explorer:** the flow chart context now exposes all interior Lean declaration kinds via three dropdowns:
  - Object kinds (`inductive`, `structure`, `class`, `def`, `theorem`, `lemma`, `example`, `instance`, `opaque`, `abbrev`, `axiom`, `constant`, `constants`)
  - Extension kinds (`declare_syntax_cat`, `syntax_cat`, `syntax`, `macro`, `macro_rules`, `notation`, `infix`, `infixl`, `infixr`, `prefix`, `postfix`, `elab`, `elab_rules`, `term_elab`, `command_elab`, `tactic`)
  - Context/Init kinds (`universe`, `universes`, `variable`, `variables`, `parameter`, `parameters`, `section`, `namespace`, `end`, `initialize`)
  - Each dropdown remembers its selected kind while filtering so analysts can refine queries without losing active context.
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
