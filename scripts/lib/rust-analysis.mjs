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
 * Two things are counted rather than listed, and both are split into
 * production and test code, because the cards describe the production surface:
 *
 * - **Items.** `items` counts nameable declarations (`fn`, `struct`, `enum`,
 *   `union`, `trait`, `type`, `const`, `static`, `mod`, `macro_rules!`) outside
 *   test code; `impl` blocks are listed but not counted, because they have no
 *   name or visibility of their own. `publicItems` counts those declared `pub`
 *   whose enclosing inline modules are all `pub` too — what a reader of the
 *   crate can actually reach.
 * - **`unsafe` sites.** `unsafe fn` headers (free functions and methods alike),
 *   `unsafe impl` blocks and `unsafe { … }` blocks, at any depth. Sites inside
 *   test code go to `testUnsafe`, the rest to `unsafe`. An earlier version
 *   counted functions and impls at item scope only — so a method inside an
 *   `impl` was never seen — while counting blocks everywhere, test modules
 *   included; the total was then neither a production nor a total figure.
 *
 * Test code is `#[test]` functions, anything under an attribute whose `cfg`
 * predicate is satisfiable only with `test` (`cfg(test)`, `cfg(all(test, …))`;
 * not `cfg(not(test))` or `cfg(any(test, feature = "…"))`, which compile into
 * production builds too), everything inside a module or block so marked, and
 * every line of an integration-test file. Items in it are listed with
 * `test: true` so the map can show them behind a per-crate toggle.
 */

export const RUST_ITEM_KINDS = Object.freeze([
  'fn', 'struct', 'enum', 'union', 'trait', 'type', 'const', 'static', 'mod', 'impl', 'macro'
]);

/** Kinds that count as declarations; `impl` blocks are listed but not counted. */
export const RUST_COUNTED_KINDS = Object.freeze(RUST_ITEM_KINDS.filter((kind) => kind !== 'impl'));

const ITEM_HEAD = new RegExp(
  '^(?:pub(?:\\((?:crate|super|self|in\\s+[A-Za-z0-9_:]+)\\))?\\s+)?' +
  '(?:default\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+(?:"[^"]*"\\s+)?)?' +
  // `\b` cannot follow `macro_rules!` (both sides are non-word characters),
  // so the keyword alternation carries its own boundary.
  '((?:fn|struct|enum|union|trait|type|const|static|mod|impl)\\b|macro_rules!)'
);

// An `unsafe fn` header wherever it sits: a free function at item scope, a
// method inside an `impl`, a required method in a `trait`. Anchored at the
// start of the line so that a function-pointer type (`let f: unsafe fn(u8)`)
// or a mention in the middle of a statement is not a site.
const UNSAFE_FN_HEAD = new RegExp(
  '^(?:pub(?:\\((?:crate|super|self|in\\s+[A-Za-z0-9_:]+)\\))?\\s+)?' +
  '(?:default\\s+)?(?:const\\s+)?(?:async\\s+)?unsafe\\s+(?:extern\\s+(?:"[^"]*"\\s+)?)?fn\\b'
);
const UNSAFE_IMPL_HEAD = /^unsafe\s+impl\b/;
const UNSAFE_BLOCK = /\bunsafe\s*\{/g;

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

const CHAR_LITERAL = /^'(?:[^'\\\n]|\\(?:[nrt0'"\\]|x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}))'/;

function isRawStringStart(text, i) {
  let j = text[i] === 'b' ? i + 2 : i + 1;
  // A raw string is `r` followed by zero or more `#` then `"`; `r` must not be
  // part of a longer identifier (e.g. `for`, `error`).
  if (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1])) return false;
  while (text[j] === '#') j += 1;
  return text[j] === '"';
}

