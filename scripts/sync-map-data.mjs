#!/usr/bin/env node
import { writeFile, mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractImportTokens, extractInteriorCodeItems, theoremCount, INTERIOR_KIND_GROUPS } from './lib/lean-analysis.mjs';

const REPO = 'hatter6822/seLe4n';
const REF = 'main';
const OUT_FILE = new URL('../data/map-data.json', import.meta.url);

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

// ── Acquire the repository without per-file REST calls ─────────────────────
// The previous approach fetched one git blob per .lean file (~1 REST request
// each), which blows past the 60/hr anonymous rate limit on a repo this size.
// Instead, resolve the tip over the git protocol and pull a single source
// archive from codeload — neither consumes the REST core quota — then analyze
// the files locally with the same lean-analysis helpers. Net: 1 archive
// download, 0 REST calls, regardless of repository size.

function resolveSha() {
  const out = execFileSync('git', ['ls-remote', `https://github.com/${REPO}.git`, `refs/heads/${REF}`], { encoding: 'utf8' });
  const sha = (out.split(/\s+/)[0] || '').trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`could not resolve ${REPO}@${REF} (git ls-remote returned: ${JSON.stringify(out.slice(0, 80))})`);
  return sha;
}

async function downloadAndExtract(sha) {
  const work = await mkdtemp(join(tmpdir(), 'sele4n-sync-'));
  const tarPath = join(work, 'repo.tar.gz');
  const res = await fetch(`https://codeload.github.com/${REPO}/tar.gz/${sha}`);
  if (!res.ok) throw new Error(`archive download failed: HTTP ${res.status}`);
  await writeFile(tarPath, Buffer.from(await res.arrayBuffer()));
  const outDir = join(work, 'extracted');
  await mkdir(outDir);
  execFileSync('tar', ['xzf', tarPath, '-C', outDir]); // system tar handles long paths / all variants
  const entries = await readdir(outDir);               // a single {owner}-{repo}-{sha} dir
  if (entries.length !== 1) throw new Error(`unexpected archive layout: ${entries.join(', ')}`);
  return { work, root: join(outDir, entries[0]) };
}

async function walkFiles(root, rel = '') {
  const out = [];
  for (const ent of await readdir(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...await walkFiles(root, r));
    else if (ent.isFile()) out.push(r);
  }
  return out;
}

const commitSha = resolveSha();
const { work, root } = await downloadAndExtract(commitSha);

let output;
try {
  const files = (await walkFiles(root)).sort();
  const leanFiles = files.filter((p) => /^SeLe4n\/.*\.lean$/.test(p));
  const modules = leanFiles.map(moduleFromPath);

  const moduleMap = Object.create(null);
  const moduleMeta = Object.create(null);
  const importsTo = Object.create(null);
  const importsFrom = Object.create(null);
  const externalImportsFrom = Object.create(null);
  for (let i = 0; i < modules.length; i += 1) moduleMap[modules[i]] = leanFiles[i];

  for (const path of leanFiles) {
    const moduleName = moduleFromPath(path);
    let source;
    try {
      source = await readFile(join(root, path), 'utf8');
    } catch {
      importsFrom[moduleName] = [];
      externalImportsFrom[moduleName] = [];
      moduleMeta[moduleName] = { layer: classifyLayer(moduleName), kind: moduleKind(moduleName), base: moduleBase(moduleName), theorems: 0, symbols: emptySymbols() };
      continue;
    }

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
  }

  output = {
    files,
    modules,
    moduleMap,
    moduleMeta,
    importsTo,
    importsFrom,
    externalImportsFrom,
    commitSha,
    generatedAt: new Date().toISOString()
  };
} finally {
  await rm(work, { recursive: true, force: true });
}

await writeFile(OUT_FILE, JSON.stringify(output, null, 2) + '\n');
console.log(`Updated ${new URL(OUT_FILE).pathname} — ${output.modules.length} modules @ ${output.commitSha.slice(0, 7)} (1 archive download, 0 REST calls)`);
