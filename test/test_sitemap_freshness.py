"""Equivalent of the public sitemap-freshness regression check."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from seo import sitemap_documents


class SitemapFreshnessTests(unittest.TestCase):
    def test_unknown_source_date_omits_lastmod_from_all_documents(self):
        docs = sitemap_documents({"/cidade/": True}, "https://precodemartelo.com", None)
        self.assertNotIn("lastmod", docs["sitemap-areas.xml"])
        self.assertNotIn("lastmod", docs["sitemap.xml"])

    def test_source_date_is_escaped_and_not_build_time(self):
        docs = sitemap_documents({"/cidade/": True}, "https://precodemartelo.com", "2026-09-14")
        self.assertIn("https://precodemartelo.com/cidade/", docs["sitemap-areas.xml"])
        self.assertIn("<lastmod>2026-09-14</lastmod>", docs["sitemap.xml"])

    def test_route_date_can_date_one_page_without_dating_the_index(self):
        docs = sitemap_documents(
            {"/cidade/": True},
            "https://precodemartelo.com",
            None,
            route_dates={"/cidade/": "2026-09-14"},
        )
        self.assertIn("<lastmod>2026-09-14</lastmod>", docs["sitemap-areas.xml"])
        self.assertNotIn("lastmod", docs["sitemap.xml"])


if __name__ == "__main__":
    unittest.main()
