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
import { readFile, readdir } from 'node:fs/promises';

const PAGES = ['index.html', 'map.html', 'run.html', '404.html'];
const ROOT = new URL('../../', import.meta.url);

// An HTML `style` attribute: whitespace-delimited so it never matches
// `data-style`, `style-src` (CSP directive), or a CSS file reference.
const INLINE_STYLE_ATTR = /\sstyle\s*=\s*["']/g;

/* The landing page and the code map render bundled snapshots only (see
   "Runtime data strategy" in CLAUDE.md). connect-src 'self' is what keeps a
   second data source from creeping back: the code map used to download the
   upstream artifact and hundreds of Lean files on every visit, and replaced
   the bundled graph with an edgeless one from another commit. */
const SELF_ONLY_CONNECT = ['index.html', 'map.html', 'run.html', '404.html'];

function cspOf(html) {
  const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  return match ? match[1] : '';
}

for (const page of SELF_ONLY_CONNECT) {
  test(`${page} pins connect-src to 'self'`, async () => {
    const html = await readFile(new URL(page, ROOT), 'utf8');
    const csp = cspOf(html);
    assert.ok(csp, `${page} should carry a Content-Security-Policy meta tag`);
    const directive = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('connect-src'));
    assert.equal(directive, "connect-src 'self'", `${page} connect-src should be exactly 'self', got: ${directive}`);
  });
}

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

/* Every link that opens a new tab carries rel="noopener noreferrer" in the
   markup itself. The pages used to patch rel at runtime, three copies of one
   function, which only covered what had rendered by then and hid an
   unhardened link from review. The locales count too: data-i18n-html writes
   their links into the page verbatim. */
test('every target="_blank" link is hardened in the markup and the locales', async () => {
  const sources = PAGES.map((page) => [page, new URL(page, ROOT)]);
  for (const name of await readdir(new URL('locales/', ROOT))) {
    if (name.endsWith('.json')) sources.push([`locales/${name}`, new URL(`locales/${name}`, ROOT)]);
  }
  for (const [label, url] of sources) {
    const text = (await readFile(url, 'utf8')).replace(/\\"/g, '"');
    for (const tag of text.match(/<a\s[^>]*>/g) || []) {
      if (!/target="_blank"/.test(tag)) continue;
      assert.match(tag, /rel="noopener noreferrer"/, `${label}: ${tag}`);
    }
  }
});
