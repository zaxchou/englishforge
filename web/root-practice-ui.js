/* Root practice uses the course plan for stamps and one word settlement per round. */
const RP_STATE = { lesson:null, data:null, loading:false, request:0, session:null, stage:'branches', branch:null, phase:'main', question:null, err:'', syncing:false };
function rpKey(data){return 'tfl-rp-v2:'+data.lessonId+':'+data.version;}
function rpCurrent(lesson){return csSel.c==='cfcm-01'&&csSel.l+1===lesson&&!!$('rp-body');}
function rpStore(session){
  try{localStorage.setItem(rpKey(RP_STATE.data),JSON.stringify(session));RP_STATE.session=session;RP_STATE.err='';return true;}
  catch{RP_STATE.err='回答未保存，请保持本页、释放浏览器存储后重试。';return false;}
}
function rpCommit(change){const session=JSON.parse(JSON.stringify(RP_STATE.session));change(session);return rpStore(session);}
async function rpLoad(lesson){
  const request=++RP_STATE.request;RP_STATE.lesson=lesson;RP_STATE.loading=true;RP_STATE.data=null;RP_STATE.err='';rpRender();
  try{
    const data=await api('/api/vocab/lesson-practice?lesson='+lesson,{signal:AbortSignal.timeout(15000)});
    if(request!==RP_STATE.request||!rpCurrent(lesson))return;
    RP_STATE.data=data.branches?.length?data:null;RP_STATE.session=null;RP_STATE.branch=null;RP_STATE.stage='branches';
    if(RP_STATE.data){
      try{const saved=JSON.parse(localStorage.getItem(rpKey(data))||'null');
        if(saved&&saved.version===data.version&&saved.lessonId===data.lessonId){RP_STATE.session=saved;RP_STATE.branch=saved.branch;RP_STATE.stage=saved.stage||'branches';RP_STATE.phase=saved.phase||'main';RP_STATE.question=saved.question;}
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
  if(!RP_STATE.session||RP_STATE.session.finished){
    let plan=null,mode='free';
    if(!free){
      try{const j=await cpRequest('/start',{lessonId:data.lessonId});plan=j.plan;mode='plan';CP.data.plans[data.lessonId]=plan;}
      catch(e){if(!['plan_not_due','plan_complete'].includes(e.code)){RP_STATE.err='无法开始本遍，请联网后重试。'+e.message;rpRender();return;}}
    }
    if(request!==RP_STATE.request)return;
    const active=plan?.active;
    const session={schema:2,id:active?.id||crypto.randomUUID(),version:data.version,lessonId:data.lessonId,mode,
      answers:Object.fromEntries(Object.entries(active?.answers||{}).map(([id,a])=>[id,a.letter])),
      corrections:Object.fromEntries(Object.entries(active?.corrections||{}).map(([id,a])=>[id,a.letter])),pending:[],wordEvents:{},branch:branch.id,stage:'read',phase:'main',question:null};
    if(!rpStore(session)){rpRender();return;}
  }
  RP_STATE.branch=branch.id;RP_STATE.stage='read';RP_STATE.phase='main';RP_STATE.question=null;
  if(rpCommit(s=>{s.branch=branch.id;s.stage='read';s.phase='main';s.question=null;}))rpRender();
}
function rpAnswer(q,value){
  if(Object.hasOwn(rpAnswers(),q.id)||!value.trim())return;
  const phase=RP_STATE.phase,session=JSON.parse(JSON.stringify(RP_STATE.session)),answers=session[phase==='main'?'answers':'corrections'];
  answers[q.id]=value;
  if(session.mode==='plan')session.pending.push({questionId:q.id,answer:value,phase});
  else if(phase==='main'){
    const questions=rpAllQuestions().filter(x=>x.word===q.word);
    if(questions.every(x=>Object.hasOwn(answers,x.id))&&!session.wordEvents[q.word])session.wordEvents[q.word]={id:'rp-'+crypto.randomUUID(),word:q.word,rating:questions.every(x=>rpCorrect(x,answers[x.id]))?3:1,at:Date.now(),queued:false};
  }
  if(!rpStore(session)){rpRender();return;}
  rpRender();rpFlush();
}
async function rpFlush(){
  if(RP_STATE.syncing||!RP_STATE.session||!RP_STATE.data)return;
  const session=RP_STATE.session,data=RP_STATE.data,request=RP_STATE.request;
  RP_STATE.syncing=true;
  try{
    if(session.mode==='plan'){
      while(session.pending.length){
        const event=session.pending[0];
        const j=await cpRequest('/root-answer',{lessonId:data.lessonId,version:data.version,roundId:session.id,...event});
        if(request!==RP_STATE.request)return;
        const next=JSON.parse(JSON.stringify(RP_STATE.session));next.pending.shift();
        const active=j.plan?.active;
        if(active){
          for(const [id,a] of Object.entries(active.answers||{}))next.answers[id]=a.letter;
          for(const [id,a] of Object.entries(active.corrections||{}))next.corrections[id]=a.letter;
          next.pending=next.pending.filter(e=>e.phase==='main'?!Object.hasOwn(active.answers||{},e.questionId):!Object.hasOwn(active.corrections||{},e.questionId)&&!active.answers?.[e.questionId]?.ok);
        }
        if(!rpStore(next))return;
        session.pending=next.pending;
        if(CP.data)CP.data.plans[data.lessonId]=j.plan;
        if(j.vocab){REC.vocab={...(REC.vocab||{}),...j.vocab};}
      }
    }else{
      for(const event of Object.values(session.wordEvents)){
        if(event.queued)continue;
        const {queued,...payload}=event;
        localStorage.setItem(VB_PREFIX+event.id,JSON.stringify(payload));
        if(!rpCommit(s=>{s.wordEvents[event.word].queued=true;}))return;
      }
      vbFlushQueue();
    }
    RP_STATE.err='';gqRefreshList();cpBadgeUpdate();
  }catch(e){if(request===RP_STATE.request)RP_STATE.err='已保存在本机，等待同步。'+e.message;}
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
  try{localStorage.setItem(rpKey(d)+':history:'+s.id,JSON.stringify(s));}
  catch{RP_STATE.err='上一轮记录未能归档，请释放浏览器存储后重试。';rpRender();return;}
  if(!rpCommit(next=>{next.finished=true;})){rpRender();return;}
  await rpBegin(d.branches[0],true);
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
function rpRender(){
  const body=$('rp-body'),meta=$('rp-meta');if(!body)return;
  const d=RP_STATE.data,s=RP_STATE.session;
  const oldInput=$('rp-answer');
  const draft=oldInput&&!oldInput.disabled&&oldInput.dataset?.rpRound===s?.id&&oldInput.dataset?.rpQuestion===RP_STATE.question
    ?{value:oldInput.value,focused:document.activeElement===oldInput,start:oldInput.selectionStart,end:oldInput.selectionEnd}:null;
  if(RP_STATE.loading){body.innerHTML='<p role="status">正在读取本节词根联盟…</p>';return;}
  if(!d){body.innerHTML='<p class="gq-note" role="status">'+esc(RP_STATE.err||'本节新练习尚未收录，可使用原配套题。')+'</p><button id="rp-retry">重新读取</button>';if(meta)meta.textContent='';$('rp-retry').onclick=()=>rpLoad(csSel.l+1);return;}
  if(meta)meta.textContent=d.branches.length+' 小组 · '+d.branches.reduce((n,b)=>n+b.words.length,0)+' 词';
  const notice=RP_STATE.err?'<p role="alert">'+esc(RP_STATE.err)+' <button id="rp-sync">重试同步</button></p>':'';
  const plan=cpPlan(d.lessonId),caption=plan?cpStamps(plan)+'<p>'+esc(cpCaption(plan))+'</p>':'';
  const wire=()=>{const retry=$('rp-sync');if(retry)retry.onclick=rpFlush;gqStudyGate();};
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
        +'<button id="rp-list">回看本课</button>'+(s.mode==='free'||s.finished?' <button id="rp-restart">再练一遍 · 不计章</button>':'');
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
    const keys=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith('tfl-rp-v2:')&&!key.includes(':history:'))keys.push(key);}
    for(const key of keys){
      if(RP_STATE.data&&key===rpKey(RP_STATE.data))continue;
      try{
        let saved=JSON.parse(localStorage.getItem(key));if(saved?.schema!==2)continue;
        if(saved.mode==='plan')while(saved.pending.length){
          const event=saved.pending[0],j=await cpRequest('/root-answer',{lessonId:saved.lessonId,version:saved.version,roundId:saved.id,...event});
          const next=JSON.parse(localStorage.getItem(key));if(next.id!==saved.id)break;
          next.pending=next.pending.filter(e=>!(e.questionId===event.questionId&&e.phase===event.phase));
          for(const [id,a] of Object.entries(j.plan?.active?.answers||{}))next.answers[id]=a.letter;
          for(const [id,a] of Object.entries(j.plan?.active?.corrections||{}))next.corrections[id]=a.letter;
          localStorage.setItem(key,JSON.stringify(next));saved=next;
          if(RP_STATE.data&&key===rpKey(RP_STATE.data)){RP_STATE.session=next;rpRender();}
        }
        if(saved.mode==='free')for(const event of Object.values(saved.wordEvents)){
          if(event.queued)continue;const {queued,...payload}=event;localStorage.setItem(VB_PREFIX+event.id,JSON.stringify(payload));
          const next=JSON.parse(localStorage.getItem(key));next.wordEvents[event.word].queued=true;localStorage.setItem(key,JSON.stringify(next));
        }
      }catch{ /* Keep the complete saved session for the next retry or return to this lesson. */ }
    }
    vbFlushQueue();
  }finally{RP_SAVED_FLUSHING=false;}
}
window.addEventListener('online',()=>{rpFlush();rpFlushSaved();});
window.addEventListener('load',()=>rpFlushSaved());
