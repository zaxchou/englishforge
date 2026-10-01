// 31 第三批余下：素材绑定门、内容签名失效规则、生成库存状态（注入假模型，无真实调用）。
import { beforeAll, afterAll, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir, db, gen, lessons, api, reg
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-materials-'))
  process.env.ENGLISHFORGE_DB = join(dir, 'test.db')
  process.env.ENGLISHFORGE_V4_GENERATION = '1'
  api = (await import('./api.mjs')).handleApi
  db = await import('./db.mjs')
  gen = await import('./v3gen.mjs')
  lessons = await import('./v3lessons.mjs')
  reg = await import('./v3registry.mjs')
})
afterAll(() => { delete process.env.ENGLISHFORGE_V4_GENERATION; db.closeDb(); rmSync(dir, { recursive: true, force: true }) })
const call = (pathname, body, method = 'GET') => api({ pathname, body, method, query: new URLSearchParams() })

const goodPkg = (materialId = 'mat_g3_contrast_texts', tag = 'm') => ({
  title: `素材绑定短课 ${tag}`, whyNow: '近期反馈安排的下一步。',
  teachingNote: '先看说话人承认的部分，再看转折后真正想说的。',
  sourceRefs: [{ ref: 'G3', claim: '两段的 but 都对照预期与实际' }],
  activities: [
    { taskFamilyId: `mat_${tag}_a`, materialId, role: 'practice', prompt: `${tag}: The plan sounded cheap, but we paid for support later. 问：but 对照什么？`, relations: [{ id: 'contrast', label: '对照预期与实际', anyOf: ['sounded', 'but', 'paid'], required: true }] },
    { taskFamilyId: `mat_${tag}_b`, materialId, role: 'transfer', prompt: `${tag} b: 导览看起来省时，但大家绕了远路。问：预期与实际各是什么？`, relations: [{ id: 'contrast', label: '对照预期与实际', anyOf: ['看起来', '但', '绕'], required: true }] },
  ],
})

it('素材绑定门：未绑定/未知素材/待审素材都拒；绑定已审素材可发布', async () => {
  await call('/api/v1/lessons')
  const id = (await call('/api/accounts', { name: '素材门' }, 'POST')).json.account.id
  await call(`/api/v1/accounts/${id}/attempts`, {
    attemptId: 'mat-seen', activityId: 'diag_d1_read', response: { kind: 'text', text: 'ok' },
    conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
  }, 'POST')
  // 未绑定 materialId → 拒（注意传 ''，undefined 会触发默认参数）
  const none = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', await: true, force: true, chat: async () => JSON.stringify(goodPkg('', 'x1')) })
  expect(none.status).toBe('rejected')
  expect((none.reasons ?? []).join(';')).toContain('materialsBound')
  // 未知素材 → 拒；待审素材（LibriVox 未听校）→ 拒
  for (const [tag, mid] of [['x2', 'mat_unknown_thing'], ['x3', 'real_cylinder_weakness_richards']]) {
    const r = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', await: true, force: true, chat: async () => JSON.stringify(goodPkg(mid, tag)) })
    expect(r.status, `${mid} 应被拒`).toBe('rejected')
    expect((r.reasons ?? []).join(';')).toContain('materialsBound')
  }
  // 绑定已审素材 → 发布（生成课只到 ready 等人审 = succeeded/published:false）
  const ok = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', await: true, force: true, chat: async () => JSON.stringify(goodPkg('mat_g3_contrast_texts', 'ok1')) })
  expect(ok.status).toBe('succeeded')
  // 注册表自检：audited/pending 状态判定
  expect(reg.materialUsableFor('mat_g3_contrast_texts', 'O-K184-02')).toBe(true)
  expect(reg.materialUsableFor('real_cylinder_weakness_richards', 'O-K184-02')).toBe(false)
})

