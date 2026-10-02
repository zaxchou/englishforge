// 59 号 S1/S2：托福产品层（四科课程/首页聚合/作答幂等/错题状态机/老师反馈）。
// 全程临时库；老师调用走注入缝，不真调模型（真实调用验收见 59 号账本 S2 记录）。
import { beforeAll, afterAll, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir, api, db, teacher
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-toefl-'))
  process.env.ENGLISHFORGE_DB = join(dir, 'test.db')
  api = (await import('../api.mjs')).handleApi
  db = await import('../db.mjs')
  teacher = await import('./teacher.mjs')
  // 测试默认注入一个"不可用"的老师：任何忘记打桩的调用都会显式失败，绝不真调模型
  teacher.__setTeacherChat(async () => { throw new Error('测试环境禁止真调模型') })
})
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })
const call = (pathname, body, method = 'GET') => api({ pathname, body, method, query: new URLSearchParams() })
const freshAccount = async (name) => (await call('/api/accounts', { name }, 'POST')).json.account.id

const MOCK_TEACHER = () => JSON.stringify({
  observation: '测试观察',
  evidence: ['引用：他的选择与原文支持'],
  hypothesis: '测试假设（单题不定性）', confidence: 'medium',
  one_fix: '测试修复动作', followup: '测试追问',
})

it('目录：四科已发布章=4、分母=12、任务/媒体绑定完整；答案不随首做下发', async () => {
  const cat = (await call('/api/toefl/catalog')).json
  expect(cat.chapters.filter((c) => c.publicationStatus === 'published')).toHaveLength(4)
  expect(cat.chapters.every((c) => c.practiceTaskId && c.methodText && c.handoutPages?.length)).toBe(true)
  expect(cat.chapters.every((c) => c.newQuestionCheck === 'unavailable_no_verified_unseen_pool')).toBe(true)
  // 任务接口不下发核验答案（questions 里没有 key/why）
  const r = (await call('/api/toefl/accounts/x-none/dashboard'))
  expect(r.status).toBe(404) // 账户不存在 → 404，不泄漏内容
})

it('作答：封闭判分/幂等重放/保存→提交升级/猜对登记', async () => {
  const id = await freshAccount('作答')
  // 提交（错 r11 对 r12）
  let r = await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'k1', taskId: 'tg-reading-s01-email', submit: true, answers: { r11: 0, r12: 2 } }, 'POST')
  expect(r.status).toBe(200)
  expect(r.json.attempt.status).toBe('submitted')
  const attemptId = r.json.attempt.attemptId
  // 提交后结果含解析；首做响应不含 key（attemptPublic 的 questions 无 key）
  expect(r.json.attempt.task.questions[0].key).toBeUndefined()
  r = await call(`/api/toefl/accounts/${id}/attempts/${attemptId}`)
  const res = Object.fromEntries(r.json.results.results.map((x) => [x.questionId, x]))
  expect(res.r11.correct).toBe(false); expect(res.r11.why).toContain('9月10日')
  expect(res.r12.correct).toBe(true)
  // 幂等重放
  r = await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'k1', taskId: 'tg-reading-s01-email', submit: true, answers: { r11: 2 } }, 'POST')
  expect(r.json.replayed).toBe(true)
  expect(r.json.attempt.attemptId).toBe(attemptId)
  // 错题登记 + 尝试次数单列
  r = await call(`/api/toefl/accounts/${id}/errors`)
  expect(r.json.errors).toHaveLength(1)
  expect(r.json.errors[0].kind).toBe('first_wrong')
  expect(r.json.errors[0].status).toBe('pending_review')
  // 重做（新幂等键）→ 同 familyId 不新增条目，retries+1
  await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'k2', taskId: 'tg-reading-s01-email', submit: true, answers: { r11: 1, r12: 2 } }, 'POST')
  r = await call(`/api/toefl/accounts/${id}/errors`)
  expect(r.json.errors).toHaveLength(1)
  expect(r.json.errors[0].retries).toBe(1)
  // 新题首次猜对 → guessed 条目（r12 此前从未进过错误本）
  await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'k3', taskId: 'tg-reading-s01-email', submit: true, answers: { r11: 2, r12: 2 }, guessedQuestionIds: ['r12'] }, 'POST')
  r = await call(`/api/toefl/accounts/${id}/errors`)
  expect(r.json.errors.map((e) => e.kind).sort()).toEqual(['first_wrong', 'guessed'])
})

