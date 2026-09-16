// Lifecycle regression: every public lot URL survives a source refresh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../site/v2/app.js', import.meta.url), 'utf8').split('/* ---- boot ')[0];
const cols = ['id', 'src', 'bairro', 'end', 'tipo', 'area', 'quartos', 'preco', 'hammer',
  'margin', 'mkt', 'aval', 'avalpct', 'n', 'ring', 'conf', 'jud', 'mod', 'data', 'link', 'promised', 'why'];
const C = Object.fromEntries(cols.map((key, i) => [key, i]));
const row = fields => cols.map(key => fields[key] ?? null);
const city = { slug: 'teste-sp', uf: 'sp', cslug: 'teste', nome: 'Teste', cidade: 'TESTE',
  stats: {}, chain: {}, shapes: null, market: {}, streets: {}, lifecycle: {}, rows: [] };

for (let i = 0; i < 9218; i++) {
  const id = `lot-${String(i).padStart(5, '0')}`;
  // Audited source state: active 2,065; unverified 2,311; missing 4,842.
  const status = i < 2065 ? 'active' : i < 4376 ? 'unverified' : 'missing';
  city.rows.push(row({ id, src: 'caixa', bairro: 'CENTRO', end: `Rua ${i}`, tipo: 'apartamento',
    area: 50, preco: 100000 + i, hammer: 90000, margin: 10, mkt: 110000, aval: 120000,
    n: 5, ring: 500, conf: 'ok', promised: 50 }));
  city.lifecycle[id] = { status, slug: `url-congelada-${id}`, last_price_brl: 100000 + i,
    last_seen_at: '2026-09-14', last_checked_at: '2026-09-15',
    missing_since: status === 'missing' ? '2026-09-15' : null };
}

const PT = {
  'lifecycle.status.active': 'Disponível na última verificação',
  'lifecycle.status.unverified': 'Disponibilidade não confirmada',
  'lifecycle.status.missing': 'Ausente da fonte na última verificação',
  'lifecycle.status.archived': 'Arquivado do catálogo atual',
  'lifecycle.inventory': 'Ofertas ativas verificadas: {active}. Registros conhecidos sem confirmação: {unverified}. Disponibilidade não confirmada não é oferta ativa.',
  'lifecycle.notice.current': 'Este registro não confirma que o imóvel continue disponível.',
  'lifecycle.notice.removed': 'Removido das listas atuais; ausência não significa venda.',
  'lifecycle.fact.last_seen': 'Última observação',
  'lifecycle.fact.last_checked': 'Última verificação',
  'lifecycle.fact.missing_since': 'Ausente desde',
  'lifecycle.fact.archived_at': 'Arquivado em',
  'lifecycle.fact.last_price': 'Último preço anunciado',
  'lifecycle.fact.appraisal': 'Avaliação registrada',
  'lifecycle.date.unknown': 'Não informada',
  'lifecycle.historical.title': 'Registro histórico',
  'lifecycle.historical.body': 'Preço anunciado mais recente — não é preço de venda.',
  'lifecycle.archive.link': 'Arquivo de registros',
  'lifecycle.archive.title': 'Arquivo de registros',
  'lifecycle.archive.body': 'Registros ausentes ou arquivados, mantidos para que URLs publicados não desapareçam.',
  'lifecycle.archive.view': 'Ver arquivo',
  'lifecycle.archive.short': 'Arquivo',
  'lifecycle.pagination.label': 'Paginação',
  'lifecycle.pagination.previous': 'Anterior',
  'lifecycle.pagination.next': 'Próxima',
  'lifecycle.pagination.page': 'Página {page} de {pages}',
  'lifecycle.area.archive_note': 'Registros históricos permanecem no arquivo.',
  'lifecycle.area.archive_body': 'Estes imóveis não entram nos resumos atuais.',
  'lifecycle.current_lists': 'Listas atuais',
  'head.page': ' · página {page}',
  'head.page.of': ' Página {page} de {pages}.',
  'head.archive.title': 'Arquivo de registros — {city}{page}',
  'head.archive.desc': 'Registros ausentes ou arquivados: {count}. Ausência da fonte não confirma venda.{page}',
  'head.all.lifecycle.title': 'Registros conhecidos — {city}{page}',
  'head.all.lifecycle.desc': '{known} registros conhecidos; {active} ofertas ativas verificadas e {unverified} sem disponibilidade confirmada.{page}',
  'head.lot.historical.title': 'Registro histórico — {what}, {where}',
  'head.lot.historical.desc': 'Registro ausente da lista atual; a ausência não confirma venda. Último preço anunciado: {price}.',
  'head.lot.unverified.title': 'Disponibilidade não confirmada — {what}, {where}',
  'head.lot.unverified.desc': 'Registro conhecido em {city}; a disponibilidade atual não foi confirmada.',
};
const interpolate = (template, vars) => template.replace(/\{(\w+)\}/g, (_, key) => vars?.[key] ?? '');
const LANG = { code: 'pt', langs: ['pt'], names: { pt: 'Português' }, num: String, money: String,
  pct: String, plur: key => key, t: (key, vars, fallback) => interpolate(PT[key] || fallback || key, vars) };
