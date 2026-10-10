"""The auction-discount study loader: shipped aggregates or a failed build, never a wrong number."""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from proto_build import AUCTION_STUDY, load_auction_study

CITIES = [{"slug": "sao-paulo-sp"}, {"slug": "rio-de-janeiro-rj"}]


def summary(n=100, median=26.4, p25=10.2, p75=37.6, above=15.5, over=20.5):
    return {"n": n, "median": median, "p25": p25, "p75": p75, "at_or_above": above, "over_40": over}


STUDY = {
    "schema": "auction-study-v1",
    "city": "sao-paulo-sp",
    "measured_at": "2026-10-10T16:38:19Z",
    "data_until": "2026-06-26",
    "source_url": "https://www.prefeitura.sp.gov.br/itbi",
    "min_comps": 5,
    "auction_deeds": 28275,
    "building": summary(5169),
    "block": summary(12344, 29.2, 11.6, 42.8),
    "years": [{"year": 2020 + i, **summary(50)} for i in range(7)],
    "periods": [
        {"from": 2006, "to": 2012, **summary(1980, 22.2, 4.7, 36.7, 19.9)},
        {"from": 2013, "to": 2019, **summary(1388, 27.5, 7.8, 38.7, 18.9)},
        {"from": 2020, "to": 2026, **summary(1801, 28.9, 18.3, 37.7, 8.1)},
    ],
    "price_thirds": [summary(1727, 22.9, 4.2, 35.4), summary(1733), summary(1709)],
}


class AuctionStudyTest(unittest.TestCase):
    def load(self, study):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "auction-study.json"
            path.write_text(json.dumps(study))
            return load_auction_study(path, CITIES)

    def test_a_valid_study_loads_whole(self):
        loaded = self.load(STUDY)
        self.assertEqual(loaded["building"]["median"], 26.4)
        self.assertEqual([y["year"] for y in loaded["years"]], list(range(2020, 2027)))
        self.assertEqual(loaded["periods"][2]["at_or_above"], 8.1)

    def test_the_absent_file_publishes_no_study(self):
        self.assertIsNone(load_auction_study(Path("/nonexistent/auction-study.json"), CITIES))

    def test_an_unpublished_city_drops_the_page_but_not_the_build(self):
        moved = copy.deepcopy(STUDY)
        moved["city"] = "fortaleza-ce"
        self.assertIsNone(self.load(moved))

    def test_out_of_shape_numbers_fail_the_build(self):
        broken = []
        bad = copy.deepcopy(STUDY)
        bad["building"]["p25"] = 30.0  # quartile above the median
        broken.append(bad)
        bad = copy.deepcopy(STUDY)
        bad["building"]["at_or_above"] = 140.0
        broken.append(bad)
        bad = copy.deepcopy(STUDY)
        bad["years"][3]["year"] = 2020  # repeated year
        broken.append(bad)
        bad = copy.deepcopy(STUDY)
        bad["auction_deeds"] = 100  # fewer deeds than measured
        broken.append(bad)
        bad = copy.deepcopy(STUDY)
        bad["source_url"] = "https://example.test/itbi"
        broken.append(bad)
        bad = copy.deepcopy(STUDY)
        bad["extra"] = 1
        broken.append(bad)
        for study in broken:
            with self.subTest(study=study), self.assertRaises(ValueError):
                self.load(study)

    def test_the_shipped_study_is_valid(self):
        loaded = load_auction_study(AUCTION_STUDY, [{"slug": "sao-paulo-sp"}])
        self.assertIsNotNone(loaded)
        self.assertGreaterEqual(loaded["auction_deeds"], loaded["building"]["n"])


if __name__ == "__main__":
    unittest.main()
