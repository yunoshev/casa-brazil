/* The free document read — the one thing on this site that talks to a server.
 *
 * A static page cannot read a 40-page edital, so this part hands the PDF's
 * URL to our Cloudflare Worker, which fetches it from Caixa's own domain
 * (strict allowlist, server-side), has Gemini extract what the document
 * actually supports, and returns JSON. The same dossiê the competition sells
 * for R$ 9,90 — here it costs a paste of a link.
 *
 * The page ships only an empty <section data-az="<lot_uid>">; everything
 * visible is drawn here at runtime through LANG.t, so the form speaks the
 * reader's language on flat pages and in the dynamic shell alike. The
 * analysis itself comes back in pt-BR — it quotes a Portuguese document.
 * Inert when no container is on the page. */
(function (global) {
  "use strict";

  var WORKER = "https://preco-real-analyze.preco-real.workers.dev/analyze";
  // Client-side mirror of the worker's PDF_ALLOWED_HOSTS — not security
  // (the worker enforces its own), just a better error before a round trip.
  // Assembled from halves because the build's key scanner reads any dotted
  // lowercase literal in parts/*.js as an i18n key, hostnames included.
  var HOSTS = {};
  ["venda-imoveis", "www"].forEach(function (h) { HOSTS[h + ".caixa.gov.br"] = 1; });

  var L = global.LANG || {};
  var t = L.t || function (k) { return k; };

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
    return t("az.err.fail");
  }

  function render(a, hit) {
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
      // The worker injects this disclaimer server-side, always: what the page
      // shows is what the server said, not what the model felt like saying.
      '<p class="foot">' + esc(a.aviso || "") + (hit ? " · " + t("az.cache") : "") + "</p>";
  }

  function boot(box) {
    box.innerHTML =
      '<div class="sechead"><h2>' + t("az.h2") + '</h2><span class="n">' +
        t("az.free") + "</span></div>" +
      '<p class="foot">' + t("az.lede") + "</p>" +
      '<form class="azform"><input type="url" required inputmode="url" placeholder="' +
        esc(t("az.ph")) + '" aria-label="' + esc(t("az.ph")) + '">' +
      '<button type="submit" class="cta">' + t("az.go") + "</button></form>" +
      '<p class="foot azmsg" hidden></p><div class="azout"></div>';
    var form = box.querySelector("form");
    var input = box.querySelector("input");
    var btn = box.querySelector("button");
    var msg = box.querySelector(".azmsg");
    var out = box.querySelector(".azout");

    function say(s) { msg.hidden = false; msg.innerHTML = s; }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var u = null;
      try { u = new URL(input.value.trim()); } catch (e) { /* said below */ }
      if (!u || u.protocol !== "https:" || !HOSTS[u.hostname]) {
        say(errText("bad_domain"));
        return;
      }
      btn.disabled = true;
      out.innerHTML = "";
      say(t("az.wait"));
      // Every call spends a free Gemini key. Knowing how many there are is the
      // difference between "the feature is used" and a bill nobody predicted.
      if (global.track) global.track("analyze_edital", { stage: "start" });
      fetch(WORKER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: box.getAttribute("data-az"), url: u.href }),
      }).then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, hit: r.headers.get("X-Cache") === "hit", body: j };
        });
      }).then(function (r) {
        btn.disabled = false;
        if (!r.ok) {
          say(errText(r.body && r.body.error));
          if (global.track) {
            global.track("analyze_edital", {
              stage: "error", reason: (r.body && r.body.error) || "unknown",
            });
          }
          return;
        }
        msg.hidden = true;
        out.innerHTML = render(r.body, r.hit);
        if (global.track) {
          global.track("analyze_edital", { stage: "ok", cached: r.hit ? 1 : 0 });
        }
      }).catch(function () {
        btn.disabled = false;
        say(errText());
        if (global.track) global.track("analyze_edital", { stage: "error", reason: "network" });
      });
    });
  }

  function wire(root) {
    var boxes = (root || document).querySelectorAll("[data-az]");
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].getAttribute("data-az-on")) {
        boxes[i].setAttribute("data-az-on", "1");
        boot(boxes[i]);
      }
    }
  }

  global.ANALYZE = { wire: wire };
  if (document.readyState !== "loading") wire();
  else document.addEventListener("DOMContentLoaded", function () { wire(); });
})(window);
