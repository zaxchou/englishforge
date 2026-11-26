/* Course-sized review plans share the existing answer queue and course view. */
const CP={data:null,error:'',loading:null,openLesson:null,operation:0};
const CP_PAUSE={state:null,minRevision:0,loading:null,saving:false,loadFailed:false,feedback:''};
const CP_PAUSE_SIGNAL='tfl-study-pause-revision';
function studyPauseState(){return CP_PAUSE.state;}
function studyPauseDue(due,anchor,now=Date.now()){
  return typeof StudyPause==='undefined'?due:StudyPause.projectDue(studyPauseState(),due,anchor,now);
}
function studyPauseDay(due,anchor,today){
  return typeof StudyPause==='undefined'?due:StudyPause.projectDay(studyPauseState(),due,anchor,today);
}
function cpPaused(){return studyPauseState()?.paused===true;}
function cpPauseCurrent(){return (studyPauseState()?.revision??-1)>=CP_PAUSE.minRevision;}
async function cpPauseRequest(body){
  const r=await fetch('/api/study-pause',{
    cache:'no-store',signal:AbortSignal.timeout(15000),
    ...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})
  });
  const conflict=!!body&&r.status===409;
  if(!r.ok&&!conflict)throw Error('无法确认复习状态');
  const {revision,windows,paused,now}=await r.json();
  if(!Number.isSafeInteger(revision)||revision<0||!Array.isArray(windows)||typeof paused!=='boolean'||!Number.isFinite(now)){
    throw Error('无法读取复习状态');
  }
  return {state:{revision,windows,paused,now},conflict};
}
function cpPauseAccept(state){
  const prev=studyPauseState();
  if(state.revision<CP_PAUSE.minRevision||state.revision<(prev?.revision??-1))return;
  if(state.revision===prev?.revision&&state.now<prev.now)return;
  CP_PAUSE.state=state;
  CP_PAUSE.loadFailed=false;
  const changed=state.revision!==prev?.revision;
  if(changed)CP_PAUSE.feedback='';
  cpPaintPause();
  if(!changed)return;
  if(state.paused)CP.closePrompt?.(true);
  cpBadgeUpdate();
  cpPaintDashboard();
  window.dispatchEvent(new CustomEvent('study-pause-changed',{detail:state}));
  if(!CP.data)return;
  if(CP.data.pauseRevision===state.revision)cpRefreshPlanViews();
  else cpLoad().then(()=>{cpPaintDashboard();cpRefreshPlanViews();}).catch(()=>{});
}
function studyPauseLoad(){
  if(CP_PAUSE.loading)return CP_PAUSE.loading;
  const minRevision=CP_PAUSE.minRevision;
  CP_PAUSE.loading=cpPauseRequest().then(({state})=>{
    cpPauseAccept(state);
    if(!cpPauseCurrent())throw Error('正在同步复习状态');
    return studyPauseState();
  }).catch(e=>{
    CP_PAUSE.loadFailed=true;
    cpPaintPause();
    throw e;
  }).finally(()=>{
    CP_PAUSE.loading=null;
    // A cross-tab signal may have arrived after this read was sent.
    if(CP_PAUSE.minRevision>minRevision&&!cpPauseCurrent())studyPauseLoad().catch(()=>{});
  });
  return CP_PAUSE.loading;
}
async function cpPauseToggle(){
  if(CP_PAUSE.saving||(!cpPauseCurrent()&&!CP_PAUSE.loadFailed))return;
  CP_PAUSE.saving=true;
  CP_PAUSE.feedback='';
  cpPaintPause();
  try{
    if(!cpPauseCurrent()){await studyPauseLoad();return;}
    const expectedRevision=studyPauseState().revision,paused=!cpPaused();
    const {state,conflict}=await cpPauseRequest({paused,expectedRevision});
    cpPauseAccept(state);
    if(conflict||!cpPauseCurrent()||state.revision!==studyPauseState().revision||cpPaused()!==paused){
      CP_PAUSE.feedback='复习状态已在另一端更新，请确认后再操作。';
    }else{
      CP_PAUSE.feedback=paused?'复习已暂停。':'复习已恢复。';
      try{localStorage.setItem(CP_PAUSE_SIGNAL,String(state.revision));}catch{}
    }
  }catch{
    CP_PAUSE.feedback='暂时无法确认复习状态，请重试。';
  }finally{
    CP_PAUSE.saving=false;
    cpPaintPause();
  }
}
/* 目录短名: 只去掉与课程/序号重复的前缀和冗词, 不改变含义; 完整原名在行 title。
   放在共享脚本顶层, 课程目录与复习卡片共用。 */
