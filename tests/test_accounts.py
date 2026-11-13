import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread.account_store import Store, Problem, MAX_PDF


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(Path(self.tmp.name))
        self.a = self.store.register('Alice','test-only-password')
        self.b = self.store.register('Bob','test-only-password')
        self.sa = self.store.login('ALICE','test-only-password')
        self.sb = self.store.login('bob','test-only-password')
        self.ws,_ = self.store.create(self.a['id'],b'%PDF-1.7\ntest','test.pdf')

    def test_registration_boundaries(self):
        for name in ('ab','x'*21,'中文abc','bad-name'):
            with self.assertRaises(Problem): self.store.register(name,'password')
        for password in ('x'*7,'x'*65):
            with self.assertRaises(Problem): self.store.register('valid',password)
        for name,password in (('abc','x'*8),('x'*20,'x'*64)):
            self.store.register(name,password)
        with self.assertRaises(Problem): self.store.register('alice','other-pass')
        with self.assertRaises(Problem): self.store.login('alice','wrong-pass')

    def test_session_and_consent_isolation(self):
        self.store.consent(self.sa,'service','report')
        self.store.require_consent(self.sa,'service','report')
        for s,f,scope in ((self.sb,'service','report'),(self.sa,'new','report'),(self.sa,'service','qa')):
            with self.assertRaises(Problem): self.store.require_consent(s,f,scope)
        other = self.store.login('alice','test-only-password')
        self.store.logout(self.sa['id'])
        with self.assertRaises(Problem): self.store.session(self.sa['id'])
        self.store.session(other['id'])

    def test_all_resources_use_workspace_owner(self):
        self.ws.note('private',0)
        with self.assertRaises(Problem): self.store.workspace(self.b['id'],self.ws.id)
        self.assertEqual([],self.store.list(self.b['id']))
        evil = type(self.ws)(self.store,self.b['id'],self.ws.id)
        for operation in (evil.state,evil.pdf,lambda:evil.note('hack',0),lambda:evil.tag('hack'),evil.delete):
            with self.assertRaises(Problem): operation()
        self.assertEqual('private',self.ws.state()['note'])

    def test_duplicate_files_are_user_scoped(self):
        self.ws.note('keep',0)
        same,fresh = self.store.create(self.a['id'],b'%PDF-1.7\ntest','another.pdf')
        self.assertFalse(fresh)
        self.assertEqual(self.ws.id,same.id)
        other,fresh = self.store.create(self.b['id'],b'%PDF-1.7\ntest','another.pdf')
        self.assertTrue(fresh)
        self.assertNotEqual(other.id,same.id)
        self.assertEqual('keep',self.ws.state()['note'])

    def test_tags_search_and_notes(self):
        self.ws.metadata({'title':'Transformer Paper','authors':'Jane Doe','year':'2026'})
        self.ws.tag(' LLM '); self.ws.tag('llm'); self.ws.tag('方法')
        tags = self.store.tags(self.a['id'])
        self.assertEqual(2,len(tags))
        tid = next(t['id'] for t in tags if t['name']=='LLM')
        self.assertEqual(1,len(self.store.list(self.a['id'],'doE',tid)))
        self.assertEqual([],self.store.list(self.a['id'],'absent',tid))
        self.ws.note('saved',0)
        with self.assertRaises(Problem): self.ws.note('stale',0)
        with patch.object(self.store,'transaction',side_effect=OSError('disk')):
            with self.assertRaises(OSError): self.ws.note('failed',1)
        self.assertEqual('saved',self.ws.state()['note'])
        self.ws.tag('LLM',remove=True)
        self.assertEqual([],self.store.list(self.a['id'],'',tid))

    def test_task_delete_and_atomic_report(self):
        tid = self.ws.start(self.sa,'parse')
        with self.assertRaises(Problem): self.ws.start(self.sa,'parse')
        with self.assertRaises(Problem): self.ws.delete()
        self.ws.parsed(tid,['page text'])
        report = self.ws.start(self.sa,'report')
        self.ws.candidate(report,{'sections':'old'})
        self.ws.commit_result(report)
        with self.assertRaises(Problem): self.ws.start(self.sa,'report')
        next_id = self.ws.start(self.sa,'report',expected_report=report)
        self.ws.candidate(next_id,{'sections':'new'})
        with patch.object(self.store,'transaction',side_effect=OSError('disk')):
            with self.assertRaises(OSError): self.ws.commit_result(next_id)
        self.assertEqual(report,self.ws.state()['report']['id'])
        self.ws.commit_result(next_id); self.ws.commit_result(next_id)
        self.assertEqual(next_id,self.ws.state()['report']['id'])

    def test_restart_marks_tasks_and_sessions_interrupted(self):
        tid = self.ws.start(self.sa,'parse')
        Store(self.tmp.name).interrupt()
        self.assertEqual('interrupted',self.ws.task(tid)['state'])
        self.assertEqual('interrupted',self.ws.state()['parse_state'])
        with self.assertRaises(Problem): self.store.session(self.sa['id'])

    def test_partial_delete_keeps_retry_entry(self):
        with patch('easyread.account_store.shutil.rmtree',side_effect=OSError('disk')):
            with self.assertRaises(Problem): self.ws.delete()
        self.assertEqual('incomplete',self.ws.state()['delete_state'])
        self.ws.delete()
        with self.assertRaises(Problem): self.ws.state()
        self.assertFalse((self.store.files/self.ws.id).exists())

    def test_pdf_identity_actual_bytes(self):
        path = self.store.files/self.ws.id/'source.pdf'
        path.write_bytes(b'%PDF-1.7\nchanged')
        with self.assertRaises(Problem): self.ws.pdf()
        self.assertEqual(1,len(self.store.list(self.a['id'])))

    def test_upload_and_registration_failures(self):
        with self.assertRaises(Problem): self.store.create(self.a['id'],b'%PDF-'+b'x'*MAX_PDF,'big.pdf')
        with self.assertRaises(Problem): self.store.create(self.a['id'],b'notpdf','bad.pdf')
        with patch('pathlib.Path.open',side_effect=OSError('disk')):
            with self.assertRaises(OSError): self.store.create(self.a['id'],b'%PDF-other','other.pdf')
        self.assertEqual(1,len(self.store.list(self.a['id'])))


if __name__ == '__main__': unittest.main()