/**
 * Is a `cfg` predicate satisfiable only when `test` is set?
 *
 * `test` → yes. `all(a, b)` → yes if any operand is. `any(a, b)` → yes only if
 * every operand is (`any(test, feature = "std")` compiles into a production
 * build with the feature on). `not(…)` → no: `not(test)` is the production
 * side of a split, and `not(feature)` says nothing about tests. Unknown
 * predicates (`feature = "…"`, `target_arch = "…"`, `loom`) → no.
 *
 * `predicate` is the text inside `cfg(…)`, with string literals already
 * blanked or not — values are never inspected.
 */
export function cfgIsTestOnly(predicate) {
  const tokens = [];
  const pattern = /\s*(?:([A-Za-z_][A-Za-z0-9_]*)|("(?:[^"\\]|\\.)*")|([(),=]))/y;
  const text = String(predicate ?? '');
  let at = 0;
  while (at < text.length) {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match || match[0].length === 0) break;
    at = pattern.lastIndex;
    if (match[1] !== undefined) tokens.push({ type: 'ident', value: match[1] });
    else if (match[2] !== undefined) tokens.push({ type: 'string' });
    else tokens.push({ type: match[3] });
  }

  let pos = 0;
  function parse() {
    const token = tokens[pos];
    if (!token || token.type !== 'ident') return null;
    pos += 1;
    if (tokens[pos] && tokens[pos].type === '(') {
      pos += 1;
      const args = [];
      while (pos < tokens.length && tokens[pos].type !== ')') {
        const arg = parse();
        if (arg) args.push(arg);
        if (tokens[pos] && tokens[pos].type === ',') pos += 1;
        else if (!tokens[pos] || tokens[pos].type !== ')') break;
      }
      pos += 1; // ')'
      return { name: token.value, args };
    }
    if (tokens[pos] && tokens[pos].type === '=') pos += 2; // key = "value"
    return { name: token.value, args: null };
  }

  function testOnly(node) {
    if (!node) return false;
    if (node.args === null) return node.name === 'test';
    if (node.name === 'all') return node.args.some(testOnly);
    if (node.name === 'any') return node.args.length > 0 && node.args.every(testOnly);
    return false;
  }

  return testOnly(parse());
}

/** Does an outer attribute (`#[…]`, brackets balanced) mark its item as test code? */
function attributeMarksTest(attribute) {
  const match = /^#\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([\s\S]*)\))?\s*\]$/.exec(attribute.trim());
  if (!match) return false;
  if (match[1] === 'test') return true;
  if (match[1] === 'cfg' && match[2] !== undefined) return cfgIsTestOnly(match[2]);
  return false;
}

function bracketBalance(text) {
  let balance = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '[') balance += 1;
    else if (text[i] === ']') balance -= 1;
  }
  return balance;
}

function visibilityOf(head) {
  const match = /^pub(?:\(([^)]+)\))?\s/.exec(head);
  if (!match) return 'private';
  if (!match[1]) return 'pub';
  return `pub(${match[1].trim()})`;
}

function nameAfter(rest) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
  // `const _: () = assert!(…)` is an anonymous compile-time assertion, not a
  // nameable declaration: it is neither listed nor counted.
  return match && match[1] !== '_' ? match[1] : '';
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

function emptyUnsafe() {
  return { fns: 0, impls: 0, blocks: 0 };
}

/**
 * Scan one Rust source file for item declarations and `unsafe` sites.
 *
 * Returns `{ items, productionItems, publicItems, testItems, unsafe, testUnsafe, lines }`:
 * - `items[]`: `{ kind, name, line, visibility, unsafe, module, test }` in
 *   source order. `module` is the inline `mod` path the item sits in (`""` at
 *   file scope, `"tests"` inside `mod tests { … }`, nested paths joined with
 *   `::`). `test` is true for `#[test]` functions, anything under a test-only
 *   `cfg`, everything inside a module so marked, and every item when
 *   `options.testFile` is set.
 * - `productionItems`: counted kinds (not `impl`) outside test code.
 * - `publicItems`: of those, the ones declared `pub` inside only-`pub` modules.
 * - `testItems`: items flagged test.
 * - `unsafe` / `testUnsafe`: `{ fns, impls, blocks }` — `unsafe fn` headers at
 *   any depth, `unsafe impl` blocks, and `unsafe { … }` blocks, split by
 *   whether the site lies in test code.
 * - `lines`: physical line count.
 */
