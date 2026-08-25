/* The header, and nothing else.
 *
 * Split out of app.js because two very different pages need exactly this and
 * nothing more: the single-page shell the build renders from, and the seven
 * thousand flat files it writes. A static page has no dataset and no renderer
 * — every link on it is a real URL and every URL is a real file — so the only
 * script it ships is the part that cannot be expressed as a link: the theme,
 * and the city menu's open/close.
 *
 * Expects window.LANG (parts/lang.js) and, for the menu, window.__CITIES__:
 * a small array of {slug, uf, cslug, nome, sub} written into the page by the
 * build. The whole file is inert if the header is not there.
 */
(function (global) {
  "use strict";

  var t = (global.LANG && global.LANG.t) || function (k) { return k; };
  function $(id) { return document.getElementById(id); }

  /* ---- theme ------------------------------------------------------
   *
   * Three states, not two: "system" is the default and stamps nothing, so the
   * page follows the OS until the reader overrides it. Nothing needs redrawing
   * on a switch any more — the map's fills are stylesheet tokens now, which is
   * what makes a page rendered once at build time correct on both themes. */
  var THEMES = ["system", "light", "dark"];
  var ICONS = {
    system: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 010 18z" fill="currentColor"/>',
    light: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4' +
      'M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    dark: '<path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"/>',
  };
  var KEY = { system: "nav.theme.system", light: "nav.theme.light", dark: "nav.theme.dark" };

  function readTheme() {
    try { return localStorage.getItem("theme") || "system"; } catch (e) { return "system"; }
  }

  function applyTheme(th) {
    if (th === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", th);
    var icon = $("themeicon");
    if (icon) icon.innerHTML = ICONS[th];
    var btn = $("theme");
    if (btn) {
      btn.title = t(KEY[th]);
      btn.setAttribute("aria-label", t("nav.theme"));
    }
  }

  /* ---- city menu -------------------------------------------------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function closeMenu() {
    var m = $("citymenu");
    if (!m || m.hidden) return;
    m.hidden = true;
    $("citypick").setAttribute("aria-expanded", "false");
  }

  function paint() {
    var here = (global.__HERE__ || {}).city || "";
    var name = $("cityname");
    var mine = (global.__CITIES__ || []).filter(function (c) { return c.slug === here; })[0];
    // The country page is in no city, and a control with an empty label reads
    // as broken rather than as neutral.
    if (name) name.textContent = mine ? mine.nome : t("nav.city.pick");
    paintMenu(here);
  }

  function paintMenu(here) {
    var list = global.__CITIES__ || [];
    var menu = $("citymenu");
    if (!menu || !list.length) return;
    menu.innerHTML = list.map(function (c) {
      var on = c.slug === here;
      var url = (global.__BASE__ || "") + "/leilao-de-imoveis/" +
        (c.uf ? c.uf + "/" : "") + (c.cslug || c.slug) + "/";
      return '<a class="mi' + (on ? " on" : "") + '" href="' + esc(url) +
        '" data-city="' + esc(c.slug) + '" role="option" aria-selected="' + on +
        '"><span class="mn">' + esc(c.nome) + '</span><span class="ms">' +
        esc(c.sub || "") + "</span></a>";
    }).join("");
    // The anchor navigates on its own; this only records where the reader went,
    // so the next bare visit opens on the same city.
    [].forEach.call(menu.querySelectorAll("[data-city]"), function (a) {
      a.addEventListener("click", function () {
        try { localStorage.setItem("city", a.dataset.city); } catch (e) { /* private mode */ }
      });
    });
  }

  /* Called twice on the single-page shell — once by app.js as soon as it has
     built the city list, once by DOMContentLoaded — and once on a static page.
     Listeners are attached on the first call only; the paint runs every time. */
  var wired = false;

  function boot() {
    if (global.LANG && global.LANG.applyStatic) global.LANG.applyStatic();
    applyTheme(readTheme());
    paint();
    if (wired) return;
    wired = true;

    var btn = $("theme");
    if (btn) {
      btn.addEventListener("click", function () {
        var next = THEMES[(THEMES.indexOf(readTheme()) + 1) % THEMES.length];
        try { localStorage.setItem("theme", next); } catch (e) { /* private mode */ }
        applyTheme(next);
        if (global.__onTheme__) global.__onTheme__();
      });
    }

    var pick = $("citypick");
    if (pick) {
      pick.addEventListener("click", function (e) {
        e.stopPropagation();
        var m = $("citymenu");
        m.hidden = !m.hidden;
        pick.setAttribute("aria-expanded", String(!m.hidden));
      });
    }
    document.addEventListener("click", closeMenu);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeMenu();
    });
    // Any link to a city, wherever it sits — the header menu, the strip on a
    // city page, the list on the front page — records where the reader went so
    // the next bare visit opens there. Delegated, because a static page's body
    // was written at build time and has nothing to attach listeners in it.
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest("[data-city]");
      if (!a) return;
      try { localStorage.setItem("city", a.dataset.city); } catch (err) { /* private mode */ }
    });
    // Language links are ordinary anchors; this only records the choice.
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest("[data-lang]");
      if (a && global.LANG && global.LANG.remember) global.LANG.remember(a.dataset.lang);
    });
  }

  global.CHROME = { boot: boot, paint: paint, applyTheme: applyTheme, readTheme: readTheme };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
