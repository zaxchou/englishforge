(function(root){
  'use strict';
  const copy=x=>JSON.parse(JSON.stringify(x));
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
  function mergeDrill(current,incoming){
    const a=object(current)?current:{},b=object(incoming)?incoming:{};
    const out={...copy(a),...copy(b)};
    for(const name of ['dd','rd','sd']){
      out[name]={...copy(a[name]||{})};
      for(const [i,v] of Object.entries(b[name]||{})){
        const old=out[name][i];
        if(!object(v))continue;
        const newer=!old||Number(v.at||0)>=Number(old.at||0);
        const value=newer?{...old,...v}:{...v,...old};
        const scores=[old?.acc,v.acc].filter(Number.isFinite);
        if(scores.length)value.acc=Math.max(...scores);
        if(old?.rec&&!value.rec)value.rec=old.rec;
        out[name][i]=value;
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
  const api={mergeDrill,mergeLesson,reconcile,repairOkayScores,repairNumberScores,lcsAcc,normTokens,coverProgress};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.EplodRecords=api;
})(typeof globalThis==='object'?globalThis:this);
