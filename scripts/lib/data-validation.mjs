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

export function validateSiteDataObject(data) {
  const errors = [];
  if (!isObject(data)) return ['site-data.json: root must be an object'];

  const requiredString = ['version', 'leanVersion', 'lines', 'commitSha', 'generatedAt'];
  const requiredNumber = ['modules', 'theorems', 'scripts', 'docs', 'buildJobs', 'admitted'];

  for (const key of requiredString) {
    if (typeof data[key] !== 'string') errors.push(`site-data.json: expected string at ${key}`);
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

export function validateCrossFile(siteData, mapData) {
  const errors = [];
  if (!isObject(siteData) || !isObject(mapData)) return errors;

  if (typeof siteData.generatedAt === 'string' && typeof mapData.generatedAt === 'string') {
    const siteDt = Date.parse(siteData.generatedAt);
    const mapDt = Date.parse(mapData.generatedAt);
    if (!Number.isNaN(siteDt) && !Number.isNaN(mapDt)) {
      const staleDays = Math.abs(siteDt - mapDt) / (1000 * 60 * 60 * 24);
      if (staleDays > 14) {
        errors.push(`cross-file: site-data and map-data generatedAt differ by ${Math.round(staleDays)} days — consider re-syncing`);
      }
    }
  }

  return errors;
}
