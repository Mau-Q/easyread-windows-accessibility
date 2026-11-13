"""Real subprocess checks; no AI or external translation engine is called."""
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

import psutil
from easyread import pdf_translation
from easyread.store import write_json_atomic


class LifecycleTests(unittest.TestCase):
    def test_identity_check_is_read_only_and_rejects_a_reused_pid(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            run = root / 'runs' / 'test'
            run.mkdir(parents=True)
            spec = str(run / 'input.json')
            proc = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)', spec],
                                    **pdf_translation.process_options())
            self.addCleanup(lambda: pdf_translation.stop_group(proc))
            write_json_atomic(root / 'translation-task.json', {'id':'test'})
            path = run / 'task.json'
            write_json_atomic(path, {'id':'test','state':'running','supervisor_pid':proc.pid})
            self.assertEqual(pdf_translation.state(SimpleNamespace(root=root))['state'], 'running')
            self.assertIsNone(proc.poll(), 'Reading task state must not terminate its process')
            write_json_atomic(path, {'id':'test','state':'running','supervisor_pid':psutil.Process().pid})
            self.assertEqual(pdf_translation.state(SimpleNamespace(root=root))['state'], 'failed')

    def test_stop_terminates_owned_descendants(self):
        with tempfile.TemporaryDirectory() as folder:
            pidfile = Path(folder) / 'child.pid'
            code = "import subprocess,sys,time;from pathlib import Path;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);Path(sys.argv[1]).write_text(str(p.pid));time.sleep(60)"
            proc = subprocess.Popen([sys.executable,'-c',code,str(pidfile)], **pdf_translation.process_options())
            self.addCleanup(lambda: pdf_translation.stop_group(proc))
            deadline=time.monotonic()+10
            while not pidfile.exists() and time.monotonic()<deadline: time.sleep(.05)
            self.assertTrue(pidfile.exists())
            child=psutil.Process(int(pidfile.read_text()))
            pdf_translation.stop_group(proc)
            self.assertIsNotNone(proc.poll())
            try: child.wait(timeout=5)
            except psutil.TimeoutExpired: self.fail('Owned child survived shutdown')
