const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('rejected stale token is refreshed once without changing the chat request',async()=>{
 const calls=[];const replies=[new Response(JSON.stringify({error:'bad token'}),{status:403}),new Response(JSON.stringify({token:'new'})),new Response(JSON.stringify({threads:[]}))];
 const PR={token:'old',ls:{get:(k,v)=>v,set(){},del(){}},$(){},toast(){}};
 vm.runInNewContext(fs.readFileSync('easyread/web/js/pdf-reader/bridge.js','utf8'),{window:{PR},location:{pathname:'/read/paper'},fetch:async(url,opts)=>{calls.push({url,opts});return replies.shift();},JSON});
 const data=await PR.api('/api/pdf-reader/paper/chat/rename',{method:'POST',body:{thread:'t1',title:'Title'}});
 assert.deepEqual(data,{threads:[]});assert.equal(calls.length,3);assert.equal(calls[0].opts.headers['X-Token'],'old');assert.equal(calls[2].opts.headers['X-Token'],'new');assert.equal(calls[0].opts.body,calls[2].opts.body);
});
