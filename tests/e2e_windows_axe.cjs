// Mechanical WCAG checks supplement actual NVDA and Windows contrast tests.
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const b=await chromium.connectOverCDP(process.env.EASYREAD_CDP),p=b.contexts()[0].pages()[0],results=[];
 const out=process.env.EASYREAD_EVIDENCE||'test-results/windows-axe';fs.mkdirSync(out,{recursive:true});
 const settle=()=>p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 async function scan(name){
  await p.waitForFunction(()=>document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).every(a=>a.playState==='finished'||a.playState==='idle'));
  for(const f of p.frames())await f.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
  const data=await p.evaluate(async()=>{const r=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}});return {violations:r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)})),incomplete:r.incomplete.map(v=>v.id),passes:r.passes.length};});
  results.push({name,...data});console.log(name+' violations='+data.violations.length);
 }
 try {
  await p.goto(new URL(p.url()).origin+'/');await p.locator('#list [role=option]').first().waitFor();await settle();await scan('library');
  await p.locator('#importBtn').press('Enter');await settle();await scan('import dialog');await p.keyboard.press('Escape');await settle();
  await p.locator('#settingsBtn').press('Enter');await settle();
  for(const tab of ['engine','selection','chat','reading','library','keys']){await p.locator('[data-set-tab='+tab+']').press('Enter');await settle();await scan('settings '+tab);}
  await p.locator('#setCancel').press('Enter');await settle();
  await p.locator('#q').fill('双栏无障碍');await p.waitForFunction(()=>document.querySelectorAll('#list [role=option]').length===1);await p.locator('#list').focus();await p.keyboard.press('Home');await p.keyboard.press('Enter');await p.waitForFunction(()=>window.dualReady===true);await scan('PDF reader');
  await p.locator('#readingControls').press('Enter');await settle();await p.locator('#notesBtn').press('Enter');await settle();await scan('PDF notes');
  assert.equal(results.reduce((n,r)=>n+r.violations.length,0),0,JSON.stringify(results.filter(r=>r.violations.length)));
 } finally {fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
