"""Reading reports and background extraction on the original App records."""
from __future__ import annotations

import copy
import json
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

from . import reading_core
from .account_store import Store, Problem, DataLease


class Service:
    def __init__(self,root,cfg,ai=None,parser=None,store=None):
        self.lease=DataLease(root) if store is None else None
        try:
            self.store=store or Store(root)
            self.store.interrupt()
        except BaseException:
            if self.lease:self.lease.close()
            raise
        self.instance=secrets.token_hex(16)
        self.desktop_token=secrets.token_hex(32)
        self.cfg=cfg
        self.ai=ai or reading_core.AIClient()
        self.parser=parser or reading_core.parse_pdf
        self.pool=ThreadPoolExecutor(max_workers=2,thread_name_prefix='easyread-reading')
        self.lock=threading.RLock()
        self.pending={}
        self.futures={}
        self.closed=False

    def configuration(self):
        return copy.deepcopy(self.cfg() if callable(self.cfg) else self.cfg)

    def info(self):
        return reading_core.service_info(self.configuration())

    def active(self):
        with self.store.connect() as c:
            return c.execute("SELECT 1 FROM tasks WHERE state IN ('queued','running') LIMIT 1").fetchone() is not None

    def logout(self,session):
        with self.lock:
            self.store.logout(session['id'])

    def consent(self,session,fingerprint,scope):
        with self.lock:
            info=self.info()
            if scope not in reading_core.SCOPE or fingerprint!=info['fingerprint']:
                raise Problem('服务或范围已改变，请重新查看说明',409)
            self.store.consent(session,fingerprint,scope)

    def workspace(self,session,pid):
        self.store.session(session['id'])
        return self.store.workspace(session['user_id'],pid)

    def state(self,session,pid):
        ws=self.workspace(session,pid)
        result=ws.state()
        for task in result['tasks']:
            task.pop('session_id',None)
            task.pop('user_id',None)
        with self.lock:
            for task in result['tasks']:
                if task['id'] in self.pending:
                    task.update(state='save_failed',stage='save',error='完整结果尚未保存；请再次保存，不会调用AI',
                                result=self.pending[task['id']])
        try:
            ws.pdf()
            result['identity_ok']=True
            result['identity_warning']=''
        except (Problem,OSError) as e:
            result['identity_ok']=False
            result['identity_warning']=str(e) if isinstance(e,Problem) else '原PDF读取失败；已有记录保留'
        return result

    def import_pdf(self,session,data,filename):
        self.store.session(session['id'])
        ws,fresh=self.store.create(session['user_id'],data,filename)
        tid=None
        if fresh:
            try:
                tid=self.start(session,ws.id,'parse')
            except Exception:
                # Registration has succeeded. A scheduling error must not turn it into an apparent failed import.
                return {'id':ws.id,'new':True,'registered':True,'warning':'原PDF已入库，解析未启动；请在论文中重试解析'}
        return {'id':ws.id,'new':fresh,'registered':True,'task':tid,
                'message':'原PDF已保存并登记；解析状态单独显示' if fresh else '个人库已有完全相同文件，已打开原记录；旧记录未覆盖'}

    def start(self,session,pid,kind,body=None):
        body=body or {}
        if kind not in ('parse','report','qa'):
            raise Problem('未知任务')
        ws=self.workspace(session,pid)
        question=body.get('question','')
        if kind=='qa' and not body.get('retry_of') and (not isinstance(question,str) or not question.strip() or len(question)>4000):
            raise Problem('问题须为1—4000字')
        cfg=None;fingerprint=None
        with self.lock:
            if self.closed:
                raise Problem('应用正在关闭，未启动新任务',409)
            if kind!='parse':
                cfg=self.configuration();info=reading_core.service_info(cfg)
                fingerprint=info['fingerprint']
                self.store.require_consent(session,fingerprint,kind)
                if body.get('retry_of') and body.get('confirm_retry') is not True:
                    raise Problem('重试会再次调用服务，可能再次收费；请先确认',409)
                # Validate actual bytes and bounded input before registering any AI work.
                pages,_=ws.input()
                if sum(map(len,pages))>reading_core.MAX_TEXT:
                    raise Problem('文本超过180,000字符处理上限，未调用AI；本地阅读仍可使用',409)
            tid=ws.start(session,kind,question.strip(),body.get('retry_of',''),body.get('expected_report',''))
            try:
                self.futures[tid]=self.pool.submit(self._run,session.copy(),pid,tid,cfg,fingerprint)
            except Exception:
                if kind=='parse': ws.parse_failed(tid,'解析未启动；原文件保留，请手动重试')
                else: ws.task_state(tid,'interrupted','queued','任务未启动，请手动重试')
                raise Problem('任务未启动，请手动重试',503) from None
        return tid

    def _run(self,session,pid,tid,cfg,fingerprint):
        ws=self.store.workspace(session['user_id'],pid)
        t=ws.task(tid)
        try:
            ws.task_state(tid,'running','parse' if t['kind']=='parse' else 'generate')
            if t['kind']=='parse':
                pages=self.parser(ws.pdf())
                ws.parsed(tid,pages)
                return
            pages,sha=ws.input()
            history=[]
            if t['kind']=='qa':
                history=[{'question':x['question'],'answer':x['result']['claims']} for x in ws.state()['tasks']
                         if x['kind']=='qa' and x['state']=='completed' and x.get('result')][-5:]
            text=reading_core.prompt(t['kind'],pages,t['question'],history)
            @contextmanager
            def dispatch():
                with self.lock:
                    if self.closed:
                        raise Problem('应用正在关闭，停止后续调用',409)
                    current=reading_core.service_info(self.configuration())
                    if current['fingerprint']!=fingerprint:
                        raise Problem('AI服务配置已改变，停止调用；需重新同意',409)
                    self.store.require_consent(session,fingerprint,t['kind'])
                    yield
            started=time.time()
            raw=self.ai.generate(cfg,text,dispatch)
            # A single already-dispatched request may complete after logout. No follow-up calls occur.
            result=reading_core.validate(raw,t['kind'],pages,pid,sha)
            finished=time.time()
            result['generation']={'started':started,'finished':finished,'seconds':round(finished-started,4),
                                  'service':reading_core.service_info(cfg)['service'],
                                  'model':reading_core.service_info(cfg)['model'],'scope':reading_core.SCOPE[t['kind']],
                                  'input_characters':sum(map(len,pages)),'prompt_sha256':__import__('hashlib').sha256(text.encode()).hexdigest()}
            with self.lock:
                self.pending[tid]=result
            self._save(ws,tid,result)
        except Exception as e:
            with self.lock:
                has_result=tid in self.pending
            if has_result:
                # Pending full output remains available for a save-only retry, even if the candidate write failed.
                try: ws.task_state(tid,'save_failed','save','完整结果保存失败；旧数据保留，再次保存不调用AI')
                except Exception: pass
                return
            message=str(e) if isinstance(e,Problem) else '处理失败，既有数据保留；请手动重试'
            try:
                if t['kind']=='parse':
                    ws.parse_failed(tid,message)
                else:
                    state='interrupted' if isinstance(e,Problem) and e.status==401 else 'failed'
                    ws.task_state(tid,state,'generate',message+'；收费状态未知，重试可能再次收费')
            except Exception:
                # Database unavailable: persisted running state becomes interrupted at next startup.
                pass

    def _save(self,ws,tid,result):
        with self.lock:
            # Serialize duplicate save requests and deletion with process-local candidate memory.
            ws.task(tid)
            ws.candidate(tid,result)
            ws.commit_result(tid)
            self.pending.pop(tid,None)

    def save_again(self,session,pid,tid):
        ws=self.workspace(session,pid)
        t=ws.task(tid)
        with self.lock:
            candidate=self.pending.get(tid)
            if candidate is None:
                candidate=next((x.get('result') for x in ws.state()['tasks'] if x['id']==tid),None)
            if t['state']=='completed':
                return
            if candidate is None:
                raise Problem('没有完整的待保存结果；失败生成须手动重试',409)
            self._save(ws,tid,candidate)

    def delete(self,session,pid):
        ws=self.workspace(session,pid)
        with self.lock:
            tids=[t['id'] for t in ws.state()['tasks']]
            ws.delete()
            for tid in tids:
                self.pending.pop(tid,None)

    def wait(self,tid,timeout=20):
        self.futures[tid].result(timeout=timeout)

    def close(self):
        with self.lock:
            self.closed=True
        self.pool.shutdown(wait=True)
        if self.lease:self.lease.close()
