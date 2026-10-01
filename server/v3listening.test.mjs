// 43 号批回归：听力训练链（无稿首听→校对稿→关稿重听→换材料→口头回应）。
// 验证：播放门（未播放拒绝作答）、校对稿步骤记 reading 不冒充听力、换材料音频可用、
// 口述 defer 不产生口语掌握、fallback 带可练方向、音频清单与活动对齐。全程临时库。
import { beforeAll, afterAll, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir, db, lessons, api
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-listening-'))
  process.env.ENGLISHFORGE_DB = join(dir, 'test.db')
  process.env.ENGLISHFORGE_V4_GENERATION = '1'
  api = (await import('./api.mjs')).handleApi
  db = await import('./db.mjs')
  lessons = await import('./v3lessons.mjs')
})
afterAll(() => { delete process.env.ENGLISHFORGE_V4_GENERATION; db.closeDb(); rmSync(dir, { recursive: true, force: true }) })
const call = (pathname, body, method = 'GET') => api({ pathname, body, method, query: new URLSearchParams() })
const c = () => db.getDb()

const freshAccount = async (name) => {
  const id = (await call('/api/accounts', { name }, 'POST')).json.account.id
  await call('/api/v1/map')
  return id
}

/** 真实播放流：取媒体（deliveryId）→ POST /support/play 落服务端播放事件（R4：听力作答前提） */
async function play(id, pkg, act) {
  const media = await call(`/api/v1/accounts/${id}/tasks/${act.taskId}/media/${act.audio.mediaId}`)
  expect(media.status).toBe(200)
  const played = await call(`/api/v1/accounts/${id}/support/play`, {
    taskId: act.taskId, deliveryId: media.json.deliveryId, eventId: crypto.randomUUID(),
    activityId: act.activityId, mediaId: act.audio.mediaId,
  }, 'POST')
  expect(played.status).toBe(200)
}

