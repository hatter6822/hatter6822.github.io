# Licensing Audit

Date: 2026-03-04
Repository: `hatter6822.github.io`

## Scope and method

This audit reviewed:
- Top-level legal files (`LICENSE`, `README.md`)
- HTML/CSS/JS sources and workflow/script files
- Known third-party markers (license strings, attributions, external CDNs/hosts)

Commands used:
- `find . -maxdepth 3 -type f`
- `rg -n "(cdn|unpkg|jsdelivr|license|copyright|@license|MIT|Apache|GPL|Leaflet|OpenStreetMap|font|icon|bootstrap|tailwind|jquery)" -S *.html *.js *.css map.* scripts/* data/* .github/workflows/*`
- manual file review (`sed -n ...`) for legal-relevant files

## Findings

### 1) Project-level license declaration is present and consistent

- `LICENSE` contains GNU GPL v3 text.
- `README.md` states GPL-3.0 and links to `LICENSE`.
- `index.html` structured data (`SoftwareSourceCode`) also declares GPL-3.0 URL.

Status: **Pass**

### 2) Third-party code attribution existed but was incomplete for redistribution

- `background-pattern.js` includes an in-source attribution line for Ashima Arts simplex noise under MIT.
- Prior to this audit, full MIT notice text was not present elsewhere in the repo.

Why this matters:
- MIT requires preserving copyright + permission notice in copies/substantial portions.
- A short attribution string alone can be insufficient for strict compliance when source is redistributed.

Remediation applied:
- Added `THIRD_PARTY_NOTICES.md` with full MIT notice text and upstream references.

Status: **Fixed**

### 3) Remote assets and APIs

- Site loads logo images from `raw.githubusercontent.com/hatter6822/seLe4n/...` and fetches GitHub API data.
- This is operationally acceptable, but organizations with strict compliance policies may require explicit provenance/rights documentation for externally hosted assets.

Recommendation:
- If formal compliance artifacts are required, add a short provenance note for externally hosted images (owner/repo/license) in `THIRD_PARTY_NOTICES.md`.

Status: **No blocking issue identified**, informational only.

## Conclusion

No critical licensing blockers were identified after adding third-party MIT notice text.

Residual risk is low and mainly procedural (documenting externally hosted image provenance if your policy requires it).
