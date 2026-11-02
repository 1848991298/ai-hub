from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import export_market

class ExportTests(unittest.TestCase):
    def test_allowlist_export_excludes_all_personal_state_and_history(self):
        with tempfile.TemporaryDirectory() as temp:
            destination=Path(temp)/'source'
            count=export_market.export(destination)
            files=sorted(str(p.relative_to(destination)) for p in destination.rglob('*') if p.is_file())
            self.assertEqual(len(files),count)
            self.assertEqual(files,sorted(name for _,name in export_market.sources()))
            self.assertTrue((destination/'README.md').is_file())
            for name in files:
                self.assertFalse(any(p in ('.git','.local','node_modules','rules','skills') for p in Path(name).parts))
                self.assertFalse(name.endswith(('.sqlite','.enc','.env')))
            for path in destination.rglob('*'):
                if path.is_file():self.assertNotRegex(path.read_text(),r'/Users/[A-Za-z0-9_.-]+/')
    def test_existing_directory_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            destination=Path(temp);file=destination/'keep';file.write_text('keep')
            with self.assertRaises(ValueError):export_market.export(destination)
            self.assertEqual(file.read_text(),'keep')
    def test_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);real=root/'private';real.write_text('fixture');link=root/'link';link.symlink_to(real)
            with patch.object(export_market,'sources',return_value=[(link,'bad')]):
                with self.assertRaises(ValueError):export_market.export(root/'export')

if __name__=='__main__':unittest.main()
