# CLAUDE.md — seLe4n Website Project Guidance

## Project Overview

This repository is the static website for **seLe4n**, a formally verified microkernel written in Lean 4. It consists of two pages and a data pipeline:

- `index.html` — Marketing/overview landing page
- `map.html` — Interactive codebase map with dependency graph, theorem coupling, and declaration explorer
- `data/*.json` — Bundled snapshots consumed by the browser runtime
- `scripts/*.mjs` — Node.js tooling to regenerate and validate those snapshots

**Stack:** Pure HTML5 + CSS3 + Vanilla JavaScript ES6+ (no frameworks, no bundler). Node.js for offline tooling only.

**Website version:** `0.30.0`
**Lean toolchain target:** `4.28.0`

## Build and Validation Commands

### Required before every commit

```bash
# Parser and validation tests (all must pass, zero warnings)
node scripts/lib/lean-analysis.test.mjs
node scripts/lib/rust-analysis.test.mjs
node scripts/lib/canonical-map.test.mjs
node scripts/lib/data-validation.test.mjs
node scripts/lib/map-runtime.test.mjs
node scripts/lib/map-toolbar.test.mjs
node scripts/lib/trace-analysis.test.mjs
node scripts/lib/run-runtime.test.mjs
node scripts/lib/static-values.test.mjs
node scripts/lib/i18n-locales.test.mjs
node scripts/lib/i18n-runtime.test.mjs
node scripts/lib/csp-html.test.mjs

# Bundled data integrity
node scripts/validate-data.mjs
node scripts/validate-traces.mjs

# JavaScript syntax checks
node --check assets/js/map.js
node --check assets/js/run.js
node --check assets/js/header-nav.js
node --check assets/js/site.js
node --check assets/js/i18n.js
node --check assets/js/theme-init.js
```

### Data refresh (when upstream seLe4n repo changes)

```bash
node scripts/sync-upstream.mjs         # one clone → site-data + map-data + traces
node scripts/apply-static-values.mjs   # stamp index.html + locales/*.json from site-data.json
```

## Validation Tiers

| Tier | Scope | When to run |
|------|-------|-------------|
| 0 | JS syntax checks (`node --check`) | Every commit |
| 1 | Unit tests (`scripts/lib/*.test.mjs`) | Every commit |
| 2 | Data validation (`scripts/validate-data.mjs`) | Every commit, after data changes |
| 3 | Manual browser verification (desktop + mobile) | UI/layout changes |
| 4 | Playwright probes: `scripts/map-smoke.mjs` (code map layout and behaviour in headless Chromium; CI runs it on every push) and `scripts/nav-stability-smoke.py` (navigation) | Map layout, navigation or scroll behaviour changes |

Run at least Tiers 0-2 before any commit. Tier 3 for front-end changes. Tier 4 when touching navigation or scroll behavior.

## Large File Handling

Several files exceed 500 lines:

| File | Lines | Notes |
|------|-------|-------|
| `assets/js/map.js` | ~6,440 | Largest runtime; read in chunks of ≤500 lines |
| `scripts/lib/map-runtime.test.mjs` | ~2,480 | Map runtime tests |
| `assets/css/style.css` | ~2,020 | Global design system |
| `assets/js/run.js` | ~1,939 | Simulator runtime (fold engine + SVG scenes) |
| `assets/css/map.css` | ~1,400 | Map-specific styles (hero, workspace, chart, sidebar, Rust cards, inventory) |
| `assets/js/header-nav.js` | ~749 | Shared navigation controller |
| `scripts/lib/rust-analysis.mjs` | ~750 | Rust crate inventory scanner |
| `assets/js/site.js` | ~566 | Landing page runtime (renders the bundled snapshot; derives nothing) |

**Rules:**
- Never read an entire large file in one operation. Use offset/limit (≤500 lines per read).
- Use the Edit tool for modifications to existing files, never Write.
- Keep edits surgical — one logical change per Edit call.

## Key Architectural Conventions

### Runtime data strategy (local-first)

1. Load bundled `data/*.json` immediately
2. Hydrate from browser `localStorage` cache if newer
3. Attempt live refresh from GitHub APIs (with cooldown + jitter)
4. Fall back gracefully if network refresh fails

**The landing page is exempt from steps 2-4 and must stay that way.** Its
statistics come from `data/site-data.json` alone, which
`scripts/sync-upstream.mjs` projects offline from the kernel's canonical
`docs/codebase_map.json`; `index.html` ships with those same values stamped into
the markup, so a failed fetch degrades to the correct numbers. `connect-src` is
`'self'` on that page to keep it that way.

