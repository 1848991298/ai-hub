#!/usr/bin/env python3
"""AI Hub 的本地映射、自检、迁移打包与恢复；仅使用 Python 标准库。"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile
from datetime import datetime

ROOT = Path(__file__).resolve().parent.parent
START, END = '<!-- AI-HUB:START -->', '<!-- AI-HUB:END -->'


def lexpath(value):
    return Path(os.path.abspath(os.path.expanduser(str(value))))


def present(path):
    return path.exists() or path.is_symlink()


def canonical_skills():
    names, seen = [], set()
    for number, raw in enumerate((ROOT / 'manifest.tsv').read_text().splitlines(), 1):
        if not raw.strip() or raw.startswith('#'):
            continue
        fields = raw.split('\t')
        if len(fields) < 3 or fields[0] not in ('canonical', 'divergent'):
            raise ValueError(f'manifest.tsv 第 {number} 行格式错误')
        status, name = fields[:2]
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', name) or name in seen:
            raise ValueError(f'无效或重复的 skill 名称：{name}')
        seen.add(name)
        if status != 'canonical':
            continue
        source = ROOT / 'skills' / name
        parts = (source / 'SKILL.md').read_text().split('---', 2)
        if len(parts) < 3 or parts[0].strip():
            raise ValueError(f'{name} 缺少 YAML frontmatter')
        if not re.search(r'^name:\s*[\"\']?' + re.escape(name) + r'[\"\']?\s*$', parts[1], re.M):
            raise ValueError(f'{name} 的 frontmatter name 不一致')
        if not re.search(r'^description:\s*\S', parts[1], re.M):
            raise ValueError(f'{name} 缺少 description')
        if any(p != source / 'SKILL.md' for p in source.rglob('SKILL.md')):
            raise ValueError(f'{name} 含嵌套 SKILL.md，会重复发现，请移到 archive/')
        names.append(name)
    for name in ('rules/global.md', 'rules/cursor-bootstrap.md', 'rules/agents-bootstrap.md'):
        if not (ROOT / name).is_file():
            raise ValueError(f'缺少来源：{name}')
    return names


def context(args):
    home = lexpath(args.home or Path.home())
    codex = lexpath(os.environ.get('CODEX_HOME', home / '.codex')) if not args.home else home / '.codex'
    paths = {side: lexpath(os.environ.get(env, default)) for side, env, default in (
        ('cursor', 'AI_HUB_CURSOR_SKILLS', home / '.cursor/skills'),
        ('codex', 'AI_HUB_CODEX_SKILLS', codex / 'skills'),
        ('agents', 'AI_HUB_AGENTS_SKILLS', home / '.agents/skills'))}
    rules = lexpath(os.environ.get('AI_HUB_CODEX_RULES', codex / 'AGENTS.md'))
    return home, home / '.ai-hub', paths, rules


def equal_tree(src, dest):
    if src.is_file():
        return dest.is_file() and src.read_bytes() == dest.read_bytes()
    if not dest.is_dir():
        return False
    left, right = {p.name for p in src.iterdir()}, {p.name for p in dest.iterdir()}
    return left == right and all(equal_tree(src / name, dest / name) for name in left)


def managed_readme(path):
    old = path.read_text() if path.exists() else '# 全局代理资源\n'
    section = START + '\n' + (ROOT / 'rules/agents-bootstrap.md').read_text().strip() + '\n' + END
    if START in old or END in old:
        if old.count(START) != 1 or old.count(END) != 1 or old.index(START) > old.index(END):
            raise ValueError(f'托管区标记异常，未覆盖：{path}')
        return old[:old.index(START)] + section + old[old.index(END) + len(END):]
    return old.rstrip() + '\n\n' + section + '\n'


def plan(args):
    names = canonical_skills()
    home, anchor, paths, rules = context(args)
    sides = ['cursor', 'codex', 'agents'] if args.to == 'both' else (['codex', 'agents'] if args.to == 'codex' else ['cursor'])
    jobs, conflicts = [], []
    old_root = anchor.resolve() if anchor.is_symlink() else None
    if anchor != ROOT:
        if present(anchor) and (not anchor.is_symlink() or anchor.resolve() != ROOT):
            if not anchor.is_symlink() or not args.relocate:
                conflicts.append(f'{anchor} 已有其他来源；搬迁须显式 --relocate，真实目录请先人工整合')
        if not anchor.is_symlink() or anchor.resolve() != ROOT:
            jobs.append(dict(label='Hub 固定入口', dest=str(anchor), target=str(ROOT), kind='link'))
    targets = [(f'{side} skill {name}', ROOT / 'skills' / name, paths[side] / name, anchor / 'skills' / name)
               for side in sides for name in names]
    if args.to in ('codex', 'both'):
        targets.append(('Codex 全局规则', ROOT / 'rules/global.md', rules, anchor / 'rules/global.md'))
    if args.to in ('cursor', 'both'):
        targets.append(('Cursor 用户规则共享入口', ROOT / 'rules/cursor-bootstrap.md', home / '.cursor/ai-hub-rule.md', anchor / 'rules/cursor-bootstrap.md'))
    for label, source, dest, target in targets:
        if dest == source or dest == target:
            raise ValueError(f'目标不能与来源重叠：{dest}')
        if dest.is_symlink() and lexpath(dest.parent / os.readlink(dest)) == target:
            continue
        if present(dest):
            relocated = False
            if args.relocate and old_root and dest.is_symlink():
                relocated = lexpath(dest.parent / os.readlink(dest)) == old_root / source.relative_to(ROOT)
            if not relocated and not equal_tree(source, dest):
                conflicts.append(f'{label} 内容不同：{dest}；先整合到 Hub，不自动覆盖')
        jobs.append(dict(label=label, dest=str(dest), target=str(target), kind='link'))
    if 'agents' in sides:
        dest = paths['agents'].parent / 'README.md'
        if dest.is_symlink():
            conflicts.append(f'不覆盖已有 README 软链接：{dest}')
        else:
            content = managed_readme(dest)
            if not dest.exists() or dest.read_text() != content:
                jobs.append(dict(label='.agents 目录说明', dest=str(dest), content=content, kind='file'))
    destinations = [j['dest'] for j in jobs]
    if len(destinations) != len(set(destinations)):
        raise ValueError('目标路径重叠，请检查 AI_HUB_* 配置')
    for job in jobs:
        dest = Path(job['dest'])
        if dest == ROOT or ROOT in dest.parents:
            raise ValueError(f'安装目标位于 Hub 内，拒绝覆盖来源：{dest}')
        parent = dest.parent
        while not present(parent):
            parent = parent.parent
        if not parent.is_dir():
            conflicts.append(f'目标父路径不是目录：{parent}')
    return jobs, conflicts


def live_guard(jobs):
    live_home = Path.home()
    live_roots = [live_home / name for name in ('.ai-hub', '.cursor', '.codex', '.agents')]
    if os.environ.get('CODEX_HOME'):
        live_roots.append(lexpath(os.environ['CODEX_HOME']))
    for job in jobs:
        dest = Path(job['dest'])
        if any(dest == base or base in dest.parents for base in live_roots):
            if os.environ.get('AI_HUB_APPLY_LIVE') != '1':
                raise ValueError('真实安装写入需要已授权并设置 AI_HUB_APPLY_LIVE=1')


def fingerprint(path):
    if path.is_symlink():
        return 'link:' + os.readlink(path)
    if path.is_file():
        return 'file:' + hashlib.sha256(path.read_bytes()).hexdigest()
    return None


def undo(records):
    for record in reversed(records):
        dest = Path(record['dest'])
        if present(dest):
            dest.unlink()
        if record.get('saved'):
            shutil.move(record['saved'], str(dest))


def apply_jobs(jobs):
    live_guard(jobs)
    if not jobs:
        print('无需修改，全部映射一致。')
        return
    backup = ROOT / '.backups' / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup.mkdir(parents=True)
    records = []
    try:
        for number, job in enumerate(jobs):
            dest = Path(job['dest'])
            dest.parent.mkdir(parents=True, exist_ok=True)
            record = dict(dest=str(dest), saved=None)
            if present(dest):
                saved = backup / f'{number:02d}-{dest.name}'
                shutil.move(str(dest), str(saved))
                record['saved'] = str(saved)
            records.append(record)
            if job['kind'] == 'link':
                dest.symlink_to(job['target'], target_is_directory=Path(job['target']).is_dir())
                if not dest.exists():
                    raise ValueError(f'映射后目标不存在：{dest}')
            else:
                dest.write_text(job['content'])
            record['installed'] = fingerprint(dest)
            (backup / 'operations.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')
            print(f'已更新 {job["label"]}：{dest}')
    except Exception:
        undo(records)
        (backup / 'rolled-back.txt').write_text('安装失败，已恢复操作前的文件和链接。\n')
        raise
    print(f'完成 {len(jobs)} 项；恢复清单：{backup / "operations.json"}')


def pull(args):
    jobs, conflicts = plan(args)
    for job in jobs:
        print(f'待更新 {job["label"]}：{job["dest"]}')
    if conflicts:
        raise ValueError('\n'.join(conflicts) + '\n存在分歧，未写入。')
    if args.apply:
        apply_jobs(jobs)
    else:
        print(f'预检结束：{len(jobs)} 项待更新，未写入。')
    if args.to in ('cursor', 'both'):
        print('Cursor 用户规则由规则工作台原生同步并读回；本脚本仅核对文件映射，不证明客户端已同步。')
    return 0


def doctor(args):
    names = canonical_skills()
    jobs, conflicts = plan(args)
    print(f'Hub：{ROOT}\nPython：{sys.version.split()[0]}\ncanonical skill：{len(names)}')
    for command in ('bash', 'git', 'ssh', 'adb', 'flutter', 'lark-cli'):
        print(f'{command}：' + (shutil.which(command) or '未安装（相关业务使用时需要）'))
    for job in jobs:
        print(f'待修复 {job["label"]}：{job["dest"]}')
    for conflict in conflicts:
        print(f'冲突：{conflict}')
    print('Cursor 用户规则保存状态须通过客户端核对；此自检不读取账号或认证文件。')
    if jobs or conflicts:
        return 1
    print('结构与文件映射检查通过。')
    return 0


def export(args):
    names = canonical_skills()
    files = [ROOT / name for name in ('.gitignore', 'README.md', 'RULE.md', 'inventory.md', 'manifest.tsv')]
    directories = [ROOT / name for name in ('rules', 'scripts', 'docs', 'ui', 'desktop')] + [ROOT / 'skills' / name for name in names]
    for folder in directories:
        if not folder.exists():
            continue
        for path in sorted(folder.rglob('*')):
            if {'__pycache__', 'node_modules', 'dist', '.build', '.local'} & set(path.relative_to(ROOT).parts) or path.name == '.DS_Store' or path.suffix == '.pyc':
                continue
            if path.is_symlink():
                raise ValueError(f'来源中存在软链接，请先确认携带内容：{path}')
            if path.is_file():
                if path.name.startswith('.env') or path.suffix.lower() in {'.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.mobileprovision'}:
                    raise ValueError(f'不打包认证或本地环境文件：{path}')
                files.append(path)
    output = lexpath(args.output)
    if present(output) or present(output.with_name(output.name + '.sha256')):
        raise ValueError(f'目标或校验文件已存在，未覆盖：{output}')
    output.parent.mkdir(parents=True, exist_ok=True)
    checksums = {}
    try:
        with output.open('xb') as stream, tarfile.open(fileobj=stream, mode='w:gz') as archive:
            for path in files:
                relative = path.relative_to(ROOT).as_posix()
                archive.add(path, arcname='ai-hub/' + relative, recursive=False)
                checksums[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
            data = (json.dumps(checksums, ensure_ascii=False, indent=2) + '\n').encode()
            info = tarfile.TarInfo('ai-hub/CHECKSUMS.json')
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    except Exception:
        output.unlink(missing_ok=True)
        raise
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_name(output.name + '.sha256').write_text(f'{digest}  {output.name}\n')
    print(f'已导出：{output}\n文件数：{len(files)}\nSHA-256：{digest}\n未包含客户端配置、备份和 archive/。')
    return 0


def restore(args):
    backup = lexpath(args.backup)
    if (backup / 'rolled-back.txt').exists() or (backup / 'restored.txt').exists():
        raise ValueError('该批次已回滚或恢复，不重复操作')
    records = json.loads((backup / 'operations.json').read_text())
    for record in records:
        dest = Path(record['dest'])
        if fingerprint(dest) != record['installed']:
            raise ValueError(f'安装后目标又有变化，停止恢复，未写入：{dest}')
        if record['saved'] and not present(Path(record['saved'])):
            raise ValueError(f'备份缺失：{record["saved"]}')
    if not args.apply:
        print(f'可恢复 {len(records)} 项；未写入。确认范围后加 --apply。')
        return 0
    live_guard(records)
    undo(records)
    (backup / 'restored.txt').write_text('已恢复本次映射之前的文件与链接。\n')
    print(f'已恢复 {len(records)} 项；Hub 正文和 Cursor UI 用户规则不在恢复范围。')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('pull', 'doctor'):
        item = sub.add_parser(name, help='预检 / 建立映射' if name == 'pull' else '只读结构和映射自检')
        item.add_argument('--home', help='安装目标用户目录，默认当前 HOME；不改变系统 HOME')
        item.add_argument('--to', choices=('cursor', 'codex', 'both'), default='both')
        item.add_argument('--relocate', action='store_true', help='确认 Hub 已搬迁，允许重指向旧 Hub 软链接')
        if name == 'pull':
            modes = item.add_mutually_exclusive_group()
            modes.add_argument('--check', action='store_true', help='默认只预检')
            modes.add_argument('--apply', action='store_true', help='备份并建立映射')
    item = sub.add_parser('export', help='打包共享规则、canonical 技能、脚本与文档')
    item.add_argument('--output', required=True, help='新 .tar.gz 文件路径，不覆盖已有文件')
    item = sub.add_parser('restore', help='按 .backups/批次/operations.json 恢复映射')
    item.add_argument('--backup', required=True, help='备份批次目录')
    item.add_argument('--apply', action='store_true', help='默认仅核对，加此参数才恢复')
    args = parser.parse_args()
    try:
        return globals()[args.command](args)
    except (ValueError, OSError, RuntimeError) as error:
        print(f'失败：{error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
