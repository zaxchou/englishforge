// 49 号回归：成长作品页数据（真实配对/空态/不可比/缺录音/两账号隔离）。
// 全程临时库；模型零调用（AI 批改注入或关闭）。
import { beforeAll, afterAll, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir, db, api, works
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-works-'))
  process.env.ENGLISHFORGE_DB = join(dir, 'test.db')
  process.env.ENGLISHFORGE_V4_AI_GRADER = '0'
  api = (await import('./api.mjs')).handleApi
  db = await import('./db.mjs')
  works = await import('./v3works.mjs')
})
afterAll(() => {
  delete process.env.ENGLISHFORGE_DB; delete process.env.ENGLISHFORGE_V4_AI_GRADER
  db.closeDb(); rmSync(dir, { recursive: true, force: true })
})
const call = (pathname, body, method = 'GET') => api({ pathname, body, method, query: new URLSearchParams() })
const c = () => db.getDb()
const freshAccount = async (name) => {
  const id = (await call('/api/accounts', { name }, 'POST')).json.account.id
  await call('/api/v1/map')
  return id
}
// 直接按 recordAttempt 的落库形状插入 evaluated 作答（作品数据层单元边界；完整作答流在其他测试覆盖）
const insertAttempt = (id, attemptId, activityId, { text, mediaId = null, hintLevel = 0, transcriptShown = false, firstExposure = true, pass = true, at, objectiveId = 'O-K115-03' }) => {
  c().prepare("SELECT COUNT(*) FROM learner_attempts_v3").get() // 触发 schema
  c().prepare(`INSERT INTO learner_attempts_v3 (account_id, attempt_id, session_id, activity_id, activity_version,
      objective_ids, task_family_id, role, response_kind, response, conditions, evaluation_status,
      evaluation, disputed_reason, body_hash, created_at, activity_snapshot)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, attemptId, '', activityId, 1, JSON.stringify([objectiveId]), 'seed-family', 'practice', 'text',
    JSON.stringify({ kind: 'text', text, mediaId }),
    JSON.stringify({ firstExposure, hintLevel, transcriptShown, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' }),
    'evaluated',
    JSON.stringify({ pass, keywordOnly: true, relations: [{ id: 'kept', label: '保留手势', hit: pass, required: true }], ...(mediaId ? {} : {}) }),
    null, 'hash-' + attemptId, at,
    JSON.stringify({}))
}

it('作品数据：零作品真实空态；单作品不配对；同目标"需要提示→独立完成"才配对；不可比不硬凑', async () => {
  const id = await freshAccount('作品-空态')
  // 零作品：结构在、内容真实空
  const empty = (await call(`/api/v1/accounts/${id}/works`)).json
  expect(empty.totalWorks).toBe(0)
  expect(empty.pair).toBeNull()
  expect(empty.adjustments.reduce.real).toBe(false)
  expect(empty.adjustments.reduce.title).toBe('还没有形成')
  // 单作品：列出但不配对
  insertAttempt(id, 'w1', 'g3c_paraphrase_recover', { text: '他们留了一半，另一半推迟。', hintLevel: 1, pass: true, at: 1000 })
  const single = (await call(`/api/v1/accounts/${id}/works`)).json
  expect(single.totalWorks).toBe(1)
  expect(single.pair).toBeNull()
  expect(single.recent.length).toBe(1)
  // 建一次真实规划（保留卡的依据=当前推荐）
  await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: `w-${id}` }, 'POST')
  // 同目标：需要提示(没过) → 独立(过了) → 配对成立
  insertAttempt(id, 'w2', 'g3c_paraphrase_recover', { text: '我们留下了手势控制，语音先缓一缓——先在展厅试过再决定，不是永久放弃。', firstExposure: true, hintLevel: 0, pass: true, at: 2000 })
  const paired = (await call(`/api/v1/accounts/${id}/works`)).json
  expect(paired.pair).not.toBeNull()
  expect(paired.pair.old.attemptId).toBe('w1')
  expect(paired.pair.old.label).toBe('需要提示')
  // 49 号实测补充：第一次没通过的独立尝试优先标"第一次没通过"，不冒充独立完成
  insertAttempt(id, 'w4', 'g3c_principle_pick', { text: '这句话只是对照，没有划范围。', firstExposure: true, hintLevel: 0, pass: false, at: 2500 })
  const afterFail = (await call(`/api/v1/accounts/${id}/works`)).json
  const w4 = afterFail.recent.find((r) => r.attemptId === 'w4')
  expect(w4.label).toBe('第一次没通过')
  expect(paired.pair.new.attemptId).toBe('w2')
  expect(paired.pair.new.label).toBe('独立完成')
  // 配对后减少卡变"真实"（依据=这对记录）
  expect(paired.adjustments.reduce.real).toBe(true)
  expect(paired.adjustments.keep.real).toBe(true)
  // 不可比：另一个目标的两次记录不与新目标硬凑（配对已取最近目标组，其他列 recent）
  insertAttempt(id, 'w3', 'm1_transfer_write', { text: '去掉 who 部分，句子指的还是那位助手——是补充信息。', firstExposure: true, hintLevel: 0, pass: true, at: 3000, objectiveId: 'O-K115-01' })
  const multi = (await call(`/api/v1/accounts/${id}/works`)).json
  expect(multi.pair.old.attemptId).toBe('w1') // 配对保持 w1→w2（同目标才配对；w3 是另一目标，不硬凑）
  expect(multi.recent.some((r) => r.attemptId === 'w3')).toBe(true)
})

it('作品数据：录音缺失如实标注；录音在则带 mediaId；两账号互不可见', async () => {
  const idA = await freshAccount('作品-A')
  const idB = await freshAccount('作品-B')
  insertAttempt(idA, 'wa-1', 'o1a_schedule_decision', { text: '我们改到周六上午。', mediaId: 'oral_media_1', hintLevel: 0, pass: true, at: 5000 })
  insertAttempt(idB, 'wb-1', 'o1a_schedule_decision', { text: 'B 的回答。', hintLevel: 0, pass: true, at: 6000 })
  const a = (await call(`/api/v1/accounts/${idA}/works`)).json
  expect(a.totalWorks).toBe(1)
  expect(a.recent[0].mediaId).toBe('oral_media_1')
  expect(a.recent[0].oral).toBe(true)
  const b = (await call(`/api/v1/accounts/${idB}/works`)).json
  expect(b.totalWorks).toBe(1)
  expect(b.recent[0].text).toBe('B 的回答。') // B 看不到 A 的作品
  expect(b.recent[0].mediaId).toBeNull() // B 的这条没有录音 → 缺失如实
})
