/* Course-sized review plans share the existing answer queue and course view. */
const CP={data:null,error:'',loading:null,openLesson:null,operation:0};
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
  CP.loading=cpRequest().then(j=>{CP.data=j;CP.error='';return j;}).catch(e=>{CP.error=e.message;throw e;}).finally(()=>{CP.loading=null;});
  return CP.loading;
}
function cpPlan(lid){return CP.data?.plans?.[lid];}
function cpManaged(k){return /^gen\/(ndf-01|cfcm-01)\//.test(k);}
function cpDate(t){return new Date(t).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric',timeZone:'Asia/Shanghai'});}
function cpCaption(p){
  if(!p)return '课后练 · 待开始';
  if(p.complete)return '复习计划完成';
  if(p.active){const a=p.active,n=Object.keys(a.answers||{}).length;return a.phase==='main'?'本遍 '+n+' / '+a.order.length+' 题':a.phase==='correction'?'轮末纠正中':'本遍待盖章';}
  if(p.pendingHistorical)return '历史已练 · 逐步安排复习';
  if(!p.stamps.length)return p.due>Date.now()?'安排在 '+cpDate(p.due):'课后练 · 待开始';
  return p.due&&p.due>Date.now()?'下次 '+cpDate(p.due):'今天可复习';
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
  else if(p.pendingHistorical)text=p.due?('下次 '+cpDate(p.due)):'待安排';
  else if(!n)text=(p.due&&p.due<=Date.now())?'可开始':(p.due?'下次 '+cpDate(p.due):'待开始');
  else if(p.due&&p.due<=Date.now()){text='今天可复习';due=true;}
  else text='下次 '+cpDate(p.due);
  return {n,target,text,due};
}
function cpLessonName(lid){const f=courseFind(lid);if(!f)return lid;return courseSeriesName(f.c.title)+' · '+shortLessonTitle(f.c.lessons[f.ix].title);}
function cpOpenLesson(lid){CP.openLesson=lid;csCourseTab='learn';const f=courseFind(lid);if(f){videoSel={c:f.c.id,l:f.ix};csSel={...videoSel};csPick=f.c.id;}nav('course/'+encodeURIComponent(lid));}
async function cpDashboard(){
  const host=$('course-memory-content');if(!host)return;
  host.innerHTML='<p role="status">正在读取复习计划…</p>';
  try{await cpLoad();}catch(e){host.innerHTML='<p role="alert">'+esc(e.message)+'</p><button id="cp-reload">重试</button>';host.querySelector('button').onclick=cpDashboard;return;}
  const d=CP.data,all=Object.values(d.plans||{}),done=all.filter(p=>p.complete).length,recs=d.recommendations||[];
  host.innerHTML='<div class="cp-dashboard"><div class="cp-heading"><div><h3>课后练 · 盖章复习</h3><p>每课 '+d.settings.target+' 次，分段完成也算。晚几天回来，已有章照样保留。</p></div><span class="cp-total">'+done+' 课已盖满</span></div>'
    +'<div class="cp-today"><div><b>'+(d.remainingToday>0?(recs.length?'今天建议复习 '+Math.min(d.remainingToday,recs.length)+' 课':'今天暂无到期课程'):'今天的复习已完成')+'</b><p>'+(d.remainingToday>0?'按课慢慢来，不用清空所有错题。':'可以收工了，想多练再选一课。')+'</p></div>'+(recs.length?'<button class="pri" data-cp-open="'+esc(recs[0])+'">'+(d.remainingToday>0?'开始今天的复习':'再练一课')+' →</button>':'')+'</div>'
    +'<div class="cp-lessons">'+recs.map(lid=>{const p=cpPlan(lid);return '<div class="cp-lesson"><div><b>'+esc(cpLessonName(lid))+'</b>'+cpStamps(p)+'<p>'+esc(cpCaption(p))+'</p></div><button data-cp-open="'+esc(lid)+'">'+(p.active?'继续本遍':'复习本课')+' →</button></div>';}).join('')+'</div>'
    +cpSettingsHTML(d.settings)
    +'<details class="cp-all"><summary>全部课程进度 · '+all.length+' 课</summary>'+all.map(p=>'<div class="cp-lesson"><div><b>'+esc(cpLessonName(p.lessonId))+'</b>'+cpStamps(p)+'<p>'+esc(cpCaption(p))+'</p></div><button data-cp-open="'+esc(p.lessonId)+'">查看</button></div>').join('')+'</details>'
    +'<details class="cp-extra"><summary>自主补充练习 · 知识点混练、抽查与词根</summary><p>这里是选做练习，不计盖章，也不增加必做任务。</p><button id="cp-old-review">打开知识点练习</button><div id="cp-old-host" hidden></div><button id="cp-families">词根家族练习</button></details></div>';
  host.querySelectorAll('[data-cp-open]').forEach(b=>b.onclick=()=>cpOpenLesson(b.dataset.cpOpen));
  host.querySelector('#cp-families').onclick=()=>gqOpenFamilies(null);
  host.querySelector('#cp-old-review').onclick=async()=>{const box=host.querySelector('#cp-old-host');box.hidden=false;try{const m=await import('/review/app.mjs');await m.mountReview(box,{embedded:true});host.querySelector('#cp-old-review').hidden=true;}catch{box.textContent='补充练习未能加载，请稍后重试。';}};
  cpWireSettings(host);gqRefreshList();
}
function cpSettingsHTML(s){return '<details class="cp-settings"><summary>复习计划设置</summary><form id="cp-settings"><label>盖章次数<select name="target">'+[1,2,3,4,5,6].map(n=>'<option'+(n===s.target?' selected':'')+'>'+n+'</option>').join('')+'</select></label><label>安排方式<select name="mode"><option value="fixed"'+(s.mode==='fixed'?' selected':'')+'>固定间隔</option><option value="adaptive"'+(s.mode==='adaptive'?' selected':'')+'>根据表现调整</option></select></label><label>每日推荐<select name="daily">'+[1,2,3,4,5].map(n=>'<option value="'+n+'"'+(n===s.daily?' selected':'')+'>'+n+' 课</option>').join('')+'</select></label><div id="cp-intervals"></div><p>间隔从上一遍实际完成日算起。固定模式只记录感受；根据表现调整会结合正确率和感受缩短或延长间隔。盖满后结束。</p><p>修改会调整后续安排，已有章保留，已开始的本遍可继续。历史已练课程从计划启用日安排，不推算旧完成日期。</p><button class="pri" type="submit">保存设置</button><span id="cp-settings-status" role="status"></span></form></details>';}
function cpWireSettings(host){
  const form=host.querySelector('#cp-settings');if(!form)return;let s=CP.data.settings;
  const draw=()=>{const box=form.querySelector('#cp-intervals'),old=[...box.querySelectorAll('input')].map(x=>Number(x.value));box.innerHTML=Array.from({length:Number(form.elements.target.value)-1},(_,i)=>'<label>第 '+(i+2)+' 遍间隔<input name="interval-'+i+'" type="number" min="1" max="60" required value="'+(old[i]||s.intervals[i]||[3,7,14,21,30][i])+'"><span>天</span></label>').join('');};draw();form.elements.target.onchange=draw;
  form.onsubmit=async e=>{e.preventDefault();const status=form.querySelector('#cp-settings-status'),button=form.querySelector('[type=submit]');button.disabled=true;status.textContent='保存中…';try{const j=await cpRequest('/settings',{target:Number(form.elements.target.value),mode:form.elements.mode.value,daily:Number(form.elements.daily.value),intervals:[...form.querySelectorAll('#cp-intervals input')].map(x=>Number(x.value)),revision:s.revision});CP.data=j;s=j.settings;status.textContent='已保存，已有章保留。';gqRefreshList();await cpDashboard();const panel=$('cp-settings');if(panel)panel.closest('details').open=true;const saved=$('cp-settings-status');if(saved)saved.textContent='已保存，已有章保留。';}catch(e){if(e.code==='settings_conflict'){try{await cpLoad();s=CP.data.settings;status.textContent='另一端已修改计划，你的输入保留；再次保存会采用当前输入。';}catch{status.textContent='设置已被另一端修改，暂时无法读取新版本，请稍后重试。';}}else status.textContent=e.message;}finally{button.disabled=false;}};
}
function cpOverviewHTML(lid){const p=cpPlan(lid);if(!CP.data)return '<div class="cp-plan"><p role="status">'+esc(CP.error||'正在读取盖章计划…')+'</p><button id="cp-plan-retry">重试读取计划</button></div>';
  const a=p?.active,can=!p?.complete&&(a||(!p?.pendingHistorical&&(!p?.due||p.due<=Date.now())));
  return '<div class="cp-plan">'+cpStamps(p)+'<p>'+esc(cpCaption(p))+'</p><div class="cp-actions">'+(can?'<button class="pri" id="cp-plan-start">'+(a?'继续本遍':'开始第 '+((p?.stamps.length||0)+1)+' 遍')+' →</button>':'')+'<button id="cp-free">自主练习'+(can?'':' · 不计章')+'</button><button id="cp-plan-settings">复习计划设置</button></div><p class="cp-hint">每遍覆盖本课课堂题，错题在轮末纠正一次。扩展挑战选做。</p>'+(p?.stamps.length?'<div class="cp-history">'+p.stamps.map((s,i)=>'<span>第'+(i+1)+'章 · '+(s.historical?'历史已练 · 日期未知':cpDate(s.at)+' · 首次正确 '+s.right+'/'+s.total)+'</span>').join('')+'</div>':'')+'</div>';
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
