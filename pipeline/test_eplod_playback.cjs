const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const {chromium}=require(process.env.TFL_PLAYWRIGHT||'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
 const ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
 await ctx.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.pathname==='/media/eplod/0002/dg.mp3'&&process.env.TFL_TEST_COLD)await new Promise(r=>setTimeout(r,1200));
  if(u.pathname==='/api/records'&&req.method()!=='GET')return route.fulfill({json:{revision:1}});
  if(!process.env.TFL_TEST_LIVE&&u.pathname==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync(root+'/web/index.html','utf8')});
  return route.continue();
 });
 const p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto((process.env.TFL_TEST_URL||'https://192.168.31.246:8018')+'/#/course/eplod-0002');
 await p.waitForSelector('#ep-tabs');await p.locator('#ep-tabs [data-m="train"]').click();
 await p.locator('.ep-settings summary').click();await p.locator('.ep-dmode [data-m="free"]').click();await p.locator('.ep-settings summary').click();
 await p.locator('#ep-blist .ep-brow[data-i="6"]').click();
 const state=()=>p.evaluate(()=>({t:document.querySelector('#ep-audio').currentTime,paused:document.querySelector('#ep-audio').paused,loop:EP.st.loop,range:EP.st.range,ai:EP.st.ai}));
 await p.locator('.ep-bcard .bp').click();
 await p.waitForFunction(()=>!document.querySelector('#ep-audio').paused&&document.querySelector('#ep-audio').currentTime>=30.3);
 await p.waitForFunction(()=>document.querySelector('#ep-audio').currentTime>33.5,{},{timeout:8000});
 const once=await state();assert.ok(once.t<35.4,JSON.stringify(once));
 await p.waitForFunction(()=>document.querySelector('#ep-audio').paused,{},{timeout:5000});
 assert.ok(Math.abs((await state()).t-30.3)<.1);
 await p.locator('.ep-bcard .bp').click();await p.waitForFunction(()=>!document.querySelector('#ep-audio').paused);
 await p.locator('.ep-bcard .bl').click();await p.waitForFunction(()=>document.querySelector('#ep-audio').currentTime>34.5);
 await p.waitForFunction(()=>document.querySelector('#ep-audio').currentTime<32&&!document.querySelector('#ep-audio').paused);
 assert.equal((await state()).loop,true);
 await p.locator('#ep-dock-next').click();await p.waitForFunction(()=>EP.st.ai===7&&document.querySelector('#ep-audio').currentTime>=35.38&&!document.querySelector('#ep-audio').paused);
 assert.equal((await state()).loop,false);
 await p.locator('#ep-dock-prev').click();await p.waitForFunction(()=>EP.st.ai===6&&document.querySelector('#ep-audio').currentTime>=30.3&&!document.querySelector('#ep-audio').paused);
 // Cold source: metadata, canplay and timeout must never each restart the same request.
 await p.locator('.ep-segs [data-seg="pb"]').click();await p.locator('.ep-materials>summary').click();await p.locator('.ep-bcard .bp').click();
 await p.waitForFunction(()=>EP.st.seg==='dg'&&!document.querySelector('#ep-audio').paused&&document.querySelector('#ep-audio').currentTime>=30.3);
 await p.waitForFunction(()=>document.querySelector('#ep-audio').currentTime>33.5,{},{timeout:8000});
 assert.ok((await state()).t<35.5);
 await p.evaluate(()=>document.querySelector('#ep-audio').pause());
 assert.deepEqual(errors,[]);
 console.log('PASS 0002 #7: play, stop, replay, loop boundary, next/previous, source switch; no runtime errors; production writes intercepted');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
