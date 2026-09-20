// Actual public HEAD 9b8f495 consent/analysis regressions are retained verbatim.
// This entry runs them plus useful non-duplicated checks from the earlier
// private funnel. Former email/DO behavior is covered by archived Worker
// fixtures, never re-enabled in the public consumer.
import './analytics.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setup, response, deferred, until } from './dom.mjs';

const result = { resumo: '<script>unsafe</script>', ocupado: 'incerto',
  dividas: { iptu: 'unknown', condominio: 'unknown', outras: [] }, confianca: 'baixa',
  aviso: 'Verify the document.', riscos: [], fase: 'Unknown', source_scope: 'lot_specific',
  _meta: { cached: true, analyzed_at: '2026-09-15T12:00:00Z' } };
const count = (s, name) => s.events.filter(e => e.name === name).length;

const heroHandler = readFileSync(new URL('../v2/app.js', import.meta.url), 'utf8')
  .match(/function wireAnalysisCTA\(root\) \{[\s\S]*?\n\}/)?.[0];
function addHero(s) {
  const hero = s.document.createElement('button');
  hero.setAttribute('data-analysis-cta', '');
  hero.setAttribute('type', 'button');
  s.document.body.appendChild(hero);
  return hero;
}
function wireHero(s) {
  // Exercise the unchanged app handler alongside native form submission.
  if (heroHandler) vm.runInNewContext(heroHandler + '\nwireAnalysisCTA(root);', { root: s.document });
}

test('existing app scroll handler permits the hero native submit', {
  skip: !heroHandler && 'This checkout does not yet contain the hero app handler',
}, async () => {
  const s = setup({ fetch: () => response(200, result) }), hero = addHero(s);
  s.load('analyze'); wireHero(s); await hero.click();
  assert.equal(s.box.scrolled, true);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].method, 'POST');
});

test('hero click submits once with no inner CTA or URL inputs, including re-init and SPA navigation', async () => {
  const s = setup({ fetch: () => response(200, result) });
  let hero = addHero(s); s.load('analyze'); wireHero(s);
  s.window.ANALYZE.wire(); s.load('analyze');
  assert.equal(s.document.querySelectorAll('button').filter(b => !b.hidden).length, 1);
  assert.equal(s.box.querySelectorAll('button').length, 0);
  assert.equal(s.document.querySelectorAll('input').length, 0);
  assert.equal(hero.getAttribute('form'), s.form().getAttribute('id'));
  assert.equal(hero.getAttribute('type'), 'submit');
  assert.equal(hero.listeners.click?.length || 0, heroHandler ? 1 : 0); // Only app.js's scroll handler.
  await hero.click();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].method, 'POST');
  assert.ok(s.requests[0].url.endsWith('/analyze/lots/034aa2e652ab4905/one-click'));
  assert.equal(hero.getAttribute('data-az-state'), 'result');
  assert.equal(hero.textContent, s.translate('az.again'));
  assert.equal(hero.disabled, false);

  const oldBox = s.box;
  oldBox.isConnected = false;
  s.document.body.innerHTML = '';
  const nextBox = s.document.createElement('section');
  nextBox.setAttribute('data-az', '034aa2e652ab4906');
  nextBox.setAttribute('data-az-source', oldBox.getAttribute('data-az-source'));
  s.document.body.appendChild(nextBox);
  hero = addHero(s); s.window.ANALYZE.wire(); wireHero(s); s.window.ANALYZE.wire();
  await hero.click();
  assert.equal(s.requests.length, 2);
  assert.ok(s.requests[1].url.endsWith('/analyze/lots/034aa2e652ab4906/one-click'));
  assert.equal(hero.listeners.click?.length || 0, heroHandler ? 1 : 0);
  assert.equal(s.document.querySelectorAll('button').length, 1);
});

