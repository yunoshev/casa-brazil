"""IndexNow: key file, URL selection from live sitemaps, request shape. No network."""

import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import indexnow

SITE = "https://precodemartelo.com"
NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'
DOCS = {
    f"{SITE}/sitemap.xml": (
        f"<sitemapindex {NS}><sitemap><loc>{SITE}/sitemap-areas.xml</loc></sitemap>"
        f"<sitemap><loc>{SITE}/sitemap-lotes.xml</loc></sitemap></sitemapindex>"
    ),
    f"{SITE}/sitemap-areas.xml": (
        f"<urlset {NS}><url><loc>{SITE}/a/</loc></url>"
        f"<url><loc>{SITE}/b/</loc><lastmod>2026-10-08</lastmod></url></urlset>"
    ),
    f"{SITE}/sitemap-lotes.xml": (
        f"<urlset {NS}><url><loc>{SITE}/lote/1/</loc><lastmod>2026-10-10</lastmod></url>"
        f"<url><loc>{SITE}/lote/2/</loc><lastmod>2026-09-01</lastmod></url></urlset>"
    ),
}


def fetch(url):
    return DOCS[url].encode()


class IndexNowTest(unittest.TestCase):
    def test_key_file_is_served_at_the_root_with_the_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = indexnow.write_key_file(Path(directory))
            self.assertEqual(path.name, indexnow.KEY + ".txt")
            self.assertEqual(path.read_text().strip(), indexnow.KEY)
        with self.assertRaises(ValueError):
            indexnow.key_file_name("bad/key")

    def test_only_recent_lastmod_is_sent_and_undated_pages_need_all(self):
        entries = indexnow.sitemap_urls(SITE, fetch)
        self.assertEqual(len(entries), 4)
        self.assertEqual(
            indexnow.changed_urls(entries, date(2026, 10, 8)),
            [f"{SITE}/b/", f"{SITE}/lote/1/"],
        )
        self.assertEqual(len(indexnow.changed_urls(entries, None)), 4)

    def test_deploy_announces_only_added_and_dropped_pages(self):
        before = {f"{SITE}/a/", f"{SITE}/lote/old/"}
        after = {f"{SITE}/a/", f"{SITE}/lote/new/"}
        self.assertEqual(
            indexnow.added_or_dropped(before, after),
            [f"{SITE}/lote/new/", f"{SITE}/lote/old/"],
        )
        self.assertEqual(indexnow.added_or_dropped(after, after), [])

    def test_off_site_sitemap_entries_are_refused(self):
        docs = dict(DOCS)
        docs[f"{SITE}/sitemap-areas.xml"] = (
            f"<urlset {NS}><url><loc>https://evil.example/x/</loc></url></urlset>"
        )
        with self.assertRaisesRegex(ValueError, "off-site"):
            indexnow.sitemap_urls(SITE, lambda url: docs[url].encode())

    def test_request_shape_and_batching(self):
        sent = []

        def post(url, body):
            sent.append((url, json.loads(body)))
            return 202

        urls = [f"{SITE}/lote/{n}/" for n in range(indexnow.MAX_URLS + 5)]
        self.assertEqual(indexnow.submit(SITE, urls, post=post), [202, 202])
        self.assertEqual(sent[0][0], "https://api.indexnow.org/indexnow")
        first = sent[0][1]
        self.assertEqual(first["host"], "precodemartelo.com")
        self.assertEqual(first["key"], indexnow.KEY)
        self.assertEqual(first["keyLocation"], f"{SITE}/{indexnow.KEY}.txt")
        self.assertEqual(len(first["urlList"]), indexnow.MAX_URLS)
        self.assertEqual(len(sent[1][1]["urlList"]), 5)

    def test_a_refused_batch_reports_its_status_instead_of_crashing(self):
        import io
        import urllib.error
        from unittest import mock

        body = io.BytesIO(b'{"errorCode":"SiteVerificationNotCompleted"}')
        refused = urllib.error.HTTPError(indexnow.ENDPOINT, 403, "Forbidden", {}, body)
        with (
            mock.patch("urllib.request.urlopen", side_effect=refused),
            mock.patch("sys.stderr", new_callable=io.StringIO) as err,
        ):
            self.assertEqual(indexnow.submit(SITE, [f"{SITE}/a/"]), [403])
        self.assertIn("SiteVerificationNotCompleted", err.getvalue())


if __name__ == "__main__":
    unittest.main()
