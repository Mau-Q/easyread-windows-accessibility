// 临时文献库验证原文图表/公式预览与 HTML 返回位置，不调用真实模型。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { spawn } = require('child_process');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'easyread-xrefs-'));
const checks = [], ok = (test, label) => { assert(test, label); checks.push(label); console.log('PASS', label); };
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
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('https://**', r => r.abort());
    async function load(id = info.id) {
      await page.goto(info.url + '/read/' + id);
      await page.waitForFunction(() => document.querySelector('#article').contentDocument?.querySelector('#easyread-xref-panel') && document.querySelector('#articleJumpBack'));
      await page.waitForTimeout(200);
      return page.frames().find(f => f.url().includes('/article.html'));
    }
    let frame = await load(), panel = frame.locator('#easyread-xref-panel');
    const fig = frame.locator('#xref-test a[href="#testfigure"]'), table = frame.locator('#xref-test a[href="#test%2Etable"]'), eq = frame.locator('#xref-test a[href="#eq.row"]');
    const back = page.locator('#articleJumpBack');
    const leave = () => page.mouse.move(5, 5);
    const hover = async ref => { await leave(); await ref.hover(); await panel.waitFor({ state: 'visible' }); };
    const position = () => frame.locator('#xref-test').evaluate(n => ({ y: scrollY, top: n.getBoundingClientRect().top }));
    const closeEnough = (a, b) => Math.abs(a.top - b.top) < 3;
    await fig.hover(); await page.waitForTimeout(100);
    ok(!await panel.isVisible(), '图表短暂经过不弹出');
    await leave(); await page.waitForTimeout(350);
    ok(!await panel.isVisible(), '移出取消图表等待中的预览');
    await fig.scrollIntoViewIfNeeded(); const start = await position();
    const fingerprint = await page.evaluate(() => PR.articleFingerprint(document.querySelector('#article').contentDocument));
    await hover(fig);
    ok(closeEnough(start, await position()), '悬停图表不改变阅读位置');
    ok((await panel.innerText()).includes('Original diagram and its caption.'), '图形和原图注一起显示');
    ok(await panel.locator('svg').count() === 1 && await panel.locator('.easyread-zh,.easyread-visual-controls,.easyread-note-pin,mark.easyread-mark').count() === 0, '原文预览排除译文、查看控件和笔记标记');
    const svg = await panel.locator('svg').evaluate(n => ({ id: n.id, clip: n.querySelector('clipPath').id, attr: n.querySelector('[clip-path]').getAttribute('clip-path'), use: n.querySelector('use').getAttribute('href'), shape: n.querySelector('defs g').id }));
    ok(svg.attr === 'url(#' + svg.clip + ')' && svg.use === '#' + svg.shape && svg.id !== 'testfigure.graphic', 'SVG 内部引用重映射，原图锚点不重复');
    ok((await panel.locator('.quoted-clip').getAttribute('style')).includes('url(#' + svg.clip + ')') && (await panel.locator('svg style').textContent()).includes('url(#' + svg.clip + ')'), 'SVG 样式中的带引号引用也保持有效');
    ok(await frame.locator('[id="testfigure"]').count() === 1 && await frame.locator('[id="testfigure.graphic"]').count() === 1, '原正文图表 id 保持唯一');
    await panel.hover(); await page.waitForTimeout(350); ok(await panel.isVisible(), '鼠标进入图表浮窗保持显示');
    await leave(); await panel.waitFor({ state: 'hidden' });
    await hover(table);
    ok(await panel.locator('table').count() === 1 && (await panel.innerText()).includes('Baseline') && (await panel.innerText()).includes('95'), '表格预览保留原行列与数值');
    await hover(eq);
    ok(await panel.locator('math').count() === 1 && (await panel.innerText()).includes('Continuation of the derivation.'), '公式行锚点展示完整多行公式与 MathML');
    await hover(frame.locator('#xref-test a[href="#testfigure.graphic"]'));
    ok(await panel.locator('figcaption').count() === 1, '图中元素锚点解析到完整图表');
    await page.keyboard.press('Escape'); ok(!await panel.isVisible(), '父页面 Escape 关闭图表预览');
    await eq.focus(); ok(await panel.isVisible(), '键盘聚焦公式可预览');
    await eq.press('Escape'); ok(!await panel.isVisible(), '论文内 Escape 关闭公式预览');
    for (const selector of ['a[href="#farappendix"]', 'a[href="#absent-figure"]', 'a[href^="https:"]']) {
      await leave(); await frame.locator('#xref-test ' + selector).hover(); await page.waitForTimeout(350);
      ok(!await panel.isVisible(), '不预览普通章节、缺失目标或外部链接：' + selector);
    }
    await hover(fig); await frame.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('#xref-test')); getSelection().removeAllRanges(); getSelection().addRange(range); });
    await page.waitForTimeout(50); ok(!await panel.isVisible(), '选中文字时关闭图表预览');
    await frame.evaluate(() => getSelection().removeAllRanges());
    await hover(fig); await frame.evaluate(() => window.dispatchEvent(new Event('scroll')));
    ok(!await panel.isVisible(), '正文滚动关闭图表预览');
    await hover(fig); await page.locator('#paperTitle').click(); ok(!await panel.isVisible(), '点击工具栏关闭图表预览');
    await hover(fig); await frame.locator('#citation-test .ltx_cite a').first().hover();
    await frame.locator('#easyread-citation-panel').waitFor({ state: 'visible' });
    ok(!await panel.isVisible(), '引用预览关闭图表预览');
    await hover(fig); ok(!await frame.locator('#easyread-citation-panel').isVisible(), '图表预览关闭引用预览');
    await frame.locator('#footnote1 > .ltx_note_mark').click();
    ok(!await panel.isVisible() && await frame.locator('#easyread-footnote-panel').isVisible(), '脚注与图表预览互斥');
    await hover(fig); ok(!await frame.locator('#easyread-footnote-panel').isVisible(), '图表预览关闭脚注');
    await leave(); await panel.waitFor({ state: 'hidden' });
    ok(fingerprint === await page.evaluate(() => PR.articleFingerprint(document.querySelector('#article').contentDocument)), '预览前后原文 DOM 内容指纹不变');
    // 原链接保持默认导航，返回恢复到跳转前的屏幕偏移。
    await fig.scrollIntoViewIfNeeded(); const beforeJump = await position();
    await fig.click();
    ok(await frame.evaluate(() => location.hash) === '#testfigure' && await back.isVisible(), '点击原图链接正常跳转并提供返回');
    await back.click(); ok(closeEnough(beforeJump, await position()) && !await back.isVisible(), '返回精确恢复原段落屏幕位置');
    await frame.locator('#xref-near a').click(); ok(!await back.isVisible(), '同屏跳转不堆积返回记录');
    await fig.scrollIntoViewIfNeeded(); const multiStart = await position();
    await fig.click(); await frame.locator('#after-figure a').click();
    ok((await back.innerText()).includes('（2）'), '连续远跳保留两层返回记录');
    await page.evaluate(() => { const input = document.createElement('textarea'); input.id = 'keyboard-fixture'; input.value = 'Editable text'; document.body.append(input); input.focus(); });
    await page.keyboard.press('Alt+ArrowLeft');
    ok((await back.innerText()).includes('（2）'), '输入笔记时 Alt 加左箭头不抢占文字编辑');
    await page.locator('#keyboard-fixture').evaluate(n => n.remove());
    await back.click(); ok(await frame.evaluate(() => location.hash) === '#testfigure' && await back.isVisible(), '第一次返回回到中间跳转位置');
    await page.keyboard.press('Alt+ArrowLeft'); ok(closeEnough(multiStart, await position()) && !await back.isVisible(), 'Alt 加左箭头逐次返回最初位置');
    // 经过划线的图表链接仍导航，不打开笔记编辑器。
    await fig.evaluate(n => { const mark = document.createElement('mark'); mark.className = 'easyread-mark'; mark.dataset.note = 'fixture-note'; n.replaceWith(mark); mark.append(n); });
    const markedStart = await position(); await fig.click();
    ok(await back.isVisible() && await frame.evaluate(() => location.hash) === '#testfigure', '划线中的图表引用继续执行跳转');
    await back.click(); ok(closeEnough(markedStart, await position()), '划线链接跳转后仍能返回');
    const appendixAnchor = await frame.locator('#appendix-body').getAttribute('data-easyread-id');
    const programStart = await position(); await page.evaluate(id => PR.jumpTo(id), appendixAnchor); await page.waitForTimeout(800);
    ok(await back.isVisible(), '笔记定位使用的段落跳转也记住来源');
    await back.click(); ok(closeEnough(programStart, await position()), '段落跳转返回原阅读位置');
    // 改变排版后使用原段落偏移恢复，而不是过期的绝对 scrollY。
    await fig.scrollIntoViewIfNeeded();
    const resizeStart = await position(); await fig.click(); await page.setViewportSize({ width: 900, height: 900 }); await page.waitForTimeout(200);
    await back.click(); const resizeEnd = await position();
    assert(closeEnough(resizeStart, resizeEnd), '窗口宽度改变后按原段落偏移返回 ' + JSON.stringify({ resizeStart, resizeEnd }));
    ok(true, '窗口宽度改变后按原段落偏移返回');
    await fig.click(); await page.locator('#jumpAbstract').click();
    ok(await back.isVisible(), '工具栏跳到摘要纳入返回栈');
    await page.setViewportSize({ width: 390, height: 700 }); await hover(eq);
    const b = await panel.evaluate(n => { const r = n.getBoundingClientRect(); return { l:r.left, r:r.right, t:r.top, b:r.bottom, w:innerWidth, h:innerHeight }; });
    ok(b.l >= 0 && b.r <= b.w && b.t >= 0 && b.b <= b.h, '窄屏公式预览留在视口内');
    await page.locator('#theme').click(); await page.locator('#readerThemePicker [data-reader-theme="original"]').click(); await hover(eq);
    ok(await panel.evaluate(n => getComputedStyle(n).backgroundColor) === 'rgb(255, 255, 255)', '图表公式浮窗跟随原始配色');
    for (const [name, original] of bytes) ok(fs.readFileSync(path.join(room, name)).equals(original), name + ' 字节不变');
    await load(); ok(await page.locator('#articleJumpBack').count() === 1 && !await back.isVisible(), '重载不会重复添加返回按钮或继承旧栈');
    if (process.env.EASYREAD_DATAFLOW_FIXTURE) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      frame = await load('dataflow-fixture'); panel = frame.locator('#easyread-xref-panel');
      await hover(frame.locator('article a[href="#S3.E3"]').first());
      ok(await panel.locator('math').count() > 0, '用户论文 Equation 3 显示原公式');
      await hover(frame.locator('article a[href="#S4.T1"]').first());
      ok(await panel.locator('table.ltx_tabular').count() === 1, '用户论文 Table 1 显示原表');
      if (process.env.EASYREAD_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.EASYREAD_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.EASYREAD_SCREENSHOT_DIR, 'table-hover.png') });
        await hover(frame.locator('article a[href="#S3.E3"]').first());
        await page.screenshot({ path: path.join(process.env.EASYREAD_SCREENSHOT_DIR, 'equation-hover.png') });
      }
    }
    ok(errors.length === 0, '没有浏览器脚本错误');
    console.log('完成', checks.length, '项图表和返回位置检查');
  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
})().catch(e => { console.error(e); process.exitCode = 1; });
