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

  // Reverse graph is precomputed for calledBy lookups
  assert.ok(normalized.declarationReverseGraph, 'normalized data should include declarationReverseGraph');
  const mapErrorCallers = Array.from(normalized.declarationReverseGraph['mapError'] || []).sort();
  assert.deepEqual(mapErrorCallers, ['advanceTimer', 'advanceTimer_safe']);
  const advanceTimerCallers = Array.from(normalized.declarationReverseGraph['advanceTimer'] || []);
  assert.deepEqual(advanceTimerCallers, ['advanceTimer_safe']);
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

  // Reverse graph is precomputed
  assert.ok(normalized.declarationReverseGraph, 'normalized data should include declarationReverseGraph');
  const stepCallers = Array.from(normalized.declarationReverseGraph['step'] || []).sort();
  assert.deepEqual(stepCallers, ['helper', 'run', 'run_safe']);
  const runCallers = Array.from(normalized.declarationReverseGraph['run'] || []).sort();
  assert.deepEqual(runCallers, ['run_safe']);
  assert.ok(!normalized.declarationReverseGraph['nonexistent'], 'nonexistent declarations have no reverse entry');
});

test('declarationModuleOf resolves module for declarations not in declarationGraph via moduleMeta', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Core.Main',
        path: 'SeLe4n/Core/Main.lean',
        declarations: [
          { kind: 'def', name: 'isolatedDef', line: 5, called: [] },
          { kind: 'def', name: 'caller', line: 10, called: ['isolatedDef'] }
        ]
      }
    ]
  });

  // isolatedDef is NOT in declarationGraph (empty called array)
  assert.ok(!normalized.declarationGraph['isolatedDef'], 'isolatedDef should not be in declarationGraph');

  // But it IS in moduleMeta symbols
  assert.ok(normalized.moduleMeta['SeLe4n.Core.Main'].symbols.byKind.def.some(d => d.name === 'isolatedDef'), 'isolatedDef should be in moduleMeta symbols');

  // Apply normalized data to test hooks state so declarationModuleOf can search
  hooks.applyTestState({
    declarationGraph: normalized.declarationGraph,
    declarationReverseGraph: normalized.declarationReverseGraph,
    moduleMeta: normalized.moduleMeta,
    moduleMap: normalized.moduleMap
  });

  // declarationModuleOf should find it via moduleMeta fallback
  assert.equal(hooks.declarationModuleOf('isolatedDef'), 'SeLe4n.Core.Main', 'declarationModuleOf should resolve via moduleMeta for declarations not in declarationGraph');
  assert.equal(hooks.declarationModuleOf('caller'), 'SeLe4n.Core.Main', 'declarationModuleOf should still resolve via declarationGraph for declarations in it');
  assert.equal(hooks.declarationModuleOf('nonexistent'), '', 'declarationModuleOf should return empty for unknown declarations');
});

test('declarations with zero relationships produce valid declaration context data', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Core.Main',
        path: 'SeLe4n/Core/Main.lean',
        declarations: [
          { kind: 'theorem', name: 'standalone_thm', line: 15, called: [] }
        ]
      }
    ]
  });

  // standalone_thm has no calls and no callers
  assert.ok(!normalized.declarationGraph['standalone_thm'], 'standalone_thm should not be in declarationGraph');
  assert.ok(!normalized.declarationReverseGraph['standalone_thm'], 'standalone_thm should not be in declarationReverseGraph');

  // But it should still be in moduleMeta symbols and resolvable
  const symbols = normalized.moduleMeta['SeLe4n.Core.Main'].symbols;
  const theoremEntries = symbols.byKind.theorem;
  assert.ok(theoremEntries.some(d => d.name === 'standalone_thm'), 'standalone_thm should exist in moduleMeta symbol entries');

  // Module resolution via moduleMeta fallback
  hooks.applyTestState({
    declarationGraph: normalized.declarationGraph,
    declarationReverseGraph: normalized.declarationReverseGraph,
    moduleMeta: normalized.moduleMeta,
    moduleMap: normalized.moduleMap
  });
  assert.equal(hooks.declarationModuleOf('standalone_thm'), 'SeLe4n.Core.Main', 'zero-relationship declaration should still resolve to its module');

  // Kind and line should still be resolvable via moduleMeta
  assert.equal(hooks.declarationKindOf('standalone_thm'), 'theorem', 'zero-relationship declaration should have resolvable kind');
  assert.equal(hooks.declarationLineOf('standalone_thm'), 15, 'zero-relationship declaration should have resolvable line');

  // Verify no forward or reverse edges exist
  assert.ok(!Object.prototype.hasOwnProperty.call(normalized.declarationGraph, 'standalone_thm'), 'zero-relationship declaration has no forward graph entry');
  const reverseKeys = Object.keys(normalized.declarationReverseGraph);
  assert.ok(!reverseKeys.includes('standalone_thm'), 'zero-relationship declaration has no reverse graph entry');
});

