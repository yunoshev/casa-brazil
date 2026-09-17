"""Freshness metadata must come from the exported source, never this build."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("proto_build_freshness", ROOT / "proto_build.py")
assert SPEC and SPEC.loader
proto_build = importlib.util.module_from_spec(SPEC)
with mock.patch.dict(
    sys.modules, {"build": types.ModuleType("build"), "shapes": types.ModuleType("shapes")}
):
    SPEC.loader.exec_module(proto_build)


class FreshnessTest(unittest.TestCase):
    def source(self, value: dict) -> dict:
        """Exercise the parser on an export-shaped temporary JSON file."""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "site.json"
            path.write_text(json.dumps(value))
            return json.loads(path.read_text())

    def test_projection_generated_is_authoritative_and_verbatim(self):
        source = self.source(
            {
                "site_projection": {"generated": "2025-08-27T14:03:02Z"},
                "generated": {"source": "2025-08-01"},
                "cities": [{"generated": "2099-01-01"}],
            }
        )
        self.assertEqual(proto_build.source_freshness(source), "2025-08-27T14:03:02Z")

    def test_explicit_generated_source_is_used_without_date_inference(self):
        source = self.source({"generated": {"source": "2025-08-27"}, "cities": []})
        self.assertEqual(proto_build.source_freshness(source), "2025-08-27")

    def test_missing_source_freshness_uses_localized_unknown_footer(self):
        source = self.source({"cities": [{"generated": "2025-08-27"}]})
        self.assertIsNone(proto_build.source_freshness(source))
        catalogues = {
            "en": {"foot.note": "date: {date}", "foot.note.unknown": "freshness is unknown"},
            "pt": {"foot.note": "data: {date}", "foot.note.unknown": "data desconhecida"},
        }
        rendered = proto_build.catalogue_for_freshness(catalogues, None)
        self.assertEqual(rendered["en"]["foot.note"], "freshness is unknown")
        self.assertEqual(rendered["pt"]["foot.note"], "data desconhecida")
        self.assertEqual(catalogues["en"]["foot.note"], "date: {date}")

    def test_invalid_and_future_source_dates_are_rejected(self):
        with self.assertRaises(ValueError):
            proto_build.source_freshness(self.source({"generated": "not-a-date"}))
        with self.assertRaises(ValueError):
            proto_build.source_freshness(self.source({"generated": "2999-01-01"}))

    def test_lifecycle_ages_only_active_records_without_mutating_input(self):
        as_of = datetime(2025, 8, 30, tzinfo=UTC)
        lifecycle = {
            "old": {"status": "active", "last_seen_at": "2025-08-26T23:59:59Z"},
            "fresh": {"status": "active", "last_seen_at": "2025-08-27T00:00:00Z"},
            "future": {"status": "active", "last_seen_at": "2025-08-31T00:00:00Z"},
            "no_date": {"status": "active"},
            "missing": {"status": "missing"},
            "archived": {"status": "archived"},
        }
        projected = proto_build.projected_lifecycle(lifecycle, as_of=as_of)
        self.assertEqual(projected["old"]["status"], "unverified")
        self.assertEqual(projected["fresh"]["status"], "active")
        self.assertEqual(projected["future"]["status"], "unverified")
        self.assertEqual(projected["no_date"]["status"], "unverified")
        self.assertEqual(projected["missing"]["status"], "missing")
        self.assertEqual(projected["archived"]["status"], "archived")
        self.assertEqual(lifecycle["old"]["status"], "active")

    def test_city_statistics_are_active_only_and_report_unverified_separately(self):
        cols = {"id": 0, "conf": 1, "ring": 2, "promised": 3, "margin": 4}
        city = {
            "slug": "rio-de-janeiro-rj",
            "cidade": "RIO DE JANEIRO",
            "nome": "Rio",
            "rows": [
                ["fresh", "ok", 0, 50, 10],
                ["old", "ok", 0, 50, 10],
                ["gone", "ok", 0, 50, 10],
            ],
            "lifecycle": {
                "fresh": {"status": "active", "last_seen_at": "2025-08-29T00:00:00Z"},
                "old": {"status": "active", "last_seen_at": "2025-08-20T00:00:00Z"},
                "gone": {"status": "missing"},
            },
        }
        with (
            mock.patch.object(proto_build, "outlines", return_value=None),
            mock.patch.object(proto_build, "market", return_value={}),
            mock.patch.object(proto_build, "upkeep", return_value={}),
            mock.patch.object(proto_build, "streets", return_value={}),
        ):
            built = proto_build.build_city(city, cols, as_of=datetime(2025, 8, 30, tzinfo=UTC))
        self.assertEqual(len(built["rows"]), 3)
        self.assertEqual(built["stats"]["lots"], 1)
        self.assertEqual(built["stats"]["unverified"], 1)
        self.assertEqual(built["lifecycle"]["old"]["status"], "unverified")

    def test_lifecycle_schema_version_is_a_top_level_payload_contract(self):
        source = self.source({"lifecycle_schema_version": 1, "cities": []})
        payload = {"cities": []}
        proto_build.copy_top_metadata(payload, source)
        self.assertEqual(payload["lifecycle_schema_version"], 1)


if __name__ == "__main__":
    unittest.main()
