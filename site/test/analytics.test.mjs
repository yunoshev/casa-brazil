import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, response, until } from './dom.mjs';

const emitted = s => (s.window.dataLayer || []).filter(e => e[0] === 'event');
const count = (s, name) => emitted(s).filter(e => e[1] === name).length;

for (const lang of ['pt', 'en', 'ru']) test(`consent labels and no Google before acceptance: ${lang}`, async () => {
  const s = setup({ lang, loading: true, noLang: true });
  s.load('analytics');
  assert.equal(s.window.dataLayer, undefined);
  assert.equal(s.document.head.children.length, 0);
  s.window.LANG = { code: lang, t: s.translate };
  await s.document.emit('DOMContentLoaded');
  const panel = s.document.body.querySelector('aside');
  assert.ok(panel.textContent.includes(s.translate('analytics.reject')));
  assert.doesNotMatch(panel.textContent, /\[analytics\./);
  s.window.track('analyze_edital', { stage: 'start' });
  s.window.ANALYTICS.setConsent('rejected');
  assert.equal(s.window.dataLayer, undefined);
  const next = setup({ lang, storage: s.data }); next.load('analytics');
  assert.equal(next.window.ANALYTICS.getConsent(), 'rejected');
  assert.equal(next.document.head.children.length, 0);
  next.window.ANALYTICS.setConsent('accepted');
  next.window.ANALYTICS.setConsent('accepted');
  assert.equal(next.document.head.children.length, 1);
  assert.equal(count(next, 'analyze_edital'), 0, 'pre-consent events are discarded');
  next.window.ANALYTICS.setConsent('rejected');
  const before = emitted(next).length;
  next.window.track('analyze_edital', { stage: 'ok' });
  assert.equal(emitted(next).length, before);
  assert.equal(next.window['ga-disable-G-TEST123'], true);
  await next.document.body.querySelector('button').emit('click');
  assert.equal(next.document.body.querySelector('aside').hidden, false);
});

test('explicit stream assertion, ID and online HTTPS are required; CF does not load', () => {
  for (const options of [{ analyticsConfig: {} }, { analyticsConfig: { ga4: 'G-TEST123' } },
    { analyticsConfig: { cf: 'example' } }, { url: 'http://localhost:8000/' }]) {
    const s = setup(options); s.load('analytics'); s.window.ANALYTICS.setConsent('accepted');
    assert.equal(s.document.head.children.length, 0);
    assert.equal(s.window.dataLayer, undefined);
  }
});

test('event and config payloads redact URLs, query, fragments, addresses and arbitrary fields', () => {
  const s = setup({ url: 'https://example.org/casa-brazil/leilao-de-imoveis/rj/rio-de-janeiro/lote/secret-address/?email=private@example.org#ticket', referrer: 'https://www.google.com/search?q=private@example.org' });
  s.load('analytics'); s.window.ANALYTICS.setConsent('accepted');
  s.window.track('analyze_edital', { stage: 'error', reason: 'private@example.org', email: 'private@example.org', visitor_id: 'secret-id', url: 'https://www.caixa.gov.br/private.pdf' });
  s.window.track('lot_outbound', { source: 'caixa', page: '/private@example.org', page_location: 'leak', page_title: 'leak' });
  s.window.track('unknown', { email: 'private@example.org' });
  const serial = JSON.stringify(s.window.dataLayer.map(e => Array.from(e)));
  assert.doesNotMatch(serial, /private@|secret-address|secret-id|private\.pdf|ticket|leak/);
  assert.equal(emitted(s).find(e => e[1] === 'analyze_edital')[2].reason, 'unknown');
  const cfg = s.window.dataLayer.find(e => e[0] === 'config')[2];
  assert.equal(cfg.send_page_view, false);
  assert.equal(cfg.allow_google_signals, false);
  assert.equal(count(s, 'unknown'), 0);
});

test('unchanged analysis POST works without consent; old start/ok/error events are sanitized', async () => {
  let fail = false;
  const s = setup({ fetch: () => fail ? response(503, { error: 'private@example.org' }) : response(200, { resumo: 'Test result', dividas: {}, ocupado: 'incerto', confianca: 'baixa' }) });
  s.load('analytics'); s.load('analyze');
  await s.analyze();
  await until(() => s.box.querySelector('.azout').innerHTML.includes('Test result'));
  assert.deepEqual(Object.keys(s.requests[0].json).sort(), ['id', 'url']);
  assert.equal(s.requests[0].url, 'https://preco-real-analyze.preco-real.workers.dev/analyze');
  assert.equal(s.window.dataLayer, undefined);
  s.window.ANALYTICS.setConsent('accepted');
  await s.analyze(); await until(() => emitted(s).some(e => e[1] === 'analyze_edital' && e[2].stage === 'ok'));
  fail = true;
  await s.analyze(); await until(() => emitted(s).some(e => e[1] === 'analyze_edital' && e[2].stage === 'error'));
  assert.doesNotMatch(JSON.stringify(s.window.dataLayer.map(e => Array.from(e))), /private@|public\.pdf/);
});

test('late form and shell navigation are observed; CTA requires visibility and counts once', () => {
  const s = setup(); s.load('analytics'); s.window.ANALYTICS.setConsent('accepted');
  s.load('analyze'); s.window.notifyMutation();
  s.observers[0].show(false); assert.equal(count(s, 'analysis_cta_view'), 0);
  s.observers[0].show(); s.window.notifyMutation(); s.observers[0].show();
  assert.equal(count(s, 'analysis_cta_view'), 1);
  assert.equal(count(s, 'lot_view'), 1);
  s.window.location.pathname = '/casa-brazil/leilao-de-imoveis/rj/rio-de-janeiro/lote/second/';
  s.window.notifyMutation(); s.observers[0].show();
  assert.equal(count(s, 'lot_view'), 2);
  assert.equal(count(s, 'analysis_cta_view'), 2);
});

test('root/subpath city, archive and paginated routes keep safe classifications and source events', async () => {
  for (const base of ['', '/casa-brazil']) for (const [tail, type] of [['', 'city'], ['arquivo/', 'archive'], ['arquivo/pagina/2/', 'archive'], ['todos-os-lotes/pagina/2/', 'all']]) {
    const s = setup({ url: `https://example.org${base}/leilao-de-imoveis/sp/sao-paulo/${tail}` });
    s.load('analytics'); s.window.ANALYTICS.setConsent('accepted');
    assert.equal(count(s, 'lot_view'), 0);
    assert.equal(emitted(s).find(e => e[1] === 'page_view')[2].page_type, type);
    for (const [attr, value, name] of [['data-city', 'recife-pe', 'city_switch'], ['data-lang', 'ru', 'lang_switch'], ['data-out', 'caixa', 'lot_outbound']]) {
      const el = s.document.createElement('a'); el.setAttribute(attr, value);
      await s.document.emit('click', { target: el }); assert.equal(count(s, name), 1);
    }
  }
});

test('all analytics translation literals exist in the three shipped catalogues', () => {
  const script = readFileSync(new URL('../parts/analytics.js', import.meta.url), 'utf8');
  const keys = [...script.matchAll(/"(analytics\.[a-z_]+)"/g)].map(m => m[1]);
  for (const lang of ['pt', 'en', 'ru']) {
    const cat = JSON.parse(readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const key of keys) assert.equal(typeof cat[key], 'string', `${lang}: ${key}`);
  }
});

test('every public source retains its outbound attribution', async () => {
  const data = JSON.parse(readFileSync(new URL('../../data/site.json', import.meta.url), 'utf8'));
  const index = data.cols.indexOf('src');
  const sources = new Set(data.cities.flatMap(c => c.rows.map(r => r[index])));
  const s = setup(); s.load('analytics'); s.window.ANALYTICS.setConsent('accepted');
  for (const source of sources) {
    const link = s.document.createElement('a'); link.setAttribute('data-out', source);
    await s.document.emit('click', { target: link });
    assert.equal(emitted(s).at(-1)[2].source, source);
  }
});
