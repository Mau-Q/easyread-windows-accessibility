// Native WebView2 when EASYREAD_CDP is set; otherwise a Windows Edge browser.
// Run only against an isolated EASYREAD_HOME with the synthetic sample.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const native = !!process.env.EASYREAD_CDP;
  const browser = native ? await chromium.connectOverCDP(process.env.EASYREAD_CDP) : await chromium.launch({channel:'msedge',headless:true});
  const page = native ? browser.contexts()[0].pages()[0] : await browser.newPage();
  const evidence = process.env.EASYREAD_EVIDENCE || 'test-results/windows-accessibility';
  fs.mkdirSync(evidence,{recursive:true});
  const results = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const record = (feature, actual) => { results.push({feature,actual,scope:native?'native WebView2 via CDP':'Edge browser',status:'TOOL_OBSERVED'}); console.log(feature,actual); };
  const settle = () => page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  try {
    if(native) {await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//,{timeout:30000});assert.match(page.url(),/^http:\/\/127\.0\.0\.1:\d+\//,'Native startup must navigate to its own service');}
    else await page.goto(process.env.EASYREAD_URL || 'http://127.0.0.1:18765');
    record('startup', page.url());
    if(native)await page.goto(new URL(page.url()).origin+'/');
    if(process.env.EASYREAD_EXPECT_SYSTEM_CONTRAST==='1') {
      // Clear automation media defaults so this measures the real OS setting.
      await page.emulateMedia({forcedColors:null,colorScheme:null});
      await page.waitForFunction(()=>matchMedia('(forced-colors: active)').matches,{},{timeout:7000});
      assert.equal(await page.evaluate(()=>matchMedia('(forced-colors: active)').matches),true);
      record('system contrast','Windows forced-colors detected by native WebView2');
    }
    if(await page.locator('#username').count()) {
      await page.getByLabel('用户名',{exact:true}).fill('a11y_test');
      await page.getByLabel('密码',{exact:true}).fill('SyntheticTest2026');
      await page.getByRole('button',{name:'登录',exact:true}).press('Enter');
    }
    await page.locator('#importBtn').waitFor(); await settle();
    await page.locator('#importBtn').press('Enter'); await settle();
    assert.equal(await page.locator('.topbar').evaluate(e=>e.inert),true);
    const modal=page.locator('[aria-modal=true]'); assert.equal(await modal.count(),1);
    await page.keyboard.press('Shift+Tab'); assert.equal(await modal.evaluate(e=>e.contains(document.activeElement)),true);
    await page.keyboard.press('Escape'); await settle();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'importBtn');
    record('modal','Background inert; Shift+Tab contained; Escape restores trigger');
    await page.locator('#importBtn').press('Enter'); await settle();
    await page.getByRole('button',{name:/选择 PDF/}).waitFor();
    // File-picker selection is supplied by automation; OS picker keyboard use remains manual.
    const importedResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/import'&&r.request().method()==='POST');
    await page.locator('#fileInput').setInputFiles(process.env.EASYREAD_SAMPLE || process.argv[2]);
    const importedId=(await (await importedResponse).json()).id;
    await page.waitForFunction(()=>!document.querySelector('#importDlg').classList.contains('open'));
    await page.waitForFunction(id=>!!document.querySelector('#paper-'+id),importedId);
    await page.locator('#list [role=option]').first().waitFor();
    await page.locator('#list').focus(); await page.keyboard.press('Home');
    const sampleIndex=await page.locator('#list [role=option]').evaluateAll((rows,id)=>rows.findIndex(r=>r.dataset.id===id),importedId);
    assert.ok(sampleIndex>=0);
    for(let n=0;n<sampleIndex;n++)await page.keyboard.press('ArrowDown');
    assert.ok(await page.locator('#list').getAttribute('aria-activedescendant'));
    record('import/select','Synthetic PDF imported; active descendant follows selection');
    await page.locator('[data-d=edit-meta]').press('Enter'); await settle();
    await page.getByRole('textbox',{name:'中文题名',exact:true}).fill('双栏无障碍合成样本');
    await page.keyboard.press('Tab');
    await page.locator('#q').fill('双栏无障碍');
    await page.waitForFunction(()=>document.querySelector('#count').textContent==='1 篇');
    record('metadata/Chinese search','Chinese title edit remains searchable (CR-001)');
    await page.locator('#q').fill(''); await settle();
    await page.locator('#list').focus(); await page.keyboard.press('Shift+F10'); await settle();
    assert.equal(await page.getByRole('menu').count(),1);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape'); await settle();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'list');
    record('context menu','Shift+F10, arrows, Escape and return focus');
    await page.locator('#list').press('Enter');
    await page.waitForFunction(()=>window.dualReady===true);
    const pdf=page.frames().find(f=>f.url().includes('/pdf/web/viewer.html')) || page.frames().find(f=>f.url().includes('viewer.html'));
    assert.ok(pdf,'Nested PDF document must exist');
    const text=await pdf.locator('body').ariaSnapshot();
    assert.ok(text.indexOf('PAGE 1 LEFT paragraph 5.')<text.indexOf('PAGE 1 RIGHT paragraph 1.'));
    fs.writeFileSync(path.join(evidence,'pdf-tree.txt'),text);
    record('PDF text','Synthetic two-column order exposed in accessibility tree; speech NOT_RUN');
    await page.locator('#readingControls').press('Enter'); await settle();
    await page.locator('#notesBtn').press('Enter'); await settle();
    await page.locator('[data-np=paper]').press('Enter'); await settle();
    await page.locator('#paperNote').fill('Synthetic keyboard note');
    await page.locator('[data-account-note-save]').press('Enter');
    await page.waitForFunction(()=>document.getElementById('accountNoteStatus')?.textContent.includes('成功保存'));
    await page.locator('[data-np-act=close]').press('Enter'); await settle();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'notesBtn');
    record('notes','Manual save succeeds; panel close restores toolbar focus');
    await page.locator('[data-pdf-layout=source]').press('Enter');
    await page.waitForFunction(()=>Dual.layout==='source'&&!Dual.layoutChanging);
    await page.locator('#readerBar > .reader-more > summary').press('Enter'); await settle();
    await page.locator('#page').fill('2'); await page.locator('#page').press('Enter');
    await page.waitForFunction(()=>document.getElementById('sourcePage').textContent.includes('第 2 页'));
    record('page navigation','Keyboard page-number navigation reaches page 2');
    await page.getByRole('link',{name:'← 文献库'}).press('Enter'); await page.locator('#list').waitFor();
    record('return','Returned to library');
    await page.locator('#settingsBtn').press('Enter'); await settle();
    await page.locator('[data-set-tab=reading]').press('Enter'); await settle();
    await page.locator('#setCancel').press('Enter'); await settle();
    record('settings','Reading tab reachable and cancel closes dialog');
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(evidence,'native-final.png')});
  } finally {
    fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({native,results,errors},null,2));
    await browser.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
