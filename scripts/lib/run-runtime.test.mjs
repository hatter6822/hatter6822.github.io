/**
 * Headless runtime test for the Simulator (assets/js/run.js and the scenes it
 * draws with, assets/js/run-scenes.js).
 *
 * There is no jsdom dependency in this repo's tooling, so this test stands up
 * a minimal DOM shim and executes the real trace-engine.js, run-scenes.js and
 * run.js inside a `vm` context. It is a regression guard for the end-to-end
 * pipeline:
 *   data load → the seven SVG scenes, for every step, before and after →
 *   kernel path, guarantees and invariants → transport stepping → sandbox
 *   perturbations judged by the engine's executable mirrors → strict adoption
 *   of the bundled document.
 * Geometry (1:1, nothing past an edge) is scripts/run-smoke.mjs's, in a browser.
 *
 * Assertions are intentionally about stable contracts (counts > 0, the step
 * label, the presence of a violated rail item) rather than brittle geometry, so
 * routine refactors of run.js don't cause false failures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { scenarioStates } from './trace-analysis.mjs';

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
// Every node under `node` whose attribute `name` equals `value`.
function withAttr(node, name, value, acc = []) {
  if (node.attrs && node.attrs[name] === value) acc.push(node);
  (node.childNodes || []).forEach((c) => withAttr(c, name, value, acc));
  return acc;
}
function texts(node, acc = []) { if (node._text) acc.push(node._text); (node.childNodes || []).forEach((c) => texts(c, acc)); return acc; }
const click = (target) => ({ type: 'click', target, preventDefault() {}, stopPropagation() {} });
const delegate = (attr, value) => ({ closest: (sel) => (sel === `[${attr}]` ? { getAttribute: () => value } : null) });

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
  // run.html loads the shared engine first; the runtime is written against it.
  const engine = await readFile(new URL('../../assets/js/trace-engine.js', import.meta.url), 'utf8');
  vm.runInContext(engine, ctx, { filename: 'trace-engine.js' });
  const scenes = await readFile(new URL('../../assets/js/run-scenes.js', import.meta.url), 'utf8');
  vm.runInContext(scenes, ctx, { filename: 'run-scenes.js' });
  const code = await readFile(new URL('../../assets/js/run.js', import.meta.url), 'utf8');
  vm.runInContext(code, ctx, { filename: 'run.js' });
  await new Promise((r) => setTimeout(r, 30)); // let fetch().then chains resolve
  return { byId, traceData };
}

const TRACES = JSON.parse(await readFile(new URL('../../data/execution-traces.json', import.meta.url), 'utf8'));
const sc = (id) => TRACES.scenarios.find((s) => s.id === id);
const stageSvg = (byId) => byId['theater-stage'].childNodes[0];

test('run.js renders the stage, inspector, guarantees, invariants and log after loading bundled data', async () => {
  const { byId } = await bootRunJs('?scenario=ipc-call-reply&step=0');
  assert.equal(stageSvg(byId).tagName, 'SVG', 'the stage is one SVG');
  assert.ok(countClass(byId['theater-stage'], 'theater-obj') > 0, 'it draws selectable objects');
  assert.equal(countClass(byId['guarantee-grid'], 'prop-card'), TRACES.propertyCatalog.length, 'one card per security property');
  assert.equal(countClass(byId['invariant-list'], 'inv-item'), TRACES.invariantCatalog.length, 'the invariant list carries the whole catalogue');
  const subsystems = new Set(TRACES.invariantCatalog.map((i) => i.subsystem || 'other'));
  assert.equal(countClass(byId['invariant-list'], 'inv-group'), subsystems.size, 'one group per subsystem');
  assert.equal(byId['theater-log'].childNodes.length, sc('ipc-call-reply').steps.length, 'the log lists every step');
  assert.equal(countClass(byId['theater-log'], 'step-chip'), sc('ipc-call-reply').steps.length, 'each step is a button in the strip');
  assert.equal(withAttr(byId['theater-log'], 'aria-current', 'step').length, 1, 'exactly one step is current');
  assert.equal(countClass(byId['theater-inspector'], 'insp-boot'), 1, 'the inspector says what to do at the initial state');
  assert.equal(countClass(byId['theater-step-head'], 'step-title'), 1, 'the step is titled above the stage');
  assert.equal(countClass(byId['scenario-properties'], 'scenario-prop'), sc('ipc-call-reply').properties.length);
  assert.ok(byId['theater-legend'].childNodes.length > 0, 'the legend describes the scene on show');
});

test('run.js highlights exactly the guarantees and invariants the current step names', async () => {
  const { byId } = await bootRunJs('?scenario=vspace-wx&step=1');
  const step = sc('vspace-wx').steps[1];
  // Which invariants a step preserves by proof follows from the catalogue: a
  // theorem covers a syscall step by its syscall id or by the "syscall" wildcard.
  assert.equal(step.outcome.status, 'ok');
  const covered = TRACES.invariantCatalog.filter((inv) => inv.preservedBy.some((p) => p.covers.includes(step.syscall.id) || p.covers.includes('syscall')));
  assert.ok(step.guarantees.length > 0 && covered.length > 0 && covered.length < TRACES.invariantCatalog.length);
  const active = [];
  (function walk(n) { if (klass(n).split(/\s+/).includes('prop-card') && n.dataset.active === 'true') active.push(n.attrs.id); (n.childNodes || []).forEach(walk); })(byId['guarantee-grid']);
  assert.deepEqual(active.sort(), step.guarantees.map((id) => 'property-' + id).sort());
  assert.equal(countStatus(byId['invariant-list'], 'preserved'), covered.length);
  const refused = await bootRunJs('?scenario=capability-gate&step=1');
  assert.equal(countStatus(refused.byId['invariant-list'], 'preserved'), 0, 'a refused step changed nothing: no proof is cited for it');
});

test('run.js lists the checked path in the inspector and names the stage that refused', async () => {
  const { byId } = await bootRunJs('?scenario=capability-gate&step=1');
  const step = sc('capability-gate').steps[1];
  const results = [];
  (function walk(n) { if (klass(n).split(/\s+/).includes('path-stage')) results.push(n.dataset.result); (n.childNodes || []).forEach(walk); })(byId['theater-inspector']);
  assert.deepEqual(results, step.path.map((p) => p.result), 'each stage shows its own result');
  assert.equal(byId['guarantee-summary'].dataset.tone, 'refused');
  assert.ok(byId['guarantee-summary'].textContent.includes(step.outcome.error), 'the summary names the KernelError');
  assert.equal(countClass(byId['theater-inspector'], 'insp-diff'), 0, 'a refused step shows no state change');
  assert.ok(countClass(byId['theater-inspector'], 'insp-nochange') >= 1, 'it says so instead');
});

test('run.js links every grounded name to its line at the bundle\'s commit, and nothing else', async () => {
  const { byId } = await bootRunJs('?scenario=capability-gate&step=1');
  const hrefs = [];
  (function walk(n) { if (n.tagName === 'A' && /^https:/.test(n.attrs.href || '')) hrefs.push(n.attrs); (n.childNodes || []).forEach(walk); })(byId['theater-inspector']);
  assert.ok(hrefs.length > 0, 'the inspector links into the kernel');
  const prefix = `https://github.com/hatter6822/seLe4n/blob/${TRACES.sourceRef}/`;
  for (const a of hrefs) {
    assert.ok(a.href.startsWith(prefix), `${a.href} is pinned to sourceRef`);
    assert.match(a.href, /\.lean#L\d+$/);
    assert.equal(a.rel, 'noopener noreferrer');
  }
  const unstamped = await bootRunJs('?scenario=capability-gate&step=1', (data) => {
    const st = data.scenarios.find((s) => s.id === 'capability-gate').steps[1];
    st.sourceRefs = [{ name: 'evil', module: 'SeLe4n.Kernel.API', path: '../x.lean', line: 1 }];
  });
  const links = [];
  (function walk(n) { if (n.tagName === 'A' && /^https:/.test(n.attrs.href || '')) links.push(n.attrs.href); (n.childNodes || []).forEach(walk); })(unstamped.byId['theater-inspector']);
  assert.ok(!links.some((h) => h.includes('x.lean')), 'a path outside the whitelist never becomes a link');
});

test('run.js transport steps, and the URL restores scenario and step', async () => {
  const total = sc('ipc-call-reply').steps.length;
  const { byId } = await bootRunJs('?scenario=ipc-call-reply&step=0');
  for (let i = 0; i < 3; i++) byId['theater-next']._fire('click');
  assert.equal(byId['theater-step-label'].textContent, `4 / ${total}`);
  byId['theater-prev']._fire('click');
  assert.equal(byId['theater-step-label'].textContent, `3 / ${total}`);
  const linked = await bootRunJs('?scenario=notification-signal&step=2');
  assert.equal(linked.byId['scenario-select'].value, 'notification-signal');
  assert.equal(linked.byId['theater-step-label'].textContent, `3 / ${sc('notification-signal').steps.length}`);
  const hostile = await bootRunJs('?scenario=%3Cscript%3E&step=99999&scene=bogus');
  assert.equal(hostile.byId['scenario-select'].value, TRACES.scenarios[0].id, 'an unknown scenario falls back to the first');
});

test('run.js inspector shows a state diff for a transition step but not for boot', async () => {
  const boot = await bootRunJs('?scenario=ipc-call-reply&step=0');
  assert.equal(countClass(boot.byId['theater-inspector'], 'insp-diff'), 0);
  const t1 = await bootRunJs('?scenario=ipc-call-reply&step=1');
  assert.ok(countClass(t1.byId['theater-inspector'], 'insp-diff') >= 1);
});

/* ── Scenes ─────────────────────────────────────────────────── */

