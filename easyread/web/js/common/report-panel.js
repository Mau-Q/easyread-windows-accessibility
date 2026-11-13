/* Add a report panel and explicit note save to the existing reader surfaces. */
(()=>{'use strict';const PR=window.PR,A=window.EasyReadAccount;if(!PR?.account||!A)return;
const $=id=>document.getElementById(id),pid=()=>PR.routePid||location.pathname.split('/').filter(Boolean).at(-1),api=action=>'/api/reading/'+pid()+(action?'/'+action:'');
const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const note=()=> $('paperNote')?.value??PR.accountNoteDraft??PR.state?.reader?.paper_note?.body??'';
const dirty=()=>note()!==(PR.accountNoteBase??PR.state?.reader?.paper_note?.body??'');
let leaving=false;A.allowNavigation=()=>{leaving=true;};
let previousDirty=false;function publishDirty(){const value=dirty();if(value===previousDirty)return;previousDirty=value;A.api('/api/editor-state',{dirty:value}).catch(()=>{});}
document.addEventListener('input',e=>{if(e.target.id==='paperNote')publishDirty();});
A.mayLeave=async()=>!dirty()||PR.confirm({title:'笔记有未保存修改',body:'继续编辑保留当前文字；放弃后离开只丢弃未保存修改，此前成功保存的笔记不变。',ok:'放弃修改后离开',cancel:'继续编辑'});
document.addEventListener('click',async e=>{
 const save=e.target.closest('[data-account-note-save]');
 if(save){e.preventDefault();save.disabled=true;const text=note();PR.accountNoteDraft=text;
  try{const d=await A.api(api('paper-note'),{body:text,revision:PR.state.reader.note_revision??0});PR.accountNoteBase=text;PR.state.reader.paper_note={body:text};PR.state.reader.note_revision=d.revision;PR.accountNoteStatus=dirty()?'刚才内容已保存，当前还有新修改':'笔记已成功保存';}
  catch(error){PR.accountNoteStatus='尚未保存：'+error.message;}
  finally{publishDirty();save.disabled=false;if($('accountNoteStatus'))$('accountNoteStatus').textContent=PR.accountNoteStatus;}return;
 }
 const link=e.target.closest('a[href]');if(!link||link.target==='_blank'||!dirty())return;
 if(new URL(link.href,location.href).pathname===location.pathname)return;e.preventDefault();e.stopImmediatePropagation();if(await A.mayLeave()){await A.api('/api/editor-state',{dirty:false});leaving=true;location.href=link.href;}
},true);
window.addEventListener('beforeunload',e=>{if(dirty()&&!leaving){e.preventDefault();e.returnValue='';}});
if(location.pathname==='/')return;
const bar=$('readerBar');if(!bar)return;let state=null,open=false,flight;
const panel=node('section');panel.id='reportpanel';panel.className='side-panel';panel.setAttribute('aria-label','阅读报告');panel.inert=true;(document.querySelector('#workspace')||document.querySelector('.web-stage')||document.body).append(panel);
const button=node('button','阅读报告','btn');button.id='reportBtn';button.setAttribute('aria-controls','reportpanel');button.setAttribute('aria-expanded','false');bar.insertBefore(button,$('notesBtn'));
const originalSide=PR.openSide;
PR.openSide=function(side){const focused=panel.contains(document.activeElement);if(side!=='report'){open=false;panel.inert=true;button.setAttribute('aria-expanded','false');document.body.classList.remove('rp-open');}const result=originalSide?.(side);if(focused&&!side)requestAnimationFrame(()=>{PR.readerShell?.show(true);button.focus();});return result;};
function show(){originalSide?.(null);PR.side='report';open=true;panel.inert=false;button.setAttribute('aria-expanded','true');document.body.classList.add('side-open','rp-open');refresh().then(()=>{if(open)panel.querySelector('button')?.focus();});}
button.onclick=show;
async function refresh(){if(flight)return flight;flight=A.api(api()).then(d=>{state=d;if(open)render();}).catch(e=>{panel.replaceChildren(node('p',e.message,'account-error'));}).finally(()=>{flight=null;});return flight;}
function busy(b,fn){b.disabled=true;return fn().catch(e=>PR.toast(PR.esc(e.message))).finally(()=>{b.disabled=false;});}
function result(container,r,tid){let index=0;const labels={research_question:'研究问题',method:'方法',results:'主要结果',limitations:'局限'};
 for(const [key,claims] of Object.entries(r.sections||{})){container.append(node('h3',labels[key]||key));for(const c of claims){const card=node('article',undefined,'account-claim '+c.source);card.append(node('span',{paper:'论文依据',general:'通用知识补充',unavailable:'未找到论文依据'}[c.source],'account-source'),node('p',c.text));for(const ref of c.citations){const at=index++;card.append(node('blockquote',ref.quote));const row=node('div',undefined,'account-ref');row.append(node('span','PDF第'+ref.page+'页'));const jump=node('button','查看原文');jump.onclick=()=>busy(jump,async()=>{const d=await A.api(api('reference')+'?task='+tid+'&index='+at);if(window.Dual){await Dual.navigate('source',d.page-1,false);PR.openSide(null);requestAnimationFrame(()=>Dual.panes.source.document.querySelector('.page[data-page-number="'+d.page+'"] .textLayer')?.focus());}else location.href='/read/'+pid()+'?source=pdf#pdf-page='+d.page;});jump.disabled=!state.identity_ok;const copy=node('button','复制片段');copy.onclick=()=>busy(copy,()=>navigator.clipboard.writeText(ref.quote));row.append(jump,copy);card.append(row);}container.append(card);}}
 if(r.generation)container.append(node('p',r.generation.service+' · '+r.generation.model+' · 生成'+r.generation.seconds.toFixed(2)+'秒','account-notice'));
}
function render(){panel.replaceChildren();const head=node('div',undefined,'ch-head');head.append(node('strong','阅读报告'),node('span',undefined,'grow'));const close=node('button','×','btn icon');close.setAttribute('aria-label','关闭阅读报告');close.onclick=()=>PR.openSide(null);head.append(close);panel.append(head);
 const body=node('div',undefined,'account-result');body.id='courseReportBody';body.append(node('p','引用帮助查找出处，不代表结论已验证；请核对原文的条件、数值和措辞。','account-notice'));
 if(state.identity_warning)body.append(node('p',state.identity_warning,'account-error'));
 const active=state.tasks.some(t=>['queued','running'].includes(t.state));
 if(state.parse_state!=='ready'){body.append(node('p','生成报告前需要完成当前PDF的逐页文字解析。原文与笔记仍可使用。','hint'));const parse=node('button','本地解析 / 重试解析','btn');parse.disabled=active;parse.onclick=()=>busy(parse,async()=>{await A.api(api('parse'),{});await refresh();});body.append(parse);}
 const generate=node('button',state.report?'重新生成报告':'生成阅读报告','btn accent');generate.id='generateReport';generate.disabled=active||state.parse_state!=='ready'||!state.identity_ok;generate.onclick=()=>busy(generate,()=>start());body.append(generate);
 if(state.report){body.append(node('p','最近成功报告 · '+new Date(state.report.saved*1000).toLocaleString(),'account-notice'));result(body,state.report.result,state.report.id);}else body.append(node('p','尚无成功保存的报告。','hint'));
 for(const t of state.tasks.filter(t=>t.kind==='report'&&t.state!=='completed')){const box=node('section',undefined,'account-task');box.append(node('p',({queued:'等待处理',running:'处理中',failed:'生成失败',interrupted:'已中断',save_failed:'完整生成但尚未保存'})[t.state]||t.state,'account-notice'));if(t.error)box.append(node('p',t.error,'account-error'));if(t.result)result(box,t.result,t.id);if(t.state==='save_failed'){const b=node('button','再次保存（不调用AI）','btn accent');b.onclick=()=>busy(b,async()=>{await A.api(api('save'),{task:t.id});await refresh();});box.append(b);}else if(['failed','interrupted'].includes(t.state)){const b=node('button','重新生成（可能再次收费）','btn');b.onclick=()=>busy(b,()=>start(t));box.append(b);}body.append(box);}
 panel.append(body);
}
async function start(retry){const body={};if(retry){if(!await PR.confirm({title:'确认重新生成？',body:'这会再次调用服务，可能再次收费；旧成功报告保留。',ok:'重新生成'}))return;body.retry_of=retry.id;body.confirm_retry=true;}if(state.report){if(!await PR.confirm({title:'重新生成报告？',body:'新报告完整生成并成功保存后才替换旧报告；失败或中断时旧报告保留。',ok:'确认重新生成'}))return;body.expected_report=state.report.id;}await A.api(api('report'),body);await refresh();}
setInterval(()=>{if(state?.tasks.some(t=>['queued','running'].includes(t.state)))refresh();},1500);
if(location.hash==='#report')show();
if(location.hash.startsWith('#pdf-page=')){const n=Number(location.hash.split('=')[1]);const timer=setInterval(()=>{if(window.dualReady){clearInterval(timer);Dual.navigate('source',n-1,false).catch(e=>PR.toast(PR.esc(e.message)));}},100);}
})();
