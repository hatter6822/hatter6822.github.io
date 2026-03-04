export function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function countTheorems(text) {
  const m = text.match(/(?:^|\n)\s*(?:private\s+|protected\s+)?theorem\s+/g);
  return m ? m.length : 0;
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
