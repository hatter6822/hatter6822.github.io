import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUST_COUNTED_KINDS,
  buildRustInventory,
  cfgHoldsInProduction,
  cfgIsTestOnly,
  childModuleFiles,
  crateDeniesUnsafe,
  parseCargoManifest,
  parseToml,
  rustFileRole,
  rustModulePath,
  scanRustSource,
  stripRustCommentsAndStrings
} from './rust-analysis.mjs';

test('stripRustCommentsAndStrings blanks comments and strings but keeps line numbers', () => {
  const source = [
    '// SPDX-License-Identifier: GPL-3.0-or-later',
    '//! crate docs with a fake `pub fn nope()` in it',
    '/* block',
    '   /* nested */ still comment pub struct Nope; */',
    'const GREETING: &str = "pub fn inside_a_string() {";',
    'const RAW: &str = r#"also "quoted" pub struct X;"#;',
    'const BYTES: &[u8] = b"pub enum Y {";',
    "const QUOTE: char = '\"';",
    "fn lifetimes<'a>(x: &'a str) -> &'a str { x }"
  ].join('\n');

  const stripped = stripRustCommentsAndStrings(source);
  const lines = stripped.split('\n');
  assert.equal(lines.length, 9, 'line structure must be preserved');
  assert.ok(!stripped.includes('nope'), 'line comment content must be removed');
  assert.ok(!stripped.includes('Nope'), 'nested block comment content must be removed');
  assert.ok(!stripped.includes('inside_a_string'), 'string literal content must be removed');
  assert.ok(!stripped.includes('quoted'), 'raw string content must be removed');
  assert.ok(!stripped.includes('enum Y'), 'byte string content must be removed');
  assert.equal(lines[7], "const QUOTE: char = '';", 'a char literal holding a quote must not open a string');
  assert.equal(lines[8], "fn lifetimes<'a>(x: &'a str) -> &'a str { x }", 'lifetimes are not literals');
});

test('scanRustSource lists file-scope items with kind, visibility, line and unsafe', () => {
  const source = [
    '#![no_std]',
    '#![deny(unsafe_code)]',
    '',
    'pub mod ipc;',
    'mod private_helper;',
    '',
    '/// Docs mentioning `pub fn decoy()`.',
    '#[inline]',
    'pub fn endpoint_send(ep: CPtr) -> KernelResult<()> {',
    '    let inner = || { fn nested() {} };',
    '    Ok(())',
    '}',
    '',
    'pub(crate) fn helper() {}',
    'pub const fn zero() -> u64 { 0 }',
    'pub unsafe fn raw_syscall() {}',
    'unsafe fn hidden_raw() {}',
    'pub extern "C" fn exported() {}',
    '',
    '#[repr(transparent)]',
    'pub struct ThreadId(u64);',
    'pub struct Unit;',
    'pub enum SyscallId { A = 0, B = 1 }',
    'pub union Bits { a: u32, b: f32 }',
    'pub trait Sealed { type Assoc; fn method(&self); }',
    'pub type KernelResult<T> = Result<T, KernelError>;',
    'pub const MAX: usize = 4;',
    'pub static mut COUNTER: u64 = 0;',
    'static TABLE: [u8; 4] = [0; 4];',
    '',
    'impl ThreadId {',
    '    pub fn raw(self) -> u64 { self.0 }',
    '}',
    'impl<T: Copy> Clone for Wrapper<T> where T: Default {',
    '    fn clone(&self) -> Self { *self }',
    '}',
    'unsafe impl Send for Bits {}',
    '',
    'macro_rules! kprint {',
    '    ($($arg:tt)*) => {{ let _ = unsafe { 1 }; }};',
    '}',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    use super::*;',
    '    #[test]',
    '    fn roundtrip() { unsafe { core::ptr::read(&0u8) }; }',
    '    mod inner {',
    '        pub fn deep() {}',
    '    }',
    '}'
  ].join('\n');

  const scan = scanRustSource(source);
  const byName = Object.fromEntries(scan.items.map((item) => [item.name, item]));

  assert.deepEqual(
    scan.items.map((item) => `${item.kind}:${item.name}`),
    [
      'mod:ipc', 'mod:private_helper',
      'fn:endpoint_send', 'fn:helper', 'fn:zero', 'fn:raw_syscall', 'fn:hidden_raw', 'fn:exported',
      'struct:ThreadId', 'struct:Unit', 'enum:SyscallId', 'union:Bits', 'trait:Sealed',
      'type:KernelResult', 'const:MAX', 'static:COUNTER', 'static:TABLE',
      'impl:ThreadId', 'impl:Clone for Wrapper<T>', 'impl:Send for Bits',
      'macro:kprint',
      'mod:tests', 'fn:roundtrip', 'mod:inner', 'fn:deep'
    ]
  );

  assert.equal(byName.endpoint_send.line, 9, 'attribute and doc lines must not shift the anchor');
  assert.equal(byName.endpoint_send.visibility, 'pub');
  assert.equal(byName.helper.visibility, 'pub(crate)');
  assert.equal(byName.hidden_raw.visibility, 'private');
  assert.equal(byName.raw_syscall.unsafe, true);
  assert.equal(byName.zero.unsafe, false);
  assert.equal(byName.COUNTER.name, 'COUNTER', '`static mut` must name the item, not the modifier');
  assert.ok(!byName.raw, 'methods inside impl blocks are not items');
  assert.ok(!byName.nested, 'items nested in function bodies are not reported');
  assert.ok(!byName.method, 'trait members are not file-scope items');
  assert.equal(byName.roundtrip.module, 'tests', 'inline module items carry their module path');
  assert.equal(byName.deep.module, 'tests::inner');
  assert.equal(byName.deep.visibility, 'pub');
  assert.equal(byName.tests.test, true, '`#[cfg(test)]` marks the module as test code');
  assert.equal(byName.roundtrip.test, true, 'everything inside a test module is test code');
  assert.equal(byName.deep.test, true, 'nested modules inherit the test marking');
  assert.equal(byName.endpoint_send.test, false, 'an `#[inline]` attribute is not a test marker');
  assert.equal(byName.kprint.test, false);

  // 21 items outside the test module, of which 3 are impl blocks; every
  // pub item at file scope counts as public.
  assert.equal(scan.productionItems, 18, 'impl blocks are listed but not counted');
  assert.equal(scan.publicItems, 13);
  assert.equal(scan.testItems, 4);
  assert.deepEqual(scan.unsafe, { fns: 2, impls: 1, blocks: 1 }, 'the macro body block is production code');
  assert.deepEqual(scan.testUnsafe, { fns: 0, impls: 0, blocks: 1 }, 'the block inside the test module is test code');
  assert.equal(scan.lines, 51);
});

