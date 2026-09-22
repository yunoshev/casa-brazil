import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, response, until, deferred } from './dom.mjs';

const emitted = s => (s.window.dataLayer || []).filter(e => e[0] === 'event');
const count = (s, name) => emitted(s).filter(e => e[1] === name).length;
const validAnalysis = { resumo: 'Valid analysis', dividas: { iptu: 'unknown', condominio: 'unknown', outras: [] },
  ocupado: 'incerto', confianca: 'baixa', aviso: 'Verify the original document.', riscos: [],
  fase: 'Unknown', source_scope: 'lot_specific' };
const jobTicket = '00000000-0000-4000-8000-000000000001.1790000000.' + 'a'.repeat(64);
const stages = s => Array.from(emitted(s).filter(e => e[1] === 'analyze_edital'), e => e[2].stage);

test('definitive pre-dispatch budget failure allows manual same-key POST instead of terminal polling', async () => {
  const s = setup({ fetch: (r, n) => n === 1 ? response(202, { status: 'pending', reason: 'queued', analysis_id: 'job', job_ticket: jobTicket, retry_after_seconds: 1 }) :
    n === 2 ? response(429, { error: 'budget_exhausted' }) : response(200, validAnalysis) });
  s.load('analyze'); const task = s.analyze();
  await until(() => s.requests.length === 1 && [...s.timers.values()].some(t => t.ms === 1000));
  s.runTimers(1000); await task;
  assert.equal(s.requests.length, 2, 'no automatic retry after a budget denial');
  assert.equal(s.requests[1].method, 'GET');
  await s.analyze();
  assert.equal(s.requests[2].method, 'POST');
  assert.equal(s.requests[2].body, s.requests[0].body, 'backend controls retry admission; identity never rotates');
  assert.equal(s.box.getAttribute('data-az-state'), 'result');
});

test('analysis is disabled by default and accepts only explicit enablement and exact HTTPS site origins', () => {
  const disabled = [
    { analysisConfig: undefined }, { analysisConfig: {} }, { analysisConfig: { enabled: false } },
    { analysisConfig: { enabled: 'true' } },
    ...['https://dashboard.example', 'https://www.caixa.gov.br', 'https://generativelanguage.googleapis.com',
      'https://preco-real-analyze.preco-real.workers.dev/other'].map(apiBase => ({ analysisConfig: { enabled: true, apiBase } })),
    ...['http://precodemartelo.com/', 'https://precodemartelo.com:444/',
      'https://other.precodemartelo.com/', 'https://precodemartelo.com.evil.example/',
      'https://evilprecodemartelo.com/', 'https://example.org/'].map(url => ({ url })),
  ];
  for (const options of disabled) {
    const s = setup(options); s.load('analyze'); s.window.ANALYZE.wire(); s.runTimers();
    assert.equal(s.form(), null);
    assert.equal(s.box.getAttribute('data-az-state'), 'unavailable');
    assert.ok(s.box.textContent.includes(s.translate('az.disabled')));
    assert.equal(s.requests.length, 0);
    assert.equal(s.data.size, 0);
    assert.equal(s.events.length, 0);
  }
  for (const url of ['https://precodemartelo.com/', 'https://www.precodemartelo.com/']) {
    const s = setup({ url }); s.load('analyze'); assert.ok(s.form());
  }
});

test('strict result schema rejects omitted fields, unknown scopes, error envelopes and malformed metadata', async () => {
  const missing = Object.keys(validAnalysis).map(key => {
    const body = { ...validAnalysis }; delete body[key]; return body;
  });
  const cases = [...missing, null, [], 'not JSON analysis',
    { ...validAnalysis, error: 'source_unavailable' }, { ...validAnalysis, status: 'pending' },
    { ...validAnalysis, source_scope: 'unknown' }, { ...validAnalysis, source_scope: null },
    { ...validAnalysis, dividas: { ...validAnalysis.dividas, outras: undefined } },
    { ...validAnalysis, dividas: { ...validAnalysis.dividas, iptu: '' } },
    { ...validAnalysis, riscos: [42] }, { ...validAnalysis, fase: null },
    ...[null, [], {}, { cached: 'true', analyzed_at: '2026-09-15T12:00:00Z' },
      { cached: true, analyzed_at: 'yesterday' }].map(_meta => ({ ...validAnalysis, _meta })),
  ];
  for (const body of cases) {
    const s = setup({ fetch: () => response(200, body) });
    s.load('analytics'); s.window.ANALYTICS.setConsent('accepted'); s.load('analyze'); await s.analyze();
    assert.deepEqual(stages(s), ['start', 'error']);
    assert.equal(s.box.querySelector('.azout').innerHTML, '');
    assert.equal([...s.data.values()].some(value => value.includes('"ok":true')), false);
  }
});

