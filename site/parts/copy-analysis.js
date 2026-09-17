/* Copy only a validated, visible AI report.  This is deliberately separate
 * from analyze.js: the analysis worker owns validation and lifecycle; this
 * module owns the user-gesture clipboard affordance. */
(function (global) {
  "use strict";

  var L = global.LANG || {};
  var t = L.t || function (key) { return key; };
  var HOST = "preco" + "demartelo" + ".com";

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>\"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function canonicalLotUrl() {
    var link = null;
    var links = document.querySelectorAll("link");
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute("rel") === "canonical") { link = links[i]; break; }
    }
    if (!link) return "";
    var raw = link.getAttribute("href");
    try {
      var url = new global.URL(raw, global.location && global.location.href);
      if (url.protocol !== "https:" || url.hostname !== HOST) return "";
      var path = url.pathname.replace(/\/+$/, "") + "/";
      if (path.indexOf("/leilao-de-imoveis/") !== 0 || path.indexOf("/lote/") === -1) return "";
      url.search = "";
      url.hash = "";
      url.pathname = path;
      return url.href;
    } catch (e) { return ""; }
  }

  function readable(root) {
    var value = typeof root.innerText === "string" && root.innerText ? root.innerText : root.textContent;
    return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n").trim();
  }

  function owner(root) {
    return root.getAttribute("data-az") || root.getAttribute("data-lot-report") || "";
  }

  function parentOf(node) {
    return node.parentNode || node.parent || node;
  }

  function hostFor(root) {
    return root.getAttribute("data-lot-report") ? parentOf(root) : root;
  }

  function controlsFor(host, key) {
    var all = host.querySelectorAll("[data-copy-analysis]");
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute("data-copy-owner") === key) return all[i];
    }
    return null;
  }

  function detach(node) {
    var parent = node.parentNode || node.parent;
    if (parent && parent.removeChild) parent.removeChild(node);
    else if (parent && parent.children) {
      var index = parent.children.indexOf(node);
      if (index !== -1) parent.children.splice(index, 1);
    }
  }

  function removeFor(host, key) {
    var control = controlsFor(host, key);
    if (control) detach(control);
  }

  function payload(source) {
    var url = canonicalLotUrl();
    var text = readable(source);
    if (!url || !text) return "";
    return text + "\n\n" + t("copy.source") + "\n" + url;
  }

  function mount(root, source) {
    var key = owner(root);
    if (!key) return;
    var host = hostFor(root);
    var text = payload(source);
    if (!text) { removeFor(host, key); return; }
    var control = controlsFor(host, key);
    if (control) {
      control._copySource = source;
      control._copyPayload = function () { return payload(source); };
      return;
    }
    control = document.createElement("div");
    control.setAttribute("data-copy-analysis", "1");
    control.setAttribute("data-copy-owner", key);
    control.className = "copy-analysis-tools";
    control.innerHTML = '<button type="button" class="copy-analysis" data-copy-go>' +
      esc(t("copy.button")) + '</button><p class="copy-analysis-status" role="status" aria-live="polite" tabindex="-1" hidden></p>' +
      '<textarea class="copy-analysis-fallback" aria-label="' + esc(t("copy.fallback.label")) +
      '" readonly hidden rows="8"></textarea>';
    host.appendChild(control);
    var button = control.querySelector("[data-copy-go]");
    var status = control.querySelector(".copy-analysis-status");
    var fallback = control.querySelector(".copy-analysis-fallback");
    control._copySource = source;
    control._copyPayload = function () { return payload(control._copySource); };
    button.addEventListener("click", function () {
      var value = control._copyPayload();
      if (!value) return;
      var write = global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText;
      if (typeof write !== "function") return fail();
      var result;
      try { result = write.call(global.navigator.clipboard, value); } catch (e) { fail(); return; }
      Promise.resolve(result).then(function () {
        fallback.hidden = true;
        status.hidden = false;
        status.textContent = t("copy.success");
        status.focus();
      }, fail);
    });

    function fail() {
      fallback.value = control._copyPayload();
      fallback.hidden = false;
      status.hidden = false;
      status.textContent = t("copy.failure");
      fallback.focus();
      if (typeof fallback.select === "function") fallback.select();
    }
  }

  function wire(root) {
    root = root || document;
    var az = root.querySelectorAll('[data-az]');
    for (var i = 0; i < az.length; i++) {
      var azSource = az[i].getAttribute("data-az-state") === "result" ? az[i].querySelector(".azout") : null;
      if (azSource && readable(azSource)) mount(az[i], azSource);
      else removeFor(hostFor(az[i]), owner(az[i]));
    }
    var reports = root.querySelectorAll('[data-lot-report]');
    for (var j = 0; j < reports.length; j++) {
      var reportSource = reports[j].getAttribute("data-report-state") === "displayed" ? reports[j] : null;
      if (reportSource && readable(reportSource)) mount(reports[j], reportSource);
      else removeFor(hostFor(reports[j]), owner(reports[j]));
    }
  }

  global.COPY_ANALYSIS = { wire: wire };
  if (document.readyState !== "loading") wire();
  else document.addEventListener("DOMContentLoaded", function () { wire(); });
  if (global.MutationObserver) {
    var target = document.documentElement || document.body;
    if (target) new global.MutationObserver(function () { wire(); }).observe(target, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-az-state", "data-report-state"],
    });
  }
})(window);
