"""Generated stylesheet URLs follow CSS content, including subpath builds."""
import hashlib
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urljoin

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("prerender_asset_test", ROOT / "prerender.py")
prerender = importlib.util.module_from_spec(SPEC)
# Import without requiring installed Chrome or opening a browser connection.
with mock.patch.dict("os.environ", {"CHROME_BIN": sys.executable}), mock.patch.dict(
    sys.modules, {"websockets": types.ModuleType("websockets")}
):
    SPEC.loader.exec_module(prerender)


class AssetVersioningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        site = Path(self.temp.name)
        (site / "v2").mkdir()
        self.css = site / "v2/style.css"
        self.css.write_bytes(b"h1.lot-address{font-size:24px}")
        patcher = mock.patch.object(prerender, "SITE", site)
        patcher.start()
        self.addCleanup(patcher.stop)

    def render(self, tpl=None, base=""):
        if tpl is None:
            tpl = (ROOT / "site/v2/page.tpl.html").read_text()
        with mock.patch.object(prerender, "BASE", base):
            html = prerender.shell(
                tpl, {"title": "Lot", "desc": "Address", "canonical": "https://example.test/lot/"},
                '<a href="/v2/style.css">Download</a>', False, [],
                {"i18n": {}, "cities": [], "here": {}},
            )
            return prerender.rebase(html)

    def test_content_change_changes_url_and_unchanged_content_is_stable(self):
        first = self.render()
        digest = hashlib.sha256(self.css.read_bytes()).hexdigest()[:12]
        self.assertIn(f'href="/v2/style.css?v={digest}"', first)
        self.assertEqual(first, self.render())
        self.css.write_bytes(b"h1.lot-address{font-size:28px}")
        self.assertNotEqual(first, self.render())
        digest = hashlib.sha256(self.css.read_bytes()).hexdigest()[:12]
        self.assertIn(f'href="/v2/style.css?v={digest}"', self.render())

    def test_root_and_subpath_preserve_fonts_scripts_and_canonical(self):
        for base in ("", "/casa-brazil"):
            with self.subTest(base=base):
                html = self.render(base=base)
                digest = hashlib.sha256(self.css.read_bytes()).hexdigest()[:12]
                css_url = f"{base}/v2/style.css?v={digest}"
                self.assertIn(f'href="{css_url}"', html)
                self.assertIn('href="https://example.test/lot/"', html)
                self.assertIn(f'src="{base}/parts/chrome.js"', html)
                self.assertIn(f'href="{base}/v2/fonts/instrument.woff2"', html)
                self.assertIn(f'<a href="{base}/v2/style.css">Download</a>', html)
                self.assertEqual(urljoin(css_url, "fonts/instrument.woff2"), f"{base}/v2/fonts/instrument.woff2")

    def test_existing_version_is_replaced_without_double_query(self):
        tpl = '<link href="/v2/style.css?theme=dark&amp;v=old&amp;v=older#sheet" rel="stylesheet">'
        once = prerender.version_stylesheet(tpl)
        self.assertEqual(once, prerender.version_stylesheet(once))
        self.assertEqual(once.count("?"), 1)
        self.assertEqual(once.count("v="), 1)
        self.assertIn("?theme=dark&amp;v=", once)
        self.assertIn('#sheet"', once)

    def test_unrelated_template_links_are_untouched(self):
        tpl = ('<link rel="canonical" href="/v2/style.css">'
               '<link rel="stylesheet" href="https://other.test/v2/style.css">'
               '<link rel="stylesheet" href="/other.css">'
               '<script src="/parts/chrome.js"></script>')
        self.assertEqual(tpl, prerender.version_stylesheet(tpl))


if __name__ == "__main__":
    unittest.main()
