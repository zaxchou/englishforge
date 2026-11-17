'use strict';
/* 真实媒体播放回归；API/音频使用固定本地夹具，不调用外部 TTS、不写生产记录。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
const base = process.env.NT_BASE || 'http://127.0.0.1:8031';
const root = path.resolve(__dirname, '..');
(async () => {
  const { createLocalAudio } = await import(pathToFileURL(path.join(root, 'number-trainer-audio.mjs')).href);
  const local = createLocalAudio({digitAudioDir:path.join(root,'web/nt-digits'),cacheDir:path.join(root,'build/qa/number-trainer/rate-fixtures')});
  const standard = fs.readFileSync(local.synthDigits('1002211007').file);
  const long = fs.readFileSync(local.synthDigits('77777777777').file);
  const browser = await chromium.launch({channel:'msedge',headless:true});
  const report = [];
  for (const name of ['preview overlaps training', 'Enter submits before audio ends', 'local audio works without TTS', 'rate selection preview and persistence', 'slow long audio finishes before auto advance', 'resumed session keeps its rate', 'replay cannot be cut by Enter', 'preview stops when leaving']) {
    const ctx = await browser.newContext({viewport:{width:390,height:844}});
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('nt:cfg')) localStorage.setItem('nt:cfg', JSON.stringify({mode:'phone',voice:'local',auto:false,count:10,rate:0.8}));
      window.__audios=[];window.__spoken=[];window.__media=[];
      const NativeAudio=window.Audio;
      window.Audio=function(...args){
        const el=new NativeAudio(...args);window.__audios.push(el);
        for (const type of ['playing','ended','pause']) el.addEventListener(type,()=>window.__media.push({type,at:performance.now(),src:el.src,rate:el.playbackRate}));
        return el;
      };
      window.Audio.prototype=NativeAudio.prototype;
      window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
      Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{cancel(){},getVoices(){return[];},speak(u){window.__spoken.push(u.text);setTimeout(()=>u.onend?.(),5);}}});
    });
    const page=await ctx.newPage();
    let requests=0, session=null;
    const events=[], errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/number-trainer/**',async route=>{
      const p=new URL(route.request().url()).pathname;
      if(p.endsWith('/config'))return route.fulfill({json:{tts:name!=='local audio works without TTS',localAudio:true,localAudioVersion:'nt-local-v2'}});
      if(p.endsWith('/summary'))return route.fulfill({json:{summary:{total:{settled:0}},phone:{summary:{total:{settled:0}},advice:[]}}});
      if(p.endsWith('/history'))return route.fulfill({json:{rounds:[]}});
      if(p.endsWith('/sessions')){
        const cfg=route.request().postDataJSON();
        const value=name==='slow long audio finishes before auto advance'?'77777777777':'1002211007';
        const questions=Array.from({length:10},(_,i)=>({id:'q'+(i+1),mode:'phone',value,digits:value.length,text:'one oh oh two two one one oh oh seven',source:'probe',audioUrl:'/api/number-trainer/audio?s=rate-test&q=q'+(i+1)}));
        session={id:'rate-test',config:cfg,questions,plan:{},state:'active'};
        return route.fulfill({json:session});
      }
      if(p.endsWith('/sessions/rate-test'))return route.fulfill({json:session});
      if(p.endsWith('/attempt')){events.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}});}
      if(p.endsWith('/preview')||p.endsWith('/audio')){
        requests++;
        return route.fulfill({contentType:'audio/wav',body:name==='slow long audio finishes before auto advance'?long:standard});
      }
      return route.fulfill({json:{ok:true}});
    });
    try {
      await page.goto(base+'/#/number-trainer');
      await page.locator('[data-voice="local"].on').waitFor();
      if(name==='rate selection preview and persistence'){
        for (const rate of ['0.6','0.8','1']) {
          await page.locator(`[data-rate="${rate}"]`).click();
          await page.locator('[data-preview="local"]').click();
          await page.waitForFunction(()=>window.__audios.some(a=>!a.paused));
          const metrics=await page.evaluate(()=>{const a=window.__audios.find(a=>!a.paused);return {rate:a.playbackRate,pitch:a.preservesPitch};});
          assert.equal(metrics.rate,Number(rate));assert.equal(metrics.pitch,true);
        }
        await page.locator('[data-rate="0.8"]').click();
        assert(await page.evaluate(()=>window.__audios.every(a=>a.paused)), 'changing speed stops the previous preview');
        await page.locator('[data-preview="natural"]').click();
        await page.waitForFunction(()=>window.__audios.some(a=>!a.paused));
        assert.equal(await page.evaluate(()=>window.__audios.find(a=>!a.paused).playbackRate),0.8,'natural preview obeys selected speed');
        await page.reload();
        await page.locator('[data-rate="0.8"].on').waitFor();
      } else if(name==='preview stops when leaving'){
        await page.locator('[data-preview="local"]').click();
        await page.waitForFunction(()=>window.__audios.some(a=>!a.paused));
        await page.evaluate(()=>window.NT.leave());
        assert(await page.evaluate(()=>window.__audios.every(a=>a.paused)), 'leaving stops all audio');
      } else {
        if(name==='preview overlaps training'){
          await page.locator('[data-preview="local"]').click();
          await page.waitForFunction(()=>window.__audios.some(a=>!a.paused));
        }
        if(name==='slow long audio finishes before auto advance'||name==='resumed session keeps its rate')await page.locator('[data-rate="0.6"]').click();
        if(name==='slow long audio finishes before auto advance')await page.locator('[data-auto="on"]').click();
        await page.locator('[data-act="start"]').click();
        await page.locator('.nt-bars').waitFor();
        await page.waitForFunction(()=>document.querySelector('.nt-state')?.textContent.includes('正在播放'));
        if(name==='local audio works without TTS'){
          assert(requests>0&&await page.evaluate(()=>window.__spoken.length===0),'local selection must load WAV even without AI credentials');
        } else if(name==='preview overlaps training'){
          assert.equal(await page.evaluate(()=>window.__audios.filter(a=>!a.paused&&!a.ended).length),1,'preview must stop before training audio starts');
        } else if(name==='replay cannot be cut by Enter'){
          await page.waitForFunction(()=>document.querySelector('.nt-state')?.textContent.includes('输入你听到的数值'),null,{timeout:15000});
          await page.keyboard.type(session.questions[0].value);await page.keyboard.press('Enter');
          await page.locator('.nt-result.ok').waitFor();
          await page.keyboard.press('r');
          await page.waitForFunction(()=>window.__audios.some(a=>!a.paused));
          assert.equal(await page.locator('[data-act="next"]').isDisabled(),true,'next button is disabled while replaying');
          await page.keyboard.press('Enter');
          assert((await page.locator('.nt-meta-row').textContent()).trim().startsWith('1 /'),'keyboard cannot cut a replay short');
        } else if(name==='resumed session keeps its rate'){
          await page.evaluate(()=>{const cfg=JSON.parse(localStorage.getItem('nt:cfg'));cfg.rate=1;localStorage.setItem('nt:cfg',JSON.stringify(cfg));});
          await page.reload();
          await page.waitForFunction(()=>document.querySelector('.nt-state')?.textContent.includes('正在播放'));
          assert.equal(await page.evaluate(()=>window.__audios.find(a=>!a.paused).playbackRate),0.6,'saved session rate overrides changed home preference');
          assert((await page.locator('.nt-meta-row').textContent()).includes('0.6×'));
        } else {
          const value=session.questions[0].value;
          await page.keyboard.type(value);await page.keyboard.press('Enter');
          assert.equal(await page.locator('.nt-result').count(),0,'keyboard must obey the playback-complete gate');
          if(name==='slow long audio finishes before auto advance'){
            await page.waitForTimeout(13200);
            assert((await page.locator('.nt-meta-row').textContent()).trim().startsWith('1 /'),'no advance at the old 12-second limit');
            assert.equal(await page.locator('.nt-result').count(),0);
            await page.waitForFunction(()=>document.querySelector('.nt-state')?.textContent.includes('输入你听到的数值'),null,{timeout:12000});
            const media=await page.evaluate(()=>window.__media.filter(e=>e.type==='playing'||e.type==='ended'));
            assert(media.some(e=>e.type==='ended'),'real media ended event observed');
            assert(media.find(e=>e.type==='ended').at-media.find(e=>e.type==='playing').at>16000,'0.6x audio played to completion');
            await page.keyboard.press('Enter');
            await page.locator('.nt-result.ok').waitFor();
            await page.waitForFunction(()=>document.querySelector('.nt-meta-row')?.textContent.trim().startsWith('2 /'));
            assert.equal(events[0].rate,0.6);assert.equal(events[0].timingValid,true);
          }
        }
      }
      assert.deepEqual(errors,[]);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      report.push({name,ok:true});
    } catch(e) { report.push({name,ok:false,error:e.stack||e.message}); }
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.every(r=>r.ok)?0:1;
})().catch(e=>{console.error(e);process.exitCode=1;});
