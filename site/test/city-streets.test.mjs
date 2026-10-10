import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../v2/app.js', import.meta.url), 'utf8');
const functions = source.split('/* ---- boot ')[0];
const cols = ['id', 'src', 'bairro', 'end', 'tipo', 'area', 'quartos', 'preco', 'hammer',
  'margin', 'mkt', 'aval', 'avalpct', 'n', 'ring', 'conf', 'jud', 'mod', 'data', 'link', 'promised', 'why'];

function street(name, slug, deals) {
  return { name, slug, bairro: 'CENTRO', f: [9000, deals] };
}

function fixture(count = 3) {
  const d = {
    R1: street('rua um', 'rua-um', 40),
    R2: street('rua dois', 'rua-dois', 120),
    R3: street('rua tres', 'rua-tres', 12),
    // Fewer than twelve deeds: the street page is noindex, so the city page must not spend a link on it.
    THIN: street('rua fina', 'rua-fina', 5),
  };
  for (let n = 0; n < count; n += 1) d[`X${n}`] = street(`rua extra ${n}`, `rua-extra-${n}`, 13);
  return {
    slug: 'rio-de-janeiro-rj', uf: 'rj', cslug: 'rio-de-janeiro', nome: 'Rio de Janeiro',
    cidade: 'RIO DE JANEIRO', stats: { lots: 0 }, chain: {}, market: {},
    shapes: { unit: 'district', nice: { CENTRO: 'Centro' }, d: { CENTRO: 'M0 0 10 0 10 10 0 10Z' },
      at: { CENTRO: [5, 5, 0, 0, 10, 10] }, of: {}, box: [0, 0, 10, 10], cols: 10, rows: 10 },
    streets: { year: 2024, d, by: { CENTRO: Object.keys(d) } }, lifecycle: {}, rows: [],
  };
}

function runtime(c, lang = 'en') {
  const cat = JSON.parse(readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url)));
  const LANG = { code: lang, langs: [lang], names: { [lang]: lang }, num: String, money: String,
    pct: String, plur: (key, n) => cat[`${key}.${n === 1 ? 'one' : 'other'}`] || key,
    t: (key, vars = {}, fallback) => (cat[key] || fallback || `[${key}]`).replace(/\{(\w+)\}/g, (s, k) => vars?.[k] ?? s) };
  const window = { __D__: { cols, cities: [c] }, __SHIP_LANGS__: [lang] };
  const ctx = vm.createContext({ window, LANG, URL, document: {
    createElement: () => ({ innerHTML: '', querySelectorAll: () => [] }),
  } });
  vm.runInContext(functions, ctx);
  ctx.indexCity(c);
  ctx.dateReference = '2026-10-10';
  return ctx;
}

test('the city page links its indexable streets, most recorded sales first', () => {
  const ctx = runtime(fixture(0));
  const html = ctx.screenCity();
  assert.match(html, /<h2 id="city-streets-title">Streets with the most recorded sales<\/h2>/);
  const section = html.slice(html.indexOf('city-streets'));
  const order = [...section.matchAll(/\/rua\/(rua-[a-z-]+)\//g)].map(m => m[1]);
  assert.deepEqual(order.slice(0, 3), ['rua-dois', 'rua-um', 'rua-tres']);
  assert.ok(!order.includes('rua-fina'), 'a noindex street gets no city-page link');
});

test('the list is capped and absent when the city has no street market', () => {
  const ctx = runtime(fixture(80));
  const html = ctx.screenCity();
  const section = html.slice(html.indexOf('city-streets'));
  const links = new Set([...section.matchAll(/\/rua\/(rua-[a-z0-9-]+)\//g)].map(m => m[1]));
  assert.equal(links.size, ctx.CITY_STREET_LIMIT);
  const none = fixture(0);
  none.streets = {};
  assert.doesNotMatch(runtime(none).screenCity(), /city-streets/);
});
