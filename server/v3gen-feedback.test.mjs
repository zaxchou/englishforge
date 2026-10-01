import { beforeAll, afterAll, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let dir, db, gen, ev, api
beforeAll(async () => {
 dir=mkdtempSync(join(tmpdir(),'ef-feedback-'));process.env.ENGLISHFORGE_DB=join(dir,'test.db')
 api=(await import('./api.mjs')).handleApi;db=await import('./db.mjs');gen=await import('./v3gen.mjs');ev=await import('./v3evidence.mjs')
})
afterAll(()=>{db.closeDb();rmSync(dir,{recursive:true,force:true})})
const call=(pathname,body,method='GET')=>api({pathname,body,method,query:new URLSearchParams()})
it('generated text substitutes retain modality limits and band after storage', async()=>{
 await call('/api/v1/map')
 const [id]=gen.registerGeneratedActivities('fixture',[{prompt:'text substitute',objectiveIds:['O-K184-02'],skillByObjective:{'O-K184-02':'listening'},complexityBand:4,transcriptShownByDefault:true,oralEvidenceDeferred:true,relations:[{id:'x',label:'x',anyOf:['x','y'],required:true}]}])
 const a=ev.activityById(id)
 expect(a.complexityBand).toBe(4);expect(a.transcriptShownByDefault).toBe(true);expect(a.oralEvidenceDeferred).toBe(true)
})
it('practice feedback invalidates teaching cache without upgrading certification', async()=>{
 const id=(await call('/api/accounts',{name:'feedback-only'},'POST')).json.account.id
 await call('/api/v1/lessons')
 gen.cacheLesson(id,'O-K184-02','les-listening-v1',1,0)
 db.getDb().prepare('UPDATE lesson_cache SET created_at=0 WHERE account_id=?').run(id)
 const attempt=await call(`/api/v1/accounts/${id}/attempts`,{attemptId:'practice',activityId:'diag_d1_read',response:{kind:'text',text:'hello'},conditions:{firstExposure:true,playCount:0,hintLevel:0,transcriptShown:false,lookupUsed:false,responseMode:'typed_summary'}},'POST')
 expect(attempt.status).toBe(200)
 const states=(await call(`/api/v1/accounts/${id}/evidence`)).json.states
 expect(states.some(s=>s.state==='trained')).toBe(false)
 expect(gen.reestimateWindow(id,'practice').invalidated).toBe(1)
 expect(db.getDb().prepare('SELECT invalidated_reason FROM lesson_cache WHERE account_id=?').get(id).invalidated_reason).toContain('practice=1')
 gen.cacheLesson(id,'O-K184-02','les-listening-v1',1,0)
 expect(db.getDb().prepare('SELECT status FROM lesson_cache WHERE account_id=?').get(id).status).toBe('ready')
 expect(gen.reestimateWindow(id,'no-new-feedback').invalidated).toBe(0)
})

it('same goal has different teaching controls for missing relations, supported success and independent confirmation',()=>{
 const miss={practiceOnly:true,conditions:{hintLevel:0},dimensions:[{id:'contrast',label:'contrast',required:true,hit:false}]}
 const repair=gen.teachingAdaptation([miss,miss],{band:3})
 const fading=gen.teachingAdaptation([{practiceOnly:true,conditions:{hintLevel:2},dimensions:[]}],{band:3})
 const confirmed=gen.teachingAdaptation([{practiceOnly:false,conditions:{hintLevel:0},dimensions:[]}],{band:3,states:[{state:'transferred'}]})
 expect(repair.mode).toBe('focused_probe');expect(repair.focusDimensions[0].count).toBe(2)
 expect(fading.mode).toBe('fade_support');expect(fading.maxBand).toBe(3)
 expect(confirmed.mode).toBe('new_context_probe');expect(confirmed.maxBand).toBe(4)
 expect(gen.teachingAdaptation([{practiceOnly:true,conditions:{hintLevel:0},dimensions:[]}],{band:3}).maxBand).toBe(3)
})

it('a pending generation response cannot publish against feedback changed while the provider was running',async()=>{
 const id=(await call('/api/accounts',{name:'stale-job'},'POST')).json.account.id
 const previous=process.env.ENGLISHFORGE_V4_GENERATION;process.env.ENGLISHFORGE_V4_GENERATION='1'
 let release
 try {
  const pending=gen.startGenerationJob(id,{objectiveId:'O-K115-01',await:true,chat:()=>new Promise(resolve=>{release=resolve})})
  expect(release).toBeTypeOf('function')
  const attempt=await call(`/api/v1/accounts/${id}/attempts`,{attemptId:'changed-during-generation',activityId:'diag_d1_read',response:{kind:'text',text:'hello'},conditions:{firstExposure:true,playCount:0,hintLevel:0,transcriptShown:false,lookupUsed:false,responseMode:'typed_summary'}},'POST')
  expect(attempt.status).toBe(200)
  release('{}')
  const result=await pending
  expect(result.status).toBe('superseded');expect(result.published).toBe(false)
  expect(db.getDb().prepare('SELECT output_lesson_id FROM generation_jobs WHERE job_id=?').get(result.jobId).output_lesson_id).toBeNull()
 }finally{if(previous===undefined)delete process.env.ENGLISHFORGE_V4_GENERATION;else process.env.ENGLISHFORGE_V4_GENERATION=previous}
})
