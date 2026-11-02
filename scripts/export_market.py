#!/usr/bin/env python3
"""按白名单导出独立运营项目；不复制个人资料、数据库、规则、依赖或 Git 历史。"""
import argparse
from datetime import datetime
import hashlib
from pathlib import Path
import shutil
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CORE = ('market_hub.py', 'market_server.py', 'market_collect.py', 'test_market_hub.py', 'test_market_collect_hub.py')
BROWSER = ('auth.mjs', 'oppo.mjs', 'oppo-data.mjs', 'portal.mjs', 'portals.mjs', 'profile.mjs', 'test-oppo.mjs', 'test-platforms.mjs', 'test-reviews.mjs')
ADAPTERS = ('common.mjs', 'honor.mjs', 'review-data.mjs', 'vivo.mjs', 'xiaomi.mjs')
TEMPLATE = ('server.py', 'setup.command', 'start.command', 'README.md', '.gitignore', '.dockerignore', 'ui/index.html', 'ui/vite.config.js', 'ui/package.json', 'ui/package-lock.json', 'ui/src/main.jsx', 'ui/src/connection.css', 'deploy/Dockerfile', 'deploy/compose.yaml', 'tests/test_connection.py')


def sources():
    files = [(ROOT / 'standalone/operations' / name, name) for name in TEMPLATE]
    files += [(ROOT / 'scripts' / name, 'scripts/' + name) for name in CORE]
    files += [(ROOT / 'scripts/market-browser' / name, 'scripts/market-browser/' + name) for name in BROWSER]
    files += [(ROOT / 'scripts/market-browser/adapters' / name, 'scripts/market-browser/adapters/' + name) for name in ADAPTERS]
    files += [(ROOT / 'ui/src' / name, 'ui/src/' + name) for name in ('MarketPage.jsx', 'market.css')]
    files += [(ROOT / 'ui/src/market-main.jsx', 'ui/src/market-main.jsx'), (ROOT / 'ui/market.html', 'ui/market.html')]
    return files


def export(destination):
    destination = Path(destination)
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('导出目标不是空目录，停止覆盖。')
    items = sources()
    for src, name in items:
        if not src.is_file() or src.is_symlink():
            raise ValueError('缺少来源或不允许软链接：' + name)
    destination.mkdir(parents=True, exist_ok=True)
    for src, name in items:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
    return len(items)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, help='导出到新的空目录，不包含任何 Git 数据')
    args = parser.parse_args()
    if args.directory:
        print(f'已导出 {export(args.directory)} 个来源文件：{args.directory}')
        return
    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    archive = dist / ('isho-operations-source-0.1.0-' + stamp + '.zip')
    with tempfile.TemporaryDirectory(prefix='isho-operations-') as temp:
        folder = Path(temp) / 'isho-operations'
        count = export(folder)
        with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED) as output:
            for path in sorted(folder.rglob('*')):
                if path.is_file():
                    output.write(path, path.relative_to(folder.parent))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256').write_text(digest + '  ' + archive.name + '\n')
    print(f'已导出 {count} 个来源文件：{archive}\nSHA-256：{digest}')


if __name__ == '__main__':
    main()
