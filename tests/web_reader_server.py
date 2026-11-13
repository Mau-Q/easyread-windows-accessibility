"""网页阅读端到端测试服务：临时文献库和本机假模型，不调用外部服务。"""
import json
import os
import shutil
import io
import sys
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from easyread import arxivhtml, chat, chat_models, config, sources, selection_translation
from easyread.server import App, Handler
from easyread.store import write_json_atomic
from tests.test_arxiv_html import HTML, URL


def main():
    app = App(config.load())
    html = HTML.replace(b'</article>', b'<h2 class="ltx_title">Methods</h2><p class="ltx_p" id="repeat">Same phrase. Again: Same phrase.</p>'
                        b'<p class="ltx_p" id="selection-test">These parameters minimize validation loss.</p>'
                        b'<p class="ltx_p" id="selection-next">A low loss does not guarantee good generalization.</p>'
                        b'<table class="ltx_tabular"><tr><th>Model</th><th>Score</th></tr><tr><td>A</td><td>95</td></tr></table></article>')
    fixture_id = '2601.00001v1'
    if os.environ.get('EASYREAD_XREF_TEST'):
        extra = '''<p class="ltx_p" id="xref-test">Check
            <a class="ltx_ref" href="#testfigure">Figure 1</a>,
            <a class="ltx_ref" href="#test%2Etable">Table 1</a>,
            <a class="ltx_ref" href="#eq.row">Equation 1</a>,
            <a class="ltx_ref" href="#testfigure.graphic">Figure detail</a>,
            <a class="ltx_ref" href="#farappendix">Appendix A</a>,
            <a class="ltx_ref" href="#absent-figure">Missing figure</a>.
            <a href="https://example.org/#testfigure">External figure link</a>.</p>
            <p class="ltx_p" id="xref-near"><a href="#xref-test">Nearby paragraph</a>.</p>
            <div style="min-height:1600px"></div>
            <figure class="ltx_figure" id="testfigure">
              <svg id="testfigure.graphic" viewBox="0 0 480 160" width="480" height="160" xmlns="http://www.w3.org/2000/svg">
                <defs><clipPath id="figure.clip"><rect width="480" height="160"/></clipPath>
                <g id="figure.shape"><rect x="30" y="30" width="180" height="100" fill="#88b6c5"/></g></defs>
                <g clip-path="url(#figure.clip)"><use href="#figure.shape"/></g>
                <g class="quoted-clip" style="clip-path:url('#figure.clip')"></g>
                <style>.quoted-clip { clip-path:url("#figure.clip"); }</style>
                <text x="245" y="87" fill="#88b6c5">Original figure</text>
              </svg><figcaption class="ltx_caption">Figure 1: Original diagram and its caption.</figcaption></figure>
            <p class="ltx_p" id="after-figure">Continue to <a href="#farappendix">Appendix A</a>.</p>
            <figure class="ltx_table" id="test.table"><figcaption>Table 1: Original scores.</figcaption>
              <table class="ltx_tabular"><tr><th>Model</th><th>Score</th></tr><tr><td>Baseline</td><td>95</td></tr></table></figure>
            <table class="ltx_equationgroup ltx_eqn_table" id="eq.group"><tbody>
              <tr class="ltx_equation ltx_eqn_row" id="eq.row"><td><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi><mo>+</mo><mi>y</mi><mo>=</mo><mn>1</mn></math></td><td>(1)</td></tr>
              <tr class="ltx_equation ltx_eqn_row"><td>Continuation of the derivation.</td><td>(1a)</td></tr>
            </tbody></table>
            <div style="min-height:1600px"></div>
            <section class="ltx_appendix" id="farappendix"><h2 class="ltx_title">Appendix A</h2>
              <p class="ltx_p" id="appendix-body">Distant appendix content. <a href="#xref-test">Return to the introduction</a>.</p></section>'''
        html = html.replace(b'</article>', extra.encode() + b'</article>')
    if os.environ.get('EASYREAD_CITATION_TEST'):
        extra = '''<p class="ltx_p" id="citation-test">Original citations:
            <cite class="ltx_cite">(<a href="#bib.zhou">Zhou et al., 2024</a>;
            <a href="#bib.other">Other et al., 2024</a>)</cite>.
            <cite class="ltx_cite"><a href="#bib%2Enumeric">[3]</a></cite>.
            <cite class="ltx_cite"><a href="#missing-reference">Missing</a></cite>.
            <cite class="ltx_cite"><a href="#a">Not a bibliography entry</a></cite>.
            <a href="#bib.zhou">Ordinary link</a>.</p>
            <p class="ltx_p" id="citation-long"><cite class="ltx_cite"><a href="#bib.long">Long et al., 2024</a></cite>.</p>
            <section class="ltx_bibliography"><ul class="ltx_biblist">
            <li class="ltx_bibitem" id="bib.zhou"><span class="ltx_tag_bibitem">Zhou et al. (2024)</span>
            <span class="ltx_bibblock">Zhou, C., Liu, P., et al.</span>
            <span class="ltx_bibblock"><em id="bib.zhou.title">Lima: Less is more for alignment.</em></span>
            <span class="ltx_bibblock">Advances in Neural Information Processing Systems, 36, 2024.
            <a href="https://example.org/lima">Paper</a> <a href="#a">Abstract in this document</a></span></li>
            <li class="ltx_bibitem" id="bib.other"><span class="ltx_bibblock">Other authors. A second reference. 2024.</span></li>
            <li class="ltx_bibitem" id="bib.numeric"><span class="ltx_bibblock">Numeric reference. 2025.</span></li>
            <li class="ltx_bibitem" id="bib.long"><span class="ltx_bibblock">''' + ('A long reference entry. ' * 250) + '''</span></li>
            </ul></section>'''
        html = html.replace(b'</article>', extra.encode() + b'</article>')
    if os.environ.get('EASYREAD_FOOTNOTE_TEST'):
        def note(label, text):
            return (f'<span class="ltx_note" id="footnote{label}"><sup class="ltx_note_mark">{label}</sup>'
                    f'<span class="ltx_note_outer"><span class="ltx_note_content"><sup class="ltx_note_mark">{label}</sup>'
                    f'<span class="ltx_tag_note">{label}</span>{text}</span></span></span>')
        extra = '<p class="ltx_p" id="footnote-tail">Validation domains' + note('1', 'Equal weights. See <a href="#a">the abstract</a>.') + ':</p>'
        extra += '<p class="ltx_p" id="footnote-url">Dataset4' + note('4', 'https://example.org/data') + ': body 4096.</p>'
        extra += '<p class="ltx_p" id="footnote-middle">Before' + note('2', 'A middle note.') + ' after.</p>'
        html = html.replace(b'</article>', extra.encode() + b'</article>')
    fixture_url = URL.replace('2512.16676v1', fixture_id)
    html = html.replace(b'2512.16676v1', fixture_id.encode())
    with patch.object(arxivhtml, "fetch", return_value=(html, fixture_url)):
        ws, _ = app.lib.create_from_arxiv_html(fixture_url)
    ws.update("paper", lambda p: [b.update(zh='| 模型 | 分数 |\n| --- | --- |\n| A | 95 |' if '表格行列' in b['source_text'] else f"中文段落 {b['id']}：提高**准确率**，保留公式 $x_i$。第二句用于笔记。") for b in p["blocks"]])
    if os.environ.get('EASYREAD_FOOTNOTE_TEST'):
        texts = {'footnote-tail': '验证领域11 1 相同权重。见摘要。：',
                 'footnote-url': '数据集444 4 https://example.org/data：正文4096。',
                 'footnote-middle': '前文[FOOTNOTE:2]中间的脚注。[/FOOTNOTE:2]后文。'}
        ws.update('paper', lambda p: [b.update(zh=texts[b['node_id']]) for b in p['blocks'] if b['node_id'] in texts])
    dataflow = os.environ.get("EASYREAD_DATAFLOW_FIXTURE")
    if dataflow:
        dest = app.lib.root / "dataflow-fixture"
        dest.mkdir()
        for name in ("source.html", "article.html", "paper.json"):
            shutil.copy2(Path(dataflow) / name, dest / name)
        if os.environ.get('EASYREAD_FORMAT_TEST'):
            for name in ('reader.json', 'chat.json'):
                if (Path(dataflow) / name).is_file():
                    shutil.copy2(Path(dataflow) / name, dest / name)
    from pypdf import PdfWriter
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.add_metadata({"/Title": "Source title"})
    buf = io.BytesIO()
    writer.write(buf)
    local_pdf = buf.getvalue()
    local_file = app.lib.root / "fixture-import.pdf"
    local_file.write_bytes(local_pdf)
    # 供 PDF 回归使用的最小论文。
    pdf = app.lib.root / "pdf-fixture"
    pdf.mkdir()
    write_json_atomic(pdf / "paper.json", {"meta": {"title_en": "PDF test", "title_zh": "PDF 回归", "pages": [1]}, "blocks": [
        {"id": "p1-1", "type": "para", "page": 1, "en": "PDF original text.", "zh": "PDF 原有阅读功能需要保留。"}]})
    Handler.app = app
    model = {"id": "fixture", "name": "本机测试模型", "label": "本机测试模型", "engine": "openai", "model": "fixture", "ready": True}

    def stream(_cfg, prompt, cwd, _cancel, _seen=None, **_session_options):
        Path(cwd, "last-prompt.txt").write_text(prompt, encoding="utf-8")
        if os.environ.get('EASYREAD_FORMAT_TEST'):
            images = _session_options.get('images', [])
            Path(cwd, 'last-images.json').write_text(json.dumps([str(p) for p in images]))
            answer = ('本机测试回答：\n\n| 名称 | 在哪份数据上计算 | 主要用途 |\n| --- | --- | --- |\n'
                      '| 训练损失 | 训练集 | 更新参数 $\\theta$ |\n'
                      '| 验证损失 | 验证集 | 选择混合比例 $\\mathbf{w}$ |\n'
                      '| 测试损失 | 测试集 | 评估未见数据 |\n\n表格后的说明。')
            for start in range(0, len(answer), 13):
                if _cancel.wait(.025):
                    return
                yield answer[start:start+13]
            return
        yield "本机测试回答：已收到引用和笔记。"

    def selection_stream(_self, request, _cfg, cancel, metrics):
        # 所有浏览器回归的选词都使用本机替身，绝不请求真实模型。
        delay = .4 if "Same phrase" in request["quote"] else .03
        if cancel.wait(delay):
            from easyread.engines import Cancelled
            raise Cancelled()
        yield "测试译文：" + request["quote"]
        metrics.update(model="fixture", reasoning_effort="low")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}", "id": ws.id, "pdf": str(local_file), "arxiv": fixture_id}), flush=True)
    with patch.object(chat_models, "listing", return_value={"models": [model], "default": "fixture"}), \
         patch.object(chat_models, "engine_cfg", return_value=({"engine": "openai"}, model)), \
         patch.object(chat, "stream", side_effect=stream), \
         patch.object(selection_translation.Service, "_codex", new=selection_stream), \
         patch.object(selection_translation.Service, "warm", return_value=None), \
         patch.object(arxivhtml, "fetch", return_value=(html, fixture_url)), \
         patch.object(sources, "_get", return_value=(local_pdf, "application/pdf", fixture_url.replace("html", "pdf"))):
        try:
            server.serve_forever()
        finally:
            server.server_close()


if __name__ == "__main__":
    sys.exit(main())
