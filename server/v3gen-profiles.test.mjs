// 31 第三批 · D2 生成验收（注入假模型，无真实调用）：同一目标、三种学习画像，
// 生成的**输入提示**必须实质不同（教学适配模式/约束不同，不是只改标题）；
// 输出的难度上限是机器门（band 超上限拒绝），不是只在提示里说说。
import { beforeAll, afterAll, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir, db, gen, api
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-profiles-'))
  process.env.ENGLISHFORGE_DB = join(dir, 'test.db')
  api = (await import('./api.mjs')).handleApi
  db = await import('./db.mjs')
  gen = await import('./v3gen.mjs')
})
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })
const call = (pathname, body, method = 'GET') => api({ pathname, body, method, query: new URLSearchParams() })

beforeAll(() => { process.env.ENGLISHFORGE_V4_GENERATION = '1' }) // 注入假模型，无真实调用；开关防误计费的统一判定照常生效
afterAll(() => { delete process.env.ENGLISHFORGE_V4_GENERATION })

// 合格包（过全部既有门）：O-K184-02 声明来源 G3/G4，账本有具体命题
const goodPkg = (tag, band) => ({
  title: `个性化短课 ${tag}`,
  whyNow: '基于近期练习反馈安排的下一步。',
  teachingNote: '先看关系线索，再自己说出对照的两边；材料是新的，做法不变。',
  sourceRefs: [{ ref: 'G3', claim: '本课两句的 but 都对照预期与实际结果' }],
  activities: [
    { taskFamilyId: `prof_${tag}_a`, materialId: 'mat_g3_contrast_texts', segmentIds: ['mat_g3_rehearsal'], referenceAnswer: '团队保留了手势控制，但把语音控制推迟到展厅实测之后——限制是先在展厅验证，不是永久放弃。', supportingQuotes: ['We kept the gesture controls, but we delayed voice control until we could test it with visitors in the exhibition hall.'], role: 'practice', prompt: `材料 ${tag}（排练记录段）：团队保留了什么、推迟了什么？限制是什么？`, relations: [{ id: 'kept', label: '保留手势', anyOf: ['kept', '保留'], required: true }, { id: 'delay', label: '推迟语音', anyOf: ['delay', '推迟'], required: true }], complexityBand: band },
    { taskFamilyId: `prof_${tag}_b`, materialId: 'mat_g3_contrast_texts', segmentIds: ['mat_g3_film'], referenceAnswer: '保留了视觉序列，推迟配音测试——限制只是小房间场景，不是影片不行。', supportingQuotes: ['We kept the visual sequence but postponed the voice-over test.'], role: 'transfer', prompt: `新情境 ${tag}（放映与配音段）：保留了什么、推迟了什么？`, relations: [{ id: 'kept', label: '保留视觉', anyOf: ['kept', '保留', 'visual'], required: true }, { id: 'post', label: '推迟配音', anyOf: ['postponed', '推迟'], required: true }], complexityBand: band },
  ],
})

const captureJob = async (id, captured) => gen.startGenerationJob(id, {
  objectiveId: 'O-K184-02', await: true, force: true,
  semanticJudge: async () => ({ verdict: 'supported', reviewer: 'test-stub' }),
  chat: async (msgs) => { captured.push(msgs[0].content); return JSON.stringify(goodPkg(id.slice(-4), 2)) },
})

