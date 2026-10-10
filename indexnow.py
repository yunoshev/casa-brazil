#!/usr/bin/env python3
"""Tell IndexNow search engines (Bing, Yandex, Seznam, Naver) which pages changed.

Google does not take IndexNow; it reads the sitemap. Bing does, and Bing's
index also feeds DuckDuckGo and ChatGPT search, which matters for a site that
wants to be quoted. The protocol is a public key file at the site root plus one
POST listing changed URLs; the key is not a secret.

Three parts:
  * ``write_key_file(out)`` runs inside prerender, so every deploy serves the key;
  * ``snapshot`` runs in the deploy job BEFORE the deploy and saves the live
    sitemap URL set;
  * ``submit --previous`` runs AFTER the deploy and sends only pages that were
    added to or dropped from the sitemap. A lot's ``lastmod`` moves every night
    it is re-verified (the page shows that date), so "recent lastmod" would
    announce ~1 500 unchanged pages a day, which engines treat as noise.
A failed ping never fails a deploy; the workflow steps are ``continue-on-error``.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit
from xml.etree import ElementTree

KEY = "642c0d4c25c9c683941c389b88efa8f5"
ENDPOINT = "https://api.indexnow.org/indexnow"
#: The protocol accepts at most 10 000 URLs per request.
MAX_URLS = 10_000
USER_AGENT = "PrecoDeMartelo/1.0 (+https://precodemartelo.com; indexnow)"
NS = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
_KEY_SHAPE = re.compile(r"[a-zA-Z0-9-]{8,128}")


def key_file_name(key: str = KEY) -> str:
    if not _KEY_SHAPE.fullmatch(key):
        raise ValueError("IndexNow key must be 8-128 characters of a-z, A-Z, 0-9 or -")
    return f"{key}.txt"


def write_key_file(out: Path, key: str = KEY) -> Path:
    """The file the engines fetch to verify that this host owns the key."""
    target = Path(out) / key_file_name(key)
    target.write_text(key + "\n")
    return target


def _fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def sitemap_urls(
    site: str, fetch: Callable[[str], bytes] = _fetch
) -> list[tuple[str, date | None]]:
    """Every (loc, lastmod) listed by the site's sitemap index, same host only."""
    host = urlsplit(site).hostname
    index = ElementTree.fromstring(fetch(f"{site}/sitemap.xml"))
    entries: list[tuple[str, date | None]] = []
    for child in index.findall("s:sitemap/s:loc", NS):
        child_url = (child.text or "").strip()
        if urlsplit(child_url).hostname != host:
            raise ValueError(f"sitemap index points off-site: {child_url}")
        urlset = ElementTree.fromstring(fetch(child_url))
        for node in urlset.findall("s:url", NS):
            loc = (node.findtext("s:loc", default="", namespaces=NS) or "").strip()
            if urlsplit(loc).hostname != host:
                raise ValueError(f"sitemap lists an off-site URL: {loc}")
            raw = (node.findtext("s:lastmod", default="", namespaces=NS) or "").strip()
            entries.append((loc, date.fromisoformat(raw[:10]) if raw else None))
    return entries


def added_or_dropped(previous: set[str], current: set[str]) -> list[str]:
    """New pages to crawl and gone pages to drop; unchanged pages are not news."""
    return sorted(previous ^ current)


def changed_urls(entries: list[tuple[str, date | None]], since: date | None) -> list[str]:
    """URLs modified on or after ``since``; all of them when ``since`` is None."""
    urls = [loc for loc, lastmod in entries if since is None or (lastmod and lastmod >= since)]
    return sorted(set(urls))


def payload(site: str, urls: list[str], key: str = KEY) -> dict:
    host = urlsplit(site).hostname
    return {
        "host": host,
        "key": key,
        "keyLocation": f"{site}/{key_file_name(key)}",
        "urlList": urls,
    }


def submit(
    site: str,
    urls: list[str],
    *,
    post: Callable[[str, bytes], int] | None = None,
    key: str = KEY,
) -> list[int]:
    """POST in protocol-sized batches; returns the HTTP status of each batch."""

    def default_post(url: str, body: bytes) -> int:
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": USER_AGENT},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            return int(response.status)

    send = post or default_post
    statuses = []
    for start in range(0, len(urls), MAX_URLS):
        body = json.dumps(payload(site, urls[start : start + MAX_URLS], key)).encode()
        statuses.append(send(ENDPOINT, body))
    return statuses


def _key_is_live(site: str) -> bool:
    try:
        return _fetch(f"{site}/{key_file_name()}").decode().strip() == KEY
    except OSError:
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    snap = sub.add_parser("snapshot", help="save the live sitemap URL set")
    snap.add_argument("--site", required=True)
    snap.add_argument("--out", type=Path, required=True)
    run = sub.add_parser("submit", help="announce pages to IndexNow")
    run.add_argument("--site", required=True)
    what = run.add_mutually_exclusive_group(required=True)
    what.add_argument("--previous", type=Path, help="snapshot taken before the deploy")
    what.add_argument("--since-days", type=int, help="pages with lastmod in this window")
    what.add_argument("--all", action="store_true", help="every sitemap URL (first run)")
    args = parser.parse_args(argv)
    site = args.site.rstrip("/")
    if urlsplit(site).scheme != "https":
        parser.error("--site must be https")
    entries = sitemap_urls(site)
    if args.command == "snapshot":
        args.out.write_text("".join(f"{loc}\n" for loc, _ in sorted(entries)))
        print(f"indexnow: snapshot of {len(entries)} URLs", flush=True)
        return 0
    # Engines reject the whole batch when keyLocation does not return the key.
    if not _key_is_live(site):
        print("indexnow: key file is not live yet; nothing sent", flush=True)
        return 1
    current = {loc for loc, _ in entries}
    if args.previous is not None:
        if not args.previous.is_file():
            print("indexnow: no pre-deploy snapshot; nothing sent", flush=True)
            return 0
        lines = args.previous.read_text().splitlines()
        urls = added_or_dropped({line.strip() for line in lines if line.strip()}, current)
    elif args.all:
        urls = sorted(current)
    else:
        urls = changed_urls(entries, datetime.now(UTC).date() - timedelta(days=args.since_days))
    if not urls:
        print("indexnow: nothing changed", flush=True)
        return 0
    statuses = submit(site, urls)
    print(f"indexnow: sent {len(urls)} URLs, HTTP {statuses}", flush=True)
    return 0 if all(status in (200, 202) for status in statuses) else 1


if __name__ == "__main__":
    sys.exit(main())
