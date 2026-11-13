import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from easyread import pdf_review, arxivhtml
from easyread.store import Workspace, write_json_atomic, empty_reader


class ReviewTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.ws=Workspace(Path(self.tmp.name)/"paper");self.ws.root.mkdir()
        (self.ws.root/"extract").mkdir();(self.ws.root/"pages").mkdir()
        (self.ws.root/"extract/page-001.jpg").write_bytes(b"frozen-image")
        (self.ws.root/"pages/page-001.webp").write_bytes(b"frozen-page")
        self.block={"id":"sdt-0","type":"para","page":1,"en":"A wrong symbol.","source_text":"A wrong symbol.","source_hash":arxivhtml.digest("A wrong symbol."),"zh":"一个符号。","sdt_refs":[[0]],"source_pages":[1]}
        write_json_atomic(self.ws.paper_path,{"meta":{},"blocks":[self.block],"translation":{}})
        write_json_atomic(self.ws.reader_path,empty_reader())
        self.cfg={"engine":"codex","codex":{"model":"same-model"},"concurrency":24,"pdf_review_profile":"strict"}

    def run_review(self, reply, stage="source", **kwargs):
        with patch("easyread.engines.run",side_effect=reply),patch("easyread.pdfwork.engine_image",return_value=self.ws.root/"extract/page-001.jpg"):
            return pdf_review.review(self.ws,self.cfg,threading.Event(),stage,lambda *a:None,**kwargs)

    def test_repair_is_rechecked_and_raw_input_remains(self):
        original_image=(self.ws.root/"extract/page-001.jpg").read_bytes()
        calls=[]
        def reply(*args):
            b=self.ws.load("paper")["blocks"][0];calls.append(b["en"])
            return json.dumps({"reviews":[{"id":b["id"],"source_hash":b["source_hash"],"status":"correct" if len(calls)==1 else "pass","corrected_text":"A correct symbol.","reason":"原图中的字符"}]})
        result=self.run_review(reply)
        self.assertTrue(result["complete"]);self.assertEqual(result["repairs"],1)
        self.assertEqual(calls,["A wrong symbol.","A correct symbol."])
        b=self.ws.load("paper")["blocks"][0]
        self.assertEqual(b["zh"],"");self.assertTrue(b["display_source_crop"])
        self.assertEqual(original_image,(self.ws.root/"extract/page-001.jpg").read_bytes())

    def test_missing_review_is_not_success(self):
        result=self.run_review(lambda *a:'{"reviews":[]}')
        self.assertFalse(result["complete"]);self.assertIn("sdt-0",result["unresolved"])

    def test_wrong_source_identity_is_not_applied(self):
        before=self.ws.paper_path.read_bytes()
        result=self.run_review(lambda *a:json.dumps({"reviews":[{"id":"sdt-0","source_hash":"wrong","status":"correct","corrected_text":"invented","reason":"guess"}]}))
        self.assertFalse(result["complete"]);self.assertEqual(before,self.ws.paper_path.read_bytes())

    def test_existing_translation_remains_and_candidates_are_saved(self):
        before=self.ws.paper_path.read_bytes()
        def reply(*args):return json.dumps({"reviews":[{"id":"sdt-0","source_hash":self.block["source_hash"],"zh_hash":arxivhtml.digest(self.block["zh"]),"status":"correct","corrected_text":"修订建议。","reason":"核对原文"}]})
        result=self.run_review(reply,"translation",preserve_translation=True)
        self.assertFalse(result["complete"]);self.assertEqual(before,self.ws.paper_path.read_bytes())

    def test_cached_pass_does_not_call_model_again(self):
        calls=[]
        def reply(*args):calls.append(1);return json.dumps({"reviews":[{"id":"sdt-0","source_hash":self.block["source_hash"],"status":"pass"}]})
        self.assertTrue(self.run_review(reply)["complete"])
        self.assertTrue(self.run_review(reply)["complete"])
        self.assertEqual(len(calls),1)

    def test_constrained_repair_keeps_strict_identity_validation(self):
        calls=[]
        def reply(cfg,*args):
            schema=json.loads(Path(cfg["codex"]["extra_args"][-1]).read_text())
            fixed=schema["properties"]["reviews"]["items"]["anyOf"][0]["properties"]
            self.assertEqual(fixed["source_hash"]["enum"],[self.block["source_hash"]])
            self.assertEqual(fixed["zh_hash"]["enum"],[arxivhtml.digest(self.block["zh"])])
            calls.append(1)
            return json.dumps({"reviews":[{"id":"sdt-0","source_hash":self.block["source_hash"],"zh_hash":arxivhtml.digest(self.block["zh"]),"status":"uncertain" if len(calls)==1 else "pass","reason":"original ambiguity preserved","corrected_text":""}]})
        self.assertTrue(self.run_review(reply,"translation")["complete"])
        self.assertEqual(len(calls),2)

    def test_missing_required_page_never_calls_model(self):
        (self.ws.root/"pages/page-001.webp").unlink()
        def reply(*args):self.fail("model must not review without required page image")
        result=self.run_review(reply)
        self.assertFalse(result["complete"])

    def test_reading_ignores_minor_change_without_second_call(self):
        self.cfg["pdf_review_profile"]="reading"
        calls=[]
        def reply(*args):
            calls.append(1)
            return json.dumps({"reviews":[{"id":"sdt-0","source_hash":self.block["source_hash"],"zh_hash":arxivhtml.digest(self.block["zh"]),"status":"correct","impact":"minor","corrected_text":"姓名拼写变化。","reason":"人名拼写"}]})
        result=self.run_review(reply,"translation")
        self.assertTrue(result["complete"])
        self.assertEqual(len(calls),1)
        self.assertEqual(self.ws.load("paper")["blocks"][0]["zh"],self.block["zh"])

    def test_reading_retains_uncertain_translation_with_local_warning(self):
        self.cfg["pdf_review_profile"]="reading"
        calls=[]
        def reply(*args):
            calls.append(1)
            return json.dumps({"reviews":[{"id":"sdt-0","source_hash":self.block["source_hash"],"zh_hash":arxivhtml.digest(self.block["zh"]),"status":"uncertain","impact":"meaning","corrected_text":"","reason":"原页符号无法确认"}]})
        result=self.run_review(reply,"translation")
        self.assertEqual(len(calls),1)
        self.assertFalse(result["complete"])
        b=self.ws.load("paper")["blocks"][0]
        self.assertEqual(b["zh"],self.block["zh"])
        self.assertTrue(b["translation_warning"])

    def test_reading_repairs_changed_meaning_once(self):
        self.cfg["pdf_review_profile"]="reading"
        calls=[]
        def reply(*args):
            calls.append(1)
            return json.dumps({"reviews":[{"id":"sdt-0","source_hash":self.block["source_hash"],"zh_hash":arxivhtml.digest(self.block["zh"]),"status":"correct","impact":"meaning","corrected_text":"没有这个符号。","reason":"译文漏掉否定"}]})
        result=self.run_review(reply,"translation")
        self.assertEqual(len(calls),1)
        self.assertEqual(result["repairs"],1)
        self.assertEqual(self.ws.load("paper")["blocks"][0]["zh"],"没有这个符号。")
        self.assertTrue(self.run_review(lambda *a:self.fail("resume must not repeat the check"),"translation")["complete"])

if __name__=="__main__":unittest.main()
