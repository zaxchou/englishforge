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

it('段位纯函数：从零到高手逐级到位；条件说人话且可解释', () => {
  // 零记录 → 起步者
  expect(journey.computeLevel([], 0).level).toBe('起步者')
  // 完成 1 课 → 入门了
  expect(journey.computeLevel([], 1).level).toBe('入门了')
  // 2 课 + growth≥5 → 上手了
  const g5 = [st('a', 'reading', 'trained'), st('b', 'reading', 'trained'), st('c', 'reading', 'independent'), st('d', 'reading', 'trained'), st('e', 'reading', 'trained')]
  const lv3 = journey.computeLevel(g5, 2)
  expect(lv3.level).toBe('上手了')
  expect(lv3.nextHow).toContain('能自己做对')
  // 2 个 independent → 站稳了
  const g6 = [...g5, st('f', 'listening', 'independent')]
  expect(journey.computeLevel(g6, 3).level).toBe('站稳了')
  // 1 个 transferred → 能迁移
  const g7 = [...g6, st('g', 'speaking', 'transferred')]
  expect(journey.computeLevel(g7, 4).level).toBe('能迁移')
  // 免修目标不计入（不冒充能力）：其余 3 项独立/迁移 + 5 课 → 熟练了（h 被排除）
  const waived = [...g7, st('h', 'writing', 'independent', '["waived_by_user"]')]
  const lv = journey.computeLevel(waived, 5)
  expect(lv.level).toBe('熟练了')
  expect(lv.summary.independent).toBe(3) // h 不计入
  // 听说读写四方向都有 independent+ → 高手
  const four = [
    st('r', 'reading', 'independent'), st('l', 'listening', 'independent'),
    st('s', 'speaking', 'independent'), st('w', 'writing', 'independent'),
  ]
  const master = journey.computeLevel(four, 2)
  expect(master.level).toBe('高手')
  expect(master.nextTitle).toBeNull()
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