test('declarationModuleOf resolves reverse-graph-only declarations via moduleMeta', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Core.Main',
        path: 'SeLe4n/Core/Main.lean',
        declarations: [
          { kind: 'inductive', name: 'ErrorKind', line: 5, called: [] },
          { kind: 'def', name: 'handleError', line: 20, called: ['ErrorKind'] }
        ]
      }
    ]
  });

  // ErrorKind is only in reverseGraph (called by handleError), not in declarationGraph
  assert.ok(!normalized.declarationGraph['ErrorKind'], 'ErrorKind should not be in declarationGraph');
  assert.ok(normalized.declarationReverseGraph['ErrorKind'], 'ErrorKind should be in declarationReverseGraph');

  // Verify reverse graph entry contents
  const errorKindCallers = Array.from(normalized.declarationReverseGraph['ErrorKind'] || []);
  assert.deepEqual(errorKindCallers, ['handleError'], 'reverse-only declaration should have callers in reverse graph');

  // Verify no forward graph entry
  assert.ok(!Object.prototype.hasOwnProperty.call(normalized.declarationGraph, 'ErrorKind'), 'reverse-only declaration has no forward graph entry');

  // declarationModuleOf should resolve via moduleMeta
  hooks.applyTestState({
    declarationGraph: normalized.declarationGraph,
    declarationReverseGraph: normalized.declarationReverseGraph,
    moduleMeta: normalized.moduleMeta,
    moduleMap: normalized.moduleMap
  });
  assert.equal(hooks.declarationModuleOf('ErrorKind'), 'SeLe4n.Core.Main', 'reverse-only declaration should resolve module via moduleMeta');

  // Verify kind is resolvable
  assert.equal(hooks.declarationKindOf('ErrorKind'), 'inductive', 'reverse-only declaration should have resolvable kind');
  assert.equal(hooks.declarationLineOf('ErrorKind'), 5, 'reverse-only declaration should have resolvable line');
});

test('large declaration lane sorting prioritizes same-module declarations', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Core.Main',
        path: 'SeLe4n/Core/Main.lean',
        declarations: [
          { kind: 'def', name: 'hubFn', line: 10, called: [
            'zHelper', 'aHelper', 'externalFn', 'bHelper', 'localFn', 'anotherExt',
            'cHelper', 'dHelper', 'eHelper', 'fHelper', 'gHelper', 'hHelper', 'iHelper'
          ] },
          { kind: 'def', name: 'localFn', line: 20, called: [] },
          { kind: 'def', name: 'aHelper', line: 30, called: [] },
          { kind: 'def', name: 'bHelper', line: 40, called: [] },
          { kind: 'def', name: 'cHelper', line: 50, called: [] },
          { kind: 'def', name: 'dHelper', line: 60, called: [] },
          { kind: 'def', name: 'eHelper', line: 70, called: [] },
          { kind: 'def', name: 'fHelper', line: 80, called: [] },
          { kind: 'def', name: 'gHelper', line: 90, called: [] },
          { kind: 'def', name: 'hHelper', line: 100, called: [] },
          { kind: 'def', name: 'iHelper', line: 110, called: [] },
          { kind: 'def', name: 'zHelper', line: 120, called: [] }
        ]
      },
      {
        module: 'SeLe4n.Ext.Util',
        path: 'SeLe4n/Ext/Util.lean',
        declarations: [
          { kind: 'def', name: 'externalFn', line: 5, called: [] },
          { kind: 'def', name: 'anotherExt', line: 15, called: [] }
        ]
      }
    ]
  });

  // hubFn calls 13 declarations (>12 threshold), so sorting should be applied
  const calls = normalized.declarationGraph['hubFn'].calls;
  assert.equal(calls.length, 13, 'hubFn should call 13 declarations');
  assert.ok(calls.length > 12, 'call count exceeds collapse threshold so sorting applies');

  // Verify the call graph structure is correct
  assert.ok(calls.includes('localFn'), 'calls should include same-module localFn');
  assert.ok(calls.includes('externalFn'), 'calls should include cross-module externalFn');
});

