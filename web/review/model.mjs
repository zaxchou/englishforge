export function summarize(bank,events,now=Date.now()){
 return bank.units.map(u=>{const es=events.filter(e=>e.unit===u.id&&e.version===bank.version).sort((a,b)=>a.at-b.at);const last=es.at(-1);let streak=0;const days=new Set();for(let i=es.length-1;i>=0&&es[i].value==='good'&&es[i].coachVersion&&es[i].independent&&es[i].outcome==='independent_correct';i--){if(es[i].phase==='supplement')continue;const d=new Date(es[i].at+8*3600000).toISOString().slice(0,10);if(!days.has(d)){days.add(d);streak++;}}
 const interval=last?.coachVersion&&last.outcome!=='independent_correct'?1:last?.phase==='supplement'?1:last?.value==='good'?[2,5,10,20][Math.min(Math.max(streak-1,0),3)]:1;
 return {...u,count:es.length,checkCount:es.filter(e=>e.phase==='check'&&e.outcome!=='skipped').length,helpCount:es.filter(e=>e.phase==='supplement').length,last,due:last?last.at+interval*86400000:0,interval,status:evidenceLabel(last)};});
}
export function selectRound(bank,events,now=Date.now(),unitIds=null,limit=3){
 const us=summarize(bank,events,now);const untouched=us.filter(u=>!u.checkCount);const weak=us.filter(u=>u.last&&u.last.value!=='good'&&u.due<=now).sort((a,b)=>a.due-b.due);
 const due=us.filter(u=>u.count&&u.due<=now).sort((a,b)=>a.due-b.due);const chosen=[];const add=u=>{if(u&&!chosen.some(x=>x.id===u.id))chosen.push(u)};
 add(weak[0]);add(untouched[0]);for(const u of due)add(u);for(const u of untouched)add(u);for(const u of [...us].sort((a,b)=>a.due-b.due))add(u);
 const selection=unitIds?[...new Set(unitIds)].slice(0,limit).map(id=>us.find(u=>u.id===id)).filter(Boolean):chosen.slice(0,limit);
 if(!selection.length)throw Error('no review units');
 return selection.map(u=>{const pool=u.questions.some(q=>q.coachVersion)?u.questions.filter(q=>q.coachVersion&&!q.level):u.questions;const prior=events.filter(e=>e.unit===u.id&&e.coachVersion).at(-1);const q=prior?pool.find(q=>q.id!==prior.question)||pool[0]:pool[u.checkCount%pool.length];const n=(u.id.split('').reduce((s,c)=>s+c.charCodeAt(0),0)+u.checkCount)%3;return {unit:u.id,title:u.title,...q,options:q.options.length?[...q.options.slice(n),...q.options.slice(0,n)]:[]}});
}
export function validateEvent(bank,input,now=Date.now()){
 if(!input||!/^cr-[a-zA-Z0-9-]{8,100}$/.test(input.id||''))throw Error('invalid event id');
 if(input.lesson&&input.lesson!==bank.lesson)throw Error('lesson mismatch');
 if(input.version!==bank.version)throw Error('content version changed');
 const unit=bank.units.find(u=>u.id===input.unit);const q=unit?.questions.find(q=>q.id===input.question);if(!q)throw Error('unknown question');
 if(!['check','supplement'].includes(input.phase))throw Error('invalid phase');
 if(input.trail!==undefined)return validateCoachEvent(bank,input,q,now);
 let value;if(q.kind==='recall'){if(!['good','fuzzy','lost'].includes(input.rating))throw Error('invalid self rating');value=input.rating;}
 else{if(!q.options.includes(input.choice))throw Error('invalid choice');value=input.choice===q.answer?'good':'lost';}
 return {id:input.id,version:bank.version,lesson:bank.lesson,unit:unit.id,question:q.id,phase:input.phase,kind:q.kind,value,choice:q.kind==='choice'?input.choice:null,at:now};
}