test('scanRustSource counts unsafe methods and nested unsafe impls, split from test code', () => {
  const scan = scanRustSource([
    'pub struct PageTableCell(u8);',
    'unsafe impl Sync for PageTableCell {}',
    'impl PageTableCell {',
    '    /// Caller must hold the lock.',
    '    pub unsafe fn with_inner_mut<F, R>(&self, f: F) -> R',
    '    where F: FnOnce() -> R {',
    '        unsafe { f() }',
    '    }',
    '    pub fn safe(&self) { let _: unsafe fn(u8) = other; }',
    '}',
    'pub trait Raw {',
    '    unsafe fn read(&self) -> u8;',
    '}',
    'pub fn helper() {',
    '    struct Shared(u8);',
    '    unsafe impl Sync for Shared {}',
    '    unsafe { core::ptr::read(&0u8) };',
    '}',
    '#[cfg(test)]',
    'impl PageTableCell {',
    '    pub unsafe fn test_only(&self) { unsafe { } }',
    '}',
    '#[cfg(test)]',
    'mod tests {',
    '    struct Shared(u8);',
    '    unsafe impl Sync for Shared {}',
    '    #[test]',
    '    fn t() { unsafe { } }',
    '}',
    '#[test]',
    'fn direct() {',
    '    unsafe { }',
    '}'
  ].join('\n'));
  assert.deepEqual(scan.unsafe, { fns: 2, impls: 2, blocks: 2 }, 'a method and a trait method; a file-scope and a fn-local impl; two blocks — the fn-pointer type is not a site');
  assert.deepEqual(scan.testUnsafe, { fns: 1, impls: 1, blocks: 3 }, 'sites under #[cfg(test)] impl, in the test module and in a #[test] fn are test sites');
});

test('scanRustSource tolerates multi-line signatures and where clauses', () => {
  const source = [
    'pub fn acquire_kernel_entry_in(',
    '    lock: &TicketLock,',
    '    core_id: usize,',
    ') -> Result<(), Error>',
    'where',
    '    Error: Default,',
    '{',
    '    fn not_an_item() {}',
    '    Ok(())',
    '}',
    'pub fn after() {}'
  ].join('\n');

  const scan = scanRustSource(source);
  assert.deepEqual(scan.items.map((item) => item.name), ['acquire_kernel_entry_in', 'after']);
  assert.equal(scan.items[1].line, 11);
});

test('cfgIsTestOnly reads the predicate rather than searching for the word test', () => {
  assert.equal(cfgIsTestOnly('test'), true);
  assert.equal(cfgIsTestOnly('all(test, feature = "std")'), true);
  assert.equal(cfgIsTestOnly('any(test, loom)'), false, 'any(test, …) compiles into a production build');
  assert.equal(cfgIsTestOnly('any(feature = "hw_target", test)'), false);
  assert.equal(cfgIsTestOnly('not(test)'), false, 'not(test) is the production side of a split');
  assert.equal(cfgIsTestOnly('any(not(target_arch = "aarch64"), test)'), false);
  assert.equal(cfgIsTestOnly('all(any(test, feature = "x"), test)'), true);
  assert.equal(cfgIsTestOnly('feature = "test-utils"'), false, 'a feature named after tests is not the test cfg');
  assert.equal(cfgIsTestOnly('test_harness'), false);
  assert.equal(cfgIsTestOnly(''), false);
  assert.equal(cfgIsTestOnly('any()'), false);
});

test('scanRustSource marks #[test] functions and test-only cfg attributes, and only those', () => {
  const scan = scanRustSource([
    '#[test]',
    'fn direct() {}',
    '#[cfg(any(test, feature = "std"))]',
    'pub fn host_and_std() {}',
    '#[cfg(all(test, feature = "std"))]',
    'pub fn std_tests_only() {}',
    '#[cfg(not(test))]',
    'pub fn production_side() {}',
    '#[cfg(feature = "test-utils")]',
    'pub fn utils() {}',
    '#[cfg(',
    '    any(feature = "hw_target", test)',
    ')]',
    'const LEAN_DECLARED_CORE_COUNT: u32 = 4;',
    '#[cfg_attr(test, derive(Debug))]',
    'pub struct Attr;',
    '#[inline]',
    'pub fn production() {}'
  ].join('\n'));
  assert.deepEqual(scan.items.map((item) => [item.name, item.test]), [
    ['direct', true],
    ['host_and_std', false],
    ['std_tests_only', true],
    ['production_side', false],
    ['utils', false],
    ['LEAN_DECLARED_CORE_COUNT', false],
    ['Attr', false],
    ['production', false]
  ]);
});

test('scanRustSource counts public items only where every enclosing module is pub', () => {
  const scan = scanRustSource([
    'pub mod args {',
    '    pub fn decode() {}',
    '    fn private() {}',
    '    pub mod nested {',
    '        pub const N: u8 = 1;',
    '    }',
    '    mod hidden {',
    '        pub fn unreachable() {}',
    '    }',
    '}',
    'mod internal {',
    '    pub fn not_api() {}',
    '}',
    'pub(crate) fn crate_only() {}',
    'pub struct Api;'
  ].join('\n'));
  assert.equal(scan.productionItems, 11);
  assert.equal(scan.publicItems, 5, 'args, decode, nested, N and Api; not the items under private modules, not pub(crate)');
});

test('scanRustSource neither lists nor counts anonymous const assertions', () => {
  const scan = scanRustSource([
    'const _: () = assert!(core::mem::size_of::<u64>() == 8);',
    'const _: () = assert!(',
    '    core::mem::align_of::<u64>() == 8,',
    '    "alignment",',
    ');',
    'pub const REAL: u8 = 1;',
    'const _: () = { assert!(true) };',
    'pub fn after() {}'
  ].join('\n'));
  assert.deepEqual(scan.items.map((item) => item.name), ['REAL', 'after'], '`_` is not a name');
  assert.equal(scan.productionItems, 2);
  assert.equal(scan.publicItems, 2);
});

test('childModuleFiles resolves an out-of-line module the way rustc does', () => {
  assert.deepEqual(childModuleFiles('src/lib.rs', 'tests'), ['src/tests.rs', 'src/tests/mod.rs']);
  assert.deepEqual(childModuleFiles('src/main.rs', 'cli'), ['src/cli.rs', 'src/cli/mod.rs']);
  assert.deepEqual(childModuleFiles('src/args/mod.rs', 'tcb'), ['src/args/tcb.rs', 'src/args/tcb/mod.rs']);
  assert.deepEqual(childModuleFiles('src/tests.rs', 'support'), ['src/tests/support.rs', 'src/tests/support/mod.rs'], 'a non-mod.rs file owns a directory of its own name');
  assert.deepEqual(childModuleFiles('src/bin/oracle.rs', 'ops'), ['src/bin/ops.rs', 'src/bin/ops/mod.rs'], 'a binary target is a crate root, so its modules resolve beside it');
  assert.deepEqual(childModuleFiles('tool/runner.rs', 'args', '', '', { root: true }), ['tool/args.rs', 'tool/args/mod.rs'], 'a root the manifest declares resolves the same way');
  assert.deepEqual(childModuleFiles('tool/runner.rs', 'args'), ['tool/runner/args.rs', 'tool/runner/args/mod.rs'], 'without that knowledge it is an ordinary file');
});

