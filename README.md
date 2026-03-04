# seLe4n Website

Static marketing site + architecture codemap for **seLe4n**.

## Repository layout

```text
.
├── assets/
│   ├── css/
│   │   ├── style.css          # Main landing-page styles
│   │   └── map.css            # Codemap-page styles
│   └── js/
│       ├── site.js            # Landing-page behavior + live metrics
│       ├── map.js             # Codemap UI/runtime orchestration
│       ├── theme-init.js      # Early theme bootstrap to avoid flash
│       └── background-pattern.js
├── data/
│   ├── site-data.json         # Bundled landing-page metrics baseline
│   └── map-data.json          # Bundled codemap snapshot baseline
├── docs/
│   ├── ARCHITECTURE_AUDIT.md
│   ├── CODEBASE_MAP.md
│   └── TESTING.md
├── scripts/
│   ├── lib/
│   │   └── map-analysis.mjs   # Shared parser/classification helpers
│   ├── sync-site-data.mjs
│   └── sync-map-data.mjs
└── test/
    └── map-analysis.test.mjs
```

## Data synchronization

Refresh bundled snapshots from `hatter6822/seLe4n`:

```bash
node scripts/sync-site-data.mjs
node scripts/sync-map-data.mjs
```

Commit the updated files in `data/` after validation.

## Runtime consistency model

- Landing page reads `data/site-data.json` as baseline, then merges live repository metadata.
- Codemap page reads `data/map-data.json` first for deterministic startup, then optionally performs live refresh.
- If live calls fail, bundled data remains authoritative fallback.

## Testing

Run automated unit tests:

```bash
node --test
```

See [`docs/TESTING.md`](docs/TESTING.md) for coverage details and roadmap.

## Additional documentation

- [Architecture audit](docs/ARCHITECTURE_AUDIT.md)
- [Codemap end-to-end guide](docs/CODEBASE_MAP.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0). See [LICENSE](LICENSE) for details.
