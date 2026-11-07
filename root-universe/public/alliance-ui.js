'use strict';
// The reviewed learning projection supplies membership; it does not add historical fact edges.
let selectedAllianceBranch=null,alliancePracticeBranch=null,alliancePracticeStage='read';
const relationLabels={close:'近支词',cognate:'远缘同源',classroom:'课堂关联',unresolved:'关系待核'};
const memberId=w=>w.query_id||w.sense_id;
function branchOfWord(data,id){return data.alliance.branches.find(b=>b.words.some(w=>memberId(w)===id));}
function reviewedMember(id){return learning.members.find(w=>memberId(w)===id);}
function allianceProfileHTML(data){
  const w=data.word,branch=branchOfWord(data,data.query_id),rooted=data.roots.length>0;
  return `<section class="root-answer" aria-label="核心词根"><div class="eyebrow">${rooted?'这个词的词源基础':'课堂关联与构词'}</div>${rooted?data.roots.map(r=>`<div class="root-heading"><h3>${esc(r.label)}</h3><span>${esc(r.meaning)}</span></div><p>${esc(r.origin)}</p>`).join(''):`<div class="root-heading"><h3>${esc(relationLabels[w.relation_kind])}</h3></div><p>保留课堂上的串联位置，不把相似拼写当作同根证明。</p>`}<p class="relation-caption">${esc(relationLabels[w.relation_kind])}${branch?' · '+esc(branch.title):''}</p><button class="link" id="root-panorama">围绕词根看整个联盟 →</button></section>
  <section class="section root-breakdown"><h3>拆开记，更好懂</h3>${w.parts?.length?`<div class="breakdown">${w.parts.map((p,i)=>`${i?'<span class="plus">+</span>':''}<div class="piece ${p.role==='root'?'root-piece':'base'}"><small>${esc(roleNames[p.role])}</small><strong>${esc(p.label)}</strong><span>${esc(p.meaning)}</span></div>`).join('')}</div>`:''}<p class="explanation">${esc(w.explanation)}</p><div class="modern-formula"><strong>现代构词</strong><span>${esc(w.modern_formula)}</span></div></section>
  <section class="section root-trace"><h3>词源与关联依据</h3><p class="trace-caption">${esc(relationLabels[w.relation_kind])} · 历史来源与记忆提示分开阅读</p><ol>${w.trace.map(s=>`<li class="${esc(s.kind)}"><strong>${esc(s.label)}</strong><span>${esc(s.meaning)}</span></li>`).join('')}</ol><p class="explanation">${esc(w.caveat||'')}</p><details class="root-evidence"><summary>查看来源与更早形式</summary>${learningSources(data,w.source_ids)}${data.roots.map(r=>`<p>${esc(r.forms_note)}</p><div class="earlier-origin">${(r.earlier||[]).map(e=>`<span><b>${esc(e.label)}</b> · ${esc(e.meaning)}</span>`).join(' → ')}</div><p>${esc(r.earlier_note)}</p>`).join('')}<details><summary>原文片段与许可</summary>${data.sources.filter(s=>w.source_ids.includes(s.id)).map(s=>`<article class="learning-source"><strong>${esc(s.entry)}</strong><blockquote>${esc(s.excerpt)}</blockquote><p>${learningSources(data,[s.id])} · ${esc(s.license)} · ${esc(s.attribution)}</p></article>`).join('')}</details></details></section>
  ${w.example?`<section class="section"><h3>放进一句话</h3><div class="meaning-example"><p>${esc(w.example.en)}</p><small>${esc(w.example.zh)}</small></div></section>`:''}${completeAllianceHTML(data)}`;
}
function completeAllianceHTML(data){
  const a=data.alliance,current=branchOfWord(data,data.query_id),stats=allianceEvidence(data.version);
  return `<section class="section alliance"><div class="alliance-heading"><div><h3>${esc(a.title)}</h3><p>${esc(a.coverage_note)}</p></div><button class="primary" data-learn-branch="${esc(current?.id||a.branches[0].id)}">学这一分支 →</button></div><p class="alliance-progress">逐词回忆：${stats.words} 个词留下记录 · ${a.words.length} 个可学习条目</p>
  ${a.branches.map(b=>`<details class="alliance-branch" ${b.id===current?.id?'open':''} data-branch="${esc(b.id)}"><summary><b>${esc(b.title)}</b><small>${esc(b.idea)}</small><span>${b.words.length} 词</span></summary><div class="branch-actions"><button class="link" data-learn-branch="${esc(b.id)}">按小组学习这支 →</button><button class="link" data-map-branch="${esc(b.id)}">看分支图 →</button></div><div class="alliance-words">${b.words.map(w=>`<button class="alliance-word clickable ${memberId(w)===data.query_id?'selected':''}" data-word="${esc(memberId(w))}"><b>${esc(w.word)}</b><span>${esc(w.clue)}</span><small>${esc(relationLabels[w.relation_kind])} · 第${w.lesson}课</small></button>`).join('')}</div></details>`).join('')}
  ${a.excluded.length?`<details class="alliance-branch"><summary><b>课堂对照与未决候选</b><span>${a.excluded.length} 词</span></summary><div class="alliance-excluded">${a.excluded.map(x=>`<div><b>${esc(x.word)}</b><span>${esc(x.reason)}</span></div>`).join('')}</div></details>`:''}</section>`;
}
function bindAllianceActions(root){
  root.querySelectorAll('[data-learn-branch]').forEach(b=>b.onclick=()=>{alliancePracticeBranch=b.dataset.learnBranch;alliancePracticeStage='read';practiceKey=null;setView('practice');});
  root.querySelectorAll('[data-map-branch]').forEach(b=>b.onclick=()=>{selectedAllianceBranch=b.dataset.mapBranch;rootGraphMode=true;graphFocus='branch:'+learning.alliance.id+':'+selectedAllianceBranch;setView('graph');graphFocus='branch:'+learning.alliance.id+':'+selectedAllianceBranch;renderGraph();});
}
function allianceGraphData(){
  const a=learning.alliance,branches=a.branches,pos={},edges=[];
  const multiRoot=learning.family_roots.length>1;
  for(const r of learning.family_roots)nodeById.set('learning:'+r.id,{id:'learning:'+r.id,type:'learning_root',label:r.label,zh:r.meaning});
  let rootId='learning:'+learning.family_roots[0].id;
  if(!multiRoot){pos[rootId]={x:50,y:65};}
  const chosen=branches.find(b=>b.id===selectedAllianceBranch);
  const visible=chosen?[chosen]:branches;
  const colX=i=>i%2?74:26;
  const rowY=i=>multiRoot?(chosen?170:75+Math.floor(i/2)*150):(chosen?220:220+Math.floor(i/2)*185);
  visible.forEach((b,i)=>{
    const id='branch:'+a.id+':'+b.id;
    nodeById.set(id,{id,type:'learning_branch',label:b.title,zh:b.words.length+'词 · '+b.idea,branch_id:b.id});
    pos[id]={x:chosen?50:colX(i),y:rowY(i)};
    if(!multiRoot)edges.push({from_id:id,to_id:rootId,layer:'learning',type:'alliance_branch',label:''});
  });
  let height=chosen?365:rowY(visible.length-1)+150;
  if(chosen){
    chosen.words.forEach((w,i)=>{const id=memberId(w),full=reviewedMember(id);nodeById.set(id,{...(nodeById.get(id)||{}),id,type:nodeById.get(id)?.type||'learning_word',label:w.word,zh:full.meaning});pos[id]={x:chosen.words.length===1?50:i%2?75:25,y:chosen?335+Math.floor(i/2)*160:385+Math.floor(i/2)*160};edges.push({from_id:id,to_id:'branch:'+a.id+':'+chosen.id,layer:'learning',type:'alliance_member',label:''});});
    height=475+Math.ceil(chosen.words.length/2)*160;
  }
  return {pos,edges,height,rootMode:true,allianceMode:true};
}
function allianceGraphDetail(){
  const a=learning.alliance,n=nodeById.get(graphFocus),branch=n?.branch_id?a.branches.find(b=>b.id===n.branch_id):null,w=reviewedMember(graphFocus);
  const detail=$('#graph-detail');
  if(branch){detail.innerHTML=`<div><span class="eyebrow">语义分支</span><h2>${esc(branch.title)}</h2><p class="translation">${branch.words.length} 个关联词</p></div><p class="detail-text">${esc(branch.idea)}</p><button class="primary" id="expand-branch">展开这一支</button><button class="link" data-learn-branch="${esc(branch.id)}">开始分支学习 →</button><button class="link" id="all-branches">返回整个联盟</button>`;$('#expand-branch').onclick=()=>{selectedAllianceBranch=branch.id;renderGraph();};}
  else if(w){detail.innerHTML=`<div><span class="eyebrow">${esc(relationLabels[w.relation_kind])}</span><h2>${esc(w.word)}</h2><div class="translation">${esc(w.meaning)}</div></div><p class="detail-text">${esc(w.explanation)}</p><p>${learningSources(learning,w.source_ids)}</p><button class="primary" id="graph-word">查看这个词</button><button class="link" id="all-branches">返回整个联盟</button>`;$('#graph-word').onclick=async()=>{lookupSense=memberId(w);await renderWord();setView('lookup');};}
  else if(n.type==='learning_root'){
    const r=learning.family_roots.find(x=>'learning:'+x.id===n.id);
    detail.innerHTML=`<div><span class="eyebrow">核心词根</span><h2>${esc(r.label)}</h2><p class="translation">${esc(r.meaning)}</p></div><p class="detail-text">${esc(r.origin)}</p><p class="detail-text">${esc(r.forms_note||'')}${r.earlier_note?' '+esc(r.earlier_note):''}</p>${learningSources(learning,r.source_ids)}<button class="primary" id="graph-word">返回查词</button><button class="link" id="all-branches">看全部分支</button>`;$('#graph-word').onclick=()=>setView('lookup');
  }
  else{detail.innerHTML=`<div><span class="eyebrow">联盟概览</span><h2>${esc(a.title)}</h2><p class="translation">${a.branches.length} 分支 · ${a.words.length} 词</p></div><p class="detail-text">点分支看小组。近支、远缘同源和课堂关联分别标明；这里的连线表示学习分组，不表示直接历史派生。</p>${learning.family_roots.length>1?`<p class="detail-text"><b>本课 ${learning.family_roots.length} 个根身份：</b><br>${learning.family_roots.map(r=>`${esc(r.label)}「${esc(r.meaning)}」`).join('<br>')}</p>`:''}<button class="primary" id="graph-word">返回查词</button><button class="link" id="all-branches">看全部分支</button>`;$('#graph-word').onclick=()=>setView('lookup');}
  const back=$('#all-branches');if(back)back.onclick=()=>{selectedAllianceBranch=null;graphFocus='learning:'+learning.family_roots[0].id;renderGraph();};
  bindAllianceActions(detail);
}
function allianceQuestions(){
  const a=learning.alliance,b=a.branches.find(b=>b.id===alliancePracticeBranch)||branchOfWord(learning,lookupSense)||a.branches[0];alliancePracticeBranch=b.id;
  return b.words.flatMap(item=>{
    const w=reviewedMember(memberId(item)),other=[...new Map(learning.members.filter(x=>x.word!==w.word&&x.meaning!==w.meaning&&x.meaning).map(x=>[x.meaning,x])).values()];
    // Context and answer are independently reviewed; alternatives are not generated from spelling similarity.
    const items=[{id:w.id+':meaning',word_id:memberId(w),kind:'辨认词义',q:`${w.word} 在本课中的意思是？`,hint:'先回想分支的意思，再判断这个词。',choices:[w.meaning,...other.slice(0,2).map(x=>x.meaning)],answer:w.meaning,why:w.explanation}];
    if(w.recall)items.push({id:w.id+':recall',word_id:memberId(w),kind:'主动回忆',q:w.recall.prompt,hint:'输入完整英文单词。',input:true,answer:w.recall.answer,why:w.recall.explanation});
    return items;
  });
}
function evidenceEvents(){
  const events=[];
  try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k.startsWith('root-universe:event:')){const e=JSON.parse(localStorage.getItem(k));if(e&&e.word_id&&typeof e.correct==='boolean')events.push(e);}}}catch{}
  return events;
}
function allianceEvidence(version){const events=evidenceEvents().filter(e=>e.version===version&&e.kind==='主动回忆');return {words:new Set(events.map(e=>e.word_id)).size,events};}
function saveAllianceSession(){
  try{localStorage.setItem('root-universe:session',JSON.stringify({key:practiceKey,branch:alliancePracticeBranch,index:qIndex,answers,stage:alliancePracticeStage,version:learning.version}));return true;}
  catch{toast('学习位置未能保存，请保持此页打开后重试。');return false;}
}
function recordAllianceAnswer(value){
  const q=questions[qIndex];if(answers[qIndex]!==undefined)return;
  const correct=q.input?value.trim().toLowerCase()===q.answer.toLowerCase():value===q.answer;
  const event={id:crypto.randomUUID(),word_id:q.word_id,question_id:q.id,version:learning.version,kind:q.kind,answer:value,correct,at:Date.now()};
  try{localStorage.setItem('root-universe:event:'+event.id,JSON.stringify(event));}
  catch{toast('这次回答未保存，请重试。');return;}
  answers[qIndex]=value;saveAllianceSession();renderPractice();
}
function renderAlliancePractice(){
  const a=learning.alliance,b=a.branches.find(b=>b.id===alliancePracticeBranch)||branchOfWord(learning,lookupSense)||a.branches[0];
  alliancePracticeBranch=b.id;const card=$('#practice-card');$('#practice-family-tag').textContent=a.title;
  $('#practice-aside').innerHTML=`<h3>选择语义分支</h3>${a.branches.map(branch=>`<button class="branch-pick ${branch.id===b.id?'active':''}" data-pick-branch="${esc(branch.id)}"><b>${esc(branch.title)}</b><small>${branch.words.length} 词</small></button>`).join('')}<p class="practice-storage-note">学习记录保存在此浏览器，可刷新接续。</p>`;
  $('#practice-aside').querySelectorAll('[data-pick-branch]').forEach(btn=>btn.onclick=()=>{alliancePracticeBranch=btn.dataset.pickBranch;alliancePracticeStage='read';startPractice(familyOf(lookupSense));});
  if(alliancePracticeStage!=='read'&&questions.length===0)questions=allianceQuestions();
  if(alliancePracticeStage==='read'){
    card.innerHTML=`<div class="practice-meta"><span>${esc(a.title)}</span><span>${b.words.length}词</span></div><h2 class="question">${esc(b.title)}</h2><p class="question-hint">${esc(b.idea)}</p><div class="lesson-words">${b.words.map(item=>{const w=reviewedMember(memberId(item));return `<article><div><b>${esc(w.word)}</b><span>${esc(w.meaning)}</span></div><p>${esc(w.clue&&w.clue!==w.meaning?w.clue:(w.explanation&&w.explanation!==w.meaning?w.explanation:'本课记忆条目：释义见上。'))}</p>${w.example?`<p class="lesson-example">${esc(w.example.en)}</p><small>${esc(w.example.zh)}</small>`:''}<button class="link" data-open-word="${esc(memberId(w))}">回看词条 →</button></article>`;}).join('')}</div><div class="practice-actions"><span class="question-hint">看懂后，遮住解释试着回忆。</span><button class="primary" id="begin-branch">开始逐词回忆 →</button></div>`;
    card.querySelectorAll('[data-open-word]').forEach(btn=>btn.onclick=async()=>{lookupSense=btn.dataset.openWord;await renderWord();setView('lookup');});
    $('#begin-branch').onclick=()=>{alliancePracticeStage='quiz';qIndex=0;answers=[];questions=allianceQuestions();saveAllianceSession();renderPractice();};return;
  }
  if(qIndex>=questions.length){
    const events=allianceEvidence(learning.version).events,good=answers.filter((v,i)=>questions[i].input?v?.trim().toLowerCase()===questions[i].answer.toLowerCase():v===questions[i].answer).length;
    const next=a.branches[a.branches.indexOf(b)+1];
    card.innerHTML=`<div class="finish"><div class="roundcheck">✓</div><h2>这一分支已练完</h2><p>${b.words.length}词 · 本轮${questions.length}题 · 首次答对${good}题</p><p>每个词的回答分别保存；这不代表整个联盟已经掌握。</p><div class="finish-actions">${next?`<button class="primary" id="next-branch">下一支：${esc(next.title)}</button>`:''}<button class="secondary" id="restart">再回忆一遍</button><button class="link" id="finish-family">回看联盟</button></div></div>`;
    if(next)$('#next-branch').onclick=()=>{alliancePracticeBranch=next.id;alliancePracticeStage='read';startPractice(familyOf(lookupSense));};
    $('#restart').onclick=()=>{alliancePracticeStage='quiz';startPractice(familyOf(lookupSense));};$('#finish-family').onclick=()=>{selectedAllianceBranch=b.id;graphFocus='branch:'+a.id+':'+b.id;setView('graph');};return;
  }
  const q=questions[qIndex],selected=answers[qIndex],judged=selected!==undefined,correct=judged&&(q.input?selected.trim().toLowerCase()===q.answer.toLowerCase():selected===q.answer);
  card.innerHTML=`<div class="practice-meta"><span>${esc(b.title)}</span><span>${qIndex+1} / ${questions.length}</span></div><div class="progress"><i class="progress-fill"></i></div><div class="q-type">${esc(q.kind)}</div><h2 class="question">${esc(q.q)}</h2><p class="question-hint">${esc(q.hint)}</p>${q.input?`<form id="recall-form"><label class="recall-label" for="recall-answer">你的答案</label><input id="recall-answer" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(selected||'')}" ${judged?'disabled':''}><button class="secondary" ${judged?'disabled':''}>检查答案</button></form>`:`<div class="answers">${q.choices.map((v,i)=>`<button class="answer ${judged&&v===q.answer?'correct':''} ${judged&&v===selected&&!correct?'wrong':''}" data-answer="${esc(v)}" ${judged?'disabled':''}><span class="letter">${'ABC'[i]}</span><span>${esc(v)}</span></button>`).join('')}</div>`}${judged?`<div class="feedback ${correct?'':'wrong'}"><h3>${correct?'答对了':'正确答案：'+esc(q.answer)}</h3><p>${esc(q.why)}</p></div>`:''}<div class="practice-actions"><button class="link" id="read-again">回看本支讲解</button><button class="primary" id="next-q" ${judged?'':'disabled'}>${qIndex===questions.length-1?'完成本支':'下一题 →'}</button></div>`;
  card.querySelector('.progress-fill').style.width=(qIndex+(judged?1:0))/questions.length*100+'%';
  card.querySelectorAll('[data-answer]').forEach(btn=>btn.onclick=()=>recordAllianceAnswer(btn.dataset.answer));
  const form=$('#recall-form');if(form)form.onsubmit=e=>{e.preventDefault();const v=$('#recall-answer').value.trim();if(v)recordAllianceAnswer(v);};
  $('#next-q').onclick=()=>{qIndex++;saveAllianceSession();renderPractice();};$('#read-again').onclick=()=>{alliancePracticeStage='read';saveAllianceSession();renderPractice();};
}
