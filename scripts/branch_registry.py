#!/usr/bin/env python3
"""登记独立分支和逐个目标的合入证据。"""
import argparse
from contextlib import contextmanager
from datetime import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlsplit

from project_hub import ProjectError, git, git_command, git_environment, git_read, remote_info, worktrees


TARGETS = ('main', 'dev', 'release')
OID = re.compile(r'(?:[0-9a-f]{40}|[0-9a-f]{64})')


def registry_path(root):
    return root / '.local' / 'branch-registry.json'


def read_records(root):
    try:
        records = json.loads(registry_path(root).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return []
    if not isinstance(records, list) or any(not isinstance(row, dict) or 'id' not in row for row in records):
        raise ValueError('分支清单格式有误')
    return records


def write_records(path, rows):
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as handle:
        temp = Path(handle.name)
        try:
            json.dump(rows, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
            handle.flush()
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)


def ref_name(repo, name):
    if not name or name.startswith('-') or git(repo, 'check-ref-format', f'refs/heads/{name}') is None:
        raise ValueError('需要实际 Git 分支名')
    return name


def commit(repo, ref):
    return git(repo, 'rev-parse', '--verify', '--end-of-options', f'{ref}^{{commit}}')


def command(repo, *args, online=False, timeout=12):
    env = git_environment()
    if online:
        env.update(GIT_ALLOW_PROTOCOL='ssh:https:http:git:file')
    try:
        return subprocess.run(git_command(repo, *args), capture_output=True, text=True, timeout=timeout, env=env)
    except (OSError, subprocess.SubprocessError):
        return None


def remote_heads(repo, remote, names=None):
    refs = tuple('refs/heads/' + name for name in names if name) if names else ()
    for _ in range(2):
        result = command(repo, 'ls-remote', '--refs', '--heads', remote, *refs, online=True)
        if result is not None and result.returncode == 0:
            break
    else:
        return None
    heads = {}
    for line in result.stdout.splitlines():
        oid, _, ref = line.partition('\t')
        if ref.startswith('refs/heads/') and OID.fullmatch(oid):
            heads[ref.removeprefix('refs/heads/')] = oid
    return heads


def read_heads(repo, remote, names, online, head_cache, key):
    heads = None
    if online and remote:
        if head_cache is None:
            heads = remote_heads(repo, remote, names)
        else:
            if key not in head_cache:
                head_cache[key] = remote_heads(repo, remote)
            heads = head_cache[key]
    if heads is not None:
        return heads, 'remote'
    local_heads = {branch: commit(repo, f'refs/remotes/{remote}/{branch}')
                   for branch in set(names) if branch and remote}
    return local_heads, 'remote_unavailable' if online else 'local'


@contextmanager
def with_remote_objects(repo, raw_url, heads):
    missing = {oid for oid in heads if oid and OID.fullmatch(oid) and commit(repo, oid) != oid}
    objects = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'objects') if missing else None
    if not raw_url or not objects:
        yield repo
        return
    # 核验新远端头时补齐临时对象，原仓库引用与 FETCH_HEAD 保持独立。
    with tempfile.TemporaryDirectory(prefix='ai-hub-branch-objects-') as temp:
        scratch = Path(temp)
        initialized = command(scratch, 'init', '--bare', '--quiet')
        if initialized is None or initialized.returncode != 0:
            yield repo
            return
        (scratch / 'objects' / 'info' / 'alternates').write_text(objects + '\n', encoding='utf-8')
        url = raw_url if ':' in raw_url.partition('/')[0] else str((repo / raw_url).resolve())
        command(scratch, 'fetch', '--no-tags', '--no-write-fetch-head', '--', url, *sorted(missing),
                online=True, timeout=24)
        yield scratch


def contains(repo, base, head):
    if commit(repo, base) != base or commit(repo, head) != head:
        return None
    result = command(repo, 'merge-base', '--is-ancestor', base, head)
    if result is None or result.returncode not in (0, 1):
        return None
    return result.returncode == 0


def https_link(value, host=None):
    url = urlsplit(value)
    if (url.scheme != 'https' or not url.hostname or url.username or url.password or url.query
            or host is not None and url.hostname != host):
        raise ValueError('请提供无认证信息的 HTTPS 链接')
    return value


