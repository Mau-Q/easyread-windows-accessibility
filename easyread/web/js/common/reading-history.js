/* Read-only history across identified reading copies. Coordinates stay in their original copy. */
(() => {
  'use strict';
  const PR=window.PR, button=document.getElementById('readingHistory');if(!button)return;
  let dialog,data;
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const prose=text=>{const n=el('div',undefined,'history-prose');n.innerHTML=PR.mdBlocks(String(text||''),{cite:false,xref:false});return n;};
  const section=(parent,title,build)=>{const box=el('details');box.append(el('summary',title));const body=el('div',undefined,'history-section');let built=false;box.addEventListener('toggle',event=>{if(event.target===box&&box.open&&!built){built=true;build(body);}});box.append(body);parent.append(box);};
  function render(records,selected){
    const content=dialog.querySelector('.history-content');content.replaceChildren();
    for(const record of records){
      const reader=record.reader||{},notes=Object.values(reader.notes||{}).filter(n=>!n.deleted),threads=record.chat?.threads||[],discussion=record.discussion?.entries||[],blocks=(record.paper?.blocks||[]).filter(b=>b.zh);
      if(!notes.length&&!threads.length&&!discussion.length&&!reader.paper_note?.body&&!blocks.length&&!Object.keys(reader.progress||{}).length&&!Object.keys(reader.edits||{}).length)continue;
      const group=el('details',undefined,'history-copy');group.open=selected===record.id;
      group.append(el('summary',record.label+` · ${notes.length} 条批注 · ${threads.length} 个对话`));
      const body=el('div',undefined,'history-section');group.append(body);
      body.append(el('p',`${notes.length} 条批注 · ${threads.length} 个对话 · ${threads.reduce((n,t)=>n+(t.messages||[]).length,0)} 条消息`,'history-meta'));
      if(notes.length||reader.paper_note?.body)section(body,'批注与论文笔记',box=>{if(reader.paper_note?.body)box.append(prose(reader.paper_note.body));for(const note of notes){const card=el('article');card.append(el('blockquote',note.quote||''),prose(note.body||''),el('small',note.anchor||'论文笔记'));box.append(card);}});
      if(threads.length)section(body,'聊天记录',box=>{for(const t of threads)section(box,t.title||'对话',list=>{for(const message of t.messages||[]){const card=el('article');card.append(el('strong',message.role==='user'?'我':message.model||'AI'),prose(message.content));for(const image of message.images||[]){if(typeof image.url==='string'&&image.url.startsWith('/p/')){const img=el('img');img.src=image.url;img.alt=image.name||'聊天图片';img.loading='lazy';card.append(img);}}list.append(card);}});});
      if(discussion.length)section(body,'已保存的 AI 讨论',box=>{for(const entry of discussion)box.append(prose(entry.q||''),prose(entry.body||''));});
      if(blocks.length)section(body,`此副本的原文与译文 · ${blocks.length} 段`,box=>{for(const block of blocks){const card=el('article');card.append(el('p',block.source_text||block.en||''),prose(block.zh));box.append(card);}});
      if(Object.keys(reader.edits||{}).length)section(body,'阅读时的修改记录',box=>box.append(el('pre',JSON.stringify(reader.edits,null,2))));
      if(Object.keys(reader.progress||{}).length)section(body,'保存的阅读位置',box=>{const p=reader.progress;box.append(el('p',(p.block?'段落 '+p.block+' · ':'')+(Number.isFinite(p.ratio)?'读到 '+Math.round(p.ratio*100)+'%':'')));if(p.dual_pdf)box.append(el('pre',JSON.stringify(p.dual_pdf,null,2)));});
      content.append(group);
    }
    if(!content.children.length)content.append(el('p','暂时没有历史阅读记录。'));
  }
  PR.openReadingHistory=async selected=>{
    if(!dialog){
      dialog=el('dialog',undefined,'reading-history-dialog');dialog.setAttribute('aria-label','历史阅读记录');
      const head=el('div',undefined,'history-head');head.append(el('strong','历史阅读记录'));const download=el('button','导出记录');download.onclick=()=>{if(!data)return;const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=el('a');a.href=url;a.download='EasyRead-reading-history.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};const close=el('button','关闭');close.onclick=()=>dialog.close();head.append(download,close);dialog.append(head,el('p','各阅读副本按原身份保留。历史位置仅供查看，不会覆盖当前笔记或进度。','history-meta'),el('div',undefined,'history-content'));document.body.append(dialog);
      dialog.addEventListener('close',()=>button.focus({preventScroll:true}));
    }
    dialog.querySelector('.history-content').replaceChildren(el('p','正在读取…'));dialog.showModal();
    try{const pid=PR.routePid||location.pathname.split('/').pop();const response=await fetch('/api/reading-history/'+encodeURIComponent(pid));data=await response.json();if(!response.ok)throw Error(data.error||'读取失败');render(data.records,selected);}catch(e){dialog.querySelector('.history-content').replaceChildren(el('p',e.message));}
  };
  button.onclick=()=>PR.openReadingHistory();
})();
