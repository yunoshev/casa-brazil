// Equivalent of the public country-city ordering regression.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../site/v2/app.js', import.meta.url), 'utf8');
const start = app.indexOf('function cityOrder(');
const end = app.indexOf('\nfunction cityList(', start);
assert.ok(start >= 0 && end > start, 'city ordering helper must remain shipped');
const cities = [
  { slug: 'sao-paulo-sp', nome: 'São Paulo', stats: { below: 6, reliable: 116 }, measured: true },
  { slug: 'fortaleza-ce', nome: 'Fortaleza', stats: { below: 0, reliable: 11 }, measured: true },
  { slug: 'recife-pe', nome: 'Recife', stats: { below: 0, reliable: 0 }, measured: true },
  { slug: 'rio-de-janeiro-rj', nome: 'Rio de Janeiro', stats: { below: 153, reliable: 284 }, measured: true },
  { slug: 'sao-goncalo-rj', nome: 'São Gonçalo', stats: { below: 18, reliable: 43 }, measured: true },
  { slug: 'market-only', nome: 'Market only', stats: { below: 9, reliable: 10 }, measured: false },
];
const context = vm.createContext({ D: { cities }, marketOnly: c => !c.measured });
vm.runInContext(app.slice(start, end), context);
assert.deepEqual(context.cityOrder(cities[0]).map(c => c.slug), [
  'sao-paulo-sp', 'fortaleza-ce', 'recife-pe', 'rio-de-janeiro-rj', 'sao-goncalo-rj', 'market-only',
]);
assert.deepEqual(context.homeMeasuredCityOrder().map(c => c.slug), [
  'rio-de-janeiro-rj', 'sao-goncalo-rj', 'sao-paulo-sp', 'fortaleza-ce',
]);
assert.deepEqual(cities.filter(c => !context.homeMeasuredCityOrder().includes(c)).map(c => c.slug), [
  'recife-pe', 'market-only',
]);
context.D.cities = [
  { slug: 'beta', nome: 'Beta', stats: { below: 5, reliable: 10 }, measured: true },
  { slug: 'alpha-b', nome: 'Alpha', stats: { below: 5, reliable: 10 }, measured: true },
  { slug: 'zeta-large', nome: 'Zeta', stats: { below: 10, reliable: 20 }, measured: true },
  { slug: 'alpha-a', nome: 'Alpha', stats: { below: 5, reliable: 10 }, measured: true },
];
assert.deepEqual(context.homeMeasuredCityOrder().map(c => c.slug), [
  'zeta-large', 'alpha-a', 'alpha-b', 'beta',
]);
console.log('country city order: evidence ranking is independent from the São Paulo default and quiet cities');