test('buildRustInventory scans an out-of-line #[cfg(test)] module and its submodules as test code', () => {
  const tree = {
    'rust/Cargo.toml': '[workspace]\nmembers = ["sele4n-hal"]\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n',
    'rust/sele4n-hal/Cargo.toml': '[package]\nname = "sele4n-hal"\nversion.workspace = true\nedition.workspace = true\n',
    'rust/sele4n-hal/src/lib.rs': '#![allow(unsafe_code)]\npub mod mmu;\n#[cfg(test)]\nmod tests;\npub fn prod() {}\n',
    'rust/sele4n-hal/src/mmu.rs': 'pub unsafe fn map() { unsafe { } }\n',
    'rust/sele4n-hal/src/tests.rs': 'mod support;\npub fn helper() { unsafe { } }\nunsafe impl Sync for Shared {}\n#[test]\nfn t() {}\n',
    'rust/sele4n-hal/src/tests/support.rs': 'pub const FIXTURE: u8 = 1;\npub struct Shared(u8);\n'
  };
  const inventory = buildRustInventory(Object.keys(tree), (path) => tree[path]);
  const hal = inventory.crates[0];
  const byPath = Object.fromEntries(hal.files.map((file) => [file.relativePath, file]));
  assert.equal(byPath['src/tests.rs'].role, 'module', 'the path rule alone calls it an ordinary module');
  assert.deepEqual(byPath['src/tests.rs'].items.map((item) => [item.name, item.test === true]), [['support', true], ['helper', true], ['Sync for Shared', true], ['t', true]], 'everything in the declared test module is test code, #[test] or not');
  assert.deepEqual(byPath['src/tests/support.rs'].items.map((item) => [item.name, item.test === true]), [['FIXTURE', true], ['Shared', true]], 'a module the test module declares is test code too');
  assert.deepEqual(byPath['src/tests.rs'].unsafe, { fns: 0, impls: 0, blocks: 0 });
  assert.deepEqual(byPath['src/tests.rs'].testUnsafe, { fns: 0, impls: 1, blocks: 1 }, 'unsafe sites in the test module are test sites');
  assert.deepEqual(byPath['src/mmu.rs'].unsafe, { fns: 1, impls: 0, blocks: 1 }, 'a production module is untouched');
  assert.equal(hal.items, 3, 'mmu, map and prod');
  assert.equal(hal.testItems, 7, 'the tests declaration, four items in tests.rs, two in support.rs');
  assert.deepEqual(hal.unsafe, { fns: 1, impls: 0, blocks: 1 });
  assert.deepEqual(hal.testUnsafe, { fns: 0, impls: 1, blocks: 1 });
});

test('scanRustSource keeps raw identifiers whole', () => {
  const scan = scanRustSource([
    'pub fn r#match(x: u8) -> u8 { x }',
    'pub struct r#type;',
    'pub mod r#mod;',
    'pub fn plain() {}'
  ].join('\n'));
  assert.deepEqual(scan.items.map((item) => item.name), ['r#match', 'r#type', 'r#mod', 'plain'], 'the prefix is part of the name as written; `r` alone would collapse distinct items');
  assert.equal(scan.publicItems, 4);
  assert.deepEqual(childModuleFiles('src/lib.rs', 'r#mod'), ['src/mod.rs', 'src/mod/mod.rs'], 'a raw identifier resolves to the bare file name');
});

test('scanRustSource counts a #[macro_export] macro as public wherever it sits', () => {
  const scan = scanRustSource([
    '#[macro_export]',
    'macro_rules! kprint {',
    '    ($($arg:tt)*) => {{}};',
    '}',
    'mod internal {',
    '    #[macro_export(local_inner_macros)]',
    '    macro_rules! hidden_but_exported {',
    '        () => {};',
    '    }',
    '    macro_rules! local_only {',
    '        () => {};',
    '    }',
    '}',
    '#[macro_export]',
    'pub fn not_a_macro() {}'
  ].join('\n'));
  const byName = Object.fromEntries(scan.items.map((item) => [item.name, item]));
  assert.equal(byName.kprint.visibility, 'pub');
  assert.equal(byName.hidden_but_exported.visibility, 'pub', 'macro_export hoists the macro to the crate root, past the private module');
  assert.equal(byName.local_only.visibility, 'private');
  assert.equal(byName.not_a_macro.visibility, 'pub', 'the attribute changes nothing for a non-macro; the item is pub on its own');
  assert.equal(scan.publicItems, 3, 'kprint, hidden_but_exported and not_a_macro; not internal (private mod) or local_only');
});

test('scanRustSource honours a test-only attribute on an associated item', () => {
  const scan = scanRustSource([
    'pub struct Cell(u8);',
    'impl Cell {',
    '    #[cfg(test)]',
    '    pub unsafe fn poke(&self) { unsafe { } }',
    '    #[cfg(test)]',
    '    fn multi_line(',
    '        &self,',
    '    ) {',
    '        unsafe { }',
    '    }',
    '    #[cfg(any(test, feature = "std"))]',
    '    pub fn both(&self) { unsafe { } }',
    '    pub unsafe fn real(&self) { unsafe { } }',
    '}',
    'pub trait Raw {',
    '    #[cfg(test)]',
    '    unsafe fn probe(&self);',
    '    unsafe fn read(&self) -> u8;',
    '}',
    'pub fn after() { unsafe { } }'
  ].join('\n'));
  assert.deepEqual(scan.unsafe, { fns: 2, impls: 0, blocks: 3 }, 'real, read; the blocks in both, real and after');
  assert.deepEqual(scan.testUnsafe, { fns: 2, impls: 0, blocks: 2 }, 'poke and probe; the blocks in poke and multi_line');
  assert.deepEqual(scan.items.map((item) => item.name), ['Cell', 'Cell', 'Raw', 'after'], 'associated items are still not listed');
});

test('scanRustSource counts public items only when the file itself is exported', () => {
  const source = 'pub fn api() {}\npub mod deeper {\n    pub fn deep() {}\n}\nfn private() {}\n';
  assert.equal(scanRustSource(source).publicItems, 3, 'reachable by default');
  assert.equal(scanRustSource(source, { exported: false }).publicItems, 0, 'nothing in a file behind a private module is public API');
  assert.equal(scanRustSource(source, { exported: false }).productionItems, 4, 'they are still declarations');
});

test('buildRustInventory carries module visibility into out-of-line files', () => {
  const tree = {
    'rust/Cargo.toml': '[workspace]\nmembers = ["sele4n-sys"]\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n',
    'rust/sele4n-sys/Cargo.toml': '[package]\nname = "sele4n-sys"\nversion.workspace = true\nedition.workspace = true\n',
    'rust/sele4n-sys/src/lib.rs': 'pub mod api;\nmod detail;\npub(crate) mod internal;\n',
    'rust/sele4n-sys/src/api.rs': 'pub fn open() {}\nmod nested;\npub mod also_pub;\n',
    'rust/sele4n-sys/src/api/nested.rs': 'pub fn unreachable_from_outside() {}\n',
    'rust/sele4n-sys/src/api/also_pub.rs': 'pub fn reachable() {}\n',
    'rust/sele4n-sys/src/detail.rs': 'pub fn helper() {}\n#[macro_export]\nmacro_rules! exported_anyway { () => {}; }\n',
    'rust/sele4n-sys/src/internal.rs': 'pub fn crate_only() {}\n'
  };
  const inventory = buildRustInventory(Object.keys(tree), (path) => tree[path]);
  const sys = inventory.crates[0];
  const pub = Object.fromEntries(sys.files.map((file) => [file.relativePath, file.publicItems]));
  assert.deepEqual(pub, {
    'src/api.rs': 2,
    'src/api/also_pub.rs': 1,
    'src/api/nested.rs': 0,
    'src/detail.rs': 1,
    'src/internal.rs': 0,
    'src/lib.rs': 1
  }, 'api and also_pub are reachable; nested (private mod), detail (private mod) and internal (pub(crate)) are not — except the macro_export macro');
  assert.equal(sys.publicItems, 5);
  assert.equal(sys.items, 11, 'six functions, one macro and four mod declarations; the private modules are still declarations');
});