for (const lang of ['pt', 'en', 'ru']) test(`generic rules never render lot-specific fact cards: ${lang}`, async () => {
  const body = { ...validAnalysis, source_scope: 'generic_rules', resumo: '<script>general rules</script>',
    ocupado: 'sim', fase: 'UNVERIFIED_PHASE', riscos: ['UNVERIFIED_RISK'],
    dividas: { iptu: 'UNVERIFIED_TAX', condominio: 'UNVERIFIED_CONDO', outras: ['UNVERIFIED_DEBT'] },
    _meta: { cached: true, analyzed_at: '2026-09-15T12:00:00Z' } };
  const s = setup({ lang, fetch: () => response(200, body) });
  s.load('analytics'); s.window.ANALYTICS.setConsent('accepted'); s.load('analyze'); await s.analyze();
  const html = s.box.querySelector('.azout').innerHTML;
  assert.ok(html.includes(s.translate('az.generic.title')));
  assert.ok(html.includes(s.translate('az.generic.note')));
  assert.ok(html.includes(s.translate('az.cache')));
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /class="facts"|UNVERIFIED_|<script>/);
  assert.deepEqual(stages(s), ['start', 'ok']);
});

test('typed backend errors determine stages; status alone never invents a reason', async () => {
  const cases = [
    [503, 'budget_exhausted', 'budget_exhausted', 'az.budget'],
    [403, 'free_limit_reached', 'free_limit_reached', 'az.allowance'],
    [503, 'capacity_exhausted', 'unavailable', 'az.capacity'],
    [503, 'analysis_unavailable', 'unavailable', 'az.err.unavailable'],
    [502, 'source_unavailable', 'unavailable', 'az.err.download'],
    [403, 'source_blocked', 'unavailable', 'az.err.source'],
    [409, 'idempotency_conflict', 'error', 'az.err.conflict'],
    [429, 'rate_limited', 'rate_limited', 'az.err.limit'],
    ...[403, 429, 503].map(status => [status, 'secret@example.org', 'error', 'az.err.fail']),
  ];
  for (const [status, error, stage, key] of cases) {
    const s = setup({ fetch: () => response(status, { error }) });
    s.load('analytics'); s.window.ANALYTICS.setConsent('accepted'); s.load('analyze'); await s.analyze();
    assert.deepEqual(stages(s), ['start', stage]);
    assert.equal(s.box.querySelector('.azmsg').textContent, s.translate(key));
    assert.equal(s.box.querySelector('.azout').innerHTML, '');
    assert.doesNotMatch(JSON.stringify(emitted(s)), /secret@example/);
  }
});

test('polling is bounded and manual retry keeps the ticket at the fixed Worker', async () => {
  const s = setup({ fetch: () => response(202, { status: 'pending', reason: 'running', analysis_id: 'job', job_ticket: jobTicket, retry_after_seconds: 1 }) });
  s.load('analytics'); s.window.ANALYTICS.setConsent('accepted'); s.load('analyze');
  const task = s.analyze();
  for (let n = 1; n <= 60; n++) {
    await until(() => s.requests.length === n && [...s.timers.values()].some(t => t.ms === 1000));
    s.runTimers(1000);
  }
  await task;
  assert.equal(s.requests.length, 60);
  assert.deepEqual(stages(s), ['start', 'pending']);
  assert.equal(s.box.getAttribute('data-az-state'), 'background');
  assert.equal(s.box.querySelector('button').disabled, false);
  assert.equal(s.timers.size, 0);
  const retry = s.analyze();
  await until(() => s.requests.length === 61 && [...s.timers.values()].some(t => t.ms === 1000));
  s.box.isConnected = false;
  s.runTimers(1000); await retry;
  for (const [i, request] of s.requests.entries()) {
    assert.equal(new URL(request.url).origin, 'https://preco-real-analyze.preco-real.workers.dev');
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.referrerPolicy, 'no-referrer');
    assert.equal(request.method, i === 0 ? 'POST' : 'GET');
  }
});

