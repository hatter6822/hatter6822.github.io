#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { siteMetricsFromCodebaseMap } from './lib/lean-analysis.mjs';

const REPO = 'hatter6822/seLe4n';
const REF = 'main';
const API = `https://api.github.com/repos/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}/${REF}/`;
const OUT_FILE = new URL('../data/site-data.json', import.meta.url);

function apiHeaders() {
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: apiHeaders() });
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

let data;
try {
  data = JSON.parse(await readFile(OUT_FILE, 'utf8'));
} catch {
  data = {};
}

const [toolchain, tree, commit, codebaseMap] = await Promise.all([
  fetchText(`${RAW}lean-toolchain`),
  fetchJson(`${API}/git/trees/${REF}?recursive=1`),
  fetchJson(`${API}/commits/${REF}`),
  fetchJson(`${RAW}docs/codebase_map.json`)
]);

const toolchainMatch = toolchain.match(/(\d+\.\d+\.\d+)/);
if (toolchainMatch) data.leanVersion = toolchainMatch[1];

const canonicalMetrics = siteMetricsFromCodebaseMap(codebaseMap);
if (!canonicalMetrics.version || canonicalMetrics.lines === undefined || !canonicalMetrics.theorems || canonicalMetrics.modules === undefined) {
  throw new Error('docs/codebase_map.json is missing required landing-page metrics');
}

let scripts = 0;
let docs = 0;
for (const item of tree.tree ?? []) {
  if (item.type !== 'blob') continue;
  const p = item.path;
  if (/^scripts\/.*\.sh$/.test(p)) scripts += 1;
  if (/^docs\/.*\.(md|txt)$/.test(p)) docs += 1;
}

// Apply canonical values last. Repository-tree counts are retained only for
// secondary fields absent from older versions of the canonical schema.
Object.assign(data, canonicalMetrics);
data.lines = formatNumber(canonicalMetrics.lines);
if (canonicalMetrics.scripts === undefined) data.scripts = scripts;
if (canonicalMetrics.docs === undefined) data.docs = docs;
if (canonicalMetrics.buildJobs === undefined) data.buildJobs = canonicalMetrics.modules * 2;
if (commit?.sha) data.commitSha = commit.sha.slice(0, 7);
if (commit?.commit?.author?.date) data.updatedAt = commit.commit.author.date;
if (data.admitted === undefined) data.admitted = 0;
data.sourceRepo = REPO;
data.sourceRef = REF;
data.metricsSource = 'docs/codebase_map.json';
data.generatedAt = new Date().toISOString();

await writeFile(OUT_FILE, JSON.stringify(data, null, 2) + '\n');
console.log(`Updated ${new URL(OUT_FILE).pathname}`);
