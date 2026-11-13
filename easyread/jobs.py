"""后台任务：导入后的渲染与整篇翻译（一条队列，状态落在每篇的 job.json，重启后接着做），
以及“让模型回答我的问题 / 重译这段”这类小任务（另一条队列，不用等整篇翻译）。"""
from __future__ import annotations

import queue
import threading
import time

from . import arxivhtml, config, pdfmatch, translate, pdf_pipeline
from .engines import Cancelled, EngineError
from .library import Library
from .log import log
from .store import Workspace, now_iso


class Jobs:
    def __init__(self, lib: Library):
        self.lib = lib
        self.bulk: queue.Queue[str] = queue.Queue()
        self.small: queue.Queue[dict] = queue.Queue()
        self.cancels: dict[str, threading.Event] = {}
        self.recent: list[dict] = []  # 小任务的状态，给页面轮询
        self.lock = threading.Lock()
        self.authorities = {}
        self.access_tasks = {}
        self.closed=threading.Event()
        self.workers=[]
        for target in (self._bulk_loop, self._small_loop):
            worker=threading.Thread(target=target,daemon=True)
            self.workers.append(worker);worker.start()
        self._resume()

    # ---------- 整篇 ----------
    def _write(self, ws: Workspace, **fields):
        def apply(job):
            job.update(fields)
            job["updated"] = now_iso()
        ws.update("job", apply)

    def _queue_write(self,ws,**fields):
        try:self._write(ws,**fields)
        except Exception:
            tid=self.access_tasks.pop(ws.id,None);self.authorities.pop(ws.id,None)
            if tid:self.lib.database.workspace(self.lib.user_id,ws.id).task_state(tid,'failed','queued','任务状态保存失败，未启动处理；请手动重试')
            raise

    def enqueue(self, ws: Workspace, pages: list[int] | None = None, translate_after: bool = True, scope: str | None = None,
                prefer_html=False, web_scope="abstract", accept_candidate=False, match_only=False):
        """pages=None：按 scope（all / body / first:N）翻译还没译的页。"""
        if (ws.load("job") or {}).get("state") in ("queued", "running"):
            raise ValueError("这篇论文已有任务在运行，可先取消再开始")
        self._access_begin(ws, translate_after)
        self._queue_write(ws, type="translate" if translate_after else "prepare", state="queued", message="排队中",
                    pages=pages, scope=scope or "all", translate=translate_after, done=0, total=0, error="", failed={},
                    prefer_html=bool(prefer_html), web_scope=web_scope, accept_candidate=bool(accept_candidate), match_only=bool(match_only))
        self.bulk.put(ws.id)

    def cancel(self, pid: str):
        ev = self.cancels.get(pid)
        if ev:
            ev.set()
        ws = self.lib.ws(pid)
        if ws and (ws.load("job") or {}).get("state") == "queued":
            self._write(ws, state="cancelled", message="已取消")
            self._access_finish(ws)

    def enqueue_html(self, ws: Workspace, translate_after=True, scope="all", retry=False, fast=False):
        job = ws.load("job") or {}
        if job.get("state") in ("queued", "running"):
            raise ValueError("这篇论文已有任务在运行，可先取消再开始")
        self._access_begin(ws, translate_after)
        retry_ids = list(job.get("failed", {})) if retry else []
        self._queue_write(ws, type="translate" if translate_after else "prepare", state="queued", message="排队中",
                    translate=translate_after, scope=scope or "all", retry=retry, retry_ids=retry_ids, fast=bool(fast),
                    done=0, total=0, unit="段", error="", failed={})
        self.bulk.put(ws.id)

    def _resume(self):
        for ws in self.lib.all():
            job = ws.load("job") or {}
            if job.get("state") in ("queued", "running"):
                if hasattr(self.lib,'database'):
                    self._write(ws,state='interrupted',message='应用重启，任务已中断；请手动重试，AI重试可能再次收费')
                    continue
                self._write(ws, state="queued", message="排队中（服务重启后继续）")
                self.bulk.put(ws.id)

    def _bulk_loop(self):
        while True:
            pid = self.bulk.get()
            if pid is None:return
            ws = self.lib.ws(pid)
            if not ws:
                continue
            job = ws.load("job") or {}
            if job.get("state") != "queued":
                self._access_finish(ws)
                continue
            if self.closed.is_set():
                self._write(ws,state='interrupted',message='应用关闭，未启动任务')
                self._access_finish(ws)
                continue
            cancel = self.cancels[pid] = threading.Event()
            try:
                from .access import request_scope
                session,gate=self.authorities.get(pid,(None,None))
                with request_scope(session,gate):
                    self._run_bulk(ws, job, cancel)
            except Cancelled:
                self._write(ws, state="cancelled", message="已取消，已译的部分保留")
            except Exception as e:  # noqa: BLE001
                msg = str(e) if isinstance(e, (EngineError, KeyError, ValueError)) else f"{type(e).__name__}: {e}"
                self._write(ws, state="error", message="出错了", error=msg[:800])
                log.exception("后台任务出错 %s", pid)
                try:
                    translate.journal(ws, f"出错停止：{msg[:500]}")
                except OSError:
                    pass
            finally:
                self._access_finish(ws)
                self.cancels.pop(pid, None)

    def _access_begin(self,ws,uses_ai):
        if not hasattr(self.lib,'database'):return
        from .access import current_authority
        from .account_store import ident,Problem
        session,gate=current_authority()
        if not session:raise Problem('后台任务缺少登录身份',401)
        if uses_ai and not gate:raise Problem('尚未同意当前AI调用范围',403)
        db=self.lib.database;tid=ident()
        with db.transaction() as c:
            row=db.workspace(self.lib.user_id,ws.id).mutable(c)
            db._live_session(c,session)
            if c.execute("SELECT 1 FROM tasks WHERE paper_id=? AND state IN ('queued','running')",(ws.id,)).fetchone():
                raise Problem('这篇论文正在处理，请等待当前任务结束',409)
            c.execute('''INSERT INTO tasks(id,paper_id,user_id,session_id,kind,state,stage,input_sha,created)
                VALUES(?,?,?,?,?,'queued','queued',?,?)''',(tid,ws.id,self.lib.user_id,session['id'],'legacy' if uses_ai else 'parse',row['sha256'],time.time()))
        self.authorities[ws.id]=(session,gate);self.access_tasks[ws.id]=tid

    def _access_finish(self,ws):
        tid=self.access_tasks.pop(ws.id,None)
        self.authorities.pop(ws.id,None)
        if not tid:return
        db=self.lib.database;owned=db.workspace(self.lib.user_id,ws.id);job=ws.load('job') or {}
        try:
            task=owned.task(tid)
            if job.get('state')=='done':
                if task['kind']=='parse' and (ws.root/'source.pdf').is_file():
                    from .reading_core import parse_pdf
                    owned.parsed(tid,parse_pdf(owned.pdf()))
                else:owned.task_state(tid,'completed','saved')
            else:owned.task_state(tid,'interrupted' if job.get('state') in ('cancelled','interrupted') else 'failed','process',job.get('error') or job.get('message') or '任务未完成')
        except Exception:
            owned.task_state(tid,'failed','parse','本地解析未完成；原PDF与记录保留，可手动重试')

    def _run_bulk(self, ws: Workspace, job: dict, cancel: threading.Event):
        cfg = config.load()
        from .access import current_authority
        cfg['_ai_gate']=current_authority()[1]
        if ws.load("paper").get("meta", {}).get("source_kind") == arxivhtml.KIND:
            return self._run_html(ws, job, cancel, cfg)
        if job.get("prefer_html"):
            self._write(ws, state="running", message="正在查找 arXiv 网页并校验 PDF 版本")
            match = pdfmatch.resolve(self.lib, ws, cancel, job.get("accept_candidate", False))
            ws.update("item", lambda item: item.update(arxiv_match=match))
            if cancel.is_set():
                raise Cancelled()
            if match.get("web_id"):
                web = self.lib.ws(match["web_id"])
                paper = web.load("paper")
                blocks = arxivhtml.translation_blocks(web, paper)
                scope = job.get("web_scope") or "abstract"
                if scope == "abstract":
                    blocks = [b for b in blocks if b.get("role") == "abstract"]
                elif scope.startswith("first:"):
                    blocks = blocks[:max(1, int(scope.split(":", 1)[1]))]
                pending = any(not b.get("zh") for b in blocks)
                if job.get("translate") and pending and (web.load("job") or {}).get("state") not in ("queued", "running"):
                    self.enqueue_html(web, scope=job.get("web_scope") or "abstract")
                self._write(ws, state="done", message=match["message"])
                return
            if job.get("match_only"):
                self._write(ws, state="done", message=match["message"])
                return
        if cfg.get("pdf_web_enabled") and not job.get("match_only") and not job.get("pages") and job.get("scope","all")=="all" and (ws.root / "source.pdf").is_file():
            source = self.lib.ws(ws.load("paper").get("meta", {}).get("original_id", "")) or ws
            def report(done, total, message):
                self._write(ws, state="running", done=done, total=total, message=message)
            target, evidence = pdf_pipeline.prepare(self.lib, source, cfg, cancel, report, job.get("translate", True))
            self._write(ws, state="done" if evidence["complete"] else "partial", failed=evidence["failed"],
                        error="" if evidence["complete"] else "自动审查与修复结果已保存；仍待确认的内容保持原 PDF 展示",
                        message="PDF 双语阅读已就绪" if evidence["complete"] else "PDF 准备结果已保存", read_id=target.id)
            return
        if not ws.load("paper").get("meta", {}).get("pages"):
            self._write(ws, state="running", message="正在渲染原页、抽取文字")
            translate.prepare(ws)
        if not job.get("translate") or cfg.get("engine") == "none":
            self._write(ws, state="done", message="已导入" + ("（未开启自动翻译）" if job.get("translate") else ""))
            return
        paper = ws.load("paper")
        all_pages = [p["n"] for p in paper["meta"]["pages"]]
        done_pages = set(paper.get("translation", {}).get("done_pages", []))
        wanted = job.get("pages") or translate.scope_pages(ws, job.get("scope")) or all_pages
        pages = wanted if job.get("pages") else [n for n in wanted if n not in done_pages]
        if not pages:
            self._write(ws, state="done", message="选定范围已译完")
            return

        def report(done, total, message):
            if cancel.is_set():
                raise Cancelled()
            self._write(ws, state="running", done=done, total=total, message=message)

        started = time.time()
        failed = translate.translate_pages(ws, cfg, pages, cancel, report)
        minutes = max(1, round((time.time() - started) / 60))
        if failed:
            first = next(iter(failed.values()))
            self._write(ws, state="partial", failed={str(k): v for k, v in failed.items()}, error=first,
                        message=(f"{len(pages) - len(failed)} 页译好了，" if len(failed) < len(pages) else "") + f"{len(failed)} 页没译成功")
        else:
            self._write(ws, state="done", failed={}, error="", message=f"翻译完成（{len(pages)} 页，用时约 {minutes} 分钟）")

    def _run_html(self, ws, job, cancel, cfg):
        arxivhtml.verify(ws)
        if job.get("fast"):
            # 快速入口也使用已验证的配置，不暗中增加每批大小或更换推理强度。
            cfg = dict(cfg, html_adaptive=True)
        if not job.get("translate") or cfg.get("engine") == "none":
            self._write(ws, state="done", message="已导入 arXiv 网页原文")
            return

        def report(done, total, message):
            if cancel.is_set():
                raise Cancelled()
            self._write(ws, state="running", done=done, total=total, unit="段", message=message)

        failed = arxivhtml.translate(ws, cfg, job.get("scope") or "all", cancel, report, job.get("retry", False))
        if failed:
            self._write(ws, state="partial", failed=failed, error=next(iter(failed.values())),
                        message=f"{len(failed)} 段未译成功，已保存其余译文")
        else:
            self._write(ws, state="done", failed={}, error="", message="所选范围翻译完成")

    # ---------- 小任务 ----------
    def submit_small(self, kind: str, pid: str, **kw) -> dict:
        ws=self.lib.ws(pid)
        if not ws:raise ValueError('论文不存在')
        self._access_begin(ws,True)
        job = {"id": f"j{int(time.time() * 1000)}", "kind": kind, "pid": pid, "state": "queued", "message": "排队中",
               "at": now_iso(), **kw}
        with self.lock:
            self.recent = ([job] + self.recent)[:50]
        self.small.put(job)
        return job

    def small_status(self, pid: str | None = None) -> list[dict]:
        with self.lock:
            return [dict(j) for j in self.recent if not pid or j["pid"] == pid]

    def _small_loop(self):
        while True:
            job = self.small.get()
            if job is None:return
            ws = self.lib.ws(job["pid"])
            if not ws:
                continue
            job["state"], job["message"] = "running", "模型思考中"
            try:
                cfg = config.load()
                from .access import request_scope
                session,gate=self.authorities.get(ws.id,(None,None))
                cfg['_ai_gate']=gate
                if self.closed.is_set():raise Cancelled()
                with request_scope(session,gate):
                    if job["kind"] == "answer":
                        translate.answer(ws, cfg, job["note"], None)
                    elif job["kind"] == "retranslate":
                        translate.retranslate(ws, cfg, job["key"], job.get("hint", ""), None)
                job["state"], job["message"] = "done", "完成"
            except Exception as e:  # noqa: BLE001
                job["state"], job["message"] = "error", str(e)[:500]
                log.exception("小任务出错 %s", job.get("kind"))
            finally:
                tid=self.access_tasks.pop(ws.id,None);self.authorities.pop(ws.id,None)
                if tid:self.lib.database.workspace(self.lib.user_id,ws.id).task_state(tid,'completed' if job['state']=='done' else 'failed','saved' if job['state']=='done' else 'generate',job.get('message',''))

    def close(self):
        self.closed.set()
        for event in self.cancels.values():event.set()
        self.bulk.put(None);self.small.put(None)
        for worker in self.workers:worker.join(timeout=30)
