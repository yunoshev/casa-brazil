"use strict";
/* Preço Real — three screens, one file.
 *
 * city -> area -> lot, addressed by hash so every level is a URL the reader can
 * send to someone. The map is the navigation: nothing on it is decorative,
 * every outline is a tap target, and zooming is the route changing.
 *
 * No prose lives here. Every visible string comes through t() from
 * i18n/<lang>.json, and build.py refuses to build if one is missing. The only
 * words written out below are CSS class names and keys. */

var D = window.__D__;
var C = {};
D.cols.forEach(function (c, i) { C[c] = i; });

var t = LANG.t, plur = LANG.plur, num = LANG.num, money = LANG.money, pct = LANG.pct;

/* ---- formatting ------------------------------------------------ */

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function b(s) { return "<b>" + s + "</b>"; }

/* Portuguese title-casing, and deliberately not translated: this folds the
 * *data* — Brazilian street and district names — not the interface. A Russian
 * or English reader still wants "Rua do Catete", not "Rua Do Catete". */
function title(s) {
  var small = { de: 1, da: 1, do: 1, das: 1, dos: 1, e: 1, em: 1, a: 1, o: 1 };
  return String(s || "").toLowerCase().split(/\s+/).map(function (w, i) {
    return i && small[w] ? w : w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}
function normKey(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .trim().toUpperCase();
}
function $(id) { return document.getElementById(id); }

/* ---- lot helpers ----------------------------------------------- */

/* A verdict is withheld, never guessed: too few comps, or comps drawn from too
 * far away, describe a district rather than an address. */
function reliable(r) { return r[C.conf] === "ok" && r[C.ring] <= 1000; }

/* A city we carry for its paid side only: no comps pipeline, no hammer chain,
 * every verdict withheld. The screens say what the city *does* have — the
 * register — instead of printing zeros against a promise we never made. */
function marketOnly(c) {
  c = c || city;
  return !(c.chain && c.chain.hammer_over_asking);
}

var TIERS = [
  [35, "good", "lot.verdict.much_cheaper"],
  [15, "good", "lot.verdict.cheaper"],
  [-15, "mute", "lot.verdict.normal"],
  [-35, "bad", "lot.verdict.dearer"],
];
function verdict(r) {
  if (!reliable(r)) return null;
  for (var i = 0; i < TIERS.length; i++) if (r[C.margin] >= TIERS[i][0]) return TIERS[i];
  return [-999, "bad", "lot.verdict.much_dearer"];
}

/* Caixa serves a photo for every lot at a URL derived from the listing id.
 * Nothing else in the registry carries images yet, so the slot stays empty and
 * says so rather than showing a stand-in that pretends to be the building. */
function photo(r) {
  var m = /hdnimovel=(\d+)/.exec(r[C.link] || "");
  return m ? "https://venda-imoveis.caixa.gov.br/fotos/F" + m[1] + "21.jpg" : null;
}

/* ---- colour ---------------------------------------------------- */

/* Colour answers the only question the map is for: is there anything to catch
 * here. That is the *share* of lots opening below the going hammer, not the
 * median margin — by median almost every district in Rio is dear, which paints
 * the whole city one shade of red and hides the districts where a third of the
 * lots are genuinely cheap. The count of those lots rides in the label, so the
 * number and the colour always say the same thing.
 *
 * The pivot sits at 30%: near the city-wide share, so an area reads as better
 * or worse than its city rather than better or worse than nothing. */
/* A class, not a colour.
 *
 * These fills used to be mixed in JavaScript from whatever the stylesheet said
 * at the moment of drawing. That works while the page is drawn in the reader's
 * own browser and breaks the instant it is drawn once, at build time, and
 * shipped flat: the colours of whichever theme the build happened to run under
 * would be baked into the file, and every reader on the other theme would get
 * a map painted for the wrong one.
 *
 * Seven steps either side of the pivot is more than the eye separates anyway,
 * and the markup gets smaller for it. Step 0 stays deliberately tinted rather
 * than pale — an area sitting exactly on the pivot must not come out the
 * colour of "no data", or the map tells the reader nothing while looking like
 * it had. */
var TINTS = 6;

function tint(share, count) {
  if (share == null || !count) return "q-none";
  var k = Math.max(-1, Math.min(1, (share - 0.3) / 0.2));
  var step = Math.round(Math.abs(k) * TINTS);
  return (k > 0 ? "q-up-" : "q-dn-") + step;
}

/* ---- the map --------------------------------------------------- */

/* The union of the boxes we are about to paint. São Paulo traces all the way
 * down to Marsilac, where no lot has ever come up for auction; framing the
 * whole outline spent 40% of a phone screen on empty grey. The ghost layer
 * still draws the rest, so the city keeps its shape at the edges. */
function frame(keys) {
  var at = city.shapes.at, box = null;
  keys.forEach(function (k) {
    var bx = at[k];
    if (!bx) return;
    box = box
      ? [Math.min(box[0], bx[2]), Math.min(box[1], bx[3]),
         Math.max(box[2], bx[4]), Math.max(box[3], bx[5])]
      : [bx[2], bx[3], bx[4], bx[5]];
  });
  return box;
}

function viewBox(box, pad) {
  var w = box[2] - box[0], h = box[3] - box[1];
  var p = pad * Math.max(w, h);
  return [box[0] - p, box[1] - p, w + 2 * p, h + 2 * p];
}

/* `cells` carry a `key` into the outline store plus the numbers to paint with.
 * Anything without an outline is simply not drawn — its lots are still in the
 * list below, which is where the map's coverage gap is admitted, not hidden. */
function drawMap(cells, opts) {
  var sh = city.shapes;
  if (!sh) return "";
  var vb = viewBox(opts.box || sh.box, opts.pad == null ? 0.02 : opts.pad);
  var fs = vb[2] / 34;
  var out = ['<svg class="map shapes" viewBox="' + vb.join(" ") +
    (opts.cover ? '" preserveAspectRatio="xMidYMid slice' : "") +
    '" role="group" aria-label="' + esc(opts.aria) + '">'];

  // Every area we can draw, in the sunk colour, so the painted ones read as
  // part of a city rather than floating in the dark.
  var ghost = [];
  Object.keys(sh.d).forEach(function (k) { ghost.push(sh.d[k]); });
  out.push('<path class="ghost" d="' + ghost.join("") +
    '" stroke-width="' + (vb[2] / 900) + '"/>');

  var labels = [];
  cells.forEach(function (c) {
    var d = sh.d[c.key];
    if (!d) return;
    // A real anchor, not a scripted <g>: on a static page the map has to work
    // before any JavaScript does, and a link is also something a crawler
    // follows into the district pages that carry the site's whole argument.
    out.push('<a class="cell' + (c.key === opts.active ? " on" : "") +
      '" href="' + esc(c.go) + '" aria-label="' + esc(c.aria) +
      '"><path class="area ' + tint(c.share, c.rel) + '" d="' + d +
      '" stroke-width="' + (vb[2] / 700) + '"/></a>');
    var at = sh.at[c.key];
    if (at) labels.push({ w: at[4] - at[2], x: at[0], y: at[1], s: areaName(c.key) });
  });

  // Cap the count as well as the size: a city of 150 areas will happily pass a
  // dozen names that individually fit and collectively are a hedge.
  labels = labels.filter(function (l) { return l.w >= l.s.length * fs * 0.46; });
  if (opts.cover) {
    // The banner is one frame shown through two very different windows, and
    // `slice` crops whichever axis has slack. A desktop banner is far wider
    // than the frame, so it keeps the full width and loses top and bottom; a
    // phone card is nearly square, so it keeps the full height and loses the
    // sides. A name near a cropped edge renders decapitated, and no label
    // beats half a label — so names outside the *desktop* safe area are
    // dropped outright, and those outside the much narrower *phone* one are
    // marked `wide` and hidden by the stylesheet below 900px.
    var cx = vb[0] + vb[2] / 2, cy = vb[1] + vb[3] / 2;
    labels = labels.filter(function (l) {
      if (Math.abs(l.y - cy) >= vb[3] * 0.27) return false;
      l.wide = Math.abs(l.x - cx) >= vb[2] * 0.17;
      return Math.abs(l.x - cx) < vb[2] * 0.44;
    });
  }
  labels.sort(function (x, y) { return y.w - x.w; });
  labels.slice(0, 11).forEach(function (l) {
    out.push('<text class="lbl' + (l.wide ? " wide" : "") + '" x="' + l.x +
      '" y="' + (l.y + fs * 0.34) +
      '" font-size="' + fs.toFixed(2) +
      '" stroke-width="' + (fs * 0.22).toFixed(2) +
      '">' + esc(l.s) + "</text>");
  });
  out.push("</svg>");
  return out.join("");
}

/* Where the outlines came from, in the city's own words. `source` is a key,
 * not a sentence: the build knows which of three very different things it
 * traced, and the page says which one in the reader's language. */
function mapSource() {
  return t(city.shapes.source) +
    (city.shapes.exact ? t("map.legend.exact") : t("map.legend.inferred"));
}

function legend() {
  var mo = marketOnly();
  return '<div class="legend">' +
    (mo ? "" :
      '<span class="sw"><i class="q-up-6"></i>' + t("map.legend.good") + "</span>" +
      '<span class="sw"><i class="q-dn-6"></i>' + t("map.legend.bad") + "</span>" +
      '<span class="sw"><i class="q-none"></i>' + t("map.legend.none") + "</span>") +
    '<span class="sw wide">' + t(mo ? "map.legend.note.market" : "map.legend.note",
      { source: mapSource() }) + "</span>" +
    "</div>";
}

/* ---- aggregation ----------------------------------------------- */

function median(a) {
  if (!a.length) return null;
  var s = a.slice().sort(function (x, y) { return x - y; });
  var h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

var city = D.cities[0];
var byArea = {};
var slugToKey = { fwd: {}, rev: {} };
var streetBySlug = {};
var lotById = {};

/* Which area a lot sits in is decided at build time by its coordinates, not by
 * its address text: the auction feeds write GUAIANAZES where São Paulo writes
 * GUAIANASES, and most of that city's lots name a street-level neighbourhood
 * no boundary file has heard of. The name is a fallback for anything the
 * raster could not place. */
/* Which district page a lot belongs on, or nothing.
 *
 * The raster answers first, because it knows what is under a coordinate. Where
 * it could not place the lot, the registry's own spelling stands in — and that
 * spelling is not always a district the map has heard of. Linking to one anyway
 * published a district URL that quietly rendered the city page underneath it,
 * which is the one duplicate this site had left. */
function areaOf(r) {
  var sh = city.shapes;
  var of = sh && sh.of;
  var k = (of && of[String(r[C.id])]) || normKey(r[C.bairro]);
  return sh && sh.nice[k] ? k : null;
}
function areaName(key) {
  var sh = city.shapes;
  return (sh && sh.nice[key]) || title(key);
}
function lots(n) { return num(n) + " " + plur("unit.lot", n); }

function indexCity(c) {
  city = c;
  byArea = {};
  lotById = {};
  c.rows.forEach(function (r) {
    lotById[String(r[C.id])] = r;
    var k = areaOf(r);
    if (k) (byArea[k] = byArea[k] || []).push(r);
  });
  // Both directions: the URL carries a slug, the data is keyed by the raster
  // key, and a reader arriving from outside has only the slug.
  streetBySlug = {};
  var sts = (c.streets || {}).d || {};
  Object.keys(sts).forEach(function (code) { streetBySlug[sts[code].slug] = code; });
  slugToKey = { fwd: {}, rev: {} };
  var nice = (c.shapes || {}).nice || {};
  Object.keys(nice).forEach(function (k) {
    var sl = slugify(nice[k]);
    // Two areas that flatten to the same slug would silently share a page.
    if (slugToKey.fwd[sl] && slugToKey.fwd[sl] !== k) sl = sl + "-" + slugify(k).slice(0, 6);
    slugToKey.fwd[sl] = k;
    slugToKey.rev[k] = sl;
  });
}

function areaStat(key) {
  var rs = byArea[key] || [];
  var rel = rs.filter(reliable);
  var below = rel.filter(function (r) { return r[C.margin] > 0; }).length;
  return {
    key: key, n: rs.length, rel: rel.length, below: below,
    share: rel.length ? below / rel.length : null,
    margin: median(rel.map(function (r) { return r[C.margin]; })),
    rows: rs,
  };
}

/* Every area the map knows, not only the ones with a lot open today.
 *
 * An auction district empties out in weeks; a district does not. The page that
 * survives its own inventory is the one that carries what the district is
 * worth — and the largest competitor keeps a district page alive with zero
 * lots for exactly this reason, while the one that publishes only lots is
 * watching 36 530 URLs decay. */
function allAreas() {
  var keys = Object.keys((city.shapes || {}).d || {});
  Object.keys(byArea).forEach(function (k) {
    if (keys.indexOf(k) === -1) keys.push(k);
  });
  return keys.map(areaStat);
}

/* ---- city switching -------------------------------------------- */

/* Timezone picks the opening city without asking for anything. Coordinates are
 * personal data under the LGPD, and five in six Brazilians live outside the
 * three municipalities we cover, so a permission prompt on load would spend a
 * one-shot browser grant to tell most visitors we have nothing for them. */
function guessCity() {
  try {
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    var hit = D.cities.filter(function (c) { return c.tz === tz; });
    if (hit.length) return hit[0];
  } catch (e) { /* older browsers just get the default */ }
  return D.cities[0];
}

/* Anchors, not buttons. Another city is another page, and a page is something
 * a reader can open in a new tab and a crawler can follow — a scripted button
 * is neither. */
function citySub(c) {
  return marketOnly(c)
    ? t("city.pick.sub.market", { lots: lots(c.stats.lots), deals: num(c.stats.paid_deals) })
    : t("city.pick.sub", { lots: lots(c.stats.lots), below: num(c.stats.below) });
}

function cityList(kind) {
  return D.cities.map(function (c) {
    var on = c.slug === city.slug;
    // cityBase, not the raw slug: two spellings of one city would become
    // two pages saying the same thing.
    var url = esc(cityBase(c));
    if (kind === "strip") {
      return '<a class="cbtn' + (on ? " on" : "") + '" href="' + url +
        '" data-city="' + esc(c.slug) + '"><b>' + esc(c.nome) + "</b><span>" +
        lots(c.stats.lots) + "</span></a>";
    }
    return '<a class="mi' + (on ? " on" : "") + '" href="' + url +
      '" data-city="' + esc(c.slug) + '" role="option" aria-selected="' + on +
      '"><span class="mn">' + esc(c.nome) + '</span><span class="ms">' +
      citySub(c) + "</span></a>";
  }).join("");
}

/* The header carries the list too, because a district or a lot page has no
 * room for the strip and should still be one tap from another city. */
/* The header's copy of the list is painted by parts/chrome.js, from a small
 * blob the build writes — a static page has no dataset to build it from. This
 * only hands it the shape it expects. */
function paintPick() {
  window.__HERE__ = { city: city.slug };
  window.__CITIES__ = D.cities.map(function (c) {
    return {
      slug: c.slug, uf: c.uf, cslug: c.cslug, nome: c.nome,
      sub: strip(citySub(c)),
    };
  });
  if (window.CHROME) window.CHROME.boot();
}

function strip(html) { return String(html).replace(/<[^>]+>/g, ""); }

/* The anchor navigates by itself; this only records where the reader went, so
 * the next bare visit opens on the same city. */
function wireCity(root) {
  [].forEach.call(root.querySelectorAll("[data-city]"), function (a) {
    a.addEventListener("click", function () {
      try { localStorage.setItem("city", a.dataset.city); } catch (e) { /* private mode */ }
    });
  });
}

/* ---- screens --------------------------------------------------- */

/* The country page, and the only one that is not about a city.
 *
 * It exists because "/" is where a link from anywhere else lands, and because
 * the argument this site makes is national even though the data is not yet:
 * the discount every platform prints is measured against a bank appraisal, and
 * a bank appraisal is a number nobody paid. Everything below is recomputed
 * across all cities rather than borrowed from whichever one the reader was
 * last in — a country page showing Rio's median would be a lie told by a
 * cache. */
function screenHome() {
  var n = national();
  // The country page opens on the product, not on prose: every city we cover,
  // full width and first — a visitor must see in one glance what exists — and
  // the default city's own map beside them. The default is the biggest city;
  // its page is one tap away and the header menu switches to any other.
  var main = D.cities[0];
  if (city.slug !== main.slug) { indexCity(main); paintPick(); }
  var areas = allAreas().filter(function (a) { return city.shapes && city.shapes.d[a.key]; });
  var cells = areas.map(function (a) {
    return {
      key: a.key, share: a.share, rel: a.rel, go: href("/a/" + encodeURIComponent(a.key)),
      aria: t("city.area.aria", { name: areaName(a.key), lots: lots(a.n), below: a.below }),
    };
  });
  return '' +
    '<section class="hero home">' +
      '<p class="kicker"><i></i>' + t("brand.kicker") +
        b(t("brand.kicker.free")) + "</p>" +
      "<h1>" + t("home.h1", { br: '<span class="mark">' + t("home.br") + "</span>" }) + "</h1>" +
      '<p class="lede">' + t("home.lede") + "</p>" +
    "</section>" +

    // Only cities with a measured verdict get a slot here: the page's promise
    // is the real discount, and a row answering "no estimate" to that promise
    // sells weakness. The market-only cities keep their pages and their place
    // in the header menu; on the front they are one quiet line, which is what
    // "we hold their deals but not their verdicts yet" actually merits.
    '<section class="sec"><div class="sechead"><h2>' + t("home.cities.h2") +
      '</h2><span class="n">' + t("home.cities.note") + "</span></div>" +
      '<div class="rowlist">' +
        D.cities.filter(function (c) { return !marketOnly(c); }).map(cityRow).join("") +
      "</div>" +
      (D.cities.some(marketOnly)
        ? '<p class="foot" style="margin-top:10px">' + t("home.more", {
            links: D.cities.filter(marketOnly).map(function (c) {
              return '<a href="' + esc(cityBase(c)) + '">' + esc(c.nome) + "</a>";
            }).join(" · "),
          }) + "</p>"
        : "") +
    "</section>" +

    (cells.length ? '<div class="side"><div class="mapcard">' +
      '<div class="maphead"><span class="t">' + esc(main.nome) + " · " +
        t("city.map.tap", {
          n: cells.length, unit: plur("unit." + city.shapes.unit, cells.length),
        }) + "</span></div>" +
      drawMap(cells, {
        aria: t("map.aria.city", { city: main.nome }),
        box: frame(cells.map(function (c) { return c.key; })),
        pad: 0.07,
      }) +
      legend() +
      '<a class="cta" href="' + esc(cityBase(main)) + '">' +
        t("home.city.open", { city: esc(main.nome) }) + "</a>" +
    "</div>" +

    catchCard(n) +

    '<div class="tiles">' +
      tile(n.lots, plur("unit.lot", n.lots)) +
      tile(n.deals, plur("city.tile.deals", n.deals)) +
      tile(n.below, t("city.tile.below")) +
    "</div>" +
    "</div>" : "") +

    '<section class="sec"><div class="sechead"><h2>' + t("home.why.h2") + "</h2></div>" +
      '<p class="lede">' + t("home.why.p", { deals: b(num(n.deals)) }) + "</p>" +
      '<p class="foot" style="margin-top:10px">' + t("home.method", {
        links: D.cities.map(function (c) {
          return '<a href="' + esc(cityBase(c) + SEG.honest + "/") + '">' +
            esc(c.nome) + "</a>";
        }).join(" · "),
      }) + "</p>" +
    "</section>" +

    '<p class="foot">' + footNote() + "</p>" + langbar();
}

/* Not a dead end: a lot page that has gone is exactly where a reader arrives
 * from an old link, and the cities are the one thing that never moves. Written
 * as a route like any other so it is drawn by the same code and translated by
 * the same catalogue; the build files it at /404.html, where every static host
 * looks for it. */
function screenNotFound() {
  return '' +
    '<section class="hero">' +
      "<h1>" + t("nf.h1") + "</h1>" +
      '<p class="lede">' + t("nf.p") + "</p>" +
    "</section>" +
    '<section class="sec"><div class="sechead"><h2>' + t("home.cities.h2") + "</h2></div>" +
      '<div class="rowlist">' + D.cities.map(cityRow).join("") + "</div>" +
    "</section>" +
    '<p class="foot">' + footNote() + "</p>" + langbar();
}

/* What was actually paid in this district, from the town hall's own register.
 *
 * This is the block that makes a district page worth having when it holds no
 * lots at all — and 44 of them do. Without it those pages are a name, a map and
 * a search term, which is the definition of a doorway; with it they carry a
 * number about the district itself that nobody else publishes at this
 * granularity. The portals know what sellers ask. The auction houses know what
 * a bank appraised. Only the ITBI knows what someone paid.
 *
 * The comparison is to the same city in the same year, never to another year:
 * the register is nominal back to 2011, so a series would measure inflation as
 * much as property. */
function marketCard(key) {
  var mk = city.market;
  if (!mk || !mk.d) return "";
  var d = mk.d[key];
  if (!d) return "";
  var lines = [];
  if (d.f) lines.push(mktLine("flat", d.f, mk.city.flat));
  if (d.h) lines.push(mktLine("house", d.h, mk.city.house));
  if (d.r) lines.push(mktLine("res", d.r, mk.city.res));
  if (!lines.length) return "";
  return '<section class="mkt"><div class="sechead"><h2>' +
      t("mkt.h2") +
      '</h2><span class="n">' + t("mkt.year", { year: mk.year }) + "</span></div>" +
    lines.join("") +
    '<p class="foot">' + t("mkt.note") +
      (mk.basis === "base_value" ? " " + t("mkt.note.base") : "") + "</p></section>";
}

function mktLine(kind, own, base) {
  var value = own[0], n = own[1];
  var rel = base ? Math.round(100 * (value / base - 1)) : null;
  return '<div class="mrow">' +
    // Three short lines rather than one crowded one. At 390px the label, the
    // price, the unit and the comparison were four things competing for one
    // row, and the comparison — the only one that needs no arithmetic from the
    // reader — was the one that got clipped.
    '<div class="mtop"><span class="lab">' + t("mkt.kind." + kind) + "</span>" +
      '<span class="grow"></span>' +
      // A neutral pill on purpose. Everywhere else on this site a green pill
      // means "cheaper than the hammer", a verdict about one lot; this is the
      // price level of a whole district, and Leblon being dear is not bad
      // news, it is Leblon.
      (rel === null ? "" : '<span class="pill mute">' +
        t("mkt.vs", { pct: (rel > 0 ? "+" : rel < 0 ? "\u2212" : "") + Math.abs(rel) + "%" }) +
        "</span>") +
    "</div>" +
    '<div class="mval"><b>' + money(value) + '</b><span class="u">' +
      t("mkt.per") + "</span></div>" +
    '<div class="msub">' + t("mkt.deals", { n: num(n) }) + "</div></div>";
}

/* One street, one number. The page exists because the register is street-level
 * and nobody else publishes at that grain: "quanto custa na rua X" has an
 * answer and no competition for it. Same bar as districts — twelve deeds in
 * the last full year or no number — and the comparison is the street's own
 * district in the same year, because the register is nominal and any series
 * would measure inflation. */
function screenStreet(code) {
  var st = city.streets.d[code];
  var year = city.streets.year;
  var dk = st.bairro;
  var mk = city.market && city.market.d ? city.market.d[dk] : null;
  var lines = [];
  if (st.f) lines.push(streetLine("flat", st.f, mk && mk.f ? mk.f[0] : null));
  if (st.h) lines.push(streetLine("house", st.h, mk && mk.h ? mk.h[0] : null));
  return '' +
    '<div class="hero">' + back(href("/a/" + encodeURIComponent(dk)), areaName(dk)) +
      "<h1>" + esc(title(st.name)) + "</h1>" +
      '<p class="lede">' + t("street.lede", {
        district: link("/a/" + encodeURIComponent(dk), esc(areaName(dk))),
        year: year,
      }) + "</p></div>" +
    '<section class="mkt"><div class="sechead"><h2>' + t("mkt.h2") +
      '</h2><span class="n">' + t("mkt.year", { year: year }) + "</span></div>" +
      lines.join("") +
      '<p class="foot">' + t("street.note") + "</p></section>" +
    (st.bairros.length > 1 ? '<p class="foot">' + t("street.spans", {
      list: st.bairros.map(function (k) {
        return link("/a/" + encodeURIComponent(k), esc(areaName(k)));
      }).join(" · "),
    }) + "</p>" : "") +
    footer();
}

function streetLine(kind, own, base) {
  var rel = base ? Math.round(100 * (own[0] / base - 1)) : null;
  return '<div class="mrow">' +
    '<div class="mtop"><span class="lab">' + t("mkt.kind." + kind) + "</span>" +
      '<span class="grow"></span>' +
      (rel === null ? "" : '<span class="pill mute">' +
        t("street.vs", { pct: (rel > 0 ? "+" : rel < 0 ? "\u2212" : "") + Math.abs(rel) + "%" }) +
        "</span>") + "</div>" +
    '<div class="mval"><b>' + money(own[0]) + '</b><span class="u">' +
      t("mkt.per") + "</span></div>" +
    '<div class="msub">' + t("mkt.deals", { n: num(own[1]) }) + "</div></div>";
}

/* The district's streets, ranked by how much actually changed hands. Every
 * street page is discovered through this list — the walk follows links, so a
 * street that is on no list is a page that does not exist. */
function streetList(key) {
  var sts = city.streets;
  if (!sts || !sts.by || !sts.by[key]) return "";
  var rows = sts.by[key].map(function (code) {
    var st = sts.d[code];
    var main = st.f || st.h;
    return '<a class="row" href="' + href("/r/" + encodeURIComponent(code)) + '">' +
      '<div class="r1"><span class="nm">' + esc(title(st.name)) + "</span>" +
        '<span class="pill mute">' + money(main[0]) + "/" + t("unit.m2") + "</span></div>" +
      '<div class="sub">' + t("mkt.deals", { n: num((st.f ? st.f[1] : 0) + (st.h ? st.h[1] : 0)) }) +
      "</div></a>";
  });
  return '<section class="sec"><div class="sechead"><h2>' + t("street.list.h2") +
    '</h2><span class="n">' + t("mkt.year", { year: sts.year }) + "</span></div>" +
    '<div class="rowlist">' + rows.join("") + "</div></section>";
}

/* The second price tag: what a flat here costs to keep, per month. A R$300k
 * lot with a R$1,800 condominium is a different deal from the same lot at
 * R$400, and no auction platform prints this next to its discounts. Listings
 * are a fair source for this one number — the fee is a fact about the
 * building, not a seller's position — and the copy says so out loud. */
function upkeepCard(key) {
  var up = city.upkeep;
  if (!up || !up.d) return "";
  var own = up.d[key];
  if (!own) return "";
  var rel = up.city ? Math.round(100 * (own[0] / up.city - 1)) : null;
  return '<section class="mkt"><div class="sechead"><h2>' + t("cost.h2") +
      '</h2><span class="n">' + t("cost.note.head") + "</span></div>" +
    '<div class="mrow">' +
      '<div class="mtop"><span class="lab">' + t("cost.condo") + "</span>" +
        '<span class="grow"></span>' +
        (rel === null ? "" : '<span class="pill mute">' +
          t("mkt.vs", { pct: (rel > 0 ? "+" : rel < 0 ? "\u2212" : "") + Math.abs(rel) + "%" }) +
          "</span>") + "</div>" +
      '<div class="mval"><b>' + money(own[0]) + '</b><span class="u">' +
        t("cost.per") + "</span></div>" +
      '<div class="msub">' + t("cost.ads", { n: num(own[1]) }) + "</div></div>" +
    '<p class="foot">' + t("cost.note") + "</p></section>";
}

/* Same shape as a district row, because it answers the same question one level
 * up: how much of this place is actually below the hammer. */
function cityRow(c) {
  var s = c.stats;
  var share = s.reliable ? s.below / s.reliable : null;
  var has = share != null;
  return '<a class="row" href="' + esc(cityBase(c)) + '" data-city="' + esc(c.slug) + '">' +
    '<div class="r1"><span class="nm">' + esc(c.nome) + "</span>" +
    (has ? '<span class="pill ' + (share >= 0.3 ? "good" : "bad") + '">' +
             t("area.row.pill", { below: s.below, rel: s.reliable }) + "</span>"
         : '<span class="pill mute">' +
             t(marketOnly(c) ? "city.row.market" : "area.row.nodata") + "</span>") + "</div>" +
    '<div class="sub">' + citySub(c) + "</div>" +
    (has ? '<div class="bar"><i class="' + (share >= 0.3 ? "up" : "dn") +
      '" style="width:' + Math.round(100 * share) + '%"></i></div>' : "") + "</a>";
}

/* Every number on the country page, from every row we have. Cheap enough to do
 * on the fly — the whole dataset is already in memory, and doing it here means
 * a fourth city changes the front page by existing, not by being added to a
 * constant. */
function national() {
  var rel = [], n = { lots: 0, deals: 0, listings: 0 };
  D.cities.forEach(function (c) {
    n.lots += c.stats.lots || 0;
    n.deals += c.stats.paid_deals || 0;
    n.listings += c.stats.listings || 0;
    c.rows.forEach(function (r) { if (reliable(r)) rel.push(r); });
  });
  var loud = rel.filter(function (r) { return (r[C.promised] || 0) >= 45; });
  var promised = rel.map(function (r) { return r[C.promised]; })
    .filter(function (x) { return x != null; });
  n.reliable = rel.length;
  n.below = rel.filter(function (r) { return r[C.margin] > 0; }).length;
  n.promised_med = promised.length ? med(promised) : null;
  n.real_med = rel.length ? -med(rel.map(function (r) { return r[C.margin]; })) : null;
  n.promised_hi_n = loud.length;
  n.above_hammer = loud.filter(function (r) { return r[C.margin] < 0; }).length;
  n.loud_below = loud.filter(function (r) { return r[C.margin] > 0; }).length;
  return n;
}

function med(xs) {
  var a = xs.slice().sort(function (x, y) { return x - y; });
  var i = a.length >> 1;
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
}

function screenCity() {
  var s = city.stats;
  var areas = allAreas().filter(function (a) { return city.shapes && city.shapes.d[a.key]; });
  var cells = areas.map(function (a) {
    return {
      key: a.key, share: a.share, rel: a.rel, go: href("/a/" + encodeURIComponent(a.key)),
      aria: t("city.area.aria", { name: areaName(a.key), lots: lots(a.n), below: a.below }),
    };
  });
  // "Where to look" is the map's own ranking in words: only areas with enough
  // reliable lots to mean anything, best first.
  var best = areas.filter(function (a) { return a.rel >= 5; })
    .sort(function (x, y) { return y.share - x.share || y.below - x.below; })
    .slice(0, 8);
  var top = city.rows.filter(reliable).slice(0, 3);

  return '' +
    '<section class="hero">' +
      '<p class="kicker"><i></i>' + t("brand.kicker") +
        b(t("brand.kicker.free")) + "</p>" +
      // "em São Paulo" but "no Rio de Janeiro": whether a city name takes an
      // article is a fact about the name, and Portuguese is not the last
      // language that will need one. The catalogue answers per city, so the
      // template never has to.
      "<h1>" + t("city.h1", {
        prep: cityPrep(),
        city: '<span class="mark">' + esc(city.nome) + "</span>",
      }) +
        "</h1>" +
      '<p class="lede">' + t(marketOnly() ? "city.lede.market" : "city.lede") + "</p>" +
      '<div class="strip">' + cityList("strip") + "</div>" +
    "</section>" +

    catchCard(s) +

    '<div class="tiles">' +
      tile(s.lots, plur(marketOnly() ? "unit.lot" : "city.tile.lots", s.lots)) +
      (s.paid_deals
        ? tile(s.paid_deals, plur("city.tile.deals", s.paid_deals))
        : tile(s.listings, plur("city.tile.listings", s.listings))) +
      (marketOnly()
        ? tile(mktDistricts(), plur("city.tile.districts", mktDistricts()))
        : tile(s.below, t("city.tile.below"))) +
    "</div>" + lent() +

    (cells.length ? '<div class="side">' +
      '<div class="mapcard">' +
        '<div class="maphead"><span class="t">' +
          t("city.map.tap", {
            n: cells.length, unit: plur("unit." + city.shapes.unit, cells.length),
          }) + "</span>" +
          '<span class="grow"></span>' +
          '<button class="zoomout" id="near">' + t("city.map.near") + "</button></div>" +
        drawMap(cells, {
          aria: t("map.aria.city", { city: city.nome }),
          box: frame(cells.map(function (c) { return c.key; })),
          pad: 0.07,
        }) +
        legend() +
        '<p class="foot" id="nearmsg" style="margin:8px 0 0"></p>' +
      "</div>" +
      (best.length ? '<section class="sec"><div class="sechead"><h2>' +
        t("city.best.h2") + '</h2><span class="n">' + t("city.best.note") + "</span></div>" +
        '<div class="rowlist">' + best.map(areaRow).join("") + "</div></section>" : "") +
    "</div>" : "") +

    (top.length ? '<section class="sec"><div class="sechead"><h2>' + t("city.top.h2") +
      '</h2><span class="n">' + t("city.top.note", { n: num(s.reliable) }) + "</span></div>" +
      '<div class="rowlist">' + top.map(lotRow).join("") + "</div>" +
      // Said next to the numbers, not on a page nobody opens: the top of any
      // ranking is where a model's own error collects.
      '<p class="foot" style="margin-top:10px">' +
        t("city.top.caveat", { honest: link("/honest", t("nav.honest")) }) + "</p>" +
      '<a class="cta" href="' + href("/all") + '">' + t("city.cta") + "</a>" +
    "</section>" : "") +

    footer();
}

function link(path, text) {
  return '<a href="' + href(path) + '">' + text + "</a>";
}

/* Only São Paulo measured every link of the chain itself. A city that borrowed
 * one says so under its own numbers, next to them — not on a page nobody
 * opens. */
function lent() {
  var parts = chainParts("chain.premium", "chain.auction");
  if (!parts) return "";
  return '<p class="foot" style="margin:10px 0 0">' +
    t(city.stats.paid_deals ? "chain.some" : "chain.none") + parts +
    t("chain.tail", { honest: link("/honest", t("nav.honest")) }) + "</p>";
}

function chainParts(premiumKey, auctionKey) {
  var bw = city.borrowed || {};
  var parts = [];
  if (bw.premium) parts.push(t(premiumKey, { city: esc(bw.premium) }));
  if (bw.auction) parts.push(t(auctionKey, { city: esc(bw.auction) }));
  return parts.length ? parts.join(t("chain.join")) : "";
}

function mktDistricts() {
  return Object.keys((city.market || {}).d || {}).length;
}

function tile(n, sub) {
  return '<div class="tile"><b>' + num(n) + "</b><span>" + esc(sub) + "</span></div>";
}

function catchCard(s) {
  if (s.promised_med == null) return "";
  var up = s.real_med > 0;
  return '<div class="catch">' +
    '<div><span class="lab">' + t("catch.promised") + "</span>" +
      '<span class="big was">' + pct(-Math.abs(s.promised_med), false) + "</span></div>" +
    '<div class="arr">→</div>' +
    '<div><span class="lab">' + t(up ? "catch.real.up" : "catch.real.dn") + "</span>" +
      '<span class="big now ' + (up ? "up" : "dn") + '">' + pct(Math.abs(s.real_med), false) +
      "</span></div>" +
    '<p class="foot">' + t("catch.foot", {
      loud: b(num(s.promised_hi_n)),
      above: b(num(s.above_hammer)),
      below: b(num(s.loud_below)),
    }) + "</p></div>";
}

function areaRow(a) {
  var has = a.share != null;
  return '<a class="row" href="' + href("/a/" + encodeURIComponent(a.key)) + '">' +
    '<div class="r1"><span class="nm">' + esc(areaName(a.key)) + "</span>" +
    (has ? '<span class="pill ' + (a.share >= 0.3 ? "good" : "bad") + '">' +
             t("area.row.pill", { below: a.below, rel: a.rel }) + "</span>"
         : '<span class="pill mute">' + t("area.row.nodata") + "</span>") + "</div>" +
    '<div class="sub">' + (has
      ? t("area.row.sub", {
          lots: lots(a.n), pct: Math.round(100 * a.share), median: pct(a.margin),
        })
      : lots(a.n)) + "</div>" +
    (has ? '<div class="bar"><i class="' + (a.share >= 0.3 ? "up" : "dn") +
      '" style="width:' + Math.round(100 * a.share) + '%"></i></div>' : "") + "</a>";
}

function screenArea(key) {
  var a = areaStat(key);
  // A district with nothing on offer today still gets its own page, and it is
  // the case this block exists for. Returning the city page here — which is
  // what this did — published sixty verbatim copies of it under sixty
  // district URLs, each declaring itself canonical. Duplicate content is a
  // worse answer than a thin page, and with the register behind it the page
  // is not thin: it says what this district costs and that no lot is up.
  var sh = city.shapes;
  var at = sh && sh.at[key];

  // The district framed with a ring of its neighbours, so the reader can see
  // where they have landed and step sideways.
  var mini = "";
  if (at) {
    var w = at[4] - at[2], h = at[5] - at[3], m = Math.max(w, h) * 0.32;
    var box = [at[2] - m, at[3] - m, at[4] + m, at[5] + m];
    // The map is a banner across the content column, not a sidebar square:
    // widen the frame to ~2.6:1 so the district sits centred with a full ring
    // of neighbours filling the width. The svg crops with `slice`, so a phone
    // simply sees the centre of this same frame.
    var bw = box[2] - box[0], bh = box[3] - box[1], want = bh * 2.6;
    if (bw < want) { box[0] -= (want - bw) / 2; box[2] += (want - bw) / 2; }
    var near = allAreas().filter(function (o) {
      var bx = sh.at[o.key];
      return bx && bx[2] < box[2] && bx[4] > box[0] && bx[3] < box[3] && bx[5] > box[1];
    }).map(function (o) {
      var bx = sh.at[o.key];
      return {
        key: o.key, share: o.share, rel: o.rel, go: href("/a/" + encodeURIComponent(o.key)),
        aria: t("area.aria", { name: areaName(o.key), lots: lots(o.n) }),
        far: Math.pow(bx[0] - at[0], 2) + Math.pow(bx[1] - at[1], 2),
      };
    }).sort(function (x, y) { return x.far - y.far; })
      // A district the size of Santa Cruz has a padded frame covering the whole
      // city; the nearest couple of dozen is a neighbourhood, the rest is a
      // reprint of the front page.
      .slice(0, 26);
    mini = '<div class="mapcard maparea"><div class="maphead"><span class="t">' +
      t("area.map.tap", { name: esc(areaName(key)) }) + "</span></div>" +
      drawMap(near, {
        aria: t("map.aria.area", { name: areaName(key) }), box: box, active: key,
        cover: true,
      }) + "</div>";
  }

  return '' +
    '<div class="hero">' + back(href(), city.nome) +
      "<h1>" + esc(areaName(key)) + "</h1>" +
      '<p class="lede">' + (!a.n
        ? t("area.lede.nolots", { all: link("/all", t("area.nolots.cta")) })
        : a.rel
          ? t("area.lede", { lots: lots(a.n), rel: a.rel, below: b(a.below) })
          : t(marketOnly() ? "area.lede.market" : "area.lede.nodata",
              { lots: lots(a.n) })) + "</p></div>" + mini +
    marketCard(key) + upkeepCard(key) + streetList(key) +
    (a.n ? '<section class="sec"><div class="rowlist">' +
      a.rows.slice().sort(function (x, y) {
        var rx = reliable(x), ry = reliable(y);
        if (rx !== ry) return rx ? -1 : 1;
        return rx ? y[C.margin] - x[C.margin] : 0;
      // No cap. This is the only page that lists a district in full, and a lot
      // that is on no page is a lot that does not exist.
      }).map(lotRow).join("") + "</div></section>" : "") +
    footer();
}

/* What winning actually costs. The advertised price is never the cheque: the
 * auctioneer's commission, the transfer tax and the notary follow it, and no
 * platform prints them next to its discounts.
 *
 * Every number here is a rate the reader can check, not a valuation of ours —
 * which is why this block appears even on lots where we withhold the estimate.
 * Rates are per city (municipal ITBI) and per sale form: on a leilão the 5%
 * commission is the buyer's by law and custom; on Caixa's direct-sale forms
 * there is no auctioneer to pay. Notary and registry follow state fee tables
 * that step with value; ~1.2% is the honest middle for these price ranges, and
 * the tilde is printed, not hidden. */
var ITBI_RATE = {
  "rio-de-janeiro-rj": 0.03,
  "sao-goncalo-rj": 0.02,
  "sao-paulo-sp": 0.03,
  "fortaleza-ce": 0.03,
  "recife-pe": 0.03,
};
var NOTARY_RATE = 0.012;

function saleForm(r) {
  var mod = String(r[C.mod] || "").toLowerCase();
  if (r[C.jud]) return "judicial";
  if (mod.indexOf("leil\u00e3o") >= 0 || mod.indexOf("leilao") >= 0) return "auction";
  return "direct";
}

function entryCard(r) {
  var base = r[C.preco];
  var rate = ITBI_RATE[city.slug];
  if (!base || !rate) return "";
  var form = saleForm(r);
  var fee = form === "direct" ? 0 : 0.05;
  var rows = [
    ["entry.bid", base, null],
    ["entry.fee", base * fee, fee ? "5%" : null],
    ["entry.itbi", base * rate, Math.round(rate * 100) + "%"],
    ["entry.notary", base * NOTARY_RATE, "~1,2%"],
  ];
  var total = base * (1 + fee + rate + NOTARY_RATE);
  return '<section class="mkt"><div class="sechead"><h2>' + t("entry.h2") +
      '</h2><span class="n">' + t("entry.head") + "</span></div>" +
    '<div class="mrow">' +
      rows.map(function (x) {
        if (!x[1]) return "";
        return '<div class="erow"><span class="el">' + t(x[0]) +
          (x[2] ? ' <em class="ep">' + x[2] + "</em>" : "") + "</span>" +
          '<span class="ev">' + money(Math.round(x[1])) + "</span></div>";
      }).join("") +
      '<div class="erow tot"><span class="el">' + t("entry.total") + "</span>" +
        '<span class="ev">' + money(Math.round(total)) +
        ' <em class="ep">+' + Math.round(100 * (total / base - 1)) + "%</em></span></div>" +
    "</div>" +
    '<p class="foot">' + t(fee ? "entry.note" : "entry.note.direct") +
      (form === "auction" ? " " + t("entry.note.extrajud") : "") + "</p></section>";
}

/* The lot's own headline, assembled from what the registry actually knows:
 * type, size and bedrooms are each absent often enough that a fixed sentence
 * would print empty slots. */
function lotLine(r) {
  var bits = [esc(title(r[C.tipo] || t("lot.fallback")))];
  if (r[C.area]) bits.push(r[C.area] + " " + t("unit.m2"));
  if (r[C.quartos]) bits.push(r[C.quartos] + " " + plur("unit.beds", r[C.quartos]));
  return bits.join(" · ");
}

function lotRow(r) {
  var vd = verdict(r);
  var ph = photo(r);
  return '<a class="row lot" href="' + href("/l/" + encodeURIComponent(r[C.id])) + '">' +
    '<div class="ph"' + (ph ? ' style="background-image:url(' + esc(ph) + ')"' : "") + ">" +
      (ph ? "" : "<span>" + t("lot.nophoto") + "</span>") + "</div>" +
    '<div class="body">' +
      '<div class="r1"><div class="ttl">' + lotLine(r) + "</div>" +
        '<span class="pill ' + (vd ? vd[1] : "mute") + '">' +
          (vd ? pct(r[C.margin]) : "?") + "</span></div>" +
      '<div class="meta">' + esc(title(r[C.end] || r[C.bairro] || "")) + "</div>" +
      // One line, not two columns: on a phone the two labelled prices sat in
      // 70px each and broke "R$ 33 635" across lines.
      '<div class="nums"><div class="k">' +
        t(vd ? "lot.nums.both" : "lot.nums.open") + "</div>" +
        '<div class="v">' + money(r[C.preco]) +
        (vd ? " <em>→</em> " + b(money(r[C.hammer])) : "") +
        "</div></div>" +
    "</div></a>";
}

/* "apartamento-64m2-penha-circular-0e2af7f775f1e45c" -> the id at the end.
   Falls through unchanged for a bare id, so both forms resolve. */
function idFromSlug(sl) {
  if (lotById[sl]) return sl;
  var tail = String(sl).split("-").pop();
  return lotById[tail] ? tail : sl;
}

/* Why a lot carries no verdict, said out loud.
 *
 * "Não damos estimativa" on its own reads as a broken feature. Every silence
 * here has a specific cause the pipeline already knows, so the page names it —
 * and where the reason is a missing measurement rather than a missing market,
 * it hands the reader the district yardstick the estimate would have used.
 *
 * The key maps are written out in full because the build's key scanner and the
 * prerender slice read literal dotted strings: "why." + code would ship a page
 * whose text exists in no language file. */
var WHY_KEY = {
  no_area: "why.no_area",
  no_type: "why.no_type",
  city_only: "why.city_only",
  no_coords: "why.no_coords",
  no_comps: "why.no_comps",
};
var CONF_KEY = {
  restricted: "why.conf.restricted",
  rights: "why.conf.rights",
  price_gap: "why.conf.price_gap",
  appraisal_gap: "why.conf.appraisal_gap",
  no_appraisal: "why.conf.no_appraisal",
};
//: Past this the comps are no longer a neighbourhood (geo_comps.CONTEXT_RING_M).
var CONTEXT_RING_M = 5000;

/* What a property in this district usually is, so "no estimate" still leaves
 * the reader with a yardstick. Asking prices, and the sentence says so. */
function askingHint(r) {
  var by = city.asking_by_district || {};
  var d = by[areaOf(r) || ""] || by[normKey(r[C.bairro])];
  if (d) {
    return '<p class="hint">' + t("why.hint", {
      bairro: esc(title(r[C.bairro] || (areaOf(r) ? areaName(areaOf(r)) : city.nome))),
      area: d[0], m2: money(d[1]), n: num(d[2]),
    }) + "</p>";
  }
  var all = Object.keys(by).map(function (k) { return by[k][1]; });
  if (!all.length) return "";
  all.sort(function (a, b) { return a - b; });
  return '<p class="hint">' + t("why.hint.city", {
    city: esc(city.nome), m2: money(all[Math.floor(all.length / 2)]),
  }) + "</p>";
}

function whyBlock(r) {
  if (reliable(r)) return "";
  var ring = r[C.ring] || 0;
  var out = "";

  // One cause, named. A withheld verdict has either a missing input (why) or a
  // failed cross-check (conf); "ok but the comps are 1-5 km out" is its own case.
  var body = WHY_KEY[r[C.why]] ? t(WHY_KEY[r[C.why]], { tipo: esc(title(r[C.tipo] || t("lot.fallback"))) })
    : CONF_KEY[r[C.conf]] ? t(CONF_KEY[r[C.conf]])
    : (!r[C.why] && ring > 1000 && ring <= CONTEXT_RING_M)
      ? t("why.ring", { ring: num(ring) })
      : "";
  if (body) {
    var hint = (r[C.why] === "no_area" || r[C.why] === "no_comps") ? askingHint(r) : "";
    out += '<div class="why"><div class="wh">' + t("why.h") + "</div><p>" + body + "</p>" +
      hint + "</div>";
  }

  // A number found only by opening the radius to the far side of the city is
  // worth showing and worth flagging in the same breath — and it stacks on top
  // of any cause above, because both are true of the same lot.
  if (ring > CONTEXT_RING_M) {
    var km = Math.round(ring / 1000);
    out += '<div class="why wide"><div class="wh">' + t("why.wide.h", { km: km }) + "</div>" +
      "<p>" + t("why.wide", { km: km, n: num(r[C.n]) }) + "</p>" +
      (body ? "" : askingHint(r)) + "</div>";
  }
  return out;
}

function screenLot(id) {
  var r = null;
  for (var i = 0; i < city.rows.length; i++) {
    if (String(city.rows[i][C.id]) === String(id)) { r = city.rows[i]; break; }
  }
  if (!r) return screenCity();
  var vd = verdict(r);
  var ph = photo(r);
  var key = areaOf(r);

  // Two of these four are ours and two are published facts. Where the verdict
  // is withheld for want of comparable sales, ours come off the scale too —
  // printing "no estimate" above a green line labelled "real price" says the
  // opposite of what the page means, and the number would be the same kind of
  // invention the site exists to call out.
  var own = reliable(r);
  var pts = [
    { k: "lot.price.open", val: r[C.preco], cls: "c-open" },
    { k: "lot.price.hammer", val: own && r[C.hammer], cls: "c-hammer" },
    { k: "lot.price.market", val: own && r[C.mkt], cls: "c-market" },
    { k: "lot.price.aval", val: r[C.aval], cls: "c-aval" },
  ].filter(function (p) { return p.val; });
  var hi = Math.max.apply(null, pts.map(function (p) { return p.val; })) * 1.06;

  return '' +
    // A lot with no district of its own steps back to the city instead.
    '<div class="hero">' + (key
      ? back(href("/a/" + encodeURIComponent(key)), areaName(key))
      : back(href(), city.nome)) +
      "<h1>" + esc(title(r[C.end] || r[C.tipo] || t("lot.fallback"))) + "</h1>" +
      '<p class="lede">' + lotLine(r) + " · " +
        esc(title(r[C.bairro] || (key ? areaName(key) : city.nome))) + "</p></div>" +

    (ph ? '<img class="shot" src="' + esc(ph) + '" alt="" ' +
      "onerror=\"this.style.display='none'\">" : "") +

    '<div class="verdict">' +
      (vd
        ? '<div class="delta ' + (r[C.margin] > 0 ? "up" : "dn") + '">' +
            pct(r[C.margin]) + "</div>" +
          '<p class="word ' + vd[1] + '">' + t(vd[2]) + "</p>" +
          '<p class="say">' + t("lot.say", {
            n: r[C.n], deals: plur("unit.deal", r[C.n]), ring: num(r[C.ring]),
          }) + "</p>"
        : '<p class="word mute">' + t("lot.verdict.none") + "</p>" +
          whyBlock(r)) +

      // Four prices on one scale, but the names live underneath: on a phone the
      // four labels sit within a few pixels of each other whenever two prices
      // are close, and overlapping text is worse than no picture.
      '<div class="scale"><div class="track">' +
        pts.map(function (p) {
          return '<div class="tick" style="left:' + ((p.val / hi) * 100).toFixed(1) + '%">' +
            '<span class="dot" style="background:' + p.col + '"></span></div>';
        }).join("") +
      "</div>" +
      '<div class="keys">' + pts.map(function (p) {
        return '<div class="key"><i class="' + p.cls + '"></i>' +
          '<span class="kk">' + t(p.k) + "</span>" +
          '<b class="' + p.cls + '">' + money(p.val) + "</b></div>";
      }).join("") + "</div></div>" +

      '<div class="facts">' +
        fact(t("lot.fact.auction"), t(r[C.jud] ? "lot.fact.auction.court" : "lot.fact.auction.bank")) +
        fact(t("lot.fact.deals"),
             r[C.n] ? r[C.n] + " / " + num(r[C.ring]) + " " + t("unit.m") : "—") +
        fact(t("lot.fact.aval"),
             r[C.avalpct] != null ? t("lot.fact.aval.val", { pct: pct(r[C.avalpct]) }) : "—") +
        fact(t("lot.fact.conf"), t(reliable(r) ? "lot.fact.conf.hi" : "lot.fact.conf.lo")) +
      "</div>" +

      // Same rule: the platform's promise is theirs to answer for and we quote
      // it either way, but our counter-number only appears when we have one.
      (r[C.promised] != null
        ? '<p class="note">' + t(own ? "lot.note.promised" : "lot.note.promised.noest", {
            promised: b(pct(-Math.abs(r[C.promised]), false)),
            margin: b(pct(r[C.margin])),
          }) + "</p>"
        : "") +

      (r[C.jud] ? '<p class="note">' + t("lot.note.court") + "</p>" : "") +

      entryCard(r) +

      // Caixa publishes an edital PDF for every sale; the worker only trusts
      // Caixa's own domains, so the reader pastes that link and gets the
      // dossiê free. Other sources' documents live behind auctioneers' sites
      // the allowlist does not know — no box rather than a box that fails.
      (r[C.src] === "caixa"
        ? '<section class="mkt azbox" data-az="' + esc(r[C.id]) + '"></section>' : "") +

      (r[C.link] ? '<a class="cta" href="' + esc(r[C.link]) +
        '" target="_blank" rel="noopener" data-out="' + esc(r[C.src] || "lot") + '">' +
        t("lot.cta") + "</a>" : "") +
    "</div>" + footer();
}

function fact(k, val) {
  return '<div class="fact"><span class="k">' + esc(k) + '</span><span class="v">' +
    esc(val) + "</span></div>";
}

function screenAll() {
  var mo = marketOnly();
  return '<div class="hero">' + back(href(), city.nome) +
    "<h1>" + t(mo ? "all.h1.market" : "all.h1") + "</h1>" +
    '<p class="lede">' + t(mo ? "all.lede.market" : "all.lede") + "</p></div>" +
    '<section class="sec"><div class="rowlist">' +
    city.rows.slice(0, 80).map(lotRow).join("") + "</div></section>" + footer();
}

function screenHonest() {
  var s = city.stats;
  var mo = marketOnly();
  var lentParts = chainParts("honest.chain.premium", "honest.chain.auction");
  return '<div class="hero">' + back(href(), city.nome) +
    "<h1>" + t("honest.h1") + "</h1></div>" +
    '<div class="verdict">' +
    (mo
      ? '<p class="say">' + t("honest.basis.market", {
          deals: b(num(s.paid_deals)), year: city.market ? city.market.year : "",
        }) + "</p>" +
        ((city.market || {}).basis === "base_value"
          ? '<p class="say">' + t("honest.base") + "</p>" : "")
      : '<p class="say">' + t("honest.basis", {
          deals: b(num(s.paid_deals)), listings: b(num(s.listings)),
        }) + "</p>" +
        ((city.market || {}).basis === "base_value"
          ? '<p class="say">' + t("honest.base") + "</p>" : "") + ladder() +
        '<p class="say">' + t("honest.head") + "</p>") +
    (city.shapes ? '<p class="say">' + t("honest.map", {
      source: t(city.shapes.source),
      kind: t(city.shapes.exact ? "honest.map.exact" : "honest.map.inferred"),
    }) + "</p>" : "") +
    (lentParts
      ? '<p class="say">' + t("honest.chain", {
          why: t(s.paid_deals ? "honest.chain.why.some" : "honest.chain.why.none"),
          what: lentParts,
        }) + "</p>"
      : "") +
    '<p class="say">' + t("honest.withheld") + "</p></div>" + footer();
}

/* The method, drawn instead of described.
   A listing price is what the seller asks; ITBI says what was paid; finished
   auctions say what the hammer takes off that. Three numbers on one scale is
   the whole argument against a discount quoted off a bank's appraisal, and it
   is the one thing the first version of this site had that this one did not. */
function ladder() {
  var ch = city.chain || {};
  if (!ch.asking_premium || !ch.auction_factor) return "";
  var paid = 1 / ch.asking_premium;
  var own = ch.zones > 0;

  function rung(lab, share, sub, end) {
    return '<div class="rung' + (end ? " is-end" : "") + '">' +
      '<div class="rl">' + t(lab) + "</div>" +
      '<div class="rv">' + Math.round(share * 100) + "%</div>" +
      '<div class="rs">' + sub + "</div></div>";
  }
  function mul(x, lab) {
    return '<div class="mul"><span>×' + x.toFixed(3) + "</span>" + t(lab) + "</div>";
  }

  return '<div class="ladder">' +
    rung("chain.asking.label", 1,
         own ? t("chain.asking.sub", { zones: num(ch.zones), city: esc(city.nome) })
             : t("chain.asking.sub_borrowed"), false) +
    mul(paid, "chain.step.premium") +
    rung("chain.paid.label", paid,
         own ? t("chain.paid.sub") : t("chain.paid.sub_borrowed"), false) +
    mul(ch.auction_factor, "chain.step.factor") +
    rung("chain.hammer.label", ch.hammer_over_asking,
         t("chain.hammer.sub", { n: num(ch.n_auction) }), true) +
    "</div>";
}

function footer() {
  return '<p class="foot">' +
    link("/all", t("nav.all")) + " · " + link("/honest", t("nav.honest")) + "<br>" +
    footNote() + "</p>" + langbar();
}

/* What the data is, and what we count. The second half is short on purpose:
 * a site that measures its readers without cookies can say so in one line
 * instead of sending them to a policy nobody opens. */
function footNote() {
  return t("foot.note", { date: esc(D.generated) }) + " " + t("foot.privacy");
}

/* Down here on purpose. The runtime already picks the visitor's language from
   the browser, so this is a correction and not a first move; the header on a
   390px phone has no room for a third control. Each language is a real link to
   a real URL, so it survives a page with no JS. */
function langbar() {
  var all = LANG.langs;
  if (all.length < 2) return "";
  return '<p class="langs">' + all.map(function (c) {
    var name = esc(LANG.names[c]);
    if (c === LANG.code) return '<b lang="' + c + '" aria-current="true">' + name + "</b>";
    return '<a lang="' + c + '" data-lang="' + c + '" hreflang="' + c +
      '" href="?lang=' + c + '">' + name + "</a>";
  }).join('<i aria-hidden="true">·</i>') + "</p>";
}

function back(url, label) {
  return '<a class="back" href="' + url + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"' +
    ' stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>' +
    esc(label) + "</a>";
}

/* ---- routing --------------------------------------------------- */

/* Real paths, not hash fragments.
 *
 *   /leilao-de-imoveis/rio-de-janeiro-rj/copacabana/
 *
 * One page, one URL, one thing a search engine can hold. The keyword sits in
 * the path because that is the phrase a Brazilian types; the UF stays on the
 * city because "são gonçalo" alone names two places.
 *
 * Call sites still pass the short internal forms ("/a/COPACABANA", "/all") and
 * this is the single place that knows what they look like on the wire. */
var ROOT = "/leilao-de-imoveis";
var SEG = { all: "todos-os-lotes", honest: "como-calculamos", lot: "lote", rua: "rua" };

/* A lot's URL carries what the lot is, not what the database calls it:
 *   /lote/apartamento-64m2-penha-circular-0e2af7f775f1e45c/
 * The id is the last segment so the address stays unique when two flats in one
 * street share a size, and the words in front of it are the ones somebody
 * would actually type. An opaque id here is the mistake the largest competitor
 * made 36 530 times.
 *
 * These URLs are permanent. When the auction ends the page does not go away —
 * what happened to a lot is the one thing nobody in this market publishes. */
function lotSlug(r) {
  var bits = [];
  if (r[C.tipo]) bits.push(slugify(String(r[C.tipo]).replace(/s$/, "")));
  if (r[C.area]) bits.push(Math.round(r[C.area]) + "m2");
  if (r[C.bairro]) bits.push(slugify(r[C.bairro]));
  bits.push(String(r[C.id]));
  return bits.filter(Boolean).join("-");
}

function slugify(s) {
  return String(s == null ? "" : s)
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function cityBase(c) {
  var x = c || city;
  return ROOT + "/" + (x.uf ? x.uf + "/" : "") + (x.cslug || x.slug) + "/";
}

function href(path) {
  var base = cityBase();
  var p = path || "/";
  if (p === "/home") return "/";
  if (p === "/" || p === "") return base;
  if (p === "/all") return base + SEG.all + "/";
  if (p === "/honest") return base + SEG.honest + "/";
  var m = /^\/a\/(.*)$/.exec(p);
  if (m) return base + slugOf(decodeURIComponent(m[1])) + "/";
  m = /^\/r\/(.*)$/.exec(p);
  if (m) {
    var st = city.streets && city.streets.d[decodeURIComponent(m[1])];
    return st ? base + SEG.rua + "/" + st.slug + "/" : base;
  }
  m = /^\/l\/(.*)$/.exec(p);
  if (m) {
    var id = decodeURIComponent(m[1]);
    return base + SEG.lot + "/" + (lotById[id] ? lotSlug(lotById[id]) : id) + "/";
  }
  return base;
}

/* An area's URL is its display name, flattened. The raster key is upper-case
 * and accent-stripped for matching; a reader's link should not be. */
function slugOf(key) { return slugToKey.rev[key] || slugify(areaName(key)); }

/* One path in, one screen out. Kept separate from the page it is drawn on so
 * the build can walk every route in a single tab without navigating: the
 * pre-render calls this, takes the markup, and writes a file. */
/* Whether the screen just drawn belongs to a city. The header's picker reads
 * it: on the country page and on the not-found page the answer is no, and a
 * control labelled with whichever city happened to be indexed last would be
 * telling the reader something untrue about where they are. */
var atCity = true;

function screenFor(path) {
  var p = String(path || "/").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (p[0] === ROOT.replace(/^\//, "")) p = p.slice(1);

  // <uf>/<cidade>, with the old glued form still understood so a link that is
  // already out in the world does not break.
  // Nothing before the city: the country page. It is the only screen that does
  // not need one, so it is checked before the lookup that would fail.
  atCity = false;
  if (!p.length) return screenHome();
  if (p.length === 1 && p[0] === "404") return screenNotFound();
  atCity = true;

  var named = D.cities.filter(function (c) {
    return (c.uf === p[0] && (c.cslug || c.slug) === p[1]) || c.slug === p[0];
  })[0];
  if (!named) return null;
  if (named.uf === p[0]) p = p.slice(1);
  if (named.slug !== city.slug) { indexCity(named); paintPick(); }
  p = p.slice(1);

  if (!p.length) return screenCity();
  if (p[0] === SEG.all) return screenAll();
  if (p[0] === SEG.honest) return screenHonest();
  if (p[0] === SEG.lot) return screenLot(idFromSlug(decodeURIComponent(p[1] || "")));
  if (p[0] === SEG.rua) {
    var sc = streetBySlug[decodeURIComponent(p[1] || "")];
    return sc ? screenStreet(sc) : screenCity();
  }
  var key = slugToKey.fwd[p[0]];
  return key ? screenArea(key) : screenCity();
}

/* The build's only entry point. Loads once with the whole dataset, is then
 * asked for one path at a time, and hands back everything a file needs: the
 * markup, the head, and the links out. No navigation, no reload — the data is
 * already in memory, so a route costs milliseconds and all of them together
 * cost minutes.
 *
 * It exists because the site's product is a number. A number that is born in
 * this file and never reaches the HTML does not exist for anything that does
 * not run JavaScript — and the crawlers behind ChatGPT, Claude and Perplexity
 * measurably do not. */
window.__render__ = function (path) {
  var html = screenFor(path);
  if (html == null) return null;
  var box = document.createElement("div");
  box.innerHTML = html;
  var links = [];
  [].forEach.call(box.querySelectorAll("a[href^='/']"), function (a) {
    links.push(a.getAttribute("href"));
  });
  return {
    body: html,
    city: atCity ? city.slug : "",
    split: !!box.querySelector(".side, .mapcard:not(.maparea), .shot"),
    head: headFor(path),
    links: links,
  };
};

/* What the head of this page should say. Kept next to the screens so a new
 * screen cannot quietly ship with the site-wide title. */
function cityPrep() { return t("city.prep." + city.slug, null, t("city.prep")); }

function headFor(path) {
  var p = String(path || "/").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  var last = p[p.length - 1] || "";
  var base = { title: t("meta.title"), desc: t("meta.desc"), canonical: path };
  if (p.length === 1 && p[0] === "404") {
    return { title: t("head.nf.title"), desc: t("nf.p"), canonical: path };
  }
  if (!p.length) {
    var n = national();
    base.title = t("head.home.title");
    base.desc = t("head.home.desc", {
      lots: lots(n.lots),
      cities: num(D.cities.length) + " " + plur("unit.city", D.cities.length),
    });
    return base;
  }
  if (!city) return base;
  var name = city.nome;
  if (p[p.length - 2] === SEG.rua && streetBySlug[last]) {
    var stx = city.streets.d[streetBySlug[last]];
    var main = stx.f || stx.h;
    base.title = t("head.street.title", { street: title(stx.name), city: name });
    base.desc = t("head.street.desc", {
      street: title(stx.name), district: areaName(stx.bairro),
      year: city.streets.year, value: money(main[0]), n: num(main[1]),
    });
  } else if (slugToKey.fwd[last]) {
    var st = areaStat(slugToKey.fwd[last]);
    base.title = t("head.area.title", { name: areaName(st.key), city: name });
    base.desc = t("head.area.desc", {
      name: areaName(st.key), city: name,
      lots: lots(st.n), below: num(st.below), rel: num(st.rel),
    });
  } else if (last === SEG.honest) {
    base.title = t("head.honest.title", { city: name });
    base.desc = t("head.honest.desc", { city: name });
  } else if (p[p.length - 2] === SEG.lot) {
    var r = lotById[idFromSlug(last)];
    var what = r ? title(r[C.end] || r[C.tipo] || t("lot.fallback")) : t("lot.fallback");
    var where = r && r[C.bairro] ? title(r[C.bairro]) : name;
    base.title = t("head.lot.title", { what: what, where: where });
    base.desc = t("head.lot.desc", { what: what, where: where, city: name });
  } else if (last === SEG.all) {
    base.title = t("head.all.title", { city: name });
    base.desc = t("head.all.desc", { city: name, lots: lots(city.stats.lots) });
  } else {
    base.title = t("head.city.title", { prep: cityPrep(), city: name });
    base.desc = marketOnly()
      ? t("head.city.desc.market", {
          city: name, lots: lots(city.stats.lots), districts: num(mktDistricts()),
        })
      : t("head.city.desc", {
          city: name, lots: lots(city.stats.lots), below: num(city.stats.below),
        });
  }
  return base;
}

function render() {
  var html = screenFor(location.pathname);
  if (html == null) {
    // Nothing here names a city — send the reader to the remembered one rather
    // than to an empty page.
    location.replace(cityBase());
    return;
  }
  var view = $("view");
  view.innerHTML = html;
  // Two columns only when there is something to put in the second one; a lot
  // list has no map, and an empty sticky column is just a wide margin.
  view.className = "wrap" + (view.querySelector(".side, .mapcard:not(.maparea), .shot") ? " split" : "");
  window.scrollTo(0, 0);
  wire();
}

function wire() {
  if (window.ANALYZE) window.ANALYZE.wire();
  var near = $("near");
  if (near) near.addEventListener("click", askNear);
  wireCity($("view"));
}

/* Asked for only on a tap, used only in the browser, never sent anywhere. */
function askNear() {
  var msg = $("nearmsg");
  if (!navigator.geolocation) { msg.textContent = t("near.nogeo"); return; }
  msg.textContent = t("near.asking");
  navigator.geolocation.getCurrentPosition(function (pos) {
    var la = pos.coords.latitude, lo = pos.coords.longitude, best = null, bd = 1e9;
    Object.keys(byArea).forEach(function (k) {
      var rs = byArea[k].filter(function (r) { return r[C.lat]; });
      if (!rs.length) return;
      var d = Math.pow(rs[0][C.lat] - la, 2) + Math.pow((rs[0][C.lon] - lo) * 0.9, 2);
      if (d < bd) { bd = d; best = k; }
    });
    if (!best || bd > 0.09) {
      msg.textContent = t("near.outside", { city: city.nome });
      return;
    }
    msg.textContent = "";
    location.assign(href("/a/" + encodeURIComponent(best)));
  }, function () {
    msg.textContent = t("near.denied");
  }, { timeout: 8000, maximumAge: 600000 });
}

/* ---- boot ------------------------------------------------------ */

var saved = null;
try { saved = localStorage.getItem("city"); } catch (e) { /* private mode */ }
indexCity(D.cities.filter(function (c) { return c.slug === saved; })[0] || guessCity());
paintPick();

// No client-side router: every link is a real URL and every URL is a real
// file. The brand is an anchor like any other.
document.querySelector(".brand").setAttribute("href", "/");
render();