export function restoreSession(bank,raw,events){
 if(!raw||raw.version!==bank.version)throw Error('session version');
 if(!Array.isArray(raw.items)||raw.items.length<1||raw.items.length>9||!Number.isInteger(raw.step)||raw.step<0||raw.step>raw.items.length||!Array.isArray(raw.answers)||raw.answers.length!==raw.step)throw Error('session shape');
 const items=raw.items.map(q=>{const u=bank.units.find(u=>u.id===q?.unit),canonical=u?.questions.find(x=>x.id===q.id);if(!canonical)throw Error('session question');const opts=Array.isArray(q.options)&&q.options.length===canonical.options.length&&new Set(q.options).size===q.options.length&&q.options.every(o=>canonical.options.includes(o))?q.options:canonical.options;return {unit:u.id,title:u.title,...canonical,options:opts,...(!q.coachVersion?{coachVersion:undefined}:{})};});
 if(new Set(items.map(q=>q.unit)).size!==items.length)throw Error('duplicate session unit');
 const answers=raw.answers.map((a,i)=>{const e=events.find(e=>e.id===a?.id&&e.version===bank.version&&e.phase==='check'&&e.unit===items[i].unit&&e.question===items[i].id);if(!e)throw Error('session evidence');return e;});
 let extra=null;if(raw.ui?.extra){const u=bank.units.find(u=>u.id===raw.ui.extra.unit),q=u?.questions.find(q=>q.id===raw.ui.extra.question);if(u&&q)extra={unit:u.id,question:q.id};}
 if(!extra&&raw.pending?.phase==='supplement'){const u=bank.units.find(u=>u.id===raw.pending.unit),q=u?.questions.find(q=>q.id===raw.pending.question);if(u&&q)extra={unit:u.id,question:q.id};}
 const allowed=['home','check','result','supplement','transfer','end','skip','map','more','picker'];let view=allowed.includes(raw.ui?.view)?raw.ui.view:'home';
 if(['result','supplement','transfer'].includes(view)&&raw.step!==items.length)view='home';if(['supplement','transfer'].includes(view)&&!extra)view='result';if(view==='check'&&raw.step===items.length)view='result';
 const picked=[...new Set(Array.isArray(raw.ui?.picked)?raw.ui.picked:[])].filter(id=>bank.units.some(u=>u.id===id)).slice(0,9);
 let pending=null;if(raw.pending){validateEvent(bank,raw.pending);const q=raw.pending.phase==='check'?items[raw.step]:extra;if(!q||raw.pending.unit!==q.unit||raw.pending.question!==(q.id||q.question))throw Error('pending session mismatch');pending=raw.pending;}
 const draft=raw.draft&&bank.units.some(u=>u.id===raw.draft.unit&&u.questions.some(q=>q.id===raw.draft.question))?raw.draft:null;
 return {version:bank.version,id:typeof raw.id==='string'&&/^[a-zA-Z0-9-]{8,48}$/.test(raw.id)?raw.id:crypto.randomUUID(),items,step:raw.step,answers,preCue:raw.preCue===true,finished:raw.finished===true&&raw.step===items.length,...(pending?{pending}:{}),ui:{view,extra,picked},draft};
}

export function reviewEventId(session,question,phase){
 const id='cr-'+session.id+'-'+phase+'-'+question.id;
 if(!/^cr-[a-zA-Z0-9-]{8,100}$/.test(id))throw Error('invalid review event identity');return id;
}
export function mergeEvidence(current,received){
 if(!Array.isArray(received))throw Error('invalid evidence');const byId=new Map();
 for(const e of [...current,...received]){if(!e||typeof e.id!=='string'||!Number.isFinite(e.at))throw Error('invalid evidence event');if(!byId.has(e.id))byId.set(e.id,e);}
 return [...byId.values()].sort((a,b)=>a.at-b.at);
}