test('hero locks duplicate clicks while busy and exposes unavailable/retry state', async () => {
  const gate = deferred(), s = setup({ fetch: () => gate.promise });
  const hero = addHero(s); s.load('analyze'); wireHero(s);
  const task = hero.click(); await until(() => s.requests.length === 1);
  assert.equal(hero.disabled, true);
  assert.equal(hero.getAttribute('aria-busy'), 'true');
  assert.equal(hero.getAttribute('data-az-state'), 'submitting');
  const nearbyStatus = s.document.getElementById(hero.getAttribute('aria-describedby'));
  assert.equal(nearbyStatus.parentElement, hero.parentElement);
  assert.equal(nearbyStatus.hidden, false);
  assert.equal(nearbyStatus.textContent, s.translate('az.progress.request'));
  await hero.click(); await s.analyze();
  assert.equal(s.requests.length, 1);
  gate.resolve(response(503, { error: 'analysis_unavailable' })); await task;
  assert.equal(hero.disabled, false);
  assert.equal(hero.getAttribute('aria-busy'), 'false');
  assert.equal(hero.getAttribute('data-az-state'), 'unavailable');
  assert.equal(hero.textContent, s.translate('az.retry'));
  assert.equal(nearbyStatus.hidden, false);
  assert.equal(nearbyStatus.textContent, s.box.querySelector('.azmsg').textContent);
  await hero.click();
  assert.equal(s.requests.length, 2);
  assert.deepEqual(s.requests[0].json, s.requests[1].json);
});

test('download failure is explained next to the hero without claiming a source block', async () => {
  const s = setup({fetch: () => response(503, {error: 'source_unavailable'})});
  const hero = addHero(s); s.load('analyze'); await hero.click();
  const status = s.document.getElementById(hero.getAttribute('aria-describedby'));
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, s.translate('az.err.download'));
  assert.match(status.textContent, /PDF/);
});

test('pending hero stays locked beyond four polls without another POST', async () => {
  const ticket = '00000000-0000-4000-8000-000000000001.1790000000.' + 'a'.repeat(64);
  const s = setup({ fetch: () => response(202, { status: 'pending', reason: 'queued',
    analysis_id: 'fixture', job_ticket: ticket, retry_after_seconds: 1 }) });
  const hero = addHero(s); s.load('analyze');
  const task = hero.click();
  await until(() => hero.getAttribute('data-az-state') === 'pending');
  assert.equal(hero.disabled, true);
  assert.equal(hero.textContent, s.translate('az.status.queued'));
  await hero.click(); assert.equal(s.requests.length, 1);
  for (let n = 2; n <= 6; n++) {
    await until(() => [...s.timers.values()].some(t => t.ms === 1000));
    s.runTimers(1000); await until(() => s.requests.length === n);
  }
  assert.equal(hero.disabled, true);
  assert.equal(hero.getAttribute('data-az-state'), 'pending');
  assert.equal(s.requests.filter(r => r.method === 'POST').length, 1);
  assert.ok(s.requests.slice(1).every(r => r.method === 'GET' && r.url.endsWith(ticket)));
  s.box.isConnected = false; s.runTimers(1000); await task;
});

for (const options of [{ analysisConfig: { enabled: false } }, { source: 'https://invalid.test/' }]) {
  test('unavailable hero fails closed: ' + JSON.stringify(options), async () => {
    const s = setup(options), hero = addHero(s); s.load('analyze'); wireHero(s);
    assert.equal(hero.disabled, true);
    assert.equal(hero.getAttribute('data-az-state'), 'unavailable');
    assert.equal(s.form(), null);
    await hero.click(); assert.equal(s.requests.length, 0);
  });
}

test('without a hero the inner submit remains the one-click fallback', async () => {
  const s = setup({ fetch: () => response(200, result) }); s.load('analyze');
  assert.equal(s.document.querySelectorAll('button').length, 1);
  assert.equal(s.document.querySelectorAll('input').length, 0);
  await s.box.querySelector('button').click();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].method, 'POST');
});

