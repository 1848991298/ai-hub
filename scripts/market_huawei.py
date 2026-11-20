"""Read ISHO release data from the official AppGallery Connect China API."""

import base64
import csv
from datetime import date, datetime, timedelta, timezone
from io import StringIO
import json
import re
import subprocess
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from market_hub import MarketError, ZONE, clean, stamp

PACKAGE = 'com.jinriyixiu.isho'
ORIGIN = 'https://connect-api.cloud.huawei.com'
ACCOUNT = 'ai-hub-market'
SERVICE = 'com.leo.aihub.market.huawei.v1'
STATES = {
    '0': 'live', '1': 'rejected', '2': 'offline', '3': 'approved',
    '4': 'reviewing', '5': 'reviewing', '6': 'taking_down', '7': 'not_submitted',
    '8': 'rejected', '9': 'takedown_rejected',
    '10': 'offline', '11': 'withdrawn', '12': 'reviewing', '13': 'rejected',
}


class HuaweiError(Exception):
    def __init__(self, state, code=''):
        super().__init__(state)
        self.state = state
        self.code = code


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def validate_credentials(value):
    if not isinstance(value, dict) or set(value) != {'platform', 'app_id', 'client_id', 'client_secret'}:
        raise MarketError('请填写华为应用类型、App ID、客户端 ID 和密钥。')
    if value['platform'] != 'harmony':
        raise MarketError('当前华为渠道绑定 ISHO 的 HarmonyOS 应用。')
    for name, limit in (('app_id', 32), ('client_id', 256), ('client_secret', 2048)):
        v = value[name]
        if not isinstance(v, str) or not v or len(v) > limit or not re.fullmatch(r'[!-~]+', v):
            raise MarketError('请核对 App ID、客户端 ID 和密钥格式。')
    if not re.fullmatch(r'[0-9]{1,32}', value['app_id']):
        raise MarketError('华为 App ID 应为数字。')
    return value


