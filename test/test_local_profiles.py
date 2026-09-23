import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from proto_build import PILOT_LOCAL_PROFILE_ROUTES, load_local_profiles


class LocalProfilesTest(unittest.TestCase):
    cities = [
        {
            "slug": "rio-de-janeiro-rj",
            "shapes": {"nice": {"COPACABANA": "Copacabana"}},
            "streets": {
                "d": {"065334": {"name": "Rua Antonio Basilio", "slug": "rua-antonio-basilio"}}
            },
        }
    ]
    profile = {
        "scope": "area",
        "city": "rio-de-janeiro-rj",
        "route": "copacabana",
        "observed_at": "2026-09-20T10:00:00Z",
        "summary": {
            "pt": "Contexto revisado em português.",
            "en": "Reviewed context in English.",
            "ru": "Проверенный контекст на русском.",
        },
        "attribution": {
            "pt": "Compilado a partir das fontes citadas.",
            "en": "Compiled from the cited sources.",
            "ru": "Составлено по указанным источникам.",
        },
        "limitations": {
            "pt": "Não substitui uma visita ou diligência própria.",
            "en": "It does not replace a visit or independent diligence.",
            "ru": "Не заменяет личную проверку объекта.",
        },
        "citations": [
            {
                "label": {
                    "pt": "Fonte pública",
                    "en": "Public source",
                    "ru": "Открытый источник",
                },
                "url": "https://example.test/source",
                "observed_at": "2026-09-19T10:00:00Z",
                "evidence": {
                    "pt": "Evidência que sustenta o contexto.",
                    "en": "Evidence supporting the context.",
                    "ru": "Данные, подтверждающие контекст.",
                },
            }
        ],
    }

    def load(self, profiles):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "local-profiles.json"
            path.write_text(
                json.dumps(
                    {
                        "schema": "local-profiles-v1",
                        "license": {
                            "scope": "OpenStreetMap-derived POI counts and names in these profiles",
                            "attribution": "© OpenStreetMap contributors",
                            "license": "ODbL-1.0",
                            "url": "https://www.openstreetmap.org/copyright",
                        },
                        "profiles": profiles,
                    }
                )
            )
            return load_local_profiles(path, self.cities)

    def test_missing_file_and_empty_schema_fall_back_to_no_blocks(self):
        self.assertEqual(
            load_local_profiles(Path("/definitely-not-present/local-profiles.json"), self.cities),
            {"area": {}, "street": {}},
        )
        self.assertEqual(self.load([]), {"area": {}, "street": {}})

    def test_normalizes_route_keyed_area_and_street_profiles(self):
        street = copy.deepcopy(self.profile)
        street.update({"scope": "street", "route": "rua-antonio-basilio"})
        loaded = self.load([self.profile, street])
        self.assertEqual(
            loaded["area"]["rio-de-janeiro-rj"]["COPACABANA"]["summary"]["en"],
            "Reviewed context in English.",
        )
        self.assertEqual(
            loaded["street"]["rio-de-janeiro-rj"]["065334"]["citations"][0]["url"],
            "https://example.test/source",
        )

    def test_pilot_allowlist_is_exactly_twenty_public_routes(self):
        self.assertEqual(
            PILOT_LOCAL_PROFILE_ROUTES,
            {
                "area": {
                    "rio-de-janeiro-rj": {
                        "campo-grande",
                        "santa-cruz",
                        "barra-da-tijuca",
                        "copacabana",
                    },
                    "recife-pe": {"poco-da-panela", "boa-viagem"},
                    "sao-paulo-sp": {"jardim-paulista", "mooca"},
                    "fortaleza-ce": {"praia-de-iracema", "farias-brito"},
                },
                "street": {
                    "rio-de-janeiro-rj": {
                        "rua-antonio-basilio",
                        "avenida-rui-barbosa",
                        "praia-do-flamengo",
                        "rua-vilela-tavares",
                        "rua-dos-invalidos",
                        "estrada-do-campinho",
                        "rua-andre-cavalcanti",
                        "rua-prof-henrique-costa",
                        "estrada-dos-bandeirantes",
                        "avenida-nossa-senhora-de-copacabana",
                    },
                },
            },
        )
        self.assertEqual(
            sum(
                len(routes)
                for cities in PILOT_LOCAL_PROFILE_ROUTES.values()
                for routes in cities.values()
            ),
            20,
        )

    def test_rejects_unknown_routes_duplicate_profiles_and_unsafe_claims(self):
        cases = []
        bad_route = copy.deepcopy(self.profile)
        bad_route["route"] = "not-a-route"
        cases.append(bad_route)
        bad_url = copy.deepcopy(self.profile)
        bad_url["citations"][0]["url"] = "javascript:alert(1)"
        cases.append(bad_url)
        bad_time = copy.deepcopy(self.profile)
        bad_time["observed_at"] = "2026-09-20"
        cases.append(bad_time)
        future_citation = copy.deepcopy(self.profile)
        future_citation["citations"][0]["observed_at"] = "2026-09-21T10:00:00Z"
        cases.append(future_citation)
        missing_translation = copy.deepcopy(self.profile)
        del missing_translation["summary"]["ru"]
        cases.append(missing_translation)
        missing_limitations = copy.deepcopy(self.profile)
        del missing_limitations["limitations"]
        cases.append(missing_limitations)
        unsafe_text = copy.deepcopy(self.profile)
        unsafe_text["summary"]["pt"] = "<script>não</script>"
        cases.append(unsafe_text)
        for profile in cases:
            with self.subTest(profile=profile):
                with self.assertRaises(ValueError):
                    self.load([profile])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.load([self.profile, copy.deepcopy(self.profile)])


if __name__ == "__main__":
    unittest.main()
