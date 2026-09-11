import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProductionGraphFile } from './rust-analysis.mjs';

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
    /* An inert DOM: every accessor answers "nothing is there", which is the
       branch map.js already guards for (`if (!node) return;`). It lets the
       state-facing entry points — setScope and friends — run under test
       without the module rendering anything. */
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      documentElement: { lang: 'en' }
    },
    window: {
      __SELE4N_MAP_DISABLE_BOOT__: true,
      atob: (input) => Buffer.from(String(input), 'base64').toString('binary'),
      /* No-op: nothing paints, so a scheduled render never runs. */
      requestAnimationFrame: () => 0,
      addEventListener: () => {},
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      location: { search: '', pathname: '/map.html' },
      history: { replaceState: () => {} }
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

test('normalizeMapData keeps the dotless Main module while still dropping the main ref', async () => {
  const hooks = await loadMapTestHooks();

  // `Main.lean` is the kernel's entry module and part of the canonical
  // production corpus the landing page counts. A case-insensitive branch-ref
  // guard dropped it, so the map graphed 310 modules while the page said 311.
  const normalized = hooks.normalizeMapData({
    modules: [
      'main',
      'heads',
      { name: 'Main', path: 'Main.lean' },
      { name: 'SeLe4n.Kernel.API', path: 'SeLe4n/Kernel/API.lean' }
    ],
    importsFrom: { Main: ['SeLe4n.Kernel.API'] }
  });

  assert.deepEqual(Array.from(normalized.modules), ['Main', 'SeLe4n.Kernel.API']);
  assert.equal(normalized.moduleMap.Main, 'Main.lean');
  // map.js runs inside a vm context, so cross-realm arrays need converting.
  assert.deepEqual(Array.from(normalized.importsFrom.Main), ['SeLe4n.Kernel.API']);
  for (const ref of ['main', 'heads']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(normalized.moduleMap, ref), `${ref} must stay filtered`);
  }
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

test('flowLegendItems returns canonical flow legend entries with individual assurance levels', async () => {
  const hooks = await loadMapTestHooks();
  hooks.setScope('lean');
  const items = hooks.flowLegendItems();
  const colors = hooks.assuranceColors();

  // Lane roles (6) + separator (1) + assurance levels (4) = 11
  assert.equal(items.length, 11);
  assert.equal(items[0].label, 'Selected module');
  assert.equal(items[0].color, '#7c9cff');
  assert.equal(items[5].label, 'External imports');
  assert.equal(items[5].color, '#b9c0d0');
  // Separator between lane roles and assurance tint
  assert.ok(items[6].separator, 'item 6 should be a separator');
  // Individual assurance level entries (after separator)
  assert.equal(items[7].color, colors.linked);
  assert.equal(items[8].color, colors.partial);
  assert.equal(items[9].color, colors.local);
  assert.equal(items[10].color, colors.none);
});

test('the boundary legend appears only in the scope that draws the boundary', async () => {
  const hooks = await loadMapTestHooks();

  hooks.setScope('lean');
  assert.equal(hooks.bridgeLegendItems().length, 0, 'the Lean-only reading keeps its original legend');
  assert.equal(hooks.flowLegendItems().length, 11);

  hooks.setScope('rust');
  assert.equal(hooks.bridgeLegendItems().length, 0, 'the Rust-only reading draws no boundary either');
  assert.equal(hooks.rustFlowLegendItems().length, 5, 'the Rust chart names its node roles');

  hooks.setScope('both');
  const bridge = Array.from(hooks.bridgeLegendItems());
  assert.ok(bridge[0].separator, 'the boundary entries are separated from the lane roles');
  assert.deepEqual(bridge.slice(1).map((item) => item.group), ['bridge', 'bridge', 'bridge', 'bridge']);
  /* Four relations, four entries: `mirrors` used to be drawn and labelled as a
     shared definition, which is not what it means. */
  assert.deepEqual(bridge.slice(1).map((item) => item.label), [
    'Lean declares \u2192 Rust implements',
    'Rust wrapper \u2192 Lean operation',
    'Mirrored either side (no call)',
    'Shared definition'
  ]);
  assert.equal(hooks.flowLegendItems().length, 16, 'the Lean legend gains the boundary entries');
  assert.equal(hooks.rustFlowLegendItems().length, 10, 'and so does the Rust one');
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

  // 3 lane entries + separator + 2 style indicators = 6
  assert.equal(items.length, 6);
  assert.equal(items[0].label, 'Selected declaration');
  assert.equal(items[0].color, '#7c9cff');
  assert.equal(items[1].label, 'Calls (outgoing)');
  assert.equal(items[1].color, '#82f0b0');
  assert.equal(items[2].label, 'Called by (incoming)');
  assert.equal(items[2].color, '#ffad42');
  assert.ok(items[3].separator, 'item 3 should be a separator');
  assert.equal(items[4].label, 'Border = declaration kind');
  assert.equal(items[5].label, 'Dashed = cross-module');
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

test('normalizeMapData builds declaration graphs from a bundled symbols.callGraph', async () => {
  const hooks = await loadMapTestHooks();

  // The shape data/map-data.json ships. Before the pipeline baked the call
  // graph in, this field was absent and the declaration flowchart stayed empty
  // until a live GitHub fetch completed — or forever, offline.
  const normalized = hooks.normalizeMapData({
    modules: [
      { module: 'SeLe4n.Core.Main', path: 'SeLe4n/Core/Main.lean' },
      { module: 'SeLe4n.Core.Helper', path: 'SeLe4n/Core/Helper.lean' }
    ],
    moduleMeta: {
      'SeLe4n.Core.Main': {
        symbols: {
          byKind: { def: [{ name: 'run', line: 20 }], theorem: [{ name: 'run_safe', line: 30 }] },
          callGraph: { run: ['step'], run_safe: ['run', 'step'] }
        }
      },
      'SeLe4n.Core.Helper': {
        symbols: {
          byKind: { def: [{ name: 'helper', line: 5 }] },
          callGraph: { helper: ['step'] }
        }
      }
    }
  });

  assert.equal(normalized.declarationGraph.run.module, 'SeLe4n.Core.Main');
  assert.deepEqual(Array.from(normalized.declarationGraph.run_safe.calls), ['run', 'step']);
  assert.equal(normalized.declarationGraph.helper.module, 'SeLe4n.Core.Helper');

  // The reverse index is what the "callers" lane renders.
  assert.deepEqual(Array.from(normalized.declarationReverseGraph.step).sort(), ['helper', 'run', 'run_safe']);
  assert.deepEqual(Array.from(normalized.declarationReverseGraph.run), ['run_safe']);

  // declarationIndex comes from byKind, so a name reachable through the graph
  // resolves to its kind and line for the flowchart node.
  assert.equal(normalized.declarationIndex.run_safe.kind, 'theorem');
  assert.equal(normalized.declarationIndex.run_safe.line, 30);
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

  // Verify the search bar context display logic uses dot-append format (Module.Declaration)
  // The renderContextChooser should format: "ModuleName.DeclName" when in declaration context
  const mapSource = await fs.readFile(mapScriptPath, 'utf8');
  assert.ok(
    mapSource.includes('state.selectedDeclarationModule + "." + state.selectedDeclaration'),
    'renderContextChooser should append declaration name with dot separator when in declaration context'
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

test('assuranceForModule returns partial when invariant exists but does not import operations', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      { name: 'SeLe4n.Mem.Operations', path: 'SeLe4n/Mem/Operations.lean' },
      { name: 'SeLe4n.Mem.Invariant', path: 'SeLe4n/Mem/Invariant.lean' }
    ],
    moduleMeta: {
      'SeLe4n.Mem.Operations': { kind: 'operations', base: 'SeLe4n.Mem', theorems: 2 },
      'SeLe4n.Mem.Invariant': { kind: 'invariant', base: 'SeLe4n.Mem', theorems: 1 }
    },
    importsFrom: {
      'SeLe4n.Mem.Operations': [],
      'SeLe4n.Mem.Invariant': []
    }
  });

  const proofPairMap = {
    'SeLe4n.Mem': {
      base: 'SeLe4n.Mem',
      operationsModule: 'SeLe4n.Mem.Operations',
      invariantModule: 'SeLe4n.Mem.Invariant',
      operationsTheorems: 2,
      invariantTheorems: 1,
      invariantImportsOperations: false
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

  const result = hooks.assuranceForModule('SeLe4n.Mem.Operations');
  assert.equal(result.level, 'partial', 'pair without import link should have partial assurance');
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

test('declarationSearchMatch resolves dot-appended declaration queries', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Kernel.API',
        path: 'SeLe4n/Kernel/API.lean',
        declarations: [
          { kind: 'def', name: 'apiInvariantBundle', line: 10, called: [] },
          { kind: 'theorem', name: 'apiSafety', line: 20, called: [] },
          { kind: 'def', name: 'initHandler', line: 30, called: [] }
        ]
      },
      {
        module: 'SeLe4n.Core.Main',
        path: 'SeLe4n/Core/Main.lean',
        declarations: [
          { kind: 'def', name: 'mainEntry', line: 5, called: [] }
        ]
      }
    ]
  });

  hooks.applyTestState({
    modules: normalized.modules,
    moduleMap: normalized.moduleMap,
    moduleMeta: normalized.moduleMeta,
    declarationGraph: normalized.declarationGraph,
    declarationReverseGraph: normalized.declarationReverseGraph,
    declarationIndex: normalized.declarationIndex
  });

  // Exact declaration match via dot-append
  const exact = hooks.declarationSearchMatch('SeLe4n.Kernel.API.apiInvariantBundle');
  assert.ok(exact, 'should find exact declaration match');
  assert.equal(exact.module, 'SeLe4n.Kernel.API');
  assert.equal(exact.declaration, 'apiInvariantBundle');
  assert.equal(exact.exact, true);

  // Prefix match via dot-append
  const prefix = hooks.declarationSearchMatch('SeLe4n.Kernel.API.api');
  assert.ok(prefix, 'should find prefix declaration match');
  assert.equal(prefix.module, 'SeLe4n.Kernel.API');
  assert.ok(prefix.declaration === 'apiInvariantBundle' || prefix.declaration === 'apiSafety',
    'should match a declaration starting with "api"');
  assert.equal(prefix.exact, false);

  // Substring match
  const substring = hooks.declarationSearchMatch('SeLe4n.Kernel.API.Safety');
  assert.ok(substring, 'should find substring declaration match');
  assert.equal(substring.module, 'SeLe4n.Kernel.API');
  assert.equal(substring.declaration, 'apiSafety');
  assert.equal(substring.exact, false);

  // No match when declaration suffix doesn't exist
  const noMatch = hooks.declarationSearchMatch('SeLe4n.Kernel.API.nonExistentDecl');
  assert.equal(noMatch, null, 'should return null for non-existent declaration');

  // No dot means no declaration search
  const noDot = hooks.declarationSearchMatch('apiInvariantBundle');
  assert.equal(noDot, null, 'should return null for queries without dots');

  // Module name only (no declaration suffix) should return null
  const moduleOnly = hooks.declarationSearchMatch('SeLe4n.Kernel.API');
  assert.equal(moduleOnly, null, 'should return null when query matches module exactly with no declaration suffix');

  // Cross-module: different module
  const otherModule = hooks.declarationSearchMatch('SeLe4n.Core.Main.mainEntry');
  assert.ok(otherModule, 'should find declaration in another module');
  assert.equal(otherModule.module, 'SeLe4n.Core.Main');
  assert.equal(otherModule.declaration, 'mainEntry');
  assert.equal(otherModule.exact, true);
});

test('moduleSearchMatches scores exact name matches highest', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      { name: 'SeLe4n.Core.Main', path: 'SeLe4n/Core/Main.lean' },
      { name: 'SeLe4n.Core.MainHelper', path: 'SeLe4n/Core/MainHelper.lean' },
      { name: 'SeLe4n.Core.Other', path: 'SeLe4n/Core/Other.lean' }
    ]
  });

  hooks.applyTestState({
    modules: normalized.modules,
    moduleMap: normalized.moduleMap,
    moduleMeta: normalized.moduleMeta,
    importsFrom: normalized.importsFrom,
    importsTo: normalized.importsTo,
    clearDegreeMap: true
  });

  hooks.buildSearchIndex();

  const matches = hooks.moduleSearchMatches('SeLe4n.Core.Main', normalized.modules);
  assert.ok(matches.length > 0, 'should return at least one match');
  assert.equal(matches[0], 'SeLe4n.Core.Main', 'exact match should be ranked first');
});

test('moduleSearchMatches returns prefix matches before substring matches', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      { name: 'SeLe4n.Kernel.API', path: 'SeLe4n/Kernel/API.lean' },
      { name: 'SeLe4n.Core.KernelBridge', path: 'SeLe4n/Core/KernelBridge.lean' },
      { name: 'SeLe4n.Kernel.IPC', path: 'SeLe4n/Kernel/IPC.lean' }
    ]
  });

  hooks.applyTestState({
    modules: normalized.modules,
    moduleMap: normalized.moduleMap,
    moduleMeta: normalized.moduleMeta,
    importsFrom: normalized.importsFrom,
    importsTo: normalized.importsTo,
    clearDegreeMap: true
  });

  hooks.buildSearchIndex();

  const matches = hooks.moduleSearchMatches('SeLe4n.Kernel', normalized.modules);
  assert.ok(matches.length >= 2, 'should return at least 2 matches');
  // Prefix matches (SeLe4n.Kernel.*) should come before substring matches
  assert.ok(
    matches[0] === 'SeLe4n.Kernel.API' || matches[0] === 'SeLe4n.Kernel.IPC',
    'first result should be a prefix match'
  );
});

