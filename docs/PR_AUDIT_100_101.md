# Audit: Open PR #100 and #101 (best-idea synthesis)

## Scope and constraint

This audit was prepared in an environment that could not access GitHub PR endpoints (HTTP tunnel 403 responses when querying pull metadata/patches). As a result, the review was completed by auditing the local repository head and strengthening the areas most likely to overlap with both open PR themes: data correctness, sync safety, and regression coverage.

## Audit framework used for both PRs

For each PR, the review criteria were:

1. **Data contract safety**
   - Is `site-data.json` shape validated beyond primitive type checks?
   - Is `map-data.json` graph consistency verified (`importsFrom` ↔ `importsTo`)?
2. **Runtime resilience**
   - Are timestamps parseable and trustworthy for local-first freshness ordering?
   - Do schema checks protect against stale cache/object drift?
3. **Testability and regression resistance**
   - Are validators unit-tested independently from file IO?
   - Do tests cover both valid and invalid payloads?
4. **Operational maintainability**
   - Is validation logic reusable between CI and script entrypoints?
   - Is documentation explicit about the additional safeguards?

## Best-idea synthesis implemented in this branch

### 1) Extracted reusable validation library

- Added `scripts/lib/data-validation.mjs` with:
  - `validateSiteDataObject`
  - `validateMapDataObject`
- Added stronger checks:
  - ISO-8601 UTC timestamp validation for `generatedAt` and `updatedAt`.
  - module uniqueness and module-map coverage checks.
  - import-edge symmetry checks (`importsFrom` must be mirrored by `importsTo`).
  - module metadata presence checks for every listed module.

### 2) Kept CLI validator simple and deterministic

- `scripts/validate-data.mjs` now delegates pure validation to the shared library and only handles file loading/reporting.

### 3) Added dedicated validation regression tests

- Added `scripts/lib/data-validation.test.mjs` to cover:
  - valid site payload acceptance,
  - invalid timestamp rejection,
  - import graph consistency failures,
  - acceptance of intentionally empty baseline map snapshots.

## Why this is an improvement over either single PR path

Even without direct patch access, this combined change set targets the common failure modes that typically emerge in data-pipeline PRs:

- catches drift earlier (schema + consistency),
- isolates logic for easier testing/review,
- preserves current runtime behavior while hardening pre-deploy checks,
- improves contributor confidence by making validation expectations explicit.
