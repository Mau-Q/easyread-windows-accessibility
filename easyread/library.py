"""文献库：一个目录里放多篇论文，每篇一个子目录（目录名就是 id，取 PDF 的 SHA-256 前 12 位）。"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import copy
import threading
from datetime import datetime
from pathlib import Path

from . import sources
from .store import SCHEMA, Workspace, empty_discussion, empty_reader, now_iso, read_json, write_json_atomic



def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Library:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._list_lock = threading.Lock()
        self._list_cache = None

    def _list_signature(self):
        """Invalidate on external writes too; cached summaries never own data.

        Readiness checks depend on runtime files and derived caches, not only
        paper metadata. Include directory/file identity, including ctime and
        inode so an atomic replacement or preserved mtime cannot hide a change.
        """
        from . import config, reflow
        roots = [self.root, config.HOME / '.pdf-reflow']
        package = Path(__file__).parent
        roots += [package / 'web/vendor/zotero', package / 'web/vendor/katex']
        paths = {config.CONFIG_PATH, *[package / name for name in reflow.RUNTIME_FILES],
                 package / 'web/js/common/util.js', package / 'web/css/reader-theme.css'}
        for root in roots:
            paths.add(root)
            paths.update(root.rglob('*'))
        result = []
        for path in sorted(paths):
            try:
                stat = path.stat()
                result.append((str(path), stat.st_dev, stat.st_ino, stat.st_size,
                               stat.st_mtime_ns, stat.st_ctime_ns))
            except FileNotFoundError:
                result.append((str(path), None))
        return tuple(result)

    def ws(self, pid: str) -> Workspace | None:
        if not re.fullmatch(r"[A-Za-z0-9_\-]{4,64}", pid or ""):
            return None
        p = self.root / pid
        return Workspace(p) if (p / "paper.json").exists() else None

    def all(self) -> list[Workspace]:
        return [Workspace(p) for p in sorted(self.root.iterdir()) if p.is_dir() and not p.name.startswith(".") and (p / "paper.json").exists()]

    # ---------- 列表摘要 ----------
    def summary(self, ws: Workspace) -> dict:
        paper = ws.load("paper") or {}
        meta = dict(paper.get("meta", {}))
        item = ws.load("item") or {}
        meta.update(item.get("meta_override") or {})
        reader = ws.load("reader") or {}
        disc = ws.load("discussion") or {}
        job = ws.load("job") or {}
        tr = paper.get("translation", {})
        notes = [n for n in reader.get("notes", {}).values() if not n.get("deleted")]
        replied = {e.get("reply_to") for e in disc.get("entries", []) if e.get("reply_to")}
        abstract = next((b.get("zh") or b.get("source_text", "") for b in paper.get("blocks", []) if b.get("role") == "abstract" and len(b.get("en", "")) > 50), "") or meta.get("abstract_en", "")
        result = {
            "id": ws.id,
            "title_zh": meta.get("title_zh", ""), "title_en": meta.get("title_en", ""), "short_zh": meta.get("short_zh", ""),
            "authors": meta.get("authors", ""), "affiliation": meta.get("affiliation", ""),
            "year": meta.get("year") or _year(meta.get("date", "")), "date": meta.get("date", ""),
            "venue": meta.get("venue", ""), "arxiv": meta.get("arxiv", ""), "url": _link(meta), "doi": meta.get("doi", ""),
            "pages": meta.get("page_count", 0), "done_pages": len(tr.get("done_pages", [])),
            "source_kind": meta.get("source_kind", "pdf"),
            "blocks": meta.get("block_count", 0), "done_blocks": len(tr.get("done_blocks", [])),
            "abstract": abstract,
            "meta_override": item.get("meta_override") or {},
            "metadata_warning": '题名来自文件名，请核对并修改' if meta.get('title_from_filename') and not item.get('meta_override',{}).get('title_en') else '',
            "tags": item.get("tags", []), "status": item.get("status", "unread"), "starred": bool(item.get("starred")),
            "added": item.get("added", ""), "last_opened": item.get("last_opened", ""),
            "progress": (reader.get("progress") or {}).get("ratio", 0),
            "notes": len([n for n in notes if n.get("kind") != "highlight"]),
            "highlights": len([n for n in notes if n.get("kind") == "highlight"]),
            "open_questions": len([n for n in notes if n.get("kind") == "question" and n["id"] not in replied]),
            "discussions": len(disc.get("entries", [])),
            "has_paper_note": bool((reader.get("paper_note") or {}).get("body")),
            "job": {k: job.get(k) for k in ("type", "state", "message", "done", "total", "updated", "error", "failed", "scope")} if job else None,
            "thumb": f"/p/{ws.id}/pages/page-001.webp" if (ws.root / "pages" / "page-001.webp").exists() else "",
        }
        result.update(read_id=ws.id, reading_source_kind=result["source_kind"], arxiv_match=item.get("arxiv_match"))
        from . import reflow
        result['pdf_reflow_default'] = result['source_kind'] != 'arxiv_html' and reflow.default_ready(ws)
        from . import pdf_pipeline
        derived=self.ws(((item.get("pdf_web_source") or {}).get("id")) or "")
        if result['source_kind'] != 'arxiv_html' and (pdf_pipeline.ready(ws) or (derived and pdf_pipeline.ready(derived))):
            result['pdf_reflow_default']=True
        web = self.web_source(ws)
        if web:
            web_summary = self.summary(web)
            for key in ("title_zh", "title_en", "authors", "year", "date", "venue", "arxiv"):
                if not result[key]:
                    result[key] = web_summary[key]
            for key in ("blocks", "done_blocks", "progress", "job", "abstract"):
                result[key] = web_summary[key]
            for key in ("notes", "highlights", "open_questions", "discussions"):
                if web_summary["source_kind"] == "pdf_sdt":result[key]=web_summary[key]
                else:result[key] += web_summary[key]
            result.update(read_id=web.id, reading_source_kind=web_summary["source_kind"], web_url=web_summary["url"],
                          local_notes=bool(notes or (reader.get("paper_note") or {}).get("body")))
            result["last_opened"] = max(result["last_opened"], web_summary["last_opened"])
        return result

    def list(self) -> list[dict]:
        with self._list_lock:
            signature = self._list_signature()
            if self._list_cache and self._list_cache[0] == signature:
                return copy.deepcopy(self._list_cache[1])
            result = self._list_uncached()
            # A concurrent write must not cache a mixed snapshot as current.
            if signature == self._list_signature():
                self._list_cache = (signature, copy.deepcopy(result))
            return result

    def _list_uncached(self) -> list[dict]:
        all_ws = self.all()
        linked = {web.id for ws in all_ws if (web := self.web_source(ws))}
        # Previous HTML snapshots remain directly readable, with their notes,
        # but replacing a PDF's reading source must not add duplicate cards.
        linked.update(entry["id"] for ws in all_ws
                      for entry in (ws.load("item") or {}).get("web_source_history", [])
                      if isinstance(entry, dict) and entry.get("id") and self.ws(entry["id"]))
        return [self.summary(ws) for ws in all_ws if ws.id not in linked and not ws.load("item").get("derived_from")]

    def web_source(self, ws):
        link = (ws.load("item") or {}).get("web_source") or {}
        web = self.ws(link.get("id", ""))
        if web and web.id != ws.id and web.load("paper").get("meta", {}).get("source_kind") == "arxiv_html":
            return web
        from . import pdf_pipeline
        derived = self.ws(((ws.load("item") or {}).get("pdf_web_source") or {}).get("id", ""))
        if derived and derived.id != ws.id and pdf_pipeline.ready(derived):
            return derived
        return None

    def find_html(self, aid):
        from . import arxivhtml
        for ws in self.all():
            meta = ws.load("paper").get("meta", {})
            if meta.get("source_kind") == arxivhtml.KIND and meta.get("arxiv") == "arXiv:" + aid:
                arxivhtml.verify(ws)
                return ws
        return None

    def attach_web(self, pdf, web, proof):
        meta = web.load("paper")["meta"]
        pdf.update("item", lambda item: item.update(web_source={"id": web.id, "url": meta["source_url"], "proof": proof}))
        def add(item):
            item["local_pdfs"] = sorted(set(item.get("local_pdfs", []) + [pdf.id]))
        web.update("item", add)

    # ---------- 导入 ----------
    def create_from_pdf(self, data: bytes, filename: str, meta: dict | None = None) -> tuple[Workspace, bool]:
        """建目录、落 PDF 和空数据文件。渲染原页、抽文字放到后台任务里做。返回 (目录, 是否新建)。"""
        if not data.startswith(b"%PDF"):
            raise ValueError("不是 PDF 文件")
        digest = sha256_bytes(data)
        pid = digest[:12]
        ws = Workspace(self.root / pid)
        if (ws.root / "paper.json").exists():
            return ws, False
        ws.root.mkdir(parents=True, exist_ok=True)
        (ws.root / "source.pdf").write_bytes(data)
        base_meta = {"title_zh": "", "title_en": "", "authors": "", "source": filename, "source_sha256": digest, "pdf": "source.pdf"}
        base_meta.update(meta or {})
        if not base_meta.get("title_en"):
            base_meta["title_en"] = _pdf_title(ws.root / "source.pdf") or Path(filename).stem
        write_json_atomic(ws.paper_path, {
            "schema": SCHEMA, "meta": base_meta,
            "translation": {"scope": "未开始", "done_pages": [], "note": ""},
            "glossary": [], "references": [], "blocks": [],
        })
        write_json_atomic(ws.discussion_path, empty_discussion())
        write_json_atomic(ws.reader_path, empty_reader())
        write_json_atomic(ws.item_path, {"added": now_iso(), "tags": [], "status": "unread", "starred": False})
        return ws, True

    def fetch(self, ref: str) -> tuple[bytes, str, dict]:
        """链接、arXiv 编号、DOI、标题 → (PDF, 文件名, 元数据)。见 sources.py。"""
        return sources.fetch(ref)

    def create_from_arxiv_html(self, ref: str, *, snapshot=None) -> tuple[Workspace, bool]:
        from . import arxivhtml
        raw, url = snapshot if snapshot else arxivhtml.fetch(ref)
        html, meta, blocks = arxivhtml.parse(raw, url)
        pid = "h" + sha256_bytes(url.encode() + b"\n" + raw)[:12]
        ws = Workspace(self.root / pid)
        if ws.paper_path.exists():
            return ws, False
        ws.root.mkdir(parents=True, exist_ok=True)
        (ws.root / "source.html").write_bytes(raw)
        (ws.root / "article.html").write_text(html, encoding="utf-8")
        meta["article_sha256"] = sha256_bytes((ws.root / "article.html").read_bytes())
        write_json_atomic(ws.paper_path, {"schema": SCHEMA, "meta": meta,
            "translation": {"done_pages": [], "done_blocks": []},
            "glossary": [], "references": [], "blocks": blocks})
        write_json_atomic(ws.discussion_path, empty_discussion())
        write_json_atomic(ws.reader_path, empty_reader())
        write_json_atomic(ws.item_path, {"added": now_iso(), "tags": [], "status": "unread", "starred": False})
        return ws, True

    def trash(self, pid: str) -> Path:
        ws = self.ws(pid)
        if not ws:
            raise KeyError(pid)
        dest = self.root / ".trash" / f"{pid}-{datetime.now():%Y%m%d%H%M%S}"
        dest.parent.mkdir(exist_ok=True)
        shutil.move(str(ws.root), dest)
        return dest

    def find_by_sha(self, digest: str) -> Workspace | None:
        return self.ws(digest[:12])


def _year(date: str) -> str:
    m = re.search(r"(19|20)\d{2}", date or "")
    return m.group(0) if m else ""


def _pdf_title(path: Path) -> str:
    try:
        import pypdf
        t = (pypdf.PdfReader(str(path)).metadata or {}).get("/Title", "") or ""
        return str(t).strip()
    except Exception:  # noqa: BLE001
        return ""


def migrate_folder(src: Path, lib: Library) -> Workspace:
    """把旧版技能生成的“xxx-共读”目录搬进文献库。"""
    src = Path(src)
    data = (src / "source.pdf").read_bytes()
    pid = sha256_bytes(data)[:12]
    dest = lib.root / pid
    if not dest.exists():
        shutil.copytree(src, dest, ignore=shutil.ignore_patterns("server.json", "*.html", "打开共读.cmd", ".write.lock"))
    ws = Workspace(dest)
    if not ws.item_path.exists():
        write_json_atomic(ws.item_path, {"added": now_iso(), "tags": [], "status": "reading", "starred": False})
    reader = read_json(ws.reader_path, {}) or {}
    reader.setdefault("paper_note", {})
    write_json_atomic(ws.reader_path, reader)
    return ws



def _link(meta: dict) -> str:
    """论文主页链接：填了就用；否则由 arXiv 编号或 DOI 推出来。"""
    if meta.get("url"):
        return meta["url"]
    m = sources.ARXIV_RE.search(meta.get("arxiv") or meta.get("source") or "")
    if m and (meta.get("arxiv") or re.fullmatch(r"\d{4}\.\d{4,5}(v\d+)?\.pdf", meta.get("source") or "")):
        aid = re.sub(r"v\d+$", "", m.group(1))  # f-string 里不能有反斜杠（Python 3.10/3.11）
        return f"https://arxiv.org/abs/{aid}"
    return f"https://doi.org/{meta['doi']}" if meta.get("doi") else ""

if __name__ == "__main__":  # 调试用：打印库摘要
    import sys
    print(json.dumps(Library(Path(sys.argv[1])).list(), ensure_ascii=False, indent=1))
