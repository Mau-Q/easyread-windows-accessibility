/* A focus-independent selection cue. It never modifies paper text or persisted notes. */
(() => {
  'use strict';
  const records=new Map(),attached=new WeakSet();
  function clear(){for(const [doc,r] of records){doc.defaultView.CSS?.highlights?.delete('easyread-active-selection');r.dispose?.();r.overlay?.remove();}records.clear();}
  function attach(doc){if(attached.has(doc))return;attached.add(doc);doc.addEventListener('mousedown',clear,true);doc.addEventListener('keydown',e=>{if(e.key==='Escape')clear();});}
  function overlay(doc,rects){
    const layer=doc.createElement('div');layer.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483000';layer.setAttribute('aria-hidden','true');doc.body.append(layer);
    const draw=()=>{layer.replaceChildren();for(const rect of rects()){if(!rect.width||!rect.height)continue;const box=doc.createElement('div');box.style.cssText=`position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:rgba(65,133,210,.30)`;layer.append(box);}};
    draw();const refresh=()=>{if(layer.isConnected)draw();else{doc.removeEventListener('scroll',refresh,true);doc.defaultView.removeEventListener('resize',refresh);}};doc.addEventListener('scroll',refresh,true);doc.defaultView.addEventListener('resize',refresh);return {overlay:layer,dispose:()=>{doc.removeEventListener('scroll',refresh,true);doc.defaultView.removeEventListener('resize',refresh);}};
  }
  function set(doc,ranges){
    clear();const copies=ranges.filter(r=>!r.collapsed).map(r=>r.cloneRange());if(!copies.length)return;attach(doc);
    const win=doc.defaultView;
    if(win.CSS?.highlights&&win.Highlight){
      if(!doc.getElementById('easyread-selection-preview-style')){const style=doc.createElement('style');style.id='easyread-selection-preview-style';style.textContent='::highlight(easyread-active-selection){background:rgba(65,133,210,.30);color:inherit}';doc.head.append(style);}
      win.CSS.highlights.set('easyread-active-selection',new win.Highlight(...copies));records.set(doc,{});
    }else records.set(doc,overlay(doc,()=>copies.flatMap(r=>[...r.getClientRects()])));
  }
  function setBoxes(doc,rects){clear();attach(doc);records.set(doc,overlay(doc,rects));}
  window.PR.selectionPreview={set,setBoxes,clear};
  document.addEventListener('keydown',e=>{if(e.key==='Escape')clear();});
})();
