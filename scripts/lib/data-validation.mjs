function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDateString(value) {
  if (typeof value !== 'string' || !value) return false;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return false;
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.test(value);
}

/**
 * Validate one module's declaration call graph.
 *
 * Beyond the shape, this asserts that every caller key is a declaration the
 * same module's `byKind` lists carry. The runtime looks a declaration up in one
 * and then the other — `declarationIndex` comes from `byKind`, `declarationGraph`
 * from `callGraph` — so a name that appears in only one silently yields a node
 * with no calls or a call lane with no navigable target. Both projections are
 * built from the same declaration in the same pass, which is what makes this
 * checkable rather than merely hoped for.
 */
function validateCallGraph(moduleName, symbols) {
  const errors = [];
  const graph = symbols.callGraph;
  const where = `map-data.json: moduleMeta.${moduleName}.symbols.callGraph`;

  if (!isObject(graph)) return [`${where} must be an object`];

  const declared = new Set();
  if (isObject(symbols.byKind)) {
    for (const entries of Object.values(symbols.byKind)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : entry?.name;
        if (typeof name === 'string' && name) declared.add(name);
      }
    }
  }

  for (const [caller, calls] of Object.entries(graph)) {
    if (!Array.isArray(calls) || !calls.length) {
      errors.push(`${where}.${caller} must be a non-empty array`);
      continue;
    }
    if (calls.some((target) => typeof target !== 'string' || !target.trim())) {
      errors.push(`${where}.${caller} must contain non-empty declaration names`);
    }
    if (declared.size && !declared.has(caller)) {
      errors.push(`${where}.${caller} is not a declaration in this module's symbol lists`);
    }
  }

  return errors;
}

const RUST_ITEM_KINDS = new Set(['fn', 'struct', 'enum', 'union', 'trait', 'type', 'const', 'static', 'mod', 'impl', 'macro']);
const RUST_FILE_ROLES = new Set(['lib', 'bin', 'build', 'test', 'module']);

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Validate the bundled Rust crate inventory (`map-data.json#rust`).
 *
 * The block is optional — a snapshot produced before the inventory existed, or
 * a live canonical refresh, carries none — but when present it must be
 * internally consistent and must describe files the snapshot's own `files`
 * inventory lists. The runtime renders the crates from this block alone, so a
 * crate pointing at a path outside the tree would render a link to nothing.
 */
