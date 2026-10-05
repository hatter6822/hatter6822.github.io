/**
 * Headless runtime test for the Simulator (assets/js/run.js).
 *
 * There is no browser (and no jsdom dependency) in this repo's tooling, so this
 * test stands up a minimal DOM shim and executes the real run.js IIFE inside a
 * `vm` context. It is a regression guard for the end-to-end pipeline:
 *   data load → SVG stage render → kernel path, guarantees and invariants →
 *   transport stepping →
 *   sandbox perturbation breaking a client-side structural check.
 *
 * Assertions are intentionally about stable contracts (counts > 0, the step
 * label, the presence of a violated rail item) rather than brittle geometry, so
 * routine refactors of run.js don't cause false failures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

/* ── Minimal DOM shim ───────────────────────────────────────── */
function makeDom() {
  const byId = {};
  function makeEl(tag, ns) {
    const handlers = {};
    const node = {
      tagName: (tag || '').toUpperCase(), localName: tag, namespaceURI: ns || null,
      childNodes: [], parentNode: null, attrs: {}, dataset: {}, _class: '', _text: '', _html: '',
      get firstChild() { return this.childNodes[0] || null; },
      get classList() {
        const set = new Set((this._class || '').split(/\s+/).filter(Boolean));
        const self = this;
        return {
          add: (c) => { set.add(c); self._class = [...set].join(' '); },
          remove: (c) => { set.delete(c); self._class = [...set].join(' '); },
          toggle: (c, f) => { const on = f === undefined ? !set.has(c) : f; on ? set.add(c) : set.delete(c); self._class = [...set].join(' '); return on; },
          contains: (c) => set.has(c)
        };
      },
      set className(v) { this._class = v; }, get className() { return this._class; },
      set textContent(v) { this._text = v; this.childNodes = []; }, get textContent() { return this._text; },
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
      setAttribute(n, v) { this.attrs[n] = String(v); if (n === 'id') byId[v] = this; },
      getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
      removeAttribute(n) { delete this.attrs[n]; },
      appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; },
      insertBefore(c, ref) { const i = this.childNodes.indexOf(ref); if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); c.parentNode = this; return c; },
      removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; },
      addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
      removeEventListener() {},
      dispatchEvent(ev) { (handlers[ev.type] || []).forEach((fn) => fn(ev)); return true; },
      _fire(t, ev) { (handlers[t] || []).forEach((fn) => fn(ev || { type: t, target: this, preventDefault() {}, stopPropagation() {} })); },
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
      scrollIntoView() {}, focus() {}, animate() { return { cancel() {} }; },
      set hidden(v) { this.attrs.hidden = v; }, get hidden() { return !!this.attrs.hidden; },
      set value(v) { this.attrs.value = v; }, get value() { return this.attrs.value || ''; },
      set disabled(v) { this.attrs.disabled = v; }, get disabled() { return !!this.attrs.disabled; },
      set max(v) { this.attrs.max = v; }, get max() { return this.attrs.max; },
      set title(v) { this.attrs.title = v; }, get title() { return this.attrs.title; }
    };
    return node;
  }
  const document = {
    documentElement: makeEl('html'), body: makeEl('body'), readyState: 'complete', _h: {},
    createElement: (t) => makeEl(t), createElementNS: (ns, t) => makeEl(t, ns),
    createTextNode: (text) => { const n = makeEl('#text'); n._text = String(text); return n; },
    getElementById: (id) => byId[id] || (byId[id] = makeEl('div')),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn); },
    removeEventListener() {}, dispatchEvent(ev) { (this._h[ev.type] || []).forEach((fn) => fn(ev)); },
    get hidden() { return false; }
  };
  return { byId, document };
}

function klass(n) { return ((n._class || '') + ' ' + ((n.attrs && n.attrs.class) || '')).trim(); }
function countClass(node, cls, acc = { n: 0 }) { if (klass(node).split(/\s+/).includes(cls)) acc.n++; (node.childNodes || []).forEach((c) => countClass(c, cls, acc)); return acc.n; }
function countStatus(node, val, acc = { n: 0 }) { if (node.dataset && node.dataset.status === val) acc.n++; (node.childNodes || []).forEach((c) => countStatus(c, val, acc)); return acc.n; }
// Count CPU boxes (box-frame rects with data-accent="running"), one per core.
function countCpuBoxes(node, acc = { n: 0 }) {
  if (node.attrs && node.attrs['data-accent'] === 'running' && (node.attrs.class || '').split(/\s+/).includes('box-frame')) acc.n++;
  (node.childNodes || []).forEach((c) => countCpuBoxes(c, acc));
  return acc.n;
}
// Return the textContent of the first element whose class list includes `cls`.
function firstClassText(node, cls) {
  if (klass(node).split(/\s+/).includes(cls)) return node.textContent || '';
  for (const c of node.childNodes || []) { const t = firstClassText(c, cls); if (t !== null) return t; }
  return null;
}

