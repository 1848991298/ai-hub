from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import patch
import export_public_hub as public

class PublicExportTests(unittest.TestCase):
    def test_only_generic_configuration_is_exported(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'public';count=public.export(root)
            files=[p for p in root.rglob('*') if p.is_file()]
            self.assertEqual(count,len(files))
            self.assertEqual(list((root/'skills').iterdir()),[root/'skills/README.md'])
            self.assertFalse((root/'rules/clients').exists())
            self.assertFalse((root/'.local').exists())
            self.assertFalse(any(line.startswith('canonical\t') for line in (root/'manifest.tsv').read_text().splitlines()))
            self.assertEqual([p['id'] for p in json.loads((root/'ui/projects.json').read_text())],['hub'])
            self.assertTrue((root/'desktop/macos/main.swift').is_file())
            self.assertTrue((root/'scripts/tracker_hub.py').is_file())
            self.assertTrue((root/'standalone/operations/server.py').is_file())
            for name in public.SCREENSHOTS:
                self.assertEqual((root/name).read_bytes(), (public.ROOT/name).read_bytes())
    def test_private_resource_token_and_path_are_blocked(self):
        for text in ('gh'+'p_'+'x'*35,'https://'+'private-team'+'.feishu.cn/base/ExampleResource'):
            with self.assertRaises(ValueError):public.audit({'test.py':text.encode()})
        with self.assertRaises(ValueError):public.audit({'test.py':b'fixturePrivateMarker'},['fixturePrivateMarker'])
        with self.assertRaises(ValueError):public.audit({'.local/config.json':b'fixture'})
    def test_screenshot_whitelist_does_not_allow_other_binary_content(self):
        for name in public.SCREENSHOTS:
            with self.assertRaises(ValueError): public.audit({name:b'not an image'})
        with self.assertRaises(ValueError): public.audit({'.local/overview.png':b'fixture'})
        with self.assertRaises(UnicodeDecodeError): public.audit({'unexpected.bin':b'\xff\x00'})

    def test_existing_content_is_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'keep').write_text('keep')
            with self.assertRaises(ValueError):public.export(root)
            self.assertEqual((root/'keep').read_text(),'keep')

if __name__=='__main__':unittest.main()
