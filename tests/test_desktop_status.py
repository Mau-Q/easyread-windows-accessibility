import threading
import unittest
from unittest.mock import Mock

from easyread.server import App, Handler


class DesktopStatusTest(unittest.TestCase):
    def setUp(self):
        self.app = App.__new__(App)
        self.app.jobs = Mock()
        self.app.jobs.small_status.return_value = []
        self.app.chat_lock = threading.Lock()
        self.app.active_chats = 0

    def test_stream_is_visible_and_cleared_after_failure(self):
        handler = Handler.__new__(Handler)
        handler.app = self.app

        def fail(*args):
            self.assertEqual(self.app.small_status()[0]["state"], "running")
            raise RuntimeError("stream disconnected")

        handler._chat_impl = fail
        with self.assertRaises(RuntimeError):
            handler._chat(None, {})
        self.assertEqual(self.app.small_status(), [])

    def test_stream_remains_active_until_all_requests_finish(self):
        self.app.active_chats = 2
        self.assertEqual(len(self.app.small_status()), 1)
        self.app.active_chats = 1
        self.assertEqual(self.app.small_status()[0]["kind"], "chat")
