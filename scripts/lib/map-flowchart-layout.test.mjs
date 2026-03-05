import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

async function read(relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), 'utf8');
}

test('flowchart renderer does not append deprecated insight-row or summary blocks', async () => {
  const mapJs = await read('assets/js/map.js');
  assert.equal(mapJs.includes('flowchart-insight-row'), false, 'map runtime should not render insight row badges');
  assert.equal(mapJs.includes('flowchart-summary'), false, 'map runtime should not render textual flow summary');
});

test('map stylesheet does not include deprecated flowchart summary/insight selectors', async () => {
  const mapCss = await read('assets/css/map.css');
  assert.equal(mapCss.includes('.flowchart-insight-row'), false, 'stylesheet should not define insight row style');
  assert.equal(mapCss.includes('.flowchart-insight'), false, 'stylesheet should not define insight chip style');
  assert.equal(mapCss.includes('.flowchart-summary'), false, 'stylesheet should not define flow summary style');
});
