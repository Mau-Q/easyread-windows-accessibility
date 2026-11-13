import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from easyread.server import Handler


class StaticMimeTests(unittest.TestCase):
    def test_reader_modules_are_served_as_javascript_even_on_windows(self):
        with tempfile.TemporaryDirectory() as folder:
            for suffix, expected in [('mjs','text/javascript'),('js','text/javascript'),('css','text/css')]:
                path=Path(folder)/('fixture.'+suffix);path.write_bytes(b'/* synthetic */')
                sent=[]
                handler=SimpleNamespace(_send=lambda *args:sent.append(args))
                Handler._file(handler,path)
                self.assertEqual(sent[0][0],200)
                self.assertEqual(sent[0][1],b'/* synthetic */')
                self.assertEqual(sent[0][2],expected+'; charset=utf-8')
