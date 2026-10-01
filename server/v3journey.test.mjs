// 47 号回归：段位纯函数（真实记录算段位，不造假百分比）+ 学习路线接口。
import { beforeAll, afterAll, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir, db, api, journey
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-journey-'))
  process.env.ENGLISHFORGE_DB = join(dir, 'test.db')
  api = (await import('./api.mjs')).handleApi
  db = await import('./db.mjs')
  journey = await import('./v3journey.mjs')
})
afterAll(() => { delete process.env.ENGLISHFORGE_DB; db.closeDb(); rmSync(dir, { recursive: true, force: true }) })
const call = (pathname, body, method = 'GET') => api({ pathname, body, method, query: new URLSearchParams() })
const c = () => db.getDb()

const st = (objectiveId, skill, state, flags = '[]') => ({ objectiveId, skill, complexity: 'base', state, flags })

it('段位纯函数：48 号五个反例逐项锁定；条件按实际缺口动态生成', () => {
  // 零记录 → 起步者
  expect(journey.computeLevel([], 0).level).toBe('起步者')
  // 完成 1 课 → 入门了
  expect(journey.computeLevel([], 1).level).toBe('入门了')
  // 2 课 + growth≥5 → 上手了
  const g5 = [st('a', 'reading', 'trained'), st('b', 'reading', 'trained'), st('c', 'reading', 'independent'), st('d', 'reading', 'trained'), st('e', 'reading', 'trained')]
  const lv3 = journey.computeLevel(g5, 2)
  expect(lv3.level).toBe('上手了')
  expect(lv3.nextHow).toContain('能自己做对')

  // 48-反例1：四技能显式判定——interaction 不冒充 writing；缺写作时不是"四项起步"
  const interactionAsWriting = [
    st('r', 'reading', 'independent'), st('l', 'listening', 'independent'),
    st('sp', 'speaking', 'independent'), st('i', 'interaction', 'independent'),
  ]
  const notMaster = journey.computeLevel(interactionAsWriting, 1)
  expect(notMaster.level).not.toBe('四项起步')
  expect(notMaster.summary.fourSkills).toBe(3)
  expect(notMaster.summary.untestedSkills).toContain('writing')

  // 48-反例2：争议不计入段位（与成长视图同口径）；免修同样排除
  const disputed = [
    st('r', 'reading', 'independent', '["disputed"]'), st('l', 'listening', 'independent', '["disputed"]'),
    st('s', 'speaking', 'independent', '["disputed"]'), st('w', 'writing', 'independent', '["disputed"]'),
  ]
  expect(journey.computeLevel(disputed, 1).level).toBe('入门了')
  const waived = [
    st('r', 'reading', 'independent', '["waived_by_user"]'), st('l', 'listening', 'independent', '["waived_by_user"]'),
    st('s', 'speaking', 'independent', '["waived_by_user"]'), st('w', 'writing', 'independent', '["waived_by_user"]'),
  ]
  expect(journey.computeLevel(waived, 1).level).toBe('入门了')

  // 48-反例3：transferred 不与 independent 重复累加——3 个目标（其中1个迁移）+5课 ≠ 熟练了
  const doubleCount = [
    st('a', 'reading', 'independent'), st('b', 'reading', 'transferred'), st('c', 'reading', 'retained'),
  ]
  expect(journey.computeLevel(doubleCount, 5).level).toBe('能迁移') // 唯一键=3，不足 4
  // 4 个唯一目标 + 5 课 → 熟练了
  const fourDistinct = [...doubleCount, st('d', 'reading', 'independent')]
  expect(journey.computeLevel(fourDistinct, 5).level).toBe('熟练了')

  // 48-反例4：升级文案按实际缺口——0 课但 growth≥2 时，"入门了"的下一步不再是"完成第一课"
  const justGrowth = [st('a', 'reading', 'independent')] // growth=2：零课也能"入门了"（复审原例）
  const lv2 = journey.computeLevel(justGrowth, 0)
  expect(lv2.level).toBe('入门了')
  expect(lv2.nextHow).not.toContain('完成第一课')

  // 48-反例5（产品边界）：四项独立也只叫"四项起步"，并给出未测方向
  const four = [
    st('r', 'reading', 'independent'), st('l', 'listening', 'independent'),
    st('s', 'speaking', 'independent'), st('w', 'writing', 'independent'),
  ]
  const top = journey.computeLevel(four, 2)
  expect(top.level).toBe('四项起步')
  expect(top.level).not.toContain('高手')
  expect(top.summary.untestedSkills).toHaveLength(0)
})

