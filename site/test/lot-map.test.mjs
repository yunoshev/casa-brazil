import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../v2/app.js', import.meta.url), 'utf8');
const functions = source.split('/* ---- boot ')[0];
const cols = ['id', 'src', 'bairro', 'end', 'tipo', 'area', 'quartos', 'preco', 'hammer',
  'margin', 'mkt', 'aval', 'avalpct', 'n', 'ring', 'conf', 'jud', 'mod', 'data', 'link', 'promised', 'why'];
const row = fields => cols.map(key => fields[key] ?? null);

function runtime({ key, address = '  Rua Principal,   10  ' } = {}) {
  const cat = JSON.parse(readFileSync(new URL('../i18n/en.json', import.meta.url)));
  const city = {
    slug: 'rio-de-janeiro-rj', uf: 'rj', cslug: 'rio-de-janeiro', nome: 'Rio de Janeiro',
    stats: {}, chain: { hammer_over_asking: 0.5 }, market: {},
    shapes: { nice: { CENTRO: 'Centro' }, d: { CENTRO: 'M0 0' }, of: {} },
    streets: { by: { CENTRO: [] }, d: {} }, lifecycle: {}, rows: [],
  };
  city.rows.push(row({ id: 'lot-1', src: 'caixa', bairro: 'CENTRO', end: address,
    tipo: 'apartamento', area: 60, preco: 100000, conf: 'ok', ring: 500 }));
  city.lifecycle['lot-1'] = { status: 'active', slug: 'lot-1' };
  const LANG = { code: 'en', langs: ['en'], names: { en: 'English' }, num: String, money: String,
    pct: String, plur: value => value,
    t: (name, vars = {}, fallback) => (cat[name] || fallback || name)
      .replace(/\{(\w+)\}/g, (match, part) => vars?.[part] ?? match) };
  const created = [];
  const document = { createElement(tag) {
    const element = { tag, attrs: {}, setAttribute(name, value) { this.attrs[name] = String(value); } };
    created.push(element); return element;
  } };
  const window = { __D__: { cols, cities: [city] }, __SHIP_LANGS__: ['en'] };
  if (key !== undefined) window.__MAPS__ = { embedKey: key };
  const ctx = vm.createContext({ window, LANG, URL, document });
  vm.runInContext(functions, ctx);
  ctx.indexCity(city);
  return { ctx, created };
}

test('keeps the safe external Maps link and omits embed UI without a valid key', () => {
  for (const key of [undefined, '', 'bad key', '<script>', 'a'.repeat(201)]) {
    const html = runtime({ key }).ctx.screenLot('lot-1');
    assert.match(html, /https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=/);
    assert.doesNotMatch(html, /data-lot-map-load/);
    assert.doesNotMatch(html, /maps\/embed\/v1\/place/);
  }
});

test('creates one lazy embed iframe only after the user clicks', () => {
  const { ctx, created } = runtime({ key: 'AIza_safe-key_123' });
  const html = ctx.screenLot('lot-1');
  assert.match(html, /data-lot-map-load/);
  assert.doesNotMatch(html, /maps\/embed\/v1\/place/);

  const listeners = {};
  const button = { disabled: false, hidden: false, addEventListener(name, fn) { listeners[name] = fn; } };
  const children = [];
  const frame = { querySelector(selector) { return selector === 'iframe' ? children[0] || null : null; },
    appendChild(child) { children.push(child); } };
  const block = { getAttribute(name) { return name === 'data-map-query' ? 'Rua Principal, 10, Rio de Janeiro, RJ, Brasil' : null; },
    querySelector(selector) { return selector === '[data-lot-map-load]' ? button : frame; } };
  const root = { querySelector() { return block; } };
  ctx.wireLotMap(root);
  assert.equal(created.length, 0);
  listeners.click();
  listeners.click();
  assert.equal(created.length, 1);
  assert.equal(children.length, 1);
  assert.equal(created[0].attrs.src,
    'https://www.google.com/maps/embed/v1/place?key=AIza_safe-key_123&q=Rua%20Principal%2C%2010%2C%20Rio%20de%20Janeiro%2C%20RJ%2C%20Brasil');
  assert.equal(created[0].attrs.loading, 'lazy');
  assert.equal(created[0].attrs.referrerpolicy, 'strict-origin-when-cross-origin');
  assert.equal(created[0].attrs.title, 'Map of the property address');
});

test('normalizes and encodes the exact lot address without allowing markup injection', () => {
  const { ctx, created } = runtime({ key: 'safe_key', address: ' Rua <img src=x onerror=alert(1)>   7 & 9 ' });
  const html = ctx.screenLot('lot-1');
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /data-map-query="Rua &lt;img src=x onerror=alert\(1\)&gt; 7 &amp; 9, Rio de Janeiro, RJ, Brasil"/);
  assert.match(html, /query=Rua%20%3Cimg%20src%3Dx%20onerror%3Dalert\(1\)%3E%207%20%26%209%2C%20Rio%20de%20Janeiro%2C%20RJ%2C%20Brasil/);

  const listeners = {}, children = [];
  const button = { addEventListener(name, fn) { listeners[name] = fn; } };
  const frame = { querySelector() { return children[0] || null; }, appendChild(child) { children.push(child); } };
  const raw = 'Rua <img src=x onerror=alert(1)> 7 & 9, Rio de Janeiro, RJ, Brasil';
  const block = { getAttribute() { return raw; },
    querySelector(selector) { return selector === '[data-lot-map-load]' ? button : frame; } };
  ctx.wireLotMap({ querySelector() { return block; } });
  listeners.click();
  assert.equal(created[0].attrs.src,
    'https://www.google.com/maps/embed/v1/place?key=safe_key&q=' + encodeURIComponent(raw));
  assert.doesNotMatch(created[0].attrs.src, /<|>|\s/);
});
