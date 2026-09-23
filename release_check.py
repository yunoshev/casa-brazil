#!/usr/bin/env python3
"""Validate a generated Pages artifact without a browser or network requests.

This checks crawlability of our files, not Google's index or search traffic.
Run after prerender, before upload-pages-artifact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit
from xml.etree import ElementTree as ET

NS = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
PRODUCTION_SITE_URL = "https://precodemartelo.com"
LEGACY_SITE_URL = "https://yunoshev.github.io/casa-brazil"
# Conservative headroom below Google's documented 2 MB HTML fetch boundary.
# https://developers.google.com/search/blog/2026/03/crawler-blog-post
MAX_HTML_BYTES = 1_900_000
MAX_PUBLIC_ARTIFACT_BYTES = 16 * 1024 * 1024
HOME_FRAGMENT = re.compile(r"^_home/([a-z0-9-]+)\.html$")


class Page(HTMLParser):
    def __init__(self, source: str):
        super().__init__(convert_charrefs=True)
        self.doctype = False
        self.lang = ""
        self.titles = 0
        self.title_text = ""
        self._title_parts: list[str] | None = None
        self.descriptions: list[str] = []
        self.h1s = 0
        self.canonicals: list[str] = []
        self.og_urls: list[str] = []
        self.favicons: list[str] = []
        self.noindex = False
        self.links: list[str] = []
        self.structured: list[str] = []
        self._ld: list[str] | None = None
        self.feed(source)

    def handle_decl(self, decl: str):
        if decl.lower() == "doctype html":
            self.doctype = True

    def handle_starttag(self, tag: str, attrs):
        a = dict(attrs)
        if tag == "html":
            self.lang = a.get("lang") or ""
        if tag == "title":
            self.titles += 1
            self._title_parts = []
        if tag == "h1":
            self.h1s += 1
        if tag == "link" and "canonical" in (a.get("rel") or "").lower().split():
            self.canonicals.append(a.get("href") or "")
        if tag == "link" and "icon" in (a.get("rel") or "").lower().split():
            self.favicons.append(a.get("href") or "")
        if tag == "meta" and (a.get("property") or "").lower() == "og:url":
            self.og_urls.append(a.get("content") or "")
        if tag == "meta" and (a.get("name") or "").lower() == "description":
            self.descriptions.append(a.get("content") or "")
        if tag == "meta" and (a.get("name") or "").lower() in {"robots", "googlebot"}:
            directives = (a.get("content") or "").lower().replace(",", " ").split()
            self.noindex |= "noindex" in directives or "none" in directives
        if tag == "a" and a.get("href"):
            self.links.append(a["href"])
        if tag == "script" and a.get("type") == "application/ld+json":
            self._ld = []

    def handle_data(self, data: str):
        if self._ld is not None:
            self._ld.append(data)
        if self._title_parts is not None:
            self._title_parts.append(data)

    def handle_endtag(self, tag: str):
        if tag == "title" and self._title_parts is not None:
            self.title_text = "".join(self._title_parts)
            self._title_parts = None
        if tag == "script" and self._ld is not None:
            self.structured.append("".join(self._ld))
            self._ld = None


def site_url(value: str) -> str:
    u = urlsplit(value)
    if (
        u.scheme != "https"
        or not u.hostname
        or u.username
        or u.password
        or u.query
        or u.fragment
        or u.hostname.endswith(".invalid")
        or u.hostname in {"example.com", "localhost"}
        or u.port not in (None, 443)
    ):
        raise ValueError(
            "--site must be the real HTTPS site URL without credentials/query/fragment"
        )
    if any(p in {".", ".."} for p in unquote(u.path).split("/")):
        raise ValueError("--site contains a traversal path")
    return value.rstrip("/")


def validate_release_site_url(value: str) -> str:
    """Require the one canonical origin allowed in a production release."""
    if value != PRODUCTION_SITE_URL:
        raise ValueError(
            "release SITE_URL must be exactly https://precodemartelo.com "
            "(no path, slash, query, fragment or legacy GitHub Pages URL)"
        )
    return value


def local_file(out: Path, site: str, url: str) -> Path | None:
    """Resolve only this origin and site subpath; never follow symlinks out."""
    root = urlsplit(site)
    u = urlsplit(url)
    if (
        u.hostname
        and u.hostname == root.hostname
        and (u.scheme, u.netloc)
        != (
            root.scheme,
            root.netloc,
        )
    ):
        raise ValueError("same-host URL must use the canonical HTTPS origin")
    if (u.scheme, u.netloc) != (root.scheme, root.netloc):
        return None
    base = root.path.rstrip("/")
    path = unquote(u.path)
    if base and not (path == base or path.startswith(base + "/")):
        raise ValueError("same-origin URL escapes the site's base path")
    rel = path[len(base) :].lstrip("/")
    if any(p in {".", ".."} for p in rel.split("/")) or "\\" in rel:
        raise ValueError("unsafe artifact path")
    target = out / rel
    if not target.suffix:
        target /= "index.html"
    target = target.resolve()
    if not target.is_relative_to(out.resolve()):
        raise ValueError("artifact URL escapes output directory")
    return target


def breadcrumb_urls(data):
    if isinstance(data, dict):
        if data.get("@type") == "BreadcrumbList":
            for item in data.get("itemListElement", []):
                value = item.get("item")
                if isinstance(value, dict):
                    value = value.get("@id")
                if isinstance(value, str):
                    yield value
        for value in data.values():
            yield from breadcrumb_urls(value)
    elif isinstance(data, list):
        for value in data:
            yield from breadcrumb_urls(value)


def _check_manifest_public_artifacts(out: Path, errors: list[str]) -> None:
    """Verify manifest-declared bytes against the artifact that Pages uploads."""
    manifest_path = out / "lifecycle-release.json"
    if not manifest_path.is_file():
        # A strict prerender already requires this release-only asset.  Keep
        # this helper tolerant for callers that use release_check.py on a
        # small fixture without running the full renderer first.
        return
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        errors.append(f"lifecycle-release.json: unreadable manifest ({type(exc).__name__})")
        return
    artifacts = manifest.get("public_artifacts") if isinstance(manifest, dict) else None
    if not isinstance(artifacts, dict):
        errors.append("lifecycle-release.json: public_artifacts is missing or invalid")
        return
    root = out.resolve()
    for relative, metadata in sorted(artifacts.items()):
        label = f"public artifact {relative!r}"
        if (
            not isinstance(relative, str)
            or not relative
            or relative.startswith("/")
            or "\\" in relative
            or any(part in {"", ".", ".."} for part in Path(relative).parts)
        ):
            errors.append(f"{label}: unsafe path in lifecycle manifest")
            continue
        if not isinstance(metadata, dict) or set(metadata) != {"sha256", "bytes"}:
            errors.append(f"{label}: invalid manifest metadata")
            continue
        digest, size = metadata.get("sha256"), metadata.get("bytes")
        if (
            not isinstance(digest, str)
            or not re.fullmatch(r"[0-9a-f]{64}", digest)
            or type(size) is not int
            or not 0 < size <= MAX_PUBLIC_ARTIFACT_BYTES
        ):
            errors.append(f"{label}: invalid manifest hash or size")
            continue
        unresolved = out / relative
        target = unresolved.resolve()
        if unresolved.is_symlink() or not target.is_relative_to(root) or not target.is_file():
            errors.append(f"{label}: deployed file is missing or unsafe")
            continue
        try:
            public = target.read_bytes()
        except OSError as exc:
            errors.append(f"{label}: cannot read deployed file ({type(exc).__name__})")
            continue
        actual = hashlib.sha256(public).hexdigest()
        if len(public) != size or actual != digest:
            errors.append(
                f"{label}: deployed bytes do not match lifecycle manifest "
                f"(expected {size} bytes/{digest[:12]}, got {len(public)} bytes/{actual[:12]})"
            )


def _check_lastmod(node, context: str, errors: list[str]) -> None:
    """Reject malformed or future dates before a sitemap can be published."""
    value = node.text or ""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        errors.append(f"{context}: lastmod must be YYYY-MM-DD")
        return
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        errors.append(f"{context}: invalid lastmod date")
        return
    if parsed > date.today():
        errors.append(f"{context}: lastmod is in the future")


def check(out: Path, site: str, *, release: bool = False) -> dict:
    site = validate_release_site_url(site) if release else site_url(site)
    out = out.resolve()
    errors: list[str] = []
    urls: set[str] = set()
    visited: set[Path] = set()

    if release:
        _check_manifest_public_artifacts(out, errors)

    def read_sitemap(path: Path):
        if path in visited:
            errors.append(f"duplicate or cyclic sitemap: {path.name}")
            return
        visited.add(path)
        try:
            tree = ET.parse(path).getroot()
        except (OSError, ET.ParseError) as exc:
            errors.append(f"invalid sitemap {path.name}: {type(exc).__name__}")
            return
        if tree.tag == f"{{{NS['s']}}}sitemapindex":
            for node in tree.findall("s:sitemap/s:loc", NS):
                try:
                    loc = node.text or ""
                    parsed = urlsplit(loc)
                    if parsed.query or parsed.fragment:
                        raise ValueError("sitemap loc must not contain query or fragment")
                    target = local_file(out, site, node.text or "")
                    if target is None or target.suffix != ".xml":
                        raise ValueError("non-local sitemap")
                    lastmod = node.find("s:lastmod", NS)
                    if lastmod is not None:
                        _check_lastmod(lastmod, f"{path.name}: sitemap", errors)
                    read_sitemap(target)
                except ValueError as exc:
                    errors.append(str(exc))
        elif tree.tag == f"{{{NS['s']}}}urlset":
            for url_node in tree.findall("s:url", NS):
                loc_node = url_node.find("s:loc", NS)
                url = (loc_node.text if loc_node is not None else "") or ""
                if url in urls:
                    errors.append(f"duplicate sitemap URL: {url}")
                urls.add(url)
                lastmod = url_node.find("s:lastmod", NS)
                if lastmod is not None:
                    _check_lastmod(lastmod, f"{path.name}: {url or '<empty loc>'}", errors)
        else:
            errors.append(f"unknown sitemap root: {path.name}")

    read_sitemap(out / "sitemap.xml")
    pages: dict[Path, Page] = {}
    expected: set[str] = set()
    for path in sorted(out.rglob("*.html")):
        source = path.read_text(encoding="utf-8")
        page = Page(source)
        rel = path.relative_to(out).as_posix()
        fragment = HOME_FRAGMENT.fullmatch(rel)
        if fragment:
            # A map swap payload is deliberately not a page. Keep its exception
            # narrow: it must be named after its city and contain precisely the
            # rendered map-card identity, so an arbitrary broken HTML file
            # cannot hide under _home/ and evade normal crawl checks.
            slug = fragment.group(1)
            valid = (
                not page.doctype
                and not page.lang
                and not page.titles
                and not page.h1s
                and not page.canonicals
                and 'class="mapcard home-city-fragment"' in source
                and f'data-home-city="{slug}"' in source
                and "<svg" in source
            )
            if not valid:
                errors.append(f"{rel}: invalid home map fragment")
            continue
        pages[path.resolve()] = page
        if release and LEGACY_SITE_URL in source:
            errors.append(f"{rel}: contains the legacy GitHub Pages URL")
        if len(source.encode("utf-8")) > MAX_HTML_BYTES:
            errors.append(f"{rel}: HTML exceeds our crawl-size guard; paginate content")
        route = rel.removesuffix("index.html") if path.name == "index.html" else rel
        own_url = site + "/" + route
        if not page.doctype or page.lang.lower() not in {"pt", "pt-br"}:
            errors.append(f"{rel}: missing HTML doctype or Portuguese lang")
        if page.titles != 1 or not page.title_text.strip():
            errors.append(f"{rel}: expected one non-empty title")
        if len(page.descriptions) != 1 or not page.descriptions[0].strip():
            errors.append(f"{rel}: expected one non-empty meta description")
        if page.canonicals != [own_url]:
            errors.append(f"{rel}: missing or non-self canonical")
        if rel == "404.html":
            if not page.noindex:
                errors.append("404.html: must be noindex")
        elif not page.noindex:
            expected.add(own_url)
            if page.h1s != 1:
                errors.append(f"{rel}: expected one H1")
        if page.og_urls != [own_url]:
            errors.append(f"{rel}: missing or non-self og:url")
        favicon_href = (urlsplit(site).path.rstrip("/") + "/favicon.svg") or "/favicon.svg"
        if page.favicons != [favicon_href]:
            errors.append(f"{rel}: missing or non-local favicon")
        for href in page.links:
            try:
                target = local_file(out, site, urljoin(own_url, href))
                if target is not None and not target.is_file():
                    errors.append(f"{rel}: broken local link {href}")
            except ValueError as exc:
                errors.append(f"{rel}: {exc}")
        for raw in page.structured:
            try:
                data = json.loads(raw)
                for url in breadcrumb_urls(data):
                    target = local_file(out, site, url)
                    if target is None or not target.is_file() or target.name == "404.html":
                        errors.append(f"{rel}: invalid breadcrumb target")
            except (ValueError, TypeError) as exc:
                errors.append(f"{rel}: invalid structured data ({type(exc).__name__})")

    for url in urls:
        try:
            u = urlsplit(url)
            target = local_file(out, site, url)
            if u.query or u.fragment or target not in pages or pages[target].noindex:
                errors.append(f"sitemap URL is not an indexable artifact page: {url}")
        except ValueError as exc:
            errors.append(str(exc))
    for url in sorted(expected - urls):
        errors.append(f"indexable page missing from sitemap: {url}")
    for url in sorted(urls - expected):
        errors.append(f"sitemap URL does not match a self-canonical page: {url}")
    if not pages or not urls:
        errors.append("artifact has no indexable pages")
    robots = out / "robots.txt"
    if not robots.is_file() or f"Sitemap: {site}/sitemap.xml" not in robots.read_text():
        errors.append("robots.txt missing or points at a different sitemap")
    favicon = out / "favicon.svg"
    if not favicon.is_file() or "<svg" not in favicon.read_text(encoding="utf-8", errors="replace"):
        errors.append("favicon.svg missing from release artifact")
    return {"ok": not errors, "html_pages": len(pages), "sitemap_urls": len(urls), "errors": errors}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=Path(__file__).parent / "dist")
    ap.add_argument("--site", required=True)
    ap.add_argument(
        "--release", action="store_true", help="enforce the production release contract"
    )
    a = ap.parse_args()
    try:
        result = check(a.out, a.site, release=a.release)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
