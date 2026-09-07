/**
 * Rust workspace analysis for the code map.
 *
 * The canonical `docs/codebase_map.json` inventories Lean declarations and
 * nothing else, so the map's view of the production Rust crates — the
 * user-space syscall wrappers and the bare-metal HAL — is projected here, from
 * the same verified checkout the Lean snapshot comes from. The pipeline calls
 * `buildRustInventory()` once per sync and bundles the result as
 * `map-data.json#rust`; the runtime renders it and derives nothing.
 *
 * The scanner is deliberately small. It is not a Rust parser: it recognises
 * item headers at the start of a logical line after comments and string
 * literals have been blanked, which is what the map needs to list a crate's
 * surface (functions, types, traits, constants, modules, impl blocks, macros)
 * with visibility and line anchors. Bodies are skipped by brace depth, so items
 * nested inside functions are not reported, but items inside inline `mod`
 * blocks are, with their `module` path recorded.
 *
 * `unsafe` is counted separately from items because it is the property the
 * crates advertise: three of the four declare `#![deny(unsafe_code)]`, and the
 * map shows that as a fact read from the sources rather than a claim copied
 * from a README.
 *
 * Test code — `#[test]` functions, anything under `#[cfg(test)]`, and every
 * item of an integration-test file — is listed with `test: true` so the map
 * can show it behind a per-crate toggle, and counted apart from the production
 * items so the cards' headline figures describe the production surface.
 */

export const RUST_ITEM_KINDS = Object.freeze([
  'fn', 'struct', 'enum', 'union', 'trait', 'type', 'const', 'static', 'mod', 'impl', 'macro'
]);

const ITEM_HEAD = new RegExp(
  '^(?:pub(?:\\((?:crate|super|self|in\\s+[A-Za-z0-9_:]+)\\))?\\s+)?' +
  '(?:default\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+(?:"[^"]*"\\s+)?)?' +
  // `\b` cannot follow `macro_rules!` (both sides are non-word characters),
  // so the keyword alternation carries its own boundary.
  '((?:fn|struct|enum|union|trait|type|const|static|mod|impl)\\b|macro_rules!)'
);

/**
 * Blank comments and string literals, preserving line structure.
 *
 * Line comments (`//`, `///`, `//!`) run to the end of the line. Block comments
 * nest in Rust, so depth is tracked. String literals — `"…"` with escapes,
 * raw strings `r#"…"#` with any number of hashes, byte strings `b"…"` — are
 * replaced with a placeholder so a brace or `fn` inside a string cannot be
 * mistaken for structure. Character literals are consumed as units, because
 * `'"'` would otherwise open a string; lifetimes (`'a`) share the quote but
 * have no closing one, so they pass through untouched.
 */
export function stripRustCommentsAndStrings(source) {
  const text = String(source ?? '');
  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') { depth += 1; i += 2; continue; }
        if (text[i] === '*' && text[i + 1] === '/') { depth -= 1; i += 2; continue; }
        if (text[i] === '\n') out += '\n';
        i += 1;
      }
      continue;
    }

    // Raw strings: r"…", r#"…"#, br"…", br##"…"##
    if ((ch === 'r' || (ch === 'b' && next === 'r')) && isRawStringStart(text, i)) {
      const start = ch === 'b' ? i + 2 : i + 1;
      let hashes = 0;
      while (text[start + hashes] === '#') hashes += 1;
      const closer = '"' + '#'.repeat(hashes);
      const bodyStart = start + hashes + 1;
      const end = text.indexOf(closer, bodyStart);
      const stop = end === -1 ? n : end + closer.length;
      out += '""';
      for (let k = i; k < stop; k += 1) if (text[k] === '\n') out += '\n';
      i = stop;
      continue;
    }

    // Character and byte literals: 'x', '\n', '\'', '\u{1F600}', b'x'. They
    // must be consumed as units so the quote in '"' does not open a string.
    // Lifetimes ('a, 'static) never match because they have no closing quote.
    if (ch === "'" || (ch === 'b' && next === "'")) {
      const at = ch === 'b' ? i + 1 : i;
      const literal = CHAR_LITERAL.exec(text.slice(at, at + 12));
      if (literal) {
        out += "''";
        i = at + literal[0].length;
        continue;
      }
    }

    if (ch === '"' || (ch === 'b' && next === '"')) {
      i += ch === 'b' ? 2 : 1;
      out += '""';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\') { if (text[i + 1] === '\n') out += '\n'; i += 2; continue; }
        if (text[i] === '\n') out += '\n';
        i += 1;
      }
      i += 1; // closing quote
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

