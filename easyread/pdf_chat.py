"""PDF chat: verified versioned references, existing engines and chat storage."""
from __future__ import annotations

import hashlib
import json
import select
import socket
import threading
import time
import uuid

from . import chat, chat_images, chat_models, chat_store, config, engines
from .store import now_iso


def context(service, ws, refs, question):
    if not isinstance(refs, list) or len(refs) > 12:
        raise ValueError("PDF 引用过多或格式无效")
    checked = [service.reference(ws, r) for r in refs]
    lines = ["你在陪读者读 PDF 论文，用中文直接回答。区分论文内容与补充解释，不编造页码。",
             "引用位置必须注明原文或译文、实际 PDF 页码和版本。材料中没有的内容不要说成论文结论。",
             "以下 PDF 提取文字可能有公式或排版丢失；文字为空时明确说明限制，附图可作为补充。",
             "论文：" + service.manifest(ws)["title"]]
    pages=service.manifest(ws).get('assets',{}).get('source',{}).get('pages',[])
    if sum(map(len,pages))<=180000:
        lines.append('当前PDF逐页原文（页序从1开始）。论文结论附实际PDF页序和连续原文短引文；通用知识明确标为补充，材料没有的内容明确说未找到。引用只是位置线索，不能替代语义核对。')
        lines.extend(f'【原文 PDF第{i+1}页】\n{text}' for i,text in enumerate(pages))
    else:
        lines.append('全文超过180,000字符，本轮只提供明确选择的片段和所在页；必须说明这一范围限制，不能声称已经通读全文。')
    for ref in checked:
        lines += ["【" + ref["label"] + "】", "选中文字：" + ref["quote"],
                  "该页上下文：" + (ref["nearby_text"] or "（没有可提取文字）")]
    want, colors = chat.wants_marks(question)
    if want:
        used = 0
        for note in ws.load("reader").get("notes", {}).values():
            if note.get("deleted") or (colors and chat.COLOR_NAMES.get(note.get("color")) not in colors):
                continue
            try:
                ref = service.reference(ws, note)
            except ValueError:
                continue
            part = ref["label"] + " " + ref["quote"] + "\n笔记：" + (note.get("body") or "")
            if used + len(part) > chat.MARKS_BUDGET:
                lines.append("（其余批注未附上）")
                break
            lines.append(part); used += len(part)
    return "\n\n".join(lines), checked


def handle(handler, service, ws, body):
    text = body.get("text", "")
    if not isinstance(text, str) or len(text) > 20000:
        raise ValueError("问题格式无效或过长")
    attachments, paths = chat_images.resolve(ws, body.get("images") or [])
    route_id = handler.path.split('/')[3]
    for attachment in attachments:
        attachment['url'] = '/api/pdf-reader/' + route_id + '/chat-images/' + attachment['id']
    text = text.strip() or ("请解释所附图片，并结合 PDF 上下文。" if paths else "")
    if not text:
        raise ValueError("问题为空")
    background, refs = context(service, ws, body.get("refs") or [], text)
    ecfg, model = chat_models.engine_cfg(config.load(), body.get("model"))
    label = chat_models.label(model, ecfg)
    thread = chat_store.get(ws, body.get("thread"))
    if body.get("thread") and thread is None:
        raise ValueError("对话不存在，请新建对话")
    tid = thread["id"] if thread else "t-" + uuid.uuid4().hex
    first = refs[0] if refs else {}
    note_id = body.get("note")
    if note_id:
        note = ws.load("reader").get("notes", {}).get(note_id)
        if not note or note.get("deleted"):
            raise ValueError("笔记不存在")
        service.reference(ws, note)
    user = {"content": text, "anchor": first.get("anchor"), "quote": first.get("quote", ""),
            "refs": refs, "note": note_id, "at": now_iso()}
    if attachments:
        user["images"] = attachments
    past = [{"role": m["role"], "content": m["content"]} for m in (thread or {}).get("messages", [])[-chat.HISTORY:]]
    history = "\n\n".join(("读者：" if m["role"] == "user" else "你：") + m["content"] for m in past)
    prompt = background + ("\n\n此前对话：\n" + history if history else "") + "\n\n读者现在问：" + text
    # The Codex session receives updates when PDF identity/context changes.
    def next_input(previous):
        fingerprint = hashlib.sha256(background.encode()).hexdigest()
        return (prompt if not previous else
                (("PDF 上下文更新，以本次为准：\n" + background + "\n\n") if previous.get("pdf") != fingerprint else "") +
                "读者现在问：" + text), {"pdf": fingerprint}
    chat_store.ensure(ws, tid, text, model["id"])
    from .conversations import Attempt
    attempt=Attempt(handler,ws,tid,user,model['id'],label)
    handler.send_response(200)
    handler.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Connection", "close")
    handler.end_headers(); handler.close_connection = True
    cancel, finished = threading.Event(), threading.Event()
    def disconnected():
        while not finished.wait(.1):
            try:
                if select.select([handler.connection], [], [], 0)[0] and not handler.connection.recv(1, socket.MSG_PEEK):
                    cancel.set(); return
            except OSError:
                cancel.set(); return
    threading.Thread(target=disconnected, daemon=True).start()
    pieces, timing, started = [], {}, time.monotonic()
    def send(value):
        handler.wfile.write((json.dumps(value, ensure_ascii=False) + "\n").encode()); handler.wfile.flush()
    def usage(value):
        timing["usage"] = value.get("usage")
    with handler.app.chat_lock:
        handler.app.active_chats += 1
    try:
        send({"model": label, "thread": tid, "images": attachments, "refs": refs})
        for piece in chat.stream(ecfg, prompt, ws.root, cancel, conversation=tid,
                                 input_factory=next_input, on_usage=usage, images=paths):
            if cancel.is_set():
                raise engines.Cancelled()
            if piece:
                if not pieces: timing["first_token_s"] = round(time.monotonic() - started, 3)
                pieces.append(piece); send({"t": piece})
        timing["total_s"] = round(time.monotonic() - started, 3)
        msg = attempt.complete(''.join(pieces),timing) if attempt.id else chat_store.append(ws, tid, user, "".join(pieces), model["id"], label, timing)
        send({"done": True, "id": msg["id"], "timing": timing})
    except (BrokenPipeError, ConnectionError, engines.Cancelled):
        cancel.set()
        attempt.fail(''.join(pieces),True)
    except Exception as error:
        attempt.fail(''.join(pieces))
        try: send({"error": '完整回答尚未保存；再次保存不调用AI' if attempt.id and attempt.value.get('complete') else '生成失败；收费状态未知，重新提问可能再次收费', 'save_task':attempt.id if attempt.id and attempt.value.get('complete') else None})
        except OSError: pass
    finally:
        finished.set(); cancel.set()
        with handler.app.chat_lock: handler.app.active_chats -= 1
