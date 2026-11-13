"""Local PDF -> pinned Zotero SDT -> translation, in a separate workspace.

The imported PDF workspace is never rewritten. A derived workspace owns its
new translations and subsequent reading state; old anchors are retained.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import threading
import tempfile
import re
from pathlib import Path

from . import arxivhtml, config, engines, reflow, reflow_prepare
from . import translation_scheduler, pdf_review, pdf_render
from .store import SCHEMA, Workspace, empty_discussion, empty_reader, now_iso, write_json_atomic, dir_lock

KIND = "pdf_sdt"
VERSION = 1


def reading_profile(cfg):
    return cfg.get("pdf_review_profile", "reading") == "reading"


def translation_text(node):
    """Keep list boundaries and explicit script indices in translator input."""
    if isinstance(node, list):
        return "".join(translation_text(n) for n in node)
    if not isinstance(node, dict):return ""
    if isinstance(node.get("text"), str):
        value = node["text"]
        style = node.get("style") or {}
        if style.get("sub"):return "_{" + value + "}"
        if style.get("sup"):return "^{" + value + "}"
        return value
    parts = [translation_text(n) for k in ("content", "items", "children") for n in node.get(k, [])]
    return ("\n" if node.get("type") == "list" else "").join(parts)


def reading_layout(paper, structure):
    """Restore native prose; retain only explicitly marked complex regions."""
    references = False
    regions = set(paper["meta"].get("pdf_original_region_refs", []))
    visuals = set()
    for i, node in enumerate(structure["content"]):
        if i == 0 or node.get("type") != "caption" or not re.match(r"Figure\s*\d", reflow_prepare.text(node)):continue
        previous = structure["content"][i-1]
        value = reflow_prepare.text(previous)
        # Some SDT charts are labelled paragraphs: numeric axes or corrupted
        # diagram labels immediately followed by their figure caption.
        numbers = len(re.findall(r"\d+(?:\.\d+)?", value))
        words = max(1, len(value.split()))
        sentences = len(re.findall(r"[.!?]\s+[A-Z]", value))
        chart_labels = numbers >= 10 and numbers / words >= .25 and sentences <= 2
        if previous.get("type") == "paragraph" and (chart_labels or "\ufffd" in value):
            visuals.add(i-1)
    for b in paper["blocks"]:
        ref = b.get("sdt_refs", [[None]])[0][0]
        if ref is None:continue
        node = structure["content"][ref]
        if node.get("type") == "heading":
            references = reflow_prepare.text(node).strip().lower() in ("references", "bibliography")
        b["role"] = "references" if references else b.get("role", "body")
        if not references and b["role"] == "references":b["role"] = "body"
        # Source review previously cropped every corrected word. A spelling
        # correction is not evidence that the native paragraph cannot reflow.
        b["display_source_crop"] = bool(b.get("restore_excluded_source") or ref in regions or ref in visuals)
        if ref in visuals:b["role"] = "visual-text"
        if node.get("type") == "list":b["source_list"] = True
    paper["meta"]["pdf_review_profile"] = "reading"


def identity(source):
    return reflow_prepare.digest(source.root / "source.pdf"), reflow_prepare.digest(source.paper_path)


def derived_id(source):
    pdf, paper = identity(source)
    return "pdfweb-" + hashlib.sha256(f"{VERSION}:{pdf}:{paper}".encode()).hexdigest()[:16]


def canonical_blocks(structure):
    """Translation IDs come directly from SDT paths, not fuzzy old-page matches."""
    blocks = []
    for i, node in enumerate(structure["content"]):
        if node.get("type") not in ("paragraph", "heading", "caption", "list", "note"):
            continue
        value = translation_text(node)
        if not value.strip():
            continue
        if node.get("flowClass") == "excluded" and furniture(value):
            continue
        pages = sorted({r[0] + 1 for r in node.get("anchor", {}).get("pageRects", [])})
        if not pages:
            raise ValueError(f"SDT 原文单元 {i} 缺少原页坐标")
        blocks.append({"id": f"sdt-{i}", "type": "heading" if node["type"] == "heading" else "para",
                       "page": pages[0], "en": value, "zh": "", "source_text": value,
                       "source_hash": arxivhtml.digest(value), "sdt_refs": [[i]],
                       "source_pages": pages, "restore_excluded_source":node.get("flowClass")=="excluded",
                       "display_source_crop":node.get("flowClass")=="excluded",
                       "role": "abstract" if value.strip().lower() == "abstract" else "body"})
    if not blocks:
        raise ValueError("Zotero 未提取到可翻译正文；保留原 PDF，未将空结果标为完成。")
    return blocks


def furniture(value):
    value=value.strip()
    return bool(re.fullmatch(r"\d{1,4}",value) or re.fullmatch(r"arXiv:\s*\d{4}\.\d{4,5}v\d+\s+\[[^\]]+\]\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}",value))


def translated(block):
    if block.get("role") in ("visual-text", "references"):return True
    kind=block.get("type")
    if kind=="math":return True  # The original formula is preserved, not translated.
    if kind=="list":return bool(block.get("items")) and all(not x.get("en") or x.get("zh") for x in block["items"])
    if kind in ("table","figure"):return not block.get("caption_en") or bool(block.get("caption_zh"))
    return not block.get("en") or bool(block.get("zh"))


def verify_extract(candidate):
    proof=json.loads((candidate/"cache-proof.json").read_text())
    for key in ("pack","structure","math","manifest"):
        name=reflow_prepare.FILES[key]
        if reflow_prepare.digest(candidate/name)!=proof.get("files",{}).get(name):
            raise ValueError("解析缓存证据发生变化，保留现有数据，未重新签发校验结果："+key)


def coverage(structure, blocks):
    translated={ref[0] for b in blocks for ref in b.get("sdt_refs",[])}
    ledger=[]
    for i,node in enumerate(structure["content"]):
        text=reflow_prepare.text(node).strip()
        disposition="translated" if i in translated else "page-furniture" if furniture(text) and node.get("flowClass")=="excluded" else "original-visual" if node.get("type") in ("image","figure","table","math","equation") else "empty" if not text else "uncovered"
        ledger.append({"ref":[i],"type":node.get("type"),"disposition":disposition,"text_sha256":arxivhtml.digest(text),"pages":sorted({r[0]+1 for r in node.get("anchor",{}).get("pageRects",[])})})
    return {"nodes":ledger,"complete":all(n["disposition"]!="uncovered" for n in ledger)}


def source_mapping(paper, structure, digest):
    records = []
    for b in paper["blocks"]:
        if not b.get("zh") and b.get("role") not in ("visual-text", "references"):
            continue
        records.append({"anchor": b["id"], "legacy_type": b["type"], "legacy_page": b["page"],
                        "source_english": b["en"], "source_chinese": "" if b.get("role") in ("visual-text", "references") else b["zh"], "legacy": b,
                        "refs": b["sdt_refs"], "source_pages": b["source_pages"],
                        "status": "canonical-source", "match": {"method": "sdt-source-identity"},
                        **({"source_warning":b["source_warning"]} if b.get("source_warning") else {}),
                        **({"restore_excluded_source":True} if b.get("restore_excluded_source") else {}),
                        **({"display_source_crop":True} if b.get("display_source_crop") else {})})
    return {"source_sha256": digest, "records": records, "issues": [],
            "counts": {"mapped": len(records), "unresolved": 0}, "quality": "source-bound"}


def translate_missing(ws, cfg, cancel, report):
    """Reuse the web translator's prompt and quality validation, without rewriting English."""
    paper = ws.load("paper")
    pending = [b for b in paper["blocks"] if not translated(b)]
    size = max(1, min(24, int(cfg.get("html_batch_blocks") or 6)))
    completed, failures = 0, {}
    batches = [pending[start:start + size] for start in range(0, len(pending), size)]
    quota = threading.Event()
    metrics = {"concurrency": translation_scheduler.concurrency(cfg), "batch_blocks": size,
               "model": cfg.get(cfg.get("engine", ""), {}).get("model"), "requests": [], "peak_active": 0}
    metric_lock = threading.Lock()
    active = 0
    def work(batch):
        nonlocal active
        if cancel.is_set():
            raise engines.Cancelled()
        if quota.is_set():
            return ({b["id"]: "额度不足，保留待翻译" for b in batch}, False)
        prompt = arxivhtml.prompt(paper, batch)
        proof_dir = ws.root / "translation-evidence"
        proof_dir.mkdir(exist_ok=True)
        name = batch[0]["id"]
        (proof_dir / (name + ".prompt.txt")).write_text(prompt)
        with metric_lock:
            active += 1
            metrics["peak_active"] = max(metrics["peak_active"], active)
            metrics["requests"].append({"ids": [b["id"] for b in batch], "prompt_sha256": arxivhtml.digest(prompt)})
        try:
            raw = engines.run(cfg, prompt, ws.root, None, cancel)
            (proof_dir / (name + ".response.txt")).write_text(raw)
            result = arxivhtml.validate(engines.parse_json(raw), batch)
            expected = {b["id"]: b["source_hash"] for b in batch}
            def save(current):
                for b in current["blocks"]:
                    if b["id"] in result:
                        if b.get("zh") or b["source_hash"] != expected[b["id"]] or arxivhtml.digest(b["en"]) != b["source_hash"]:
                            raise ValueError("原文或已有译文变化，停止覆盖")
                        b["zh"] = result[b["id"]]
                current["translation"]["done_blocks"] = [b["id"] for b in current["blocks"] if b.get("zh")]
            ws.update("paper", save)
            return ({}, False)
        except engines.Cancelled:
            raise
        except Exception as e:
            failed = {b["id"]: str(e)[:500] for b in batch}
            write_json_atomic(proof_dir / (name + ".failure.json"), {"ids": list(failed), "error": str(e)})
            # Do not continue consuming requests after an unavailable provider.
            if any(s in str(e).lower() for s in ("quota", "usage limit", "找不到", "额度", "没有配置")):
                quota.set()
            return (failed, any(s in str(e).lower() for s in ("429", "timeout", "rate limit", "connection")))
        finally:
            with metric_lock:
                active -= 1
    def finished(batch, failed, allowed):
        nonlocal completed
        failures.update(failed)
        completed += len(batch) - len(failed)
        report(completed, len(pending), f"PDF 翻译进度已保存 · 最多 {allowed} 路")
    try:
        if batches:
            report(0, len(pending), f"正在逐段翻译 PDF 原文 · 最多 {metrics['concurrency']} 路")
            translation_scheduler.run(batches, work, cfg, cancel, finished)
    finally:
        write_json_atomic(ws.root / "pdf-translation-metrics.json", metrics)
    return failures


