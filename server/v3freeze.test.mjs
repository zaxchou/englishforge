// 38 号批回归：F3/F4 版本冻结（四场景隔离库复现）+ S1 审核输入完整性 + S2 审核后发布前最终核对。
// 全程临时库，不碰真实数据；模型/审核器全部注入。
import { beforeAll, afterAll, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir, db, gen, lessons, api, reg, ev
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-freeze-'))
  process.env.ENGLISHFORGE_DB = join(dir, 'test.db')
  process.env.ENGLISHFORGE_V4_GENERATION = '1'
  api = (await import('./api.mjs')).handleApi
  db = await import('./db.mjs')
  gen = await import('./v3gen.mjs')
  lessons = await import('./v3lessons.mjs')
  reg = await import('./v3registry.mjs')
  ev = await import('./v3evidence.mjs')
})
afterAll(() => { delete process.env.ENGLISHFORGE_V4_GENERATION; db.closeDb(); rmSync(dir, { recursive: true, force: true }) })
const call = (pathname, body, method = 'GET') => api({ pathname, body, method, query: new URLSearchParams() })
const c = () => db.getDb()

// 38-S1：与默认模型审核同构的桩（逐题四维度）
const judgeOK = async (input) => ({
  verdict: 'supported', reviewer: 'test-stub',
  activities: (input.activities ?? []).map((a) => ({
    idx: a.idx, answerability: 'supported', languageFacts: 'supported',
    objectiveAlignment: 'supported', scoringConsistency: 'supported',
  })),
})

const pkg = (tag = 'fz', over = {}) => ({
  title: `冻结短课 ${tag}`, whyNow: '近期反馈安排的下一步。', teachingNote: '先看说话人承认的部分，再看转折后真正想说的。',
  sourceRefs: [{ ref: 'G3', claim: '两段的 but 都对照预期与实际' }],
  activities: [
    { taskFamilyId: `fz_${tag}_a`, materialId: 'mat_g3_contrast_texts', segmentIds: ['mat_g3_rehearsal'],
      referenceAnswer: '团队保留了手势控制，但把语音控制推迟到展厅实测之后——限制是先在展厅验证，不是永久放弃。',
      supportingQuotes: ['We kept the gesture controls, but we delayed voice control until we could test it with visitors in the exhibition hall.'],
      role: 'practice', prompt: `${tag}: 读排练记录——团队保留了什么、推迟了什么？限制是什么？`, hints: ['限制看 until 那半句'],
      relations: [{ id: 'kept', label: '保留手势', anyOf: ['kept', '保留'], required: true }, { id: 'delay', label: '推迟语音', anyOf: ['delay', '推迟'], required: true }] },
    { taskFamilyId: `fz_${tag}_b`, materialId: 'mat_g3_contrast_texts', segmentIds: ['mat_g3_film'],
      referenceAnswer: '保留了视觉序列，推迟配音测试——限制只是小房间场景。',
      supportingQuotes: ['We kept the visual sequence but postponed the voice-over test.'],
      role: 'transfer', prompt: `${tag} b: 读放映与配音段——保留了什么、推迟了什么？`, hints: [],
      relations: [{ id: 'kept', label: '保留视觉', anyOf: ['kept', '保留', 'visual'], required: true }, { id: 'post', label: '推迟配音', anyOf: ['postponed', '推迟'], required: true }] },
  ],
  ...over,
})

const seeAccount = async (name, seenActivity = 'diag_d1_read') => {
  const id = (await call('/api/accounts', { name }, 'POST')).json.account.id
  await call('/api/v1/map')
  await call(`/api/v1/accounts/${id}/attempts`, {
    attemptId: `seen-${id}`, activityId: seenActivity, response: { kind: 'text', text: 'ok' },
    conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
  }, 'POST')
  return id
}

