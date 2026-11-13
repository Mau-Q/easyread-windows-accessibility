/* Actual browser observation. This process never writes paper or note data. */
const fs=require('fs'),path=require('path');
(async()=>{
  const [moduleRoot,url,out,requiredPath]=process.argv.slice(2);
  const required=JSON.parse(fs.readFileSync(requiredPath,'utf8'));
  const {webkit}=require(path.join(moduleRoot,'playwright'));
  const browser=await webkit.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(url,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.reflowReady||document.querySelector('#readerFrame')?.contentWindow?.pilotError,{timeout:180000});
    const observation=await page.evaluate(async(required)=>{
      const p=window.reflowPilot;
      if(!p)return {complete:false,errors:[document.querySelector('#readerFrame')?.contentWindow?.pilotError||'reader initialization failed']};
      const doc=p.reader._primarySDTView._iframeDocument;
      // Zotero creates src-less crop placeholders and renders them on demand.
      // Visit each region; an unloaded offscreen placeholder is not a broken image.
      for(const img of [...doc.images].filter(img=>!img.closest('[hidden]'))){
        img.scrollIntoView({block:'center'});
        const started=Date.now();
        while((!img.naturalWidth||img.dataset.easyreadImageReady!=='true')&&Date.now()-started<10000)await new Promise(resolve=>setTimeout(resolve,50));
      }
      const mappings=p.mappings.map(m=>({id:m.anchor,source:!!m.en?.isConnected,translation:!!m.zh?.isConnected,
        math_errors:[...m.zh.querySelectorAll('.katex-error')].map(e=>({tex:e.textContent,error:e.title})).concat([...m.zh.querySelectorAll('.pilot-prose')].filter(e=>!e.closest('code')&&/\\(?:frac|bigcup|sum|sqrt)\b/.test(e.textContent)).map(e=>({tex:e.textContent,error:'公式代码尚未排版'}))),
        images:[...(m.en?.querySelectorAll('img')||[])].filter(img=>!img.closest('[hidden]')).map(img=>({complete:img.complete&&img.dataset.easyreadImageReady==='true',width:img.naturalWidth}))}));
      const images=[...doc.querySelectorAll('#sdt-content img')].filter(img=>!img.closest('[hidden]')).map(img=>({complete:img.complete&&img.dataset.easyreadImageReady==='true',width:img.naturalWidth,ref:img.closest('[data-ref-path]')?.dataset.refPath}));
      const missing=p.map.records.filter(r=>!mappings.some(m=>m.id===r.anchor)).map(r=>r.anchor);
      const visible=el=>!!el&&!el.closest('[hidden]')&&el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0;
      const missing_visuals=required.filter(n=>!n.has_coordinates||![doc.querySelector('[data-ref-path="'+n.ref+'"]'),doc.querySelector('[data-easyread-source-anchor="visual-'+n.ref+'"]'),doc.querySelector('[data-pilot-original-ref="'+n.ref+'"]')].some(visible));
      const failed=mappings.filter(m=>!m.source||!m.translation||m.math_errors.length||m.images.some(i=>!i.complete||!i.width));
      return {complete:!missing.length&&!missing_visuals.length&&!failed.length&&!images.some(i=>!i.complete||!i.width),mappings,missing,missing_visuals,failed,images,
        width:doc.getElementById('sdt-content').getBoundingClientRect().width};
    },required);
    observation.errors=(observation.errors||[]).concat(errors);observation.complete=observation.complete&&!errors.length;
    await page.screenshot({path:path.join(path.dirname(out),'render.png')});
    fs.writeFileSync(out,JSON.stringify(observation,null,2));
  }finally{await browser.close();}
})().catch(e=>{process.stderr.write(String(e));process.exitCode=1;});
