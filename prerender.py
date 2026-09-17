#!/usr/bin/env python3
"""Turn the single-page build into one file per URL.

The site's product is a number. A number that is born in app.js and never
reaches the HTML does not exist for anything that will not run JavaScript —
and the crawlers behind ChatGPT, Claude and Perplexity measurably do not
(Vercel/MERJ, 569M GPTBot and 370M ClaudeBot requests: they fetch script files
and never execute them). Google will render eventually; they never will. So
the markup is produced here, at build time, and shipped flat.

How: load site/v2/index.html once in headless Chrome — the whole dataset, two
and a half megabytes, parsed a single time — and then ask `window.__render__`
for one path after another. No navigation, no reload, nothing re-parsed, so a
route costs milliseconds and every route in the site costs minutes.

The routes come from the data, not from a list kept by hand: the walk starts at
the front page and follows the links each rendered page reports, which means a
page nobody links to is a page that does not get written. That is the intended
behaviour — an orphan is a bug in the site, not in the build.

Run: .venv/bin/python -u experiments/brazil/prerender.py [--out dist]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit

import websockets
from public_config import analysis_script_src, app_script_src, privacy_page, snippet
from release_check import validate_release_site_url
from release_promotion import observed_partial_without_global_freshness
from seo import (
    breadcrumbs,
    canonical_url,
    data_date,
    prerender_date,
    route_file,
    sitemap_documents,
    validate_page,
    validate_site_url,
)

HERE = Path(__file__).parent
SITE = HERE / "site"


def _chrome_bin() -> str:
    """Wherever this machine keeps its Chrome.

    CI (ubuntu-latest) has google-chrome on PATH, a Mac keeps it under
    /Applications, and CHROME_BIN overrides both when neither guess is right.
    """
    for p in (
        os.environ.get("CHROME_BIN"),
        shutil.which("google-chrome"),
        shutil.which("chromium-browser"),
        shutil.which("chromium"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ):
        if p and Path(p).exists():
            return p
    raise SystemExit("no Chrome found — install one or point CHROME_BIN at it")


#: Static files are published in Brazilian Portuguese. The source shell also
#: supports other languages; this build does not emit separate locale URLs.
LANG = "pt"

#: Everything a page needs that is not the page. Copied, not linked, so the
#: output directory is the whole site.
ASSETS = (
    "favicon.svg",
    "v2/style.css",
    "v2/fonts/bricolage.woff2",
    "v2/fonts/instrument.woff2",
    "v2/fonts/martian.woff2",
    "parts/lang.js",
    "parts/chrome.js",
    "parts/geo.js",
    "parts/analyze.js",
    "parts/copy-analysis.js",
    "parts/analytics.js",
    "parts/market.js",
    "v2/app.js",
    "data/market_reports.json",
)

# A local preview must not need a release candidate/receipt. Strict releases
# add these byte-attested files after proto_build has generated them.
RELEASE_ASSETS = ("lifecycle-release.json", "lifecycle-projection.json")


def asset_paths(*, release: bool) -> tuple[str, ...]:
    return (*ASSETS, *RELEASE_ASSETS) if release else ASSETS


def payload_date(payload: dict[str, Any], *, asserted: str, release: bool) -> str | None:
    """Keep the release date rule aligned with the lifecycle release mode."""
    if not isinstance(payload, dict):
        raise ValueError("runtime payload must be an object")
    partial_release = release and observed_partial_without_global_freshness(payload)
    return cast(
        str | None,
        prerender_date(
            payload.get("generated"), asserted=asserted, release=release and not partial_release
        ),
    )


def chrome(port: int, profile: Path) -> subprocess.Popen:
    for lock in profile.glob("Singleton*"):
        lock.unlink(missing_ok=True)
    return subprocess.Popen(
        [
            _chrome_bin(),
            "--headless=new",
            "--disable-gpu",
            # Ubuntu 24.04 (today's ubuntu-latest) blocks unprivileged user
            # namespaces, so Chrome's sandbox cannot start in CI. This tool
            # renders only its own localhost pages, so the sandbox buys
            # nothing here; /dev/shm in a runner is too small for a real tab.
            "--no-sandbox",
            "--disable-dev-shm-usage",
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile}",
            "--window-size=414,900",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        # In CI the browser's own complaint is the only clue a failed start
        # leaves behind; locally it is just noise.
        stderr=None if os.environ.get("CI") else subprocess.DEVNULL,
    )


def wait_for(url: str, tries: int = 200) -> dict[str, Any]:
    for _ in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                response = json.load(r)
                if isinstance(response, dict):
                    return response
                raise ValueError("Chrome version response is not an object")
        except (urllib.error.URLError, OSError, TimeoutError):
            time.sleep(0.1)
    raise SystemExit(f"Chrome не поднялся на {url}")


class Tab:
    """One CDP connection, one `Runtime.evaluate` at a time."""

    def __init__(self, ws):
        self.ws = ws
        self.n = 0

    async def send(self, method: str, **params):
        self.n += 1
        await self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    async def js(self, expr: str):
        r = await self.send("Runtime.evaluate", expression=expr, returnByValue=True)
        got = r.get("result", {})
        if r.get("exceptionDetails"):
            raise RuntimeError(detail(r["exceptionDetails"]))
        return got.get("value")

    async def settled(self, expr: str, tries: int = 60):
        """Evaluate once the page has stopped moving under us.

        The shell redirects on load. Between the poll that sees `__render__`
        and the next call, a slow runner can navigate away — the execution
        context dies and CDP answers with a bare "Uncaught" that names
        nothing. Waiting for the renderer again and retrying is the whole fix;
        a real error in the expression survives every attempt and is raised.
        """
        last = ""
        for _ in range(tries):
            try:
                return await self.js(expr)
            except RuntimeError as e:
                last = str(e)
                await asyncio.sleep(0.25)
                for _ in range(600):
                    if await self.js("typeof window.__render__ === 'function' && !!window.__D__"):
                        break
                    await asyncio.sleep(0.1)
        raise RuntimeError(f"страница не устоялась: {last}")


async def alive(tab, expr: str) -> bool:
    """A poll that treats "the context just died" as "not ready yet"."""
    try:
        return bool(await tab.js(expr))
    except RuntimeError:
        return False


def detail(ex: dict) -> str:
    """Everything Chrome knows about a thrown exception, on one line.

    `exceptionDetails["text"]` alone is "Uncaught" — true, and useless from a
    CI log an hour after the fact.
    """
    val = ex.get("exception") or {}
    where = f"{ex.get('lineNumber', '?')}:{ex.get('columnNumber', '?')}"
    said = val.get("description") or val.get("value") or ex.get("text") or "JS threw"
    return f"{said} @ {ex.get('url') or 'eval'}:{where}"


def blob(obj) -> str:
    # "</" inside a string would close the script tag early.
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


#: The path GitHub serves a project site under ("/casa-brazil"), empty on a
#: real domain. Derived from --site once; a page baked for the root breaks
#: every stylesheet and map the moment Pages puts it in a subfolder.
BASE = ""


def rebase(html: str) -> str:
    """Prefix every root-absolute href/src with BASE.

    The regex touches attributes only: canonical, sitemap and breadcrumb URLs
    are already built from the full --site value, and the inline data blobs
    carry slugs, not paths. Protocol-relative "//" is left alone.
    """
    if not BASE:
        return html

    def add_base(match: re.Match[str]) -> str:
        attribute, value = match.group(1), match.group(2)
        if value == BASE or value.startswith(BASE + "/"):
            return match.group(0)
        return f'{attribute}="{BASE}{value}"'

    return re.sub(r'\b(href|src)="(/(?!/)[^"]*)"', add_base, html)


#: Codepoints the shipped webfonts were cut to (`fonts_build.py` writes it).
#: Loaded once; empty when the file is missing, which turns the check off
#: rather than failing a build on a machine that has not run the font tool.
def font_charset() -> set[str]:
    f = SITE / "v2" / "fonts" / "charset.json"
    if not f.exists():
        return set()
    return {chr(c) for c in json.loads(f.read_text())}


def missing_glyphs(text: str, allowed: set[str]) -> set[str]:
    """Characters a reader would see in a fallback face.

    The fonts are subset to what the data contains, so this is the tripwire on
    that decision: the day a district name arrives with a letter outside the
    set, the build says which letter instead of quietly rendering one word in
    Helvetica on nine thousand pages.
    """
    if not allowed:
        return set()
    return {c for c in set(text) if c not in allowed and c.isprintable() and not c.isspace()}


def analytics(site: str) -> str:
    """Public API/privacy config is independent of optional consent-gated GA."""
    rendered = snippet(site)
    if not isinstance(rendered, str):
        raise TypeError("public analytics snippet must be text")
    return rendered


ANALYTICS = ""


def shell(
    tpl: str,
    head: dict,
    body: str,
    split: bool,
    ld: list,
    chrome: dict,
    home: bool = False,
    lot: bool = False,
) -> str:
    """One rendered screen, wrapped in the page it ships as."""
    scripts = "\n".join(f'<script type="application/ld+json">{blob(x)}</script>' for x in ld if x)
    return (
        tpl.replace("__I18N_DATA__", blob(chrome["i18n"]))
        .replace("__CITIES_DATA__", blob(chrome["cities"]))
        .replace("__HERE_DATA__", blob(chrome["here"]))
        .replace("__BASE_DATA__", json.dumps(BASE))
        .replace("__TITLE__", esc_attr(head["title"]))
        .replace("__DESC__", esc_attr(head["desc"]))
        .replace("__CANONICAL__", esc_attr(head["canonical"]))
        .replace("__ROBOTS__", "noindex, follow" if head.get("noindex") else "index, follow")
        .replace("__LD__", scripts)
        .replace("__CLASS__", "wrap" + (" lot-page" if lot else "") + (" split" if split else ""))
        .replace("__BODY__", body)
        .replace("__COUNTERS__", ANALYTICS)
        .replace("__HOME_GEO__", '<script src="/parts/geo.js" defer></script>' if home else "")
        .replace('src="/parts/analyze.js"', f'src="{analysis_script_src()}"')
        .replace('src="/v2/app.js"', f'src="{app_script_src()}"')
    )


def complete_head(html: str) -> str:
    """Apply required static head links to auxiliary generated pages."""
    additions: list[str] = []
    if 'rel="icon"' not in html:
        additions.append('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')
    if 'property="og:url"' not in html:
        match = re.search(r'<link rel="canonical" href="([^"]+)">', html)
        if match:
            additions.append(f'<meta property="og:url" content="{match.group(1)}">')
    return html if not additions else html.replace("</head>", "\n".join(additions) + "\n</head>", 1)


#: Every hole the template has. Listed rather than pattern-matched, because
#: the page legitimately contains `window.__I18N__` and friends — and that is
#: precisely the hazard: a marker named after the global it is assigned to
#: matches its own left-hand side and eats both halves of the line. Third time
#: that has happened here, so the names are now deliberately distinct and the
#: build checks that every one of them was consumed.
MARKERS = (
    "__I18N_DATA__",
    "__BASE_DATA__",
    "__CITIES_DATA__",
    "__HERE_DATA__",
    "__TITLE__",
    "__DESC__",
    "__CANONICAL__",
    "__ROBOTS__",
    "__LD__",
    "__CLASS__",
    "__BODY__",
    # Fourth time: the hole is __COUNTERS__ and the global it fills in is
    # window.__ANALYTICS__ *on purpose*. Naming them alike makes the inserted
    # snippet match the marker it just replaced, and the check below fires on
    # a page that is in fact correct.
    "__COUNTERS__",
    "__HOME_GEO__",
)


def esc_attr(s: str) -> str:
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


#: Anything in `parts/` that looks like a catalogue key. A flat page's body was
#: written at build time and never re-renders, so the only strings its runtime
#: can still need are the header's — five of them, against a hundred and fifty
#: in the catalogue. Shipping the whole thing to every page cost 10 KB of the
#: average 19 KB, which is to say half the site was one JSON file repeated
#: seven thousand times.
#:
#: Scanned rather than listed, because chrome.js reaches some of these through
#: a lookup table and a hand-kept list would drift. If the scan comes back
#: without the theme keys the regex has stopped matching, and the build says so
#: instead of shipping pages whose only visible string is a key name.
KEY_RE = re.compile(r"""["']([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)["']""")
# `plur()` receives a translation-key base and resolves the locale-specific
# `.one`, `.few`, `.many`, or `.other` key at runtime. Those bases are not
# catalogue entries themselves, so do not make the static key audit reject a
# shipped runtime merely because app.js contains a pluralized label.
PLURAL_CALL_RE = re.compile(r"\bplur\([^;\n]{0,160}")
KEY_CANARY = "nav.theme"


def runtime_keys() -> set[str]:
    keys: set[str] = set()
    plural_bases: set[str] = set()
    for rel in ASSETS:
        if rel.endswith(".js"):
            source = (SITE / rel).read_text()
            keys |= set(KEY_RE.findall(source))
            for call in PLURAL_CALL_RE.findall(source):
                plural_bases |= set(KEY_RE.findall(call))
    if KEY_CANARY not in keys:
        raise SystemExit(
            f"в parts/*.js не нашлось даже {KEY_CANARY!r} — разбор ключей сломан, "
            f"страницы уехали бы с именами ключей вместо слов"
        )
    return keys - plural_bases


#: Written into every output directory this script creates. `--out` is emptied
#: before a run, and emptying a directory somebody typed by hand is not this
#: script's business — so it refuses unless it can see its own mark.
STAMP = ".prerender-output"


def prepare(out: Path) -> None:
    if out.exists() and any(out.iterdir()) and not (out / STAMP).exists():
        raise SystemExit(
            f"{out} не пуст и не помечен как вывод сборки — удалите его сами, "
            f"если он действительно ваш"
        )
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    (out / STAMP).write_text("written by prerender.py\n")


#: One sitemap file holds at most this many URLs by the protocol; splitting on
#: what the page IS rather than on a running count means the index says
#: something — districts here, lots there — the way Spy Leilões separates its
#: two trees and Zukerman's single flat file does not.
SITEMAP_MAX = 45_000

#: Routes that ship as a bare file rather than as a directory with an index.
#: GitHub Pages, Netlify and nginx all look for `404.html` at the site root and
#: nowhere else, so the not-found page cannot live at `/404/index.html` — and
#: it must stay out of the sitemap, which is a list of pages that exist.
FLAT = {"/404": "404.html"}


def write_sitemap(
    out: Path,
    emitted: dict,
    site: str,
    when: str | None,
    *,
    route_dates: dict[str, str] | None = None,
) -> None:
    """Only validated, indexable files written during THIS run enter the sitemap."""
    pages = {}
    urls = {canonical_url(site, p) for p in emitted if route_file(p) != "404.html"}
    for path in emitted:
        html = (out / route_file(path)).read_text()
        facts = validate_page(html, path, site, emitted_urls=urls)
        pages[path] = not facts.noindex
    for name, xml in sitemap_documents(
        pages, site, when, route_dates=route_dates, chunk_size=SITEMAP_MAX
    ).items():
        (out / name).write_text(xml)


def write_robots(out: Path, site: str) -> None:
    """Open to everything, including the crawlers that answer questions.

    Nothing here is behind a login and nothing is worth hiding — the whole
    argument for this site is that its numbers are public where everyone
    else's are gated. The AI crawlers are named explicitly rather than left to
    the wildcard so the intent is on the record: we want to be the answer.
    """
    out.joinpath("robots.txt").write_text(
        "User-agent: *\n"
        f"Disallow: {BASE}/_home/\n"
        "Allow: /\n\n"
        "# Named on purpose. This site exists to be quoted.\n"
        f"User-agent: GPTBot\nDisallow: {BASE}/_home/\nAllow: /\n\n"
        f"User-agent: OAI-SearchBot\nDisallow: {BASE}/_home/\nAllow: /\n\n"
        f"User-agent: ClaudeBot\nDisallow: {BASE}/_home/\nAllow: /\n\n"
        f"User-agent: PerplexityBot\nDisallow: {BASE}/_home/\nAllow: /\n\n"
        f"User-agent: Google-Extended\nDisallow: {BASE}/_home/\nAllow: /\n\n"
        f"Sitemap: {site}/sitemap.xml\n"
    )


async def run(a, ws_url: str, tpl: str, out: Path) -> None:
    try:
        async with websockets.connect(ws_url, max_size=64_000_000) as ws:
            tab = Tab(ws)
            await tab.send("Page.enable")
            # The rendered HTML intentionally contains lazy Google Maps
            # iframes for readers. Block their network requests only in this
            # build-time Chrome session: the final HTML still keeps the iframe
            # and visitors load it normally in their own browser.
            await tab.send("Network.enable")
            await tab.send(
                "Network.setBlockedURLs",
                urls=["https://www.google.com/maps/embed/*"],
            )
            # Straight at the shell, never at "/": the root still belongs to
            # the front end this one replaces, and a build that silently
            # rendered the old page would be very hard to notice.
            seed = f"{a.base}{a.shell}?lang={LANG}"
            await tab.send("Page.navigate", url=seed)
            for _ in range(600):
                if await alive(tab, "typeof window.__render__ === 'function' && !!window.__D__"):
                    break
                await asyncio.sleep(0.1)
            else:
                raise SystemExit("страница не поднялась — __render__ не появился")

            cities = await tab.settled(
                "JSON.stringify(__D__.cities.map(function(c){"
                "return {uf:c.uf, cslug:c.cslug||c.slug};}))"
            )
            cities = json.loads(cities)
            city_paths = [
                "/leilao-de-imoveis/" + (c["uf"] + "/" if c["uf"] else "") + c["cslug"] + "/"
                for c in cities
            ]
            # "/" first in the queue: it is where every link from outside lands,
            # and it is the one page the walk cannot discover, because nothing
            # in a body links up to it — the brand lives in the template.
            queue = ["/"] + city_paths
            glyphs = font_charset()
            unknown: set[str] = set()
            # The shell has no route of its own, so it redirects on load — and
            # the redirect drops the ?lang= that was on it, after which the
            # runtime falls back to whatever this browser profile happens to
            # remember. Land on a real path instead, where nothing redirects.
            # A city path, not queue[0]: "/" is a page this build has yet to
            # write, and until it exists the dev server answers it with the
            # front end this one replaces — which has no renderer at all.
            await tab.send("Page.navigate", url=f"{a.base}{city_paths[0]}?lang={LANG}")
            for _ in range(600):
                if await alive(tab, "typeof window.__render__ === 'function'"):
                    break
                await asyncio.sleep(0.1)
            else:
                raise SystemExit(f"{city_paths[0]} не поднялась — рендерер не появился")

            got_lang = await tab.settled("window.LANG && window.LANG.code")
            if got_lang != LANG:
                raise SystemExit(
                    f"страница отрисовалась на {got_lang!r}, а не {LANG!r} — "
                    f"сборка на чужом языке хуже, чем несобранная"
                )

            # Tell the renderer which catalogues will actually travel with a
            # page, so it does not offer the reader languages the file cannot
            # switch into.
            await tab.settled("window.__SHIP_LANGS__ = " + json.dumps([LANG]))

            # The header's own data, read once. Only the shipped language's
            # catalogue travels with the pages; the others stay behind with the
            # single-page shell, because nothing on a flat page can re-render
            # into them anyway.
            want = runtime_keys()
            whole = json.loads(
                await tab.settled("JSON.stringify(__I18N__[" + json.dumps(LANG) + "])")
            )
            missing = sorted(want - set(whole))
            if missing:
                raise SystemExit(f"каталог {LANG} не знает ключей рантайма: {missing}")
            i18n = {LANG: {k: v for k, v in whole.items() if k in want or k == "_meta"}}
            menu = json.loads(await tab.settled("JSON.stringify(window.__CITIES__ || [])"))
            runtime_payload = json.loads(await tab.settled("JSON.stringify(__D__)"))
            a.generated = payload_date(runtime_payload, asserted=a.generated, release=a.release)

            queue += list(FLAT)
            seen, written, t0 = set(queue), 0, time.time()
            emitted = {}
            route_dates = {}
            inbound_routes: set[str] = set()
            lot_titles: dict[str, str] = {}
            lot_descriptions: dict[str, str] = {}

            while queue:
                path = queue.pop(0)
                got = await tab.js("JSON.stringify(window.__render__(" + json.dumps(path) + "))")
                if got in (None, "null"):
                    print(f"  пропуск (не маршрут): {path}", flush=True)
                    continue
                page = json.loads(got)
                head = dict(page["head"], canonical=canonical_url(a.site, path))
                head["noindex"] = path in FLAT or head.get("noindex", False)
                if "/lote/" in path and not head["noindex"]:
                    for label, value, registry in (
                        ("title", head.get("title"), lot_titles),
                        ("description", head.get("desc"), lot_descriptions),
                    ):
                        if not isinstance(value, str) or not value.strip():
                            raise SystemExit(f"{path}: lot {label} is empty")
                        previous = registry.get(value)
                        if previous is not None:
                            raise SystemExit(
                                f"duplicate lot {label}: {previous} and {path}"
                            )
                        registry[value] = path
                html = shell(
                    tpl,
                    head,
                    page["body"],
                    page["split"],
                    [],  # Add entity breadcrumbs once the actual-write set is known.
                    {
                        "i18n": i18n,
                        "cities": menu,
                        "here": {"city": page["city"] or ("sao-paulo-sp" if path == "/" else "")},
                    },
                    path == "/",
                    page.get("lot", False),
                )
                left = [m for m in MARKERS if m in html]
                if left:
                    raise SystemExit(f"в {path} остались маркеры шаблона: {sorted(left)}")
                # Only the visible text: markup and inline data never reach a
                # font. Collected, not raised — one stray character deserves a
                # line at the end, not nine thousand dead builds.
                unknown |= missing_glyphs(re.sub(r"<[^>]+>", " ", page["body"]), glyphs)
                # lstrip, because the country page strips down to "" and
                # `out / "/index.html"` is not out at all — pathlib treats an
                # absolute right-hand side as the whole answer, and this one
                # points at the root of the disk.
                rel = route_file(path)
                target = out / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                html = rebase(complete_head(html))
                validate_page(html, path, a.site)
                target.write_text(html)
                emitted[path] = page.get("breadcrumbs", [])
                if page.get("lastmod"):
                    route_dates[path] = page["lastmod"]
                written += 1
                if written % 250 == 0:
                    rate = written / max(time.time() - t0, 1e-6)
                    print(f"  {written} страниц, {rate:.0f}/с, в очереди {len(queue)}", flush=True)
                if a.limit and written >= a.limit:
                    break
                for href in page["links"]:
                    href = href.split("#")[0].split("?")[0]
                    if href.startswith("/leilao-de-imoveis/") and href not in seen:
                        seen.add(href)
                        queue.append(href)
                    if href.startswith("/leilao-de-imoveis/"):
                        inbound_routes.add(href)

            orphan_lots = sorted(
                path for path in emitted if "/lote/" in path and path not in inbound_routes
            )
            if orphan_lots:
                sample = ", ".join(orphan_lots[:5])
                raise SystemExit(f"{len(orphan_lots)} emitted lot pages have no internal link: {sample}")

            # Map fragments are not routes: no document shell/canonical and no
            # sitemap entry. The current payload contains five supported cities.
            slugs = json.loads(
                await tab.settled("JSON.stringify(__D__.cities.map(function(c){return c.slug;}))")
            )
            for slug in slugs:
                fragment = await tab.settled(
                    "window.__homeCityFragment__(" + json.dumps(slug) + ")"
                )
                if not fragment:
                    raise SystemExit(f"home fragment missing for {slug}")
                target = out / "_home" / f"{slug}.html"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(rebase(fragment))

            if unknown:
                print(
                    f"  ВНИМАНИЕ: {len(unknown)} символов нет в подрезанных шрифтах, "
                    f"читатель увидит их системным начертанием: "
                    f"{' '.join(sorted(unknown))}\n"
                    f"  добавьте их в EXTRA в fonts_build.py и пересоберите шрифты",
                    flush=True,
                )
            # The notice is a real static route even before collection is enabled.
            # Missing operator settings produce a noindex notice and no email form.
            privacy_path = "/privacidade/"
            target = out / route_file(privacy_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(rebase(complete_head(privacy_page(a.site))))
            emitted[privacy_path] = []
            written += 1

            # Partial builds may not reach a district linked by an early lot.
            # Such ancestors must not become nonexistent JSON-LD targets.
            urls = {canonical_url(a.site, p) for p in emitted if route_file(p) != "404.html"}
            for path, trail in emitted.items():
                ld = breadcrumbs(trail, a.site, emitted)
                if ld:
                    target = out / route_file(path)
                    html = target.read_text().replace(
                        "</head>",
                        f'<script type="application/ld+json">{blob(ld)}</script>\n</head>',
                    )
                    validate_page(html, path, a.site, emitted_urls=urls)
                    target.write_text(html)
            write_sitemap(out, emitted, a.site, a.generated, route_dates=route_dates)
            write_robots(out, a.site)

            for rel in asset_paths(release=a.release or a.legacy_baseline_release):
                dst = out / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(SITE / rel, dst)

            secs = time.time() - t0
            print(
                f"{written} страниц за {secs:.0f} с ({written / max(secs, 1e-6):.0f}/с) → {out}",
                flush=True,
            )
    finally:
        pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "dist"))
    ap.add_argument("--base", default="http://127.0.0.1:8899")
    ap.add_argument(
        "--site",
        default=os.environ.get("SITE_URL", ""),
        help="public HTTPS site URL, including GitHub Pages subpath if used",
    )
    release_mode = ap.add_mutually_exclusive_group()
    release_mode.add_argument(
        "--release", action="store_true", help="require documented payload date"
    )
    release_mode.add_argument(
        "--legacy-baseline-release",
        action="store_true",
        help="strict lifecycle baseline with intentionally null source freshness",
    )
    ap.add_argument("--shell", default="/v2/index.html")
    ap.add_argument(
        "--generated",
        default="",
        help="optional assertion of payload date; never overrides missing/different metadata",
    )
    ap.add_argument("--port", type=int, default=9340)
    ap.add_argument("--limit", type=int, default=0, help="stop after N pages (a smoke run)")
    a = ap.parse_args()
    try:
        a.site = (
            validate_release_site_url(a.site)
            if a.release or a.legacy_baseline_release
            else validate_site_url(a.site)
        )
        a.generated = data_date(a.generated)
    except ValueError as exc:
        ap.error(str(exc))
    global BASE, ANALYTICS
    BASE = urlsplit(a.site).path
    ANALYTICS = analytics(a.site)
    if BASE:
        print(f"базовый путь: {BASE} (сайт живёт в подпапке)", flush=True)
    out = Path(a.out)
    prepare(out)
    tpl = (SITE / "v2" / "page.tpl.html").read_text()

    profile = HERE / ".prerender-profile"
    profile.mkdir(exist_ok=True)
    proc = chrome(a.port, profile)
    try:
        wait_for(f"http://127.0.0.1:{a.port}/json/version")
        # Recent Chrome only opens a tab on PUT; a POST comes back 405.
        req = urllib.request.Request(
            f"http://127.0.0.1:{a.port}/json/new?about:blank", method="PUT"
        )
        with urllib.request.urlopen(req) as r:
            ws_url = json.load(r)["webSocketDebuggerUrl"]
        print(f"{a.base} → {out} (lang={LANG})", flush=True)
        asyncio.run(run(a, ws_url, tpl, out))
    finally:
        proc.kill()


if __name__ == "__main__":
    main()
