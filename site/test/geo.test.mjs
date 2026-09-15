import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../parts/geo.js', import.meta.url), 'utf8');
const cities = ['sao-paulo-sp', 'rio-de-janeiro-rj', 'recife-pe'].map(slug => ({ slug }));
const response = (body, ok = true) => ({ ok, json: async () => body, text: async () => body });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function harness({ storage = new Map(), base = '/casa', home = 'sao-paulo-sp', slotExists = true, noAbort = false } = {}) {
  const timers = [], requests = [], cityCalls = [], order = ['sao-paulo-sp', 'rio-de-janeiro-rj', 'recife-pe'];
  const slot = { html: `<article data-home-city="${home}"></article>`, querySelector(s) { return s === '[data-home-city]' ? { getAttribute: () => this.html.match(/data-home-city="([^"]+)/)?.[1] } : null; } };
  const note = { textContent: '' }, rows = new Map(order.map(slug => [slug, { slug, parentNode: { insertBefore(row) { const i = order.indexOf(row.slug); if (i >= 0) order.splice(i, 1); order.unshift(row.slug); } } }]));
  Object.defineProperty(slot, 'innerHTML', { get: () => slot.html, set: value => { slot.html = value; } });
  const listeners = {}, document = {
    readyState: 'complete',
    getElementById(id) { if (!slotExists) return null; return id === 'home-city-fragment' ? slot : id === 'geo-note' ? note : null; },
    querySelector(s) { const slug = s.match(/data-city="([^"]+)"/)?.[1]; return slug ? rows.get(slug) : null; },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
  };
  const fetch = (url, init) => { const d = deferred(); requests.push({ url, init, ...d }); return d.promise; };
  const sandbox = { document, fetch, __BASE__: base, __CITIES__: cities, LANG: { t: k => k }, CHROME: { setCity: s => cityCalls.push(s) }, localStorage: { getItem: k => storage.get(k) ?? null, setItem() {} }, setTimeout(fn) { const timer = { fn, cleared: false }; timers.push(timer); return timer; }, clearTimeout(timer) { if (timer) timer.cleared = true; }, window: null };
  if (!noAbort) sandbox.AbortController = AbortController;
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'geo.js' });
  return { ...sandbox, requests, timers, cityCalls, order, slot, note, async flush() { for (let round = 0; round < 3; round++) { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); } }, fireTimer(i = 0) { timers[i]?.fn(); }, click() { listeners.click?.forEach(fn => fn({ target: { closest: () => ({}) } })); } };
}

test('homepage geo selects Recife, then atomically updates fragment, header/map, note, and card order', async () => {
  const h = harness();
  assert.equal(h.requests.length, 1); assert.match(h.requests[0].url, /preco-real-geo.*\/city$/); assert.equal(h.requests[0].init.body, undefined);
  h.requests[0].resolve(response({ city: 'recife-pe', reason: 'nearest' })); await h.flush();
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].url, '/casa/_home/recife-pe.html'); assert.deepEqual(h.cityCalls, []);
  h.requests[1].resolve(response('<article data-home-city="recife-pe">Recife</article>')); await h.flush();
  assert.deepEqual(h.cityCalls, ['recife-pe']); assert.equal(h.slot.querySelector('[data-home-city]').getAttribute('data-home-city'), 'recife-pe'); assert.equal(h.note.textContent, 'geo.approx'); assert.equal(h.order[0], 'recife-pe');
});

test('valid manual city skips geo and loads only its fragment', async () => {
  const h = harness({ storage: new Map([['city', 'rio-de-janeiro-rj']]) }); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, '/casa/_home/rio-de-janeiro-rj.html');
  h.requests[0].resolve(response('<article data-home-city="rio-de-janeiro-rj">Rio</article>')); await h.flush(); assert.deepEqual(h.cityCalls, ['rio-de-janeiro-rj']); assert.equal(h.requests.filter(r => /workers\.dev/.test(r.url)).length, 0);
});

