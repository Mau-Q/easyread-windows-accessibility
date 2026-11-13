// Connect only to an explicitly enabled test WebView2 debugging endpoint.
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.EASYREAD_CDP);
 try {
  const page=browser.contexts()[0].pages()[0];
  await page.goto(new URL(page.url()).origin+'/');
  await page.locator('#list [role=option]').first().waitFor();
  const title=process.argv[2]||'双栏无障碍';
  await page.locator('#q').fill(title);
  await page.waitForFunction(()=>document.querySelectorAll('#list [role=option]').length===1);
  await page.locator('#list').focus();await page.keyboard.press('Home');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.dualReady===true);
  const frame=page.frames().find(f=>f.url().includes('viewer.html'));
  await frame.locator('.page[data-page-number="1"] .textLayer').focus();
  console.log('Native PDF first-page text layer focused');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
