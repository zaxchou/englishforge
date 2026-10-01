// 38 号产品交付回归：O-K115-03 后继课程链（短讲→输入→挑战恢复→输出→迁移→连续推进）。
// 全程临时库；验证的是学习者真实走法（serve→作答→提示重试→完成→下一课可学）。
import { beforeAll, afterAll, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir, db, lessons, api
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-chain-'))
  process.env.ENGLISHFORGE_DB = join(dir, 'test.db')
  process.env.ENGLISHFORGE_V4_GENERATION = '1'
  api = (await import('./api.mjs')).handleApi
  db = await import('./db.mjs')
  lessons = await import('./v3lessons.mjs')
})
afterAll(() => { delete process.env.ENGLISHFORGE_V4_GENERATION; db.closeDb(); rmSync(dir, { recursive: true, force: true }) })
const call = (pathname, body, method = 'GET') => api({ pathname, body, method, query: new URLSearchParams() })
const c = () => db.getDb()

// accept/options 只在本地注册表（公开课包不带合同，防泄露）——测试同走查取法
const registry = JSON.parse(readFileSync(new URL('./data/v3-activities.json', import.meta.url), 'utf8'))
const regById = (aid) => registry.activities.find((x) => x.activityId === aid)
const slotAnswers = (aid) => Object.fromEntries((regById(aid)?.evaluationContract?.slots ?? []).map((s) => [s.slotId, s.accept]))
const slotWrong = (aid) => Object.fromEntries((regById(aid)?.evaluationContract?.slots ?? []).map((s) => [s.slotId, s.options.find((o) => o !== s.accept) ?? s.accept]))

const freshAccount = async (name) => {
  const id = (await call('/api/accounts', { name }, 'POST')).json.account.id
  await call('/api/v1/map')
  return id
}

const answer = async (id, lessonId, act, response, attemptTag, hintLevel = 0) => call(`/api/v1/accounts/${id}/attempts`, {
  attemptId: `ch-${lessonId}-${act.activityId}-${attemptTag}`, taskId: act.taskId, activityId: act.activityId,
  response,
  conditions: { firstExposure: attemptTag === 'r1', hintLevel, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
}, 'POST')

it('链路种子：两节课都过质量门并发布（dev_only）；A 的后继指向 B', async () => {
  await call('/api/v1/lessons')
  const rows = lessons.listLessons().filter((l) => l.lessonId.startsWith('les-claim-limit-c'))
  expect(rows.length).toBe(2)
  for (const l of rows) expect(l.contentStatus).toBe('published')
  const c1 = lessons.getLesson('les-claim-limit-c1')
  expect(c1.nextCandidates).toContain('les-claim-limit-c2')
  expect(c1.activities.length).toBe(5) // 短讲→输入→挑战恢复→输出→迁移
  const c2 = lessons.getLesson('les-claim-limit-c2')
  expect(c2.activities.length).toBe(2)
})

it('完整链路：A 的五步全走通（含材料下发、槽位判题、写作诚实标注、迁移），完成后 B 可学', async () => {
  const id = await freshAccount('链路-完整')
  // 用户画像前置：旧关系课（les-relations-v1，v2 排序在前）已完成——正是 38 号"从 O-K115-03 出发"的起点
  c().prepare("INSERT INTO plan_decisions (account_id, decision_id, request_id, map_version, evidence_version, snapshot, candidates, primary_goal, strategy_id, reason, hypotheses, uncertain_areas, lesson_ref, served_lesson_id, status, created_at) VALUES (?,?,?,'map-v1',0,'[]','[]','O-K115-01','short_explain','seed','','[]','{}','les-relations-v1','completed',?)")
    .run(id, `pd-seed-${id}`, `seed-${id}`, Date.now())
  // 推荐指向 A（模拟 les-relations-v1 已完成后的状态：直接把决策的 served_lesson_id 指到 c1）
  const plan = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: `chain-${id}` }, 'POST')).json.decision
  c().prepare("UPDATE plan_decisions SET served_lesson_id = 'les-claim-limit-c1', status = 'ready' WHERE decision_id = ?").run(plan.decisionId)
  const pkg = (await call(`/api/v1/accounts/${id}/lessons/les-claim-limit-c1`)).json
  expect(pkg.title).toContain('主张、对照和限制')
  expect(pkg.activities.length).toBe(5)
  // 第 1 步（短讲+原理确认）：30 秒短讲在题面里（主张/对照/让步/限制的区别，禁位置口诀）
  const a1 = pkg.activities[0]
  expect(a1.prompt).toContain('but/although 后面不一定是限制')
  expect(a1.prompt).toContain('our assumption about what visitors wanted was incomplete')
  expect(a1.slots.length).toBe(2)
  // 答错 → 逐槽反馈；答对 → O-K115-03 met（封闭认证）
  const bad1 = await answer(id, pkg.lessonId, a1, { kind: 'choice', text: '', answers: slotWrong(a1.activityId) }, 'bad')
  expect(bad1.json.pass).toBe(false)
  expect(bad1.json.slotResults.every((s) => s.status === 'wrong')).toBe(true)
  const good1 = await answer(id, pkg.lessonId, a1, { kind: 'choice', text: '', answers: slotAnswers(a1.activityId) }, 'r1')
  expect(good1.json.pass).toBe(true)
  expect(good1.json.objectiveResults['O-K115-03']).toBe('met')
  // 第 2 步（输入·排练段）：槽位+理由栏；理由漏掉 → 选择对但理由未测（slotOnly 中性）
  const a2 = pkg.activities[1]
  expect(a2.material.segments[0].text).toContain('voice prototype')
  const good2 = await answer(id, pkg.lessonId, a2, { kind: 'choice', text: '', answers: slotAnswers(a2.activityId) }, 'r1')
  expect(good2.json.pass).toBe(true)
  expect(good2.json.objectiveResults['O-K115-03']).toBe('partial') // 理由栏未作答：不冒充完全掌握
  // 第 3 步（挑战与恢复）：正确意思但漏了词表锚点 → 不通过 → 逐层提示（第 3 层给可用词族）→ 用提示方向的词重试 → 通过
  const a3 = pkg.activities[2]
  const miss = await answer(id, pkg.lessonId, a3, { kind: 'text', text: '他们留了一半，另一半再等等看情况。' }, 'r1')
  expect(miss.json.pass).toBe(false)
  expect(miss.json.practiceOnly).toBe(true) // 开放题=练习反馈（诚实标注）
  for (let lvl = 1; lvl <= 3; lvl++) {
    const h = await call(`/api/v1/accounts/${id}/lessons/${pkg.lessonId}/hints`, { activityId: a3.activityId, level: lvl }, 'POST')
    expect(h.json.hint.length).toBeGreaterThan(4)
  }
  const retry = await answer(id, pkg.lessonId, a3, { kind: 'text', text: '我们保留了手势，语音先缓一缓——先在展厅让人多的时候试过再决定，不是永久放弃。' }, 'r2', 3)
  expect(retry.json.pass).toBe(true) // 恢复路径：提示后等义表达通过
  // 照抄原文 → mustNot 违规被拒（要用你自己的话）
  const copy = await answer(id, pkg.lessonId, a3, { kind: 'text', text: 'We kept the gesture controls, but we delayed voice control until we could test it with visitors in the exhibition hall.' }, 'r3')
  expect(copy.json.pass).toBe(false)
  expect(copy.json.mustNotViolations.join(';')).toContain('照抄')
  // 第 4 步（输出·写作）：写作练习反馈如实践习标注
  const a4 = pkg.activities[3]
  const good4 = await answer(id, pkg.lessonId, a4, { kind: 'text', text: '语音当时失灵是因为人多、好几个观众同时说话；所以先推迟到展厅测过再定。这只是先测再定，不代表语音方案不行。' }, 'r1')
  expect(good4.json.pass).toBe(true)
  expect(good4.json.practiceOnly).toBe(true)
  // 第 5 步（迁移·放映段）：换材料+换任务形状（判断句子在做什么），slots+理由
  const a5 = pkg.activities[4]
  expect(a5.role).toBe('transfer')
  expect(a5.material.segments[0].text).toContain('noisy lobby')
  const good5 = await answer(id, pkg.lessonId, a5, { kind: 'choice', text: '第一句只是对照；第二句只是推迟配音测试，不是影片不行。', answers: slotAnswers(a5.activityId) }, 'r1')
  expect(good5.json.pass).toBe(true)
  // 完成 → 重算 → B 可学（lessonForObjective 跳过已完成的 A，返回 B）
  const done = await call(`/api/v1/accounts/${id}/lessons/${pkg.lessonId}/complete`, {}, 'POST')
  expect(done.json.ok).toBe(true)
  const next = lessons.lessonForObjective('O-K115-03', { excludeCompletedFor: id })
  expect(next.lessonId).toBe('les-claim-limit-c2')
  // 完成后的推荐决策可打开 B（若主目标仍是 O-K115-03；主目标移动则今日卡有生成/备用路径兜底）
  const planView = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
  if (planView.primaryGoal === 'O-K115-03') expect(planView.lesson.lessonId).toBe('les-claim-limit-c2')
})

