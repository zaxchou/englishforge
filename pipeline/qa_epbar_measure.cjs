/* 播放条(ep-stage)自适应验收: 各视口宽度下量布局状态并截图 */
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.TFL_PLAYWRIGHT||'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
const base=process.env.TFL_TEST_URL||'http://127.0.0.1:8020';
const out=path.resolve(__dirname,'../build/qa/ep-bar');fs.mkdirSync(out,{recursive:true});
(async()=>{
  const b=await chromium.launch({channel:'msedge',headless:true});
  const widths=[1920,1680,1552,1500,1440,1366,1300,1280,1200,1180,1100,1000,960,900,820,760,700,390,320];
  console.log('vw\tstage\tdock\tsegs\tloop\tmask\tflow\trows\toverflow');
  for(const w of widths){
    const ctx=await b.newContext({viewport:{width:w,height:Math.max(740,Math.round(w*0.62))},ignoreHTTPSErrors:true});
    const p=await ctx.newPage();
    try{
      await p.goto(base+'/#/eplod/eplod-0001',{waitUntil:'domcontentloaded'});
      await p.locator('#ep-tabs').waitFor({timeout:30000});
      await p.waitForFunction(()=>document.querySelector('.ep-stage')&&document.querySelector('.ep-stage').offsetHeight>0,{timeout:15000});
      await p.waitForTimeout(250);
      // 模拟播放态(train 态 dock 最宽, 即用户截图的状态), RO 异步触发后再量
      await p.evaluate(()=>{const d=document.getElementById('ep-dock');if(d){d.style.display='flex';d.dataset.tab='train';}});
      await p.waitForTimeout(300);
      const m=await p.evaluate(()=>{
        const st=document.querySelector('.ep-stage');
        const g=x=>x?Math.round(x.getBoundingClientRect().width):0;
        const vis=x=>x&&x.getBoundingClientRect().width>0&&x.getBoundingClientRect().height>0;
        const dock=st.querySelector('.ep-dock'),segs=st.querySelector('.ep-segs'),
              loop=document.getElementById('ep-loop'),mask=document.getElementById('ep-mask');
        const flow=st.classList.contains('ep-flow');
        const tops=[...new Set([dock,segs,loop,mask].filter(vis).map(x=>Math.round(x.getBoundingClientRect().top)))].sort((a,b)=>a-b);
        let rows=tops.length?1:0;
        for(let i=1;i<tops.length;i++)if(tops[i]-tops[i-1]>12)rows++;
        const sr=st.getBoundingClientRect();
        const overflow=[dock,segs,loop,mask].filter(vis).some(x=>{const r=x.getBoundingClientRect();return r.right>sr.right+1||r.left<sr.left-1;});
        return {stage:g(st),dock:g(dock),segs:g(segs),loop:g(loop),mask:g(mask),flow,rows,overflow};
      });
      console.log(`${w}\t${m.stage}\t${m.dock}\t${m.segs}\t${m.loop}\t${m.mask}\t${m.flow}\t${m.rows}\t${m.overflow}`);
      if([1552,1440,1280,1180,1000,900,760,390,320].includes(w)){
        await p.locator('.ep-stage').screenshot({path:path.join(out,`bar-${w}.png`)});
        await p.screenshot({path:path.join(out,`page-${w}.png`)});
      }
    }catch(e){console.log(w+'\tERR '+e.message.split('\n')[0]);}
    await ctx.close();
  }
  // 精听模式(listen dock 变宽)抽查两个夹缝宽度
  for(const w of [1440,1280]){
    const ctx=await b.newContext({viewport:{width:w,height:900},ignoreHTTPSErrors:true});
    const p=await ctx.newPage();
    await p.goto(base+'/#/eplod/eplod-0001',{waitUntil:'domcontentloaded'});
    await p.locator('#ep-tabs').waitFor({timeout:30000});
    await p.waitForFunction(()=>document.querySelector('.ep-stage')&&document.querySelector('.ep-stage').offsetHeight>0,{timeout:15000});
    await p.evaluate(()=>{const d=document.querySelector('.ep-dock');if(d){d.style.display='flex';d.dataset.tab='train';}});
    await p.waitForTimeout(300);
    const m=await p.evaluate(()=>{
      const st=document.querySelector('.ep-stage');
      const dock=st.querySelector('.ep-dock'),loop=document.getElementById('ep-loop');
      const tops=[Math.round(dock.getBoundingClientRect().top),Math.round(loop.getBoundingClientRect().top)].sort((a,b)=>a-b);
      let rows=tops.length?1:0;
      for(let i=1;i<tops.length;i++)if(tops[i]-tops[i-1]>12)rows++;
      return {dock:Math.round(dock.getBoundingClientRect().width),flow:st.classList.contains('ep-flow'),rows,
        stage:Math.round(st.getBoundingClientRect().width)};
    });
    console.log(`train@${w}\tdock=${m.dock}\tstage=${m.stage}\tflow=${m.flow}\trows=${m.rows}`);
    await p.screenshot({path:path.join(out,`bar-listen-${w}.png`)});
    await ctx.close();
  }
  await b.close();
})();
