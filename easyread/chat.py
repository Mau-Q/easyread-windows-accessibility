"""阅读页右侧的“问 AI”：提示词和流式输出（回答一个字一个字流出来）。

- 用哪个模型：chat_models.py（设置里的一张短名单）。
- 对话记录：chat_store.py（每篇论文可以有多个对话）。
- 上下文：论文标题、摘要、读者指着的段落和前后几段、读者引用的几处原文、术语表。
  读者的标记（按颜色分好的划线、笔记、问题）只在问题提到“标红的”“划线”“笔记”时才带上，
  提到具体颜色就只带那种颜色，所以可以问“我标红的那些公式之间有什么联系”。
  Claude Code 还能自己 Read paper.json、reader.json 看全文和全部标记。
"""
from __future__ import annotations

import json
import base64
import mimetypes
import hashlib
import re
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path

from . import engines
from .prompts import _block_text
from .store import Workspace

HISTORY = 12  # 带上最近几轮对话
COLOR_NAMES = {"yellow": "黄", "green": "绿", "blue": "蓝", "pink": "红"}
MARKS_BUDGET = 9000  # 标记部分最多带多少字


# ---------- 提示词 ----------
def _reading_text(b: dict, web: bool = False) -> str:
    if not web:
        return _block_text(b)
    zh = b.get("zh") or ""
    en = b.get("source_text") or b.get("en") or ""
    return ("译文：" + zh + "\n" if zh else "") + "原文：" + en


def _context(ws: Workspace, anchor: str | None, quote: str, refs: list[dict] | None = None, background: bool = True) -> str:
    paper = ws.load("paper")
    meta = paper.get("meta", {})
    blocks = paper.get("blocks", [])
    web = meta.get("source_kind") == "arxiv_html"
    lines = [f"论文：《{meta.get('title_zh') or ''}》{meta.get('title_en') or ''}，{meta.get('authors', '')[:200]}。"] if background else []
    abstract = ("\n".join(_reading_text(b, True) for b in blocks if b.get("role") == "abstract") if web
                else next((b.get("zh") for b in blocks if b.get("role") == "abstract"), ""))
    if abstract and background:
        lines.append(("摘要：" if web else "摘要（译文）：") + abstract[:1500])
    idx = next((i for i, b in enumerate(blocks) if b.get("id") == anchor), None)
    if idx is not None:
        h = next((b for b in reversed(blocks[:idx + 1]) if b.get("type") == "heading"), None)
        if h:
            lines.append(f"读者正在读的章节：{h.get('num', '')} {h.get('zh', '')}")
        near = blocks[max(0, idx - 3): idx + 3]
        lines.append(("附近的网页段落：\n" if web else "附近的译文：\n") + "\n\n".join(f"[{b['id']}] {_reading_text(b, web)}" for b in near))
        focus = blocks[idx]
        focus_text = (_reading_text(focus, True) if web else
                      f"译文：{_block_text(focus)}\n原文：{focus.get('en') or focus.get('caption_en') or focus.get('tex', '')}")
        lines.append(f"读者指着的是上面的段落 [{focus['id']}]。" if web else
                     f"读者指着的段落 [{focus['id']}]：\n{focus_text}")
        # 网页附近段落已经含完整原文和译文；摘要全在其中时只标明位置。
        abstract_ids = [b['id'] for b in blocks if b.get('role') == 'abstract']
        if background and web and abstract and abstract_ids and set(abstract_ids) <= {b['id'] for b in near}:
            lines[1] = "摘要在下面的段落：" + "、".join(f"[{bid}]" for bid in abstract_ids) + "。"
    if quote:
        lines.append(f"读者选中的原话：「{quote}」")
    extra = [r for r in (refs or []) if r.get("anchor") != anchor or (r.get("quote") or "") != quote]
    if extra:
        by_id = {b.get("id"): b for b in blocks}
        parts = []
        for r in extra[:12]:
            b = by_id.get(r.get("anchor")) or {}
            q = (r.get("quote") or "").strip()
            parts.append(f"[{r.get('anchor')}] " + (f"读者选中：「{q[:800]}」\n  所在段落：" if q else "") + _reading_text(b, web)[:1200])
        lines.append("读者引用了这几处（问题可能是在问它们之间的关系）：\n" + "\n".join(parts))
    gl = paper.get("glossary", [])
    if gl and background:
        lines.append("术语表：" + "；".join(f"{g['en']} = {g['zh']}" for g in gl[:80]))
    return "\n\n".join(lines)


