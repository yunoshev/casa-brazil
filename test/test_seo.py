"""Offline SEO contracts: python -m unittest discover -s experiments/brazil/test."""

import ast
import json
import sys
import unittest
from datetime import date
from pathlib import Path
from xml.etree import ElementTree as ET

BRAZIL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRAZIL))
from seo import (
    PageFacts,
    breadcrumbs,
    canonical_url,
    data_date,
    prerender_date,
    route_file,
    sitemap_documents,
    source_date,
    validate_page,
    validate_site_url,
)

SITE = "https://yunoshev.github.io/casa-brazil"
CITY = "/leilao-de-imoveis/rj/rio-de-janeiro/"
AREA = CITY + "copacabana/"
LOT = CITY + "lote/apartamento-123/"


def page(site, path, *, noindex=False, ld=None):
    return (
        '<!doctype html><html lang="pt-BR"><head>'
        "<title>Unique page title</title>"
        '<meta name="description" content="A useful page description.">'
        f'<link rel="canonical" href="{canonical_url(site, path)}">'
        f'<meta name="robots" content="{"noindex, follow" if noindex else "index, follow"}">'
        f'<script type="application/ld+json">{json.dumps(ld or {})}</script>'
        "</head><body><h1>Imóveis</h1></body></html>"
    )


class DateTests(unittest.TestCase):
    def test_prerender_cannot_override_missing_or_older_source_date(self):
        for value in [None, "2020-01-01"]:
            with self.assertRaisesRegex(ValueError, "cannot override"):
                prerender_date(value, asserted="2025-01-01")
        self.assertEqual(
            prerender_date("2025-01-01", asserted="2025-01-01", release=True), "2025-01-01"
        )
        with self.assertRaises(ValueError):
            prerender_date(None, release=True)
        self.assertIsNone(prerender_date(None))

    def test_unknown_preview_and_release_block(self):
        src = {"cities": [{"rows": [["2026-09-15"]]}]}
        self.assertIsNone(source_date(src))
        with self.assertRaisesRegex(ValueError, "source metadata"):
            source_date(src, release=True)

    def test_all_cities_required_and_mixed_dates_not_replaced_by_max(self):
        for dates in [("2025-01-01", None), ("2025-01-01", "2025-02-01")]:
            src = {"cities": [{"generated": d} for d in dates]}
            self.assertIsNone(source_date(src))
            with self.assertRaises(ValueError):
                source_date(src, release=True)
        self.assertEqual(
            source_date({"cities": [{"generated": "2025-01-01"}]}, release=True), "2025-01-01"
        )

    def test_documented_export_date_preserved_without_age_refresh(self):
        self.assertEqual(
            source_date({"generated": "2020-02-29", "cities": [{}]}, release=True), "2020-02-29"
        )

    def test_strict_calendar_format_and_future(self):
        for value in [
            "2025-02-29",
            "2025-13-01",
            "20250101",
            " 2025-01-01",
            "2025-1-01",
            "2025-01-01T00:00:00Z",
            "today",
            20250101,
            "2030-01-01",
        ]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                data_date(value, today=date(2026, 9, 15))


class URLTests(unittest.TestCase):
    def test_root_domain_and_github_subpath(self):
        for site in [SITE, "https://precodemartelo.com"]:
            self.assertEqual(validate_site_url(site + "/"), site)
            self.assertEqual(canonical_url(site, "/"), site + "/")
            self.assertEqual(canonical_url(site, LOT), site + LOT)
            self.assertEqual(canonical_url(site, "/404"), site + "/404.html")

    def test_bad_site_urls(self):
        for site in [
            "",
            "http://precodemartelo.com",
            "/casa-brazil",
            "https://example.invalid",
            "https://example.com",
            "https://my-site.test",
            "https://localhost",
            "https://user:password@precodemartelo.com",
            SITE + "?lang=pt",
            SITE + "#x",
            SITE + "?",
            SITE + "#",
            SITE + "/../evil",
            SITE + "/%2e%2e/evil",
            SITE + "//",
            "https://precodemartelo.com:443",
            "https://127.0.0.1",
            "https://preco_real.com",
            "https://-preco.com",
            "https://precodemartelo.com/\nevil",
            "https://precodemartelo.com\\evil",
        ]:
            with self.subTest(site=site), self.assertRaises(ValueError):
                validate_site_url(site)

    def test_routes_cannot_escape_output_or_create_duplicate_canonicals(self):
        self.assertEqual(route_file("/"), "index.html")
        for path in [
            "../x",
            "/../x/",
            "//evil/",
            CITY + "?lang=pt",
            "/index.html",
            CITY.rstrip("/"),
        ]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                route_file(path)