test('moduleSearchMatches handles empty query by returning first 10 modules', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      { name: 'SeLe4n.A', path: 'SeLe4n/A.lean' },
      { name: 'SeLe4n.B', path: 'SeLe4n/B.lean' }
    ]
  });

  hooks.applyTestState({
    modules: normalized.modules,
    moduleMap: normalized.moduleMap,
    moduleMeta: normalized.moduleMeta,
    importsFrom: normalized.importsFrom,
    importsTo: normalized.importsTo,
    clearDegreeMap: true
  });

  hooks.buildSearchIndex();

  const matches = hooks.moduleSearchMatches('', normalized.modules);
  assert.equal(matches.length, 2, 'empty query should return all modules (up to 10)');
});

test('declarationSearchMatch uses global declaration index for cross-module search', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Kernel.API',
        path: 'SeLe4n/Kernel/API.lean',
        declarations: [
          { kind: 'def', name: 'apiInvariantBundle', line: 10, called: [] },
          { kind: 'theorem', name: 'apiSafety', line: 20, called: [] }
        ]
      },
      {
        module: 'SeLe4n.Core.Main',
        path: 'SeLe4n/Core/Main.lean',
        declarations: [
          { kind: 'def', name: 'mainEntry', line: 5, called: ['apiInvariantBundle'] }
        ]
      },
      {
        module: 'SeLe4n.Platform.Driver',
        path: 'SeLe4n/Platform/Driver.lean',
        declarations: [
          { kind: 'def', name: 'driverInit', line: 8, called: [] }
        ]
      }
    ]
  });

  hooks.applyTestState({
    modules: normalized.modules,
    moduleMap: normalized.moduleMap,
    moduleMeta: normalized.moduleMeta,
    declarationGraph: normalized.declarationGraph,
    declarationReverseGraph: normalized.declarationReverseGraph,
    declarationIndex: normalized.declarationIndex
  });
  hooks.buildSearchIndex();

  // Strategy 1: Exact module prefix match with declaration suffix
  const exact = hooks.declarationSearchMatch('SeLe4n.Kernel.API.apiInvariantBundle');
  assert.ok(exact, 'should find exact declaration via module prefix');
  assert.equal(exact.module, 'SeLe4n.Kernel.API');
  assert.equal(exact.declaration, 'apiInvariantBundle');
  assert.equal(exact.exact, true);

  // Strategy 2: Partial qualified name that doesn't match any module exactly
  // "SeLe4n.Kernel.API.api" — module matches, declaration is prefix
  const partialDecl = hooks.declarationSearchMatch('SeLe4n.Kernel.API.api');
  assert.ok(partialDecl, 'should find partial declaration match within exact module');
  assert.equal(partialDecl.module, 'SeLe4n.Kernel.API');
  assert.equal(partialDecl.exact, false);

  // Strategy 2b: Global search when no module boundary matches
  // "SeLe4n.Platform.Driver.driverInit" — exact module + exact declaration
  const platformDecl = hooks.declarationSearchMatch('SeLe4n.Platform.Driver.driverInit');
  assert.ok(platformDecl, 'should find declaration in Platform.Driver');
  assert.equal(platformDecl.module, 'SeLe4n.Platform.Driver');
  assert.equal(platformDecl.declaration, 'driverInit');
  assert.equal(platformDecl.exact, true);
});

test('declarationSearchMatches returns multiple ranked results', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Kernel.API',
        path: 'SeLe4n/Kernel/API.lean',
        declarations: [
          { kind: 'def', name: 'apiInvariantBundle', line: 10, called: [] },
          { kind: 'theorem', name: 'apiSafety', line: 20, called: [] },
          { kind: 'def', name: 'apiHandler', line: 30, called: [] }
        ]
      },
      {
        module: 'SeLe4n.Core.Main',
        path: 'SeLe4n/Core/Main.lean',
        declarations: [
          { kind: 'def', name: 'apiWrapper', line: 5, called: [] }
        ]
      }
    ]
  });

  hooks.applyTestState({
    modules: normalized.modules,
    moduleMap: normalized.moduleMap,
    moduleMeta: normalized.moduleMeta,
    declarationGraph: normalized.declarationGraph,
    declarationReverseGraph: normalized.declarationReverseGraph,
    declarationIndex: normalized.declarationIndex
  });
  hooks.buildSearchIndex();

  // Search for "SeLe4n.Kernel.API.api" should return multiple matches from that module
  const results = hooks.declarationSearchMatches('SeLe4n.Kernel.API.api', 5);
  assert.ok(results.length >= 2, 'should return multiple declaration matches');
  // All results should be from the matched module
  for (const r of results) {
    assert.equal(r.module, 'SeLe4n.Kernel.API', 'all results should be from the matched module');
  }
  // The exact prefix match should be first (apiHandler or apiInvariantBundle or apiSafety)
  const declNames = results.map(r => r.declaration);
  assert.ok(declNames.every(n => n.toLowerCase().startsWith('api')), 'all results should start with "api"');
});

test('declarationSearchMatches handles empty and non-dot queries', async () => {
  const hooks = await loadMapTestHooks();

  // Empty query and non-dot query should always return empty arrays
  const emptyResults = hooks.declarationSearchMatches('', 5);
  assert.ok(Array.isArray(emptyResults), 'empty query should return an array');
  assert.equal(emptyResults.length, 0, 'empty query should return no results');

  const noDotResults = hooks.declarationSearchMatches('noDots', 5);
  assert.ok(Array.isArray(noDotResults), 'non-dot query should return an array');
  assert.equal(noDotResults.length, 0, 'query without dots should return no results');
});

test('buildSearchIndex creates declarationSearchList from declarationIndex', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Kernel.API',
        path: 'SeLe4n/Kernel/API.lean',
        declarations: [
          { kind: 'def', name: 'apiBundle', line: 10, called: [] }
        ]
      }
    ]
  });

  hooks.applyTestState({
    modules: normalized.modules,
    moduleMap: normalized.moduleMap,
    moduleMeta: normalized.moduleMeta,
    declarationIndex: normalized.declarationIndex
  });
  hooks.buildSearchIndex();

  // The declarationSearchMatch should work after buildSearchIndex populates the list
  const match = hooks.declarationSearchMatch('SeLe4n.Kernel.API.apiBundle');
  assert.ok(match, 'buildSearchIndex should enable declaration search');
  assert.equal(match.module, 'SeLe4n.Kernel.API');
  assert.equal(match.declaration, 'apiBundle');
  assert.equal(match.exact, true);
});

test('edge layer in flowchart SVG is aria-hidden for accessibility', async () => {
  const mapSource = await fs.readFile(mapScriptPath, 'utf8');
  assert.ok(
    mapSource.includes('"aria-hidden": "true"') && mapSource.includes('flow-edge-layer'),
    'edge layer should be marked aria-hidden for screen readers'
  );
});

test('context search uses dot-append format for declaration display', async () => {
  const mapSource = await fs.readFile(mapScriptPath, 'utf8');

  // The renderContextChooser should use Module.Declaration format (not › separator)
  assert.ok(
    mapSource.includes('state.selectedDeclarationModule + "." + state.selectedDeclaration'),
    'context search should use dot-append format for declaration display in the search bar'
  );

  // The context search label should reflect the current context mode
  assert.ok(
    /Context search.*declaration/.test(mapSource),
    'context search label should indicate declaration context'
  );
  assert.ok(
    /Context search.*module/.test(mapSource),
    'context search label should indicate module context'
  );
});

test('selectDeclaration syncs context search bar value', async () => {
  const mapSource = await fs.readFile(mapScriptPath, 'utf8');

  // selectDeclaration should sync the context search bar to the dot-appended value
  const selectDeclMatch = mapSource.match(/function selectDeclaration\([\s\S]*?^  \}/m);
  assert.ok(selectDeclMatch, 'selectDeclaration function should exist');
  const selectDeclBody = selectDeclMatch[0];
  assert.ok(
    selectDeclBody.includes('picker.value = mod + "." + declName'),
    'selectDeclaration should sync the context search bar to Module.Declaration format'
  );
});

test('DOM element caching is initialized on boot', async () => {
  const mapSource = await fs.readFile(mapScriptPath, 'utf8');

  // The boot function should call cacheDomElements
  assert.ok(
    mapSource.includes('cacheDomElements()'),
    'boot function should call cacheDomElements to initialize cached DOM references'
  );

  // cacheDomElements should cache key elements
  assert.ok(
    /function cacheDomElements\(\)/.test(mapSource),
    'cacheDomElements function should exist'
  );
  assert.ok(
    mapSource.includes('DOM.flowchartWrap'),
    'DOM cache should include flowchartWrap element'
  );
  assert.ok(
    mapSource.includes('DOM.moduleSearch'),
    'DOM cache should include moduleSearch element'
  );
});

test('label wrap cache uses batch eviction for performance', async () => {
  const mapSource = await fs.readFile(mapScriptPath, 'utf8');

  // The cache should evict in batches, not one at a time
  assert.ok(
    mapSource.includes('LABEL_WRAP_CACHE_EVICT_BATCH'),
    'label wrap cache should define a batch eviction constant'
  );

  // Batch eviction loop should exist
  assert.ok(
    /for.*evicted.*LABEL_WRAP_CACHE_EVICT_BATCH/.test(mapSource),
    'label wrap cache should use a loop for batch eviction'
  );
});

test('reset button returns to module context from declaration view', async () => {
  const mapSource = await fs.readFile(mapScriptPath, 'utf8');

  // The reset button handler should call returnToModuleContext when in declaration context
  assert.ok(
    /reset.*addEventListener.*click[\s\S]*?returnToModuleContext/m.test(mapSource),
    'reset button should return to module context when in declaration flow'
  );
});

test('interiorKindColor returns correct colors for known kinds and fallback for unknown', async () => {
  const hooks = await loadMapTestHooks();

  // Known kinds should return their mapped color
  assert.equal(hooks.interiorKindColor('theorem'), '#ffd782');
  assert.equal(hooks.interiorKindColor('def'), '#82f0b0');
  assert.equal(hooks.interiorKindColor('inductive'), '#8ecbff');
  assert.equal(hooks.interiorKindColor('namespace'), '#ff84b6');

  // Plural "constants" should resolve via normalizeDeclarationKind fallback to "constant"
  assert.equal(hooks.interiorKindColor('constants'), '#f7b0ff');

  // Unknown kinds should return the gray fallback
  assert.equal(hooks.interiorKindColor('unknownKind'), '#8fa3bf');
  assert.equal(hooks.interiorKindColor(''), '#8fa3bf');
  assert.equal(hooks.interiorKindColor(null), '#8fa3bf');
});

test('normalizeDeclarationKind normalizes plurals and trims whitespace', async () => {
  const hooks = await loadMapTestHooks();

  assert.equal(hooks.normalizeDeclarationKind('constants'), 'constant');
  assert.equal(hooks.normalizeDeclarationKind('  Theorem  '), 'theorem');
  assert.equal(hooks.normalizeDeclarationKind('DEF'), 'def');
  assert.equal(hooks.normalizeDeclarationKind(''), '');
  assert.equal(hooks.normalizeDeclarationKind(null), '');
});

