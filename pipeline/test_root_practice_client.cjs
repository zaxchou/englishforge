const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../web/root-practice-ui.js'),'utf8');
function setup(data,store=new Map()){
 let fail=false,queueFail=false,seq=0;const nodes=new Map(),body={innerHTML:'',querySelectorAll:()=>[]};
 const ctx={console,AbortSignal,crypto:{randomUUID:()=>`test-${++seq}`},window:{addEventListener(){}},Date,JSON,Math,Object,Array,Map,Set,Promise,String,
  localStorage:{get length(){return store.size;},key:i=>[...store.keys()][i],getItem:k=>store.get(k)||null,setItem(k,v){if(fail||queueFail&&k.startsWith('tfl-vb-event:'))throw Error('quota');store.set(k,v);}},
  csSel:{c:'cfcm-01',l:data.lesson-1},$:id=>id==='rp-body'?body:(nodes.get(id)||nodes.set(id,{}).get(id)),
  esc:s=>String(s??''),api:async()=>data,cpLoad:async()=>{},cpPlan:()=>null,cpStamps:()=>'',cpCaption:()=>'',CP:{data:{plans:{}}},REC:{vocab:{}},
  gqStudyGate(){},renderGenQuiz(){},gqRefreshList(){},cpBadgeUpdate(){},vbFlushQueue(){},VB_PREFIX:'tfl-vb-event:',cpRequest:async()=>{const e=Error('not due');e.code='plan_not_due';throw e;}};
 vm.createContext(ctx);vm.runInContext(code,ctx);return {ctx,store,body,nodes,run:s=>vm.runInContext(s,ctx),fail:v=>fail=v,queueFail:v=>queueFail=v};
}
(async()=>{
 const {createRootPractice}=await import('../root-practice.mjs');const service=createRootPractice(path.join(__dirname,'../build/root-universe/learning')),data=service.lesson(1),other=service.lesson(2);
 let t=setup(data);await t.ctx.rpLoad(1);await t.ctx.rpBegin(data.branches[0]);
 const questions=data.branches[0].words[0].questions,[meaning,recall]=questions;
 t.ctx.first=meaning;t.fail(true);t.ctx.rpAnswer(meaning,meaning.answer);assert.equal(t.run('Object.keys(RP_STATE.session.answers).length'),0);assert.match(t.body.innerHTML,/未保存/);
 t.fail(false);t.ctx.rpAnswer(meaning,meaning.answer);await new Promise(r=>setImmediate(r));assert.equal(t.run('Object.keys(RP_STATE.session.wordEvents).length'),0);
 t.queueFail(true);t.ctx.rpAnswer(recall,recall.answer);await new Promise(r=>setImmediate(r));assert.equal(t.run('Object.keys(RP_STATE.session.wordEvents).length'),1);assert.match(t.run('RP_STATE.err'),/等待同步/);
 t.queueFail(false);await t.ctx.rpFlush();assert.equal([...t.store.keys()].filter(k=>k.startsWith('tfl-vb-event:')).length,1);
 t.ctx.rpAnswer(recall,recall.answer);assert.equal(t.run('Object.keys(RP_STATE.session.wordEvents).length'),1);
 t.ctx.rpMove('quiz',recall.id);const reloaded=setup(data,t.store);await reloaded.ctx.rpLoad(1);assert.equal(reloaded.run('RP_STATE.question'),recall.id);assert.equal(reloaded.run('RP_STATE.phase'),'main');
 assert.equal(reloaded.run('Object.keys(RP_STATE.session.answers).length'),2);assert.equal(reloaded.run('RP_STATE.stage'),'quiz');
 // A slow old lesson cannot replace the newly selected lesson.
 t=setup(data);const requests=new Map();t.ctx.api=url=>new Promise(r=>requests.set(url,r));const old=t.ctx.rpLoad(1);t.ctx.csSel.l=1;const current=t.ctx.rpLoad(2);requests.get('/api/vocab/lesson-practice?lesson=2')(other);await current;requests.get('/api/vocab/lesson-practice?lesson=1')(data);await old;assert.equal(t.run('RP_STATE.data.lesson'),2);
 // Answers appended during a request survive acknowledging the first event.
 t=setup(data);t.ctx.cpRequest=async(route)=>route==='/start'?{plan:{active:{id:'plan-round',answers:{},corrections:{}}}}:new Promise(r=>{t.resolve=r;});await t.ctx.rpLoad(1);await t.ctx.rpBegin(data.branches[0]);t.ctx.rpAnswer(meaning,meaning.answer);t.ctx.rpAnswer(recall,recall.answer);assert.equal(t.run('RP_STATE.session.pending.length'),2);t.resolve({plan:{},vocab:{}});await new Promise(r=>setImmediate(r));assert.equal(t.run('RP_STATE.session.pending.length'),1);t.resolve({plan:{},vocab:{}});await new Promise(r=>setImmediate(r));assert.equal(t.run('RP_STATE.session.pending.length'),0);
 // The first server-accepted answer wins across devices, including correction eligibility.
 t=setup(data);await t.ctx.rpLoad(1);await t.ctx.rpBegin(data.branches[0]);const conflict=Object.keys(meaning.options).find(k=>k!==meaning.answer);
 t.ctx.allAnswers=Object.fromEntries(data.quiz.questions.map(q=>[q.id,q.answer]));t.ctx.qid=meaning.id;t.ctx.good=meaning.answer;
 t.run('RP_STATE.session.mode="plan";RP_STATE.session.answers=allAnswers;RP_STATE.session.pending=[{questionId:qid,answer:good,phase:"main"}];');
 t.ctx.cpRequest=async()=>({plan:{active:{answers:{[meaning.id]:{letter:conflict,ok:false}},corrections:{}}}});await t.ctx.rpFlush();
 assert.equal(t.run('RP_STATE.session.answers[qid]'),conflict);assert.equal(t.run('rpRemaining("correction").length'),1);
 // Starting a new free round archives the complete old one and creates a fresh identity.
 t=setup(data);await t.ctx.rpLoad(1);await t.ctx.rpBegin(data.branches[0]);const oldId=t.run('RP_STATE.session.id');t.ctx.full=Object.fromEntries(data.quiz.questions.map(q=>[q.id,q.answer]));t.run('rpCommit(s=>{s.answers=full;});');await t.ctx.rpRestart();
 assert.notEqual(t.run('RP_STATE.session.id'),oldId);assert.equal(t.run('Object.keys(RP_STATE.session.answers).length'),0);assert([...t.store.keys()].some(k=>k.endsWith(':history:'+oldId)));
 // Restoring connectivity also sends saved answers from a lesson that is no longer mounted.
 const otherKey='tfl-rp-v2:'+other.lessonId+':'+other.version,oq=other.quiz.questions[0];
 t.store.set(otherKey,JSON.stringify({schema:2,id:'other-round',lessonId:other.lessonId,version:other.version,mode:'plan',answers:{[oq.id]:oq.answer},corrections:{},pending:[{questionId:oq.id,answer:oq.answer,phase:'main'}],wordEvents:{}}));
 t.ctx.cpRequest=async()=>({plan:{active:{answers:{[oq.id]:{letter:oq.answer,ok:true}},corrections:{}}}});await t.ctx.rpFlushSaved();assert.equal(JSON.parse(t.store.get(otherKey)).pending.length,0);
 // A legacy quiz phase cannot keep the study clock alive after root practice finishes.
 const html=fs.readFileSync(path.join(__dirname,'../web/index.html'),'utf8');
 t.ctx.courseById=()=>({lessons:[{id:data.lessonId}]});t.ctx.GQ_UI={phase:'quiz',lessonId:data.lessonId};t.nodes.set('cs-mat-practice',{style:{display:''}});
 t.ctx.document={hidden:false,querySelector:()=>({}),getElementById:()=>({}),body:{classList:{contains:()=>false}}};
 vm.runInContext(html.slice(html.indexOf('function gqActive(){'),html.indexOf('function gqStudyGate()')),t.ctx);
 t.run('RP_STATE.stage="finish";');assert.equal(t.ctx.gqActive(),false);t.run('RP_STATE.stage="quiz";');assert.equal(t.ctx.gqActive(),true);
 t.run('RP_STATE.loading=true;RP_STATE.data=null;');assert.equal(t.ctx.gqActive(),false);t.run('RP_STATE.loading=false;');assert.equal(t.ctx.gqActive(),true,'uncovered lessons keep the existing quiz clock');
 console.log('PASS root client: storage failure, word aggregation, queue failure recovery, no duplicate grade, exact refresh resume, out-of-order lesson requests, concurrent answers during sync, first-answer reconciliation, archived free restart, background lesson retry, root study clock isolation');
})().catch(e=>{console.error(e);process.exitCode=1;});