function validateRustInventory(rust, files) {
  const errors = [];
  const where = 'map-data.json: rust';
  if (!isObject(rust)) return [`${where} must be an object`];
  if (!Array.isArray(rust.crates)) return [`${where}.crates must be an array`];
  if (!Array.isArray(rust.members)) errors.push(`${where}.members must be an array`);
  if (rust.workspaceManifest !== undefined && typeof rust.workspaceManifest !== 'string') {
    errors.push(`${where}.workspaceManifest must be a string`);
  }

  const knownFiles = new Set(Array.isArray(files) ? files : []);
  const seenNames = new Set();
  const crateNames = new Set(rust.crates.map((crate) => crate?.name).filter((name) => typeof name === 'string'));

  rust.crates.forEach((crate, index) => {
    const label = `${where}.crates[${index}]`;
    if (!isObject(crate)) { errors.push(`${label} must be an object`); return; }
    if (typeof crate.name !== 'string' || !crate.name.trim()) { errors.push(`${label}.name must be a non-empty string`); return; }
    if (seenNames.has(crate.name)) errors.push(`${label}: duplicate crate ${crate.name}`);
    seenNames.add(crate.name);

    if (typeof crate.path !== 'string' || !crate.path.trim()) errors.push(`${label}.path must be a non-empty string`);
    if (typeof crate.manifest !== 'string' || !crate.manifest.trim()) errors.push(`${label}.manifest must be a non-empty string`);
    else if (knownFiles.size && !knownFiles.has(crate.manifest)) errors.push(`${label}.manifest ${crate.manifest} is not in files[]`);

    for (const key of ['sourceFiles', 'lines', 'items', 'publicItems', 'testItems']) {
      if (!isNonNegativeInteger(crate[key])) errors.push(`${label}.${key} must be a non-negative integer`);
    }
    if (typeof crate.deniesUnsafe !== 'boolean') errors.push(`${label}.deniesUnsafe must be a boolean`);
    if (!isObject(crate.unsafe) || !['fns', 'impls', 'blocks'].every((key) => isNonNegativeInteger(crate.unsafe[key]))) {
      errors.push(`${label}.unsafe must carry integer fns/impls/blocks counts`);
    }
    for (const key of ['dependencies', 'internalDependencies', 'externalDependencies', 'devDependencies', 'buildDependencies', 'features']) {
      if (!Array.isArray(crate[key]) || crate[key].some((entry) => typeof entry !== 'string')) {
        errors.push(`${label}.${key} must be an array of strings`);
      }
    }
    if (Array.isArray(crate.internalDependencies)) {
      for (const dep of crate.internalDependencies) {
        if (!crateNames.has(dep)) errors.push(`${label}.internalDependencies names unknown crate ${dep}`);
      }
    }

    if (!Array.isArray(crate.files)) { errors.push(`${label}.files must be an array`); return; }
    if (isNonNegativeInteger(crate.sourceFiles) && crate.sourceFiles !== crate.files.length) {
      errors.push(`${label}.sourceFiles says ${crate.sourceFiles} but files[] has ${crate.files.length}`);
    }

    let itemTotal = 0;
    let publicTotal = 0;
    let testTotal = 0;
    let lineTotal = 0;
    let flaggedTotal = 0;
    crate.files.forEach((file, fileIndex) => {
      const fileLabel = `${label}.files[${fileIndex}]`;
      if (!isObject(file)) { errors.push(`${fileLabel} must be an object`); return; }
      if (typeof file.path !== 'string' || !file.path.trim()) { errors.push(`${fileLabel}.path must be a non-empty string`); return; }
      if (knownFiles.size && !knownFiles.has(file.path)) errors.push(`${fileLabel}.path ${file.path} is not in files[]`);
      if (typeof crate.path === 'string' && !file.path.startsWith(`${crate.path}/`)) {
        errors.push(`${fileLabel}.path ${file.path} lies outside crate ${crate.path}`);
      }
      if (typeof file.relativePath !== 'string') errors.push(`${fileLabel}.relativePath must be a string`);
      if (typeof file.modulePath !== 'string') errors.push(`${fileLabel}.modulePath must be a string`);
      if (!RUST_FILE_ROLES.has(file.role)) errors.push(`${fileLabel}.role ${JSON.stringify(file.role)} is not a known role`);
      for (const key of ['lines', 'publicItems', 'testItems']) {
        if (!isNonNegativeInteger(file[key])) errors.push(`${fileLabel}.${key} must be a non-negative integer`);
      }
      if (!Array.isArray(file.items)) { errors.push(`${fileLabel}.items must be an array`); return; }
      let flagged = 0;
      file.items.forEach((item, itemIndex) => {
        const itemLabel = `${fileLabel}.items[${itemIndex}]`;
        if (!isObject(item)) { errors.push(`${itemLabel} must be an object`); return; }
        if (!RUST_ITEM_KINDS.has(item.kind)) errors.push(`${itemLabel}.kind ${JSON.stringify(item.kind)} is not a known item kind`);
        if (typeof item.name !== 'string' || !item.name.trim()) errors.push(`${itemLabel}.name must be a non-empty string`);
        if (!Number.isInteger(item.line) || item.line < 1) errors.push(`${itemLabel}.line must be a positive integer`);
        if (typeof item.visibility !== 'string' || !/^(?:private|pub|pub\([^)]+\))$/.test(item.visibility)) {
          errors.push(`${itemLabel}.visibility ${JSON.stringify(item.visibility)} is not a visibility`);
        }
        if (item.test !== undefined && item.test !== true) errors.push(`${itemLabel}.test must be true when present`);
        if (item.test === true) flagged += 1;
      });
      // Test items are listed (behind a toggle) and flagged; the counts the
      // cards show must agree with the flags.
      if (isNonNegativeInteger(file.testItems) && file.testItems !== flagged) {
        errors.push(`${fileLabel}.testItems says ${file.testItems} but ${flagged} item(s) are flagged test`);
      }
      itemTotal += file.items.length - flagged;
      flaggedTotal += flagged;
      publicTotal += isNonNegativeInteger(file.publicItems) ? file.publicItems : 0;
      testTotal += isNonNegativeInteger(file.testItems) ? file.testItems : 0;
      lineTotal += isNonNegativeInteger(file.lines) ? file.lines : 0;
    });

    if (isNonNegativeInteger(crate.items) && crate.items !== itemTotal) errors.push(`${label}.items says ${crate.items} but files list ${itemTotal}`);
    if (isNonNegativeInteger(crate.testItems) && crate.testItems !== flaggedTotal) errors.push(`${label}.testItems says ${crate.testItems} but ${flaggedTotal} item(s) are flagged test`);
    if (isNonNegativeInteger(crate.publicItems) && crate.publicItems !== publicTotal) errors.push(`${label}.publicItems says ${crate.publicItems} but files sum to ${publicTotal}`);
    if (isNonNegativeInteger(crate.testItems) && crate.testItems !== testTotal) errors.push(`${label}.testItems says ${crate.testItems} but files sum to ${testTotal}`);
    if (isNonNegativeInteger(crate.lines) && crate.lines !== lineTotal) errors.push(`${label}.lines says ${crate.lines} but files sum to ${lineTotal}`);
  });

  return errors;
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
        continue;
      }
      // The map graphs exactly the published production scope: nothing under
      // tests/, and nothing from the in-tree testing framework.
      const path = String(data.moduleMap[moduleName] ?? '');
      if (path.startsWith('tests/') || path.startsWith('SeLe4n/Testing/')) {
        errors.push(`map-data.json: module ${moduleName} (${path}) lies outside the production scope`);
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
    let modulesWithCallGraph = 0;

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

      if (meta.symbols.callGraph !== undefined) {
        errors.push(...validateCallGraph(moduleName, meta.symbols));
        if (Object.keys(meta.symbols.callGraph || {}).length) modulesWithCallGraph += 1;
      }
    }

    // The declaration flowchart is driven entirely by these graphs. Without
    // them the map still renders modules and imports, so a regression that
    // dropped the field would be invisible until someone clicked a
    // declaration and got an empty lane.
    if (data.modules.length && !modulesWithCallGraph) {
      errors.push('map-data.json: no module carries symbols.callGraph — the declaration call graph is missing');
    }
  }

  if (isObject(data.moduleMeta)) {
    for (const key of Object.keys(data.moduleMeta)) {
      if (!modulesSet.has(key)) {
        errors.push(`map-data.json: moduleMeta contains orphaned entry ${key} not in modules array`);
      }
    }
  }

  if (data.rust !== undefined) errors.push(...validateRustInventory(data.rust, data.files));

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
