/* Approximate city selection for the flat country homepage only.
 *
 * The endpoint sees the request IP as any HTTP service does, returns one known
 * city slug, and never receives browser coordinates. A saved manual choice
 * always wins; the inferred result is not stored as that choice.
 */
(function (global) {
  "use strict";
  var ENDPOINT = "https://preco-real-geo.preco-real.workers.dev/city";
  var TIMEOUT = 1200;
  var FALLBACK = "sao-paulo-sp";
  var generation = 0, wired = false;
  function t(key) { return (global.LANG && global.LANG.t) ? global.LANG.t(key) : key; }
  function known(slug) {
    return (global.__CITIES__ || []).some(function (c) { return c.slug === slug; });
  }
  function saved() {
    try { var slug = localStorage.getItem("city"); return known(slug) ? slug : ""; }
    catch (e) { return ""; }
  }
  function base() { return String(global.__BASE__ || "").replace(/\/+$/, ""); }
  function note(reason) {
    var el = document.getElementById("geo-note");
    if (el) el.textContent = reason === "nearest" ? t("geo.approx") : "";
  }
  function reorder(slug) {
    var row = document.querySelector && document.querySelector('.row[data-city="' + slug + '"]');
    if (row && row.parentNode) row.parentNode.insertBefore(row, row.parentNode.firstChild);
  }
  function active(token, slug) {
    var manual = saved();
    return token === generation && (!manual || manual === slug);
  }
  function bounded(url, init, parse) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var clock;
    var timedOut = new Promise(function (resolve) {
      clock = setTimeout(function () { if (controller) controller.abort(); resolve(null); }, TIMEOUT);
    });
    init.signal = controller && controller.signal;
    var request = fetch(url, init).then(function (r) {
      return r.ok ? parse(r) : null;
    }).catch(function () { return null; });
    // Race includes JSON/text parsing, not merely response headers.
    return Promise.race([request, timedOut]).then(function (value) {
      clearTimeout(clock);
      return value;
    });
  }
  function current(slug) {
    var slot = document.getElementById("home-city-fragment");
    var card = slot && slot.querySelector && slot.querySelector("[data-home-city]");
    return !!(card && card.getAttribute("data-home-city") === slug);
  }
  function commit(slug, reason, token) {
    if (!active(token, slug)) return;
    if (global.CHROME && global.CHROME.setCity) global.CHROME.setCity(slug);
    reorder(slug);
    note(reason);
  }
  function apply(slug, reason, token) {
    token = token == null ? ++generation : token;
    if (!known(slug)) slug = FALLBACK;
    if (current(slug)) { commit(slug, reason, token); return Promise.resolve(); }
    return bounded(base() + "/_home/" + encodeURIComponent(slug) + ".html", {
      credentials: "omit", referrerPolicy: "no-referrer"
    }, function (r) { return r.text(); }).then(function (html) {
      var slot = document.getElementById("home-city-fragment");
      if (html && slot && active(token, slug)) {
        slot.innerHTML = html;
        commit(slug, reason, token);
      }
      // Failure intentionally commits nothing: the static São Paulo map and
      // label remain a truthful pair.
    });
  }
  function lookup() {
    return bounded(ENDPOINT, {
      credentials: "omit", referrerPolicy: "no-referrer"
    }, function (r) { return r.json(); }).then(function (body) {
      return body && known(body.city) && (body.reason === "nearest" || body.reason === "default") ? body : null;
    });
  }
  function boot() {
    if (!document.getElementById("home-city-fragment")) return;
    if (!wired) {
      wired = true;
      document.addEventListener("click", function (e) {
        var a = e.target.closest && e.target.closest("[data-city]");
        if (a) generation += 1;
      });
    }
    var manual = saved();
    if (manual) { apply(manual, "manual", ++generation); return; }
    var token = ++generation;
    lookup().then(function (result) {
      // A menu click while lookup was pending is authoritative even if the
      // navigation was prevented by an embedding page.
      if (token === generation) apply(result ? result.city : FALLBACK, result && result.reason, token);
    });
  }
  global.GEO = { known: known, saved: saved, boot: boot, apply: apply };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window);
