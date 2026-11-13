/* Adapt PDF locations/storage to the actual shared web-reader panels. */
(() => {
  const PR=window.PR;
  PR.state={paper:null,reader:{},discussion:{entries:[]},job:{},item:{},layout:{},versions:{}};
  PR.pid=decodeURIComponent(location.pathname.split('/')[2]);PR.paperKey=PR.pid;
  PR.blockById={};PR.order={};PR.side=null;
  PR.store={mode:'server',get pending(){return window.reflowOutbox?.pending||0;}};
  PR.blockKeys=b=>[b.id];
  PR.textFor=id=>{const b=PR.blockById[id];return b?.zh||b?.caption_zh||b?.en||b?.caption_en||b?.tex||'';};
  PR.currentBlock=PR.readingBlock=()=>window.reflowPilot?.progress().block||null;
  PR.openSide=side=>{
    PR.flushNotesPanelEdits?.();
    PR.hideSelectionTranslation?.();
    const p=window.reflowPilot,m=p?.reading?p.mappings.find(m=>m.anchor===PR.readingBlock()):null,top=m?.en.getBoundingClientRect().top;
    PR.side=side;
    for(const [cls,on] of [['side-open',!!side],['np-open',side==='notes'],['ch-open',side==='chat']])document.body.classList.toggle(cls,on);
    PR.$('#notespanel').inert=side!=='notes';PR.$('#chatpanel').inert=side!=='chat';
    PR.$('#notesBtn').setAttribute('aria-expanded',String(side==='notes'));PR.$('#chatBtn').setAttribute('aria-expanded',String(side==='chat'));
    PR.$('#selectionTools').hidden=true;
    requestAnimationFrame(()=>{if(m?.en.isConnected&&top!=null)m.en.ownerDocument.defaultView?.scrollBy(0,m.en.getBoundingClientRect().top-top);});
  };
  PR.jumpTo=(id,opts={})=>{
    const p=window.reflowPilot,anchor=id.replace(/^b-/,'');
    const note=p?.notes.find(n=>n._canonicalId===opts.note);
    if(note)return p.gotoNote(note.id);
    if(p?.mappings.some(m=>m.anchor===anchor))return p.jump(anchor,true);
    const b=PR.blockById[anchor],layout=PR.state.layout[anchor];
    if(b?.page)return p.gotoSource(layout?.page||b.page,layout?.box||b.box);
    PR.toast('这条批注没有已确认的位置，请查看原 PDF');
  };
  PR.quoteLost=id=>!!PR.state.reader.notes?.[id]?.quote&&!window.reflowPilot?.notes.some(n=>n._canonicalId===id);
  PR.noteSurface={
    render(){if(PR.notesPanelOpen?.())PR.renderNotesPanel();},
    openEditor(id){PR.openSide('notes');PR.renderNotesPanel(id);},
    link(card,on){const p=window.reflowPilot;for(const m of p?.mappings||[])if(m.anchor===card.dataset.anchor){m.en.classList.toggle('linked',on);m.zh.classList.toggle('linked',on);}}
  };
})();
