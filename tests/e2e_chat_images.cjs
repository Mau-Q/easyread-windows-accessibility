// 临时文献库验证截图粘贴、图片传输、历史与流式表格，不发送真实论文到模型。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'easyread-chat-images-'));
const checks = [], ok = (value, label) => { assert(value, label); checks.push(label); console.log('PASS', label); };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
(async () => {
  const srv = spawn(path.join(root, '.venv/bin/python'), ['-m', 'tests.web_reader_server'], {
    cwd: root, env: { ...process.env, EASYREAD_HOME: tmp, EASYREAD_LIBRARY: path.join(tmp, 'library'), EASYREAD_FORMAT_TEST: '1' }
  });
  let browser;
  try {
    const info = await new Promise((resolve, reject) => {
      let buf = ''; const timer = setTimeout(() => reject(Error('服务未启动')), 15000);
      srv.stdout.on('data', d => { buf += d; if (buf.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(buf.split('\n')[0])); } });
      srv.stderr.on('data', d => process.stderr.write(d));
      srv.once('exit', code => { clearTimeout(timer); reject(Error('服务退出 ' + code)); });
    });
    browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('https://**', r => r.abort());
    await page.goto(info.url + '/read/' + info.id); await page.click('#chatBtn'); await page.waitForSelector('#chatInput');
    const file = { name: '截图.png', mimeType: 'image/png', buffer: png };
    await page.fill('#chatInput', '用表格解释截图');
    await page.evaluate(base64 => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const data = new DataTransfer(); data.items.add(new File([bytes], '粘贴截图.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      document.querySelector('#chatInput').dispatchEvent(event);
      if (!event.defaultPrevented) throw Error('图片粘贴未处理');
    }, png.toString('base64'));
    await page.waitForSelector('.ch-compose .ch-image img');
    ok(await page.inputValue('#chatInput') === '用表格解释截图', '图片粘贴保留输入文字');
    ok(await page.locator('.ch-compose .ch-image img').evaluate(img => img.complete && img.naturalWidth === 1), '粘贴后图片预览可见');
    await page.click('[data-c="remove-image"]');
    ok(await page.locator('.ch-compose .ch-image').count() === 0, '发送前可以移除图片');
    await page.setInputFiles('#chatImageFile', [file]);
    ok(await page.locator('.ch-compose .ch-image').count() === 1, '选择文件也能添加图片');
    await page.setInputFiles('#chatImageFile', [file, file, file, file]);
    ok(await page.locator('.ch-compose .ch-image').count() === 4, '一次最多4张图片');
    for (let i = 0; i < 3; i++) await page.locator('[data-c="remove-image"]').last().click();
    // 上传失败时保留原图、文字与引用，允许继续发送。
    await page.route('**/chat-images?**', route => route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"测试上传失败"}' }));
    await page.click('[data-c="send"]'); await page.waitForSelector('#chatList .cm.ai.err');
    ok(await page.inputValue('#chatInput') === '用表格解释截图' && await page.locator('.ch-compose .ch-image').count() === 1, '上传失败保留草稿和图片');
    await page.unroute('**/chat-images?**');
    await page.click('[data-c="send"]');
    await page.waitForSelector('#chatList .md-table');
    await page.waitForSelector('#chatList [data-c="pin"]');
    const table = page.locator('#chatList .md-table');
    ok(await table.locator('th').count() === 3 && await table.locator('tbody tr').count() === 3, '流式 Markdown 显示为三列表格');
    ok(await table.locator('.katex').count() === 2, '表格中的参数公式正常渲染');
    ok((await page.locator('#chatList .cm.ai:last-child .body').innerText()).includes('表格后的说明'), '表格后的正文完整保留');
    const room = path.join(tmp, 'library', info.id), saved = JSON.parse(fs.readFileSync(path.join(room, 'chat.json')));
    const user = saved.threads[0].messages.find(m => m.role === 'user'), paths = JSON.parse(fs.readFileSync(path.join(room, 'last-images.json')));
    ok(paths.length === 1 && fs.readFileSync(paths[0]).equals(png), '后台模型收到未经压缩的原始图片');
    ok(user.images.length === 1 && user.images[0].mime === 'image/png' && user.images[0].width === 1, '历史记录保存可校验的图片附件');
    const returned = await page.request.get(info.url + user.images[0].url);
    ok(returned.status() === 200 && (await returned.body()).equals(png), '历史图片地址返回相同原始字节');
    await page.reload(); await page.click('#chatBtn'); await page.click('[data-c="list"]'); await page.locator('.ch-thread[data-t]').first().click();
    await page.waitForSelector('#chatList .cm.user .ch-image img');
    await page.waitForFunction(() => document.querySelector('#chatList .cm.user .ch-image img')?.naturalWidth === 1);
    ok(await page.locator('#chatList .cm.user .ch-image img').evaluate(img => img.complete && img.naturalWidth === 1), '重开对话仍可查看附件');
    ok(await page.locator('#chatList .md-table tbody tr').count() === 3, '历史回答同样显示表格');
    await page.setViewportSize({ width: 390, height: 700 });
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '窄屏表格与附件不撑破阅读器');
    // 真实论文和既有标记在临时副本上验证。
    if (process.env.EASYREAD_DATAFLOW_FIXTURE) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(info.url + '/read/dataflow-fixture');
      await page.waitForFunction(() => document.querySelector('#article').contentDocument?.querySelector('mark.easyread-mark'));
      const frame = page.frames().find(f => f.url().includes('/article.html'));
      ok(await frame.locator('[data-easyread-id="web-24"] mark.easyread-mark').count() === 1, '截图中跨公式的整句高亮连续包裹');
      ok(await frame.locator('[data-easyread-id="web-24"] mark.easyread-mark math').count() === 2, '高亮覆盖完整公式且公式结构保留');
      const appearance = await frame.locator('[data-easyread-id="web-20"] mark.easyread-mark').first().evaluate(mark => ({ bg:getComputedStyle(mark).backgroundColor, citation:getComputedStyle(mark.querySelector('a')).backgroundColor, fg:getComputedStyle(mark).color, link:getComputedStyle(mark.querySelector('a')).color }));
      ok(appearance.bg.endsWith('0.17)') && appearance.citation === 'rgba(0, 0, 0, 0)' && appearance.link === appearance.fg, '暗色高亮变淡且引用不叠加蓝色背景');
      await page.click('#chatBtn'); await page.click('[data-c="list"]');
      const titles = await page.locator('.ch-thread[data-t]').allInnerTexts();
      let found = false;
      for (let i = 0; i < titles.length; i++) {
        await page.locator('.ch-thread[data-t]').nth(i).click();
        if (await page.locator('#chatList .md-table').count()) { found = true; break; }
        await page.click('[data-c="list"]');
      }
      ok(found, '用户已有 AI 回答里的 Markdown 表格恢复渲染');
      if (process.env.EASYREAD_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.EASYREAD_SCREENSHOT_DIR, { recursive: true });
        await page.locator('#chatList .md-table').first().scrollIntoViewIfNeeded();
        await page.locator('#chatpanel').screenshot({ path: path.join(process.env.EASYREAD_SCREENSHOT_DIR, 'ai-table.png') });
        await frame.locator('[data-easyread-id="web-24"]').screenshot({ path: path.join(process.env.EASYREAD_SCREENSHOT_DIR, 'highlight-math.png') });
      }
    }
    ok(errors.length === 0, '没有浏览器脚本错误');
    console.log('完成', checks.length, '项表格与图片浏览器检查');
  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); fs.rmSync(tmp, {recursive:true,force:true}); }
})().catch(e => { console.error(e); process.exitCode = 1; });
