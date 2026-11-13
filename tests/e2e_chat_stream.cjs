// Fixed local replay of production renderLive, no server/model/user-data writes.
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {webkit}=require('../runtime/node_modules/playwright');
const repo=path.resolve(__dirname,'..'),before=process.env.CHAT_BEFORE,output=process.env.CHAT_RESULTS;
const paragraph='这是一个长回答的完整段落，解释训练数据、验证指标以及误差来源。读者可以回看早先的内容，并结合公式理解每一步。';
const cases={prose:Array.from({length:100},(_,i)=>`### 第 ${i+1} 点\n\n${paragraph.repeat(2)}\n\n`).join(''),mixed:Array.from({length:45},(_,i)=>`### 推导 ${i+1}\n\n${paragraph} 参见 [1]、公式 (1)。\n\n- 更新参数 $x_i$\n- 比较验证损失\n\n$$\\sum_{i=1}^{n} w_i x_i$$\n\n| 方法 | 参数 |\n| --- | --- |\n| A | $x_i$ |\n| B | $w_i$ |\n\n\`\`\`python\n# 空行仍属于代码\nx = "<tag>"\n\ny = x + "|"\n\`\`\`\n\n`).join('')};
const boundaryCases=['前文\n\n```python\nx=1\n\ny=2\n```\n\n后文','| A | B |\n| --- | --- |\n| a\\|b | `x|y` |\n\n后文','文字\n$$x+y$$\n\n- 一\n- 二\n\n引用 [1] 和公式 (1)','~~~\nabc\n\n~~~\n\n后文','a\r\n\r\nb\r\n\r\nc','价格 \\$20\n\n**粗体 $x$**\n\n<script>bad</script>'];
(async()=>{
 const browser=await webkit.launch({headless:true});const results={cases:{},checks:[]};
 try{
  async function pageFor(source){
   const p=await browser.newPage({viewport:{width:1280,height:900}});
   await p.setContent('<div id="chatpanel"><div id="chatList" style="height:600px;width:460px;overflow:auto"><div class="cm ai"><div class="body"></div></div></div></div>');
   await p.addScriptTag({path:path.join(repo,'easyread/web/vendor/katex/katex.min.js')});
   await p.addScriptTag({path:path.join(repo,'easyread/web/js/common/util.js')});
   await p.evaluate(()=>{Object.assign(PR,{state:{},store:{mode:'server'},blockById:{p1:{page:1}},refById:{1:{}},xindex:{eq:{1:{}}},on(){}})});
   await p.addScriptTag({path:path.join(repo,'easyread/web/js/common/markup.js')});
   const hook='PR.__replay=text=>{st.streaming||={msg:{}};st.streaming.msg.content=text;renderLive();}; PR.__reset=()=>{st.streaming=null;document.querySelector(".body").replaceChildren();}; const renderLiveSoon =';
   await p.addScriptTag({content:fs.readFileSync(source,'utf8').replace('const renderLiveSoon =',hook)});return p;
  }
  const optimized=await pageFor(path.join(repo,'easyread/web/js/reader/chat.js'));
  for(const text of boundaryCases){await optimized.evaluate(()=>PR.__reset());await optimized.evaluate(text=>{for(let i=1;i<=text.length;i++){PR.__replay(text.slice(0,i));const box=document.querySelector('.body');if([...box.children].map(n=>n.outerHTML).join('')!==PR.mdBlocks(text.slice(0,i)))throw Error('prefix mismatch '+i);} },text);}
  results.checks.push('Every streamed character matches original Markdown for fences, blank lines, tables, CRLF, formulas, escaped currency, citations and HTML escaping');
  await optimized.evaluate(()=>{PR.__reset();PR.__replay('已完成\n\n未完成');const first=document.querySelector('.body p');PR.__replay('已完成\n\n未完成继续');if(first!==document.querySelector('.body p'))throw Error('stable node replaced');PR.refById={};PR.__replay('已完成\n\n未完成继续');if(document.querySelector('.body').textContent!=='已完成未完成继续')throw Error('context reset');});
  results.checks.push('Completed nodes retained; changed citation context resets rendering');await optimized.close();
  for(const [name,text]of Object.entries(cases)){
   results.cases[name]={chars:text.length,chunk_chars:192};
   for(const variant of ['before','after']){
    const p=await pageFor(variant==='before'?path.join(before,'easyread/web/js/reader/chat.js'):path.join(repo,'easyread/web/js/reader/chat.js'));
    const measured=await p.evaluate(text=>{
     const md=PR.mdBlocks;let chars=0,calls=0;PR.mdBlocks=(s,...args)=>{chars+=s.length;calls++;return md(s,...args)};
     const runs=[];let input=0,count=0;
     for(let trial=0;trial<6;trial++){PR.__reset();chars=0;calls=0;const times=[];
      for(let n=192;n<text.length+192;n+=192){const t=performance.now();PR.__replay(text.slice(0,n));document.querySelector('#chatList').scrollHeight;times.push(performance.now()-t);}
      const gold=document.createElement('div');gold.innerHTML=md(text);if([...document.querySelector('.body').children].map(n=>n.outerHTML).join('')!==[...gold.children].map(n=>n.outerHTML).join(''))throw Error('final mismatch');
      if(trial)runs.push({total_ms:times.reduce((a,b)=>a+b,0),p95_update_ms:times.slice().sort((a,b)=>a-b)[Math.floor(times.length*.95)],max_update_ms:Math.max(...times)});input=chars;count=calls;
     }
     return {runs,parsed_chars:input,parser_calls:count};
    },text);results.cases[name][variant]=measured;await p.close();
   }
  }
  // Run the identical prefix checks through the PDF-specific adapter too.
  const pdf=await pageFor(path.join(repo,'easyread/web/js/pdf-dual/chat.js'));
  for(const text of boundaryCases){await pdf.evaluate(()=>PR.__reset());await pdf.evaluate(text=>{for(let i=1;i<=text.length;i++){PR.__replay(text.slice(0,i));if([...document.querySelector('.body').children].map(n=>n.outerHTML).join('')!==PR.mdBlocks(text.slice(0,i)))throw Error('PDF mismatch '+i);}},text);}await pdf.close();
  results.checks.push('PDF adapter matches the same prefix cases');
  fs.writeFileSync(output,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
