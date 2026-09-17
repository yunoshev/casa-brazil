"""Pure SEO contracts. No browser, filesystem, network or build dependencies."""

from __future__ import annotations

import ipaddress
import json
import re
from datetime import date
from html.parser import HTMLParser
from urllib.parse import urlsplit
from xml.sax.saxutils import escape


def data_date(value, *, required=False, today=None):
    """Validate source metadata; the clock is only an upper bound, never a fallback."""
    if value is None or value == "":
        if required:
            raise ValueError(
                "Missing generated source metadata; restore its documented date before release"
            )
        return None
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("generated must be a source date in YYYY-MM-DD format")
    parsed = date.fromisoformat(value)
    if parsed > (today or date.today()):
        raise ValueError("generated source date cannot be in the future")
    return value


def source_date(source, *, release=False, today=None):
    """Accept a documented whole-export date or one common date across ALL cities.

    Mixed city dates do not establish a single whole-export date. Auction dates,
    file mtimes and build time are deliberately never consulted.
    """
    top = data_date(source.get("generated"), today=today)
    cities = [data_date(c.get("generated"), today=today) for c in source.get("cities", [])]
    common = cities[0] if cities and cities[0] and len(set(cities)) == 1 else None
    return data_date(top or common, required=release, today=today)


def prerender_date(value, *, asserted=None, release=False):
    """A CLI assertion can confirm source metadata, never replace it."""
    actual = data_date(value, required=release)
    claimed = data_date(asserted)
    if claimed and claimed != actual:
        raise ValueError("--generated must match source payload metadata; it cannot override it")
    return actual


def validate_site_url(value):
    """One HTTPS origin plus an optional GitHub Pages subpath; no placeholders."""
    if not isinstance(value, str) or not value or re.search(r"[\s\\?#%]", value):
        raise ValueError(
            "SITE_URL must be an absolute HTTPS URL without query, fragment or escapes"
        )
    u = urlsplit(value)
    host = u.hostname or ""
    labels = host.split(".")
    reserved = {"example", "invalid", "test", "localhost", "local"}
    if (
        u.scheme != "https"
        or not u.netloc
        or u.username is not None
        or u.password is not None
        or u.port is not None
        or len(labels) < 2
        or any(x in reserved for x in labels)
        or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", x) for x in labels)
    ):
        raise ValueError(
            "SITE_URL requires a public HTTPS hostname without credentials, port or placeholders"
        )
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise ValueError("SITE_URL must use a public hostname, not an IP address")
    path = u.path.rstrip("/")
    if not re.fullmatch(r"(?:/[A-Za-z0-9_-]+)*", path) or "//" in u.path:
        raise ValueError("SITE_URL has an invalid base path")
    return "https://" + host + path


def route_file(path):
    if path in {"/404", "/404.html"}:
        return "404.html"
    if path != "/" and not re.fullmatch(r"/(?:[a-z0-9_-]+/)+", path):
        raise ValueError(f"Invalid canonical route: {path!r}")
    return (path.strip("/") + "/index.html").lstrip("/")


def canonical_url(site, path):
    route_file(path)
    return validate_site_url(site) + ("/404.html" if path == "/404" else path)


