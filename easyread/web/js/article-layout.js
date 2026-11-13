/* 通用图表阅读层。保留原节点和译文，只增加容器、样式与查看控件。 */
(function (PR) {
  "use strict";
  const installed = new WeakMap();
  const topologies = new WeakMap();
  const watchedImages = new WeakSet();
  const controls = '.easyread-visual-controls, .easyread-note-pin, .easyread-visual-dialog';

  // 验证的是阅读层优化前后的内容；不是 PDF 到 HTML 转换或翻译的正确性。
  PR.articleFingerprint = function (doc) {
    const article = doc.querySelector('article.ltx_document');
    if (!article) return null;
    const copy = article.cloneNode(true);
    copy.querySelectorAll(controls + ', .easyread-zh').forEach((n) => n.remove());
    copy.querySelectorAll('mark.easyread-mark').forEach((n) => n.replaceWith(...n.childNodes));
    copy.querySelectorAll('[data-easyread-layout-wrapper]').forEach((n) => n.replaceWith(...n.childNodes));
    copy.querySelectorAll('*').forEach((n) => {
      const classes = Array.from(n.classList).filter((c) => !c.startsWith('easyread-visual') && c !== 'easyread-focus');
      if (classes.length) n.setAttribute('class', classes.join(' ')); else n.removeAttribute('class');
    });
    copy.normalize();
    return copy.outerHTML;
  };

  function button(doc, text, act, title) {
    const b = doc.createElement('button'); b.type = 'button'; b.textContent = text;
    b.dataset.visualAction = act; b.title = title || text; return b;
  }
  function modal(doc, original, opener) {
    doc.querySelector('.easyread-visual-dialog')?.remove();
    const dlg = doc.createElement('dialog'); dlg.className = 'easyread-visual-dialog';
    dlg.setAttribute('aria-label', '图表放大查看');
    const bar = doc.createElement('div'); bar.className = 'easyread-visual-dialog-bar';
    const label = doc.createElement('span'); label.textContent = '图表原内容'; bar.append(label);
    ['缩小', '100%', '放大', '关闭'].forEach((text, i) => bar.append(button(doc, text, ['minus', 'fit', 'plus', 'close'][i])));
    const viewport = doc.createElement('div'); viewport.className = 'easyread-visual-viewport';
    const content = doc.createElement('div'); content.className = 'easyread-visual-dialog-content';
    const clone = original.cloneNode(true);
    clone.querySelectorAll(controls).forEach((n) => n.remove());
    [clone, ...clone.querySelectorAll('[id]')].forEach((n) => n.removeAttribute('id'));
    content.append(clone); viewport.append(content); dlg.append(bar, viewport); doc.body.append(dlg);
    let scale = 1;
    const close = () => { dlg.close(); dlg.remove(); opener.focus({ preventScroll: true }); };
    bar.onclick = (e) => {
      const action = e.target.closest('[data-visual-action]')?.dataset.visualAction;
      if (!action) return;
      if (action === 'close') return close();
      scale = action === 'fit' ? 1 : Math.max(.5, Math.min(3, scale + (action === 'plus' ? .25 : -.25)));
      content.style.zoom = scale; bar.querySelector('[data-visual-action="fit"]').textContent = Math.round(scale * 100) + '%';
    };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    dlg.showModal();
    // 固定未缩放时的内容宽度，避免响应式图片随 zoom 缩回视口宽度。
    content.style.width = Math.max(600, viewport.clientWidth - 36) + 'px';
  }

  PR.layoutArticle = function (doc, showZh = true) {
    const article = doc.querySelector('article.ltx_document'); if (!article) return;
    if (!installed.has(doc)) installed.set(doc, new Map());
    const states = installed.get(doc);
    // 有些论文的图是 SVG、代码块或嵌套表格，仍使用原节点。
    let figures = topologies.get(article);
    if (!figures) {
      figures = Array.from(article.querySelectorAll('figure, .ltx_figure, .ltx_table'))
        .filter((n) => !n.parentElement.closest('figure, .ltx_figure, .ltx_table'));
      article.querySelectorAll('table.ltx_tabular').forEach((table) => {
        if (!table.parentElement.classList.contains('easyread-table-scroll')) {
          const scroll = doc.createElement('div'); scroll.className = 'easyread-table-scroll';
          scroll.dataset.easyreadLayoutWrapper = ''; table.before(scroll); scroll.append(table);
        }
        if (!table.closest('figure, .ltx_figure, .ltx_table')) {
          const scroll = table.parentElement;
          if (!scroll.parentElement.classList.contains('easyread-visual')) {
            const box = doc.createElement('div'); box.dataset.easyreadLayoutWrapper = ''; box.className = 'easyread-visual';
            scroll.before(box); box.append(scroll);
            const zh = scroll.nextElementSibling || box.nextElementSibling;
            if (zh?.classList.contains('easyread-zh')) box.append(zh);
          }
          figures.push(scroll.parentElement);
        }
      });
      figures = [...new Set(figures)];
      topologies.set(article, figures);
    }
    for (const figure of figures) {
      figure.classList.add('easyread-visual');
      let state = states.get(figure);
      if (!state) {
        state = { mode: figure.querySelector('table.ltx_tabular') ? 'en' : 'bi' }; states.set(figure, state);
        const bar = doc.createElement('div'); bar.className = 'easyread-visual-controls';
        bar.setAttribute('aria-label', '图表查看方式');
        if (figure.querySelector('table.ltx_tabular')) {
          [['原表', 'en'], ['对照已有译表', 'bi']].forEach(([text, act]) => bar.append(button(doc, text, act)));
        }
        bar.append(button(doc, '放大查看', 'expand', '放大原图表，可缩放和平移'));
        figure.prepend(bar);
        bar.onclick = (e) => {
          const b = e.target.closest('[data-visual-action]'); if (!b) return;
          const act = b.dataset.visualAction;
          if (act === 'expand') return modal(doc, figure, b);
          state.mode = act; PR.layoutArticle(doc, true);
        };
      }
      const translated = !!figure.querySelector(figure.querySelector('table.ltx_tabular') ? '.easyread-zh:not([hidden]) table' : '.easyread-zh:not([hidden])');
      figure.querySelectorAll('.easyread-zh').forEach((zh) => zh.classList.toggle('easyread-table-translation', !!zh.querySelector('table')));
      const mode = showZh && translated ? state.mode : 'en';
      figure.classList.toggle('easyread-visual-en', mode === 'en');
      figure.classList.toggle('easyread-visual-zh', mode === 'zh');
      figure.querySelectorAll(':scope > .easyread-visual-controls button').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.visualAction === mode));
        b.disabled = ['zh', 'bi'].includes(b.dataset.visualAction) && (!showZh || !translated);
      });
      figure.querySelectorAll('img').forEach((img) => {
        if (watchedImages.has(img)) return;
        watchedImages.add(img);
        let message;
        const failed = () => {
          if (message) return;
          message = doc.createElement('span'); message.className = 'easyread-image-error';
          message.textContent = '原图加载失败 · ';
          const link = doc.createElement('a'); link.href = img.src; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '打开原图 ↗';
          message.append(link); figure.querySelector(':scope > .easyread-visual-controls').prepend(message);
        };
        img.addEventListener('error', failed);
        img.addEventListener('load', () => { message?.remove(); message = null; });
        if (img.complete && !img.naturalWidth) failed();
      });
    }
  };
  PR.revealVisualTranslations = function (doc) {
    for (const state of installed.get(doc)?.values() || []) state.mode = 'bi';
  };
  PR.restoreVisualAssets = function (doc, assets) {
    for (const asset of assets || []) {
      const parent = doc.getElementById(asset.parent);
      if (!parent || (asset.id && doc.getElementById(asset.id))) continue;
      if (Array.from(parent.querySelectorAll('img')).some((img) => img.src === asset.src)) continue;
      const img = doc.createElement('img'); img.src = asset.src; img.alt = ''; img.className = asset.class || '';
      if (asset.id) img.id = asset.id;
      if (asset.width) img.width = +asset.width;
      if (asset.height) img.height = +asset.height;
      img.dataset.easyreadRestoredGraphic = 'source-snapshot'; parent.prepend(img);
    }
  };
})(window.PR);