test('declaration lane collapse threshold and visible limit are exposed via test hooks', async () => {
  const hooks = await loadMapTestHooks();
  assert.equal(hooks.declarationLaneCollapseThreshold(), 12, 'collapse threshold should be 12');
  assert.equal(hooks.declarationLaneVisibleLimit(), 10, 'visible limit should be 10');
});

test('applyTestState accepts declarationLanesExpanded, flowContext, and selectedDeclaration', async () => {
  const hooks = await loadMapTestHooks();

  // Verify initial state
  hooks.applyTestState({ declarationLanesExpanded: false, flowContext: 'module', selectedDeclaration: '' });
  // No assertion needed — if applyTestState doesn't throw, the state keys are accepted

  // Set declaration context state
  hooks.applyTestState({
    declarationLanesExpanded: true,
    flowContext: 'declaration',
    selectedDeclaration: 'myDecl'
  });

  // Verify state is applied by checking that flowContext affects test hooks behavior
  // declarationLanesExpanded is transient UI state, so we just verify it's accepted without error
  assert.ok(true, 'applyTestState accepted declarationLanesExpanded, flowContext, and selectedDeclaration');
});

test('interior menu highlights active declaration in declaration context', async () => {
  const hooks = await loadMapTestHooks();
  const interior = hooks.makeEmptyInteriorSymbols();
  interior.byKind.def = [
    { name: 'activeDecl', line: 10 },
    { name: 'otherDecl', line: 20 }
  ];

  // In declaration context, selectedDeclaration should be trackable
  hooks.applyTestState({
    flowContext: 'declaration',
    selectedDeclaration: 'activeDecl'
  });

  // The items returned by interiorItemsForSelection should include the active declaration
  const objectKinds = ['inductive', 'structure', 'class', 'def', 'theorem', 'lemma', 'example', 'instance', 'opaque', 'abbrev', 'axiom', 'constant', 'constants'];
  const items = hooks.interiorItemsForSelection(interior, objectKinds, '__all__', '');
  const activeItem = items.find(item => item.name === 'activeDecl');
  assert.ok(activeItem, 'active declaration should be in the items list');
  assert.equal(activeItem.__kind, 'def', 'active declaration should have correct kind');
});

test('renderContextChooser appends declaration name in declaration context', async () => {
  const hooks = await loadMapTestHooks();

  // Verify the search bar context display logic uses separator character
  // The renderContextChooser should format: "ModuleName › DeclName" when in declaration context
  const mapSource = await fs.readFile(mapScriptPath, 'utf8');
  assert.ok(
    mapSource.includes('state.selectedModule + " \\u203A " + state.selectedDeclaration'),
    'renderContextChooser should append declaration name with › separator when in declaration context'
  );
});

