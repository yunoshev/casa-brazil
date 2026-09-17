import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setup, response, until } from './dom.mjs';

const id = '008d136b4590d81f';
const base = 'https://preco-real-analyze.preco-real.workers.dev';
const ticket = '123e4567-e89b-42d3-a456-426614174000.1790000000.' + 'a'.repeat(64);
const MATRICULA_WARNING = 'Análise automatizada da matrícula, sujeita a erros e omissões. Não constitui certidão atualizada, parecer jurídico ou garantia sobre titularidade, ônus, cancelamentos ou disponibilidade do imóvel. Confira o documento integral e consulte o cartório e um profissional independente antes de decidir.';
const analysis = {
  contract: 'brazil_matricula_v1', document_type: 'matricula',
  identity: {
    matricula: { status: 'match', catalog_value: '12.345', document_value: '12345', citations: [{ page: 1, quote: 'Matrícula 12.345' }] },
    address: { status: 'omitted', catalog_value: 'Rua A', document_value: null, citations: [] },
  },
  entries: [{ kind: 'R', number: 7, title: 'Penhora', summary: 'Existe uma penhora registrada.', effect: 'unclear',
    citations: [{ page: 4, quote: '<penhora> R-7' }] }],
  summary: 'A matrícula informa uma penhora.', warnings: ['Confirme o efeito atual no cartório.'],
  confidence: 'medium', disclaimer: MATRICULA_WARNING,
  _meta: { cached: false, analyzed_at: '2026-09-17T10:00:00Z' },
};
function pdf(name = 'matricula.pdf', overrides = {}) {
  const bytes = Uint8Array.from([37, 80, 68, 70, 45]);
  return { name, type: 'application/pdf', size: bytes.length,
    slice() { return { arrayBuffer: async () => bytes.buffer }; }, ...overrides };
}
function fixture(options = {}) {
  return setup({ lotId: id, source: 'https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=1',
    analysisConfig: { apiBase: base, enabled: false, uploadEnabled: true }, ...options });
}
async function select(s, file) {
  const input = s.box.querySelector('input'); input.files = file ? [file] : [];
  await input.emit('change');
}
async function consent(s) {
  const checkbox = s.box.querySelector('form').querySelectorAll('input')[1];
  checkbox.checked = true; await checkbox.emit('change');
}

for (const lang of ['pt', 'en', 'ru']) test(`${lang}: manual download, accessible picker and historical/legal warnings`, () => {
  const s = fixture({ lang }); s.load('analyze');
  assert.equal(s.requests.length, 0);
  assert.ok(s.box.textContent.includes(s.translate('az.upload.lede')));
  assert.ok(s.box.textContent.includes(s.translate('az.upload.manual')));
  assert.ok(s.box.textContent.includes(s.translate('az.upload.historical')));
  assert.ok(s.box.textContent.includes(s.translate('az.upload.consent')));
  assert.match(s.box.innerHTML, /type="file"[^>]+accept="application\/pdf,.pdf"/);
  assert.match(s.box.innerHTML, /role="status"[^>]+aria-live="polite"/);
  assert.match(s.box.innerHTML, /target="_blank" rel="noopener noreferrer"/);
  assert.ok(s.box.textContent.includes(s.translate('az.upload.download')));
});

test('validates extension, MIME, size and PDF signature before any request', async () => {
  const s = fixture(); s.load('analyze');
  for (const file of [pdf('x.txt'), pdf('x.pdf', { type: 'text/plain' }), pdf('x.pdf', { size: 5 * 1024 * 1024 + 1 }),
    pdf('x.pdf', { slice() { return { arrayBuffer: async () => Uint8Array.from([0, 1, 2, 3, 4]).buffer }; } })]) {
    await select(s, file);
    assert.equal(s.box.getAttribute('data-az-state'), 'error');
    assert.equal(s.box.querySelector('.azmsg').textContent, s.translate('az.upload.invalid'));
  }
  assert.equal(s.requests.length, 0);
  await select(s, pdf());
  assert.equal(s.box.getAttribute('data-az-state'), 'ready');
  assert.equal(s.box.querySelector('button').disabled, true);
  await consent(s); assert.equal(s.box.querySelector('button').disabled, false);
});

test('explicit paid-provider consent is required before any upload', async () => {
  const s = fixture(); s.load('analyze'); await select(s, pdf());
  await s.box.querySelector('form').emit('submit');
  assert.equal(s.requests.length, 0);
  assert.equal(s.box.querySelector('.azmsg').textContent, s.translate('az.upload.consent_required'));
});

