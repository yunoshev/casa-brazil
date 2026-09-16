/* Local consent: no Google script, dataLayer or pings before acceptance.
 * The same first-party settings window is used in every country. GA starts
 * only after the visitor explicitly grants analytics for this policy revision.
 * Read-only build config: __ANALYTICS__.ga4 and
 * __ANALYTICS__.enhancedMeasurementDisabled === true. The latter asserts that
 * automatic history, form, outbound, download and search measurement are OFF
 * in the GA stream; send_page_view:false alone cannot disable those settings.
 * Account setup belongs to the release owner. CF beacon is not bootstrapped
 * here: it bypasses this module's URL and event sanitization.
 * ANALYTICS.wire(root) observes new shell content; setConsent/getConsent let
 * main add a privacy-settings link. Pre-consent events are discarded.
 */
(function (global) {
  "use strict";
  var CFG = global.__ANALYTICS__ || {};
  // This record intentionally has no continuity with prior consent schemes.
  // The new all-country first-party policy asks every returning visitor once.
  var LOCAL_KEY = "brazil-analytics-local-consent-v2";
  var LOCAL_REVISION = "local-all-countries-v2";
  var choice = null, started = false, panel = null, preferences = null, pageSeen = false;
  var ctaSeen = false, lotSeen = false, observer = null;
  var lastPath = null;
  // Resolve LANG at use time: analytics may load before lang.js.
  function t(key) { return global.LANG && global.LANG.t ? global.LANG.t(key) : key; }
  var SOURCES = ["caixa", "zuk", "superbid", "sodre", "sodre-santoro", "sodresantoro", "leilaoimovel", "leilao-imovel", "vlance", "emgea", "resale", "santander", "lot"];
  var CITIES = ["rio-de-janeiro-rj", "sao-paulo-sp", "sao-goncalo-rj", "recife-pe", "fortaleza-ce"];
  var REASONS = ["rate_limited", "analysis_unavailable", "bad_domain", "too_large",
    "upstream", "invalid_response", "network", "timeout", "unknown", "bad_request",
    "idempotency_conflict", "budget_exhausted", "free_limit_reached", "capacity_exhausted", "source_unavailable", "source_blocked"];
  var EVENTS = {
    page_view: [], lot_view: [], lot_outbound: ["source", "page"],
    city_switch: ["city_code"], lang_switch: ["lang"], analysis_cta_view: [],
    analyze_edital: ["stage", "cached", "reason"],
    lot_report_displayed: ["source_scope"],
    analysis_budget_exhausted: [], analysis_free_limit_reached: [], analysis_capacity_exhausted: [],
  };

  function offline() {
    var h = global.location.hostname;
    return global.location.protocol !== "https:" || !h || h === "localhost" ||
      h === "127.0.0.1" || h === "[::1]" || /^192\.168\./.test(h) ||
      global.navigator.webdriver === true;
  }
  var gaReady = !offline() && /^G-[A-Z0-9]+$/.test(CFG.ga4 || "") && CFG.enhancedMeasurementDisabled === true;
  var ready = gaReady;

  function readLocalChoice() {
    try {
      var saved = JSON.parse(global.localStorage.getItem(LOCAL_KEY) || "null");
      return saved && saved.revision === LOCAL_REVISION &&
        (saved.value === "accepted" || saved.value === "rejected") ? saved.value : null;
    } catch (e) { return null; }
  }

  function saveLocalChoice(value) {
    try { global.localStorage.setItem(LOCAL_KEY, JSON.stringify({ revision: LOCAL_REVISION, value: value })); }
    catch (e) { /* session choice still works */ }
  }
  choice = readLocalChoice();

  function includes(xs, value) { return xs.indexOf(value) !== -1; }

  // Never send a lot/address slug, arbitrary path, query or hash to Google.
  // City codes are the finite catalogue, not user-provided labels.
  function context() {
    var path = global.location.pathname;
    var base = path.indexOf("/casa-brazil/") === 0 ? "/casa-brazil/" : "/";
    var result = { page_type: "other", page: base };
    if (path === base || path === base + "index" + ".html") result.page_type = "home";
    CITIES.some(function (city) {
      var uf = city.slice(-2), slug = city.slice(0, -3);
      var prefix = base + "leilao-de-imoveis/" + uf + "/" + slug + "/";
      if (path.indexOf(prefix) !== 0) return false;
      result.city_code = city;
      var tail = path.slice(prefix.length);
      result.page_type = !tail ? "city" : tail.indexOf("lote/") === 0 ? "lot" :
        tail.indexOf("rua/") === 0 ? "street" : /^todos-os-lotes\/(pagina\/[1-9][0-9]*\/)?$/.test(tail) ? "all" :
        /^arquivo\/(pagina\/[1-9][0-9]*\/)?$/.test(tail) ? "archive" :
        tail === "como-calculamos/" ? "methodology" : "area";
      result.page = prefix + (result.page_type === "lot" ? "lote/" : result.page_type === "street" ? "rua/" : "");
      return true;
    });
    result.lang = global.LANG && includes(["pt", "en", "ru"], global.LANG.code) ? global.LANG.code : "pt";
    return result;
  }

  function referrer() {
    try {
      var u = new URL(document.referrer);
      // Known search origins preserve attribution without query text.
      if (/^(www\.)?(google\.(com|com\.br|pt|ru|co\.uk)|bing\.com|duckduckgo\.com)$/.test(u.hostname)) return "https://" + u.hostname + "/";
    } catch (e) { /* empty/unknown referrer omitted */ }
    return "";
  }

  function track(name, params) {
    if (!ready || choice !== "accepted" || !started || !Object.prototype.hasOwnProperty.call(EVENTS, name)) return false;
    try {
      var ctx = context(), p = params || {}, safe = { page_type: ctx.page_type, lang: ctx.lang };
      if (ctx.city_code) safe.city_code = ctx.city_code;
      var source = document.querySelector("[data-out]");
      if (ctx.page_type === "lot" && source && includes(SOURCES, source.getAttribute("data-out"))) safe.source = source.getAttribute("data-out");
      var allowed = EVENTS[name].concat(["source", "city_code", "lang"]);
      allowed.forEach(function (key) {
        var value = p[key];
        if (key === "source" && includes(SOURCES, value)) safe.source = value;
        if (key === "city_code" && includes(CITIES, value)) safe.city_code = value;
        if (key === "lang" && includes(["pt", "en", "ru"], value)) safe.lang = value;
        if (key === "stage" && includes(["start", "pending", "ok", "error", "rate_limited", "free_limit_reached", "budget_exhausted", "unavailable"], value)) safe.stage = value;
        if (key === "cached" && (value === 0 || value === 1)) safe.cached = value;
        if (key === "source_scope" && value === "historical_document") safe.source_scope = value;
        if (key === "reason" && value !== undefined) safe.reason = includes(REASONS, value) ? value : "unknown";
        if (key === "page") safe.page = ctx.page;
      });
      safe.page_location = global.location.origin + ctx.page;
      safe.page_referrer = referrer();
      safe.page_title = ctx.page_type;
      safe.send_to = CFG.ga4;
      global.gtag("event", name, safe);
      return true;
    } catch (e) { return false; }
  }
  global.track = track;

  function start() {
    if (!gaReady || choice !== "accepted" || started) return;
    try {
      global.dataLayer = global.dataLayer || [];
      if (typeof global.gtag !== "function") global.gtag = function () { global.dataLayer.push(arguments); };
      global["ga-disable-" + CFG.ga4] = false;
      global.gtag("consent", "default", {
        ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted",
      });
      var ctx = context();
      global.gtag("set", {
        page_location: global.location.origin + ctx.page, page_referrer: referrer(), page_title: ctx.page_type,
      });
      global.gtag("js", new Date());
      global.gtag("config", CFG.ga4, {
        send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false,
        cookie_flags: "SameSite=Lax;Secure",
      });
      var script = document.createElement("script");
      script.async = true;
      script.referrerPolicy = "no-referrer";
      script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(CFG.ga4);
      document.head.appendChild(script);
      started = true;
    } catch (e) { /* blocked tag never affects the product */ }
  }

  function stopGoogleAnalytics() {
    if (started) {
      global["ga-disable-" + CFG.ga4] = true;
      try { global.gtag("consent", "update", { analytics_storage: "denied" }); } catch (e) { /* optional */ }
    }
  }

  function localPanel() {
    if (!panel) return;
    panel.hidden = false;
    var first = panel.querySelector("button");
    if (first) first.focus();
  }

  function setConsent(value) {
    if (value !== "accepted" && value !== "rejected") return false;
    choice = value;
    saveLocalChoice(value);
    if (panel) panel.hidden = true;
    if (preferences) preferences.focus();
    if (value === "accepted") {
      if (started) {
        global["ga-disable-" + CFG.ga4] = false;
        try { global.gtag("consent", "update", { analytics_storage: "granted" }); } catch (e) { /* optional */ }
      } else start();
      wire(document);
    } else stopGoogleAnalytics();
    return true;
  }

  function banner() {
    if (!gaReady || !document.body) return;
    if (!preferences) {
      preferences = document.createElement("button");
      preferences.type = "button";
      preferences.setAttribute("class", "analytics-preferences");
      preferences.textContent = t("analytics.preferences");
      preferences.addEventListener("click", function () {
        localPanel();
      });
      document.body.appendChild(preferences);
    }
    if (panel) return;
    panel = document.createElement("aside");
    panel.hidden = !!choice;
    panel.setAttribute("class", "analytics-banner");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-label", t("analytics.title"));
    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("class", "analytics-close");
    close.setAttribute("aria-label", t("analytics.close"));
    close.setAttribute("title", t("analytics.close"));
    close.textContent = "×";
    close.addEventListener("click", function () { setConsent("rejected"); });
    panel.appendChild(close);
    var title = document.createElement("h2");
    title.setAttribute("class", "analytics-banner-title");
    title.textContent = t("analytics.title");
    panel.appendChild(title);
    var text = document.createElement("p");
    text.setAttribute("class", "analytics-banner-copy");
    text.textContent = t("analytics.consent");
    panel.appendChild(text);
    var actions = document.createElement("div");
    actions.setAttribute("class", "analytics-actions");
    ["rejected", "accepted"].forEach(function (value) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = value === "accepted" ? t("analytics.accept") : t("analytics.reject");
      button.setAttribute("class", "analytics-action " + (value === "accepted" ? "analytics-accept" : "analytics-reject"));
      button.addEventListener("click", function () { setConsent(value); });
      actions.appendChild(button);
    });
    panel.appendChild(actions);
    document.body.appendChild(panel);
  }

  function wire(root) {
    banner();
    if (!ready || !started || choice !== "accepted") return;
    if (lastPath !== global.location.pathname) {
      lastPath = global.location.pathname;
      pageSeen = lotSeen = ctaSeen = false;
      if (observer) observer.disconnect();
    }
    if (!pageSeen) pageSeen = track("page_view");
    var scope = root || document;
    var lot = scope.querySelector("[data-out], [data-az]");
    if (!lotSeen && lot && context().page_type === "lot") lotSeen = track("lot_view", { source: lot.getAttribute("data-out") || "caixa" });
    if (ctaSeen || !global.IntersectionObserver) return;
    if (!observer) observer = new global.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!ctaSeen && entry.isIntersecting && entry.intersectionRatio > 0) {
          ctaSeen = track("analysis_cta_view", { source: "caixa" });
          if (ctaSeen) observer.disconnect();
        }
      });
    }, { threshold: 0.1 });
    var nodes = scope.querySelectorAll("[data-az] .cta");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].closest(".azform")) observer.observe(nodes[i]);
    }
  }

  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-out], [data-city], [data-lang]");
    if (!el) return;
    if (el.hasAttribute("data-out")) track("lot_outbound", { source: el.getAttribute("data-out"), page: true });
    else if (el.hasAttribute("data-city")) track("city_switch", { city_code: el.getAttribute("data-city") });
    else if (el.hasAttribute("data-lang")) track("lang_switch", { lang: el.getAttribute("data-lang") });
  });

  global.ANALYTICS = Object.freeze({ wire: wire, setConsent: setConsent, getConsent: function () { return choice; } });
  function boot() {
    if (choice === "accepted") start();
    wire(document);
    // The existing analysis module inserts its form after DOMContentLoaded;
    // shell navigation replaces #view. Observe both without changing its API.
    if (ready && global.MutationObserver) {
      var updates = new global.MutationObserver(function () { wire(document); });
      updates.observe(document.getElementById("view") || document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState !== "loading") boot();
  else document.addEventListener("DOMContentLoaded", boot);
})(window);
