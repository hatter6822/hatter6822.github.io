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
 *
 * Designed boundaries, stated so they are not mistaken for gaps: the scanner
 * reads declarations, not paths, so `pub use` re-exports do not make a private
 * module's items public; a file an `include!` splices in is neither read as
 * part of the including file nor reachable through a module declaration;
 * items a macro invocation generates are invisible; one declaration is read
 * per line, the first, so a line carrying two is one; `unsafe trait`
 * declarations are not counted as sites (the three counters are `unsafe fn`,
 * `unsafe impl` and `unsafe { … }`); and `<…>` is a group only where it
 * follows an identifier or `::`, the way generics are written. Moving any of
 * these changes published figures and is a decision, not a patch.
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
 * Parse a `cfg` predicate — the text inside `cfg(…)`, string literals blanked
 * or not, since values are never inspected — into `{ name, args }` nodes:
 * `args` is null for a bare option (`test`, `loom`) or a `key = "value"`
 * pair, and a list for `all(…)`, `any(…)` and `not(…)`.
 */
function parseCfgPredicate(predicate) {
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
  return parse();
}

/**
 * Evaluate a parsed predicate for a build in which `test` has the given
 * value. Three-valued: `true` or `false` when `test` alone decides it, `null`
 * when it depends on something the inventory cannot know — a feature, a
 * target, an option it does not recognise. `all`, `any` and `not` combine
 * the three values the usual way: `all(false, ?)` is false, `any(true, ?)`
 * is true, `not(?)` is unknown. Both questions the scanner asks of a
 * predicate are answered here, so they cannot drift apart.
 */
function evaluateCfg(node, testValue) {
  if (!node) return null;
  if (node.args === null) return node.name === 'test' ? testValue : null;
  if (node.name === 'not') {
    if (node.args.length !== 1) return null;
    const inner = evaluateCfg(node.args[0], testValue);
    return inner === null ? null : !inner;
  }
  if (node.name === 'all') {
    let value = true;
    for (const arg of node.args) {
      const inner = evaluateCfg(arg, testValue);
      if (inner === false) return false;
      if (inner === null) value = null;
    }
    return value;
  }
  if (node.name === 'any') {
    let value = false;
    for (const arg of node.args) {
      const inner = evaluateCfg(arg, testValue);
      if (inner === true) return true;
      if (inner === null) value = null;
    }
    return value;
  }
  return null;
}

/**
 * Is a `cfg` predicate satisfiable only when `test` is set? It must be false
 * in every production build and not false once `test` is on: `test` and
 * `all(test, …)` are; `any(test, feature = "std")` is not, because it
 * compiles into a production build with the feature on; `not(test)` is the
 * production side of a split; `feature = "…"`, `target_arch = "…"` and
 * `loom` say nothing about tests; `any()` is dead code, not test code.
 */
export function cfgIsTestOnly(predicate) {
  const node = parseCfgPredicate(predicate);
  return evaluateCfg(node, false) === false && evaluateCfg(node, true) !== false;
}

/**
 * Does a `cfg` predicate hold in every production build, whatever the
 * features and target? `not(test)` and `any(not(test), feature = "x")` do;
 * `feature = "strict"` and `all(not(test), target_arch = "…")` may not, so
 * they do not. This is the question a crate-wide policy behind `cfg_attr`
 * has to answer.
 */
export function cfgHoldsInProduction(predicate) {
  return evaluateCfg(parseCfgPredicate(predicate), false) === true;
}

/**
 * Does an outer attribute (`#[…]`, brackets balanced) mark its item as test
 * code? `#[test]`, a test attribute macro under a path (`#[tokio::test]`),
 * and a `cfg` whose predicate is test-only.
 */
function attributeMarksTest(attribute) {
  const match = /^#\[\s*([A-Za-z_][A-Za-z0-9_:]*)\s*(?:\(([\s\S]*)\))?\s*\]$/.exec(attribute.trim());
  if (!match) return false;
  const name = match[1];
  if (name === 'test' || name.endsWith('::test')) return true;
  if (name === 'cfg' && match[2] !== undefined) return cfgIsTestOnly(match[2]);
  return false;
}

/** Does an inner attribute (`#![…]`) make its whole scope test code? `#![cfg(test)]` at the top of a file or an inline module does. */
function innerAttributeMarksTest(attribute) {
  const match = /^#!\[\s*cfg\s*\(([\s\S]*)\)\s*\]$/.exec(attribute.trim());
  return Boolean(match) && cfgIsTestOnly(match[1]);
}

