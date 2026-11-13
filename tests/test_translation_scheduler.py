import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread import arxivhtml, engines, translation_context, translation_scheduler, translation_quality
from easyread.library import Library
from test_arxiv_html import HTML, URL


class TranslationSchedulingTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.lib = Library(Path(temp.name))
        with patch.object(arxivhtml, 'fetch', return_value=(HTML, URL)):
            self.ws, _ = self.lib.create_from_arxiv_html(URL)

    @staticmethod
    def answer(prompt):
        inputs = json.loads(prompt.split('\n输入：', 1)[1])
        return json.dumps({'translations': [{'id': b['id'], 'source_hash': b['source_hash'],
                                             'zh': '译文 ' + b['id']} for b in inputs]})

    def test_parallel_order_cannot_change_any_prompt_or_cached_content(self):
        self.ws.update('paper', lambda p: p['blocks'][0].update(zh='已保存的标题'))
        before = self.ws.load('paper')
        context = translation_context.freeze(before, (self.ws.root / 'article.html').read_text())
        expected = {b['id']: arxivhtml.prompt(before, [b], context) for b in before['blocks'][1:]}
        observed = {}
        barrier = threading.Barrier(4)
        def run(cfg, prompt, *args):
            barrier.wait(timeout=5)
            bid = json.loads(prompt.split('\n输入：', 1)[1])[0]['id']
            observed[bid] = prompt
            return self.answer(prompt)
        with patch.object(engines, 'run', side_effect=run):
            failed = arxivhtml.translate(self.ws, {'concurrency': 4, 'html_batch_blocks': 1},
                                         'all', threading.Event(), lambda *a: None)
        self.assertFalse(failed)
        self.assertEqual(expected, observed)
        self.assertEqual(self.ws.load('paper')['blocks'][0]['zh'], '已保存的标题')
        self.assertEqual([b['en'] for b in before['blocks']], [b['en'] for b in self.ws.load('paper')['blocks']])

    def test_retry_is_limited_to_transient_failure_and_keeps_completed_translation(self):
        calls = []
        def run(cfg, prompt, *args):
            calls.append(prompt)
            if len(calls) == 1:
                raise engines.EngineError('HTTP 429 rate limit')
            return self.answer(prompt)
        with patch.object(engines, 'run', side_effect=run):
            failed = arxivhtml.translate(self.ws, {'concurrency': 4, 'html_retry_delay': 0},
                                         'abstract', threading.Event(), lambda *a: None)
        self.assertFalse(failed)
        self.assertEqual(calls[0], calls[1])
        metrics = json.loads((self.ws.root / 'translation-metrics.json').read_text())
        self.assertEqual(len(metrics['requests']), 2)

    def test_invalid_batch_is_split_and_only_valid_children_are_saved(self):
        calls = []
        def run(cfg, prompt, *args):
            inputs = json.loads(prompt.split('\n输入：', 1)[1])
            calls.append([b['id'] for b in inputs])
            if len(inputs) > 1 or inputs[0]['id'] == 'web-3':
                return '{"translations":[]}'
            return self.answer(prompt)
        with patch.object(engines, 'run', side_effect=run):
            failed = arxivhtml.translate(self.ws, {}, 'abstract', threading.Event(), lambda *a: None)
        self.assertEqual(set(failed), {'web-3'})
        self.assertTrue(self.ws.load('paper')['blocks'][1]['zh'])
        self.assertFalse(self.ws.load('paper')['blocks'][2]['zh'])
        self.assertEqual(calls, [['web-2', 'web-3'], ['web-2'], ['web-3']])

    def test_quota_stops_queued_calls_without_overwriting_any_content(self):
        before = copy.deepcopy(self.ws.load('paper'))
        with patch.object(engines, 'run', side_effect=engines.EngineError('usage limit reached')) as run:
            failed = arxivhtml.translate(self.ws, {'concurrency': 1, 'html_batch_blocks': 1},
                                         'all', threading.Event(), lambda *a: None)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(len(failed), len(before['blocks']))
        self.assertEqual(before, self.ws.load('paper'))

    def test_one_workers_quota_error_also_stops_other_workers_pending_retry(self):
        rate_started = threading.Event()
        def run(cfg, prompt, *args):
            bid = json.loads(prompt.split('\n输入：', 1)[1])[0]['id']
            if bid == 'web-2':
                self.assertTrue(rate_started.wait(5))
                raise engines.EngineError('usage limit reached')
            rate_started.set()
            raise engines.EngineError('429 rate limit')
        with patch.object(engines, 'run', side_effect=run) as model:
            failed = arxivhtml.translate(self.ws, {'concurrency': 2, 'html_batch_blocks': 1, 'html_retry_delay': 0.1},
                                         'abstract', threading.Event(), lambda *a: None)
        self.assertEqual(len(failed), 2)
        self.assertEqual(model.call_count, 2)

    def test_scheduler_bounds_peak_and_reduces_limit_after_transient_failure(self):
        allowed = []
        peak = active = 0
        lock = threading.Lock()
        ready = threading.Barrier(4)
        def work(batch):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            if batch < 4:
                ready.wait(timeout=5)
            with lock:
                active -= 1
            return {}, batch == 0
        translation_scheduler.run(list(range(16)), work, {'concurrency': 4}, threading.Event(),
                                  lambda batch, failed, n: allowed.append(n))
        self.assertEqual(peak, 4)
        self.assertIn(2, allowed)
        self.assertTrue(all(1 <= n <= 4 for n in allowed))

    def test_higher_parallelism_supported_and_clamped_at_32(self):
        self.assertEqual(translation_scheduler.concurrency({'concurrency': 16}), 16)
        self.assertEqual(translation_scheduler.concurrency({'concurrency': 1000}), 32)
        self.assertEqual(translation_scheduler.concurrency({'concurrency': -1}), 1)

    def test_ambiguous_or_unfounded_cached_glossary_is_not_forced_on_other_batches(self):
        paper = self.ws.load('paper')
        paper['blocks'][0].update(source_text='Accuracy', zh='准确率（Accuracy）')
        paper['blocks'][1].update(source_text='Accuracy', zh='准确度（Accuracy）')
        paper['blocks'][2].update(zh='未知词（NotInSource）')
        context = translation_context.freeze(paper, '')
        self.assertEqual(context['glossary'], [])

    def test_strict_quantity_bounds_are_checked_without_rewriting_or_guessing_alignment(self):
        self.assertTrue(translation_quality.issues('more than six pipelines', '六条以上流水线'))
        self.assertTrue(translation_quality.issues('fewer than 12 items', '十二项以下'))
        self.assertFalse(translation_quality.issues('more than six pipelines', '超过六条流水线'))
        self.assertFalse(translation_quality.issues('at least six pipelines', '六条以上流水线'))
        self.assertFalse(translation_quality.issues('more than six pipelines', '十六条以上流水线'))
        self.assertFalse(translation_quality.issues('at least six X but more than six Y', '六个以上的 X 和超过六个的 Y'))

    def test_quality_repair_only_requests_bad_new_paragraph_and_keeps_other_saved_text(self):
        self.ws.update('paper', lambda p: p['blocks'][2].update(source_text='more than six pipelines'))
        calls = []
        good = None
        def run(cfg, prompt, *args):
            nonlocal good
            inputs = json.loads(prompt.split('\n输入：', 1)[1]); calls.append([b['id'] for b in inputs])
            rows = [{'id': b['id'], 'source_hash': b['source_hash'], 'zh': '原样保存的合格译文'} for b in inputs]
            for row in rows:
                if row['id'] == 'web-3':
                    row['zh'] = '超过六条流水线' if '必须核对并修正' in prompt else '六条以上流水线'
            if len(calls) == 2:
                good = self.ws.load('paper')['blocks'][1]['zh']
            return json.dumps({'translations': rows})
        with patch.object(engines, 'run', side_effect=run):
            failed = arxivhtml.translate(self.ws, {}, 'abstract', threading.Event(), lambda *a: None)
        self.assertFalse(failed)
        self.assertEqual(calls, [['web-2', 'web-3'], ['web-3']])
        self.assertEqual(good, '原样保存的合格译文')
        self.assertEqual(self.ws.load('paper')['blocks'][2]['zh'], '超过六条流水线')

    def test_cancellation_during_backoff_cannot_save_a_translation(self):
        cancel = threading.Event()
        def run(*args):
            cancel.set()
            raise engines.EngineError('temporary network error')
        with patch.object(engines, 'run', side_effect=run):
            with self.assertRaises(engines.Cancelled):
                arxivhtml.translate(self.ws, {}, 'abstract', cancel, lambda *a: None)
        self.assertFalse(any(b['zh'] for b in self.ws.load('paper')['blocks']))


if __name__ == '__main__':
    unittest.main()
