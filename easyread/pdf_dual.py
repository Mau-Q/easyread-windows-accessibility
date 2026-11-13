"""Independent original-layout PDF reader. No translation or model service access.

Reference contract v1: document + side + immutable asset identity + PDF coordinates.
Only explicitly prepared experiments outside the real library can be opened here.
"""
from __future__ import annotations

import copy
import hashlib
import math
import re
import unicodedata
from pathlib import Path

from . import config
from .store import Workspace, apply_ops, dir_lock, now_iso, read_json, write_json_atomic

PREFIX = "/experiments/pdf-dual/"
CONTRACT = 1
COORDINATES = "pdf-user-space"
SIDES = ("source", "translation")


def normalized(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text)
                   if not c.isspace() and c not in "-\u00ad")


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def valid_scale(value):
    if isinstance(value, str) and value in ("page-width", "page-fit", "auto"):
        return True
    # PDF.js location.scale is a percentage (90 means 90%); Zotero restores it
    # by dividing by 100. Preserve that unit instead of treating it as a ratio.
    if type(value) not in (int, float, str):
        return False
    try:
        number = float(value)
    except ValueError:
        return False
    return math.isfinite(number) and 5 <= number <= 2000


class Service:
    def __init__(self, home: Path):
        self.root = Path(home).resolve() / ".pdf-dual-experiments"

    def workspace(self, pid):
        if not re.fullmatch(r"[a-zA-Z0-9_-]{4,64}", pid):
            raise ValueError("实验样例不存在")
        root = (self.root / pid).resolve()
        if not root.is_relative_to(self.root) or not (root / "manifest.json").is_file():
            raise ValueError("实验样例不存在")
        return Workspace(root)

    def manifest(self, ws):
        manifest = read_json(ws.root / "manifest.json")
        if manifest.get("id") != ws.id or manifest.get("reference_schema") != CONTRACT:
            raise ValueError("实验清单版本不匹配")
        return manifest

    def asset_file(self, ws, asset):
        filename = asset.get("filename", "")
        if not filename or Path(filename).name != filename:
            raise ValueError("PDF 文件名无效")
        base = (ws.root / "assets").resolve()
        path = (base / filename).resolve()
        if not base.is_relative_to(ws.root) or not path.is_relative_to(base) or not path.is_file():
            raise ValueError("PDF 文件不存在")
        if hashlib.sha256(path.read_bytes()).hexdigest() != asset["sha256"]:
            raise ValueError("PDF 文件指纹已变化，旧坐标已停用")
        return path

    def reference(self, ws, value, asset=None):
        if not isinstance(value, dict) or not isinstance(value.get("pdf"), dict):
            raise ValueError("PDF 引用格式错误")
        pdf = value["pdf"]
        if type(pdf.get("schema")) is not int or pdf["schema"] != CONTRACT or pdf.get("document_id") != ws.id or pdf.get("coordinate_space") != COORDINATES:
            raise ValueError("PDF 引用协议或文档身份不匹配")
        manifest = self.manifest(ws)
        side = pdf.get("side")
        asset = asset or manifest["assets"].get(side)
        if not asset:
            raise ValueError("PDF 来源不明确")
        if type(pdf.get("version")) is not int or any(pdf.get(k) != asset.get(a) for k, a in
               (("asset_id", "id"), ("version", "version"), ("sha256", "sha256"))):
            raise ValueError("PDF 版本已变化，旧记录保留且不迁移坐标")
        self.asset_file(ws, asset)
        page = pdf.get("pageIndex")
        if type(page) is not int or not 0 <= page < asset["page_count"]:
            raise ValueError("PDF 页码无效")
        if value.get("anchor") != f"{side}-p{page + 1}":
            raise ValueError("引用侧与页码不一致")
        positions = pdf.get("positions")
        if not isinstance(positions, list) or len(positions) > 2:
            raise ValueError("选区页范围无效")
        for offset, position in enumerate(positions):
            if not isinstance(position, dict) or type(position.get("pageIndex")) is not int or position["pageIndex"] != page + offset or page + offset >= asset["page_count"]:
                raise ValueError("跨页选区必须连续且属于同一 PDF")
            rects = position.get("rects")
            if not isinstance(rects, list) or not 0 < len(rects) <= 2000:
                raise ValueError("选区坐标缺失")
            box = asset["page_boxes"][page + offset]
            for rect in rects:
                if not isinstance(rect, list) or len(rect) != 4 or not all(finite(v) for v in rect):
                    raise ValueError("选区坐标无效")
                if not (box[0] - 2 <= rect[0] < rect[2] <= box[2] + 2 and box[1] - 2 <= rect[1] < rect[3] <= box[3] + 2):
                    raise ValueError("选区坐标超出 PDF 页面")
        quote = value.get("quote", "")
        if not isinstance(quote, str) or len(quote) > 8000:
            raise ValueError("选中文字无效或过长")
        source = "\n".join(asset["pages"][p] for p in range(page, page + max(1, len(positions))))
        if quote and (not positions or not normalized(quote) or normalized(quote) not in normalized(source)):
            raise ValueError("选中文字无法在该 PDF 页确认")
        return {"anchor": value["anchor"], "quote": quote, "pdf": copy.deepcopy(pdf),
                "label": f"{asset['label']} · 第 {page + 1} 页 · v{asset['version']}",
                "nearby_text": source[:12000], "context_scope": "same-PDF-page", "confirmed": True}

    def state(self, ws):
        manifest = self.manifest(ws)
        assets = copy.deepcopy(manifest["assets"])
        for side, asset in assets.items():
            self.asset_file(ws, asset)
            asset.pop("pages", None)
            asset["url"] = f"{PREFIX}{ws.id}/assets/{side}"
        reader = ws.load("reader")
        notes = copy.deepcopy(reader.get("notes", {}))
        for note in notes.values():
            try:
                self.reference(ws, note)
                note["pdf_status"] = "current"
            except ValueError:
                note["pdf_status"] = "stale"
        reader["notes"] = notes
        return {"id": ws.id, "title": manifest["title"], "assets": assets,
                "paper": manifest["paper"], "reader": reader, "versions": ws.versions(),
                "reference_schema": CONTRACT, "model_calls_permitted": False, "automatic_translation": False}

    def validate_ops(self, ws, current, clean):
        known = copy.deepcopy(current.get("notes", {}))
        for op in clean:
            if not isinstance(op, dict):
                raise ValueError("保存操作无效")
            kind = op.get("op")
            if kind == "note":
                note = op.get("note")
                self.reference(ws, note)
                nid = note.get("id")
                if not isinstance(nid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", nid):
                    raise ValueError("笔记身份无效")
                previous = known.get(nid)
                if previous and previous.get("pdf") != note["pdf"]:
                    raise ValueError("已有笔记不能更换 PDF 身份或坐标")
                native = note.get("native")
                positions = note["pdf"]["positions"]
                style = note.get("style", "marker")
                if style not in ("marker", "underline") or note.get("color", "yellow") not in ("yellow", "green", "blue", "pink"):
                    raise ValueError("划线样式或颜色无效")
                annotation_type = "underline" if style == "underline" else "highlight"
                if not isinstance(native, list) or len(native) != len(positions):
                    raise ValueError("高亮与选区不一致")
                for i, (annotation, position) in enumerate(zip(native, positions)):
                    if not isinstance(annotation, dict) or annotation.get("type") != annotation_type or annotation.get("position") != position or annotation.get("id") != f"{nid}-{i}" or annotation.get("text") != note.get("quote"):
                        raise ValueError("高亮与选区不一致")
                if note.get("kind") not in ("highlight", "note", "question") or not isinstance(note.get("body", ""), str) or len(note.get("body", "")) > 100000:
                    raise ValueError("笔记内容无效")
                note.pop("pdf_status", None)
                known[nid] = note
            elif kind == "progress":
                progress = op.get("dual_pdf")
                available = set(self.manifest(ws)["assets"])
                if not isinstance(progress, dict) or type(progress.get("schema")) is not int or progress["schema"] != CONTRACT or progress.get("document_id") != ws.id or progress.get("active") not in available or type(progress.get("sync")) is not bool or not isinstance(progress.get("panes"), dict) or not set(progress["panes"]) <= available or "source" not in progress["panes"]:
                    raise ValueError("双 PDF 阅读进度无效")
                for side, loc in progress["panes"].items():
                    if not isinstance(loc, dict) or type(loc.get("pageIndex")) is not int:
                        raise ValueError("双 PDF 阅读位置无效")
                    self.reference(ws, {"anchor": f"{side}-p{loc.get('pageIndex', -1) + 1}", "quote": "",
                                        "pdf": dict(loc, side=side, schema=CONTRACT, document_id=ws.id, coordinate_space=COORDINATES, positions=[])})
                    scale = loc.get("scale")
                    if not valid_scale(scale):
                        raise ValueError("缩放比例无效")
                    if not all(finite(loc.get(k)) and abs(loc[k]) <= 1000000 for k in ("top", "left")):
                        raise ValueError("滚动位置无效")
            elif kind == "note_del":
                if op.get("id") not in known:
                    raise ValueError("笔记不存在")
            elif kind == "paper_note":
                if not isinstance(op.get("body"), str) or len(op["body"]) > 100000:
                    raise ValueError("论文笔记无效")
            else:
                raise ValueError("PDF 对照实验不支持该操作")

    def apply(self, ws, body):
        if not isinstance(body, dict):
            raise ValueError("保存请求无效")
        ops = body.get("ops")
        if not isinstance(ops, list) or not 0 < len(ops) <= 100:
            raise ValueError("保存操作无效")
        # Validation and merge share the same lock; no note can silently change identity.
        clean = copy.deepcopy(ops)
        with dir_lock(ws.root):
            reader = ws.load("reader")
            self.validate_ops(ws, reader, clean)
            applied = apply_ops(reader, clean)
            for op in clean:
                if op["op"] == "progress" and reader.get("progress", {}).get("at") == op.get("at"):
                    reader["progress"]["dual_pdf"] = copy.deepcopy(op["dual_pdf"])
            if applied:
                ws._journal(clean, str(body.get("client", ""))[:40])
                ws._snapshot()
                write_json_atomic(ws.reader_path, reader)
        return {"rev": reader.get("rev", 0), "applied": applied, "versions": ws.versions()}

    def preview(self, ws, body):
        if not isinstance(body, dict):
            raise ValueError("引用请求无效")
        refs = body.get("refs")
        if not isinstance(refs, list) or not 0 < len(refs) <= 12:
            raise ValueError("请引用一处 PDF 位置")
        question = body.get("text", "")
        if not isinstance(question, str) or not question.strip() or len(question) > 20000:
            raise ValueError("问题为空或过长")
        result = {"schema": CONTRACT, "document_id": ws.id, "question": question,
                  "refs": [self.reference(ws, ref) for ref in refs], "note": body.get("note"),
                  "mode": "context-preview", "model_called": False, "model_calls": 0, "at": now_iso()}
        with dir_lock(ws.root):
            path = ws.root / "context-previews.json"
            records = read_json(path, [])
            records.append(result)
            write_json_atomic(path, records)
        return result

    def get(self, handler, path):
        rel = path[len(PREFIX):].strip("/")
        if not rel:
            return handler._file(config.WEB / "pdf-dual-experiments.html")
        parts = rel.split("/")
        ws = self.workspace(parts[0])
        if len(parts) == 1:
            return handler._file(config.WEB / "pdf-dual-reader.html")
        if len(parts) == 3 and parts[1] == "assets" and parts[2] in SIDES:
            return handler._file(self.asset_file(ws, self.manifest(ws)["assets"][parts[2]]))
        action = "/".join(parts[1:])
        if action == "state":
            return handler._json(200, {**self.state(ws), "token": handler.app.token})
        if action == "part/reader":
            return handler._json(200, {"data": self.state(ws)["reader"]})
        if action == "part/discussion":
            return handler._json(200, {"data": {"entries": []}})
        if action == "chat":
            return handler._json(200, {"threads": [], "models": [{"id": "preview-only", "label": "引用预览 · 不调用模型"}], "default": "preview-only"})
        if action == "context-previews":
            return handler._json(200, read_json(ws.root / "context-previews.json", []))
        if action == "status":
            return handler._json(200, {"document_id": ws.id, "model_calls": 0, "model_calls_permitted": False, "automatic_translation": False})
        return handler._json(404, {"error": "实验接口不存在"})

    def post(self, handler, path, body):
        parts = path[len(PREFIX):].strip("/").split("/")
        ws = self.workspace(parts[0])
        action = "/".join(parts[1:])
        if action == "ops":
            return handler._json(200, self.apply(ws, body))
        if action == "context-preview":
            return handler._json(200, self.preview(ws, body))
        return handler._json(403, {"error": "PDF 对照实验禁止模型调用、自动翻译和导入"})


def install(server):
    """Register only the experimental namespace from the CLI bootstrap.

    The adopted reader hashes server.py/store.py/shared reader components.
    Keep those exact bytes and delegate every ordinary route to its base handler.
    """
    from urllib.parse import unquote, urlparse
    import json
    if getattr(server.Handler, "pdf_dual_installed", False):
        return
    service = Service(config.HOME)
    class ExperimentalHandler(server.Handler):
        pdf_dual_installed = True

        def _get(self):
            path = unquote(urlparse(self.path).path)
            if path.startswith(PREFIX):
                try:
                    scoped=Service(getattr(getattr(self,'app',None),'home',service.root.parent))
                    return scoped.get(self, path)
                except ValueError as error:
                    return self._json(409, {"error": str(error)})
            return super()._get()

        def _post(self):
            path = unquote(urlparse(self.path).path)
            if path.startswith(PREFIX):
                scoped=Service(getattr(getattr(self,'app',None),'home',service.root.parent))
                return scoped.post(self, path, json.loads(self._body(2_000_000) or b"{}"))
            return super()._post()
    server.Handler = ExperimentalHandler
