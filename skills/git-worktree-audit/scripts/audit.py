#!/usr/bin/env python3
"""只读收集一个 Git common dir 下的分支、工作树及未提交内容。"""

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from datetime import datetime, timezone
import xml.etree.ElementTree as ET


def redact(value):
    return re.sub(r"(\w+://)[^/@\s]+@", r"\1<redacted>@", value)


def git(repo, *args):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", LC_ALL="C")
    result = subprocess.run(
        ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", str(repo), *args],
        capture_output=True, env=env, timeout=45,
    )
    if result.returncode:
        raise RuntimeError(redact(os.fsdecode(result.stderr).strip()))
    return result.stdout


def parse_worktrees(raw):
    result, item = [], {}
    for field in raw.split(b"\0"):
        if not field:
            if item:
                result.append(item)
                item = {}
            continue
        key, sep, value = field.partition(b" ")
        item[os.fsdecode(key)] = os.fsdecode(value) if sep else True
    if item:
        result.append(item)
    return result


def category(path):
    p = path.replace("\\", "/")
    parts = p.lower().split("/")
    name = parts[-1]
    if p.startswith("mainlog/") or ".idea" in parts and "shelf" in parts:
        return "本地证据或恢复资料"
    if name == ".env" or name.startswith(".env.") or name.endswith((".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".mobileprovision")):
        return "敏感文件待核实"
    if any(x in parts for x in ("build", "node_modules", ".dart_tool", ".gradle", ".kotlin", "pods", "deriveddata", "__pycache__")) or name.endswith((".apk", ".aab", ".ipa", ".xcarchive", ".salive")):
        return "生成物或本机状态"
    if name == "agents.md" or p.startswith((".agents/", ".cursor/", ".idea/", ".vscode/")):
        return "规则或工具配置待审查"
    return "业务或工程文件待审查"


def parse_status(raw):
    records, result, i = raw.split(b"\0"), [], 0
    conflicts = {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}
    while i < len(records):
        rec = records[i]
        i += 1
        if not rec:
            continue
        if len(rec) < 4 or rec[2:3] != b" ":
            raise ValueError("无法解析 Git status 记录")
        xy, path = rec[:2].decode("ascii"), os.fsdecode(rec[3:])
        item = {"status": xy, "path": path, "category_hint": category(path)}
        if "R" in xy or "C" in xy:
            if i >= len(records) or not records[i]:
                raise ValueError("重命名记录缺少原路径")
            item["original_path"] = os.fsdecode(records[i])
            i += 1
        item.update(untracked=xy == "??", staged=xy[0] not in " ?", unstaged=xy[1] not in " ?", conflict=xy in conflicts)
        result.append(item)
    return result


def count_files(files):
    return dict(total=len(files), tracked=sum(not x["untracked"] for x in files),
                **{k: sum(x[k] for x in files) for k in ("staged", "unstaged", "untracked", "conflict")})


def read_shelf(repo):
    root = repo / ".idea/shelf"
    if not root.is_dir():
        return []
    metadata, entries = {}, []
    for path in sorted(root.glob("*.xml")):
        try:
            node = ET.parse(path).getroot()
            opts = {x.get("name"): x.get("value", "") for x in node.findall("option")}
            patch = opts.get("PATH", "").replace("$PROJECT_DIR$", str(repo))
            if patch:
                if not Path(patch).is_absolute():
                    patch = str(repo / patch)
                metadata[str(Path(patch).resolve())] = {
                    "metadata_path": str(path), "description": opts.get("DESCRIPTION", ""),
                    "recycled": node.get("recycled") == "true", "to_delete": node.get("toDelete") == "true",
                }
        except (OSError, ET.ParseError) as exc:
            entries.append({"metadata_path": str(path), "error": str(exc)})
    patches = set(root.rglob("*.patch")) | {Path(x) for x in metadata}
    for path in sorted(patches):
        item = {"patch_path": str(path), **metadata.get(str(path.resolve()), {})}
        try:
            raw = path.read_bytes()
            item.update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(),
                        files=[line[7:] for line in raw.decode("utf-8", errors="replace").splitlines() if line.startswith("Index: ")])
            item["state"] = "recycled" if item.get("recycled") else "registered" if item.get("metadata_path") else "orphan_patch"
        except OSError as exc:
            item["error"] = str(exc)
        entries.append(item)
    return entries


def inspect_worktree(record, common):
    item = dict(record)
    repo = Path(record["worktree"])
    item["path"] = str(repo)
    item["branch"] = str(record.get("branch", "")).removeprefix("refs/heads/") or None
    if not repo.exists():
        item["state"] = "missing"
        return item
    if record.get("bare"):
        item["state"] = "bare"
        return item
    try:
        actual = Path(os.fsdecode(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")).strip()).resolve()
        if actual != common:
            raise RuntimeError("此目录当前关联到另一个 Git common dir")
        before = os.fsdecode(git(repo, "rev-parse", "HEAD")).strip()
        files = parse_status(git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all"))
        item.update(state="readable", files=files, counts=count_files(files), shelf=read_shelf(repo))
        item["head_at_scan"] = before
        after = os.fsdecode(git(repo, "rev-parse", "HEAD")).strip()
        item["head_changed_during_scan"] = before != after or before != record.get("HEAD")
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
        item.update(state="unreadable", error=redact(str(exc)))
    return item


def collect(repo):
    started = datetime.now(timezone.utc).isoformat()
    common = Path(os.fsdecode(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")).strip()).resolve()
    records = parse_worktrees(git(repo, "worktree", "list", "--porcelain", "-z"))
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        worktrees = list(pool.map(lambda row: inspect_worktree(row, common), records))
    refs = []
    fmt = "%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track)%00%(symref)%00%(subject)"
    for line in git(repo, "for-each-ref", "--format=" + fmt, "refs/heads", "refs/remotes").splitlines():
        ref, sha, upstream, track, symref, subject = os.fsdecode(line).split("\0", 5)
        local = ref.startswith("refs/heads/")
        row = dict(ref=ref, name=ref.removeprefix("refs/heads/" if local else "refs/remotes/"),
                   head=sha, upstream=upstream or None, track=track, symbolic_target=symref or None, last_subject=subject)
        row["worktrees"] = [w["path"] for w in worktrees if w.get("branch") == row["name"]] if local else []
        row["upstream_state"] = "missing" if "gone" in track else "configured" if upstream else "none"
        for kind in ("ahead", "behind"):
            match = re.search(r"\b" + kind + r" (\d+)", track)
            row[kind] = int(match.group(1)) if match else 0 if upstream and "gone" not in track else None
        refs.append(row)
    local_branches = [r for r in refs if r["ref"].startswith("refs/heads/")]
    remote_branches = [r for r in refs if r["ref"].startswith("refs/remotes/") and not r["symbolic_target"]]
    stash = []
    for line in git(repo, "stash", "list", "--format=%gd%x00%H%x00%gs").splitlines():
        ref, sha, subject = os.fsdecode(line).split("\0", 2)
        item = dict(ref=ref, head=sha, subject=subject)
        try:
            item["files"] = [os.fsdecode(p) for p in git(repo, "stash", "show", "--include-untracked", "--no-ext-diff", "--no-textconv", "--name-only", "-z", sha).split(b"\0") if p]
        except (RuntimeError, subprocess.TimeoutExpired) as exc:
            item["error"] = redact(str(exc))
        stash.append(item)
    remotes = []
    for remote in os.fsdecode(git(repo, "remote")).splitlines():
        url = os.fsdecode(git(repo, "remote", "get-url", remote)).strip()
        remotes.append(dict(name=remote, url=redact(url).split("?")[0].split("#")[0]))
    readable = [w for w in worktrees if w["state"] == "readable"]
    shelf = [s for w in readable for s in w["shelf"] if s.get("patch_path")]
    totals = {k: sum(w["counts"][k] for w in readable) for k in ("total", "tracked", "staged", "unstaged", "untracked", "conflict")}
    summary = dict(registered_worktrees=len(worktrees), readable_worktrees=len(readable),
                   missing_worktrees=sum(w["state"] == "missing" for w in worktrees),
                   unreadable_worktrees=sum(w["state"] == "unreadable" for w in worktrees),
                   bare_worktrees=sum(w["state"] == "bare" for w in worktrees),
                   dirty_worktrees=sum(bool(w["counts"]["total"]) for w in readable),
                   clean_worktrees=sum(not w["counts"]["total"] for w in readable),
                   detached_worktrees=sum(bool(w.get("detached")) for w in readable),
                   local_branches=len(local_branches), remote_tracking_branches=len(remote_branches),
                   local_branches_without_worktree=sum(not b["worktrees"] for b in local_branches),
                   ahead_of_upstream_branches=sum((b["ahead"] or 0) > 0 for b in local_branches),
                   stash_entries=len(stash), shelf_patch_files=len(shelf),
                   shelf_unique_payloads=len({s["sha256"] for s in shelf if s.get("sha256")}), file_counts=totals)
    return dict(schema_version=1, started_at=started, finished_at=datetime.now(timezone.utc).isoformat(),
                requested_repo=str(repo.resolve()), common_dir=str(common), network_refreshed=False,
                summary=summary, remotes=remotes, local_branches=local_branches,
                remote_tracking_branches=remote_branches, worktrees=worktrees, stash=stash)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path, help="完整 JSON 输出路径；建议使用仓库外的临时目录")
    args = parser.parse_args()
    try:
        result = collect(args.repo)
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
        parser.exit(1, "盘点失败：" + redact(str(exc)) + "\n")
    text = json.dumps(result, ensure_ascii=True, indent=2) + "\n"
    if args.output:
        args.output.write_text(text, encoding="utf-8")
        print(json.dumps(dict(output=str(args.output.resolve()), summary=result["summary"]), ensure_ascii=False))
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