export function scanRustSource(source, options = {}) {
  const raw = String(source ?? '');
  const testFile = Boolean(options && options.testFile);
  const clean = stripRustCommentsAndStrings(raw);
  const lines = clean.split('\n');
  const items = [];
  const unsafeStats = emptyUnsafe();
  const testUnsafe = emptyUnsafe();
  let productionItems = 0;
  let publicItems = 0;
  let testItems = 0;

  // Brace-depth tracking decides what counts as an item: only headers at the
  // current "item scope" are reported. Inline modules open a new item scope
  // (their body is item scope again), everything else (fn/impl/trait bodies,
  // struct bodies) is skipped as a body. `exported` says whether every
  // enclosing inline module is `pub`, so a `pub fn` in a private `mod` is not
  // counted as public API.
  const scopes = [{ depth: 0, module: '', kind: 'file', test: testFile, exported: true }];
  // Depths of bodies that belong to test items (a `#[test] fn`, a
  // `#[cfg(test)] impl`, a test module): `unsafe` sites inside them are test
  // sites, whatever their depth.
  const testRegions = [];
  let depth = 0;
  let pendingHead = null; // an item header awaiting its `{`, `;` or `=`
  // Outer attributes seen since the last item at this scope; a multi-line
  // attribute is accumulated until its brackets balance.
  let pendingTestAttribute = false;
  let attributeBuffer = null;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const lineNo = idx + 1;
    const trimmed = line.trim();
    const top = scopes[scopes.length - 1];
    const atItemScope = depth === top.depth;

    if (atItemScope && !pendingHead) {
      if (attributeBuffer !== null) {
        attributeBuffer += '\n' + trimmed;
        if (bracketBalance(attributeBuffer) <= 0) {
          if (attributeMarksTest(attributeBuffer)) pendingTestAttribute = true;
          attributeBuffer = null;
        }
        continue;
      }
      if (trimmed.startsWith('#[')) {
        if (bracketBalance(trimmed) > 0) {
          attributeBuffer = trimmed;
        } else if (attributeMarksTest(trimmed)) {
          pendingTestAttribute = true;
        }
        continue;
      }
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
          const visibility = visibilityOf(head);
          items.push({
            kind,
            name,
            line: lineNo,
            visibility,
            unsafe: isUnsafe,
            module: top.module,
            test: isTest
          });
          if (isTest) testItems += 1;
          else if (kind !== 'impl') {
            productionItems += 1;
            if (visibility === 'pub' && top.exported) publicItems += 1;
          }
          pendingHead = { kind, name, test: isTest, exported: top.exported && visibility === 'pub' };
        }
        pendingTestAttribute = false;
      }
    }

    // `unsafe` sites on this line, attributed to test or production code by
    // the innermost enclosing item.
    const inTest = testFile || top.test || testRegions.length > 0 || Boolean(pendingHead && pendingHead.test);
    const bucket = inTest ? testUnsafe : unsafeStats;
    if (UNSAFE_FN_HEAD.test(trimmed)) bucket.fns += 1;
    else if (UNSAFE_IMPL_HEAD.test(trimmed)) bucket.impls += 1;
    const blockMatches = trimmed.match(UNSAFE_BLOCK);
    if (blockMatches) bucket.blocks += blockMatches.length;

    // Walk braces on this line to track depth and detect module bodies.
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c];
      if (ch === '{') {
        depth += 1;
        if (pendingHead) {
          if (pendingHead.test) testRegions.push(depth);
          if (pendingHead.kind === 'mod') {
            const moduleName = pendingHead.name;
            scopes.push({
              depth,
              module: top.module ? `${top.module}::${moduleName}` : moduleName,
              kind: 'mod',
              test: Boolean(top.test || pendingHead.test),
              exported: pendingHead.exported
            });
          }
          pendingHead = null;
        }
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1);
        while (testRegions.length && depth < testRegions[testRegions.length - 1]) testRegions.pop();
        const current = scopes[scopes.length - 1];
        if (scopes.length > 1 && depth < current.depth) scopes.pop();
      } else if ((ch === ';' || ch === '=') && pendingHead && depth === scopes[scopes.length - 1].depth) {
        // `mod foo;`, `type A = B;`, `const X: T = …;`, `static S: T = …;`
        pendingHead = null;
      }
    }
  }

  return {
    items,
    productionItems,
    publicItems,
    testItems,
    unsafe: unsafeStats,
    testUnsafe,
    lines: physicalLineCount(raw)
  };
}

