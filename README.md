# seLe4n Website

Static marketing website for **seLe4n**, plus an interactive Lean codebase map.

## Repository architecture

```text
.
├── assets/
│   ├── css/                  # Site and codemap stylesheets
│   └── js/                   # Runtime browser scripts
├── data/                     # Bundled deterministic snapshots
├── docs/                     # Architecture, audits, and maintenance guides
├── scripts/
│   ├── lib/                  # Shared analysis logic (imported by scripts + tests)
│   ├── sync-map-data.mjs     # Builds data/map-data.json from GitHub API
│   └── sync-site-data.mjs    # Builds data/site-data.json from GitHub API
├── tests/                    # Node test suite for sync/parsing logic
├── index.html                # Main landing page
└── map.html                  # Interactive architecture/code map page
```

## Data synchronization pipeline

Both pages are designed to be deterministic first and live-synced second:

1. `data/site-data.json` and `data/map-data.json` are loaded as the baseline.
2. Browser runtime optionally refreshes from GitHub APIs.
3. Local cache is used only as an optimization layer and is revalidated.

Refresh baseline data from `hatter6822/seLe4n` with:

```bash
node scripts/sync-site-data.mjs
node scripts/sync-map-data.mjs
```

Commit any updated files under `data/` after a sync.

## Testing

Run parser and metrics regression tests:

```bash
npm test
```

These tests protect the most failure-prone portions of the system:

- Lean import extraction and multiline parsing.
- Symbol/theorem extraction for map metadata.
- README metrics parsing for site snapshot generation.

## Documentation map

- `docs/ARCHITECTURE_AUDIT.md` — findings, risks, and growth plan.
- `docs/MAP_PAGE_OPTIMIZATION.md` — end-to-end map page design and optimization notes.
- `LICENSE-AUDIT.md` and `THIRD_PARTY_NOTICES.md` — legal/compliance context.

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0). See [LICENSE](LICENSE).
