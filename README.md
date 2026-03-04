# seLe4n Website

Static, security-hardened marketing and architecture-intelligence site for **seLe4n**.

## What this repository contains
- Landing page (`index.html`) with live project metrics.
- Code map page (`map.html`) for interactive Lean module exploration.
- Browser runtime scripts (`site.js`, `map.js`, `background-pattern.js`).
- Shared UI runtime helpers (`js/shared-ui.js`).
- Deterministic bundled snapshots under `data/`.
- Data synchronization scripts under `scripts/`.
- Parser utility layer under `scripts/lib/`.
- Unit tests under `tests/`.

## Architecture overview
See detailed architecture documentation in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Runtime model
1. Render bundled snapshot data from `data/site-data.json` or `data/map-data.json`.
2. Hydrate from local cache if cache is fresher.
3. Refresh from GitHub live APIs with timeout/error guards.
4. Persist normalized cache for future loads.

### Shared UI model
Shared page concerns are centralized in `js/shared-ui.js`:
- theme persistence and toggle
- mobile navigation behavior
- external link hardening

## Data synchronization
Refresh bundled data from the canonical `hatter6822/seLe4n` repository:

```bash
node scripts/sync-site-data.mjs
node scripts/sync-map-data.mjs
```

Then commit any changes in:
- `data/site-data.json`
- `data/map-data.json`

## Testing
Run parser and extraction tests:

```bash
node --test tests/parsers.test.mjs
```

## Audit and growth planning
A full audit report and growth-oriented refactor summary are available in:
- [`docs/AUDIT.md`](docs/AUDIT.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## Security notes
- Strict Content Security Policy defined per HTML entrypoint.
- External links are programmatically hardened with `noopener noreferrer`.
- API requests use explicit fetch options and timeout handling.

## Third-party notices
This repository includes a third-party simplex-noise implementation used in `background-pattern.js`.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution and license text.

## License
This project is licensed under the GNU General Public License v3.0 (GPL-3.0). See [LICENSE](LICENSE) for details.
