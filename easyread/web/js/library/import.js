/* 导入：对话框（选文件 / 链接）+ 把 PDF 拖进窗口任何地方 + 在页面上直接粘贴链接。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  const dlg = PR.$("#importDlg");
  const SCOPES = [["all", "全文"], ["body", "正文（到参考文献为止）"], ["first", "前几页"]];

  const pref = () => Object.assign({ auto: true, scope: "all", first: 10, sourceMode: "arxiv_html", webScope: "abstract" }, PR.ls.get("easyread-import", {}));
  const savePref = (p) => PR.ls.set("easyread-import", Object.assign(pref(), p));

  PR.openImport = function (ref) {
    // The file input must belong to the active modal. An inert input elsewhere
    // in the page cannot open the real Windows picker through a keyboard click.
    const fileInput = PR.$('#fileInput'); fileInput.remove();
    const p = pref();
    if (L.pdfDefault || PR.account) { p.auto = false; p.sourceMode = "pdf"; }
    const off = PR.account || L.engine === "none";
    dlg.querySelector(".dialog").innerHTML =
      "<h2>导入论文</h2>" +
      '<button type="button" class="dropzone" id="pick">' + PR.icon("upload") + '<div class="big">选择 PDF，或拖到这里</div><div class="hint">可以一次选多个；同一个文件不会重复导入</div></button>' +
      '<div class="or">或者</div>' +
      '<label class="field"><span>链接、arXiv 编号、DOI 或论文标题</span><div class="inline"><input class="input" id="arxivRef" placeholder="2411.00640 · 10.18653/v1/N19-1423 · 论文网页链接 · 论文标题">' +
      '<button class="btn accent" id="arxivGo">导入</button></div></label>' +
      '<label class="field"><span>阅读方式</span><select class="input" id="sourceMode"><option value="arxiv_html"' + (p.sourceMode === "arxiv_html" ? ' selected' : '') + '>优先网页双语（本地 PDF 自动匹配 arXiv）</option><option value="pdf"' + (p.sourceMode === "pdf" ? ' selected' : '') + '>仅 PDF 阅读</option></select><span class="hint">本地 PDF 校验一致后使用对应版本网页；未确认或无网页时保留 PDF。原文件一直保留。</span></label>' +
      '<div class="imp-opts"><label class="check"><input type="checkbox" id="autoTr"' + (p.auto && !off ? " checked" : "") + (off ? " disabled" : "") + ">导入后翻译</label>" +
      '<div class="seg" id="scopeSeg">' + SCOPES.map(([k, l]) => '<button data-scope="' + k + '" class="' + (p.scope === k ? "on" : "") + '">' + l + "</button>").join("") + "</div>" +
      '<span class="first-n"' + (p.scope === "first" ? "" : " hidden") + '><input class="input" id="firstN" type="number" min="1" value="' + p.first + '"> 页</span>' +
      '<select class="input" id="webScope" hidden>' + [['abstract','先译摘要'],['first:10','前 10 段'],['all','全文']].map(([v,l]) => '<option value="' + v + '"' + (p.webScope === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>' +
      '<p class="hint" style="margin-top:8px">用 ' + PR.esc(L.engineLabel || "（未设置）") + ' 翻译 · <button class="linkish" id="impEngine">换引擎</button>。长论文可以先译正文，附录之后在详情里点“继续翻译”。</p>' +
      '<div class="actions"><button class="btn" id="impClose">关闭</button></div>';
    dlg.querySelector('.dialog').appendChild(fileInput); fileInput.inert = false;
    if (PR.account) {
      PR.$("#autoTr").closest("label").innerHTML = "导入仅保存与本地解析；翻译请入库后主动发起并确认发送范围。";
      PR.$("#impEngine").closest("p").hidden = true;
    }
    dlg.classList.add("open");
    setTimeout(() => { const i = PR.$("#arxivRef"); if (ref) i.value = ref; updateMode(); i.focus(); }, 50);
  };
  const close = () => dlg.classList.remove("open");
  function webMode() {
    const ref = (PR.$("#arxivRef").value || "").trim();
    return PR.$("#sourceMode").value === "arxiv_html" && /^(?:arxiv:)?\s*\d{4}\.\d{4,5}(?:v\d+)?$|^https?:\/\/(?:www\.|export\.)?arxiv\.org\//i.test(ref);
  }
  function updateMode() {
    const web = webMode() || (!PR.$("#arxivRef").value.trim() && PR.$("#sourceMode").value === "arxiv_html");
    PR.$("#webScope").hidden = !!PR.account || !web;
    PR.$("#scopeSeg").hidden = !!PR.account || web;
    PR.$(".first-n", dlg).hidden = !!PR.account || web || pref().scope !== "first";
  }
  function opts() {
    const p = pref();
    const c = PR.$("#autoTr");
    const auto = !PR.account && (c ? c.checked : !L.pdfDefault && p.auto && L.engine !== "none");
    const scope = p.scope === "first" ? "first:" + Math.max(1, +p.first || 10) : p.scope;
    const mode = PR.$("#sourceMode");
    return { translate: auto, scope, preferHtml: (mode ? mode.value : L.pdfDefault ? "pdf" : p.sourceMode) === "arxiv_html", webScope: p.webScope };
  }

  dlg.addEventListener("click", (e) => {
    if (e.target === dlg || e.target.closest("#impClose")) close();
    if (e.target.closest("#pick")) PR.$("#fileInput").click();
    if (e.target.closest("#arxivGo")) importRef(PR.$("#arxivRef").value);
    if (e.target.closest("#impEngine")) { close(); PR.openSettings(); }
    const s = e.target.closest("[data-scope]");
    if (s) {
      savePref({ scope: s.dataset.scope });
      PR.$$("[data-scope]", dlg).forEach((b) => b.classList.toggle("on", b === s));
      PR.$(".first-n", dlg).hidden = s.dataset.scope !== "first";
    }
  });
  dlg.addEventListener("change", (e) => {
    if (e.target.id === "autoTr") savePref({ auto: e.target.checked });
    if (e.target.id === "firstN") savePref({ first: +e.target.value || 10 });
    if (e.target.id === "sourceMode") { savePref({ sourceMode: e.target.value }); updateMode(); }
    if (e.target.id === "webScope") savePref({ webScope: e.target.value });
  });
  dlg.addEventListener("input", (e) => { if (e.target.id === "arxivRef") updateMode(); });
  dlg.addEventListener("keydown", (e) => { if (e.target.id === "arxivRef" && e.key === "Enter") importRef(e.target.value); if (e.key === "Escape") close(); });
  PR.$("#importBtn").onclick = () => PR.openImport();
  PR.$("#fileInput").addEventListener("change", (e) => { importFiles(Array.from(e.target.files)); e.target.value = ""; });

  async function importFiles(files) {
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!pdfs.length) return PR.toast("只支持 PDF 文件");
    close();
    const o = opts();
    let last = null;
    let successful = 0;
    for (const [k, f] of pdfs.entries()) {
      PR.toast("正在导入 " + (k + 1) + "/" + pdfs.length + "：" + PR.esc(f.name), null, 60000);
      try {
        if (PR.account && f.size > 20000000) throw Error("PDF上限为20,000,000字节");
        const r = await PR.api("/api/import?translate=" + (o.translate ? 1 : 0) + "&scope=" + encodeURIComponent(o.scope) + "&name=" + encodeURIComponent(f.name) + "&prefer_html=" + (o.preferHtml ? 1 : 0) + "&web_scope=" + encodeURIComponent(o.webScope), { method: "POST", body: f });
        last = r.id;
        successful++;
        if (!r.new) PR.toast("《" + PR.esc(f.name) + "》已经在库里了");
      } catch (e) { PR.toast("导入失败：" + PR.esc(e.message)); }
    }
    await L.load();
    if (last) { L.select(last); PR.toast((PR.account ? "已处理 " + successful + " 份PDF；重复文件复用原记录，本地解析状态单独显示" : "已导入 " + pdfs.length + " 篇" + (o.preferHtml ? "，后台匹配 arXiv 网页" : o.translate ? "，后台开始翻译" : "")), { label: "打开", fn: () => L.openReader(last) }, 6000); }
  }

  async function importRef(ref) {
    ref = (ref || "").trim();
    if (!ref) return;
    const btn = PR.$("#arxivGo");
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 查找中'; }
    else PR.toast('<span class="spin"></span> 正在查找并下载 ' + PR.esc(ref), null, 60000);
    const o = opts();
    try {
      const web = webMode();
      const r = await PR.api("/api/import-url", { method: "POST", body: { ref, translate: o.translate, scope: web ? PR.$("#webScope").value : o.scope, mode: web ? "arxiv_html" : "pdf" } });
      close();
      await L.load();
      L.select(r.id);
      PR.toast(r.new ? "已导入" + (o.translate ? "，后台开始翻译" : "") : "这篇已经在库里了", { label: "打开", fn: () => L.openReader(r.id) }, 6000);
    } catch (e) {
      PR.toast("导入失败：" + PR.esc(e.message), null, 8000);
      if (btn) { btn.disabled = false; btn.textContent = "导入"; }
    }
  }
  PR.importRef = importRef;

  /* 在文献库页面直接 Ctrl+V 一个链接或 arXiv 编号 */
  document.addEventListener("paste", (e) => {
    if (e.target.closest("input, textarea, [contenteditable]") || PR.$(".dialog-backdrop.open")) return;
    const files = Array.from(e.clipboardData.files || []);
    if (files.length) { e.preventDefault(); return importFiles(files); }
    const t = (e.clipboardData.getData("text") || "").trim();
    if (/^(https?:\/\/\S+|(arxiv:)?\d{4}\.\d{4,5}(v\d+)?|(doi:\s*)?10\.\d{4,9}\/\S+)$/i.test(t)) { e.preventDefault(); PR.openImport(t); }
  });

  /* 拖进窗口任何地方都能导入 */
  let depth = 0;
  const overlay = PR.$("#dropOverlay");
  const hasFiles = (e) => Array.from(e.dataTransfer && e.dataTransfer.types || []).includes("Files");
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; depth++; overlay.classList.add("on"); });
  window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) overlay.classList.remove("on"); });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; overlay.classList.remove("on");
    importFiles(Array.from(e.dataTransfer.files));
  });
})(window.PR);
