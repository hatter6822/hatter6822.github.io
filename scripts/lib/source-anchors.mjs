/**
 * Deep links into the kernel tree, kept pointing at the right line.
 *
 * The landing page links a declaration by name to the exact line it sits on:
 * `…/blob/main/SeLe4n/Kernel/InformationFlow/Policy.lean#L281`. A line number
 * is the one part of such a link that upstream invalidates without touching
 * anything here — `DomainFlowPolicy` moved from 555 to 281 between releases,
 * `registerServiceChecked` from 530 to 632, and by 0.31.0 sixteen of the
 * page's thirty-seven anchors landed on unrelated code. A reader who follows
 * one lands mid-proof somewhere else and has no way to tell the link is the
 * thing that is wrong.
 *
 * So the line numbers stop being prose. The sync scans the page for the links
 * it already carries, resolves each label's declaration in the pinned
 * checkout, and records the result in data/site-data.json;
 * scripts/apply-static-values.mjs stamps them back, the way every metric is
 * stamped. Adding a link to the page is enough — the next sync resolves it.
 *
 * What is deliberately *not* here: nothing invents a link, and nothing edits
 * the file path. A label that no longer resolves is reported, not guessed at,
 * because a declaration that left its file is an editorial change (the link
 * may belong somewhere else entirely) and quietly repointing it would publish
 * a claim nobody made.
 */

const BLOB_PREFIX = 'https://github.com/hatter6822/seLe4n/blob/main/';

/**
 * Labels that name something other than the declaration they link to.
 *
 * `Untyped` is the `KernelObject` constructor a reader knows the object type
 * by; the structure it carries is `UntypedObject`. Keep this table at the
 * handful of cases where the page's word and the kernel's identifier
 * genuinely differ — it is not a place to paper over a stale link.
 */
const LABEL_ALIASES = Object.freeze({
  Untyped: 'UntypedObject'
});

/**
 * Match a blob link that carries a line anchor and a `<code>` label.
 *
 * Written to survive both surfaces: index.html quotes attributes with `"`,
 * and a locale file stores the same HTML as a JSON string, where every quote
 * arrives escaped as `\"`. Anything between the href and the label is skipped
 * (target, rel, class), but not another tag that opens an element, so a link
 * whose label is plain prose is left alone.
 */
const ANCHOR_PATTERN = new RegExp(
  '(href=(?:"|\\\\")' + BLOB_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^"#\\\\]+)#L)(\\d+)' +
    '((?:"|\\\\")[^<>]*>\\s*<code>)([^<]+)(</code>)',
  'g'
);

/** Lean and Rust declaration headers that can carry a name. */
const DECLARATION_KEYWORDS = [
  'theorem', 'lemma', 'def', 'abbrev', 'structure', 'inductive', 'class', 'instance',
  'axiom', 'opaque', 'macro', 'notation',
  'fn', 'struct', 'enum', 'union', 'trait', 'type', 'const', 'static', 'macro_rules!'
];

const MODIFIERS = [
  'private', 'protected', 'noncomputable', 'partial', 'unsafe', 'nonrec', 'scoped', 'local',
  'pub', 'pub\\(crate\\)', 'pub\\(super\\)', 'async', 'extern', 'default'
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip the entities a label may carry in markup, so `&amp;` matches `&`. */
function decodeLabel(label) {
  return String(label)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * The identifier a label refers to, or '' when the label is not one.
 *
 * A label carrying a space, a generic argument or a path separator is prose or
 * a type expression (`Cap<Obj, Rts>`), not a declaration this can look up.
 */
export function labelIdentifier(label) {
  const decoded = decodeLabel(label);
  const aliased = LABEL_ALIASES[decoded] ?? decoded;
  return /^[A-Za-z_][A-Za-z0-9_'!?]*$/.test(aliased) ? aliased : '';
}

/**
 * Every line-anchored, code-labelled blob link in one text surface.
 *
 * Returns one entry per occurrence (the same link appears in six locales), so
 * callers that want a set should key on `path` and `label` themselves.
 */
export function collectSourceAnchors(text) {
  const found = [];
  if (typeof text !== 'string') return found;

  for (const match of text.matchAll(ANCHOR_PATTERN)) {
    found.push({ path: match[2], line: Number(match[3]), label: decodeLabel(match[5]) });
  }

  return found;
}

/**
 * Find the line a declaration is written on, 1-based, or undefined.
 *
 * Matches a declaration header at any indentation, after an optional
 * attribute (`@[simp]`, `#[inline]`) and any run of modifiers, and allows the
 * qualified spelling a Lean declaration may carry (`DomainFlowPolicy.ofLattice`
 * resolves for the label `ofLattice`). The first such line wins: a name is
 * declared once, and a later `theorem foo_bar` is a different name.
 */
export function declarationLine(sourceText, name) {
  if (typeof sourceText !== 'string' || !name) return undefined;

  const header = new RegExp(
    `^[^\\S\\n]*(?:@\\[[^\\]]*\\][^\\S\\n]*|#\\[[^\\]]*\\][^\\S\\n]*)*` +
      `(?:(?:${MODIFIERS.join('|')})[^\\S\\n]+)*` +
      `(?:${DECLARATION_KEYWORDS.join('|')})[^\\S\\n]+` +
      `(?:[A-Za-z0-9_.']+\\.)?${escapeRegExp(name)}\\b`
  );

  const lines = sourceText.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (header.test(lines[index])) return index + 1;
  }

  return undefined;
}

/**
 * Resolve every collected anchor against a checkout.
 *
 * `readSource(path)` returns the file's text, or undefined when it is not in
 * the checkout. The result is keyed by path then label so the snapshot reads
 * as an inventory of the page's links, and `unresolved` names the ones a
 * caller has to look at by hand — a moved file, a renamed declaration.
 */
export function resolveSourceAnchors(anchors, readSource) {
  const resolved = {};
  const unresolved = [];
  const sources = new Map();
  const seen = new Set();

  for (const { path, label, line } of anchors) {
    const identifier = labelIdentifier(label);
    if (!identifier) continue;

    const key = `${path}#${label}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!sources.has(path)) sources.set(path, readSource(path));
    const text = sources.get(path);
    if (typeof text !== 'string') {
      unresolved.push({ path, label, line, reason: 'file not in the checkout' });
      continue;
    }

    const found = declarationLine(text, identifier);
    if (found === undefined) {
      unresolved.push({ path, label, line, reason: `no declaration of ${identifier} in this file` });
      continue;
    }

    (resolved[path] ??= {})[label] = found;
  }

  return { resolved, unresolved };
}

/**
 * Rewrite the line anchors in a text surface from a resolved inventory.
 *
 * Pure string → string, like the metric rewriter beside it. A link whose
 * (path, label) pair the inventory does not carry keeps the anchor it has:
 * the stamper never removes a line number it could not confirm.
 */
export function applySourceAnchors(text, anchors) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!anchors || typeof anchors !== 'object') return text;

  return text.replace(ANCHOR_PATTERN, (whole, head, path, line, middle, label, tail) => {
    const resolved = anchors[path]?.[decodeLabel(label)];
    if (!Number.isInteger(resolved) || resolved < 1) return whole;
    return `${head}${resolved}${middle}${label}${tail}`;
  });
}
