(() => {
  'use strict';
  const $=id=>document.getElementById(id),api='/experiments/pdf-dual/'+PR.pid;
  let serverReader,ready=false,queue=Promise.resolve(),syncing=false,progressTimer;
  const Dual=window.Dual={panes:{},assets:{},active:'source',views:{source:{pageIndex:0},translation:{pageIndex:0}},selection:null};
  Dual.fail=e=>{console.error(e);$('status').textContent=e.message||String(e);$('status').classList.add('sample-error');};
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
    try{await dualOutbox.flush();serverReader=(await json('/part/reader')).data;rebuild();Dual.restoreHighlights();PR.noteSurface.render();}
    catch(e){saved('error','保存未完成 · 本地保留');throw e;}
  }
  PR.flush=flush;PR.poll=async()=>{if(!dualOutbox.pending){serverReader=(await json('/part/reader')).data;rebuild();Dual.restoreHighlights();PR.noteSurface.render();}};
  PR.commit=op=>{if(op.op==='note'&&!Dual.matches(op.note.pdf||{})){Dual.fail(Error('旧版本笔记保留且不迁移坐标'));return Promise.reject(Error('旧版本笔记不可覆盖'));}op={...op,at:op.at||PR.nowIso()};dualOutbox.enqueue(op);rebuild();Dual.restoreHighlights();PR.emit('reader',op);queue=queue.then(flush).catch(Dual.fail);return queue;};
  Dual.currentAnchor=()=>`${Dual.active}-p${(Dual.views[Dual.active].pageIndex||0)+1}`;
  Dual.matches=pdf=>{const a=Dual.assets[pdf.side];return !!a&&pdf.asset_id===a.id&&pdf.version===a.version&&pdf.sha256===a.sha256;};
  Dual.initialView=side=>{const v=Dual.savedProgress?.panes?.[side];return v&&Dual.matches({...v,side})?{pageIndex:v.pageIndex,scale:v.scale,top:v.top,left:v.left}:{pageIndex:0,scale:'page-width'};};
  Dual.activate=side=>{Dual.active=side;for(const p of document.querySelectorAll('.pane'))p.classList.toggle('active',p.dataset.side===side);if(document.activeElement!==$('page'))$('page').value=(Dual.views[side].pageIndex||0)+1;PR.emit('reading-context');};
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
    if(sel?.rangeCount&&!sel.isCollapsed){rect=sel.getRangeAt(0).getBoundingClientRect();const inner=pane.view._iframe.getBoundingClientRect(),outer=$(selected.pdf.side+'Frame').getBoundingClientRect();rect={left:rect.left+inner.left+outer.left,bottom:rect.bottom+inner.top+outer.top};}
    $('selectionLabel').textContent=`${selected.pdf.side==='source'?'原文':'译文'} · 第 ${selected.pdf.pageIndex+1} 页`;
    $('selectionTools').hidden=false;$('selectionTools').style.left=Math.max(8,Math.min(rect?.left||20,innerWidth-470))+'px';$('selectionTools').style.top=Math.min(rect?.bottom+8||140,innerHeight-65)+'px';
  };
  Dual.restoreHighlights=()=>{
    for(const [side,pane] of Object.entries(Dual.panes)){
      const annotations=PR.myNotes().filter(n=>n.pdf?.side===side&&Dual.matches(n.pdf)).flatMap(n=>(n.native||[]).map(a=>({...a,comment:n.body||'',color:{yellow:'#ffd400',green:'#5fb236',blue:'#a28ae5',pink:'#e56eee'}[n.color]||'#ffd400'})));
      pane.reader.setAnnotations(annotations);
    }
  };
  Dual.highlight=async()=>{
    if(!Dual.selection)throw Error('请先选中文字');const s=structuredClone(Dual.selection),id=PR.uid('pdf-'),stamp=PR.nowIso();
    const native=s.pdf.positions.map((position,i)=>({id:id+'-'+i,type:'highlight',tags:[],position,text:s.quote,color:s.pdf.side==='source'?'#ffd400':'#a28ae5',sortIndex:String(position.pageIndex).padStart(5,'0')+'|000000|000000',pageLabel:String(position.pageIndex+1),authorName:'EasyRead',readOnly:true,dateCreated:stamp,dateModified:stamp}));
    const note={id,kind:'highlight',body:'',language:s.pdf.side==='source'?'en':'zh',anchor:s.anchor,quote:s.quote,color:s.pdf.side==='source'?'yellow':'blue',pdf:s.pdf,native,created:stamp,updated:stamp};
    await PR.commit({op:'note',note});PR.noteSurface.openEditor(id);return note;
  };
  Dual.goto=async(anchor,nid)=>{
    const note=nid&&PR.state.reader.notes[nid],ref=note?{anchor:note.anchor,quote:note.quote,pdf:note.pdf}:Dual.referenceFor(anchor);
    if(!ref?.pdf||!Dual.matches(ref.pdf))throw Error('文件版本已变化，旧笔记保持原版本');
    Dual.activate(ref.pdf.side);await Dual.navigate(ref.pdf.side,ref.pdf.pageIndex,false);
    if(note?.native?.length)await Dual.panes[ref.pdf.side].view.navigate({annotationID:note.native[0].id},{block:'center',ifNeeded:false});
    return ref;
  };
  Dual.navigate=async(side,pageIndex,sync=$('sync').checked)=>{
    if(!Number.isInteger(pageIndex)||pageIndex<0||pageIndex>=Dual.assets[side].page_count)throw Error('页码超出范围');
    const sides=sync?Object.keys(Dual.panes):[side];syncing=true;
    try{await Promise.all(sides.map(async k=>{Dual.views[k].pageIndex=pageIndex;await Dual.panes[k].view.navigate({pageNumber:String(pageIndex+1)});}));}
    finally{setTimeout(()=>{syncing=false;Dual.activate(side);Dual.saveProgress();},450);}
  };
  Dual.viewChanged=(side,state)=>{
    Dual.views[side]={...Dual.views[side],...state};const pageIndex=Dual.views[side].pageIndex||0;$(side+'Page').textContent=`第 ${pageIndex+1} 页 · v${Dual.assets[side].version}`;
    if(side===Dual.active&&document.activeElement!==$('page'))$('page').value=pageIndex+1;
    if(!ready)return;
    if(!syncing&&side===Dual.active&&$('sync').checked){const other=side==='source'?'translation':'source';if(Dual.views[other].pageIndex!==pageIndex)Dual.navigate(side,pageIndex,true).catch(Dual.fail);}
    Dual.saveProgress();
  };
  Dual.saveProgress=()=>{if(!ready)return;clearTimeout(progressTimer);progressTimer=setTimeout(()=>{
    const panes={};for(const [side,v] of Object.entries(Dual.views)){const a=Dual.assets[side];panes[side]={asset_id:a.id,version:a.version,sha256:a.sha256,pageIndex:v.pageIndex||0,scale:v.scale||'page-width',top:v.top||0,left:v.left||0};}
    PR.commit({op:'progress',block:Dual.currentAnchor(),dual_pdf:{schema:1,document_id:PR.pid,panes,active:Dual.active,sync:$('sync').checked}});
  },700);};
  Dual.paneReady=async(side,pane)=>{
    Dual.panes[side]=pane;Dual.restoreHighlights();
    if(Object.keys(Dual.panes).length!==2)return;
    const saved=PR.state.reader.progress?.dual_pdf;
    if(saved){$('sync').checked=saved.sync!==false;Dual.activate(saved.active||'source');}
    ready=window.dualReady=true;$('status').textContent='原文与译文已就绪 · 选中文字可划线、写笔记或问 AI';saved&&Dual.saveProgress();
  };
  PR.previewContext=async payload=>{
    await PR.flush();const refs=payload.refs.map(r=>r.pdf?r:Dual.referenceFor(r.anchor,r.quote));
    const result=await json('/context-preview',{...payload,refs});Dual.lastPreview=result;
    document.getElementById('contextPreview')?.remove();const panel=PR.$('#chatpanel'),box=document.createElement('div');box.id='contextPreview';box.className='ctx-preview';
    const h=document.createElement('h3');h.textContent='引用预览 · 未调用模型';box.append(h);
    for(const ref of result.refs){const label=document.createElement('strong');label.textContent=ref.label;const q=document.createElement('div');q.className='preview-quote';q.textContent=ref.quote||'当前页';const details=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('pre');summary.textContent='查看随问题携带的页内上下文';text.textContent=ref.nearby_text;details.append(summary,text);box.append(label,q,details);}
    panel.append(box);box.scrollIntoView({block:'nearest'});$('status').textContent='已确认 PDF 来源、页码和选中文字；本实验未调用模型';return result;
  };
  const originalStartNote=PR.startNote;
  PR.startNote=opts=>{const ref=Dual.referenceFor(opts.anchor,opts.quote||'');return originalStartNote({...opts,pdf:opts.pdf||ref?.pdf,native:opts.native||[]});};
  $('notesBtn').onclick=()=>PR.toggleNotesPanel();$('chatBtn').onclick=()=>PR.toggleChat();
  $('selectionTools').addEventListener('mousedown',e=>e.preventDefault());
  $('highlight').onclick=()=>Dual.highlight().catch(Dual.fail);$('ask').onclick=()=>{if(Dual.selection){const ref=structuredClone(Dual.selection);Dual.clearSelection();PR.chatAsk(ref);}};
  $('copy').onclick=()=>navigator.clipboard.writeText(Dual.selection?.quote||'').catch(Dual.fail);
  $('prev').onclick=()=>Dual.navigate(Dual.active,(Dual.views[Dual.active].pageIndex||0)-1).catch(Dual.fail);
  $('next').onclick=()=>Dual.navigate(Dual.active,(Dual.views[Dual.active].pageIndex||0)+1).catch(Dual.fail);
  $('page').onchange=()=>Dual.navigate(Dual.active,Number($('page').value)-1).catch(Dual.fail);$('sync').onchange=()=>Dual.saveProgress();
  $('page').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();Dual.navigate(Dual.active,Number($('page').value)-1).catch(Dual.fail);}};
  for(const [button,method] of [['zoomIn','zoomIn'],['zoomOut','zoomOut'],['fit','zoomPageWidth']])$(button).onclick=()=>{Dual.panes[Dual.active].reader[method]();};
  $('retry').onclick=()=>PR.flush().catch(Dual.fail);window.addEventListener('online',()=>PR.flush().catch(Dual.fail));
  PR.openExport=()=>{const text=PR.notesMarkdown();const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/markdown'}));a.download='DoReMi-PDF实验笔记.md';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
  const originalCard=PR.cardHtml;
  PR.cardHtml=(item,editingId)=>{
    const html=originalCard(item,editingId),note=item.data;
    if(!note.pdf||note.pdf_status!=='stale')return html;
    const label=PR.pdfReferenceLabel(note)+(note.pdf_status==='stale'?' · 旧版本，坐标已停用':'');
    return html.replace('<div class="lbl">','<div class="pdf-note-identity">'+PR.esc(label)+'</div><div class="lbl">');
  };
  document.addEventListener('keydown',e=>{if(e.key==='Escape')Dual.clearSelection();});
  (async()=>{
    const state=await json('/state');Dual.assets=state.assets;PR.token=state.token;PR.state.paper=state.paper;serverReader=state.reader;Dual.savedProgress=state.reader.progress?.dual_pdf;
    state.paper.blocks.forEach((b,i)=>{PR.blockById[b.id]=b;PR.order[b.id]=i;});
    window.dualOutbox=new ReflowOutbox({storage:localStorage,key:'easyread-pdf-dual-v1:'+state.id,request:json,changed:saved});rebuild();Dual.savedProgress=PR.state.reader.progress?.dual_pdf;
    PR.sectionOf=PR.sectionLabel;
    for(const side of Object.keys(Dual.assets)){
      const frame=$(side+'Frame');frame.dataset.side=side;frame.onload=()=>{const script=frame.contentDocument.createElement('script');script.src='/web/js/pdf-dual/pane.js';frame.contentDocument.head.append(script);};frame.src='/web/vendor/zotero/reader.html';
    }
    if(dualOutbox.pending)await PR.flush();saved('saved');
  })().catch(Dual.fail);
})();