function expectedScenes(s) {
  const st = s.initialState;
  const out = ['path']; // every step has a path: a trap, a tick, a reschedule or an interrupt
  if ((st.endpoints || []).length || (st.notifications || []).length || (st.replies || []).length) out.push('ipc');
  if ((st.cores || []).length) out.push('scheduler');
  if ((st.cnodes || []).length) out.push('cspace');
  if ((st.untyped || []).length || (st.vspaces || []).length) out.push('memory');
  if ((st.labels || []).length >= 2) out.push('infoflow');
  if ((st.irqs || []).length) out.push('irq');
  return out;
}

test('run.js offers exactly the scenes a scenario has something to show in, and the tabs switch them', async () => {
  for (const s of TRACES.scenarios) {
    const { byId } = await bootRunJs(`?scenario=${s.id}&step=0`);
    const tabs = byId['theater-scenes'].childNodes;
    assert.deepEqual(tabs.map((t) => t.dataset.scene), expectedScenes(s), s.id);
    const opening = s.focus && expectedScenes(s).includes(s.focus) ? s.focus : expectedScenes(s)[0];
    assert.equal(stageSvg(byId).attrs['data-scene'], opening, `${s.id} opens on its focus scene`);
    assert.equal(tabs.filter((t) => t.attrs['aria-selected'] === 'true').length, 1, 'one tab is selected');
    assert.equal(tabs.filter((t) => t.attrs.tabindex === '0').length, 1, 'and it alone is in the tab order');
    const last = tabs[tabs.length - 1];
    last._fire('click');
    assert.equal(stageSvg(byId).attrs['data-scene'], last.dataset.scene, 'a tab switches the scene');
  }
});

