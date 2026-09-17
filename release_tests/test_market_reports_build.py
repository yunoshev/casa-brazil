"""Market release hand-off: lifecycle-bound, bounded and public-safe."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BRAZIL = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("proto_build", BRAZIL / "proto_build.py")
BUILD = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BUILD)

BINDING = {
    "release_id": "observed_partial:cycle-7:0123456789abcdef01234567",
    "catalog_cycle_id": "cycle-7",
    "artifact_sha256": "0123456789abcdef" * 4,
}


def market(count=5):
    return {
        "schema": "market-v1",
        "currency": "BRL",
        "sale_asking": {"min": 280000, "max": 350000},
        "discount_pct": 18.5,
        "rent_monthly": {"min": 1800, "max": 2300},
        "yield_pct": 7.8,
        "condo_monthly": {"min": 350, "max": 520},
        "sample": {"count": count, "radius_m": 1000, "freshness_days": 3, "confidence": "medium"},
        "disclaimer": "A amostra usa anúncios de venda e não confirma preços pagos.",
    }


def evidence(count=5, *, private=False):
    return [
        {
            "source_listing_id": f"private-listing-{index}",
            "source_url": f"https://user:secret@internal.example/{index}?token=hidden"
            if private
            else None,
            "operation": "sale",
            "observed_at": f"2026-09-16T12:00:{index:02d}Z",
            "price_brl": 280000 + index * 1000,
            "area_m2": 50,
            "distance_m": 100 + index,
        }
        for index in range(count)
    ]


class MarketReportsBuildTest(unittest.TestCase):
    def test_only_strict_observed_partial_release_can_skip_global_freshness(self):
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
        self.assertIsNone(BUILD.strict_release_freshness(partial, "observed_partial"))
        self.assertEqual(
            BUILD.strict_release_freshness({"generated": "2026-09-16"}, "trusted"),
            "2026-09-16",
        )
        with self.assertRaisesRegex(ValueError, "observed-partial"):
            BUILD.strict_release_freshness(
                {**partial, "generated": "2026-09-16"}, "observed_partial"
            )

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "market_reports.json"

    def write(self, reports, *, binding=BINDING):
        self.path.write_text(
            json.dumps(
                {
                    "schema": "brazil-market-reports-v2",
                    "as_of": "2026-09-16T12:00:00Z",
                    "lifecycle": binding,
                    "availability": {
                        "status": "available" if reports else "insufficient_data",
                        "qualified_reports": len(reports),
                        "minimum_comparable_evidence": 5,
                    },
                    "reports": reports,
                }
            )
        )

    def test_zero_report_case_always_has_honest_empty_public_artifact(self):
        self.write([])
        artifact, lookup = BUILD.prepare_market_reports(self.path, {"known"}, BINDING)
        self.assertEqual(lookup, {})
        self.assertEqual(artifact["availability"]["status"], "insufficient_data")
        self.assertEqual(artifact["availability"]["qualified_reports"], 0)
        self.assertEqual(artifact["reports"], [])

    def test_one_valid_report_is_deterministic_and_private_fields_are_stripped(self):
        self.write(
            [
                {"lot_id": "known", "market": market(), "evidence": evidence(private=True)},
                {"lot_id": "orphan", "market": market(), "evidence": evidence()},
            ]
        )
        artifact, lookup = BUILD.prepare_market_reports(self.path, {"known"}, BINDING)
        self.assertEqual(list(lookup), ["known"])
        self.assertEqual([row["lot_id"] for row in artifact["reports"]], ["known"])
        dumped = json.dumps(artifact)
        self.assertNotIn("private-listing", dumped)
        self.assertNotIn("internal.example", dumped)
        self.assertNotIn("secret", dumped)

    def test_fewer_than_five_evidence_rows_is_omitted_not_valued(self):
        self.write([{"lot_id": "known", "market": market(4), "evidence": evidence(4)}])
        artifact, lookup = BUILD.prepare_market_reports(self.path, {"known"}, BINDING)
        self.assertEqual(lookup, {})
        self.assertEqual(artifact["availability"]["status"], "insufficient_data")
        self.assertEqual(artifact["reports"], [])

    def test_xss_or_undeclared_private_fields_fail_closed(self):
        bad = market()
        bad["disclaimer"] = "<script>alert(1)</script>"
        self.write([{"lot_id": "known", "market": bad, "evidence": evidence()}])
        with self.assertRaises(ValueError):
            BUILD.prepare_market_reports(self.path, {"known"}, BINDING)
        self.write(
            [{"lot_id": "known", "market": market(), "evidence": evidence(), "password": "x"}]
        )
        with self.assertRaises(ValueError):
            BUILD.prepare_market_reports(self.path, {"known"}, BINDING)

    def test_lifecycle_mismatch_fails_closed(self):
        self.write(
            [{"lot_id": "known", "market": market(), "evidence": evidence()}],
            binding=dict(BINDING, artifact_sha256="f" * 64),
        )
        with self.assertRaisesRegex(ValueError, "does not match"):
            BUILD.prepare_market_reports(self.path, {"known"}, BINDING)

    def test_source_size_cap_fails_closed(self):
        self.path.write_bytes(b"x" * (4 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, "size cap"):
            BUILD.prepare_market_reports(self.path, {"known"}, BINDING)

    def test_public_artifact_size_cap_fails_closed(self):
        self.write([{"lot_id": "known", "market": market(), "evidence": evidence()}])
        with (
            patch("market_release.MAX_PUBLIC_BYTES", 1),
            self.assertRaisesRegex(ValueError, "size cap"),
        ):
            BUILD.prepare_market_reports(self.path, {"known"}, BINDING)


if __name__ == "__main__":
    unittest.main()
