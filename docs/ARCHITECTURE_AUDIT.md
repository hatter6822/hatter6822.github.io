# Website Architecture Audit (2026)

## Scope
Audit of the static marketing site and codemap experience in this repository.

## Findings

1. **Flat asset layout limited growth**
   - CSS and JavaScript were all at repository root, which made page ownership and future feature work harder to scale.
2. **Map ingestion logic had duplication**
   - Parsing/classification logic existed in both browser/runtime and sync script paths.
3. **Map UI hot-paths lacked memoization**
   - Filtered/sorted module lists were recomputed frequently during interactive updates.
4. **Automated test coverage was minimal**
   - No regression tests existed for map parsing and symbol extraction semantics.
5. **Operational docs were sparse**
   - Setup, architecture, and testing guidance were mixed into a short README.

## Remediation delivered in this change

- Reorganized static assets under `assets/css` and `assets/js`.
- Introduced `scripts/lib/map-analysis.mjs` as a shared parser/classifier library for the map data pipeline.
- Added filtered-module memoization and invalidation in the map runtime for better responsiveness under repeated UI updates.
- Added node-based unit tests (`node:test`) covering parser/tokenization/symbol extraction behavior.
- Expanded docs with dedicated architecture, map internals, and testing references.

## Remaining opportunities

- Split `assets/js/map.js` into page-level modules (`data`, `render`, `state`, `controls`) once the site can serve ES modules uniformly.
- Add CI workflow to run `node --test` and lint checks on each PR.
- Add synthetic performance benchmark snapshots for map render time with representative large module sets.
