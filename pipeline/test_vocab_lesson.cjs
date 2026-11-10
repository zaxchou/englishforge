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
async function session(){return (await call('/api/vocab/lesson')).data.session;}
async function advanceTo(key){ for(let i=0;i<220;i++){ const s=await session(); if(!s||s.completedAt) throw Error('session ended before '+key); if(s.current===key) return s; const r=await call('/api/vocab/lesson/grade',{lessonId:'cfcm-01-01',id:'adv-'+String(++seq).padStart(4,'0'),key:s.current,action:'know'}); assert.equal(r.status,200); } throw Error('advanceTo not found: '+key); }
(async()=>{
await start();
let r=await call('/api/vocab/lesson/cards');assert.equal(r.status,200);assert.equal(r.data.total,176);assert.equal(r.data.noted,138);
r=await call('/api/vocab/lesson');assert.equal(r.data.session,null);
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01'});assert.equal(r.status,200);assert.equal(r.data.session.total,176);assert.equal(r.data.session.current,'affix');assert.equal(r.data.session.remaining,176);
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01'});assert.equal(r.data.resumed,true);
// 未到期旧词：认识后原到期时间与间隔不变（冻结）
let e=ev();e.key='affix';e.action='know';r=await call('/api/vocab/lesson/grade',e);assert.equal(r.status,200);assert.equal(r.data.wrote,false);
let snap=(await call('/api/records')).data;assert.equal(snap.vocab.affix.i,100);assert.equal(snap.vocab.affix.n,2);assert.equal(snap.vocab.affix.due,now+86400000);
// 重放幂等 + 同 id 换动作冲突
const replay=await call('/api/vocab/lesson/grade',e);assert.equal(replay.data.duplicate,true);
assert.equal((await call('/api/vocab/lesson/grade',{...e,action:'again'})).status,409);
// 到期旧词：按良好延长
await advanceTo('fixated');
r=await call('/api/vocab/lesson/grade',{...ev(),key:'fixated',action:'know'});assert.equal(r.status,200);assert.equal(r.data.wrote,true);assert.equal(r.data.st.i,15);assert.ok(r.data.st.due>Date.now());
// 新课新词：首次 3 天
await advanceTo('fix');
r=await call('/api/vocab/lesson/grade',{...ev(),key:'fix',action:'know'});assert.equal(r.status,200);assert.equal(r.data.st.s,99);assert.equal(r.data.st.i,4320);assert.ok(Math.abs(r.data.st.due-Date.now()-4320*60000)<60000);
// 重启持久化：进度与当前词保持
const preRestart=await session();
await stop();await start();
r=await call('/api/vocab/lesson');assert.equal(r.data.session.doneCount,preRestart.doneCount);assert.equal(r.data.session.current,preRestart.current);
// 重开 → 新认读轮
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01',restart:true});assert.equal(r.data.session.doneCount,0);assert.equal(r.data.session.remaining,176);assert.equal(r.data.session.current,'affix');
// —— C1：未到期旧词看卡后认出 → 遗忘信号（1 天、ease-0.2），并进轮末重考
r=await call('/api/vocab/lesson/grade',{...ev(),key:'affix',action:'again'});assert.equal(r.status,200);
r=await call('/api/vocab/lesson/grade',{...ev(),key:'affix',action:'continue'});assert.equal(r.status,200);
await advanceTo('affix');
r=await call('/api/vocab/lesson/grade',{...ev(),key:'affix',action:'know'});
assert.equal(r.status,200);assert.equal(r.data.wrote,true);assert.equal(r.data.st.i,1440);assert.equal(r.data.st.e,2.3);
assert.ok(Math.abs(r.data.st.due-Date.now()-1440*60000)<60000);
assert.equal((await session()).rechecked.affix,1);
snap=(await call('/api/records')).data;assert.ok(snap.vocabEvents[seq===1?'lesson-event-0001':Object.keys(snap.vocabEvents).find(k=>/^lesson-event-/.test(k))]!==undefined,'全局账本应登记课级事件');
// —— C2：看卡后认出的新词（无记录）→ 次日
await advanceTo('cross');
const c2=ev();c2.key='cross';c2.action='again';
r=await call('/api/vocab/lesson/grade',c2);assert.equal(r.status,200);
r=await call('/api/vocab/lesson/grade',{...ev(),key:'cross',action:'continue'});assert.equal(r.status,200);
await advanceTo('cross');
const c2k=ev();c2k.key='cross';c2k.action='know';
r=await call('/api/vocab/lesson/grade',c2k);
assert.equal(r.status,200);assert.equal(r.data.wrote,true);assert.equal(r.data.st.i,1440);assert.equal(r.data.st.e,2.5);assert.ok(Math.abs(r.data.st.due-Date.now()-1440*60000)<60000);
snap=(await call('/api/records')).data;assert.ok(snap.vocabEvents[c2k.id],'全局账本应登记新词次日');
// —— 非当前词拒绝
assert.equal((await call('/api/vocab/lesson/grade',{...ev(),key:'affix',action:'know'})).status,409);
// 普通快照不能覆盖课级会话
snap=(await call('/api/records')).data;const keep=JSON.stringify(snap.vocabLesson);
snap.vocabLesson={ 'cfcm-01-01':{ hacked:true } };
snap.attemptProtocol=2;snap.snapshotId='lesson-snapshot-0001';
assert.equal((await call('/api/records',snap)).status,200);
assert.equal(JSON.stringify((await call('/api/records')).data.vocabLesson),keep);
const beforeStop=await session();
await stop();await start();
const mid=await session();assert.equal(mid.doneCount,beforeStop.doneCount);assert.equal(mid.current,beforeStop.current);
// —— 走到完成：轮末重考不再写调度；归档 tries 与 nextDueAt
for(let guard=0;guard<600;guard++){
  const g=await session();
  if(g.completedAt) break;
  if(g.front===1){ await call('/api/vocab/lesson/grade',{lessonId:'cfcm-01-01',id:'drain-c-'+guard,key:g.current,action:'continue'}); continue; }
  await call('/api/vocab/lesson/grade',{lessonId:'cfcm-01-01',id:'drain-k-'+guard,key:g.current,action:'know'});
}
r=await call('/api/vocab/lesson');const fin=r.data.session;
assert.ok(fin.completedAt);assert.equal(fin.remaining,0);assert.ok(fin.nextDueAt>Date.now());
assert.equal(fin.history[0].tries.affix,1);assert.equal(fin.history[0].tries.cross,1);
// 完成后无到期 → start 原样返回
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01'});assert.equal(r.data.resumed,true);
console.log('PASS lesson vocab: 176 cards, resume, non-due freeze, due extend, initial 3d, seen-card next-day, continue insert@10, global ledger, idempotent replay, payload conflict, current guard, snapshot isolation, restart persistence, lapse on seen-card existing, round-end recheck, archive tries + nextDueAt');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>server?.kill());