test('all shipped runtime literals exist in each catalogue; no hosts mistaken for i18n keys', () => {
  const prerender = readFileSync(new URL('../../prerender.py', import.meta.url), 'utf8');
  const assets = prerender.match(/ASSETS = \(([\s\S]*?)\n\)/)[1];
  const files = [...assets.matchAll(/"([^"]+\.js)"/g)].map(m => m[1]);
  assert.ok(files.includes('parts/analytics.js'));
  const sources = files.map(f => readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n');
  const keys = [...sources.matchAll(/["']([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)["']/g)].map(m => m[1]);
  const pluralBases = new Set([...sources.matchAll(/\bplur\([^;\n]{0,160}/g)].flatMap(m =>
    [...m[0].matchAll(/["']([a-z][a-z0-9_.]+)["']/g)].map(part => part[1])));
  assert.ok(keys.includes('nav.theme'));
  const cats = ['pt', 'en', 'ru'].map(lang => JSON.parse(readFileSync(new URL('../i18n/' + lang + '.json', import.meta.url))));
  for (const cat of cats) for (const key of keys) {
    if (pluralBases.has(key)) continue;
    assert.equal(typeof cat[key], 'string', key);
  }
  const scoped = cat => Object.keys(cat).filter(k => /^(az|analytics)\./.test(k)).sort();
  assert.deepEqual(scoped(cats[0]), scoped(cats[1])); assert.deepEqual(scoped(cats[0]), scoped(cats[2]));
});

for (const lang of ['pt', 'en', 'ru']) test('escaped result and acknowledged same-key reload: ' + lang, async () => {
  const s = setup({ lang, fetch: () => response(200, result) }); s.load('analyze');
  await s.analyze(); await s.analyze();
  assert.equal(s.box.getAttribute('data-az-state'), 'result');
  assert.match(s.box.querySelector('.azout').innerHTML, /&lt;script&gt;unsafe/);
  assert.equal(s.requests.length, 1, 'repeated click reveals in-memory result');
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

test('new Caixa source changes request key but preserves visitor and readonly config', async () => {
  const cfg = Object.freeze({ enabled: true, apiBase: 'https://preco-real-analyze.preco-real.workers.dev' });
  const first = setup({ analysisConfig: cfg, fetch: () => response(200, result) });
  first.load('analyze'); await first.analyze();
  const second = setup({ analysisConfig: cfg, storage: first.data,
    source: 'https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=1111111111111',
    fetch: () => response(200, result) });
  second.load('analyze'); await second.analyze();
  assert.notEqual(first.requests[0].json.idempotency_key, second.requests[0].json.idempotency_key);
  assert.equal(first.requests[0].json.visitor_id, second.requests[0].json.visitor_id);
  assert.deepEqual(cfg, { enabled: true, apiBase: 'https://preco-real-analyze.preco-real.workers.dev' });
});

for (const status of [200, 201, 202, 400, 429, 503]) test('legacy ACK/ticket can never enable email or generate a lead: ' + status, async () => {
  const s = setup({ analysisConfig: { enabled: true, privacyUrl: '/privacidade/', privacyContact: 'fixture',
      waitlistEnabled: true },
    fetch: () => response(status, { error: 'budget_exhausted', saved: true, status: 'queued',
      fulfillment: 'deferred', waitlist_available: true, waitlist_token: 'private-ticket' }) });
  s.load('analyze'); await s.analyze(); await s.analyze();
  assert.equal(s.document.querySelector('.azqueue'), null);
  assert.equal(s.document.querySelectorAll('form').length, 1);
  assert.equal(s.document.querySelectorAll('input').length, 0);
  assert.equal(s.requests.length, 2);
  assert.ok(s.requests.every(r => r.url.endsWith('/analyze/lots/034aa2e652ab4905/one-click')));
  assert.equal(count(s, 'generate_lead'), 0);
  assert.equal(count(s, 'analysis_waitlist_view'), 0);
  assert.doesNotMatch(JSON.stringify([...s.data]), /private-ticket|fixture|email/);
});
