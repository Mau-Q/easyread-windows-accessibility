"""真实管道上的 Codex 协议替身：首片段、正文一致性、错误与取消，不调用模型。"""
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread import chat, codex_chat, engines


FAKE = '''
import json,sys,time
from pathlib import Path
mode,root=sys.argv[1:]
def send(obj):
 print(json.dumps(obj,ensure_ascii=False),flush=True)
def event(method,**kw):
 send({"method":method,"params":{"threadId":"t-fake","turnId":"turn-fake",**kw}})
for line in sys.stdin:
 q=json.loads(line); rid=q.get("id"); method=q["method"]
 if method=="initialize":
  if mode=="old":
   send({"id":rid,"error":{"message":"unknown method"}});break
  send({"id":rid,"result":{}})
 elif method=="thread/start":
  assert q["params"]["ephemeral"] is True
  assert q["params"]["sandbox"]=="read-only"
  assert q["params"]["approvalPolicy"]=="never"
  send({"id":rid,"result":{"thread":{"id":"t-fake"}}})
 elif method=="turn/start":
  Path(root,"request.json").write_text(json.dumps(q))
  send({"id":rid,"result":{"turn":{"id":"turn-fake"}}})
  if mode=="quiet":
   time.sleep(10);break
  sys.stderr.write("test diagnostic\\n"*10000);sys.stderr.flush()
  event("item/started",item={"id":"comment","type":"agentMessage","phase":"commentary","text":""})
  event("item/agentMessage/delta",itemId="comment",delta="工具前的说明")
  event("item/completed",item={"id":"comment","type":"agentMessage","phase":"commentary","text":"工具前的说明"})
  phase=None if mode=="legacy" else "final_answer"
  event("item/started",item={"id":"answer","type":"agentMessage","phase":phase,"text":""})
  event("item/reasoning/summaryTextDelta",delta="不应显示的推理")
  event("item/agentMessage/delta",itemId="answer",delta="原文 $x$ ")
  if mode=="gate":
   while not Path(root,"gate").exists():time.sleep(.01)
  if mode=="fail":
   event("turn/completed",turn={"status":"failed","error":{"message":"provider failed"}});break
  event("item/agentMessage/delta",itemId="answer",delta="与回答。")
  answer="别的内容" if mode=="mismatch" else "原文 $x$ 与回答。"
  event("item/completed",item={"id":"answer","type":"agentMessage","phase":phase,"text":answer})
  event("turn/completed",turn={"status":"completed"});break
'''


class CodexChatTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.script = self.root / 'cli.py'
        self.script.write_text(FAKE)
        self.cancel = threading.Event()
        self.cfg = {'command': sys.executable, 'model': 'gpt-6.1-sol',
                    'extra_args': ['-c', 'model_reasoning_effort="high"'], 'timeout': 3}
        self.procs = []

    def tearDown(self):
        for proc in self.procs:
            self.assertIsNotNone(proc.poll())
        self.temp.cleanup()

    def fake(self, mode):
        def popen(args, cwd):
            self.assertEqual(args[1:], ['app-server', '-c', 'model_reasoning_effort="high"'])
            proc = subprocess.Popen([sys.executable, str(self.script), mode, str(self.root)], cwd=cwd,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, encoding='utf-8')
            self.procs.append(proc)
            return proc
        return patch('easyread.engines._popen', popen)

    def test_first_piece_arrives_before_completion_and_only_answer_is_sent(self):
        with self.fake('gate'):
            gen = codex_chat.stream(self.cfg, '问题', self.root, self.cancel)
            first = next(gen)
            self.assertEqual(first, '原文 $x$ ')
            self.assertFalse((self.root / 'gate').exists())
            self.assertIsNone(self.procs[0].poll())
            (self.root / 'gate').touch()
            self.assertEqual(first + ''.join(gen), '原文 $x$ 与回答。')
        self.assertEqual(json.loads((self.root / 'request.json').read_text())['params']['input'][0]['text'], '问题')

    def test_legacy_message_uses_completed_text_once(self):
        with self.fake('legacy'):
            self.assertEqual(list(codex_chat.stream(self.cfg, '问题', self.root, self.cancel)), ['原文 $x$ 与回答。'])

    def test_image_is_native_turn_input_with_configured_effort(self):
        image = self.root / '截图.png'
        image.write_bytes(b'fixture')
        with self.fake('legacy'):
            list(chat.stream({'engine': 'codex', 'codex': self.cfg}, '解释截图', self.root,
                             self.cancel, images=[image]))
        params = json.loads((self.root / 'request.json').read_text())['params']
        self.assertEqual(params['input'], [{'type': 'text', 'text': '解释截图'},
                                         {'type': 'localImage', 'path': str(image)}])
        self.assertEqual(params['effort'], 'high')

    def test_failure_after_request_never_falls_back_or_resends(self):
        cfg = {'engine': 'codex', 'codex': self.cfg}
        with self.fake('fail'), patch('easyread.engines.run') as fallback:
            gen = chat.stream(cfg, '问题', self.root, self.cancel)
            self.assertEqual(next(gen), '原文 $x$ ')
            with self.assertRaisesRegex(engines.EngineError, 'provider failed'):
                list(gen)
            fallback.assert_not_called()

    def test_mismatched_final_text_is_not_marked_complete(self):
        with self.fake('mismatch'):
            with self.assertRaisesRegex(engines.EngineError, '不一致'):
                list(codex_chat.stream(self.cfg, '问题', self.root, self.cancel))

    def test_unsupported_protocol_can_fall_back_before_model_request(self):
        with self.fake('old'), patch('easyread.engines.run', return_value='旧 CLI 回答') as fallback:
            self.assertEqual(list(chat.stream({'engine': 'codex', 'codex': self.cfg}, '问题', self.root, self.cancel)), ['旧 CLI 回答'])
            fallback.assert_called_once()
        self.assertFalse((self.root / 'request.json').exists())

    def test_cancel_while_waiting_kills_process(self):
        timer = threading.Timer(.2, self.cancel.set)
        timer.start()
        try:
            with self.fake('quiet'):
                with self.assertRaises(engines.Cancelled):
                    list(codex_chat.stream(self.cfg, '问题', self.root, self.cancel))
        finally:
            timer.cancel()

    def test_timeout_after_request_is_not_an_unavailable_protocol(self):
        with self.fake('quiet'):
            with self.assertRaises(engines.EngineError) as raised:
                list(codex_chat.stream({**self.cfg, 'timeout': 1}, '问题', self.root, self.cancel))
            self.assertNotIsInstance(raised.exception, codex_chat.StreamUnavailable)


if __name__ == '__main__':
    unittest.main()
