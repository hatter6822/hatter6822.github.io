# Code Map Page: End-to-End Optimization Guide

## Objectives

- Keep the map responsive for large Lean module graphs.
- Preserve deterministic baseline rendering with graceful live refresh.
- Avoid user-facing regressions under partial network failure.

## End-to-end flow

1. **Bootstrap**
   - Load theme/navigation scaffolding.
   - Read URL state (`module`, `layer`, `detail`, toggles).
2. **Baseline acquisition**
   - Compare local cache vs bundled `data/map-data.json`.
   - Select freshest local baseline and render immediately.
3. **Live synchronization policy**
   - Respect cooldown/jitter via localStorage metadata.
   - Check latest commit; skip rebuild when unchanged.
4. **Graph rebuild (if needed)**
   - Fetch tree, then parse Lean blobs with bounded concurrency.
   - Compute imports, theorem/symbol metadata, proof-pair structure.
5. **Render cycle**
   - Recompute filtered/ranked module context.
   - Render toolbar summary, legend, context strip, interior symbol menu, and flowchart.

## Existing optimizations

- `requestAnimationFrame` render coalescing.
- `AbortController` + timeout for network hardening.
- Fetch concurrency cap (`FETCH_CONCURRENCY`) for blob analysis.
- Local cache TTL and sync cooldown metadata.
- Node cache for repeated DOM metric updates.
- Pre-synced bundled data for deterministic startup.

## Reliability constraints

- Network failures must not blank the map if local/bundled data exists.
- URL state must remain canonical and shareable.
- Source parsing must tolerate comments and multiline imports.

## Recommended next optimizations

1. **Chunked rendering for very large module sets**
   - Break flowchart node creation into micro-batches to prevent long main-thread stalls.
2. **Dedicated web worker for parsing**
   - Offload heavy import/symbol extraction from the UI thread.
3. **Incremental diff sync**
   - Compare changed file SHAs to avoid full reanalysis when only a subset changes.
4. **Selective interior-symbol hydration**
   - Fetch interior symbol details lazily when user expands a module.

## Regression checklist

- Validate navigation with keyboard (`j`/`k`).
- Validate `proof-linked-only` and `show full flow graph` toggles.
- Validate URL sharing round-trip.
- Validate stale cache startup and refresh transition messaging.

