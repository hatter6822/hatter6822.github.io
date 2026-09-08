import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUST_COUNTED_KINDS,
  buildRustInventory,
  cfgIsTestOnly,
  parseCargoManifest,
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
