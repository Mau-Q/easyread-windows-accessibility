/* Display-only source repairs. Each split preserves raw SDT text offsets. */
// PDF.js's default white canvas is page paper, not part of the chart. Render
// that canvas transparently; explicit fills/colours inside the PDF stay intact.
window.renderReflowRegions=async(reader,pageIndex,rects)=>{
  if(!rects.length)return [];
  const frame=reader._primaryView._iframeWindow,doc=frame.document;
  const page=await frame.PDFViewerApplication.pdfDocument.getPage(pageIndex+1),viewport=page.getViewport({scale:3});
  const boxes=rects.map(rect=>{const r=viewport.convertToViewportRectangle(rect);return [Math.min(r[0],r[2]),Math.min(r[1],r[3]),Math.max(r[0],r[2]),Math.max(r[1],r[3])];});
  const left=Math.floor(Math.min(...boxes.map(r=>r[0]))),top=Math.floor(Math.min(...boxes.map(r=>r[1])));
  const canvas=doc.createElement('canvas');canvas.width=Math.ceil(Math.max(...boxes.map(r=>r[2])))-left;canvas.height=Math.ceil(Math.max(...boxes.map(r=>r[3])))-top;
  if(!canvas.width||!canvas.height)throw Error('原图表区域为空');
  canvas.style.cssText='position:absolute;left:-100000px';doc.body.append(canvas);
  try{
    await page.render({canvasContext:canvas.getContext('2d'),viewport,background:'rgba(0,0,0,0)',transform:[1,0,0,1,-left,-top]}).promise;
    return boxes.map(r=>{const crop=doc.createElement('canvas');crop.width=Math.ceil(r[2]-r[0]);crop.height=Math.ceil(r[3]-r[1]);crop.getContext('2d').drawImage(canvas,r[0]-left,r[1]-top,r[2]-r[0],r[3]-r[1],0,0,crop.width,crop.height);return crop.toDataURL('image/png');});
  }finally{canvas.remove();}
};
window.styleReflowImage=img=>{
  if(img._easyreadImageStyle)return;
  img._easyreadImageStyle=true;
  const apply=()=>{
    if(!img.naturalWidth)return;
    const canvas=img.ownerDocument.createElement('canvas');canvas.width=canvas.height=96;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,96,96);
    const data=ctx.getImageData(0,0,96,96).data;let coloured=0,painted=0;
    for(let i=0;i<data.length;i+=4)if(data[i+3]>32){painted++;if(data[i+3]>200&&Math.max(data[i],data[i+1],data[i+2])-Math.min(data[i],data[i+1],data[i+2])>24)coloured++;}
    if(!painted)return; // Zotero's temporary transparent placeholder is not a chart.
    img.dataset.easyreadImage=coloured>painted*.02?'colour':'monochrome';
    img.dataset.easyreadImageReady='true';
  };
  const schedule=()=>{delete img.dataset.easyreadImageReady;img.decode().then(()=>{apply();setTimeout(apply,100);}).catch(()=>{});};
  img.addEventListener('load',schedule);
  new MutationObserver(schedule).observe(img,{attributes:true,attributeFilter:['src']});
  if(img.complete&&img.naturalWidth)schedule();
};
window.prepareReflowSource=(view,structure,map,reader)=>{
  const doc=view._iframeDocument,content=doc.getElementById('sdt-content');
  if(doc._easyreadSourcePreparation)return doc._easyreadSourcePreparation;
  doc._easyreadSourcePreparation=(async()=>{
  for(const split of map.source_splits||[]){
    const index=split.ref[0],block=structure.content[index],original=content.querySelector('[data-ref-path="'+index+'"]');
    if(!original)throw Error('待拆分原节点不存在：'+index);
    const raw=block.content.map(n=>n.text||'').join('');
    if(split.segments.map(s=>raw.slice(s.start,s.end)).join('')!==raw)throw Error('拆分没有完整覆盖原节点');
    const pieces=[];
    for(const segment of split.segments){
      const root=doc.createElement(segment.role==='footnote'?'aside':'p');root.dataset.refPath=String(index);root.dataset.easyreadSegment=segment.key;if(segment.role==='footnote')root.className='pilot-source-footnote';
      let offset=0;
      for(let i=0;i<block.content.length;i++){
        const node=block.content[i],text=node.text||'',end=offset+text.length;
        if(end>segment.start&&offset<segment.end){
          const a=Math.max(0,segment.start-offset),b=Math.min(text.length,segment.end-offset),source=original.querySelector('[data-text-index="'+i+'"]');
          const span=source?source.cloneNode(true):doc.createElement('span');span.dataset.textIndex=String(i);span.dataset.easyreadRawStart=String(a);
          if(a!==0||b!==text.length||!source)span.textContent=text.slice(a,b);
          if(span.textContent!==text.slice(a,b))throw Error('显示字符与原 SDT 不一致：'+index+'.'+i);
          root.append(span);
        }offset=end;
      }
      if(root.textContent!==raw.slice(segment.start,segment.end))throw Error('拆分内容不一致');pieces.push(root);
    }
    original.hidden=true;original.removeAttribute('id');original.removeAttribute('data-ref-path');
    pieces[0].id='sdt-'+index;let tail=original;for(const piece of pieces){tail.after(piece);tail=piece;}
    for(const segment of split.segments){const root=pieces.find(p=>p.dataset.easyreadSegment===segment.key);if(Number.isInteger(segment.after_ref)){const after=content.querySelector('[data-ref-path="'+segment.after_ref+'"]');if(after)after.after(root);}if(!segment.label)continue;const label=doc.createElement('div');label.className='pilot-source-tag';label.textContent=segment.label;root.before(label);}
  }
  for(const rec of map.records.filter(r=>r.restore_excluded_source))for(const ref of rec.refs){
    const index=ref[0];if(content.querySelector('[data-ref-path="'+index+'"]'))continue;
    const block=structure.content[index],root=doc.createElement(rec.legacy_type==='heading'?'h3':'aside');root.dataset.refPath=String(index);root.id='sdt-'+index;root.dataset.easyreadRestored='source';
    for(let i=0;i<block.content.length;i++){const n=block.content[i];if(typeof n.text!=='string')throw Error('隐藏节点含非文本结构');const span=doc.createElement('span');span.dataset.textIndex=String(i);span.textContent=n.text;root.append(span);}
    const after=[...content.children].find(el=>Number(el.dataset.refPath)>index);if(after)after.before(root);else content.append(root);
  }
  if(map.source_splits?.length){
    const originalPoint=view._domPositionToPoint.bind(view),originalDOM=view._pointToDOMPosition.bind(view);
    view._domPositionToPoint=(node,offset,end)=>{const p=originalPoint(node,offset,end);if(p){const span=(node.nodeType===1?node:node.parentElement).closest('[data-easyread-raw-start]');if(span)p[p.length-1]+=Number(span.dataset.easyreadRawStart);}return p;};
    view._pointToDOMPosition=point=>{
      const ref=point.slice(0,-1),at=point.at(-1),spans=content.querySelectorAll('[data-ref-path="'+ref[0]+'"] [data-text-index="'+ref[1]+'"][data-easyread-raw-start]');
      for(const span of spans){const start=Number(span.dataset.easyreadRawStart),end=start+span.textContent.length;if(at<start||at>end)continue;const walker=doc.createTreeWalker(span,4);let offset=at-start;while(walker.nextNode()){if(offset<=walker.currentNode.length)return {node:walker.currentNode,offset};offset-=walker.currentNode.length;}}
      return originalDOM(point);
    };
  }
  for(const rec of [...map.records.filter(r=>r.display_source_crop),...(map.visual_repairs||[])]){
    const positions=new Map();for(const ref of rec.refs)for(const r of structure.content[ref[0]].anchor?.pageRects||[]){const page=r[0],rect=r.slice(1);if(!positions.has(page))positions.set(page,rect);else{const a=positions.get(page);positions.set(page,[Math.min(a[0],rect[0]),Math.min(a[1],rect[1]),Math.max(a[2],rect[2]),Math.max(a[3],rect[3])]);}}
    const index=rec.refs[0][0];let first=content.querySelector('[data-ref-path="'+index+'"]');
    if(!first&&(map.visual_repairs||[]).includes(rec)){first=doc.createElement('figure');first.dataset.refPath=String(index);const after=[...content.children].find(el=>Number(el.dataset.refPath)>index);if(after)after.before(first);else content.append(first);}
    if(!first||!positions.size)throw Error('原区域坐标缺失');
    const figure=doc.createElement('figure');figure.dataset.easyreadSourceAnchor=rec.anchor;figure.className='pilot-original-visual';
    const pdf=reader._primaryView._iframeWindow.PDFViewerApplication.pdfDocument;
    for(const [pageIndex,rect] of positions){const page=await pdf.getPage(pageIndex+1),viewport=page.getViewport({scale:3}),r=viewport.convertToViewportRectangle(rect),left=Math.min(r[0],r[2]),top=Math.min(r[1],r[3]),width=Math.abs(r[2]-r[0]),height=Math.abs(r[3]-r[1]);
      // FontFace resources belong to the PDF iframe. Rendering in the SDT
      // document substitutes missing fonts and can turn every glyph into a box.
      const pdfDoc=reader._primaryView._iframeWindow.document,canvas=pdfDoc.createElement('canvas');canvas.width=Math.ceil(width);canvas.height=Math.ceil(height);canvas.style.position='absolute';canvas.style.left='-100000px';pdfDoc.body.append(canvas);
      try{await page.render({canvasContext:canvas.getContext('2d'),viewport,background:'rgba(0,0,0,0)',transform:[1,0,0,1,-left,-top]}).promise;const image=doc.createElement('img');image.src=canvas.toDataURL('image/png');image.alt='原 PDF 内容区域 · 第 '+(pageIndex+1)+' 页';image.style.width=(rec.legacy?.source_region_expand?'min(100%, 520px)':width/3*4/3+'px');image.style.maxWidth='100%';figure.append(image);}finally{canvas.remove();}
    }
    first.before(figure);for(const ref of rec.refs){const el=content.querySelector('[data-ref-path="'+ref[0]+'"]');if(el)el.hidden=true;}
    if(rec.source_warning){const hint=doc.createElement('p');hint.className='pilot-source-warning';hint.textContent=rec.source_warning;figure.append(hint);}
  }
  })();return doc._easyreadSourcePreparation;
};
