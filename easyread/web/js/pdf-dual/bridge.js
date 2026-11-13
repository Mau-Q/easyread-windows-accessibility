(() => {
  const PR=window.PR;
  const originalApi=PR.api;
  PR.api=(path,opts)=>{if(path.startsWith('/api/p/'+PR.pid+'/'))return originalApi('/experiments/pdf-dual/'+PR.pid+'/'+path.slice(('/api/p/'+PR.pid+'/').length),opts);if(path==='/api/prefs'&&!opts?.method)return Promise.resolve({});return Promise.reject(Error('实验页面禁止模型、设置和正式文献操作'));};
  const local=PR.ls;PR.ls={get:(key,fallback)=>local.get('pdf-dual:'+key,fallback),set:(key,value)=>local.set('pdf-dual:'+key,value),del:key=>local.del('pdf-dual:'+key)};
  PR.savePrefs=()=>{};PR.loadPrefs=async()=>{};
  PR.pid=PR.paperKey=location.pathname.split('/').filter(Boolean).at(-1);PR.previewOnly=true;PR.side=null;PR.state={paper:{blocks:[],meta:{}},reader:{notes:{}},discussion:{entries:[]},job:{},item:{},versions:{}};
  PR.blockById={};PR.order={};PR.store={mode:'server',get pending(){return window.dualOutbox?.pending||0;}};
  PR.blockKeys=b=>[b.id];PR.textFor=id=>{const b=PR.blockById[id];return b?.zh||b?.en||'';};
  PR.currentBlock=PR.readingBlock=()=>window.Dual?.currentAnchor()||'source-p1';
  PR.sectionLabel=PR.sectionOf=id=>{const b=PR.blockById[id];return b?`${b.pdf_side==='source'?'原文':'译文'} · 第 ${b.page} 页 · v${window.Dual?.assets[b.pdf_side]?.version||1}`:'PDF 位置';};
  PR.openSide=side=>{PR.flushNotesPanelEdits?.();PR.side=side;for(const [cls,on] of [['side-open',!!side],['np-open',side==='notes'],['ch-open',side==='chat']])document.body.classList.toggle(cls,on);for(const name of ['notes','chat'])PR.$('#'+(name==='notes'?'notespanel':'chatpanel')).inert=side!==name;PR.$('#selectionTools').hidden=true;};
  PR.jumpTo=(anchor,opts={})=>window.Dual?.goto(anchor.replace(/^b-/,''),opts.note).catch(window.Dual.fail);
  PR.quoteLost=id=>{const n=PR.state.reader.notes[id];return !!n?.pdf&&!window.Dual?.matches(n.pdf);};
  PR.noteSurface={render(){if(PR.notesPanelOpen?.())PR.renderNotesPanel();},openEditor(id){PR.openSide('notes');PR.renderNotesPanel(id);},link(){}};
  PR.applyMarks=()=>window.Dual?.restoreHighlights();PR.referenceFor=(anchor,quote)=>window.Dual?.referenceFor(anchor,quote);
  PR.pdfReferenceLabel=ref=>ref.pdf?`${ref.pdf.side==='source'?'原文':'译文'} · 第 ${ref.pdf.pageIndex+1} 页 · v${ref.pdf.version}`:'';
})();