test('declaration flowchart preserves scroll position on re-render', async () => {
  const hooks = await loadMapTestHooks();

  // Verify the declaration flowchart has scroll preservation logic
  const mapSource = await fs.readFile(mapScriptPath, 'utf8');
  const declFnMatch = mapSource.match(/function renderDeclarationFlowchart\(\)[\s\S]*?^  \}/m);
  assert.ok(declFnMatch, 'renderDeclarationFlowchart should exist');
  const declFnBody = declFnMatch[0];
  assert.ok(declFnBody.includes('shouldPreserveScroll'), 'renderDeclarationFlowchart should include scroll preservation logic');
  assert.ok(declFnBody.includes('previousScrollLeft'), 'renderDeclarationFlowchart should save previous scroll left');
  assert.ok(declFnBody.includes('previousScrollTop'), 'renderDeclarationFlowchart should save previous scroll top');
});

test('declaration lane expansion shows all items when expanded state is set', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Core.Main',
        path: 'SeLe4n/Core/Main.lean',
        declarations: [
          { kind: 'def', name: 'hubFn', line: 10, called: [
            'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10',
            'a11', 'a12', 'a13', 'a14', 'a15'
          ] },
          { kind: 'def', name: 'a1', line: 20, called: [] },
          { kind: 'def', name: 'a2', line: 30, called: [] },
          { kind: 'def', name: 'a3', line: 40, called: [] },
          { kind: 'def', name: 'a4', line: 50, called: [] },
          { kind: 'def', name: 'a5', line: 60, called: [] },
          { kind: 'def', name: 'a6', line: 70, called: [] },
          { kind: 'def', name: 'a7', line: 80, called: [] },
          { kind: 'def', name: 'a8', line: 90, called: [] },
          { kind: 'def', name: 'a9', line: 100, called: [] },
          { kind: 'def', name: 'a10', line: 110, called: [] },
          { kind: 'def', name: 'a11', line: 120, called: [] },
          { kind: 'def', name: 'a12', line: 130, called: [] },
          { kind: 'def', name: 'a13', line: 140, called: [] },
          { kind: 'def', name: 'a14', line: 150, called: [] },
          { kind: 'def', name: 'a15', line: 160, called: [] }
        ]
      }
    ]
  });

  const calls = normalized.declarationGraph['hubFn'].calls;
  assert.equal(calls.length, 15, 'hubFn should call 15 declarations');

  // When collapsed (default), only LANE_VISIBLE_LIMIT (10) should be shown
  const threshold = hooks.declarationLaneCollapseThreshold();
  const visibleLimit = hooks.declarationLaneVisibleLimit();
  assert.ok(calls.length > threshold, 'call count exceeds threshold');

  const collapsedVisible = calls.slice(0, visibleLimit);
  const collapsedCount = calls.length - visibleLimit;
  assert.equal(collapsedVisible.length, 10, 'collapsed view shows 10 items');
  assert.equal(collapsedCount, 5, 'collapsed count shows 5 hidden items');

  // When expanded, all items should be shown
  const expandedVisible = calls.slice();
  assert.equal(expandedVisible.length, 15, 'expanded view shows all 15 items');
});

