'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const ws=require('../../root-universe/workspace.cjs');
const {listen}=require('../../root-universe/server.cjs');
const out={ok:false,checks:[],screenshots:[],errors:[]},stamp='alliance-'+crypto.randomUUID(),artifact=ws.mkdir(ws.QA,stamp);
async function run(){
 let server,browser;
 try{
  server=await listen({port:0});const origin='http://127.0.0.1:'+server.address().port;
  const pw=require(process.env.TFL_PLAYWRIGHT||'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
  browser=await pw.chromium.launch({channel:'msedge',headless:true});
  const check=(name,fn)=>{fn();out.checks.push(name);};
  for(const [width,height] of [[1440,900],[390,844],[320,760]]){
   const ctx=await browser.newContext({viewport:{width,height},permissions:[]});const page=await ctx.newPage();
   page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
   try{
    // Lookup a learning-only word and verify the alliance UI
    await page.goto(origin+'/');
    await page.locator('.word-title h2').waitFor();
    await page.getByLabel('搜索单词').fill('contradict');
    await page.getByRole('button',{name:'查词',exact:true}).click();
    await page.waitForURL(u=>u.searchParams.get('node')==='Ldict:contradict');
    assert.equal(await page.locator('.word-title h2').textContent(),'contradict');
    assert((await page.locator('.root-answer').textContent()).includes('dict'));
    // Alliance: all member words are clickable buttons
    const clickable=await page.locator('.alliance-word.clickable').count();
    assert(clickable>=78,'expected >=78 clickable alliance words, got '+clickable);
    // Switch word inside the alliance (expand all branches first)
    await page.evaluate(()=>document.querySelectorAll('.alliance-branch').forEach(d=>d.open=true));
    await page.locator('.alliance-word.clickable[data-word="Ldict:verdict"]').click();
    await page.locator('.word-title h2').waitFor();
    assert.equal(await page.locator('.word-title h2').textContent(),'verdict');
    // Root panorama shows branches, not just 3 template words
    await page.locator('#root-panorama').click();
    await page.locator('.map-node').first().waitFor();
    const mapNodes=await page.locator('.map-node').count();
    assert(mapNodes>=12,'panorama should show root+branches, got '+mapNodes);
    const shot1=ws.file(ws.QA,stamp+'/'+width+'-graph.png');await page.screenshot({path:shot1});out.screenshots.push(shot1);
    // Branch practice flow: read -> quiz -> meaning + recall answers
    await page.locator(width<=700?'.mobile-tabs [data-view="practice"]':'.sidebar [data-view="practice"]').click();
    await page.locator('.lesson-words').waitFor();
    const shot2=ws.file(ws.QA,stamp+'/'+width+'-branch-read.png');await page.screenshot({path:shot2});out.screenshots.push(shot2);
    await page.locator('#begin-branch').click();
    await page.locator('.practice-card .question').waitFor();
    // Answer all questions of branch B2 (contradict branch: 3 words, meaning + recall = 6)
    const total=Number(/(\d+)\s*\/\s*(\d+)/.exec(await page.locator('.practice-meta span:last-child').textContent())[2]);
    assert(total>=6,'branch practice should have >=6 questions, got '+total);
    for(let i=0;i<total;i++){
     const input=page.locator('#recall-answer');
     if(await input.count()){await input.fill('contradiction');await page.locator('#recall-form button').click();}
     else await page.locator('.practice-card .answer').first().click();
     await page.locator('.practice-card .feedback').waitFor();
     if(i<total-1){await page.locator('#next-q').click();await page.locator('.practice-card .question').waitFor();}
    }
    const shot3=ws.file(ws.QA,stamp+'/'+width+'-branch-finish.png');await page.screenshot({path:shot3});out.screenshots.push(shot3);
    // Recorded events persist and refresh resumes
    const events=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('root-universe:event:')).length);
    assert(events>=total,'events should persist, got '+events);
    await page.reload();
    await page.locator('#practice-view .finish, #practice-view .question, #practice-view .lesson-words').first().waitFor();
    const size=await page.evaluate(()=>({doc:document.documentElement.scrollWidth,width:innerWidth}));
    assert(size.doc<=size.width,'horizontal overflow at '+width+': '+JSON.stringify(size));
    assert.deepEqual(errors,[],'page errors at '+width);
    out.checks.push('viewport '+width+': alliance lookup, '+clickable+' clickable words, panorama, branch practice '+total+'q, '+events+' persisted events, no overflow/errors');
    // ---- Lesson 1 (multi-root alliance): lookup fix, panorama shows 13 branch cards, branch practice ----
    await page.goto(origin+'/');
    await page.locator('.word-title h2').waitFor();
    await page.getByLabel('搜索单词').fill('cross');
    await page.getByRole('button',{name:'查词',exact:true}).click();
    await page.waitForURL(u=>(u.searchParams.get('node')||'').startsWith('Lcfcm-01:'));
    assert.equal(await page.locator('.word-title h2').textContent(),'cross');
    const l1Clickable=await page.locator('.alliance-word.clickable').count();
    assert(l1Clickable>=176,'lesson1 alliance should expose >=176 words, got '+l1Clickable);
    await page.locator('#root-panorama').click();
    await page.locator('.map-node').first().waitFor();
    const l1Nodes=await page.locator('.map-node').count();
    assert(l1Nodes>=13,'lesson1 panorama should show 13 branches, got '+l1Nodes);
    const shot4=ws.file(ws.QA,stamp+'/'+width+'-lesson1-graph.png');await page.screenshot({path:shot4});out.screenshots.push(shot4);
    await page.locator(width<=700?'.mobile-tabs [data-view="practice"]':'.sidebar [data-view="practice"]').click();
    await page.locator('.lesson-words').waitFor();
    await page.locator('#begin-branch').click();
    await page.locator('.practice-card .question').waitFor();
    const total1=Number(/(\d+)\s*\/\s*(\d+)/.exec(await page.locator('.practice-meta span:last-child').textContent())[2]);
    assert(total1>=2,'lesson1 branch practice should have >=2 questions, got '+total1);
    const input1=page.locator('#recall-answer');
    if(await input1.count()){await input1.fill('fix');await page.locator('#recall-form button').click();}
    else await page.locator('.practice-card .answer').first().click();
    await page.locator('.practice-card .feedback').waitFor();
    out.checks.push('viewport '+width+': lesson1 multi-root lookup, '+l1Clickable+' clickable, '+l1Nodes+'-branch panorama, branch practice works');
   }finally{await ctx.close();}
  }
  out.ok=true;
 }catch(e){out.errors.push(e.stack||e.message);}
 finally{
  if(browser)await browser.close().catch(()=>{});
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  out.exit_code=out.ok?0:1;ws.atomic(artifact,'result.json',out);ws.atomic(artifact,'exit-code.json',{exit_code:out.exit_code});
 }
 console.log(JSON.stringify(out));process.exitCode=out.exit_code;
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
