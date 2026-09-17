"""Equivalent static-asset regression for the strict Pages build.

The current prerenderer ships an explicit, deterministic asset manifest rather
than rewriting CSS URLs.  This check protects that replacement contract and
the publisher boundary from silently losing a cacheable asset.
"""

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("pages_prerender", ROOT / "prerender.py")
assert SPEC and SPEC.loader
PRERENDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PRERENDER)


class AssetVersioningTests(unittest.TestCase):
    def test_release_asset_manifest_is_explicit_and_all_files_exist(self):
        self.assertIn("v2/style.css", PRERENDER.ASSETS)
        self.assertEqual(len(PRERENDER.ASSETS), len(set(PRERENDER.ASSETS)))
        for asset in PRERENDER.ASSETS:
            with self.subTest(asset=asset):
                self.assertTrue((ROOT / "site" / asset).is_file(), asset)

    def test_release_adds_attestation_assets_without_mutating_preview_manifest(self):
        preview = PRERENDER.asset_paths(release=False)
        release = PRERENDER.asset_paths(release=True)
        self.assertEqual(release[: len(preview)], preview)
        self.assertEqual(release[-2:], ("lifecycle-release.json", "lifecycle-projection.json"))

    def test_manifest_is_a_literal_tuple_not_a_runtime_directory_scan(self):
        self.assertIsInstance(PRERENDER.ASSETS, tuple)
        source = (ROOT / "prerender.py").read_text(encoding="utf-8")
        self.assertIn("ASSETS = (", source)


if __name__ == "__main__":
    unittest.main()
