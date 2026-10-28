const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {coverProgress}=require('../web/eplod-records.js');
const {chromium}=require(process.env.TFL_PLAYWRIGHT||'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
const base=process.env.TFL_TEST_URL||'http://127.0.0.1:8020';
const out=path.resolve(__dirname,'../build/qa/ep-coverage');fs.mkdirSync(out,{recursive:true});
const nine=[0,1,2,3,4,5,6,7,8],today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const date=n=>new Date(Date.now()+8*3600000-n*86400000).toISOString().slice(0,10);
const days=n=>Object.fromEntries(Array.from({length:n},(_,i)=>[date(n-i),nine]));
assert.equal(coverProgress({stampDays:{[today]:[0,1,2]}},3,today).completed,1);
assert.equal(coverProgress({stampDays:{[today]:[0,0,1,2,9,-1]}},3,today).todayN,3);
assert.equal(coverProgress({stampDays:{[today]:nine}},0,today).completed,0);
assert.equal(coverProgress({recoveredCover:{sentences:nine},stampDays:days(3)},9,today).completed,3);
(async()=>{const seed=await(await fetch('http://127.0.0.1:8020/api/records')).json();const browser=await chromium.launch({channel:'msedge',headless:true});const passed=[],errors=[];
try{
 async function test(name,fn,course={}){
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:960}});
  let stored={...seed,course:structuredClone(course)},reject=false,failures=0;
  await context.route('**/api/records',r=>{
   if(r.request().method()==='GET')return r.fulfill({json:stored});
   if(reject){failures++;return r.fulfill({status:503,json:{error:'fixture save failure'}});}
   stored={...r.request().postDataJSON(),revision:(stored.revision||0)+1};return r.fulfill({json:{ok:true,revision:stored.revision}});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  try{await page.goto(base+'/#/course/eplod-0002');await page.locator('#ep-tabs').waitFor({timeout:60000});await page.locator('#ep-cov .ep-cover-step').first().waitFor();await page.evaluate(()=>document.fonts.ready);
   await fn(page,{get:()=>stored,reject:v=>reject=v,failures:()=>failures});passed.push(name);console.log('PASS',name);
  }finally{await context.close();}
 }
 for(let n=0;n<=3;n++)await test('round '+n+' agrees in navigation and always-visible lesson progress',async p=>{
  const row=p.locator('#ep-list .cli.on');assert.equal(await row.locator('.ep-round.complete').count(),n);assert.equal(await p.locator('#ep-cov .ep-cover-step.complete').count(),n);
  assert.equal(await row.locator('.ep-nav-caption').innerText(),n===3?'三遍完成':n===0?'背诵':'待第'+(n+1)+'遍');
  assert.equal(await p.locator('#ep-cov .ep-cover-heading h4').innerText(),'覆盖背诵');
  assert.ok(await p.locator('#ep-cov').isVisible());assert.ok(await p.locator('#ep-progress').isHidden());
  await p.locator('#ep-progress-toggle').click();assert.equal(await p.locator('#ep-progress-toggle').getAttribute('aria-expanded'),'true');assert.ok(await p.locator('#ep-progress').isVisible());assert.ok(await p.locator('#ep-cov').isVisible());
  assert.equal(await p.locator('#ep-steps .es').count(),4);assert.match(await p.locator('#ep-progress-toggle span').innerText(),/收起明细/);
  await p.locator('#ep-progress-toggle').click();assert.ok(await p.locator('#ep-progress').isHidden());assert.ok(await p.locator('#ep-cov').isVisible());assert.match(await p.locator('#ep-progress-toggle span').innerText(),/学习明细/);
  if(n===3){assert.equal(await row.locator('.ep-round.final').count(),1);assert.equal(await p.locator('#ep-cov .ep-cover-step.final').count(),1);assert.match(await p.locator('#ep-cov').innerText(),/三遍复背已完成/);}
 },{'eplod-0002':{done:true,drill:{stampDays:days(n)}}});
 await test('today stamp waits for tomorrow and historical recognition stays identifiable',async p=>{
  assert.equal(await p.locator('#ep-cov .complete.ep-cover-step').count(),2);assert.match(await p.locator('#ep-cov').innerText(),/历史补认/);assert.match(await p.locator('#ep-cov').innerText(),/隔天继续第 3 遍/);assert.equal(await p.locator('#ep-list .cli.on .ep-round.complete').count(),2);
 },{'eplod-0002':{drill:{recoveredCover:{sentences:nine,recognizedAt:1},stampDays:{[today]:nine}}}});
 await test('third completed round checks the lesson automatically without manual marking',async(p,store)=>{
  const row=p.locator('#ep-list .cli.on');
  assert.equal(await row.locator('.ep-round.complete').count(),3);
  assert.ok(await p.evaluate(()=>document.querySelector('#ep-list .cli.on').classList.contains('done')),'nav check auto-set');
  assert.match(await p.locator('.csp-meta').innerText(),/已学过/);
  assert.equal(await p.locator('#ep-done').textContent(),'取消已学');
  await p.evaluate(()=>flushRecords());await p.waitForFunction(()=>!recSaving&&!recDirty);
  assert.equal(store.get().course['eplod-0002'].done,true);
  assert.equal(await p.evaluate(()=>{updateCourseCount();return $('cs-ct').textContent;}),'1 / 364 节');
  await p.reload();await p.locator('#ep-cov .ep-cover-step').first().waitFor();
  assert.ok(await p.evaluate(()=>document.querySelector('#ep-list .cli.on').classList.contains('done')),'check survives reload');
 },{'eplod-0002':{drill:{recoveredCover:{sentences:nine,recognizedAt:1},stampDays:days(2)}}});
 await test('new stamp updates navigation, survives save failure retry and reload',async(p,store)=>{
  store.reject(true);
  await p.evaluate(()=>{epStamp(8);flushRecords();});   /* 第9句(下标8)补齐全部9句 */
  await p.waitForFunction(()=>!recSaving&&recDirty);assert.ok(store.failures()>0);assert.equal(await p.locator('#ep-list .cli.on .ep-round.complete').count(),1);assert.equal(await p.locator('#ep-cov .ep-cover-step.complete').count(),1);
  store.reject(false);await p.evaluate(()=>flushRecords());await p.waitForFunction(()=>!recSaving&&!recDirty);assert.deepEqual(store.get().course['eplod-0002'].drill.stampDays[today],nine);
  await p.reload();await p.locator('#ep-cov .ep-cover-step').first().waitFor();assert.equal(await p.locator('#ep-list .cli.on .ep-round.complete').count(),1);assert.equal(await p.locator('#ep-cov .ep-cover-step.complete').count(),1);
 },{'eplod-0002':{drill:{stampDays:{[today]:nine.slice(0,8)}}}});
 await test('all catalog lessons have true sentence counts; short lessons use their total',async p=>{
  const lessons=await p.evaluate(()=>courseById('eplod-01').lessons.map(l=>({id:l.id,n:l.dialogue_count})));
  assert.equal(lessons.length,364);assert.ok(lessons.every(l=>Number.isInteger(l.n)&&l.n>0));assert.equal(lessons.find(l=>l.id==='eplod-0002').n,9);
  const short=lessons.find(l=>l.n<6);if(short){await p.evaluate(id=>{const f=courseFind(id);REC.course[id]={drill:{stampDays:{'2020-01-01':Array.from({length:f.c.lessons[f.ix].dialogue_count},(_,i)=>i)}}};renderCourseNav();},short.id);const n=await p.evaluate(id=>{const f=courseFind(id);return epCoverState(REC.course[id],f.c.lessons[f.ix].dialogue_count).completed;},short.id);assert.equal(n,1);}
 });
 await test('phone header is compressed and player groups into deliberate rows',async p=>{
  await p.setViewportSize({width:320,height:844});
  const m=await p.evaluate(()=>({
   sub:getComputedStyle(document.querySelector('#v-course>.sub')).display,
   src:document.querySelector('.ep .csp-meta .src').innerText.trim(),
   rows:new Set([...document.querySelectorAll('.ep-status button,.ep-status label,.ep-status summary')].filter(e=>e.checkVisibility()).map(e=>Math.round(e.getBoundingClientRect().top))).size,
   stageH:Math.round(document.querySelector('.ep-stage').getBoundingClientRect().height),
   segs:Math.round(document.querySelector('.ep-segs').getBoundingClientRect().top),
   status:Math.round(document.querySelector('.ep-status').getBoundingClientRect().top),
   dock:Math.round(document.querySelector('.ep-dock').getBoundingClientRect().top),
   playW:document.querySelector('#ep-dock-play').getBoundingClientRect().height,
   toggle:!!document.querySelector('#ep-more>summary').getClientRects().length,
   speaker:!!document.querySelector('#ep-speed').getClientRects().length
  }));
  assert.equal(m.sub,'none');assert.ok(!/EnglishPod/.test(m.src),m.src);assert.equal(m.rows,2,JSON.stringify(m));
  assert.ok(m.stageH<=110,JSON.stringify(m));assert.ok(m.dock<m.segs&&Math.abs(m.segs-m.status)<8,JSON.stringify(m));
  assert.ok(m.toggle&&m.speaker);assert.ok(m.playW>=30,JSON.stringify(m));
  await p.setViewportSize({width:390,height:844});assert.equal(await p.evaluate(()=>getComputedStyle(document.querySelector('#v-course>.sub')).display),'none');
  await p.setViewportSize({width:1440,height:960});assert.notEqual(await p.evaluate(()=>getComputedStyle(document.querySelector('#v-course>.sub')).display),'none');
 });
 await test('training sentence play is labeled and targets the current sentence',async p=>{
  await p.locator('#ep-tabs [data-m=train]').click();
  const bp=p.locator('.ep-bcard .bp');
  assert.match(await bp.innerText(),/听这句/);
  await bp.click();
  await p.waitForFunction(()=>{const a=document.querySelector('#ep-audio');return a&&!a.paused;},{timeout:8000});
  const x=await p.evaluate(()=>({target:EP.st.playTarget,session:EP.st.playSession}));
  assert.equal(x.target.seg,'dg');assert.equal(x.target.i,0);assert.equal(x.session.i,0);
 });
 await test('desktop narrow navigation and 320/390 phone states remain readable',async p=>{
  for(const width of [1440,1024,390,320]){
   await p.setViewportSize({width,height:width<800?844:960});
   if(width<800)await p.locator('#cs-outline-toggle').click();
   const nav=await p.locator('#ep-list .cli.on').evaluate(el=>({w:el.getBoundingClientRect().width,over:el.scrollWidth-el.clientWidth,title:el.querySelector('.lt').getBoundingClientRect().height,marks:[...el.querySelectorAll('.ep-round')].map(e=>e.getBoundingClientRect().y)}));assert.ok(nav.over<=1,JSON.stringify(nav));assert.equal(new Set(nav.marks).size,1);
   await p.screenshot({path:path.join(out,'nav-'+width+'.png')});
   if(width<800)await p.locator('#cs-outline-toggle').click();
   const m=await p.evaluate(()=>({over:document.documentElement.scrollWidth-innerWidth,steps:[...document.querySelectorAll('.ep-cover-step')].map(e=>({w:e.clientWidth,sw:e.scrollWidth})),dates:[...document.querySelectorAll('.ep-cover-label time')].map(e=>({ws:getComputedStyle(e).whiteSpace,h:e.getBoundingClientRect().height})),coverBottom:document.querySelector('#ep-cov').getBoundingClientRect().bottom,stageTop:document.querySelector('.ep-stage').getBoundingClientRect().top,visible:!!document.querySelector('#ep-cov').getClientRects().length}));assert.ok(m.over<=1);assert.ok(m.visible);assert.ok(m.steps.every(x=>x.sw<=x.w+1),JSON.stringify(m));assert.ok(m.dates.every(x=>x.ws==='nowrap'&&x.h<22));if(width<800)assert.ok(m.coverBottom<=m.stageTop,JSON.stringify(m));await p.screenshot({path:path.join(out,'course-'+width+'.png')});
  }
 },{'eplod-0001':{done:true,drill:{stampDays:days(3)}},'eplod-0002':{done:true,drill:{stampDays:days(2)}},'eplod-0014':{drill:{stampDays:days(1)}}});
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({base,passed,errors},null,2));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
