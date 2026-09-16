import importlib.util
import ast
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("proto_build_media", ROOT / "proto_build.py")
assert SPEC and SPEC.loader
PROTO = importlib.util.module_from_spec(SPEC)
with mock.patch.dict(sys.modules, {"build": types.ModuleType("build"), "shapes": types.ModuleType("shapes")}):
    SPEC.loader.exec_module(PROTO)


class LotMediaProjectionTests(unittest.TestCase):
    def test_build_helper_is_self_contained_and_has_no_private_import(self):
        tree = ast.parse((ROOT / "proto_build.py").read_text(encoding="utf-8"))
        imports = [node for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))]
        imported = " ".join(alias.name for node in imports for alias in getattr(node, "names", []))
        self.assertNotIn("casa_radar", imported)
        self.assertNotIn("auction_sources", imported)
        self.assertNotIn("experiments", imported)

    def media_file(self, value):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lot-media.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            return PROTO.load_lot_media(path)

    def test_current_public_lots_are_covered_without_touching_site_json(self):
        site = json.loads((ROOT / "data" / "site.json").read_text(encoding="utf-8"))
        media = PROTO.load_lot_media()
        public_ids = {str(row[site["cols"].index("id")]) for city in site["cities"] for row in city["rows"]}
        media_ids = {lot_id for lots in media.values() for lot_id in lots}
        self.assertTrue(media_ids <= public_ids)
        self.assertGreater(len(media_ids), 0)
        self.assertNotIn("media", site["cities"][0])

    def test_rejects_private_credentials_queries_and_non_snapshot_scope(self):
        bad_values = [
            {"photos": ["https://user:pass@example.test/a.jpg"], "scope": "source_snapshot"},
            {"photos": ["https://127.0.0.1/a.jpg"], "scope": "source_snapshot"},
            {"photos": ["https://example.test/a.jpg?sig=secret"], "scope": "source_snapshot"},
            {"photos": [], "scope": "current"},
        ]
        for bad in bad_values:
            with self.assertRaises(ValueError):
                self.media_file({"version": 1, "cities": {"rio-de-janeiro-rj": {"lot": bad}}})

    def test_merge_is_additive_and_does_not_change_public_row(self):
        city = {"slug": "rio-de-janeiro-rj", "rows": [["lot", "zuk", ""]], "lifecycle": {"lot": {"status": "active"}}}
        original = json.dumps(city, sort_keys=True)
        PROTO.merge_lot_media(city, {"rio-de-janeiro-rj": {"lot": {"photos": ["https://example.test/a.jpg"], "scope": "source_snapshot"}}})
        self.assertEqual(json.dumps({k: city[k] for k in ("slug", "rows", "lifecycle")}, sort_keys=True), original)
        self.assertEqual(city["media"]["lot"]["scope"], "source_snapshot")


if __name__ == "__main__":
    unittest.main()
