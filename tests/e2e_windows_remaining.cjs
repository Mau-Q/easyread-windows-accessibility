// Additional existing functions; all destructive operations use a disposable sample.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
 const b=await chromium.connectOverCDP(process.env.EASYREAD_CDP),p=b.contexts()[0].pages()[0];
 const out=process.env.EASYREAD_EVIDENCE||'test-results/windows-remaining';fs.mkdirSync(out,{recursive:true});
 const results=[],errors=[];p.on('pageerror',e=>errors.push(e.message));
 const settle=()=>p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const ok=feature=>{results.push({feature,status:'TOOL_OBSERVED',scope:'native UI / real local backend'});console.log(feature);};
 async function toolbar(){if(await p.locator('#readingControls').getAttribute('aria-expanded')!=='true'){await p.locator('#readingControls').press('Enter');await settle();}}
 async function more(){await toolbar();const d=p.locator('#readerBar > .reader-more');if(!await d.evaluate(e=>e.open)){await d.locator('summary').press('Enter');await settle();}}
 try {
  await p.goto(new URL(p.url()).origin+'/');await p.locator('#list [role=option]').first().waitFor();
  await p.locator('#q').fill('双栏无障碍');await p.waitForFunction(()=>document.querySelectorAll('#list [role=option]').length===1);
  await p.locator('#list').focus();await p.keyboard.press('Home');await p.keyboard.press('Enter');await p.waitForFunction(()=>window.dualReady===true);await toolbar();
  assert.ok(await p.evaluate(()=>!!Dual.assets.translation),'Seed a controlled translation PDF fixture first');
  for(const layout of ['source','translation','parallel']){await p.locator('[data-pdf-layout='+layout+']').press('Enter');await p.waitForFunction(mode=>!Dual.layoutChanging&&Dual.layout===mode,layout);assert.equal(await p.locator('[data-pdf-layout='+layout+']').getAttribute('aria-pressed'),'true');}
  const divider=p.locator('.reader-divider');await divider.press('ArrowRight');assert.equal(await divider.getAttribute('aria-valuenow'),'52');await divider.press('Home');assert.equal(await divider.getAttribute('aria-valuenow'),'50');
  await more();await p.locator('#sync').check();await p.locator('#page').fill('1');await p.locator('#page').press('Enter');await p.waitForFunction(()=>Dual.views[Dual.active].pageIndex===0);
  await p.locator('#fit').press('Enter');await p.locator('#zoomIn').press('Enter');await p.locator('#zoomOut').press('Enter');
  await p.locator('#next').press('Enter');await p.waitForFunction(()=>document.querySelector('#sourcePage').textContent.includes('第 2 页'));
  await p.locator('#prev').press('Enter');await p.waitForFunction(()=>document.querySelector('#sourcePage').textContent.includes('第 1 页'));ok('All PDF layouts, split keyboard adjustment, zoom and next/previous page');
  await p.locator('#theme').press('Enter');await settle();assert.equal(await p.locator('#theme').getAttribute('aria-expanded'),'true');await p.keyboard.press('Escape');await settle();ok('Reader appearance chooser opens and closes by keyboard');
  await more();await p.locator('#readingHistory').press('Enter');await p.locator('.reading-history-dialog .history-content').waitFor();
  await p.locator('.reading-history-dialog .history-content').getByText(/正在读取/).waitFor({state:'hidden'});
  await p.keyboard.press('Escape');await settle();assert.equal(await p.evaluate(()=>document.activeElement.id),'readingHistory');ok('History content loads; Escape restores focus (native download tested separately)');
  // 200% text/layout zoom at the native window's actual available width.
  await p.evaluate(()=>document.documentElement.style.zoom='2');await toolbar();
  const controls=await p.locator('#readingControls').boundingBox();assert.ok(controls.x>=0&&controls.y>=0);
  await p.locator('#notesBtn').press('Enter');await settle();await p.locator('[data-np=paper]').press('Enter');await settle();
  const input=await p.locator('#paperNote').boundingBox();const viewport=await p.evaluate(()=>({w:innerWidth,h:innerHeight}));assert.ok(input.width>100&&input.x<viewport.w&&input.y<viewport.h);
  await p.locator('[data-np-act=close]').press('Enter');await p.evaluate(()=>document.documentElement.style.zoom='');ok('200 percent zoom keeps reader toolbar and paper note reachable');
  await toolbar();await p.getByRole('link',{name:'← 文献库'}).press('Enter');await p.locator('#list').waitFor();
  if(!process.env.EASYREAD_DELETE_SAMPLE)throw Error('Set EASYREAD_DELETE_SAMPLE to a disposable PDF');
  await p.locator('#importBtn').press('Enter');await settle();await p.locator('#fileInput').setInputFiles(process.env.EASYREAD_DELETE_SAMPLE);
  await p.waitForFunction(()=>!document.querySelector('#importDlg').classList.contains('open'));
  await p.waitForFunction(()=>!!PR.lib.selected&&!!PR.lib.byId(PR.lib.selected));
  const id=await p.evaluate(()=>PR.lib.selected);assert.ok(id);
  await p.locator('[data-d=more]').press('Enter');await p.getByRole('menuitem',{name:'永久删除',exact:true}).press('Enter');
  await p.locator('[data-cf=no]').press('Enter');await settle();assert.ok(await p.evaluate(id=>!!PR.lib.byId(id),id));
  await p.locator('[data-d=more]').press('Enter');await p.getByRole('menuitem',{name:'永久删除',exact:true}).press('Enter');await p.getByRole('button',{name:'确认永久删除',exact:true}).press('Enter');
  await p.waitForFunction(id=>!PR.lib.byId(id),id);ok('Disposable paper deletion: cancel preserves it; confirm deletes it');
  assert.deepEqual(errors,[]);
 } finally {fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,errors},null,2));await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
