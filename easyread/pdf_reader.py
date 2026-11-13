"""Original-layout PDF reading with explicitly requested HJFY translation/chat.

PDF content identity owns the new notes. Existing library and HJFY data are read
only. A global reversible switch changes PDF routes; no per-paper admission list.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import threading
import re
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import config, pdf_dual, pdf_translation, pdf_chat, chat_store, chat_models, chat_images
from .store import Workspace, dir_lock, empty_reader, read_json, write_json_atomic

API = "/api/pdf-reader/"


class PDFWorkspace(Workspace):
    def load(self, name):
        if name == 'paper':
            return (read_json(self.root / 'manifest.json', {}) or {}).get('paper', {})
        return super().load(name)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Service(pdf_dual.Service):
    THEMES = ("original", "dark", "black", "snow", "sepia")

    def __init__(self, home, library, hjfy_home=None):
        self.root = Path(home).resolve() / ".pdf-reading"
        self.library = library
        self.hjfy = Path(hjfy_home or os.environ.get("EASYREAD_HJFY_HOME") or
                         Path.home() / "Library/Application Support/HJFY").resolve()
        self.hjfy_models=self.hjfy
        if hasattr(library,'database') and Path(home).resolve()!=library.database.legacy_home:
            # Operator connection settings are shared, historical paper outputs
            # belong only to the account that explicitly adopted the old data.
            self.hjfy=Path(home).resolve()/'.hjfy'
        self.hashes = {}
        self.prepare_lock = threading.RLock()

    def enabled(self):
        value = read_json(self.root / "default.json", {}) or {}
        return value.get("schema") == 1 and value.get("enabled") is True

    def appearance(self):
        value = read_json(self.root / "appearance.json", {}) or {}
        inherited = (read_json(self.root.parent / "prefs.json", {}) or {}).get("reader", {})
        theme = value.get("readerTheme", inherited.get("readerTheme"))
        pen = value.get("pen", inherited.get("pen"))
        return {"readerTheme": theme if theme in self.THEMES else "original",
                "pen": pen if pen in ("marker", "underline") else "marker"}

    def file_hash(self, path):
        path = Path(path)
        stat = path.stat()
        key = (str(path.resolve()), stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        if key not in self.hashes:
            self.hashes[key] = digest(path)
        return self.hashes[key]

    def source_workspace(self, pid):
        ws = self.library.ws(pid)
        return ws if ws and (ws.root / "source.pdf").is_file() else None

    def pdf_origin(self, pid):
        ws = self.source_workspace(pid)
        if not ws:
            return None
        parent = self.library.ws((ws.load("item") or {}).get("derived_from", ""))
        if parent and (parent.root / "source.pdf").is_file() and self.file_hash(parent.root / "source.pdf") == self.file_hash(ws.root / "source.pdf"):
            return parent
        return ws

    def web_reader(self, pid):
        ws = self.library.ws(pid)
        if not ws:
            return None
        if (ws.load("paper") or {}).get("meta", {}).get("source_kind") == "arxiv_html":
            return ws
        origin = self.pdf_origin(pid)
        web = self.library.web_source(origin or ws)
        return web if web and (web.load("paper") or {}).get("meta", {}).get("source_kind") == "arxiv_html" else None

    def reading_history(self, pid):
        start = self.library.ws(pid)
        if not start:
            raise ValueError("文献不存在")
        all_ws = self.library.all()
        ids = {pid}
        # Follow stored relations and exact source identities, never title similarity.
        changed = True
        while changed:
            changed = False
            known_hashes = {(w.load("paper") or {}).get("meta", {}).get("source_sha256") for w in all_ws if w.id in ids}
            known_hashes.discard(None); known_hashes.discard("")
            for ws in all_ws:
                item = ws.load("item") or {}
                links = {item.get("derived_from"), (item.get("web_source") or {}).get("id"), (item.get("pdf_web_source") or {}).get("id")}
                links.update(e.get("id") for e in item.get("web_source_history", []) if isinstance(e, dict))
                source_hash = (ws.load("paper") or {}).get("meta", {}).get("source_sha256")
                if ws.id in ids or links.intersection(ids) or source_hash in known_hashes:
                    additions = ({ws.id} | {k for k in links if k and self.library.ws(k)}) - ids
                    if additions:
                        ids.update(additions); changed = True
        records = []
        def add(key, label, ws, paper=None):
            reader = ws.load("reader") or {}
            records.append({"id": key, "label": label, "reader": reader, "chat": ws.load("chat") or {},
                            "discussion": ws.load("discussion") or {}, "paper": paper or {}})
        hashes = set()
        current_web_ids = {(w.load("item").get("web_source") or {}).get("id") for w in all_ws if w.id in ids}
        for ws in all_ws:
            if ws.id not in ids:
                continue
            paper = ws.load("paper") or {}
            meta = paper.get("meta", {})
            kind = meta.get("source_kind")
            label = ("arXiv 网页 · 当前版本" if ws.id in current_web_ids else "arXiv 网页 · 历史版本") if kind == "arxiv_html" else "早期 PDF 阅读记录"
            add(ws.id, label, ws, paper)
            if (ws.root / "source.pdf").is_file():
                hashes.add(self.file_hash(ws.root / "source.pdf"))
        for key in hashes:
            folder = self.root / key
            if (folder / "reader.json").exists():
                add("pdf:" + key, "PDF 对照阅读记录", PDFWorkspace(folder))
        for manifest_path in (self.root.parent / ".pdf-dual-experiments").glob("*/manifest.json"):
            manifest = read_json(manifest_path, {}) or {}
            if manifest.get("assets", {}).get("source", {}).get("sha256") in hashes:
                add("experiment:" + manifest_path.parent.name, "早期 PDF 对照记录", Workspace(manifest_path.parent))
        return {"paper_id": pid, "records": records}

    def translations(self, source_hash):
        """Match bytes, including readable outputs marked review by HJFY."""
        base = self.hjfy / "Documents"
        if not base.is_dir():
            return []
        try:
            from .database import request_cached
            history = request_cached(('hjfy-history',str(self.hjfy)),lambda:read_json(self.hjfy / "history.json", []))
        except (ValueError, OSError):
            history = []
        times = {}
        for record in history if isinstance(history, list) else []:
            output = record.get("output") if isinstance(record, dict) else None
            if isinstance(output, str) and urlparse(output).scheme == "file":
                path = Path(unquote(urlparse(output).path)).resolve()
                timestamp = record.get("finishedAt")
                if path.is_relative_to(base) and type(timestamp) in (int, float):
                    times[str(path)] = timestamp + 978307200  # Apple reference date.
        matches = []
        for original in sorted(base.glob("*/original.pdf")):
            try:
                if not original.resolve().is_relative_to(base) or self.file_hash(original) != source_hash:
                    continue
                for output in original.parent.glob("Runs/*/translated*.pdf"):
                    if not output.resolve().is_relative_to(original.parent.resolve()):
                        continue
                    matches.append({"id": output.parent.name, "path": output,
                                    "source_sha256": source_hash, "sha256": self.file_hash(output),
                                    "finished": times.get(str(output.resolve()), output.stat().st_mtime),
                                    "document": original.parent.name})
            except OSError:
                continue
        return sorted(matches, key=lambda v: (v["finished"], v["id"]), reverse=True)

    def describe(self, ws, source, side, asset_id, version, provenance, extract=True):
        """Extraction is for page references; absent text never excludes reading."""
        from pypdf import PdfReader
        filename = f"{side}-{self.file_hash(source)[:24]}.pdf"
        target = ws.root / "assets" / filename
        if not target.exists():
            tmp = target.with_suffix(".tmp")
            shutil.copyfile(source, tmp)
            tmp.replace(target)
        source_hash = self.file_hash(source)
        if self.file_hash(target) != source_hash:
            raise ValueError("已保存的 PDF 副本指纹发生变化，请保留文件并核对")
        document = PdfReader(target)
        boxes = [[float(v) for v in page.cropbox] for page in document.pages]
        if not extract:
            return {"id": asset_id, "role": side, "label": "原文" if side == "source" else "译文",
                    "version": version, "sha256": source_hash, "filename": filename,
                    "page_count": len(boxes), "page_boxes": boxes, "pages": [""] * len(boxes),
                    "provenance": provenance, "extraction_revision": 1, "text_ready": False}
        pages = []
        from .pdfwork import _document
        with _document(target) as pdf:
            for i in range(len(pdf)):
                page = text = None
                try:
                    page = pdf[i]
                    text = page.get_textpage()
                    pages.append(text.get_text_range())
                except Exception:
                    pages.append("")
                finally:
                    if text is not None:
                        text.close()
                    if page is not None:
                        page.close()
        return {"id": asset_id, "role": side, "label": "原文" if side == "source" else "译文",
                "version": version, "sha256": source_hash, "filename": filename,
                "page_count": len(boxes), "page_boxes": boxes, "pages": pages,
                "provenance": provenance, "extraction_revision": 1}

    def workspace(self, pid):
        original = self.source_workspace(pid)
        if not original:
            raise ValueError("这篇文献没有本地 PDF")
        source = original.root / "source.pdf"
        source_hash = self.file_hash(source)
        ws = PDFWorkspace(self.root / source_hash)
        with self.prepare_lock:
            (ws.root / "assets").mkdir(parents=True, exist_ok=True)
            with dir_lock(ws.root):
                old = read_json(ws.root / "manifest.json", {}) or {}
                versions = copy.deepcopy(old.get("translation_versions", []))
                asset = old.get("assets", {}).get("source")
                if not asset or asset.get("sha256") != source_hash or asset.get("extraction_revision") != 1:
                    asset = self.describe(ws, source, "source", "source-v1", 1,
                                          {"kind": "library", "source_sha256": source_hash})
                options = []
                errors = []
                candidates = self.translations(source_hash) + pdf_translation.completed(ws)
                candidates.sort(key=lambda v: (v['finished'], v['id']), reverse=True)
                choice = read_json(ws.root / "choice.json", {}) or {}
                candidate_ids = ['hjfy-' + c['id'] + '-' + c['sha256'][:12] for c in candidates]
                previous = old.get('assets', {}).get('translation', {}).get('id')
                wanted = next((id for id in (choice.get('asset_id'), previous) if id in candidate_ids), candidate_ids[0] if candidate_ids else None)
                for candidate in candidates:
                    if self.file_hash(candidate['path']) != candidate['sha256']:
                        errors.append('任务译文指纹发生变化，未加载该产物')
                        continue
                    key = "hjfy-" + candidate["id"] + "-" + candidate["sha256"][:12]
                    existing = next((v for v in versions if v["id"] == key), None)
                    if existing is None or existing.get("extraction_revision") != 1 or (key == wanted and existing.get('text_ready') is False):
                        try:
                            version = existing["version"] if existing else max((v["version"] for v in versions), default=0) + 1
                            versions = [v for v in versions if v["id"] != key]
                            existing = self.describe(ws, candidate["path"], "translation", key,
                                                     version,
                                                     {"kind": candidate.get("kind", "hjfy"), "document": candidate["document"],
                                                      "run": candidate["id"], "source_sha256": source_hash}, extract=key == wanted)
                            versions.append(existing)
                        except Exception as error:
                            errors.append("已有译文无法读取：" + str(error)[:120])
                            continue
                    options.append(existing)
                choice = read_json(ws.root / "choice.json", {}) or {}
                selected = next((v for v in options if v["id"] == choice.get("asset_id")), None)
                previous = old.get("assets", {}).get("translation", {}).get("id")
                selected = selected or next((v for v in options if v["id"] == previous), None)
                selected = selected or (options[0] if options else None)
                if selected and choice.get("asset_id") != selected["id"]:
                    write_json_atomic(ws.root / "choice.json", {"asset_id": selected["id"]})
                assets = {"source": asset}
                if selected:
                    assets["translation"] = selected
                meta = (original.load("paper") or {}).get("meta", {})
                title = meta.get("title_zh") or meta.get("title_en") or pid
                blocks = [{"id": f"{side}-p{i + 1}", "type": "paragraph", "pdf_side": side,
                           "page": i + 1, "en": text if side == "source" else "",
                           "zh": text if side == "translation" else ""}
                          for side, a in assets.items() for i, text in enumerate(a["pages"])]
                manifest = {"id": ws.id, "reference_schema": 1, "title": title, "assets": assets,
                            "translation_versions": versions, "available_translations": [v["id"] for v in options],
                            "translation_errors": errors, "paper": {"meta": dict(meta, source_kind="pdf_dual"), "blocks": blocks}}
                if manifest != old:
                    write_json_atomic(ws.root / "manifest.json", manifest)
                if not ws.reader_path.exists():
                    write_json_atomic(ws.reader_path, empty_reader())
        return ws

    def asset_file(self, ws, asset):
        filename = asset.get('filename', '')
        if not filename or Path(filename).name != filename:
            raise ValueError('PDF 文件名无效')
        base = (ws.root / 'assets').resolve()
        path = (base / filename).resolve()
        if not base.is_relative_to(ws.root) or not path.is_relative_to(base) or not path.is_file():
            raise ValueError('PDF 文件不存在')
        if self.file_hash(path) != asset['sha256']:
            raise ValueError('PDF 文件指纹已变化，旧坐标已停用')
        return path

    def serve_asset(self, handler, ws, asset):
        path = self.asset_file(ws, asset)
        size = path.stat().st_size
        etag = '"' + asset['sha256'] + '"'
        start, end, code = 0, size - 1, 200
        value = handler.headers.get('Range', '')
        if value and handler.headers.get('If-Range', etag) == etag:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', value)
            if match and any(match.groups()):
                left, right = match.groups()
                if left:
                    start = int(left); end = min(int(right), size - 1) if right else size - 1
                else:
                    start = max(0, size - int(right))
                if start >= size or end < start:
                    return handler._send(416, b'', 'application/pdf', headers={'Content-Range': f'bytes */{size}'})
                code = 206
        handler.send_response(code)
        for name, value in {'Content-Type': 'application/pdf', 'Content-Length': str(end-start+1),
                            'Accept-Ranges': 'bytes', 'ETag': etag, 'Cache-Control': 'private, max-age=86400'}.items():
            handler.send_header(name, value)
        if code == 206: handler.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        handler.end_headers()
        if handler.command != 'HEAD':
            with path.open('rb') as stream:
                stream.seek(start); remaining = end-start+1
                while remaining:
                    chunk = stream.read(min(65536, remaining))
                    if not chunk: raise OSError('PDF 在读取期间发生变化')
                    handler.wfile.write(chunk); remaining -= len(chunk)

    def existing_workspace(self, pid, prepare=True):
        """Resolve identity without scanning translations or rebuilding paper.

        Opening/refreshing/selecting a translation still prepares the complete
        workspace. Frequent status queries need no extraction, even on a PDF
        that has never been opened.
        """
        original = self.source_workspace(pid)
        if not original:
            raise ValueError("这篇文献没有本地 PDF")
        source_hash = self.file_hash(original.root / 'source.pdf')
        ws = PDFWorkspace(self.root / source_hash)
        if not prepare:
            return ws
        if not (ws.root / 'manifest.json').exists():
            return self.workspace(pid)
        manifest = self.manifest(ws)
        asset = manifest.get('assets', {}).get('source', {})
        if asset.get('sha256') == source_hash and asset.get('extraction_revision') == 1 and ws.reader_path.exists():
            return ws
        return self.workspace(pid)

    def legacy(self, pid, source_hash):
        original = self.source_workspace(pid)
        sources = [original]
        web = self.library.web_source(original)
        if web and web.id != pid:
            sources.append(web)
        # Keep earlier reading workspaces for this exact PDF reachable too.
        for item in self.library.all():
            meta = (item.load("item") or {})
            paper_meta = (item.load("paper") or {}).get("meta", {})
            if paper_meta.get("source_sha256") == source_hash and item.id not in {w.id for w in sources}:
                sources.append(item)
        result = []
        for item in sources:
            reader = item.load("reader") or {}
            notes = [n for n in reader.get("notes", {}).values() if not n.get("deleted")]
            body = (reader.get("paper_note") or {}).get("body", "")
            if notes or body:
                result.append({"id": item.id, "label": "原有阅读笔记", "notes": notes, "paper_note": body,
                               "href": "/api/reading-history/" + pid})
        for path in (self.root.parent / ".pdf-dual-experiments").glob("*/manifest.json"):
            manifest = read_json(path, {}) or {}
            if manifest.get("assets", {}).get("source", {}).get("sha256") == source_hash:
                reader = read_json(path.parent / "reader.json", {}) or {}
                notes = [n for n in reader.get("notes", {}).values() if not n.get("deleted")]
                if notes:
                    result.append({"id": path.parent.name, "label": "实验阅读笔记", "notes": notes,
                                   "paper_note": "", "href": "/api/reading-history/" + pid})
        return result

    def reference(self, ws, value):
        pdf = value.get("pdf", {}) if isinstance(value, dict) else {}
        manifest = self.manifest(ws)
        known = list(manifest["assets"].values()) + manifest["translation_versions"]
        asset = next((a for a in known if a["role"] == pdf.get("side") and
                      all(pdf.get(k) == a.get(v) for k, v in
                          (("asset_id", "id"), ("version", "version"), ("sha256", "sha256")))), None)
        if asset is None:
            raise ValueError("PDF 版本不存在或文件身份不匹配")
        if asset.get('text_ready') is False:
            asset = self.describe(ws, self.asset_file(ws, asset), asset['role'], asset['id'], asset['version'], asset['provenance'])
        return super().reference(ws, value, asset=asset)

    def state(self, ws):
        state = super().state(ws)
        for note in state["reader"]["notes"].values():
            pdf = note.get("pdf", {})
            asset = state["assets"].get(pdf.get("side"), {})
            if any(pdf.get(k) != asset.get(v) for k, v in
                   (("asset_id", "id"), ("version", "version"), ("sha256", "sha256"))):
                note["pdf_status"] = "stale"
        return state

    def state_for(self, pid):
        ws = self.workspace(pid)
        state = self.state(ws)
        state['discussion'] = ws.load('discussion')
        manifest = self.manifest(ws)
        state["assets"] = {k: dict(v, url=API + pid + "/assets/" + k + "/" + v["id"]) for k, v in state["assets"].items()}
        state.update(route_id=pid, api_base=API + pid,
                     model_calls_permitted=True,
                     appearance=self.appearance(),
                     web_read_url=("/read/" + web.id if (web := self.web_reader(pid)) else None),
                     legacy_sources=self.legacy(pid, ws.id),
                     translation_options=[{"id": v["id"], "version": v["version"], "page_count": v["page_count"],
                                           "label": f"译文 v{v['version']} · {v['page_count']} 页 · {v['provenance']['run'][:8]}"}
                                          for v in manifest["translation_versions"] if v["id"] in manifest["available_translations"]],
                     translation_errors=manifest["translation_errors"],
                     translation_pending="translation" not in state["assets"])
        return state

    def summary(self, item):
        original = self.source_workspace(item["id"])
        if not original:
            return item
        result = dict(item)
        key = self.file_hash(original.root / "source.pdf")
        reader = read_json(self.root / key / "reader.json", {}) or {}
        result.update(pdf_reader_default=True, previous_read_id=item.get("read_id"), read_id=item["id"],
                      reading_source_kind="pdf_dual", has_pdf_translation=bool(self.translations(key) or pdf_translation.completed(PDFWorkspace(self.root / key))),
                      progress=(reader.get("progress") or {}).get("ratio", 0))
        result["notes"] += sum(not n.get("deleted") and n.get("kind") != "highlight" for n in reader.get("notes", {}).values())
        result["highlights"] += sum(not n.get("deleted") and n.get("kind") == "highlight" for n in reader.get("notes", {}).values())
        return result

    def get(self, handler, path):
        parts = path[len(API):].strip("/").split("/")
        pid = parts[0]
        action = "/".join(parts[1:])
        if action == "state":
            state = self.state_for(pid)
            return handler._json(200, {**state, "token": handler.app.token})
        ws = self.existing_workspace(pid, prepare=action not in ('translation', 'status'))
        if action == 'part/reader':
            return handler._json(200, {'data': self.state(ws)['reader']})
        if action.startswith("assets/"):
            segments = action.split("/")
            side = segments[1]
            asset = self.manifest(ws)["assets"].get(side)
            if len(segments) == 3:
                known = list(self.manifest(ws)["assets"].values()) + self.manifest(ws)["translation_versions"]
                asset = next((a for a in known if a["role"] == side and a["id"] == segments[2]), None)
            return self.serve_asset(handler, ws, asset) if asset else handler._json(404, {"error": "尚无该 PDF"})
        if action == "part/discussion":
            return handler._json(200, {"data": ws.load("discussion")})
        if action == "chat":
            from .conversations import threads
            return handler._json(200, {"threads": threads(handler,ws), **chat_models.listing(config.load())})
        if action.startswith("chat-images/"):
            image_id = action.removeprefix("chat-images/")
            _, paths = chat_images.resolve(ws, [{"id": image_id}])
            return handler._file(paths[0])
        if action == "translation":
            task = pdf_translation.state(ws)
            if task.get("state") == "completed":
                task['asset_id'] = 'hjfy-easyread-' + task['id'] + '-' + task['output_sha256'][:12]
            return handler._json(200, {"task": task, "models": pdf_translation.choices(self),
                                       "pdf_mode": "preserve", "target_language": "zh-Hans"})
        if action == "context-previews":
            return handler._json(200, read_json(ws.root / "context-previews.json", []))
        if action == "status":
            return handler._json(200, {"document_id": ws.id, "model_calls_permitted": True, "automatic_translation": False,
                                      "translation": pdf_translation.state(ws)})
        return handler._json(404, {"error": "PDF 阅读接口不存在"})

    def post(self, handler, path, body):
        parts = path[len(API):].strip("/").split("/")
        action = "/".join(parts[1:])
        ws = self.workspace(parts[0]) if action in ('refresh', 'select-translation', 'translation/start') else self.existing_workspace(parts[0])
        if action == "ops":
            result = self.apply(ws, body)
            if all(op.get('op') == 'progress' for op in body.get('ops', [])):
                result['progress'] = ws.load('reader').get('progress', {})
            return handler._json(200, result)
        if action == "context-preview":
            return handler._json(200, self.preview(ws, body))
        if action == "chat":
            return pdf_chat.handle(handler, self, ws, body)
        if action.startswith("chat/"):
            sub = action.split('/')[-1]
            if sub == 'rename': chat_store.rename(ws, body.get('thread'), body.get('title'))
            elif sub == 'delete': chat_store.delete(ws, body.get('thread'))
            elif sub == 'pin':
                thread = chat_store.get(ws, body.get('thread'))
                messages = (thread or {}).get('messages', [])
                index = next((i for i, m in enumerate(messages) if m.get('id') == body.get('id') and m.get('role') == 'assistant'), None)
                if index is None: raise ValueError('回答不存在')
                answer, question = messages[index], messages[index - 1] if index else {}
                refs = question.get('refs', [])
                for ref in refs: self.reference(ws, ref)
                from .paperdata import add_discussion
                add_discussion(ws, [{'kind':'qa', 'q':question.get('content',''), 'body':answer['content'],
                                     'by':answer.get('model',''), 'anchor':question.get('anchor'),
                                     'quote':question.get('quote',''), 'refs':refs}])
            else: raise ValueError('对话操作不存在')
            return handler._json(200, {"threads": chat_store.threads(ws)})
        if action == "translation/start":
            return handler._json(200, {"task": pdf_translation.start(self, ws, body)})
        if action == "translation/cancel":
            return handler._json(200, {"task": pdf_translation.cancel(ws)})
        if action == "appearance":
            if "readerTheme" in body and body["readerTheme"] not in self.THEMES:
                raise ValueError("阅读背景不存在")
            if "pen" in body and body["pen"] not in ("marker", "underline"):
                raise ValueError("划线样式不存在")
            if not body or set(body) - {"readerTheme", "pen"}:
                raise ValueError("阅读偏好无效")
            with dir_lock(self.root):
                write_json_atomic(self.root / "appearance.json", dict(self.appearance(), **body))
            return handler._json(200, self.appearance())
        if action in ("refresh", "select-translation"):
            if action == "select-translation":
                if body.get("asset_id") not in self.manifest(ws)["available_translations"]:
                    raise ValueError("译文版本不存在或不属于该原文")
                with dir_lock(ws.root):
                    write_json_atomic(ws.root / "choice.json", {"asset_id": body["asset_id"]})
            return handler._json(200, self.state_for(parts[0]))
        return handler._json(403, {"error": "PDF 阅读器不会调用模型或自动翻译"})


def install(server):
    if getattr(server.Handler, "pdf_reader_installed", False):
        return
    services = {}
    class PDFHandler(server.Handler):
        pdf_reader_installed = True

        @property
        def pdf_service(self):
            key = str(self.app.lib.root)
            if key not in services:
                services[key] = Service(getattr(self.app,'home',config.HOME), self.app.lib)
            return services[key]

        def _reader_redirect(self, target):
            self.send_response(302)
            self.send_header("Location", target)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        def _get(self):
            url = urlparse(self.path)
            path = unquote(url.path)
            service = self.pdf_service
            query = parse_qs(url.query)
            if path.startswith(API):
                try:
                    return service.get(self, path)
                except (ValueError, OSError) as error:
                    return self._json(409, {"error": str(error)})
            if path.startswith("/api/reading-history/"):
                try:
                    return self._json(200, service.reading_history(path.split("/")[-1]))
                except ValueError as error:
                    return self._json(404, {"error": str(error)})
            if path in {"/web/reader.html", "/web/reflow-reader.html", "/web/pdf-dual-reader.html", "/web/pdf-dual-experiments.html"}:
                return self._reader_redirect("/")
            if path.startswith(pdf_dual.PREFIX):
                rel = path[len(pdf_dual.PREFIX):].strip("/").split("/")
                if len(rel) == 1 and re.fullmatch(r"[A-Za-z0-9_-]+", rel[0]):
                    manifest = read_json(config.HOME / ".pdf-dual-experiments" / rel[0] / "manifest.json", {}) or {}
                    key = manifest.get("assets", {}).get("source", {}).get("sha256")
                    for item in self.app.lib.all():
                        original = service.pdf_origin(item.id)
                        if original and service.file_hash(original.root / "source.pdf") == key:
                            return self._reader_redirect("/read/" + original.id)
                if rel == [""]:
                    return self._reader_redirect("/")
                if len(rel) == 3 and rel[1] == "assets":
                    return super()._get()  # Keep immutable historical PDFs downloadable.
                return self._json(410, {"error": "实验阅读入口已停用，请在阅读页查看历史记录"})
            if path.startswith("/read/"):
                pid = path[6:]
                ws = self.app.lib.ws(pid)
                if not ws:
                    return self._json(404, {"error": "文献不存在"})
                web = service.web_reader(pid)
                is_web = ws.load("paper").get("meta", {}).get("source_kind") == "arxiv_html"
                if web and (query.get("source") == ["web"] or (is_web and query.get("source") != ["pdf"])):
                    if web.id != pid or url.query:
                        return self._reader_redirect("/read/" + web.id)
                    return self._file(config.WEB / "arxiv-reader.html")
                origin = service.pdf_origin(pid)
                if not origin and is_web:
                    for item in self.app.lib.all():
                        candidate = service.pdf_origin(item.id)
                        if candidate and service.web_reader(candidate.id) and service.web_reader(candidate.id).id == pid:
                            origin = candidate; break
                    if not origin:
                        return self._reader_redirect("/read/" + pid)
                if origin:
                    if origin.id != pid or url.query:
                        return self._reader_redirect("/read/" + origin.id)
                    return self._file(config.WEB / "pdf-reader.html")
                return self._json(409, {"error": "缺少原 PDF 或 arXiv 网页；原有数据保留在历史记录中"})
            if path == "/api/library":
                cfg = config.load()
                return self._json(200, {"items": [service.summary(i) for i in self.app.lib.list()],
                    "token": self.app.token, "jobs": self.app.small_status(), "engine": cfg.get("engine"),
                    "engine_label": server._engine_label(cfg), "first_run": config.is_first_run(),
                    "version": server.__version__, "pdf_reader_default_enabled": True})
            return super()._get()

        def _post(self):
            url = urlparse(self.path)
            path = unquote(url.path)
            if path.startswith(pdf_dual.PREFIX):
                return self._json(410, {"error": "实验阅读已停用，历史记录保留"})
            if path.startswith(API):
                if path.rstrip('/').endswith('/chat-images'):
                    pid = path[len(API):].split('/')[0]
                    ws = self.pdf_service.workspace(pid)
                    image = chat_images.save(ws, self._body(chat_images.MAX_BYTES), parse_qs(url.query).get('name', [''])[0])
                    image['url'] = API + pid + '/chat-images/' + image['id']
                    return self._json(200, {'image':image})
                return self.pdf_service.post(self, path, json.loads(self._body(2_000_000) or b"{}"))
            if path == "/api/import" and self.pdf_service.enabled() and parse_qs(url.query).get("translate") != ["1"]:
                name = parse_qs(url.query).get("name", ["paper.pdf"])[0]
                ws, fresh = self.app.lib.create_from_pdf(self._body(), name)
                return self._json(200, {"id": ws.id, "new": fresh})
            return super()._post()
    server.Handler = PDFHandler
