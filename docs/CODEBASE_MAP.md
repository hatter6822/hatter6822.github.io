# Codebase Map: End-to-End Guide

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
   - Parses imports and interior declarations (theorems/functions with line anchors).
   - Normalizes imports against the current module inventory and rebuilds reverse import edges for consistency.
   - Computes module degree, pair linkage, and assurance labels.

5. **Rendering lifecycle**
   - Updates stat cards and status text.
   - Renders filter chooser + options.
   - Builds flow chart, interior menu, and traversal trail.

## Interaction model

- **Context jump:** module/path search + Enter.
- **Keyboard walk:** `j` and `k` outside input controls.
- **Detail levels:** compact/balanced/expanded.
- **Graph scope toggles:** full flow and proof-linked-only.

## Accessibility and mobile

- Skip link and landmark regions are present.
- Flow chart container is keyboard focusable and labeled.
- On small screens, touch targets are enlarged and a usage hint is shown.
- Chart scrolling uses touch-optimized overflow behavior.

## Troubleshooting checklist

1. Run data sync scripts and commit refreshed snapshots.
2. Validate snapshots with `node scripts/validate-data.mjs`.
3. Run parser regression tests with `node scripts/lib/lean-analysis.test.mjs`.
4. Verify `map.html` references `assets/css/map.css` and `assets/js/map.js`.
