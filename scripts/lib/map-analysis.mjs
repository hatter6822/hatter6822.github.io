export function moduleFromPath(path) {
  return path.replace(/\.lean$/, '').replace(/\//g, '.');
}

export function classifyLayer(moduleName) {
  if (/\.Model\./.test(moduleName)) return 'model';
  if (/\.Kernel\./.test(moduleName)) return 'kernel';
  if (/\.Security\./.test(moduleName) || /\.IFC\./.test(moduleName)) return 'security';
  if (/\.Platform\./.test(moduleName) || /\.Hardware\./.test(moduleName)) return 'platform';
  return 'other';
}

export function moduleKind(moduleName) {
  if (/\.Operations$/.test(moduleName)) return 'operations';
  if (/\.Invariant$/.test(moduleName)) return 'invariant';
  return 'other';
}

export function moduleBase(moduleName) {
  return moduleName.replace(/\.(Operations|Invariant)$/, '');
}

export function theoremCount(text) {
  const matches = text.match(/^\s*(?:private\s+|protected\s+)?(?:theorem|lemma)\s+[\w'.`]+/gm);
  return matches ? matches.length : 0;
}

export function normalizeSymbolName(name) {
  return String(name || '').replace(/`/g, '').trim();
}

export function extractInteriorCodeItems(sourceText) {
  const attrPrefix = '(?:@\\[[^\\]]+\\]\\s+|@[\\w.]+\\s+)*';
  const theoremPattern = new RegExp("^\\s*" + attrPrefix + "(?:private\\s+|protected\\s+)?(?:theorem|lemma)\\s+([\\w'.`]+)", "gm");
  const functionPattern = new RegExp("^\\s*" + attrPrefix + "(?:private\\s+|protected\\s+)?(?:noncomputable\\s+)?(?:def|abbrev|opaque)\\s+([\\w'.`]+)", "gm");
  const instancePattern = new RegExp("^\\s*" + attrPrefix + "(?:private\\s+|protected\\s+)?(?:noncomputable\\s+)?instance\\s+([\\w'.`]+)", "gm");
  const seenTheorems = Object.create(null);
  const seenFunctions = Object.create(null);
  const theorems = [];
  const functions = [];

  let match;
  while ((match = theoremPattern.exec(sourceText)) !== null) {
    const theoremName = normalizeSymbolName(match[1]);
    if (!theoremName || seenTheorems[theoremName]) continue;
    seenTheorems[theoremName] = true;
    theorems.push(theoremName);
  }

  while ((match = functionPattern.exec(sourceText)) !== null) {
    const functionName = normalizeSymbolName(match[1]);
    if (!functionName || seenFunctions[functionName]) continue;
    seenFunctions[functionName] = true;
    functions.push(functionName);
  }

  while ((match = instancePattern.exec(sourceText)) !== null) {
    const instanceName = normalizeSymbolName(match[1]);
    if (!instanceName || seenFunctions[instanceName]) continue;
    seenFunctions[instanceName] = true;
    functions.push(instanceName);
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
  const lines = sourceText.split(/\r?\n/);

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
