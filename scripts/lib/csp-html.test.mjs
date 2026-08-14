/**
 * Static CSP-compliance guard for the HTML pages.
 *
 * Both pages ship a strict Content-Security-Policy with `style-src 'self'` and
 * no `'unsafe-inline'`. An inline `style="…"` attribute is therefore *blocked
 * at runtime* — the markup parses but the style never applies, silently
 * dropping whatever it was meant to set (this is exactly how the run.html
 * status-legend swatches once rendered colourless). Catch the whole class of
 * regression at build time instead of in a browser console.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const PAGES = ['index.html', 'map.html', 'run.html', '404.html'];
const ROOT = new URL('../../', import.meta.url);

// An HTML `style` attribute: whitespace-delimited so it never matches
// `data-style`, `style-src` (CSP directive), or a CSS file reference.
const INLINE_STYLE_ATTR = /\sstyle\s*=\s*["']/g;

for (const page of PAGES) {
  test(`${page} has no inline style attributes (CSP style-src 'self')`, async () => {
    const html = await readFile(new URL(page, ROOT), 'utf8');
    const hits = html.match(INLINE_STYLE_ATTR) || [];
    assert.equal(
      hits.length, 0,
      `${page} contains ${hits.length} inline style attribute(s); move them to a CSS class — ` +
      `the strict CSP blocks inline styles so they would never apply.`
    );
  });
}
