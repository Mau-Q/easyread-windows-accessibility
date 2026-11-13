/* Original visual blocks stay in place. Expanded views clone display nodes;
   neither SDT, source PDF nor stored translations are changed. */
window.attachReflowVisuals=(doc,structure)=>{
  if(!doc.getElementById('easyread-visual-style')){
    const style=doc.createElement('style');style.id='easyread-visual-style';
    style.textContent='.pilot-visual{overflow-x:auto}.pilot-visual-toolbar{display:flex;gap:8px;margin:8px 0;font:14px system-ui}.pilot-visual-dialog{position:fixed;inset:20px;margin:0;width:calc(100vw - 40px);height:calc(100vh - 40px);max-width:none;max-height:none;box-sizing:border-box;padding:16px;background:#faf8f3;color:#302c27;border:1px solid #ccc}.pilot-visual-dialog::backdrop{background:#0009}.pilot-visual-viewport{height:calc(100% - 50px);overflow:auto}.pilot-visual-content{width:max-content;min-width:100%;transform-origin:top left}.pilot-visual-content img{max-width:none!important}.pilot-existing-table{overflow-x:auto;margin-top:12px;font-size:14px}.pilot-existing-table summary{cursor:pointer}.pilot-original-visual img{max-width:100%}.pilot-source-footnote{font-size:.85em;padding-left:12px;border-left:2px solid #b9aea0}.pilot-source-tag{font:12px system-ui;color:#756e64;margin-top:12px}';doc.head.append(style);
  }
  const entries=structure.content.map((block,i)=>({block,root:doc.querySelector('[data-ref-path="'+i+'"]')}));
  const images=doc.createElement('style');images.textContent=':root:is([data-reader-theme="dark"],[data-reader-theme="black"]) img[data-easyread-image="monochrome"]{filter:invert(1) brightness(.85)!important}:root:is([data-reader-theme="dark"],[data-reader-theme="black"]) img[data-easyread-image="colour"]{background:white}:root[data-reader-theme] .pilot-visual-dialog img[data-easyread-image],.pilot-visual-dialog img{filter:none!important;background:white!important}';doc.head.append(images);
  for(const img of doc.querySelectorAll('#sdt-content img'))window.styleReflowImage(img);
  if(!doc._easyreadImageObserver){doc._easyreadImageObserver=new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1){if(node.matches('img'))window.styleReflowImage(node);for(const img of node.querySelectorAll('img'))window.styleReflowImage(img);}});doc._easyreadImageObserver.observe(doc.getElementById('sdt-content'),{childList:true,subtree:true});}
  entries.push(...[...doc.querySelectorAll('[data-easyread-source-anchor]')].map(root=>({block:{type:'image'},root})));
  for(const {block,root} of entries){
    if(!['image','table','math'].includes(block.type)||!root||root.hidden||root.dataset.easyreadVisual)continue;
    root.dataset.easyreadVisual='original';root.classList.add('pilot-visual');
    const bar=doc.createElement('div');bar.className='pilot-visual-toolbar';
    const open=doc.createElement('button');open.textContent=block.type==='math'?'放大原公式':'放大原图表';open.type='button';bar.append(open);root.before(bar);
    open.onclick=()=>{
      const dialog=doc.createElement('dialog');dialog.className='pilot-visual-dialog';dialog.setAttribute('aria-label','原图表放大查看');
      const controls=doc.createElement('div');controls.className='pilot-visual-toolbar';
      const viewport=doc.createElement('div');viewport.className='pilot-visual-viewport';
      const content=doc.createElement('div');content.className='pilot-visual-content';content.append(root.cloneNode(true));viewport.append(content);
      let scale=1;const button=(label,fn)=>{const b=doc.createElement('button');b.type='button';b.textContent=label;b.onclick=fn;controls.append(b);};
      const zoom=value=>{scale=Math.max(.5,Math.min(4,value));content.style.zoom=String(scale);};
      button('缩小',()=>zoom(scale-.25));button('放大',()=>zoom(scale+.25));button('重置',()=>zoom(1));button('关闭',()=>dialog.close());
      dialog.append(controls,viewport);doc.body.append(dialog);dialog.addEventListener('close',()=>{dialog.remove();open.focus();},{once:true});dialog.showModal();
    };
  }
};
