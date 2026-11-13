// 临时库验证双语选区、持久化、问答、断线补存与 PDF 回归；模型由测试服务替代。
// NODE_PATH=/path/to/bundled/node_modules node tests/e2e_web.cjs
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'easyread-web-test-'));
const PY = process.env.EASYREAD_TEST_PYTHON || path.join(ROOT, '.venv', 'bin', 'python');
const checks = [];
const ok = (test, label) => { assert(test, label); checks.push(label); console.log('PASS', label); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 80; i++) { if (await fn()) return; await delay(100); } throw new Error('等待验证超时'); }

(async () => {
  const srv = spawn(PY, ['-m', 'tests.web_reader_server'], { cwd: ROOT, env: { ...process.env, EASYREAD_HOME: TMP, EASYREAD_LIBRARY: path.join(TMP, 'library') } });
  let browser;
  try {
    const info = await new Promise((resolve, reject) => {
      let buf = ''; const timer = setTimeout(() => reject(new Error('测试服务未启动')), 15000);
      srv.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(buf.split('\n')[0])); } });
      srv.stderr.on('data', (d) => process.stderr.write(d));
      srv.once('exit', (code) => { clearTimeout(timer); reject(new Error('测试服务退出 ' + code)); });
    });
    const { url, id } = info;
    const room = path.join(TMP, 'library', id);
    const disk = (name = 'reader') => JSON.parse(fs.readFileSync(path.join(room, name + '.json'), 'utf8'));
    const source = fs.readFileSync(path.join(room, 'article.html'));
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, executablePath: process.env.EASYREAD_TEST_BROWSER || (fs.existsSync(chrome) ? chrome : undefined) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
    const errors = [], cspBlocked = [];
    let navigationStartedAt = -Infinity;
    page.on('request', r => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigationStartedAt = Date.now(); });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const outgoingPoll = m.text().match(/\/api\/p\/([^/]+)\/versions due to access control checks\./);
      // WebKit logs a cancelled fetch when an old document's poll is still in
      // flight during navigation. Errors in the current reader still fail.
      if (outgoingPoll && (Date.now() - navigationStartedAt < 1000 || !new URL(page.url()).pathname.endsWith('/read/' + outgoingPoll[1]))) return;
      if (/script-src/.test(m.text())) cspBlocked.push(m.text());
      else if (!/Failed to load resource|ERR_BLOCKED_BY_CLIENT/.test(m.text())) errors.push(m.text());
    });
    await page.route('https://**', (r) => r.abort()); // 原文 CSS/图片不影响本机交互验证。
    let frame;
    async function load() {
      navigationStartedAt = Date.now();
      await page.goto(url + '/read/' + id);
      await page.waitForFunction(() => PR.state.paper && document.querySelector('#article').contentDocument?.querySelector('.easyread-zh'));
      frame = page.frames().find((f) => f.url().includes('/article.html'));
    }
    const notes = () => Object.values(disk().notes || {}).filter((n) => !n.deleted);
    async function select(selector, quote, last = false) {
      await frame.locator(selector).scrollIntoViewIfNeeded();
      await frame.evaluate(({ selector, quote, last }) => {
        const root = document.querySelector(selector), w = document.createTreeWalker(root, 4), nodes = [];
        for (let n; (n = w.nextNode());) if (!n.parentElement.closest('math, annotation, .katex')) nodes.push(n);
        const text = nodes.map((n) => n.data).join(''), start = last ? text.lastIndexOf(quote) : text.indexOf(quote);
        if (start < 0) throw new Error('未找到选句 ' + quote);
        let pos = 0; const range = document.createRange();
        for (const n of nodes) { if (start >= pos && start < pos + n.length) range.setStart(n, start - pos); if (start + quote.length > pos && start + quote.length <= pos + n.length) range.setEnd(n, start + quote.length - pos); pos += n.length; }
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }, { selector, quote, last });
      await page.waitForSelector('#selbar.open');
    }
    const saved = async () => { await page.waitForFunction(() => PR.store.pending === 0 && PR.store.status === 'saved'); };
    await load();
    const articleResponse = await page.request.get(url + '/p/' + id + '/article.html');
    ok(articleResponse.headers()['content-security-policy'].includes("script-src 'none'"), '网页正文以 CSP 禁止快照执行脚本');
    await frame.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__easyread_untrusted_probe = true'; document.body.appendChild(s); });
    ok(await frame.evaluate(() => window.__easyread_untrusted_probe) === undefined && cspBlocked.length > 0, '放行阅读器事件后，正文内注入脚本仍被阻止');
    const en = '[data-easyread-id="web-3"]', zh = '#easyread-zh-web-3';
    const math = await frame.locator(en + ' math').evaluate((n) => n.outerHTML);
    await select(en, 'may improve accuracy');
    await page.click('#selbar [data-color="yellow"]'); await saved();
    ok(notes()[0].key === 'en' && notes()[0].quote === 'may improve accuracy', '英文跨行内元素的选区保存到 reader.json');
    await select(zh, '准确率');
    await page.click('#selbar [data-pen="underline"]');
    await page.click('#selbar [data-color="blue"]'); await saved();
    ok(notes().some((n) => n.key === 'zh' && n.style === 'underline' && n.color === 'blue'), '中文四色下划线与英文独立保存');
    await select('[data-easyread-id="web-7"]', 'Same phrase.', true);
    await page.click('#selbar [data-color="green"]'); await saved();
    const repeated = notes().find((n) => n.quote === 'Same phrase.');
    ok(repeated.start > 10, '重复原话保存准确位置');
    await load();
    ok(await frame.locator('mark.easyread-mark').count() >= 4, '刷新恢复中英文高亮和下划线');
    ok(await frame.locator(en + ' math').evaluate((n) => n.outerHTML) === math, '数学 DOM 未被划线修改');
    ok(fs.readFileSync(path.join(room, 'article.html')).equals(source), '论文 HTML 快照字节不变');
    const repeatedText = await frame.locator('[data-easyread-id="web-7"]').evaluate((n) => n.innerHTML);
    ok(repeatedText.indexOf('Again:') < repeatedText.indexOf('<mark'), '刷新仍标记第二个重复句子');
    ok(await page.evaluate(() => {
      const doc = document.querySelector('#article').contentDocument;
      const mark = doc.querySelector('mark.easyread-mark'), pin = doc.querySelector('.easyread-note-pin'), index = PR.blockById;
      PR.indexArticle(); PR.noteSurface.render();
      return mark === doc.querySelector('mark.easyread-mark') && pin === doc.querySelector('.easyread-note-pin') && index === PR.blockById;
    }), '未变内容刷新保留索引、高亮及笔记标记节点');
    const markIdentity = await frame.evaluateHandle(() => document.querySelector('mark.easyread-mark'));
    await page.click('#toggleZh'); await page.click('#toggleZh');
    ok(await frame.evaluate(mark => mark.isConnected && document.querySelector('mark.easyread-mark') === mark, markIdentity), '中英切换不重建已有高亮');
    await markIdentity.dispose();
    const paperBeforeRefresh = disk('paper');
    const translatedNote = notes().find(n => n.key === 'zh');
    const updatePaper = async paper => {
      fs.writeFileSync(path.join(room, 'paper.json'), JSON.stringify(paper));
      await page.evaluate(() => PR.poll());
    };
    const changedPaper = JSON.parse(JSON.stringify(paperBeforeRefresh));
    changedPaper.blocks.find(b => b.id === translatedNote.anchor).zh = '更新后的译文，原选句暂时不存在。';
    await updatePaper(changedPaper);
    ok(await page.evaluate(id => PR.quoteLost(id), translatedNote.id), '译文更新使旧引文失配，缓存不保留错误高亮');
    await updatePaper(paperBeforeRefresh);
    ok(!await page.evaluate(id => PR.quoteLost(id), translatedNote.id) && await frame.locator('mark[data-note="' + translatedNote.id + '"]').count() > 0, '恢复原译文后重新核对并恢复原批注');
    const englishNote = notes().find(n => n.key === 'en');
    const changedIdentity = JSON.parse(JSON.stringify(paperBeforeRefresh));
    changedIdentity.blocks.find(b => b.id === englishNote.anchor).source_hash = 'different-source-identity';
    await updatePaper(changedIdentity);
    ok(await page.evaluate(id => PR.quoteLost(id), englishNote.id), '原文身份变化仍停用旧高亮，缓存不绕过身份验证');
    await updatePaper(paperBeforeRefresh);
    ok(!await page.evaluate(id => PR.quoteLost(id), englishNote.id), '恢复原文身份后原批注恢复');
    await page.click('#toggleZh'); await page.click('#notesBtn');
    const chineseNote = notes().find((n) => n.key === 'zh');
    await page.locator('#notespanel .card[data-note="' + chineseNote.id + '"] .quote').click();
    ok(await frame.locator(zh).isVisible(), '从笔记定位中文划线时，自动显示隐藏的中文');
    await frame.locator('mark[data-note="' + notes()[0].id + '"]').first().click();
    await page.locator('#notespanel .card.editing textarea').fill('我的理解：准确率有前提。');
    await page.click('#chatBtn'); await saved(); // 在 debounce 前切换面板也不能丢笔记。
    ok(notes().some((n) => n.body === '我的理解：准确率有前提。'), '点划线编辑，快速切换侧栏仍保存笔记');
    await page.click('#notesBtn');
    await page.click('#notespanel [data-np="paper"]');
    await page.fill('#paperNote', '整篇论文笔记。');
    await page.click('#notespanel [data-np="notes"]'); await saved();
    ok(disk().paper_note.body === '整篇论文笔记。', '整篇笔记切换标签时自动保存');
    ok(!(await page.locator('#notespanel').innerText()).includes('undefined 页'), '网页笔记按章节显示，不编造 PDF 页码');
    await page.click('#chatBtn');
    await select(en, 'may improve accuracy'); await page.click('#selbar [data-s="chat"]');
    await select('[data-easyread-id="web-4"]', 'Do not omit this sentence.'); await page.click('#selbar [data-s="chat"]');
    await page.fill('#chatInput', '解释我标黄的句子以及这两段之间的关系。');
    await page.click('#chatpanel [data-c="send"]');
    await page.waitForSelector('#chatList [data-c="pin"]');
    const convo = disk('chat').threads[0];
    ok(convo.messages[0].refs.length === 2, 'AI 问答发送多个网页原文引用');
    const prompt = fs.readFileSync(path.join(room, 'last-prompt.txt'), 'utf8');
    ok(prompt.includes('原文：') && prompt.includes('Do not omit this sentence.') && prompt.includes('我的理解：准确率有前提。'), '模型上下文包含原文、已有中文和所问颜色的笔记');
    await page.click('#chatList [data-c="pin"]');
    await until(() => (disk('discussion').entries || []).some((e) => e.body.includes('本机测试回答')));
    await page.click('#notesBtn'); await page.evaluate(() => PR.poll());
    try { await page.waitForFunction(() => document.querySelector('#notespanel').textContent.includes('本机测试回答'), null, { timeout: 6000 }); }
    catch (e) { console.log('PIN DIAGNOSTIC', await page.evaluate(() => ({ side: PR.side, discussion: PR.state.discussion, text: document.querySelector('#notespanel').innerText, focused: document.activeElement.outerHTML.slice(0, 300) }))); throw e; }
    ok(true, 'AI 回答可保存到笔记');
    await load(); await page.click('#chatBtn');
    await page.click('#chatpanel [data-c="list"]');
    await page.click('#chatpanel .ch-thread[data-t]');
    ok((await page.locator('#chatpanel').innerText()).includes('本机测试回答'), '刷新后保留问答历史');
    // 阅读位置改变后，问答的自动上下文也跟着变化。
    await page.click('#chatpanel [data-c="new"]');
    await frame.locator('[data-easyread-id="web-4"]').click();
    await page.waitForFunction(() => document.querySelector('.chip-ctx.auto')?.title.includes('web-4'));
    ok(true, 'iframe 当前段落变化会更新问答上下文');
    // 断线队列刷新恢复后补存。
    await page.route('**/ops', (r) => r.abort());
    await select(zh, '第二句用于笔记'); await page.click('#selbar [data-color="pink"]');
    await page.waitForFunction(() => PR.store.status === 'offline');
    ok(await page.evaluate(() => PR.store.pending > 0), '断线时划线留在本地保存队列');
    await page.unroute('**/ops');
    await page.evaluate(() => PR.flush()); await saved();
    ok(notes().some((n) => n.color === 'pink'), '恢复服务后补存划线');
    const remove = notes().find((n) => n.quote === '第二句用于笔记');
    await page.evaluate((nid) => PR.commit({ op: 'note_del', id: nid }), remove.id); await saved();
    ok(await frame.locator('mark[data-note="' + remove.id + '"]').count() === 0, '删除标记会同步移除正文划线');
    await page.click('#notesBtn'); await page.click('#notespanel [data-np-act="md"]');
    await page.check('[data-exp="chat"]');
    const downloadPromise = page.waitForEvent('download'); await page.click('[data-exp-go]');
    const download = await downloadPromise, exportPath = path.join(TMP, 'notes.md'); await download.saveAs(exportPath);
    const markdown = fs.readFileSync(exportPath, 'utf8');
    ok(markdown.includes('整篇论文笔记。') && markdown.includes('本机测试回答') && markdown.includes('## 问 AI 的对话'), 'Markdown 导出包含论文笔记、批注和对话记录');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#chatBtn');
    const box = await page.locator('#chatpanel').boundingBox();
    ok(box.x >= 0 && box.x + box.width <= 391, '窄屏问答侧栏不超出视口');
    await page.locator('#chatpanel [data-c="close"]').click();
    await page.click('#theme');
    await page.locator('#readerThemePicker [data-reader-theme="dark"]').click();
    ok(await frame.evaluate(() => document.documentElement.dataset.theme) === 'dark', '深色主题同步到双语正文');
    if (process.env.EASYREAD_TEST_SHOTS) {
      fs.mkdirSync(process.env.EASYREAD_TEST_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.EASYREAD_TEST_SHOTS, 'web-mobile.png') });
      await page.setViewportSize({ width: 1440, height: 1000 }); await page.click('#notesBtn');
      await page.screenshot({ path: path.join(process.env.EASYREAD_TEST_SHOTS, 'web-notes.png') });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    navigationStartedAt = Date.now();
    await page.goto(url + '/read/pdf-fixture'); await page.waitForSelector('#paper .zh');
    await page.click('[data-act="notes"]');
    await page.click('#notespanel [data-np="notes"]');
    await page.evaluate(() => PR.setCurrent('p1-1', { bar: false }));
    await page.click('#notespanel [data-np-act="add"]');
    await page.fill('#notespanel .card.editing textarea', 'PDF 笔记回归通过');
    await page.locator('#notespanel .card.editing textarea').press('Escape'); await saved();
    const pdfReader = JSON.parse(fs.readFileSync(path.join(TMP, 'library/pdf-fixture/reader.json'), 'utf8'));
    ok(Object.values(pdfReader.notes).some((n) => n.body === 'PDF 笔记回归通过'), 'PDF 原有笔记模块仍能保存');
    ok(errors.length === 0, '网页与 PDF 交互没有 JavaScript 异常：' + errors.join('; '));
    console.log(JSON.stringify({ checks: checks.length, result: 'PASS', temporaryLibrary: TMP }));
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM');
    if (!process.env.EASYREAD_TEST_KEEP) fs.rmSync(TMP, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
