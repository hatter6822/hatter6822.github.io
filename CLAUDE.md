# CLAUDE.md — seLe4n Website Project Guidance

## Project Overview

This repository is the static website for **seLe4n**, a formally verified microkernel written in Lean 4. It consists of two pages and a data pipeline:

- `index.html` — Marketing/overview landing page
- `map.html` — Interactive codebase map with dependency graph, theorem coupling, and declaration explorer
- `data/*.json` — Bundled snapshots consumed by the browser runtime
- `scripts/*.mjs` — Node.js tooling to regenerate and validate those snapshots

**Stack:** Pure HTML5 + CSS3 + Vanilla JavaScript ES6+ (no frameworks, no bundler). Node.js for offline tooling only.

**Website version:** `0.32.0`
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
node scripts/lib/source-anchors.test.mjs
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
| 4 | Playwright probes: `scripts/map-smoke.mjs` (code map layout and behaviour in headless Chromium), `scripts/index-smoke.mjs` (landing page: every stamped figure survives hydration, no label clipped, deep links match the resolved inventory) — CI runs both on every push — and `scripts/nav-stability-smoke.py` (navigation) | Map layout, landing-page figures, navigation or scroll behaviour changes |

Run at least Tiers 0-2 before any commit. Tier 3 for front-end changes. Tier 4 when touching navigation, scroll behaviour, the code map's layout, or any published figure.

## Large File Handling

Several files exceed 500 lines:

| File | Lines | Notes |
|------|-------|-------|
| `assets/js/map.js` | ~7,000 | Largest runtime; read in chunks of ≤500 lines |
| `scripts/lib/map-runtime.test.mjs` | ~2,700 | Map runtime tests |
| `assets/css/style.css` | ~2,020 | Global design system |
| `assets/js/run.js` | ~1,939 | Simulator runtime (fold engine + SVG scenes) |
| `assets/css/map.css` | ~1,100 | Map-specific styles (hero, workspace, scope toggle, chart, sidebar) |
| `assets/js/header-nav.js` | ~749 | Shared navigation controller |
| `scripts/lib/rust-analysis.mjs` | ~1,450 | Rust crate inventory scanner, TOML reader |
| `scripts/lib/rust-analysis.test.mjs` | ~1,200 | Rust scanner tests |
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
  against one known commit. The snapshot still records `sourceRef: main`. A
  pinned run regenerates at that revision or not at all: on a source-digest
  mismatch it fails and names the artifact's generation commit, instead of
  checking that commit out the way the unpinned sync recovers.
- `lines` is published only while a physical count over the artifact's own
  production files reproduces `production_loc` (`productionLocReproduction`);
  otherwise the subtraction would mix two counting methods and the sync
  refuses to publish rather than quote a wrong figure.
- Theorem counts come from the artifact's comment-aware `modules[].declarations`
  inventory, **not** from `readme_sync.proved_theorem_lemma_decls`. That field is
  a bare per-line regex: on the current artifact it counts 78 prose lines inside
  doc comments and misses 15 `protected`/`noncomputable` declarations. See the
  reconciliation at the top of `scripts/lib/canonical-map.mjs`.
- **The version is the one exception**, and deliberately: the artifact carries
  no version outside its README-mirroring `readme_sync` block, so taking it
  from there published a mirror of a mirror. `lakefile.toml` is where the
  project *declares* its version — `readme_sync.version`, the README badge and
  `rust/Cargo.toml` are all copies of it, and Cargo.toml says so in a comment.
  `readProjectVersion()` reads the declaration from the same pinned checkout,
  and `canonicalCrossChecks` reports any disagreement with the artifact rather
  than letting a stale artifact pass silently.
- Four figures are counted off the **digest-verified Lean sources**, because the
  artifact records declarations but not what this needs from them. Each one was
  hand-written until 0.32.0 and each one was wrong:

  | Metric | Read from | Was | Is |
  |--------|-----------|-----|-----|
  | `syscalls` | constructors of `inductive SyscallId` | 30 | 35 |
  | `externs` | `@[extern …]` declarations across production Lean | 17 | 73 |
  | `enforcementOps` | the length `enforcementBoundaryExtended_count` proves | 38 | 44 |
  | `enforcementOpsPerCore` | the length `enforcementBoundaryPerCore_count` proves | — | 59 |

  The enforcement figures come off a machine-checked statement, which is as
  close to the truth as a published number gets — and upstream's own docstring
  asks for exactly that: "the entry count is **not** restated here … a number
  repeated in prose goes stale the first time an entry lands".
