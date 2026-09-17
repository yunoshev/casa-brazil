"""Offline contract for the derived GitHub Pages repository.

The workflow is copied into a separate public repository.  This test keeps the
two allowlists in lockstep: a green private build must not publish a workflow
that asks the public checkout for a file the publisher omitted.  It also makes
the production switches explicit and rejects secret references or a soft
canonical URL.
"""

from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_WORKFLOW = ROOT / "deploy" / "pages.yml"
DEPLOYED_WORKFLOW = ROOT / ".github" / "workflows" / "pages.yml"
PUBLISHER = ROOT / "publish_repo.py"
CANONICAL = "https://precodemartelo.com"

PUBLIC_VARS = (
    "MAPS_EMBED_API_KEY",
    "BRAZIL_PUBLIC_ANALYSIS_ENABLED",
    "LOT_REPORTS_ENABLED",
    "GA4_ID",
    "GA4_ENHANCED_MEASUREMENT_DISABLED",
    "CF_BEACON",
)

# The old public repository's checks are intentionally represented by current
# equivalents.  The mapping is itself tested below, so removing a regression
# requires changing this reviewed contract rather than silently dropping it.
LEGACY_EQUIVALENTS = {
    "sitemap freshness": ("test/test_sitemap_freshness.py",),
    "country order": ("test/country_city_order.mjs",),
    "lifecycle i18n": ("test/lifecycle_i18n.mjs",),
    "valuation UI": ("test/archive_app.mjs",),
    "public config": ("release_tests/test_public_config.py",),
    "asset versioning": ("test/test_asset_versioning.py",),
    "lot media": (
        "release_tests/test_lot_media_build.py",
        "site/test/gallery.test.mjs",
    ),
}

EQUIVALENT_MARKERS = {
    "test/test_sitemap_freshness.py": ("sitemap_documents",),
    "test/country_city_order.mjs": ("cityOrder",),
    "test/lifecycle_i18n.mjs": ("archive.status",),
    "test/archive_app.mjs": ("screenLot", "archive"),
    "release_tests/test_public_config.py": ("PublicConfigTest", "settings"),
    "test/test_asset_versioning.py": ("asset_paths",),
    "release_tests/test_lot_media_build.py": ("load_lot_media",),
    "site/test/gallery.test.mjs": ("gallery",),
}


def _workflow_path() -> Path:
    """Select the workflow this checkout would actually execute."""
    if DEPLOYED_WORKFLOW.is_file():
        return DEPLOYED_WORKFLOW
    if SOURCE_WORKFLOW.is_file():
        return SOURCE_WORKFLOW
    raise FileNotFoundError("missing Pages workflow in source and deployed locations")


WORKFLOW = _workflow_path()


def _publisher_literals() -> tuple[set[str], set[str]]:
    # The derived public repository intentionally omits its private publisher.
    # There, the staged filesystem is the exact publisher result to validate.
    if not PUBLISHER.is_file():
        files = {path.relative_to(ROOT).as_posix() for path in ROOT.rglob("*") if path.is_file()}
        return files, set()

    tree = ast.parse(PUBLISHER.read_text(encoding="utf-8"))
    values: dict[str, object] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in {"FILES", "RENAMED"}:
                    values[target.id] = ast.literal_eval(node.value)
    files = set(values["FILES"])  # type: ignore[arg-type]
    renamed = set(values["RENAMED"]) | set(values["RENAMED"].values())  # type: ignore[union-attr]
    return files, renamed


def _workflow_files(text: str) -> set[str]:
    """Extract explicit Python/Node file operands from shell run blocks."""
    found: set[str] = set()
    for match in re.finditer(
        r"\b(?:python(?:\s+-u)?|node(?:\s+--test)?)\s+([A-Za-z0-9_.][A-Za-z0-9_./-]*\.(?:py|mjs|js))\b",
        text,
    ):
        found.add(match.group(1))
    return found


def _literal_assignment(path: Path, name: str) -> tuple[str, ...]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == name:
                    value = ast.literal_eval(node.value)
                    return tuple(value)
    raise AssertionError(f"{path}: missing literal assignment {name}")


def _relative_module_dependencies(entries: set[str]) -> set[str]:
    """Trace static relative imports used by workflow-invoked JS tests."""
    pattern = re.compile(
        r"(?:\b(?:import|export)\b[^;]*?\bfrom\s*|\bimport\s*)"
        r'["\'](\.[^"\']+)["\']',
        re.DOTALL,
    )
    root = ROOT.resolve()
    pending = [ROOT / entry for entry in entries if Path(entry).suffix in {".js", ".mjs"}]
    dependencies: set[str] = set()
    seen: set[Path] = set()
    while pending:
        source = pending.pop().resolve()
        if source in seen or not source.is_file():
            continue
        seen.add(source)
        for specifier in pattern.findall(source.read_text(encoding="utf-8")):
            target = (source.parent / specifier).resolve()
            relative = target.relative_to(root).as_posix()
            if relative not in dependencies:
                dependencies.add(relative)
                pending.append(target)
    return dependencies


class PagesWorkflowContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")
        cls.files, cls.renamed = _publisher_literals()
        cls.public_files = cls.files | cls.renamed

    def test_validates_the_workflow_executed_by_this_checkout(self):
        expected = DEPLOYED_WORKFLOW if DEPLOYED_WORKFLOW.is_file() else SOURCE_WORKFLOW
        self.assertEqual(WORKFLOW, expected)
        self.assertTrue(WORKFLOW.is_file())

    def test_every_explicit_workflow_file_is_published_and_exists(self):
        refs = _workflow_files(self.workflow)
        self.assertTrue(refs)
        for path in sorted(refs):
            with self.subTest(path=path):
                self.assertIn(path, self.public_files)
                self.assertTrue((ROOT / path).is_file(), path)

    def test_discovered_python_release_tests_are_published(self):
        for path in sorted((ROOT / "release_tests").glob("*.py")):
            with self.subTest(path=path.name):
                self.assertIn(path.relative_to(ROOT).as_posix(), self.files)

    def test_prerender_runtime_assets_are_published(self):
        for asset in _literal_assignment(ROOT / "prerender.py", "ASSETS"):
            path = f"site/{asset}"
            with self.subTest(path=path):
                if path == "site/data/market_reports.json":
                    # This is lifecycle-bound output from proto_build.py, not
                    # an input that publish_repo.py may copy from the private
                    # tree.  The Pages workflow creates it before prerender.
                    self.assertIn("PUBLIC_MARKET_REPORTS", (ROOT / "proto_build.py").read_text())
                else:
                    self.assertIn(path, self.public_files)
                    self.assertTrue((ROOT / path).is_file(), path)

    def test_legacy_public_regressions_have_current_equivalents(self):
        for name, paths in LEGACY_EQUIVALENTS.items():
            with self.subTest(name=name):
                for path in paths:
                    self.assertIn(path, self.public_files)
                    self.assertTrue((ROOT / path).is_file(), path)
                    # unittest discovery calls the whole release_tests
                    # directory; frontend checks are called by filename.
                    if path.startswith("release_tests/"):
                        self.assertIn("-s release_tests", self.workflow)
                    else:
                        self.assertIn(Path(path).name, self.workflow)
                    body = (ROOT / path).read_text(encoding="utf-8")
                    for marker in EQUIVALENT_MARKERS[path]:
                        self.assertIn(marker, body, f"{name}: {path} lacks {marker}")

    def test_all_shipped_new_frontend_tests_are_called(self):
        required = {
            "site/test/analytics.test.mjs",
            "site/test/funnel.test.mjs",
            "site/test/lot-reports.test.mjs",
            "site/test/matricula-upload.test.mjs",
            "site/test/matricula-e2e.test.mjs",
            "site/test/geo.test.mjs",
            "site/test/gallery.test.mjs",
            "site/test/related-lots.test.mjs",
            "site/test/lot-map.test.mjs",
            "site/test/market.test.mjs",
            "test/seo_app.mjs",
            "test/archive_app.mjs",
        }
        self.assertTrue(required <= _workflow_files(self.workflow))

    def test_workflow_frontend_test_dependencies_are_published(self):
        for path in sorted(_relative_module_dependencies(_workflow_files(self.workflow))):
            with self.subTest(path=path):
                self.assertIn(path, self.public_files)
                self.assertTrue((ROOT / path).is_file(), path)

    def test_public_switches_are_in_build_and_prerender_env_without_fallbacks(self):
        for var in PUBLIC_VARS:
            assignment = f"{var}: ${{{{ vars.{var} }}}}"
            self.assertGreaterEqual(self.workflow.count(assignment), 2, var)
        for var in ("MAPS_EMBED_API_KEY", "BRAZIL_PUBLIC_ANALYSIS_ENABLED", "LOT_REPORTS_ENABLED"):
            self.assertNotRegex(self.workflow, rf"{var}: .*\|\|")
        self.assertNotIn("set -x", self.workflow)
        self.assertNotRegex(self.workflow, r"(?:echo|printf)[^\n]*\$\{?\w*(?:KEY|GA4|BEACON)")

    def test_release_is_exact_canonical_and_contains_no_secret_expression(self):
        self.assertIn("SITE_URL: ${{ vars.SITE_URL }}", self.workflow)
        self.assertIn("SITE: ${{ vars.SITE_URL }}", self.workflow)
        self.assertIn(CANONICAL, self.workflow)
        self.assertNotIn("secrets.", self.workflow)
        self.assertNotIn("yunoshev.github.io", self.workflow)

    def test_lifecycle_bound_market_file_is_not_copied_as_a_publisher_input(self):
        if PUBLISHER.is_file():
            self.assertNotIn("site/data/market_reports.json", self.files)


if __name__ == "__main__":
    unittest.main()
