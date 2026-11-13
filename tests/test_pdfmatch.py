"""匹配只凭固定版本 PDF 哈希自动切换；不覆盖原文、译文、批注。"""
import io
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

from pypdf import PdfWriter

from easyread import arxivhtml, pdfmatch, sources
from easyread.engines import Cancelled
from easyread.jobs import Jobs
from easyread.library import Library
from tests.test_arxiv_html import HTML, URL


class PDFMatchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.lib = Library(Path(self.temp.name))
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        writer.add_metadata({"/Title": "Source title"})
        data = io.BytesIO()
        writer.write(data)
        self.data = data.getvalue()
        self.pdf, _ = self.lib.create_from_pdf(self.data, "2512.16676v1.pdf")
        self.pdf.update("paper", lambda p: p["blocks"].append({"id": "old", "en": "Original", "zh": "已有译文"}))
        self.pdf.apply_reader_ops([{"op": "paper_note", "body": "原 PDF 笔记"}])
        self.frozen = {n: (self.pdf.root / n).read_bytes() for n in ("source.pdf", "paper.json", "reader.json")}

    def resolve(self, data=None, final=None, accept=False):
        with patch.object(arxivhtml, "fetch", return_value=(HTML, URL)), \
             patch.object(sources, "_get", return_value=(self.data if data is None else data, "application/pdf", final or URL.replace("html", "pdf"))):
            return pdfmatch.resolve(self.lib, self.pdf, threading.Event(), accept)

    def assert_frozen(self):
        for name, content in self.frozen.items():
            self.assertEqual((self.pdf.root / name).read_bytes(), content, name)

    def test_exact_pdf_matches_and_one_record_keeps_pdf_notes(self):
        result = self.resolve()
        self.assertEqual(result["state"], "matched")
        self.assertEqual(result["proof"]["kind"], "pdf_sha256")
        self.assert_frozen()
        summary = self.lib.list()
        self.assertEqual(len(summary), 1)
        self.assertEqual(summary[0]["read_id"], result["web_id"])
        self.assertEqual(summary[0]["reading_source_kind"], "arxiv_html")
        self.assertTrue(summary[0]["local_notes"])
        self.assertEqual(self.lib.web_source(self.pdf).load("item")["local_pdfs"], [self.pdf.id])

    def test_different_bytes_only_candidate_no_html_record(self):
        result = self.resolve(b"%PDF different version")
        self.assertEqual(result["state"], "candidate")
        self.assertFalse(self.lib.web_source(self.pdf))
        self.assertEqual(len(self.lib.all()), 1)
        self.assert_frozen()

    def test_wrong_version_redirect_never_accepted(self):
        result = self.resolve(final="https://arxiv.org/pdf/2512.16676v2")
        self.assertEqual(result["state"], "unavailable")
        self.assertFalse(self.lib.web_source(self.pdf))
        self.assert_frozen()

    def test_unavailable_html_and_search_failure_keep_pdf(self):
        with patch.object(arxivhtml, "fetch", side_effect=sources.SourceError("404")):
            self.assertEqual(pdfmatch.resolve(self.lib, self.pdf, threading.Event())["state"], "unavailable")
        with patch.object(pdfmatch, "candidate", side_effect=sources.SourceError("timeout")):
            self.assertEqual(pdfmatch.resolve(self.lib, self.pdf, threading.Event())["state"], "unavailable")
        with patch.object(pdfmatch, "candidate", return_value=None):
            self.assertEqual(pdfmatch.resolve(self.lib, self.pdf, threading.Event())["state"], "not_found")
        self.assert_frozen()

    def test_reuses_existing_html_without_overwriting_translation_or_notes(self):
        with patch.object(arxivhtml, "fetch", return_value=(HTML, URL)):
            web, _ = self.lib.create_from_arxiv_html(URL)
        web.update("paper", lambda p: [b.update(zh="保留已有中文 " + b["id"]) for b in p["blocks"]])
        web.apply_reader_ops([{"op": "paper_note", "body": "网页原笔记"}])
        original = {n: (web.root / n).read_bytes() for n in ("source.html", "article.html", "paper.json", "reader.json")}
        with patch.object(arxivhtml, "fetch", side_effect=AssertionError("不应重新抓取已有版本")), \
             patch.object(sources, "_get", return_value=(self.data, "application/pdf", URL.replace("html", "pdf"))):
            result = pdfmatch.resolve(self.lib, self.pdf, threading.Event())
        self.assertEqual(result["web_id"], web.id)
        for name, content in original.items():
            self.assertEqual((web.root / name).read_bytes(), content)
        self.assert_frozen()
        self.assertEqual(self.lib.create_from_pdf(self.data, "same.pdf")[0].id, self.pdf.id)

    def test_manual_selection_is_explicit_and_proof_is_distinct(self):
        result = self.resolve(b"%PDF different")
        self.pdf.update("item", lambda item: item.update(arxiv_match=result))
        result = self.resolve(accept=True)
        self.assertEqual(result["proof"]["kind"], "user_selected")
        self.assertIn("未确认", result["message"])
        self.assert_frozen()

    def test_identity_does_not_use_reference_bare_id(self):
        fake = Mock(metadata={"/Title": "Paper title"}, pages=[Mock()])
        fake.pages[0].extract_text.return_value = "References: 2512.16676v1"
        self.pdf.update("paper", lambda p: p["meta"].update(source="paper.pdf"))
        with patch("pypdf.PdfReader", return_value=fake):
            self.assertEqual(pdfmatch.identity(self.pdf)["arxiv"], "")
            fake.pages[0].extract_text.return_value = "arXiv:2512.16676v1 [cs.AI]"
            self.assertEqual(pdfmatch.identity(self.pdf)["arxiv"], "2512.16676v1")

    def test_cancellation_no_link_or_model_call(self):
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(Cancelled), patch.object(pdfmatch, "candidate") as query:
            pdfmatch.resolve(self.lib, self.pdf, cancel)
        query.assert_not_called()
        self.assert_frozen()

    def test_job_routes_to_web_without_preparing_pdf_or_retranslating_cached_html(self):
        result = self.resolve()
        web = self.lib.ws(result["web_id"])
        web.update("paper", lambda p: [b.update(zh="已有中文") for b in p["blocks"]])
        jobs = Jobs.__new__(Jobs)  # 同步验证队列路由，无后台线程
        jobs.lib = self.lib
        with patch("easyread.jobs.config.load", return_value={"engine": "none"}), \
             patch("easyread.jobs.translate.prepare") as prepare, patch.object(jobs, "enqueue_html") as enqueue:
            jobs._run_bulk(self.pdf, {"prefer_html": True, "translate": True, "web_scope": "all"}, threading.Event())
        prepare.assert_not_called()
        enqueue.assert_not_called()
        self.assertEqual(self.pdf.load("job")["state"], "done")
        self.assert_frozen()


if __name__ == "__main__":
    unittest.main()
