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
   const ctx=await browser.newContext({viewport:{width,height},permissions:[],serviceWorkers:'block'});
   const blocked=[];
   await ctx.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(url.origin===origin&&req.method()==='GET'&&['/','/app.js','/alliance-ui.js','/style.css','/brand.png','/favicon.ico','/api/graph','/api/learning','/api/search','/api/source'].includes(url.pathname))return route.continue();blocked.push(req.method()+' '+req.url());return route.abort('blockedbyclient');});
   const page=await ctx.newPage();
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
    const topology=await page.evaluate(()=>({branches:Object.keys(activeGraphData.pos).filter(id=>nodeById.get(id).type==='learning_branch').length,roots:Object.keys(activeGraphData.pos).filter(id=>nodeById.get(id).type==='learning_root').length,scope:selectedAllianceRoot,edges:activeGraphData.edges.length}));
    assert.equal(topology.scope,'Rdict');assert.equal(topology.roots,1);assert.equal(topology.branches,11);assert.equal(topology.edges,11);
    assert.equal(mapNodes,topology.branches+topology.roots,'panorama must connect each visible branch to its real root');
    const shot1=ws.file(ws.QA,stamp+'/'+width+'-graph.png');await page.screenshot({path:shot1});out.screenshots.push(shot1);
    // Branch practice flow: read -> quiz -> meaning + recall answers
    await page.locator(width<=700?'.mobile-tabs [data-view="practice"]':'.sidebar [data-view="practice"]').click();
    await page.locator('.lesson-words').waitFor();
    const shot2=ws.file(ws.QA,stamp+'/'+width+'-branch-read.png');await page.screenshot({path:shot2});out.screenshots.push(shot2);
    await page.locator('#begin-branch').click();
    await page.locator('.practice-card .question').waitFor();
    // Compare against the reviewed branch, then answer each word by identity.
    const snapshot=()=>page.evaluate(()=>({key:practiceKey,index:qIndex,answers,stage:alliancePracticeStage,branch:alliancePracticeBranch,questions,session:JSON.parse(localStorage.getItem('root-universe:session')),events:Object.keys(localStorage).filter(k=>k.startsWith('root-universe:event:')).length}));
    const expected=await page.evaluate(()=>learning.alliance.branches.find(b=>b.id===alliancePracticeBranch).words.flatMap(item=>{const w=learning.members.find(w=>(w.query_id||w.sense_id)===(item.query_id||item.sense_id));return [{id:w.id+':meaning',word_id:w.query_id||w.sense_id,answer:w.meaning},...(w.recall?[{id:w.id+':recall',word_id:w.query_id||w.sense_id,answer:w.recall.answer}]:[])];}));
    const total=Number(/(\d+)\s*\/\s*(\d+)/.exec(await page.locator('.practice-meta span:last-child').textContent())[2]);
    assert.equal(total,expected.length);assert(total>=6);
    assert.deepEqual((await snapshot()).questions.map(q=>({id:q.id,word_id:q.word_id,answer:q.answer})),expected);
    for(let i=0;i<total;i++){
     const input=page.locator('#recall-answer');
     if(await input.count()){await input.fill(expected[i].answer);await page.locator('#recall-form button').click();}
     else await page.locator('.practice-card [data-answer]').nth((await snapshot()).questions[i].choices.indexOf(expected[i].answer)).click();
     await page.locator('.practice-card .feedback').waitFor();
     assert.equal(await page.locator('.feedback h3').textContent(),'答对了');
     if(i===0||i===1){
      const before=await snapshot();assert(before.key);assert.equal(before.session.key,before.key);assert.equal(before.session.index,i);assert.equal(before.session.answers[i],expected[i].answer);
      await page.reload();await page.locator('.practice-card .feedback').waitFor();assert.deepEqual(await snapshot(),before,'refresh must restore exact question, answer, option order and event count');
     }
     if(i<total-1){await page.locator('#next-q').click();await page.locator('.practice-card .question').waitFor();}
    }
    const shot3=ws.file(ws.QA,stamp+'/'+width+'-branch-finish.png');await page.screenshot({path:shot3});out.screenshots.push(shot3);
    // Recorded events persist and refresh resumes
    const events=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('root-universe:event:')).length);
    assert(events>=total,'events should persist, got '+events);
    const beforeReload=await snapshot();await page.reload();
    await page.locator('#practice-view .feedback').waitFor();assert.deepEqual(await snapshot(),beforeReload);
    await page.locator('#next-q').click();await page.locator('#restart').waitFor();
    assert((await page.locator('.finish').textContent()).includes('首次答对'+total+'题'));
    await page.locator('#restart').click();await page.locator('.practice-card .question').waitFor();
    const restarted=await snapshot();assert.equal(restarted.index,0);assert.deepEqual(restarted.answers,[]);assert.deepEqual(restarted.questions.map(q=>({id:q.id,word_id:q.word_id,answer:q.answer})),expected);
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
    await page.locator('#alliance-root-select').selectOption('@all');
    const l1Nodes=await page.locator('.map-node').count();
    const branchCount=await page.evaluate(()=>new Set(Object.keys(activeGraphData.pos).filter(id=>nodeById.get(id).type==='learning_branch').map(id=>nodeById.get(id).branch_id)).size);
    assert.equal(branchCount,13,'all-root view must preserve every classroom branch');assert(l1Nodes>13);
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
    // ---- Lessons 2 & 3: lookup, alliance coverage, branch practice entry ----
    for(const [word,prefix,minWords] of [['compass','Lcfcm-02:',200],['psychology','Lcfcm-03:',200]]){
      await page.goto(origin+'/');
      await page.locator('.word-title h2').waitFor();
      await page.getByLabel('搜索单词').fill(word);
      await page.getByRole('button',{name:'查词',exact:true}).click();
      await page.waitForURL(u=>(u.searchParams.get('node')||'').startsWith(prefix));
      assert.equal(await page.locator('.word-title h2').textContent(),word);
      const clickable=await page.locator('.alliance-word.clickable').count();
      assert(clickable>=minWords,word+' alliance clickable '+clickable+' < '+minWords);
      await page.waitForTimeout(400);
      await page.locator(width<=700?'.mobile-tabs [data-view="practice"]':'.sidebar [data-view="practice"]').click();
      await page.locator('.lesson-words').waitFor();
      const shot5=ws.file(ws.QA,stamp+'/'+width+'-'+word+'-practice.png');await page.screenshot({path:shot5});out.screenshots.push(shot5);
      out.checks.push('viewport '+width+': '+word+' lookup, '+clickable+' clickable, branch practice card ok');
    }
    assert.deepEqual(blocked,[],'browser must not access write or paid endpoints');
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