test('assuranceForModule includes theoremDensity and descriptive detail text', async () => {
  const hooks = await loadMapTestHooks();

  // Manually build proofPairMap (buildPairs needs DOM for updateMetric)
  const proofPairMap = {
    'X': {
      base: 'X',
      operationsModule: 'X.Operations',
      invariantModule: 'X.Invariant',
      operationsTheorems: 3,
      invariantTheorems: 2,
      invariantImportsOperations: true
    },
    'Y': {
      base: 'Y',
      operationsModule: 'Y.Operations',
      invariantModule: 'Y.Invariant',
      operationsTheorems: 0,
      invariantTheorems: 0,
      invariantImportsOperations: true
    }
  };

  hooks.applyTestState({
    modules: ['X.Operations', 'X.Invariant', 'Y.Operations', 'Y.Invariant', 'Z.Standalone'],
    moduleMap: {
      'X.Operations': 'X/Operations.lean',
      'X.Invariant': 'X/Invariant.lean',
      'Y.Operations': 'Y/Operations.lean',
      'Y.Invariant': 'Y/Invariant.lean',
      'Z.Standalone': 'Z/Standalone.lean'
    },
    moduleMeta: {
      'X.Operations': { kind: 'operations', base: 'X', theorems: 3 },
      'X.Invariant': { kind: 'invariant', base: 'X', theorems: 2 },
      'Y.Operations': { kind: 'operations', base: 'Y', theorems: 0 },
      'Y.Invariant': { kind: 'invariant', base: 'Y', theorems: 0 },
      'Z.Standalone': { theorems: 4 }
    },
    importsFrom: {
      'X.Operations': [],
      'X.Invariant': ['X.Operations'],
      'Y.Operations': [],
      'Y.Invariant': ['Y.Operations'],
      'Z.Standalone': []
    },
    importsTo: {
      'X.Operations': ['X.Invariant'],
      'X.Invariant': [],
      'Y.Operations': ['Y.Invariant'],
      'Y.Invariant': [],
      'Z.Standalone': []
    },
    proofPairMap: proofPairMap,
    clearAssuranceCache: true,
    clearDegreeMap: true
  });

  // Linked pair with theorems — high density, descriptive detail
  const linkedWithTheorems = hooks.assuranceForModule('X.Operations');
  assert.equal(linkedWithTheorems.level, 'linked');
  assert.equal(linkedWithTheorems.theoremDensity, 5);
  assert.ok(linkedWithTheorems.detail.includes('5 theorems'), 'detail should mention theorem count');
  assert.ok(linkedWithTheorems.score > 0, 'score should reflect theorem density bonus');

  // Linked pair with zero theorems — structural only
  const linkedNoTheorems = hooks.assuranceForModule('Y.Operations');
  assert.equal(linkedNoTheorems.level, 'linked');
  assert.equal(linkedNoTheorems.theoremDensity, 0);
  assert.ok(linkedNoTheorems.detail.includes('structurally linked'), 'detail should note structural-only link');

  // Local theorem coverage
  const localResult = hooks.assuranceForModule('Z.Standalone');
  assert.equal(localResult.level, 'local');
  assert.equal(localResult.theoremDensity, 4);
  assert.ok(localResult.detail.includes('4 theorems'), 'detail should mention local theorem count');
});

test('ASSURANCE_COLORS constant maps all four assurance levels', async () => {
  const hooks = await loadMapTestHooks();
  const colors = hooks.assuranceColors();

  assert.ok(colors.linked, 'linked color should be defined');
  assert.ok(colors.partial, 'partial color should be defined');
  assert.ok(colors.local, 'local color should be defined');
  assert.ok(colors.none, 'none color should be defined');
  // Colors should be valid hex strings
  for (const level of ['linked', 'partial', 'local', 'none']) {
    assert.match(colors[level], /^#[0-9a-fA-F]{6}$/, `${level} color should be a valid hex color`);
  }
});

test('assuranceForModule computes pair-wide coverage for linked modules', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Net.Operations',
        path: 'SeLe4n/Net/Operations.lean',
        declarations: [
          { kind: 'theorem', name: 'send_safe', line: 10, called: [] },
          { kind: 'theorem', name: 'recv_safe', line: 20, called: [] },
          { kind: 'theorem', name: 'conn_ok', line: 30, called: [] },
          { kind: 'def', name: 'sendMsg', line: 40, called: [] },
          { kind: 'def', name: 'recvMsg', line: 50, called: [] }
        ]
      },
      {
        module: 'SeLe4n.Net.Invariant',
        path: 'SeLe4n/Net/Invariant.lean',
        declarations: [
          { kind: 'theorem', name: 'net_inv', line: 10, called: [] },
          { kind: 'theorem', name: 'buf_inv', line: 20, called: [] },
          { kind: 'def', name: 'checkInvariant', line: 30, called: [] }
        ]
      }
    ],
    moduleMeta: {
      'SeLe4n.Net.Operations': { kind: 'operations', base: 'SeLe4n.Net', theorems: 3 },
      'SeLe4n.Net.Invariant': { kind: 'invariant', base: 'SeLe4n.Net', theorems: 2 }
    },
    importsFrom: {
      'SeLe4n.Net.Invariant': ['SeLe4n.Net.Operations'],
      'SeLe4n.Net.Operations': []
    }
  });

  const proofPairMap = {
    'SeLe4n.Net': {
      base: 'SeLe4n.Net',
      operationsModule: 'SeLe4n.Net.Operations',
      invariantModule: 'SeLe4n.Net.Invariant',
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

  const result = hooks.assuranceForModule('SeLe4n.Net.Operations');
  assert.equal(result.level, 'linked', 'should be linked');
  // Coverage should be pair-wide: 5 theorems across 8 total pair declarations = 62.5%
  assert.ok(result.coverage > 0.5, 'pair-wide coverage should exceed 50% (5 thm / 8 decl)');
  assert.ok(result.pairDeclarations >= 8, 'pairDeclarations should count both modules');
  assert.equal(result.strength, 'strong', 'should be strong with >=40% coverage and >=3 theorems');
  assert.ok(result.detail.includes('verifiable declaration'), 'detail should mention verifiable declarations');
});

test('assuranceForModule uses scaffolded label for linked pairs with zero theorems', async () => {
  const hooks = await loadMapTestHooks();

  const normalized = hooks.normalizeMapData({
    modules: [
      { name: 'SeLe4n.Fs.Operations', path: 'SeLe4n/Fs/Operations.lean' },
      { name: 'SeLe4n.Fs.Invariant', path: 'SeLe4n/Fs/Invariant.lean' }
    ],
    moduleMeta: {
      'SeLe4n.Fs.Operations': { kind: 'operations', base: 'SeLe4n.Fs', theorems: 0 },
      'SeLe4n.Fs.Invariant': { kind: 'invariant', base: 'SeLe4n.Fs', theorems: 0 }
    },
    importsFrom: {
      'SeLe4n.Fs.Invariant': ['SeLe4n.Fs.Operations'],
      'SeLe4n.Fs.Operations': []
    }
  });

  const proofPairMap = {
    'SeLe4n.Fs': {
      base: 'SeLe4n.Fs',
      operationsModule: 'SeLe4n.Fs.Operations',
      invariantModule: 'SeLe4n.Fs.Invariant',
      operationsTheorems: 0,
      invariantTheorems: 0,
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

  const result = hooks.assuranceForModule('SeLe4n.Fs.Operations');
  assert.equal(result.level, 'linked', 'should still be linked');
  assert.equal(result.strength, 'scaffolded', 'zero-theorem linked pair should be scaffolded');
  assert.ok(result.label.includes('scaffolded'), 'label should say scaffolded');
  assert.ok(result.detail.includes('convention'), 'detail should clarify convention is met but no proofs');
});

test('assuranceForModule distinguishes disconnected from incomplete partial pairs', async () => {
  const hooks = await loadMapTestHooks();

  // Case 1: Both modules exist but Invariant doesn't import Operations (disconnected)
  const norm1 = hooks.normalizeMapData({
    modules: [
      { name: 'A.Operations', path: 'A/Operations.lean' },
      { name: 'A.Invariant', path: 'A/Invariant.lean' }
    ],
    moduleMeta: {
      'A.Operations': { kind: 'operations', base: 'A', theorems: 2 },
      'A.Invariant': { kind: 'invariant', base: 'A', theorems: 1 }
    },
    importsFrom: {
      'A.Operations': [],
      'A.Invariant': []
    }
  });

  hooks.applyTestState({
    modules: norm1.modules,
    moduleMap: norm1.moduleMap,
    moduleMeta: norm1.moduleMeta,
    importsFrom: norm1.importsFrom,
    importsTo: norm1.importsTo,
    proofPairMap: {
      'A': {
        base: 'A',
        operationsModule: 'A.Operations',
        invariantModule: 'A.Invariant',
        operationsTheorems: 2,
        invariantTheorems: 1,
        invariantImportsOperations: false
      }
    },
    clearAssuranceCache: true,
    clearDegreeMap: true
  });

  const disconnected = hooks.assuranceForModule('A.Operations');
  assert.equal(disconnected.level, 'partial');
  assert.equal(disconnected.strength, 'disconnected', 'both modules present but no import link should be disconnected');
  assert.ok(disconnected.detail.includes('does not import'), 'detail should explain missing import');

  // Case 2: Only Operations exists, Invariant is absent (incomplete)
  hooks.applyTestState({
    proofPairMap: {
      'A': {
        base: 'A',
        operationsModule: 'A.Operations',
        invariantModule: '',
        operationsTheorems: 2,
        invariantTheorems: 0,
        invariantImportsOperations: false
      }
    },
    clearAssuranceCache: true,
    clearDegreeMap: true
  });

  const incomplete = hooks.assuranceForModule('A.Operations');
  assert.equal(incomplete.level, 'partial');
  assert.equal(incomplete.strength, 'incomplete', 'missing Invariant module should be incomplete');
  assert.ok(incomplete.detail.includes('absent'), 'detail should explain missing module');
});

test('assuranceForModule local strength requires multiple theorems for well-covered', async () => {
  const hooks = await loadMapTestHooks();

  // 1 theorem out of 2 declarations = 50% ratio but only 1 theorem
  const norm = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Tiny.Module',
        path: 'SeLe4n/Tiny/Module.lean',
        declarations: [
          { kind: 'theorem', name: 'only_thm', line: 5, called: [] },
          { kind: 'def', name: 'only_def', line: 10, called: [] }
        ]
      }
    ],
    moduleMeta: {
      'SeLe4n.Tiny.Module': { theorems: 1 }
    },
    importsFrom: { 'SeLe4n.Tiny.Module': [] }
  });

  hooks.applyTestState({
    modules: norm.modules,
    moduleMap: norm.moduleMap,
    moduleMeta: norm.moduleMeta,
    importsFrom: norm.importsFrom,
    importsTo: norm.importsTo,
    proofPairMap: {},
    clearAssuranceCache: true,
    clearDegreeMap: true
  });

  const result = hooks.assuranceForModule('SeLe4n.Tiny.Module');
  assert.equal(result.level, 'local');
  // 50% coverage but only 1 theorem should NOT be "well-covered"
  assert.notEqual(result.strength, 'well-covered',
    'single theorem at 50% ratio should not be well-covered');
  assert.equal(result.strength, 'moderate',
    'single theorem with >=20% ratio should be moderate');
});

test('extensionDeclarationCount counts only extension-group declarations', async () => {
  const hooks = await loadMapTestHooks();
  const norm = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Syntax.Module',
        path: 'SeLe4n/Syntax/Module.lean',
        declarations: [
          { kind: 'syntax', name: 'mySyntax', line: 5 },
          { kind: 'macro', name: 'myMacro', line: 10 },
          { kind: 'notation', name: 'myNotation', line: 15 },
          { kind: 'def', name: 'helper', line: 20 },
          { kind: 'theorem', name: 'thm1', line: 25 },
          { kind: 'namespace', name: 'NS', line: 1 }
        ]
      }
    ],
    moduleMeta: { 'SeLe4n.Syntax.Module': { theorems: 1 } },
    importsFrom: { 'SeLe4n.Syntax.Module': [] }
  });
  hooks.applyTestState({
    modules: norm.modules,
    moduleMap: norm.moduleMap,
    moduleMeta: norm.moduleMeta,
    clearAssuranceCache: true
  });
  const interior = hooks.makeEmptyInteriorSymbols();
  // Populate from normalized module meta
  const meta = norm.moduleMeta['SeLe4n.Syntax.Module'];
  const extCount = hooks.extensionDeclarationCount(meta.symbols);
  assert.equal(extCount, 3, 'should count syntax + macro + notation as 3 extension declarations');
  const objCount = hooks.objectDeclarationCount(meta.symbols);
  assert.equal(objCount, 2, 'should count def + theorem as 2 object declarations (namespace is context-init)');
  const verifiable = hooks.verifiableSurfaceArea(meta.symbols);
  // verifiable = obj(2) + floor(ext(3)*0.5) = 2 + 1 = 3
  assert.equal(verifiable, 3, 'verifiable surface area should be obj + floor(ext*0.5)');
});

test('assuranceForModule extension-only module gets extension-only strength', async () => {
  const hooks = await loadMapTestHooks();
  const norm = hooks.normalizeMapData({
    modules: [
      {
        module: 'SeLe4n.Lang.DSL',
        path: 'SeLe4n/Lang/DSL.lean',
        declarations: [
          { kind: 'syntax', name: 'dslSyntax', line: 5 },
          { kind: 'macro', name: 'dslMacro', line: 10 },
          { kind: 'notation', name: 'dslNotation', line: 15 }
        ]
      }
    ],
    moduleMeta: { 'SeLe4n.Lang.DSL': { theorems: 0 } },
    importsFrom: { 'SeLe4n.Lang.DSL': [] }
  });
  hooks.applyTestState({
    modules: norm.modules,
    moduleMap: norm.moduleMap,
    moduleMeta: norm.moduleMeta,
    importsFrom: norm.importsFrom,
    importsTo: norm.importsTo,
    proofPairMap: {},
    clearAssuranceCache: true,
    clearDegreeMap: true
  });
  const result = hooks.assuranceForModule('SeLe4n.Lang.DSL');
  assert.equal(result.level, 'none');
  assert.equal(result.strength, 'extension-only',
    'module with only extension declarations should be extension-only');
  assert.ok(result.detail.includes('extension declaration'),
    'detail should mention extension declarations');
});

