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
 * ── Canonical metrics projection ───────────────────────────────────────────
 *
 * `docs/codebase_map.json` in the seLe4n repository is the single source of
 * truth for every landing-page statistic. The kernel's own
 * `scripts/generate_codebase_map.py` emits it, and the upstream README's
 * "Current state" table is itself rendered from the same `readme_sync` block —
 * so reading the artifact is what keeps this site and that README from
 * contradicting each other.
 *
 * Schema targeted (`schema_version` 1.0.0):
 *
 *   summary.module_count                      381   production + test modules
 *   summary.declaration_count              19,039
 *   readme_sync.version                  "0.34.56"
 *   readme_sync.lean_toolchain            "v4.28.0"
 *   readme_sync.production_files              311
 *   readme_sync.production_loc            330,569
 *   readme_sync.test_files                     70
 *   readme_sync.test_loc                   68,907
 *   readme_sync.proved_theorem_lemma_decls 11,000
 *   modules[].declarations[]      { kind, name, line, called[] }
 *
 * Scope: the landing page reports *production* Lean — everything outside
 * `tests/`. Upstream computes `proved_theorem_lemma_decls` over production
 * files only, so modules and lines are taken production-only too. The three
 * headline figures then describe one corpus and match the README exactly.
 *
 * Substitution rule: a metric may fall back to another key *of the same
 * artifact*, never to a source outside it. Earlier revisions of this
 * projection guessed at key names the artifact has never carried
 * (`lean_version`, `build_jobs`, `stats.*`, `files[]`); the misses fell
 * through to heuristics — a README table parse, a `GET /languages` byte
 * estimate, a `modules × 2` build-job invention — and the page published
 * figures no upstream source asserts. `canonicalMetricsIssues()` now fails the
 * sync loudly when a required key goes missing, so a schema change upstream
 * surfaces as a red build instead of a plausible-looking wrong number.
 */

/** Required canonical keys, as dotted paths, with the metric each feeds. */
const CANONICAL_KEYS = Object.freeze([
  ['readme_sync.version', 'version'],
  ['readme_sync.lean_toolchain', 'leanVersion'],
  ['readme_sync.production_files', 'modules'],
  ['readme_sync.production_loc', 'lines'],
  ['readme_sync.proved_theorem_lemma_decls', 'theorems'],
  ['repository.head.commit_sha', 'commitSha'],
  ['repository.head.committed_at_utc', 'updatedAt']
]);

