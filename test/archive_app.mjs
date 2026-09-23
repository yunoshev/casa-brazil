// Offline Node VM regressions. No DOM library, browser, network or paid calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../site/v2/app.js', import.meta.url), 'utf8');
new vm.Script(source);
const functions = source.split('/* ---- boot ')[0];
const catalogs = Object.fromEntries(['pt', 'en', 'ru'].map(lang => [lang,
  JSON.parse(readFileSync(new URL(`../site/i18n/${lang}.json`, import.meta.url)))]));
const cols = ['id', 'src', 'bairro', 'end', 'tipo', 'area', 'quartos', 'preco', 'hammer',
  'margin', 'mkt', 'aval', 'avalpct', 'n', 'ring', 'conf', 'jud', 'mod', 'data', 'link', 'promised', 'why'];
const C = Object.fromEntries(cols.map((key, i) => [key, i]));
const row = fields => cols.map(key => fields[key] ?? null);
const stamp = '2026-09-15T12:00:00+00:00';
function fixture() {
  const c = {
    slug: 'rio-de-janeiro-rj', uf: 'rj', cslug: 'rio-de-janeiro', nome: 'Rio de Janeiro',
    cidade: 'RIO DE JANEIRO', stats: { lots: 610, below: 610, paid_deals: 100 },
    chain: { hammer_over_asking: 0.6, auction_factor: 0.8, asking_premium: 1.2, n_auction: 20 },
    shapes: { nice: { CENTRO: 'Centro', HISTORY: 'History', EMPTY: 'Empty' },
      d: { CENTRO: 'M0 0L10 0L10 10Z', HISTORY: 'M10 0L20 0L20 10Z' },
      at: { CENTRO: [5, 5, 0, 0, 10, 10], HISTORY: [15, 5, 10, 0, 20, 10] },
      of: {}, box: [0, 0, 20, 10], unit: 'district', source: 'map.source.rio_cadastre' },
    market: {}, streets: { year: 2025, by: { HISTORY: ['1'] }, d: {
      '1': { name: 'Rua Histórica', slug: 'rua-historica', bairro: 'HISTORY', bairros: ['HISTORY'], f: [7000, 20] },
    } }, lifecycle: {}, rows: [],
  };
  for (let i = 0; i < 610; i++) {
    const id = String(i).padStart(16, '0');
    const status = i < 405 ? (i % 2 ? 'missing' : 'archived') : i === 405 ? 'unverified' : 'active';
    c.rows.push(row({ id, src: 'caixa', bairro: i < 405 ? 'HISTORY' : 'CENTRO',
      end: `Rua do Teste ${i}`, tipo: 'apartamento', area: 60, preco: 100000 + i,
      hammer: 200000, mkt: 250000, aval: 300000, margin: i < 405 ? 90 : -5,
      promised: i < 405 ? 80 : 50, conf: 'ok', ring: 500, n: 20, data: '2025-01-01',
      link: `https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=${i}` }));
    c.lifecycle[id] = { status, slug: `permanent-original-${id}`, first_seen_at: null,
      last_seen_at: '2026-09-10T12:00:00Z', last_checked_at: stamp,
      missing_since: i < 405 ? '2026-09-14T12:00:00Z' : null,
      archived_at: status === 'archived' ? stamp : null,
      last_price_brl: 123456 + i, outcome: null,
      history: [{ kind: 'seeded', observed_at: stamp, price_brl: 100000 + i,
        source_date: i < 405 ? '2026-09-15' : null, source_url: null }] };
  }
  return c;
}
function runtime(cities, lang = 'en', datasetCols = cols, options = {}) {
  const cat = catalogs[lang];
  const LANG = { code: lang, langs: [lang], names: { [lang]: lang }, num: String, money: String, pct: String,
    plur: (key, n) => cat[`${key}.${n === 1 ? 'one' : 'other'}`] || key,
    t: (key, vars = {}, fallback) => {
      assert.ok(cat[key] || fallback, `Missing ${lang} translation: ${key}`);
      return (cat[key] || fallback).replace(/\{(\w+)\}/g, (s, k) => vars?.[k] ?? s);
    } };
  const contextCities = options.localData ? JSON.parse(JSON.stringify(cities)) : cities;
  const windowData = { __D__: { cols: datasetCols, cities: contextCities, generated: null }, __SHIP_LANGS__: [lang] };
  if (options.marketReports) windowData.__D__.market_reports = options.marketReports;
  if (options.localProfiles) windowData.__D__.local_profiles = options.localProfiles;
  const document = options.marketReports ? {} : undefined;
  const ctx = vm.createContext({ window: {}, LANG: options.localData ? undefined : LANG, URL, document });
  vm.runInContext(`window = JSON.parse(${JSON.stringify(JSON.stringify(windowData))})`, ctx);
  if (options.localData) vm.runInContext(`{
    const catalog = JSON.parse(${JSON.stringify(JSON.stringify(cat))});
    LANG = {
      code: ${JSON.stringify(lang)}, langs: [${JSON.stringify(lang)}], names: { ${JSON.stringify(lang)}: ${JSON.stringify(lang)} },
      num: String, money: String, pct: String,
      plur: (key, n) => catalog[key + '.' + (n === 1 ? 'one' : 'other')] || key,
      t: (key, vars = {}, fallback) => (catalog[key] || fallback || key).replace(/\\{(\\w+)\\}/g, (s, k) => vars?.[k] ?? s),
    };
  }`, ctx);
  if (options.marketReports) ctx.window.MARKET = {
    renderReport(report, ownerDocument) {
      assert.equal(report.schema, 'market-v1');
      assert.equal(ownerDocument, document);
      return { outerHTML: '<section class="market-report"><h2>Market estimate</h2><p>R$ 280000</p></section>' };
    },
  };
  vm.runInContext(functions, ctx);
  if (options.localData) vm.runInContext('indexCity(window.__D__.cities[0])', ctx);
  else ctx.indexCity(cities[0]);
  ctx.dateReference = '2026-09-15';
  return ctx;
}
const lotLinks = html => [...html.matchAll(/class="row lot" href="([^"]+)"/g)].map(m => m[1]);
function crawl(ctx, archive) {
  let path = archive ? ctx.href('/archive') : ctx.href('/all'), prev = null;
  const visited = new Set(), titles = new Set(), urls = [];
  while (path) {
    assert.ok(!visited.has(path), `Cycle: ${path}`);
    visited.add(path);
    const html = ctx.screenFor(path), head = ctx.headFor(path);
    assert.equal(typeof html, 'string', path);
    assert.ok(Buffer.byteLength(html) < 2_000_000);
    const links = lotLinks(html);
    assert.ok(links.length <= 200);
    urls.push(...links);
    assert.equal(head.canonical, path);
    assert.ok(!head.noindex);
    assert.ok(!titles.has(head.title));
    titles.add(head.title);
    assert.equal(/<a rel="prev" href="([^"]+)"/.exec(html)?.[1] ?? null, prev);
    if (visited.size > 1) assert.deepEqual(Array.from(ctx.pageTrail(path), x => x.path),
      ['/', ctx.cityBase(), ctx.href(archive ? '/archive' : '/all'), path]);
    prev = path;
    path = /<a rel="next" href="([^"]+)"/.exec(html)?.[1] ?? null;
  }
  assert.equal(visited.size, archive ? ctx.archivePageCount() : ctx.allPageCount());
  assert.equal(urls.length, new Set(urls).size);
  return urls;
}

