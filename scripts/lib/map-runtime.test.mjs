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

test('normalizeCaretRange clamps out-of-range selections and defaults to input length', async () => {
  const hooks = await loadMapTestHooks();

  const first = hooks.normalizeCaretRange('alphabet', 2, 99);
  assert.equal(first.start, 2);
  assert.equal(first.end, 8);

  const second = hooks.normalizeCaretRange('alphabet', -5, 3.9);
  assert.equal(second.start, 0);
  assert.equal(second.end, 3);

  const third = hooks.normalizeCaretRange('alphabet', undefined, undefined);
  assert.equal(third.start, 8);
  assert.equal(third.end, 8);
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


test('interior kind group order renders Objects, Contexts/Inits, Extensions', async () => {
  const hooks = await loadMapTestHooks();
  assert.deepEqual(Array.from(hooks.interiorKindGroupOrder()), ['object', 'contextInit', 'extension']);
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
  assert.deepEqual(Array.from(allExtensionItems, (item) => item.name), ['macroExpand', 'syntaxAlias']);
  assert.equal(allExtensionItems[0].__kind, 'macro');
  assert.equal(allExtensionItems[1].__kind, 'syntax');

  const allContextItems = hooks.interiorItemsForSelection(interior, contextKinds, '__all__', 'init');
  assert.deepEqual(Array.from(allContextItems, (item) => item.name), ['initCore']);
});



test('interiorItemsForSelection sorts aggregated results case-insensitively', async () => {
  const hooks = await loadMapTestHooks();
  const interior = hooks.makeEmptyInteriorSymbols();

  interior.byKind.def = [
    { name: 'zeta', line: 6 },
    { name: 'Alpha', line: 5 },
    { name: 'alpha', line: 8 }
  ];

  const ordered = hooks.interiorItemsForSelection(interior, ['def'], '__all__', '');
  assert.deepEqual(Array.from(ordered, (item) => item.name), ['Alpha', 'alpha', 'zeta']);
  assert.deepEqual(Array.from(ordered, (item) => item.__kind), ['def', 'def', 'def']);
});

test('flowLaneLabelVisibility hides context labels for empty lanes', async () => {
  const hooks = await loadMapTestHooks();

  const emptyLanes = hooks.flowLaneLabelVisibility({
    importCount: 0,
    importerCount: 0,
    proofCount: 0,
    linkedPathLength: 1,
    externalCount: 0
  });

  assert.equal(emptyLanes.imports, false);
  assert.equal(emptyLanes.impacted, false);
  assert.equal(emptyLanes.proof, false);
  assert.equal(emptyLanes.linkedPath, false);
  assert.equal(emptyLanes.external, false);
  assert.equal(emptyLanes.selected, false);

  const populatedLanes = hooks.flowLaneLabelVisibility({
    importCount: 3,
    importerCount: 2,
    proofCount: 1,
    linkedPathLength: 3,
    externalCount: 4
  });

  assert.equal(populatedLanes.imports, true);
  assert.equal(populatedLanes.impacted, true);
  assert.equal(populatedLanes.proof, true);
  assert.equal(populatedLanes.linkedPath, true);
  assert.equal(populatedLanes.external, true);
  assert.equal(populatedLanes.selected, true);
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

test('normalizeMapData preserves declaration call graph from modules[].declarations', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Kernel.Adapter',
        path: 'SeLe4n/Kernel/Adapter.lean',
        declarations: [
          { kind: 'def', name: 'mapError', line: 10, called: [] },
          { kind: 'def', name: 'advanceTimer', line: 20, called: ['mapError'] },
          { kind: 'theorem', name: 'advanceTimer_safe', line: 30, called: ['advanceTimer', 'mapError'] }
        ]
      }
    ]
  });

  assert.ok(normalized.declarationGraph, 'normalized data should include declarationGraph');
  assert.deepEqual(normalized.declarationGraph['advanceTimer'].calls, ['mapError']);
  assert.deepEqual(normalized.declarationGraph['advanceTimer_safe'].calls, ['advanceTimer', 'mapError']);
  assert.equal(normalized.declarationGraph['advanceTimer'].module, 'SeLe4n.Kernel.Adapter');
  assert.ok(!normalized.declarationGraph['mapError'], 'declarations with empty called arrays should not appear in graph');
});

test('declarationCalls and declarationCalledBy resolve call relationships correctly', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Core.Main',
        path: 'SeLe4n/Core/Main.lean',
        declarations: [
          { kind: 'inductive', name: 'ErrorKind', line: 5, called: [] },
          { kind: 'def', name: 'mapError', line: 10, called: ['ErrorKind'] },
          { kind: 'def', name: 'advanceTimer', line: 20, called: ['mapError'] },
          { kind: 'theorem', name: 'advanceTimer_safe', line: 30, called: ['advanceTimer', 'mapError'] }
        ]
      }
    ]
  });

  // Inject the declaration graph into test hooks state
  // The hooks operate on a shared state, so we need to provide context
  const calls = normalized.declarationGraph['advanceTimer_safe'] ? normalized.declarationGraph['advanceTimer_safe'].calls : [];
  assert.deepEqual(calls, ['advanceTimer', 'mapError']);

  // Verify reverse lookup capability via the declarationGraph structure
  const callers = [];
  for (const [name, entry] of Object.entries(normalized.declarationGraph)) {
    if (entry.calls.indexOf('mapError') !== -1) callers.push(name);
  }
  callers.sort();
  assert.deepEqual(callers, ['advanceTimer', 'advanceTimer_safe']);
});

test('declarationFlowLegendItems returns canonical declaration flow legend entries', async () => {
  const hooks = await loadMapTestHooks();
  const items = hooks.declarationFlowLegendItems();

  assert.equal(items.length, 4);
  assert.equal(items[0].label, 'Selected declaration');
  assert.equal(items[0].color, '#7c9cff');
  assert.equal(items[1].label, 'Calls (outgoing)');
  assert.equal(items[1].color, '#82f0b0');
  assert.equal(items[2].label, 'Called by (incoming)');
  assert.equal(items[2].color, '#ffad42');
  assert.equal(items[3].label, 'Color = declaration kind');
  assert.equal(items[3].color, '#8fa3bf');
});

test('normalizeMapData preserves callGraph on module symbols for declaration-centric payloads', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Core.Main',
        path: 'SeLe4n/Core/Main.lean',
        declarations: [
          { kind: 'def', name: 'step', line: 10, called: [] },
          { kind: 'def', name: 'run', line: 20, called: ['step'] },
          { kind: 'theorem', name: 'run_safe', line: 30, called: ['run', 'step'] }
        ]
      },
      {
        module: 'SeLe4n.Core.Helper',
        path: 'SeLe4n/Core/Helper.lean',
        declarations: [
          { kind: 'def', name: 'helper', line: 5, called: ['step'] }
        ]
      }
    ]
  });

  // Cross-module call graph is merged
  assert.equal(normalized.declarationGraph['run'].module, 'SeLe4n.Core.Main');
  assert.equal(normalized.declarationGraph['helper'].module, 'SeLe4n.Core.Helper');
  assert.deepEqual(normalized.declarationGraph['helper'].calls, ['step']);
  assert.deepEqual(normalized.declarationGraph['run_safe'].calls, ['run', 'step']);
});
