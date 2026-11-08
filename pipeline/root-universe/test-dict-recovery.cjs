'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {listen}=require('../../root-universe/server.cjs');
const pw=require(process.env.TFL_PLAYWRIGHT||'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
const out=path.resolve(process.env.TFL_ROOT_QA||'build/qa/root-universe/fix-20261108');fs.mkdirSync(out,{recursive:true});
const result={ok:false,checks:[],screenshots:[],errors:[],isolation:'Read-only dictionary service, fresh browser contexts, all non-GET and external requests blocked.'};
let server,browser;
(async()=>{
 server=await listen({port:0});const origin='http://127.0.0.1:'+server.address().port;
 browser=await pw.chromium.launch({channel:'msedge',headless:true,args:['--use-mock-keychain','--password-store=basic']});
 for(const width of [1440,390,320]){
  const ctx=await browser.newContext({viewport:{width,height:width===1440?900:844},serviceWorkers:'block'});
  await ctx.route('**/*',route=>route.request().method()==='GET'&&new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await ctx.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.stack||e.message));
  const screenshot=async state=>{const target=path.join(out,width+'-'+state+'.png');await page.screenshot({path:target});result.screenshots.push(target);};
  try{
   await page.route('**/api/graph',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"injected index outage"}'}));
   await page.goto(origin+'/?node=Ldict:contradict');await page.locator('#reload-app').waitFor();
   assert(await page.locator('[data-view="graph"]').first().isDisabled());
   await page.evaluate(()=>{setView('graph');setView('practice');renderGraph();renderPractice();});
   assert(await page.locator('#reload-app').isVisible());assert.deepEqual(errors,[]);
   await page.unroute('**/api/graph');await page.locator('#reload-app').click();await page.locator('.word-title h2').waitFor();
   assert.equal(await page.locator('.word-title h2').textContent(),'contradict');
   // Learning failures replace the previous word and remain retryable, including malformed success responses.
   for(const [status,body] of [[503,'{"error":"temporary failure"}'],[404,'{"error":"unknown"}'],[200,'{"status":"unresolved"}'],[200,'{"status":"reviewed","word":{},"roots":[],"alliance":{}}'],[200,'{"status":"reviewed","word":{"meaning":"test","parts":[],"trace":[],"query_id":"broken"},"roots":[],"sources":[],"members":[],"family_roots":[],"alliance":{"id":"broken","branches":[{}],"words":[]}}']]){
    await page.route('**/api/learning?**',r=>r.fulfill({status,contentType:'application/json',body}));
    await page.getByLabel('搜索单词').fill('compass');await page.getByRole('button',{name:'查词',exact:true}).click();await page.locator('#retry-word').waitFor();
    assert((await page.locator('#word-content').innerText()).includes('compass'));assert(!(await page.locator('#word-content').innerText()).includes('contradict'));
    assert.equal(await page.locator('.word-title h2').count(),0);assert(await page.locator('[data-view="practice"]').first().isDisabled());
    await page.unroute('**/api/learning?**');await page.locator('#retry-word').click();await page.locator('.word-title h2').waitFor();assert.equal(await page.locator('.word-title h2').textContent(),'compass');
   }
   result.checks.push(width+': index failure navigation guard, learning 503/404/malformed replacement, retry works without page errors');
   await page.goto(origin+'/?node=Ldict:contradict');await page.locator('.word-title h2').waitFor();
   assert.deepEqual(await page.locator('.root-breakdown .piece strong').allTextContents(),['contra-','dict']);
   assert((await page.locator('.root-trace').innerText()).includes('contrādīcō'));assert(!(await page.locator('.root-trace').innerText()).includes('本候选待独立'));
   if(width===1440)for(const [word,parts]of [['contradict',['contra-','dict']],['contradiction',['contra-','dict','-ion']],['contradictory',['contra-','dict','-ory']]]){
    const response=await page.request.get(origin+'/api/learning?id=Ldict:'+word),profile=await response.json();assert.equal(response.status(),200);assert.equal(profile.status,'reviewed');assert.deepEqual(profile.word.parts.map(p=>p.label),parts);assert(profile.word.trace.some(t=>t.kind==='historical'));assert(profile.word.trace.some(t=>t.kind==='root'));
   }
   await screenshot('lookup');
   await page.locator('#root-panorama').click();await page.locator('[data-node="learning:Rdict"]').waitFor();await page.waitForFunction(()=>document.querySelectorAll('#map-lines path').length>0);
   assert.equal(await page.locator('#alliance-root-select').inputValue(),'Rdict');
   const checkLayout=async()=>{
    const metrics=await page.locator('.map-node').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect(),s=n.querySelector('small');return {id:n.dataset.node,x:r.x,y:r.y,w:r.width,h:r.height,font:parseFloat(getComputedStyle(s).fontSize),scroll:s.scrollHeight,client:s.clientHeight};}));
    for(const n of metrics){assert(n.font>=13);assert(n.scroll<=n.client+1,'text clipping '+n.id);}
    for(let i=0;i<metrics.length;i++)for(let j=i+1;j<metrics.length;j++){const a=metrics[i],b=metrics[j];assert(!(a.x<b.x+b.w-1&&a.x+a.w>b.x+1&&a.y<b.y+b.h-1&&a.y+a.h>b.y+1),'node overlap '+a.id+' / '+b.id);}
    const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert(size.scroll<=size.width,'horizontal overflow');
   };
   await checkLayout();await screenshot('graph');
   await page.locator('#alliance-root-select').selectOption('Rdigit');await page.locator('[data-node="learning:Rdigit"]').waitFor();assert.equal(await page.locator('[data-node="learning:Rdict"]').count(),0);
   await page.locator('[data-node^="branch:dict:"]').click();await page.locator('#expand-branch').click();
   const displayed=await page.evaluate(()=>Object.keys(activeGraphData.pos).map(id=>nodeById.get(id)).filter(n=>n.type==='learning_word'||n.type==='senses').map(n=>n.label).sort());
   assert.deepEqual(displayed,['digit','digital','digitally','digitize','double-digit'].sort());await checkLayout();
   await page.locator('#alliance-root-select').selectOption('@all');assert.equal(await page.locator('.map-node.root').count(),2);await checkLayout();
   assert(await page.evaluate(()=>activeGraphData.edges.every(e=>{const branch=nodeById.get(e.from_id);return branch.type!=='learning_branch'||branch.root_id===nodeById.get(e.to_id).root_id;})));
   await page.locator('#alliance-root-select').selectOption('Rdigit');
   await page.locator(width<=700?'.mobile-tabs [data-view="lookup"]':'.sidebar [data-view="lookup"]').click();
   await page.locator('[data-branch="B1"] summary').click();await page.locator('[data-map-branch="B1"]').click();
   const crossRoot=await page.evaluate(()=>({root:selectedAllianceRoot,branch:selectedAllianceBranch,visibleRoots:Object.keys(activeGraphData.pos).filter(id=>nodeById.get(id).type==='learning_root')}));
   assert.deepEqual(crossRoot,{root:'Rdict',branch:'B1',visibleRoots:['learning:Rdict']});assert(await page.locator('[data-node="branch:dict:B1"]').count());await checkLayout();
   result.checks.push(width+': root nodes and edges, 13px uncut descriptions, no overlap, digit separate root and correct 5-word branch, all-root clusters, branch entry resets unrelated scope');
   await page.locator(width<=700?'.mobile-tabs [data-view="lookup"]':'.sidebar [data-view="lookup"]').click();
   await page.locator('.alliance-heading [data-learn-branch]').click();await page.locator('#begin-branch').click();await page.locator('.practice-card .question').waitFor();
   const choices=await page.evaluate(()=>questions.filter(q=>q.choices).map(q=>q.choices.map(meaningTerms)));
   for(const options of choices)for(let i=0;i<options.length;i++)for(let j=i+1;j<options.length;j++)assert(!options[i].some(t=>options[j].includes(t)),'equivalent distractors');
   const q=await page.evaluate(()=>questions[qIndex]);await page.locator('[data-answer]').filter({hasText:q.answer}).first().click();await page.locator('.feedback').waitFor();
   const session=await page.evaluate(()=>({key:practiceKey,index:qIndex,answers}));await page.reload();await page.locator('.feedback').waitFor();assert.deepEqual(await page.evaluate(()=>({key:practiceKey,index:qIndex,answers})),session);
   if(width!==320)await screenshot('practice');
   result.checks.push(width+': semantic distractor de-duplication and exact refresh resume');
   if(width<=700)assert(await page.locator('.mobile-desk-link').isVisible());
   await page.goto(origin+'/?node=Ldict:verdict');await page.locator('.word-title h2').waitFor();
   assert.equal(await page.locator('.root-breakdown .piece').count(),0);assert((await page.locator('.root-breakdown').innerText()).includes('课堂记忆线索'));
   assert.deepEqual(errors,[]);
  }finally{await ctx.close();}
 }
 result.ok=true;
})().catch(e=>{result.errors.push(e.stack||e.message);}).finally(async()=>{
 if(browser)await browser.close().catch(()=>{});if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
 result.exit_code=result.ok?0:1;fs.writeFileSync(path.join(out,'recovery-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exitCode=result.exit_code;
});
