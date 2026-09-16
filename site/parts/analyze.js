/* Analysis is disabled unless __ANALYSIS__.enabled === true.
 * The only browser endpoint is the fixed HTTPS Worker below. Before enabling,
 * its owner must verify exact-origin CORS and the brazil-proxy-v1 exact-body
 * HMAC contract for internal POST /api/brazil-analysis and ticket polling.
 * Signing secrets and dashboard access never belong in this browser script.
 * No email collection.
 * Only random request IDs and acknowledgement flags persist locally;
 * PDF URLs, results and signed poll tickets never enter storage or analytics. */
(function (global) {
  "use strict";

  var CFG = global.__ANALYSIS__ || {};
  var BASE = "https://preco-real-analyze.preco-real.workers.dev";
  // This is a browser guard, not server CORS enforcement. Fail closed on
  // arbitrary endpoint overrides; redirects must not bypass this boundary.
  var trustedEndpoint =
    (CFG.apiBase === undefined || CFG.apiBase === BASE) &&
    ["https://precodemartelo.com", "https://www.precodemartelo.com"].indexOf(global.location.origin) !== -1;
  var enabled = CFG.enabled === true && trustedEndpoint;
  var reportsEnabled = CFG.reportsEnabled === true && trustedEndpoint;
  // Client-side mirror of the worker's PDF_ALLOWED_HOSTS — not security
  // (the worker enforces its own), just a better error before a round trip.
  // Assembled from halves because the build's key scanner reads any dotted
  // lowercase literal in parts/*.js as an i18n key, hostnames included.
  var HOSTS = {};
  ["venda-imoveis", "www"].forEach(function (h) { HOSTS[h + ".caixa.gov.br"] = 1; });

  var L = global.LANG || {};
  var t = L.t || function (k) { return k; };
  var lang = /^(pt|en|ru)$/.test(L.code) ? L.code : "pt";
  var PREFIX = "brazil-analysis-v1-";
  var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  var TICKET = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[0-9]{10,11}\.[a-f0-9]{64}$/;

  function track(name, params) {
    try { if (global.track) global.track(name, params); } catch (e) { /* optional */ }
  }

  function pdf(value) {
    try {
      var u = new URL(value);
      if (u.protocol === "https:" && HOSTS[u.hostname] && !u.username && !u.password &&
          !u.port && /\.pdf$/i.test(u.pathname) && !u.hash && u.href.length <= 2048) return u.href;
    } catch (e) { /* show local validation error */ }
    return null;
  }

  function randomID() {
    var bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.prototype.map.call(bytes, function (n) { return (n + 256).toString(16).slice(1); }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  function write(key, value) {
    global.localStorage.setItem(key, value);
    if (global.localStorage.getItem(key) !== value) throw new Error("storage");
  }

  async function requestState(id, url) {
    var visitor = global.localStorage.getItem(PREFIX + "visitor");
    if (!UUID.test(visitor || "")) {
      visitor = randomID();
      write(PREFIX + "visitor", visitor);
    }
    var hash = await global.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([id, url, visitor, lang])));
    var slot = PREFIX + Array.prototype.map.call(new Uint8Array(hash), function (n) {
      return (n + 256).toString(16).slice(1);
    }).join("");
    var old = null;
    try { old = JSON.parse(global.localStorage.getItem(slot)); } catch (e) { /* new request */ }
    var record = {
      key: old && UUID.test(old.key) ? old.key : randomID(),
      ok: !!(old && old.ok === true),
    };
    write(slot, JSON.stringify(record));
    return { slot: slot, record: record, payload: {
      id: id, url: url, visitor_id: visitor, idempotency_key: record.key, lang: lang,
    } };
  }

  function remember(state) {
    try { write(state.slot, JSON.stringify(state.record)); } catch (e) { /* retain in memory; never repeat POST automatically */ }
  }

  function post(path, payload, timeout) {
    var controller = global.AbortController ? new global.AbortController() : null;
    return new Promise(function (resolve, reject) {
      var timer = global.setTimeout(function () {
        if (controller) controller.abort();
        reject(new Error("timeout"));
      }, timeout);
      Promise.resolve().then(function () {
        return global.fetch(BASE + path, {
          method: payload === null ? "GET" : "POST", headers: { "Content-Type": "application/json" },
          credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error",
          body: payload === null ? undefined : JSON.stringify(payload), signal: controller ? controller.signal : undefined,
        });
      }).then(async function (r) {
        var body = null;
        try { body = await r.json(); } catch (e) { /* HTTP status still matters */ }
        return { status: r.status, body: body, hit: r.headers.get("X-Cache") === "hit" };
      }).then(function (r) { global.clearTimeout(timer); resolve(r); }, function (e) {
        global.clearTimeout(timer); reject(e);
      });
    });
  }

  // Full literals on purpose: the prerender ships flat pages only the i18n
  // keys it can see written out in parts/*.js, and "az.occ." + value is
  // invisible to it.
  var OCC = { sim: "az.occ.sim", nao: "az.occ.nao", incerto: "az.occ.incerto" };
  var OCC_CLS = { sim: "bad", nao: "good", incerto: "mute" };
  var CONF = { alta: "az.conf.alta", media: "az.conf.media", baixa: "az.conf.baixa" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function items(xs) {
    return (xs || []).map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("");
  }

  function errText(code) {
    if (code === "bad_domain") return t("az.err.domain");
    if (code === "rate_limited") return t("az.err.limit");
    if (code === "analysis_unavailable") return t("az.err.unavailable");
    if (code === "source_unavailable" || code === "source_blocked") return t("az.err.source");
    if (code === "budget_exhausted") return t("az.budget");
    if (code === "free_limit_reached") return t("az.allowance");
    if (code === "capacity_exhausted") return t("az.capacity");
    if (code === "idempotency_conflict") return t("az.err.conflict");
    return t("az.err.fail");
  }

  function validResult(a) {
    // A 200 alone is not analysis success. Reject malformed envelopes before
    // rendering or emitting stage=ok (the live GA key-event derivation).
    function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
    function strings(value) {
      return Array.isArray(value) && value.every(function (x) { return typeof x === "string" && !!x.trim(); });
    }
    function keys(value, allowed) {
      return Object.keys(value).every(function (key) { return allowed.indexOf(key) !== -1; });
    }
    return object(a) && keys(a, ["resumo", "ocupado", "confianca", "aviso", "dividas", "riscos", "fase", "source_scope", "_meta"]) &&
      ["lot_specific", "generic_rules"].indexOf(a.source_scope) !== -1 &&
      typeof a.resumo === "string" && !!a.resumo.trim() &&
      ["sim", "nao", "incerto"].indexOf(a.ocupado) !== -1 &&
      ["alta", "media", "baixa"].indexOf(a.confianca) !== -1 &&
      typeof a.aviso === "string" && !!a.aviso.trim() &&
      object(a.dividas) && keys(a.dividas, ["iptu", "condominio", "outras"]) &&
      typeof a.dividas.iptu === "string" && !!a.dividas.iptu.trim() &&
      typeof a.dividas.condominio === "string" && !!a.dividas.condominio.trim() &&
      strings(a.dividas.outras) && strings(a.riscos) &&
      typeof a.fase === "string" && !!a.fase.trim() &&
      (a._meta === undefined || (object(a._meta) && keys(a._meta, ["cached", "analyzed_at"]) &&
        typeof a._meta.cached === "boolean" && typeof a._meta.analyzed_at === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(a._meta.analyzed_at) &&
        !isNaN(Date.parse(a._meta.analyzed_at))));
  }

  function render(a, hit) {
    // General rules cannot establish occupancy, auction phase or lot debts.
    if (a.source_scope === "generic_rules") {
      return '<h3>' + t("az.generic.title") + '</h3><p class="note">' + t("az.generic.note") +
        '</p><p class="say">' + esc(a.resumo) + '</p><p class="foot">' + esc(a.aviso) +
        (hit ? " · " + t("az.cache") : "") + '</p>';
    }
    var d = a.dividas || {};
    var extra =
      (a.fase ? '<p class="note"><b>' + t("az.fase") + "</b> " + esc(a.fase) + "</p>" : "") +
      ((d.outras || []).length
        ? '<p class="note"><b>' + t("az.outras") + "</b></p><ul class=\"azlist\">" +
          items(d.outras) + "</ul>" : "") +
      ((a.riscos || []).length
        ? '<p class="note"><b>' + t("az.riscos") + "</b></p><ul class=\"azlist\">" +
          items(a.riscos) + "</ul>" : "");
    return '<p class="say">' + esc(a.resumo) + "</p>" +
      '<div class="facts">' +
        '<div class="fact"><span class="k">' + t("az.occ") + '</span><span class="v ' +
          (OCC_CLS[a.ocupado] || "mute") + '">' +
          t(OCC[a.ocupado] || "az.occ.incerto", null, esc(a.ocupado)) + "</span></div>" +
        '<div class="fact"><span class="k">IPTU</span><span class="v">' +
          esc(d.iptu) + "</span></div>" +
        '<div class="fact"><span class="k">' + t("az.condo") + '</span><span class="v">' +
          esc(d.condominio) + "</span></div>" +
        '<div class="fact"><span class="k">' + t("az.conf") + '</span><span class="v">' +
          t(CONF[a.confianca] || "az.conf.baixa", null, esc(a.confianca)) + "</span></div>" +
      "</div>" + extra +
      // Display the validated backend disclaimer as text.
      '<p class="foot">' + esc(a.aviso || "") + (hit ? " · " + t("az.cache") : "") + "</p>";
  }

  function validReport(a, id) {
    function time(value) {
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !isNaN(Date.parse(value));
    }
    function safe(value) {
      return typeof value === "string" && !!value.trim() && value.length <= 12000 &&
        !/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(value);
    }
    function date(value) {
      return value === null || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
    }
    function keys(value, allowed) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(function (key) { return allowed.indexOf(key) !== -1; }); }
    function event(value) {
      return keys(value, ["date", "page", "time", "timezone"]) && date(value.date) &&
        Number.isInteger(value.page) && value.page > 0 && value.page <= 150 &&
        (value.time === null || (typeof value.time === "string" && /^[0-2]\d:[0-5]\d$/.test(value.time))) &&
        ["unknown", "America/Sao_Paulo"].indexOf(value.timezone) !== -1;
    }
    function finding(value) {
      return keys(value, ["kind", "statement", "page", "quote"]) &&
        ["occupancy", "commission", "charges", "servitude", "auction_date"].indexOf(value.kind) !== -1 &&
        Number.isInteger(value.page) && value.page > 0 && value.page <= 150 && safe(value.statement) && value.statement.length <= 360 &&
        safe(value.quote) && value.quote.length <= 360;
    }
    function strings(value, min, max) { return Array.isArray(value) && value.length >= min && value.length <= max && value.every(safe); }
    var doc = a && a.document, match = a && a.match, report = a && a.report;
    return a && a.status === "historical_document" && a.source_scope === "historical_document" && a.lot_id === id &&
      time(a.analyzed_at) && doc && time(doc.captured_at) && /^[a-f0-9]{64}$/.test(doc.sha256) &&
      /^[a-f0-9]{64}$/.test(doc.evidence_hash) && Number.isInteger(doc.page) && doc.page > 0 && doc.page <= 10000 &&
      keys(match, ["address", "matricula", "auction_dates"]) && match.address === true && match.matricula === true && match.auction_dates === true &&
      keys(report, ["language", "summary", "findings", "auction_events", "document_date"]) && report.language === "pt" && safe(report.summary) && report.summary.length <= 900 &&
      Array.isArray(report.findings) && report.findings.length >= 1 && report.findings.length <= 6 && report.findings.every(finding) &&
      Array.isArray(report.auction_events) && report.auction_events.length >= 1 && report.auction_events.length <= 3 && report.auction_events.every(event) &&
      date(report.document_date) && strings(a.limitations, 1, 1);
  }

  function renderReport(a) {
    function event(value) {
      return esc(value.date || t("archive.date.unknown")) + (value.time ? " · " + esc(value.time) : "") + " · " +
        esc(value.timezone === "unknown" ? t("archive.date.unknown") : value.timezone) + " · " +
        esc(t("az.report.page", { page: value.page }));
    }
    function finding(value) {
      var stated = value.statement.toLocaleLowerCase().indexOf(value.quote.toLocaleLowerCase()) !== -1;
      return '<li><p>' + esc(value.statement) + ' <span class="foot">' + esc(t("az.report.page", { page: value.page })) +
        '</span></p>' + (stated ? '' : '<blockquote class="foot">' + esc(value.quote) + '</blockquote>') + '</li>';
    }
    return '<h2>' + esc(t("az.report.title")) + '</h2>' +
      '<p class="foot">' + esc(t("az.report.notice")) + '</p>' +
      '<p class="foot">' + esc(t("az.report.scope")) + ' · ' + esc(t("az.report.language")) + '</p>' +
      '<p>' + esc(t("az.report.date", { date: a.report.document_date || t("archive.date.unknown") })) + '</p>' +
      '<p class="foot">' + esc(t("az.report.auctions")) + '</p><ul class="azlist">' + a.report.auction_events.map(event).map(function (x) { return "<li>" + x + "</li>"; }).join("") + '</ul>' +
      '<div lang="pt"><p class="say">' + esc(a.report.summary) + '</p>' +
        '<p class="foot">' + esc(t("az.report.findings")) + '</p><ul class="azlist">' + a.report.findings.map(finding).join("") + '</ul>' +
        '<ul class="foot">' + items(a.limitations) + '</ul></div>' +
      '<p class="foot">' + esc(t("az.report.captured", { date: a.document.captured_at })) + '</p>' +
      '<p class="foot">' + esc(t("az.analyzed", { date: a.analyzed_at })) + '</p>' +
      '<p class="foot">' + esc(t("az.report.page", { page: a.document.page })) + '</p>';
  }

  async function bootReport(box) {
    if (!reportsEnabled) return;
    var id = box.getAttribute("data-lot-report");
    if (!/^[a-f0-9]{16}$/.test(id || "")) return;
    box.setAttribute("data-report-state", "loading");
    box.innerHTML = '<p class="foot" role="status">' + esc(t("az.report.loading")) + '</p>';
    try {
      // Read-only cache lookup: no visitor ID, local storage, POST, polling or fallback.
      var r = await post("/api/brazil-lot-reports/" + id, null, 15000);
      if (box.isConnected === false || box.getAttribute("data-lot-report") !== id) return;
      if (r.status === 200 && validReport(r.body, id)) {
        box.innerHTML = renderReport(r.body);
        box.setAttribute("data-report-state", "displayed");
        // This is a display, not a new analysis conversion or a button click.
        track("lot_report_displayed", { source_scope: "historical_document" });
        return;
      }
    } catch (e) { if (box.isConnected === false) return; }
    box.setAttribute("data-report-state", "unavailable");
    box.innerHTML = '<p class="foot" role="status">' + esc(t("az.report.unavailable")) + '</p>';
  }

  function boot(box) {
    if (!enabled) {
      box.setAttribute("data-az-state", "unavailable");
      box.innerHTML = '<div class="sechead"><h2>' + t("az.h2") + '</h2></div>' +
        '<p class="foot" role="status">' + t("az.disabled") + '</p>';
      return;
    }
    box.innerHTML =
      '<div class="sechead"><h2>' + t("az.h2") + '</h2><span class="n">' +
        t("az.free") + "</span></div>" +
      '<p class="foot">' + t("az.lede") + "</p>" +
      '<form class="azform"><input type="url" required inputmode="url" placeholder="' +
        esc(t("az.ph")) + '" aria-label="' + esc(t("az.ph")) + '">' +
      '<button type="submit" class="cta">' + t("az.go") + "</button></form>" +
      '<p class="foot azmsg" role="status" aria-live="polite" hidden></p><div class="azout"></div>';
    var form = box.querySelector("form");
    var input = box.querySelector("input");
    var btn = box.querySelector("button");
    var msg = box.querySelector(".azmsg");
    var out = box.querySelector(".azout");
    var busy = false, state = null, stateURL = null;
    var prefill = pdf(box.getAttribute("data-az-pdf") || "");
    if (prefill) input.value = prefill;

    function say(s) { msg.hidden = false; msg.textContent = s; }
    function mode(value) { box.setAttribute("data-az-state", value); }
    function lock(value) {
      busy = value;
      btn.disabled = value;
      input.disabled = value;
      form.setAttribute("aria-busy", String(value));
    }
    function failure(reason) {
      var stage = ["rate_limited", "free_limit_reached", "budget_exhausted"].indexOf(reason) !== -1 ? reason :
        ["analysis_unavailable", "source_unavailable", "source_blocked", "capacity_exhausted"].indexOf(reason) !== -1 ? "unavailable" : "error";
      mode(stage);
      say(errText(reason));
      track("analyze_edital", { stage: stage, reason: reason });
      btn.textContent = t("az.retry");
    }

    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      if (busy) return;
      var url = pdf(input.value.trim());
      if (!url) {
        say(errText("bad_domain"));
        track("analyze_edital", { stage: "error", reason: "bad_domain" });
        return;
      }
      lock(true);
      mode("submitting");
      out.innerHTML = "";
      say(t("az.wait"));
      try {
        if (!state || stateURL !== url) {
          state = await requestState(box.getAttribute("data-az"), url);
          stateURL = url;
        }
      } catch (e) {
        mode("error");
        say(t("az.err.storage"));
        lock(false);
        return;
      }
      track("analyze_edital", { stage: "start" });
      var deadline = Date.now() + 120000;
      try {
        for (var attempt = 0; attempt < 4; attempt++) {
          // Tickets live only in memory, never storage, analytics or page links.
          var r = await post(state.ticket ? "/analyze/" + state.ticket : "/analyze", state.ticket ? null : state.payload,
            Math.max(1, Math.min(115000, deadline - Date.now())));
          // Navigation must not attribute an old request's success to a new lot.
          if (box.isConnected === false) return;
          var body = r.body && typeof r.body === "object" && !Array.isArray(r.body) ? r.body : {};
          if (r.status === 202 && !body.error && body.status === "pending" && typeof body.analysis_id === "string" && !!body.analysis_id.trim() &&
              typeof body.job_ticket === "string" && TICKET.test(body.job_ticket)) {
            state.ticket = body.job_ticket;
            if (!state.pending) {
              state.pending = true;
              track("analyze_edital", { stage: "pending" });
            }
            mode("pending");
            say(t("az.pending"));
            btn.textContent = t("az.retry");
            var delay = Number(body.retry_after_seconds);
            delay = Math.max(1, Math.min(15, isFinite(delay) ? delay : 5)) * 1000;
            if (attempt === 3 || Date.now() + delay >= deadline || box.isConnected === false) return;
            await new Promise(function (resolve) { global.setTimeout(resolve, delay); });
            if (box.isConnected === false) return;
            continue;
          }
          if (r.status === 200 && validResult(body)) {
            var hit = body._meta ? body._meta.cached === true : r.hit;
            out.innerHTML = render(body, hit);
            if (body._meta && typeof body._meta.analyzed_at === "string" && !isNaN(Date.parse(body._meta.analyzed_at))) {
              out.innerHTML += '<p class="foot">' + esc(t("az.analyzed", {
                date: new Date(body._meta.analyzed_at).toLocaleString(lang),
              })) + '</p>';
            }
            msg.hidden = true;
            mode("result");
            if (!state.record.ok) {
              state.record.ok = true;
              remember(state);
              track("analyze_edital", { stage: "ok", cached: hit ? 1 : 0 });
            }
            btn.textContent = t("az.again");
            return;
          }
          // A rejected/expired ticket can be recovered by a manual same-key POST.
          if (r.status === 400 || r.status === 404) state.ticket = null;
          // HTTP status alone cannot distinguish free allowance, budget,
          // capacity, source blocking and ordinary throttling.
          var errors = ["rate_limited", "free_limit_reached", "budget_exhausted", "capacity_exhausted",
            "analysis_unavailable", "source_unavailable", "source_blocked", "bad_domain", "bad_request",
            "idempotency_conflict", "too_large", "upstream"];
          var reason = r.status >= 400 && r.status <= 599 && errors.indexOf(body.error) !== -1 ? body.error : "invalid_response";
          // These typed 429s guarantee no dispatch. A manual retry must reach
          // core admission via POST, not poll a terminal job forever. Keep the
          // same key: only the backend may authorize a pre-dispatch requeue.
          if (r.status === 429 && ["budget_exhausted", "free_limit_reached", "capacity_exhausted"].indexOf(reason) !== -1) state.ticket = null;
          failure(reason);
          if (["budget_exhausted", "free_limit_reached", "capacity_exhausted"].indexOf(reason) !== -1) {
            track(reason === "budget_exhausted" ? "analysis_budget_exhausted" : reason === "capacity_exhausted" ? "analysis_capacity_exhausted" : "analysis_free_limit_reached", {});
          }
          return;
        }
      } catch (e) {
        if (box.isConnected === false) return;
        failure(e.message === "timeout" ? "timeout" : "network");
      } finally { lock(false); }
    });
  }

  function wire(root) {
    var reports = (root || document).querySelectorAll("[data-lot-report]");
    for (var j = 0; j < reports.length; j++) {
      if (reportsEnabled && !reports[j].getAttribute("data-report-on")) {
        reports[j].setAttribute("data-report-on", "1");
        bootReport(reports[j]);
      }
    }
    var boxes = (root || document).querySelectorAll("[data-az]");
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].getAttribute("data-az-on")) {
        boxes[i].setAttribute("data-az-on", "1");
        boot(boxes[i]);
      }
    }
    try { if (global.ANALYTICS) global.ANALYTICS.wire(root || document); } catch (e) { /* optional */ }
  }

  global.ANALYZE = { wire: wire };
  if (document.readyState !== "loading") wire();
  else document.addEventListener("DOMContentLoaded", function () { wire(); });
})(window);
