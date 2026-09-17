import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setup, response, until } from './dom.mjs';

const id = '034aa2e652ab4905';
const base = 'https://preco-real-analyze.preco-real.workers.dev';
const canonical = 'https://precodemartelo.com/leilao-de-imoveis/rj/rio-de-janeiro/lote/apartment-123/';
const analysis = {
  source_scope: 'lot_specific', resumo: 'A matrícula indica ocupação não informada.', ocupado: 'incerto',
  confianca: 'baixa', dividas: { iptu: 'Não informado', condominio: 'Não informado', outras: [] },
  riscos: ['Confira o documento integral.'], fase: 'Não informada', aviso: 'Análise automatizada sujeita a erros e omissões.',
  _meta: { cached: true, analyzed_at: '2026-09-15T12:00:00Z' },
};
const historical = {
  status: 'historical_document', lot_id: id, source_scope: 'historical_document', analyzed_at: '2026-09-16T01:00:00Z',
  document: { sha256: 'a'.repeat(64), captured_at: '2026-09-15T23:45:15.102912+00:00', page: 13, evidence_hash: 'b'.repeat(64) },
  match: { address: true, matricula: true, auction_dates: true },
  report: { language: 'pt', summary: 'O documento histórico indica ocupação.',
    findings: [{ kind: 'occupancy', statement: 'O documento histórico indica ocupação.', page: 13, quote: 'ocupado' }],
    auction_events: [{ date: '2026-07-21', time: '11:00', timezone: 'unknown', page: 1 }], document_date: '2026-06-19' },
  limitations: ['Não confirma disponibilidade atual.'],
};

test('static shells ship the copy runtime after the AI runtime', () => {
  for (const file of ['../v2/page.tpl.html', '../v2/index.tpl.html']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /parts\/analyze\.js/);
    assert.match(source, /parts\/copy-analysis\.js/);
    assert.ok(source.indexOf('parts/analyze.js') < source.indexOf('parts/copy-analysis.js'));
  }
  const prerender = readFileSync(new URL('../../prerender.py', import.meta.url), 'utf8');
  assert.match(prerender, /"parts\/copy-analysis\.js",/);
});

function canonicalLink(s, href = canonical) {
  const link = s.document.createElement('link');
  link.setAttribute('rel', 'canonical'); link.setAttribute('href', href);
  s.document.head.appendChild(link);
}

async function resultFixture({ writeText, lang = 'pt', canonicalHref = canonical } = {}) {
  const writes = [];
  const s = setup({
    url: canonical, analysisConfig: { apiBase: base, enabled: true, reportsEnabled: false },
    fetch: () => response(200, analysis),
  });
  canonicalLink(s, canonicalHref);
  s.window.LANG.code = lang;
  s.window.navigator.clipboard = { writeText: writeText || (async text => writes.push(text)) };
  s.load('analyze'); s.load('copy-analysis'); await s.analyze();
  await until(() => s.box.getAttribute('data-az-state') === 'result');
  s.window.COPY_ANALYSIS.wire();
  return { s, writes };
}

test('successful AI result copies visible text once and appends its validated canonical URL', async () => {
  const { s, writes } = await resultFixture();
  const button = s.box.querySelector('[data-copy-go]');
  assert.ok(button);
  await button.click(); await until(() => writes.length === 1);
  assert.match(writes[0], /A matrícula indica ocupação não informada/);
  assert.match(writes[0], /Análise automatizada sujeita a erros e omissões/);
  assert.equal(writes[0].match(new RegExp(canonical, 'g')).length, 1);
  assert.doesNotMatch(writes[0], /venda-imoveis\.caixa\.gov\.br/);
  assert.match(writes[0], /\n\nFonte: Preço Real\nhttps:\/\/precodemartelo\.com\/leilao-de-imoveis\/rj\/rio-de-janeiro\/lote\/apartment-123\/$/);
});

