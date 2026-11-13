"""本地 PDF 的 arXiv 来源匹配。标题只提供候选，自动切换必须校验 PDF 字节。"""
from __future__ import annotations

import hashlib
import re
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote

from . import arxivhtml, sources


def _title_key(text):
    return re.sub(r"[^\w]", "", unicodedata.normalize("NFKC", text).casefold())


def identity(ws) -> dict:
    meta = (ws.load("paper") or {}).get("meta", {})
    text, title = "", ""
    try:
        from pypdf import PdfReader
        pdf = PdfReader(str(ws.root / "source.pdf"))
        text = pdf.pages[0].extract_text() or ""
        title = str((pdf.metadata or {}).get("/Title") or "").strip()
    except Exception:  # 损坏、加密或扫描件仍保留 PDF，可按已有元数据查候选
        pass
    # 不从参考文献或正文中的裸编号认定本篇论文。
    stamp = re.search(r"\barxiv\s*:\s*(" + sources.ARXIV_RE.pattern + r")", text[:4000], re.I)
    aid = stamp.group(1) if stamp else ""
    if not aid:
        for value in (meta.get("arxiv", ""), Path(meta.get("source", "")).name.removesuffix(".pdf")):
            try:
                aid = arxivhtml.arxiv_id(value)
                break
            except ValueError:
                pass
    doi = sources.DOI_RE.search(text[:4000])
    return {"arxiv": aid, "doi": meta.get("doi") or (doi.group(1) if doi else ""),
            "title": title or meta.get("title_en", "")}


def candidate(ws) -> dict | None:
    ident = identity(ws)
    if ident["arxiv"]:
        return {"arxiv": ident["arxiv"], "title": ident["title"], "via": "pdf_identifier"}
    found = sources.s2_lookup("DOI:" + ident["doi"]) if ident["doi"] else None
    if not found and ident["title"]:
        found = sources.s2_search_title(ident["title"])
    if found and (found.get("externalIds") or {}).get("ArXiv"):
        return {"arxiv": arxivhtml.arxiv_id(found["externalIds"]["ArXiv"]),
                "title": found.get("title", ""), "via": "metadata_search"}
    if not ident["title"] or len(ident["title"]) < 12:
        return None
    # Semantic Scholar 无结果时，查询 arXiv 官方元数据；相似标题只作候选。
    query = quote('ti:"' + ident["title"].replace('"', ' ') + '"')
    raw, _, _ = sources._get("https://export.arxiv.org/api/query?search_query=" + query + "&max_results=5",
                             "application/atom+xml", 20, 2_000_000)
    ns = {"a": "http://www.w3.org/2005/Atom"}
    for entry in ET.fromstring(raw).findall("a:entry", ns):
        title = " ".join(entry.findtext("a:title", "", ns).split())
        if _title_key(title) == _title_key(ident["title"]):
            return {"arxiv": arxivhtml.arxiv_id(entry.findtext("a:id", "", ns)),
                    "title": title, "via": "arxiv_title_search"}
    return None


def resolve(lib, ws, cancel, accept_candidate=False) -> dict:
    """返回持久化匹配信息；所有论文文件、译文、PDF 批注都不修改。"""
    from .engines import Cancelled
    def check():
        if cancel.is_set():
            raise Cancelled()
    check()
    linked = lib.web_source(ws)
    if linked:
        arxivhtml.verify(linked)
        return {"state": "matched", "web_id": linked.id, "message": "已关联网页双语阅读", "proof": (ws.load("item") or {}).get("web_source", {}).get("proof")}
    saved = (ws.load("item") or {}).get("arxiv_match", {})
    c = saved.get("candidate") if accept_candidate else None
    try:
        c = c or candidate(ws)
    except (ValueError, OSError, ET.ParseError) as e:
        return {"state": "unavailable", "message": "来源查找暂时失败，保留 PDF 阅读", "error": str(e)[:300]}
    check()
    if not c:
        return {"state": "not_found", "message": "未找到对应 arXiv 论文，保留 PDF 阅读"}
    c = dict(c)
    c["url"] = "https://arxiv.org/html/" + c["arxiv"]
    try:
        # 已保存的相同版本优先复用，保留已有译文和网页批注。
        web = lib.find_html(c["arxiv"]) if re.search(r"v\d+$", c["arxiv"]) else None
        if web:
            arxivhtml.verify(web)
            url = web.load("paper")["meta"]["source_url"]
            raw = None
        else:
            raw, url = arxivhtml.fetch(c["arxiv"])
            arxivhtml.parse(raw, url)  # 先检查确实有可读正文，不创建空 HTML 记录
        c.update(arxiv=arxivhtml.arxiv_id(url), url=url)
        check()
        if not accept_candidate:
            data, _, final = sources._get("https://arxiv.org/pdf/" + c["arxiv"], "application/pdf", 30)
            final_id = arxivhtml.arxiv_id(final)
            if final_id != c["arxiv"] or not data.startswith(b"%PDF"):
                raise sources.SourceError("无法校验指定版本的 arXiv PDF")
            digest = hashlib.sha256(data).hexdigest()
            local = hashlib.sha256((ws.root / "source.pdf").read_bytes()).hexdigest()
            if digest != local:
                return {"state": "candidate", "candidate": c,
                        "message": "找到候选网页，但 PDF 文件不同；版本或内容未确认，继续使用本地 PDF"}
            proof = {"kind": "pdf_sha256", "sha256": local, "arxiv": c["arxiv"]}
        else:
            proof = {"kind": "user_selected", "arxiv": c["arxiv"]}
        check()
        if not web:
            web = lib.find_html(c["arxiv"]) or lib.create_from_arxiv_html(url, snapshot=(raw, url))[0]
        lib.attach_web(ws, web, proof)
        return {"state": "matched", "candidate": c, "web_id": web.id, "proof": proof,
                "message": "PDF 文件校验一致，优先网页双语阅读" if proof["kind"] == "pdf_sha256" else "已按你的选择使用候选网页；内容一致性未确认"}
    except (ValueError, OSError) as e:
        return {"state": "unavailable", "candidate": c, "message": "网页或版本校验暂不可用，保留 PDF 阅读", "error": str(e)[:300]}
