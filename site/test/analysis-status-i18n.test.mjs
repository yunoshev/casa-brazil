import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const locales = ['en', 'pt', 'ru'];
const states = ['queued', 'fetching', 'analyzing', 'ready', 'unavailable'];

for (const locale of locales) {
  test(`${locale} ships every analysis status translation`, () => {
    const catalog = JSON.parse(readFileSync(new URL(`../i18n/${locale}.json`, import.meta.url), 'utf8'));
    for (const state of states) {
      const key = `az.status.${state}`;
      assert.equal(typeof catalog[key], 'string', `${locale} missing ${key}`);
      assert.ok(catalog[key].trim(), `${locale} has empty ${key}`);
      assert.notEqual(catalog[key], key, `${locale} left ${key} untranslated`);
    }
  });
}
