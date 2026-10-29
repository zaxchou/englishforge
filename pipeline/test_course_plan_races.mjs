import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ui=fs.readFileSync(new URL('../web/course-plan-ui.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const section=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const lid='ndf-01-01';
const plan=(id='round')=>({lessonId:lid,stamps:[],target:3,due:0,active:{id,phase:'main',order:['q1','q2'],answers:{},corrections:{},correctionOrder:[]}});
function setup(){
 const state={lessonId:lid,quiz:{questions:[{id:'q1'},{id:'q2'}]},phase:'ready',answers:{},planSaving:false};
 const ctx=vm.createContext({console,Date,JSON,Math,AbortSignal,GQ_UI:state,recAttQueue:[],fetch:()=>{},api:()=>{},$:()=>null,renderGenQuiz(){},gqRefreshList(){},gqScrollToCard(){},csQuizFocus(){},gqOverview(){},recFlushAttempts(){},gqQid:(q,x)=>x.id,esc:String,courseFind:()=>null});
 vm.runInContext(ui+'\n'+section('function gqStart(ids, run)', '/* 做题主视觉:'),ctx);
 const run=s=>vm.runInContext(s,ctx);
 run('CP.data={settings:{target:3,intervals:[3,7],mode:"fixed",daily:1,revision:0},plans:{}}');
 return {ctx,state,run};
}
const reply=j=>({ok:true,json:async()=>j});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

test('R1 repaired: late start preserves a newer autonomous run in the same lesson',async()=>{
 const c=setup(),d=deferred();c.ctx.api=async(path,opts)=>opts?{quiz:{questions:[{id:'q1'},{id:'q2'}]}}:{lessons:[lid]};
 c.ctx.fetch=()=>d.promise;
 const pending=c.run(`cpStart('${lid}')`);
 await new Promise(r=>setImmediate(r));
 c.run("gqStart(['q1','q2'],'core');GQ_UI.answers.q1={letter:'A',ok:true,eventId:'new-free-answer'};GQ_UI.ix=1");
 d.resolve(reply({plan:plan(),settings:{target:3}}));await pending;
 assert.equal(c.state.planRound,null);assert.equal(c.state.answers.q1.eventId,'new-free-answer');assert.equal(c.state.ix,1);assert.equal(c.state.phase,'quiz');
 console.log('R1 REPAIRED: newer autonomous answer, position and phase survive late start');
});

test('R2 repaired: late finish preserves newer same-lesson quiz and saving state',async()=>{
 const c=setup(),d=deferred();let click;const button={dataset:{cpRating:'good'}};
 c.ctx.body={querySelectorAll:()=>[{...button,set onclick(fn){click=fn;}}]};
 c.run("GQ_UI.phase='plan-finish';GQ_UI.planRound='old-round';cpWireFinish(body)");
 c.ctx.fetch=path=>path.endsWith('/finish')?d.promise:Promise.resolve(reply({plans:{[lid]:{...plan(),active:null,stamps:[{id:'old-round'}]}},settings:{target:3}}));
 const pending=click();
 c.run("gqStart(['q1','q2'],'core');GQ_UI.answers.q1={letter:'B',ok:true};GQ_UI.ix=1;GQ_UI.planSaving=true");
 d.resolve(reply({plan:{...plan(),active:null,stamps:[{id:'old-round'}]},settings:{target:3}}));await pending;
 assert.equal(c.state.phase,'quiz');assert.equal(c.state.planRound,null);assert.equal(c.state.answers.q1.letter,'B');assert.equal(c.state.ix,1);assert.equal(c.state.planSaving,true);
 console.log('R2 REPAIRED: late finish preserves newer quiz, answer, position and saving state');
});

test('R3 repaired: settings conflict refreshes revision, preserves draft and saves on retry',async()=>{
 const c=setup(),status={textContent:''},button={disabled:false},inputs=[{value:'3'},{value:'7'}],box={innerHTML:'',querySelectorAll:()=>[]};let submit;const revisions=[];let reads=0;
 const form={elements:{target:{value:'3'},mode:{value:'fixed'},daily:{value:'1'}},querySelector:s=>s==='#cp-intervals'?box:s==='#cp-settings-status'?status:button,querySelectorAll:()=>inputs,set onsubmit(fn){submit=fn;}};
 c.ctx.host={querySelector:()=>form};c.ctx.fetch=async(path,opts)=>{
  if(!opts.method){reads++;return reply({plans:{},settings:{target:4,intervals:[5,8,14],mode:'adaptive',daily:2,revision:1}});}
  const body=JSON.parse(opts.body);revisions.push(body.revision);
  if(body.revision===0)return {ok:false,json:async()=>({error:'course-plan settings conflict',code:'settings_conflict'})};
  assert.equal(body.target,3);assert.equal(body.mode,'fixed');assert.deepEqual(body.intervals,[3,7]);return reply({plans:{},settings:{...body,revision:2}});
 };
 c.run('cpWireSettings(host)');
 await submit({preventDefault(){}});assert.match(status.textContent,/输入保留/);assert.equal(form.elements.target.value,'3');assert.equal(form.elements.mode.value,'fixed');
 await submit({preventDefault(){}});
 assert.deepEqual(revisions,[0,1]);assert.equal(reads,1);assert.match(status.textContent,/已保存/);assert.equal(button.disabled,false);
 console.log('R3 REPAIRED: revision refreshed, draft preserved, retry saved with revision 1');
});

test('control: resume overlays current-phase queued answers only',()=>{
 const c=setup();c.ctx.p=plan();c.ctx.recAttQueue.push({id:'pending',planRound:'round',planPhase:'main',ref:{qid:'q1'},answer:'A',ok:true});c.run('cpResume(p)');assert.equal(c.state.ix,1);assert.equal(c.state.answers.q1.eventId,'pending');
});

test('control: cross-lesson late start leaves current lesson state alone',async()=>{
 const c=setup(),d=deferred();c.ctx.api=async(path,opts)=>opts?{quiz:{questions:[{id:'q1'},{id:'q2'}]}}:{lessons:[lid]};c.ctx.fetch=()=>d.promise;
 const pending=c.run(`cpStart('${lid}')`);await new Promise(r=>setImmediate(r));c.state.lessonId='cfcm-01-01';
 d.resolve(reply({plan:plan(),settings:{target:3}}));await pending;assert.equal(c.state.phase,'ready');assert.equal(c.state.planRound,undefined);
});

test('control: offline attempt stays queued, then saved 409 is acknowledged and removed',async()=>{
 const c=setup();let fail=true;const removed=[],scheduled=[];
 c.ctx.localStorage={removeItem:k=>removed.push(k)};c.ctx.setTimeout=fn=>{scheduled.push(fn);return scheduled.length;};
 c.ctx.saveStatus=()=>{};c.ctx.recLoadAttQueue=()=>{};c.ctx.recPersistAttQueue=()=>true;c.ctx.recOverlayPending=()=>{};c.ctx.gqAttemptAcknowledged=()=>{};
 c.ctx.REC={attempts:{},mistakes:{},qtimes:{}};
 c.run("var recAttSending=false,recReady=true,recAttRetry=null,recAttBackoff=0,recDirty=false;var ATT_PREFIX='tfl-att-item:';");
 vm.runInContext(section('async function recFlushAttempts()', "window.addEventListener('storage',e=>"),c.ctx);
 c.ctx.recAttQueue.push({id:'queued-answer',ref:{qid:'q1'},planRound:'round',planPhase:'main'});
 c.ctx.fetch=async()=>{if(fail)throw Error('synthetic offline');return {ok:false,status:409,json:async()=>({attemptSaved:true,planError:'round no longer active',attempt:{n:1},plan:{...plan(),active:null}})};};
 await c.run('recFlushAttempts()');assert.equal(c.ctx.recAttQueue.length,1);assert.equal(scheduled.length,1);
 fail=false;await c.run('recFlushAttempts()');assert.equal(c.ctx.recAttQueue.length,0);assert.deepEqual(removed,['tfl-att-item:queued-answer']);assert.equal(c.ctx.REC.attempts.q1.n,1);
});

test('control: finish success survives failing follow-up GET',async()=>{
 const c=setup();let click;c.ctx.body={querySelectorAll:()=>[{dataset:{cpRating:'good'},set onclick(fn){click=fn;}}]};
 c.run("GQ_UI.phase='plan-finish';GQ_UI.planRound='round';cpWireFinish(body)");
 c.ctx.fetch=async path=>{if(!path.endsWith('/finish'))throw Error('synthetic GET offline');return reply({plan:{...plan(),active:null,stamps:[{id:'round'}]},settings:{target:3}});};
 await click();assert.equal(c.state.phase,'ready');assert.equal(c.state.planRound,null);assert.match(c.state.err,/已盖章/);
});