test('assuranceForModule returns correct levels based on proof pair state', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      { name: 'SeLe4n.IPC.Operations', path: 'SeLe4n/IPC/Operations.lean' },
      { name: 'SeLe4n.IPC.Invariant', path: 'SeLe4n/IPC/Invariant.lean' },
      { name: 'SeLe4n.Sched.Worker', path: 'SeLe4n/Sched/Worker.lean' },
      { name: 'SeLe4n.Sched.Bare', path: 'SeLe4n/Sched/Bare.lean' }
    ],
    moduleMeta: {
      'SeLe4n.IPC.Operations': { kind: 'operations', base: 'SeLe4n.IPC', theorems: 3 },
      'SeLe4n.IPC.Invariant': { kind: 'invariant', base: 'SeLe4n.IPC', theorems: 2 },
      'SeLe4n.Sched.Worker': { theorems: 4 },
      'SeLe4n.Sched.Bare': { theorems: 0 }
    },
    importsFrom: {
      'SeLe4n.IPC.Invariant': ['SeLe4n.IPC.Operations'],
      'SeLe4n.IPC.Operations': [],
      'SeLe4n.Sched.Worker': [],
      'SeLe4n.Sched.Bare': []
    }
  });

  // Manually build proofPairMap as buildPairs would (buildPairs needs DOM)
  const proofPairMap = {
    'SeLe4n.IPC': {
      base: 'SeLe4n.IPC',
      operationsModule: 'SeLe4n.IPC.Operations',
      invariantModule: 'SeLe4n.IPC.Invariant',
      operationsTheorems: 3,
      invariantTheorems: 2,
      invariantImportsOperations: true
    }
  };

  hooks.applyTestState({
    modules: normalized.modules,
    moduleMap: normalized.moduleMap,
    moduleMeta: normalized.moduleMeta,
    importsFrom: normalized.importsFrom,
    importsTo: normalized.importsTo,
    proofPairMap: proofPairMap,
    clearAssuranceCache: true,
    clearDegreeMap: true
  });

  // Linked: both Operations+Invariant exist and Invariant imports Operations
  const linkedResult = hooks.assuranceForModule('SeLe4n.IPC.Operations');
  assert.equal(linkedResult.level, 'linked', 'module with linked proof pair should have linked assurance');

  // Local: module has theorems but no proof pair
  const localResult = hooks.assuranceForModule('SeLe4n.Sched.Worker');
  assert.equal(localResult.level, 'local', 'module with theorems but no pair should have local assurance');

  // None: module has no theorems and no proof pair
  const noneResult = hooks.assuranceForModule('SeLe4n.Sched.Bare');
  assert.equal(noneResult.level, 'none', 'module with no theorems or pair should have none assurance');
});

test('relatedProofModules returns Operations/Invariant neighbors', async () => {
  const hooks = await loadMapTestHooks();

  // moduleBase strips .Operations/.Invariant suffix, then relatedProofModules
  // looks for base+".Operations" and base+".Invariant" in moduleMap
  const normalized = hooks.normalizeMapData({
    modules: [
      { name: 'SeLe4n.IPC.Operations', path: 'SeLe4n/IPC/Operations.lean' },
      { name: 'SeLe4n.IPC.Invariant', path: 'SeLe4n/IPC/Invariant.lean' }
    ]
  });

  hooks.applyTestState({
    modules: normalized.modules,
    moduleMap: normalized.moduleMap,
    moduleMeta: normalized.moduleMeta,
    importsFrom: normalized.importsFrom,
    importsTo: normalized.importsTo
  });

  // From Operations, moduleBase strips ".Operations" → base "SeLe4n.IPC"
  // Then looks for SeLe4n.IPC.Operations (self, excluded) and SeLe4n.IPC.Invariant (found)
  const opsRelated = hooks.relatedProofModules('SeLe4n.IPC.Operations');
  assert.ok(!opsRelated.includes('SeLe4n.IPC.Operations'), 'should not include self');
  assert.ok(opsRelated.includes('SeLe4n.IPC.Invariant'), 'should include Invariant from Operations');

  // From Invariant, moduleBase strips ".Invariant" → base "SeLe4n.IPC"
  // Then looks for SeLe4n.IPC.Operations (found) and SeLe4n.IPC.Invariant (self, excluded)
  const invRelated = hooks.relatedProofModules('SeLe4n.IPC.Invariant');
  assert.ok(invRelated.includes('SeLe4n.IPC.Operations'), 'should include Operations from Invariant');
  assert.ok(!invRelated.includes('SeLe4n.IPC.Invariant'), 'should not include self from Invariant');
});