**`map.html` is bundle-first in practice.** The serialized map snapshot is past
the ~5M-unit `localStorage` quota, so step 2 never has anything to hydrate:
`setCache()` skips the write above `CACHE_MAX_CHARS` (4 MiB of UTF-16 units)
and returns `false` instead of throwing into an empty `catch`. The cache code
stays (it works for smaller snapshots and the unit tests cover it), but no
feature may depend on the map cache persisting between visits.

### One pipeline, one revision

`scripts/sync-upstream.mjs` is the only thing that fetches upstream. It clones
seLe4n once and writes all three `data/*.json` snapshots from that single
checkout, after verifying the canonical artifact's `source_sync.source_digest`
over the Lean sources it ships with.

Three separate sync scripts preceded it and drifted: `site-data.json` was
generated at one commit and `map-data.json` at another, and each re-derived the
same quantities by its own method, so the landing page and the code map quoted
different module and theorem counts for the same kernel. Both snapshots now
record the same `commitSha` and `sourceDigest`, and `validateCrossFile` fails
the build when they disagree — including when the module or theorem totals
diverge. Do not add a second fetcher.

### Landing-page metrics are canonical or absent

`docs/codebase_map.json` is the source of truth for every published statistic —
the kernel generates it, and seLe4n's own README table is rendered from its
`readme_sync` block.

- A metric may fall back to another key **of the same artifact**; it may never
  fall back to a source outside it. A README parse, a `GET /languages` byte
  estimate and a `modules × 2` build-job count all shipped as facts this way.
- A missing key aborts the sync (`canonicalMetricsIssues`). Publishing a partial
  projection is how the page drifted in the first place.
- Scope is **production Lean**: the artifact's production set (everything
  outside `tests/`) **minus the in-tree testing framework** `SeLe4n/Testing/`,
  so the headline figures describe one corpus. `modules` and `theorems` are
  counted over that inventory; `lines` is the artifact's `production_loc` minus
  the framework files' physical lines, measured on the digest-verified sources
  (the same count reproduces `production_loc` exactly, and
  `canonicalCrossChecks` says so if it ever stops). Recorded as `metricsScope`
  and pinned by `validate-data.mjs`, which also rejects any map module under
  `tests/` or `SeLe4n/Testing/`. The scope lives in one place,
  `scripts/lib/canonical-map.mjs` (`isProductionModule`). Because the kernel's
  own README table is rendered from the same artifact at its wider scope, the
  landing page says so under the hero stats (`hero.scope_note`); keep that
  sentence whenever the figures are shown without it.
- `SELE4N_REF=<40-hex commit> node scripts/sync-upstream.mjs` regenerates the
  snapshots at a pinned upstream revision, so a data change can be reviewed
  against one known commit. The snapshot still records `sourceRef: main`.
- Theorem counts come from the artifact's comment-aware `modules[].declarations`
  inventory, **not** from `readme_sync.proved_theorem_lemma_decls`. That field is
  a bare per-line regex: on the current artifact it counts 78 prose lines inside
  doc comments and misses 15 `protected`/`noncomputable` declarations. See the
  reconciliation at the top of `scripts/lib/canonical-map.mjs`.
- Never write a metric into `index.html` or a locale by hand. Every literal copy
  is stamped by `scripts/apply-static-values.mjs`; `static-values.test.mjs`
  fails when the committed tree drifts.

### Locale files embed live metrics

`data-i18n-html` sets `el.innerHTML` wholesale, so each `locales/*.json` carries
its own copy of the `data-live` spans **and the numbers inside them**. They
silently drifted to `546` while `index.html` said `574`. Any change touching a
metric must run `apply-static-values.mjs`, and `index.html`, `data/` and
`locales/` must be committed together.

### Code map page structure (0.30.0)

`map.html` is three sections, in this order, and the order is asserted by
`map-toolbar.test.mjs`: the **Lean module workspace** (toolbar, flow chart,
declaration sidebar), the **Rust production crates**, and the **repository
inventory**. Production code is the subject; everything else is viewable but
visually secondary (closed `<details>`, muted chrome).

