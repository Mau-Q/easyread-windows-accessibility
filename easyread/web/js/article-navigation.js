/* HTML 阅读位置栈：保留段落的屏幕偏移，支持连续跳转后逐次返回。 */
(function (PR) {
  "use strict";
  let detach = () => {};
  PR.attachArticleNavigation = function (doc) {
    detach();
    const win = doc.defaultView, stack = [], listeners = [];
    const button = document.createElement("button");
    button.id = "articleJumpBack"; button.className = "btn article-jump-back";
    button.type = "button"; button.hidden = true;
    button.title = "返回跳转前的阅读位置（Alt + ←）";
    document.body.append(button);
    const listen = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      listeners.push(() => target.removeEventListener(type, handler, options));
    };
    const nodeFor = id => id && doc.querySelector('[data-easyread-id="' + CSS.escape(id) + '"]');
    function show() {
      const spot = stack[stack.length - 1];
      button.hidden = !spot;
      if (spot) button.textContent = "← 返回刚才读的地方" + (stack.length > 1 ? "（" + stack.length + "）" : "");
    }
    function remember(target, source) {
      if (!target?.isConnected || target.ownerDocument !== doc) return;
      const r = target.getBoundingClientRect();
      if (r.bottom > 0 && r.top < win.innerHeight) return;
      const sourceNode = source?.closest('[data-easyread-id]');
      const id = sourceNode?.dataset.easyreadId || PR.readingBlock(), node = sourceNode || nodeFor(id);
      stack.push({ id, offset: node?.getBoundingClientRect().top, x: win.scrollX, y: win.scrollY, hash: win.location.hash });
      if (stack.length > 30) stack.shift();
      show();
    }
    function goBack() {
      const spot = stack.pop();
      if (!spot) return;
      PR.hideArticleCitation?.(); PR.hideArticleXref?.(); PR.hideArticleFootnote?.(); PR.hideSelectionTranslation?.();
      const node = nodeFor(spot.id);
      const y = node && spot.offset != null ? win.scrollY + node.getBoundingClientRect().top - spot.offset : spot.y;
      try { win.history.replaceState(win.history.state, "", win.location.pathname + win.location.search + spot.hash); } catch (_) {}
      win.scrollTo({ left: spot.x, top: y, behavior: "instant" });
      win.focus(); show();
    }
    listen(button, "click", goBack);
    // 不接管原链接：浏览器仍执行原来的锚点跳转和 hash 历史。
    listen(doc, "click", e => {
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || win.getSelection()?.toString()) return;
      const link = e.target.closest?.('a[href^="#"]');
      const targetWindow = link?.getAttribute("target");
      if (!link || link.hasAttribute("download") || (targetWindow && targetWindow !== "_self")) return;
      let key;
      try { key = decodeURIComponent(link.getAttribute("href").slice(1)); } catch (_) { return; }
      const target = doc.getElementById(key);
      if (target?.closest("article.ltx_document")) remember(target, link);
    }, true);
    const keydown = e => {
      if (e.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === "ArrowLeft" && stack.length) {
        e.preventDefault(); e.stopImmediatePropagation(); goBack();
      }
    };
    listen(doc, "keydown", keydown, true);
    listen(document, "keydown", keydown, true);
    PR.rememberArticleSpot = remember;
    detach = () => { listeners.forEach(remove => remove()); button.remove(); stack.length = 0; };
  };
})(window.PR);
