/* Shared modal lifecycle. Native dialog elements retain their own browser behavior. */
(() => {
  'use strict';
  const focusable = 'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"],[contenteditable="true"]';
  const visible = e => !e.closest('[inert],[hidden]') && e.getClientRects().length;
  const controls = root => [...root.querySelectorAll(focusable)].filter(visible);
  const frames = new Map();
  let blocked = new Map(), lastFocus = null, serial = 0;
  const label = (e, text) => { if (text && !e.hasAttribute('aria-label') && !e.hasAttribute('aria-labelledby')) e.setAttribute('aria-label', text); };
  function enhance() {
    document.querySelectorAll('button[title]').forEach(e => { const t=e.textContent.trim();if (!t || /^[×✕‹›⋯…☰]$/.test(t)) label(e, e.title); });
    document.querySelectorAll('.card textarea').forEach(e=>label(e,'批注内容'));
    const colors={yellow:'黄色',green:'绿色',blue:'蓝色',pink:'红色'};
    document.querySelectorAll('button[data-color]').forEach(e=>{if(!e.hasAttribute('aria-label')||e.getAttribute('aria-label')==='换颜色')e.setAttribute('aria-label',(colors[e.dataset.color]||e.dataset.color)+'划线');e.setAttribute('aria-pressed',String(e.classList.contains('on')));});
    const drawerTabs=document.querySelector('.drawer-tabs');
    if(drawerTabs){drawerTabs.setAttribute('role','group');drawerTabs.setAttribute('aria-label','目录信息');drawerTabs.querySelectorAll('button').forEach(e=>e.setAttribute('aria-pressed',String(e.classList.contains('on'))));}
    const names = {q:'搜索标题、作者',paperNote:'论文笔记',firstN:'翻译前几页',webScope:'网页翻译范围',chatInput:'问题',nativeModel:'翻译模型连接',catInput:'新建并加入分类'};
    for (const [id, name] of Object.entries(names)) { const e = document.getElementById(id); if (e) label(e, name); }
    document.querySelectorAll('input,textarea,select,[contenteditable="true"]').forEach(e => {
      if (e.labels?.length || e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby') || e.type === 'hidden') return;
      const field = e.closest('.field'), title = field?.querySelector(':scope > span');
      if (title) { title.id ||= 'field-label-' + (++serial); e.setAttribute('aria-labelledby',title.id); }
    });
    document.querySelectorAll('.seg button[data-np],.np-filters button,.set-tabs button,[data-scope]').forEach(e => e.setAttribute('aria-pressed',String(e.classList.contains('on'))));
    document.querySelectorAll('[data-status],[data-cattoggle],.srow[data-view],.srow[data-cat]').forEach(e => e.setAttribute('aria-pressed',String(e.classList.contains('on'))));
    document.querySelectorAll('.ch-thread-open').forEach(e=>e.setAttribute('aria-pressed',String(e.parentElement.classList.contains('on'))));
    document.querySelectorAll('[data-c="list"]').forEach(e=>e.setAttribute('aria-expanded',String(!!e.closest('#chatpanel')?.querySelector('.ch-list'))));
    const metaNames={title_en:'英文题名',title_zh:'中文题名',authors:'作者',year:'年份',venue:'出处',url:'链接'};
    document.querySelectorAll('[contenteditable="plaintext-only"],[contenteditable="true"]').forEach(e=>{
      e.setAttribute('role','textbox');
      if(e.dataset.meta) label(e,metaNames[e.dataset.meta]);
    });
    document.querySelectorAll('.dialog-backdrop .dialog,.popover.confirm').forEach(e => {
      e.setAttribute('role','dialog');
      const h = e.querySelector('h1,h2,h3,.cf-title');
      if(h && !e.hasAttribute('aria-label')) { h.id ||= 'dialog-title-' + (++serial); e.setAttribute('aria-labelledby',h.id); }
    });
  }
  function restore(e) {
    if(e?.isConnected && visible(e)) e.focus({preventScroll:true});
    else if(e?.id) document.getElementById(e.id)?.focus({preventScroll:true});
    else document.querySelector('#list,#readingControls,main a,main button')?.focus({preventScroll:true});
  }
  function sync() {
    enhance();
    if(lastFocus && !lastFocus.isConnected && document.activeElement === document.body) {
      let replacement = lastFocus.id && document.getElementById(lastFocus.id);
      if(!replacement) for(const [key,value] of Object.entries(lastFocus.dataset || {})) {
        const attr='data-'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());
        replacement=document.querySelector('['+attr+'="'+CSS.escape(value)+'"]');
        if(replacement) break;
      }
      if(replacement && visible(replacement)) replacement.focus({preventScroll:true});
    }
    document.querySelectorAll('.dialog-backdrop').forEach(e => { e.inert = !e.classList.contains('open'); });
    const open = [...document.querySelectorAll('.dialog-backdrop.open > .dialog,.popover.confirm.open')];
    for (const [box, saved] of frames) if(!open.includes(box)) {
      frames.delete(box); box.removeAttribute('aria-modal');
      for(const [e, inert] of blocked) e.inert = inert;
      blocked.clear(); restore(saved);
    }
    for(const box of open) if(!frames.has(box)) {
      frames.set(box, lastFocus || document.activeElement);
      box.setAttribute('aria-modal','true'); box.tabIndex = -1;
      (controls(box)[0] || box).focus();
    }
    const top = [...frames.keys()].at(-1);
    for(const [e, inert] of blocked) e.inert = inert;
    blocked.clear();
    if(top) {
      // Inert siblings along the full ancestor chain, including nested dialogs.
      let branch = top;
      while(branch.parentElement) {
        for(const e of branch.parentElement.children) if(e !== branch && e.tagName !== 'SCRIPT' && !e.inert) {
          blocked.set(e,false); e.inert = true;
        }
        branch = branch.parentElement;
        if(branch === document.body) break;
      }
      if(!top.contains(document.activeElement)) (controls(top)[0] || top).focus();
    }
  }
  document.addEventListener('focusin', e => { lastFocus = e.target; });
  document.addEventListener('keydown', e => {
    const top = [...frames.keys()].at(-1);
    if(!top || e.isComposing) return;
    if(e.key==='Escape'&&document.querySelector('#ctxmenu.open')){
      e.preventDefault();e.stopImmediatePropagation();window.PR?.closeMenu();return;
    }
    if(e.key === 'Tab') {
      const list = controls(top), i = list.indexOf(document.activeElement);
      if(!list.length) { e.preventDefault(); top.focus(); }
      else if(e.shiftKey && i <= 0) { e.preventDefault(); list.at(-1).focus(); }
      else if(!e.shiftKey && (i < 0 || i === list.length-1)) { e.preventDefault(); list[0].focus(); }
    }
    if(e.key === 'Escape' && !top.classList.contains('confirm')) {
      e.preventDefault(); e.stopImmediatePropagation();
      // Use the existing cancel handler so drafts/preview cleanup still runs.
      const cancel = top.querySelector('#setCancel,#impClose,[data-close],[data-act="cancel"],.actions button');
      if(cancel) cancel.click(); else top.closest('.dialog-backdrop')?.classList.remove('open');
    }
  },true);
  new MutationObserver(sync).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden']});
  sync();
})();
