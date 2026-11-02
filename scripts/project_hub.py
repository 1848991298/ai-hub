#!/usr/bin/env python3
"""工程登记、只读 Git 识别、目录选择与 SourceTree 联动。"""
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit
import uuid


class ProjectError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def git(path, *args):
    try:
        result = subprocess.run(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', str(path), *args],
                                capture_output=True, text=True, timeout=8,
                                env=dict(os.environ, GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0'))
        return result.stdout.rstrip('\n') if result.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def remote_info(name, raw):
    # 原始 URL 只在内存解析；不把用户名、密码、查询参数和认证片段送往页面或登记文件。
    host = ''; repository = ''
    try:
        if '://' in raw:
            parsed = urlsplit(raw); host = parsed.hostname or ''; repository = parsed.path
        else:
            match = re.fullmatch(r'(?:[^@/]+@)?([^:/]+):(.+)', raw)
            if match:
                host, repository = match.groups()
        host = host.lower()
        if not re.fullmatch(r'[a-z0-9.-]+', host): host = ''
        repository = repository.strip('/').removesuffix('.git')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+', repository): repository = ''
    except ValueError:
        host = ''; repository = ''
    platform = {'github.com': 'GitHub', 'gitlab.com': 'GitLab', 'bitbucket.org': 'Bitbucket'}.get(host, '自建 Git' if host else '远端待识别')
    return dict(name=name, host=host, repository=repository, platform=platform)


def worktrees(path):
    raw = git(path, 'worktree', 'list', '--porcelain', '-z')
    if raw is None: return None
    rows = []
    for record in raw.split('\0\0'):
        values = dict(field.partition(' ')[::2] for field in record.split('\0') if field)
        if 'worktree' not in values: continue
        location = Path(values['worktree']).resolve()
        rows.append(dict(id=hashlib.sha256(str(location).encode()).hexdigest()[:16], path=str(location),
                         branch=values.get('branch', '').removeprefix('refs/heads/') or '游离 HEAD',
                         head=values.get('HEAD', '')[:12], current=location == Path(path).resolve(),
                         exists=location.is_dir(), locked='locked' in values, prunable='prunable' in values))
    return rows


def change_count(raw):
    if raw is None: return None
    records = raw.split('\0'); index = 0; count = 0
    while index < len(records):
        if not records[index]: break
        count += 1
        index += 2 if any(code in records[index][:2] for code in ('R', 'C')) else 1
    return count


def inspect_project(path):
    path = Path(path).expanduser().resolve()
    result = dict(path=str(path), exists=path.is_dir(), is_git=False, branch=None, changes=None, worktrees=0,
                  remotes=[], platform='路径不可用', platform_source='登记目录不存在', repository='未检测到仓库', last_commit=None)
    if not path.is_dir(): return result
    inside = git(path, 'rev-parse', '--is-inside-work-tree')
    if inside != 'true':
        result.update(platform='普通目录', platform_source='目录可读取，未识别为 Git 工作区')
        return result
    result['is_git'] = True
    branch = git(path, 'branch', '--show-current')
    result['branch'] = ('游离 HEAD' if branch == '' else branch)
    result['changes'] = change_count(git(path, 'status', '--porcelain', '-z', '--untracked-files=normal'))
    result['last_commit'] = git(path, 'log', '-1', '--format=%h') or None
    trees = worktrees(path)
    result['worktrees'] = len(trees) if trees is not None else None
    names = git(path, 'remote')
    if names is None:
        result.update(platform='待核实', platform_source='Git 远端读取失败')
        return result
    for name in names.splitlines():
        raw = git(path, 'remote', 'get-url', '--all', name)
        if raw is None:
            result.update(platform='待核实', platform_source='Git 远端读取失败')
            return result
        result['remotes'].extend(remote_info(name, url) for url in raw.splitlines())
    if not result['remotes']:
        result.update(platform='本地 Git', platform_source='Git 仓库未配置 remote', repository='无远端仓库')
    else:
        primary = next((remote for remote in result['remotes'] if remote['name'] == 'origin'), result['remotes'][0])
        result.update(platform=primary['platform'], repository=primary['repository'] or primary['host'] or '远端待识别',
                      platform_source=f"依据 {primary['name']} 的实际主机" + (f"：{primary['host']}" if primary['host'] else '，地址类型待识别'))
        if primary['platform'] == '自建 Git': result['platform_source'] += '；未仅凭地址推断 GitLab 等服务类型'
    return result


def detect_tags(path):
    path = Path(path)
    signatures = [('pubspec.yaml','Flutter / Dart'), ('package.json','JavaScript / TypeScript'), ('Cargo.toml','Rust'),
                  ('pyproject.toml','Python'), ('Package.swift','Swift'), ('go.mod','Go'), ('build.gradle','Gradle')]
    return [label for name,label in signatures if (path/name).is_file()] or ['本地工程']


class ProjectService:
    def __init__(self, root):
        self.root = Path(root); self.registry = self.root/'.local/projects.json'
        self.lock = threading.Lock(); self.picker_lock = threading.Lock(); self.selections = {}

    def entries(self):
        try:
            base = json.loads((self.root/'ui/projects.json').read_text())
        except (OSError, ValueError):
            raise ProjectError('工程来源清单不可读取，请检查 ui/projects.json。',500)
        try:
            local = json.loads(self.registry.read_text())
        except FileNotFoundError:
            local = []
        except (OSError, ValueError):
            raise ProjectError('本机工程清单不可读取，请保留文件并检查。',500)
        if not isinstance(base,list): raise ProjectError('工程来源清单格式有误。',500)
        if not isinstance(local, list) or any(not isinstance(row,dict) or not isinstance(row.get('id'),str) or not isinstance(row.get('path'),str) for row in local):
            raise ProjectError('本机工程清单格式有误，请保留文件并检查。', 500)
        return base + local

    def path(self, entry):
        return self.root.resolve() if entry['path']=='@hub' else Path(entry['path']).expanduser().resolve()

    def entry(self, project_id):
        entry = next((entry for entry in self.entries() if entry['id']==project_id), None)
        if entry is None: raise ProjectError('未找到已登记的工程。', 404)
        return entry

    def snapshot(self, entry):
        return {**entry, 'registered_platform':entry.get('platform'), **inspect_project(self.path(entry))}

    def picker(self):
        configured = os.environ.get('AI_HUB_PROJECT_PICKER')
        candidates = [Path(configured)] if configured else []
        candidates.append(self.root/'dist/AI Hub.app/Contents/Resources/ProjectPicker.app/Contents/MacOS/AIHubProjectPicker')
        return next((str(path) for path in candidates if path.is_file() and os.access(path,os.X_OK)), None)

    def sourcetree(self):
        candidates = ['/Applications/Sourcetree.app/Contents/Resources/stree','/Applications/SourceTree.app/Contents/Resources/stree']
        found = shutil.which('stree')
        if found: candidates.append(found)
        return next((path for path in candidates if Path(path).is_file() and os.access(path,os.X_OK)),None)

    def capabilities(self):
        return dict(schema_version=1, directory_picker=bool(self.picker()), sourcetree=bool(self.sourcetree()))

    def prepare_selection(self, path):
        selected = Path(path).expanduser().resolve()
        if not selected.is_dir(): raise ProjectError('所选文件夹已不存在，请重新选择。')
        top = git(selected, 'rev-parse', '--show-toplevel')
        path = Path(top).resolve() if top else selected
        candidate = inspect_project(path)
        candidate.update(name=path.name or '本地工程', tags=detect_tags(path))
        duplicate = next((entry for entry in self.entries() if self.path(entry)==path),None)
        candidate['existing_id'] = duplicate['id'] if duplicate else None
        token = uuid.uuid4().hex
        with self.lock:
            self.selections = {key:value for key,value in self.selections.items() if time.monotonic()-value['created']<600}
            self.selections[token] = dict(path=str(path), created=time.monotonic())
        return dict(status='selected', selection_token=token, candidate=candidate)

    def pick(self):
        executable = self.picker()
        if not executable: raise ProjectError('当前安装缺少系统目录选择器，请先构建新版 macOS App。',503)
        if not self.picker_lock.acquire(blocking=False): raise ProjectError('文件夹选择窗口已打开，请先完成或取消选择。',409)
        try:
            try:
                # 通过 Launch Services 启动 App，保证系统窗口归属和完成后的焦点恢复。
                self.registry.parent.mkdir(exist_ok=True)
                with tempfile.TemporaryDirectory(prefix='picker-',dir=self.registry.parent) as temporary:
                    output=Path(temporary)/'selection.json'
                    bundle=Path(executable).parents[2]
                    result = subprocess.run(['/usr/bin/open','-W','-n',str(bundle),'--args','--result',str(output)],capture_output=True,text=True,timeout=315)
                    value = json.loads(output.read_text())
            except (OSError,ValueError,subprocess.SubprocessError):
                raise ProjectError('文件夹选择未完成，请重新打开选择窗口。',503)
            if not isinstance(value,dict): raise ProjectError('目录选择器未返回有效结果。',503)
            if value.get('status')=='cancelled': return dict(status='cancelled')
            if result.returncode != 0 or not isinstance(value.get('path'),str): raise ProjectError('目录选择器未返回有效文件夹。',503)
            return self.prepare_selection(value['path'])
        finally:
            self.picker_lock.release()

    def add(self, value):
        if not isinstance(value,dict) or set(value) != {'selection_token','name','description'} or any(not isinstance(value[key],str) for key in value):
            raise ProjectError('添加工程只接受已选择的文件夹、名称和备注。')
        name=value['name'].strip(); description=value['description'].strip()
        if not 1<=len(name)<=80 or len(description)>240: raise ProjectError('名称需为 1–80 字，备注最多 240 字。')
        with self.lock:
            selected=self.selections.get(value['selection_token'])
            if not selected or time.monotonic()-selected['created']>=600: raise ProjectError('文件夹选择已过期，请重新选择。',409)
            path=Path(selected['path'])
            if not path.is_dir(): raise ProjectError('所选文件夹已不存在，请重新选择。')
            entries=self.entries()
            if any(self.path(entry)==path for entry in entries): raise ProjectError('这个工程目录已经登记，无需重复添加。',409)
            entry=dict(id='local-'+uuid.uuid4().hex[:12],name=name,subtitle=description or '本机工程',path=str(path),
                       color='blue',icon='git',tags=detect_tags(path),skills=[],created_at=datetime.now().astimezone().isoformat())
            local=[row for row in entries if row not in json.loads((self.root/'ui/projects.json').read_text())]
            self.registry.parent.mkdir(exist_ok=True)
            with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=self.registry.parent,delete=False) as handle:
                json.dump(local+[entry],handle,ensure_ascii=False,indent=2); handle.write('\n'); temporary=Path(handle.name)
            try:
                os.chmod(temporary,0o600); temporary.replace(self.registry)
            finally:
                temporary.unlink(missing_ok=True)
            del self.selections[value['selection_token']]
            return self.snapshot(entry)

    def details(self, project_id):
        entry=self.entry(project_id); path=self.path(entry); project=self.snapshot(entry)
        if not project['is_git']: raise ProjectError('当前目录未识别为 Git 工作区。',409)
        raw=git(path,'for-each-ref','--sort=refname','--format=%(refname)\t%(objectname:short)\t%(symref)','refs/heads','refs/remotes')
        trees=worktrees(path)
        if raw is None or trees is None: raise ProjectError('分支或工作树读取失败，请稍后重试。',503)
        branches=[]
        for line in raw.splitlines():
            ref,head,symref=line.split('\t',2)
            if symref: continue
            remote=ref.startswith('refs/remotes/')
            name=ref.removeprefix('refs/remotes/' if remote else 'refs/heads/')
            branches.append(dict(name=name,ref=ref,head=head,remote=remote,current=not remote and name==project['branch'],
                                 worktree_ids=[tree['id'] for tree in trees if not remote and tree['branch']==name]))
        return dict(project=project,branches=branches[:500],truncated=len(branches)>500,worktrees=trees,capabilities=self.capabilities())

    def open_sourcetree(self, value):
        if not isinstance(value,dict) or set(value)-{'project_id','worktree_id'} or not isinstance(value.get('project_id'),str) or ('worktree_id' in value and not isinstance(value['worktree_id'],str)):
            raise ProjectError('打开操作只接受已登记工程与工作树标识。')
        details=self.details(value['project_id']); path=details['project']['path']
        if value.get('worktree_id'):
            tree=next((tree for tree in details['worktrees'] if tree['id']==value['worktree_id']),None)
            if not tree or not tree['exists'] or tree['prunable']: raise ProjectError('对应工作树不可用，请刷新后重试。',409)
            path=tree['path']
        executable=self.sourcetree()
        if not executable: raise ProjectError('未找到 SourceTree，请安装后重新打开工作台。',503)
        try:
            subprocess.Popen([executable,path],cwd=path,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        except OSError:
            raise ProjectError('未能请求 SourceTree 打开此工程。',503)
        return dict(status='requested',path=path)