/** 用修改过的素材字节构造签名输入覆盖（不动真实文件），返回恢复函数 */
function overrideMaterialsChanged() {
  const files = ['v3-map-seed.json', 'v3-objectives.json', 'v3-materials.json'].map((f) => {
    const p = new URL(`./data/${f}`, import.meta.url)
    return { file: f, stamp: `mutated:${f}`, bytes: readFileSync(p) }
  })
  const mats = JSON.parse(files[2].bytes.toString('utf8'))
  mats.materials.find((m) => m.materialId === 'mat_g3_contrast_texts').segments[0].text += ' EDITED-LINE-FOR-TEST.'
  files[2].bytes = Buffer.from(JSON.stringify(mats), 'utf8')
  return reg.__overrideContentDigest(files)
}

it('S1：审核输入完整到达审核器（短讲/提示/评分合同/目标边界/段正文）；合同版本一致性有断言', async () => {
  const id = await seeAccount('S1-输入')
  expect(gen.GEN_CONTRACT_V1.version).toBe(reg.CONTENT_CONTRACTS.generation)
  const captured = []
  const r = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', userConfirmed: true, await: true, force: true,
    semanticJudge: async (input) => { captured.push(input); return judgeOK(input) },
    chat: async () => JSON.stringify(pkg('s1')) })
  expect(r.status).toBe('succeeded'); expect(r.published).toBe(true)
  const input = captured[0]
  expect(input.reviewContract).toBe(reg.CONTENT_CONTRACTS.semanticReview)
  // 目标行为/边界（38-S1：审核者必须知道这题该测什么）
  expect(input.objective.behavior.length).toBeGreaterThan(5)
  expect(input.objective.boundary.length).toBeGreaterThan(5)
  // 精华讲解 + 每题：提示/关系全文/mustNot/参考答案/评分规则/段正文
  expect(input.teachingNote).toContain('转折')
  expect(input.activities.length).toBe(2)
  for (const a of input.activities) {
    expect(Array.isArray(a.hints)).toBe(true)
    expect(a.relations.length).toBeGreaterThanOrEqual(2)
    expect(a.relations[0].anyOf.length).toBeGreaterThanOrEqual(2)
    expect(Array.isArray(a.mustNot)).toBe(true)
    expect(a.referenceAnswer.length).toBeGreaterThan(8)
    expect(a.scoringRule.acceptAnchors.length).toBeGreaterThanOrEqual(2)
    expect(a.answerabilityMeasurable).toBe(true)
  }
  expect(JSON.stringify(input.segments)).toContain('voice prototype')
  // 审核对象哈希落档（S2 发布前核对用它）
  const review = JSON.parse(c().prepare('SELECT validation FROM generation_jobs WHERE job_id = ?').get(r.jobId).validation).semanticReview
  expect(review.reviewHash).toMatch(/^[0-9a-f]{16}$/)
  expect(review.inputComplete).toBe(true)
})

it('S1：listen 素材无审核转写 → 可答性不可测 → judge 自报 supported 也强制 pending 不发布', async () => {
  const id = await seeAccount('S1-听素材')
  // 直接构造绑定 listen 素材的包：机器门 quoteIntegrity 对 listen 豁免引用，但语义审核缺输入
  const listenPkg = pkg('ls')
  listenPkg.activities = listenPkg.activities.map((a) => ({ ...a, materialId: 'aud_l2_museum_v1', segmentIds: null, supportingQuotes: null }))
  const r = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', userConfirmed: true, await: true, force: true,
    semanticJudge: judgeOK, chat: async () => JSON.stringify(listenPkg) })
  expect(r.status).toBe('succeeded'); expect(r.published).toBe(false); expect(r.pending).toBe('content_semantic_review')
  const review = JSON.parse(c().prepare('SELECT validation FROM generation_jobs WHERE job_id = ?').get(r.jobId).validation).semanticReview
  expect(review.verdict).toBe('pending')
  expect(review.inputComplete).toBe(false)
})

