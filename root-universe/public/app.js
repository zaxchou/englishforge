'use strict';
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const relationNames={modern_derived_from:'现代派生',modern_compound_of:'现代复合',borrowed_from:'借入自',inherited_from:'继承自',historical_derived_from:'历史派生',historical_compound_of:'历史复合',cognate_with:'同源',allomorph_of:'词素异形',synonym_of:'近义',antonym_of:'反义',analysis_component:'现代成分'};
const posNames={noun:'名词',verb:'动词',adjective:'形容词',adverb:'副词',participle:'分词',prefix:'前缀',suffix:'后缀'};
const langNames={en:'英语',la:'拉丁语',grc:'古希腊语','Middle English':'中古英语','enm':'中古英语','fro':'古法语'};
const sectionNames={Etymology:'词源',Verb:'动词',Noun:'名词',Adjective:'形容词',Participle:'分词',Pronunciation:'发音'};
function humanLocator(locator){
  const parts=String(locator).split(';').map(s=>s.trim()).filter(Boolean);
  const shown=[];
  for(const part of parts){
    if(/^(wikitext|snapshot)\b/.test(part))continue;
    const seg=part.split('/').map(s=>s.trim());
    if(seg.length===2&&seg[1]==='language heading'){shown.push((langNames[seg[0]]||seg[0])+' · 语言章节');continue;}
    if(seg[1]==='Etymology'){
      const pos=seg[2]?(sectionNames[seg[2]]||seg[2])+'义':'';
      shown.push((langNames[seg[0]]||seg[0])+' · 词源'+(pos?' · '+pos:'')+(seg[3]?' '+seg[3]:''));continue;
    }
    const m=/^([^/]+)\/===(.+?)===$/.exec(part);
    if(m){shown.push((langNames[m[1]]||m[1])+' · '+(sectionNames[m[2]]||m[2])+'章节');continue;}
    shown.push(part);
  }
  return shown.join(' · ')||String(locator);
}
let G=null,nodeById=new Map(),view='lookup';
let lookupSense=null,graphFocus=null,trail=[],graphFamily=null;
let learning=null,lookupSequence=0,rootGraphMode=false;
const roleNames={root:'词根',prefix:'前缀',suffix:'后缀',base:'基词'};
function address(replace=true){
  const u=new URL(location.href);u.search='';
  if(lookupSense){u.searchParams.set('node',lookupSense);u.searchParams.set('q',nodeById.get(lookupSense)?.label||'');}
  u.searchParams.set('view',view);history[replace?'replaceState':'pushState']({},'',u);
}
function learningSources(data,ids){
  return (ids||[]).map(id=>data.sources.find(s=>s.id===id)).filter(Boolean).map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Wiktionary · ${esc(s.entry)} ↗</a>`).join(' · ');
}
function rootLearningHTML(data){
  if(data?.status!=='reviewed')return '<section class="root-pending"><h3>词根溯源尚未完成</h3><p>已有词义和邻词关系，但还不能把相邻基词当作最终词根。</p></section>';
  if(data.alliance?.id&&data.word.query_id)return allianceProfileHTML(data);
  const w=data.word;
  return `<section class="root-answer" aria-label="核心词根"><div class="eyebrow">这个词的核心词根</div>${data.roots.map(r=>`<div class="root-heading"><h3>${esc(r.label)}</h3><span>${esc(r.meaning)}</span></div><p>${esc(r.origin)}</p>`).join('')}<button class="link" id="root-panorama">围绕词根看整个词族 →</button></section>
  <section class="section root-breakdown"><h3>拆开记，更好懂</h3><div class="breakdown">${w.parts.map((p,i)=>`${i?'<span class="plus" aria-hidden="true">+</span>':''}<div class="piece ${p.role==='root'?'root-piece':'base'}"><small>${esc(roleNames[p.role])}</small><strong>${esc(p.label)}</strong><span>${esc(p.meaning)}</span></div>`).join('')}</div><p class="explanation">${esc(w.explanation)}</p><div class="modern-formula"><strong>现代构词</strong><span>${esc(w.modern_formula)}</span></div></section>
  <section class="section root-trace"><h3>一路追到词根</h3><p class="trace-caption">学习溯源摘要 · 现代构词与历史来源分层展示</p><ol>${w.trace.map(s=>`<li class="${s.kind}"><strong>${esc(s.label)}</strong><span>${esc(s.meaning)}</span></li>`).join('')}</ol>
  <details class="root-evidence"><summary>查看词根依据与更早来源</summary>${data.roots.map(r=>`<p>${esc(r.forms_note)}</p><p>${learningSources(data,r.source_ids)}</p><div class="earlier-origin">${(r.earlier||[]).map(e=>`<span><b>${esc(e.label)}</b> · ${esc(e.language)} · ${esc(e.meaning)}</span>`).join(' → ')}</div><p>${esc(r.earlier_note)}</p><p>${learningSources(data,r.earlier_source_ids)}</p>`).join('')}<p>${esc(w.caveat)}</p><details><summary>原始依据（含维基标记）</summary>${data.sources.map(s=>`<article class="learning-source"><strong>${esc(s.entry)}</strong><blockquote>${esc(s.excerpt)}</blockquote><p>${learningSources(data,[s.id])} · ${esc(s.license)} · ${esc(s.attribution)}</p></article>`).join('')}</details></details></section>
  ${w.example?`<section class="section"><h3>放进一句话</h3><div class="meaning-example"><p>${esc(w.example.en)}</p><small>${esc(w.example.zh)}</small></div></section>`:''}
  ${data.alliance?allianceHTML(data):''}`;
}
function allianceHTML(data){
  if(data.alliance?.id&&data.word.query_id)return completeAllianceHTML(data);
  const a=data.alliance;
  return `<section class="section alliance"><h3>词根联盟 · ${esc(a.coverage_note)}</h3>
  ${a.branches.map((b,i)=>`<details class="alliance-branch" ${i===0?'open':''}><summary><b>${esc(b.title)}</b><small>${esc(b.idea)}</small><span>${b.words.length} 词</span></summary>
  <div class="alliance-words">${b.words.map(w=>w.sense_id?`<button class="alliance-word clickable" data-word="${esc(w.sense_id)}"><b>${esc(w.word)}</b><span>${esc(w.clue)}</span></button>`:`<div class="alliance-word"><b>${esc(w.word)}</b><span>${esc(w.clue)}</span></div>`).join('')}</div>
  <p class="alliance-note">不属于本根但拼形相近：${a.excluded.slice(0,8).map(x=>esc(x.word)).join('、')}…</p></details>`).join('')}
  <details class="alliance-branch"><summary>排除的词（拼形相近但不同根）</summary><div class="alliance-excluded">${a.excluded.map(x=>`<div><b>${esc(x.word)}</b><span>${esc(x.reason)}</span></div>`).join('')}</div></details></section>`;
}
let practiceFamily=null,practiceKey=null,questions=[],qIndex=0,answers=[];
const practiceContext=()=>[lookupSense,learning?.version||''].join(':');
const api=async p=>{const r=await fetch(p);const d=await r.json();if(!r.ok)throw Error(d.error||'REQUEST_FAILED');return d;};
let toastTimer=null;
function toast(text){const t=$('#toast');t.textContent=text;t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.hidden=true;},2600);}
const sensesOf=headId=>G.nodes.filter(n=>n.type==='senses'&&n.headword_id===headId);
const familyOf=id=>G.familyOf.get(id)||null;
const familySenses=f=>f?f.member_ids.map(id=>nodeById.get(id)).filter(n=>n.type==='senses'&&n.zh&&n.language==='en'):[];
const familyLabelOf=id=>{const f=familyOf(id);return f?f.label:'未分族';};
function edgesTouching(id){return G.edges.filter(e=>e.from_id===id||e.to_id===id);}
function otherOf(e,id){return nodeById.get(e.from_id===id?e.to_id:e.from_id);}
async function fetchSources(ids,ctx){ // ctx: {clean,zh} cleaned definition of the node being viewed
  const out=[];
  for(const id of [...new Set(ids)]){
    try{out.push(await api('/api/source?id='+encodeURIComponent(id)));}catch(e){/* keep partial */}
  }
  if(!out.length)return '<p class="tech">出处暂时无法读取。</p>';
  return out.map(e=>`<strong>${esc(e.entry)}</strong>
    <p>${esc(humanLocator(e.locator))} · 修订 ${esc(String(e.source_version||'').replace('enwiktionary-revid-',''))}</p>
    <div class="raw-label">Wiktionary 原文（未改动，含维基标记）</div><code>${esc(e.original_text)}</code>
    ${ctx&&ctx.clean?`<div class="raw-label">整理后（作者去标记，非原文）</div><p class="clean-line">${esc(ctx.clean)}</p>`:''}
    ${ctx&&ctx.zh?`<p class="clean-line">${esc(ctx.zh)}</p>`:''}
    ${e.translation_zh?`<p class="clean-line">${esc(e.translation_zh)}</p>`:''}
    <p>采集时备注（历史存档，非当前状态）：${esc(e.translation_note)}</p>
    <a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">打开来源版本 ↗</a>
    <div class="tech">当前状态：已通过独立来源复核，纳入正式图。<br>${esc(e.license)} · ${esc(e.attribution)}<br>片段SHA-256：${esc(e.excerpt_sha256)}</div>`).join('<hr style="border:0;border-top:1px solid var(--line)">');
}
function bindSourceTriggers(root){
  root.querySelectorAll('[data-source-trigger]').forEach(b=>{b.onclick=async()=>{
    const box=document.getElementById(b.dataset.sourceTrigger);
    if(box.hidden&&!box.dataset.loaded){box.innerHTML='<p>正在读取出处…</p>';const ctx=box.dataset.ctx?JSON.parse(box.dataset.ctx):null;
      box.innerHTML=await fetchSources(JSON.parse(box.dataset.evidence),ctx);box.dataset.loaded='1';}
    box.hidden=!box.hidden;b.setAttribute('aria-expanded',String(!box.hidden));};
  });
}
function setView(v){
  if(v==='graph'&&view==='lookup'){rootGraphMode=learning?.status==='reviewed';graphFocus=lookupSense;trail=[];}
  view=v;address();
  document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==v+'-view');
  document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('on',b.dataset.view===v);if(b.dataset.view===v)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  $('#top-context').textContent={lookup:'从一个词，认识一个词族',graph:'点击邻词，沿着关系继续探索',practice:'把一组相近的词，用法分清楚'}[v];
  if(v==='graph')renderGraph();
  if(v==='practice'){
    if(learning?.status==='reviewed'&&learning.alliance?.id&&learning.word.query_id){renderAlliancePractice();window.scrollTo({top:0,behavior:'instant'});return;}
    const f=familyOf(lookupSense);
    if(f&&practiceKey!==practiceContext())startPractice(f);else renderPractice();
  }
  window.scrollTo({top:0,behavior:'instant'});
}
function renderDown(){
  document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!=='lookup-view');
  $('#word-content').innerHTML='<div class="notice-empty"><h2>词族内容暂未就绪</h2><p>正式索引尚未构建或暂时无法读取，可稍后重试。</p><button class="primary" id="reload-app">重试</button></div>';
  $('#reload-app').onclick=()=>location.reload();
}
function renderUnknown(){
  $('#word-content').innerHTML='<div class="notice-empty"><h2>这个词还未收录</h2><p>目前只收录已通过独立来源复核的词族。可以先看看已收录的词。</p><button class="secondary" id="reset-word">查看已收录的词</button></div>';
  $('#reset-word').onclick=()=>{lookupSense=defaultSense();renderWord();};
}
function defaultSense(){
  const all=G.nodes.filter(n=>n.type==='senses'&&n.zh&&n.language==='en');
  return (all.find(n=>n.label==='predict')||all[0]).id;
}
async function renderWord(){
  const n=nodeById.get(lookupSense),sequence=++lookupSequence;
  if(!n||(n.type!=='senses'&&n.type!=='learning_word')){renderUnknown();return;}
  $('#word-content').setAttribute('aria-busy','true');
  let data;
  try{data=await api('/api/learning?id='+encodeURIComponent(n.id));}catch{data={status:'unresolved'};}
  if(sequence!==lookupSequence)return;
  learning=data;$('#word-content').removeAttribute('aria-busy');
  $('#search').value=n.label;address();
  if(n.type==='learning_word'){const head=nodeById.get(n.headword_id);$('#word-content').innerHTML=`<div class="lookup-grid"><article><div class="word-entry"><div class="word-title"><h2>${esc(n.label)}</h2></div><div class="translation">${esc(data.word.meaning)}</div><div class="tiny-tags"><span class="tag green">${esc(learning.alliance.title)}</span><span class="tag">第${esc(String(learning.word.lesson))}课</span><span class="tag green">课程词</span></div></div>${rootLearningHTML(data)}</article></div>`;
    document.querySelectorAll('#word-content [data-word]').forEach(b=>b.onclick=()=>{lookupSense=b.dataset.word;renderWord();});
    if($('#root-panorama'))$('#root-panorama').onclick=()=>{graphFocus=lookupSense;rootGraphMode=true;trail=[];setView('graph');};
    bindAllianceActions($('#word-content'));return;}
  const head=nodeById.get(n.headword_id),etym=n.etymology_id?nodeById.get(n.etymology_id):null;
  const headSenses=head?sensesOf(head.id):[n];
  const mine=edgesTouching(lookupSense);
  const outModern=mine.filter(e=>e.layer==='modern'&&e.from_id===lookupSense);
  const outHist=mine.filter(e=>e.layer==='historical'&&e.from_id===lookupSense);
  const inModern=mine.filter(e=>e.layer==='modern'&&e.to_id===lookupSense);
  const modern=outModern.length?outModern:[],hist=outHist.length?outHist:[];
  const sectionH3=outModern.length?'构词成分':outHist.length?'词源成分':inModern.length?'构成了这些词':'构词成分';
  const piece=(e,i)=>{const o=otherOf(e,lookupSense);const sub=o.zh||posNames[o.pos]||(o.language?`〔${langNames[o.language]||o.language}〕`:'')||relationNames[e.type];
    return `${i>0?'<span class="plus">+</span>':''}<div class="piece ${i>0?'base':''}"><strong>${esc(o.label||'')}</strong><small>${esc(sub)}</small></div>`;};
  const layerTag=modern.length?'现代构词':hist.length?'历史来源':'已核实词族';
  const fam=familyOf(lookupSense);
  const rail=(fam?fam.member_ids.map(id=>nodeById.get(id)):[]).filter(m=>m&&m.type==='senses'&&m.id!==lookupSense).slice(0,4);
  const mini=rail.slice(0,3);
  const ctx=JSON.stringify({clean:n.definition_original||'',zh:n.zh||''});
  $('#word-content').innerHTML=`<div class="lookup-grid"><article>
    <div class="word-entry">
      <div class="word-title"><h2>${esc(head?(head.label||head.display):n.label)}</h2><span class="pos">${esc(posNames[n.pos]||n.pos||'')}</span></div>
      <div class="translation">${esc(data.status==='reviewed'?data.word.meaning:n.zh||'')}</div>
      ${headSenses.length>1?`<div class="sense-chips">${headSenses.map(s=>`<button data-sense="${esc(s.id)}" class="${s.id===lookupSense?'active':''}">${esc(posNames[s.pos]||s.pos||'词义')} · ${esc((s.zh||'').slice(0,14))}</button>`).join('')}</div>`:''}
      <div class="tiny-tags"><span class="tag green">${esc(data.status==='reviewed'?data.roots.map(r=>r.label).join(' / ')+' 词族':fam?fam.label:'词族')}</span><span class="tag">${esc(layerTag)}</span>${head&&head.course_member?'<span class="tag green">课程词</span>':''}</div>
    </div>
    ${rootLearningHTML(data)}
    <section class="section ${data.status==='reviewed'?'secondary-relations':''}"><h3>${data.status==='reviewed'?'已核实的直接关系':esc(sectionH3)}</h3>
      ${(modern.length||hist.length)?`<div class="breakdown">${(modern.length?modern:hist).map((e,i)=>piece(e,i)).join('')}</div>`:inModern.length?`<div class="breakdown">${inModern.map(e=>piece(e,-1)).join('')}</div>`:'<p class="explanation">该词义尚无已核实的构词关系。</p>'}
      ${etym&&etym.identity_note?`<p class="explanation">${esc(etym.identity_note)}</p>`:''}
      ${n.evidence_ids&&n.evidence_ids.length?`<button class="source-trigger" data-source-trigger="lookup-source" aria-expanded="false"><span class="dot"></span>来源与原文 <span aria-hidden="true">↗</span></button><div class="source-box" id="lookup-source" hidden data-evidence="${esc(JSON.stringify(n.evidence_ids))}" data-ctx='${esc(ctx)}'></div>`:''}
    </section>
    <section class="section"><h3>连起来看</h3><div class="family-rail">${rail.length?rail.map(m=>`<button class="family-chip" data-word="${esc(m.id)}"><b>${esc(m.label)}</b><small>${esc(m.zh||posNames[m.pos]||'')}</small></button>`).join(''):'<p class="explanation">该词族的其他词义还在整理中。</p>'}</div></section>
    </article>
    <aside class="side-note"><div class="label">${data.status==='reviewed'?'围绕词根串起来':'与这个词有关'}</div><h3>${esc(data.status==='reviewed'?data.roots.map(r=>r.label+'「'+r.meaning+'」').join(' / '):fam?fam.label:'')}</h3>
      <p>先看共同基础，再看词义和词性的变化。现代构词与历史来源是两层信息。</p>
      <div class="mini-list">${mini.map(m=>`<button data-word="${esc(m.id)}">${esc(m.label)}<span>查看 →</span></button>`).join('')}</div>
      <button class="primary" id="lookup-graph">展开词族关系 →</button>
      ${practiceFamilyAvailable(fam)?'<button class="link" id="lookup-practice">练一练这组词</button>':''}
    </aside></div>`;
  document.querySelectorAll('#word-content [data-word]').forEach(b=>b.onclick=()=>{lookupSense=b.dataset.word;renderWord();});
  document.querySelectorAll('#word-content [data-sense]').forEach(b=>b.onclick=()=>{lookupSense=b.dataset.sense;renderWord();});
  const openGraph=()=>{graphFocus=lookupSense;rootGraphMode=learning?.status==='reviewed';trail=[];graphFamily=(familyOf(lookupSense)||{}).id||graphFamily;setView('graph');};
  $('#lookup-graph').onclick=openGraph;
  if($('#root-panorama'))$('#root-panorama').onclick=openGraph;
  if($('#lookup-practice'))$('#lookup-practice').onclick=()=>{startPractice(familyOf(lookupSense));setView('practice');};
  bindSourceTriggers($('#word-content'));
  if(data.alliance?.id&&data.word.query_id)bindAllianceActions($('#word-content'));
}
function practiceFamilyAvailable(f){return f&&familySenses(f).filter(m=>m.label).length>=3&&new Set(familySenses(f).map(m=>m.label)).size>=3;}
/* ---------- graph ---------- */
function rootGraphData(){
  if(learning.alliance?.id&&learning.word.query_id)return allianceGraphData();
  const members=learning.members||[learning.word],roots=learning.family_roots||learning.roots;
  const rootIds=new Set(members.flatMap(w=>w.root_ids));
  const rootsInView=roots.filter(r=>rootIds.has(r.id));
  for(const r of rootsInView)nodeById.set('learning:'+r.id,{id:'learning:'+r.id,type:'learning_root',label:r.label,zh:r.meaning,identity_note:[r.origin,r.forms_note].filter(Boolean).join('。')});
  const words=members.map(w=>({...nodeById.get(w.sense_id),zh:w.meaning})),ids=new Set(words.map(w=>w.id));
  const modern=G.edges.filter(e=>e.layer==='modern'&&e.assertion==='positive'&&ids.has(e.from_id)&&ids.has(e.to_id));
  const bases=words.filter(w=>!modern.some(e=>e.from_id===w.id));
  const ranks=new Map(bases.map(w=>[w.id,0]));
  for(let k=0;k<words.length;k++)for(const e of modern)if(ranks.has(e.to_id)&&!ranks.has(e.from_id))ranks.set(e.from_id,ranks.get(e.to_id)+1);
  const pos={},edges=[...modern];let y=65;
  const place=row=>{for(let k=0;k<row.length;k+=2){const chunk=row.slice(k,k+2);chunk.forEach((id,i)=>{pos[id]={x:chunk.length===1?50:26+48*i,y};});y+=140;}};
  place(rootsInView.map(r=>'learning:'+r.id));
  const rows=new Map();for(const w of words){const rank=ranks.get(w.id)||0;if(!rows.has(rank))rows.set(rank,[]);rows.get(rank).push(w.id);}
  for(const rank of [...rows.keys()].sort((a,b)=>a-b))place(rows.get(rank));
  for(const r of rootsInView){
    const related=members.filter(w=>w.root_ids.includes(r.id));
    const relatedIds=new Set(related.map(w=>w.sense_id));
    const starts=related.filter(w=>!modern.some(e=>e.from_id===w.sense_id&&relatedIds.has(e.to_id)));
    for(const w of starts)edges.push({from_id:w.sense_id,to_id:'learning:'+r.id,layer:'historical',type:'learning_summary',label:'词源关联',summary:w.trace.filter(s=>s.kind==='historical').map(s=>s.label).join(' · ')});
  }
  return {pos,edges,height:y-60,rootMode:true};
}
function graphData(){
  if(rootGraphMode&&learning?.status==='reviewed')return rootGraphData();
  const levels=new Map([[graphFocus,0]]);
  let todo=[graphFocus];
  for(let d=0;d<2;d++){
    const next=[];
    for(const id of todo)for(const e of G.edges){
      if(e.from_id!==id&&e.to_id!==id)continue;
      const other=e.from_id===id?e.to_id:e.from_id;
      if(levels.has(other))continue;
      levels.set(other,d+1);next.push(other);
    }
    todo=next;
  }
  const rows=new Map();
  for(const [id,l] of levels){if(!rows.has(l))rows.set(l,[]);rows.get(l).push(id);}
  const ordered=[...rows.keys()].sort((a,b)=>a-b),pos={},visualRows=[];
  for(const l of ordered){const ids=rows.get(l);for(let k=0;k<ids.length;k+=2)visualRows.push(ids.slice(k,k+2));}
  for(const [i,ids] of visualRows.entries()){
    const y=visualRows.length===1?230:60+i*(350/(visualRows.length-1));
    ids.forEach((id,j)=>{pos[id]={x:ids.length===1?50:(j===0?26:74),y};});
  }
  return {pos,edges:G.edges.filter(e=>levels.has(e.from_id)&&levels.has(e.to_id))};
}
function renderGraph(){
  const fam=familyOf(graphFocus)||familyOf(lookupSense);
  let modes=$('#graph-modes');
  if(!modes){modes=document.createElement('div');modes.id='graph-modes';modes.className='graph-modes';$('.graph-toolbar').before(modes);}
  const canRoot=learning?.status==='reviewed'&&fam?.id===familyOf(lookupSense)?.id;
  if(!canRoot)rootGraphMode=false;
  modes.hidden=!canRoot;
  modes.innerHTML='<button type="button" data-graph-mode="root">词根全景</button><button type="button" data-graph-mode="neighbors">直接关系</button>';
  modes.querySelectorAll('button').forEach(b=>{b.classList.toggle('active',(b.dataset.graphMode==='root')===rootGraphMode);b.onclick=()=>{rootGraphMode=b.dataset.graphMode==='root';graphFocus=lookupSense;trail=[];renderGraph();};});
  $('.graph-toolbar .label').textContent=rootGraphMode?'词根全景 · 溯源摘要':'当前词附近 · 两层关系';
  $('.graph-note').textContent=rootGraphMode?'从词根串起这组词。棕色虚线是学习溯源摘要；具体历史形式可在右侧查看。':'点一个词，以它为中心继续展开。每条关系都可回看出处。';
  document.querySelectorAll('#family-switch button').forEach(b=>b.classList.toggle('active',b.dataset.family===(fam?fam.id:'')));
  $('#graph-back').disabled=!trail.length;
  $('#graph-back').onclick=()=>{if(trail.length){graphFocus=trail.pop();renderGraph();}};
  const data=graphData();
  $('#family-map').classList.toggle('root-map',!!data.rootMode);
  $('#family-map').style.height=(data.height||476)+'px';
  $('#map-nodes').innerHTML=Object.entries(data.pos).map(([id,p])=>{
    const n=nodeById.get(id),root=n.type==='learning_root'||n.type==='etymologies'||(n.language&&n.language!=='en');
    return `<button class="map-node ${id===graphFocus?'current':''} ${root?'root':''}" data-node="${esc(id)}" data-x="${p.x}" data-y="${p.y}" aria-pressed="${id===graphFocus}"><strong>${esc(n.label||'')}</strong><small>${esc(n.zh||posNames[n.pos]||langNames[n.language]||'词族节点')}</small></button>`;
  }).join('');
  document.querySelectorAll('#map-nodes [data-node]').forEach(b=>{b.style.left=b.dataset.x+'%';b.style.top=b.dataset.y+'px';});
  document.querySelectorAll('#map-nodes [data-node]').forEach(b=>{b.onclick=()=>focusWord(b.dataset.node);});
  renderGraphDetail();
  requestAnimationFrame(()=>drawLines(data));
}
function focusWord(id){
  if(id===graphFocus)return;
  trail.push(graphFocus);graphFocus=id;renderGraph();
}
function renderGraphDetail(){
  if(rootGraphMode&&learning?.status==='reviewed'&&learning.alliance?.id&&learning.word.query_id)return allianceGraphDetail();
  const n=nodeById.get(graphFocus);
  const fam=familyOf(graphFocus)||familyOf(lookupSense);
  if(rootGraphMode&&learning?.status==='reviewed'){
    const roots=learning.family_roots||learning.roots,selected=(learning.members||[learning.word]).find(w=>w.sense_id===n.id);
    const relevant=n.type==='learning_root'?roots.filter(r=>'learning:'+r.id===n.id):roots.filter(r=>selected?.root_ids.includes(r.id));
    const explanation=selected?selected.explanation:relevant.map(r=>r.forms_note||r.origin).join(' ');
    const trace=selected?.trace||[],sourceIds=selected?selected.source_ids:relevant.flatMap(r=>r.source_ids);
    $('#graph-detail').innerHTML=`<div><span class="eyebrow">${n.type==='learning_root'?'核心词根':'当前词'}</span><h2>${esc(n.label)}</h2><div class="translation">${esc(selected?.meaning||n.zh||'')}</div></div><div class="mini-divider"></div><div class="root-summary-note">${relevant.map(r=>`<p><b>${esc(r.label)} · ${esc(r.meaning)}</b><br>${esc(r.origin)}</p>`).join('')}</div><p class="detail-text">${esc(explanation)}</p><details class="root-evidence"><summary>查看逐层来源</summary>${trace.length?`<ol>${trace.map(s=>`<li>${esc(s.label)} · ${esc(s.meaning)}</li>`).join('')}</ol>`:''}<p>${learningSources(learning,sourceIds)}</p></details><button class="primary" id="graph-word">${n.type==='learning_root'?'返回查词':'查看这个词'}</button>`;
    $('#graph-word').onclick=()=>{if(n.type==='senses')lookupSense=n.id;renderWord();setView('lookup');};return;
  }
  const root=n.type==='etymologies'||(n.language&&n.language!=='en');
  $('#graph-detail').innerHTML=`<div><span class="eyebrow">当前词</span><h2>${esc(n.label||'')}</h2>
    <div class="translation">${esc(n.zh||'')}</div>
    <span class="tag" ${n.pos?`data-pos="${esc(n.pos)}"`:''}>${esc([posNames[n.pos],langNames[n.language]||n.language].filter(Boolean).join(' · ')||'词族节点')}</span></div>
    <div class="mini-divider"></div>
    <p class="detail-text">${esc(n.identity_note||(n.zh?'该词义已通过独立来源复核。':'历史中间形式，用于连接现代词与更早的来源。'))}</p>
    ${n.evidence_ids&&n.evidence_ids.length?`<button class="source-trigger" data-source-trigger="graph-source" aria-expanded="false"><span class="dot"></span>来源与原文 <span aria-hidden="true">↗</span></button><div class="source-box" id="graph-source" hidden data-evidence='${esc(JSON.stringify(n.evidence_ids))}' data-ctx='${esc(JSON.stringify({clean:n.definition_original||'',zh:n.zh||''}))}'></div>`:''}
    ${!root&&n.type==='senses'?`<button class="primary" id="graph-word">查看这个词</button>`:`<button class="primary" id="graph-word">查看这个词</button>`}`;
  const gw=$('#graph-word');if(gw)gw.onclick=()=>{if(n.type==='senses'){lookupSense=n.id;renderWord();setView('lookup');}else{const en=familySenses(fam)[0];if(en){lookupSense=en.id;renderWord();setView('lookup');}}};
  bindSourceTriggers($('#graph-detail'));
}
function drawLines(data){
  const host=$('#family-map'),svg=$('#map-lines');
  if(!host||host.offsetWidth===0)return;
  const hb=host.getBoundingClientRect();
  svg.setAttribute('viewBox',`0 0 ${hb.width} ${hb.height}`);
  svg.innerHTML=data.edges.map(e=>{
    const aEl=host.querySelector(`[data-node="${CSS.escape(e.to_id)}"]`),bEl=host.querySelector(`[data-node="${CSS.escape(e.from_id)}"]`);
    if(!aEl||!bEl)return '';
    const a=aEl.getBoundingClientRect(),b=bEl.getBoundingClientRect();
    const ax=a.x+a.width/2-hb.x,ay=a.y+a.height/2-hb.y,bx=b.x+b.width/2-hb.x,by=b.y+b.height/2-hb.y;
    const dx=bx-ax,dy=by-ay;
    const f1=Math.min(Math.abs((a.width/2+3)/(dx||.001)),Math.abs((a.height/2+3)/(dy||.001)));
    const f2=Math.min(Math.abs((b.width/2+3)/(dx||.001)),Math.abs((b.height/2+3)/(dy||.001)));
    const x1=ax+dx*f1,y1=ay+dy*f1,x2=bx-dx*f2,y2=by-dy*f2;
    const mx=(x1+x2)/2,my=(y1+y2)/2;
    const color=e.layer==='historical'?'#a88b62':'#82a38e';
    const label=e.label||relationNames[e.type]||'';
    return `<path d="M${x1} ${y1} L${x2} ${y2}" fill="none" stroke="${color}" stroke-width="1.5" ${e.layer==='historical'?'stroke-dasharray="4 4"':''}/><text x="${mx}" y="${my-5}" text-anchor="middle" fill="${e.layer==='historical'?'#846338':'#557260'}" class="map-line-label">${esc(label)}</text>`;
  }).join('');
}
new ResizeObserver(()=>{if(view==='graph'&&!$('#graph-view').hidden)drawLines(graphData());}).observe($('#family-map'));
function buildFamilySwitch(){
  const fams=G.families.filter(f=>f.member_ids.some(id=>{const n=nodeById.get(id);return n.type==='senses'&&n.language==='en';}));
  $('#family-switch').innerHTML=fams.map(f=>`<button data-family="${esc(f.id)}">${esc(f.label)}</button>`).join('');
  document.querySelectorAll('#family-switch button').forEach(b=>b.onclick=()=>{trail=[];rootGraphMode=false;graphFamily=b.dataset.family;graphFocus=defaultFocusOf(b.dataset.family);renderGraph();});
}
function defaultFocusOf(famId){
  const f=G.families.find(x=>x.id===famId);
  const senses=f?f.member_ids.map(id=>nodeById.get(id)).filter(n=>n.type==='senses'&&n.language==='en'):[];
  const head=nodeById.get(famId);
  const ofHead=head?senses.find(s=>s.headword_id===head.id):null;
  return (ofHead||senses[0]||{id:defaultSense()}).id;
}
/* ---------- practice ---------- */
function startPractice(fam){
  practiceFamily=fam?fam.id:practiceFamily;
  practiceKey=practiceContext();
  qIndex=0;answers=[];
  questions=makeQuestions(G.families.find(f=>f.id===practiceFamily));
  $('#practice-family-tag').textContent=fam?fam.label:'';
  renderPractice();
}
function makeQuestions(fam){
  const members=familySenses(fam);
  const qs=[];
  if(learning?.status==='reviewed'&&memberIn(fam,learning.sense_id)){
    const w=learning.word,roots=learning.roots,rootParts=w.parts.filter(p=>p.role==='root');
    const rootForms=(rootParts.length?rootParts.map(p=>p.label):roots.map(r=>r.label)).join(' + '),meaning=roots.map(r=>r.meaning).join('；');
    const part=w.parts.find(p=>p.role!=='root')||w.parts[0];
    const roles=[part.role,...Object.keys(roleNames).filter(k=>k!==part.role).slice(0,2)];
    return [
      {kind:'先认词根',q:`${w.word} 的核心词根是什么？`,hint:'区分词根、词缀和整个单词。',choices:[rootForms,w.word+'（完整单词）','只看前后缀，不需要词根'],answer:rootForms,why:roots.map(r=>r.label+' 表示「'+r.meaning+'」').join('；')+'。'},
      {kind:'记住根义',q:`${roots.map(r=>r.label).join(' + ')} 表达的核心意思是什么？`,hint:roots.map(r=>r.origin).join('；'),choices:[meaning,'只表示单词的词性','没有词义，只起连接作用'],answer:meaning,why:roots.map(r=>r.forms_note||r.origin).join('；')},
      {kind:'分清成分',q:`${part.label} 在 ${w.word} 中是什么成分？`,hint:'词根、前后缀、基词各有自己的作用。',choices:roles.map(k=>roleNames[k]),answer:roleNames[part.role],why:`${part.label} 是${roleNames[part.role]}，表示「${part.meaning}」。${w.explanation}`}
    ];
  }
  const pickChoices=(labels,answer)=>{const rest=labels.filter(l=>l!==answer).sort();const chosen=rest.slice(0,2);return [answer,...chosen];};
  if(members.length>=3&&new Set(members.map(m=>m.label)).size>=3){
    const labels=[...new Set(members.map(m=>m.label))];
    const m1=members.find(m=>m.zh&&m.zh.length<=18)||members[0];
    let ch=pickChoices(labels,m1.label);
    ch=ch.sort().slice(1).concat(ch[0]);
    qs.push({kind:'先认含义',q:`哪个词表示「${m1.zh}」？`,hint:'看词义，也留意它是哪个词性。',choices:ch,answer:m1.label,why:`${m1.label}：${m1.zh}（${posNames[m1.pos]||m1.pos}）。`});
    const posList=[...new Set(members.map(m=>m.pos))];
    if(posList.length>=2){
      const m2=members.find(m=>m.pos===posList[0]);
      const distractors=labels.filter(label=>label!==m2.label&&!members.some(m=>m.label===label&&m.pos===m2.pos));
      if(distractors.length>=2)qs.push({kind:'分清词性',q:`下列哪个词有${posNames[m2.pos]||m2.pos}用法？`,hint:'按已收录的词义判断；一个词可以有不止一种词性。',choices:[m2.label,...distractors.slice(0,2)].sort(),answer:m2.label,why:`${m2.label} 有${posNames[m2.pos]||m2.pos}义；另外两个词在本组已收录的词义中没有该词性。`});
    }
  }
  const edges=G.edges.filter(e=>e.layer!=='auxiliary'&&memberIn(fam,e.from_id)&&memberIn(fam,e.to_id));
  const rel=edges.find(e=>e.layer==='historical')||edges.find(e=>e.layer==='modern');
  if(rel){
    const a=nodeById.get(rel.from_id),b=nodeById.get(rel.to_id);
    const dir=`${a.label} → ${b.label}`;
    qs.push({kind:'认关系',q:`${a.label} 的${rel.layer==='historical'?'历史来源':'现代构词基础'}是哪个词？`,hint:'关系图里的箭头都指向来源词。',choices:pickChoices([...new Set([a.label,b.label,...familySenses(fam).map(m=>m.label)])],b.label).sort(),answer:b.label,why:`${dir} · ${relationNames[rel.type]}。`});
  }
  return qs;
}
function memberIn(f,id){return !!(f&&f.member_ids.includes(id));}
function renderPractice(){
  if(learning?.status==='reviewed'&&learning.alliance?.id&&learning.word.query_id)return renderAlliancePractice();
  let fam=G.families.find(f=>f.id===practiceFamily);
  if(!fam){
    fam=G.families.find(f=>practiceFamilyAvailable(f))||G.families[0];
    practiceFamily=fam.id;questions=makeQuestions(fam);qIndex=0;answers=[];
  }
  $('#practice-family-tag').textContent=fam?fam.label:'';
  const members=familySenses(fam);
  $('#practice-aside').innerHTML=`<h3>这一组词的关系</h3>${members.map(m=>`<div class="memory-line${m.id===lookupSense?' active':''}">${esc(m.label)}<span>${esc(posNames[m.pos]||m.pos||'')} · ${esc(m.zh||'')}</span></div>`).join('')}<button class="link" id="practice-family">回看词族关系 →</button>`;
  $('#practice-family').onclick=()=>{graphFocus=defaultFocusOf(fam.id);trail=[];setView('graph');};
  const card=$('#practice-card');
  if(!questions.length){
    card.innerHTML='<div class="notice-empty"><h2>该词族暂不能出题</h2><p>串联练习需要同一词族里至少三个已核实的词义。这个族还在整理中，先去词族图里看看关系。</p><button class="primary" id="go-graph">回看词族关系 →</button></div>';
    $('#go-graph').onclick=()=>{graphFocus=defaultFocusOf(fam.id);trail=[];setView('graph');};return;
  }
  if(qIndex>=questions.length){
    const good=answers.filter((v,i)=>v===questions[i].answer).length;
    card.innerHTML=`<div class="finish"><div class="roundcheck" aria-hidden="true">✓</div><h2>本轮辨析已完成</h2><p>本轮完成 ${questions.length} 题 · 首次答对 ${good} 题</p><div class="finish-actions"><button class="primary" id="finish-family">回看词族</button><button class="secondary" id="restart">再练一遍</button></div></div>`;
    $('#restart').onclick=()=>startPractice(fam);
    $('#finish-family').onclick=()=>{graphFocus=defaultFocusOf(fam.id);trail=[];setView('graph');};
    return;
  }
  const q=questions[qIndex],selected=answers[qIndex],judged=selected!==undefined;
  card.innerHTML=`<div class="practice-meta"><span>词族辨析 · ${esc(fam.label)}</span><span>${qIndex+1} / ${questions.length}</span></div>
    <div class="progress" aria-label="本轮完成进度"><i class="progress-fill" data-fill="${(qIndex+(judged?1:0))/questions.length*100}"></i></div>
    <div class="q-type">${esc(q.kind)}</div><h2 class="question">${esc(q.q)}</h2><p class="question-hint">${esc(q.hint)}</p>
    <div class="answers">${q.choices.map((v,i)=>`<button class="answer ${judged&&v===q.answer?'correct':''} ${judged&&v===selected&&v!==q.answer?'wrong':''}" data-answer="${esc(v)}" ${judged?'disabled':''}><span class="letter">${'ABC'[i]}</span><span>${esc(v)}</span></button>`).join('')}</div>
    ${judged?`<div class="feedback ${selected!==q.answer?'wrong':''}"><h3>${selected===q.answer?'答对了':'正确答案：'+esc(q.answer)}</h3><p>${esc(q.why)}</p></div>`:''}
    <div class="practice-actions"><button class="link" id="q-family">回看这组词的关系</button><button class="primary" id="next-q" ${judged?'':'disabled'}>${qIndex===questions.length-1?'完成本轮':'下一题 →'}</button></div>`;
  const fill=card.querySelector('.progress-fill');if(fill)fill.style.width=fill.dataset.fill+'%';
  card.querySelectorAll('[data-answer]').forEach(b=>b.onclick=()=>{if(answers[qIndex]===undefined)answers[qIndex]=b.dataset.answer;renderPractice();});
  $('#next-q').onclick=()=>{qIndex++;renderPractice();};
  $('#q-family').onclick=()=>{graphFocus=defaultFocusOf(fam.id);trail=[];setView('graph');};
}
/* ---------- search ---------- */
let suggestSeq=0;
async function searchWords(){
  const val=$('#search').value.trim().toLowerCase();
  const seq=++suggestSeq;
  if(!val){$('#suggestions').hidden=true;return;}
  try{
    const result=await api('/api/search?q='+encodeURIComponent(val));
    if(seq!==suggestSeq)return;
    const rows=[];
    for(const h of result.results)for(const s of h.senses)rows.push({id:s.id,word:h.display,zh:s.zh||s.definition_zh||''});
    $('#suggestions').hidden=false;
    $('#suggestions').innerHTML=rows.length?rows.slice(0,7).map(r=>`<button data-pick="${esc(r.id)}" type="button"><b>${esc(r.word)}</b><small>${esc(r.zh)}</small></button>`).join(''):'<div class="empty-search">当前词族还没有匹配的词。</div>';
    document.querySelectorAll('#suggestions [data-pick]').forEach(b=>b.onclick=()=>{lookupSense=b.dataset.pick;$('#suggestions').hidden=true;renderWord();});
  }catch(e){if(seq===suggestSeq)toast('暂时无法读取，请重试。');}
}
$('#search').addEventListener('input',searchWords);
$('#search').onkeydown=e=>{if(e.key==='Escape')$('#suggestions').hidden=true;};
document.addEventListener('click',e=>{if(!e.target.closest('.search-area'))$('#suggestions').hidden=true;});
$('#search-form').onsubmit=e=>{
  e.preventDefault();
  const val=$('#search').value.trim().toLowerCase();
  if(!val)return;
  api('/api/search?q='+encodeURIComponent(val)).then(result=>{
    let hit=null;
    for(const h of result.results){
      const exact=h.display.toLowerCase()===val;
      const s=(exact?[h]:result.results).flatMap(x=>x.senses);
      if(s.length){hit=exact?s[0].id:s[0].id;break;}
    }
    if(hit){lookupSense=hit;$('#suggestions').hidden=true;renderWord();}
    else renderUnknown();
  }).catch(()=>toast('暂时无法读取，请重试。'));
};
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
(async function boot(){
  try{
    G=await api('/api/graph');
  }catch(e){renderDown();return;}
  G.nodes.forEach(n=>nodeById.set(n.id,n));
  G.familyOf=new Map();
  G.families.forEach(f=>f.member_ids.forEach(id=>G.familyOf.set(id,f)));
  const params=new URLSearchParams(location.search),requested=params.get('node'),query=params.get('q');
  lookupSense=requested||G.nodes.find(n=>n.type==='senses'&&n.label?.toLowerCase()===query?.toLowerCase())?.id||defaultSense();
  const fam=familyOf(lookupSense);
  graphFamily=fam?fam.id:G.families[0].id;
  graphFocus=lookupSense;
  buildFamilySwitch();
  const initial=params.get('view');
  await renderWord();
  try{
    const saved=JSON.parse(localStorage.getItem('root-universe:session')||'null');
    if(saved&&saved.key===practiceContext()&&saved.version===learning?.version&&learning?.alliance&&memberId(learning.word)===lookupSense){practiceKey=saved.key;alliancePracticeBranch=saved.branch;alliancePracticeStage=saved.stage||'read';qIndex=saved.index||0;answers=saved.answers||[];}
  }catch{}
  if(['lookup','graph','practice'].includes(initial))setView(initial);
  window.onpopstate=async()=>{const p=new URLSearchParams(location.search);lookupSense=p.get('node')||defaultSense();graphFocus=lookupSense;await renderWord();setView(p.get('view')||'lookup');};
})();
