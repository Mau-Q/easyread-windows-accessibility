/* 脚注只在阅读 DOM 中拆开；下载快照和已存译文字节不变。 */
(function (PR) {
  "use strict";
  const escRE = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let doc, panel, opened, trigger;
  const notes = new Map();

  function close(restoreFocus = false) {
    if (!panel) return;
    panel.hidden = true;
    doc.querySelectorAll('.easyread-footnote-ref[aria-expanded="true"]').forEach((n) => n.setAttribute("aria-expanded", "false"));
    if (restoreFocus) trigger?.focus();
    opened = trigger = null;
  }
  function show(ref) {
    const note = notes.get(ref.dataset.footnote);
    if (!note) return;
    if (opened === note.key && !panel.hidden) return close();
    close(); opened = note.key; trigger = ref;
    PR.hideArticleCitation?.();
    PR.hideArticleXref?.();
    PR.hideSelectionTranslation?.();
    panel.replaceChildren();
    panel.setAttribute("aria-label", "脚注 " + note.label);
    const head = doc.createElement("div"); head.className = "easyread-footnote-head";
    const title = doc.createElement("strong"); title.textContent = "脚注 " + note.label;
    const dismiss = doc.createElement("button"); dismiss.type = "button"; dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "关闭脚注"); dismiss.onclick = () => close(true);
    head.append(title, dismiss); panel.append(head);
    const en = doc.createElement("div"); en.className = "easyread-footnote-en"; en.lang = "en";
    en.append(...Array.from(note.content.cloneNode(true).childNodes)); panel.append(en);
    if (note.zh && note.zh !== note.content.textContent.trim()) {
      const zh = doc.createElement("div"); zh.className = "easyread-footnote-zh"; zh.lang = "zh-CN";
      zh.innerHTML = note.renderHtml(note.zh); panel.append(zh);
    }
    panel.hidden = false; ref.setAttribute("aria-expanded", "true");
    const win = doc.defaultView, box = ref.getBoundingClientRect();
    const width = Math.min(520, win.innerWidth - 24);
    panel.style.width = width + "px";
    panel.style.left = Math.max(12, Math.min(win.innerWidth - width - 12, box.left)) + "px";
    const height = panel.getBoundingClientRect().height;
    const below = box.bottom + 10;
    panel.style.top = Math.max(12, below + height <= win.innerHeight - 12 ? below : box.top - height - 10) + "px";
  }
  PR.attachArticleFootnotes = function (articleDoc) {
    doc = articleDoc; notes.clear(); opened = trigger = null;
    panel = doc.createElement("section"); panel.className = "easyread-footnote-panel";
    panel.id = "easyread-footnote-panel"; panel.hidden = true; panel.setAttribute("role", "dialog");
    doc.body.append(panel);
    doc.querySelectorAll(".ltx_note").forEach((node, i) => {
      const mark = node.querySelector(":scope > .ltx_note_mark"), raw = node.querySelector(".ltx_note_content");
      if (!mark || !raw) return;
      const content = raw.cloneNode(true);
      content.querySelectorAll(".ltx_note_mark,.ltx_tag_note").forEach((n) => n.remove());
      const label = mark.textContent.trim(), key = node.id || "note-" + i;
      const note = { key, label, node, content, zh: "", renderHtml: null };
      // 旧导入把这几个 DOM 标签串在了一起；只按该脚注的真实标签识别。
      note.labels = Array.from(node.querySelectorAll(".ltx_note_mark,.ltx_tag_note"), (n) => n.textContent.trim());
      notes.set(key, note);
      mark.classList.add("easyread-footnote-ref"); mark.dataset.footnote = key;
      mark.tabIndex = 0; mark.setAttribute("role", "button"); mark.setAttribute("aria-label", "查看脚注 " + label);
      mark.setAttribute("aria-expanded", "false"); mark.setAttribute("aria-controls", panel.id);
    });
    doc.addEventListener("click", (e) => {
      const ref = e.target.closest(".easyread-footnote-ref");
      if (ref) { e.preventDefault(); show(ref); }
      else if (!e.target.closest(".easyread-footnote-panel")) close();
    });
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.hidden) { e.preventDefault(); e.stopImmediatePropagation(); close(true); }
      else if (["Enter", " "].includes(e.key) && e.target.matches(".easyread-footnote-ref")) { e.preventDefault(); show(e.target); }
    });
    doc.defaultView.addEventListener("scroll", () => close(), { passive: true });
    doc.defaultView.addEventListener("resize", () => close());
    document.addEventListener("pointerdown", () => close());
  };
  PR.hideArticleFootnote = close;

  function legacySpan(text, note, root) {
    if (note.labels.length < 2) return null;
    const content = note.content.textContent.trim();
    const url = /^https?:\/\/\S+$/.test(content);
    const pattern = note.labels.map(escRE).join("\\s*") + "\\s*" + (url ? "(?=" + escRE(content) + ")" : "(?!\\d)");
    const matches = Array.from(text.matchAll(new RegExp(pattern, "g")));
    if (matches.length !== 1) return null;
    const match = matches[0], start = match.index, bodyStart = start + match[0].length;
    // URL 脚注有精确的末端，正文在脚注之后仍可接着显示。
    if (url && text.startsWith(content, bodyStart)) {
      return { start, end: bodyStart + content.length, zh: content };
    }
    // 说明文字只处理位于原段末尾的脚注；中间位置缺少译文边界时保留全文。
    const range = doc.createRange(); range.setStartAfter(note.node); range.setEnd(root, root.childNodes.length);
    const tail = range.toString().trim();
    if (root.querySelectorAll(".ltx_note").length !== 1 || !/^[.:;!?：；。！？]*$/.test(tail)) return null;
    const last = tail.slice(-1), translated = { ":": "：", ";": "；", ".": "。", "!": "！", "?": "？" }[last];
    const ending = last ? [last, translated].filter(Boolean).find((p) => text.endsWith(p)) : "";
    if (last && !ending) return null;
    const end = text.length - (ending?.length || 0);
    return end > bodyStart ? { start, end, zh: text.slice(bodyStart, end) } : null;
  }
  PR.articleTranslationHtml = function (root, text, renderHtml) {
    const edits = [];
    for (const note of notes.values()) {
      if (!root.contains(note.node)) continue;
      const tagged = new RegExp("\\[FOOTNOTE:" + escRE(note.label) + "\\]([\\s\\S]*?)\\[/FOOTNOTE:" + escRE(note.label) + "\\]", "g");
      const matches = Array.from(String(text).matchAll(tagged));
      const match = matches.length === 1 ? matches[0] : null;
      const span = match ? { start: match.index, end: match.index + match[0].length, zh: match[1] } : legacySpan(text, note, root);
      note.zh = span?.zh || ""; note.renderHtml = renderHtml;
      if (span) edits.push({ ...span, note });
    }
    let body = String(text || "");
    edits.sort((a, b) => b.start - a.start).forEach((edit, i) => {
      edit.token = "⟦EASYREAD-FOOTNOTE-" + i + "⟧";
      body = body.slice(0, edit.start) + edit.token + body.slice(edit.end);
    });
    let html = renderHtml(body);
    for (const edit of edits) {
      html = html.replace(edit.token, '<sup><button type="button" class="easyread-footnote-ref" data-footnote="' + PR.esc(edit.note.key) + '" aria-label="查看脚注 ' + PR.esc(edit.note.label) + '" aria-expanded="false" aria-controls="easyread-footnote-panel">' + PR.esc(edit.note.label) + '</button></sup>');
    }
    return html;
  };
})(window.PR);
