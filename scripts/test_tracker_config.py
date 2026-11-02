import json
from pathlib import Path
import tempfile
import unittest
from tracker_config import load_settings

class TrackerConfigTests(unittest.TestCase):
    def test_unconfigured_has_no_remote_resource(self):
        with tempfile.TemporaryDirectory() as temp:
            token,url,tables,error=load_settings(temp)
            self.assertEqual((token,url),('',''))
            self.assertTrue(error)
            self.assertTrue(all(not table['id'] for table in tables.values()))
            self.assertFalse((Path(temp)/'.local').exists())
    def test_valid_local_binding_and_invalid_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);path=root/'.local/tracker-config.json';path.parent.mkdir()
            value={'base_token':'ExampleBase','base_url':'https://example.feishu.cn/base/ExampleBase','tables':{kind:{'id':'tbl'+kind,'fields':{field:'fld'+kind+field for field in ('content','status','created','due','priority','note')}} for kind in ('issue','task')}}
            path.write_text(json.dumps(value))
            token,url,tables,error=load_settings(root)
            self.assertEqual(token,'ExampleBase');self.assertIsNone(error)
            self.assertEqual(tables['issue']['fields']['created'],'fldissuecreated')
            path.write_text('{bad')
            token,url,tables,error=load_settings(root)
            self.assertFalse(token);self.assertTrue(error)
    def test_credentials_and_duplicate_field_ids_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);path=root/'.local/tracker-config.json';path.parent.mkdir()
            value={'base_token':'ExampleBase','base_url':'https://user:password@example.feishu.cn/base/ExampleBase','tables':{}}
            path.write_text(json.dumps(value));self.assertFalse(load_settings(root)[0])

if __name__=='__main__':unittest.main()