export function validateCoachTrail(q,trail){
 if(!q.coachVersion||!Array.isArray(trail)||!trail.length||trail.length>16)throw Error('invalid coach trail');
 let level=0,revealed=false,done=false;const attempts=[];
 const clean=trail.map(step=>{
  if(done||!step||typeof step!=='object')throw Error('invalid trail order');
  if(step.type==='hint'){if(step.level!==level+1||step.level>q.hints.length||revealed)throw Error('invalid hint');level=step.level;return {type:'hint',level};}
  if(step.type==='answer'){if(revealed||typeof step.choice!=='string'||!step.choice.trim()||step.choice.length>160||(q.kind!=='short'&&!q.options.includes(step.choice))||attempts.length>=4)throw Error('invalid answer');const a={type:'answer',choice:step.choice,helpLevel:level};attempts.push(a);const verdict=answerVerdict(q,step.choice);if(verdict!=='incorrect')done=true;return a;}
  if(step.type==='reveal'){revealed=true;done=true;return {type:'reveal'};}
  if(step.type==='skip'){done=true;return {type:'skip'};}
  throw Error('unknown trail step');
 });return {clean,attempts,level,revealed,done};
}
function validateCoachEvent(bank,input,q,now){
 if(input.coachVersion!==q.coachVersion)throw Error('coach version changed');const t=validateCoachTrail(q,input.trail);const singleWrong=input.singleAttempt===true&&input.phase==='check'&&t.clean.length===1&&t.attempts.length===1&&answerVerdict(q,t.attempts[0].choice)==='incorrect';if(!t.done&&!singleWrong)throw Error('unfinished episode');
 const first=t.attempts[0],last=t.attempts.at(-1),independent=!!first&&first.helpLevel===0&&input.phase==='check'&&input.preCue!==true;
 const outcome=singleWrong?'incorrect':last&&answerVerdict(q,last.choice)==='unscored'?'unscored':t.clean.at(-1).type==='skip'?'skipped':t.revealed?'revealed':independent&&t.attempts.length===1?'independent_correct':input.preCue===true&&t.attempts.length===1?'cued_correct':'assisted_correct';
 return {id:input.id,version:bank.version,lesson:bank.lesson,unit:input.unit,question:q.id,phase:input.phase,kind:q.kind,value:independent?(answerVerdict(q,first.choice)==='correct'?'good':answerVerdict(q,first.choice)==='incorrect'?'lost':'unknown'):'unknown',choice:first?.choice||null,at:now,level:q.level||'recognize',coachVersion:q.coachVersion,trail:t.clean,helpSnapshot:q.hints.slice(0,t.level),explanationSnapshot:t.clean.at(-1).type!=='skip'?q.explain:null,preHelpSnapshot:input.phase==='supplement'?bank.units.find(u=>u.id===input.unit).note:null,sourceSnapshot:bank.units.find(u=>u.id===input.unit).source,outcome,independent,preCue:input.preCue===true,finalChoice:last?.choice||null};
}
export function evidenceLabel(e){
 if(!e)return '尚未检查';
 if(e.coachVersion){if(e.outcome==='incorrect')return '这一处答错，待复查';if(e.outcome==='unscored')return '这个表达需核对，暂不判分';if(e.outcome==='skipped')return '这次先跳过';if(e.outcome==='revealed')return '已看讲解，待换题检查';if(e.outcome==='cued_correct')return '带目标线索完成，待无提示检查';if(e.outcome==='assisted_correct')return '重试后答对，待独立检查';return e.level==='retrieve'?(e.followup?.delayed?'隔日自己补出表达':'本次自己补出表达'):e.followup?.delayed?'隔日换题独立答对':'本次独立答对';}
 return e.phase==='supplement'?'刚补过，待复查':e.kind==='recall'?'自评：'+(e.value==='good'?'熟悉':'需要再看'):'历史检查，帮助条件未知';
}