it('内容签名失效：等待期间签名变化 → 任务 superseded；未分发个体课不再适用；历史无签名不追溯', async () => {
  const id = (await call('/api/accounts', { name: '签名失效' }, 'POST')).json.account.id
  await call(`/api/v1/accounts/${id}/attempts`, {
    attemptId: 'sig-seen', activityId: 'diag_d1_read', response: { kind: 'text', text: 'ok' },
    conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
  }, 'POST')
  // 在途任务：chat 挂起，等待期间改写库里保存的内容签名（模拟地图/来源命题更新）
  let release
  const pending = gen.startGenerationJob(id, { objectiveId: 'O-K184-02', await: true, force: true, chat: () => new Promise((r) => { release = r }) })
  const stored = db.getDb().prepare('SELECT job_id, input_spec FROM generation_jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT 1').get(id)
  const spec = JSON.parse(stored.input_spec)
  expect(spec.contentSignature).toBe(reg.contentSignature()) // 新任务携带当前签名
  db.getDb().prepare('UPDATE generation_jobs SET input_spec = ? WHERE job_id = ?')
    .run(JSON.stringify({ ...spec, contentSignature: 'stale-signature' }), stored.job_id)
  release(JSON.stringify(goodPkg('mat_g3_contrast_texts', 'sig')))
  const result = await pending
  expect(result.status).toBe('superseded')
  expect(result.reasons).toContain('LEARNING_FEEDBACK_OR_CONTENT_CHANGED')
  // 未分发个体课：签名过期 → 不适用；签名当前 → 适用
  const c = db.getDb()
  const original = c.prepare("SELECT * FROM lesson_versions WHERE lesson_id='les-relations-v1' ORDER BY version DESC").get()
  const mkLesson = (lessonId, sig) => {
    const copy = { ...original, lesson_id: lessonId, account_scope: id }
    const cols = Object.keys(copy)
    c.prepare(`INSERT INTO lesson_versions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(copy))
    c.prepare("INSERT INTO generation_jobs (account_id, job_id, input_spec, contract_version, status, output_lesson_id, created_at) VALUES (?,?,?,'fixture','succeeded',?,?)")
      .run(id, `job-${lessonId}`, JSON.stringify({ learnerEvidence: { practiceRevision: c.prepare('SELECT COUNT(*) AS n FROM learner_attempts_v3 WHERE account_id = ?').get(id).n, evidenceVersion: c.prepare("SELECT value FROM v3_counters WHERE account_id=? AND name='evidence'").get(id)?.value ?? 0 }, contentSignature: sig }), lessonId, Date.now())
    return lessons.getLesson(lessonId)
  }
  expect(lessons.lessonApplicable(id, mkLesson('sig-fresh', reg.contentSignature()))).toBe(true)
  expect(lessons.lessonApplicable(id, mkLesson('sig-stale', 'stale-signature'))).toBe(false)
  // 历史无签名不追溯：老格式（无 contentSignature 字段）反馈计数对齐当前 → 适用（签名缺失不误杀）
  const legacy = { learnerEvidence: { practiceRevision: c.prepare('SELECT COUNT(*) AS n FROM learner_attempts_v3 WHERE account_id = ?').get(id).n, evidenceVersion: c.prepare("SELECT value FROM v3_counters WHERE account_id=? AND name='evidence'").get(id)?.value ?? 0 } }
  c.prepare("INSERT INTO generation_jobs (account_id, job_id, input_spec, contract_version, status, output_lesson_id, created_at) VALUES (?,?,?,'fixture','succeeded',?,?)")
    .run(id, 'job-legacy', JSON.stringify(legacy), 'legacy-lesson', Date.now())
  const legacyCopy = { ...original, lesson_id: 'legacy-lesson', account_scope: id }
  const cols = Object.keys(legacyCopy)
  c.prepare(`INSERT INTO lesson_versions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(legacyCopy))
  expect(lessons.lessonApplicable(id, lessons.getLesson('legacy-lesson'))).toBe(true)
})

it('userConfirmed：全局开关关闭时，单次明确确认可生成；未确认仍 409（冷却/去重不受影响）', async () => {
  const id = (await call('/api/accounts', { name: '确认生成' }, 'POST')).json.account.id
  await call(`/api/v1/accounts/${id}/attempts`, {
    attemptId: 'uc-seen', activityId: 'diag_d1_read', response: { kind: 'text', text: 'ok' },
    conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
  }, 'POST')
  const prev = process.env.ENGLISHFORGE_V4_GENERATION
  delete process.env.ENGLISHFORGE_V4_GENERATION
  try {
    // 未确认 → 拒
    expect(() => gen.startGenerationJob(id, { objectiveId: 'O-K184-02', chat: async () => '{}' })).toThrow('GENERATION_DISABLED')
    // 用户单次确认（界面按钮明示计费）→ 照常走质量门并发布
    const r = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', userConfirmed: true, await: true, force: true,
      chat: async () => JSON.stringify(goodPkg('mat_g3_contrast_texts', 'uc')) })
    expect(r.status).toBe('succeeded')
    // 即使 normally 需要人审（explanationKind new）→ 用户确认的样本也以 dev_only 发布可学，签审挂账
    const needsSignPkg = { ...goodPkg('mat_g3_contrast_texts', 'uc2'), explanationKind: 'new' }
    const r2 = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', userConfirmed: true, await: true, force: true,
      chat: async () => JSON.stringify(needsSignPkg) })
    expect(r2.status).toBe('succeeded')
    expect(r2.published).toBe(true)
    expect(r2.devSample).toBe(true)
    const row = db.getDb().prepare('SELECT content_status FROM lesson_versions WHERE lesson_id = ?').get(r2.lessonId)
    expect(row.content_status).toBe('published')
  } finally {
    if (prev === undefined) delete process.env.ENGLISHFORGE_V4_GENERATION; else process.env.ENGLISHFORGE_V4_GENERATION = prev
  }
})

