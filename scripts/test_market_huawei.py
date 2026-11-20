import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from market_hub import MarketError

import market_huawei as huawei


class HuaweiTests(unittest.TestCase):
    config = {'platform': 'harmony', 'app_id': '24680', 'client_id': 'fixture', 'client_secret': 'fixture-secret'}
    success = {'ret': {'code': 0}}

    def test_release_queries_confirm_package_before_reading_progress(self):
        for platform, apk_type, api_version in [('android', '1', 'v2'), ('harmony', '7', 'v3')]:
            with self.subTest(platform=platform), patch.object(huawei, 'request_json', side_effect=[
                {'access_token': 'mock'},
                {**self.success, 'appids': [{'value': '24680'}]},
                {**self.success, 'appInfo': {'releaseState': 3, 'onShelfVersionNumber': '1.0.8',
                    'onShelfVersionCode': 31081, 'versionNumber': '1.1.0', 'versionCode': 31101}},
            ]) as fetch:
                row, _ = huawei.read_release({**self.config, 'platform': platform})
                self.assertEqual((row['status'], row['live_version'], row['pending_version']), ('approved', '1.0.8', '1.1.0'))
                self.assertEqual(fetch.call_args_list[1].args[1], {'packageName': huawei.PACKAGE, 'packageTypes': apk_type})
                self.assertEqual(fetch.call_args.args[:2], (f'/api/publish/{api_version}/app-info', {'appId': '24680', 'releaseType': 1}))

    def test_authorization_is_bound_to_harmony(self):
        with self.assertRaises(MarketError):
            huawei.validate_credentials({**self.config, 'platform': 'android'})
        self.assertEqual(huawei.PACKAGE, 'com.jinriyixiu.isho')

    def test_wrong_app_mapping_is_not_writable(self):
        with patch.object(huawei, 'request_json', side_effect=[
            {'access_token': 'mock'}, {**self.success, 'appids': [{'value': '24681'}]},
        ]) as fetch:
            result = huawei.collect(self.config)
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(result['state'], 'app_not_found')
        self.assertEqual(result['rows']['channels'], [])

    def test_only_new_downloads_and_explicit_zero_are_imported(self):
        prior = datetime.now(timezone.utc).date() - timedelta(days=1)
        before = prior - timedelta(days=1)
        data = f'日期,总下载成功次数,新下载成功次数\n{before},91,—\n{prior},123,0\n'
        with patch.object(huawei, 'request_json', return_value={**self.success, 'fileURL':'https://example.invalid/mock'}), \
                patch.object(huawei, 'read_report_csv', return_value=data):
            rows, _, end = huawei.read_downloads(self.config, {})
        self.assertEqual(rows[0]['downloads'], '0')
        self.assertEqual(rows[0]['date'], end)
        self.assertEqual(len(rows), 1)

    def test_untrusted_download_url_never_opens(self):
        for url in ('https://huawei.com.attacker.invalid/a', 'http://huawei.com/a', 'https://someone@huawei.com/a'):
            with self.subTest(url=url), patch.object(huawei, 'build_opener') as opener:
                with self.assertRaises(huawei.HuaweiError):
                    huawei.read_report_csv(url)
                opener.assert_not_called()

    def test_failed_download_does_not_discard_versions_or_reviews(self):
        version = {'channel': 'huawei', 'status': 'live', 'live_version': '1.0.8'}
        with patch.object(huawei, 'read_release', return_value=(version, {})), \
                patch.object(huawei, 'read_downloads', side_effect=huawei.HuaweiError('access_denied')), \
                patch.object(huawei, 'read_reviews', return_value=[]):
            result = huawei.collect(self.config)
        self.assertEqual(result['rows']['channels'], [version])
        self.assertEqual(result['parts']['channels']['state'], 'ok')
        self.assertEqual(result['parts']['downloads']['state'], 'access_denied')
        self.assertEqual(result['parts']['reviews']['count'], 0)
