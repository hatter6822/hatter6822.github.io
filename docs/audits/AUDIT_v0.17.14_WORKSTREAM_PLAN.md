# Audit v0.17.14 — Workstream Plan

> Baseline: website release **0.17.5**, audit date **2026-03-21**.

## Phase R4: Lifecycle & Service Coherence

### Objective

Harden the runtime lifecycle of all browser-side services — fetch pipelines,
polling timers, render scheduling, cache management, and cleanup paths — so
that every service has a coherent start → run → dispose lifecycle, shared
utilities are deduplicated, and no resource leaks or stale-state bugs can
occur during normal operation or page teardown.

### Scope

| Area | Files | Summary |
|------|-------|---------|
| Live sync polling | `assets/js/map.js` | Timer lacks cleanup; visibility/focus/online listeners never removed |
| Fetch patterns | `assets/js/site.js`, `assets/js/map.js` | Duplicated timeout/abort logic; site.js missing timer cleanup in `.catch` |
| Duplicate utilities | `assets/js/site.js`, `assets/js/map.js` | `safeScrollTo`, `normalizePagePath`, `hardenExternalLinks`, `setupTheme`/`setTheme`, `setupNav` duplicated across files |
| Cache management | `assets/js/site.js`, `assets/js/map.js` | Similar localStorage patterns with different key/schema constants but no shared abstraction |
| Render scheduling | `assets/js/map.js` | `scheduleRender` and `scheduleInteriorMenuRender` guard re-entry but don't guard stale frames after data reload |
| Background animation | `assets/js/background-pattern.js` | Resize timer not cleared on context loss; old buffer not deleted on restore |
| Event listener cleanup | `assets/js/header-nav.js` | MutationObserver/ResizeObserver never disconnected (acceptable for SPA-lifetime nav, but document) |

### Task breakdown

#### R4.1 — Centralize service lifecycle in map.js
- Extract `setupLiveSyncPolling` timer ID into module-scoped variable
- Add `stopLiveSyncPolling()` that clears the timeout chain
- Clear polling on `webglcontextlost`-equivalent scenario (page unload)
- Wire `beforeunload` listener to call `stopLiveSyncPolling()` for clean teardown

#### R4.2 — Fix live sync polling cleanup
- `setupLiveSyncPolling` uses recursive `setTimeout` with no stored timer ID
- Store the pending timer ID so it can be cancelled
- Add `pagehide` event handler to cancel pending poll on navigation away
- Prevent poll trigger when `inFlight` is true AND document is hidden

#### R4.3 — Consolidate duplicate utility functions
- `safeScrollTo` exists in both `site.js` and `header-nav.js` with different implementations
- `normalizePagePath` duplicated in `site.js` and `header-nav.js`
- `hardenExternalLinks` duplicated in `site.js` and `map.js`
- `setupTheme`/`setTheme` duplicated in `site.js` and `map.js`
- `setupNav` duplicated in `site.js` and `map.js`
- Since there's no bundler, the canonical approach is: `header-nav.js` owns navigation,
  each page script delegates to it. For theme/harden, one file is canonical and the other
  guards with `typeof` checks.

#### R4.4 — Unify fetch timeout pattern
- `site.js` uses `fetchWithTimeout` with `AbortController` + `setTimeout` + `.finally()`
- `map.js` uses `safeFetch` with `AbortController` + `setTimeout` + manual cleanup in both `.then` and `.catch`
- Both patterns work but differ in edge-case cleanup
- Standardize: ensure both use `.finally()` for timer cleanup (map.js `.catch` path already clears, but consolidation improves clarity)

#### R4.5 — Fix AbortController/timer cleanup edge case in site.js
- `fetchWithTimeout` clears the timer in `.finally()` but doesn't null-check `controller`
- The `controller` is already guarded by `typeof AbortController === "function"` but the timer should also be null-guarded in edge cases
- Ensure abort signal errors are not double-thrown

#### R4.6 — Centralize cache key documentation
- Document all localStorage keys used across the codebase in one reference
- Keys: `sele4n-theme`, `sele4n-live-v2`, `sele4n-code-map-v9`, `sele4n-code-map-live-sync-meta-v1`, `sele4n-nav-intent-v1`, `sele4n-bg-animation-paused-v1`
- Add inline comments in each file referencing the canonical key list

#### R4.7 — Guard stale render frames after data reload
- `applyData` in map.js calls `renderAll()` synchronously
- A pending `requestAnimationFrame` from `scheduleRender()` could fire after `applyData` completes, causing a double render
- Add a render epoch counter: increment on `applyData`, skip scheduled renders from previous epochs

#### R4.8 — Fix background-pattern.js resource cleanup
- On `webglcontextrestored`, new buffer is created but old `buf` variable is overwritten without deleting old buffer (old buffer is already lost with context, so this is cosmetic)
- Resize timer should be cleared on context loss to prevent resize during lost state
- Document that `MutationObserver` for theme changes is intentionally never disconnected (page-lifetime)

### Test coverage additions

- Test that `safeFetch` timer cleanup works in both success and error paths
- Test that `normalizeMapData` + `applyData` sequence produces valid render state
- Test render epoch guard prevents stale-frame double renders
- Test localStorage key documentation matches actual usage

### Documentation updates

- `docs/ARCHITECTURE.md` — Add lifecycle management section
- `docs/DEVELOPER_GUIDE.md` — Add localStorage key reference
- `docs/TESTING.md` — Update test matrix with lifecycle coverage
- `docs/CODEBASE_MAP.md` — Document live sync polling lifecycle
- `CONTRIBUTING.md` — Reference new lifecycle patterns

### Success criteria

1. All existing tests pass with zero warnings
2. New lifecycle tests pass
3. No duplicate utility functions across files
4. Every timer/polling mechanism has a documented cleanup path
5. Render scheduling is epoch-guarded against stale frames
6. All documentation updated to reflect changes
