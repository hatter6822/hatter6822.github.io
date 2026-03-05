#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { extractImportTokens, extractInteriorCodeItems, theoremCount, INTERIOR_KIND_GROUPS } from './lib/lean-analysis.mjs';

const REPO = 'hatter6822/seLe4n';
const REF = 'main';
const API = `https://api.github.com/repos/${REPO}`;
const OUT_FILE = new URL('../data/map-data.json', import.meta.url);
const FETCH_CONCURRENCY = 8;

const ALL_INTERIOR_KINDS = [
  ...INTERIOR_KIND_GROUPS.object,
  ...INTERIOR_KIND_GROUPS.extension,
  ...INTERIOR_KIND_GROUPS.contextInit
];

function emptySymbols() {
  const byKind = Object.create(null);
  for (const kind of ALL_INTERIOR_KINDS) byKind[kind] = [];
  return { byKind, theorems: [], functions: [] };
}

function moduleFromPath(path) {
  return path.replace(/\.lean$/, '').replace(/\//g, '.');
}

function classifyLayer(moduleName) {
  if (/\.Model\./.test(moduleName)) return 'model';
  if (/\.Kernel\./.test(moduleName)) return 'kernel';
  if (/\.Security\./.test(moduleName) || /\.IFC\./.test(moduleName)) return 'security';
  if (/\.Platform\./.test(moduleName) || /\.Hardware\./.test(moduleName)) return 'platform';
  return 'other';
}

function moduleKind(moduleName) {
  if (/\.Operations$/.test(moduleName)) return 'operations';
  if (/\.Invariant$/.test(moduleName)) return 'invariant';
  return 'other';
}

function moduleBase(moduleName) {
  return moduleName.replace(/\.(Operations|Invariant)$/, '');
}

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
    moduleMeta[moduleName] = { layer: classifyLayer(moduleName), kind: moduleKind(moduleName), base: moduleBase(moduleName), theorems: 0, symbols: emptySymbols() };
    return;
  }

  const blob = await fetchJson(`${API}/git/blobs/${sha}`);
  if (blob?.encoding !== 'base64' || !blob.content) {
    importsFrom[moduleName] = [];
    externalImportsFrom[moduleName] = [];
    moduleMeta[moduleName] = { layer: classifyLayer(moduleName), kind: moduleKind(moduleName), base: moduleBase(moduleName), theorems: 0, symbols: emptySymbols() };
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
