"""验证网页原文保真、版本固定、模型仅写中文与失败恢复。"""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from bs4 import BeautifulSoup

from easyread import arxivhtml, engines
from easyread.library import Library

URL = "https://arxiv.org/html/2512.16676v1"
HTML = b'''<!doctype html><html><head><title>Test</title>
<link rel="stylesheet" href="/static/paper.css"><script>alert(1)</script></head>
<body><a href="/abs/2512.16676v1">version</a><article class="ltx_document">
<h1 class="ltx_title ltx_title_document">Source title</h1>
<div class="ltx_abstract"><h6 class="ltx_title">Abstract</h6>
<p class="ltx_p" id="a">We may improve <em>accuracy</em> by 3%.
<math alttext="x_i"><mi>x</mi><annotation encoding="application/x-tex">x_i</annotation></math>
<a href="#ref1">[1]</a></p></div>
<p class="ltx_p" id="b" onclick="alert(1)">Do not omit this sentence.</p>
<figure><img src="2512.16676v1/x1.png"><figcaption class="ltx_caption">Figure 1: Source caption.</figcaption></figure>
<section class="ltx_bibliography"><p class="ltx_p" id="ref1">Author. Reference.</p></section>
</article></body></html>'''


class ArxivHTMLTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.lib = Library(Path(self.temp.name))
        with patch.object(arxivhtml, "fetch", return_value=(HTML, URL)):
            self.ws, _ = self.lib.create_from_arxiv_html(URL)

    def test_dom_text_math_links_and_assets_preserved(self):
        before = BeautifulSoup(HTML, "html.parser").article
        after = BeautifulSoup((self.ws.root / "article.html").read_text(), "html.parser")
        self.assertEqual(before.get_text(), after.article.get_text())
        self.assertEqual(str(before.math), str(after.math))
        self.assertEqual(after.select_one('a[href="#ref1"]').text, "[1]")
        self.assertEqual(after.img["src"], "https://arxiv.org/html/2512.16676v1/x1.png")
        self.assertFalse(after.find("script"))
        self.assertNotIn("onclick", after.find(id="b").attrs)
        self.assertEqual(len(self.ws.load("paper")["blocks"]), 5)
        self.assertIn("$x_i$", self.ws.load("paper")["blocks"][2]["source_text"])
        self.assertEqual(self.lib.summary(self.ws)["source_kind"], "arxiv_html")

    def test_version_identity_and_unsupported_html(self):
        self.assertEqual(arxivhtml._version(HTML, URL, "2512.16676"), "2512.16676v1")
        with self.assertRaises(ValueError):
            arxivhtml._version(HTML, "https://arxiv.org/html/2512.16676v1", "2512.16676v2")
        with self.assertRaises(ValueError):
            arxivhtml._version(HTML, "https://arxiv.org/html/2402.08954v1", "2512.16676v1")
        with self.assertRaises(ValueError):
            arxivhtml.arxiv_id("https://arxiv.org.evil.test/abs/2512.16676")
        with self.assertRaises(ValueError):
            arxivhtml.parse(b"<html>not available</html>", URL)

    def test_footnote_prompt_keeps_boundaries_without_flattening_hidden_labels(self):
        raw = HTML.replace(b'</article>', b'''<p class="ltx_p" id="notes">Dataset4<span class="ltx_note" id="footnote4"><sup class="ltx_note_mark">4</sup><span class="ltx_note_outer"><span class="ltx_note_content"><sup class="ltx_note_mark">4</sup><span class="ltx_tag_note">4</span>https://example.org/data</span></span></span>: body.</p></article>''')
        html, _, blocks = arxivhtml.parse(raw, URL)
        block = next(b for b in blocks if b['node_id'] == 'notes')
        self.assertEqual(block['source_text'], 'Dataset4[FOOTNOTE:4]https://example.org/data[/FOOTNOTE:4]: body.')
        before = BeautifulSoup(raw, 'html.parser').find(id='notes')
        after = BeautifulSoup(html, 'html.parser').find(id='notes')
        self.assertEqual(before.get_text(), after.get_text())
        self.assertEqual(str(before.select_one('.ltx_note')), str(after.select_one('.ltx_note')))
        valid = {'translations': [{'id': block['id'], 'source_hash': block['source_hash'],
                                  'zh': '数据集4[FOOTNOTE:4]https://example.org/data[/FOOTNOTE:4]：正文。'}]}
        self.assertIn(block['id'], arxivhtml.validate(valid, [block]))
        for zh in ('数据集444 4 https://example.org/data：正文。',
                   '数据集[FOOTNOTE:5]链接[/FOOTNOTE:5]：正文。'):
            valid['translations'][0]['zh'] = zh
            with self.assertRaises(arxivhtml.TranslationQualityError):
                arxivhtml.validate(valid, [block])

    def test_model_cannot_replace_english_and_cache_skips_done_blocks(self):
        original = self.ws.load("paper")
        html_bytes = (self.ws.root / "article.html").read_bytes()
        def run(cfg, prompt, *args):
            inputs = json.loads(prompt.split("\n输入：", 1)[1])
            return json.dumps({"translations": [{"id": b["id"], "source_hash": b["source_hash"],
                "zh": "中文译文", "en": "MALICIOUS REPLACEMENT"} for b in inputs]})
        with patch.object(engines, "run", side_effect=run) as engine:
            self.assertEqual(arxivhtml.translate(self.ws, {}, "abstract", threading.Event(), lambda *a: None), {})
            self.assertEqual(engine.call_count, 1)
            arxivhtml.translate(self.ws, {}, "abstract", threading.Event(), lambda *a: None)
            self.assertEqual(engine.call_count, 1)
        current = self.ws.load("paper")
        self.assertEqual([b["en"] for b in original["blocks"]], [b["en"] for b in current["blocks"]])
        self.assertEqual((self.ws.root / "article.html").read_bytes(), html_bytes)
        self.assertEqual(len(current["translation"]["done_blocks"]), 2)
        exported = BeautifulSoup(arxivhtml.export(self.ws), "html.parser")
        self.assertEqual(len(exported.select(".easyread-zh")), 2)

    def test_incomplete_or_mismatched_output_saves_nothing(self):
        blocks = self.ws.load("paper")["blocks"][1:3]
        cases = [{"translations": []}, {"translations": [{"id": "wrong", "source_hash": "wrong", "zh": "中文"}]}]
        for output in cases:
            with self.assertRaises(engines.EngineError):
                arxivhtml.validate(output, blocks)
        with patch.object(engines, "run", return_value='{"translations":[]}'):
            failed = arxivhtml.translate(self.ws, {}, "abstract", threading.Event(), lambda *a: None)
        self.assertEqual(set(failed), {b["id"] for b in blocks})
        self.assertFalse(any(b["zh"] for b in self.ws.load("paper")["blocks"]))

    def test_cancellation_prevents_save_and_snapshot_change_stops_calls(self):
        cancel = threading.Event()
        cancel.set()
        with patch.object(engines, "run") as engine:
            with self.assertRaises(engines.Cancelled):
                arxivhtml.translate(self.ws, {}, "all", cancel, lambda *a: None)
            engine.assert_not_called()
        (self.ws.root / "source.html").write_bytes(b"changed source")
        with patch.object(engines, "run") as engine:
            with self.assertRaises(ValueError):
                arxivhtml.translate(self.ws, {}, "all", threading.Event(), lambda *a: None)
            engine.assert_not_called()

    def test_import_deduplicates_only_identical_snapshot(self):
        with patch.object(arxivhtml, "fetch", return_value=(HTML, URL)):
            same, fresh = self.lib.create_from_arxiv_html(URL)
        self.assertFalse(fresh)
        self.assertEqual(same.id, self.ws.id)
        with patch.object(arxivhtml, "fetch", return_value=(HTML.replace(b"3%", b"4%"), URL)):
            other, fresh = self.lib.create_from_arxiv_html(URL)
        self.assertTrue(fresh)
        self.assertNotEqual(other.id, self.ws.id)

    def test_parallel_batches_save_without_losing_translations(self):
        barrier = threading.Barrier(3)
        original = self.ws.load("paper")
        def run(cfg, prompt, *args):
            barrier.wait(timeout=5)
            inputs = json.loads(prompt.split("\n输入：", 1)[1])
            return json.dumps({"translations": [{"id": b["id"], "source_hash": b["source_hash"],
                "zh": "中文 " + b["id"]} for b in inputs]})
        with patch.object(engines, "run", side_effect=run):
            failed = arxivhtml.translate(self.ws, {"concurrency": 3, "html_batch_blocks": 2},
                                        "all", threading.Event(), lambda *a: None)
        self.assertEqual(failed, {})
        current = arxivhtml.verify(self.ws)
        self.assertTrue(all(b["zh"] for b in current["blocks"]))
        self.assertEqual(len(current["translation"]["done_blocks"]), 5)
        self.assertEqual([b["en"] for b in original["blocks"]], [b["en"] for b in current["blocks"]])

    def test_table_upgrade_preserves_source_and_cached_translation(self):
        raw = HTML.replace(b"</figure>", b'</figure><table class="ltx_tabular"><tr><th>Model</th><th>Score</th></tr>'
                           b'<tr><td>Model A</td><td>95.3</td></tr></table>')
        with patch.object(arxivhtml, "SELECTOR", ".ltx_p, .ltx_title, .ltx_caption"), \
             patch.object(arxivhtml, "fetch", return_value=(raw, URL)):
            ws, _ = self.lib.create_from_arxiv_html(URL)
        ws.update("paper", lambda p: p["blocks"][1].update(zh="已保存的摘要标题"))
        before = BeautifulSoup((ws.root / "article.html").read_text(), "html.parser")
        self.assertEqual(arxivhtml.include_tables(ws), 1)
        self.assertEqual(arxivhtml.include_tables(ws), 0)
        after = BeautifulSoup((ws.root / "article.html").read_text(), "html.parser")
        self.assertEqual(before.article.get_text(), after.article.get_text())
        self.assertEqual(str(before.math), str(after.math))
        paper = arxivhtml.verify(ws)
        self.assertEqual(paper["blocks"][1]["zh"], "已保存的摘要标题")
        self.assertEqual(paper["meta"]["source_sha256"], arxivhtml.digest(raw))
        table = next(b for b in paper["blocks"] if b["id"].startswith("web-table-"))
        self.assertIn('"text": "95.3"', table["source_text"])
        self.assertEqual(len(paper["blocks"]), 6)

    def test_parallel_cancellation_keeps_unfinished_batches_unsaved(self):
        barrier = threading.Barrier(3)
        cancel = threading.Event()
        def run(cfg, prompt, *args):
            inputs = json.loads(prompt.split("\n输入：", 1)[1])
            barrier.wait(timeout=5)
            cancel.set()
            return json.dumps({"translations": [{"id": b["id"], "source_hash": b["source_hash"],
                "zh": "中文"} for b in inputs]})
        with patch.object(engines, "run", side_effect=run):
            with self.assertRaises(engines.Cancelled):
                arxivhtml.translate(self.ws, {"concurrency": 3, "html_batch_blocks": 2},
                                    "all", cancel, lambda *a: None)
        self.assertFalse(any(b["zh"] for b in self.ws.load("paper")["blocks"]))

    def test_svg_objects_display_as_original_images_and_legacy_assets_restore(self):
        graphic = b'<figure id="fig3"><object class="ltx_graphics" id="original-graphic" type="image/svg+xml" data="2512.16676v1/plot.svg" width="476" height="99"></object><figcaption class="ltx_caption">Original SVG caption</figcaption></figure>'
        raw = HTML.replace(b'</article>', graphic + b'</article>')
        with patch.object(arxivhtml, "fetch", return_value=(raw, URL)):
            ws, _ = self.lib.create_from_arxiv_html(URL)
        article = BeautifulSoup((ws.root / "article.html").read_text(), "html.parser")
        img = article.find(id="original-graphic")
        self.assertEqual(img.name, "img")
        self.assertEqual(img["src"], URL + "/plot.svg")
        self.assertFalse(article.find("object"))
        self.assertEqual(article.article.get_text(), BeautifulSoup(raw, "html.parser").article.get_text())
        before = {n: (ws.root / n).read_bytes() for n in ("source.html", "article.html", "paper.json")}
        self.assertEqual(arxivhtml.visual_assets(ws)[0]["src"], URL + "/plot.svg")
        for name, data in before.items():
            self.assertEqual((ws.root / name).read_bytes(), data)

    def test_new_translation_does_not_generate_tables(self):
        raw = HTML.replace(b'</article>', b'<table class="ltx_tabular"><tr><td>95.3</td></tr></table></article>')
        with patch.object(arxivhtml, "fetch", return_value=(raw, URL)):
            ws, _ = self.lib.create_from_arxiv_html(URL)
        def run(cfg, prompt, *args):
            inputs = json.loads(prompt.split("\n输入：", 1)[1])
            self.assertFalse(any('95.3' in b['text'] for b in inputs))
            return json.dumps({"translations": [{"id": b["id"], "source_hash": b["source_hash"], "zh": "中文"} for b in inputs]})
        with patch.object(engines, "run", side_effect=run):
            self.assertEqual(arxivhtml.translate(ws, {}, "all", threading.Event(), lambda *a: None), {})
        table = next(b for b in ws.load("paper")["blocks"] if b.get("translatable") is False)
        self.assertEqual(table['en'], '95.3')
        self.assertEqual(table['zh'], '')


if __name__ == "__main__":
    unittest.main()