const answer = (id, act, text, tag = 'r1', extra = {}) => call(`/api/v1/accounts/${id}/attempts`, {
  attemptId: `lsn-${act.activityId}-${tag}`, taskId: act.taskId, activityId: act.activityId,
  response: { kind: 'text', text },
  conditions: { firstExposure: tag === 'r1', hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary', ...extra },
}, 'POST')
const registry = JSON.parse(readFileSync(new URL('./data/v3-activities.json', import.meta.url), 'utf8'))
const regById = (aid) => registry.activities.find((x) => x.activityId === aid)
/** 听后选择（封闭槽位）：accept 从本地注册表取（公开课包不带合同） */
const slotAnswer = (id, act, tag = 'r1') => {
  const slots = regById(act.activityId)?.evaluationContract?.slots ?? []
  return call(`/api/v1/accounts/${id}/attempts`, {
    attemptId: `lsn-${act.activityId}-${tag}`, taskId: act.taskId, activityId: act.activityId,
    response: { kind: 'choice', text: '', answers: Object.fromEntries(slots.map((s) => [s.slotId, s.accept])) },
    conditions: { firstExposure: tag === 'r1', hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
  }, 'POST')
}

it('听力链：无播放拒绝作答；真实播放后可答；校对稿步骤记 reading；关稿重听与换材料都有音频', async () => {
  const id = await freshAccount('听力链')
  const plan = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: `lsn-${id}` }, 'POST')).json.decision
  c().prepare("UPDATE plan_decisions SET served_lesson_id = 'les-listening-c1', status = 'ready', lesson_ref = ? WHERE decision_id = ?")
    .run(JSON.stringify({ lesson: { lessonId: 'les-listening-c1', version: 1, status: 'published', devSample: true, contentPreview: false }, fallback: null }), plan.decisionId)
  const pkg = (await call(`/api/v1/accounts/${id}/lessons/les-listening-c1`)).json
  expect(pkg.title).toContain('听出主张和限制')
  expect(pkg.activities.length).toBe(5)

  // ① 无稿首听：未播放 → 拒绝（听力证据的前提是服务端播放记录）
  const l1a = pkg.activities[0]
  expect(l1a.audio).not.toBeNull()
  expect(l1a.audio.synthetic !== undefined || l1a.audio.mediaId).toBeTruthy()
  const noPlay = await answer(id, l1a, '团队决定只在考试周开提醒。')
  expect(noPlay.status).toBe(400)
  expect(noPlay.json.error).toContain('LISTENING_PLAYBACK_REQUIRED')
  // 播放 → 听后选择通过（封闭槽位=真实听力事件）
  await play(id, pkg, l1a)
  const ok1 = await slotAnswer(id, l1a)
  expect(ok1.status).toBe(200)
  expect(ok1.json.pass).toBe(true)
  // 听力技能落 listening 槽（synthetic + 真实播放记录）
  const ev1 = c().prepare("SELECT skill, basis FROM evidence_events WHERE account_id = ? AND attempt_id = ? AND kind = 'observed'").get(id, `lsn-${l1a.activityId}-r1`)
  expect(ev1.skill).toBe('listening')
  expect(JSON.parse(ev1.basis).playbackVerified).toBe(true)

  // ② 校对稿步骤：封闭定位题 → 记 reading（不冒充听力；synthetic cap 只作用于 listening）
  const l1b = pkg.activities[1]
  expect(l1b.prompt).toContain('文字稿')
  const ok2 = await slotAnswer(id, l1b)
  expect(ok2.status).toBe(200)
  expect(ok2.json.pass).toBe(true)
  const ev2 = c().prepare("SELECT skill FROM evidence_events WHERE account_id = ? AND attempt_id = ? AND kind = 'observed'").get(id, `lsn-${l1b.activityId}-r1`)
  expect(ev2.skill).toBe('reading')

  // ③ 关稿重听：同一音频、新问题、需要重新播放
  const l1c = pkg.activities[2]
  expect(l1c.audio.mediaId).toBe('aud_l1_standup_v1')
  const noPlay2 = await answer(id, l1c, 'In fact 分开预期和实际；平时周是关掉。')
  expect(noPlay2.status).toBe(400)
  await play(id, pkg, l1c)
  const ok3 = await slotAnswer(id, l1c)
  expect(ok3.json.pass).toBe(true)

  // ④ 换材料换情境：洗衣时间表音频可播可答
  const l1d = pkg.activities[3]
  expect(l1d.role).toBe('transfer')
  expect(l1d.audio.mediaId).toBe('aud_l1d_laundry_v1')
  await play(id, pkg, l1d)
  const ok4 = await slotAnswer(id, l1d)
  expect(ok4.json.pass).toBe(true)

  // ⑤ 口头回应（练习参考级）：文本路径可作答，口语证据 defer
  const l1e = pkg.activities[4]
  const ok5 = await answer(id, l1e, 'I agree with the change, as long as reminders come back before exam week.')
  expect(ok5.status).toBe(200)
  const ev5 = c().prepare("SELECT COUNT(*) AS n FROM evidence_events WHERE account_id = ? AND attempt_id = ? AND kind = 'observed'").get(id, `lsn-${l1e.activityId}-r1`)
  expect(ev5.n).toBe(0) // 口语证据 defer：不产生掌握正分
  const complete = await call(`/api/v1/accounts/${id}/lessons/les-listening-c1/complete`, {}, 'POST')
  expect(complete.json.ok).toBe(true)
  // 43 号承诺兑现：synthetic 听力证据封顶 trained——三道听后选择全对也不升 independent
  const st = c().prepare("SELECT state FROM learner_states WHERE account_id = ? AND objective_id = 'O-K184-01' AND skill = 'listening'").all(id)
  expect(st.length).toBeGreaterThan(0)
  for (const row of st) expect(['unmeasured', 'tentative', 'trained']).toContain(row.state)
})

