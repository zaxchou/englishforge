'use strict';
// The reviewed learning projection supplies membership; it does not add historical fact edges.
let selectedAllianceBranch=null,selectedAllianceRoot=null,alliancePracticeBranch=null,alliancePracticeStage='read',alliancePendingEvents=[];
const relationLabels={close:'近支词',cognate:'远缘同源',classroom:'课堂关联',unresolved:'关系待核'};
const memberId=w=>w.query_id||w.sense_id;
const alliancePracticeContext=branch=>JSON.stringify(['alliance-v1',lookupSense,learning.alliance.id,learning.version,branch]);
function practiceBranch(id){return learning.alliance.branches.find(b=>b.id===id)||branchOfWord(learning,lookupSense)||learning.alliance.branches[0];}
function allianceQuestionSet(){return JSON.stringify(questions.map(q=>[q.id,q.answer,q.choices||null]));}
function initializeAlliancePractice(branch,stage='read',saved=null){
  alliancePracticeBranch=practiceBranch(branch).id;alliancePracticeStage=stage;
  practiceKey=alliancePracticeContext(alliancePracticeBranch);
  questions=allianceQuestions();qIndex=0;answers=[];
  // Rebuild from the reviewed projection, then accept only the matching question set and valid position.
  if(saved&&saved.key===practiceKey&&saved.questionSet===allianceQuestionSet()&&
    ['read','quiz'].includes(saved.stage)&&Number.isInteger(saved.index)&&saved.index>=0&&saved.index<=questions.length&&
    Array.isArray(saved.answers)&&saved.answers.length>=saved.index&&saved.answers.length<=Math.min(saved.index+1,questions.length)&&
    saved.answers.every((v,i)=>typeof v==='string'&&(questions[i].input?v.trim().length>0:questions[i].choices.includes(v)))){
    alliancePracticeStage=saved.stage;qIndex=saved.index;answers=saved.answers;
  }
}
function ensureAlliancePractice(){
  if(practiceKey===alliancePracticeContext(alliancePracticeBranch))return;
  let saved=null;
  try{saved=JSON.parse(localStorage.getItem('root-universe:session')||'null');}catch{}
  const pending=new Map(alliancePendingEvents.map(e=>[e.id,e]));
  for(const e of Array.isArray(saved?.pendingEvents)?saved.pendingEvents:[])if(e&&typeof e.id==='string'&&e.word_id&&typeof e.correct==='boolean')pending.set(e.id,e);
  alliancePendingEvents=[...pending.values()];
  const matches=saved&&saved.query===lookupSense&&saved.alliance===learning.alliance.id&&saved.version===learning.version&&
    learning.alliance.branches.some(b=>b.id===saved.branch)&&saved.key===alliancePracticeContext(saved.branch);
  initializeAlliancePractice(matches?saved.branch:null,'read',matches?saved:null);
  if(saveAllianceSession())flushAllianceEvents();
}
function persistAllianceProgress(change){
  const before={branch:alliancePracticeBranch,stage:alliancePracticeStage,key:practiceKey,questions,index:qIndex,answers:[...answers],events:[...alliancePendingEvents]};
  change();
  if(saveAllianceSession())return true;
  alliancePracticeBranch=before.branch;alliancePracticeStage=before.stage;practiceKey=before.key;questions=before.questions;qIndex=before.index;answers=before.answers;alliancePendingEvents=before.events;
  return false;
}
function startAlliancePractice(branch,stage='read'){
  if(learningLookup!==lookupSense)return;
  if(persistAllianceProgress(()=>initializeAlliancePractice(branch,stage))){flushAllianceEvents();renderAlliancePractice();}
}
function shuffleAllianceChoices(choices,seed){
  let state=2166136261;
  for(const c of seed)state=Math.imul(state^c.charCodeAt(0),16777619)>>>0;
  const shuffled=[...new Set(choices)];
  for(let i=shuffled.length-1;i>0;i--){
    state=(state+0x6D2B79F5)>>>0;
    let n=Math.imul(state^(state>>>15),state|1);n^=n+Math.imul(n^(n>>>7),n|61);
    const j=Math.floor(((n^(n>>>14))>>>0)/4294967296*(i+1));
    [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];
  }
  return shuffled;
}
function branchOfWord(data,id){return data.alliance.branches.find(b=>b.words.some(w=>memberId(w)===id));}
function reviewedMember(id){return learning.members.find(w=>memberId(w)===id);}
function allianceBreakdownHTML(data,branch){
  const w=data.word,parts=w.parts||[];
  const placeholder=parts.length===1&&parts[0].role==='base'&&parts[0].label.toLowerCase()===w.word.toLowerCase();
  if(!parts.length||placeholder){
    const clue=branch?.words.find(item=>memberId(item)===data.query_id)?.clue;
    return `<section class="section root-breakdown"><h3>课堂记忆线索</h3><p class="explanation">${esc(clue||'本词按当前课堂分支串联，构词资料仍在整理。')}</p><p class="breakdown-note">逐词构词分析待补充；这里保留课堂线索。</p></section>`;
  }
  return `<section class="section root-breakdown"><h3>拆开记，更好懂</h3><div class="breakdown" data-parts="${parts.length}">${parts.map((p,i)=>`${i?'<span class="plus">+</span>':''}<div class="piece ${p.role==='root'?'root-piece':'base'}"><small>${esc(roleNames[p.role])}</small><strong>${esc(p.label)}</strong><span>${esc(p.meaning)}</span></div>`).join('')}</div>${w.explanation&&w.explanation!==w.meaning?`<p class="explanation">${esc(w.explanation)}</p>`:''}${w.modern_formula?`<div class="modern-formula"><strong>现代构词与记忆</strong><span>${esc(w.modern_formula)}</span></div>`:''}</section>`;
}
function allianceProfileHTML(data){
  const w=data.word,branch=branchOfWord(data,data.query_id),rooted=data.roots.length>0;
  return `<section class="root-answer" aria-label="核心词根"><div class="eyebrow">${rooted?'这个词的词源基础':'课堂关联与构词'}</div>${rooted?data.roots.map(r=>`<div class="root-heading"><h3>${esc(r.label)}</h3><span>${esc(r.meaning)}</span></div><p>${esc(r.origin)}</p>`).join(''):`<div class="root-heading"><h3>${esc(relationLabels[w.relation_kind])}</h3></div><p>保留课堂上的串联位置，不把相似拼写当作同根证明。</p>`}<p class="relation-caption">${esc(relationLabels[w.relation_kind])}${branch?' · '+esc(branch.title):''}</p><button class="link" id="root-panorama">围绕词根看整个联盟 →</button></section>
  ${allianceBreakdownHTML(data,branch)}
  <section class="section root-trace"><h3>词源与关联依据</h3><p class="trace-caption">${esc(relationLabels[w.relation_kind])} · 历史来源与记忆提示分开阅读</p>${w.trace.some(s=>s.kind!=='word')?`<ol>${w.trace.map(s=>`<li class="${esc(s.kind)}"><strong>${esc(s.label)}</strong><span>${esc(s.meaning)}</span></li>`).join('')}</ol>`:''}${w.caveat?`<p class="explanation">${esc(w.caveat)}</p>`:''}<details class="root-evidence"><summary>查看来源与更早形式</summary>${learningSources(data,w.source_ids)}${data.roots.map(r=>`<p>${esc(r.forms_note)}</p><div class="earlier-origin">${(r.earlier||[]).map(e=>`<span><b>${esc(e.label)}</b> · ${esc(e.meaning)}</span>`).join(' → ')}</div><p>${esc(r.earlier_note)}</p>`).join('')}<details><summary>原文片段与许可</summary>${data.sources.filter(s=>w.source_ids.includes(s.id)).map(s=>`<article class="learning-source"><strong>${esc(s.entry)}</strong><blockquote>${esc(s.excerpt)}</blockquote><p>${learningSources(data,[s.id])} · ${esc(s.license)} · ${esc(s.attribution)}</p></article>`).join('')}</details></details></section>
  ${w.example?`<section class="section"><h3>放进一句话</h3><div class="meaning-example"><p>${esc(w.example.en)}</p><small>${esc(w.example.zh)}</small></div></section>`:''}${completeAllianceHTML(data)}`;
}
function completeAllianceHTML(data){
  const a=data.alliance,current=branchOfWord(data,data.query_id),stats=allianceEvidence(data.version);
  return `<section class="section alliance"><div class="alliance-heading"><div><h3>${esc(a.title)}</h3><p>${esc(a.coverage_note)}</p></div><button class="primary" data-learn-branch="${esc(current?.id||a.branches[0].id)}">学这一分支 →</button></div><p class="alliance-progress">逐词回忆：${stats.words} 个词留下记录 · ${a.words.length} 个可学习条目</p>
  ${a.branches.map(b=>`<details class="alliance-branch" ${b.id===current?.id?'open':''} data-branch="${esc(b.id)}"><summary><b>${esc(b.title)}</b><small>${esc(b.idea)}</small><span>${b.words.length} 词</span></summary><div class="branch-actions"><button class="link" data-learn-branch="${esc(b.id)}">按小组学习这支 →</button><button class="link" data-map-branch="${esc(b.id)}">看分支图 →</button></div><div class="alliance-words">${b.words.map(w=>`<button class="alliance-word clickable ${memberId(w)===data.query_id?'selected':''}" data-word="${esc(memberId(w))}"><b>${esc(w.word)}</b><span>${esc(w.clue)}</span><small>${esc(relationLabels[w.relation_kind])} · 第${w.lesson}课</small></button>`).join('')}</div></details>`).join('')}
  ${a.excluded.length?`<details class="alliance-branch"><summary><b>课堂对照与未决候选</b><span>${a.excluded.length} 词</span></summary><div class="alliance-excluded">${a.excluded.map(x=>`<div><b>${esc(x.word)}</b><span>${esc(x.reason)}</span></div>`).join('')}</div></details>`:''}</section>`;
}
function openAllianceBranch(id){
  const branch=learning.alliance.branches.find(b=>b.id===id);if(!branch)return;
  const roots=new Set(branch.words.flatMap(item=>{const ids=reviewedMember(memberId(item)).root_ids;return ids?.length?ids:['@classroom'];}));
  selectedAllianceBranch=id;selectedAllianceRoot=roots.size===1?[...roots][0]:'@all';
  rootGraphMode=true;graphFocus='branch:'+learning.alliance.id+':'+id;showGraphView();
  const focus=Object.keys(activeGraphData.pos).find(key=>nodeById.get(key).branch_id===id);
  if(focus&&graphFocus!==focus){graphFocus=focus;renderGraph();}
}
function bindAllianceActions(root){
  root.querySelectorAll('[data-learn-branch]').forEach(b=>b.onclick=()=>{startAlliancePractice(b.dataset.learnBranch);setView('practice');});
  root.querySelectorAll('[data-map-branch]').forEach(b=>b.onclick=()=>openAllianceBranch(b.dataset.mapBranch));
}
function allianceGraphData(){
  const a=learning.alliance,pos={},edges=[],rows=[];
  const members=learning.members,roots=learning.family_roots.filter(r=>members.some(w=>w.root_ids?.includes(r.id)));
  const groups=roots.map(r=>({key:r.id,id:'learning:'+r.id,label:r.label,meaning:r.meaning}));
  if(members.some(w=>!w.root_ids?.length))groups.push({key:'@classroom',id:'learning-group:'+a.id,label:'课堂对照',meaning:'保留课堂串联，不视为同根'});
  if(!groups.some(g=>g.key===selectedAllianceRoot)&&selectedAllianceRoot!=='@all')selectedAllianceRoot=groups.find(g=>learning.word.root_ids?.includes(g.key))?.key||groups[0]?.key;
  let picker=$('#alliance-root-picker');
  if(!picker){picker=document.createElement('div');picker.id='alliance-root-picker';picker.className='graph-root-picker';$('#graph-modes').after(picker);}
  picker.hidden=groups.length<2;
  picker.innerHTML='<label for="alliance-root-select">图内分组</label><select id="alliance-root-select">'+groups.map(g=>`<option value="${esc(g.key)}">${esc(g.label)} · ${members.filter(w=>g.key==='@classroom'?!w.root_ids?.length:w.root_ids?.includes(g.key)).length}词</option>`).join('')+'<option value="@all">全部词根 · 分开展示</option></select>';
  const select=$('#alliance-root-select');select.value=selectedAllianceRoot;
  select.onchange=()=>{selectedAllianceRoot=select.value;selectedAllianceBranch=null;graphFocus=groups.find(g=>g.key===selectedAllianceRoot)?.id||'alliance-overview:'+a.id;renderGraph();};
  const matchesGroup=(word,g)=>g.key==='@classroom'?!word.root_ids?.length:word.root_ids?.includes(g.key);
  const chosenBranch=a.branches.find(b=>b.id===selectedAllianceBranch);
  const visibleGroups=(selectedAllianceRoot==='@all'?groups:groups.filter(g=>g.key===selectedAllianceRoot))
    .filter(g=>!chosenBranch||chosenBranch.words.some(item=>matchesGroup(reviewedMember(memberId(item)),g)));
  const columns=$('#family-map').clientWidth<520?1:2;
  const addRows=ids=>{for(let i=0;i<ids.length;i+=columns)rows.push(ids.slice(i,i+columns));};
  for(const g of visibleGroups){
    nodeById.set(g.id,{id:g.id,type:g.key==='@classroom'?'learning_group':'learning_root',label:g.label,zh:g.meaning,root_id:g.key});
    pos[g.id]={x:50,y:0};rows.push([g.id]);
    const branches=a.branches.filter(b=>!selectedAllianceBranch||b.id===selectedAllianceBranch),branchIds=[];
    for(const b of branches){
      const words=b.words.filter(item=>{const w=reviewedMember(memberId(item));return g.key==='@classroom'?!w.root_ids?.length:w.root_ids?.includes(g.key);});
      if(!words.length)continue;
      const id='branch:'+a.id+':'+b.id+(selectedAllianceRoot==='@all'?':'+g.key:'');
      nodeById.set(id,{id,type:'learning_branch',label:b.title,zh:words.length+'词 · '+b.idea,branch_id:b.id,root_id:g.key,member_ids:words.map(memberId)});
      pos[id]={x:50,y:0};branchIds.push(id);
      edges.push({from_id:id,to_id:g.id,layer:g.key==='@classroom'?'learning_classroom':'learning',type:'alliance_branch',label:''});
      if(selectedAllianceBranch){
        addRows([id]);const ids=[];
        for(const item of words){const wordId=memberId(item),w=reviewedMember(wordId);nodeById.set(wordId,{...(nodeById.get(wordId)||{}),id:wordId,type:nodeById.get(wordId)?.type||'learning_word',label:w.word,zh:w.meaning});pos[wordId]={x:50,y:0};ids.push(wordId);edges.push({from_id:wordId,to_id:id,layer:w.relation_kind==='classroom'?'learning_classroom':'learning',type:'alliance_member',label:''});}
        addRows(ids);
      }
    }
    if(!selectedAllianceBranch)addRows(branchIds);
  }
  return {pos,edges,rows,columns,rootMode:true,allianceMode:true};
}
function layoutAllianceRows(data){
  const host=$('#family-map');let y=20;
  for(const row of data.rows){
    const nodes=row.map(id=>host.querySelector(`[data-node="${CSS.escape(id)}"]`));
    const height=Math.max(...nodes.map(n=>n.getBoundingClientRect().height));
    nodes.forEach((n,i)=>{n.style.left=(nodes.length===1?50:i===0?26:74)+'%';n.style.top=(y+height/2)+'px';});
    y+=height+48;
  }
  host.style.height=y+'px';data.height=y;
}
function allianceGraphDetail(){
  const a=learning.alliance,n=nodeById.get(graphFocus),branch=n?.branch_id?a.branches.find(b=>b.id===n.branch_id):null,w=reviewedMember(graphFocus);
  const detail=$('#graph-detail');
  if(branch){detail.innerHTML=`<div><span class="eyebrow">语义分支</span><h2>${esc(branch.title)}</h2><p class="translation">${n.member_ids.length} 个关联词</p></div><p class="detail-text">${esc(branch.idea)}</p><button class="primary" id="expand-branch">展开这一支</button><button class="link" data-learn-branch="${esc(branch.id)}">开始分支学习 →</button><button class="link" id="all-branches">返回整个联盟</button>`;$('#expand-branch').onclick=()=>{selectedAllianceRoot=n.root_id;selectedAllianceBranch=branch.id;graphFocus='branch:'+a.id+':'+branch.id;renderGraph();};}
  else if(w){detail.innerHTML=`<div><span class="eyebrow">${esc(relationLabels[w.relation_kind])}</span><h2>${esc(w.word)}</h2><div class="translation">${esc(w.meaning)}</div></div><p class="detail-text">${esc(w.explanation)}</p><p>${learningSources(learning,w.source_ids)}</p><button class="primary" id="graph-word">查看这个词</button><button class="link" id="all-branches">返回整个联盟</button>`;$('#graph-word').onclick=async()=>{lookupSense=memberId(w);await renderWord();setView('lookup');};}
  else if(n?.type==='learning_group'){
    detail.innerHTML='<div><span class="eyebrow">课堂串联</span><h2>课堂对照</h2><p class="detail-text">这些词保留课堂并列位置。相似拼写与教学联想不是同源证据；请逐词查看各自来源。</p></div><button class="link" id="all-branches">看全部分支</button>';
  }
  else if(n?.type==='learning_root'){
    const r=learning.family_roots.find(x=>'learning:'+x.id===n.id);
    detail.innerHTML=`<div><span class="eyebrow">核心词根</span><h2>${esc(r.label)}</h2><p class="translation">${esc(r.meaning)}</p></div><p class="detail-text">${esc(r.origin)}</p><p class="detail-text">${esc(r.forms_note||'')}${r.earlier_note?' '+esc(r.earlier_note):''}</p>${learningSources(learning,r.source_ids)}<button class="primary" id="graph-word">返回查词</button><button class="link" id="all-branches">看全部分支</button>`;$('#graph-word').onclick=()=>setView('lookup');
  }
  else{detail.innerHTML=`<div><span class="eyebrow">联盟概览</span><h2>${esc(a.title)}</h2><p class="translation">${a.branches.length} 分支 · ${a.words.length} 词</p></div><p class="detail-text">点分支看小组。近支、远缘同源和课堂关联分别标明；这里的连线表示学习分组，不表示直接历史派生。</p>${learning.family_roots.length>1?`<p class="detail-text"><b>本课 ${learning.family_roots.length} 个根身份：</b><br>${learning.family_roots.map(r=>`${esc(r.label)}「${esc(r.meaning)}」`).join('<br>')}</p>`:''}<button class="primary" id="graph-word">返回查词</button><button class="link" id="all-branches">看全部分支</button>`;$('#graph-word').onclick=()=>setView('lookup');}
  const back=$('#all-branches');if(back)back.onclick=()=>{selectedAllianceBranch=null;graphFocus=selectedAllianceRoot==='@all'?'alliance-overview:'+a.id:selectedAllianceRoot==='@classroom'?'learning-group:'+a.id:'learning:'+selectedAllianceRoot;renderGraph();};
  bindAllianceActions(detail);
}
function meaningTerms(text){
  return [...new Set(String(text||'').normalize('NFKC').toLowerCase().replace(/\b(?:adj|adv|vt|vi|prep|pron|conj|interj|num|aux|ad|n|v|a)\.\s*/g,'').split(/[;；,，、/]/).map(s=>s.replace(/[\s.。()（）“”‘’]/g,'')).filter(Boolean))].sort();
}
function meaningAlternatives(word){
  const used=new Set(meaningTerms(word.meaning)),out=[];
  for(const candidate of learning.members){
    if(candidate.word===word.word)continue;
    const terms=meaningTerms(candidate.meaning);
    if(!terms.length||terms.some(t=>used.has(t)))continue;
    out.push(candidate);terms.forEach(t=>used.add(t));if(out.length===2)break;
  }
  return out;
}
function allianceQuestions(){
  const a=learning.alliance,b=a.branches.find(b=>b.id===alliancePracticeBranch)||branchOfWord(learning,lookupSense)||a.branches[0];alliancePracticeBranch=b.id;
  return b.words.flatMap(item=>{
    const w=reviewedMember(memberId(item)),other=meaningAlternatives(w);
    // Ignore part-of-speech prefixes and reordered synonyms when selecting alternatives.
    const items=[];
    if(other.length===2)items.push({id:w.id+':meaning',word_id:memberId(w),kind:'辨认词义',q:`${w.word} 在本课中的意思是？`,hint:'先回想分支的意思，再判断这个词。',choices:[w.meaning,...other.map(x=>x.meaning)],answer:w.meaning,why:w.explanation});
    if(w.recall)items.push({id:w.id+':recall',word_id:memberId(w),kind:'主动回忆',q:w.recall.prompt,hint:'输入完整英文单词。',input:true,answer:w.recall.answer,why:w.recall.explanation});
    for(const q of items)if(q.choices)q.choices=shuffleAllianceChoices(q.choices,alliancePracticeContext(b.id)+q.id);
    return items;
  });
}
function evidenceEvents(){
  const events=[];
  try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k.startsWith('root-universe:event:')){const e=JSON.parse(localStorage.getItem(k));if(e&&e.word_id&&typeof e.correct==='boolean')events.push(e);}}}catch{}
  const ids=new Set(events.map(e=>e.id));
  for(const e of alliancePendingEvents)if(!ids.has(e.id)){events.push(e);ids.add(e.id);}
  return events;
}
function flushAllianceEvents(){
  if(!alliancePendingEvents.length)return;
  try{
    for(const e of alliancePendingEvents)localStorage.setItem('root-universe:event:'+e.id,JSON.stringify(e));
    const pending=alliancePendingEvents;alliancePendingEvents=[];
    if(!saveAllianceSession())alliancePendingEvents=pending;
  }catch{toast('回答和位置已保存，学习统计将在存储恢复后补齐。');}
}
function allianceEvidence(version){const events=evidenceEvents().filter(e=>e.version===version&&e.kind==='主动回忆');return {words:new Set(events.map(e=>e.word_id)).size,events};}
function saveAllianceSession(){
  if(learningLookup!==lookupSense||practiceKey!==alliancePracticeContext(alliancePracticeBranch))return false;
  try{
    let saved=null;try{saved=JSON.parse(localStorage.getItem('root-universe:session')||'null');}catch{}
    const pending=new Map(alliancePendingEvents.map(e=>[e.id,e]));
    for(const e of Array.isArray(saved?.pendingEvents)?saved.pendingEvents:[])if(e&&typeof e.id==='string'&&e.word_id&&typeof e.correct==='boolean'&&!pending.has(e.id))pending.set(e.id,e);
    const events=[...pending.values()].filter(e=>!localStorage.getItem('root-universe:event:'+e.id));
    localStorage.setItem('root-universe:session',JSON.stringify({key:practiceKey,query:lookupSense,alliance:learning.alliance.id,branch:alliancePracticeBranch,index:qIndex,answers,stage:alliancePracticeStage,version:learning.version,questionSet:allianceQuestionSet(),pendingEvents:events}));
    alliancePendingEvents=events;return true;
  }catch{toast('学习位置未能保存，请保持此页打开后重试。');return false;}
}
function recordAllianceAnswer(value){
  if(learningLookup!==lookupSense||practiceKey!==alliancePracticeContext(alliancePracticeBranch)||alliancePracticeStage!=='quiz')return;
  const q=questions[qIndex];if(!q||answers[qIndex]!==undefined||typeof value!=='string'||(!q.input&&!q.choices.includes(value)))return;
  const correct=q.input?value.trim().toLowerCase()===q.answer.toLowerCase():value===q.answer;
  const event={id:crypto.randomUUID(),word_id:q.word_id,question_id:q.id,query_id:lookupSense,alliance_id:learning.alliance.id,branch_id:alliancePracticeBranch,context:practiceKey,version:learning.version,kind:q.kind,answer:value,correct,at:Date.now()};
  if(!persistAllianceProgress(()=>{answers[qIndex]=value;alliancePendingEvents.push(event);}))return;
  flushAllianceEvents();renderPractice();
}
function renderAlliancePractice(){
  if(learningLookup!==lookupSense)return renderPractice();
  ensureAlliancePractice();
  const a=learning.alliance,b=practiceBranch(alliancePracticeBranch);
  alliancePracticeBranch=b.id;const card=$('#practice-card');$('#practice-family-tag').textContent=a.title;
  $('#practice-aside').innerHTML=`<h3>选择语义分支</h3>${a.branches.map(branch=>`<button class="branch-pick ${branch.id===b.id?'active':''}" data-pick-branch="${esc(branch.id)}"><b>${esc(branch.title)}</b><small>${branch.words.length} 词</small></button>`).join('')}<p class="practice-storage-note">学习记录保存在此浏览器，可刷新接续。</p>`;
  $('#practice-aside').querySelectorAll('[data-pick-branch]').forEach(btn=>btn.onclick=()=>startAlliancePractice(btn.dataset.pickBranch));
  if(alliancePracticeStage==='read'){
    card.innerHTML=`<div class="practice-meta"><span>${esc(a.title)}</span><span>${b.words.length}词</span></div><h2 class="question">${esc(b.title)}</h2><p class="question-hint">${esc(b.idea)}</p><div class="lesson-words">${b.words.map(item=>{const w=reviewedMember(memberId(item));return `<article><div><b>${esc(w.word)}</b><span>${esc(w.meaning)}</span></div><p>${esc(w.clue&&w.clue!==w.meaning?w.clue:(w.explanation&&w.explanation!==w.meaning?w.explanation:'本课记忆条目：释义见上。'))}</p>${w.example?`<p class="lesson-example">${esc(w.example.en)}</p><small>${esc(w.example.zh)}</small>`:''}<button class="link" data-open-word="${esc(memberId(w))}">回看词条 →</button></article>`;}).join('')}</div><div class="practice-actions"><span class="question-hint">看懂后，遮住解释试着回忆。</span><button class="primary" id="begin-branch">${qIndex>=questions.length?'回看本轮结果 →':qIndex||answers.length?'继续逐词回忆 →':'开始逐词回忆 →'}</button></div>`;
    card.querySelectorAll('[data-open-word]').forEach(btn=>btn.onclick=async()=>{lookupSense=btn.dataset.openWord;await renderWord();setView('lookup');});
    $('#begin-branch').onclick=()=>{if(persistAllianceProgress(()=>{alliancePracticeStage='quiz';}))renderAlliancePractice();};return;
  }
  if(qIndex>=questions.length){
    const events=allianceEvidence(learning.version).events,good=answers.filter((v,i)=>questions[i].input?v?.trim().toLowerCase()===questions[i].answer.toLowerCase():v===questions[i].answer).length;
    const next=a.branches[a.branches.indexOf(b)+1];
    card.innerHTML=`<div class="finish"><div class="roundcheck">✓</div><h2>这一分支已练完</h2><p>${b.words.length}词 · 本轮${questions.length}题 · 首次答对${good}题</p><p>每个词的回答分别保存；这不代表整个联盟已经掌握。</p><div class="finish-actions">${next?`<button class="primary" id="next-branch">下一支：${esc(next.title)}</button>`:''}<button class="secondary" id="restart">再回忆一遍</button><button class="link" id="finish-family">回看联盟</button></div></div>`;
    if(next)$('#next-branch').onclick=()=>startAlliancePractice(next.id);
    $('#restart').onclick=()=>startAlliancePractice(b.id,'quiz');$('#finish-family').onclick=()=>openAllianceBranch(b.id);return;
  }
  const q=questions[qIndex],selected=answers[qIndex],judged=selected!==undefined,correct=judged&&(q.input?selected.trim().toLowerCase()===q.answer.toLowerCase():selected===q.answer);
  card.innerHTML=`<div class="practice-meta"><span>${esc(b.title)}</span><span>${qIndex+1} / ${questions.length}</span></div><div class="progress"><i class="progress-fill"></i></div><div class="q-type">${esc(q.kind)}</div><h2 class="question">${esc(q.q)}</h2><p class="question-hint">${esc(q.hint)}</p>${q.input?`<form id="recall-form"><label class="recall-label" for="recall-answer">你的答案</label><input id="recall-answer" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(selected||'')}" ${judged?'disabled':''}><button class="secondary" ${judged?'disabled':''}>检查答案</button></form>`:`<div class="answers">${q.choices.map((v,i)=>`<button class="answer ${judged&&v===q.answer?'correct':''} ${judged&&v===selected&&!correct?'wrong':''}" data-answer="${esc(v)}" ${judged?'disabled':''}><span class="letter">${'ABC'[i]}</span><span>${esc(v)}</span></button>`).join('')}</div>`}${judged?`<div class="feedback ${correct?'':'wrong'}"><h3>${correct?'答对了':'正确答案：'+esc(q.answer)}</h3><p>${esc(q.why)}</p></div>`:''}<div class="practice-actions"><button class="link" id="read-again">回看本支讲解</button><button class="primary" id="next-q" ${judged?'':'disabled'}>${qIndex===questions.length-1?'完成本支':'下一题 →'}</button></div>`;
  card.querySelector('.progress-fill').style.width=(qIndex+(judged?1:0))/questions.length*100+'%';
  card.querySelectorAll('[data-answer]').forEach(btn=>btn.onclick=()=>recordAllianceAnswer(btn.dataset.answer));
  const form=$('#recall-form');if(form)form.onsubmit=e=>{e.preventDefault();const v=$('#recall-answer').value.trim();if(v)recordAllianceAnswer(v);};
  $('#next-q').onclick=()=>{if(persistAllianceProgress(()=>{qIndex++;}))renderPractice();};$('#read-again').onclick=()=>{if(persistAllianceProgress(()=>{alliancePracticeStage='read';}))renderPractice();};
}