test('scanRustSource treats an integration-test file as test code throughout', () => {
  const scan = scanRustSource('pub fn helper() { unsafe { } }\n#[test]\nfn smoke() {}\n', { testFile: true });
  assert.deepEqual(scan.items.map((item) => [item.name, item.test]), [['helper', true], ['smoke', true]]);
  assert.equal(scan.productionItems, 0);
  assert.equal(scan.testItems, 2);
  assert.deepEqual(scan.unsafe, { fns: 0, impls: 0, blocks: 0 });
  assert.deepEqual(scan.testUnsafe, { fns: 0, impls: 0, blocks: 1 });
});

test('scanRustSource handles empty and non-string input', () => {
  assert.deepEqual(scanRustSource(''), {
    items: [], productionItems: 0, publicItems: 0, testItems: 0,
    unsafe: { fns: 0, impls: 0, blocks: 0 }, testUnsafe: { fns: 0, impls: 0, blocks: 0 }, lines: 0
  });
  assert.deepEqual(scanRustSource(null).items, []);
  assert.deepEqual(scanRustSource(undefined).items, []);
  assert.ok(!RUST_COUNTED_KINDS.includes('impl'));
});

test('parseCargoManifest reads package fields, workspace inheritance and dependency tables', () => {
  const manifest = parseCargoManifest([
    '[package]',
    'name = "sele4n-abi"',
    'description = "ARM64 register ABI layer # not a comment"',
    'version.workspace = true',
    'edition.workspace = true',
    '',
    '[features]',
    'default = []',
    'std = ["sele4n-types/std"]',
    '',
    '[dependencies]',
    'sele4n-types = { path = "../sele4n-types" }',
    '',
    '[dev-dependencies]',
    '# review note',
    'sele4n-sys = { path = "../sele4n-sys" }',
    '',
    "[target.'cfg(loom)'.dependencies]",
    'loom = "0.7"',
    '',
    '[target."cfg(unix)".dev-dependencies]',
    'libc = "0.2"',
    '',
    '[build-dependencies]',
    'cc = "1.2" # pinned',
    '',
    '[[bin]]',
    'name = "oracle"',
    'path = "src/bin/oracle.rs"'
  ].join('\n'));

  assert.equal(manifest.package.name, 'sele4n-abi');
  assert.equal(manifest.package.description, 'ARM64 register ABI layer # not a comment');
  assert.deepEqual(manifest.package.version, { workspace: true });
  assert.deepEqual(manifest.features, ['default', 'std']);
  assert.deepEqual(manifest.dependencies, ['sele4n-types'], 'a target-scoped table is not an unconditional dependency');
  assert.deepEqual(manifest.devDependencies, ['sele4n-sys']);
  assert.deepEqual(manifest.buildDependencies, ['cc']);
  assert.deepEqual(manifest.targetDependencies, [
    { cfg: 'cfg(loom)', table: 'dependencies', names: ['loom'] },
    { cfg: 'cfg(unix)', table: 'dev-dependencies', names: ['libc'] }
  ]);
  assert.deepEqual(manifest.bins, [{ name: 'oracle', path: 'src/bin/oracle.rs' }]);
});

test('parseCargoManifest reads workspace members and inherited package fields', () => {
  const manifest = parseCargoManifest([
    '[workspace]',
    'resolver = "2"',
    'members = [',
    '    "sele4n-types",',
    '    "sele4n-abi",',
    ']',
    '',
    '[workspace.package]',
    'version = "0.34.56"',
    'edition = "2021"',
    'rust-version = "1.94"'
  ].join('\n'));

  assert.deepEqual(manifest.members, ['sele4n-types', 'sele4n-abi']);
  assert.equal(manifest.workspacePackage.version, '0.34.56');
  assert.equal(manifest.workspacePackage.edition, '2021');
  assert.equal(manifest.workspacePackage['rust-version'], '1.94');
});

test('rustFileRole and rustModulePath classify crate sources', () => {
  assert.equal(rustFileRole('src/lib.rs'), 'lib');
  assert.equal(rustFileRole('src/bin/rw_lock_oracle.rs'), 'bin');
  assert.equal(rustFileRole('build.rs'), 'build');
  assert.equal(rustFileRole('tests/conformance.rs'), 'test');
  assert.equal(rustFileRole('src/args/tcb.rs'), 'module');

  assert.equal(rustModulePath('src/lib.rs'), '');
  assert.equal(rustModulePath('src/bin/rw_lock_oracle.rs'), '', 'a binary target is its own crate root');
  assert.equal(rustModulePath('src/args/mod.rs'), 'args');
  assert.equal(rustModulePath('src/args/tcb.rs'), 'args::tcb');
  assert.equal(rustModulePath('src/trap.rs'), 'trap');
  assert.equal(rustModulePath('tests/conformance.rs'), '');
});

