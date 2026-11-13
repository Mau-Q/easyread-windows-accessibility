'use strict';
(() => {
  const $=id=>document.getElementById(id),id=PR.pid,api='/api/p/'+encodeURIComponent(id);
  const verification=new URLSearchParams(location.search).get('verification')==='1';
  const status=text=>{$('status').textContent=text;},fail=e=>{status(e.message||String(e));PR.toast(PR.esc(e.message||String(e)));};
  let state,pilot,canonical={},queue=Promise.resolve(),outbox,serverReader={},ready=false,retryTimer,pollTimer;
  const json=async(path,body)=>{
    const send=()=>fetch(api+path,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json','X-Token':state.token},body:JSON.stringify(body)});
    let r=await send();
    if(r.status===403&&body!==undefined){const fresh=await fetch(api+'/reflow/state',{cache:'no-store'});if(fresh.ok){state.token=PR.token=(await fresh.json()).token;r=await send();}}
    const data=await r.json();if(!r.ok)throw new Error(data.error||'请求失败 '+r.status);return data;
  };
  const run=fn=>Promise.resolve().then(fn).catch(fail);
  $('legacy').href='/read/'+id+'?source=pdf&mode=legacy';$('original').href='/p/'+id+'/source.pdf';
  $('notesBtn').onclick=()=>run(()=>{if(ready)PR.toggleNotesPanel();else status('阅读器正在准备…');});
  $('chatBtn').onclick=()=>run(()=>{if(ready)PR.toggleChat();else status('阅读器正在准备…');});
  $('translateBtn').onclick=()=>{$('translationTools').hidden=!$('translationTools').hidden;$('translateBtn').setAttribute('aria-expanded',String(!$('translationTools').hidden));};
  $('continueTranslate').onclick=()=>run(()=>json('/translate',{scope:'all'}));$('cancelTranslate').onclick=()=>run(()=>json('/cancel',{}));
  $('jumpAbstract').onclick=()=>run(()=>{const m=pilot?.mappings.find(m=>m.legacy.role==='abstract'||/^(abstract|摘要)$/i.test(m.rec.source_english.trim()));if(m)return pilot.jump(m.anchor,true);throw new Error('未找到摘要位置');});
  $('selectionTools').addEventListener('mousedown',e=>e.preventDefault());
  window.addEventListener('beforeunload',event=>{PR.flushNotesPanelEdits?.();if(outbox?.volatile){event.preventDefault();event.returnValue='';}});
  window.addEventListener('pagehide',()=>{if(ready&&!verification)try{outbox.enqueue({op:'progress',...pilot.progress(),at:new Date().toISOString()});}catch(e){saveStatus('error',e.message);}});
  $('retry').onclick=()=>run(flush);$('theme').onclick=()=>PR.toggleReaderThemePicker($('theme'));$('back').onclick=()=>run(()=>pilot.goBack());
  PR.on('reader-theme-changed',()=>{pilot?.applyTheme();$('theme').textContent='配色 · '+PR.READER_THEMES.find(t=>t.id===PR.readerThemeValue()).label;});
  PR.on('ui-changed',()=>{$('chatBtn').hidden=!PR.feature('chat');});
  window.addEventListener('online',()=>run(flush));
  function rebuildReader(){
    const reader=structuredClone(serverReader);reader.notes||={};
    for(const [,op] of outbox.entries()){
      if(op.op==='note')reader.notes[op.note.id]=structuredClone(op.note);
      else if(op.op==='note_del'&&reader.notes[op.id])reader.notes[op.id].deleted=true;
      else if(op.op==='paper_note')reader.paper_note={body:op.body||'',at:op.at};
    }
    PR.state.reader=reader;canonical=Object.fromEntries(Object.entries(reader.notes).filter(([,n])=>!n.deleted));
  }
  function renderNotes(){PR.noteSurface.render();}
  function saveStatus(kind,message){$('retry').hidden=!outbox?.pending;const label=message||(kind==='saved'?'已保存':outbox?.pending?'等待保存':'已保存');$('saveStatus').textContent=label;$('saveState').dataset.s=kind;$('saveState').querySelector('span').textContent=label;}
  async function flush(){
    if(!outbox)return;
    try{await outbox.flush();serverReader=(await json('/part/reader')).data;rebuildReader();if(pilot)await restoreNotes();renderNotes();clearTimeout(retryTimer);}
    catch(e){saveStatus('error','保存未完成，修改已保留：'+e.message);clearTimeout(retryTimer);if(!e.conflict)retryTimer=setTimeout(()=>run(flush),5000);throw e;}
  }
  PR.commit=op=>{
    op={...op,at:op.at||PR.nowIso()};outbox.enqueue(op);rebuildReader();
    PR.emit('reader',op);
    queue=queue.then(async()=>{if(pilot)await restoreNotes();renderNotes();await flush();}).catch(fail);
    return queue;
  };
  PR.flush=async()=>{await flush();const fresh=await json('/reflow/state');state.token=PR.token=fresh.token;};
  PR.poll=async()=>{
    if(outbox.pending)return;
    const [reader,discussion]=await Promise.all([json('/part/reader'),json('/part/discussion')]);
    serverReader=reader.data;PR.state.discussion=discussion.data||{entries:[]};rebuildReader();
    if(pilot)await restoreNotes();renderNotes();
  };
  PR.applyMarks=()=>run(()=>pilot&&restoreNotes());
  for(const [button,method] of Object.entries({copy:'copy',highlight:'highlight',pdf:'gotoPDF',reading:'toggleReading',zhToggle:'toggleChinese',font:'larger',ask:'ask'}))$(button).onclick=()=>run(async()=>{if(!pilot)throw new Error('阅读器尚未就绪');if(button==='highlight'&&!pilot.selection?.anchors?.length)throw new Error('该选区尚无原段落映射');const value=await pilot[method]();if(button==='highlight'&&!pilot.reading&&value?._canonicalId)PR.noteSurface.openEditor(value._canonicalId);return value;});
  async function persistNotes(data){
    for(const n of data.notes){if(n._canonicalId)continue;
      const key='reflow-'+n.id;if(canonical[key])continue;
      const now=new Date().toISOString(),native=data.native.filter(a=>(n.nativeIds||[n.id]).includes(a.id));
      outbox.enqueue({op:'note',at:now,note:{id:key,language:n.language,anchor:n.anchor,key:n.language==='zh'?n.anchor:undefined,quote:n.quote,kind:'highlight',color:n.language==='en'?'yellow':'blue',body:'',created:now,updated:now,reflow:{source_sha256:state.source_sha256,selection:n,native}}});n._canonicalId=key;
    }
    rebuildReader();renderNotes();await flush();status('划线已保存到 EasyRead 笔记');
  }
  const save=(name,data)=>{if(name!=='annotations')return Promise.resolve();const job=queue.then(()=>persistNotes(data));queue=job.catch(fail);return job;};
  async function progress(position){if(!ready||verification)return;PR.emit('reading-context');const at=new Date().toISOString();outbox.enqueue({op:'progress',...position,at});clearTimeout(pollTimer);pollTimer=setTimeout(()=>run(flush),1000);}
  async function inspect(payload){
    const s=payload.selection,refs=s.refs||s.anchors.map(anchor=>({anchor,quote:s.quote}));
    const checked=await json('/reflow/context',{source_sha256:state.source_sha256,refs});
    for(const ref of checked.refs)PR.chatAsk(ref);
    status('引用上下文已确认；点击发送才会调用模型');
  }
  function selectionRect(){
    const view=pilot?.reading?pilot.reader._primarySDTView:pilot?.reader._primaryView;
    const selected=view?._iframeWindow.getSelection();let r;
    if(selected?.rangeCount&&!selected.isCollapsed)r=selected.getRangeAt(0).getBoundingClientRect();
    else if(view&&!pilot.reading&&pilot.selection?.pdfPosition){const b=view.getClientRectForPopup(pilot.selection.pdfPosition);r={left:b[0],top:b[1],bottom:b[3],width:b[2]-b[0]};}
    if(!r)return null;
    const outer=$('readerFrame').getBoundingClientRect(),inner=view._iframe.getBoundingClientRect();
    return {left:inner.left+outer.left+r.left,top:inner.top+outer.top+r.top,bottom:inner.top+outer.top+r.bottom,width:r.width};
  }
  window.pilotUI={status,selectionRect,selection(s){$('quote').textContent=s?.quote||'选择英文或中文';$('alignment').textContent=s?(s.language==='zh'?'中文 → 原段落/图表范围':'英文 → 原 PDF 字符范围')+' · '+s.pdfPositions.length+' 页':'';const bar=$('selectionTools');bar.hidden=!s;if(s){const r=selectionRect();if(r){bar.classList.add('open');bar.style.left=Math.max(8,Math.min(r.left,innerWidth-300))+'px';bar.style.top=Math.max(65,Math.min(r.bottom+8,innerHeight-50))+'px';}}},mode(on){$('reading').textContent=on?'切到原 PDF':'切到中英阅读';$('pdf').hidden=!on;$('highlight').textContent=on?'划线':'划句笔记';},notes:renderNotes,context:p=>run(()=>inspect(p)),save,
    progress:position=>run(()=>progress(position)),back:available=>{$('back').hidden=!available;},
    async ready(p){pilot=p;window.reflowPilot=p;await restoreNotes();renderNotes();const queued=outbox.entries().filter(([,op])=>op.op==='progress').at(-1)?.[1];await p.restoreProgress(queued||state.reader.progress||{});ready=true;window.reflowReady=true;PR.emit('loaded');if(!outbox.pending)saveStatus('saved');status('中英阅读就绪 · '+p.mappings.length+' 个双语单元');if(state.capabilities.preview){$('qualityNotice').hidden=false;$('qualityNotice').textContent='候选预览尚未验收；原 PDF 和原有阅读数据保留。';}if(outbox.pending)run(flush);}}
  async function restoreNotes(){
    const values=[],native=[],colors={yellow:'#ffd400',blue:'#a28ae5',green:'#5fb236',pink:'#e56eee'};
    for(const [key,n] of Object.entries(canonical)){
      if(n.reflow?.source_sha256===state.source_sha256&&n.reflow.selection.quote===n.quote){values.push({...structuredClone(n.reflow.selection),_canonicalId:key,color:colors[n.color]||colors.yellow});native.push(...structuredClone(n.reflow.native||[]).map(a=>({...a,color:colors[n.color]||colors.yellow,comment:n.body||'',dateModified:n.updated})));continue;}
      const m=pilot.mappings.find(x=>x.anchor===n.anchor),language=n.language||'zh';if(!m||!n.quote)continue;
      const text=language==='zh'?m.zhText:m.enEls.map(el=>el.textContent).join(''),hits=[];
      for(let i=text.indexOf(n.quote);i>=0;i=text.indexOf(n.quote,i+1))if((!n.prefix||text.slice(0,i).endsWith(n.prefix))&&(!n.suffix||text.slice(i+n.quote.length).startsWith(n.suffix)))hits.push(i);
      if(hits.length!==1)continue;const at=hits[0];let selection={language,anchor:m.anchor,anchors:[m.anchor],quote:n.quote,start:at,end:at+n.quote.length,pdfPositions:m.pdfPositions,alignment:'source-unit'};
      if(language==='en'){
        const doc=m.en.ownerDocument,range=doc.createRange(),nodes=[];for(const el of m.enEls){const walker=doc.createTreeWalker(el,4);while(walker.nextNode())nodes.push(walker.currentNode);}let offset=0,started=false,ended=false;
        for(const node of nodes){const end=offset+node.length;if(!started&&at<end){range.setStart(node,at-offset);started=true;}if(started&&at+n.quote.length<=end){range.setEnd(node,at+n.quote.length-offset);ended=true;break;}offset=end;}
        if(!ended)continue;const domSelection=doc.defaultView.getSelection();domSelection.removeAllRanges();domSelection.addRange(range);const captured=pilot.captureSelection();domSelection.removeAllRanges();if(!captured||captured.quote!==n.quote)continue;selection=structuredClone(captured);
      }
      const nid='L'+String(values.length).padStart(7,'0'),positions=selection.pdfPositions;
      const ids=positions.map((position,i)=>{const aid=i?nid.slice(0,6)+String(i).padStart(2,'0'):nid;native.push({id:aid,type:'highlight',color:colors[n.color]||colors.blue,position,sortIndex:pilot.reader._sdt.mapper.getSortIndex(position),pageLabel:String(position.pageIndex+1),text:n.quote,comment:n.body||'',readOnly:true,dateCreated:n.created,dateModified:n.updated});return aid;});
      values.push({id:nid,nativeIds:ids,_canonicalId:key,...selection,color:colors[n.color]||colors.blue});
    }
    pilot.restoreExisting(values,native);
  }

  async function preferences(){PR.token=state.token;const prefs=await PR.loadPrefs();PR.prefs=Object.assign(PR.ls.get('easyread-prefs',{}),prefs.reader||{});PR.applyTheme(PR.prefs.theme||'auto');PR.applyReaderTheme();$('theme').textContent='配色 · '+PR.READER_THEMES.find(t=>t.id===PR.readerThemeValue()).label;}
  (async()=>{
    state=await json('/reflow/state');window.reflowState=state;
    PR.state.paper=state.paper;PR.state.discussion=(await json('/part/discussion')).data||{entries:[]};
    PR.state.layout=(await json('/part/layout')).data||{};
    PR.state.engine=(await PR.api('/api/config')).config.engine;
    state.paper.blocks.forEach((b,i)=>{PR.blockById[b.id]=b;PR.order[b.id]=i;});
    if(state.capabilities.default_ready)document.title='EasyRead · PDF 双语阅读';
    await preferences();serverReader=state.reader;
    outbox=new ReflowOutbox({storage:localStorage,key:'easyread-reflow-'+id+'-'+state.source_sha256,request:json,changed:saveStatus});window.reflowOutbox=outbox;rebuildReader();
    $('title').textContent=state.paper.meta.title_en||'PDF 阅读';$('workspace').hidden=false;$('readerFrame').src='/web/renderer/'+state.renderer_revision+'/vendor/zotero/reader.html';
    setInterval(()=>{if(!ready||document.hidden)return;if(outbox.pending)return outbox.conflict?undefined:run(flush);run(PR.poll);},3000);
    document.addEventListener('keydown',e=>{if(e.target.closest('input,textarea,select,[contenteditable]'))return;if(e.key==='Escape')PR.openSide(null);else if(PR.keyAction(e.key.toLowerCase())==='notes')PR.toggleNotesPanel();else if(PR.keyAction(e.key.toLowerCase())==='chat')PR.toggleChat();});
  })().catch(e=>{$('workspace').hidden=true;$('fallback').hidden=false;$('fallback').textContent=e.message+' ';const a=document.createElement('a');a.href=$('legacy').href;a.textContent='打开原阅读模式';$('fallback').append(a);status('阅读器尚不可用');});
})();