def _marks(ws: Workspace, colors: set[str] | None = None) -> str:
    """读者的全部标记，按颜色分组；每处带上所在段落的译文（含 $TeX$），这样问“红色那些公式”也答得上。"""
    paper = ws.load("paper")
    web = paper.get("meta", {}).get("source_kind") == "arxiv_html"
    blocks = {b.get("id"): b for b in paper.get("blocks", [])}
    order = {b.get("id"): i for i, b in enumerate(paper.get("blocks", []))}
    notes = [n for n in (ws.load("reader").get("notes") or {}).values() if not n.get("deleted")]
    if not notes:
        return ""
    notes.sort(key=lambda n: order.get(n.get("anchor"), 1e9))
    kinds = {"highlight": "划线", "note": "笔记", "question": "问题"}
    groups: dict[str, list[str]] = {}
    shown: set[str] = set()
    for n in notes:
        color = COLOR_NAMES.get(n.get("color") or "yellow", "黄") if n.get("quote") else "无颜色"
        if colors and color not in colors:
            continue
        b = blocks.get(n.get("anchor")) or {}
        line = f"- [{n.get('anchor')}] {kinds.get(n.get('kind'), '笔记')}"
        if n.get("quote"):
            line += f"：「{n['quote']}」"
        if n.get("body"):
            line += f"；读者写道：{n['body'][:300]}"
        if b and b.get("id") not in shown:
            shown.add(b["id"])
            line += f"\n  所在段落：{_reading_text(b, web)[:1200 if web else 600]}"
        groups.setdefault(color, []).append(line)
    parts, used = [], 0
    for color in ["红", "黄", "绿", "蓝", "无颜色"]:
        for line in groups.get(color, []):
            if used > MARKS_BUDGET:
                break
            if not parts or not parts[-1].startswith(f"【{color}"):
                parts.append(f"【{color}色】" if color != "无颜色" else "【没有颜色的笔记和问题】")
            parts.append(line)
            used += len(line)
    return (("读者在网页原文或译文上做的标记（按颜色分组，每处附所在段落的原文和已有译文）：\n" if web else
             "读者在译文上做的标记（按颜色分组，读者说“红的”“黄色那些”就是指这里；每处附所在段落译文，行内公式是 $TeX$）：\n")
            + "\n".join(parts) + ("\n（标记太多，只列了一部分；Claude Code 可以 Read reader.json 看全部）" if used > MARKS_BUDGET else ""))


MARK_WORDS = re.compile(r"标[红黄绿蓝记了过的出注]|划线|划过|划的|画线|高亮|涂|颜色|[红黄绿蓝][色的]|笔记|批注|标记|我的问题|highlight", re.I)


def wants_marks(text: str) -> tuple[bool, set[str] | None]:
    """问题里提到“标红的”“划线”“我的笔记”这类词，才把读者的标记带上；提到具体颜色就只带那几种。"""
    if not MARK_WORDS.search(text or ""):
        return False, None
    colors = {c for c in "红黄绿蓝" if re.search(c + "[色的]|标" + c, text)}
    return True, (colors | {"无颜色"} if colors and re.search(r"笔记|问题|批注", text) else colors or None)


def _marks_summary(ws: Workspace) -> str:
    notes = [n for n in (ws.load("reader").get("notes") or {}).values() if not n.get("deleted")]
    if not notes:
        return ""
    counts: dict[str, int] = {}
    for n in notes:
        k = COLOR_NAMES.get(n.get("color") or "yellow", "黄") + "色" if n.get("quote") else "无颜色笔记"
        counts[k] = counts.get(k, 0) + 1
    return "读者在论文上做过 " + str(len(notes)) + " 处标记（" + "、".join(f"{k} {v}" for k, v in counts.items()) + "），这次问题没提到，就没附上。"


