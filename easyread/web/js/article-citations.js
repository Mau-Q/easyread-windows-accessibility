/* 原文引用悬停预览：展示本地文末条目，不改论文快照或译文。 */
(function (PR) {
  "use strict";
  // 引用和图表共用悬停行为，各自解析原文目标、生成预览内容。
  PR.createArticlePreview = function (doc, options) {
    const win = doc.defaultView, listeners = [];
    const panel = doc.createElement("section");
    panel.id = options.id;
    panel.className = options.className;
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", options.label);
    doc.body.append(panel);
    let trigger = null, openTimer, closeTimer;
    const listen = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      listeners.push(() => target.removeEventListener(type, handler, options));
    };
    const clearTimers = () => { win.clearTimeout(openTimer); win.clearTimeout(closeTimer); };
    const hasSelection = () => {
      const selection = win.getSelection();
      return selection && selection.rangeCount > 0 && !selection.isCollapsed;
    };
    function close() {
      clearTimers();
      if (trigger) trigger.removeAttribute("aria-details");
      trigger = null;
      panel.hidden = true;
    }
    const reference = options.reference;
    function show(ref) {
      if (!ref.link.isConnected || hasSelection()) return close();
      clearTimers();
      if (trigger && trigger !== ref.link) trigger.removeAttribute("aria-details");
      trigger = ref.link;
      options.beforeShow();
      panel.replaceChildren(options.render(ref));
      panel.scrollTop = 0;
      panel.hidden = false;
      trigger.setAttribute("aria-details", panel.id);
      position();
    }
    function position() {
      if (panel.hidden || !trigger?.isConnected) return;
      const box = trigger.getBoundingClientRect(), margin = 12;
      const width = Math.min(options.width || 520, Math.max(0, win.innerWidth - margin * 2));
      panel.style.width = width + "px";
      panel.style.left = Math.max(margin, Math.min(win.innerWidth - width - margin, box.left)) + "px";
      const height = panel.getBoundingClientRect().height;
      const below = box.bottom + 8;
      panel.style.top = Math.max(margin, Math.min(win.innerHeight - height - margin,
        below + height <= win.innerHeight - margin ? below : box.top - height - 8)) + "px";
    }
    function scheduleClose() {
      win.clearTimeout(openTimer);
      win.clearTimeout(closeTimer);
      closeTimer = win.setTimeout(close, 220);
    }
    listen(doc, "pointerover", (e) => {
      if (e.pointerType === "touch" || e.buttons) return;
      if (panel.contains(e.target)) { clearTimers(); return; }
      const ref = reference(e.target);
      if (!ref) return;
      if (trigger === ref.link && !panel.hidden) { clearTimers(); return; }
      close();
      openTimer = win.setTimeout(() => show(ref), 300);
    });
    listen(doc, "pointerout", (e) => {
      const ref = reference(e.target);
      if (!ref && !panel.contains(e.target)) return;
      if (panel.contains(e.relatedTarget) || ref?.link.contains(e.relatedTarget)) return;
      scheduleClose();
    });
    listen(doc, "focusin", (e) => {
      if (panel.contains(e.target)) { clearTimers(); return; }
      const ref = reference(e.target);
      if (ref) show(ref);
    });
    listen(doc, "focusout", (e) => {
      if ((reference(e.target) || panel.contains(e.target)) && !panel.contains(e.relatedTarget)) scheduleClose();
    });
    listen(doc, "pointerdown", (e) => { if (!panel.contains(e.target)) close(); });
    listen(doc, "click", (e) => { if (!panel.contains(e.target)) close(); });
    const escape = (e) => {
      if (e.key !== "Escape") return;
      const visible = !panel.hidden;
      close();
      if (visible) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    listen(doc, "keydown", escape);
    listen(document, "keydown", escape, true);
    listen(doc, "selectionchange", () => { if (hasSelection()) close(); });
    listen(doc, "dragstart", close);
    listen(win, "scroll", close, { passive: true });
    listen(win, "resize", close);
    listen(document, "pointerdown", close);
    // 图片较晚加载时重新定位，避免浮窗越过视口下沿。
    listen(panel, "load", position, true);
    return { close, detach: () => { close(); listeners.forEach((remove) => remove()); panel.remove(); } };
  };

  let preview;
  PR.attachArticleCitations = function (doc) {
    preview?.detach();
    preview = PR.createArticlePreview(doc, {
      id: "easyread-citation-panel", className: "easyread-citation-panel", label: "参考文献预览",
      reference(target) {
        const link = target?.closest?.(".ltx_cite a[href]");
        if (!link || !link.closest("article.ltx_document") ||
            link.closest(".easyread-zh,.ltx_bibliography,.ltx_biblist,.ltx_note")) return null;
        const href = link.getAttribute("href");
        if (!href.startsWith("#")) return null;
        let key;
        try { key = decodeURIComponent(href.slice(1)); } catch (_) { return null; }
        const item = doc.getElementById(key)?.closest(".ltx_bibitem");
        return item ? { link, item } : null;
      },
      beforeShow() { PR.hideArticleFootnote?.(); PR.hideArticleXref?.(); PR.hideSelectionTranslation?.(); },
      render(ref) {
        const item = ref.item.cloneNode(true);
        // 克隆节点的 id 会干扰原有锚点跳转；内容和 href 保持原样。
        item.removeAttribute("id");
        item.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
        const list = doc.createElement("ul"); list.className = "easyread-citation-entry";
        list.append(item); return list;
      }
    });
    PR.hideArticleCitation = preview.close;
  };
})(window.PR);
