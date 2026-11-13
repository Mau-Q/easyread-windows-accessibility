// Real public arXiv HTML import; no translation/model request is made.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
 const b=await chromium.connectOverCDP(process.env.EASYREAD_CDP),p=b.contexts()[0].pages()[0];
 const settle=()=>p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 try {
  await p.goto(new URL(p.url()).origin+'/');await p.locator('#importBtn').press('Enter');await settle();
  await p.locator('#sourceMode').selectOption('arxiv_html');await p.locator('#arxivRef').fill('2411.00640v1');
  const imported=p.waitForResponse(r=>r.url().endsWith('/api/import-url')&&r.request().method()==='POST',{timeout:150000});
  await p.locator('#arxivRef').press('Enter');const response=await imported,data=await response.json();assert.equal(response.status(),200,JSON.stringify(data));
  await p.waitForFunction(id=>PR.lib.items.some(x=>x.id===id),data.id);
  await p.locator('#q').fill('Adding Error Bars');await p.waitForFunction(id=>!!document.querySelector('#paper-'+id),data.id);
  const index=await p.locator('#list [role=option]').evaluateAll((rows,id)=>rows.findIndex(e=>e.dataset.id===id),data.id);
  assert.ok(index>=0);await p.locator('#list').focus();await p.keyboard.press('Home');for(let n=0;n<index;n++)await p.keyboard.press('ArrowDown');await p.keyboard.press('Enter');
  const article=p.frameLocator('#article');await article.locator('[data-easyread-id]').first().waitFor({timeout:30000});
  await p.locator('#readingControls').press('Enter');await settle();await p.locator('#notesBtn').press('F6');
  assert.equal(await article.locator('body').evaluate(e=>e===document.activeElement),true);
  await article.locator('body').press('Shift+F6');await settle();assert.equal(await p.evaluate(()=>document.activeElement.closest('#readerBar')!==null),true);
  const more=p.locator('#readerBar > .reader-more');await more.locator('summary').press('Enter');await p.locator('#jumpAbstract').press('Enter');
  await p.waitForFunction(()=>document.querySelector('#article').contentDocument.activeElement?.classList.contains('ltx_abstract'));
  assert.ok(await article.locator('body').evaluate(()=>document.activeElement!==document.body));
  const count=await p.evaluate(()=>PR.myNotes().length);
  await article.locator('body').evaluate(()=>{const e=document.querySelector('p[data-easyread-id]')||document.querySelector('[data-easyread-id]');const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);});
  await article.locator('body').press('Shift+F10');await p.locator('#selbar [data-s=highlight][data-color=yellow]').press('Enter');
  await p.waitForFunction(n=>PR.myNotes().length>n,count);
  if(await p.locator('#readingControls').getAttribute('aria-expanded')!=='true')await p.locator('#readingControls').press('Enter');await settle();
  await p.locator('#notesBtn').press('Enter');await settle();assert.equal(await p.locator('#notespanel').evaluate(e=>e.contains(document.activeElement)),true);
  await p.keyboard.press('Escape');await settle();assert.equal(await p.evaluate(()=>document.activeElement.id),'notesBtn');
  console.log('Real arXiv HTML import, body/F6 navigation, abstract focus, keyboard highlight persistence and note focus return passed');
 } finally {await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