- `niSteps` is published **only while the claim it supports is still true**. The
  page says every kernel step has its own non-interference proof, so
  `nonInterferenceCoverage()` checks the correspondence rather than comparing
  totals: each constructor of `NonInterferenceStep` must have a
  `nonInterference_perCore_<step>` theorem (a `…High` constructor pairs with
  the base-named theorem). A constructor with no proof fails the sync and names
  it. `niCrossCore` counts the SMP half by the kernel's own naming convention.
- `subsystems` carries the architecture diagram's per-layer figures — `{key:
  {modules, theorems}}` over the same corpus and the same declaration inventory
  as the headline counts. The layers live in one place, `SITE_SUBSYSTEMS` in
  `scripts/lib/canonical-map.mjs`; the markup addresses them as
  `data-live="subsystem.<key>.modules"`. Ten of the twelve original labels had
  gone stale (IPC read 52 files against 66, information flow 801 theorems
  against 1,680). `validate-data.mjs` rejects a snapshot key the page does not
  name, reconciles every layer against `map-data`'s graph, and
  `static-values.test.mjs` rejects a page span the snapshot cannot fill — so a
  diagram label cannot go back to being hand-written. A figure that is a *sum*
  of two layers (`462 theorems across Object (218) and State (244)`) is an
  entry with `namespaces` (plural) rather than a literal: a hard-coded total
  beside two live components contradicts them the first time either moves.
- `sourceAnchors` records where each deep link's declaration is written
  (`path → label → line`). Sixteen of the page's thirty-seven `#L` anchors
  pointed at unrelated code by 0.31.0. The sync reads the committed surfaces to
  learn which links exist — adding a link to the page is enough — resolves each
  label in the checkout and records the line; `apply-static-values.mjs` stamps
  it on both surfaces. A label it cannot place is **reported, never guessed**:
  a declaration that left its file is an editorial call (the link may belong
  somewhere else entirely), so fix the path by hand and let the next sync
  resolve it. See `scripts/lib/source-anchors.mjs`. A lookup matches only when
  the identifier **ends** the declared name: a trailing `\b` is satisfied by
  the dot in `def Foo.bar`, so asking for `Foo` silently took that member's
  line instead of reporting the link. Comments are stripped first, line for
  line (`stripLeanComments` / `stripRustCommentsAndStrings`, both of which
  preserve line numbers): a declaration that moves away often leaves its name
  in a doc-comment example shaped exactly like a header, and stamping that
  line publishes a wrong anchor that looks resolved.
- **An anchored link names the commit its line belongs to**, recorded as
  `sourceAnchorRef` and written into the href in place of `main`. A line number
  against a branch is a line number on a moving target: the unpinned sync falls
  back to the artifact's generation commit when upstream has committed Lean
  changes without regenerating the artifact, and a line resolved there is not a
  line on `main`. Bare file and tree links still track `main` — only a link
  that carries a line carries a revision.
- **"All the syscalls have wrappers" is verified before it is published.**
  `syscalls` counts Lean `SyscallId` constructors and knows nothing about
  `sele4n-sys`, so on its own it would let a new Lean syscall land before its
  wrapper and have the next sync silently upgrade the claim; the prose it
  replaced said "27 of 30", which is the proof these surfaces lag each other.
  `assertSyscallWrapperCoverage()` folds case and separators (Lean
  `cspaceMint`, Rust `SyscallId::CSpaceMint`) and fails the sync naming any
  syscall the wrapper crate does not reference. Comments and string literals
  are stripped first: a syscall named only in a doc comment or an error
  message is not a wrapper. This is a **gate on publishing
  a figure, not a figure**: the landing page still states nothing the Rust
  inventory derives.
- **The `unsafe` claim is about an operation, not a block.** `sele4n-abi`
  declares `raw_syscall` twice — one per target, only one of which compiles —
  and the call site is itself an `unsafe` block, so the scanner counts two
  `unsafe fn` and two blocks while the kernel has exactly one unsafe
  *operation*, the `svc #0` `asm!`. Upstream's own comment says as much. Saying
  "one unsafe block" contradicted the counters the code map ships from the same
  revision; say "operation".
