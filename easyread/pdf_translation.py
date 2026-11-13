"""Explicit native HJFY jobs. Each supervisor survives reader/server restarts."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import urlparse

from . import config
from .store import dir_lock, now_iso, read_json, write_json_atomic

ACTIVE = {"queued", "running", "cancelling"}
RUNTIME = Path("/Applications/HJFY.app/Contents/Resources/PDFRuntime")


def choices(service):
    records = read_json(getattr(service,'hjfy_models',service.hjfy) / "models.json", []) or []
    return [{"id": r["id"], "model": r["connection"].get("model", ""),
             "base_url": r["connection"].get("baseURL", ""),
             "provider": r["connection"].get("provider", "chat-completions")}
            for r in records if r.get("enabled") and r.get("connection", {}).get("model")]


def state(ws):
    current = read_json(ws.root / "translation-task.json", {}) or {}
    if not current.get("id"):
        return {"state": "idle"}
    path = ws.root / "runs" / current["id"] / "task.json"
    task = read_json(path, {}) or {}
    if task.get('state') in ACTIVE:
        events_path = path.parent / 'events.jsonl'
        if events_path.exists():
            with events_path.open('rb') as stream:
                stream.seek(max(0, events_path.stat().st_size - 64000))
                for line in reversed(stream.read().splitlines()):
                    try: event = json.loads(line)
                    except ValueError: continue
                    if event.get('type') == 'progress' and event.get('protocol_version') == 4:
                        task['message'] = event.get('message', {}).get('text') or task['message']
                        break
    if task.get("state") in ACTIVE and task.get("supervisor_pid"):
        try:
            os.kill(task["supervisor_pid"], 0)
            command = subprocess.run(['ps', '-p', str(task['supervisor_pid']), '-o', 'command='], capture_output=True, text=True, check=False).stdout
            if str(path.parent / 'input.json') not in command:
                raise ProcessLookupError()
        except ProcessLookupError:
            latest = read_json(path, {}) or {}
            if latest.get('state') not in ACTIVE:
                return latest
            task.update(state="failed", message="翻译进程已结束但没有完成记录，请重新启动", updated=now_iso())
            write_json_atomic(path, task)
    return task


def start(service, ws, body):
    model = next((m for m in choices(service) if m["id"] == body.get("model_id")), None)
    if not model:
        raise ValueError("请选择已启用的幻觉翻译模型连接")
    if model["provider"] not in ("chat-completions", "responses", "qwen-mt"):
        raise ValueError("该模型协议不受原生引擎支持")
    runtime = Path(os.environ.get("EASYREAD_HJFY_RUNTIME") or RUNTIME)
    if not (runtime / "bin/hjfy-pdf").is_file():
        raise ValueError("找不到幻觉翻译 PDF 引擎，请安装 HJFY")
    o = config.load().get("openai", {})
    local = urlparse(model["base_url"]).hostname in ("localhost", "127.0.0.1", "::1")
    key = o.get("api_key", "") if o.get("base_url", "").rstrip("/") == model["base_url"].rstrip("/") else ""
    if not local and not key:
        raise ValueError("该连接的凭据未在 EasyRead 配置，请先配置 API 或使用已有本地 Codex 连接")
    with dir_lock(ws.root):
        current = state(ws)
        if current.get("state") in ACTIVE:
            return current
        run_id = uuid.uuid4().hex
        folder = ws.root / "runs" / run_id; folder.mkdir(parents=True)
        task = {"id": run_id, "state": "queued", "message": "准备翻译", "created": now_iso(),
                "updated": now_iso(), "source_sha256": ws.id, "model": model["model"],
                "target_language": "zh-Hans", "pdf_mode": "preserve"}
        write_json_atomic(folder / "task.json", task)
        manifest = service.manifest(ws)
        source = service.asset_file(ws, manifest["assets"]["source"])
        options = read_json(service.root / "hjfy.json", {}) or {}
        spec = {"task": str(folder / "task.json"), "source": str(source),
                "runtime": str(runtime), "connection": model, "bridge_start": options.get("bridge_start"),
                "bridge_base_url": options.get("bridge_base_url"), "source_sha256": ws.id}
        # Credentials stay in the worker environment, never task/spec/log files.
        write_json_atomic(folder / "input.json", spec)
        env = os.environ.copy(); env["EASYREAD_NATIVE_API_KEY"] = key or "local-placeholder"
        from .access import current_runtime,current_authority,current_paper
        authority=current_runtime()
        owned=access_task=None
        if authority:
            import secrets
            session,gate=current_authority();gate()
            owned=authority.db.workspace(session['user_id'],current_paper())
            access_task=owned.start(session,'native')
            owned.task_state(access_task,'running','translate')
            capability=secrets.token_hex(32)
            authority.native_proxies[capability]={'session':session,'gate':gate,'key':key or 'local-placeholder',
                'base_url':model['base_url'],'cancel':folder/'cancel'}
            # The worker must send all requests through the session gate. No
            # provider credential or capability is written into input/task files.
            spec['connection']={**model,'base_url':f'http://127.0.0.1:{authority.httpd.server_port}/native-proxy'}
            spec['upstream_connection']=model
            spec['bridge_lock_root']=str(authority.db.root)
            spec['account_root']=str(authority.db.root)
            spec['account_home']=str(authority.home)
            write_json_atomic(folder/'input.json',spec)
            env['EASYREAD_NATIVE_API_KEY']=capability
        env["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent)
        with (folder / "supervisor.log").open("wb") as log:
            proc = subprocess.Popen([sys.executable, "-B", "-m", "easyread.pdf_translation", str(folder / "input.json")],
                                    stdout=log, stderr=log, env=env, start_new_session=True)
        # Worker waits until the pointer is committed before updating task.json.
        task["supervisor_pid"] = proc.pid; write_json_atomic(folder / "task.json", task)
        write_json_atomic(ws.root / "translation-task.json", {"id": run_id})
        (folder / "ready").touch()
        def finished():
            proc.wait()
            if owned:
                result=state(ws)
                owned.task_state(access_task,'completed' if result.get('state')=='completed' else 'interrupted' if result.get('state')=='cancelled' else 'failed','translate',result.get('message',''))
                authority.native_proxies.pop(capability,None)
        threading.Thread(target=finished, daemon=True).start()
        return task


def cancel(ws):
    task = state(ws)
    if task.get("state") in ACTIVE:
        (ws.root / "runs" / task["id"] / "cancel").touch()
    return task


def completed(ws):
    result = []
    for path in (ws.root / "runs").glob("*/task.json"):
        task = read_json(path, {}) or {}
        output = path.parent / "translated.pdf"
        if task.get("state") == "completed" and task.get("source_sha256") == ws.id and output.is_file():
            result.append({"id": "easyread-" + task["id"], "path": output, "source_sha256": ws.id,
                           "finished": task.get("finished_epoch", output.stat().st_mtime),
                           "document": ws.id, "kind": "easyread-hjfy", "sha256": task["output_sha256"]})
    return result


def stop_group(proc):
    if proc and proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL); proc.wait(timeout=5)
        except ProcessLookupError:
            pass


def run(spec_path):
    import hashlib
    from pypdf import PdfReader
    spec = read_json(Path(spec_path), {})
    if spec.get('account_root'):
        from .database import Database
        database=Database(spec['account_root'],spec['account_home'])
    path = Path(spec["task"]); folder = path.parent
    for _ in range(100):
        if (folder / "ready").exists(): break
        time.sleep(.05)
    task = read_json(path, {})
    native = bridge = None
    connection_lock = None
    bridge_log = None
    def save(**values):
        task.update(values, updated=now_iso()); write_json_atomic(path, task)
    def terminate(*_): (folder / "cancel").touch()
    signal.signal(signal.SIGTERM, terminate); signal.signal(signal.SIGINT, terminate)
    try:
        source = Path(spec["source"])
        if hashlib.sha256(source.read_bytes()).hexdigest() != spec["source_sha256"]:
            raise ValueError("原文身份发生变化")
        connection = spec["connection"]
        bridge_connection=spec.get('upstream_connection',connection)
        # Serialize users of one local bridge so one job cannot stop a bridge
        # still borrowed by another PDF supervisor. The lock survives restarts.
        if spec.get('bridge_start'):
            import fcntl
            name = hashlib.sha256(bridge_connection['base_url'].encode()).hexdigest()[:16]
            lock_root=Path(spec.get('bridge_lock_root') or folder.parent.parent.parent)
            connection_lock = (lock_root / ('bridge-' + name + '.lock')).open('a')
            while True:
                try:
                    fcntl.flock(connection_lock, fcntl.LOCK_EX | fcntl.LOCK_NB); break
                except BlockingIOError:
                    save(state='queued', message='等待本地翻译连接')
                    if (folder / 'cancel').exists(): raise InterruptedError()
                    time.sleep(.2)
        if spec.get("bridge_start") and bridge_connection["base_url"].rstrip("/") == str(spec.get("bridge_base_url", "")).rstrip("/"):
            def alive():
                try:
                    with urllib.request.urlopen(bridge_connection["base_url"].removesuffix('/v1') + '/health', timeout=2) as r:
                        return r.status == 200
                except Exception: return False
            if not alive():
                bridge_log = (folder / "bridge.log").open('wb')
                bridge = subprocess.Popen([sys.executable, "-B", spec["bridge_start"]], stdout=bridge_log, stderr=bridge_log,
                                          start_new_session=True)
                for _ in range(100):
                    if alive(): break
                    if bridge.poll() is not None: raise ValueError("本地 Codex 桥接启动失败")
                    if (folder / "cancel").exists(): raise InterruptedError()
                    time.sleep(.2)
                else: raise ValueError("本地 Codex 桥接没有就绪")
        if (folder / "cancel").exists(): raise InterruptedError()
        args = [str(Path(spec["runtime"]) / "bin/hjfy-pdf"), str(source),
                "--resource-root", spec["runtime"], "--provider", connection["provider"],
                "--base-url", connection["base_url"], "--model", connection["model"],
                "--api-key-env", "EASYREAD_NATIVE_API_KEY", "--target-language", "zh-Hans",
                "--pdf-mode", "preserve", "--events", "jsonl", "--ui-language", "zh-Hans",
                "--work-dir", str(folder / "work"), "--analysis-cache-dir", str(folder / "analysis"),
                "--translation-cache", str(folder / "translations.csv"), "--translation-cache-db", str(folder / "translations.sqlite3"),
                "--report", str(folder / "report.md"), "--cleanup-intermediate=false", "-o", str(folder / "translated.pdf")]
        write_json_atomic(folder / "command.json", args)
        save(state="running", message="幻觉翻译处理中")
        with (folder / "stderr.log").open('wb') as err:
            native = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, text=True, start_new_session=True)
            events = []
            def consume():
                with (folder / "events.jsonl").open('w') as stream:
                    for line in native.stdout:
                        stream.write(line); stream.flush()
                        try:
                            event = json.loads(line)
                            if event.get('type') in ('output_published', 'document_finished', 'run_finished'):
                                events.append(event)
                        except ValueError: pass
            reader = threading.Thread(target=consume, daemon=True); reader.start()
            while native.poll() is None:
                if (folder / "cancel").exists():
                    save(state="cancelling", message="正在取消"); stop_group(native); raise InterruptedError()
                time.sleep(.2)
            reader.join(timeout=5)
            native.stdout.close()
        task["exit_code"] = native.returncode
        if (folder / "cancel").exists(): raise InterruptedError()
        if native.returncode != 0:
            raise ValueError("幻觉翻译未完成，原生引擎退出码 " + str(native.returncode))
        output = folder / "translated.pdf"
        if not output.is_file() or not len(PdfReader(output).pages):
            raise ValueError("原生引擎没有发布可读取的最终 PDF")
        # Require an explicit native publication signal in the recorded protocol.
        published = [e for e in events if e.get('protocol_version') == 4 and e.get('type') == 'output_published'
                     and e.get('output') == str(output)]
        document_done = [e for e in events if e.get('protocol_version') == 4 and e.get('type') == 'document_finished'
                         and e.get('output') == str(output) and e.get('content', {}).get('published') is True
                         and e.get('outcome') not in ('failed', 'cancelled')]
        run_done = [e for e in events if e.get('protocol_version') == 4 and e.get('type') == 'run_finished'
                    and e.get('outcome') not in ('failed', 'cancelled') and not e.get('error')]
        if not published or not document_done or not run_done:
            raise ValueError("缺少原生完成或发布记录，产物保留以供核对")
        save(state="completed", message="译文已完成", output_sha256=hashlib.sha256(output.read_bytes()).hexdigest(),
             finished_epoch=time.time(), publication=published[-1], completion=run_done[-1])
    except InterruptedError:
        save(state="cancelled", message="已取消，可以重新翻译")
    except Exception as error:
        save(state="failed", message=str(error)[:300])
    finally:
        stop_group(native)
        if native and native.stdin: native.stdin.close()
        if native and native.stdout and not native.stdout.closed: native.stdout.close()
        # Only stop the bridge process created by this task; existing services are untouched.
        stop_group(bridge)
        if bridge_log: bridge_log.close()
        if connection_lock: connection_lock.close()


if __name__ == "__main__":
    run(sys.argv[1])
