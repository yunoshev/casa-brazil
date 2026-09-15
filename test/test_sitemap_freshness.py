"""Sitemaps must be honest when the source has no whole-catalogue date."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("public_prerender", ROOT / "prerender.py")
assert SPEC and SPEC.loader
prerender = importlib.util.module_from_spec(SPEC)
# Sitemap helpers are dependency-free; do not require a browser/CDP package to
# test them on a minimal CI image.
sys.modules.setdefault("websockets", types.ModuleType("websockets"))
SPEC.loader.exec_module(prerender)


class SitemapFreshnessTest(unittest.TestCase):
    def test_unknown_date_omits_lastmod_everywhere(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            prerender.write_sitemap(out, ["/leilao-de-imoveis/sp/teste/"], "https://example.test", None)
            self.assertNotIn("lastmod", (out / "sitemap.xml").read_text())
            self.assertNotIn("lastmod", (out / "sitemap-areas.xml").read_text())

    def test_known_date_is_escaped_and_written(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            prerender.write_sitemap(out, ["/leilao-de-imoveis/sp/teste/"], "https://example.test?a=1&b=2", "2026-09-14")
            xml = (out / "sitemap-areas.xml").read_text()
            self.assertIn("https://example.test?a=1&amp;b=2", xml)
            self.assertIn("<lastmod>2026-09-14</lastmod>", xml)

    def test_malformed_date_is_omitted_not_invented(self):
        self.assertIsNone(prerender.sitemap_date("unknown"))
        self.assertIsNone(prerender.sitemap_date("2026-99-99"))


if __name__ == "__main__":
    unittest.main()
