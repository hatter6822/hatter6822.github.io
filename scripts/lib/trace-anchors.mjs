/**
 * Ground every name the simulator shows in the kernel source it claims.
 *
 * A trace names kernel declarations everywhere: the operation a step runs, the
 * gate that checked its capability, the theorem that proves a property, the
 * predicate an invariant stands for. Each of those is a claim about the
 * kernel, and the 0.33.6 fixture proved how they rot: by 0.36.41 one had been
 * retired, two named modules rather than declarations, and fifteen named
 * functions that no executed path reaches any more. Nothing failed, because
 * nothing checked.
 *
 * So a name is not prose. The sync resolves every `{ name, module }` reference
 * in the trace against the pinned checkout — the same digest-verified tree the
 * code map is generated from — and stamps the line it is declared on in its
 * module's file, with the commit as `sourceRef`. A reference it cannot place fails the sync,
 * naming it: a declaration that left its module is an editorial decision (the
 * step may need rewriting, not repointing), the same rule the landing page's
 * deep links follow (`source-anchors.mjs`).
 *
 * The browser links `path#Lline` at `sourceRef`, so a link always opens the
 * revision its line was read from.
 */

import { declarationLine } from './source-anchors.mjs';
import { inductiveConstructors, stripLeanComments } from './lean-analysis.mjs';

/** Where the kernel declares the facts a step's syscall and outcome restate. */
export const KERNEL_FACT_SOURCES = Object.freeze({
  syscalls: { path: 'SeLe4n/Model/Object/Types.lean', inductive: 'SyscallId' },
  errors: { path: 'SeLe4n/Model/KernelError.lean', inductive: 'KernelError' },
  rights: { path: 'SeLe4n/Kernel/API.lean', table: 'syscallRequiredRight' }
});

/** `SeLe4n.Kernel.API` → `SeLe4n/Kernel/API.lean`. */
export function modulePath(module) {
  return String(module ?? '').replace(/\./g, '/') + '.lean';
}

function isRef(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.name === 'string' && typeof value.module === 'string';
}

/**
 * Every declaration reference in a trace document, each with a readable place.
 *
 * Returns the reference objects themselves (not copies), so stamping them
 * edits the document in place.
 */
export function collectTraceRefs(data) {
  const found = [];
  const note = (ref, where) => { if (isRef(ref)) found.push({ ref, where }); };
  const noteAll = (list, where) => { if (Array.isArray(list)) list.forEach((ref, i) => note(ref, `${where}[${i}]`)); };

  (data?.propertyCatalog ?? []).forEach((prop) => noteAll(prop.theorems, `property "${prop.id}".theorems`));
  (data?.invariantCatalog ?? []).forEach((inv) => {
    note(inv.predicate, `invariant "${inv.id}".predicate`);
    noteAll(inv.preservedBy, `invariant "${inv.id}".preservedBy`);
    // A proof names the function it is about and, when it proves a bundle,
    // the bundles the predicate sits in: each is a declaration too.
    (Array.isArray(inv.preservedBy) ? inv.preservedBy : []).forEach((proof, i) => {
      if (!isRef(proof)) return;
      note(proof.subject, `invariant "${inv.id}".preservedBy[${i}].subject`);
      noteAll(proof.within, `invariant "${inv.id}".preservedBy[${i}].within`);
    });
    note(inv.runtimeCheck, `invariant "${inv.id}".runtimeCheck`);
  });
  (data?.scenarios ?? []).forEach((sc) => (sc.steps ?? []).forEach((step, i) => {
    const where = `scenario "${sc.id}" step ${i}`;
    noteAll(step.sourceRefs, `${where} sourceRefs`);
    (step.path ?? []).forEach((stage, j) => note(stage.ref, `${where} path[${j}] (${stage.stage})`));
  }));
  return found;
}

/**
 * The line `name` is declared on in `text`, trying the qualified spelling first.
 *
 * `VSpaceRoot.mapPage` is written `def mapPage` inside `namespace VSpaceRoot`,
 * so the last segment is the fallback. Only the module's own file is searched:
 * a name that resolves somewhere else is not the declaration the trace cites.
 */
export function refLine(text, name, path) {
  const direct = declarationLine(text, name, path);
  if (direct !== undefined) return direct;
  const last = String(name).split('.').pop();
  return last && last !== name ? declarationLine(text, last, path) : undefined;
}

