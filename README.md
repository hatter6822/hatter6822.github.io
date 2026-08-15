# seLe4n Website

Static site for **seLe4n**, including a marketing homepage and an interactive architecture/codebase map. Covers the Lean 4 kernel model, Rust syscall wrappers, and hardware platform bindings.

## Current website release

- Website version: `0.27.0`
- Lean toolchain target: `4.28.0`

## Repository layout

- `index.html`: main marketing page
- `map.html`: interactive codebase map
- `run.html`: Simulator — replay the kernel in action with the proven invariants
- `404.html`: not-found page served by GitHub Pages
- `robots.txt` / `sitemap.xml`: crawler policy and page inventory
- `assets/css/`: shared and page-specific styles
- `assets/js/`: runtime scripts (theme, site, map, run, background)
- `data/`: bundled snapshots consumed at runtime
- `scripts/`: sync, validation, and parser utilities
- `docs/`: architecture and map implementation documentation

## Local development workflow

### 1) Refresh bundled data snapshots

```bash
node scripts/sync-site-data.mjs
node scripts/sync-map-data.mjs
node scripts/sync-trace-data.mjs
node scripts/apply-static-values.mjs
```

`apply-static-values.mjs` rewrites the static fallback values in `index.html`
(the `data-live` spans, JSON-LD version, and snapshot timestamp) from
`data/site-data.json`, so the no-JS view matches the bundled snapshot. The
weekly `sync-sele4n-data.yml` workflow runs this same pipeline — the scripts
here are the single source of truth for every published metric. The sync
scripts send an `Authorization` header when a `GITHUB_TOKEN` environment
variable is present, which avoids anonymous API rate limits in CI.

### 2) Validate snapshots

```bash
node scripts/validate-data.mjs
node scripts/validate-traces.mjs
```

### 3) Run parser regression tests

```bash
node scripts/lib/lean-analysis.test.mjs
node scripts/lib/data-validation.test.mjs
node scripts/lib/map-runtime.test.mjs
node scripts/lib/map-toolbar.test.mjs
node scripts/lib/trace-analysis.test.mjs
node scripts/lib/run-runtime.test.mjs
node scripts/lib/csp-html.test.mjs
node scripts/lib/static-values.test.mjs
node scripts/lib/i18n-locales.test.mjs
```

## Runtime data strategy

The site is intentionally local-first:

1. Load bundled snapshot from `data/*.json`.
2. Optionally hydrate from browser cache if newer.
3. Attempt live refresh from GitHub.
4. Fall back to bundled/cached values on fetch failure.

This keeps rendering deterministic while still allowing low-latency live updates.

## Code map declaration context and interior explorer

The map flowchart renders its legend in the chart’s upper-right corner so semantic meaning stays attached to the graph during interaction and screenshots while preserving workspace for core flow nodes. Both module-context and declaration-context flowcharts share six extracted helpers (`createFlowSvg`, `createFlowLegend`, `flowLaneLabel`, `applyFlowScrollTarget`, `computeFlowLayout`, `buildFlowNodeGroup`) to eliminate duplication. Node heights are pre-computed during layout passes to avoid redundant recalculation. Flow nodes have smooth CSS transitions on hover and focus for polished visual feedback.

The code map interior panel supports declaration-first navigation:

