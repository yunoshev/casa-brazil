"""Real templates/assets/config/sitemap together; no browser or external API."""

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

BRAZIL = Path(__file__).parents[1]
sys.path.insert(0, str(BRAZIL))
import prerender
import proto_build
from public_config import privacy_page, snippet
from release_check import check
from seo import breadcrumbs, canonical_url, route_file


class BuildIntegrationTest(unittest.TestCase):
    def test_clean_temp_strict_partial_build_replaces_every_stale_release_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_dir, site, public_data = root / "data", root / "site/v2", root / "site/data"
            data_dir.mkdir()
            site.mkdir(parents=True)
            public_data.mkdir(parents=True)
            (site / "index.tpl.html").write_text(
                "__PAYLOAD__|__COUNTERS__|__I18N_DATA__|__TITLE__|__DESC__"
            )
            observed = "2026-09-16T00:00:00Z"
            payload = {
                "cols": ["id"],
                "cities": [{"slug": "sao-paulo-sp", "rows": [["lot-1"]], "lifecycle": {}}],
                "lifecycle_schema_version": 1,
                "provenance": {
                    "schema_version": 2,
                    "release": {
                        "cycle_id": "cycle-clean",
                        "release_mode": "observed_partial",
                        "trusted": False,
                        "absence_inference": False,
                        "global_freshness": None,
                        "scopes": [
                            {
                                "scope": "SP",
                                "observed_at": observed,
                                "source_date": "2026-09-16",
                                "catalog_sha256": "a" * 64,
                            }
                        ],
                    },
                },
            }
            candidate = data_dir / "site.json"
            candidate.write_text(json.dumps(payload, separators=(",", ":")))
            digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
            receipt = data_dir / "site.json.release.json"
            receipt.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "release_id": f"observed_partial:cycle-clean:{digest[:24]}",
                        "artifact_sha256": digest,
                        "release_mode": "observed_partial",
                        "catalog_cycle_id": "cycle-clean",
                        "publication_state": "candidate",
                        "published_at": None,
                    }
                )
            )
            outputs = [
                site / "index.html",
                public_data / "market_reports.json",
                root / "site/lifecycle-projection.json",
                root / "site/lifecycle-release.json",
            ]
            for output in outputs:
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text("STALE")

            argv = [
                "proto_build.py",
                "--release",
                "--site",
                "https://precodemartelo.com",
                "--data",
                str(candidate),
                "--lifecycle-receipt",
                str(receipt),
                "--market-reports",
                str(data_dir / "missing-market.json"),
                "--lot-media",
                str(data_dir / "missing-media.json"),
            ]
            catalogues = {
                "pt": {
                    "foot.note": "dated",
                    "foot.note.unknown": "unknown",
                    "meta.title": "title",
                    "meta.desc": "description",
                }
            }
            built_city = {
                "slug": "sao-paulo-sp",
                "nome": "São Paulo",
                "rows": [["lot-1"]],
                "lifecycle": {},
                "shapes": {},
                "stats": {
                    "lots": 0,
                    "reliable": 0,
                    "below": 0,
                    "promised_med": None,
                    "real_med": None,
                },
            }
            with (
                patch.object(proto_build, "HERE", root),
                patch.object(proto_build, "SITE", site),
                patch.object(proto_build, "LOCAL_PROFILES", root / "missing-local-profiles.json"),
                patch.object(
                    proto_build, "PUBLIC_MARKET_REPORTS", public_data / "market_reports.json"
                ),
                patch.object(proto_build, "build_city", return_value=built_city),
                patch.object(proto_build, "save_shape_cache"),
                patch.object(proto_build, "check_prepositions"),
                patch.object(proto_build.classic, "load_catalogues", return_value=catalogues),
                patch.object(proto_build.classic, "check"),
                patch.object(proto_build.classic, "blob", side_effect=json.dumps),
                patch.object(proto_build, "snippet", return_value="counter"),
                patch.object(sys, "argv", argv),
            ):
                proto_build.main()

            self.assertEqual(
                (root / "site/lifecycle-projection.json").read_bytes(), candidate.read_bytes()
            )
            self.assertNotIn("STALE", (site / "index.html").read_text())
            self.assertNotIn("generated", (site / "index.html").read_text())
            self.assertNotIn("STALE", (public_data / "market_reports.json").read_text())
            manifest = json.loads((root / "site/lifecycle-release.json").read_text())
            self.assertEqual(manifest["release_id"], f"observed_partial:cycle-clean:{digest[:24]}")

    def test_normal_release_accepts_only_strict_partial_without_a_global_date(self):
        partial = {
            "lifecycle_schema_version": 1,
            "provenance": {
                "schema_version": 2,
                "release": {
                    "cycle_id": "cycle-7",
                    "release_mode": "observed_partial",
                    "trusted": False,
                    "global_freshness": None,
                    "absence_inference": False,
                    "scopes": [
                        {
                            "scope": "caixa:SP",
                            "catalog_sha256": "0" * 64,
                            "observed_at": "2026-09-16T00:00:00Z",
                            "source_date": "2026-09-16",
                        }
                    ],
                },
            },
        }
        self.assertIsNone(prerender.payload_date(partial, asserted="", release=True))
        with self.assertRaisesRegex(ValueError, "Missing generated"):
            prerender.payload_date({"generated": None}, asserted="", release=True)
        with self.assertRaisesRegex(ValueError, "Observed-partial"):
            prerender.payload_date(
                {**partial, "generated": "2026-09-16"}, asserted="", release=True
            )

    def test_lifecycle_attestation_assets_are_release_only(self):
        self.assertNotIn("lifecycle-release.json", prerender.asset_paths(release=False))
        self.assertNotIn("lifecycle-projection.json", prerender.asset_paths(release=False))
        self.assertEqual(
            prerender.asset_paths(release=True)[-2:],
            ("lifecycle-release.json", "lifecycle-projection.json"),
        )

    def test_real_templates_and_sitemaps_for_both_hosts(self):
        cat = json.loads((BRAZIL / "site/i18n/pt.json").read_text())
        tpl = (BRAZIL / "site/v2/page.tpl.html").read_text()
        missing = prerender.runtime_keys() - set(cat)
        self.assertFalse(missing, f"Flat page runtime strings missing: {missing}")
        env = {
            "PUBLIC_OPERATOR_NAME": "Test operator",
            "PUBLIC_OPERATOR_CONTACT": "privacy@example.net",
            "GA4_ID": "G-TEST1234",
            "GA4_ENHANCED_MEASUREMENT_DISABLED": "true",
        }
        for site in ["https://yunoshev.github.io/casa-brazil", "https://precodemartelo.com"]:
            with self.subTest(site=site), tempfile.TemporaryDirectory() as directory:
                out = Path(directory)
                prerender.BASE = urlsplit(site).path
                prerender.ANALYTICS = snippet(site, env)
                city = "/leilao-de-imoveis/rj/rio-de-janeiro/"
                lot = city + "lote/apartamento-123/"
                routes = ["/", city, lot, "/404"]
                emitted = {p: [] for p in routes}
                emitted["/privacidade/"] = []
                for path in routes:
                    trail = [{"path": "/", "name": "Brasil"}, {"path": city, "name": "Rio"}]
                    if path == lot:
                        trail.append({"path": lot, "name": "Apartamento"})
                    html = prerender.shell(
                        tpl,
                        {
                            "title": "Test catalogue",
                            "desc": "Public facts",
                            "canonical": canonical_url(site, path),
                            "noindex": path == "/404",
                        },
                        '<h1>Imóveis</h1><a href="'
                        + city
                        + '">Rio</a><a href="/privacidade/">Privacidade</a>'
                        + ('<section data-az="caixa:123"></section>' if path == lot else ""),
                        False,
                        [breadcrumbs(trail, site, emitted)],
                        {"i18n": {"pt": cat}, "cities": [], "here": {"city": "rio-de-janeiro-rj"}},
                    )
                    self.assertFalse([m for m in prerender.MARKERS if m in html])
                    self.assertIn(
                        f'<link rel="canonical" href="{canonical_url(site, path)}">', html
                    )
                    self.assertIn(
                        f'<meta property="og:url" content="{canonical_url(site, path)}">', html
                    )
                    favicon = (
                        "/favicon.svg"
                        if site == "https://precodemartelo.com"
                        else "/casa-brazil/favicon.svg"
                    )
                    rendered = prerender.rebase(html)
                    self.assertIn(f'<link rel="icon" href="{favicon}"', rendered)
                    self.assertIn("window.__ANALYSIS__=", html)
                    self.assertIn('"enhancedMeasurementDisabled":true', html)
                    self.assertLess(html.index("/parts/lang.js"), html.index("/parts/analytics.js"))
                    self.assertIn("/parts/market.js", html)
                    file = out / route_file(path)
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_text(rendered)
                policy = out / "privacidade/index.html"
                policy.parent.mkdir(parents=True, exist_ok=True)
                policy.write_text(
                    prerender.rebase(prerender.complete_head(privacy_page(site, env)))
                )
                # ``data/market_reports.json`` is not a source asset.  In a
                # production release proto_build creates the lifecycle-bound
                # public bytes before prerender runs; copying the private
                # checkout here would recreate the stale-file overwrite this
                # contract is meant to prevent.
                source_assets = tuple(
                    asset for asset in prerender.ASSETS if asset != "data/market_reports.json"
                )
                for asset in source_assets:
                    target = out / asset
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(BRAZIL / "site" / asset, target)
                self.assertFalse((out / "data/market_reports.json").exists())
                prerender.write_sitemap(out, emitted, site, None)
                prerender.write_robots(out, site)
                result = check(out, site, release=site == "https://precodemartelo.com")
                self.assertTrue(result["ok"], result["errors"])
                self.assertEqual(result["html_pages"], 5)
                self.assertEqual(result["sitemap_urls"], 4)
                self.assertNotIn("lastmod", (out / "sitemap.xml").read_text())


if __name__ == "__main__":
    unittest.main()