def prepare(lib, source, cfg, cancel, report, translate=True):
    target,evidence=_prepare(lib,source,cfg,cancel,report,translate)
    # Supported content repairs are bounded, source-grounded and re-rendered.
    # Model output never becomes executable code or bypasses publication checks.
    for attempt in range(2):
        rendered=evidence.get("render_review") or {}
        ids=rendered.get("repairable_math_ids") or []
        visuals=rendered.get("repairable_visual_refs") or []
        if evidence["complete"] or not (ids or visuals):break
        before=reflow_prepare.digest(target.paper_path)
        if ids and cfg.get("pdf_ai_review"):
            report(0,len(ids),f"AI 正在修复公式展示 · 第 {attempt+1} 轮")
            pdf_review.review(target,cfg,cancel,"render",report,only_ids=set(ids),diagnostics=rendered.get("failed"))
        if visuals:
            report(0,len(visuals),"正在从原 PDF 区域恢复图表，随后重新检查")
            target.update("paper",lambda p:p["meta"].update(render_visual_repairs=sorted(set(p["meta"].get("render_visual_repairs",[]))|set(visuals))))
        if reflow_prepare.digest(target.paper_path)==before:break
        target,evidence=_prepare(lib,source,cfg,cancel,report,translate)
    return target,evidence