const TEST_ATTRIBUTE = /^#\[(?:test\b|cfg\(.*\btest\b)/;

const CHAR_LITERAL = /^'(?:[^'\\\n]|\\(?:[nrt0'"\\]|x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}))'/;

function isRawStringStart(text, i) {
  let j = text[i] === 'b' ? i + 2 : i + 1;
  // A raw string is `r` followed by zero or more `#` then `"`; `r` must not be
  // part of a longer identifier (e.g. `for`, `error`).
  if (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1])) return false;
  while (text[j] === '#') j += 1;
  return text[j] === '"';
}

function visibilityOf(head) {
  const match = /^pub(?:\(([^)]+)\))?\s/.exec(head);
  if (!match) return 'private';
  if (!match[1]) return 'pub';
  return `pub(${match[1].trim()})`;
}

function nameAfter(rest) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
  return match ? match[1] : '';
}

/**
 * Name an `impl` block the way a reader would: `Trait for Type` when it is a
 * trait impl, otherwise the type. Generic parameter lists on the `impl` itself
 * (`impl<T: Bound> Foo<T>`) are skipped; the type's own generics are kept
 * because they are part of how the block reads.
 */
function implName(rest) {
  let text = rest.trim();
  if (text.startsWith('<')) {
    let depth = 0;
    let k = 0;
    for (; k < text.length; k += 1) {
      if (text[k] === '<') depth += 1;
      else if (text[k] === '>') { depth -= 1; if (depth === 0) { k += 1; break; } }
    }
    text = text.slice(k).trim();
  }
  const braceAt = text.indexOf('{');
  if (braceAt !== -1) text = text.slice(0, braceAt);
  const whereAt = text.search(/\bwhere\b/);
  if (whereAt !== -1) text = text.slice(0, whereAt);
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Scan one Rust source file for item declarations.
 *
 * Returns `{ items, unsafe, lines }`:
 * - `items[]`: `{ kind, name, line, visibility, unsafe, module, test }` in
 *   source order. `module` is the inline `mod` path the item sits in (`""` at
 *   file scope, `"tests"` inside `mod tests { … }`, nested paths joined with
 *   `::`). `test` is true for `#[test]` functions, anything under a
 *   `#[cfg(test)]` attribute, and everything inside a module so marked.
 * - `unsafe`: `{ fns, impls, blocks }` — `unsafe fn` items, `unsafe impl`
 *   blocks, and explicit `unsafe { … }` blocks wherever they occur.
 * - `lines`: physical line count.
 */
export function scanRustSource(source) {
  const raw = String(source ?? '');
  const clean = stripRustCommentsAndStrings(raw);
  const lines = clean.split('\n');
  const items = [];
  const unsafeStats = { fns: 0, impls: 0, blocks: 0 };

  // Brace-depth tracking decides what counts as an item: only headers at the
  // current "item scope" are reported. Inline modules open a new item scope
  // (their body is item scope again), everything else (fn/impl/trait bodies,
  // struct bodies) is skipped as a body.
  const scopes = [{ depth: 0, module: '', kind: 'file', test: false }];
  let depth = 0;
  let pendingHead = null; // an item header awaiting its `{`, `;` or `=`
  // Outer attributes seen since the last item at this scope. `#[test]` and
  // `#[cfg(test)]` (in any `any`/`all` combination) mark the item — and, for
  // an inline module, everything inside it — as test code.
  let pendingTestAttribute = false;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const lineNo = idx + 1;
    const trimmed = line.trim();
    const top = scopes[scopes.length - 1];
    const atItemScope = depth === top.depth;

    // `unsafe { … }` blocks are counted wherever they occur.
    const blockMatches = trimmed.match(/\bunsafe\s*\{/g);
    if (blockMatches) unsafeStats.blocks += blockMatches.length;

    if (atItemScope && !pendingHead && trimmed.startsWith('#[')) {
      if (TEST_ATTRIBUTE.test(trimmed)) pendingTestAttribute = true;
    }

    if (atItemScope && !pendingHead && trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('}')) {
      const match = ITEM_HEAD.exec(trimmed);
      if (!match) pendingTestAttribute = false;
      if (match) {
        const keyword = match[1];
        const kind = keyword === 'macro_rules!' ? 'macro' : keyword;
        const rest = trimmed.slice(match.index + match[0].length);
        const head = trimmed;
        const isUnsafe = /(?:^|\s)unsafe\s/.test(head.slice(0, match.index + match[0].length));
        let name;
        if (kind === 'impl') name = implName(rest);
        else if (kind === 'static') name = nameAfter(rest.replace(/^\s*mut\s+/, ''));
        else name = nameAfter(rest);
        if (name) {
          const isTest = Boolean(top.test || pendingTestAttribute);
          items.push({
            kind,
            name,
            line: lineNo,
            visibility: visibilityOf(head),
            unsafe: isUnsafe,
            module: top.module,
            test: isTest
          });
          if (isUnsafe && kind === 'fn') unsafeStats.fns += 1;
          if (isUnsafe && kind === 'impl') unsafeStats.impls += 1;
          pendingHead = { kind, name, test: isTest };
        }
        pendingTestAttribute = false;
      }
    }

    // Walk braces on this line to track depth and detect module bodies.
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c];
      if (ch === '{') {
        depth += 1;
        if (pendingHead) {
          if (pendingHead.kind === 'mod') {
            const moduleName = pendingHead.name;
            scopes.push({
              depth,
              module: top.module ? `${top.module}::${moduleName}` : moduleName,
              kind: 'mod',
              test: Boolean(top.test || pendingHead.test)
            });
          }
          pendingHead = null;
        }
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1);
        const current = scopes[scopes.length - 1];
        if (scopes.length > 1 && depth < current.depth) scopes.pop();
      } else if ((ch === ';' || ch === '=') && pendingHead && depth === scopes[scopes.length - 1].depth) {
        // `mod foo;`, `type A = B;`, `const X: T = …;`, `static S: T = …;`
        pendingHead = null;
      }
    }
  }

  return { items, unsafe: unsafeStats, lines: physicalLineCount(raw) };
}

