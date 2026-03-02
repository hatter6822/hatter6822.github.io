# seLe4n Website

Source for [sele4n.org](https://sele4n.org) — the project website for
[seLe4n](https://github.com/hatter6822/seLe4n), a formally verified
micro-kernel written entirely in Lean 4.

## Structure

```
index.html              Main single-page website
style.css               All styling (dark/light themes, responsive)
background-pattern.js   WebGL fractal diamond background
CNAME                   Custom domain (sele4n.org)
.nojekyll               Disables Jekyll processing
scripts/validate.sh     Local site validation
.github/workflows/
  deploy.yml            GitHub Pages deployment
  validate.yml          PR validation (HTML checks, site integrity)
  sync-sele4n-data.yml  Automated data sync from seLe4n repo
```

## Local Development

Open `index.html` in a browser. No build step required.

For a local server with live reload:

```bash
npx serve .
```

## Validation

Run the local validation suite (requires bash + python3):

```bash
bash scripts/validate.sh
```

Run HTML validation (requires Node.js):

```bash
npx html-validate index.html
```

## CI/CD

Three GitHub Actions workflows manage the site:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **deploy.yml** | Push to `main` | Deploys to GitHub Pages via `actions/deploy-pages` |
| **validate.yml** | PRs, push to `main` | HTML validation + site integrity checks |
| **sync-sele4n-data.yml** | Weekly / `repository_dispatch` / manual | Syncs live statistics from the seLe4n repository |

### Data Sync

The sync workflow fetches live data from `hatter6822/seLe4n` and updates
the static fallback values in `index.html`. This keeps the website accurate
even when the client-side GitHub API fetch fails (rate limits, offline, etc.).

Synced fields: version, Lean toolchain, theorem count, module count, line
count, script count, doc count, and build jobs.

### Pages Deployment

The site uses the modern `actions/deploy-pages` workflow. To activate it,
set the GitHub Pages source to **GitHub Actions** in repository Settings >
Pages.

## Live Data

The website displays live statistics fetched client-side from the GitHub API
on page load (cached in `sessionStorage` for 30 minutes). Static fallback
values in the HTML ensure the site works without JavaScript or when API
calls fail.

Elements with `data-live="key"` attributes are updated dynamically:

| Key | Description |
|-----|-------------|
| `version` | seLe4n project version |
| `lean-version` | Lean 4 toolchain version |
| `theorems` | Total proven theorems |
| `modules` | Lean kernel modules |
| `lines` | Estimated lines of Lean code |
| `scripts` | Test/CI scripts |
| `docs` | Documentation files |
| `build-jobs` | Parallel build jobs |
| `admitted` | Admitted proofs (always 0) |

## License

GPLv3 — see the [seLe4n repository](https://github.com/hatter6822/seLe4n)
for full license text.
