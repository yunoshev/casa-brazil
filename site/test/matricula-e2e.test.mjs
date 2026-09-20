import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import worker from '../../worker/src/index.js';
import { setup, until, response } from './dom.mjs';

const origin = 'https://precodemartelo.com';
const id = '034aa2e652ab4905';
const ticket = '00000000-0000-4000-8000-000000000001.1790000000.' + 'a'.repeat(64);
const MATRICULA_WARNING = 'Análise automatizada da matrícula, sujeita a erros e omissões. Não constitui certidão atualizada, parecer jurídico ou garantia sobre titularidade, ônus, cancelamentos ou disponibilidade do imóvel. Confira o documento integral e consulte o cartório e um profissional independente antes de decidir.';
const env = { ANALYSIS_ENABLED: 'true', BRAZIL_API_ORIGIN: 'https://188-245-254-157.nip.io',
  BRAZIL_PROXY_SECRET: 'test-only-proxy-secret-with-at-least-32-characters' };
const result = {
  contract: 'brazil_matricula_v1', document_type: 'matricula',
  identity: {
    matricula: { status: 'match', catalog_value: '12.345', document_value: '12345', citations: [{ page: 1, quote: 'Matrícula 12.345' }] },
    address: { status: 'omitted', catalog_value: 'Rua A', document_value: null, citations: [] },
  },
  entries: [{ kind: 'AV', number: 2, title: 'Cancelamento', summary: 'Cancelamento do R-1.', effect: 'cancelled',
    citations: [{ page: 1, quote: 'AV-2 cancelamento do R-1' }] }], summary: 'A matrícula contém uma averbação.',
  warnings: ['Confirme a certidão atualizada.'], confidence: 'medium', disclaimer: MATRICULA_WARNING,
  _meta: { cached: false, analyzed_at: '2026-09-17T10:00:00Z' },
};

function browserPDF() {
  const blob = new Blob(['%PDF-offline-browser-worker-core'], { type: 'application/pdf' });
  Object.defineProperty(blob, 'name', { value: 'matricula.pdf' });
  return blob;
}

test('one-click shows busy indicator through long wait, renders matrícula, repeats instantly', async () => {
  const site = setup({ fetch: (req, n) => n <= 6
    ? response(202, { status: 'analyzing', reason: 'analyzing', analysis_id: id,
      job_ticket: ticket, retry_after_seconds: 1 })
    : response(200, result) });
  site.load('analyze');
  const button = site.box.querySelector('button');
  const task = site.analyze();
  await until(() => site.requests.length === 1);
  for (let n = 2; n <= 7; n++) {
    await until(() => [...site.timers.values()].some(t => t.ms === 1000));
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.disabled, true);
    site.runTimers(1000);
    await until(() => site.requests.length === n);
  }
  await task;
  assert.equal(site.box.getAttribute('data-az-state'), 'result');
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.match(site.box.querySelector('.azout').innerHTML, /AV-2/);
  const count = site.requests.length;
  await site.analyze();
  assert.equal(site.requests.length, count);
  assert.match(site.box.querySelector('.azout').innerHTML, /AV-2/);
});

test('offline browser -> Worker -> mock core -> poll -> rendered versioned matrícula DTO', async () => {
  const coreCalls = [], nonces = new Set();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const bytes = options.body ? new Uint8Array(await new Response(options.body).arrayBuffer()) : new Uint8Array();
    const path = new URL(url).pathname, headers = new Headers(options.headers);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const signed = ['brazil-proxy-v1', options.method, path, headers.get('X-Brazil-Timestamp'),
      headers.get('X-Brazil-Nonce'), origin, headers.get('X-Brazil-Subject'), digest].join('\n');
    assert.equal(headers.get('X-Brazil-Signature'), createHmac('sha256', env.BRAZIL_PROXY_SECRET).update(signed).digest('hex'));
    assert.equal(nonces.has(headers.get('X-Brazil-Nonce')), false); nonces.add(headers.get('X-Brazil-Nonce'));
    coreCalls.push({ path, headers, bytes });
    if (coreCalls.length === 1) return new Response(JSON.stringify({ status: 'pending', reason: 'queued', analysis_id: id,
      job_ticket: ticket, retry_after_seconds: 1 }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Cache': 'miss' } });
  };
  try {
    const site = setup({ lotId: id, analysisConfig: { enabled: false, uploadEnabled: true,
      apiBase: 'https://preco-real-analyze.preco-real.workers.dev' },
    fetch: async request => {
      const publicURL = new URL(request.url);
      return worker.fetch(new Request('https://worker.test' + publicURL.pathname, { method: request.method,
        headers: { ...request.headers, Origin: origin, 'CF-Connecting-IP': '192.0.2.1' },
        ...(request.body ? { body: request.body } : {}) }), env);
    } });
    site.load('analyze');
    const input = site.box.querySelector('input'); input.files = [browserPDF()]; await input.emit('change');
    const consent = site.box.querySelector('form').querySelectorAll('input')[1]; consent.checked = true; await consent.emit('change');
    const task = site.box.querySelector('form').emit('submit');
    await until(() => coreCalls.length === 1);
    assert.equal(coreCalls[0].path, '/api/brazil-analysis/lots/' + id + '/matricula');
    assert.equal(new TextDecoder().decode(coreCalls[0].bytes), '%PDF-offline-browser-worker-core');
    assert.equal(coreCalls[0].headers.get('Content-Type'), 'application/pdf');
    assert.equal(coreCalls[0].headers.get('X-Analysis-Consent'), null);
    site.runTimers(1000); await task;
    assert.equal(coreCalls[1].path, '/api/brazil-analysis/' + ticket);
    assert.equal(coreCalls[1].bytes.length, 0);
    assert.equal(site.box.getAttribute('data-az-state'), 'complete');
    assert.match(site.box.querySelector('.azout').innerHTML, /AV-2/);
    assert.match(site.box.querySelector('.azout').innerHTML, /Matrícula 12\.345/);
  } finally { globalThis.fetch = originalFetch; }
});
