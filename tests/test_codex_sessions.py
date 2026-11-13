"""持久会话协议、缓存累计差值与 HTTP 回答落盘；不调用真实模型或浏览器。"""
import io
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread import chat, chat_store, codex_chat, engines, server
from easyread.store import Workspace, write_json_atomic

FAKE = '''
import json,sys,uuid,time
from pathlib import Path
root=Path(sys.argv[1]); tid=None; n=0
def send(x): print(json.dumps(x,ensure_ascii=False),flush=True)
for line in sys.stdin:
 q=json.loads(line); rid=q.get("id"); method=q["method"]; p=q["params"]
 with (root/"requests.jsonl").open("a") as f:f.write(json.dumps(q)+"\\n")
 if method=="initialize": send({"id":rid,"result":{}})
 elif method in ("thread/start","thread/resume"):
  assert p["approvalPolicy"]=="never" and p["sandbox"]=="read-only"
  if method=="thread/start":
   assert p["ephemeral"] is False
   tid=str(uuid.uuid4()); n=0
  else:
   tid=p["threadId"]; n=json.loads((root/(tid+".json")).read_text())
  (root/(tid+".json")).write_text(json.dumps(n))
  send({"id":rid,"result":{"thread":{"id":tid},
       "model":"different-model" if (root/"wrong-model").exists() else p["model"],
       "reasoningEffort":"medium" if (root/"wrong-effort").exists() else "high"}})
 elif method=="turn/start":
  assert p["effort"]=="high"
  n+=1; turn="turn-"+str(n); (root/(tid+".json")).write_text(json.dumps(n))
  send({"id":rid,"result":{"turn":{"id":turn}}})
  text=p["input"][0]["text"]
  def event(method,**kw):send({"method":method,"params":{"threadId":tid,"turnId":turn,**kw}})
  if text=="FAIL" or text.endswith("读者现在问：FAIL"):
   event("turn/completed",turn={"id":turn,"status":"failed","error":{"message":"model failed"}});continue
  event("item/started",item={"type":"agentMessage","id":"a","phase":"final_answer"})
  event("item/agentMessage/delta",itemId="a",delta="回答 "+str(n))
  if text=="GATE":
   while not (root/"release").exists():time.sleep(.01)
  event("item/completed",item={"type":"agentMessage","id":"a","phase":"final_answer","text":"回答 "+str(n)})
  counts={"inputTokens":100,"cachedInputTokens":80 if n>1 else 0,"outputTokens":20,
          "reasoningOutputTokens":10,"totalTokens":120,"cacheWriteInputTokens":0}
  total={k:v*n for k,v in counts.items()}
  total["cachedInputTokens"]=80*(n-1)
  event("thread/tokenUsage/updated",tokenUsage={"total":total,"last":counts})
  event("turn/completed",turn={"id":turn,"status":"completed"})
'''


class PersistentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.script = self.root / "cli.py"
        self.script.write_text(FAKE)
        self.cfg = {"command": sys.executable, "model": "gpt-6.1-sol",
                    "extra_args": ["-c", 'model_reasoning_effort="high"'], "timeout": 3}
        self.ecfg = {"engine": "codex", "codex": self.cfg}
        self.cancel, self.procs = threading.Event(), []
        def popen(args, cwd):
            self.assertEqual(args[1:], ["app-server", "-c", 'model_reasoning_effort="high"'])
            proc = subprocess.Popen([sys.executable, str(self.script), str(self.root)], cwd=cwd,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, encoding="utf-8")
            self.procs.append(proc)
            return proc
        self.mock = patch("easyread.engines._popen", popen)
        self.mock.start()

    def tearDown(self):
        codex_chat.close_all()
        self.mock.stop()
        for proc in self.procs:
            self.assertIsNotNone(proc.poll())
        self.temp.cleanup()

    def ask(self, text, conversation="local-t", callback=None, cwd=None):
        return "".join(chat.stream(self.ecfg, text, cwd or self.root, self.cancel,
                                   conversation=conversation,
                                   input_factory=lambda state: (text, {"reading": "unchanged"}),
                                   on_usage=callback))

    def requests(self):
        return [json.loads(x) for x in (self.root / "requests.jsonl").read_text().splitlines()]

    def test_same_connection_same_thread_and_per_turn_cache_delta(self):
        metrics = []
        self.assertEqual(self.ask("首问", callback=metrics.append), "回答 1")
        self.assertEqual(self.ask("追问", callback=metrics.append), "回答 2")
        self.assertEqual(len(self.procs), 1)
        self.assertEqual(metrics[0]["thread_id"], metrics[1]["thread_id"])
        self.assertFalse(metrics[0]["session_reused"])
        self.assertTrue(metrics[1]["session_reused"])
        self.assertEqual(metrics[0]["usage"]["cached_input_tokens"], 0)
        self.assertEqual(metrics[1]["usage"]["cached_input_tokens"], 80)
        self.assertEqual(metrics[1]["usage"]["input_tokens"], 100)
        self.assertEqual(metrics[1]["usage"]["cache_hit_ratio"], .8)
        self.assertEqual(metrics[1]["usage"]["basis"], "turn_total_delta")
        reqs = self.requests()
        self.assertEqual(sum(x["method"] == "thread/start" for x in reqs), 1)
        self.assertEqual([x["params"]["input"][0]["text"] for x in reqs if x["method"] == "turn/start"], ["首问", "追问"])

    def test_reconnect_resumes_saved_identity_and_counters(self):
        metrics = []
        self.ask("首问", callback=metrics.append)
        codex_chat.close_all()
        self.ask("服务重启后的追问", callback=metrics.append)
        self.assertEqual(len(self.procs), 2)
        self.assertEqual(metrics[0]["thread_id"], metrics[1]["thread_id"])
        self.assertEqual(metrics[1]["reasoning_effort"], "high")
        self.assertEqual(metrics[1]["usage"]["input_tokens"], 100)
        methods = [q["method"] for q in self.requests()]
        self.assertEqual(methods.count("thread/start"), 1)
        self.assertEqual(methods.count("thread/resume"), 1)

    def test_image_attaches_to_existing_conversation_only_on_requested_turn(self):
        self.ask('首问')
        image = self.root / 'image.png'
        image.write_bytes(b'fixture')
        metrics = []
        result = ''.join(chat.stream(self.ecfg, '看图追问', self.root, self.cancel,
                                    conversation='local-t', input_factory=lambda state: ('看图追问', state),
                                    on_usage=metrics.append, images=[image]))
        self.assertEqual(result, '回答 2')
        turns = [q['params'] for q in self.requests() if q['method'] == 'turn/start']
        self.assertEqual(len(turns[0]['input']), 1)
        self.assertEqual(turns[1]['input'][1], {'type': 'localImage', 'path': str(image)})
        self.assertEqual(turns[0]['threadId'], turns[1]['threadId'])
        self.assertTrue(metrics[0]['session_reused'])
        self.assertEqual(metrics[0]['reasoning_effort'], 'high')

    def test_different_dialogs_and_papers_have_separate_threads(self):
        metrics = []
        other = self.root / "other-paper"
        other.mkdir()
        self.ask("甲", callback=metrics.append)
        self.ask("乙", conversation="other", callback=metrics.append)
        self.ask("丙", callback=metrics.append, cwd=other)
        self.assertEqual(len({m["thread_id"] for m in metrics}), 3)
        self.assertEqual(len(self.procs), 3)

    def test_failure_does_not_replay_or_replace_thread(self):
        self.ask("首问")
        saved = (self.root / ".codex-chat.json").read_text()
        with self.assertRaisesRegex(engines.EngineError, "model failed"), patch("easyread.engines.run") as fallback:
            self.ask("FAIL")
            fallback.assert_not_called()
        after = json.loads((self.root / ".codex-chat.json").read_text())["sessions"]
        prior = json.loads(saved)["sessions"]
        self.assertEqual(next(iter(after.values()))["thread_id"], next(iter(prior.values()))["thread_id"])
        self.assertEqual(next(iter(after.values()))["status"], "interrupted")
        self.ask("新的追问")
        methods = [q["method"] for q in self.requests()]
        self.assertEqual(methods.count("thread/start"), 1)
        self.assertEqual(methods.count("thread/resume"), 1)
        self.assertEqual(sum(q["method"] == "turn/start" and q["params"]["input"][0]["text"] == "FAIL" for q in self.requests()), 1)

    def test_invalid_saved_session_is_not_replaced(self):
        self.ask("首问")
        codex_chat.close_all()
        for path in self.root.glob("*.json"):
            if path.name not in (".codex-chat.json",):
                path.unlink()
        with self.assertRaises(engines.EngineError):
            self.ask("恢复失败")
        self.assertEqual(sum(q["method"] == "thread/start" for q in self.requests()), 1)
        self.assertEqual(sum(q["method"] == "turn/start" for q in self.requests()), 1)

    def test_cancel_preserves_identity_and_rejects_concurrent_same_dialog(self):
        gen = chat.stream(self.ecfg, "GATE", self.root, self.cancel, conversation="local-t",
                          input_factory=lambda state: ("GATE", {"reading": "same"}))
        self.assertEqual(next(gen), "回答 1")
        with self.assertRaisesRegex(engines.EngineError, "正在回答"):
            self.ask("不能同时问")
        gen.close()
        saved = next(iter(json.loads((self.root / ".codex-chat.json").read_text())["sessions"].values()))
        self.assertEqual(saved["status"], "interrupted")
        metrics = []
        self.ask("取消后的新问题", callback=metrics.append)
        self.assertEqual(metrics[0]["thread_id"], saved["thread_id"])
        self.assertEqual(metrics[0]["usage"]["basis"], "last_model_call")
        self.assertEqual(sum(q["method"] == "turn/start" for q in self.requests()), 2)

    def test_model_or_effort_mismatch_stops_before_model_request(self):
        for marker in ("wrong-model", "wrong-effort"):
            (self.root / marker).touch()
            with self.assertRaisesRegex(engines.EngineError, "未提交问题"):
                self.ask("问题")
            (self.root / marker).unlink()
        self.assertFalse(any(q["method"] == "turn/start" for q in self.requests()))

    def test_changed_context_keeps_original_and_translation_bytes(self):
        blocks = [{"id": f"web-{i}", "source_text": f"Original {i} $x_i$", "zh": f"译文 {i} $x_i$"} for i in range(10)]
        write_json_atomic(self.root / "paper.json", {"meta": {"source_kind": "arxiv_html"}, "blocks": blocks})
        ws = Workspace(self.root)
        old = (self.root / "paper.json").read_bytes()
        messages = [{"role": "user", "content": "第一问"}]
        first, state = chat.codex_turn(ws, messages, "web-1", "", [], None)
        self.assertEqual(first, chat.prompt(ws, messages, "web-1", "", "codex", []))
        messages += [{"role": "assistant", "content": "之前的回答"}, {"role": "user", "content": "第二问"}]
        follow, _ = chat.codex_turn(ws, messages, "web-1", "", [], state)
        self.assertEqual(follow, "读者现在问：第二问")
        changed, _ = chat.codex_turn(ws, messages, "web-8", "Original 8", [], state)
        self.assertIn(blocks[8]["source_text"], changed)
        self.assertIn(blocks[8]["zh"], changed)
        self.assertNotIn("之前的回答", changed)
        cleared, _ = chat.codex_turn(ws, messages, None, "", [], state)
        self.assertIn("本次没有指定相关内容", cleared)
        self.assertEqual((self.root / "paper.json").read_bytes(), old)

    def test_first_question_failure_keeps_local_dialog_identity_for_resume(self):
        write_json_atomic(self.root / "paper.json", {"blocks": []})
        ws = Workspace(self.root)
        handler = object.__new__(server.Handler)
        handler.wfile = io.BytesIO()
        handler.send_response = lambda *args: None
        handler.send_header = lambda *args: None
        handler.end_headers = lambda: None
        cfg = {"chat": {"default": "gpt", "models": [{"id": "gpt", "name": "GPT · high", "engine": "codex", "model": "gpt-6.1-sol"}]},
               "codex": self.cfg}
        with patch("easyread.server.config.load", return_value=cfg), patch("easyread.server.log.exception"):
            server.Handler._chat_impl(handler, ws, {"text": "FAIL"})
            tid = chat_store.threads(ws)[0]["id"]
            binding = next(iter(json.loads((self.root / ".codex-chat.json").read_text())["sessions"].values()))
            self.assertEqual(chat_store.get(ws, tid)["messages"], [])
            server.Handler._chat_impl(handler, ws, {"text": "新的问题", "thread": tid})
        self.assertEqual(len(chat_store.threads(ws)), 1)
        assistant = chat_store.get(ws, tid)["messages"][-1]
        self.assertEqual(assistant["timing"]["codex"]["thread_id"], binding["thread_id"])
        self.assertEqual(sum(q["method"] == "thread/start" for q in self.requests()), 1)

    def test_http_handler_persists_telemetry_and_preserves_old_content(self):
        blocks = [{"id": "web-1", "source_text": "Frozen original $x$", "zh": "固定译文 $x$"}]
        write_json_atomic(self.root / "paper.json", {"meta": {"source_kind": "arxiv_html"}, "blocks": blocks})
        write_json_atomic(self.root / "reader.json", {"notes": {}})
        old = [{"role": "user", "content": "旧问题"}, {"role": "assistant", "content": "旧回答"}]
        write_json_atomic(self.root / "chat.json", {"threads": [{"id": "local-t", "messages": old}]})
        frozen = {p: p.read_bytes() for p in [self.root / "paper.json", self.root / "reader.json"]}
        ws = Workspace(self.root)
        handler = object.__new__(server.Handler)
        handler.wfile = io.BytesIO()
        handler.send_response = lambda *args: None
        handler.send_header = lambda *args: None
        handler.end_headers = lambda: None
        cfg = {"chat": {"default": "gpt", "models": [{"id": "gpt", "name": "GPT · high", "engine": "codex", "model": "gpt-6.1-sol"}]},
               "codex": self.cfg}
        with patch("easyread.server.config.load", return_value=cfg):
            server.Handler._chat_impl(handler, ws, {"text": "首问", "thread": "local-t", "anchor": "web-1"})
            server.Handler._chat_impl(handler, ws, {"text": "追问", "thread": "local-t", "anchor": "web-1"})
        done = [json.loads(s) for s in handler.wfile.getvalue().splitlines() if json.loads(s).get("done")]
        self.assertEqual(len(done), 2)
        self.assertEqual(done[1]["timing"]["usage"]["cached_input_tokens"], 80)
        self.assertEqual(done[0]["timing"]["codex"]["thread_id"], done[1]["timing"]["codex"]["thread_id"])
        messages = chat_store.get(ws, "local-t")["messages"]
        self.assertEqual(messages[:2], old)
        self.assertEqual(messages[-1]["timing"], done[-1]["timing"])
        for path, content in frozen.items():
            self.assertEqual(path.read_bytes(), content)
        inputs = [q["params"]["input"][0]["text"] for q in self.requests() if q["method"] == "turn/start"]
        self.assertIn("旧回答", inputs[0])
        self.assertEqual(inputs[1], "读者现在问：追问")


class UsageTest(unittest.TestCase):
    def test_unknown_and_real_zero_are_distinct(self):
        self.assertEqual(codex_chat.usage_delta(None, {}), {"available": False})
        last = {"inputTokens": 100, "cachedInputTokens": 0}
        m = codex_chat.usage_delta({"last": last}, None)
        self.assertTrue(m["available"])
        self.assertEqual(m["cache_hit_ratio"], 0)
        self.assertEqual(m["basis"], "last_model_call")

    def test_multiple_model_calls_use_cumulative_difference_not_last(self):
        prior = dict(inputTokens=1000, cachedInputTokens=900, outputTokens=200,
                     reasoningOutputTokens=100, totalTokens=1200)
        total = dict(inputTokens=4000, cachedInputTokens=3000, outputTokens=700,
                     reasoningOutputTokens=400, totalTokens=4700)
        usage = codex_chat.usage_delta({"total": total, "last": {"inputTokens": 50, "cachedInputTokens": 0}}, prior)
        self.assertEqual((usage["input_tokens"], usage["cached_input_tokens"], usage["output_tokens"]), (3000, 2100, 500))
        self.assertEqual(usage["basis"], "turn_total_delta")


if __name__ == "__main__":
    unittest.main()