test('every scene of every step of every scenario draws, and is described in words', async () => {
  for (const s of TRACES.scenarios) {
    for (const scene of expectedScenes(s)) {
      for (let i = 0; i < s.steps.length; i++) {
        for (const view of i === 0 ? ['after'] : ['after', 'before']) {
          const { byId } = await bootRunJs(`?scenario=${s.id}&step=${i}&scene=${scene}${view === 'before' ? '&view=before' : ''}`);
          const where = `${s.id} step ${i} ${scene} ${view}`;
          const svg = stageSvg(byId);
          assert.equal(svg && svg.tagName, 'SVG', where);
          assert.equal(svg.attrs['data-scene'], scene, where);
          assert.equal(countClass(byId['theater-stage'], 'stage-fallback'), 0, `${where}: the scene did not throw`);
          assert.equal(svg.attrs['aria-describedby'], 'theater-alt', `${where}: the SVG points at its text alternative`);
          assert.ok((byId['theater-alt'].textContent || '').includes(s.steps[i].title), `${where}: the alternative names the step`);
        }
      }
    }
  }
});

test('the before/after toggle shows the state a step found, and the URL carries it', async () => {
  const s = sc('ipc-call-reply');
  const i = s.steps.findIndex((x) => x.syscall && x.syscall.id === 'call');
  const caller = s.steps[i].actor;
  const status = (byId) => withAttr(stageSvg(byId), 'data-object', caller)
    .flatMap((g) => g.childNodes).map((n) => n.attrs['data-status']).filter(Boolean)[0];
  const after = await bootRunJs(`?scenario=ipc-call-reply&step=${i}&scene=ipc`);
  assert.equal(status(after.byId), 'blocked', 'after a call the caller is blocked on the reply');
  const before = await bootRunJs(`?scenario=ipc-call-reply&step=${i}&scene=ipc&view=before`);
  assert.equal(status(before.byId), 'running', 'before it, the caller was running');
  // The radios themselves are static markup; run-smoke.mjs drives them in a browser.
  const html = await readFile(new URL('../../run.html', import.meta.url), 'utf8');
  assert.deepEqual([...html.matchAll(/role="radio"[^>]*data-view="([a-z]+)"/g)].map((m) => m[1]), ['before', 'after']);
});

