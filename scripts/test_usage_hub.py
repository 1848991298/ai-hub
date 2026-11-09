#!/usr/bin/env python3
"""用量口径、隐私白名单、旧快照与采集并发回归；不读取真实账号。"""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta
import usage_hub as usage

STAMP = '2026-10-29T12:00:00+08:00'
WINDOW = {'since': '2026-09-30', 'until': '2026-10-29', 'days': 30}

def counters():
    return dict(inputTokens=10,cacheReadTokens=100,cacheCreationTokens=5,outputTokens=20,reasoningOutputTokens=8,totalTokens=135)

def cc_payload(fallback=False):
    return {'daily':[{'date':'2026-10-29',**counters(),'costUSD':2,'models':{'sample-model':{**counters(),'isFallback':fallback}}}]}

class NormalizerTests(unittest.TestCase):
    def test_cursor_missing_web_session_is_actionable_and_redacted(self):
        payload = {'provider': 'cursor', 'error': {'message': 'No Cursor session found. secret@example.test token=private'}}
        result = usage.normalize_quota(payload, 'cursor', STAMP)
        self.assertEqual(result['error_code'], 'cursor_session_missing')
        self.assertIn('浏览器登录 cursor.com', result['reason'])
        self.assertNotIn('secret', json.dumps(result))
        self.assertNotIn('private', json.dumps(result))
        history = usage.normalize_cursor_cost(payload, WINDOW, STAMP)
        self.assertEqual(history['error_code'], 'cursor_session_missing')

    def test_cache_and_reasoning_are_not_double_counted(self):
        row=usage.normalize_ccusage(cc_payload(),WINDOW,STAMP)['daily'][0]
        self.assertEqual((row['input_tokens'],row['output_tokens'],row['total_tokens'],row['cached_tokens']),(115,20,135,100))
        self.assertEqual(row['estimated_usd'],2)
        inclusive=usage.token_mix(dict(inputTokens=115,outputTokens=20,totalTokens=135,cacheReadTokens=100))
        self.assertEqual(inclusive['input_tokens'],115)

    def test_unknown_prices_and_missing_counts_are_not_zero(self):
        row=usage.normalize_ccusage(cc_payload(True),WINDOW,STAMP)['daily'][0]
        self.assertIsNone(row['estimated_usd'])
        self.assertEqual(row['total_tokens'],135)
        self.assertIsNone(usage.token_mix({})['total_tokens'])
        self.assertIsNone(usage.number(float('nan')))
        self.assertIsNone(usage.number(10**1000))
        self.assertIsNone(usage.tokens(True))
        zero=cc_payload(); zero['daily'][0]['costUSD']=0
        self.assertEqual(usage.normalize_ccusage(zero,WINDOW,STAMP)['daily'][0]['estimated_usd'],0)

    def test_fallback_reference_preserved_without_claiming_exact_price(self):
        row=usage.normalize_ccusage(cc_payload(True),WINDOW,STAMP)['daily'][0]
        self.assertEqual(row['reference_usd'],2)
        self.assertIsNone(row['estimated_usd'])
        self.assertFalse(row['pricing_complete'])
        self.assertTrue(row['models'][0]['fallback_pricing'])

    def test_duplicate_or_inconsistent_counts_stop_aggregation(self):
        payload=cc_payload(); payload['daily']*=2
        with self.assertRaises(ValueError): usage.normalize_ccusage(payload,WINDOW,STAMP)
        payload=cc_payload(); payload['daily'][0]['totalTokens']=150
        with self.assertRaises(ValueError): usage.normalize_ccusage(payload,WINDOW,STAMP)

    def test_cursor_period_charge_is_never_allocated_to_daily(self):
        payload=[{'provider':'cursor','currencyCode':'USD','meteredCostUSD':25,'historyDays':30,'accountEmail':'secret@example.test',
          'daily':[{'date':'2026-10-29',**counters(),'totalCost':2,'modelBreakdowns':[{'modelName':'sample-model','totalTokens':135,'cost':2}]}]}]
        result=usage.normalize_cursor_cost(payload,WINDOW,STAMP)
        self.assertEqual(result['metered_period'],{'days':30,'label':'来源返回区间','usd':25})
        self.assertIsNone(result['daily'][0]['metered_usd'])
        self.assertEqual(result['daily'][0]['models'][0]['total_tokens'],135)
        self.assertNotIn('secret',json.dumps(result))
        payload[0]['coverage']={'unpriced':1}
        self.assertIsNone(usage.normalize_cursor_cost(payload,WINDOW,STAMP)['daily'][0]['estimated_usd'])
        payload[0]['currencyCode']='EUR'
        self.assertIsNone(usage.normalize_cursor_cost(payload,WINDOW,STAMP)['metered_period']['usd'])

    def test_quota_uses_remaining_and_drops_identity(self):
        payload=[{'provider':'codex','source':'oauth','usage':{'updatedAt':STAMP,'identity':{'accountEmail':'secret@example.test'},'secondary':{'usedPercent':31,'windowMinutes':10080,'resetsAt':'2026-11-01T12:00:00+08:00'}}}]
        result=usage.normalize_quota(payload,'codex',STAMP)
        self.assertEqual(len(result['windows']),1)
        self.assertEqual(result['windows'][0]['remaining_percent'],69)
        self.assertNotIn('secret',json.dumps(result))
        payload[0]['usage']['secondary']['resetsAt']='2026-10-28T12:00:00+08:00'
        self.assertIsNone(usage.normalize_quota(payload,'codex',STAMP)['windows'][0]['remaining_percent'])
        self.assertEqual(usage.normalize_quota({'provider':'codex','usage':{}},'codex',STAMP)['state'],'unavailable')

    def test_day_window_is_shanghai_calendar_not_utc(self):
        self.assertEqual(usage.period(datetime(2026,10,29,0,1,tzinfo=usage.ZONE)),{'since':'1970-01-01','until':'2026-10-29','days':None,'mode':'all'})
        self.assertEqual(usage.iso_time('2026-10-28T16:01:00Z'),'2026-10-29T00:01:00+08:00')

    def test_all_history_keeps_old_rows_and_excludes_future_dates(self):
        payload=cc_payload(); payload['daily'][0]['date']='2025-12-02'
        payload['daily'].append({**payload['daily'][0],'date':'2026-10-30'})
        window=usage.period(datetime.fromisoformat(STAMP))
        result=usage.normalize_ccusage(payload,window,STAMP)
        self.assertEqual([r['date'] for r in result['daily']],['2025-12-02'])
        self.assertEqual(result['coverage_mode'],'all_available')

    def test_all_cursor_charge_uses_all_label_not_sentinel_day_count(self):
        result=usage.normalize_cursor_cost({'provider':'cursor','reportingPeriod':'all','historyDays':739920,'currencyCode':'USD','meteredCostUSD':125,'daily':[]},WINDOW,STAMP)
        self.assertEqual(result['metered_period'],{'days':None,'label':'全部可读历史','usd':125})
        self.assertEqual(result['coverage_mode'],'all_available')