export function linkCoachEvidence(event,events){
 if(!event.coachVersion)return event;
 const previous=events.filter(e=>e.unit===event.unit&&e.coachVersion&&e.question!==event.question&&(e.level||'recognize')===(event.level||'recognize')&&e.outcome!=='skipped').at(-1);
 return previous?{...event,followup:{eventId:previous.id,delayed:event.at-previous.at>=86400000,differentQuestion:true}}:event;
}

export function answerVerdict(q,answer){
 if(q.kind!=='short')return answer===q.answer?'correct':'incorrect';
 const normalize=v=>String(v).trim().toLowerCase().replace(/[’]/g,"'").replace(/[.!?]+$/,'').replace(/\s+/g,' ');
 const a=normalize(answer);if(q.accepted.some(x=>normalize(x)===a))return 'correct';
 return q.incorrect.some(x=>normalize(x)===a)?'incorrect':'unscored';
}
export function progression(bank,events,unitId){
 const u=bank.units.find(u=>u.id===unitId);if(!u)return null;
 const es=events.filter(e=>e.unit===unitId&&e.version===bank.version).sort((a,b)=>a.at-b.at);
 const passed=q=>{const latest=es.filter(e=>e.question===q.id&&e.coachVersion===q.coachVersion&&e.outcome!=='skipped').at(-1);return latest?.outcome==='independent_correct'&&latest.phase==='check';};
 const base=u.questions.filter(q=>q.coachVersion&&!q.level),advanced=u.questions.filter(q=>q.level==='retrieve');
 return {unit:unitId,ready:base.length>=2&&base.every(passed),complete:advanced.length>=2&&advanced.every(passed),passed:advanced.filter(passed).map(q=>q.id),label:advanced.length&&advanced.every(passed)?'已在两种句子中补出表达，之后间隔复查':base.length>=2&&base.every(passed)?'基础辨认可用，可以试着自己补出表达':'先检查基础用法'};
}
export function selectLearningRound(bank,events,now=Date.now(),ids=null,mode='adaptive',count=6){
 if(![1,2,3,4,5,6,7,8,9].includes(count))throw Error('invalid round size');
 const states=bank.pilotUnits.map(id=>progression(bank,events,id));
 if(!ids){
  const due=summarize(bank,events,now).filter(u=>bank.pilotUnits.includes(u.id)&&u.due<=now&&u.count).map(u=>u.id);
  const progressing=states.filter(s=>!s.complete).map(s=>s.unit);
  const other=summarize(bank,events,now).filter(u=>!bank.pilotUnits.includes(u.id)).sort((a,b)=>a.checkCount-b.checkCount||a.due-b.due).map(u=>u.id);
  const seen=new Set(events.filter(e=>e.version===bank.version&&e.phase==='check'&&reviewDay(e.at)===reviewDay(now)).map(e=>e.unit));
  ids=[...new Set([...due,...progressing,...other])].filter(id=>!seen.has(id)).slice(0,count);
  if(!ids.length)return [];
 }
 return selectRound(bank,events,now,ids,count).map(item=>{
  const state=progression(bank,events,item.unit);if(mode==='base'||!state?.ready)return item;
  const u=bank.units.find(u=>u.id===item.unit);const qs=u.questions.filter(q=>q.level==='retrieve');const previous=events.filter(e=>e.unit===item.unit&&e.level==='retrieve').at(-1);
  const q=qs.find(q=>!state.passed.includes(q.id)&&q.id!==previous?.question)||qs.find(q=>!state.passed.includes(q.id))||qs.find(q=>q.id!==previous?.question)||qs[0];
  return {...q,unit:u.id,title:u.title};
 });
}

function reviewDay(at){return new Date(at+8*3600000).toISOString().slice(0,10);}
export function remainingToday(bank,events,now=Date.now()){
 const seen=new Set(events.filter(e=>e.version===bank.version&&e.phase==='check'&&reviewDay(e.at)===reviewDay(now)).map(e=>e.unit));return bank.units.filter(u=>!seen.has(u.id)).length;
}
