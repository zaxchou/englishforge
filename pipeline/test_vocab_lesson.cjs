const fs=require('fs'),path=require('path'),{spawn}=require('child_process'),os=require('os'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tfl-lv-'));const port=8067,base='http://127.0.0.1:'+port;let server;
const env={...process.env,TFL_TLS_KEY:'',TFL_TLS_CERT:'',TFL_AI_KEY:'',TFL_ASR_KEY:'',TFL_TTS_KEY:'',QWEN_TTS_API_KEY:''};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const now=Date.now();
fs.writeFileSync(path.join(dir,'records.json'),JSON.stringify({
  revision:1,vocab:{
    affix:{e:2.5,i:100,s:99,r:2,n:2,at:now-86400000,born:now-86400000,due:now+86400000},
    fixated:{e:2.5,i:6,s:99,r:1,n:1,at:now-86400000,born:now-86400000,due:now-1000}
  },vocabEvents:{},vocabDays:{},attempts:{},qtimes:{},mistakes:{},families:{},course:{},study:{},writing:{},drafts:{},feedback:[]
}));
async function start(){server=spawn(process.execPath,[path.join(root,'server.mjs'),'--port',String(port),'--records',dir],{env,stdio:'ignore',windowsHide:true});for(let i=0;i<120;i++){try{if((await fetch(base+'/api/health')).ok)return}catch{}await sleep(100)}throw Error('server failed');}
async function stop(){const s=server;await new Promise(r=>{s.once('exit',r);s.kill();});}
async function call(route,body){const r=await fetch(base+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});return {status:r.status,data:await r.json()};}
let seq=0;const ev=()=>({lessonId:'cfcm-01-01',id:'lesson-event-'+String(++seq).padStart(4,'0'),key:'',action:''});
const S=async()=> (await call('/api/vocab/lesson')).data.session;
const RS=async()=> (await call('/api/vocab/lesson')).data.reviewSession;
async function advanceTo(key,slot){ for(let i=0;i<260;i++){ const s=slot==='review'?await RS():await S(); if(!s||s.completedAt) throw Error('session ended before '+key); if(s.current===key) return s; const r=await call('/api/vocab/lesson/grade',{lessonId:'cfcm-01-01',slot:slot||'first',id:'adv-'+String(++seq).padStart(4,'0'),key:s.current,action:'know'}); assert.equal(r.status,200); } throw Error('advanceTo not found: '+key); }
async function patch(fn){ await stop(); const rf=path.join(dir,'records.json'); const rec=JSON.parse(fs.readFileSync(rf,'utf8')); fn(rec); fs.writeFileSync(rf,JSON.stringify(rec)); await start(); }
(async()=>{
await start();
// —— 词卡与多课端点
let r=await call('/api/vocab/lesson/cards');assert.equal(r.status,200);assert.equal(r.data.total,176);assert.equal(r.data.noted,138);
r=await call('/api/vocab/lesson/cards?id=cfcm-01-01');assert.equal(r.data.total,176);
r=await call('/api/vocab/lessons');assert.ok(r.data.lessons.some(x=>x.lessonId==='cfcm-01-01'));assert.ok((r.data.keys||[]).length>=176);
assert.equal((await call('/api/vocab/lesson?id=nope')).status,400);
// —— R3.2-2：开学时已有到期词 → 先开复习轮，认读轮稍后
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01'});
assert.equal(r.data.slot,'review');assert.equal(r.data.session.total,1);assert.equal(r.data.session.current,'fixated');
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01'});assert.equal(r.data.resumed,true);assert.equal(r.data.slot,'review');
r=await call('/api/vocab/lesson/grade',{...ev(),slot:'review',key:'fixated',action:'know'});
assert.equal(r.status,200);assert.equal(r.data.slot,'review');assert.equal(r.data.wrote,true);assert.equal(r.data.st.i,15);assert.ok(r.data.st.due>Date.now());
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01'});
assert.equal(r.data.slot,'first');assert.equal(r.data.session.total,176);assert.equal(r.data.session.current,'affix');assert.equal(r.data.session.remaining,176);
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01'});assert.equal(r.data.resumed,true);assert.equal(r.data.slot,'first');
// —— 未到期旧词：认识后原到期时间与间隔不变（冻结）
let e=ev();e.key='affix';e.action='know';r=await call('/api/vocab/lesson/grade',e);assert.equal(r.status,200);assert.equal(r.data.wrote,false);
let snap=(await call('/api/records')).data;assert.equal(snap.vocab.affix.i,100);assert.equal(snap.vocab.affix.n,2);assert.equal(snap.vocab.affix.due,now+86400000);
const replay=await call('/api/vocab/lesson/grade',e);assert.equal(replay.data.duplicate,true);
assert.equal((await call('/api/vocab/lesson/grade',{...e,action:'again'})).status,409);
// —— 新课新词：首次 3 天
await advanceTo('fix');
r=await call('/api/vocab/lesson/grade',{...ev(),key:'fix',action:'know'});assert.equal(r.data.st.i,4320);assert.equal(r.data.st.s,99);
// —— 重启持久化
const pre=await S();await stop();await start();r=await S();assert.equal(r.doneCount,pre.doneCount);assert.equal(r.current,pre.current);
// —— 重开 → 新认读轮（复习位保留）
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01',restart:true});assert.equal(r.data.slot,'first');assert.equal(r.data.session.doneCount,0);assert.equal(r.data.session.current,'affix');
// —— C1：未到期旧词看卡后认出 → 遗忘（1 天、ease-0.2）+ 轮末重考
r=await call('/api/vocab/lesson/grade',{...ev(),key:'affix',action:'again'});assert.equal(r.status,200);
r=await call('/api/vocab/lesson/grade',{...ev(),key:'affix',action:'continue'});assert.equal(r.status,200);
await advanceTo('affix');
r=await call('/api/vocab/lesson/grade',{...ev(),key:'affix',action:'know'});
assert.equal(r.data.wrote,true);assert.equal(r.data.st.i,1440);assert.equal(r.data.st.e,2.3);
assert.equal((await S()).rechecked.affix,1);
// —— C2：看卡后认出的新词 → 次日
await advanceTo('cross');
r=await call('/api/vocab/lesson/grade',{...ev(),key:'cross',action:'again'});assert.equal(r.status,200);
r=await call('/api/vocab/lesson/grade',{...ev(),key:'cross',action:'continue'});assert.equal(r.status,200);
await advanceTo('cross');
r=await call('/api/vocab/lesson/grade',{...ev(),key:'cross',action:'know'});
assert.equal(r.data.wrote,true);assert.equal(r.data.st.i,1440);assert.equal(r.data.st.e,2.5);
// —— 跨端点事件 id 与当前词守门
assert.equal((await call('/api/vocab/grade',{id:'legacy-cross0001',word:'fix',rating:3,at:Date.now()})).status,200);
assert.equal((await call('/api/vocab/lesson/grade',{lessonId:'cfcm-01-01',slot:'first',id:'legacy-cross0001',key:'affix',action:'know'})).status,409);
assert.equal((await call('/api/vocab/lesson/grade',{...ev(),key:'affix',action:'know'})).status,409);
// —— R3.2-2（进行中）：认读没过完时出现到期词 → 另开复习位，认读进度保留
await patch(rec=>{ const k='fix'; if(rec.vocab[k]) rec.vocab[k].due=Date.now()-1000; });
// —— R4.2-3：显式 slot=first 跳过到期优先（复习完成页的「继续认读」按钮）
const firstAtPatch=(await S()).doneCount;
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01',slot:'first'});
assert.equal(r.data.slot,'first');assert.equal(r.data.session.doneCount,firstAtPatch);assert.ok(r.data.session.current);
assert.equal(r.data.firstSession.doneCount,firstAtPatch);
r=await call('/api/vocab/lesson');
assert.ok(r.data.firstSession&&!r.data.firstSession.completedAt&&r.data.firstSession.remaining>0);
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01'});
assert.equal(r.data.slot,'review');assert.equal(r.data.session.current,'fix');
const firstBefore=(await S()).doneCount;
r=await call('/api/vocab/lesson/grade',{...ev(),slot:'review',key:'fix',action:'know'});assert.equal(r.status,200);assert.equal(r.data.wrote,true);
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01'});
assert.equal(r.data.slot,'first');assert.equal(r.data.session.doneCount,firstBefore,'复习轮不应动认读轮进度');
// —— 快照隔离
snap=(await call('/api/records')).data;const keepFirst=JSON.stringify(snap.vocabLesson), keepReview=JSON.stringify(snap.vocabLessonReview);
snap.vocabLesson={'hacked':1};snap.vocabLessonReview={'hacked':1};snap.attemptProtocol=2;snap.snapshotId='lesson-snapshot-0001';
assert.equal((await call('/api/records',snap)).status,200);
snap=(await call('/api/records')).data;assert.equal(JSON.stringify(snap.vocabLesson),keepFirst);assert.equal(JSON.stringify(snap.vocabLessonReview),keepReview);
// —— 走完认读轮：轮末重考不再写、归档 tries、nextDueAt
let lastGrade=null;
for(let guard=0;guard<600;guard++){
  const s=await S(); if(s.completedAt) break;
  if(s.front===1){ lastGrade=await call('/api/vocab/lesson/grade',{lessonId:'cfcm-01-01',slot:'first',id:'drain-c-'+guard,key:s.current,action:'continue'}); continue; }
  lastGrade=await call('/api/vocab/lesson/grade',{lessonId:'cfcm-01-01',slot:'first',id:'drain-k-'+guard,key:s.current,action:'know'});
}
r=await call('/api/vocab/lesson');const fin=r.data.session;
assert.ok(fin.completedAt);assert.equal(fin.remaining,0);assert.ok(fin.nextDueAt>Date.now());
// —— R4.2-2：完成页「看卡最多的词」带词义与老师讲解（GET 与 grade 响应都要有）
assert.ok(r.data.hardWords.length>0);assert.ok(Array.isArray(r.data.reviewHardWords));
for(const h of r.data.hardWords){ assert.ok(h.word);assert.equal(typeof h.def,'string');assert.equal(typeof h.note,'string');assert.ok(h.tries>=1); }
assert.ok(lastGrade&&Array.isArray(lastGrade.data.hardWords)&&lastGrade.data.hardWords.length>0,'grade 响应应带 hardWords');
// —— 有会话后课程概览仍可读（横幅/徽标依赖；曾因重复 publicSession 崩）
r=await call('/api/vocab/lessons');
const l0=(r.data.lessons||[]).find(x=>x.lessonId==='cfcm-01-01');
assert.ok(l0&&l0.session&&l0.session.doneCount>0&&l0.session.remaining===0);
assert.ok(l0.reviewSession===null||typeof l0.reviewSession==='object');
assert.equal(fin.history[0].tries.affix,1);assert.equal(fin.history[0].tries.cross,1);
// —— 完成后无到期 → start 留在认读位；复习位结果仍可读
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01'});assert.equal(r.data.slot,'first');assert.equal(r.data.resumed,true);
r=await call('/api/vocab/lesson');assert.equal(r.data.review.due,0);assert.ok(r.data.review.tomorrow>=1);
assert.ok(r.data.reviewSession&&r.data.reviewSession.completedAt,'复习位应保留上一轮结果');
assert.ok(Array.isArray(r.data.hardWords));
// —— R3.2-4：复习轮 40 上限；做完一轮仍有到期 → 再开下一轮
await patch(rec=>{ let n=0; const skip=new Set(['affix','cross','fix','fixity','fixed','fixer']);
  for(const [k,v] of Object.entries(rec.vocab)){ if(n>=45) break; if(skip.has(k)) continue; v.due=Date.now()-1000; n++; } });
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01'});
assert.equal(r.data.slot,'review');assert.equal(r.data.session.remaining,40);assert.equal(r.data.session.total,40);
for(let i=0;i<40;i++){ const s=await RS(); if(s.completedAt) break; const rr=await call('/api/vocab/lesson/grade',{lessonId:'cfcm-01-01',slot:'review',id:'cap-'+String(i).padStart(4,'0'),key:s.current,action:'know'}); assert.equal(rr.status,200); }
r=await call('/api/vocab/lesson');assert.ok(r.data.reviewSession&&r.data.reviewSession.completedAt);assert.equal(r.data.review.due,5);
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01'});assert.equal(r.data.slot,'review');assert.equal(r.data.session.remaining,5);
console.log('PASS lesson vocab: cards/lessons, due-first review slot, first pass 176, freeze, initial 3d, restart, lapse rules, next-day, slot isolation, cross-endpoint ids, review mid-round, explicit first slot, hardWords payload, snapshot isolation, drain + archive + nextDueAt');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>server?.kill());
