import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../v2/app.js', import.meta.url), 'utf8');
const functions = source.split('/* ---- boot ')[0];
const cols = ['id', 'src', 'bairro', 'end', 'tipo', 'area', 'quartos', 'preco', 'hammer',
  'margin', 'mkt', 'aval', 'avalpct', 'n', 'ring', 'conf', 'jud', 'mod', 'data', 'link', 'promised', 'why'];
const row = fields => cols.map(key => fields[key] ?? null);

function note() {
  return {
    observed_at: '2026-10-08T10:00:00Z',
    body: { pt: ['Centro antigo.', 'Prédios baixos.'], en: ['Old centre.', 'Low-rise blocks.'],
      ru: ['Старый центр.', 'Малоэтажная застройка.'] },
    pros: { pt: ['Metrô'], en: ['Metro'], ru: ['Метро'] },
    cons: { pt: ['Ruído'], en: ['Noise'], ru: ['Шум'] },
    teaser: { pt: 'Centro denso e barato.', en: 'Dense, cheap centre.', ru: 'Плотный дешёвый центр.' },
    sources: [{ label: { pt: 'Fonte', en: 'Source', ru: 'Источник' },
      url: 'https://example.test/centro', observed_at: '2026-10-07T00:00:00Z' }],
  };
}

function fixture(withNote) {
  const c = {
    slug: 'rio-de-janeiro-rj', uf: 'rj', cslug: 'rio-de-janeiro', nome: 'Rio de Janeiro',
    cidade: 'RIO DE JANEIRO', stats: { lots: 2 }, chain: {}, market: {},
    shapes: { unit: 'district', nice: { CENTRO: 'Centro' }, d: { CENTRO: 'M0 0 10 0 10 10 0 10Z' },
      at: { CENTRO: [5, 5, 0, 0, 10, 10] }, of: {}, box: [0, 0, 10, 10], cols: 10, rows: 10 },
    streets: {}, lifecycle: {}, rows: [],
  };
  // Two thin lots: well below the ten the district would need to be indexable on its own.
  for (const id of ['a', 'b']) {
    c.rows.push(row({ id, src: 'caixa', bairro: 'CENTRO', end: 'Rua Principal, ' + id, tipo: 'apartamento',
      area: 60, preco: 100000, data: '2099-01-01' }));
    c.lifecycle[id] = { status: 'active', slug: 'lot-' + id };
  }
  return { c, notes: withNote ? { 'rio-de-janeiro-rj': { CENTRO: note() } } : undefined };
}

function runtime({ c, notes }, lang = 'en') {
  const cat = JSON.parse(readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url)));
  const LANG = { code: lang, langs: [lang], names: { [lang]: lang }, num: String, money: String,
    pct: String, plur: (key, n) => cat[`${key}.${n === 1 ? 'one' : 'other'}`] || key,
    t: (key, vars = {}, fallback) => (cat[key] || fallback || `[${key}]`).replace(/\{(\w+)\}/g, (s, k) => vars?.[k] ?? s) };
  const window = { __D__: { cols, cities: [c], district_notes: notes }, __SHIP_LANGS__: [lang] };
  const ctx = vm.createContext({ window, LANG, URL, document: {
    createElement: () => ({ innerHTML: '', querySelectorAll: () => [] }),
  } });
  vm.runInContext(functions, ctx);
  ctx.indexCity(c);
  ctx.dateReference = '2026-10-08';
  return ctx;
}

test('a district page renders its reviewed note before the inventory, in the reader language', () => {
  const ctx = runtime(fixture(true));
  const html = ctx.screenArea('CENTRO');
  const at = html.indexOf('class="mkt district-note"');
  assert.ok(at > 0, 'note block present');
  assert.ok(at < html.indexOf('class="sec"'), 'note comes before the lot list');
  assert.match(html, /<h2>Living in Centro<\/h2>/);
  assert.match(html, /<p>Old centre\.<\/p><p>Low-rise blocks\.<\/p>/);
  assert.match(html, /<h3>Upsides<\/h3><ul><li>Metro<\/li><\/ul>/);
  assert.match(html, /<h3>Watch-outs<\/h3><ul><li>Noise<\/li><\/ul>/);
  assert.match(html, /href="https:\/\/example\.test\/centro"[^>]*rel="noopener noreferrer nofollow">Source<\/a>/);
  assert.match(html, /text reviewed 2026-10-08/);
  const ru = runtime(fixture(true), 'ru').screenArea('CENTRO');
  assert.match(ru, /Как живётся в районе Centro/);
  assert.match(ru, /<p>Старый центр\.<\/p>/);
});

test('without a note nothing is rendered and the thin district stays out of the index', () => {
  const ctx = runtime(fixture(false));
  assert.doesNotMatch(ctx.screenArea('CENTRO'), /district-note/);
  assert.equal(ctx.areaSeoEligible('CENTRO'), false);
  assert.equal(ctx.headFor(ctx.href('/a/CENTRO')).noindex, true);
  assert.doesNotMatch(ctx.screenCity(), /district-notes/);
});

test('a note makes the district indexable and lends its teaser to the description', () => {
  const ctx = runtime(fixture(true));
  assert.equal(ctx.areaSeoEligible('CENTRO'), true);
  const head = ctx.headFor(ctx.href('/a/CENTRO'));
  assert.equal(head.noindex, undefined);
  assert.equal(head.desc, 'Dense, cheap centre. 2 lots at auction in Centro, Rio de Janeiro.');
});

test('the city page lists noted districts with their teasers as links', () => {
  const ctx = runtime(fixture(true));
  const html = ctx.screenCity();
  assert.match(html, /<h2>Districts at auction, in brief<\/h2>/);
  assert.match(html, /class="row noted" href="[^"]*\/rio-de-janeiro\/centro\/"[^>]*>.*?<span class="nm">Centro<\/span><span class="pill mute">2 lots<\/span><\/div><div class="sub">Dense, cheap centre\.<\/div><\/a>/s);
});

test('a malformed note is ignored rather than rendered', () => {
  const f = fixture(true);
  f.notes['rio-de-janeiro-rj'].CENTRO.sources[0].url = 'javascript:alert(1)';
  f.notes['rio-de-janeiro-rj'].CENTRO.body.en = [];
  const ctx = runtime(f);
  // An empty body in the reader language invalidates the note entirely.
  assert.equal(ctx.districtNote('CENTRO'), null);
  assert.doesNotMatch(ctx.screenArea('CENTRO'), /district-note/);
  const g = fixture(true);
  g.notes['rio-de-janeiro-rj'].CENTRO.sources[0].url = 'javascript:alert(1)';
  const html = runtime(g).screenArea('CENTRO');
  assert.match(html, /district-note/);
  assert.doesNotMatch(html, /javascript:/);
});
