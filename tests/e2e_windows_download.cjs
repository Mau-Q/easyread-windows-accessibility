// Playwright CDP cancels native downloads. Use raw CDP keyboard input and the
// actual Windows Save As dialog, then inspect the file saved on disk.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
(async()=>{
 const endpoint=process.env.EASYREAD_CDP;if(!endpoint)throw Error('Set EASYREAD_CDP');
 const out=process.env.EASYREAD_EVIDENCE||'test-results/windows-download';fs.mkdirSync(out,{recursive:true});
 const target=(await(await fetch(endpoint+'/json')).json()).find(x=>x.type==='page');
 const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let serial=0;
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
 ws.onmessage=e=>{const x=JSON.parse(e.data);if(x.id){const entry=pending.get(x.id);if(entry){pending.delete(x.id);x.error?entry.reject(Error(x.error.message)):entry.resolve(x.result);}}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 try {
  const focused=await send('Runtime.evaluate',{expression:`(()=>{const d=document.querySelector('.reading-history-dialog');if(!d?.open)throw Error('Open reading history first');const b=d.querySelector('.history-head button');b.focus();return document.activeElement===b})()` ,returnByValue:true});
  assert.equal(focused.result.value,true);
  // Do not await keydown: native modal Show() can block the CDP reply until saved.
  const key=send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,text:'\r'});
  await new Promise(r=>setTimeout(r,1200));
  const file=path.resolve(out,'history-'+Date.now()+'.json');
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'native_file_picker.ps1'),'-Sample',file,'-Save'],{encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);await key;await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
  const until=Date.now()+10000;while(!fs.existsSync(file)&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
  const data=JSON.parse(fs.readFileSync(file,'utf8'));assert.ok(Array.isArray(data.records));
  console.log('Actual native Save As keyboard export: valid JSON, records='+data.records.length);
 } finally {ws.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
