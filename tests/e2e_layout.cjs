// 通用排版、DataFlow 原文/译文一致性，以及本地 PDF 自动匹配阅读路径。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'easyread-layout-'));
const checks = []; const ok = (value, label) => { assert(value, label); checks.push(label); console.log('PASS', label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(100); } throw Error('等待测试超时'); }
(async () => {
  const srv = spawn(path.join(root, '.venv/bin/python'), ['-m', 'tests.web_reader_server'], {cwd:root, env:{...process.env, EASYREAD_HOME:tmp, EASYREAD_LIBRARY:path.join(tmp,'library'), EASYREAD_DATAFLOW_FIXTURE:path.join(root,'library/h318344820356')}});
  let browser;
  try {
    const info = await new Promise((resolve,reject) => { let buf=''; const t=setTimeout(()=>reject(Error('未启动')),15000); srv.stdout.on('data',d=>{buf+=d;if(buf.includes('\n')){clearTimeout(t);resolve(JSON.parse(buf.split('\n')[0]));}}); srv.stderr.on('data',d=>process.stderr.write(d)); });
    browser = await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
    const page = await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://**', route => /\.svg/.test(route.request().url()) ? route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="476" height="99"><text y="50">Original SVG test resource</text></svg>'}) : route.abort());
    async function load(id) { await page.goto(info.url+'/read/'+id); await page.waitForFunction(()=>document.querySelector('#article')?.contentDocument?.querySelector('.easyread-visual-controls')); return page.frames().find(f=>f.url().includes('/article.html')); }
    let frame = await load(info.id);
    const raw = fs.readFileSync(path.join(tmp,'library',info.id,'article.html'),'utf8');
    ok(await page.evaluate(raw=>{const d=new DOMParser().parseFromString(raw,'text/html'),before=PR.articleFingerprint(d);PR.layoutArticle(d);PR.layoutArticle(d);return before===PR.articleFingerprint(d);},raw),'通用规则第一次及重复应用均保留原文 DOM 内容');
    const table = frame.locator('.easyread-visual:has(table.ltx_tabular)').first();
    const baseline = await page.evaluate(()=>PR.articleFingerprint(document.querySelector('#article').contentDocument));
    const translations = await frame.locator('.easyread-zh').evaluateAll(ns=>ns.map(n=>n.dataset.text));
    ok(!await table.locator('.easyread-table-translation').isVisible(),'默认只显示原表，已有译表收起');
    await table.locator('[data-visual-action="bi"]').click();
    ok(await table.locator('.easyread-table-translation').isVisible() && await table.locator('table.ltx_tabular').isVisible(),'可展开已有译表，原表始终保留');
    await table.locator('[data-visual-action="expand"]').click();
    const dialog=frame.locator('.easyread-visual-dialog'); await dialog.waitFor({state:'visible'});
    const beforeZoom=await dialog.locator('table.ltx_tabular').evaluate(n=>n.getBoundingClientRect().width);
    await dialog.locator('[data-visual-action="plus"]').click();
    ok(await dialog.locator('[data-visual-action="fit"]').innerText()==='125%' && await dialog.locator('table.ltx_tabular').evaluate(n=>n.getBoundingClientRect().width)>beforeZoom*1.2,'放大查看确实增大图表，而不仅更新百分比');
    await dialog.locator('[data-visual-action="close"]').click();
    ok(await frame.locator('.easyread-visual-dialog').count()===0,'关闭放大图表后返回原阅读位置');
    ok(baseline===await page.evaluate(()=>PR.articleFingerprint(document.querySelector('#article').contentDocument)),'切换译表与放大均未修改英文、公式、链接及表格结构');
    assert.deepEqual(await frame.locator('.easyread-zh').evaluateAll(ns=>ns.map(n=>n.dataset.text)),translations); ok(true,'全部已有译文字符串完全一致');
    // 图表含 rowspan/colspan、内联数学、SVG 和代码，仍保持原 DOM。
    ok(await page.evaluate(()=>{const d=new DOMParser().parseFromString('<article class="ltx_document"><figure><svg xmlns="http://www.w3.org/2000/svg"><text>source</text></svg><pre>code = 1</pre><figcaption>Caption</figcaption></figure><figure><table class="ltx_tabular"><tr><th rowspan="2">A</th><td colspan="2"><math><mi>x</mi></math></td></tr><tr><td>B</td><td>C</td></tr></table></figure></article>','text/html');const b=PR.articleFingerprint(d);PR.layoutArticle(d);return b===PR.articleFingerprint(d);}), '合并单元格、数学、SVG 与代码图同样保真');
    const dataflowRoot=path.join(tmp,'library/dataflow-fixture');
    const frozen=Object.fromEntries(['source.html','article.html','paper.json'].map(n=>[n,fs.readFileSync(path.join(dataflowRoot,n))]));
    frame=await load('dataflow-fixture');
    const sourceFigure3=frame.locator('[id="S4.F3"]');
    await until(()=>sourceFigure3.locator('img').evaluate(n=>n.complete && n.naturalWidth>0));
    ok((await sourceFigure3.locator('img').getAttribute('src')).endsWith('/2512.16676v1/qa_eval_op_example.svg'),'DataFlow 图 3 从原快照恢复原 SVG，并成功显示');
    ok(await sourceFigure3.locator('.ltx_caption + .easyread-zh').isVisible(),'原图下仍显示已有双语图注');
    const savedPaper=JSON.parse(frozen['paper.json']);
    const shown=await frame.locator('.easyread-zh').evaluateAll(ns=>Object.fromEntries(ns.map(n=>[n.dataset.anchor,n.dataset.text])));
    ok(savedPaper.blocks.filter(b=>b.zh).every(b=>shown[b.id]===b.zh),'DataFlow 全部 371 段已有译文逐字符串核对一致');
    const dfraw=frozen['article.html'].toString();
    ok(await page.evaluate(raw=>{const d=new DOMParser().parseFromString(raw,'text/html'),b=PR.articleFingerprint(d);PR.layoutArticle(d);return b===PR.articleFingerprint(d);},dfraw),'DataFlow 原文节点、数学与原表排版前后完全一致');
    const dfTable = frame.locator('.ltx_table').filter({has:frame.locator('.ltx_caption', {hasText:'Table 2:'})}).first();
    const caption=await dfTable.locator('.ltx_caption + .easyread-zh').isVisible();
    ok(caption && !await dfTable.locator('.easyread-table-translation').isVisible(),'DataFlow 表 2 只显示原表与双语图注');
    await sourceFigure3.locator('[data-visual-action="expand"]').click();
    await frame.locator('.easyread-visual-dialog [data-visual-action="close"]').click();
    await page.setViewportSize({width:390,height:844});
    ok(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'窄屏图表横向滚动留在容器内，页面不溢出');
    await page.setViewportSize({width:1440,height:1000});
    for(const [n,bytes] of Object.entries(frozen))assert(fs.readFileSync(path.join(dataflowRoot,n)).equals(bytes));ok(true,'DataFlow 三个内容文件 SHA 校验输入字节保持不变');
    // API 集成：本地上传 -> 后台查找 -> 原版本哈希 -> 已有网页双语（假网络资源，不调用模型）。
    const library=await(await page.request.get(info.url+'/api/library')).json(), token=library.token;
    const pdf=fs.readFileSync(info.pdf), webBefore=fs.readFileSync(path.join(tmp,'library',info.id,'paper.json'));
    const res=await(await page.request.post(info.url+'/api/import?translate=0&name='+info.arxiv+'.pdf',{headers:{'X-Token':token,'Content-Type':'application/pdf'},data:pdf})).json();
    await until(async()=>{const s=await(await page.request.get(info.url+'/api/p/'+res.id+'/state')).json();return s.job?.state==='done';});
    const state=await(await page.request.get(info.url+'/api/p/'+res.id+'/state')).json();
    ok(state.item.arxiv_match.state==='matched' && state.item.web_source.id===info.id,'上传本地 PDF 自动寻找指定 arXiv 网页，并复用已有译文');
    await page.goto(info.url+'/read/'+res.id);await page.waitForSelector('#article');
    ok(page.url().endsWith('/read/'+info.id),'默认阅读自动进入网页双语');
    await page.waitForSelector('#localPdf:not([hidden])');
    ok((await page.locator('#localPdf').getAttribute('href')).includes(res.id+'/source.pdf'),'网页双语有原 PDF 核对入口');
    const original=await page.request.get(info.url+'/read/'+res.id+'?source=pdf');
    ok(original.url().endsWith('/source.pdf') && (await original.body()).equals(pdf),'仍可直接打开原始本地 PDF 阅读，未渲染时也不会空白');
    assert(fs.readFileSync(path.join(tmp,'library',res.id,'source.pdf')).equals(pdf));
    assert(fs.readFileSync(path.join(tmp,'library',info.id,'paper.json')).equals(webBefore));ok(true,'来源关联不修改 PDF 文件和已有网页译文');
    const again=await(await page.request.post(info.url+'/api/import?translate=0&name='+info.arxiv+'.pdf',{headers:{'X-Token':token},data:pdf})).json();
    ok(again.id===res.id && !again.new,'重复导入不重复建文献');
    // 设置必须显示实际 high，且切换引擎/保存/重开不能把已选并发重置为 1。
    await page.route('**/api/engines',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({found:{},models:{}})}));
    await page.evaluate(()=>PR.openSettings('engine'));
    await page.locator('#settingsDlg [data-engine="codex"]').click();
    ok((await page.locator('#settingsDlg .set-body').innerText()).includes('翻译推理强度：high'),'设置页显示翻译实际推理强度 high');
    await page.locator('#settingsDlg [data-k="concurrency"]').selectOption('16');
    await page.locator('#settingsDlg [data-engine="claude"]').click();
    await page.locator('#settingsDlg [data-engine="codex"]').click();
    ok(await page.locator('#settingsDlg [data-k="concurrency"]').inputValue()==='16','切换翻译引擎保留 16 路并发设置');
    await page.locator('#setSave').click();
    await page.waitForSelector('#settingsDlg.open',{state:'hidden'});
    await page.evaluate(()=>PR.openSettings('engine'));
    ok(await page.locator('#settingsDlg [data-k="concurrency"]').inputValue()==='16' && (await page.locator('#settingsDlg .set-body').innerText()).includes('翻译推理强度：high'),'保存并重新打开设置后，并发和 high 均保持');
    await page.locator('#setCancel').click();
    ok(errors.length===0,'阅读与导入流程没有 JavaScript 异常：'+errors.join(';'));
    console.log(JSON.stringify({result:'PASS',checks:checks.length}));
  } finally {if(browser)await browser.close();srv.kill('SIGTERM');fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