async function bootRunJs(search, mutate) {
  const { byId, document } = makeDom();
  const store = new Map();
  const traceData = JSON.parse(await readFile(new URL('../../data/execution-traces.json', import.meta.url), 'utf8'));
  if (mutate) mutate(traceData); // let a test perturb the served payload before boot
  const window = {
    document, location: { search: search || '', pathname: '/run.html' },
    history: { replaceState() {} },
    localStorage: { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    navigator: { languages: ['en'] },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    requestAnimationFrame: (cb) => { cb(); return 1; },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    fetch: (url) => String(url).indexOf('data/execution-traces.json') >= 0
      ? Promise.resolve({ ok: true, json: () => Promise.resolve(traceData) })
      : Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('404')) })
  };
  window.window = window;
  const ctx = vm.createContext({
    window, document, console, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: window.fetch, localStorage: window.localStorage, navigator: window.navigator,
    matchMedia: window.matchMedia, requestAnimationFrame: window.requestAnimationFrame,
    AbortController: window.AbortController, CustomEvent: window.CustomEvent
  });
  const code = await readFile(new URL('../../assets/js/run.js', import.meta.url), 'utf8');
  vm.runInContext(code, ctx, { filename: 'run.js' });
  await new Promise((r) => setTimeout(r, 30)); // let fetch().then chains resolve
  return { byId, traceData };
}

test('run.js renders the stage, inspector, guarantees, invariants and log after loading bundled data', async () => {
  const { byId, traceData } = await bootRunJs('?scenario=ipc-call-reply&step=0');
  assert.ok(byId['theater-stage'].childNodes.length >= 1, 'stage has an SVG root');
  assert.ok(countClass(byId['theater-stage'], 'theater-chip') > 0, 'stage renders thread chips');
  assert.ok(countClass(byId['theater-stage'], 'theater-box') > 0, 'stage renders boxes');
  assert.equal(countClass(byId['guarantee-grid'], 'prop-card'), traceData.propertyCatalog.length, 'one card per security property');
  assert.equal(countClass(byId['invariant-list'], 'inv-item'), traceData.invariantCatalog.length, 'the invariant list carries the whole catalogue');
  const subsystems = new Set(traceData.invariantCatalog.map((i) => i.subsystem || 'other'));
  assert.equal(countClass(byId['invariant-list'], 'inv-group'), subsystems.size, 'one group per subsystem');
  assert.equal(byId['theater-log'].childNodes.length, traceData.scenarios[0].steps.length, 'log lists every step');
  assert.ok(byId['theater-inspector'].childNodes.length > 0, 'inspector is populated');
  assert.equal(countClass(byId['scenario-properties'], 'scenario-prop'), traceData.scenarios[0].properties.length, 'the scenario names the properties it demonstrates');
});

test('run.js highlights exactly the guarantees and invariants the current step names', async () => {
  const { byId, traceData } = await bootRunJs('?scenario=vspace-wx&step=1');
  const step = traceData.scenarios.find((s) => s.id === 'vspace-wx').steps[1];
  assert.ok(step.guarantees.length > 0 && step.invariants.preserved.length > 0);
  const active = [];
  (function walk(n) { if (klass(n).split(/\s+/).includes('prop-card') && n.dataset.active === 'true') active.push(n.attrs.id); (n.childNodes || []).forEach(walk); })(byId['guarantee-grid']);
  assert.deepEqual(active.sort(), step.guarantees.map((id) => 'property-' + id).sort(), 'the active cards are the step\'s guarantees');
  assert.equal(countStatus(byId['invariant-list'], 'preserved'), step.invariants.preserved.length, 'each preserved invariant is marked, the rest hold');
});