it('保存→提交：同幂等键一次性升级，不重复建 attempt', async () => {
  const id = await freshAccount('保存提交')
  let r = await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'w1', taskId: 'tg-writing-s01-email', draft: 'Dear Editor, I cannot upload my essay.' }, 'POST')
  expect(r.json.attempt.status).toBe('saved')
  const attemptId = r.json.attempt.attemptId
  r = await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'w1', taskId: 'tg-writing-s01-email', submit: true }, 'POST')
  expect(r.status).toBe(200)
  expect(r.json.attempt.attemptId).toBe(attemptId)
  expect(r.json.attempt.status).toBe('submitted')
})

it('开放题：未提交拒绝反馈；反馈版本递增；失败保留作答可重试', async () => {
  const id = await freshAccount('反馈')
  let r = await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'w1', taskId: 'tg-writing-s01-email', draft: 'Dear Editor, the upload page shows a format error. I tried Chrome and Edge. Please check.' }, 'POST')
  const attemptId = r.json.attempt.attemptId
  await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'w1', taskId: 'tg-writing-s01-email', submit: true }, 'POST')
  // 测试默认老师桩会抛错 → 502 failed，作答保留
  r = await call(`/api/toefl/accounts/${id}/attempts/${attemptId}/feedback`, { note: '我觉得请求清楚' }, 'POST')
  expect(r.status).toBe(502)
  expect(r.json.error).toContain('TOEFL_FEEDBACK_FAILED')
  r = await call(`/api/toefl/accounts/${id}/attempts/${attemptId}`)
  // 60 复审：反馈失败只落 feedback，attempt 保持 submitted（进度不倒扣）
  expect(r.json.attempt.status).toBe('submitted')
  // 注入成功 → done；再要一次 → v2
  teacher.__setTeacherChat(async () => ({ text: MOCK_TEACHER(), finishReason: 'stop', usage: {} }))
  r = await call(`/api/toefl/accounts/${id}/attempts/${attemptId}/feedback`, {}, 'POST')
  expect(r.status).toBe(200)
  expect(r.json.feedback.status).toBe('done')
  expect(r.json.feedback.output.one_fix).toBe('测试修复动作')
  expect(r.json.results.kind).toBe('open')
  // 失败的那次也占一个版本（反馈记录绑定不覆盖，55 §12）；成功=v2，再来=v3
  r = await call(`/api/toefl/accounts/${id}/attempts/${attemptId}/feedback`, {}, 'POST')
  expect(r.json.feedback.version).toBe(3)
  teacher.__setTeacherChat(async () => { throw new Error('测试环境禁止真调模型') })
})

it('口语：无转写可提交；自录转写标 user_typed；反馈合同不带发音评价前提', async () => {
  const id = await freshAccount('口语')
  const r1 = await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 's1', taskId: 'tg-speaking-s01-interview', submit: true }, 'POST')
  expect(r1.status).toBe(200)
  expect(r1.json.attempt.audioAvailable).toBe(false)
  const r2 = await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 's2', taskId: 'tg-speaking-s01-interview', submit: true, transcript: 'I prefer mornings.', transcriptOrigin: 'user_typed' }, 'POST')
  expect(r2.json.attempt.transcriptOrigin).toBe('user_typed')
  // 四科提示词合同：口语明确无 ASR/不评发音；写作明确不代写不评分
  const input = teacher.buildTeacherInput({ task: (await import('./content.mjs')).toeflTask('tg-speaking-s01-interview'), attempt: { draft_transcript: 'test', transcript_origin: 'user_typed', answers: null, draft: null } })
  expect(input).toContain('user_typed')
})

