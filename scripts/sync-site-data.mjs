#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const REPO = 'hatter6822/seLe4n';
const REF = 'main';
const API = `https://api.github.com/repos/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}/${REF}/`;
const OUT_FILE = new URL('../data/site-data.json', import.meta.url);

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function countTheorems(text) {
  const m = text.match(/(?:^|\n)\s*(?:private\s+|protected\s+)?theorem\s+/g);
  return m ? m.length : 0;
}

function parseCurrentStateMetrics(readmeText) {
  if (!readmeText) return {};

  const metrics = {};
  const rows = readmeText.split(/\r?\n/);

  for (const row of rows) {
    const cells = row.split('|').map((cell) => cell.trim());
    if (cells.length < 3) continue;

    const metric = cells[1]?.toLowerCase() ?? '';
    const value = cells[2] ?? '';

    if (metric.includes('version')) {
      const version = value.match(/\d+\.\d+\.\d+/);
      if (version) metrics.version = version[0];
    }

    if (metric.includes('production loc')) {
      const loc = value.match(/\d[\d,]*/);
      if (loc) metrics.lines = loc[0];
    }

    if (metric.includes('theorem')) {
      const theoremCount = value.match(/\d[\d,]*/);
      if (theoremCount) metrics.theorems = Number(theoremCount[0].replace(/,/g, ''));
    }

    if (metric.includes('build job')) {
      const buildJobs = value.match(/\d[\d,]*/);
      if (buildJobs) metrics.buildJobs = Number(buildJobs[0].replace(/,/g, ''));
    }
  }

  return metrics;
}

const data = JSON.parse(await readFile(OUT_FILE, 'utf8'));

const [toolchain, lakefile, readme, tree, langs, commit] = await Promise.all([
  fetchText(`${RAW}lean-toolchain`),
  fetchText(`${RAW}lakefile.toml`),
  fetchText(`${RAW}README.md`),
  fetchJson(`${API}/git/trees/${REF}?recursive=1`),
  fetchJson(`${API}/languages`),
  fetchJson(`${API}/commits/${REF}`)
]);

const toolchainMatch = toolchain.match(/(\d+\.\d+\.\d+)/);
if (toolchainMatch) data.leanVersion = toolchainMatch[1];

const versionMatch = lakefile.match(/version\s*=\s*"([^"]+)"/);
const currentStateMetrics = parseCurrentStateMetrics(readme);
if (currentStateMetrics.version) data.version = currentStateMetrics.version;
else if (versionMatch) data.version = versionMatch[1];

let modules = 0;
let scripts = 0;
let docs = 0;
let theoremCount = 0;
for (const item of tree.tree ?? []) {
  if (item.type !== 'blob') continue;
  const p = item.path;
  if (/^SeLe4n\/Kernel\/.*\.lean$/.test(p)) modules += 1;
  if (/^scripts\/.*\.sh$/.test(p)) scripts += 1;
  if (/^docs\/.*\.(md|txt)$/.test(p)) docs += 1;
}

const leanPaths = (tree.tree ?? [])
  .filter((item) => item.type === 'blob' && /^SeLe4n\/Kernel\/.*\.lean$/.test(item.path));

for (const item of leanPaths) {
  const blob = await fetchJson(`${API}/git/blobs/${item.sha}`);
  if (blob?.encoding !== 'base64' || !blob.content) continue;
  const content = Buffer.from(blob.content, 'base64').toString('utf8');
  theoremCount += countTheorems(content);
}

data.modules = modules;
data.scripts = scripts;
data.docs = docs;
if (typeof currentStateMetrics.buildJobs === 'number' && currentStateMetrics.buildJobs > 0) data.buildJobs = currentStateMetrics.buildJobs;
else data.buildJobs = modules * 2;

if (typeof currentStateMetrics.theorems === 'number' && currentStateMetrics.theorems > 0) data.theorems = currentStateMetrics.theorems;
else if (theoremCount > 0) data.theorems = theoremCount;

if (currentStateMetrics.lines) data.lines = currentStateMetrics.lines;
else if (langs?.Lean) data.lines = formatNumber(Math.round(langs.Lean / 38));
if (commit?.sha) data.commitSha = commit.sha.slice(0, 7);
if (commit?.commit?.author?.date) data.updatedAt = commit.commit.author.date;
data.generatedAt = new Date().toISOString();

await writeFile(OUT_FILE, JSON.stringify(data, null, 2) + '\n');
console.log(`Updated ${new URL(OUT_FILE).pathname}`);
