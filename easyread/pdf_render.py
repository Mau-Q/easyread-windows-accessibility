"""Observe the real reader and repair supported content faults before adoption."""
import json
import shutil
import subprocess
import os
from pathlib import Path
from . import config, reflow, reflow_prepare, pdf_review, engines
from .store import write_json_atomic


def binding(ws):
    cache,_=reflow.verified(ws)
    return {"paper_sha256":reflow_prepare.digest(ws.paper_path),
            "cache_proof_sha256":reflow_prepare.digest(cache/'cache-proof.json'),"runtime":reflow.runtime_identity()}


def valid(ws):
    try:
        result=json.loads((ws.root/'pdf-render.json').read_text())
        return result.get('complete') is True and result.get('binding')==binding(ws)
    except (OSError,ValueError,KeyError):return False


def check(ws,cfg,cancel,report):
    if valid(ws):return json.loads((ws.root/'pdf-render.json').read_text())
    folder=ws.root/'render-review';folder.mkdir(exist_ok=True)
    try:
        info=json.loads(config.SERVER_INFO.read_text())
        modules=Path(cfg.get('pdf_render_node_modules') or config.HOME/'runtime/node_modules')
        if not (modules/'playwright').is_dir():raise ValueError('实际阅读页检查组件尚未就绪，保留候选入口')
        report(0,1,'正在检查实际阅读页：译文、公式与原图')
        out=folder/'observation.json'
        cache,_=reflow.verified(ws)
        proof=json.loads((cache/'cache-proof.json').read_text())
        structure=json.loads((cache/proof.get('resources',reflow.FILES)['structure']).read_text())
        required=[{'ref':i,'has_coordinates':bool(n.get('anchor',{}).get('pageRects'))} for i,n in enumerate(structure['content']) if n.get('type') in ('image','figure','table','math','equation')]
        required_path=folder/'required-visuals.json';write_json_atomic(required_path,required)
        args=[shutil.which('node') or 'node',str(Path(__file__).with_name('pdf_render_check.cjs')),str(modules),info['url']+'/read/'+ws.id+'?mode=reflow&verification=1',str(out),str(required_path)]
        with (folder/'check.log').open('w') as log:
            env=os.environ.copy()
            browsers=Path(cfg.get('pdf_render_browser_root') or config.HOME/'runtime/browsers')
            if browsers.is_dir():env['PLAYWRIGHT_BROWSERS_PATH']=str(browsers)
            process=subprocess.Popen(args,stdout=log,stderr=log,env=env)
            try:
                while process.poll() is None:
                    if cancel.is_set():raise engines.Cancelled()
                    try:process.wait(timeout=.25)
                    except subprocess.TimeoutExpired:pass
            finally:
                if process.poll() is None:process.kill();process.wait()
        if process.returncode:raise ValueError('实际阅读页检查未完成，诊断记录已保留')
        result=json.loads(out.read_text())
        result['binding']=binding(ws)
        result['repairable_math_ids']=[m['id'] for m in result.get('failed',[]) if m.get('math_errors')]
        result['repairable_visual_refs']=sorted({int(img['ref']) for img in result.get('images',[]) if (not img['complete'] or not img['width']) and str(img.get('ref','')).isdigit()}|{n['ref'] for n in result.get('missing_visuals',[]) if n['has_coordinates']})
    except engines.Cancelled:raise
    except Exception as error:result={'complete':False,'error':str(error)}
    write_json_atomic(ws.root/'pdf-render.json',result)
    return result
