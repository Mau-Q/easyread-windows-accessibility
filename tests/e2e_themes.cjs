// 五种阅读配色、界面独立性与持久化；使用临时文献库，不请求真实模型。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { spawn } = require('child_process');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'easyread-themes-'));
const checks = [], ok = (test, label) => { assert(test, label); checks.push(label); console.log('PASS', label); };
const themes = [
  ['original', 'rgb(255, 255, 255)', 'rgb(0, 0, 0)', 'none'],
  ['dark', 'rgb(46, 52, 64)', 'rgb(216, 222, 233)', 'brightness(0.85)'],
  ['black', 'rgb(0, 0, 0)', 'rgb(255, 255, 255)', 'invert(1)'],
  ['snow', 'rgb(236, 239, 244)', 'rgb(59, 66, 82)', 'none'],
  ['sepia', 'rgb(244, 236, 216)', 'rgb(91, 70, 54)', 'none']
];
(async () => {
  const srv = spawn(path.join(root, '.venv/bin/python'), ['-m', 'tests.web_reader_server'], {
    cwd: root, env: { ...process.env, EASYREAD_HOME: tmp, EASYREAD_LIBRARY: path.join(tmp, 'library'),
      EASYREAD_XREF_TEST: '1', EASYREAD_CITATION_TEST: '1', EASYREAD_FOOTNOTE_TEST: '1' }
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
    const bytes = ['source.html', 'article.html', 'paper.json'].map(name => [name, fs.readFileSync(path.join(room, name))]);
    browser = process.env.EASYREAD_TEST_ENGINE === 'webkit' ? await webkit.launch({ headless: true }) :
      await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, colorScheme: 'dark' });
    const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error('PAGE ERROR', e.message); });
    const waitSaved = async id => {
      for (let n = 0; n < 80; n++) {
        if (await page.evaluate(async id => (await PR.api('/api/prefs')).reader?.readerTheme === id, id)) return;
        await page.waitForTimeout(100);
      }
      throw Error('配色未保存：' + id);
    };
    await page.route('https://**', r => r.abort());
    const load = async id => {
      await page.goto(info.url + '/read/' + id);
      await page.waitForFunction(() => document.querySelector('#article').contentDocument?.querySelector('#easyread-xref-panel') && document.querySelector('#article').contentDocument.documentElement.dataset.readerTheme);
      await page.waitForTimeout(100);
      return page.frames().find(f => f.url().includes('/article.html'));
    };
    let frame = await load(info.id);
    const fingerprint = await page.evaluate(() => PR.articleFingerprint(document.querySelector('#article').contentDocument));
    const pick = async id => { await page.locator('#theme').click(); await page.locator('#readerThemePicker [data-reader-theme="' + id + '"]').click(); };
    const colors = locator => locator.evaluate(n => ({ bg: getComputedStyle(n).backgroundColor, fg: getComputedStyle(n).color }));
    const citation = frame.locator('#citation-test .ltx_cite a').first(), fig = frame.locator('#xref-test a[href="#testfigure"]');
    const bar = await colors(page.locator('header'));
    await page.locator('#theme').click();
    ok(await page.locator('#readerThemePicker [data-reader-theme]').count() === 5, '配色面板提供全部五种主题');
    await page.keyboard.press('Escape');
    ok(!await page.locator('#readerThemePicker').isVisible() && await page.locator('#theme').getAttribute('aria-expanded') === 'false', 'Escape 关闭配色面板并更新展开状态');
    for (const [id, bg, fg, filter] of themes) {
      const before = await frame.evaluate(() => scrollY); await pick(id);
      ok(await frame.evaluate(() => scrollY) === before, id + ' 切换不改变阅读位置');
      assert.deepEqual(await colors(frame.locator('body')), { bg, fg }); ok(true, id + ' 正文背景和文字匹配 Zotero 色值');
      assert.deepEqual(await colors(page.locator('header')), bar); ok(true, id + ' 保留界面配色');
      ok(await frame.locator('#testfigure svg').evaluate(n => getComputedStyle(n).filter) === filter, id + ' 图像按主题保持、调暗或反色');
      await citation.hover(); await frame.locator('#easyread-citation-panel').waitFor({ state: 'visible' });
      assert.deepEqual(await colors(frame.locator('#easyread-citation-panel')), { bg, fg }); ok(true, id + ' 引用预览同步配色');
      await fig.hover(); await frame.locator('#easyread-xref-panel').waitFor({ state: 'visible' });
      assert.deepEqual(await colors(frame.locator('#easyread-xref-panel')), { bg, fg }); ok(true, id + ' 图表预览同步配色');
      await frame.locator('#footnote1 > .ltx_note_mark').click(); await frame.locator('#easyread-footnote-panel').waitFor({ state: 'visible' });
      assert.deepEqual(await colors(frame.locator('#easyread-footnote-panel')), { bg, fg }); ok(true, id + ' 脚注预览同步配色');
      await page.keyboard.press('Escape');
    }
    ok(fingerprint === await page.evaluate(() => PR.articleFingerprint(document.querySelector('#article').contentDocument)), '切换五种主题后原文指纹不变');
    await waitSaved('sepia');
    frame = await load(info.id);
    ok(await frame.evaluate(() => document.documentElement.dataset.readerTheme) === 'sepia', '刷新后仍为棕褐');
    await page.evaluate(() => PR.openSettings('reading')); await page.locator('#readerThemeSel').waitFor();
    await page.selectOption('#readerThemeSel', 'black'); await page.selectOption('#themeSel', 'light');
    ok(await frame.evaluate(() => document.documentElement.dataset.readerTheme) === 'black' && await page.evaluate(() => document.documentElement.dataset.theme) === 'light', '设置可独立预览阅读与界面主题');
    await page.locator('#setCancel').click();
    ok(await frame.evaluate(() => document.documentElement.dataset.readerTheme) === 'sepia' && await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', '取消设置恢复两个主题，不写入预览');
    await page.evaluate(() => PR.openSettings('reading')); await page.locator('#readerThemeSel').waitFor();
    await page.selectOption('#readerThemeSel', 'snow'); await page.keyboard.press('Escape');
    ok(await frame.evaluate(() => document.documentElement.dataset.readerTheme) === 'sepia', 'Escape 取消预览');
    await page.setViewportSize({ width: 390, height: 700 }); await page.locator('#theme').click();
    const box = await page.locator('#readerThemePicker').boundingBox();
    ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 700, '窄屏配色面板留在视口内');
    const iframeBox = await page.locator('#article').boundingBox();
    await page.mouse.click(iframeBox.x + 20, iframeBox.y + iframeBox.height - 20);
    ok(!await page.locator('#readerThemePicker').isVisible(), '点击正文关闭配色面板');
    await page.setViewportSize({ width: 1300, height: 900 });
    await page.goto(info.url + '/read/pdf-fixture'); await page.waitForSelector('#paper .zh');
    ok(await page.evaluate(() => document.documentElement.dataset.readerTheme) === 'sepia', 'PDF 阅读页继承同一配色');
    await page.locator('[data-act="settings"]').click();
    ok(await page.locator('#settings [data-reader-theme]').count() === 5, 'PDF 的 Aa 设置提供五种色块');
    for (const [id, bg, fg] of themes) {
      await page.locator('#settings [data-reader-theme="' + id + '"]').click();
      ok(await page.locator('body').evaluate(n => getComputedStyle(n).backgroundColor) === bg && (await colors(page.locator('#paper .zh'))).fg === fg, id + ' PDF 阅读正文配色正确');
    }
    await waitSaved('sepia');
    const fresh = await browser.newPage({ colorScheme: 'light' }); await fresh.goto(info.url + '/read/' + info.id);
    await fresh.waitForFunction(() => document.querySelector('#article')?.contentDocument?.documentElement?.dataset.readerTheme === 'sepia');
    ok(true, '无本地缓存的新浏览器环境从服务端恢复棕褐'); await fresh.close();
    await page.goto(info.url + '/'); await page.waitForFunction(() => PR.openSettings);
    await page.evaluate(() => PR.openSettings('reading')); await page.locator('#readerThemeSel').waitFor();
    ok(await page.locator('#readerThemeSel').inputValue() === 'sepia', '文献库的阅读设置显示已保存主题');
    await page.selectOption('#readerThemeSel', 'snow'); await page.locator('#setSave').click();
    await waitSaved('snow');
    frame = await load(info.id);
    const savedTheme = await page.evaluate(async () => ({ applied: document.querySelector('#article').contentDocument.documentElement.dataset.readerTheme, prefs: PR.prefs.readerTheme, cache: PR.ls.get('easyread-prefs', {}).readerTheme, server: (await PR.api('/api/prefs')).reader?.readerTheme }));
    ok(savedTheme.applied === 'snow', '从文献库保存的主题应用到正文：' + JSON.stringify(savedTheme));
    if (process.env.EASYREAD_TEST_SHOTS) {
      fs.mkdirSync(process.env.EASYREAD_TEST_SHOTS, { recursive: true });
      frame = await load(process.env.EASYREAD_DATAFLOW_FIXTURE ? 'dataflow-fixture' : info.id);
      await page.locator('#toggleZh').click();
      const para = frame.locator('article .ltx_p').filter({ hasText: 'This scaling law' }).first();
      if (await para.count()) await para.scrollIntoViewIfNeeded();
      for (const [id] of themes) {
        await pick(id);
        const tags = frame.locator('article a .ltx_ref_tag');
        if (await tags.count()) ok(await tags.evaluateAll(nodes => nodes.every(n => getComputedStyle(n).color === getComputedStyle(n.closest('a')).color)), id + ' 用户论文的全部交叉引用文字跟随链接色');
        await page.screenshot({ path: path.join(process.env.EASYREAD_TEST_SHOTS, 'theme-' + id + '.png') });
      }
      await page.locator('#theme').click(); await page.screenshot({ path: path.join(process.env.EASYREAD_TEST_SHOTS, 'theme-picker.png') });
    }
    for (const [name, original] of bytes) ok(fs.readFileSync(path.join(room, name)).equals(original), name + ' 字节不变');
    ok(!errors.length, '无浏览器脚本异常：' + errors.join('; '));
    console.log(JSON.stringify({ ok: true, checks: checks.length, engine: process.env.EASYREAD_TEST_ENGINE || 'chromium', tmp }));
  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
})().catch(e => { console.error(e); process.exit(1); });
