// Offline contract tests for source-snapshot media and the explicit Maps tap.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../site/v2/app.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function safeHttpsURL'), source.indexOf('/* ---- colour'));
const staticModule = readFileSync(new URL('../site/parts/lot-media.js', import.meta.url), 'utf8');
const staticPage = readFileSync(new URL('../site/v2/page.tpl.html', import.meta.url), 'utf8');
const staticIndex = readFileSync(new URL('../site/v2/index.tpl.html', import.meta.url), 'utf8');
const prerender = readFileSync(new URL('../prerender.py', import.meta.url), 'utf8');
const strings = {
  'lot.fallback': 'Lot', 'lot.photo.alt': 'Property photo: {what}',
  'lot.gallery.note': 'Images from the source snapshot.', 'lot.gallery.prev': 'Previous',
  'lot.gallery.next': 'Next', 'lot.map.h2': 'Map', 'lot.map.note': 'Approximate address search.',
  'lot.map.load': 'Load Google map', 'lot.map.hide': 'Hide map',
  'lot.map.external': 'Open search in Google Maps', 'lot.map.iframe': 'Map of the reported address',
};
function t(key, values = {}) { return (strings[key] || key).replace(/\{(\w+)\}/g, (_, k) => values[k] || ''); }
function title(s) { return String(s); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

class Node {
  constructor(classes = []) { this.classes = classes; this.listeners = {}; this.children = []; this.attrs = {}; this.dataset = {}; this.className = classes.join(' '); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, event = {}) { for (const fn of this.listeners[name] || []) fn({ preventDefault() {}, ...event }); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  querySelector(selector) { return selector === 'iframe' ? this.children.find(x => x.tagName === 'iframe') || null : this.nodes?.[selector] || null; }
  querySelectorAll(selector) { return this.lists?.[selector] || []; }
  appendChild(node) { this.children.push(node); return node; }
  remove() { this.removed = true; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text || ''; }
}
function runtime(media = {}, key = 'test key') {
  const document = new Node();
  document.readyState = 'complete'; document.documentElement = new Node();
  document.createElement = tag => { const n = new Node(); n.tagName = tag; return n; };
  const sandbox = {
    URL, encodeURIComponent, city: { slug: 'sao-paulo-sp', nome: 'São Paulo', uf: 'SP', media },
    C: { id: 0, src: 1, end: 2, tipo: 3, link: 4 }, t, title, esc,
    window: { __MAPS__: key ? { embedKey: key } : {}, LANG: { t } }, document,
    MutationObserver: class { constructor() {} observe() {} },
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(helpers + staticModule + '; window.api={mediaForLot,gallery,lotMap,mapQueryForLot,wireLotMedia: window.LOT_MEDIA.wire};', sandbox);
  return sandbox.window.api;
}
const lot = ['lot-1', 'zuk', 'Rua Segura, 12', 'apartamento', 'https://example.test/lot'];

test('source projection accepts only credential-free https URLs and never makes a gallery from guesses', () => {
  const api = runtime({ 'lot-1': { photos: ['https://images.example/a.jpg', 'http://bad.example/a.jpg', 'https://u:p@bad.example/a.jpg', 'javascript:alert(1)', 'https://images.example/a.jpg'] } });
  assert.deepEqual(Array.from(api.mediaForLot(lot)), ['https://images.example/a.jpg']);
  const html = api.gallery(lot);
  assert.match(html, /images\.example\/a\.jpg/);
  assert.doesNotMatch(html, /onerror=|<script|javascript:/i);
  assert.match(html, /source snapshot/);
});

test('known Caixa cover is one fallback, while non-Caixa zero coverage renders no gallery', () => {
  const api = runtime();
  assert.equal(api.gallery(lot), '');
  const caixa = ['caixa-1', 'caixa', 'Rua Fonte, 7', 'casa', 'https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=12345'];
  const html = api.gallery(caixa);
  assert.match(html, /F1234521\.jpg/);
  assert.equal((html.match(/gallery-image/g) || []).length, 1);
});

test('gallery buttons and arrow keys change the announced count; a broken image is removed safely', () => {
  const api = runtime();
  const one = new Node(['gallery-image']), two = new Node(['gallery-image']);
  const previous = new Node(['gallery-prev']), next = new Node(['gallery-next']), count = new Node(['gallery-count']);
  const gallery = new Node();
  gallery.lists = { '.gallery-image': [one, two] };
  gallery.nodes = { '.gallery-prev': previous, '.gallery-next': next, '.gallery-count': count };
  const root = new Node(); root.lists = { '[data-lot-thumb]': [], '[data-gallery]': [gallery], '[data-lot-map]': [] };
  api.wireLotMedia(root);
  next.emit('click');
  assert.equal(count.textContent, '2 / 2');
  assert.match(one.className, /hid/);
  gallery.emit('keydown', { key: 'ArrowLeft' });
  assert.equal(count.textContent, '1 / 2');
  two.emit('error');
  assert.equal(two.removed, true);
  assert.equal(count.textContent, '1 / 1');
  assert.doesNotMatch(one.className, /hid/);
});

test('map is absent without a key, uses a documented address rather than coordinates, and loads only after a tap', () => {
  const noKey = runtime({}, '');
  assert.match(noKey.lotMap(lot), /data-lot-map[^>]*hidden/);
  assert.equal(noKey.mapQueryForLot(['x', 'zuk', 'Rua Cortada… 12', 'casa', 'https://example.test']), null);

  const api = runtime();
  const button = new Node(['map-load']), frame = new Node(['lot-map-frame']), map = new Node();
  map.attrs['data-map-query'] = 'Rua Segura, 12, São Paulo - SP, Brasil';
  map.nodes = { '.map-load': button, '.lot-map-frame': frame };
  const root = new Node(); root.lists = { '[data-lot-thumb]': [], '[data-gallery]': [], '[data-lot-map]': [map] };
  api.wireLotMedia(root);
  assert.equal(frame.querySelector('iframe'), null);
  button.emit('click');
  const iframe = frame.querySelector('iframe');
  assert.ok(iframe);
  assert.equal(iframe.src, 'https://www.google.com/maps/embed/v1/place?key=test%20key&q=Rua%20Segura%2C%2012%2C%20S%C3%A3o%20Paulo%20-%20SP%2C%20Brasil');
  assert.equal(button.textContent, 'Hide map');
  button.emit('click');
  assert.equal(frame.querySelector('iframe'), null);
  assert.equal(button.textContent, 'Load Google map');
});

test('the same module is shipped on prerendered pages and the SPA shell', () => {
  assert.match(staticPage, /src="\/parts\/lot-media\.js" defer/);
  assert.match(staticIndex, /src="\/parts\/lot-media\.js"/);
  assert.match(prerender, /"parts\/lot-media\.js"/);
});
