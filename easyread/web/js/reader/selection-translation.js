/* 选区下方自动翻译。浮窗在阅读器外层，不改论文节点和已有译文。 */
(function (PR) {
  "use strict";
  let cfg = null, active = null, dragging = false, timer = null, serial = 0;
  const attached = new WeakSet();
  const card = PR.el("section", { id: "selectionTranslation", class: "selection-translation", role: "region", "aria-label": "选区翻译", hidden: true });
  card.innerHTML = '<div class="st-head"><span class="st-label">翻译</span><button type="button" data-st="close" aria-label="关闭翻译">×</button></div>' +
    '<div class="st-result" role="status" aria-live="polite"></div><div class="st-foot"><span class="st-status"></span><span class="grow"></span>' +
    '<button type="button" data-st="retry" hidden>重试</button><button type="button" data-st="copy" disabled>复制</button>' +
    '<button type="button" data-st="chat">问 AI</button><button type="button" data-st="settings">设置</button></div>';
  document.body.appendChild(card);
  const result = card.querySelector(".st-result"), status = card.querySelector(".st-status");
  const safeNode = (n) => n.nodeType === 1 ? n : n.parentElement;
  const skip = "math, annotation, .katex, button, .easyread-note-pin, .stale-tag, .num, .ltx_note, .easyread-footnote-ref, .easyread-footnote-panel";

  function read(doc, frame) {
    const win = doc.defaultView, sel = win.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || safeNode(sel.anchorNode)?.closest("input,textarea,[contenteditable],#selectionTranslation")) return null;
    const r = sel.getRangeAt(0), parts = [], anchors = [], hashes = {};
    let key = null, firstStart = null, prefix = "", suffix = "";
    const roots = frame ? doc.querySelectorAll(".easyread-zh,[data-easyread-id]") : doc.querySelectorAll("#paper .en,#paper .en-title,#paper .zh");
    for (const root of roots) {
      if (!root.getClientRects().length || !r.intersectsNode(root) || root.querySelector("textarea")) continue;
      if (frame && !root.classList.contains("easyread-zh") && root.querySelector("[data-easyread-id]")) continue;
      const lang = root.classList.contains("easyread-zh") || root.classList.contains("zh") ? "zh" : "en";
      const anchor = frame ? root.dataset.anchor || root.dataset.easyreadId : root.closest(".blk")?.dataset.id;
      if (!anchor) continue;
      const walker = doc.createTreeWalker(root, 5, { acceptNode: (n) => {
        if (n.nodeType === 1) return n.parentElement?.closest("math,.katex,.ltx_note,.easyread-footnote-panel") ? 2 : n.matches("math,.katex") ? 1 : n.matches("button,.easyread-note-pin,.stale-tag,.num,.ltx_note,.easyread-footnote-ref,.easyread-footnote-panel") ? 2 : 3;
        return n.parentElement.closest(skip) ? 2 : 1;
      } });
      let node, whole = "", text = "", start = null, end = null;
      while ((node = walker.nextNode())) {
        const formula = node.nodeType === 1;
        const tex = formula && (node.getAttribute("alttext") || node.querySelector('annotation[encoding="application/x-tex"]')?.textContent);
        const content = formula ? (tex ? "$" + tex + "$" : node.textContent) : node.data;
        const offset = whole.length; whole += content;
        if (!r.intersectsNode(node)) continue;
        if (formula) {
          if (start == null) start = offset;
          end = offset + content.length; text += content;
          continue;
        }
        const piece = doc.createRange(); piece.selectNodeContents(node);
        if (r.compareBoundaryPoints(0, piece) > 0) piece.setStart(r.startContainer, r.startOffset);
        if (r.compareBoundaryPoints(2, piece) < 0) piece.setEnd(r.endContainer, r.endOffset);
        const value = piece.toString();
        if (!value) continue;
        if (start == null) start = offset + (piece.startContainer === node ? piece.startOffset : 0);
        end = offset + (piece.endContainer === node ? piece.endOffset : node.length);
        text += value;
      }
      if (!text.trim()) continue;
      if (key && key !== lang) return null; // 双语混合选区没有唯一翻译目标。
      key = lang;
      if (firstStart == null) { firstStart = start; prefix = whole.slice(Math.max(0, start - 32), start); }
      suffix = whole.slice(end, end + 32);
      parts.push(text);
      if (!anchors.includes(anchor)) anchors.push(anchor);
      hashes[anchor] = PR.blockById?.[anchor]?.source_hash;
    }
    if (!parts.length) return null;
    const quote = parts.join("\n").trim();
    const box = r.getBoundingClientRect(), fb = frame?.getBoundingClientRect();
    return { body: { anchor: anchors[0], anchors, key, quote, start: firstStart, prefix, suffix, source_hashes: hashes },
      rect: { left: box.left + (fb?.left || 0), top: box.top + (fb?.top || 0), bottom: box.bottom + (fb?.top || 0), width: box.width } };
  }

  function position(rect) {
    const width = Math.min(440, innerWidth - 24);
    card.style.width = width + "px";
    card.style.left = Math.max(12, Math.min(innerWidth - width - 12, rect.left + rect.width / 2 - width / 2)) + "px";
    let top = rect.bottom + 10;
    const bar = PR.$("#selbar") || PR.$("#selectionTools");
    if (top + card.offsetHeight > innerHeight - 12) top = Math.max(12, rect.top - card.offsetHeight - 10);
    if (bar?.classList.contains("open")) {
      const b = bar.getBoundingClientRect(), left = parseFloat(card.style.left);
      if (left < b.right && left + width > b.left && top < b.bottom + 6 && top + card.offsetHeight > b.top - 6) {
        const below = b.bottom + 8, above = b.top - card.offsetHeight - 8;
        top = below + card.offsetHeight <= innerHeight - 12 ? below : Math.max(12, above);
      }
    }
    card.style.top = top + "px";
  }

  // 原选区工具栏在 mouseup 后稍晚定位，跟随它的实际位置避让。
  const selectionBar = PR.$("#selbar") || PR.$("#selectionTools");
  if (selectionBar) new MutationObserver(() => { if (active && !card.hidden) position(active.rect); })
    .observe(selectionBar, { attributes: true, attributeFilter: ["class", "style"] });

  function cancel() {
    clearTimeout(timer); timer = null;
    if (active?.controller) {
      active.controller.abort();
      if (active.rid) PR.api("/api/selection-translation/cancel", { method: "POST", body: { request_id: active.rid } }).catch(() => {});
    }
    active = null; serial++;
  }
  function hide() { cancel(); card.hidden = true; }
  PR.hideSelectionTranslation = hide;
  PR.selectionTranslationState = () => active && ({ ...active.metrics, quote: active.body.quote, text: active.text, phase: active.phase });

  function show(selection, delay) {
    if (!selection || !cfg?.enabled || PR.store?.mode !== "server") return hide();
    const fingerprint = JSON.stringify(selection.body);
    if (active?.fingerprint === fingerprint && !card.hidden) { position(selection.rect); return; }
    cancel();
    const id = serial;
    active = { ...selection, fingerprint, id, metrics: { selected_at: performance.now() }, text: "", phase: "loading" };
    card.hidden = false; card.dataset.phase = "loading";
    result.textContent = "正在翻译…"; status.textContent = "";
    card.querySelector('[data-st="copy"]').disabled = true;
    card.querySelector('[data-st="retry"]').hidden = true;
    card.querySelector(".st-label").textContent = selection.body.key === "zh" && cfg.target_language === "zh-CN" ? "译为英文" : "翻译";
    position(selection.rect);
    active.metrics.popup_ms = performance.now() - active.metrics.selected_at;
    if (delay) timer = setTimeout(() => translate(id, false), delay);
    else translate(id, false);
  }

  async function translate(id, refresh) {
    const current = active;
    if (!current || current.id !== id) return;
    current.controller = new AbortController(); current.rid = PR.uid("st");
    card.dataset.requestId = current.rid;
    current.phase = "loading"; current.text = "";
    result.textContent = "正在翻译…";
    card.querySelector('[data-st="retry"]').hidden = true;
    const started = performance.now(); current.metrics.request_ms = started - current.metrics.selected_at;
    let reader;
    try {
      const response = await fetch("/api/p/" + encodeURIComponent(PR.pid) + "/selection-translation", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ ...current.body, request_id: current.rid, refresh }), signal: current.controller.signal,
      });
      if (!response.ok) { const error = await response.json(); throw Error(error.error || "请求失败 " + response.status); }
      reader = response.body.getReader();
      const decoder = new TextDecoder(); let buffer = "", done = false;
      function consume(line) {
        if (!line.trim() || active !== current) return;
        const ev = JSON.parse(line);
        if (ev.error) throw Error(ev.error);
        if (ev.t) {
          if (!current.text) current.metrics.first_text_ms = performance.now() - current.metrics.selected_at;
          current.text += ev.t; current.phase = "streaming";
          result.textContent = current.text; card.dataset.phase = "streaming";
          position(current.rect);
        }
        if (ev.done) {
          done = true; current.text = ev.text || current.text; current.phase = "done";
          result.textContent = current.text; card.dataset.phase = "done";
          current.metrics.total_ms = performance.now() - current.metrics.selected_at;
          current.metrics.server = ev.timing;
          status.textContent = ev.timing?.cached ? "已缓存" : ev.timing?.reused_existing ? "已有译文" : "已翻译 · " + (current.metrics.total_ms / 1000).toFixed(1) + " 秒";
          card.querySelector('[data-st="copy"]').disabled = false;
          position(current.rect);
        }
      }
      while (true) {
        const chunk = await reader.read();
        if (active !== current) return;
        buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        let at;
        while ((at = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); consume(line); }
        if (chunk.done) { if (buffer.trim()) consume(buffer); break; }
      }
      if (!done && active === current) throw Error("翻译连接中断，请重试");
    } catch (e) {
      if (active !== current || e.name === "AbortError") return;
      current.phase = "error"; card.dataset.phase = "error";
      result.textContent = e.message; status.textContent = "";
      card.querySelector('[data-st="retry"]').hidden = false;
      position(current.rect);
    } finally { if (reader) reader.releaseLock(); }
  }

  card.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
  card.addEventListener("click", (e) => {
    const action = e.target.closest("[data-st]")?.dataset.st;
    if (action === "close") hide();
    else if (action === "copy" && active?.phase === "done") navigator.clipboard.writeText(active.text).then(() => PR.toast("已复制译文"));
    else if (action === "retry" && active) translate(active.id, true);
    else if (action === "settings") { hide(); PR.openSettings("selection"); }
    else if (action === "chat" && active) { const body = active.body; hide(); for (const ref of body.refs || [{ anchor: body.anchor, quote: body.quote }]) PR.chatAsk?.(ref); }
  });

  function attach(doc, frame, readSelection) {
    if (attached.has(doc)) return;
    attached.add(doc);
    doc.addEventListener("mousedown", (e) => {
      if (safeNode(e.target)?.closest("#selectionTranslation,#selbar,#blockbar,#selectionTools")) return;
      dragging = true; hide();
    });
    doc.addEventListener("mouseup", (e) => {
      if (safeNode(e.target)?.closest("#selectionTranslation,#selbar,#blockbar,#selectionTools")) return;
      dragging = false;
      // mouseup 后选区已稳定；下一轮事件读取后立即请求，拖动时仍不请求。
      setTimeout(() => show(readSelection ? readSelection() : read(doc, frame), 0), 0);
    });
    doc.addEventListener("keyup", (e) => {
      if (e.shiftKey && e.key.startsWith("Arrow") || (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") show(readSelection ? readSelection() : read(doc, frame), 150);
    });
    doc.addEventListener("selectionchange", () => {
      if (!dragging && active && doc.defaultView.getSelection().isCollapsed) hide();
    });
    doc.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); }, true);
    doc.addEventListener("scroll", () => { if (active) hide(); }, { passive: true, capture: true });
  }
  PR.attachSelectionTranslation = attach;
  attach(document, null);
  const frame = PR.$("#article");
  if (frame) frame.addEventListener("load", () => { if (frame.contentDocument) attach(frame.contentDocument, frame); });
  window.addEventListener("resize", hide);
  window.addEventListener("pagehide", hide);
  async function configure() {
    if (PR.store?.mode !== "server") return;
    try {
      cfg = (await PR.api("/api/config")).config.selection_translation;
      if (cfg?.enabled) PR.api("/api/selection-translation/warm", { method: "POST", body: {} }).catch(() => {});
    } catch (e) { cfg = null; }
  }
  PR.on("loaded", configure);
  PR.on("settings-saved", () => { hide(); configure(); });
  PR.on("remote", (names) => { if (names.includes("paper")) hide(); });
})(window.PR);
