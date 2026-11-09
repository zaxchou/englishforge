(function(root){
  'use strict';
  const copy=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
  const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
  const SCORING_VERSION=9;
  /* 判分归一分词(r19): 官方文本的 "5:58" 分词成 [5,58], ASR/用户输入是 [five,fifty,eight],
     形状不同会白扣分——数字 token 统一展开成读法单词; oh 与 zero 互通(两侧同变换, 只增匹配不改错配)。 */
  const NUM1={0:'zero',1:'one',2:'two',3:'three',4:'four',5:'five',6:'six',7:'seven',8:'eight',9:'nine',10:'ten',11:'eleven',12:'twelve',13:'thirteen',14:'fourteen',15:'fifteen',16:'sixteen',17:'seventeen',18:'eighteen',19:'nineteen',20:'twenty'};   /* 20 曾缺表, expandNum 兜底成 "20" 配不上 twenty(r2 2026-10-30) */
  const NUM10={2:'twenty',3:'thirty',4:'forty',5:'fifty',6:'sixty',7:'seventy',8:'eighty',9:'ninety'};
  function expandNum(v,out){
    if(v<=20)out.push(NUM1[v]||String(v));
    else if(v<100){out.push(NUM10[Math.floor(v/10)]);if(v%10)out.push(NUM1[v%10]);}
    else if(v<1000){out.push(NUM1[Math.floor(v/100)],'hundred');if(v%100)expandNum(v%100,out);}
    else{out.push(NUM1[Math.floor(v/1000)],'thousand');if(v%1000)expandNum(v%1000,out);}
  }
  /* 美英拼写互通(r20): 英式变体归一到美式, 与数字展开同一原则——两侧同变换, 只增匹配不改错配。
     变体只走白名单词根, 形近词(called/wise/surprise/hour 等)不是变体, 不动。 */
  const UKRULES=[
    [/^(cancel|travel|model|label|level|total|fuel|signal|marvel|dial|equal|rival|pedal|channel|counsel)l(ed|ing|ers?|ings?|ous)$/,'$1$2'],
    [/^(real|recogn|organ|apolog|character|standard|modern|special|social|minim|maxim|optim|summar|author|emphas|memor|categor|priorit|util|stabil|normal|formal|visual|custom|initial|final|hospital|familiar|central|critic)is(e|es|ed|ing|ation|ations)$/,'$1iz$2'],
    [/^analys(e|ed|ing)$/,'analyz$1'],
    [/^(col|fav|behavi|hon|neighb|hum|lab|arm|flav|rum|vap|harb)our(s|ed|ing|al|ite|ites|able|ful|ous|less|hood|hoods|ings)?$/,'$1or$2'],
    [/^(cent|met|theat|lit|fib|calib|lust|scept)red$/,'$1ered'],
    [/^(cent|met|theat|lit|fib|calib|lust|scept)re(s)?$/,'$1er$2']
  ];
  const UKWORDS={learnt:'learned',burnt:'burned',spelt:'spelled',dreamt:'dreamed',leapt:'leaped',
    spilt:'spilled',spoilt:'spoiled',smelt:'smelled',grey:'gray',greys:'grays',greyed:'grayed',greying:'graying',
    judgement:'judgment',judgements:'judgments',acknowledgement:'acknowledgment',acknowledgements:'acknowledgments',
    practise:'practice',practised:'practiced',practises:'practices',practising:'practicing',
    licence:'license',licences:'licenses',defence:'defense',defences:'defenses',
    offence:'offense',offences:'offenses',pretence:'pretense',pretences:'pretenses',
    fulfil:'fulfill',fulfils:'fulfills',fulfilment:'fulfillment',fulfilments:'fulfillments',
    enrol:'enroll',enrols:'enrolls',enrolment:'enrollment',enrolments:'enrollments',
    instalment:'installment',instalments:'installments',skilful:'skillful',wilful:'willful',
    programme:'program',programmes:'programs',tyre:'tire',tyres:'tires',kerb:'curb',kerbs:'curbs',
    cheque:'check',cheques:'checks'};
  function usSpelling(w){
    for(let k=0;k<UKRULES.length;k++){const t=w.replace(UKRULES[k][0],UKRULES[k][1]);if(t!==w)return t;}
    return Object.hasOwn(UKWORDS,w)?UKWORDS[w]:w;
  }
  /* 语气词互通(r3 2026-10-31): Mmm/Hmm/Um/Uh… ASR 几乎无法稳定区分, 全家族归一到
     'hmm', 两侧同变换只增匹配。白名单按整词匹配, 真词(ham/hum/mum/her)不受影响;
     oh 仍归 zero(数字读法), 不入本家族。语料实测 16 种变体全部覆盖。 */
  const FILLER=/^(h+mm*|m+hmm*|mm+|um+|uh+|uhm+|erm?|eh+|huh+|aha|ugh|ah+)$/;
  /* 感叹词拼写家族(r7 2026-11-08): Geeze/Geez/Jeez/Jeeze 同音同义, 拼写随意——官方文本用
     Geeze, ASR 写 Geez/Jeez。归一到 geez, 白名单整词匹配, 真词不动。 */
  const GEEZ=/^(gee+ze?|jee+ze?)$/;
  /* 口语缩略与等价写法归一: 只有明确同义的形式展开; 裸 cause 保留其名词/动词义。 */
  const SLANG={alright:['all','right'],gonna:['going','to'],wanna:['want','to'],gotta:['got','to'],kinda:['kind','of'],sorta:['sort','of'],
    lemme:['let','me'],gimme:['give','me'],outta:['out','of'],lotta:['lot','of'],"c'mon":['come','on'],
    "'bout":['about'],"'em":['them'],"'cause":['because'],"'til":['till'],"'till":['till'],"'tis":['it','is']};
  /* 明确同义的常见缩写两侧展开。's(is/has/所有格)有歧义——但人称/指示代词+'s 从不表示
     所有格(its/ours 无撇号), 按 is 读法展开(r6 2026-11-07): ASR 常把 He's 写成 He is,
     形状差(1↔2 token)整对落空; has 读法(he's got ↔ he has got)展开后 he/got 仍各得其所。
     名词所有格(boy's/James's/today's)不展开。'd(had/would)仍不盲目替换。 */
  const CONTRACTIONS={"i'm":['i','am'],"you're":['you','are'],"we're":['we','are'],"they're":['they','are'],
    "he's":['he','is'],"she's":['she','is'],"it's":['it','is'],"that's":['that','is'],"what's":['what','is'],
    "who's":['who','is'],"there's":['there','is'],"here's":['here','is'],"where's":['where','is'],"how's":['how','is'],
    "i've":['i','have'],"you've":['you','have'],"we've":['we','have'],"they've":['they','have'],
    "i'll":['i','will'],"you'll":['you','will'],"he'll":['he','will'],"she'll":['she','will'],
    "it'll":['it','will'],"we'll":['we','will'],"they'll":['they','will'],"let's":['let','us'],
    "don't":['do','not'],"doesn't":['does','not'],"didn't":['did','not'],"isn't":['is','not'],
    "aren't":['are','not'],"wasn't":['was','not'],"weren't":['were','not'],"haven't":['have','not'],
    "hasn't":['has','not'],"hadn't":['had','not'],"won't":['will','not'],"wouldn't":['would','not'],
    "can't":['can','not'],cannot:['can','not'],"couldn't":['could','not'],"shouldn't":['should','not'],
    "mustn't":['must','not'],"needn't":['need','not'],"mightn't":['might','not']};
  const COMBINING=/[\u0300-\u036f]/;
  function wordTokens(w){
    const out=[];
    if(w==='okay')return ['ok'];
    const bare=w.replace(/^'+|'+$/g,'');   /* 游离撇号和词尾所有格 customers'; SLANG 仍按原词查('bout 等靠撇号) */
    if(/^\d+$/.test(bare)){
      expandNum(parseInt(bare,10),out);
      return out.every(token=>typeof token==='string')?out:[w];
    }
    /* 身高写法 6'1"(官方文本) vs ASR 读法 six one(r5 2026-11-07): 数字'数字展开成读法
       单词, 两侧同变换只增匹配; o'clock 等非数字后缀不匹配。弯引号已在折叠层归一。 */
    const feet=bare.match(/^(\d{1,2})'(\d{1,2})$/);
    if(feet){const spoken=[];expandNum(parseInt(feet[1],10),spoken);expandNum(parseInt(feet[2],10),spoken);return spoken;}
    if(Object.hasOwn(SLANG,w))return SLANG[w].slice();
    if(!bare)return out;
    if(Object.hasOwn(CONTRACTIONS,bare))return CONTRACTIONS[bare].slice();
    /* 已确认的视力复合词与连字符/分写形式同分词; 不普遍拼接(如 re-sign/resign)。 */
    const sighted=bare.match(/^(far|near|short|long)(sighted(?:ness)?)$/);
    if(sighted)return [sighted[1],sighted[2]];
    if(FILLER.test(bare))return ['hmm'];
    if(GEEZ.test(bare))return ['geez'];
    /* 同音称呼两侧同变换, 不按大写猜测姓名。 */
    if(bare==='miss')return ['ms'];else if(bare==='misses')return ['mrs'];
    return [bare==='oh'?'zero':usSpelling(bare)];
  }
  /* 评分与显示共享的原文词段。折叠时保留每个字符的原文范围, 因而 d + 空格 + U+0301
     + ecor 是同一段, 不能按空格拆开后分别归一。分隔符不消耗 marks; 数字/缩写可消耗多个。 */
  function tokenSegments(value){
    const text=String(value),chars=[],starts=[],ends=[];
    let offset=0;
    for(const raw of text){
      const start=offset;offset+=raw.length;
      const folded=raw.toLowerCase().normalize('NFD').replace(/[\u2018\u2019\u02bc\uff07]/g,"'");
      for(let i=0;i<folded.length;i++){
        const ch=folded[i];
        if(COMBINING.test(ch)){
          // The old whole-text normalizer removes spaces immediately before a floating accent.
          while(chars[chars.length-1]===' '){chars.pop();starts.pop();ends.pop();}
          if(ends.length)ends[ends.length-1]=offset;
          continue;
        }
        chars.push(ch);starts.push(start);ends.push(offset);
      }
    }
    const segments=[],folded=chars.join('');
    let cursor=0;
    for(const match of folded.matchAll(/[a-z0-9']+/g)){
      const start=starts[match.index],end=ends[match.index+match[0].length-1];
      if(start>cursor)segments.push({text:text.slice(cursor,start),tokens:[]});
      segments.push({text:text.slice(start,end),tokens:wordTokens(match[0])});
      cursor=end;
    }
    if(cursor<text.length)segments.push({text:text.slice(cursor),tokens:[]});
    return segments;
  }
  function normTokens(s){return tokenSegments(s).flatMap(part=>part.tokens);}
  /* 语音赦免仅限逐项确认的姓名变体。普通数词、内容词、星期名称不走编辑距离或大写猜测。 */
  const NAME_ALIASES=[['julianne','julian'],['mcnealy','mclean']];
  function fuzzyEqual(a,b){
    return a!==b&&NAME_ALIASES.some(group=>group.includes(a)&&group.includes(b));
  }
  /* 复合词分写等价(r8 2026-11-09): 官方 "voice mail" vs ASR/用户 "voicemail"——相邻两 token
     拼接等于另一侧单 token 即互配(双向)。护栏: 拼接≥5 字符且 pair 首词非虚词/非前缀语素
     (挡 to+get↔together / a+lone↔alone / re+sign↔resign 这类真词误并; over/anti/out 等
     是合法复合词首, 不挡, overhead/antiparticles 案例依赖它们)。两侧同变换, 只增匹配不改错配。 */
  const COMPOUND_BLOCK=new Set(['to','a','i','of','in','on','for','and','or','is','it','be','by','at','as','we','he','she','you','they','do','go','so','no','if','me','my','us','an','am','are','was','were','has','have','had','the','that','this','with','from','but','not','oh','ok','re','un','de','dis','pre','non']);
  /* 连字符 re- 复合词中「连起来就是同一个词」的白名单(r9 2026-11-09): 官方 "re-do" vs
     用户 "redo" 是同词异写; resign(辞职)与 re-sign(再签)这类真异义词不在表内, 仍保持区分。 */
  const RE_MERGES=new Set(['redo','redecorating','redecorate','reemphasize','retake','rerun','rebook','reorder','reenter','repaint','rewrite','reread','replay','recheck','reapply','rebuild','reload','reopen','restart','reuse','remix','recast','reconnect','recreate','reassemble']);
  function compoundOK(w,merged){return RE_MERGES.has(merged)||(!COMPOUND_BLOCK.has(w)&&w.length>=2&&merged.length>=5);}
  function scoreTokens(official,mine,fuzzy=false){
    const a=normTokens(official),b=normTokens(mine),n=a.length,m=b.length;
    /* 前缀 dp[i][j]=LCS(a[0..i-1],b[0..j-1]), 含复合词 2↔1 合并分支(官方对计 2 分) */
    const dp=Array.from({length:n+1},()=>new Array(m+1).fill(0));
    for(let i=1;i<=n;i++)for(let j=1;j<=m;j++){
      let best=Math.max(dp[i-1][j],dp[i][j-1]);
      if(a[i-1]===b[j-1])best=Math.max(best,dp[i-1][j-1]+1);
      if(i>=2&&compoundOK(a[i-2],a[i-2]+a[i-1])&&a[i-2]+a[i-1]===b[j-1])best=Math.max(best,dp[i-2][j-1]+2);
      if(j>=2&&compoundOK(b[j-2],b[j-2]+b[j-1])&&b[j-2]+b[j-1]===a[i-1])best=Math.max(best,dp[i-1][j-2]+1);
      dp[i][j]=best;
    }
    const marks=new Array(n).fill(false),matched=new Array(m).fill(false),pairs=[];
    /* 后向回溯, 与旧实现同优先级: 先单匹配(重复 token 归属语义不变), 再合并 span, 再跳 */
    let i=n,j=m;
    while(i>0&&j>0){
      if(a[i-1]===b[j-1]){marks[i-1]=true;matched[j-1]=true;pairs.push([i-1,j-1]);i--;j--;continue;}
      if(i>=2&&compoundOK(a[i-2],a[i-2]+a[i-1])&&a[i-2]+a[i-1]===b[j-1]){
        marks[i-2]=true;marks[i-1]=true;matched[j-1]=true;pairs.push([i-2,j-1],[i-1,j-1]);i-=2;j--;continue;
      }
      if(j>=2&&compoundOK(b[j-2],b[j-2]+b[j-1])&&b[j-2]+b[j-1]===a[i-1]){
        marks[i-1]=true;matched[j-2]=true;matched[j-1]=true;pairs.push([i-1,j-2],[i-1,j-1]);i--;j-=2;continue;
      }
      if(dp[i-1][j]>=dp[i][j-1])i--;else j--;
    }
    pairs.reverse();
    if(fuzzy){
      const ou=[],bu=[];
      for(let k=0;k<n;k++)if(!marks[k])ou.push(k);
      for(let k=0;k<m;k++)if(!matched[k])bu.push(k);
      let k=0;
      for(const oi of ou){
        for(let t=k;t<Math.min(bu.length,k+4);t++){
          if(fuzzyEqual(a[oi],b[bu[t]])){marks[oi]=true;matched[bu[t]]=true;pairs.push([oi,bu[t]]);bu.splice(t,1);k=t;break;}
        }
      }
    }
    /* 命中分以官方侧 marks 为准(含 fuzzy 赦免; 合并等价 pair 计 2 个官方 token) */
    const hit=marks.reduce((s,v)=>s+(v?1:0),0);
    return {acc:n?hit/n:0,marks,matched,pairs,extras:b.filter((_,k)=>!matched[k]).slice(0,12)};
  }
  function lcsAccFuzzy(official,mine){return scoreTokens(official,mine,true).acc;}
  /* 兼容旧调用方的计数返回值; 新调用方可用 repairVoiceScores 获取逐字段审计。 */
  function repairVoiceFuzzyScores(records,loadDialogue){return repairVoiceScores(records,loadDialogue).changed;}
  /* 只重算有本次原始转写的显式结果。rd.acc 是没有 best 转写的历史聚合, 不能从 latest
     反推或降低。wp 的 best/latest 各用自己的 text, 双方均核实后才重选 best 并完整审计。 */
  function repairVoiceScores(records,loadDialogue){
    const changes=[],skipped=[];
    const skip=(path,reason)=>skipped.push({path,reason});
    const write=(target,key,value,path,reason)=>{
      if(JSON.stringify(target[key])===JSON.stringify(value))return;
      changes.push({path:[...path,key],before:copy(target[key]),after:copy(value),reason});
      target[key]=copy(value);
    };
    const hasText=value=>typeof value==='string'&&!!value.trim();
    for(const [id,lesson] of Object.entries(records?.course||{})){
      if(!/^eplod-\d{4}$/.test(id)||!object(lesson?.drill))continue;
      const drill=lesson.drill,base=['course',id,'drill'];
      if(!object(drill.rd)&&!object(drill.wp))continue;
      let dialogue;
      try{dialogue=loadDialogue(id);}catch{}
      if(!Array.isArray(dialogue)){skip(base,'dialogue-unavailable');continue;}
      for(const [i,row] of Object.entries(drill.rd||{})){
        if(!object(row))continue;
        const path=[...base,'rd',i],official=dialogue[i]?.text;
        if(Number.isFinite(row.acc))skip([...path,'acc'],'unverifiable-historical-best');
        if(!hasText(official)||!normTokens(official).length){skip(path,'official-text-unavailable');continue;}
        const rescore=(result,resultPath)=>{
          if(!hasText(result.text)){skip(resultPath,'transcript-unavailable');return;}
          if(scoringVersion(result)>SCORING_VERSION){skip(resultPath,'newer-scoring-version');return;}
          write(result,'acc',lcsAccFuzzy(official,result.text),resultPath,'normalized-voice-transcript');
          write(result,'scoringVersion',SCORING_VERSION,resultPath,'verified-voice-scoring-version');
        };
        if(object(row.voice)){
          if(row.voice.mode==null||row.voice.mode==='voice')rescore(row.voice,[...path,'voice']);
          else skip([...path,'voice'],'conflicting-result-mode');
        }
        if(object(row.latest)&&row.latest.mode==='voice')rescore(row.latest,[...path,'latest']);
        if(row.mode==='voice'&&hasText(row.last)){
          // Modern mirrors must agree with latest's own text, mode and attempt time.
          if(object(row.latest)&&(row.latest.mode!=='voice'||row.latest.text!==row.last||time(row.latest.at)!==time(row.at))){
            skip([...path,'lastAcc'],'conflicting-latest-mirror');
          }else if(scoringVersion(row.latest)>SCORING_VERSION||Number(row.lastScoringVersion)>SCORING_VERSION){
            skip([...path,'lastAcc'],'newer-scoring-version');
          }else{
            write(row,'lastAcc',lcsAccFuzzy(official,row.last),path,'voice-transcript-mirror');
            write(row,'lastScoringVersion',SCORING_VERSION,path,'verified-voice-mirror-version');
          }
        }
      }
      if(!object(drill.wp))continue;
      const sourceValid=dialogue.length&&dialogue.every(line=>object(line)&&typeof line.text==='string');
      const official=sourceValid?dialogue.map(line=>line.text).join(' '):'';
      const lengths=sourceValid?dialogue.map(line=>normTokens(line.text).length):[];
      const total=lengths.reduce((sum,n)=>sum+n,0),verified=new Set();
      for(const key of ['latest','best']){
        const result=drill.wp[key],path=[...base,'wp',key];
        if(!object(result))continue;
        if(!sourceValid||!total){skip(path,'official-text-unavailable');continue;}
        if(result.mode!=null&&result.mode!=='whole'){skip(path,'conflicting-result-mode');continue;}
        if(!hasText(result.text)){skip(path,'transcript-unavailable');continue;}
        if(scoringVersion(result)>SCORING_VERSION){skip(path,'newer-scoring-version');continue;}
        const score=scoreTokens(official,result.text,true);
        if(score.marks.length!==total){skip(path,'ambiguous-sentence-boundaries');continue;}
        let offset=0;
        const per=lengths.map((len,i)=>{
          const hit=score.marks.slice(offset,offset+len).filter(Boolean).length;
          offset+=len;
          return {i,acc:len?hit/len:1};
        });
        write(result,'acc',score.acc,path,'normalized-whole-transcript');
        write(result,'per',per,path,'whole-transcript-sentence-marks');
        write(result,'extra',score.extras,path,'whole-transcript-extra-tokens');
        write(result,'scoringVersion',SCORING_VERSION,path,'verified-whole-scoring-version');
        verified.add(key);
      }
      if(verified.has('best')&&verified.has('latest')){
        const {best,latest}=drill.wp;
        if(latest.acc>best.acc||(latest.acc===best.acc&&compareResult(latest,best)>0)){
          write(drill.wp,'best',latest,[...base,'wp'],'verified-whole-best-order');
        }
      }
    }
    return {changed:changes.length,changes,skipped};
  }
  function lcsAcc(official,mine){
    /* r8: 委托 scoreTokens(含复合词合并等价), 与整篇/语音判分同一口径 */
    const a=normTokens(official);
    return a.length?scoreTokens(official,mine).acc:0;
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
  function scoringVersion(result){
    const version=result?.scoringVersion;
    return Number.isSafeInteger(version)&&version>0&&Number.isFinite(result.acc)&&typeof result.text==='string'&&result.text.trim()?version:0;
  }
  function sameScoredAttempt(a,b){
    return compareResult(a,b)===0&&(!!identity(a?.id)||
      (time(a?.at)>0&&a?.mode===b?.mode&&typeof a?.text==='string'&&a.text===b?.text));
  }
  function newest(a,b){
    if(!a)return b?copy(b):null;
    if(!b)return copy(a);
    const order=compareResult(a,b);
    if(order!==0)return copy(order>0?a:b);
    if(sameScoredAttempt(a,b)&&scoringVersion(a)!==scoringVersion(b)){
      const [older,newer]=scoringVersion(a)>scoringVersion(b)?[b,a]:[a,b];
      return {...copy(older),...copy(newer)};
    }
    return {...copy(a),...copy(b)};
  }
  function latestResult(value){
    if(object(value.latest))return copy(value.latest);
    if(typeof value.last!=='string')return null;
    const result={id:identity(value.id),at:time(value.at),mode:value.mode||'type',text:value.last,
      acc:Number.isFinite(value.lastAcc)?value.lastAcc:value.mode==='voice'?undefined:value.acc};
    if(Object.hasOwn(value,'lastScoringVersion'))result.scoringVersion=value.lastScoringVersion;
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
      if(Object.hasOwn(latest,'scoringVersion'))out.lastScoringVersion=latest.scoringVersion;
      else delete out.lastScoringVersion;
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
    for(const key of ['dur','speed','scoringVersion'])if(Object.hasOwn(attempt,key))result[key]=copy(attempt[key]);
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
  /* 整篇背诵(r11 2026-10-31): drill.wp={latest,best}。latest=较新一次整篇 take;
     best=历史最好(按 acc)。多端合并各取各的赢家, 不能被 ...copy(b) 整块覆盖。 */
  function mergeWhole(current,incoming){
    const a=object(current)?current:{},b=object(incoming)?incoming:{};
    const la=object(a.latest)?a.latest:null,lb=object(b.latest)?b.latest:null;
    const latest=newest(la,lb);
    // best 候选必须含两侧显式 best, 否则反向合并会让历史最好回退成最新一的成绩
    const candidates=[a.best,b.best,la,lb].filter(x=>object(x)&&Number.isFinite(x.acc));
    // Correct the same take's stale score before comparing it with other takes' best scores.
    const best=candidates.filter(x=>!candidates.some(y=>sameScoredAttempt(x,y)&&scoringVersion(y)>scoringVersion(x)))
      .reduce((w,x)=>!w||x.acc>w.acc||(x.acc===w.acc&&compareResult(x,w)>0)?x:w,null);
    const out={};
    if(latest)out.latest=latest;
    if(best)out.best=copy(best);
    return Object.keys(out).length?out:undefined;
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
    const wp=mergeWhole(a.wp,b.wp);
    if(wp)out.wp=wp;else delete out.wp;
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
  /* 英式拼写曾被当错词扣分(r20): 涉及变体的历史成绩用新归一重算, 与数字修复同款, 只升不降。 */
  function repairSpellingScores(records,loadDialogue){
    let changed=0;
    const variant=s=>(String(s).toLowerCase().match(/[a-z0-9']+/g)||[]).some(w=>usSpelling(w)!==w);   /* 原始分词查变体, normTokens 的输出已归一 */
    for(const [id,lesson] of Object.entries(records.course||{})){
      if(!/^eplod-\d{4}$/.test(id))continue;
      const drill=lesson.drill||{};
      if(!drill.dd&&!drill.rd)continue;
      const dialogue=loadDialogue(id);
      if(!dialogue)continue;
      for(const kind of ['dd','rd']){
        for(const [i,r] of Object.entries(drill[kind]||{})){
          const text=dialogue[+i]&&dialogue[+i].text;
          if(!text||typeof r.last!=='string'||!r.last.trim()||!Number.isFinite(r.acc))continue;
          if(!variant(text)&&!variant(r.last))continue;
          const acc=lcsAcc(text,r.last);
          if(acc>r.acc+1e-9){r.acc=acc;changed++;}
        }
      }
    }
    return changed;
  }
  /* 语气词曾被当错词扣分(r3): 涉及变体的历史成绩用新归一重算, 只升不降, 与数字修复同款。 */
  function repairFillerScores(records,loadDialogue){
    let changed=0;
    const hasFiller=s=>(String(s).toLowerCase().match(/[a-z0-9']+/g)||[]).some(w=>FILLER.test(w));
    for(const [id,lesson] of Object.entries(records.course||{})){
      if(!/^eplod-\d{4}$/.test(id))continue;
      const drill=lesson.drill||{};
      if(!drill.dd&&!drill.rd)continue;
      const dialogue=loadDialogue(id);
      if(!dialogue)continue;
      for(const kind of ['dd','rd']){
        for(const [i,r] of Object.entries(drill[kind]||{})){
          const text=dialogue[+i]&&dialogue[+i].text;
          if(!text||typeof r.last!=='string'||!r.last.trim()||!Number.isFinite(r.acc))continue;
          if(!hasFiller(text)&&!hasFiller(r.last))continue;
          const acc=lcsAcc(text,r.last);
          if(acc>r.acc+1e-9){r.acc=acc;changed++;}
        }
      }
    }
    return changed;
  }
  /* 缩略词曾被当错词扣分(r7): 涉及 gonna/'bout 等的历史成绩重算, 只升不降, 与数字修复同款。 */
  function repairSlangScores(records,loadDialogue){
    let changed=0;
    const hasSlang=s=>/[^\x00-\x7F]| +[\u0300-\u036f]/.test(s)||(String(s).toLowerCase().match(/[a-z0-9']+/g)||[]).some(w=>SLANG[w]||w[0]==="'"||w.slice(-1)==="'");
    for(const [id,lesson] of Object.entries(records.course||{})){
      if(!/^eplod-\d{4}$/.test(id))continue;
      const drill=lesson.drill||{};
      if(!drill.dd&&!drill.rd)continue;
      const dialogue=loadDialogue(id);
      if(!dialogue)continue;
      for(const kind of ['dd','rd']){
        for(const [i,r] of Object.entries(drill[kind]||{})){
          const text=dialogue[+i]&&dialogue[+i].text;
          if(!text||typeof r.last!=='string'||!r.last.trim()||!Number.isFinite(r.acc))continue;
          if(!hasSlang(text)&&!hasSlang(r.last))continue;
          const acc=lcsAcc(text,r.last);
          if(acc>r.acc+1e-9){r.acc=acc;changed++;}
        }
      }
    }
    return changed;
  }
  const api={SCORING_VERSION,mergeDrill,mergeLesson,reconcile,saveAttempt,speedPassed,repairSpeedScores,repairOkayScores,repairNumberScores,repairSpellingScores,repairFillerScores,repairVoiceScores,repairVoiceFuzzyScores,repairSlangScores,scoreTokens,lcsAcc,lcsAccFuzzy,fuzzyEqual,tokenSegments,normTokens,usSpelling,coverProgress};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.EplodRecords=api;
})(typeof globalThis==='object'?globalThis:this);
