import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from easyread import pdf_pipeline, reflow_prepare, arxivhtml, config
from easyread.library import Library
from easyread.store import write_json_atomic


def node(value, kind="paragraph", page=0):
    return {"type": kind, "content": [{"text": value}], "anchor": {"pageRects": [[page, 10, 20, 100, 50]]}}


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.lib = Library(self.home / "library")
        self.source, _ = self.lib.create_from_pdf(b"%PDF isolated fixture", "sample.pdf")
        self.before = {n: (self.source.root / n).read_bytes() for n in ("source.pdf", "paper.json", "reader.json", "discussion.json")}
        self.cfg = dict(config.DEFAULTS, pdf_web_enabled=True, pdf_ai_review=False, pdf_render_required=False,engine="codex", concurrency=24, html_batch_blocks=2, pdf_review_profile="strict")
        self.patches = [patch.object(config, "HOME", self.home), patch.object(config, "load", return_value=self.cfg)]
        for p in self.patches: p.start()
        self.addCleanup(lambda: [p.stop() for p in reversed(self.patches)])
        self.addCleanup(self.tmp.cleanup)

    def extract(self, workspace, worker, out, **kwargs):
        out.mkdir()
        structure = {"content": [node("Evidence is reliable."), node("Results are preserved.", "heading")]}
        write_json_atomic(out / "structure.json", structure)
        for name in reflow_prepare.FILES.values():
            if not (out / name).exists():
                (out / name).write_text("{}")
        write_json_atomic(out / "cache-proof.json", {"schema":2,"quality":"preview","source_sha256":reflow_prepare.digest(Path(workspace)/"source.pdf"),
                          "paper_sha256":reflow_prepare.digest(Path(workspace)/"paper.json"),"resources":reflow_prepare.FILES,
                          "files":{n:reflow_prepare.digest(out/n) for n in reflow_prepare.FILES.values()}})

    def response(self, cfg, prompt, cwd, images, cancel):
        p=json.loads((Path(cwd)/"paper.json").read_text())
        return json.dumps({"translations":[{"id":b["id"],"source_hash":b["source_hash"],"zh":"证据可靠。" if b["id"]=="sdt-0" else "结果得到保留。"} for b in p["blocks"]]})

    def prepare(self, **kwargs):
        with patch.object(reflow_prepare,"prepare",side_effect=self.extract):
            return pdf_pipeline.prepare(self.lib,self.source,self.cfg,threading.Event(),lambda *a:None,**kwargs)

    def test_real_validator_and_source_identity(self):
        with patch("easyread.engines.run",side_effect=self.response):
            target, proof=self.prepare()
        self.assertTrue(proof["complete"])
        self.assertTrue(pdf_pipeline.ready(target))
        for name,data in self.before.items(): self.assertEqual((self.source.root/name).read_bytes(),data)
        self.assertEqual([b["en"] for b in target.load("paper")["blocks"]],["Evidence is reliable.","Results are preserved."])
        self.assertEqual(self.lib.web_source(self.source).id,target.id)
        self.assertEqual(len(self.lib.list()),1)

    def test_provider_failure_cannot_be_ready(self):
        with patch("easyread.engines.run",side_effect=RuntimeError("model unavailable")):
            target,proof=self.prepare()
        self.assertFalse(proof["complete"])
        self.assertFalse(pdf_pipeline.ready(target))
        self.assertEqual(len(proof["failed"]),2)

    def test_invalid_or_missing_translation_cannot_be_ready(self):
        with patch("easyread.engines.run",return_value='{"translations":[]}'):
            target,proof=self.prepare()
        self.assertFalse(proof["complete"])
        self.assertFalse(pdf_pipeline.ready(target))

    def test_no_translation_and_empty_parse_are_not_success(self):
        with patch("easyread.engines.run") as model:
            target,proof=self.prepare(translate=False)
        model.assert_not_called()
        self.assertFalse(proof["complete"])
        with self.assertRaises(ValueError):pdf_pipeline.canonical_blocks({"content":[]})

    def test_resume_reuses_english_and_completed_translation(self):
        with patch("easyread.engines.run",side_effect=self.response): target,_=self.prepare()
        data=target.paper_path.read_bytes()
        with patch("easyread.engines.run") as model: resumed,proof=self.prepare()
        model.assert_not_called()
        self.assertEqual(data,resumed.paper_path.read_bytes())
        self.assertTrue(proof["complete"])

    def test_cache_or_translation_changes_invalidate_route(self):
        with patch("easyread.engines.run",side_effect=self.response): target,_=self.prepare()
        target.update("paper",lambda p:p["blocks"][0].update(en="Changed source"))
        self.assertFalse(pdf_pipeline.ready(target))

    def test_changed_extract_cache_is_never_reblessed(self):
        with patch("easyread.engines.run",side_effect=self.response):target,_=self.prepare()
        before=(target.root/"sdt-cache/cache-proof.json").read_bytes()
        (target.root/"sdt-cache/structure.json").write_text('{"content":[]}')
        with self.assertRaisesRegex(ValueError,"解析缓存证据发生变化"):self.prepare()
        self.assertEqual(before,(target.root/"sdt-cache/cache-proof.json").read_bytes())

    def test_math_and_table_bodies_not_sent_for_translation(self):
        blocks=pdf_pipeline.canonical_blocks({"content":[node("Paragraph"),node("Numbers", "table"),node("Figure 1: Evidence", "caption"),node("x+y", "math")]})
        self.assertEqual([b["id"] for b in blocks],["sdt-0","sdt-2"])

    def test_missing_pdf_coordinates_rejected(self):
        n=node("Text");n["anchor"]={}
        with self.assertRaises(ValueError):pdf_pipeline.canonical_blocks({"content":[n]})

    def test_reading_preserves_lists_and_scripts_without_cropping_prose(self):
        listing={"type":"list","anchor":{"pageRects":[[0,10,20,100,50]]},"content":[
            {"type":"listitem","content":[{"text":"1. First D"},{"text":"i","style":{"sub":True}}]},
            {"type":"listitem","content":[{"text":"2. Second"}]}]}
        structure={"content":[node("Abstract"),listing]}
        blocks=pdf_pipeline.canonical_blocks(structure)
        self.assertEqual(blocks[1]["en"],"1. First D_{i}\n2. Second")
        blocks[0]["display_source_crop"]=True
        paper={"meta":{},"blocks":blocks}
        pdf_pipeline.reading_layout(paper,structure)
        self.assertFalse(blocks[0]["display_source_crop"])
        self.assertTrue(blocks[1]["source_list"])

    def test_reading_skips_full_source_review_and_keeps_local_warning_readable(self):
        self.cfg.update(pdf_review_profile="reading",pdf_ai_review=True)
        stages=[]
        def review(ws,cfg,cancel,stage,report,**kwargs):
            stages.append(stage)
            ws.update("paper",lambda p:p["blocks"][0].update(translation_warning="对照原文"))
            return {"complete":False,"usable":True,"unresolved":{"sdt-0":"符号不明确"}}
        with patch("easyread.engines.run",side_effect=self.response),patch("easyread.pdf_review.review",side_effect=review):
            target,proof=self.prepare()
        self.assertEqual(stages,["translation"])
        self.assertTrue(proof["complete"])
        self.assertTrue(pdf_pipeline.ready(target))
        self.assertIn("sdt-0",proof["reading_warnings"])
        for name,data in self.before.items():self.assertEqual((self.source.root/name).read_bytes(),data)

    def test_excluded_semantic_text_is_preserved_and_audited(self):
        n=node("[Stack Exchange (STEM)]");n["flowClass"]="excluded"
        page=node("12");page["flowClass"]="excluded"
        structure={"content":[n,page]}
        blocks=pdf_pipeline.canonical_blocks(structure)
        self.assertEqual(len(blocks),1)
        self.assertTrue(blocks[0]["restore_excluded_source"])
        self.assertTrue(blocks[0]["display_source_crop"])
        self.assertTrue(pdf_pipeline.coverage(structure,blocks)["complete"])
        self.assertFalse(pdf_pipeline.coverage(structure,[])["complete"])

    def test_legacy_partial_translation_is_not_complete(self):
        self.assertFalse(pdf_pipeline.translated({"type":"para","en":"missing","zh":""}))
        self.assertFalse(pdf_pipeline.translated({"type":"list","items":[{"en":"one","zh":"一"},{"en":"two","zh":""}]}))
        self.assertTrue(pdf_pipeline.translated({"type":"figure","caption_en":"Figure","caption_zh":"图"}))
        self.assertTrue(pdf_pipeline.translated({"type":"math","tex":"x+y"}))

    def test_render_error_triggers_ai_repair_and_actual_recheck(self):
        self.cfg.update(pdf_ai_review=True,pdf_render_required=True)
        stages=[]
        def review(ws,cfg,cancel,stage,report,**kwargs):
            stages.append(stage)
            if stage=="render":
                self.assertEqual(kwargs["only_ids"],{"sdt-0"})
                ws.update("paper",lambda p:p["blocks"][0].update(zh="修复后的公式 $x+y$。"))
            return {"complete":True}
        with patch("easyread.engines.run",side_effect=self.response),patch("easyread.pdf_review.review",side_effect=review),patch("easyread.pdf_render.check",side_effect=[{"complete":False,"repairable_math_ids":["sdt-0"],"failed":[{"id":"sdt-0","math_errors":["bad TeX"]}]},{"complete":True}]) as render:
            target,proof=self.prepare()
        self.assertTrue(proof["complete"])
        self.assertEqual(render.call_count,2)
        self.assertIn("render",stages)
        self.assertEqual(target.load("paper")["blocks"][0]["zh"],"修复后的公式 $x+y$。")
        for name,data in self.before.items():self.assertEqual((self.source.root/name).read_bytes(),data)

if __name__=="__main__": unittest.main()
