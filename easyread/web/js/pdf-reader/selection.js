(() => {
  'use strict';
  const bar=document.getElementById('selectionTools');
  let rect,editingId;
  const palette={yellow:'#ecc45c',green:'#7eb576',blue:'#6ea0d6',pink:'#e25c5c'};
  PR.pdfMarkColor=note=>note.style==='underline'?(getComputedStyle(document.documentElement).getPropertyValue('--reading-ul-'+(note.color||'yellow')).trim()||palette[note.color]||palette.yellow):(palette[note.color]||palette.yellow);
  function show(){
    const note=editingId&&PR.state.reader.notes[editingId],pen=note?(note.style||'marker'):(PR.prefs.pen||'marker');
    bar.innerHTML='<span class="pens">'+[['marker','荧光笔'],['underline','下划线']].map(([p,label])=>'<button data-pen="'+p+'" class="'+(p===pen?'on':'')+'" title="'+label+'" aria-label="'+label+'" aria-pressed="'+(p===pen)+'">'+PR.icon(p,'sm')+'</button>').join('')+'</span><span class="dots pen-'+pen+'">'+PR.HL_COLORS.map(([c,label])=>'<button data-s="highlight" data-color="'+c+'" class="dot-'+c+(note?.color===c?' on':'')+'" title="'+label+'色划线" aria-label="'+label+'色划线"></button>').join('')+'</span><button data-s="note">'+PR.icon('note','sm')+(note?'写笔记':'笔记')+'</button><button data-s="question">'+PR.icon('question','sm')+'提问</button><button data-s="chat">'+PR.icon('sparkle','sm')+'问 AI</button><button data-s="copy" title="复制" aria-label="复制">'+PR.icon('copy','sm')+'</button>'+(note?'<button data-s="delete">删除划线</button>':'');
    bar.hidden=false;
    const width=bar.offsetWidth,height=bar.offsetHeight,box=rect||{left:20,top:150,bottom:170,width:0};
    bar.style.left=Math.max(8,Math.min(box.left+(box.width||0)/2-width/2,innerWidth-width-8))+'px';
    bar.style.top=Math.max(8,Math.min(box.top-height-10>8?box.top-height-10:box.bottom+10,innerHeight-height-8))+'px';
  }
  PR.showPDFSelection=box=>{rect=box;editingId=null;show();};
  PR.showPDFMark=(id,box)=>{rect=box;editingId=id;show();};
  const clear=()=>{for(const pane of Object.values(Dual.panes))pane.document.getSelection()?.removeAllRanges();Dual.clearSelection();};
  async function action(kind,color){
    const note=editingId&&PR.state.reader.notes[editingId],selection=note?{anchor:note.anchor,quote:note.quote,pdf:note.pdf}:Dual.selection;
    if(!selection)return;const ref=structuredClone(selection);clear();
    if(kind!=='chat'&&kind!=='copy')PR.selectionPreview?.clear();
    if(kind==='copy'){await navigator.clipboard.writeText(ref.quote);return PR.toast('已复制');}
    if(kind==='chat')return PR.chatAsk(ref);
    if(kind==='delete'){await PR.commit({op:'note_del',id:note.id});return PR.toast('已删除划线',{label:'撤销',fn:()=>PR.commit({op:'note',note:{...note,deleted:false,updated:PR.nowIso()}})});}
    if(note){const changed={...note,updated:PR.nowIso()};if(kind==='highlight')changed.color=color;else changed.kind=kind;await PR.commit({op:'note',note:changed});if(kind!=='highlight')PR.noteSurface.openEditor(note.id);}
    else await Dual.annotate(ref,kind,color);
  }
  bar.addEventListener('mousedown',e=>e.preventDefault());
  bar.addEventListener('click',async e=>{
    try{
      const pen=e.target.closest('[data-pen]');
      if(pen){PR.prefs.pen=pen.dataset.pen;PR.savePrefs('reader',{pen:PR.prefs.pen});if(editingId){const note=PR.state.reader.notes[editingId];await PR.commit({op:'note',note:{...note,style:PR.prefs.pen,updated:PR.nowIso()}});}show();return;}
      const button=e.target.closest('[data-s]');if(button)await action(button.dataset.s,button.dataset.color);
    }catch(error){Dual.fail(error);}
  });
  PR.pdfSelectionKeydown=e=>{
    if(bar.hidden||e.ctrlKey||e.metaKey||e.altKey||e.target.closest('input,textarea,[contenteditable]'))return;
    const key=e.key.toLowerCase(),color=PR.HL_COLORS[Number(key)-1]?.[0],kind=color?'highlight':key==='n'?'note':key==='q'?'question':null;
    if(kind){e.preventDefault();action(kind,color).catch(Dual.fail);}
  };
  document.addEventListener('keydown',PR.pdfSelectionKeydown);
})();
