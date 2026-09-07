/**
 * Static fallback synchronization for the landing page and its translations.
 *
 * Each live metric is embedded more than once: as a `data-live` span in
 * index.html (what a visitor sees before JS hydrates, or with JS disabled), in
 * the JSON-LD block that feeds search snippets, and again inside the
 * translated HTML of every locale file — `data-i18n-html` replaces an
 * element's innerHTML wholesale, so each locale carries its own copy of the
 * spans and the numbers inside them.
 *
 * Every one of those copies must mirror data/site-data.json. When they drift,
 * the wrong number is what a visitor actually reads: locale strings once said
 * "546 build jobs" while index.html said 574, and a reader who switched
 * language saw the stale figure. This module is the single place that mapping
 * lives; the sync workflow and local tooling both call it.
 */

/** data/site-data.json key → data-live attribute key. */
const LIVE_KEYS = Object.freeze({
  version: 'version',
  leanVersion: 'lean-version',
  theorems: 'theorems',
  modules: 'modules',
  scripts: 'scripts',
  docs: 'docs',
  lines: 'lines',
  // Derived from the artifact (axiom declarations plus anything reaching
  // sorry), so it is no longer the constant it used to be. Left unstamped, a
  // no-JS view would keep claiming zero admitted proofs on the day it isn't.
  admitted: 'admitted'
});

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function escapeReplacement(value) {
  return String(value).replace(/\$/g, '$$$$');
}

/**
 * Render a metric exactly as assets/js/site.js renders it.
 *
 * Counts are published as numbers and grouped here; `lines` is published
 * pre-grouped as a string and passes through. The two renderings must agree
 * character for character — otherwise hydration rewrites the figure in front
 * of the reader, which is how "11000" would flicker to "11,000" on load.
 */
function renderValue(value) {
  if (typeof value !== 'number') return String(value);
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Rewrite `<span data-live="key">…</span>` bodies in any text surface.
 *
 * The attribute quotes are matched as either bare `"` (HTML) or `\"` (a string
 * value inside a JSON locale file), so one substitution serves both without
 * having to parse and re-serialize the JSON.
 */
function replaceLiveValues(text, data) {
  let out = text;

  for (const [dataKey, liveKey] of Object.entries(LIVE_KEYS)) {
    const value = data[dataKey];
    if (!hasValue(value)) continue;
    out = out.replace(
      new RegExp(`(data-live=(?:"|\\\\")${liveKey}(?:"|\\\\")>)[^<]*(<)`, 'g'),
      `$1${escapeReplacement(renderValue(value))}$2`
    );
  }

  return out;
}

/**
 * Rewrite the static fallback values in an index.html string from a
 * site-data.json object. Pure string → string; missing data keys leave the
 * existing markup untouched.
 */
export function applyStaticValues(html, data) {
  if (typeof html !== 'string') throw new TypeError('html must be a string');
  if (!data || typeof data !== 'object') return html;

  let out = replaceLiveValues(html, data);

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

/**
 * Rewrite the metric literals baked into a locale JSON file's translated HTML.
 *
 * Deliberately narrower than applyStaticValues: only the `data-live` span
 * bodies are touched. The JSON-LD and `<time datetime>` rules are index.html's
 * alone and must not be let loose on translator-authored text.
 */
export function applyLocaleStaticValues(json, data) {
  if (typeof json !== 'string') throw new TypeError('json must be a string');
  if (!data || typeof data !== 'object') return json;
  return replaceLiveValues(json, data);
}
