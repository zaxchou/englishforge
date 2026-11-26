import assert from 'node:assert/strict';import fs from 'node:fs';import {fileURLToPath} from 'node:url';
import {createReviewHub} from '../review-hub.mjs';
import StudyPause from '../web/study-pause.js';
import {chooseHubRound,hubState} from '../web/review/hub-model.mjs';
import {remainingToday,selectLearningRound,selectRound,summarize} from '../web/review/model.mjs';
const bank=JSON.parse(fs.readFileSync(new URL('../web/review/bank.json',import.meta.url),'utf8'));
assert.deepEqual(selectRound(bank,[],Date.now(),['object']).map(q=>q.unit),['object']);assert.equal(selectRound(bank,[],Date.now(),['root','root','reject']).length,2);assert.equal(selectRound(bank,[],Date.now(),['root','reject','project','eject']).length,3);assert.throws(()=>selectRound(bank,[],Date.now(),['not-real']));console.log('optional selection: exact unit, duplicates, maximum three and invalid selection passed');

const DAY=86400000;
const at=100*DAY;
const reject=bank.units.find(u=>u.id==='reject');
const lesson={...bank,units:[reject],pilotUnits:[reject.id]};
const weak={at,version:bank.version,unit:reject.id,phase:'check',value:'lost'};
const pause={revision:2,windows:[{start:at+DAY/4,end:at+DAY*2.25}]};
const projectDue=(due,anchor,now)=>StudyPause.projectDue(pause,due,anchor,now);
const resumed=at+DAY*2.5;
const standalone=summarize(lesson,[weak],resumed,projectDue)[0];
assert.equal(standalone.rawDue,at+DAY);
assert.equal(standalone.due,at+3*DAY);
assert.equal(standalone.last.at,at);
assert.equal(remainingToday(lesson,[weak],resumed,{projectDue}),0);
assert.deepEqual(selectLearningRound(lesson,[weak],resumed,null,'adaptive',6,{projectDue}),[]);
assert.equal(remainingToday(lesson,[weak],at+3*DAY,{projectDue}),1);
assert.equal(selectLearningRound(lesson,[weak],at+3*DAY,null,'adaptive',6,{projectDue})[0].unit,reject.id);
assert.equal(remainingToday(lesson,[],resumed,{paused:true}),0);
assert.deepEqual(selectLearningRound(lesson,[],resumed,null,'adaptive',6,{paused:true}),[]);
assert.equal(selectLearningRound(lesson,[weak],resumed,[reject.id],'base',1,{paused:true,projectDue})[0].unit,reject.id);

const quiz={kind:'quiz',keys:['vocab:reject'],lesson:bank.lesson,task:'usage'};
const evidence=[{keys:quiz.keys,task:quiz.task,at,good:false}];
assert.equal(hubState(quiz,evidence,resumed,projectDue).due,at+3*DAY);
assert.deepEqual(chooseHubRound([quiz],evidence,{},resumed,()=>0,projectDue),[]);
assert.equal(chooseHubRound([quiz],evidence,{extra:true},resumed,()=>0,projectDue)[0].preCue,false);
const lastExposure=at+2*DAY;
assert.equal(hubState(quiz,[{keys:quiz.keys,task:'expression',at:lastExposure}],resumed,projectDue).due,lastExposure+DAY);
console.log('standalone and mixed due selection honor pause windows and real exposure cooldowns');

const originalFetch=globalThis.fetch, originalNow=Date.now;
const originalKey=process.env.TFL_ASR_KEY, originalURL=process.env.TFL_ASR_URL;
try{
 const word='reject',qid='voice/'+word;
 let now=at+2*DAY;
 let currentPause={revision:1,windows:[{start:pause.windows[0].start,end:null}]};
 let records={course:{[lesson.lesson]:{done:true}},reviewHub:{version:1,rounds:{},voiceMistakes:{[word]:{word,at,due:at+DAY,correctChecks:1}},events:[{kind:'voice',qid,word,keys:['vocab:'+word,'voice-common:'+word],at,decision:'incorrect'}]}};
 Date.now=()=>now;
 process.env.TFL_ASR_KEY='test';process.env.TFL_ASR_URL='https://example.invalid/asr';
 globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({decision:'correct',confidence:1,inCourseSense:true,reason:'correct',reference:'reference'})}}]}));
 const hub=createReviewHub({web:fileURLToPath(new URL('../web/',import.meta.url)),records:()=>records,setRecords:next=>{records=next;},save:()=>{},quizzes:()=>({}),banks:()=>[lesson],reviewEvents:()=>[],pause:()=>currentPause,ai:{key:'test',base:'https://example.invalid'}});
 async function call(endpoint,body){
  const url='/api/review-hub/'+endpoint;
  let payload;
  const handled=await hub.handle({url,method:body?'POST':'GET',headers:{'content-type':'application/json'}},null,url.split('?')[0],async()=>JSON.stringify(body),(_,status,json)=>{assert.equal(status,200,json.error);payload=json;});
  assert.equal(handled,true);
  return payload;
 }
 const mistake=()=>records.reviewHub.voiceMistakes[word];
 const catalog=await call('catalog');
 assert.equal(catalog.paused,true);assert.equal(catalog.readyCount,0);
 assert.equal((await call('round',{mode:'mixed'})).round,null);
 assert.equal((await call('round',{mode:'voice',count:1})).round,null);
 assert.equal((await call('mistakes')).items[0].due,at+DAY*2.75);
 assert.equal(mistake().due,at+DAY);
 const extra=(await call('round',{mode:'voice',count:1,extra:true})).round;
 assert.equal(extra.created,now);
 const answer=(await call('answer',{round:extra.id,index:0,answer:'拒绝'})).round;
 assert.equal(answer.results[0].independent,true);
 assert.equal(mistake().correctChecks,1);
 assert.equal(mistake().at,at);
 assert.equal(mistake().dueAnchor,now);
 assert.equal(mistake().due,now+2*DAY);
 assert.equal(records.reviewHub.events.at(-1).at,now);
 currentPause=pause;
 now=at+4*DAY;
 assert.equal((await call('catalog')).readyCount,0);
 assert.equal((await call('round',{mode:'voice',count:1})).round,null);
 assert.equal((await call('mistakes')).items[0].due,at+DAY*4.25);
 now=at+DAY*4.25;
 assert.equal((await call('catalog')).readyCount,1);
 const due=(await call('round',{mode:'voice',count:1})).round;
 await call('answer',{round:due.id,index:0,answer:'拒绝'});
 assert.equal(mistake().cleared,true);
 assert.equal(mistake().correctChecks,2);
}finally{
 globalThis.fetch=originalFetch;Date.now=originalNow;
 if(originalKey===undefined)delete process.env.TFL_ASR_KEY;else process.env.TFL_ASR_KEY=originalKey;
 if(originalURL===undefined)delete process.env.TFL_ASR_URL;else process.env.TFL_ASR_URL=originalURL;
}
console.log('mixed review can resume after a pause and voice mistakes require genuinely due checks');
