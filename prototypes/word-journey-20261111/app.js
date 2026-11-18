'use strict';
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const steps=['meaning','origin','family','practice'];
const stepNames={meaning:'词义与用法',origin:'构词来由',family:'词根与词族',practice:'回忆与应用'};
const roleNames={prefix:'前缀',root:'词根',suffix:'后缀',base:'基词'};
const relationNames={close:'近支词',cognate:'远缘同源',classroom:'课堂关联',unresolved:'关系待核'};
const trio=['contradict','contradiction','contradictory'];
const predictTrio=['predict','predictable','unpredictable'];
const profileCache=new Map();
let current=null,phase='meaning',lookupSequence=0,searchSequence=0,searchTimer,toastTimer,graphCache=null,lastRoot=null,quiz=null;
const api=async p=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),20000);try{const r=await fetch('/api/'+p,{signal:c.signal});const data=await r.json();if(!r.ok)throw Error(data.error||'REQUEST_FAILED');return data;}finally{clearTimeout(t);}};
function toast(text){$('#notice').textContent=text;$('#notice').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#notice').hidden=true,3000);}
const queryId=w=>w.query_id||w.sense_id;
const partsOf=w=>Array.isArray(w.parts)?w.parts:[];
const genuineParts=w=>partsOf(w).length>0&&!(w.parts.length===1&&w.parts[0].role==='base'&&w.parts[0].label.toLowerCase()===w.word.toLowerCase());
function address(replace=false,root=null){const u=new URL(location.href);u.search='';if(root)u.searchParams.set('root',root.id);else if(current){u.searchParams.set('word',queryId(current.word));u.searchParams.set('step',phase);}history[replace?'replaceState':'pushState']({},'',u);}
function hidePanels(){for(const id of ['welcome','results','study'])$('#'+id).hidden=true;$('#suggestions').hidden=true;}
function hasApplications(){return !!quiz?.questions.some(q=>q.kind==='换语境应用');}
function practiceLabel(){return !current||hasApplications()?'回忆与应用':'词义回忆';}
function navigation(){document.querySelectorAll('[data-step]').forEach(b=>{if(b.dataset.step==='practice'){const div=b.querySelector('div');if(div){div.childNodes[0].textContent=practiceLabel();div.querySelector('small').textContent=hasApplications()||!current?'试着独立用出来':'试着独立回想';}else b.textContent=hasApplications()||!current?'4 应用':'4 回忆';}b.disabled=!current;b.classList.toggle('active',!!current&&b.dataset.step===phase);if(current&&b.dataset.step===phase)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');});}
function reset(push=true){++lookupSequence;++searchSequence;current=null;lastRoot=null;quiz=null;phase='meaning';hidePanels();$('#welcome').hidden=false;$('#search').value='';navigation();if(push)address();window.scrollTo({top:0,behavior:'instant'});$('#search').focus();}
function errorHTML(title,body,button='重新读取'){return `<div class="notice-box" role="alert"><h2>${esc(title)}</h2><p>${esc(body)}</p><button class="secondary" id="retry">${esc(button)}</button></div>`;}
async function loadWord(id,{step='meaning',replace=false,push=true}={}){
  const seq=++lookupSequence;++searchSequence;$('#suggestions').hidden=true;
  current=null;quiz=null;navigation();
  hidePanels();$('#results').hidden=false;$('#results').innerHTML='<div class="notice-box" role="status"><h2>正在读取这个词…</h2><p>词义、构词和词族正在加载。</p></div>';
  try{
    let d=profileCache.get(id);if(!d){d=await api('learning?id='+encodeURIComponent(id));if(d.status==='reviewed')profileCache.set(id,d);}
    if(seq!==lookupSequence)return;
    if(d.status!=='reviewed'){
      const detail=await api('node?id='+encodeURIComponent(id));if(seq!==lookupSequence)return;
      current=null;navigation();$('#results').innerHTML=errorHTML(detail.node?.definition_zh||'这个词的资料还在整理','目前没有完整的构词档案。可以继续查其他已收录词。','查其他词');$('#retry').onclick=()=>reset();return;
    }
    if(!d.word||!Array.isArray(d.members)||!Array.isArray(d.roots))throw Error('PROFILE_INVALID');
    current=d;phase=steps.includes(step)?step:'meaning';quiz=makeQuiz(d);restoreQuiz();render();if(push)address(replace);window.scrollTo({top:0,behavior:'instant'});
  }catch{if(seq!==lookupSequence)return;current=null;navigation();$('#results').innerHTML=errorHTML('这个词暂时无法读取','请检查网络后重试，或者继续搜索其他词。');$('#retry').onclick=()=>loadWord(id,{step,replace,push});}
}
function groupWords(d=current){
  const names=trio.includes(d.word.word)?trio:predictTrio.includes(d.word.word)?predictTrio:null;
  if(names)return names.map(name=>d.members.find(w=>w.word===name)).filter(Boolean);
  const branch=d.alliance?.branches.find(b=>b.words.some(w=>queryId(w)===queryId(d.word)));
  const ids=new Set((branch?.words||[]).map(queryId));
  const others=d.members.filter(w=>queryId(w)!==queryId(d.word)&&(!ids.size||ids.has(queryId(w))));
  return [d.word,...others].slice(0,3);
}
function sourcesHTML(d=current){
  const ids=new Set(d.word.source_ids||[]),sources=d.sources.filter(s=>ids.has(s.id));
  return `<details class="sources"><summary>查看词源依据与原文</summary><p>以下是固定修订的来源。上方“构词思路”为作者整理的理解线索；历史形式和借入路径以来源为准。</p>${sources.map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.entry)} ↗</a>`).join('')}<details><summary>原文片段与署名</summary>${sources.map(s=>`<p><b>${esc(s.entry)}</b> · ${esc(s.license)} · ${esc(s.attribution)}</p><blockquote>${esc(s.excerpt)}</blockquote>`).join('')}</details></details>`;
}
function rootInfo(d=current){return d.roots[0]||null;}
function meaningHTML(){
  const w=current.word,parts=partsOf(w),example=w.example;
  let note=trio.includes(w.word)?({contradict:'常用作动词：说法、事实或证据，与另一说法相反。',contradiction:'用名词指出一种不一致：两份说法之间存在矛盾。',contradictory:'用形容词描述彼此不一致的说法或情况。'}[w.word]):'先在句子里看清它表达的意思，再追到构词和词族。';
  const clue=genuineParts(w)?`<div class="pieces-inline">${parts.map((p,i)=>`${i?'<span>＋</span>':''}<b>${esc(p.label)}</b>`).join('')}</div><p>${esc(w.modern_formula||w.explanation)}</p>`:`<p>${esc(w.explanation||w.meaning)}</p>`;
  return `<div class="meaning-layout"><section><h2>先看它怎么用</h2><p class="stage-lead">${esc(note)}</p>${example?`<div class="usage-example"><p class="en">${esc(example.en)}</p><p class="zh">${esc(example.zh)}</p></div><p class="meaning-type">${example.kind==='original'?'原创学习例句':'课程例句'}</p>`:'<div class="usage-example"><p class="en">'+esc(w.meaning)+'</p><p class="zh">本词的学习例句尚未补充。</p></div>'}<p class="use-note">下一步，把这个意思与构词成分连起来。</p></section><aside class="clue-preview"><h3>${genuineParts(w)?'接下来：看懂构词':'接下来：已有的课堂线索'}</h3>${clue}<button class="link" data-go="origin">看它怎样表达这个意思 →</button></aside></div>${sourcesHTML()}`;
}
function story(w){
  if(w.word==='contradict')return '要表达“说出反对的话”，可以把 contra-「相反、反对」与“说”的词源成分联系起来：朝相反方向说 → 反驳。主语换成事实或证据时，就是“与某种说法相矛盾”。';
  if(w.word==='contradiction')return '先理解“反着说、反驳”这个动作，再把它看成一种行为、结果或状态：一次反驳，或两种说法之间的矛盾。这里的 -ion 帮助理解名词形式；它不是任意动词都能套用的造词规则。';
  if(w.word==='contradictory')return '如果要描述两种说法的性质，可以从“彼此反驳、相互不一致”想到“相互矛盾的”。这里的 -ory 帮助理解这个形容词，来源也给出了与 contradict + -ory 等价的现代分析。';
  return w.explanation||w.modern_formula||w.meaning;
}
function originHTML(){
  const w=current.word,parts=partsOf(w),trioWord=trio.includes(w.word);
  return `<h2>${trioWord?'从“相反”与“说”，理解“矛盾”':'把词义和构词连起来'}</h2><p class="stage-lead">${genuineParts(w)?'先辨认成分各自的角色，再看它们怎样帮助理解整个词。':'本词现有资料以课堂线索为主，逐词构词分析仍待补充。'}</p>${genuineParts(w)?`<div class="parts ${parts.length>2?'many':''}">${parts.map((p,i)=>`${i?'<span class="plus" aria-hidden="true">＋</span>':''}<div class="part ${p.role==='root'?'root':''}"><span class="role">${esc(roleNames[p.role])}</span><strong>${esc(p.label)}</strong><span class="sense">${esc(p.meaning)}</span>${p.root_id?'<button data-go="family">连到同根词 →</button>':''}</div>`).join('')}</div>`:''}<div class="thinking"><h3>${trioWord?'构词思路':'理解线索'}</h3><p>${esc(story(w))}</p><small>${trioWord?'作者整理的理解方式；不是历史人物的心理记录。':'保留已有档案中的说明；课堂联想与历史事实分开看。'}</small></div><section class="origin-trace"><h3>来源追踪 · 从现在向前看</h3><ol class="trace">${(w.trace||[]).map(t=>`<li><strong>${esc(t.label)}</strong><span>${esc(t.meaning)}</span></li>`).join('')}</ol></section>${trioWord?'<p class="meaning-type">dict 是词源性词干，不是能独立使用的现代英语动词。英语词的借入史与表层记忆拆解是两层信息。</p>':''}${sourcesHTML()}`;
}
function wordNode(w,kind='英语单词'){return `<button class="word-node ${w.word===current.word.word?'active':''}" data-family-word="${esc(queryId(w))}"><span class="node-kind">${esc(kind)}</span><b>${esc(w.word)}</b><small>${esc(w.meaning)}</small></button>`;}
function historicalMap(words){
  const routes={contradict:'经拉丁 contrādictus',contradiction:'经拉丁 contrādictiō、古法语与中古英语',contradictory:'经晚期拉丁 contradictorius'};
  return `<div class="relation-map" aria-label="反驳词族共享来源关系图"><div class="source-row"><div class="source-node"><span class="node-kind">前缀</span><b>contrā-</b><small>相反；反对</small></div><div class="source-node"><span class="node-kind">词源基础</span><b>dīcō</b><small>说；讲 · 相关词干 dic- / dict-</small></div></div><div class="connector">拉丁语构成</div><div class="history-node"><span class="node-kind">共同的拉丁语来源</span><b>contrādīcō</b><small>说出反对的话；反驳</small></div><div class="word-branches">${words.map((w,i)=>`<div class="word-branch"><p class="route-note">路径 ${i+1} · ${esc(routes[w.word])} ↓</p>${wordNode(w)}</div>`).join('')}</div></div>`;
}
function modernMap(words){
  const ordered=predictTrio.map(name=>words.find(w=>w.word===name)).filter(Boolean);
  const nodeIds=new Set(ordered.map(queryId));
  const edges=(graphCache?.edges||[]).filter(e=>e.type==='modern_derived_from'&&nodeIds.has(e.from_id)&&nodeIds.has(e.to_id));
  if(edges.length!==2)return `<div class="relation-map"><p class="stage-lead">现代派生关系暂时无法读取，下面先列出当前学习组。</p><div class="word-branches">${ordered.map(w=>wordNode(w,'课堂学习条目')).join('')}</div></div>`;
  return `<div class="relation-map" aria-label="预测词族现代构词关系图"><div class="modern-chain">${ordered.map((w,i)=>`${i?`<div class="modern-link"><strong>＋ ${i===1?'-able':'un-'}</strong>${i===1?'可…的':'不；非'} →</div>`:''}${wordNode(w)}`).join('')}</div></div>`;
}
function learningMap(words){const roots=current.roots;return `<div class="relation-map" aria-label="当前词的学习关联图"><div class="source-row">${roots.map(r=>`<div class="source-node"><span class="node-kind">词源性基础</span><b>${esc(r.label)}</b><small>${esc(r.meaning)}</small></div>`).join('')||'<div class="source-node"><b>课堂串联</b><small>尚未归入已核根身份</small></div>'}</div><div class="connector">学习分组 · 不表示逐词直接派生</div><div class="word-branches">${words.map(w=>wordNode(w,relationNames[w.relation_kind]||'学习条目')).join('')}</div></div>`;}
function rootMembers(){const ids=new Set(current.word.root_ids||[]);return current.members.filter(w=>w.root_ids?.some(id=>ids.has(id)));}
function memberListHTML(words){return ['close','cognate','classroom','unresolved'].map(kind=>{const selected=words.filter(w=>(w.relation_kind||'close')===kind);return selected.length?`<section class="member-group"><h3>${esc(relationNames[kind])} · ${selected.length} 词</h3><div class="member-list">${selected.map(w=>`<button data-lookup="${esc(queryId(w))}"><span><b>${esc(w.word)}</b><small>${esc(w.meaning)}</small></span><span aria-hidden="true">→</span></button>`).join('')}</div></section>`:'';}).join('');}
function familyHTML(){
  const words=groupWords(),r=rootInfo(),members=rootMembers(),historical=trio.includes(current.word.word),modern=predictTrio.includes(current.word.word);
  return `<div class="graph-heading"><div><h2>${historical?'同一个来源，三种不同表达':modern?'从一个词，逐层形成新词':'沿着共同基础，看清相关词'}</h2><p>${historical?'三条借入路径分别展示；不把记忆拆解画成历史直接派生。':modern?'实线表示已有来源支持的现代构词关系。':'连线表示学习关联，各词的具体来源可继续查看。'}</p></div></div><div class="relation-legend"><span>${historical?'历史来源':modern?'现代构词':'学习关联'}</span></div>${historical?historicalMap(words):modern?modernMap(words):learningMap(words)}<div class="map-focus"><p>当前词：<b>${esc(current.word.word)}</b> · 点图中的其他词可接着查。</p><button class="link" data-go="origin">回看当前词的构词来由 →</button></div>${members.length?`<details class="family-expanded"><summary>${esc(r?.label||'当前词根')} · 展开全部 ${members.length} 个已收录相关词</summary><p class="stage-lead">近支、远缘同源和课堂关联分别列出；这些标签不等于词与词之间的直接派生边。</p>${memberListHTML(members)}</details>`:''}${sourcesHTML()}`;
}
function quizKey(){return 'word-journey:quiz:'+queryId(current.word);}
function makeQuiz(d){
  const words=groupWords(d),w=d.word;
  const questions=[{id:queryId(w)+':recall',kind:'主动回忆',prompt:w.recall?.prompt||'根据释义写出英文：'+w.meaning,answer:w.word,input:true,why:w.recall?.explanation||w.explanation,hint:genuineParts(w)?w.parts.map(p=>p.label+'「'+p.meaning+'」').join(' ＋ '):w.explanation}];
  const contexts={predict:{prompt:'Scientists cannot ___ every detail of future weather.',zh:'科学家无法预测未来天气的每一个细节。',answer:'predict',why:'cannot 后面接动词原形，这里需要 predict。'},predictable:{prompt:'The pattern repeats every week, so the result is ___.',zh:'这个模式每周重复，所以结果是可以预料的。',answer:'predictable',why:'规律重复使结果可预测，用 predictable。'},unpredictable:{prompt:'The wind kept changing without warning; it was ___.',zh:'风向毫无征兆地不断变化，是难以预测的。',answer:'unpredictable',why:'without warning 强调无法预料，用 unpredictable。'},contradict:{prompt:'The facts ___ his claim.',zh:'事实与他的说法相矛盾。',answer:'contradict',why:'facts 是复数主语，后面需要动词 contradict。'},contradiction:{prompt:'There is a ___ between the dates on these two forms.',zh:'这两份表格上的日期存在矛盾。',answer:'contradiction',why:'a 后面需要一个名词：contradiction。'},contradictory:{prompt:'The two reports give ___ explanations.',zh:'两份报告给出了相互矛盾的解释。',answer:'contradictory',why:'这里要修饰 explanations，用形容词 contradictory。'}};
  if(trio.includes(w.word)||predictTrio.includes(w.word))for(const name of (trio.includes(w.word)?trio:predictTrio).filter(n=>n!==w.word))questions.push({id:name+':use',kind:'换语境应用',...contexts[name],choices:[...(trio.includes(w.word)?trio:predictTrio)]});
  else for(const other of words.filter(x=>x.word!==w.word).slice(0,2))questions.push({id:queryId(other)+':recall',kind:'同组回忆',prompt:other.recall?.prompt||'根据释义写出英文：'+other.meaning,answer:other.word,input:true,why:other.recall?.explanation||other.explanation,hint:genuineParts(other)?other.parts.map(p=>p.label+'「'+p.meaning+'」').join(' ＋ '):other.explanation});
  questions.forEach((q,i)=>{if(q.choices){const shift=(q.answer.length+i)%q.choices.length;q.choices=q.choices.slice(shift).concat(q.choices.slice(0,shift));}});
  return {version:d.version,questions,index:0,answers:[],draft:'',hint:false};
}
function saveQuiz(){try{sessionStorage.setItem(quizKey(),JSON.stringify({version:quiz.version,signature:quiz.questions.map(q=>q.id),index:quiz.index,answers:quiz.answers,draft:quiz.draft,hint:quiz.hint}));}catch{toast('本次位置暂时无法保存，请保持页面打开。');}}
function restoreQuiz(){try{const saved=JSON.parse(sessionStorage.getItem(quizKey())||'null');if(saved?.version===quiz.version&&JSON.stringify(saved.signature)===JSON.stringify(quiz.questions.map(q=>q.id))&&Number.isInteger(saved.index)&&saved.index>=0&&saved.index<=quiz.questions.length&&Array.isArray(saved.answers)&&saved.answers.length>=saved.index&&saved.answers.length<=Math.min(saved.index+1,quiz.questions.length)&&saved.answers.every((a,i)=>a&&typeof a.value==='string'&&typeof a.correct==='boolean'&&a.correct===(a.value.trim().toLowerCase()===quiz.questions[i].answer.toLowerCase()))){quiz.index=saved.index;quiz.answers=saved.answers;quiz.draft=typeof saved.draft==='string'?saved.draft:'';quiz.hint=!!saved.hint;}}catch{}}
function practiceHTML(){
  const done=quiz.index>=quiz.questions.length;
  if(done)return `<div class="finished"><span class="eyebrow">本轮结束</span><h2>把这组词，放回它们的关系里</h2><p class="score">首次答对 ${quiz.answers.filter(a=>a.correct).length} / ${quiz.questions.length} 题</p><ul>${quiz.questions.map((q,i)=>`<li><b>${esc(q.answer)}</b><small>${quiz.answers[i]?.correct?'首次答对':'本轮需要回看'}</small></li>`).join('')}</ul><p class="stage-lead">${hasApplications()?'回忆和应用':'词义与拼写回忆'}只是这一轮的证据；之后仍需按现有学习计划复习。</p><div class="finish-actions"><button class="primary" data-go="family">回到词族</button><button class="secondary" id="restart-quiz">再试一轮</button><button class="link" data-reset>查下一个词 →</button></div></div>`;
  const q=quiz.questions[quiz.index],a=quiz.answers[quiz.index];
  return `<div class="practice-box"><div class="practice-meta"><span>${esc(q.kind)}</span><span>${quiz.index+1} / ${quiz.questions.length}</span></div><progress value="${quiz.index+(a?1:0)}" max="${quiz.questions.length}" aria-label="本轮进度"></progress><h2>${q.input?'先不看英文，回想一下':'把词放进新的句子'}</h2><p class="prompt">${esc(q.prompt)}</p>${q.zh?`<p class="stage-lead">${esc(q.zh)}</p>`:''}${q.input?`<form id="answer-form"><label for="answer" class="sr-only">写出英文单词</label><input class="answer-input" id="answer" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="写出英文单词" value="${esc(a?.value||quiz.draft)}" ${a?'disabled':''} required><div class="quiz-controls"><button type="button" class="link" id="hint" ${a?'disabled':''}>给一点构词提示</button><button class="primary" type="submit" ${a?'disabled':''}>确认答案</button></div></form>`:`<div class="quiz-options">${q.choices.map((v,i)=>`<button data-answer="${esc(v)}" class="${a&&v===q.answer?'chosen':''} ${a&&!a.correct&&v===a.value?'wrong':''}" ${a?'disabled':''}><span>${'ABC'[i]}</span>${esc(v)}</button>`).join('')}</div>`}${quiz.hint&&!a?`<p class="quiz-hint">${esc(q.hint||'先回想这个词在当前组里的含义。')}</p>`:''}${a?`<div class="quiz-feedback ${a.correct?'':'wrong'}"><strong>${a.correct?'这题答对了':'正确答案：'+esc(q.answer)}</strong><p>${esc(q.why)}</p></div><div class="quiz-controls"><button class="link" data-go="origin">回看构词来由</button><button class="primary" id="next-question">${quiz.index===quiz.questions.length-1?'看本轮结果':'下一题 →'}</button></div>`:''}</div>`;
}
function header(){
  const w=current.word,testing=phase==='practice';
  $('#word-title').textContent=testing?'回忆这组词':w.word;$('#word-meaning').textContent=testing?(hasApplications()?'先回想，再放进新的句子':'先回想词义，再写出英文'):w.meaning;
  $('#breadcrumb-word').textContent=testing?'当前词族':w.word;$('#breadcrumb-step').textContent=phase==='practice'?practiceLabel():stepNames[phase];
  $('#word-role').textContent=testing?'本轮 '+quiz.questions.length+' 题':trio.includes(w.word)?'词源与结构已逐词复核':predictTrio.includes(w.word)?'现代派生关系已核':'课程学习条目';
  $('#pronounce').hidden=testing;$('#search').value=testing?'':w.word;
  navigation();
}
function render(){
  hidePanels();$('#study').hidden=false;header();
  $('#stage').innerHTML=phase==='meaning'?meaningHTML():phase==='origin'?originHTML():phase==='family'?familyHTML():practiceHTML();
  const index=steps.indexOf(phase),next=steps[index+1];
  const labels={meaning:'看懂它的构词来由 →',origin:'沿词根看这一组词 →',family:'用这组词练一轮 →'};
  $('#next-action').hidden=!next;$('#next-action').innerHTML=next?`<p>下一步 · ${esc(next==='practice'?practiceLabel():stepNames[next])}</p><button class="primary" data-go="${next}">${labels[phase]}</button>`:'';
  bindActions();
  if(phase==='family'&&predictTrio.includes(current.word.word)&&!graphCache){const d=current;api('graph').then(g=>{graphCache=g;if(current===d&&phase==='family')render();}).catch(()=>toast('现代构词关系暂时未读到，可以重试进入词族。'));}
}
function go(step,{push=true}={}){if(!current||!steps.includes(step))return;phase=step;if(step==='practice'&&'speechSynthesis'in window)speechSynthesis.cancel();render();if(push)address();window.scrollTo({top:0,behavior:'instant'});}
function answer(value){const q=quiz.questions[quiz.index];if(quiz.answers[quiz.index])return;const v=value.trim();if(!v){toast('先写出你的答案。');return;}quiz.answers[quiz.index]={value:v,correct:v.toLowerCase()===q.answer.toLowerCase(),hint:quiz.hint};quiz.draft='';saveQuiz();render();}
function bindActions(){
  document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));
  document.querySelectorAll('[data-lookup]').forEach(b=>b.onclick=()=>loadWord(b.dataset.lookup));
  document.querySelectorAll('[data-reset]').forEach(b=>b.onclick=()=>reset());
  document.querySelectorAll('[data-family-word]').forEach(b=>b.onclick=()=>loadWord(b.dataset.familyWord,{step:'family'}));
  document.querySelectorAll('[data-answer]').forEach(b=>b.onclick=()=>answer(b.dataset.answer));
  if($('#answer-form'))$('#answer-form').onsubmit=e=>{e.preventDefault();answer($('#answer').value);};
  if($('#answer'))$('#answer').oninput=()=>{quiz.draft=$('#answer').value;saveQuiz();};
  if($('#hint'))$('#hint').onclick=()=>{quiz.hint=true;saveQuiz();render();};
  if($('#next-question'))$('#next-question').onclick=()=>{quiz.index++;quiz.draft='';quiz.hint=false;saveQuiz();render();window.scrollTo({top:0,behavior:'instant'});};
  if($('#restart-quiz'))$('#restart-quiz').onclick=()=>{quiz=makeQuiz(current);saveQuiz();render();};
}
function resultHTML(data){
  const roots=data.roots||[];
  const words=data.results.length?'<h3>单词</h3>'+data.results.flatMap(h=>h.senses.map(s=>'<button class="result-row" data-result-word="'+esc(s.id)+'"><b>'+esc(h.display)+'</b><small>'+esc(s.zh||s.definition_zh||'')+'</small></button>')).join(''):'';
  const rootRows=roots.length?'<h3>词根 · 按形式或含义匹配</h3>'+roots.map(r=>'<button class="result-row" data-root="'+esc(r.id)+'"><b>'+esc(r.label)+'</b><small>'+esc(r.meaning)+' · '+r.count+' 词</small></button>').join(''):'';
  const text=$('#search').value.trim().toLowerCase(),rootIntent=/^-|-$/.test(text)||(!data.results.some(h=>h.display.toLowerCase()===text)&&roots.length>0);
  return (rootIntent?rootRows+words:words+rootRows)+(!roots.length&&!data.results.length?'<div class="notice-box"><h2>这个词暂未收录</h2><p>可以试试 contradict、unpredictable，或用词根含义搜索。</p></div>':'')+(data.truncated?'<p class="meaning-type">匹配较多，继续输入可缩小范围。</p>':'');
}
function bindResults(host){host.querySelectorAll('[data-result-word]').forEach(b=>b.onclick=()=>loadWord(b.dataset.resultWord));host.querySelectorAll('[data-root]').forEach(b=>b.onclick=()=>openRoot(b.dataset.root));}
async function search({submit=false,push=true}={}){
  const text=$('#search').value.trim(),seq=++searchSequence;if(!text){$('#suggestions').hidden=true;if(submit)reset();return;}
  try{const data=await api('search?q='+encodeURIComponent(text)+'&max=50');if(seq!==searchSequence)return;
    if(submit){++lookupSequence;const exact=data.results.find(h=>h.display.toLowerCase()===text.toLowerCase());if(exact)return loadWord(exact.senses[0].id,{push});current=null;quiz=null;navigation();if(push){const u=new URL(location.href);u.search='';u.searchParams.set('q',text);history.pushState({},'',u);}hidePanels();$('#results').hidden=false;$('#results').innerHTML='<h1>“'+esc(text)+'” 的查找结果</h1>'+resultHTML(data);bindResults($('#results'));}
    else{$('#suggestions').hidden=false;$('#suggestions').innerHTML=resultHTML(data);bindResults($('#suggestions'));}
  }catch{if(seq===searchSequence)toast('搜索暂时无法完成，请重试。');}
}
async function browseRoots({push=true}={}){const seq=++lookupSequence;++searchSequence;current=null;quiz=null;navigation();if(push){const u=new URL(location.href);u.search='?browse=roots';history.pushState({},'',u);}hidePanels();$('#results').hidden=false;$('#results').innerHTML='<div class="notice-box" role="status">正在读取词根目录…</div>';try{const data=await api('roots');if(seq!==lookupSequence)return;$('#results').innerHTML='<button class="link" id="back-search">← 回到查词</button><h1>已有词根</h1><p class="stage-lead">点一个词根，再从相关词里选一个开始。</p><div class="root-results">'+data.results.map(r=>`<button class="root-result" data-root="${esc(r.id)}"><b>${esc(r.label.split('「')[0])}</b><span>${esc(r.meaning)}</span><small>${r.count}词 · ${esc(r.title)}</small></button>`).join('')+'</div>';bindResults($('#results'));$('#back-search').onclick=()=>reset();}catch{if(seq===lookupSequence){$('#results').innerHTML=errorHTML('词根目录暂时无法读取','请检查网络后重试。');$('#retry').onclick=browseRoots;}}}
async function openRoot(id,{push=true}={}){const seq=++lookupSequence;++searchSequence;current=null;quiz=null;navigation();hidePanels();$('#results').hidden=false;$('#results').innerHTML='<div class="notice-box" role="status">正在读取相关词…</div>';try{const r=await api('root?id='+encodeURIComponent(id));if(seq!==lookupSequence)return;lastRoot=r;$('#results').innerHTML='<button class="link" id="back-roots">← 词根目录</button><h1>'+esc(r.label)+'</h1><p class="stage-lead">'+esc(r.meaning)+' · '+r.count+' 个相关词。选一个词，开始看词义、构词和用法。</p>'+['close','cognate','classroom','unresolved'].map(k=>{const list=r.members.filter(w=>w.relation_kind===k);return list.length?'<section class="member-group"><h3>'+esc(relationNames[k])+'</h3><div class="member-list">'+list.map(w=>'<button data-result-word="'+esc(w.id)+'"><span><b>'+esc(w.word)+'</b><small>'+esc(w.meaning)+'</small></span><span aria-hidden="true">→</span></button>').join('')+'</div></section>':'';}).join('');bindResults($('#results'));$('#back-roots').onclick=browseRoots;if(push)address(false,r);window.scrollTo({top:0,behavior:'instant'});}catch{if(seq===lookupSequence){$('#results').innerHTML=errorHTML('相关词暂时无法读取','请重试或继续查其他词。');$('#retry').onclick=()=>openRoot(id,{push});}}}
$('#search').oninput=()=>{++searchSequence;clearTimeout(searchTimer);searchTimer=setTimeout(()=>search(),180);};
$('#search-form').onsubmit=e=>{e.preventDefault();clearTimeout(searchTimer);search({submit:true});};
$('#search').onkeydown=e=>{if(e.key==='Escape'){$('#suggestions').hidden=true;++searchSequence;}if(e.key==='ArrowDown'&&!$('#suggestions').hidden){e.preventDefault();$('#suggestions button')?.focus();}};
document.addEventListener('click',e=>{if(!e.target.closest('.search-header')){$('#suggestions').hidden=true;++searchSequence;}});
document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>go(b.dataset.step));
$('#browse-roots').onclick=browseRoots;
$('#pronounce').onclick=()=>{if(!current||!('speechSynthesis'in window))return toast('这个浏览器暂不支持朗读。');speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(current.word.word);u.lang='en-US';u.rate=.85;speechSynthesis.speak(u);};
async function restoreURL(){const p=new URLSearchParams(location.search);if(p.get('word'))await loadWord(p.get('word'),{step:p.get('step')||'meaning',push:false});else if(p.get('root'))await openRoot(p.get('root'),{push:false});else if(p.get('q')){$('#search').value=p.get('q');await search({submit:true,push:false});}else if(p.get('browse')==='roots')await browseRoots({push:false});else reset(false);}
window.onpopstate=restoreURL;
bindActions();navigation();restoreURL();