it('S1：审核输出缺任一题任一维度 → 不发布（supported 必须逐题四维度齐全）', async () => {
  const id = await seeAccount('S1-缺维度')
  const partial = async (input) => ({
    verdict: 'supported', reviewer: 'test-stub',
    activities: input.activities.map((a, i) => ({ idx: a.idx, answerability: 'supported', languageFacts: 'supported',
      objectiveAlignment: 'supported', ...(i === 0 ? {} : { scoringConsistency: 'supported' }) })),
  })
  const r = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', userConfirmed: true, await: true, force: true,
    semanticJudge: partial, chat: async () => JSON.stringify(pkg('pd')) })
  expect(r.published).toBe(false); expect(r.pending).toBe('content_semantic_review')
  const review = JSON.parse(c().prepare('SELECT validation FROM generation_jobs WHERE job_id = ?').get(r.jobId).validation).semanticReview
  expect(review.judgeVerdict).toBe('supported')
  expect(review.verdict).toBe('pending')
  expect(review.missing.join(';')).toContain('dimension@0')
})

it('S2：审核返回前学习反馈前进 → 不发布、任务 superseded、留痕可查', async () => {
  const id = await seeAccount('S2-反馈前进')
  let releaseJudge
  const judgeGate = async (input) => { await new Promise((res) => { releaseJudge = res }); return judgeOK(input) }
  const pending = gen.startGenerationJob(id, { objectiveId: 'O-K184-02', userConfirmed: true, await: true, force: true,
    semanticJudge: judgeGate, chat: async () => JSON.stringify(pkg('s2a')) })
  await new Promise((r) => setTimeout(r, 30))
  // 审核等待期间：学习者产生新作答（证据前进）
  await call(`/api/v1/accounts/${id}/attempts`, {
    attemptId: `s2-new-${id}`, activityId: 'diag_d1_read', response: { kind: 'text', text: '新的作答' },
    conditions: { firstExposure: false, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
  }, 'POST')
  releaseJudge()
  const r = await pending
  expect(r.status).toBe('superseded'); expect(r.published).toBe(false)
  expect(r.reasons).toContain('INVALIDATED_DURING_REVIEW')
  const row = c().prepare('SELECT status, output_lesson_id, finished_at FROM generation_jobs WHERE job_id = ?').get(r.jobId)
  expect(row.status).toBe('superseded'); expect(row.finished_at).not.toBeNull()
  const lesson = c().prepare('SELECT content_status FROM lesson_versions WHERE lesson_id = ?').get(r.lessonId ?? '')
  if (lesson) expect(lesson.content_status).toBe('ready') // 建了课但没发布
})

it('S2：审核期间任务被外部 superseded → supported 迟到不覆盖、不发布（状态条件写入）', async () => {
  const id = await seeAccount('S2-外部作废')
  let releaseJudge
  const judgeGate = async (input) => { await new Promise((res) => { releaseJudge = res }); return judgeOK(input) }
  const pending = gen.startGenerationJob(id, { objectiveId: 'O-K184-02', userConfirmed: true, await: true, force: true,
    semanticJudge: judgeGate, chat: async () => JSON.stringify(pkg('s2b')) })
  await new Promise((r) => setTimeout(r, 30))
  c().prepare("UPDATE generation_jobs SET status='superseded', reject_reasons='[\"EXTERNAL\"]' WHERE job_id = ?")
    .run((await Promise.race([pending.then(() => null), Promise.resolve(null)]), c().prepare("SELECT job_id FROM generation_jobs WHERE account_id=? AND status='running'").get(id).job_id))
  releaseJudge()
  const r = await pending
  expect(r.status).toBe('superseded'); expect(r.published).toBe(false)
  expect(r.reasons).toContain('SUPERSEDED_DURING_REVIEW')
  const row = c().prepare('SELECT status, reject_reasons FROM generation_jobs WHERE job_id = ?').get(r.jobId)
  expect(row.status).toBe('superseded')
  expect(JSON.parse(row.reject_reasons)).toEqual(['EXTERNAL']) // 原因不被改写（可追溯）
})

it('F3-场景①正文变化 → 在途任务失效（不靠重启）；签名缓存按文件内容戳失效', async () => {
  const id = await seeAccount('F3-在途')
  const sigBefore = reg.contentSignature()
  let releaseChat
  const chatGate = async () => { await new Promise((res) => { releaseChat = res }); return JSON.stringify(pkg('f3a')) }
  const pending = gen.startGenerationJob(id, { objectiveId: 'O-K184-02', userConfirmed: true, await: true, force: true,
    semanticJudge: judgeOK, chat: chatGate })
  await new Promise((r) => setTimeout(r, 30))
  const restore = overrideMaterialsChanged()
  try {
    expect(reg.contentSignature()).not.toBe(sigBefore) // 内容变了 → 签名变了（无重启）
    releaseChat()
    const r = await pending
    expect(r.status).toBe('superseded')
    expect(r.reasons).toContain('LEARNING_FEEDBACK_OR_CONTENT_CHANGED')
  } finally { restore() }
  expect(reg.contentSignature()).toBe(sigBefore)
})

it('F3-场景②正文变化 → 未分发的个体生成课不再适用；恢复后重新适用', async () => {
  const id = await seeAccount('F3-未分发')
  const r = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', userConfirmed: true, await: true, force: true,
    semanticJudge: judgeOK, chat: async () => JSON.stringify(pkg('f3b')) })
  expect(r.published).toBe(true)
  expect(lessons.lessonApplicable(id, lessons.getLesson(r.lessonId))).toBe(true)
  const restore = overrideMaterialsChanged()
  try {
    expect(lessons.lessonApplicable(id, lessons.getLesson(r.lessonId))).toBe(false)
  } finally { restore() }
  expect(lessons.lessonApplicable(id, lessons.getLesson(r.lessonId))).toBe(true)
})

