import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const mapScriptPath = path.join(repoRoot, 'assets/js/map.js');

async function loadMapTestHooks() {
  const source = await fs.readFile(mapScriptPath, 'utf8');
  const context = {
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    Intl,
    Date,
    Math,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Uint8Array,
    TextDecoder,
    encodeURIComponent,
    decodeURIComponent,
    escape,
    fetch: () => { throw new Error('unexpected fetch during test'); },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    document: {},
    window: {
      __SELE4N_MAP_DISABLE_BOOT__: true,
      atob: (input) => Buffer.from(String(input), 'base64').toString('binary')
    }
  };

  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'assets/js/map.js' });
  assert.ok(context.window.__SELE4N_MAP_TEST_HOOKS__, 'expected map test hooks to be initialized');
  return context.window.__SELE4N_MAP_TEST_HOOKS__;
}

test('normalizeMapData sanitizes modules/imports and accepts legacy symbol buckets', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    files: [' SeLe4n/Core/Main.lean ', 'SeLe4n/Core/Main.lean', 'README.md'],
    modules: [
      { name: 'SeLe4n.Core.Main', path: 'SeLe4n/Core/Main.lean', imports: ['SeLe4n.Core.Helper', 'Bad Name', 'SeLe4n.Core.Main'], externalImports: ['Std.Data.List', 'SeLe4n.Core.Helper', 'Std.Data.List'] },
      { name: 'SeLe4n.Core.Helper', path: 'SeLe4n/Core/Helper.lean' },
      'Bad Name'
    ],
    moduleMap: {
      'SeLe4n.Core.Main': 'SeLe4n/Core/Main.lean',
      'Bad Name': 'bad/path.lean',
      'SeLe4n.Core.Helper': 'SeLe4n/Core/Helper.lean',
      main: 'https://githubusercontent.com/hatter6822/seLe4n/refs/heads/main'
    },
    moduleMeta: {
      'SeLe4n.Core.Main': {
        symbols: {
          by_kind: {
            theorem: [{ name: 'mainThm', line: 21 }],
            constant: [{ name: 'mainConst', line: 22 }]
          }
        }
      },
      'Bad Name': { symbols: { by_kind: { theorem: [{ name: 'invalid', line: 1 }] } } }
    },
    importsFrom: {
      'SeLe4n.Core.Main': ['SeLe4n.Core.Helper', 'Bad Name', 'SeLe4n.Core.Main'],
      'Bad Name': ['SeLe4n.Core.Helper'],
      main: ['SeLe4n.Core.Main']
    },
    externalImportsFrom: {
      'SeLe4n.Core.Main': ['Std.Data.List', 'SeLe4n.Core.Helper', 'Std.Data.List']
    }
  });

  assert.deepEqual(Array.from(normalized.modules), ['SeLe4n.Core.Helper', 'SeLe4n.Core.Main']);
  assert.deepEqual(Array.from(normalized.files), ['README.md', 'SeLe4n/Core/Helper.lean', 'SeLe4n/Core/Main.lean']);
  assert.ok(!Object.prototype.hasOwnProperty.call(normalized.moduleMap, 'Bad Name'));
  assert.deepEqual(Array.from(normalized.importsFrom['SeLe4n.Core.Main']), ['SeLe4n.Core.Helper']);
  assert.deepEqual(Array.from(normalized.importsFrom['SeLe4n.Core.Helper']), []);
  assert.deepEqual(Array.from(normalized.externalImportsFrom['SeLe4n.Core.Main']), ['Std.Data.List']);
  assert.deepEqual(Array.from(normalized.externalImportsFrom['SeLe4n.Core.Helper']), []);
  assert.equal(normalized.moduleMeta['SeLe4n.Core.Main'].symbols.byKind.constant[0].name, 'mainConst');
  assert.equal(normalized.moduleMeta['SeLe4n.Core.Helper'].theorems, 0);
});





test('normalizeMapData ignores branch-ref pseudo-modules and URL module paths', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      'main',
      { name: 'SeLe4n.Core.Main', path: 'https://githubusercontent.com/hatter6822/seLe4n/refs/heads/main/docs/codebase_map.json' },
      { name: 'SeLe4n.Core.Helper', path: 'SeLe4n/Core/Helper.lean' }
    ],
    importsFrom: {
      main: ['SeLe4n.Core.Main'],
      'SeLe4n.Core.Main': ['SeLe4n.Core.Helper']
    }
  });

  assert.deepEqual(Array.from(normalized.modules), ['SeLe4n.Core.Helper', 'SeLe4n.Core.Main']);
  assert.equal(normalized.moduleMap['SeLe4n.Core.Main'], 'SeLe4n/Core/Main.lean');
  assert.ok(!Object.prototype.hasOwnProperty.call(normalized.moduleMap, 'main'));
});