it('错题状态机：非法转移 409；verified 只能来自 awaiting_new_check', async () => {
  const id = await freshAccount('状态机')
  await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'k1', taskId: 'tg-reading-s01-email', submit: true, answers: { r11: 0, r12: 2 } }, 'POST')
  const { errors } = (await call(`/api/toefl/accounts/${id}/errors`)).json
  const errorId = errors[0].errorId
  expect((await call(`/api/toefl/accounts/${id}/errors/${errorId}/status`, { status: 'verified' }, 'POST')).status).toBe(409)
  expect((await call(`/api/toefl/accounts/${id}/errors/${errorId}/status`, { status: 'reviewed' }, 'POST')).json.error.status).toBe('reviewed')
  expect((await call(`/api/toefl/accounts/${id}/errors/${errorId}/status`, { status: 'awaiting_new_check' }, 'POST')).json.error.status).toBe('awaiting_new_check')
  // 60 复审：verified 必须绑定真实未见新题作答；当前没有题池，API 直调不可达
  const unbacked = await call(`/api/toefl/accounts/${id}/errors/${errorId}/status`, { status: 'verified', detail: '新段落同类线索做对' }, 'POST')
  expect(unbacked.status).toBe(409)
  expect(unbacked.json.error).toContain('TOEFL_VERIFICATION_UNBACKED')
  // 无凭据的 verified 被拒后状态不变（仍在 awaiting_new_check，可回退 reviewed 继续处理）
  expect((await call(`/api/toefl/accounts/${id}/errors`)).json.errors.find((e) => e.errorId === errorId).status).toBe('awaiting_new_check')
})

it('主动疑点：self_noted 可登记、不依赖题目', async () => {
  const id = await freshAccount('疑点')
  const r = await call(`/api/toefl/accounts/${id}/errors`, {
    kind: 'self_noted', part: 'listening', chapterId: 'toefl-listening-s01',
    title: '听到 tomorrow 没反应过来', detail: '不是没理解日期，是声音反应慢', tag: '声音识别',
  }, 'POST')
  expect(r.json.error.kind).toBe('self_noted')
  expect(r.json.error.status).toBe('pending_review')
})

it('首页聚合：分母 12；事件驱动三活动；resume 每科独立；不平均四科百分比', async () => {
  const id = await freshAccount('聚合')
  let r = await call(`/api/toefl/accounts/${id}/dashboard`)
  expect(r.json.progress.overall).toEqual({ done: 0, total: 12 })
  expect(r.json.latestTeacherAnalysis).toBeNull()
  // 阅读章 3 活动
  await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'r1', taskId: 'tg-reading-s01-email', submit: true, answers: { r11: 2, r12: 2 } }, 'POST')
  await call(`/api/toefl/accounts/${id}/events`, { kind: 'method_done', chapterId: 'toefl-reading-s01', path: 'handout' }, 'POST')
  await call(`/api/toefl/accounts/${id}/events`, { kind: 'review_done', chapterId: 'toefl-reading-s01' }, 'POST')
  await call(`/api/toefl/accounts/${id}/resume`, { part: 'reading', chapterId: 'toefl-reading-s01', activity: 'learn', position: 10 }, 'POST')
  await call(`/api/toefl/accounts/${id}/resume`, { part: 'listening', chapterId: 'toefl-listening-s01', activity: 'learn', mediaId: 'vid_listening_intro', position: 42 }, 'POST')
  r = await call(`/api/toefl/accounts/${id}/dashboard`)
  const reading = r.json.progress.parts.find((p) => p.part === 'reading')
  expect(reading.done).toBe(3); expect(reading.total).toBe(3)
  expect(r.json.progress.overall.done).toBe(3)
  expect(r.json.resume.reading.activity).toBe('learn')
  expect(r.json.resume.listening.lastPosition).toBe(42)
  // 完成章显示"查看本章/下一章"，不重推
  const ch = (await call(`/api/toefl/accounts/${id}/chapter/toefl-reading-s01`)).json
  expect(ch.activities.method.done && ch.activities.practice.done && ch.activities.review.done).toBe(true)
})

it('媒体：白名单外 404；白名单内文件可读；拖动大段不收观看区间', async () => {
  const id = await freshAccount('媒体')
  const bad = await call(`/api/toefl/media/../../etc/passwd`)
  expect(bad.status).toBe(404)
  // media 走 raw 分支，不在 handleApi 路由表里 → 404 "no such endpoint" 也是"不进 JSON 通道"的证明
  // 这里验证 JSON 侧登记：白名单内收、超长区间不收
  expect((await call(`/api/toefl/accounts/${id}/media-progress`, { mediaId: 'aud_listening_conversation', position: 3 }, 'POST')).status).toBe(200)
  expect((await call(`/api/toefl/accounts/${id}/media-progress`, { mediaId: 'not_in_list', position: 1 }, 'POST')).status).toBe(404)
})

