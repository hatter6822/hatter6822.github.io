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
- theorem counting behavior
- README metric table parsing
- data schema and graph consistency validation behavior
- map runtime normalization (modules-array-first hydration, branch-wrapper payload extraction, rejection of payloads that omit `modules[]`, filtering of branch-ref pseudo-modules and URL module paths, declaration-centric canonical payload support, declaration projection into symbol buckets, theorem/function fallback derivation from `byKind` when explicit arrays are empty, path-based dependency normalization, deterministic module/file ordering, stable per-module defaults, `symbolsLoaded` correctness, interior-kind group aggregation/default-selection behavior, and interior search caret-range normalization used by live filter rerenders)

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
- Test map page on mobile viewport (~390px width).
- Confirm the compact toolbar is rendered directly below the "Interactive dependency/proof flow chart" header, before the interior declaration panel, and contains only current module context search, flow detail presets, and reset, and includes compact-density toolbar semantics.
- Confirm map context-search, detail-preset keyboard navigation (Arrow/Home/End), and keyboard traversal still function.
- Confirm flow legend chips render in the flowchart upper-right corner (not as detached panels) and remain visible while panning/scrolling the chart.
- Confirm reset restores default balanced detail mode, clears any search validity errors, and preserves a minimal toolbar footprint across desktop/mobile breakpoints.
- Confirm each interior dropdown (Object, Extension, Context/Init) defaults to `All (N)`, can switch kinds, and deep-link declarations to source lines.
- Confirm the `Filter declarations across all kinds…` search box accepts multi-character typing without dropping focus/caret after each keystroke.
- Confirm selecting a different module node in the flow chart updates all three interior declaration scrollboxes (Object/Extension/Context-Init) to the newly selected module.
- Confirm modules-array payload compatibility by testing both string and object module entries, including branch-wrapper payloads where top-level `main` metadata must not become a module node.
- Confirm legacy symbol compatibility with snapshots that use `symbols.by_kind` and/or `constant` declaration keys.
- Confirm map live status messaging remains coherent during load/refresh.

### Cross-browser nav stability probe (optional, Playwright)

If Playwright browsers are available in your environment, run a smoke probe that clicks a hash nav link and samples active nav state over time.

```bash
# serve the repository root
python3 -m http.server 4173 --bind 0.0.0.0

# in another shell, use Playwright (chromium/firefox/webkit)
python3 scripts/nav-stability-smoke.py
```

Expected: selected hash link remains active through the full sample window in Chromium, Firefox, and WebKit/Safari-compatible engines.