def prompt(ws: Workspace, messages: list[dict], anchor: str | None, quote: str, engine: str, refs: list[dict] | None = None) -> str:
    history = messages[-HISTORY:]
    convo = "\n\n".join(("读者" if m["role"] == "user" else "你") + "：" + m["content"] for m in history[:-1])
    ask = history[-1]["content"] if history else ""
    tool = ("需要看全文时，用 Read 工具读当前目录的 paper.json（blocks 里是译文和原文）；读者的全部标记在 reader.json 的 notes 里。\n"
            if engine == "claude" else "")
    want, colors = wants_marks(ask)
    marks = _marks(ws, colors) if want else _marks_summary(ws)
    position = ("这是网页双语阅读，没有 PDF 页码；引用位置用章节标题或原句，不要编造页码。" if
                ws.load("paper").get("meta", {}).get("source_kind") == "arxiv_html" else
                "提到原文位置时说“式 5”“第 4 页那段”，不要写 [p4-5] 这类内部编号。")
    return ("你在陪读者读一篇学术论文，回答他边读边冒出来的问题。用中文，直接、具体，能举例就举例；"
            "区分“论文里写了什么”和“你的补充解释”，论文里没有的内容不要说成是论文说的。"
            "行内公式写 $TeX$，行间公式写 $$TeX$$。" + position + "只输出回答本身，不要客套，不要重复问题。\n" + tool + "\n"
            + _context(ws, anchor, quote, refs)
            + ("\n\n" + marks if marks else "")
            + (f"\n\n之前的对话：\n{convo}" if convo else "")
            + f"\n\n读者现在问：{ask}")


# ---------- 流式输出 ----------
def codex_turn(ws: Workspace, messages: list[dict], anchor, quote, refs, state: dict | None):
    """首问迁入原提示词和旧对话；追问只追加问题及变化的背景、阅读位置、标记。"""
    ask = messages[-1]["content"] if messages else ""
    want, colors = wants_marks(ask)
    parts = {"background": _context(ws, None, ""),
             "reading": _context(ws, anchor, quote, refs, background=False),
             "marks": _marks(ws, colors) if want else _marks_summary(ws)}
    hashes = {k: hashlib.sha256(v.encode()).hexdigest() for k, v in parts.items()}
    if not state:
        return prompt(ws, messages, anchor, quote, "codex", refs), hashes
    updates = []
    names = {"background": "论文背景和术语更新", "reading": "这次的阅读位置和引用", "marks": "这次的标记信息"}
    for kind, content in parts.items():
        if hashes[kind] != state.get(kind):
            updates.append(names[kind] + "（以本次内容为准）：\n" + (content or "本次没有指定相关内容。"))
    return "\n\n".join(updates + ["读者现在问：" + ask]), hashes


def stream(ecfg: dict, text: str, cwd: Path, cancel: threading.Event, on_model=None,
           conversation: str | None = None, input_factory=None, on_usage=None, images=None) -> Iterator[str]:
    """on_model(实际模型名)：Claude Code 开头会报它实际用的模型。"""
    from .access import check_ai_dispatch
    check_ai_dispatch()
    from .access import current_authority,isolated_codex
    if current_authority()[0] and ecfg.get('engine')=='codex':
        ecfg={**ecfg,'codex':isolated_codex(ecfg['codex'])}
    e = ecfg.get("engine")
    images = images or []
    if e == "claude":
        if images:
            text += "\n\n读者本次附了图片，请先用 Read 工具读取以下图片，再结合提问回答：\n" + "\n".join(str(p) for p in images)
        yield from _stream_claude(ecfg["claude"], text, cwd, cancel, on_model)
    elif e == "openai":
        yield from _stream_openai(ecfg["openai"], text, cancel, images)
    elif e == "codex":
        from . import codex_chat
        if conversation:
            yield from codex_chat.conversation_stream(ecfg["codex"], cwd, cancel, conversation, input_factory, on_usage, images=images)
            return
        try:
            yield from codex_chat.stream(ecfg["codex"], text, cwd, cancel, on_usage, images=images)
        except codex_chat.StreamUnavailable:
            # 旧 CLI 仅在尚未提交模型请求时回退，避免隐形重复问答。
            yield engines.run(ecfg, text, cwd, images, cancel)
    else:
        yield engines.run(ecfg, text, cwd, None, cancel)


