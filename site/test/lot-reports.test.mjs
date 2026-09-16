// Offline consumer tests. Fixtures model the strictly allowlisted Worker DTO;
// no source, PDF, model, Worker, or Analytics network request is made here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, response, until } from './dom.mjs';

const base = 'https://preco-real-analyze.preco-real.workers.dev';
const ids = ['008d136b4590d81f', '0d87bc6178c407cb'];

function dto(id) {
  return {
    status: 'historical_document', lot_id: id, source_scope: 'historical_document', analyzed_at: '2026-09-16T12:00:00Z',
    document: { sha256: 'a'.repeat(64), captured_at: '2026-09-16T10:00:00Z', page: 13, evidence_hash: 'b'.repeat(64) },
    match: { address: true, matricula: true, auction_dates: true },
    report: {
      language: 'pt', summary: 'Resumo histórico do documento, sem afirmação sobre o estado atual.',
      findings: [{ kind: 'occupancy', statement: 'O documento histórico registra ocupação na época.', page: 13, quote: 'ocupado na época do documento' }],
      auction_events: [{ date: '2026-07-21', time: '11:00', timezone: 'unknown', page: 1 }],
      document_date: '2026-06-19',
    },
    limitations: ['Este documento é histórico e não confirma disponibilidade ou condição atual.'],
  };
}

function fixture(id, options = {}) {
  const s = setup({ analysisConfig: { apiBase: base, reportsEnabled: true, enabled: false },
    fetch: () => response(200, dto(id)), ...options });
  const box = s.document.createElement('section');
  box.setAttribute('data-lot-report', id);
  s.document.body.appendChild(box);
  s.reportBox = box;
  return s;
}

for (const id of ids) test('valid historical report renders citations before a consented display event: ' + id, async () => {
  const s = fixture(id);
  s.load('analytics');
  s.window.ANALYTICS.setConsent('accepted');
  s.load('analyze');
  await until(() => s.reportBox.getAttribute('data-report-state') === 'displayed');
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].url, base + '/api/brazil-lot-reports/' + id);
  assert.equal(s.requests[0].method, 'GET');
  assert.equal(s.requests[0].body, undefined);
  const html = s.reportBox.innerHTML;
  assert.match(html, /2026-07-21/);
  assert.match(html, /ocupado na época do documento/);
  assert.match(html, /página 13/);
  assert.equal(html.includes('<script>'), false);
  const events = (s.window.dataLayer || []).filter(item => item[0] === 'event' && item[1] === 'lot_report_displayed');
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(events[0][2])), {
    page_type: 'lot', lang: 'pt', city_code: 'rio-de-janeiro-rj', source_scope: 'historical_document',
    page_location: 'https://precodemartelo.com/casa-brazil/leilao-de-imoveis/rj/rio-de-janeiro/lote/', page_referrer: '', page_title: 'lot', send_to: 'G-TEST123',
  });
  assert.doesNotMatch(JSON.stringify(events[0]), new RegExp(id + '|2026-07-21|ocupado|sha256|matricula', 'i'));
});

test('without consent or with malformed/PII DTO, there is no report display event', async () => {
  const id = ids[0];
  const denied = fixture(id);
  denied.load('analytics'); denied.load('analyze');
  await until(() => denied.reportBox.getAttribute('data-report-state') === 'displayed');
  assert.equal(denied.window.dataLayer, undefined);

  for (const bad of [
    { ...dto(id), match: { address: true, matricula: true, auction_date: true } },
    { ...dto(id), report: { ...dto(id).report, findings: [{ ...dto(id).report.findings[0], quote: 'CPF 123.456.789-00' }] } },
    { ...dto(id), report: { ...dto(id).report, auction_events: [] } },
    { ...dto(id), report: { ...dto(id).report, document_date: '2026-02-30' } },
  ]) {
    const s = fixture(id, { fetch: () => response(200, bad) });
    s.load('analytics'); s.window.ANALYTICS.setConsent('accepted'); s.load('analyze');
    await until(() => s.reportBox.getAttribute('data-report-state') === 'unavailable');
    assert.equal((s.window.dataLayer || []).filter(item => item[1] === 'lot_report_displayed').length, 0);
  }
});
