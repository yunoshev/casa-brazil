// Offline function tests; no browser, DOM library, network or app boot.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';

const source = readFileSync(new URL('../site/v2/app.js', import.meta.url), 'utf8');
new vm.Script(source); // Check grammar of the entire source, including boot.
const functions = source.split('/* ---- boot ')[0];
assert.ok(functions.length < source.length, 'boot boundary exists');
const cat = JSON.parse(readFileSync(new URL('../site/i18n/pt.json', import.meta.url)));
const cols = ['id', 'src', 'bairro', 'end', 'tipo', 'area', 'quartos', 'preco', 'hammer',
  'margin', 'mkt', 'aval', 'avalpct', 'n', 'ring', 'conf', 'jud', 'mod', 'data', 'link'];
const row = fields => cols.map(k => fields[k] ?? null);
const city = {
  slug: 'rio-de-janeiro-rj', uf: 'rj', cslug: 'rio-de-janeiro', nome: 'Rio de Janeiro',
  stats: { lots: 405 }, chain: {}, market: {},
  shapes: { nice: { COPACABANA: 'Copacabana', EMPTY: 'Empty' }, d: {}, at: {}, of: {} },
  rows: Array.from({ length: 405 }, (_, i) => row({
    id: String(i).padStart(16, '0'), tipo: 'apartamento', preco: 100000 + i,
    bairro: i < 80 ? 'COPACABANA' : 'Unmapped', data: '2025-01-01',
  })),
};
const LANG = {
  code: 'pt', langs: ['pt'], names: { pt: 'Português' }, num: String, money: String, pct: String,
  plur: (key, n) => cat[`${key}.${n === 1 ? 'one' : 'other'}`] || key,
  t: (key, vars = {}, fallback) => (cat[key] || fallback || `[${key}]`).replace(/\{(\w+)\}/g, (s, k) => vars?.[k] ?? s),
};
const window = { __D__: { cols, cities: [city], generated: null }, __SHIP_LANGS__: ['pt'] };
const ctx = vm.createContext({ window, LANG });
vm.runInContext(functions, ctx);
ctx.indexCity(city);
ctx.dateReference = '2026-09-15';

function crawlAll(runtime) {
  let path = runtime.href('/all'), previous = null;
  const pages = new Map(), urls = [], titles = new Set();
  while (path) {
    assert.ok(!pages.has(path), `pagination cycle at ${path}`);
    const html = runtime.screenFor(path);
    assert.equal(typeof html, 'string', path);
    assert.ok(Buffer.byteLength(html) < 2_000_000, `${path}: body exceeds 2 MB`);
    const links = [...html.matchAll(/class="row lot" href="([^"]+)"/g)].map(x => x[1]);
    assert.ok(links.length <= 200, path);
    urls.push(...links);
    pages.set(path, html);
    const head = runtime.headFor(path);
    assert.equal(head.canonical, path);
    assert.ok(!head.noindex);
    assert.ok(!titles.has(head.title), `duplicate title: ${path}`);
    titles.add(head.title);
    if (pages.size > 1) {
      assert.match(head.title, new RegExp(`Página ${pages.size}$`));
      assert.match(head.desc, new RegExp(`^Página ${pages.size} / `));
      assert.match(html, new RegExp(`<h1>[^<]*Página ${pages.size}</h1>`));
      assert.deepEqual(Array.from(runtime.pageTrail(path), x => x.path),
        ['/', runtime.cityBase(), runtime.href('/all'), path]);
    }
    const prev = /<a rel="prev" href="([^"]+)"/.exec(html)?.[1] ?? null;
    assert.equal(prev, previous, `back link on ${path}`);
    previous = path;
    path = /<a rel="next" href="([^"]+)"/.exec(html)?.[1] ?? null;
  }
  assert.equal(pages.size, runtime.allPageCount());
  return { pages, urls };
}

const { pages: fixturePages, urls } = crawlAll(ctx);
assert.equal(fixturePages.size, 3);
assert.equal(urls.length, 405);
assert.equal(new Set(urls).size, 405);
assert.ok(urls.some(x => x.includes('0000000000000404')), 'unmapped final lot is reachable through pagination');
for (const url of urls) assert.ok(ctx.screenFor(url)?.includes('<h1>'), url);

assert.match(ctx.footNote(), /Data do conjunto de dados desconhecida/);
assert.doesNotMatch(ctx.footNote(), /Atualizado em/);
window.__D__.generated = '2020-01-01';
assert.match(ctx.footNote(), /Data do conjunto de dados: 2020-01-01/);