test('normalizeMapData rejects payloads that do not expose modules array data', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    moduleMap: { 'SeLe4n.Core.Main': 'SeLe4n/Core/Main.lean' },
    importsFrom: { 'SeLe4n.Core.Main': [] }
  });

  assert.equal(normalized, null);
});


test('normalizeMapData marks symbolsLoaded when normalized symbol lines are complete', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: ['SeLe4n.Model.State'],
    moduleMap: { 'SeLe4n.Model.State': 'SeLe4n/Model/State.lean' },
    moduleMeta: {
      'SeLe4n.Model.State': {
        symbols: {
          by_kind: {
            theorem: [{ name: 'safe', line: 4 }],
            def: [{ name: 'transition', line: 9 }],
            constant: [{ name: 'X', line: 12 }]
          }
        }
      }
    }
  });

  assert.equal(normalized.moduleMeta['SeLe4n.Model.State'].symbolsLoaded, true);
});

test('normalizeCanonicalPayload unwraps branch-keyed canonical map payloads', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeCanonicalPayload({
    main: {
      modules: ['SeLe4n.Core.Main'],
      moduleMap: { 'SeLe4n.Core.Main': 'SeLe4n/Core/Main.lean' },
      importsFrom: { 'SeLe4n.Core.Main': [] },
      moduleMeta: {
        'SeLe4n.Core.Main': {
          layer: 'other',
          kind: 'other',
          base: 'SeLe4n.Core.Main',
          theorems: 1
        }
      },
      generatedAt: '2026-01-01T00:00:00.000Z'
    }
  });

  assert.deepEqual(Array.from(normalized.modules), ['SeLe4n.Core.Main']);
  assert.equal(normalized.moduleMap['SeLe4n.Core.Main'], 'SeLe4n/Core/Main.lean');
  assert.equal(normalized.generatedAt, '2026-01-01T00:00:00.000Z');
});



test('normalizeCanonicalPayload prefers candidate with valid module names over branch-ref only modules', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeCanonicalPayload({
    modules: ['main'],
    main: {
      modules: ['SeLe4n.Core.Main'],
      moduleMap: { 'SeLe4n.Core.Main': 'SeLe4n/Core/Main.lean' },
      importsFrom: { 'SeLe4n.Core.Main': [] }
    }
  });

  assert.deepEqual(Array.from(normalized.modules), ['SeLe4n.Core.Main']);
  assert.ok(!Object.prototype.hasOwnProperty.call(normalized.moduleMap, 'main'));
});

test('normalizeCanonicalPayload prioritizes modules array and ignores branch-ref metadata keys', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeCanonicalPayload({
    main: 'https://githubusercontent.com/hatter6822/seLe4n/refs/heads/main',
    generatedAt: '2026-02-03T04:05:06.000Z',
    modules: ['SeLe4n.Core.Main'],
    moduleMap: {
      'SeLe4n.Core.Main': 'SeLe4n/Core/Main.lean',
      main: 'https://githubusercontent.com/hatter6822/seLe4n/refs/heads/main'
    },
    importsFrom: {
      'SeLe4n.Core.Main': [],
      main: ['SeLe4n.Core.Main']
    },
    moduleMeta: {
      'SeLe4n.Core.Main': { theorems: 2 }
    }
  });

  assert.deepEqual(Array.from(normalized.modules), ['SeLe4n.Core.Main']);
  assert.deepEqual(Object.keys(normalized.moduleMap), ['SeLe4n.Core.Main']);
  assert.ok(!Object.prototype.hasOwnProperty.call(normalized.importsFrom, 'main'));
  assert.equal(normalized.generatedAt, '2026-02-03T04:05:06.000Z');
});

test('normalizeCanonicalPayload prefers nested branch payload over weak top-level metadata', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeCanonicalPayload({
    moduleMap: { main: 'https://githubusercontent.com/hatter6822/seLe4n/refs/heads/main' },
    importsFrom: { main: ['SeLe4n.Core.Main'] },
    main: {
      modules: ['SeLe4n.Core.Main', 'SeLe4n.Core.Helper'],
      moduleMap: {
        'SeLe4n.Core.Main': 'SeLe4n/Core/Main.lean',
        'SeLe4n.Core.Helper': 'SeLe4n/Core/Helper.lean'
      },
      importsFrom: {
        'SeLe4n.Core.Main': ['SeLe4n.Core.Helper'],
        'SeLe4n.Core.Helper': []
      },
      moduleMeta: {
        'SeLe4n.Core.Main': { theorems: 1 },
        'SeLe4n.Core.Helper': { theorems: 0 }
      }
    }
  });

  assert.deepEqual(Array.from(normalized.modules), ['SeLe4n.Core.Helper', 'SeLe4n.Core.Main']);
  assert.deepEqual(Array.from(normalized.importsFrom['SeLe4n.Core.Main']), ['SeLe4n.Core.Helper']);
  assert.ok(!Object.prototype.hasOwnProperty.call(normalized.moduleMap, 'main'));
});



