"""SQLite persistence and ownership beneath the existing EasyRead workspaces.

The HTTP layer obtains a user-scoped Library. Existing reader/translation code
continues using Workspace and JSON-shaped records; SQLite owns their committed
structured values and the existing files remain compatible mirrors.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from .account_store import Store,Problem,encoded,ident

_BACKENDS=[]
_BACKENDS_LOCK=threading.RLock()
_SNAPSHOT=ContextVar('easyread_document_snapshot',default=None)

def request_cached(key,read):
    snapshot=_SNAPSHOT.get()
    if not snapshot:return read()
    memo=snapshot.setdefault('memo',{})
    if key not in memo:memo[key]=read()
    return memo[key]


def backend_for(path):
    snapshot=_SNAPSHOT.get()
    if snapshot and str(path) in snapshot['documents']:return snapshot['backend']
    path=Path(path).resolve()
    if path.suffix!='.json':return None
    with _BACKENDS_LOCK:
        for backend in _BACKENDS:
            if backend.owner_for_path(path):return backend
    return None


def mount(backend):
    with _BACKENDS_LOCK:
        if backend not in _BACKENDS:_BACKENDS.append(backend)


def unmount(backend):
    with _BACKENDS_LOCK:
        if backend in _BACKENDS:_BACKENDS.remove(backend)


class Database(Store):
    def __init__(self,root,legacy_home):
        super().__init__(root)
        self.legacy_home=Path(legacy_home).resolve()
        self._roots={};self._roots_lock=threading.RLock()
        self._document_lock=threading.RLock()
        with self.connect() as c:
            c.executescript('''
            CREATE TABLE IF NOT EXISTS resources(
                user_id TEXT NOT NULL REFERENCES users(id), id TEXT NOT NULL,
                directory TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'paper',
                PRIMARY KEY(user_id,id));
            CREATE TABLE IF NOT EXISTS document_roots(
                directory TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id));
            CREATE TABLE IF NOT EXISTS documents(
                path TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),
                value TEXT NOT NULL,updated REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS application(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            ''')
            for r in c.execute('SELECT directory,user_id FROM document_roots'):
                self._roots[Path(r['directory'])]=r['user_id']
        mount(self)

    def close(self):unmount(self)

    @contextmanager
    def document_snapshot(self,uid):
        # One bulk read per library request replaces hundreds of SQLite opens.
        # Request-local state cannot become another login's cache or survive a write.
        with self.connect() as c:
            c.execute('BEGIN')
            documents={r['path']:r['value'] for r in c.execute('SELECT path,value FROM documents WHERE user_id=?',(uid,))}
            resources={r['id']:Path(r['directory']) for r in c.execute("SELECT id,directory FROM resources WHERE user_id=? AND kind='paper'",(uid,))}
        token=_SNAPSHOT.set({'backend':self,'uid':uid,'documents':documents,'resources':resources})
        try:yield
        finally:_SNAPSHOT.reset(token)

    def bind_root(self,uid,directory,c=None):
        directory=Path(directory).resolve()
        if c is None:
            with self.transaction() as conn:return self.bind_root(uid,directory,conn)
        previous=c.execute('SELECT user_id FROM document_roots WHERE directory=?',(str(directory),)).fetchone()
        if previous and previous['user_id']!=uid:raise Problem('资料目录已属于其他账号',409)
        c.execute('INSERT OR IGNORE INTO document_roots VALUES(?,?)',(str(directory),uid))
        with self._roots_lock:self._roots[directory]=uid

    def owner_for_path(self,path):
        path=Path(path).resolve()
        with self._roots_lock:
            for parent in (path,*path.parents):
                uid=self._roots.get(parent)
                if uid:return uid
        return None

    def read_document(self,path,default=None):
        snapshot=_SNAPSHOT.get()
        if snapshot and snapshot['backend'] is self and str(path) in snapshot['documents']:
            return json.loads(snapshot['documents'][str(path)])
        path=Path(path).resolve();uid=self.owner_for_path(path)
        if not uid:raise RuntimeError('Unbound document')
        with self.connect() as c:
            row=c.execute('SELECT value FROM documents WHERE path=? AND user_id=?',(str(path),uid)).fetchone()
        if row:return json.loads(row['value'])
        # Read-only migration: a missing/corrupt file is never replaced by an empty successful record.
        try:value=json.loads(path.read_text(encoding='utf-8'))
        except FileNotFoundError:return copy.deepcopy(default)
        with self.transaction() as c:
            c.execute('INSERT OR IGNORE INTO documents VALUES(?,?,?,?)',(str(path),uid,encoded(value),time.time()))
            row=c.execute('SELECT value FROM documents WHERE path=? AND user_id=?',(str(path),uid)).fetchone()
        return json.loads(row['value'])

    def write_document(self,path,value,mirror_writer):
        path=Path(path).resolve();uid=self.owner_for_path(path)
        if not uid:raise RuntimeError('Unbound document')
        value=copy.deepcopy(value)
        if path.name=='item.json':
            tags=value.get('tags',[])
            if not isinstance(tags,list) or len(tags)>100:raise Problem('标签格式无效')
            canonical=[];seen=set()
            with self.connect() as c:
                known={r['normalized']:r['name'] for r in c.execute('SELECT normalized,name FROM tags WHERE user_id=?',(uid,))}
            for raw in tags:
                if not isinstance(raw,str) or not raw.strip() or len(raw.strip())>60:raise Problem('标签须为1—60字')
                name=raw.strip();key=name.casefold()
                if key not in seen:canonical.append(known.get(key,name));seen.add(key)
            value['tags']=canonical
            meta=value.get('meta_override',{})
            if 'title_en' in meta and not str(meta['title_en']).strip():raise Problem('题名不能为空')
            if meta.get('year') and not re.fullmatch(r'[0-9]{4}',str(meta['year'])):raise Problem('年份留空或为4位数字')
        # Serialize mirror compensation, including a failed SQLite COMMIT. Never
        # acknowledge a mirror-only write as a successful save.
        with self._document_lock:
            previous=path.read_bytes() if path.exists() else None
            try:
                with self.transaction() as c:
                    c.execute('INSERT OR REPLACE INTO documents VALUES(?,?,?,?)',(str(path),uid,encoded(value),time.time()))
                    if path.name in ('paper.json','item.json','reader.json'):
                        self._sync_paper(c,uid,path.parent,path.name,value)
                    mirror_writer(path,value)
            except BaseException:
                if previous is None:
                    path.unlink(missing_ok=True)
                elif not path.exists() or path.read_bytes()!=previous:
                    temporary=path.with_name(path.name+'.rollback')
                    temporary.write_bytes(previous);os.replace(temporary,path)
                raise

    def _sync_paper(self,c,uid,directory,name,value):
        resource=c.execute("SELECT id FROM resources WHERE user_id=? AND directory=? AND kind='paper'",(uid,str(directory))).fetchone()
        if not resource:return
        pid=resource['id']
        def get(part):
            if part+'.json'==name:return value
            record=c.execute('SELECT value FROM documents WHERE path=? AND user_id=?',(str(directory/(part+'.json')),uid)).fetchone()
            if record:return json.loads(record['value'])
            try:return json.loads((directory/(part+'.json')).read_text())
            except FileNotFoundError:return {}
        paper,item=get('paper'),get('item');meta={**paper.get('meta',{}),**item.get('meta_override',{})}
        c.execute('UPDATE papers SET title=?,authors=?,year=?,legacy_item=? WHERE id=? AND user_id=?',
                  (str(meta.get('title_en') or meta.get('title_zh') or directory.name),str(meta.get('authors') or ''),
                   str(meta.get('year') or ''),encoded(item),pid,uid))
        if name=='reader.json':
            c.execute('UPDATE papers SET note=?,reader=? WHERE id=? AND user_id=?',
                      (str((value.get('paper_note') or {}).get('body') or ''),encoded(value),pid,uid))
        if name=='item.json':
            c.execute('DELETE FROM paper_tags WHERE paper_id=?',(pid,))
            for name in value.get('tags',[]):
                key=name.casefold();tag=c.execute('SELECT id FROM tags WHERE user_id=? AND normalized=?',(uid,key)).fetchone()
                tid=tag['id'] if tag else ident()
                if not tag:c.execute('INSERT INTO tags VALUES(?,?,?,?)',(tid,uid,name,key))
                c.execute('INSERT OR IGNORE INTO paper_tags VALUES(?,?)',(pid,tid))

    def add_resource(self,uid,pid,directory,kind='paper',c=None):
        directory=Path(directory).resolve()
        if c is None:
            with self.transaction() as conn:return self.add_resource(uid,pid,directory,kind,conn)
        c.execute('INSERT OR IGNORE INTO resources VALUES(?,?,?,?)',(uid,pid,str(directory),kind))
        self.bind_root(uid,directory,c)

    def resource(self,uid,pid,kind='paper'):
        snapshot=_SNAPSHOT.get()
        if snapshot and snapshot['backend'] is self and snapshot['uid']==uid and kind=='paper':return snapshot['resources'].get(pid)
        with self.connect() as c:
            row=c.execute('SELECT directory FROM resources WHERE user_id=? AND id=? AND kind=?',(uid,pid,kind)).fetchone()
        return Path(row['directory']) if row else None

    def source_directory(self,uid,pid):
        return self.resource(uid,pid) or self.files/pid

    def delete_paper(self,uid,pid):
        """Delete the original resource and its private derived reading cache.

        Keep the registration and an explicit residual state until both files
        and SQL records are gone. Shared exact-PDF caches survive other records.
        """
        owned=self.workspace(uid,pid)
        with self._document_lock:
            with self.transaction() as c:
                row=owned.row(c)
                if c.execute("SELECT 1 FROM tasks WHERE paper_id=? AND state IN ('queued','running')",(pid,)).fetchone():
                    raise Problem('当前论文正在处理，结束后才能删除',409)
                c.execute("UPDATE papers SET delete_state='incomplete',delete_error='正在清理文件与关联记录' WHERE id=? AND user_id=?",(pid,uid))
                shared=c.execute('SELECT 1 FROM papers WHERE user_id=? AND sha256=? AND id<>?',(uid,row['sha256'],pid)).fetchone()
            targets=[self.source_directory(uid,pid)]
            if not shared:
                home=self.user_home(uid)
                for name in ('.pdf-reading','.pdf-reflow'):
                    targets.append(home/name/row['sha256'])
                for manifest in (home/'.pdf-dual-experiments').glob('*/manifest.json'):
                    value=json.loads(manifest.read_text())
                    if value.get('assets',{}).get('source',{}).get('sha256')==row['sha256']:targets.append(manifest.parent)
            try:
                for directory in targets:
                    if directory.exists():shutil.rmtree(directory)
                with self.transaction() as c:
                    owned.row(c)
                    for target in targets:
                        for record in c.execute('SELECT path FROM documents WHERE user_id=?',(uid,)).fetchall():
                            if Path(record['path']).is_relative_to(target):c.execute('DELETE FROM documents WHERE path=? AND user_id=?',(record['path'],uid))
                    c.execute('DELETE FROM resources WHERE user_id=? AND id=?',(uid,pid))
                    c.execute('DELETE FROM papers WHERE user_id=? AND id=?',(uid,pid))
                    for target in targets:c.execute('DELETE FROM document_roots WHERE directory=? AND user_id=?',(str(target),uid))
                with self._roots_lock:
                    for target in targets:self._roots.pop(target,None)
            except Exception:
                with self.transaction() as c:c.execute("UPDATE papers SET delete_error='文件或记录清理未完成，请再次删除以清理残留' WHERE id=? AND user_id=?",(pid,uid))
                raise Problem('删除未完成，登记与残留记录保留；请再次删除',409) from None

    def user_home(self,uid):
        with self.connect() as c:
            owner=c.execute("SELECT value FROM application WHERE key='original_owner'").fetchone()
        if owner and owner['value']==uid:return self.legacy_home
        path=self.root/'users'/uid;path.mkdir(parents=True,exist_ok=True)
        for name in ('.pdf-reading','.pdf-reflow','.pdf-dual-experiments','.selection-translations'):
            self.bind_root(uid,path/name)
        self.bind_root(uid,path/'prefs.json')
        return path

    def initial_library(self):
        from . import config
        cfg=config.load()
        return Path(cfg['library_dir']).resolve() if self.legacy_home==config.HOME.resolve() else self.legacy_home/'library'

    def original_pending(self):
        with self.connect() as c:
            owner=c.execute("SELECT 1 FROM application WHERE key='original_owner'").fetchone()
        return not owner and any(self.initial_library().glob('*/paper.json'))

    def adopt_original(self,uid):
        """First account claims existing local data; registration is explicit.

        Import files as records without deleting/moving originals. Derived reading
        resources and links keep their existing IDs and paths.
        """
        library=self.initial_library()
        sources=sorted(library.glob('*/paper.json'))
        snapshot=self.root/'backups'/'before-sqlite'
        snapshot.mkdir(parents=True,exist_ok=True)
        manifest=[]
        for path in sources:
            directory=path.parent
            for file in sorted(directory.rglob('*.json')):
                if file.is_symlink():continue
                rel=file.relative_to(self.legacy_home) if file.is_relative_to(self.legacy_home) else Path('library')/file.relative_to(library)
                dest=snapshot/rel;dest.parent.mkdir(parents=True,exist_ok=True)
                if not dest.exists():shutil.copy2(file,dest)
                if hashlib.sha256(file.read_bytes()).digest()!=hashlib.sha256(dest.read_bytes()).digest():
                    raise Problem('原资料备份核验失败，未接管原库',503)
                manifest.append({'path':str(rel),'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
        # Reading caches are part of the existing library, not another account's scratch data.
        for name in ('.pdf-reading','.pdf-reflow','.pdf-dual-experiments','.selection-translations'):
            folder=self.legacy_home/name
            if folder.exists():
                for file in folder.rglob('*.json'):
                    if file.is_symlink():continue
                    dest=snapshot/file.relative_to(self.legacy_home);dest.parent.mkdir(parents=True,exist_ok=True)
                    if not dest.exists():shutil.copy2(file,dest)
        (snapshot/'manifest.json').write_text(encoded(manifest))
        with self.transaction() as c:
            if c.execute("SELECT 1 FROM application WHERE key='original_owner'").fetchone():
                raise Problem('原库已完成归属登记，不能再次分配',409)
            for path in sources:
                paper=json.loads(path.read_text());meta=paper.get('meta',{});directory=path.parent;pid=directory.name
                pdf=directory/'source.pdf'
                digest=hashlib.sha256(pdf.read_bytes()).hexdigest() if pdf.is_file() else hashlib.sha256((directory/'source.html').read_bytes() if (directory/'source.html').is_file() else path.read_bytes()).hexdigest()
                # Legacy derived records remain resources. AI indexes are created
                # lazily for each actual source PDF, preserving all legacy relations.
                c.execute('''INSERT OR IGNORE INTO papers(id,user_id,sha256,filename,title,authors,year,created)
                    VALUES(?,?,?,?,?,?,?,?)''',(pid,uid,digest,str(meta.get('source') or 'source.pdf'),
                    str(meta.get('title_en') or meta.get('title_zh') or pid),str(meta.get('authors') or ''),str(meta.get('year') or ''),time.time()))
                self.add_resource(uid,pid,directory,c=c)
                for file in directory.rglob('*.json'):
                    if file.is_symlink():continue
                    value=json.loads(file.read_text())
                    c.execute('INSERT OR REPLACE INTO documents VALUES(?,?,?,?)',(str(file.resolve()),uid,encoded(value),time.time()))
            for name in ('.pdf-reading','.pdf-reflow','.pdf-dual-experiments','.selection-translations'):
                self.bind_root(uid,self.legacy_home/name,c)
            self.bind_root(uid,self.legacy_home/'prefs.json',c)
            c.execute("INSERT INTO application VALUES('original_owner',?)",(uid,))
        return {'papers':len(sources),'backup':str(snapshot)}


class Library:
    """Factory returning the existing Library subclass with SQL ownership."""
    def __new__(cls,database,uid):
        from .library import Library as OriginalLibrary,sha256_bytes,_pdf_title
        from .store import Workspace,SCHEMA,empty_reader,empty_discussion,now_iso,write_json_atomic
        class OwnedLibrary(OriginalLibrary):
            def __init__(self):
                super().__init__(database.root/'users'/uid/'library')
                self.database,self.user_id=database,uid

            def ws(self,pid):
                if not re.fullmatch(r'[A-Za-z0-9_-]{4,64}',pid or ''):return None
                directory=database.resource(uid,pid)
                if not directory:return None
                if (directory/'paper.json').is_file():return Workspace(directory)
                with database.connect() as c:row=c.execute('SELECT delete_state FROM papers WHERE id=? AND user_id=?',(pid,uid)).fetchone()
                return Workspace(directory) if row and row['delete_state'] else None

            def all(self):
                with database.connect() as c:
                    records=c.execute("SELECT directory FROM resources WHERE user_id=? AND kind='paper' ORDER BY id",(uid,)).fetchall()
                return [Workspace(Path(r['directory'])) for r in records if (Path(r['directory'])/'paper.json').is_file()]

            def list(self):
                values=self._list_uncached()
                with database.connect() as c:rows=c.execute('SELECT * FROM papers WHERE user_id=?',(uid,)).fetchall()
                indexed={r['id']:r for r in rows}
                for item in values:
                    row=indexed[item['id']];item.update(parse_state=row['parse_state'],parse_error=row['parse_error'])
                residuals=[r for r in rows if r['delete_state']]
                for row in residuals:
                    old=next((v for v in values if v['id']==row['id']),None)
                    if old is None:
                        old=self.summary(Workspace(database.source_directory(uid,row['id'])));values.append(old)
                    old.update(title_en=row['title'],delete_state=row['delete_state'],delete_error=row['delete_error'],
                               job={'state':'error','message':row['delete_error'],'error':row['delete_error']})
                return values

            def create_from_pdf(self,data,filename,meta=None):
                ws,fresh=database.create(uid,data,filename)
                if not fresh and self.ws(ws.id):return self.find_by_sha(ws.row()['sha256']) or self.ws(ws.id),False
                directory=database.files/ws.id
                database.add_resource(uid,ws.id,directory)
                original=Workspace(directory)
                embedded_title=_pdf_title(directory/'source.pdf')
                base={'title_zh':'','title_en':embedded_title or Path(filename).stem,'title_from_filename':not bool(embedded_title),
                      'authors':'','source':filename,'source_sha256':sha256_bytes(data),'pdf':'source.pdf'}
                base.update(meta or {})
                write_json_atomic(original.paper_path,{'schema':SCHEMA,'meta':base,'translation':{'scope':'未开始','done_pages':[],'note':''},'glossary':[],'references':[],'blocks':[]})
                if not original.reader_path.exists():write_json_atomic(original.reader_path,empty_reader())
                if not original.discussion_path.exists():write_json_atomic(original.discussion_path,empty_discussion())
                if not original.item_path.exists():write_json_atomic(original.item_path,{'added':now_iso(),'tags':[],'status':'unread','starred':False})
                return original,True

            def create_from_arxiv_html(self,ref,*,snapshot=None):
                # Reuse parsing and original DOM snapshots in this user's own staging root.
                original,fresh=super().create_from_arxiv_html(ref,snapshot=snapshot)
                with database.connect() as c:
                    owned=c.execute("SELECT id FROM resources WHERE user_id=? AND directory=?",(uid,str(original.root))).fetchone()
                if owned:return self.ws(owned['id']),False
                pid=ident();directory=self.root/pid
                original.root.rename(directory);ws=Workspace(directory)
                meta=ws.load('paper')['meta'];digest=hashlib.sha256((directory/'source.html').read_bytes()).hexdigest()
                with database.transaction() as c:
                    c.execute('''INSERT INTO papers(id,user_id,sha256,filename,title,authors,year,created,parse_state)
                        VALUES(?,?,?,?,?,?,?,?,'ready')''',(pid,uid,digest,'source.html',meta.get('title_en') or pid,meta.get('authors') or '',str(meta.get('year') or ''),time.time()))
                    database.add_resource(uid,pid,directory,c=c)
                return ws,True

            def find_by_sha(self,digest):
                with database.connect() as c:
                    rows=c.execute('SELECT id FROM papers WHERE user_id=? AND sha256=? ORDER BY created',(uid,digest)).fetchall()
                matches=[ws for row in rows if (ws:=self.ws(row['id']))]
                if len(matches)>1:
                    visible={v['id'] for v in self.list()}
                    return next((ws for ws in matches if ws.id in visible),matches[0])
                return matches[0] if matches else None

            def trash(self,pid):
                raise Problem('请使用经过确认的永久删除操作；不能绕过任务与残留检查',409)
        return OwnedLibrary()
