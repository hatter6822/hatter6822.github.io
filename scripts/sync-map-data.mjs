#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { classifyLayer, extractImportTokens, extractInteriorCodeItems, moduleBase, moduleFromPath, moduleKind, theoremCount } from './lib/map-analysis.mjs';

const REPO = 'hatter6822/seLe4n';
const REF = 'main';
const API = `https://api.github.com/repos/${REPO}`;
const OUT_FILE = new URL('../data/map-data.json', import.meta.url);
const FETCH_CONCURRENCY = 8;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function runInPool(items, worker) {
  let index = 0;
  async function runner() {
    if (index >= items.length) return;
    const current = index;
    index += 1;
    await worker(items[current]);
    await runner();
  }

  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, () => runner());
  await Promise.all(workers);
}

const [tree, commit] = await Promise.all([
  fetchJson(`${API}/git/trees/${REF}?recursive=1`),
  fetchJson(`${API}/commits/${REF}`)
]);

const files = [];
const leanFiles = [];
const leanShasByPath = Object.create(null);

for (const entry of tree.tree ?? []) {
  if (!entry || entry.type !== 'blob') continue;
  files.push(entry.path);
  if (/^SeLe4n\/.*\.lean$/.test(entry.path)) {
    leanFiles.push(entry.path);
    leanShasByPath[entry.path] = entry.sha || '';
  }
}

const modules = leanFiles.map(moduleFromPath);
const moduleMap = Object.create(null);
const moduleMeta = Object.create(null);
const importsTo = Object.create(null);
const importsFrom = Object.create(null);
const externalImportsFrom = Object.create(null);

for (let i = 0; i < modules.length; i += 1) moduleMap[modules[i]] = leanFiles[i];

await runInPool(leanFiles, async (path) => {
  const moduleName = moduleFromPath(path);
  const sha = leanShasByPath[path];

  if (!sha) {
    importsFrom[moduleName] = [];
    externalImportsFrom[moduleName] = [];
    moduleMeta[moduleName] = { layer: classifyLayer(moduleName), kind: moduleKind(moduleName), base: moduleBase(moduleName), theorems: 0, symbols: { theorems: [], functions: [] } };
    return;
  }

  const blob = await fetchJson(`${API}/git/blobs/${sha}`);
  if (blob?.encoding !== 'base64' || !blob.content) {
    importsFrom[moduleName] = [];
    externalImportsFrom[moduleName] = [];
    moduleMeta[moduleName] = { layer: classifyLayer(moduleName), kind: moduleKind(moduleName), base: moduleBase(moduleName), theorems: 0, symbols: { theorems: [], functions: [] } };
    return;
  }

  const source = Buffer.from(blob.content, 'base64').toString('utf8');
  const seenInternal = Object.create(null);
  const seenExternal = Object.create(null);
  const internal = [];
  const external = [];

  for (const token of extractImportTokens(source)) {
    if (moduleMap[token]) {
      if (!seenInternal[token]) {
        seenInternal[token] = true;
        internal.push(token);
      }
    } else if (!seenExternal[token]) {
      seenExternal[token] = true;
      external.push(token);
    }
  }

  importsFrom[moduleName] = internal;
  externalImportsFrom[moduleName] = external;
  for (const dep of internal) {
    if (!importsTo[dep]) importsTo[dep] = [];
    importsTo[dep].push(moduleName);
  }

  moduleMeta[moduleName] = {
    layer: classifyLayer(moduleName),
    kind: moduleKind(moduleName),
    base: moduleBase(moduleName),
    theorems: theoremCount(source),
    symbols: extractInteriorCodeItems(source)
  };
});

const output = {
  files,
  modules,
  moduleMap,
  moduleMeta,
  importsTo,
  importsFrom,
  externalImportsFrom,
  commitSha: commit?.sha || '',
  generatedAt: new Date().toISOString()
};

await writeFile(OUT_FILE, JSON.stringify(output, null, 2) + '\n');
console.log(`Updated ${new URL(OUT_FILE).pathname}`);
