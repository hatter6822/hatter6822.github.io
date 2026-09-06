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

