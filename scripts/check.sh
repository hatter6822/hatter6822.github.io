#!/usr/bin/env bash
# Tiers 0-2: every unit test, the bundled-data validators and a syntax check
# of every runtime script. CI and the data-sync workflow both run this one
# script, so the job that pushes a regenerated snapshot cannot run fewer
# checks than the job that judges it afterwards (the sync job's hand-copied
# list had already lost the six `node --check` lines).
#
# Tests and scripts are discovered by glob: a new *.test.mjs or runtime file
# is covered the day it lands, without anyone remembering to list it here.
set -euo pipefail
cd "$(dirname "$0")/.."

for test in scripts/lib/*.test.mjs; do
  echo "::group::${test}"
  node "${test}"
  echo "::endgroup::"
done

node scripts/validate-data.mjs
node scripts/validate-traces.mjs

for file in assets/js/*.js; do
  node --check "${file}"
done

echo "Tiers 0-2 passed"
