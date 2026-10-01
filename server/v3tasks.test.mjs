import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let dir,api,db,tasks,evidence
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'ef-issued-'));process.env.ENGLISHFORGE_DB=join(dir,'test.db')
 api=(await import('./api.mjs')).handleApi;db=await import('./db.mjs');tasks=await import('./v3tasks.mjs');evidence=await import('./v3evidence.mjs')
})
afterAll(()=>{db.closeDb();rmSync(dir,{recursive:true,force:true})})
const call=(pathname,body,method='GET')=>api({pathname,body,method,query:new URLSearchParams()})
const cond={firstExposure:true,hintLevel:0,transcriptShown:false,playCount:999,lookupUsed:false,responseMode:'typed_summary'}
async function account(){return (await call('/api/accounts',{name:'isolated-task'},'POST')).json.account.id}
async function course(id){await call('/api/v1/map');await call('/api/v1/lessons');return (await call(`/api/v1/accounts/${id}/lessons/les-listening-v1`)).json.activities.find(a=>a.audio)}
async function play(id,taskId,act,eventId='play-1'){
 const d=await call(`/api/v1/accounts/${id}/tasks/${taskId}/media/${act.audioRef ?? act.audio.mediaId}`)
 expect(d.status).toBe(200)
 return call(`/api/v1/accounts/${id}/support/play`,{taskId,deliveryId:d.json.deliveryId,eventId,activityId:act.activityId,mediaId:act.audioRef ?? act.audio.mediaId},'POST')
}
describe('server-issued task and media contracts',()=>{
 it('no delivery/other account/expired task cannot authorize play; repeated network event counts once; plays override self report',async()=>{
  const id=await account(),other=await account(),a=await course(id)
  expect((await call(`/api/v1/accounts/${id}/support/play`,{taskId:a.taskId,activityId:a.activityId,mediaId:a.audio.mediaId,eventId:'x'},'POST')).status).toBe(400)
  expect((await call(`/api/v1/accounts/${other}/tasks/${a.taskId}/media/${a.audio.mediaId}`)).status).toBe(400)
  expect((await play(id,a.taskId,a)).json.playCount).toBe(1)
  expect((await play(id,a.taskId,a)).json.playCount).toBe(1)
  const body={attemptId:'take1',taskId:a.taskId,activityId:a.activityId,response:{kind:'text',text:'正常 假设 不完整 以为'},conditions:cond}
  expect((await call(`/api/v1/accounts/${id}/attempts`,body,'POST')).status).toBe(200)
  expect((await call(`/api/v1/accounts/${id}/attempts`,body,'POST')).json.replayed).toBe(true)
  expect((await call(`/api/v1/accounts/${id}/attempts`,{...body,response:{kind:'text',text:'new'}},'POST')).json.error).toContain('NEW_TAKE_ID_REQUIRED')
  expect((await call(`/api/v1/accounts/${id}/attempts`,{...body,attemptId:'take2'},'POST')).json.replayed).not.toBe(true)
  const rows=db.getDb().prepare('SELECT conditions FROM learner_attempts_v3 WHERE account_id=?').all(id)
  expect(rows).toHaveLength(2);expect((await course(id)).nextTake).toBe(3);expect(JSON.parse(rows[0].conditions).playCount).toBe(1)
  const ev=(await call(`/api/v1/accounts/${id}/evidence`)).json
  expect(ev.states.some(s=>s.skill==='listening' && s.state==='trained')).toBe(false)
  db.getDb().prepare('UPDATE issued_tasks SET expires_at=0 WHERE task_id=?').run(a.taskId)
  expect((await call(`/api/v1/accounts/${id}/tasks/${a.taskId}/media/${a.audio.mediaId}`)).json.error).toContain('EXPIRED')
 })
 it('new isolated holdout first playback counts; prior issuance does not; skill and rubric mismatch rejected',async()=>{
  const id=await account();await course(id);const c=db.getDb()
  c.prepare("INSERT INTO generation_jobs (account_id,job_id,input_spec,contract_version,status,created_at) VALUES (?,?,'{}','test','succeeded',?)").run(id,'testjob',Date.now())
  const source=evidence.activityById('diag_d2_listen_sim')
  const acts=['baseline','post'].map((name,i)=>({...structuredClone(source),activityId:'private-'+name,taskFamilyId:'private-family-'+name,prompt:'private new material '+name,holdout:true,complexityBand:2,role:'holdout',evaluationContract:{dimensions:['meaning'],slots:[{slotId:'claim',prompt:'claim?',options:['A','B'],accept:'A',objectiveIds:source.objectiveIds}]},version:1}))
  for(const act of acts)c.prepare('INSERT INTO generated_activities VALUES (?,?,?,?,?)').run(act.activityId,1,'testjob',JSON.stringify(act),Date.now())
  const spec=act=>({activityId:act.activityId,materialVersion:1,materialRef:act.activityId,taskFamilyId:act.taskFamilyId,dimensions:['meaning'],passRule:'all_slots',skill:'listening'})
  const reg=(await call(`/api/v1/accounts/${id}/trials`,{skill:'listening',baselineTask:spec(acts[0]),postTask:spec(acts[1])},'POST')).json
  const issued=(await call(`/api/v1/accounts/${id}/trials/${reg.trialId}/tasks`,{phase:'baseline'},'POST')).json
  expect(issued.taskId).toBeTruthy();expect(issued.activity.prompt).toBeTruthy();expect(issued.activity.evaluationContract).toBeUndefined();expect(issued.activity.slots[0].accept).toBeUndefined();expect((await play(id,issued.taskId,acts[0])).status).toBe(200)
  const attempt={attemptId:'baseline-take',taskId:issued.taskId,activityId:acts[0].activityId,response:{kind:'choice',answers:{claim:'A'},text:''},conditions:cond}
  expect((await call(`/api/v1/accounts/${id}/attempts`,attempt,'POST')).status).toBe(200)
  const savedAt=c.prepare('SELECT created_at FROM learner_attempts_v3 WHERE account_id=? AND attempt_id=?').get(id,'baseline-take').created_at
  c.prepare('UPDATE issued_tasks SET expires_at=? WHERE task_id=?').run(savedAt+1,issued.taskId)
  await new Promise(resolve=>setTimeout(resolve,5))
  expect(()=>tasks.requireTask(id,issued.taskId)).toThrow('EXPIRED')
  const revised={...acts[0],version:2}
  c.prepare('UPDATE generated_activities SET definition=?,version=2 WHERE activity_id=?').run(JSON.stringify(revised),acts[0].activityId)
  const obs=await call(`/api/v1/accounts/${id}/trials/${reg.trialId}/observations`,{phase:'baseline',attemptId:'baseline-take'},'POST')
  c.prepare('UPDATE generated_activities SET definition=?,version=1 WHERE activity_id=?').run(JSON.stringify(acts[0]),acts[0].activityId)
  expect(obs.json.counted).toBe(true)
  c.prepare("UPDATE learner_attempts_v3 SET evaluation_status='disputed' WHERE account_id=? AND attempt_id=?").run(id,'baseline-take')
  const comparison=(await call(`/api/v1/accounts/${id}/trials/${reg.trialId}/compare`)).json
  expect(comparison.baseline.counted).toBe(false);expect(comparison.baseline.originallyCounted).toBe(true)
  const otherReg=(await call(`/api/v1/accounts/${id}/trials`,{skill:'listening',baselineTask:spec(acts[0]),postTask:spec(acts[1])},'POST')).json
  const again=(await call(`/api/v1/accounts/${id}/trials/${otherReg.trialId}/tasks`,{phase:'baseline'},'POST')).json
  await play(id,again.taskId,acts[0]);await call(`/api/v1/accounts/${id}/attempts`,{...attempt,taskId:again.taskId,attemptId:'later'},'POST')
  c.prepare("UPDATE learner_attempts_v3 SET evaluation_status='disputed' WHERE account_id=? AND attempt_id=?").run(id,'later')
  const disputed=await call(`/api/v1/accounts/${id}/trials/${otherReg.trialId}/observations`,{phase:'baseline',attemptId:'later'},'POST')
  expect(disputed.json.counted).toBe(false);expect(disputed.json.exposureNote).toContain('争议')
  const bad=await call(`/api/v1/accounts/${id}/trials`,{skill:'reading',baselineTask:spec(acts[0]),postTask:spec(acts[1])},'POST')
  expect(bad.status).toBe(400)
 })
})
