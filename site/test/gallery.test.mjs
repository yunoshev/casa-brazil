import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setup } from './dom.mjs';

const source = readFileSync(new URL('../v2/app.js', import.meta.url), 'utf8');
const functions = source.split('/* ---- boot ')[0];
const cols = ['id', 'src', 'bairro', 'end', 'tipo', 'area', 'quartos', 'preco', 'hammer',
  'margin', 'mkt', 'aval', 'avalpct', 'n', 'ring', 'conf', 'jud', 'mod', 'data', 'link', 'promised', 'why'];
const row = fields => cols.map(key => fields[key] ?? null);

function fixture(media, { archived = false, link = null, rowFields = {}, market = {} } = {}) {
  const c = {
    slug: 'rio-de-janeiro-rj', uf: 'rj', cslug: 'rio-de-janeiro', nome: 'Rio de Janeiro',
    stats: {}, chain: { hammer_over_asking: 0.5 },
    shapes: { nice: { CENTRO: 'Centro' }, d: { CENTRO: 'M0 0' }, of: {} },
    market, streets: { by: { CENTRO: ['main'] }, d: {
      main: { name: 'Rua Principal', slug: 'rua-principal', bairro: 'CENTRO', bairros: ['CENTRO'] },
    } }, lifecycle: {}, rows: [],
  };
  c.rows.push(row({ id: 'lot-1', src: 'caixa', bairro: 'CENTRO', end: 'Rua Principal, 10',
    tipo: 'apartamento', area: 60, preco: 100000, conf: 'ok', ring: 500, link, ...rowFields }));
  c.lifecycle['lot-1'] = { status: archived ? 'archived' : 'active', slug: 'lot-1', last_price_brl: 99000 };
  c.rows.push(row({ id: 'lot-related', src: 'caixa', bairro: 'CENTRO', end: 'Rua Principal, 20',
    tipo: 'apartamento', area: 60, preco: 105000, conf: 'ok', ring: 500 }));
  c.lifecycle['lot-related'] = { status: 'active', slug: 'lot-related', last_price_brl: 105000 };
  const payload = media === undefined ? undefined : { version: 1, cities: { [c.slug]: { 'lot-1': media } } };
  return { c, payload };
}

function runtime({ media, archived = false, link = null, reports = null, rowFields = {}, market = {}, mapKey } = {}) {
  const cat = JSON.parse(readFileSync(new URL('../i18n/en.json', import.meta.url)));
  const LANG = { code: 'en', langs: ['en'], names: { en: 'English' }, num: String, money: String,
    pct: String, plur: (key, n) => key + (n === 1 ? '.one' : '.other'),
    t: (key, vars = {}, fallback) => (cat[key] || fallback || key).replace(/\{(\w+)\}/g, (s, k) => vars?.[k] ?? s) };
  const { c, payload } = fixture(media, { archived, link, rowFields, market });
  const window = { __D__: { cols, cities: [c] }, __SHIP_LANGS__: ['en'] };
  if (mapKey) window.__MAPS__ = { embedKey: mapKey };
  if (payload) window.__D__.media = payload;
  if (reports) window.__D__.market_reports = reports;
  const ctx = vm.createContext({ window, LANG, URL, document: {} });
  vm.runInContext(functions, ctx);
  ctx.indexCity(c);
  return ctx;
}

test('renders ordered many-photo gallery, deduplicates resilient input, and lazy-loads non-primary images', () => {
  const html = runtime({ media: {
    gallery: [
      { url: 'https://img.example.test/second.jpg' },
      { url: 'https://img.example.test/first.jpg' },
      { url: 'https://img.example.test/second.jpg' },
      { url: 'http://not-approved.example/third.jpg' },
      { url: 'https://img.example.test/third.jpg?token=nope' },
    ],
  } }).screenLot('lot-1');
  assert.equal((html.match(/class="gallery-thumb"/g) || []).length, 2);
  assert.match(html, /data-gallery-hero src="https:\/\/img\.example\.test\/second\.jpg"/);
  assert.match(html, /data-gallery-index="1"[\s\S]*?src="https:\/\/img\.example\.test\/first\.jpg"[\s\S]*?loading="lazy"/);
  assert.match(html, /data-gallery-total="2"/);
  assert.match(html, /role="region" tabindex="0"/);
  assert.match(html, /data-gallery-prev/);
  assert.match(html, /data-gallery-next/);
  assert.match(html, /data-gallery-open aria-haspopup="dialog"/);
  assert.match(html, /data-gallery-lightbox hidden role="dialog" aria-modal="true"/);
  assert.match(html, /data-gallery-lightbox-prev/);
  assert.match(html, /data-gallery-lightbox-next/);
});