/** Line count the way `wc -l` reports it, plus one for an unterminated last line. */
function physicalLineCount(text) {
  if (!text.length) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1;
  return text.endsWith('\n') ? count : count + 1;
}

const DEPENDENCY_TABLES = new Set(['dependencies', 'dev-dependencies', 'build-dependencies']);

/**
 * Minimal Cargo.toml reader: `[package]` name/description/edition, the
 * dependency names under `[dependencies]` / `[dev-dependencies]` /
 * `[build-dependencies]`, and — kept apart — the same tables scoped to a
 * target, `[target.'cfg(…)'.dependencies]`, as `targetDependencies:
 * [{ cfg, table, names }]`. A target-scoped table is resolved only when its
 * predicate holds (`loom` under `cfg(loom)` enters no ordinary build), so it
 * must never be reported as an unconditional dependency.
 *
 * Workspace inheritance (`edition.workspace = true`) is resolved by the caller
 * against `[workspace.package]`, which this same function reads from the root
 * manifest as `workspacePackage`, and `[workspace] members` as `members`.
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
    targetDependencies: [],
    features: [],
    bins: []
  };

  let section = '';
  let arrayKey = null;
  let arrayTarget = null;
  let currentBin = null;
  let currentTarget = null;

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
      currentBin = null;
      currentTarget = null;
      if (line.startsWith('[[bin]]')) { currentBin = {}; out.bins.push(currentBin); }
      const scoped = /^target\.(?:'([^']+)'|"([^"]+)"|([^.'"]+))\.(dependencies|dev-dependencies|build-dependencies)$/.exec(section);
      if (scoped) {
        currentTarget = { cfg: scoped[1] ?? scoped[2] ?? scoped[3], table: scoped[4], names: [] };
        out.targetDependencies.push(currentTarget);
      }
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
    if (currentTarget) {
      currentTarget.names.push(key);
      continue;
    }
    if (DEPENDENCY_TABLES.has(section)) {
      if (section === 'dependencies') out.dependencies.push(key);
      else if (section === 'dev-dependencies') out.devDependencies.push(key);
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
 * Where an out-of-line module declared in `relativePath` may live: `mod x;`
 * in `src/lib.rs`, `src/main.rs` or a `mod.rs` resolves next to the declaring
 * file; in any other file it resolves inside that file's own directory
 * (`src/foo.rs` → `src/foo/x.rs`). `#[path]` overrides are not followed.
 */
export function childModuleFiles(relativePath, name) {
  const parts = String(relativePath ?? '').split('/');
  const file = parts.pop();
  const dir = parts.join('/');
  const anchor = file === 'lib.rs' || file === 'main.rs' || file === 'mod.rs' ? dir : [dir, file.replace(/\.rs$/, '')].filter(Boolean).join('/');
  const base = anchor ? `${anchor}/` : '';
  return [`${base}${name}.rs`, `${base}${name}/mod.rs`];
}

function addUnsafe(total, counts) {
  total.fns += counts.fns;
  total.impls += counts.impls;
  total.blocks += counts.blocks;
}

