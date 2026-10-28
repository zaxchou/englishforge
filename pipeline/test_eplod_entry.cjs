const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.TFL_PLAYWRIGHT||'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
const base=process.env.TFL_TEST_URL||'http://127.0.0.1:8020';
const out=path.resolve(__dirname,'../build/qa/ep-entry');fs.mkdirSync(out,{recursive:true});
(async()=>{const seed=await(await fetch('http://127.0.0.1:8020/api/records')).json();const b=await chromium.launch({channel:'msedge',headless:true});const passed=[],errors=[];let stored;
try{
 async function page(course={}){
  const ctx=await b.newContext({viewport:{width:1440,height:960},ignoreHTTPSErrors:true});
  stored={...seed,course:structuredClone(course)};
  await ctx.route('**/api/records',r=>{if(r.request().method()==='GET')return r.fulfill({json:stored});stored={...r.request().postDataJSON(),revision:(stored.revision||0)+1};return r.fulfill({json:{ok:true,revision:stored.revision}});});
  return {ctx,p:await ctx.newPage()};
 }
 { // 顶层入口与互斥计数
  const {ctx,p}=await page();p.on('pageerror',e=>errors.push(e.message));
  await p.goto(base+'/#/eplod');await p.locator('#ep-tabs').waitFor({timeout:60000});
  assert.ok(await p.locator('.nav button[data-v=eplod]').isVisible(),'nav entry');
  assert.equal(await p.evaluate(()=>document.querySelector('.nav button.on')?.dataset.v),'eplod');
  assert.equal(await p.locator('#cs-title').textContent(),'EnglishPod');
  assert.equal(await p.locator('.cs-pick select').count(),0,'EP mode has no course dropdown');
  assert.match(await p.locator('#cs-ct').textContent(),/ \/ 364 节$/);
  assert.match(await p.locator('#cs-nav .csi .t b').textContent(),/EnglishPod/);
  // 视频课模式: 标题/计数排除 EP
  await p.locator('.nav button[data-v=course]').click();await p.locator('.cs-pick select').waitFor();
  assert.equal(await p.locator('#cs-title').textContent(),'视频课');
  const opts=await p.locator('.cs-pick select option').allTextContents();
  assert.ok(opts.every(t=>!/EnglishPod/.test(t)),'video dropdown excludes EP');
  assert.doesNotMatch(await p.locator('#cs-ct').textContent(),/ \/ 364 节$/);
  assert.match(await p.locator('#cs-ct').textContent(),/ \/ \d+ 节$/);
  // 记忆: 回 EP 应回到之前那期
  await p.locator('.nav button[data-v=eplod]').click();await p.locator('#ep-tabs').waitFor();
  await p.locator('#ep-list .cli').filter({hasText:'#0014'}).click();await p.waitForFunction(()=>EP.st.l.ep===14);
  await p.locator('.nav button[data-v=course]').click();await p.locator('.cs-pick select').waitFor();
  await p.locator('.nav button[data-v=eplod]').click();await p.waitForFunction(()=>EP.st?.l?.ep===14&&location.hash==='#/eplod/eplod-0014');
  assert.equal(await p.evaluate(()=>location.hash),'#/eplod/eplod-0014');
  passed.push('top-level entry separates modes and remembers each side');console.log('PASS entry modes');
  await ctx.close();
 }
 { // 旧 hash 兼容 + 深链
  const {ctx,p}=await page();p.on('pageerror',e=>errors.push(e.message));
  await p.goto(base+'/#/course/eplod-0002');await p.locator('#ep-tabs').waitFor({timeout:60000});
  assert.equal(await p.evaluate(()=>location.hash),'#/eplod/eplod-0002');
  assert.equal(await p.locator('#cs-title').textContent(),'EnglishPod');
  passed.push('legacy course hash redirects to eplod route');console.log('PASS legacy redirect');
  await ctx.close();
 }
 { // 刷新保持 + 计数不互相污染
  const {ctx,p}=await page({'eplod-0002':{done:true}});
  p.on('pageerror',e=>errors.push(e.message));
  await p.goto(base+'/#/eplod');await p.locator('#ep-tabs').waitFor({timeout:60000});
  assert.match(await p.locator('#cs-ct').textContent(),/^1 \/ 364 节$/);
  await p.locator('.nav button[data-v=course]').click();await p.locator('.cs-pick select').waitFor();
  assert.match(await p.locator('#cs-ct').textContent(),/^0 \/ \d+ 节$/);
  await p.reload();await p.locator('#cs-title').waitFor({timeout:60000});
  assert.equal(await p.locator('#cs-title').textContent(),'视频课');   // 刷新回到离开时的入口
  await p.locator('.nav button[data-v=eplod]').click();await p.waitForFunction(()=>EP.st?.l?.ep);
  assert.match(await p.locator('#cs-ct').textContent(),/^1 \/ 364 节$/);
  passed.push('counts stay separate across reload and mode switch');console.log('PASS counts separate');
  await ctx.close();
 }
 { // 真题训练合并视图 + 旧路由重定向 + 课后复习并入视频课
  const {ctx,p}=await page();p.on('pageerror',e=>errors.push(e.message));
  await p.goto(base+'/#/sets');await p.locator('#exam-tabs').waitFor({timeout:60000});
  assert.equal(await p.evaluate(()=>location.hash),'#/exam/sets');
  assert.equal(await p.locator('#exam-tabs button.on').textContent(),'整套');
  assert.ok(await p.locator('.exam-badge').isVisible(),'official badge');
  await p.locator('#exam-tabs [data-t=review]').click();
  assert.equal(await p.evaluate(()=>location.hash),'#/exam/review');
  assert.ok(await p.locator('#exam-pane-review').isVisible());
  assert.ok(await p.locator('#exam-pane-review #rv-list').count());
  assert.equal(await p.evaluate(()=>location.hash),'#/exam/review');
  await p.goto(base+'/#/memory');await p.locator('#cs-tabs').waitFor({timeout:60000});
  assert.equal(await p.evaluate(()=>location.hash),'#/course/review');
  assert.equal(await p.locator('#cs-tabs button.on').textContent(),'课后复习');
  assert.ok(await p.locator('#cs-pane-review #course-memory-content').isVisible());
  await p.locator('#cs-tabs [data-t=learn]').click();
  assert.ok(await p.locator('#cs-layout').isVisible());
  // 课后复习页签不得泄露进 EnglishPod 视图
  await p.locator('.nav button[data-v=eplod]').click();await p.locator('#ep-tabs').waitFor({state:'visible'});
  const leak=await p.evaluate(()=>({t:getComputedStyle(document.getElementById('cs-tabs')).display,r:getComputedStyle(document.getElementById('cs-pane-review')).display,learn:document.getElementById('cs-pane-learn').offsetParent!==null,ep:!!document.getElementById('ep-tabs').offsetParent}));
  assert.ok(leak.t==='none'&&leak.r==='none'&&leak.learn&&leak.ep,JSON.stringify(leak));
  // 导航分组: 桌面 6 项 + 学/习标签
  const labels=await p.locator('.nav .nav-label').allTextContents();
  assert.deepEqual(labels,['学','习','工具']);
  assert.equal(await p.locator('.nav button[data-v=exam]').count(),1);
  passed.push('exam merged view, review tab in course and redirects');console.log('PASS exam/course tabs and redirects');
  await ctx.close();
 }
 { // 数据分析 · EnglishPod 深学卡
  const epFixture={
    'eplod-0002':{done:true,wt:3600,at:Date.now(),drill:{
      dd:{0:{acc:.95},1:{acc:.95}},
      rd:{0:{acc:.95}},
      sd:{0:{id:'speed-test',at:1,acc:.95,dur:2,sourceDur:3,verified:true}},
      stampDays:{'2026-10-26':[0,1,2,3,4,5,6,7,8],'2026-10-27':[0,1,2,3,4,5,6,7,8]},
      recoveredCover:{sentences:[0,1,2,3,4,5,6,7,8],recognizedAt:1}}},
    'eplod-0001':{drill:{stampDays:{'2026-10-26':[0,1,2,3,4,5,6,7,8]}}}
  };
  const {ctx,p}=await page(epFixture);
  p.on('pageerror',e=>errors.push(e.message));
  await p.goto(base+'/#/stats');await p.locator('#st-ep').waitFor({timeout:60000});
  assert.equal(await p.locator('#st-ep-ct').textContent(),'已学过 1 / 364 期');
  const txt=await p.locator('#st-ep').innerText();
  assert.match(txt,/三遍完成[\s\S]*?1 期/);assert.match(txt,/进行中[\s\S]*?1 期/);
  assert.match(txt,/听写通过[\s\S]*?2 句/);assert.match(txt,/背诵通过[\s\S]*?1 句/);assert.match(txt,/同速通过[\s\S]*?1 句/);
  assert.match(txt,/累计精听[\s\S]*?1\.0 h/);assert.match(txt,/最近精听 今天/);
  assert.ok(await p.locator('#st-ep-go').isVisible());
  await p.locator('#st-ep-go').click();await p.locator('#ep-tabs').waitFor({state:'visible',timeout:60000});
  assert.equal(await p.evaluate(()=>location.hash),'#/eplod/eplod-0002');
  passed.push('stats EnglishPod card computes and navigates');console.log('PASS stats ep card');
  await ctx.close();
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({base,passed,errors},null,2));
}finally{await b.close()}})().catch(e=>{console.error(e);process.exitCode=1});
