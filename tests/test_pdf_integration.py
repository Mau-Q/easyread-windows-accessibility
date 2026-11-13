import io
import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from pypdf import PdfWriter
from easyread import pdf_reader, pdf_translation, pdf_chat, chat_store, chat_images
from easyread.library import Library
from easyread.store import read_json, write_json_atomic


class IntegrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name); self.hjfy = self.home / 'HJFY'; self.hjfy.mkdir()
        self.lib = Library(self.home / 'library')
        out = io.BytesIO(); writer = PdfWriter(); writer.add_blank_page(width=600,height=800); writer.write(out)
        self.original, _ = self.lib.create_from_pdf(out.getvalue(), 'test.pdf')
        self.service = pdf_reader.Service(self.home,self.lib,self.hjfy)
        self.ws = self.service.workspace(self.original.id)
        write_json_atomic(self.hjfy/'models.json',[{'id':'local','enabled':True,'connection':{'model':'fixture','baseURL':'http://127.0.0.1:9999/v1','provider':'chat-completions'}}])
        self.runtime = self.home / 'runtime'; (self.runtime/'bin').mkdir(parents=True)
        self.env = patch.dict(os.environ,{'EASYREAD_HJFY_RUNTIME':str(self.runtime)}); self.env.start(); self.addCleanup(self.env.stop)
        self.cfg = patch.object(pdf_translation.config,'load',return_value={'openai':{}}); self.cfg.start(); self.addCleanup(self.cfg.stop)

    def fake_engine(self,mode='complete'):
        import sys
        p=self.runtime/'bin/hjfy-pdf'
        p.write_text('#!'+sys.executable+'\n'+
            'import sys,shutil,json,time\na=sys.argv\n'+
            ('time.sleep(30)\n' if mode=='slow' else '')+
            'shutil.copyfile(a[1],a[a.index("-o")+1])\n'+
            ('sys.exit(2)\n' if mode=='fail' else '')+
            ('print(json.dumps({"protocol_version":4,"type":"output_published","output":a[a.index("-o")+1]}),flush=True)\nprint(json.dumps({"protocol_version":4,"type":"document_finished","output":a[a.index("-o")+1],"content":{"published":True},"outcome":"succeeded"}),flush=True)\nprint(json.dumps({"protocol_version":4,"type":"run_finished","outcome":"succeeded"}),flush=True)\n' if mode!='unpublished' else ''))
        p.chmod(0o700)

    def wait(self):
        for _ in range(150):
            task=pdf_translation.state(self.ws)
            if task.get('state') not in pdf_translation.ACTIVE:return task
            time.sleep(.04)
        self.fail('fixture task timed out')

    def test_exact_completed_output_is_registered_without_switching_existing_choice(self):
        self.fake_engine(); task=pdf_translation.start(self.service,self.ws,{'model_id':'local'})
        result=self.wait(); self.assertEqual(result['state'],'completed')
        self.assertEqual(result['id'],task['id'])
        reopened=pdf_reader.Service(self.home,self.lib,self.hjfy).state_for(self.original.id)
        self.assertIn(task['id'],reopened['assets']['translation']['id'])
        self.assertEqual(reopened['assets']['translation']['provenance']['kind'],'easyread-hjfy')
        self.assertEqual(self.original.load('reader')['notes'],{})

    def test_duplicate_click_and_reopen_return_same_active_task_and_cancel(self):
        self.fake_engine('slow'); a=pdf_translation.start(self.service,self.ws,{'model_id':'local'})
        b=pdf_translation.start(self.service,self.ws,{'model_id':'local'});self.assertEqual(a['id'],b['id'])
        reopened=pdf_reader.Service(self.home,self.lib,self.hjfy).workspace(self.original.id)
        self.assertEqual(pdf_translation.state(reopened)['id'],a['id'])
        pdf_translation.cancel(reopened);self.assertEqual(self.wait()['state'],'cancelled')
        self.assertFalse(pdf_translation.completed(self.ws))

    def test_failed_or_unpublished_output_is_never_loaded_and_retry_has_new_id(self):
        for mode in ['fail','unpublished']:
            self.fake_engine(mode);a=pdf_translation.start(self.service,self.ws,{'model_id':'local'})
            self.assertEqual(self.wait()['state'],'failed');self.assertFalse(pdf_translation.completed(self.ws))
        self.fake_engine();b=pdf_translation.start(self.service,self.ws,{'model_id':'local'})
        self.assertNotEqual(a['id'],b['id']);self.assertEqual(self.wait()['state'],'completed')

    def test_reference_validation_rejects_wrong_identity_before_model(self):
        ref=self.ref();ref['pdf']['sha256']='0'*64
        with self.assertRaises(ValueError):pdf_chat.context(self.service,self.ws,[ref],'解释')

    def test_output_tampering_cannot_register_a_completed_task(self):
        self.fake_engine();pdf_translation.start(self.service,self.ws,{'model_id':'local'});task=self.wait()
        output=self.ws.root/'runs'/task['id']/'translated.pdf';output.write_bytes(output.read_bytes()+b'\nchanged')
        state=self.service.state_for(self.original.id)
        self.assertTrue(state['translation_pending']);self.assertIn('指纹',state['translation_errors'][0])

    def test_missing_connection_credentials_does_not_create_a_task(self):
        self.fake_engine()
        write_json_atomic(self.hjfy/'models.json',[{'id':'remote','enabled':True,'connection':{'model':'fixture','baseURL':'https://example.invalid/v1','provider':'chat-completions'}}])
        with self.assertRaises(ValueError):pdf_translation.start(self.service,self.ws,{'model_id':'remote'})
        self.assertEqual(pdf_translation.state(self.ws),{'state':'idle'})

    def test_disconnect_before_first_token_cancels_model_and_leaves_no_false_answer(self):
        left,right=socket.socketpair();self.addCleanup(left.close)
        handler=SimpleNamespace(path='/api/pdf-reader/'+self.original.id+'/chat',app=SimpleNamespace(chat_lock=threading.Lock(),active_chats=0),connection=left,wfile=io.BytesIO(),send_response=lambda *a:None,send_header=lambda *a:None,end_headers=lambda:None)
        cancelled=[]
        def stream(ecfg,prompt,cwd,cancel,**kwargs):
            right.close()
            cancelled.append(cancel.wait(2))
            from easyread.engines import Cancelled
            raise Cancelled()
            yield
        with patch.object(pdf_chat.chat_models,'engine_cfg',return_value=({'engine':'codex'},{'id':'gpt'})),patch.object(pdf_chat.chat_models,'label',return_value='Fixture'),patch.object(pdf_chat.chat,'stream',side_effect=stream):
            pdf_chat.handle(handler,self.service,self.ws,{'text':'解释','refs':[self.ref()]})
        self.assertEqual(cancelled,[True]);self.assertEqual(handler.app.active_chats,0)
        self.assertEqual(chat_store.threads(self.ws)[0]['messages'],[])

    def ref(self):
        a=self.service.manifest(self.ws)['assets']['source']
        return {'anchor':'source-p1','quote':'','pdf':{'schema':1,'document_id':self.ws.id,'coordinate_space':'pdf-user-space','side':'source','asset_id':a['id'],'version':a['version'],'sha256':a['sha256'],'pageIndex':0,'positions':[]}}

    def test_stream_history_preserves_pdf_identity_and_images(self):
        from PIL import Image
        image=io.BytesIO();Image.new('RGB',(5,5)).save(image,format='PNG');attachment=chat_images.save(self.ws,image.getvalue())
        left,right=socket.socketpair();self.addCleanup(left.close);self.addCleanup(right.close)
        handler=SimpleNamespace(path='/api/pdf-reader/'+self.original.id+'/chat',app=SimpleNamespace(chat_lock=threading.Lock(),active_chats=0),connection=left,wfile=io.BytesIO(),send_response=lambda *a:None,send_header=lambda *a:None,end_headers=lambda:None)
        model={'id':'gpt','engine':'codex','model':'fixture'}
        sent=[]
        def stream(*args,**kwargs):sent.append((args,kwargs));yield '解释完成'
        with patch.object(pdf_chat.chat_models,'engine_cfg',return_value=({'engine':'codex'},model)),patch.object(pdf_chat.chat_models,'label',return_value='Fixture'),patch.object(pdf_chat.chat,'stream',side_effect=stream):
            pdf_chat.handle(handler,self.service,self.ws,{'text':'解释这页','refs':[self.ref()],'images':[attachment]})
        lines=[json.loads(s) for s in handler.wfile.getvalue().splitlines()]
        self.assertTrue(lines[-1]['done']);self.assertIn('原文 · 第 1 页 · v1',sent[0][0][1])
        user=chat_store.threads(self.ws)[0]['messages'][0]
        self.assertEqual(user['refs'][0]['pdf'],self.ref()['pdf']);self.assertIn('/api/pdf-reader/',user['images'][0]['url'])
        self.assertEqual(handler.app.active_chats,0)
        thread=chat_store.threads(self.ws)[0]
        class JSONHandler:
            def _json(self,code,body):return code,body
        _,data=self.service.post(JSONHandler(),pdf_reader.API+self.original.id+'/chat/pin',{'thread':thread['id'],'id':thread['messages'][1]['id']})
        self.assertEqual(self.ws.load('discussion')['entries'][0]['refs'][0]['pdf'],self.ref()['pdf'])
        self.assertEqual(self.service.state_for(self.original.id)['discussion']['entries'][0]['refs'][0]['pdf'],self.ref()['pdf'])


if __name__=='__main__':unittest.main()