function shortLessonTitle(title){
  let t=String(title||'').trim();
  t=t.replace(/^第\s*\d+\s*课\s*[·.、]\s*/,'')
     .replace(/^托福词汇\s*[-－—]\s*/,'')
     .replace(/^总概\s*[-－—]\s*/,'')
     .replace(/^(基础|核心|进阶)词汇\s*·\s*词根\s*/,'$1 · ')
     .replace(/^学科词汇系列\s*[-－—]\s*/,'学科 · ')
     .replace(/^前缀之\s*[“"]?([^”"]+)[”"]?系列$/,'前缀 · $1')
     .replace(/^词汇[“"]三维度[”"]及记忆法$/,'词汇三维度与记忆法')
     .replace(/^[“"]记[”"]几个词汇背诵的小提示$/,'背诵的几个小提示')
     .replace(/^[“"]用[”"]突破托福写作语言大关$/,'用词汇突破写作')
     .replace(/^[“"]考[”"]真题词汇[=＝]考点词汇？$/,'真题词汇＝考点词汇？');
  return t.replace(/\s+/g,' ').trim()||String(title||'');
}
async function cpRequest(path='',body){
  const r=await fetch('/api/course-plan'+path,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const j=await r.json();if(!r.ok){const e=Error(j.error||'复习计划未保存，请重试');e.code=j.code;throw e;}return j;
}
async function cpLoad(){
  if(CP.loading)return CP.loading;
  const stale=j=>Number.isSafeInteger(j.pauseRevision)&&j.pauseRevision<Math.max(
    CP.data?.pauseRevision??0,studyPauseState()?.revision??0,CP_PAUSE.minRevision
  );
  CP.loading=cpRequest().then(async j=>{
    if(stale(j))j=await cpRequest();
    if(stale(j))throw Error('正在同步复习计划，请稍后重试');
    if(Number.isSafeInteger(j.pauseRevision)&&j.pauseRevision>(studyPauseState()?.revision??-1)){
      CP_PAUSE.minRevision=Math.max(CP_PAUSE.minRevision,j.pauseRevision);
      studyPauseLoad().catch(()=>{});
    }
    CP.data=j;CP.error='';cpBadgeUpdate();return j;
  }).catch(e=>{CP.error=e.message;throw e;}).finally(()=>{CP.loading=null;});
  return CP.loading;
}
function cpPlan(lid){return CP.data?.plans?.[lid];}
function cpManaged(k){return /^gen\/(ndf-01|cfcm-01)\//.test(k);}
function cpDate(t){return new Date(t).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric',timeZone:'Asia/Shanghai'});}
function cpPlanDueNow(p,now=Date.now()){
  if((cpPaused()||p.paused)&&Number.isFinite(p.dueRemaining))return p.dueRemaining<=0;
  return !!p.due&&p.due<=now;
}
function cpCaption(p){
  if(!p)return '课后练 · 待开始';
  if(p.complete)return '复习计划完成';
  if(p.active){const a=p.active,n=Object.keys(a.answers||{}).length;return a.phase==='main'?'本遍 '+n+' / '+a.order.length+' 题':a.phase==='correction'?'轮末纠正中':'本遍待盖章';}
  if(!p.stamps.length&&p.begun===false)return '未开始';
  if(cpPaused())return cpPlanDueNow(p)?'可手动复习':'排期已暂停';
  if(p.pendingHistorical)return '历史已练 · 逐步安排复习';
  if(!p.stamps.length)return p.due&&!cpPlanDueNow(p)?'安排在 '+cpDate(p.due):'课后练 · 待开始';
  return p.due&&!cpPlanDueNow(p)?'下次 '+cpDate(p.due):'今天可复习';
}
function cpStamps(p,compact=false){
  const target=p?.target||CP.data?.settings?.target||3,n=p?.stamps?.length||0;
  return '<span class="cp-stamps'+(compact?' compact':'')+'" aria-label="课后练 '+n+' / '+target+' 次">'+Array.from({length:Math.max(target,n)},(_,i)=>'<i class="'+(i<n?'filled':'')+'" aria-hidden="true">'+(i<n?'✓':'·')+'</i>').join('')+'<span>'+n+' / '+target+' 次</span></span>';
}
/* 列表只留一行: 章点 + 最短状态; 完整说法仍在详情与悬浮说明 */
function cpNavMeta(lid){
  const p=cpPlan(lid);if(!p)return null;
  const target=p.target||CP.data?.settings?.target||3,n=p.stamps.length||0;
  let text='',due=false;
  if(p.complete)text='已盖满';
  else if(p.active){const a=p.active;text=a.phase==='main'?('本遍 '+Object.keys(a.answers||{}).length+'/'+a.order.length):a.phase==='correction'?'纠正中':'待盖章';}
  else if(!n&&p.begun===false)text='未开始';
  else if(cpPaused())text=cpPlanDueNow(p)?'可手动复习':'排期已暂停';
  else if(p.pendingHistorical)text=p.due?('下次 '+cpDate(p.due)):'待安排';
  else if(!n)text=cpPlanDueNow(p)?'可开始':(p.due?'下次 '+cpDate(p.due):'待开始');
  else if(cpPlanDueNow(p)){text='今天可复习';due=true;}
  else text=p.due?'下次 '+cpDate(p.due):'待安排';
  return {n,target,text,due};
}
function cpLessonName(lid){const f=courseFind(lid);if(!f)return lid;return courseSeriesName(f.c.title)+' · '+shortLessonTitle(f.c.lessons[f.ix].title);}
function cpOpenLesson(lid){CP.openLesson=lid;csCourseTab='learn';const f=courseFind(lid);if(f){videoSel={c:f.c.id,l:f.ix};csSel={...videoSel};csPick=f.c.id;}nav('course/'+encodeURIComponent(lid));}
/* 复习中心(2026-11-04 用户反馈「像半成品」): 按来源分区, 不再把五套系统混成一张清单。
   排期规则不变; 旧「知识点练习」App 入口撤掉(代码保留), 只留统一的来源入口。 */
function cpPlansOf(prefix){return Object.values(CP.data?.plans||{}).filter(p=>String(p.lessonId).startsWith(prefix));}
function cpGroupSummary(plans){
  const done=plans.filter(p=>p.complete).length,active=plans.find(p=>p.active);
  const started=plans.filter(p=>p.stamps.length||p.active).length;
  return {total:plans.length,done,active,started};
}
function cpEplodSummary(){
  const rows=Object.entries(REC.course||{}).filter(([id,l])=>id.startsWith('eplod-')&&l&&typeof l==='object');
  const today=typeof epDay==='function'?epDay():new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  let todayN=0,full=0,started=0;
  for(const [,l] of rows){
    const days=l.drill?.stampDays||{};const keys=Object.keys(days).filter(d=>Array.isArray(days[d])&&days[d].length);
    if(keys.length)started++;
    if((days[today]||[]).length)todayN++;
    if(keys.length>=3)full++;
  }
  return {learned:rows.length,today:todayN,started,full};
}
function cpWeakDue(){
  const now=Date.now();
  const mistakes=Object.entries(REC.mistakes||{}).filter(([k,m])=>m&&!m.cleared&&!cpManaged(k)&&studyPauseDue(Number(m.due||0),Number(m.last||m.added),now)<=now).length;
  const families=Object.values(REC.families||{}).filter(f=>f&&!f.cleared&&studyPauseDue(Number(f.due||0),Number(f.dueAnchor||f.last||f.added),now)<=now).length;
  return {mistakes,families};
}
/* EnglishPod 覆盖背诵到期(1-3-7 日程): completed 1-2 遍且到期的课会提醒;
   第四遍=可选加练, kind='optional' 只进徽标数字与复习中心列表, 不弹窗不催促。 */
function cpEplodDue(){
  const out=[],cat=(typeof courseById==='function')?courseById('eplod-01'):null;
  if(!cat||typeof EplodRecords==='undefined'||typeof REC==='undefined'||!REC.course)return out;
  const today=(typeof epDay==='function')?epDay():new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  for(const l of cat.lessons){
    const drill=REC.course[l.id]?.drill;if(!drill)continue;
    const st=EplodRecords.coverProgress(drill,l.dialogue_count??0,today,studyPauseDay);
    if(st.dueToday)out.push({id:l.id,pass:st.completed+1,kind:'due'});
    else if(st.extraToday)out.push({id:l.id,pass:4,kind:'optional'});
  }
  return out;
}
/* 徽标口径(2026-11-13 用户反馈「三节到期只显示一个数」): 课后练=所有到期/进行中的课,
   不被每日推荐截断(推荐只决定弹窗顺序); EnglishPod=覆盖背诵到期+可选第四遍。
   与服务端推送门槛(r7「练过才算开始」)同口径: 计划启用时就给每课写了 due=启用日,
   从未开始的课 begun=false, 不算到期——否则没学过的万词班会全部涌进提醒。 */
function cpDueAll(){
  const now=Date.now(),ids=new Set();
  for(const p of Object.values(CP.data?.plans||{})){
    if(!p||p.complete||p.begun===false)continue;
    if(p.begun&&(p.active||cpPlanDueNow(p,now)))ids.add(p.lessonId);
  }
  for(const r of (CP.data?.recommendations||[]))ids.add(r);
  const ep=cpEplodDue(),epDue=ep.filter(x=>x.kind==='due'),epOpt=ep.filter(x=>x.kind==='optional');
  return {plan:ids.size,planIds:ids,ep,epDue,epOpt,red:ids.size+epDue.length,yellow:epOpt.length};
}
async function cpExamCard(){
  let exams=[];
  try{exams=(await api('/api/exams')).exams||[];}catch(e){return '<section class="cp-sec"><h4>期末考试</h4><p class="cp-sec-note">暂时读取不到试卷。</p></section>';}
  if(!exams.length)return '';
  return exams.map(x=>{
    const u=x.unlock||{done:0,need:x.total||0,ready:false};
    const status=x.active?'进行中 · 已答 '+x.active.answered+' / '+x.total:x.last?'上次 '+x.last.correct+' / '+x.last.total+'（'+Math.round((x.last.score||0)*100)+'%）':'未开始';
    return '<section class="cp-sec cp-sec-exam"><h4>期末考试</h4><div class="cp-exam"><div><b>'+esc(x.title)+'</b><span class="cp-exam-meta">'+x.total+' 题 · 不限时 · 交卷后逐题复盘</span><p>'+esc(status)+'</p><p class="cp-sec-note">'+(u.ready?'课程已学完，可以开考':'还差 '+(u.need-u.done)+' 节学完解锁')+'</p></div><div class="cp-exam-actions">'+(u.ready?'<button class="pri" data-exam-go="'+esc(x.id)+'">'+(x.active?'继续考试':'开始考试')+' →</button>':'')+'<button data-exam-go="'+esc(x.id)+'">查看试卷</button></div></div></section>';
  }).join('');
}
function cpPaintPause(){
  const button=$('cp-pause-toggle');if(!button)return;
  const ready=cpPauseCurrent(),paused=cpPaused();
  const title=paused?'复习已暂停':'复习安排';
  const hint=paused?'提醒已暂停，复习排期将从恢复时接着计算。你仍可以练习或继续进行中的一遍。':'需要休息时，可以暂停复习排期和到期提醒。';
  $('cp-pause-title').textContent=title;
  $('cp-pause-hint').textContent=hint;
  button.textContent=ready?(paused?'恢复复习':'暂停复习'):CP_PAUSE.loadFailed?'重试读取状态':'正在读取状态…';
  button.setAttribute('aria-disabled',String(CP_PAUSE.saving||(!ready&&!CP_PAUSE.loadFailed)));
  const status=$('cp-pause-status');
  const message=CP_PAUSE.saving?'正在确认…':CP_PAUSE.feedback||(!ready&&CP_PAUSE.loadFailed?'暂时无法读取复习状态。':'');
  if(status.textContent!==message)status.textContent=message;
}
async function cpDashboard(){
  const host=$('course-memory-content');if(!host)return;
  host.innerHTML='<div class="cp-dashboard"><div class="cp-heading"><div><h3>复习中心</h3><p>按来源分区：课后练盖章、期末考、EnglishPod 覆盖、错题与词根。各自独立计算，互不混排。</p></div><span class="cp-total" id="cp-dashboard-total"></span></div>'
    +'<section class="cp-pause" aria-labelledby="cp-pause-title"><div><h4 id="cp-pause-title"></h4><p id="cp-pause-hint"></p></div><button type="button" id="cp-pause-toggle" aria-describedby="cp-pause-hint"></button><p id="cp-pause-status" role="status"></p></section>'
    +'<div id="cp-dashboard-body"><p class="tfl-loading" role="status"><i aria-hidden="true"></i>正在读取复习计划…</p></div></div>';
  $('cp-pause-toggle').onclick=cpPauseToggle;
  cpPaintPause();
  if(!cpPauseCurrent())studyPauseLoad().catch(()=>{});
  const body=$('cp-dashboard-body');
  let exam;
  try{await cpLoad();exam=await cpExamCard();}catch(e){
    if(!body.isConnected)return;
    body.innerHTML='<p role="alert">'+esc(e.message)+'</p><button>重试</button>';
    body.querySelector('button').onclick=cpDashboard;return;
  }
  if(!body.isConnected)return;
  body.innerHTML='<div id="cp-dashboard-today"></div>'+exam+'<div id="cp-dashboard-sources"></div>'
    +cpSettingsHTML(CP.data.settings)
    +'<p class="cp-sec-note cp-foot-note">旧「知识点练习」已收进历史，不再从这里进入；需要时可在真题训练里选题。</p>';
  body.querySelectorAll('[data-exam-go]').forEach(b=>b.onclick=()=>nav('final/ndf-01-final'));
  cpPaintDashboard();cpWireSettings(body);gqRefreshList();
}
function cpPaintDashboard(){
  const sources=$('cp-dashboard-sources');if(!sources||!CP.data)return;
  const today=$('cp-dashboard-today'),d=CP.data,recs=d.recommendations||[],paused=cpPaused();
  const ndf=cpGroupSummary(cpPlansOf('ndf-01')),cf=cpGroupSummary(cpPlansOf('cfcm-01'));
  const due=cpDueAll(),epDueN=due.epDue.length,epOptN=due.epOpt.length;
  const extraDue=Math.max(0,due.plan-recs.length);
  const row=p=>'<div class="cp-lesson"><div><b>'+esc(cpLessonName(p.lessonId))+'</b>'+cpStamps(p)+'<p>'+esc(cpCaption(p))+'</p></div><button data-cp-open="'+esc(p.lessonId)+'">'+(p.active?'继续本遍':'复习本课')+' →</button></div>';
  const ep=cpEplodSummary(),weak=cpWeakDue();
  const epRows=due.ep.map(item=>{
    const name=(typeof lessonTitle==='function'&&lessonTitle(item.id))||item.id;
    const optional=item.kind==='optional';
    const label=optional?'三遍已完成 · 第四遍可选（不限时）':'第 '+item.pass+' 遍'+(paused?'可复习':'到期');
    return '<div class="cp-lesson'+(optional?' opt':'')+'"><div><b>'+esc(name)+'</b>'+(optional?'<span class="cp-opt-tag">可选</span>':'<span class="cp-due-tag">'+(paused?'可复习':'到期')+'</span>')+'<p>'+esc(label)+'</p></div><button data-ep-open="'+esc(item.id)+'">'+(optional?'背第四遍':'去背诵')+' →</button></div>';
  }).join('');
  $('cp-dashboard-total').textContent=ndf.started+' / '+ndf.total+' 课已开始 · '+ndf.done+' 课盖满';
  sources.classList.toggle('cp-paused',paused);
  today.innerHTML=paused?'<div class="cp-today"><b>可选练习</b></div>':'<div class="cp-today"><div><b>'+(due.red>0?('今天必做 '+due.red+' 件'+(extraDue>0?('（推荐 '+recs.length+' + 自选 '+extraDue+'）'):'')+(epOptN?('，另有 '+epOptN+' 课可选第四遍，不做也行'):'')):(epOptN?('今天没有必做项，另有 '+epOptN+' 课可选第四遍，不做也行'):(d.remainingToday>0?'今天暂无到期的课后练':'今天的课后练复习已完成')))+'</b><p>'+(extraDue>0?'到期但没排进推荐的部分列在下面，练哪课自己挑，不用按顺序。':(d.remainingToday>0?'按课慢慢来，不用清空所有错题。':'可以收工了，想多练再选一课。'))+'</p></div>'+(recs.length?'<button class="pri" data-cp-open="'+esc(recs[0])+'">'+(d.remainingToday>0?'开始今天的复习':'再练一课')+' →</button>':'')+'</div>';
  const open=new Set([...sources.querySelectorAll('details[open]')].map(el=>el.dataset.cpAll));
  const courseSection=(prefix,title,group,empty)=>{
    const plans=cpPlansOf(prefix);
    const ids=[...new Set([...recs,...due.planIds])];
    const rows=ids.filter(id=>id.startsWith(prefix)).map(cpPlan).filter(Boolean).map(row).join('');
    return '<section class="cp-sec"><h4>'+title+' · 课后练盖章<span>'+group.started+' 已开始 · '+group.done+' / '+group.total+' 盖满</span></h4>'
      +'<div class="cp-lessons">'+(rows||'<p class="cp-sec-note">'+empty+'</p>')+'</div>'
      +'<details class="cp-all" data-cp-all="'+prefix+'"'+(open.has(prefix)?' open':'')+'><summary>'+title+'进度 · '+group.total+' 课</summary>'+plans.map(row).join('')+'</details></section>';
  };
  const empty=paused?'可以展开进度挑一课。':'今天没有到期的课后练；可以展开进度挑一课。';
  sources.innerHTML=courseSection('ndf-01','新东方词汇课',ndf,empty)
    +courseSection('cfcm-01','万词班',cf,cf.started?empty:cf.total+' 节已排入计划，还没有开始。按自己的节奏随时开始第一课。')
    +'<section class="cp-sec"><h4>EnglishPod · 覆盖背诵<span>三个不同日期各一遍，第四遍可选</span></h4>'
      +'<p class="cp-sec-note">已开始 '+ep.started+' 节 · 今日已计入 '+ep.today+' 节 · 三遍完成 '+ep.full+' 节'+(epDueN?(' · <span class="cp-due-tag">'+(paused?'可复习 ':'必背 ')+epDueN+' 课</span>'):'')+(epOptN?(' · <span class="cp-opt-tag">可选 '+epOptN+' 课</span>'):'')+'</p>'
      +(epRows?'<div class="cp-lessons">'+epRows+'</div>':'<div class="cp-sec-actions"><button data-ep-go>打开 EnglishPod 列表 →</button></div>')+'</section>'
    +'<section class="cp-sec"><h4>错题与词根</h4><p class="cp-sec-note">'+(paused?'当前可练':'今日到期')+'：错题 '+weak.mistakes+' 题 · 词根家族 '+weak.families+' 个</p>'
      +'<div class="cp-sec-actions"><button data-review-go>去错题本 →</button><button data-fam-go>词根家族练习 →</button></div></section>';
  for(const part of [today,sources])part.querySelectorAll('[data-cp-open]').forEach(b=>b.onclick=()=>cpOpenLesson(b.dataset.cpOpen));
  sources.querySelectorAll('[data-ep-open]').forEach(b=>b.onclick=()=>nav('eplod/'+encodeURIComponent(b.dataset.epOpen)));
  sources.querySelectorAll('[data-ep-go]').forEach(b=>b.onclick=()=>nav('eplod'));
  sources.querySelectorAll('[data-review-go]').forEach(b=>b.onclick=()=>nav('exam/review'));
  sources.querySelectorAll('[data-fam-go]').forEach(b=>b.onclick=()=>gqOpenFamilies(null));
}
function cpSettingsHTML(s){return '<details class="cp-settings"><summary>复习计划设置</summary><form id="cp-settings"><label>盖章次数<select name="target">'+[1,2,3,4,5,6].map(n=>'<option'+(n===s.target?' selected':'')+'>'+n+'</option>').join('')+'</select></label><label>安排方式<select name="mode"><option value="fixed"'+(s.mode==='fixed'?' selected':'')+'>固定间隔</option><option value="adaptive"'+(s.mode==='adaptive'?' selected':'')+'>根据表现调整</option></select></label><label>每日推荐<select name="daily">'+[1,2,3,4,5].map(n=>'<option value="'+n+'"'+(n===s.daily?' selected':'')+'>'+n+' 课</option>').join('')+'</select></label><div id="cp-intervals"></div><p>间隔从上一遍实际完成日算起。固定模式只记录感受；根据表现调整会结合正确率和感受缩短或延长间隔。盖满后结束。</p><p>修改会调整后续安排，已有章保留，已开始的本遍可继续。历史已练课程从计划启用日安排，不推算旧完成日期。</p><button class="pri" type="submit">保存设置</button><span id="cp-settings-status" role="status"></span></form></details>';}
function cpWireSettings(host){
  const form=host.querySelector('#cp-settings');if(!form)return;let s=CP.data.settings;
  const draw=()=>{const box=form.querySelector('#cp-intervals'),old=[...box.querySelectorAll('input')].map(x=>Number(x.value));box.innerHTML=Array.from({length:Number(form.elements.target.value)-1},(_,i)=>'<label>第 '+(i+2)+' 遍间隔<input name="interval-'+i+'" type="number" min="1" max="60" required value="'+(old[i]||s.intervals[i]||[3,7,14,21,30][i])+'"><span>天</span></label>').join('');};draw();form.elements.target.onchange=draw;
  form.onsubmit=async e=>{e.preventDefault();const status=form.querySelector('#cp-settings-status'),button=form.querySelector('[type=submit]');button.disabled=true;status.textContent='保存中…';try{const j=await cpRequest('/settings',{target:Number(form.elements.target.value),mode:form.elements.mode.value,daily:Number(form.elements.daily.value),intervals:[...form.querySelectorAll('#cp-intervals input')].map(x=>Number(x.value)),revision:s.revision});CP.data=j;s=j.settings;status.textContent='已保存，已有章保留。';gqRefreshList();await cpDashboard();const panel=$('cp-settings');if(panel)panel.closest('details').open=true;const saved=$('cp-settings-status');if(saved)saved.textContent='已保存，已有章保留。';}catch(e){if(e.code==='settings_conflict'){try{await cpLoad();s=CP.data.settings;status.textContent='另一端已修改计划，你的输入保留；再次保存会采用当前输入。';}catch{status.textContent='设置已被另一端修改，暂时无法读取新版本，请稍后重试。';}}else status.textContent=e.message;}finally{button.disabled=false;}};
}
function cpOverviewHTML(lid){const p=cpPlan(lid);if(!CP.data)return '<div class="cp-plan"><p role="status"'+(CP.error?'':' class="tfl-loading"')+'>'+(CP.error?esc(CP.error):'<i aria-hidden="true"></i>正在读取盖章计划…')+'</p><button id="cp-plan-retry">重试读取计划</button></div>';
  const a=p?.active,can=!p?.complete&&(a||(!p?.pendingHistorical&&(!p?.due||cpPlanDueNow(p))));
  return '<div class="cp-plan">'+cpStamps(p)+'<p>'+esc(cpCaption(p))+'</p><div class="cp-actions">'+(can?'<button class="pri" id="cp-plan-start">'+(a?'继续本遍':'开始第 '+((p?.stamps.length||0)+1)+' 遍')+' →</button>':'')+'<button id="cp-free">自主练习'+(can?'':' · 不计章')+'</button><button id="cp-plan-settings">复习计划设置</button></div><p class="cp-hint">每遍覆盖本课课堂题，错题在轮末纠正一次。扩展挑战选做。</p>'+(p?.stamps.length?'<div class="cp-history">'+p.stamps.map((s,i)=>'<span>第'+(i+1)+'章 · '+(s.historical?'历史已练 · 日期未知':cpDate(s.at)+' · 首次正确 '+s.right+'/'+s.total)+'</span>').join('')+'</div>':'')+'</div>';
}
function cpRefreshPlanViews(){
  gqRefreshList();
  if(typeof GQ_UI==='undefined'||GQ_UI.phase!=='ready'||GQ_UI.planRound)return;
  const panel=document.querySelector('#v-course.on #gq-body > .gq-in > .cp-plan');
  if(!panel||panel.querySelector('#cp-plan-start:disabled'))return;
  const parent=panel.parentElement;
  const focus=panel.contains(document.activeElement)?document.activeElement.id:'';
  panel.outerHTML=cpOverviewHTML(GQ_UI.lessonId);
  cpWireOverview(parent);
  if(focus)$(focus)?.focus();
}
function cpWireOverview(body){const lid=GQ_UI.lessonId;
  const start=body.querySelector('#cp-plan-start');if(start)start.onclick=()=>cpStart(lid);
  const free=body.querySelector('#cp-free');if(free)free.onclick=()=>{GQ_UI.planRound=null;gqStart(gqTierIds(GQ_UI.quiz,'core'),'core');};
  const settings=body.querySelector('#cp-plan-settings');if(settings)settings.onclick=()=>{csCourseGo('review');history.replaceState(null,'','#/course/review');};
  const retry=body.querySelector('#cp-plan-retry');if(retry)retry.onclick=async()=>{try{await cpLoad();}catch{}if(GQ_UI.lessonId===lid)renderGenQuiz();};
}
async function cpStart(lid){const operation=++CP.operation;const button=$('cp-plan-start');if(button)button.disabled=true;try{
  const meta=await api('/api/ai/quiz');if(!meta.lessons?.includes(lid))throw Error('本课练习暂不可用，请返回总览重试。');
  const cached=await api('/api/ai/quiz',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lessonId:lid})});
  const j=await cpRequest('/start',{lessonId:lid});CP.data.plans[lid]=j.plan;CP.data.settings=j.settings;if(GQ_UI.lessonId!==lid||CP.operation!==operation)return;
  GQ_UI.quiz=cached.quiz;cpResume(j.plan);
}catch(e){if(GQ_UI.lessonId===lid&&CP.operation===operation){GQ_UI.err=e.message;renderGenQuiz();}}finally{if(button?.isConnected)button.disabled=false;}}
function cpResume(p){const a=p.active;if(!a)return;
  const st=GQ_UI;st.planRound=a.id;st.planPhase=a.phase;st.err='';st.planSaving=false;st.planConflict=false;
  if(a.phase==='finish'){st.phase='plan-finish';renderGenQuiz();gqScrollToCard();return;}
  const correction=a.phase==='correction',order=correction?a.correctionOrder:a.order,answers=correction?a.corrections:a.answers;
  gqStart(order,'core');st.planRound=a.id;st.planPhase=a.phase;st.answers=JSON.parse(JSON.stringify(answers||{}));
  for(const item of recAttQueue.filter(x=>x.planRound===a.id&&x.planPhase===a.phase)){const q=st.quiz.questions.find(q=>gqQid(st.quiz,q)===item.ref.qid);if(q&&!st.answers[q.id])st.answers[q.id]={letter:item.answer,ok:item.ok,unsure:item.unsure,eventId:item.id};}
  st.ix=order.findIndex(id=>!st.answers[id]);if(st.ix<0)st.ix=order.length-1;renderGenQuiz();gqScrollToCard();
}
function cpHasPending(round){return recAttQueue.some(x=>x.planRound===round);}
async function cpAdvance(){const st=GQ_UI,lid=st.lessonId,roundId=st.planRound;if(st.planSaving)return;const operation=++CP.operation;st.planSaving=true;st.err='';renderGenQuiz();
  try{if(cpHasPending(st.planRound)){recFlushAttempts();throw Error('本遍答案正在保存，已暂存在本机；联网保存后点“继续”。');}await cpLoad();if(GQ_UI.lessonId!==lid||GQ_UI.planRound!==roundId||CP.operation!==operation)return;const p=cpPlan(lid);if(!p?.active||p.active.id!==roundId)throw Error('本遍状态已变化，请返回总览继续，已有作答保留。');cpResume(p);}catch(e){if(GQ_UI.lessonId===lid&&GQ_UI.planRound===roundId&&CP.operation===operation){st.err=e.message;st.planSaving=false;renderGenQuiz();}}finally{if(GQ_UI.lessonId===lid&&GQ_UI.planRound===roundId&&CP.operation===operation)st.planSaving=false;}}
function cpFinishHTML(){const st=GQ_UI,p=cpPlan(st.lessonId),a=p?.active;return '<div class="gq-in cp-finish">'+cpStamps(p)+'<h3>本遍已完成，盖下这一章</h3><p>首次正确 '+Object.values(a?.answers||{}).filter(x=>x.ok).length+' / '+(a?.order.length||0)+' 题。错题已经纠正一遍。</p><p>这一遍感觉怎么样？</p><div class="cp-actions">'+[['hard','费劲'],['good','刚好'],['easy','轻松']].map(([v,t])=>'<button data-cp-rating="'+v+'"'+(st.planSaving?' disabled':'')+'>'+t+' · 盖章</button>').join('')+'</div><p role="status">'+esc(st.err||'盖章后会显示下一次日期；固定间隔不受感受影响。')+'</p></div>';}
function cpWireFinish(body){body.querySelectorAll('[data-cp-rating]').forEach(b=>b.onclick=async()=>{const st=GQ_UI,lid=st.lessonId,roundId=st.planRound;if(st.planSaving)return;const operation=++CP.operation;st.planSaving=true;st.err='';renderGenQuiz();try{const j=await cpRequest('/finish',{lessonId:lid,roundId,rating:b.dataset.cpRating});CP.data.plans[lid]=j.plan;CP.data.settings=j.settings;await cpLoad().catch(()=>{});if(GQ_UI.lessonId!==lid||CP.operation!==operation)return;st.planRound=null;st.phase='ready';st.err='本遍已盖章。'+cpCaption(j.plan);st.planSaving=false;renderGenQuiz();gqRefreshList();}catch(e){if(GQ_UI.lessonId===lid&&CP.operation===operation){st.err=e.message;renderGenQuiz();}}finally{if(CP.operation!==operation)return;st.planSaving=false;if(GQ_UI.lessonId===lid&&st.phase==='plan-finish')renderGenQuiz();}});}
function cpAcceptAttempt(item,j){if(j.plan&&CP.data)CP.data.plans[j.plan.lessonId]=j.plan;if(j.planError&&GQ_UI.planRound===item.planRound){GQ_UI.err=j.planError;GQ_UI.planConflict=true;}if(j.plan)gqRefreshList();}
/* ---- 到期提醒(r5): 右上角徽标 + 到期弹窗(每课每天至多一次)。
   到期判定完全来自服务端 summary 的 recommendations(已含每日推荐量与进行中的课),
   本地只负责去打扰: 「稍后」的课当天记入 tfl-cp-snooze; 答题中/正开着该课页不弹。 ---- */
function cpTodayKey(){return new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});}
function cpDuePick(recs,snooze,day){return (Array.isArray(recs)?recs:[]).find(lid=>snooze[lid]!==day)||null;}
function cpSnoozeLoad(){
  let out={};try{const old=JSON.parse(localStorage.getItem('tfl-cp-snooze')||'{}');if(old&&typeof old==='object'&&!Array.isArray(old))out={...old};}catch(e){}
  const day=cpTodayKey(),prefix='tfl-cp-snooze/'+day+'/';
  try{for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith(prefix)&&localStorage.getItem(key)===day)out[decodeURIComponent(key.slice(prefix.length))]=day;}}catch(e){}
  return out;
}
function cpSnooze(lid){
  const day=cpTodayKey(),prefix='tfl-cp-snooze/'+day+'/';
  CP.snooze={...CP.snooze,...cpSnoozeLoad()};
  for(const key of Object.keys(CP.snooze))if(CP.snooze[key]!==day)delete CP.snooze[key];
  CP.snooze[lid]=day;
  /* 每课独立键防止并发覆盖; 旧聚合键继续兼容已有页面。 */
  try{localStorage.setItem(prefix+encodeURIComponent(lid),day);localStorage.setItem('tfl-cp-snooze',JSON.stringify(CP.snooze));
    for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(key?.startsWith('tfl-cp-snooze/')&&!key.startsWith(prefix))localStorage.removeItem(key);}
  }catch(e){}
}
function cpBadgeUpdate(){
  const b=$('cp-bell');if(!b)return;
  const paused=cpPaused(),due=cpDueAll(),urgent=cpPauseCurrent()&&!paused&&due.red>0;
  const label=paused?'复习已暂停':urgent?'复习到期':'复习中心';
  let title=paused?'复习已暂停，打开复习中心':label;
  if(urgent){
    const parts=[];
    if(due.plan)parts.push(due.plan+' 课课后练到期');
    if(due.epDue.length)parts.push(due.epDue.length+' 课覆盖背诵到期');
    title='今天必做：'+parts.join(' · ');
    if(due.yellow)title+='；另有 '+due.yellow+' 课可选第四遍（可选，不计入）';
  }
  b.title=title;
  b.setAttribute('aria-label',title);
  b.classList.toggle('has-due',urgent);
  b.classList.toggle('is-paused',paused);
  b.classList.toggle('has-opt',urgent&&due.yellow>0);
  const text=b.querySelector('.cp-bell-t');if(text)text.textContent=label;
  const n=b.querySelector('#cp-bell-n');if(n)n.textContent=urgent?(due.red>9?'9+':String(due.red)):'';
  b.hidden=false;
}
function cpBadgeGo(){
  if(typeof navMenuOpen==='function')navMenuOpen(false);
  if(location.hash==='#/course/review')return;
  if(cpPauseCurrent()&&!cpPaused()){
    const due=cpDueAll();
    if(due.red===1){
      if(due.epDue.length){nav('eplod/'+encodeURIComponent(due.epDue[0].id));return;}
      const rec=(CP.data?.recommendations||[])[0];
      if(rec){cpOpenLesson(rec);return;}
    }
  }
  if(typeof courseMode!=='undefined'&&courseMode==='course'&&document.querySelector('#v-course.on')){
    csCourseGo('review');history.replaceState(null,'','#/course/review');
    return;
  }
  nav('course/review');
}
function cpMountPrompt(mask,key,open){
  CP.closePrompt?.();
  const previous=document.activeElement;
  mask.id='cp-due-mask';mask.className='cp-due-mask';mask.dataset.lesson=key;
  const close=(restoreFocus=false)=>{
    const focused=restoreFocus&&mask.contains(document.activeElement);
    document.removeEventListener('keydown',onKey);
    mask.remove();
    if(CP.closePrompt===close)CP.closePrompt=null;
    if(focused)(previous?.isConnected&&previous!==document.body?previous:$('cp-bell'))?.focus();
  };
  const later=()=>{cpSnooze(key);close(true);};
  const onKey=e=>{if(e.key==='Escape')later();};
  CP.closePrompt=close;
  mask.addEventListener('click',e=>{if(e.target===mask)later();});
  const now=mask.querySelector('#cp-due-now');
  now.onclick=()=>{cpSnooze(key);close();open();};
  mask.querySelector('#cp-due-later').onclick=later;
  document.addEventListener('keydown',onKey);
  document.body.append(mask);
  now.focus();
}
function cpDuePromptShow(lid){
  const p=cpPlan(lid),target=p?.target||CP.data?.settings?.target||3,n=p?.stamps?.length||0,mask=document.createElement('div');
  const line=p&&p.active?'本遍还没盖完章，接着做完就能盖上。':p&&p.complete?'这门课已盖满章，可以自由回顾。':'第 '+(n+1)+' 遍（共 '+target+' 遍）到期了，今天做完就能盖上这一章。';
  mask.innerHTML='<div class="cp-due" role="dialog" aria-modal="true" aria-label="复习到期提醒"><p class="cp-due-kicker">复习到期</p><b>'+esc(cpLessonName(lid))+'</b><p>'+line+'</p><div class="cp-due-actions"><button class="pri" id="cp-due-now">马上学习</button><button id="cp-due-later">稍后学习</button></div></div>';
  cpMountPrompt(mask,lid,()=>cpOpenLesson(lid));
}
async function cpDueCheck(){
  const [plans,pause]=await Promise.all([cpLoad().catch(()=>null),studyPauseLoad().catch(()=>null)]);
  cpBadgeUpdate();
  if(!pause||!cpPauseCurrent()||cpPaused()||CP_PAUSE.saving||document.hidden||document.getElementById('cp-due-mask'))return;
  if(typeof epWholeLocked==='function'&&epWholeLocked())return;
  /* 正在录音/等待麦克风/回听/音频兜底时也不打断(与答题中同口径) */
  if(typeof EP!=='undefined'&&EP.st&&(EP.st.recording||EP.st.recPending||EP.st.wpTake||EP.st.blobRequest||EP.replay))return;
  if(location.hash.startsWith('#/course')&&GQ_UI&&(GQ_UI.phase==='quiz'||GQ_UI.phase==='prep'||GQ_UI.planRound))return;   /* 仅可见课程中的活动练习抑制提醒 */
  if(location.hash.startsWith('#/course'))return;   /* 人已在课程/复习页, 不重复打扰(不依赖页面状态就位时序) */
  const snooze=cpSnoozeLoad(),day=cpTodayKey();
  const recs=plans&&(plans.pauseRevision===undefined||plans.pauseRevision===studyPauseState().revision)?plans.recommendations:[];
  const lid=cpDuePick(recs,snooze,day);   /* 每次实时回读, 多标签页共享同一天的稍后记录 */
  if(lid){cpDuePromptShow(lid);return;}
  /* EnglishPod 覆盖背诵(1-3-7): 每天至多弹一次, 提最靠前的一课; 多课时徽标数字仍全量,
     可选第四遍(kind='optional')永不弹窗。 */
  const epDue=cpEplodDue().filter(x=>x.kind==='due');
  if(epDue.length&&snooze['#eplod']!==day)cpEpPromptShow(epDue[0]);
}
function cpEpPromptShow(item){
  const mask=document.createElement('div');
  const name=(typeof lessonTitle==='function'?lessonTitle(item.id):item.id)||item.id;
  mask.innerHTML='<div class="cp-due" role="dialog" aria-modal="true" aria-label="背诵到期提醒"><p class="cp-due-kicker">覆盖背诵到期</p><b>'+esc(name)+'</b><p>第 '+item.pass+' 遍到期了，今天朗读或背诵一遍就能盖上。</p><div class="cp-due-actions"><button class="pri" id="cp-due-now">马上背诵</button><button id="cp-due-later">稍后学习</button></div></div>';
  cpMountPrompt(mask,'#eplod',()=>nav('eplod/'+encodeURIComponent(item.id)));
}
function cpDueWatch(){
  if(CP.timer)return;
  if(!CP.snooze)CP.snooze=cpSnoozeLoad();
  const refresh=()=>{if(!document.hidden)cpDueCheck();};
  CP.timer=setInterval(refresh,240000);
  document.addEventListener('visibilitychange',refresh);
  window.addEventListener('focus',refresh);
  window.addEventListener('storage',e=>{
    if(e.key===CP_PAUSE_SIGNAL){
      const revision=Number(e.newValue);
      if(Number.isSafeInteger(revision)&&revision>(studyPauseState()?.revision??-1)){
        CP_PAUSE.minRevision=Math.max(CP_PAUSE.minRevision,revision);
        cpPaintPause();cpBadgeUpdate();
        studyPauseLoad().catch(()=>{});
      }
      return;
    }
    if(e.key!=='tfl-cp-snooze'&&!e.key?.startsWith('tfl-cp-snooze/'))return;
    CP.snooze=cpSnoozeLoad();
    const mask=document.getElementById('cp-due-mask');
    if(mask&&CP.snooze[mask.dataset.lesson]===cpTodayKey())CP.closePrompt?.(true);
  });
  refresh();
}
