// All chat provider/history responses are controlled fixtures, never real AI.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
 const b=await chromium.connectOverCDP(process.env.EASYREAD_CDP),page=b.contexts()[0].pages()[0];
 const out=process.env.EASYREAD_EVIDENCE||'test-results/windows-chat';fs.mkdirSync(out,{recursive:true});
 const results=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 const tick=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const ok=feature=>{console.log(feature);results.push({feature,scope:'native UI; controlled chat fixture; no provider calls',status:'TOOL_OBSERVED'});};
 try{
  const origin=new URL(page.url()).origin;await page.goto(origin+'/');await page.locator('#q').fill('双栏无障碍');await page.waitForFunction(()=>document.querySelector('#count').textContent==='1 篇');await page.locator('#list').focus();await page.keyboard.press('Home');await page.keyboard.press('Enter');await page.waitForFunction(()=>window.dualReady===true);
  const id=await page.evaluate(()=>PR.routePid),base=origin+'/api/pdf-reader/'+id+'/chat';
  let threads=[{id:'fixture-old',title:'Synthetic previous conversation',model:'fixture-model',updated:new Date().toISOString(),messages:[{id:'u-old',role:'user',content:'Synthetic previous question'},{id:'a-old',role:'assistant',content:'Synthetic previous answer',model:'Fixture'}]}],calls=0,mode='failure',release;
  const models=[{id:'fixture-model',label:'Fixture / no AI',ready:true}];
  await page.route(base,async route=>{
   if(route.request().method()==='GET')return route.fulfill({json:{threads,models,default:'fixture-model'}});
   calls++;const body=route.request().postDataJSON();assert.ok(body.refs.length>0,'Current PDF reference must accompany the question');
   if(mode==='failure')return route.fulfill({status:503,json:{error:'Synthetic chat interruption'}});
   if(mode==='pause'){await new Promise(r=>release=r);try{await route.fulfill({status:200,body:''});}catch{}return;}
   const answer={id:'fixture-answer',role:'assistant',content:'Synthetic controlled answer',model:'Fixture'};
   threads=[{id:'fixture-new',title:body.text,model:'fixture-model',updated:new Date().toISOString(),messages:[{id:'fixture-user',role:'user',content:body.text,refs:body.refs},answer]},...threads.filter(t=>t.id!=='fixture-new')];
   const events=[{thread:'fixture-new',model:'Fixture'},{t:answer.content},...(mode==='save_failure'?[{error:'Synthetic answer save failure',save_task:'fixture-save'}]:[{done:true,id:answer.id}])];
   return route.fulfill({status:200,contentType:'application/x-ndjson',body:events.map(e=>JSON.stringify(e)).join('\n')+'\n'});
  });
  await page.route(base+'/rename',route=>{const body=route.request().postDataJSON();threads.find(t=>t.id===body.thread).title=body.title;return route.fulfill({json:{ok:true}});});
  await page.route(base+'/delete',route=>{const body=route.request().postDataJSON();threads=threads.filter(t=>t.id!==body.thread);return route.fulfill({json:{ok:true}});});
  await page.route(base+'/save',route=>route.fulfill({json:{ok:true}}));
  await page.locator('#readingControls').press('Enter');await tick();await page.locator('#chatBtn').press('Enter');
  await page.getByRole('textbox',{name:'问题',exact:true}).waitFor();await page.locator('#chatInput').fill('Synthetic failure question');await page.locator('#chatInput').press('Enter');
  await page.getByText('没能回答：Synthetic chat interruption',{exact:true}).waitFor();assert.equal(await page.locator('#chatInput').inputValue(),'Synthetic failure question');ok('Chat error preserves question and referenced context');
  mode='save_failure';await page.locator('#chatInput').press('Enter');await page.locator('[data-c=save-answer]').waitFor();const beforeSave=calls;await page.locator('[data-c=save-answer]').press('Enter');await page.locator('[data-c=save-answer]').waitFor({state:'detached'});assert.equal(calls,beforeSave);ok('Answer save-only retry does not regenerate');
  await page.locator('#chatpanel [data-c=list]').press('Enter');await page.locator('.ch-thread[data-t="fixture-new"] .ch-thread-open').focus();
  await page.locator('.ch-thread[data-t="fixture-new"] [data-c=rename]').press('Enter');await page.getByRole('textbox',{name:'对话改名',exact:true}).fill('Renamed fixture conversation');await page.getByRole('textbox',{name:'对话改名',exact:true}).press('Enter');await tick();
  await page.locator('.ch-thread[data-t="fixture-new"] .ch-thread-open').press('Enter');await tick();assert.ok((await page.locator('.ch-title').innerText()).includes('Renamed fixture conversation'));ok('Native conversation button selects a renamed conversation');
  await page.locator('#chatpanel [data-c=list]').press('Enter');await page.locator('.ch-thread[data-t="fixture-old"] .ch-thread-open').focus();await page.locator('.ch-thread[data-t="fixture-old"] [data-c=del]').press('Enter');await page.locator('.popover.confirm.open [data-cf=no]').press('Enter');assert.ok(threads.some(t=>t.id==='fixture-old'));
  await page.locator('.ch-thread[data-t="fixture-old"] .ch-thread-open').focus();await page.locator('.ch-thread[data-t="fixture-old"] [data-c=del]').press('Enter');await page.locator('.popover.confirm.open [data-cf=ok]').press('Enter');await page.locator('.ch-thread[data-t="fixture-old"]').waitFor({state:'detached'});ok('Conversation deletion can be cancelled or confirmed');
  await page.locator('#chatpanel [data-c=new]').first().press('Enter');mode='pause';await page.locator('#chatInput').fill('Synthetic cancelled question');await page.locator('#chatInput').press('Enter');await page.locator('[data-c=stop]').waitFor();await page.locator('[data-c=stop]').press('Enter');release?.();await page.waitForFunction(()=>document.querySelector('#chatInput')?.value==='Synthetic cancelled question');ok('Stop preserves the interrupted question');
  await page.locator('#chatInput').press('Escape');await tick();assert.equal(await page.evaluate(()=>PR.side),null);ok('Escape closes chat and preserves toolbar access');
  assert.deepEqual(errors,[]);
 }finally{await page.unrouteAll({behavior:'ignoreErrors'});fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,errors},null,2));await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
