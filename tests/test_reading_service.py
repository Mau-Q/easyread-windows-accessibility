import contextlib
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from pypdf import PdfWriter

from easyread.reading_service import Service
from easyread.account_store import Problem
from easyread.reading_core import validate, parse_pdf, service_info

PAGE='This paper studies a bounded test method. The method reduces memory for this experiment only. '
CFG={'engine':'codex','codex':{'model':'configured-test-model'}}


def result(kind='report',quote=PAGE[:65]):
    claim={'text':'受控样本结论，仅用于流程测试','source':'paper','citations':[{'page':1,'quote':quote}]}
    return json.dumps({'sections':{k:[claim] for k in ('research_question','method','results','limitations')}} if kind=='report' else {'claims':[claim]})


class FakeAI:
    def __init__(self): self.calls=[];self.response=None;self.before=None;self.after=None
    def generate(self,cfg,text,dispatch):
        if self.before: self.before()
        with dispatch(): self.calls.append(text)
        if self.after: self.after()
        if isinstance(self.response,Exception): raise self.response
        return self.response or result('qa' if '"task": "qa"' in text else 'report')


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.ai=FakeAI();self.service=Service(self.tmp.name,CFG,self.ai,lambda data:[PAGE]);self.addCleanup(self.service.close)
        self.store=self.service.store
        self.a=self.store.register('Alice','test-only-password');self.b=self.store.register('Bob','test-only-password')
        self.sa=self.store.login('alice','test-only-password');self.sb=self.store.login('bob','test-only-password')
        data=self.service.import_pdf(self.sa,b'%PDF-1.7\nfixture','fixture.pdf');self.pid=data['id'];self.service.wait(data['task'])
        self.ws=self.store.workspace(self.a['id'],self.pid)

    def consent(self,session=None,kind='report'):
        self.service.consent(session or self.sa,self.service.info()['fingerprint'],kind)

    def run_task(self,kind='report',body=None):
        tid=self.service.start(self.sa,self.pid,kind,body);self.service.wait(tid);return tid

    def test_local_operations_make_no_ai_request(self):
        self.ws.pdf();self.ws.metadata({'title':'local','authors':'','year':''});self.ws.note('local note',0)
        with self.assertRaises(Problem): self.service.start(self.sa,self.pid,'report')
        self.assertEqual([],self.ai.calls)
        self.assertEqual('ready',self.ws.state()['parse_state'])

    def test_second_instance_cannot_interrupt_live_sessions(self):
        with self.assertRaisesRegex(Problem,'另一实例'):
            Service(self.tmp.name,CFG,self.ai)
        self.store.session(self.sa['id'])
        self.assertEqual('ready',self.ws.state()['parse_state'])

    def test_report_qa_order_and_ownership(self):
        self.consent();report=self.run_task()
        self.assertEqual(report,self.ws.state()['report']['id'])
        self.consent(kind='qa');qa=self.run_task('qa',{'question':'What is the method?'})
        state=self.service.state(self.sa,self.pid)
        self.assertEqual(['parse','report','qa'],[t['kind'] for t in state['tasks']])
        self.assertEqual('completed',self.ws.task(qa)['state'])
        self.assertNotIn('local note',self.ai.calls[-1])
        self.assertEqual(2,len(self.ai.calls))
        with self.assertRaises(Problem): self.service.state(self.sb,self.pid)
        with self.assertRaises(Problem): self.service.save_again(self.sb,self.pid,qa)

    def test_invalid_quote_and_incomplete_output_keep_old_report(self):
        self.consent();old=self.run_task()
        self.ai.response='```json\n'+result()+'\n```'
        old=self.run_task(body={'expected_report':old})
        self.assertEqual(old,self.ws.state()['report']['id'])
        for invalid in (result(quote='This fabricated quote is not in this PDF'),
                        '```json\n'+result(quote='Fabricated fenced citation absent from the PDF')+'\n```',
                        'Extra output\n'+self.ai.response,'{"sections":{}}','{"sections":'):
            self.ai.response=invalid
            tid=self.run_task(body={'expected_report':old})
            self.assertEqual('failed',self.ws.task(tid)['state'])
            self.assertEqual(old,self.ws.state()['report']['id'])

    def test_save_failure_and_save_only_retry(self):
        self.consent();old=self.run_task()
        with patch('easyread.account_store.Workspace.commit_result',side_effect=OSError('disk full')):
            tid=self.run_task(body={'expected_report':old})
        self.assertEqual(old,self.ws.state()['report']['id'])
        self.assertEqual('save_failed',self.service.state(self.sa,self.pid)['tasks'][-1]['state'])
        count=len(self.ai.calls)
        self.service.save_again(self.sa,self.pid,tid)
        self.assertEqual(count,len(self.ai.calls))
        self.assertEqual(tid,self.ws.state()['report']['id'])

    def test_candidate_write_failure_preserves_in_memory_output(self):
        self.consent(kind='qa')
        with patch('easyread.account_store.Workspace.candidate',side_effect=OSError('disk full')):
            tid=self.run_task('qa',{'question':'Question'})
        state=self.service.state(self.sa,self.pid)
        self.assertEqual('save_failed',state['tasks'][-1]['state'])
        self.assertIn('claims',state['tasks'][-1]['result'])
        self.service.save_again(self.sa,self.pid,tid)
        self.assertEqual(1,len(self.ai.calls))

    def test_failure_retry_keeps_attempt_and_cost_confirmation(self):
        self.consent(kind='qa');self.ai.response=Problem('timeout')
        failed=self.run_task('qa',{'question':'original question'})
        self.assertEqual('failed',self.ws.task(failed)['state'])
        with self.assertRaises(Problem): self.service.start(self.sa,self.pid,'qa',{'retry_of':failed})
        self.ai.response=None
        retry=self.run_task('qa',{'retry_of':failed,'confirm_retry':True})
        self.assertEqual('failed',self.ws.task(failed)['state'])
        self.assertEqual('completed',self.ws.task(retry)['state'])
        self.assertEqual('original question',self.ws.task(retry)['question'])

    def test_logout_before_dispatch_prevents_call(self):
        self.consent();gate=threading.Event();entered=threading.Event()
        def before(): entered.set();gate.wait(10)
        self.ai.before=before
        tid=self.service.start(self.sa,self.pid,'report');self.assertTrue(entered.wait(5))
        self.service.logout(self.sa);gate.set();self.service.wait(tid)
        self.assertEqual([],self.ai.calls)
        self.assertEqual('interrupted',self.ws.task(tid)['state'])
        self.assertIsNone(self.ws.state()['report'])

    def test_already_dispatched_return_stays_with_original_user(self):
        self.consent();gate=threading.Event();entered=threading.Event()
        def after(): entered.set();gate.wait(10)
        self.ai.after=after
        tid=self.service.start(self.sa,self.pid,'report');self.assertTrue(entered.wait(5))
        for operation in (lambda:self.service.start(self.sa,self.pid,'report'),lambda:self.service.delete(self.sa,self.pid)):
            with self.assertRaises(Problem): operation()
        self.service.logout(self.sa);gate.set();self.service.wait(tid)
        self.assertEqual(tid,self.ws.state()['report']['id'])
        with self.assertRaises(Problem): self.service.state(self.sb,self.pid)
        new=self.store.login('alice','test-only-password')
        with self.assertRaises(Problem): self.service.start(new,self.pid,'report',{'expected_report':tid})

    def test_service_change_rechecks_consent_at_dispatch(self):
        cfg=dict(CFG);cfg['codex']=dict(CFG['codex']);self.service.cfg=lambda:cfg
        self.consent();self.ai.before=lambda:cfg['codex'].update(model='changed')
        tid=self.run_task()
        self.assertEqual([],self.ai.calls)
        self.assertEqual('failed',self.ws.task(tid)['state'])

    def test_parse_failure_preserves_local_operations_and_retry(self):
        self.service.parser=lambda _:(_ for _ in ()).throw(Problem('controlled parse failure'))
        tid=self.run_task('parse')
        self.assertEqual('failed',self.ws.state()['parse_state'])
        self.ws.note('still local',0);self.ws.metadata({'title':'still editable','year':'','authors':''});self.ws.pdf()
        self.consent()
        with self.assertRaises(Problem): self.service.start(self.sa,self.pid,'report')
        self.service.parser=lambda _:[PAGE];self.run_task('parse')
        self.assertEqual('ready',self.ws.state()['parse_state'])
        self.assertEqual(1,len(self.store.list(self.a['id'])))

    def test_stale_candidate_does_not_silently_replace_new_report(self):
        self.consent();old=self.run_task()
        with patch('easyread.account_store.Workspace.commit_result',side_effect=OSError('disk')):
            stale=self.run_task(body={'expected_report':old})
        new=self.run_task(body={'expected_report':old})
        with self.assertRaises(Problem): self.service.save_again(self.sa,self.pid,stale)
        self.assertEqual(new,self.ws.state()['report']['id'])

    def test_reference_normalization_preserves_numbers_and_punctuation(self):
        validate(result(quote=PAGE[:65].replace(' ','\n')),'report',[PAGE],self.pid,'x')
        with self.assertRaises(Problem): validate(result(quote=PAGE[:65].replace('method','METHOD ELSE')),'report',[PAGE],self.pid,'x')

    def test_real_parser_rejects_scan_encrypted_and_corrupt(self):
        writer=PdfWriter();writer.add_blank_page(width=200,height=200);b=io.BytesIO();writer.write(b)
        with self.assertRaisesRegex(Problem,'OCR'): parse_pdf(b.getvalue())
        writer.encrypt('test-only');b=io.BytesIO();writer.write(b)
        with self.assertRaisesRegex(Problem,'加密'): parse_pdf(b.getvalue())
        with self.assertRaisesRegex(Problem,'解析失败'): parse_pdf(b'%PDF-1.7\ncorrupt')


if __name__=='__main__': unittest.main()
