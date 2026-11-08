import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.TFL_ROOT_QA || path.join(project, 'build/qa/root-universe/fix-20261109/root-recovery');
fs.mkdirSync(outDir, { recursive:true });
const { createRootPractice } = await import(pathToFileURL(path.join(project, 'root-practice.mjs')));
const { createCoursePlanHandler } = await import(pathToFileURL(path.join(project, 'course-plan.mjs')));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'junenglish-root-recovery-'));
const learning = path.join(temporary, 'learning');
const source = fs.readFileSync(path.join(project, 'web/root-practice-ui.js'), 'utf8');
const clone = x => JSON.parse(JSON.stringify(x));
function publish(revision, changed=false) {
  const entry = { id:'cfcm-01', schema_version:'1.1.0', roots:[{id:'r',label:'r',meaning:'test'}],
    words:['alpha','beta'].map((word,i)=>({id:'w'+i,word,meaning:'meaning '+i+(changed?' changed':''),explanation:'unchanged explanation',root_ids:['r']})),
    alliance:{id:'cfcm-01',title:'Fixture '+revision,words:[],branches:[{id:'b',title:'Fixture',idea:'',word_ids:['w0','w1']}]}};
  const bytes=JSON.stringify(entry), version=createHash('sha256').update(bytes).digest('hex');
  const dir=path.join(learning,'cfcm-01','versions',version);
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'entry.json'),bytes);
  fs.writeFileSync(path.join(learning,'cfcm-01','current.json'),JSON.stringify({id:'cfcm-01',version}));
  return version;
}
publish(1);
const practice=createRootPractice(learning);
function backend(){
  let records={version:1,attempts:{},course:{}},grades=0;
  const recordFile=path.join(temporary,'records-'+randomUUID()+'.json');
  const handler=createCoursePlanHandler({records:()=>records,setRecords:x=>{records=x;},save:x=>fs.writeFileSync(recordFile,JSON.stringify(x)),
    quizzes:()=>practice.quizzes(),rootQuizVersion:(lid,v)=>practice.lessonVersion(Number(lid.slice(-2)),v)?.quiz,now:()=>1700000000000,
    gradeRootWord:(r,event)=>{grades++;r.vocabEvents||={};r.vocabEvents[event.id]=event;r.vocab||={};r.vocab[event.word]={n:(r.vocab[event.word]?.n||0)+1};}});
  async function request(suffix,input){let reply;
    await handler.handle({method:input===undefined?'GET':'POST',headers:{host:'isolated.test','content-type':'application/json'}},{},'/api/course-plan'+suffix,
      async()=>Buffer.from(JSON.stringify(input)),(_res,status,body)=>{reply={status,body};});
    if(reply.status>=400)throw Object.assign(new Error(reply.body.error),{code:reply.body.code,status:reply.status,reply});
    return reply.body;
  }
  return {request,records:()=>clone(records),grades:()=>grades};
}
const serverSource=fs.readFileSync(path.join(project,'server.mjs'),'utf8');
function between(from,to){const start=serverSource.indexOf(from);assert(start>=0,from);const end=serverSource.indexOf(to,start);assert(end>start,to);return serverSource.slice(start,end);}
function isolatedGradeEndpoint(){
  const recordFile=path.join(temporary,'grade-'+randomUUID()+'.json');
  const c=vm.createContext({createHash,console,Buffer,vocabIndex:()=>new Map([['alpha',{w:'alpha'}],['beta',{w:'beta'}]]),
    recordsSave:r=>fs.writeFileSync(recordFile,JSON.stringify(r)),readBody:async req=>Buffer.from(JSON.stringify(req.payload)),sendJSON:(_res,status,body)=>({status,body})});
  vm.runInContext(between('const vocabKey =','function vocabIndex()')+between('const SM2_DEF =','/* 发音:')+
    between('function vocabStateValid(st)','/* ---------- 题库目录')+
    'let RECORDS={version:1};globalThis.grade=async function(payload){const req={method:"POST",headers:{host:"isolated.test","content-type":"application/json"},payload},res={},p="/api/vocab/grade";'+
    between("    if (p === '/api/vocab/grade') {",'    /* ---- API: 背单词发音')+'};globalThis.records=()=>JSON.parse(JSON.stringify(RECORDS));',c);
  return c;
}
function storage(){const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),key:i=>[...values.keys()][i]??null,get length(){return values.size;}};}
function tab(shared,api=async()=>{throw Error('offline');}){
  const context=vm.createContext({localStorage:shared,window:{addEventListener(){}},crypto:{randomUUID},console,esc:s=>String(s??''),
    cpRequest:api,cpLoad:async()=>{},CP:{data:{plans:{}}},REC:{},VB_PREFIX:'vb-',vbFlushQueue(){},gqRefreshList(){},cpBadgeUpdate(){},
    csSel:{c:'cfcm-01',l:0},$:()=>({}),AbortSignal,api:async url=>{const u=new URL(url,'http://isolated.test');return u.searchParams.has('version')?practice.lessonVersion(1,u.searchParams.get('version')):practice.lesson(1);},renderGenQuiz(){}});
  vm.runInContext(source+'\nrpRender=()=>{};globalThis.ui={state:RP_STATE,key:rpKey,roundKey:rpRoundKey,answer:rpAnswer,flush:rpFlush,flushSaved:rpFlushSaved,load:rpLoad,begin:rpBegin,store:rpStore,recoveryHTML:rpRecoveryHTML};',context);
  return context;
}
function session(data,id,mode='plan'){return {schema:2,id,version:data.version,lessonId:data.lessonId,mode,answers:{},corrections:{},pending:[],wordEvents:{},branch:'b:1',stage:'quiz',phase:'main',question:'q1'};}
function attach(t,data,s){Object.assign(t.ui.state,{data:clone(data),session:clone(s),request:1,lesson:1,phase:'main',stage:'quiz',branch:'b:1',question:'q1'});}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const results=[];
let exitCode=0;
try {
  // N01: separate durable events survive both stale tab writes and an explicitly damaged snapshot.
  {
    const data=practice.lesson(1),shared=storage(),s=session(data,'offline-round'),a=tab(shared),b=tab(shared);
    attach(a,data,s);attach(b,data,s);
    a.ui.answer(data.quiz.questions[0],data.quiz.questions[0].answer);await tick();
    b.ui.answer(data.quiz.questions[1],data.quiz.questions[1].answer);await tick();
    const afterB=JSON.parse(shared.getItem(a.ui.key(data)));
    assert.deepEqual(Object.keys(afterB.answers).sort(),['q1','q2']);assert.equal(afterB.pending.length,2);
    // A snapshot alone is no longer the only durable source of an unacknowledged answer.
    shared.setItem(a.ui.key(data),JSON.stringify({...s,answers:{q2:data.quiz.questions[1].answer},pending:[{questionId:'q2',answer:data.quiz.questions[1].answer,phase:'main'}]}));
    const reopened=tab(shared);await reopened.ui.load(1);await tick();
    assert.deepEqual(Object.keys(reopened.ui.state.session.answers).sort(),['q1','q2']);assert.equal(reopened.ui.state.session.pending.length,2);
    const newer=session(data,'different-round');reopened.ui.store(newer,true);a.ui.store({...s,stage:'read'});
    assert.equal(JSON.parse(shared.getItem(a.ui.key(data))).id,newer.id);
    assert.equal(Object.keys(JSON.parse(shared.getItem(a.ui.key(data))).answers).length,0,'rounds never merge');
    results.push({case:'N01 independent answers survive stale tabs and snapshot replacement; different rounds stay isolated',answers:afterB.answers,pending:afterB.pending.length});
  }
  // N02: same round/word keeps its first rating, timestamp and ID, including legacy UUID migration.
  {
    const data=practice.lesson(1),shared=storage(),s=session(data,'shared-free-round','free'),a=tab(shared),b=tab(shared),q=data.quiz.questions[0];
    attach(a,data,s);attach(b,data,s);
    const wrong=Object.keys(q.options).find(k=>k!==q.answer);
    a.ui.answer(q,wrong);await tick();b.ui.answer(q,q.answer);await tick();await b.ui.flush();
    const queued=[];for(let i=0;i<shared.length;i++){const k=shared.key(i);if(k.startsWith('vb-'))queued.push(JSON.parse(shared.getItem(k)));}
    assert.equal(queued.length,1);assert.equal(queued[0].rating,1);assert.equal(queued[0].rootRound,s.id);
    const payload=clone(queued[0]);await a.ui.flush();assert.deepEqual(JSON.parse(shared.getItem('vb-'+payload.id)),payload);
    const endpoint=isolatedGradeEndpoint();assert.equal((await endpoint.grade(payload)).status,200);
    assert.equal((await endpoint.grade({...payload,rating:3,at:payload.at+100})).status,200);
    assert.equal((await endpoint.grade({...payload,id:'old-second-uuid',rating:3,at:payload.at+200})).status,200);
    assert.equal(endpoint.records().vocab.alpha.n,1);assert.equal(Object.values(endpoint.records().vocabDays)[0].grades,1);
    const legacyEndpoint=isolatedGradeEndpoint(),legacy={id:'rp-old-accepted-uuid',word:'alpha',rating:3,at:1699999999000};
    assert.equal((await legacyEndpoint.grade(legacy)).status,200);
    assert.equal((await legacyEndpoint.grade({...legacy,rating:1})).status,409,'ordinary event conflicts stay strict');
    const old=session(data,'legacy-free-round','free');old.answers[q.id]=q.answer;old.wordEvents.alpha={...legacy,queued:true};
    const oldTab=tab(storage());attach(oldTab,data,old);await oldTab.ui.flush();
    const migrated=JSON.parse(oldTab.localStorage.getItem('vb-'+legacy.id));assert.equal(migrated.id,legacy.id);assert.equal(migrated.at,legacy.at);
    assert.equal((await legacyEndpoint.grade(migrated)).status,200);
    assert.equal((await legacyEndpoint.grade({...migrated,id:'rpf-new-scope-id',rating:1,at:legacy.at+10})).status,200);
    assert.equal(legacyEndpoint.records().vocab.alpha.n,1,'legacy accepted event must not advance again');
    results.push({case:'N02 stable first settlement and old UUID retry are idempotent',payload,newRoundGrades:endpoint.records().vocab.alpha.n,legacyGrades:legacyEndpoint.records().vocab.alpha.n});
  }
  // N03: old complete free rounds are archived; the next click asks the plan, which decides due/free.
  {
    const data=practice.lesson(1),shared=storage(),requests=[];let due=false;
    const t=tab(shared,async(suffix,payload)=>{requests.push({suffix,payload});if(!due)throw Object.assign(Error('not due'),{code:'plan_not_due'});return {plan:{active:{id:'next-due-round',answers:{},corrections:{}}}};});
    const old=session(data,'completed-free-round','free');old.answers=Object.fromEntries(data.quiz.questions.map(q=>[q.id,q.answer]));old.stage='finish';
    attach(t,data,old);shared.setItem(t.ui.key(data),JSON.stringify(old));
    await t.ui.begin(data.branches[0]);assert.equal(requests.length,1);assert.equal(t.ui.state.session.mode,'free');assert.notEqual(t.ui.state.session.id,old.id);
    assert(JSON.parse(shared.getItem(t.ui.key(data)+':history:'+old.id)).finished);
    t.ui.store({...t.ui.state.session,answers:clone(old.answers)});assert.equal(t.ui.state.session.finished,true);
    due=true;await t.ui.load(1);await tick();await t.ui.begin(data.branches[0]);
    assert.equal(requests.length,2);assert.equal(t.ui.state.session.mode,'plan');assert.equal(t.ui.state.session.id,'next-due-round');
    results.push({case:'N03 completed free round archives and naturally enters due plan; not-due remains free',startRequests:requests.length,currentRound:t.ui.state.session.id});
  }
  // N04: after another tab finishes, only an already accepted identical answer can be confirmed.
  {
    const api=backend(),data=practice.lesson(1),started=await api.request('/start',{lessonId:data.lessonId}),id=started.plan.active.id,pending=[];
    for(const q of data.quiz.questions){const e={questionId:q.id,answer:q.answer,phase:'main'};await api.request('/root-answer',{lessonId:data.lessonId,version:data.version,roundId:id,...e});pending.push(e);}
    const grades=api.grades();await api.request('/finish',{lessonId:data.lessonId,roundId:id,rating:'good'});
    const replay={lessonId:data.lessonId,version:data.version,roundId:id,...pending.at(-1)},reply=await api.request('/root-answer',replay);
    assert.equal(reply.round.archived,true);assert.equal(reply.round.completed,true);assert(reply.round.finishedAt);
    await assert.rejects(()=>api.request('/root-answer',{...replay,answer:'different'}),e=>e.status===409);
    await assert.rejects(()=>api.request('/root-answer',{...replay,questionId:'q3'}),e=>e.status===409);
    await assert.rejects(()=>api.request('/root-answer',{...replay,phase:'correction'}),e=>e.status===409);
    const shared=storage(),t=tab(shared,api.request),s=session(data,id);s.answers=Object.fromEntries(data.quiz.questions.map(q=>[q.id,q.answer]));s.pending=[pending.at(-1)];attach(t,data,s);shared.setItem(t.ui.key(data),JSON.stringify(s));
    await t.ui.flush();assert.equal(t.ui.state.session.pending.length,0);assert.equal(t.ui.state.session.finished,true);
    await t.ui.load(1);await tick();assert.equal(t.ui.state.session.pending.length,0);assert.equal(api.grades(),grades);
    assert.equal(api.records().coursePlan.plans[data.lessonId].stamps.length,1);
    assert.equal(Object.keys(api.records().coursePlan.plans[data.lessonId].archivedRounds[0].wordGrades).length,2);
    results.push({case:'N04 lost acknowledgement replays after finish without accepting new/wrong/correction answers',pending:t.ui.state.session.pending.length,gradeCalls:api.grades(),archived:reply.round.archived,completed:reply.round.completed});
  }
  // N05: compatibility is proved by hash-verified archived questions, never the client version assertion.
  {
    const api=backend(),data=practice.lesson(1),started=await api.request('/start',{lessonId:data.lessonId}),shared=storage(),offline=tab(shared),s=session(data,started.plan.active.id);
    attach(offline,data,s);offline.ui.answer(data.quiz.questions[0],data.quiz.questions[0].answer);await tick();
    // A pre-fix session has neither embedded questions nor a supplied round signature.
    for(const key of [offline.ui.key(data),offline.ui.roundKey(s)]){const old=JSON.parse(shared.getItem(key));delete old.questions;shared.setItem(key,JSON.stringify(old));}
    publish(2);assert.deepEqual(practice.lesson(1).quiz.questions,data.quiz.questions);await api.request('');
    const online=tab(shared,api.request);await online.ui.load(1);await tick();await online.ui.flush();
    assert.equal(online.ui.state.session.id,s.id);assert.equal(online.ui.state.session.pending.length,0);
    assert.equal(api.records().coursePlan.plans[data.lessonId].active.answers.q1.letter,data.quiz.questions[0].answer);
    await assert.rejects(()=>api.request('/root-answer',{lessonId:data.lessonId,version:'f'.repeat(64),roundId:s.id,questionId:'q2',answer:data.quiz.questions[1].answer,phase:'main'}),e=>e.code==='question_version_changed');
    // A real edit must not apply an unsent old answer to the replacement round.
    const oldTab=tab(shared);attach(oldTab,data,online.ui.state.session);oldTab.ui.answer(data.quiz.questions[1],data.quiz.questions[1].answer);await tick();
    publish(3,true);await api.request('');
    await assert.rejects(()=>api.request('/root-answer',{lessonId:data.lessonId,version:data.version,roundId:s.id,questionId:'q2',answer:data.quiz.questions[1].answer,phase:'main'}),e=>e.status===409);
    const changed=tab(shared,api.request);await changed.ui.load(1);await tick();await changed.ui.flushSaved();
    assert.equal(changed.ui.state.session,null);assert.equal(changed.ui.state.recovery.length,1);
    const kept=changed.ui.state.recovery[0].session;assert.equal(kept.pending.length,1);assert.equal(Object.keys(kept.answers).length,2);
    const html=changed.ui.recoveryHTML();assert.match(html,/旧版／旧轮记录已保留/);assert(html.includes(data.quiz.questions[0].stem));assert.match(html,/首次回答/);
    assert.deepEqual(api.records().coursePlan.plans[data.lessonId].active.answers,{});
    const confirmation=await api.request('/root-answer',{lessonId:data.lessonId,version:data.version,roundId:s.id,questionId:'q1',answer:data.quiz.questions[0].answer,phase:'main'});
    assert.equal(confirmation.round.archived,true);assert.equal(confirmation.round.completed,false);
    await changed.ui.begin(practice.lesson(1).branches[0]);assert.equal(changed.ui.state.session.mode,'plan');assert.notEqual(changed.ui.state.session.id,s.id);
    assert.equal(JSON.parse(shared.getItem(offline.ui.roundKey(s))).pending.length,1,'old pending is preserved, not cleared to fake sync');
    results.push({case:'N05 title-only publication restores old session; real question edits retain visible review and reject stale new answers',compatibleRecovered:s.id,oldPending:kept.pending.length,visibleRecovery:true,newRound:changed.ui.state.session.id});
  }
  console.log('PASS root recovery: N01 independent events, N02 stable/legacy settlement, N03 free completion, N04 archived acknowledgement, N05 verified version recovery and visible obsolete records');
} catch(error) {
  exitCode=1;results.push({case:'failure',error:error.stack});console.error(error);
} finally {
  fs.writeFileSync(path.join(outDir,'root-recovery-results.json'),JSON.stringify({temporary,exitCode,results},null,2));
  fs.writeFileSync(path.join(outDir,'exit-code.txt'),String(exitCode)+'\n');
  process.exitCode=exitCode;
}