test('network timeout aborts the request; late results and navigation cannot emit success', async () => {
  let finish;
  const s = setup({ fetch: () => new Promise(resolve => { finish = resolve; }) });
  s.load('analytics'); s.window.ANALYTICS.setConsent('accepted'); s.load('analyze');
  const task = s.analyze(); await until(() => s.requests.length === 1);
  s.runTimers(115000); await task;
  assert.equal(s.requests[0].signal.aborted, true);
  assert.deepEqual(stages(s), ['start', 'error']);
  finish(response(200, validAnalysis)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(stages(s), ['start', 'error']);
  assert.equal(s.box.querySelector('.azout').innerHTML, '');

  const next = setup({ fetch: () => new Promise(resolve => { finish = resolve; }) });
  next.load('analytics'); next.window.ANALYTICS.setConsent('accepted'); next.load('analyze');
  const pending = next.analyze(); await until(() => next.requests.length === 1);
  next.box.isConnected = false; finish(response(200, validAnalysis)); await pending;
  assert.deepEqual(stages(next), ['start']);
});

test('every analysis runtime key exists in all three actual public catalogues', () => {
  const script = readFileSync(new URL('../parts/analyze.js', import.meta.url), 'utf8');
  const keys = [...script.matchAll(/["'](az\.[a-z0-9_.]+)["']/g)].map(m => m[1]).filter(k => !k.endsWith('.'));
  for (const lang of ['pt', 'en', 'ru']) {
    const catalog = JSON.parse(readFileSync(new URL('../i18n/' + lang + '.json', import.meta.url)));
    for (const key of keys) assert.equal(typeof catalog[key], 'string', lang + ':' + key);
    assert.notEqual(catalog['az.budget'], catalog['az.allowance']);
    assert.notEqual(catalog['az.allowance'], catalog['az.err.limit']);
  }
});

for (const lang of ['pt', 'en', 'ru']) test(`public pending polls never count as success; one pending and one valid success: ${lang}`, async () => {
  const s = setup({ lang, fetch: (r, n) => n <= 3 ? response(202, { status: 'pending', reason: 'queued', analysis_id: 'job', job_ticket: jobTicket, retry_after_seconds: 1 }) : response(200, validAnalysis) });
  s.load('analytics'); s.window.ANALYTICS.setConsent('accepted'); s.load('analyze');
  const task = s.analyze();
  for (let n = 1; n <= 3; n++) {
    await until(() => s.requests.length === n && [...s.timers.values()].some(t => t.ms === 1000));
    assert.deepEqual(stages(s), ['start', 'pending']);
    assert.equal(s.box.querySelector('.azmsg').textContent, s.translate('az.progress.queued'));
    assert.equal(s.box.querySelector('.azout').innerHTML, '');
    s.runTimers(1000);
  }
  await task;
  assert.deepEqual(stages(s), ['start', 'pending', 'ok']);
  assert.equal(s.requests[0].method, 'POST');
  assert.deepEqual(Object.keys(s.requests[0].json).sort(), ['id', 'idempotency_key', 'lang', 'source_url', 'visitor_id']);
  assert.equal(s.requests[0].json.lang, lang);
  assert.ok(s.requests.slice(1).every(r => r.method === 'GET' && r.body === undefined && r.url.endsWith('/analyze/' + jobTicket)));
  await s.analyze();
  assert.equal(stages(s).filter(x => x === 'ok').length, 1);
  assert.equal(count(s, 'analysis_started'), 0);
  assert.equal(count(s, 'analysis_success'), 0);
  assert.doesNotMatch(JSON.stringify([...s.data]), /1790000000|caixa\.gov|Valid analysis/);
  assert.doesNotMatch(JSON.stringify(s.window.dataLayer.map(e => Array.from(e))), /1790000000|caixa\.gov|visitor_id|idempotency_key/);
});

test('202 malformed envelopes and malformed 200 are never completed analyses', async () => {
  const cases = [[202, {}], [202, { status: 'pending', analysis_id: 'job', job_ticket: '../admin' }],
    [200, {}], [200, { ...validAnalysis, aviso: '' }], [200, { ...validAnalysis, ocupado: 'maybe' }],
    [200, { ...validAnalysis, riscos: 'bad' }], [200, { ...validAnalysis, dividas: {} }]];
  for (const [status, body] of cases) {
    const s = setup({ fetch: () => response(status, body) }); s.load('analytics');
    s.window.ANALYTICS.setConsent('accepted'); s.load('analyze'); await s.analyze();
    assert.deepEqual(stages(s), ['start', 'error']);
    assert.equal(s.box.querySelector('.azout').innerHTML, '');
    assert.equal(s.requests.length, 1);
  }
});

for (const [reason, event, key] of [
  ['budget_exhausted', 'analysis_budget_exhausted', 'az.budget'],
  ['free_limit_reached', 'analysis_free_limit_reached', 'az.allowance'],
  ['capacity_exhausted', 'analysis_capacity_exhausted', 'az.capacity'],
  ['rate_limited', null, 'az.err.limit'],
]) test(`typed 429 ${reason} remains distinct; no public waitlist or email`, async () => {
  const s = setup({ fetch: () => response(429, { error: reason, waitlist_available: true, waitlist_token: 'private-ticket' }) });
  s.load('analytics'); s.window.ANALYTICS.setConsent('accepted'); s.load('analyze'); await s.analyze();
  assert.equal(s.box.querySelector('.azmsg').textContent, s.translate(key));
  assert.equal(stages(s).includes('ok'), false);
  for (const name of ['analysis_budget_exhausted', 'analysis_free_limit_reached', 'analysis_capacity_exhausted']) assert.equal(count(s, name), name === event ? 1 : 0);
  assert.deepEqual(stages(s), ['start', reason === 'capacity_exhausted' ? 'unavailable' : reason]);
  assert.equal(emitted(s).find(e => e[1] === 'analyze_edital' && e[2].reason)[2].reason, reason);
  assert.equal(s.document.querySelectorAll('form').length, 1);
  assert.equal(s.document.querySelectorAll('input').length, 0);
  assert.equal(s.requests.length, 1);
  assert.equal(count(s, 'generate_lead'), 0);
  assert.doesNotMatch(JSON.stringify(emitted(s)), /private-ticket|waitlist/);
});

test('same-key retries survive reload; repeated clicks dedupe and unsafe source never renders a button', async () => {
  const s = setup(); s.load('analyze'); await s.analyze(); await s.analyze();
  assert.equal(s.requests[0].body, s.requests[1].body);
  const next = setup({ storage: s.data }); next.load('analyze'); await next.analyze();
  assert.equal(next.requests[0].body, s.requests[0].body);
  const blocked = setup({ storageBlocked: true }); blocked.load('analyze'); await blocked.analyze();
  assert.equal(blocked.requests.length, 0);
  for (const source of ['http://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=1',
    'https://evil.example/sistema/detalhe-imovel.asp?hdnimovel=1',
    'https://u:p@venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=1',
    'https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=1#secret']) {
    const unsafe = setup({ source }); unsafe.load('analyze');
    assert.equal(unsafe.form(), null); assert.equal(unsafe.requests.length, 0);
  }
  const pending = deferred();
  const deduped = setup({ fetch: () => pending.promise }); deduped.load('analyze');
  const first = deduped.analyze(); await until(() => deduped.requests.length === 1);
  await deduped.analyze(); assert.equal(deduped.requests.length, 1);
  pending.resolve(response(200, validAnalysis)); await first;
});

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
  s.window.track('lot_outbound', { lot_source: 'caixa', page: '/private@example.org', page_location: 'leak', page_title: 'leak' });
  s.window.track('unknown', { email: 'private@example.org' });
  const serial = JSON.stringify(s.window.dataLayer.map(e => Array.from(e)));
  assert.doesNotMatch(serial, /private@|secret-address|secret-id|private\.pdf|ticket|leak/);
  assert.equal(emitted(s).find(e => e[1] === 'analyze_edital')[2].reason, 'unknown');
  const cfg = s.window.dataLayer.find(e => e[0] === 'config')[2];
  assert.equal(cfg.send_page_view, false);
  assert.equal(cfg.allow_google_signals, false);
  assert.equal(count(s, 'unknown'), 0);
});

test('shared-core analysis POST works without consent; start/ok/error events are sanitized', async () => {
  let fail = false;
  const s = setup({ fetch: () => fail ? response(503, { error: 'private@example.org' }) : response(200, { ...validAnalysis, resumo: 'Test result' }) });
  s.load('analytics'); s.load('analyze');
  await s.analyze();
  await until(() => s.box.querySelector('.azout').innerHTML.includes('Test result'));
  assert.deepEqual(Object.keys(s.requests[0].json).sort(), ['id', 'idempotency_key', 'lang', 'source_url', 'visitor_id']);
  assert.equal(s.requests[0].url, 'https://preco-real-analyze.preco-real.workers.dev/analyze/lots/034aa2e652ab4905/one-click');
  assert.equal(s.window.dataLayer, undefined);
  const observed = setup({ fetch: () => fail ? response(503, { error: 'private@example.org' }) : response(200, { ...validAnalysis, resumo: 'Test result' }) });
  observed.load('analytics'); observed.window.ANALYTICS.setConsent('accepted'); observed.load('analyze');
  await observed.analyze(); await until(() => emitted(observed).some(e => e[1] === 'analyze_edital' && e[2].stage === 'ok'));
  fail = true;
  await observed.analyze();
  assert.equal(observed.requests.length, 1, 'ready result never calls the API again');
  const failed = setup({ fetch: () => response(503, { error: 'private@example.org' }) });
  failed.load('analytics'); failed.window.ANALYTICS.setConsent('accepted'); failed.load('analyze');
  await failed.analyze(); await until(() => emitted(failed).some(e => e[1] === 'analyze_edital' && e[2].stage === 'error'));
  assert.doesNotMatch(JSON.stringify(failed.window.dataLayer.map(e => Array.from(e))), /private@|source_url/);
});

test('late form and shell navigation are observed; CTA requires visibility and counts once', () => {
  const s = setup(); s.load('analytics'); s.window.ANALYTICS.setConsent('accepted');
  const hero = s.document.body.appendChild(s.document.createElement('button'));
  hero.setAttribute('data-analysis-cta', '');
  s.load('analyze'); s.window.notifyMutation();
  assert.equal(s.box.querySelector('.azform .cta'), null);
  assert.equal(s.observers[0].nodes[0], hero);
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

test('page views never override GA4 acquisition source; public providers use lot_source', async () => {
  const data = JSON.parse(readFileSync(new URL('../../data/site.json', import.meta.url), 'utf8'));
  const index = data.cols.indexOf('src');
  const sources = new Set(data.cities.flatMap(c => c.rows.map(r => r[index])));
  const s = setup(); s.load('analytics'); s.window.ANALYTICS.setConsent('accepted');
  const pageView = emitted(s).find(e => e[1] === 'page_view')[2];
  assert.equal(Object.hasOwn(pageView, 'source'), false);
  assert.equal(Object.hasOwn(pageView, 'lot_source'), false);
  for (const source of sources) {
    const link = s.document.createElement('a'); link.setAttribute('data-out', source);
    await s.document.emit('click', { target: link });
    const params = emitted(s).at(-1)[2];
    assert.equal(params.lot_source, source);
    assert.equal(Object.hasOwn(params, 'source'), false);
  }
});
