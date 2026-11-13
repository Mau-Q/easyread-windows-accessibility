import copy
import io
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from pypdf import PdfWriter
from easyread import config, pdf_reader, reflow
from easyread.library import Library
from easyread.store import write_json_atomic

class PerformanceTest(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.home=Path(tmp.name);self.lib=Library(self.home/'library')
        self.home_patch=patch.object(config,'HOME',self.home);self.home_patch.start();self.addCleanup(self.home_patch.stop)
        out=io.BytesIO();w=PdfWriter();w.add_blank_page(width=600,height=800);w.write(out)
        self.ws,_=self.lib.create_from_pdf(out.getvalue(),'fixture.pdf')
        self.service=pdf_reader.Service(self.home,self.lib,self.home/'HJFY')
        self.handler=SimpleNamespace(_json=lambda code,body:(code,body),app=SimpleNamespace(token='fixture'))

    def test_warm_list_reuses_summaries_and_returned_data_is_independent(self):
        with patch.object(self.lib,'_list_uncached',wraps=self.lib._list_uncached) as build:
            before=self.lib.list();before[0]['title_en']='caller mutation'
            after=self.lib.list();self.assertNotEqual(after[0]['title_en'],'caller mutation');self.assertEqual(build.call_count,1)

    def test_atomic_external_update_with_same_mtime_invalidates_list(self):
        first=self.lib.list();p=self.ws.item_path;stamp=p.stat().st_mtime_ns
        self.ws.patch_item({'starred':True});os.utime(p,ns=(stamp,stamp))
        self.assertFalse(first[0]['starred']);self.assertTrue(self.lib.list()[0]['starred'])
        write_json_atomic(self.ws.reader_path,{'notes':{'n':{'id':'n','kind':'note'}},'progress':{'ratio':.5}})
        updated=self.lib.list()[0];self.assertEqual(updated['notes'],1);self.assertEqual(updated['progress'],.5)

    def test_runtime_and_readiness_evidence_changes_invalidate_cached_summary(self):
        self.lib.list()
        with patch.object(self.lib,'_list_uncached',wraps=self.lib._list_uncached) as build:
            folder=self.home/'.pdf-reflow';folder.mkdir();(folder/'adoptions.json').write_text('{}')
            self.lib.list();self.assertEqual(build.call_count,1)
            (folder/'adoptions.json').unlink();self.lib.list();self.assertEqual(build.call_count,2)

    def test_status_before_open_does_not_create_workspace_or_extract(self):
        with patch.object(self.service,'workspace',side_effect=AssertionError('prepared')),patch.object(self.service,'translations',side_effect=AssertionError('scanned')):
            code,body=self.service.get(self.handler,pdf_reader.API+self.ws.id+'/translation')
        self.assertEqual(code,200);self.assertEqual(body['task']['state'],'idle')
        self.assertFalse((self.service.root/self.service.file_hash(self.ws.root/'source.pdf')).exists())

    def test_reader_and_progress_use_existing_workspace_and_preserve_notes(self):
        state=self.service.state_for(self.ws.id);runtime=self.service.workspace(self.ws.id)
        with patch.object(self.service,'workspace',side_effect=AssertionError('prepared')),patch.object(self.service,'translations',side_effect=AssertionError('scanned')),patch.object(self.service,'legacy',side_effect=AssertionError('legacy scanned')):
            code,data=self.service.get(self.handler,pdf_reader.API+self.ws.id+'/part/reader')
            self.assertEqual(data['data'],state['reader'])
            asset=state['assets']['source'];op={'op':'progress','at':'2026-10-13T23:00:00Z','block':'source-p1','ratio':.3,'dual_pdf':{'schema':1,'document_id':runtime.id,'active':'source','sync':False,'panes':{'source':{'asset_id':asset['id'],'version':asset['version'],'sha256':asset['sha256'],'pageIndex':0,'scale':'page-width','top':0,'left':0}}}}
            code,result=self.service.post(self.handler,pdf_reader.API+self.ws.id+'/ops',{'ops':[op]})
        self.assertEqual(result['progress']['ratio'],.3);self.assertEqual(runtime.load('reader')['notes'],state['reader']['notes'])
        invalid=copy.deepcopy(op);invalid['dual_pdf']['panes']['source']['sha256']='bad'
        with self.assertRaises(ValueError):self.service.post(self.handler,pdf_reader.API+self.ws.id+'/ops',{'ops':[invalid]})

    def test_changed_source_cannot_reuse_old_manifest(self):
        old=self.service.workspace(self.ws.id);(self.ws.root/'source.pdf').write_bytes((self.ws.root/'source.pdf').read_bytes()+b'\nchanged')
        self.assertNotEqual(self.service.existing_workspace(self.ws.id).id,old.id)