test('buildRustInventory assembles crates in workspace order with per-file scans', () => {
  const tree = {
    'rust/Cargo.toml': [
      '[workspace]',
      'members = [',
      '    "sele4n-types",',
      '    "sele4n-sys",',
      ']',
      '[workspace.package]',
      'version = "0.1.0"',
      'edition = "2021"'
    ].join('\n'),
    'rust/Cargo.lock': '',
    'rust/sele4n-types/Cargo.toml': [
      '[package]',
      'name = "sele4n-types"',
      'description = "Core types"',
      'version.workspace = true',
      'edition.workspace = true',
      '[dependencies]'
    ].join('\n'),
    'rust/sele4n-types/src/lib.rs': [
      '#![no_std]',
      '#![deny(unsafe_code)]',
      'pub mod identifiers;',
      'pub struct ThreadId(u64);',
      'impl ThreadId { pub fn raw(self) -> u64 { self.0 } }'
    ].join('\n'),
    'rust/sele4n-types/src/identifiers.rs': 'pub const SENTINEL: u64 = 0;\n',
    'rust/sele4n-sys/Cargo.toml': [
      '[package]',
      'name = "sele4n-sys"',
      'description = "Safe wrappers"',
      'version.workspace = true',
      'edition.workspace = true',
      '[dependencies]',
      'sele4n-types = { path = "../sele4n-types" }',
      'log = "0.4"',
      '[dev-dependencies]',
      'sele4n-types = { path = "../sele4n-types" }',
      "[target.'cfg(loom)'.dependencies]",
      'loom = "0.7"'
    ].join('\n'),
    'rust/sele4n-sys/src/lib.rs': 'pub unsafe fn raw() { unsafe { } }\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { unsafe { } }\n}\n',
    'rust/sele4n-sys/src/bin/oracle.rs': '#![deny(unsafe_code)]\nfn main() {}\n',
    'rust/sele4n-sys/tests/smoke.rs': '#[test]\nfn smoke() { unsafe { } }\n',
    'SeLe4n/Kernel/API.lean': 'theorem not_rust : True := trivial'
  };

  const inventory = buildRustInventory(Object.keys(tree), (path) => {
    if (!(path in tree)) throw new Error(`missing ${path}`);
    return tree[path];
  });

  assert.equal(inventory.workspaceManifest, 'rust/Cargo.toml');
  assert.deepEqual(inventory.members, ['sele4n-types', 'sele4n-sys']);
  assert.equal(inventory.edition, '2021');
  assert.equal(inventory.version, '0.1.0');
  assert.deepEqual(inventory.workspaceFiles, ['rust/Cargo.lock', 'rust/Cargo.toml']);
  assert.deepEqual(inventory.crates.map((crate) => crate.name), ['sele4n-types', 'sele4n-sys']);

  const types = inventory.crates[0];
  assert.equal(types.description, 'Core types');
  assert.equal(types.edition, '2021', 'workspace-inherited edition resolves through the root manifest');
  assert.equal(types.version, '0.1.0');
  assert.equal(types.deniesUnsafe, true);
  assert.equal(types.sourceFiles, 2);
  assert.equal(types.lines, 6);
  assert.equal(types.items, 3, 'the impl block is listed, not counted');
  assert.equal(types.publicItems, 3);
  assert.deepEqual(types.targetDependencies, []);
  assert.deepEqual(types.unsafe, { fns: 0, impls: 0, blocks: 0 });
  assert.deepEqual(types.testUnsafe, { fns: 0, impls: 0, blocks: 0 });
  assert.deepEqual(types.files.map((file) => file.relativePath), ['src/identifiers.rs', 'src/lib.rs']);
  assert.equal(types.files[1].role, 'lib');
  assert.equal(types.files[1].productionItems, 2);
  assert.equal(types.files[1].items.length, 3);
  assert.equal(types.files[0].modulePath, 'identifiers');

  const sys = inventory.crates[1];
  assert.deepEqual(sys.internalDependencies, ['sele4n-types']);
  assert.deepEqual(sys.externalDependencies, ['log'], 'loom under cfg(loom) is not an external dependency');
  assert.deepEqual(sys.targetDependencies, [{ cfg: 'cfg(loom)', table: 'dependencies', names: ['loom'] }]);
  assert.deepEqual(sys.devDependencies, ['sele4n-types']);
  assert.equal(sys.deniesUnsafe, false, 'a deny in a src/bin target does not speak for the library');
  assert.deepEqual(sys.unsafe, { fns: 1, impls: 0, blocks: 1 });
  assert.deepEqual(sys.testUnsafe, { fns: 0, impls: 0, blocks: 2 }, 'the test module block and the integration-test block');
  const smoke = sys.files.find((file) => file.relativePath === 'tests/smoke.rs');
  assert.equal(smoke.role, 'test');
  assert.deepEqual(smoke.items.map((item) => [item.name, item.test]), [['smoke', true]], 'integration-test items are listed, flagged test');
  assert.equal(smoke.testItems, 1);
  assert.equal(smoke.productionItems, 0);
  assert.equal(smoke.publicItems, 0);
  assert.deepEqual(smoke.testUnsafe, { fns: 0, impls: 0, blocks: 1 });
  const lib = sys.files.find((file) => file.relativePath === 'src/lib.rs');
  assert.deepEqual(lib.items.map((item) => [item.name, item.test === true]), [['raw', false], ['tests', true], ['t', true]], 'the cfg(test) module and its test are listed and flagged');
  assert.equal(lib.testItems, 2);
  assert.equal(sys.items, 2, 'production items only: raw and main');
  assert.equal(sys.testItems, 3);
});

test('buildRustInventory returns an empty workspace when the tree has no rust directory', () => {
  const inventory = buildRustInventory(['SeLe4n/Kernel/API.lean', 'README.md'], () => { throw new Error('unreachable'); });
  assert.equal(inventory.workspaceManifest, '');
  assert.deepEqual(inventory.crates, []);
  assert.deepEqual(inventory.members, []);
});

test('scanRustSource reads a declaration that shares its line with an attribute', () => {
  const scan = scanRustSource([
    '#![allow(dead_code)] pub struct First;',
    '#[cfg(test)] mod tests {',
    '    pub fn helper() { unsafe { } }',
    '    #[test] fn t() {}',
    '}',
    '#[macro_export] macro_rules! inline_macro { () => {}; }',
    '#[inline] #[must_use] pub fn quick() -> u8 { 1 }',
    '#[cfg(',
    '    test',
    ')] pub fn after_multi_line() { unsafe { } }',
    'impl First {',
    '    #[cfg(test)] pub fn probe(&self) { unsafe { } }',
    '    #[inline] pub fn real(&self) { unsafe { } }',
    '}',
    'pub fn last() {}'
  ].join('\n'));
  assert.deepEqual(scan.items.map((item) => [item.name, item.module, item.test === true, item.line]), [
    ['First', '', false, 1],
    ['tests', '', true, 2],
    ['helper', 'tests', true, 3],
    ['t', 'tests', true, 4],
    ['inline_macro', '', false, 6],
    ['quick', '', false, 7],
    ['after_multi_line', '', true, 10],
    ['First', '', false, 11],
    ['last', '', false, 15]
  ], 'the declaration after an attribute is read from the same line, and its braces keep the depth in step');
  assert.equal(scan.productionItems, 4, 'First, inline_macro, quick, last');
  assert.equal(scan.publicItems, 4);
  assert.equal(scan.testItems, 4, 'tests, helper, t, after_multi_line');
  assert.deepEqual(scan.unsafe, { fns: 0, impls: 0, blocks: 1 }, 'the block in real');
  assert.deepEqual(scan.testUnsafe, { fns: 0, impls: 0, blocks: 3 }, 'helper, after_multi_line and the guarded method probe');
});

test('scanRustSource keeps a test-only const or static initializer in test code', () => {
  const scan = scanRustSource([
    '#[cfg(test)]',
    'const CHECK: () = {',
    '    unsafe { }',
    '};',
    '#[cfg(test)]',
    'pub(crate) static GUARD: Lock = Lock::new(',
    '    unsafe { raw() },',
    ');',
    'const PROD: () = {',
    '    unsafe { }',
    '};',
    '#[cfg(test)]',
    'type Alias = u8;',
    '#[cfg(test)]',
    'static PLAIN: std::sync::Mutex<()> = std::sync::Mutex::new(());',
    'pub fn after() { unsafe { } }'
  ].join('\n'));
  assert.deepEqual(scan.items.map((item) => [item.name, item.test === true]), [
    ['CHECK', true], ['GUARD', true], ['PROD', false], ['Alias', true], ['PLAIN', true], ['after', false]
  ]);
  assert.deepEqual(scan.testUnsafe, { fns: 0, impls: 0, blocks: 2 }, 'the blocks inside the two test-only initializers');
  assert.deepEqual(scan.unsafe, { fns: 0, impls: 0, blocks: 2 }, 'PROD and after: the status does not leak past a `;`');
});

