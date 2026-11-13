"""本地服务：只监听 127.0.0.1。文献库页、阅读页、数据接口、导入、后台任务。"""
from __future__ import annotations

import json
import mimetypes
import os
import sys
import threading
import time

import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

from . import __version__, arxivhtml, chat, chat_images, chat_models, chat_store, cli_models, config, detect, engines, paperdata, pdfwork, prefs, reflow, selection_translation, pdf_pipeline
from .log import log, setup as setup_log, tail
from .jobs import Jobs
from .library import Library
from .store import now_iso, write_json_atomic

WEB = config.WEB
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
MAX_UPLOAD = 200 * 1024 * 1024


def _safe(base: Path, rel: str) -> Path | None:
    target = (base / rel).resolve()
    return target if target.is_relative_to(base.resolve()) and target.is_file() else None


class App:
    def __init__(self, cfg: dict, library=None, home=None):
        self.home=Path(home or config.HOME)
        self.lib = library or Library(config.library_dir(cfg))
        self.jobs = Jobs(self.lib)
        self.token = os.urandom(12).hex()
        self.chat_lock = threading.Lock()
        self.active_chats = 0
        self.selection = selection_translation.Service(self.home)

    def small_status(self):
        jobs = list(self.jobs.small_status())
        if hasattr(self,'runtime'):
            with self.runtime.db.connect() as c:
                jobs += [{'kind':r['kind'],'state':r['state'],'pid':r['paper_id'],'message':'当前账号任务正在处理'} for r in c.execute("SELECT kind,state,paper_id FROM tasks WHERE user_id=? AND state IN ('queued','running')",(self.user_id,))]
        with self.chat_lock:
            if self.active_chats:
                jobs.append({"kind": "chat", "state": "running", "message": "AI 正在回答"})
        return jobs