- The workspace opens on `SeLe4n.Kernel.API` whenever the URL carries no
  `module=`. `DEFAULT_MODULE` in `map.js` is the one place that says so;
  `defaultModuleName()` falls back to the first module only when the snapshot
  lacks the API module. The previous release opened on `Main` (the first
  module in name order); when a live tree rebuild dropped `Main.lean`, the
  chooser fell back to the top-scored module,
  `SeLe4n.Kernel.IPC.Invariant.Structural.DualQueueMembership`. Never
  reintroduce the score heuristic as a default, and keep `Main.lean` in the
  tree path (`isLeanModulePath`).
- A lane with more modules than the detail budget groups them by
  `moduleSubsystem()` (the parent namespace, capped at three segments) and opens
  each group in place. The budget cut ("+38 more imports") is kept only for
  expanded flow mode.
- **The chart is never drawn below 1:1.** `.flowchart-svg` is `width: auto;
  min-width: 100%` at every width, and `minimumFlowWidth()` returns 900 from
  900px up, so the layout is `max(900, column width)` and a wider layout
  scrolls inside `.flowchart-wrap`. Never put `width: 100%` back on the SVG
  and never raise the desktop minimum: a fixed 1180 beside the sidebar scaled
  the chart to 0.58–0.86 at every desktop width, which is what got 0.30.0
  reverted the first time.
- The declaration sidebar sits beside the chart only from **90rem** (1440px),
  the narrowest viewport that leaves the chart a ~900px column beside a
  22.5rem sidebar (75rem left 738px). It is sticky there, and its list height
  is viewport-bound so the pinned sidebar fits a 720px-tall screen. Below
  90rem it stacks under the chart.
- Imports the graph does not contain are labelled by what they are: `SeLe4n`
  is "in-repo · library root", `SeLe4n.Testing.*` is "in-repo · outside
  production scope", everything else "external dependency".
- Re-selecting the current module must not repaint the declaration sidebar
  unless it shows another module: the search field's `change` fires on blur,
  and rebuilding the list under the pointer swallowed the click that caused it.
- Count labels use plural families (`key_one` / `key_few` / `key_many` /
  `key_other`) resolved by `t(key, { count })`, and every number handed to
  `t()` or `formatCount()` is grouped by the active locale (`10,929`,
  `10 929`, `10.929`). Never hard-code a separator or a plural in a string.
- The Rust cards render `map-data.json#rust` and derive nothing. Test items
  are listed only behind each card's toggle; `crate.items` counts production
  declarations alone. `rustUnsafeSummary()` reads `unsafe` (production) and
  `testUnsafe` apart: the card's headline is the production figure, the detail
  line names the fn/impl/block counts, the item-level `allow` exception
  (`sele4n-abi`) and "+N in test code", and the strip sums production sites.
  Never show one total that mixes the two; the reverted build's "118 sites"
  was neither figure.