test('crateDeniesUnsafe parses the lint attribute rather than matching one spelling', () => {
  assert.equal(crateDeniesUnsafe('#![no_std]\n#![deny(unsafe_code)]\npub fn f() {}\n'), true);
  assert.equal(crateDeniesUnsafe('#![deny( unsafe_code )]'), true, 'spaces inside the list');
  assert.equal(crateDeniesUnsafe('#![deny(dead_code, unsafe_code)]'), true, 'one of several lints');
  assert.equal(crateDeniesUnsafe('#![deny(\n    missing_docs,\n    unsafe_code,\n)]'), true, 'a multi-line list');
  assert.equal(crateDeniesUnsafe('#![forbid(unsafe_code)]'), true);
  assert.equal(crateDeniesUnsafe('#![warn(unsafe_code)]'), false, 'a warning is not a denial');
  assert.equal(crateDeniesUnsafe('#![deny(unsafe_op_in_unsafe_fn)]'), false, 'another lint');
  assert.equal(crateDeniesUnsafe('#![deny(unsafe_code)]\n#![allow(unsafe_code)]'), false, 'a later allow lifts the deny');
  assert.equal(crateDeniesUnsafe('#![forbid(unsafe_code)]\n#![allow(unsafe_code)]'), true, 'a forbid cannot be lifted');
  assert.equal(crateDeniesUnsafe('#![cfg_attr(not(test), deny(unsafe_code))]'), true, 'a predicate that holds in production');
  assert.equal(crateDeniesUnsafe('#![cfg_attr(test, deny(unsafe_code))]'), false, 'a test-only predicate never holds in production');
  assert.equal(crateDeniesUnsafe('#![cfg_attr(feature = "strict", deny(unsafe_code))]'), false, 'a feature-conditional lint is not the crate policy');
  assert.equal(crateDeniesUnsafe('#![cfg_attr(any(not(test), feature = "strict"), deny(unsafe_code))]'), true, 'holds whatever the feature');
  assert.equal(crateDeniesUnsafe('#![cfg_attr(all(not(test), target_arch = "aarch64"), deny(unsafe_code))]'), false, 'holds on one target only');
  assert.equal(crateDeniesUnsafe('//! #![deny(unsafe_code)]\n/* #![deny(unsafe_code)] */\n#[deny(unsafe_code)]\nfn f() {}\n'), false, 'comments and an outer attribute on an item are not crate policy');
  assert.equal(crateDeniesUnsafe(''), false);
  assert.equal(crateDeniesUnsafe(null), false);
});

test('parseCargoManifest keeps the package identity and path of a renamed dependency', () => {
  const manifest = parseCargoManifest([
    '[package]',
    'name = "sele4n-hal"',
    '[dependencies]',
    'types = { package = "sele4n-types", path = "../types" }',
    'json = { package = "serde_json", version = "1" }',
    'log = "0.4"',
    '[dev-dependencies]',
    'abi = { path = "../abi", package = "sele4n-abi", features = ["std", "extra"] }',
    "[target.'cfg(loom)'.dependencies]",
    'loom-alias = { package = "loom", version = "0.7" }'
  ].join('\n'));
  assert.deepEqual(manifest.dependencies, ['sele4n-types', 'serde_json', 'log'], 'listed by package identity, in declaration order');
  assert.deepEqual(manifest.devDependencies, ['sele4n-abi']);
  assert.deepEqual(manifest.targetDependencies, [{ cfg: 'cfg(loom)', table: 'dependencies', names: ['loom'] }]);
  assert.deepEqual(manifest.dependencySpecs, [
    { table: 'dependencies', cfg: '', name: 'types', package: 'sele4n-types', path: '../types', workspace: false },
    { table: 'dependencies', cfg: '', name: 'json', package: 'serde_json', path: '', workspace: false },
    { table: 'dependencies', cfg: '', name: 'log', package: 'log', path: '', workspace: false },
    { table: 'dev-dependencies', cfg: '', name: 'abi', package: 'sele4n-abi', path: '../abi', workspace: false },
    { table: 'dependencies', cfg: 'cfg(loom)', name: 'loom-alias', package: 'loom', path: '', workspace: false }
  ], 'an array-valued field inside the inline table does not split the entry');
});

test('buildRustInventory resolves internal dependencies by package identity, not directory name', () => {
  const tree = {
    'rust/Cargo.toml': '[workspace]\nmembers = [\n    "types",\n    "hal",\n]\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n',
    'rust/types/Cargo.toml': '[package]\nname = "sele4n-types"\nversion.workspace = true\nedition.workspace = true\n',
    'rust/types/src/lib.rs': '#![no_std]\n#![deny( unsafe_code )]\npub struct Id(u64);\n',
    'rust/hal/Cargo.toml': [
      '[package]',
      'name = "sele4n-hal"',
      'version.workspace = true',
      'edition.workspace = true',
      '[dependencies]',
      'kernel-types = { package = "sele4n-types", path = "../types" }',
      'log = "0.4"',
      '[dev-dependencies]',
      'sele4n-types = { path = "../types" }',
      "[target.'cfg(loom)'.dependencies]",
      'loom-shim = { package = "loom", version = "0.7" }'
    ].join('\n'),
    'rust/hal/src/lib.rs': '#![deny(\n    missing_docs,\n    unsafe_code,\n)]\npub fn f() {}\n'
  };
  const inventory = buildRustInventory(Object.keys(tree), (path) => tree[path]);
  assert.deepEqual(inventory.crates.map((crate) => [crate.name, crate.path]), [['sele4n-types', 'rust/types'], ['sele4n-hal', 'rust/hal']], 'a member directory need not be the package name');
  const hal = inventory.crates[1];
  assert.deepEqual(hal.internalDependencies, ['sele4n-types'], 'a renamed path dependency is the workspace crate it points at');
  assert.deepEqual(hal.externalDependencies, ['log']);
  assert.deepEqual(hal.dependencies, ['sele4n-types', 'log'], 'listed by package identity, in declaration order');
  assert.deepEqual(hal.devDependencies, ['sele4n-types'], 'the path alone resolves the member');
  assert.deepEqual(hal.targetDependencies, [{ cfg: 'cfg(loom)', table: 'dependencies', names: ['loom'] }], 'a renamed external dependency reads as its package');
  assert.equal(inventory.crates[0].deniesUnsafe, true, 'spaces inside the lint list');
  assert.equal(hal.deniesUnsafe, true, 'a multi-line lint list');
});

test('cfgHoldsInProduction is true only for predicates that hold whatever the features and target', () => {
  assert.equal(cfgHoldsInProduction('not(test)'), true);
  assert.equal(cfgHoldsInProduction('any(not(test), feature = "strict")'), true);
  assert.equal(cfgHoldsInProduction('not(all(test, feature = "x"))'), true, 'false in production whatever the feature');
  assert.equal(cfgHoldsInProduction('all()'), true, 'vacuous');
  assert.equal(cfgHoldsInProduction('test'), false);
  assert.equal(cfgHoldsInProduction('feature = "strict"'), false, 'depends on the build');
  assert.equal(cfgHoldsInProduction('all(not(test), target_arch = "aarch64")'), false);
  assert.equal(cfgHoldsInProduction('not(feature = "x")'), false);
  assert.equal(cfgHoldsInProduction('any()'), false);
  assert.equal(cfgHoldsInProduction(''), false);
});

