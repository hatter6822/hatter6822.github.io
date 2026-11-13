/**
 * Static guard for .github/workflows.
 *
 * The sync workflow pushes to the publishing branch on a schedule, so what it
 * may run, and with which credentials, is part of the site's security
 * posture. These are the properties a review would look for, held as tests so
 * a later edit cannot drop one unnoticed. The files are read as text: there
 * is no YAML parser in the repository and none is worth adding for this.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const DIR = new URL('../../.github/workflows/', import.meta.url);
const files = (await readdir(DIR)).filter((name) => /\.ya?ml$/.test(name));
const workflows = await Promise.all(files.map(async (name) => [name, await readFile(new URL(name, DIR), 'utf8')]));

/** The text of every `run:` block, comments included. */
function runBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!head) continue;
    const indent = head[1].length + (lines[i].trimStart().startsWith('- ') ? 2 : 0);
    const body = [head[2]];
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].search(/\S/) > indent)) {
      i += 1;
      body.push(lines[i]);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

test('there are workflows to check', () => {
  assert.ok(workflows.length >= 2, `found ${files.join(', ')}`);
});

for (const [name, text] of workflows) {
  test(`${name}: every action is pinned to a full commit`, () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(uses.length > 0);
    for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${ref} must name a 40-hex commit`);
  });

  test(`${name}: least privilege is declared, and write access only on the job that pushes`, () => {
    assert.match(text, /^permissions:\s*(\{\}|\n {2}contents: read\n)/m, 'a top-level permissions block, empty or read-only');
    const grants = [...text.matchAll(/^\s+([a-z-]+):\s*write\s*$/gm)].map((m) => m[1]);
    if (name === 'sync-sele4n-data.yml') assert.deepEqual(grants, ['contents']);
    else assert.deepEqual(grants, []);
    assert.doesNotMatch(text, /pull_request_target|workflow_run/, 'no trigger that runs untrusted code with repository credentials');
  });

  test(`${name}: no expression is spliced into a shell script`, () => {
    // ${{ … }} inside run: is substituted before the shell parses the script,
    // so anything an outsider can influence becomes code. Values reach a
    // script through env: instead.
    for (const block of runBlocks(text)) assert.doesNotMatch(block, /\$\{\{/, block.slice(0, 120));
  });

  test(`${name}: the checkout leaves no credential behind, and installs run no package scripts`, () => {
    const checkouts = text.match(/uses:\s*actions\/checkout@[^\n]*\n(?:\s+with:\n(?:\s+[\w-]+:.*\n)+)?/g) || [];
    assert.ok(checkouts.length > 0);
    for (const step of checkouts) assert.match(step, /persist-credentials:\s*false/, 'checkout must set persist-credentials: false');
    for (const line of text.split('\n').filter((l) => /\bnpm (install|ci|i)\b/.test(l) && !l.trim().startsWith('#'))) {
      assert.match(line, /--ignore-scripts/, line.trim());
      assert.match(line, /@\d+\.\d+\.\d+\b/, `${line.trim()} must pin an exact version`);
    }
  });

  test(`${name}: runs are bounded and serialized`, () => {
    assert.match(text, /^concurrency:\n {2}group:/m);
    assert.match(text, /^\s+timeout-minutes:\s*\d+/m);
  });
}

test('the sync workflow gates its push on the checks and the three probes', () => {
  const text = workflows.find(([name]) => name === 'sync-sele4n-data.yml')[1];
  const at = (needle) => {
    const index = text.indexOf(needle);
    assert.notEqual(index, -1, `${needle} is missing`);
    return index;
  };
  const push = at('push origin');
  for (const gate of ['./scripts/check.sh', 'scripts/index-smoke.mjs', 'scripts/map-smoke.mjs', 'scripts/run-smoke.mjs']) {
    assert.ok(at(gate) < push, `${gate} must run before the push`);
  }
  assert.equal((text.match(/\bgit\b[^\n]*\bpush\b|^\s*push origin/gm) || []).length, 1, 'one push');
  assert.doesNotMatch(text, /--force|-f\b.*push|push.*\s-f\b/, 'never a forced push');
  // The token is named only by the step that pushes.
  assert.equal((text.match(/github\.token|secrets\./g) || []).length, 1);
});
