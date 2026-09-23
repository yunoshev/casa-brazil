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
  'margin', 'mkt', 'aval', 'avalpct', 'n', 'ring', 'conf', 'jud', 'mod', 'data', 'link', 'srcdetail'];
const row = fields => cols.map(k => fields[k] ?? null);
const city = {
  slug: 'rio-de-janeiro-rj', uf: 'rj', cslug: 'rio-de-janeiro', nome: 'Rio de Janeiro',
  stats: { lots: 405 }, chain: {}, market: {},
  shapes: { nice: { COPACABANA: 'Copacabana', EMPTY: 'Empty' }, d: {}, at: {}, of: {} },
  rows: Array.from({ length: 405 }, (_, i) => row({
    id: String(i).padStart(16, '0'), tipo: 'apartamento', preco: 100000 + i,
    bairro: i < 80 ? 'COPACABANA' : 'Unmapped', end: 'Rua de Teste, ' + i, area: 60, data: '2025-01-01',
    link: 'https://source.example/lot/' + i,
  })),
};
const LANG = {
  code: 'pt', langs: ['pt'], names: { pt: 'Português' }, num: String, money: String, pct: String,
  plur: (key, n) => cat[`${key}.${n === 1 ? 'one' : 'other'}`] || key,
  t: (key, vars = {}, fallback) => (cat[key] || fallback || `[${key}]`).replace(/\{(\w+)\}/g, (s, k) => vars?.[k] ?? s),
};
const window = { __D__: { cols, cities: [city], generated: null }, __SHIP_LANGS__: ['pt'] };
const ctx = vm.createContext({ window, LANG, URL });
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

function assertUniqueLotMetadata(runtime, lotUrls, { bodies = false } = {}) {
  const titles = new Set(), descriptions = new Set();
  for (const path of lotUrls) {
    const slug = path.split('/').filter(Boolean).at(-1);
    const id = runtime.idFromSlug(slug);
    const head = runtime.headFor(path);
    assert.ok(head.title.includes(id), `${path}: title lacks stable lot reference`);
    assert.ok(head.desc.includes(id), `${path}: description lacks stable lot reference`);
    assert.ok(head.title.length <= 120, `${path}: title is not compact (${head.title.length})`);
    assert.ok(head.desc.length <= 260, `${path}: description is not compact (${head.desc.length})`);
    assert.ok(!titles.has(head.title), `${path}: duplicate lot title`);
    assert.ok(!descriptions.has(head.desc), `${path}: duplicate lot description`);
    titles.add(head.title);
    descriptions.add(head.desc);
    if (bodies) {
      const html = runtime.screenFor(path);
      assert.match(html, new RegExp(`Referência do lote: ${id}`));
      assert.match(html, /\brelated-lot\b/, `${path}: no related-lot internal link`);
    }
  }
}

const { pages: fixturePages, urls } = crawlAll(ctx);
assert.equal(fixturePages.size, 3);
assert.equal(urls.length, 405);
assert.equal(new Set(urls).size, 405);
assertUniqueLotMetadata(ctx, urls, { bodies: true });
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
assert.equal(ctx.headFor(base + 'empty/').noindex, undefined);
assert.match(ctx.screenArea('EMPTY'), /estatísticas históricas/);
city.market.year = null;
assert.equal(ctx.headFor(base + 'empty/').noindex, true);

// Indexability is deliberately based on publishable facts, not just a route.
// A complete inherited row may remain searchable while availability is still
// unverified, but a feed fragment without a source, address or price context
// cannot become a search landing page.
const strong = row({ id: 'strong', tipo: 'apartamento', bairro: 'COPACABANA', end: 'Rua Boa, 10',
  area: 50, preco: 123000, data: '2026-09-10', link: 'https://source.example/lots/strong' });
const weak = row({ id: 'weak', tipo: 'apartamento', bairro: 'COPACABANA', end: '',
  area: 0, preco: 123000, link: null });
const bare = row({ id: 'bare', tipo: 'apartamento', bairro: 'COPACABANA', end: 'Rua Sem Evidência, 9',
  area: 50, preco: 123000, aval: 160000, link: 'https://source.example/lots/bare' });