def target_snapshot(repo, name, head, source_branch, candidate, current_head, base_oid, proof=None):
    result = dict(name=name, head=head, state='unselected')
    if not name:
        return result
    if not head:
        return {**result, 'state': 'unavailable'}
    if name == source_branch:
        return {**result, 'state': 'on_source'}
    if not candidate or current_head != candidate:
        state = 'uncommitted' if current_head == base_oid else 'candidate_pending'
        return {**result, 'state': state}
    included = contains(repo, candidate, head)
    if included:
        return {**result, 'state': 'merged', 'method': 'ancestry'}
    if (proof and proof['target'] == name and proof['source'] == candidate
            and contains(repo, proof['merge'], head)):
        return {**result, 'state': 'merged', 'method': 'receipt', 'evidence': proof}
    return {**result, 'state': 'not_contained' if included is False else 'unverified'}


def workspace_snapshot(tree):
    readable = tree['exists'] and not tree['prunable']
    changes = git(tree['path'], 'status', '--porcelain=v1', '--untracked-files=normal') if readable else None
    return dict(path=tree['path'], active=True, available=readable,
                dirty=None if changes is None else bool(changes), locked=tree['locked'])


def branch_record(args, repo, name, trees, previous, head_cache=None):
    purpose = (args.purpose if args.purpose is not None else previous.get('purpose', '')).strip()
    if not purpose or len(purpose) > 240:
        raise ValueError('首次登记需要 1–240 字的分支用途')
    base = previous.get('base')
    if args.base and not base:
        base_oid = commit(repo, args.base)
        if not base_oid:
            raise ValueError('无法核实创建基准')
        base = dict(ref=args.base, oid=base_oid)
    if not base:
        raise ValueError('首次登记需要创建时的实际基准')

    remotes = git_read(repo, 'remote').splitlines()
    remote = args.remote or previous.get('remote', {}).get('name') or ('origin' if 'origin' in remotes else next(iter(remotes), ''))
    if remote and (remote.startswith('-') or remote not in remotes):
        raise ValueError('指定远端不在仓库的实际配置中')
    raw = git_read(repo, 'remote', 'get-url', remote) if remote else ''
    source = remote_info(remote, raw)
    if not remote:
        source['platform'] = '本地 Git'

    old_targets = previous.get('targets', {})
    names = {}
    for role in TARGETS:
        given = getattr(args, role)
        target = old_targets.get(role, {}).get('name', '') if given is None else given
        names[role] = ref_name(repo, target) if target else ''
    requested_comparisons = args.compare if args.compare is not None else previous.get('comparisons', {})
    extra_names = [ref_name(repo, target) for target in dict.fromkeys(requested_comparisons)
                   if target not in names.values()]
    if (any(names.values()) or extra_names) and not remote:
        raise ValueError('核对合入目标需要实际远端')
    landing = list(dict.fromkeys(args.landing if args.landing is not None else previous.get('landing', [])))
    if any(not names[role] for role in landing):
        raise ValueError('计划合入的目标需要具体分支名')

    head = commit(repo, 'refs/heads/' + name)
    if not head and not previous:
        raise ValueError('首次登记需要可读取的本地分支')
    candidate = previous.get('candidate')
    if args.candidate:
        if not head or head == base['oid']:
            raise ValueError('请先核实任务提交已产生，再登记合入候选')
        candidate = head

    proofs = previous.get('proofs', {}).copy() if previous.get('remote') == source else {}
    for role, source_oid, merge_oid, link in args.proof:
        if (role not in TARGETS or not names[role] or not OID.fullmatch(source_oid)
                or not OID.fullmatch(merge_oid) or source_oid != candidate or not source['host']):
            raise ValueError('合并凭据需要目标、完整候选 SHA、合并 SHA 及平台链接')
        proofs[role] = dict(target=names[role], source=source_oid, merge=merge_oid, url=https_link(link, source['host']))

    compared = [*names.values(), *extra_names]
    heads, verification = read_heads(repo, remote, [name, *compared], args.online,
                                     head_cache, (trees[0]['path'], remote, raw))
    target_oids = (heads.get(target) for target in compared) if candidate and verification == 'remote' else ()
    with with_remote_objects(repo, raw, target_oids) as object_repo:
        def inspect(target, proof=None):
            return target_snapshot(object_repo, target, heads.get(target), name,
                                   candidate, head or candidate, base['oid'], proof)

        targets = {role: inspect(target, proofs.get(role)) for role, target in names.items()}
        comparisons = {target: inspect(target) for target in extra_names}

    active = [workspace_snapshot(tree) for tree in trees[1:] if tree['branch'] == name]
    primary = workspace_snapshot(trees[0]) if trees[0]['branch'] == name else None
    active_paths = {tree['path'] for tree in active}
    ended = [
        {**tree, 'active': False, 'available': Path(tree['path']).is_dir()}
        for tree in previous.get('directories', []) if tree['path'] not in active_paths
    ]
    retained = candidate if args.keep and candidate else previous.get('retained')
    arrived = (verification == 'remote' and bool(landing) and candidate and candidate == head
               and all(targets[role]['state'] == 'merged' for role in landing))
    cleanup = 'none'
    if active:
        cleanup = 'integration' if name in names.values() else 'waiting'
        if arrived and cleanup == 'waiting':
            safe_to_review = all(tree['available'] and tree['dirty'] is False and not tree['locked'] for tree in active)
            cleanup = 'kept' if retained == candidate else ('review' if safe_to_review else 'blocked')
    archive = https_link(args.archive) if args.archive else previous.get('archive')
    return dict(branch=name, purpose=purpose, project=Path(trees[0]['path']).name, repo_path=trees[0]['path'],
                remote=source, base=base, head=head, candidate=candidate, publication=heads.get(name),
                verification=verification, targets=targets, comparisons=comparisons, landing=landing, proofs=proofs,
                directories=active + ended, primary_directory=primary, cleanup=cleanup, retained=retained,
                archive=archive, checked_at=datetime.now().astimezone().isoformat(timespec='seconds'))


