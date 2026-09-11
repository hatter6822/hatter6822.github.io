/**
 * Lean source parsing.
 *
 * Two consumers, two roles:
 *
 * - `extractImportTokens` is used by the sync pipeline. Import edges are the
 *   one thing the canonical `docs/codebase_map.json` does not record, so the
 *   dependency graph has to be read from the Lean sources themselves.
 * - the declaration parsers below mirror the copies inside `assets/js/map.js`,
 *   which the map runtime uses when it fetches an individual `.lean` file. The
 *   pipeline no longer calls them: declarations come from the canonical
 *   artifact, whose generator tracks nested `/- -/` depth and strips string
 *   literals, which a line-oriented regex cannot. Keeping them here keeps the
 *   runtime's logic under test.
 *
 * Everything about the canonical artifact itself lives in ./canonical-map.mjs.
 */
export function normalizeSymbolName(name) {
  return String(name || '').replace(/`/g, '').trim();
}

export const INTERIOR_KIND_GROUPS = Object.freeze({
  object: Object.freeze(['inductive', 'structure', 'class', 'def', 'theorem', 'lemma', 'example', 'instance', 'opaque', 'abbrev', 'axiom', 'constant', 'constants']),
  extension: Object.freeze(['declare_syntax_cat', 'syntax_cat', 'syntax', 'macro', 'macro_rules', 'notation', 'infix', 'infixl', 'infixr', 'prefix', 'postfix', 'elab', 'elab_rules', 'term_elab', 'command_elab', 'tactic']),
  contextInit: Object.freeze(['universe', 'universes', 'variable', 'variables', 'parameter', 'parameters', 'section', 'namespace', 'end', 'initialize'])
});

const ALL_INTERIOR_KINDS = Object.freeze([
  ...INTERIOR_KIND_GROUPS.object,
  ...INTERIOR_KIND_GROUPS.extension,
  ...INTERIOR_KIND_GROUPS.contextInit
]);

export function theoremCount(text) {
  const matches = String(text || '').match(/^\s*(?:@\[[^\]]+\]\s+|@[\w.]+\s+)*(?:private\s+|protected\s+)?(?:noncomputable\s+)?(?:theorem|lemma)\s+[\w'.`]+/gm);
  return matches ? matches.length : 0;
}

function createLineLocator(text) {
  const source = String(text || '');
  const lineStarts = [0];

  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) !== 10) continue;
    lineStarts.push(i + 1);
  }

  return function lineNumberForIndex(index) {
    const target = Math.max(0, Number(index) || 0);
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (lineStarts[mid] <= target) low = mid + 1;
      else high = mid - 1;
    }

    return Math.max(1, high + 1);
  };
}


function declarationLineFromMatch(match, lineNumberForIndex) {
  const whole = String((match && match[0]) || '');
  const leading = (whole.match(/^\s*/) || [''])[0].length;
  return lineNumberForIndex((match && typeof match.index === 'number' ? match.index : 0) + leading);
}

