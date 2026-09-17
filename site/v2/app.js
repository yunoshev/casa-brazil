"use strict";
/* Preço Real — three screens, one file.
 *
 * city -> area -> lot, addressed by hash so every level is a URL the reader can
 * send to someone. The map is the navigation: nothing on it is decorative,
 * every outline is a tap target, and zooming is the route changing.
 *
 * Visible strings come through t() from i18n/<lang>.json, including SEO
 * notices and pagination. */

/* Generated lot pages already contain their HTML and only need gallery wiring;
 * keep the data-dependent index harmless when that payload is absent. */
var D = window.__D__ || { cols: [], cities: [] };
var C = {};
if (D && Array.isArray(D.cols)) D.cols.forEach(function (c, i) { C[c] = i; });

var t = LANG.t, plur = LANG.plur, num = LANG.num, money = LANG.money, pct = LANG.pct;

/* ---- formatting ------------------------------------------------ */

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function b(s) { return "<b>" + s + "</b>"; }

/* This is a rendering reference, never a claim that a source was checked. */
var dateReference = new Date().toISOString().slice(0, 10);
function auctionDate(r) {
  var value = r[C.data];
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  var parsed = new Date(value + "T00:00:00Z");
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function auctionNote(r) {
  var day = auctionDate(r);
  var text = day
    ? t("seo.auction.date", { date: day }) + " "
    : t("seo.auction.unknown") + " ";
  if (day && day < dateReference) {
    text += t("seo.auction.past", { date: dateReference }) + " ";
  }
  return text + t("seo.auction.verify");
}

/* Portuguese title-casing, and deliberately not translated: this folds the
 * *data* — Brazilian street and district names — not the interface. A Russian
 * or English reader still wants "Rua do Catete", not "Rua Do Catete". */
function title(s) {
  var small = { de: 1, da: 1, do: 1, das: 1, dos: 1, e: 1, em: 1, a: 1, o: 1 };
  return String(s || "").toLowerCase().split(/\s+/).map(function (w, i) {
    return i && small[w] ? w : w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}
function metaText(value, limit) {
  var text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(1, limit - 1)).replace(/[\s,.;:-]+$/g, "") + "\u2026";
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

/* Inventory membership and analytical reliability are independent. Older
 * exports remain browsable, but their availability has never been verified. */
function lifecycle(r, c) { return ((c || city).lifecycle || {})[String(r[C.id])] || {}; }
function lotStatus(r, c) {
  var status = lifecycle(r, c).status;
  return ["active", "missing", "archived"].indexOf(status) >= 0 ? status : "unverified";
}
function isCurrent(r, c) { return ["missing", "archived"].indexOf(lotStatus(r, c)) < 0; }
function currentRows(c) {
  c = c || city;
  return c.rows.filter(function (r) { return isCurrent(r, c); });
}
function archiveRows() {
  return city.rows.filter(function (r) { return !isCurrent(r); }).sort(function (a, b) {
    var la = lifecycle(a), lb = lifecycle(b);
    return String(lb.archived_at || lb.missing_since || "").localeCompare(String(la.archived_at || la.missing_since || "")) ||
      String(a[C.id]).localeCompare(String(b[C.id]));
  });
}
function refreshStats(c) {
  var rows = currentRows(c), rel = rows.filter(reliable);
  var loud = rel.filter(function (r) { return (r[C.promised] || 0) >= 45; });
  var promised = rel.map(function (r) { return r[C.promised]; }).filter(function (v) { return v != null; });
  var s = c.stats = c.stats || {};
  s.lots = rows.length;
  s.reliable = rel.length;
  s.below = rel.filter(function (r) { return r[C.margin] > 0; }).length;
  s.promised_med = median(promised);
  s.real_med = rel.length ? -median(rel.map(function (r) { return r[C.margin]; })) : null;
  s.promised_hi_n = loud.length;
  s.above_hammer = loud.filter(function (r) { return r[C.margin] < 0; }).length;
  s.loud_below = loud.filter(function (r) { return r[C.margin] > 0; }).length;
}

var STATUS_KEY = { active: "archive.status.active", unverified: "archive.status.unverified",
  missing: "archive.status.missing", archived: "archive.status.archived" };
var OUTCOME_KEY = { sold: "archive.outcome.sold", withdrawn: "archive.outcome.withdrawn",
  cancelled: "archive.outcome.cancelled", postponed: "archive.outcome.postponed", unsold: "archive.outcome.unsold" };
var HISTORY_KEY = { seeded: "archive.event.seeded", seen: "archive.event.seen",
  historical_price: "archive.event.historical_price",
  price_changed: "archive.event.price_changed", missing: "archive.event.missing",
  archived: "archive.event.archived", reappeared: "archive.event.reappeared", outcome: "archive.event.outcome" };
function httpsSource(value) {
  if (typeof value !== "string" || /[\s<>"'\\]/.test(value)) return null;
  try {
    var u = new URL(value);
    return u.protocol === "https:" && u.hostname && !u.username && !u.password ? value : null;
  } catch (e) { return null; }
}
function confirmedOutcome(r) {
  var outcome = lifecycle(r).outcome;
  return outcome && Object.prototype.hasOwnProperty.call(OUTCOME_KEY, outcome.kind) &&
    httpsSource(outcome.evidence_url) ? outcome : null;
}
function archiveDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  var date = new Date(value);
  var day = new Date(value.slice(0, 10) + "T00:00:00Z");
  return !isNaN(date.getTime()) && !isNaN(day.getTime()) &&
    day.toISOString().slice(0, 10) === value.slice(0, 10) ? value : null;
}
function dateFact(key, value) {
  var date = archiveDate(value);
  return fact(t(key), date || t("archive.date.unknown"));
}
function priceKnown(value) { return typeof value === "number" && isFinite(value) && value >= 0; }
function lastAdvertisedPrice(r) {
  var value = lifecycle(r).last_price_brl;
  return priceKnown(value) ? value : priceKnown(r[C.preco]) ? r[C.preco] : null;
}
function lotReference(r) { return String(r[C.id] == null ? "" : r[C.id]).trim(); }
function lotReferenceLine(r) {
  return '<p class="lot-reference">' + esc(t("lot.reference", { ref: lotReference(r) })) + '</p>';
}
function priceText(value) { return priceKnown(value) ? money(value) : t("archive.price.unknown"); }
function inventoryNotice() { return '<p class="note inventory-note">' + esc(t("archive.inventory.notice")) + '</p>'; }
function lifecycleBanner(r, compact) {
  var status = lotStatus(r), lc = lifecycle(r);
  if (compact) {
    return '<aside class="lifecycle-banner compact ' + status + '" aria-label="' + esc(t(STATUS_KEY[status])) + '">' +
      '<b>' + esc(t(STATUS_KEY[status])) + '</b><span>' + esc(t(!isCurrent(r)
        ? "archive.removal.notice" : status === "active" ? "archive.active.notice" : "archive.unverified.notice")) +
      '</span></aside>';
  }
  return '<section class="lifecycle-banner ' + status + '" aria-label="' + esc(t(STATUS_KEY[status])) + '">' +
    '<h2>' + esc(t(STATUS_KEY[status])) + '</h2><p>' + esc(t(!isCurrent(r)
      ? "archive.removal.notice" : status === "active" ? "archive.active.notice" : "archive.unverified.notice")) + '</p>' +
    '<div class="facts">' + dateFact("archive.date.last_seen", lc.last_seen_at) +
      dateFact("archive.date.checked", lc.last_checked_at) +
      (status === "missing" || lc.missing_since ? dateFact("archive.date.missing", lc.missing_since) : "") +
      (status === "archived" ? dateFact("archive.date.archived", lc.archived_at) : "") + '</div></section>';
}
function lotHistory(r) {
  var lc = lifecycle(r), outcome = confirmedOutcome(r);
  var history = (Array.isArray(lc.history) ? lc.history : []).filter(function (event) {
    return event && Object.prototype.hasOwnProperty.call(HISTORY_KEY, event.kind);
  });
  return '<section class="mkt lot-history"><h2>' + esc(t("archive.history.h2")) + '</h2>' +
    '<p class="note">' + esc(t("archive.history.notice")) + '</p>' +
    '<div class="facts">' + dateFact("archive.date.first_seen", lc.first_seen_at) +
      fact(t("archive.price.last"), priceText(lastAdvertisedPrice(r))) + '</div>' +
    (outcome ? '<div class="confirmed-outcome"><h3>' + esc(t(OUTCOME_KEY[outcome.kind])) + '</h3>' +
      '<div class="facts">' + dateFact("archive.date.outcome", outcome.effective_at) +
      (outcome.kind === "sold" && priceKnown(outcome.price_brl)
        ? fact(t("archive.price.sale"), priceText(outcome.price_brl)) : "") + '</div>' +
      '<a href="' + esc(outcome.evidence_url) + '" target="_blank" rel="noopener noreferrer">' +
      esc(t("archive.evidence")) + '</a></div>'
      : '<p>' + esc(t("archive.outcome.unknown")) + '</p>') +
    (history.length ? '<ol class="history-events">' + history.map(function (event) {
      var url = httpsSource(event.source_url);
      return '<li><b>' + esc(t(HISTORY_KEY[event.kind], {
        date: archiveDate(event.source_date) || t("archive.date.unknown"),
      })) + '</b><div class="facts">' +
        dateFact(event.kind === "historical_price" || event.kind === "seeded" ? "archive.date.imported" : "archive.date.observed", event.observed_at) +
        fact(t("archive.price.observed"), priceText(event.price_brl)) +
        dateFact("archive.date.source", event.source_date) + '</div>' +
        (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(t("archive.evidence")) + '</a>' : "") + '</li>';
    }).join("") + '</ol>' : '<p>' + esc(t("archive.history.empty")) + '</p>') + '</section>';
}

function screenHistoricalLot(r) {
  var key = areaOf(r);
  return '<div class="hero">' + back(key ? href("/a/" + encodeURIComponent(key)) : href(), key ? areaName(key) : city.nome) +
    '<h1><span class="lot-title" title="' + esc(title(r[C.end] || r[C.tipo] || t("lot.fallback"))) + '">' + esc(title(r[C.end] || r[C.tipo] || t("lot.fallback"))) + '</span></h1><p class="lede">' + lotLine(r) + '</p>' +
    lotReferenceLine(r) +
    lotBreadcrumb(r) + '</div>' +
    lifecycleBanner(r) + lotGallery(r) + lotMapsBlock(r) + '<p class="foot">' + link("/archive", esc(t("archive.nav"))) + ' · ' +
    link("/all", esc(t("archive.current"))) + '</p>' + lotHistory(r) +
    '<section class="mkt" data-lot-report="' + esc(r[C.id]) + '"></section>' +
    '<section class="mkt historical-analysis"><h2>' + esc(t("archive.analysis.h2")) + '</h2>' +
    '<p>' + esc(t("archive.analysis.notice")) + '</p><div class="facts">' +
    fact(t("archive.price.appraisal"), priceText(r[C.aval])) +
    (reliable(r) ? fact(t("archive.price.estimate"), priceText(r[C.hammer])) +
      fact(t("archive.price.market"), priceText(r[C.mkt])) : '') + '</div></section>' +
    (httpsSource(r[C.link]) ? '<p class="foot"><a href="' + esc(r[C.link]) + '" target="_blank" rel="noopener noreferrer">' +
      esc(t("archive.source.original")) + '</a></p>' : '') + sameStreetLots(r) + relatedLots(r) + footer();
}

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

/* Media is an additive payload. Older builds do not carry it at all, so the
 * renderer must never make the presence of a gallery a prerequisite for a
 * lot page.  The exporter currently writes `{cities: {slug: {lot_id: ...}}}`;
 * the small set of equivalent lookups below also keeps previews and future
 * payload wrappers readable without fetching anything from the browser. */
function mediaPayload() {
  return D.media || D.lot_media || D.media_payload ||
    (window && window.__MEDIA__) || null;
}
function mediaRecordFor(r) {
  var payload = mediaPayload(), id = String(r[C.id]);
  if (!payload || typeof payload !== "object") return null;
  var has = function (obj, key) {
    return obj && typeof obj === "object" &&
      Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null;
  };
  var cityKeys = [city.slug, city.cslug, city.uf && (city.uf + ":" + city.cslug)];
  var cities = has(payload, "cities");
  if (cities && typeof cities === "object") {
    for (var i = 0; i < cityKeys.length; i++) {
      var bucket = has(cities, cityKeys[i]);
      var record = has(bucket, id);
      if (record && typeof record === "object") return record;
    }
  }
  var lots = has(payload, "lots");
  var direct = has(lots, id) || has(payload, id);
  if (direct && typeof direct === "object") return direct;
  var records = has(payload, "records");
  if (Array.isArray(records)) {
    for (var j = 0; j < records.length; j++) {
      var item = records[j];
      if (item && typeof item === "object" &&
          String(item.lot_id || item.id || item.registry_uid || "") === id) return item;
    }
  }
  return null;
}
function safeMediaUrl(value) {
  if (typeof value !== "string" || !value || /[\s<>"'\\]/.test(value)) return null;
  try {
    var u = new URL(value);
    return u.protocol === "https:" && u.hostname && !u.username && !u.password && !u.search && !u.hash ? value : null;
  } catch (e) { return null; }
}
function mediaUrls(record) {
  if (!record || typeof record !== "object") return [];
  var out = [], seen = {};
  var add = function (value) {
    var url = safeMediaUrl(value);
    if (url && !seen[url]) { seen[url] = true; out.push(url); }
  };
  var gallery = record.gallery;
  if (Array.isArray(gallery)) {
    gallery.forEach(function (entry) {
      add(entry && typeof entry === "object" ? entry.url : entry);
    });
  }
  /* If a malformed/new gallery contains no usable URLs, use the v1 fields.
   * When gallery has usable entries it is authoritative and its order wins. */
  if (!out.length) {
    (Array.isArray(record.photos) ? record.photos : []).forEach(add);
    add(record.primary_photo);
  }
  return out;
}
function lotPhotos(r) {
  var urls = mediaUrls(mediaRecordFor(r));
  if (!urls.length) {
    var fallback = safeMediaUrl(photo(r));
    if (fallback) urls.push(fallback);
  }
  return urls;
}
function galleryText(kind, index, total) {
  var code = LANG && LANG.code;
  if (kind === "count") {
    return code === "ru" ? index + " из " + total : code === "en" ? index + " of " + total : index + " de " + total;
  }
  if (code === "ru") return kind === "previous" ? "Предыдущее фото" : kind === "next" ? "Следующее фото" : "Фото " + index + " из " + total;
  if (code === "en") return kind === "previous" ? "Previous photo" : kind === "next" ? "Next photo" : "Photo " + index + " of " + total;
  return kind === "previous" ? "Foto anterior" : kind === "next" ? "Próxima foto" : "Foto " + index + " de " + total;
}
function galleryAlt(r, index, total) {
  var subject = title(r[C.end] || r[C.tipo] || t("lot.fallback"));
  var place = title(r[C.bairro] || city.nome);
  return subject + " — " + place + ", " + galleryText("count", index, total);
}
function lotGallery(r) {
  var photos = lotPhotos(r);
  if (!photos.length) return "";
  var total = photos.length, label = galleryText("count", 1, total);
  var html = '<section class="lot-gallery" data-gallery data-gallery-total="' + total +
    '" role="region" tabindex="0" aria-label="' + esc(t("lot.gallery.label", null, "Property photos")) + '">' +
    '<div class="gallery-hero"><button type="button" class="gallery-open" data-gallery-open aria-haspopup="dialog" aria-label="' +
      esc(t("lot.gallery.open", null, "Open larger photo")) + '"><img class="shot" data-gallery-hero src="' + esc(photos[0]) +
    '" alt="' + esc(galleryAlt(r, 1, total)) + '" decoding="async" fetchpriority="high" width="640" height="480"' +
    ' onerror="this.style.display=\'none\'"></button>' +
    '<span class="gallery-count" data-gallery-count aria-live="polite">' + esc(label) + "</span></div>";
  if (total > 1) {
    html += '<div class="gallery-controls">' +
      '<button type="button" class="gallery-control" data-gallery-prev aria-label="' + esc(galleryText("previous", 1, total)) + '" disabled>‹</button>' +
      '<span class="gallery-hint">' + esc(galleryText("count", 1, total)) + '</span>' +
      '<button type="button" class="gallery-control" data-gallery-next aria-label="' + esc(galleryText("next", 2, total)) + '">›</button>' +
      '</div><div class="gallery-thumbs" role="list" aria-label="' + esc(t("lot.gallery.label", null, "Property photos")) + '">';
    photos.forEach(function (url, i) {
      html += '<button type="button" class="gallery-thumb" data-gallery-index="' + i +
        '" data-gallery-alt="' + esc(galleryAlt(r, i + 1, total)) +
        '" aria-label="' + esc(galleryText("photo", i + 1, total)) + '" aria-current="' + (i === 0 ? "true" : "false") + '">' +
        '<img src="' + esc(url) + '" alt="" decoding="async"' + (i ? ' loading="lazy"' : '') +
        ' width="88" height="66" onerror="this.style.display=\'none\'">' +
        '</button>';
    });
    html += "</div>";
  }
  html += '<div class="gallery-lightbox" data-gallery-lightbox hidden role="dialog" aria-modal="true" aria-label="' +
    esc(t("lot.gallery.label", null, "Property photos")) + '"><button type="button" class="gallery-lightbox-backdrop" data-gallery-close tabindex="-1" aria-hidden="true"></button>' +
    '<div class="gallery-lightbox-panel"><button type="button" class="gallery-lightbox-close" data-gallery-close aria-label="' +
      esc(t("lot.gallery.close", null, "Close gallery")) + '">×</button>' +
    '<img data-gallery-lightbox-image src="' + esc(photos[0]) + '" alt="' + esc(galleryAlt(r, 1, total)) + '">';
  if (total > 1) {
    html += '<div class="gallery-lightbox-controls"><button type="button" class="gallery-control" data-gallery-lightbox-prev aria-label="' +
      esc(galleryText("previous", 1, total)) + '" disabled>‹</button><span class="gallery-hint" data-gallery-lightbox-count aria-live="polite">' +
      esc(label) + '</span><button type="button" class="gallery-control" data-gallery-lightbox-next aria-label="' +
      esc(galleryText("next", 2, total)) + '">›</button></div>';
  }
  return html + "</div></div></section>";
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

var DEFAULT_CITY = D.cities.filter(function (c) { return c.slug === "sao-paulo-sp"; })[0] || D.cities[0];
var city = DEFAULT_CITY;
var byArea = {};
var historyByArea = {};
var slugToKey = { fwd: {}, rev: {} };
var streetBySlug = {};
var lotById = {};
var lotBySlug = {};
var streetCodeByLotId = {};
var lotsByStreet = {};
var lotsByArea = {};
var lotsByCity = [];
D.cities.forEach(refreshStats);

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
  relatedLotCache = {};
  relatedPlaceCache = {};
  relatedCandidates = {};
  streetCodeByLotId = {};
  lotsByStreet = {};
  lotsByArea = {};
  lotsByCity = [];
  city = c;
  byArea = {};
  historyByArea = {};
  lotById = {};
  lotBySlug = {};
  refreshStats(c);
  ensureCatalogStreets(c);
  var streets = (c.streets || {}).d || {};
  // A street URL is a promise.  Do not use a row merely because its text
  // resembles an address: the matching street must have one unambiguous,
  // published route in this city's catalogue.
  streetBySlug = {};
  Object.keys(streets).forEach(function (code) {
    var slug = streets[code] && streets[code].slug;
    if (!slug) return;
    if (Object.prototype.hasOwnProperty.call(streetBySlug, slug)) {
      streetBySlug[slug] = null; // Colliding slugs cannot safely be linked.
    } else {
      streetBySlug[slug] = code;
    }
  });
  var streetCodes = Object.keys(streets).filter(publishedStreetCode).sort(function (a, b) {
    return String(c.streets.d[b].name || "").length - String(c.streets.d[a].name || "").length;
  });
  c.rows.forEach(function (r) {
    lotById[String(r[C.id])] = r;
    lotBySlug[lotSlug(r)] = r;
    lotsByCity.push(r);
    var id = String(r[C.id]), street = matchedStreetCode(r[C.end], streetCodes);
    streetCodeByLotId[id] = street;
    if (street) (lotsByStreet[street] = lotsByStreet[street] || []).push(r);
    var k = areaOf(r), place = { area: k || normKey(r[C.bairro]), street: street };
    if (place.area) (lotsByArea[place.area] = lotsByArea[place.area] || []).push(r);
    var target = isCurrent(r) ? byArea : historyByArea;
    if (k) (target[k] = target[k] || []).push(r);
  });
  // Both directions: the URL carries a slug, the data is keyed by the raster
  // key, and a reader arriving from outside has only the slug.  The reverse
  // map above deliberately omits ambiguous slugs.
  slugToKey = { fwd: {}, rev: {} };
  var nice = (c.shapes || {}).nice || {};
  Object.keys(nice).forEach(function (k) {
    var sl = slugify(nice[k]);
    // Two areas that flatten to the same slug would silently share a page.
    if (slugToKey.fwd[sl] && slugToKey.fwd[sl] !== k) sl = sl + "-" + slugify(k).slice(0, 6);
    slugToKey.fwd[sl] = k;
    slugToKey.rev[k] = sl;
  });
  buildRelatedGroups();
}

/* The deed dataset covers only some cities and has its own statistical sample
 * threshold. A street route is useful before it has a valuation: it gives a
 * reader an honest list of the auction lots at that address. Build those
 * routes from the already-published catalogue, one per confidently parsed
 * street, including a street with a single lot. */
function parsedCatalogStreet(address) {
  var first = String(address || "").split(",")[0].replace(/\s+/g, " ").trim();
  if (!/^(?:RUA|R\.?|AVENIDA|AV\.?|ALAMEDA|TRAVESSA|TV\.?|ESTRADA|RODOVIA|ROD\.?|PRACA|PRAÇA|LARGO|VIA|PASSAGEM|BECO)\s+/i.test(first)) return null;
  if (first.length < 5 || /\d/.test(first)) return null;
  return first;
}

function ensureCatalogStreets(c) {
  var streets = c.streets && typeof c.streets === "object" ? c.streets : (c.streets = {});
  var data = streets.d && typeof streets.d === "object" ? streets.d : (streets.d = {});
  var byName = {}, usedSlugs = {};
  Object.keys(data).forEach(function (code) {
    var st = data[code] || {}, key = normKey(st.name);
    if (key) byName[key] = code;
    if (st.slug) usedSlugs[st.slug] = true;
  });
  (c.rows || []).forEach(function (r) {
    var name = parsedCatalogStreet(r[C.end]);
    if (!name) return;
    var key = normKey(name), code = byName[key];
    if (!code) {
      var slug = slugify(name), n = 2, base = slug;
      while (usedSlugs[slug]) slug = base + "-" + n++;
      code = "catalog-" + slug;
      data[code] = {
        name: name,
        slug: slug,
        bairro: normKey(r[C.bairro]),
        bairros: [normKey(r[C.bairro])],
        catalog_only: true,
      };
      byName[key] = code;
      usedSlugs[slug] = true;
    }
  });
}

function publishedStreetCode(code) {
  var st = city.streets && city.streets.d && city.streets.d[code];
  return !!(st && st.name && st.slug && streetBySlug[st.slug] === code);
}

/* An address can name a road and then continue with a building name.  That is
 * not enough to call it the catalogue street: after the exact street name we
 * require a conventional house/unit marker or a number.  This consciously
 * leaves some rows unlinked rather than connecting a reader to the wrong Rua.
 */
function certainStreetTail(value) {
  var tail = String(value || "").replace(/^[\s,;:/.-]+/, "");
  return !tail || /^\d/.test(tail) ||
    /^(?:N(?:[.\s]|$)|NO(?:[.\s]|$)|NUM(?:[.\s]|$)|NUMERO\b|S\s*\/?\s*N\b|SN\b|KM\b|LOTE\b|LT\b|QUADRA\b|QD\b|CASA\b|AP(?:T)?\b|BLOCO\b|BL\b|ED(?:IFICIO)?\b)/.test(tail);
}

function streetAddressMatches(address, streetName) {
  var text = normKey(address), name = normKey(streetName);
  if (!text || !name || text.indexOf(name) !== 0) return false;
  if (text === name) return true;
  var boundary = text.charAt(name.length);
  return /[\s,;:/.-]/.test(boundary) && certainStreetTail(text.slice(name.length));
}

function matchedStreetCode(address, codes) {
  if (!address) return null;
  for (var i = 0; i < codes.length; i++) {
    var code = codes[i], st = city.streets.d[code];
    if (st && streetAddressMatches(address, st.name)) return code;
  }
  return null;
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

/* Inventory context is deliberately separate from the deed statistics above.
 * It counts the unique catalogue records that this route can actually link to
 * and calls the observed opening bid what it is.  It never combines market
 * report ranges or turns an unverified row into a confirmed offer. */
function inventoryDate(rows) {
  var generated = archiveDate(D && D.generated);
  if (generated) return { key: "inventory.date.dataset", date: generated.slice(0, 10) };
  var dates = uniqueRows(rows).map(function (r) {
    var lc = lifecycle(r);
    return archiveDate(lc.last_checked_at || lc.last_seen_at);
  }).filter(Boolean).sort();
  return dates.length ? { key: "inventory.date.checked", date: dates[dates.length - 1].slice(0, 10) } : null;
}

function uniqueRows(rows) {
  var seen = {};
  return (Array.isArray(rows) ? rows : []).filter(function (r, i) {
    if (!r) return false;
    var id = String(r[C.id] == null ? "" : r[C.id]).trim() || "@" + i;
    if (seen[id]) return false;
    seen[id] = true;
    return true;
  });
}

function inventorySummary(rows, anchors) {
  var all = uniqueRows(rows), current = all.filter(isCurrent), archived = all.filter(function (r) { return !isCurrent(r); });
  var unverified = current.filter(function (r) { return lotStatus(r) === "unverified"; }).length;
  var prices = current.map(function (r) { return r[C.preco]; }).filter(priceKnown).sort(function (a, b) { return a - b; });
  var price = prices.length
    ? money(prices[0]) + " – " + money(prices[prices.length - 1]) + " (" + t("inventory.price.sample", { n: num(prices.length) }) + ")"
    : t("inventory.price.none");
  var date = inventoryDate(all);
  var nav = [];
  if (current.length && anchors && anchors.current) nav.push('<a href="#' + esc(anchors.current) + '">' + esc(t("inventory.nav.current")) + '</a>');
  if (archived.length && anchors && anchors.archived) nav.push('<a href="#' + esc(anchors.archived) + '">' + esc(t("inventory.nav.archived")) + '</a>');
  return '<section class="mkt inventory-summary" data-inventory-summary aria-labelledby="inventory-summary-title">' +
    '<div class="sechead"><h2 id="inventory-summary-title">' + esc(t("inventory.title")) + '</h2><span class="n">' + esc(t("inventory.records", { n: num(all.length) })) + '</span></div>' +
    '<div class="facts">' +
      fact(t("inventory.current"), num(current.length)) +
      fact(t("inventory.archived"), num(archived.length)) +
      (unverified ? fact(t("inventory.unverified"), num(unverified)) : "") +
      fact(t("inventory.price"), price) +
    '</div>' +
    '<p class="foot inventory-meta">' + esc(date ? t(date.key, { date: date.date }) : t("inventory.date.unknown")) + " " + esc(t("inventory.note")) + "</p>" +
    (nav.length ? '<p class="foot inventory-nav">' + nav.join(" · ") + "</p>" : "") +
    '</section>';
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

/* The public home starts at São Paulo. Approximate network selection for the
 * flat home page lives in parts/geo.js; routes never infer or replace a city. */
function guessCity() {
  return DEFAULT_CITY;
}

/* Anchors, not buttons. Another city is another page, and a page is something
 * a reader can open in a new tab and a crawler can follow — a scripted button
 * is neither. */
function citySub(c) {
  return marketOnly(c)
    ? t("city.pick.sub.market", { lots: lots(c.stats.lots), deals: num(c.stats.paid_deals) })
    : t("city.pick.sub", { lots: lots(c.stats.lots), below: num(c.stats.below) });
}

function cityOrder(first) {
  return D.cities.slice().sort(function (a, b) {
    return (a.slug === first.slug ? -1 : b.slug === first.slug ? 1 : 0);
  });
}

/* The country verdict list is evidence-ranked, independently of the header
 * and current-city controls. Cities without a reliable sample stay in the
 * quiet coverage line below it. */
function homeMeasuredCityOrder() {
  return D.cities.filter(function (c) {
    return !marketOnly(c) && c.stats.reliable > 0;
  }).sort(function (a, b) {
    var shareA = a.stats.below / a.stats.reliable;
    var shareB = b.stats.below / b.stats.reliable;
    if (shareA !== shareB) return shareB - shareA;
    if (a.stats.reliable !== b.stats.reliable) return b.stats.reliable - a.stats.reliable;
    var nameA = String(a.nome || a.slug), nameB = String(b.nome || b.slug);
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;
    return a.slug === b.slug ? 0 : a.slug < b.slug ? -1 : 1;
  });
}

function cityList(kind) {
  return cityOrder(DEFAULT_CITY).map(function (c) {
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
  window.__CITIES__ = cityOrder(DEFAULT_CITY).map(function (c) {
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
function homeMap(main) {
  // The country page opens on the product, not on prose: every city we cover,
  // full width and first — a visitor must see in one glance what exists — and
  // the default city's own map beside them. The default is the biggest city;
  // its page is one tap away and the header menu switches to any other.
  if (city.slug !== main.slug) indexCity(main);
  var areas = allAreas().filter(function (a) { return city.shapes && city.shapes.d[a.key]; });
  var cells = areas.map(function (a) {
    return {
      key: a.key, share: a.share, rel: a.rel, go: href("/a/" + encodeURIComponent(a.key)),
      aria: t("city.area.aria", { name: areaName(a.key), lots: lots(a.n), below: a.below }),
    };
  });
  return cells.length ? '<div class="mapcard home-city-fragment" data-home-city="' + esc(main.slug) + '">' +
    '<div class="maphead"><span class="t">' + esc(main.nome) + " · " +
      t("city.map.tap", { n: cells.length, unit: plur("unit." + city.shapes.unit, cells.length) }) + "</span></div>" +
    drawMap(cells, { aria: t("map.aria.city", { city: main.nome }), box: frame(cells.map(function (c) { return c.key; })), pad: 0.07 }) +
    legend() + '<a class="cta" href="' + esc(cityBase(main)) + '">' +
      t("home.city.open", { city: esc(main.nome) }) + "</a></div>" : "";
}

function screenHome() {
  var n = national();
  var main = DEFAULT_CITY;
  var featured = homeMap(main);
  var measuredCities = homeMeasuredCityOrder();
  var quietCities = D.cities.filter(function (c) {
    return measuredCities.indexOf(c) === -1;
  });
  return '' +
    '<section class="hero home">' +
      '<p class="kicker"><i></i>' + t("brand.kicker") +
        b(t("brand.kicker.free")) + "</p>" +
      "<h1>" + t("home.h1", { br: '<span class="mark">' + t("home.br") + "</span>" }) + "</h1>" +
      '<p class="lede">' + t("home.lede") + "</p>" + inventoryNotice() +
    "</section>" +

    // Only cities with a measured verdict get a slot here: the page's promise
    // is the real discount, and a row answering "no estimate" to that promise
    // sells weakness. The market-only cities keep their pages and their place
    // in the header menu; on the front they are one quiet line, which is what
    // "we hold their deals but not their verdicts yet" actually merits.
    '<section class="sec"><div class="sechead"><h2>' + t("home.cities.h2") +
      '</h2><span class="n">' + t("home.cities.note") + "</span></div>" +
      '<div class="rowlist">' +
        measuredCities.map(cityRow).join("") +
      "</div>" +
      (quietCities.length
        ? '<p class="foot" style="margin-top:10px">' + t("home.more", {
            links: quietCities.map(function (c) {
              return '<a href="' + esc(cityBase(c)) + '">' + esc(c.nome) + "</a>";
            }).join(" · "),
          }) + "</p>"
        : "") +
    "</section>" +

    (featured ? '<div class="side"><div id="home-city-fragment">' + featured + '</div><p class="foot" id="geo-note" aria-live="polite"></p>' +

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

/* A map or an undated asking-price hint alone does not make an empty district
 * useful for indexing. Historical ITBI remains useful when year and sample
 * are present; its age does not turn it into an empty page. */
function hasAreaMarket(key) {
  var mk = city.market || {}, d = (mk.d || {})[key] || {};
  return /^\d{4}$/.test(String(mk.year || "")) && Number(mk.year) <= Number(dateReference.slice(0, 4)) &&
    [d.f, d.h, d.r].some(function (x) { return x && x[0] > 0 && x[1] > 0; });
}

function emptyAreaText(key) {
  var text = t("seo.area.empty") + " ";
  if ((historyByArea[key] || []).length) return text + t("archive.area.notice");
  return text + (hasAreaMarket(key)
    ? t("seo.area.history") : t("seo.area.nohistory"));
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
  var districtRoute = dk && slugToKey.rev[dk];
  var mk = city.market && city.market.d ? city.market.d[dk] : null;
  var lines = [];
  if (st.f) lines.push(streetLine("flat", st.f, mk && mk.f ? mk.f[0] : null));
  if (st.h) lines.push(streetLine("house", st.h, mk && mk.h ? mk.h[0] : null));
  var bairros = Array.isArray(st.bairros) ? st.bairros : [];
  return '' +
    '<div class="hero">' + back(districtRoute ? href("/a/" + encodeURIComponent(dk)) : cityBase(), districtRoute ? areaName(dk) : city.nome) +
      "<h1>" + esc(title(st.name)) + "</h1>" +
      '<p class="lede">' + (lines.length ? t("street.lede", {
        district: districtRoute ? link("/a/" + encodeURIComponent(dk), esc(areaName(dk))) : esc(city.nome),
        year: year,
      }) : t("street.catalog.lede")) + "</p></div>" +
    inventorySummary(lotsByStreet[code] || [], { current: "street-current-lots", archived: "street-archive-lots" }) +
    (lines.length ? '<section class="mkt"><div class="sechead"><h2>' + t("mkt.h2") +
      '</h2><span class="n">' + t("mkt.year", { year: year }) + "</span></div>" +
      lines.join("") +
      '<p class="foot">' + t("street.note") + "</p></section>" : "") +
    (bairros.filter(function (k) { return slugToKey.rev[k]; }).length > 1 ? '<p class="foot">' + t("street.spans", {
      list: bairros.filter(function (k) { return slugToKey.rev[k]; }).map(function (k) {
        return link("/a/" + encodeURIComponent(k), esc(areaName(k)));
      }).join(" · "),
    }) + "</p>" : "") +
    marketAvailabilityNote(lotsByStreet[code] || []) +
    streetLotLists(code) +
    footer();
}

/* A street statistic and its current inventory answer different questions.
 * The former comes from deeds; the latter is the published catalogue, split
 * so a removed offer is never presented as still available. */
function streetLotLists(code) {
  var rows = lotsByStreet[code] || [];
  var current = rows.filter(isCurrent), archived = rows.filter(function (r) { return !isCurrent(r); });
  function section(key, id, items) {
    if (!items.length) return "";
    return '<section id="' + id + '" class="sec street-lots" aria-labelledby="' + id + '-title"><div class="sechead"><h2 id="' + id + '-title">' +
      esc(t(key)) + '</h2><span class="n">' + esc(num(items.length)) +
      '</span></div><div class="rowlist">' + items.map(lotRow).join("") + "</div></section>";
  }
  return section("street.lots.current", "street-current-lots", current) + section("street.lots.archive", "street-archive-lots", archived);
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
  var rows = sts.by[key].filter(function (code) {
    var st = sts.d[code];
    return st && (st.f || st.h);
  }).map(function (code) {
    var st = sts.d[code];
    var main = st.f || st.h;
    return '<a class="row" href="' + href("/r/" + encodeURIComponent(code)) + '">' +
      '<div class="r1"><span class="nm">' + esc(title(st.name)) + "</span>" +
        '<span class="pill mute">' + money(main[0]) + "/" + t("unit.m2") + "</span></div>" +
      '<div class="sub">' + t("mkt.deals", { n: num((st.f ? st.f[1] : 0) + (st.h ? st.h[1] : 0)) }) +
      "</div></a>";
  });
  if (!rows.length) return "";
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
    currentRows(c).forEach(function (r) { if (reliable(r)) rel.push(r); });
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
  var top = currentRows().filter(reliable).slice(0, 3);

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
      inventoryNotice() + marketAvailabilityNote(city.rows) + '<p class="foot">' + link("/archive", esc(t("archive.nav"))) + '</p>' +
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
        ? esc(emptyAreaText(key)) + " " + link("/all", t("area.nolots.cta"))
        : a.rel
          ? t("area.lede", { lots: lots(a.n), rel: a.rel, below: b(a.below) })
          : t(marketOnly() ? "area.lede.market" : "area.lede.nodata",
              { lots: lots(a.n) })) + "</p></div>" + mini +
    inventorySummary((byArea[key] || []).concat(historyByArea[key] || []), { current: "area-current-lots", archived: "area-archive-lots" }) +
    inventoryNotice() + marketAvailabilityNote(byArea[key] || []) + marketCard(key) + upkeepCard(key) + streetList(key) +
    (a.n ? '<section id="area-current-lots" class="sec" aria-labelledby="area-current-lots-title"><div class="sechead"><h2 id="area-current-lots-title">' + esc(t("area.lots.current")) + '</h2><span class="n">' + esc(num(a.n)) + '</span></div><div class="rowlist">' +
      a.rows.slice().sort(function (x, y) {
        var rx = reliable(x), ry = reliable(y);
        if (rx !== ry) return rx ? -1 : 1;
        return rx ? y[C.margin] - x[C.margin] : 0;
      // No cap. This is the only page that lists a district in full, and a lot
      // that is on no page is a lot that does not exist.
      }).map(lotRow).join("") + "</div></section>" : "") +
    ((historyByArea[key] || []).length ? '<section id="area-archive-lots" class="sec" aria-labelledby="area-archive-lots-title"><h2 id="area-archive-lots-title">' + esc(t("archive.nav")) + '</h2>' +
      '<p>' + esc(t("archive.area.notice")) + '</p><div class="rowlist">' +
      historyByArea[key].slice(0, ALL_PAGE_SIZE).map(lotRow).join("") + '</div><p class="foot">' +
      link("/archive", esc(t("archive.all", { n: num(historyByArea[key].length) }))) + '</p></section>' : '') +
    footer();
}

function heroFinance(r, vd) {
  var own = reliable(r);
  var context = r[C.promised] != null ? pct(-Math.abs(r[C.promised]), false) : vd ? t(vd[2]) : "—";
  var facts = [
    [t("lot.price.open"), r[C.preco] ? money(r[C.preco]) : "—"],
    [t("lot.price.aval"), r[C.aval] ? money(r[C.aval]) : "—"],
    [t("lot.price.hammer"), own && r[C.hammer] ? money(r[C.hammer]) : "—"],
    [t("lot.hero.context"), context],
  ];
  return '<dl class="hero-finance">' + facts.map(function (item) {
    return '<div><dt>' + esc(item[0]) + '</dt><dd>' + esc(item[1]) + '</dd></div>';
  }).join("") + "</dl>";
}

/* ITBI is a district-level record of completed deeds, not a price for this
 * individual lot. Keep that evidence separate from both the auction facts and
 * the listing-based market report, and omit it entirely when the district has
 * no verified register sample. */
function lotTransactionSummary(r) {
  var key = areaOf(r), mk = city.market || {}, district = key && mk.d ? mk.d[key] : null;
  if (!district || !/^\d{4}$/.test(String(mk.year || ""))) return "";
  var type = String(r[C.tipo] || "").toLowerCase();
  var kind = /casa|sobrado|terreno/.test(type) ? "h" : /apart|flat/.test(type) ? "f" : "r";
  var kindLabel = kind === "h" ? "house" : kind === "f" ? "flat" : "res";
  var value = district[kind] || district.r || district.f || district.h;
  if (!Array.isArray(value) || value.length < 2 || !priceKnown(value[0]) || !value[1]) return "";
  return '<aside class="hero-transactions" aria-label="' + esc(t("mkt.h2")) + '"><span>' +
    esc(t("mkt.h2")) + '</span><b>' + esc(money(value[0])) + " " + esc(t("mkt.per")) +
    '</b><small>' + esc(areaName(key)) + " · " + esc(t("mkt.kind." + kindLabel)) + " · " +
    esc(t("mkt.deals", { n: num(value[1]) })) + " · " +
    esc(t("mkt.year", { year: mk.year })) + "</small></aside>";
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

/* Search snippets use only fields carried by the source row. The stable
 * reference makes two units at the same address distinguishable; the facts
 * make the description useful without claiming an estimate exists. */
function lotMetaSubject(r) {
  var bits = [title(r[C.tipo] || t("lot.fallback"))];
  if (priceKnown(r[C.area]) && r[C.area] > 0) bits.push(r[C.area] + " " + t("unit.m2"));
  return metaText(bits.join(" · "), 52);
}
function lotMetaFacts(r) {
  var facts = [];
  if (priceKnown(r[C.preco])) facts.push(t("lot.price.open") + ": " + money(r[C.preco]));
  if (priceKnown(r[C.aval])) facts.push(t("lot.price.aval") + ": " + money(r[C.aval]));
  var day = auctionDate(r);
  if (day) facts.push(t("seo.auction.date", { date: day }));
  return facts.join(" · ") || lotMetaSubject(r);
}

/* Related lots use only rows already published in this page's payload. A
 * street is usable only when it has a street page, so partial or misspelled
 * addresses cannot manufacture dead links. Tiers describe place, not distance:
 * the dataset does not publish a distance between these records. */
function streetCodeForLot(r) {
  var id = String(r[C.id]);
  if (Object.prototype.hasOwnProperty.call(streetCodeByLotId, id)) return streetCodeByLotId[id];
  if (!r[C.end] || !city.streets || !city.streets.d) return null;
  var codes = Object.keys(city.streets.d).filter(publishedStreetCode).sort(function (a, b) {
    return String(city.streets.d[b].name || "").length - String(city.streets.d[a].name || "").length;
  });
  return matchedStreetCode(r[C.end], codes);
}

function relatedPlace(r) {
  var id = String(r[C.id]);
  if (relatedPlaceCache[id]) return relatedPlaceCache[id];
  var area = areaOf(r), street = streetCodeForLot(r);
  return relatedPlaceCache[id] = { area: area || normKey(r[C.bairro]), street: street };
}

function relatedRelationship(tier) {
  return t(tier === 0 ? "related.street" : tier === 1 ? "related.area" : "related.city");
}

function relatedTrail(place) {
  var bits = ['<a href="' + esc(cityBase()) + '">' + esc(city.nome) + "</a>"];
  if (place.area && slugToKey.rev[place.area]) {
    bits.push('<a href="' + esc(href("/a/" + encodeURIComponent(place.area))) + '">' +
      esc(areaName(place.area)) + "</a>");
  }
  if (place.street && city.streets && city.streets.d[place.street]) {
    var st = city.streets.d[place.street];
    if (streetBySlug[st.slug]) bits.push('<a href="' + esc(href("/r/" + encodeURIComponent(place.street))) + '">' +
      esc(title(st.name)) + "</a>");
  }
  return bits.join(" · ");
}

function relatedPrice(r) {
  var value = isCurrent(r) ? r[C.preco] : lastAdvertisedPrice(r);
  return priceKnown(value) ? money(value) : "";
}

var RELATED_LOT_LIMIT = 6;
var relatedLotCache = {}, relatedPlaceCache = {}, relatedCandidates = {};
var relatedGroups = { street: {}, area: {}, city: [] };
function relatedOrder(a, b) {
  return (isCurrent(a) ? 0 : 1) - (isCurrent(b) ? 0 : 1) ||
    String(a[C.id]).localeCompare(String(b[C.id]));
}
function buildRelatedGroups() {
  var groups = { street: {}, area: {}, city: lotsByCity.slice().sort(relatedOrder) };
  Object.keys(lotsByStreet).forEach(function (key) {
    groups.street[key] = lotsByStreet[key].slice();
  });
  Object.keys(lotsByArea).forEach(function (key) {
    groups.area[key] = lotsByArea[key].slice();
  });
  Object.keys(groups.street).forEach(function (key) { groups.street[key].sort(relatedOrder); });
  Object.keys(groups.area).forEach(function (key) { groups.area[key].sort(relatedOrder); });
  relatedGroups = groups;

  /* Materialize the original stage order once. The old renderer walked the
   * whole city for every lot and relied on add() to stop after six rows. Keep
   * that exact de-duplication behavior, but do the walk during city indexing. */
  relatedCandidates = {};
  lotsByCity.forEach(function (origin) {
    var originId = String(origin[C.id]), place = relatedPlace(origin), rows = [], seen = {};
    var add = function (candidate, tier) {
      var id = String(candidate[C.id]);
      if (id === originId || seen[id] || rows.length >= RELATED_LOT_LIMIT) return;
      seen[id] = true;
      rows.push({ row: candidate, place: relatedPlace(candidate), tier: tier });
    };
    var addGroup = function (group, tier) {
      for (var i = 0; i < group.length && rows.length < RELATED_LOT_LIMIT; i++) add(group[i], tier);
    };
    addGroup(place.street ? groups.street[place.street] || [] : [], 0);
    addGroup(place.area ? groups.area[place.area] || [] : [], 1);
    addGroup(groups.city, 2);
    relatedCandidates[originId] = rows;
  });
}
function relatedLots(r) {
  var rows = relatedCandidates[String(r[C.id])] || [];
  var place = relatedPlace(r);
  if (!rows.length) {
    /* If the exact street is known, its empty state owns the explanation and
     * the link to the street catalogue. Otherwise a valid district route is
     * still useful navigation even when this is the only lot there. */
    if (place.street || !place.area || !slugToKey.rev[place.area]) return "";
    return '<section class="sec related-lots" aria-labelledby="related-lots-title">' +
      '<div class="sechead"><h2 id="related-lots-title">' + esc(t("related.title")) + '</h2></div>' +
      '<p class="related-empty">' + esc(t("related.empty", { area: areaName(place.area) })) + "</p></section>";
  }
  return '<section class="sec related-lots" aria-labelledby="related-lots-title">' +
    '<div class="sechead"><h2 id="related-lots-title">' + esc(t("related.title")) + '</h2></div>' +
    '<div class="rowlist">' + rows.map(function (item) {
      var candidate = item.row, historical = !isCurrent(candidate), price = relatedPrice(candidate);
      var facts = [item.tier === 0 && item.place.street && city.streets.d[item.place.street]
        ? title(city.streets.d[item.place.street].name) : null,
        item.place.area && slugToKey.rev[item.place.area] ? areaName(item.place.area) : null,
        price ? price : null, candidate[C.area] ? candidate[C.area] + " " + t("unit.m2") : null]
        .filter(Boolean).filter(function (value, index, all) { return all.indexOf(value) === index; });
      return '<a class="row related-lot" href="' + esc(href("/l/" + encodeURIComponent(candidate[C.id]))) + '">' +
        '<div class="r1"><div class="nm">' + esc(title(candidate[C.end] || candidate[C.tipo] || t("lot.fallback"))) +
          '</div><span class="pill ' + (historical ? "mute" : "good") + '">' +
          esc(t(historical ? "related.archive" : "related.current")) + "</span></div>" +
        '<div class="sub">' + esc(candidate[C.tipo] || t("lot.fallback")) + " · " +
          esc(relatedRelationship(item.tier)) + "</div>" +
        (facts.length ? '<div class="sub related-facts">' + esc(facts.join(" · ")) + "</div>" : "") +
        '<div class="related-trail" aria-label="' + esc(t("lot.breadcrumb")) + '">' + relatedTrail(item.place) + "</div>" +
      "</a>";
    }).join("") + "</div></section>";
}

/* A reader who has arrived on a property page most often wants the other
 * auctions at this exact address level, not a generic "nearby" list.  Keep
 * that answer short; the street page remains the route to the full catalogue.
 * `streetCodeForLot` only returns a certain match with a real street route.
 */
var SAME_STREET_LOT_LIMIT = 4;
function sameStreetLots(r) {
  var code = streetCodeForLot(r);
  if (!code || !publishedStreetCode(code)) return "";
  var rows = (relatedGroups.street[code] || []).filter(function (candidate) {
    return String(candidate[C.id]) !== String(r[C.id]);
  }).slice(0, SAME_STREET_LOT_LIMIT);
  var street = city.streets.d[code];
  return '<section class="sec same-street-lots" aria-labelledby="same-street-lots-title">' +
    '<div class="sechead"><h2 id="same-street-lots-title">' + esc(t("same.street.title")) +
      '</h2><a class="same-street-all" href="' + esc(href("/r/" + encodeURIComponent(code))) + '">' +
      esc(t("same.street.all", { street: title(street.name), count: num((lotsByStreet[code] || []).length) })) +
      '</a></div>' + (rows.length ? '<div class="rowlist">' + rows.map(function (candidate) {
        var historical = !isCurrent(candidate), price = relatedPrice(candidate);
        var facts = [price, candidate[C.area] ? candidate[C.area] + " " + t("unit.m2") : null].filter(Boolean);
        return '<a class="row same-street-lot" href="' + esc(href("/l/" + encodeURIComponent(candidate[C.id]))) + '">' +
          '<div class="r1"><div class="nm">' + esc(title(candidate[C.end] || candidate[C.tipo] || t("lot.fallback"))) +
            '</div><span class="pill ' + (historical ? "mute" : "good") + '">' +
            esc(t(historical ? "related.archive" : "related.current")) + '</span></div>' +
          (facts.length ? '<div class="sub related-facts">' + esc(facts.join(" · ")) + '</div>' : "") +
        '</a>';
      }).join("") + '</div>' : '<p class="related-empty">' + esc(t("same.street.empty")) + '</p>') + '</section>';
}

/* `i` arrives free from every call site's .map(lotRow). It decides one thing:
 * whether this row's photo waits. Deferring the picture the reader is already
 * looking at is the classic own-goal of lazy loading — it delays the largest
 * paint instead of saving anything — so the two rows that open above the fold
 * on a phone stay eager and everything below them waits. */
function lotRow(r, i) {
  var historical = !isCurrent(r);
  var vd = historical ? null : verdict(r);
  var ph = photo(r);
  var eager = !i || i < 2;
  return '<a class="row lot" href="' + href("/l/" + encodeURIComponent(r[C.id])) + '">' +
    // A real <img>, not a background-image: only an element the browser knows
    // is an image can be deferred. A district list is up to two hundred lots,
    // and every one of them was fetching a full-size photo from Caixa before
    // the reader had scrolled — ten megabytes to read one page. The intrinsic
    // size is stated so the row does not jump when the picture lands.
    '<div class="ph">' + (ph
      ? '<img src="' + esc(ph) + '" alt="" decoding="async" width="82" height="82"' +
        (eager ? "" : ' loading="lazy"') + ' onerror="this.remove()">'
      : "<span>" + t("lot.nophoto") + "</span>") + "</div>" +
    '<div class="body">' +
      '<div class="r1"><div class="ttl">' + lotLine(r) + "</div>" +
        '<span class="pill ' + (vd ? vd[1] : "mute") + '">' +
          (historical ? esc(t(STATUS_KEY[lotStatus(r)])) : vd ? pct(r[C.margin]) : "?") + "</span></div>" +
      '<div class="meta">' + esc(title(r[C.end] || r[C.bairro] || "")) + "</div>" +
      '<div class="meta">' + esc(historical ? t("archive.removal.notice") : t(STATUS_KEY[lotStatus(r)]) + '. ' + auctionNote(r)) + "</div>" +
      // One line, not two columns: on a phone the two labelled prices sat in
      // 70px each and broke "R$ 33 635" across lines.
      '<div class="nums"><div class="k">' +
        t(historical ? "archive.price.last" : vd ? "lot.nums.both" : "lot.nums.open") + "</div>" +
        '<div class="v">' + (historical ? priceText(lastAdvertisedPrice(r)) : money(r[C.preco])) +
        (vd ? " <em>→</em> " + b(money(r[C.hammer])) : "") +
        "</div></div>" +
    "</div></a>";
}

/* "apartamento-64m2-penha-circular-0e2af7f775f1e45c" -> the id at the end.
   Falls through unchanged for a bare id, so both forms resolve. */
function idFromSlug(sl) {
  if (lotBySlug[sl]) return String(lotBySlug[sl][C.id]);
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
  data_changed: "why.data_changed",
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
  /* A lot with a validated market-v1 report already has a separate asking
   * range below. Do not place the older district-average hint beside it: that
   * would make two different samples look like one estimate. */
  if (marketReportFor(r[C.id])) return "";
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

/* Market reports are a separate, already-validated public payload. The AI
 * placeholder below remains owned by analyze.js; this renderer only adds the
 * synchronous human-readable market facts when the build embedded one. */
function marketReportFor(id) {
  var reports = D && D.market_reports;
  return reports && typeof reports === "object" ? reports[String(id)] : null;
}

function marketHeroSummary(id) {
  var report = marketReportFor(id);
  var asking = report && report.sale_asking;
  var sample = report && report.sample;
  if (!asking || !sample || !Number.isFinite(asking.min) || !Number.isFinite(asking.max) ||
      !Number.isInteger(sample.count) || sample.count < 5) return "";
  var confidence = "market.confidence." + String(sample.confidence || "low");
  return '<aside class="hero-market" aria-label="' + esc(t("market.sale_asking")) + '"><span>' +
    esc(t("market.sale_asking")) + '</span><b>' + esc(money(asking.min)) + " – " + esc(money(asking.max)) +
    '</b><small>' + esc(t("market.sample", { count: sample.count })) + " · " +
    esc(t("market.radius", { radius: sample.radius_m })) + " · " +
    esc(t("market.freshness", { days: sample.freshness_days })) + " · " +
    esc(t("market.confidence", { level: t(confidence) })) + '</small><p class="hero-market-note">' +
    esc(t("market.disclaimer.truth")) + "</p></aside>";
}

function marketReportBlock(id) {
  var report = marketReportFor(id);
  if (!report ||
      !window.MARKET || typeof window.MARKET.renderReport !== "function" ||
      typeof document === "undefined") return "";
  var rendered = window.MARKET.renderReport(report, document);
  return rendered && typeof rendered.outerHTML === "string" ? rendered.outerHTML : "";
}

/* A count of qualified lot reports is useful navigation context.  It is not
 * an area/street valuation and never combines individual price ranges. */
function marketAvailabilityCount(rows) {
  var reports = D && D.market_reports;
  if (!reports || typeof reports !== "object" || !Array.isArray(rows)) return 0;
  var seen = {}, count = 0;
  rows.forEach(function (row) {
    var id = String(row && row[C.id]);
    if (!seen[id] && Object.prototype.hasOwnProperty.call(reports, id)) {
      seen[id] = true;
      count++;
    }
  });
  return count;
}

function marketAvailabilityNote(rows) {
  var count = marketAvailabilityCount(rows);
  return count ? '<p class="foot market-availability">' +
    esc(t("market.availability", { count: num(count) })) + "</p>" : "";
}

function lotBreadcrumb(r) {
  var place = relatedPlace(r), bits = ['<a href="' + esc(cityBase()) + '">' + esc(city.nome) + "</a>"];
  if (place.area && slugToKey.rev[place.area]) {
    bits.push('<a href="' + esc(href("/a/" + encodeURIComponent(place.area))) + '">' +
      esc(areaName(place.area)) + "</a>");
  }
  if (place.street && city.streets && city.streets.d[place.street] && streetBySlug[city.streets.d[place.street].slug]) {
    bits.push('<a href="' + esc(href("/r/" + encodeURIComponent(place.street))) + '">' +
      esc(title(city.streets.d[place.street].name)) + "</a>");
  }
  return '<nav class="lot-breadcrumb" aria-label="' + esc(t("lot.breadcrumb")) + '">' + bits.join(" · ") + "</nav>";
}

/* Generated lot pages render the configured public Embed key directly into the
 * prerendered map iframe. The ordinary Maps link remains available when no key
 * is configured; the static app runtime never revisits this block. */
function lotMapQuery(r) {
  var address = String(r[C.end] || "").replace(/\s+/g, " ").trim();
  if (!address) return "";
  return [address, city.nome, city.uf ? String(city.uf).toUpperCase() : "", "Brasil"]
    .filter(Boolean).join(", ");
}
function mapsEmbedKey() {
  var value = window.__MAPS__ && window.__MAPS__.embedKey;
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : "";
}
function lotMapsLink(r) {
  var query = lotMapQuery(r);
  if (!query) return "";
  return '<a class="maps-link" href="https://www.google.com/maps/search/?api=1&amp;query=' +
    esc(encodeURIComponent(query)) + '" target="_blank" rel="noopener noreferrer">' +
    esc(t("lot.maps")) + "</a>";
}
function lotMapsBlock(r) {
  var query = lotMapQuery(r);
  if (!query) return "";
  var key = mapsEmbedKey();
  var iframe = key ? '<div class="lot-map-frame"><iframe src="https://www.google.com/maps/embed/v1/place?key=' +
    esc(encodeURIComponent(key)) + '&amp;q=' + esc(encodeURIComponent(query)) + '" title="' +
    esc(t("lot.maps.embed.title")) + '" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>' : "";
  return '<section class="lot-map">' +
    '<h2>' + esc(t("lot.maps.heading")) + '</h2><div class="lot-map-actions">' +
    lotMapsLink(r) + '</div>' + iframe + '</section>';
}

function screenLot(id) {
  var r = null;
  for (var i = 0; i < city.rows.length; i++) {
    if (String(city.rows[i][C.id]) === String(id)) { r = city.rows[i]; break; }
  }
  if (!r) return null;
  if (!isCurrent(r)) return screenHistoricalLot(r);
  var vd = verdict(r);
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

  return '<div class="lot-above"><div class="lot-intro">' +
    // A lot with no district of its own steps back to the city instead.
    '<div class="hero">' + (key
      ? back(href("/a/" + encodeURIComponent(key)), areaName(key))
      : back(href(), city.nome)) +
      '<h1><span class="lot-title" title="' + esc(title(r[C.end] || r[C.tipo] || t("lot.fallback"))) + '">' + esc(title(r[C.end] || r[C.tipo] || t("lot.fallback"))) + "</span></h1>" +
      '<p class="lede">' + lotLine(r) + " · " +
        esc(title(r[C.bairro] || (key ? areaName(key) : city.nome))) + "</p>" +
      lotReferenceLine(r) +
      lotBreadcrumb(r) +
      '<div class="lot-statuses"><span class="status-chip source">' + esc(title(r[C.src] || "fonte")) +
        "</span>" + lifecycleBanner(r, true) + "</div>" +
      '<p class="note">' + esc(auctionNote(r)) + "</p></div>" +
    heroFinance(r, vd) +
    marketHeroSummary(r[C.id]) +
    lotTransactionSummary(r) +
    '<div class="hero-actions">' +
      (r[C.src] === "caixa" ? '<button type="button" class="analysis-cta" data-analysis-cta>' +
        esc(t("lot.ai.cta", null, "Analyze with AI")) + "</button>" : "") +
      (r[C.link] ? '<a class="source-link" href="' + esc(r[C.link]) +
        '" target="_blank" rel="noopener" data-out="' + esc(r[C.src] || "lot") + '">' +
        esc(t("lot.cta")) + "</a>" : "") +
    "</div>" +
    "</div>" +

    // On a phone the image belongs immediately after the decision summary;
    // desktop CSS moves this same node into the right-hand hero column.
    lotGallery(r) +
    lotMapsBlock(r) +

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
            '<span class="dot ' + p.cls + '"></span></div>';
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
    "</div>" +
    "</div>" +

    '<div class="lot-wide">' +
      '<section class="mkt" data-lot-report="' + esc(r[C.id]) + '"></section>' +
      marketReportBlock(r[C.id]) +

      // Caixa publishes an edital PDF for every sale; the worker only trusts
      // Caixa's own domains, so the reader pastes that link and gets the
      // dossiê free. Other sources' documents live behind auctioneers' sites
      // the allowlist does not know — no box rather than a box that fails.
      (r[C.src] === "caixa"
        ? '<section class="mkt azbox" data-az="' + esc(r[C.id]) + '" data-az-source="' +
          esc(r[C.link] || "") + '"></section>' : "") +
    "</div>" + lotHistory(r) + sameStreetLots(r) + relatedLots(r) + footer();
}

function fact(k, val) {
  return '<div class="fact"><span class="k">' + esc(k) + '</span><span class="v">' +
    esc(val) + "</span></div>";
}

var ALL_PAGE_SIZE = 200;
function allPageCount() { return Math.max(1, Math.ceil(currentRows().length / ALL_PAGE_SIZE)); }
function allPageHref(page) {
  return href("/all") + (page > 1 ? "pagina/" + page + "/" : "");
}
function allPageNumber(path) {
  if (path === allPageHref(1)) return 1;
  var match = /\/todos-os-lotes\/pagina\/([1-9][0-9]*)\/$/.exec(path);
  var n = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(n) && n >= 2 && n <= allPageCount() && path === allPageHref(n) ? n : 0;
}
function pageLabel(page) { return t("seo.page", { page: page }); }
function allPagination(page) {
  var count = allPageCount();
  if (count < 2) return "";
  return '<nav class="foot" aria-label="' + esc(t("seo.pagination")) + '">' +
    (page > 1 ? '<a rel="prev" href="' + allPageHref(page - 1) + '">' +
      esc(t("seo.previous")) + "</a> · " : "") +
    '<span aria-current="page">' + esc(pageLabel(page)) + " / " + count + "</span>" +
    (page < count ? ' · <a rel="next" href="' + allPageHref(page + 1) + '">' +
      esc(t("seo.next")) + "</a>" : "") + "</nav>";
}

function screenAll(page) {
  page = page == null ? 1 : page;
  if (!Number.isSafeInteger(page) || page < 1 || page > allPageCount()) return null;
  var mo = marketOnly();
  return '<div class="hero">' + back(href(), city.nome) +
    "<h1>" + t(mo ? "all.h1.market" : "all.h1") +
      (page > 1 ? " · " + esc(pageLabel(page)) : "") + "</h1>" +
    '<p class="lede">' + t(mo ? "all.lede.market" : "all.lede") + "</p>" + inventoryNotice() +
    '<p class="foot">' + link("/archive", esc(t("archive.nav"))) + '</p></div>' +
    allPagination(page) +
    '<section class="sec"><div class="rowlist">' +
    currentRows().sort(function (x, y) {
      return mo ? x[C.preco] - y[C.preco] : (y[C.margin] || 0) - (x[C.margin] || 0);
    }).slice((page - 1) * ALL_PAGE_SIZE, page * ALL_PAGE_SIZE).map(lotRow).join("") +
    "</div></section>" + allPagination(page) + footer();
}

function archivePageCount() { return Math.max(1, Math.ceil(archiveRows().length / ALL_PAGE_SIZE)); }
function archivePageHref(page) { return href("/archive") + (page > 1 ? "pagina/" + page + "/" : ""); }
function archivePageNumber(path) {
  if (path === archivePageHref(1)) return 1;
  var match = /\/arquivo\/pagina\/([1-9][0-9]*)\/$/.exec(path);
  var n = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(n) && n >= 2 && n <= archivePageCount() && path === archivePageHref(n) ? n : 0;
}
function archivePagination(page) {
  var count = archivePageCount();
  if (count < 2) return "";
  return '<nav class="foot" aria-label="' + esc(t("seo.pagination")) + '">' +
    (page > 1 ? '<a rel="prev" href="' + archivePageHref(page - 1) + '">' + esc(t("seo.previous")) + '</a> · ' : '') +
    '<span aria-current="page">' + esc(pageLabel(page)) + ' / ' + count + '</span>' +
    (page < count ? ' · <a rel="next" href="' + archivePageHref(page + 1) + '">' + esc(t("seo.next")) + '</a>' : '') + '</nav>';
}
function screenArchive(page) {
  page = page == null ? 1 : page;
  if (!Number.isSafeInteger(page) || page < 1 || page > archivePageCount()) return null;
  var rows = archiveRows();
  return '<div class="hero">' + back(href("/all"), t("archive.current")) +
    '<h1>' + esc(t("archive.h1", { city: city.nome })) + (page > 1 ? ' · ' + esc(pageLabel(page)) : '') + '</h1>' +
    '<p class="lede">' + esc(t("archive.lede", { n: num(rows.length) })) + '</p></div>' + archivePagination(page) +
    '<section class="sec"><div class="rowlist">' + rows.slice((page - 1) * ALL_PAGE_SIZE, page * ALL_PAGE_SIZE).map(lotRow).join("") +
    '</div>' + (!rows.length ? '<p>' + esc(t("archive.empty")) + '</p>' : '') + '</section>' + archivePagination(page) + footer();
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
    link("/all", t("nav.all")) + " · " + link("/archive", esc(t("archive.nav"))) + " · " + link("/honest", t("nav.honest")) + "<br>" +
    footNote() + "</p>" + langbar();
}

/* What the data is, and what we count. The second half is short on purpose:
 * a site that measures its readers without cookies can say so in one line
 * instead of sending them to a policy nobody opens. */
function footNote() {
  var stamp = D.generated
    ? t("seo.dataset.date", { date: D.generated }) + " "
    : t("seo.dataset.unknown") + " ";
  return esc(stamp + t("seo.dataset.notice")) + " " + t("foot.privacy") +
    ' <a href="' + (window.__BASE__ || "") + '/privacidade/">' + esc(t("az.queue.privacy")) + '</a>';
}

/* Down here on purpose. The runtime already picks the visitor's language from
   the browser, so this is a correction and not a first move; the header on a
   390px phone has no room for a third control. Each language is a real link to
   a real URL, so it survives a page with no JS. */
function langbar() {
  // What the *shipped page* will carry, not what this build tab happens to
  // hold. The pre-render renders every page in a shell loaded with all three
  // catalogues but writes only one of them into the file, so reading
  // LANG.langs here baked a three-way switcher into 9 318 pages where two of
  // the three links changed nothing: ?lang=ru on a flat page finds no Russian
  // catalogue and re-renders in Portuguese. Dead controls, and an hreflang
  // pointing at a URL that is not in that language, which Search Console
  // reports as an error.
  var all = window.__SHIP_LANGS__ || LANG.langs;
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
var SEG = { all: "todos-os-lotes", archive: "arquivo", honest: "como-calculamos", lot: "lote", rua: "rua" };

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
  var stable = lifecycle(r).slug;
  if (typeof stable === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stable)) return stable;
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
  if (p === "/archive") return base + SEG.archive + "/";
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
  if (p[0] === ROOT.replace(/^\//, "")) {
    p = p.slice(1);
    if (!p.length) return null; // No catalogue or UF-only landing pages exist.
  }

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
  if (p[0] === SEG.archive) {
    var archivePage = archivePageNumber(path);
    return archivePage ? screenArchive(archivePage) : null;
  }
  if (p[0] === SEG.all) {
    var page = allPageNumber(path);
    return page ? screenAll(page) : null;
  }
  if (p.length === 1 && p[0] === SEG.honest) return screenHonest();
  if (p.length === 2 && p[0] === SEG.lot) {
    var lot = lotById[idFromSlug(decodeURIComponent(p[1]))];
    return lot && lotSlug(lot) === p[1] ? screenLot(lot[C.id]) : null;
  }
  if (p.length === 2 && p[0] === SEG.rua) {
    var sc = streetBySlug[decodeURIComponent(p[1] || "")];
    return sc ? screenStreet(sc) : null;
  }
  var key = slugToKey.fwd[p[0]];
  return p.length === 1 && key ? screenArea(key) : null;
}

function pageTrail(path) {
  if (!atCity || path === "/404") return [];
  var trail = [{ path: "/", name: t("seo.brazil") },
    { path: cityBase(), name: city.nome }];
  if (path === cityBase()) return trail;
  var archivedPage = archivePageNumber(path);
  if (archivedPage) {
    if (archivedPage > 1) trail.push({ path: archivePageHref(1), name: t("archive.nav") });
    trail.push({ path: path, name: archivedPage > 1 ? pageLabel(archivedPage) : t("archive.nav") });
    return trail;
  }
  var page = allPageNumber(path);
  if (page > 1) {
    trail.push({ path: allPageHref(1), name: t("nav.all") });
    trail.push({ path: path, name: pageLabel(page) });
    return trail;
  }
  var parts = path.split("/").filter(Boolean), last = parts[parts.length - 1];
  var key = null, name = "";
  if (parts[parts.length - 2] === SEG.lot) {
    var r = lotById[idFromSlug(last)];
    if (!r) return [];
    key = areaOf(r);
    name = title(r[C.end] || r[C.tipo] || t("lot.fallback"));
    var lotStreet = streetCodeForLot(r);
  } else if (parts[parts.length - 2] === SEG.rua) {
    var st = city.streets.d[streetBySlug[last]];
    if (!st) return [];
    key = st.bairro;
    name = title(st.name);
  } else if (slugToKey.fwd[last]) {
    name = areaName(slugToKey.fwd[last]);
  } else {
    name = t(last === SEG.all ? "nav.all" : "nav.honest");
  }
  if (key && slugToKey.rev[key]) {
    trail.push({ path: href("/a/" + encodeURIComponent(key)), name: areaName(key) });
  }
  if (lotStreet && city.streets && city.streets.d[lotStreet]) {
    var lotSt = city.streets.d[lotStreet];
    if (streetBySlug[lotSt.slug]) {
      trail.push({ path: href("/r/" + encodeURIComponent(lotStreet)), name: title(lotSt.name) });
    }
  }
  trail.push({ path: path, name: name });
  return trail;
}

/* A sitemap date may describe only the exact lot whose lifecycle evidence
 * carries it. Scope observations cannot date city/list pages because a
 * partial source does not prove anything about lots it did not return. */
function lotLastmod(path) {
  var parts = String(path || "").split("/").filter(Boolean);
  if (parts.length < 2 || parts[parts.length - 2] !== SEG.lot) return null;
  var r = lotById[idFromSlug(parts[parts.length - 1])];
  if (!r || lotSlug(r) !== parts[parts.length - 1]) return null;
  var lc = lifecycle(r), dates = [];
  function remember(value) {
    var valid = archiveDate(value), day = valid && valid.slice(0, 10);
    if (day && day <= dateReference) dates.push(day);
  }
  [lc.first_seen_at, lc.last_seen_at, lc.last_checked_at, lc.missing_since,
    lc.archived_at].forEach(remember);
  if (lc.outcome) remember(lc.outcome.observed_at);
  (Array.isArray(lc.history) ? lc.history : []).forEach(function (event) {
    if (event) remember(event.observed_at);
  });
  dates.sort();
  return dates.length ? dates[dates.length - 1] : null;
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
    split: pageUsesSideColumn(path, html),
    lot: isLotRoute(path),
    head: headFor(path),
    breadcrumbs: pageTrail(path),
    lastmod: lotLastmod(path),
    links: links,
  };
};

function isLotRoute(path) {
  var parts = String(path || "/").split("/").filter(Boolean);
  return parts.length >= 2 && parts[parts.length - 2] === SEG.lot;
}

/* A lot gallery contains an image with class `shot`, but it is content, not a
 * sidebar.  The former broad selector saw that nested image and created a
 * second desktop grid column with nothing in it.  Only screens that explicitly
 * emit `.side` may use the split layout; lot pages keep the available width.
 */
function pageUsesSideColumn(path, html) {
  return !isLotRoute(path) && /class="side(?:\s|")/.test(String(html || ""));
}

window.__homeCityFragment__ = function (slug) {
  var chosen = D.cities.filter(function (c) { return c.slug === slug; })[0];
  if (!chosen) return null;
  var before = city;
  var html = homeMap(chosen);
  indexCity(before);
  return html;
};

/* What the head of this page should say. Kept next to the screens so a new
 * screen cannot quietly ship with the site-wide title. */
function cityPrep() { return t("city.prep." + city.slug, null, t("city.prep")); }

function headFor(path) {
  var p = String(path || "/").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  var last = p[p.length - 1] || "";
  var base = { title: t("meta.title"), desc: t("meta.desc"), canonical: path };
  if (p.length === 1 && p[0] === "404") {
    return { title: t("head.nf.title"), desc: t("nf.p"), canonical: path, noindex: true };
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
    base.desc = main ? t("head.street.desc", {
      street: title(stx.name), district: areaName(stx.bairro),
      year: city.streets.year, value: money(main[0]), n: num(main[1]),
    }) : t("head.street.catalog.desc", {
      street: title(stx.name), city: name, lots: lots((lotsByStreet[streetBySlug[last]] || []).length),
    });
  } else if (slugToKey.fwd[last]) {
    var st = areaStat(slugToKey.fwd[last]);
    base.title = t("head.area.title", { name: areaName(st.key), city: name });
    base.desc = t("head.area.desc", {
      name: areaName(st.key), city: name,
      lots: lots(st.n), below: num(st.below), rel: num(st.rel),
    });
    if (!st.n) {
      base.noindex = !hasAreaMarket(st.key) && !(historyByArea[st.key] || []).length;
      base.desc = areaName(st.key) + ", " + name + ". " + emptyAreaText(st.key);
    }
  } else if (last === SEG.honest) {
    base.title = t("head.honest.title", { city: name });
    base.desc = t("head.honest.desc", { city: name });
  } else if (p[p.length - 2] === SEG.lot) {
    var r = lotById[idFromSlug(last)];
    var what = r ? lotMetaSubject(r) : t("lot.fallback");
    var where = r && r[C.bairro] ? metaText(title(r[C.bairro]), 32) : name;
    var ref = r ? lotReference(r) : "";
    var address = r ? metaText(title(r[C.end] || where), 88) : where;
    var facts = r ? lotMetaFacts(r) : what;
    base.title = t("head.lot.title", { what: what, where: where, city: name, ref: ref });
    base.desc = t("head.lot.desc", {
      what: what, where: where, city: name, address: address, facts: facts, ref: ref,
    });
    if (r && !isCurrent(r)) {
      base.title = t(STATUS_KEY[lotStatus(r)]) + ' · ' + what + ' · ' + ref;
      base.desc = address + ', ' + name + '. ' + t("archive.removal.notice") + ' ' +
        t("archive.price.last") + ': ' + priceText(lastAdvertisedPrice(r)) + '. ' +
        t("lot.reference", { ref: ref });
    }
  } else if (archivePageNumber(path)) {
    var archivePage = archivePageNumber(path);
    base.title = t("archive.h1", { city: name });
    base.desc = t("archive.lede", { n: num(archiveRows().length) });
    if (archivePage > 1) {
      base.title += ' · ' + pageLabel(archivePage);
      base.desc = pageLabel(archivePage) + ' / ' + archivePageCount() + '. ' + base.desc;
    }
  } else if (allPageNumber(path)) {
    var page = allPageNumber(path);
    base.title = t("head.all.title", { city: name });
    base.desc = t("head.all.desc", { city: name, lots: lots(city.stats.lots) });
    if (page > 1) {
      base.title += " · " + pageLabel(page);
      base.desc = pageLabel(page) + " / " + allPageCount() + ". " + base.desc;
    }
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
  // A gallery image is not a desktop sidebar.  Keep a lot page wide unless
  // the renderer deliberately emitted a `.side` column.
  view.className = "wrap" + (isLotRoute(location.pathname) ? " lot-page" : "") +
    (pageUsesSideColumn(location.pathname, html) ? " split" : "");
  window.scrollTo(0, 0);
  wire();
}

function wireGallery(root) {
  var gallery = root && root.querySelector ? root.querySelector("[data-gallery]") : null;
  if (!gallery) return;
  if (gallery.getAttribute("data-gallery-wired") === "true") return;
  gallery.setAttribute("data-gallery-wired", "true");
  var hero = gallery.querySelector("[data-gallery-hero]");
  var open = gallery.querySelector("[data-gallery-open]");
  var lightbox = gallery.querySelector("[data-gallery-lightbox]");
  var lightboxImage = gallery.querySelector("[data-gallery-lightbox-image]");
  var closeButtons = [].slice.call(gallery.querySelectorAll("[data-gallery-close]"));
  var lightboxPrev = gallery.querySelector("[data-gallery-lightbox-prev]");
  var lightboxNext = gallery.querySelector("[data-gallery-lightbox-next]");
  var lightboxCount = gallery.querySelector("[data-gallery-lightbox-count]");
  var thumbs = [].slice.call(gallery.querySelectorAll("[data-gallery-index]"));
  var prev = gallery.querySelector("[data-gallery-prev]");
  var next = gallery.querySelector("[data-gallery-next]");
  var count = gallery.querySelector("[data-gallery-count]");
  var total = Number(gallery.getAttribute("data-gallery-total")) || thumbs.length;
  var current = 0;
  if (!hero) return;
  gallery.setAttribute("tabindex", "0");

  function syncLightbox() {
    if (!lightboxImage) return;
    lightboxImage.setAttribute("src", hero.getAttribute("src") || "");
    lightboxImage.setAttribute("alt", hero.getAttribute("alt") || "");
    if (lightboxCount) lightboxCount.textContent = galleryText("count", current + 1, total);
    if (lightboxPrev) lightboxPrev.disabled = current === 0;
    if (lightboxNext) lightboxNext.disabled = current === total - 1;
  }
  function select(index, moveFocus) {
    index = Math.max(0, Math.min(total - 1, index));
    var button = thumbs[index], image = button && button.querySelector("img");
    if (!button || !image) return;
    current = index;
    hero.setAttribute("src", image.getAttribute("src") || "");
    hero.setAttribute("alt", button.getAttribute("data-gallery-alt") || button.getAttribute("aria-label") || "");
    thumbs.forEach(function (item, i) {
      item.setAttribute("aria-current", i === index ? "true" : "false");
    });
    if (count) count.textContent = galleryText("count", index + 1, total);
    if (prev) prev.disabled = index === 0;
    if (next) next.disabled = index === total - 1;
    syncLightbox();
    if (moveFocus) button.focus();
  }
  function closeLightbox() {
    if (!lightbox || lightbox.hidden) return;
    lightbox.hidden = true;
    document.removeEventListener("keydown", onLightboxKey);
    if (open) open.focus();
  }
  function onLightboxKey(event) {
    if (event.key === "Escape") {
      event.preventDefault(); closeLightbox();
    } else if (total > 1 && event.key === "ArrowLeft") {
      event.preventDefault(); select(current - 1, false);
    } else if (total > 1 && event.key === "ArrowRight") {
      event.preventDefault(); select(current + 1, false);
    }
  }
  if (open && lightbox) open.addEventListener("click", function () {
    syncLightbox();
    lightbox.hidden = false;
    document.addEventListener("keydown", onLightboxKey);
    var closer = gallery.querySelector(".gallery-lightbox-close");
    if (closer) closer.focus();
  });
  closeButtons.forEach(function (button) {
    button.addEventListener("click", closeLightbox);
  });
  if (lightbox && total > 1) {
    var touchStart = null;
    lightbox.addEventListener("touchstart", function (event) {
      touchStart = event.touches && event.touches[0] ? event.touches[0].clientX : null;
    }, { passive: true });
    lightbox.addEventListener("touchend", function (event) {
      var end = event.changedTouches && event.changedTouches[0] ? event.changedTouches[0].clientX : null;
      if (touchStart == null || end == null || Math.abs(end - touchStart) < 42) return;
      select(current + (end < touchStart ? 1 : -1), false);
      touchStart = null;
    }, { passive: true });
  }
  if (total < 2 || thumbs.length < 2) return;
  thumbs.forEach(function (button, index) {
    button.addEventListener("click", function () { select(index, false); });
  });
  if (prev) prev.addEventListener("click", function () {
    var current = thumbs.findIndex(function (item) { return item.getAttribute("aria-current") === "true"; });
    select(current - 1, true);
  });
  if (next) next.addEventListener("click", function () {
    select(current + 1, true);
  });
  if (lightboxPrev) lightboxPrev.addEventListener("click", function () { select(current - 1, false); });
  if (lightboxNext) lightboxNext.addEventListener("click", function () { select(current + 1, false); });
  gallery.addEventListener("keydown", function (event) {
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault(); select(current - 1, true);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault(); select(current + 1, true);
    } else if (event.key === "Home") {
      event.preventDefault(); select(0, true);
    } else if (event.key === "End") {
      event.preventDefault(); select(total - 1, true);
    }
  });
  select(0, false);
}

function wire() {
  if (window.ANALYZE) window.ANALYZE.wire();
  var near = $("near");
  if (near) near.addEventListener("click", askNear);
  wireCity($("view"));
  wireAnalysisCTA($("view"));
  wireGallery($("view"));
}

function wireAnalysisCTA(root) {
  var button = root && root.querySelector ? root.querySelector("[data-analysis-cta]") : null;
  var target = root && root.querySelector ? root.querySelector("[data-az]") : null;
  if (!button || !target) return;
  button.addEventListener("click", function () {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    var control = target.querySelector("button, input, [tabindex]");
    if (control && typeof control.focus === "function") control.focus({ preventScroll: true });
  });
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

if (window.__D__ && Array.isArray(D.cities)) {
  var saved = null;
  try { saved = localStorage.getItem("city"); } catch (e) { /* private mode */ }
  indexCity(D.cities.filter(function (c) { return c.slug === saved; })[0] || guessCity());
  paintPick();

  // No client-side router: every link is a real URL and every URL is a real
  // file. The brand is an anchor like any other.
  var brand = document.querySelector(".brand");
  if (brand) brand.setAttribute("href", "/");
  render();
} else {
  /* Generated pages already contain their body and their SSR map iframe. The
   * static runtime only attaches gallery behavior; it never re-renders the
   * page or touches map/network state. */
  wireGallery(document);
}