test('keeps the legacy photos/primary schema and hides controls for one image', () => {
  const html = runtime({ media: {
    photos: ['https://img.example.test/legacy.jpg', 'https://img.example.test/legacy.jpg'],
    primary_photo: 'https://img.example.test/legacy.jpg',
  } }).screenLot('lot-1');
  assert.equal((html.match(/data-gallery-hero/g) || []).length, 1);
  assert.match(html, /src="https:\/\/img\.example\.test\/legacy\.jpg"/);
  assert.match(html, /alt="Rua Principal, 10 — Centro, 1 of 1"/);
  assert.doesNotMatch(html, /gallery-controls|gallery-thumb/);
});

test('zero media preserves the existing one-photo fallback, while an absent fallback stays empty', () => {
  const fallback = runtime({ media: { gallery: [], photos: [], primary_photo: null },
    link: 'https://venda-imoveis.caixa.gov.br/imovel?hdnimovel=123' }).screenLot('lot-1');
  assert.match(fallback, /src="https:\/\/venda-imoveis\.caixa\.gov\.br\/fotos\/F12321\.jpg"/);
  const empty = runtime({ media: { gallery: [], photos: [], primary_photo: null } }).screenLot('lot-1');
  assert.doesNotMatch(empty, /data-gallery|class="shot"/);
});

test('archive pages use the same gallery and keep related lots beside it', () => {
  const html = runtime({ archived: true, media: {
    gallery: [{ url: 'https://img.example.test/archive.jpg' }],
  } }).screenLot('lot-1');
  assert.match(html, /data-gallery-hero/);
  assert.match(html, /class="sec related-lots"/);
  assert.match(html, /class="lot-gallery"/);
});

test('gallery keyboard semantics are present in the shipped markup and wiring', () => {
  const html = runtime({ media: {
    gallery: [{ url: 'https://img.example.test/a.jpg' }, { url: 'https://img.example.test/b.jpg' }],
  } }).screenLot('lot-1');
  assert.match(html, /type="button" class="gallery-control"/);
  assert.match(html, /aria-current="true"/);
  assert.match(source, /event\.key === "ArrowLeft"/);
  assert.match(source, /event\.key === "ArrowRight"/);
  assert.match(source, /event\.key === "Home"/);
  assert.match(source, /event\.key === "End"/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /touchstart/);
  assert.match(source, /data-gallery-lightbox/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /button\.focus\(\)/);
});

