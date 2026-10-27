/* 修锚后验收: ①全库剩余无锚统计 ②新锚区间合法性(不重叠/有序/在时长内) ③抽期浏览器实播 */
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.TFL_PLAYWRIGHT||'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
const base='http://127.0.0.1:8020';
const DUR={}; // durations 从 JSON 自带
(async()=>{
  // ① 数据层统计
  let eps=0, unanchoredLines=0, unanchoredEps=0, patched=0;
  const details=[];
  for(let ep=1;ep<=364;ep++){
    if(ep===164)continue;
    const id=String(ep).padStart(4,'0');
    let d;try{d=JSON.parse(fs.readFileSync(`build/eplod/${id}.json`,'utf8'));}catch(e){continue;}
    eps++;
    const bad=[];
    const anchored=d.dialogue.filter(l=>l.t0!=null);
    d.dialogue.forEach((l,i)=>{if(l.t0==null){bad.push(i);}});
    // 锚合法性: 区间不重叠且在 [0, dur] 内
    const dur=(d.durations&&d.durations.dg)||0;
    const spans=anchored.map(l=>[l.t0,l.t1]).sort((a,b)=>a[0]-b[0]);
    for(let i=1;i<spans.length;i++)if(spans[i][0]<spans[i-1][1]-0.01){details.push(`${id} OVERLAP ${spans[i-1][1]} > ${spans[i][0]}`);}
    for(const [a,b] of spans)if(dur>0&&(a<0||b>dur+1)){details.push(`${id} OUT_OF_RANGE ${a}-${b} dur=${dur}`);}
    if(bad.length){unanchoredEps++;unanchoredLines+=bad.length;details.push(`${id} 无锚${bad.length}: ${bad.join(',')}`);}
    else patched++;
  }
  console.log(`期数 ${eps}, 全锚期 ${patched}, 仍有无锚的期 ${unanchoredEps} 共 ${unanchoredLines} 句`);
  console.log(details.slice(0,40).join('\n')||'(无异常)');
  // ③ 浏览器抽检: 抽 3 个已修期听第一句
  const spots=['0001','0009','0027'];
  const b=await chromium.launch({channel:'msedge',headless:true});
  for(const id of spots){
    const ctx=await b.newContext({viewport:{width:1440,height:900}});
    const p=await ctx.newPage();
    const errs=[];p.on('pageerror',e=>errs.push(e.message));
    await p.goto(base+'/#/eplod/eplod-'+id,{waitUntil:'domcontentloaded'});
    await p.locator('#ep-tabs').waitFor({timeout:30000});
    await p.waitForFunction(ep=>EP.st?.l?.ep===+ep,id);
    await p.waitForTimeout(400);
    const r=await p.evaluate(async()=>{
      document.querySelector('#ep-tabs [data-m=train]').click();
      await new Promise(r=>setTimeout(r,250));
      const a=document.getElementById('ep-audio');
      document.querySelector('.ep-bcard .bp').click();
      await new Promise(r=>setTimeout(r,600));
      return {ai:EP.st.ai,paused:a.paused,t:a.currentTime};
    });
    console.log(`抽检 ${id}: ai=${r.ai} playing=${!r.paused} t=${r.t.toFixed(1)} errs=${errs.length}`);
    await ctx.close();
  }
  await b.close();
})();
