/**
 * Contrast of the design tokens, computed from assets/css/style.css.
 *
 * Every page takes its text and fill colours from the two token blocks at the
 * top of the stylesheet, so a pair that fails there fails everywhere it is
 * used. Three did: light-theme muted text, accent and green sat at 4.0-4.4:1
 * on the tinted surfaces they are read on (they pass on white, which is the
 * only surface anyone checks by eye), and `--on-accent` was white in the dark
 * theme, where the accent is a light blue: 2.7:1.
 *
 * WCAG 2.x relative luminance; 4.5:1 is the AA bound for body-size text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../../assets/css/style.css', import.meta.url), 'utf8');

function tokens(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} block`);
  const block = css.slice(start, css.indexOf('\n}', start));
  const out = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)) out[m[1]] = m[2];
  return out;
}

function luminance(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` at `share` over `bg`, the way a translucent wash is painted. */
function mix(fg, bg, share) {
  const parts = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [f, g] = [parts(fg), parts(bg)];
  return `#${f.map((v, i) => Math.round(v * share + g[i] * (1 - share)).toString(16).padStart(2, '0')).join('')}`;
}

const dark = tokens(':root');
const light = { ...dark, ...tokens('[data-theme="light"]') };

for (const [name, t] of [['dark', dark], ['light', light]]) {
  const surfaces = ['--bg', '--bg-alt', '--surface', '--surface-2'];

  test(`${name}: text, muted text and the accent are readable on every surface`, () => {
    for (const text of ['--text', '--text-muted', '--text-bright', '--heading', '--accent', '--green']) {
      for (const surface of surfaces) {
        const ratio = contrast(t[text], t[surface]);
        assert.ok(ratio >= 4.5, `${text} ${t[text]} on ${surface} ${t[surface]} is ${ratio.toFixed(2)}:1`);
      }
    }
  });

  test(`${name}: the accent and the green are readable on their own washes`, () => {
    // An active tab, a badge, a status chip: the colour as text on a surface
    // tinted with the same colour. The stylesheets wash with up to 14% of the
    // accent (an active scene tab) and 12% of the green (a running thread).
    for (const [colour, share] of [['--accent', 0.14], ['--green', 0.12]]) {
      for (const surface of ['--surface', '--surface-2', '--bg-alt']) {
        const wash = mix(t[colour], t[surface], share);
        const ratio = contrast(t[colour], wash);
        assert.ok(ratio >= 4.5, `${colour} ${t[colour]} on a ${Math.round(share * 100)}% wash over ${surface} (${wash}) is ${ratio.toFixed(2)}:1`);
      }
    }
  });

  test(`${name}: text on a filled control is readable on every fill`, () => {
    for (const fill of ['--accent', '--accent-dim', '--green', '--yellow', '--red', '--purple']) {
      const ratio = contrast(t['--on-accent'], t[fill]);
      assert.ok(ratio >= 4.5, `--on-accent ${t['--on-accent']} on ${fill} ${t[fill]} is ${ratio.toFixed(2)}:1`);
    }
    // .btn-primary and the nav's call to action put --bg on the accent.
    assert.ok(contrast(t['--bg'], t['--accent']) >= 4.5, `--bg on --accent is ${contrast(t['--bg'], t['--accent']).toFixed(2)}:1`);
  });
}