test('generated page template ships the gallery runtime without re-rendering the static map', async () => {
  const template = readFileSync(new URL('../v2/page.tpl.html', import.meta.url), 'utf8');
  const prerender = readFileSync(new URL('../../prerender.py', import.meta.url), 'utf8');
  assert.match(template, /<script src="\/v2\/app\.js" defer><\/script>/);
  assert.match(prerender, /"v2\/app\.js",/);

  const html = runtime({
    media: { gallery: [
      { url: 'https://img.example.test/a.jpg' },
      { url: 'https://img.example.test/b.jpg' },
    ] },
    mapKey: 'safe_key',
  }).screenLot('lot-1');
  const page = setup({ lang: 'en' });
  page.document.body.innerHTML = html;
  const context = vm.createContext(page.window);
  vm.runInContext(source, context);

  const gallery = page.document.querySelector('[data-gallery]');
  const hero = gallery.querySelector('[data-gallery-hero]');
  const lightbox = gallery.querySelector('[data-gallery-lightbox]');
  const next = gallery.querySelector('[data-gallery-next]');
  const maps = page.document.querySelectorAll('iframe');
  assert.equal(maps.length, 1);
  assert.match(maps[0].getAttribute('src'), /maps\/embed/);
  assert.equal(hero.getAttribute('src'), 'https://img.example.test/a.jpg');

  await next.click();
  assert.equal(hero.getAttribute('src'), 'https://img.example.test/b.jpg');
  const second = gallery.querySelectorAll('[data-gallery-index]')[1];
  assert.equal(second.getAttribute('aria-current'), 'true');
  assert.equal(second.focused, true);

  await gallery.querySelector('[data-gallery-open]').click();
  assert.equal(lightbox.hidden, false);
  assert.equal(lightbox.querySelector('[data-gallery-lightbox-image]').getAttribute('src'), 'https://img.example.test/b.jpg');
  await gallery.emit('keydown', { key: 'ArrowLeft' });
  assert.equal(hero.getAttribute('src'), 'https://img.example.test/a.jpg');
  await lightbox.emit('touchstart', { touches: [{ clientX: 200 }] });
  await lightbox.emit('touchend', { changedTouches: [{ clientX: 100 }] });
  assert.equal(hero.getAttribute('src'), 'https://img.example.test/b.jpg');
  await gallery.querySelector('.gallery-lightbox-close').click();
  assert.equal(lightbox.hidden, true);
  assert.equal(page.document.querySelectorAll('iframe').length, 1);
});

test('product hero puts financial facts, market evidence and one analysis anchor before the gallery', () => {
  const html = runtime({ media: { gallery: [{ url: 'https://img.example.test/a.jpg' }] }, reports: {
    'lot-1': { sale_asking: { min: 111000, max: 155000 }, sample: {
      count: 8, radius_m: 1000, freshness_days: 2, confidence: 'medium',
    } },
  }, link: 'https://example.test/lot' }).screenLot('lot-1');
  assert.match(html, /class="lot-above"><div class="lot-intro">/);
  assert.match(html, /class="hero-finance"/);
  assert.match(html, /opening bid/);
  assert.doesNotMatch(html, /Entrada real|Real entry price/);
  assert.match(html, /class="hero-market"/);
  assert.match(html, /8 listings in the sample/);
  assert.match(html, /radius: 1000/);
  assert.match(html, /checked 2 days ago/);
  assert.match(html, /asking prices from listings/);
  assert.match(html, /class="analysis-cta" data-analysis-cta/);
  assert.match(html, /class="source-link" href="https:\/\/example\.test\/lot"/);
  assert.ok(html.indexOf('class="analysis-cta"') < html.indexOf('class="lot-gallery"'));
  assert.ok(html.indexOf('class="source-link"') < html.indexOf('class="lot-gallery"'));
  assert.ok(html.indexOf('class="lot-gallery"') < html.indexOf('class="verdict"'));
  const css = readFileSync(new URL('../v2/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.lot-above\{display:flex; flex-direction:column/);
  assert.match(css, /\.lot-above\{display:grid; grid-template-columns:minmax\(0,1fr\) minmax\(440px,1fr\)/);
  assert.doesNotMatch(css, /\.lot-page > \.lot-history,[\s\S]{0,100}max-width:760px/);
});

test('a market report suppresses the legacy district asking hint on an unscored lot', () => {
  const html = runtime({
    reports: {
      'lot-1': { sale_asking: { min: 111000, max: 155000 }, sample: {
        count: 8, radius_m: 1000, freshness_days: 2, confidence: 'medium',
      } },
    },
    rowFields: { conf: 'no_comps', why: 'no_comps', ring: 5000 },
  }).screenLot('lot-1');
  assert.match(html, /No estimate shown/);
  assert.match(html, /asking prices from listings/);
  assert.doesNotMatch(html, /For scale:/);
});

test('transaction context translates the property kind on generated lot markup', () => {
  const html = runtime({ market: { year: '2025', d: { CENTRO: { f: [6000, 12] } } } }).screenLot('lot-1');
  assert.match(html, /Flats/);
  assert.doesNotMatch(html, /mkt\.kind\.f/);
});
