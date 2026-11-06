"""从本机忽略目录加载台账绑定；公开源码不携带任何用户资源编号。"""
import copy
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

FIELD_NAMES = ('content', 'status', 'created', 'due', 'priority', 'note', 'tags')
REQUIRED_FIELDS = set(FIELD_NAMES) - {'tags'}
DEFAULT_TABLES = {
    kind: {'id': '', 'label': label,
           'fields': {name: 'field_' + kind + '_' + name for name in FIELD_NAMES}}
    for kind, label in (('issue', '问题'), ('task', '任务'))
}


def load_settings(root):
    path = Path(root) / '.local/tracker-config.json'
    fallback = ('', '', copy.deepcopy(DEFAULT_TABLES))
    if not path.exists():
        return (*fallback, '尚未配置飞书台账。请按 README 创建本机 .local/tracker-config.json；当前不会查询任何飞书表。')
    try:
        value = json.loads(path.read_text())
        if not isinstance(value, dict) or set(value) != {'base_token', 'base_url', 'tables'}:
            raise ValueError()
        token, url, tables = value['base_token'], value['base_url'], value['tables']
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9]+', token):
            raise ValueError()
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path != '/base/' + token:
            raise ValueError()
        if not isinstance(tables, dict) or set(tables) != set(DEFAULT_TABLES):
            raise ValueError()
        clean = copy.deepcopy(DEFAULT_TABLES)
        for kind, item in tables.items():
            if not isinstance(item, dict) or set(item) - {'id', 'label', 'fields'}:
                raise ValueError()
            if not isinstance(item.get('id'), str) or not re.fullmatch(r'tbl[A-Za-z0-9]+', item['id']):
                raise ValueError()
            fields = item.get('fields')
            if not isinstance(fields, dict) or not REQUIRED_FIELDS <= set(fields) <= set(FIELD_NAMES):
                raise ValueError()
            if any(not isinstance(v, str) or not re.fullmatch(r'fld[A-Za-z0-9]+', v) for v in fields.values()) or len(set(fields.values())) != len(fields):
                raise ValueError()
            clean[kind]['id'] = item['id']
            clean[kind]['fields'] = fields
        return token, url, clean, None
    except (OSError, ValueError, TypeError, AttributeError):
        return (*fallback, '本机 tracker-config.json 格式不正确；当前不会查询飞书。请按配置示例核对后重新启动。')
