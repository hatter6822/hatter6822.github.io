/**
 * Static fallback synchronization for index.html.
 *
 * The landing page embeds each live metric twice: once as a `data-live` span
 * fallback (shown before JS hydrates, or with JS disabled) and once in the
 * JSON-LD block. Both must mirror data/site-data.json or the no-JS view and
 * search snippets drift from the bundled snapshot. This module is the single
 * place that mapping lives; the sync workflow and local tooling both call it.
 */

/** data/site-data.json key → data-live attribute key. */
const LIVE_KEYS = Object.freeze({
  version: 'version',
  leanVersion: 'lean-version',
  theorems: 'theorems',
  modules: 'modules',
  scripts: 'scripts',
  docs: 'docs',
  buildJobs: 'build-jobs',
  lines: 'lines'
});

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function escapeReplacement(value) {
  return String(value).replace(/\$/g, '$$$$');
}

/**
 * Rewrite the static fallback values in an index.html string from a
 * site-data.json object. Pure string → string; missing data keys leave the
 * existing markup untouched.
 */
export function applyStaticValues(html, data) {
  if (typeof html !== 'string') throw new TypeError('html must be a string');
  if (!data || typeof data !== 'object') return html;

  let out = html;

  for (const [dataKey, liveKey] of Object.entries(LIVE_KEYS)) {
    const value = data[dataKey];
    if (!hasValue(value)) continue;
    out = out.replace(
      new RegExp(`(data-live="${liveKey}">)[^<]*(<)`, 'g'),
      `$1${escapeReplacement(value)}$2`
    );
  }

  if (hasValue(data.version)) {
    out = out.replace(/("version":\s*")[^"]*(")/g, `$1${escapeReplacement(data.version)}$2`);
  }

  if (hasValue(data.updatedAt)) {
    out = out.replace(
      /(data-live="updated-at" datetime=")[^"]*(")/g,
      `$1${escapeReplacement(data.updatedAt)}$2`
    );
  }

  return out;
}
