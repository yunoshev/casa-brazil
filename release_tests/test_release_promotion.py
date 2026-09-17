import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("release_promotion", ROOT / "release_promotion.py")
PROMOTE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PROMOTE
SPEC.loader.exec_module(PROMOTE)


def candidate(cycle="cycle-2", observed="2026-09-16T00:00:00Z"):
    payload = {
        "cols": [],
        "cities": [],
        "lifecycle_schema_version": 1,
        "provenance": {
            "schema_version": 2,
            "release": {
                "cycle_id": cycle,
                "release_mode": "observed_partial",
                "trusted": False,
                "global_freshness": None,
                "absence_inference": False,
                "observed_at": observed,
                "scopes": [
                    {
                        "scope": "caixa:SP",
                        "catalog_sha256": "0" * 64,
                        "observed_at": observed,
                        "source_date": "2026-09-16",
                    }
                ],
            },
        },
    }
    data = PROMOTE.json_bytes(payload)
    digest = hashlib.sha256(data).hexdigest()
    receipt = {
        "schema_version": 1,
        "release_id": f"observed_partial:{cycle}:{digest[:24]}",
        "artifact_sha256": digest,
        "release_mode": "observed_partial",
        "catalog_cycle_id": cycle,
        "publication_state": "candidate",
        "published_at": None,
    }
    return payload, data, receipt


