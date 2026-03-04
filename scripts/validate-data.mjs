#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
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
}

await validateSiteData();
await validateMapData();

if (!process.exitCode) {
  console.log('✅ Data files validated');
}
