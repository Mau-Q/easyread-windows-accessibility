/* Opt-in chrome for the native PDF and arXiv readers. No reading-state writes. */
(() => {
  'use strict';
  const PR=window.PR, bar=document.getElementById('readerBar'), trigger=document.getElementById('readingControls');
  if(!bar||!trigger)return;
  if(PR.openSide) {
    const openSide=PR.openSide; let origin;
    PR.openSide=function(side) {
      if(side && side!==PR.side) origin=document.activeElement;
      const result=openSide.apply(this,arguments);
      requestAnimationFrame(()=>{
        if(side && PR.side===side) document.getElementById(side==='notes'?'notespanel':'chatpanel')?.querySelector('button,textarea,input')?.focus();
        else if(!side && !PR.side) {
          const target=origin?.isConnected ? origin : document.getElementById('notesBtn');
          if(bar.contains(target)) show(true);
          target?.focus();
        }
      });
      return result;
    };
  }
  let timer, over=false, keyboard=false;
  const attached=new WeakSet();
  const held=()=>over||bar.querySelector('details[open]')||document.querySelector('#readerThemePicker:not([hidden])')||
    (!document.getElementById('translationTools')?.hidden&&document.getElementById('translationTools'))||
    (bar.contains(document.activeElement)&&(keyboard||document.activeElement.matches('input,select,textarea')));
  function show(open){
    clearTimeout(timer);
    if(!open){bar.querySelectorAll('details[open]').forEach(d=>d.open=false);PR.closeReaderThemePicker?.();const tools=document.getElementById('translationTools');if(tools){tools.hidden=true;document.getElementById('translateBtn')?.setAttribute('aria-expanded','false');}}
    document.body.classList.toggle('controls-hidden',!open);bar.inert=!open;
    trigger.setAttribute('aria-expanded',String(open));
    if(!open&&bar.contains(document.activeElement))trigger.focus({preventScroll:true});
  }
  function leave(){clearTimeout(timer);timer=setTimeout(()=>{if(!held())show(false);},350);}
  function move(e){
    let y=e.clientY,win=e.view||e.target.ownerDocument.defaultView;
    try{while(win&&win!==window){const f=win.frameElement;if(!f)break;y+=f.getBoundingClientRect().top;win=f.ownerDocument.defaultView;}}catch{return;}
    if(y<=10){show(true);return;}
    over=bar.contains(e.target)||!!e.target.closest?.('#readerThemePicker,#translationTools');
    if(over)clearTimeout(timer);else leave();
  }
  function attach(doc){
    if(!doc||attached.has(doc))return;attached.add(doc);
    doc.addEventListener('pointermove',move,{passive:true});
    doc.addEventListener('keydown',e=>{
      if(e.key==='Tab')keyboard=true;
      if(e.key==='F6'&&!e.ctrlKey&&!e.altKey&&!e.metaKey){
        e.preventDefault();e.stopPropagation();keyboard=true;
        const regions=[{owns:bar.contains(e.target)||e.target===trigger,focus:()=>{show(true);bar.querySelector('a,button')?.focus();}}];
        for(const [side,pane] of Object.entries(window.Dual?.panes||{})){
          const frame=document.getElementById(side+'Frame');if(!frame||!frame.getClientRects().length)continue;
          const target=pane.document.querySelector('.page[data-page-number="'+((Dual.views[side].pageIndex||0)+1)+'"] .textLayer')||pane.document.querySelector('.textLayer');
          if(target)regions.push({owns:e.target.ownerDocument===pane.document||e.target===frame,focus:()=>target.focus()});
        }
        const article=document.getElementById('article');
        if(article?.contentDocument?.body)regions.push({owns:e.target.ownerDocument===article.contentDocument||e.target===article,focus:()=>article.contentDocument.body.focus()});
        for(const id of ['selectionTools','selbar','notespanel','chatpanel','reportpanel']){
          const panel=document.getElementById(id);if(!panel||panel.inert||panel.hidden||!panel.getClientRects().length)continue;
          if(getComputedStyle(panel).visibility==='hidden')continue;
          const first=panel.querySelector('button,input,textarea');if(first)regions.push({owns:panel.contains(e.target),focus:()=>first.focus()});
        }
        const current=regions.findIndex(r=>r.owns),next=(current+(e.shiftKey?-1:1)+regions.length)%regions.length;
        regions[next].focus();return;
      }
      if(e.key==='Escape'&&!e.defaultPrevented&&!document.querySelector('dialog[open],.dialog-backdrop.open,.popover.confirm.open')){
        if(PR.side&&e.target.closest('#notespanel,#chatpanel,#reportpanel')){e.preventDefault();PR.openSide(null);}
        else if(!e.target.closest('input,textarea,[contenteditable]'))show(false);
      }
    });
    doc.addEventListener('pointerdown',()=>{keyboard=false;});
    doc.querySelectorAll('iframe').forEach(f=>{f.addEventListener('load',()=>{try{attach(f.contentDocument);}catch{}});try{attach(f.contentDocument);}catch{}});
  }
  function setModes(modes){
    if(modes.length<2)return;
    const old=bar.querySelector('.reader-mode');if(!old)return;
    const menu=document.createElement('details');menu.className='reader-more reader-mode reader-mode-menu';
    const summary=document.createElement('summary');summary.textContent=modes.find(m=>m.current)?.label+' ▾';summary.setAttribute('aria-label','切换阅读方式');menu.append(summary);
    const list=document.createElement('div');list.className='reader-menu';
    for(const mode of modes){const link=document.createElement('a');link.className='btn';link.textContent=mode.label+(mode.current?' ✓':'');link.href=mode.href;if(mode.current)link.setAttribute('aria-current','page');list.append(link);}
    menu.append(list);old.replaceWith(menu);menu.addEventListener('toggle',leave);
  }
  PR.readerShell={show,attach,setModes};attach(document);
  bar.addEventListener('pointerenter',()=>{over=true;show(true);});bar.addEventListener('pointerleave',()=>{over=false;leave();});
  bar.addEventListener('focusout',leave);bar.addEventListener('toggle',leave,true);
  trigger.onclick=()=>{keyboard=true;show(true);bar.querySelector('a,button')?.focus();};
  document.getElementById('hideControls').onclick=()=>{over=false;show(false);};
  document.querySelector('.reader-edge').addEventListener('pointerenter',()=>show(true));
  new MutationObserver(()=>{
    for(const [id,cls] of [['notesBtn','np-open'],['chatBtn','ch-open']])document.getElementById(id)?.setAttribute('aria-expanded',String(document.body.classList.contains(cls)));
  }).observe(document.body,{attributes:true,attributeFilter:['class']});
  const panes=document.getElementById('pdfPanes');
  if(panes){
    const divider=document.createElement('div');divider.className='reader-divider';divider.tabIndex=0;
    divider.setAttribute('role','separator');divider.setAttribute('aria-orientation','vertical');divider.setAttribute('aria-label','调整原文与译文宽度，双击恢复均分');
    divider.setAttribute('aria-valuemin','30');divider.setAttribute('aria-valuemax','70');panes.append(divider);
    const key='easyread-pdf-split:'+location.pathname;let ratio=.5;
    function resize(value,save=false){ratio=Math.max(.3,Math.min(.7,value));panes.style.setProperty('--split-ratio',(ratio*100)+'%');divider.setAttribute('aria-valuenow',String(Math.round(ratio*100)));if(save)try{localStorage.setItem(key,String(ratio));}catch{}}
    try{const saved=Number(localStorage.getItem(key));resize(saved>=.3&&saved<=.7?saved:.5);}catch{resize(.5);}
    divider.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();divider.setPointerCapture(e.pointerId);document.body.classList.add('reader-resizing');};
    divider.onpointermove=e=>{if(!divider.hasPointerCapture(e.pointerId))return;const rect=panes.getBoundingClientRect();resize((e.clientX-rect.left)/rect.width);};
    divider.onlostpointercapture=()=>{document.body.classList.remove('reader-resizing');resize(ratio,true);};
    divider.onpointerup=e=>{if(divider.hasPointerCapture(e.pointerId))divider.releasePointerCapture(e.pointerId);};
    divider.ondblclick=()=>resize(.5,true);
    divider.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home'].includes(e.key)){e.preventDefault();resize(e.key==='Home'?.5:ratio+(e.key==='ArrowLeft'?-.02:.02),true);}};
  }
  show(false);
})();