/** Line count the way `wc -l` reports it, plus one for an unterminated last line. */
function physicalLineCount(text) {
  if (!text.length) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1;
  return text.endsWith('\n') ? count : count + 1;
}

/**
 * Minimal Cargo.toml reader: `[package]` name/description/edition, and the
 * dependency names under `[dependencies]` / `[dev-dependencies]` /
 * `[build-dependencies]` / `[target.'cfg(…)'.dependencies]`. Workspace
 * inheritance (`edition.workspace = true`) is resolved by the caller against
 * `[workspace.package]`, which this same function reads from the root manifest
 * as `workspacePackage`, and `[workspace] members` as `members`.
 *
 * Only the line shapes Cargo manifests actually use are recognised:
 * `key = "value"`, `key = { … }`, `key.workspace = true`, and one-item-per-line
 * arrays. That is enough for the four crates here and fails soft (fields
 * absent) rather than wrong on anything more exotic.
 */
export function parseCargoManifest(source) {
  const text = String(source ?? '');
  const out = {
    package: {},
    workspacePackage: {},
    members: [],
    dependencies: [],
    devDependencies: [],
    buildDependencies: [],
    features: [],
    bins: []
  };

  let section = '';
  let arrayKey = null;
  let arrayTarget = null;
  let currentBin = null;

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    if (arrayKey) {
      if (line.startsWith(']')) { arrayKey = null; arrayTarget = null; continue; }
      const item = line.replace(/,$/, '').trim().replace(/^"(.*)"$/, '$1');
      if (item && arrayTarget) arrayTarget.push(item);
      continue;
    }

    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      section = header[1].trim();
      if (line.startsWith('[[bin]]')) { currentBin = {}; out.bins.push(currentBin); }
      else currentBin = null;
      continue;
    }

    const assignment = /^([A-Za-z0-9_.\-'"()\s]+?)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const key = assignment[1].trim().replace(/^"(.*)"$/, '$1');
    const value = assignment[2].trim();

    const stringValue = /^"(.*)"$/.exec(value);
    if (value === '[') {
      arrayKey = key;
      if (section === 'workspace' && key === 'members') arrayTarget = out.members;
      else arrayTarget = [];
      continue;
    }

    if (section === 'package') {
      if (key.endsWith('.workspace')) out.package[key.replace(/\.workspace$/, '')] = { workspace: true };
      else if (stringValue) out.package[key] = stringValue[1];
      continue;
    }
    if (section === 'workspace.package') {
      if (stringValue) out.workspacePackage[key] = stringValue[1];
      continue;
    }
    if (section === 'bin' && currentBin) {
      if (stringValue) currentBin[key] = stringValue[1];
      continue;
    }
    if (section === 'features') {
      out.features.push(key);
      continue;
    }
    // `[dependencies]` and target-scoped `[target.'cfg(…)'.dependencies]`
    // alike; the same for the dev and build tables.
    const dependencyTable = /(?:^|\.)(dependencies|dev-dependencies|build-dependencies)$/.exec(section);
    if (dependencyTable) {
      if (dependencyTable[1] === 'dependencies') out.dependencies.push(key);
      else if (dependencyTable[1] === 'dev-dependencies') out.devDependencies.push(key);
      else out.buildDependencies.push(key);
    }
  }

  return out;
}

