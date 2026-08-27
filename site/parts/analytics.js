/* Who reads this site, and what they do with it.
 *
 * Two counters, on purpose. Cloudflare Web Analytics is the honest traffic
 * number: no cookies, no consent question, and it counts the readers who block
 * Google. GA4 is the one that will link to Search Console, so a query in the
 * console can be followed to what the reader did after clicking it — the whole
 * point of measuring an SEO-first site at all.
 *
 * GA4 runs in Consent Mode with everything denied. That is not a placeholder
 * waiting for a banner: with `analytics_storage: denied` the tag sets no
 * cookie and sends a cookieless ping, which under the LGPD needs no consent
 * dialogue and costs this site nothing it would otherwise have. A free tool
 * that answers "is anybody reading Pavuna" does not need to know who they are.
 *
 * Both IDs arrive from the build (repository variables), never from this file.
 * With neither set the whole module is inert, which is what a local checkout
 * and every pre-render run should be.
 */
(function (global) {
  "use strict";

  var CFG = global.__ANALYTICS__ || {};

  /* The pre-render drives a real Chrome through nine thousand pages on every
   * deploy. Without this guard each build would be the site's busiest day. */
  function offline() {
    var h = location.hostname;
    return location.protocol === "file:" ||
      !h || h === "localhost" || h === "127.0.0.1" || h === "[::1]" ||
      /^192\.168\./.test(h) || navigator.webdriver === true;
  }

  function load(src, attrs) {
    var s = document.createElement("script");
    s.async = true;
    s.src = src;
    for (var k in attrs) if (attrs.hasOwnProperty(k)) s.setAttribute(k, attrs[k]);
    document.head.appendChild(s);
  }

  var on = !offline() && !!(CFG.ga4 || CFG.cf);

  if (on && CFG.ga4) {
    global.dataLayer = global.dataLayer || [];
    // Not an arrow and not a rest parameter: gtag reads `arguments` itself,
    // and everything else on this site is ES5 for the same reason.
    function gtag() { global.dataLayer.push(arguments); }
    global.gtag = gtag;
    gtag("consent", "default", {
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "denied",
    });
    gtag("js", new Date());
    gtag("config", CFG.ga4, { anonymize_ip: true });
    load("https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(CFG.ga4));
  }

  if (on && CFG.cf) {
    load("https://static.cloudflareinsights.com/beacon.min.js",
      { "data-cf-beacon": JSON.stringify({ token: CFG.cf }) });
  }

  /* One call for the rest of the site. Inert when analytics is off, so a
   * caller never has to ask whether it is. */
  function track(name, params) {
    if (!on || !global.gtag) return;
    try { global.gtag("event", name, params || {}); } catch (e) { /* never break a page */ }
  }
  global.track = track;

  /* Delegated, because a static page's body was written at build time.
   *
   * Three things worth a name. Everything else GA4's enhanced measurement
   * already counts, and a custom event that duplicates a built-in one only
   * makes the reports harder to read. */
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-out], [data-city], [data-lang]");
    if (!el) return;
    // The click that means the site worked: the reader went to bid.
    if (el.hasAttribute("data-out")) {
      track("lot_outbound", { source: el.getAttribute("data-out"), page: location.pathname });
    } else if (el.hasAttribute("data-city")) {
      track("city_switch", { city: el.getAttribute("data-city") });
    } else if (el.hasAttribute("data-lang")) {
      // Whether anyone outside Portuguese exists here is a real open question;
      // the desk research said no, and this is the measurement that settles it.
      track("lang_switch", { lang: el.getAttribute("data-lang") });
    }
  });
})(window);