test('normalizeMapData derives theorem totals from symbol payloads when explicit counts are missing', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: ['SeLe4n.Core.Main'],
    moduleMeta: {
      'SeLe4n.Core.Main': {
        symbols: {
          by_kind: {
            theorem: [{ name: 'main_safe', line: 12 }],
            lemma: [{ name: 'helper', line: 18 }]
          }
        }
      }
    }
  });

  assert.equal(normalized.moduleMeta['SeLe4n.Core.Main'].theorems, 2);
});



test('normalizeMapData falls back to byKind when theorem/function arrays are empty', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: ['SeLe4n.Core.Main'],
    moduleMeta: {
      'SeLe4n.Core.Main': {
        symbols: {
          by_kind: {
            theorem: [{ name: 'main_safe', line: 7 }],
            def: [{ name: 'step', line: 11 }]
          },
          theorems: [],
          functions: []
        }
      }
    }
  });

  const symbols = normalized.moduleMeta['SeLe4n.Core.Main'].symbols;
  assert.deepEqual(Array.from(symbols.theorems, (item) => item.name), ['main_safe']);
  assert.deepEqual(Array.from(symbols.functions, (item) => item.name), ['step']);
});
test('normalizeMapData resolves dependency paths to module names', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      { name: 'SeLe4n.Core.Main', path: 'SeLe4n/Core/Main.lean', imports: [{ path: 'SeLe4n/Core/Helper.lean' }] },
      { name: 'SeLe4n.Core.Helper', path: 'SeLe4n/Core/Helper.lean' }
    ]
  });

  assert.deepEqual(Array.from(normalized.importsFrom['SeLe4n.Core.Main']), ['SeLe4n.Core.Helper']);
});


test('normalizeMapData projects modules[].declarations into symbol buckets', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Core.Main',
        path: 'SeLe4n/Core/Main.lean',
        declarations: [
          { kind: 'theorem', name: 'safe_main', line: 14 },
          { kind: 'def', name: 'step', line: 20 }
        ]
      }
    ]
  });

  assert.equal(normalized.moduleMeta['SeLe4n.Core.Main'].theorems, 1);
  assert.equal(normalized.moduleMeta['SeLe4n.Core.Main'].symbols.byKind.theorem[0].name, 'safe_main');
  assert.equal(normalized.moduleMeta['SeLe4n.Core.Main'].symbols.byKind.def[0].name, 'step');
  assert.equal(normalized.moduleMeta['SeLe4n.Core.Main'].symbolsLoaded, true);
});

test('interior kind group helpers default to all kinds and aggregate extension/context items', async () => {
  const hooks = await loadMapTestHooks();
  const interior = hooks.makeEmptyInteriorSymbols();

  interior.byKind.def = [{ name: 'mainDef', line: 12 }];
  interior.byKind.theorem = [{ name: 'mainThm', line: 30 }];
  interior.byKind.syntax = [{ name: 'syntaxAlias', line: 48 }];
  interior.byKind.macro = [{ name: 'macroExpand', line: 55 }];
  interior.byKind.namespace = [{ name: 'Core', line: 3 }];
  interior.byKind.initialize = [{ name: 'initCore', line: 90 }];

  const extensionKinds = ['declare_syntax_cat', 'syntax_cat', 'syntax', 'macro', 'macro_rules', 'notation', 'infix', 'infixl', 'infixr', 'prefix', 'postfix', 'elab', 'elab_rules', 'term_elab', 'command_elab', 'tactic'];
  const contextKinds = ['universe', 'universes', 'variable', 'variables', 'parameter', 'parameters', 'section', 'namespace', 'end', 'initialize'];

  assert.equal(hooks.pickInteriorDefaultKind(interior, extensionKinds, ''), '__all__');
  assert.equal(hooks.pickInteriorDefaultKind(interior, contextKinds, ''), '__all__');
  assert.equal(hooks.interiorGroupItemCount(interior, extensionKinds), 2);
  assert.equal(hooks.interiorGroupItemCount(interior, contextKinds), 2);

  const allExtensionItems = hooks.interiorItemsForSelection(interior, extensionKinds, '__all__', '');
  assert.deepEqual(Array.from(allExtensionItems, (item) => item.name), ['syntaxAlias', 'macroExpand']);

  const allContextItems = hooks.interiorItemsForSelection(interior, contextKinds, '__all__', 'init');
  assert.deepEqual(Array.from(allContextItems, (item) => item.name), ['initCore']);
});

test('flowLegendItems returns canonical flow legend entries', async () => {
  const hooks = await loadMapTestHooks();
  const items = hooks.flowLegendItems();

  assert.equal(items.length, 7);
  assert.equal(items[0].label, 'Selected module');
  assert.equal(items[0].color, '#7c9cff');
  assert.equal(items[6].label, 'Node tint = assurance level');
  assert.equal(items[6].color, '#8fa3bf');
});
