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
