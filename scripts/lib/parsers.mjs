export function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
      const theoremCount = value.match(/\d[\d,]*/);
      if (theoremCount) metrics.theorems = Number(theoremCount[0].replace(/,/g, ''));
    }

    if (metric.includes('build job')) {
      const buildJobs = value.match(/\d[\d,]*/);
      if (buildJobs) metrics.buildJobs = Number(buildJobs[0].replace(/,/g, ''));
    }
  }

  return metrics;
}

export function countTheorems(text) {
  const m = text.match(/(?:^|\n)\s*(?:private\s+|protected\s+)?theorem\s+/g);
  return m ? m.length : 0;
}

export function moduleFromPath(path) {
  return path.replace(/\.lean$/, '').replace(/\//g, '.');
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

function isLikelyModuleToken(token) {
  return /^[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*$/.test(token || '');
}

function tokenizeImportSegment(segment) {
  const out = [];
  const raw = (segment || '').split(/[\s,]+/);
  for (const part of raw) {
    const candidate = (part || '').replace(/^[()]+|[()]+$/g, '').trim();
    if (!candidate || !isLikelyModuleToken(candidate)) continue;
    out.push(candidate);
  }
  return out;
}
