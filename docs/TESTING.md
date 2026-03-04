# Testing Guide

## Current automated checks

### Unit tests
- `test/map-analysis.test.mjs`
- Runner: Node built-in `node:test`

Coverage includes:
- Lean path-to-module mapping behavior.
- Layer/kind/base classification helpers.
- Import token extraction across multiline import statements and comments.
- Symbol extraction + theorem counting with deduplication behavior.

## Run tests

```bash
node --test
```

## Recommended future additions

- Browser-level smoke tests for `index.html` and `map.html` with Playwright in CI.
- JSON schema validation for `data/site-data.json` and `data/map-data.json`.
- Performance regression check for map rendering with synthetic large graphs.
