"""SQLite accounts, owned records and controlled PDF storage.

All existing-paper operations enter Workspace; callers never supply file paths.
The original App binds its existing workspaces through database.Database.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

MAX_PDF = 20_000_000
ACTIVE = ('queued', 'running')


class Problem(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def ident():
    return secrets.token_hex(16)


def encoded(value):
    return json.dumps(value, ensure_ascii=False)


def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)


class DataLease:
    """Prevent a second server from interrupting sessions/tasks in a live store."""
    def __init__(self,root):
        root=Path(root).resolve()
        root.mkdir(parents=True,exist_ok=True)
        self.file=(root/'.runtime.lock').open('a+b')
        try:
            if os.name=='nt':
                import msvcrt
                self.file.write(b'0');self.file.flush();self.file.seek(0)
                msvcrt.locking(self.file.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise Problem('该数据目录正在被另一实例使用，请复用现有App或选择独立数据目录',409) from None

    def close(self):
        if self.file.closed:return
        if os.name=='nt':
            import msvcrt
            self.file.seek(0);msvcrt.locking(self.file.fileno(),msvcrt.LK_UNLCK,1)
        else:
            import fcntl
            fcntl.flock(self.file.fileno(),fcntl.LOCK_UN)
        self.file.close()


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.files = self.root / 'papers'
        self.files.mkdir(exist_ok=True)
        self.db = self.root / 'easyread.sqlite3'
        with self.connect() as c:
            c.execute('PRAGMA journal_mode=WAL')
            c.executescript('''
            CREATE TABLE IF NOT EXISTS users(
                id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                salt BLOB NOT NULL, password BLOB NOT NULL, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions(
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                csrf TEXT NOT NULL, expires REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS consents(
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                fingerprint TEXT NOT NULL, scope TEXT NOT NULL,
                PRIMARY KEY(session_id,fingerprint,scope));
            CREATE TABLE IF NOT EXISTS papers(
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                sha256 TEXT NOT NULL, filename TEXT NOT NULL, title TEXT NOT NULL,
                authors TEXT NOT NULL DEFAULT '', year TEXT NOT NULL DEFAULT '',
                metadata_complete INTEGER NOT NULL DEFAULT 0,
                created REAL NOT NULL, parse_state TEXT NOT NULL DEFAULT 'pending',
                parse_error TEXT NOT NULL DEFAULT '', pages TEXT NOT NULL DEFAULT '[]',
                parsed_sha TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
                note_revision INTEGER NOT NULL DEFAULT 0,
                delete_state TEXT NOT NULL DEFAULT '', delete_error TEXT NOT NULL DEFAULT '');
            CREATE TABLE IF NOT EXISTS tags(
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                name TEXT NOT NULL, normalized TEXT NOT NULL, UNIQUE(user_id,normalized));
            CREATE TABLE IF NOT EXISTS paper_tags(
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY(paper_id,tag_id));
            CREATE TABLE IF NOT EXISTS reports(
                paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
                id TEXT NOT NULL UNIQUE, result TEXT NOT NULL, saved REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS tasks(
                id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT NOT NULL,
                kind TEXT NOT NULL, state TEXT NOT NULL, stage TEXT NOT NULL,
                error TEXT NOT NULL DEFAULT '', question TEXT NOT NULL DEFAULT '',
                retry_of TEXT NOT NULL DEFAULT '', expected_report TEXT NOT NULL DEFAULT '',
                input_sha TEXT NOT NULL DEFAULT '', created REAL NOT NULL,
                generated REAL, saved REAL, finished REAL);
            CREATE UNIQUE INDEX IF NOT EXISTS one_active_paper_task ON tasks(paper_id)
                WHERE state IN ('queued','running');
            CREATE TABLE IF NOT EXISTS candidates(
                task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
                result TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS papers_owner ON papers(user_id);
            CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(user_id,paper_id,created);
            ''')
            for table,name,definition in (
                ('users','prefs',"TEXT NOT NULL DEFAULT '{}'"),
                ('papers','legacy_item',"TEXT NOT NULL DEFAULT '{}'"),
                ('papers','reader',"TEXT NOT NULL DEFAULT '{}'")):
                if name not in {r['name'] for r in c.execute(f'PRAGMA table_info({table})')}:
                    c.execute(f'ALTER TABLE {table} ADD COLUMN {name} {definition}')
        os.chmod(self.db, 0o600)
        os.chmod(self.root, 0o700)

    @contextmanager
    def connect(self):
        c = sqlite3.connect(self.db, timeout=5, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute('PRAGMA foreign_keys=ON')
        try:
            yield c
        finally:
            c.close()

    @contextmanager
    def transaction(self):
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            try:
                yield c
                c.commit()
            except BaseException:
                c.rollback()
                raise

    def register(self, username, password):
        if not isinstance(username, str) or not re.fullmatch(r'[A-Za-z0-9_]{3,20}', username):
            raise Problem('用户名须为3—20位英文字母、数字或下划线')
        if not isinstance(password, str) or not 8 <= len(password) <= 64:
            raise Problem('密码须为8—64位')
        salt, uid = secrets.token_bytes(16), ident()
        derived = password_hash(password, salt)
        try:
            with self.transaction() as c:
                c.execute('INSERT INTO users(id,username,salt,password,created) VALUES(?,?,?,?,?)', (uid, username, salt, derived, time.time()))
        except sqlite3.IntegrityError:
            raise Problem('用户名已存在（不区分大小写）', 409) from None
        return {'id': uid, 'username': username}

    def login(self, username, password):
        if not isinstance(username, str) or not isinstance(password, str) or len(password) > 64:
            raise Problem('账号或密码错误', 401)
        with self.connect() as c:
            u = c.execute('SELECT * FROM users WHERE username=? COLLATE NOCASE', (username,)).fetchone()
        derived = password_hash(password, u['salt'] if u else b'0' * 16)
        if not u or not hmac.compare_digest(derived, u['password']):
            raise Problem('账号或密码错误', 401)
        sid, csrf = ident() + ident(), ident()
        with self.transaction() as c:
            c.execute('INSERT INTO sessions VALUES(?,?,?,?,1)', (sid, u['id'], csrf, time.time()+86400))
        return self.session(sid)

    def session(self, sid):
        with self.connect() as c:
            s = c.execute('''SELECT s.*,u.username FROM sessions s JOIN users u ON s.user_id=u.id
                WHERE s.id=? AND active=1 AND expires>?''', (sid or '', time.time())).fetchone()
        if not s:
            raise Problem('请重新登录', 401)
        return dict(s)

    def logout(self, sid):
        with self.transaction() as c:
            c.execute('UPDATE sessions SET active=0 WHERE id=?', (sid,))
            c.execute('DELETE FROM consents WHERE session_id=?', (sid,))

    def consent(self, session, fingerprint, scope):
        with self.transaction() as c:
            self._live_session(c, session)
            c.execute('INSERT OR IGNORE INTO consents VALUES(?,?,?)', (session['id'], fingerprint, scope))

    def require_consent(self, session, fingerprint, scope):
        with self.connect() as c:
            self._live_session(c, session)
            ok = c.execute('SELECT 1 FROM consents WHERE session_id=? AND fingerprint=? AND scope=?',
                           (session['id'], fingerprint, scope)).fetchone()
        if not ok:
            raise Problem('尚未同意本次登录的服务及发送范围，请查看调用说明', 403)

    @staticmethod
    def _live_session(c, session):
        if not c.execute('SELECT 1 FROM sessions WHERE id=? AND user_id=? AND active=1 AND expires>?',
                         (session['id'], session['user_id'], time.time())).fetchone():
            raise Problem('本次登录已结束，停止后续调用；已发送的请求可能仍计费', 401)

    def workspace(self, user_id, paper_id):
        ws = Workspace(self, user_id, paper_id)
        ws.row()
        return ws

    def list(self, user_id, keyword='', tag=''):
        # Python casefold also gives consistent Unicode comparison on SQLite builds without ICU.
        with self.connect() as c:
            rows = c.execute('SELECT * FROM papers WHERE user_id=? ORDER BY created DESC,id', (user_id,)).fetchall()
            tags = c.execute('''SELECT pt.paper_id,t.id,t.name FROM paper_tags pt JOIN tags t ON pt.tag_id=t.id
                WHERE t.user_id=?''', (user_id,)).fetchall()
        by_paper = {}
        for t in tags:
            by_paper.setdefault(t['paper_id'], []).append({'id': t['id'], 'name': t['name']})
        result = []
        for r in rows:
            item = self.summary(r)
            item['tags'] = by_paper.get(r['id'], [])
            if keyword.casefold() not in r['title'].casefold() and keyword.casefold() not in r['authors'].casefold():
                continue
            if tag and tag not in {t['id'] for t in item['tags']}:
                continue
            result.append(item)
        return result

    @staticmethod
    def summary(row):
        return {k: row[k] for k in ('id','filename','title','authors','year','created','parse_state',
            'parse_error','metadata_complete','delete_state','delete_error')}

    def tags(self, user_id):
        with self.connect() as c:
            return [dict(t) for t in c.execute('SELECT id,name FROM tags WHERE user_id=? ORDER BY name', (user_id,))]

    def create(self, user_id, data, filename):
        if len(data) > MAX_PDF:
            raise Problem('PDF上限为20,000,000字节', 413)
        if not data.startswith(b'%PDF-'):
            raise Problem('不是可识别的PDF文件；未入库')
        sha, pid = hashlib.sha256(data).hexdigest(), ident()
        filename = Path(str(filename).replace('\\','/')).name[:200] or 'paper.pdf'
        directory = self.files / pid
        # Files and registration are coordinated; registration failure never advertises an import.
        created=False
        try:
            with self.transaction() as c:
                existing = c.execute('SELECT id FROM papers WHERE user_id=? AND sha256=?', (user_id,sha)).fetchone()
                if existing:return self.workspace(user_id,existing['id']), False
                directory.mkdir(mode=0o700)
                created=True
                pdf = directory / 'source.pdf'
                with pdf.open('xb') as f:
                    f.write(data)
                    f.flush()
                    os.fsync(f.fileno())
                c.execute('''INSERT INTO papers(id,user_id,sha256,filename,title,created)
                    VALUES(?,?,?,?,?,?)''', (pid,user_id,sha,filename,Path(filename).stem,time.time()))
        except BaseException:
            if created:shutil.rmtree(directory, ignore_errors=True)
            raise
        return self.workspace(user_id,pid), True

    def interrupt(self):
        with self.transaction() as c:
            c.execute("UPDATE tasks SET state='interrupted',stage='interrupted',error=?,finished=? WHERE state IN ('queued','running')",
                      ('应用重启，任务已中断；未自动恢复。可手动重试，AI重试可能再次收费',time.time()))
            c.execute("UPDATE papers SET parse_state='interrupted',parse_error='解析被应用重启中断，可原记录重试' WHERE parse_state='running'")
            c.execute('UPDATE sessions SET active=0')
            c.execute('DELETE FROM consents')


class Workspace:
    def __init__(self, store, user_id, paper_id):
        self.store, self.user_id, self.id = store, user_id, paper_id

    def row(self, c=None):
        if c is None:
            with self.store.connect() as conn:
                return self.row(conn)
        r = c.execute('SELECT * FROM papers WHERE id=? AND user_id=?', (self.id,self.user_id)).fetchone()
        if not r:
            raise Problem('论文不存在或无权访问',404)
        return r

    def pdf(self, verify=True):
        row = self.row()
        directory=self.store.source_directory(self.user_id,self.id) if hasattr(self.store,'source_directory') else self.store.files/self.id
        path = directory / 'source.pdf'
        if not path.is_file() or path.is_symlink():
            raise Problem('原PDF无法打开：文件缺失；记录仍保留',409)
        data = path.read_bytes()
        if verify and hashlib.sha256(data).hexdigest() != row['sha256']:
            raise Problem('PDF内容身份不符；已保存记录保留，引用跳转已停用',409)
        return data

    def state(self):
        with self.store.connect() as c:
            r = self.row(c)
            report = c.execute('SELECT * FROM reports WHERE paper_id=?',(self.id,)).fetchone()
            tasks = c.execute('SELECT * FROM tasks WHERE paper_id=? AND user_id=? ORDER BY created,id',
                              (self.id,self.user_id)).fetchall()
            result = {**self.store.summary(r), 'sha256':r['sha256'], 'page_count':len(json.loads(r['pages'])),
                      'note':r['note'], 'note_revision':r['note_revision'], 'tasks':[dict(t) for t in tasks],
                      'report':{'id':report['id'],'saved':report['saved'],'result':json.loads(report['result'])} if report else None}
            for task in result['tasks']:
                cand = c.execute('SELECT result FROM candidates WHERE task_id=?',(task['id'],)).fetchone()
                if cand:
                    task['result'] = json.loads(cand['result'])
            return result

    def metadata(self, body):
        vals = [str(body.get(k,'')).strip() for k in ('title','authors','year')]
        if not vals[0] or len(vals[0]) > 500 or len(vals[1]) > 1000 or (vals[2] and not re.fullmatch(r'\d{4}',vals[2])):
            raise Problem('题名不能为空且不超过500字；作者不超过1000字；年份留空或为4位数字')
        with self.store.transaction() as c:
            self.mutable(c)
            c.execute('UPDATE papers SET title=?,authors=?,year=?,metadata_complete=1 WHERE id=? AND user_id=?',
                      (*vals,self.id,self.user_id))

    def note(self, body, revision):
        if not isinstance(body,str) or len(body) > 200_000:
            raise Problem('笔记须为文字且不超过200,000字')
        with self.store.transaction() as c:
            r = self.mutable(c)
            if revision != r['note_revision']:
                raise Problem('笔记已在其他页面更新；当前编辑内容保留，请重新打开核对后保存',409)
            c.execute('UPDATE papers SET note=?,note_revision=note_revision+1 WHERE id=? AND user_id=?',
                      (body,self.id,self.user_id))
        return revision+1

    def mutable(self,c):
        row = self.row(c)
        if row['delete_state']:
            raise Problem('论文删除未完成，请继续删除；其他修改暂不可用',409)
        return row

    def tag(self, name, remove=False):
        name = str(name).strip()
        if not name or len(name) > 60:
            raise Problem('标签须为1—60字')
        norm = name.casefold()
        with self.store.transaction() as c:
            self.mutable(c)
            t = c.execute('SELECT id FROM tags WHERE user_id=? AND normalized=?',(self.user_id,norm)).fetchone()
            if remove:
                if t:
                    c.execute('DELETE FROM paper_tags WHERE paper_id=? AND tag_id=?',(self.id,t['id']))
            else:
                tid = t['id'] if t else ident()
                if not t:
                    c.execute('INSERT INTO tags VALUES(?,?,?,?)',(tid,self.user_id,name,norm))
                c.execute('INSERT OR IGNORE INTO paper_tags VALUES(?,?)',(self.id,tid))
        return self.store.tags(self.user_id)

    def task(self, task_id, c=None):
        if c is None:
            with self.store.connect() as conn:
                return self.task(task_id,conn)
        self.row(c)
        t = c.execute('SELECT * FROM tasks WHERE id=? AND paper_id=? AND user_id=?',
                      (task_id,self.id,self.user_id)).fetchone()
        if not t:
            raise Problem('任务不存在或无权访问',404)
        return dict(t)

    def start(self, session, kind, question='', retry_of='', expected_report=''):
        tid = ident()
        with self.store.transaction() as c:
            row = self.mutable(c)
            self.store._live_session(c,session)
            active = c.execute("SELECT id FROM tasks WHERE paper_id=? AND state IN ('queued','running')",(self.id,)).fetchone()
            if active:
                raise Problem('这篇论文正在处理，请等待当前任务结束',409)
            if kind in ('report','qa') and row['parse_state'] != 'ready':
                raise Problem('解析尚未成功，报告和问答暂不可用；可阅读原PDF、改信息、记笔记或重试解析',409)
            if retry_of:
                old = self.task(retry_of,c)
                if old['kind'] != kind or old['state'] not in ('failed','interrupted'):
                    raise Problem('只能重试同类型的失败或中断任务',409)
                if kind == 'qa':
                    question = old['question']
            if kind == 'report':
                report = c.execute('SELECT id FROM reports WHERE paper_id=?',(self.id,)).fetchone()
                if (report['id'] if report else '') != expected_report:
                    raise Problem('请先确认替换最近成功报告，再重新发起',409)
            c.execute('''INSERT INTO tasks(id,paper_id,user_id,session_id,kind,state,stage,question,retry_of,expected_report,input_sha,created)
                VALUES(?,?,?,?,?,'queued','queued',?,?,?,?,?)''',
                (tid,self.id,self.user_id,session['id'],kind,question,retry_of,expected_report,row['sha256'],time.time()))
            if kind == 'parse':
                c.execute("UPDATE papers SET parse_state='running',parse_error='' WHERE id=? AND user_id=?",(self.id,self.user_id))
        return tid

    def task_state(self, tid, state, stage, error=''):
        with self.store.transaction() as c:
            self.task(tid,c)
            c.execute('UPDATE tasks SET state=?,stage=?,error=?,finished=? WHERE id=? AND user_id=?',
                      (state,stage,error,time.time() if state not in ACTIVE else None,tid,self.user_id))

    def parsed(self, tid, pages):
        self.pdf()
        with self.store.transaction() as c:
            t = self.task(tid,c)
            row = self.mutable(c)
            if t['input_sha'] != row['sha256']:
                raise Problem('解析输入身份不符',409)
            c.execute("UPDATE papers SET pages=?,parsed_sha=?,parse_state='ready',parse_error='' WHERE id=? AND user_id=?",
                      (encoded(pages),row['sha256'],self.id,self.user_id))
            c.execute("UPDATE tasks SET state='completed',stage='saved',finished=?,saved=? WHERE id=? AND user_id=?",
                      (time.time(),time.time(),tid,self.user_id))

    def parse_failed(self, tid, message):
        with self.store.transaction() as c:
            self.task(tid,c)
            c.execute("UPDATE papers SET parse_state='failed',parse_error=? WHERE id=? AND user_id=?",(message,self.id,self.user_id))
            c.execute("UPDATE tasks SET state='failed',stage='parse',error=?,finished=? WHERE id=? AND user_id=?",
                      (message,time.time(),tid,self.user_id))

    def input(self):
        self.pdf()
        row = self.row()
        if row['parse_state'] != 'ready' or row['parsed_sha'] != row['sha256']:
            raise Problem('逐页解析未就绪或输入身份不符',409)
        return json.loads(row['pages']),row['sha256']

    def candidate(self, tid, result):
        with self.store.transaction() as c:
            t = self.task(tid,c)
            if t['state'] == 'completed':
                return
            c.execute('INSERT OR REPLACE INTO candidates VALUES(?,?)',(tid,encoded(result)))
            c.execute("UPDATE tasks SET state='save_failed',stage='candidate',generated=?,error=? WHERE id=? AND user_id=?",
                      (time.time(),'生成完成，尚未保存为正式结果；再次保存不调用AI',tid,self.user_id))

    def commit_result(self, tid):
        self.pdf()
        with self.store.transaction() as c:
            row = self.mutable(c)
            t = self.task(tid,c)
            if t['state'] == 'completed':
                return
            if t['state'] != 'save_failed':
                raise Problem('尚无完整的待保存结果',409)
            cand = c.execute('SELECT result FROM candidates WHERE task_id=?',(tid,)).fetchone()
            if not cand or row['sha256'] != t['input_sha']:
                raise Problem('候选结果缺失或输入身份变化，未替换旧数据',409)
            if t['kind'] == 'report':
                old = c.execute('SELECT id FROM reports WHERE paper_id=?',(self.id,)).fetchone()
                if (old['id'] if old else '') != t['expected_report']:
                    raise Problem('最近报告已变化，不能静默覆盖；请核对后重新生成',409)
                c.execute('INSERT OR REPLACE INTO reports VALUES(?,?,?,?)',(self.id,tid,cand['result'],time.time()))
                # Keep one successful report; task metadata stays, prior generated contents do not.
                c.execute("DELETE FROM candidates WHERE task_id IN (SELECT id FROM tasks WHERE paper_id=? AND kind='report' AND id<>? AND state='completed')",(self.id,tid))
            c.execute("UPDATE tasks SET state='completed',stage='saved',error='',saved=?,finished=? WHERE id=? AND user_id=?",
                      (time.time(),time.time(),tid,self.user_id))

    def delete(self):
        if hasattr(self.store,'delete_paper'):
            return self.store.delete_paper(self.user_id,self.id)
        with self.store.transaction() as c:
            self.row(c)
            if c.execute("SELECT 1 FROM tasks WHERE paper_id=? AND state IN ('queued','running')",(self.id,)).fetchone():
                raise Problem('解析、报告或问答正在处理，结束后才能删除',409)
            c.execute("UPDATE papers SET delete_state='incomplete',delete_error='正在删除原PDF及关联记录' WHERE id=? AND user_id=?",(self.id,self.user_id))
        try:
            directory = self.store.files / self.id
            if directory.exists():
                shutil.rmtree(directory)
            with self.store.transaction() as c:
                self.row(c)
                c.execute('DELETE FROM papers WHERE id=? AND user_id=?',(self.id,self.user_id))
        except Exception:
            with self.store.transaction() as c:
                self.row(c)
                c.execute("UPDATE papers SET delete_error=? WHERE id=? AND user_id=?",
                          ('删除未完成；仍保留论文登记和未删除关联记录，请再次删除',self.id,self.user_id))
            raise Problem('删除未完成，论文登记仍保留；请再次删除以清理残留',409) from None