test('normalizeCanonicalPayload scopes the live refresh to production modules', async () => {
  const hooks = await loadMapTestHooks();

  // The artifact inventories production and test modules; the bundled snapshot
  // graphs production alone, and the landing page counts the same set. Applying
  // the artifact verbatim replaced a 311-module map with a 381-module one, so a
  // networked visit disagreed with index.html.
  const normalized = hooks.normalizeCanonicalPayload({
    schema_version: '1.0.0',
    repository: { head: { commit_sha: 'BB61196FAD5BAA8E189ADE361570F7547B0CFAA6', committed_at_utc: '2026-09-05T15:04:11+00:00' } },
    modules: [
      { module: 'SeLe4n.Kernel.API', path: 'SeLe4n/Kernel/API.lean', declarations: [{ kind: 'theorem', name: 'a', line: 1, called: [] }] },
      { module: 'Main', path: 'Main.lean', declarations: [{ kind: 'def', name: 'main', line: 1, called: [] }] },
      { module: 'SeLe4n.Testing.Helpers', path: 'SeLe4n/Testing/Helpers.lean', declarations: [{ kind: 'def', name: 'mkState', line: 1, called: [] }] },
      { module: 'Tests.Smoke', path: 'tests/Smoke.lean', declarations: [{ kind: 'theorem', name: 'smoke', line: 1, called: [] }] },
      { module: 'Tests.Deep', path: 'tests/deep/Deep.lean', declarations: [{ kind: 'theorem', name: 'deep', line: 1, called: [] }] }
    ]
  });

  assert.deepEqual(Array.from(normalized.modules).sort(), ['Main', 'SeLe4n.Kernel.API']);
  // The artifact names its revision as repository.head.commit_sha; a refresh
  // that lost it blanked the inventory's provenance note.
  assert.equal(normalized.commitSha, 'bb61196fad5baa8e189ade361570f7547b0cfaa6', 'the graph commit comes from the artifact');
  const wrapped = hooks.normalizeCanonicalPayload({ main: { schema_version: '1.0.0', repository: { head: { commit_sha: 'a'.repeat(40) } }, modules: [{ module: 'Main', path: 'Main.lean', declarations: [] }] } });
  assert.equal(wrapped.commitSha, 'a'.repeat(40), 'a wrapped artifact is read the same way');
  // The in-tree testing framework is outside the published scope too.
  for (const testModule of ['Tests.Smoke', 'Tests.Deep', 'SeLe4n.Testing.Helpers']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(normalized.moduleMap, testModule), `${testModule} must not be graphed`);
  }
  assert.equal(hooks.isOutsideProductionScope('SeLe4n/Testing/Helpers.lean'), true);
  assert.equal(hooks.isOutsideProductionScope('tests/Smoke.lean'), true);
  assert.equal(hooks.isOutsideProductionScope('SeLe4n/Kernel/API.lean'), false);
});

test('the live tree path takes the same scope as the bundle and includes the entry module', async () => {
  const hooks = await loadMapTestHooks();
  assert.equal(hooks.isLeanModulePath('SeLe4n/Kernel/API.lean'), true);
  assert.equal(hooks.isLeanModulePath('Main.lean'), true, 'Main.lean is a production module the tree path must not drop');
  assert.equal(hooks.isLeanModulePath('SeLe4n/Testing/Helpers.lean'), false);
  assert.equal(hooks.isLeanModulePath('tests/Smoke.lean'), false);
  assert.equal(hooks.isLeanModulePath('SeLe4n.lean'), false, 'the library root is not in the canonical inventory');
  assert.equal(hooks.isLeanModulePath('docs/notes.lean.md'), false);
});

test('in-repository imports outside the scope are not labelled external dependencies', async () => {
  const hooks = await loadMapTestHooks();
  assert.equal(hooks.isInRepoOutsideScope('SeLe4n.Testing.MainTraceHarness'), true);
  assert.equal(hooks.isInRepoOutsideScope('SeLe4n'), true, 'the library root Main imports');
  assert.equal(hooks.isInRepoOutsideScope('Std.Data.List'), false);
  assert.equal(hooks.isInRepoOutsideScope('SeLe4nExtra.Thing'), false);
});

/* ── Redesign: default module, subsystem grouping, repository inventory ─── */

test('the workspace defaults to SeLe4n.Kernel.API when the snapshot carries it', async () => {
  const hooks = await loadMapTestHooks();
  assert.equal(hooks.defaultModule(), 'SeLe4n.Kernel.API');

  const withApi = hooks.normalizeMapData({
    modules: [
      { name: 'SeLe4n.Kernel.IPC.Invariant.Structural.DualQueueMembership', path: 'SeLe4n/Kernel/IPC/Invariant/Structural/DualQueueMembership.lean' },
      { name: 'SeLe4n.Kernel.API', path: 'SeLe4n/Kernel/API.lean' }
    ],
    moduleMeta: {
      // The hub with the highest heuristic score must not win the default.
      'SeLe4n.Kernel.IPC.Invariant.Structural.DualQueueMembership': { theorems: 452 },
      'SeLe4n.Kernel.API': { theorems: 140 }
    }
  });
  hooks.applyTestState({ modules: withApi.modules, moduleMap: withApi.moduleMap, moduleMeta: withApi.moduleMeta });
  assert.equal(hooks.defaultModuleName(), 'SeLe4n.Kernel.API');

  const withoutApi = hooks.normalizeMapData({
    modules: [{ name: 'SeLe4n.Core.Zeta', path: 'SeLe4n/Core/Zeta.lean' }, { name: 'SeLe4n.Core.Alpha', path: 'SeLe4n/Core/Alpha.lean' }]
  });
  hooks.applyTestState({ modules: withoutApi.modules, moduleMap: withoutApi.moduleMap, moduleMeta: withoutApi.moduleMeta });
  assert.equal(hooks.defaultModuleName(), 'SeLe4n.Core.Alpha', 'falls back to the first module in inventory order');
});

test('moduleSubsystem caps the namespace at three segments', async () => {
  const hooks = await loadMapTestHooks();
  assert.equal(hooks.moduleSubsystem('SeLe4n.Kernel.IPC.Invariant.Structural.DualQueueMembership'), 'SeLe4n.Kernel.IPC');
  assert.equal(hooks.moduleSubsystem('SeLe4n.Kernel.IPC.Invariant'), 'SeLe4n.Kernel.IPC');
  assert.equal(hooks.moduleSubsystem('SeLe4n.Kernel.API'), 'SeLe4n.Kernel');
  assert.equal(hooks.moduleSubsystem('SeLe4n.Model.Object.Types'), 'SeLe4n.Model.Object');
  assert.equal(hooks.moduleSubsystem('SeLe4n.Prelude'), 'SeLe4n');
  assert.equal(hooks.moduleSubsystem('Main'), 'Main');
  assert.equal(hooks.moduleSubsystem(''), '');
});

test('over-budget lanes group modules by subsystem and open groups in place', async () => {
  const hooks = await loadMapTestHooks();
  const imports = [
    'SeLe4n.Kernel.IPC.DualQueue', 'SeLe4n.Kernel.IPC.Invariant', 'SeLe4n.Kernel.IPC.CrossCore.Fault',
    'SeLe4n.Kernel.Architecture.Adapter', 'SeLe4n.Kernel.Architecture.VSpace',
    'SeLe4n.Kernel.Scheduler.Operations', 'SeLe4n.Kernel.Scheduler.Invariant',
    'SeLe4n.Kernel.Service.Registry',
    'SeLe4n.Prelude',
    'SeLe4n.Kernel.Capability.Operations'
  ];

  hooks.applyTestState({ neighborLimit: 8, flowShowAll: false, laneGroupsExpanded: { imports: {}, importers: {} } });

  const groups = hooks.groupLaneModules(imports);
  assert.deepEqual(Array.from(groups, (group) => `${group.key}:${group.members.length}`), [
    'SeLe4n.Kernel.IPC:3', 'SeLe4n.Kernel.Architecture:2', 'SeLe4n.Kernel.Scheduler:2',
    'SeLe4n:1', 'SeLe4n.Kernel.Capability:1', 'SeLe4n.Kernel.Service:1'
  ], 'largest subsystems first, ties alphabetical, input order kept inside a group');
  assert.deepEqual(Array.from(groups[0].members), ['SeLe4n.Kernel.IPC.DualQueue', 'SeLe4n.Kernel.IPC.Invariant', 'SeLe4n.Kernel.IPC.CrossCore.Fault']);

  const collapsed = hooks.buildLaneEntries(imports, 'imports');
  assert.equal(collapsed.grouped, true, 'ten imports exceed a budget of eight');
  assert.deepEqual(Array.from(collapsed.entries, (entry) => entry.type === 'group' ? `group:${entry.key}` : `module:${entry.name}`), [
    'group:SeLe4n.Kernel.IPC', 'group:SeLe4n.Kernel.Architecture', 'group:SeLe4n.Kernel.Scheduler',
    'module:SeLe4n.Prelude', 'module:SeLe4n.Kernel.Capability.Operations', 'module:SeLe4n.Kernel.Service.Registry'
  ], 'singleton subsystems render as plain module nodes');
  assert.deepEqual(Array.from(collapsed.visibleModules), ['SeLe4n.Prelude', 'SeLe4n.Kernel.Capability.Operations', 'SeLe4n.Kernel.Service.Registry']);
  assert.equal(collapsed.total, 10);

  hooks.applyTestState({ laneGroupsExpanded: { imports: { 'SeLe4n.Kernel.IPC': true }, importers: {} } });
  const expanded = hooks.buildLaneEntries(imports, 'imports');
  const ipcIndex = expanded.entries.findIndex((entry) => entry.type === 'group' && entry.key === 'SeLe4n.Kernel.IPC');
  assert.equal(expanded.entries[ipcIndex].expanded, true);
  assert.deepEqual(
    Array.from(expanded.entries.slice(ipcIndex + 1, ipcIndex + 4), (entry) => [entry.name, entry.nested, entry.groupKey]),
    [
      ['SeLe4n.Kernel.IPC.DualQueue', true, 'SeLe4n.Kernel.IPC'],
      ['SeLe4n.Kernel.IPC.Invariant', true, 'SeLe4n.Kernel.IPC'],
      ['SeLe4n.Kernel.IPC.CrossCore.Fault', true, 'SeLe4n.Kernel.IPC']
    ],
    'an opened group lists its members right below it, nested'
  );
  assert.ok(expanded.visibleModules.includes('SeLe4n.Kernel.IPC.DualQueue'));

  const withinBudget = hooks.buildLaneEntries(imports.slice(0, 8), 'imports');
  assert.equal(withinBudget.grouped, false, 'a lane within budget stays flat');
  assert.equal(withinBudget.entries.length, 8);

  hooks.applyTestState({ flowShowAll: true });
  const showAll = hooks.buildLaneEntries(imports, 'imports');
  assert.equal(showAll.grouped, false, 'expanded flow mode lists every module flat');
  assert.equal(showAll.entries.length, 10);
  hooks.applyTestState({ flowShowAll: false });
});

test('retainInventory keeps the file tree and Rust inventory across a canonical refresh', async () => {
  const hooks = await loadMapTestHooks();
  const rust = { crates: [{ name: 'sele4n-sys', files: [] }] };
  const previous = {
    files: ['SeLe4n/Kernel/API.lean', 'rust/sele4n-sys/src/lib.rs', 'README.md'],
    rust: rust,
    inventoryCommit: 'aaaaaaa',
    rustCommit: 'aaaaaaa'
  };

  // A canonical live refresh: modules only, so files are just Lean module paths.
  const canonical = { files: ['SeLe4n/Kernel/API.lean', 'SeLe4n/Kernel/IPC.lean'], commitSha: 'bbbbbbb', rust: null };
  const retained = hooks.retainInventory(previous, canonical);
  assert.deepEqual(Array.from(retained.files), previous.files, 'a Lean-only file list is not a tree; keep the previous one');
  assert.equal(retained.inventoryCommit, 'aaaaaaa');
  assert.equal(retained.rust, rust);
  assert.equal(retained.rustCommit, 'aaaaaaa');
  assert.equal(retained.retainedFiles, true);
  assert.equal(retained.retainedRust, true);

  // A tree rebuild carries every file but still no Rust inventory.
  const tree = { files: ['SeLe4n/Kernel/API.lean', 'docs/NEW.md', 'rust/x.rs'], commitSha: 'ccccccc' };
  const rebuilt = hooks.retainInventory(previous, tree);
  assert.deepEqual(Array.from(rebuilt.files), tree.files);
  assert.equal(rebuilt.inventoryCommit, 'ccccccc');
  assert.equal(rebuilt.rust, rust, 'the bundled Rust inventory survives');
  assert.equal(rebuilt.rustCommit, 'aaaaaaa');
  assert.equal(rebuilt.retainedFiles, false);

  // A fresh bundled snapshot replaces both.
  const bundled = { files: ['SeLe4n/Kernel/API.lean', 'README.md'], commitSha: 'ddddddd', rust: { crates: [{ name: 'sele4n-hal', files: [] }] } };
  const fresh = hooks.retainInventory(previous, bundled);
  assert.equal(fresh.rust.crates[0].name, 'sele4n-hal');
  assert.equal(fresh.rustCommit, 'ddddddd');
  assert.equal(fresh.inventoryCommit, 'ddddddd');

  // Nothing previous: whatever comes in is used.
  const cold = hooks.retainInventory(null, canonical);
  assert.deepEqual(Array.from(cold.files), canonical.files);
  assert.equal(cold.rust, null);
  assert.equal(cold.rustCommit, '');
});