def _prepare(lib, source, cfg, cancel, report, translate=True):
    """Create/resume derived data; attach only a completely prepared cache."""
    pdf_hash, paper_hash = identity(source)
    target = Workspace(lib.root / derived_id(source))
    target.root.mkdir(parents=True, exist_ok=True)
    with dir_lock(target.root, ".prepare.lock", timeout=1):
        if cancel.is_set():
            raise engines.Cancelled()
        if not target.paper_path.exists():
            shutil.copy2(source.root / "source.pdf", target.root / "source.pdf")
            original = source.load("paper")
            meta = dict(original["meta"], source_kind=KIND, original_id=source.id, source_sha256=pdf_hash)
            data = dict(original, meta=meta)
            write_json_atomic(target.paper_path, data)
            # Snapshot existing state without writing it back or guessing new anchors.
            for part in ("reader", "discussion", "chat", "layout"):
                if (source.root / (part + ".json")).is_file():
                    shutil.copy2(source.root / (part + ".json"), target.root / (part + ".json"))
            if not target.reader_path.exists():
                write_json_atomic(target.reader_path, empty_reader())
            if not target.discussion_path.exists():
                write_json_atomic(target.discussion_path, empty_discussion())
            write_json_atomic(target.item_path, {"added": now_iso(), "derived_from": source.id,
                                                "source_paper_sha256": paper_hash})
        worker = Path(cfg.get("pdf_worker_root") or config.HOME / "runtime" / "document-worker")
        candidate = target.root / "sdt-cache"
        if not (candidate / "structure.json").exists():
            report(0, 1, "正在使用 Zotero 解析 PDF")
            with tempfile.TemporaryDirectory(prefix="pdf-build-", dir=target.root.parent) as temporary:
                build = Path(temporary) / "output"
                try:
                    reflow_prepare.prepare(target.root, worker, build, cancel=cancel)
                    shutil.move(str(build), candidate)
                except Exception:
                    if (build / "failure.json").exists():
                        shutil.copy2(build / "failure.json", target.root / "preparation-failure.json")
                    raise
        if cancel.is_set():
            raise engines.Cancelled()
        verify_extract(candidate)
        structure = json.loads((candidate / "structure.json").read_text())
        paper = target.load("paper")
        canonical = not source.load("paper").get("blocks")
        if canonical and not paper.get("blocks"):
            blocks = canonical_blocks(structure)
            def initialize(p):
                p.update(blocks=blocks,translation={"done_blocks":[]})
                p["meta"]["block_count"]=len(blocks)
                p["meta"]["page_count"]=max(page for b in blocks for page in b["source_pages"])
                p["meta"]["title_en"]=blocks[0]["en"] if blocks[0]["type"]=="heading" else p["meta"].get("title_en","")
            target.update("paper",initialize)
        elif canonical:
            expected=canonical_blocks(structure)
            existing={b["id"] for b in paper["blocks"]}
            missing=[b for b in expected if b["id"] not in existing]
            if missing:
                target.update("paper",lambda p:p.update(blocks=sorted(p["blocks"]+missing,key=lambda b:b["sdt_refs"][0][0])))
        source_coverage=coverage(structure,target.load("paper")["blocks"]) if canonical else None
        if source_coverage:write_json_atomic(target.root/"source-coverage.json",source_coverage)
        failures = {}
        source_review = translation_review = None
        reading = reading_profile(cfg)
        if canonical and reading:
            target.update("paper", lambda p: reading_layout(p, structure))
            source_review = {"complete":True, "profile":"reading", "skipped":True,
                             "reason":"原文保留解析结构；重点检查译文含义，不逐字改写原文"}
        if canonical and not reading and cfg.get("pdf_ai_review") and translate and cfg.get("engine") != "none":
            source_review = pdf_review.review(target,cfg,cancel,"source",report)
        if canonical and translate and cfg.get("engine") != "none":
            if not cfg.get("pdf_ai_review") or (source_review and source_review["complete"]):
                failures = translate_missing(target, cfg, cancel, report)
            if cfg.get("pdf_ai_review") and source_review and source_review["complete"] and not failures:
                translation_review = pdf_review.review(target,cfg,cancel,"translation",report)
        paper = target.load("paper")
        if canonical:
            def metadata(p):
                p["meta"]["block_count"]=len(p["blocks"])
                p["meta"]["page_count"]=max(page for b in p["blocks"] for page in b["source_pages"])
                if p["blocks"][0]["type"]=="heading":p["meta"]["title_en"]=p["blocks"][0]["en"]
            target.update("paper",metadata)
            paper=target.load("paper")
        mapping = source_mapping(paper, structure, pdf_hash) if canonical else reflow_prepare.mapping(paper, structure, pdf_hash)
        if not canonical:
            try:
                accepted_cache, _ = reflow.verified(source)
                mapping = json.loads((accepted_cache / "full-mapping.json").read_text())
                resources = json.loads((accepted_cache / "cache-proof.json").read_text()).get("resources", reflow.FILES)
                for key in ("pack", "structure", "math", "manifest"):
                    shutil.copy2(accepted_cache / resources[key], candidate / reflow_prepare.FILES[key])
            except ValueError:
                pass
        write_json_atomic(candidate / "full-mapping.json", mapping)
        mapping["visual_repairs"]=[{"anchor":"visual-"+str(i),"refs":[[i]]} for i in paper["meta"].get("render_visual_repairs",[])]
        write_json_atomic(candidate / "full-mapping.json", mapping)
        def reading_counts(p):
            p["meta"]["block_count"]=len(mapping["records"])+len(mapping.get("issues",[]))
            p.setdefault("translation",{})["done_blocks"]=[r["anchor"] for r in mapping["records"]]
        target.update("paper",reading_counts)
        paper=target.load("paper")
        proof = json.loads((candidate / "cache-proof.json").read_text())
        proof["paper_sha256"] = reflow_prepare.digest(target.paper_path)
        proof.update(schema=2, resources=reflow_prepare.FILES, quality="preview")
        proof["files"] = {name: reflow_prepare.digest(candidate / name) for name in reflow_prepare.FILES.values()}
        write_json_atomic(candidate / "cache-proof.json", proof)
        destination = config.HOME / ".pdf-reflow" / pdf_hash / proof["paper_sha256"]
        if destination.exists() and reflow_prepare.digest(destination / "cache-proof.json") != reflow_prepare.digest(candidate / "cache-proof.json"):
            previous = destination.with_name(destination.name + "-previous-" + reflow_prepare.digest(destination / "cache-proof.json")[:12])
            if previous.exists():
                raise ValueError("缓存历史路径已存在，保留缓存并停止发布")
            destination.rename(previous)
        if not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(candidate, destination)
        complete = bool(paper["blocks"]) and all(translated(b) for b in paper["blocks"]) and not mapping.get("issues") and not failures
        if canonical and not translate:
            complete = False
        if canonical and cfg.get("pdf_ai_review") and not reading:
            complete = complete and bool(source_review and source_review["complete"] and translation_review and translation_review["complete"])
        if canonical:complete=complete and source_coverage["complete"]
        evidence = {"schema": VERSION, "source_id": source.id, "source_sha256": pdf_hash,
                    "source_paper_sha256": paper_hash, "paper_sha256": proof["paper_sha256"],
                    "runtime": reflow.runtime_identity(), "cache_proof_sha256": reflow_prepare.digest(destination / "cache-proof.json"),
                    "complete": complete, "failed": failures, "unresolved": len(mapping.get("issues", [])),
                    "canonical_source": canonical, "created": now_iso()}
        evidence["ai_review"] = {"source":source_review,"translation":translation_review}
        evidence["review_profile"] = "reading" if reading else "strict"
        evidence["reading_warnings"] = (translation_review or {}).get("unresolved", {})
        evidence["source_coverage"]=source_coverage
        write_json_atomic(target.root / "pdf-pipeline.json", evidence)
        if complete and cfg.get("pdf_render_required",True):
            rendered=pdf_render.check(target,cfg,cancel,report)
            evidence["render_review"]=rendered
            evidence["complete"]=complete and rendered["complete"]
            write_json_atomic(target.root/"pdf-pipeline.json",evidence)
        if identity(source) != (pdf_hash, paper_hash):
            raise ValueError("准备期间源 PDF 或已有译文变化，未切换入口")
        # This link is written only in the currently selected library, initially isolated.
        source.update("item", lambda i: i.update(pdf_web_source={"id": target.id}))
        return target, evidence


def ready(ws):
    try:
        evidence = json.loads((ws.root / "pdf-pipeline.json").read_text())
        if not config.load().get("pdf_web_enabled") or evidence["schema"] != VERSION or not evidence["complete"]:
            return False
        if config.load().get("pdf_render_required",True) and not pdf_render.valid(ws):return False
        if evidence.get("canonical_source") and config.load().get("pdf_ai_review") and evidence.get("review_profile") != "reading":
            audit=evidence.get("ai_review") or {}
            if not all((audit.get(stage) or {}).get("complete") for stage in ("source","translation")):
                return False
        root, source_hash = reflow.verified(ws)
        return (evidence["source_sha256"] == source_hash
                and evidence["paper_sha256"] == reflow_prepare.digest(ws.paper_path)
                and evidence["runtime"] == reflow.runtime_identity()
                and evidence["cache_proof_sha256"] == reflow_prepare.digest(root / "cache-proof.json"))
    except (OSError, ValueError, KeyError, TypeError):
        return False
