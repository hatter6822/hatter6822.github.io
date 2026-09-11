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
 *
 * The same applies to the line anchors on the page's deep links into the
 * kernel tree: see source-anchors.mjs, which resolves them, and which this
 * module applies to both surfaces alongside the metrics.
 */
import { applySourceAnchors } from './source-anchors.mjs';

/** data/site-data.json key → data-live attribute key. */
const LIVE_KEYS = Object.freeze({
  version: 'version',
  leanVersion: 'lean-version',
  theorems: 'theorems',
  modules: 'modules',
  scripts: 'scripts',
  docs: 'docs',
  lines: 'lines',
  // Counted off the verified Lean sources rather than retyped into prose. Both
  // were hand-maintained until 0.32.0 and both were wrong: the page said 30
  // syscalls against a surface of 35, and 17 `@[extern]` functions against 73.
  syscalls: 'syscalls',
  externs: 'externs',
  // The security card's two specific claims, each read from the kernel rather
  // than restated: the arity of `NonInterferenceStep` (one proof per step),
  // the cross-core theorems beside it, and the enforcement-boundary tables,
  // whose sizes the kernel proves by `rfl`. The page quoted 80, 25 and 38
  // against 35, 35 and 44.
  niSteps: 'ni-steps',
  niCrossCore: 'ni-cross-core',
  enforcementOps: 'enforcement-ops',
  enforcementOpsPerCore: 'enforcement-ops-per-core',
  // Derived from the artifact (axiom declarations plus anything reaching
  // sorry), so it is no longer the constant it used to be. Left unstamped, a
  // no-JS view would keep claiming zero admitted proofs on the day it isn't.
  admitted: 'admitted'
});

/**
 * Per-subsystem figures, addressed as `subsystem.<key>.<field>`.
 *
 * The architecture diagram labels each layer with its module and theorem
 * counts. Those were typed into the markup until 0.32.0, and ten of the twelve
 * had gone stale — the scheduler read 46 modules against 49, information flow
 * 801 theorems against 1,680. They are projected from the canonical artifact
 * now; the `data-live` key names the subsystem so the markup still reads as
 * itself. `scripts/lib/canonical-map.mjs` owns which subsystems exist.
 */
const SUBSYSTEM_FIELDS = Object.freeze(['modules', 'theorems']);

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

/** A live key is interpolated into a RegExp; the dots in `subsystem.ipc.modules` are literal. */
function escapeAttribute(key) {
  return String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  const keyed = Object.entries(LIVE_KEYS).map(([dataKey, liveKey]) => [liveKey, data[dataKey]]);

  for (const [key, entry] of Object.entries(data?.subsystems ?? {})) {
    for (const field of SUBSYSTEM_FIELDS) keyed.push([`subsystem.${key}.${field}`, entry?.[field]]);
  }

  for (const [liveKey, value] of keyed) {
    if (!hasValue(value)) continue;
    out = out.replace(
      new RegExp(`(data-live=(?:"|\\\\")${escapeAttribute(liveKey)}(?:"|\\\\")>)[^<]*(<)`, 'g'),
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

  let out = applySourceAnchors(replaceLiveValues(html, data), data.sourceAnchors, data.sourceAnchorRef);

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
 * bodies and the line anchors are touched. The JSON-LD and `<time datetime>`
 * rules are index.html's alone and must not be let loose on
 * translator-authored text.
 *
 * The anchors belong on both surfaces: a locale carries its own copy of every
 * link, so a line number left unstamped here sends a reader who switched
 * language to a line the English page stopped pointing at.
 */
export function applyLocaleStaticValues(json, data) {
  if (typeof json !== 'string') throw new TypeError('json must be a string');
  if (!data || typeof data !== 'object') return json;
  return applySourceAnchors(replaceLiveValues(json, data), data.sourceAnchors, data.sourceAnchorRef);
}