it('B 课可学：新情境（博物馆地图）两步全部可答；与 A 是不同材料', async () => {
  const id = await freshAccount('链路-B课')
  const plan = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: `chainb-${id}` }, 'POST')).json.decision
  c().prepare("UPDATE plan_decisions SET served_lesson_id = 'les-claim-limit-c2', status = 'ready' WHERE decision_id = ?").run(plan.decisionId)
  const pkg = (await call(`/api/v1/accounts/${id}/lessons/les-claim-limit-c2`)).json
  expect(pkg.activities.length).toBe(2)
  expect(pkg.activities[0].material.segments[0].text).toContain('We made a map')
  const b1 = await answer(id, pkg.lessonId, pkg.activities[0], { kind: 'choice', text: '地图没坏，是团队的预期不完整。', answers: slotAnswers(pkg.activities[0].activityId) }, 'r1')
  expect(b1.json.pass).toBe(true)
  const b2 = await answer(id, pkg.lessonId, pkg.activities[1], { kind: 'text', text: '地图一直按设计在运行；不完整的是我们对访客想要什么的假设。下一步先去问访客为什么这样选路线，再决定要不要改。' }, 'r1')
  expect(b2.json.pass).toBe(true)
  expect(b2.json.practiceOnly).toBe(true)
  const done = await call(`/api/v1/accounts/${id}/lessons/${pkg.lessonId}/complete`, {}, 'POST')
  expect(done.json.ok).toBe(true)
})

it('审核状态一致性：策划链是开发样本（无模型审核），页面标"开发样本"而不是"内容试验预览"', async () => {
  const id = await freshAccount('链路-标记')
  const pkg = (await call(`/api/v1/accounts/${id}/lessons/les-claim-limit-c1`)).json
  expect(pkg.devSampleNotice).toContain('开发样本')
  expect(pkg.devSampleNotice).not.toContain('内容试验预览')
  expect(pkg.contentReview.preview).toBe(false)
  expect(pkg.contentReview.humanSignPending).toBe(true)
})
