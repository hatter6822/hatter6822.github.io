#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isValidSymbolEntry(entry) {
  if (typeof entry === 'string') return entry.length > 0;
  if (!isObject(entry)) return false;
  if (typeof entry.name !== 'string' || !entry.name.trim()) return false;
  if (entry.line !== undefined && (!Number.isInteger(entry.line) || entry.line < 0)) return false;
  return true;
}

async function validateSiteData() {
  const raw = await readFile(new URL('../data/site-data.json', import.meta.url), 'utf8');
  const data = JSON.parse(raw);

  const requiredString = ['version', 'leanVersion', 'lines', 'commitSha', 'generatedAt'];
  const requiredNumber = ['modules', 'theorems', 'scripts', 'docs', 'buildJobs', 'admitted'];

  for (const key of requiredString) {
    if (typeof data[key] !== 'string') fail(`site-data.json: expected string at ${key}`);
  }
  for (const key of requiredNumber) {
    if (typeof data[key] !== 'number' || Number.isNaN(data[key])) fail(`site-data.json: expected number at ${key}`);
  }
}

async function validateMapData() {
  const raw = await readFile(new URL('../data/map-data.json', import.meta.url), 'utf8');
  const data = JSON.parse(raw);

  if (!Array.isArray(data.files)) fail('map-data.json: files must be an array');
  if (!Array.isArray(data.modules)) fail('map-data.json: modules must be an array');
  if (!isObject(data.moduleMap)) fail('map-data.json: moduleMap must be an object');
  if (!isObject(data.moduleMeta)) fail('map-data.json: moduleMeta must be an object');
  if (!isObject(data.importsTo)) fail('map-data.json: importsTo must be an object');
  if (!isObject(data.importsFrom)) fail('map-data.json: importsFrom must be an object');
  if (!isObject(data.externalImportsFrom)) fail('map-data.json: externalImportsFrom must be an object');
  if (typeof data.commitSha !== 'string') fail('map-data.json: commitSha must be a string');
  if (typeof data.generatedAt !== 'string') fail('map-data.json: generatedAt must be a string');

  for (const moduleName of data.modules) {
    const meta = data.moduleMeta[moduleName];
    if (!meta) continue;
    if (!isObject(meta.symbols)) continue;

    for (const kind of ['theorems', 'functions']) {
      const entries = meta.symbols[kind];
      if (!Array.isArray(entries)) {
        fail(`map-data.json: moduleMeta.${moduleName}.symbols.${kind} must be an array`);
        continue;
      }
      for (const entry of entries) {
        if (!isValidSymbolEntry(entry)) {
          fail(`map-data.json: invalid symbol entry in moduleMeta.${moduleName}.symbols.${kind}`);
          break;
        }
      }
    }
  }
}

await validateSiteData();
await validateMapData();

if (!process.exitCode) {
  console.log('✅ Data files validated');
}