class ReleasePromotionTest(unittest.TestCase):
    def test_observed_partial_contract_allows_only_null_global_freshness(self):
        payload, data, receipt = candidate()
        self.assertTrue(PROMOTE.observed_partial_without_global_freshness(payload))
        self.assertEqual(PROMOTE._candidate_receipt(data, receipt), receipt)
        for change in (
            {"generated": "2026-09-16"},
            {"lifecycle_schema_version": 2},
            {
                "provenance": {
                    "schema_version": 2,
                    "catalog_cycle": {},
                    "release": payload["provenance"]["release"],
                }
            },
            {
                "provenance": {
                    "schema_version": 2,
                    "release": {
                        **payload["provenance"]["release"],
                        "global_freshness": "2026-09-16",
                    },
                }
            },
            {
                "provenance": {
                    "schema_version": 2,
                    "release": {**payload["provenance"]["release"], "absence_inference": True},
                }
            },
            {
                "provenance": {
                    "schema_version": 2,
                    "release": {**payload["provenance"]["release"], "trusted": True},
                }
            },
            {
                "provenance": {
                    "schema_version": 2,
                    "release": {**payload["provenance"]["release"], "scopes": []},
                }
            },
            {
                "provenance": {
                    "schema_version": 2,
                    "release": {
                        **payload["provenance"]["release"],
                        "scopes": [
                            {
                                **payload["provenance"]["release"]["scopes"][0],
                                "catalog_sha256": "not-a-digest",
                            }
                        ],
                    },
                }
            },
            {"source_as_of": "2026-09-16"},
        ):
            with self.subTest(change=change):
                invalid = {**payload, **change}
                with self.assertRaisesRegex(ValueError, "Observed-partial"):
                    PROMOTE.observed_partial_without_global_freshness(invalid)

        trusted = {"generated": "2026-09-16", "cities": []}
        self.assertFalse(PROMOTE.observed_partial_without_global_freshness(trusted))

    def test_trusted_candidate_still_requires_explicit_complete_global_freshness(self):
        payload = {
            "generated": "2026-09-16",
            "cols": [],
            "cities": [],
            "lifecycle_schema_version": 1,
            "provenance": {
                "schema_version": 2,
                "catalog_cycle": {"cycle_id": "trusted-1", "trusted": True},
            },
        }
        data = PROMOTE.json_bytes(payload)
        digest = hashlib.sha256(data).hexdigest()
        receipt = {
            "schema_version": 1,
            "release_id": f"trusted:trusted-1:{digest[:24]}",
            "artifact_sha256": digest,
            "release_mode": "trusted",
            "catalog_cycle_id": "trusted-1",
            "publication_state": "candidate",
            "published_at": None,
        }
        self.assertEqual(PROMOTE.candidate_contract(data, receipt, payload), receipt)
        for key, value in (("generated", None), ("generated", "not-a-date")):
            invalid = {**payload, key: value}
            invalid_data = PROMOTE.json_bytes(invalid)
            invalid_digest = hashlib.sha256(invalid_data).hexdigest()
            invalid_receipt = {
                **receipt,
                "artifact_sha256": invalid_digest,
                "release_id": f"trusted:trusted-1:{invalid_digest[:24]}",
            }
            with self.assertRaisesRegex(ValueError, "global generated"):
                PROMOTE.candidate_contract(invalid_data, invalid_receipt, invalid)

    def test_manifest_is_deterministic_and_requires_candidate_receipt(self):
        payload, data, receipt = candidate()
        manifest = PROMOTE.manifest_for_candidate(data, receipt, payload)
        self.assertEqual(manifest["projection_path"], "lifecycle-projection.json")
        self.assertEqual(manifest["projection_bytes"], len(data))
        self.assertEqual(manifest["build_code"], "brazil-strict-lifecycle")
        self.assertEqual(manifest["build_version"], 1)
        self.assertEqual(PROMOTE._manifest(manifest), manifest)
        with self.assertRaises(ValueError):
            PROMOTE.manifest_for_candidate(
                data, dict(receipt, publication_state="published"), payload
            )

    def test_manifest_attests_bounded_market_artifact_bytes(self):
        payload, data, receipt = candidate()
        market = b'{"schema":"brazil-market-reports-public-v1","reports":[]}'
        manifest = PROMOTE.manifest_for_candidate(
            data,
            receipt,
            payload,
            public_artifacts={"data/market_reports.json": market},
        )
        artifact = manifest["public_artifacts"]["data/market_reports.json"]
        self.assertEqual(artifact["bytes"], len(market))
        self.assertEqual(artifact["sha256"], hashlib.sha256(market).hexdigest())
        self.assertEqual(PROMOTE._manifest(manifest), manifest)
        PROMOTE._verify_public_artifacts(
            manifest,
            lambda url: market if url.endswith("data/market_reports.json") else b"",
            "https://precodemartelo.com",
        )
        with self.assertRaisesRegex(ValueError, "market artifact"):
            PROMOTE._verify_public_artifacts(
                manifest,
                lambda _url: b"different",
                "https://precodemartelo.com",
            )

    def test_legacy_baseline_manifest_requires_null_freshness_without_generated_date(self):
        payload, data, receipt = candidate()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact, candidate_receipt, manifest = (
                root / "site.json",
                root / "site.json.release.json",
                root / "lifecycle-release.json",
            )
            artifact.write_bytes(data)
            candidate_receipt.write_bytes(PROMOTE.json_bytes(receipt))
            PROMOTE.emit_manifest(artifact, candidate_receipt, manifest, legacy_baseline=True)
            self.assertEqual(json.loads(manifest.read_text())["release_mode"], "observed_partial")
            payload["generated"] = "2026-09-16"
            artifact.write_bytes(PROMOTE.json_bytes(payload))
            with self.assertRaisesRegex(ValueError, "strict observed-partial"):
                PROMOTE.emit_manifest(artifact, candidate_receipt, manifest, legacy_baseline=True)

    def test_hermetic_promotion_is_exact_idempotent_and_antirollback(self):
        payload, data, receipt = candidate()
        manifest = PROMOTE.manifest_for_candidate(data, receipt, payload)
        urls = []

        def transport(url):
            urls.append(url)
            return PROMOTE.json_bytes(manifest) if url.endswith(PROMOTE.MANIFEST_NAME) else data

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, source_receipt = root / "candidate.json", root / "candidate.release.json"
            source.write_bytes(data)
            source_receipt.write_bytes(PROMOTE.json_bytes(receipt))

            def now():
                return datetime(2026, 9, 16, tzinfo=UTC)

            self.assertEqual(
                PROMOTE.promote(
                    source,
                    source_receipt,
                    root,
                    transport=transport,
                    now=now,
                    bootstrap_legacy=True,
                ),
                "bootstrapped",
            )
            generation = (root / "exports/published.current").resolve()
            stored = json.loads((generation / "published.release.json").read_text())
            self.assertEqual(stored["release_mode"], "legacy_baseline")
            self.assertEqual(
                PROMOTE.promote(source, source_receipt, root, transport=transport, now=now),
                "already_published",
            )
            self.assertEqual(urls[0], "https://precodemartelo.com/lifecycle-release.json")
            self.assertEqual(urls[1], "https://precodemartelo.com/lifecycle-projection.json")
            _, old_data, old_receipt = candidate("cycle-old", "2026-09-15T00:00:00Z")
            source.write_bytes(old_data)
            source_receipt.write_bytes(PROMOTE.json_bytes(old_receipt))
            old_manifest = PROMOTE.manifest_for_candidate(
                old_data, old_receipt, json.loads(old_data)
            )
            with self.assertRaisesRegex(ValueError, "rollback"):
                PROMOTE.promote(
                    source,
                    source_receipt,
                    root,
                    transport=lambda u: (
                        PROMOTE.json_bytes(old_manifest)
                        if u.endswith(PROMOTE.MANIFEST_NAME)
                        else old_data
                    ),
                    now=now,
                )

    def test_torn_generation_never_changes_the_current_pointer(self):
        payload, old_data, old_receipt = candidate("old", "2026-09-15T00:00:00Z")
        new_payload, new_data, new_receipt = candidate("new", "2026-09-16T00:00:00Z")
        old_manifest = PROMOTE.manifest_for_candidate(old_data, old_receipt, payload)
        new_manifest = PROMOTE.manifest_for_candidate(new_data, new_receipt, new_payload)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, source_receipt = root / "candidate.json", root / "candidate.release.json"
            source.write_bytes(old_data)
            source_receipt.write_bytes(PROMOTE.json_bytes(old_receipt))

            def transport(url):
                return (
                    PROMOTE.json_bytes(old_manifest)
                    if url.endswith(PROMOTE.MANIFEST_NAME)
                    else old_data
                )

            PROMOTE.promote(
                source,
                source_receipt,
                root,
                transport=transport,
                bootstrap_legacy=True,
                now=lambda: datetime(2026, 9, 16, tzinfo=UTC),
            )
            pointer = root / "exports/published.current"
            before_target = os.readlink(pointer)
            before = PROMOTE._current_generation(root / "exports")
            source.write_bytes(new_data)
            source_receipt.write_bytes(PROMOTE.json_bytes(new_receipt))
            real_write = PROMOTE.atomic_write
            calls = 0

            def fail_receipt(path, data):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("disk full")
                real_write(path, data)

            with (
                patch.object(PROMOTE, "atomic_write", side_effect=fail_receipt),
                self.assertRaises(OSError),
            ):
                PROMOTE.promote(
                    source,
                    source_receipt,
                    root,
                    transport=lambda u: (
                        PROMOTE.json_bytes(new_manifest)
                        if u.endswith(PROMOTE.MANIFEST_NAME)
                        else new_data
                    ),
                    now=lambda: datetime(2026, 9, 17, tzinfo=UTC),
                )
            self.assertEqual(os.readlink(pointer), before_target)
            self.assertEqual(PROMOTE._current_generation(root / "exports"), before)

    def test_transport_rejects_redirect_and_wrong_content_type(self):
        with self.assertRaises(ValueError):
            PROMOTE._response(
                lambda u: PROMOTE.TransportResponse(b"{}", 302, u, "application/json"),
                "https://precodemartelo.com/lifecycle-release.json",
            )
        with self.assertRaises(ValueError):
            PROMOTE._response(
                lambda u: PROMOTE.TransportResponse(b"{}", 200, u, "text/html"),
                "https://precodemartelo.com/lifecycle-release.json",
            )


if __name__ == "__main__":
    unittest.main()
