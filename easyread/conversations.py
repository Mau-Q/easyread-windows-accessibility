"""Failure-aware persistence for the existing streaming chat panels."""
from __future__ import annotations

import copy
import json
import time

from . import chat_store
from .account_store import Problem


class Attempt:
    def __init__(self,handler,workspace,thread,user,model_id,label):
        self.handler,self.ws=handler,workspace
        self.runtime=getattr(getattr(handler,'app',None),'runtime',None)
        self.id=None
        if not self.runtime:return
        self.pid=handler.path.split('/')[3]
        self.owned=self.runtime.db.workspace(handler.session['user_id'],self.pid)
        self.id=self.owned.start(handler.session,'chat',user['content'])
        self.value={'thread':thread,'user':copy.deepcopy(user),'model_id':model_id,'model':label,
                    'answer':'','complete':False,'surface':'pdf' if '/api/pdf-reader/' in handler.path else 'paper'}
        self.runtime.chat_pending[self.id]=self.value
        # Persist the question before dispatch. Incomplete attempts never enter
        # the successful conversation or the next model's history.
        try:
            self.owned.candidate(self.id,self.value)
            self.owned.task_state(self.id,'running','generate')
        except Exception:
            self.owned.task_state(self.id,'failed','prepare','问题登记未完成，未调用AI')
            self.runtime.chat_pending.pop(self.id,None)
            raise

    def complete(self,answer,timing):
        if not self.runtime:return None
        if not answer.strip():raise Problem('服务没有返回完整回答',409)
        self.value.update(answer=answer,timing=timing,complete=True)
        try:return save(self.handler,self.ws,self.id,self.value)
        except Exception:
            try:self.owned.task_state(self.id,'save_failed','save','完整回答尚未保存；再次保存不调用AI')
            except Exception:pass
            raise Problem('完整回答尚未保存；请再次保存，不会调用AI',503) from None

    def fail(self,partial='',interrupted=False):
        if not self.id or self.value.get('complete'):return
        self.value.update(answer=partial,complete=False)
        message='已中断，部分输出未作为成功回答保存' if interrupted else '生成失败，部分输出未作为成功回答保存'
        try:
            self.owned.candidate(self.id,self.value)
            self.owned.task_state(self.id,'interrupted' if interrupted else 'failed','generate',message+'；收费状态未知，重新提问可能再次收费')
            self.runtime.chat_pending.pop(self.id,None)
        except Exception:pass


def save(handler,ws,tid,value=None):
    runtime=handler.app.runtime;owned=runtime.db.workspace(handler.session['user_id'],handler.path.split('/')[3])
    with runtime.lock:
        task=owned.task(tid)
        if task['kind']!='chat':raise Problem('问答记录不存在',404)
        if value is None:
            value=runtime.chat_pending.get(tid)
            if value is None:
                with runtime.db.connect() as c:row=c.execute('SELECT result FROM candidates WHERE task_id=?',(tid,)).fetchone()
                value=json.loads(row['result']) if row else None
        if not value or not value.get('complete'):raise Problem('没有完整待保存回答；重新提问会再次调用AI',409)
        surface='pdf' if '/api/pdf-reader/' in handler.path else 'paper'
        if value['surface']!=surface:raise Problem('问答阅读界面不匹配',409)
        owned.candidate(tid,value)
        message=chat_store.append(ws,value['thread'],{**value['user'],'request_id':tid},value['answer'],value['model_id'],value['model'],value.get('timing'))
        owned.task_state(tid,'completed','saved')
        runtime.chat_pending.pop(tid,None)
        return message


def threads(handler,ws):
    result=copy.deepcopy(chat_store.threads(ws))
    runtime=getattr(handler.app,'runtime',None)
    if not runtime:return result
    owned=runtime.db.workspace(handler.session['user_id'],handler.path.split('/')[3])
    surface='pdf' if '/api/pdf-reader/' in handler.path else 'paper'
    state=owned.state()
    with runtime.lock:
        for task in state['tasks']:
            if task['kind']!='chat' or task['state']=='completed':continue
            value=runtime.chat_pending.get(task['id']) or task.get('result')
            if not value or value.get('surface')!=surface:continue
            thread=next((t for t in result if t['id']==value['thread']),None)
            if not thread:
                thread={'id':value['thread'],'title':value['user']['content'][:22],'messages':[],'updated':value['user'].get('at','')};result.insert(0,thread)
            if any(m.get('request_id')==task['id'] for m in thread['messages']):continue
            error=task['error'] or '应用重启，任务已中断；未作为成功回答保存'
            thread['messages'].extend([{**value['user'],'role':'user'},
              {'id':task['id'],'role':'assistant','content':value.get('answer',''),'model':value['model'],'error':error,
               'at':value['user'].get('at',''),'save_task':task['id'] if value.get('complete') else None}])
            thread['updated']=max(thread.get('updated',''),value['user'].get('at',''))
            # Keep each question with its answer, including a failed attempt
            # followed by a later successful retry in the same old panel.
            pairs=[];messages=thread['messages'];i=0
            while i<len(messages):
                size=2 if messages[i].get('role')=='user' and i+1<len(messages) and messages[i+1].get('role')=='assistant' else 1
                pairs.append(messages[i:i+size]);i+=size
            pairs.sort(key=lambda pair:pair[0].get('at',''))
            thread['messages']=[message for pair in pairs for message in pair]
    return sorted(result,key=lambda thread:thread.get('updated',''),reverse=True)
