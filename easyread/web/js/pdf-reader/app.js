(() => {
  'use strict';
  const $=id=>document.getElementById(id),api=PR.readerApi;
  let serverReader,ready=false,queue=Promise.resolve(),syncing=false,progressTimer;
  const Dual=window.Dual={panes:{},assets:{},active:'source',views:{source:{pageIndex:0},translation:{pageIndex:0}},selection:null};
  Dual.applyPdfTheme=pane=>PR.applyPDFTheme(pane);
  Dual.pageSync=new PDFPageSync({assets:()=>Dual.assets,enabled:()=>ready&&!Dual.layoutChanging&&Dual.layout==='parallel'&&!$('sync').disabled&&$('sync').checked,navigate:async(side,state)=>{
    const view=Dual.panes[side].view;
    const viewer=view._iframeWindow.PDFViewerApplication.pdfViewer;
    // One viewport update: never bounce to the page top before following.
    viewer.scrollPageIntoView({pageNumber:state.pageIndex+1,...(Number.isFinite(state.top)?{destArray:[null,{name:'XYZ'},state.left||0,state.top,null],allowNegativeOffset:true}:{})});
  }});
  Dual.fail=e=>{if(Dual.switchContext){Dual.switchContext=null;$('translationVersion').disabled=false;$('sync').checked=false;$('sync').disabled=true;ready=window.dualReady=true;}console.error(e);$('status').textContent=e.message||String(e);$('status').classList.add('sample-error');};
  const json=async(path,body)=>{
    const send=()=>fetch(api+path,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json','X-Token':PR.token},body:JSON.stringify(body)});
    let r=await send();
    if(r.status===403&&body!==undefined){const fresh=await fetch(api+'/state',{cache:'no-store'});if(fresh.ok){PR.token=(await fresh.json()).token;r=await send();}}
    const d=await r.json();if(!r.ok)throw Error(d.error||'请求失败');return d;
  };
  function rebuild(){
    const reader=structuredClone(serverReader);reader.notes||={};
    for(const [,op] of dualOutbox.entries()){
      if(op.op==='note')reader.notes[op.note.id]=structuredClone(op.note);
      else if(op.op==='note_del'&&reader.notes[op.id])reader.notes[op.id].deleted=true;
      else if(op.op==='paper_note')reader.paper_note={body:op.body||'',at:op.at};
      else if(op.op==='progress'&&Date.parse(op.at)>=Date.parse(reader.progress?.at||'1970-01-01'))reader.progress={...reader.progress,block:op.block,at:op.at,dual_pdf:structuredClone(op.dual_pdf)};
    }
    PR.state.reader=reader;
  }
  const saved=(kind,message)=>{const pending=window.dualOutbox?.pending||0;$('saveState').textContent=message||(pending?'等待保存':'已保存');$('retry').hidden=!pending;};
  async function flush(){
    try{
      const result=await dualOutbox.flush();
      if(!result.operations.length)return;
      if(result.operations.every(op=>op.op==='progress')&&result.progress){
        serverReader.progress=result.progress;rebuild();return;
      }
      serverReader=(await json('/part/reader')).data;rebuild();Dual.restoreHighlights();PR.noteSurface.render();
    }
    catch(e){saved('error','保存未完成 · 本地保留');throw e;}
  }
  PR.flush=flush;PR.poll=async()=>{if(!dualOutbox.pending){serverReader=(await json('/part/reader')).data;PR.state.discussion=(await json('/part/discussion')).data;rebuild();Dual.restoreHighlights();PR.noteSurface.render();}};
  PR.commit=op=>{if(op.op==='note'&&!Dual.matches(op.note.pdf||{})){Dual.fail(Error('旧版本笔记保留且不迁移坐标'));return Promise.reject(Error('旧版本笔记不可覆盖'));}op=structuredClone({...op,at:op.at||PR.nowIso()});if(op.op==='note')op.note.native=(op.note.native||[]).map(a=>({...a,type:op.note.style==='underline'?'underline':'highlight',color:PR.pdfMarkColor(op.note),dateModified:op.note.updated||op.at}));dualOutbox.enqueue(op);rebuild();if(op.op!=='progress'){Dual.restoreHighlights();PR.emit('reader',op);}queue=queue.then(flush).catch(Dual.fail);return queue;};
  Dual.layout='parallel';
  const layoutKey='easyread-pdf-layout:'+location.pathname;
  Dual.setLayout=async(mode,remember=true)=>{
    if (!['source','translation','parallel'].includes(mode)) return;
    if (!Dual.assets.translation) mode='source';
    const generation=Dual.layoutGeneration=(Dual.layoutGeneration||0)+1;
    const states=structuredClone(Dual.views);
    for(const [side,pane] of Object.entries(Dual.panes))states[side].scale=pane.view._iframeWindow.PDFViewerApplication.pdfViewer.currentScaleValue;
    Dual.layoutChanging=true; Dual.pageSync.pending=null; await Dual.pageSync.flight;
    Dual.layout=mode; Dual.clearSelection(); PR.selectionPreview?.clear();
    for(const name of ['source','translation','parallel'])document.body.classList.toggle('pdf-layout-'+name,name===mode);
    for(const button of $('pdfLayout').querySelectorAll('button')){
      button.setAttribute('aria-pressed',String(button.dataset.pdfLayout===mode));
      button.disabled=button.dataset.pdfLayout!=='source'&&!Dual.assets.translation;
    }
    if(remember)try{localStorage.setItem(layoutKey,mode);}catch{}
    Dual.activate(mode==='parallel'?Dual.active:mode);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    if(generation!==Dual.layoutGeneration)return;
    for(const [side,pane] of Object.entries(Dual.panes)){
      if(mode!=='parallel'&&side!==mode)continue;
      const viewer=pane.view._iframeWindow.PDFViewerApplication.pdfViewer,state=states[side];
      viewer.currentScaleValue=state.scale||'page-width';viewer.update();
      viewer.scrollPageIntoView({pageNumber:(state.pageIndex||0)+1,destArray:[null,{name:'XYZ'},state.left||0,state.top||0,null],allowNegativeOffset:true});
    }
    Dual.layoutChanging=false;
    if(mode==='parallel')await Dual.pageSync.request(Dual.active,Dual.views[Dual.active]);
    Dual.saveProgress();
  };
  $('pdfLayout').onclick=e=>{const button=e.target.closest('[data-pdf-layout]');if(button&&!button.disabled)Dual.setLayout(button.dataset.pdfLayout).catch(Dual.fail);};
  Dual.currentAnchor=()=>`${Dual.active}-p${(Dual.views[Dual.active].pageIndex||0)+1}`;
  Dual.matches=pdf=>{const a=Dual.assets[pdf.side];return !!a&&pdf.asset_id===a.id&&pdf.version===a.version&&pdf.sha256===a.sha256;};
  Dual.initialView=side=>{if(side==='translation'&&Dual.switchContext?.sync)return {pageIndex:Dual.views.source.pageIndex||0,scale:Dual.views.source.scale||'page-width'};const v=Dual.savedProgress?.panes?.[side];return v&&Dual.matches({...v,side})?{pageIndex:v.pageIndex,scale:v.scale,top:v.top,left:v.left}:{pageIndex:0,scale:'page-width'};};
  Dual.activate=side=>{Dual.active=side;for(const p of document.querySelectorAll('.pane'))p.classList.toggle('active',p.dataset.side===side);if(document.activeElement!==$('page'))$('page').value=(Dual.views[side].pageIndex||0)+1;$('pageCount').textContent='/ '+Dual.assets[side].page_count;PR.emit('reading-context');};
  Dual.referenceFor=(anchor,quote='')=>{
    if(Dual.selection?.anchor===anchor&&Dual.selection.quote===quote)return structuredClone(Dual.selection);
    const note=PR.myNotes().find(n=>n.anchor===anchor&&n.quote===quote&&Dual.matches(n.pdf||{}));if(note)return {anchor,quote,pdf:structuredClone(note.pdf)};
    const b=PR.blockById[anchor],a=b&&Dual.assets[b.pdf_side];if(!a)return null;
    return {anchor,quote,pdf:{schema:1,document_id:PR.pid,coordinate_space:'pdf-user-space',side:b.pdf_side,asset_id:a.id,version:a.version,sha256:a.sha256,pageIndex:b.page-1,positions:[]}};
  };
  Dual.clearSelection=()=>{Dual.selection=null;$('selectionTools').hidden=true;};
  Dual.selected=selected=>{
    Dual.selection=structuredClone(selected);Dual.activate(selected.pdf.side);
    const pane=Dual.panes[selected.pdf.side],sel=pane.document.getSelection();let rect;
    if(sel?.rangeCount&&!sel.isCollapsed){PR.selectionPreview?.set(pane.document,[sel.getRangeAt(0)]);rect=sel.getRangeAt(0).getBoundingClientRect();const inner=pane.view._iframe.getBoundingClientRect(),outer=$(selected.pdf.side+'Frame').getBoundingClientRect();rect={left:rect.left+inner.left+outer.left,top:rect.top+inner.top+outer.top,bottom:rect.bottom+inner.top+outer.top,width:rect.width};}
    if(!sel?.rangeCount||sel.isCollapsed)PR.selectionPreview?.setBoxes(pane.document,()=>selected.pdf.positions.flatMap(position=>{
      const page=pane.document.querySelector('.page[data-page-number="'+(position.pageIndex+1)+'"] .textLayer'),box=page?.getBoundingClientRect(),viewport=pane.view._iframeWindow.PDFViewerApplication.pdfViewer.getPageView(position.pageIndex)?.viewport;
      if(!box||!viewport)return [];return position.rects.map(r=>{const a=viewport.convertToViewportPoint(r[0],r[1]),b=viewport.convertToViewportPoint(r[2],r[3]);return {left:box.left+Math.min(a[0],b[0])*box.width/viewport.width,top:box.top+Math.min(a[1],b[1])*box.height/viewport.height,width:Math.abs(a[0]-b[0])*box.width/viewport.width,height:Math.abs(a[1]-b[1])*box.height/viewport.height};});
    }));
    PR.showPDFSelection(rect);
  };
  Dual.restoreHighlights=()=>{
    for(const [side,pane] of Object.entries(Dual.panes)){
      const annotations=PR.myNotes().filter(n=>n.pdf?.side===side&&Dual.matches(n.pdf)).flatMap(n=>(n.native||[]).map(a=>({...a,comment:n.body||'',type:n.style==='underline'?'underline':'highlight',color:PR.pdfMarkColor(n)})));
      pane.reader.setAnnotations(annotations);
    }
  };
  Dual.annotate=async(s,kind='highlight',color='yellow')=>{
    const id=PR.uid('pdf-'),stamp=PR.nowIso(),style=PR.prefs.pen||'marker';
    const native=s.pdf.positions.map((position,i)=>({id:id+'-'+i,type:style==='underline'?'underline':'highlight',tags:[],position,text:s.quote,color:PR.pdfMarkColor({style,color}),sortIndex:String(position.pageIndex).padStart(5,'0')+'|000000|000000',pageLabel:String(position.pageIndex+1),authorName:'EasyRead',readOnly:true,dateCreated:stamp,dateModified:stamp}));
    const note={id,kind,body:'',style,language:s.pdf.side==='source'?'en':'zh',anchor:s.anchor,quote:s.quote,color,pdf:s.pdf,native,created:stamp,updated:stamp};
    await PR.commit({op:'note',note});if(kind==='highlight')PR.toast('已划线，点划线可以写笔记',{label:'撤销',fn:()=>PR.commit({op:'note_del',id})},2600);else PR.noteSurface.openEditor(id);return note;
  };
  Dual.annotationClicked=(side,pageIndex,x,y,rect)=>{
    const note=PR.myNotes().slice().reverse().find(n=>n.pdf?.side===side&&Dual.matches(n.pdf)&&n.pdf.positions.some(p=>p.pageIndex===pageIndex&&p.rects.some(r=>x>=r[0]-2&&x<=r[2]+2&&y>=r[1]-2&&y<=r[3]+2)));
    if(note){Dual.activate(side);if(note.kind!=='highlight')PR.noteSurface.openEditor(note.id);else PR.showPDFMark(note.id,rect);}
  };
  PR.on('reader-theme-changed',()=>Dual.restoreHighlights());
  Dual.goto=async(anchor,nid)=>{
    const note=nid&&PR.state.reader.notes[nid],ref=note?{anchor:note.anchor,quote:note.quote,pdf:note.pdf}:Dual.referenceFor(anchor);
    if(!ref?.pdf||!Dual.matches(ref.pdf))throw Error('文件版本已变化，旧笔记保持原版本');
    if(Dual.layout!=='parallel'&&Dual.layout!==ref.pdf.side)await Dual.setLayout(ref.pdf.side);
    Dual.activate(ref.pdf.side);await Dual.navigate(ref.pdf.side,ref.pdf.pageIndex,false);
    if(note?.native?.length)await Dual.panes[ref.pdf.side].view.navigate({annotationID:note.native[0].id},{block:'center',ifNeeded:false});
    return ref;
  };
  Dual.navigate=async(side,pageIndex,sync=$('sync').checked)=>{
    if(!Number.isInteger(pageIndex)||pageIndex<0||pageIndex>=Dual.assets[side].page_count)throw Error('页码超出范围');
    const sides=sync&&Dual.layout==='parallel'?Object.keys(Dual.panes).filter(k=>pageIndex<Dual.assets[k].page_count):[side];syncing=true;
    try{await Promise.all(sides.map(async k=>{await Dual.panes[k].view.navigate({pageIndex});}));}
    finally{requestAnimationFrame(()=>{syncing=false;Dual.activate(side);Dual.saveProgress();});}
  };
  Dual.viewChanged=(side,state,live=false)=>{
    const changed=['pageIndex','scale','top','left'].some(k=>k in state&&state[k]!==Dual.views[side][k]);Dual.views[side]={...Dual.views[side],...state};const pageIndex=Dual.views[side].pageIndex||0;$(side+'Page').textContent=`第 ${pageIndex+1} 页 · v${Dual.assets[side].version}`;
    if(side===Dual.active&&document.activeElement!==$('page'))$('page').value=pageIndex+1;
    if(!ready)return;
    if(changed&&!syncing&&!Dual.layoutChanging&&side===Dual.active&&$('sync').checked&&(live||!Dual.panes[side]?.liveSync))Dual.pageSync.request(side,Dual.views[side]).catch(Dual.fail);
    if(changed)Dual.saveProgress();
  };
  Dual.saveProgressNow=()=>{if(!ready)return;clearTimeout(progressTimer);
    const panes={};for(const side of Object.keys(Dual.assets)){const v=Dual.views[side],a=Dual.assets[side];panes[side]={asset_id:a.id,version:a.version,sha256:a.sha256,pageIndex:v.pageIndex||0,scale:v.scale||'page-width',top:v.top||0,left:v.left||0};}
    return PR.commit({op:'progress',block:Dual.currentAnchor(),ratio:(Dual.views.source.pageIndex||0)/Math.max(1,Dual.assets.source.page_count-1),dual_pdf:{schema:1,document_id:PR.pid,panes,active:Dual.active,sync:$('sync').checked}});
  };
  Dual.saveProgress=()=>{if(!ready)return;clearTimeout(progressTimer);progressTimer=setTimeout(()=>Dual.saveProgressNow(),700);};
  Dual.paneReady=async(side,pane)=>{
    if(pane.assetId&&pane.assetId!==Dual.assets[side]?.id)return;
    Dual.panes[side]=pane;PR.applyPDFTheme(pane);Dual.restoreHighlights();
    if(Object.keys(Dual.panes).length!==Object.keys(Dual.assets).length)return;
    const saved=PR.state.reader.progress?.dual_pdf;
    if(saved&&!Dual.switchContext){$('sync').checked=!$('sync').disabled&&saved.sync!==false;Dual.activate(Dual.assets[saved.active]?saved.active:'source');}
    ready=window.dualReady=true;$('status').textContent=(Dual.assets.translation?'原文与译文已就绪':'原文已就绪 · 尚无译文 PDF')+' · 选中文字可划线、写笔记或问 AI';
    if(Dual.switchContext){const context=Dual.switchContext;Dual.switchContext=null;$('translationVersion').disabled=false;Dual.activate('source');await Dual.pageSync.request('source',Dual.views.source);Dual.activate(context.active);PR.refreshPDFChatContext?.();Dual.saveProgress();}
    else{saved&&Dual.saveProgress();Dual.pageSync.request(Dual.active,Dual.views[Dual.active]).catch(Dual.fail);}
    let layout=Dual.layout;try{layout=localStorage.getItem(layoutKey)||layout;}catch{}
    await Dual.setLayout(layout,false);
  };
  PR.previewPDFContext=async payload=>{
    await PR.flush();const refs=payload.refs.map(r=>r.pdf?r:Dual.referenceFor(r.anchor,r.quote));
    const result=await json('/context-preview',{...payload,refs});Dual.lastPreview=result;
    document.getElementById('contextPreview')?.remove();const panel=PR.$('#chatpanel'),box=document.createElement('div');box.id='contextPreview';box.className='ctx-preview';
    const h=document.createElement('h3');h.textContent='引用预览 · 未调用模型';box.append(h);
    for(const ref of result.refs){const label=document.createElement('strong');label.textContent=ref.label;const q=document.createElement('div');q.className='preview-quote';q.textContent=ref.quote||'当前页';const details=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('pre');summary.textContent='查看随问题携带的页内上下文';text.textContent=ref.nearby_text;details.append(summary,text);box.append(label,q,details);}
    panel.append(box);box.scrollIntoView({block:'nearest'});$('status').textContent='已确认 PDF 来源、页码和选中文字；未调用模型';return result;
  };
  const originalStartNote=PR.startNote;
  PR.startNote=opts=>{const ref=Dual.referenceFor(opts.anchor,opts.quote||'');return originalStartNote({...opts,pdf:opts.pdf||ref?.pdf,native:opts.native||[]});};
  $('notesBtn').onclick=()=>PR.toggleNotesPanel();$('chatBtn').onclick=()=>PR.toggleChat();
  $('prev').onclick=()=>Dual.navigate(Dual.active,(Dual.views[Dual.active].pageIndex||0)-1).catch(Dual.fail);
  $('next').onclick=()=>Dual.navigate(Dual.active,(Dual.views[Dual.active].pageIndex||0)+1).catch(Dual.fail);
  $('page').onchange=()=>Dual.navigate(Dual.active,Number($('page').value)-1).catch(Dual.fail);$('sync').onchange=()=>{Dual.pageSync.request(Dual.active,Dual.views[Dual.active]).catch(Dual.fail);Dual.saveProgress();};
  $('page').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();Dual.navigate(Dual.active,Number($('page').value)-1).catch(Dual.fail);}};
  for(const [button,method] of [['zoomIn','zoomIn'],['zoomOut','zoomOut'],['fit','zoomPageWidth']])$(button).onclick=()=>{Dual.panes[Dual.active].reader[method]();};
  $('retry').onclick=()=>PR.flush().catch(Dual.fail);window.addEventListener('online',()=>PR.flush().catch(Dual.fail));
  const preserveEdits=()=>{PR.flushNotesPanelEdits?.();Dual.saveProgressNow();};
  window.addEventListener('pagehide',preserveEdits);window.addEventListener('beforeunload',preserveEdits);
  PR.openExport=()=>{const text=PR.notesMarkdown();const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/markdown'}));a.download='PDF阅读笔记.md';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
  const originalCard=PR.cardHtml;
  PR.cardHtml=(item,editingId)=>{
    const html=originalCard(item,editingId),note=item.data;
    if(!note.pdf||note.pdf_status!=='stale')return html;
    const label=PR.pdfReferenceLabel(note)+(note.pdf_status==='stale'?' · 旧版本，坐标已停用':'');
    return html.replace('<div class="lbl">','<div class="pdf-note-identity">'+PR.esc(label)+'</div><div class="lbl">');
  };
  $('findTranslation').onclick=async()=>{try{preserveEdits();await PR.flush();await json('/refresh',{});location.reload();}catch(e){Dual.fail(e);}};
  Dual.selectTranslation=async id=>{
    const select=$('translationVersion');if(select.disabled)throw Error('译文正在切换，请稍后重试');
    const old=Dual.assets.translation;if(old?.id===id&&Dual.panes.translation?.assetId===id)return;
    select.disabled=true;
    try{
      preserveEdits();await PR.flush();
      const state=await json('/select-translation',{asset_id:id});
      if(state.id!==PR.pid||state.assets.source.sha256!==Dual.assets.source.sha256){location.reload();return;}
      const active=Dual.active,sync=(old?$('sync').checked:true)&&state.assets.source.page_count===state.assets.translation.page_count;
      ready=window.dualReady=false;Dual.pageSync.pending=null;await Dual.pageSync.flight;Dual.clearSelection();Dual.switchContext={active,sync};
      Dual.panes.translation?.view.destroy?.();delete Dual.panes.translation;
      Dual.assets=state.assets;Dual.views.translation={pageIndex:0};Dual.legacySources=state.legacy_sources||[];Dual.savedProgress=state.reader.progress?.dual_pdf;
    if(state.web_read_url)PR.readerShell?.setModes([{label:'PDF 对照',current:true,href:location.pathname},{label:'arXiv 网页',href:state.web_read_url}]);serverReader=state.reader;
      PR.state.paper=state.paper;PR.state.discussion=state.discussion;PR.blockById={};PR.order={};
      state.paper.blocks.forEach((b,i)=>{PR.blockById[b.id]=b;PR.order[b.id]=i;});
      rebuild();PR.noteSurface.render();$('sync').disabled=state.assets.source.page_count!==state.assets.translation.page_count;$('sync').checked=sync;$('sync').title=$('sync').disabled?'没有译文或两侧页数不同，使用独立翻页':'两侧按 PDF 页码和页内位置同步';
      $('translationPage').textContent='正在加载译文 · v'+state.assets.translation.version;
      $('readingNotice').textContent='原版式 PDF 对照 · 原文 '+state.assets.source.page_count+' 页，译文 '+state.assets.translation.page_count+' 页 · 不自动调用模型';
      select.replaceChildren(...state.translation_options.map(v=>{const o=document.createElement('option');o.value=v.id;o.textContent=v.label;o.selected=v.id===id;return o;}));select.hidden=state.translation_options.length<2;
      $('translationFrame').hidden=false;$('translationPending').hidden=true;document.body.classList.remove('source-only');$('status').textContent='正在加载译文 · 原文仍可阅读';
      const frame=$('translationFrame');frame.dataset.side='translation';frame.onload=()=>{const script=frame.contentDocument.createElement('script');script.src='/web/js/pdf-dual/pane.js';frame.contentDocument.head.append(script);};frame.src='/web/vendor/zotero/native-reader.html';
    }catch(e){select.value=old?.id||'';select.disabled=false;throw e;}
  };
  $('translationVersion').onchange=()=>Dual.selectTranslation($('translationVersion').value).catch(Dual.fail);
  const renderNotes=PR.renderNotesPanel;
  PR.renderNotesPanel=(id)=>{
    renderNotes(id);const list=$('notespanel').querySelector('.np-list');if(!list||list.querySelector('#legacyPdfNotes'))return;
    const group=document.createElement('section');group.id='legacyPdfNotes';
    for(const source of Dual.legacySources||[]){
      const heading=document.createElement('h3');heading.textContent=source.label;group.append(heading);
      const link=document.createElement('button');link.textContent='查看历史阅读记录';link.onclick=()=>PR.openReadingHistory?.(source.id);group.append(link);
      for(const note of source.notes||[]){const card=document.createElement('div');card.className='legacy-note';const quote=document.createElement('blockquote');quote.textContent=note.quote||'';const body=document.createElement('div');body.innerHTML=PR.mdBlocks(note.body||'');card.append(quote,body);group.append(card);}
      if(source.paper_note){const body=document.createElement('div');body.innerHTML=PR.mdBlocks(source.paper_note);group.append(body);}
    }
    if(group.childNodes.length)list.append(group);
  };
  const markdownNotes=PR.notesMarkdown;
  PR.notesMarkdown=(...args)=>markdownNotes(...args)+(Dual.legacySources||[]).map(s=>'\n\n## '+s.label+'\n\n[历史阅读记录]('+location.origin+'/api/reading-history/'+PR.routePid+')\n\n'+(s.paper_note||'')+'\n'+(s.notes||[]).map(n=>(n.quote?'> '+n.quote+'\n\n':'')+(n.body||'')).join('\n\n')).join('');
  document.addEventListener('keydown',e=>{if(e.key==='Escape')Dual.clearSelection();});
  (async()=>{
    const state=await json('/state');PR.pid=PR.paperKey=state.id;Dual.legacySources=state.legacy_sources||[];document.title='EasyRead · '+(state.paper?.meta?.title_en||state.title);$('paperTitle').textContent=state.paper?.meta?.title_en||state.title;$('paperTitle').title=$('paperTitle').textContent;Dual.assets=state.assets;PR.token=state.token;PR.initPDFTheme(state.appearance);PR.state.paper=state.paper;PR.state.discussion=state.discussion||{entries:[]};serverReader=state.reader;Dual.savedProgress=state.reader.progress?.dual_pdf;
    if(state.web_read_url)PR.readerShell?.setModes([{label:'PDF 对照',current:true,href:location.pathname},{label:'arXiv 网页',href:state.web_read_url}]);
    const translated=!!state.assets.translation;
    document.body.classList.toggle('source-only',!translated);$('translationFrame').hidden=!translated;$('translationPending').hidden=translated;$('translationPage').textContent=translated?'第 1 页 · v'+state.assets.translation.version:'尚无译文';
    $('sync').disabled=!translated||state.assets.source.page_count!==state.assets.translation.page_count;
    $('sync').title=$('sync').disabled?'没有译文或两侧页数不同，使用独立翻页':'两侧按 PDF 页码和页内位置同步';
    $('sync').checked=!$('sync').disabled;
    $('readingNotice').textContent=translated?'原版式 PDF 对照 · 原文 '+state.assets.source.page_count+' 页，译文 '+state.assets.translation.page_count+' 页 · 不自动调用模型':'原文 PDF · 尚无译文，先读原文 · 不自动调用模型';
    $('pageCount').textContent='/ '+state.assets.source.page_count;
    const versions=state.translation_options||[];$('translationVersion').hidden=versions.length<2;
    for(const v of versions){const option=document.createElement('option');option.value=v.id;option.textContent=v.label;option.selected=v.id===state.assets.translation?.id;$('translationVersion').append(option);}
    state.paper.blocks.forEach((b,i)=>{PR.blockById[b.id]=b;PR.order[b.id]=i;});
    window.dualOutbox=new ReflowOutbox({storage:localStorage,key:'easyread-pdf-dual-v1:'+state.id,request:json,changed:saved});rebuild();Dual.savedProgress=PR.state.reader.progress?.dual_pdf;
    PR.sectionOf=PR.sectionLabel;
    for(const side of Object.keys(Dual.assets)){
      const frame=$(side+'Frame');frame.dataset.side=side;frame.onload=()=>{const script=frame.contentDocument.createElement('script');script.src='/web/js/pdf-dual/pane.js';frame.contentDocument.head.append(script);};frame.src='/web/vendor/zotero/native-reader.html';
    }
    if(dualOutbox.pending)await PR.flush();saved('saved');
  })().catch(Dual.fail);
})();
