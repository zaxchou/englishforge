'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.TFL_PLAYWRIGHT||'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
const root=path.resolve(__dirname,'..'),base=process.env.TFL_TEST_URL||'http://127.0.0.1:8020';
const out=path.join(root,'build/qa/ep-flow-fixed');fs.mkdirSync(out,{recursive:true});
const E=require('../web/eplod-records.js');
const seed={version:1,revision:0,attempts:{},qtimes:{},mistakes:{},families:{},course:{},study:{},writing:{},drafts:{},feedback:[]};
let browser;
async function setup(course={}){
 const ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:960}});
 let stored={...structuredClone(seed),course:structuredClone(course)};
 const pending=[],errors=[],archive=[],state={asrText:'okay',hold:false,archiveFail:false,asrFail:false,asrCalls:0};
 await ctx.route('**/api/records**',async r=>{if(r.request().method()==='GET')return r.fulfill({json:stored});stored={...r.request().postDataJSON(),revision:stored.revision+1};return r.fulfill({json:{ok:true,revision:stored.revision}});});
 await ctx.route('**/api/eplod/lesson/*',async r=>{const res=await r.fetch();const j=await res.json();j.asr=true;return r.fulfill({json:j});});
 await ctx.route('**/api/eplod/asr',async r=>{state.asrCalls++;const text=state.asrText;if(state.hold)await new Promise(resolve=>pending.push(resolve));return r.fulfill({status:state.asrFail?503:200,json:state.asrFail?{error:'test unavailable'}:{ok:true,text}});});
 await ctx.route('**/api/eplod/recording',async r=>{const j=r.request().postDataJSON();archive.push(j);return r.fulfill({status:state.archiveFail?503:200,json:state.archiveFail?{error:'test archive failure'}:{ok:true,file:`eplod-${j.ep}-${j.i}-${j.takeId}.webm`}});});
 await ctx.addInitScript(()=>{
  window.__mediaCalls=0;window.__tracks=[];window.__mediaPending=[];window.__delayMedia=false;
  navigator.mediaDevices.getUserMedia=async()=>{
   window.__mediaCalls++;
   if(window.__delayMedia)await new Promise(r=>window.__mediaPending.push(r));
   const ac=new AudioContext();await ac.resume();const src=ac.createOscillator(),gain=ac.createGain(),dest=ac.createMediaStreamDestination();gain.gain.value=.2;src.connect(gain).connect(dest);src.start();
   window.__tracks.push(...dest.stream.getTracks());return dest.stream;
  };
 });
 const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));
 await p.goto(base+'/#/eplod/eplod-0016');await p.locator('#ep-tabs').waitFor();await p.locator('#ep-tabs [data-m="train"]').click();
 return {ctx,p,state,pending,errors,archive,stored:()=>stored,close:async()=>{for(const f of pending.splice(0))f();await ctx.close();}};
}
async function choose(p,i,mode='voice'){
 await p.evaluate(i=>epGo(i),i);await p.locator('.ep-bcard .bmode [data-m="'+mode+'"]').click();
}
async function record(p){
 await p.locator('.ep-bcard .ep-rec').click();await p.waitForFunction(()=>!!EP.st.recording);await p.waitForTimeout(450);await p.locator('.ep-bcard .ep-rec').click();await p.waitForFunction(()=>!EP.st.recording);
}
async function test(name,fn){await fn();console.log('PASS '+name);}
(async()=>{
 browser=await chromium.launch({channel:'msedge',headless:true});
 try{
 await test('incomplete voice and typing do not award speed or cover; replay appears immediately',async()=>{
  const h=await setup();try{
   await choose(h.p,2);await record(h.p);await h.p.waitForFunction(()=>!!EP.st.p.drill.rd[2]?.voice);
   const r=await h.p.evaluate(()=>({acc:EP.st.p.drill.rd[2].voice.acc,sd:EP.st.p.drill.sd?.[2],stamp:Object.values(EP.st.p.drill.stampDays||{}).flat(),replay:!!document.querySelector('.elisten-me'),ai:EP.st.ai}));
   assert.ok(r.acc<.1);assert.equal(r.sd,undefined);assert.ok(!r.stamp.includes(2));assert.equal(r.replay,true);assert.equal(r.ai,2);
   await h.p.locator('.bmode [data-m="type"]').click();await h.p.locator('.btype .dt').fill('okay');await h.p.locator('.btype .dsubmit').click();
   assert.equal(await h.p.evaluate(()=>Object.values(EP.st.p.drill.stampDays||{}).flat().includes(2)),false);
   await h.p.screenshot({path:path.join(out,'desktop-failed-stays.png')});assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
 });
 await test('late recognition never navigates or steals draft; history best cannot pass current response',async()=>{
  const h=await setup({'eplod-0016':{drill:{rd:{2:{acc:1,at:1}},dd:{},sd:{},stampDays:{},playsS:{}}}});try{
   h.state.hold=true;await choose(h.p,2);await record(h.p);await h.p.waitForFunction(()=>document.querySelector('.bvoice .dr').textContent.includes('转写中'));
   await choose(h.p,8,'type');await h.p.locator('.btype .dt').fill('my unfinished draft');
   h.state.hold=false;h.pending.splice(0).forEach(f=>f());await h.p.waitForFunction(()=>!!EP.st.p.drill.rd[2]?.voice);
   await h.p.waitForTimeout(1100);assert.equal(await h.p.evaluate(()=>EP.st.ai),8);assert.equal(await h.p.locator('.btype .dt').inputValue(),'my unfinished draft');
   await choose(h.p,2);assert.match(await h.p.locator('.bvoice .dr').innerText(),/本次词准 6%/);assert.match(await h.p.locator('.bh [data-k="r"]').innerText(),/100%/);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
 });
 await test('successful response stays; typed retry preserves voice and replay through reload',async()=>{
  const h=await setup();try{
   h.state.asrText=await h.p.evaluate(()=>EP.st.d.dialogue[2].text);await choose(h.p,2);await record(h.p);
   await h.p.waitForFunction(()=>!!EP.st.p.drill.rd[2]?.rec&&!!EP.st.p.drill.rd[2]?.voice);
   assert.equal(await h.p.evaluate(()=>EP.st.ai),2);assert.equal(await h.p.evaluate(()=>EP.st.p.drill.rd[2].voice.acc),1);
   await h.p.locator('.bmode [data-m="type"]').click();await h.p.locator('.btype .dt').fill('okay');await h.p.locator('.btype .dsubmit').click();
   const r=await h.p.evaluate(()=>EP.st.p.drill.rd[2]);assert.equal(r.typed.acc,.0625);assert.equal(r.voice.acc,1);assert.ok(r.rec);assert.equal(r.acc,1);
   await h.p.evaluate(()=>flushRecords());await h.p.waitForFunction(()=>!recSaving&&!recDirty);await h.p.reload();await h.p.locator('#ep-tabs').waitFor();await h.p.locator('#ep-tabs [data-m="train"]').click();await choose(h.p,2);
   assert.match(await h.p.locator('.bvoice .dr').innerText(),/本次通过/);assert.equal(await h.p.locator('.elisten-me').count(),1);
   assert.equal(await h.p.locator('.bh [data-k="s"]').count(),1);
   await h.p.evaluate(()=>location.hash='#/stats');await h.p.locator('#st-ep').waitFor();assert.match(await h.p.locator('#st-ep').innerText(),/同速通过[\s\S]*?1 句/);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
 });
 await test('pending microphone is single-owner and cancelled by sentence, mode, tab and route changes',async()=>{
  const h=await setup();try{
   await choose(h.p,2);await h.p.evaluate(()=>{window.__delayMedia=true;document.querySelector('.ep-rec').click();document.querySelector('.ep-rec').click();});
   assert.equal(await h.p.evaluate(()=>window.__mediaCalls),1);await choose(h.p,3);await h.p.evaluate(()=>window.__mediaPending.splice(0).forEach(f=>f()));
   await h.p.waitForFunction(()=>window.__tracks.length>0&&window.__tracks.every(t=>t.readyState==='ended'));assert.equal(await h.p.evaluate(()=>!!EP.st.recording),false);
   await h.p.evaluate(()=>window.__delayMedia=false);await choose(h.p,3);await h.p.locator('.ep-rec').click();await h.p.waitForFunction(()=>!!EP.st.recording);await h.p.locator('.bmode [data-m="type"]').click();await h.p.waitForFunction(()=>!EP.st.recording);
   await choose(h.p,4);await h.p.locator('.ep-rec').click();await h.p.waitForFunction(()=>!!EP.st.recording);await h.p.locator('#ep-tabs [data-m="listen"]').click();await h.p.waitForFunction(()=>!EP.st.recording);
   await h.p.locator('#ep-tabs [data-m="train"]').click();await choose(h.p,5);await h.p.locator('.ep-rec').click();await h.p.waitForFunction(()=>!!EP.st.recording);await h.p.evaluate(()=>location.hash='#/stats');await h.p.waitForFunction(()=>!!document.querySelector('#v-stats.on'));
   assert.equal(await h.p.evaluate(()=>!!EP.st.recording||!!EP.st.recPending),false);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
 });
 await test('replay, original audio and microphone are mutually exclusive',async()=>{
  const h=await setup();try{
   h.state.asrText=await h.p.evaluate(()=>EP.st.d.dialogue[2].text);await choose(h.p,2);await record(h.p);await h.p.waitForFunction(()=>!!EP.st.p.drill.rd[2]?.voice);
   await h.p.locator('.bp').click();await h.p.waitForFunction(()=>!document.querySelector('#ep-audio').paused);
   await h.p.locator('.elisten-me').click();await h.p.waitForFunction(()=>!!EP.replay&&!EP.replay.paused);assert.equal(await h.p.evaluate(()=>document.querySelector('#ep-audio').paused),true);
   await h.p.locator('.elisten-me').click();assert.equal(await h.p.evaluate(()=>EP.replay),null);
   await h.p.locator('.elisten-me').click();await h.p.waitForFunction(()=>!!EP.replay&&!EP.replay.paused);await h.p.locator('.ep-rec').click();await h.p.waitForFunction(()=>!!EP.st.recording);assert.equal(await h.p.evaluate(()=>EP.replay),null);
   await h.p.locator('#ep-tabs [data-m="listen"]').click();assert.equal(await h.p.evaluate(()=>!!EP.st.recording),false);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
 });
 await test('failed ASR and archive keep local replay and offer retry without re-recording',async()=>{
  const h=await setup();try{
   h.state.asrFail=true;h.state.archiveFail=true;await choose(h.p,2);await record(h.p);await h.p.locator('.ep-retry-asr').waitFor();await h.p.locator('.ep-retry-archive').waitFor();assert.equal(await h.p.locator('.elisten-me').count(),1);
   h.state.asrFail=false;h.state.archiveFail=false;h.state.asrText=await h.p.evaluate(()=>EP.st.d.dialogue[2].text);
   await h.p.locator('.ep-retry-asr').click();await h.p.waitForFunction(()=>EP.st.p.drill.rd[2]?.voice?.acc===1);await h.p.locator('.ep-retry-archive').click();await h.p.waitForFunction(()=>!!EP.st.p.drill.rd[2]?.rec);
   assert.equal(await h.p.evaluate(()=>window.__mediaCalls),1);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
 });
 await test('unanchored sentence remains reachable and completes full coverage via typing',async()=>{
  const h=await setup();try{
   await h.p.goto(base+'/#/eplod/eplod-0003');await h.p.waitForFunction(()=>EP.st?.l.ep===3);await h.p.locator('#ep-tabs [data-m="train"]').click();await h.p.evaluate(()=>epGo(7));
   assert.equal(await h.p.evaluate(()=>EP.st.ai),7);assert.ok(await h.p.locator('.bp').isDisabled());assert.ok(await h.p.locator('.btype').isVisible());
   await h.p.locator('.btype .dt').fill('So');await h.p.locator('.btype .dsubmit').click();assert.equal(await h.p.evaluate(()=>Object.values(EP.st.p.drill.stampDays).flat().includes(7)),true);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
 });
 await test('two voice takes returned in reverse order keep the newest result and recording',async()=>{
  const h=await setup();try{
   h.state.hold=true;await choose(h.p,2);await record(h.p);await h.p.waitForFunction(()=>Object.values(EP.takes||{}).some(t=>t.processing));
   const oldId=await h.p.evaluate(()=>epTake(EP.st,2).id);h.state.asrText=await h.p.evaluate(()=>EP.st.d.dialogue[2].text);await record(h.p);
   await h.p.waitForFunction(id=>epTake(EP.st,2)?.id!==id&&epTake(EP.st,2)?.processing,oldId);
   const newest=await h.p.evaluate(()=>epTake(EP.st,2).id);assert.equal(h.pending.length,2);
   h.pending[1]();await h.p.waitForFunction(id=>EP.st.p.drill.rd[2]?.voice?.id===id,newest);
   h.pending[0]();await h.p.waitForTimeout(300);
   const r=await h.p.evaluate(()=>EP.st.p.drill.rd[2]);assert.equal(r.voice.id,newest);assert.equal(r.voice.acc,1);assert.equal(r.recAttemptId,newest);assert.ok(r.rec.includes(newest));assert.equal(await h.p.evaluate(()=>EP.st.ai),2);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
 });
 await test('leaving and returning to the same lesson receives pending feedback without moving the sentence',async()=>{
  const h=await setup();try{
   h.state.hold=true;await choose(h.p,2);await record(h.p);await h.p.waitForFunction(()=>epTake(EP.st,2)?.processing);
   await h.p.evaluate(()=>location.hash='#/stats');await h.p.locator('#v-stats.on').waitFor();await h.p.evaluate(()=>location.hash='#/eplod/eplod-0016');await h.p.waitForFunction(()=>EP.st?.active&&document.querySelector('#ep-tabs'));
   await h.p.locator('#ep-tabs [data-m="train"]').click();await choose(h.p,2);assert.match(await h.p.locator('.bvoice .dr').innerText(),/转写中/);
   h.state.hold=false;h.pending.splice(0).forEach(f=>f());await h.p.waitForFunction(()=>document.querySelector('.bvoice .dr').textContent.includes('本次词准'));assert.equal(await h.p.evaluate(()=>EP.st.ai),2);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
 });
 await test('card stays in sentence order at desktop, 390 and 320px with explicit next controls',async()=>{
  const h=await setup();try{
   for(const width of [1440,390,320]){
    await h.p.setViewportSize({width,height:width===1440?960:844});await choose(h.p,5,'type');
    const r=await h.p.evaluate(()=>{const a=[...document.querySelector('#ep-blist').children].map(x=>({i:+x.dataset.i,y:x.getBoundingClientRect().top}));return {ordered:a.every((x,i)=>!i||x.y>a[i-1].y),order:getComputedStyle(document.querySelector('.ep-bcard')).order,overflow:document.documentElement.scrollWidth>innerWidth};});
    assert.equal(r.ordered,true);assert.equal(r.order,'0');assert.equal(r.overflow,false);await h.p.locator('.ep-bcard').scrollIntoViewIfNeeded();await h.p.screenshot({path:path.join(out,`training-${width}.png`)});
   }
   assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
 });
 console.log('EnglishPod flow regression: all 10 checks passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