it('素材正文全链路：注册保留 materialId；serve 下发 read 类正文；listen 类不下发正文（首听无脚本）', async () => {
  const ev = await import('./v3evidence.mjs')
  // 注册保留 materialId（实测丢失事故：门过但落库丢字段，学习者看不到素材）
  const [actId] = gen.registerGeneratedActivities('job-mat-keep', [{
    taskFamilyId: 'mat_keep_fam', prompt: '读下面这段短文并复述。', hints: [],
    objectiveIds: ['O-K184-02'], skillByObjective: { 'O-K184-02': 'reading' },
    materialId: 'mat_g3_contrast_texts',
    conditionsSpec: ['firstExposure', 'hintLevel', 'transcriptShown', 'playCount', 'lookupUsed', 'responseMode'],
    relations: [{ id: 'contrast', label: '对照', anyOf: ['but', '但'], required: true }],
  }])
  const stored = ev.activityById(actId)
  expect(stored.materialId).toBe('mat_g3_contrast_texts')
  // publicActivity 下发正文
  const pub = ev.publicActivity(stored)
  expect(pub.material?.content?.length).toBeGreaterThan(0)
  expect(pub.material.content[0].text).toContain('voice prototype')
  // listen 类不下发正文（音频即素材，首听无脚本）
  expect(ev.publicActivity({ ...stored, materialId: 'aud_l2_museum_v1' }).material).toBeNull()
  // serveLesson 同口径（用诊断里的听力活动验证：有 audioRef 无 materialId → material null）
  const diagAct = ev.activityById('diag_d1_read')
  expect(diagAct.materialId ?? null).toBeNull()
})

it('生成库存：ready/pendingReview/failedCooldown/disabled 分开计数，只读无副作用', async () => {
  const id = (await call('/api/accounts', { name: '库存' }, 'POST')).json.account.id
  // 未开启 → disabled
  const prev = process.env.ENGLISHFORGE_V4_GENERATION
  delete process.env.ENGLISHFORGE_V4_GENERATION
  expect(gen.generationStock(id).disabled).toBe(true)
  process.env.ENGLISHFORGE_V4_GENERATION = prev
  // 造一条待审 + 一条失败冷却
  const c = db.getDb()
  c.prepare("INSERT INTO generation_jobs (account_id, job_id, input_spec, contract_version, status, output_lesson_id, validation, created_at) VALUES (?,?,'{}','fixture','succeeded',?,?,?)")
    .run(id, 'stock-pending', 'gen-pending-1', '{"pending":"human_sign"}', Date.now())
  c.prepare("INSERT INTO generation_jobs (account_id, job_id, input_spec, contract_version, status, reject_reasons, finished_at, created_at) VALUES (?,?,'{}','fixture','rejected','[\"x\"]',?,?)")
    .run(id, 'stock-failed', Date.now(), Date.now())
  const stock = gen.generationStock(id)
  expect(stock.disabled).toBe(false)
  expect(stock.pendingReview).toBe(1)
  expect(stock.failedCooldown).toBe(1)
  expect(stock.ready).toBe(0)
  // 路由只读可用
  const viaApi = (await call(`/api/v1/accounts/${id}/generation`)).json.stock
  expect(viaApi.pendingReview).toBe(1)
})
