#!/usr/bin/env python3
"""导出可公开的完整 AI Hub：只复制源码，使用通用模板并检查个人资源。"""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = ('docs/images/overview.png', 'docs/images/projects.png', 'docs/images/market.png')
TEMPLATES = ('README.md', 'RULE.md', 'inventory.md', 'manifest.tsv', 'setup.command', 'start.command',
             'tracker-config.example.json', 'rules/global.md', 'rules/cursor-bootstrap.md',
             'rules/agents-bootstrap.md', 'skills/README.md', 'ui/projects.json',
             'docs/portability.md', 'docs/market-operations.md')
TOP = ('.gitignore', '.dockerignore', 'ui/index.html', 'ui/market.html', 'ui/package.json',
       'ui/package-lock.json', 'ui/vite.config.js', 'scripts/pull.sh', 'scripts/cursor_rules.applescript',
       'scripts/usage-tools/package.json', 'scripts/usage-tools/package-lock.json')
BLOCKED_PARTS = {'.git', '.local', '.build', '.backups', 'archive', 'dist', 'node_modules', '__pycache__'}
PATTERNS = (
    r'/Users/[A-Za-z0-9_.-]+(?:/|[\"\'])',
    r'https?://(?!your-company\.|example\.)[A-Za-z0-9-]+\.feishu\.cn/(?:docx|base|wiki)/[A-Za-z0-9]+',
    r'\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{30,})',
    r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
)


def source_files():
    files = [(ROOT / name, name) for name in (*TOP, *SCREENSHOTS)]
    template_root = ROOT / 'distribution/public'
    files += [((template_root if template_root.is_dir() else ROOT) / name, name) for name in TEMPLATES]
    files += [(p, p.relative_to(ROOT).as_posix()) for p in sorted((ROOT / 'scripts').glob('*.py'))]
    for directory in ('ui/src', 'desktop/macos', 'deploy/market', 'scripts/market-browser', 'standalone/operations', 'distribution/public'):
        for path in sorted((ROOT / directory).rglob('*')):
            if not path.is_file() or BLOCKED_PARTS.intersection(path.relative_to(ROOT).parts):
                continue
            if path.suffix not in ('.py', '.js', '.jsx', '.mjs', '.css', '.swift', '.html', '.json', '.md', '.yaml', '.command', '.tsv') and path.name not in ('.gitignore', '.dockerignore', 'Dockerfile'):
                continue
            files.append((path, path.relative_to(ROOT).as_posix()))
    unique = {}
    for source, name in files:
        unique[name] = source
    return [(path, name) for name, path in sorted(unique.items())]


def private_markers():
    markers = set()
    config = ROOT / '.local/tracker-config.json'
    if config.is_file():
        try:
            value = json.loads(config.read_text())
            markers.update((value['base_token'], value['base_url']))
            for table in value['tables'].values():
                markers.add(table['id'])
                markers.update(table['fields'].values())
        except (OSError, ValueError, KeyError, AttributeError, TypeError):
            raise ValueError('无法读取本机台账资源清单，未继续公开导出。')
    return {item for item in markers if isinstance(item, str) and len(item) > 7}


def clean_content(name, data):
    if name in SCREENSHOTS:
        return data
    text = data.decode('utf-8')
    if name == 'ui/src/main.jsx':
        text = re.sub(r'(<strong>)[^<]+ 的空间(</strong>)', r'\1我的空间\2', text)
        text = re.sub(r'(<button className="profile"[^\n]*?<strong>)[^<]+(</strong>)', r'\1本机用户\2', text)
        text = text.replace("useState({ type: 'project', id: 'isho' })", "useState({ type: 'project', id: 'hub' })")
        text = re.sub(r'https://[^/]+\.feishu\.cn/docx/[A-Za-z0-9]+', 'https://github.com/1848991298/isho-operations#readme', text)
        text = text.replace('>L</span>', '>A</span>').replace('>L</div>', '>A</div>')
    if name == 'ui/index.html':
        text = re.sub(r'(<meta name="description" content=")[^"]*(" />)', r'\1工程、Skills 与 Rules 本地工作台。\2', text)
    if name == 'scripts/preview_hub.py':
        text = text.replace('用户入口曾人工核对，当前加载待核实', '用户入口待检查')
    if name in ('ui/package.json', 'ui/package-lock.json'):
        value = json.loads(text)
        value['name'] = 'ai-hub-ui'
        if '' in value.get('packages', {}):
            value['packages']['']['name'] = 'ai-hub-ui'
        text = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    text = re.sub(r'com\.[a-z0-9_-]+\.aihub', 'com.aihub.desktop', text)
    return text.encode()


def audit(contents, markers=()):
    for name, data in contents.items():
        if BLOCKED_PARTS.intersection(Path(name).parts) or name.startswith('rules/clients/') or name.endswith(('.sqlite', '.enc', '.pem', '.key')):
            raise ValueError('不允许公开的文件路径：' + name)
        if name in SCREENSHOTS:
            if not data.startswith(b'\x89PNG\r\n\x1a\n'):
                raise ValueError('文档截图不是 PNG：' + name)
            continue
        text = data.decode('utf-8')
        if any(re.search(pattern, text) for pattern in PATTERNS) or any(marker in text for marker in markers):
            raise ValueError('发现个人资源或凭据模式，停止导出；请检查文件：' + name)


def export(destination):
    destination = Path(destination)
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('导出目标不是空目录，未覆盖已有内容。')
    contents = {}
    modes = {}
    for path, name in source_files():
        if not path.is_file() or path.is_symlink():
            raise ValueError('来源缺失或不允许软链接：' + name)
        contents[name] = clean_content(name, path.read_bytes())
        modes[name] = path.stat().st_mode & 0o777
    audit(contents, private_markers())
    destination.mkdir(parents=True, exist_ok=True)
    for name, data in contents.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(modes[name])
    return len(contents)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path)
    args = parser.parse_args()
    if args.directory:
        print(f'公开源码已导出 {export(args.directory)} 个文件：{args.directory}')
        return
    output = ROOT / 'dist'
    output.mkdir(exist_ok=True)
    archive = output / ('ai-hub-public-source-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.zip')
    with tempfile.TemporaryDirectory(prefix='ai-hub-public-') as temp:
        folder = Path(temp) / 'ai-hub'
        count = export(folder)
        with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED) as package:
            for path in sorted(folder.rglob('*')):
                if path.is_file():
                    package.write(path, path.relative_to(folder.parent))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256').write_text(digest + '  ' + archive.name + '\n')
    print(f'公开源码已导出 {count} 个文件：{archive}\nSHA-256：{digest}')


if __name__ == '__main__':
    main()
