/* 课程认读界面（多课）。两按钮认读 + 课级认读轮/复习轮双会话位。
   数据来自 /api/vocab/lesson*；所有评分由服务端结算，本文件只负责呈现与时序。 */
(function(){
  const CONFIRM_MS=2500;
  const q=id=>document.getElementById(id);
  let token=0, active=false, lessonId='cfcm-01-01', slot='first';
  let cardsByLesson=new Map(), lesson=null, session=null, reviewInfo=null, hardWords=[];
  let busy=false, uni=false, err='', audio=null;
  let pending=null, confirming=false, confirmTimer=null, timeMark=null, doneShown=false;
  const byKey=new Map();

  const eventId=()=>'lv-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
  const now=()=>Date.now();
  const cards=()=>cardsByLesson.get(lessonId)||null;

  function stopAudio(){ try{if(audio){audio.onerror=null;audio.pause();audio=null;} window.speechSynthesis?.cancel();}catch(e){} }

  function speak(card){
    stopAudio();
    if(!card) return;
    if(card.key!==card.word){ try{vbSpeakLocal(card.word);}catch(e){} return; }
    try{
      const a=new Audio('/api/vocab/tts?w='+encodeURIComponent(card.key));
      audio=a;
      const fallback=()=>{ if(audio===a) { try{vbSpeakLocal(card.word);}catch(e){} } };
      a.onerror=fallback;
      a.play().catch(fallback);
    }catch(e){ try{vbSpeakLocal(card.word);}catch(_){} }
  }

  function settleTime(){
    try{
      if(timeMark && !document.hidden){
        const sec=Math.round((Date.now()-timeMark)/1000);
        if(sec>=1 && typeof studyTick==='function'){
          studyTick(sec);
          if(sec>=5 && typeof recSave==='function') recSave();
        }
      }
    }catch(e){}
    timeMark=(document.hidden||doneShown)?null:Date.now();
  }
  function onVis(){ if(document.hidden) settleTime(); else if(active&&!doneShown) timeMark=Date.now(); }

  function shell(inner){
    const review=session&&session.phase==='review';
    return '<div class="lv-wrap">'
      + '<div class="lv-head"><div><h3>'+esc(lesson?lesson.title:lessonId)+(review?' · 复习轮':'')+'</h3>'
      + '<div class="meta">'+(review?'本轮到期词，认出即延长间隔；想不起来看卡':'本课 <b>'+(lesson?lesson.total:0)+'</b> 词 · 已整理 <b>'+(lesson?lesson.noted:0)+'</b> 条老师讲解')+'</div></div>'
      + '<button class="lv-exit" id="lv-exit">返回背单词</button></div>'
      + progress()+inner+'</div>';
  }
  function progress(){
    if(!session) return '';
    const dm=session.doneCount||0, total=session.total||1;
    return '<div class="lv-progress"><div class="lv-track"><i style="width:'+Math.round(dm/total*100)+'%"></i></div>'
      + '<span class="lv-count">已认 <b>'+dm+'</b> / '+total+' · 待再认 <b>'+(session.again||0)+'</b></span></div>';
  }
  function cardTag(c){
    if(session.rechecked&&session.rechecked[c.key]) return '<span class="lv-tag re">再确认</span>';
    const known=!!((window.REC&&REC.vocab&&REC.vocab[c.key])||(session.phase==='review'));
    return '<span class="lv-tag'+(known?' re':'')+'">'+(known?'复习':'新词')+'</span>';
  }
  function speakBtn(){ return '<button class="lv-speak" id="lv-speak" type="button" aria-label="播放发音"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6.5 8.5H3v7h3.5L11 19Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8.5 8.5 0 0 1 0 12"/></svg></button>'; }
  function metaRow(c){ return '<div class="lv-meta">'+cardTag(c)+'<span>第 '+c.group+' 组 · '+esc(c.groupLabel)+'</span></div>'; }

  function front(c){
    if(confirming){
      return '<div class="lv-card">'+metaRow(c)
        + '<div class="lv-wordrow"><span class="lv-word">'+esc(c.word)+'</span>'+speakBtn()+'</div>'
        + '<div class="lv-ipa">'+esc(c.ipa||'')+'</div>'
        + '<div class="lv-sect"><div class="lv-label">你想起的意思对吗？</div><div class="lv-def">'+esc(c.def)+'</div></div>'
        + '<div class="lv-choices"><button class="lv-btn" type="button" data-lv="wrong">其实记错了</button>'
        + '<button class="lv-btn pri" type="button" data-lv="proceed">记对了 · 继续</button></div>'
        + '<div class="lv-cfbar"><i></i></div>'
        + (err?'<p class="lv-err" role="alert">'+esc(err)+'</p>':'')+'</div>';
    }
    return '<div class="lv-card">'+metaRow(c)
      + '<div class="lv-wordrow"><span class="lv-word">'+esc(c.word)+'</span>'+speakBtn()+'</div>'
      + '<div class="lv-ipa">'+esc(c.ipa||'')+'</div>'
      + '<div class="lv-choices"><button class="lv-btn pri" type="button" data-lv="know"'+(busy?' disabled':'')+'>认识 <span class="lv-kbd">1</span></button>'
      + '<button class="lv-btn" type="button" data-lv="again"'+(busy?' disabled':'')+'>不认识 <span class="lv-kbd">2</span></button></div>'
      + '<p class="lv-hint">认识＝不看提示能想起意思 · 只有眼熟请点不认识</p>'
      + (busy?'<p class="lv-hint" role="status">保存中…</p>':'')
      + (err?'<p class="lv-err" role="alert">'+esc(err)+'</p>':'')+'</div>';
  }

  function detail(c){
    const note=c.note
      ? '<div class="lv-note"><div class="nl">老师怎么讲 · 课堂整理</div><p>'+esc(c.note)+'</p></div>'
      : '<p class="lv-empty">本词没有单独整理老师提示，看基本义即可。</p>';
    const hasRoot=!!(c.rootLabel||c.rootExplain);
    const uniBox=uni&&hasRoot?'<div class="lv-uni">'
      + '<div class="uhead"><span>词根宇宙</span><span>'+esc(c.relationKind==='classroom'?'课堂关联':'课堂投影的同族关系')+'</span></div>'
      + (c.rootLabel?'<div class="rootline"><b>'+esc(c.rootLabel)+'</b>　'+esc(c.rootMeaning||'')+'</div>':'')
      + (c.rootExplain?'<div class="explain">'+esc(c.rootExplain)+'</div>':'')
      + ((c.neighbors||[]).length?'<div class="chips">'+c.neighbors.map(x=>'<span>'+esc(x)+'</span>').join('')+'</div>':'')
      + (c.rootOrigin?'<div class="mini">来源记录：'+esc(c.rootOrigin)+'</div>':'')
      + '<div class="mini">课堂学习投影，关系标签不等于独立词源核验。</div></div>':'';
    const uniBtn=hasRoot?'<div class="lv-row"><button class="lv-ghost" type="button" data-lv="uni">'+(uni?'收起词根宇宙':'打开词根宇宙')+'</button>'
      +(c.rootLabel?'<span class="lv-meta">'+esc(c.rootLabel)+'</span>':'')+'</div>'+uniBox
      :'<p class="lv-empty">本词暂未挂接词根关系。</p>';
    const ex=c.example?'<details class="lv-ex"><summary>例句</summary><p>'+esc(c.example)+'</p>'+(c.exampleZh?'<p class="zh">'+esc(c.exampleZh)+'</p>':'')+'</details>':'';
    return '<div class="lv-card">'
      + '<div class="lv-meta"><span class="lv-tag re">'+(session.rechecked&&session.rechecked[c.key]?'再确认':'学习中')+'</span><span>第 '+c.group+' 组 · '+esc(c.groupLabel)+'</span></div>'
      + '<div class="lv-wordrow"><span class="lv-word">'+esc(c.word)+'</span>'+speakBtn()+'</div>'
      + '<div class="lv-ipa">'+esc(c.ipa||'')+'</div>'
      + '<div class="lv-sect"><div class="lv-label">基本义</div><div class="lv-def">'+esc(c.def)+'</div></div>'
      + '<div class="lv-sect">'+note+'</div><div class="lv-sect">'+uniBtn+'</div>'+ex
      + '<button class="lv-continue" type="button" data-lv="continue"'+(busy?' disabled':'')+'>继续 · 稍后再认一次 <span class="lv-kbd">Enter</span></button>'
      + (busy?'<p class="lv-hint" role="status">保存中…</p>':'')
      + (err?'<p class="lv-err" role="alert">'+esc(err)+'</p>':'')+'</div>';
  }

  /* 词根族回忆：只在复习完成页；只列本轮涉及的族；展开可核对词义 */
  function recallPanel(){
    const list=cards(); if(!list||!session||session.phase!=='review') return '';
    const involved=new Set(session.order||Object.keys(session.done||{}));
    const groups=new Map();
    for(const c of list){
      if(!involved.has(c.key)) continue;
      const g=Number(c.group)||0;
      if(!groups.has(g)) groups.set(g,{label:c.groupLabel||('第'+g+'组'),root:c.rootLabel||'',words:[]});
      groups.get(g).words.push(c);
    }
    if(!groups.size) return '';
    let h='<div class="lv-recall"><div class="lv-label">本轮词根族回忆</div>'
      +'<p class="lv-empty">先看词根，回想这一族里有哪几个词、各是什么意思，再展开核对。</p>';
    for(const [g,info] of [...groups].sort((a,b)=>a[0]-b[0])){
      h+='<details class="lv-rg"><summary>'+esc(info.label)+(info.root?(' · '+esc(info.root)):'')+'</summary>'
        +info.words.map(x=>'<div class="lv-rgw"><b>'+esc(x.word)+'</b> · '+esc(x.def)+'</div>').join('')+'</details>';
    }
    return h+'</div>';
  }

  function done(){
    if(!doneShown){ doneShown=true; settleTime(); }
    const s=session, total=s.total||0, first=s.summary&&s.summary.first||0, later=s.summary&&s.summary.later||0;
    const review=s.phase==='review';
    const base=s.nextDueAt||(now()+3*864e5), d=new Date(base);
    const due=(d.getMonth()+1)+' 月 '+d.getDate()+' 日';
    const overdue=base<now();
    const dueLine=overdue?'这批词的复习时间已到 · 背单词页会出现它们。'
      :(review?'最近的到期日在 <b>'+due+'</b> · 届时仍先只见英文，想不起来再看卡。':'新认的词约 <b>'+due+'</b> 到期 · 到期时仍先只见英文，想不起来再看卡。');
    const remainDue=(reviewInfo&&reviewInfo.due)||0;
    return '<div class="lv-card lv-done">'
      + '<div class="ok">✓</div><h3>'+(review?'本轮复习完成':'本课认读完成')+'</h3>'
      + '<p class="lead">'+(review?'这轮到期的词都过了一遍。':'本课 '+total+' 个词都在只看英文时点过认识。')+'</p>'
      + '<div class="lv-stats"><div><span>全词</span><b>'+total+'</b></div>'
      + '<div><span>直接认出</span><b>'+first+'</b></div>'
      + '<div><span>看卡后认出</span><b>'+later+'</b></div></div>'
      + recallPanel()
      + '<p class="lv-due">'+dueLine+((reviewInfo&&reviewInfo.tomorrow)?' · 明天还有 <b>'+reviewInfo.tomorrow+'</b> 词到期':'')+'</p>'
      + '<div class="lv-row">'
      + (remainDue>0?'<button class="lv-btn pri" type="button" data-lv="next-review"'+(busy?' disabled':'')+'>继续再认（还剩 '+remainDue+' 词）</button>':'')
      + (review?'':'<button class="lv-ghost" type="button" data-lv="restart"'+(busy?' disabled':'')+'>再练一遍</button>')
      + '<button class="lv-ghost" type="button" data-lv="back">返回背单词</button></div>'
      + (busy?'<p class="lv-hint" role="status">保存中…</p>':'')
      + (err?'<p class="lv-err" role="alert">'+esc(err)+'</p>':'')+'</div>';
  }

  /* 分段：按词根组边界切三段 */
  function segBounds(){
    const list=cards(); if(!list||!list.length) return [60,120];
    const order=[]; const seen=new Set();
    for(const c of list){ const g=Number(c.group)||0; if(!seen.has(g)){seen.add(g);order.push(g);} }
    const size=g=>list.filter(c=>(Number(c.group)||0)===g).length;
    const total=list.length, targets=[total/3,total*2/3], bounds=[]; let cum=0, gi=0;
    for(const t of targets){
      while(gi<order.length&&cum<t){ cum+=size(order[gi]); gi++; }
      bounds.push(cum);
    }
    return [Math.max(1,bounds[0]),Math.max(bounds[0]+1,Math.min(total,bounds[1]))];
  }
  function segDue(){
    if(!session||session.completedAt||session.front===1||session.phase==='review') return 0;
    const [b1,b2]=segBounds(); const dm=session.doneCount||0;
    let seg=0;
    if(dm>=b2&&dm<(session.total||0)) seg=2; else if(dm>=b1&&dm<b2) seg=1;
    if(!seg) return 0;
    try{ if(localStorage.getItem('tfl-lv-seg:'+session.roundId+':'+seg)) return 0; }catch(e){}
    return seg;
  }
  function breakCard(seg){
    return '<div class="lv-card lv-break">'
      + '<div class="lv-label">第 '+(seg+1)+' / 3 段</div><h3>这一段过完了</h3>'
      + '<p class="lv-empty">已认 '+(session.doneCount||0)+' / '+(session.total||0)+' 词。可以继续下一段，也可以今天先到这里——进度已保存。</p>'
      + '<div class="lv-choices"><button class="lv-btn" type="button" data-lv="seg-exit">今天先到这里</button>'
      + '<button class="lv-btn pri" type="button" data-lv="seg-continue">继续下一段</button></div></div>';
  }

  function render(){
    const body=q('vb-body');
    if(!body||!active||!document.querySelector('#v-vocab.on')) return;
    const ct=q('vb-ct'); if(ct&&lesson) ct.textContent=(lesson.title||lessonId)+' · '+(session?(session.doneCount||0):0)+' / '+(lesson.total||0);
    if(!session){ body.innerHTML=shell('<div class="lv-loading">正在读取课程进度…</div>'); wire(); return; }
    if(session.completedAt){ body.innerHTML=shell(done()); wire(); return; }
    const seg=segDue();
    if(seg){ body.innerHTML=shell(breakCard(seg)); wire(); return; }
    const c=byKey.get(session.current);
    if(!c){ body.innerHTML=shell('<div class="lv-loading">词卡数据缺少当前词，请重试。</div>'); wire(); return; }
    body.innerHTML=shell(session.front===1?detail(c):front(c));
    wire();
  }

  function wire(){
    const exit=q('lv-exit'); if(exit) exit.onclick=()=>{ leave(); location.hash='#/vocab'; };
    const sp=q('lv-speak'); if(sp) sp.onclick=()=>speak(byKey.get(session&&session.current));
    q('vb-body')?.querySelectorAll('[data-lv]').forEach(b=>{
      const act=b.getAttribute('data-lv');
      b.onclick=()=>{
        if(act==='uni'){ uni=!uni; render(); }
        else if(act==='back'){ leave(); location.hash='#/vocab'; }
        else if(act==='restart'){ if(!busy) restart(); }
        else if(act==='next-review'){ if(!busy) nextReview(); }
        else if(act==='know'){ if(!busy&&!confirming) startConfirm(); }
        else if(act==='proceed'){ if(confirming) proceed(); }
        else if(act==='wrong'){ if(confirming) markWrong(); }
        else if(act==='seg-continue'){ try{localStorage.setItem('tfl-lv-seg:'+session.roundId+':'+segDue(),'1');}catch(e){} render(); }
        else if(act==='seg-exit'){ leave(); location.hash='#/vocab'; }
        else if(act==='again'||act==='continue'){ if(!busy) grade(act); }
      };
    });
  }

  function startConfirm(){
    if(!session||!session.current) return;
    confirming=true; err=''; render();
    if(confirmTimer) clearTimeout(confirmTimer);
    const cur=session.current;
    const auto=session.phase!=='review'&&!(session.rechecked&&session.rechecked[cur]);
    if(auto) confirmTimer=setTimeout(()=>{ if(confirming&&active){ confirming=false; grade('know'); } },CONFIRM_MS);
  }
  function proceed(){ if(!confirming) return; if(confirmTimer){clearTimeout(confirmTimer);confirmTimer=null;} confirming=false; grade('know'); }
  function markWrong(){ if(!confirming) return; if(confirmTimer){clearTimeout(confirmTimer);confirmTimer=null;} confirming=false; grade('again'); }

  function applyMeta(res){
    if(!res) return;
    if(res.lesson) lesson=res.lesson;
    if(res.review) reviewInfo=res.review;
    if(res.hardWords) hardWords=res.hardWords;
    if(res.slot) slot=res.slot;
    else if(res.session&&res.session.phase) slot=res.session.phase==='review'?'review':'first';
  }

  async function resync(){
    try{
      const r=await api('/api/vocab/lesson?id='+encodeURIComponent(lessonId),{signal:AbortSignal.timeout(10000)});
      if(r.lesson) lesson=r.lesson;
      if(r.review) reviewInfo=r.review;
      if(r.hardWords) hardWords=r.hardWords;
      const pick=slot==='review'?r.reviewSession:r.session;
      if(pick) session=pick;
      return true;
    }catch(e){ return false; }
  }

  function mergeVocabAck(key,res){
    try{
      if(res.st&&window.REC){
        REC.vocab=REC.vocab||{};
        const newer=(typeof vbNewer==='function')?vbNewer(res.st,REC.vocab[key]):true;
        if(newer) REC.vocab[key]=res.st;
        if(typeof VB_ACK!=='undefined'&&VB_ACK) VB_ACK[key]=res.st;
      }
      if(res.vocabDays&&window.REC) REC.vocabDays=res.vocabDays;
    }catch(e){}
  }

  async function grade(action){
    if(!session||!session.current) return;
    const t=token, key=session.current;
    if(!pending||pending.key!==key||pending.action!==action||pending.slot!==slot) pending={id:eventId(),key,action,slot};
    const id=pending.id;
    busy=true; err=''; render();
    try{
      const res=await api('/api/vocab/lesson/grade',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({lessonId,slot,id,key,action}),signal:AbortSignal.timeout(15000)});
      if(t!==token) return;
      session=res.session; pending=null; uni=false; applyMeta(res); mergeVocabAck(key,res);
    }catch(e){
      if(t!==token) return;
      const msg=(e&&e.message)||'保存失败，请重试';
      const ok=await resync(); if(t!==token) return;
      const cur=session&&session.current;
      const applied=cur!==key || (action==='again'&&cur===key&&session.front===1);
      if(ok&&applied){ pending=null; err=''; } else err=msg;
    }
    finally{ if(t===token){ busy=false; render(); } }
  }

  async function nextReview(){
    const t=token; busy=true; err=''; render();
    try{
      const res=await api('/api/vocab/lesson/start',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({lessonId}),signal:AbortSignal.timeout(15000)});
      if(t!==token) return;
      session=res.session; applyMeta(res); pending=null; uni=false; doneShown=false;
    }catch(e){ if(t===token) err=(e&&e.message)||'无法开始下一轮'; }
    finally{ if(t===token){ busy=false; render(); } }
  }

  async function restart(){
    const t=token; busy=true; err=''; confirming=false;
    if(confirmTimer){clearTimeout(confirmTimer);confirmTimer=null;}
    render();
    try{
      const res=await api('/api/vocab/lesson/start',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({lessonId,restart:true}),signal:AbortSignal.timeout(15000)});
      if(t!==token) return;
      session=res.session; applyMeta(res); uni=false; pending=null; doneShown=false;
    }catch(e){
      if(t!==token) return;
      const ok=await resync(); if(t!==token) return;
      err=ok?'':((e&&e.message)||'无法重新开始');
    }
    finally{ if(t===token){ busy=false; render(); } }
  }

  async function open(id){
    const t=++token; active=true; busy=false; uni=false; err=''; session=null; pending=null;
    confirming=false; if(confirmTimer){clearTimeout(confirmTimer);confirmTimer=null;}
    doneShown=false; slot='first';
    if(id) lessonId=id;
    try{window.vbSuspendForLesson&&vbSuspendForLesson();}catch(e){}
    timeMark=Date.now();
    document.addEventListener('visibilitychange',onVis);
    q('lv-entry')?.setAttribute('hidden','');
    const body=q('vb-body');
    if(body) body.innerHTML='<div class="lv-loading">正在读取课程词卡…</div>';
    try{
      if(!cardsByLesson.has(lessonId)){
        const data=await api('/api/vocab/lesson/cards?id='+encodeURIComponent(lessonId),{signal:AbortSignal.timeout(20000)});
        if(t!==token) return;
        cardsByLesson.set(lessonId,data.cards||[]);
        lesson={title:data.title,total:data.total,noted:data.noted};
      }
      byKey.clear(); for(const c of (cards()||[])) byKey.set(c.key,c);
      const st=await api('/api/vocab/lesson/start',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({lessonId}),signal:AbortSignal.timeout(15000)});
      if(t!==token) return;
      lesson=st.lesson||lesson; session=st.session; applyMeta(st);
      render();
    }catch(e){
      if(t!==token) return;
      if(body) body.innerHTML='<div class="lv-loading" role="status">'+esc((e&&e.message)||'课程词卡读取失败')+'<br><button class="lv-ghost" id="lv-retry" style="margin-top:12px">重试</button></div>';
      const r=q('lv-retry'); if(r) r.onclick=()=>open(id);
    }
  }

  function leave(){
    active=false; token++; settleTime();
    confirming=false; if(confirmTimer){clearTimeout(confirmTimer);confirmTimer=null;}
    stopAudio();
    document.removeEventListener('visibilitychange',onVis);
    q('lv-entry')?.removeAttribute('hidden');
    const ct=q('vb-ct'); if(ct) ct.textContent='';
    try{ window.loadLVLessons&&loadLVLessons(true); }catch(e){}   // 横幅/徽标强制刷新（R3.2-3）
  }

  document.addEventListener('keydown',function(e){
    if(!active) return;
    if(e.target&&/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if(confirming){
      if(e.key==='1'||e.key==='Enter'){ e.preventDefault(); proceed(); }
      else if(e.key==='2'||e.key==='Escape'){ e.preventDefault(); markWrong(); }
      return;
    }
    if(!session||session.completedAt) return;
    if(session.front===1){
      if(e.key==='Enter'||e.key==='1'){ e.preventDefault(); const b=document.querySelector('[data-lv="continue"]'); if(b&&!busy) b.click(); }
      return;
    }
    if(e.key==='1'){ e.preventDefault(); const b=document.querySelector('[data-lv="know"]'); if(b&&!busy&&!confirming) b.click(); }
    else if(e.key==='2'){ e.preventDefault(); const b=document.querySelector('[data-lv="again"]'); if(b&&!busy) b.click(); }
  });

  window.LV={open,leave,isActive:()=>active};
})();
