import { beforeAll, afterAll, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let dir,db,api
beforeAll(async()=>{dir=mkdtempSync(join(tmpdir(),'ef-oral-retry-'));process.env.ENGLISHFORGE_DB=join(dir,'test.db');api=(await import('./api.mjs')).handleApi;db=await import('./db.mjs')})
afterAll(()=>{db.closeDb();rmSync(dir,{recursive:true,force:true})})
const call=(pathname,body,method='GET')=>api({pathname,body,method,query:new URLSearchParams()})
function wav(){const b=Buffer.alloc(32044);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(32000,40);return b}
it('lost upload/attempt responses reuse one asset and one transcript; changed request is rejected',async()=>{
 const id=(await call('/api/accounts',{name:'retry'},'POST')).json.account.id
 await call('/api/v1/map');await call('/api/v1/lessons')
 const pkg=(await call(`/api/v1/accounts/${id}/lessons/les-oral-v1`)).json
 const a=pkg.activities[0],bytes=wav(),spec={requestId:'one-upload',activityId:a.activityId,mime:'audio/wav',bytes:bytes.length,durationMs:1000}
 const intent=(await call(`/api/v1/accounts/${id}/oral/intent`,spec,'POST')).json
 try {
  expect((await call(`/api/v1/accounts/${id}/oral/intent`,spec,'POST')).json.mediaId).toBe(intent.mediaId)
  const put=await api({pathname:intent.uploadUrl,method:'PUT',body:bytes,query:new URLSearchParams({token:intent.token})});expect(put.status).toBe(200)
  const retry=(await call(`/api/v1/accounts/${id}/oral/intent`,spec,'POST')).json
  expect(retry.uploaded).toBe(true);expect(retry.mediaId).toBe(intent.mediaId);expect(retry.token).toBeNull()
  expect((await call(`/api/v1/accounts/${id}/oral/intent`,{...spec,bytes:spec.bytes+1},'POST')).status).toBe(409)
  const body={attemptId:'one-oral-take',taskId:a.taskId,activityId:a.activityId,mediaId:intent.mediaId,transcript:'The map worked but visitors needed different information.',transcriptOrigin:'user_typed',conditions:{firstExposure:true,hintLevel:0,lookupUsed:false,responseMode:'oral_recording'}}
  expect((await call(`/api/v1/accounts/${id}/attempts/oral`,body,'POST')).status).toBe(200)
  expect((await call(`/api/v1/accounts/${id}/attempts/oral`,body,'POST')).json.replayed).toBe(true)
  expect((await call(`/api/v1/accounts/${id}/attempts/oral`,{...body,transcript:'changed'},'POST')).status).toBe(409)
  const c=db.getDb();expect(c.prepare('SELECT COUNT(*) n FROM media_assets WHERE account_id=?').get(id).n).toBe(1)
  expect(c.prepare('SELECT COUNT(*) n FROM learner_attempts_v3 WHERE account_id=?').get(id).n).toBe(1)
  expect(JSON.parse(c.prepare('SELECT transcript_versions FROM media_assets WHERE media_id=?').get(intent.mediaId).transcript_versions)).toHaveLength(1)
 }finally{await call(`/api/v1/accounts/${id}/oral/${intent.mediaId}`,undefined,'DELETE')}
})