test('scanRustSource binds attributes by one rule at every depth', () => {
  const scan = scanRustSource([
    '#[cfg(test)] use std::vec::Vec;',
    'pub fn real() { unsafe { } }',
    '#[cfg(test)]',
    'static BUF: [u8; 4] = [0; 4];',
    'pub fn also_real() { unsafe { } }',
    '#[cfg(test)]',
    'extern "C" {',
    '    fn foreign();',
    '}',
    'impl Cell {',
    '    #[cfg(test)]',
    '    fn guarded(&self) -> [u8; 2] { unsafe { [0; 2] } }',
    '    fn plain(&self) { unsafe { } }',
    '}',
    '#[tokio::test]',
    'async fn attribute_macro_test() { unsafe { } }',
    '#[cfg(test)] const SEMI: u8 = 1;',
    'pub fn after_semi() { unsafe { } }'
  ].join('\n'));
  assert.deepEqual(scan.items.map((item) => [item.name, item.test === true]), [
    ['real', false], ['BUF', true], ['also_real', false], ['Cell', false], ['attribute_macro_test', true], ['SEMI', true], ['after_semi', false]
  ], 'an attribute binds to the very next construct, a `use` included; a `;` inside brackets ends nothing; a test attribute macro under a path marks a test');
  assert.deepEqual(scan.unsafe, { fns: 0, impls: 0, blocks: 4 }, 'real, also_real, plain, after_semi');
  assert.deepEqual(scan.testUnsafe, { fns: 0, impls: 0, blocks: 2 }, 'guarded and the attribute-macro test');
});

test('scanRustSource treats a scope under #![cfg(test)] as test code', () => {
  const file = scanRustSource('#![cfg(test)]\n#![allow(dead_code)]\npub fn helper() { unsafe { } }\npub struct Fixture;\n');
  assert.deepEqual(file.items.map((item) => [item.name, item.test]), [['helper', true], ['Fixture', true]]);
  assert.equal(file.productionItems, 0);
  assert.deepEqual(file.testUnsafe, { fns: 0, impls: 0, blocks: 1 });
  const inline = scanRustSource([
    'pub fn prod() { unsafe { } }',
    'mod support {',
    '    #![cfg(test)]',
    '    pub fn helper() { unsafe { } }',
    '}',
    'pub fn after() { unsafe { } }'
  ].join('\n'));
  assert.deepEqual(inline.items.map((item) => [item.name, item.test === true]), [['prod', false], ['support', false], ['helper', true], ['after', false]], 'the module declaration is production; its body is test code');
  assert.deepEqual(inline.unsafe, { fns: 0, impls: 0, blocks: 2 });
  assert.deepEqual(inline.testUnsafe, { fns: 0, impls: 0, blocks: 1 });
  assert.equal(scanRustSource('#![cfg(not(test))]\npub fn prod() {}\n').productionItems, 1, 'the production side of a split');
});

test('buildRustInventory resolves out-of-line modules declared inside inline modules and through #[path]', () => {
  const tree = {
    'rust/Cargo.toml': '[workspace]\nmembers = ["sele4n-hal"]\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n',
    'rust/sele4n-hal/Cargo.toml': '[package]\nname = "sele4n-hal"\nversion.workspace = true\nedition.workspace = true\n',
    'rust/sele4n-hal/src/lib.rs': [
      '#[cfg(test)]',
      'mod outer {',
      '    mod support;',
      '}',
      'pub mod api {',
      '    mod hidden;',
      '    pub mod shown;',
      '}',
      'mod internal {',
      '    pub mod leaf;',
      '}',
      '#[cfg(test)]',
      '#[path = "fixtures/named.rs"]',
      'mod renamed;',
      'mod tests {',
      '    pub fn inline_only() {}',
      '}',
      'pub fn prod() {}'
    ].join('\n'),
    'rust/sele4n-hal/src/outer/support.rs': 'pub fn helper() { unsafe { } }\n',
    'rust/sele4n-hal/src/api/hidden.rs': 'pub fn unreachable() {}\n',
    'rust/sele4n-hal/src/api/shown/mod.rs': 'pub fn reachable() {}\n',
    'rust/sele4n-hal/src/internal/leaf.rs': 'pub fn behind_private_parent() {}\n',
    'rust/sele4n-hal/src/fixtures/named.rs': 'pub fn fixture() { unsafe { } }\n',
    'rust/sele4n-hal/src/tests.rs': 'pub fn not_the_inline_module() { unsafe { } }\n'
  };
  const inventory = buildRustInventory(Object.keys(tree), (path) => tree[path]);
  const hal = inventory.crates[0];
  const byPath = Object.fromEntries(hal.files.map((file) => [file.relativePath, file]));
  assert.deepEqual(byPath['src/outer/support.rs'].items.map((item) => [item.name, item.test === true]), [['helper', true]], 'declared inside a test-only inline module');
  assert.deepEqual(byPath['src/outer/support.rs'].testUnsafe, { fns: 0, impls: 0, blocks: 1 });
  assert.equal(byPath['src/api/hidden.rs'].publicItems, 0, 'a private mod inside a pub inline module');
  assert.equal(byPath['src/api/shown/mod.rs'].publicItems, 1);
  assert.equal(byPath['src/internal/leaf.rs'].publicItems, 0, 'a pub mod inside a private inline module');
  assert.deepEqual(byPath['src/fixtures/named.rs'].items.map((item) => [item.name, item.test === true]), [['fixture', true]], '#[path] names the file');
  assert.equal(byPath['src/tests.rs'].productionItems, 1, 'an inline `mod tests { }` says nothing about src/tests.rs');
  assert.deepEqual(hal.unsafe, { fns: 0, impls: 0, blocks: 1 }, 'src/tests.rs');
  assert.deepEqual(hal.testUnsafe, { fns: 0, impls: 0, blocks: 2 }, 'support.rs and named.rs');
  assert.equal(hal.items, 12);
  assert.equal(hal.testItems, 5, 'outer, support, renamed, helper, fixture');
  assert.equal(hal.publicItems, 5, 'api, shown, reachable, prod, and the pub fn in src/tests.rs, which nothing declares and so keeps the default status');
  assert.deepEqual(childModuleFiles('src/lib.rs', 'support', 'outer'), ['src/outer/support.rs', 'src/outer/support/mod.rs']);
  assert.deepEqual(childModuleFiles('src/net.rs', 'support', 'outer::inner'), ['src/net/outer/inner/support.rs', 'src/net/outer/inner/support/mod.rs']);
  assert.deepEqual(childModuleFiles('src/lib.rs', 'renamed', '', 'fixtures/named.rs'), ['src/fixtures/named.rs']);
  assert.deepEqual(childModuleFiles('src/net.rs', 'renamed', '', 'sibling/shared.rs'), ['src/sibling/shared.rs'], 'at file scope the path is relative to the file directory');
  assert.deepEqual(childModuleFiles('src/net.rs', 'renamed', 'inline', 'x.rs'), ['src/net/inline/x.rs'], 'inside inline modules a non-mod-rs file owns a directory of its name');
});

test('parseToml reads the manifest shapes Cargo accepts', () => {
  const toml = parseToml([
    '# leading comment',
    'title = "T # not a comment" # trailing',
    "literal = 'C:\\path'",
    'multi = """',
    'first line',
    'second \\',
    '   joined"""',
    'flag = true',
    'count = 1_000',
    'members = ["a", "b"] # one line',
    'nested = [',
    '    "x", # comment inside',
    '    "y",',
    ']',
    'inline = { path = "../x", features = ["std", "extra"], optional = false }',
    'dotted.key.inner = "v"',
    '',
    '[table.sub]',
    'value = 1',
    '',
    '[[bin]]',
    'name = "one"',
    '[[bin]]',
    'name = "two"',
    '[bin.extra]',
    'flag = true',
    "[target.'cfg(loom)'.dependencies]",
    'loom = "0.7"',
    '[target."cfg(unix)".dev-dependencies]',
    'libc = "0.2"'
  ].join('\n'));
  assert.equal(toml.title, 'T # not a comment');
  assert.equal(toml.literal, 'C:\\path');
  assert.equal(toml.multi, 'first line\nsecond joined');
  assert.equal(toml.flag, true);
  assert.equal(toml.count, 1000);
  assert.deepEqual(toml.members, ['a', 'b']);
  assert.deepEqual(toml.nested, ['x', 'y']);
  assert.deepEqual(toml.inline, { path: '../x', features: ['std', 'extra'], optional: false });
  assert.deepEqual(toml.dotted, { key: { inner: 'v' } });
  assert.deepEqual(toml.table, { sub: { value: 1 } });
  assert.deepEqual(toml.bin, [{ name: 'one' }, { name: 'two', extra: { flag: true } }]);
  assert.deepEqual(toml.target, { 'cfg(loom)': { dependencies: { loom: '0.7' } }, 'cfg(unix)': { 'dev-dependencies': { libc: '0.2' } } });
  assert.deepEqual(parseToml(''), {});
  assert.deepEqual(parseToml(null), {});
});