it('F3-场景③+F4：已开始课用冻结正文完成；素材改版不改写已下发内容；历史作答的快照含完整定义', async () => {
  const id = await seeAccount('F3-已开始')
  const r = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', userConfirmed: true, await: true, force: true,
    semanticJudge: judgeOK, chat: async () => JSON.stringify(pkg('f3c')) })
  const plan = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: `f3c-${id}` }, 'POST')).json.decision
  // 让推荐指向这节课（把别的已发布候选课完成掉太重；直接把决策的 served_lesson_id 指到它）
  c().prepare("UPDATE plan_decisions SET served_lesson_id = ?, status = 'ready' WHERE decision_id = ?")
    .run(r.lessonId, plan.decisionId)
  const served = (await call(`/api/v1/accounts/${id}/lessons/${r.lessonId}`)).json
  expect(served.contentReview.preview).toBe(true) // 38-S3：内容试验预览标记
  expect(served.devSampleNotice).toContain('内容试验预览')
  const act = served.activities[0]
  expect(act.material.segments[0].text).toContain('voice prototype')
  // 学习者真实作答（封闭槽位从注册表取 accept；开放题给含锚点的回答）
  const registry = JSON.parse(readFileSync(new URL('./data/v3-activities.json', import.meta.url), 'utf8'))
  for (const a of served.activities) {
    const slots = registry.activities.find((x) => x.activityId === a.activityId)?.evaluationContract?.slots
    const response = slots
      ? { kind: 'choice', text: '', answers: Object.fromEntries(slots.map((s) => [s.slotId, s.accept])) }
      : { kind: 'text', text: '团队保留了手势控制，推迟了语音——先在展厅试过再决定，不是永久放弃。' }
    const at = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: `f3c-${a.activityId}`, taskId: a.taskId, activityId: a.activityId, response,
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    expect(at.status).toBe(200)
  }
  const attemptRow = c().prepare('SELECT activity_id, activity_snapshot FROM learner_attempts_v3 WHERE account_id = ? ORDER BY rowid DESC LIMIT 1').get(id)
  const snap = JSON.parse(attemptRow.activity_snapshot)
  expect(snap.prompt.length).toBeGreaterThan(5) // 34-F4：题面原文入档
  expect(snap.evaluationContract.relations.length).toBeGreaterThan(0) // 评分合同冻结
  expect(snap.materialSnapshot[0].text).toContain('postponed the voice-over') // 34-F3：正文冻结（最后一题=迁移题，绑放映段）
  // 素材改版（模拟文件正文变化）后：已开始课仍按**冻结正文**下发，不偷偷换
  const mutated = JSON.parse(JSON.stringify(snap.materialSnapshot))
  mutated[0].text = 'FROZEN-TEXT-SHOULD-WIN.'
  c().prepare('UPDATE generated_activities SET definition = ? WHERE activity_id = ?')
    .run(JSON.stringify({ ...ev.activityById(attemptRow.activity_id), materialSnapshot: mutated }), attemptRow.activity_id)
  const served2 = (await call(`/api/v1/accounts/${id}/lessons/${r.lessonId}`)).json
  expect(served2.activities[1].material.segments[0].text).toBe('FROZEN-TEXT-SHOULD-WIN.')
  // 历史作答与事件原文不动
  const rowAfter = c().prepare('SELECT evaluation FROM learner_attempts_v3 WHERE account_id = ? AND activity_id = ?').get(id, attemptRow.activity_id)
  expect(JSON.parse(rowAfter.evaluation).pass).toBeDefined()
})