export function extractInteriorCodeItems(sourceText) {
  const source = String(sourceText || '');
  const seenByKind = Object.create(null);
  const byKind = Object.create(null);
  const declarationPattern = /^\s*(?:@\[[^\]]+\]\s+|@[\w.]+\s+)*(?:private\s+|protected\s+)?(?:noncomputable\s+)?(inductive|structure|class|def|theorem|lemma|example|instance|opaque|abbrev|axiom|constants?|declare_syntax_cat|syntax_cat|syntax|macro_rules|macro|notation|infixl|infixr|infix|prefix|postfix|elab_rules|term_elab|command_elab|elab|tactic|universes?|variables?|parameters?|section|namespace|end|initialize)\b[ \t]*([^:\s\n(\[{:=\-]*)/gm;
  const lineNumberForIndex = createLineLocator(sourceText);

  for (const kind of ALL_INTERIOR_KINDS) {
    byKind[kind] = [];
    seenByKind[kind] = Object.create(null);
  }

  let match;
  while ((match = declarationPattern.exec(source)) !== null) {
    const keyword = String(match[1] || '').trim();
    if (!keyword) continue;
    const kind = keyword;
    if (!Object.prototype.hasOwnProperty.call(byKind, kind)) continue;

    const rawName = normalizeSymbolName(match[2] || '');
    const line = declarationLineFromMatch(match, lineNumberForIndex);
    const fallbackName = `<${kind}@L${line}>`;
    const name = rawName || fallbackName;
    if (seenByKind[kind][name]) continue;
    seenByKind[kind][name] = true;
    byKind[kind].push({ name, line });
  }

  return {
    byKind,
    theorems: [...byKind.theorem, ...byKind.lemma],
    functions: [...byKind.def, ...byKind.abbrev, ...byKind.opaque, ...byKind.instance]
  };
}

export function isLikelyModuleToken(token) {
  return /^[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*$/.test(token || '');
}

export function tokenizeImportSegment(segment) {
  const out = [];
  const raw = (segment || '').split(/[\s,]+/);
  for (const part of raw) {
    const candidate = (part || '').replace(/^[()]+|[()]+$/g, '').trim();
    if (!candidate || !isLikelyModuleToken(candidate)) continue;
    out.push(candidate);
  }
  return out;
}

export function extractImportTokens(sourceText) {
  const tokens = [];
  const lines = String(sourceText || '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] || '';
    const withoutComment = raw.split('--')[0] || '';
    const trimmed = withoutComment.trim();
    if (!/^import(?:\s|$)/.test(trimmed)) continue;

    tokens.push(...tokenizeImportSegment(trimmed.replace(/^import\s*/, '')));

    let cursor = i + 1;
    while (cursor < lines.length) {
      const continuationRaw = lines[cursor] || '';
      if (!/^\s/.test(continuationRaw)) break;

      const continuation = (continuationRaw.split('--')[0] || '').trim();
      if (!continuation) {
        cursor += 1;
        continue;
      }

      const contTokens = tokenizeImportSegment(continuation);
      if (!contTokens.length) break;
      tokens.push(...contTokens);
      cursor += 1;
    }

    i = cursor - 1;
  }

  return tokens;
}


/**
 * Strip Lean comments while preserving offsets-per-line semantics closely
 * enough for declaration counting: nested `/- -/` blocks and `--` line
 * comments both go, string literals are kept whole so a `--` inside one is not
 * mistaken for a comment.
 *
 * The artifact's own `proved_theorem_lemma_decls` is a bare per-line regex with
 * no comment handling, and it over-counts by 78 prose lines on the current
 * tree (see the reconciliation at the top of canonical-map.mjs). Anything this
 * module counts off raw sources does the comment-aware thing instead.
 */
export function stripLeanComments(sourceText) {
  const text = String(sourceText || '');
  let out = '';
  let depth = 0;
  let i = 0;

  while (i < text.length) {
    if (depth === 0 && text[i] === '"') {
      const start = i;
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += text.slice(start, Math.min(i, text.length));
      continue;
    }
    if (text.startsWith('/-', i)) { depth += 1; i += 2; continue; }
    if (depth > 0 && text.startsWith('-/', i)) { depth -= 1; i += 2; continue; }
    if (depth > 0) {
      // Keep newlines so line-anchored patterns still see the right structure.
      if (text[i] === '\n') out += '\n';
      i += 1;
      continue;
    }
    if (text.startsWith('--', i)) {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    out += text[i];
    i += 1;
  }

  return out;
}

/**
 * Count the constructors of a named `inductive`.
 *
 * The syscall surface is an `inductive SyscallId` whose constructors are the
 * syscalls, so this is how the site learns how many there are instead of a
 * human retyping the number into three sentences and six locale files. Returns
 * `undefined` when the declaration is not found, so a rename upstream fails
 * the sync loudly rather than publishing a stale count.
 */
export function countInductiveConstructors(sourceText, name) {
  return inductiveConstructors(sourceText, name)?.length;
}

/**
 * The constructor names of a named `inductive`, in source order.
 *
 * `NonInterferenceStep` names one kernel step per constructor, and the site
 * states that each has its own non-interference proof. Counting both sides
 * would only show the totals agree; naming them is what lets the sync check
 * that every step is actually covered. Returns `undefined` when the
 * declaration is not found.
 */
export function inductiveConstructors(sourceText, name) {
  const source = stripLeanComments(sourceText);
  /* Horizontal whitespace only: `\s*` after a multiline `^` happily consumes
     the preceding blank lines, which puts the anchor before the header and
     makes the very first line read as a following declaration. */
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(`^[^\\S\\n]*inductive[^\\S\\n]+${escaped}\\b.*$`, 'm');
  const match = declaration.exec(source);
  if (!match) return undefined;

  const lines = source.slice(match.index + match[0].length).split(/\r?\n/).slice(1);
  const names = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const constructor = /^\|\s*([A-Za-z_][A-Za-z0-9_'!?]*)/.exec(trimmed);
    if (constructor) { names.push(constructor[1]); continue; }
    if (/^\|\s*\S/.test(trimmed)) { names.push(''); continue; }
    // `deriving`, `where`-block members and any following declaration end it;
    // an indented continuation of the previous constructor does not.
    if (/^(deriving|inductive|structure|def|theorem|lemma|abbrev|instance|namespace|end|@\[)/.test(trimmed)) break;
    if (!/^\s/.test(line)) break;
  }
  return names;
}

/**
 * Count `@[extern …]` declarations — the Lean side of the foreign-function
 * bridge. Lean attaches the attribute to the declaration it precedes, so one
 * attribute is one bridged function. Attribute lists may carry other
 * attributes alongside it (`@[extern "f", inline]`).
 */
export function countExternDeclarations(sourceText) {
  const source = stripLeanComments(sourceText);
  const matches = source.match(/@\[[^\]]*\bextern\b[^\]]*\]/g);
  return matches ? matches.length : 0;
}
