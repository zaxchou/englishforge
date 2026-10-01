import { beforeAll, afterAll, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let dir,db,ev,api
beforeAll(async()=>{dir=mkdtempSync(join(tmpdir(),'ef-replay-'));process.env.ENGLISHFORGE_DB=join(dir,'test.db');api=(await import('./api.mjs')).handleApi;db=await import('./db.mjs');ev=await import('./v3evidence.mjs')})
afterAll(()=>{db.closeDb();rmSync(dir,{recursive:true,force:true})})
it('historical keyword credit loses stale base row; valid closed evidence and waiver survive; originals are unchanged',async()=>{
 const id=(await api({pathname:'/api/accounts',method:'POST',body:{name:'replay-fixture'},query:new URLSearchParams()})).json.account.id
 const c=(await import('./v3db.mjs')).ensureV3Schema()
 const ins=c.prepare(`INSERT INTO evidence_events (account_id,evidence_id,attempt_id,objective_id,skill,complexity,kind,condition,pass,basis,created_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,?)`)
 ins.run(id,'old-keyword','old-listen','listening','band2','observed','first_independent',1,JSON.stringify({keywordContentCheck:true,taskFamilyId:'old'}),1)
 ins.run(id,'valid-closed','closed-read','reading','band2','observed','first_independent',1,JSON.stringify({taskFamilyId:'closed',role:'practice'}),2)
 ins.run(id,'waiver','waived-goal','speaking','band3','waive','unknown',null,'{}',3)
 c.prepare(`INSERT INTO learner_states VALUES (?,?,?,'base','trained','[]',0,0)`).run(id,'old-listen','listening')
 const original=c.prepare('SELECT * FROM evidence_events WHERE account_id=? ORDER BY evidence_id').all(id)
 ev.recomputeStates(id)
 const states=c.prepare('SELECT * FROM learner_states WHERE account_id=?').all(id)
 expect(states.some(s=>s.objective_id==='old-listen' && s.state==='trained')).toBe(false)
 expect(states.find(s=>s.objective_id==='closed-read' && s.complexity==='base').state).toBe('trained')
 expect(JSON.parse(states.find(s=>s.objective_id==='waived-goal' && s.complexity==='base').flags)).toContain('waived_by_user')
 expect(c.prepare('SELECT * FROM evidence_events WHERE account_id=? ORDER BY evidence_id').all(id)).toEqual(original)
 ev.recomputeStates(id)
 expect(c.prepare('SELECT * FROM evidence_events WHERE account_id=? ORDER BY evidence_id').all(id)).toEqual(original)
})
