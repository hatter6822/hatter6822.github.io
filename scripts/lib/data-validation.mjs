function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDateString(value) {
  if (typeof value !== 'string' || !value) return false;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return false;
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.test(value);
}

function isValidSymbolEntry(entry) {
  if (typeof entry === 'string') return entry.trim().length > 0;
  if (!isObject(entry)) return false;
  if (typeof entry.name !== 'string' || !entry.name.trim()) return false;
  if (entry.line !== undefined && (!Number.isInteger(entry.line) || entry.line < 0)) return false;
  return true;
}

/**
 * Provenance the snapshot must carry, and the exact value each must hold.
 *
 * These are the fields that make "this came from the canonical artifact" a
 * checkable claim rather than a comment. The landing page once shipped figures
 * derived from a README table and a bytes-per-line estimate while the schema
 * validated perfectly, because nothing asserted where the numbers came from.
 */
const REQUIRED_PROVENANCE = Object.freeze({
  sourceRepo: 'hatter6822/seLe4n',
  sourceRef: 'main',
  metricsSource: 'docs/codebase_map.json',
  // Production Lean only: theorems, lines and modules describe one corpus.
  metricsScope: 'production'
});

export function validateSiteDataObject(data) {
  const errors = [];
  if (!isObject(data)) return ['site-data.json: root must be an object'];

  const requiredString = [
    'version', 'leanVersion', 'lines', 'commitSha', 'generatedAt',
    'schemaVersion', 'sourceDigest'
  ];
  const requiredNumber = ['modules', 'theorems', 'scripts', 'docs', 'admitted'];

  for (const key of requiredString) {
    if (typeof data[key] !== 'string') errors.push(`site-data.json: expected string at ${key}`);
  }

  for (const [key, expected] of Object.entries(REQUIRED_PROVENANCE)) {
    if (data[key] !== expected) {
      errors.push(`site-data.json: ${key} must be ${JSON.stringify(expected)}, got ${JSON.stringify(data[key])}`);
    }
  }

  // `lines` is the one metric published pre-grouped, so the no-JS fallback and
  // the hydrated value render identically. Anything else means it was written
  // by something other than the sync script.
  if (typeof data.lines === 'string' && !/^\d{1,3}(?:,\d{3})*$/.test(data.lines)) {
    errors.push(`site-data.json: lines must be a comma-grouped integer, got ${JSON.stringify(data.lines)}`);
  }

  // The commit the statistics were measured at, from the artifact's own
  // repository.head — not whatever happened to be at the tip of the branch.
  if (typeof data.commitSha === 'string' && !/^[0-9a-f]{7,40}$/.test(data.commitSha)) {
    errors.push(`site-data.json: commitSha must be a hexadecimal commit id, got ${JSON.stringify(data.commitSha)}`);
  }

  if (typeof data.sourceDigest === 'string' && !/^[0-9a-f]{64}$/.test(data.sourceDigest)) {
    errors.push('site-data.json: sourceDigest must be the artifact\'s sha256 source digest');
  }
  for (const key of requiredNumber) {
    if (typeof data[key] !== 'number' || Number.isNaN(data[key])) {
      errors.push(`site-data.json: expected number at ${key}`);
    } else if (!Number.isInteger(data[key])) {
      errors.push(`site-data.json: expected integer at ${key}, got ${data[key]}`);
    } else if (data[key] < 0) {
      errors.push(`site-data.json: ${key} must be non-negative`);
    }
  }

  if (typeof data.generatedAt === 'string' && !isIsoDateString(data.generatedAt)) {
    errors.push('site-data.json: generatedAt must be an ISO-8601 UTC timestamp');
  }

  if (data.updatedAt !== undefined && data.updatedAt !== '' && !isIsoDateString(data.updatedAt)) {
    errors.push('site-data.json: updatedAt must be empty or an ISO-8601 UTC timestamp');
  }

  return errors;
}

