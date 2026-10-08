import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from proto_build import load_district_notes


class DistrictNotesTest(unittest.TestCase):
    cities = [
        {
            "slug": "rio-de-janeiro-rj",
            "shapes": {"nice": {"COPACABANA": "Copacabana", "LEME": "Leme"}},
        }
    ]
    # A note is only accepted where a documented local profile exists.
    local_profiles = {"area": {"rio-de-janeiro-rj": {"COPACABANA": {}}}, "street": {}}
    note = {
        "city": "rio-de-janeiro-rj",
        "route": "copacabana",
        "observed_at": "2026-10-08T10:00:00Z",
        "body": {
            "pt": ["Primeiro parágrafo.", "Segundo parágrafo."],
            "en": ["First paragraph.", "Second paragraph."],
            "ru": ["Первый абзац.", "Второй абзац."],
        },
        "pros": {"pt": ["Praia perto."], "en": ["Beach nearby."], "ru": ["Пляж рядом."]},
        "cons": {
            "pt": ["Condomínio caro."],
            "en": ["Costly condo fees."],
            "ru": ["Дорогой кондоминиум."],
        },
        "teaser": {
            "pt": "Orla densa com prédios antigos.",
            "en": "Dense seafront of older buildings.",
            "ru": "Плотная набережная со старыми домами.",
        },
        "sources": [
            {
                "label": {"pt": "Fonte pública", "en": "Public source", "ru": "Открытый источник"},
                "url": "https://example.test/source",
                "observed_at": "2026-10-07T10:00:00Z",
            }
        ],
    }

    def load(self, notes, profiles=None):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "district-notes.json"
            path.write_text(json.dumps({"schema": "district-notes-v1", "notes": notes}))
            return load_district_notes(
                path, self.cities, self.local_profiles if profiles is None else profiles
            )

    def test_missing_file_and_empty_list_mean_no_notes(self):
        self.assertEqual(
            load_district_notes(
                Path("/definitely-not-present/district-notes.json"),
                self.cities,
                self.local_profiles,
            ),
            {},
        )
        self.assertEqual(self.load([]), {})

    def test_note_is_keyed_by_city_and_district_data_key(self):
        loaded = self.load([self.note])
        note = loaded["rio-de-janeiro-rj"]["COPACABANA"]
        self.assertEqual(note["teaser"]["en"], "Dense seafront of older buildings.")
        self.assertEqual(note["body"]["ru"], ["Первый абзац.", "Второй абзац."])
        self.assertEqual(note["sources"][0]["url"], "https://example.test/source")
        self.assertEqual(set(note), {"observed_at", "body", "pros", "cons", "teaser", "sources"})

    def test_rejects_notes_without_profile_route_or_safe_text(self):
        cases = []
        no_profile = copy.deepcopy(self.note)
        no_profile["route"] = "leme"  # published route, but no documented profile
        cases.append(no_profile)
        bad_route = copy.deepcopy(self.note)
        bad_route["route"] = "not-a-route"
        cases.append(bad_route)
        bad_url = copy.deepcopy(self.note)
        bad_url["sources"][0]["url"] = "javascript:alert(1)"
        cases.append(bad_url)
        future_source = copy.deepcopy(self.note)
        future_source["sources"][0]["observed_at"] = "2026-10-09T10:00:00Z"
        cases.append(future_source)
        missing_language = copy.deepcopy(self.note)
        del missing_language["body"]["ru"]
        cases.append(missing_language)
        one_paragraph = copy.deepcopy(self.note)
        one_paragraph["body"]["pt"] = ["Só um."]
        cases.append(one_paragraph)
        empty_pros = copy.deepcopy(self.note)
        empty_pros["pros"]["en"] = []
        cases.append(empty_pros)
        unsafe = copy.deepcopy(self.note)
        unsafe["teaser"]["pt"] = "<script>não</script>"
        cases.append(unsafe)
        extra_field = copy.deepcopy(self.note)
        extra_field["html"] = "<b>no</b>"
        cases.append(extra_field)
        for note in cases:
            with self.subTest(note=note):
                with self.assertRaises(ValueError):
                    self.load([note])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.load([self.note, copy.deepcopy(self.note)])
        with self.assertRaisesRegex(ValueError, "documented local profile"):
            self.load([self.note], profiles={"area": {}, "street": {}})


if __name__ == "__main__":
    unittest.main()
