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
            db.execute('BEGIN IMMEDIATE')
            if 'applied_record_id' not in {row['name'] for row in db.execute('PRAGMA table_info(jobs)')}:
                db.execute('ALTER TABLE jobs ADD COLUMN applied_record_id TEXT')
            db.execute('''CREATE TABLE IF NOT EXISTS staged_images (
                id TEXT PRIMARY KEY, job_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL,
                data BLOB NOT NULL, created_at TEXT NOT NULL)''')
            db.execute('CREATE INDEX IF NOT EXISTS staged_images_job ON staged_images(job_id)')
            # 更新和删除可读回核对；尚未拿到记录编号的新建不能盲目重发。
            db.execute("""UPDATE jobs SET state='pending' WHERE state='writing'
                          AND (json_extract(payload,'$.operation') IN ('update','delete') OR applied_record_id IS NOT NULL)""")
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
            return [self.decode(row) for row in db.execute("""SELECT j.*,
                (SELECT count(*) FROM staged_images WHERE job_id=j.id) AS pending_images
                FROM jobs j WHERE state NOT IN ('done','discarded') ORDER BY seq""")]

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
                if old['applied_record_id']:
                    raise ValueError('文字已同步，请重试尚未同步的截图。')
                old_payload = json.loads(old['payload'])
                if old_payload['operation'] == 'delete' or any(item['payload']['operation'] == 'delete' for item in items):
                    raise ValueError('请先取消之前的操作，再重新确认删除。')
                same_create = len(items) == 1 and old_payload['operation'] == items[0]['payload']['operation'] == 'create' and old_payload['body']['kind'] == items[0]['payload']['body']['kind']
                if len(items) != 1 or (old['target'] != items[0]['target'] and not same_create):
                    raise ValueError('只能替换同一条记录的失败修改。')
                carried = [row['id'] for row in db.execute('SELECT id FROM staged_images WHERE job_id=?', (supersedes,))]
                if carried:
                    payload = items[0]['payload']
                    payload['image_ids'] = list(dict.fromkeys(carried + payload.get('image_ids', [])))
                db.execute("UPDATE jobs SET state='discarded',updated_at=? WHERE id=?", (stamp(), supersedes))
            for item in items:
                raw = json.dumps(item['payload'], ensure_ascii=False, sort_keys=True)
                existing = db.execute('SELECT payload FROM jobs WHERE id=?', (item['id'],)).fetchone()
                if existing:
                    if existing['payload'] != raw:
                        raise ValueError('这次操作编号已用于不同内容，请重新打开后保存。')
                    continue
                operation = item['payload']['operation']
                if operation == 'delete':
                    body = item['payload']['body']
                    targets = [item['target'], *item.get('create_targets', [])]
                    placeholders = ','.join('?' for _ in targets)
                    active = db.execute(f"""SELECT 1 FROM jobs WHERE state NOT IN ('done','discarded') AND
                        (target IN ({placeholders}) OR
                         (applied_record_id=? AND json_extract(payload,'$.body.kind')=?)) LIMIT 1""",
                        (*targets, body['record_id'], body['kind'])).fetchone()
                    if active:
                        raise ValueError('这条记录还有待处理的同步操作，请处理后再删除。')
                elif operation == 'update' and db.execute("""SELECT 1 FROM jobs WHERE target=?
                    AND state NOT IN ('done','discarded') AND json_extract(payload,'$.operation')='delete' LIMIT 1""",
                    (item['target'],)).fetchone():
                    raise ValueError('这条记录有待处理的删除，请先处理删除请求。')
                current = stamp()
                db.execute('INSERT INTO jobs(id,target,payload,state,created_at,updated_at) VALUES (?,?,?,?,?,?)',
                           (item['id'], item['target'], raw, 'pending', current, current))
                for image_id in item['payload'].get('image_ids', []):
                    image = db.execute('SELECT job_id FROM staged_images WHERE id=?', (image_id,)).fetchone()
                    if not image or image['job_id'] not in (None, supersedes):
                        raise ValueError('截图暂存已变化，请重新选择后保存。')
                    db.execute('UPDATE staged_images SET job_id=? WHERE id=?', (item['id'], image_id))

    def stage_image(self, image_id, name, mime, data):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute("DELETE FROM staged_images WHERE job_id IS NULL AND julianday(created_at) < julianday('now','-1 day')")
            old = db.execute('SELECT name,mime,data FROM staged_images WHERE id=?', (image_id,)).fetchone()
            if old:
                if (old['name'], old['mime'], old['data']) != (name, mime, data):
                    raise ValueError('截图编号已占用，请重新添加图片。')
                return
            db.execute('INSERT INTO staged_images(id,name,mime,data,created_at) VALUES (?,?,?,?,?)',
                       (image_id, name, mime, data, stamp()))

    def record_applied(self, job_id, record_id):
        with self.connect() as db:
            db.execute('UPDATE jobs SET applied_record_id=? WHERE id=?', (record_id, job_id))

    def images(self, job_id):
        with self.connect() as db:
            return [dict(row) for row in db.execute('SELECT id,name,mime FROM staged_images WHERE job_id=? ORDER BY rowid', (job_id,))]

    def image_bytes(self, image_id):
        with self.connect() as db:
            return db.execute('SELECT data FROM staged_images WHERE id=?', (image_id,)).fetchone()['data']

    def finish_image(self, image_id):
        with self.connect() as db:
            db.execute('DELETE FROM staged_images WHERE id=?', (image_id,))

    def claim(self):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            # 同一记录按顺序执行；前一项失败时，后续项保留等待，其他记录可继续。
            row = db.execute("""SELECT j.* FROM jobs j WHERE j.state='pending' AND NOT EXISTS (
                SELECT 1 FROM jobs older WHERE older.target=j.target AND older.seq<j.seq
                AND older.state IN ('pending','writing','failed','uncertain')
                AND (older.applied_record_id IS NULL OR older.state != 'failed')) ORDER BY j.seq LIMIT 1""").fetchone()
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
            changed = db.execute("""UPDATE jobs SET state='pending',error=NULL,status=NULL,updated_at=?
                WHERE id=? AND state='failed'""", (stamp(), job_id))
            if not changed.rowcount:
                raise ValueError('这项操作不能直接重试，请先核对结果或继续编辑。')

    def discard(self, job_id):
        with self.connect() as db:
            changed = db.execute("""UPDATE jobs SET state='discarded',updated_at=?
                WHERE id=? AND state IN ('failed','uncertain','pending')""", (stamp(), job_id))
            if not changed.rowcount:
                raise ValueError('这项操作已经在写入或已完成，请刷新后核对。')
            db.execute('DELETE FROM staged_images WHERE job_id=?', (job_id,))