def read_credentials():
    try:
        result = subprocess.run(
            ['/usr/bin/security', 'find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w'],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 44 or 'could not be found' in result.stderr.lower():
            raise HuaweiError('needs_configuration')
        if result.returncode:
            raise HuaweiError('auth_key_unavailable')
        return validate_credentials(json.loads(base64.b64decode(result.stdout.strip(), validate=True)))
    except (OSError, ValueError, MarketError, subprocess.TimeoutExpired) as error:
        raise HuaweiError('auth_key_unavailable') from error


def save_credentials(value):
    encoded = base64.b64encode(json.dumps(value).encode()).decode()
    command = f'add-generic-password -U -a {ACCOUNT} -s {SERVICE} -w {encoded}\nquit\n'
    try:
        result = subprocess.run(
            ['/usr/bin/security', '-i'], input=command, capture_output=True, text=True, timeout=10,
        )
        if result.returncode or read_credentials() != value:
            raise HuaweiError('auth_key_unavailable')
    except (OSError, subprocess.TimeoutExpired) as error:
        raise HuaweiError('auth_key_unavailable') from error


def request_json(path, params=None, headers=None, body=None):
    url = ORIGIN + path + ('?' + urlencode(params) if params else '')
    request = Request(url, headers={'Accept': 'application/json', 'Content-Type': 'application/json', **(headers or {})},
                      data=json.dumps(body).encode() if body else None)
    try:
        with build_opener(NoRedirect).open(request, timeout=12) as response:
            value = json.loads(response.read(2_000_001))
            if not isinstance(value, dict):
                raise HuaweiError('read_failed', 'response_schema')
            return value
    except HTTPError as error:
        state = {401: 'needs_login', 403: 'access_denied'}.get(error.code, 'read_failed')
        raise HuaweiError(state, 'http_failed') from error
    except (URLError, TimeoutError, ValueError) as error:
        raise HuaweiError('read_failed', 'response_failed') from error


def check_result(value, status_field='code'):
    result = value.get('ret')
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            result = None
    if not isinstance(result, dict) or str(result.get(status_field)) != '0':
        raise HuaweiError('read_failed', 'api_rejected')


def read_release(settings):
    access = request_json('/api/oauth2/v1/token', body={
        'grant_type': 'client_credentials',
        'client_id': settings['client_id'],
        'client_secret': settings['client_secret'],
    })
    token = access.get('access_token')
    if not isinstance(token, str) or not re.fullmatch(r'[!-~]{1,8192}', token):
        raise HuaweiError('needs_login', 'authorization_failed')
    headers = {'client_id': settings['client_id'], 'Authorization': 'Bearer ' + token}
    harmony = settings['platform'] == 'harmony'
    mapping = request_json('/api/publish/v2/appid-list', {
        'packageName': PACKAGE, 'packageTypes': '7' if harmony else '1',
    }, headers)
    check_result(mapping)
    # This endpoint is already restricted to a single package and package type.
    applications = mapping.get('appids')
    if not isinstance(applications, list) or not any(
        isinstance(app, dict) and str(app.get('value')) == settings['app_id'] for app in applications
    ):
        raise HuaweiError('app_not_found', 'app_binding')
    release = request_json(f'/api/publish/v{"3" if harmony else "2"}/app-info', {
        'appId': settings['app_id'], 'releaseType': 1,
    }, headers)
    check_result(release)
    info = release.get('appInfo')
    if not isinstance(info, dict):
        raise HuaweiError('read_failed', 'response_schema')
    state = STATES.get(str(info.get('releaseState')))
    if not state:
        raise HuaweiError('read_failed', 'unknown_status')
    row = {'channel': 'huawei', 'status': state, 'as_of': stamp()[:10], 'reason': ''}
    current = info.get('versionNumber') or ''
    live = info.get('onShelfVersionNumber') or ''
    if state == 'live' and not live:
        live = current
    live_code = info.get('onShelfVersionCode')
    if state == 'live' and live == current and live_code is None:
        live_code = info.get('versionCode')
    if state == 'live' and not live:
        raise HuaweiError('read_failed', 'version_schema')
    if live or state in ('offline', 'live'):
        row.update(live_version=live if state != 'offline' else '',
                   live_code=live_code if state != 'offline' else None)
    if state in ('reviewing', 'approved', 'rejected'):
        row.update(pending_version=current, pending_code=info.get('versionCode'))
    else:
        row.update(pending_version='', pending_code=None)
    audit = release.get('auditInfo')
    if state == 'rejected' and isinstance(audit, dict) and isinstance(audit.get('auditOpinion'), str):
        row['reason'] = audit['auditOpinion'].replace('\0', '').strip()[:5000]
    try:
        clean('channels', row)
    except MarketError as error:
        raise HuaweiError('read_failed', 'version_schema') from error
    return row, headers



def read_report_csv(url):
    if not isinstance(url, str):
        raise HuaweiError('read_failed', 'report_url')
    location = urlsplit(url)
    host = location.hostname or ''
    suffixes = ('huawei.com', 'dbankcloud.com', 'dbankcloud.cn', 'dbankcdn.com', 'dbankcdn.cn')
    if (location.scheme != 'https' or location.username or location.password or location.port not in (None, 443)
            or not any(host == suffix or host.endswith('.' + suffix) for suffix in suffixes)):
        raise HuaweiError('read_failed', 'report_url')
    # The signed download link authorizes the file. Never forward the API token.
    with build_opener(NoRedirect).open(Request(url), timeout=12) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise HuaweiError('read_failed', 'report_size')
    return raw.decode('utf-8-sig')


def read_downloads(settings, headers):
    harmony = settings['platform'] == 'harmony'
    end = datetime.now(timezone.utc).date() - timedelta(days=1)
    start = end - timedelta(days=29)
    path = '/api/report/harmony-report/v1/harmony/appDownloadAnalysisExport/' if harmony else (
        '/api/report/distribution-operation-quality/v1/appDownloadExport/')
    params = {'startTime': start.strftime('%Y%m%d'), 'endTime': end.strftime('%Y%m%d'),
              'language': 'zh-CN', 'groupBy': 'date', 'exportType': 'CSV'}
    if not harmony:
        params.update(filterCondition='businessType', filterConditionValue='AppGallery')
    report = request_json(path + settings['app_id'], params, headers)
    check_result(report)
    table = csv.DictReader(StringIO(read_report_csv(report.get('fileURL'))))
    column = '新下载成功次数' if harmony else '新下载成功'
    if not table.fieldnames or any(table.fieldnames.count(name) != 1 for name in ('日期', column)):
        raise HuaweiError('read_failed', 'report_schema')
    source = '华为 AppGallery · ' + ('HarmonyOS 新下载成功次数（UTC，含卸载后重下）' if harmony else 'Android 新下载成功（UTC）')
    rows = []
    seen = set()
    for value in table:
        day = value['日期']
        if re.fullmatch(r'[0-9]{8}', day):
            day = f'{day[:4]}-{day[4:6]}-{day[6:]}'
        when = date.fromisoformat(day)
        if when.isoformat() != day or not start <= when <= end or day in seen:
            raise HuaweiError('read_failed', 'report_schema')
        seen.add(day)
        count = value[column]
        if count in ('', '-', '—'):
            continue
        if not isinstance(count, str) or not re.fullmatch(r'(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)', count):
            raise HuaweiError('read_failed', 'report_schema')
        row = {'channel': 'huawei', 'date': day, 'downloads': count.replace(',', ''), 'source': source}
        clean('metrics', row)
        rows.append(row)
    return rows, start.isoformat(), end.isoformat()

def read_reviews(settings, headers):
    now = datetime.now(ZONE)
    start = now - timedelta(days=30)
    rows = []
    expected = None
    for page in range(1, 11):
        value = request_json('/api/reviews/v1/manage/dev/reviews', {
            'appId': settings['app_id'], 'beginTime': int(start.timestamp() * 1000),
            'endTime': int(now.timestamp() * 1000), 'countries': 'CN', 'page': page, 'limit': 20,
        }, headers)
        check_result(value, 'rtnCode')
        data = value.get('data')
        if not isinstance(data, dict) or not isinstance(data.get('reviewList'), list):
            raise HuaweiError('read_failed', 'review_schema')
        total = data.get('total')
        if type(total) is not int or total < 0 or (expected is not None and expected != total):
            raise HuaweiError('read_failed', 'review_pagination')
        expected = total
        for review in data['reviewList']:
            date = datetime.fromtimestamp(review['dateline'] / 1000, ZONE)
            if not start <= date <= now or review.get('countryCode') != 'CN':
                raise HuaweiError('read_failed', 'review_schema')
            row = {'channel': 'huawei', 'external_id': review['reviewId'], 'date': date.date().isoformat(),
                   'rating': review['rating'], 'version': review.get('apkVersion') or '',
                   'body': (review.get('content') or '')[:5000], 'source': '华为 AppGallery · 中国区评论'}
            clean('reviews', row)
            rows.append(row)
        if data.get('hasNext') in (0, '0'):
            if len(rows) != expected or len({r['external_id'] for r in rows}) != expected:
                raise HuaweiError('read_failed', 'review_pagination')
            return rows
    raise HuaweiError('read_failed', 'review_pagination')


def collect(settings=None):
    rows = {'channels': [], 'metrics': [], 'reviews': []}
    parts = {}
    try:
        settings = read_credentials() if settings is None else settings
        release, headers = read_release(settings)
        rows['channels'] = [release]
        parts['channels'] = {'state': 'ok'}
    except HuaweiError as error:
        parts['channels'] = {'state': error.state, 'code': error.code}
        return {'provider': 'huawei', 'package': PACKAGE, 'state': error.state, 'rows': rows, 'parts': parts}
    try:
        rows['metrics'], start, end = read_downloads(settings, headers)
        parts['downloads'] = {'state': 'ok', 'count': len(rows['metrics']), 'from': start, 'to': end}
    except HuaweiError as error:
        parts['downloads'] = {'state': error.state, 'code': error.code}
    except (OSError, TypeError, ValueError, MarketError, csv.Error):
        parts['downloads'] = {'state': 'read_failed', 'code': 'report_failed'}
    try:
        rows['reviews'] = read_reviews(settings, headers)
        parts['reviews'] = {'state': 'ok', 'count': len(rows['reviews'])}
    except HuaweiError as error:
        parts['reviews'] = {'state': error.state, 'code': error.code}
    except (KeyError, TypeError, ValueError, OverflowError, OSError, MarketError):
        parts['reviews'] = {'state': 'read_failed', 'code': 'review_schema'}
    return {'provider': 'huawei', 'package': PACKAGE, 'state': 'partial', 'rows': rows, 'parts': parts}
