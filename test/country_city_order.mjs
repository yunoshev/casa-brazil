import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../site/v2/app.js', import.meta.url), 'utf8');
assert.ok(
  app.includes('countryCityOrder(D.cities.filter(function (c) { return !marketOnly(c); })).map(cityRow)'),
  'country homepage must keep market-only cities out of the main row list'
);

/* Load the actual pure comparator from the application, with only the current
 * city fixtures it needs.  This proves the homepage order without rendering
 * the picker or changing any live values. */
const start = app.indexOf('function countryCityRank(');
const end = app.indexOf('\nfunction cityList(', start);
assert.ok(start >= 0 && end > start, 'country city ordering helpers must exist');
const context = {};
vm.runInNewContext(app.slice(start, end), context, { filename: 'app.js' });

const cities = [
  { nome: 'Fortaleza', stats: { reliable: 10, below: 1 } },
  { nome: 'São Paulo', stats: { reliable: 10, below: 2 } },
  { nome: 'Recife', stats: { reliable: 0, below: 0 } },
  { nome: 'São Gonçalo', stats: { reliable: 10, below: 7 } },
  { nome: 'Rio de Janeiro', stats: { reliable: 10, below: 8 } },
];
const ordered = context.countryCityOrder(cities).map(c => c.nome);
assert.deepEqual(ordered, ['Rio de Janeiro', 'São Gonçalo', 'Recife', 'São Paulo', 'Fortaleza']);
console.log('country city order:', ordered.join(' → '));
