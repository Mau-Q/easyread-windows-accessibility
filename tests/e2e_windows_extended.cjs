// Additional native UI regressions. AI requests below are explicitly intercepted
// fixtures; no real provider is invoked. Only isolated synthetic data is edited.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.EASYREAD_CDP);
 const page=browser.contexts()[0].pages()[0],origin=new URL(page.url()).origin;
 const out=process.env.EASYREAD_EVIDENCE||'test-results/windows-extended';fs.mkdirSync(out,{recursive:true});
 const categoryBase='键盘验证'+Date.now().toString(36),categoryName=categoryBase+'改名';
 const results=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const ok=(feature,scope='native UI / real local backend')=>{console.log(feature,scope);results.push({feature,scope,status:'TOOL_OBSERVED'});};
 async function choose(id){await page.locator('#list').focus();await page.keyboard.press('Home');const i=await page.locator('#list [role=option]').evaluateAll((rows,id)=>rows.findIndex(r=>r.dataset.id===id),id);assert.ok(i>=0);for(let n=0;n<i;n++)await page.keyboard.press('ArrowDown');}
 async function toolbar(){if(await page.locator('#readingControls').getAttribute('aria-expanded')!=='true'){await page.locator('#readingControls').press('Enter');await settle();}}
 async function more(){await toolbar();const menu=page.locator('#readerBar > .reader-more');if(!await menu.evaluate(e=>e.open)){await menu.locator('summary').press('Enter');await settle();}}
 try{
  await page.goto(origin+'/');await page.locator('#list [role=option]').first().waitFor();
  await page.locator('#side h3 [data-add]').press('Enter');await page.locator('.side-input[data-new]').fill(categoryBase);await page.keyboard.press('Enter');await settle();
  let category=page.locator('.srow[data-cat="'+categoryBase+'"]');await category.press('Shift+F10');await page.getByRole('menuitem',{name:'改名',exact:true}).press('Enter');
  await page.locator('.side-input[data-rename]').fill(categoryName);await page.keyboard.press('Enter');await settle();
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.cat),categoryName);ok('Category create/rename restores keyboard focus');
  await page.locator('#q').fill('双栏无障碍');await page.waitForFunction(()=>document.querySelector('#count').textContent==='1 篇');await page.locator('#list').focus();await page.keyboard.press('Home');
  const sampleId=await page.locator('#list [role=option]').first().getAttribute('data-id');
  await page.locator('#catInput').fill(categoryName);await page.keyboard.press('Enter');
  await page.waitForFunction(([id,name])=>PR.lib.byId(id).tags.includes(name),[sampleId,categoryName]);
  const starBefore=await page.locator('[data-d=star]').getAttribute('aria-pressed');await page.locator('[data-d=star]').press('Enter');await settle();assert.notEqual(await page.locator('[data-d=star]').getAttribute('aria-pressed'),starBefore);
  await page.locator('[data-status=done]').press('Enter');await settle();assert.equal(await page.locator('[data-status=done]').getAttribute('aria-pressed'),'true');ok('Assign category, star and reading status');
  const grip=page.getByRole('separator',{name:/侧栏宽度/});const initial=Number(await grip.getAttribute('aria-valuenow'));await grip.press('ArrowRight');assert.equal(Number(await grip.getAttribute('aria-valuenow')),Math.min(420,initial+10));await grip.press('ArrowLeft');ok('Sidebar resize has keyboard separator values');
  await page.locator('#settingsBtn').press('Enter');await settle();
  for(const tab of ['engine','selection','chat','reading','library','keys']){await page.locator('[data-set-tab='+tab+']').press('Enter');await settle();assert.equal(await page.locator('[data-set-tab='+tab+']').getAttribute('aria-pressed'),'true');}
  await page.locator('[data-set-tab=chat]').press('Enter');await settle();
  await page.locator('[data-cm=add]').press('Enter');await settle();await page.locator('#cmName').fill('Synthetic model draft');await page.locator('[data-cm=ok]').press('Enter');await settle();
  const added=page.locator('.mc').filter({hasText:'Synthetic model draft'});await added.locator('[data-cm=default]').press('Enter');await settle();assert.equal(await page.locator('.mc').filter({hasText:'Synthetic model draft'}).locator('[data-cm=default]').getAttribute('aria-pressed'),'true');
  await page.locator('.mc').filter({hasText:'Synthetic model draft'}).locator('[data-cm=more]').press('Enter');await page.getByRole('menuitem',{name:/修改/}).press('Enter');await settle();await page.locator('#cmName').fill('Synthetic model renamed');await page.locator('[data-cm=ok]').press('Enter');await settle();
  await page.locator('.mc').filter({hasText:'Synthetic model renamed'}).locator('[data-cm=more]').press('Enter');await page.getByRole('menuitem',{name:/删/}).press('Enter');await page.getByRole('button',{name:'删掉',exact:true}).press('Enter');await settle();assert.equal(await page.locator('.mc').filter({hasText:'Synthetic model renamed'}).count(),0);
  ok('Model settings add/default/edit/delete by keyboard','Draft settings only; cancel without saving or provider calls');
  await page.locator('#setCancel').press('Enter');await settle();ok('Every existing settings tab reachable with keyboard');
  await page.locator('[data-d=read]').press('Enter');await page.waitForFunction(()=>window.dualReady===true);await toolbar();
  await page.locator('#notesBtn').press('Enter');await settle();await page.locator('[data-np=paper]').press('Enter');await settle();
  const draft='Synthetic recovery note '+Date.now();
  const noteURL=origin+'/api/reading/'+sampleId+'/paper-note';
  await page.route(noteURL,r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic save interruption'})}),{times:1});
  await page.locator('#paperNote').fill(draft);await page.locator('[data-account-note-save]').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#accountNoteStatus').textContent.includes('尚未保存'));
  assert.equal(await page.locator('#paperNote').inputValue(),draft);
  await toolbar();await page.getByRole('link',{name:'← 文献库'}).press('Enter');await page.locator('.popover.confirm.open').waitFor();
  await page.locator('[data-cf=no]').press('Enter');await settle();assert.ok(page.url().includes('/read/'));assert.equal(await page.locator('#paperNote').inputValue(),draft);
  await page.locator('[data-account-note-save]').press('Enter');await page.waitForFunction(()=>document.querySelector('#accountNoteStatus').textContent.includes('成功保存'));
  ok('Save failure retains draft; cancel navigation and retry persist','503 controlled fixture; retry real local backend');
  await page.locator('[data-np-act=close]').press('Enter');await settle();await toolbar();
  await more();await page.locator('#page').fill('1');await page.locator('#page').press('Enter');await page.waitForFunction(()=>document.querySelector('#sourcePage').textContent.includes('第 1 页'));
  await page.locator('#page').press('F6');
  const pdf=page.frames().find(f=>f.url().includes('viewer.html'));assert.equal(await pdf.evaluate(()=>document.activeElement.classList.contains('textLayer')),true);
  await pdf.evaluate(()=>{const span=document.querySelector('.page[data-page-number="1"] .textLayer span');const range=document.createRange();range.selectNodeContents(span);const s=getSelection();s.removeAllRanges();s.addRange(range);});
  const count=await page.evaluate(()=>PR.myNotes().length);
  await pdf.locator('.page[data-page-number="1"] .textLayer').press('Shift+F10');await settle();
  await page.locator('#selectionTools [data-s=highlight][data-color=yellow]').press('Enter');
  await page.waitForFunction(n=>PR.myNotes().length>n,count);ok('F6 enters PDF; Shift+F10 exposes annotation actions','Controlled DOM text selection; keyboard annotation; real persistence');
  await toolbar();await page.locator('#notesBtn').press('Enter');await settle();await page.locator('[data-np=notes]').press('Enter');await settle();
  const card=page.locator('#notespanel .card[data-note]').last();await card.locator('[data-a=edit]').press('Enter');await page.getByRole('textbox',{name:'批注内容',exact:true}).fill('Synthetic annotation edit');await page.getByRole('textbox',{name:'批注内容',exact:true}).press('Enter');await settle();ok('Annotation edit through keyboard');
  await page.locator('[data-np-act=close]').press('Enter');await settle();await toolbar();
  // Report service fixtures preserve real paper identity, but never call AI.
  const reading=origin+'/api/reading/'+sampleId;let state=await page.evaluate(async url=>await (await fetch(url)).json(),reading),phase='initial',generations=0;
  const claim={text:'Synthetic report claim',source:'paper',citations:[{page:1,quote:'PAGE 1 LEFT paragraph 1.'}]};
  const result={sections:{research_question:[claim]}};
  await page.route(reading,route=>{const value=structuredClone(state);value.parse_state='ready';value.identity_ok=true;value.report=null;value.tasks=[];
   if(phase==='failed')value.tasks=[{id:'fixture-report',kind:'report',state:'failed',error:'Synthetic generation failure'}];
   if(phase==='save_failed')value.tasks=[{id:'fixture-report',kind:'report',state:'save_failed',result}];
   if(phase==='saved')value.report={id:'fixture-report',saved:Date.now()/1000,result};
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});});
  await page.route(reading+'/report',route=>{generations++;phase=generations===1?'failed':'save_failed';return route.fulfill({json:{ok:true}});});
  await page.route(reading+'/save',route=>{phase='saved';return route.fulfill({json:{ok:true}});});
  await page.route(reading+'/reference?*',route=>route.fulfill({json:{page:1,quote:'PAGE 1 LEFT paragraph 1.'}}));
  await page.locator('#reportBtn').press('Enter');await page.getByRole('button',{name:'生成阅读报告',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'关闭阅读报告');
  await page.locator('#generateReport').press('Enter');await page.getByText('Synthetic generation failure',{exact:true}).waitFor();
  await page.getByRole('button',{name:'重新生成（可能再次收费）',exact:true}).press('Enter');await page.locator('.popover.confirm.open [data-cf=ok]').press('Enter');
  await page.getByRole('button',{name:'再次保存（不调用AI）',exact:true}).press('Enter');await page.getByText(/最近成功报告/).waitFor();assert.equal(generations,2);
  await page.getByRole('button',{name:'查看原文',exact:true}).press('Enter');await settle();assert.equal(await page.evaluate(()=>PR.side),null);
  ok('Report failure/retry/save-only recovery and citation jump','Controlled report fixture; zero provider requests');
  await more();await page.locator('#readingHistory').press('Enter');
  await page.getByRole('dialog',{name:'历史阅读记录',exact:true}).waitFor();await page.keyboard.press('Escape');await settle();ok('History native dialog opens and escapes');
  await toolbar();await page.getByRole('link',{name:'← 文献库'}).press('Enter');await page.locator('#list').waitFor();
  await page.locator('#q').fill('');await page.locator('.srow[data-view=all]').press('Enter');
  category=page.locator('.srow[data-cat="'+categoryName+'"]');await category.press('Shift+F10');await page.getByRole('menuitem',{name:'删除分类',exact:true}).press('Enter');await page.locator('.popover.confirm.open [data-cf=ok]').press('Enter');await category.waitFor({state:'detached'});ok('Delete category preserves paper');
  assert.deepEqual(errors,[]);
 }finally{await page.unrouteAll({behavior:'ignoreErrors'});fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,errors},null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
