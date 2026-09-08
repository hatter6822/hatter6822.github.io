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
 * item headers at the start of a logical line — after comments and string
 * literals have been blanked and the attributes at the line's start have been
 * consumed — which is what the map needs to list a crate's
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

/** `#[macro_export]` (with or without `(local_inner_macros)`) exports the macro from the crate root. */
function attributeExportsMacro(attribute) {
  return /^#\[\s*macro_export\b/.test(attribute.trim());
}

function bracketBalance(text) {
  let balance = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '[') balance += 1;
    else if (text[i] === ']') balance -= 1;
  }
  return balance;
}

/**
 * Index just past the `]` that closes an attribute in `text`: `open` is the
 * number of `[` still unclosed from earlier lines (0 when the attribute
 * starts on this line). -1 when the line does not close it.
 */
function attributeClose(text, open) {
  let balance = open;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '[') balance += 1;
    else if (text[i] === ']') {
      balance -= 1;
      if (balance <= 0) return i + 1;
    }
  }
  return -1;
}

function visibilityOf(head) {
  const match = /^pub(?:\(([^)]+)\))?\s/.exec(head);
  if (!match) return 'private';
  if (!match[1]) return 'pub';
  return `pub(${match[1].trim()})`;
}

function nameAfter(rest) {
  // A raw identifier (`fn r#match()`) keeps its prefix: that is the name as
  // written and referenced. `const _: () = assert!(…)` is an anonymous
  // compile-time assertion, not a nameable declaration: neither listed nor
  // counted.
  const match = /^\s*(r#)?([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
  if (!match || match[2] === '_') return '';
  return (match[1] || '') + match[2];
}

/** The identifier without a raw-identifier prefix, as it appears in a path. */
function bareIdentifier(name) {
  return String(name ?? '').replace(/^r#/, '');
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
 * - `publicItems`: of those, the ones declared `pub` inside only-`pub` modules
 *   (`#[macro_export]` macros count as `pub` wherever they sit), when the file
 *   itself is reachable: `options.exported` says whether every module on the
 *   path from the crate root to this file is `pub` (default true).
 * - `testItems`: items flagged test.
 * - `unsafe` / `testUnsafe`: `{ fns, impls, blocks }` — `unsafe fn` headers at
 *   any depth, `unsafe impl` blocks, and `unsafe { … }` blocks, split by
 *   whether the site lies in test code.
 * - `lines`: physical line count.
 */
export function scanRustSource(source, options = {}) {
  const raw = String(source ?? '');
  const testFile = Boolean(options && options.testFile);
  const fileExported = !(options && options.exported === false);
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
  const scopes = [{ depth: 0, module: '', kind: 'file', test: testFile, exported: fileExported }];
  // Depths of bodies that belong to test items (a `#[test] fn`, a
  // `#[cfg(test)] impl`, a test module): `unsafe` sites inside them are test
  // sites, whatever their depth.
  const testRegions = [];
  let depth = 0;
  let pendingHead = null; // an item header awaiting its `{`, `;` or `=`
  // Outer attributes seen since the last item at this scope; a multi-line
  // attribute is accumulated until its brackets balance.
  let pendingTestAttribute = false;
  let pendingMacroExport = false;
  let attributeBuffer = null;
  // A test-only attribute below item scope — on an associated method in an
  // `impl` or `trait` — is not an item, but the body it guards is test code:
  // its `unsafe` sites go to testUnsafe. The flag holds until the body opens
  // (a test region is pushed) or the declaration ends without one (`;`). A
  // test-only const or static hands its status over the same way at `=`, so
  // a block initializer on a later line is scanned as test code.
  let pendingNestedTest = false;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNo = idx + 1;
    const top = scopes[scopes.length - 1];
    const atItemScope = depth === top.depth;
    // What remains of the line once the attributes at its start are consumed.
    // Compact Rust puts an attribute and its declaration on one line
    // (`#[cfg(test)] mod tests {`, `#[macro_export] macro_rules! m {`), so
    // the declaration and its braces are read from the rest of that line,
    // not dropped with the attribute.
    let text = lines[idx];

    if (!pendingHead) {
      const noteAttribute = (attribute) => {
        const marksTest = attributeMarksTest(attribute);
        if (atItemScope) {
          if (marksTest) pendingTestAttribute = true;
          if (attributeExportsMacro(attribute)) pendingMacroExport = true;
        } else if (marksTest) {
          pendingNestedTest = true;
        }
      };
      if (attributeBuffer !== null) {
        // A multi-line attribute either closes on this line or runs past it.
        const close = attributeClose(text, bracketBalance(attributeBuffer));
        if (close < 0) { attributeBuffer += '\n' + text.trim(); continue; }
        if (attributeBuffer.startsWith('#[')) noteAttribute(attributeBuffer + '\n' + text.slice(0, close).trim());
        attributeBuffer = null;
        text = text.slice(close);
      }
      while (/^\s*#!?\[/.test(text)) {
        const start = text.search(/\S/);
        const close = attributeClose(text, 0);
        if (close < 0) { attributeBuffer = text.slice(start); text = ''; break; }
        // An inner attribute (`#![…]`) speaks for the enclosing scope, not
        // for the next declaration: only outer attributes are noted.
        if (text.startsWith('#[', start)) noteAttribute(text.slice(start, close));
        text = text.slice(close);
      }
    }

    const trimmed = text.trim();
    if (atItemScope && !pendingHead && trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('}')) {
      const match = ITEM_HEAD.exec(trimmed);
      if (!match) { pendingTestAttribute = false; pendingMacroExport = false; }
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
          // `#[macro_export]` publishes the macro at the crate root whatever
          // module it sits in; it is public API without a `pub`.
          const macroExported = kind === 'macro' && pendingMacroExport;
          const visibility = macroExported ? 'pub' : visibilityOf(head);
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
            if (visibility === 'pub' && (top.exported || macroExported)) publicItems += 1;
          }
          pendingHead = { kind, name, test: isTest, exported: top.exported && visibility === 'pub' };
        }
        pendingTestAttribute = false;
        pendingMacroExport = false;
      }
    }

    // `unsafe` sites on this line, attributed to test or production code by
    // the innermost enclosing item.
    const inTest = testFile || top.test || testRegions.length > 0 || Boolean(pendingHead && pendingHead.test) || pendingNestedTest;
    const bucket = inTest ? testUnsafe : unsafeStats;
    if (UNSAFE_FN_HEAD.test(trimmed)) bucket.fns += 1;
    else if (UNSAFE_IMPL_HEAD.test(trimmed)) bucket.impls += 1;
    const blockMatches = trimmed.match(UNSAFE_BLOCK);
    if (blockMatches) bucket.blocks += blockMatches.length;

    // Walk braces on this line to track depth and detect module bodies.
    for (let c = 0; c < text.length; c += 1) {
      const ch = text[c];
      if (ch === '{') {
        depth += 1;
        if (pendingNestedTest) {
          testRegions.push(depth);
          pendingNestedTest = false;
        }
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
        // `mod foo;`, `type A = B;`, `const X: T = …;`, `static S: T = …;`.
        // A test-only const or static may still open a block initializer on
        // a later line (`const CHECK: () = {` … `};`): the `unsafe` sites in
        // it are test sites, so its test status outlives the head until that
        // block opens or the declaration ends.
        if (ch === '=' && pendingHead.test) pendingNestedTest = true;
        pendingHead = null;
      } else if (ch === ';' && pendingNestedTest) {
        // A guarded declaration without a body (`#[cfg(test)] fn helper();`)
        // or a test-only initializer without a block (`= Mutex::new(());`).
        pendingNestedTest = false;
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

const LINT_LEVELS = new Set(['allow', 'warn', 'deny', 'forbid']);

/**
 * Does a crate root deny `unsafe_code` for the whole crate? The inner
 * attributes (`#![…]`) are read in order with their argument lists parsed,
 * not matched as one spelling: `#![deny( unsafe_code )]`, `#![deny(dead_code,
 * unsafe_code)]`, a multi-line attribute and `#![forbid(unsafe_code)]` all
 * count, `#![warn(unsafe_code)]` does not, and a later `#![allow(unsafe_code)]`
 * lifts an earlier deny the way rustc applies lint levels in order (a forbid
 * cannot be lifted). A `cfg_attr` counts when its predicate holds in a
 * production build (`cfg_attr(not(test), deny(unsafe_code))`), never when it
 * is test-only. Comments, strings and outer attributes on items are not
 * crate policy.
 */
export function crateDeniesUnsafe(source) {
  let denies = false;
  for (const body of innerAttributes(stripRustCommentsAndStrings(String(source ?? '')))) {
    const level = unsafeCodeLintLevel(body);
    if (level === 'forbid') return true;
    if (level === 'deny') denies = true;
    else if (level === 'allow' || level === 'warn') denies = false;
  }
  return denies;
}

/** The bodies of a source's inner attributes `#![…]`, in order, brackets balanced across lines. */
function innerAttributes(text) {
  const bodies = [];
  const pattern = /^\s*#!\[/gm;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const close = attributeClose(text.slice(start), 1);
    if (close < 0) break;
    bodies.push(text.slice(start, start + close - 1));
    pattern.lastIndex = start + close;
  }
  return bodies;
}

/**
 * The level an attribute body sets for the `unsafe_code` lint (`allow`,
 * `warn`, `deny`, `forbid`), or `""` when it says nothing about that lint.
 */
function unsafeCodeLintLevel(body) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*$/.exec(body);
  if (!match) return '';
  const name = match[1];
  const args = splitTopLevel(match[2]);
  if (name === 'cfg_attr') {
    // `cfg_attr(predicate, attribute, …)`: the attributes apply when the
    // predicate holds, which a test-only predicate never does in production.
    if (args.length < 2 || cfgIsTestOnly(args[0])) return '';
    let level = '';
    for (const attribute of args.slice(1)) level = unsafeCodeLintLevel(attribute) || level;
    return level;
  }
  if (!LINT_LEVELS.has(name)) return '';
  return args.some((lint) => lint === 'unsafe_code') ? name : '';
}

/** Split an argument list at the commas outside any brackets, trimming each part. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const DEPENDENCY_TABLES = new Set(['dependencies', 'dev-dependencies', 'build-dependencies']);

/**
 * Minimal Cargo.toml reader: `[package]` name/description/edition, the
 * dependencies under `[dependencies]` / `[dev-dependencies]` /
 * `[build-dependencies]`, and — kept apart — the same tables scoped to a
 * target, `[target.'cfg(…)'.dependencies]`, as `targetDependencies:
 * [{ cfg, table, names }]`. A target-scoped table is resolved only when its
 * predicate holds (`loom` under `cfg(loom)` enters no ordinary build), so it
 * must never be reported as an unconditional dependency.
 *
 * Every dependency list carries package identities: the table key, unless
 * the entry renames the package (`alias = { package = "actual", … }`), in
 * which case `actual`. `dependencySpecs` keeps each entry whole — `{ table,
 * cfg, name, package, path }` — for the caller to resolve against the
 * workspace.
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
    dependencySpecs: [],
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
      const spec = dependencySpec(key, value, currentTarget.table, currentTarget.cfg);
      out.dependencySpecs.push(spec);
      currentTarget.names.push(spec.package);
      continue;
    }
    if (DEPENDENCY_TABLES.has(section)) {
      const spec = dependencySpec(key, value, section, '');
      out.dependencySpecs.push(spec);
      if (section === 'dependencies') out.dependencies.push(spec.package);
      else if (section === 'dev-dependencies') out.devDependencies.push(spec.package);
      else out.buildDependencies.push(spec.package);
    }
  }

  return out;
}

/**
 * One dependency entry: the table key it is declared under (`name`), the
 * package it resolves to (`package` — the key unless the entry renames it
 * with `package = "…"`) and its `path`, if any, read from the inline table.
 */
function dependencySpec(name, value, table, cfg) {
  const spec = { table, cfg, name, package: name, path: '' };
  const inline = /^\{([\s\S]*)\}$/.exec(value);
  if (!inline) return spec;
  for (const field of splitTopLevel(inline[1])) {
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*"(.*)"$/.exec(field);
    if (!pair) continue;
    if (pair[1] === 'package') spec.package = pair[2];
    else if (pair[1] === 'path') spec.path = pair[2];
  }
  return spec;
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
  const stem = bareIdentifier(name);
  return [`${base}${stem}.rs`, `${base}${stem}/mod.rs`];
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
 * `src/main.rs` for a binary-only package — by `crateDeniesUnsafe`. A
 * `#![deny(unsafe_code)]` in a `src/bin/*.rs` target speaks for that binary,
 * which is its own crate, not for the library.
 *
 * A dependency is internal when it resolves to a workspace package, by name
 * or by path; the lists carry package identities, so a renamed dependency
 * reads as the crate it is.
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

  // Every manifest first: a dependency is internal when it names a workspace
  // package — by its `package` identity, or by a `path` into a member's
  // directory — not when its table key happens to equal a directory name. A
  // member whose directory is not its package name, and a renamed dependency
  // (`alias = { package = "sele4n-types", path = … }`), are workspace edges.
  const manifests = new Map(orderedDirs.map((dir) => [dir, parseCargoManifest(safeRead(readText, `${root}/${dir}/Cargo.toml`))]));
  const packageNames = new Set();
  const packagesByPath = new Map();
  for (const [dir, manifest] of manifests) {
    if (!manifest.package.name) continue;
    packageNames.add(manifest.package.name);
    packagesByPath.set(`${root}/${dir}`, manifest.package.name);
  }
  const workspacePackage = (cratePath, spec) => {
    const byPath = spec.path ? packagesByPath.get(resolvePath(cratePath, spec.path)) : '';
    if (byPath) return byPath;
    return packageNames.has(spec.package) ? spec.package : '';
  };

  const crates = [];
  for (const dir of orderedDirs) {
    const cratePath = `${root}/${dir}`;
    const manifest = manifests.get(dir);
    if (!manifest.package.name) continue;
    // Dependency lists by package identity, resolved against the workspace.
    const identity = (spec) => workspacePackage(cratePath, spec) || spec.package;
    const listed = (table, cfg) => manifest.dependencySpecs.filter((spec) => spec.table === table && spec.cfg === cfg).map(identity);

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
    // module declarations (`mod x;`) to their files the way rustc does, and
    // carry two things down that path:
    //  - test-only status: `#[cfg(test)] mod tests;` names an ordinary module
    //    by path, but everything in `src/tests.rs` is test code, as is every
    //    module it declares in turn;
    //  - export status: `pub` items in a file reached through a private
    //    `mod detail;` are not public API, so `publicItems` must not count
    //    them. Files nothing declares (crate roots, `#[path]` targets) keep
    //    the default, exported.
    // The sets are closed under declaration before the affected files are
    // rescanned with the status they inherit.
    const scans = new Map();
    for (const path of sources) {
      const relative = path.slice(cratePath.length + 1);
      const text = safeRead(readText, path);
      const role = rustFileRole(relative);
      scans.set(relative, { path, relative, text, role, scan: scanRustSource(text, { testFile: role === 'test' }) });
    }
    const testFiles = new Set([...scans.values()].filter((entry) => entry.role === 'test').map((entry) => entry.relative));
    const privateFiles = new Set();
    let grew = true;
    while (grew) {
      grew = false;
      for (const entry of scans.values()) {
        const parentTest = testFiles.has(entry.relative);
        const parentPrivate = privateFiles.has(entry.relative);
        for (const item of entry.scan.items) {
          if (item.kind !== 'mod') continue;
          const childTest = parentTest || item.test;
          const childPrivate = parentPrivate || item.visibility !== 'pub';
          for (const candidate of childModuleFiles(entry.relative, item.name)) {
            if (!scans.has(candidate)) continue;
            if (childTest && !testFiles.has(candidate)) { testFiles.add(candidate); grew = true; }
            if (childPrivate && !privateFiles.has(candidate)) { privateFiles.add(candidate); grew = true; }
          }
        }
      }
    }
    for (const entry of scans.values()) {
      const testFile = testFiles.has(entry.relative);
      const exported = !privateFiles.has(entry.relative);
      if (testFile !== (entry.role === 'test') || !exported) entry.scan = scanRustSource(entry.text, { testFile, exported });
    }

    for (const entry of scans.values()) {
      const { path, relative, text, role, scan } = entry;
      if (relative === crateRoot) deniesUnsafe = crateDeniesUnsafe(text);
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

    const unconditional = manifest.dependencySpecs.filter((spec) => spec.table === 'dependencies' && !spec.cfg);
    const internalDeps = unconditional.map((spec) => workspacePackage(cratePath, spec)).filter(Boolean);
    const externalDeps = unconditional.filter((spec) => !workspacePackage(cratePath, spec)).map((spec) => spec.package);

    crates.push({
      name: manifest.package.name,
      path: cratePath,
      manifest: `${cratePath}/Cargo.toml`,
      description: inherit('description'),
      edition: inherit('edition'),
      version: inherit('version'),
      dependencies: unconditional.map(identity),
      internalDependencies: internalDeps,
      externalDependencies: externalDeps,
      devDependencies: listed('dev-dependencies', ''),
      buildDependencies: listed('build-dependencies', ''),
      targetDependencies: manifest.targetDependencies.map((entry) => ({
        cfg: entry.cfg,
        table: entry.table,
        names: listed(entry.table, entry.cfg)
      })),
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

/** `base/relative` with `.` and `..` folded: a dependency `path` against its crate directory. */
function resolvePath(base, relative) {
  const parts = String(base).split('/').filter(Boolean);
  for (const segment of String(relative).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}