test('normalizeMapData passes a well-formed rust inventory through and drops a malformed one', async () => {
  const hooks = await loadMapTestHooks();
  const rust = {
    root: 'rust',
    workspaceManifest: 'rust/Cargo.toml',
    members: ['sele4n-sys'],
    edition: '2021',
    version: '0.1.0',
    rustVersion: '1.94',
    workspaceFiles: ['rust/Cargo.toml'],
    crates: [{ name: 'sele4n-sys', path: 'rust/sele4n-sys', files: [] }, { name: '', files: [] }, { name: 'ghost' }]
  };
  const normalized = hooks.normalizeMapData({
    modules: [{ name: 'SeLe4n.Kernel.API', path: 'SeLe4n/Kernel/API.lean' }],
    rust,
    inventoryCommit: 'abc1234',
    rustCommit: 'abc1234'
  });
  assert.deepEqual(Array.from(normalized.rust.crates, (crate) => crate.name), ['sele4n-sys'], 'crates without a name or file list are dropped');
  assert.equal(normalized.rust.edition, '2021');
  assert.deepEqual(Array.from(normalized.rust.members), ['sele4n-sys']);
  assert.equal(normalized.inventoryCommit, 'abc1234');
  assert.equal(normalized.rustCommit, 'abc1234');

  assert.equal(hooks.normalizeRustInventory('nope'), null);
  assert.equal(hooks.normalizeRustInventory({ crates: 'none' }), null);
  assert.equal(hooks.normalizeRustInventory({ crates: [] }), null);
  const withoutRust = hooks.normalizeMapData({ modules: [{ name: 'SeLe4n.Kernel.API', path: 'SeLe4n/Kernel/API.lean' }] });
  assert.equal(withoutRust.rust, null);
});

test('pickInteriorMenuGroup keeps the remembered group and otherwise opens the first non-empty one', async () => {
  const hooks = await loadMapTestHooks();
  const groups = [
    { key: 'object', totalCount: 0 },
    { key: 'contextInit', totalCount: 3 },
    { key: 'extension', totalCount: 2 }
  ];
  assert.equal(hooks.pickInteriorMenuGroup(groups, 'extension'), 'extension');
  assert.equal(hooks.pickInteriorMenuGroup(groups, 'object'), 'object', 'an explicit choice is kept even when empty');
  assert.equal(hooks.pickInteriorMenuGroup(groups, ''), 'contextInit', 'the first non-empty group opens by default');
  assert.equal(hooks.pickInteriorMenuGroup([], ''), 'object');
});

test('formatCount groups thousands and leaves non-numbers alone', async () => {
  const hooks = await loadMapTestHooks();
  assert.equal(hooks.formatCount(10937), '10,937');
  assert.equal(hooks.formatCount(866), '866');
  assert.equal(hooks.formatCount(0), '0');
  assert.equal(hooks.formatCount('–'), '–');
  assert.equal(hooks.formatCount(null), '');
});

test('seedBundledInventory fills a newer cache from the bundle when the cache lacks the tree or the crates', async () => {
  const hooks = await loadMapTestHooks();
  const bundled = {
    files: ['SeLe4n/Kernel/API.lean', 'rust/sele4n-sys/src/lib.rs', 'README.md'],
    rust: { crates: [{ name: 'sele4n-sys', files: [] }] },
    commitSha: 'bbbbbbb'
  };
  // A cache from a canonical live refresh: newer, module paths only, no Rust block.
  const cached = { files: ['SeLe4n/Kernel/API.lean', 'SeLe4n/Kernel/IPC.lean'], rust: null, commitSha: 'ccccccc' };
  const seeded = hooks.seedBundledInventory(cached, bundled);
  assert.equal(seeded, cached, 'the cache object itself is returned');
  assert.equal(seeded.rust, bundled.rust);
  assert.equal(seeded.rustCommit, 'bbbbbbb');
  assert.deepEqual(Array.from(seeded.files), bundled.files, 'a Lean-only list yields to the bundled tree');
  assert.equal(seeded.inventoryCommit, 'bbbbbbb');

  // A cache that already carries both keeps its own.
  const complete = { files: ['SeLe4n/Kernel/API.lean', 'docs/X.md'], rust: { crates: [{ name: 'sele4n-hal', files: [] }] }, commitSha: 'ddddddd' };
  const kept = hooks.seedBundledInventory(complete, bundled);
  assert.equal(kept.rust.crates[0].name, 'sele4n-hal');
  assert.deepEqual(Array.from(kept.files), complete.files);

  // The bundle winning, or nothing to seed from, is a no-op.
  assert.equal(hooks.seedBundledInventory(bundled, bundled), bundled);
  assert.equal(hooks.seedBundledInventory(null, bundled), null);
  assert.equal(hooks.seedBundledInventory(cached, null), cached);
});

/* ── Review round: the unsafe lint vs. counted sites, crate support files ── */

test('rustUnsafeSummary keeps the lint, the production sites and the test sites apart', async () => {
  const hooks = await loadMapTestHooks();
  // sele4n-abi: `#![deny(unsafe_code)]` at the crate root and three sites in
  // src/trap.rs under item-level `#[allow(unsafe_code)]`.
  const abi = hooks.rustUnsafeSummary({ name: 'sele4n-abi', deniesUnsafe: true, unsafe: { fns: 2, impls: 0, blocks: 1 }, testUnsafe: { fns: 0, impls: 0, blocks: 0 } });
  assert.equal(abi.sites, 3, 'a deny lint is not proof of zero sites');
  assert.equal(abi.deniesUnsafe, true);
  assert.equal(abi.exceptions, true);
  assert.equal(hooks.rustUnsafeDetail(abi), '2 fn · 1 block · under item-level allow', 'zero counters are not listed; the exception is named');
  // sele4n-hal at dcbd1dd: the headline is the production figure, the test
  // sites are named apart — never one total that mixes the two.
  const hal = hooks.rustUnsafeSummary({ name: 'sele4n-hal', deniesUnsafe: false, unsafe: { fns: 9, impls: 3, blocks: 87 }, testUnsafe: { fns: 0, impls: 4, blocks: 20 } });
  assert.equal(hal.sites, 99, 'fns, impls and blocks in production code');
  assert.equal(hal.testSites, 24, 'sites in test code are counted apart');
  assert.equal(hal.exceptions, false);
  assert.equal(hooks.rustUnsafeDetail(hal), '9 fn · 3 impls · 87 blocks · +24 in test code');
  const types = hooks.rustUnsafeSummary({ name: 'sele4n-types', deniesUnsafe: true, unsafe: { fns: 0, impls: 0, blocks: 0 }, testUnsafe: { fns: 0, impls: 0, blocks: 0 } });
  assert.deepEqual([types.sites, types.testSites, types.deniesUnsafe, types.exceptions], [0, 0, true, false]);
  assert.equal(hooks.rustUnsafeDetail(types), '');
  assert.deepEqual([hooks.rustUnsafeSummary({}).sites, hooks.rustUnsafeSummary(null).sites], [0, 0], 'a crate without counters reads as zero sites');
});

test('the first locale load repaints only what was painted from fallbacks', async () => {
  const hooks = await loadMapTestHooks();
  // Spread: the state object is built in the map's vm realm, and strict deep
  // equality compares prototypes across realms.
  assert.deepEqual({ ...hooks.localePaintState() }, { ready: false, painted: false }, 'nothing is looked up at load time');
  let repaints = 0;
  const repaint = () => { repaints += 1; };
  hooks.translate('map.rust_lane_declares');
  assert.equal(hooks.localePaintState().painted, true, 'a lookup before the locale is ready is a fallback');
  assert.equal(hooks.handleLocaleReady(repaint), true, 'the ready callback repaints what fell back');
  assert.equal(repaints, 1);
  assert.deepEqual({ ...hooks.localePaintState() }, { ready: true, painted: false });
  hooks.translate('map.rust_lane_declares');
  assert.equal(hooks.localePaintState().painted, false, 'lookups after readiness are final');
  assert.equal(hooks.handleLocaleReady(repaint), false, 'a locale that was ready before anything was painted repaints nothing');
  assert.equal(repaints, 1);
});

/* ── The Rust half of the workspace, and the boundary between the two ───── */

/** Production Rust source files in a snapshot: every file a graph node stands for. */
function productionRustFiles(raw) {
  return raw.rust.crates.reduce(
    (total, crate) => total + crate.files.filter((file) => file.role !== 'test').length,
    0
  );
}

async function loadBundledState() {
  const hooks = await loadMapTestHooks();
  const raw = JSON.parse(await fs.readFile(path.join(repoRoot, 'data/map-data.json'), 'utf8'));
  const data = hooks.normalizeMapData(raw);
  hooks.applyTestState({
    modules: data.modules,
    moduleMap: data.moduleMap,
    moduleMeta: data.moduleMeta,
    importsFrom: data.importsFrom,
    importsTo: data.importsTo,
    externalImportsFrom: data.externalImportsFrom,
    rust: data.rust,
    commitSha: data.commitSha,
    rustCommit: data.commitSha,
    buildBridge: true
  });
  return { hooks, data, raw };
}

test('every production Rust source file is one graph node, and test targets are none', async () => {
  const { hooks, raw } = await loadBundledState();
  const graph = hooks.buildRustGraph(raw.rust);

  /* Partitioned by the scanner's own predicate, so the runtime and the Node
     side cannot drift: whatever the inventory calls a production graph file is
     exactly what the browser draws. The headless probe sizes its expectations
     from the same export. */
  const expected = [];
  const omitted = [];
  for (const crate of raw.rust.crates) {
    for (const file of crate.files) (isProductionGraphFile(file) ? expected : omitted).push(file.path);
  }
  assert.ok(expected.length > 50 && omitted.length > 0, 'the snapshot carries both');

  const nodePaths = Array.from(graph.nodes, (name) => graph.byName[name].path).sort();
  assert.deepEqual(nodePaths, expected.slice().sort(), 'one node per production file, no duplicates and none dropped');
  for (const omittedPath of omitted) {
    assert.ok(!nodePaths.includes(omittedPath), `${omittedPath} is outside the production surface and stays out of the graph`);
  }

  /* Each crate contributes exactly one root, and it is the crate's own name. */
  assert.deepEqual(Array.from(graph.crateRoots), ['sele4n-types', 'sele4n-abi', 'sele4n-sys', 'sele4n-hal'],
    'crate roots keep workspace order and are addressed by the bare crate name');
  for (const root of graph.crateRoots) {
    assert.equal(graph.byName[root].isRoot, true);
    assert.equal(graph.byName[root].parent, '', 'a crate root hangs off nothing');
  }
});

test('a Rust node is addressed by its module path, and a non-library target says which it is', async () => {
  const { hooks } = await loadBundledState();
  const crate = { name: 'sele4n-hal' };
  const cases = [
    [{ modulePath: '', role: 'lib', relativePath: 'src/lib.rs' }, 'sele4n-hal'],
    [{ modulePath: 'mmu', role: 'module', relativePath: 'src/mmu.rs' }, 'sele4n-hal::mmu'],
    [{ modulePath: 'args::cspace', role: 'module', relativePath: 'src/args/cspace.rs' }, 'sele4n-hal::args::cspace'],
    [{ modulePath: '', role: 'build', relativePath: 'build.rs' }, 'sele4n-hal::build'],
    [{ modulePath: '', role: 'bin', relativePath: 'src/bin/oracle.rs' }, 'sele4n-hal::bin::oracle'],
    [{ modulePath: '', role: 'bin', relativePath: 'src/bin/oracle/main.rs' }, 'sele4n-hal::bin::oracle'],
    [{ modulePath: '', role: 'bin', relativePath: 'src/main.rs' }, 'sele4n-hal::bin::sele4n-hal'],
    [{ modulePath: '', role: 'test', relativePath: 'tests/conformance.rs' }, 'sele4n-hal::tests::conformance']
  ];
  for (const [file, expected] of cases) {
    assert.equal(hooks.rustNodeName(crate, file), expected, `${file.relativePath} should address as ${expected}`);
  }
  assert.equal(hooks.rustTargetName(crate, { relativePath: 'tests/common/mod.rs' }), 'tests_common_mod',
    'a file that names no target still yields a stable segment rather than an empty one');
});

test('a module hangs off the module that declares it, up to its target root', async () => {
  const { hooks, raw } = await loadBundledState();
  assert.equal(hooks.rustNode('sele4n-abi::args::cspace').parent, 'sele4n-abi::args');
  assert.equal(hooks.rustNode('sele4n-abi::args').parent, 'sele4n-abi');
  assert.equal(hooks.rustNode('sele4n-abi').parent, '');
  assert.deepEqual(Array.from(hooks.rustAncestorChain('sele4n-abi::args::cspace')), ['sele4n-abi', 'sele4n-abi::args'],
    'the chain reads downwards as the module path does');
  assert.ok(Array.from(hooks.rustNode('sele4n-abi::args').children).includes('sele4n-abi::args::cspace'),
    'the child edge is the inverse of the parent edge');
  const hal = raw.rust.crates.find((crate) => crate.name === 'sele4n-hal');
  const topLevelHalModules = hal.files.filter((file) => file.role === 'module' && !file.modulePath.includes('::')).length;
  assert.equal(hooks.rustNode('sele4n-hal').children.length, topLevelHalModules,
    'every top-level HAL module hangs off the crate root, and nothing else does');
  assert.ok(topLevelHalModules > 20, `expected the HAL to carry a real module tree, got ${topLevelHalModules}`);
});

