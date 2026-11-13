import copy
import hashlib
import json
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path

from easyread import pdf_dual
from easyread.store import empty_reader, read_json, write_json_atomic


class PDFDualTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.service = pdf_dual.Service(self.home)
        self.root = self.service.root / "dual-test"
        (self.root / "assets").mkdir(parents=True)
        self.manifest = {"id": "dual-test", "reference_schema": 1, "title": "Test", "paper": {"blocks": []}, "assets": {}}
        for side, text in [("source", "Original text\nSecond page"), ("translation", "中文译文\n第二页")]:
            raw = b"%PDF-test-" + side.encode()
            (self.root / "assets" / f"{side}.pdf").write_bytes(raw)
            self.manifest["assets"][side] = {"id": f"{side}-v1", "version": 1, "label": side,
                "sha256": hashlib.sha256(raw).hexdigest(), "filename": f"{side}.pdf", "page_count": 2,
                "pages": text.split("\n"), "page_boxes": [[0, 0, 612, 792]] * 2}
        write_json_atomic(self.root / "manifest.json", self.manifest)
        write_json_atomic(self.root / "reader.json", empty_reader())
        self.ws = self.service.workspace("dual-test")

    def ref(self, side="source", quote="Original text"):
        asset = self.manifest["assets"][side]
        return {"anchor": f"{side}-p1", "quote": quote, "pdf": {
            "schema": 1, "document_id": "dual-test", "coordinate_space": "pdf-user-space", "side": side,
            "asset_id": asset["id"], "version": asset["version"], "sha256": asset["sha256"], "pageIndex": 0,
            "positions": [{"pageIndex": 0, "rects": [[50, 700, 200, 720]]}]}}

    def note(self, side="source", quote="Original text", nid="test-note"):
        ref = self.ref(side, quote)
        return dict(ref, id=nid, kind="note", body="saved", created="2026-10-13T10:00:00Z", updated="2026-10-13T10:00:00Z",
                    native=[{"id": f"{nid}-0", "type": "highlight", "position": ref["pdf"]["positions"][0], "text": quote}])

    def save(self, note):
        return self.service.apply(self.ws, {"ops": [{"op": "note", "note": note}], "client": "contract-test"})

    def test_saves_both_sides_with_workspace_history_and_reloads(self):
        self.save(self.note())
        self.save(self.note("translation", "中文译文", "translation-note"))
        notes = self.service.state(self.ws)["reader"]["notes"]
        self.assertEqual({n["pdf"]["side"] for n in notes.values()}, set(pdf_dual.SIDES))
        self.assertTrue(all(n["pdf_status"] == "current" for n in notes.values()))
        self.assertEqual(len(self.ws.journal_path.read_text().splitlines()), 2)
        self.assertTrue(list((self.root / "history").glob("reader-*.json")))

    def test_batch_rejection_cannot_partially_save(self):
        good = self.note()
        bad = self.note(nid="bad-note")
        bad["pdf"]["sha256"] = "wrong"
        before = self.ws.reader_path.read_bytes()
        with self.assertRaises(ValueError):
            self.service.apply(self.ws, {"ops": [{"op": "note", "note": n} for n in (good, bad)]})
        self.assertEqual(self.ws.reader_path.read_bytes(), before)
        self.assertFalse(self.ws.journal_path.exists())

    def test_identity_fields_are_required(self):
        for key, value in [("schema", 2), ("document_id", "other-doc"), ("side", "other"), ("asset_id", "other"), ("version", 2), ("sha256", "other"), ("coordinate_space", "browser-pixels")]:
            with self.subTest(key=key):
                ref = self.ref(); ref["pdf"][key] = value
                with self.assertRaises(ValueError): self.service.reference(self.ws, ref)

    def test_page_and_quote_cannot_cross_sides(self):
        with self.assertRaises(ValueError): self.service.reference(self.ws, self.ref("translation", "Original text"))
        for page in [-1, 2, True]:
            ref = self.ref(); ref["pdf"]["pageIndex"] = page
            with self.assertRaises(ValueError): self.service.reference(self.ws, ref)

    def test_finite_bounded_rectangles(self):
        for rect in [[0, 0, float("nan"), 10], [2, 2, 1, 3], [0, 0, 10000, 10], [1, 1, 2], [True, 1, 2, 3]]:
            ref = self.ref(); ref["pdf"]["positions"][0]["rects"] = [rect]
            with self.assertRaises(ValueError): self.service.reference(self.ws, ref)

    def test_cross_page_reference_stays_contiguous(self):
        ref = self.ref(quote="Original text\nSecond page")
        ref["pdf"]["positions"].append({"pageIndex": 1, "rects": [[50, 700, 200, 720]]})
        self.assertTrue(self.service.reference(self.ws, ref)["confirmed"])
        ref["pdf"]["positions"][1]["pageIndex"] = 0
        with self.assertRaises(ValueError): self.service.reference(self.ws, ref)

    def test_native_highlight_cannot_disagree_with_reference(self):
        note = self.note(); note["native"][0]["position"] = {"pageIndex": 1, "rects": [[1, 2, 3, 4]]}
        with self.assertRaises(ValueError): self.save(note)

    def test_both_sides_can_change_pen_and_color_without_moving_reference(self):
        for side, quote in [('source', 'Original text'), ('translation', '中文译文')]:
            note = self.note(side, quote, side + '-mark')
            self.save(note)  # Old highlights have no style or color fields.
            original_reference = copy.deepcopy(note['pdf'])
            for style in ['underline', 'marker']:
                for color in ['yellow', 'green', 'blue', 'pink']:
                    note.update(style=style, color=color)
                    note['native'][0]['type'] = 'underline' if style == 'underline' else 'highlight'
                    self.save(note)
                    stored = pdf_dual.Service(self.home).state(self.ws)['reader']['notes'][note['id']]
                    self.assertEqual(stored['pdf'], original_reference)
                    self.assertEqual((stored['style'], stored['color']), (style, color))
                    self.assertEqual(stored['native'][0]['type'], note['native'][0]['type'])

    def test_invalid_pen_color_and_mismatched_native_type_are_rejected(self):
        for fields in [{'style': 'other'}, {'color': 'other'}, {'style': 'underline'}]:
            note = self.note(); note.update(fields)
            with self.subTest(fields=fields), self.assertRaises(ValueError): self.save(note)

    def test_existing_note_identity_cannot_be_reassigned(self):
        self.save(self.note())
        with self.assertRaises(ValueError): self.save(self.note("translation", "中文译文"))
        self.assertEqual(self.ws.load("reader")["notes"]["test-note"]["pdf"]["side"], "source")

    def test_replaced_translation_keeps_old_note_and_disables_old_coordinates(self):
        old = self.note("translation", "中文译文")
        self.save(old)
        self.manifest["assets"]["translation"].update(id="translation-v2", version=2)
        write_json_atomic(self.root / "manifest.json", self.manifest)
        stale = self.service.state(self.ws)["reader"]["notes"][old["id"]]
        self.assertEqual(stale["pdf_status"], "stale")
        self.assertEqual(stale["body"], "saved")
        self.assertEqual(stale["pdf"], old["pdf"])
        with self.assertRaises(ValueError): self.service.preview(self.ws, {"text": "Question", "refs": [old]})
        with self.assertRaises(ValueError): self.save(old)

    def test_file_tampering_stops_old_coordinates(self):
        (self.root / "assets/source.pdf").write_bytes(b"%PDF-changed")
        with self.assertRaises(ValueError): self.service.reference(self.ws, self.ref())

    def test_mixed_preview_preserves_selected_quotes_without_answer(self):
        refs = [self.ref(), self.ref("translation", "中文译文")]
        result = self.service.preview(self.ws, {"text": "Compare", "refs": refs})
        self.assertEqual([r["quote"] for r in result["refs"]], ["Original text", "中文译文"])
        self.assertEqual([r["pdf"] for r in result["refs"]], [r["pdf"] for r in refs])
        self.assertFalse(result["model_called"])
        self.assertNotIn("answer", result)
        self.assertEqual(read_json(self.root / "context-previews.json")[0], result)

    def test_duplicate_save_and_soft_delete_preserve_identity(self):
        note = self.note(); self.save(note); self.save(note)
        self.assertEqual(len(self.ws.load("reader")["notes"]), 1)
        self.service.apply(self.ws, {"ops": [{"op": "note_del", "id": note["id"], "at": "2026-10-13T11:00:00Z"}]})
        stored = self.ws.load("reader")["notes"][note["id"]]
        self.assertTrue(stored["deleted"])
        self.assertEqual(stored["pdf"], note["pdf"])

    def test_progress_saves_both_views_and_rejects_wrong_asset(self):
        panes = {side: dict(asset_id=asset["id"], version=1, sha256=asset["sha256"], pageIndex=1, scale="page-width", top=20, left=0) for side, asset in self.manifest["assets"].items()}
        progress = {"schema": 1, "document_id": self.ws.id, "active": "translation", "sync": False, "panes": panes}
        op = {"op": "progress", "at": "2026-10-13T10:00:00Z", "dual_pdf": progress}
        self.service.apply(self.ws, {"ops": [op]})
        self.assertEqual(self.ws.load("reader")["progress"]["dual_pdf"], progress)
        panes["source"]["sha256"] = "other"
        with self.assertRaises(ValueError): self.service.apply(self.ws, {"ops": [op]})

    def test_native_numeric_zoom_strings(self):
        for value in ["page-width", "page-fit", "auto", 90, 120, "90", "120"]:
            self.assertTrue(pdf_dual.valid_scale(value))
        for value in [True, "NaN", "Infinity", "wrong", "0", 0.9, -1, 2001, None, {}]:
            self.assertFalse(pdf_dual.valid_scale(value))

    def test_model_and_translation_endpoints_are_blocked(self):
        class Handler:
            def _json(self, code, data): return code, data
        for action in ["chat", "translate", "import", "answer", "selection-translation", "chat-images", "chat/models"]:
            status, body = self.service.post(Handler(), f"{pdf_dual.PREFIX}{self.ws.id}/{action}", {})
            self.assertEqual(status, 403)

    def test_production_library_is_untouched(self):
        (self.home / "library").mkdir()
        protected = self.home / "library/reader.json"; protected.write_text("unchanged")
        self.save(self.note())
        self.assertEqual(protected.read_text(), "unchanged")
        self.assertFalse((self.home / "library/dual-test").exists())
        with self.assertRaises(ValueError): self.service.workspace("../library")

    def test_experiment_dispatch_delegates_all_normal_routes(self):
        class OriginalHandler:
            def _get(self): return "normal-get"
            def _post(self): return "normal-post"
            def _body(self, limit): return b"{}"
            def _json(self, code, body): return code, body
        server = SimpleNamespace(Handler=OriginalHandler)
        with patch.object(pdf_dual.config, "HOME", self.home): pdf_dual.install(server)
        installed = server.Handler
        pdf_dual.install(server)
        self.assertIs(server.Handler, installed)
        handler = installed()
        for path in ["/", "/read/existing?source=pdf", "/api/p/existing/ops", "/api/library"]:
            handler.path = path
            self.assertEqual(handler._get(), "normal-get")
            self.assertEqual(handler._post(), "normal-post")
        handler.path = pdf_dual.PREFIX + self.ws.id + "/status"
        status, body = handler._get()
        self.assertEqual(status, 200)
        self.assertFalse(body["model_calls_permitted"])
        handler.path = pdf_dual.PREFIX + self.ws.id + "/chat"
        self.assertEqual(handler._post()[0], 403)


if __name__ == "__main__": unittest.main()
