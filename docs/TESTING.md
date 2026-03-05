# Testing and Validation Matrix

This repository uses lightweight Node-based checks.

> Documentation baseline: website release **0.1.0**.

## Automated checks

### Parser and extraction regression tests

```bash
node scripts/lib/lean-analysis.test.mjs
node scripts/lib/data-validation.test.mjs
node scripts/lib/map-runtime.test.mjs
```

Validates:
- Lean import token extraction
- interior symbol extraction across all supported declaration kinds and line tracking
- theorem counting behavior
- README metric table parsing
- data schema and graph consistency validation behavior
- map runtime normalization (modules-array-first hydration, branch-wrapper payload extraction, rejection of payloads that omit `modules[]`, filtering of branch-ref pseudo-modules and URL module paths, declaration-centric canonical payload support, declaration projection into symbol buckets, theorem fallback derivation, path-based dependency normalization, deterministic module/file ordering, stable per-module defaults, `symbolsLoaded` correctness, and interior-kind group aggregation/default-selection behavior)

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
node --check assets/js/site.js
node --check assets/js/background-pattern.js
node --check assets/js/theme-init.js
```

## Manual verification recommendations

- Confirm `index.html` and `map.html` load from a static server.
- Test map page on mobile viewport (~390px width).
- Confirm map filtering/search and keyboard traversal still function.
- Confirm each interior dropdown (Object, Extension, Context/Init) defaults to `All kinds (N)`, can switch kinds, and deep-link declarations to source lines.
- Confirm selecting a different module node in the flow chart updates all three interior declaration scrollboxes (Object/Extension/Context-Init) to the newly selected module.
- Confirm modules-array payload compatibility by testing both string and object module entries, including branch-wrapper payloads where top-level `main` metadata must not become a module node.
- Confirm legacy symbol compatibility with snapshots that use `symbols.by_kind` and/or `constant` declaration keys.
- Confirm map live status messaging remains coherent during load/refresh.
