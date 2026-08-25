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
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import websockets

HERE = Path(__file__).parent
SITE = HERE / "site"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

#: The one language that gets its own files. Search demand for Brazilian
#: auction property outside Portuguese is not small, it is absent: Google
#: Autocomplete returns nothing for five English and five Russian phrasings
#: where `leilao de imoveis` returns ten, and Trends has data for the Russian
#: query in one week out of 262. The other languages stay available to a reader
#: through the switcher, on these same URLs, with a canonical pointing here.
LANG = "pt"

#: Everything a page needs that is not the page. Copied, not linked, so the
#: output directory is the whole site.
ASSETS = ("v2/style.css", "parts/lang.js", "parts/chrome.js", "parts/analyze.js")


def chrome(port: int, profile: Path) -> subprocess.Popen:
    for lock in profile.glob("Singleton*"):
        lock.unlink(missing_ok=True)
    return subprocess.Popen(
        [
            CHROME,
            "--headless=new",
            "--disable-gpu",
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile}",
            "--window-size=414,900",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def wait_for(url: str, tries: int = 200) -> dict:
    for _ in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                return json.load(r)
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
            raise RuntimeError(r["exceptionDetails"].get("text", "JS threw"))
        return got.get("value")


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
    return re.sub(r'\b(href|src)="/(?!/)', f'\\1="{BASE}/', html)


def shell(tpl: str, head: dict, body: str, split: bool, ld: list, chrome: dict) -> str:
    """One rendered screen, wrapped in the page it ships as."""
    scripts = "\n".join(
        f'<script type="application/ld+json">{json.dumps(x, ensure_ascii=False)}</script>'
        for x in ld
        if x
    )
    return (
        tpl.replace("__I18N_DATA__", blob(chrome["i18n"]))
        .replace("__CITIES_DATA__", blob(chrome["cities"]))
        .replace("__HERE_DATA__", blob(chrome["here"]))
        .replace("__BASE_DATA__", json.dumps(BASE))
        .replace("__TITLE__", esc_attr(head["title"]))
        .replace("__DESC__", esc_attr(head["desc"]))
        .replace("__CANONICAL__", esc_attr(head["canonical"]))
        .replace("__LD__", scripts)
        .replace("__CLASS__", "wrap split" if split else "wrap")
        .replace("__BODY__", body)
    )


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
    "__LD__",
    "__CLASS__",
    "__BODY__",
)


