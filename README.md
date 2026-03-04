# seLe4n Website

Static marketing site for **seLe4n**.

## Data synchronization

Live metrics are now sourced from `data/site-data.json` first, so desktop and mobile clients render the same baseline data.

The code map page can also be pre-synced through `data/map-data.json` for deterministic, low-latency rendering before live refresh.

To refresh those metrics from `hatter6822/seLe4n`:

```bash
node scripts/sync-site-data.mjs

node scripts/sync-map-data.mjs
```

Then commit the updated `data/site-data.json` file.

Then validate the bundled snapshots before committing:

```bash
node scripts/validate-data.mjs
```



## Code map interior symbol links

The code map interior panel now links each discovered declaration directly to its source in `hatter6822/seLe4n`.

- Function-style declarations (`def`, `abbrev`, `opaque`, and `instance`) and theorem-style declarations (`theorem`, `lemma`) are parsed with declaration line metadata.
- Each interior item link targets the exact GitHub blob line anchor (`#L<line>`), when line metadata is available.
- Legacy cached/bundled symbol payloads remain supported; older entries without line metadata are normalized and still rendered.

## Runtime data consistency

The browser now treats `data/site-data.json` as the canonical baseline on every refresh. Any cached values are immediately revalidated against the bundled file, then live repository metadata is merged in (version, Lean toolchain, LOC, theorem count, scripts/docs counts, kernel modules, build jobs, and latest commit metadata from `main`).

If any live fetch fails in the browser, the site continues to use bundled `data/site-data.json` values as fallback.


## Third-party notices

This repository includes a third-party simplex-noise implementation used in `background-pattern.js`.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution and license text.

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0). See [LICENSE](LICENSE) for details.
