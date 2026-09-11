/**
 * Tests for the deep-link anchor resolver.
 *
 * Sixteen of the landing page's thirty-seven line anchors were pointing at
 * unrelated code by 0.31.0 — `DomainFlowPolicy` at line 555 of a file where it
 * sits at 281. These pin the behaviour that replaced hand-maintained numbers:
 * collect what the page links to, resolve it in the checkout, stamp it back on
 * both surfaces, and refuse to guess when a label no longer resolves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySourceAnchors,
  collectSourceAnchors,
  declarationLine,
  labelIdentifier,
  resolveSourceAnchors
} from './source-anchors.mjs';

const LINK = (path, line, label, ref = 'main') =>
  `<a href="https://github.com/hatter6822/seLe4n/blob/${ref}/${path}#L${line}" target="_blank" rel="noopener noreferrer" class="code-link"><code>${label}</code></a>`;

test('collects a line-anchored, code-labelled blob link', () => {
  const found = collectSourceAnchors(`prose ${LINK('SeLe4n/Model/State.lean', 689, 'SystemState')} prose`);
  assert.deepEqual(found, [{ ref: 'main', path: 'SeLe4n/Model/State.lean', line: 689, label: 'SystemState' }]);
});

test('collects a link already stamped at a commit, so re-running is idempotent', () => {
  const found = collectSourceAnchors(LINK('SeLe4n/Model/State.lean', 638, 'SystemState', 'c386166'));
  assert.deepEqual(found, [{ ref: 'c386166', path: 'SeLe4n/Model/State.lean', line: 638, label: 'SystemState' }]);
});

test('collects the same link out of a locale file, where the quotes are escaped', () => {
  const json = JSON.stringify({ text: LINK('SeLe4n/Model/State.lean', 689, 'SystemState') });
  assert.deepEqual(collectSourceAnchors(json), [
    { ref: 'main', path: 'SeLe4n/Model/State.lean', line: 689, label: 'SystemState' }
  ]);
});

test('ignores a link with no line anchor and one whose label is prose', () => {
  const noAnchor = '<a href="https://github.com/hatter6822/seLe4n/blob/main/README.md">the README</a>';
  const proseLabel = '<a href="https://github.com/hatter6822/seLe4n/blob/main/SeLe4n/Model/State.lean#L1">the state record</a>';
  assert.deepEqual(collectSourceAnchors(`${noAnchor}\n${proseLabel}`), []);
});

test('a label must be an identifier to be resolvable', () => {
  assert.equal(labelIdentifier('SystemState'), 'SystemState');
  assert.equal(labelIdentifier('Cap&lt;Obj,&nbsp;Rts&gt;'), '');
  assert.equal(labelIdentifier('svc&nbsp;#0'), '');
  // The one alias: the page names the KernelObject constructor, the kernel
  // declares the structure it carries.
  assert.equal(labelIdentifier('Untyped'), 'UntypedObject');
});

test('finds a declaration past attributes and modifiers, at any indentation', () => {
  const source = [
    '/-- doc -/',                       // 1
    'structure Other where',            // 2
    '',                                 // 3
    '@[simp]',                          // 4
    'protected noncomputable def target : Nat := 0' // 5
  ].join('\n');
  assert.equal(declarationLine(source, 'target'), 5);
});

test('resolves a qualified Lean declaration by its short name', () => {
  assert.equal(declarationLine('def DomainFlowPolicy.ofLattice : Nat := 0', 'ofLattice'), 1);
});

test('reports a label it cannot place instead of guessing a line', () => {
  const anchors = [{ path: 'A.lean', label: 'Gone', line: 12 }];
  const { resolved, unresolved } = resolveSourceAnchors(anchors, () => 'def Present : Nat := 0');
  assert.deepEqual(resolved, {});
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0].reason, /no declaration of Gone/);
});

test('reports a file that is not in the checkout', () => {
  const { unresolved } = resolveSourceAnchors([{ path: 'Gone.lean', label: 'X', line: 1 }], () => undefined);
  assert.match(unresolved[0].reason, /file not in the checkout/);
});

test('stamps a moved declaration onto both surfaces', () => {
  const anchors = { 'SeLe4n/Kernel/InformationFlow/Policy.lean': { DomainFlowPolicy: 281 } };
  const html = LINK('SeLe4n/Kernel/InformationFlow/Policy.lean', 555, 'DomainFlowPolicy');

  assert.match(applySourceAnchors(html, anchors), /Policy\.lean#L281"/);

  const locale = applySourceAnchors(JSON.stringify({ text: html }), anchors);
  assert.match(locale, /Policy\.lean#L281\\"/);
  assert.deepEqual(Object.keys(JSON.parse(locale)), ['text']);
});

test('an anchored link names the revision its line belongs to', () => {
  // The unpinned sync falls back to the artifact's generation commit when
  // upstream has moved ahead of it, so a line resolved there is not a line on
  // `main`. A link that carries a line carries the commit too.
  const anchors = { 'SeLe4n/Model/State.lean': { SystemState: 638 } };
  const out = applySourceAnchors(LINK('SeLe4n/Model/State.lean', 689, 'SystemState'), anchors, 'c386166');
  assert.match(out, /blob\/c386166\/SeLe4n\/Model\/State\.lean#L638"/);

  // Re-stamping at a new revision replaces the old one rather than stacking.
  const again = applySourceAnchors(out, { 'SeLe4n/Model/State.lean': { SystemState: 700 } }, 'deadbee');
  assert.match(again, /blob\/deadbee\/SeLe4n\/Model\/State\.lean#L700"/);
});

test('without a revision the link keeps the ref it has', () => {
  const anchors = { 'SeLe4n/Model/State.lean': { SystemState: 638 } };
  const out = applySourceAnchors(LINK('SeLe4n/Model/State.lean', 689, 'SystemState'), anchors);
  assert.match(out, /blob\/main\/SeLe4n\/Model\/State\.lean#L638"/);
});

test('a revision that is not a plain ref is ignored rather than injected', () => {
  const anchors = { 'SeLe4n/Model/State.lean': { SystemState: 638 } };
  for (const bad of ['../../evil', 'a/b', '"onmouseover=', '']) {
    const out = applySourceAnchors(LINK('SeLe4n/Model/State.lean', 689, 'SystemState'), anchors, bad);
    assert.match(out, /blob\/main\/SeLe4n\/Model\/State\.lean#L638"/, String(bad));
  }
});

test('leaves an anchor the inventory does not carry exactly as written', () => {
  const html = LINK('SeLe4n/Other.lean', 42, 'Unknown');
  assert.equal(applySourceAnchors(html, { 'SeLe4n/Kernel/API.lean': { x: 1 } }), html);
});

test('never stamps a line number that is not a line', () => {
  const html = LINK('A.lean', 9, 'X');
  for (const bad of [0, -3, 1.5, '12', null]) {
    assert.equal(applySourceAnchors(html, { 'A.lean': { X: bad } }), html);
  }
});

test('the whole round trip: page → resolve → stamp', () => {
  const page = `<p>${LINK('A.lean', 999, 'Target')}</p>`;
  const source = ['-- header', '', 'def Target : Nat := 0'].join('\n');
  const { resolved, unresolved } = resolveSourceAnchors(collectSourceAnchors(page), () => source);
  assert.deepEqual(unresolved, []);
  assert.match(applySourceAnchors(page, resolved), /A\.lean#L3"/);
});