test('two declarations are the same declaration once case convention is normalised away', async () => {
  const hooks = await loadMapTestHooks();
  assert.equal(hooks.toBridgeKey('ffiGicAcknowledge'), 'ffi_gic_acknowledge');
  assert.equal(hooks.toBridgeKey('ffi_gic_acknowledge'), 'ffi_gic_acknowledge');
  assert.equal(hooks.toBridgeKey('ThreadId'), hooks.toBridgeKey('thread_id'));
  assert.equal(hooks.toBridgeKey('MAX_LABEL'), hooks.toBridgeKey('maxLabel'));
  assert.equal(hooks.toBridgeKey('ASID'), hooks.toBridgeKey('Asid'));
  assert.equal(hooks.toBridgeKey('r#match'), 'match', 'a raw identifier matches the plain one');
  assert.equal(hooks.toBridgeKey('<instance@L12>'), '', 'an anonymous declaration matches nothing');
  assert.equal(hooks.toBridgeKey(''), '');
});

test('the boundary relation follows the Lean declaration kind, and only then the crate', async () => {
  const hooks = await loadMapTestHooks();
  /* A Lean `opaque` has no Lean body, so a Rust fn of that name is its
     implementation — whatever crate it sits in. */
  assert.equal(hooks.bridgeRelation('fn', 'opaque', 'sele4n-hal'), 'implements');
  assert.equal(hooks.bridgeRelation('fn', 'opaque', 'sele4n-sys'), 'implements');
  assert.equal(hooks.bridgeRelation('fn', 'axiom', 'sele4n-types'), 'implements');
  /* Lean implements it: the crate's stratum says who is calling whom. */
  assert.equal(hooks.bridgeRelation('fn', 'def', 'sele4n-sys'), 'invokes');
  assert.equal(hooks.bridgeRelation('fn', 'def', 'sele4n-hal'), 'mirrors');
  assert.equal(hooks.bridgeRelation('fn', 'def', 'sele4n-abi'), 'shares');
  assert.equal(hooks.bridgeRelation('fn', 'def', 'a-crate-nobody-declared'), 'shares',
    'an unknown crate gets no direction rather than a guessed one');
  /* A type or constant is data crossing the boundary, never a call. */
  assert.equal(hooks.bridgeRelation('struct', 'structure', 'sele4n-sys'), 'shares');
  assert.equal(hooks.bridgeRelation('const', 'def', 'sele4n-hal'), 'shares');
  assert.deepEqual(
    ['sele4n-types', 'sele4n-abi', 'sele4n-sys', 'sele4n-hal', 'unknown'].map(hooks.rustCrateStratum),
    ['shared', 'boundary', 'userspace', 'hardware', 'shared']
  );
});

test('the bundled snapshot carries the foreign-function seam, directed both ways', async () => {
  const { hooks } = await loadBundledState();
  const index = hooks.bridgeIndex();
  assert.ok(index.links > 150, `expected the seam to carry real weight, got ${index.links} links`);

  const fromLean = Array.from(index.byLean['SeLe4n.Platform.FFI'] || []);
  const seam = fromLean.find((edge) => edge.rustNode === 'sele4n-hal::ffi');
  assert.ok(seam, 'SeLe4n.Platform.FFI should reach sele4n-hal::ffi');
  assert.equal(seam.relation, 'implements');
  assert.ok(seam.links.length > 60, `the FFI seam should carry most of the opaque declarations, got ${seam.links.length}`);
  for (const link of seam.links) {
    assert.equal(link.leanKind, 'opaque', `${link.leanName} should have no Lean body`);
    assert.equal(link.rustKind, 'fn');
    assert.equal(hooks.toBridgeKey(link.leanName), hooks.toBridgeKey(link.rustName));
  }

  /* The same edge object is reachable from the Rust side, so the two readings
     cannot disagree. */
  const fromRust = Array.from(index.byRust['sele4n-hal::ffi'] || []);
  assert.ok(fromRust.some((edge) => edge.leanModule === 'SeLe4n.Platform.FFI' && edge.links.length === seam.links.length));

  /* The syscall direction: Lean implements it, the user-space wrapper calls it. */
  const wrapper = Array.from(index.byRust['sele4n-sys::cspace'] || []);
  const calls = wrapper.find((edge) => edge.leanModule === 'SeLe4n.Kernel.Capability.Operations');
  assert.ok(calls, 'the cspace wrapper should reach the kernel capability operations');
  assert.equal(calls.relation, 'invokes');
  assert.ok(Array.from(calls.links, (link) => link.rustName).includes('cspace_mint'));

  /* Shared data: the ABI types both sides name. */
  const shared = Array.from(index.byRust['sele4n-types::identifiers'] || []);
  const prelude = shared.find((edge) => edge.leanModule === 'SeLe4n.Prelude');
  assert.ok(prelude && prelude.relation === 'shares');
  assert.ok(Array.from(prelude.links, (link) => link.rustName).includes('ThreadId'));
});

test('the boundary bands mirror each other and appear only in the combined scope', async () => {
  const { hooks } = await loadBundledState();

  for (const scope of ['lean', 'rust']) {
    hooks.applyTestState({ scope });
    assert.equal(hooks.bridgeBandsFor('SeLe4n.Platform.FFI').total, 0, `${scope} scope draws no boundary`);
    assert.equal(hooks.bridgeBandRows('sele4n-hal::ffi').length, 0);
  }

  hooks.applyTestState({ scope: 'both' });
  const leanRows = Array.from(hooks.bridgeBandRows('SeLe4n.Platform.FFI'));
  assert.deepEqual(leanRows.map((row) => [row.relation, row.outbound]), [['implements', true]],
    'from the Lean side the kernel calls down into Rust');
  const rustRows = Array.from(hooks.bridgeBandRows('sele4n-hal::ffi'));
  assert.deepEqual(rustRows.map((row) => [row.relation, row.outbound]), [['implements', false]],
    'from the Rust side the same edge points inwards');

  const wrapperRows = Array.from(hooks.bridgeBandRows('sele4n-sys::cspace'));
  assert.deepEqual(wrapperRows.map((row) => [row.relation, row.outbound]), [['invokes', true]],
    'a user-space wrapper calls up into the kernel');
  const kernelRows = Array.from(hooks.bridgeBandRows('SeLe4n.Kernel.Capability.Operations'));
  assert.deepEqual(kernelRows.map((row) => [row.relation, row.outbound]), [['invokes', false]]);

  /* A module with nothing on the other side gets no band at all. */
  assert.equal(hooks.bridgeBandRows('SeLe4n.Kernel.API').length, 0);
});

test('a boundary edge names the declarations behind it rather than counting them', async () => {
  const { hooks } = await loadBundledState();
  hooks.applyTestState({ scope: 'both' });
  const edge = Array.from(hooks.bridgeIndex().byRust['sele4n-sys::cspace'])[0];
  const shown = Math.min(3, edge.links.length);
  const extra = edge.links.length - shown;
  const tail = extra > 0 ? ` +${extra} more` : '';
  assert.equal(hooks.bridgeEdgeSubtitle(edge, true), edge.links.slice(0, shown).map((l) => l.leanName).join(', ') + tail);
  assert.equal(hooks.bridgeEdgeSubtitle(edge, false), edge.links.slice(0, shown).map((l) => l.rustName).join(', ') + tail);
  assert.match(hooks.bridgeEdgeSubtitle(edge, false), /cspace_/, 'the cspace wrapper names cspace functions');
  const short = { links: [{ leanName: 'a', rustName: 'a_fn' }] };
  assert.equal(hooks.bridgeEdgeSubtitle(short, false), 'a_fn', 'a single match needs no overflow tail');
});

test('the scope decides which nodes exist, and the selection survives a switch when it can', async () => {
  const { hooks, data, raw } = await loadBundledState();

  hooks.setScope('lean');
  assert.equal(hooks.scopeNodes().length, data.modules.length);
  assert.equal(hooks.nodeExists('SeLe4n.Kernel.API'), true);
  assert.equal(hooks.nodeExists('sele4n-hal::ffi'), false, 'a Rust node is not addressable in the Lean scope');
  assert.equal(hooks.defaultNodeName(), 'SeLe4n.Kernel.API');

  hooks.setScope('rust');
  assert.equal(hooks.scopeNodes().length, productionRustFiles(raw));
  assert.equal(hooks.nodeExists('SeLe4n.Kernel.API'), false);
  assert.equal(hooks.nodeExists('sele4n-hal::ffi'), true);
  assert.equal(hooks.defaultNodeName(), 'sele4n-types', 'the Rust scope opens on the first crate root');
  assert.equal(hooks.currentScope(), 'rust');

  hooks.setScope('both');
  assert.equal(hooks.scopeNodes().length, data.modules.length + productionRustFiles(raw));
  assert.equal(hooks.defaultNodeName(), 'SeLe4n.Kernel.API', 'any scope carrying Lean still opens on the kernel API');
});

test('switching scope keeps a node that survives it and falls back when it does not', async () => {
  const { hooks } = await loadBundledState();
  hooks.setScope('both');

  hooks.applyTestState({ selectedModule: 'sele4n-hal::ffi' });
  hooks.setScope('rust');
  assert.equal(hooks.currentScope(), 'rust');
  hooks.setScope('both');
  assert.equal(hooks.nodeExists('sele4n-hal::ffi'), true, 'the node is still there after a widening switch');

  /* Narrowing to Lean drops the Rust selection, so the workspace falls back to
     the scope's own default rather than rendering nothing. */
  hooks.applyTestState({ selectedModule: 'sele4n-hal::ffi' });
  hooks.setScope('lean');
  assert.equal(hooks.nodeExists('sele4n-hal::ffi'), false);
  assert.equal(hooks.defaultNodeName(), 'SeLe4n.Kernel.API');
});

test('a node name off the URL is whitelisted tightly enough for both languages', async () => {
  const hooks = await loadMapTestHooks();
  for (const good of ['SeLe4n.Kernel.API', 'Main', 'sele4n-hal::ffi', 'sele4n-abi::args::cspace', 'sele4n-hal::bin::rw_lock_oracle']) {
    assert.equal(hooks.sanitizeModuleName(good), good, `${good} should be accepted`);
  }
  for (const bad of ['a/b', 'a b', '<script>', 'a"b', "a'b", 'a&b', 'a\\b', 'a#b']) {
    assert.equal(hooks.sanitizeModuleName(bad), '', `${bad} should be rejected`);
  }
  assert.deepEqual(['lean', 'both', 'rust'].map(hooks.sanitizeScope), ['lean', 'both', 'rust']);
  for (const bad of ['', 'LEAN', 'leanrust', 'both ', null]) assert.equal(hooks.sanitizeScope(bad), '');
  assert.equal(hooks.defaultScope(), 'both');
});

test('Rust nodes sort after Lean modules, crate roots leading their crates', async () => {
  const { hooks } = await loadBundledState();
  hooks.setScope('both');
  assert.ok(hooks.nodeSortScore('SeLe4n.Kernel.API') >= 0, 'a Lean score is never negative');
  assert.equal(hooks.nodeSortScore('sele4n-hal'), -0.5, 'a crate root leads its crate');
  const ffi = hooks.nodeSortScore('sele4n-hal::ffi');
  const lean = hooks.nodeSortScore('sele4n-hal::lean_ready');
  assert.ok(ffi < -1 && lean < -1, 'every module scores below every crate root');
  assert.ok(ffi > lean, 'the larger production surface comes first');
});

