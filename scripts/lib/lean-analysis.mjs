export function normalizeSymbolName(name) {
  return String(name || '').replace(/`/g, '').trim();
}

export function theoremCount(text) {
  const matches = String(text || '').match(/^\s*(?:@[\w.]+\s+)*(?:private\s+|protected\s+)?(?:theorem|lemma)\s+[\w'.`]+/gm);
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
  const theoremPattern = /^\s*(?:@[\w.]+\s+)*(?:private\s+|protected\s+)?(?:theorem|lemma)\s+([\w'.`]+)/gm;
  const functionPattern = /^\s*(?:@[\w.]+\s+)*(?:private\s+|protected\s+)?(?:noncomputable\s+)?(?:def|abbrev|opaque)\s+([\w'.`]+)/gm;
  const instancePattern = /^\s*(?:@[\w.]+\s+)*(?:private\s+|protected\s+)?(?:noncomputable\s+)?instance\s+([\w'.`]+)/gm;
  const seenTheorems = Object.create(null);
  const seenFunctions = Object.create(null);
  const theorems = [];
  const functions = [];
  const lineNumberForIndex = createLineLocator(sourceText);

  let match;
  while ((match = theoremPattern.exec(sourceText)) !== null) {
    const theoremName = normalizeSymbolName(match[1]);
    if (!theoremName || seenTheorems[theoremName]) continue;
    seenTheorems[theoremName] = true;
    theorems.push({ name: theoremName, line: declarationLineFromMatch(match, lineNumberForIndex) });
  }

  while ((match = functionPattern.exec(sourceText)) !== null) {
    const functionName = normalizeSymbolName(match[1]);
    if (!functionName || seenFunctions[functionName]) continue;
    seenFunctions[functionName] = true;
    functions.push({ name: functionName, line: declarationLineFromMatch(match, lineNumberForIndex) });
  }

  while ((match = instancePattern.exec(sourceText)) !== null) {
    const instanceName = normalizeSymbolName(match[1]);
    if (!instanceName || seenFunctions[instanceName]) continue;
    seenFunctions[instanceName] = true;
    functions.push({ name: instanceName, line: declarationLineFromMatch(match, lineNumberForIndex) });
  }

  return { theorems, functions };
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

export function parseCurrentStateMetrics(readmeText) {
  if (!readmeText) return {};

  const metrics = {};
  const rows = readmeText.split(/\r?\n/);

  for (const row of rows) {
    const cells = row.split('|').map((cell) => cell.trim());
    if (cells.length < 3) continue;

    const metric = cells[1]?.toLowerCase() ?? '';
    const value = cells[2] ?? '';

    if (metric.includes('version')) {
      const version = value.match(/\d+\.\d+\.\d+/);
      if (version) metrics.version = version[0];
    }

    if (metric.includes('production loc')) {
      const loc = value.match(/\d[\d,]*/);
      if (loc) metrics.lines = loc[0];
    }

    if (metric.includes('theorem')) {
      const theoremMatch = value.match(/\d[\d,]*/);
      if (theoremMatch) metrics.theorems = Number(theoremMatch[0].replace(/,/g, ''));
    }

    if (metric.includes('build job')) {
      const buildJobsMatch = value.match(/\d[\d,]*/);
      if (buildJobsMatch) metrics.buildJobs = Number(buildJobsMatch[0].replace(/,/g, ''));
    }
  }

  return metrics;
}