/**
 * Build the Rust inventory the map bundles.
 *
 * `files` is the repository tree (every path, not only Rust); `readText(path)`
 * returns a file's contents or throws. Only `rust/` is inspected. A crate is a
 * directory directly under `rust/` that carries a `Cargo.toml` with a
 * `[package]` table; the root `rust/Cargo.toml` names the workspace members and
 * supplies inherited package fields.
 *
 * `deniesUnsafe` is read from the crate root alone — `src/lib.rs`, or
 * `src/main.rs` for a binary-only package. A `#![deny(unsafe_code)]` in a
 * `src/bin/*.rs` target speaks for that binary, which is its own crate, not
 * for the library.
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
    const crateRoot = sources.includes(`${cratePath}/src/lib.rs`) ? 'src/lib.rs'
      : sources.includes(`${cratePath}/src/main.rs`) ? 'src/main.rs' : '';

    const crateFiles = [];
    let lines = 0;
    let itemTotal = 0;
    let publicTotal = 0;
    let testTotal = 0;
    const unsafeTotal = emptyUnsafe();
    const testUnsafeTotal = emptyUnsafe();
    let deniesUnsafe = false;

    // First pass: every source by its path role. Then resolve out-of-line
    // modules declared under a test-only attribute (`#[cfg(test)] mod tests;`
    // in the crate root, `src/tests.rs` on disk): the path rule calls such a
    // file an ordinary module, but everything in it is test code, as is
    // everything in the modules it declares in turn — so the set is closed
    // under declaration before those files are rescanned as test code.
    const scans = new Map();
    for (const path of sources) {
      const relative = path.slice(cratePath.length + 1);
      const text = safeRead(readText, path);
      const role = rustFileRole(relative);
      scans.set(relative, { path, relative, text, role, scan: scanRustSource(text, { testFile: role === 'test' }) });
    }
    const testFiles = new Set([...scans.values()].filter((entry) => entry.role === 'test').map((entry) => entry.relative));
    let grew = true;
    while (grew) {
      grew = false;
      for (const entry of scans.values()) {
        for (const item of entry.scan.items) {
          if (item.kind !== 'mod' || !(item.test || testFiles.has(entry.relative))) continue;
          for (const candidate of childModuleFiles(entry.relative, item.name)) {
            if (scans.has(candidate) && !testFiles.has(candidate)) { testFiles.add(candidate); grew = true; }
          }
        }
      }
    }
    for (const relative of testFiles) {
      const entry = scans.get(relative);
      if (entry.role !== 'test') entry.scan = scanRustSource(entry.text, { testFile: true });
    }

    for (const entry of scans.values()) {
      const { path, relative, text, role, scan } = entry;
      if (relative === crateRoot && /^\s*#!\[(?:deny|forbid)\(unsafe_code\)\]/m.test(text)) deniesUnsafe = true;
      const items = scan.items.map((item) => ({
        kind: item.kind,
        name: item.name,
        line: item.line,
        visibility: item.visibility,
        ...(item.unsafe ? { unsafe: true } : {}),
        ...(item.module ? { module: item.module } : {}),
        ...(item.test ? { test: true } : {})
      }));
      crateFiles.push({
        path,
        relativePath: relative,
        modulePath: rustModulePath(relative),
        role,
        lines: scan.lines,
        items,
        productionItems: scan.productionItems,
        publicItems: scan.publicItems,
        testItems: scan.testItems,
        unsafe: scan.unsafe,
        testUnsafe: scan.testUnsafe
      });
      lines += scan.lines;
      itemTotal += scan.productionItems;
      publicTotal += scan.publicItems;
      testTotal += scan.testItems;
      addUnsafe(unsafeTotal, scan.unsafe);
      addUnsafe(testUnsafeTotal, scan.testUnsafe);
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
      targetDependencies: manifest.targetDependencies.map((entry) => ({ cfg: entry.cfg, table: entry.table, names: entry.names.slice() })),
      features: manifest.features.filter((feature) => feature !== 'default'),
      deniesUnsafe,
      files: crateFiles,
      sourceFiles: crateFiles.length,
      lines,
      items: itemTotal,
      publicItems: publicTotal,
      testItems: testTotal,
      unsafe: unsafeTotal,
      testUnsafe: testUnsafeTotal
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