test('parseCargoManifest reads sub-table and dotted dependency declarations', () => {
  const manifest = parseCargoManifest([
    '[package]',
    'name = "sele4n-hal"',
    '[dependencies]',
    'sele4n-types.path = "../sele4n-types"',
    'log = { version = "0.4", default-features = false }',
    '[dependencies.kernel-abi]',
    'package = "sele4n-abi"',
    'path = "../sele4n-abi"',
    '[dependencies.shared]',
    'workspace = true'
  ].join('\n'));
  assert.deepEqual(manifest.dependencies, ['sele4n-types', 'log', 'sele4n-abi', 'shared']);
  assert.deepEqual(manifest.dependencySpecs.map((spec) => [spec.name, spec.package, spec.path, spec.workspace]), [
    ['sele4n-types', 'sele4n-types', '../sele4n-types', false],
    ['log', 'log', '', false],
    ['kernel-abi', 'sele4n-abi', '../sele4n-abi', false],
    ['shared', 'shared', '', true]
  ]);
});

test('buildRustInventory resolves a workspace-inherited dependency through the root manifest', () => {
  const tree = {
    'rust/Cargo.toml': [
      '[workspace]',
      'members = ["types", "hal"]',
      '[workspace.package]',
      'version = "0.1.0"',
      'edition = "2021"',
      '[workspace.dependencies]',
      'kernel-types = { package = "sele4n-types", path = "types" }',
      'log = "0.4"'
    ].join('\n'),
    'rust/types/Cargo.toml': '[package]\nname = "sele4n-types"\nversion.workspace = true\nedition.workspace = true\n',
    'rust/types/src/lib.rs': 'pub struct Id(u64);\n',
    'rust/hal/Cargo.toml': '[package]\nname = "sele4n-hal"\nversion.workspace = true\nedition.workspace = true\n[dependencies]\nkernel-types = { workspace = true }\nlog.workspace = true\n',
    'rust/hal/src/lib.rs': 'pub fn f() {}\n'
  };
  const inventory = buildRustInventory(Object.keys(tree), (path) => tree[path]);
  assert.deepEqual(inventory.crates.map((crate) => crate.name), ['sele4n-types', 'sele4n-hal'], 'a one-line members array keeps workspace order');
  const hal = inventory.crates[1];
  assert.deepEqual(hal.internalDependencies, ['sele4n-types'], 'resolved through [workspace.dependencies], relative to the workspace root');
  assert.deepEqual(hal.externalDependencies, ['log']);
  assert.deepEqual(hal.dependencies, ['sele4n-types', 'log']);
});

test('scanRustSource releases an attribute at the comma or brace that ends a field, variant or arm', () => {
  const scan = scanRustSource([
    'pub struct Counters {',
    '    #[cfg(test)]',
    '    pub probes: Option<Box<dyn Fn(u8) -> u8>>,',
    '    pub real: u8,',
    '    #[cfg(test)]',
    '    last: u8',
    '}',
    'pub fn after_struct() { unsafe { } }',
    'pub enum Event {',
    '    #[cfg(test)]',
    '    Probe { at: u8 },',
    '    #[cfg(test)]',
    '    Tuple(u8, u8),',
    '    Real',
    '}',
    'pub fn after_enum() { unsafe { } }',
    'pub fn arms(e: Event) {',
    '    match e {',
    '        #[cfg(test)]',
    '        Event::Probe { .. } => unsafe { },',
    '        _ => unsafe { },',
    '    }',
    '}',
    '#[cfg(test)]',
    'fn generic<A, B>(a: A, b: B) -> Result<A, B> where A: Iterator<Item = u8> { unsafe { } }',
    'pub fn last() { unsafe { } }'
  ].join('\n'));
  assert.deepEqual(scan.items.map((item) => [item.name, item.test === true]), [
    ['Counters', false], ['after_struct', false], ['Event', false], ['after_enum', false], ['arms', false], ['generic', true], ['last', false]
  ], 'a field or variant attribute never reaches the next item; commas inside generics end nothing');
  assert.deepEqual(scan.unsafe, { fns: 0, impls: 0, blocks: 4 }, 'after_struct, after_enum, the `_` arm, last');
  assert.deepEqual(scan.testUnsafe, { fns: 0, impls: 0, blocks: 2 }, 'the guarded arm and generic');
});

test('buildRustInventory honours manifest-declared crate roots', () => {
  const tree = {
    'rust/Cargo.toml': '[workspace]\nmembers = ["tool", "lib"]\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n',
    'rust/tool/Cargo.toml': '[package]\nname = "sele4n-tool"\nversion.workspace = true\nedition.workspace = true\n[[bin]]\nname = "runner"\npath = "tool/runner.rs"\n',
    'rust/tool/tool/runner.rs': '#![deny(unsafe_code)]\nmod args;\npub fn entry() {}\nfn main() {}\n',
    'rust/tool/tool/args.rs': 'pub fn parse() {}\n',
    'rust/lib/Cargo.toml': '[package]\nname = "sele4n-lib"\nversion.workspace = true\nedition.workspace = true\n[lib]\npath = "lib/root.rs"\n',
    'rust/lib/lib/root.rs': '#![forbid(unsafe_code)]\nmod inner;\npub fn api() {}\n',
    'rust/lib/lib/inner.rs': 'pub fn hidden() {}\n'
  };
  const inventory = buildRustInventory(Object.keys(tree), (path) => tree[path]);
  const tool = inventory.crates[0];
  const byPath = Object.fromEntries(tool.files.map((file) => [file.relativePath, file]));
  assert.equal(byPath['tool/runner.rs'].role, 'bin', 'the [[bin]] path is a crate root');
  assert.equal(byPath['tool/runner.rs'].modulePath, '');
  assert.equal(byPath['tool/args.rs'].role, 'module');
  assert.equal(tool.deniesUnsafe, true, 'read from the declared binary root');
  assert.equal(byPath['tool/args.rs'].publicItems, 0, 'declared by a private `mod args;` beside the root');
  const lib = inventory.crates[1];
  const libByPath = Object.fromEntries(lib.files.map((file) => [file.relativePath, file]));
  assert.equal(libByPath['lib/root.rs'].role, 'lib', 'the [lib] path is the library root');
  assert.equal(lib.deniesUnsafe, true);
  assert.equal(libByPath['lib/inner.rs'].publicItems, 0, 'a crate root resolves `mod inner;` beside itself');
});
