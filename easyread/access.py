"""Identity, ownership and session-bound AI dispatch for the original App."""
from __future__ import annotations

import copy
import json
import secrets
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from . import config,chat_models,reading_core
from .account_store import DataLease,Problem
from .database import Database,Library
from .reading_service import Service as ReadingService

_AI_GATE=ContextVar('easyread_ai_gate',default=None)
_SESSION=ContextVar('easyread_request_session',default=None)
_RUNTIME=ContextVar('easyread_request_runtime',default=None)
_PAPER=ContextVar('easyread_request_paper',default=None)

def current_runtime():return _RUNTIME.get()
def current_paper():return _PAPER.get()

def isolated_codex(settings):
    """Keep the chosen model/effort while excluding host tools and memories."""
    import re,tomllib
    value=copy.deepcopy(settings);args=list(value.get('extra_args') or [])
    for feature in ('shell_tool','apps','plugins','remote_plugin','memories','multi_agent','hooks','skill_search','computer_use','browser_use','image_generation','code_mode','view_image'):
        args+=['-c','features.'+feature+'=false']
    args+=['-c','features.skip_host_skill_discovery=true','-c','project_doc_max_bytes=0','-c','web_search="disabled"']
    try:
        host=tomllib.loads((Path.home()/'.codex/config.toml').read_text())
        for name in host.get('mcp_servers',{}):
            if re.fullmatch(r'[A-Za-z0-9_-]+',name):args+=['-c','mcp_servers.'+name+'.enabled=false']
    except (OSError,ValueError):pass
    value.update(extra_args=args,_account_isolated=True)
    return value


def current_authority():
    return _SESSION.get(),_AI_GATE.get()


@contextmanager
def request_scope(session,gate=None,runtime=None,paper=None):
    token=_SESSION.set(session)
    runtime_token=_RUNTIME.set(runtime)
    paper_token=_PAPER.set(paper)
    try:
        with ai_scope(gate):yield
    finally:_SESSION.reset(token);_RUNTIME.reset(runtime_token);_PAPER.reset(paper_token)


def check_ai_dispatch(cfg=None):
    gate=(cfg or {}).get('_ai_gate') or _AI_GATE.get()
    if gate:gate()


@contextmanager
def ai_scope(gate):
    token=_AI_GATE.set(gate)
    try:yield
    finally:_AI_GATE.reset(token)


SCOPES={
 'chat':'当前论文的原文、已有译文、本次问题、选中片段、最近对话及你主动附加的图片；不发送其他论文或其他账号资料',
 'chat-notes':'当前论文的原文、已有译文、本次问题、最近对话、选中片段、你主动附加的图片，以及本次问题涉及的当前论文批注或笔记；不发送其他论文或其他账号资料',
 'translation':'当前论文原文、原页图、已有译文及术语上下文，用于你主动发起的翻译；不发送其他论文或其他账号资料',
 'selection':'当前选中文字与所在论文的必要上下文，用于你主动发起的选词翻译；不发送其他论文或其他账号资料',
 'service-test':'你主动点击试译时的一段内置公开测试文字，不发送论文或笔记',
}


class Runtime:
    def __init__(self,cfg):
        self.cfg=cfg;self.home=config.HOME.resolve();self.root=self.home/'.easyread'
        self.lease=DataLease(self.root)
        try:self.db=Database(self.root,self.home)
        except BaseException:self.lease.close();raise
        self.reading=ReadingService(self.root,config.load,store=self.db)
        self.users={};self.lock=threading.RLock();self.desktop_token=secrets.token_hex(32)
        self.instance=secrets.token_hex(16)
        self.drafts={}
        self.chat_pending={}
        self.native_proxies={}

    def user(self,session):
        uid=session['user_id']
        with self.lock:
            if uid not in self.users:
                from .server import App
                app=App(self.cfg,library=Library(self.db,uid),home=self.db.user_home(uid))
                app.runtime=self;app.user_id=uid
                self.users[uid]=app
            return self.users[uid]

    def ai_info(self,scope,model=None):
        if scope in ('report','qa'):
            info=self.reading.info();info['scope']=scope;info['description']=info['scopes'][scope];return info
        cfg=config.load()
        if scope=='native':
            from . import pdf_reader,pdf_translation
            from types import SimpleNamespace
            home=Path(__import__('os').environ.get('EASYREAD_HJFY_HOME') or Path.home()/'Library/Application Support/HJFY')
            chosen=next((m for m in pdf_translation.choices(SimpleNamespace(hjfy=home)) if m['id']==model),None)
            if not chosen:raise Problem('请选择已配置的幻觉翻译模型连接')
            info=reading_core.service_info({**cfg,'engine':'openai','openai':{'base_url':chosen['base_url'],'model':chosen['model']}})
            return {**info,'scope':scope,'description':'当前PDF原文、页图与版式信息，用于主动发起的幻觉翻译；不发送其他论文、笔记或对话'}
        if scope=='selection':
            from . import selection_translation
            selected=selection_translation.settings(cfg)
            if selected['engine']=='codex':
                cfg={**cfg,'engine':'codex','codex':{**cfg['codex'],'model':selection_translation.codex_model(selected,cfg)}}
            else:cfg={**cfg,'engine':'openai','openai':selected['api']}
        if scope.startswith('chat'):
            cfg,_=chat_models.engine_cfg(cfg,model)
        if cfg.get('engine') in ('codex','openai'):
            info=reading_core.service_info(cfg)
        else:
            from .server import _engine_label
            import hashlib
            engine=cfg.get('engine');selected=cfg.get(engine,{}) if isinstance(cfg.get(engine),dict) else {}
            name=_engine_label(cfg);model_name=selected.get('model') or '由当前服务配置决定（当前无法确认）'
            info={'service':name,'model':model_name,'fingerprint':hashlib.sha256(json.dumps([engine,name,model_name]).encode()).hexdigest(),
                  'fee':'按所配置服务计费，当前无法预估。超时或未收到结果不表示未收费；重试可能再次收费。',
                  'privacy':'内容将发送至配置服务，不承诺服务商的数据保存或使用政策。'}
        return {**info,'scope':scope,'description':SCOPES[scope]}

    def gate(self,session,scope,model=None):
        original=self.ai_info(scope,model)['fingerprint']
        def check():
            if self.ai_info(scope,model)['fingerprint']!=original:raise Problem('服务或模型已改变，请重新同意调用范围',403)
            self.db.require_consent(session,original,scope)
        check()
        return check

    def logout(self,session):
        with self.lock:
            self.db.logout(session['id'])
            self.drafts.pop(session['id'],None)
            for token,value in list(self.native_proxies.items()):
                if value['session']['id']==session['id']:
                    value['cancel'].touch();self.native_proxies.pop(token,None)

    def close(self):
        for value in self.native_proxies.values():value['cancel'].touch()
        self.reading.close()
        for app in self.users.values():
            app.jobs.close();app.selection.close()
        self.db.close();self.lease.close()
