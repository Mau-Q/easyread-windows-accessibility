/* Original-page selections retain PDF geometry and verified source anchors. */
(() => {
  'use strict';
  const compare=(a,b)=>{for(let i=0;i<Math.min(a.length,b.length);i++)if(a[i]!==b[i])return a[i]-b[i];return a.length-b.length;};
  const normalized=text=>text.normalize('NFKC').replace(/[\s\u00ad-]/g,'');
  window.captureOriginalPDFSelection=({reader,structure,map})=>{
    const view=reader._primaryView,doc=view._iframeWindow.document,sel=doc.getSelection();
    const range=sel&&!sel.isCollapsed&&sel.rangeCount?sel.getRangeAt(0):null,element=n=>n.nodeType===1?n:n.parentElement;
    const textRange=range&&element(range.startContainer)?.closest('.textLayer')&&element(range.endContainer)?.closest('.textLayer');
    const pages=new Map();
    for(const layer of textRange?doc.querySelectorAll('.textLayer'):[]){
      if(!range.intersectsNode(layer))continue;
      const pageIndex=Number(layer.closest('.page')?.dataset.pageNumber)-1;
      const viewport=view._iframeWindow.PDFViewerApplication.pdfViewer.getPageView(pageIndex)?.viewport;
      const box=layer.getBoundingClientRect();if(!viewport||!box.width||!box.height)continue;
      const walker=doc.createTreeWalker(layer,4),rects=[],probes=[];let node;
      while((node=walker.nextNode())){
        if(!range.intersectsNode(node))continue;
        const piece=doc.createRange();piece.selectNodeContents(node);
        if(range.compareBoundaryPoints(0,piece)>0)piece.setStart(range.startContainer,range.startOffset);
        if(range.compareBoundaryPoints(2,piece)<0)piece.setEnd(range.endContainer,range.endOffset);
        if(!piece.toString())continue;
        for(const r of piece.getClientRects()){
          if(!r.width||!r.height)continue;
          const convert=(inset)=>{
            const a=viewport.convertToPdfPoint((r.left-box.left+inset)*viewport.width/box.width,(r.top-box.top+r.height*(inset? .25:0))*viewport.height/box.height);
            const b=viewport.convertToPdfPoint((r.right-box.left-inset)*viewport.width/box.width,(r.bottom-box.top-r.height*(inset? .25:0))*viewport.height/box.height);
            return [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])];
          };
          rects.push(convert(0));
          // Text-layer line boxes touch adjacent lines. Use their interior for
          // source lookup; keep the full selection rectangle for highlights.
          probes.push(convert(Math.min(.2,r.width/4)));
        }
      }
      if(rects.length)pages.set(pageIndex,{rects,probes});
    }
    const mapPages=(pages,raw)=>{
    if(!pages.size||pages.size>2)return null;
    const indexes=[...pages.keys()].sort((a,b)=>a-b);if(indexes.length===2&&indexes[1]!==indexes[0]+1)return null;
    const spans=[];
    const visit=(node,ref,start,end)=>{
      if(typeof node.text==='string'){
        if(compare([...ref,node.text.length],start)<=0||compare([...ref,0],end)>=0)return;
        const a=compare(ref,start.slice(0,-1))===0?start.at(-1):0,b=compare(ref,end.slice(0,-1))===0?end.at(-1):node.text.length;
        if(b>a)spans.push({ref,node,start:a,end:b});
      }
      for(const [i,child]of(node.content||[]).entries())visit(child,[...ref,i],start,end);
    };
    for(const pageIndex of indexes){
      const position=reader._sdt.mapper.sourceToSDTPosition({pageIndex,rects:pages.get(pageIndex).probes});
      if(!position)return null;
      visit(structure,[],position.start,position.end);
    }
    const merged=[];
    for(const span of spans){const last=merged.at(-1);if(last&&compare(last.ref,span.ref)===0&&span.start<=last.end)last.end=Math.max(last.end,span.end);else merged.push({...span});}
    let quote='',previous=null;const anchors=[],refs=[];
    for(const span of merged){
      const candidates=map.records.filter(m=>m.refs.some(ref=>ref.every((n,i)=>span.ref[i]===n)));
      // Partial legacy mappings need their own character reconciliation.
      if(candidates.length!==1||candidates[0].source_segments)return null;
      const anchor=candidates[0].anchor,text=span.node.text.slice(span.start,span.end);
      if(previous&&previous!==anchor)quote+='\n\n';quote+=text;previous=anchor;
      if(!anchors.includes(anchor)){anchors.push(anchor);refs.push({anchor,quote:''});}
      refs.at(-1).quote+=text;
    }
    quote=quote.trim();
    // Never widen a short word selection to a line or guess a different text.
    if(!quote||quote.length>8000||anchors.length>20||normalized(quote)!==normalized(raw))return null;
    const pdfPositions=indexes.map(pageIndex=>({pageIndex,rects:pages.get(pageIndex).rects}));
    const edge=(anchor,span)=>{
      const rec=map.records.find(r=>r.anchor===anchor),nodes=[];
      const collect=(node,ref)=>{if(typeof node.text==='string')nodes.push({ref,text:node.text});for(const [i,n]of(node.content||[]).entries())collect(n,[...ref,i]);};
      for(const ref of rec.refs){let node=structure;for(const i of ref)node=node.content[i];collect(node,ref);}
      if(nodes.map(n=>n.text).join('')!==(rec.legacy.source_text||rec.source_english))return null;
      const index=nodes.findIndex(n=>compare(n.ref,span.ref)===0);if(index<0)return null;
      return {start:nodes.slice(0,index).map(n=>n.text).join('').length+span.start,
        prefix:(nodes.slice(0,index).map(n=>n.text).join('')+span.node.text.slice(0,span.start)).slice(-32),
        suffix:(span.node.text.slice(span.end)+nodes.slice(index+1).map(n=>n.text).join('')).slice(0,32)};
    };
    const first=edge(anchors[0],merged[0]),last=edge(anchors.at(-1),merged.at(-1));
    const locator=first&&last?{start:first.start,prefix:first.prefix,suffix:last.suffix}:{};
    return {language:'en',anchor:anchors[0],anchors,refs,quote,
      translationLocator:locator,
      sdtSegments:merged.map(s=>({start:[...s.ref,s.start],end:[...s.ref,s.end]})),
      pdfPositions,pdfPosition:pdfPositions[0],alignment:'selected-original-PDF-characters'};
    };
    const domResult=range&&mapPages(pages,range.toString());if(domResult)return domResult;
    // WKWebView may expose the renderer's semantic character selection rather
    // than a text-layer DOM range. It still must agree with the selected text.
    const native=view._easyreadNativeSelection;
    if(!native||range&&normalized(range.toString())!==normalized(native.quote))return null;
    const nativePages=new Map();
    for(const p of native.positions){
      nativePages.set(p.pageIndex,{rects:p.rects,probes:p.rects.map(r=>{
        const x=Math.min(.2,(r[2]-r[0])/4),y=(r[3]-r[1])/4;return [r[0]+x,r[1]+y,r[2]-x,r[3]-y];
      })});
    }
    return mapPages(nativePages,native.quote);
  };
})();