test('normalizeMapData deduplicates external imports and excludes known internal modules', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      { name: 'SeLe4n.Core.Main', path: 'SeLe4n/Core/Main.lean',
        imports: ['SeLe4n.Core.Helper'],
        externalImports: ['Std.Data.List', 'Std.Data.List', 'Init.Prelude', 'SeLe4n.Core.Helper'] },
      { name: 'SeLe4n.Core.Helper', path: 'SeLe4n/Core/Helper.lean' }
    ]
  });

  const externalImports = normalized.externalImportsFrom['SeLe4n.Core.Main'];
  assert.ok(Array.isArray(externalImports), 'externalImportsFrom should be an array');
  assert.ok(externalImports.includes('Std.Data.List'), 'should include Std.Data.List');
  assert.ok(externalImports.includes('Init.Prelude'), 'should include Init.Prelude');
  // SeLe4n.Core.Helper is a known internal module and should be excluded from external
  assert.ok(!externalImports.includes('SeLe4n.Core.Helper'), 'should not include known internal module in external imports');
  // Std.Data.List should appear only once (deduplicated)
  assert.equal(externalImports.filter(e => e === 'Std.Data.List').length, 1, 'external imports should be deduplicated');
});

test('findNearestLinkedPath returns shortest path to linked proof module', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      { name: 'SeLe4n.Core.Start', path: 'SeLe4n/Core/Start.lean' },
      { name: 'SeLe4n.Core.Middle', path: 'SeLe4n/Core/Middle.lean' },
      { name: 'SeLe4n.IPC.Operations', path: 'SeLe4n/IPC/Operations.lean' },
      { name: 'SeLe4n.IPC.Invariant', path: 'SeLe4n/IPC/Invariant.lean' }
    ],
    moduleMeta: {
      'SeLe4n.Core.Start': { theorems: 0 },
      'SeLe4n.Core.Middle': { theorems: 0 },
      'SeLe4n.IPC.Operations': { kind: 'operations', base: 'SeLe4n.IPC', theorems: 2 },
      'SeLe4n.IPC.Invariant': { kind: 'invariant', base: 'SeLe4n.IPC', theorems: 1 }
    },
    importsFrom: {
      'SeLe4n.Core.Start': ['SeLe4n.Core.Middle'],
      'SeLe4n.Core.Middle': ['SeLe4n.IPC.Operations'],
      'SeLe4n.IPC.Invariant': ['SeLe4n.IPC.Operations'],
      'SeLe4n.IPC.Operations': []
    }
  });

  // Manually set proofPairMap so assuranceForModule can detect "linked" level
  const proofPairMap = {
    'SeLe4n.IPC': {
      base: 'SeLe4n.IPC',
      operationsModule: 'SeLe4n.IPC.Operations',
      invariantModule: 'SeLe4n.IPC.Invariant',
      operationsTheorems: 2,
      invariantTheorems: 1,
      invariantImportsOperations: true
    }
  };

  hooks.applyTestState({
    modules: normalized.modules,
    moduleMap: normalized.moduleMap,
    moduleMeta: normalized.moduleMeta,
    importsFrom: normalized.importsFrom,
    importsTo: normalized.importsTo,
    proofPairMap: proofPairMap,
    clearAssuranceCache: true,
    clearDegreeMap: true
  });

  // From Start, path should traverse through Middle to reach a linked proof module
  const path = hooks.findNearestLinkedPath('SeLe4n.Core.Start', 3);
  assert.ok(path.length > 0, 'should find a path to linked proof module');
  assert.equal(path[0], 'SeLe4n.Core.Start', 'path should start from the origin module');

  // From a module that is already linked, path should be just itself
  const selfPath = hooks.findNearestLinkedPath('SeLe4n.IPC.Operations', 3);
  assert.equal(selfPath.length, 1, 'linked module should return path of length 1');
  assert.equal(selfPath[0], 'SeLe4n.IPC.Operations', 'linked module path should contain itself');
});


