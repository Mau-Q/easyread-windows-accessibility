// 临时文献库验证引用悬停与原有阅读操作，不调用真实模型。
const fs = require('fs'), path = require('path'), os = require('os');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'easyread-citations-'));
const checks = [], ok = (test, label) => { assert(test, label); checks.push(label); console.log('PASS', label); };
(async () => {
  const srv = spawn(path.join(root, '.venv/bin/python'), ['-m', 'tests.web_reader_server'], {
    cwd: root, env: { ...process.env, EASYREAD_HOME: tmp, EASYREAD_LIBRARY: path.join(tmp, 'library'),
      EASYREAD_CITATION_TEST: '1', EASYREAD_FOOTNOTE_TEST: '1' }
  });
  let browser;
  try {
    const info = await new Promise((resolve, reject) => {
      let buf = ''; const timer = setTimeout(() => reject(Error('服务未启动')), 15000);
      srv.stdout.on('data', d => { buf += d; if (buf.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(buf.split('\n')[0])); } });
      srv.stderr.on('data', d => process.stderr.write(d));
      srv.once('exit', code => { clearTimeout(timer); reject(Error('服务退出 ' + code)); });
    });
    const room = path.join(tmp, 'library', info.id);
    const protectedFiles = ['source.html', 'article.html', 'paper.json'].map(name => [name, fs.readFileSync(path.join(room, name))]);
    browser = process.env.EASYREAD_TEST_ENGINE === 'webkit' ? await webkit.launch({ headless: true }) :
      await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, colorScheme: 'dark' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('https://**', r => r.abort());
    const load = async id => {
      await page.goto(info.url + '/read/' + id);
      await page.waitForFunction(() => document.querySelector('#article').contentDocument?.querySelector('#easyread-citation-panel'));
      return page.frames().find(f => f.url().includes('/article.html'));
    };
    let frame = await load(info.id);
    let panel = frame.locator('#easyread-citation-panel');
    const zhou = frame.locator('#citation-test .ltx_cite a').nth(0), other = frame.locator('#citation-test .ltx_cite a').nth(1);
    const leave = () => page.mouse.move(5, 5);
    const hover = async ref => { await leave(); await ref.hover(); await panel.waitFor({ state: 'visible' }); };
    await zhou.hover(); await page.waitForTimeout(100);
    ok(!await panel.isVisible(), '鼠标短暂经过引用不立即弹出');
    await leave(); await page.waitForTimeout(350);
    ok(!await panel.isVisible(), '移出引用取消等待中的预览');
    await zhou.scrollIntoViewIfNeeded();
    const scrollBefore = await frame.evaluate(() => scrollY);
    await hover(zhou);
    ok(await frame.evaluate(() => scrollY) === scrollBefore, '悬停预览保留正文阅读位置');
    ok(await panel.locator('.ltx_bibitem').textContent() === await frame.locator('article #bib\\.zhou').textContent(), '完整展示文末条目，文字不改写');
    ok(await panel.locator('em').innerText() === 'Lima: Less is more for alignment.', '文末斜体排版保留');
    ok(await panel.locator('a[href="https://example.org/lima"]').count() === 1 && await panel.locator('a[href="#a"]').count() === 1, '原条目的外部链接和内部链接保留');
    ok(await panel.locator('[id]').count() === 0 && await frame.locator('[id="bib.zhou"]').count() === 1, '浮窗没有复制原锚点 id');
    await panel.hover(); await page.waitForTimeout(350);
    ok(await panel.isVisible(), '鼠标移入浮窗后保持显示');
    await leave(); await panel.waitFor({ state: 'hidden' });
    ok(!await panel.isVisible(), '移出浮窗后关闭');
    await hover(zhou); await hover(other);
    ok((await panel.innerText()).includes('A second reference') && !(await panel.innerText()).includes('Lima:'), '同组引用分别显示对应条目');
    await page.keyboard.press('Escape');
    ok(!await panel.isVisible(), 'Escape 关闭预览');
    await frame.locator('#citation-test a[href="#bib%2Enumeric"]').focus();
    ok((await panel.innerText()).includes('Numeric reference'), '数字引用与编码锚点支持键盘聚焦预览');
    await page.keyboard.press('Escape');
    await frame.locator('#citation-test a[href="#missing-reference"]').hover(); await page.waitForTimeout(350);
    ok(!await panel.isVisible(), '缺失文末目标不生成错误条目');
    await frame.locator('#citation-test a[href="#a"]').hover(); await page.waitForTimeout(350);
    ok(!await panel.isVisible(), '非参考文献目标不触发引用预览');
    await frame.locator('#citation-test > a').hover(); await page.waitForTimeout(350);
    ok(!await panel.isVisible(), '普通正文链接不触发引用预览');
    const zh = await frame.locator('#citation-test').getAttribute('data-easyread-id');
    await frame.locator('#easyread-zh-' + zh).hover(); await page.waitForTimeout(350);
    ok(!await panel.isVisible(), '中文译文不触发预览');
    await hover(zhou); await frame.evaluate(() => window.dispatchEvent(new Event('scroll')));
    ok(!await panel.isVisible(), '正文滚动关闭位置已变化的预览');
    await hover(zhou); await page.locator('#paperTitle').click();
    ok(!await panel.isVisible(), '点击阅读器工具栏关闭预览');
    await frame.evaluate(() => { const n = document.querySelector('#citation-test'); const range = document.createRange(); range.selectNodeContents(n); getSelection().removeAllRanges(); getSelection().addRange(range); });
    await zhou.hover(); await page.waitForTimeout(350);
    ok(!await panel.isVisible(), '选择正文时不弹出引用预览');
    await frame.evaluate(() => getSelection().removeAllRanges());
    await leave(); await hover(zhou);
    await frame.locator('#footnote1 > .ltx_note_mark').click();
    ok(!await panel.isVisible() && await frame.locator('.easyread-footnote-panel').isVisible(), '打开脚注时关闭引用预览');
    await hover(zhou);
    ok(!await frame.locator('.easyread-footnote-panel').isVisible(), '打开引用预览时关闭脚注');
    await frame.evaluate(() => { const link = document.querySelector('#citation-test .ltx_cite a'); const mark = document.createElement('mark'); mark.className = 'easyread-mark'; mark.dataset.note = 'fixture-note'; link.replaceWith(mark); mark.append(link); });
    await zhou.click();
    ok(await frame.evaluate(() => location.hash) === '#bib.zhou', '高亮中的引用点击仍跳转至文末');
    ok(!await panel.isVisible(), '点击引用跳转后关闭预览');
    await frame.locator('#citation-long a').evaluate(n => { n.style.position = 'fixed'; n.style.right = '0'; n.style.bottom = '1px'; });
    await hover(frame.locator('#citation-long a'));
    const bounds = () => panel.evaluate(n => { const b=n.getBoundingClientRect(); return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,w:innerWidth,h:innerHeight,scroll:n.scrollHeight,client:n.clientHeight}; });
    let b = await bounds();
    ok(b.left >= 0 && b.right <= b.w && b.top >= 0 && b.bottom <= b.h, '右下角长条目预览保持在视口内');
    ok(b.scroll > b.client, '长参考文献在浮窗内滚动');
    await panel.hover(); await page.mouse.wheel(0, 150); await page.waitForTimeout(100);
    ok(await panel.isVisible() && await panel.evaluate(n => n.scrollTop) > 0, '滚动浮窗内容不会关闭预览');
    await page.setViewportSize({ width: 390, height: 700 });
    ok(!await panel.isVisible(), '窗口缩放关闭旧位置的预览');
    await hover(frame.locator('#citation-long a')); b = await bounds();
    ok(b.left >= 0 && b.right <= b.w && b.top >= 0 && b.bottom <= b.h, '窄屏长条目完整留在视口内');
    await page.locator('#theme').click(); await page.locator('#readerThemePicker [data-reader-theme="original"]').click(); await hover(frame.locator('#citation-long a'));
    ok(await panel.evaluate(n => getComputedStyle(n).backgroundColor) === 'rgb(255, 255, 255)', '浮窗跟随原始配色');
    await page.locator('#theme').click(); await page.locator('#readerThemePicker [data-reader-theme="dark"]').click(); await hover(frame.locator('#citation-long a'));
    ok(await panel.evaluate(n => getComputedStyle(n).backgroundColor) === 'rgb(46, 52, 64)', '浮窗跟随深色配色');
    for (const [name, bytes] of protectedFiles) ok(fs.readFileSync(path.join(room, name)).equals(bytes), name + ' 字节不变');
    if (process.env.EASYREAD_DATAFLOW_FIXTURE) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      frame = await load('dataflow-fixture'); panel = frame.locator('#easyread-citation-panel');
      const sourceRef = frame.locator('[data-easyread-id="web-35"] a[href="#bib.bib50"]');
      await hover(sourceRef);
      ok((await panel.innerText()).includes('Lima: Less is more for alignment.'), '截图中的 Zhou 引用显示真实文末 LIMA 条目');
      if (process.env.EASYREAD_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.EASYREAD_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.EASYREAD_SCREENSHOT_DIR, 'citation-hover.png') });
      }
      await hover(frame.locator('[data-easyread-id="web-35"] a[href="#bib.bib32"]'));
      ok((await panel.innerText()).includes('Revisiting the superficial alignment hypothesis.'), '截图中的 Raghavendra 引用显示对应真实文末条目');
    }
    ok(errors.length === 0, '没有浏览器脚本错误');
    console.log('完成', checks.length, '项引用浏览器检查');
  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
})().catch(e => { console.error(e); process.exitCode = 1; });