it('口头回应链：三步式站会决定 + 追问门控（完成前者才出现），口述 defer 无掌握事件', async () => {
  const id = await freshAccount('口头链')
  const plan = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: `orc-${id}` }, 'POST')).json.decision
  c().prepare("UPDATE plan_decisions SET served_lesson_id = 'les-oral-c1', status = 'ready', lesson_ref = ? WHERE decision_id = ?")
    .run(JSON.stringify({ lesson: { lessonId: 'les-oral-c1', version: 1, status: 'published', devSample: true, contentPreview: false }, fallback: null }), plan.decisionId)
  const pkg = (await call(`/api/v1/accounts/${id}/lessons/les-oral-c1`)).json
  expect(pkg.activities.length).toBe(1) // 追问未解锁
  const o1a = pkg.activities[0]
  expect(o1a.oralTask).toBe(true)
  const r1 = await answer(id, o1a, "We're moving the stand-up to Saturday morning because Wednesday evenings conflict with class. If someone can't come, we will record it and share notes.", 'r1')
  expect(r1.json.pass).toBe(true)
  expect(r1.json.practiceOnly).toBe(true) // 机器词表=练习反馈
  // 追问解锁
  const pkg2 = (await call(`/api/v1/accounts/${id}/lessons/les-oral-c1`)).json
  expect(pkg2.activities.length).toBe(2)
  const o1b = pkg2.activities[1]
  expect(o1b.role).toBe('transfer')
  const r2 = await answer(id, o1b, "OK, good point. He can watch the recording and add notes async — he's still in, we are not cancelling him.", 'r1')
  expect(r2.json.pass).toBe(true)
  const done = await call(`/api/v1/accounts/${id}/lessons/les-oral-c1/complete`, {}, 'POST')
  expect(done.json.ok).toBe(true)
  const observed = c().prepare("SELECT COUNT(*) AS n FROM evidence_events WHERE account_id = ? AND kind = 'observed'").get(id).n
  expect(observed).toBe(0) // oralEvidenceDeferred：口语掌握待人审，机器不给正分
})

it('43 号对齐：音频清单含新素材（synthetic/许可/逐段依据/活动绑定）；fallback 带可练方向', async () => {
  const manifest = JSON.parse(readFileSync(new URL('./data/audio-manifest.json', import.meta.url), 'utf8'))
  for (const mid of ['aud_l1_standup_v1', 'aud_l1d_laundry_v1']) {
    const asset = manifest.assets.find((x) => x.mediaId === mid)
    expect(asset, mid).toBeTruthy()
    expect(asset.sourceType).toBe('synthetic')
    expect(asset.licenseStatus).toBe('confirmed')
    expect(asset.segments.length).toBeGreaterThanOrEqual(3)
    for (const seg of asset.segments) expect(seg.meaningBasis.length).toBeGreaterThan(4)
  }
  expect(manifest.assets.find((x) => x.mediaId === 'aud_l1_standup_v1').transcript).toContain('conclusion')
  expect(manifest.assets.find((x) => x.mediaId === 'aud_l1d_laundry_v1').transcript).toContain('weekdays')
  expect(manifest.assets.find((x) => x.mediaId === 'aud_l1_standup_v1').activityIds)
    .toEqual(expect.arrayContaining(['l1a_first_listen', 'l1b_transcript_study', 'l1c_relisten_closed']))
  // 素材池已登记（listen_synthetic、audited、限 O-K184-*）
  const reg = await import('./v3registry.mjs')
  expect(reg.getMaterial('aud_l1_standup_v1').status).toBe('audited')
  expect(reg.materialUsableFor('aud_l1_standup_v1', 'O-K184-01')).toBe(true)
  expect(reg.materialUsableFor('aud_l1_standup_v1', 'O-K115-03')).toBe(false)
  // fallback 载荷带 objectiveIds（前端渲染"练的方向"）
  const id = await freshAccount('方向数据')
  c().prepare("INSERT INTO plan_decisions (account_id, decision_id, request_id, map_version, evidence_version, snapshot, candidates, primary_goal, strategy_id, reason, hypotheses, uncertain_areas, lesson_ref, served_lesson_id, status, created_at) VALUES (?,?,?,'map-v1',0,'[]','[]','O-K184-01','sound_segmentation','seed','','[]','{}','les-relations-v1','completed',?)")
    .run(id, `pd-dir-${id}`, `dir-${id}`, Date.now())
  const plan = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: `dir-${id}` }, 'POST')).json.decision
  if (plan.fallback) {
    expect(Array.isArray(plan.fallback.objectiveIds)).toBe(true)
    expect(plan.fallback.reason).toContain('不会被它记成掌握')
  }
})