def _stream_claude(c: dict, text: str, cwd: Path, cancel, on_model=None) -> Iterator[str]:
    exe = engines.claude_path(c)
    if not exe:
        raise engines.EngineError("找不到 Claude Code 命令（先装好并登录 Claude Code）")
    args = [exe, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--allowedTools", "Read", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]
    if c.get("model"):
        args += ["--model", c["model"]]
    proc = engines._popen(args, cwd)
    proc.stdin.write(text)
    proc.stdin.close()
    killer = threading.Thread(target=lambda: (cancel.wait(), proc.poll() is None and proc.kill()), daemon=True)
    killer.start()
    got = False
    try:
        for line in proc.stdout:
            if cancel.is_set():
                raise engines.Cancelled()
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "system" and ev.get("subtype") == "init" and ev.get("model") and on_model:
                on_model(ev["model"])
            if ev.get("type") == "stream_event":
                d = (ev.get("event") or {}).get("delta") or {}
                if d.get("type") == "text_delta" and d.get("text"):
                    got = True
                    yield d["text"]
            elif ev.get("type") == "result":
                if ev.get("is_error"):
                    raise engines.EngineError("Claude Code 出错：" + str(ev.get("result") or ev.get("subtype")))
                if not got and ev.get("result"):
                    yield ev["result"]
                return
        err = proc.stderr.read()[-400:]
        if not got:
            raise engines.EngineError(err or "Claude Code 没有输出")
    finally:
        if proc.poll() is None:
            proc.kill()
        cancel.set()  # 让 killer 线程退出


def _stream_openai(o: dict, text: str, cancel, images=None) -> Iterator[str]:
    base = (o.get("base_url") or "").rstrip("/")
    if not base or not o.get("model"):
        raise engines.EngineError("API 没填地址或模型")
    body = {"model": o["model"], "temperature": 0.4, "stream": True, "messages": [{"role": "user", "content": text}]}
    if images:
        body["messages"][0]["content"] = [{"type": "text", "text": text}] + [
            {"type": "image_url", "image_url": {"url": "data:" + (mimetypes.guess_type(p.name)[0] or "image/png") +
             ";base64," + base64.b64encode(p.read_bytes()).decode("ascii")}} for p in images]
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if o.get("api_key"):
        headers["Authorization"] = "Bearer " + o["api_key"]
    req = urllib.request.Request(base + "/chat/completions", data=json.dumps(body).encode(), headers=headers)
    try:
        r = urllib.request.urlopen(req, timeout=int(o.get("timeout") or 600))
    except urllib.error.HTTPError as e:
        raise engines.EngineError(f"接口返回 {e.code}：{e.read()[:300].decode('utf-8', 'replace')}")
    except Exception as e:  # noqa: BLE001
        raise engines.EngineError(f"连不上接口：{e}")
    thinking = False
    with r:
        for raw in r:
            if cancel.is_set():
                raise engines.Cancelled()
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                return
            try:
                delta = (json.loads(data).get("choices") or [{}])[0].get("delta") or {}
            except json.JSONDecodeError:
                continue
            piece = delta.get("content") or ""
            # 推理模型把思考过程包在 <think> 里，读者不需要看
            if "<think>" in piece:
                thinking, piece = True, piece.split("<think>")[0]
            if thinking:
                if "</think>" not in piece:
                    continue
                thinking, piece = False, piece.split("</think>", 1)[1]
            if piece:
                yield piece