const reliable = row({ id: 'reliable', tipo: 'apartamento', bairro: 'COPACABANA', end: 'Rua Confiável, 8',
  area: 50, preco: 123000, conf: 'ok', ring: 500, link: 'https://source.example/lots/reliable' });
const reported = row({ id: 'reported', tipo: 'apartamento', bairro: 'COPACABANA', end: 'Rua com Relatório, 7',
  area: 50, preco: 123000, link: 'https://source.example/lots/reported' });
const documented = row({ id: 'documented', tipo: 'apartamento', bairro: 'COPACABANA', end: 'Rua Documentada, 6',
  area: 50, preco: 123000, link: 'https://source.example/lots/documented' });
const seededOnly = row({ id: 'seeded-only', tipo: 'apartamento', bairro: 'COPACABANA',
  end: 'Rua Só Bootstrap, 5', area: 50, preco: 123000,
  link: 'https://source.example/lots/seeded-only' });
const partialCaixa = row({ id: 'partial-caixa', src: 'caixa', tipo: 'apartamento', bairro: 'COPACABANA',
  end: 'Rua Observada, 4', area: 50, preco: 123000,
  link: 'https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=123456789' });
const partialWrongSource = row({ id: 'partial-wrong-source', src: 'caixa', tipo: 'apartamento', bairro: 'COPACABANA',
  end: 'Rua Fonte Incorreta, 3', area: 50, preco: 123000,
  link: 'https://source.example/lots/partial-wrong-source' });
const partialNoMarker = row({ id: 'partial-no-marker', src: 'caixa', tipo: 'apartamento', bairro: 'COPACABANA',
  end: 'Rua Sem Marker, 8', area: 50, preco: 123000,
  link: 'https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=456789123' });
const partialStale = row({ id: 'partial-stale', src: 'caixa', tipo: 'apartamento', bairro: 'COPACABANA',
  end: 'Rua Antiga, 2', area: 50, preco: 123000,
  link: 'https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=987654321' });
