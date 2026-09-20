// Offline consumer tests; every GET is a fixture, never a source/provider call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setup, response, deferred, until } from './dom.mjs';

const id = '008d136b4590d81f';
const base = 'https://preco-real-analyze.preco-real.workers.dev';
const result = {
  status: 'historical_document', lot_id: id, source_scope: 'historical_document', analyzed_at: '2026-09-16T01:00:00Z',
  document: { sha256: 'a'.repeat(64), captured_at: '2026-09-15T23:45:15.102912+00:00', page: 13, evidence_hash: 'b'.repeat(64) },
  match: { address: true, matricula: true, auction_dates: true },
  report: { language: 'pt', summary: 'Documento histórico <script>unsafe</script>',
    findings: [{ kind: 'occupancy', statement: 'O documento histórico indica ocupação.', page: 13, quote: 'ocupado' }],
    auction_events: [{ date: '2026-07-21', time: '11:00', timezone: 'unknown', page: 1 }], document_date: '2026-06-19' },
  limitations: ['Não confirma disponibilidade atual.'],
};
function fixture(options = {}) {
  const s = setup({ url: 'https://precodemartelo.com/leilao-de-imoveis/sp/sao-paulo/lote/historical-' + id + '/',
    analysisConfig: { apiBase: base, reportsEnabled: true, enabled: false }, storageBlocked: true,
    fetch: () => response(200, result), ...options });
  const box = s.document.createElement('section'); box.setAttribute('data-lot-report', id);
  s.document.body.appendChild(box); s.reportBox = box;
  return s;
}
const displayed = s => s.events.filter(e => e.name === 'lot_report_displayed');

for (const lang of ['pt', 'en', 'ru']) test(lang + ': cached historical report renders original dates/scope and emits display once after render', async () => {
  const s = fixture({ lang });
  s.window.track = (name, params) => {
    if (name === 'lot_report_displayed') {
      assert.equal(s.reportBox.getAttribute('data-report-state'), 'displayed');
      assert.match(s.reportBox.innerHTML, /2026-07-21/);
    }
    s.events.push({ name, params });
  };
  s.load('analyze');
  await until(() => s.reportBox.getAttribute('data-report-state') === 'displayed');
  s.window.ANALYZE.wire(); s.window.ANALYZE.wire();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].url, base + '/api/brazil-lot-reports/' + id);
  assert.equal(s.requests[0].method, 'GET'); assert.equal(s.requests[0].body, undefined);
  assert.equal(s.requests[0].credentials, 'omit'); assert.equal(s.requests[0].referrerPolicy, 'no-referrer');
  assert.equal(s.requests[0].redirect, 'error');
  const html = s.reportBox.innerHTML;
  for (const text of [s.translate('az.report.notice'), s.translate('az.report.scope'), s.translate('az.report.language'),
    result.document.captured_at, result.analyzed_at, '2026-07-21', 'lang="pt"']) assert.ok(html.includes(text));
  assert.ok(html.includes('&lt;script&gt;unsafe&lt;/script&gt;')); assert.doesNotMatch(html, /<script>|<button|\[az\./);
  assert.equal(displayed(s).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(displayed(s)[0].params)), { source_scope: 'historical_document' });
  assert.equal(s.events.filter(e => e.name === 'analyze_edital').length, 0);
  assert.equal(s.data.size, 0);
});

test('disabled reports/untrusted origin or endpoint do not GET or enable analysis', () => {
  for (const options of [
    { analysisConfig: { apiBase: base, enabled: true } },
    { analysisConfig: { apiBase: 'https://evil.example', reportsEnabled: true } },
    { url: 'https://evil.example/' }, { url: 'http://localhost/' },
  ]) {
    const s = fixture(options); s.load('analyze');
    assert.equal(s.requests.length, 0); assert.equal(displayed(s).length, 0);
  }
});

test('404/202/malformed/wrong lot/current/generic scope never render a report or signal conversion', async () => {
  const bodies = [
    [404, { status: 'not_available' }], [202, { status: 'pending' }], [200, {}],
    [200, { ...result, lot_id: '0d87bc6178c407cb' }],
    [200, { ...result, source_scope: 'lot_specific' }], [200, { ...result, source_scope: 'generic_rules' }],
    [200, { ...result, analyzed_at: 'not-date' }], [200, { ...result, match: { ...result.match, matricula: false } }],
    [200, { ...result, match: { address: true, matricula: true, auction_date: true } }],
    [200, { ...result, report: { ...result.report, summary: 'CPF 123.456.789-00' } }],
    [200, { ...result, report: { ...result.report, findings: [{ ...result.report.findings[0], quote: 'CPF 123.456.789-00' }] } }],
    [200, { ...result, report: { ...result.report, auction_events: [{ ...result.report.auction_events[0], date: '2026-02-30' }] } }],
  ];
  for (const [status, body] of bodies) {
    const s = fixture({ fetch: () => response(status, body) }); s.load('analyze');
    await until(() => s.reportBox.getAttribute('data-report-state') === 'unavailable');
    assert.equal(s.requests.length, 1); assert.equal(displayed(s).length, 0);
    assert.equal(s.events.filter(e => e.name === 'analyze_edital').length, 0);
    assert.ok(s.reportBox.innerHTML.includes(s.translate('az.report.unavailable')));
  }
});

