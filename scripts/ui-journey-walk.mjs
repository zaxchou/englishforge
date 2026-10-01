// Engineering fixtures only; creates its own temporary DB and localhost server.
// Set EF_PLAYWRIGHT_IMPORT to a Playwright module URL if not installed in this project.
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo=fileURLToPath(new URL('../',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'ef-ui-walk-'))
const dbPath=join(dir,'isolated.db'),port=5193,base=`http://127.0.0.1:${port}`
let server,browser,logs=''
const pause=ms=>new Promise(r=>setTimeout(r,ms))
async function api(path,body){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(`${r.status} ${path}: ${JSON.stringify(data)}`);return data}
try {
 const {chromium}=await import(process.env.EF_PLAYWRIGHT_IMPORT || 'playwright')
 server=spawn(process.execPath,[join(repo,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:repo,env:{...process.env,ENGLISHFORGE_DB:dbPath,ENGLISHFORGE_V4_GENERATION:'0',ENGLISHFORGE_TLS_KEY:'',ENGLISHFORGE_TLS_CERT:''},windowsHide:true})
 server.stdout.on('data',b=>{logs+=b});server.stderr.on('data',b=>{logs+=b})
 let health
 for(let i=0;i<60;i++){if(server.exitCode!==null)throw Error(`server failed ${logs}`);try{health=await api('/api/health');break}catch{await pause(250)}}
 if(!health || health.path!==dbPath)throw Error('REFUSE_NONISOLATED_DATABASE')
 const id=(health.accounts[0] ?? (await api('/api/accounts',{name:'browser-fixture'})).account).id
 // No map-page visit: the diagnostic must seed its own dependencies.
 let d=await api(`/api/v1/accounts/${id}/diagnostics`,{requestId:'ui-diag'})
 const scripts={D1:'他们做了一个展览。',D1b:'工具在小房间安静的时候可用，在吵闹的大房间失败。',D2:'AI 助手很有用，能帮助设计项目找灵感。',D2b:'这个工具可以帮我们找论文，但使用前必须自己读来源核查；摘要漏掉了原论文的重要限制。',D3:'它能帮我们找到值得读的论文，但摘要可能漏掉原文的重要限制，所以使用前必须自己读。我的项目会用它找材料，但会核查来源。'}
 for(let i=0;d.status==='open'&&i<8;i++){
  const a=d.activity;if(!a)throw Error('diagnostic missing activity')
  if(a.audio){const delivery=await api(`/api/v1/accounts/${id}/tasks/${a.taskId}/media/${a.audio.mediaId}`);await api(`/api/v1/accounts/${id}/support/play`,{taskId:a.taskId,deliveryId:delivery.deliveryId,eventId:crypto.randomUUID(),activityId:a.activityId,mediaId:a.audio.mediaId})}
  const result=await api(`/api/v1/accounts/${id}/attempts`,{attemptId:`ui-${d.step}-${i}`,sessionId:d.diagnosticId,taskId:a.taskId,activityId:a.activityId,response:{kind:'text',text:scripts[d.step]||''},conditions:{firstExposure:true,hintLevel:0,transcriptShown:d.step==='D2b',playCount:0,lookupUsed:false,responseMode:'typed_summary'}})
  d=result.diagnostic
 }
 if(d.status!=='completed')throw Error('DIAGNOSTIC_GUARD_EXHAUSTED')
 browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']})
 const page=await browser.newPage({permissions:['microphone'],viewport:{width:1280,height:900}}),errors=[]
 page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message))
 await page.goto(base);await page.getByText('能力路径 · 新版',{exact:true}).click()
 let completed=0
 for(let course=0;course<4;course++){
  const plan=(await api(`/api/v1/accounts/${id}/plan`)).decision
  if(!plan.lesson.lessonId){await page.getByRole('button',{name:'内容准备中…',exact:true}).waitFor();break}
  await page.getByRole('button',{name:/^(开始训练|继续上一段)$/}).click()
  let pkg=await api(`/api/v1/accounts/${id}/lessons/${plan.lesson.lessonId}`)
  await page.getByRole('heading',{name:pkg.title,exact:true}).waitFor()
  for(let step=0;step<6;step++){
   const a=pkg.activities.find(x=>!x.resume);if(!a)break
   const area=page.locator('.v4-act')
   if(a.audio){await area.locator('audio').waitFor();const played=page.waitForResponse(r=>r.url().includes('/support/play')&&r.request().method()==='POST');await area.locator('audio').evaluate(el=>el.play());if((await played).status()!==200)throw Error('play rejected')}
   if(a.oralTask){await area.getByRole('button',{name:/开始录音/}).click();await pause(1100);await area.getByRole('button',{name:/停止录音/}).click();await area.getByRole('button',{name:'提交口语作答',exact:true}).waitFor()}
   await area.locator('textarea').fill('The map worked as designed, but our assumption about visitors was incomplete. They walked toward crowded rooms because they thought something interesting was happening. We will ask why before changing the design.')
   // Expiry recovery is exercised only inside this script's own guarded temporary DB.
   if(step===0 && (course===0 || course===2)) {
    const c=new DatabaseSync(dbPath);try{c.prepare('UPDATE issued_tasks SET expires_at=0 WHERE task_id=?').run(a.taskId)}finally{c.close()}
    const [expired]=await Promise.all([page.waitForResponse(r=>r.url().includes(`/accounts/${id}/attempts`)&&r.request().method()==='POST'),area.getByRole('button',{name:a.oralTask?'提交口语作答':'提交',exact:true}).click()])
    if(expired.status()!==409)throw Error('expired task accepted')
    await page.getByRole('button',{name:a.oralTask?'重新获取任务后再试（保留这段录音）':'重新读取当前任务',exact:true}).click()
    await page.getByRole('button',{name:'重新读取当前任务',exact:true}).waitFor()
    if(!await area.locator('textarea').inputValue())throw Error('task refresh discarded draft')
    if(a.oralTask)await area.getByRole('button',{name:'提交口语作答',exact:true}).waitFor()
    const fresh=await api(`/api/v1/accounts/${id}/lessons/${plan.lesson.lessonId}`)
    if(fresh.activities.find(x=>x.activityId===a.activityId).taskId===a.taskId)throw Error('expired task was not replaced')
   }
   const response=page.waitForResponse(r=>r.url().includes(`/accounts/${id}/attempts`)&&r.request().method()==='POST')
   const [saved]=await Promise.all([response,area.getByRole('button',{name:a.oralTask?'提交口语作答':'提交',exact:true}).click()])
   if(saved.status()!==200)throw Error('attempt rejected')
   await area.locator('.v4-relations, .v4-advise').first().waitFor()
   pkg=await api(`/api/v1/accounts/${id}/lessons/${plan.lesson.lessonId}`)
   if(pkg.activities.some(x=>!x.resume))await page.getByRole('button',{name:'看懂了，进入下一步',exact:true}).click()
  }
  if(pkg.activities.some(x=>!x.resume))throw Error('LESSON_STEP_GUARD_EXHAUSTED')
  await page.getByRole('button',{name:'完成训练，查看本次反馈',exact:true}).click()
  await page.getByRole('heading',{name:pkg.title+' · 已完成',exact:true}).waitFor()
  await page.getByRole('button',{name:'查看下一步',exact:true}).click();completed++
 }
 if(completed!==3)throw Error(`expected 3 development samples, got ${completed}`)
 await page.getByRole('button',{name:'我的成长',exact:true}).first().click();await page.getByText('最近完成的训练',{exact:true}).waitFor()
 await page.setViewportSize({width:390,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('mobile overflow')
 if(errors.length)throw Error(errors.join(';'))
 console.log('UI_JOURNEY_OK: 3 development lessons, fake microphone, growth, honest exhausted content; no learning-effect claim')
} finally {
 await browser?.close();server?.kill()
 if(server&&server.exitCode===null)await Promise.race([new Promise(r=>server.once('exit',r)),pause(3000)])
 // Remove only this script's freshly created temporary directory.
 rmSync(dir,{recursive:true,force:true})
}