test('drag/drop runs verifying -> queued -> analyzing -> cited result without automatic download', async () => {
  const replies = [response(202, { status: 'queued', analysis_id: 'job', job_ticket: ticket, retry_after_seconds: 1 }),
    response(202, { status: 'pending', analysis_id: 'job', job_ticket: ticket, retry_after_seconds: 1 }),
    response(200, analysis)];
  const s = fixture({ fetch: () => replies.shift() }); s.load('analyze');
  const drop = s.box.querySelector('label');
  await drop.emit('drop', { dataTransfer: { files: [pdf()] } });
  assert.equal(s.box.getAttribute('data-az-state'), 'ready');
  await consent(s);
  const task = s.box.querySelector('form').emit('submit');
  await until(() => s.requests.length === 1);
  assert.equal(s.requests[0].url, base + '/analyze/lots/' + id);
  assert.equal(s.requests[0].method, 'POST');
  assert.equal(s.requests[0].headers['Content-Type'], 'application/pdf');
  assert.equal(s.requests[0].headers['X-Analysis-Consent'], 'brazil-matricula-paid-ai-v1');
  assert.match(s.requests[0].headers['X-Visitor-Id'], /^[a-f0-9-]{36}$/);
  assert.match(s.requests[0].headers['X-Idempotency-Key'], /^[a-f0-9-]{36}$/);
  assert.equal(s.requests[0].headers['X-Analysis-Lang'], 'pt');
  assert.equal(s.requests[0].credentials, 'omit'); assert.equal(s.requests[0].redirect, 'error');
  assert.equal(s.requests[0].body.name, 'matricula.pdf');
  assert.equal(s.box.getAttribute('data-az-state'), 'queued'); s.runTimers(1000);
  await until(() => s.requests.length === 2);
  assert.equal(s.requests[1].url, base + '/analyze/' + ticket); assert.equal(s.requests[1].method, 'GET');
  assert.equal(s.box.getAttribute('data-az-state'), 'analyzing'); s.runTimers(1000);
  await task;
  assert.equal(s.box.getAttribute('data-az-state'), 'complete');
  assert.ok(s.box.querySelector('.azout').innerHTML.includes('Página 4'));
  assert.ok(s.box.querySelector('.azout').innerHTML.includes('&lt;penhora&gt; R-7'));
  assert.ok(s.box.textContent.includes(analysis.disclaimer));
  assert.equal(s.events.filter(e => e.name === 'analyze_edital' && e.params.stage === 'ok').length, 1);
});

for (const lang of ['pt', 'en', 'ru']) test(`${lang}: exact matrícula warning is rendered`, async () => {
  const s = fixture({ lang, fetch: () => response(200, analysis) }); s.load('analyze');
  await select(s, pdf()); await consent(s);
  await s.box.querySelector('form').emit('submit');
  assert.equal(s.box.getAttribute('data-az-state'), 'complete');
  assert.ok(s.box.textContent.includes(MATRICULA_WARNING));
  assert.equal(s.box.textContent.includes('Confira o documento integral e procure orientação independente.'), false);
});

test('uncited or mismatched responses never render a result', async () => {
  for (const [body, key] of [[{ ...analysis, entries: [{ ...analysis.entries[0], citations: [] }] }, 'az.upload.error'],
    [{ ...analysis, disclaimer: 'Confira o documento integral.' }, 'az.upload.error'],
    [{ error: 'document_mismatch' }, 'az.upload.mismatch']]) {
    const s = fixture({ fetch: () => response(body.error ? 422 : 200, body) }); s.load('analyze');
    await select(s, pdf()); await consent(s); await s.box.querySelector('form').emit('submit');
    assert.equal(s.box.getAttribute('data-az-state'), 'error');
    assert.equal(s.box.querySelector('.azmsg').textContent, s.translate(key));
    assert.equal(s.box.querySelector('.azout').innerHTML, '');
    assert.equal(s.events.some(e => e.params.stage === 'ok'), false);
  }
});

test('untrusted origin/endpoint and disabled upload preserve the existing client', () => {
  for (const options of [{ analysisConfig: { enabled: false, uploadEnabled: true, apiBase: 'https://evil.example' } },
    { url: 'https://evil.example/', analysisConfig: { enabled: false, uploadEnabled: true } }]) {
    const s = fixture(options); s.load('analyze'); assert.equal(s.box.getAttribute('data-az-state'), 'unavailable'); assert.equal(s.requests.length, 0);
  }
  const disabled = fixture({ analysisConfig: { enabled: false, uploadEnabled: false } }); disabled.load('analyze');
  assert.equal(disabled.box.querySelector('input'), null);
});

test('one-click wins when public config enables both flows', () => {
  const s = fixture({ analysisConfig: { enabled: true, uploadEnabled: true } }); s.load('analyze');
  assert.equal(s.box.querySelectorAll('button').length, 1);
  assert.equal(s.box.querySelector('input'), null);
});

test('lot renderer supplies the Caixa source link to the upload client', () => {
  const source = readFileSync(new URL('../v2/app.js', import.meta.url), 'utf8');
  const lot = source.slice(source.indexOf('function screenLot('));
  assert.match(lot, /data-az-source/);
});
