/* 网页阅读面适配：笔记/问答沿用 PDF 的模块；选区与标记在只读原文 iframe 内。 */
(function (PR) {
  "use strict";
  const S = PR.state, frame = PR.$("#article"), bar = PR.$("#selbar");
  const SKIP = "math, annotation, .katex, button, .easyread-note-pin, .ltx_note, .easyread-footnote-ref, .easyread-footnote-panel, .easyread-citation-panel, .easyread-xref-panel";
  let doc = null, current = null, pending = null, segments = [];
  let sourceNodes = new Map(), translatedNodes = new Map(), indexedPaper = null;
  let segmentsIndexed = false;
  let marksRevision = 0, marksSignature = null, pinsSignature = null;
  const lost = new Set();
  PR.blockById = {}; PR.order = {};
  PR.prefs = Object.assign({ pen: "marker" }, PR.ls.get("easyread-prefs", {}));
  PR.textFor = (id) => { const b = PR.blockById[id]; return b ? b.zh || b.source_text || b.en || "" : ""; };
  PR.blockKeys = (b) => [b.id];
  const english = (id) => {
    if (!doc) return null;
    let node = sourceNodes.get(id);
    if (!node?.isConnected) {
      node = doc.querySelector('[data-easyread-id="' + CSS.escape(id) + '"]');
      if (node) sourceNodes.set(id, node);
    }
    return node;
  };
  const chinese = (id) => {
    if (!doc) return null;
    let node = translatedNodes.get(id);
    if (!node?.isConnected) {
      node = doc.getElementById("easyread-zh-" + id);
      if (node) translatedNodes.set(id, node);
    }
    return node;
  };
  PR.articleNode = (id, key = "en") => key === "zh" ? chinese(id) : english(id);
  PR.invalidateArticleMarks = () => { marksRevision++; };
  const rootFor = (n) => n.key === "en" ? english(n.anchor) : chinese(n.anchor);
  PR.quoteLost = (id) => lost.has(id);

  function textNodes(root) {
    const nodes = [], w = doc.createTreeWalker(root, 4, {
      acceptNode: (n) => n.parentElement.closest(SKIP) ? 2 : 1,
    });
    for (let n; (n = w.nextNode());) nodes.push(n);
    return nodes;
  }
  const fullText = (root) => textNodes(root).map((n) => n.data).join("");
  function offset(root, container, index) {
    const range = doc.createRange(); range.setStart(root, 0); range.setEnd(container, index);
    let pos = 0;
    for (const n of textNodes(root)) {
      if (n === container) return pos + index;
      if (range.intersectsNode(n)) pos += n.length;
    }
    return pos;
  }
  function quotePosition(text, n) {
    if (Number.isInteger(n.start) && text.slice(n.start, n.start + n.quote.length) === n.quote && n.text_hash === PR.hashText(text)) return n.start;
    let best = -1, score = -1, tied = false;
    for (let i = text.indexOf(n.quote); i >= 0; i = text.indexOf(n.quote, i + 1)) {
      let s = 0;
      if (n.prefix && text.slice(Math.max(0, i - n.prefix.length), i) === n.prefix) s++;
      if (n.suffix && text.slice(i + n.quote.length, i + n.quote.length + n.suffix.length) === n.suffix) s++;
      if (s > score) { best = i; score = s; tied = false; } else if (s === score) tied = true;
    }
    return tied ? -1 : best;
  }
  function wrap(root, start, end, note) {
    const createMark = () => {
      const mark = doc.createElement("mark");
      mark.className = "easyread-mark c-" + (note.color || "yellow") + (note.style === "underline" ? " s-ul" : "");
      mark.dataset.note = note.id;
      return mark;
    };
    // 完整跨过行内引用/公式时，用一个连续标记包住整个 Range。
    // 只移动完整的 MathML 节点，公式内部和原始快照都保持原样。
    if (root.matches(".ltx_p,.easyread-zh,.ltx_title,.ltx_caption")) {
      let pos = 0, first, last;
      for (const n of textNodes(root)) {
        const a = pos, b = pos + n.length; pos = b;
        if (b <= start || a >= end) continue;
        first ||= { node: n, offset: Math.max(start, a) - a };
        last = { node: n, offset: Math.min(end, b) - a };
      }
      if (first && last) {
        const range = doc.createRange(); range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset);
        try { range.surroundContents(createMark()); return; }
        catch (e) { if (!["InvalidStateError", "HierarchyRequestError"].includes(e.name)) throw e; }
      }
    }
    // 端点落在不完整的行内元素内时，保留元素边界，使用原有分段方式。
    let pos = 0;
    for (const n of textNodes(root)) {
      const a = pos, b = pos + n.length; pos = b;
      if (b <= start || a >= end) continue;
      const from = Math.max(start, a) - a, to = Math.min(end, b) - a;
      let part = n;
      if (to < part.length) part.splitText(to);
      if (from) part = part.splitText(from);
      const mark = createMark();
      part.parentNode.insertBefore(mark, part); mark.appendChild(part);
    }
  }
  PR.applyMarks = function () {
    if (!doc || !S.paper) return;
    const notes = PR.myNotes().filter(n => n.quote);
    // Body edits and progress do not change quote placement. Translation DOM
    // replacement explicitly invalidates this signature before restoring marks.
    const signature = JSON.stringify([marksRevision, notes.map(n => [n.id, n.anchor, n.key, n.quote,
      n.start, n.prefix, n.suffix, n.text_hash, n.source_hash, PR.blockById[n.anchor]?.source_hash, n.color, n.style])]);
    if (signature === marksSignature) return;
    doc.querySelectorAll("mark.easyread-mark").forEach((m) => m.replaceWith(...m.childNodes));
    lost.clear();
    for (const n of notes) {
      const root = rootFor(n), b = PR.blockById[n.anchor];
      if (!root || (n.key === "en" && n.source_hash && b?.source_hash !== n.source_hash)) { lost.add(n.id); continue; }
      const i = quotePosition(fullText(root), n);
      if (i < 0) { lost.add(n.id); continue; }
      wrap(root, i, i + n.quote.length, n);
    }
    marksSignature = signature;
  };
  function renderPins() {
    if (!doc) return;
    const groups = {};
    PR.myNotes().forEach((n) => { (groups[n.anchor] ||= []).push(n.id); });
    (S.discussion.entries || []).forEach((n) => { (groups[PR.anchorOfEntry(n)] ||= []).push(null); });
    const signature = JSON.stringify(groups);
    if (signature === pinsSignature) return;
    doc.querySelectorAll(".easyread-note-pin").forEach((n) => n.remove());
    for (const [anchor, ids] of Object.entries(groups)) {
      const node = english(anchor); if (!node) continue;
      const pin = doc.createElement("button");
      pin.className = "easyread-note-pin"; pin.textContent = ids.length;
      pin.title = "查看这段的划线、笔记和 AI 回答";
      pin.setAttribute("aria-label", "这段有 " + ids.length + " 条批注");
      pin.dataset.anchor = anchor;
      // 使用相邻控件，原文节点的文字与引用锚点不变。
      node.insertAdjacentElement("beforebegin", pin);
    }
    pinsSignature = signature;
  }
  PR.noteSurface = {
    render() { renderPins(); if (PR.notesPanelOpen?.()) PR.renderNotesPanel(); },
    openEditor(id) { PR.openSide("notes"); PR.renderNotesPanel(id); },
    link(card, on) {
      if (!doc) return;
      const id = card.dataset.note;
      if (id) doc.querySelectorAll('mark[data-note="' + CSS.escape(id) + '"]').forEach((m) => m.classList.toggle("active", on));
    },
  };
  PR.openSide = function (side) {
    PR.flushNotesPanelEdits?.();
    hideSelection();
    const anchor = PR.readingBlock(), node = english(anchor), top = node?.getBoundingClientRect().top;
    if(!side)PR.selectionPreview?.clear();
    PR.side = side;
    document.body.classList.toggle("side-open", !!side);
    document.body.classList.toggle("np-open", side === "notes");
    document.body.classList.toggle("ch-open", side === "chat");
    PR.$("#notespanel").inert = side !== "notes"; PR.$("#chatpanel").inert = side !== "chat";
    PR.$("#notesBtn").setAttribute("aria-expanded", String(side === "notes"));
    PR.$("#chatBtn").setAttribute("aria-expanded", String(side === "chat"));
    requestAnimationFrame(() => { if (node && top != null) frame.contentWindow.scrollBy(0, node.getBoundingClientRect().top - top); });
  };
  PR.currentBlock = () => current;
  PR.readingBlock = function () {
    if (!doc) return null;
    const line = frame.clientHeight * .3;
    let best = null, nearest = -Infinity;
    for (const s of segments) {
      if (s.node.hidden || !s.node.getClientRects().length) continue;
      const rect = s.node.getBoundingClientRect();
      if (rect.height <= 0 || rect.top > line || rect.top < nearest) continue;
      nearest = rect.top; best = s.anchor;
    }
    best ||= segments.find(s=>!s.node.hidden&&s.node.getClientRects().length)?.anchor || null;
    return best;
  };
  PR.jumpTo = function (id, opts) {
    if (!doc) return;
    const anchor = id.replace(/^b-/, ""), note = opts?.note && S.reader.notes?.[opts.note];
    if (note?.key === "zh" && chinese(anchor)?.hidden) PR.showChinese?.();
    let target = note && rootFor(note);
    if (target && note) target = target.querySelector('mark[data-note="' + CSS.escape(note.id) + '"]') || target;
    target ||= english(anchor);
    if (!target) return;
    PR.rememberArticleSpot?.(target);
    current = anchor;
    if (matchMedia("(max-width: 760px)").matches) PR.openSide(null);
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("easyread-focus"); setTimeout(() => target.classList.remove("easyread-focus"), 1400);
    PR.emit("reading-context");
  };
  function selection() {
    if (!doc) return null;
    const sel = frame.contentWindow.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0), el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    const root = el.closest(".easyread-zh, [data-easyread-id]");
    if (!root || !root.contains(r.endContainer) || el.closest(SKIP)) return null;
    const key = root.classList.contains("easyread-zh") ? "zh" : "en";
    const anchor = key === "zh" ? root.dataset.anchor : root.dataset.easyreadId;
    const text = fullText(root), start = offset(root, r.startContainer, r.startOffset), end = offset(root, r.endContainer, r.endOffset);
    const quote = text.slice(start, end); if (!quote.trim()) return null;
    const box = r.getBoundingClientRect(), fb = frame.getBoundingClientRect();
    return { anchor, key, quote, prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32), start,
      text_hash: PR.hashText(text), source_hash: PR.blockById[anchor]?.source_hash,
      rect: { left: fb.left + box.left, top: fb.top + box.top, bottom: fb.top + box.bottom, width: box.width } };
  }
  function hideSelection() { bar.classList.remove("open"); pending = null; }
  function showSelection() {
    const next = selection();
    if (!next) return hideSelection();
    pending = next; current = next.anchor;
    PR.selectionPreview?.set(doc,[frame.contentWindow.getSelection().getRangeAt(0)]);
    const pen = PR.prefs.pen === "underline" ? "underline" : "marker";
    bar.innerHTML = '<span class="pens"><button data-pen="marker" class="' + (pen === "marker" ? "on" : "") + '" aria-pressed="' + (pen === "marker") + '" title="荧光笔">' + PR.icon("marker", "sm") + '</button><button data-pen="underline" class="' + (pen === "underline" ? "on" : "") + '" aria-pressed="' + (pen === "underline") + '" title="下划线">' + PR.icon("underline", "sm") + '</button></span><span class="dots pen-' + pen + '">' +
      PR.HL_COLORS.map(([c, name]) => '<button data-s="highlight" data-color="' + c + '" class="dot-' + c + '" title="' + name + '色划线"></button>').join("") + '</span><button data-s="note">' + PR.icon("note", "sm") + '笔记</button><button data-s="question">' + PR.icon("question", "sm") + '提问</button>' +
      (PR.feature("chat") ? '<button data-s="chat">' + PR.icon("sparkle", "sm") + '问 AI</button>' : "") + '<button data-s="copy" title="复制">' + PR.icon("copy", "sm") + '</button>';
    bar.classList.add("open");
    const r = pending.rect, w = bar.offsetWidth, h = bar.offsetHeight;
    bar.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    bar.style.top = Math.max(8, Math.min(innerHeight - h - 8, r.top - h - 8 < frame.offsetTop ? r.bottom + 8 : r.top - h - 8)) + "px";
    PR.emit("reading-context");
  }
  PR.selectionAction = function (kind, color) {
    if (!pending) return;
    const { rect, ...n } = pending;
    hideSelection(); frame.contentWindow.getSelection().removeAllRanges();
    if(kind!=="chat"&&kind!=="copy")PR.selectionPreview?.clear();
    if (kind === "copy") return navigator.clipboard.writeText(n.quote).then(() => PR.toast("已复制"));
    if (kind === "chat") return PR.chatAsk({ anchor: n.anchor, quote: n.quote });
    Object.assign(n, { kind, color: color || "yellow", style: PR.prefs.pen === "underline" ? "underline" : "marker" });
    if (kind === "highlight") {
      Object.assign(n, { id: PR.uid("n"), body: "", created: PR.nowIso() });
      PR.saveNote(n);
      PR.toast("已划线，点划线可以写笔记", { label: "撤销", fn: () => PR.commit({ op: "note_del", id: n.id }) }, 2600);
    } else PR.startNote(n);
  };
  bar.addEventListener("mousedown", (e) => e.preventDefault());
  bar.addEventListener("click", (e) => {
    const pen = e.target.closest("[data-pen]");
    if (pen) {
      PR.prefs.pen = pen.dataset.pen;
      PR.ls.set("easyread-prefs", Object.assign(PR.ls.get("easyread-prefs", {}), { pen: PR.prefs.pen }));
      PR.savePrefs("reader", { pen: PR.prefs.pen }); return showSelection();
    }
    const b = e.target.closest("[data-s]"); if (b) PR.selectionAction(b.dataset.s, b.dataset.color);
  });
  function keydown(e) {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.target.closest("textarea, input, [contenteditable]")) return;
    const key = e.key.toLowerCase();
    if (key === "escape") { hideSelection(); PR.openSide(null); return; }
    if (!PR.keysOn) return;
    const color = { 1: "yellow", 2: "green", 3: "blue", 4: "pink" }[key];
    if (pending && color) { e.preventDefault(); return PR.selectionAction("highlight", color); }
    const act = PR.keyAction(key);
    if (pending && ["note", "question"].includes(act)) { e.preventDefault(); return PR.selectionAction(act); }
    if (act === "notes") PR.toggleNotesPanel();
    else if (act === "chat") PR.toggleChat();
    else if (["note", "question"].includes(act)) { const anchor = current || PR.readingBlock(); if (anchor) PR.startNote({ anchor, kind: act }); }
    else return;
    e.preventDefault();
  }
  document.addEventListener("keydown", keydown);
  window.addEventListener("resize", hideSelection);
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#selbar")) hideSelection(); });
  function refresh() { PR.applyMarks(); PR.renderMargin(); }
  function indexPaper() {
    PR.blockById = Object.fromEntries(S.paper.blocks.map((b) => [b.id, b]));
    PR.order = Object.fromEntries(S.paper.blocks.map((b, i) => [b.id, i]));
    indexedPaper = S.paper;
  }
  PR.on("reader", (op) => { if (!["progress", "paper_note"].includes(op.op)) refresh(); });
  PR.on("remote", (changed) => { if (changed.some((n) => ["reader", "discussion"].includes(n))) refresh(); });

  PR.attachArticle = function (articleDoc, { deferIndex = false } = {}) {
    doc = articleDoc; current = null;
    sourceNodes = new Map(); translatedNodes = new Map(); indexedPaper = null;
    segments = []; segmentsIndexed = false;
    marksSignature = pinsSignature = null; marksRevision++;
    for (const node of doc.querySelectorAll('[data-easyread-id]')) {
      const id = node.dataset.easyreadId;
      if (!sourceNodes.has(id)) sourceNodes.set(id, node);
    }
    // Inline Markdown labels need the block lookup before translations render;
    // defer only DOM segments and annotation restoration until they are present.
    if (S.paper) indexPaper();
    doc.addEventListener("mouseup", () => setTimeout(showSelection, 10));
    doc.addEventListener("keyup", (e) => { if (e.shiftKey && e.key.startsWith("Arrow")) showSelection(); });
    doc.addEventListener("selectionchange", PR.debounce(() => { if (frame.contentWindow.getSelection().isCollapsed) hideSelection(); }, 100));
    doc.addEventListener("keydown", keydown);
    doc.addEventListener("click", (e) => {
      if (frame.contentWindow.getSelection().toString()) return;
      if (e.target.closest('.easyread-citation-panel, .easyread-xref-panel, a[href^="#"]')) return;
      const mark = e.target.closest("mark.easyread-mark"), pin = e.target.closest(".easyread-note-pin");
      if (mark) { e.preventDefault(); return PR.openNoteEditor(mark.dataset.note); }
      if (pin) { current = pin.dataset.anchor; PR.toggleNotesPanel(true); return; }
      const root = e.target.closest(".easyread-zh, [data-easyread-id]");
      current = root ? root.dataset.anchor || root.dataset.easyreadId : null;
      PR.emit("reading-context");
    });
    doc.addEventListener("dragstart", () => { const s = selection(); PR.emit("article-drag", s ? { anchor: s.anchor, quote: s.quote.slice(0, 1000) } : null); });
    doc.addEventListener("dragend", () => PR.emit("article-drag", null));
    frame.contentWindow.addEventListener("scroll", () => { current = null; hideSelection(); PR.emit("reading-context"); }, { passive: true });
    PR.sectionOf = function (id) {
      let title = "论文开头";
      for (const b of S.paper.blocks) {
        const node = english(b.id);
        if (node?.matches("h1,h2,h3,h4,h5,h6") && !node.matches(".ltx_title_document")) title = PR.plain(b.zh || b.en);
        if (b.id === id) break;
      }
      return title;
    };
    PR.sectionLabel = (id) => id === "head" ? "论文开头" : PR.sectionOf(id);
    if (!deferIndex) PR.indexArticle();
  };
  PR.indexArticle = function ({ structureChanged = false } = {}) {
    if (!S.paper || !doc) return;
    const paperChanged = indexedPaper !== S.paper;
    if (paperChanged) indexPaper();
    if (paperChanged || structureChanged || !segmentsIndexed) {
      segments = S.paper.blocks.flatMap((b) => [english(b.id), chinese(b.id)].filter(Boolean).map((node) => ({ node, anchor: b.id })));
      segmentsIndexed = true;
    }
    refresh();
  };
})(window.PR);
