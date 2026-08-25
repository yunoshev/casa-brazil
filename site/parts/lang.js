/* The translation runtime, and the only place a page learns what language it
   is in. Loaded before anything that renders, it publishes one global:

       window.LANG = { code, t, plur, num, pct, money, applyStatic }

   Every visible string lives in i18n/<lang>.json and reaches a page only
   through t(). Nothing that renders may contain prose — adding a language has
   to cost one file, not a pass over a script — and build.py refuses to build
   when a key a page asks for is missing from a catalogue, or when the
   catalogues have drifted apart. */
(function (global) {
  "use strict";

  var L = global.__I18N__ || {};
  var LANGS = Object.keys(L).filter(function (k) { return k.charAt(0) !== "_"; });

  function pick() {
    var q = (location.search.match(/[?&]lang=([\w-]+)/) || [])[1];
    var saved = null;
    try { saved = localStorage.getItem("lang"); } catch (e) { /* private mode */ }
    var want = q || saved;
    if (want && L[want]) return want;
    var nav = (navigator.languages || [navigator.language || ""]).join(",").toLowerCase();
    for (var i = 0; i < LANGS.length; i++) {
      if (nav.indexOf(LANGS[i]) === 0 || nav.indexOf("," + LANGS[i]) !== -1) return LANGS[i];
    }
    return L.pt ? "pt" : LANGS[0];
  }

  var code = pick();
  var M = L[code] || {};
  var names = {};
  LANGS.forEach(function (k) { names[k] = (L[k]._meta && L[k]._meta.name) || k; });
  var locale = (M._meta && M._meta.locale) || "en-US";
  var group = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  var one = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  // Categories differ by language — ru needs one/few/many/other where pt and en
  // need one/other — so the rule comes from the locale, never from a hand-rolled
  // %10 test that only ever knew about Russian.
  var rules = new Intl.PluralRules(locale);

  document.documentElement.lang = code;
  document.documentElement.dir = (M._meta && M._meta.dir) || "ltr";

  function t(key, p, fallback) {
    var s = M[key];
    // A key built from a data value can legitimately miss — a geocoder that
    // starts emitting a new precision label should print the label, not a
    // bracketed key. Anything written by hand still fails loudly.
    if (s == null) return fallback != null ? fallback : "[" + key + "]";
    if (!p) return s;
    return s.replace(/\{(\w+)\}/g, function (m, k) { return p[k] == null ? m : p[k]; });
  }

  /* "22 лотов" is not Russian. The noun is picked by the locale's own plural
     category, so a catalogue carries the forms its language actually has. */
  function plur(base, n) {
    return t(base + "." + rules.select(n), null, t(base + ".other", null, base));
  }

  // ru-RU groups with a full no-break space; in a mono face at display size
  // that reads as two numbers, so narrow it to U+202F for the page.
  function num(v) {
    return v == null ? "—" : group.format(Math.round(v)).replace(/ /g, " ");
  }
  function money(v) { return v == null ? "—" : "R$ " + num(v); }
  function pct(v, sign) {
    if (v == null) return "—";
    var a = Math.abs(v);
    var s = (a < 10 ? one : group).format(a);
    return (v < 0 ? "−" : (sign === false ? "" : "+")) + s + "%";
  }

  function strip(s) { return String(s).replace(/<[^>]+>/g, ""); }
  function applyStatic(root) {
    var set = function (attr, fn) {
      var nodes = (root || document).querySelectorAll("[" + attr + "]");
      for (var i = 0; i < nodes.length; i++) fn(nodes[i], nodes[i].getAttribute(attr));
    };
    set("data-i18n", function (el, k) { el.innerHTML = t(k); });
    set("data-i18n-title", function (el, k) { el.setAttribute("title", strip(t(k))); });
    set("data-i18n-content", function (el, k) { el.setAttribute("content", strip(t(k))); });
    set("data-i18n-aria", function (el, k) { el.setAttribute("aria-label", strip(t(k))); });
  }

  /* A page offers the other languages as ordinary links to `?lang=xx`, so they
     work with no JS and a crawler can follow them. This only records the
     choice, so the next visit to a bare URL keeps it instead of falling back
     to whatever the browser asks for. */
  function remember(want) {
    try { localStorage.setItem("lang", want); } catch (e) { /* private mode */ }
  }

  global.LANG = {
    code: code, langs: LANGS, names: names, meta: M._meta || {}, remember: remember,
    t: t, plur: plur, num: num, money: money, pct: pct, applyStatic: applyStatic,
  };
})(window);
