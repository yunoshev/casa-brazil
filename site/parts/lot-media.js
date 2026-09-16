"use strict";
/* Static lot pages do not load app.js. This owns only DOM behaviour for the
 * gallery and the deliberately opt-in Google Maps Embed frame. */
(function () {
  function t(key) { return window.LANG && window.LANG.t ? window.LANG.t(key) : key; }
  function mapsKey() {
    var m = window.__MAPS__;
    return m && typeof m.embedKey === "string" && m.embedKey.trim() ? m.embedKey.trim() : null;
  }
  function wire(root) {
    if (!root) return;
    [].forEach.call(root.querySelectorAll("[data-lot-thumb]"), function (img) {
      if (img.dataset.lotMediaWired) return;
      img.dataset.lotMediaWired = "1";
      img.addEventListener("error", function () { if (img.parentNode) img.parentNode.innerHTML = ""; });
    });
    [].forEach.call(root.querySelectorAll("[data-gallery]"), function (box) {
      if (box.dataset.lotMediaWired) return;
      box.dataset.lotMediaWired = "1";
      var images = [].slice.call(box.querySelectorAll(".gallery-image")), current = 0;
      function show(next) {
        if (!images.length) { box.remove(); return; }
        current = (next + images.length) % images.length;
        images.forEach(function (img, i) { img.className = "shot gallery-image" + (i === current ? "" : " hid"); });
        var count = box.querySelector(".gallery-count");
        if (count) count.textContent = (current + 1) + " / " + images.length;
      }
      images.forEach(function (img) { img.addEventListener("error", function () {
        images.splice(images.indexOf(img), 1); img.remove(); show(Math.min(current, images.length - 1));
      }); });
      var prev = box.querySelector(".gallery-prev"), next = box.querySelector(".gallery-next");
      if (prev) prev.addEventListener("click", function () { show(current - 1); });
      if (next) next.addEventListener("click", function () { show(current + 1); });
      box.addEventListener("keydown", function (event) {
        if (event.key === "ArrowLeft") { event.preventDefault(); show(current - 1); }
        if (event.key === "ArrowRight") { event.preventDefault(); show(current + 1); }
      });
    });
    [].forEach.call(root.querySelectorAll("[data-lot-map]"), function (box) {
      if (box.dataset.lotMediaWired) return;
      var key = mapsKey();
      if (!key) return; // absent key means the entire map block remains off
      box.hidden = false; box.dataset.lotMediaWired = "1";
      var button = box.querySelector(".map-load"), frame = box.querySelector(".lot-map-frame");
      if (!button || !frame) return;
      button.addEventListener("click", function () {
        if (frame.querySelector("iframe")) { frame.textContent = ""; button.textContent = t("lot.map.load"); return; }
        var query = box.getAttribute("data-map-query");
        if (!query) return;
        var iframe = document.createElement("iframe");
        iframe.className = "lot-map-embed"; iframe.setAttribute("title", t("lot.map.iframe"));
        iframe.setAttribute("loading", "lazy"); iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
        iframe.setAttribute("allowfullscreen", "");
        iframe.src = "https://www.google.com/maps/embed/v1/place?key=" + encodeURIComponent(key) + "&q=" + encodeURIComponent(query);
        frame.appendChild(iframe); button.textContent = t("lot.map.hide");
      });
    });
  }
  function boot() { wire(document); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  new MutationObserver(boot).observe(document.documentElement, { childList: true, subtree: true });
  window.LOT_MEDIA = { wire: wire };
}());
