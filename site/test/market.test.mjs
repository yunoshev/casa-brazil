import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setup } from './dom.mjs';

const valid = {
  schema: 'market-v1', currency: 'BRL',
  sale_asking: { min: 280000, max: 350000 }, discount_pct: 18.5,
  rent_monthly: { min: 1800, max: 2300 }, yield_pct: 7.8,
  condo_monthly: { min: 350, max: 520 },
  sample: { count: 28, radius_m: 1000, freshness_days: 3, confidence: 'medium' },
  disclaimer: 'A amostra usa anúncios de venda e não confirma preços pagos.'
};

function browser(lang = 'pt') {
  const s = setup({ lang });
  const context = vm.createContext(s.window);
  vm.runInContext(readFileSync(new URL('../parts/market.js', import.meta.url), 'utf8'), context);
  return s;
}

test('strict market-v1 allowlist accepts the report and rejects drift', () => {
  const s = browser();
  assert.equal(s.window.MARKET.validateReport(valid), true);
  for (const bad of [
    { ...valid, extra: true },
    { ...valid, schema: 'market-v2' },
    { ...valid, currency: 'USD' },
    { ...valid, sale_asking: { min: 350000, max: 280000 } },
    { ...valid, sale_asking: { ...valid.sale_asking, source: 'sale' } },
    { ...valid, sample: { ...valid.sample, confidence: 'certain' } },
    { ...valid, disclaimer: '' },
    { ...valid, rent_monthly: { min: 0, max: 100000001 } },
    { ...valid, sample: { ...valid.sample, count: 1.5 } },
  ]) assert.equal(s.window.MARKET.validateReport(bad), false);
});

for (const lang of ['pt', 'en', 'ru']) test(`${lang}: renders facts with text nodes and honest disclaimer`, () => {
  const s = browser(lang);
  const root = s.document.createElement('div');
  assert.equal(s.window.MARKET.mount(root, valid, s.document), true);
  const report = root.querySelector('[data-market-report]');
  assert.ok(report);
  assert.equal(report.querySelector('h2').textContent, s.translate('market.title'));
  assert.match(report.textContent, /280/);
  assert.match(report.textContent, /350/);
  assert.match(report.textContent, /18/);
  assert.match(report.textContent, /28/);
  assert.match(report.textContent, /1000/);
  assert.match(report.textContent, /3/);
  assert.match(report.textContent, /anúncios|listings|объявлен/i);
  assert.match(report.textContent, /não confirma preços pagos|not completed sale prices|не подтверждает цены сделок/i);
  assert.equal(report.querySelectorAll('script').length, 0);
  assert.equal(report.querySelectorAll('img').length, 0);
});

test('optional rent, yield and condo facts render as absent without inventing values', () => {
  const s = browser('en');
  const root = s.document.createElement('div');
  const report = { ...valid, rent_monthly: null, yield_pct: null, condo_monthly: null, discount_pct: null };
  assert.equal(s.window.MARKET.mount(root, report, s.document), true);
  const text = root.textContent;
  assert.doesNotMatch(text, /Rent|Yield|Condo/);
  assert.match(text, /not reported/);
});

test('fewer than five comparables shows translated insufficient data, never a market estimate', () => {
  const s = browser('en');
  const root = s.document.createElement('div');
  const sparse = { ...valid, sample: { ...valid.sample, count: 4 } };
  assert.equal(s.window.MARKET.validateReport(sparse), true, 'the DTO remains a valid source record');
  assert.equal(s.window.MARKET.mount(root, sparse, s.document), true);
  assert.match(root.textContent, /Insufficient comparable listings \(4\)/);
  assert.equal(root.querySelector('.market-facts'), null);
  assert.doesNotMatch(root.textContent, /280000|350000/);
});

test('renderer is inert without a valid report and never calls network APIs', () => {
  const s = browser();
  s.window.fetch = () => { throw new Error('network must not be called'); };
  const root = s.document.createElement('div');
  assert.equal(s.window.MARKET.mount(root, { ...valid, sample: null }, s.document), false);
  assert.equal(root.children.length, 0);
});

test('all market runtime keys exist in all public catalogues and JSON parses', () => {
  const script = readFileSync(new URL('../parts/market.js', import.meta.url), 'utf8');
  const keys = [...script.matchAll(/translate\("(market\.[a-z0-9_.]+)"/g)].map(m => m[1]);
  for (const lang of ['pt', 'en', 'ru']) {
    const catalog = JSON.parse(readFileSync(new URL('../i18n/' + lang + '.json', import.meta.url), 'utf8'));
    for (const key of keys) assert.equal(typeof catalog[key], 'string', `${lang}:${key}`);
  }
});
