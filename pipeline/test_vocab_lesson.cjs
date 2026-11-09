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
const event=n=>({lessonId:'cfcm-01-01',id:'lesson-event-'+String(n).padStart(4,'0'),key:'',action:'',});
(async()=>{
await start();
let r=await call('/api/vocab/lesson/cards');assert.equal(r.status,200);assert.equal(r.data.total,176);assert.equal(r.data.noted,138);
r=await call('/api/vocab/lesson');assert.equal(r.data.session,null);
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01'});assert.equal(r.status,200);assert.equal(r.data.session.total,176);assert.equal(r.data.session.current,'affix');assert.equal(r.data.session.remaining,176);
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01'});assert.equal(r.data.resumed,true);
// 未到期旧词：认识后原到期时间与间隔不变
let e={...event(1),key:'affix',action:'know'};r=await call('/api/vocab/lesson/grade',e);assert.equal(r.status,200);assert.equal(r.data.session.doneCount,1);assert.equal(r.data.wrote,false);
let snap=(await call('/api/records')).data;assert.equal(snap.vocab.affix.i,100);assert.equal(snap.vocab.affix.n,2);assert.equal(snap.vocab.affix.due,now+86400000);
// 重放幂等
const replay=await call('/api/vocab/lesson/grade',e);assert.equal(replay.data.duplicate,true);assert.equal(replay.data.session.doneCount,1);
assert.equal((await call('/api/vocab/lesson/grade',{...e,action:'again'})).status,409);
// 到期旧词：按良好延长
r=await call('/api/vocab/lesson/grade',{...event(2),key:'fixated',action:'know'});assert.equal(r.status,200);assert.equal(r.data.wrote,true);assert.ok(r.data.st.due>Date.now());
// 新课新词：首次 3 天、已毕业
r=await call('/api/vocab/lesson/grade',{...event(3),key:'fix',action:'know'});assert.equal(r.status,200);assert.equal(r.data.st.s,99);assert.equal(r.data.st.i,4320);assert.ok(Math.abs(r.data.st.due-Date.now()-4320*60000)<60000);
// 不认识→继续：回到队尾，不改变调度
const before=(await call('/api/records')).data.vocab;
r=await call('/api/vocab/lesson/grade',{...event(4),key:'fixity',action:'again'});assert.equal(r.data.session.front,1);assert.equal(r.data.session.current,'fixity');
r=await call('/api/vocab/lesson/grade',{...event(5),key:'fixity',action:'continue'});assert.equal(r.data.session.front,0);assert.equal(r.data.session.remaining,173);assert.equal(r.data.session.doneCount,3);assert.equal(r.data.session.current,'fixed');
const after=(await call('/api/records')).data.vocab;assert.deepEqual(after.fixity,before.fixity);
// 非当前词拒绝
assert.equal((await call('/api/vocab/lesson/grade',{...event(6),key:'prefix',action:'know'})).status,409);
// 普通快照不能覆盖课级会话
snap=(await call('/api/records')).data;const keep=JSON.stringify(snap.vocabLesson);
snap.vocabLesson={ 'cfcm-01-01':{ hacked:true } };
snap.attemptProtocol=2;snap.snapshotId='lesson-snapshot-0001';
assert.equal((await call('/api/records',snap)).status,200);
assert.equal(JSON.stringify((await call('/api/records')).data.vocabLesson),keep);
await stop();await start();
r=await call('/api/vocab/lesson');assert.equal(r.data.session.doneCount,3);assert.equal(r.data.session.current,'fixed');
// 重新开始保留历史，队列回满
r=await call('/api/vocab/lesson/start',{lessonId:'cfcm-01-01',restart:true});assert.equal(r.data.session.doneCount,0);assert.equal(r.data.session.remaining,176);assert.equal(r.data.session.current,'affix');
console.log('PASS lesson vocab: 176 cards, resume, non-due freeze, due extend, initial 3d, again/continue requeue, idempotent replay, payload conflict, current guard, snapshot isolation, restart persistence, restart resets queue');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>server?.kill());