- Parses theorem-style declarations (`theorem`, `lemma`)
- Parses function-style declarations (`def`, `abbrev`, `opaque`, `instance`)
- Populates all interior declaration groupings used by the UI (`Objects`, `Contexts/Inits`, `Extensions`)
- Defaults each interior kind selector to `All (N)` so Object/Context-Init/Extension scrollboxes open with complete group coverage
- Color-codes interior kind selector options and declaration chips by declaration kind with standardized `color-mix` saturation, smooth CSS transitions, and robust plural-kind fallback resolution so the selector doubles as a visual key for list entries
- Sorts interior declaration results case-insensitively (including `All`) for stable alphabetical scanning
- Keeps the interior declaration filter input focused while typing, preserving caret position across panel rerenders so multi-character filters can be entered reliably
- Includes declaration line metadata for line-accurate blob anchors
- Normalizes legacy symbol payload variants (`byKind`/`by_kind`, `constant`/`constants`) so flow-chart selection updates the interior declaration panels reliably
- Supports declaration-centric canonical payloads (`modules[].declarations`) and derives theorem totals/import graphs when explicit aggregates are omitted
- Preserves declaration-level `called` relationships from upstream `docs/codebase_map.json` into a merged call graph with precomputed reverse index and `declarationIndex` for O(1) caller and metadata lookups
- Clicking any declaration in the interior panel switches the flowchart to declaration context, showing outgoing calls and incoming callers with kind-colored nodes and chaining navigation; declarations with zero relationships display a centered node with an informative empty-state hint; lanes with more than 12 entries are sorted by module relevance (same-module first) before collapsing to show the first 10 with an interactive "+N more" expand button that fully expands the lane, with a "Return to Compact" button to collapse back; the currently selected declaration is highlighted in the interior menu
- Breadcrumb navigation (semantic `<nav>` with `aria-label`) allows free bidirectional traversal between module and declaration contexts, with URL persistence via `decl` parameter and robust module resolution on data load; the generalized context search bar displays `Module.Declaration` in dot-append format with dynamic label updates ("Context search — module" / "Context search — declaration") per context; `flowchart-wrap` `aria-label` updates dynamically per context; declaration flowchart preserves scroll position across re-renders; the Reset button returns from declaration context to module context
- The unified context search bar supports both module and declaration search using a dot-append approach (e.g., `SeLe4n.Kernel.API.apiInvariantBundle` resolves to `SeLe4n.Kernel.API`'s internal `apiInvariantBundle` declaration) via two complementary strategies: (1) progressive module-prefix resolution with declaration suffix matching, and (2) global cross-module search via a pre-built `declarationSearchList` index when no exact module prefix matches; when a declaration is selected via the context search, the flowchart automatically syncs to declaration context; results are ranked by exact/prefix/substring scoring and multiple suggestions appear as styled dropdown entries selectable via keyboard or mouse
- Derives homepage theorem totals from declaration/symbol payloads in `docs/codebase_map.json` first, using top-level theorem aggregates only as a last-resort fallback; deduplicates modules appearing in both `modules[]` and `moduleMeta` to prevent double-counting

## Simulator (kernel in action)

`run.html` is a proof-aware execution visualizer. Because every seLe4n transition is a
deterministic pure function with machine-checked invariants, the page can **replay**
real kernel execution traces step by step and show the proven invariants holding at
every transition. It offers seven switchable **scenes** — **System** (CPU, run queue,
IPC wait queues), **Scheduler** (per-core SMP columns, priority buckets, EDF deadlines, CBS budget bars),
**Capabilities** (the capability derivation tree, where minting derives children and a
strict revoke prunes a whole subtree), **Memory** (untyped regions with a watermark,
carving typed objects out of memory and reclaiming them on revoke), **VSpace** (page
mappings with W^X status, where a writable-and-executable map is rejected and a TLB row
shows cached translations being shot down on unmap), **Information
flow** (the security-domain lattice, where the kernel blocks a leak from secret to
public until an audited declassification authorizes it), and **Services** (the
dependency DAG with dependency-ordered start, fault, and restart). A transport bar
(play/step/scrub) drives the
timeline; an invariant rail links each machine-checked invariant back to its proof
module on `map.html`; and an opt-in, clearly-labeled **sandbox** lets you perturb the
state and watch a structural check break — illustrating exactly what the Lean proofs
forbid.

Trace data lives in `data/execution-traces.json` (a schema-versioned snapshot; the
bundled sample is a reference fixture until the upstream kernel emits the artifact
directly). The full design — schema, scenes, pipeline, and roadmap — is in
[docs/SIMULATOR_SPEC.md](docs/SIMULATOR_SPEC.md).

## Documentation index

- [Architecture audit and growth plan](docs/ARCHITECTURE.md)
- [Codebase map end-to-end guide](docs/CODEBASE_MAP.md)
- [Simulator design + trace schema](docs/SIMULATOR_SPEC.md)
- [Upstream trace export (kernel-side bridge)](docs/UPSTREAM_TRACE_EXPORT.md)
- [Testing and validation matrix](docs/TESTING.md)
- [Developer guide (file-by-file orientation)](docs/DEVELOPER_GUIDE.md)
- [Contributing guide](CONTRIBUTING.md)
- [AI development guidance](CLAUDE.md)

## Third-party notices

This repository currently bundles no third-party code.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the record of previously included code and its license text.

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0). See [LICENSE](LICENSE) for details.
