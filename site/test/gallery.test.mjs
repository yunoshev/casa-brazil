import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../v2/app.js', import.meta.url), 'utf8');
const functions = source.split('/* ---- boot ')[0];
const cols = ['id', 'src', 'bairro', 'end', 'tipo', 'area', 'quartos', 'preco', 'hammer',
  'margin', 'mkt', 'aval', 'avalpct', 'n', 'ring', 'conf', 'jud', 'mod', 'data', 'link', 'promised', 'why'];
const row = fields => cols.map(key => fields[key] ?? null);

function fixture(media, { archived = false, link = null } = {}) {
  const c = {
    slug: 'rio-de-janeiro-rj', uf: 'rj', cslug: 'rio-de-janeiro', nome: 'Rio de Janeiro',
    stats: {}, chain: { hammer_over_asking: 0.5 },
    shapes: { nice: { CENTRO: 'Centro' }, d: { CENTRO: 'M0 0' }, of: {} },
    market: {}, streets: { by: { CENTRO: ['main'] }, d: {
      main: { name: 'Rua Principal', slug: 'rua-principal', bairro: 'CENTRO', bairros: ['CENTRO'] },
    } }, lifecycle: {}, rows: [],
  };
  c.rows.push(row({ id: 'lot-1', src: 'caixa', bairro: 'CENTRO', end: 'Rua Principal, 10',
    tipo: 'apartamento', area: 60, preco: 100000, conf: 'ok', ring: 500, link }));
  c.lifecycle['lot-1'] = { status: archived ? 'archived' : 'active', slug: 'lot-1', last_price_brl: 99000 };
  c.rows.push(row({ id: 'lot-related', src: 'caixa', bairro: 'CENTRO', end: 'Rua Principal, 20',
    tipo: 'apartamento', area: 60, preco: 105000, conf: 'ok', ring: 500 }));
  c.lifecycle['lot-related'] = { status: 'active', slug: 'lot-related', last_price_brl: 105000 };
  const payload = media === undefined ? undefined : { version: 1, cities: { [c.slug]: { 'lot-1': media } } };
  return { c, payload };
}

function runtime({ media, archived = false, link = null } = {}) {
  const cat = JSON.parse(readFileSync(new URL('../i18n/en.json', import.meta.url)));
  const LANG = { code: 'en', langs: ['en'], names: { en: 'English' }, num: String, money: String,
    pct: String, plur: (key, n) => key + (n === 1 ? '.one' : '.other'),
    t: (key, vars = {}, fallback) => (cat[key] || fallback || key).replace(/\{(\w+)\}/g, (s, k) => vars?.[k] ?? s) };
  const { c, payload } = fixture(media, { archived, link });
  const window = { __D__: { cols, cities: [c] }, __SHIP_LANGS__: ['en'] };
  if (payload) window.__D__.media = payload;
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
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /button\.focus\(\)/);
});