class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='hub-usage-test-'); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)

    def test_read_has_no_side_effects_and_no_cli(self):
        runner=unittest.mock.Mock()
        service=usage.UsageService(self.root,runner)
        self.assertFalse(service.snapshot()['refreshing']); runner.assert_not_called()
        self.assertEqual(list(self.root.iterdir()),[])

    def test_single_flight_and_failed_read_preserves_marked_history(self):
        service=usage.UsageService(self.root)
        service.value['providers'][0]['history']=usage.normalize_ccusage(cc_payload(),WINDOW,STAMP)
        def failed(provider,window): return service.empty_provider(provider)
        with patch.object(service,'collect_provider',side_effect=failed), patch.object(usage,'period',return_value=WINDOW): service.collect()
        self.assertEqual(service.value['providers'][0]['history']['state'],'stale')
        self.assertEqual(service.value['providers'][0]['history']['daily'][0]['total_tokens'],135)
        self.assertEqual(service.cache.stat().st_mode & 0o777,0o600)
        with patch.object(usage.threading,'Thread') as thread:
            self.assertTrue(service.refresh()); self.assertFalse(service.refresh()); self.assertEqual(thread.call_count,1)

    def test_restarted_cache_does_not_claim_current_quota(self):
        service=usage.UsageService(self.root)
        service.value['window']=WINDOW
        service.value['providers'][0]['history']=usage.normalize_ccusage(cc_payload(),WINDOW,STAMP)
        service.value['providers'][0]['quota']={'state':'ready','windows':[]}
        service.cache.parent.mkdir(); service.cache.write_text(json.dumps(service.value))
        with patch.object(usage,'period',return_value=WINDOW): loaded=usage.UsageService(self.root)
        self.assertEqual(loaded.snapshot()['providers'][0]['history']['state'],'stale')
        self.assertEqual(loaded.snapshot()['providers'][0]['quota']['state'],'unavailable')

    def test_quota_snapshot_expiry_does_not_mutate_source(self):
        service=usage.UsageService(self.root)
        quota=usage.normalize_quota({'provider':'codex','usage':{'updatedAt':STAMP,'secondary':{'usedPercent':31}}},'codex',STAMP)
        service.value['providers'][0]['quota']=quota
        with patch.object(usage,'now',return_value=datetime.fromisoformat(STAMP)+timedelta(minutes=16)):
            current=service.snapshot()['providers'][0]['quota']
        self.assertEqual(current['state'],'stale'); self.assertIsNone(current['windows'][0]['remaining_percent'])
        self.assertEqual(quota['state'],'ready')

    def test_tools_are_fixed_and_failures_do_not_leak_stderr(self):
        def runner(args,timeout): raise usage.CollectorError('SECRET-TOKEN /private/path')
        service=usage.UsageService(self.root,runner)
        with patch.object(usage,'executable',return_value='/fixed/tool'):
            for provider in ('codex','cursor'):
                result=service.collect_provider(provider,WINDOW)
                self.assertNotIn('SECRET',json.dumps(result))
                self.assertEqual(result['history']['state'],'unavailable')

    def test_collectors_request_all_history_not_just_a_bigger_frontend_filter(self):
        calls=[]
        def runner(args,timeout):
            calls.append(args)
            if 'daily' in args: return cc_payload()
            provider=args[args.index('--provider')+1]
            if 'cost' in args: return {'provider':provider,'reportingPeriod':'all','currencyCode':'USD','daily':[]}
            return {'provider':provider,'usage':{}}
        service=usage.UsageService(self.root,runner)
        with patch.object(usage,'executable',return_value='/fixed/tool'):
            for provider in ('codex','cursor'): service.collect_provider(provider,usage.period())
        daily=next(args for args in calls if 'daily' in args)
        self.assertNotIn('--since',daily); self.assertNotIn('--until',daily)
        cost=next(args for args in calls if 'cost' in args)
        self.assertEqual(cost[cost.index('--period')+1],'all'); self.assertNotIn('--days',cost)

    def test_legacy_cache_kept_but_not_claimed_to_be_full_history(self):
        service=usage.UsageService(self.root)
        service.value.update(schema_version=1,window=WINDOW)
        service.value['providers'][0]['history']=usage.normalize_ccusage(cc_payload(),WINDOW,STAMP)
        service.cache.parent.mkdir(); service.cache.write_text(json.dumps(service.value))
        loaded=usage.UsageService(self.root).snapshot()
        self.assertEqual(loaded['schema_version'],2)
        self.assertEqual(loaded['providers'][0]['history']['coverage_mode'],'legacy_30')
        self.assertEqual(loaded['providers'][0]['history']['state'],'stale')
        self.assertEqual(len(loaded['providers'][0]['history']['daily']),1)

if __name__=='__main__': unittest.main(verbosity=2)
