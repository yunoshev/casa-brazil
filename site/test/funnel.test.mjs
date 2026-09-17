// Actual public HEAD 9b8f495 consent/analysis regressions are retained verbatim.
// This entry runs them plus useful non-duplicated checks from the earlier
// private funnel. Former email/DO behavior is covered by archived Worker
// fixtures, never re-enabled in the public consumer.
import './analytics.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, response, deferred, until } from './dom.mjs';

const result = { resumo: '<script>unsafe</script>', ocupado: 'incerto',
  dividas: { iptu: 'unknown', condominio: 'unknown', outras: [] }, confianca: 'baixa',
  aviso: 'Verify the document.', riscos: [], fase: 'Unknown', source_scope: 'lot_specific',
  _meta: { cached: true, analyzed_at: '2026-09-15T12:00:00Z' } };
const count = (s, name) => s.events.filter(e => e.name === name).length;

test('all shipped runtime literals exist in each catalogue; no hosts mistaken for i18n keys', () => {
  const prerender = readFileSync(new URL('../../prerender.py', import.meta.url), 'utf8');
  const assets = prerender.match(/ASSETS = \(([\s\S]*?)\n\)/)[1];
  const files = [...assets.matchAll(/"([^"]+\.js)"/g)].map(m => m[1]);
  assert.ok(files.includes('parts/analytics.js'));
  const sources = files.map(f => readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n');
  const keys = [...sources.matchAll(/["']([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)["']/g)].map(m => m[1]);
  assert.ok(keys.includes('nav.theme'));
  const cats = ['pt', 'en', 'ru'].map(lang => JSON.parse(readFileSync(new URL('../i18n/' + lang + '.json', import.meta.url))));
  for (const cat of cats) for (const key of keys) assert.equal(typeof cat[key], 'string', key);
  const scoped = cat => Object.keys(cat).filter(k => /^(az|analytics)\./.test(k)).sort();
  assert.deepEqual(scoped(cats[0]), scoped(cats[1])); assert.deepEqual(scoped(cats[0]), scoped(cats[2]));
});

for (const lang of ['pt', 'en', 'ru']) test('escaped result and acknowledged same-key reload: ' + lang, async () => {
  const s = setup({ lang, fetch: () => response(200, result) }); s.load('analyze');
  await s.analyze(); await s.analyze();
  assert.equal(s.box.getAttribute('data-az-state'), 'result');
  assert.match(s.box.querySelector('.azout').innerHTML, /&lt;script&gt;unsafe/);
  assert.deepEqual(s.requests[0].json, s.requests[1].json);
  assert.equal(s.events.filter(e => e.name === 'analyze_edital' && e.params.stage === 'ok').length, 1);
  assert.doesNotMatch(JSON.stringify([...s.data]), /caixa\.gov|resumo|reader@|signed-ticket/);
  const next = setup({ lang, storage: s.data, fetch: () => response(200, result) }); next.load('analyze'); await next.analyze();
  assert.deepEqual(next.requests[0].json, s.requests[0].json);
  assert.equal(next.events.filter(e => e.params.stage === 'ok').length, 0);
});

test('double submit stays locked even if analytics is blocked', async () => {
  const gate = deferred(), s = setup({ trackThrows: true, fetch: () => gate.promise }); s.load('analyze');
  const task = s.analyze(); await until(() => s.requests.length === 1); await s.analyze();
  assert.equal(s.requests.length, 1); gate.resolve(response(200, result)); await task;
  assert.equal(s.box.getAttribute('data-az-state'), 'result');
});

test('new PDF changes request key but preserves visitor and readonly config/prefill', async () => {
  const cfg = Object.freeze({ enabled: true, apiBase: 'https://preco-real-analyze.preco-real.workers.dev' });
  const s = setup({ analysisConfig: cfg, prefill: 'https://www.caixa.gov.br/first.pdf', fetch: () => response(200, result) });
  s.load('analyze'); assert.equal(s.input().value, 'https://www.caixa.gov.br/first.pdf');
  await s.analyze('https://www.caixa.gov.br/first.pdf'); await s.analyze('https://www.caixa.gov.br/second.pdf');
  assert.notEqual(s.requests[0].json.idempotency_key, s.requests[1].json.idempotency_key);
  assert.equal(s.requests[0].json.visitor_id, s.requests[1].json.visitor_id);
});

for (const status of [200, 201, 202, 400, 429, 503]) test('legacy ACK/ticket can never enable email or generate a lead: ' + status, async () => {
  const s = setup({ analysisConfig: { enabled: true, privacyUrl: '/privacidade/', privacyContact: 'fixture',
      waitlistEnabled: true },
    fetch: () => response(status, { error: 'budget_exhausted', saved: true, status: 'queued',
      fulfillment: 'deferred', waitlist_available: true, waitlist_token: 'private-ticket' }) });
  s.load('analyze'); await s.analyze(); await s.analyze();
  assert.equal(s.document.querySelector('.azqueue'), null);
  assert.equal(s.document.querySelectorAll('form').length, 1);
  assert.equal(s.document.querySelectorAll('input').length, 1);
  assert.equal(s.requests.length, 2);
  assert.ok(s.requests.every(r => r.url.endsWith('/analyze')));
  assert.equal(count(s, 'generate_lead'), 0);
  assert.equal(count(s, 'analysis_waitlist_view'), 0);
  assert.doesNotMatch(JSON.stringify([...s.data]), /private-ticket|fixture|email/);
});
