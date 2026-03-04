# Codebase Map: End-to-End Technical Guide

## Data flow

1. `scripts/sync-map-data.mjs` reads repository tree + blob content from GitHub API.
2. Shared parser helpers in `scripts/lib/map-analysis.mjs` extract:
   - module identity,
   - import graph edges,
   - theorem/function symbol metadata,
   - layer/kind classification.
3. Snapshot is written to `data/map-data.json` for deterministic cold-start rendering.
4. Browser runtime (`assets/js/map.js`) loads bundled data, then optionally live-refreshes from GitHub.
5. UI renders a focused interactive flow graph + context metadata.

## Runtime optimization strategy

- Filtered module list is memoized by a filter signature (`layer`, `proof-linked`, module count, commit SHA).
- Cache invalidates automatically when data or filter state changes.
- Existing degree and label wrapping caches remain in place.

## Safety model

- Browser requests use strict fetch options and timeout guards.
- Snapshot fallback ensures map page remains functional when API requests fail.
- URL state is bounded/validated before applying to runtime controls.

## Maintenance commands

```bash
node scripts/sync-map-data.mjs
node --test
```