- Never write a metric into `index.html` or a locale by hand. Every literal copy
  is stamped by `scripts/apply-static-values.mjs`; `static-values.test.mjs`
  fails when the committed tree drifts.

### Locale files embed live metrics

`data-i18n-html` sets `el.innerHTML` wholesale, so each `locales/*.json` carries
its own copy of the `data-live` spans **and the numbers inside them**. They
silently drifted to `546` while `index.html` said `574`. Any change touching a
metric must run `apply-static-values.mjs`, and `index.html`, `data/` and
`locales/` must be committed together.

### Code map page structure (0.31.0)

`map.html` is **one section**, the production module workspace, and
`map-toolbar.test.mjs` asserts it is the only one. Through 0.30.0 it carried
two more — a Rust crate card grid and a repository file inventory — and both
are gone: the Rust codebase is navigated in the workspace itself, behind a
scope toggle. Production code is the subject in every scope.

#### A node states its path inside its own codebase

- The subject is the codebase, not the repository that holds it. A node's
  source line says where the file sits in **its own** codebase —
  `Kernel/API.lean`, `sele4n-types/src/error.rs` — because the repository-
  relative path the snapshot ships opens with the same segment on every node
  of a chart: every Lean label read `SeLe4n/…` and every Rust label `rust/…`,
  which is where the codebase sits in the repository and nothing about the
  file. The node's own title already names the library or the crate.
- **The label and the href are deliberately different strings.** Only the
  label is shortened; `moduleSourceLink()` builds the href from the full
  repository path, which is the only one GitHub resolves. The same holds for
  the Lean and Rust node tooltips' `path:` line, and for
  `declarationSourceHref()` / `symbolSourceHref()`, which are hrefs only.
- **The root comes from the data, never from a constant.** `codebaseRoot()`
  in `map.js` takes Rust's from the snapshot's `rust.root` (the workspace
  directory) and Lean's from the first component of the module name, which is
  the library root Lake compiles from — `SeLe4n.Kernel.API` is built from
  `SeLe4n/Kernel/API.lean`. Hard-coding `rust` or `SeLe4n` here would state a
  fact about the kernel's tree in this page's source.
- A path that does not sit under its codebase's root is left **exactly as it
  is** rather than guessed at: `Main.lean` is a Lean module at the repository
  root, and `isLeanModulePath` keeps it in the tree deliberately. Stripping a
  root down to an empty label is likewise refused.

#### Scope

- Three readings, chosen by the toolbar's radiogroup and carried in the URL as
  `scope=`: `lean` (Lean modules alone), `both` (the default — both languages
  with the boundary between them drawn) and `rust` (the Rust workspace alone).
  `SCOPES` and `DEFAULT_SCOPE` in `map.js` are the one place that says so, and
  the static markup must mark the same option active or the toggle flashes on
  boot — `map-toolbar.test.mjs` checks the two agree.
- Switching scope keeps the selected node when it survives the switch and falls
  back to that scope's own default when it does not. `DEFAULT_MODULE` is
  unchanged: every scope carrying Lean still opens on `SeLe4n.Kernel.API`.
- Node names come off the URL, so `sanitizeModuleName()` is a tight whitelist:
  `[A-Za-z0-9_.:-]` and nothing else. It had to widen for `::` and the hyphen a
  crate name may carry; never widen it further. Anything the runtime *builds*
  into a node name goes through `urlSafeNodeSegment()` first — the collision
  suffix for two Rust files with one name used to be `@` plus a slash-bearing
  path, which the whitelist rejects, so the node could be selected but not
  reloaded or shared.
- The enclosing-module lane on the Rust chart is a **chain**: root → … →
  parent → selected. Edging every ancestor straight to the centre said the
  crate root declares `sele4n-abi::args::cspace` when `args` does.
- Switching scope replaces a selection the new scope cannot show, and sets the
  replacement as `flowScrollTarget`. An empty target means "keep the scroll you
  had" on desktop, which left the fallback node off-screen after scrolling down
  a band and narrowing the scope.
