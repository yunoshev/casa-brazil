// Equivalent of the public lifecycle-i18n regression.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../site/v2/app.js', import.meta.url), 'utf8');
const required = [
  'archive.status.active', 'archive.status.unverified', 'archive.status.missing',
  'archive.status.archived', 'archive.inventory.notice', 'archive.active.notice',
  'archive.removal.notice', 'archive.date.last_seen', 'archive.date.checked',
  'archive.date.missing', 'archive.date.archived', 'archive.price.last',
  'archive.h1', 'archive.lede', 'archive.analysis.h2',
];
for (const lang of ['pt', 'en', 'ru']) {
  const catalog = JSON.parse(readFileSync(new URL(`../site/i18n/${lang}.json`, import.meta.url)));
  for (const key of required) assert.equal(typeof catalog[key], 'string', `${lang}:${key}`);
}
for (const marker of ['STATUS_KEY', 't("archive.inventory.notice"', 't("archive.date.last_seen"', 't("archive.analysis.h2"']) {
  assert.ok(app.includes(marker), `missing translated runtime marker ${marker}`);
}
assert.doesNotMatch(app, /Disponibilidade não confirmada|Registro histórico/);
console.log('lifecycle i18n: PT/EN/RU catalogues and runtime markers are present');