const window = { __D__: { cols, cities: [city], generated: null }, __SHIP_LANGS__: ['pt'] };
const ctx = vm.createContext({ window, LANG, URL });
vm.runInContext(source, ctx);
ctx.indexCity(city);

const links = html => [...html.matchAll(/class="row lot" href="([^"]+)"/g)].map(m => m[1]);
function crawl(runtime, kind) {
  let path = runtime.href(kind), total = [], pages = 0;
  while (path) {
    const html = runtime.screenFor(path);
    assert.equal(typeof html, 'string', path);
    const pageLinks = links(html);
    assert.ok(pageLinks.length <= 200);
    total.push(...pageLinks); pages++;
    path = /<a rel="next" href="([^"]+)"/.exec(html)?.[1] || null;
  }
  return { total, pages };
}

const current = crawl(ctx, '/all'), archived = crawl(ctx, '/archive');
assert.equal(city.stats.lots, 2065, 'only confirmed-active lots enter offer stats');
assert.equal(city.stats.unverified_lots, 2311);
assert.equal(current.total.length, 4376, 'unverified records stay findable but are not offers');
assert.equal(archived.total.length, 4842);
assert.equal(current.pages, 22);
assert.equal(archived.pages, 25);
assert.notEqual(ctx.headFor(ctx.href('/archive')).title, ctx.headFor(ctx.href('/archive') + 'pagina/2/').title);
assert.notEqual(ctx.headFor(ctx.href('/all')).title, ctx.headFor(ctx.href('/all') + 'pagina/2/').title);
assert.equal(new Set([...current.total, ...archived.total]).size, 9218, 'no public lot URL is lost');
assert.ok(ctx.screenAll().includes('Disponibilidade não confirmada não é oferta ativa'));
assert.ok(ctx.screenArchive().includes('mantidos para que URLs publicados não desapareçam'));
const archivedLot = city.rows.at(-1);
const frozen = ctx.href(`/l/${archivedLot[C.id]}`);
archivedLot[C.end] = 'Endereço alterado';
ctx.indexCity(city);
assert.equal(ctx.href(`/l/${archivedLot[C.id]}`), frozen, 'lifecycle slug is permanent');
assert.match(ctx.screenFor(frozen), /Preço anunciado mais recente — não é preço de venda/);
assert.match(ctx.headFor(frozen).title, /^Registro histórico/);
assert.match(ctx.headFor(frozen).desc, /não confirma venda/);
const unverifiedLot = city.rows[2065];
const unverifiedPath = ctx.href(`/l/${unverifiedLot[C.id]}`);
assert.match(ctx.headFor(unverifiedPath).title, /^Disponibilidade não confirmada/);
assert.match(ctx.headFor(unverifiedPath).desc, /não foi confirmada/);
console.log('archive refresh: 9,218 lifecycle rows, frozen URLs and paginated archive passed');

// Optional release preflight: node test/archive_refresh.mjs site/v2/index.html
// This is deliberately VM-only: it checks every public renderer route without
// needing Chrome, a network source or a write to the published tree.
if (process.argv[2]) {
  const input = readFileSync(process.argv[2], 'utf8');
  const embedded = /<script>window\.__D__\s*=\s*(.*?);<\/script>/s.exec(input);
  const payload = JSON.parse(embedded ? embedded[1] : input);
  assert.equal(payload.lifecycle_schema_version, 1, 'payload must declare lifecycle schema v1');
  const liveWindow = { __D__: payload, __SHIP_LANGS__: ['pt'] };
  const live = vm.createContext({ window: liveWindow, LANG, URL });
  vm.runInContext(source, live);
  let lots = 0, active = 0, unverified = 0, missing = 0, archived = 0;
  for (const c of payload.cities) {
    live.indexCity(c);
    const base = live.cityBase(c);
    for (const path of ['/', base]) assert.equal(typeof live.screenFor(path), 'string', path);
    const currentLive = crawl(live, '/all'), archiveLive = crawl(live, '/archive');
    const found = new Set([...currentLive.total, ...archiveLive.total]);
    const expected = new Set(c.rows.map(r => live.href(`/l/${encodeURIComponent(r[live.C.id])}`)));
    assert.deepEqual(found, expected, `${c.nome}: every lot URL must be emitted through a bounded catalogue`);
    for (const key of Object.keys(live.slugToKey.rev)) {
      const path = base + live.slugToKey.rev[key] + '/';
      assert.equal(typeof live.screenFor(path), 'string', path);
    }
    for (const code of Object.keys((c.streets || {}).d || {})) {
      const path = live.href(`/r/${encodeURIComponent(code)}`);
      assert.equal(typeof live.screenFor(path), 'string', path);
    }
    for (const r of c.rows) {
      const state = live.lotStatus(r);
      if (state === 'active') active++;
      else if (state === 'unverified') unverified++;
      else if (state === 'missing') missing++;
      else if (state === 'archived') archived++;
      const path = live.href(`/l/${encodeURIComponent(r[live.C.id])}`);
      assert.equal(typeof live.screenFor(path), 'string', path);
      lots++;
    }
  }
  assert.ok(lots > 0, 'built payload must contain lots');
  console.log(`archive preflight: ${lots} lot routes render; states=${JSON.stringify({ active, unverified, missing, archived })}`);
}