def record(root, args, head_cache=None, expected_id=None):
    repo = Path(args.repo).expanduser().resolve()
    common = git_read(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    name = ref_name(repo, args.branch or git_read(repo, 'branch', '--show-current'))
    trees = worktrees(repo)
    if not trees:
        raise ValueError('无法核对实际 Git 工作树')
    key = hashlib.sha256(os.fsencode(common) + b'\0' + name.encode()).hexdigest()[:24]
    if expected_id is not None and key != expected_id:
        raise ValueError('登记目录对应的 Git 仓库已变更')
    path = registry_path(root)
    path.parent.mkdir(exist_ok=True)
    with os.fdopen(os.open(path.with_suffix('.lock'), os.O_CREAT | os.O_RDWR, 0o600), 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        rows = read_records(root)
        previous = next((row for row in rows if row['id'] == key), {})
        current = {'id': key, **branch_record(args, repo, name, trees, previous, head_cache)}
        write_records(path, [current, *[row for row in rows if row['id'] != key]])
    return current


def refresh_all(root, args):
    records, failures, heads = [], [], {}
    for row in read_records(root):
        repo = row.get('repo_path') or next(
            (tree['path'] for tree in row.get('directories', []) if tree.get('active') and tree.get('available')), None
        )
        try:
            if not repo:
                raise ValueError('旧记录需要用实际仓库目录重新核对一次')
            params = argparse.Namespace(**{**vars(args), 'repo': repo, 'branch': row['branch']})
            records.append(record(root, params, head_cache=heads, expected_id=row['id']))
        except (ProjectError, ValueError, OSError) as error:
            failures.append(dict(project=row['project'], branch=row['branch'], error=str(error)))
    return dict(records=records, errors=failures)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument('--repo', help='实际仓库或关联工作树目录')
    scope.add_argument('--all', action='store_true', help='按仓库核验清单里的全部已登记分支')
    parser.add_argument('--branch', help='默认使用当前本地分支')
    parser.add_argument('--purpose', help='首次登记时填写业务用途')
    parser.add_argument('--base', help='首次登记时填写实际创建基准')
    parser.add_argument('--remote', help='实际远端名称')
    for role in TARGETS:
        parser.add_argument('--' + role, help='指定此目标的实际分支名，空值表示未指定')
    parser.add_argument('--landing', action='append', choices=TARGETS, help='该任务明确要合入的目标，可重复')
    parser.add_argument('--compare', action='append', help='附加对照分支，可重复。它们不改变计划合入范围')
    parser.add_argument('--candidate', action='store_true', help='按已确认任务提交登记当前分支头')
    parser.add_argument('--online', action='store_true', help='查询实际远端，缺少的目标对象读取到临时仓库')
    parser.add_argument('--proof', action='append', nargs=4, default=[], metavar=('角色', '候选SHA', '合并SHA', '链接'))
    parser.add_argument('--archive', help='已有飞书条目的 HTTPS 链接')
    parser.add_argument('--keep', action='store_true', help='已收到保留独立目录的选择')
    args = parser.parse_args()
    if args.all and any(value for key, value in vars(args).items() if key not in ('all', 'online')):
        parser.error('--all 仅配合 --online 使用，单条记录的字段通过 --repo 修改')
    root = Path(__file__).resolve().parents[1]
    try:
        result = refresh_all(root, args) if args.all else record(root, args)
    except (ProjectError, ValueError, OSError) as error:
        parser.exit(1, f'{error}\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.all and result['errors']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
