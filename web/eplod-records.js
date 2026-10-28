(function(root){
  'use strict';
  const copy=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
  const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
  /* 判分归一分词(r19): 官方文本的 "5:58" 分词成 [5,58], ASR/用户输入是 [five,fifty,eight],
     形状不同会白扣分——数字 token 统一展开成读法单词; oh 与 zero 互通(两侧同变换, 只增匹配不改错配)。 */
  const NUM1={0:'zero',1:'one',2:'two',3:'three',4:'four',5:'five',6:'six',7:'seven',8:'eight',9:'nine',10:'ten',11:'eleven',12:'twelve',13:'thirteen',14:'fourteen',15:'fifteen',16:'sixteen',17:'seventeen',18:'eighteen',19:'nineteen'};
  const NUM10={2:'twenty',3:'thirty',4:'forty',5:'fifty',6:'sixty',7:'seventy',8:'eighty',9:'ninety'};
  function expandNum(v,out){
    if(v<=20)out.push(NUM1[v]||String(v));
    else if(v<100){out.push(NUM10[Math.floor(v/10)]);if(v%10)out.push(NUM1[v%10]);}
    else if(v<1000){out.push(NUM1[Math.floor(v/100)],'hundred');if(v%100)expandNum(v%100,out);}
    else{out.push(NUM1[Math.floor(v/1000)],'thousand');if(v%1000)expandNum(v%1000,out);}
  }
  function normTokens(s){
    const out=[];
    for(let w of (String(s).toLowerCase().match(/[a-z0-9']+/g)||[])){
      if(w==='okay'){out.push('ok');continue;}
      if(/^\d+$/.test(w)){expandNum(parseInt(w,10),out);continue;}
      out.push(w==='oh'?'zero':w);
    }
    return out;
  }
  function lcsAcc(official,mine){
    const a=normTokens(official),b=normTokens(mine);
    if(!a.length)return 0;
    const dp=Array(b.length+1).fill(0);
    for(const w of a){let prev=0;for(let j=1;j<=b.length;j++){const old=dp[j];dp[j]=w===b[j-1]?prev+1:Math.max(dp[j],dp[j-1]);prev=old;}}
    return dp[b.length]/a.length;
  }
  const time=value=>Number.isFinite(Number(value))?Number(value):0;
  const identity=value=>typeof value==='string'?value:'';
  // A result's identity belongs to the attempt, never to an ASR/archive response's arrival time.
  function compareResult(a,b){
    const delta=time(a?.at)-time(b?.at);
    if(delta)return delta;
    const x=identity(a?.id),y=identity(b?.id);
    return x===y?0:x>y?1:-1;
  }
  function newest(a,b){
    if(!a)return b?copy(b):null;
    if(!b)return copy(a);
    const order=compareResult(a,b);
    return order===0?{...copy(a),...copy(b)}:copy(order>0?a:b);
  }
  function latestResult(value){
    if(object(value.latest))return copy(value.latest);
    if(typeof value.last!=='string')return null;
    const result={id:identity(value.id),at:time(value.at),mode:value.mode||'type',text:value.last,
      acc:Number.isFinite(value.lastAcc)?value.lastAcc:value.mode==='voice'?undefined:value.acc};
    for(const key of ['dur','speed'])if(Object.hasOwn(value,key))result[key]=copy(value[key]);
    return result;
  }
  function modeResult(value,latest,mode){
    const saved=value[mode==='type'?'typed':mode];
    return newest(object(saved)?saved:null,latest?.mode===mode?latest:null);
  }
  function voiceResult(value,latest){return modeResult(value,latest,'voice');}
  function recordingResult(value){
    return value.rec?{rec:value.rec,at:time(value.recAt??value.at),id:identity(value.recAttemptId)}:null;
  }
  function mergeAttempt(current,incoming){
    const a=object(current)?current:{},b=object(incoming)?incoming:{};
    const al=latestResult(a),bl=latestResult(b),latest=newest(al,bl);
    const voice=newest(voiceResult(a,al),voiceResult(b,bl));
    const typed=newest(modeResult(a,al,'type'),modeResult(b,bl,'type'));
    const out=compareResult(al||a,bl||b)>0?{...copy(b),...copy(a)}:{...copy(a),...copy(b)};
    const scores=[a.acc,b.acc,al?.acc,bl?.acc,voice?.acc].filter(Number.isFinite);
    if(scores.length)out.acc=Math.max(...scores);
    if(latest){
      out.latest=latest;
      out.at=latest.at;out.last=latest.text;out.mode=latest.mode;out.lastAcc=latest.acc;
      // Do not display a previous voice attempt's duration on a newer typed attempt.
      for(const key of ['dur','speed']){
        if(Object.hasOwn(latest,key))out[key]=copy(latest[key]);
        else delete out[key];
      }
    }
    if(voice)out.voice=voice;
    if(typed)out.typed=typed;
    const rec=newest(recordingResult(a),recordingResult(b));
    if(rec){
      out.rec=rec.rec;out.recAt=rec.at;
      if(rec.id)out.recAttemptId=rec.id;
      else delete out.recAttemptId;
    }
    return out;
  }
  function saveAttempt(prev,attempt){
    if(!object(attempt))return mergeAttempt(prev,{});
    const result={id:identity(attempt.id),at:time(attempt.at),mode:attempt.mode||'type',
      text:String(attempt.text??''),acc:attempt.acc};
    for(const key of ['dur','speed'])if(Object.hasOwn(attempt,key))result[key]=copy(attempt[key]);
    return mergeAttempt(prev,{acc:result.acc,latest:result});
  }
  function legacySpeedEvidence(value,reading,source){
    if(!object(value)||value.verified===false||!Number.isFinite(value.dur)||value.dur<=0||!object(reading))return null;
    const voice=voiceResult(reading,latestResult(reading));
    if(!voice||voice.mode!=='voice'||typeof voice.text!=='string'||!voice.text.trim()||
       !Number.isFinite(voice.dur)||voice.dur!==value.dur)return null;
    if(value.id){if(identity(value.id)!==identity(voice.id))return null;}
    else {
      // Old clients stamped rd and sd separately after ASR, usually a millisecond apart.
      const delta=time(value.at)-time(voice.at);
      if(time(value.at)<=0||time(voice.at)<=0||delta<0||delta>1000)return null;
    }
    const sourceDur=object(source)&&Number.isFinite(source.t0)&&Number.isFinite(source.t1)?source.t1-source.t0:0;
    if(sourceDur<=0||typeof source.text!=='string'||!source.text.trim())return null;
    const acc=lcsAcc(source.text,voice.text);
    return acc>=.9&&value.dur<=sourceDur*1.15+.5?{acc,sourceDur}:null;
  }
  function speedPassed(value,reading,source){
    if(!object(value)||!Number.isFinite(value.dur)||value.dur<=0)return false;
    // Modern speed evidence carries its own content score; historical best never qualifies it.
    if(['acc','sourceDur','verified'].some(key=>Object.hasOwn(value,key))){
      return value.verified!==false&&Number.isFinite(value.acc)&&value.acc>=.9&&
        Number.isFinite(value.sourceDur)&&value.sourceDur>0&&value.dur<=value.sourceDur*1.15+.5;
    }
    return !!legacySpeedEvidence(value,reading,source);
  }
  function repairSpeedScores(records,loadDialogue){
    let changed=0;
    for(const [id,lesson] of Object.entries(records.course||{})){
      if(!/^eplod-\d{4}$/.test(id))continue;
      const drill=lesson.drill||{};
      if(!Object.values(drill.sd||{}).some(value=>object(value)&&value.verified==null))continue;
      const dialogue=loadDialogue(id);
      for(const [i,value] of Object.entries(drill.sd||{})){
        if(!object(value)||value.verified!=null)continue;
        const evidence=legacySpeedEvidence(value,drill.rd?.[i],dialogue?.[i]);
        if(evidence){Object.assign(value,evidence,{verified:true});changed++;}
      }
    }
    return changed;
  }
  function mergeSpeed(current,incoming){
    const a=object(current)?current:{},b=object(incoming)?incoming:{};
    const newer=compareResult(a,b)<=0,winner=newer?b:a;
    const out=newer?{...copy(a),...copy(b)}:{...copy(b),...copy(a)};
    // A stale score/source duration must not become evidence for a different speed take.
    if(compareResult(a,b)!==0)for(const key of ['id','at','acc','dur','sourceDur','verified']){
      if(!Object.hasOwn(winner,key))delete out[key];
    }
    return out;
  }
  function mergeDrill(current,incoming){
    const a=object(current)?current:{},b=object(incoming)?incoming:{};
    const out={...copy(a),...copy(b)};
    for(const name of ['dd','rd','sd']){
      out[name]={...copy(a[name]||{})};
      for(const [i,v] of Object.entries(b[name]||{})){
        const old=out[name][i];
        if(!object(v))continue;
        // sd.acc describes that speed attempt, so never mix in another attempt's best score.
        out[name][i]=name==='sd'?mergeSpeed(old,v):mergeAttempt(old,v);
      }
    }
    out.playsS={...copy(a.playsS||{})};
    for(const [i,n] of Object.entries(b.playsS||{}))out.playsS[i]=Math.max(Number(out.playsS[i])||0,Number(n)||0);
    out.stampDays={};
    for(const day of new Set([...Object.keys(a.stampDays||{}),...Object.keys(b.stampDays||{})])){
      out.stampDays[day]=[...new Set([...(a.stampDays?.[day]||[]),...(b.stampDays?.[day]||[])].filter(i=>Number.isInteger(i)&&i>=0))].sort((x,y)=>x-y);
    }
    const recovered=[a.recoveredCover,b.recoveredCover].filter(object);
    if(recovered.length){
      out.recoveredCover={...recovered[0],sentences:[...new Set(recovered.flatMap(x=>x.sentences||[]))].sort((x,y)=>x-y)};
      out.recoveredCover.recognizedAt=Math.min(...recovered.map(x=>Number(x.recognizedAt)||Date.now()));
    }
    return out;
  }
  function coverProgress(drill,total,today){
    drill=object(drill)?drill:{};
    const need=total,days=drill.stampDays||{};   /* 一遍=当天过完全部句子(用户口径 2026-10-28) */
    const count=v=>Array.isArray(v)?new Set(v.filter(i=>Number.isInteger(i)&&i>=0&&i<total)).size:0;
    const dates=need>0?Object.keys(days).filter(day=>count(days[day])>=need).sort():[];
    const recovered=!!drill.recoveredCover;
    const completed=Math.min(3,dates.length+(recovered?1:0));
    return {total,need,dates,recovered,completed,todayN:count(days[today]),todayStamped:dates.includes(today)};
  }
  function mergeLesson(current,incoming){
    const a=current||{},b=incoming||{};
    return {...copy(a),...copy(b),drill:mergeDrill(a.drill,b.drill)};
  }
  function reconcile(target,source){
    if(target===source)return target;
    for(const k of Object.keys(target))if(!Object.prototype.hasOwnProperty.call(source,k))delete target[k];
    for(const [k,v] of Object.entries(source)){
      if(object(v)&&object(target[k]))reconcile(target[k],v);
      else target[k]=v==null?v:copy(v);
    }
    return target;
  }
  function repairOkayScores(records,loadDialogue){
    let changed=0;
    const tokens=normTokens;
    for(const [id,lesson] of Object.entries(records.course||{})){
      if(!/^eplod-\d{4}$/.test(id))continue;
      const drill=lesson.drill||{};
      const candidates=['dd','rd'].flatMap(kind=>Object.entries(drill[kind]||{}).map(([i,r])=>({i,r})));
      if(!candidates.some(({r})=>typeof r.last==='string'&&/\b(ok|okay)\b/i.test(r.last)))continue;
      const dialogue=loadDialogue(id);
      for(const {i,r} of candidates){
        const text=dialogue?.[i]?.text;
        if(!text||typeof r.last!=='string'||!Number.isFinite(r.acc)||!/\b(ok|okay)\b/i.test(text)||!/\b(ok|okay)\b/i.test(r.last))continue;
        const a=tokens(text),b=tokens(r.last),dp=Array(b.length+1).fill(0);
        for(const w of a){let prev=0;for(let j=1;j<=b.length;j++){const old=dp[j];dp[j]=w===b[j-1]?prev+1:Math.max(dp[j],dp[j-1]);prev=old;}}
        const acc=a.length?dp[b.length]/a.length:0;
        if(acc>r.acc){r.acc=acc;changed++;}
      }
    }
    return changed;
  }
  function repairNumberScores(records,loadDialogue){
    let changed=0;
    for(const [id,lesson] of Object.entries(records.course||{})){
      if(!/^eplod-\d{4}$/.test(id))continue;
      const drill=lesson.drill||{};
      const dialogue=loadDialogue(id);
      if(!dialogue||!dialogue.some(l=>l&&/\d/.test(l.text||'')))continue;
      for(const kind of ['dd','rd']){
        for(const [i,r] of Object.entries(drill[kind]||{})){
          const text=dialogue[+i]&&dialogue[+i].text;
          if(!text||typeof r.last!=='string'||!r.last.trim()||!Number.isFinite(r.acc))continue;
          const acc=lcsAcc(text,r.last);
          if(acc>r.acc+1e-9){r.acc=acc;changed++;}
        }
      }
    }
    return changed;
  }
  const api={mergeDrill,mergeLesson,reconcile,saveAttempt,speedPassed,repairSpeedScores,repairOkayScores,repairNumberScores,lcsAcc,normTokens,coverProgress};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.EplodRecords=api;
})(typeof globalThis==='object'?globalThis:this);