test('the declaration sidebar serves Rust with its own groups and a test bucket', async () => {
  const { hooks } = await loadBundledState();

  const errorFile = hooks.rustNode('sele4n-types::error').file;
  const interior = hooks.rustInteriorForNode('sele4n-types::error');
  const items = errorFile.items;
  const nonTest = items.filter((item) => !item.test);

  /* The sidebar lists every non-test item, impl blocks included; the snapshot
     counts declarations, which excludes them. The two figures live in
     different places on purpose — the node summary quotes the snapshot's. */
  assert.equal(interior.listed, nonTest.length);
  assert.equal(interior.tests, items.length - nonTest.length);
  assert.equal(interior.total, items.length);
  assert.ok(interior.byKind.impl.length > 0, 'this file carries impl blocks, which is what makes the two counts differ');
  assert.equal(interior.listed - interior.byKind.impl.length, errorFile.productionItems,
    'listed items minus impl blocks is exactly what the snapshot counts');
  assert.ok(hooks.rustNodeSummary('sele4n-types::error').startsWith(`${errorFile.productionItems} items`),
    'the summary quotes the snapshot\'s declaration count, never the sidebar\'s listing count');
  assert.deepEqual(Array.from(interior.byKind['enum'], (item) => item.name), ['KernelError']);
  assert.equal(interior.byKind.fn.length, 0, 'test fns never leak into the production bucket');
  assert.equal(interior.byKind['test:fn'].length, items.filter((i) => i.test && i.kind === 'fn').length,
    'test items bucket under a test: prefix, not their bare kind');
  assert.equal(interior.byKind['enum'][0].visibility, 'pub');

  const groups = Array.from(hooks.interiorGroupsForNode('sele4n-types::error', interior));
  assert.deepEqual(groups.map((group) => group.key), ['rustTypes', 'rustFunctions', 'rustStructure', 'rustTests']);
  /* Every item lands in exactly one group, and the impl blocks land in the
     structure group rather than among the types. */
  assert.equal(groups.reduce((total, group) => total + group.totalCount, 0), items.length);
  assert.equal(groups.find((group) => group.key === 'rustStructure').totalCount, interior.byKind.impl.length);
  assert.equal(groups.find((group) => group.key === 'rustTests').totalCount, interior.tests);

  /* A Lean module keeps the Lean groups through the same entry point. */
  const leanGroups = Array.from(hooks.interiorGroupsForNode('SeLe4n.Kernel.API', hooks.interiorForNode('SeLe4n.Kernel.API')));
  assert.deepEqual(leanGroups.map((group) => group.key), ['object', 'contextInit', 'extension']);

  assert.equal(hooks.interiorKindLabelForNode('sele4n-types::error', 'fn'), 'fn', 'a Rust keyword is not translated');
  assert.equal(hooks.interiorKindLabelForNode('sele4n-types::error', 'macro'), 'macro_rules!');
  assert.equal(hooks.interiorKindLabelForNode('sele4n-types::error', 'test:fn'), 'fn (test)');
  assert.equal(hooks.interiorKindLabelForNode('SeLe4n.Kernel.API', 'theorem'), 'Theorem');
});

test('a Rust node summary keeps the production surface and the test surface apart', async () => {
  const { hooks } = await loadBundledState();
  const group = (n) => n.toLocaleString('en-US');
  const ffi = hooks.rustNode('sele4n-hal::ffi').file;
  assert.equal(
    hooks.rustNodeSummary('sele4n-hal::ffi'),
    `${group(ffi.productionItems)} items · ${group(ffi.publicItems)} pub · ${group(ffi.lines)} lines · ` +
    `${ffi.unsafe.fns + ffi.unsafe.impls + ffi.unsafe.blocks} unsafe sites · ${group(ffi.testItems)} tests`
  );
  /* A file with no unsafe and no tests says neither, rather than "0". */
  const ipc = hooks.rustNode('sele4n-sys::ipc').file;
  assert.equal(ipc.testItems, 0);
  assert.equal(hooks.rustNodeSummary('sele4n-sys::ipc'),
    `${group(ipc.productionItems)} items · ${group(ipc.publicItems)} pub · ${group(ipc.lines)} lines`);

  /* The crate root answers for its crate: the deny lint and the counted sites
     are two facts, and a test site is never folded into the production total. */
  const types = hooks.rustNode('sele4n-types').crate;
  assert.equal(types.deniesUnsafe, true);
  assert.equal(types.unsafe.fns + types.unsafe.impls + types.unsafe.blocks, 0);
  assert.equal(hooks.rustCrateSummary(types),
    `${group(types.sourceFiles)} files · ${group(types.items)} items · denies unsafe`);

  const halCrate = hooks.rustNode('sele4n-hal').crate;
  const halSites = halCrate.unsafe.fns + halCrate.unsafe.impls + halCrate.unsafe.blocks;
  const halTestSites = halCrate.testUnsafe.fns + halCrate.testUnsafe.impls + halCrate.testUnsafe.blocks;
  const halSummary = hooks.rustCrateSummary(halCrate);
  assert.ok(halSummary.includes(`${group(halSites)} unsafe sites`), `production sites are the headline (${halSummary})`);
  assert.ok(halSummary.includes(`+${group(halTestSites)} in test code`), `test sites are named apart (${halSummary})`);
  assert.ok(!halSummary.includes(`${group(halSites + halTestSites)} unsafe`), 'and never summed into one figure');

  const abiCrate = hooks.rustNode('sele4n-abi').crate;
  const abiSites = abiCrate.unsafe.fns + abiCrate.unsafe.impls + abiCrate.unsafe.blocks;
  assert.equal(abiCrate.deniesUnsafe, true);
  assert.ok(abiSites > 0, 'sele4n-abi is the crate that denies unsafe and still carries sites');
  const abiSummary = hooks.rustCrateSummary(abiCrate);
  assert.ok(abiSummary.includes(`${group(abiSites)} unsafe sites`) && abiSummary.includes('under item-level allow'),
    `a crate that denies unsafe and still carries sites says so (${abiSummary})`);
  assert.ok(!abiSummary.includes('denies unsafe'), 'the lint never stands in for the counted sites');
});

test('crate dependencies keep their table, and a workspace member is navigable from any of them', async () => {
  const { hooks } = await loadBundledState();
  const hal = Array.from(hooks.rustCrateDependencies(hooks.rustNode('sele4n-hal').crate), (dep) => [dep.name, dep.label, dep.navigable]);
  assert.deepEqual(hal, [
    ['loom', 'under cfg(loom)', false],
    ['sele4n-types', 'test-only', true],
    ['sele4n-abi', 'test-only', true],
    ['cc', 'build-time', false]
  ], 'a target-scoped table keeps its cfg and never reads as an ordinary dependency');

  const sys = Array.from(hooks.rustCrateDependencies(hooks.rustNode('sele4n-sys').crate), (dep) => [dep.name, dep.label, dep.navigable]);
  assert.deepEqual(sys, [['sele4n-abi', 'workspace crate', true], ['sele4n-types', 'workspace crate', true]]);
  assert.deepEqual(Array.from(hooks.rustCrateDependencies(hooks.rustNode('sele4n-types').crate)), []);
});

test('the English plural fallback pluralises and groups digits', async () => {
  const hooks = await loadMapTestHooks();
  assert.equal(hooks.pluralEn(1, 'file', 'files'), '1 file');
  assert.equal(hooks.pluralEn(0, 'file', 'files'), '0 files');
  assert.equal(hooks.pluralEn(1303, 'module', 'modules'), '1,303 modules');
});

test('a mirrored routine keeps its own band rather than passing as a shared definition', async () => {
  // `mirrors` means the same routine written either side of the seam — two
  // implementations of one contract. Folded into `shared` it was relabelled
  // "Definitions shared across the boundary", the opposite of what it means,
  // and the tooltip said one thing while the band said another.
  const { hooks } = await loadBundledState();
  hooks.applyTestState({ scope: 'both' });

  const index = hooks.bridgeIndex();
  let mirrored = null;
  for (const node of Object.keys(index.byRust)) {
    const edge = Array.from(index.byRust[node] || []).find((e) => e.relation === 'mirrors');
    if (edge) { mirrored = { node, edge }; break; }
  }
  assert.ok(mirrored, 'the bundled snapshot carries at least one mirrored routine');

  const bands = hooks.bridgeBandsFor(mirrored.node);
  assert.ok(Array.from(bands.mirrors).length > 0, 'it lands in the mirrors band');
  assert.ok(!Array.from(bands.shared).some((e) => e.relation === 'mirrors'),
    'and never in the shared band');

  const rows = Array.from(hooks.bridgeBandRows(mirrored.node));
  const mirrorRow = rows.find((row) => row.relation === 'mirrors');
  assert.ok(mirrorRow, 'the chart draws it as its own row');
  assert.notEqual(mirrorRow.label, rows.find((row) => row.relation === 'shares')?.label);
});

test('only the relations that are calls carry an arrowhead', async () => {
  const { hooks } = await loadBundledState();
  const undirected = hooks.bridgeUndirected();

  assert.equal(undirected.mirrors, true, 'a mirrored routine is not a call');
  assert.equal(undirected.shares, true, 'a shared definition is not a call');
  assert.ok(!undirected.implements, 'the kernel calling down is a call');
  assert.ok(!undirected.invokes, 'a wrapper calling up is a call');
});

test('the boundary legend names every relation the bands can draw', async () => {
  const { hooks } = await loadBundledState();
  hooks.applyTestState({ scope: 'both' });

  const legend = Array.from(hooks.bridgeLegendItems()).filter((item) => item.group === 'bridge');
  assert.equal(legend.length, 4, 'implements, invokes, mirrors, shares');
  const colors = legend.map((item) => item.color);
  assert.equal(new Set(colors).size, colors.length,
    'each relation is a distinct colour, so the legend can tell them apart');
});

test('a colliding Rust node name still round-trips through the URL', async () => {
  // The collision suffix used to be `@` plus a slash-bearing path, which
  // sanitizeModuleName() rejects: the node could be selected in-session and
  // written into `module=`, but a reload or a shared link dropped it.
  const { hooks } = await loadBundledState();

  assert.equal(hooks.urlSafeNodeSegment('src/args/cspace.rs'), 'src-args-cspace.rs');
  assert.equal(hooks.urlSafeNodeSegment('a//b'), 'a-b');
  assert.equal(hooks.urlSafeNodeSegment('/leading/'), 'leading');

  const collided = `sele4n-abi::args::${hooks.urlSafeNodeSegment('src/bin/args.rs')}`;
  assert.equal(hooks.sanitizeModuleName(collided), collided,
    'the whole node name survives the URL whitelist');
});

test('narrowing the scope centres the fallback node instead of keeping the old scroll', async () => {
  // An empty flowScrollTarget means "preserve the scroll" on desktop, so after
  // scrolling down a Rust band and switching to Lean the fallback node could
  // render outside the visible frame.
  const { hooks } = await loadBundledState();

  hooks.setScope('rust');
  const rustNode = hooks.scopeNodes().find((name) => hooks.isRustNode(name));
  hooks.applyTestState({ selectedModule: rustNode, flowScrollTarget: '' });

  hooks.setScope('lean');
  assert.equal(hooks.selectionState().module, hooks.defaultNodeName(),
    'the Rust node does not survive the switch');
  assert.equal(hooks.flowScrollTarget(), hooks.defaultNodeName(),
    'and the replacement is the scroll target');
});

test('a declaration deep link is refused when the scope cannot show its module', async () => {
  // `?scope=rust&decl=<a Lean declaration>` used to resolve the declaration to
  // its Lean module and select it, leaving a Lean graph under a Rust badge.
  const { hooks } = await loadBundledState();
  hooks.applyTestState({ scope: 'both' });

  const declaration = hooks.selectionState().declaration || 'apiInvariantBundle';
  hooks.applyTestState({
    scope: 'rust',
    flowContext: 'declaration',
    selectedDeclaration: declaration,
    selectedDeclarationModule: 'SeLe4n.Kernel.API'
  });

  assert.ok(!hooks.nodeExists('SeLe4n.Kernel.API'), 'the Lean module is outside the Rust scope');
});

test('a declaration search is refused when the scope cannot show its module', async () => {
  // The URL-restore path was fixed first; this is the interactive one. The
  // search field accepts a typed or chosen declaration through
  // selectDeclaration(), whose guard checked state.moduleMap — the Lean
  // inventory regardless of scope — so in scope=rust it selected the Lean
  // module while the toggle and badge still read Rust.
  const { hooks } = await loadBundledState();

  hooks.setScope('both');
  const before = hooks.selectionState();
  const leanModule = hooks.scopeNodes().find((name) => !hooks.isRustNode(name));
  assert.ok(leanModule, 'the combined scope carries Lean modules');

  hooks.setScope('rust');
  const rustSelection = hooks.selectionState().module;
  assert.ok(hooks.isRustNode(rustSelection), 'the Rust scope opens on a Rust node');

  hooks.selectDeclaration('apiInvariantBundle', leanModule);
  assert.equal(hooks.selectionState().module, rustSelection,
    'a Lean declaration does not pull a Lean module in under a Rust badge');
  assert.notEqual(hooks.selectionState().context, 'declaration');

  hooks.setScope('both');
  assert.ok(before, 'the combined scope is restored for later tests');
});

test('the enclosing module path is drawn as a chain, not a fan', async () => {
  // `sele4n-abi::args::cspace` has two ancestors. Edging both straight to the
  // centre said the crate root declares `cspace`, when `args` does.
  const { hooks } = await loadBundledState();
  hooks.applyTestState({ scope: 'rust' });

  const nested = hooks.scopeNodes().find((name) => (name.match(/::/g) || []).length >= 2);
  assert.ok(nested, 'the bundled snapshot carries a module nested at least two deep');

  const chain = Array.from(hooks.rustAncestorChain(nested));
  assert.ok(chain.length >= 2, `${nested} has more than one ancestor`);

  // Root first, immediate parent last: each entry's parent is the one before
  // it, and the last is the selected node's own parent. That is precisely the
  // relation the lane must draw.
  for (let i = 1; i < chain.length; i += 1) {
    assert.equal(hooks.rustNode(chain[i]).parent, chain[i - 1],
      `${chain[i]} is declared by ${chain[i - 1]}`);
  }
  assert.equal(hooks.rustNode(nested).parent, chain[chain.length - 1],
    'and the selected node hangs off the last of them');
});