/** Drop a `# comment` that is not inside a quoted value. */
function stripTomlComment(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== '\\') inQuote = !inQuote;
    else if (ch === '#' && !inQuote) return line.slice(0, i);
  }
  return line;
}

/** Classify a Rust source path within its crate. */
export function rustFileRole(relativePath) {
  const path = String(relativePath ?? '');
  if (path === 'src/lib.rs') return 'lib';
  if (path === 'src/main.rs' || /^src\/bin\//.test(path)) return 'bin';
  if (path === 'build.rs') return 'build';
  if (/^tests\//.test(path) || /^benches\//.test(path) || /^examples\//.test(path)) return 'test';
  return 'module';
}

/**
 * The Rust module path of a source file inside its crate: `src/args/mod.rs`
 * and `src/args.rs` are both `args`; `src/args/tcb.rs` is `args::tcb`;
 * `src/lib.rs` is the crate root (`""`).
 */
export function rustModulePath(relativePath) {
  const path = String(relativePath ?? '');
  if (!/^src\//.test(path) || !/\.rs$/.test(path)) return '';
  if (path === 'src/lib.rs' || path === 'src/main.rs' || /^src\/bin\//.test(path)) return '';
  const parts = path.slice(4, -3).split('/');
  if (parts[parts.length - 1] === 'mod') parts.pop();
  return parts.join('::');
}

/**
 * Build the Rust inventory the map bundles.
 *
 * `files` is the repository tree (every path, not only Rust); `readText(path)`
 * returns a file's contents or throws. Only `rust/` is inspected. A crate is a
 * directory directly under `rust/` that carries a `Cargo.toml` with a
 * `[package]` table; the root `rust/Cargo.toml` names the workspace members and
 * supplies inherited package fields.
 */
export function buildRustInventory(files, readText, options = {}) {
  const root = String(options.root ?? 'rust');
  const list = Array.isArray(files) ? files.map(String) : [];
  const rootManifestPath = `${root}/Cargo.toml`;
  const hasRoot = list.includes(rootManifestPath);
  const rootManifest = hasRoot ? parseCargoManifest(safeRead(readText, rootManifestPath)) : parseCargoManifest('');

  const crateDirs = new Set();
  for (const path of list) {
    const match = new RegExp(`^${escapeRegExp(root)}/([^/]+)/Cargo\\.toml$`).exec(path);
    if (match) crateDirs.add(match[1]);
  }

  const memberOrder = rootManifest.members.length ? rootManifest.members : [...crateDirs].sort();
  const orderedDirs = [
    ...memberOrder.filter((dir) => crateDirs.has(dir)),
    ...[...crateDirs].filter((dir) => !memberOrder.includes(dir)).sort()
  ];

  const crates = [];
  for (const dir of orderedDirs) {
    const cratePath = `${root}/${dir}`;
    const manifest = parseCargoManifest(safeRead(readText, `${cratePath}/Cargo.toml`));
    if (!manifest.package.name) continue;

    const inherit = (key) => {
      const value = manifest.package[key];
      if (value && typeof value === 'object' && value.workspace) return rootManifest.workspacePackage[key] ?? '';
      return typeof value === 'string' ? value : '';
    };

    const sources = list
      .filter((path) => path.startsWith(`${cratePath}/`) && /\.rs$/.test(path))
      .sort();

    const crateFiles = [];
    let lines = 0;
    let itemTotal = 0;
    let publicTotal = 0;
    let testTotal = 0;
    const unsafeTotal = { fns: 0, impls: 0, blocks: 0 };
    let deniesUnsafe = false;

    for (const path of sources) {
      const relative = path.slice(cratePath.length + 1);
      const text = safeRead(readText, path);
      const scan = scanRustSource(text);
      const role = rustFileRole(relative);
      if (role === 'lib' || role === 'bin') {
        if (/^\s*#!\[(?:deny|forbid)\(unsafe_code\)\]/m.test(text)) deniesUnsafe = true;
      }
      // Test code is listed but flagged: `#[cfg(test)] mod tests` blocks and
      // integration-test files hold most of the HAL's functions, and they are
      // not the surface the map highlights, so the page keeps them behind a
      // toggle and counts them apart from the production items.
      const isTestFile = role === 'test';
      const items = scan.items.map((item) => ({
        kind: item.kind,
        name: item.name,
        line: item.line,
        visibility: item.visibility,
        ...(item.unsafe ? { unsafe: true } : {}),
        ...(item.module ? { module: item.module } : {}),
        ...(item.test || isTestFile ? { test: true } : {})
      }));
      const testItems = items.filter((item) => item.test).length;
      const productionCount = items.length - testItems;
      const publicItems = items.filter((item) => item.visibility === 'pub' && !item.module && !item.test).length;
      crateFiles.push({
        path,
        relativePath: relative,
        modulePath: rustModulePath(relative),
        role,
        lines: scan.lines,
        items,
        publicItems,
        testItems,
        unsafe: scan.unsafe
      });
      lines += scan.lines;
      itemTotal += productionCount;
      publicTotal += publicItems;
      testTotal += testItems;
      unsafeTotal.fns += scan.unsafe.fns;
      unsafeTotal.impls += scan.unsafe.impls;
      unsafeTotal.blocks += scan.unsafe.blocks;
    }

    const internalDeps = manifest.dependencies.filter((dep) => crateDirs.has(dep));
    const externalDeps = manifest.dependencies.filter((dep) => !crateDirs.has(dep));

    crates.push({
      name: manifest.package.name,
      path: cratePath,
      manifest: `${cratePath}/Cargo.toml`,
      description: inherit('description'),
      edition: inherit('edition'),
      version: inherit('version'),
      dependencies: manifest.dependencies,
      internalDependencies: internalDeps,
      externalDependencies: externalDeps,
      devDependencies: manifest.devDependencies,
      buildDependencies: manifest.buildDependencies,
      features: manifest.features.filter((feature) => feature !== 'default'),
      deniesUnsafe,
      files: crateFiles,
      sourceFiles: crateFiles.length,
      lines,
      items: itemTotal,
      publicItems: publicTotal,
      testItems: testTotal,
      unsafe: unsafeTotal
    });
  }

  const nonCrateFiles = list.filter((path) => path.startsWith(`${root}/`))
    .filter((path) => !crates.some((crate) => path.startsWith(`${crate.path}/`)))
    .sort();

  return {
    root,
    workspaceManifest: hasRoot ? rootManifestPath : '',
    members: rootManifest.members.slice(),
    edition: rootManifest.workspacePackage.edition ?? '',
    version: rootManifest.workspacePackage.version ?? '',
    rustVersion: rootManifest.workspacePackage['rust-version'] ?? '',
    workspaceFiles: nonCrateFiles,
    crates
  };
}

function safeRead(readText, path) {
  try {
    const value = readText(path);
    return typeof value === 'string' ? value : String(value ?? '');
  } catch {
    return '';
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