test('invalid saved city is ignored and uses geo', () => { const h = harness({ storage: new Map([['city', 'not-a-city']]) }); assert.equal(h.requests.length, 1); assert.match(h.requests[0].url, /workers\.dev\/city$/); });
test('deep pages do not make geo or fragment requests', () => { assert.equal(harness({ slotExists: false }).requests.length, 0); });

test('malformed geo response falls back to São Paulo without a nearest note', async () => {
  const h = harness(); h.requests[0].resolve(response({ city: 'recife-pe', reason: 'not-allowed' })); await h.flush(); assert.equal(h.requests.length, 1); assert.deepEqual(h.cityCalls, ['sao-paulo-sp']); assert.match(h.slot.html, /sao-paulo-sp/); assert.equal(h.note.textContent, '');
});

test('geo network error and timeout both use fallback, including without AbortController', async () => {
  const error = harness(); error.requests[0].resolve(Promise.reject(new Error('offline'))); await error.flush(); assert.equal(error.requests.length, 1); assert.deepEqual(error.cityCalls, ['sao-paulo-sp']);
  const noAbort = harness({ noAbort: true }); noAbort.fireTimer(0); await noAbort.flush(); assert.equal(noAbort.requests.length, 1); assert.deepEqual(noAbort.cityCalls, ['sao-paulo-sp']);
  const timeout = harness(); timeout.fireTimer(0); await timeout.flush(); assert.equal(timeout.requests.length, 1); assert.deepEqual(timeout.cityCalls, ['sao-paulo-sp']);
});

test('fragment 404 and timeout retain the matching São Paulo map/header/card', async () => {
  const failed = harness({ storage: new Map([['city', 'rio-de-janeiro-rj']]) }); failed.requests[0].resolve(response('', false)); await failed.flush(); assert.deepEqual(failed.cityCalls, []); assert.match(failed.slot.html, /sao-paulo-sp/); assert.equal(failed.order[0], 'sao-paulo-sp');
  const timed = harness({ storage: new Map([['city', 'rio-de-janeiro-rj']]) }); timed.fireTimer(0); await timed.flush(); assert.deepEqual(timed.cityCalls, []); assert.match(timed.slot.html, /sao-paulo-sp/);
});

test('manual click while geo is pending prevents the late inferred city overwrite', async () => { const h = harness(); h.click(); h.requests[0].resolve(response({ city: 'recife-pe', reason: 'nearest' })); await h.flush(); assert.equal(h.requests.length, 1); assert.deepEqual(h.cityCalls, []); assert.match(h.slot.html, /sao-paulo-sp/); });

test('manual click while a fragment is pending prevents its late overwrite', async () => { const h = harness({ storage: new Map([['city', 'rio-de-janeiro-rj']]) }); h.click(); h.requests[0].resolve(response('<article data-home-city="rio-de-janeiro-rj">late Rio</article>')); await h.flush(); assert.deepEqual(h.cityCalls, []); assert.match(h.slot.html, /sao-paulo-sp/); });

test('fragment body resolving after its timeout cannot overwrite the current São Paulo state', async () => { const h = harness({ storage: new Map([['city', 'rio-de-janeiro-rj']]) }); h.fireTimer(0); await h.flush(); assert.deepEqual(h.cityCalls, []); h.requests[0].resolve(response('<article data-home-city="rio-de-janeiro-rj">late Rio</article>')); await h.flush(); assert.deepEqual(h.cityCalls, []); assert.match(h.slot.html, /sao-paulo-sp/); });

test('root-subpath fragment URL is used and coordinates are never sent', async () => { const h = harness({ base: '/brasil' }); h.requests[0].resolve(response({ city: 'recife-pe', reason: 'default' })); await h.flush(); assert.equal(h.requests[1].url, '/brasil/_home/recife-pe.html'); assert.equal(Object.hasOwn(h.requests[0].init, 'body'), false); assert.doesNotMatch(h.requests[0].url, /lat|lon|coord/i); });