export function validateMapDataObject(data) {
  const errors = [];
  if (!isObject(data)) return ['map-data.json: root must be an object'];

  if (!Array.isArray(data.files)) errors.push('map-data.json: files must be an array');
  if (!Array.isArray(data.modules)) errors.push('map-data.json: modules must be an array');
  if (!isObject(data.moduleMap)) errors.push('map-data.json: moduleMap must be an object');
  if (!isObject(data.moduleMeta)) errors.push('map-data.json: moduleMeta must be an object');
  if (!isObject(data.importsTo)) errors.push('map-data.json: importsTo must be an object');
  if (!isObject(data.importsFrom)) errors.push('map-data.json: importsFrom must be an object');
  if (!isObject(data.externalImportsFrom)) errors.push('map-data.json: externalImportsFrom must be an object');
  if (typeof data.commitSha !== 'string') errors.push('map-data.json: commitSha must be a string');
  if (typeof data.generatedAt !== 'string') errors.push('map-data.json: generatedAt must be a string');

  // Provenance, so validateCrossFile can prove both snapshots came from one
  // pipeline run rather than from two scripts that happened to agree.
  if (data.metricsSource !== REQUIRED_PROVENANCE.metricsSource) {
    errors.push(`map-data.json: metricsSource must be ${JSON.stringify(REQUIRED_PROVENANCE.metricsSource)}, got ${JSON.stringify(data.metricsSource)}`);
  }
  if (typeof data.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(data.sourceDigest)) {
    errors.push('map-data.json: sourceDigest must be the canonical artifact\'s sha256 source digest');
  }

  if (typeof data.generatedAt === 'string' && data.generatedAt && !isIsoDateString(data.generatedAt)) {
    errors.push('map-data.json: generatedAt must be empty or an ISO-8601 UTC timestamp');
  }

  if (!Array.isArray(data.modules)) return errors;

  const modulesSet = new Set();
  for (const moduleName of data.modules) {
    if (typeof moduleName !== 'string' || !moduleName.trim()) {
      errors.push('map-data.json: modules must contain non-empty strings');
      continue;
    }
    if (modulesSet.has(moduleName)) errors.push(`map-data.json: duplicate module ${moduleName}`);
    modulesSet.add(moduleName);
  }

  if (isObject(data.moduleMap)) {
    for (const moduleName of data.modules) {
      if (!(moduleName in data.moduleMap)) {
        errors.push(`map-data.json: moduleMap missing entry for ${moduleName}`);
      }
    }
  }

  if (isObject(data.importsFrom)) {
    for (const [moduleName, deps] of Object.entries(data.importsFrom)) {
      if (!modulesSet.has(moduleName)) errors.push(`map-data.json: importsFrom has unknown module ${moduleName}`);
      if (!Array.isArray(deps)) {
        errors.push(`map-data.json: importsFrom.${moduleName} must be an array`);
        continue;
      }

      for (const dep of deps) {
        if (!modulesSet.has(dep)) errors.push(`map-data.json: importsFrom.${moduleName} references unknown module ${dep}`);
        const reverse = data.importsTo?.[dep];
        if (!Array.isArray(reverse) || !reverse.includes(moduleName)) {
          errors.push(`map-data.json: importsTo.${dep} missing reverse edge to ${moduleName}`);
        }
      }
    }
  }

  if (isObject(data.moduleMeta)) {
    for (const moduleName of data.modules) {
      const meta = data.moduleMeta[moduleName];
      if (!isObject(meta)) {
        errors.push(`map-data.json: moduleMeta missing object for ${moduleName}`);
        continue;
      }

      if (!isObject(meta.symbols)) continue;

      for (const kind of ['theorems', 'functions']) {
        const entries = meta.symbols[kind];
        if (!Array.isArray(entries)) {
          errors.push(`map-data.json: moduleMeta.${moduleName}.symbols.${kind} must be an array`);
          continue;
        }
        for (const entry of entries) {
          if (!isValidSymbolEntry(entry)) {
            errors.push(`map-data.json: invalid symbol entry in moduleMeta.${moduleName}.symbols.${kind}`);
            break;
          }
        }
      }

      if (meta.symbols.byKind !== undefined) {
        if (!isObject(meta.symbols.byKind)) {
          errors.push(`map-data.json: moduleMeta.${moduleName}.symbols.byKind must be an object`);
        } else {
          for (const [kind, entries] of Object.entries(meta.symbols.byKind)) {
            if (!Array.isArray(entries)) {
              errors.push(`map-data.json: moduleMeta.${moduleName}.symbols.byKind.${kind} must be an array`);
              continue;
            }
            for (const entry of entries) {
              if (!isValidSymbolEntry(entry)) {
                errors.push(`map-data.json: invalid symbol entry in moduleMeta.${moduleName}.symbols.byKind.${kind}`);
                break;
              }
            }
          }
        }
      }
    }
  }

  if (isObject(data.moduleMeta)) {
    for (const key of Object.keys(data.moduleMeta)) {
      if (!modulesSet.has(key)) {
        errors.push(`map-data.json: moduleMeta contains orphaned entry ${key} not in modules array`);
      }
    }
  }

  return errors;
}

/**
 * Assert the bundled snapshots came out of one pipeline run.
 *
 * They used to be produced by separate scripts fetching upstream
 * independently, and they drifted: site-data was generated at one commit and
 * map-data at another, so the landing page and the code map quoted different
 * module and theorem counts for the same kernel. Both snapshots now record the
 * revision and the canonical source digest they were built from, which makes
 * "one pipeline" a property CI can check rather than a convention.
 */
export function validateCrossFile(siteData, mapData) {
  const errors = [];
  if (!isObject(siteData) || !isObject(mapData)) return errors;

  if (typeof siteData.commitSha === 'string' && typeof mapData.commitSha === 'string') {
    // site-data abbreviates the commit for display; map-data keeps it in full.
    if (!mapData.commitSha.startsWith(siteData.commitSha)) {
      errors.push(`cross-file: site-data commitSha ${siteData.commitSha} does not match map-data ${mapData.commitSha.slice(0, 7)} — re-run scripts/sync-upstream.mjs`);
    }
  }

  if (siteData.sourceDigest !== mapData.sourceDigest) {
    errors.push('cross-file: site-data and map-data record different canonical source digests — they were not built from one checkout');
  }

  if (siteData.metricsSource !== mapData.metricsSource) {
    errors.push('cross-file: site-data and map-data name different canonical metrics sources');
  }

  // The map graphs exactly the production corpus the landing page counts, so a
  // divergence here is the two pages disagreeing about the same kernel.
  if (Number.isInteger(siteData.modules) && Array.isArray(mapData.modules)
      && siteData.modules !== mapData.modules.length) {
    errors.push(`cross-file: site-data reports ${siteData.modules} modules but map-data graphs ${mapData.modules.length}`);
  }

  if (Number.isInteger(siteData.theorems) && isObject(mapData.moduleMeta)) {
    const mapped = Object.values(mapData.moduleMeta)
      .reduce((total, meta) => total + (isObject(meta) && Number.isInteger(meta.theorems) ? meta.theorems : 0), 0);
    if (mapped !== siteData.theorems) {
      errors.push(`cross-file: site-data reports ${siteData.theorems} theorems but map-data modules sum to ${mapped}`);
    }
  }

  return errors;
}