it('同一目标三种画像：生成提示的适配模式实质不同（focused_probe / fade_support / new_context_probe）', async () => {
  await call('/api/v1/lessons')
  const mk = async (name) => (await call('/api/accounts', { name }, 'POST')).json.account.id
  const failOn = (attemptId, text, conditions = {}) => call(`/api/v1/accounts/${id}/attempts`, {
    attemptId, activityId: 'diag_d1_read', response: { kind: 'text', text },
    conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary', ...conditions },
  }, 'POST')
  let id

  // A 反复漏同一关系 → focused_probe（区分反复漏掉的关系，不复读旧句）
  id = await mk('画像A-反复漏')
  await failOn('pa-1', '团队保留了手势控制，推迟了语音控制，因为多人同时说话时失败了。') // 缺 limit 关系
  await failOn('pa-2', '团队保留了手势并推迟语音，展厅里多人说话导致失败。')
  const capA = []; const jobA = await captureJob(id, capA)
  console.log('PROFDBG', jobA.status, JSON.stringify(jobA.reasons ?? []), 'capA.len=', capA.length)
  expect(['succeeded']).toContain(jobA.status) // 生成课只到 ready 等人审（needsSign），不自动成为正式可学课

  // B 提示/看稿支持下的成功 → fade_support（逐步撤支持）
  id = await mk('画像B-支持成功')
  await failOn('pb-1', '团队保留了手势控制，推迟了语音控制，因为多人同时说话时失败了；他们并未完全放弃语音，仍想再测试。', { hintLevel: 2 }) // 全关系命中 + 支持
  const capB = []; await captureJob(id, capB)

  // C 单次失败（无支持、非反复）→ new_context_probe（新情境检验；关键词失败不跳过不升档）
  id = await mk('画像C-单次失败')
  await failOn('pc-1', '团队保留了手势控制，推迟了语音控制，因为多人同时说话时失败了。')
  const capC = []; await captureJob(id, capC)

  // 提示级实质差异：适配模式不同、指令不同；共同部分（目标名/来源命题）不是差异来源
  const modes = [capA, capB, capC].map((c) => (c[0].match(/"mode":"([a-z_]+)"/) ?? [])[1])
  expect(modes).toEqual(['focused_probe', 'fade_support', 'new_context_probe'])
  expect(capA[0]).toContain('区分反复漏掉的关系')
  expect(capB[0]).toContain('逐步撤掉提示或文字稿')
  expect(capC[0]).toContain('不要直接跳过本目标或自动升难度')
  // 差异落实在约束与反馈段落，而非只改标题（标题根本不在提示里）
  expect(new Set(capA).size === 1 && capA[0] !== capB[0] && capB[0] !== capC[0]).toBe(true)
})

it('难度上限是机器门：band 超 maxBand 的生成输出被拒（关键词画像不升档），合规带可发布', async () => {
  const id = (await call('/api/accounts', { name: '画像D-上限' }, 'POST')).json.account.id
  await call(`/api/v1/accounts/${id}/attempts`, {
    attemptId: 'pd-1', activityId: 'diag_d1_read',
    response: { kind: 'text', text: '团队保留了手势控制，推迟了语音控制，因为多人同时说话时失败了。' },
    conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
  }, 'POST')
  const captured = []
  // 先取一次合规包，从提示里读出该画像的 maxBand
  const job = await gen.startGenerationJob(id, {
    objectiveId: 'O-K184-02', await: true, force: true,
    semanticJudge: async () => ({ verdict: 'supported', reviewer: 'test-stub' }), chat: async (msgs) => { captured.push(msgs[0].content); return JSON.stringify(goodPkg('d1', 2)) },
  })
  expect(job.status).toBe('succeeded')
  const maxBand = Number((captured[0].match(/"maxBand":(\d+)/) ?? [])[1])
  expect(maxBand).toBeGreaterThanOrEqual(1)
  // 越上限输出（band = maxBand+3）→ 质量门拒绝，理由点名 bandWithinMax（难度上限机器门）
  const over = await gen.startGenerationJob(id, {
    objectiveId: 'O-K184-02', await: true, force: true,
    semanticJudge: async () => ({ verdict: 'supported', reviewer: 'test-stub' }), chat: async () => JSON.stringify(goodPkg('d2', maxBand + 3)),
  })
  expect(over.status).toBe('rejected')
  expect((over.reasons ?? []).join(';')).toContain('bandWithinMax')
  // 合规带（≤ maxBand）显式 force 重试可发布
  const ok = await gen.startGenerationJob(id, {
    objectiveId: 'O-K184-02', await: true, force: true,
    semanticJudge: async () => ({ verdict: 'supported', reviewer: 'test-stub' }), chat: async () => JSON.stringify(goodPkg('d3', maxBand)),
  })
  expect(ok.status).toBe('succeeded')
})
