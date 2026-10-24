const fs=require('fs'),path=require('path'),{spawn}=require('child_process'),os=require('os'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tfl-vocab-api-'));const base='http://127.0.0.1:8066';let server;
const env={...process.env,TFL_TLS_KEY:'',TFL_TLS_CERT:'',TFL_AI_KEY:'',TFL_ASR_KEY:'',TFL_TTS_KEY:'',QWEN_TTS_API_KEY:''};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function start(){server=spawn(process.execPath,[path.join(root,'server.mjs'),'--port','8066','--records',dir],{env,stdio:'ignore',windowsHide:true});for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)return}catch{}await sleep(100)}throw Error('server failed');}
async function stop(){const s=server;await new Promise(r=>{s.once('exit',r);s.kill();});}
async function call(route,body){const r=await fetch(base+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});return {status:r.status,data:await r.json()};}
(async()=>{
await start();const event={id:'vocab-test-event-0001',word:'affix',rating:4,at:Date.now()-3600000};
const first=await call('/api/vocab/grade',event);assert.equal(first.status,200);assert.equal(first.data.st.n,1);const born=first.data.st.born;
const retry=await call('/api/vocab/grade',event);assert.equal(retry.data.st.n,1);assert.equal(retry.data.duplicate,true);
assert.equal((await call('/api/vocab/grade',{...event,rating:3})).status,409);
const second={...event,id:'vocab-test-event-0002',rating:1};const parallel=await Promise.all([call('/api/vocab/grade',second),call('/api/vocab/grade',second)]);assert.ok(parallel.every(r=>r.data.st.n===2));assert.equal(parallel[0].data.st.born,born);
let snap=(await call('/api/records')).data;assert.equal(snap.vocabDays[Object.keys(snap.vocabDays)[0]].introduced,1);assert.equal(Object.keys(snap.vocabEvents).length,2);
const savedState=JSON.stringify(snap.vocab);for(const k of ['attempts','qtimes','mistakes','families','course','study','writing','drafts'])snap[k]||={};snap.feedback||=[];Object.assign(snap,{attemptProtocol:2,snapshotId:'vocab-snapshot-0001',vocab:{affix:{...snap.vocab.affix,i:999999,at:Date.now()+3600000}},vocabEvents:{},vocabDays:{}});
assert.equal((await call('/api/records',snap)).status,200);snap=(await call('/api/records')).data;assert.equal(JSON.stringify(snap.vocab),savedState);assert.equal(Object.keys(snap.vocabEvents).length,2);
await stop();await start();assert.equal((await call('/api/vocab/grade',second)).data.st.n,2);
const legacy={word:'fixated',rating:3,at:Date.now()-5000};assert.equal((await call('/api/vocab/grade',legacy)).data.st.n,1);assert.equal((await call('/api/vocab/grade',legacy)).data.st.n,1);
assert.equal((await call('/api/vocab/grade',{...event,id:'badtime-id-0001',at:null})).status,400);
const recordFile=path.join(dir,'records.json'),held=recordFile+'.held';fs.renameSync(recordFile,held);fs.mkdirSync(recordFile);
const fault={...event,id:'disk-failure-event-0001',rating:1};assert.equal((await call('/api/vocab/grade',fault)).status,503);assert.equal((await call('/api/records')).data.vocab.affix.n,2);fs.rmdirSync(recordFile);fs.renameSync(held,recordFile);assert.equal((await call('/api/vocab/grade',fault)).data.st.n,3);
console.log('PASS vocab API: retry, payload conflict, concurrent replay, immutable born, snapshot isolation, restart persistence, legacy queue, persistence failure atomicity');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>server?.kill());
