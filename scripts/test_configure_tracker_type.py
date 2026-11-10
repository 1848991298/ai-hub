"""类型字段配置只改结构与本机绑定，不写历史记录。"""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from configure_tracker_type import configure
from tracker_hub import TrackerError


class Client:
    def __init__(self, field=None):
        self.fields = {'fldContent': {'id':'fldContent','name':'内容','type':'text'}}
        if field: self.fields[field['id']] = field
        self.rows = [{'id':'recExisting','cells':{'fldContent':'已有任务'}}]
        self.writes = []

    def invoke(self, args):
        command = args[1]
        if command == '+field-list': return {'data':{'fields':list(copy.deepcopy(self.fields).values())}}
        if command == '+field-get': return {'data':{'field':copy.deepcopy(self.fields[args[args.index('--field-id')+1]])}}
        if command == '+record-list':
            ids=list(self.fields)
            return {'data':{'field_id_list':ids,'record_id_list':[r['id'] for r in self.rows], 'data':[[r['cells'].get(key) for key in ids] for r in self.rows], 'has_more':False}}
        self.writes.append(command)
        if command == '+field-create':
            body=json.loads(args[args.index('--json')+1]);body['id']='fldCategory';self.fields['fldCategory']=body;return {'data':{'field':copy.deepcopy(body)}}
        if command == '+field-update':
            key=args[args.index('--field-id')+1];self.fields[key]={**json.loads(args[args.index('--json')+1]),'id':key};return {'data':{}}
        raise AssertionError('不应写入历史记录')


class TypeConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.path=self.root/'.local/tracker-config.json';self.path.parent.mkdir()
        self.value={'base_token':'ExampleBase','base_url':'https://example.feishu.cn/base/ExampleBase','tables':{kind:{'id':'tbl'+kind,'fields':{name:'fld'+kind+name for name in ('content','status','created','due','priority','note','tags')}} for kind in ('issue','task')}}
        self.path.write_text(json.dumps(self.value))

    def test_check_does_not_create_field_or_config(self):
        client=Client();before=self.path.read_text();result=configure(self.root,client=client)
        self.assertFalse(result['applied']);self.assertTrue(result['needs_field']);self.assertFalse(client.writes);self.assertEqual(before,self.path.read_text())

    def test_apply_preserves_records_and_does_not_default_history(self):
        client=Client();before=copy.deepcopy(client.rows);result=configure(self.root,True,client)
        self.assertTrue(result['applied']);self.assertEqual(result['historical_records_updated'],0);self.assertEqual(client.rows,before)
        config=json.loads(self.path.read_text());self.assertEqual(config['tables']['task']['fields']['category'],'fldCategory');self.assertNotIn('category',config['tables']['issue']['fields']);self.assertNotIn('default_value',client.fields['fldCategory'])
        configure(self.root,True,client);self.assertEqual(client.writes,['+field-create'])
        self.assertTrue((Path(result['backup'])/'tracker-config.json').exists())

    def test_wrong_existing_schema_stops_before_write(self):
        client=Client({'id':'fldCategory','name':'类型','type':'select','multiple':False,'options':[{'name':'修复'}]})
        with self.assertRaises(TrackerError):configure(self.root,True,client)
        self.assertFalse(client.writes);self.assertNotIn('category',json.loads(self.path.read_text())['tables']['task']['fields'])

    def test_existing_option_extension_preserves_description_and_default(self):
        client=Client({'id':'fldCategory','name':'类型','type':'select','multiple':False,'description':'已有说明','default_value':['需求'],'options':[{'name':'需求','hue':'Blue'}]})
        configure(self.root,True,client)
        self.assertEqual(client.fields['fldCategory']['description'],'已有说明');self.assertEqual(client.fields['fldCategory']['default_value'],['需求']);self.assertEqual(client.fields['fldCategory']['options'][0]['hue'],'Blue')
        self.assertEqual(client.writes,['+field-update'])


if __name__=='__main__': unittest.main()