test('navigation and network failure discard old response without polling/fallback/storage', async () => {
  const gate = deferred(), s = fixture({ fetch: () => gate.promise }); s.load('analyze');
  await until(() => s.requests.length === 1);
  s.reportBox.isConnected = false; gate.resolve(response(200, result));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(displayed(s).length, 0); assert.equal(s.requests.length, 1);
  const failed = fixture({ fetch: () => Promise.reject(Error('private diagnostic')) }); failed.load('analyze');
  await until(() => failed.reportBox.getAttribute('data-report-state') === 'unavailable');
  assert.equal(failed.requests.length, 1); assert.equal(displayed(failed).length, 0);
  assert.doesNotMatch(failed.reportBox.innerHTML, /private diagnostic/);
});

test('GA consent and allowlist keep display separate from conversion and omit identifiers/PII', async () => {
  const s = fixture({ storageBlocked: false }); s.load('analytics'); s.window.ANALYTICS.setConsent('accepted');
  s.load('analyze'); await until(() => s.reportBox.getAttribute('data-report-state') === 'displayed');
  const events = s.window.dataLayer.map(x => [...x]).filter(x => x[0] === 'event');
  const event = events.find(x => x[1] === 'lot_report_displayed');
  assert.ok(event); assert.equal(event[2].source_scope, 'historical_document');
  assert.doesNotMatch(JSON.stringify(event), new RegExp(id + '|2026-07-21|unsafe|sha256|matricula|CPF'));
  assert.equal(events.filter(x => ['analyze_edital', 'analysis_success', 'generate_lead'].includes(x[1])).length, 0);
  s.window.track('lot_report_displayed', { source_scope: 'private@example.test', lot_id: id, document: 'private' });
  assert.doesNotMatch(JSON.stringify([...s.window.dataLayer.at(-1)]), /private@example|lot_id|document/);
  const denied = fixture(); denied.load('analytics'); denied.load('analyze');
  await until(() => denied.reportBox.getAttribute('data-report-state') === 'displayed');
  assert.equal(denied.window.dataLayer, undefined);
});

test('both historical and current lot templates carry the report hook, not just Caixa input form', () => {
  const source = readFileSync(new URL('../v2/app.js', import.meta.url), 'utf8');
  assert.match(source.slice(source.indexOf('function screenHistoricalLot'), source.indexOf('function marketOnly')), /documentReportSlot\(r\[C.id\]\)/);
  assert.match(source.slice(source.indexOf('function screenLot(')), /documentReportSlot\(r\[C.id\]\)/);
  assert.match(source.slice(source.indexOf('function documentReportSlot'), source.indexOf('function wireDocumentReport')), /data-lot-report/);
});

test('existing explicit analysis preserves start/ok funnel without report display conversion', async () => {
  const analysis = { source_scope: 'generic_rules', resumo: 'Regras gerais apenas.', ocupado: 'incerto', confianca: 'baixa',
    dividas: { iptu: 'Não informado', condominio: 'Não informado', outras: [] }, riscos: [], fase: 'Não informada',
    aviso: 'Verifique a documentação.', _meta: { cached: true, analyzed_at: '2026-09-15T12:00:00Z' } };
  const s = fixture({ storageBlocked: false, analysisConfig: { apiBase: base, enabled: true, reportsEnabled: false },
    fetch: () => response(200, analysis) });
  s.load('analyze'); assert.equal(s.requests.length, 0);
  await s.analyze(); await s.analyze();
  assert.equal(s.requests.length, 1); assert.ok(s.requests.every(r => r.method === 'POST' &&
    r.url === base + '/analyze/lots/034aa2e652ab4905/one-click'));
  assert.equal(s.events.filter(e => e.name === 'analyze_edital' && e.params.stage === 'start').length, 1);
  assert.equal(s.events.filter(e => e.name === 'analyze_edital' && e.params.stage === 'ok').length, 1);
  assert.equal(displayed(s).length, 0);
});
