'use strict';
window.makeFullPilot=async({reader,paper,manifest,state,map,css,ui,save,structure,inlineEvidence})=>{
  let notes=structuredClone(state.annotations?.notes||[]),native=structuredClone(state.annotations?.native||[]),selection=null,mappings=[],reading=true,showZh=true,large=false;
  const host=parent.PILOT_NATIVE_HOST||'browser';
  const spots=[];
  function remember(){const p=progress(),m=mappings.find(m=>m.anchor===p.block);spots.push({position:p,offset:reading?m?.en.getBoundingClientRect().top:0});if(spots.length>20)spots.shift();ui.back?.(true);}
  function applyTheme(){
    const PR=parent.PR;if(!PR)return;
    const theme=PR.READER_THEMES.find(t=>t.id===PR.readerThemeValue()),tone=['dark','black'].includes(theme.id)?'dark':'light';
    // Reading colours come from the shared article CSS. Keep the PDF renderer
    // in its original palette so native theme filters cannot recolour crops.
    reader.setLightTheme('light');reader.setDarkTheme('light');reader.setColorScheme('light');
    const doc=reader._primarySDTView?._iframeDocument;if(!doc)return;PR.applyReaderTheme(doc,theme.id);
    let style=doc.getElementById('easyread-palette');if(!style){style=doc.createElement('style');style.id='easyread-palette';doc.head.append(style);}
    style.textContent='body,#sdt-content{background:'+theme.background+'!important;color:'+theme.foreground+'!important}.pilot-zh{color:var(--paper-zh)!important}.pilot-zh mark{color:#302c27!important}.pilot-visual-modal{background:'+theme.background+'!important;color:'+theme.foreground+'!important}';
  }
  const observations={host,source_sha256:manifest.source_sha256,events:[],corrections:[],restored:[],mathErrors:[]};
  const record=async(kind,data={})=>{observations.events.push({kind,time:new Date().toISOString(),...data});await save(host==='browser'?'observations':'host-events',observations);};
  const persist=async()=>{await save('annotations',{native,notes});ui.notes(notes);};
  const nodeAt=ref=>{let n=structure;for(const i of ref)n=n.content[i];return n;};
  const walkText=root=>{const w=root.ownerDocument.createTreeWalker(root,4),a=[];while(w.nextNode())a.push(w.currentNode);return a;};
  function rangeAt(root,a,b){const r=root.ownerDocument.createRange();let pos=0,started=false;for(const n of walkText(root)){const end=pos+n.length;if(!started&&a<end){r.setStart(n,a-pos);started=true;}if(started&&b<=end){r.setEnd(n,b-pos);return r;}pos=end;}throw new Error('文本范围不存在');}
  const rawOffset=(root,node,offset)=>{const r=root.ownerDocument.createRange();r.selectNodeContents(root);r.setEnd(node,offset);return r.toString().length;};
  const topHost=(el,doc)=>{while(el.parentElement&&el.parentElement.id!=='sdt-content')el=el.parentElement;return el;};
  function sourceSpans(refs,segments){const result=[];for(const ref of refs){const b=nodeAt(ref);if(!Array.isArray(b.content))continue;let offset=0;for(let i=0;i<b.content.length;i++){const n=b.content[i];if(typeof n.text!=='string')continue;const scopes=segments?segments.filter(s=>s.ref[0]===ref[0]):[{start:0,end:Infinity}];for(const s of scopes){const start=Math.max(0,s.start-offset),end=Math.min(n.text.length,s.end-offset);if(end>start)result.push({block:b,blockRef:ref,node:n,ref:[...ref,i],start,end});}offset+=n.text.length;}}return result;}
  function pdfPositions(spans){
    const mapper=reader._sdt.mapper,pages=new Map();
    const add=(pg,rect)=>{if(!pages.has(pg))pages.set(pg,[]);pages.get(pg).push(rect);};
    for(const span of spans){const runs=mapper._getRunData(span.node,span.ref);if(runs){let ri=0;for(let i=0;i<span.node.text.length&&ri<runs.length;i++){if(/[\n\t ]/.test(span.node.text[i]))continue;const run=runs[ri++];if(i>=span.start&&i<span.end)add(run.pageIndex,reader._primarySDTView?._pilotPDFRunOverrides?.get(span.ref.join('.')+':'+i)||run.rect);}}
      else for(const r of span.node.anchor?.pageRects||span.block.anchor?.pageRects||[])add(r[0],r.slice(1,5));}
    return [...pages].sort((a,b)=>a[0]-b[0]).map(([pageIndex,rects])=>{
      const merged=[];for(const r of rects){const last=merged.at(-1);if(last&&Math.abs(last[1]-r[1])<1&&Math.abs(last[3]-r[3])<1&&r[0]>=last[0]&&r[0]-last[2]<4){last[2]=Math.max(last[2],r[2]);}else merged.push([...r]);}
      return {pageIndex,rects:merged};
    });
  }
  function displayCorrections(view){
    const doc=view._iframeDocument,offsetMaps=new Map();
    for(const root of [...doc.querySelectorAll('#sdt-content > p,#sdt-content > figcaption,#sdt-content > h2,#sdt-content > h3')]){
      const before=root.textContent,edits=[];
      for(const match of before.matchAll(/\b(Equations?|Figures?|Tables?|Sections?|Algorithms?)(?=\d)/g))edits.push({at:match.index+match[0].length,insert:' ',basis:'reference-label-boundary'});
      for(const match of before.matchAll(/\bLemma(?=[A-Z]\.\d)/g))edits.push({at:match.index+match[0].length,insert:' ',basis:'original-PDF-page-20-Lemma-D.1'});
      for(const match of before.matchAll(/\d(?=(?:is|using|provides|presents|shows|and|left|right)\b)/g))edits.push({at:match.index+1,insert:' ',basis:'reference-following-word'});
      for(const match of before.matchAll(/\band(?=\d)/g))edits.push({at:match.index+3,insert:' ',basis:'reference-conjunction-boundary'});
      for(const match of before.matchAll(/280Mparameter/g))edits.push({at:match.index+4,insert:'-',basis:'original-PDF-page-1-line-break-hyphen'});
      if(!edits.length)continue;
      const nodes=walkText(root);let offset=0;
      for(const text of nodes){const start=offset,end=start+text.length;offset=end;
        const local=edits.filter(e=>e.at>=start&&e.at<end).map(e=>({...e,at:e.at-start}));if(!local.length)continue;
        const span=text.parentElement.closest('[data-text-index]'),block=span?.closest('[data-ref-path]');if(!span||!block)continue;
        const key=block.dataset.refPath+'.'+span.dataset.textIndex,raw=text.data,displayToRaw=[0],rawToDisplay=[];let shown='';
        for(let i=0;i<=raw.length;i++){for(const e of local.filter(e=>e.at===i)){shown+=e.insert;for(let j=0;j<e.insert.length;j++)displayToRaw.push(i);}rawToDisplay[i]=shown.length;if(i<raw.length){shown+=raw[i];displayToRaw.push(i+1);}}
        text.data=shown;offsetMaps.set(key,{displayToRaw,rawToDisplay});
      }
      observations.corrections.push({ref:root.dataset.refPath,before,after:root.textContent,edits});
    }
    const toPoint=view._domPositionToPoint.bind(view),toDOM=view._pointToDOMPosition.bind(view);
    view._domPositionToPoint=(node,offset,isEnd)=>{const p=toPoint(node,offset,isEnd);if(p){const map=offsetMaps.get(p.slice(0,-1).join('.'));if(map)p[p.length-1]=map.displayToRaw[p.at(-1)]??map.displayToRaw.at(-1);}return p;};
    view._pointToDOMPosition=point=>{const p=[...point],map=offsetMaps.get(p.slice(0,-1).join('.'));if(map)p[p.length-1]=map.rawToDisplay[p.at(-1)]??map.rawToDisplay.at(-1);return toDOM(p);};
    view._pilotOffsetMaps=offsetMaps;
  }
  function chineseFragment(doc,raw,start=0,inlineMath=[]){
    const fragment=doc.createDocumentFragment();let last=0;
    const plain=(text,index)=>{if(!text)return;const append=(value,at,tag)=>{if(!value)return;const span=doc.createElement('span');span.className='pilot-prose';span.dataset.zhStart=start+index+at;span.dataset.zhEnd=start+index+at+value.length;span.textContent=value;if(tag){const wrapper=doc.createElement(tag);wrapper.append(span);fragment.append(wrapper);}else fragment.append(span);};let at=0;for(const token of text.matchAll(/\*\*([^*\n]+)\*\*|`([^`\n]+)`/g)){append(text.slice(at,token.index),at);append(token[1]??token[2],token.index+(token[1]!==undefined?2:1),token[1]!==undefined?'strong':'code');at=token.index+token[0].length;}append(text.slice(at),at);};
    const formulas=[...raw.matchAll(/\$\$([\s\S]*?)\$\$|\$([^$]+)\$/g)].map(m=>({start:m.index,end:m.index+m[0].length,tex:m[1]??m[2],display:m[1]!==undefined}));
    for(const m of inlineMath){if(!Number.isInteger(m.start)||!Number.isInteger(m.end)||m.start<0||m.end>raw.length||m.start>=m.end||raw.slice(m.start,m.end)!==m.tex)throw Error('公式显示范围与译文不匹配');if(!formulas.some(f=>m.start<f.end&&m.end>f.start))formulas.push({...m,display:false});}
    for(const m of formulas.sort((a,b)=>a.start-b.start)){
      if(m.start<last)throw Error('公式显示范围重叠');
      plain(raw.slice(last,m.start),last);const el=doc.createElement('span');el.className='pilot-math';el.dataset.zhStart=start+m.start;el.dataset.zhEnd=start+m.end;el.dataset.tex=m.tex;el.title=raw.slice(m.start,m.end);
      try{el.innerHTML=parent.katex.renderToString(el.dataset.tex,{displayMode:m.display,throwOnError:false,trust:false,strict:'ignore'});}catch(e){el.textContent=el.title;observations.mathErrors.push(String(e));}
      fragment.append(el);last=m.end;
    }plain(raw.slice(last),last);return fragment;
  }
  function renderTranslation(m,doc){
    const root=doc.createElement('div');root.className='pilot-zh';root.lang='zh-CN';root.dataset.pilotAnchor=m.anchor;root.hidden=!showZh;
    if(m.rec.legacy.role==='visual-text'||m.rec.legacy.role==='references')root.hidden=true;
    m.zhText=m.rec.source_chinese;root.append(chineseFragment(doc,m.zhText,0,m.rec.legacy.display_math||[]));
    if(m.rec.legacy.translation_warning){
      const hint=doc.createElement('small');hint.className='pilot-translation-warning';hint.textContent=m.rec.legacy.translation_warning;
      const link=doc.createElement('a');link.textContent='查看原 PDF';link.href='/p/'+encodeURIComponent(paper.id||parent.PR.pid)+'/source.pdf#page='+m.rec.legacy_page;link.target='_blank';link.rel='noopener';hint.append(' ',link);root.append(hint);
    }
    if(m.rec.legacy_type==='table'){
      const details=doc.createElement('details');details.className='pilot-existing-table';const summary=doc.createElement('summary');summary.textContent='对照已有译表';details.append(summary);
      const table=doc.createElement('table');table.className='pilot-translated-table';let index=m.zhText.length;
      const rows=[...(m.rec.legacy.head||[]),...(m.rec.legacy.rows||[])];
      for(let ri=0;ri<rows.length;ri++){const tr=doc.createElement('tr');for(let ci=0;ci<rows[ri].length;ci++){m.zhText+='\n';index++;const raw=String(rows[ri][ci]),td=doc.createElement(ri<(m.rec.legacy.head||[]).length?'th':'td');td.append(chineseFragment(doc,raw,index));index+=raw.length;m.zhText+=raw;tr.append(td);}table.append(tr);}details.append(table);root.append(details);
    }
    m.zh=root;return root;
  }
  function sourceElement(ref,doc){return doc.querySelector('[data-ref-path="'+ref.join('.')+'"]');}
  function refreshLayout(){const v=reader._primarySDTView;if(!v)return;const zhIDs=new Set(notes.filter(n=>n.language==='zh').flatMap(n=>n.nativeIds||[n.id]));v.setAnnotations(reader._state.annotations.filter(a=>!zhIDs.has(a.id)));v._handleViewUpdate(true);}
  function markChinese(note){
    const m=mappings.find(m=>m.anchor===note.anchor);if(!m||m.zhText.slice(note.start,note.end)!==note.quote){observations.restored.push({id:note.id,status:'unmatched-source'});return false;}
    for(const el of m.zh.querySelectorAll('[data-zh-start]')){const a=+el.dataset.zhStart,b=+el.dataset.zhEnd;if(b<=note.start||a>=note.end)continue;
      if(el.classList.contains('pilot-math')){el.classList.add('pilot-marked-math');el.dataset.note=note.id;continue;}
      const from=Math.max(a,note.start)-a,to=Math.min(b,note.end)-a,r=rangeAt(el,from,to),mark=el.ownerDocument.createElement('mark');mark.dataset.note=note.id;mark.style.background=note.color||'#dfd1f4';try{r.surroundContents(mark);}catch{observations.restored.push({id:note.id,status:'overlapping-range-not-rendered'});return false;}
    }return true;
  }
  async function mount(){
    const v=reader._primarySDTView,doc=v._iframeDocument;
    let sizeStyle=doc.getElementById('easyread-width');if(!sizeStyle){sizeStyle=doc.createElement('style');sizeStyle.id='easyread-width';sizeStyle.textContent='body{width:100%!important;max-width:none!important;margin:0!important}';doc.head.append(sizeStyle);}
    sizeStyle.textContent+=' #sdt-content,#sdt-content>p{font-family:var(--paper-en)!important}#sdt-content>p{text-align:left!important}.pilot-zh{font-family:var(--paper-sans)!important}';
    if(!doc.getElementById('easyread-web-style')){const style=doc.createElement('style');style.id='easyread-web-style';style.textContent=(window.pdfWebArticleCSS||'')+'body{padding:40px 28px 100px!important}#sdt-content{box-sizing:border-box;width:100%!important;max-width:780px!important;margin:0 auto!important;padding:0!important;font:400 18px/1.75 Georgia,serif!important}#sdt-content>p{font:inherit!important;margin:0 0 1em!important}.pilot-zh{font:400 17px/1.9 system-ui!important;border-left:2px solid var(--paper-rule)!important;padding:0 0 0 18px!important;margin:12px 0 36px!important}#sdt-content>h2,#sdt-content>h3{line-height:1.35!important}.pilot-zh[hidden]{display:none!important}';doc.head.append(style);}
    await window.prepareReflowSource?.(v,structure,map,reader);
    const doremi=manifest.source_sha256==='6bf62c211048c07b786a2d9146e6ffaf38ef8af744eebdbe5281cdaf827227b4';
    if(doremi)displayCorrections(v);else{v._pilotOffsetMaps=new Map();v._pilotMathData=new Map();}
    if(inlineEvidence.source_sha256!==manifest.source_sha256)throw new Error('数学证据来源不匹配');
    if(doremi)window.mountEnglishMath(v,structure,inlineEvidence,observations);
    const nativeRange=v._getAnnotationDisplayedRange.bind(v);
    v._getAnnotationDisplayedRange=annotation=>{
      const note=notes.find(n=>n.language==='en'&&n.sdtSegments&&(n.nativeIds||[n.id]).includes(annotation.id));
      if(!note)return nativeRange(annotation);
      const ranges=[];
      for(const segment of note.sdtSegments){const ref=segment.start.slice(0,-1),node=nodeAt(ref),runs=reader._sdt.mapper._getRunData(node,ref);let start=null,end=null,ri=0;
        for(let i=0;i<node.text.length;i++){if(/[\n\t ]/.test(node.text[i]))continue;const run=runs?.[ri++];if(i>=segment.start.at(-1)&&i<segment.end.at(-1)&&run?.pageIndex===annotation.position.pageIndex){if(start===null)start=i;end=i+1;}}
        if(start===null)continue;const exact=v._pilotRawRanges?.(ref,start,end);if(exact){ranges.push(...exact);continue;}const a=v._pointToDOMPosition([...ref,start]),b=v._pointToDOMPosition([...ref,end]),r=doc.createRange();r.setStart(a.node,a.offset);r.setEnd(b.node,b.offset);ranges.push(r);
      }
      if(!ranges.length)return null;
      const range=ranges[0].cloneRange();range.getClientRects=()=>ranges.flatMap(r=>[...r.getClientRects()]);
      range.getBoundingClientRect=()=>{const rects=range.getClientRects(),left=Math.min(...rects.map(r=>r.left)),top=Math.min(...rects.map(r=>r.top)),right=Math.max(...rects.map(r=>r.right)),bottom=Math.max(...rects.map(r=>r.bottom));return new v._iframeWindow.DOMRect(left,top,right-left,bottom-top);};
      return range;
    };
    const style=doc.createElement('style');style.textContent=css+'\n.pilot-zh{margin:1em 0 1.8em;padding-left:14px;border-left:2px solid #d9caa6;color:#705f48;font:17px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;white-space:pre-wrap;user-select:text}.pilot-zh[hidden]{display:none}.pilot-zh mark,.pilot-marked-math{background:#dfd1f4;color:inherit}.pilot-translated-table{width:100%;border-collapse:collapse;margin-top:12px;font-size:14px;white-space:normal}.pilot-translated-table td,.pilot-translated-table th{border:1px solid #d6d2c7;padding:6px;vertical-align:top}.pilot-zh .katex-display{overflow-x:auto;overflow-y:hidden}';doc.head.append(style);
    const contrast=doc.createElement('style');contrast.textContent='@media(prefers-color-scheme:dark){.pilot-zh{color:#dfd2b9}.pilot-zh mark,.pilot-marked-math{color:#28222e}}';doc.head.append(contrast);
    const matrix=doremi?doc.querySelector('[data-ref-path="182"]'):null;
    if(matrix){const crops=v._options.data.getBlockCrops([182]);if(crops.length){const figure=doc.createElement('figure');figure.dataset.pilotOriginalRef='182';figure.setAttribute('aria-label','Equation 14 · original PDF matrix');for(const crop of crops){const image=doc.createElement('img');image.alt='Equation 14 · original PDF matrix';image.style.cssText='max-width:100%;width:'+crop.displayWidth+'px';image.src=await crop.render();figure.append(image);}matrix.hidden=true;matrix.after(figure);observations.corrections.push({ref:'182',basis:'matrix-misclassified-as-paragraph',display:'original-PDF-crop'});}}
    mappings=[];const tails=new Map();
    for(const rec of map.records){
      const els=rec.source_segments?rec.source_segments.map(s=>s.key?doc.querySelector('[data-easyread-segment="'+s.key+'"]'):sourceElement(s.ref,doc)).filter(Boolean):rec.refs.map(ref=>sourceElement(ref,doc)).filter(Boolean);if(!els.length)throw new Error('映射没有显示节点：'+rec.anchor);
      const resource=(rec.resource_refs||[]).map(ref=>sourceElement(ref,doc)).filter(Boolean);
      const crop=rec.display_source_crop?doc.querySelector('[data-easyread-source-anchor="'+rec.anchor+'"]'):null;
      const positions=pdfPositions(sourceSpans(rec.resource_refs||rec.refs,rec.source_segments));
      if(!positions.length)for(const ref of rec.refs)for(const r of nodeAt(ref).anchor?.pageRects||[]){let p=positions.find(p=>p.pageIndex===r[0]);if(!p){p={pageIndex:r[0],rects:[]};positions.push(p);}p.rects.push(r.slice(1));}
      const m={anchor:rec.anchor,rec,legacy:rec.legacy,enEls:els,en:crop||els[0],zhSource:rec.source_chinese,
        enText:crop?rec.source_english:els.map(el=>[...el.querySelectorAll('[data-text-index]')].filter(span=>span.closest('[data-ref-path]')===el&&!span.closest('[hidden]')).map(span=>v._pilotMathData.get(el.dataset.refPath+'.'+span.dataset.textIndex)?.tokens.map(t=>t.char).join('')||span.textContent).join('')).join('\n\n'),
        pdfPositions:positions};
      const hostEl=topHost(crop||resource.at(-1)||els.at(-1),doc),tail=tails.get(hostEl)||hostEl;
      tail.insertAdjacentElement('afterend',renderTranslation(m,doc));tails.set(hostEl,m.zh);mappings.push(m);
    }
    for(const n of notes){if(n.language==='zh')markChinese(n);observations.restored.push({id:n.id,language:n.language,status:'restored'});}
    doc.addEventListener('selectionchange',()=>{try{capture();}catch(e){ui.status('选区无法定位：'+e.message);}},true);
    doc.addEventListener('copy',event=>{const s=capture();if(s&&event.clipboardData){event.preventDefault();event.stopImmediatePropagation();event.clipboardData.setData('text/plain',s.quote);record('native-copy',{language:s.language,quote:s.quote});}},true);
    if(!doc._easyreadProgressAttached){doc._easyreadProgressAttached=true;let timer;doc.addEventListener('scroll',()=>{clearTimeout(timer);timer=setTimeout(()=>{if(reading)ui.progress?.(progress());},300);},true);}
    window.attachReflowVisuals?.(doc,structure);refreshLayout();applyTheme();
    if(!doc._easyreadBackAttached){doc._easyreadBackAttached=true;doc.addEventListener('keydown',backKey);}
  }
  function displayOffset(span,node,offset){const r=span.ownerDocument.createRange();r.selectNodeContents(span);r.setEnd(node,offset);return r.toString().length;}
  function englishSpans(range){const v=reader._primarySDTView,doc=v._iframeDocument,result=[];
    for(const span of doc.querySelectorAll('#sdt-content [data-text-index]')){if(span.closest('.pilot-zh,[hidden]')||!range.intersectsNode(span))continue;let r=doc.createRange();r.selectNodeContents(span);
      const repaired=v._pilotMathSelection?.(span,range);if(repaired){const ref=repaired.ref,blockRef=ref.slice(0,-1),block=nodeAt(blockRef),node=block.content[ref.at(-1)];repaired.parts.forEach((part,i)=>result.push({block,blockRef,node,ref,...part,quote:i===0?repaired.quote:''}));continue;}
      if(span.contains(range.startContainer))r.setStart(range.startContainer,range.startOffset);
      if(span.contains(range.endContainer))r.setEnd(range.endContainer,range.endOffset);
      if(r.collapsed)continue;const first=walkText(span)[0],last=walkText(span).at(-1);if(!first||!last)continue;
      if(r.startContainer===span)r.setStart(first,0);if(r.endContainer===span)r.setEnd(last,last.length);
      const a=v._domPositionToPoint(r.startContainer,r.startOffset,false),b=v._domPositionToPoint(r.endContainer,r.endOffset,true);if(!a||!b)continue;
      const ref=a.slice(0,-1),blockRef=ref.slice(0,-1),block=nodeAt(blockRef),node=block.content[ref.at(-1)];
      result.push({block,blockRef,node,ref,start:a.at(-1),end:b.at(-1),quote:r.toString()});
    }return result;
  }
  function zhPoint(node,offset,end){const el=(node.nodeType===1?node:node.parentElement).closest('[data-zh-start]');if(!el)return null;return el.classList.contains('pilot-math')?+(end?el.dataset.zhEnd:el.dataset.zhStart):+el.dataset.zhStart+displayOffset(el,node,offset);}
  function capture(){
    if(!reading){
      selection=window.captureOriginalPDFSelection({reader,structure,map});ui.selection(selection);return selection;
    }
    const v=reader._primarySDTView;if(!v)return null;const sel=v._iframeWindow.getSelection();if(!sel||sel.isCollapsed||!sel.rangeCount)return null;
    const range=sel.getRangeAt(0),el=n=>n.nodeType===1?n:n.parentElement,a=el(range.startContainer).closest('.pilot-zh'),b=el(range.endContainer).closest('.pilot-zh');
    if(a||b){if(a!==b){selection=null;ui.selection(null);ui.status('中英文端点混合时不建立引用，请分别选择。');return null;}const m=mappings.find(m=>m.anchor===a.dataset.pilotAnchor),start=zhPoint(range.startContainer,range.startOffset,false),end=zhPoint(range.endContainer,range.endOffset,true);if(start==null||end==null)return null;
      selection={language:'zh',anchor:m.anchor,anchors:[m.anchor],quote:m.zhText.slice(start,end),start,end,pdfPositions:m.pdfPositions,alignment:'source-unit'};
    }else{
      const spans=englishSpans(range);if(!spans.length)return null;const refs=[...new Set(spans.map(s=>s.blockRef[0]))];
      const matched=mappings.filter(m=>m.rec.refs.some(ref=>refs.includes(ref[0]))&&(!m.rec.source_segments||spans.some(s=>{const block=nodeAt(s.blockRef),offset=block.content.slice(0,s.ref.at(-1)).reduce((n,v)=>n+(v.text||'').length,0);return m.rec.source_segments.some(seg=>seg.ref[0]===s.blockRef[0]&&offset+s.start<seg.end&&offset+s.end>seg.start);}))).sort((x,y)=>x.rec.refs.length-y.rec.refs.length);
      let quote='',last='';for(const s of spans){const key=s.blockRef.join('.');if(last&&key!==last)quote+='\n\n';quote+=s.quote;last=key;}
      selection={language:'en',anchor:matched[0]?.anchor||'sdt:'+refs[0],anchors:matched.map(m=>m.anchor),quote,
        sdtSegments:spans.map(s=>({start:[...s.ref,s.start],end:[...s.ref,s.end]})),pdfPositions:pdfPositions(spans),alignment:'selected-English-characters'};
    }
    if(!selection.quote.trim()||!selection.pdfPositions.length)return null;
    selection.pdfPosition=selection.pdfPositions[0];ui.selection(selection);return selection;
  }
  function context(){if(!selection)throw new Error('请先选择文字');const chosen=mappings.filter(m=>selection.anchors.includes(m.anchor));
    return {mode:'context-inspection-only',source_sha256:manifest.source_sha256,title:paper.meta.title_en,selection:structuredClone(selection),
      units:chosen.map(m=>({anchor:m.anchor,english:m.enText,chinese:m.zhText,source_chinese:m.zhSource,source_pages:m.rec.source_pages,variation:m.rec.reviewed_variation||null})),
      nearby:chosen.length?mappings.slice(Math.max(0,mappings.indexOf(chosen[0])-1),mappings.indexOf(chosen.at(-1))+2).map(m=>({anchor:m.anchor,english:m.enText,chinese:m.zhText})):[],
      pdf_alignment:selection.alignment};}
  async function setReading(enabled){
    selection=null;ui.selection(null);parent.PR.hideSelectionTranslation?.();
    await reader._setReadingMode(true,enabled);reading=enabled;reader._updateState({primaryViewSelectionPopup:null,secondaryViewSelectionPopup:null});
    if(enabled){await reader._primarySDTView.initializedPromise;await mount();}
    else{
      await reader._primaryView.initializedPromise;
      const doc=reader._primaryView._iframeWindow.document;
      if(!doc._easyreadSelectionAttached){
        doc._easyreadSelectionAttached=true;
        const view=reader._primaryView,getAction=view.getActionAtPosition.bind(view);
        view.getActionAtPosition=(position,event)=>{
          if(event.button===0&&event.target?.closest?.('.page')&&!event.target.closest('input,textarea,button,[contenteditable]'))return {action:{type:'selectText'},selectAnnotations:[]};
          return getAction(position,event);
        };
        let browserRange=null;
        const snapshotRange=()=>{
          const selected=doc.getSelection();if(reading||!selected?.rangeCount||selected.isCollapsed)return;
          const range=selected.getRangeAt(0),element=n=>n.nodeType===1?n:n.parentElement;
          if(!element(range.startContainer)?.closest('.textLayer')||!element(range.endContainer)?.closest('.textLayer'))return;
          return {startNode:range.startContainer,startOffset:range.startOffset,endNode:range.endContainer,endOffset:range.endOffset};
        };
        doc.addEventListener('mousedown',()=>{browserRange=null;view._easyreadNativeSelection=null;},true);
        doc.addEventListener('pointerup',()=>{browserRange=snapshotRange();},true);
        doc.addEventListener('mouseup',()=>{
          const nativePosition=view.getSelectionPosition(),nativeQuote=(view._selectionRanges||[]).filter(r=>!r.collapsed).sort((a,b)=>a.pageIndex-b.pageIndex).map(r=>r.text).join('\n');
          if(nativePosition&&nativeQuote){const positions=[{pageIndex:nativePosition.pageIndex,rects:nativePosition.rects}];if(nativePosition.nextPageRects)positions.push({pageIndex:nativePosition.pageIndex+1,rects:nativePosition.nextPageRects});view._easyreadNativeSelection={quote:nativeQuote,positions:structuredClone(positions)};}
          const point=browserRange||snapshotRange();browserRange=null;if(!point)return;
          const {startNode,startOffset,endNode,endOffset}=point,selected=doc.getSelection();
          // The desktop PDF view reconciles its canvas selection on pointerup.
          // Preserve the actual browser text range before that reconciliation,
          // then let EasyRead use that same range for all three actions.
          setTimeout(()=>{
            if(reading||!startNode.isConnected||!endNode.isConnected)return;
            reader._primaryView._setSelectionRanges();reader._primaryView._render();
            reader._updateState({primaryViewSelectionPopup:null});
            const restored=doc.createRange();restored.setStart(startNode,startOffset);restored.setEnd(endNode,endOffset);
            selected.removeAllRanges();selected.addRange(restored);
          },0);
        },true);
        doc.addEventListener('selectionchange',()=>{if(!reading&&doc.getSelection()?.isCollapsed){selection=null;ui.selection(null);}});
        doc.addEventListener('keydown',e=>{if(e.key==='Escape'){selection=null;view._easyreadNativeSelection=null;ui.selection(null);}});
        doc.addEventListener('scroll',()=>{view._easyreadNativeSelection=null;ui.selection(null);},{capture:true,passive:true});
      }
      parent.PR.attachSelectionTranslation?.(doc,null,()=>{
        if(reading)return null;
        const s=capture();if(!s)return null;
        const hashes=Object.fromEntries(s.anchors.map(a=>[a,parent.PR.blockById[a]?.source_hash]));
        return {body:{anchor:s.anchor,anchors:s.anchors,refs:s.refs,key:'en',quote:s.refs.map(r=>r.quote.trim()).join('\n'),...s.translationLocator,source_hashes:hashes},rect:ui.selectionRect()};
      });
    }
    ui.mode(reading);
  }
  async function jump(anchor,saveSpot=false){if(!map.records.some(m=>m.anchor===anchor))throw new Error('未找到 '+anchor);if(saveSpot)remember();if(!reading)await setReading(true);const m=mappings.find(m=>m.anchor===anchor);refreshLayout();const win=m.en.ownerDocument.defaultView;win.scrollTo({left:win.scrollX,top:win.scrollY+m.en.getBoundingClientRect().top,behavior:'instant'});ui.progress?.(progress());ui.status('已定位 '+anchor+' · 原文页 '+m.rec.source_pages.join('、'));}
  async function goBack(){const spot=spots.pop();if(!spot)return;await pilot.restoreProgress(spot.position);if(spot.position.reflow.reading){const m=mappings.find(m=>m.anchor===spot.position.block);if(m)m.en.ownerDocument.defaultView.scrollBy(0,m.en.getBoundingClientRect().top-spot.offset);}ui.back?.(spots.length>0);ui.progress?.(progress());}
  function backKey(e){if(e.altKey&&e.key==='ArrowLeft'&&!e.target.closest?.('input,textarea,[contenteditable=true]')&&spots.length){e.preventDefault();goBack().catch(error=>ui.status(error.message));}}
  parent.document.addEventListener('keydown',backKey);
  function progress(pageIndex){
    const total=structure.catalog.pages.length;
    let m;if(reading){m=mappings.filter(m=>m.en.getBoundingClientRect().top<=100).at(-1)||mappings[0];pageIndex=Math.max(0,(m?.rec.source_pages?.[0]||1)-1);}
    else{pageIndex=pageIndex??((reader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber||1)-1);pageIndex=Math.max(0,Math.min(total-1,pageIndex));m=mappings.find(m=>m.rec.source_pages.includes(pageIndex+1));}
    return {block:m?.anchor||null,ratio:total>1?pageIndex/(total-1):0,offset:reading?m?.en.getBoundingClientRect().top:undefined,reflow:{source_sha256:manifest.source_sha256,pageIndex,reading}};
  }
  const pilot={reader,map,observations,get notes(){return notes;},get mappings(){return mappings;},get selection(){return selection;},captureSelection:capture,payload:context,record,setReading,jump,
    progress,goBack,applyTheme,get reading(){return reading;},
    async restoreProgress(saved){const position=saved.reflow;if(position?.source_sha256===manifest.source_sha256&&!position.reading){await setReading(false);await reader._primaryView.initializedPromise;await reader._primaryView.navigate({pageIndex:position.pageIndex});}else if(saved.block&&mappings.some(m=>m.anchor===saved.block)){await jump(saved.block);const m=mappings.find(m=>m.anchor===saved.block);if(Number.isFinite(saved.offset))m.en.ownerDocument.defaultView.scrollBy(0,m.en.getBoundingClientRect().top-saved.offset);}else if(position?.source_sha256===manifest.source_sha256){const m=mappings.find(m=>m.rec.source_pages.includes(position.pageIndex+1));if(m)await jump(m.anchor);}},
    restoreExisting(values,annotations){const restored=annotations.map(a=>({...a,tags:a.tags||[]}));if(JSON.stringify(notes)===JSON.stringify(values)&&JSON.stringify(native)===JSON.stringify(restored))return;const doc=reader._primarySDTView?._iframeDocument;for(const mark of doc?.querySelectorAll('.pilot-zh mark[data-note]')||[])mark.replaceWith(...mark.childNodes);for(const m of mappings)m.zh.normalize();notes=values;native=restored;reader.setAnnotations(native);for(const n of notes)if(n.language==='zh'&&Number.isInteger(n.start))markChinese(n);refreshLayout();ui.notes(notes);},
    async acceptNative(values){for(const a of values){const i=native.findIndex(x=>x.id===a.id);if(i<0)native.push(a);else native[i]=a;}await persist();},
    async deleteNative(ids){native=native.filter(a=>!ids.includes(a.id));notes=notes.filter(n=>!(n.nativeIds||[n.id]).some(id=>ids.includes(id)));await persist();},
    async copy(){if(!selection)throw new Error('没有选区');const text=parent.document.createElement('textarea');text.value=selection.quote;text.style.cssText='position:fixed;left:-2000px';parent.document.body.append(text);text.select();const ok=parent.document.execCommand('copy');text.remove();if(!ok)await parent.navigator.clipboard.writeText(selection.quote);await record('copy-button',{quote:selection.quote,language:selection.language});ui.status('选区已复制');},
    async highlight(){if(!selection)throw new Error('没有选区');const s=structuredClone(selection),ids=[];
      for(const position of s.pdfPositions){const id=crypto.randomUUID().replaceAll('-','').slice(0,8).toUpperCase(),a={id,type:'highlight',tags:[],color:s.language==='en'?'#ffd400':'#a28ae5',position,sortIndex:reader._sdt.mapper.getSortIndex(position),pageLabel:String(position.pageIndex+1),text:s.quote,comment:s.language==='zh'?'中文对应源单元（非逐词对齐）：'+s.quote:'',authorName:'EasyRead',readOnly:true,dateCreated:new Date().toISOString(),dateModified:new Date().toISOString()};ids.push(id);native.push(a);}reader.setAnnotations(native);
      const n={id:ids[0],nativeIds:ids,...s};notes.push(n);if(n.language==='zh')markChinese(n);refreshLayout();await persist();await record('highlight-created',{note:n});return n;},
    async gotoPDF(){if(!selection)throw new Error('没有选区');remember();const positions=structuredClone(selection.pdfPositions);await setReading(false);await reader._primaryView.initializedPromise;await reader._primaryView.navigate({position:positions[0]},{block:'center',ifNeeded:false});ui.status('原 PDF · 共 '+positions.length+' 页选区，可在笔记中恢复');await record('pdf-navigation',{positions});},
    async gotoSource(pageNumber,box){remember();await setReading(false);await reader._primaryView.initializedPromise;const pageIndex=pageNumber-1;
      if(Array.isArray(box)&&box.length===4&&box.every(Number.isFinite)){const page=await reader._primaryView._iframeWindow.PDFViewerApplication.pdfDocument.getPage(pageNumber),v=page.getViewport({scale:1}),a=v.convertToPdfPoint(box[0]*v.width,box[1]*v.height),b=v.convertToPdfPoint(box[2]*v.width,box[3]*v.height);await reader._primaryView.navigate({position:{pageIndex,rects:[[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])]]}},{block:'center',ifNeeded:false});}
      else await reader._primaryView.navigate({pageIndex});ui.status('已定位原 PDF 第 '+pageNumber+' 页');},
    async gotoNote(id){const n=notes.find(n=>n.id===id);if(!n)throw new Error('笔记不存在');remember();selection=structuredClone(n);selection.pdfPositions=n.pdfPositions||[n.pdfPosition];selection.anchors=n.anchors||[n.anchor];ui.selection(selection);await setReading(false);await reader._primaryView.initializedPromise;await reader._primaryView.navigate({annotationID:n.nativeIds?.[0]||n.id},{block:'center',ifNeeded:false});await record('note-restored-navigation',{id});},
    async ask(){const p=context();ui.context(p);await record('context-inspected',{payload:p});return p;},
    async toggleReading(){await setReading(!reading);},jumpSample:()=>jump('p1-3'),jumpFormula:()=>jump('p4-2'),jumpTable:()=>jump('tab2'),jumpCross:()=>jump('p3-10'),
    toggleChinese(){showZh=!showZh;for(const m of mappings)m.zh.hidden=!showZh||['visual-text','references'].includes(m.rec.legacy.role);parent.document.getElementById('zhToggle').textContent=showZh?'隐藏中文':'显示中文';refreshLayout();},
    larger(){large=!large;const doc=reader._primarySDTView?._iframeDocument;if(doc){doc.getElementById('sdt-content').style.fontSize=large?'22px':'';for(const m of mappings)m.zh.style.fontSize=large?'20px':'';refreshLayout();}}
  };
  await setReading(true);
  return pilot;
};