for (const lang of ['pt', 'en', 'ru']) test(`${lang} uses localized copy controls and source line`, async () => {
  const { s, writes } = await resultFixture({ lang });
  const button = s.box.querySelector('[data-copy-go]');
  assert.equal(button.textContent, s.translate('copy.button'));
  await button.click(); await until(() => writes.length === 1);
  assert.match(writes[0], new RegExp(s.translate('copy.source').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('canonical query, fragment and foreign origins never enter copied output', async () => {
  const tracked = canonical + '?utm_source=mail&utm_campaign=lot#share';
  const { s: clean, writes: cleanWrites } = await resultFixture({ canonicalHref: tracked });
  await clean.box.querySelector('[data-copy-go]').click(); await until(() => cleanWrites.length === 1);
  assert.equal(cleanWrites[0].split(canonical).length - 1, 1);
  assert.doesNotMatch(cleanWrites[0], /utm_|#share/);
  for (const foreign of ['https://evil.example/leilao-de-imoveis/rj/rio-de-janeiro/lote/x/',
    'https://precodemartelo.com.evil.example/leilao-de-imoveis/rj/rio-de-janeiro/lote/x/']) {
    const { s } = await resultFixture({ canonicalHref: foreign });
    assert.equal(s.document.querySelectorAll('[data-copy-analysis]').length, 0);
  }
});

test('clipboard failure exposes the same plain text as a selectable fallback', async () => {
  const { s } = await resultFixture({ writeText: () => Promise.reject(new Error('blocked')) });
  const button = s.box.querySelector('[data-copy-go]');
  await button.click();
  const fallback = s.box.querySelector('.copy-analysis-fallback');
  assert.ok(fallback); assert.equal(fallback.hidden, false); assert.equal(fallback.getAttribute('readonly'), '');
  assert.match(fallback.value, /Fonte: Preço Real/); assert.equal(fallback.focused, true);
});

test('displayed historical report also gets one copy control with citations and URL', async () => {
  const writes = [];
  const s = setup({ url: canonical, analysisConfig: { apiBase: base, enabled: false, reportsEnabled: true },
    fetch: () => response(200, historical) });
  canonicalLink(s);
  const report = s.document.createElement('section'); report.setAttribute('data-lot-report', id);
  s.document.body.appendChild(report); s.reportBox = report;
  s.window.navigator.clipboard = { writeText: async text => writes.push(text) };
  s.load('analyze'); await until(() => report.getAttribute('data-report-state') === 'displayed');
  s.load('copy-analysis'); s.window.COPY_ANALYSIS.wire();
  const button = s.document.body.querySelector('[data-copy-go]');
  assert.ok(button); await button.click(); await until(() => writes.length === 1);
  assert.match(writes[0], /O documento histórico indica ocupação/);
  assert.match(writes[0], /ocupado/); assert.match(writes[0], /Fonte: Preço Real/);
  assert.equal(writes[0].split(canonical).length - 1, 1);
});

test('rerender wiring does not duplicate the copy control or its listener', async () => {
  const { s, writes } = await resultFixture();
  s.window.COPY_ANALYSIS.wire(); s.window.COPY_ANALYSIS.wire();
  assert.equal(s.box.querySelectorAll('[data-copy-go]').length, 1);
  await s.box.querySelector('[data-copy-go]').click(); await until(() => writes.length === 1);
});

test('queued, unavailable and absent reports never expose a copy button', () => {
  const s = setup({ url: canonical, analysisConfig: { apiBase: base, enabled: true, reportsEnabled: false } });
  canonicalLink(s); s.load('copy-analysis');
  s.window.COPY_ANALYSIS.wire();
  assert.equal(s.document.querySelectorAll('[data-copy-analysis]').length, 0);
  s.box.setAttribute('data-az-state', 'pending'); s.window.COPY_ANALYSIS.wire();
  assert.equal(s.document.querySelectorAll('[data-copy-analysis]').length, 0);
});

test('market pricing blocks are not treated as AI analysis reports', () => {
  const s = setup({ url: canonical });
  canonicalLink(s); const market = s.document.createElement('section'); market.setAttribute('data-market-report', 'market-v1');
  market.textContent = 'Preços pedidos na venda'; s.document.body.appendChild(market);
  s.load('copy-analysis'); s.window.COPY_ANALYSIS.wire();
  assert.equal(s.document.querySelectorAll('[data-copy-analysis]').length, 0);
});