const c = fixture(), ctx = runtime([c]), base = ctx.cityBase();
const marketId = c.rows[406][C.id];
const marketCity = fixture();
marketCity.rows[406][C.end] = 'Rua Histórica, 1';
const marketCtx = runtime([marketCity], 'en', cols, {
  marketReports: { [marketId]: { schema: 'market-v1' } },
});
const marketHTML = marketCtx.screenLot(marketId);
assert.match(marketHTML, /class="market-report"/);
assert.match(marketHTML, /R\$ 280000/);
assert.match(marketHTML, new RegExp('data-lot-report="' + marketId + '"'));
assert.match(marketCtx.screenCity(), /1 lots on this page have a market report available/);
assert.match(marketCtx.screenArea('CENTRO'), /1 lots on this page have a market report available/);
assert.match(marketCtx.screenStreet('1'), /1 lots on this page have a market report available/);
assert.doesNotMatch(marketCtx.screenStreet('1'), /Market estimate/,
  'street availability never claims an aggregate valuation');

const localProfiles = {
  area: { 'rio-de-janeiro-rj': { CENTRO: {
    observed_at: '2026-09-20T10:00:00Z',
    summary: { pt: 'Contexto em português.', en: 'Reviewed local context.', ru: 'Проверенный местный контекст.' },
    attribution: { pt: 'Fontes citadas.', en: 'Compiled from cited sources.', ru: 'По указанным источникам.' },
    limitations: { pt: 'Não substitui diligência.', en: 'It does not replace diligence.', ru: 'Не заменяет проверку.' },
    citations: [{ label: { pt: 'Fonte pública', en: 'Public source', ru: 'Открытый источник' },
      url: 'https://source.example/context?x=1&y=2', observed_at: '2026-09-19T10:00:00Z',
      evidence: { pt: 'Evidência pública.', en: 'A <documented> public result.', ru: 'Открытые данные.' } }],
  } } },
  street: { 'rio-de-janeiro-rj': { '1': {
    observed_at: '2026-09-20T10:00:00Z',
    summary: { pt: 'Contexto da rua.', en: 'Reviewed street context.', ru: 'Проверенный контекст улицы.' },
    attribution: { pt: 'Fontes citadas.', en: 'Compiled from cited sources.', ru: 'По указанным источникам.' },
    limitations: { pt: 'Não substitui diligência.', en: 'It does not replace diligence.', ru: 'Не заменяет проверку.' },
    citations: [{ label: { pt: 'Fonte da rua', en: 'Street source', ru: 'Источник улицы' },
      url: 'https://source.example/street', observed_at: '2026-09-18T10:00:00Z',
      evidence: { pt: 'Resultado datado.', en: 'A dated street result.', ru: 'Данные с датой.' } }],
  } } },
};
const localCtx = runtime([fixture()], 'en', cols, { localProfiles });
const localArea = localCtx.screenArea('CENTRO');
assert.match(localArea, /Documented local context/);
assert.match(localArea, /Reviewed local context\./);
assert.match(localArea, /observed 2026-09-20/);
assert.match(localArea, /https:\/\/source.example\/context\?x=1&amp;y=2/);
assert.match(localArea, /A &lt;documented&gt; public result\./);
assert.match(localArea, /Compiled from cited sources\./);
assert.match(localArea, /Limits of this context/);
assert.match(localArea, /It does not replace diligence\./);
assert.match(localCtx.screenStreet('1'), /Reviewed street context\./);
assert.equal(localCtx.headFor(localCtx.href('/a/centro/')).noindex,
  ctx.headFor(ctx.href('/a/centro/')).noindex,
  'a profile enriches a route but does not change indexability');