class ArtifactContracts(unittest.TestCase):
    def test_paginated_list_self_canonicals_and_breadcrumb_targets(self):
        first = CITY + "todos-os-lotes/"
        second = first + "pagina/2/"
        for site in [SITE, "https://precodemartelo.com"]:
            emitted = {"/", CITY, first, second}
            trail = [
                {"path": p, "name": n}
                for p, n in [
                    ("/", "Brasil"),
                    (CITY, "Rio de Janeiro"),
                    (first, "Todos os lotes"),
                    (second, "Página 2"),
                ]
            ]
            ld = breadcrumbs(trail, site, emitted)
            html = page(site, second, ld=ld)
            validate_page(html, second, site, emitted)
            self.assertEqual(route_file(second), (second + "index.html").lstrip("/"))
            with self.assertRaisesRegex(ValueError, "self-canonical"):
                validate_page(
                    html.replace(f'href="{site + second}"', f'href="{site + first}"'), second, site
                )
            docs = sitemap_documents(dict.fromkeys(emitted, True), site)
            urls = {
                x.text for x in ET.fromstring(docs["sitemap-areas.xml"]).findall("{*}url/{*}loc")
            }
            self.assertEqual(urls, {site + p for p in emitted})

    def test_exactly_one_self_canonical(self):
        for site in [SITE, "https://precodemartelo.com"]:
            html = page(site, CITY)
            validate_page(html, CITY, site)
            for bad in [
                html.replace(site + CITY, site + AREA),
                html.replace('<link rel="canonical"', '<link rel="alternate"'),
                html.replace("</head>", f'<link rel="canonical" href="{site + CITY}"></head>'),
            ]:
                with self.assertRaisesRegex(ValueError, "self-canonical"):
                    validate_page(bad, CITY, site)

    def test_404_and_standard_html(self):
        validate_page(page(SITE, "/404", noindex=True), "/404", SITE)
        with self.assertRaisesRegex(ValueError, "noindex"):
            validate_page(page(SITE, "/404"), "/404", SITE)
        for html in [
            page(SITE, CITY).replace("<!doctype html>", ""),
            page(SITE, CITY).replace('lang="pt-BR"', 'lang="pt"'),
        ]:
            with self.assertRaises(ValueError):
                validate_page(html, CITY, SITE)
        self.assertTrue(PageFacts('<meta name="Googlebot" content="NOINDEX">').noindex)

    def test_title_and_description_are_single_and_non_empty(self):
        html = page(SITE, CITY)
        validate_page(html, CITY, SITE)
        broken = [
            html.replace("<title>Unique page title</title>", ""),
            html.replace("Unique page title", ""),
            html.replace("</head>", "<title>Duplicate</title></head>"),
            html.replace('<meta name="description" content="A useful page description.">', ""),
            html.replace("A useful page description.", ""),
            html.replace("</head>", '<meta name="description" content="Duplicate"></head>'),
        ]
        for document in broken:
            with self.subTest(document=document), self.assertRaises(ValueError):
                validate_page(document, CITY, SITE)

    def test_entity_breadcrumbs_include_home_city_area_lot(self):
        trail = [
            {"path": p, "name": n}
            for p, n in [
                ("/", "Brasil"),
                (CITY, "Rio de Janeiro"),
                (AREA, "Copacabana"),
                (LOT, "Apartamento"),
            ]
        ]
        emitted = {e["path"] for e in trail}
        ld = breadcrumbs(trail, SITE, emitted)
        self.assertEqual(
            [x["item"] for x in ld["itemListElement"]], [SITE + e["path"] for e in trail]
        )
        validate_page(page(SITE, LOT, ld=ld), LOT, SITE, emitted)
        # A partial build may not have reached the district yet.
        emitted.remove(AREA)
        partial = breadcrumbs(trail, SITE, emitted)
        self.assertEqual([x["position"] for x in partial["itemListElement"]], [1, 2, 3])
        validate_page(page(SITE, LOT, ld=partial), LOT, SITE, emitted)
        with self.assertRaisesRegex(ValueError, "breadcrumb"):
            validate_page(page(SITE, LOT, ld=ld), LOT, SITE, emitted)
        self.assertEqual(breadcrumbs([], SITE, emitted), {})

    def test_partial_sitemap_exactly_written_indexable_pages(self):
        # The walk also discovered LOT, but has not written it: never add it.
        htmls = {p: page(SITE, p, noindex=p in {AREA, "/404"}) for p in ["/", CITY, AREA, "/404"]}
        written = {p: not validate_page(html, p, SITE).noindex for p, html in htmls.items()}
        docs = sitemap_documents(written, SITE)
        locs = []
        for name, xml in docs.items():
            root = ET.fromstring(xml)
            self.assertNotIn("lastmod", xml)
            if name != "sitemap.xml":
                locs.extend(x.text for x in root.findall("{*}url/{*}loc"))
        self.assertEqual(set(locs), {SITE + "/", SITE + CITY})
        self.assertNotIn(SITE + LOT, locs)

    def test_sitemap_chunks_and_known_date(self):
        written = {"/": True, CITY: True, AREA: True, LOT: True, "/404": True}
        for site in [SITE, "https://precodemartelo.com"]:
            docs = sitemap_documents(written, site, "2025-01-01", chunk_size=2)
            self.assertEqual(
                set(docs),
                {"sitemap-areas-1.xml", "sitemap-areas-2.xml", "sitemap-lotes.xml", "sitemap.xml"},
            )
            index = ET.fromstring(docs["sitemap.xml"])
            for loc in index.findall("{*}sitemap/{*}loc"):
                self.assertIn(loc.text.removeprefix(site + "/"), docs)
            for xml in docs.values():
                self.assertNotIn("404", xml)
                self.assertTrue(
                    all(x.text == "2025-01-01" for x in ET.fromstring(xml).findall(".//{*}lastmod"))
                )

    def test_partial_sitemap_dates_only_the_evidence_bound_lot(self):
        written = {"/": True, CITY: True, LOT: True}
        docs = sitemap_documents(written, SITE, route_dates={LOT: "2025-01-02"})
        self.assertNotIn("lastmod", docs["sitemap.xml"])
        area = ET.fromstring(docs["sitemap-areas.xml"])
        self.assertEqual(area.findall(".//{*}lastmod"), [])
        lots = ET.fromstring(docs["sitemap-lotes.xml"])
        self.assertEqual(
            [(node.find("{*}loc").text, node.find("{*}lastmod").text) for node in lots],
            [(SITE + LOT, "2025-01-02")],
        )

    def test_source_grammar_and_template_skeleton(self):
        for name in ["seo.py", "proto_build.py", "prerender.py"]:
            ast.parse((BRAZIL / name).read_text(), filename=name)
        for name in ["page.tpl.html", "index.tpl.html"]:
            html = (BRAZIL / "site/v2" / name).read_text()
            facts = PageFacts(html.replace("__LD__", ""))
            self.assertEqual(facts.lang, "pt-BR")
            self.assertTrue(facts.doctype)
            self.assertIn("</body>\n</html>", html)


if __name__ == "__main__":
    unittest.main()
