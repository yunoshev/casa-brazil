import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../site/v2/app.js', import.meta.url), 'utf8');
const catalogs = Object.fromEntries(['pt', 'en', 'ru'].map(lang => [
  lang, JSON.parse(readFileSync(new URL(`../site/i18n/${lang}.json`, import.meta.url))),
]));

const keys = [
  'lifecycle.status.active', 'lifecycle.status.unverified', 'lifecycle.status.missing',
  'lifecycle.status.archived', 'lifecycle.inventory', 'lifecycle.notice.current',
  'lifecycle.notice.removed', 'lifecycle.fact.last_seen', 'lifecycle.fact.last_checked',
  'lifecycle.fact.missing_since', 'lifecycle.fact.archived_at', 'lifecycle.fact.last_price',
  'lifecycle.fact.appraisal', 'lifecycle.date.unknown', 'lifecycle.historical.title',
  'lifecycle.historical.body', 'lifecycle.archive.link', 'lifecycle.archive.title',
  'lifecycle.archive.body', 'lifecycle.archive.view', 'lifecycle.area.archive_note',
  'lifecycle.area.archive_body', 'lifecycle.current_lists', 'head.page', 'head.page.of',
  'lifecycle.archive.short', 'lifecycle.pagination.label', 'lifecycle.pagination.previous',
  'lifecycle.pagination.next', 'lifecycle.pagination.page',
  'head.archive.title', 'head.archive.desc', 'head.all.lifecycle.title',
  'head.all.lifecycle.desc', 'head.lot.historical.title', 'head.lot.historical.desc',
  'head.lot.unverified.title', 'head.lot.unverified.desc',
];

for (const [lang, catalog] of Object.entries(catalogs)) {
  for (const key of keys) assert.equal(typeof catalog[key], 'string', `${lang} missing ${key}`);
  const render = (key, vars = {}) => catalog[key].replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? `{${name}}`);
  assert.match(render('lifecycle.inventory', { active: '12', unverified: '3' }), /12|12/);
  if (lang !== 'pt') assert.notEqual(render('lifecycle.status.active'), catalogs.pt['lifecycle.status.active'], `${lang} must not fall back to PT`);
}

const visibleLifecycleLiterals = [
  'Disponível na última verificação', 'Disponibilidade não confirmada',
  'Ofertas ativas verificadas:', 'Registro histórico', 'Arquivo de registros',
  'Registros históricos permanecem no arquivo.', 'Registro ausente da lista atual',
];
for (const literal of visibleLifecycleLiterals) {
  assert.equal(app.includes(literal), false, `hardcoded lifecycle copy remains: ${literal}`);
}

for (const marker of ['t("lifecycle.status."', 't("lifecycle.inventory"', '"lifecycle.notice.current"', 't("lifecycle.fact.', 't("head.archive.', 't("head.all.lifecycle.', 't("head.lot.historical.', 't("head.lot.unverified.']) {
  assert.ok(app.includes(marker), `app should translate ${marker}`);
}

console.log('lifecycle i18n: PT/EN/RU catalogs complete and lifecycle copy is translated');
