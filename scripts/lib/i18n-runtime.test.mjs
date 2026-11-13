/**
 * Boots the real `assets/js/i18n.js` in a `vm` DOM shim and exercises `t()`:
 * `{{name}}` interpolation, CLDR plural forms chosen by `vars.count`, and
 * locale-aware digit grouping — the behaviour every count label on the code
 * map relies on ("1 file", "2 files", "10 929 файлів").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

/** Load i18n.js with `strings` served synchronously from a fixture object. */
async function loadI18n(locale, strings) {
  const source = await fs.readFile(path.join(repoRoot, 'assets/js/i18n.js'), 'utf8');
  const noop = () => {};
  const element = { lang: '', setAttribute: noop, getAttribute: () => null, addEventListener: noop, textContent: '', innerHTML: '' };
  const context = {
    console, Intl, setTimeout, clearTimeout, URL, URLSearchParams,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    location: { search: '', pathname: '/', href: 'http://localhost/' },
    navigator: { language: locale, languages: [locale] },
    localStorage: { getItem: () => locale, setItem: noop, removeItem: noop },
    XMLHttpRequest: function XMLHttpRequest() {
      this.open = noop;
      this.setRequestHeader = noop;
      this.send = () => { this.status = 200; this.response = strings; if (this.onload) this.onload(); };
    },
    document: {
      documentElement: element,
      readyState: 'complete',
      title: '',
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener: noop
    }
  };
  context.window = { addEventListener: noop, dispatchEvent: noop, location: context.location, document: context.document };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'assets/js/i18n.js' });
  assert.ok(context.window.sele4nI18n, 'window.sele4nI18n exported');
  return context.window.sele4nI18n;
}

const FIXTURE = {
  demo: {
    plain: 'Hello {{name}}',
    files_one: '{{count}} file',
    files_other: '{{count}} files',
    modules_one: '{{count}} модуль',
    modules_few: '{{count}} модулі',
    modules_many: '{{count}} модулів',
    modules_other: '{{count}} модуля',
    things: '{{count}} things'
  }
};

test('t() interpolates and returns the key when nothing matches', async () => {
  const i18n = await loadI18n('en', FIXTURE);
  assert.equal(i18n.locale(), 'en');
  assert.equal(i18n.t('demo.plain', { name: 'seLe4n' }), 'Hello seLe4n');
  assert.equal(i18n.t('demo.missing'), 'demo.missing');
});

test('t() picks the English plural form from vars.count', async () => {
  const i18n = await loadI18n('en', FIXTURE);
  assert.equal(i18n.t('demo.files', { count: 1 }), '1 file');
  assert.equal(i18n.t('demo.files', { count: 0 }), '0 files');
  assert.equal(i18n.t('demo.files', { count: 866 }), '866 files');
  assert.equal(i18n.t('demo.things', { count: 1 }), '1 things', 'a key without variants resolves as before');
  assert.equal(i18n.pluralCategory(1), 'one');
  assert.equal(i18n.pluralCategory(2), 'other');
});

test('t() picks the Ukrainian one/few/many forms and groups digits the Ukrainian way', async () => {
  const i18n = await loadI18n('uk', FIXTURE);
  assert.equal(i18n.t('demo.modules', { count: 1 }), '1 модуль');
  assert.equal(i18n.t('demo.modules', { count: 3 }), '3 модулі');
  assert.equal(i18n.t('demo.modules', { count: 11 }), '11 модулів');
  assert.equal(i18n.t('demo.modules', { count: 303 }), '303 модулі');
  assert.equal(i18n.t('demo.modules', { count: 1.5 }), '1,5 модуля', 'fractions take the "other" form');
  const grouped = i18n.t('demo.modules', { count: 10929 });
  assert.match(grouped, /^10.929 модулів$/, `digits grouped by the locale: ${grouped}`);
  assert.equal(i18n.formatNumber(10929).replace(/\s/g, ' '), '10 929');
});

test('formatNumber follows the active locale', async () => {
  assert.equal((await loadI18n('en', FIXTURE)).formatNumber(325346), '325,346');
  assert.equal((await loadI18n('es', FIXTURE)).formatNumber(325346), '325.346');
  assert.equal((await loadI18n('ja', FIXTURE)).formatNumber(325346), '325,346');
});

test('the shipped English bundle resolves a real key through t()', async () => {
  const en = JSON.parse(await fs.readFile(path.join(repoRoot, 'locales/en.json'), 'utf8'));
  const i18n = await loadI18n('en', en);
  assert.equal(i18n.t('map.hero_title'), en.map.hero_title);
});