/** The file a `#[path = "…"]` attribute names, read from the raw line because the scanned text has its strings blanked. */
function attributePath(rawLine) {
  const match = /#\[\s*path\s*=\s*"([^"]+)"\s*\]/.exec(String(rawLine ?? ''));
  return match ? match[1] : '';
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
 * - `items[]`: `{ kind, name, line, visibility, unsafe, module, test,
 *   exported }` in source order. `module` is the inline `mod` path the item
 *   sits in (`""` at file scope, `"tests"` inside `mod tests { … }`, nested
 *   paths joined with `::`). `test` is true for `#[test]` functions, anything
 *   under a test-only `cfg`, everything inside a module so marked, and every
 *   item when `options.testFile` is set. `exported` says whether the item is
 *   reachable from outside the crate through this file. A `mod` item also
 *   carries `inline: true` when its body is in this file and `path` when a
 *   `#[path = "…"]` attribute names its file.
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
  const rawLines = raw.split('\n');
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
  // Depths of bodies that are test code — a `#[test] fn`, a `#[cfg(test)]`
  // impl, a test module, a guarded method, a test-only initializer block:
  // `unsafe` sites inside them are test sites, whatever their depth.
  const testRegions = [];
  let depth = 0;
  // Parenthesis, bracket and generic-argument nesting: a `;`, `,` or `=`
  // inside `(…)`, `[…]` or `<…>` (`[u8; 4]`, `Lock::new(x)`, `Map<K, V>`,
  // `Iterator<Item = u8>`) ends nothing. `<` opens a group only when it
  // follows an identifier or `::`, and `>` closes one only when a group is
  // open and it is not the `>` of `->` or `=>`; a `{` or `}` resets the
  // count, so a comparison read as a generic cannot leak past its block.
  let groupDepth = 0;
  // A declaration header whose body or terminator is still to come. Once the
  // header is read only a `mod` needs it: its `{` opens a scope.
  let pendingHead = null;
  // Outer attributes read since the last construct ended, at any depth. They
  // bind to whatever comes next — an item at item scope, an associated
  // method, a `use`, a statement — and the body that construct opens, if
  // any, is a test region when `test` is set. The binding is released by the
  // `{` that opens the body, the `;` that ends the construct without one, the
  // `,` that ends a field, a variant or a match arm, or the `}` that closes
  // the enclosing body (a last field without a trailing comma); an `=`
  // completes the header only, so a test-only const or static keeps its
  // status across a block initializer on later lines. One rule for every
  // scope and every kind of construct: earlier versions bound attributes at
  // item scope only, dropped the status at `=`, or let a field's attribute
  // survive its struct, and each of those gaps filed `unsafe` sites under
  // production. (A guarded match arm whose pattern has braces spends the
  // binding on the pattern; an arm body on later lines is then plain code.)
  const pending = { test: false, macroExport: false, path: '' };
  let attributeBuffer = null;
  // An `unsafe` keyword that ended a line: the block, function or impl it
  // opens starts on the next non-blank line (`let x = unsafe` / `{ … }`).
  let pendingUnsafeToken = false;

  const releasePending = () => {
    pending.test = false;
    pending.macroExport = false;
    pending.path = '';
  };
  // `#![cfg(test)]` at the top of a file or an inline module: everything in
  // that scope is test code.
  const markScopeTest = (scope) => {
    scope.test = true;
    if (!testRegions.includes(scope.depth)) testRegions.push(scope.depth);
  };

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
        if (attribute.startsWith('#![')) {
          // An inner attribute speaks for the enclosing scope, not for the
          // next declaration.
          if (atItemScope && innerAttributeMarksTest(attribute)) markScopeTest(top);
          return;
        }
        if (attributeMarksTest(attribute)) pending.test = true;
        if (attributeExportsMacro(attribute)) pending.macroExport = true;
        if (/^#\[\s*path\s*=/.test(attribute)) pending.path = attributePath(rawLines[idx]) || pending.path;
      };
      if (attributeBuffer !== null) {
        // A multi-line attribute either closes on this line or runs past it.
        const close = attributeClose(text, bracketBalance(attributeBuffer));
        if (close < 0) { attributeBuffer += '\n' + text.trim(); continue; }
        noteAttribute(attributeBuffer + '\n' + text.slice(0, close).trim());
        attributeBuffer = null;
        text = text.slice(close);
      }
      while (/^\s*#!?\[/.test(text)) {
        const start = text.search(/\S/);
        const close = attributeClose(text, 0);
        if (close < 0) { attributeBuffer = text.slice(start); text = ''; break; }
        noteAttribute(text.slice(start, close));
        text = text.slice(close);
      }
    }

    const trimmed = text.trim();
    if (atItemScope && !pendingHead && trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('}')) {
      const match = ITEM_HEAD.exec(trimmed);
      if (match) {
        const keyword = match[1];
        const kind = keyword === 'macro_rules!' ? 'macro' : keyword;
        const rest = trimmed.slice(match.index + match[0].length);
        const head = trimmed;
        const isUnsafe = pendingUnsafeToken || /(?:^|\s)unsafe\s/.test(head.slice(0, match.index + match[0].length));
        let name;
        if (kind === 'impl') name = implName(rest);
        else if (kind === 'static') name = nameAfter(rest.replace(/^\s*mut\s+/, ''));
        else name = nameAfter(rest);
        if (name) {
          const isTest = Boolean(top.test || pending.test);
          // `#[macro_export]` publishes the macro at the crate root whatever
          // module it sits in; it is public API without a `pub`.
          const macroExported = kind === 'macro' && pending.macroExport;
          const visibility = macroExported ? 'pub' : visibilityOf(head);
          const reachable = visibility === 'pub' && (top.exported || macroExported);
          const item = {
            kind,
            name,
            line: lineNo,
            visibility,
            unsafe: isUnsafe,
            module: top.module,
            test: isTest,
            exported: reachable
          };
          if (kind === 'mod' && pending.path) item.path = pending.path;
          items.push(item);
          if (isTest) testItems += 1;
          else if (kind !== 'impl') {
            productionItems += 1;
            if (reachable) publicItems += 1;
          }
          pendingHead = { kind, name, item, test: isTest, exported: top.exported && visibility === 'pub' };
        }
        // The macro and path attributes bound to this header; `test` stays
        // pending until the body opens or the declaration ends.
        pending.macroExport = false;
        pending.path = '';
      }
    }

    // `unsafe` sites on this line, attributed to test or production code by
    // the innermost enclosing item.
    const inTest = top.test || testRegions.length > 0 || pending.test;
    const bucket = inTest ? testUnsafe : unsafeStats;
    if (pendingUnsafeToken && trimmed) {
      if (trimmed.startsWith('{')) bucket.blocks += 1;
      else if (/^fn\b/.test(trimmed)) bucket.fns += 1;
      else if (/^impl\b/.test(trimmed)) bucket.impls += 1;
      pendingUnsafeToken = false;
    }
    if (UNSAFE_FN_HEAD.test(trimmed)) bucket.fns += 1;
    else if (UNSAFE_IMPL_HEAD.test(trimmed)) bucket.impls += 1;
    const blockMatches = trimmed.match(UNSAFE_BLOCK);
    if (blockMatches) bucket.blocks += blockMatches.length;
    if (/(?:^|[^A-Za-z0-9_#])unsafe$/.test(trimmed)) pendingUnsafeToken = true;

    // Walk the line to track depth, module bodies and construct ends.
    for (let c = 0; c < text.length; c += 1) {
      const ch = text[c];
      if (ch === '(' || ch === '[') {
        groupDepth += 1;
      } else if (ch === ')' || ch === ']') {
        groupDepth = Math.max(0, groupDepth - 1);
      } else if (ch === '<' && c > 0 && /[A-Za-z0-9_:]/.test(text[c - 1])) {
        groupDepth += 1;
      } else if (ch === '>' && groupDepth > 0 && text[c - 1] !== '-' && text[c - 1] !== '=') {
        groupDepth -= 1;
      } else if (ch === '{') {
        groupDepth = 0;
        depth += 1;
        if (pending.test) testRegions.push(depth);
        if (pendingHead) {
          if (pendingHead.kind === 'mod') {
            pendingHead.item.inline = true;
            scopes.push({
              depth,
              module: top.module ? `${top.module}::${pendingHead.name}` : pendingHead.name,
              kind: 'mod',
              test: Boolean(top.test || pendingHead.test),
              exported: pendingHead.exported
            });
          }
          pendingHead = null;
        }
        releasePending();
      } else if (ch === '}') {
        groupDepth = 0;
        depth = Math.max(0, depth - 1);
        while (testRegions.length && depth < testRegions[testRegions.length - 1]) testRegions.pop();
        const current = scopes[scopes.length - 1];
        if (scopes.length > 1 && depth < current.depth) scopes.pop();
        // A last field, variant or arm without a trailing comma ends here.
        releasePending();
      } else if (ch === ',' && groupDepth === 0) {
        // A field, a variant or a match arm ends at its comma.
        releasePending();
      } else if (ch === '=' && groupDepth === 0 && pendingHead && depth === scopes[scopes.length - 1].depth) {
        // `type A = B;`, `const X: T = …;`, `static S: T = …;`: the header is
        // complete; what follows is an initializer, not a body.
        pendingHead = null;
      } else if (ch === ';' && groupDepth === 0) {
        // `mod foo;`, `struct S;`, a guarded declaration without a body
        // (`#[cfg(test)] fn helper();`), a `use`, a statement.
        if (pendingHead && depth === scopes[scopes.length - 1].depth) pendingHead = null;
        releasePending();
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
 * cannot be lifted). A `cfg_attr` counts only when its predicate holds in
 * every production build (`cfg_attr(not(test), deny(unsafe_code))`); one that
 * depends on a feature or a target (`cfg_attr(feature = "strict", …)`) is a
 * conditional policy, not the crate's, and leaves the flag alone. Comments,
 * strings and outer attributes on items are not crate policy either.
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
    // predicate holds, so only a predicate that holds in every production
    // build makes them crate policy.
    if (args.length < 2 || !cfgHoldsInProduction(args[0])) return '';
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
 * Read the TOML subset Cargo manifests are written in into a plain object:
 * tables and arrays of tables (`[a.b]`, `[[bin]]`, `[target.'cfg(…)'
 * .dependencies]`), dotted keys (`version.workspace = true`), basic and
 * literal strings on one line or three-quoted across lines, booleans,
 * numbers, arrays that may span lines with trailing commas and comments
 * inside, and inline tables. A value it cannot read is skipped rather than
 * guessed. Reading the document structurally instead of by line shape is
 * what lets `parseCargoManifest` see a `[dependencies.foo]` sub-table, a
 * dotted `foo.path = "…"` key and a one-line `members = ["a", "b"]` the way
 * Cargo does; the line-shaped reader it replaces dropped each of those.
 */
export function parseToml(source) {
  const text = String(source ?? '');
  const n = text.length;
  const root = {};
  let table = root;
  let pos = 0;
  const TRIPLE_LITERAL = "'" + "''";

  const isBare = (ch) => /[A-Za-z0-9_-]/.test(ch);
  const skipBlanks = (newlines) => {
    while (pos < n) {
      const ch = text[pos];
      if (ch === ' ' || ch === '\t' || ch === '\r' || (newlines && ch === '\n')) pos += 1;
      else if (ch === '#') { while (pos < n && text[pos] !== '\n') pos += 1; }
      else break;
    }
  };
  const skipLine = () => { while (pos < n && text[pos] !== '\n') pos += 1; };
  const readEscape = () => {
    const next = text[pos + 1];
    pos += 2;
    switch (next) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      case 'u': { const hex = text.slice(pos, pos + 4); pos += 4; return String.fromCodePoint(parseInt(hex, 16) || 0); }
      case 'U': { const hex = text.slice(pos, pos + 8); pos += 8; return String.fromCodePoint(parseInt(hex, 16) || 0); }
      case '\n': { while (pos < n && /\s/.test(text[pos])) pos += 1; return ''; }
      default: return next ?? '';
    }
  };
  const readBasicString = () => {
    const multi = text.startsWith('"""', pos);
    pos += multi ? 3 : 1;
    if (multi && text[pos] === '\n') pos += 1;
    let out = '';
    while (pos < n) {
      if (multi ? text.startsWith('"""', pos) : text[pos] === '"' || text[pos] === '\n') break;
      if (text[pos] === '\\') { out += readEscape(); continue; }
      out += text[pos];
      pos += 1;
    }
    pos += multi ? 3 : 1;
    return out;
  };
  const readLiteralString = () => {
    const multi = text.startsWith(TRIPLE_LITERAL, pos);
    const quote = multi ? TRIPLE_LITERAL : "'";
    pos += quote.length;
    if (multi && text[pos] === '\n') pos += 1;
    let end = text.indexOf(quote, pos);
    if (!multi) { const eol = text.indexOf('\n', pos); if (eol !== -1 && (end === -1 || eol < end)) end = eol; }
    const out = text.slice(pos, end === -1 ? n : end);
    pos = end === -1 ? n : end + quote.length;
    return out;
  };
  const readKeyPath = () => {
    const segments = [];
    for (;;) {
      skipBlanks(false);
      const ch = text[pos];
      if (ch === '"') segments.push(readBasicString());
      else if (ch === "'") segments.push(readLiteralString());
      else {
        const start = pos;
        while (pos < n && isBare(text[pos])) pos += 1;
        if (pos === start) break;
        segments.push(text.slice(start, pos));
      }
      skipBlanks(false);
      if (text[pos] !== '.') break;
      pos += 1;
    }
    return segments;
  };
  const readValue = () => {
    skipBlanks(false);
    const ch = text[pos];
    if (ch === '"') return readBasicString();
    if (ch === "'") return readLiteralString();
    if (ch === '[') {
      pos += 1;
      const values = [];
      for (;;) {
        skipBlanks(true);
        if (pos >= n) break;
        if (text[pos] === ']') { pos += 1; break; }
        const value = readValue();
        if (value !== undefined) values.push(value);
        skipBlanks(true);
        if (text[pos] === ',') pos += 1;
        else if (text[pos] === ']') { pos += 1; break; }
        else if (value === undefined) pos += 1;
      }
      return values;
    }
    if (ch === '{') {
      pos += 1;
      const inline = {};
      for (;;) {
        skipBlanks(true);
        if (pos >= n) break;
        if (text[pos] === '}') { pos += 1; break; }
        const key = readKeyPath();
        skipBlanks(false);
        if (text[pos] === '=' && key.length) {
          pos += 1;
          const value = readValue();
          if (value !== undefined) setTomlPath(inline, key, value);
        }
        skipBlanks(true);
        if (text[pos] === ',') pos += 1;
        else if (text[pos] === '}') { pos += 1; break; }
        else if (!key.length) pos += 1;
      }
      return inline;
    }
    const start = pos;
    while (pos < n && !/[\s,\]}#]/.test(text[pos])) pos += 1;
    const token = text.slice(start, pos);
    if (!token) return undefined;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (/^[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?$/.test(token)) return Number(token.replace(/_/g, ''));
    return token;
  };

  while (pos < n) {
    skipBlanks(true);
    if (pos >= n) break;
    if (text[pos] === '[') {
      const arrayOfTables = text.startsWith('[[', pos);
      pos += arrayOfTables ? 2 : 1;
      const path = readKeyPath();
      while (pos < n && text[pos] === ']') pos += 1;
      table = path.length ? enterTomlTable(root, path, arrayOfTables) : root;
      skipLine();
      continue;
    }
    const key = readKeyPath();
    skipBlanks(false);
    if (text[pos] === '=' && key.length) {
      pos += 1;
      const value = readValue();
      if (value !== undefined) setTomlPath(table, key, value);
    }
    skipLine();
  }
  return root;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Assign `value` at a dotted key path under `table`, creating the tables in between. */
function setTomlPath(table, path, value) {
  let target = table;
  for (const segment of path.slice(0, -1)) {
    if (!isPlainObject(target[segment])) target[segment] = {};
    target = target[segment];
  }
  target[path[path.length - 1]] = value;
}

/** The table a `[a.b]` or `[[a.b]]` header selects; an array of tables on the way means its last element. */
function enterTomlTable(root, path, arrayOfTables) {
  let target = root;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    if (index === path.length - 1 && arrayOfTables) {
      if (!Array.isArray(target[segment])) target[segment] = [];
      const entry = {};
      target[segment].push(entry);
      return entry;
    }
    if (Array.isArray(target[segment])) {
      target = target[segment][target[segment].length - 1];
    } else {
      if (!isPlainObject(target[segment])) target[segment] = {};
      target = target[segment];
    }
  }
  return target;
}

/**
 * Cargo.toml facts for the inventory, read from `parseToml`'s object:
 * `[package]` fields (a `key.workspace = true` becomes `{ workspace: true }`),
 * `[workspace] members`, `[workspace.package]`, the `[workspace.dependencies]`
 * entries members inherit, `[features]` names and what each enables
 * (`featureTable`), the `[lib]` table and the `[[bin]]`, `[[test]]`,
 * `[[bench]]` and `[[example]]` targets (their string fields, `path` among
 * them), and the
 * dependencies under `[dependencies]` / `[dev-dependencies]` /
 * `[build-dependencies]` — kept apart from the same tables scoped to a
 * target, `[target.'cfg(…)'.dependencies]`, which come back as
 * `targetDependencies: [{ cfg, table, names }]`. A target-scoped table is
 * resolved only when its predicate holds (`loom` under `cfg(loom)` enters no
 * ordinary build), so it must never be reported as an unconditional
 * dependency.
 *
 * Every dependency list carries package identities: the table key, unless
 * the entry renames the package (`alias = { package = "actual", … }`), in
 * which case `actual`. `dependencySpecs` keeps each entry whole — `{ table,
 * cfg, name, package, path, workspace, optional }` — for the caller to
 * resolve against the workspace; `workspace` marks an entry written
 * `{ workspace = true }`, whose package and path live in the root manifest's
 * `workspaceDependencies`, and `optional` one that a feature has to enable.
 */
export function parseCargoManifest(source) {
  const toml = parseToml(source);
  const out = {
    package: {},
    workspacePackage: {},
    workspaceDependencies: {},
    lib: {},
    tests: [],
    benches: [],
    examples: [],
    featureTable: {},
    members: [],
    exclude: [],
    dependencies: [],
    devDependencies: [],
    buildDependencies: [],
    targetDependencies: [],
    dependencySpecs: [],
    features: [],
    bins: []
  };
  const tableOf = (value) => (isPlainObject(value) ? value : {});

  for (const [key, value] of Object.entries(tableOf(toml.package))) {
    if (typeof value === 'string' || typeof value === 'boolean') out.package[key] = value;
    else if (isPlainObject(value) && value.workspace === true) out.package[key] = { workspace: true };
  }
  const workspace = tableOf(toml.workspace);
  if (Array.isArray(workspace.members)) out.members = workspace.members.filter((member) => typeof member === 'string');
  if (Array.isArray(workspace.exclude)) out.exclude = workspace.exclude.filter((entry) => typeof entry === 'string');
  for (const [key, value] of Object.entries(tableOf(workspace.package))) {
    if (typeof value === 'string') out.workspacePackage[key] = value;
  }
  for (const [key, value] of Object.entries(tableOf(workspace.dependencies))) {
    out.workspaceDependencies[key] = dependencySpec(key, value, 'workspace', '');
  }
  out.features = Object.keys(tableOf(toml.features));
  for (const [feature, enables] of Object.entries(tableOf(toml.features))) {
    out.featureTable[feature] = Array.isArray(enables) ? enables.filter((entry) => typeof entry === 'string') : [];
  }
  const stringFields = (entry) => Object.fromEntries(Object.entries(entry).filter(([, value]) => typeof value === 'string'));
  const targets = (key) => (Array.isArray(toml[key]) ? toml[key].filter(isPlainObject).map(stringFields) : []);
  out.lib = stringFields(tableOf(toml.lib));
  out.bins = targets('bin');
  out.tests = targets('test');
  out.benches = targets('bench');
  out.examples = targets('example');

  const listed = { dependencies: out.dependencies, 'dev-dependencies': out.devDependencies, 'build-dependencies': out.buildDependencies };
  for (const name of DEPENDENCY_TABLES) {
    for (const [key, value] of Object.entries(tableOf(toml[name]))) {
      const spec = dependencySpec(key, value, name, '');
      out.dependencySpecs.push(spec);
      listed[name].push(spec.package);
    }
  }
  for (const [cfg, scoped] of Object.entries(tableOf(toml.target))) {
    for (const name of DEPENDENCY_TABLES) {
      if (!isPlainObject(scoped) || !isPlainObject(scoped[name])) continue;
      const entry = { cfg, table: name, names: [] };
      out.targetDependencies.push(entry);
      for (const [key, value] of Object.entries(scoped[name])) {
        const spec = dependencySpec(key, value, name, cfg);
        out.dependencySpecs.push(spec);
        entry.names.push(spec.package);
      }
    }
  }
  return out;
}

/**
 * One dependency entry: the table key it is declared under (`name`), the
 * package it resolves to (`package` — the key unless the entry renames it
 * with `package = "…"`), its `path` if any, whether it inherits the
 * workspace's entry (`{ workspace = true }`), and whether it is `optional`,
 * that is, compiled only when a feature enables it.
 */
function dependencySpec(name, value, table, cfg) {
  const spec = { table, cfg, name, package: name, path: '', workspace: false, optional: false };
  if (isPlainObject(value)) {
    if (typeof value.package === 'string') spec.package = value.package;
    if (typeof value.path === 'string') spec.path = value.path;
    if (value.workspace === true) spec.workspace = true;
    if (value.optional === true) spec.optional = true;
  }
  return spec;
}

/**
 * The features that enable an optional dependency: every `[features]` entry
 * that lists `dep:<name>`, `<name>` or `<name>/…` (`<name>?/…`), or — when no
 * feature uses the `dep:` syntax for it — the implicit feature Cargo creates
 * with the dependency's own name.
 */
export function enablingFeatures(featureTable, name) {
  const table = isPlainObject(featureTable) ? featureTable : {};
  const explicit = [];
  let usesDepSyntax = false;
  for (const [feature, enables] of Object.entries(table)) {
    const list = Array.isArray(enables) ? enables : [];
    if (list.includes(`dep:${name}`)) usesDepSyntax = true;
    if (list.some((entry) => entry === `dep:${name}` || entry === name || entry.startsWith(`${name}/`) || entry.startsWith(`${name}?/`))) explicit.push(feature);
  }
  if (!usesDepSyntax && !explicit.includes(name)) explicit.unshift(name);
  return explicit;
}

/** A conventional binary target: `src/main.rs`, `src/bin/<name>.rs` or `src/bin/<name>/main.rs`. */
const CONVENTIONAL_BIN = /^src\/(?:main\.rs|bin\/[^/]+\.rs|bin\/[^/]+\/main\.rs)$/;

/** A conventional test, bench or example target: `tests/<name>.rs` or `tests/<name>/main.rs`, likewise under `benches/` and `examples/`. */
const CONVENTIONAL_TEST_ROOT = /^(?:tests|benches|examples)\/(?:[^/]+\.rs|[^/]+\/main\.rs)$/;

/**
 * The crate roots Cargo would build for a package, from its manifest and its
 * source list (paths relative to the crate): the library root (`[lib] path`,
 * else `src/lib.rs` unless `autolib = false`), the binary roots (every
 * `[[bin]] path`, and unless `autobins = false` the conventional
 * `src/main.rs`, `src/bin/<name>.rs` and `src/bin/<name>/main.rs`), and the
 * test roots the manifest declares outside the conventional directories
 * (`[[test]]`, `[[bench]]`, `[[example]]` paths). Any other file under
 * `src/bin/<name>/` is a module of that binary, not a root, and a
 * `src/main.rs` left behind under `autobins = false` is a module Cargo never
 * builds as a target. This is the one place those rules live; roles, module
 * paths, module resolution and `deniesUnsafe` all follow from it.
 */
export function cargoTargets(manifest, relativeSources) {
  const present = new Set((relativeSources || []).map(String));
  const pkg = manifest.package || {};
  const declaredLib = manifest.lib && manifest.lib.path && present.has(manifest.lib.path) ? manifest.lib.path : '';
  const lib = declaredLib || (pkg.autolib !== false && present.has('src/lib.rs') ? 'src/lib.rs' : '');
  const bins = [];
  const add = (path) => { if (path && present.has(path) && !bins.includes(path)) bins.push(path); };
  if (pkg.autobins !== false) add('src/main.rs');
  for (const bin of manifest.bins || []) add(bin.path);
  if (pkg.autobins !== false) {
    for (const path of [...present].sort()) if (CONVENTIONAL_BIN.test(path)) add(path);
  }
  const tests = [];
  for (const target of [...(manifest.tests || []), ...(manifest.benches || []), ...(manifest.examples || [])]) {
    if (target.path && present.has(target.path) && !tests.includes(target.path)) tests.push(target.path);
  }
  return { lib, bins, tests };
}

/** Is a crate-relative path one of the crate's target roots (a library, binary or test crate of its own)? */
export function isTargetRoot(relativePath, roots) {
  const path = String(relativePath ?? '');
  if (roots) {
    return path === roots.lib || (Array.isArray(roots.bins) && roots.bins.includes(path))
      || (Array.isArray(roots.tests) && roots.tests.includes(path)) || CONVENTIONAL_TEST_ROOT.test(path);
  }
  return path === 'src/lib.rs' || CONVENTIONAL_BIN.test(path) || CONVENTIONAL_TEST_ROOT.test(path);
}

/**
 * Classify a Rust source path within its crate. With `roots` — `cargoTargets`'
 * answer, `{ lib, bins, tests }` — the target set decides: a `[[bin]] path =
 * "tool/runner.rs"` is a binary root, a `[[test]] path` is test code, a file
 * nested under a directory-style binary (`src/bin/tool/helper.rs`) is a
 * module of that binary, and a `src/main.rs` the manifest turned off with
 * `autobins = false` is a module. Without `roots` the conventional paths
 * decide.
 */
export function rustFileRole(relativePath, roots) {
  const path = String(relativePath ?? '');
  if (roots) {
    if (roots.lib && path === roots.lib) return 'lib';
    if (Array.isArray(roots.bins) && roots.bins.includes(path)) return 'bin';
    if (Array.isArray(roots.tests) && roots.tests.includes(path)) return 'test';
  } else {
    if (path === 'src/lib.rs') return 'lib';
    if (CONVENTIONAL_BIN.test(path)) return 'bin';
  }
  if (path === 'build.rs') return 'build';
  if (/^tests\//.test(path) || /^benches\//.test(path) || /^examples\//.test(path)) return 'test';
  return 'module';
}

/**
 * The Rust module path of a source file inside its crate, relative to the
 * directory its crate root owns: `src/args/mod.rs` and `src/args.rs` are both
 * `args`; `src/args/tcb.rs` is `args::tcb`; a crate root (`src/lib.rs`, a
 * binary, a root the manifest declares) is `""`; `src/bin/tool/helper.rs` is
 * `helper` of the binary `src/bin/tool/main.rs`; `tool/args.rs` is `args`
 * of a declared root `tool/runner.rs`.
 */
export function rustModulePath(relativePath, roots) {
  const path = String(relativePath ?? '');
  if (!/\.rs$/.test(path)) return '';
  const rootFiles = roots ? [roots.lib, ...(Array.isArray(roots.bins) ? roots.bins : [])].filter(Boolean) : [];
  if (roots ? rootFiles.includes(path) : (path === 'src/lib.rs' || CONVENTIONAL_BIN.test(path))) return '';
  const owners = rootFiles.map((file) => file.replace(/\/[^/]*$/, '')).filter((dir) => dir && path.startsWith(`${dir}/`));
  const binDir = roots ? null : /^(src\/bin\/[^/]+)\//.exec(path);
  if (binDir) owners.push(binDir[1]);
  if (path.startsWith('src/')) owners.push('src');
  if (!owners.length) return '';
  const owner = owners.sort((a, b) => b.length - a.length)[0];
  const parts = path.slice(owner.length + 1, -3).split('/');
  if (parts[parts.length - 1] === 'mod') parts.pop();
  return parts.join('::');
}

/**
 * The target root a file's module path is measured from.
 *
 * `rustModulePath` picks the deepest owning directory and then throws away
 * which root that was, so a nested binary module (`src/bin/tool/helper.rs`,
 * module path `helper`) was indistinguishable from a library module and the
 * code map hung it off the library root — showing the library as declaring a
 * binary's module. Returns the root file, or '' when the path is itself a root
 * or belongs to none.
 */
export function rustModuleTarget(relativePath, roots) {
  const path = String(relativePath ?? '');
  if (!/\.rs$/.test(path)) return '';
  const rootFiles = roots ? [roots.lib, ...(Array.isArray(roots.bins) ? roots.bins : [])].filter(Boolean) : [];
  if (rootFiles.includes(path)) return '';

  // Deepest owning root wins, the same rule rustModulePath applies: a file
  // under `src/bin/tool/` belongs to that binary, not to `src/lib.rs`.
  const owned = rootFiles
    .map((file) => ({ file, dir: file.replace(/\/[^/]*$/, '') }))
    .filter(({ dir }) => dir && path.startsWith(`${dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length);

  return owned.length ? owned[0].file : '';
}

/**
 * Where an out-of-line module declared in `relativePath` may live: `mod x;`
 * in a crate root (`src/lib.rs`, `src/main.rs`, a binary under `src/bin/`,
 * a root the manifest declares — `options.root`) or in a `mod.rs` resolves
 * next to the declaring file; in any other file it resolves inside that
 * file's own directory (`src/foo.rs` → `src/foo/x.rs`). `modulePath` is the
 * inline-module path the declaration sits in and `pathAttribute` a
 * `#[path = "…"]` on it.
 */
export function childModuleFiles(relativePath, name, modulePath = '', pathAttribute = '', options = {}) {
  const parts = String(relativePath ?? '').split('/');
  const file = parts.pop();
  const dir = parts.join('/');
  // Explicit knowledge of the file's root status wins; without it the
  // conventional names decide.
  const modRs = options.root !== undefined
    ? Boolean(options.root) || file === 'mod.rs'
    : file === 'lib.rs' || file === 'main.rs' || file === 'mod.rs' || CONVENTIONAL_BIN.test(String(relativePath ?? ''));
  const anchor = modRs ? dir : [dir, file.replace(/\.rs$/, '')].filter(Boolean).join('/');
  // Declared inside inline modules (`mod outer { mod support; }`), the file
  // sits one directory deeper per enclosing module: `src/outer/support.rs`.
  const nested = String(modulePath ?? '').split('::').filter(Boolean).map(bareIdentifier);
  if (pathAttribute) {
    // `#[path = "…"]`: at file scope the path is relative to the source
    // file's directory; inside inline modules, to the directory those
    // modules would own (for a non-mod-rs file, under its own name).
    const base = (nested.length ? [anchor, ...nested] : [dir]).filter(Boolean).join('/');
    return [resolvePath(base, pathAttribute)];
  }
  const base = [anchor, ...nested].filter(Boolean).join('/');
  const prefix = base ? `${base}/` : '';
  const stem = bareIdentifier(name);
  return [`${prefix}${stem}.rs`, `${prefix}${stem}/mod.rs`];
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
 * `deniesUnsafe` is read from the crate root alone — the library root, or
 * for a package without one its first binary root, as `cargoTargets` finds
 * them — by `crateDeniesUnsafe`. A `#![deny(unsafe_code)]` in a `src/bin/*.rs`
 * target speaks for that binary, which is its own crate, not for the library.
 *
 * Packages are discovered at any depth under the root and ordered by the
 * workspace's `members` (globs expanded); a dependency is internal only when
 * its path resolves to a member's directory, and the lists carry package
 * identities, so a renamed dependency reads as the crate it is.
 */
export function buildRustInventory(files, readText, options = {}) {
  const root = String(options.root ?? 'rust');
  const list = Array.isArray(files) ? files.map(String) : [];
  const rootManifestPath = `${root}/Cargo.toml`;
  const hasRoot = list.includes(rootManifestPath);
  const rootManifest = hasRoot ? parseCargoManifest(safeRead(readText, rootManifestPath)) : parseCargoManifest('');

  // Every package under the root, at any depth — `crates/app/Cargo.toml` is
  // a valid member path — skipping build output. Ordered by `[workspace]
  // members`, which Cargo lets be globs (`crates/*`), then the packages the
  // workspace does not list, by path.
  const rootPrefix = `${root}/`;
  const packageDirs = [];
  for (const path of list) {
    if (!path.startsWith(rootPrefix) || !path.endsWith('/Cargo.toml') || path === rootManifestPath) continue;
    const dir = path.slice(rootPrefix.length, -'/Cargo.toml'.length);
    if (dir.split('/').includes('target')) continue;
    packageDirs.push(dir);
  }
  packageDirs.sort();
  // `[workspace] exclude` removes a package from the workspace even when a
  // member glob matches it; Cargo treats it as an independent package, so
  // the inventory leaves it out and its files stay workspace files.
  const excluded = rootManifest.exclude.map(globToRegExp);
  const workspaceDirs = packageDirs.filter((dir) => !excluded.some((matcher) => matcher.test(dir)));
  const memberDirs = [];
  for (const pattern of rootManifest.members) {
    const matcher = globToRegExp(pattern);
    for (const dir of workspaceDirs) if (matcher.test(dir) && !memberDirs.includes(dir)) memberDirs.push(dir);
  }
  // A non-virtual workspace — `rust/Cargo.toml` carrying `[package]` as well
  // as `[workspace]` — has the root directory (`.`) as a member too, listed
  // or not, and it comes first.
  const rootPackage = rootManifest.package.name ? ['.'] : [];
  const orderedDirs = [...rootPackage, ...memberDirs, ...workspaceDirs.filter((dir) => !memberDirs.includes(dir))];
  const crateDirPath = (dir) => (dir === '.' ? root : `${root}/${dir}`);

  // Every manifest first, because dependency edges resolve against the
  // members' directories: an entry is internal only when its `path` — its
  // own, or the one it inherits through `[workspace.dependencies]` —
  // resolves to a member's directory. That is the one way Cargo resolves a
  // dependency to a workspace member; a registry dependency that happens to
  // share a member's name (`util = "1"`) stays external, and the table key
  // is never compared with directory names.
  const manifests = new Map(orderedDirs.map((dir) => [dir, dir === '.' ? rootManifest : parseCargoManifest(safeRead(readText, `${root}/${dir}/Cargo.toml`))]));
  const packagesByPath = new Map();
  for (const [dir, manifest] of manifests) {
    if (manifest.package.name) packagesByPath.set(crateDirPath(dir), manifest.package.name);
  }
  // An entry written `{ workspace = true }` takes its package and path from
  // the root manifest's `[workspace.dependencies]`, relative to the root.
  const inherited = (spec) => (spec.workspace && rootManifest.workspaceDependencies[spec.name]) || null;
  const workspacePackage = (cratePath, spec) => {
    const source = inherited(spec) || spec;
    const base = inherited(spec) ? root : cratePath;
    if (!source.path) return '';
    return packagesByPath.get(resolvePath(base, source.path)) || '';
  };

  const crates = [];
  for (const dir of orderedDirs) {
    const cratePath = crateDirPath(dir);
    const manifest = manifests.get(dir);
    if (!manifest.package.name) continue;
    // Dependency lists by package identity, resolved against the workspace.
    const identity = (spec) => workspacePackage(cratePath, spec) || (inherited(spec) || spec).package;
    const listed = (table, cfg) => manifest.dependencySpecs.filter((spec) => spec.table === table && spec.cfg === cfg).map(identity);

    const inherit = (key) => {
      const value = manifest.package[key];
      if (value && typeof value === 'object' && value.workspace) return rootManifest.workspacePackage[key] ?? '';
      return typeof value === 'string' ? value : '';
    };

    // The crate's sources: every `.rs` under its directory that is not inside
    // a package nested deeper (which Cargo treats as its own package).
    const nested = orderedDirs.filter((other) => other !== dir && (dir === '.' || other.startsWith(`${dir}/`))).map((other) => `${crateDirPath(other)}/`);
    const sources = list
      .filter((path) => path.startsWith(`${cratePath}/`) && /\.rs$/.test(path) && !nested.some((prefix) => path.startsWith(prefix)))
      .sort();
    // The crate roots Cargo would build (`cargoTargets`). `deniesUnsafe` is
    // read from the library root, or — for a package without one — its
    // first binary root.
    const roots = cargoTargets(manifest, sources.map((path) => path.slice(cratePath.length + 1)));
    const crateRoot = roots.lib || roots.bins[0] || '';

    const crateFiles = [];
    let lines = 0;
    let itemTotal = 0;
    let publicTotal = 0;
    let testTotal = 0;
    const unsafeTotal = emptyUnsafe();
    const testUnsafeTotal = emptyUnsafe();
    let deniesUnsafe = false;

    // First pass: every source by its path role. Then resolve out-of-line
    // module declarations (`mod x;`) to their files the way rustc does —
    // under the directory the declaring file owns, one level deeper per
    // enclosing inline module (`mod outer { mod x; }` is `outer/x.rs`), or
    // the file a `#[path = "…"]` names — and carry two things down that
    // path:
    //  - test-only status: `#[cfg(test)] mod tests;` names an ordinary module
    //    by path, but everything in `src/tests.rs` is test code, as is every
    //    module it declares in turn;
    //  - export status: `pub` items in a file reached through a private
    //    `mod detail;`, or through a `pub mod` inside a private inline
    //    module, are not public API, so `publicItems` must not count them.
    // Files nothing declares (crate roots, binaries) keep the default,
    // exported. The sets are closed under declaration before the affected
    // files are rescanned with the status they inherit.
    const scans = new Map();
    for (const path of sources) {
      const relative = path.slice(cratePath.length + 1);
      const text = safeRead(readText, path);
      const role = rustFileRole(relative, roots);
      scans.set(relative, { path, relative, text, role, scan: scanRustSource(text, { testFile: role === 'test' }) });
    }
    const testFiles = new Set([...scans.values()].filter((entry) => entry.role === 'test').map((entry) => entry.relative));
    // Export status is reachability: a target root is exported, and so is a
    // file an exported file declares with a `pub mod` under `pub` inline
    // modules. A file nothing declares — stale, generated input, `include!`d
    // — is unreachable, so its `pub` items are not public API. (A crate root
    // resolves `mod x;` beside itself; any other file under a directory of
    // its own name.)
    //
    // Compilation reachability is a second, wider set: a file any `mod`
    // declaration reaches, whatever its visibility. Every exported file is
    // compiled, but not the reverse — a file behind a private `mod` is
    // compiled and is not public API. The two must be tracked apart: the code
    // map draws the *compiled* module tree, so an orphan must not appear
    // there, while the boundary index needs the narrower export set.
    const rootFile = (relative) => isTargetRoot(relative, roots) || relative === 'build.rs';
    const exportedFiles = new Set([...scans.keys()].filter(rootFile));
    const reachedFiles = new Set([...scans.keys()].filter(rootFile));
    let grew = true;
    while (grew) {
      grew = false;
      for (const entry of scans.values()) {
        const parentTest = testFiles.has(entry.relative);
        const parentExported = exportedFiles.has(entry.relative);
        const parentReached = reachedFiles.has(entry.relative);
        for (const item of entry.scan.items) {
          // Out-of-line declarations only: an inline `mod tests { … }` names
          // no file, so a same-named file elsewhere must not inherit from it.
          if (item.kind !== 'mod' || item.inline) continue;
          const childTest = parentTest || item.test;
          const childExported = parentExported && item.exported;
          for (const candidate of childModuleFiles(entry.relative, item.name, item.module, item.path, { root: rootFile(entry.relative) })) {
            if (!scans.has(candidate)) continue;
            if (childTest && !testFiles.has(candidate)) { testFiles.add(candidate); grew = true; }
            if (childExported && !exportedFiles.has(candidate)) { exportedFiles.add(candidate); grew = true; }
            if (parentReached && !reachedFiles.has(candidate)) { reachedFiles.add(candidate); grew = true; }
          }
        }
      }
    }
    for (const entry of scans.values()) {
      const testFile = testFiles.has(entry.relative);
      const exported = exportedFiles.has(entry.relative);
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
        /* `pub` is syntax; `exported` is reachability — every enclosing inline
           module `pub` and the file itself reached through `pub mod` from a
           target root. The scanner already computed it for `publicItems` and
           then dropped it here, so consumers had only the syntactic flag: the
           code map published boundary links for `pub` constants sitting in a
           private module (`sele4n-hal`'s `error_code::VM_FAULT`), which are
           crate-private implementation details, not shared API. */
        exported: Boolean(item.exported),
        ...(item.unsafe ? { unsafe: true } : {}),
        ...(item.module ? { module: item.module } : {}),
        ...(item.test ? { test: true } : {})
      }));
      crateFiles.push({
        path,
        relativePath: relative,
        modulePath: rustModulePath(relative, roots),
        /* Which target root that module path is measured from. Absent for a
           root itself. */
        ...(rustModuleTarget(relative, roots) ? { target: rustModuleTarget(relative, roots) } : {}),
        /* Whether any Cargo target reaches this file through `mod`
           declarations. A file nothing declares — stale, generated input,
           `include!`d — is listed in the inventory but compiles into nothing,
           so the code map must not draw it as part of the module tree. */
        reachable: reachedFiles.has(relative),
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

    // Only an unconditional entry is an edge Cargo always resolves; an
    // `optional = true` entry is compiled when a feature enables it, so it
    // is listed apart with the features that do.
    const declared = manifest.dependencySpecs.filter((spec) => spec.table === 'dependencies' && !spec.cfg);
    const unconditional = declared.filter((spec) => !spec.optional);
    const internalDeps = unconditional.map((spec) => workspacePackage(cratePath, spec)).filter(Boolean);
    const externalDeps = unconditional.filter((spec) => !workspacePackage(cratePath, spec)).map(identity);
    const optionalDeps = declared.filter((spec) => spec.optional).map((spec) => ({
      package: identity(spec),
      internal: Boolean(workspacePackage(cratePath, spec)),
      features: enablingFeatures(manifest.featureTable, spec.name)
    }));

    crates.push({
      name: manifest.package.name,
      path: cratePath,
      manifest: `${cratePath}/Cargo.toml`,
      description: inherit('description'),
      edition: inherit('edition'),
      version: inherit('version'),
      dependencies: declared.map(identity),
      internalDependencies: internalDeps,
      externalDependencies: externalDeps,
      optionalDependencies: optionalDeps,
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

/** A Cargo member glob (`crates/*`, `tools/**`) as an anchored regular expression over a package directory. */
function globToRegExp(pattern) {
  const source = String(pattern ?? '')
    .replace(/\/+$/, '')
    .split(/(\*\*|\*|\?)/)
    .map((piece) => (piece === '**' ? '.*' : piece === '*' ? '[^/]*' : piece === '?' ? '[^/]' : escapeRegExp(piece)))
    .join('');
  return new RegExp(`^${source}$`);
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
