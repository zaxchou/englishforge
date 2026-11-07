const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'tfl-root-browser-')),out=path.join(root,'build/qa/root-universe/fix-20261107');fs.mkdirSync(out,{recursive:true});
const result={ok:false,checks:[],errors:[],blocked:[],screenshots:[],records:dir};let server,browser,activePage;
async function run(){
 fs.writeFileSync(path.join(dir,'generated-quizzes.json'),JSON.stringify({items:{'ndf-01-01':{v:2,course:'ndf-01',lessonNo:1,src:'official',questions:[{id:'q1',stem:'fixture',options:{A:'yes',B:'no'},answer:'A'}]}}}));
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const base='http://127.0.0.1:'+port;
 server=spawn(process.execPath,[path.join(root,'server.mjs'),'--port',String(port),'--records',dir],{cwd:root,env:{...process.env,TFL_TLS_KEY:'',TFL_TLS_CERT:'',TFL_AI_KEY:'',TFL_ASR_KEY:'',TFL_TTS_KEY:'',QWEN_TTS_API_KEY:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let logs='';await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout '+logs)),15000);server.stdout.on('data',b=>{logs+=b;if(logs.includes('http://localhost:')){clearTimeout(timer);resolve();}});server.stderr.on('data',b=>logs+=b);server.once('exit',n=>{clearTimeout(timer);reject(Error('startup '+n+' '+logs));});});
 const pw=require(process.env.TFL_PLAYWRIGHT||'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');browser=await pw.chromium.launch({channel:'msedge',headless:true});
 for(const width of [1440,390,320]){
  const ctx=await browser.newContext({viewport:{width,height:width===1440?900:844},permissions:[],serviceWorkers:'block'}),page=await ctx.newPage();activePage=page;page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.stack||e.message));
  await ctx.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());
   if(u.origin!==base){result.blocked.push(r.url());return route.abort();}
   if(/\/api\/(?:vocab\/tts|asr|tts|ai\/explain)/.test(u.pathname)){result.blocked.push(u.pathname);return route.fulfill({status:503,contentType:'application/json',body:'{"error":"blocked in test"}'});}
   if(u.pathname==='/api/records'&&r.method()!=='GET')return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"revision":1}'});
   if(u.pathname==='/api/ai/quiz')return route.fulfill({status:200,contentType:'application/json',body:r.method()==='GET'?' {"lessons":[],"revisions":{}}':'{"quiz":null}'});
   return route.continue();
  });
  let releaseLoading,loadingSeen;const loadingHeld=new Promise(r=>releaseLoading=r),loadingStarted=new Promise(r=>loadingSeen=r);
  await page.route('**/api/vocab/lesson-practice?lesson=2',async route=>{loadingSeen();await loadingHeld;await route.continue();},{times:1});
  await page.goto(base+'/#/course/cfcm-01-02');await page.locator('.htabs [data-h="practice"]').click();await loadingStarted;
  assert.equal(await page.locator('#gq-body button').count(),0,'old actions must be suspended until root availability is known');releaseLoading();
  await page.waitForFunction(()=>RP_STATE.data?.lesson===2&&!RP_STATE.loading);
  assert.equal(await page.evaluate(()=>RP_STATE.data.branches.reduce((n,b)=>n+b.words.length,0)),216);
  await page.locator('[data-rp-branch]').first().click();await page.locator('#rp-begin').click();
  const question=()=>page.evaluate(()=>RP_STATE.data.quiz.questions.find(q=>q.id===RP_STATE.question));
  const first=await question();await page.locator('[data-rp-c="'+first.answer+'"]').click();await page.locator('#rp-nextq').click();const second=await question();assert.equal(second.word,first.word);assert.equal(second.kind,'recall');
  // Test an actual pending answer with the root endpoint offline.
  await page.route('**/api/course-plan/root-answer',route=>route.abort());await page.locator('#rp-answer').fill(second.answer);await page.evaluate(()=>rpRender());assert.equal(await page.locator('#rp-answer').inputValue(),second.answer,'saving another answer must preserve the current input');await page.locator('#rp-check').click();
  await page.waitForFunction(()=>!RP_STATE.syncing&&RP_STATE.session.pending.length>0);
  const before=await page.evaluate(()=>({id:RP_STATE.session.id,q:RP_STATE.question,answers:RP_STATE.session.answers}));
  await page.reload();await page.locator('.htabs [data-h="practice"]').click();await page.waitForFunction(()=>RP_STATE.session&&RP_STATE.question&&!RP_STATE.loading&&!RP_STATE.syncing);
  assert.deepEqual(await page.evaluate(()=>({id:RP_STATE.session.id,q:RP_STATE.question,answers:RP_STATE.session.answers})),before);
  assert(await page.locator('#rp-answer').isDisabled());
  await page.unroute('**/api/course-plan/root-answer');await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForFunction(()=>RP_STATE.session.pending.length===0&&!RP_STATE.syncing);
  const records=await (await page.request.get(base+'/api/records')).json();assert.equal(records.vocab[first.word.toLowerCase()].n,1);assert.equal(records.vocab[first.word.toLowerCase()].s,2);
  if(width===1440){
   const start=await (await page.request.post(base+'/api/course-plan/start',{data:{lessonId:'ndf-01-01'}})).json();
   const r=await page.request.post(base+'/api/records/attempt',{data:{id:'root-concurrent-ndf-0001',ref:{qid:'gen/ndf-01/1/quiz/1',set:'gen',subj:'ndf-01',mk:'1',gkey:'quiz'},answer:'A',ok:true,t:Date.now(),secs:1,planRound:start.plan.active.id,planPhase:'main'}});assert.equal(r.status(),200);
   const plans=await (await page.request.get(base+'/api/course-plan')).json();assert.equal(plans.plans['cfcm-01-02'].active.id,before.id);assert.equal(Object.keys(plans.plans['cfcm-01-02'].active.answers).length,2);
  }
  await page.locator('#rp-nextq').click();const third=await question();assert.notEqual(third.word,first.word);
  // Leaving and remounting the same lesson renders the cached panel and saved position.
  await page.evaluate(()=>nav('home'));await page.evaluate(()=>nav('course/cfcm-01-02'));await page.locator('.htabs [data-h="practice"]').click();await page.locator('#rp-nextq').waitFor();assert.equal((await question()).id,third.id);
  assert.equal(await page.locator('#gq-body #cp-plan-start').count(),0,'legacy card must not start old plan');
  const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert(overflow.scroll<=overflow.width,JSON.stringify(overflow));
  const shot=path.join(out,'root-'+width+'.png');await page.locator('.rp-card').scrollIntoViewIfNeeded();await page.screenshot({path:shot});result.screenshots.push(shot);
  assert.deepEqual(errors,[]);result.checks.push(width+': direct course entry, 216 members, once-per-word scheduling, offline/reload/retry, exact resume, remount, legacy archive, no overflow/pageerrors');await ctx.close();
 }
 result.ok=true;
}
run().catch(async e=>{result.errors.push(e.stack||e.message);result.failureState=await activePage?.evaluate(()=>({lesson:RP_STATE.lesson,mode:RP_STATE.session?.mode,pending:RP_STATE.session?.pending,err:RP_STATE.err,syncing:RP_STATE.syncing,answers:RP_STATE.session?.answers,q:RP_STATE.question,html:document.getElementById('rp-body')?.innerText})).catch(()=>null);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server?.kill();result.exit_code=result.ok?0:1;fs.writeFileSync(path.join(out,'browser-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exitCode=result.exit_code;});