def esc_attr(s: str) -> str:
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def breadcrumbs(path: str, site: str) -> dict:
    """The one structured-data type in this niche that yields a rich result.

    There is no real-estate rich result at all — the whole gallery is 25 types
    and "real estate" is not among them, and it has been shrinking (Vehicle
    Listing killed 2025-06, FAQ 2026-05). Breadcrumbs and ItemList are what is
    left that Google actually shows, so those are what we emit. Notably absent:
    Offer.price carrying our estimate. Structured data has to be a true
    representation of the page, and our number is a model output, not a price
    anybody is offering.
    """
    parts = [p for p in path.strip("/").split("/") if p]
    # A trail of one is not a trail: the front page is the crumb, and the
    # not-found page is not anywhere in the tree.
    if len(parts) < 2:
        return {}
    items, acc = [], ""
    for i, seg in enumerate(parts):
        acc += "/" + seg
        items.append(
            {
                "@type": "ListItem",
                "position": i + 1,
                "name": seg.replace("-", " "),
                "item": site + acc + "/",
            }
        )
    return {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": items}


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
KEY_CANARY = "nav.theme"


def runtime_keys() -> set[str]:
    keys: set[str] = set()
    for rel in ASSETS:
        if rel.endswith(".js"):
            keys |= set(KEY_RE.findall((SITE / rel).read_text()))
    if KEY_CANARY not in keys:
        raise SystemExit(
            f"в parts/*.js не нашлось даже {KEY_CANARY!r} — разбор ключей сломан, "
            f"страницы уехали бы с именами ключей вместо слов"
        )
    return keys


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


def kind_of(path: str) -> str:
    parts = [p for p in path.strip("/").split("/") if p]
    if "lote" in parts:
        return "lotes"
    return "ruas" if "rua" in parts else "areas"


def write_sitemap(out: Path, paths: list[str], site: str, when: str) -> None:
    """An index and two files: the districts, and the lots.

    lastmod is the day the data was cut, on every URL, because that is the
    truth — a rebuild reprices every page. Zukerman's 13 742 district URLs all
    say 2022-02-18, which tells a crawler nothing except that nobody is
    watching.
    """
    groups: dict[str, list[str]] = {}
    for p in paths:
        groups.setdefault(kind_of(p), []).append(p)

    files = []
    for kind, urls in sorted(groups.items()):
        for n in range(0, len(urls), SITEMAP_MAX):
            chunk = urls[n : n + SITEMAP_MAX]
            name = (
                f"sitemap-{kind}.xml"
                if len(urls) <= SITEMAP_MAX
                else (f"sitemap-{kind}-{n // SITEMAP_MAX + 1}.xml")
            )
            body = "".join(
                f"<url><loc>{site}{u}</loc><lastmod>{when}</lastmod></url>" for u in chunk
            )
            (out / name).write_text(
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                f"{body}</urlset>\n"
            )
            files.append(name)

    index = "".join(
        f"<sitemap><loc>{site}/{f}</loc><lastmod>{when}</lastmod></sitemap>" for f in files
    )
    (out / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        f"{index}</sitemapindex>\n"
    )
    print("  " + ", ".join(f"{k}: {len(v)}" for k, v in sorted(groups.items())), flush=True)


def write_robots(out: Path, site: str) -> None:
    """Open to everything, including the crawlers that answer questions.

    Nothing here is behind a login and nothing is worth hiding — the whole
    argument for this site is that its numbers are public where everyone
    else's are gated. The AI crawlers are named explicitly rather than left to
    the wildcard so the intent is on the record: we want to be the answer.
    """
    out.joinpath("robots.txt").write_text(
        "User-agent: *\n"
        "Allow: /\n\n"
        "# Named on purpose. This site exists to be quoted.\n"
        "User-agent: GPTBot\nAllow: /\n\n"
        "User-agent: OAI-SearchBot\nAllow: /\n\n"
        "User-agent: ClaudeBot\nAllow: /\n\n"
        "User-agent: PerplexityBot\nAllow: /\n\n"
        "User-agent: Google-Extended\nAllow: /\n\n"
        f"Sitemap: {site}/sitemap.xml\n"
    )


async def run(a, ws_url: str, tpl: str, out: Path) -> None:
    try:
        async with websockets.connect(ws_url, max_size=64_000_000) as ws:
            tab = Tab(ws)
            await tab.send("Page.enable")
            # Straight at the shell, never at "/": the root still belongs to
            # the front end this one replaces, and a build that silently
            # rendered the old page would be very hard to notice.
            seed = f"{a.base}{a.shell}?lang={LANG}"
            await tab.send("Page.navigate", url=seed)
            for _ in range(600):
                if await tab.js("typeof window.__render__ === 'function' && !!window.__D__"):
                    break
                await asyncio.sleep(0.1)
            else:
                raise SystemExit("страница не поднялась — __render__ не появился")

            cities = await tab.js(
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
            # The shell has no route of its own, so it redirects on load — and
            # the redirect drops the ?lang= that was on it, after which the
            # runtime falls back to whatever this browser profile happens to
            # remember. Land on a real path instead, where nothing redirects.
            # A city path, not queue[0]: "/" is a page this build has yet to
            # write, and until it exists the dev server answers it with the
            # front end this one replaces — which has no renderer at all.
            await tab.send("Page.navigate", url=f"{a.base}{city_paths[0]}?lang={LANG}")
            for _ in range(600):
                if await tab.js("typeof window.__render__ === 'function'"):
                    break
                await asyncio.sleep(0.1)
            else:
                raise SystemExit(f"{city_paths[0]} не поднялась — рендерер не появился")

            got_lang = await tab.js("window.LANG && window.LANG.code")
            if got_lang != LANG:
                raise SystemExit(
                    f"страница отрисовалась на {got_lang!r}, а не {LANG!r} — "
                    f"сборка на чужом языке хуже, чем несобранная"
                )

            # The header's own data, read once. Only the shipped language's
            # catalogue travels with the pages; the others stay behind with the
            # single-page shell, because nothing on a flat page can re-render
            # into them anyway.
            want = runtime_keys()
            whole = json.loads(await tab.js("JSON.stringify(__I18N__[" + json.dumps(LANG) + "])"))
            missing = sorted(want - set(whole))
            if missing:
                raise SystemExit(f"каталог {LANG} не знает ключей рантайма: {missing}")
            i18n = {LANG: {k: v for k, v in whole.items() if k in want or k == "_meta"}}
            menu = json.loads(await tab.js("JSON.stringify(window.__CITIES__ || [])"))
            if not a.generated:
                a.generated = await tab.js("__D__.generated") or ""

            queue += list(FLAT)
            seen, written, t0 = set(queue), 0, time.time()

            while queue:
                path = queue.pop(0)
                got = await tab.js("JSON.stringify(window.__render__(" + json.dumps(path) + "))")
                if got in (None, "null"):
                    print(f"  пропуск (не маршрут): {path}", flush=True)
                    continue
                page = json.loads(got)
                head = dict(page["head"], canonical=a.site + path)
                html = shell(
                    tpl,
                    head,
                    page["body"],
                    page["split"],
                    [breadcrumbs(path, a.site)],
                    {"i18n": i18n, "cities": menu, "here": {"city": page["city"]}},
                )
                left = [m for m in MARKERS if m in html]
                if left:
                    raise SystemExit(f"в {path} остались маркеры шаблона: {sorted(left)}")
                # lstrip, because the country page strips down to "" and
                # `out / "/index.html"` is not out at all — pathlib treats an
                # absolute right-hand side as the whole answer, and this one
                # points at the root of the disk.
                rel = FLAT.get(path) or (path.strip("/") + "/index.html").lstrip("/")
                target = out / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(rebase(html))
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

            write_sitemap(out, sorted(p for p in seen if p not in FLAT), a.site, a.generated)
            write_robots(out, a.site)

            for rel in ASSETS:
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
    ap.add_argument("--site", default="https://example.invalid")
    ap.add_argument("--shell", default="/v2/index.html")
    ap.add_argument(
        "--generated",
        default="",
        help="the data cut date for <lastmod>; defaults to what the payload says",
    )
    ap.add_argument("--port", type=int, default=9340)
    ap.add_argument("--limit", type=int, default=0, help="stop after N pages (a smoke run)")
    a = ap.parse_args()
    global BASE
    BASE = __import__("urllib.parse", fromlist=["urlparse"]).urlparse(a.site).path.rstrip("/")
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
