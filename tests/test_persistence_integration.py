"""Regressions for adopting the original App without changing its records."""
import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from easyread import config
from easyread.account_store import Problem
from easyread.database import Database,Library
from easyread.library import Library as OriginalLibrary
from easyread.store import read_json,write_json_atomic
from test_app_access import text_pdf

class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.home=Path(self.tmp.name)
        self.db=Database(self.home/'.easyread',self.home);self.addCleanup(self.db.close)
        self.a=self.db.register('alice','testing-password')['id'];self.b=self.db.register('bob','testing-password')['id']

    def test_adoption_preserves_original_bytes_links_notes_and_ownership(self):
        original=OriginalLibrary(self.home/'library');ws,_=original.create_from_pdf(text_pdf(),'old.pdf')
        ws.update('reader',lambda x:x.update(paper_note={'body':'我的旧笔记'},progress={'ratio':0.37}))
        ws.patch_item({'tags':['Original'],'meta_override':{'title_en':'A preserved title'}})
        before={str(p):p.read_bytes() for p in ws.root.rglob('*') if p.is_file()}
        self.assertTrue(self.db.original_pending());self.db.adopt_original(self.a)
        self.assertEqual(before,{str(p):p.read_bytes() for p in ws.root.rglob('*') if p.is_file()})
        owned=Library(self.db,self.a);self.assertEqual('我的旧笔记',owned.ws(ws.id).load('reader')['paper_note']['body'])
        self.assertEqual('A preserved title',owned.list()[0]['title_en']);self.assertIsNone(Library(self.db,self.b).ws(ws.id))
        self.assertEqual([],Library(self.db,self.b).list());self.assertFalse(self.db.original_pending())
        with self.assertRaises(Problem):self.db.adopt_original(self.b)

    def test_failed_commit_restores_json_and_sql_and_old_note(self):
        lib=Library(self.db,self.a);ws,_=lib.create_from_pdf(text_pdf(),'paper.pdf')
        write_json_atomic(ws.reader_path,{'paper_note':{'body':'old'}})
        previous=ws.reader_path.read_bytes();transaction=self.db.transaction
        @contextmanager
        def fail_commit():
            with transaction() as c:
                yield c
                raise OSError('injected commit failure')
        with patch.object(self.db,'transaction',fail_commit):
            with self.assertRaises(OSError):write_json_atomic(ws.reader_path,{'paper_note':{'body':'new'}})
        self.assertEqual(previous,ws.reader_path.read_bytes());self.assertEqual('old',read_json(ws.reader_path)['paper_note']['body'])

    def test_deletion_failure_keeps_retry_entry_and_cleans_original_and_cache(self):
        lib=Library(self.db,self.a);ws,_=lib.create_from_pdf(text_pdf(),'paper.pdf')
        cache=self.db.user_home(self.a)/'.pdf-reading'/self.db.workspace(self.a,ws.id).row()['sha256'];cache.mkdir(parents=True)
        write_json_atomic(cache/'reader.json',{'paper_note':{'body':'private'}})
        from easyread import database
        real=database.shutil.rmtree
        def fail_cache(path):
            if Path(path)==cache:raise OSError('injected filesystem failure')
            real(path)
        with patch.object(database.shutil,'rmtree',side_effect=fail_cache):
            with self.assertRaises(Problem):self.db.workspace(self.a,ws.id).delete()
        self.assertFalse(ws.root.exists());self.assertIsNotNone(lib.ws(ws.id));self.assertEqual('incomplete',lib.list()[0]['delete_state'])
        self.db.workspace(self.a,ws.id).delete();self.assertEqual([],lib.list());self.assertFalse(cache.exists())

    def test_list_snapshot_does_not_keep_stale_notes_or_cross_user_records(self):
        a=Library(self.db,self.a);b=Library(self.db,self.b)
        wa,_=a.create_from_pdf(text_pdf(),'alice.pdf');wb,_=b.create_from_pdf(text_pdf('A distinct document owned by Bob, containing enough text for a meaningful local verification. No provider is invoked.'),'bob.pdf')
        write_json_atomic(wa.reader_path,{'paper_note':{'body':'alice before'}})
        with self.db.document_snapshot(self.a):
            value=read_json(wa.reader_path);value['paper_note']['body']='in-memory modification'
            self.assertEqual('alice before',read_json(wa.reader_path)['paper_note']['body'])
            self.assertEqual([wa.id],[r['id'] for r in a.list()]);self.assertEqual([wb.id],[r['id'] for r in b.list()])
        write_json_atomic(wa.reader_path,{'paper_note':{'body':'alice after'}})
        with self.db.document_snapshot(self.a):self.assertEqual('alice after',read_json(wa.reader_path)['paper_note']['body'])

    def test_failed_legacy_enqueue_does_not_leave_a_phantom_active_task(self):
        from easyread.jobs import Jobs
        from easyread.access import request_scope
        lib=Library(self.db,self.a);ws,_=lib.create_from_pdf(text_pdf(),'paper.pdf')
        session=self.db.login('alice','testing-password');jobs=Jobs(lib);self.addCleanup(jobs.close)
        with request_scope(session,lambda:None),patch.object(jobs,'_write',side_effect=OSError('injected queue save failure')):
            with self.assertRaises(OSError):jobs.enqueue(ws,translate_after=True)
        with self.db.connect() as c:states=[r['state'] for r in c.execute('SELECT state FROM tasks WHERE paper_id=?',(ws.id,))]
        self.assertEqual(['failed'],states);self.assertTrue(jobs.bulk.empty())

    def test_hjfy_history_is_not_inherited_by_another_account_with_same_pdf(self):
        from easyread import pdf_reader,pdf_translation
        self.db.adopt_original(self.a)
        a=Library(self.db,self.a);b=Library(self.db,self.b);data=text_pdf()
        wa,_=a.create_from_pdf(data,'same.pdf');wb,_=b.create_from_pdf(data,'same.pdf')
        external=self.home/'operator-hjfy';folder=external/'Documents'/'old-document';(folder/'Runs'/'old-run').mkdir(parents=True)
        (folder/'original.pdf').write_bytes(data);(folder/'Runs'/'old-run'/'translated.pdf').write_bytes(data)
        (external/'models.json').write_text(json.dumps([{'id':'shared-model','enabled':True,'connection':{'model':'fixture','baseURL':'http://127.0.0.1:9/v1'}}]))
        sa=pdf_reader.Service(self.db.user_home(self.a),a,hjfy_home=external);sb=pdf_reader.Service(self.db.user_home(self.b),b,hjfy_home=external)
        digest=sa.file_hash(wa.root/'source.pdf')
        self.assertEqual(1,len(sa.translations(digest)));self.assertEqual([],sb.translations(digest))
        self.assertEqual(pdf_translation.choices(sa),pdf_translation.choices(sb))

    def test_duplicate_legacy_pdf_reopens_visible_source_instead_of_hidden_derivative(self):
        import shutil
        source=OriginalLibrary(self.home/'library');ws,_=source.create_from_pdf(text_pdf(),'original.pdf')
        hidden=ws.root.parent/'0000-derived';shutil.copytree(ws.root,hidden)
        (hidden/'item.json').write_text(json.dumps({'derived_from':ws.id,'tags':[],'status':'unread'}))
        self.db.adopt_original(self.a);owned=Library(self.db,self.a)
        self.assertEqual([ws.id],[v['id'] for v in owned.list()])
        reopened,fresh=owned.create_from_pdf(text_pdf(),'again.pdf')
        self.assertFalse(fresh);self.assertEqual(ws.id,reopened.id)

if __name__=='__main__':unittest.main()
