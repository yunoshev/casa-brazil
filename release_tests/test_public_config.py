import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from public_config import privacy_page, settings, snippet
from release_check import Page


class PublicConfigTest(unittest.TestCase):
    site = "https://yunoshev.github.io/casa-brazil"

    def test_analysis_config_without_analytics(self):
        output = snippet(self.site, {})
        self.assertIn("window.__ANALYSIS__", output)
        self.assertIn("window.__MAPS__={}", output)
        self.assertNotIn('src="/parts/analytics.js"', output)
        self.assertNotIn("maps.googleapis.com", output)
        self.assertEqual(settings(self.site, {})["analysis"]["privacyContact"], "")

    def test_empty_maps_embed_key_produces_empty_config(self):
        self.assertEqual(settings(self.site, {})["maps"], {})
        self.assertEqual(settings(self.site, {"MAPS_EMBED_API_KEY": ""})["maps"], {})
        self.assertIn("window.__MAPS__={}", snippet(self.site, {"MAPS_EMBED_API_KEY": ""}))

    def test_maps_embed_key_is_public_config_without_auto_load(self):
        key = "AIza" + "aB0_-" * 7
        cfg = settings(self.site, {"MAPS_EMBED_API_KEY": key})
        self.assertEqual(cfg["maps"], {"embedKey": key})
        output = snippet(self.site, {"MAPS_EMBED_API_KEY": key})
        self.assertIn(f'window.__MAPS__={{"embedKey":"{key}"}}', output)
        self.assertNotIn("maps.googleapis.com", output)

    def test_maps_embed_key_rejects_invalid_values(self):
        for value in (
            " ",
            "not-a-google-key",
            "AIza" + "a" * 34,
            "AIza" + "a" * 36,
            "AIza" + "a" * 34 + "<",
            "AIza" + "a" * 34 + "\n",
        ):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    settings(self.site, {"MAPS_EMBED_API_KEY": value})

    def test_analysis_requires_exact_lowercase_true(self):
        for value in (None, "false", "TRUE", "1"):
            env = {} if value is None else {"BRAZIL_PUBLIC_ANALYSIS_ENABLED": value}
            cfg = settings(self.site, env)["analysis"]
            self.assertFalse(cfg["enabled"])
            self.assertFalse(cfg["uploadEnabled"])

        cfg = settings(self.site, {"BRAZIL_PUBLIC_ANALYSIS_ENABLED": "true"})["analysis"]
        self.assertTrue(cfg["enabled"])
        self.assertTrue(cfg["uploadEnabled"])

    def test_upload_is_fail_closed_for_an_overridden_api_origin(self):
        cfg = settings(
            self.site,
            {
                "BRAZIL_PUBLIC_ANALYSIS_ENABLED": "true",
                "ANALYSIS_API_BASE": "https://other-worker.example",
            },
        )["analysis"]
        self.assertTrue(cfg["enabled"])
        self.assertFalse(cfg["uploadEnabled"])

    def test_readonly_reports_require_explicit_flag_and_are_independent(self):
        for value in (None, "false", "TRUE", "1"):
            env = {} if value is None else {"LOT_REPORTS_ENABLED": value}
            self.assertFalse(settings(self.site, env)["analysis"]["reportsEnabled"])
        reports_only = settings(self.site, {"LOT_REPORTS_ENABLED": "true"})["analysis"]
        self.assertTrue(reports_only["reportsEnabled"])
        self.assertFalse(reports_only["enabled"])
        analysis_only = settings(self.site, {"BRAZIL_PUBLIC_ANALYSIS_ENABLED": "true"})["analysis"]
        self.assertTrue(analysis_only["enabled"])
        self.assertFalse(analysis_only["reportsEnabled"])

    def test_invalid_measurement_id_or_api(self):
        for env in [
            {"GA4_ID": "not-a-stream"},
            {"ANALYSIS_API_BASE": "http://unsafe.example"},
            {"ANALYSIS_API_BASE": "https://user:secret@api.caixa.gov.br"},
        ]:
            with self.assertRaises(ValueError):
                settings(self.site, env)

    def test_ga_requires_explicit_stream_configuration(self):
        env = {"GA4_ID": "G-TEST1234"}
        self.assertFalse(settings(self.site, env)["analytics"]["enhancedMeasurementDisabled"])
        env["GA4_ENHANCED_MEASUREMENT_DISABLED"] = "true"
        self.assertTrue(settings(self.site, env)["analytics"]["enhancedMeasurementDisabled"])

    def test_inline_script_escapes_contact(self):
        output = snippet(
            self.site,
            {
                "PUBLIC_OPERATOR_NAME": "Owner",
                "PUBLIC_OPERATOR_CONTACT": "</script><script>oops</script>",
            },
        )
        self.assertNotIn("</script><script>oops", output)
        self.assertIn("\\u003c", output)

    def test_unconfigured_policy_is_noindex(self):
        page = Page(privacy_page(self.site, {}))
        self.assertTrue(page.noindex)
        self.assertTrue(page.doctype)

    def test_policy_configured_and_rebased(self):
        source = privacy_page(
            self.site,
            {"PUBLIC_OPERATOR_NAME": "Owner", "PUBLIC_OPERATOR_CONTACT": "privacy@example.net"},
        )
        page = Page(source)
        self.assertFalse(page.noindex)
        self.assertEqual(page.canonicals, [self.site + "/privacidade/"])
        self.assertIn('href="/casa-brazil/v2/style.css"', source)
        self.assertNotIn("gtag/js", source)
        self.assertIn("backend\nCasa Radar", source)
        self.assertIn("Google Gemini", source)
        self.assertIn("trechos selecionados", source)
        self.assertNotIn("30 dias", source)
        self.assertNotIn("registros operacionais ficam no serviço Cloudflare", source)
        self.assertIn("não oferece lista de espera por email", source)


if __name__ == "__main__":
    unittest.main()
