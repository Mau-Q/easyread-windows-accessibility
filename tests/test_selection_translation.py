import copy
import hashlib
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from easyread import config, engines, selection_translation as st
from easyread.store import Workspace, write_json_atomic


class SelectionTranslationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.ws = Workspace(self.root / "library" / "paper")
        self.ws.root.mkdir(parents=True)
        self.paper = {"meta": {"title_en": "Loss modeling"}, "glossary": [{"en": "parameters", "zh": "参数"}], "blocks": [
            {"id": "a", "type": "para", "en": "Our approach defines a loss model.", "zh": "已有译文。", "source_hash": "v1"},
            {"id": "b", "type": "para", "en": "We fit these parameters and minimize the validation loss.", "zh": "我们拟合这些参数，并最小化验证损失。", "source_hash": "v1"},
            {"id": "c", "type": "para", "en": "The parameters differ across domains.", "zh": "参数随领域而异。", "source_hash": "v1"}]}
        write_json_atomic(self.ws.root / "paper.json", self.paper)
        self.original = (self.ws.root / "paper.json").read_bytes()
        self.cfg = copy.deepcopy(config.DEFAULTS)
        self.cfg["codex"]["model"] = "gpt-6.1-sol"
        self.cfg["selection_translation"]["codex"]["model"] = "gpt-6.1-sol"
        self.service = st.Service(self.root)
        self.body = {"anchor": "b", "quote": "parameters", "key": "en", "start": 13, "source_hashes": {"b": "v1"}, "force_model": True}

    def tearDown(self):
        self.service.close()
        self.assertEqual((self.ws.root / "paper.json").read_bytes(), self.original)
        self.tmp.cleanup()

    def run_stream(self, body=None):
        rid = "request-12345"
        cancel = self.service.register(rid)
        try:
            return list(self.service.stream(self.ws, body or self.body, self.cfg, rid, cancel))
        finally:
            self.service.unregister(rid)

    def test_context_and_configuration_isolation(self):
        before = copy.deepcopy(self.cfg)
        req = st.prepare(self.ws, self.body, self.cfg)
        self.assertIn("We fit these parameters", req["prompt"])
        self.assertIn("参数", req["prompt"])
        c = self.service._codex_settings(self.cfg)
        self.assertEqual(c["model"], "gpt-6.1-sol")
        self.assertIn('model_reasoning_effort="low"', c["extra_args"])
        self.assertEqual(self.cfg, before)
        self.assertIn('model_reasoning_effort="high"', self.cfg["codex"]["extra_args"])

    def test_cache_uses_context_and_only_complete_results(self):
        with patch.object(self.service, "_codex", return_value=iter(["参", "数"])) as model:
            first = self.run_stream()
        self.assertTrue(first[-1]["done"])
        self.assertEqual(first[-1]["text"], "参数")
        with patch.object(self.service, "_codex", side_effect=AssertionError("重复结果不该调用模型")):
            second = self.run_stream()
        self.assertTrue(second[-1]["timing"]["cached"])
        self.assertNotEqual(st.prepare(self.ws, self.body, self.cfg)["cache_key"],
                            st.prepare(self.ws, {**self.body, "anchor": "c", "source_hashes": {}}, self.cfg)["cache_key"])
        def fail(*args):
            yield "未完成"
            raise engines.EngineError("provider failed")
        with patch.object(self.service, "_codex", side_effect=fail), self.assertRaises(engines.EngineError):
            self.run_stream({**self.body, "quote": "validation loss"})
        key = st.prepare(self.ws, {**self.body, "quote": "validation loss"}, self.cfg)["cache_key"]
        self.assertIsNone(self.service.cached(key))

    def test_stale_source_and_foreign_text_never_request_model(self):
        with patch.object(self.service, "_codex", side_effect=AssertionError("不应调用模型")):
            for body in ({**self.body, "source_hashes": {"b": "old"}}, {**self.body, "quote": "not present"}):
                with self.assertRaises(ValueError):
                    self.run_stream(body)

    def test_cancel_before_start_and_during_stream_do_not_cache(self):
        self.service.cancel("request-12345")
        with self.assertRaises(engines.Cancelled):
            self.run_stream()
        self.service.cancelled.clear()
        def cancel_after_piece(*args):
            yield "暂"
            self.service.cancel("request-12345")
            yield "停"
        with patch.object(self.service, "_codex", side_effect=cancel_after_piece), self.assertRaises(engines.Cancelled):
            self.run_stream()
        self.assertIsNone(self.service.cached(st.prepare(self.ws, self.body, self.cfg)["cache_key"]))

    def test_cross_paragraph_selection(self):
        req = st.prepare(self.ws, {"anchors": ["a", "b"], "quote": self.paper["blocks"][0]["en"] + "\n" + self.paper["blocks"][1]["en"]}, self.cfg)
        self.assertIn("minimize", req["prompt"])

    def test_exact_existing_translation_reused_without_model(self):
        with patch.object(self.service, "_codex", side_effect=AssertionError("已有对应译文不应请求模型")):
            word = self.run_stream({**self.body, "force_model": False})
            paragraph = self.run_stream({"anchor": "b", "key": "en", "quote": self.paper["blocks"][1]["en"]})
        self.assertEqual(word[-1]["text"], "参数")
        self.assertTrue(word[-1]["timing"]["reused_existing"])
        self.assertEqual(paragraph[-1]["text"], self.paper["blocks"][1]["zh"])
        self.assertTrue(paragraph[-1]["timing"]["reused_existing"])
        self.assertIsNone(st.prepare(self.ws, {"anchor": "b", "quote": "validation loss"}, self.cfg)["existing"])

    def test_api_key_masking_and_partial_update(self):
        s = st.settings(self.cfg)
        s["api"]["api_key"] = "private-test-key"
        shown = st.public(s)
        self.assertNotIn("private-test-key", json.dumps(shown))
        updated = st.sanitize({"api": {"api_key": shown["api"]["api_key"], "model": "example"}}, s)
        self.assertEqual(updated["api"]["api_key"], "private-test-key")
        public = config.public({**self.cfg, "selection_translation": s})
        self.assertNotIn("private-test-key", json.dumps(public))

    def test_both_api_protocols_real_local_http_and_truncation(self):
        calls = []
        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(inner):
                body = json.loads(inner.rfile.read(int(inner.headers["Content-Length"])))
                calls.append((inner.path, body, inner.headers.get("Authorization")))
                inner.send_response(200)
                inner.send_header("Content-Type", "text/event-stream")
                inner.end_headers()
                if inner.path.endswith("responses"):
                    events = [{"type": "response.output_text.delta", "delta": "参数"}, {"type": "response.completed", "response": {"usage": {"output_tokens": 2}}}]
                else:
                    reason = "length" if body["model"] == "truncated" else "stop"
                    events = [{"choices": [{"delta": {"content": "参"}}]}, {"choices": [{"delta": {"content": "数"}, "finish_reason": reason}]}]
                for ev in events:
                    inner.wfile.write(("data: " + json.dumps(ev, ensure_ascii=False) + "\n\n").encode())
                if not inner.path.endswith("responses"):
                    inner.wfile.write(b"data: [DONE]\n\n")
        server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        t = threading.Thread(target=server.serve_forever, daemon=True); t.start()
        try:
            self.cfg["selection_translation"]["engine"] = "api"
            a = self.cfg["selection_translation"]["api"]
            a.update(base_url=f"http://127.0.0.1:{server.server_port}/v1", model="example", api_key="private-test-key")
            for protocol in ("chat_completions", "responses"):
                a["protocol"] = protocol
                result = self.run_stream()
                self.assertEqual(result[-1]["text"], "参数")
                self.assertFalse(result[-1]["timing"]["cached"])
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0][0], "/v1/chat/completions")
            self.assertEqual(calls[1][0], "/v1/responses")
            self.assertTrue(all(x[2] == "Bearer private-test-key" for x in calls))
            a.update(protocol="chat_completions", reasoning_effort="max")
            result = self.run_stream()
            self.assertEqual(calls[-1][1]["reasoning_effort"], "max")
            self.assertGreaterEqual(calls[-1][1]["max_tokens"], 8192)
            self.assertEqual(result[-1]["timing"]["reasoning_effort"], "max")
            a.update(protocol="chat_completions", model="truncated")
            with self.assertRaises(engines.EngineError):
                self.run_stream()
            self.assertIsNone(self.service.cached(st.prepare(self.ws, self.body, self.cfg)["cache_key"]))
        finally:
            server.shutdown(); server.server_close(); t.join()

    def test_api_reuses_connection_streams_before_finish_and_rotates_key(self):
        calls, release, waiting = [], threading.Event(), threading.Event()
        class Provider(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *args):
                pass
            def do_POST(inner):
                body = json.loads(inner.rfile.read(int(inner.headers["Content-Length"])))
                calls.append((inner.client_address, body, inner.headers.get("Authorization")))
                first = b'data: {"choices":[{"delta":{"content":"first"}}]}\n\n'
                last = b'data: {"choices":[{"delta":{"content":" last"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
                inner.send_response(200)
                inner.send_header("Content-Type", "text/event-stream")
                inner.send_header("Content-Length", str(len(first) + len(last)))
                inner.end_headers()
                inner.wfile.write(first); inner.wfile.flush()
                if len(calls) == 1:
                    waiting.set()
                    release.wait(3)
                inner.wfile.write(last); inner.wfile.flush()
        server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        t = threading.Thread(target=server.serve_forever, daemon=True); t.start()
        self.cfg["selection_translation"]["engine"] = "api"
        a = self.cfg["selection_translation"]["api"]
        a.update(base_url=f"http://127.0.0.1:{server.server_port}/v1", model="example", api_key="key-one", reasoning_effort="max")
        rid = "reuse-request-12345"
        try:
            cancel = self.service.register(rid)
            stream = self.service.stream(self.ws, {**self.body, "refresh": True}, self.cfg, rid, cancel)
            next(stream)  # metadata
            piece = next(stream)
            self.assertEqual(piece["t"], "first")
            self.assertTrue(waiting.is_set())
            self.assertFalse(release.is_set(), "译文必须在响应结束之前流出")
            release.set()
            first = list(stream)[-1]
            self.service.unregister(rid)
            a["api_key"] = "key-two"
            second = self.run_stream({**self.body, "refresh": True})[-1]
            self.assertEqual(calls[0][0], calls[1][0], "第二次请求应复用已完成的 TCP 连接")
            self.assertFalse(first["timing"]["connection_reused"])
            self.assertTrue(second["timing"]["connection_reused"])
            self.assertEqual([c[2] for c in calls], ["Bearer key-one", "Bearer key-two"])
            self.assertEqual(calls[0][1]["messages"], calls[1][1]["messages"])
            self.assertTrue(all(c[1]["reasoning_effort"] == "max" and c[1]["max_tokens"] == 8192 for c in calls))
        finally:
            release.set(); self.service.unregister(rid); self.service.close()
            server.shutdown(); server.server_close(); t.join()

    def test_api_proxy_route_and_error_do_not_retry_or_leak_credentials(self):
        paths = []
        class Proxy(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(inner):
                inner.rfile.read(int(inner.headers["Content-Length"]))
                paths.append(inner.path)
                inner.send_response(502)
                inner.end_headers()
                inner.wfile.write(b"sensitive-provider-error-do-not-display")
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        t = threading.Thread(target=proxy.serve_forever, daemon=True); t.start()
        self.cfg["selection_translation"]["engine"] = "api"
        self.cfg["selection_translation"]["api"].update(base_url="http://unreachable-provider.invalid/v1", model="example", api_key="private-test-key")
        try:
            with patch.object(st.urllib.request, "getproxies", return_value={"http": f"http://127.0.0.1:{proxy.server_port}"}), \
                 patch.object(st.urllib.request, "proxy_bypass", return_value=False), self.assertRaises(engines.EngineError) as error:
                self.run_stream()
            self.assertEqual(paths, ["http://unreachable-provider.invalid/v1/chat/completions"])
            self.assertEqual(str(error.exception), "选词翻译 API 请求失败（HTTP 502）")
            self.assertIsNone(self.service.cached(st.prepare(self.ws, self.body, self.cfg)["cache_key"]))
        finally:
            self.service.close(); proxy.shutdown(); proxy.server_close(); t.join()


if __name__ == "__main__":
    unittest.main()