it('学习路线接口：完成课时间线有序不重复；当前课带步数进度；后继课进"接下来"', async () => {
  const id = (await call('/api/accounts', { name: '路线' }, 'POST')).json.account.id
  await call('/api/v1/map')
  // 完成 relations-v1（真实完成流：决策→served→作答→complete）
  const plan0 = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: `j-${id}` }, 'POST')).json.decision
  c().prepare("UPDATE plan_decisions SET served_lesson_id = 'les-relations-v1', status = 'ready', lesson_ref = ? WHERE decision_id = ?")
    .run(JSON.stringify({ lesson: { lessonId: 'les-relations-v1', version: 2, status: 'published', devSample: true, contentPreview: false }, fallback: null }), plan0.decisionId)
  const pkg = (await call(`/api/v1/accounts/${id}/lessons/les-relations-v1`)).json
  for (const act of pkg.activities) {
    const r = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: `j-rel-${act.activityId}`, taskId: act.taskId, activityId: act.activityId,
      response: { kind: 'text', text: '团队保留了手势控制，推迟了语音——先在展厅试过再决定，不是永久放弃。地图没坏，是预期不完整。我们保留了视觉序列，推迟了配音测试。' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    expect(r.status).toBe(200)
  }
  await call(`/api/v1/accounts/${id}/lessons/les-relations-v1/complete`, {}, 'POST')
  // 取当前课（listening-v1）读到中间
  const plan1 = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
  const curId = plan1.lesson?.lessonId
  expect(curId).toBeTruthy()
  const curPkg = (await call(`/api/v1/accounts/${id}/lessons/${curId}`)).json
  // 听力课第 1 步要真实播放：取媒体 → 落服务端播放事件（R4），否则作答被拒
  const a0 = curPkg.activities[0]
  if (a0.audio) {
    const media = await call(`/api/v1/accounts/${id}/tasks/${a0.taskId}/media/${a0.audio.mediaId}`)
    await call(`/api/v1/accounts/${id}/support/play`, { taskId: a0.taskId, deliveryId: media.json.deliveryId, eventId: crypto.randomUUID(), activityId: a0.activityId, mediaId: a0.audio.mediaId }, 'POST')
  }
  await call(`/api/v1/accounts/${id}/attempts`, {
    attemptId: `j-${a0.activityId}`, taskId: a0.taskId, activityId: a0.activityId,
    response: { kind: 'text', text: '地图没坏，是团队对游客需求的假设不完整；有人走向拥挤展厅，因为以为那里有意思。' },
    conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 2, lookupUsed: false, responseMode: 'typed_summary' },
  }, 'POST')
  const j = (await call(`/api/v1/accounts/${id}/journey`)).json
  expect(j.completed.length).toBe(1)
  expect(j.completed[0].lessonId).toBe('les-relations-v1')
  expect(j.completed[0].title).toContain('关系和限定')
  expect(j.current?.lessonId).toBe(curId)
  expect(j.current?.doneSteps).toBe(1)
  expect(j.current?.total).toBeGreaterThan(1)
  expect(j.lessonNumber).toBe(2)
  // 段位接口：完成 1 课 → 至少入门了
  const g = (await call(`/api/v1/accounts/${id}/growth`)).json
  expect(['入门了', '上手了']).toContain(g.level)
  expect(g.stats.lessons).toBe(1)
  expect(g.nextHow.length).toBeGreaterThan(4)
})

it('50 号自愈：旧决策说"主目标没课"但新课已上架 → GET plan 自动重算接上新课；重复读不产生重复决策', async () => {
  const id = (await call('/api/accounts', { name: '自愈' }, 'POST')).json.account.id
  await call('/api/v1/map')
  // 制造一个"content_pending"的旧决策（在 c1 上架前的时间点语义）
  const c2 = db.getDb()
  c2.prepare("INSERT INTO plan_decisions (account_id, decision_id, request_id, map_version, evidence_version, snapshot, candidates, primary_goal, strategy_id, reason, hypotheses, uncertain_areas, lesson_ref, served_lesson_id, status, created_at) VALUES (?,?,?,'map-v1',0,'[]','[]','O-K115-03','short_explain','旧决策：无课','','[]','{}',NULL,'ready',?)")
    .run(id, `pd-stale-${id}`, `stale-${id}`, Date.now() - 100000)
  // 第一次读：lesson_ref 为空对象（无 lessonId 也无 fallback）→ 触发自愈重算
  const plan = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
  // 自愈=按当前状态重新规划（不强制旧目标）；关键是"无课挂起"状态解除、有可学课
  expect(plan.lesson?.lessonId).toBeTruthy()
  // 重复读：requestId 幂等，不产生新决策
  const before = c2.prepare('SELECT COUNT(*) n FROM plan_decisions WHERE account_id = ?').get(id).n
  await call(`/api/v1/accounts/${id}/plan`)
  const after = c2.prepare('SELECT COUNT(*) n FROM plan_decisions WHERE account_id = ?').get(id).n
  expect(after).toBe(before)
})