/**
 * Stamp `line` on every reference; return the ones that did not resolve.
 *
 * A reference's file is its module's (`modulePath`), so no path is stored: a
 * second copy of it could only disagree. `readSource(path)` returns a file's
 * text, or undefined when the checkout has no such file.
 */
export function anchorTraceRefs(data, readSource) {
  const unresolved = [];
  const texts = new Map();
  for (const { ref, where } of collectTraceRefs(data)) {
    const path = modulePath(ref.module);
    if (!texts.has(path)) texts.set(path, readSource(path));
    const text = texts.get(path);
    const line = typeof text === 'string' ? refLine(text, ref.name, path) : undefined;
    if (line === undefined) {
      unresolved.push(`${where}: ${ref.name} in ${ref.module}${typeof text === 'string' ? '' : ' (no such file)'}`);
      delete ref.path;
      delete ref.line;
      continue;
    }
    delete ref.path;
    ref.line = line;
  }
  return unresolved;
}

/**
 * The right each syscall requires, read off `syscallRequiredRight`'s match arms
 * (`| .send => .write`). Returns undefined when the table is not found.
 */
export function requiredRightTable(sourceText, name = KERNEL_FACT_SOURCES.rights.table) {
  const source = stripLeanComments(String(sourceText ?? ''));
  const header = new RegExp(`^def[^\\S\\n]+${name}\\b.*$`, 'm').exec(source);
  if (!header) return undefined;
  const table = {};
  for (const line of source.slice(header.index + header[0].length).split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const arm = /^\|\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*=>\s*\.([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
    if (arm) { table[arm[1]] = arm[2]; continue; }
    if (!/^\s/.test(line)) break;
  }
  return table;
}

/**
 * The number each syscall travels under in x7, read off `SyscallId.toNat`'s
 * match arms (`| .send => 0`). Returns undefined when the encoder is not found.
 */
export function syscallNumberTable(sourceText) {
  const source = stripLeanComments(String(sourceText ?? ''));
  const header = /^[^\S\n]*(?:@\[[^\]]*\][^\S\n]*)?def[^\S\n]+toNat[^\S\n]*:[^\S\n]*SyscallId[^\S\n]*→[^\S\n]*Nat.*$/m.exec(source);
  if (!header) return undefined;
  const table = {};
  for (const line of source.slice(header.index + header[0].length).split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const arm = /^\|\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*=>\s*(\d+)\b/.exec(trimmed);
    if (arm) { table[arm[1]] = Number(arm[2]); continue; }
    break;
  }
  return Object.keys(table).length ? table : undefined;
}

/**
 * Check what a trace restates about the kernel's interface, not just its names.
 *
 * A step's `syscall.id` must be a `SyscallId` constructor, its `number` (x7)
 * the value `SyscallId.toNat` gives it, its `requiredRight` the right
 * `syscallRequiredRight` assigns that syscall, and every error it reports a
 * `KernelError` constructor. The 0.33.6 fixture said `cspaceCopy`
 * needed write (it needs grant), `reply` needed grantReply (it needs write),
 * and called a syscall `declassifyStore` that does not exist. Returns issues;
 * an empty list means every restated fact matches the checkout.
 */
export function checkTraceKernelFacts(data, readSource) {
  const issues = [];
  const facts = KERNEL_FACT_SOURCES;
  const syscalls = inductiveConstructors(readSource(facts.syscalls.path) ?? '', facts.syscalls.inductive);
  const errors = inductiveConstructors(readSource(facts.errors.path) ?? '', facts.errors.inductive);
  const rights = requiredRightTable(readSource(facts.rights.path) ?? '');
  const numbers = syscallNumberTable(readSource(facts.syscalls.path) ?? '');
  if (!syscalls?.length) issues.push(`${facts.syscalls.inductive} not found in ${facts.syscalls.path}`);
  if (!errors?.length) issues.push(`${facts.errors.inductive} not found in ${facts.errors.path}`);
  if (!rights || !Object.keys(rights).length) issues.push(`${facts.rights.table} not found in ${facts.rights.path}`);
  if (!numbers) issues.push(`SyscallId.toNat not found in ${facts.syscalls.path}`);
  if (issues.length) return issues;

  const syscallSet = new Set(syscalls);
  const errorSet = new Set(errors);
  (data?.scenarios ?? []).forEach((sc) => (sc.steps ?? []).forEach((step, i) => {
    const where = `scenario "${sc.id}" step ${i}`;
    const call = step.syscall;
    if (call) {
      if (!syscallSet.has(call.id)) issues.push(`${where}: syscall "${call.id}" is not a SyscallId constructor`);
      else {
        // x7 carries `SyscallId.toNat` of the syscall (`decodeSyscallId`).
        if (call.number !== numbers[call.id]) {
          issues.push(`${where}: x7 = ${call.number}, but SyscallId.toNat .${call.id} = ${numbers[call.id]}`);
        }
        // A syscall that names no capability (yield) has no rights stage and so
        // restates no right; one that does must restate the table's.
        if (call.requiredRight !== undefined && rights[call.id] !== call.requiredRight) {
          issues.push(`${where}: ${call.id} requires "${rights[call.id]}" per ${facts.rights.table}, the trace says "${call.requiredRight}"`);
        }
      }
    }
    const reported = [step.outcome?.error, ...(step.path ?? []).map((stage) => stage.error)].filter(Boolean);
    for (const error of reported) {
      if (!errorSet.has(error)) issues.push(`${where}: "${error}" is not a KernelError constructor`);
    }
  }));
  return issues;
}

/**
 * A `def name : SyscallId → …` written as match arms, read into
 * `{ constructor: value }`. An arm may list several constructors and run over
 * several lines (`| .a | .b` … `| .c => v`); the value is the text after `=>`
 * with a leading `some` and a leading dot dropped. A wildcard arm is returned
 * under `_`. `undefined` when the definition is not there.
 */
export function matchArmTable(sourceText, name) {
  const source = stripLeanComments(String(sourceText ?? ''));
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^[^\\S\\n]*(?:@\\[[^\\]]*\\][^\\S\\n]*)?def[^\\S\\n]+${escaped}(?![A-Za-z0-9_?!'])[^\\n]*$`, 'm').exec(source);
  if (!header) return undefined;
  const table = {};
  let pending = [];
  for (const line of source.slice(header.index + header[0].length).split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) { if (Object.keys(table).length || pending.length) break; continue; }
    if (!trimmed.startsWith('|')) break;
    const at = trimmed.indexOf('=>');
    const patterns = (at === -1 ? trimmed : trimmed.slice(0, at)).split('|').map((p) => p.trim()).filter(Boolean);
    for (const p of patterns) {
      const m = /^\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(p) || /^(_)$/.exec(p);
      if (!m) return undefined;
      pending.push(m[1]);
    }
    if (at !== -1) {
      const value = trimmed.slice(at + 2).trim().replace(/^some\s+/, '').replace(/^\./, '');
      for (const ctor of pending) table[ctor] = value;
      pending = [];
    }
  }
  return Object.keys(table).length && !pending.length ? table : undefined;
}

/** Where the kernel writes the tables the trace engine restates. */
export const ENGINE_TABLE_SOURCES = Object.freeze({
  objectKind: { path: 'SeLe4n/Kernel/API.lean', table: 'syscallObjectKind?' },
  missingRight: { path: 'SeLe4n/Kernel/API.lean', table: 'syscallMissingRightError' },
  truncation: { path: 'SeLe4n/Kernel/Architecture/SyscallArgDecode.lean', table: 'truncationMinimum' },
  overflow: { path: 'SeLe4n/Kernel/Architecture/RegisterDecode.lean', table: 'syscallReadsOverflow' },
  targetAccepted: { path: 'SeLe4n/Kernel/API.lean', table: 'syscallTargetAccepted' }
});

/** The engine's capability kind for a kernel `KernelObjectType`. */
const OBJECT_KIND_NAMES = { vspaceRoot: 'vspace' };
/** The engine's capability kind for a non-object `CapTarget` constructor. */
const TARGET_KIND_NAMES = { replyCap: 'reply', irqControl: 'irqControl', irqHandler: 'irqHandler' };

/**
 * The trace engine decides the type gate, the missing-right answer, the
 * truncation minimum and which syscalls read the IPC buffer from tables it
 * restates. They are the kernel's tables, so they are compared with the
 * kernel's, entry for entry, for every syscall, at the revision the trace is
 * grounded in. A table that has moved fails the sync: a gate the page
 * recomputes from a stale table is a decision the kernel no longer makes.
 */
export function checkEngineTables(engine, readSource) {
  const issues = [];
  const src = ENGINE_TABLE_SOURCES;
  const read = (entry) => matchArmTable(readSource(entry.path) ?? '', entry.table);
  const syscalls = inductiveConstructors(readSource(KERNEL_FACT_SOURCES.syscalls.path) ?? '', KERNEL_FACT_SOURCES.syscalls.inductive) ?? [];
  if (!syscalls.length) return [`${KERNEL_FACT_SOURCES.syscalls.inductive} not found in ${KERNEL_FACT_SOURCES.syscalls.path}`];

  const kinds = read(src.objectKind);
  if (!kinds) issues.push(`${src.objectKind.table} not found in ${src.objectKind.path}`);
  else for (const id of syscalls) {
    const lean = kinds[id] === undefined ? kinds._ : kinds[id];
    const want = lean === undefined || lean === 'none' ? undefined : (OBJECT_KIND_NAMES[lean] ?? lean);
    const got = engine.SYSCALL_OBJECT_KIND[id];
    if (want !== got) issues.push(`${src.objectKind.table} .${id} is ${lean ?? 'unstated'}, the engine's SYSCALL_OBJECT_KIND says ${got ?? 'none'}`);
  }

  const missing = read(src.missingRight);
  if (!missing) issues.push(`${src.missingRight.table} not found in ${src.missingRight.path}`);
  else for (const id of syscalls) {
    const lean = missing[id] === undefined ? missing._ : missing[id];
    if (lean !== engine.missingRightError(id)) issues.push(`${src.missingRight.table} .${id} is ${lean ?? 'unstated'}, the engine answers ${engine.missingRightError(id)}`);
  }

  const mins = read(src.truncation);
  if (!mins) issues.push(`${src.truncation.table} not found in ${src.truncation.path}`);
  else for (const id of syscalls) {
    const lean = Number(mins[id] === undefined ? mins._ : mins[id]);
    if (lean !== engine.truncationMinimum(id)) issues.push(`${src.truncation.table} .${id} is ${lean}, the engine's TRUNCATION_MIN says ${engine.truncationMinimum(id)}`);
  }

  const overflow = read(src.overflow);
  if (!overflow) issues.push(`${src.overflow.table} not found in ${src.overflow.path}`);
  else for (const id of syscalls) {
    const lean = (overflow[id] === undefined ? overflow._ : overflow[id]) === 'true';
    if (lean !== engine.readsOverflow(id)) issues.push(`${src.overflow.table} .${id} is ${lean}, the engine's READS_OVERFLOW says ${engine.readsOverflow(id)}`);
  }

  // `syscallTargetAccepted`'s non-object arms: `| .replyCap _ => sid == .reply`.
  const accepted = stripLeanComments(readSource(src.targetAccepted.path) ?? '');
  const at = accepted.search(new RegExp(`def[^\\S\\n]+${src.targetAccepted.table}\\b`));
  if (at === -1) issues.push(`${src.targetAccepted.table} not found in ${src.targetAccepted.path}`);
  else {
    const body = accepted.slice(at).split(/\n[^\S\n]*\n/)[0];
    for (const [ctor, kind] of Object.entries(TARGET_KIND_NAMES)) {
      const arm = new RegExp(`\\|\\s*\\.${ctor}\\s+_\\s*=>([\\s\\S]*?)(?=\\n\\s*\\|\\s*\\.|$)`).exec(body);
      const lean = arm ? [...arm[1].matchAll(/sid\s*==\s*\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]).sort() : null;
      const got = Object.keys(engine.SYSCALL_TARGET_KIND).filter((id) => engine.SYSCALL_TARGET_KIND[id] === kind).sort();
      if (!lean) issues.push(`${src.targetAccepted.table} has no .${ctor} arm`);
      else if (lean.join(',') !== got.join(',')) issues.push(`${src.targetAccepted.table} accepts a .${ctor} capability for ${lean.join(', ')}; the engine's SYSCALL_TARGET_KIND says ${got.join(', ') || 'none'}`);
    }
    if (!/\|\s*none\s*=>\s*sid\s*==\s*\.declassify\b/.test(body)) issues.push(`${src.targetAccepted.table} no longer accepts any object capability for exactly .declassify`);
  }
  return issues;
}

/**
 * Ground a whole trace document at one revision: anchor every reference, check
 * every restated interface fact, and record the revision the lines belong to.
 * With `engine`, the tables the trace engine restates are checked too.
 * Returns the issues; the caller must refuse to publish when there are any.
 */
export function groundTrace(data, { readSource, commitSha, version, engine }) {
  const issues = [...anchorTraceRefs(data, readSource), ...checkTraceKernelFacts(data, readSource)];
  if (engine) issues.push(...checkEngineTables(engine, readSource));
  data.sourceRef = commitSha;
  data.kernelCommit = String(commitSha).slice(0, 7);
  if (version) data.kernelVersion = version;
  return issues;
}