city.rows.push(strong, weak, bare, reliable, reported, documented, seededOnly, partialCaixa, partialWrongSource, partialNoMarker, partialStale);
city.lifecycle = {
  strong: { status: 'active', slug: 'strong', first_seen_at: '2026-09-12T10:00:00Z',
    last_seen_at: '2026-09-13T10:00:00Z', last_checked_at: '2026-09-14T10:00:00Z',
    missing_since: null, archived_at: null, history: [] },
  weak: { status: 'unverified', slug: 'weak', first_seen_at: null, last_seen_at: null,
    last_checked_at: null, missing_since: null, archived_at: null, history: [] },
  bare: { status: 'unverified', slug: 'bare', first_seen_at: null, last_seen_at: null,
    last_checked_at: null, missing_since: null, archived_at: null, history: [] },
  reliable: { status: 'unverified', slug: 'reliable', first_seen_at: null, last_seen_at: null,
    last_checked_at: null, missing_since: null, archived_at: null, history: [] },
  reported: { status: 'unverified', slug: 'reported', first_seen_at: null, last_seen_at: null,
    last_checked_at: null, missing_since: null, archived_at: null, history: [] },
  documented: { status: 'unverified', slug: 'documented', first_seen_at: null, last_seen_at: null,
    last_checked_at: null, missing_since: null, archived_at: null, history: [] },
  'seeded-only': { status: 'archived', slug: 'seeded-only', first_seen_at: null, last_seen_at: null,
    last_checked_at: '2026-09-14T10:00:00Z', missing_since: '2026-09-14T10:00:00Z',
    archived_at: '2026-09-14T10:00:00Z',
    history: [{ kind: 'seeded', observed_at: '2026-09-14T10:00:00Z', source_date: null, source_url: null }] },
  'partial-caixa': { status: 'unverified', slug: 'partial-caixa', first_seen_at: null,
    positive_source_observed_at: '2026-09-15T10:00:00Z', last_seen_at: '2026-09-15T10:00:00Z',
    last_checked_at: '2026-09-15T10:00:00Z', missing_since: null, archived_at: null, history: [] },
  'partial-wrong-source': { status: 'unverified', slug: 'partial-wrong-source', first_seen_at: null,
    positive_source_observed_at: '2026-09-15T10:00:00Z', last_seen_at: '2026-09-15T10:00:00Z',
    last_checked_at: '2026-09-15T10:00:00Z', missing_since: null, archived_at: null, history: [] },
  'partial-no-marker': { status: 'unverified', slug: 'partial-no-marker', first_seen_at: null,
    last_seen_at: '2026-09-15T10:00:00Z', last_checked_at: '2026-09-15T10:00:00Z',
    missing_since: null, archived_at: null, history: [] },
  'partial-stale': { status: 'unverified', slug: 'partial-stale', first_seen_at: null,
    positive_source_observed_at: '2026-09-11T10:00:00Z', last_seen_at: '2026-09-11T10:00:00Z',
    last_checked_at: '2026-09-11T10:00:00Z', missing_since: null, archived_at: null, history: [] },
};
window.__D__.market_reports = { reported: { schema: 'market-v1' } };
window.__D__.saved_analyses = { documented: {} };
city.streets = { year: 2026, by: { COPACABANA: ['seo'] }, d: {
  seo: { name: 'Rua Boa', slug: 'rua-boa', bairro: 'COPACABANA', bairros: ['COPACABANA'], f: [10000, 12] },
} };
ctx.indexCity(city);
const strongPath = ctx.href('/l/strong');
const weakPath = ctx.href('/l/weak');
const barePath = ctx.href('/l/bare');
assert.equal(ctx.headFor(strongPath).noindex, undefined);
assert.match(ctx.headFor(strongPath).desc, /Referência do lote: strong/);
assert.equal(ctx.headFor(weakPath).noindex, true);
assert.equal(ctx.headFor(barePath).noindex, true, 'area and appraisal alone are not independent evidence');
assert.equal(ctx.headFor(ctx.href('/l/reliable')).noindex, undefined);
assert.equal(ctx.headFor(ctx.href('/l/reported')).noindex, undefined);
assert.equal(ctx.headFor(ctx.href('/l/documented')).noindex, undefined);
assert.equal(ctx.headFor(ctx.href('/l/seeded-only')).noindex, true,
  'a collector/bootstrap timestamp alone is not independent historical evidence');
assert.equal(ctx.lotStatus(partialCaixa), 'unverified', 'presence evidence must not assert active availability');
assert.equal(ctx.headFor(ctx.href('/l/partial-caixa')).noindex, undefined,
  'a fresh, directly observed Caixa row can be indexed without absence inference');
assert.match(ctx.screenLot('partial-caixa'), /Disponibilidade não verificada/,
  'the indexed partial row still discloses its unverified availability');
assert.equal(ctx.headFor(ctx.href('/l/partial-wrong-source')).noindex, true,
  'a partial marker without the official Caixa detail URL is not enough');
assert.equal(ctx.headFor(ctx.href('/l/partial-no-marker')).noindex, true,
  'generic lifecycle dates cannot masquerade as a positive source observation');
assert.equal(ctx.headFor(ctx.href('/l/partial-stale')).noindex, true,
  'positive observation evidence expires after three days');
assert.match(ctx.screenLot('strong'), /Dados deste lote/);
assert.match(ctx.screenLot('strong'), /status da disponibilidade/);
assert.match(ctx.screenLot('strong'), /lance inicial por m²/);
assert.match(ctx.screenStreet('seo'), /Resumo do catálogo desta página/);
assert.equal(ctx.headFor(ctx.href('/r/seo')).noindex, undefined);
assert.equal(ctx.headFor(base + 'copacabana/').noindex, undefined);
assert.equal(ctx.lotLastmod(strongPath), '2026-09-14');
assert.equal(ctx.routeLastmod(ctx.href('/r/seo')), '2026-09-14');
assert.equal(ctx.routeLastmod(base + 'copacabana/'), '2026-09-15');
assert.equal(ctx.routeLastmod(base), '2026-09-15');

