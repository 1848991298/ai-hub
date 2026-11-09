#!/usr/bin/env python3
"""在临时仓库验证计数、特殊路径、恢复资料和只读边界。"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import audit


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="worktree-audit-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "项目 空格"
        self.env = patch.dict(os.environ, {
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_AUTHOR_NAME": "Audit Test", "GIT_AUTHOR_EMAIL": "audit@example.test",
            "GIT_COMMITTER_NAME": "Audit Test", "GIT_COMMITTER_EMAIL": "audit@example.test",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.run_git("init", "--initial-branch=main", str(self.repo), cwd=self.root)
        (self.repo / "原名 space.txt").write_text("base\n")
        (self.repo / ".gitignore").write_text(".idea/\n")
        self.run_git("add", "原名 space.txt", ".gitignore")
        self.run_git("commit", "-m", "initial")

    def run_git(self, *args, cwd=None, check=True):
        return subprocess.run(["git", "--no-optional-locks", "-C", str(cwd or self.repo), *args],
                              capture_output=True, check=check).stdout

    def snapshot(self):
        return {"refs": self.run_git("show-ref"), "index": (self.repo / ".git/index").read_bytes(),
                "config": (self.repo / ".git/config").read_bytes(),
                "status": self.run_git("status", "--porcelain=v1", "-z", "-uall"),
                "stash": self.run_git("stash", "list", "--format=%H")}

    def test_real_worktrees_renames_stash_shelf_and_read_only(self):
        (self.repo / "原名 space.txt").write_text("stashed\n")
        (self.repo / "stash extra.txt").write_text("kept\n")
        self.run_git("stash", "push", "-u", "-m", "preserve")
        self.run_git("worktree", "add", "-b", "clean", str(self.root / "clean"))
        self.run_git("worktree", "add", "--detach", str(self.root / "detached"))
        self.run_git("worktree", "add", "--detach", str(self.root / "missing"))
        shutil.rmtree(self.root / "missing")
        self.run_git("mv", "原名 space.txt", "新名 space.txt")
        (self.repo / "新名 space.txt").write_text("base\nextra\n")
        (self.repo / "含 换\n行.txt").write_text("untracked\n")
        (self.repo / ".env").write_text("SUPER_SECRET_FILE_CONTENT=hidden\n")
        shelf = self.repo / ".idea/shelf"
        (shelf / "one").mkdir(parents=True)
        (shelf / "two").mkdir()
        payload = b"Index: kept.txt\n===\n"
        (shelf / "one/shelved.patch").write_bytes(payload)
        (shelf / "two/shelved.patch").write_bytes(payload)
        (shelf / "one.xml").write_text('<changelist toDelete="true"><option name="PATH" value="$PROJECT_DIR$/.idea/shelf/one/shelved.patch" /></changelist>')
        before = self.snapshot()
        result = audit.collect(self.repo)
        self.assertEqual(before, self.snapshot())
        s = result["summary"]
        self.assertEqual((s["registered_worktrees"], s["readable_worktrees"], s["missing_worktrees"]), (4, 3, 1))
        self.assertEqual((s["dirty_worktrees"], s["clean_worktrees"], s["detached_worktrees"]), (1, 2, 1))
        self.assertEqual((s["local_branches"], s["stash_entries"]), (2, 1))
        self.assertEqual((s["shelf_patch_files"], s["shelf_unique_payloads"]), (2, 1))
        self.assertEqual(s["file_counts"], dict(total=3, tracked=1, staged=1, unstaged=1, untracked=2, conflict=0))
        current = result["worktrees"][0]
        renamed = next(f for f in current["files"] if "original_path" in f)
        self.assertEqual((renamed["path"], renamed["original_path"]), ("新名 space.txt", "原名 space.txt"))
        self.assertIn("含 换\n行.txt", [f["path"] for f in current["files"]])
        self.assertEqual({x["state"] for x in current["shelf"]}, {"registered", "orphan_patch"})
        self.assertEqual(set(result["stash"][0]["files"]), {"原名 space.txt", "stash extra.txt"})
        self.assertNotIn("SUPER_SECRET_FILE_CONTENT", json.dumps(result))
        self.assertEqual((shelf / "one/shelved.patch").read_bytes(), payload)

    def test_conflict_is_reported_and_preserved(self):
        self.run_git("checkout", "-b", "side")
        (self.repo / "原名 space.txt").write_text("side\n")
        self.run_git("commit", "-am", "side")
        self.run_git("checkout", "main")
        (self.repo / "原名 space.txt").write_text("main\n")
        self.run_git("commit", "-am", "main")
        self.run_git("merge", "--no-commit", "side", check=False)
        before = self.snapshot()
        merge_head = (self.repo / ".git/MERGE_HEAD").read_bytes()
        result = audit.collect(self.repo)
        self.assertEqual(result["summary"]["file_counts"]["conflict"], 1)
        self.assertEqual(before, self.snapshot())
        self.assertEqual((self.repo / ".git/MERGE_HEAD").read_bytes(), merge_head)

    def test_upstream_counts_no_network_and_credential_redaction(self):
        self.run_git("remote", "add", "origin", "https://user:secret@example.invalid/repo.git?token=hidden")
        self.run_git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.run_git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
        self.run_git("branch", "--set-upstream-to=origin/main")
        (self.repo / "原名 space.txt").write_text("ahead\n")
        self.run_git("commit", "-am", "ahead")
        result = audit.collect(self.repo)
        self.assertFalse(result["network_refreshed"])
        self.assertEqual(result["summary"]["remote_tracking_branches"], 1)
        self.assertEqual(result["local_branches"][0]["ahead"], 1)
        self.assertNotIn("secret", json.dumps(result))
        self.assertNotIn("token=hidden", json.dumps(result))
        self.run_git("update-ref", "-d", "refs/remotes/origin/main")
        gone = audit.collect(self.repo)["local_branches"][0]
        self.assertEqual(gone["upstream_state"], "missing")
        self.assertIsNone(gone["ahead"])


if __name__ == "__main__":
    unittest.main()