function readPath(root, dottedPath) {
  let node = root;
  for (const segment of dottedPath.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * Report every canonical key the landing page needs but the artifact lacks.
 *
 * Returns an empty array for a well-formed map. Callers are expected to treat
 * a non-empty result as fatal: publishing a partially-projected snapshot is
 * how the page drifted away from the artifact in the first place.
 */
export function canonicalMetricsIssues(codebaseMap) {
  if (!codebaseMap || typeof codebaseMap !== 'object') {
    return ['docs/codebase_map.json: expected a JSON object'];
  }

  const issues = [];
  for (const [path, metric] of CANONICAL_KEYS) {
    const value = readPath(codebaseMap, path);
    if (value === undefined || value === null || value === '') {
      issues.push(`docs/codebase_map.json: missing ${path} (feeds the "${metric}" statistic)`);
    }
  }

  if (!Array.isArray(codebaseMap.modules) || codebaseMap.modules.length === 0) {
    issues.push('docs/codebase_map.json: modules[] is empty — cannot verify the admitted-proof count');
  }

  return issues;
}

export function theoremCountFromCodebaseMap(codebaseMap) {
  const map = codebaseMap && typeof codebaseMap === 'object' ? codebaseMap : null;
  if (!map) return 0;

  const countTheoremDeclarations = (declarations) => {
    if (!Array.isArray(declarations)) return 0;

    let total = 0;
    for (const declaration of declarations) {
      const kind = String(declaration?.kind ?? '').toLowerCase();
      if (kind === 'theorem' || kind === 'lemma') total += 1;
    }

    return total;
  };

  const countTheoremSymbols = (symbols) => {
    if (!symbols || typeof symbols !== 'object') return 0;

    const theoremEntries = Array.isArray(symbols.theorems) ? symbols.theorems.length : 0;
    if (theoremEntries > 0) return theoremEntries;

    const byKindTheorems = Array.isArray(symbols.byKind?.theorem) ? symbols.byKind.theorem.length : 0;
    const byKindLemmas = Array.isArray(symbols.byKind?.lemma) ? symbols.byKind.lemma.length : 0;
    return byKindTheorems + byKindLemmas;
  };

  const countModuleTheorems = (moduleLike) => {
    if (!moduleLike || typeof moduleLike !== 'object') return 0;

    const fromDeclarations = countTheoremDeclarations(moduleLike.declarations);
    if (fromDeclarations > 0) return fromDeclarations;

    const fromSymbols = countTheoremSymbols(moduleLike.symbols);
    if (fromSymbols > 0) return fromSymbols;

    const explicit = Number(moduleLike.theorems ?? moduleLike.theoremCount ?? moduleLike.stats?.theorems);
    return Number.isFinite(explicit) && explicit > 0 ? explicit : 0;
  };

  let total = 0;
  const counted = new Set();

  if (Array.isArray(map.modules)) {
    for (const moduleInfo of map.modules) {
      total += countModuleTheorems(moduleInfo);
      if (moduleInfo && moduleInfo.name) counted.add(moduleInfo.name);
    }
  }

  if (map.moduleMeta && typeof map.moduleMeta === 'object') {
    for (const [name, moduleInfo] of Object.entries(map.moduleMeta)) {
      if (counted.has(name)) continue;
      total += countModuleTheorems(moduleInfo);
    }
  }

  if (total > 0) return total;

  const topLevel = Number(map.theorems);
  if (Number.isFinite(topLevel) && topLevel > 0) return topLevel;

  const statsTheorems = Number(map.stats?.theorems);
  return Number.isFinite(statsTheorems) && statsTheorems > 0 ? statsTheorems : 0;
}

/**
 * Count admitted proofs recorded by the canonical artifact.
 *
 * Two declaration shapes qualify: an `axiom` (a proposition asserted rather
 * than proved) and any declaration whose extracted call list reaches `sorry`
 * or `sorryAx`. Both are recorded per declaration under
 * `modules[].declarations`, which turns the hero's "Admitted Proofs" tile from
 * a hand-written `0` into a figure the artifact actually supports.
 *
 * Returns `undefined` when the map carries no declaration inventory — an
 * absent inventory is not evidence of zero, and the caller must not publish
 * one as if it were.
 */
export function admittedCountFromCodebaseMap(codebaseMap) {
  const map = codebaseMap && typeof codebaseMap === 'object' ? codebaseMap : null;
  if (!map || !Array.isArray(map.modules) || map.modules.length === 0) return undefined;

  let admitted = 0;
  let sawDeclarations = false;

  for (const moduleInfo of map.modules) {
    const declarations = moduleInfo?.declarations;
    if (!Array.isArray(declarations)) continue;
    sawDeclarations = true;

    for (const declaration of declarations) {
      if (String(declaration?.kind ?? '').toLowerCase() === 'axiom') {
        admitted += 1;
        continue;
      }

      const called = declaration?.called;
      if (!Array.isArray(called)) continue;
      if (called.some((name) => /^sorry(?:Ax)?$/.test(String(name ?? '')))) admitted += 1;
    }
  }

  return sawDeclarations ? admitted : undefined;
}

function positiveInteger(value) {
  const number = typeof value === 'string' ? Number(value.replace(/,/g, '')) : Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function firstInteger(...values) {
  for (const value of values) {
    const parsed = positiveInteger(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * Project the landing page's statistics from the canonical codebase map.
 *
 * Returns only the metrics the artifact supports; a caller that needs a
 * complete set must check `canonicalMetricsIssues()` first rather than filling
 * gaps from elsewhere.
 */
export function siteMetricsFromCodebaseMap(codebaseMap) {
  const map = codebaseMap && typeof codebaseMap === 'object' ? codebaseMap : null;
  if (!map) return {};

  const sync = map.readme_sync && typeof map.readme_sync === 'object' ? map.readme_sync : {};
  const summary = map.summary && typeof map.summary === 'object' ? map.summary : {};
  const metrics = {};

  if (typeof sync.version === 'string' && sync.version.trim()) metrics.version = sync.version.trim();

  // `lean_toolchain` carries the toolchain tag ("v4.28.0"); the page renders a
  // bare version after the word "Lean".
  const toolchain = [sync.lean_toolchain, sync.lean_version].find((value) => typeof value === 'string' && value.trim());
  if (toolchain) metrics.leanVersion = toolchain.trim().replace(/^v/i, '');

  const lines = firstInteger(sync.production_loc);
  if (lines !== undefined) metrics.lines = lines;

  // The artifact's own tally wins. theoremCountFromCodebaseMap measures a
  // different thing — structured `kind` over every module, tests included —
  // and stands in only for a map that predates `proved_theorem_lemma_decls`.
  const theorems = firstInteger(sync.proved_theorem_lemma_decls);
  if (theorems !== undefined) {
    metrics.theorems = theorems;
  } else {
    const scanned = theoremCountFromCodebaseMap(map);
    if (scanned > 0) metrics.theorems = scanned;
  }

  // production_files is the production-scoped count the other two headline
  // figures share; summary.module_count (which includes tests/) is the
  // same-artifact stand-in, and canonicalMetricsIssues flags the substitution.
  const modules = firstInteger(sync.production_files, summary.module_count);
  if (modules !== undefined) metrics.modules = modules;

  const admitted = admittedCountFromCodebaseMap(map);
  if (admitted !== undefined) metrics.admitted = admitted;

  return metrics;
}

/**
 * Extract the provenance of a canonical map: which commit the statistics were
 * measured at, and when. Kept separate from the metrics so a snapshot always
 * records the artifact revision it came from — `commitSha` names the commit
 * the map was generated at, not whatever happens to be at the tip of `main`.
 */
export function canonicalProvenance(codebaseMap) {
  const map = codebaseMap && typeof codebaseMap === 'object' ? codebaseMap : null;
  if (!map) return {};

  const head = map.repository?.head;
  const provenance = {};

  if (typeof map.schema_version === 'string' && map.schema_version.trim()) {
    provenance.schemaVersion = map.schema_version.trim();
  }

  if (typeof head?.commit_sha === 'string' && /^[0-9a-f]{7,40}$/i.test(head.commit_sha)) {
    provenance.commitSha = head.commit_sha.slice(0, 7);
  }

  // The generator writes an offset timestamp ("+00:00"); the site's schema and
  // the <time datetime> attribute both want a `Z`-suffixed instant.
  const committedAt = Date.parse(head?.committed_at_utc ?? '');
  if (!Number.isNaN(committedAt)) provenance.updatedAt = new Date(committedAt).toISOString();

  const digest = map.source_sync?.source_digest;
  if (typeof digest === 'string' && /^[0-9a-f]{64}$/i.test(digest)) provenance.sourceDigest = digest;

  return provenance;
}