class Handler(BaseHTTPRequestHandler):
    app: App
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # ---------- 输出 ----------
    def _send(self, code: int, body: bytes, ctype: str, cache: bool = False, headers: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _file(self, path: Path | None, cache=False, headers=None):
        if not path:
            return self._json(404, {"error": "not found"})
        if path == WEB / 'reflow-reader.html':
            body = path.read_text().replace('/web/vendor/', '/web/renderer/' + reflow.renderer_revision() + '/vendor/')
            return self._send(200, body.encode(), 'text/html; charset=utf-8')
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, path.read_bytes(), ctype, cache, headers)

    def _download(self, body: bytes, filename: str, ctype: str):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", f"attachment; filename=\"export.html\"; filename*=UTF-8''{quote(filename)}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _chat(self, ws, body: dict):
        with self.app.chat_lock:
            self.app.active_chats += 1
        try:
            return self._chat_impl(ws, body)
        finally:
            with self.app.chat_lock:
                self.app.active_chats -= 1

    def _chat_impl(self, ws, body: dict):
        """流式回答：一行一个 JSON，{"t": 片段} … 最后 {"done": true, "id": …} 或 {"error": …}。"""
        started, requested_at = time.monotonic(), now_iso()
        attachments, image_paths = chat_images.resolve(ws, body.get("images") or [])
        text = (body.get("text") or "").strip() or ("请解释所附图片，并结合当前论文上下文。" if attachments else "")
        if not text:
            raise ValueError("问题是空的")
        cfg = config.load()
        ecfg, m = chat_models.engine_cfg(cfg, body.get("model"))
        model = chat_models.label(m, ecfg)
        thread = chat_store.get(ws, body.get("thread"))
        tid = thread["id"] if thread else chat_store.new_id()
        refs = [{"anchor": str(r.get("anchor") or ""), "quote": str(r.get("quote") or "")[:1000]}
                for r in (body.get("refs") or [])[:12] if isinstance(r, dict) and r.get("anchor")]
        first = refs[0] if refs else {}
        user = {"content": text, "anchor": body.get("anchor") or first.get("anchor"), "quote": (body.get("quote") or first.get("quote") or "")[:1000],
                "note": body.get("note"), "refs": refs, "at": requested_at}
        if attachments:
            user["images"] = attachments
        past = (thread or {}).get("messages", [])
        convo = [{"role": x["role"], "content": x["content"]} for x in past] + [{"role": "user", "content": text}]
        prompt_text = chat.prompt(ws, convo, user["anchor"], user["quote"], ecfg["engine"], refs)
        if ecfg["engine"] == "codex" and not thread:
            chat_store.ensure(ws, tid, text, m["id"])
        timing = {"prepare_ms": round((time.monotonic() - started) * 1000, 1), "prompt_chars": len(prompt_text)}
        from .conversations import Attempt
        attempt=Attempt(self,ws,tid,user,m['id'],model)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        cancel = threading.Event()
        pieces: list[str] = []

        def send(obj):
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()
        try:
            send({"model": model, "thread": tid, "images": attachments})
            def seen(actual):
                chat_models.remember(m.get("model", ""), actual)
                if m.get("engine") == "claude":
                    send({"model": chat_models.label(m)})
            def measured(metrics):
                timing["usage"] = metrics["usage"]
                timing["prompt_chars"] = metrics["sent_chars"]
                timing["codex"] = {k: metrics[k] for k in
                                   ("thread_id", "turn_id", "session_reused", "model", "reasoning_effort")}
            def next_input(state):
                return chat.codex_turn(ws, convo, user["anchor"], user["quote"], refs, state)
            for piece in chat.stream(ecfg, prompt_text, ws.root, cancel, seen,
                                     conversation=tid, input_factory=next_input, on_usage=measured, images=image_paths):
                if not piece:
                    continue
                if not pieces:
                    timing["first_token_s"] = round(time.monotonic() - started, 3)
                pieces.append(piece)
                send({"t": piece})
            timing["total_s"] = round(time.monotonic() - started, 3)
            msg = attempt.complete(''.join(pieces),timing) if attempt.id else chat_store.append(ws, tid, user, "".join(pieces), m["id"], model, timing)
            send({"done": True, "id": msg["id"], "timing": timing})
            log.info("问答完成 %s model=%s first=%ss total=%ss prompt=%s chars", ws.id, model,
                     timing.get("first_token_s"), timing["total_s"], timing["prompt_chars"])
            if "usage" in timing:
                log.info("Codex 用量 %s %s", ws.id, json.dumps({"codex": timing["codex"], "usage": timing["usage"]}))
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            cancel.set()  # 读者点了停止或关了页面
            attempt.fail(''.join(pieces),True)
        except engines.Cancelled:
            attempt.fail(''.join(pieces),True)
        except Exception as e:  # noqa: BLE001
            attempt.fail(''.join(pieces))
            log.exception("对话出错 %s", ws.id)
            try:
                send({"error": '完整回答尚未保存；再次保存不调用AI' if attempt.id and attempt.value.get('complete') else '生成失败；收费状态未知，重新提问可能再次收费', 'save_task':attempt.id if attempt.id and attempt.value.get('complete') else None})
            except OSError:
                pass

    def _body(self, limit=MAX_UPLOAD) -> bytes:
        n = int(self.headers.get("Content-Length", "0"))
        if n < 0 or n > limit:
            raise ValueError("文件太大")
        return self.rfile.read(n) if n else b""

    def _selection_translation(self, ws, body):
        service = self.app.selection
        rid = str(body.get("request_id") or os.urandom(12).hex())
        cancel = service.register(rid)
        stream = service.stream(ws, body, config.load(), rid, cancel)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def send(obj):
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()

        # fetch.abort 在尚无输出的推理阶段也能取消，不必等第一片段写入失败。
        finished = threading.Event()
        def disconnected():
            import select
            import socket
            while not finished.wait(.1):
                try:
                    if select.select([self.connection], [], [], 0)[0] and not self.connection.recv(1, socket.MSG_PEEK):
                        service.cancel(rid)
                        return
                except OSError:
                    service.cancel(rid)
                    return
        watcher = threading.Thread(target=disconnected, daemon=True)
        watcher.start()
        try:
            for ev in stream:
                send(ev)
        except engines.Cancelled:
            pass
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            service.cancel(rid)
        except Exception as e:
            # API 异常可能含授权信息，返回已清理的用户消息。
            message = str(e)[:300] if isinstance(e, (ValueError, engines.EngineError)) else "选词翻译失败，请重试"
            try:
                send({"error": message})
            except OSError:
                pass
        finally:
            finished.set()
            cancel.set()
            stream.close()
            service.unregister(rid)

    # ---------- GET ----------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            self._get()
        except Exception as e:  # noqa: BLE001
            log.exception("请求出错 %s", self.path)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _get(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        app, lib = self.app, self.app.lib
        if path in ("/", "/index.html"):
            return self._file(WEB / "library.html")
        if path.startswith("/read/"):
            # The PDF handler owns the two supported reading routes.
            ws = lib.ws(path[6:])
            if ws and ws.load("paper").get("meta", {}).get("source_kind") == arxivhtml.KIND:
                return self._file(WEB / "arxiv-reader.html")
            return self._json(409, {"error": "请使用 PDF 对照或 arXiv 网页阅读入口"})
        if path.startswith('/web/renderer/'):
            parts = path.split('/', 4)
            if len(parts) != 5 or parts[3] != reflow.renderer_revision():
                return self._json(409, {'error': '阅读器版本已经变化，请重新打开阅读页。'})
            if not parts[4].startswith(('vendor/zotero/', 'vendor/katex/')):
                return self._json(404, {'error': 'not found'})
            return self._file(_safe(WEB, parts[4]), cache=False)
        if path.startswith("/web/"):
            return self._file(_safe(WEB, path[5:]), cache=path.startswith("/web/vendor/"))
        if path == "/api/library":
            cfg = config.load()
            return self._json(200, {"items": lib.list(), "token": app.token, "jobs": app.small_status(),
                                    "engine": cfg.get("engine"), "engine_label": _engine_label(cfg),
                                    "first_run": config.is_first_run(), "version": __version__})
        if path == "/api/config":
            return self._json(200, {"config": config.public(config.load()), "presets": config.PRESETS, "groups": config.PRESET_GROUPS})
        if path == "/api/engines":
            cfg = config.load()
            found = detect.detect(cfg, fresh=parse_qs(url.query).get("fresh") == ["1"])
            return self._json(200, {"found": found, "ready": detect.ready(cfg, found), "engine": cfg.get("engine"), "models": cli_models.listing()})
        if path == "/api/prefs":
            return self._json(200, prefs.load())
        if path == "/api/chat/models":
            return self._json(200, chat_models.listing(config.load()))
        if path == "/api/log":
            return self._json(200, {"text": tail(config.LOG_PATH, 200), "path": str(config.LOG_PATH)})
        if path == "/api/jobs":
            return self._json(200, {"jobs": app.jobs.small_status(parse_qs(url.query).get("pid", [None])[0])})
        if path.startswith("/api/p/"):
            parts = path.split("/")  # ['', 'api', 'p', id, action, name?]
            ws = lib.ws(parts[3]) if len(parts) > 4 else None
            if not ws:
                return self._json(404, {"error": "没有这篇论文"})
            action = parts[4]
            if action == "reflow":
                try:
                    if len(parts) > 5 and parts[5] != "state":
                        return self._file(reflow.file(ws, parts[5]))
                    return self._json(200, {**reflow.state(ws), "token": app.token})
                except ValueError as e:
                    return self._json(409, {"error": str(e), "fallback": "/read/" + ws.id + "?source=pdf"})
            if action == "state":
                ws.patch_item({"last_opened": now_iso()})
                if (ws.root / "source.pdf").exists():
                    _warm(ws.root)
                return self._json(200, {
                    **{n: ws.load(n) for n in ("paper", "discussion", "reader", "layout", "item", "job")},
                    "versions": ws.versions(), "token": app.token, "id": ws.id,
                    "engine": config.load().get("engine")})
            if action == "versions":
                return self._json(200, ws.versions())
            if action == "visual-assets":
                return self._json(200, {"assets": arxivhtml.visual_assets(ws)})
            if action == "chat":
                from .conversations import threads
                return self._json(200, {"threads": threads(self,ws), **chat_models.listing(config.load())})
            if action == "log":
                return self._json(200, {"text": tail(ws.root / "job.log", 300)})
            if action == "export":
                if ws.load("paper").get("meta", {}).get("source_kind") == arxivhtml.KIND:
                    return self._download(arxivhtml.export(ws).encode("utf-8"), ws.id + ".html", "text/html; charset=utf-8")
                from .build import build
                out = build(ws)
                return self._download(out.read_bytes(), out.name, "text/html; charset=utf-8")
            if action == "part" and len(parts) > 5 and parts[5] in ("paper", "discussion", "reader", "layout", "job"):
                return self._json(200, {"data": ws.load(parts[5]), "version": ws.versions()[parts[5]]})
        if path.startswith("/p/"):
            _, _, pid, rel = path.split("/", 3)
            ws = lib.ws(pid)
            if ws and rel.startswith("chat-images/") and chat_images.ID_RE.fullmatch(rel.removeprefix("chat-images/")):
                return self._file(_safe(ws.root / "chat-images", rel.removeprefix("chat-images/")))
            if ws and rel.startswith("pages/") and "w=" in url.query:  # 原页面板用的小一号图，第一次请求时生成
                return self._file(pdfwork.page_variant(ws.root, rel, int(parse_qs(url.query)["w"][0])), cache=True)
            if ws and rel == "article.html":
                arxivhtml.verify(ws)
                # WebKit 要 allow-scripts 才会分发父页面注册的事件。
                # CSP 仍禁止论文快照执行任何脚本，仅允许阅读器自己的回调。
                return self._file(_safe(ws.root, rel), headers={
                    "Content-Security-Policy": "script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
                })
            if ws and (rel.split("/", 1)[0] in ("pages", "figures") or rel == "source.pdf"):
                return self._file(_safe(ws.root, rel), cache=rel != "source.pdf")
        return self._json(404, {"error": "not found"})

    # ---------- POST ----------
    def do_POST(self):
        if self.headers.get("X-Token") != self.app.token:  # 挡住别的网页跨站写
            # Rejected bodies must not become the next request on a keep-alive
            # socket. A restarted server issues a new token; the UI retries.
            self.close_connection = True
            return self._json(403, {"error": "bad token"})
        try:
            self._post()
        except (ValueError, KeyError) as e:
            self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("请求出错 %s", self.path)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _post(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        app, lib = self.app, self.app.lib

        if path == "/api/import":  # 请求体就是 PDF 文件
            data = self._body()
            ws, fresh = lib.create_from_pdf(data, q.get("name", "paper.pdf"))
            prefer = q.get("prefer_html", "1") == "1"
            if fresh or (prefer and not lib.web_source(ws) and (ws.load("job") or {}).get("state") not in ("queued", "running")):
                app.jobs.enqueue(ws, translate_after=q.get("translate", "1") == "1", scope=q.get("scope"),
                                 prefer_html=prefer, web_scope=q.get("web_scope", "abstract"))
            return self._json(200, {"id": ws.id, "new": fresh})
        if path in ("/api/import-url", "/api/import-arxiv"):
            body = json.loads(self._body() or b"{}")
            if body.get("mode") == arxivhtml.KIND:
                ws, fresh = lib.create_from_arxiv_html(body.get("ref", ""))
                if fresh:
                    app.jobs.enqueue_html(ws, translate_after=bool(body.get("translate", True)), scope=body.get("scope"))
                return self._json(200, {"id": ws.id, "new": fresh})
            data, name, meta = lib.fetch(body.get("ref", ""))  # sources.SourceError 是 ValueError，回 400
            ws, fresh = lib.create_from_pdf(data, name, meta)
            if fresh:
                app.jobs.enqueue(ws, translate_after=bool(body.get("translate", True)), scope=body.get("scope"))
            return self._json(200, {"id": ws.id, "new": fresh})
        if path == "/api/config":
            patch = json.loads(self._body() or b"{}")
            patch.pop("library_dir", None)
            # 选词翻译通过专用入口保存，避免改到全文翻译或问 AI 配置。
            patch.pop("selection_translation", None)
            if isinstance(patch.get("openai"), dict):
                patch["openai"] = config.with_key(patch["openai"])
            cfg = config.save(patch)
            return self._json(200, {"config": config.public(cfg)})
        if path == "/api/selection-translation/config":
            patch = json.loads(self._body() or b"{}")
            current = selection_translation.settings(config.load())
            value = selection_translation.sanitize(patch, current)
            cfg = config.save({"selection_translation": value})
            return self._json(200, {"config": selection_translation.public(selection_translation.settings(cfg))})
        if path == "/api/selection-translation/cancel":
            body = json.loads(self._body() or b"{}")
            rid = str(body.get("request_id") or "")
            if rid:
                app.selection.cancel(rid)
            return self._json(200, {"ok": True})
        if path == "/api/selection-translation/warm":
            self._body()
            def warm_selection():
                try:
                    app.selection.warm(config.load())
                except Exception:
                    log.info("选词翻译预热未完成，将在选择文字后连接")
            threading.Thread(target=warm_selection, daemon=True).start()
            return self._json(200, {"ok": True})
        if path == "/api/prefs":
            return self._json(200, prefs.save(json.loads(self._body() or b"{}")))
        if path == "/api/chat/models":  # 设置页保存名单和默认模型；或面板里只改默认
            body = json.loads(self._body() or b"{}")
            patch = {}
            if "models" in body:
                patch["models"] = chat_models.sanitize(body["models"])
            if body.get("default"):
                patch["default"] = str(body["default"])
            full = {"chat": patch}
            if isinstance(body.get("keys"), dict):  # 设置里给某家 API 填的 Key，和翻译那边共用
                keys = dict(config.load()["openai"].get("keys") or {})
                keys.update({str(k): str(v).strip() for k, v in body["keys"].items() if v and not str(v).startswith("••••")})
                full["openai"] = {"keys": keys}
            config.save(full)
            return self._json(200, chat_models.listing(config.load()))
        if path == "/api/config/test":
            cfg = config.load()
            patch = json.loads(self._body() or b"{}")
            if patch.get("engine"):
                cfg["engine"] = patch["engine"]
            return self._json(200, engines.test(cfg))

        if path.startswith("/api/p/"):
            parts = path.split("/")
            ws = lib.ws(parts[3]) if len(parts) > 4 else None
            if not ws:
                return self._json(404, {"error": "没有这篇论文"})
            action = parts[4]
            if action == "chat-images":
                return self._json(200, {"image": chat_images.save(ws, self._body(chat_images.MAX_BYTES), q.get("name", ""))})
            body = json.loads(self._body() or b"{}")
            if action == "reflow" and len(parts) == 6 and parts[5] == "context":
                return self._json(200, reflow.context(ws, body))
            if action == "chat" and len(parts) > 5:
                sub, tid = parts[5], body.get("thread", "")
                if sub == "pin":
                    chat_store.pin(ws, tid, body.get("id", ""))
                elif sub == "rename":
                    chat_store.rename(ws, tid, body.get("title", ""))
                elif sub == "delete":
                    chat_store.delete(ws, tid)
                return self._json(200, {"threads": chat_store.threads(ws)})
            if action == "chat":
                return self._chat(ws, body)
            if action == "selection-translation":
                return self._selection_translation(ws, body)
            if action == "ops":
                ops = body.get("ops") or []
                if not isinstance(ops, list):
                    raise ValueError("ops 必须是数组")
                res = ws.apply_reader_ops(ops, client=str(body.get("client", ""))[:40])
                res["versions"] = ws.versions()
                return self._json(200, res)
            if action == "item":
                return self._json(200, ws.patch_item(body))
            if action in ("match-arxiv", "use-web"):
                if ws.load("paper").get("meta", {}).get("source_kind") == arxivhtml.KIND:
                    raise ValueError("请从本地 PDF 查找来源")
                if action == "use-web" and not (ws.load("item") or {}).get("arxiv_match", {}).get("candidate"):
                    raise ValueError("尚无候选网页，请先查找来源")
                app.jobs.enqueue(ws, translate_after=False, prefer_html=True, accept_candidate=action == "use-web", match_only=True)
                return self._json(200, {"ok": True})
            if action == "translate":
                if ws.load("paper").get("meta", {}).get("source_kind") == arxivhtml.KIND:
                    app.jobs.enqueue_html(ws, scope=body.get("scope"), retry=bool(body.get("failed")), fast=bool(body.get("fast")))
                    return self._json(200, {"ok": True})
                pages = paperdata.parse_pages(body["pages"]) if body.get("pages") else None
                if body.get("failed"):  # 只重试上次没译成功的页
                    pages = sorted(int(k) for k in ((ws.load("job") or {}).get("failed") or {})) or None
                app.jobs.enqueue(ws, pages=pages, translate_after=True, scope=body.get("scope"))
                return self._json(200, {"ok": True})
            if action == "reveal":  # 在资源管理器 / 访达里打开这篇的文件夹
                _reveal(ws.root)
                return self._json(200, {"ok": True})
            if action == "cancel":
                app.jobs.cancel(ws.id)
                return self._json(200, {"ok": True})
            if action == "answer":
                return self._json(200, app.jobs.submit_small("answer", ws.id, note=body["note"]))
            if action == "retranslate":
                return self._json(200, app.jobs.submit_small("retranslate", ws.id, key=body["key"], hint=body.get("hint", "")))
            if action == "delete":
                app.jobs.cancel(ws.id)
                return self._json(200, {"trash": str(lib.trash(ws.id))})
        return self._json(404, {"error": "not found"})


_warming: set[str] = set()


def _warm(root: Path) -> None:
    """打开一篇论文时，后台生成原页面板用的小图（每篇只做一次）。"""
    if str(root) in _warming or (root / "pages" / f"w{pdfwork.PANEL_WIDTH}").exists() and \
            len(list((root / "pages" / f"w{pdfwork.PANEL_WIDTH}").glob("*.webp"))) >= len(list((root / "pages").glob("page-*.webp"))):
        return
    _warming.add(str(root))

    def run():
        try:
            pdfwork.warm_variants(root)
        except Exception:  # noqa: BLE001
            log.exception("生成面板图失败 %s", root)
        finally:
            _warming.discard(str(root))
    threading.Thread(target=run, daemon=True).start()


def _engine_label(cfg: dict) -> str:
    e = cfg.get("engine")
    if e == "openai":
        preset = next((p["name"] for p in config.PRESETS if p["id"] == cfg["openai"].get("preset")), "API")
        return f"{preset.split('（')[0]} · {cfg['openai'].get('model') or '未填模型'}"
    return engines.ENGINE_NAMES.get(e, e or "")


def _reveal(path: Path):
    import subprocess
    if sys.platform.startswith("win"):
        os.startfile(str(path))  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def make_server(cfg=None, port=0):
    """The existing handler chain, with account/ownership checks at its boundary."""
    from .access import Runtime
    from .account_http import handler_for
    runtime = Runtime(cfg or config.load())
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", port), handler_for(Handler, runtime))
    except BaseException:
        runtime.close()
        raise
    httpd.runtime = runtime
    runtime.httpd=httpd
    return httpd


def serve(port: int | None = None, open_browser: bool = False, path: str = "/"):
    setup_log(config.LOG_PATH)
    cfg = config.load()
    port = cfg["port"] if port is None else port
    httpd = make_server(cfg, port)
    runtime = httpd.runtime
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    info = {"url": url, "pid": os.getpid(), "started": now_iso(),
            "instance": runtime.instance, "desktop_token": runtime.desktop_token,
            "parent_pid": os.getppid()}
    if not config.temp_library():
        write_json_atomic(config.SERVER_INFO, info)
        config.SERVER_INFO.chmod(0o600)
    log.info("EasyRead %s 已启动：%s", __version__, url)
    print(f"EasyRead 已启动：{url}", flush=True)
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url + path)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        from . import codex_chat
        codex_chat.close_all()
        runtime.close()
        httpd.server_close()
