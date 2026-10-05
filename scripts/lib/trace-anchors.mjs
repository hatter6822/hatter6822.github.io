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
 * code map is generated from — and stamps the file and line it is declared on,
 * with the commit as `sourceRef`. A reference it cannot place fails the sync,
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
 * Stamp `path` and `line` on every reference; return the ones that did not resolve.
 *
 * `readSource(path)` returns a file's text, or undefined when the checkout has
 * no such file.
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
    ref.path = path;
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
 * Check what a trace restates about the kernel's interface, not just its names.
 *
 * A step's `syscall.id` must be a `SyscallId` constructor, its `requiredRight`
 * the right `syscallRequiredRight` assigns that syscall, and every error it
 * reports a `KernelError` constructor. The 0.33.6 fixture said `cspaceCopy`
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
  if (!syscalls?.length) issues.push(`${facts.syscalls.inductive} not found in ${facts.syscalls.path}`);
  if (!errors?.length) issues.push(`${facts.errors.inductive} not found in ${facts.errors.path}`);
  if (!rights || !Object.keys(rights).length) issues.push(`${facts.rights.table} not found in ${facts.rights.path}`);
  if (issues.length) return issues;

  const syscallSet = new Set(syscalls);
  const errorSet = new Set(errors);
  (data?.scenarios ?? []).forEach((sc) => (sc.steps ?? []).forEach((step, i) => {
    const where = `scenario "${sc.id}" step ${i}`;
    const call = step.syscall;
    if (call) {
      if (!syscallSet.has(call.id)) issues.push(`${where}: syscall "${call.id}" is not a SyscallId constructor`);
      else if (rights[call.id] !== call.requiredRight) {
        issues.push(`${where}: ${call.id} requires "${rights[call.id]}" per ${facts.rights.table}, the trace says "${call.requiredRight}"`);
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
 * Ground a whole trace document at one revision: anchor every reference, check
 * every restated interface fact, and record the revision the lines belong to.
 * Returns the issues; the caller must refuse to publish when there are any.
 */
export function groundTrace(data, { readSource, commitSha, version }) {
  const issues = [...anchorTraceRefs(data, readSource), ...checkTraceKernelFacts(data, readSource)];
  data.sourceRef = commitSha;
  data.kernelCommit = String(commitSha).slice(0, 7);
  if (version) data.kernelVersion = version;
  return issues;
}
