# seLe4n Website

Static site for **seLe4n**, including a marketing homepage and an interactive architecture/codebase map.

## Current website release

- Website version: `0.1.0`
- Lean toolchain target: `4.28.0`

## Repository layout

- `index.html`: main marketing page
- `map.html`: interactive codebase map
- `assets/css/`: shared and page-specific styles
- `assets/js/`: runtime scripts (theme, site, map, background)
- `data/`: bundled snapshots consumed at runtime
- `scripts/`: sync, validation, and parser utilities
- `docs/`: architecture and map implementation documentation

## Local development workflow

### 1) Refresh bundled data snapshots

```bash
node scripts/sync-site-data.mjs
node scripts/sync-map-data.mjs
```

### 2) Validate snapshots

```bash
node scripts/validate-data.mjs
```

### 3) Run parser regression tests

```bash
node scripts/lib/lean-analysis.test.mjs
node scripts/lib/data-validation.test.mjs
node scripts/lib/map-runtime.test.mjs
node scripts/lib/map-toolbar.test.mjs
```

## Runtime data strategy

The site is intentionally local-first:

1. Load bundled snapshot from `data/*.json`.
2. Optionally hydrate from browser cache if newer.
3. Attempt live refresh from GitHub.
4. Fall back to bundled/cached values on fetch failure.

This keeps rendering deterministic while still allowing low-latency live updates.

## Code map interior symbol links

The map flowchart now renders its legend in the chart’s upper-right corner so semantic meaning stays attached to the graph during interaction and screenshots while preserving workspace for core flow nodes.

The code map interior panel links declarations directly to source in `hatter6822/seLe4n`:

- Parses theorem-style declarations (`theorem`, `lemma`)
- Parses function-style declarations (`def`, `abbrev`, `opaque`, `instance`)
- Populates all interior declaration groupings used by the UI (`Objects`, `Contexts/Inits`, `Extensions`)
- Defaults each interior kind selector to `All (N)` so Object/Context-Init/Extension scrollboxes open with complete group coverage
- Color-codes interior kind selector options and declaration chips by declaration kind so the selector doubles as a visual key for list entries
- Sorts interior declaration results case-insensitively (including `All`) for stable alphabetical scanning
- Keeps the interior declaration filter input focused while typing, preserving caret position across panel rerenders so multi-character filters can be entered reliably
- Includes declaration line metadata for line-accurate blob anchors
- Normalizes legacy symbol payload variants (`byKind`/`by_kind`, `constant`/`constants`) so flow-chart selection updates the interior declaration panels reliably
- Supports declaration-centric canonical payloads (`modules[].declarations`) and derives theorem totals/import graphs when explicit aggregates are omitted
- Preserves declaration-level `called` relationships from upstream `docs/codebase_map.json` into a merged call graph with precomputed reverse index, enabling declaration context navigation with O(1) caller lookups
- Clicking any declaration in the interior panel switches the flowchart to declaration context, showing outgoing calls and incoming callers with kind-colored nodes and chaining navigation; declarations with zero relationships display a centered node with an informative empty-state hint; lanes with more than 12 entries are sorted by module relevance (same-module first) before collapsing to show the first 10 with a "+N more" summary
- Breadcrumb navigation allows free bidirectional traversal between module and declaration contexts, with URL persistence via `decl` parameter and robust module resolution on data load
- Derives homepage theorem totals from declaration/symbol payloads in `docs/codebase_map.json` first, using top-level theorem aggregates only as a last-resort fallback

## Documentation index

- [Architecture audit and growth plan](docs/ARCHITECTURE.md)
- [Codebase map end-to-end guide](docs/CODEBASE_MAP.md)
- [Testing and validation matrix](docs/TESTING.md)
- [Developer guide (file-by-file orientation)](docs/DEVELOPER_GUIDE.md)
- [Contributing guide](CONTRIBUTING.md)
- [AI development guidance](CLAUDE.md)

## Third-party notices

This repository includes a third-party simplex-noise implementation used in `assets/js/background-pattern.js`.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution and license text.

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0). See [LICENSE](LICENSE) for details.
