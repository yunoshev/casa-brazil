import copy
import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from proto_build import DOCUMENT_REPORTS, load_document_reports


class DocumentReportsTest(unittest.TestCase):
    def setUp(self):
        self.data = json.loads(DOCUMENT_REPORTS.read_text())
        self.lot, self.report = next(iter(self.data['reports'].items()))
        self.source = {'cols': ['id', 'src', 'link'], 'cities': [
            {'rows': [[self.lot, 'caixa', self.report['source_url']]]}]}

    def load(self, data):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'reports.json'
            path.write_text(json.dumps(data))
            return load_document_reports(path, self.source)

    def test_exact_binding(self):
        self.assertEqual(self.load(self.data)[self.lot]['source_kind'], 'browser_screenshots')

    def test_missing_lot_omitted(self):
        self.source['cities'][0]['rows'] = []
        self.assertEqual(self.load(self.data), {})

    def test_wrong_source_rejected(self):
        self.source['cities'][0]['rows'][0][2] += '0'
        with self.assertRaisesRegex(ValueError, 'match catalog'):
            self.load(self.data)

    def test_unreviewed_pdf_claim_bad_page_or_private_field_rejected(self):
        for field, value in [('reviewed', False), ('original_pdf_available', True),
                             ('source_kind', 'pdf'), ('source_url', 'https://evil.example'),
                             ('page_count', True), ('summary', '<script>bad</script>'),
                             ('raw_ocr', 'not allowed')]:
            data = copy.deepcopy(self.data)
            data['reports'][self.lot][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.load(data)
        data = copy.deepcopy(self.data)
        data['reports'][self.lot]['findings'][0]['page'] = 5
        with self.assertRaisesRegex(ValueError, 'citation'):
            self.load(data)


if __name__ == '__main__':
    unittest.main()