for (const bad of [null, '', '2025-02-29', '2026-13-01', 'today', '2026-09-15T12:00:00Z']) {
  const r = row({ data: bad });
  assert.equal(ctx.auctionDate(r), null);
  assert.match(ctx.auctionNote(r), /não informada ou não confirmada/);
}
assert.match(ctx.auctionNote(row({ data: '2025-01-01' })), /já havia passado em 2026-09-15/);
for (const d of ['2026-09-15', '2027-01-01']) {
  const note = ctx.auctionNote(row({ data: d }));
  assert.match(note, /Disponibilidade não verificada/);
  assert.doesNotMatch(note, /já havia passado|ativo|encerrado|fonte verificada/);
}
assert.match(ctx.screenLot(city.rows[0][0]), /Disponibilidade não verificada/);

const base = ctx.cityBase();
assert.equal(ctx.headFor(base + 'empty/').noindex, true);
assert.match(ctx.screenArea('EMPTY'), /Não há estatísticas locais/);
assert.doesNotMatch(ctx.screenArea('EMPTY'), /hoje|0 de 0|custaram de verdade/);
assert.equal(ctx.headFor(base + 'copacabana/').noindex, undefined, 'lots retain useful neighbourhood page');
city.market = { year: 2025, city: {}, d: { EMPTY: { f: [10000, 12] } } };
assert.equal(ctx.headFor(base + 'empty/').noindex, false);
assert.match(ctx.screenArea('EMPTY'), /estatísticas históricas/);
city.market.year = null;
assert.equal(ctx.headFor(base + 'empty/').noindex, true);

for (const path of ['/leilao-de-imoveis/', '/leilao-de-imoveis/rj/', base + 'rua/',
  base + 'lote/', base + 'missing/', base + 'todos-os-lotes/extra/',
  ...['0', '1', '01', '02', '-1', '2.5', '4', '999999999999999999999'].map(n => base + `todos-os-lotes/pagina/${n}/`),
  base + 'todos-os-lotes/extra/todos-os-lotes/pagina/2/',
  base + 'todos-os-lotes/pagina/2/extra/',
  base + 'lote/fake-0000000000000000/']) {
  assert.equal(ctx.screenFor(path), null, path);
}
assert.equal(ctx.headFor('/404').noindex, true);
ctx.atCity = true;
assert.deepEqual(Array.from(ctx.pageTrail(urls[0]), x => x.path), ['/', base, base + 'copacabana/', urls[0]]);
assert.deepEqual(Array.from(ctx.pageTrail(urls[84]), x => x.path), ['/', base, urls[84]]);
city.streets = { d: { '1': { name: 'Rua Real', slug: 'rua-real', bairro: 'COPACABANA' } } };
ctx.indexCity(city);
assert.deepEqual(Array.from(ctx.pageTrail(base + 'rua/rua-real/'), x => x.path),
  ['/', base, base + 'copacabana/', base + 'rua/rua-real/']);

// All locale paths use complete copy; no new i18n keys are needed.
for (const lang of ['pt', 'en', 'ru']) {
  LANG.code = lang;
  assert.doesNotMatch(ctx.auctionNote(row({})), /undefined|\[[a-z]+\./);
  assert.doesNotMatch(ctx.emptyAreaText('EMPTY'), /undefined|\[[a-z]+\./);
}
console.log('SEO app: 405 lots reached through 3 static pages; dates, empty areas, invalid routes, breadcrumbs and JS grammar passed');

// Measure the existing export in memory; do not rebuild geometry or write HTML.
// Body bytes exclude the surrounding page template, CSS and remote photos.
const exported = JSON.parse(readFileSync(new URL('../data/site.json', import.meta.url)));
LANG.code = 'pt';
let total = 0, pageCount = 0, maxBody = 0;
for (const raw of exported.cities) {
  const uf = raw.slug.slice(-2);
  const c = { ...raw, uf, cslug: raw.slug.slice(0, -3), shapes: null,
    stats: { lots: raw.rows.length }, market: {}, streets: {} };
  const w = { __D__: { cols: exported.cols, cities: [c], generated: exported.generated ?? null },
    __SHIP_LANGS__: ['pt'] };
  const live = vm.createContext({ window: w, LANG });
  vm.runInContext(functions, live);
  live.indexCity(c);
  const { pages, urls: links } = crawlAll(live);
  const expected = new Set(raw.rows.map(r => live.href('/l/' + encodeURIComponent(r[0]))));
  assert.equal(links.length, raw.rows.length, c.nome);
  assert.deepEqual(new Set(links), expected, c.nome);
  total += links.length;
  pageCount += pages.size;
  const bodies = [...pages.values()];
  const biggest = Math.max(...bodies.map(html => Buffer.byteLength(html)));
  maxBody = Math.max(maxBody, biggest);
  console.log(`${c.nome}: pages=${pages.size}, rows=${links.length}, unique URLs=${expected.size}, max body=${biggest} bytes, max gzip=${Math.max(...bodies.map(html => gzipSync(html).length))} bytes`);
}
assert.equal(total, exported.cities.reduce((n, c) => n + c.rows.length, 0));
console.log(`Existing export: all ${total} rows reached through ${pageCount} static pages; largest body ${maxBody} bytes. No dataset changes or HTML writes`);
