"""Public consent settings and privacy output; no browser or network."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from public_config import settings, snippet, privacy_page, validate_site_url

spec = importlib.util.spec_from_file_location("analytics_prerender", ROOT / "prerender.py")
prerender = importlib.util.module_from_spec(spec)
with mock.patch.dict(os.environ, {"CHROME_BIN": sys.executable}), mock.patch.dict(
    sys.modules, {"websockets": types.ModuleType("websockets")}
):
    spec.loader.exec_module(prerender)


class PublicConfigTests(unittest.TestCase):
    def test_explicit_gate_and_no_implicit_tracker(self):
        self.assertEqual(snippet({}), "")
        self.assertEqual(snippet({"CF_BEACON": "unused"}), "")
        self.assertFalse(settings({"GA4_ID": "G-TEST1234"})["enhancedMeasurementDisabled"])
        env = {"GA4_ID": "G-TEST1234", "GA4_ENHANCED_MEASUREMENT_DISABLED": "true"}
        self.assertTrue(settings(env)["enhancedMeasurementDisabled"])
        self.assertNotIn("googletagmanager", snippet(env))
        with self.assertRaises(ValueError):
            settings({"GA4_ID": "</script>"})

    def test_script_version_matches_content_and_rebases(self):
        env = {"GA4_ID": "G-TEST1234"}
        digest = hashlib.sha256((ROOT / "site/parts/analytics.js").read_bytes()).hexdigest()[:12]
        self.assertIn(f'/parts/analytics.js?v={digest}', snippet(env))
        self.assertEqual(snippet(env), snippet(env))
        for base in ("", "/casa-brazil"):
            with mock.patch.object(prerender, "BASE", base):
                self.assertIn(f'src="{base}/parts/analytics.js?v={digest}"', prerender.rebase(snippet(env)))
        # Changed source bytes must select a new URL without writing assets.
        with mock.patch("public_config.Path.read_bytes", return_value=b"changed script"):
            self.assertNotIn(f'?v={digest}', snippet(env))

    def test_privacy_output_preserves_css_version_and_base_path(self):
        css = hashlib.sha256((ROOT / "site/v2/style.css").read_bytes()).hexdigest()[:12]
        for base in ("", "/casa-brazil"):
            with tempfile.TemporaryDirectory() as temp, mock.patch.object(prerender, "BASE", base):
                prerender.write_privacy(Path(temp), "https://example.test" + base)
                page = (Path(temp) / "privacidade/index.html").read_text()
                self.assertIn(f'href="{base}/v2/style.css?v={css}"', page)
                self.assertIn(f'href="https://example.test{base}/privacidade/"', page)
                self.assertIn(f'href="{base}/"', page)
                self.assertNotIn("gtag/js", page)
                self.assertNotIn("__COUNTERS__", page)
                self.assertIn("não oferece cadastro por email", page)

    def test_no_operator_or_contact_is_published(self):
        page = privacy_page("https://example.test", {"PUBLIC_OPERATOR_NAME": "secret-operator", "PUBLIC_OPERATOR_CONTACT": "secret@example.test"})
        self.assertNotIn("secret", page)
        self.assertNotIn("Responsável:", page)
        self.assertNotIn("Contato:", page)

    def test_invalid_site_rejected(self):
        for site in ("http://example.test", "https://user:pass@example.test", "https://example.test/?email=x", "https://example.test/#x", "https://example.test/../"):
            with self.assertRaises(ValueError):
                validate_site_url(site)

    def test_templates_keep_runtime_order_and_existing_hooks(self):
        for filename in ("index.tpl.html", "page.tpl.html"):
            template = (ROOT / "site/v2" / filename).read_text()
            self.assertLess(template.index('/parts/lang.js'), template.index('__COUNTERS__'))
            self.assertLess(template.index('__COUNTERS__'), template.index('/parts/analyze.js'))
            self.assertIn('/privacidade/', template)
        template = (ROOT / "site/v2/page.tpl.html").read_text()
        self.assertIn('__HOME_GEO__', template)
        with mock.patch.object(prerender, "ANALYTICS", snippet({"GA4_ID": "G-TEST1234"})):
            output = prerender.shell(template, {"title": "Lot", "desc": "Lot", "canonical": "https://example.test"}, "", False, [], {"i18n": {}, "cities": [], "here": {}})
        self.assertNotIn('__COUNTERS__', output)
        self.assertIn('/parts/analytics.js?v=', output)

    def test_flat_pages_include_all_runtime_translation_keys(self):
        needed = prerender.runtime_keys()
        self.assertIn("analytics.accept", needed)
        for lang in ("pt", "en", "ru"):
            catalogue = json.loads((ROOT / "site/i18n" / (lang + ".json")).read_text())
            self.assertFalse(needed - catalogue.keys(), lang)


if __name__ == "__main__":
    unittest.main()
