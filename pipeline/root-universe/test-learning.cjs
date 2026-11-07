'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ws=require('../../root-universe/workspace.cjs');
const builder=require('../../root-universe/build.cjs');
const learning=require('../../root-universe/learning.cjs');
const kit=require('./validate-kit.cjs');
const {listen}=require('../../root-universe/server.cjs');
async function run(){
 const out={ok:false,checks:[],screenshots:[],errors:[]};let server,browser;
 const stamp='learning-'+require('node:crypto').randomUUID();ws.mkdir(ws.QA,stamp);
 const check=(name,fn)=>{fn();out.checks.push(name);};
 try{
 const index=builder.current().index,raw=ws.bytes(ws.ROOT,'learning/dict/entry.json'),e=JSON.parse(raw);
 const valid=learning.validate(e,raw,null,index,{requireReview:false});
 check('snapshot revisions, byte hashes and literal source excerpts',()=>assert.equal(valid.sources.size,e.sources.length));
 check('root, prefix, suffix and whole-word identities stay distinct',()=>{
  const predict=e.words.find(w=>w.word==='predict'),un=e.words.find(w=>w.word==='unpredictable');
  assert.equal(predict.parts.find(p=>p.role==='root').label,'dict');
  assert.equal(predict.parts.find(p=>p.role==='prefix').label,'pre-');
  assert.deepEqual(un.parts.map(p=>p.label),['un-','pre-','dict','-able']);
  assert.equal(un.trace.at(-1).root_id,'Rdict');
  assert(un.trace.some(s=>s.label==='predictable'));assert(un.trace.some(s=>s.label==='praedīcō'));
 });
 // Synthetic signatures in memory exercise rejection paths, never published.
 const fake={decision:'approved',entry_sha256:kit.sha(raw),reviewer:'synthetic-independent-reviewer',review_run_id:'synthetic-run',approved_ids:valid.claims};
 for(const [name,edit,pattern]of [
  ['reject stale review',r=>{r.entry_sha256='0'.repeat(64);},/REVIEW_HASH/],
  ['reject author self-review',r=>{r.reviewer=e.author;},/INDEPENDENT/],
  ['reject partial approval',r=>{r.approved_ids.pop();},/CLOSURE/]
 ])check(name,()=>{const r=structuredClone(fake);edit(r);assert.throws(()=>learning.validate(e,raw,r,index),pattern);});
 check('reject changed snapshot bytes',()=>assert.throws(()=>learning.validate(e,raw,fake,index,{readSnapshot:()=>Buffer.from('{}')}),/SOURCE_HASH/));
 check('unknown profile never guesses a root from neighbors',()=>assert.equal(learning.query(index,'P0011:s0001').status,'unresolved'));
 const app=fs.readFileSync(require('node:path').join(ws.PROJECT,'root-universe/public/app.js'),'utf8');
 const vm=require('node:vm');
 const extract=(start,end)=>app.slice(app.indexOf('function '+start+'('),app.indexOf('function '+end+'('));
 check('generic renderer accepts roots with no earlier forms',()=>{
  const data={status:'reviewed',word:e.words[0],roots:[{...e.roots[0],earlier:undefined}],sources:e.sources};
  const code=extract('rootLearningHTML','allianceHTML')+'\nfunction allianceHTML(data){return \'\';}\nrootLearningHTML(data)';
  const html=vm.runInNewContext(code,{esc:s=>String(s??''),learningSources:()=>'',roleNames:{root:'词根',prefix:'前缀',suffix:'后缀',base:'基词'},data});
  assert(html.includes('dict- / dic-'));
 });
 check('generic graph supports multiple roots and three siblings without overflow',()=>{
  const members=Array.from({length:5},(_,i)=>({sense_id:'synthetic:'+i,word:'synthetic'+i,meaning:'synthetic',root_ids:['A','B'],trace:[]}));
  const roots=[{id:'A',label:'synthetic Greek root',meaning:'a',origin:'希腊来源'},{id:'B',label:'synthetic English root',meaning:'b',origin:'英语来源'}];
  const lookup=new Map(members.map(w=>[w.sense_id,{id:w.sense_id,label:w.word}]));
  const data=vm.runInNewContext('('+extract('rootGraphData','graphData')+')',{learning:{members,word:members[0],roots},nodeById:lookup,G:{edges:[]}})();
  assert.equal(Object.keys(data.pos).length,7);assert(Object.values(data.pos).every(p=>p.x>0&&p.x<100));
  assert.equal(data.edges.length,10);assert(data.edges.every(e=>!e.label.includes('拉丁')));
 });
 check('generic practice accepts a root without prefixes and includes multiple roots',()=>{
  const w={...e.words[0],root_ids:['A','B'],parts:[{label:'a',role:'root',meaning:'one'},{label:'b',role:'root',meaning:'two'}]};
  const scope={learning:{status:'reviewed',sense_id:w.sense_id,word:w,roots:[{label:'a',meaning:'one'},{label:'b',meaning:'two'}]},familySenses:()=>[],memberIn:()=>true,roleNames:{root:'词根',prefix:'前缀',suffix:'后缀',base:'基词'}};
  const q=vm.runInNewContext('('+extract('makeQuestions','memberIn')+')',scope)({});assert.equal(q[0].answer,'a + b');assert.equal(q[2].answer,'词根');
 });
 const published=learning.query(index,'P0001:s0001');
 check('real independent review is required before publication',()=>assert.equal(published.status,'reviewed'));
 check('alliance covers course words, branches have nonempty word lists, excluded words have reasons',()=>{
  const a=published.alliance;assert(a&&a.branches.length>=5&&a.words.length>=20&&a.excluded.length>=5);
  const inAlliance=new Set(a.words.map(w=>w.word.toLowerCase()));
  for(const x of a.excluded)assert(!inAlliance.has(x.word.toLowerCase()),x.word+' in both alliance and excluded');
  const branchIds=new Set(a.branches.map(b=>b.id));
  for(const w of a.words)assert(branchIds.has(w.branch),w.word+' branch '+w.branch+' not found');
  for(const b of a.branches){assert(b.words.length>0,'empty branch '+b.id);assert(b.title&&b.idea);}
  assert(a.words.some(w=>w.word==='contradict'));assert(a.words.some(w=>w.word==='verdict'));
  assert(a.excluded.some(x=>x.word==='medical'));assert(a.excluded.some(x=>x.word==='radical'));
 });
 server=await listen({port:0});const origin='http://127.0.0.1:'+server.address().port;
 const response=await fetch(origin+'/api/learning?id=P0001:s0001');assert.equal(response.status,200);assert.equal((await response.json()).status,'reviewed');out.checks.push('HTTP learning endpoint returns reviewed, source-bound profile');
 const pw=require(process.env.TFL_PLAYWRIGHT||'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
 browser=await pw.chromium.launch({channel:'msedge',headless:true});
 for(const width of [1440,390,320]){
  const ctx=await browser.newContext({viewport:{width,height:width===1440?900:844},permissions:[]});const page=await ctx.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.goto(origin+'/?q=predict&node=P0001%3As0001');
   await page.locator('.root-heading h3').waitFor();
   assert.equal(await page.locator('.word-title h2').textContent(),'predict');
   assert.equal(await page.locator('.root-heading h3').textContent(),'dict- / dic-');
   assert((await page.locator('.root-answer').textContent()).includes('说'));
   const rootBox=await page.locator('.root-heading').boundingBox();assert(rootBox.y<844,'root answer should be visible in the initial viewport');
   assert.deepEqual(await page.locator('.root-breakdown .piece strong').allTextContents(),['pre-','dict']);
   assert((await page.locator('.root-trace').textContent()).includes('praedīcō'));
   assert.equal(await page.locator('.root-evidence').first().getAttribute('open'),null);
   if(width===1440){
     await page.locator('.alliance-branch').first().waitFor();
     assert((await page.locator('.alliance').textContent()).includes('contradict'));
     assert((await page.locator('.alliance').textContent()).includes('verdict'));
     assert((await page.locator('.alliance').textContent()).includes('dict'));
     const allianceClick=page.locator('.alliance-word.clickable[data-word="P0001:s0003"]');
     if(await allianceClick.count()>0){await allianceClick.click();await page.locator('.root-heading h3').waitFor();assert.equal(await page.locator('.word-title h2').textContent(),'unpredictable');await page.goto(origin+'/?q=predict&node=P0001%3As0001');await page.locator('.root-heading').waitFor();}
   }
   const screenshot=ws.file(ws.QA,stamp+'/'+width+'-predict.png');await page.screenshot({path:screenshot});out.screenshots.push(screenshot);
   await page.reload();await page.locator('.root-heading').waitFor();assert.equal(await page.locator('.word-title h2').textContent(),'predict');
   // The old node URL must resolve the requested word, not the former hard-coded default.
   await page.goto(origin+'/?q=predict&node=P0001%3As0002');await page.locator('.root-heading').waitFor();assert.equal(await page.locator('.word-title h2').textContent(),'predictable');
   await page.getByLabel('搜索单词').fill('unpredictable');await page.getByRole('button',{name:'查词',exact:true}).click();
   await page.waitForURL(u=>u.searchParams.get('node')==='P0001:s0003');await page.locator('.root-breakdown .piece strong').nth(3).waitFor();
   assert.deepEqual(await page.locator('.root-breakdown .piece strong').allTextContents(),['un-','pre-','dict','-able']);
   assert((await page.locator('.modern-formula').textContent()).includes('un- + (predict + -able)'));
   const unshot=ws.file(ws.QA,stamp+'/'+width+'-unpredictable.png');await page.screenshot({path:unshot});out.screenshots.push(unshot);
   await page.locator('#root-panorama').click();await page.locator('.map-node[data-node="learning:Rdict"]').waitFor();
   assert(await page.locator('.root-map').isVisible());
   const boxes=await page.locator('.map-node').evaluateAll(ns=>ns.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};}));
   for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)assert(!(boxes[i].x<boxes[j].right&&boxes[i].right>boxes[j].x&&boxes[i].y<boxes[j].bottom&&boxes[i].bottom>boxes[j].y),'graph nodes overlap');
   const graphshot=ws.file(ws.QA,stamp+'/'+width+'-root-graph.png');await page.screenshot({path:graphshot});out.screenshots.push(graphshot);
   // Alliance panorama shows branch cards; expand B1 to reach member words.
   await page.locator('.map-node[data-node="branch:dict:B1"]').click();
   await page.locator('#expand-branch').click();
   await page.locator('.map-node[data-node="P0001:s0001"]').waitFor();
   await page.locator('.map-node[data-node="P0001:s0001"]').click();
   assert.equal(await page.locator('#graph-detail .detail-text').textContent(),published.word.explanation);
   await page.locator('.map-node[data-node="P0001:s0003"]').click();
   assert((await page.locator('#graph-detail .detail-text').textContent()).includes('否定前缀 un-'));
   await page.locator('.map-node[data-node="learning:Rdict"]').click();assert((await page.locator('#graph-detail').textContent()).includes('dīcō'));
   await page.locator('#graph-word').click();await page.locator('.root-answer').waitFor();assert.equal(await page.locator('.word-title h2').textContent(),'unpredictable');
   await page.locator('.root-evidence').first().locator('summary').first().click();assert((await page.locator('.root-evidence').first().textContent()).includes('*déyḱeti'));
   const link=await page.locator('.root-evidence a').first().getAttribute('href');assert(link.includes('oldid='));
   const nav=width<=700?'.mobile-tabs':'.sidebar';await page.locator(nav+' [data-view="practice"]').click();
   // Alliance practice shows the branch reading card first, then the quiz.
   await page.locator('.lesson-words').waitFor();assert((await page.locator('.practice-card').textContent()).includes('dict'));
   await page.locator('#begin-branch').click();await page.locator('.practice-card .question').waitFor();
   await page.locator('.practice-card .answer').first().click();assert((await page.locator('.feedback').textContent()).includes('答对了')||(await page.locator('.feedback').textContent()).includes('正确答案'));
   const size=await page.evaluate(()=>({doc:document.documentElement.scrollWidth,width:innerWidth}));assert(size.doc<=size.width);
   assert.deepEqual(errors,[]);out.checks.push('Edge '+width+': visible root, role-labelled pieces, trace, old URLs, refresh, root graph, sources and root exercise');
  }finally{await ctx.close();}
 }
 out.ok=true;
 }catch(e){out.errors.push(e.stack||e.message);}
 finally{if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}out.exit_code=out.ok?0:1;ws.atomic(ws.QA,stamp+'/result.json',out);ws.atomic(ws.QA,stamp+'/exit-code.json',{exit_code:out.exit_code});}
 console.log(JSON.stringify(out));process.exitCode=out.exit_code;
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
