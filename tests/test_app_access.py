import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from http.cookiejar import CookieJar
from unittest.mock import patch
from pypdf import PdfWriter
from easyread import config,server,pdf_dual,pdf_reader


def text_pdf(text='This public test paper explains a bounded method and its limitations for a local software test.'):
    body=('BT /F1 10 Tf 20 100 Td ('+text.replace('(','').replace(')','')+') Tj ET').encode()
    objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',b'<< /Length '+str(len(body)).encode()+b' >>\nstream\n'+body+b'\nendstream']
    data=b'%PDF-1.4\n';offsets=[0]
    for i,obj in enumerate(objects,1):offsets.append(len(data));data+=f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n'
    start=len(data);data+=b'xref\n0 6\n0000000000 65535 f \n'+b''.join(f'{v:010d} 00000 n \n'.encode() for v in offsets[1:])+f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF'.encode()
    return data


class AppAccessTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);home=Path(self.tmp.name)
        cfg={**config.load(),'library_dir':str(home/'library'),'engine':'none','pdf_web_enabled':False}
        self.home=home;self.cfg=cfg
        for p in (patch.object(config,'HOME',home),patch.object(config,'load',return_value=cfg)):
            p.start();self.addCleanup(p.stop)
        pdf_dual.install(server);pdf_reader.install(server)
        self.httpd=server.make_server(cfg,0);self.runtime=self.httpd.runtime
        self.addCleanup(self.runtime.close);self.addCleanup(self.httpd.server_close)
        threading.Thread(target=self.httpd.serve_forever,daemon=True).start();self.addCleanup(self.httpd.shutdown)
        self.base=f'http://127.0.0.1:{self.httpd.server_port}';self.tokens={}
        self.a=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()));self.b=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
        for client,name in ((self.a,'alice'),(self.b,'bob')):
            self.request(client,'/api/register',{'username':name,'password':'test-only-password'})
            self.tokens[client]=self.request(client,'/api/login',{'username':name,'password':'test-only-password'})[1]['csrf']
        self.pdf=text_pdf();_,data=self.request(self.a,'/api/import?name=test.pdf&translate=1&prefer_html=0',self.pdf)
        self.pid=data['id']
        if data.get('task'):self.runtime.reading.wait(data['task'])

    def request(self,client,path,body=None,headers=None):
        raw=body if isinstance(body,bytes) else json.dumps(body).encode() if body is not None else None
        req=urllib.request.Request(self.base+path,data=raw,headers={'X-EasyRead':'app','X-Token':self.tokens.get(client,''),**(headers or {})})
        try:r=client.open(req,timeout=15)
        except urllib.error.HTTPError as e:r=e
        with r:
            raw=r.read();ctype=r.headers.get('Content-Type','');return r.status,[json.loads(line) for line in raw.splitlines()] if 'ndjson' in ctype else json.loads(raw) if 'json' in ctype else raw

    def test_original_pages_and_features_use_same_entry(self):
        status,html=self.request(self.a,'/')
        self.assertEqual(200,status);self.assertIn(b'js/library/app.js',html);self.assertIn(b'account-session.js',html)
        status,items=self.request(self.a,'/api/library');self.assertEqual(200,status)
        self.assertEqual([self.pid],[x['id'] for x in items['items']])
        status,reader=self.request(self.a,'/read/'+self.pid)
        self.assertEqual(200,status);self.assertIn(b'pdf-reader/app.js',reader);self.assertIn(b'pdf-dual/chat.js',reader)
        self.assertNotIn(b'/web/course/',reader)

    def test_direct_access_and_mutations_are_isolated(self):
        for path in ('/read/'+self.pid,'/p/'+self.pid+'/source.pdf','/api/p/'+self.pid+'/state','/api/pdf-reader/'+self.pid+'/state','/api/reading/'+self.pid):
            self.assertIn(self.request(self.b,path)[0],(404,409))
        for path,body in ((f'/api/p/{self.pid}/item',{'starred':True}),(f'/api/pdf-reader/{self.pid}/ops',{'ops':[]}),(f'/api/reading/{self.pid}/report',{}),(f'/api/reading/{self.pid}/delete',{'confirm':True})):
            self.assertIn(self.request(self.b,path,body)[0],(404,409))
        self.assertEqual([],self.request(self.b,'/api/library')[1]['items'])

    def test_logout_csrf_and_session_token_are_distinct(self):
        self.assertEqual(403,self.request(self.a,f'/api/p/{self.pid}/item',{'starred':True},{'X-Token':'wrong'})[0])
        self.assertNotEqual(self.tokens[self.a],self.tokens[self.b])
        self.assertEqual(200,self.request(self.a,'/api/logout',{})[0])
        self.assertEqual(401,self.request(self.a,f'/p/{self.pid}/source.pdf')[0])
        self.assertEqual(200,self.request(self.a,'/')[0])
        self.assertEqual(403,self.request(self.b,'/api/desktop/status')[0])

    def test_metadata_tags_and_user_preferences_are_sqlite_backed(self):
        self.assertEqual(200,self.request(self.a,f'/api/p/{self.pid}/item',{'meta_override':{'title_en':'Known Paper','authors':'Ada','year':'2026'},'tags':[' LLM ','llm','方法']})[0])
        item=self.request(self.a,'/api/library')[1]['items'][0]
        self.assertEqual('Known Paper',item['title_en']);self.assertEqual(['LLM','方法'],item['tags'])
        self.request(self.a,'/api/prefs',{'reader':{'theme':'dark'}})
        self.assertNotIn('reader',self.request(self.b,'/api/prefs')[1])
        with self.runtime.db.connect() as c:self.assertGreater(c.execute('SELECT count(*) FROM documents').fetchone()[0],0)

    def test_import_is_local_and_old_ai_routes_require_consent(self):
        self.assertFalse(self.request(self.a,'/api/p/'+self.pid+'/state')[1]['job'].get('translate'))
        status,data=self.request(self.a,f'/api/pdf-reader/{self.pid}/chat',{'text':'Question','refs':[]})
        self.assertEqual(403,status);self.assertEqual('consent_required',data['code'])
        self.assertNotIn('api_key',json.dumps(data))

    def test_chat_failure_retains_question_but_excludes_partial_from_history(self):
        import time
        from easyread import chat_store
        for _ in range(100):
            if self.request(self.a,'/api/p/'+self.pid+'/state')[1]['job'].get('state') not in ('queued','running'):break
            time.sleep(.02)
        cfg={**self.cfg,'engine':'codex','codex':{'model':'fixture-only'}}
        model={'id':'fixture','engine':'codex','model':'fixture-only'}
        def broken(*args,**kw):
            yield 'partial output'
            raise RuntimeError('injected generation failure')
        path=f'/api/pdf-reader/{self.pid}/chat'
        with patch('easyread.chat_models.engine_cfg',return_value=(cfg,model)),patch('easyread.chat.stream',side_effect=broken):
            _,challenge=self.request(self.a,path,{'text':'failed question'})
            self.request(self.a,'/api/consent',{'scope':challenge['scope'],'model':'fixture','fingerprint':challenge['info']['fingerprint']})
            status,events=self.request(self.a,path,{'text':'failed question'})
        self.assertEqual(200,status);self.assertTrue(events[-1].get('error'));self.assertFalse(any(e.get('done') for e in events))
        records=self.request(self.a,path)[1]['threads'];attempt=records[0]['messages'][-1]
        self.assertIn('partial output',attempt['content']);self.assertTrue(attempt['error'])
        with self.runtime.db.connect() as c:
            rows=c.execute("SELECT state FROM tasks WHERE paper_id=? AND kind='chat'",(self.pid,)).fetchall()
        self.assertEqual(['failed'],[r['state'] for r in rows])
        with patch('easyread.chat_models.engine_cfg',return_value=(cfg,model)),patch('easyread.chat.stream',return_value=iter(['complete reply'])):
            status,events=self.request(self.a,path,{'text':'second question','thread':records[0]['id']})
        self.assertEqual(200,status);self.assertTrue(events[-1].get('done'))
        messages=self.request(self.a,path)[1]['threads'][0]['messages']
        self.assertEqual(['failed question','partial output','second question','complete reply'],[m['content'] for m in messages])
        self.assertEqual([],self.request(self.b,path)[1].get('threads',[]))

    def test_upload_boundary_and_invalid_registration(self):
        original=text_pdf();at=original.rindex(b'startxref');padding=b'%'+b'x'*(20_000_000-len(original)-2)+b'\n';boundary=original[:at]+padding+original[at:]
        self.assertEqual(20_000_000,len(boundary));status,accepted=self.request(self.a,'/api/import?name=boundary.pdf&prefer_html=0',boundary)
        self.assertEqual(200,status);self.assertTrue(accepted['registered']);self.runtime.reading.wait(accepted['task'])
        self.assertEqual('ready',self.request(self.a,'/api/reading/'+accepted['id'])[1]['parse_state'])
        self.assertEqual(413,self.request(self.a,'/api/import?name=large.pdf',boundary+b'x')[0])
        self.assertEqual(409,self.request(self.b,'/api/register',{'username':'ALICE','password':'test-only-password'})[0])
        self.assertEqual(400,self.request(self.b,'/api/consent',{'scope':'unknown','fingerprint':'x'})[0])

    def test_save_only_chat_retry_is_idempotent_and_never_calls_ai(self):
        import time
        from types import SimpleNamespace
        from easyread import conversations,chat_store
        from easyread.account_store import Problem
        for _ in range(100):
            if self.request(self.a,'/api/p/'+self.pid+'/state')[1]['job'].get('state') not in ('queued','running'):break
            time.sleep(.02)
        with self.runtime.db.connect() as c:row=c.execute('SELECT id FROM sessions WHERE csrf=?',(self.tokens[self.a],)).fetchone()
        session=self.runtime.db.session(row['id']);ws=self.runtime.user(session).lib.ws(self.pid)
        handler=SimpleNamespace(app=SimpleNamespace(runtime=self.runtime),session=session,path=f'/api/p/{self.pid}/chat')
        attempt=conversations.Attempt(handler,ws,'test-thread',{'content':'Question','at':'2026-10-30'},'fixture','fixture')
        with patch('easyread.chat_store.append',side_effect=OSError('injected save failure')):
            with self.assertRaises(Problem):attempt.complete('A complete answer',{'total_s':1})
        record=conversations.threads(handler,ws)[0]['messages'][-1]
        self.assertEqual(attempt.id,record['save_task']);self.assertEqual([],chat_store.threads(ws))
        with patch('easyread.chat.stream') as provider:
            conversations.save(handler,ws,attempt.id);conversations.save(handler,ws,attempt.id)
            provider.assert_not_called()
        self.assertEqual(2,len(chat_store.get(ws,'test-thread')['messages']))
        self.assertEqual('completed',attempt.owned.task(attempt.id)['state'])

    def test_native_proxy_revocation_prevents_dispatch(self):
        with self.runtime.db.connect() as c:row=c.execute('SELECT id FROM sessions WHERE csrf=?',(self.tokens[self.a],)).fetchone()
        session=self.runtime.db.session(row['id']);cancel=self.home/'native-cancel'
        self.runtime.native_proxies['test-only-capability']={'session':session,'cancel':cancel,'gate':lambda:None,'base_url':'http://127.0.0.1:9/v1','key':'fixture'}
        self.request(self.a,'/api/logout',{})
        with patch('httpx.Client') as outbound:
            status,_=self.request(self.b,'/native-proxy/chat/completions',{},headers={'Authorization':'Bearer test-only-capability'})
            outbound.assert_not_called()
        self.assertEqual(401,status);self.assertTrue(cancel.exists())

    def test_both_populated_accounts_reject_each_others_complete_resources(self):
        import time
        from easyread import chat_store,reading_core
        from easyread.store import write_json_atomic
        _,other=self.request(self.b,'/api/import?name=bob.pdf&translate=0&prefer_html=0',text_pdf('Bob owns a different private document. This paper studies a bounded method and its limitations for software verification.'))
        if other.get('task'):self.runtime.reading.wait(other['task'])
        fixtures=[]
        for client,pid in ((self.a,self.pid),(self.b,other['id'])):
            for _ in range(100):
                if self.request(client,'/api/p/'+pid+'/state')[1]['job'].get('state') not in ('queued','running'):break
                time.sleep(.02)
            with self.runtime.db.connect() as c:row=c.execute('SELECT id FROM sessions WHERE csrf=?',(self.tokens[client],)).fetchone()
            session=self.runtime.db.session(row['id']);owned=self.runtime.db.workspace(session['user_id'],pid)
            original=self.runtime.user(session).lib.ws(pid);original.patch_item({'tags':['Private '+session['username']]})
            write_json_atomic(original.reader_path,{'paper_note':{'body':session['username']+' private note'}})
            chat_store.append(original,'fixture-thread',{'content':'private question'},'private answer','fixture','fixture')
            parse=owned.start(session,'parse');pages=reading_core.parse_pdf(owned.pdf());owned.parsed(parse,pages)
            claim={'text':'fixture only','source':'paper','citations':[{'page':1,'quote':pages[0][:40],'paper_id':pid,'sha256':owned.row()['sha256']}]}
            report=owned.start(session,'report');owned.candidate(report,{'sections':{k:[claim] for k in ('research_question','method','results','limitations')}});owned.commit_result(report)
            qa=owned.start(session,'qa','fixture question');owned.candidate(qa,{'claims':[claim]});owned.commit_result(qa)
            fixtures.append((client,pid,report,qa,owned.state()))
        for owner,pid,report,qa,before in fixtures:
            attacker=self.b if owner is self.a else self.a
            for path in (f'/p/{pid}/source.pdf',f'/api/p/{pid}/state',f'/api/p/{pid}/chat',f'/api/pdf-reader/{pid}/chat',f'/api/reading/{pid}',f'/api/reading/{pid}/reference?task={report}&index=0'):
                self.assertEqual(404,self.request(attacker,path)[0])
            for path,body in ((f'/api/reading/{pid}/save',{'task':qa}),(f'/api/reading/{pid}/paper-note',{'body':'attack','revision':0}),(f'/api/reading/{pid}/delete',{'confirm':True}),(f'/api/p/{pid}/item',{'tags':['attack']})):
                self.assertEqual(404,self.request(attacker,path,body)[0])
            self.assertEqual(before,self.runtime.db.workspace(before['tasks'][0]['user_id'],pid).state())

    def test_historical_experimental_pdf_assets_require_their_owner(self):
        import hashlib
        from easyread.store import write_json_atomic
        case=self.home/'.pdf-dual-experiments'/'old-case';(case/'assets').mkdir(parents=True)
        (case/'assets'/'source.pdf').write_bytes(self.pdf)
        write_json_atomic(case/'manifest.json',{'id':'old-case','reference_schema':pdf_dual.CONTRACT,'assets':{'source':{'filename':'source.pdf','sha256':hashlib.sha256(self.pdf).hexdigest()}}})
        route='/experiments/pdf-dual/old-case/assets/source'
        status,body=self.request(self.a,route);self.assertEqual(200,status);self.assertEqual(self.pdf,body)
        self.assertEqual(404,self.request(self.b,route)[0])

    def test_persistent_connection_uses_each_new_body_and_account(self):
        import http.client
        conn=http.client.HTTPConnection('127.0.0.1',self.httpd.server_port,timeout=15);self.addCleanup(conn.close)
        cookie='';csrf=''
        def post(path,value):
            conn.request('POST',path,body=json.dumps(value).encode(),headers={'Content-Type':'application/json','X-EasyRead':'app','X-CSRF':csrf,'Cookie':cookie})
            response=conn.getresponse();body=json.loads(response.read());return response.status,body,response.getheader('Set-Cookie')
        status,login,header=post('/api/login',{'username':'alice','password':'test-only-password'});self.assertEqual(200,status)
        csrf=login['csrf'];cookie=header.split(';',1)[0];socket=conn.sock
        self.assertEqual(200,post('/api/editor-state',{'dirty':True})[0])
        for revision,text in enumerate(('first saved note','second saved note')):
            status,saved,_=post('/api/reading/'+self.pid+'/paper-note',{'body':text,'revision':revision})
            self.assertEqual(200,status);self.assertEqual(revision+1,saved['revision']);self.assertIs(conn.sock,socket)
        status,login,header=post('/api/login',{'username':'bob','password':'test-only-password'});self.assertEqual(200,status);self.assertEqual('bob',login['username'])
        csrf=login['csrf'];cookie=header.split(';',1)[0]
        self.assertEqual(404,post('/api/reading/'+self.pid+'/paper-note',{'body':'unauthorized','revision':2})[0])


if __name__=='__main__':unittest.main()
