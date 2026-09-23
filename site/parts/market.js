(function (global) {
  "use strict";

  /*
   * Pure consumer for a pre-embedded market-v1 report. The exporter can place
   * the JSON on a page later; this slice deliberately owns no fetching,
   * inference, storage, or HTML parsing.
   */
  var L = global.LANG || {};
  var translate = L.t || function (key, params, fallback) {
    var value = fallback || key;
    return String(value).replace(/\{(\w+)\}/g, function (match, name) {
      return params && params[name] != null ? params[name] : match;
    });
  };

  var ALLOWED_ROOT = [
    "schema", "currency", "sale_asking", "discount_pct", "rent_monthly",
    "yield_pct", "condo_monthly", "sample", "disclaimer", "comparables"
  ];
  var ALLOWED_RANGE = ["min", "max"];
  var ALLOWED_SAMPLE = ["count", "radius_m", "freshness_days", "confidence"];
  var CONFIDENCE = ["high", "medium", "low"];
  var CONFIDENCE_LABEL = {
    high: "market.confidence.high",
    medium: "market.confidence.medium",
    low: "market.confidence.low"
  };

  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function integer(value, min, max) {
    return Number.isInteger(value) && value >= min && value <= max;
  }

  function onlyKeys(value, allowed) {
    return object(value) && Object.keys(value).every(function (key) {
      return allowed.indexOf(key) !== -1;
    });
  }

  function validRange(value, maxValue) {
    return onlyKeys(value, ALLOWED_RANGE) &&
      finiteNumber(value.min) && finiteNumber(value.max) &&
      value.min >= 0 && value.max >= value.min && value.max <= maxValue;
  }

  function validOptionalRange(value, maxValue) {
    return value === null || validRange(value, maxValue);
  }

  function validComparable(value) {
    if (!onlyKeys(value, ["source", "url", "observed_at", "price_brl", "area_m2", "price_per_m2", "distance_m"])) return false;
    if (value.source !== "ZAP Imóveis" && value.source !== "Viva Real") return false;
    if (typeof value.url !== "string" || !/^https:\/\/(?:www\.)?(?:zapimoveis\.com\.br|vivareal\.com\.br)\/imove/i.test(value.url) || /[?#\s]/.test(value.url)) return false;
    if (typeof value.observed_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z$/.test(value.observed_at)) return false;
    return finiteNumber(value.price_brl) && value.price_brl > 0 &&
      finiteNumber(value.area_m2) && value.area_m2 > 0 &&
      finiteNumber(value.price_per_m2) && value.price_per_m2 > 0 &&
      finiteNumber(value.distance_m) && value.distance_m >= 0;
  }

  function validReport(report) {
    if (!onlyKeys(report, ALLOWED_ROOT) || report.schema !== "market-v1" ||
        report.currency !== "BRL") return false;

    if (!validRange(report.sale_asking, 100000000000)) return false;
    if (report.discount_pct !== null &&
        (!finiteNumber(report.discount_pct) || report.discount_pct < -100 || report.discount_pct > 100)) return false;
    if (!validOptionalRange(report.rent_monthly, 100000000)) return false;
    if (report.yield_pct !== null &&
        (!finiteNumber(report.yield_pct) || report.yield_pct < 0 || report.yield_pct > 1000)) return false;
    if (!validOptionalRange(report.condo_monthly, 10000000)) return false;

    if (!onlyKeys(report.sample, ALLOWED_SAMPLE) ||
        !integer(report.sample.count, 0, 1000000) ||
        !integer(report.sample.radius_m, 0, 100000) ||
        !integer(report.sample.freshness_days, 0, 3650) ||
        CONFIDENCE.indexOf(report.sample.confidence) === -1) return false;

    return Array.isArray(report.comparables) && report.comparables.length <= 20 &&
      report.comparables.every(validComparable) &&
      typeof report.disclaimer === "string" &&
      report.disclaimer.trim().length > 0 && report.disclaimer.length <= 2000;
  }

  function text(value) {
    return String(value == null ? "" : value);
  }

  function locale() {
    if (L.code === "ru") return "ru-RU";
    if (L.code === "en") return "en-US";
    return "pt-BR";
  }

  function money(value) {
    if (value == null) return translate("market.no_data", null, "—");
    var formatted;
    try {
      formatted = new Intl.NumberFormat(locale(), {
        maximumFractionDigits: 0,
        minimumFractionDigits: 0
      }).format(value);
    } catch (e) {
      formatted = String(Math.round(value));
    }
    return "R$ " + formatted;
  }

  function percent(value) {
    if (value == null) return translate("market.no_data", null, "—");
    var formatted;
    try {
      formatted = new Intl.NumberFormat(locale(), {
        maximumFractionDigits: 1,
        minimumFractionDigits: 0
      }).format(value);
    } catch (e) {
      formatted = String(value);
    }
    return formatted + "%";
  }

  function range(value) {
    return money(value.min) + "–" + money(value.max);
  }

  function number(value) {
    try { return new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(value); }
    catch (e) { return String(Math.round(value)); }
  }

  function node(document, tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.setAttribute("class", className);
    if (value != null) element.textContent = text(value);
    return element;
  }

  function label(document, key) {
    return node(document, "dt", "market-label", translate(key));
  }

  function value(document, content) {
    return node(document, "dd", "market-value", content);
  }

  function addFact(document, list, key, content) {
    list.appendChild(label(document, key));
    list.appendChild(value(document, content));
  }

  function confidenceLabel(confidence) {
    return translate(CONFIDENCE_LABEL[confidence], null, confidence);
  }

  function renderReport(report, document) {
    if (!validReport(report)) return null;
    document = document || global.document;
    if (!document || typeof document.createElement !== "function") return null;

    var section = node(document, "section", "market-report");
    section.setAttribute("data-market-report", "market-v1");

    var heading = node(document, "h2", "market-title", translate("market.title"));
    section.appendChild(heading);

    var note = node(document, "p", "market-intro", translate("market.intro"));
    section.appendChild(note);

    /* A shaped payload is not automatically enough evidence for an estimate.
     * Keep the source's sample metadata visible, but do not turn fewer than
     * five listings into a price range or a discount. */
    if (report.sample.count < 5) {
      section.appendChild(node(document, "p", "market-insufficient",
        translate("market.insufficient", { count: report.sample.count })));
      return section;
    }

    var facts = node(document, "dl", "market-facts");
    addFact(document, facts, "market.sale_asking", range(report.sale_asking));
    addFact(document, facts, "market.discount", report.discount_pct === null
      ? translate("market.no_data") : percent(report.discount_pct));
    if (report.rent_monthly !== null) addFact(document, facts, "market.rent", range(report.rent_monthly));
    if (report.yield_pct !== null) addFact(document, facts, "market.yield", percent(report.yield_pct));
    if (report.condo_monthly !== null) addFact(document, facts, "market.condo", range(report.condo_monthly));
    section.appendChild(facts);

    var sample = node(document, "p", "market-sample");
    sample.appendChild(node(document, "span", "market-sample-count",
      translate("market.sample", { count: report.sample.count })));
    sample.appendChild(node(document, "span", "market-sample-radius",
      translate("market.radius", { radius: report.sample.radius_m })));
    sample.appendChild(node(document, "span", "market-sample-freshness",
      translate("market.freshness", { days: report.sample.freshness_days })));
    sample.appendChild(node(document, "span", "market-sample-confidence",
      translate("market.confidence", { level: confidenceLabel(report.sample.confidence) })));
    section.appendChild(sample);

    if (report.comparables.length) {
      section.appendChild(node(document, "h3", "market-listings-title", translate("market.listings.title")));
      var listings = node(document, "ul", "market-listings");
      report.comparables.forEach(function (item) {
        var entry = node(document, "li", "market-listing");
        var link = node(document, "a", "market-listing-link", item.source);
        link.setAttribute("href", item.url);
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer nofollow");
        entry.appendChild(link);
        entry.appendChild(node(document, "span", "market-listing-detail", " · " + money(item.price_brl) + " · " + number(item.area_m2) + " m² · " + money(item.price_per_m2) + "/m² · " + number(item.distance_m) + " m · " + item.observed_at.slice(0, 10)));
        listings.appendChild(entry);
      });
      section.appendChild(listings);
    } else {
      section.appendChild(node(document, "p", "market-listings-unavailable",
        translate("market.listings.unavailable")));
    }

    var disclaimer = node(document, "p", "market-disclaimer");
    disclaimer.appendChild(node(document, "strong", "market-disclaimer-title",
      translate("market.disclaimer.title")));
    disclaimer.appendChild(node(document, "span", "market-disclaimer-text", report.disclaimer));
    disclaimer.appendChild(node(document, "span", "market-disclaimer-truth",
      translate("market.disclaimer.truth")));
    section.appendChild(disclaimer);

    return section;
  }

  function mount(root, report, document) {
    if (!root || typeof root.appendChild !== "function") return false;
    var rendered = renderReport(report, document);
    if (!rendered) return false;
    root.appendChild(rendered);
    return true;
  }

  global.MARKET = {
    validateReport: validReport,
    renderReport: renderReport,
    mount: mount,
    formatMoney: money,
    formatPercent: percent
  };
})(window);