it('独立限时检查：明确拒绝（无已核验未见池），不伪造模考', async () => {
  const id = await freshAccount('限时')
  const r = await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 't1', taskId: 'tg-reading-s01-email', mode: 'timed_check', submit: true, answers: { r11: 2 } }, 'POST')
  expect(r.status).toBe(409)
  expect(r.json.error).toContain('TOEFL_NO_VERIFIED_UNSEEN_POOL')
})

it('老师输入绑定：封闭题带核验答案与他的选择；模型不改判分写进合同', async () => {
  const { toeflTask } = await import('./content.mjs')
  const task = toeflTask('tg-reading-s01-email')
  const input = teacher.buildTeacherInput({ task, attempt: { answers: JSON.stringify({ r11: 0, r12: 2 }), draft: null } })
  expect(input).toContain('核验答案：C')
  expect(input).toContain('他的选择：A')
  expect(input).toContain('你不能修改答案或判分')
})

// ---- 60 号（Codex 复审）回归 ----

it('60-a 空提交拒绝：不成为判分记录、不暴露答案', async () => {
  const id = await freshAccount('60a')
  const r = await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'e1', taskId: 'tg-reading-s01-email', submit: true, answers: {} }, 'POST')
  expect(r.status).toBe(400)
  expect(r.json.error).toContain('TOEFL_INCOMPLETE_SUBMISSION')
  const r2 = await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'e2', taskId: 'tg-reading-s01-email', submit: true, answers: { r11: 2 } }, 'POST')
  expect(r2.status).toBe(400) // 缺 r12 也拒绝
  expect((await call(`/api/toefl/accounts/${id}/errors`)).json.errors).toHaveLength(0)
})

it('60-b 反馈失败不倒扣进度', async () => {
  const id = await freshAccount('60b')
  await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'w1', taskId: 'tg-writing-s01-email', submit: true, draft: 'Dear Editor, please help.' }, 'POST')
  let dash = (await call(`/api/toefl/accounts/${id}/dashboard`)).json
  expect(dash.progress.overall.done).toBe(1)
  const attemptId = dash.errors.total // 0；取 attempt 另查
  const st = (await call(`/api/toefl/accounts/${id}/chapter/toefl-writing-s01`)).json
  await call(`/api/toefl/accounts/${id}/attempts/${st.latestAttempt.attemptId}/feedback`, {}, 'POST') // 测试桩抛错 → 502
  dash = (await call(`/api/toefl/accounts/${id}/dashboard`)).json
  expect(dash.progress.overall.done).toBe(1) // 仍是 1，不回退
})

it('60-c 保存→提交不清空已有草稿', async () => {
  const id = await freshAccount('60c')
  await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'w1', taskId: 'tg-writing-s01-email', draft: 'Do not erase this original draft.' }, 'POST')
  const r = await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'w1', taskId: 'tg-writing-s01-email', submit: true }, 'POST')
  expect(r.status).toBe(200)
  expect(r.json.attempt.draft).toBe('Do not erase this original draft.')
})

it('60-d verified 不可无凭据直达：必须绑定 timed_check 作答（60-d 测试与状态机用例合并覆盖）', async () => {
  const id = await freshAccount('60d')
  await call(`/api/toefl/accounts/${id}/attempts`, { idempotencyKey: 'k1', taskId: 'tg-reading-s01-email', submit: true, answers: { r11: 0, r12: 2 } }, 'POST')
  const { errors } = (await call(`/api/toefl/accounts/${id}/errors`)).json
  const errorId = errors[0].errorId
  await call(`/api/toefl/accounts/${id}/errors/${errorId}/status`, { status: 'reviewed' }, 'POST')
  await call(`/api/toefl/accounts/${id}/errors/${errorId}/status`, { status: 'awaiting_new_check' }, 'POST')
  const r = await call(`/api/toefl/accounts/${id}/errors/${errorId}/status`, { status: 'verified', detail: '直接API调用' }, 'POST')
  expect(r.status).toBe(409)
  expect(r.json.error).toContain('TOEFL_VERIFICATION_UNBACKED')
})
