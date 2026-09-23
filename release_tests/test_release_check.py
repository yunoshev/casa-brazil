import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "release_check", Path(__file__).parents[1] / "release_check.py"
)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class ReleaseCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name)
        self.site = "https://yunoshev.github.io/casa-brazil"
        self.html = (
            '<!doctype html><html lang="pt-BR"><head><title>Imóveis</title>'
            '<meta name="description" content="Informação pública sobre leilões.">'
            '<link rel="canonical" href="' + self.site + '/">'
            '<meta property="og:url" content="' + self.site + '/">'
            '<link rel="icon" href="/casa-brazil/favicon.svg" type="image/svg+xml"></head>'
            "<body><h1>Imóveis</h1></body></html>"
        )
        (self.out / "index.html").write_text(self.html)
        (self.out / "robots.txt").write_text(
            f"User-agent: *\nAllow: /\nSitemap: {self.site}/sitemap.xml\n"
        )
        self.sitemap([self.site + "/"])
        (self.out / "favicon.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')

    def sitemap(self, urls):
        (self.out / "sitemap.xml").write_text(
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            + "".join("<url><loc>" + url + "</loc></url>" for url in urls)
            + "</urlset>"
        )

    def result(self):
        return CHECK.check(self.out, self.site)

    def test_valid_project_site(self):
        self.assertTrue(self.result()["ok"])

    def test_missing_sitemap_target(self):
        self.sitemap([self.site + "/", self.site + "/missing/"])
        self.assertFalse(self.result()["ok"])

    def test_unlisted_indexable_page(self):
        p = self.out / "city"
        p.mkdir()
        (p / "index.html").write_text(self.html.replace(self.site + "/", self.site + "/city/"))
        self.assertTrue(any("missing from sitemap" in e for e in self.result()["errors"]))

    def test_home_map_fragment_is_not_a_page_or_sitemap_url(self):
        p = self.out / "_home"
        p.mkdir()
        (p / "sao-paulo-sp.html").write_text(
            '<div class="mapcard home-city-fragment" data-home-city="sao-paulo-sp"><svg></svg></div>'
        )
        self.assertTrue(self.result()["ok"])

    def test_arbitrary_home_html_cannot_bypass_page_validation(self):
        p = self.out / "_home"
        p.mkdir()
        (p / "sao-paulo-sp.html").write_text("<div>not a map fragment</div>")
        self.assertTrue(any("invalid home map fragment" in e for e in self.result()["errors"]))

    def test_broken_breadcrumb(self):
        ld = {"@type": "BreadcrumbList", "itemListElement": [{"item": self.site + "/rj/"}]}
        (self.out / "index.html").write_text(
            self.html + '<script type="application/ld+json">' + json.dumps(ld) + "</script>"
        )
        self.assertTrue(any("breadcrumb" in e for e in self.result()["errors"]))

    def test_missing_base_path(self):
        (self.out / "index.html").write_text(self.html + '<a href="/city/">Cidade</a>')
        self.assertFalse(self.result()["ok"])

    def test_404_requires_noindex(self):
        four = self.html.replace(f'href="{self.site}/"', f'href="{self.site}/404.html"').replace(
            f'content="{self.site}/"', f'content="{self.site}/404.html"'
        )
        (self.out / "404.html").write_text(four)
        self.assertFalse(self.result()["ok"])
        (self.out / "404.html").write_text(
            four.replace("</head>", '<meta name="robots" content="noindex"></head>')
        )
        self.assertTrue(self.result()["ok"])

    def test_noindex_excluded(self):
        self.sitemap([self.site + "/"])
        (self.out / "index.html").write_text(
            self.html.replace("</head>", '<meta name="robots" content="noindex"></head>')
        )
        self.assertFalse(self.result()["ok"])

    def test_noindex_page_still_requires_a_self_canonical(self):
        self.sitemap([])
        noindex = (
            self.html.replace(f'href="{self.site}/"', f'href="{self.site}/other/"')
            .replace(f'content="{self.site}/"', f'content="{self.site}/other/"')
            .replace("</head>", '<meta name="robots" content="noindex"></head>')
        )
        (self.out / "index.html").write_text(noindex)
        result = self.result()
        self.assertFalse(result["ok"])
        self.assertTrue(any("non-self canonical" in e for e in result["errors"]))

    def test_same_host_http_link_is_not_treated_as_external(self):
        (self.out / "index.html").write_text(
            self.html + f'<a href="http://{self.site.removeprefix("https://")}/city/">Cidade</a>'
        )
        result = self.result()
        self.assertFalse(result["ok"])
        self.assertTrue(any("canonical HTTPS origin" in e for e in result["errors"]))

    def test_future_sitemap_lastmod_fails(self):
        future = "2999-01-01"
        (self.out / "sitemap.xml").write_text(
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            f"<url><loc>{self.site}/</loc><lastmod>{future}</lastmod></url>"
            "</urlset>"
        )
        result = self.result()
        self.assertFalse(result["ok"])
        self.assertTrue(any("lastmod is in the future" in e for e in result["errors"]))

    def test_external_links_are_not_fetched(self):
        (self.out / "index.html").write_text(
            self.html + '<a href="https://www.caixa.gov.br/">Caixa</a>'
        )
        self.assertTrue(self.result()["ok"])

    def test_oversized_html_fails_before_publish(self):
        (self.out / "index.html").write_text(self.html + " " * CHECK.MAX_HTML_BYTES)
        self.assertTrue(any("crawl-size guard" in e for e in self.result()["errors"]))

    def test_unsafe_url_rejected(self):
        for value in [
            "https://example.invalid",
            "http://site.test",
            "https://u:p@site.test",
            "https://site.test/?email=a",
        ]:
            with self.assertRaises(ValueError):
                CHECK.site_url(value)
        with self.assertRaises(ValueError):
            CHECK.local_file(self.out, self.site, self.site + "/%2e%2e/private.txt")

    def test_root_domain(self):
        self.site = "https://precodemartelo.com"
        self.html = self.html.replace("https://yunoshev.github.io/casa-brazil", self.site)
        self.html = self.html.replace("/casa-brazil/favicon.svg", "/favicon.svg")
        (self.out / "index.html").write_text(self.html)
        (self.out / "robots.txt").write_text(f"Sitemap: {self.site}/sitemap.xml")
        self.sitemap([self.site + "/"])
        self.assertTrue(self.result()["ok"])

    def test_release_requires_exact_production_origin(self):
        for value in [
            "",
            "http://precodemartelo.com",
            "https://precodemartelo.com/",
            "https://precodemartelo.com/site",
            "https://yunoshev.github.io/casa-brazil",
        ]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                CHECK.validate_release_site_url(value)
        self.assertEqual(
            CHECK.validate_release_site_url("https://precodemartelo.com"),
            "https://precodemartelo.com",
        )

    def test_release_checker_rejects_legacy_artifact_domain(self):
        with self.assertRaises(ValueError):
            CHECK.check(self.out, self.site, release=True)

    def test_release_rejects_manifest_artifact_overwritten_before_deploy(self):
        self.site = "https://precodemartelo.com"
        self.html = self.html.replace("https://yunoshev.github.io/casa-brazil", self.site)
        self.html = self.html.replace("/casa-brazil/favicon.svg", "/favicon.svg")
        (self.out / "index.html").write_text(self.html)
        (self.out / "robots.txt").write_text(
            f"User-agent: *\nAllow: /\nSitemap: {self.site}/sitemap.xml\n"
        )
        self.sitemap([self.site + "/"])

        expected = b'{"schema":"brazil-market-reports-public-v1","reports":["fresh"]}'
        stale = b'{"schema":"brazil-market-reports-public-v1","reports":[]}'
        target = self.out / "data/market_reports.json"
        target.parent.mkdir()
        target.write_bytes(expected)
        manifest = {
            "public_artifacts": {
                "data/market_reports.json": {
                    "sha256": hashlib.sha256(expected).hexdigest(),
                    "bytes": len(expected),
                }
            }
        }
        (self.out / "lifecycle-release.json").write_text(json.dumps(manifest))

        # This is the historical failure: a later copy step replaces the
        # lifecycle-bound output with the old insufficient-data artifact.
        target.write_bytes(stale)
        result = CHECK.check(self.out, self.site, release=True)
        self.assertFalse(result["ok"])
        self.assertTrue(
            any(
                "deployed bytes do not match lifecycle manifest" in error
                for error in result["errors"]
            )
        )


if __name__ == "__main__":
    unittest.main()
