/* 文献库：列表、筛选、排序、键盘操作、状态轮询。 */
(function (PR) {
  "use strict";
  const L = (PR.lib = { items: [], view: "all", tag: null, q: "", sort: PR.ls.get("easyread-sort", "opened"), selected: null, engine: "claude" });
  const prefs = PR.ls.get("easyread-prefs", {});
  PR.applyTheme(prefs.theme);


  PR.$("#importBtn").innerHTML = PR.icon("plus", "sm") + "<span>导入论文</span>";
  PR.$("#settingsBtn").innerHTML = PR.icon("gear");
  PR.$("#helpBtn").innerHTML = PR.icon("question");
  PR.$(".search .si").outerHTML = PR.icon("search", "sm");
  PR.$("#sort").value = L.sort;

  L.byId = (id) => L.items.find((i) => i.id === id);
  L.openReader = (id, translate = false) => { rememberView(); location.href = "/read/" + encodeURIComponent(id) + (translate ? "?translate=1" : ""); };
  L.patch = async function (id, fields) {
    const it = L.byId(id);
    if (it) { Object.assign(it, fields.meta_override ? {} : fields); L.render(); }  // 先改界面，再存盘
    try { await PR.api("/api/p/" + id + "/item", { method: "POST", body: fields }); }
    catch (e) { PR.toast("保存失败：" + PR.esc(e.message)); }
    await L.load();
  };

  let loadFlight, reloadRequested=false, hasLoaded=false;
  L.load = function () {
    clearTimeout(pollT);
    if(loadFlight){reloadRequested=true;return loadFlight;}
    loadFlight=load().finally(()=>{loadFlight=null;if(reloadRequested){reloadRequested=false;L.load().catch(()=>schedule());}});
    return loadFlight;
  };
  async function load() {
    const d = await PR.api("/api/library");
    PR.token = d.token;
    L.engine = d.engine;
    L.engineLabel = d.engine_label;
    L.firstRun = d.first_run;
    L.version = d.version;
    L.pdfDefault = !!d.pdf_reader_default_enabled;
    engineChip();
    L.jobs = d.jobs || [];
    const changed=!hasLoaded||JSON.stringify(L.items)!==JSON.stringify(d.items);hasLoaded=true;
    L.items = d.items;
    if(changed)L.render();
    restoreView();
    schedule();
  }

  let pollT;
  function schedule() {
    clearTimeout(pollT);
    if(document.hidden)return;
    const busy = L.items.some((i) => i.job && ["queued", "running"].includes(i.job.state)) || (L.jobs||[]).some(j=>["queued","running"].includes(j.state));
    pollT = setTimeout(() => L.load().catch(() => schedule()), busy ? 2500 : 60000);
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(pollT);else L.load().catch(()=>schedule());});
  window.addEventListener('focus',()=>{if(!document.hidden)L.load().catch(()=>schedule());});

  function filtered() {
    const view = L.VIEWS.find((v) => v[0] === L.view) || L.VIEWS[0];
    const q = L.q.trim().toLowerCase();
    let list = L.items.filter(view[3]);
    if (L.tag) list = list.filter((i) => i.tags.includes(L.tag));
    if (q) list = list.filter((i) => (PR.account ? [i.title_zh, i.title_en, i.authors] : [i.title_zh, i.title_en, i.authors, i.venue, i.arxiv, i.abstract, (i.tags || []).join(" "), i.year])
      .join(" ").toLowerCase().includes(q));
    const key = { opened: (i) => i.last_opened || i.added, added: (i) => i.added, year: (i) => String(i.year || ""), title: (i) => i.title_en || i.title_zh };
    const k = key[L.sort] || key.opened;
    list.sort((a, b) => (L.sort === "title" ? String(k(a)).localeCompare(String(k(b)), "zh") : String(k(b)).localeCompare(String(k(a)))));
    return list;
  }

  function statusPill(i) {
    const m = { unread: "未读", reading: "在读", done: "已读" };
    return '<span class="pill ' + (i.status || "unread") + '">' + (m[i.status] || "未读") + "</span>";
  }
  L.jobLine = function (i) {
    /* Task state takes priority; routine source/version details live in the detail panel. */
    const j = i.job;
    const unit = ["arxiv_html","pdf_sdt"].includes(i.reading_source_kind) ? "段" : "页";
    if (j && ["queued", "running"].includes(j.state)) {
      const pct = j.total ? " " + j.done + "/" + j.total + " " + unit : "";
      return '<span class="stat job"><span class="spin"></span>' + PR.esc(j.state === "queued" ? "排队中" : (j.message || "处理中")) + pct + "</span>";
    }
    if (j && j.state === "error") return '<span class="stat err">翻译出错</span>';
    if (j && j.state === "partial") return '<span class="stat err">' + Object.keys(j.failed || {}).length + " " + unit + "没译成功</span>";
    return "";
  };

  function displayVenue(i) {
    const value = i.venue || i.arxiv || "";
    const match = value.match(/\b(NeurIPS|ICML|ICLR|ACL|EMNLP|NAACL|COLM|AAAI)\b/i);
    return match ? match[1] : value;
  }

  function rowHtml(i) {
    const title = i.title_en || i.title_zh || "（未命名）";
    const sub = i.title_zh && i.title_en && i.title_zh !== i.title_en ? '<div class="t2" lang="zh-CN">' + PR.esc(i.title_zh) + "</div>" : "";
    const bits = [i.authors && (i.authors.split(",").slice(0, 3).join(",") + (i.authors.split(",").length > 3 ? " 等" : "")), i.year, displayVenue(i)].filter(Boolean);
    const tags = (i.tags || []).slice(0, 3).map((t) => '<span class="chip cat">' + PR.icon("folder", "sm") + PR.esc(t) + "</span>").join("") + ((i.tags || []).length > 3 ? '<span class="chip" title="' + PR.esc(i.tags.slice(3).join("、")) + '">+' + (i.tags.length - 3) + "</span>" : "");
    const notes = i.notes + i.highlights ? '<span class="stat">' + PR.icon("note", "sm") + (i.notes + i.highlights) + (i.open_questions ? " · " + i.open_questions + " 问待答" : "") + "</span>" : "";
    const prog = i.progress ? '<span class="progress-label">读到 ' + Math.round(i.progress * 100) + '%</span><div class="meter" title="阅读进度 ' + Math.round(i.progress * 100) + '%"><i style="width:' + Math.round(i.progress * 100) + '%"></i></div>' : "";
    return '<div class="row' + (L.selected === i.id ? " on" : "") + '" data-id="' + i.id + '" role="option" aria-selected="' + (L.selected === i.id) + '" draggable="true">' +
      '<div><div class="t1">' + (i.starred ? '<span class="star">' + PR.icon("star") + "</span>" : "") + '<span class="paper-title" title="' + PR.esc(title) + '">' + PR.esc(title) + "</span></div>" + sub +
      '<div class="t3">' + bits.map((b) => "<span>" + PR.esc(String(b)) + "</span>").join("<span>·</span>") + tags + "</div></div>" +
      '<div class="side-info">' + statusPill(i) + prog + L.jobLine(i) + notes + "</div></div>";
  }

  L.render = function () {
    PR.renderSide();
    const list = filtered();
    const view = L.VIEWS.find((v) => v[0] === L.view) || L.VIEWS[0];
    PR.$("#viewTitle").textContent = L.tag ? L.tag : view[1] + (L.view === "all" ? "论文" : "");
    PR.$("#count").textContent = list.length + " 篇";
    PR.$("#list").innerHTML = list.length ? list.map(rowHtml).join("") : emptyHtml();
    if (L.selected && !L.byId(L.selected)) L.select(null);
    else PR.renderDetail && PR.renderDetail();
  };
  function emptyHtml() {
    if (L.items.length) return '<div class="empty-state"><div class="big">没有符合条件的论文</div>换个关键词或筛选试试。</div>';
    if (PR.account) return '<div class="welcome">' + PR.logo("hero") + '<h2>把英文论文，读成舒服的中文</h2><p class="sub">这是你的个人文献库。导入文本型 PDF，阅读原文、整理分类和手动记笔记；报告与问答由你主动发起。</p><button class="btn accent" onclick="PR.openImport()">' + PR.icon("plus", "sm") + '导入论文</button><p class="hint">单份不超过20,000,000字节；导入后只进行本地解析，不自动调用AI。</p></div>';
    const ok = L.engineReady;
    return '<div class="welcome">' + PR.logo("hero") + "<h2>把英文论文，读成舒服的中文</h2>" +
      '<p class="sub">导入 PDF，后台逐页翻译；公式、表格照原文排好，随时对照原文，边读边划线、记笔记、提问。</p>' +
      '<ol class="steps">' +
      '<li class="' + (ok ? "done" : "") + '"><b>选一个翻译引擎</b><span>' + (ok === undefined ? '<span class="spin"></span> 正在检测本机…' : ok ? "已就绪：" + PR.esc(L.engineLabel) : "当前引擎还不能用，" + (L.engineHint || "去设置里选一个")) + '</span><button class="btn sm ' + (ok ? "line" : "accent") + '" onclick="PR.openSettings()">' + (ok ? "换一个" : "去设置") + "</button></li>" +
      "<li><b>导入论文</b><span>拖进 PDF、粘贴 arXiv 链接，或者直接在这个页面按 Ctrl+V</span>" +
      '<button class="btn sm accent" onclick="PR.openImport()">' + PR.icon("plus", "sm") + "导入</button></li>" +
      '<li><b>开始读</b><span>点段落出操作条，选中文字能划线、写笔记、提问；按 <kbd>?</kbd> 看快捷键</span></li></ol>' +
      '<p class="try">没有现成的论文？试试 <button class="linkish" onclick="PR.importRef(&quot;1706.03762&quot;)">Attention Is All You Need</button></p></div>';
  }

  /* 顶栏上的引擎状态：一眼看出现在用什么翻译、能不能用 */
  async function engineChip() {
    const chip = PR.$("#engineChip");
    chip.innerHTML = '<span class="dot"></span><span>' + PR.esc(L.engineLabel || "") + "</span>";
    if (L.engineReady === undefined && !engineChip.pending) {
      engineChip.pending = true;
      const r = await PR.api("/api/engines").catch(() => null);
      engineChip.pending = false;
      L.engineReady = r ? r.ready : true;
      const f = r && r.found && r.found[L.engine];
      L.engineHint = f && !f.found ? "本机没找到 " + L.engineLabel : L.engine === "openai" ? "API 还没填 Key" : "";
      L.render();
    }
    chip.classList.toggle("bad", L.engineReady === false);
    chip.title = L.engineReady === false ? "翻译引擎还不能用：" + (L.engineHint || "") + "（点这里设置）" : "翻译引擎（点这里设置）";
  }
  PR.$("#engineChip").onclick = () => PR.openSettings();

  L.select = function (id) {
    if (L.selected !== id) L.detailEditing = false;
    L.selected = id;
    PR.$(".lib").classList.toggle("has-detail", !!id);
    PR.$$(".row").forEach((r) => (r.classList.toggle("on", r.dataset.id === id), r.setAttribute("aria-selected", String(r.dataset.id === id))));
    PR.renderDetail && PR.renderDetail();
  };

  /* Per-tab return state; never stored in paper or reader records. */
  const returnKey = "easyread-library-return-v1";
  let pendingReturn;
  try { pendingReturn = JSON.parse(sessionStorage.getItem(returnKey) || "null"); } catch (_) {}
  if (pendingReturn && typeof pendingReturn === "object") {
    if (typeof pendingReturn.q === "string") { L.q = pendingReturn.q; PR.$("#q").value = L.q; }
    if (typeof pendingReturn.view === "string") L.view = pendingReturn.view;
    L.tag = typeof pendingReturn.tag === "string" ? pendingReturn.tag : null;
    if (["opened", "added", "year", "title"].includes(pendingReturn.sort)) { L.sort = pendingReturn.sort; PR.$("#sort").value = L.sort; }
  }
  function rememberView() {
    try { sessionStorage.setItem(returnKey, JSON.stringify({ q:L.q, view:L.view, tag:L.tag, sort:L.sort,
      selected:L.selected, scroll:PR.$(".main").scrollTop })); } catch (_) {}
  }
  function restoreView() {
    if (!pendingReturn) return;
    const saved = pendingReturn; pendingReturn = null;
    if (saved.selected && PR.$$('.row').some(r => r.dataset.id === saved.selected)) L.select(saved.selected);
    requestAnimationFrame(() => { PR.$(".main").scrollTop = Math.max(0, Number(saved.scroll) || 0); });
  }
  window.addEventListener("pagehide", rememberView);

  /* ---------- 事件 ---------- */
  PR.$("#list").addEventListener("click", (e) => {
    const r = e.target.closest(".row");
    if (r) L.select(r.dataset.id);
  });
  /* 点列表空白处、侧栏、标题栏空白：收起右侧详情 */
  document.addEventListener("click", (e) => {
    if (!L.selected || e.target.closest(".row, #detail, .dialog-backdrop, .menu, #toast, .topbar button, .topbar input, select")) return;
    if (e.target.closest(".main, .side, .topbar")) L.select(null);
  });
  PR.$("#list").addEventListener("dblclick", (e) => { const r = e.target.closest(".row"); if (r) L.openReader(r.dataset.id); });
  PR.$("#list").addEventListener("contextmenu", (e) => {
    const r = e.target.closest(".row");
    if (!r) return;
    e.preventDefault();
    L.select(r.dataset.id);
    PR.rowMenu && PR.rowMenu(r.dataset.id, { x: e.clientX, y: e.clientY });
  });
  PR.$("#q").addEventListener("input", PR.debounce((e) => { L.q = e.target.value; L.render(); }, 120));
  PR.$("#sort").addEventListener("change", (e) => { L.sort = e.target.value; PR.ls.set("easyread-sort", L.sort); L.render(); });

  document.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.target.closest("input, textarea, select, [contenteditable]")) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (PR.$(".dialog-backdrop.open")) return;
    const rows = PR.$$(".row");
    const idx = rows.findIndex((r) => r.dataset.id === L.selected);
    if (e.key === "/" || (e.key === "k" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); PR.$("#q").focus(); }
    else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); const r = rows[Math.min(rows.length - 1, idx + 1)]; if (r) { L.select(r.dataset.id); r.scrollIntoView({ block: "nearest" }); } }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); const r = rows[Math.max(0, idx - 1)]; if (r) { L.select(r.dataset.id); r.scrollIntoView({ block: "nearest" }); } }
    else if (e.key === "Enter" && L.selected) L.openReader(L.selected);
    else if (e.key === "Escape") L.select(null);
    else if (e.key === "s" && L.selected) { const it = L.byId(L.selected); L.patch(it.id, { starred: !it.starred }); }
  });

  PR.onSettingsSaved = () => L.load();
  // 等侧栏、详情这些脚本都加载完再取数据：数据先到、脚本还没到时会出错
  document.addEventListener("DOMContentLoaded", () => {
    PR.loadPrefs().then((p) => { if (p.reader && p.reader.theme) PR.applyTheme(p.reader.theme); PR.useServerUi(p); L.useServerSide(p); });
    L.load().catch((e) => { PR.$("#list").innerHTML = '<div class="empty-state"><div class="big">连不上本地服务</div>' + PR.esc(e.message) + "</div>"; });
  });
})(window.PR);
