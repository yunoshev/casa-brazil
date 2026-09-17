import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import worker from '../../worker/src/index.js';
import { setup, until } from './dom.mjs';

const origin = 'https://precodemartelo.com';
const id = '034aa2e652ab4905';
const source = 'https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=8444412843294';
const ticket = '00000000-0000-4000-8000-000000000001.1790000000.' + 'a'.repeat(64);
const env = { ANALYSIS_ENABLED: 'true', BRAZIL_API_ORIGIN: 'https://188-245-254-157.nip.io',
  BRAZIL_PROXY_SECRET: 'test-only-proxy-secret-with-at-least-32-characters' };
const result = { resumo: 'Regras gerais validadas.', dividas: { iptu: 'não informado', condominio: 'não informado', outras: [] },
  ocupado: 'incerto', confianca: 'baixa', aviso: 'Confira o edital completo.', riscos: [],
  fase: 'não informado', source_scope: 'generic_rules',
  _meta: { cached: false, analyzed_at: '2026-09-17T10:00:00Z' } };

test('offline browser one-click -> Worker HMAC -> mock core -> bounded poll -> generic result', async () => {
  const coreCalls = [], nonces = new Set();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = typeof options.body === 'string' ? options.body : '';
    const path = new URL(url).pathname, headers = new Headers(options.headers);
    const digest = createHash('sha256').update(body).digest('hex');
    const signed = ['brazil-proxy-v1', options.method, path, headers.get('X-Brazil-Timestamp'),
      headers.get('X-Brazil-Nonce'), origin, headers.get('X-Brazil-Subject'), digest].join('\n');
    assert.equal(headers.get('X-Brazil-Signature'), createHmac('sha256', env.BRAZIL_PROXY_SECRET).update(signed).digest('hex'));
    assert.equal(nonces.has(headers.get('X-Brazil-Nonce')), false); nonces.add(headers.get('X-Brazil-Nonce'));
    coreCalls.push({ path, body });
    if (coreCalls.length === 1) return new Response(JSON.stringify({ status: 'waiting_document',
      reason: 'waiting_for_cached_pdf', analysis_id: id, job_ticket: ticket, retry_after_seconds: 1 }),
    { status: 202, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(result),
      { status: 200, headers: { 'Content-Type': 'application/json', 'X-Cache': 'miss' } });
  };
  try {
    const site = setup({ lotId: id, source, fetch: async request => {
      const publicURL = new URL(request.url);
      return worker.fetch(new Request('https://worker.test' + publicURL.pathname, { method: request.method,
        headers: { ...request.headers, Origin: origin, 'CF-Connecting-IP': '192.0.2.1' },
        ...(request.body ? { body: request.body } : {}) }), env);
    } });
    site.load('analyze');
    const task = site.analyze();
    await until(() => coreCalls.length === 1);
    assert.equal(coreCalls[0].path, '/api/brazil-analysis/lots/' + id);
    assert.deepEqual(JSON.parse(coreCalls[0].body), {
      id, source_url: source, visitor_id: JSON.parse(coreCalls[0].body).visitor_id,
      idempotency_key: JSON.parse(coreCalls[0].body).idempotency_key, lang: 'pt',
    });
    assert.equal(site.box.getAttribute('data-az-state'), 'pending');
    site.runTimers(1000); await task;
    assert.equal(coreCalls[1].path, '/api/brazil-analysis/' + ticket);
    assert.equal(coreCalls[1].body, '');
    assert.equal(site.box.getAttribute('data-az-state'), 'result');
    assert.match(site.box.querySelector('.azout').innerHTML, /Regras gerais validadas/);
    assert.match(site.box.querySelector('.azout').innerHTML, /az\.generic\.title|Regras gerais/);
  } finally { globalThis.fetch = originalFetch; }
});
