#!/usr/bin/env bash
# scripts/validate.sh — Local validation for the seLe4n website
#
# Checks site integrity without external dependencies (bash + python3 only).
# Run from the repository root:  bash scripts/validate.sh
set -euo pipefail

ERRORS=0
PASS=0

error() { echo "  FAIL  $1"; ERRORS=$((ERRORS + 1)); }
pass()  { echo "  PASS  $1"; PASS=$((PASS + 1)); }

echo "=== seLe4n Website Validation ==="
echo ""

# ── 1. Required files ────────────────────────────────────────────────
echo "--- Required files ---"
for f in index.html style.css background-pattern.js CNAME; do
  if [ -s "$f" ]; then
    pass "$f exists and has content"
  else
    error "$f is missing or empty"
  fi
done
# .nojekyll is intentionally empty — just check existence
if [ -f .nojekyll ]; then
  pass ".nojekyll exists"
else
  error ".nojekyll is missing"
fi

# ── 2. HTML structure ────────────────────────────────────────────────
echo ""
echo "--- HTML structure ---"

if grep -q '<!DOCTYPE html>' index.html; then
  pass "DOCTYPE declaration present"
else
  error "Missing DOCTYPE declaration"
fi

if grep -q '<html lang=' index.html; then
  pass "HTML lang attribute set"
else
  error "Missing lang attribute on <html>"
fi

if grep -q '<meta charset=' index.html; then
  pass "Meta charset declared"
else
  error "Missing meta charset"
fi

if grep -q '<meta name="viewport"' index.html; then
  pass "Viewport meta tag present"
else
  error "Missing viewport meta tag"
fi

if grep -q '<meta name="description"' index.html; then
  pass "Meta description present"
else
  error "Missing meta description"
fi

# ── 3. Data-live fallback values ─────────────────────────────────────
echo ""
echo "--- Data-live fallback values ---"

EMPTY_FALLBACKS=$(grep -cP 'data-live="[^"]+"><' index.html || true)
if [ "$EMPTY_FALLBACKS" -eq 0 ]; then
  pass "All data-live elements have non-empty fallback values"
else
  error "${EMPTY_FALLBACKS} data-live element(s) have empty fallback values"
  grep -nP 'data-live="[^"]+"><' index.html | while read -r line; do
    echo "       -> $line"
  done
fi

# Verify expected data-live keys exist
EXPECTED_KEYS="version lean-version theorems modules lines scripts docs build-jobs"
for key in $EXPECTED_KEYS; do
  if grep -qP "data-live=\"${key}\"" index.html; then
    pass "data-live=\"${key}\" element found"
  else
    error "Missing data-live=\"${key}\" element"
  fi
done

# ── 4. Internal anchor links ─────────────────────────────────────────
echo ""
echo "--- Internal anchor links ---"

BROKEN_ANCHORS=0
while IFS= read -r href; do
  id="${href#\#}"
  if ! grep -q "id=\"${id}\"" index.html; then
    error "Broken anchor: #${id} (no element with id=\"${id}\")"
    BROKEN_ANCHORS=$((BROKEN_ANCHORS + 1))
  fi
done < <(grep -oP 'href="#\K[^"]+' index.html | sort -u)

if [ "$BROKEN_ANCHORS" -eq 0 ]; then
  pass "All internal anchor links resolve"
fi

# ── 5. JSON-LD validity ──────────────────────────────────────────────
echo ""
echo "--- JSON-LD schema ---"

if python3 -c "
import json, re
with open('index.html') as f:
    html = f.read()
m = re.search(r'<script type=\"application/ld\+json\">(.*?)</script>', html, re.DOTALL)
if not m:
    raise ValueError('No JSON-LD block found')
data = json.loads(m.group(1))
assert '@context' in data, 'Missing @context'
assert 'name' in data, 'Missing name'
assert 'version' in data, 'Missing version'
" 2>/dev/null; then
  pass "JSON-LD schema is valid and contains required fields"
else
  error "JSON-LD schema is invalid or missing required fields"
fi

# ── 6. CSS/JS file references ────────────────────────────────────────
echo ""
echo "--- Asset references ---"

# CSS files referenced by index.html
while IFS= read -r ref; do
  if [ -f "$ref" ]; then
    pass "Referenced CSS exists: $ref"
  else
    error "Missing CSS file: $ref"
  fi
done < <(grep -oP 'href="\K[^"]+\.css' index.html || true)

# JS files referenced by index.html (local only, skip external URLs)
while IFS= read -r ref; do
  if [ -f "$ref" ]; then
    pass "Referenced JS exists: $ref"
  else
    error "Missing JS file: $ref"
  fi
done < <(grep -oP 'src="\K[^"]+\.js' index.html | grep -v '^https\?://' || true)

# ── 7. GitHub Actions workflow structure ─────────────────────────────
echo ""
echo "--- GitHub Actions workflows ---"

for wf in .github/workflows/*.yml; do
  if [ ! -f "$wf" ]; then
    continue
  fi
  # Basic structure check: must contain name, on, and jobs keys
  if grep -q '^name:' "$wf" && grep -q '^on:' "$wf" && grep -q '^jobs:' "$wf"; then
    pass "Workflow structure valid: $wf"
  else
    error "Workflow missing required keys (name/on/jobs): $wf"
  fi
  # Check for common YAML issues: tabs instead of spaces
  if grep -qP '^\t' "$wf"; then
    error "Workflow uses tabs instead of spaces: $wf"
  else
    pass "Workflow uses spaces (no tabs): $wf"
  fi
done

# ── 8. CNAME value ───────────────────────────────────────────────────
echo ""
echo "--- Domain configuration ---"

CNAME_VALUE=$(cat CNAME 2>/dev/null | tr -d '[:space:]')
if [ "$CNAME_VALUE" = "sele4n.org" ]; then
  pass "CNAME correctly set to sele4n.org"
else
  error "CNAME value is '${CNAME_VALUE}', expected 'sele4n.org'"
fi

# ── 9. No sorry/axiom in website content ─────────────────────────────
echo ""
echo "--- Content integrity ---"

# The website claims "Zero sorry. Zero axiom." — verify the hero stats match
ADMITTED=$(grep -oP 'data-live="admitted">\K[^<]+' index.html || echo "?")
if [ "$ADMITTED" = "0" ]; then
  pass "Admitted proofs fallback is 0"
else
  error "Admitted proofs fallback is '${ADMITTED}', expected '0'"
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "=============================="
if [ "$ERRORS" -gt 0 ]; then
  echo "FAILED: $ERRORS error(s), $PASS check(s) passed"
  exit 1
fi
echo "ALL PASSED: $PASS check(s) passed, 0 errors"