def breadcrumbs(trail, site, emitted):
    """Entity-based trail from the renderer, limited to files actually emitted."""
    items: list[dict[str, object]] = []
    seen = set()
    for entry in trail:
        path = entry["path"]
        if path not in emitted or path in {"/404", "/404.html"} or path in seen:
            continue
        seen.add(path)
        items.append(
            {
                "@type": "ListItem",
                "position": len(items) + 1,
                "name": entry["name"],
                "item": canonical_url(site, path),
            }
        )
    if len(items) < 2:
        return {}
    return {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": items}


class PageFacts(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.canonicals = []
        self.titles = []
        self.descriptions = []
        self.noindex = False
        self.lang = None
        self.doctype = False
        self.structured = []
        self._ld = None
        self._title = None
        self.feed(html)
        self.close()

    def handle_decl(self, decl):
        self.doctype = decl.lower() == "doctype html"

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "html":
            self.lang = a.get("lang")
        if tag == "link" and "canonical" in (a.get("rel") or "").lower().split():
            self.canonicals.append(a.get("href"))
        if tag == "title":
            self._title = ""
        if tag == "meta" and (a.get("name") or "").lower() == "description":
            self.descriptions.append(a.get("content"))
        if tag == "meta" and (a.get("name") or "").lower() in {"robots", "googlebot"}:
            self.noindex |= bool(
                {"noindex", "none"} & set(re.split(r"[\s,]+", (a.get("content") or "").lower()))
            )
        if tag == "script" and a.get("type") == "application/ld+json":
            self._ld = ""

    def handle_data(self, data):
        if self._ld is not None:
            self._ld += data
        if self._title is not None:
            self._title += data

    def handle_endtag(self, tag):
        if tag == "title" and self._title is not None:
            self.titles.append(self._title)
            self._title = None
        if tag == "script" and self._ld is not None:
            self.structured.append(json.loads(self._ld))
            self._ld = None


def validate_page(html, path, site, emitted=None, *, emitted_urls=None):
    facts = PageFacts(html)
    if not facts.doctype or facts.lang != "pt-BR":
        raise ValueError(f"{path}: expected HTML5 and lang=pt-BR")
    if facts.canonicals != [canonical_url(site, path)]:
        raise ValueError(f"{path}: expected exactly one self-canonical")
    if len(facts.titles) != 1 or not facts.titles[0].strip():
        raise ValueError(f"{path}: expected exactly one non-empty title")
    if len(facts.descriptions) != 1 or not (facts.descriptions[0] or "").strip():
        raise ValueError(f"{path}: expected exactly one non-empty meta description")
    if route_file(path) == "404.html" and not facts.noindex:
        raise ValueError("404.html must be noindex")
    if emitted is not None or emitted_urls is not None:
        # Large builds precompute this once, avoiding a quadratic URL scan.
        urls = (
            emitted_urls
            if emitted_urls is not None
            else {canonical_url(site, p) for p in emitted if route_file(p) != "404.html"}
        )
        for obj in facts.structured:
            if obj.get("@type") == "BreadcrumbList":
                for i, crumb in enumerate(obj["itemListElement"], 1):
                    if crumb.get("item") not in urls or crumb.get("position") != i:
                        raise ValueError(f"{path}: invalid breadcrumb target or position")
    return facts


def sitemap_documents(pages, site, when=None, *, route_dates=None, chunk_size=45000):
    """Return XML documents from an actual-write manifest {route: indexable}.

    Unknown dates omit lastmod, including on the sitemap index. The caller must
    add a route only AFTER writing and validating its HTML, never on discovery.
    """
    site = validate_site_url(site)
    when = data_date(when)
    route_dates = route_dates or {}
    if not isinstance(route_dates, dict) or set(route_dates) - set(pages):
        raise ValueError("route_dates must refer only to emitted pages")
    route_dates = {path: data_date(value) for path, value in route_dates.items()}
    if chunk_size < 1:
        raise ValueError("chunk_size must be positive")
    groups: dict[str, list[str]] = {}
    for path, indexable in sorted(pages.items()):
        route_file(path)
        if not indexable or route_file(path) == "404.html":
            continue
        parts = path.split("/")
        kind = "lotes" if "lote" in parts else "ruas" if "rua" in parts else "areas"
        groups.setdefault(kind, []).append(path)
    prefix = '<?xml version="1.0" encoding="UTF-8"?>'
    namespace = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'
    docs = {}
    for kind, paths in sorted(groups.items()):
        for start in range(0, len(paths), chunk_size):
            suffix = f"-{start // chunk_size + 1}" if len(paths) > chunk_size else ""
            body = "".join(
                f"<url><loc>{escape(canonical_url(site, path))}</loc>"
                + (
                    f"<lastmod>{when or route_dates.get(path)}</lastmod>"
                    if when or route_dates.get(path)
                    else ""
                )
                + "</url>"
                for path in paths[start : start + chunk_size]
            )
            docs[f"sitemap-{kind}{suffix}.xml"] = f"{prefix}<urlset {namespace}>{body}</urlset>\n"
    # Per-route evidence never dates the sitemap as a whole.
    lastmod = f"<lastmod>{when}</lastmod>" if when else ""
    index = "".join(
        f"<sitemap><loc>{escape(site + '/' + name)}</loc>{lastmod}</sitemap>" for name in docs
    )
    docs["sitemap.xml"] = f"{prefix}<sitemapindex {namespace}>{index}</sitemapindex>\n"
    return docs
