import copy
import io
import os
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
from easyread import pdf_reader
from easyread.library import Library
from easyread.store import empty_reader, write_json_atomic


def pdf(path, pages=1):
    writer = PdfWriter()
    for _ in range(pages): writer.add_blank_page(width=612, height=792)
    with path.open('wb') as file: writer.write(file)


class PDFReaderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.lib = Library(self.home / 'library')
        self.original = self.home / 'input.pdf'; pdf(self.original, 2)
        self.ws, _ = self.lib.create_from_pdf(self.original.read_bytes(), 'input.pdf')
        self.hjfy = self.home / 'HJFY'
        self.service = pdf_reader.Service(self.home, self.lib, self.hjfy)

    def output(self, name, pages, original=None):
        folder = self.hjfy / 'Documents' / name
        (folder / 'Runs' / name).mkdir(parents=True)
        (folder / 'original.pdf').write_bytes(original or self.original.read_bytes())
        path = folder / 'Runs' / name / 'translated.zh-Hans.pdf'; pdf(path, pages)
        return path

    def progress(self, state):
        panes = {side: {'asset_id': a['id'], 'version': a['version'], 'sha256': a['sha256'], 'pageIndex': 0, 'scale': 'page-width', 'top': 0, 'left': 0} for side, a in state['assets'].items()}
        return {'op': 'progress', 'at': '2026-10-13T12:00:00Z', 'dual_pdf': {'schema': 1, 'document_id': state['id'], 'active': 'source', 'sync': False, 'panes': panes}}

    def test_original_only_needs_no_translation_or_text_layer(self):
        state = self.service.state_for(self.ws.id)
        self.assertEqual(set(state['assets']), {'source'})
        self.assertEqual(state['assets']['source']['page_count'], 2)
        self.assertTrue(state['translation_pending'])
        self.assertFalse(state['automatic_translation'])
        self.assertEqual(state['paper']['blocks'][0]['en'], '')
        runtime = self.service.workspace(self.ws.id)
        self.service.apply(runtime, {'ops': [self.progress(state)]})
        self.assertEqual(set(runtime.load('reader')['progress']['dual_pdf']['panes']), {'source'})

    def test_page_text_is_extracted_for_real_pdf_selection(self):
        writer = PdfWriter(); page = writer.add_blank_page(width=612, height=792)
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): font})})
        stream = DecodedStreamObject(); stream.set_data(b'BT /F1 16 Tf 70 700 Td (PDF selection text) Tj ET')
        page[NameObject('/Contents')] = writer._add_object(stream)
        path = self.home / 'text.pdf'
        with path.open('wb') as file: writer.write(file)
        workspace, _ = self.lib.create_from_pdf(path.read_bytes(), 'text.pdf')
        state = self.service.state_for(workspace.id)
        self.assertIn('PDF selection text', state['paper']['blocks'][0]['en'])
        asset = state['assets']['source']
        ref = {'anchor':'source-p1', 'quote':'PDF selection text', 'pdf': {'schema':1,'document_id':state['id'],'coordinate_space':'pdf-user-space','side':'source','asset_id':asset['id'],'version':asset['version'],'sha256':asset['sha256'],'pageIndex':0,'positions':[{'pageIndex':0,'rects':[[70,697,210,717]]}]}}
        self.assertTrue(self.service.reference(self.service.workspace(workspace.id), ref)['confirmed'])

    def test_review_status_and_different_page_counts_do_not_exclude_outputs(self):
        path = self.output('run-a', 7)
        write_json_atomic(self.hjfy / 'history.json', [{'output': path.as_uri(), 'finishedAt': 100, 'status': 'review'}])
        state = self.service.state_for(self.ws.id)
        self.assertEqual(state['assets']['translation']['page_count'], 7)
        self.assertEqual(state['assets']['source']['page_count'], 2)

    def test_matching_uses_original_fingerprint_not_filename(self):
        other = self.home / 'other.pdf'; pdf(other, 3)
        self.output('same-name-wrong-content', 4, other.read_bytes())
        self.assertTrue(self.service.state_for(self.ws.id)['translation_pending'])

    def test_multiple_versions_select_and_keep_old_pdf_coordinates(self):
        a = self.output('run-a', 3); b = self.output('run-b', 5)
        write_json_atomic(self.hjfy / 'history.json', [{'output': a.as_uri(), 'finishedAt': 20}, {'output': b.as_uri(), 'finishedAt': 10}])
        state = self.service.state_for(self.ws.id)
        self.assertEqual(state['assets']['translation']['page_count'], 3)
        selected = next(v for v in state['translation_options'] if v['page_count'] == 5)
        runtime = self.service.workspace(self.ws.id)
        a1 = state['assets']['translation']
        note = {'id': 'version-note', 'kind': 'note', 'body': 'old version note', 'anchor': 'translation-p1', 'quote': '', 'native': [],
                'updated': '2026-10-13T12:00:00Z', 'pdf': {'schema': 1, 'document_id': state['id'], 'coordinate_space': 'pdf-user-space', 'side': 'translation', 'asset_id': a1['id'], 'version': a1['version'], 'sha256': a1['sha256'], 'pageIndex': 0, 'positions': []}}
        self.service.apply(runtime, {'ops': [{'op': 'note', 'note': note}]})
        class Handler:
            def _json(self, code, body): return code, body
        code, new = self.service.post(Handler(), pdf_reader.API + self.ws.id + '/select-translation', {'asset_id': selected['id']})
        self.assertEqual(code, 200)
        self.assertEqual(new['assets']['translation']['page_count'], 5)
        old = new['reader']['notes']['version-note']
        self.assertEqual(old['pdf_status'], 'stale')
        self.assertEqual(old['pdf'], note['pdf'])
        self.assertEqual(old['body'], note['body'])
        self.assertEqual(len(self.service.manifest(runtime)['translation_versions']), 2)
        # A second window may still display the immutable old asset.
        note['body'] = 'saved from the other open window'
        note['updated'] = '2026-10-13T12:01:00Z'
        self.service.apply(runtime, {'ops': [{'op': 'note', 'note': note}, self.progress(state)]})
        self.assertEqual(runtime.load('reader')['notes']['version-note']['body'], note['body'])
        class FileHandler:
            headers = {}; command = 'GET'
            def __init__(self): self.wfile = io.BytesIO()
            def send_response(self, code): self.code = code
            def send_header(self, *args): pass
            def end_headers(self): pass
            def _json(self, code, body): return code, body
        handler = FileHandler()
        self.service.get(handler, state['assets']['translation']['url'])
        self.assertEqual(handler.code, 200)
        self.assertEqual(handler.wfile.getvalue(), a.read_bytes())

    def test_aliases_share_notes_by_exact_pdf_content(self):
        other = self.lib.root / 'alias-doc'; other.mkdir()
        (other / 'source.pdf').write_bytes(self.original.read_bytes())
        write_json_atomic(other / 'paper.json', self.ws.load('paper'))
        self.assertEqual(self.service.state_for('alias-doc')['id'], self.service.state_for(self.ws.id)['id'])

    def test_asset_ranges_and_fingerprint_invalidation(self):
        state = self.service.state_for(self.ws.id)
        ws = self.service.workspace(self.ws.id); asset = state['assets']['source']
        path = self.service.asset_file(ws, asset); data = path.read_bytes()
        class Handler:
            command = 'GET'
            def __init__(self, headers): self.headers = headers; self.sent = {}; self.wfile = io.BytesIO()
            def send_response(self, code): self.code = code
            def send_header(self, name, value): self.sent[name] = value
            def end_headers(self): pass
            def _send(self, code, body, content_type, headers): self.code = code; self.sent = headers; self.wfile.write(body)
        for value, expected in [('bytes=0-15', data[:16]), ('bytes=16-', data[16:]), ('bytes=-16', data[-16:])]:
            h = Handler({'Range': value}); self.service.serve_asset(h, ws, asset)
            self.assertEqual(h.code, 206); self.assertEqual(h.wfile.getvalue(), expected)
            self.assertEqual(int(h.sent['Content-Length']), len(expected))
            self.assertIn('Content-Range', h.sent)
        h = Handler({'Range': f'bytes={len(data)}-'}); self.service.serve_asset(h, ws, asset)
        self.assertEqual(h.code, 416); self.assertEqual(h.sent['Content-Range'], f'bytes */{len(data)}')
        h = Handler({'Range': 'bytes=0-15', 'If-Range': '"old"'}); self.service.serve_asset(h, ws, asset)
        self.assertEqual(h.code, 200); self.assertEqual(h.wfile.getvalue(), data)
        h = Handler({'Range': 'bytes=0-15'}); h.command = 'HEAD'; self.service.serve_asset(h, ws, asset)
        self.assertEqual(h.code, 206); self.assertEqual(h.wfile.getvalue(), b'')
        stat = path.stat(); path.write_bytes(b'X' + data[1:]); os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        with self.assertRaisesRegex(ValueError, '指纹已变化'):
            self.service.asset_file(ws, asset)

    def test_unselected_text_is_lazy_and_selection_materializes_it(self):
        a = self.output('run-a', 3); b = self.output('run-b', 5)
        write_json_atomic(self.hjfy / 'history.json', [{'output': a.as_uri(), 'finishedAt': 20}, {'output': b.as_uri(), 'finishedAt': 10}])
        self.service.state_for(self.ws.id); ws = self.service.workspace(self.ws.id)
        versions = self.service.manifest(ws)['translation_versions']
        pending = next(v for v in versions if v.get('text_ready') is False)
        with patch.object(self.service, 'describe', wraps=self.service.describe) as describe:
            self.service.reference(ws, {'anchor': 'translation-p1', 'quote': '', 'pdf': {'schema': 1, 'document_id': ws.id, 'coordinate_space': 'pdf-user-space', 'side': 'translation', 'asset_id': pending['id'], 'version': pending['version'], 'sha256': pending['sha256'], 'pageIndex': 0, 'positions': []}})
            self.assertTrue(describe.called)
        class Handler:
            def _json(self, code, body): return code, body
        code, state = self.service.post(Handler(), pdf_reader.API + self.ws.id + '/select-translation', {'asset_id': pending['id']})
        self.assertEqual(code, 200); self.assertEqual(state['assets']['translation']['page_count'], 5)
        self.assertIsNot(state['assets']['translation'].get('text_ready'), False)

    def test_legacy_notes_are_visible_without_rewriting_any_existing_file(self):
        reader = empty_reader(); reader['notes']['old'] = {'id': 'old', 'body': 'keep old note', 'anchor': 'old-block'}
        reader['paper_note'] = {'body': 'old paper note'}
        write_json_atomic(self.ws.reader_path, reader)
        before = {str(p): p.read_bytes() for p in self.ws.root.rglob('*') if p.is_file()}
        state = self.service.state_for(self.ws.id)
        self.assertEqual(state['legacy_sources'][0]['notes'][0]['body'], 'keep old note')
        self.assertEqual(state['legacy_sources'][0]['paper_note'], 'old paper note')
        self.assertEqual(state['legacy_sources'][0]['href'], '/api/reading-history/' + self.ws.id)
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.ws.root.rglob('*') if p.is_file()})

    def test_history_uses_stored_links_and_never_changes_original_records(self):
        reader = empty_reader(); reader['notes']['old'] = {'id':'old','body':'note'}
        write_json_atomic(self.ws.reader_path, reader)
        write_json_atomic(self.ws.root / 'chat.json', {'threads':[{'id':'chat','messages':[{'role':'user','content':'question'}]}]})
        before = {str(p):p.read_bytes() for p in self.ws.root.rglob('*') if p.is_file()}
        records = self.service.reading_history(self.ws.id)['records']
        record = next(r for r in records if r['id']==self.ws.id)
        self.assertEqual(record['reader']['notes']['old']['body'], 'note')
        self.assertEqual(record['chat']['threads'][0]['messages'][0]['content'], 'question')
        self.assertEqual(before, {str(p):p.read_bytes() for p in self.ws.root.rglob('*') if p.is_file()})
        with self.assertRaises(ValueError): self.service.reading_history('absent')

    def test_new_translation_is_discovered_on_open(self):
        self.assertTrue(self.service.state_for(self.ws.id)['translation_pending'])
        self.output('run-new', 4)
        self.assertFalse(self.service.state_for(self.ws.id)['translation_pending'])

    def test_new_output_does_not_switch_the_open_translation_during_save(self):
        self.output('run-a', 3)
        state = self.service.state_for(self.ws.id)
        before = state['assets']['translation']['id']
        self.output('run-b', 5)
        runtime = self.service.workspace(self.ws.id)
        self.service.apply(runtime, {'ops': [self.progress(state)]})
        reopened = self.service.state_for(self.ws.id)
        self.assertEqual(reopened['assets']['translation']['id'], before)
        self.assertEqual(len(reopened['translation_options']), 2)
        self.assertEqual(runtime.load('reader')['progress']['dual_pdf']['panes']['translation']['asset_id'], before)

    def test_default_is_global_and_can_be_disabled(self):
        self.assertFalse(self.service.enabled())
        self.service.root.mkdir(exist_ok=True)
        write_json_atomic(self.service.root / 'default.json', {'schema': 1, 'enabled': True})
        self.assertTrue(self.service.enabled())
        write_json_atomic(self.service.root / 'default.json', {'schema': 1, 'enabled': False})
        self.assertFalse(self.service.enabled())

    def test_five_backgrounds_persist_without_changing_shared_preferences_or_notes(self):
        prefs = self.home / 'prefs.json'
        write_json_atomic(prefs, {'reader': {'readerTheme': 'sepia'}, 'other': 'preserved'})
        self.assertEqual(self.service.appearance()['readerTheme'], 'sepia')
        self.service.state_for(self.ws.id)
        runtime = self.service.workspace(self.ws.id)
        before = runtime.reader_path.read_bytes(); shared = prefs.read_bytes()
        class Handler:
            def _json(self, code, body): return code, body
        for theme in self.service.THEMES:
            code, response = self.service.post(Handler(), pdf_reader.API + self.ws.id + '/appearance', {'readerTheme': theme})
            self.assertEqual(code, 200); self.assertEqual(response['readerTheme'], theme)
            reopened = pdf_reader.Service(self.home, self.lib, self.hjfy)
            self.assertEqual(reopened.state_for(self.ws.id)['appearance']['readerTheme'], theme)
        with self.assertRaisesRegex(ValueError, '背景不存在'):
            self.service.post(Handler(), pdf_reader.API + self.ws.id + '/appearance', {'readerTheme': 'invalid'})
        self.assertEqual(prefs.read_bytes(), shared); self.assertEqual(runtime.reader_path.read_bytes(), before)

    def test_unimplemented_automatic_actions_remain_blocked(self):
        class Handler:
            def _json(self, code, body): return code, body
        for action in ['translate', 'import', 'selection-translation', 'answer']:
            self.assertEqual(self.service.post(Handler(), pdf_reader.API + self.ws.id + '/' + action, {})[0], 403)

    def test_pen_and_background_partial_updates_preserve_each_other(self):
        class Handler:
            def _json(self, code, body): return code, body
        path = pdf_reader.API + self.ws.id + '/appearance'
        self.service.post(Handler(), path, {'readerTheme': 'sepia'})
        self.service.post(Handler(), path, {'pen': 'underline'})
        self.assertEqual(pdf_reader.Service(self.home, self.lib, self.hjfy).appearance(), {'readerTheme': 'sepia', 'pen': 'underline'})
        self.service.post(Handler(), path, {'readerTheme': 'dark'})
        self.assertEqual(self.service.appearance(), {'readerTheme': 'dark', 'pen': 'underline'})
        for body in [{'pen': 'invalid'}, {}, {'pen': 'marker', 'extra': True}]:
            with self.assertRaises(ValueError): self.service.post(Handler(), path, body)

    def test_router_default_previous_web_and_new_import_without_jobs(self):
        class OriginalHandler:
            def _get(self): return 'old-get'
            def _post(self): raise AssertionError('should not reach automatic jobs')
            def _file(self, path): return Path(path).name
            def _body(self, *args): return self.upload
            def _json(self, code, body): return code, body
        server = SimpleNamespace(Handler=OriginalHandler)
        home_patch = patch.object(pdf_reader.config, 'HOME', self.home)
        home_patch.start(); self.addCleanup(home_patch.stop)
        pdf_reader.install(server)
        handler = server.Handler(); handler._reader_redirect = lambda target: ('redirect', target); handler.app = SimpleNamespace(lib=self.lib)
        handler.path = '/read/' + self.ws.id
        self.assertEqual(handler._get(), 'pdf-reader.html')
        (self.home / '.pdf-reading').mkdir(exist_ok=True)
        write_json_atomic(self.home / '.pdf-reading/default.json', {'schema': 1, 'enabled': True})
        self.assertEqual(handler._get(), 'pdf-reader.html')
        for query in ['mode=previous', 'mode=legacy', 'mode=reflow', 'source=web']:
            handler.path = '/read/' + self.ws.id + '?' + query
            self.assertEqual(handler._get(), ('redirect', '/read/' + self.ws.id))
        handler.path = '/api/import?prefer_html=1'; handler.upload = self.original.read_bytes()
        code, response = handler._post()
        self.assertEqual(code, 200)
        self.assertEqual(response['id'], self.ws.id)


if __name__ == '__main__': unittest.main()
