import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, response, deferred, until } from './dom.mjs';

const ticket = '00000000-0000-4000-8000-000000000001.1790000000.' + 'a'.repeat(64);
const pending = (status, extra = {}) => response(202, {status,
  reason: {queued:'queued',fetching:'fetching_document',analyzing:'analyzing'}[status],
  analysis_id:'job',job_ticket:ticket,retry_after_seconds:5,...extra});

function fixture(fetch) {
  let now = 1000000;
  class Clock extends Date { static now() { return now; } }
  const s = setup({fetch, Date:Clock});
  const hero = s.document.createElement('button');
  hero.setAttribute('data-analysis-cta',''); s.document.body.appendChild(hero);
  s.load('analyze');
  return {s,hero,advance(ms) { now += ms; }};
}

test('one-minute countdown becomes elapsed time, never a fabricated completion percentage', async () => {
  const gate = deferred();
  const {s,hero,advance} = fixture(() => gate.promise);
  const task = hero.click(); await until(() => s.requests.length === 1);
  const panel = s.document.querySelector('.az-progress');
  assert.equal(panel.parentElement, hero.parentElement);
  assert.equal(panel.querySelector('[data-az-clock]').textContent, '1:00');
  advance(1000); s.runTimers(1000);
  assert.equal(panel.querySelector('[data-az-clock]').textContent, '0:59');
  advance(59000); s.runTimers(1000);
  assert.equal(panel.querySelector('[data-az-clock]').textContent, '1:00');
  assert.equal(panel.querySelector('[data-az-clock-label]').textContent, s.translate('az.progress.elapsed'));
  assert.doesNotMatch(panel.textContent, /100%|concluído/);
  gate.resolve(response(502,{error:'analysis_validation_failed'})); await task;
  assert.equal(panel.hidden,true);
  assert.equal(s.timers.size,0);
  assert.equal(hero.disabled,true);
  assert.equal(s.box.querySelector('.azmsg').textContent,s.translate('az.err.validation'));
});

test('server stages change only on responses; after two minutes status checking reuses ticket', async () => {
  const {s,hero,advance} = fixture((request,n) => pending(n===1?'fetching':'analyzing'));
  const task = hero.click(); await until(() => s.requests.length===1 && s.box.getAttribute('data-az-state')==='pending');
  const panel = s.document.querySelector('.az-progress');
  assert.equal(panel.getAttribute('data-az-stage'),'document');
  advance(5000); s.runTimers(5000);
  await until(() => s.requests.length===2 && panel.getAttribute('data-az-stage')==='analyzing');
  assert.equal(panel.querySelectorAll('[data-az-step]')[0].getAttribute('data-step-state'),'done');
  advance(115000); s.runTimers(5000); await task;
  assert.equal(s.box.getAttribute('data-az-state'),'background');
  assert.equal(hero.getAttribute('aria-busy'),'false');
  assert.equal(hero.disabled,false);
  assert.equal(hero.textContent,s.translate('az.progress.check'));
  assert.equal(s.timers.size,0);
  const retry = hero.click(); await until(() => s.requests.length===4);
  s.box.isConnected=false; s.runTimers(5000); await retry;
  assert.equal(s.requests.filter(r=>r.method==='POST').length,1);
  assert.ok(s.requests.slice(1).every(r=>r.method==='GET' && r.url.endsWith(ticket)));
});

test('long source pause immediately switches to background without a false one-minute promise', async () => {
  const {s,hero} = fixture(() => pending('queued',{retry_not_before_seconds:1800}));
  await hero.click();
  assert.equal(s.box.getAttribute('data-az-state'),'background');
  assert.match(s.box.querySelector('.azmsg').textContent,/30 min/);
  assert.equal(s.document.querySelector('.az-clock').hidden,true);
  assert.equal(s.requests.length,1);
  assert.equal(s.timers.size,0);
});

test('PDF-ready queued state is distinct from waiting to download', async () => {
  const {s,hero} = fixture(() => pending('queued',{document_ready:true}));
  const task = hero.click(); await until(()=>s.box.getAttribute('data-az-state')==='pending');
  assert.equal(s.document.querySelector('.az-progress').getAttribute('data-az-stage'),'analysis_queue');
  assert.equal(s.box.querySelector('.azmsg').textContent,s.translate('az.progress.analysis_queue'));
  s.box.isConnected=false;s.runTimers(5000);await task;
  assert.equal(s.timers.size,0);
});