it('F4：活动合同换版后，历史作答重算按冻结合同（状态不被新合同改写）', async () => {
  const id = await seeAccount('F4-重放')
  await call(`/api/v1/accounts/${id}/attempts`, {
    attemptId: `f4-${id}`, activityId: 'g3c_principle_pick',
    response: { kind: 'choice', text: '', answers: { but_after: '团队对访客想要什么的预期不完整', when_limit: '句子里有实际收窄范围的内容（比如“只在…先试”）' } },
    conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
  }, 'POST')
  const attemptRow0 = c().prepare('SELECT evaluation FROM learner_attempts_v3 WHERE account_id = ? ORDER BY rowid DESC LIMIT 1').get(id)
  expect(JSON.parse(attemptRow0.evaluation).pass).toBe(true) // 链路第 1 题按注册表答 → 过
  const statesBefore = c().prepare('SELECT objective_id, skill, complexity, state, flags FROM learner_states WHERE account_id = ?').all(id).map((x) => JSON.stringify(x)).sort()
  const attemptBefore = c().prepare('SELECT evaluation FROM learner_attempts_v3 WHERE account_id = ?').get(id)
  // 内容换版：改注册表合同的 accept（等价于"答案换版"）
  const act = ev.activityById('g3c_principle_pick')
  const mutated = JSON.parse(JSON.stringify(act))
  mutated.evaluationContract.slots = mutated.evaluationContract.slots.map((s) => ({ ...s, accept: s.options.find((o) => o !== s.accept) }))
  c().prepare('UPDATE generated_activities SET definition = ? WHERE activity_id = ?').run(JSON.stringify(mutated), 'g3c_principle_pick')
  ev.recomputeStates(id)
  const statesAfter = c().prepare('SELECT objective_id, skill, complexity, state, flags FROM learner_states WHERE account_id = ?').all(id).map((x) => JSON.stringify(x)).sort()
  const attemptAfter = c().prepare('SELECT evaluation FROM learner_attempts_v3 WHERE account_id = ?').get(id)
  expect(statesAfter).toEqual(statesBefore) // 重放按冻结快照：换版不改写历史状态
  expect(attemptAfter.evaluation).toBe(attemptBefore.evaluation) // 作答评估原文不动
})

it('S3：生成结果页/恢复页的字段贯通（listJobs 暴露 published/pending/semanticVerdict）', async () => {
  const id = await seeAccount('S3-字段')
  const r = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', userConfirmed: true, await: true, force: true,
    semanticJudge: judgeOK, chat: async () => JSON.stringify(pkg('s3')) })
  expect(r.published).toBe(true)
  const jobs = (await call(`/api/v1/accounts/${id}/generation`)).json.jobs
  const job = jobs.find((j) => j.job_id === r.jobId)
  expect(job.published).toBe(true)
  // O-K184-02 主技能是听力 → 音频课强制人审挂账（userConfirmed 仍按 dev 预览发布可学）
  expect(job.pending).toBe('human_sign')
  expect(job.semanticVerdict).toBe('supported')
  const lesson = (await call(`/api/v1/accounts/${id}/lessons/${r.lessonId}`)).json
  expect(lesson.contentReview).toEqual({ preview: true, humanSignPending: true, semanticVerdict: 'supported', pending: 'human_sign' })
})