test('run.js draws the kernel path and names the stage that refused a call', async () => {
  const { byId, traceData } = await bootRunJs('?scenario=capability-gate&step=1');
  const step = traceData.scenarios.find((s) => s.id === 'capability-gate').steps[1];
  assert.equal(countClass(byId['theater-inspector'], 'path-stage'), step.path.length, 'one row per stage');
  assert.equal(countStatus(byId['theater-inspector'], 'fail'), 0, 'stage results are carried as data-result, not data-status');
  const results = [];
  (function walk(n) { if (klass(n).split(/\s+/).includes('path-stage')) results.push(n.dataset.result); (n.childNodes || []).forEach(walk); })(byId['theater-inspector']);
  assert.deepEqual(results, step.path.map((p) => p.result), 'each stage shows its own result');
  assert.equal(byId['guarantee-summary'].dataset.tone, 'refused', 'the summary says the call was refused');
  assert.ok(byId['guarantee-summary'].textContent.includes(step.outcome.error), 'and names the KernelError');
  assert.equal(countClass(byId['theater-inspector'], 'insp-diff'), 0, 'a refused step shows no state change');
  assert.ok(countClass(byId['theater-inspector'], 'insp-nochange') >= 1, 'it says so instead');
});

test('run.js links every grounded name to its line at the bundle\'s commit, and nothing else', async () => {
  const { byId, traceData } = await bootRunJs('?scenario=capability-gate&step=1');
  const hrefs = [];
  (function walk(n) { if (n.tagName === 'A' && /^https:/.test(n.attrs.href || '')) hrefs.push(n.attrs); (n.childNodes || []).forEach(walk); })(byId['theater-inspector']);
  assert.ok(hrefs.length > 0, 'the inspector links into the kernel');
  const prefix = `https://github.com/hatter6822/seLe4n/blob/${traceData.sourceRef}/`;
  for (const a of hrefs) {
    assert.ok(a.href.startsWith(prefix), `${a.href} is pinned to sourceRef`);
    assert.match(a.href, /\.lean#L\d+$/);
    assert.equal(a.rel, 'noopener noreferrer');
  }
  // A reference the sync did not stamp is shown, not linked.
  const unstamped = await bootRunJs('?scenario=capability-gate&step=1', (data) => {
    const st = data.scenarios.find((s) => s.id === 'capability-gate').steps[1];
    st.sourceRefs = [{ name: 'evil', module: 'SeLe4n.Kernel.API', path: '../x.lean', line: 1 }];
    st.path = st.path.map(({ ref, ...rest }) => rest);
  });
  const links = [];
  (function walk(n) { if (n.tagName === 'A' && /^https:/.test(n.attrs.href || '')) links.push(n.attrs.href); (n.childNodes || []).forEach(walk); })(unstamped.byId['theater-inspector']);
  assert.ok(!links.some((h) => h.includes('x.lean')), 'a path outside the whitelist never becomes a link');
});

test('run.js transport advances the step counter', async () => {
  const { byId } = await bootRunJs('?scenario=ipc-call-reply&step=0');
  for (let i = 0; i < 3; i++) byId['theater-next']._fire('click');
  assert.equal(byId['theater-step-label'].textContent, '4 / 6');
});

test('run.js inspector shows a state-diff for a transition step but not for boot', async () => {
  const boot = await bootRunJs('?scenario=ipc-call-reply&step=0');
  assert.equal(countClass(boot.byId['theater-inspector'], 'insp-diff'), 0, 'no diff at the boot step');
  const t1 = await bootRunJs('?scenario=ipc-call-reply&step=1');
  assert.ok(countClass(t1.byId['theater-inspector'], 'insp-diff') >= 1, 'a state-changes section renders for the call step');
});

test('run.js sandbox perturbation breaks a client-side structural check', async () => {
  const { byId } = await bootRunJs('?scenario=ipc-call-reply&step=3');
  byId['sandbox-toggle']._fire('click'); // enable sandbox
  const evt = { type: 'click', target: { closest: (sel) => sel === '[data-perturb]' ? { getAttribute: () => 'dup-runqueue' } : null }, preventDefault() {}, stopPropagation() {} };
  byId['sandbox-panel']._fire('click', evt);
  assert.ok(countStatus(byId['invariant-list'], 'violated') > 0, 'an invariant is shown violated');
  assert.equal(byId['invariant-summary'].dataset.tone, 'bad', 'the summary tone reflects the violation');
});

test('run.js restores deep-link state (scenario + step) from the URL', async () => {
  const { byId } = await bootRunJs('?scenario=notification-signal&step=2');
  assert.equal(byId['scenario-select'].value, 'notification-signal');
  assert.equal(byId['theater-step-label'].textContent, '3 / 5');
});

test('run.js renders the Scheduler scene with CBS budget bars', async () => {
  const { byId } = await bootRunJs('?scenario=edf-budget-preempt&step=0');
  // edf scenario declares primaryScene "scheduler"
  assert.ok(countClass(byId['theater-stage'], 'sched-chip') > 0, 'scheduler chips render');
  assert.ok(countClass(byId['theater-stage'], 'budget-fill') > 0, 'budget bars render');
});

test('run.js honors a URL scene override on a system-default scenario', async () => {
  const { byId } = await bootRunJs('?scenario=ipc-call-reply&scene=scheduler&step=0');
  assert.ok(countClass(byId['theater-stage'], 'sched-chip') > 0, 'scene=scheduler forces the scheduler scene');
});

test('run.js scene tabs switch the rendered scene', async () => {
  const { byId } = await bootRunJs('?scenario=ipc-call-reply&step=0');
  assert.equal(countClass(byId['theater-stage'], 'sched-chip'), 0, 'starts on the system scene');
  const tabs = byId['theater-scenes'].childNodes;
  const schedTab = tabs.find((t) => t.dataset && t.dataset.scene === 'scheduler');
  assert.ok(schedTab, 'a scheduler tab exists');
  schedTab._fire('click');
  assert.ok(countClass(byId['theater-stage'], 'sched-chip') > 0, 'clicking the tab switches to the scheduler scene');
});

test('run.js renders the Capability scene CDT (nodes + edges)', async () => {
  const { byId } = await bootRunJs('?scenario=capability-mint-revoke&step=4');
  assert.equal(countClass(byId['theater-stage'], 'cdt-node'), 4, 'four capabilities before revocation');
  assert.equal(countClass(byId['theater-stage'], 'cdt-edge'), 3, 'three derivation edges');
});

test('run.js revocation removes the derivations and keeps the revoked capability', async () => {
  const { byId } = await bootRunJs('?scenario=capability-mint-revoke&step=6');
  assert.equal(countClass(byId['theater-stage'], 'cdt-node'), 3, 'app′ is gone; app itself survives cspaceRevoke');
  assert.equal(countClass(byId['theater-stage'], 'cdt-edge'), 2);
});

test('run.js shows the Capability tab only for scenarios with a CDT', async () => {
  const cap = await bootRunJs('?scenario=capability-mint-revoke&step=0');
  const capTabs = cap.byId['theater-scenes'].childNodes.map((t) => t.dataset && t.dataset.scene);
  assert.ok(capTabs.includes('capability'), 'capability scenario shows the tab');
  const ipc = await bootRunJs('?scenario=ipc-call-reply&step=0');
  const ipcTabs = ipc.byId['theater-scenes'].childNodes.map((t) => t.dataset && t.dataset.scene);
  assert.ok(!ipcTabs.includes('capability'), 'ipc scenario hides the capability tab');
});

test('run.js renders the Memory scene (watermark bar + carved objects)', async () => {
  const { byId } = await bootRunJs('?scenario=untyped-lifecycle&step=2');
  assert.ok(countClass(byId['theater-stage'], 'mem-region') >= 1, 'an untyped region renders');
  assert.equal(countClass(byId['theater-stage'], 'mem-child'), 2, 'two carved objects');
  assert.ok(countClass(byId['theater-stage'], 'mem-watermark') >= 1, 'a watermark marker renders');
});

test('run.js untypedReset reclaims the region only after the children are revoked', async () => {
  const refused = await bootRunJs('?scenario=untyped-lifecycle&step=4');
  assert.equal(countClass(refused.byId['theater-stage'], 'mem-child'), 2, 'the refused reset leaves the region as it was');
  const reset = await bootRunJs('?scenario=untyped-lifecycle&step=6');
  assert.equal(countClass(reset.byId['theater-stage'], 'mem-child'), 0, 'no carved objects after the reset');
});

test('run.js shows the Memory tab only for scenarios with untyped memory', async () => {
  const mem = await bootRunJs('?scenario=untyped-lifecycle&step=0');
  const memTabs = mem.byId['theater-scenes'].childNodes.map((t) => t.dataset && t.dataset.scene);
  assert.ok(memTabs.includes('memory'), 'untyped scenario shows the Memory tab');
  const ipc = await bootRunJs('?scenario=ipc-call-reply&step=0');
  const ipcTabs = ipc.byId['theater-scenes'].childNodes.map((t) => t.dataset && t.dataset.scene);
  assert.ok(!ipcTabs.includes('memory'), 'ipc scenario hides the Memory tab');
});

test('run.js renders the Information-flow scene with a blocked flow', async () => {
  const { byId } = await bootRunJs('?scenario=infoflow-noninterference&step=1');
  assert.equal(countClass(byId['theater-stage'], 'if-domain'), 3, 'three security domains');
  assert.equal(countClass(byId['theater-stage'], 'if-policy'), 3, 'three allowed-flow policy arcs');
  assert.ok(countClass(byId['theater-stage'], 'if-flow-block') >= 1, 'the secret→public flow is shown blocked');
});

test('run.js declassification is an audited release: the policy never changes', async () => {
  const before = await bootRunJs('?scenario=infoflow-noninterference&step=4');
  assert.equal(countClass(before.byId['theater-stage'], 'audit-row'), 0, 'the audit log starts empty');
  const { byId } = await bootRunJs('?scenario=infoflow-noninterference&step=5');
  assert.equal(countClass(byId['theater-stage'], 'if-policy'), 3, 'declassify adds no policy edge');
  assert.equal(countClass(byId['theater-stage'], 'audit-row'), 1, 'it appends one audit entry');
});

test('run.js shows the Information-flow tab only for scenarios with a flow policy', async () => {
  const inf = await bootRunJs('?scenario=infoflow-noninterference&step=0');
  const infTabs = inf.byId['theater-scenes'].childNodes.map((t) => t.dataset && t.dataset.scene);
  assert.ok(infTabs.includes('infoflow'), 'infoflow scenario shows the tab');
  const ipc = await bootRunJs('?scenario=ipc-call-reply&step=0');
  const ipcTabs = ipc.byId['theater-scenes'].childNodes.map((t) => t.dataset && t.dataset.scene);
  assert.ok(!ipcTabs.includes('infoflow'), 'ipc scenario hides the infoflow tab');
});

test('run.js renders the VSpace scene with mappings + W^X status', async () => {
  const { byId } = await bootRunJs('?scenario=vspace-wx&step=2');
  assert.ok(countClass(byId['theater-stage'], 'vs-space') >= 1, 'an address space renders');
  assert.equal(countClass(byId['theater-stage'], 'vs-ok'), 2, 'two compliant page mappings (code r-x, data rw-)');
  assert.equal(countClass(byId['theater-stage'], 'vs-rejected'), 0, 'no rejection at step 2');
});

test('run.js VSpace W^X rejection shows a rejected row', async () => {
  const { byId } = await bootRunJs('?scenario=vspace-wx&step=3');
  assert.ok(countClass(byId['theater-stage'], 'vs-rejected') >= 1, 'the rwx map is shown rejected');
  assert.equal(countClass(byId['theater-stage'], 'vs-ok'), 2, 'the two compliant mappings remain (the rejected one is not stored)');
});

test('run.js shows the VSpace tab only for scenarios with an address space', async () => {
  const vsp = await bootRunJs('?scenario=vspace-wx&step=0');
  const vspTabs = vsp.byId['theater-scenes'].childNodes.map((t) => t.dataset && t.dataset.scene);
  assert.ok(vspTabs.includes('vspace'), 'vspace scenario shows the VSpace tab');
  const ipc = await bootRunJs('?scenario=ipc-call-reply&step=0');
  const ipcTabs = ipc.byId['theater-scenes'].childNodes.map((t) => t.dataset && t.dataset.scene);
  assert.ok(!ipcTabs.includes('vspace'), 'ipc scenario hides the VSpace tab');
});

test('run.js VSpace scene renders a TLB row that caches mapped pages', async () => {
  const { byId } = await bootRunJs('?scenario=vspace-wx&step=2');
  assert.ok(countClass(byId['theater-stage'], 'vs-tlb') >= 1, 'a TLB row renders for the address space');
  const tlb = firstClassText(byId['theater-stage'], 'vs-tlb');
  assert.ok(/0x400000/.test(tlb) && /0x600000/.test(tlb), 'both mapped pages are cached in the TLB after two maps');
  assert.equal(countClass(byId['theater-stage'], 'vs-shootdown'), 0, 'no shootdown annotation on a pure map step');
});

test('run.js VSpace unmap triggers a TLB shootdown (stale entry evicted)', async () => {
  const { byId } = await bootRunJs('?scenario=vspace-wx&step=4');
  assert.ok(countClass(byId['theater-stage'], 'vs-shootdown') >= 1, 'an unmap shows a shootdown annotation');
  const sd = firstClassText(byId['theater-stage'], 'vs-shootdown');
  assert.ok(/0x600000/.test(sd), 'the shootdown names the unmapped page');
  const tlb = firstClassText(byId['theater-stage'], 'vs-tlb');
  assert.ok(/0x400000/.test(tlb) && !/0x600000/.test(tlb), 'the unmapped page is evicted from the TLB, the survivor remains');
});

test('run.js Scheduler scene renders one CPU column per core (SMP)', async () => {
  const smp = await bootRunJs('?scenario=smp-affinity&scene=scheduler&step=0');
  assert.equal(countCpuBoxes(smp.byId['theater-stage']), 2, 'two CPU columns for two cores');
  const single = await bootRunJs('?scenario=edf-budget-preempt&scene=scheduler&step=0');
  assert.equal(countCpuBoxes(single.byId['theater-stage']), 1, 'single-core scenario → one CPU box');
});

test('run.js System scene is SMP-aware (one CPU box per core)', async () => {
  const smp = await bootRunJs('?scenario=smp-affinity&scene=system&step=0');
  assert.equal(countCpuBoxes(smp.byId['theater-stage']), 2, 'two CPU boxes in the System scene too');
  const ipc = await bootRunJs('?scenario=ipc-call-reply&scene=system&step=0');
  assert.equal(countCpuBoxes(ipc.byId['theater-stage']), 1, 'single-core System scene → one CPU box');
});

test('run.js surfaces a recorded invariant failure as violated, not green', async () => {
  const { byId } = await bootRunJs('?scenario=ipc-call-reply&step=1', (data) => {
    const sc = data.scenarios.find((s) => s.id === 'ipc-call-reply');
    const inv0 = data.invariantCatalog[0].id;
    sc.steps[1].invariants = { preserved: [], failed: [inv0] };
  });
  assert.ok(countStatus(byId['invariant-list'], 'violated') >= 1, 'the failed invariant is shown violated');
  assert.equal(byId['invariant-summary'].dataset.tone, 'bad', 'the summary tone reflects the failure');
});

test('run.js preserves a deep-linked selected object on initial load', async () => {
  const trace = JSON.parse(await readFile(new URL('../../data/execution-traces.json', import.meta.url), 'utf8'));
  const objId = trace.scenarios.find((s) => s.id === 'ipc-call-reply').initialState.threads[0].id;
  const linked = await bootRunJs('?scenario=ipc-call-reply&step=1&object=' + encodeURIComponent(objId));
  assert.ok(countClass(linked.byId['theater-inspector'], 'insp-object') >= 1, 'the deep-linked object detail survives the initial load');
  const plain = await bootRunJs('?scenario=ipc-call-reply&step=1');
  assert.equal(countClass(plain.byId['theater-inspector'], 'insp-object'), 0, 'no object panel without ?object=');
});

test('run.js strict adoption rejects a trace with a dangling op reference', async () => {
  const { byId } = await bootRunJs('?scenario=ipc-call-reply&step=0', (data) => {
    const sc = data.scenarios.find((s) => s.id === 'ipc-call-reply');
    sc.steps[1].delta.ops.push({ op: 'threadPatch', id: 'th.ghost', set: { priority: 1 } });
  });
  assert.equal(countClass(byId['theater-stage'], 'theater-chip'), 0, 'malformed trace is not adopted/rendered');
  assert.ok(/invalid/i.test(byId['theater-status'].textContent || ''), 'an invalid-data status is shown');
});

test('run.js refuses a trace whose refused step changes state', async () => {
  // A refused transition returns no successor state; drawing a change there
  // would publish a failure atomicity the kernel does not have.
  const { byId } = await bootRunJs('?scenario=capability-gate&step=0', (data) => {
    const st = data.scenarios.find((s) => s.id === 'capability-gate').steps[1];
    st.delta.ops.push({ op: 'threadPatch', id: st.actor, set: { priority: 1 } });
  });
  assert.equal(countClass(byId['theater-stage'], 'theater-chip'), 0);
  assert.ok(/invalid/i.test(byId['theater-status'].textContent || ''));
});

test('run.js is bundle-only: it fetches the bundled snapshot and nothing else', async () => {
  const code = await readFile(new URL('../../assets/js/run.js', import.meta.url), 'utf8');
  assert.ok(!/raw\.githubusercontent|api\.github\.com/.test(code), 'no remote data endpoint');
  assert.ok(!/localStorage\.(get|set)Item\(\s*["']sele4n-exec/.test(code), 'no trace cache');
  const html = await readFile(new URL('../../run.html', import.meta.url), 'utf8');
  assert.match(html, /connect-src 'self';/, 'the CSP allows same-origin fetches only');
});