test('locale HTML is sanitized in an inert document, against a tag allowlist', async () => {
  // A <div> from the live document fetches an <img src> and runs its onerror
  // the moment innerHTML is assigned — before the allowlist walk can strip it.
  // A <template>'s content belongs to an inert document, which does neither.
  const source = await fs.readFile(path.join(repoRoot, 'assets/js/i18n.js'), 'utf8');
  const body = /function sanitizeToFragment\(raw\) \{([^]*?)\n {2}\}/.exec(source)?.[1] ?? '';
  assert.match(body, /createElement\("template"\)/, 'the sanitizer parses into a <template>');
  assert.doesNotMatch(body, /createElement\("div"\)/, 'the sanitizer must not parse into a live-document element');
  // The walked nodes are adopted as they are. Serializing them and assigning
  // the string to the target is a second parse, and a second parse is what
  // every mutation-XSS needs.
  assert.match(body, /return tmp;/, 'the sanitizer returns the nodes it walked');
  assert.doesNotMatch(body, /return [^;]*innerHTML/, 'the sanitizer must not hand back a string to be parsed again');
  assert.match(body, /namespaceURI !== XHTML_NS/, 'an allowed name counts only in the HTML namespace');
  // One HTML sink on the whole site: the template parse above. Every page
  // sends require-trusted-types-for 'script', so a second one would throw in
  // a browser — this says so before a browser is involved.
  const scripts = (await fs.readdir(path.join(repoRoot, 'assets/js'))).filter((name) => name.endsWith('.js'));
  const sinks = [];
  for (const name of scripts) {
    const text = await fs.readFile(path.join(repoRoot, 'assets/js', name), 'utf8');
    text.split('\n').forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/\.(innerHTML|outerHTML)\s*[+]?=[^=]|insertAdjacentHTML\s*\(|document\.write(ln)?\s*\(|\bDOMParser\b|createContextualFragment|\bsrcdoc\b|\beval\s*\(|new Function\s*\(|set(Timeout|Interval)\s*\(\s*["'`]/.test(code)) {
        sinks.push(`${name}:${index + 1}`);
      }
    });
  }
  assert.equal(sinks.length, 1, `exactly one HTML sink is expected, found: ${sinks.join(', ')}`);
  assert.match(sinks[0], /^i18n\.js:/);
  assert.equal((source.match(/createPolicy\(/g) || []).length, 1, 'one Trusted Types policy');
  assert.doesNotMatch(source, /window\.\w+\s*=\s*htmlPolicy|htmlPolicy\s*:/, 'the policy is not exported');

  const allow = /var SAFE_TAGS = \/\^\(([^)]*)\)\$\/i;/.exec(source)?.[1]?.split('|') ?? [];
  assert.ok(allow.length > 0, 'SAFE_TAGS is an anchored alternation');
  for (const tag of ['img', 'svg', 'script', 'iframe', 'object', 'style', 'template']) {
    assert.ok(!allow.includes(tag), `SAFE_TAGS must not allow <${tag}>`);
  }
  const fn = /function isSafeHref\(href\) \{([^]*?)\n {2}\}/.exec(source)?.[1];
  assert.ok(fn, 'sanitizeHTML checks hrefs through isSafeHref');
  const isSafeHref = new Function('href', fn);
  for (const ok of ['https://github.com/hatter6822/seLe4n', '/map.html', '#about', 'mailto:a@b.c']) assert.ok(isSafeHref(ok), `${ok} is kept`);
  for (const bad of ['javascript:alert(1)', '//evil.example', '/\\evil.example', 'data:text/html,x', 'ftp://x', '']) assert.ok(!isSafeHref(bad), `${bad || '(empty)'} is dropped`);
  // The URL parser removes tabs and newlines and trims leading controls, so
  // each of these is "//evil.example" or "javascript:" by the time it resolves.
  for (const bad of ['/\t/evil.example', '/\n/evil.example', ' //evil.example', '\u0001javascript:alert(1)', 'java\tscript:alert(1)', '/ok path']) {
    assert.ok(!isSafeHref(bad), `${JSON.stringify(bad)} is dropped`);
  }

  // Every link a shipped locale carries passes the same test, so the
  // sanitizer never has to drop one in production.
  for (const name of (await fs.readdir(path.join(repoRoot, 'locales'))).filter((n) => n.endsWith('.json'))) {
    const text = JSON.stringify(JSON.parse(await fs.readFile(path.join(repoRoot, 'locales', name), 'utf8')));
    for (const m of text.matchAll(/href=\\"([^"\\]*)\\"/g)) assert.ok(isSafeHref(m[1]), `${name}: ${m[1]}`);
  }
});
