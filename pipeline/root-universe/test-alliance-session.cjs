'use strict';
// Real browser + real client scripts; all content and browser storage are isolated fixtures.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const ws=require('../../root-universe/workspace.cjs');
const origin='http://127.0.0.1:8036';
function fixture(id,version,names){
 const roots=[{id:'R'+id,label:id+' root',meaning:'fixture root',origin:'fixture origin',forms_note:'fixture forms',earlier:[]}];
 const members=names.map((word,i)=>({id:id+'-word-'+i,query_id:id==='dict'&&i<3?'P0001:s000'+(i+1):'L'+id+':'+word,sense_id:id==='dict'&&i<3?'P0001:s000'+(i+1):null,word,meaning:id+' meaning '+i,lesson:1,relation_kind:'close',root_ids:[roots[0].id],source_ids:[],parts:[{label:id,role:'root',meaning:'fixture root'}],explanation:'Reviewed fixture explanation '+word,modern_formula:word,trace:[],recall:{prompt:'Recall '+word,answer:word,explanation:'Recall fixture '+word}}));
 const branches=[{id:'B1',title:id+' first branch',idea:'first group',words:members.slice(0,3)},{id:'B2',title:id+' second branch',idea:'second group',words:members.slice(3)}];
 return {status:'reviewed',version,members,roots,family_roots:roots,sources:[],alliance:{id,title:id+' alliance',branches,words:members,excluded:[],coverage_note:'Synthetic test fixture'}};
}
async function run(){
 const stamp='alliance-session-'+crypto.randomUUID(),artifact=ws.mkdir(ws.QA,stamp);
 const out={ok:false,checks:[],errors:[],blocked:[],isolation:'Browser routes fulfill local assets and synthetic GET APIs only; no server, records or paid endpoints.'};
 let browser,ctx;
 try{
  const profiles=[fixture('dict','dict-v1',['predict','predictable','unpredictable','contradict','contradiction']),fixture('lesson2','lesson2-v1',['cross','crossing','crossroad','compass'])];
  const graph={nodes:profiles.flatMap(p=>p.members.map(w=>({id:w.query_id,type:w.sense_id?'senses':'learning_word',label:w.word,zh:w.meaning,language:'en',pos:'verb',evidence_ids:[]}))),edges:[],families:profiles.map(p=>({id:'alliance:'+p.alliance.id,label:p.alliance.title,member_ids:p.members.map(w=>w.query_id)}))};
  const assets=new Map(['index.html','app.js','alliance-ui.js','style.css','brand.png'].map(name=>['/'+(name==='index.html'?'':name),fs.readFileSync(path.join(ws.PROJECT,'root-universe/public',name))]));
  const pw=require(process.env.TFL_PLAYWRIGHT||'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
  browser=await pw.chromium.launch({channel:'msedge',headless:true});
  ctx=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
  await ctx.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());
   if(u.origin!==origin||req.method()!=='GET'){
    out.blocked.push(req.method()+' '+req.url());return route.abort('blockedbyclient');
   }
   const reply=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
   if(assets.has(u.pathname))return route.fulfill({status:200,contentType:u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.css')?'text/css':u.pathname.endsWith('.png')?'image/png':'text/html',body:assets.get(u.pathname)});
   if(u.pathname==='/favicon.ico')return route.fulfill({status:204,body:''});
   if(u.pathname==='/api/graph')return reply(graph);
   if(u.pathname==='/api/roots'){
    const roots=profiles.flatMap(p=>p.roots.map(r=>({...r,id:p.alliance.id+':'+r.id,root_id:r.id,entry_id:p.alliance.id,title:p.alliance.title,count:p.members.filter(w=>w.root_ids.includes(r.id)).length,forms:[]})));
    return reply({results:roots,total:roots.length,truncated:false});
   }
   if(u.pathname==='/api/learning'){
    const p=profiles.find(p=>p.members.some(w=>w.query_id===u.searchParams.get('id')));
    assert(p,'unknown fixture query');const word=p.members.find(w=>w.query_id===u.searchParams.get('id'));
    return reply({...p,query_id:word.query_id,sense_id:word.sense_id,word});
   }
   if(u.pathname==='/api/search')return reply({results:profiles.flatMap(p=>p.members.filter(w=>w.word===u.searchParams.get('q')).map(w=>({display:w.word,senses:[{id:w.query_id,zh:w.meaning}]})))});
   out.blocked.push(req.method()+' '+req.url());return route.abort('blockedbyclient');
  });
  const page=await ctx.newPage();page.setDefaultTimeout(10000);
  page.on('pageerror',e=>out.errors.push(e.stack||e.message));
  const state=()=>page.evaluate(()=>({key:practiceKey,query:lookupSense,version:learning.version,alliance:learning.alliance.id,branch:alliancePracticeBranch,stage:alliancePracticeStage,index:qIndex,answers,questions:questions.map(q=>({id:q.id,word_id:q.word_id,q:q.q,choices:q.choices,answer:q.answer,input:!!q.input})),saved:JSON.parse(localStorage.getItem('root-universe:session')),events:Object.keys(localStorage).filter(k=>k.startsWith('root-universe:event:')).map(k=>JSON.parse(localStorage.getItem(k)))}));
  const check=name=>out.checks.push(name);
  const reload=async()=>{await page.reload();await page.locator('#practice-view:not([hidden]) .question, #practice-view:not([hidden]) .finish').first().waitFor();};
  const expectSession=s=>{
   assert.equal(s.saved.key,s.key);assert.equal(s.saved.query,s.query);assert.equal(s.saved.alliance,s.alliance);assert.equal(s.saved.version,s.version);assert.equal(s.saved.branch,s.branch);
   assert.deepEqual(JSON.parse(s.key),['alliance-v1',s.query,s.alliance,s.version,s.branch]);
   assert.equal(s.saved.index,s.index);assert.deepEqual(s.saved.answers,s.answers);assert.equal(s.saved.stage,s.stage);
  };
  const expectQuestions=(s,p,branch)=>{
   const words=p.alliance.branches.find(b=>b.id===branch).words;
   assert.deepEqual(s.questions.map(q=>q.id),words.flatMap(w=>[w.id+':meaning',w.id+':recall']));
   assert.deepEqual(s.questions.map(q=>q.word_id),words.flatMap(w=>[w.query_id,w.query_id]));
   for(const q of s.questions){const w=words.find(w=>w.query_id===q.word_id);assert.equal(q.answer,q.input?w.word:w.meaning);if(!q.input){assert.equal(new Set(q.choices).size,q.choices.length);assert(q.choices.includes(w.meaning));}}
  };
  const search=async word=>{await page.locator('.sidebar [data-view="lookup"]').click();await page.getByLabel('搜索单词').fill(word);await page.getByRole('button',{name:'查词',exact:true}).click();await page.waitForFunction(word=>learningLookup===lookupSense&&learning.word.word===word,word);await page.locator('.sidebar [data-view="practice"]').click();};
  const answer=async(correct=true)=>{
   const s=await state(),q=s.questions[s.index],p=profiles.find(p=>p.alliance.id===s.alliance),w=p.members.find(w=>w.query_id===q.word_id);
   const value=q.input?(correct?w.word.toUpperCase():'wrong-fixture-answer'):(correct?w.meaning:q.choices.find(v=>v!==w.meaning));
   if(q.input){await page.locator('#recall-answer').fill(value);await page.locator('#recall-form button').click();}
   else await page.locator('[data-answer]').filter({hasText:value}).click();
   await page.locator('.feedback').waitFor();
   const after=await state(),event=after.events.find(e=>e.question_id===q.id&&e.context===s.key&&e.answer===value);
   assert(event,'a persisted event must match this question and answer');assert.equal(event.correct,correct);assert.equal(event.word_id,w.query_id);assert.equal(event.version,p.version);assert.equal(event.query_id,s.query);assert.equal(event.alliance_id,s.alliance);assert.equal(event.branch_id,s.branch);assert.equal(event.context,s.key);
   assert.equal(after.answers[s.index],value);expectSession(after);
  };
  const finish=async()=>{while(!(await page.locator('#restart').count())){const s=await state();if(s.answers[s.index]===undefined)await answer();await page.locator('#next-q').click();}};
  await page.goto(origin+'/?node=P0001%3As0001');await page.locator('.word-title h2').waitFor();
  await page.locator('.alliance-heading [data-learn-branch]').click();await page.locator('.lesson-words').waitFor();
  let s=await state();expectSession(s);expectQuestions(s,profiles[0],'B1');assert.equal(s.stage,'read');assert(s.key);await reload();assert.deepEqual(await state(),s);
  await page.locator('#begin-branch').click();s=await state();expectSession(s);
  const positions=s.questions.filter(q=>!q.input).map(q=>q.choices.indexOf(q.answer));assert(new Set(positions).size>1,'meaning answers must occupy multiple positions');assert(positions.some(i=>i>0),'correct answers cannot all be A');
  await answer(false);s=await state();const wrongFeedback=await page.locator('.feedback').textContent();await reload();assert.deepEqual(await state(),s);assert.equal(await page.locator('.feedback').textContent(),wrongFeedback);assert.equal(await page.locator('.answer:disabled').count(),3);
  await page.locator('#next-q').click();await answer();s=await state();await reload();assert.deepEqual(await state(),s);assert.equal(await page.locator('#recall-answer').inputValue(),'PREDICT');assert(await page.locator('#recall-answer').isDisabled());
  await page.locator('#next-q').click();s=await state();await reload();assert.deepEqual(await state(),s);assert.equal(await page.locator('.practice-meta span:last-child').textContent(),'3 / 6');
  assert.deepEqual(await page.locator('[data-answer]').evaluateAll(ns=>ns.map(n=>n.dataset.answer)),s.questions[2].choices);
  check('normal learn entry: non-null full context; exact read, wrong answer, recall answer and unanswered question restore; option order and event count unchanged');
  await finish();s=await state();assert.equal(s.index,6);assert.equal(s.answers.length,6);assert((await page.locator('.finish').textContent()).includes('首次答对5题'));await reload();assert.deepEqual(await state(),s);
  await page.locator('#restart').click();s=await state();expectQuestions(s,profiles[0],'B1');expectSession(s);assert.equal(s.index,0);assert.deepEqual(s.answers,[]);assert.equal(s.stage,'quiz');assert.equal(s.questions.length,6);await reload();assert.deepEqual(await state(),s);await answer();
  check('fact-backed predict restart uses six word-identified alliance questions, resets answers and survives refresh');
  await finish();await page.locator('#next-branch').click();s=await state();expectQuestions(s,profiles[0],'B2');expectSession(s);assert.equal(s.stage,'read');assert.deepEqual(s.answers,[]);await reload();assert.deepEqual(await state(),s);
  await page.locator('[data-pick-branch="B1"]').click();s=await state();expectQuestions(s,profiles[0],'B1');expectSession(s);assert.equal(s.stage,'read');await page.locator('#begin-branch').click();await answer();
  check('next branch and sidebar branch selection reset context, questions and answers; selected branch restores');
  await search('predictable');s=await state();expectQuestions(s,profiles[0],'B1');expectSession(s);assert.equal(s.query,'P0001:s0002');assert.equal(s.stage,'read');assert.deepEqual(s.answers,[]);await page.locator('#begin-branch').click();await answer();
  check('query changes within the same alliance cannot inherit another word lookup session');
  await search('cross');s=await state();expectQuestions(s,profiles[1],'B1');expectSession(s);assert.equal(s.stage,'read');assert.deepEqual(s.answers,[]);await page.locator('#begin-branch').click();await answer();s=await state();await reload();assert.deepEqual(await state(),s);
  check('cross-alliance navigation with colliding B1 IDs discards old questions; new answer belongs to new word, alliance and version');
  const beforeVersion=s;profiles[1].version='lesson2-v2';await reload();s=await state();expectSession(s);expectQuestions(s,profiles[1],'B1');assert.equal(s.stage,'read');assert.deepEqual(s.answers,[]);assert.notEqual(s.key,beforeVersion.key);assert.deepEqual(s.events,beforeVersion.events);await page.locator('#begin-branch').click();await answer();
  check('archive version update rejects prior answers and position without rewriting historical events');
  // Keep the version and query identical but change the archive identity.
  profiles[1].alliance.id='lesson2-replaced';await reload();s=await state();expectSession(s);assert.equal(s.stage,'read');assert.deepEqual(s.answers,[]);await page.locator('#begin-branch').click();await answer();
  check('archive identity change with unchanged query/version rejects old session');
  const valid=(await state()).saved;
  for(const [name,mutate]of [
   ['legacy null key',x=>{x.key=null;}],['unknown branch',x=>{x.branch='missing';}],['negative index',x=>{x.index=-1;}],['out of bounds index',x=>{x.index=999;}],['invalid answer type',x=>{x.answers=[42];}],['invalid choice',x=>{x.answers=['not-a-choice'];}],['changed question set',x=>{x.questionSet='stale';}],['changed query',x=>{x.query='another-word';}]
  ]){
   const broken=structuredClone(valid);mutate(broken);await page.evaluate(x=>localStorage.setItem('root-universe:session',JSON.stringify(x)),broken);await reload();s=await state();expectSession(s);assert.equal(s.stage,'read',name);assert.equal(s.index,0,name);assert.deepEqual(s.answers,[],name);
  }
  await page.evaluate(()=>localStorage.setItem('root-universe:session','{broken json'));await reload();s=await state();expectSession(s);assert.equal(s.stage,'read');assert.deepEqual(s.answers,[]);
  check('legacy, malformed, mismatched and out-of-range stored sessions safely reset');
  // Block a profile request in flight and attempt to submit an old question.
  await page.locator('#begin-branch').click();let release,started;
  const held=new Promise(r=>{release=r;}),seen=new Promise(r=>{started=r;});
  await page.route('**/api/learning?id=P0001%3As0001',async route=>{started();await held;await route.fallback();});
  const oldEvents=(await state()).events.length;
  try{
   await page.evaluate(()=>{lookupSense='P0001:s0001';void renderWord();});await seen;
   assert.equal(await page.locator('[data-answer]').count(),0,'old answers must disappear during load');
   await page.evaluate(()=>{recordAllianceAnswer('lesson2 meaning 0');setView('practice');});
   assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('root-universe:event:')).length),oldEvents);
  }finally{release();}
  await page.waitForFunction(()=>learningLookup==='P0001:s0001');
  await page.locator('.sidebar [data-view="practice"]').click();
  s=await state();expectQuestions(s,profiles[0],'B1');expectSession(s);assert.equal(s.stage,'read');
  check('pending lookup hides old quiz and blocks old-answer writes before the matching profile arrives');
  assert.deepEqual(out.blocked,[],'all requests must stay inside the fixture allowlist');assert.deepEqual(out.errors,[]);
  out.ok=true;
 }catch(e){out.errors.push(e.stack||e.message);}
 finally{
  if(ctx)await ctx.close().catch(e=>out.errors.push(e.message));
  if(browser)await browser.close().catch(e=>out.errors.push(e.message));
  out.ok=out.ok&&out.errors.length===0;out.exit_code=out.ok?0:1;
  ws.atomic(artifact,'result.json',out);console.log(JSON.stringify({...out,artifact}));process.exitCode=out.exit_code;
 }
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
