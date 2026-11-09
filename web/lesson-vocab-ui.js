/* 第一课课程认读界面。数据与服务端会话来自 /api/vocab/lesson*，不写 localStorage 进度。 */
(function(){
  const LESSON='cfcm-01-01';
  const q=id=>document.getElementById(id);
  let token=0, active=false, cards=null, lesson=null, session=null, busy=false, uni=false, err='', audio=null, pending=null;
  const byKey=new Map();

  const eventId=()=>'lv-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
  const now=()=>Date.now();

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

  function shell(inner){
    return '<div class="lv-wrap">'
      + '<div class="lv-head"><div><h3>'+(lesson?esc(lesson.title):'第01课')+'</h3>'
      + '<div class="meta">本课 <b>'+(lesson?lesson.total:176)+'</b> 词 · 已整理 <b>'+(lesson?lesson.noted:138)+'</b> 条老师讲解</div></div>'
      + '<button class="lv-exit" id="lv-exit">返回背单词</button></div>'
      + progress()
      + inner + '</div>';
  }

  function progress(){
    if(!session) return '';
    const done=session.doneCount||0, total=session.total||1;
    const again=session.again||0;
    return '<div class="lv-progress"><div class="lv-track"><i style="width:'+Math.round(done/total*100)+'%"></i></div>'
      + '<span class="lv-count">已认 <b>'+done+'</b> / '+total+' · 待再认 <b>'+again+'</b></span></div>';
  }

  function front(c){
    const re=session.front===1;
    return '<div class="lv-card">'
      + '<div class="lv-meta"><span class="lv-tag'+(re?' re':'')+'">'+(re?'再认一次':'新词')+'</span>'
      + '<span>第 '+c.group+' 组 · '+esc(c.groupLabel)+'</span></div>'
      + '<div class="lv-wordrow"><span class="lv-word">'+esc(c.word)+'</span>'
      + '<button class="lv-speak" id="lv-speak" type="button" aria-label="播放发音"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6.5 8.5H3v7h3.5L11 19Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8.5 8.5 0 0 1 0 12"/></svg></button></div>'
      + '<div class="lv-ipa">'+esc(c.ipa||'')+'</div>'
      + '<div class="lv-choices">'
      + '<button class="lv-btn pri" type="button" data-lv="know"'+(busy?' disabled':'')+'>认识</button>'
      + '<button class="lv-btn" type="button" data-lv="again"'+(busy?' disabled':'')+'>不认识</button></div>'
      + '<p class="lv-hint">认识＝不看提示能想起意思 · 只有眼熟请点不认识</p>'
      + (busy?'<p class="lv-hint" role="status">保存中…</p>':'')
      + (err?'<p class="lv-err" role="alert">'+esc(err)+'</p>':'')
      + '</div>';
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
    const ex=c.example
      ? '<details class="lv-ex"><summary>例句</summary><p>'+esc(c.example)+'</p>'+(c.exampleZh?'<p class="zh">'+esc(c.exampleZh)+'</p>':'')+'</details>':'';
    return '<div class="lv-card">'
      + '<div class="lv-meta"><span class="lv-tag re">学习中</span><span>第 '+c.group+' 组 · '+esc(c.groupLabel)+'</span></div>'
      + '<div class="lv-wordrow"><span class="lv-word">'+esc(c.word)+'</span>'
      + '<button class="lv-speak" id="lv-speak" type="button" aria-label="播放发音"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6.5 8.5H3v7h3.5L11 19Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8.5 8.5 0 0 1 0 12"/></svg></button></div>'
      + '<div class="lv-ipa">'+esc(c.ipa||'')+'</div>'
      + '<div class="lv-sect"><div class="lv-label">基本义</div><div class="lv-def">'+esc(c.def)+'</div></div>'
      + '<div class="lv-sect">'+note+'</div>'
      + '<div class="lv-sect">'+uniBtn+'</div>'
      + ex
      + '<button class="lv-continue" type="button" data-lv="continue"'+(busy?' disabled':'')+'>继续 · 稍后再认一次</button>'
      + (busy?'<p class="lv-hint" role="status">保存中…</p>':'')
      + (err?'<p class="lv-err" role="alert">'+esc(err)+'</p>':'')
      + '</div>';
  }

  function done(){
    const s=session, total=s.total||0, first=s.summary?.first||0, later=s.summary?.later||0;
    const base=s.completedAt||now(), d=new Date(base+3*864e5);
    const due=(d.getMonth()+1)+' 月 '+d.getDate()+' 日';
    const overdue=d.getTime()<now();
    return '<div class="lv-card lv-done">'
      + '<div class="ok">✓</div><h3>本课认读完成</h3>'
      + '<p class="lead">本课 '+total+' 个词都在只看英文时点过认识。</p>'
      + '<div class="lv-stats"><div><span>全词</span><b>'+total+'</b></div>'
      + '<div><span>首次就认出</span><b>'+first+'</b></div>'
      + '<div><span>看卡后认出</span><b>'+later+'</b></div></div>'
      + '<p class="lv-due">'+(overdue?'新认的词已在 <b>'+due+'</b> 到期 · 到背单词里复习即可。':'新认的词约 <b>'+due+'</b> 到期 · 到期时仍先只见英文，想不起来再看卡。')+'</p>'
      + '<div class="lv-row"><button class="lv-ghost" type="button" data-lv="restart"'+(busy?' disabled':'')+'>再练一遍</button>'
      + '<button class="lv-ghost" type="button" data-lv="back">返回背单词</button></div>'
      + (busy?'<p class="lv-hint" role="status">保存中…</p>':'')
      + (err?'<p class="lv-err" role="alert">'+esc(err)+'</p>':'')+'</div>';
  }

  function render(){
    const body=q('vb-body');
    if(!body||!active||!document.querySelector('#v-vocab.on')) return;
    const ct=q('vb-ct'); if(ct&&lesson) ct.textContent='第01课 · '+(session?(session.doneCount||0):0)+' / '+(lesson.total||176);
    if(!session){ body.innerHTML=shell('<div class="lv-loading">正在读取课级进度…</div>'); return; }
    if(session.completedAt){ body.innerHTML=shell(done()); wire(); return; }
    const c=byKey.get(session.current);
    if(!c){ body.innerHTML=shell('<div class="lv-loading">词卡数据缺少当前词，请重试。</div>'); wire(); return; }
    body.innerHTML=shell(session.front===1?detail(c):front(c));
    wire();
  }

  function wire(){
    const exit=q('lv-exit'); if(exit) exit.onclick=()=>{ leave(); location.hash='#/vocab'; };
    const sp=q('lv-speak'); if(sp) sp.onclick=()=>speak(byKey.get(session?.current));
    q('vb-body')?.querySelectorAll('[data-lv]').forEach(b=>{
      const act=b.getAttribute('data-lv');
      b.onclick=()=>{
        if(act==='uni'){ uni=!uni; render(); }
        else if(act==='back'){ leave(); location.hash='#/vocab'; }
        else if(act==='restart'){ if(!busy) restart(); }
        else if(['know','again','continue'].includes(act)){ if(!busy) grade(act); }
      };
    });
  }

  async function resync(){
    try{
      const r=await api('/api/vocab/lesson',{signal:AbortSignal.timeout(10000)});
      if(r.session){ session=r.session; lesson=r.lesson||lesson; uni=false; err=''; }
    }catch(e){}
  }
  async function grade(action){
    if(!session||!session.current) return;
    const t=token, key=session.current;
    if(!pending||pending.key!==key||pending.action!==action) pending={id:eventId(),key,action};
    const id=pending.id;
    busy=true; err='';
    render();
    try{
      const res=await api('/api/vocab/lesson/grade',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({lessonId:LESSON,id,key,action}),signal:AbortSignal.timeout(15000)});
      if(t!==token) return;
      session=res.session; pending=null; uni=false;
    }catch(e){
      if(t!==token) return;
      const msg=e.message||'保存失败，请重试';
      if(/not current word|already completed|lesson not started/.test(msg)){ await resync(); if(t!==token) return; pending=null; }
      else err=msg;
    }
    finally{ if(t===token){ busy=false; render(); } }
  }

  async function restart(){
    const t=token; busy=true; err=''; render();
    try{
      const res=await api('/api/vocab/lesson/start',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({lessonId:LESSON,restart:true})});
      if(t!==token) return;
      session=res.session; lesson=res.lesson||lesson; uni=false;
    }catch(e){ if(t===token) err=e.message||'无法重新开始'; }
    finally{ if(t===token){ busy=false; render(); } }
  }

  async function open(id){
    const t=++token; active=true; busy=false; uni=false; err=''; session=null; pending=null;
    try{window.vbSuspendForLesson&&vbSuspendForLesson();}catch(e){}
    q('lv-entry')?.setAttribute('hidden','');
    const body=q('vb-body');
    if(body) body.innerHTML='<div class="lv-loading">正在读取第一课词卡…</div>';
    try{
      if(!cards){
        const data=await api('/api/vocab/lesson/cards',{signal:AbortSignal.timeout(20000)});
        if(t!==token) return;
        cards=data.cards; byKey.clear(); cards.forEach(c=>byKey.set(c.key,c));
        lesson={title:data.title,total:data.total,noted:data.noted};
      }
      const meta=await api('/api/vocab/lesson',{signal:AbortSignal.timeout(10000)});
      if(t!==token) return;
      lesson=meta.lesson||lesson; session=meta.session;
      if(!session){
        const st=await api('/api/vocab/lesson/start',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({lessonId:id||LESSON})});
        if(t!==token) return;
        session=st.session; lesson=st.lesson||lesson;
      }
      render();
    }catch(e){
      if(t!==token) return;
      if(body) body.innerHTML='<div class="lv-loading" role="status">'+esc(e.message||'第一课词卡读取失败')+'<br><button class="lv-ghost" id="lv-retry" style="margin-top:12px">重试</button></div>';
      const r=q('lv-retry'); if(r) r.onclick=()=>open(id);
    }
  }

  function leave(){
    active=false; token++; stopAudio();
    q('lv-entry')?.removeAttribute('hidden');
    const ct=q('vb-ct'); if(ct) ct.textContent='';
  }

  window.LV={open,leave,isActive:()=>active};
})();
