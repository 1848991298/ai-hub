"""台账本机持久队列：先提交 SQLite，再异步写飞书；不保存凭据。"""
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


class TrackerOutbox:
    def __init__(self, root):
        directory = Path(root) / '.local'
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / 'tracker-outbox.sqlite'
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
            db.execute('''CREATE TABLE IF NOT EXISTS jobs (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                target TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
                error TEXT, status INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL)''')
            # 更新可按目标值读回恢复；中断的新建不能盲目重发，避免重复记录。
            db.execute("UPDATE jobs SET state='pending' WHERE state='writing' AND json_extract(payload,'$.operation')='update'")
            db.execute("""UPDATE jobs SET state='uncertain', error='新建结果尚未确认，请先核对飞书，避免重复新建。', status=409
                          WHERE state='writing'""")
        os.chmod(self.path, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def cached(self):
        with self.connect() as db:
            row = db.execute("SELECT value FROM cache WHERE key='snapshot'").fetchone()
        return json.loads(row['value']) if row else None

    def cache(self, value):
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO cache VALUES ('snapshot',?)", (json.dumps(value, ensure_ascii=False),))

    @staticmethod
    def decode(row):
        if not row:
            return None
        value = dict(row)
        value['payload'] = json.loads(value['payload'])
        return value

    def jobs(self):
        with self.connect() as db:
            return [self.decode(row) for row in db.execute("SELECT * FROM jobs WHERE state NOT IN ('done','discarded') ORDER BY seq")]

    def get(self, job_id):
        with self.connect() as db:
            return self.decode(db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone())

    def enqueue(self, items, supersedes=None):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if supersedes:
                old = db.execute('SELECT * FROM jobs WHERE id=?', (supersedes,)).fetchone()
                if not old or old['state'] not in ('failed', 'uncertain'):
                    raise ValueError('原修改已变化，请刷新后再编辑。')
                old_payload = json.loads(old['payload'])
                same_create = len(items) == 1 and old_payload['operation'] == items[0]['payload']['operation'] == 'create' and old_payload['body']['kind'] == items[0]['payload']['body']['kind']
                if len(items) != 1 or (old['target'] != items[0]['target'] and not same_create):
                    raise ValueError('只能替换同一条记录的失败修改。')
                db.execute("UPDATE jobs SET state='discarded',updated_at=? WHERE id=?", (stamp(), supersedes))
            for item in items:
                raw = json.dumps(item['payload'], ensure_ascii=False, sort_keys=True)
                existing = db.execute('SELECT payload FROM jobs WHERE id=?', (item['id'],)).fetchone()
                if existing:
                    if existing['payload'] != raw:
                        raise ValueError('这次操作编号已用于不同内容，请重新打开后保存。')
                    continue
                current = stamp()
                db.execute('INSERT INTO jobs(id,target,payload,state,created_at,updated_at) VALUES (?,?,?,?,?,?)',
                           (item['id'], item['target'], raw, 'pending', current, current))

    def claim(self):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            # 同一记录按顺序执行；前一项失败时，后续项保留等待，其他记录可继续。
            row = db.execute("""SELECT j.* FROM jobs j WHERE j.state='pending' AND NOT EXISTS (
                SELECT 1 FROM jobs older WHERE older.target=j.target AND older.seq<j.seq
                AND older.state IN ('pending','writing','failed','uncertain')) ORDER BY j.seq LIMIT 1""").fetchone()
            if not row:
                return None
            db.execute("UPDATE jobs SET state='writing',attempts=attempts+1,updated_at=? WHERE id=?", (stamp(), row['id']))
            value = self.decode(row)
            value['state'] = 'writing'
            return value

    def finish(self, job_id, state='done', error=None, status=None):
        with self.connect() as db:
            db.execute('UPDATE jobs SET state=?,error=?,status=?,updated_at=? WHERE id=?', (state, error, status, stamp(), job_id))
            db.execute("DELETE FROM jobs WHERE state IN ('done','discarded') AND seq NOT IN (SELECT seq FROM jobs ORDER BY seq DESC LIMIT 200)")

    def retry(self, job_id):
        with self.connect() as db:
            row = db.execute('SELECT state FROM jobs WHERE id=?', (job_id,)).fetchone()
            if not row or row['state'] != 'failed':
                raise ValueError('这项操作不能直接重试，请先核对结果或继续编辑。')
            db.execute("UPDATE jobs SET state='pending',error=NULL,status=NULL,updated_at=? WHERE id=?", (stamp(), job_id))

    def discard(self, job_id):
        with self.connect() as db:
            row = db.execute('SELECT state FROM jobs WHERE id=?', (job_id,)).fetchone()
            if not row or row['state'] not in ('failed', 'uncertain', 'pending'):
                raise ValueError('这项操作已经在写入或已完成，请刷新后核对。')
            db.execute("UPDATE jobs SET state='discarded',updated_at=? WHERE id=?", (stamp(), job_id))
