"""The experimental reader must fail closed and preserve the workspace."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from easyread import reflow
from easyread.store import Workspace
from easyread.store import apply_ops

class ReflowTest(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);self.home=Path(tmp.name)
        self.ws=Workspace(self.home/'library'/'paper-test');self.ws.root.mkdir(parents=True)
        source=b'fixture pdf';self.digest=hashlib.sha256(source).hexdigest()
        (self.ws.root/'source.pdf').write_bytes(source)
        self.ws.paper_path.write_text(json.dumps({'meta':{'title_en':'fixture'},'blocks':[{'id':'p1-1','type':'para','page':1,'en':'original weights','zh':'原有域权重'}]}))
        (self.ws.root/'reader.json').write_text(json.dumps({'notes':{'old':{'quote':'域权重'}}}))
        self.root=self.home/'.pdf-reflow'/self.digest;self.root.mkdir(parents=True)
        for name in reflow.FILES.values():(self.root/name).write_text('{}')
        proof={'source_sha256':self.digest,'paper_sha256':hashlib.sha256(self.ws.paper_path.read_bytes()).hexdigest(),'files':{name:hashlib.sha256((self.root/name).read_bytes()).hexdigest() for name in reflow.FILES.values()}}
        (self.root/'cache-proof.json').write_text(json.dumps(proof))
        for target,name,value in [(reflow.config,'HOME',self.home),(reflow,'SUPPORTED_SOURCE',self.digest)]:
            p=patch.object(target,name,value);p.start();self.addCleanup(p.stop)

    def test_readonly_state_and_context(self):
        before={p:p.read_bytes() for p in self.ws.root.iterdir()}
        self.assertFalse(reflow.state(self.ws)['capabilities']['auto_analysis'])
        result=reflow.context(self.ws,{'source_sha256':self.digest,'refs':[{'anchor':'p1-1','quote':'weights'}]})
        self.assertFalse(result['model_called']);self.assertIn('原有域权重',result['context']);self.assertIn('weights',result['context'])
        self.assertEqual(before,{p:p.read_bytes() for p in self.ws.root.iterdir()})
    def test_stale_translation_rejected(self):
        self.ws.paper_path.write_text('{}')
        with self.assertRaisesRegex(ValueError,'版本'):reflow.state(self.ws)
    def test_tampered_cache_rejected(self):
        (self.root/'english-math-evidence.json').write_text('changed')
        with self.assertRaisesRegex(ValueError,'校验失败'):reflow.state(self.ws)
    def test_unknown_source_rejected(self):
        (self.ws.root/'source.pdf').write_bytes(b'other pdf')
        with self.assertRaisesRegex(ValueError,'尚无'):reflow.state(self.ws)
    def test_invalid_context_rejected(self):
        for body in [{'source_sha256':'wrong','refs':[]},{'refs':None},{'refs':[{'anchor':'missing'}]},{'refs':[]}]:
            with self.subTest(body=body):
                body.setdefault('source_sha256',self.digest)
                with self.assertRaises(ValueError):reflow.context(self.ws,body)
    def test_resource_whitelist(self):
        with self.assertRaises(ValueError):reflow.file(self.ws,'../../config.json')

    def test_default_requires_separate_identity_matched_desktop_acceptance(self):
        self.assertFalse(reflow.default_ready(self.ws))
        record={'status':'accepted','desktop_app':'EasyRead',
                'paper_sha256':hashlib.sha256(self.ws.paper_path.read_bytes()).hexdigest(),
                'cache_proof_sha256':hashlib.sha256((self.root/'cache-proof.json').read_bytes()).hexdigest()}
        registry={'schema':1,'runtime':reflow.runtime_identity(),'documents':{self.digest:record}}
        path=self.home/'.pdf-reflow/adoptions.json';path.write_text(json.dumps(registry))
        self.assertTrue(reflow.default_ready(self.ws))
        self.assertTrue(reflow.state(self.ws)['capabilities']['default_ready'])
        for key in ['paper_sha256','cache_proof_sha256','desktop_app','status']:
            bad=json.loads(json.dumps(registry));bad['documents'][self.digest][key]='wrong'
            path.write_text(json.dumps(bad));self.assertFalse(reflow.default_ready(self.ws),key)
        bad=json.loads(json.dumps(registry));bad['runtime']['web/js/reflow/app.js']='old'
        path.write_text(json.dumps(bad));self.assertFalse(reflow.default_ready(self.ws))
        path.write_text(json.dumps(registry));(self.root/'full-mapping.json').write_text('tampered')
        self.assertFalse(reflow.default_ready(self.ws))
        path.write_text('{partial');self.assertFalse(reflow.default_ready(self.ws))

    def test_progress_modes_and_legacy_invalidation(self):
        reader={}
        apply_ops(reader,[{'op':'progress','block':'p2-1','ratio':0.4,'offset':-231.5,'at':'2026-01-01',
                           'reflow':{'source_sha256':self.digest,'pageIndex':1,'reading':False}}])
        self.assertFalse(reader['progress']['reflow']['reading'])
        self.assertEqual(reader['progress']['offset'],-231.5)
        apply_ops(reader,[{'op':'progress','block':'p3-1','ratio':0.6,'at':'2026-01-02'}])
        self.assertNotIn('reflow',reader['progress'])
        self.assertNotIn('offset',reader['progress'])
        self.assertEqual(reader['progress']['block'],'p3-1')
        apply_ops(reader,[{'op':'progress','block':'old','at':'2025-01-01'}])
        self.assertEqual(reader['progress']['block'],'p3-1')

    def test_utc_progress_and_notes_after_local_timestamp(self):
        reader={'progress':{'block':'legacy','at':'2026-10-12T18:46:50.032+08:00'},
                'notes':{'n':{'id':'n','body':'old','updated':'2026-10-12T18:46:50.032+08:00'}}}
        apply_ops(reader,[{'op':'progress','block':'p8-2','at':'2026-10-12T10:55:07.931Z'},
                          {'op':'note','note':{'id':'n','body':'new','updated':'2026-10-12T10:55:07.931Z'}}])
        self.assertEqual(reader['progress']['block'],'p8-2')
        self.assertEqual(reader['notes']['n']['body'],'new')
        apply_ops(reader,[{'op':'progress','block':'stale','at':'2026-10-12T18:50:00+08:00'},
                          {'op':'note_del','id':'n','at':'2026-10-12T18:50:00+08:00'}])
        self.assertEqual(reader['progress']['block'],'p8-2')
        self.assertNotIn('deleted',reader['notes']['n'])

    def test_generic_cache_is_preview_only_and_version_bound(self):
        from easyread.reflow_prepare import FILES as generic
        paper_hash=hashlib.sha256(self.ws.paper_path.read_bytes()).hexdigest()
        root=self.root/paper_hash;root.mkdir()
        for name in generic.values():(root/name).write_text('{}')
        proof={'schema':2,'quality':'preview','source_sha256':self.digest,'paper_sha256':paper_hash,
               'resources':generic,'files':{n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in generic.values()}}
        (root/'cache-proof.json').write_text(json.dumps(proof))
        with patch.object(reflow,'SUPPORTED_SOURCE','different'):
            state=reflow.state(self.ws)
            self.assertTrue(state['capabilities']['preview'])
            self.assertFalse(state['capabilities']['default_ready'])
            self.assertEqual(reflow.file(self.ws,'pack').name,'document.sdt')
            (root/'document.sdt').write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError,'校验失败'):reflow.state(self.ws)
