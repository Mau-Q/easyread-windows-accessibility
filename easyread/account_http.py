"""Authentication and new reading operations on the existing HTTP handler chain."""
from __future__ import annotations

import copy
import hashlib
import hmac
import json
import re
import secrets
import time
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs,urlparse,unquote,urlencode

from . import config,prefs,chat,reading_core
from .access import request_scope
from .account_store import Problem,MAX_PDF
from .store import read_json,write_json_atomic,now_iso

COOKIE='easyread_session'


class RequestApp:
    def __init__(self,app,session):
        object.__setattr__(self,'_app',app);object.__setattr__(self,'token',session['csrf'])
        object.__setattr__(self,'session',session)
    def __getattr__(self,name):return getattr(self._app,name)
    def __setattr__(self,name,value):setattr(self._app,name,value)


def handler_for(base,runtime):
    class Handler(base):

        def _session(self):
            jar=SimpleCookie()
            try:jar.load(self.headers.get('Cookie',''))
            except Exception:raise Problem('请登录',401) from None
            return runtime.db.session(jar[COOKIE].value if COOKIE in jar else '')

        def _send(self,code,body,ctype,cache=False,headers=None):
            headers=dict(headers or {})
            headers.update({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'})
            if getattr(self,'session',None):headers['X-EasyRead-Session']=self.session['csrf']
            return super()._send(code,body,ctype,cache=False,headers=headers)

        def _body(self,limit=MAX_PDF):
            if hasattr(self,'body_cache'):
                if len(self.body_cache)>limit:raise Problem('请求超过大小上限',413)
                return self.body_cache
            if self.headers.get('Transfer-Encoding'):raise Problem('不支持分块上传',400)
            try:size=int(self.headers.get('Content-Length','0'))
            except ValueError:raise Problem('请求长度无效') from None
            if not 0<=size<=limit:
                if limit<size<=limit+1_000_000:self.rfile.read(size)
                raise Problem(f'上传上限为{limit:,}字节',413)
            self.body_cache=self.rfile.read(size)
            if len(self.body_cache)!=size:raise Problem('请求未完整接收')
            return self.body_cache

        def _data(self):
            try:data=json.loads(self._body() or b'{}')
            except (ValueError,UnicodeError):raise Problem('请求JSON无效') from None
            if not isinstance(data,dict):raise Problem('请求须为JSON对象')
            return data

        def _origin(self):
            host=self.headers.get('Host','')
            if host not in (f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'):
                raise Problem('无效主机',403)
            if self.headers.get('Origin') not in (None,'http://'+host) or self.headers.get('Sec-Fetch-Site')=='cross-site':
                raise Problem('跨站请求已拒绝',403)

        def _dispatch(self,write=False):
            # BaseHTTPRequestHandler serves multiple requests on one socket.
            # This cache belongs to one request, never the connection/session.
            self.__dict__.pop('body_cache',None)
            self.session=None
            try:
                self._origin()
                path=unquote(urlparse(self.path).path)
                if write and path.startswith('/native-proxy/'):
                    return self._native_proxy(path)
                if not write and path=='/api/health':
                    return self._json(200,{'version':'easyread-accounts-1','instance':runtime.instance})
                if not write and path=='/api/desktop/status':
                    if not hmac.compare_digest(self.headers.get('X-Desktop-Token',''),runtime.desktop_token):raise Problem('无权读取全局任务状态',403)
                    active=runtime.reading.active() or any(j.get('state') in ('queued','running') for app in runtime.users.values() for j in app.small_status())
                    return self._json(200,{'active':bool(active),'dirty':any(runtime.drafts.values())})
                if not write and path=='/api/setup':return self._json(200,{'original_pending':runtime.db.original_pending()})
                if write and path in ('/api/register','/api/login'):
                    if self.headers.get('X-EasyRead')!='app':raise Problem('请求来源校验失败',403)
                    data=self._data()
                    if path=='/api/register':
                        with runtime.lock:
                            adopt=runtime.db.original_pending()
                            if adopt and data.get('accept_original') is not True:
                                raise Problem('首次设置账号需确认现有本机文献与阅读记录归属；原文件保留',409)
                            user=runtime.db.register(data.get('username'),data.get('password'))
                            with runtime.db.connect() as c:first=c.execute("SELECT 1 FROM application WHERE key='original_owner'").fetchone() is None
                            if first:
                                try:runtime.db.adopt_original(user['id'])
                                except Exception:
                                    with runtime.db.transaction() as c:c.execute('DELETE FROM users WHERE id=?',(user['id'],))
                                    with runtime.db._roots_lock:runtime.db._roots={p:u for p,u in runtime.db._roots.items() if u!=user['id']}
                                    raise
                        return self._json(201,{'username':user['username'],'original_assigned':adopt})
                    previous=None
                    try:previous=self._session()
                    except Problem:pass
                    session=runtime.db.login(data.get('username'),data.get('password'))
                    if previous:runtime.logout(previous)
                    self.session=session
                    return self._send(200,json.dumps({'username':session['username'],'csrf':session['csrf']}).encode(),'application/json; charset=utf-8',headers={
                        'Set-Cookie':f'{COOKIE}={session["id"]}; Path=/; HttpOnly; SameSite=Strict'})
                try:self.session=self._session()
                except Problem:
                    if not write and path in ('/','/login'):
                        return super()._file(config.WEB/'login.html')
                    if not write and (path.startswith(('/web/css/','/web/js/common/account-login')) or path in ('/web/favicon.svg','/web/js/common/accessibility.js')):
                        return self._file_public(path)
                    raise
                self.app=RequestApp(runtime.user(self.session),self.session)
                resource=re.match(r'^/(?:api/p|api/pdf-reader|api/reading-history|api/reading|p|read)/([A-Za-z0-9_-]+)(?:/|$)',path)
                if resource and not self.app.lib.ws(resource[1]):
                    raise Problem('论文不存在或无权访问',404)
                if write and resource and not path.endswith('/delete'):
                    with runtime.db.connect() as c:runtime.db.workspace(self.session['user_id'],resource[1]).mutable(c)
                if write:
                    token=self.headers.get('X-CSRF') or self.headers.get('X-Token','')
                    if not hmac.compare_digest(token,self.session['csrf']):raise Problem('会话校验失败，请重新打开页面',403)
                if not write and path=='/api/session':return self._json(200,{'username':self.session['username'],'csrf':self.session['csrf']})
                if write and path=='/api/editor-state':
                    runtime.drafts[self.session['id']]=self._data().get('dirty') is True
                    return self._json(200,{'ok':True})
                if write and path=='/api/logout':
                    self._body();runtime.logout(self.session)
                    return self._send(200,b'{"ok":true}','application/json',headers={'Set-Cookie':f'{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'})
                if write and path=='/api/consent':
                    data=self._data();scope=data.get('scope')
                    from .access import SCOPES
                    if scope not in (*SCOPES,'report','qa','native'):raise Problem('调用范围无效')
                    info=runtime.ai_info(scope,data.get('model'))
                    if info['fingerprint']!=data.get('fingerprint'):raise Problem('服务或模型已改变，请重新查看说明',409)
                    runtime.db.consent(self.session,info['fingerprint'],scope);return self._json(200,{'ok':True})
                if not write and path=='/api/service':return self._json(200,runtime.reading.info())
                gate=None
                if write:
                    scope,model=self._ai_operation(path)
                    if scope:
                        # Consume this POST before returning a consent challenge.
                        # Otherwise a persistent connection can treat the unread
                        # body as the start of the next request.
                        self._body()
                        try:gate=runtime.gate(self.session,scope,model)
                        except Problem as e:
                            if e.status==403:return self._json(403,{'error':str(e),'code':'consent_required','info':runtime.ai_info(scope,model),'scope':scope,'model':model})
                            raise
                with request_scope(self.session,gate,runtime,resource[1] if resource else None):
                    if write:return self._post_account(path)
                    return self._get_account(path)
            except Problem as e:
                self.close_connection=True;return self._json(e.status,{'error':str(e)})
            except (BrokenPipeError,ConnectionResetError):self.close_connection=True
            except ValueError as e:
                self.close_connection=True;return self._json(400,{'error':str(e)[:300]})
            except Exception:
                self.close_connection=True
                return self._json(503,{'error':'读取或保存失败；未确认成功，既有数据保留。请重试，未保存文字请勿关闭页面'})

        def _file_public(self,path):
            from .server import _safe
            return super()._file(_safe(config.WEB,path[len('/web/'):]))

        def do_GET(self):return self._dispatch()
        def do_POST(self):return self._dispatch(True)

        def _file(self,path,cache=False,headers=None):
            pages={'library.html','pdf-reader.html','arxiv-reader.html','reflow-reader.html','reader.html'}
            if path and path.parent==config.WEB and path.name in pages and self.session:
                text=path.read_text();boot=json.dumps({'username':self.session['username'],'csrf':self.session['csrf']},ensure_ascii=False).replace('<','\\u003c')
                text=text.replace('<head>','<head><script>window.EASYREAD_ACCOUNT='+boot+'</script>',1)
                for source in ('<script src="/web/js/common/util.js"></script>','<script defer src="/web/js/common/util.js"></script>'):
                    if source in text:
                        extra=''
                        if '/web/js/common/confirm.js' not in text:
                            extra='<script '+('defer ' if 'defer' in source else '')+'src="/web/js/common/confirm.js"></script>'
                        text=text.replace(source,source+extra+'<script '+('defer ' if 'defer' in source else '')+'src="/web/js/common/account-session.js"></script>',1)
                text=text.replace('</head>','<link rel="stylesheet" href="/web/css/account-additions.css"></head>')
                text=text.replace('搜索标题、作者、分类、摘要','搜索题名或作者')
                text=text.replace('</body>','<script defer src="/web/js/common/report-panel.js"></script></body>')
                return self._send(200,text.encode(),'text/html; charset=utf-8')
            return super()._file(path,cache=False,headers=headers)

        def _ai_operation(self,path):
            if path in ('/api/import','/api/import-url','/api/import-arxiv'):return None,None
            if path=='/api/config/test':return 'service-test',None
            if path.endswith('/selection-translation'):return 'selection',None
            if path.endswith('/translation/start'):return 'native',self._data().get('model_id')
            if path.endswith(('/translate','/retranslate','/answer','/translation/start')):return 'translation',None
            if path.endswith('/chat') and path.startswith(('/api/p/','/api/pdf-reader/')):
                pid=path.split('/')[3];owned=runtime.db.workspace(self.session['user_id'],pid)
                original=self.app.lib.ws(pid)
                if (original.root/'source.pdf').is_file() and owned.row()['parse_state']!='ready':
                    if owned.row()['parse_state']=='pending':
                        runtime.reading.start(self.session,pid,'parse')
                        raise Problem('已启动本地文字解析；完成后请重新提问，本次未调用AI',409)
                    raise Problem('本地解析尚未成功；请在阅读报告中查看状态或重试解析，本次未调用AI',409)
                data=self._data();want,_=chat.wants_marks(data.get('text',''))
                return ('chat-notes' if want else 'chat'),data.get('model')
            return None,None

        def _native_proxy(self,path):
            # Every provider dispatch is checked, including retries performed by
            # the external PDF engine. The capability lives only in its environment.
            import httpx
            token=self.headers.get('Authorization','').removeprefix('Bearer ')
            with runtime.lock:
                proxy=runtime.native_proxies.get(token)
                if not proxy:raise Problem('翻译授权已结束；未发送后续请求',401)
                proxy['gate']()
                suffix=path.removeprefix('/native-proxy/')
                if suffix not in ('chat/completions','responses','v1/chat/completions','v1/responses'):
                    raise Problem('翻译接口不存在',404)
                body=self._body()
                url=proxy['base_url'].rstrip('/')+'/'+suffix.removeprefix('v1/')
                client=httpx.Client(timeout=600,follow_redirects=False)
                request=client.build_request('POST',url,content=body,headers={'Content-Type':'application/json','Authorization':'Bearer '+proxy['key']})
                try:response=client.send(request,stream=True)
                except Exception:client.close();raise Problem('翻译服务连接失败，未确认收费状态',503) from None
            try:
                self.send_response(response.status_code)
                self.send_header('Content-Type',response.headers.get('Content-Type','application/json'))
                self.send_header('Connection','close');self.send_header('Cache-Control','no-store');self.end_headers();self.close_connection=True
                for chunk in response.iter_raw():self.wfile.write(chunk);self.wfile.flush()
            finally:response.close();client.close()

        def _get_account(self,path):
            if path=='/api/library':
                with runtime.db.document_snapshot(self.session['user_id']):return super()._get()
            if path=='/login':return self._file(config.WEB/'library.html')
            if path=='/api/prefs':return self._json(200,read_json(self.app.home/'prefs.json',{}) or {})
            if path=='/api/log':
                with runtime.db.connect() as c:rows=[{k:r[k] for k in ('id','kind','state','stage','error','created')} for r in c.execute('SELECT * FROM tasks WHERE user_id=? ORDER BY created DESC LIMIT 100',(self.session['user_id'],))]
                return self._json(200,{'text':json.dumps(rows,ensure_ascii=False,indent=2),'path':'当前账号任务记录'})
            if path.startswith('/api/reading/'):
                return self._reading(path,False)
            # Historic experimental PDF assets must also belong to this account.
            from .pdf_dual import PREFIX
            if path.startswith(PREFIX):
                rel=path[len(PREFIX):].split('/')[0]
                target=self.app.home/'.pdf-dual-experiments'/rel/'manifest.json'
                if not target.is_file() or runtime.db.owner_for_path(target)!=self.session['user_id']:raise Problem('没有这份阅读记录',404)
            return super()._get()

        def _post_account(self,path):
            if re.fullmatch(r'/api/(?:p|pdf-reader)/[A-Za-z0-9_-]+/chat/save',path):
                from .conversations import save,threads
                pid=path.split('/')[3]
                ws=self.pdf_service.workspace(pid) if path.startswith('/api/pdf-reader/') else self.app.lib.ws(pid)
                save(self,ws,self._data().get('task',''))
                return self._json(200,{'threads':threads(self,ws)})
            if path=='/api/prefs':
                data=read_json(self.app.home/'prefs.json',{}) or {}
                for key,value in self._data().items():
                    if key in prefs.ALLOWED and isinstance(value,dict):data[key]={**data.get(key,{}),**value}
                write_json_atomic(self.app.home/'prefs.json',data);return self._json(200,data)
            if path in ('/api/config','/api/chat/models','/api/selection-translation/config'):
                with runtime.db.connect() as c:owner=c.execute("SELECT value FROM application WHERE key='original_owner'").fetchone()
                if not owner or owner['value']!=self.session['user_id']:raise Problem('服务配置由本机运行者统一管理；当前账号可选择已配置模型',403)
            if path=='/api/selection-translation/warm':
                self._body();return self._json(200,{'ok':True})
            if path.startswith('/api/reading/'):return self._reading(path,True)
            if path=='/api/import':
                query=parse_qs(urlparse(self.path).query)
                original,fresh=self.app.lib.create_from_pdf(self._body(),query.get('name',['paper.pdf'])[0])
                task=None;warning=''
                if fresh:
                    try:
                        if query.get('prefer_html')==['1']:
                            self.app.jobs.enqueue(original,translate_after=False,prefer_html=True)
                        else:task=runtime.reading.start(self.session,original.id,'parse')
                    except Exception:warning='原文件已保存并登记，解析未启动；请在阅读报告中重试本地解析'
                return self._json(200,{'id':original.id,'new':fresh,'registered':True,'task':task,'warning':warning})
            elif path in ('/api/import-url','/api/import-arxiv'):
                data=self._data();data['translate']=False;self.body_cache=json.dumps(data).encode()
            return super()._post()

        def _reading(self,path,write):
            match=re.fullmatch(r'/api/reading/([A-Za-z0-9_-]{4,64})(?:/(.*))?',path)
            if not match:raise Problem('阅读接口不存在',404)
            pid,action=match.groups();action=action or ''
            original=self.app.lib.ws(pid)
            if not original:raise Problem('论文不存在或无权访问',404)
            ws=runtime.db.workspace(self.session['user_id'],pid)
            if not write:
                if not action:return self._json(200,runtime.reading.state(self.session,pid))
                if action=='reference':
                    query=parse_qs(urlparse(self.path).query);task=query.get('task',[''])[0]
                    t=ws.task(task);state=runtime.reading.state(self.session,pid)
                    result=next((x.get('result') for x in state['tasks'] if x['id']==task),None)
                    if not result:raise Problem('引用结果不存在',404)
                    claims=[v for values in result.get('sections',{}).values() for v in values] if 'sections' in result else result.get('claims',[])
                    refs=[ref for claim in claims for ref in claim['citations']]
                    try:index=int(query.get('index',['-1'])[0]);ref=refs[index]
                    except (ValueError,IndexError):raise Problem('引用不存在',404) from None
                    if index<0 or ref['paper_id']!=pid or ref['sha256']!=ws.row()['sha256']:raise Problem('文件身份不符，引用跳转停用',409)
                    ws.pdf();return self._json(200,{'page':ref['page'],'quote':ref['quote']})
                raise Problem('阅读接口不存在',404)
            data=self._data()
            if action in ('report','qa','parse'):
                scope=action
                if action!='parse':
                    info=runtime.reading.info()
                    try:runtime.db.require_consent(self.session,info['fingerprint'],scope)
                    except Problem as e:
                        if e.status==403:return self._json(403,{'error':str(e),'code':'consent_required','scope':scope,'info':{**info,'scope':scope,'description':info['scopes'][scope]}})
                        raise
                task=runtime.reading.start(self.session,pid,action,data);return self._json(202,{'task':task})
            if action=='save':runtime.reading.save_again(self.session,pid,data.get('task',''));return self._json(200,{'saved':True})
            if action=='delete':
                if data.get('confirm') is not True:raise Problem('请先确认永久删除原PDF及全部关联记录',409)
                runtime.reading.delete(self.session,pid);return self._json(200,{'deleted':True})
            if action=='paper-note':
                # The original PDF reader owns its existing hash workspace; web
                # notes remain in their original paper workspace.
                target=self.pdf_service.workspace(pid) if (original.root/'source.pdf').is_file() else original
                body=data.get('body')
                if not isinstance(body,str) or len(body)>200000:raise Problem('笔记格式无效或超过200,000字')
                with runtime.lock:
                    reader=target.load('reader');revision=reader.get('note_revision',0)
                    if data.get('revision')!=revision:raise Problem('笔记已在另一页面更新，当前文字保留，请核对后保存',409)
                    target.update('reader',lambda record:record.update(paper_note={'body':body,'at':now_iso()},note_revision=revision+1))
                return self._json(200,{'saved':True,'revision':revision+1})
            raise Problem('阅读接口不存在',404)
    return Handler
