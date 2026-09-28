const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
 const out = path.resolve('design-v6'); fs.mkdirSync(out,{recursive:true});
 const browser = await chromium.launch({channel:'msedge',headless:true});
 const context = await browser.newContext({viewport:{width:1536,height:1024}, reducedMotion:'reduce'});
 const page = await context.newPage(); const errors=[];
 page.on('pageerror', e => errors.push(e.message));
 await page.goto('http://127.0.0.1:4185');
 await page.getByRole('button',{name:/^开始练习/}).waitFor();
 await page.screenshot({path:path.join(out,'01-home.png'),fullPage:true});
 await page.getByRole('textbox',{name:'搜索课程或知识点'}).fill('没有这样的课程');
 await page.getByText('没有找到相关课程').waitFor();
 await page.getByRole('textbox',{name:'搜索课程或知识点'}).fill('');
 await page.locator('.course-row').first().click();
 await page.locator('.skill-card').first().waitFor();
 await page.screenshot({path:path.join(out,'02-course.png'),fullPage:true});
 await page.locator('.skill-card').first().click();
 if(await page.getByText('懂了，开练 →',{exact:true}).count()) await page.getByText('懂了，开练 →',{exact:true}).click();
 let iterations=0, checkedRecovery=false;
 const seen=[];
 while(await page.locator('.quiz').count() && iterations++ < 120){
   const concept = page.getByText('懂了，开练 →',{exact:true});
   if(await concept.count()){await concept.click();continue;}
   const next = page.getByRole('button',{name:'下一题 →',exact:true});
   if(await next.count()){await next.click();continue;}
   const skip = page.getByRole('button',{name:'跳过这题',exact:true});
   if(await skip.count()){await skip.click();continue;}
   const opt = page.locator('.options .opt:not([disabled])');
   if(await opt.count()){
     seen.push(await page.locator('.prompt').innerText());
     await opt.first().click();
     if(!checkedRecovery){
       await page.screenshot({path:path.join(out,'03-practice.png'),fullPage:true});
       const before = await page.evaluate(() => JSON.parse(localStorage.getItem('sf-progress-v2')));
       if(!before.activeSession.runtime.pending) throw new Error('Answer feedback not persisted');
       await page.reload(); await page.getByRole('button',{name:/^继续上次练习/}).click();
       await page.getByRole('button',{name:'下一题 →',exact:true}).waitFor();
       const after = await page.evaluate(() => JSON.parse(localStorage.getItem('sf-progress-v2')));
       if(before.attempts.length !== after.attempts.length) throw new Error('Refresh duplicated events');
       if(after.activeSession.runtime.pending.given !== before.activeSession.runtime.pending.given) throw new Error('Refresh lost original answer');
       checkedRecovery=true;
     }
     continue;
   }
   if(await page.locator('.tiles-pool').count()){
     while(await page.locator('.tiles-pool .token').count()) await page.locator('.tiles-pool .token').first().click();
     await page.getByRole('button',{name:'检查',exact:true}).click();continue;
   }
   const tap = page.locator('.tap-sentence .token:not([disabled])');
   if(await tap.count()){await tap.first().click();continue;}
   const sort = page.locator('.sort-btns .opt');
   if(await sort.count()){await sort.first().click();continue;}
   if(await page.locator('.match-grid').count()){
     const left=page.locator('.match-col').first().locator('button:not([disabled])');
     if(await left.count()){
       await left.first().click();
       const right=page.locator('.match-col').last().locator('button:not([disabled])');
       const n=await right.count();
       for(let i=0;i<n;i++){const b=right.nth(i); if(await b.count()) await b.click(); if(!await page.locator('.match-col .picked').count()) break;}
       continue;
     }
   }
   if(await page.getByRole('button',{name:'先下一题（稍后复习再见）'}).count()){await page.getByRole('button',{name:'先下一题（稍后复习再见）'}).click();continue;}
   throw new Error('Unhandled question state: '+(await page.locator('main').innerText()).slice(0,700));
 }
 await page.locator('.result-card').waitFor({timeout:5000});
 await page.screenshot({path:path.join(out,'04-result.png'),fullPage:true});
 const state=await page.evaluate(()=>JSON.parse(localStorage.getItem('sf-progress-v2')));
 if(state.activeSession) throw new Error('Session did not settle');
 if(new Set(state.attempts.map(a=>a.attemptId)).size!==state.attempts.length) throw new Error('Duplicate attempt IDs');
 if(!checkedRecovery) throw new Error('Recovery scenario not covered');
 await page.getByRole('button',{name:'回到学习空间',exact:true}).click();
 await page.setViewportSize({width:1100,height:800});
 await page.screenshot({path:path.join(out,'05-compact.png'),fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
 if(overflow) throw new Error('Horizontal overflow at desktop width 1100');
 // Isolated browser context only: seed one classification exercise to verify its checkpoint.
 await page.evaluate(() => {
   const p=JSON.parse(localStorage.getItem('sf-progress-v2'));
   p.activeSession={sessionId:'sort-recovery',kind:'review',queue:[{qid:'v4q4'}],runtime:null,createdAt:Date.now(),committed:false};
   localStorage.setItem('sf-progress-v2',JSON.stringify(p));
 });
 await page.reload(); await page.getByRole('button',{name:/^继续上次练习/}).click();
 while(await page.locator('.sort-btns .opt').count()) await page.locator('.sort-btns .opt').first().click();
 const sortBefore=await page.evaluate(()=>JSON.parse(localStorage.getItem('sf-progress-v2')));
 if(!sortBefore.activeSession.runtime.pending) throw new Error('Classification feedback not saved');
 await page.reload(); await page.getByRole('button',{name:/^继续上次练习/}).click();
 await page.getByRole('button',{name:'下一题 →',exact:true}).click();
 for(let i=0;i<20 && await page.locator('.quiz').count();i++){
   const sort=page.locator('.sort-btns .opt');
   if(await sort.count()) await sort.first().click();
   else if(await page.getByRole('button',{name:'下一题 →',exact:true}).count()) await page.getByRole('button',{name:'下一题 →',exact:true}).click();
 }
 await page.locator('.result-card').waitFor();
 if(errors.length) throw new Error(errors.join('\n'));
 fs.writeFileSync(path.join(out,'browser-check.json'),JSON.stringify({passed:true,checkedRecovery,attempts:state.attempts.length,xp:state.xp,iterations,errors},null,2));
 console.log(JSON.stringify({passed:true,attempts:state.attempts.length,iterations,errors}));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
