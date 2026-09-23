"""Public media boundary: optional input, exact joins and deterministic payload."""

import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

BRAZIL = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("proto_build_media", BRAZIL / "proto_build.py")
assert SPEC and SPEC.loader
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class LotMediaBuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.media = self.root / "lot-media.json"

    def write_media(self, value):
        self.media.write_text(json.dumps(value), encoding="utf-8")

    def test_absent_media_is_optional(self):
        self.assertEqual(BUILD.load_lot_media(self.media, {"rio": {"current"}}), {})

    def test_legacy_and_new_media_keep_exact_published_city_and_lot_join(self):
        self.write_media(
            {
                # Version was absent from the earliest reviewed artifact.
                "cities": {
                    "rio": {
                        "current": {
                            "photos": ["https://img.example.test/current.jpg"],
                            "scope": "source_snapshot",
                        },
                        "archive": {
                            "gallery": [
                                {
                                    "url": "https://img.example.test/archive-2.jpg",
                                    "provenance": {"snapshot": "private.json"},
                                },
                                {"url": "https://img.example.test/archive-1.jpg"},
                            ]
                        },
                        "removed": {"photos": ["https://img.example.test/not-published.jpg"]},
                    },
                    "wrong-city": {"current": {"photos": ["https://img.example.test/wrong.jpg"]}},
                }
            }
        )
        result = BUILD.load_lot_media(self.media, {"rio": {"current", "archive"}})
        self.assertEqual(
            result,
            {
                "version": 1,
                "cities": {
                    "rio": {
                        "archive": {
                            "gallery": [
                                {"url": "https://img.example.test/archive-2.jpg"},
                                {"url": "https://img.example.test/archive-1.jpg"},
                            ]
                        },
                        "current": {"photos": ["https://img.example.test/current.jpg"]},
                    }
                },
            },
        )
        rendered = json.dumps(result)
        self.assertNotIn("private.json", rendered)
        self.assertNotIn("wrong-city", rendered)
        self.assertNotIn("removed", rendered)

    def test_invalid_urls_never_reach_public_payload(self):
        self.write_media(
            {
                "version": 1,
                "cities": {
                    "rio": {
                        "current": {
                            "gallery": [
                                {"url": "https://img.example.test/ok.jpg"},
                                {"url": "https://img.example.test/private.jpg?token=secret"},
                                {"url": "https://user:password@img.example.test/credentials.jpg"},
                                {"url": "https://127.0.0.1/local.jpg"},
                                {"url": "javascript:alert(1)"},
                                {"url": "https://img.example.test/<script>.jpg"},
                            ],
                            "primary_photo": "https://img.example.test/primary.jpg#fragment",
                        }
                    }
                },
            }
        )
        result = BUILD.load_lot_media(self.media, {"rio": {"current"}})
        self.assertEqual(
            result["cities"]["rio"]["current"],
            {
                "gallery": [{"url": "https://img.example.test/ok.jpg"}],
            },
        )
        rendered = json.dumps(result)
        for forbidden in ("secret", "password", "127.0.0.1", "javascript:", "<script>", "fragment"):
            self.assertNotIn(forbidden, rendered)

    def test_build_embeds_only_current_and_archive_fixture_media_deterministically(self):
        source = self.root / "site.json"
        source.write_text(
            json.dumps(
                {
                    "generated": "2026-09-15",
                    "cols": ["id"],
                    "cities": [{"rows": [["current"], ["archive"]]}],
                }
            ),
            encoding="utf-8",
        )
        self.write_media(
            {
                "version": 1,
                "cities": {
                    "rio": {
                        "current": {"photos": ["https://img.example.test/current.jpg"]},
                        "archive": {"gallery": [{"url": "https://img.example.test/archive.jpg"}]},
                        "unknown": {"photos": ["https://img.example.test/unknown.jpg"]},
                    }
                },
            }
        )
        site = self.root / "site" / "v2"
        site.mkdir(parents=True)
        real_public_market_reports = BUILD.PUBLIC_MARKET_REPORTS
        real_market_before = (
            real_public_market_reports.read_bytes()
            if real_public_market_reports.exists()
            else None
        )
        public_market_reports = self.root / "site" / "data" / "market_reports.json"
        public_market_reports.parent.mkdir(parents=True)
        market_sentinel = b"lifecycle-bound-market-sentinel\n"
        public_market_reports.write_bytes(market_sentinel)
        (site / "index.tpl.html").write_text(
            "<script>window.__D__ = __PAYLOAD__;</script>__I18N_DATA____COUNTERS____TITLE____DESC__",
            encoding="utf-8",
        )
        built_city = {
            "slug": "rio",
            "nome": "Rio",
            "rows": [["current"], ["archive"]],
            "shapes": {},
            "stats": {"lots": 1, "reliable": 0, "below": 0, "promised_med": None, "real_med": None},
        }
        catalogues = {"pt": {"meta.title": "title", "meta.desc": "desc"}}
        argv = [
            "--data",
            str(source),
            "--lot-media",
            str(self.media),
            "--market-reports",
            str(self.root / "none.json"),
        ]
        with (
            mock.patch.object(BUILD, "SITE", site),
            mock.patch.object(BUILD, "LOCAL_PROFILES", self.root / "missing-local-profiles.json"),
            mock.patch.object(BUILD, "PUBLIC_MARKET_REPORTS", public_market_reports),
            mock.patch.object(BUILD, "build_city", return_value=built_city),
            mock.patch.object(BUILD, "save_shape_cache"),
            mock.patch.object(BUILD.classic, "load_catalogues", return_value=catalogues),
            mock.patch.object(BUILD.classic, "check"),
            mock.patch.object(BUILD, "snippet", return_value=""),
        ):
            with mock.patch("sys.argv", ["proto_build.py", *argv]):
                BUILD.main()
            first = (site / "index.html").read_text(encoding="utf-8")
            first_market = public_market_reports.read_bytes()
            with mock.patch("sys.argv", ["proto_build.py", *argv]):
                BUILD.main()
            second = (site / "index.html").read_text(encoding="utf-8")
            second_market = public_market_reports.read_bytes()

        self.assertEqual(first, second)
        self.assertNotEqual(first_market, market_sentinel)
        self.assertEqual(first_market, second_market)
        generated_market = json.loads(first_market)
        self.assertEqual(generated_market["schema"], "brazil-market-reports-public-v1")
        self.assertEqual(generated_market["reports"], [])
        if real_market_before is None:
            self.assertFalse(real_public_market_reports.exists())
        else:
            self.assertEqual(real_public_market_reports.read_bytes(), real_market_before)
        payload_match = re.search(r"window\.__D__ = (.+?)</script>", first)
        self.assertIsNotNone(payload_match)
        payload = json.loads(payload_match.group(1).rstrip(";"))
        self.assertEqual(set(payload["media"]["cities"]["rio"]), {"current", "archive"})
        self.assertIn("https://img.example.test/current.jpg", first)
        self.assertIn("https://img.example.test/archive.jpg", first)
        self.assertNotIn("unknown.jpg", first)


if __name__ == "__main__":
    unittest.main()
