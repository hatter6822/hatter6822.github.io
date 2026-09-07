import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRustInventory,
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

  assert.deepEqual(scan.unsafe, { fns: 2, impls: 1, blocks: 2 });
  assert.equal(scan.lines, 51);
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

test('scanRustSource marks #[test] functions and cfg(any(test, …)) items without a test module', () => {
  const scan = scanRustSource([
    '#[test]',
    'fn direct() {}',
    '#[cfg(any(test, feature = "std"))]',
    'pub fn host_only() {}',
    '#[cfg(feature = "test-utils")]',
    'pub fn utils() {}',
    '#[inline]',
    'pub fn production() {}'
  ].join('\n'));
  assert.deepEqual(scan.items.map((item) => [item.name, item.test]), [
    ['direct', true],
    ['host_only', true],
    ['utils', false],
    ['production', false]
  ]);
});

test('scanRustSource handles empty and non-string input', () => {
  assert.deepEqual(scanRustSource(''), { items: [], unsafe: { fns: 0, impls: 0, blocks: 0 }, lines: 0 });
  assert.deepEqual(scanRustSource(null).items, []);
  assert.deepEqual(scanRustSource(undefined).items, []);
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
  assert.deepEqual(manifest.dependencies, ['sele4n-types', 'loom']);
  assert.deepEqual(manifest.devDependencies, ['sele4n-sys']);
  assert.deepEqual(manifest.buildDependencies, ['cc']);
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
      'pub struct ThreadId(u64);'
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
      'sele4n-types = { path = "../sele4n-types" }'
    ].join('\n'),
    'rust/sele4n-sys/src/lib.rs': 'pub unsafe fn raw() { unsafe { } }\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {}\n}\n',
    'rust/sele4n-sys/tests/smoke.rs': '#[test]\nfn smoke() {}\n',
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
  assert.equal(types.lines, 5);
  assert.equal(types.items, 3);
  assert.equal(types.publicItems, 3);
  assert.deepEqual(types.unsafe, { fns: 0, impls: 0, blocks: 0 });
  assert.deepEqual(types.files.map((file) => file.relativePath), ['src/identifiers.rs', 'src/lib.rs']);
  assert.equal(types.files[1].role, 'lib');
  assert.equal(types.files[0].modulePath, 'identifiers');

  const sys = inventory.crates[1];
  assert.deepEqual(sys.internalDependencies, ['sele4n-types']);
  assert.deepEqual(sys.externalDependencies, ['log']);
  assert.deepEqual(sys.devDependencies, ['sele4n-types']);
  assert.equal(sys.deniesUnsafe, false);
  assert.deepEqual(sys.unsafe, { fns: 1, impls: 0, blocks: 1 });
  const smoke = sys.files.find((file) => file.relativePath === 'tests/smoke.rs');
  assert.equal(smoke.role, 'test');
  assert.deepEqual(smoke.items, [], 'integration-test files list no items');
  assert.equal(smoke.testItems, 1, 'but their test functions are counted');
  const lib = sys.files.find((file) => file.relativePath === 'src/lib.rs');
  assert.deepEqual(lib.items.map((item) => item.name), ['raw'], 'the cfg(test) module and its test are counted, not listed');
  assert.equal(lib.testItems, 2);
  assert.equal(sys.items, 1);
  assert.equal(sys.testItems, 3);
});

test('buildRustInventory returns an empty workspace when the tree has no rust directory', () => {
  const inventory = buildRustInventory(['SeLe4n/Kernel/API.lean', 'README.md'], () => { throw new Error('unreachable'); });
  assert.equal(inventory.workspaceManifest, '');
  assert.deepEqual(inventory.crates, []);
  assert.deepEqual(inventory.members, []);
});
