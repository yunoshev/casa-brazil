"""Equivalent static-asset regression for the strict Pages build.

The current prerenderer ships an explicit, deterministic asset manifest rather
than rewriting CSS URLs.  This check protects that replacement contract and
the publisher boundary from silently losing a cacheable asset.
"""

import hashlib
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

    def test_generated_lot_shell_uses_only_content_versioned_analysis_controller(self):
        digest = hashlib.sha256((ROOT / "site/parts/analyze.js").read_bytes()).hexdigest()[:12]
        template = (ROOT / "site/v2/page.tpl.html").read_text(encoding="utf-8")
        html = PRERENDER.shell(
            template,
            head={"title": "Lot", "desc": "Lot", "canonical": "https://example.test/lot/"},
            body="",
            split=False,
            lot=True,
            ld=[],
            chrome={"i18n": {}, "cities": [], "here": {}},
        )
        expected = f'src="/parts/analyze.js?v={digest}"'
        self.assertEqual(html.count(expected), 1)
        self.assertNotIn('src="/parts/analyze.js"', html)
        css_digest = hashlib.sha256((ROOT / "site/v2/style.css").read_bytes()).hexdigest()[:12]
        self.assertIn(f'href="/v2/style.css?v={css_digest}"', html)
        self.assertNotIn('href="/v2/style.css"', html)
        app_digest = hashlib.sha256((ROOT / "site/v2/app.js").read_bytes()).hexdigest()[:12]
        if 'src="/v2/app.js"' in template:
            self.assertEqual(html.count(f'src="/v2/app.js?v={app_digest}"'), 1)
            self.assertNotIn('src="/v2/app.js"', html)


if __name__ == "__main__":
    unittest.main()