assert.doesNotMatch(ctx.screenArea('CENTRO'), /local-profile/,
  'missing optional data leaves the existing route untouched');
const ptFallback = JSON.parse(JSON.stringify(localProfiles));
delete ptFallback.area['rio-de-janeiro-rj'].CENTRO.summary.en;
assert.match(runtime([fixture()], 'en', cols, { localProfiles: ptFallback }).screenArea('CENTRO'),
  /Contexto em português\./, 'old static payloads fall back to Portuguese copy');
const unsafeProfile = JSON.parse(JSON.stringify(localProfiles));
unsafeProfile.area['rio-de-janeiro-rj'].CENTRO.citations[0].url = 'javascript:alert(1)';
assert.doesNotMatch(runtime([fixture()], 'en', cols, { localProfiles: unsafeProfile }).screenArea('CENTRO'),
  /local-profile/, 'an unsafe runtime citation suppresses the complete profile');
assert.match(runtime([fixture()], 'ru', cols, { localProfiles }).screenArea('CENTRO'),
  /Проверенный местный контекст\./, 'profile copy follows the selected locale');

const current = crawl(ctx, false), archived = crawl(ctx, true);
assert.equal(current.length, 205);
assert.equal(archived.length, 405);
assert.equal(new Set([...current, ...archived]).size, 610);
assert.equal(ctx.allPageCount(), 2);
assert.equal(ctx.archivePageCount(), 3);
assert.equal(c.stats.lots, 205);
assert.equal(c.stats.reliable, 205);
assert.equal(c.stats.below, 0);
assert.equal(c.stats.promised_med, 50);
assert.equal(c.stats.real_med, 5);
assert.equal(c.stats.promised_hi_n, 205);
assert.equal(c.stats.above_hammer, 205);
assert.equal(c.stats.loud_below, 0);
assert.equal(ctx.national().lots, 205);
assert.equal(ctx.national().below, 0);
assert.equal(ctx.national().promised_med, 50);
assert.equal(ctx.areaStat('HISTORY').n, 0);
assert.equal(ctx.areaStat('HISTORY').share, null);
assert.equal(ctx.areaStat('CENTRO').n, 205);
assert.ok(!ctx.headFor(base + 'history/').noindex, 'Useful archived district remains indexed');
assert.equal(ctx.headFor(base + 'empty/').noindex, true, 'Existing empty-page policy retained');
const mixedDossier = ctx.inventorySummary([c.rows[405], c.rows[406], c.rows[0]]);
assert.match(mixedDossier, /Current catalog records<\/span><span class="v">2<\/span>/);
assert.match(mixedDossier, /Archived or missing records<\/span><span class="v">1<\/span>/);
assert.match(mixedDossier, /Availability unverified<\/span><span class="v">1<\/span>/);
const historyArea = ctx.screenFor(base + 'history/');
assert.match(historyArea, /Earlier lots in this district/);
assert.ok(historyArea.includes(ctx.href('/archive')));
const streetPath = ctx.href('/r/1');
const originalStreetRows = ctx.lotsByStreet['1'];
ctx.lotsByStreet['1'] = [c.rows[405], c.rows[0]];
const mixedStreetLists = ctx.streetLotLists('1');
assert.match(mixedStreetLists, /Current lots on this street/);
assert.match(mixedStreetLists, /Archived lots on this street/);
ctx.lotsByStreet['1'] = originalStreetRows;
const streetBefore = ctx.screenFor(streetPath);
assert.match(streetBefore, /7000/);
assert.match(streetBefore, /2025/);
assert.ok(!ctx.headFor(streetPath).noindex);
assert.ok(ctx.screenCity().includes(ctx.href('/archive')));
assert.ok(ctx.screenAll().includes(ctx.href('/archive')));
assert.ok(ctx.screenArchive().includes(ctx.href('/all')));
for (const path of lotLinks(ctx.screenCity())) assert.ok(current.includes(path), 'City recommendations contain current records only');
for (const path of lotLinks(ctx.screenArea('CENTRO'))) assert.ok(current.includes(path));
const lotHeadTitles = new Set(), lotHeadDescriptions = new Set();
for (const path of [...current, ...archived]) {
  const html = ctx.screenFor(path);
  const id = ctx.idFromSlug(path.split('/').filter(Boolean).at(-1));
  const head = ctx.headFor(path);
  assert.ok(html?.includes('<h1>'), path);
  assert.ok(!head.noindex, path);
  assert.equal(head.canonical, path);
  assert.ok(head.title.includes(id), `${path}: title lacks stable lot reference`);
  assert.ok(head.desc.includes(id), `${path}: description lacks stable lot reference`);
  assert.ok(html.includes(`Lot reference: ${id}`), `${path}: visible lot reference missing`);
  assert.ok(!lotHeadTitles.has(head.title), `${path}: duplicate lot title`);
  assert.ok(!lotHeadDescriptions.has(head.desc), `${path}: duplicate lot description`);
  lotHeadTitles.add(head.title);
  lotHeadDescriptions.add(head.desc);
  if (archived.includes(path)) {
    assert.match(html, /Removed from current lists/);
    assert.match(html, /Last advertised price — not a sale price/);
    assert.match(html, /Retained historical analysis/);
    assert.doesNotMatch(html, /data-az=|class="cta"|Sale confirmed by the source|Sale price confirmed by the source/);
    assert.match(html, /Outcome not confirmed by a source/);
  }
}

