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
```

## Runtime data strategy

The site is intentionally local-first:

1. Load bundled snapshot from `data/*.json`.
2. Optionally hydrate from browser cache if newer.
3. Attempt live refresh from GitHub.
4. Fall back to bundled/cached values on fetch failure.

This keeps rendering deterministic while still allowing low-latency live updates.

## Code map interior symbol links

The code map interior panel links declarations directly to source in `hatter6822/seLe4n`:

- Parses theorem-style declarations (`theorem`, `lemma`)
- Parses function-style declarations (`def`, `abbrev`, `opaque`, `instance`)
- Populates all interior declaration groupings used by the UI (`Object kinds`, `Extension kinds`, `Context/Init kinds`)
- Defaults each interior kind selector to `All kinds (N)` so Object/Extension/Context-Init scrollboxes open with complete group coverage
- Includes declaration line metadata for line-accurate blob anchors
- Normalizes legacy symbol payload variants (`byKind`/`by_kind`, `constant`/`constants`) so flow-chart selection updates the interior declaration panels reliably
- Supports declaration-centric canonical payloads (`modules[].declarations`) and derives theorem totals/import graphs when explicit aggregates are omitted

## Documentation index

- [Architecture audit and growth plan](docs/ARCHITECTURE.md)
- [Codebase map end-to-end guide](docs/CODEBASE_MAP.md)
- [Testing and validation matrix](docs/TESTING.md)
- [Contributing guide](CONTRIBUTING.md)

## Third-party notices

This repository includes a third-party simplex-noise implementation used in `assets/js/background-pattern.js`.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution and license text.

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0). See [LICENSE](LICENSE) for details.
