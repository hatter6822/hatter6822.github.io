# Website Architecture

## Goals
- Keep the site fully static for GitHub Pages compatibility.
- Centralize shared UI primitives so pages evolve consistently.
- Isolate data synchronization logic from browser runtime logic.
- Create testable parser utilities for reliable metric extraction.

## High-level layout
- `index.html`: marketing and project overview page.
- `map.html`: interactive codebase map application.
- `site.js`: home-page runtime metrics hydration.
- `map.js`: map runtime, filtering, and visualization rendering.
- `js/shared-ui.js`: shared browser concerns (theme, mobile nav, external link hardening).
- `scripts/`: data sync tooling.
- `scripts/lib/parsers.mjs`: reusable parsing/tokenization primitives used by sync scripts.
- `tests/`: Node-native tests focused on deterministic parser behavior.
- `data/`: bundled snapshots used as deterministic startup data.

## Runtime data flow
1. Page boot renders bundled values.
2. Page checks cache (`localStorage`) and applies if fresher than bundled snapshots.
3. Page refreshes live repository metadata from GitHub APIs.
4. Cache is updated with normalized schema and TTL metadata.

## Shared UI layer
`js/shared-ui.js` now owns:
- Theme initialization and persistence.
- Theme toggle behavior.
- Mobile navigation open/close and escape-key interactions.
- Security hardening for external links (`noopener noreferrer`).

This avoids divergence between `index.html` and `map.html` over time.

## Map-page performance notes
- Module filtering now uses an in-memory cache key keyed by filter state and dataset size.
- Cached filtered results avoid repeated full scans during high-frequency rerenders.
- Existing requestAnimationFrame rendering scheduler remains the primary anti-jank mechanism.

## Testing strategy
- Parser utilities are unit-tested using Node's built-in test runner.
- Tests focus on semantic behavior for metric extraction and import tokenization.
- Sync scripts consume parser utilities so tests protect both scripts transitively.
