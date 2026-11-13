/* 图表和公式预览只克隆原内容，不读取译文，也不改变正文锚点。 */
(function (PR) {
  "use strict";
  let preview, serial = 0;
  const visual = "figure,.ltx_figure,.ltx_table,.ltx_equation,.ltx_equationgroup";
  function cloneOriginal(doc, original) {
    const clone = original.cloneNode(true), svgIds = new Map();
    clone.querySelectorAll(".easyread-zh,.easyread-visual-controls,.easyread-note-pin,.easyread-image-error").forEach(n => n.remove());
    clone.querySelectorAll("mark.easyread-mark").forEach(n => n.replaceWith(...n.childNodes));
    const nodes = [clone, ...clone.querySelectorAll("*")];
    // SVG 的 clipPath、use 等必须保留内部引用，但不能复制正文的 id。
    for (const n of nodes) if (n.id && n.namespaceURI === "http://www.w3.org/2000/svg") {
      svgIds.set(n.id, "easyread-preview-svg-" + (++serial));
    }
    const rewriteUrls = value => value.replace(/url\(\s*(['"]?)#([^\s)'" ]+)\1\s*\)/g,
      (all, quote, key) => svgIds.has(key) ? "url(#" + svgIds.get(key) + ")" : all);
    for (const n of nodes) {
      const id = svgIds.get(n.id);
      if (id) n.id = id; else n.removeAttribute("id");
      ["data-easyread-id", "data-anchor", "aria-details"].forEach(a => n.removeAttribute(a));
      Array.from(n.classList).filter(c => c.startsWith("easyread-visual") || c === "easyread-focus").forEach(c => n.classList.remove(c));
      for (const attr of Array.from(n.attributes)) {
        let value = rewriteUrls(attr.value);
        if (n.namespaceURI === "http://www.w3.org/2000/svg" && ["href", "xlink:href"].includes(attr.name) && svgIds.has(value.slice(1))) value = "#" + svgIds.get(value.slice(1));
        if (value !== attr.value) n.setAttributeNS(attr.namespaceURI, attr.name, value);
      }
      if (n.namespaceURI === "http://www.w3.org/2000/svg" && n.localName === "style") n.textContent = rewriteUrls(n.textContent);
    }
    // 公式锚点可能落在 tr/td 内：展示完整的原公式表，保留多行推导。
    return clone;
  }
  PR.attachArticleXrefs = function (doc) {
    preview?.detach();
    preview = PR.createArticlePreview(doc, {
      id: "easyread-xref-panel", className: "easyread-xref-panel", label: "图表与公式原文预览", width: 680,
      reference(target) {
        const link = target?.closest?.('a[href^="#"]');
        if (!link || !link.closest("article.ltx_document") ||
            link.closest(".easyread-zh,.ltx_cite,.ltx_bibliography,.ltx_note")) return null;
        let key;
        try { key = decodeURIComponent(link.getAttribute("href").slice(1)); } catch (_) { return null; }
        const node = doc.getElementById(key);
        let item = node?.closest(visual);
        if (!item || !item.closest("article.ltx_document")) return null;
        if (item.matches(".ltx_equation,.ltx_equationgroup")) item = item.closest("table.ltx_eqn_table") || item;
        return { link, item };
      },
      beforeShow() { PR.hideArticleFootnote?.(); PR.hideArticleCitation?.(); PR.hideSelectionTranslation?.(); },
      render(ref) {
        const content = doc.createElement("div"); content.className = "easyread-xref-content";
        const head = doc.createElement("div"); head.className = "easyread-xref-head";
        head.textContent = ref.link.textContent.trim().slice(0, 120) + " · 原文预览";
        content.append(head, cloneOriginal(doc, ref.item)); return content;
      }
    });
    PR.hideArticleXref = preview.close;
  };
})(window.PR);
