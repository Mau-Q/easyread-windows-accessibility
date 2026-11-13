const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function harness(path){
 let now=0,id=0,calls=0;const timers=new Map(),listeners={},elements={};
 const el=()=>({classList:{add(){},toggle(){}},append(){},replaceChildren(){},addEventListener(){},showModal(){},close(){},value:'local'});
 const document={hidden:false,body:el(),getElementById:k=>elements[k]||=(el()),addEventListener:(k,f)=>listeners[k]=f,createElement:el};
 const storage=new Map();const window={dualReady:true,addEventListener:(k,f)=>listeners['window:'+k]=f};
 const PR={readerApi:'/api/pdf-reader/p',routePid:'p',token:'t',flush:async()=>{},chatFetch:async()=>{calls++;return {ok:true,json:async()=>({task:{state:'idle'},models:[{id:'local',model:'fixture'}]})};}};
 const ctx={window,document,PR,Dual:{assets:{}},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},setTimeout:(f,ms)=>{timers.set(++id,{f,time:now+ms});return id},clearTimeout:i=>timers.delete(i),Promise,Error,JSON};
 vm.runInNewContext(fs.readFileSync(path,'utf8'),ctx);
 const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
 async function advance(ms){await settle();const end=now+ms;let next;while((next=[...timers].sort((a,b)=>a[1].time-b[1].time)[0])&&next[1].time<=end){now=next[1].time;timers.delete(next[0]);next[1].f();await settle();}now=end;}
 return {advance,settle,document,listeners,get calls(){return calls},PR,elements,ctx};
}
test('idle polling backs off, hidden pages stop and return immediately checks status',async()=>{
 const h=harness('easyread/web/js/pdf-reader/translation.js');await h.advance(60000);assert.equal(h.calls,3);
 h.document.hidden=true;h.listeners.visibilitychange();await h.advance(60000);assert.equal(h.calls,3);
 h.document.hidden=false;h.listeners.visibilitychange();await h.settle();assert.equal(h.calls,4);
});
test('busy polling remains responsive and concurrent focus does not overlap requests',async()=>{
 const h=harness('easyread/web/js/pdf-reader/translation.js');await h.settle();let release,active=0,max=0;
 h.PR.chatFetch=async()=>{active++;max=Math.max(max,active);await new Promise(r=>release=r);active--;return {ok:true,json:async()=>({task:{id:'run',state:'running'},models:[]})};};
 h.listeners['window:focus']();h.listeners['window:focus']();await h.settle();assert.equal(max,1);release();await h.settle();
 // A queued refresh follows the first; release it too, then status keeps 1.5s cadence.
 await h.advance(0);release();await h.settle();assert.equal(max,1);
});
function readerHarness(base='easyread'){
 const elements={},storage=new Map(),calls=[],events=[];let highlights=0,panelRenders=0;
 const el=()=>({dataset:{},classList:{add(){},toggle(){}},append(){},addEventListener(){},querySelector(){return null}});
 const document={getElementById:k=>elements[k]||=(el()),body:el(),addEventListener(){},createElement:el};
 const asset={id:'source-v1',version:1,sha256:'abc',page_count:4,page_boxes:[]};
 let reader={notes:{existing:{id:'existing',body:'retained'}},progress:{}};
 const PR={nowIso:()=>new Date().toISOString(),readerApi:'/api/pdf-reader/p',state:{paper:{blocks:[]},reader,discussion:{}},blockById:{},order:{},on(){},emit:(...a)=>events.push(a),initPDFTheme(){},noteSurface:{render(){panelRenders++}}};
 const ctx={document,PR,console,crypto:require('node:crypto'),structuredClone,Date,Promise,JSON,Error,location:{},setTimeout,clearTimeout,PDFPageSync:class{request(){return Promise.resolve()}},addEventListener(){},localStorage:{get length(){return storage.size},key:i=>[...storage.keys()][i],getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},fetch:async(url,opts)=>{
  calls.push(url);let data;
  if(url.endsWith('/state'))data={id:'p',reader:structuredClone(reader),assets:{source:asset},paper:{blocks:[]},translation_options:[],appearance:{}};
  else if(url.endsWith('/ops')){const {ops}=JSON.parse(opts.body);for(const op of ops){if(op.op==='progress')reader.progress={at:op.at,block:op.block,ratio:op.ratio,dual_pdf:op.dual_pdf};else if(op.op==='paper_note')reader.paper_note={body:op.body};}data={applied:ops.map(o=>o.op),progress:reader.progress};}
  else data={data:structuredClone(reader)};
  return {ok:true,status:200,json:async()=>data};
 }};ctx.window=ctx;
 vm.runInNewContext(fs.readFileSync(base+'/web/js/pdf-reader/outbox.js','utf8'),ctx);
 vm.runInNewContext(fs.readFileSync(base+'/web/js/pdf-reader/app.js','utf8'),ctx);
 const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
 return {ctx,PR,calls,events,settle,get highlights(){return highlights},get panelRenders(){return panelRenders},install(){ctx.Dual.restoreHighlights=()=>highlights++;},get reader(){return reader}};
}
test('progress saves durably without reading notes or repainting highlights; note edits still refresh',async()=>{
 const h=readerHarness();await h.settle();h.install();h.calls.length=0;
 for(let i=0;i<5;i++)await h.PR.commit({op:'progress',at:`2026-10-13T13:00:0${i}Z`,block:'source-p2',ratio:.5,dual_pdf:{}});
 assert.equal(h.calls.filter(u=>u.endsWith('/ops')).length,5);assert.equal(h.calls.filter(u=>u.endsWith('/part/reader')).length,0);
 assert.equal(h.highlights,0);assert.equal(h.panelRenders,0);assert.equal(h.reader.notes.existing.body,'retained');assert.equal(h.PR.state.reader.progress.ratio,.5);assert.equal(h.ctx.dualOutbox.pending,0);
 await h.PR.commit({op:'paper_note',body:'new paper note'});
 assert.equal(h.calls.filter(u=>u.endsWith('/part/reader')).length,1);assert.equal(h.panelRenders,1);assert.ok(h.highlights>0);
});
function libraryHarness(){
 const timers=new Map(),listeners={},elements={};let id=0,listRenders=0,reply={items:[],jobs:[],engine:'fixture',engine_label:'Fixture'};
 const element=k=>elements[k]||=( {classList:{toggle(){}},addEventListener(){},querySelector(){return null},set innerHTML(v){if(k==='#list')listRenders++},set outerHTML(v){}} );
 const document={hidden:false,addEventListener:(k,f)=>listeners[k]=f};
 const PR={ls:{get:(k,v)=>v,set(){}},applyTheme(){},logo:()=>'',icon:()=>'',esc:String,$:element,$$:()=>[],renderSide(){},debounce:f=>f,api:async()=>reply};
 const ctx={PR,window:{PR,addEventListener:(k,f)=>listeners['window:'+k]=f},document,JSON,String,Promise,setTimeout:(f,ms)=>{timers.set(++id,{f,ms});return id},clearTimeout:k=>timers.delete(k)};
 vm.runInNewContext(fs.readFileSync('easyread/web/js/library/app.js','utf8'),ctx);PR.lib.VIEWS=[['all','全部','',()=>true]];PR.lib.engineReady=true;
 return {PR,document,listeners,timers,get listRenders(){return listRenders},set reply(v){reply=v}};
}
test('library first empty state renders, unchanged refresh retains DOM and idle/active cadences differ',async()=>{
 const h=libraryHarness();await h.PR.lib.load();assert.equal(h.listRenders,1);assert.equal([...h.timers.values()][0].ms,60000);
 await h.PR.lib.load();assert.equal(h.listRenders,1);
 h.reply={items:[],jobs:[{state:'running'}]};await h.PR.lib.load();assert.equal([...h.timers.values()][0].ms,2500);
 h.document.hidden=true;h.listeners.visibilitychange();assert.equal(h.timers.size,0);
});
