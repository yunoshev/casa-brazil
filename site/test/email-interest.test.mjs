import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, response } from './dom.mjs';

const name = 'analysis_email_interest_submitted';
const emitted = s => (s.window.dataLayer || []).filter(e => e[0] === 'event' && e[1] === name);
async function fixture(consent) {
  const s = setup({ fetch: () => response(502, { error: 'analysis_validation_failed' }) });
  s.load('analytics');
  if (consent) s.window.ANALYTICS.setConsent(consent);
  s.load('analyze'); await s.analyze();
  return s;
}

test('an error offers the release-style email UI without sending an address', async () => {
  const s = await fixture('accepted');
  const panel = s.document.querySelector('.az-interest');
  assert.match(panel.textContent, /Receber a análise por email/);
  const input = panel.querySelector('input');
  assert.equal(input.getAttribute('type'), 'email');
  assert.equal(input.hasAttribute('required'), true);
  assert.equal(input.hasAttribute('name'), false);
  assert.equal(input.getAttribute('autocomplete'), 'off');
  assert.equal(emitted(s).length, 0);
});

test('one confirmed valid form emits one event without reading the input or sending/saving it', async () => {
  const s = await fixture('accepted');
  const panel = s.document.querySelector('.az-interest'), form = panel.querySelector('form');
  const input = panel.querySelector('input');
  Object.defineProperty(input, 'value', {get() { throw Error('Input value must never be read'); }});
  const before = JSON.stringify([...s.data]), calls = s.requests.length;
  await form.emit('submit'); await form.emit('submit');
  assert.equal(emitted(s).length, 1);
  assert.equal(s.requests.length, calls);
  assert.equal(JSON.stringify([...s.data]), before);
  assert.equal(panel.querySelector('input'), null);
  assert.match(panel.textContent, /envio por email ainda não está disponível/);
  assert.match(panel.textContent, /não foi enviado nem salvo/);
  const keys = Object.keys(emitted(s)[0][2]);
  assert.ok(!keys.some(k => /email|hash|visitor|idempotency|ticket|input/.test(k)));
});

test('native validity must pass; no event is sent for an empty or invalid form', async () => {
  const s = await fixture('accepted');
  const form = s.document.querySelector('.az-interest-form');
  form.checkValidity = () => false;
  await form.emit('submit');
  assert.equal(emitted(s).length, 0);
  assert.ok(form.querySelector('input'));
});

for (const consent of [undefined, 'rejected']) test(`interest works with ${consent || 'no'} analytics consent, without a Google event`, async () => {
  const s = await fixture(consent);
  await s.document.querySelector('.az-interest-form').emit('submit');
  assert.equal(emitted(s).length, 0);
  assert.equal(s.window.dataLayer, undefined);
  assert.equal(s.document.querySelector('.az-interest input'), null);
  s.window.ANALYTICS.setConsent('accepted');
  assert.equal(emitted(s).length, 0, 'never replay pre-consent interest');
});

test('analytics allowlist strips even accidentally supplied email, hash and value', async () => {
  const s = await fixture('accepted');
  s.window.track(name, { email: 'private@example.test', email_hash: 'private-hash', value: 'private-value', job_id: 'private-job' });
  assert.equal(emitted(s).length, 1);
  assert.doesNotMatch(JSON.stringify(emitted(s)), /private-|private@|email_hash|job_id/);
});