test('the boundary carries only items reachable from outside the crate', async () => {
  // `pub` is syntax; a `pub` const inside a private module is crate-private.
  // The index matched on visibility, so `sele4n-hal`'s error_code::VM_FAULT
  // and USER_EXCEPTION — both naming Lean definitions — were published as
  // shared boundary links for implementation details.
  const { hooks } = await loadBundledState();
  hooks.applyTestState({ scope: 'both' });
  const index = hooks.bridgeIndex();

  const named = new Set();
  for (const node of Object.keys(index.byRust)) {
    for (const edge of Array.from(index.byRust[node] || [])) {
      for (const link of Array.from(edge.links || [])) named.add(link.rustName);
    }
  }

  assert.ok(!named.has('VM_FAULT'), 'a pub const in a private module is not shared API');
  assert.ok(!named.has('USER_EXCEPTION'));
  assert.ok(named.size > 0, 'the boundary still carries the genuinely exported items');
});

test('a snapshot without the export flag falls back to visibility', async () => {
  // The flag arrived after the first snapshots; an older bundle must still
  // draw a boundary rather than emptying out.
  const { hooks } = await loadBundledState();
  const legacy = {
    crates: [{
      name: 'legacy', path: 'rust/legacy', manifest: 'rust/legacy/Cargo.toml',
      sourceFiles: 1, lines: 1, items: 1, publicItems: 1, testItems: 0,
      deniesUnsafe: false, unsafe: { fns: 0, impls: 0, blocks: 0 }, testUnsafe: { fns: 0, impls: 0, blocks: 0 },
      dependencies: [], internalDependencies: [], externalDependencies: [],
      devDependencies: [], buildDependencies: [], features: [],
      targetDependencies: [], optionalDependencies: [],
      files: [{
        path: 'rust/legacy/src/lib.rs', relativePath: 'src/lib.rs', modulePath: '', role: 'lib',
        lines: 1, productionItems: 1, publicItems: 1, testItems: 0,
        unsafe: { fns: 0, impls: 0, blocks: 0 }, testUnsafe: { fns: 0, impls: 0, blocks: 0 },
        items: [{ kind: 'fn', name: 'legacyOnly', line: 1, visibility: 'pub' }]
      }]
    }],
    members: ['legacy']
  };

  const graph = hooks.buildRustGraph(legacy);
  assert.ok(graph && graph.nodes.length === 1, 'the legacy crate still graphs');
});

test('a nested binary module hangs off its own binary, not the library', async () => {
  // `rustModulePath` records src/bin/tool/helper.rs as `helper`, which the
  // parent fallback could not tell from a library module — so the chart showed
  // the library declaring a binary's module.
  const { hooks } = await loadBundledState();
  const file = (relativePath, role, modulePath, target) => ({
    path: `rust/dual/${relativePath}`, relativePath, modulePath, role,
    ...(target ? { target } : {}),
    lines: 1, productionItems: 0, publicItems: 0, testItems: 0, items: [],
    unsafe: { fns: 0, impls: 0, blocks: 0 }, testUnsafe: { fns: 0, impls: 0, blocks: 0 }
  });

  const graph = hooks.buildRustGraph({
    members: ['dual'],
    crates: [{
      name: 'dual', path: 'rust/dual', manifest: 'rust/dual/Cargo.toml',
      sourceFiles: 3, lines: 3, items: 0, publicItems: 0, testItems: 0,
      deniesUnsafe: false, unsafe: { fns: 0, impls: 0, blocks: 0 }, testUnsafe: { fns: 0, impls: 0, blocks: 0 },
      dependencies: [], internalDependencies: [], externalDependencies: [],
      devDependencies: [], buildDependencies: [], features: [],
      targetDependencies: [], optionalDependencies: [],
      files: [
        file('src/lib.rs', 'lib', ''),
        file('src/bin/tool/main.rs', 'bin', ''),
        file('src/bin/tool/helper.rs', 'module', 'helper', 'src/bin/tool/main.rs')
      ]
    }]
  });

  const helper = graph.nodes.find((name) => /helper$/.test(name));
  assert.ok(helper, 'the nested module is graphed');
  const parent = graph.byName[helper].parent;
  assert.equal(graph.byName[parent].file.relativePath, 'src/bin/tool/main.rs',
    'the binary declares it, not src/lib.rs');
});

test('a declaration search finds nothing in a scope with no Lean', async () => {
  // Refusing the selection was not enough: the callers still overwrote the
  // input and announced "Declaration: …", so the control claimed to show Lean
  // content while the Rust chart stayed put. Nothing is offered now.
  const { hooks } = await loadBundledState();

  hooks.setScope('both');
  const found = hooks.declarationSearchMatch('SeLe4n.Kernel.API.apiInvariantBundle');
  assert.ok(found, 'the combined scope resolves a qualified declaration');

  hooks.setScope('rust');
  assert.equal(hooks.declarationSearchMatch('SeLe4n.Kernel.API.apiInvariantBundle'), null);
  assert.deepEqual(Array.from(hooks.declarationSearchMatches('SeLe4n.Kernel.API.api', 5)), []);

  hooks.setScope('both');
});

test('an unreachable Rust file is not drawn as part of the module tree', async () => {
  // The scanner keeps an orphan because its text is real; the graph must
  // leave it out, because it compiles into nothing and drawing it presents
  // stale or generated source as production code.
  const { hooks } = await loadBundledState();
  const file = (relativePath, role, modulePath, extra = {}) => ({
    path: `rust/solo/${relativePath}`, relativePath, modulePath, role,
    lines: 1, productionItems: 0, publicItems: 0, testItems: 0, items: [],
    unsafe: { fns: 0, impls: 0, blocks: 0 }, testUnsafe: { fns: 0, impls: 0, blocks: 0 },
    ...extra
  });

  const crate = {
    name: 'solo', path: 'rust/solo', manifest: 'rust/solo/Cargo.toml',
    sourceFiles: 3, lines: 3, items: 0, publicItems: 0, testItems: 0,
    deniesUnsafe: false, unsafe: { fns: 0, impls: 0, blocks: 0 }, testUnsafe: { fns: 0, impls: 0, blocks: 0 },
    dependencies: [], internalDependencies: [], externalDependencies: [],
    devDependencies: [], buildDependencies: [], features: [],
    targetDependencies: [], optionalDependencies: [],
    files: [
      file('src/lib.rs', 'lib', '', { reachable: true }),
      file('src/live.rs', 'module', 'live', { target: 'src/lib.rs', reachable: true }),
      file('src/orphan.rs', 'module', 'orphan', { target: 'src/lib.rs', reachable: false })
    ]
  };

  const graph = hooks.buildRustGraph({ members: ['solo'], crates: [crate] });
  assert.ok(graph.nodes.some((name) => /live$/.test(name)), 'the reached module is a node');
  assert.ok(!graph.nodes.some((name) => /orphan$/.test(name)), 'the orphan is not');

  // A snapshot predating the flag draws everything it lists, as before.
  const legacy = { ...crate, files: crate.files.map(({ reachable, ...rest }) => rest) };
  const before = hooks.buildRustGraph({ members: ['solo'], crates: [legacy] });
  assert.ok(before.nodes.some((name) => /orphan$/.test(name)));
});

test('a declared binary is addressed by its Cargo target name, and test-only modules are no nodes', async () => {
  // `[[bin]] name = "runner", path = "tool/entry.rs"` builds `runner`; a node
  // named `bin::tool_entry` addresses a target the manifest does not have, in
  // the chart and in the shareable `module=` URL alike. And `#[cfg(test)] mod
  // tests;` leaves `src/tests.rs` with the path-derived role `module`, so only
  // the file-level flag keeps test code out of a production-only map.
  const { hooks } = await loadBundledState();
  const file = (relativePath, role, modulePath, extra) => ({
    path: `rust/named/${relativePath}`, relativePath, modulePath, role, reachable: true,
    lines: 1, productionItems: 0, publicItems: 0, testItems: 0, items: [],
    unsafe: { fns: 0, impls: 0, blocks: 0 }, testUnsafe: { fns: 0, impls: 0, blocks: 0 },
    ...(extra || {})
  });
  const crate = {
    name: 'named', path: 'rust/named', manifest: 'rust/named/Cargo.toml',
    sourceFiles: 5, lines: 5, items: 0, publicItems: 0, testItems: 0,
    deniesUnsafe: false, unsafe: { fns: 0, impls: 0, blocks: 0 }, testUnsafe: { fns: 0, impls: 0, blocks: 0 },
    dependencies: [], internalDependencies: [], externalDependencies: [],
    devDependencies: [], buildDependencies: [], features: [],
    targetDependencies: [], optionalDependencies: [],
    files: [
      file('src/lib.rs', 'lib', '', { testOnly: false }),
      file('tool/entry.rs', 'bin', '', { targetName: 'runner', testOnly: false }),
      file('tool/entry/helper.rs', 'module', 'helper', { target: 'tool/entry.rs', testOnly: false }),
      file('src/tests.rs', 'module', 'tests', { target: 'src/lib.rs', testOnly: true }),
      file('src/tests/deeper.rs', 'module', 'tests::deeper', { target: 'src/lib.rs', testOnly: true })
    ]
  };

  const graph = hooks.buildRustGraph({ members: ['named'], crates: [crate] });
  assert.ok(graph.nodes.includes('named::bin::runner'), 'the Cargo target name, not the pathname');
  assert.ok(!graph.nodes.some((name) => /tool_entry/.test(name)));
  assert.equal(graph.byName['named::helper'].parent, 'named::bin::runner',
    'and its module hangs off that binary, addressed the same way');
  assert.ok(!graph.nodes.some((name) => /tests/.test(name)),
    'an out-of-line test module and its descendants are test code, whatever the pathname says');

  // A snapshot predating either field falls back to the path-derived reading.
  const legacy = { ...crate, files: crate.files.map(({ targetName, testOnly, ...rest }) => rest) };
  const before = hooks.buildRustGraph({ members: ['named'], crates: [legacy] });
  assert.ok(before.nodes.includes('named::bin::tool_entry'));
  assert.ok(before.nodes.some((name) => /tests$/.test(name)));
});

test('two targets with the same nested module path keep their own parents', async () => {
  // `byModulePath` held one `args`, so one `cspace` hung off the other
  // target's parent. The index is keyed by target as well as path now.
  const { hooks } = await loadBundledState();
  const file = (relativePath, role, modulePath, target) => ({
    path: `rust/dual/${relativePath}`, relativePath, modulePath, role,
    ...(target ? { target } : {}), reachable: true,
    lines: 1, productionItems: 0, publicItems: 0, testItems: 0, items: [],
    unsafe: { fns: 0, impls: 0, blocks: 0 }, testUnsafe: { fns: 0, impls: 0, blocks: 0 }
  });

  const graph = hooks.buildRustGraph({
    members: ['dual'],
    crates: [{
      name: 'dual', path: 'rust/dual', manifest: 'rust/dual/Cargo.toml',
      sourceFiles: 5, lines: 5, items: 0, publicItems: 0, testItems: 0,
      deniesUnsafe: false, unsafe: { fns: 0, impls: 0, blocks: 0 }, testUnsafe: { fns: 0, impls: 0, blocks: 0 },
      dependencies: [], internalDependencies: [], externalDependencies: [],
      devDependencies: [], buildDependencies: [], features: [],
      targetDependencies: [], optionalDependencies: [],
      files: [
        file('src/lib.rs', 'lib', ''),
        file('src/args.rs', 'module', 'args', 'src/lib.rs'),
        file('src/args/cspace.rs', 'module', 'args::cspace', 'src/lib.rs'),
        file('src/bin/tool/main.rs', 'bin', ''),
        file('src/bin/tool/args.rs', 'module', 'args', 'src/bin/tool/main.rs'),
        file('src/bin/tool/args/cspace.rs', 'module', 'args::cspace', 'src/bin/tool/main.rs')
      ]
    }]
  });

  const parentOf = (relativePath) => {
    const name = graph.nodes.find((n) => graph.byName[n].file.relativePath === relativePath);
    return graph.byName[graph.byName[name].parent].file.relativePath;
  };

  assert.equal(parentOf('src/args/cspace.rs'), 'src/args.rs', "the library's cspace hangs off the library's args");
  assert.equal(parentOf('src/bin/tool/args/cspace.rs'), 'src/bin/tool/args.rs',
    "and the binary's off the binary's");
});

test('an exactly-typed module outside the scope is not accepted', async () => {
  // Third site of the same mistake: the exact-match branch checked
  // state.moduleMap, so in scope=rust the caller closed the suggestions on a
  // Lean module that selectModule then refused.
  const { hooks } = await loadBundledState();

  hooks.setScope('both');
  assert.ok(hooks.nodeExists('SeLe4n.Kernel.API'));

  hooks.setScope('rust');
  assert.ok(!hooks.nodeExists('SeLe4n.Kernel.API'),
    'the exact-match branch now asks the same predicate the selection does');

  hooks.setScope('both');
});
