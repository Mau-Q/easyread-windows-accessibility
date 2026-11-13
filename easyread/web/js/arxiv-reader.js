/* 英文 DOM 保持不变：所有译文放入相邻的独立节点。 */
(async function (PR) {
  "use strict";
  const id = location.pathname.split("/").pop();
  const api = "/api/p/" + encodeURIComponent(id);
  const frame = PR.$("#article");
  const S = PR.state;
  let paper, job = {}, showZh = true, doc;
  let renderedVisibility = null;
  function showTranslationTools(show) {
    PR.$("#translationTools").hidden = !show;
    PR.$("#translateBtn").setAttribute("aria-expanded", String(show));
    if(show)PR.readerShell?.show(true);
  }
  const legacyDark = PR.ls.get("easyread-web-dark", null);
  if (!PR.prefs.readerTheme && typeof legacyDark === "boolean") PR.prefs.readerTheme = legacyDark ? "dark" : "sepia";
  function translationHtml(text) {
    const lines = String(text || "").split("\n");
    const cells = (line) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
    const separator = (line) => line.includes("|") && cells(line).every((c) => /^:?-{3,}:?$/.test(c));
    let html = "", prose = [];
    const flush = () => { html += PR.mdBlocks(prose.join("\n"), { cite: false, xref: false }); prose = []; };
    for (let i = 0; i < lines.length; i++) {
      if (i + 1 < lines.length && lines[i].includes("|") && separator(lines[i + 1])) {
        flush();
        const head = cells(lines[i]);
        html += '<div class="easyread-table-wrap"><table><thead><tr>' + head.map((c) => "<th>" + PR.md(c, { cite: false, xref: false }) + "</th>").join("") + "</tr></thead><tbody>";
        i++;
        while (i + 1 < lines.length && lines[i + 1].trim().startsWith("|")) {
          html += "<tr>" + cells(lines[++i]).map((c) => "<td>" + PR.md(c, { cite: false, xref: false }) + "</td>").join("") + "</tr>";
        }
        html += "</tbody></table></div>";
      } else prose.push(lines[i]);
    }
    flush();
    return html;
  }
  function setTheme(id = PR.readerThemeValue()) {
    const theme = PR.applyReaderTheme(document, id);
    PR.$("#theme").textContent = "外观";
    if (doc) PR.applyReaderTheme(doc, theme.id);
  }
  function render() {
    paper = S.paper; job = S.job || {};
    if (doc && paper) {
      let structureChanged = false, contentChanged = false;
      for (const b of paper.blocks) {
        const node = PR.articleNode(b.id);
        if (!node) continue;
        let zh = PR.articleNode(b.id, "zh");
        if (!zh && b.zh) {
          zh = doc.createElement("div");
          zh.id = "easyread-zh-" + b.id;
          zh.className = "easyread-zh";
          zh.lang = "zh-CN";
          zh.dataset.anchor = b.id;
          const sourceFigure = b.zh_span_tables && node.closest('figure.ltx_table');
          if (sourceFigure) sourceFigure.append(zh);
          else (node.closest('.easyread-table-scroll') || node).insertAdjacentElement("afterend", zh);
          structureChanged = true;
        }
        if (zh && zh.dataset.text !== b.zh) {
          // KaTeX accepts CSS colors, while arXiv may emit LaTeX RGB colors.
          // Adapt only the display input; keep the saved translation intact.
          const displayZh = b.zh.replace(/\\color\[rgb\]\{([\d.]+),([\d.]+),([\d.]+)\}/g,
            (match, r, g, blue) => {
              const values = [r, g, blue].map(Number);
              if (values.some(v => v < 0 || v > 1)) return match;
              return "\\color{#" + values.map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("") + "}";
            });
          zh.innerHTML = PR.articleTranslationHtml(node, displayZh, translationHtml);
          zh.dataset.text = b.zh;
          contentChanged = true;
        }
        if (zh && zh.hidden === showZh) zh.hidden = !showZh;
      }
      if (contentChanged || structureChanged || renderedVisibility !== showZh) PR.layoutArticle(doc, showZh);
      renderedVisibility = showZh;
      if (contentChanged) PR.invalidateArticleMarks();
      PR.indexArticle({ structureChanged });
    }
    const busy = ["queued", "running"].includes(job.state);
    const units = paper ? paper.blocks.filter((b) => b.translatable !== false) : [];
    const completed = units.filter((b) => b.zh).length;
    const total = units.length;
    PR.$("#translateBtn").textContent = busy ? "翻译进度" : completed && completed < total ? "继续翻译" : "翻译";
    PR.$("#translate").disabled = busy;
    PR.$("#cancel").hidden = !busy;
    PR.$("#retry").hidden = busy || !Object.keys(job.failed || {}).length;
    PR.$("#status").textContent = "已译 " + completed + "/" + total + " 段" +
      (job.error ? " · " + job.error : busy ? " · " + (job.message || "翻译中") : "");
  }
  async function act(action, body) {
    try {
      await PR.api(api + "/" + action, { method: "POST", body: body || {} });
      await PR.poll();
    } catch (e) { PR.$("#status").textContent = e.message; }
  }
  PR.on("remote", (changed) => { if (changed.some((n) => ["paper", "job"].includes(n))) render(); });
  PR.on("status", ({ s, text }) => {
    const el = PR.$("#saveState"); el.dataset.s = s; el.querySelector("span").textContent = text;
  });
  PR.$("#notesBtn").onclick = () => PR.toggleNotesPanel();
  PR.$("#translateBtn").onclick = () => showTranslationTools(PR.$("#translationTools").hidden);
  showTranslationTools(new URLSearchParams(location.search).get("translate") === "1");
  PR.$("#chatBtn").onclick = () => PR.toggleChat();
  PR.on("ui-changed", () => { PR.$("#chatBtn").hidden = !PR.feature("chat"); });
  PR.on("settings-saved", () => { PR.applyTheme(PR.prefs.theme || "auto"); setTheme(); });
  PR.on("reader-theme-changed", setTheme);
  PR.on("reader-theme-preview", setTheme);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { PR.applyTheme(PR.prefs.theme || "auto"); setTheme(); });
  PR.$("#translate").onclick = () => act("translate", { scope: PR.$("#scope").value });
  PR.$("#retry").onclick = () => act("translate", { failed: true });
  PR.$("#cancel").onclick = () => act("cancel");
  PR.$("#jumpAbstract").onclick = () => {
    const target = doc?.querySelector(".ltx_abstract");
    if (target) { PR.rememberArticleSpot?.(target); target.scrollIntoView({ block: "start" }); }
  };
  PR.$("#theme").onclick = () => PR.toggleReaderThemePicker(PR.$("#theme"));
  PR.showChinese = () => { showZh = true; if (doc) { PR.revealVisualTranslations(doc); renderedVisibility = null; } PR.$("#toggleZh").textContent = "隐藏中文"; render(); };
  PR.$("#toggleZh").onclick = () => {
    showZh = !showZh;
    PR.$("#toggleZh").textContent = showZh ? "隐藏中文" : "显示中文";
    render();
  };
  PR.applyTheme(PR.prefs.theme || "auto"); setTheme();
  try {
    await PR.load();
    const prefs = await PR.loadPrefs(); PR.useServerUi(prefs);
    Object.assign(PR.prefs, prefs.reader || {});
    PR.applyTheme(PR.prefs.theme || "auto"); setTheme();
    paper = S.paper;
    document.title = paper.meta.title_en + " · EasyRead";
    PR.$("#paperTitle").textContent = paper.meta.title_en;
    PR.$("#original").href = paper.meta.source_url;
    const linkedPdf = S.item?.local_pdfs?.[0];
    if(linkedPdf)PR.readerShell?.setModes([{label:'arXiv 网页',current:true,href:location.pathname},{label:'PDF 对照',href:'/read/'+encodeURIComponent(linkedPdf)}]);
    if (linkedPdf) { PR.$('#localPdf').href = '/p/' + encodeURIComponent(linkedPdf) + '/source.pdf'; PR.$('#localPdf').hidden = false; }
    PR.$("#sourceInfo").textContent = paper.meta.arxiv + " · 网页英文原文";
    const assets = (await PR.api(api + '/visual-assets')).assets;
    frame.onload = async () => {
      doc = frame.contentDocument;
      PR.readerShell?.attach(doc);
      renderedVisibility = null;
      const katex = doc.createElement("link");
      katex.rel = "stylesheet"; katex.href = "/web/vendor/katex/katex.min.css";
      const mathStyled = new Promise(resolve => { katex.onload = resolve; katex.onerror = resolve; });
      doc.head.appendChild(katex);
      const style = doc.createElement("link");
      style.rel = "stylesheet";
      style.href = "/web/css/arxiv-article.css";
      const styled = new Promise((resolve) => {
        style.onload = resolve;
        style.onerror = resolve;
      });
      doc.head.appendChild(style);
      const colors = doc.createElement("link");
      colors.rel = "stylesheet"; colors.href = "/web/css/reader-theme.css";
      const colored = new Promise(resolve => { colors.onload = resolve; colors.onerror = resolve; });
      doc.head.appendChild(colors);
      // Establish the reader styles before adding translated math and measuring
      // progress. This avoids laying out the same long article in two styles.
      await Promise.all([styled, colored, mathStyled]);
      PR.restoreVisualAssets(doc, assets);
      PR.attachArticleFootnotes(doc);
      PR.attachArticleCitations(doc);
      PR.attachArticleXrefs(doc);
      PR.attachArticleNavigation(doc);
      PR.attachArticle(doc, { deferIndex: true });
      setTheme(); render();
      const progress = S.reader.progress || {}, ratio = progress.ratio || 0;
      const anchor = doc.querySelector('[data-easyread-id="' + CSS.escape(progress.block || '') + '"]');
      if (anchor) frame.contentWindow.scrollTo(0, frame.contentWindow.scrollY + anchor.getBoundingClientRect().top - (Number.isFinite(progress.offset) ? progress.offset : frame.clientHeight * .3));
      else if (ratio) frame.contentWindow.scrollTo(0, ratio * Math.max(1, doc.documentElement.scrollHeight - frame.clientHeight));
      frame.contentWindow.addEventListener("scroll", PR.debounce(() => {
        const height = doc.documentElement.scrollHeight - frame.clientHeight;
        const ratio = height > 0 ? frame.contentWindow.scrollY / height : 0;
        const block=PR.readingBlock(), current=doc.querySelector('[data-easyread-id="'+CSS.escape(block || '')+'"]');
        PR.commit({ op: "progress", block, ratio, offset: current?.getBoundingClientRect().top, at: PR.nowIso() });
      }, 800));
    };
    frame.src = "/p/" + encodeURIComponent(id) + "/article.html";
    render();
    PR.startPolling();
  } catch (e) { PR.$("#status").textContent = e.message; }
})(window.PR);
