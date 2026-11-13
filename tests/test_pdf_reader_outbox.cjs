const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../easyread/web/js/pdf-reader/outbox.js');
class Storage {constructor(){this.m=new Map();}get length(){return this.m.size;}key(i){return [...this.m.keys()][i];}getItem(k){return this.m.get(k)||null;}setItem(k,v){this.m.set(k,v);}removeItem(k){this.m.delete(k);}}
const note=(id,body,at='2026-01-01T00:00:00Z')=>({op:'note',at,note:{id,body,updated:at}});
test('failed write survives a new reader and sends exactly the same operation',async()=>{
  const storage=new Storage(),op=note('n','body');let received;
  const first=new ReflowOutbox({storage,key:'paper',request:async()=>{throw Error('offline');}});
  first.enqueue(op);await assert.rejects(first.flush(),/offline/);
  const next=new ReflowOutbox({storage,key:'paper',request:async(_,b)=>{received=b.ops;return {applied:['note:n']};}});
  assert.equal(next.pending,1);await next.flush();assert.deepEqual(received,[op]);assert.equal(next.pending,0);
});
test('lost acknowledgment is idempotent and conflicting newer edits remain pending',async()=>{
  const storage=new Storage(),op=note('n','body');let current=op.note;
  const q=new ReflowOutbox({storage,key:'paper',request:async path=>path==='/ops'?{applied:[]}:{data:{notes:{n:current}}}});
  q.enqueue(op);await q.flush();assert.equal(q.pending,0);
  q.enqueue(op);current={...op.note,body:'newer edit',updated:'2026-02-01T00:00:00Z'};
  await assert.rejects(q.flush(),/版本冲突/);assert.equal(q.pending,1);
});
test('two tabs retain independent writes and writes during a flush are drained',async()=>{
  const storage=new Storage();let release;const gate=new Promise(r=>release=r);const sent=[];
  const q=new ReflowOutbox({storage,key:'paper',request:async(_,b)=>{sent.push(b.ops);if(sent.length===1)await gate;return {applied:b.ops.map(o=>'note:'+o.note.id)};}});
  const other=new ReflowOutbox({storage,key:'paper',request:q.request});q.enqueue(note('a','A'));const flight=q.flush();other.enqueue(note('b','B'));release();await flight;
  assert.equal(q.pending,0);assert.deepEqual(sent.map(b=>b.map(o=>o.note.id)),[['a'],['b']]);
});
test('source keys isolate pending operations',()=>{const storage=new Storage();new ReflowOutbox({storage,key:'old',request:()=>{}}).enqueue(note('a','A'));assert.equal(new ReflowOutbox({storage,key:'new',request:()=>{}}).pending,0);});
test('over 100 offline operations drain in bounded batches after reopening',async()=>{
 const storage=new Storage();const first=new ReflowOutbox({storage,key:'pdf',request:async()=>{throw Error('offline');}});
 for(let i=0;i<205;i++)first.enqueue(note(String(i),'saved'));
 await assert.rejects(first.flush(),/offline/);
 const sizes=[];const next=new ReflowOutbox({storage,key:'pdf',request:async(_,b)=>{sizes.push(b.ops.length);assert.ok(b.ops.length<=100);return {applied:b.ops.map(o=>'note:'+o.note.id)};}});
 await next.flush();assert.deepEqual(sizes,[100,100,5]);assert.equal(next.pending,0);
});
test('progress acknowledges authoritative position and older tab progress does not block notes',async()=>{
 const storage=new Storage(),newer={at:'2026-10-13T13:00:00Z',ratio:.8};
 const q=new ReflowOutbox({storage,key:'pdf',request:async path=>path==='/ops'?{applied:[],progress:newer}:{data:{progress:newer}}});
 q.enqueue({op:'progress',at:'2026-10-13T12:00:00Z',ratio:.2});
 const result=await q.flush();assert.equal(q.pending,0);assert.deepEqual(result.progress,newer);
 q.request=async()=>({applied:['note:n']});q.enqueue(note('n','still saves'));await q.flush();assert.equal(q.pending,0);
});
