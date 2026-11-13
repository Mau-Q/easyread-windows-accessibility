// 本机假模型和临时库验证脚注，不调用外部 API 或修改用户文献。
const fs = require('fs'), path = require('path'), os = require('os');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'easyread-footnotes-'));
const checks = [];
const ok = (test, label) => { assert(test, label); checks.push(label); console.log('PASS', label); };
(async () => {
  const srv = spawn(path.join(root, '.venv/bin/python'), ['-m', 'tests.web_reader_server'], {
    cwd: root, env: { ...process.env, EASYREAD_HOME: tmp, EASYREAD_LIBRARY: path.join(tmp, 'library'), EASYREAD_FOOTNOTE_TEST: '1' }
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
    browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, colorScheme: 'dark' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('https://**', r => r.abort());
    async function load(id) {
      await page.goto(info.url + '/read/' + id);
      await page.waitForFunction(() => document.querySelector('#article').contentDocument?.querySelector('.easyread-footnote-ref'));
      return page.frames().find(f => f.url().includes('/article.html'));
    }
    let frame = await load(info.id);
    const zhFor = async nodeId => '#easyread-zh-' + await frame.locator('#' + nodeId).getAttribute('data-easyread-id');
    const tail = await zhFor('footnote-tail'), url = await zhFor('footnote-url'), middle = await zhFor('footnote-middle');
    ok(await frame.locator(tail).innerText() === '验证领域1：', '旧说明脚注从正文拆出，保留冒号和单个上标');
    ok(await frame.locator(url).innerText() === '数据集44：正文4096。', 'URL 脚注精确拆出，保留名称尾数4和正文数字4096');
    ok(await frame.locator(middle).innerText() === '前文2后文。', '新脚注边界支持段落中间的说明');
    ok(!await frame.locator('.ltx_note_outer').first().isVisible(), '原站隐藏脚注不挤入正文');
    await frame.locator(tail + ' button').click();
    const panel = frame.locator('.easyread-footnote-panel');
    ok(await panel.isVisible() && (await panel.innerText()).includes('Equal weights.') && (await panel.innerText()).includes('相同权重。见摘要。'), '中文上标展开原文与已有中文脚注');
    ok(!/11 1|111/.test(await panel.innerText()), '脚注面板移除重复标签');
    ok(await panel.locator('a[href="#a"]').count() === 1, '脚注中的原文引用链接保留');
    await frame.locator(tail + ' button').press('Escape');
    ok(!await panel.isVisible(), 'Escape 关闭脚注');
    await frame.locator('#footnote1 > .ltx_note_mark').click();
    ok(await panel.isVisible() && (await panel.innerText()).includes('相同权重'), '英文上标打开同一双语脚注');
    await panel.locator('button').click();
    await frame.locator(middle + ' button').focus();
    await frame.locator(middle + ' button').press('Enter');
    ok(await panel.isVisible() && (await panel.innerText()).includes('中间的脚注'), '键盘 Enter 可打开脚注');
    await frame.locator(middle + ' button').press('Escape');
    await frame.locator('#footnote-tail').click();
    ok(!await panel.isVisible(), '点击正文关闭脚注');
    await frame.locator(tail + ' button').click();
    await frame.evaluate(() => window.dispatchEvent(new Event('scroll')));
    ok(!await panel.isVisible(), '滚动关闭定位过期的脚注面板');
    await page.setViewportSize({ width: 390, height: 700 });
    await frame.locator(tail + ' button').click();
    const bounds = await panel.evaluate(n => { const b = n.getBoundingClientRect(); return { left:b.left, right:b.right, top:b.top, bottom:b.bottom, w:innerWidth, h:innerHeight }; });
    ok(bounds.left >= 0 && bounds.right <= bounds.w && bounds.top >= 0 && bounds.bottom <= bounds.h, '窄屏脚注面板留在视口内');
    for (const [name, bytes] of protectedFiles) ok(fs.readFileSync(path.join(room, name)).equals(bytes), name + ' 字节不变');
    if (process.env.EASYREAD_DATAFLOW_FIXTURE) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      frame = await load('dataflow-fixture');
      ok(await frame.locator('.ltx_note > .easyread-footnote-ref').count() === 10, '用户论文的10个英文脚注均可展开');
      ok(await frame.locator('.easyread-zh .easyread-footnote-ref').count() === 10, '用户论文的10个中文脚注均分离');
      const source = JSON.parse(fs.readFileSync(path.join(tmp, 'library/dataflow-fixture/paper.json'), 'utf8'));
      const model = source.blocks.find(b => b.source_text.startsWith('The model parameters'));
      const body = await frame.locator('#easyread-zh-' + model.id).innerText();
      ok(!body.includes('我们计算所有领域') && !body.includes('11 1') && body.endsWith('：'), '截图段落中的脚注译文完整拆出');
      await frame.locator('#easyread-zh-' + model.id + ' button').click();
      ok((await frame.locator('.easyread-footnote-panel').innerText()).includes('第 5.4 节'), '中文脚注内容和章节号完整保留');
    }
    ok(errors.length === 0, '没有浏览器脚本错误');
    console.log('完成', checks.length, '项脚注浏览器检查');
  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
})().catch(e => { console.error(e); process.exitCode = 1; });