const r = c.rows[0], id = r[C.id], lc = c.lifecycle[id];
const stable = ctx.href(`/l/${id}`);
r[C.bairro] = 'Changed address';
r[C.area] = 99;
r[C.tipo] = 'casa';
ctx.indexCity(c);
assert.equal(ctx.href(`/l/${id}`), stable);
assert.ok(ctx.screenFor(stable));
assert.equal(ctx.screenFor(base + `lote/casa-99m2-changed-address-${id}/`), null);
lc.slug = 'original-slug-without-id';
ctx.indexCity(c);
assert.ok(ctx.screenFor(base + 'lote/original-slug-without-id/'), 'Slug override need not end with the ID');
assert.equal(ctx.pageTrail(base + 'lote/original-slug-without-id/').at(-1).path, base + 'lote/original-slug-without-id/');

lc.history = [
  { kind: 'seen', observed_at: '2026-09-01T12:00:00Z', price_brl: 155000, source_date: '2026-08-31', source_url: 'https://source.test/first' },
  { kind: 'price_changed', observed_at: '2026-09-10T12:00:00Z', price_brl: 123456, source_date: null, source_url: 'https://source.test/price' },
  { kind: 'missing', observed_at: '2026-09-14T12:00:00Z', price_brl: null, source_date: null, source_url: null },
  { kind: 'archived', observed_at: stamp, price_brl: null, source_date: null, source_url: null },
];
let html = ctx.screenLot(id);
assert.match(html, /155000/);
assert.match(html, /123456/);
assert.match(html, /2026-08-31/);
assert.match(html, /href="https:\/\/source.test\/price"/);
assert.match(html, /Archive observation recorded at/);
assert.doesNotMatch(html, /Outcome date reported by the source/);
lc.history.push({ kind: 'historical_price', observed_at: stamp, price_brl: 199123.45,
  source_date: '2026-08-21', source_url: 'https://source.test/legacy' });
