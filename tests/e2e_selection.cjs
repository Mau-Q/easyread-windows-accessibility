const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const {spawn} = require('child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'easyread-selection-'));
const checks = [], ok = (value, label) => { assert(value, label); checks.push(label); console.log('PASS', label); };
(async () => {
  let browser;
  const srv = spawn(path.join(root, '.venv/bin/python'), ['-m', 'tests.web_reader_server'], {cwd: root, env: {...process.env, EASYREAD_HOME: tmp, EASYREAD_LIBRARY: path.join(tmp, 'library')}});
  try {
    const info = await new Promise((resolve, reject) => {
      let buf = ''; const timeout = setTimeout(() => reject(Error('fixture server timeout')), 15000);
      srv.stdout.on('data', data => {buf += data; if (buf.includes('\n')) {clearTimeout(timeout); resolve(JSON.parse(buf.split('\n')[0]));}});
      srv.stderr.on('data', data => process.stderr.write(data));
    });
    browser = await chromium.launch({headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
    const page = await browser.newPage({viewport: {width: 1300, height: 900}}), errors = [], requests = [], cancelled = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', req => {
      if (/\/p\/[^/]+\/selection-translation$/.test(req.url())) requests.push(req.postDataJSON());
      if (req.url().endsWith('/selection-translation/cancel')) cancelled.push(req.postDataJSON());
    });
    await page.route('https://**', route => route.abort());
    const bytes = Object.fromEntries(['paper.json', 'article.html', 'source.html'].map(n => [n, fs.readFileSync(path.join(tmp, 'library', info.id, n))]));
    await page.goto(info.url + '/read/' + info.id);
    await page.waitForFunction(() => window.PR?.state.paper && document.querySelector('#article')?.contentDocument?.querySelector('#selection-test'));
    await page.waitForTimeout(150);
    let frame = page.frames().find(f => f.url().includes('/article.html'));
    const body = await frame.locator('#selection-test').getAttribute('data-easyread-id');
    async function select(text, selector = '#selection-test') {
      await frame.locator(selector).scrollIntoViewIfNeeded();
      await page.waitForTimeout(180);
      return frame.evaluate(({selector, text}) => {
        const root = document.querySelector(selector), node = root.firstChild, start = node.data.indexOf(text);
        if (start < 0) throw Error('text absent');
        const r = document.createRange(); r.setStart(node, start); r.setEnd(node, start + text.length);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        root.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
        const box = r.getBoundingClientRect(); return {bottom: box.bottom, top: box.top};
      }, {selector, text});
    }
    const box = await select('parameters');
    await page.locator('#selectionTranslation').waitFor({state: 'visible'});
    ok(await page.locator('#selectionTranslation').getAttribute('data-phase') === 'loading', '选完立即出现正在翻译，无需点击');
    const geometry = await page.locator('#selectionTranslation').boundingBox(), fb = await page.locator('#article').boundingBox();
    ok(geometry.y >= fb.y + box.bottom, '翻译卡片位于选区下方');
    await page.waitForFunction(() => PR.selectionTranslationState()?.phase === 'done');
    ok((await page.locator('.st-result').textContent()).includes('parameters'), '自动翻译单词');
    const first = await page.evaluate(() => PR.selectionTranslationState());
    ok(first.popup_ms < 100, '卡片绘制耗时低于100毫秒');
    await page.locator('[data-st="close"]').click();
    await select('parameters');
    await page.waitForFunction(() => PR.selectionTranslationState()?.phase === 'done');
    ok((await page.evaluate(() => PR.selectionTranslationState())).server.cached, '重复选择从独立结果缓存返回');
    for (const quote of ['validation loss', 'parameters minimize validation loss.']) {
      await select(quote); await page.waitForFunction(() => PR.selectionTranslationState()?.phase === 'done');
      ok((await page.locator('.st-result').textContent()).includes(quote), '短语或整句翻译：' + quote);
    }
    await select('These parameters minimize validation loss.');
    await page.waitForFunction(() => PR.selectionTranslationState()?.phase === 'done');
    const existing = await page.evaluate(anchor => PR.blockById[anchor].zh, body);
    ok((await page.locator('.st-result').textContent()) === existing && (await page.evaluate(() => PR.selectionTranslationState())).server.reused_existing, '完整段落直接复用原有译文，不调用模型');
    await select('Same phrase', '#repeat');
    await page.waitForTimeout(180); // 第一个请求已经进入替身模型。
    await select('parameters');
    await page.waitForFunction(() => PR.selectionTranslationState()?.phase === 'done');
    await page.waitForTimeout(450);
    ok((await page.locator('.st-result').textContent()).endsWith('parameters'), '旧请求不覆盖新选区结果');
    ok(cancelled.length > 0, '切换选区会主动取消旧请求');
    await frame.locator('#a').scrollIntoViewIfNeeded();
    await page.waitForTimeout(180);
    await frame.locator('#a').evaluate(root => {const r=document.createRange(),s=getSelection();r.selectNodeContents(root);s.removeAllRanges();s.addRange(r);root.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
    await page.waitForFunction(() => ['done','error'].includes(PR.selectionTranslationState()?.phase));
    ok((await page.evaluate(()=>PR.selectionTranslationState()))?.phase==='done' && (await page.locator('.st-result').textContent()).includes('$x_i$'), '选区中的数学保留TeX，原公式节点不变');
    await frame.locator('#selection-test').scrollIntoViewIfNeeded();
    await page.waitForTimeout(180);
    const beforeDrag = requests.length;
    await frame.evaluate(() => document.querySelector('#selection-test').dispatchEvent(new MouseEvent('mousedown', {bubbles: true})));
    await frame.evaluate(() => {const n=document.querySelector('#selection-test').firstChild,s=getSelection(),r=document.createRange();r.setStart(n,0);r.setEnd(n,6);s.removeAllRanges();s.addRange(r);});
    await page.waitForTimeout(250);
    ok(requests.length === beforeDrag, '拖动过程中不发送翻译请求');
    await frame.evaluate(() => document.querySelector('#selection-test').dispatchEvent(new MouseEvent('mouseup', {bubbles: true})));
    await page.waitForFunction(() => PR.selectionTranslationState()?.phase === 'done');
    await frame.evaluate(() => document.querySelectorAll('.easyread-zh').forEach(n=>n.hidden=true));
    await page.waitForTimeout(200);
    await frame.evaluate(() => {const a=document.querySelector('#selection-test').firstChild,b=document.querySelector('#selection-next').firstChild,r=document.createRange(),s=getSelection();r.setStart(a,0);r.setEnd(b,b.length);s.removeAllRanges();s.addRange(r);a.parentElement.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
    await page.waitForFunction(() => ['done','error'].includes(PR.selectionTranslationState()?.phase));
    ok((await page.evaluate(()=>PR.selectionTranslationState())).phase==='done', '跨段翻译完成：'+await page.locator('.st-result').textContent());
    ok((await page.evaluate(()=>PR.selectionTranslationState())).server.reused_existing && (await page.locator('.st-result').textContent()).includes(existing), '跨段选区复用对应段落的完整译文');
    await page.keyboard.press('Escape');
    ok(!await page.locator('#selectionTranslation').isVisible(), 'Escape关闭卡片');
    const originalCfg = await page.evaluate(async () => (await PR.api('/api/config')).config);
    await page.evaluate(() => PR.openSettings('selection'));
    await page.locator('[data-st-setting="engine"]').selectOption('api');
    await page.locator('[data-st-setting="api.base_url"]').fill('https://example.invalid/v1');
    await page.locator('[data-st-setting="api.model"]').fill('example-fast-model');
    await page.locator('[data-st-setting="api.api_key"]').fill('private-ui-fixture-key');
    await page.locator('#setSave').click();
    await page.waitForFunction(() => !document.querySelector('#settingsDlg').classList.contains('open'));
    const saved = await page.evaluate(async () => (await PR.api('/api/config')).config);
    ok(saved.selection_translation.engine === 'api' && saved.selection_translation.api.model === 'example-fast-model', '设置页可保存独立API接口');
    ok(!JSON.stringify(saved).includes('private-ui-fixture-key'), 'API密钥不返回明文');
    ok(JSON.stringify(saved.codex) === JSON.stringify(originalCfg.codex) && JSON.stringify(saved.chat) === JSON.stringify(originalCfg.chat) && saved.engine === originalCfg.engine, '保存选词API配置不改原问AI和全文翻译配置');
    await page.goto(info.url + '/read/pdf-fixture?source=pdf');
    await page.waitForFunction(() => PR.state.paper && document.querySelector('#paper .en'));
    await page.waitForTimeout(150);
    await page.evaluate(async () => {await PR.api('/api/selection-translation/config',{method:'POST',body:{engine:'codex'}});PR.emit('settings-saved',{});PR.setPref('mode','bi');});
    await page.waitForTimeout(120);
    await page.locator('#paper .en').evaluate(root => {const n=root.firstChild,r=document.createRange(),s=getSelection();r.setStart(n,0);r.setEnd(n,3);s.removeAllRanges();s.addRange(r);root.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
    await page.waitForFunction(() => PR.selectionTranslationState()?.phase === 'done');
    ok((await page.locator('.st-result').textContent()).endsWith('PDF'), 'PDF阅读器英文选区同样自动翻译');
    for (const [name, data] of Object.entries(bytes)) assert(fs.readFileSync(path.join(tmp,'library',info.id,name)).equals(data));
    ok(true, '原文快照和全部已有译文字节保持不变');
    ok(!errors.length, '浏览器没有JavaScript错误：' + errors.join('; '));
    console.log(JSON.stringify({result:'PASS',checks:checks.length,popup_ms:first.popup_ms,first_text_ms:first.first_text_ms}));
  } finally {if (browser) await browser.close(); srv.kill('SIGTERM');}
})().catch(e => {console.error(e.stack); process.exitCode=1;});