test('the path scene draws the registers, the CPtr walk, every gate and the Except result', async () => {
  const step = sc('capability-gate').steps[1];
  const { byId } = await bootRunJs('?scenario=capability-gate&step=1&scene=path');
  const svg = stageSvg(byId);
  const cn = sc('capability-gate').initialState.cnodes[0];
  const all = texts(svg);
  for (const reg of ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x7']) assert.ok(all.some((t) => t === reg || t.startsWith(reg + ' ')), `${reg} is drawn`);
  assert.equal(withAttr(svg, 'data-role', 'guard').length, cn.guardWidth, 'one cell per guard bit');
  assert.equal(withAttr(svg, 'data-role', 'radix').length, cn.radixWidth, 'one cell per radix bit');
  assert.ok(withAttr(svg, 'data-role', 'f-length').length > 0, 'the MessageInfo length field is drawn bit by bit');
  assert.equal(countClass(svg, 'right-pill'), 5, 'every right, held or not');
  assert.equal(withAttr(svg, 'data-need', 'missing').length, 1, 'the missing right is marked');
  const gates = [];
  (function walk(n) { if (klass(n).split(/\s+/).includes('gate')) gates.push(n.attrs['data-result']); (n.childNodes || []).forEach(walk); })(svg);
  assert.deepEqual(gates, step.path.map((p) => p.result), 'one gate per stage, in the kernel\'s order, each with its result');
  assert.ok(all.some((t) => t.includes(step.outcome.error)), 'the refusal names the KernelError');
});

test('the path scene shows the selection a dispatch made, with every candidate\'s verdict', async () => {
  const s = sc('scheduler-buckets');
  const i = s.steps.findIndex((x) => x.delta.ops.some((o) => o.op === 'dispatch' && o.thread));
  const { byId } = await bootRunJs(`?scenario=scheduler-buckets&step=${i}&scene=path`);
  const svg = stageSvg(byId);
  assert.equal(withAttr(svg, 'data-pick', 'true').length, 1, 'one candidate is chosen');
  assert.ok(countClass(svg, 'sel-row') >= 2, 'every candidate the core weighed is listed, not only the winner');
  const picked = withAttr(svg, 'data-pick', 'true')[0];
  const dispatched = s.steps[i].delta.ops.find((o) => o.op === 'dispatch').thread;
  const name = s.initialState.threads.find((t) => t.id === dispatched).name;
  assert.ok(texts(picked).includes(name), 'and the chosen row is the thread the step dispatched');
  // A context that ran dry is listed with the reason it was passed over.
  const edf = sc('budget-edf');
  const j = edf.steps.findIndex((x, k) => k > 0 && x.delta.ops.some((o) => o.op === 'dispatch') && x.delta.ops.some((o) => o.op === 'scCharge'));
  const dry = await bootRunJs(`?scenario=budget-edf&step=${j}&scene=path`);
  assert.equal(withAttr(stageSvg(dry.byId), 'data-pick', 'true').length, 1);
  assert.ok(withAttr(stageSvg(dry.byId), 'data-role', 'budget').length + withAttr(stageSvg(dry.byId), 'data-role', 'spent').length > 0, 'the charge is drawn tick by tick');
});

test('the path scene walks an interrupt through its delivery, bound or not', async () => {
  const s = sc('irq-delivery');
  const fires = s.steps.map((x, i) => (x.kind === 'interrupt' ? i : -1)).filter((i) => i >= 0);
  assert.ok(fires.length >= 2, 'the scenario fires the line both unbound and bound');
  for (const i of fires) {
    const { byId } = await bootRunJs(`?scenario=irq-delivery&step=${i}&scene=path`);
    assert.ok(countClass(stageSvg(byId), 'step-dot') >= 3, `step ${i}: the delivery is drawn as ordered steps`);
    const irq = await bootRunJs(`?scenario=irq-delivery&step=${i}&scene=irq`);
    assert.ok(withAttr(stageSvg(irq.byId), 'data-object', 'irq:' + s.steps[i].irq.line).length >= 1, 'the interrupt scene draws the line that fired');
  }
});

test('the IPC scene draws queues, the notification word and the message a step delivered', async () => {
  const call = sc('ipc-call-reply').steps.findIndex((x) => x.syscall && x.syscall.id === 'call');
  const ipc = await bootRunJs(`?scenario=ipc-call-reply&step=${call}&scene=ipc`);
  assert.equal(countClass(stageSvg(ipc.byId), 'payload'), 1, 'the delivered message is drawn');
  assert.ok(withAttr(stageSvg(ipc.byId), 'data-weight', 'heavy').length >= 1, 'with the edge it travelled');
  const step = sc('ipc-call-reply').steps[call];
  const words = step.delta.ops.find((o) => o.op === 'message').words;
  assert.ok(words.length > 0 && texts(stageSvg(ipc.byId)).some((t) => words.every((w) => t.includes(String(w)))), 'and its words are the ones the trace records');
  const boot = await bootRunJs('?scenario=ipc-call-reply&step=0&scene=ipc');
  assert.equal(countClass(stageSvg(boot.byId), 'payload'), 0, 'no message is drawn where none moved');
  const ntfn = await bootRunJs('?scenario=notification-signal&step=2&scene=ipc');
  const cells = withAttr(stageSvg(ntfn.byId), 'data-role', 'f-extra').length + withAttr(stageSvg(ntfn.byId), 'data-role', 'spent').length;
  assert.equal(cells, 8 * sc('notification-signal').initialState.notifications.length, 'the pending word is drawn bit by bit');
  assert.ok(withAttr(stageSvg(ntfn.byId), 'data-role', 'f-extra').length >= 1, 'the latched badge shows its set bits');
  // A capability travels only when the endpoint capability carries grant.
  const xfer = sc('cap-transfer');
  const sends = xfer.steps.map((x, i) => (x.syscall && x.syscall.id === 'send' ? i : -1)).filter((i) => i >= 0);
  const moved = sends.filter((i) => xfer.steps[i].delta.ops.some((o) => o.op === 'capInsert'));
  assert.ok(moved.length >= 1 && moved.length < sends.length, 'the scenario has a send that moves a capability and one that does not');
});

test('the scheduler scene draws one box per core and the scheduling contexts', async () => {
  const smp = await bootRunJs('?scenario=smp-affinity&step=1&scene=scheduler');
  assert.equal(countClass(stageSvg(smp.byId), 'cpu'), sc('smp-affinity').initialState.cores.length, 'one CPU per core');
  const state = scenarioStates(sc('smp-affinity'))[1];
  const buckets = Object.values(state.runQueues).reduce((n, q) => n + new Set(q.map((e) => e.prio)).size, 0);
  assert.equal(countClass(stageSvg(smp.byId), 'bucket'), buckets, 'one row per priority bucket that holds a thread');
  assert.ok(withAttr(stageSvg(smp.byId), 'data-mark', 'next').length >= 1, 'the thread each core would pick next is marked');
  const edf = await bootRunJs('?scenario=budget-edf&step=1&scene=scheduler');
  for (const ctx of sc('budget-edf').initialState.schedContexts) {
    assert.ok(withAttr(stageSvg(edf.byId), 'data-object', ctx.id).length >= 1, `${ctx.id} is drawn`);
  }
  assert.ok(withAttr(stageSvg(edf.byId), 'data-object', 'clock').length === 1, 'the kernel clock is drawn');
  assert.ok(withAttr(stageSvg(edf.byId), 'data-role', 'budget').length >= 1, 'budgets are drawn tick by tick');
});

test('the CSpace scene draws every slot and one arc per derivation link', async () => {
  const s = sc('capability-derivation');
  const i = s.steps.length - 2;
  const { byId } = await bootRunJs(`?scenario=capability-derivation&step=${i}&scene=cspace`);
  const state = scenarioStates(s)[i];
  for (const cn of state.cnodes) {
    for (const slot of Object.keys(cn.slots || {})) {
      assert.ok(withAttr(stageSvg(byId), 'data-object', `${cn.id}/${slot}`).length >= 1, `${cn.id}/${slot} is drawn`);
    }
  }
  const inTree = new Set();
  for (const [parent, kids] of Object.entries(state.cdt || {})) { if (kids.length) { inTree.add(parent); kids.forEach((k) => inTree.add(k)); } }
  assert.equal(countClass(stageSvg(byId), 'tree-node'), inTree.size, 'the derivation tree has one node per slot in it');
  const del = s.steps.findIndex((x) => x.syscall && x.syscall.id === 'cspaceDelete');
  const gone = await bootRunJs(`?scenario=capability-derivation&step=${del}&scene=cspace`);
  const deleted = s.steps[del].delta.ops.find((o) => o.op === 'capDelete').slot;
  const ghost = withAttr(stageSvg(gone.byId), 'data-object', deleted).flatMap((g) => g.childNodes).filter((n) => n.attrs['data-ghost'] === 'true');
  assert.equal(ghost.length, 1, 'the capability a delete removed is shown where it was');
});

test('the memory scene draws a refused retype where it would have gone, and a refused W+X mapping', async () => {
  const ut = sc('untyped-retype').steps.findIndex((x) => x.syscall && x.syscall.id === 'untypedRetype' && x.outcome.status === 'error');
  const a = await bootRunJs(`?scenario=untyped-retype&step=${ut}&scene=memory`);
  const request = [];
  (function walk(n) { if (klass(n).split(/\s+/).includes('request')) request.push(n); (n.childNodes || []).forEach(walk); })(stageSvg(a.byId));
  assert.equal(request.length, 1, 'the request is drawn');
  assert.equal(request[0].attrs['data-ghost'], 'true', 'as a ghost: it was refused');
  const kids = scenarioStates(sc('untyped-retype'))[ut].untyped[0].children.length;
  assert.equal(countClass(stageSvg(a.byId), 'carved'), kids, 'one carved extent per object the region holds');
  assert.equal(countClass(stageSvg(a.byId), 'region'), sc('untyped-retype').initialState.untyped.length);
  const ok = await bootRunJs('?scenario=untyped-retype&step=1&scene=memory');
  const granted = [];
  (function walk(n) { if (klass(n).split(/\s+/).includes('request')) granted.push(n); (n.childNodes || []).forEach(walk); })(stageSvg(ok.byId));
  assert.equal(granted.length, 1);
  assert.notEqual(granted[0].attrs['data-ghost'], 'true', 'a granted request is not a ghost');
  const wx = sc('vspace-wx').steps.findIndex((x) => x.outcome.status === 'error');
  const b = await bootRunJs(`?scenario=vspace-wx&step=${wx}&scene=memory`);
  const refused = sc('vspace-wx').steps[wx].delta.ops.find((o) => o.op === 'vspaceReject');
  assert.ok(refused, 'the refusal is recorded as an event');
  assert.equal(withAttr(stageSvg(b.byId), 'data-ghost', 'true').length, 1, 'the refused mapping is drawn as a ghost row');
  assert.ok(texts(stageSvg(b.byId)).some((t) => t.includes('W^X')), 'and says why');
  const unmap = sc('vspace-wx').steps.findIndex((x) => x.syscall && x.syscall.id === 'vspaceUnmap');
  const c = await bootRunJs(`?scenario=vspace-wx&step=${unmap}&scene=memory`);
  assert.equal(withAttr(stageSvg(c.byId), 'data-ghost', 'true').length, 1, 'the unmapped page is shown where it was');
  const mapped = scenarioStates(sc('vspace-wx'))[unmap].vspaces[0].mappings.length;
  assert.ok(texts(stageSvg(c.byId)).filter((t) => /^0x[0-9a-f]+$/.test(t)).length >= mapped + 1, 'beside every page still mapped');
});

test('the information-flow scene draws the lattice, the denied flow and the audit entry', async () => {
  const s = sc('information-flow');
  const denied = s.steps.findIndex((x) => x.outcome.status === 'error');
  const a = await bootRunJs(`?scenario=information-flow&step=${denied}&scene=infoflow`);
  assert.equal(countClass(stageSvg(a.byId), 'label-box'), s.initialState.labels.length, 'one box per label');
  const edges = [];
  (function walk(n) { if (klass(n).split(/\s+/).includes('ed')) edges.push(n.attrs); (n.childNodes || []).forEach(walk); })(stageSvg(a.byId));
  assert.ok(edges.some((e) => e['data-tone'] === 'bad' && e['data-dash'] === 'true'), 'the denied flow is drawn dashed, in the refusal colour');
  assert.ok(edges.some((e) => e['data-tone'] !== 'bad'), 'beside the flows the policy admits');
  const declass = s.steps.findIndex((x) => x.delta.ops.some((o) => o.op === 'auditAppend'));
  const before = await bootRunJs(`?scenario=information-flow&step=${declass}&scene=infoflow&view=before`);
  const b = await bootRunJs(`?scenario=information-flow&step=${declass}&scene=infoflow`);
  const auditTexts = (r) => withAttr(stageSvg(r.byId), 'data-object', 'audit').flatMap((g) => texts(g)).length;
  assert.ok(auditTexts(b) > auditTexts(before), 'the declassification adds a row to the audit log');
  assert.equal(withAttr(stageSvg(b.byId), 'data-object', 'audit')[0].attrs['data-changed'], 'true');
});
/* ── Sandbox ────────────────────────────────────────────────── */

const PERTURBATIONS = [
  ['enqueue-current', 'ipc-call-reply', 2, 'queueCurrentConsistent'],
  ['wake-blocked', 'ipc-call-reply', 1, 'blockedNotRunnable'],
  ['dup-runqueue', 'scheduler-buckets', 0, 'runQueueUnique'],
  ['orphan-cdt', 'capability-derivation', 1, 'cdtLinksAgree'],
  ['map-wx', 'vspace-wx', 1, 'wxExclusive'],
  ['stale-tlb', 'vspace-wx', 1, 'tlbConsistent'],
  ['overspend', 'budget-edf', 1, 'budgetWithinBounds'],
  ['overlap', 'untyped-retype', 2, 'untypedNonOverlap']
];

test('the run.html sandbox offers every perturbation the runtime knows', async () => {
  const html = await readFile(new URL('../../run.html', import.meta.url), 'utf8');
  const offered = [...html.matchAll(/data-perturb="([a-z-]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(offered, PERTURBATIONS.map((p) => p[0]).sort());
});

for (const [kind, scenarioId, stepIndex, invariant] of PERTURBATIONS) {
  test(`sandbox "${kind}" breaks ${invariant}, and reset restores the trace`, async () => {
    assert.ok(TRACES.invariantCatalog.some((i) => i.id === invariant), `${invariant} is catalogued`);
    const { byId } = await bootRunJs(`?scenario=${scenarioId}&step=${stepIndex}`);
    byId['sandbox-toggle']._fire('click');
    byId['sandbox-panel']._fire('click', click(delegate('data-perturb', kind)));
    assert.equal(byId[`invariant-${invariant}`].dataset.status, 'violated', `${kind} violates ${invariant}`);
    assert.equal(byId['invariant-summary'].dataset.tone, 'bad');
    byId['sandbox-panel']._fire('click', click(delegate('data-sandbox-reset', '')));
    assert.equal(countStatus(byId['invariant-list'], 'violated'), 0, 'reset returns to the trace');
  });
}

/* ── Selection and adoption ─────────────────────────────────── */

test('run.js selects an object from the stage and keeps a deep-linked selection on first load', async () => {
  const objId = sc('ipc-call-reply').initialState.threads[0].id;
  const linked = await bootRunJs('?scenario=ipc-call-reply&step=1&object=' + encodeURIComponent(objId));
  assert.ok(countClass(linked.byId['theater-inspector'], 'insp-object') >= 1);
  const plain = await bootRunJs('?scenario=ipc-call-reply&step=1');
  assert.equal(countClass(plain.byId['theater-inspector'], 'insp-object'), 0);
  plain.byId['theater-stage']._fire('click', click(delegate('data-object', objId)));
  assert.ok(countClass(plain.byId['theater-inspector'], 'insp-object') >= 1, 'a click on the stage selects');
});

for (const [why, mutate] of [
  ['a dangling op reference', (d) => d.scenarios[0].steps[1].delta.ops.push({ op: 'threadPatch', id: 'th.ghost', set: { priority: 1 } })],
  ['a refused step that changes state', (d) => {
    const st = d.scenarios.find((s) => s.id === 'capability-gate').steps[1];
    st.delta.ops.push({ op: 'threadPatch', id: st.actor, set: { priority: 1 } });
  }],
  ['another schema version', (d) => { d.schemaVersion = 2; }],
  ['an op the engine does not know', (d) => d.scenarios[0].steps[1].delta.ops.push({ op: 'servicePatch' })]
]) {
  test(`run.js refuses a document with ${why}`, async () => {
    const { byId } = await bootRunJs('?scenario=ipc-call-reply&step=0', mutate);
    assert.equal(byId['theater-stage'].childNodes.length, 0, 'nothing is drawn');
    assert.ok(/invalid/i.test(byId['theater-status'].textContent || ''), 'an invalid-data status is shown');
  });
}

/* ── Bundle-only, and every label localised ─────────────────── */

test('run.js is bundle-only: it fetches the bundled snapshot and nothing else', async () => {
  const code = await readFile(new URL('../../assets/js/run.js', import.meta.url), 'utf8');
  assert.ok(!/raw\.githubusercontent|api\.github\.com/.test(code), 'no remote data endpoint');
  assert.ok(!/localStorage/.test(code), 'no cache, and the theme is theme-init.js\'s');
  const html = await readFile(new URL('../../run.html', import.meta.url), 'utf8');
  assert.match(html, /connect-src 'self';/);
  assert.ok(html.indexOf('trace-engine.js') < html.indexOf('assets/js/run.js'), 'the engine loads before the runtime');
});

test('every label run.js looks up exists in the English locale', async () => {
  const code = await readFile(new URL('../../assets/js/run.js', import.meta.url), 'utf8');
  const scenes = await readFile(new URL('../../assets/js/run-scenes.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../../run.html', import.meta.url), 'utf8');
  const en = JSON.parse(await readFile(new URL('../../locales/en.json', import.meta.url), 'utf8')).run;
  const keys = new Set([...code.matchAll(/"run\.([a-z0-9_]+)"/g)].map((m) => m[1]).filter((k) => !k.endsWith('_')));
  // The scenes look their labels up as L("key", "fallback"), or name them in a
  // ["key", "fallback"] table that a lookup walks.
  for (const m of scenes.matchAll(/\bL\(\s*"([a-z0-9_]+)"\s*,/g)) if (!m[1].endsWith('_')) keys.add(m[1]);
  for (const m of scenes.matchAll(/\["([a-z][a-z0-9_]+)",\s*"(?:[^"\\]|\\.)*"\]/g)) keys.add(m[1]);
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="run\.([a-z0-9_]+)"/g)) keys.add(m[1]);
  // Keys built from a value: one per path stage the schema allows.
  for (const stage of ['entry', 'decode', 'lookup', 'type', 'rights', 'args', 'flow', 'operation']) keys.add('stage_' + stage);
  assert.ok(keys.size > 300, 'the scan found the labels');
  const has = (k) => k in en || `${k}_other` in en; // a plural family is looked up by its base
  const missing = [...keys].filter((k) => !has(k));
  assert.deepEqual(missing, []);
  const base = (k) => k.replace(/_(one|few|many|other)$/, '');
  const unused = Object.keys(en).filter((k) => !keys.has(k) && !keys.has(base(k)));
  assert.deepEqual(unused, [], 'and the locale carries no label the page no longer uses');
});

test('the scenes decide nothing: every kernel decision they draw is asked of the engine', async () => {
  const scenes = await readFile(new URL('../../assets/js/run-scenes.js', import.meta.url), 'utf8');
  for (const fn of ['selectOnCore', 'resolveCap', 'carvePlacement', 'retypeRequest', 'flowsTo', 'irqBinding', 'transferPlan', 'msgInfoFields']) {
    assert.match(scenes, new RegExp(`\\bE\\.${fn}\\(`), `the scenes ask the engine for ${fn}`);
  }
  assert.ok(!/\bfetch\(|localStorage|XMLHttpRequest/.test(scenes), 'and they load and store nothing');
});
