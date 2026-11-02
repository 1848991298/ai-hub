#!/usr/bin/env python3
"""固定用量采集器：仅保留统计白名单，不向前端或缓存转发账号、凭据、会话正文。"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from datetime import datetime, date
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('Asia/Shanghai')
INTERVAL = 300


def now():
    return datetime.now(ZONE)


def iso_time(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.astimezone(ZONE).isoformat() if parsed.tzinfo else None
    except ValueError:
        return None


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value > 1e18 or not math.isfinite(value) or value < 0:
        return None
    return value


def tokens(value):
    value = number(value)
    return int(value) if value is not None and value == int(value) and value <= 9e15 else None


def period(clock=None):
    end = (clock or now()).date()
    return {'since': '1970-01-01', 'until': end.isoformat(), 'days': None, 'mode': 'all'}


def unavailable(source, reason, state='unavailable', scope=''):
    return {'state': state, 'source': source, 'scope': scope, 'updated_at': None, 'reason': reason, 'daily': [], 'windows': []}


def provider_record(payload, provider):
    rows = payload if isinstance(payload, list) else [payload]
    matches = [row for row in rows if isinstance(row, dict) and row.get('provider') == provider]
    if len(matches) != 1:
        raise ValueError('统计来源不唯一或格式不兼容')
    return matches[0]


def token_mix(row, convention='auto'):
    raw_input = tokens(row.get('inputTokens'))
    output = tokens(row.get('outputTokens'))
    cached = tokens(row.get('cacheReadTokens', row.get('cachedInputTokens', 0)))
    creation = tokens(row.get('cacheCreationTokens', 0))
    total = tokens(row.get('totalTokens'))
    if None in (raw_input, output, cached, creation, total):
        return {'total_tokens': total, 'input_tokens': None, 'output_tokens': output, 'cached_tokens': None}
    # ccusage 20.x 的 inputTokens 为非缓存输入；缓存和 reasoning 均不能再加进已有总数。
    if convention == 'exclusive' or total == raw_input + cached + creation + output:
        input_total = raw_input + cached + creation
    elif total == raw_input + output:
        input_total = raw_input
    else:
        return {'total_tokens': total, 'input_tokens': None, 'output_tokens': output, 'cached_tokens': None}
    if input_total + output != total or cached > input_total:
        raise ValueError('token 分类与总数不一致')
    return {'total_tokens': total, 'input_tokens': input_total, 'output_tokens': output, 'cached_tokens': cached}


def normalize_ccusage(payload, window, timestamp):
    rows = payload.get('daily') if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError('ccusage daily 格式不兼容')
    daily = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('日期记录格式不兼容')
        key = row.get('date')
        if not isinstance(key, str):
            raise ValueError('缺少日期')
        date.fromisoformat(key)
        if not window['since'] <= key <= window['until']:
            continue
        if key in seen:
            raise ValueError('重复日期，停止汇总避免重复计费')
        seen.add(key)
        raw_models = row.get('models', {})
        models = []
        if isinstance(raw_models, dict):
            for name, value in raw_models.items():
                if isinstance(name, str) and isinstance(value, dict):
                    models.append({'name': name[:160], **token_mix(value, 'exclusive'), 'fallback_pricing': value.get('isFallback') is not False})
        priced = bool(models) and all(not model['fallback_pricing'] for model in models)
        daily.append({'date': key, **token_mix(row, 'exclusive'), 'estimated_usd': number(row.get('costUSD')) if priced else None,
                      'metered_usd': None, 'pricing_complete': priced, 'models': models})
    return {'state': 'ready', 'source': 'ccusage 20.0.45 · 本地日志', 'scope': '本机保留的 Codex 记录，不含未落盘的云端或其他设备任务',
            'updated_at': timestamp, 'reason': None, 'daily': sorted(daily, key=lambda r: r['date']),
            'coverage_mode': 'all_available',
            'note': '读取本机仍保留的全部日记录；API 等价费用估算，未知或回退定价不计入，reasoning 已含在输出中。'}


def normalize_cursor_cost(payload, window, timestamp):
    row = provider_record(payload, 'cursor')
    if cursor_session_missing(row):
        return cursor_login_required('CodexBar · Cursor 用量接口', '当前账号云端事件，可跨设备')
    if row.get('error'):
        return unavailable('CodexBar · Cursor 用量接口', 'Cursor 日统计暂不可用，请检查采集器中的登录与费用访问设置。', scope='当前账号云端事件，可跨设备')
    rows = row.get('daily')
    if not isinstance(rows, list):
        raise ValueError('Cursor 日统计格式不兼容')
    daily = []; seen = set()
    for value in rows:
        if not isinstance(value, dict):
            raise ValueError('Cursor 日期记录格式不兼容')
        key = value.get('date'); date.fromisoformat(key)
        if not window['since'] <= key <= window['until']:
            continue
        if key in seen:
            raise ValueError('重复日期')
        seen.add(key)
        # 只接受明确标记的扣费字段；API 单价总额不冒充订阅实际扣费。
        partial = row.get('currencyCode') != 'USD' or value.get('unpricedRequestCount', 0) != 0 or (value.get('coverage') or {}).get('unpriced', 0) != 0 or (row.get('coverage') or {}).get('unpriced', 0) != 0
        models = [{'name': str(model['modelName'])[:160], **token_mix(model), 'fallback_pricing': number(model.get('cost')) is None} for model in value.get('modelBreakdowns', []) if isinstance(model, dict) and isinstance(model.get('modelName'), str)]
        if not models:
            models = [{'name': model[:160], 'total_tokens': None} for model in value.get('modelsUsed', []) if isinstance(model, str)]
        daily.append({'date': key, **token_mix(value), 'estimated_usd': None if partial else number(value.get('totalCost')),
                      'metered_usd': number(value.get('meteredCostUSD')) if row.get('currencyCode') == 'USD' else None, 'pricing_complete': not partial,
                      'models': models})
    all_history = row.get('reportingPeriod') == 'all'
    return {'state': 'ready', 'source': 'CodexBar 0.82 · Cursor 用量接口', 'scope': '当前账号云端可读取的全部日记录，可跨设备；与 Codex 本机记录范围不同' if all_history else '当前账号云端来源返回的日记录，未确认全量范围',
            'updated_at': iso_time(row.get('updatedAt')) or timestamp, 'reason': None, 'daily': sorted(daily, key=lambda r: r['date']),
            'coverage_mode': 'all_available' if all_history else 'source_window',
            'note': '日期沿用 Cursor 来源的日记录；API 等价估算与来源计费口径分栏展示，缺少字段不推算。',
            'metered_period': {'days': None if all_history else tokens(row.get('historyDays')), 'label': '全部可读历史' if all_history else '来源返回区间', 'usd': number(row.get('meteredCostUSD')) if row.get('currencyCode') == 'USD' else None}}


def cursor_session_missing(row):
    error = row.get('error')
    return isinstance(error, dict) and isinstance(error.get('message'), str) and 'No Cursor session found' in error['message']


def cursor_login_required(source, scope):
    result = unavailable(source, '采集器没有可用的 Cursor 网页登录会话。请在浏览器登录 cursor.com 后刷新；若使用 Safari，还需检查采集器的完全磁盘访问权限。', scope=scope)
    result['error_code'] = 'cursor_session_missing'
    return result


def normalize_quota(payload, provider, timestamp):
    row = provider_record(payload, provider)
    usage = row.get('usage')
    if provider == 'cursor' and cursor_session_missing(row):
        return cursor_login_required('CodexBar · 账号额度', '账号订阅窗口')
    if row.get('error') or not isinstance(usage, dict):
        return unavailable('CodexBar · 账号额度', '额度未读取成功，请检查对应软件的登录状态与采集器授权。', scope='账号订阅窗口')
    windows = []
    labels = row.get('rateWindowLabels') or {}
    for index, key in enumerate(('primary', 'secondary', 'tertiary')):
        value = usage.get(key)
        if not isinstance(value, dict):
            continue
        used = number(value.get('usedPercent'))
        if used is None:
            continue
        minutes = number(value.get('windowMinutes'))
        label = labels.get(key) if isinstance(labels, dict) else None
        label = {'Total': '套餐总额度', 'Cursor': 'Cursor 模型', 'Third Party': '第三方模型', 'Weekly': '每周窗口', 'Session': '会话窗口'}.get(label, label)
        if not isinstance(label, str):
            label = {300: '5 小时窗口', 10080: '每周窗口', 43200: '每月窗口'}.get(minutes, f'额度窗口 {index + 1}')
        reset = iso_time(value.get('resetsAt'))
        expired = bool(reset and datetime.fromisoformat(reset) <= datetime.fromisoformat(timestamp))
        windows.append({'id': key, 'label': label[:80], 'used_percent': used, 'remaining_percent': None if expired else max(0, 100-used),
                        'window_minutes': minutes, 'resets_at': reset, 'expired': expired})
    return {'state': 'ready' if windows else 'unavailable', 'source': 'CodexBar · 账号额度', 'scope': '账号订阅窗口；与每日 token 统计独立',
            'updated_at': iso_time(usage.get('updatedAt')) or timestamp, 'windows': windows,
            'reason': None if windows else '当前数据源未提供可读的额度窗口。'}


class CollectorError(Exception):
    pass


def run_json(arguments, timeout):
    env = dict(os.environ, NO_COLOR='1', CI='1', TERM='dumb')
    process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, start_new_session=True)
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        raise CollectorError('采集超时，保留状态供稍后重试。')
    try:
        return json.loads(output)
    except (ValueError, TypeError):
        # 不把 CLI stderr、认证字段或未知原文透传进页面和缓存。
        raise CollectorError('采集器未返回可读统计，请检查登录或工具版本。')


def executable(root, name):
    candidates = [root / 'scripts/usage-tools/node_modules/.bin' / name]
    found = shutil.which(name)
    if found:
        candidates.append(Path(found))
    if name == 'codexbar':
        candidates.extend(Path(p) for p in ('/opt/homebrew/bin/codexbar', '/usr/local/bin/codexbar', '/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI'))
    return next((str(path) for path in candidates if path.is_file() and os.access(path, os.X_OK)), None)


class UsageService:
    def __init__(self, root, runner=run_json):
        self.root = Path(root); self.runner = runner
        self.lock = threading.Lock(); self.refreshing = False; self.last_attempt = None
        self.value = {'schema_version': 2, 'timezone': 'Asia/Shanghai', 'window': period(), 'refreshed_at': None,
                      'providers': [self.empty_provider(p) for p in ('codex', 'cursor')]}
        self.cache = self.root / '.local/usage-snapshot.json'
        try:
            saved = json.loads(self.cache.read_text())
            if saved.get('schema_version') in (1, 2):
                # 本文件仅由已规范化的采集结果生成。启动后明确标记为旧快照。
                if not isinstance(saved.get('providers'), list) or {p.get('id') for p in saved['providers'] if isinstance(p, dict)} != {'codex', 'cursor'}:
                    raise ValueError('缓存格式不兼容')
                for provider in saved['providers']:
                    if not isinstance(provider.get('history'), dict) or not isinstance(provider.get('quota'), dict):
                        raise ValueError('缓存格式不兼容')
                for provider in saved['providers']:
                    if provider['history'].get('state') not in ('ready', 'stale', 'unavailable', 'missing_dependency') or not isinstance(provider['history'].get('daily'), list):
                        raise ValueError('缓存格式不兼容')
                    if provider['history']['state'] == 'ready':
                        provider['history']['state'] = 'stale'
                    if saved['schema_version'] == 1:
                        provider['history'].update(coverage_mode='legacy_30', reason='旧版缓存仅含近 30 天，等待全量采集。')
                    provider['quota'] = unavailable('CodexBar · 账号额度', '重启后等待重新读取，旧额度不作为当前值。')
                saved.update(schema_version=2, window=period())
                self.value = saved
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            pass

    def empty_provider(self, provider):
        return {'id': provider, 'name': 'Codex' if provider == 'codex' else 'Cursor',
                'history': unavailable('ccusage · 本地日志' if provider == 'codex' else 'CodexBar · 用量接口', '尚未采集每日明细。'),
                'quota': unavailable('CodexBar · 账号额度', '尚未读取账号额度。')}

    def snapshot(self):
        with self.lock:
            result = deepcopy(self.value)
            timestamp = now()
            result.update(refreshing=self.refreshing, refresh_interval_seconds=INTERVAL, served_at=timestamp.isoformat())
            for provider in result['providers']:
                history = provider['history']
                history_time = iso_time(history.get('updated_at'))
                if history['state'] == 'ready' and history_time and (timestamp - datetime.fromisoformat(history_time)).total_seconds() > 900:
                    history.update(state='stale', reason='日统计快照已超过 15 分钟，等待重新读取。')
                quota = provider['quota']
                measured = iso_time(quota.get('updated_at'))
                outdated = measured and (timestamp - datetime.fromisoformat(measured)).total_seconds() > 900
                if outdated and quota['state'] == 'ready':
                    quota.update(state='stale', reason='额度快照已超过 15 分钟，等待重新读取。')
                for window in quota.get('windows', []):
                    reset = iso_time(window.get('resets_at'))
                    if outdated or (reset and datetime.fromisoformat(reset) <= timestamp):
                        window.update(expired=True, remaining_percent=None)
            return result

    def refresh(self):
        with self.lock:
            if self.refreshing or (self.last_attempt is not None and time.monotonic() - self.last_attempt < 15):
                return False
            self.refreshing = True; self.last_attempt = time.monotonic()
        threading.Thread(target=self.collect, daemon=True, name='ai-hub-usage').start()
        return True

    def collect_provider(self, provider, window):
        result = self.empty_provider(provider); timestamp = now().isoformat()
        tool = executable(self.root, 'codexbar')
        if provider == 'codex':
            ccusage = executable(self.root, 'ccusage')
            if not ccusage:
                result['history'] = unavailable('ccusage', '缺少每日采集工具，请按 README 安装固定版本。', 'missing_dependency')
            else:
                try:
                    raw = self.runner([ccusage, 'codex', 'daily', '--json', '--offline', '--timezone', 'Asia/Shanghai'], 180)
                    result['history'] = normalize_ccusage(raw, window, now().isoformat())
                except (OSError, CollectorError, ValueError, TypeError, KeyError, AttributeError):
                    result['history'] = unavailable('ccusage', '本机每日明细读取失败，可能是版本不兼容或读取超时。')
        if tool:
            try:
                raw = self.runner([tool, 'usage', '--provider', provider, '--source', 'oauth' if provider == 'codex' else 'auto', '--format', 'json', '--json-only', '--no-color'], 35)
                result['quota'] = normalize_quota(raw, provider, now().isoformat())
            except (OSError, CollectorError, ValueError, TypeError, KeyError, AttributeError):
                result['quota'] = unavailable('CodexBar · 账号额度', '额度读取超时或未授权，请检查对应软件登录状态。')
            if provider == 'cursor':
                try:
                    raw = self.runner([tool, 'cost', '--provider', 'cursor', '--period', 'all', '--format', 'json', '--json-only', '--no-color'], 180)
                    result['history'] = normalize_cursor_cost(raw, window, now().isoformat())
                except (OSError, CollectorError, ValueError, TypeError, KeyError, AttributeError):
                    result['history'] = unavailable('CodexBar · Cursor 用量接口', 'Cursor 每日明细暂未取得，请检查登录与费用读取设置。')
        else:
            result['quota'] = unavailable('CodexBar', '缺少额度采集工具，请按 README 安装 CodexBar。', 'missing_dependency')
            if provider == 'cursor':
                result['history'] = unavailable('CodexBar', '缺少 Cursor 用量采集工具。', 'missing_dependency')
        return result

    def collect(self):
        window = period()
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(self.collect_provider, p, window) for p in ('codex', 'cursor')]
                for future in as_completed(futures):
                    provider = future.result()
                    with self.lock:
                        self.value['window'] = window
                        previous = next(p for p in self.value['providers'] if p['id'] == provider['id'])
                        if provider['history']['state'] not in ('ready',) and previous['history'].get('daily'):
                            history = deepcopy(previous['history']); history['state'] = 'stale'
                            history['daily'] = [row for row in history['daily'] if window['since'] <= row['date'] <= window['until']]
                            history['reason'] = provider['history']['reason']; provider['history'] = history
                        self.value['providers'] = [provider if p['id'] == provider['id'] else p for p in self.value['providers']]
            with self.lock:
                self.value['refreshed_at'] = now().isoformat()
                value = deepcopy(self.value)
            self.cache.parent.mkdir(exist_ok=True)
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.cache.parent, delete=False) as handle:
                json.dump(value, handle, ensure_ascii=False, allow_nan=False)
                temporary = Path(handle.name)
            os.chmod(temporary, 0o600)
            temporary.replace(self.cache)
        finally:
            with self.lock:
                self.refreshing = False
