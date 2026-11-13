"""arXiv HTML 共读：保存网页快照，原文来自 DOM，模型只写中文。"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from . import engines, sources, translation_context, translation_scheduler, translation_quality
from .store import now_iso, write_json_atomic

KIND = "arxiv_html"
SELECTOR = ".ltx_p, .ltx_title, .ltx_caption, table.ltx_tabular"


def digest(data: bytes | str) -> str:
    return hashlib.sha256(data.encode("utf-8") if isinstance(data, str) else data).hexdigest()


def arxiv_id(ref: str) -> str:
    ref = (ref or "").strip().strip("<>")
    if ref.startswith(("http://", "https://")):
        u = urlparse(ref)
        if u.hostname not in ("arxiv.org", "www.arxiv.org", "export.arxiv.org"):
            raise sources.SourceError("网页共读需要 arXiv 链接或编号")
        ref = re.sub(r"^/(abs|html|pdf)/", "", u.path).removesuffix(".pdf").rstrip("/")
    ref = re.sub(r"^arxiv:\s*", "", ref, flags=re.I)
    if not sources.ARXIV_RE.fullmatch(ref):
        raise sources.SourceError("请填 arXiv 编号，或 arxiv.org 的 abs/html/pdf 链接")
    return ref


def _version(raw: bytes, final: str, aid: str) -> str:
    base = re.sub(r"v\d+$", "", aid)
    ids = []
    try:
        ids.append(arxiv_id(final))
    except ValueError:
        raise sources.SourceError("arXiv HTML 跳转到了其他网站")
    if re.sub(r"v\d+$", "", ids[0]) != base:
        raise sources.SourceError("arXiv HTML 跳转到了另一篇论文")
    soup = BeautifulSoup(raw, "html.parser")
    for a in soup.select('a[href], link[rel="canonical"]'):
        href = urljoin(final, a.get("href", ""))
        if urlparse(href).path.startswith(("/abs/", "/pdf/")):
            try:
                ids.append(arxiv_id(href))
            except ValueError:
                pass
    versions = {i for i in ids if re.sub(r"v\d+$", "", i) == base and re.search(r"v\d+$", i)}
    if re.search(r"v\d+$", aid):
        if versions and versions != {aid}:
            raise sources.SourceError("网页返回的论文版本与请求不一致")
        return aid
    if len(versions) != 1:
        raise sources.SourceError("无法确定网页版本，请使用带 v1/v2 等版本号的 arXiv 链接")
    return versions.pop()


def fetch(ref: str) -> tuple[bytes, str]:
    aid = arxiv_id(ref)
    url = f"https://arxiv.org/html/{aid}"
    try:
        raw, _, final = sources._get(url, "text/html", 60, 20_000_000)
    except sources.SourceError as e:
        raise sources.SourceError("该论文的 arXiv HTML 暂时不可用；可选择 PDF 导入。" + str(e)) from e
    pinned = _version(raw, final, aid)
    url = f"https://arxiv.org/html/{pinned}"
    if not re.search(r"v\d+$", aid):
        raw, _, final = sources._get(url, "text/html", 60, 20_000_000)
        _version(raw, final, pinned)
    return raw, url


def _prompt_text(node) -> str:
    """给翻译引擎的副本：数学用 TeX 表示，不改变被展示的节点。"""
    copy = BeautifulSoup(str(node), "html.parser")
    for math in copy.find_all("math"):
        tex = math.get("alttext")
        if not tex:
            annotation = math.find("annotation", attrs={"encoding": "application/x-tex"})
            tex = annotation.get_text() if annotation else None
        math.replace_with(f" ${tex}$ " if tex else math.get_text(" ", strip=True))
    for note in copy.select(".ltx_note"):
        mark, content = note.select_one(".ltx_note_mark"), note.select_one(".ltx_note_content")
        if not mark or not content:
            continue
        label = mark.get_text(strip=True)
        for duplicate in content.select(".ltx_note_mark, .ltx_tag_note"):
            duplicate.decompose()
        text = content.get_text(" ", strip=True)
        note.replace_with(f"[FOOTNOTE:{label}]{text}[/FOOTNOTE:{label}]")
    for table in copy.select("table.ltx_tabular"):
        rows = [[{"text": c.get_text(" ", strip=True), "colspan": c.get("colspan", "1"),
                  "rowspan": c.get("rowspan", "1")} for c in row.find_all(["th", "td"], recursive=False)]
                for row in table.find_all("tr")]
        table.replace_with(" 表格行列：" + json.dumps(rows, ensure_ascii=False) + " ")
    return re.sub(r"\s+", " ", copy.get_text()).strip()


def _graphic_url(value, url):
    absolute = urljoin(url, value or "")
    u = urlparse(absolute)
    pinned = arxiv_id(url)
    if u.scheme == "https" and u.hostname == "arxiv.org" and u.path.startswith("/html/" + pinned + "/"):
        return absolute
    return None


def visual_assets(ws):
    """从冻结快照恢复旧导入时被 object 过滤掉的原图；不改 article/paper。"""
    paper = verify(ws)
    soup = BeautifulSoup((ws.root / "source.html").read_bytes(), "html.parser")
    assets = []
    for node in soup.select('article.ltx_document object.ltx_graphics[type^="image/"]'):
        parent = node.find_parent("figure", id=True)
        src = _graphic_url(node.get("data"), paper["meta"]["source_url"])
        if parent and src:
            assets.append({"parent": parent["id"], "id": node.get("id", ""), "src": src,
                           "width": node.get("width", ""), "height": node.get("height", ""),
                           "class": " ".join(node.get("class", []))})
    return assets


def translation_blocks(ws, paper=None):
    """原表不由 AI 重建；保留旧译表，但新翻译跳过表格单元。"""
    paper = paper or verify(ws)
    soup = BeautifulSoup((ws.root / "article.html").read_text(encoding="utf-8"), "html.parser")
    tables = {n.get("data-easyread-id") for n in soup.select("table.ltx_tabular[data-easyread-id]")}
    return [b for b in paper["blocks"] if b["id"] not in tables]


def parse(raw: bytes, url: str) -> tuple[str, dict, list[dict]]:
    soup = BeautifulSoup(raw, "html.parser")
    article = soup.select_one("article.ltx_document")
    if not article:
        raise sources.SourceError("该网页没有可读取的 arXiv HTML 正文；请选择 PDF 导入")
    title = article.select_one(".ltx_title_document")
    authors = article.select(".ltx_personname")
    meta = {"source_kind": KIND, "url": url, "source_url": url,
            "arxiv": "arXiv:" + arxiv_id(url), "source": url,
            "source_sha256": digest(raw), "fetched_at": now_iso(),
            "title_en": title.get_text(" ", strip=True) if title else (soup.title.get_text() if soup.title else arxiv_id(url)),
            "authors": ", ".join(a.get_text(" ", strip=True) for a in authors),
            "pages": [], "page_count": 0}
    # 只移除可执行内容；正文文字、MathML、图片、表格和原有锚点都保留。
    # SVG 作为 img 显示原资源，不执行 object 中的活动内容。
    for node in soup.select('object.ltx_graphics[type^="image/"]'):
        src = _graphic_url(node.get("data"), url)
        if src:
            image = soup.new_tag("img", src=src, alt="")
            for attr in ("id", "class", "width", "height", "style"):
                if node.has_attr(attr):
                    image[attr] = node[attr]
            node.insert_before(image)
            node.unwrap()  # 保留可能存在的原图备用文本
    for node in soup.select("script, iframe, object, embed, form, base, meta[http-equiv]"):
        node.decompose()
    for node in soup.find_all(True):
        for attr in list(node.attrs):
            if attr.lower().startswith("on") or attr.lower() in ("srcdoc", "autofocus"):
                del node[attr]
    blocks = []
    chosen = set()
    for node in article.select(SELECTOR):
        if any(id(p) in chosen for p in node.parents):
            continue
        if node.find_parent(class_=re.compile(r"ltx_bibliography|ltx_biblist")):
            continue
        text = node.get_text()
        if not text.strip():
            continue
        bid = f"web-{len(blocks) + 1}"
        abstract = bool(node.find_parent(class_="ltx_abstract"))
        blocks.append({"id": bid, "type": "para", "en": text, "zh": "",
                       "source_text": _prompt_text(node), "source_hash": digest(text),
                       "translatable": node.name != "table",
                       "role": "abstract" if abstract else "body",
                       "node_id": node.get("id", "")})
        node["data-easyread-id"] = bid
        chosen.add(id(node))
    if not blocks:
        raise sources.SourceError("网页里没有找到正文段落")
    # 保留本地引用跳转；将图片和 CSS 的相对地址指回固定的 arXiv 版本。
    for node in soup.find_all(True):
        for attr in ("href", "src", "poster", "xlink:href"):
            value = node.get(attr)
            if not isinstance(value, str) or value.startswith("#"):
                continue
            absolute = urljoin(url, value)
            u = urlparse(absolute)
            if u.scheme not in ("http", "https", "mailto"):
                del node[attr]
                continue
            if attr == "href" and absolute.split("#")[0] == url and u.fragment:
                node[attr] = "#" + u.fragment
            else:
                node[attr] = absolute
            if node.name == "a" and not node[attr].startswith("#"):
                node["target"], node["rel"] = "_blank", "noopener noreferrer"
        if node.has_attr("srcset"):
            del node["srcset"]  # 保留 src，避免相对候选地址落到本地服务。
    # 显示原论文 article，省去网站导航。CSS 与数学结构仍来自原网页。
    head = str(soup.head) if soup.head else "<head></head>"
    html = '<!doctype html><html lang="en">' + head + "<body>" + str(article) + "</body></html>"
    meta["block_count"] = sum(b["translatable"] for b in blocks)
    return html, meta, blocks


def verify(ws) -> dict:
    paper = ws.load("paper")
    if digest((ws.root / "source.html").read_bytes()) != paper["meta"]["source_sha256"]:
        raise ValueError("网页快照校验失败，请重新导入该版本")
    if digest((ws.root / "article.html").read_bytes()) != paper["meta"]["article_sha256"]:
        raise ValueError("阅读网页校验失败，请重新导入该版本")
    for b in paper["blocks"]:
        if digest(b["en"]) != b["source_hash"]:
            raise ValueError("英文段落校验失败，请重新导入该版本")
    return paper


def include_tables(ws) -> int:
    """给旧的网页快照补表格翻译单元；原文和已有译文保持不变。"""
    paper = verify(ws)
    path = ws.root / "article.html"
    soup = BeautifulSoup(path.read_text(encoding="utf-8"), "html.parser")
    additions = []
    existing = {b["id"] for b in paper["blocks"]}
    for table in soup.select("article.ltx_document table.ltx_tabular"):
        if table.get("data-easyread-id") or table.find_parent(attrs={"data-easyread-id": True}):
            continue
        if table.find_parent(class_=re.compile(r"ltx_bibliography|ltx_biblist")):
            continue
        text = table.get_text()
        if not text.strip():
            continue
        bid = f"web-table-{len(additions) + 1}"
        while bid in existing:
            bid += "-new"
        existing.add(bid)
        additions.append({"id": bid, "type": "para", "en": text, "zh": "", "source_hash": digest(text),
                          "source_text": _prompt_text(table), "role": "body", "node_id": table.get("id", "")})
        table["data-easyread-id"] = bid
    if not additions:
        return 0
    html = str(soup)
    order = {n["data-easyread-id"]: i for i, n in enumerate(soup.select("[data-easyread-id]"))}
    def save(current):
        if current["meta"]["article_sha256"] != paper["meta"]["article_sha256"]:
            raise ValueError("补表格期间网页快照发生变化")
        path.write_bytes(html.encode("utf-8"))
        current["blocks"].extend(additions)
        current["blocks"].sort(key=lambda b: order[b["id"]])
        current["meta"]["article_sha256"] = digest(html)
        current["meta"]["block_count"] = len(current["blocks"])
    ws.update("paper", save)
    return len(additions)


def prompt(paper: dict, blocks: list[dict], context=None) -> str:
    return translation_context.prompt(paper, blocks, context or translation_context.freeze(paper, ""))


class TranslationQualityError(engines.EngineError):
    def __init__(self, valid, invalid, messages):
        super().__init__("；".join(messages))
        self.valid, self.invalid = valid, invalid


def validate(data: dict, blocks: list[dict]) -> dict[str, str]:
    if not isinstance(data, dict) or not isinstance(data.get("translations"), list):
        raise engines.EngineError("模型没有返回逐段中文译文")
    expected = {b["id"]: b for b in blocks}
    result = {}
    for row in data["translations"]:
        if not isinstance(row, dict):
            raise engines.EngineError("译文条目格式错误")
        bid = row.get("id")
        if bid not in expected or bid in result or row.get("source_hash") != expected[bid]["source_hash"]:
            raise engines.EngineError("译文与原文段落不匹配，未保存本批译文")
        zh = row.get("zh")
        if not isinstance(zh, str) or not zh.strip():
            raise engines.EngineError("模型遗漏了中文译文，未保存本批译文")
        result[bid] = zh.strip()
    if result.keys() != expected.keys():
        raise engines.EngineError("模型遗漏了段落，未保存本批译文")
    invalid, messages = [], []
    for bid, zh in result.items():
        warnings = translation_quality.issues(expected[bid]["source_text"], zh)
        note_tags = lambda text: re.findall(r"\[/?FOOTNOTE:[^\]\n]+\]", text)
        if note_tags(expected[bid]["source_text"]) != note_tags(zh):
            warnings.append("脚注边界标记必须逐一原样保留，不得将脚注并入正文。")
        if warnings:
            invalid.append(bid)
            messages.extend(warnings)
    if invalid:
        raise TranslationQualityError({bid: zh for bid, zh in result.items() if bid not in invalid}, invalid, messages)
    return result


def _journal(ws, message):
    with (ws.root / "job.log").open("a", encoding="utf-8") as out:
        out.write(f"{now_iso()}  {message}\n")


def translate(ws, cfg: dict, scope: str, cancel, report, retry: bool = False) -> dict:
    paper = verify(ws)
    blocks = translation_blocks(ws, paper)
    if scope == "abstract":
        blocks = [b for b in blocks if b.get("role") == "abstract"]
    elif scope.startswith("first:"):
        blocks = blocks[:max(1, int(scope.split(":", 1)[1]))]
    if retry:
        failed_ids = set((ws.load("job") or {}).get("retry_ids", []))
        blocks = [b for b in blocks if b["id"] in failed_ids]
    blocks = [b for b in blocks if not b.get("zh")]
    done, failed = 0, {}
    workers = translation_scheduler.concurrency(cfg)
    batch_size = max(1, min(24, int(cfg.get("html_batch_blocks") or 6)))
    batch_chars = max(1000, min(24000, int(cfg.get("html_batch_chars") or 10000)))
    batches, batch, chars = [], [], 0
    for b in blocks:
        if batch and (len(batch) >= batch_size or chars + len(b["source_text"]) > batch_chars):
            batches.append(batch)
            batch, chars = [], 0
        batch.append(b)
        chars += len(b["source_text"])
    if batch:
        batches.append(batch)
    context = translation_context.freeze(paper, (ws.root / "article.html").read_text(encoding="utf-8"))
    started = time.monotonic()
    metrics = {"started": now_iso(), "configured_concurrency": workers, "batch_blocks": batch_size,
               "batch_chars": batch_chars, "adaptive": cfg.get("html_adaptive", True),
               "context_sha256": digest(json.dumps(context, ensure_ascii=False, sort_keys=True)),
               "requests": [], "peak_active": 0}
    metric_lock = threading.Lock()
    active = 0
    _journal(ws, f"网页翻译开始：{len(blocks)} 段，范围 {scope}，引擎 {cfg.get('engine', '')}，并发 {workers}")
    quota = threading.Event()
    quota_errors = []
    report(0, len(blocks), f"正在翻译全文，{workers} 路并行")
    temporary_error = re.compile(r"429|rate.?limit|too many requests|timeout|超过 \d+ 秒|temporar|\b50[234]\b|connection|stream.*disconnect", re.I)
    quota_error = re.compile(r"quota|usage limit|session limit|余额|额度|接口返回 40[12]", re.I)

    def request(batch, hint=""):
        nonlocal active
        batch_prompt = prompt(paper, batch, context)
        if hint:
            batch_prompt = batch_prompt.replace("\n输入：", "\n必须核对并修正：" + hint + "\n输入：", 1)
        with metric_lock:
            active += 1
            metrics["peak_active"] = max(metrics["peak_active"], active)
        start = time.monotonic()
        error = ""
        try:
            return engines.run(cfg, batch_prompt, ws.root, None, cancel)
        except Exception as e:
            error = str(e)
            raise
        finally:
            with metric_lock:
                active -= 1
                metrics["requests"].append({"ids": [b["id"] for b in batch],
                    "seconds": round(time.monotonic() - start, 3),
                    "source_characters": sum(len(b["source_text"]) for b in batch),
                    "prompt_sha256": digest(batch_prompt), "error": error[:300]})

    def commit(batch, result):
        if cancel.is_set():
            raise engines.Cancelled()
        expected = {b["id"]: b["source_hash"] for b in batch}
        def save(current):
            for b in current["blocks"]:
                if b["id"] in result:
                    if b["source_hash"] != expected[b["id"]] or digest(b["en"]) != b["source_hash"]:
                        raise ValueError("翻译期间原文发生变化，停止保存")
                    if b.get("zh"):
                        raise ValueError("翻译期间该段已有译文，停止覆盖")
                    b["zh"] = result[b["id"]]
            current["translation"]["done_blocks"] = [b["id"] for b in current["blocks"] if b.get("zh")]
        ws.update("paper", save)
        _journal(ws, f"已保存 {batch[0]['id']} 起的 {len(result)} 段中文；原文保留")

    def run_batch(batch, can_split=True, hint=""):
        if cancel.is_set():
            raise engines.Cancelled()
        if quota.is_set():
            return {b["id"]: quota_errors[0] for b in batch}, False
        temporary = False
        try:
            for attempt in range(2):
                try:
                    if cancel.is_set():
                        raise engines.Cancelled()
                    if quota.is_set():
                        raise engines.EngineError(quota_errors[0])
                    text = request(batch, hint)
                    break
                except engines.EngineError as e:
                    if quota_error.search(str(e)) or not temporary_error.search(str(e)):
                        raise
                    temporary = True
                    if attempt or cancel.wait(float(cfg.get("html_retry_delay", 2))):
                        if cancel.is_set():
                            raise engines.Cancelled()
                        raise
            try:
                result = validate(engines.parse_json(text), batch)
            except TranslationQualityError as e:
                if e.valid:
                    commit(batch, e.valid)
                if hint:
                    return {bid: str(e) for bid in e.invalid}, temporary
                bad = [b for b in batch if b["id"] in e.invalid]
                errors, temp = run_batch(bad, False, str(e))
                return errors, temporary or temp
            except engines.EngineError:
                if can_split and len(batch) > 1:
                    middle = len(batch) // 2
                    left, left_temp = run_batch(batch[:middle], False)
                    right, right_temp = run_batch(batch[middle:], False)
                    return dict(left, **right), temporary or left_temp or right_temp
                raise
            commit(batch, result)
            return {}, temporary
        except engines.EngineError as e:
            _journal(ws, f"{batch[0]['id']} 起的 {len(batch)} 段失败：{e}")
            # 配额耗尽时不再对剩余段落发请求。
            if quota_error.search(str(e)):
                quota_errors.append(str(e))
                quota.set()
            return {b["id"]: str(e) for b in batch}, temporary

    def completed(batch, errors, allowed):
        nonlocal done
        failed.update(errors)
        done += len(batch)
        report(done, len(blocks), f"已处理 {done}/{len(blocks)} 段（{allowed} 路并行，上限 {workers}）")

    try:
        translation_scheduler.run(batches, run_batch, cfg, cancel, completed)
    finally:
        metrics["seconds"] = round(time.monotonic() - started, 3)
        metrics["failed_blocks"] = len(failed)
        metrics["cancelled"] = cancel.is_set()
        write_json_atomic(ws.root / "translation-metrics.json", metrics)
    _journal(ws, f"网页翻译结束：{len(failed)} 段失败")
    return failed


def export(ws) -> str:
    paper = verify(ws)
    soup = BeautifulSoup((ws.root / "article.html").read_text(encoding="utf-8"), "html.parser")
    for b in paper["blocks"]:
        node = soup.find(attrs={"data-easyread-id": b["id"]})
        if node and b.get("zh"):
            zh = soup.new_tag("div", attrs={"class": "easyread-zh", "lang": "zh-CN"})
            zh.string = b["zh"]
            node.insert_after(zh)
    style = soup.new_tag("style")
    style.string = ".easyread-zh{margin:.6em 0 1.5em;font:1em/1.85 system-ui;white-space:pre-line;color:#285968}"
    soup.head.append(style)
    return str(soup)
