import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../v2/app.js', import.meta.url), 'utf8');
const functions = source.split('/* ---- boot ')[0];
const cols = ['id', 'src', 'bairro', 'end', 'tipo', 'area', 'quartos', 'preco', 'hammer',
  'margin', 'mkt', 'aval', 'avalpct', 'n', 'ring', 'conf', 'jud', 'mod', 'data', 'link', 'promised', 'why'];

function summary(n, median, p25, p75, above, over = 20) {
  return { n, median, p25, p75, at_or_above: above, over_40: over };
}

function study(overrides = {}) {
  return {
    city: 'sao-paulo-sp', measured_at: '2026-10-10T16:38:19Z', data_until: '2026-06-26',
    source_url: 'https://www.prefeitura.sp.gov.br/itbi', min_comps: 5, auction_deeds: 28275,
    building: summary(5169, 26.4, 10.2, 37.6, 15.5, 20.5),
    block: summary(12344, 29.2, 11.6, 42.8, 15.2),
    years: [2022, 2023, 2024, 2025, 2026].map((year, i) => ({ year, ...summary(200 + i, 25 + i, 15, 38, 9) })),
    periods: [
      { from: 2006, to: 2012, ...summary(1980, 22.2, 4.7, 36.7, 19.9) },
      { from: 2013, to: 2019, ...summary(1388, 27.5, 7.8, 38.7, 18.9) },
      { from: 2020, to: 2026, ...summary(1801, 28.9, 18.3, 37.7, 8.1) },
    ],
    price_thirds: [summary(1727, 22.9, 4.2, 35.4, 21), summary(1733, 28.2, 15, 38, 12), summary(1709, 27.7, 12, 39, 13)],
    ...overrides,
  };
}

function city(slug, uf, cslug, nome) {
  return {
    slug, uf, cslug, nome, cidade: nome.toUpperCase(), rows: [], lifecycle: {}, market: {},
    stats: { lots: 40, reliable: 30, below: 11, paid_deals: 1000, listings: 500 },
    chain: { asking_premium: 1.216799, auction_factor: 0.736001, hammer_over_asking: 0.604867, n_auction: 5169, zones: 990 },
  };
}

function runtime(payloadStudy, lang = 'en') {
  const cat = JSON.parse(readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url)));
  const LANG = { code: lang, langs: [lang], names: { [lang]: lang }, num: v => String(Math.round(v)), money: String,
    pct: (v, sign) => (v < 0 ? '−' : sign === false ? '' : '+') + Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0) + '%',
    plur: (key, n) => cat[`${key}.${n === 1 ? 'one' : 'other'}`] || key,
    t: (key, vars = {}, fallback) => (cat[key] || fallback || `[${key}]`).replace(/\{(\w+)\}/g, (s, k) => vars?.[k] ?? s) };
  const sp = city('sao-paulo-sp', 'sp', 'sao-paulo', 'São Paulo');
  const rio = city('rio-de-janeiro-rj', 'rj', 'rio-de-janeiro', 'Rio de Janeiro');
  const window = { __D__: { cols, cities: [sp, rio], auction_study: payloadStudy }, __SHIP_LANGS__: [lang] };
  const ctx = vm.createContext({ window, LANG, URL, document: {
    createElement: () => ({ innerHTML: '', querySelectorAll: () => [] }),
  } });
  vm.runInContext(functions, ctx);
  ctx.indexCity(sp);
  ctx.dateReference = '2026-10-10';
  return ctx;
}

const PATH = '/leilao-de-imoveis/sp/sao-paulo/quanto-desconta-o-leilao/';

test('the study page draws the measured figures, a point per year and the source', () => {
  const ctx = runtime(study());
  const html = ctx.screenFor(PATH);
  assert.match(html, /<h1>How much an auction really knocks off in São Paulo<\/h1>/);
  assert.match(html, /<b>26%<\/b>/);
  assert.match(html, /<b>60%<\/b>/, 'where a typical auction ends against the asking price');
  assert.equal((html.match(/<circle/g) || []).length, 5);
  assert.doesNotMatch(html, /<title/, 'the page head owns the only <title>');
  assert.equal((html.match(/<circle class="open"/g) || []).length, 1, '2026 is a partial year');
  assert.equal((html.match(/<tr><th scope="row">/g) || []).length, 5);
  assert.match(html, /href="https:\/\/www\.prefeitura\.sp\.gov\.br\/itbi"/);
  // Stats are recounted from the live rows; with none reliable, today's block stays out.
  assert.doesNotMatch(html, /lots on sale today/);
  ctx.city.stats.reliable = 30;
  ctx.city.stats.below = 11;
  assert.match(ctx.screenFor(PATH), /<b>30<\/b> lots in São Paulo with a reliable estimate\. Of those, <b>11<\/b>/);
});

test('direction sentences follow the numbers, not the copy', () => {
  let html = runtime(study()).screenFor(PATH);
  assert.match(html, /grew rather than shrank/);
  assert.match(html, /has become much rarer/);
  const reversed = study({ periods: [
    { from: 2006, to: 2012, ...summary(1980, 30, 10, 40, 8) },
    { from: 2013, to: 2019, ...summary(1388, 27.5, 7.8, 38.7, 18.9) },
    { from: 2020, to: 2026, ...summary(1801, 22, 5, 35, 20) },
  ] });
  html = runtime(reversed).screenFor(PATH);
  assert.match(html, /discount against the building itself shrank/);
  assert.match(html, /has become more common/);
});

test('only the measured city has the route; titles and links point at it', () => {
  const ctx = runtime(study());
  assert.equal(ctx.screenFor('/leilao-de-imoveis/rj/rio-de-janeiro/quanto-desconta-o-leilao/'), null);
  ctx.screenFor(PATH);
  assert.match(ctx.headFor(PATH).title, /26% below the neighbours/);
  assert.ok(!ctx.headFor(PATH).noindex);
  const rioCity = ctx.screenFor('/leilao-de-imoveis/rj/rio-de-janeiro/');
  assert.ok(rioCity.includes(`href="${PATH}"`), 'every city footer links the study');
  assert.ok(ctx.screenFor('/leilao-de-imoveis/rj/rio-de-janeiro/como-calculamos/').includes(`href="${PATH}"`));
  assert.ok(ctx.screenFor('/').includes(`href="${PATH}"`), 'the home page links the study');
});

test('without a shipped study there is no page and no dangling link', () => {
  const ctx = runtime(undefined);
  assert.equal(ctx.screenFor(PATH), null);
  assert.doesNotMatch(ctx.screenFor('/leilao-de-imoveis/sp/sao-paulo/'), /quanto-desconta-o-leilao/);
});
