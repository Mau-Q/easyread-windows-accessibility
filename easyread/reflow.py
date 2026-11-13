"""Opt-in PDF reflow: only explicitly verified caches; never translate or mutate a paper."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
from . import config, chat

FILES = {'pack': 'doremi.sdt', 'structure': 'structure.json', 'mapping': 'full-mapping.json',
         'math': 'english-math-evidence.json', 'manifest': 'build-manifest.json'}
SUPPORTED_SOURCE = '6bf62c211048c07b786a2d9146e6ffaf38ef8af744eebdbe5281cdaf827227b4'
RUNTIME_FILES = ('reflow.py', 'server.py', 'store.py', 'pdf_pipeline.py', 'pdf_review.py', 'pdf_render.py', 'pdf_render_check.cjs', 'reflow_prepare.py', 'web/reflow-reader.html', 'web/css/pdf-web-reader.css',
                 'web/js/reflow/app.js', 'web/js/reflow/bootstrap.js', 'web/js/reflow/outbox.js',
                 'web/js/reflow/full-adapter.js', 'web/js/reflow/source-display.js',
                 'web/js/reflow/pdf-selection.js', 'web/js/reader/selection-translation.js',
                 'web/css/selection-translation.css', 'web/js/common/settings-selection.js',
                 'web/js/reflow/panel-bridge.js', 'web/js/reader/margin.js', 'web/js/reader/notespanel.js',
                 'web/js/reader/chat.js', 'web/js/reader/export.js', 'web/js/common/confirm.js', 'web/js/common/features.js',
                 'web/css/base.css', 'web/css/reader.css', 'web/css/reader-panels.css', 'web/css/reader-chat.css',
                 'web/css/arxiv-reader.css', 'web/css/arxiv-article.css',
                 'web/js/reflow/english-math.js', 'web/js/reflow/visuals.js',
                 'web/js/common/markup.js', 'web/js/common/reader-theme.js',
                 'web/vendor/zotero/reader.js', 'web/vendor/zotero/reader.css',
                 'web/vendor/zotero/reader.html', 'web/vendor/zotero/pdf/web/viewer.mjs')


def runtime_identity():
    """Bind adoption to the tested adapter and renderer, not just a PDF hash."""
    from .database import request_cached
    return request_cached(('reflow-runtime',str(Path(__file__).parent)),_runtime_identity)


def _runtime_identity():
    package = Path(__file__).parent
    names=set(RUNTIME_FILES) | {'web/js/common/util.js', 'web/css/reader-theme.css'}
    for directory in ('web/vendor/zotero', 'web/vendor/katex'):
        names.update(str(p.relative_to(package)) for p in (package / directory).rglob('*') if p.is_file())
    return {name: hashlib.sha256((package / name).read_bytes()).hexdigest() for name in sorted(names)}


def renderer_revision():
    return hashlib.sha256(json.dumps(runtime_identity(), sort_keys=True).encode()).hexdigest()


def default_ready(ws, cache=None):
    """Only a separately accepted, identity-matched document may become default."""
    try:
        registry = json.loads((config.HOME / '.pdf-reflow' / 'adoptions.json').read_text())
        if registry.get('schema') != 1 or registry.get('runtime') != runtime_identity():
            return False
        root, digest = cache or verified(ws)
        accepted = registry.get('documents', {}).get(digest, {})
        return (accepted.get('status') == 'accepted'
                and accepted.get('paper_sha256') == hashlib.sha256(ws.paper_path.read_bytes()).hexdigest()
                and accepted.get('cache_proof_sha256') == hashlib.sha256((root / 'cache-proof.json').read_bytes()).hexdigest()
                and accepted.get('desktop_app') == 'EasyRead')
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def verified(ws):
    source = ws.root / 'source.pdf'
    if not source.is_file():
        raise ValueError('这篇文献没有本地 PDF，请使用原阅读入口。')
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    root = config.HOME / '.pdf-reflow' / digest
    paper_digest = hashlib.sha256(ws.paper_path.read_bytes()).hexdigest()
    versioned = root / paper_digest
    if (versioned / 'cache-proof.json').is_file():
        root = versioned
    proof_path = root / 'cache-proof.json'
    if not proof_path.is_file():
        raise ValueError('这篇 PDF 尚无经过验证的重排缓存。原 PDF 和原阅读入口仍可使用；没有开始解析或翻译。')
    proof = json.loads(proof_path.read_text())
    if proof.get('source_sha256') != digest or proof.get('paper_sha256') != paper_digest:
        raise ValueError('原文或译文版本与已验证缓存不同，请使用原阅读入口。')
    resources = proof.get('resources', FILES)
    if resources != FILES:
        from .reflow_prepare import FILES as generic_files
        if proof.get('schema') != 2 or resources != generic_files or proof.get('quality') != 'preview':
            raise ValueError('未知缓存格式，请使用原阅读入口。')
    elif digest != SUPPORTED_SOURCE:
        raise ValueError('这篇 PDF 尚无经过验证的重排缓存，请使用原阅读入口。')
    for name in resources.values():
        p = root / name
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != proof.get('files', {}).get(name):
            raise ValueError('重排缓存校验失败，请使用原阅读入口。')
    return root, digest


def state(ws):
    root, digest = verified(ws)
    proof = json.loads((root / 'cache-proof.json').read_text())
    resources = proof.get('resources', FILES)
    from . import pdf_pipeline
    accepted = default_ready(ws, (root, digest)) or pdf_pipeline.ready(ws)
    return {'id': ws.id, 'paper': ws.load('paper'), 'reader': ws.load('reader'),
            'source_sha256': digest, 'renderer_revision': renderer_revision(), 'manifest': json.loads((root / resources['manifest']).read_text()),
            'capabilities': {'verified_cache': accepted or proof.get('quality') != 'preview', 'preview': proof.get('quality') == 'preview' and not accepted, 'default_ready': accepted, 'word_alignment': False, 'auto_analysis': False}}


def file(ws, name):
    root, _ = verified(ws)
    resources = json.loads((root / 'cache-proof.json').read_text()).get('resources', FILES)
    if name not in resources:
        raise ValueError('未知重排资源')
    return root / resources[name]


def context(ws, body):
    _, digest = verified(ws)
    if body.get('source_sha256') != digest:
        raise ValueError('引用来源不匹配')
    allowed = {b.get('id') for b in ws.load('paper').get('blocks', [])}
    values = body.get('refs')
    if not isinstance(values, list):
        raise ValueError('引用格式错误')
    refs = [{'anchor': str(r.get('anchor', '')), 'quote': str(r.get('quote', ''))[:1000]}
            for r in values[:12] if isinstance(r, dict)]
    if not refs or any(r['anchor'] not in allowed for r in refs):
        raise ValueError('该选区没有已确认的原段落映射，请返回原 PDF 核对。')
    return {'source_sha256': digest, 'refs': refs,
            'context': chat._context(ws, refs[0]['anchor'], refs[0]['quote'], refs),
            'model_called': False}
