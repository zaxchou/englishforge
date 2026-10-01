// 46 号回归：AI 批改（机械规则降为参考）。全程注入 chat，零真实调用、零费用。
// 验证：意思对但词表拒 → AI 判对（displayPass 翻正、随作答落库、重放不重复调用）；
// 词全有但意思错 → AI 判错（覆盖机械通过）；口述转写宽容批改；AI 不可用回落机械；
// 开关关闭不调用；诊断题不调用；AI 结论随 resume 返回。
import { beforeAll, afterAll, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir, db, ev, api, grader
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-grader-'))
  process.env.ENGLISHFORGE_DB = join(dir, 'test.db')
  api = (await import('./api.mjs')).handleApi
  db = await import('./db.mjs')
  ev = await import('./v3evidence.mjs')
  grader = await import('./v3grader.mjs')
})
afterAll(() => { delete process.env.ENGLISHFORGE_DB; delete process.env.ENGLISHFORGE_V4_AI_GRADER; db.closeDb(); rmSync(dir, { recursive: true, force: true }) })
const call = (pathname, body, method = 'GET') => api({ pathname, body, method, query: new URLSearchParams() })
const c = () => db.getDb()

const freshAccount = async (name) => {
  const id = (await call('/api/accounts', { name }, 'POST')).json.account.id
  await call('/api/v1/map')
  return id
}
const attempt = (id, actId, text, tag = '1', extra = {}) => call(`/api/v1/accounts/${id}/attempts`, {
  attemptId: `gr-${actId}-${tag}`, activityId: actId, response: { kind: 'text', text },
  conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary', ...extra },
}, 'POST')

it('AI 批改：意思对但词表拒 → 判对、displayPass 翻正、结论落库、重放不再调用', async () => {
  const id = await freshAccount('批改-意思对')
  let calls = 0
  grader.__setGraderChat(async () => {
    calls++
    return JSON.stringify({ verdict: 'correct', feedback: '意思说到位了：保留了手势、推迟了语音，限制说得很清楚。', agreesWithMechanical: false })
  })
  // g3c_paraphrase_recover：换一种没有任何词表锚点的说法（机械必判不过）
  const r = await attempt(id, 'g3c_paraphrase_recover', '他们决定先只用按钮那种玩法，出声的那种等去过现场再说。', 'ai1')
  expect(r.status).toBe(200)
  expect(r.json.aiReview).not.toBeNull()
  expect(r.json.aiReview.verdict).toBe('correct')
  expect(r.json.aiReview.feedback).toContain('意思')
  expect(r.json.displayPass).toBe(true) // 机械判false，AI 按意思翻正
  expect(calls).toBe(1)
  // 幂等重放：不再次调用 AI，返回落库的结论
  const replay = await attempt(id, 'g3c_paraphrase_recover', '他们决定先只用按钮那种玩法，出声的那种等去过现场再说。', 'ai1')
  expect(replay.json.aiReview.verdict).toBe('correct')
  expect(calls).toBe(1)
  // resume 同样带 AI 结论
  grader.__setGraderChat(null)
})

it('AI 批改：词全有但意思错 → AI 判错覆盖机械通过；AI 不可用回落机械；开关关闭不调用', async () => {
  const id = await freshAccount('批改-意思错')
  // 机械会判过的词表堆砌，AI 判为曲解
  grader.__setGraderChat(async () => JSON.stringify({ verdict: 'incorrect', feedback: '要点词都抄上来了，但把"推迟"说成了"取消"——限制不是不用语音。', agreesWithMechanical: false }))
  const r = await attempt(id, 'g3c_paraphrase_recover', '保留 手势 推迟 语音 展厅 考试周——把这些词全堆上。', 'ai2')
  expect(r.json.displayPass).toBe(false) // AI 为主：机械过也不算对
  expect(r.json.aiReview.verdict).toBe('incorrect')
  grader.__setGraderChat(null)
  // AI 不可用（chat 抛错）→ 回落机械：机械过则 displayPass=机械 pass
  grader.__setGraderChat(async () => { throw new Error('AI 服务不可用') })
  const fallback = await attempt(id, 'g3c_write_limit', '语音当时失灵是因为人多；所以先推迟到展厅测过再定。这只是先测再定，不代表语音方案不行。', 'ai3')
  expect(fallback.json.aiReview).toBeNull()
  expect(fallback.json.displayPass).toBe(fallback.json.pass)
  // 开关关闭 → 不调用（chat 注入计数为 0）
  process.env.ENGLISHFORGE_V4_AI_GRADER = '0'
  let calls = 0
  grader.__setGraderChat(async () => { calls++; return JSON.stringify({ verdict: 'correct', feedback: 'x', agreesWithMechanical: true }) })
  const off = await attempt(id, 'g3c_write_limit', '语音失灵是因为人多；先在展厅测过再定，不是语音不行。', 'ai4')
  expect(off.json.aiReview).toBeNull()
  expect(calls).toBe(0)
  delete process.env.ENGLISHFORGE_V4_AI_GRADER
  grader.__setGraderChat(null)
})

it('口述作答（转写稿）同样走 AI 批改；诊断题不调用；结论随 resume 返回', async () => {
  const id = await freshAccount('批改-口述')
  let seenPrompt = ''
  grader.__setGraderChat(async (msgs) => {
    seenPrompt = msgs[0].content
    return JSON.stringify({ verdict: 'correct', feedback: '转写里能看出来你把决定和条件都说清了，转写错字不影响。', agreesWithMechanical: true })
  })
  // o1a 是口述题（oral route 或文本路径都可；这里走文本路径等价于转写稿批改）
  const plan = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: `gr-${id}` }, 'POST')).json.decision
  c().prepare("UPDATE plan_decisions SET served_lesson_id = 'les-oral-c1', status = 'ready', lesson_ref = ? WHERE decision_id = ?")
    .run(JSON.stringify({ lesson: { lessonId: 'les-oral-c1', version: 1, status: 'published', devSample: true, contentPreview: false }, fallback: null }), plan.decisionId)
  const pkg = (await call(`/api/v1/accounts/${id}/lessons/les-oral-c1`)).json
  const o1a = pkg.activities[0]
  const r = await call(`/api/v1/accounts/${id}/attempts`, {
    attemptId: `gr-${o1a.activityId}`, taskId: o1a.taskId, activityId: o1a.activityId,
    response: { kind: 'text', text: "We move the stand-up to Saturday morning because Wednesday has class conflict. If someone can't come, we record it." },
    conditions: { firstExposure: true, hintLevel: 0, responseMode: 'typed_summary' },
  }, 'POST')
  expect(r.json.aiReview.verdict).toBe('correct')
  expect(seenPrompt).toContain('转写稿可能有听写错误') // 口语宽容指令在提示里
  expect(r.json.displayPass).toBe(true)
  // 诊断题不调用 AI（角色守卫）
  let calls = 0
  grader.__setGraderChat(async () => { calls++; return JSON.stringify({ verdict: 'correct', feedback: 'x', agreesWithMechanical: true }) })
  await attempt(id, 'diag_d1_read', '他们做了一个展览。', 'diag')
  expect(calls).toBe(0)
  grader.__setGraderChat(null)
  // resume 返回落库的 AI 结论
  const pkg2 = (await call(`/api/v1/accounts/${id}/lessons/les-oral-c1`)).json
  expect(pkg2.activities[0].resume.result.aiReview.verdict).toBe('correct')
})