lc.history.push({ kind: 'unknown_future_event', observed_at: stamp, price_brl: 8123999, source_url: 'https://source.test/private' });
html = ctx.screenLot(id);
assert.match(html, /Historical asking price from source dated 2026-08-21, imported later/);
assert.match(html, /Import date — not the source observation date<\/span><span class="v">2026-09-15/);
assert.match(html, /Date stated in the source<\/span><span class="v">2026-08-21/);
assert.match(html, /199123\.45/);
assert.doesNotMatch(html, /unknown_future_event|8123999|https:\/\/source.test\/private/);
for (const bad of [null, '', 'http://source.test/sold', 'javascript:alert(1)', 'https://',
  'https://user:pass@source.test/sold', 'https://source.test/" onclick="evil', 'https://source.test\\evil']) {
  lc.outcome = { kind: 'sold', price_brl: 99999, effective_at: '2026-09-12T12:00:00Z', evidence_url: bad };
  assert.equal(ctx.confirmedOutcome(r), null);
  assert.doesNotMatch(ctx.screenLot(id), /Sale confirmed by the source|99999|onclick="evil/);
}
for (const kind of ['sold', 'withdrawn', 'cancelled', 'postponed', 'unsold']) {
  lc.outcome = { kind, price_brl: 99999, effective_at: null, evidence_url: 'https://source.test/outcome?a=1&b=2' };
  html = ctx.screenLot(id);
  assert.ok(html.includes(catalogs.en[`archive.outcome.${kind}`]));
  assert.match(html, /https:\/\/source.test\/outcome\?a=1&amp;b=2/);
  assert.equal(html.includes('99999'), kind === 'sold');
  assert.match(html, /Outcome date reported by the source<\/span><span class="v">Not recorded/);
}
lc.outcome = { kind: 'sold', price_brl: 99999, effective_at: '2026-09-12T12:00:00Z', evidence_url: 'https://source.test/sold' };
assert.match(ctx.screenLot(id), /Outcome date reported by the source<\/span><span class="v">2026-09-12T12:00:00Z/);
assert.match(ctx.screenLot(id), /Last advertised price — not a sale price<\/span><span class="v">123456/);
lc.status = 'unverified';
lc.archived_at = null;
lc.missing_since = null;
lc.outcome = null;
lc.history.push({ kind: 'reappeared', observed_at: stamp, price_brl: 130000, source_date: null, source_url: null });
ctx.indexCity(c);
assert.equal(c.stats.lots, 206);
assert.equal(ctx.archiveRows().length, 404);
assert.match(ctx.screenLot(id), /Reappearance observed/);
assert.match(ctx.screenLot(id), /Availability unverified/);
assert.ok(ctx.screenFor(base + 'lote/original-slug-without-id/'));
assert.equal(ctx.screenFor(streetPath), streetBefore, 'Street history persists through transitions');

for (const lang of ['pt', 'en', 'ru']) {
  const local = fixture(), run = runtime([local], lang);
  const changed = local.rows[406];
  changed[C.conf] = 'none'; changed[C.margin] = null; changed[C.why] = 'data_changed'; changed[C.preco] = 180000;
  const changedHTML = run.screenLot(changed[C.id]);
  assert.ok(changedHTML.includes(catalogs[lang]['why.data_changed']));
  assert.equal(run.verdict(changed), null);
  for (const content of [changedHTML, run.screenLot(local.rows[0][C.id]), run.screenArchive(3), run.screenArea('HISTORY')]) {
    assert.doesNotMatch(content, /undefined|\[archive\.|\[why\.data_changed\]/);
  }
}
const legacy = fixture();
delete legacy.lifecycle;
const old = runtime([legacy]);
assert.equal(old.currentRows().length, 610);
assert.equal(old.archiveRows().length, 0);
assert.equal(old.lotStatus(legacy.rows[0]), 'unverified');
assert.match(old.screenLot(legacy.rows[0][C.id]), /Availability has not been confirmed/);
assert.doesNotMatch(old.screenLot(legacy.rows[0][C.id]), /Present at the last source check/);
assert.match(old.screenArchive(), /No archived or missing lots/);
for (const suffix of ['pagina/0/', 'pagina/1/', 'pagina/01/', 'pagina/02/', 'pagina/4/',
  'pagina/-1/', 'pagina/2.5/', 'pagina/999999999999999999/', 'pagina/2/extra/', 'extra/']) {
  assert.equal(ctx.screenFor(ctx.href('/archive') + suffix), null, suffix);
}
for (const bad of [null, '', '2026-02-30', 'bad', '<script>']) assert.equal(ctx.archiveDate(bad), null);
assert.equal(ctx.archiveDate('2026-09-15T23:00:00-03:00'), '2026-09-15T23:00:00-03:00');

const bare = fixture();
bare.rows.push(row({ id: 'new-caixa', src: 'caixa', preco: 100000, conf: 'none' }));
bare.lifecycle['new-caixa'] = { status: 'active', slug: 'new-source-record', history: [] };
const bareRun = runtime([bare]);
assert.ok(crawl(bareRun, false).includes(bareRun.href('/l/new-caixa')));
assert.equal(bareRun.verdict(bare.rows.at(-1)), null);
assert.equal(bareRun.areaOf(bare.rows.at(-1)), null);
assert.match(bareRun.screenFor(bareRun.href('/l/new-caixa')), /No estimate/);

// Exercise the ENTIRE existing catalog as history, in memory. No 20-lot pilot.
const exported = JSON.parse(readFileSync(new URL('../data/site.json', import.meta.url)));
const originalURLs = new Map();
let total = 0, pages = 0;
for (const raw of exported.cities) {
  const c = { ...raw, uf: raw.slug.slice(-2), cslug: raw.slug.slice(0, -3), shapes: null,
    stats: {}, market: {}, streets: {}, lifecycle: {} };
  const full = runtime([c], 'pt', exported.cols, { localData: true });
  const ids = new Map(JSON.parse(vm.runInContext(
    'JSON.stringify(window.__D__.cities[0].rows.map(r => [String(r[C.id]), lotSlug(r)]))', full)));
  for (const r of c.rows) originalURLs.set(`${c.slug}/${r[full.C.id]}`, full.href('/l/' + encodeURIComponent(r[full.C.id])));
  for (const [i, r] of c.rows.entries()) c.lifecycle[String(r[full.C.id])] = {
    status: i % 2 ? 'archived' : 'missing', slug: ids.get(String(r[full.C.id])),
    archived_at: i % 2 ? stamp : null, missing_since: stamp, history: [],
  };
  vm.runInContext(`window.__D__.cities[0].lifecycle = JSON.parse(${JSON.stringify(JSON.stringify(c.lifecycle))}); indexCity(window.__D__.cities[0])`, full);
  assert.equal(full.national().lots, 0);
  assert.equal(full.national().reliable, 0);
  assert.equal(lotLinks(full.screenAll()).length, 0);
  // The fixture above owns the pagination crawl assertions. For the full
  // export, checking every archive page would repeatedly sort all 8,423 rows;
  // check the page count once, then keep complete lot-route coverage here.
  assert.equal(full.archivePageCount(), Math.ceil(raw.rows.length / 200));
  const reached = c.rows;
  assert.equal(reached.length, raw.rows.length, c.nome);
  const routeSummary = JSON.parse(vm.runInContext(`JSON.stringify(window.__D__.cities[0].rows.reduce((summary, r) => {
    const path = href('/l/' + encodeURIComponent(r[C.id]));
    const body = screenFor(path);
    summary.count++;
    if (typeof body !== 'string' || !body.includes('<h1>') || /data-az=/.test(body)) {
      summary.failed++;
      summary.firstFailure ||= path;
    }
    return summary;
  }, { count: 0, failed: 0, firstFailure: null }))`, full));
  assert.equal(routeSummary.count, raw.rows.length);
  assert.equal(routeSummary.failed, 0, routeSummary.firstFailure);
  total += reached.length; pages += full.archivePageCount();
}
assert.equal(total, exported.cities.reduce((n, city) => n + city.rows.length, 0));
console.log(`Archive app: mixed lifecycle, stats/maps/rankings, stable URLs, district/street retention, sourced outcomes, price history, reappearance, invalid routes and all locales passed. Full 8423-lot catalog routes rendered; archive page counts validated (${pages} pages); archive pagination crawl covered by the fixture; no file writes.`);

// Optional real lifecycle preview: node test/archive_app.mjs /path/to/preview.json
if (process.argv[2]) {
  const preview = JSON.parse(readFileSync(process.argv[2]));
  const states = {}, cities = preview.cities.map(raw => ({ ...raw,
    uf: raw.slug.slice(-2), cslug: raw.slug.slice(0, -3), shapes: null,
    stats: { paid_deals: raw.paid_deals, listings: raw.listings }, market: {}, streets: {} }));
  const live = runtime(cities, 'pt', preview.cols);
  let reached = 0, currentCount = 0, archiveCount = 0;
  for (const c of cities) {
    live.indexCity(c);
    const current = crawl(live, false), archive = crawl(live, true);
    currentCount += current.length; archiveCount += archive.length;
    assert.equal(current.length + archive.length, c.rows.length);
    const expected = new Set(c.rows.map(r => live.href('/l/' + encodeURIComponent(r[live.C.id]))));
    assert.deepEqual(new Set([...current, ...archive]), expected);
    for (const r of c.rows) {
      const state = live.lotStatus(r);
      states[state] = (states[state] || 0) + 1;
      const path = live.href('/l/' + encodeURIComponent(r[live.C.id]));
      const original = originalURLs.get(`${c.slug}/${r[live.C.id]}`);
      if (original) assert.equal(path, original, 'Pre-existing lot URL must survive source changes');
      const body = live.screenFor(path);
      assert.ok(body?.includes('<h1>'), path);
      if (!live.isCurrent(r)) {
        assert.ok(archive.includes(path));
        assert.doesNotMatch(body, /data-az=/);
        assert.ok(body.includes(catalogs.pt[`archive.status.${state}`]));
        assert.ok(!live.headFor(path).noindex);
      }
      if (r[live.C.why] === 'data_changed') {
        assert.equal(live.verdict(r), null);
        if (live.isCurrent(r)) assert.ok(body.includes(catalogs.pt['why.data_changed']));
      }
    }
    reached += expected.size;
  }
  assert.equal(live.national().lots, currentCount);
  console.log(`Lifecycle preview: all ${reached} URLs render; ${currentCount} current, ${archiveCount} archive/pending; states=${JSON.stringify(states)}.`);
}
