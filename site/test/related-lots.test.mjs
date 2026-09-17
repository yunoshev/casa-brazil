import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../v2/app.js', import.meta.url), 'utf8');
const functions = source.split('/* ---- boot ')[0];
const cols = ['id', 'src', 'bairro', 'end', 'tipo', 'area', 'quartos', 'preco', 'hammer',
  'margin', 'mkt', 'aval', 'avalpct', 'n', 'ring', 'conf', 'jud', 'mod', 'data', 'link', 'promised', 'why'];
const C = Object.fromEntries(cols.map((key, i) => [key, i]));
const row = fields => cols.map(key => fields[key] ?? null);

function fixture() {
  const c = {
    slug: 'rio-de-janeiro-rj', uf: 'rj', cslug: 'rio-de-janeiro', nome: 'Rio de Janeiro',
    cidade: 'RIO DE JANEIRO', stats: {}, chain: { hammer_over_asking: 0.5 },
    shapes: { nice: { CENTRO: 'Centro' }, d: { CENTRO: 'M0 0' }, of: {} },
    market: {}, streets: { by: { CENTRO: ['main'] }, d: {
      main: { name: 'Rua Principal', slug: 'rua-principal', bairro: 'CENTRO', bairros: ['CENTRO'] },
    } }, lifecycle: {}, rows: [],
  };
  const add = (id, fields, status = 'active') => {
    c.rows.push(row({ id, src: 'caixa', bairro: 'CENTRO', end: 'Rua Principal, 10',
      tipo: 'apartamento', area: 60, preco: 100000, conf: 'ok', ring: 500, ...fields }));
    c.lifecycle[id] = { status, slug: 'lot-' + id, last_price_brl: 99000 };
  };
  add('origin', {});
  add('street-current', { end: 'Rua Principal, 20' });
  add('area-current', { end: 'Avenida Nova, 20' });
  add('city-current', { bairro: 'OUTRO', end: 'Avenida Longe, 20' });
  add('street-archive', { end: 'Rua Principal, 30' }, 'archived');
  add('area-archive', { end: 'Avenida Nova, 30' }, 'missing');
  add('unknown-street', { bairro: 'OUTRO', end: 'Rua Sem Rota, 1' });
  return c;
}

function runtime(c) {
  const cat = JSON.parse(readFileSync(new URL('../i18n/en.json', import.meta.url)));
  const LANG = { code: 'en', langs: ['en'], names: { en: 'English' }, num: String, money: String,
    pct: String, plur: (key, n) => key + (n === 1 ? '.one' : '.other'),
    t: (key, vars = {}, fallback) => (cat[key] || fallback || key).replace(/\{(\w+)\}/g, (s, k) => vars?.[k] ?? s) };
  const window = { __D__: { cols, cities: [c] }, __SHIP_LANGS__: ['en'] };
  const ctx = vm.createContext({ window, LANG, URL, document: {} });
  vm.runInContext(functions, ctx);
  ctx.indexCity(c);
  return ctx;
}

test('ranks related lots by published place and keeps current lots ahead of archive', () => {
  const ctx = runtime(fixture());
  const html = ctx.screenLot('origin');
  const ids = [...html.matchAll(/class="row related-lot" href="[^"]*\/lote\/lot-([^/]+)\//g)].map(m => m[1]);
  assert.deepEqual(ids, ['street-current', 'street-archive', 'area-current', 'area-archive', 'city-current', 'unknown-street']);
  assert.doesNotMatch(html, /lote\/lot-origin\//);
  assert.match(html, /Same street/);
  assert.match(html, /Same area/);
  assert.match(html, /Same city/);
});

test('precomputes bounded per-lot candidates without changing the six-row limit', () => {
  const c = fixture();
  for (let i = 0; i < 5000; i++) {
    c.rows.push(row({ id: `city-${String(i).padStart(5, '0')}`, bairro: 'OUTRO',
      end: `Avenida Longe, ${i}`, tipo: 'apartamento', area: 60, preco: 100000 }));
    c.lifecycle[`city-${String(i).padStart(5, '0')}`] = { status: 'active', slug: `lot-city-${i}` };
  }
  const ctx = runtime(c);
  assert.equal(ctx.relatedGroups.city.length, c.rows.length);
  assert.equal(ctx.relatedCandidates.origin.length, 6);
  const html = ctx.screenLot('origin');
  assert.equal([...html.matchAll(/class="row related-lot"/g)].length, 6);
});

test('historical lot pages get the same related section and preserve archive pricing', () => {
  const ctx = runtime(fixture());
  const html = ctx.screenLot('street-archive');
  assert.match(html, /class="sec related-lots"/);
  assert.match(html, /class="row related-lot"/);
  assert.match(html, /99000/);
  assert.doesNotMatch(html, /lote\/lot-street-archive\//);
});

test('lot breadcrumbs include only valid city, area and street routes', () => {
  const ctx = runtime(fixture());
  const path = ctx.href('/l/street-current');
  assert.deepEqual(Array.from(ctx.pageTrail(path), item => item.path), [
    '/', ctx.cityBase(), ctx.href('/a/CENTRO'), ctx.href('/r/main'), path,
  ]);
  const html = ctx.screenLot('street-current');
  assert.match(html, /class="lot-breadcrumb"/);
  assert.match(html, /href="\/leilao-de-imoveis\/rj\/rio-de-janeiro\/"/);
  assert.match(html, /href="\/leilao-de-imoveis\/rj\/rio-de-janeiro\/centro\/"/);
  assert.match(html, /href="\/leilao-de-imoveis\/rj\/rio-de-janeiro\/rua\/rua-principal\/"/);
  assert.match(html, /www\.google\.com\/maps\/search\/\?api=1&amp;query=/);
  const missing = fixture();
  missing.rows[0][C.bairro] = 'No Such District';
  missing.rows[0][C.end] = 'Rua Sem Rota, 1';
  const missingCtx = runtime(missing);
  const missingPath = missingCtx.href('/l/origin');
  assert.deepEqual(Array.from(missingCtx.pageTrail(missingPath), item => item.path), [
    '/', missingCtx.cityBase(), missingPath,
  ]);
});

test('missing geography does not invent area or street routes', () => {
  const c = fixture();
  c.rows[0][C.bairro] = 'No Such District';
  c.rows[0][C.end] = 'No Such Street, 1';
  const html = runtime(c).screenLot('origin');
  assert.doesNotMatch(html, /\/rua\/sem-rota/);
  assert.match(html, /href="\/leilao-de-imoveis\/rj\/rio-de-janeiro\/"/);
});

test('street pages separate current and archived catalogue lots', () => {
  const ctx = runtime(fixture());
  const html = ctx.screenStreet('main');
  assert.match(html, /Current lots on this street/);
  assert.match(html, /Archived lots on this street/);
  assert.match(html, /lote\/lot-street-current\//);
  assert.match(html, /lote\/lot-street-archive\//);
});