- **A scope with no Lean offers no declarations to find.**
  `declarationSearchAvailable()` gates both `declarationSearchMatch()` and
  `declarationSearchMatches()`, so nothing unreachable is suggested or
  matched. The same applies to an exactly-typed **module**: `matchModule()`
  asks `nodeExists()`, not `state.moduleMap`. Three separate acceptance points
  had the scope-blind test, and each let the search control disagree with the
  chart. Refusing only the *selection* was not enough: every caller still
  overwrote the input, closed the suggestions and announced "Declaration: …",
  so the control claimed to show Lean content while the Rust chart stayed put.
  `selectDeclaration()` also reports whether it took the selection.
- A declaration only becomes the selection when `nodeExists()` accepts the
  module it resolves to — in `selectDeclaration()`, which the search field
  calls, as well as on the URL-restore path. `scope=rust` paired with a Lean
  declaration otherwise pulled the Lean module into the selection while the
  toggle and badge still read Rust. Both paths must use the scope-aware
  predicate; `state.moduleMap` is the Lean inventory whatever the scope.

#### The Lean chart

- The workspace opens on `SeLe4n.Kernel.API` whenever the URL carries no
  `module=`. `DEFAULT_MODULE` in `map.js` is the one place that says so;
  `defaultModuleName()` falls back to the first module only when the snapshot
  lacks the API module. A previous release opened on `Main` (the first
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
  reverted the first time. **The Rust chart reuses `computeFlowLayout()` and
  `createFlowSvg()` for exactly this reason** — never give it a layout of its
  own.
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

#### The Rust chart

- **A node is one production Rust source file**, addressed by the Rust module
  path that reaches it (`sele4n-abi::args::cspace`); a crate's library root is
  the bare crate name. A file records the `target` its module path is measured
  from, so a nested binary module (`src/bin/tool/helper.rs`, module path
  `helper`) hangs off that binary rather than off whichever library happens to
  exist alongside it. The parent index is keyed by **target and module path
  together**: two targets in one package can carry the same nested path
  (`src/args/cspace.rs` and `src/bin/tool/args/cspace.rs` both reach
  `args::cspace`), and a path-only index held one `args`. A target that is its own crate root — a binary, the
  build script — takes that target as a path segment
  (`sele4n-hal::bin::rw_lock_oracle`) and the node states which kind of target
  it is, so the segment is never read as a module of the library. Which target
  that is, Cargo says: `targetName` carries a declared target's manifest name
  (`[[bin]] name = "runner", path = "tool/entry.rs"` builds `runner`), because
  a nonconventional path has its identity written down nowhere else and
  `bin::tool_entry` addresses a target the manifest does not have — in the
  chart and in the shareable `module=` URL alike.
- **A file's address is the path it is declared under, not its pathname.**
  `modulePath` and `target` come from walking `mod` declarations out from each
  target root, breadth-first, first assignment winning (the shallower path, and
  at equal depth the earlier root — the library before its binaries). The two
  readings agree wherever Cargo's conventions are followed, and they agree
  across the whole current workspace; they part exactly where `#[path = "…"]`
  redirects a declaration. `#[path = "impl/foo.rs"] mod renamed;` compiles as
  `renamed`, so an `impl::foo` node names a module the crate does not have —
  and hangs it off a parent chain that does not exist either. A file nothing
  declares keeps the pathname derivation; it is listed, never drawn.
- **Neither test code nor unreachable files are nodes.** Production code is
  the map's subject, as the Lean scope leaves out `tests/` and
  `SeLe4n/Testing/`. A file no Cargo target reaches through `mod` declarations
  compiles into nothing; the scanner lists it (its text is real) and marks it
  `reachable: false`, and the graph leaves it out rather than presenting stale
  or generated source as part of the module tree. **Compilation reachability
  and export reachability are two sets** — everything exported is compiled,
  not everything compiled is exported (a file behind a private `mod`) — so
  `reachable` and `exported` are tracked apart and neither stands in for the
  other. Test-ness is a third: `role` reads the pathname and so calls
  `src/tests.rs` a module, while the common `#[cfg(test)] mod tests;` makes
  that file and everything it declares in turn test-only. `testOnly` is the
  flag that knows, and the graph excludes on it as well as on the role. The
  three conditions live in one predicate, `isProductionGraphFile` in
  `rust-analysis.mjs`; the runtime applies the same three and
  `map-runtime.test.mjs` holds the two to each other over the bundled
  snapshot, so `map-smoke.mjs` sizes its expectations from the predicate
  rather than from a number typed into it. The crate root's
  summary still names the crate's test surface, so nothing is hidden.
- Lanes: the module path that reaches the file (left), the modules it declares
  (right) and the crate's dependency context (below). A **leaf declares
  nothing**, so its right lane holds the modules its *parent* declares
  alongside it, with the edges drawn from that parent — never from the centre,
  which would assert a relation that does not exist.
- The sidebar's four Rust tabs are Types, Functions, Impls/Mods and Tests, the
  last holding every test item under a `test:` kind prefix. The remembered Rust
  group starts **unset** so a crate root, which declares only modules, does not
  open on an empty Types tab.
- A Rust kind is a keyword: `fn` reads `fn` in every locale. Only the "(test)"
  qualifier around it is prose.
- The sidebar's listing count and the snapshot's `productionItems` are two
  quantities — an `impl` block is listed but never counted. Keep them apart:
  the node summary quotes the snapshot's figure, the sidebar's stays inside the
  sidebar.

#### The Lean ↔ Rust boundary

- Two declarations are the same declaration when `toBridgeKey()` folds them to
  one key (snake case, `r#` stripped, anonymous names excluded). The Rust side
  contributes production items of a nameable kind that are **exported**, not
  merely `pub`: `impl` and `mod` are named after other things, and without the
  visibility filter `fn main` in a build script matches `Main.main`. `pub` is
  syntax; `exported` is reachability, and matching on syntax published
  boundary links for `sele4n-hal`'s `error_code::VM_FAULT` and
  `USER_EXCEPTION` — `pub` constants inside a private module, unreachable from
  outside the crate. The scanner emits `exported` on **every** item so its
  absence is a schema fact (a pre-flag snapshot, which falls back to
  visibility) rather than a value.
- **Direction comes from the Lean declaration's kind, not from the crate.** A
  Lean `opaque`/`axiom` has no Lean body, so a Rust `fn` of that name is its
  implementation and the kernel calls down (`implements`). Everything else is
  labelled as what it is: `invokes` (a user-space wrapper naming a Lean-
  implemented operation), `mirrors` (a HAL routine of the same name either side
  of the seam — not a call) and `shares` (a type or constant on both sides).
- **Each of the four relations gets its own band, its own colour and its own
  legend row.** `mirrors` was folded into `shared` and so was relabelled
  "definitions shared across the boundary", which is the opposite of what it
  means: two implementations of one contract, not one definition both sides
  hold.
- **Only `implements` and `invokes` are drawn with an arrowhead.**
  `BRIDGE_UNDIRECTED` is the one place that says so, and `drawFlowEdge()` omits
  `marker-end` for those relations. An arrow on a shared type asserts a call
  that does not happen.
- `RUST_CRATE_STRATUM` is the one editorial fact in the model, four entries
  restating what the crates' manifests say of themselves. It only ever decides
  how a matched **function** is labelled, never whether a pair exists, and a
  crate it does not name is "shared" — no direction rather than a guessed one.
  Never grow it into a heuristic over crate descriptions.
- Both readings index the same edge objects (`byLean` and `byRust` hold the
  same records), so the Lean view and the Rust view of one edge cannot drift
  apart. An edge **names** the declarations behind it rather than counting
  them: the names are the evidence.
- The band is what the combined scope adds. `bridgeBandsFor()` returns nothing
  in `lean` and `rust` scope, and the legend loses its boundary entries with
  it.

#### Chrome, localisation and data retention

- Generated labels are painted with `t()` at render time, and the first
  locale load dispatches no `sele4n:locale-changed` event. `setupLocaleReady()`
  registers on `sele4nI18n.onReady()` before anything paints, and the callback
  repaints once, only if a lookup fell back before the locale
  arrived (`paintedBeforeLocale`, set by `t()` itself). A non-English locale
  that landed after the bundled snapshot otherwise left every generated label
  in English; the probe holds the locale back to prove the repaint.
- **Every visible label in every chart goes through `t()`** — lane labels,
  budget-node affordances, the boundary band's rows, both legends. Each is
  looked up **once** and used for both the node's measurement and its painting:
  a translated label measured at its English width wraps wrongly. Node tooltips
  and the SVG `aria-label` summaries are still English; that is a known
  pre-existing surface, not a licence to add more.
- Count labels use plural families (`key_one` / `key_few` / `key_many` /
  `key_other`) resolved by `t(key, { count })`, and every number handed to
  `t()` or `formatCount()` is grouped by the active locale (`10,929`,
  `10 929`, `10.929`). Never hard-code a separator or a plural in a string.
- The Rust graph renders `map-data.json#rust` and derives nothing beyond the
  module tree and the boundary match. `rustUnsafeSummary()` reads `unsafe`
  (production) and `testUnsafe` apart: the node's headline is the production
  figure, the detail names the fn/impl/block counts, the item-level `allow`
  exception (`sele4n-abi`) and "+N in test code". Never show one total that
  mixes the two; a reverted build's "118 sites" was neither figure. The crate
  lint (`deniesUnsafe`) is a separate fact and never stands in for the counts.
- A target-scoped dependency table is stated under its cfg ("under
  cfg(loom)"), dev-dependencies as "test-only", build dependencies as
  "build-time"; only unconditional tables are "external". A dependency is
  navigable when it names a workspace member, whichever table it came from.
- A live refresh may carry no repository tree (the canonical artifact lists
  only Lean modules) and never carries a Rust inventory. `retainInventory()`
  keeps the previous tree and crates in that case and records the commit each
  was taken at, so the Rust half does not empty out on a networked visit. A
  tree refresh changes the Lean declarations, so `buildBridgeIndex()` must run
  again with it — and **before** `buildPairs()`, which stamps the header's
  Boundary Links from `state.bridge`. Rebuilding afterwards published a total
  one refresh behind the bands drawn from it.
- A canonical refresh names its revision as `repository.head.commit_sha`;
  `normalizeCanonicalPayload` adopts it as `commitSha`. Rust nodes link at
  `state.rustCommit` and Lean modules at `state.commitSha`
  (`nodeSourceRef()`), because the two halves can be a commit apart. When they
  are, `renderInventoryProvenance()` says so under the "Generated" stamp
  (`#map-inventory-note`, `map.inventory_retained`) — the header publishes Rust
  Modules and Boundary Links beside one timestamp, which otherwise reads as a
  single coherent snapshot. The note is hidden when the two agree.
- `node scripts/map-smoke.mjs` renders the page in headless Chromium and
  asserts the guarantees above (chart at 1:1 at 1200–1920 in **both** scopes,
  sidebar placement, the pinned sidebar at 720p, no sideways overflow, clean
  console, both themes, a Spanish deep link, a locale held back until after the
  snapshot paints, the scope toggle end to end, the boundary band's direction,
  crossing into the other language, a Rust deep link, tappable scope options on
  a phone, nothing clipped in the sidebar, and every node's source line reading
  inside its own codebase while its href keeps the repository path — read off
  the rendered anchor in both languages, since the two are different strings).
  `.github/workflows/ci.yml` runs
  it with the runner's Chrome on every push. A layout guarantee the docs make
  gets a probe assertion.

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
  An `unsafe` keyword that ends a line binds to the block, `fn` or `impl`
  that starts the next non-blank line (`let x = unsafe` / `{ … }`), so a site
  split across lines is still a site.
- **Test code is decided by the `cfg` predicate, not by the word `test`.**
  `cfgIsTestOnly` treats `cfg(test)` and `cfg(all(test, …))` as test-only, and
  `cfg(not(test))` and `cfg(any(test, feature = "…"))` as production, because
  those compile into production builds. `#[test]` functions, everything inside
  a marked module or block, and every line of an integration-test file are
  test code. One three-valued evaluator (`evaluateCfg`) answers both questions
  the scanner asks of a predicate — is it test-only, does it hold in every
  production build — so the two cannot drift apart.
- **Target-scoped dependency tables stay separate.** `[target.'cfg(loom)'
  .dependencies]` is bundled as `targetDependencies: [{ cfg, table, names }]`,
  never as an external dependency: the HAL's `loom` enters no ordinary build.
- **A target is named by its manifest, not by its path.** `cargoTargets` is
  the one place that says so: alongside the roots it returns `names`, each
  binary and test root mapped to what Cargo builds it under — a conventional
  path names itself (`src/bin/x.rs` and `src/bin/x/main.rs` both build `x`,
  `src/main.rs` the package), and a declared target carries its manifest
  `name`, applied last so it overrides the path it also claims.
- **`deniesUnsafe` is read from the crate root only**: the library root
  (`[lib] path`, else `src/lib.rs`) or, for a package without one, its first
  binary root — `src/main.rs`, a `[[bin]] path`, or a conventional
  `src/bin/<name>.rs` / `src/bin/<name>/main.rs` target, in that order;
  `autobins = false` turns the conventional binaries off, `src/main.rs`
  included, and `autolib = false` the conventional library. A `[[test]]`,
  `[[bench]]` or `[[example]]` path outside the conventional directories is
  test code. `cargoTargets` is the one place
  those rules live; roles and module paths follow from it, so a file nested
  under a directory-style binary is that binary's module, not a root. A lint
  in a `src/bin/*.rs` target speaks for that binary, not for the library.
  `crateDeniesUnsafe` parses the
  inner attributes' argument lists in order — `#![deny(dead_code,
  unsafe_code)]`, a multi-line list, `forbid`, and a `cfg_attr` whose
  predicate holds in every production build (`not(test)`) all count; `warn`
  does not, a feature- or target-conditional `cfg_attr` is no crate policy,
  and a later `allow` lifts a deny — never one exact spelling.
- **A dependency is internal by path, and listed by package identity.** Each
  member's manifest is read first; an entry is a workspace edge only when its
  `path` — its own, or the one it inherits through `[workspace.dependencies]`
  — resolves to a member's directory, which is the one way Cargo resolves a
  dependency to a member. Never compare the table key with directory names,
  and never match by package name alone: a renamed dependency and a member
  whose directory is not its name went external the first way, and a
  registry dependency that shares a member's name went internal the second.
  Every dependency list carries package identities (the `package` field when
  renamed, else the key).
  An `optional = true` entry is no unconditional edge: it is listed under
  `optionalDependencies` with the features that enable it
  (`enablingFeatures`: `dep:name`, `name`, `name/…`, or the implicit feature
  of the same name), and the strip draws nothing for it.
- **Manifests are read structurally.** `parseToml` reads the TOML subset
  Cargo uses (sub-tables, dotted keys, one-line and multi-line arrays, inline
  tables, three-quoted strings, comments) into an object and
  `parseCargoManifest` takes its facts from that; an entry written
  `{ workspace = true }` resolves through the root's `[workspace.dependencies]`.
  The line-shaped reader it replaced silently dropped a `[dependencies.foo]`
  sub-table, a dotted `foo.path = "…"` and a one-line `members = ["a", "b"]`.
  Packages are discovered at any depth under `rust/` (`crates/app` is a valid
  member path), ordered by `[workspace] members` with globs expanded
  (`crates/*`), then the packages the workspace does not list; build output
  under `target/` is skipped, and a package nested inside another owns its
  own files.
  A non-virtual workspace's root package (`rust/Cargo.toml` carrying
  `[package]`) is a member too, first in order, and owns the files no nested
  package does.
  Packages the workspace `exclude`s are left out, as Cargo leaves them out of
  the workspace, even when a member glob matches them.
- **An out-of-line test module is test code throughout.** `#[cfg(test)] mod
  tests;` resolves to `src/tests.rs` or `src/tests/mod.rs`
  (`childModuleFiles`, rustc's rule), that file is rescanned as test code, and
  so is every module it declares in turn. The file records it as `testOnly`,
  which is the only place that fact survives: `role` is read off the pathname
  and calls `src/tests.rs` a module, so a consumer filtering on the role alone
  puts test code on a production map.
- **`const _: () = assert!(…)` is anonymous**: neither listed nor counted. The
  first snapshot carried 37 items named `_`. A raw identifier (`fn r#match`)
  keeps its prefix as its name and resolves to the bare file name as a module.
- **Public means reachable.** `publicItems` counts `pub` items whose enclosing
  inline modules are all `pub` *and* whose file is reached through `pub mod`
  declarations from the crate root (`buildRustInventory` carries export
  status into out-of-line files alongside test status). A `#[macro_export]`
  macro is public wherever it sits.
  Export status starts at the target roots and travels only through `pub mod`
  declarations, so a file nothing declares — stale, generated input,
  `include!`d — is unreachable and its `pub` items are not public API.
- **Attributes bind by one rule at every depth.** An outer attribute binds to
  the next construct — an item at item scope, an associated method, a `use`,
  a statement — and the body that construct opens is a test region when the
  attribute is test-only. The binding is released by the `{` that opens the
  body, the `;` that ends the construct, the `,` that ends a field, a variant
  or a match arm, or the `}` that closes the enclosing body; an `=` completes
  the header only, so a test-only `const`/`static` keeps its status across a
  block initializer, and a `;`, `,` or `=` inside `(…)`, `[…]` or `<…>` ends
  nothing. An attribute may share its
  line with its declaration (`#[cfg(test)] mod tests {`). `#[test]`,
  `#[<path>::test]` and a test-only `cfg` mark tests; `#![cfg(test)]` at the
  top of a file or an inline module makes that whole scope test code. Three
  earlier scanners each bound attributes for one scope or one construct kind
  and misfiled `unsafe` sites for the others: never add a scope-specific
  flag again.
- **Module files follow rustc's rule in full.** `mod x;` resolves under the
  directory the declaring file owns, one level deeper per enclosing inline
  module (`mod outer { mod x; }` is `outer/x.rs`), or to the file a
  `#[path = "…"]` names; an inline `mod x { … }` names no file. A crate root
  (`src/lib.rs`, `src/main.rs`, a `src/bin/<name>.rs` or
  `src/bin/<name>/main.rs` binary, or a root the manifest declares) and a
  `mod.rs` own the directory they sit in; any other file, a directory-style
  binary's nested module included, owns a directory of its own name. Test and
  export status travel down that resolution (`childModuleFiles`).
  A test crate root (`tests/<name>.rs`, `tests/<name>/main.rs`, a declared
  `[[test]]` path) resolves `mod common;` beside itself, so
  `tests/common/mod.rs` is a module of the test crates, not a target.
- **The scanner's boundaries are designed, not gaps.** It reads declarations,
  not paths: `pub use` re-exports do not make a private module's items
  public; an `include!`d file is neither part of the including file nor
  reachable through a module declaration; macro-generated items are
  invisible; one declaration is read per line; `unsafe trait` declarations
  are not sites (the counters are `unsafe fn`, `unsafe impl` and `unsafe { …
  }`). Moving any of these changes published figures: it is a decision to
  state, not a patch to slip in.
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

### An override wins only the properties it names

Winning is per-declaration, not per-rule: a component rule that outranks a base
rule for `content` inherits everything the base rule declares and the component
does not. `.card ul li::before` painted an absolutely positioned 6px dot on
every list item inside a card, and the code map's whole workspace is one card.
The declaration sidebar's `pub` chip re-generated that pseudo-element with its
own text, colour and padding — and with the base rule's `position: absolute;
left: 0; top: 0.7rem; width: 6px; height: 6px` still live underneath, so the
word was painted across the row's corner, over the name, in a box a fifth of
its size. The same rule was silently overriding the search listbox's inset and
its top margin. Nothing here was a specificity failure; the chip rule outranked
the bullet everywhere it spoke.

- A base rule written as a **descendant** selector (`.card ul li`) reaches into
  every component nested inside it. If it describes prose, scope it to the
  prose: `.card > ul > li` keeps a card's own list and stops at the first
  widget that happens to be a list. Undoing it per widget, property by
  property, is the state that breaks — the next property is always the one
  nobody named.
- A component that wants a box of its own should state the box: a chip's
  padding and its text are not a size if something upstream still says
  `width: 6px`.
- Generated content contributes nothing to `scrollHeight`, so an overflow
  check over the row will not see it. A probe for a chip has to measure the
  chip (`getComputedStyle(el, '::before')`) — `map-smoke.mjs` now does.

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
| Map scope toggle + Rust graph + boundary | `assets/js/map.js` |
| Map browser smoke probe | `scripts/map-smoke.mjs` |
| Landing page smoke probe | `scripts/index-smoke.mjs` |
| Continuous integration | `.github/workflows/ci.yml` |
| Map controls/layout/sections | `map.html`, `assets/css/map.css` |
| Landing page metrics | `assets/js/site.js`, `index.html` |
| Navigation behavior | `assets/js/header-nav.js` |
| Theme switching | `assets/js/theme-init.js` |
| Static fallback sync | `scripts/apply-static-values.mjs`, `scripts/lib/static-values.mjs` |
| Deep-link line anchors | `scripts/lib/source-anchors.mjs` |
| Per-subsystem figures | `SITE_SUBSYSTEMS` in `scripts/lib/canonical-map.mjs` |
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
