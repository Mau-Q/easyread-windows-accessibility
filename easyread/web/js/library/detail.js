/* 文献库右侧详情：元数据编辑、分类、状态、翻译任务、引用、删除。 */
(function (PR) {
  "use strict";
  const L = PR.lib;

  function citeKey(i) {
    const last = (i.authors || "anon").split(",")[0].trim().split(/\s+/).pop().replace(/[^A-Za-z]/g, "").toLowerCase() || "anon";
    const word = (i.title_en || "paper").split(/\s+/).find((w) => w.length > 3) || "paper";
    return last + (i.year || "") + word.replace(/[^A-Za-z]/g, "").toLowerCase();
  }
  PR.cite = function (i, style) {
    const authors = (i.authors || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (style === "bibtex") {
      const arx = (i.arxiv || "").replace(/^arXiv:/i, "").split(/\s/)[0];
      return "@article{" + citeKey(i) + ",\n  title = {" + i.title_en + "},\n  author = {" + authors.join(" and ") + "},\n  year = {" + (i.year || "") + "}" +
        (arx ? ",\n  eprint = {" + arx + "},\n  archivePrefix = {arXiv}" : "") + (i.doi ? ",\n  doi = {" + i.doi + "}" : "") + (i.url ? ",\n  url = {" + i.url + "}" : "") + "\n}";
    }
    if (style === "apa") {
      const apaNames = authors.slice(0, 20).map((a) => { const p = a.split(/\s+/); return p.length > 1 ? p.pop() + ", " + p.map((x) => x[0] + ".").join(" ") : a; });
      const who = apaNames.length > 1 ? apaNames.slice(0, -1).join(", ") + ", & " + apaNames[apaNames.length - 1] : apaNames[0] || "";
      return who + " (" + (i.year || "n.d.") + "). " + i.title_en + ". " + (i.venue || i.arxiv || "") + (i.url ? ". " + i.url : "");
    }
    // GB/T 7714 简式
    const names = authors.slice(0, 3).map((a) => { const p = a.split(/\s+/); return p.length > 1 ? p.pop() + " " + p.map((x) => x[0]).join(" ") : a; });
    return names.join(", ") + (authors.length > 3 ? ", et al" : "") + ". " + i.title_en + "[J/OL]. " + (i.venue || i.arxiv || "") + ", " + (i.year || "") + "." + (i.url ? " " + i.url : "");
  };
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); PR.toast("已复制" + what); }
    catch (e) { PR.toast("复制失败，请手动选中"); }
  }


  function jobHtml(i) {
    if(!PR.account)return originalJobHtml(i);
    const states={pending:'已入库，尚未解析',running:'已入库，正在本地解析',ready:'本地文字解析完成',failed:'本地解析失败',interrupted:'本地解析已中断'};
    const extraction=i.parse_state?'<div class="jobbox"><div>'+PR.esc(states[i.parse_state]||i.parse_state)+'</div>'+(i.parse_error?'<div class="err">'+PR.esc(i.parse_error)+'</div>':'')+'<div class="hint">原PDF与登记分别保留；失败可在阅读报告中重试本地解析。</div></div>':'';
    return extraction+originalJobHtml(i);
  }
  function originalJobHtml(i) {
    if (i.reading_source_kind === "pdf_dual") return '<div class="jobbox"><div>' + (i.has_pdf_translation ? '已有幻觉翻译产物，打开后双栏对照。' : '尚无译文 PDF，可以直接阅读原文。') + '</div><div class="hint">不会自动启动翻译或调用模型。原有笔记可在阅读页查看。</div></div>';
    if (i.reading_source_kind === "pdf_sdt") {
      return '<div class="jobbox"><div>PDF 双语阅读已就绪 · ' + i.done_blocks + '/' + i.blocks + ' 个阅读单元</div></div>';
    }
    const j = i.job || {};
    if (i.reading_source_kind === "arxiv_html") {
      const busy = ["queued", "running"].includes(j.state);
      return '<div class="jobbox"><div>网页原文 · 已译 ' + i.done_blocks + '/' + i.blocks + ' 段</div>' +
        (busy ? '<div>' + PR.esc(j.message || "处理中") + '</div><button class="btn sm" data-d="cancel">取消</button>' :
          (j.error ? '<div class="err">' + PR.esc(j.error) + '</div>' : '') +
          (i.done_blocks < i.blocks ? '<button class="btn sm accent" data-d="read-translate">继续翻译 / 选择范围</button>' : '')) +
        '<div class="hint">英文直接来自保存的 arXiv 网页版本，中文逐段显示在下方。</div></div>';
    }
    const running = ["queued", "running"].includes(j.state);
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    let h = '<div class="jobbox">';
    if (running) {
      h += '<div><span class="spin"></span> ' + PR.esc(j.message || "处理中") + (j.total ? "（" + j.done + "/" + j.total + " 页）" : "") + "</div>" +
        '<div class="bar"><i style="width:' + pct + '%"></i></div><div class="row2"><button class="btn sm line" data-d="cancel">取消</button>' +
        '<button class="btn sm" data-d="read">边译边读</button></div>';
    } else {
      const full = i.pages && i.done_pages >= i.pages;
      h += "<div>译文：" + (i.pages ? i.done_pages + " / " + i.pages + " 页" : "尚未处理") + (full ? " · 全文" : "") + "</div>";
      const failed = Object.keys(j.failed || {}).map(Number).sort((a, b) => a - b);
      if (j.state === "error") h += '<div class="err">上次翻译出错：' + PR.esc(j.error || j.message) + "</div>";
      if (j.state === "partial" && failed.length) h += '<div class="err">第 ' + PR.esc(pageList(failed)) + " 页没译成功：" + PR.esc(j.error || "") + "</div>";
      h += '<div class="row2" style="margin-top:8px">' +
        (j.state === "partial" && failed.length ? '<button class="btn sm accent" data-d="retry-failed">重试这 ' + failed.length + " 页</button>" : "") +
        (!full && !(j.state === "partial" && failed.length) ? '<button class="btn sm accent" data-d="translate">' + (i.done_pages ? "继续翻译剩下的页" : "开始翻译") + "</button>" : "") +
        (!full && j.state === "partial" && failed.length && i.pages - i.done_pages > failed.length ? '<button class="btn sm line" data-d="translate">继续翻译剩下的页</button>' : "") +
        (j.state ? '<button class="btn sm" data-d="log">' + PR.icon("log", "sm") + "翻译记录</button>" : "") + "</div>" +
        (L.engine === "none" ? '<div class="hint" style="margin-top:6px">当前没有开启翻译引擎，去设置里选一个。</div>' : "");
    }
    return h + "</div>";
  }

  function pageList(ns) { // [3,4,5,9] → "3–5、9"
    const out = [];
    ns.forEach((n) => { const r = out[out.length - 1]; if (r && n === r[1] + 1) r[1] = n; else out.push([n, n]); });
    return out.map(([a, b]) => (a === b ? a : a + "–" + b)).join("、");
  }

  PR.renderDetail = function () {
    const box = PR.$("#detail");
    const i = L.byId(L.selected);
    if (!i) { box.innerHTML = ""; return; }
    if (box.contains(document.activeElement) && document.activeElement.matches("[contenteditable], input")) return; // 正在编辑，不打断
    const readLabel = i.progress > 0.02 ? "继续阅读 · " + Math.round(i.progress * 100) + "%" : "开始阅读";
    const status = [["unread", "未读"], ["reading", "在读"], ["done", "已读"]].map(([k, l]) =>
      '<button data-status="' + k + '" class="' + ((i.status || "unread") === k ? "on" : "") + '">' + l + "</button>").join("");
    // 分类：全部分类都列出来，点一下放进 / 拿出
    const cats = L.cats().map((c) => '<button class="catchip' + ((i.tags || []).includes(c) ? " on" : "") + '" data-cattoggle="' + PR.esc(c) + '">' + PR.icon((i.tags || []).includes(c) ? "check" : "folder", "sm") + PR.esc(c) + "</button>").join("");
    box.innerHTML = '<div class="detail-head"><span>论文详情</span><button class="detail-close" data-d="close" title="收起（Esc）">' + PR.icon("x", "sm") + "</button></div>" +
      '<div class="detail-inner">' +
      '<div class="title-en" contenteditable="' + (L.detailEditing ? 'plaintext-only' : 'false') + '" data-meta="title_en" lang="en" spellcheck="false">' + PR.esc(L.detailEditing ? i.title_en || "" : i.title_en || i.title_zh || "（未命名）") + "</div>" +
      ((i.title_zh && i.title_zh !== i.title_en) || L.detailEditing ? '<div class="title-zh" contenteditable="' + (L.detailEditing ? 'plaintext-only' : 'false') + '" data-meta="title_zh" spellcheck="false">' + PR.esc(i.title_zh || "") + "</div>" : "") +
      (i.metadata_warning ? '<p class="hint">'+PR.esc(i.metadata_warning)+'</p>' : '') +
      '<div class="cover"><div class="actions">' +
      '<a class="btn accent" data-d="read" href="/read/' + i.id + '">' + PR.icon("book", "sm") + readLabel + "</a>" +
      '<a class="btn line" href="' + PR.esc(i.source_kind === "arxiv_html" ? i.url : '/p/' + i.id + '/source.pdf') + '" target="_blank" rel="noopener">' + PR.icon("pdf", "sm") + (i.source_kind === "arxiv_html" ? "打开 arXiv 原网页" : "打开原 PDF") + "</a>" +
      '<div class="act-row"><button class="btn line" data-d="cite" title="复制参考文献格式：GB/T 7714、APA、BibTeX">' + PR.icon("copy", "sm") + "复制引用</button>" +
      '<button class="btn icon line" data-d="star" title="星标（S）" style="color:' + (i.starred ? "#c9a24a" : "") + '">' + PR.icon("star", "sm").replace('class="i sm"', 'class="i sm"' + (i.starred ? ' style="fill:currentColor"' : "")) + "</button>" +
      '<button class="btn icon line" data-d="more" title="更多：阅读方式、导出、打开文件夹、回收站">' + PR.icon("more", "sm") + "</button></div></div></div>" +
      '<div class="cats">' + cats + '<input id="catInput" placeholder="＋ 新分类" maxlength="30"></div>' +
      '<div class="seg">' + status + "</div>" +
      '<button class="btn sm line" data-d="edit-meta">' + (L.detailEditing ? "完成编辑" : "编辑信息") + "</button>" +
      '<div class="kv"><span>作者</span><span contenteditable="' + (L.detailEditing ? 'plaintext-only' : 'false') + '" data-meta="authors">' + PR.esc(i.authors) + "</span>" +
      '<span>年份</span><span contenteditable="' + (L.detailEditing ? 'plaintext-only' : 'false') + '" data-meta="year">' + PR.esc(i.year) + "</span>" +
      '<span>出处</span><span contenteditable="' + (L.detailEditing ? 'plaintext-only' : 'false') + '" data-meta="venue">' + PR.esc(i.venue || i.arxiv) + "</span>" +
      '<span>链接</span><span contenteditable="' + (L.detailEditing ? 'plaintext-only' : 'false') + '" data-meta="url">' + PR.esc(i.url) + "</span>" +
      "<span>添加</span><span>" + PR.esc(PR.relTime(i.added)) + (i.last_opened ? "　·　上次打开 " + PR.esc(PR.relTime(i.last_opened)) : "") + "</span></div>" +
      (i.source_kind === 'arxiv_html' ? '' : i.reading_source_kind === 'pdf_sdt' ? '<h4>阅读来源</h4><div class="hint">本地 PDF 双语阅读，原 PDF 保留。</div>' : '<h4>阅读来源</h4><div class="hint">' + PR.esc(i.arxiv_match?.message || '可查找对应的 arXiv 网页，PDF 原文件和批注保留。') + '</div>' +
        (i.read_id !== i.id ? '<a class="linkish" href="' + PR.esc(i.web_url) + '" target="_blank" rel="noopener">对应 arXiv 网页 ↗</a>' :
          '<button class="btn sm" data-d="match-arxiv"' + (["queued", "running"].includes(i.job?.state) ? ' disabled' : '') + '>查找 arXiv 网页</button>' +
          (i.arxiv_match?.state === 'candidate' ? '<div class="hint">候选：' + PR.esc(i.arxiv_match.candidate.title || i.arxiv_match.candidate.arxiv) + ' · ' + PR.esc(i.arxiv_match.candidate.arxiv) + '</div><a class="linkish" href="' + PR.esc(i.arxiv_match.candidate.url) + '" target="_blank" rel="noopener">检查候选网页 ↗</a> <button class="btn sm" data-d="use-web">使用这个候选版本</button>' : ''))) +
      "<h4>翻译</h4>" + jobHtml(i) +
      (i.notes + i.highlights + i.open_questions ? '<p class="mine-line">' + [i.notes && i.notes + " 条笔记", i.highlights && i.highlights + " 处划线", i.open_questions && i.open_questions + " 个问题待回答"].filter(Boolean).join(" · ") + "</p>" : "") +
      (i.abstract ? '<h4>摘要</h4><div class="abstract" id="abs">' + PR.esc(i.abstract.replace(/\$([^$]+)\$/g, "$1")) + '</div><button class="linkish" data-d="abs">展开全文</button>' : "") +
      "</div>";
  };

  async function saveMeta(el) {
    const i = L.byId(L.selected);
    if (!i || !L.detailEditing) return;
    const key = el.dataset.meta, val = el.textContent.trim();
    if ((i[key] || "") === val) return;
    const override = Object.assign({}, { [key]: val });
    await L.patch(i.id, { meta_override: Object.assign({}, i.meta_override || {}, override) });
  }

  const box = PR.$("#detail");
  box.addEventListener("focusout", (e) => { if (e.target.matches("[data-meta]")) saveMeta(e.target); });
  box.addEventListener("keydown", (e) => {
    if (e.target.matches("[data-meta]") && e.key === "Enter") { e.preventDefault(); e.target.blur(); }
    if (e.target.id === "catInput" && e.key === "Enter") { L.addCat(e.target.value, L.selected); e.target.value = ""; }
  });
  box.addEventListener("click", async (e) => {
    const i = L.byId(L.selected);
    if (!i) return;
    const st = e.target.closest("[data-status]");
    if (st) return L.patch(i.id, { status: st.dataset.status });
    const ct = e.target.closest("[data-cattoggle]");
    if (ct) return L.toggleInCat(i.id, ct.dataset.cattoggle);
    const d = e.target.closest("[data-d]");
    if (!d) return;
    const act = d.dataset.d;
    if (act === "edit-meta") { L.detailEditing = !L.detailEditing; PR.renderDetail(); }
    else if (act === "close") L.select(null);
    else if (act === "star") L.patch(i.id, { starred: !i.starred });
    else if (act === "read") L.openReader(i.id);
    else if (act === "read-translate") L.openReader(i.read_id || i.id, true);
    else if (act === "abs") { PR.$("#abs").classList.toggle("open"); d.textContent = PR.$("#abs").classList.contains("open") ? "收起" : "展开全文"; }
    else if (act === "cite") PR.menu(d, [
      { label: "GB/T 7714 · 中文论文、学位论文", icon: "copy", fn: () => copy(PR.cite(i, "gb"), " GB/T 7714 引用") },
      { label: "APA · 英文论文常用", icon: "copy", fn: () => copy(PR.cite(i, "apa"), " APA 引用") },
      { label: "BibTeX · LaTeX / Overleaf、Zotero 导入", icon: "copy", fn: () => copy(PR.cite(i, "bibtex"), " BibTeX") },
      "-",
      { label: "标题 + 链接 · 发给别人", icon: "link", fn: () => copy((i.title_zh ? i.title_zh + "（" + i.title_en + "）" : i.title_en) + "\n" + (i.url || ""), "标题和链接") },
    ]);
    else if (act === "more") PR.rowMenu(i.id, d);
    else if (act === "match-arxiv" || act === "use-web") { await PR.api("/api/p/" + i.id + "/" + act, { method: "POST", body: {} }); PR.toast("后台查找并关联阅读来源"); L.load(); }
    else if (act === "cancel") { await PR.api("/api/p/" + (i.read_id || i.id) + "/cancel", { method: "POST", body: {} }); L.load(); }
    else if (act === "retry-failed") { await PR.api("/api/p/" + i.id + "/translate", { method: "POST", body: { failed: true } }); PR.toast("正在重试"); L.load(); }
    else if (act === "log") { const r = await PR.api("/api/p/" + i.id + "/log"); PR.showText("翻译记录", r.text); }
    else if (act === "translate") { await PR.api("/api/p/" + i.id + "/translate", { method: "POST", body: {} }); PR.toast("已开始翻译"); L.load(); }
  });
  async function retranslateAll(i) {
    if (!(await PR.confirm({ title: "全部重新翻译？", body: "会消耗模型额度。你改过的译文、笔记都保留。", ok: "重新翻译" }))) return;
    await PR.api("/api/p/" + i.id + "/translate", { method: "POST", body: { pages: "1-" + i.pages } });
    PR.toast("已开始重新翻译"); L.load();
  }

  PR.rowMenu = function (id, where) {
    const i = L.byId(id);
    const setStatus = (s) => () => L.patch(id, { status: s });
    PR.menu(where, [
      { label: "打开阅读", icon: "book", kbd: "Enter", fn: () => L.openReader(id) },
      ...(i.source_kind !== "arxiv_html" ? [{label:"PDF 左右对照",icon:"pdf",fn:()=>{location.href="/read/"+encodeURIComponent(id);}}] : []),
      ...(i.web_url ? [{label:"arXiv 网页阅读",icon:"book",fn:()=>{location.href="/read/"+encodeURIComponent(id)+"?source=web";}}] : []),
      { label: i.source_kind === "arxiv_html" ? "打开 arXiv 原网页" : "打开原 PDF", icon: "pdf", fn: () => window.open(i.source_kind === "arxiv_html" ? i.url : "/p/" + id + "/source.pdf") },
      "-",
      { label: i.starred ? "取消星标" : "加星标", icon: "star", kbd: "S", fn: () => L.patch(id, { starred: !i.starred }) },
      { label: L.side.pinned.includes("p:" + id) ? "取消置顶" : "置顶到侧栏", icon: "pin", fn: () => L.togglePin("p:" + id) },
      "-",
      ...L.catMenuItems(id),
      { label: "标为未读", fn: setStatus("unread") }, { label: "标为在读", fn: setStatus("reading") }, { label: "标为已读", fn: setStatus("done") },
      "-",
      { label: "复制 BibTeX", icon: "copy", fn: () => copy(PR.cite(i, "bibtex"), " BibTeX") },
      { label: i.reading_source_kind === "arxiv_html" ? "导出双语 HTML（图片需联网）" : "导出历史阅读记录", icon: "download", fn: () => {
        PR.toast("正在打包…");
        const a = document.createElement("a");
        a.href = i.reading_source_kind === "arxiv_html" ? "/api/p/" + (i.read_id || id) + "/export" : "/api/reading-history/" + encodeURIComponent(id);
        a.download = i.reading_source_kind === "arxiv_html" ? "EasyRead-export.html" : "EasyRead-reading-history.json";
        document.body.appendChild(a); a.click(); a.remove();
      } },
      { label: "打开所在文件夹", icon: "folder", fn: () => PR.api("/api/p/" + id + "/reveal", { method: "POST", body: {} }).catch((e) => PR.toast(PR.esc(e.message))) },

      { label: "翻译记录", icon: "log", fn: async () => { const r = await PR.api("/api/p/" + id + "/log"); PR.showText("翻译记录", r.text); } },
      { label: PR.account ? "永久删除" : "移到回收站", icon: "trash", fn: async () => {
        if(PR.account){
          if(!await PR.confirm({title:"永久删除这篇论文？",body:"删除原PDF、当前论文的报告、问答、笔记和阅读记录，无法撤销。正在处理的论文需要先等待任务结束。",ok:"确认永久删除",danger:true}))return;
          await PR.api("/api/reading/"+id+"/delete",{method:"POST",body:{confirm:true}});L.select(null);await L.load();PR.toast("已永久删除");return;
        }
        if (!(await PR.confirm({ title: "移到回收站？", body: "《" + (i.title_zh || i.title_en) + "》会放进文献库的 .trash 目录，可以找回。", ok: "移到回收站", danger: true }))) return;
        await PR.api("/api/p/" + id + "/delete", { method: "POST", body: {} });
        L.select(null); L.load(); PR.toast("已移到回收站");
      } },
    ]);
  };
})(window.PR);