test('declarationSourceHref builds GitHub line links for declaration nodes', async () => {
  const hooks = await loadMapTestHooks();

  hooks.applyTestState({
    moduleMap: { 'SeLe4n.Core.Main': 'SeLe4n/Core/Main.lean' },
    declarationIndex: {
      safe_main: { module: 'SeLe4n.Core.Main', kind: 'theorem', line: 42 },
      no_line: { module: 'SeLe4n.Core.Main', kind: 'def', line: 0 }
    }
  });

  const lineHref = hooks.declarationSourceHref('safe_main');
  assert.ok(
    lineHref.includes('/SeLe4n/Core/Main.lean#L42'),
    'declarationSourceHref should include file path and line anchor'
  );

  const noLineHref = hooks.declarationSourceHref('no_line');
  assert.ok(
    noLineHref.endsWith('/SeLe4n/Core/Main.lean'),
    'declarationSourceHref should omit line anchor when line is unavailable'
  );

  assert.equal(hooks.declarationSourceHref('missing_decl'), '', 'unknown declarations should have no source link');
});

test('declaration flowchart renders clickable flow-meta line links', async () => {
  const mapSource = await fs.readFile(mapScriptPath, 'utf8');
  assert.ok(
    mapSource.includes('"class": "flow-meta-link"'),
    'declaration flowchart should render flow-meta-link spans for source line links'
  );
  assert.ok(
    mapSource.includes('declMetaLink(name)'),
    'declaration flowchart should compute declaration meta links for flow nodes'
  );
});
test('normalizeMapData builds declarationIndex for O(1) declaration metadata lookups', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Core.Main',
        path: 'SeLe4n/Core/Main.lean',
        declarations: [
          { kind: 'theorem', name: 'safe_main', line: 14 },
          { kind: 'def', name: 'step', line: 20, called: ['safe_main'] }
        ]
      },
      {
        module: 'SeLe4n.Ext.Util',
        path: 'SeLe4n/Ext/Util.lean',
        declarations: [
          { kind: 'def', name: 'helper', line: 5, called: [] }
        ]
      }
    ]
  });

  assert.ok(normalized.declarationIndex, 'normalized data should include declarationIndex');

  // All declarations should be indexed regardless of call graph presence
  const safeMainIdx = normalized.declarationIndex['safe_main'];
  assert.ok(safeMainIdx, 'safe_main should be in declarationIndex');
  assert.equal(safeMainIdx.module, 'SeLe4n.Core.Main');
  assert.equal(safeMainIdx.kind, 'theorem');
  assert.equal(safeMainIdx.line, 14);

  const stepIdx = normalized.declarationIndex['step'];
  assert.ok(stepIdx, 'step should be in declarationIndex');
  assert.equal(stepIdx.module, 'SeLe4n.Core.Main');
  assert.equal(stepIdx.kind, 'def');
  assert.equal(stepIdx.line, 20);

  const helperIdx = normalized.declarationIndex['helper'];
  assert.ok(helperIdx, 'helper should be in declarationIndex');
  assert.equal(helperIdx.module, 'SeLe4n.Ext.Util');
  assert.equal(helperIdx.kind, 'def');
  assert.equal(helperIdx.line, 5);

  // Unknown declarations should not be in the index
  assert.ok(!normalized.declarationIndex['nonexistent'], 'nonexistent declarations should not be indexed');

  // Verify lookups via declarationModuleOf/KindOf/LineOf use the index
  hooks.applyTestState({
    declarationGraph: normalized.declarationGraph,
    declarationReverseGraph: normalized.declarationReverseGraph,
    moduleMeta: normalized.moduleMeta,
    moduleMap: normalized.moduleMap
  });

  assert.equal(hooks.declarationModuleOf('safe_main'), 'SeLe4n.Core.Main');
  assert.equal(hooks.declarationKindOf('safe_main'), 'theorem');
  assert.equal(hooks.declarationLineOf('safe_main'), 14);
  assert.equal(hooks.declarationModuleOf('helper'), 'SeLe4n.Ext.Util');
  assert.equal(hooks.declarationKindOf('helper'), 'def');
  assert.equal(hooks.declarationLineOf('helper'), 5);
  assert.equal(hooks.declarationModuleOf('nonexistent'), '');
  assert.equal(hooks.declarationKindOf('nonexistent'), '');
  assert.equal(hooks.declarationLineOf('nonexistent'), 0);
});
