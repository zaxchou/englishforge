/* Root practice uses the course plan for stamps and one word settlement per round. */
const RP_STATE = { lesson:null, data:null, loading:false, request:0, session:null, recovery:[], stage:'branches', branch:null, phase:'main', question:null, err:'', syncing:false };
function rpKey(data){return 'tfl-rp-v2:'+data.lessonId+':'+data.version;}
function rpCurrent(lesson){return csSel.c==='cfcm-01'&&csSel.l+1===lesson&&!!$('rp-body');}
const rpClone=x=>JSON.parse(JSON.stringify(x));
function rpJSON(key){return JSON.parse(localStorage.getItem(key)||'null');}
function rpRoundKey(s){return 'tfl-rp-round:'+encodeURIComponent(s.lessonId)+':'+encodeURIComponent(s.id);}
function rpEventPrefix(s){return 'tfl-rp-answer:'+encodeURIComponent(s.lessonId)+':'+encodeURIComponent(s.id)+':';}
function rpEventKey(s,e){return rpEventPrefix(s)+e.phase+':'+e.questionId;}
function rpAckKey(s,e){return rpEventKey(s,e).replace('tfl-rp-answer:','tfl-rp-ack:');}
function rpKeys(prefix){const keys=[];for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k?.startsWith(prefix))keys.push(k);}return keys;}
function rpRemember(s){
  // Each answer has its own durable slot. A stale tab can never overwrite another item or the first answer.
  for(const phase of ['main','correction'])for(const [questionId,answer] of Object.entries(s[phase==='main'?'answers':'corrections']||{})){
    const e={questionId,answer,phase},key=rpEventKey(s,e);if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify(e));
  }
  for(const e of s.pending||[]){const key=rpEventKey(s,e);if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify(e));}
}
function rpRead(session){
  const s=rpClone(session),stored=rpJSON(rpRoundKey(s))||rpJSON(rpKey(s));s.wordEvents||={};
  if(stored?.id===s.id){
    s.answers={...s.answers,...stored.answers};s.corrections={...s.corrections,...stored.corrections};
    for(const [word,event] of Object.entries(stored.wordEvents||{})){
      const incoming=s.wordEvents?.[word];
      s.wordEvents[word]={...event,queued:event.queued||!!(incoming?.id===event.id&&incoming.rootRound===event.rootRound&&incoming.queued)};
    }
    s.finished=!!(s.finished||stored.finished);
    s.completedAt=s.completedAt||stored.completedAt;s.blocked=s.blocked||stored.blocked;
  }
  s.answers||={};s.corrections||={};s.wordEvents||={};
  const pending=new Map((s.pending||[]).map(e=>[e.phase+':'+e.questionId,e]));
  for(const key of rpKeys(rpEventPrefix(s))){const e=rpJSON(key);if(!e)continue;
    const ack=rpJSON(rpAckKey(s,e));s[e.phase==='main'?'answers':'corrections'][e.questionId]=ack?.answer??e.answer;
    if(s.mode==='plan'&&!ack)pending.set(e.phase+':'+e.questionId,e);else pending.delete(e.phase+':'+e.questionId);
  }
  s.pending=[...pending.values()].filter(e=>!rpJSON(rpAckKey(s,e)));
  return s;
}
function rpWordId(s,word){
  // The server also checks the full round/word identity; these hashes keep browser queue keys bounded.
  const text=JSON.stringify([s.id,word.toLowerCase()]);
  return 'rpf-'+[2166136261,2246822519,3266489917,668265263].map(seed=>{let h=seed;for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619);return (h>>>0).toString(16).padStart(8,'0');}).join('');
}
function rpSettleWords(s){
  if(s.mode!=='free')return;
  const questions=s.questions||[];
  for(const word of new Set([...questions.map(q=>q.word),...Object.keys(s.wordEvents)])){
    const key='tfl-rp-word:'+encodeURIComponent(s.lessonId)+':'+encodeURIComponent(s.id)+':'+encodeURIComponent(word);
    let event=rpJSON(key)||s.wordEvents[word];
    if(event&&s.wordEvents[word]?.id===event.id&&s.wordEvents[word].queued)event={...event,queued:true};
    const qs=questions.filter(q=>q.word===word);
    if(!event&&qs.length&&qs.every(q=>Object.hasOwn(s.answers,q.id)))event={id:rpWordId(s,word),word,rating:qs.every(q=>rpCorrect(q,s.answers[q.id]))?3:1,at:s.startedAt||Date.now(),queued:false};
    if(!event)continue;
    // Retain legacy UUIDs and their original payload; one retry registers their stable scope server-side.
    if(event.rootRound!==s.id)event={...event,rootRound:s.id,queued:false};
    localStorage.setItem(key,JSON.stringify(event));s.wordEvents[word]=event;
  }
}
function rpSave(session,activate=false){
  const old=rpJSON(rpRoundKey(session))||rpJSON(rpKey(session));
  if(old?.id===session.id)rpRemember(old);
  rpRemember(session);
  const s=rpRead(session);rpSettleWords(s);
  const qs=s.questions||[];
  if(s.mode==='free'&&qs.length&&qs.every(q=>Object.hasOwn(s.answers,q.id))&&qs.every(q=>rpCorrect(q,s.answers[q.id])||Object.hasOwn(s.corrections,q.id))){s.finished=true;s.completedAt||=Date.now();}
  localStorage.setItem(rpRoundKey(s),JSON.stringify(s));
  if(s.finished)localStorage.setItem(rpKey(s)+':history:'+s.id,JSON.stringify(s));
  const current=rpJSON(rpKey(s));
  if(activate||!current||current.id===s.id)localStorage.setItem(rpKey(s),JSON.stringify(s));
  return s;
}
function rpStore(session,activate=false){
  try{if(!session.questions&&RP_STATE.data)session.questions=rpClone(RP_STATE.data.quiz.questions);RP_STATE.session=rpSave(session,activate);RP_STATE.err='';return true;}
  catch{RP_STATE.err='回答未保存，请保持本页、释放浏览器存储后重试。';return false;}
}
function rpCommit(change){const session=rpRead(RP_STATE.session);change(session);return rpStore(session);}
function rpReconcile(session,event,j){
  const latest=rpJSON(rpRoundKey(session))||rpJSON(rpKey(session));
  const s=rpRead(latest?.id===session.id?latest:session),round=j.round||(j.plan?.active?.id===s.id||!j.plan?.active?.id?j.plan?.active:null);
  // A successful response acknowledges exactly the submitted item, never a concurrently appended answer.
  localStorage.setItem(rpAckKey(s,event),JSON.stringify({answer:round?.[event.phase==='main'?'answers':'corrections']?.[event.questionId]?.letter??event.answer}));
  if(round){
    for(const phase of ['main','correction'])for(const [id,a] of Object.entries(round[phase==='main'?'answers':'corrections']||{})){
      const e={questionId:id,phase};localStorage.setItem(rpAckKey(s,e),JSON.stringify({answer:a.letter}));s[phase==='main'?'answers':'corrections'][id]=a.letter;
    }
    for(const e of s.pending)if(e.phase==='correction'&&round.answers?.[e.questionId]?.ok)localStorage.setItem(rpAckKey(s,e),JSON.stringify({answer:e.answer,skip:true}));
    if(round.archived){s.finished=true;s.archived=true;s.completedAt=round.finishedAt||Date.now();}
  }
  s.pending=s.pending.filter(e=>!rpJSON(rpAckKey(s,e)));return rpSave(s);
}
function rpQueueWords(session){
  const s=rpSave(session);
  for(const event of Object.values(s.wordEvents)){
    if(event.queued)continue;
    const {queued,...payload}=event;localStorage.setItem(VB_PREFIX+event.id,JSON.stringify(payload));event.queued=true;
  }
  return rpSave(s);
}
async function rpLoad(lesson){
  const request=++RP_STATE.request;RP_STATE.lesson=lesson;RP_STATE.loading=true;RP_STATE.data=null;RP_STATE.err='';rpRender();renderGenQuiz();
  try{
    const data=await api('/api/vocab/lesson-practice?lesson='+lesson,{signal:AbortSignal.timeout(15000)});
    if(request!==RP_STATE.request||!rpCurrent(lesson))return;
    RP_STATE.data=data.branches?.length?data:null;RP_STATE.session=null;RP_STATE.recovery=[];RP_STATE.branch=null;RP_STATE.stage='branches';
    if(RP_STATE.data){
      try{
        const candidates=[rpKey(data),...rpKeys('tfl-rp-v2:'+data.lessonId+':').filter(k=>!k.includes(':history:')&&k!==rpKey(data))];
        for(const key of candidates){
          let saved=rpJSON(key);if(saved?.schema!==2||saved.lessonId!==data.lessonId)continue;
          saved=rpRead(saved);
          if(saved.blocked){RP_STATE.recovery.push({key,session:saved,questions:saved.questions||[]});continue;}
          if(saved.version!==data.version){
            let oldQuestions=saved.questions;
            if(!oldQuestions){try{const old=await api('/api/vocab/lesson-practice?lesson='+lesson+'&version='+encodeURIComponent(saved.version),{signal:AbortSignal.timeout(15000)});if(old.version===saved.version)oldQuestions=old.quiz?.questions;}catch{}}
            if(request!==RP_STATE.request)return;
            if(!oldQuestions||JSON.stringify(oldQuestions)!==JSON.stringify(data.quiz.questions)){
              RP_STATE.recovery.push({key,session:saved,questions:oldQuestions||[]});continue;
            }
            saved.questions=oldQuestions;
          }
          if(!RP_STATE.session){saved.questions||=rpClone(data.quiz.questions);RP_STATE.session=rpSave(saved);}
        }
        const saved=RP_STATE.session;
        if(saved){RP_STATE.branch=saved.branch;RP_STATE.stage=saved.stage||'branches';RP_STATE.phase=saved.phase||'main';RP_STATE.question=saved.question;}
      }catch{RP_STATE.err='本机练习位置无法读取，原记录保留；请导出浏览器记录后重试。';}
      try{await cpLoad();}catch{ /* The saved round remains usable offline. */ }
      if(request!==RP_STATE.request||!rpCurrent(lesson))return;
    }
  }catch(e){if(request===RP_STATE.request&&rpCurrent(lesson))RP_STATE.err='练习读取失败，请重试。'+e.message;}
  finally{if(request===RP_STATE.request){RP_STATE.loading=false;if(rpCurrent(lesson)){rpRender();renderGenQuiz();rpFlush();}}}
}
function rpQuestions(branch){return branch.words.flatMap(w=>w.questions);}
function rpAllQuestions(){return RP_STATE.data.quiz.questions;}
function rpAnswers(phase=RP_STATE.phase){return RP_STATE.session?.[phase==='main'?'answers':'corrections']||{};}
function rpCorrect(q,value){return q.kind==='recall'?value.trim().toLowerCase()===q.answer.toLowerCase():value===q.answer;}
function rpRemaining(phase){return rpAllQuestions().filter(q=>phase==='main'?!Object.hasOwn(rpAnswers('main'),q.id):Object.hasOwn(rpAnswers('main'),q.id)&&!rpCorrect(q,rpAnswers('main')[q.id])&&!Object.hasOwn(rpAnswers('correction'),q.id));}
async function rpBegin(branch,free=false){
  if(RP_STATE.syncing)return;
  const data=RP_STATE.data,request=RP_STATE.request;
  if(RP_STATE.session&&!rpStore(rpRead(RP_STATE.session))){rpRender();return;}
  if(!RP_STATE.session||RP_STATE.session.finished||RP_STATE.session.blocked){
    let plan=null,mode='free';
    if(!free){
      try{const j=await cpRequest('/start',{lessonId:data.lessonId});plan=j.plan;mode='plan';CP.data.plans[data.lessonId]=plan;}
      catch(e){if(!['plan_not_due','plan_complete'].includes(e.code)){RP_STATE.err='无法开始本遍，请联网后重试。'+e.message;rpRender();return;}}
    }
    if(request!==RP_STATE.request)return;
    const active=plan?.active;
    const session={schema:2,id:active?.id||crypto.randomUUID(),version:data.version,lessonId:data.lessonId,mode,startedAt:Date.now(),questions:rpClone(data.quiz.questions),
      answers:Object.fromEntries(Object.entries(active?.answers||{}).map(([id,a])=>[id,a.letter])),
      corrections:Object.fromEntries(Object.entries(active?.corrections||{}).map(([id,a])=>[id,a.letter])),pending:[],wordEvents:{},branch:branch.id,stage:'read',phase:'main',question:null};
    if(!rpStore(session,true)){rpRender();return;}
  }
  RP_STATE.branch=branch.id;RP_STATE.stage='read';RP_STATE.phase='main';RP_STATE.question=null;
  if(rpCommit(s=>{s.branch=branch.id;s.stage='read';s.phase='main';s.question=null;}))rpRender();
}
function rpAnswer(q,value){
  if(Object.hasOwn(rpAnswers(),q.id)||!value.trim())return;
  const phase=RP_STATE.phase,session=rpRead(RP_STATE.session),answers=session[phase==='main'?'answers':'corrections'];
  if(session.finished||session.blocked||Object.hasOwn(answers,q.id)){RP_STATE.session=session;rpRender();return;}
  answers[q.id]=value;
  if(session.mode==='plan')session.pending.push({questionId:q.id,answer:value,phase});
  if(!rpStore(session)){rpRender();return;}
  rpRender();rpFlush();
}
async function rpFlush(){
  if(RP_STATE.syncing||!RP_STATE.session||!RP_STATE.data)return;
  let session=RP_STATE.session;const data=RP_STATE.data,request=RP_STATE.request;
  RP_STATE.syncing=true;
  try{
    session=rpSave(session);RP_STATE.session=session;
    if(session.blocked){RP_STATE.err=session.blocked;return;}
    if(session.mode==='plan'){
      while(session.pending.length){
        const event=session.pending[0];
        const j=await cpRequest('/root-answer',{lessonId:session.lessonId,version:session.version,roundId:session.id,...event});
        // Persist the acknowledgement even if the user selected another lesson during the request.
        session=rpReconcile(session,event,j);
        if(request!==RP_STATE.request)return;
        if(RP_STATE.session?.id!==session.id)return;
        RP_STATE.session=session;
        if(CP.data)CP.data.plans[data.lessonId]=j.plan;
        if(j.vocab){REC.vocab={...(REC.vocab||{}),...j.vocab};}
      }
    }else{
      session=rpQueueWords(session);RP_STATE.session=session;vbFlushQueue();
    }
    RP_STATE.err='';gqRefreshList();cpBadgeUpdate();
  }catch(e){if(request===RP_STATE.request){
    if(['question_version_changed','round_mismatch'].includes(e.code)){
      const message='旧轮回答已保留，可回看；题目或轮次已更新，请回到小组开始本轮。'+e.message;
      try{const latest=rpJSON(rpRoundKey(session));session=rpRead(latest?.id===session.id?latest:session);session.blocked=message;RP_STATE.session=rpSave(session);}catch{}
      RP_STATE.err=message;
    }else RP_STATE.err='已保存在本机，等待同步。'+e.message;
  }}
  finally{RP_STATE.syncing=false;if(request===RP_STATE.request)rpRender();else rpFlush();rpFlushSaved();}
}
function rpMove(stage,question=null,phase=RP_STATE.phase){
  if(!rpCommit(s=>{s.stage=stage;s.question=question;s.phase=phase;s.branch=RP_STATE.branch;})){rpRender();return;}
  Object.assign(RP_STATE,{stage,question,phase});rpRender();
}
async function rpRestart(){
  await rpFlush();
  const s=RP_STATE.session,d=RP_STATE.data;
  if(!s||s.pending.length||Object.values(s.wordEvents).some(e=>!e.queued)){RP_STATE.err='已有回答还未保存完成，请先重试同步。';rpRender();return;}
  try{localStorage.setItem(rpKey(s)+':history:'+s.id,JSON.stringify(s));}
  catch{RP_STATE.err='上一轮记录未能归档，请释放浏览器存储后重试。';rpRender();return;}
  if(!rpCommit(next=>{next.finished=true;})){rpRender();return;}
  await rpBegin(d.branches[0]);
}
async function rpFinish(rating){
  const data=RP_STATE.data,session=RP_STATE.session,request=RP_STATE.request;
  await rpFlush();if(request!==RP_STATE.request)return;
  if(RP_STATE.session.pending.length||rpRemaining('main').length||rpRemaining('correction').length){RP_STATE.err='本遍尚未保存完成，请重试同步。';rpRender();return;}
  try{
    const j=await cpRequest('/finish',{lessonId:data.lessonId,roundId:session.id,rating});
    if(request!==RP_STATE.request)return;
    CP.data.plans[data.lessonId]=j.plan;rpCommit(s=>{s.finished=true;});
    gqRefreshList();await cpLoad();rpRender();
  }catch(e){RP_STATE.err='盖章未完成，可重试；已有回答保留。'+e.message;rpRender();}
}
function rpRecoveryHTML(){
  const records=[...RP_STATE.recovery];
  if(RP_STATE.session?.blocked)records.push({session:RP_STATE.session,questions:RP_STATE.session.questions||[]});
  return records.map(({session:s,questions})=>'<details class="gq-note"><summary>旧版／旧轮记录已保留 · '+esc(s.id)+' · '+(s.pending||[]).length+' 个回答待核对</summary><p>题目或轮次已更新，旧回答不会套用新版题目。可回看以下首答与纠正，并从小组开始新版练习。</p>'+(s.blocked?'<p>'+esc(s.blocked)+'</p>':'')+Object.entries(s.answers||{}).map(([id,answer])=>{const q=questions.find(q=>q.id===id);return '<p><b>'+esc(q?.stem||id)+'</b><br>首次回答：'+esc(answer)+(q?.options?.[answer]?' · '+esc(q.options[answer]):'')+(Object.hasOwn(s.corrections||{},id)?'<br>纠正：'+esc(s.corrections[id]):'')+'</p>';}).join('')+'</details>').join('');
}
function rpRender(){
  const body=$('rp-body'),meta=$('rp-meta');if(!body)return;
  const d=RP_STATE.data,s=RP_STATE.session;
  const oldInput=$('rp-answer');
  const draft=oldInput&&!oldInput.disabled&&oldInput.dataset?.rpRound===s?.id&&oldInput.dataset?.rpQuestion===RP_STATE.question
    ?{value:oldInput.value,focused:document.activeElement===oldInput,start:oldInput.selectionStart,end:oldInput.selectionEnd}:null;
  if(RP_STATE.loading){body.innerHTML='<p role="status">正在读取本节词根联盟…</p>';return;}
  if(!d){body.innerHTML='<p class="gq-note" role="status">'+esc(RP_STATE.err||'本节新练习尚未收录，可使用原配套题。')+'</p><button id="rp-retry">重新读取</button>';if(meta)meta.textContent='';$('rp-retry').onclick=()=>rpLoad(csSel.l+1);return;}
  if(meta)meta.textContent=d.branches.length+' 小组 · '+d.branches.reduce((n,b)=>n+b.words.length,0)+' 词';
  const notice=(RP_STATE.err?'<p role="alert">'+esc(RP_STATE.err)+' <button id="rp-sync">重试同步</button></p>':'')+rpRecoveryHTML();
  const plan=cpPlan(d.lessonId),caption=plan?cpStamps(plan)+'<p>'+esc(cpCaption(plan))+'</p>':'';
  const wire=()=>{const retry=$('rp-sync');if(retry)retry.onclick=rpFlush;gqStudyGate();};
  if(s?.blocked){rpRenderBranches(body,d,notice+caption);wire();return;}
  const mainLeft=s?rpRemaining('main'):[],correctionLeft=s?rpRemaining('correction'):[];
  if(s&&!mainLeft.length&&!['read','review'].includes(RP_STATE.stage)){
    if(correctionLeft.length){
      if(RP_STATE.stage!=='quiz'||RP_STATE.phase!=='correction'){
        RP_STATE.stage='corrections';
        body.innerHTML=notice+caption+'<h3>本遍已练完，纠正后再盖章</h3><p>还有 '+correctionLeft.length+' 道错题需要回忆一次。</p><button class="pri" id="rp-correct">开始轮末纠正</button>';
        $('rp-correct').onclick=()=>rpMove('quiz',correctionLeft[0].id,'correction');wire();return;
      }
    }else{
      RP_STATE.stage='finish';
      const right=rpAllQuestions().filter(q=>rpCorrect(q,s.answers[q.id])).length;
      body.innerHTML=notice+caption+'<h3>本遍已练完 ✓</h3><p>首次答对 '+right+' / '+rpAllQuestions().length+' 题。已练不等于全部掌握，到期继续回忆。</p>'
        +(s.mode==='plan'&&!s.finished?'<p>全部回答同步后即可盖章。</p><div class="rp-actions">'+[['hard','费劲'],['good','刚好'],['easy','轻松']].map(([v,t])=>'<button data-rp-finish="'+v+'" '+(s.pending.length||RP_STATE.syncing?'disabled':'')+'>'+t+' · 盖章</button>').join('')+'</div>':'<p>'+(s.mode==='plan'?'本遍已盖章。':'自主练习不计章；每词本轮只结算一次。')+'</p>')
        +'<button id="rp-list">回看本课</button>'+(s.mode==='free'||s.finished?' <button id="rp-restart">开始下一遍 · 到期计章</button>':'');
      body.querySelectorAll('[data-rp-finish]').forEach(b=>b.onclick=()=>rpFinish(b.dataset.rpFinish));$('rp-list').onclick=()=>rpMove('review');
      const restart=$('rp-restart');if(restart)restart.onclick=rpRestart;wire();return;
    }
  }
  if(['branches','review'].includes(RP_STATE.stage)||!s){rpRenderBranches(body,d,notice+caption);wire();return;}
  const branch=d.branches.find(b=>b.id===RP_STATE.branch)||d.branches[0];
  if(RP_STATE.stage==='read'){
    body.innerHTML=notice+'<div class="rp-head"><button id="rp-back">← 选择小组</button><b>'+esc(branch.title)+'</b></div><div class="rp-lessonwords">'+branch.words.map(w=>'<article class="rp-word"><div><b>'+esc(w.word)+'</b><span>'+esc(w.def)+'</span></div><p>'+esc(w.explanation||w.clue)+'</p>'+(w.example?'<p class="rp-example">'+esc(w.example.en)+'</p><small>'+esc(w.example.zh)+'</small>':'')+'</article>').join('')+'</div><button class="pri" id="rp-begin">开始逐词回忆 →</button>';
    $('rp-back').onclick=()=>rpMove('branches');$('rp-begin').onclick=()=>rpMove('quiz',rpQuestions(branch).find(q=>!Object.hasOwn(rpAnswers('main'),q.id))?.id||rpQuestions(branch)[0].id,'main');wire();return;
  }
  const questions=RP_STATE.phase==='correction'?rpAllQuestions().filter(q=>!rpCorrect(q,s.answers[q.id])):rpQuestions(branch);
  const q=questions.find(q=>q.id===RP_STATE.question)||questions.find(q=>!Object.hasOwn(rpAnswers(),q.id));
  if(!q){body.innerHTML=notice+'<h3>本小组已练完</h3><button id="rp-back">选择下一组 →</button>';$('rp-back').onclick=()=>rpMove('branches');wire();return;}
  const answer=rpAnswers()[q.id],judged=answer!==undefined,correct=judged&&rpCorrect(q,answer);
  body.innerHTML=notice+'<div class="rp-head"><button id="rp-back">← 选择小组</button><span>'+esc(RP_STATE.phase==='correction'?'轮末纠正':branch.title)+' · '+(questions.indexOf(q)+1)+' / '+questions.length+'</span></div><h4>'+esc(q.stem)+'</h4>'
    +(q.kind==='recall'?'<div class="rp-recall"><input id="rp-answer" data-rp-round="'+esc(s.id)+'" data-rp-question="'+esc(q.id)+'" aria-label="英文答案" autocomplete="off" autocapitalize="none" spellcheck="false" value="'+esc(answer??draft?.value??'')+'" '+(judged?'disabled':'')+'><button class="pri" id="rp-check" '+(judged?'disabled':'')+'>检查</button></div>':'<div class="rp-choices">'+Object.entries(q.options).map(([letter,text])=>'<button data-rp-c="'+letter+'" class="rp-choice '+(judged&&letter===q.answer?'correct':judged&&letter===answer?'wrong':'')+'" '+(judged?'disabled':'')+'><span class="rp-letter">'+letter+'</span>'+esc(text)+'</button>').join('')+'</div>')
    +(judged?'<div class="gq-explain"><b>'+(correct?'答对了':'正确答案：'+esc(q.kind==='recall'?q.answer:q.options[q.answer]))+'</b><p>'+esc(q.explanation)+'</p></div>':'')
    +'<p role="status">'+(s.mode==='plan'?(s.pending.length?'已保存在本机，'+s.pending.length+' 个回答待同步。':'本轮回答已同步。'):'回答先保存本机，每词完成后加入复习排期。')+'</p><button class="pri" id="rp-nextq" '+(judged?'':'disabled')+'>下一题 →</button>';
  $('rp-back').onclick=()=>rpMove('branches');body.querySelectorAll('[data-rp-c]').forEach(b=>b.onclick=()=>rpAnswer(q,b.dataset.rpC));
  const input=$('rp-answer');if(input&&!judged){if(draft?.focused){input.focus({preventScroll:true});input.setSelectionRange(draft.start,draft.end);}$('rp-check').onclick=()=>rpAnswer(q,input.value.trim());input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('rp-check').click();}};}
  $('rp-nextq').onclick=()=>{const next=questions[questions.indexOf(q)+1];rpMove(next?'quiz':'branches',next?.id||null);};wire();
}
function rpRenderBranches(body,d,prefix){
  const s=RP_STATE.session;
  body.innerHTML=prefix+'<div class="rp-branches">'+d.branches.map(b=>{const done=s&&rpQuestions(b).every(q=>Object.hasOwn(s.answers,q.id));return '<button class="rp-branch '+(done?'done':'')+'" data-rp-branch="'+esc(b.id)+'"><b>'+esc(b.title)+'</b><span>'+b.words.length+' 词'+(done?' · 已练':'')+'</span></button>';}).join('')+'</div><p>每组最多 8 词；本遍覆盖全课并纠正错题后可盖章。每词本轮只结算一次复习评分。</p>';
  body.querySelectorAll('[data-rp-branch]').forEach(b=>b.onclick=()=>rpBegin(d.branches.find(x=>x.id===b.dataset.rpBranch)));
}
let RP_SAVED_FLUSHING=false;
async function rpFlushSaved(){
  if(RP_SAVED_FLUSHING)return;RP_SAVED_FLUSHING=true;
  try{
    const keys=[...rpKeys('tfl-rp-v2:').filter(k=>!k.includes(':history:')),...rpKeys('tfl-rp-round:')],seen=new Set();
    for(const key of keys){
      let saved;
      try{
        saved=rpJSON(key);if(saved?.schema!==2)continue;
        const identity=saved.lessonId+':'+saved.id;if(seen.has(identity))continue;seen.add(identity);
        if(RP_STATE.session?.id===saved.id&&RP_STATE.session.lessonId===saved.lessonId)continue;
        saved=rpSave(saved);if(saved.blocked)continue;
        if(saved.mode==='plan')while(saved.pending.length){
          const event=saved.pending[0],j=await cpRequest('/root-answer',{lessonId:saved.lessonId,version:saved.version,roundId:saved.id,...event});
          saved=rpReconcile(saved,event,j);
        }
        if(saved.mode==='free')rpQueueWords(saved);
      }catch(e){
        if(saved&&['question_version_changed','round_mismatch'].includes(e.code)){
          try{saved.blocked='旧轮未同步回答已保留，请回本课回看并开始新版练习。'+e.message;saved=rpSave(saved);
            const item=RP_STATE.recovery.find(x=>x.session.id===saved.id);if(item)item.session=saved;
          }catch{}
        }
      }
    }
    vbFlushQueue();
  }finally{RP_SAVED_FLUSHING=false;}
}
window.addEventListener('online',()=>{rpFlush();rpFlushSaved();});
window.addEventListener('load',()=>rpFlushSaved());