// Separate Caixa units may have the same normalised address, type, area and
// price. A bounded source-stated unit detail must survive into both the body
// and search metadata; a hash reference by itself is not useful page content.
const salas801 = row({ id: 'salas-801', src: 'caixa', tipo: 'sala', bairro: 'COPACABANA',
  end: 'Avenida Exemplo, 109', area: 50, preco: 123000,
  link: 'https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=801',
  srcdetail: 'SALAS 801/802' });
const salas803 = row({ id: 'salas-803', src: 'caixa', tipo: 'sala', bairro: 'COPACABANA',
  end: 'Avenida Exemplo, 109', area: 50, preco: 123000,
  link: 'https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=803',
  srcdetail: 'SALAS 803/804' });
city.rows.push(salas801, salas803);
for (const id of ['salas-801', 'salas-803']) city.lifecycle[id] = {
  status: 'active', slug: id, first_seen_at: '2026-09-14T10:00:00Z',
  last_seen_at: '2026-09-15T10:00:00Z', last_checked_at: '2026-09-15T10:00:00Z',
  missing_since: null, archived_at: null, history: [],
};
ctx.indexCity(city);
const salas801Head = ctx.headFor(ctx.href('/l/salas-801'));
const salas803Head = ctx.headFor(ctx.href('/l/salas-803'));
assert.notEqual(salas801Head.title, salas803Head.title);
assert.notEqual(salas801Head.desc, salas803Head.desc);
assert.match(salas801Head.title, /Salas 801\/802/);
assert.match(salas803Head.desc, /Salas 803\/804/);
assert.match(ctx.screenLot('salas-801'), /Identificação da unidade informada pela fonte: Salas 801\/802/);
assert.match(ctx.screenLot('salas-803'), /Identificação da unidade informada pela fonte: Salas 803\/804/);
salas801[cols.indexOf('srcdetail')] = '<script>private title</script>';
assert.doesNotMatch(ctx.screenLot('salas-801'), /private title|source-detail/,
  'rendering rejects a raw/unapproved source title even if a payload is tampered');

assert.equal(ctx.citySeoEligible({ rows: [], market: { year: null, d: { X: { f: [9000, 12] } } },
  streets: { d: {} } }), false, 'undated market payload cannot index a city');
assert.equal(ctx.citySeoEligible({ rows: [], market: { year: 2099, d: { X: { f: [9000, 12] } } },
  streets: { d: {} } }), false, 'future market payload cannot index a city');
assert.equal(ctx.citySeoEligible({ rows: [], market: { year: 2025, d: { X: { f: [9000, 12] } } },
  streets: { d: {} } }), true, 'valid dated market evidence can index a city');

city.streets.d.catalogue = { name: 'Rua Catálogo', slug: 'rua-catalogo', bairro: 'COPACABANA',
  bairros: ['COPACABANA'] };
ctx.indexCity(city);
const catalogueStreet = ctx.headFor(ctx.href('/r/catalogue'));
assert.equal(catalogueStreet.noindex, true, 'a street without deed evidence remains out of the sitemap');
assert.match(catalogueStreet.desc, /Contagens são registros do catálogo/);

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
  const live = vm.createContext({ window: w, LANG, URL });
  vm.runInContext(functions, live);
  live.indexCity(c);
  const { pages, urls: links } = crawlAll(live);
  const expected = new Set(raw.rows.map(r => live.href('/l/' + encodeURIComponent(r[0]))));
  assert.equal(links.length, raw.rows.length, c.nome);
  assert.deepEqual(new Set(links), expected, c.nome);
  assertUniqueLotMetadata(live, links);
  total += links.length;
  pageCount += pages.size;
  const bodies = [...pages.values()];
  const biggest = Math.max(...bodies.map(html => Buffer.byteLength(html)));
  maxBody = Math.max(maxBody, biggest);
  console.log(`${c.nome}: pages=${pages.size}, rows=${links.length}, unique URLs=${expected.size}, max body=${biggest} bytes, max gzip=${Math.max(...bodies.map(html => gzipSync(html).length))} bytes`);
}
assert.equal(total, exported.cities.reduce((n, c) => n + c.rows.length, 0));
console.log(`Existing export: all ${total} rows reached through ${pageCount} static pages; largest body ${maxBody} bytes. No dataset changes or HTML writes`);
