import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setup } from './dom.mjs';

const code = readFileSync(new URL('../v2/app.js', import.meta.url), 'utf8').split('/* ---- boot ')[0];
const reports = JSON.parse(readFileSync(new URL('../content/document-reports.json', import.meta.url))).reports;
const id = Object.keys(reports)[0];
const canonical = 'https://precodemartelo.com/leilao-de-imoveis/sp/sao-paulo/lote/test-034aa2e652ab4905/';

function runtime(clipboard) {
  const page = setup({ lang: 'pt' });
  page.ctx = vm.createContext(page.window);
  page.window.__D__ = { cols: [], cities: [], document_reports: reports };
  const cat = JSON.parse(readFileSync(new URL('../i18n/pt.json', import.meta.url)));
  page.ctx.LANG = { t: (key, vars = {}) => (cat[key] || key).replace(/\{(\w+)\}/g, (_, k) => vars[k]),
    plur: String, num: String, money: String, pct: String };
  page.ctx.URL = URL;
  page.ctx.navigator.clipboard = clipboard;
  page.ctx.location.href = canonical + '?utm_source=test#foo';
  vm.runInContext(code, page.ctx);
  page.document.body.innerHTML = page.ctx.documentReportSlot(id);
  const select = page.document.querySelector.bind(page.document);
  page.document.querySelector = s => s === 'link[rel="canonical"]'
    ? { getAttribute: () => canonical + '?utm_source=test#foo' } : select(s);
  const fallback = page.document.querySelector('[data-document-copy-fallback]');
  fallback.select = () => { fallback.selected = true; };
  return page;
}

test('reviewed report is complete HTML inside a closed native disclosure, without API analysis', () => {
  const p = runtime({ writeText: async () => {} });
  const html = p.ctx.documentReportSlot(id);
  assert.match(html, /HIS-2/);
  assert.match(html, /<details data-document-report-disclosure><summary/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(html, /não do PDF original/);
  assert.match(html, /Fonte: página 3/);
  assert.doesNotMatch(html, /data-lot-report=|data-az=/);
  assert.match(p.ctx.documentReportSlot('unknown'), /data-lot-report="unknown"/);
});

test('hero link reveals saved report without another AI request', async () => {
  const p = runtime({ writeText: async () => {} });
  const link = p.document.createElement('a');
  link.setAttribute('href', '#document-report');
  p.document.body.appendChild(link);
  const selectAll = p.document.querySelectorAll.bind(p.document);
  p.document.querySelectorAll = selector => selector === 'a[href="#document-report"]' ? [link] : selectAll(selector);
  p.ctx.wireDocumentReport(p.document);
  await link.emit('click');
  assert.equal(p.document.querySelector('[data-document-report-disclosure]').open, true);
});

test('copy includes limitations and clean canonical once, and wiring is idempotent', async () => {
  const copied = [];
  const p = runtime({ writeText: async v => copied.push(v) });
  p.ctx.wireDocumentReport(p.document);
  p.ctx.wireDocumentReport(p.document);
  await p.document.querySelector('[data-copy-document-report]').emit('click');
  assert.equal(copied.length, 1);
  assert.match(copied[0], /Não é parecer jurídico/);
  assert.ok(copied[0].endsWith('Fonte: Preço Real\n' + canonical));
  assert.doesNotMatch(copied[0], /utm_source|#foo/);
  assert.match(p.document.querySelector('[data-document-copy-status]').textContent, /copiados/);
});

test('denied clipboard presents selectable text, not false success', async () => {
  const p = runtime({ writeText: async () => { throw new Error('denied'); } });
  p.ctx.wireDocumentReport(p.document);
  await p.document.querySelector('[data-copy-document-report]').emit('click');
  const fallback = p.document.querySelector('[data-document-copy-fallback]');
  assert.equal(fallback.hidden, false);
  assert.equal(fallback.selected, true);
  assert.ok(fallback.value.endsWith(canonical));
  assert.match(p.document.querySelector('[data-document-copy-status]').textContent, /Não foi possível/);
});