- A target-scoped dependency table is stated under its cfg ("under
  cfg(loom): loom"), dev-dependencies as "test-only"; only unconditional
  tables are "external".
- Every file under `rust/` has one entry on the page: the crate cards own the
  `.rs` sources and `crateSupportFiles()` lists the rest (`Cargo.toml`,
  `link.ld`, `.S`) per crate in the inventory, then the workspace files.
- Content sets a card's height: `.rust-crate-grid` is `align-items: start`
  and `.rust-crate-files` is bounded (`max-height`, scrolls inside the card).
  With the default `stretch`, the HAL's 33-file card once set a 3,000px row
  and three quarters of the section was blank. The dependency strip SVG keeps
  its `width` attribute, is centred when narrower than its figure, and scrolls
  inside `.rust-dependency-scroll` when wider.
- A live refresh may carry no repository tree (the canonical artifact lists
  only Lean modules) and never carries a Rust inventory. `retainInventory()`
  keeps the previous tree and crates in that case and records the commit each
  was taken at, so the inventory sections do not empty out on a networked
  visit.
- `renderInventory()` rebuilds both sections from scratch, on every live
  refresh and locale switch, so it captures the open state of every
  `<details>` (`data-open-key`) first and re-applies it after. Never rebuild
  these sections without that: the refresh lands seconds after first paint,
  exactly when a reader has started opening things.
- Count labels ("303 modules", "1 file", "Show 61 test items") come from
  plural families through `t(key, { count })`; the English fallbacks go
  through `pluralEn()`. No string may hard-code a plural or a separator.
- `node scripts/map-smoke.mjs` renders the page in headless Chromium and
  asserts the guarantees above (chart at 1:1 at 1200–1920, sidebar placement,
  the pinned sidebar at 720p, no sideways overflow, clean console, both
  themes, a Spanish deep link, the crate cards and inventory, bounded card
  heights, pluralised labels, `loom` under its cfg, and open state surviving a
  re-render). `.github/workflows/ci.yml` runs it with the
  runner's Chrome on every push. A layout guarantee the docs make gets a probe
  assertion.

### Rust crate inventory (`map-data.json#rust`)

`scripts/lib/rust-analysis.mjs` scans the `rust/` workspace of the same pinned
checkout and bundles one descriptive block: crates in workspace order, each
with its manifest facts, per-file item lists (kind, name, line, visibility,
inline-module path, `test` flag) and counts. It feeds **no landing-page
statistic**; the landing page stays canonical-or-absent.

- **Counts describe the production surface.** `items` counts nameable
  declarations (`fn`, `struct`, `enum`, `union`, `trait`, `type`, `const`,
  `static`, `mod`, `macro_rules!`) outside test code; `impl` blocks are listed
  but not counted. `publicItems` counts those declared `pub` whose enclosing
  inline modules are all `pub`. `testItems` is everything flagged `test`.
- **`unsafe` and `testUnsafe` are two counters with one definition each**:
  `unsafe fn` headers at any depth (free functions and methods alike),
  `unsafe impl` blocks and `unsafe { … }` blocks, attributed to test or
  production by the innermost enclosing item. An earlier scanner counted
  functions and impls at file scope only, and blocks everywhere including test
  modules, so the HAL's total was neither figure; never reintroduce a counter
  that mixes scopes.
- **Test code is decided by the `cfg` predicate, not by the word `test`.**
  `cfgIsTestOnly` treats `cfg(test)` and `cfg(all(test, …))` as test-only, and
  `cfg(not(test))` and `cfg(any(test, feature = "…"))` as production, because
  those compile into production builds. `#[test]` functions, everything inside
  a marked module or block, and every line of an integration-test file are
  test code.
- **Target-scoped dependency tables stay separate.** `[target.'cfg(loom)'
  .dependencies]` is bundled as `targetDependencies: [{ cfg, table, names }]`,
  never as an external dependency: the HAL's `loom` enters no ordinary build.
- **`deniesUnsafe` is read from the crate root only** (`src/lib.rs`, or
  `src/main.rs` for a binary-only package). A lint in a `src/bin/*.rs` target
  speaks for that binary, not for the library.
- `validate-data.mjs` reconciles every crate total with its per-file lists,
  counter by counter, and rejects a crate file the snapshot's `files[]` does
  not list.

### Map data normalization

- `modules[]` array is the canonical source of graph nodes
- Legacy top-level maps (`moduleMap`, `importsFrom`, `moduleMeta`) are fallbacks only
- Branch-ref metadata keys (e.g. `main`) are excluded from module inventories
- Declaration-centric payloads (`modules[].declarations`) are projected into symbol buckets
- `moduleMeta[].symbols.callGraph` ships in the bundled snapshot; every key must
  also appear in that module's `byKind` lists (`validate-data.mjs` asserts it),
  because the runtime resolves a declaration through one and its calls through
  the other
- Reverse import edges (`importsTo`) are always rebuilt from `importsFrom`

### CSS override weight (media queries add no specificity)

A rule inside `@media`, `@supports`, or `@media print` competes on ordinary
specificity. A responsive override written with fewer classes than the base rule
it means to replace silently loses, and the desktop value survives into the
mobile layout. This has caused five separate visual defects in this codebase.

- Write a responsive override with **at least** the weight of the base rule it
  overrides. Prefer making the base rule *less* specific over making the
  override *more* specific.
- When both rules end up at equal weight (e.g. two `[data-theme="light"] .x`
  rules), source order decides — put the fallback block last and say so in a
  comment.
- For values that change per breakpoint, prefer a custom property consumed by a
  single rule (see `--arch-cols`). Re-declare the property on the element that
  consumes it; a declaration on the element always beats a value inherited from
  an ancestor, whatever the ancestor selector's specificity.
- `@media print` colour resets are the one place `!important` is correct — a
  bare `a` or `code` selector loses to every component rule on the page.

### A winning declaration can still do nothing (inline boxes)

Specificity is only half of it — the box has to be able to accept the property.
On an **inline** box, `width`, `height`, `min-height`, and vertical padding
contribute nothing to layout, so a responsive rule that sets them applies and is
silently inert. `.nav-links a` is the case that bit: its anchors are inline, so
the mobile drop-down's `width: 100%` and `min-height: 2.75rem` did nothing and
every row overlapped its neighbour.

- Before setting a box property in a responsive override, check the element's
  used `display`. Anything that must own a row needs `block` or `flex` first.
- `getBoundingClientRect().height` on an inline box reports the union of its
  *painted* fragments, vertical padding included. It is not the element's
  contribution to flow, and it will confirm a row height the layout does not
  have. Measure the offset between consecutive rows instead.
- A property that only makes sense in one formatting context does not carry
  over: `text-align: center` centres nothing once the element becomes a flex
  container sized to its content — that is `justify-content: center`.

### `nav.*` locale values are layout-constrained

The desktop menu is sized to its content and clamped by `.container`'s max-width,
so the ten items share a hard **932px** ceiling that does not grow with the
window — a locale that exceeds it wraps to two lines at every desktop width,
2560px included. English sits at 816px. Check the menu at 1280px after touching
any `nav.*` value; a wide window hides the defect rather than revealing it.

- Keep a `nav.*` value in the nav. `run.html`'s footer once rendered from
  `nav.code_map`, so compacting the menu label silently rewrote a footer that had
  no width pressure. Surfaces with different constraints get different keys
  (`footer.code_map`); share one only for locale-invariant strings like "GitHub".
- Menu labels are independent of the section headings they link to in every
  locale, so a shorter label costs no consistency.

### Security posture

Both HTML pages enforce:
- `Content-Security-Policy` (strict `default-src 'self'`)
- `Permissions-Policy` (geolocation, microphone, camera, payment, USB, browsing-topics disabled)
- `referrer` policy (`strict-origin-when-cross-origin`)
- `X-Content-Type-Options: nosniff`
- All external links hardened with `rel="noopener noreferrer"`

### Operations/Invariant split (upstream seLe4n convention)

The codebase map recognizes the Operations.lean/Invariant.lean pair pattern. Proof pairs are detected, scored, and visualized with assurance labels (linked/partial/local/none).

## File Ownership Quick Reference

| Change area | Primary file(s) |
|-------------|-----------------|
| Map graph behavior | `assets/js/map.js` |
| Map browser smoke probe | `scripts/map-smoke.mjs` |
| Continuous integration | `.github/workflows/ci.yml` |
| Map controls/layout/sections | `map.html`, `assets/css/map.css` |
| Landing page metrics | `assets/js/site.js`, `index.html` |
| Navigation behavior | `assets/js/header-nav.js` |
| Theme switching | `assets/js/theme-init.js` |
| Static fallback sync | `scripts/apply-static-values.mjs`, `scripts/lib/static-values.mjs` |
| Upstream data pipeline | `scripts/sync-upstream.mjs` |
| Canonical artifact contract | `scripts/lib/canonical-map.mjs` |
| Locale key parity | `scripts/lib/i18n-locales.test.mjs`, `locales/*.json` |
| Internationalization | `assets/js/i18n.js`, `locales/*.json` |
| Lean parsing | `scripts/lib/lean-analysis.mjs` |
| Rust crate inventory (map) | `scripts/lib/rust-analysis.mjs` |
| Data validation | `scripts/lib/data-validation.mjs` |
| Global styles | `assets/css/style.css` |
| Simulator (kernel-in-action) | `run.html`, `assets/js/run.js`, `assets/css/run.css` |
| Trace data + fold engine | `data/execution-traces.json`, `scripts/lib/trace-analysis.mjs` |

## Documentation Sync Requirements

When making changes, keep these documents in sync:

- `README.md` — Project overview and workflow
- `CONTRIBUTING.md` — Required checks and checklists
- `docs/ARCHITECTURE.md` — System architecture decisions
- `docs/CODEBASE_MAP.md` — Map pipeline and runtime behavior
- `docs/SIMULATOR_SPEC.md` — Simulator design + trace schema
- `docs/UPSTREAM_TRACE_EXPORT.md` — Kernel-side trace export bridge (source: fixture → kernel)
- `docs/DEVELOPER_GUIDE.md` — File-by-file orientation
- `docs/TESTING.md` — Testing matrix and manual verification

## Security Reporting

Any suspected CVE-worthy vulnerability discovered during work — whether in code logic, dependencies, build infrastructure, or specification gaps — must be reported immediately before continuing other work.
