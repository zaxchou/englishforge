// curriculum-v4 新域（W0–W2）验收测试 —— 对应 docs/curriculum-v4/15 §10 的 T1/T2/T3/T4/T8。
//
// 跑的是真实路径：直接调 handleApi（与 Vite 中间件同一条路），独立 tmpdir 数据库。
// 这些测试是工程验收（合同 fixture），不是学习效果的统计证明 —— 那要等真人试学。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir
let handleApi
let closeDb

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ef-v3-'))
  process.env.ENGLISHFORGE_DB = join(dir, 'test.db')
  // 必须在设置 ENGLISHFORGE_DB 之后再加载模块（DB_PATH 在模块加载时求值）
  const api = await import('./api.mjs')
  const db = await import('./db.mjs')
  handleApi = api.handleApi
  closeDb = db.closeDb
})

afterAll(() => {
  try { closeDb() } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

const call = (pathname, body, method = 'GET', query = new URLSearchParams()) => {
  // 允许直接把 ?a=b 写在 pathname 里（evidence 过滤等）
  const [path, qs] = pathname.split('?')
  if (qs) for (const [k, v] of new URLSearchParams(qs)) query.append(k, v)
  return handleApi({ method, pathname: path, body, query })
}

/** R8：生成一段真实可解码的 WAV 字节（16kHz 16bit 单声道 PCM，静音），供口语上传链路用 */
function makeWav(ms = 1200) {
  const rate = 16_000
  const samples = Math.round(rate * ms / 1000)
  const b = Buffer.alloc(44 + samples * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * 3000), 44 + i * 2)
  return b
}

async function mkAccount(name) {
  const r = await call('/api/accounts', { name }, 'POST')
  expect(r.status).toBe(200)
  return r.json.account.id
}

// ==================================================================
// W0 / T8：旧数据保护与双轨隔离
// 合同：建新域不改旧系统；旧记录只作候选线索；attemptId/requestId 幂等；快照可恢复。
// ==================================================================
describe('W0/T8 旧数据保护与双轨隔离', () => {
  it('新域健康检查可用，v3 表与旧表并存', async () => {
    const r = await call('/api/v1/health')
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.domain).toBe('curriculum-v4')
  })

  it('旧 sync 契约在 v3 表存在后保持原形状；305 条旧历史幂等不重复', async () => {
    const id = await mkAccount('T8旧历史')
    const attempts = Array.from({ length: 305 }, (_, i) => ({
      attemptId: `old-${i}`,
      sessionId: 's1',
      questionId: `q-${i % 40}`,
      objectiveId: 'subject-object',
      variantGroupId: 'vg',
      mode: 'recognition',
      timestamp: 1_700_000_000_000 + i,
      localDate: '2026-09-28',
      firstAttempt: i % 2 === 0,
      supportUsed: 0,
      answer: 'She',
      outcome: 'correct',
      evaluator: 'deterministic',
      contentVersion: 1,
      isDueReview: false,
    }))
    const body = {
      baseRevision: 0,
      state: { xp: 10, streak: 1, lastActiveDate: '2026-09-28', skills: {}, questionStates: {}, sessions: [], dailyXp: {} },
      attempts,
      reason: 'test',
    }
    const r1 = await call(`/api/accounts/${id}/sync`, body, 'POST')
    expect(r1.status).toBe(200)
    // 旧契约形状不因 v3 出现而改变
    expect(Object.keys(r1.json).sort()).toEqual(
      expect.arrayContaining(['ok', 'revision', 'attemptsInserted', 'reviewsWritten', 'reason']),
    )
    expect(r1.json.attemptsInserted).toBe(305)
    // 幂等：同批重发，不得重复入库
    const r2 = await call(`/api/accounts/${id}/sync`, { ...body, baseRevision: r1.json.revision }, 'POST')
    expect(r2.status).toBe(200)
    expect(r2.json.attemptsInserted).toBe(0)
    const legacy = await call(`/api/v1/accounts/${id}/legacy-map`)
    expect(legacy.status).toBe(200)
    expect(legacy.json.readOnly).toBe(true)
    expect(legacy.json.oldCounts.attempts).toBe(305)
    expect(legacy.json.forbidden.join('')).toContain('不得转换为新目标完成比例')
  })

  it('旧数据映射是候选线索，不写任何新域状态', async () => {
    const id = await mkAccount('T8只读')
    const syncRes = await call(`/api/accounts/${id}/sync`, {
      baseRevision: 0,
      state: { xp: 999, streak: 9, lastActiveDate: '2026-09-28', skills: {}, questionStates: {}, sessions: [], dailyXp: {} },
      attempts: [{
        attemptId: 'sp-1', sessionId: 's', questionId: 'q', objectiveId: 'o', variantGroupId: 'vg',
        mode: 'speak', timestamp: 1, localDate: '2026-09-28', firstAttempt: true, supportUsed: 0,
        answer: 'hello', outcome: 'correct', evaluator: 'similarity', contentVersion: 1, isDueReview: false,
      }],
      reason: 'test',
    }, 'POST')
    expect(syncRes.status).toBe(200)
    expect(syncRes.json.attemptsInserted).toBe(1)
    const map = (await call(`/api/v1/accounts/${id}/legacy-map`)).json
    expect(map.oldCounts.speakAttempts).toBe(1)
    expect(map.hints.speakEntryHint).toContain('不等于已有自主表达证据')
    // 新域学习状态对这个账户仍然全空（unmeasured）——W2 起由 /evidence 断言
  })

  it('两个账户同目标不同表现互不串数据；快照恢复不触碰新域', async () => {
    const a = await mkAccount('T8甲')
    const b = await mkAccount('T8乙')
    // 老域：甲用整份替换写一份带 xp 的状态（replace 会先自动留快照），乙保持空
    await call(`/api/accounts/${a}/replace`, {
      baseRevision: 0,
      state: { xp: 777, streak: 1, lastActiveDate: '2026-09-28', skills: {}, questionStates: {}, sessions: [], dailyXp: {} },
      attempts: [], reason: 'test',
    }, 'POST')
    const pa = (await call(`/api/accounts/${a}/progress`)).json
    const pb = (await call(`/api/accounts/${b}/progress`)).json
    expect(pa.progress.xp).toBe(777)
    expect(pb.progress.xp).not.toBe(777)
    // 快照恢复：快照存的是替换前的状态 —— 再替换成 888，然后恢复，应回到 777
    await call(`/api/accounts/${a}/replace`, {
      state: { xp: 888, streak: 1, lastActiveDate: '2026-09-29', skills: {}, questionStates: {}, sessions: [], dailyXp: {} },
      attempts: [], reason: 'test-2',
    }, 'POST')
    const { getDb } = await import('./db.mjs')
    const { ensureV3Schema, nextCounter, getCounter } = await import('./v3db.mjs')
    ensureV3Schema(getDb())
    const before = nextCounter(a, 'evidence')
    expect(getCounter(a, 'evidence')).toBe(1)
    const snaps = (await call(`/api/accounts/${a}/snapshots`)).json
    expect(snaps.snapshots.length).toBeGreaterThan(0)
    const res = await call(`/api/snapshots/${snaps.snapshots[0].id}/restore`, {}, 'POST')
    expect(res.status).toBe(200)
    const pa2 = (await call(`/api/accounts/${a}/progress`)).json
    expect(pa2.progress.xp).toBe(777) // 回滚到替换前的这份
    expect(getCounter(a, 'evidence')).toBe(before) // 新域数据原样
    expect(getCounter(b, 'evidence')).toBe(0) // 且不串账户
  })

  it('发布过的目标版本不可静默覆盖（trigger 强制）', async () => {
    const { getDb } = await import('./db.mjs')
    const { ensureV3Schema } = await import('./v3db.mjs')
    const conn = ensureV3Schema(getDb())
    conn.prepare(
      `INSERT INTO objective_versions (objective_id, version, parent_group, layer, name, behavior, boundary, status, created_at)
       VALUES ('O-T8-01', 1, 'K000', 'structure', '测试目标', '测试行为', '测试边界', 'published', 0)`,
    ).run()
    let msg = ''
    try {
      conn.prepare("UPDATE objective_versions SET behavior = '被篡改' WHERE objective_id = 'O-T8-01' AND version = 1").run()
    } catch (e) { msg = String(e?.message) }
    expect(msg).toContain('OBJECTIVE_VERSION_PUBLISHED_IMMUTABLE')
    const row = conn.prepare("SELECT behavior FROM objective_versions WHERE objective_id = 'O-T8-01'").get()
    expect(row.behavior).toBe('测试行为')
    conn.prepare("DELETE FROM objective_versions WHERE objective_id = 'O-T8-01'").run()
  })
})

// ==================================================================
// W1 / T1：目标覆盖账本
// 合同：抽查单元的目标有原子行为、来源状态、前置、技能出口；未核验不显示“已覆盖”。
// ==================================================================
describe('W1/T1 目标覆盖账本', () => {
  it('216 个 K 组全部入库，抽查单元在账且状态诚实', async () => {
    const r = await call('/api/v1/map')
    expect(r.status).toBe(200)
    const map = r.json
    expect(map.mapVersion).toBe('map-v1')
    expect(map.summary.groups).toBe(216)
    expect(map.summary.byAtomization.pending).toBe(211)
    expect(map.summary.byAtomization.partial_draft).toBe(5)
    // 抽查：U01/U03/U39/U62/U64/U68/U71 都在账（T1 指定单元 + 一个低频高级目标 K214/U72）
    const unitIds = new Set(map.groups.map((g) => g.unitId))
    for (const u of ['U01', 'U03', 'U39', 'U62', 'U64', 'U68', 'U71']) expect(unitIds.has(u), u).toBe(true)
    const k214 = map.groups.find((g) => g.groupId === 'K214')
    expect(k214.atomizationStatus).toBe('pending') // 低频高级目标：诚实待拆
    // U72 不是遗漏收容箱：三个组各有具体名目
    for (const g of map.groups.filter((x) => x.unitId === 'U72')) expect(g.title.length).toBeGreaterThan(3)
    expect(map.summary.coveredClaims).toBe(0)
    expect(map.legacyNotice).toContain('不换算')
  })

  it('首批 15 条目标齐备：行为/边界/前置/技能出口/来源，未核验不冒充已验证', async () => {
    const map = (await call('/api/v1/map')).json
    expect(map.objectives.length).toBe(15)
    for (const o of map.objectives) {
      expect(o.behavior.length, o.objectiveId).toBeGreaterThan(10)
      expect(o.boundary.length, o.objectiveId).toBeGreaterThan(10)
      expect(Object.keys(o.skills).length, o.objectiveId).toBeGreaterThan(0)
      expect(o.sourceRefs.length, o.objectiveId).toBeGreaterThan(0)
      for (const s of o.sourceRefs) {
        expect(['external', 'teaching_heuristic'].includes(s.kind), s.ref).toBe(true)
        expect(s.claim.length).toBeGreaterThan(5)
        expect(s.limit.length, s.ref).toBeGreaterThan(5) // 来源必须带“不能推出”边界
      }
      expect(['claim_checked', 'design_rationale'].includes(o.verification), o.objectiveId).toBe(true)
      expect(o.status).toBe('draft') // 人审/音频/试学未完成，不许 published
      const g = map.groups.find((x) => x.groupId === o.parentGroup)
      expect(g.atomizationStatus, o.objectiveId).toBe('partial_draft') // 父组未完成细则对账
      expect(g.factReviewStatus).toBe('partial_claim_checked')
    }
    // 音频依赖的目标必须标 needs_audio（17：文本脚本不能用于听力认证）
    for (const id of ['O-K007-01', 'O-K007-02', 'O-K184-01']) {
      expect(map.objectives.find((o) => o.objectiveId === id).flags).toContain('needs_audio')
    }
  })

  it('前置图有效：引用存在、无环、登记一致；校验失败会让种子落库失败', async () => {
    const map = (await call('/api/v1/map')).json
    expect(map.validation.ok).toBe(true)
    const o115_03 = map.objectives.find((o) => o.objectiveId === 'O-K115-03')
    expect(o115_03.prerequisites).toEqual(['O-K115-01', 'O-K115-02']) // 是目标 ID，不是单元号
    // 环检测：A→B→A 必须被抓出来
    const { getDb, closeDb } = await import('./db.mjs')
    const { ensureV3Schema } = await import('./v3db.mjs')
    const { validateMap } = await import('./v3map.mjs')
    const conn = ensureV3Schema(getDb())
    const ins = conn.prepare(
      `INSERT INTO objective_versions (objective_id, version, parent_group, layer, name, behavior, boundary, prerequisites, status, created_at)
       VALUES (?,1,'K999','structure','x','x','x',?,'draft',0)`)
    try {
      ins.run('O-CY-A', JSON.stringify(['O-CY-B']))
      ins.run('O-CY-B', JSON.stringify(['O-CY-A']))
      const v = validateMap(conn)
      expect(v.ok).toBe(false)
      expect(v.errors.join('')).toContain('前置环')
    } finally {
      conn.prepare("DELETE FROM objective_versions WHERE objective_id IN ('O-CY-A','O-CY-B')").run()
    }
    void closeDb
  })

  it('单条目标可查（含来源明细），查不到给 404', async () => {
    const r = await call('/api/v1/map/objectives/O-K184-02')
    expect(r.status).toBe(200)
    expect(r.json.objective.name).toContain('转折')
    expect(r.json.objective.sourceRefs.map((s) => s.ref)).toEqual(expect.arrayContaining(['G3', 'G4']))
    expect((await call('/api/v1/map/objectives/O-NOPE')).status).toBe(404)
  })
})

// ==================================================================
// W2 / T2：三种画像 → 三种不同且可解释的后继；同一输入重放结果稳定
// ==================================================================
const ANSWERS = {
  rich_d1: '团队保留了手势控制，推迟了语音控制；因为语音原型在多人同时说话的展厅里失败了。although 的限制是：团队仍想探索语音交互，推迟不等于永久放弃。',
  fail_d1: '他们做了一个展览。',
  pass_d1b: '工具在小房间（安静的）可用，在大房间（吵的）失败。',
  pass_d2: '最终评价：这个工具可以帮我们找论文，值得读，但用之前必须自己读来源核查；最初按话题找到了论文，看起来很有用；后来发现摘要漏掉了原论文的重要限制。',
  fail_d2: 'AI 助手很有用，能帮助设计项目找灵感。',
  pass_d3: '我们从 AI 助手学到：它能帮我们找到值得读的论文，但摘要可能漏掉原文的重要限制，所以使用前必须自己读。我的项目里我会用它找材料，但会自己核查来源。',
  fail_d3: 'AI papers useful.',
}

async function playTask(accountId, activity) {
  const audio = await call(`/api/v1/accounts/${accountId}/tasks/${activity.taskId}/media/${activity.audio.mediaId}`)
  expect(audio.status).toBe(200)
  const played = await call(`/api/v1/accounts/${accountId}/support/play`, {
    taskId:activity.taskId, deliveryId:audio.json.deliveryId,eventId:`play-${Date.now()}-${Math.random()}`,
    activityId:activity.activityId,mediaId:activity.audio.mediaId,
  },'POST')
  expect(played.status).toBe(200)
}

async function runDiagnostic(accountId, script, requestId) {
  let cur = (await call(`/api/v1/accounts/${accountId}/diagnostics`, { requestId }, 'POST')).json
  const responses = []
  let guard = 0
  while (cur.status === 'open' && cur.activity && guard++ < 8) {
    // R4：听力活动必须先有服务端播放事件（媒体从清单按活动取）
    if (cur.activity.audio) {
      await playTask(accountId, cur.activity)
    }
    const r = await call(`/api/v1/accounts/${accountId}/attempts`, {
      attemptId: `${requestId}-${cur.step}`,
      taskId: cur.activity.taskId,
      sessionId: cur.diagnosticId,
      activityId: cur.activity.activityId,
      response: { kind: 'text', text: script[cur.step] ?? '' },
      conditions: {
        firstExposure: true, hintLevel: 0, transcriptShown: cur.step === 'D2b',
        playCount: cur.step === 'D2' || cur.step === 'D2b' ? 2 : 1,
        lookupUsed: false, responseMode: 'typed_summary',
      },
    }, 'POST')
    expect(r.status).toBe(200)
    responses.push(r.json)
    cur = r.json.diagnostic
  }
  expect(cur.status, `诊断应完成：${cur.step}`).toBe('completed')
  return { session: cur, responses }
}

describe('W2/T2 三种画像 → 三种后继', () => {
  it('P1 基础已会 → 挑战先行，不刷旧库存', async () => {
    const id = await mkAccount('T2-基础已会')
    const { session } = await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }, 'rq-p1')
    expect(session.tentative.route).toBe('challenge_first')
    const plan = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
    // 21 §6.1 新语义：D2 带合成音频 → O-K184-02 听力证据真实成立 → O-K184-03 前置满足 → 挑战先行。
    // O-K115-01/02 仍是 unmeasured（D1 没问 which），留在候选里不丢（F4：未问的目标没有成绩）
    expect(plan.primaryGoal).toBe('O-K115-01') // 未测关键词理解不再满足挑战前置
    expect(plan.strategyId).toBe('short_explain')
    expect(plan.reason).toBeTruthy()
    expect(plan.lesson.lessonId).toBe('les-relations-v1') // 有证据的近期可学前置，不凭词袋跳关
    // 逐目标结果：D1 不给 O-K115-01/02 搭车认证（unmeasured）
    const d1 = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K115-02`)).json
    expect(d1.states.length).toBe(0) // 未问的目标没有成绩
    const dropped = plan.notChosen.find((n) => n.objectiveId === 'O-K190-01')
    expect(dropped.reason).toBeTruthy()
  })

  it('P2 文字会声音卡 → L2 声音支线；文字证据保留，音频课诚实等待', async () => {
    const id = await mkAccount('T2-文字会声音卡')
    const { session } = await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.fail_d2, D2b: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }, 'rq-p2')
    expect(session.tentative.route).toBe('L2')
    expect(session.tentative.hypotheses).toContain('sound_segmentation_or_realtime')
    const plan = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
    expect(plan.primaryGoal).toBe('O-K007-02')
    expect(plan.strategyId).toBe('sound_segmentation')
    // W3 起策略能指到已发布的静态课包（开发样本）；听力证据在真音频前仍诚实未测
    expect(plan.lesson.lessonId).toBe('les-listening-v1')
    expect(plan.lesson.status).toBe('published')
    expect(plan.lesson.devSample).toBe(true)
    // 路由生效时 ranked[0] 不进 notChosen：排除项非空即可
    expect(plan.notChosen.length).toBeGreaterThan(0)
    // R3：D1 开放文本=词表练习反馈，不写证据——O-K115-03 如实无成绩（文字层"证据保留"已被 R3 收紧为练习）
    const ev = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K115-03`)).json
    expect(ev.states.length).toBe(0)
  })

  it('P3 理解会口述卡 → L3 检索/表达支线；口语证据诚实保持未测', async () => {
    const id = await mkAccount('T2-理解会口述卡')
    const { session } = await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.pass_d2, D3: ANSWERS.fail_d3 }, 'rq-p3')
    expect(session.tentative.route).toBe('L3')
    const plan = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
    expect(plan.primaryGoal).toBe('O-K190-01')
    expect(plan.strategyId).toBe('oral_retrieval')
    expect(plan.lesson.lessonId).toBe('les-oral-v1')
    expect(plan.lesson.devSample).toBe(true)
    expect(plan.reason).toContain('堆选择题')
    // 口述 fixture 不产生口语状态
    const ev = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K190-01`)).json
    expect(ev.states.filter((s) => s.skill === 'speaking').every((s) => s.state === 'unmeasured')).toBe(true)
  })

  it('三种画像的推荐明显不同；无新证据时重放结果稳定；requestId 幂等', async () => {
    const plans = []
    for (const [tag, script] of [
      ['A', { D1: ANSWERS.rich_d1, D2: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }],
      ['B', { D1: ANSWERS.rich_d1, D2: ANSWERS.fail_d2, D2b: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }],
      ['C', { D1: ANSWERS.rich_d1, D2: ANSWERS.pass_d2, D3: ANSWERS.fail_d3 }],
    ]) {
      const id = await mkAccount('T2-对比' + tag)
      await runDiagnostic(id, script, 'rq-' + tag)
      plans.push((await call(`/api/v1/accounts/${id}/plan`)).json.decision)
    }
    const sig = new Set(plans.map((p) => p.primaryGoal + '/' + p.strategyId))
    expect(sig.size).toBe(3)
    for (const p of plans) expect(p.reason.length).toBeGreaterThan(10)

    // 重放：不产生新证据，再算一次 → 决策内容一致（decisionId 可以不同）
    const id = await mkAccount('T2-重放')
    await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.fail_d2, D2b: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }, 'rq-r1')
    const d1 = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
    const d2 = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: 'rq-r2' }, 'POST')).json.decision
    expect(d2.primaryGoal).toBe(d1.primaryGoal)
    expect(d2.strategyId).toBe(d1.strategyId)
    expect(d2.reason).toBe(d1.reason)
    expect(d2.notChosen.map((n) => n.objectiveId + n.reason)).toEqual(d1.notChosen.map((n) => n.objectiveId + n.reason))
    // requestId 幂等：同 requestId 返回同一决策
    const d3 = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: 'rq-r2' }, 'POST')).json.decision
    expect(d3.decisionId).toBe(d2.decisionId)
  })

  it('D1b 只是定位：结构卡画像走 L1，但定位成功不升级掌握', async () => {
    const id = await mkAccount('T2-结构卡')
    const { session } = await runDiagnostic(id, { D1: ANSWERS.fail_d1, D1b: ANSWERS.pass_d1b, D2: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }, 'rq-s')
    expect(session.tentative.route).toBe('L1')
    expect(session.tentative.hypotheses).toContain('relation_modifier_or_retention')
    const plan = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
    expect(plan.primaryGoal).toBe('O-K115-01')
    expect(plan.strategyId).toBe('short_explain')
    expect(plan.lesson.activityId).toBe('les_l1_sensor_read')
    const ev = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K115-01`)).json
    // R3：D1 失败与 D1b 定位都是开放文本词表检查 → 纯练习反馈，不写任何状态（比"最多 tentative"更诚实）
    expect(ev.states.length).toBe(0)
  })
})

// ==================================================================
// W2 / T3：争议与坏材料 —— 用户不降级，holdout 不被污染
// ==================================================================
describe('W2/T3 争议与坏材料', () => {
  it('报告坏题 → 该次证据争议、状态不降级、材料隔离', async () => {
    const id = await mkAccount('T3-坏题')
    // 争议基底用 ct01（纯封闭、reasonAssessed=true，可升 trained；29 号 A1 后 ct03 是中性参与证据）
    const post = (attemptId, answers) => call(`/api/v1/accounts/${id}/attempts`, {
      attemptId, activityId: 'ct01_which_probe',
      response: { kind: 'choice', text: '', answers },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    const good = await post('t3-ct01-good', { which_a: 'DEVICE', which_b: 'EVENT', tail_role: 'B' })
    expect(good.json.pass).toBe(true)
    const before = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K115-02`)).json
    expect(before.states[0].state).toBe('trained')

    const rep = await call(`/api/v1/accounts/${id}/content-reports`, {
      attemptId: 't3-ct01-good', location: '选项 B 的题面歧义', description: '选项情境与原文决定存在歧义',
    }, 'POST')
    expect(rep.status).toBe(200)
    expect(rep.json.certificationPaused).toBe(true)

    const after = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K115-02`)).json
    expect(after.states[0].state).toBe('trained') // 不降级
    expect(after.states.some((s) => s.flags.includes('disputed'))).toBe(true) // 只挂争议（base 聚合行）
    expect(after.disputedAttempts.length).toBeGreaterThan(0)
    // 后续推荐：避开争议材料，不降级用户
    const plan = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: 'rq-t3-plan' }, 'POST')).json.decision
    const allNotChosen = plan.notChosen.map((n) => n.objectiveId).join(',')
    expect(allNotChosen).toContain('O-K115-02')
    expect(plan.notChosen.find((n) => n.objectiveId === 'O-K115-02').reason).toContain('争议')
  })

  it('holdout：答案与评分要点永不下发；被报告后隔离，不再计分', async () => {
    const id = await mkAccount('T3-holdout')
    const good = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'hold-1', activityId: 'hold_maker_booking_audio',
      response: { kind: 'text', text: '讲者推荐提前预约（book in advance）；拒绝了晚上打印更便宜这个结论；试点只有三周；下学期用两个完整学期比较。' },
      conditions: { firstExposure: true, transcriptShown: false, playCount: 1, hintLevel: 0, responseMode: 'typed_summary' },
    }, 'POST')
    expect(good.status).toBe(200)
    expect(good.json.evaluationStatus).toBe('evaluated')
    expect(good.json.pass).toBe(true)
    expect(good.json.dimensions).toBeUndefined() // 维度命中会泄露保留题的评分要点
    expect(JSON.stringify(good.json)).not.toContain('anyOf')
    // holdout 永不出现在推荐里
    await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }, 'rq-h1')
    const plan = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
    expect(JSON.stringify(plan)).not.toContain('hold_maker_booking_audio')

    // 报告后隔离：之后的尝试直接进争议，不再计正分
    const rep = await call(`/api/v1/accounts/${id}/content-reports`, {
      activityId: 'hold_maker_booking_audio', description: '音频脚本转写与原声不符',
    }, 'POST')
    expect(rep.json.certificationPaused).toBe(true)
    const again = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'hold-2', activityId: 'hold_maker_booking_audio',
      response: { kind: 'text', text: '讲者推荐提前预约；试点只有三周；用两个完整学期比较；拒绝了更便宜的结论。' },
      conditions: { firstExposure: true, transcriptShown: false, playCount: 1, hintLevel: 0, responseMode: 'typed_summary' },
    }, 'POST')
    expect(again.json.evaluationStatus).toBe('disputed')
  })
})

// ==================================================================
// W2 / T4：斩掉 —— 同层同质消失；复杂任务失败只开局部短修复
// ==================================================================
describe('W2/T4 斩掉与局部修复', () => {
  it('免修基础目标后，复杂任务失败只开短修复，不批量重刷', async () => {
    const id = await mkAccount('T4-斩掉')
    await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }, 'rq-t4')
    // 用户斩掉 O-K115-01（读）
    const w = await call(`/api/v1/accounts/${id}/waivers`, {
      objectiveId: 'O-K115-01', skill: 'reading', reason: '这部分我已经会了',
    }, 'POST')
    expect(w.json.flags).toContain('waived_by_user')
    expect(w.json.state).not.toBe('retained') // 免修 ≠ 认证
    let plan = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: 'rq-t4-w' }, 'POST')).json.decision
    expect(plan.primaryGoal).not.toBe('O-K115-01')
    expect(plan.notChosen.find((n) => n.objectiveId === 'O-K115-01').reason).toContain('waived')

    // 复杂任务失败（film 家族，O-K115-01/03）
    const fail = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'complex-1', activityId: 'rep_film_postpone_read',
      response: { kind: 'text', text: '影片本身差，所以我们放弃了它。' },
      conditions: { firstExposure: true, hintLevel: 0, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    expect(fail.json.pass).toBe(false)
    plan = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: 'rq-t4-f' }, 'POST')).json.decision
    expect(plan.primaryGoal).toBe('O-K115-01') // 只针对暴露的缺口
    expect(plan.strategyId).toBe('short_repair')
    expect(plan.reason).toContain('局部短修复')
    expect(plan.lesson.activityId).toBe('diag_d1b_contrast') // 定位题，不是成批基础重刷
    // 状态：免修保留 + 需要修复标志，仍不降级为已认证
    const ev = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K115-01`)).json
    expect(ev.states[0].flags).toEqual(expect.arrayContaining(['waived_by_user', 'needs_repair']))
    // F1 语义：O-K115-01 未被 D1 认证过（unmeasured）——免修+待修复成立，但不冒充 trained
    expect(ev.states[0].state).toBe('unmeasured')
  })
})

// ==================================================================
// W2 / 附加：幂等、条件校验、诚实未实现
// ==================================================================
describe('W2/附加 幂等与诚实状态', () => {
  it('attemptId 幂等：同正文重放返回首次结果；异正文自动 bump 下一轮 take（不再 409 卡人，2026-10-01 用户实测）；缺条件 400', async () => {
    const id = await mkAccount('W2-幂等')
    const body = {
      attemptId: 'idem-1', activityId: 'diag_d1_read',
      response: { kind: 'text', text: ANSWERS.rich_d1 },
      conditions: { firstExposure: true, hintLevel: 0, lookupUsed: false, responseMode: 'typed_summary' },
    }
    const r1 = await call(`/api/v1/accounts/${id}/attempts`, body, 'POST')
    expect(r1.json.saved).toBe(true)
    const r2 = await call(`/api/v1/accounts/${id}/attempts`, body, 'POST')
    expect(r2.status).toBe(200)
    expect(r2.json.attemptId).toBe('idem-1')
    // 异正文：新语义 = 服务端自动分配 -t2 落新行（历史不覆盖），响应带 attemptIdUsed
    const r3 = await call(`/api/v1/accounts/${id}/attempts`, { ...body, response: { kind: 'text', text: '别的回答' } }, 'POST')
    expect(r3.status).toBe(200)
    expect(r3.json.attemptIdUsed).toBe('idem-1-t2')
    const r4 = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'idem-2', activityId: 'diag_d1_read', response: { kind: 'text', text: 'x' },
      conditions: { firstExposure: true },
    }, 'POST')
    expect(r4.status).toBe(400)
  })

  it('课程包服务、提示逐层揭晓、完成/撤回；录音接口诚实未实现（W5）', async () => {
    const id = await mkAccount('W3-课程包')
    // W5 起 /oral 是真实合同：裸 POST 提示走 intent 上传链路
    expect([400, 404]).toContain((await call(`/api/v1/accounts/${id}/oral`, {}, 'POST')).status)
    // 无诊断时不给推荐（不用旧题凑数）
    const empty = (await call(`/api/v1/accounts/${id}/plan`)).json
    expect(empty.decision).toBeNull()
    expect(empty.note).toContain('入口诊断')

    // 课程包：published 才可见，无 holdout 答案，带开发样本标记
    const list = (await call('/api/v1/lessons')).json.lessons
    expect(list.map((l) => l.lessonId)).toEqual(expect.arrayContaining(['les-relations-v1', 'les-listening-v1', 'les-oral-v1']))
    expect(list.every((l) => l.humanReview === 'pending')).toBe(true) // 无人审签署：全带标记

    const pkg = (await call(`/api/v1/accounts/${id}/lessons/les-relations-v1`)).json
    expect(pkg.whyNow).toContain('D1')
    expect(pkg.teachingNote).toContain('连接词') // 精华讲解在课包里（15 §7）
    expect(pkg.devSampleNotice).toContain('人审未签署')
    expect(pkg.activities.length).toBe(2)
    expect(JSON.stringify(pkg)).not.toContain('anyOf') // 评分要点不下发
    // 深层提示只在逐层揭示接口出现，不随课包首屏下发（15 §9）
    expect(JSON.stringify(pkg)).not.toContain('空框填空')
    expect(pkg.activities[0].hintStageCount).toBeGreaterThan(0)
    // holdout 不可作为课包被取到
    expect((await call(`/api/v1/accounts/${id}/lessons/hold_maker_booking_audio`)).status).toBe(404)

    // 提示逐层：第 1 层可取；跳层拒绝；越界拒绝
    const h1 = await call(`/api/v1/accounts/${id}/lessons/les-relations-v1/hints`, { activityId: 'les_l1_sensor_read', level: 1 }, 'POST')
    expect(h1.json.hint).toContain('that') // 第 1 层 = 课包 hintStages 第 1 层（线索词）
    // 跳层：没揭示过第 1 层的账户直接取第 2 层 → HINT_LEVEL_SKIPPED
    const id2 = await mkAccount('W3-提示跳层')
    const skip = await call(`/api/v1/accounts/${id2}/lessons/les-relations-v1/hints`, { activityId: 'les_l1_sensor_read', level: 2 }, 'POST')
    expect(skip.status).toBe(400)
    const h2 = await call(`/api/v1/accounts/${id}/lessons/les-relations-v1/hints`, { activityId: 'les_l1_sensor_read', level: 2 }, 'POST')
    expect(h2.status).toBe(200) // 已揭示 1 层后可取第 2 层
    expect(h2.json.hint).toContain('空框填空') // 第 2 层 = 空框提示
    expect((await call(`/api/v1/accounts/${id}/lessons/les-relations-v1/hints`, { activityId: 'les_l1_sensor_read', level: 3 }, 'POST')).status).toBe(400)

    // 服务端覆盖自报：谎称"无提示首见"也换不来独立证据（提示揭示记录覆盖 hintLevel）
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'les-l1-a1', activityId: 'les_l1_sensor_read',
      response: { kind: 'text', text: '出问题的是实验室里准的那颗传感器；现在可用于室内测试；公开活动的安装被推迟到灯光下检查。' },
      conditions: { firstExposure: true, hintLevel: 0, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    const { getDb } = await import('./db.mjs')
    const conn = (await import('./v3db.mjs')).ensureV3Schema(getDb())
    const cond = JSON.parse(conn.prepare("SELECT conditions FROM learner_attempts_v3 WHERE attempt_id = 'les-l1-a1'").get().conditions)
    expect(cond.hintLevel).toBe(2) // 被服务端揭示记录覆盖为 2 → 记 hinted，封顶 trained

    // 计划 → 取课（served）→ 做课内活动 → 完成（completed）
    await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.fail_d2, D2b: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }, 'rq-l1')
    await call(`/api/v1/accounts/${id}/lessons/les-listening-v1`)
    let plan = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
    expect(plan.status).toBe('served')
    // R4：听力作答前先落服务端播放事件
    const issuedL2 = (await call(`/api/v1/accounts/${id}/lessons/les-listening-v1`)).json.activities.find(a => a.activityId === 'les_l2_museum_map_audio')
    await playTask(id, issuedL2)
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'l2-1', taskId: issuedL2.taskId, activityId: 'les_l2_museum_map_audio',
      response: { kind: 'text', text: '地图按设计正常工作，不完整的是对访客需求的假设；有访客以为里面有意思才走向拥挤的房间。' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, responseMode: 'typed_summary' },
    }, 'POST')
    // 课内活动没做完 → 拒绝完成（服务端设防，不只靠 UI）
    expect((await call(`/api/v1/accounts/${id}/lessons/les-listening-v1/complete`, {}, 'POST')).status).toBe(400)
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'l2-2', activityId: 'les_l2b_museum_transcript',
      response: { kind: 'text', text: 'that 从句修饰地图；because 解释部分访客的动机；Could we ask visitors why they chose that route?' },
      conditions: { firstExposure: true, transcriptShown: true, playCount: 1, responseMode: 'typed_summary' },
    }, 'POST')
    const done = await call(`/api/v1/accounts/${id}/lessons/les-listening-v1/complete`, {}, 'POST')
    expect(done.json.planCompleted).toBe(true)

    // 门控：L3 的未预告追问在复述提交前不可见（18 §6）
    const l3a = (await call(`/api/v1/accounts/${id}/lessons/les-oral-v1`)).json
    expect(JSON.stringify(l3a)).not.toContain('If the map worked')
    expect(l3a.activities.length).toBe(1)
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'l3-1', activityId: 'les_l3_oral_recap',
      response: { kind: 'text', text: '团队预期人们选更安静的路线，实际有人走向拥挤的房间；地图正常，假设不完整；下一步问访客为什么。' },
      conditions: { firstExposure: true, hintLevel: 0, responseMode: 'typed_summary' },
    }, 'POST')
    const l3b = (await call(`/api/v1/accounts/${id}/lessons/les-oral-v1`)).json
    expect(l3b.activities.length).toBe(2) // 追问现在才解锁

    // 撤回改用一次性课包（les-listening-v1 保持可用，供 T6 窗口测试）
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'disp-1', activityId: 'ct02_nested_which',
      response: { kind: 'choice', text: '第一处 which 说媒体实验室最近买了设备；第二处指更换电源并继续展出这件事，使访客仍能看到装置。', answers: { which_1: 'LAB', which_2: 'POWER', software_why: 'RUNNING_OK' } },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    expect((await call('/api/v1/lessons/les-disposable-v1/withdraw', { reason: 'x' }, 'POST')).status).toBe(400) // 无 confirm
    const wd = await call('/api/v1/lessons/les-disposable-v1/withdraw', { reason: '测试撤回：字幕与音频不一致', confirm: 'les-disposable-v1' }, 'POST')
    expect(wd.json.ok).toBe(true)
    expect(wd.json.affectedRecheckEvents).toBeGreaterThan(0)
    expect((await call(`/api/v1/accounts/${id}/lessons/les-disposable-v1`)).status).toBe(404) // 停止新分发
    const again = await call('/api/v1/lessons')
    expect(again.json.lessons.find((l) => l.lessonId === 'les-disposable-v1').contentStatus).toBe('withdrawn')
    const { getDb: gd } = await import('./db.mjs')
    const c2 = (await import('./v3db.mjs')).ensureV3Schema(gd())
    let resurrect = ''
    try {
      c2.prepare("UPDATE lesson_versions SET content_status = 'published' WHERE lesson_id = 'les-disposable-v1'").run()
    } catch (e) { resurrect = String(e?.message) }
    expect(resurrect).toContain('LESSON_WITHDRAWN_TERMINAL')
  })

  it('挑战被前置挡住 → 回落到证据候选的课并如实标 devSample；人审签署走 mainline', async () => {
    const id = await mkAccount('W3-fixture')
    // D2 失败：O-K184-02 听力证据未就绪 → O-K184-03 前置被挡 → 回落到听力修复支线（21 §6.1 后的真实回落画像）
    await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.fail_d2, D3: ANSWERS.pass_d3 }, 'rq-fx')
    const plan = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
    expect(plan.primaryGoal).toBe('O-K007-02')
    expect(plan.strategyId).toBe('sound_segmentation')
    expect(plan.lesson.lessonId).toBe('les-listening-v1')
    expect(plan.lesson.devSample).toBe(true)
    // 签署路径：pending → signed（mainline）；机器不能代签
    expect((await call('/api/v1/lessons/les-oral-v1/sign', { note: 'x' }, 'POST')).status).toBe(400) // 无 reviewer
    const sg = await call('/api/v1/lessons/les-oral-v1/sign', { reviewer: '张俊杰教学思路复核（placeholder）', note: '待真人签署' }, 'POST')
    expect(sg.json.humanReview).toBe('signed')
    const l = (await call('/api/v1/lessons')).json.lessons.find((x) => x.lessonId === 'les-oral-v1')
    expect(l.humanReview).toBe('signed')
  })

  it('发布过的课程包不可改写内容（撤回除外），修订必须开新版本', async () => {
    const { getDb } = await import('./db.mjs')
    const conn = (await import('./v3db.mjs')).ensureV3Schema(getDb())
    let msg = ''
    try {
      conn.prepare(
        `UPDATE lesson_versions SET why_now = '被篡改' WHERE rowid =
           (SELECT rowid FROM lesson_versions WHERE lesson_id = 'les-relations-v1' ORDER BY version DESC LIMIT 1)`).run()
    } catch (e) { msg = String(e?.message) }
    expect(msg).toContain('LESSON_VERSION_PUBLISHED_IMMUTABLE')
  })
})

// ==================================================================
// W4 / T5：生成质量门 —— 坏输出全部不得发布；T6：窗口重估与模型失败回退
// ==================================================================
describe('W4/T5+T6 按需生成供给', () => {
  beforeAll(() => { process.env.ENGLISHFORGE_V4_GENERATION = '1' })
  afterAll(() => { delete process.env.ENGLISHFORGE_V4_GENERATION })
  const goodPkg = {
    title: '把转折接回主张', whyNow: 'D2 首听漏结论：先抓 but 之前的主张，再看它对照什么。',
    teachingNote: '说话人先说一件事看起来不错，再用 but 换到另一面：but 前是他承认的，but 后才是他真正要说的。',
    explanationKind: 'established',
    activities: [
      { taskFamilyId: 'gen_contrast_a', materialId: 'mat_g3_contrast_texts', prompt: '听：The app looked perfect in the demo, but it crashed every hour at school. 问：说话人真正强调什么？', hints: ['but 之后是重点'],
        relations: [{ id: 'demo', label: 'demo 里看起来完美', anyOf: ['demo', '演示', '看起来'], required: true }, { id: 'crash', label: '学校里每小时崩', anyOf: ['crash', '崩', 'school', '学校'], required: true }] },
      { taskFamilyId: 'gen_contrast_b', materialId: 'mat_g3_contrast_texts', prompt: 'Our first test worked well, but real users stopped at step three. 问：两半分别是什么？', hints: [],
        relations: [{ id: 'test', label: '首测顺利', anyOf: ['test', '测试', 'worked'], required: true }, { id: 'step3', label: '真实用户停在第三步', anyOf: ['step', '第三', 'users'], required: true }] },
    ],
    sourceRefs: [{ ref: 'G3', claim: 'but 表示对照' }],
  }
  // C4：来源命题按目标声明选——账本里每个代号都有已核命题；夹具照抄账本主张
  const ledgerClaims = {
    G1: '限定从句限定所指对象；非限定从句补充信息',
    G3: 'but 表示对照；although/though 引导从属对照分句',
    G4: '话语标记帮助组织、转换和管理所说内容',
    C1: '互动、澄清、转述、音系维度可用于设计真实任务',
    T: 'C15 提供“声音—结构—简化”的解释入口',
  }
  const pkgFor = (refs) => ({ ...goodPkg, sourceRefs: refs.map((ref) => ({ ref, claim: ledgerClaims[ref.split(':')[0]] })) })
  const fakeChat = (payload) => async () => JSON.stringify(typeof payload === 'function' ? payload() : payload)

  it('T5：空字段/无来源/术语解析/家族重复/截断 —— 全部拒收且留原因；好输出经全门发布（dev_only）', async () => {
    const id = await mkAccount('W4-T5')
    await call('/api/v1/map') // 自给自足：不依赖其它测试先播种账本
    const gen = await import('./v3gen.mjs')
    const prior = await call(`/api/v1/accounts/${id}/attempts`, { attemptId:'t5-seen', activityId:'diag_d1_read', response:{kind:'text',text:'test'}, conditions:{firstExposure:true,hintLevel:0,transcriptShown:false,playCount:0,lookupUsed:false,responseMode:'typed_summary'} }, 'POST')
    expect(prior.status).toBe(200)
    const bad = [
      ['schema 缺字段', { title: '', whyNow: '', teachingNote: '', activities: [], sourceRefs: [] }],
      ['无来源', { ...goodPkg, sourceRefs: [] }],
      ['来源只报代号无命题（C4）', { ...goodPkg, sourceRefs: [{ ref: 'G3' }] }],
      ['来源代号目标未声明（C4）', { ...goodPkg, sourceRefs: [{ ref: 'G5', claim: '未重读的 can 常变为 /kən/' }] }],
      ['解析含术语', { ...goodPkg, teachingNote: 'but 引导的从句在句中作状语，主语是真主语。' }],
      ['家族与最近重复', { ...goodPkg, activities: goodPkg.activities.map((a) => ({ ...a, taskFamilyId: 'exhibit_decision_read_A' })) }],
      ['包内同内容换标签（C4 指纹）', { ...goodPkg, activities: [goodPkg.activities[0], { ...goodPkg.activities[0], taskFamilyId: 'gen_contrast_c' }] }],
    ]
    for (const [label, payload] of bad) {
      const r = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', strategyId: 'sound_segmentation', chat: fakeChat(payload), await: true, force: true })
      expect(r.status, label).toBe('rejected')
      // 连续失败会进入冷却（§7 撤出候选）：冷却复用上次结论，不带新 reasons
      if (!r.cooledDown) expect(r.reasons.length, label).toBeGreaterThan(0)
    }
    // 截断（非法 JSON）
    const trunc = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', chat: async () => '{"title":"半截', await: true, force: true })
    expect(trunc.status).toBe('rejected')
    // 好输出：阅读目标（claim_checked）→ 自动发布（dev_only 通道）；来源按目标声明带命题（C4）
    const okJob = await gen.startGenerationJob(id, { objectiveId: 'O-K115-01', strategyId: 'short_explain', chat: fakeChat(pkgFor(['G1'])), await: true, force: true })
    expect(okJob.status).toBe('succeeded')
    expect(okJob.published).toBe(true)
    // C4：生成课落账户 scope——操作者列表可见 scope；他人直连取课被拒
    const lessons = (await call('/api/v1/lessons')).json.lessons
    const genLesson = lessons.find((l) => l.lessonId === okJob.lessonId)
    expect(genLesson.contentStatus).toBe('published')
    expect(genLesson.accountScope).toBe(id)
    const other = await mkAccount('W4-T5-他人')
    const v3lessons = await import('./v3lessons.mjs')
    let leaked = ''
    try { v3lessons.serveLesson(other, okJob.lessonId) } catch (e) { leaked = String(e?.message) }
    expect(leaked).toContain('ACTIVITY_NOT_PUBLISHED')
    expect(v3lessons.lessonForObjective('O-K115-01', { excludeCompletedFor: other })?.lessonId).not.toBe(okJob.lessonId)
    // 听力目标（O-K184-02）：文本课不能给听力证据（15 §5 技能不互升）→ 强制人审，不自动发布
    const listenJob = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', strategyId: 'sound_segmentation', chat: fakeChat(pkgFor(['G3'])), await: true, force: true })
    expect(listenJob.status).toBe('succeeded')
    expect(listenJob.published).toBe(false)
    const listenRow = (await call(`/api/v1/accounts/${id}/generation`)).json.jobs.find((j) => j.job_id === listenJob.jobId)
    expect(JSON.parse(listenRow.validation).pending).toBe('human_sign')
    // 未核验目标（design_rationale）→ 只到 ready 等签署，不自动发布
    const pend = await gen.startGenerationJob(id, { objectiveId: 'O-K190-01', chat: fakeChat(pkgFor(['T'])), await: true, force: true })
    expect(pend.status).toBe('succeeded')
    expect(pend.published).toBe(false)
    // 指标：拒收率/原因可查；旧 published 种子课没丢
    const m = (await call(`/api/v1/accounts/${id}/generation`)).json.metrics
    expect(m.rejected).toBeGreaterThanOrEqual(7)
    expect(m.succeeded).toBe(3)
    expect(m.rejectionRate).toBeGreaterThan(0)
    expect(lessons.filter((l) => l.lessonId.startsWith('les-')).length).toBeGreaterThanOrEqual(3)
  }, 30000)

  it('C4 回归：旧题改名换皮被内容指纹拦下；真新内容不受牵连', async () => {
    const id = await mkAccount('W4-C4指纹')
    await call('/api/v1/map')
    const acts = (await import('./data/v3-activities.json')).default
    const donor = acts.activities.find((a) => a.role === 'practice' && !a.holdout && a.prompt
      && ((a.relations ?? a.evaluationContract?.relations) ?? []).length >= 1
      && ((a.relations ?? a.evaluationContract?.relations) ?? []).every((r) => Array.isArray(r.anyOf) && r.anyOf.length >= 2))
    // 该账户真实作答过 donor → 内容指纹进入账户历史
    const att = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'c4fp-1', activityId: donor.activityId,
      response: { kind: 'text', text: ((donor.relations ?? donor.evaluationContract?.relations) ?? []).map((r) => r.anyOf?.[0] ?? '').join('；') },
      conditions: { firstExposure: true, transcriptShown: true, playCount: 1, hintLevel: 0, responseMode: 'typed_summary' },
    }, 'POST')
    expect(att.status).toBe(200)
    const gen = await import('./v3gen.mjs')
    const fakeChat = (payload) => async () => JSON.stringify(payload)
    // 换皮包：家族标签全新，但 prompt+关系+候选句与作答过的旧题完全一致
    // （静态活动的关系在 evaluationContract 里；生成包用顶层 relations，内容一致指纹才一致）
    const reskin = {
      title: '看起来全新的一课', whyNow: '旧题换了名字重新投递应该被识破。', teachingNote: '白话解释，不含术语词。',
      explanationKind: 'established',
      activities: [donor, { ...donor, prompt: donor.prompt + '（第二批）' }].map((a, i) => ({
        ...a, taskFamilyId: `brand_new_family_${i}`,
        relations: a.evaluationContract?.relations ?? a.relations,
      })),
      sourceRefs: [{ ref: 'G3', claim: 'but 表示对照；although/though 引导从属对照分句' }],
    }
    const r = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', strategyId: 'sound_segmentation', chat: fakeChat(reskin), await: true, force: true })
    expect(r.status).toBe('rejected')
    expect(r.reasons.join('')).toContain('familyFresh')
    // 对照组：真新内容（不同 prompt/关系）+ 绑定已审素材，同账户正常过门
    const fresh = {
      ...reskin,
      title: '真正的新课', activities: [
        { taskFamilyId: 'fresh_fam_a', materialId: 'mat_g3_contrast_texts', prompt: 'New plan, new problems: the team changed the schedule twice this week. 问：改变了几次？', hints: [],
          relations: [{ id: 'twice', label: '改了两次', anyOf: ['twice', '两次', 'two'], required: true }, { id: 'sched', label: '改的是日程', anyOf: ['schedule', '日程', '计划'], required: true }] },
        { taskFamilyId: 'fresh_fam_b', materialId: 'mat_g3_contrast_texts', prompt: 'The printer jammed again, so we switched rooms. 问：结果是什么？', hints: [],
          relations: [{ id: 'switch', label: '换了房间', anyOf: ['switch', '换', 'room'], required: true }, { id: 'jam', label: '原因又是卡纸', anyOf: ['jam', '卡纸', 'printer'], required: true }] },
      ],
    }
    const ok = await gen.startGenerationJob(id, { objectiveId: 'O-K184-02', strategyId: 'sound_segmentation', chat: fakeChat(fresh), await: true, force: true })
    expect(ok.status).toBe('succeeded')
  }, 30000)

  it('T6：学第 1 课时证据前进 → 缓存课被作废留痕；模型失败 → job failed 且有适配后继或诚实不足', async () => {
    const id = await mkAccount('W4-T6')
    await call('/api/v1/map')
    await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.fail_d2, D2b: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }, 'rq-t6')
    // 建窗：L2 路线有已发布课 → 缓存 ready
    const w = (await call(`/api/v1/accounts/${id}/window`)).json
    expect(w.slots.some((s) => s.status === 'ready')).toBe(true)
    // 学一点新东西（证据前进）→ 重估 → 缓存作废 + 原因。
    // R3 后用封闭题（ct03）产生真实证据事件；开放题纯练习不写认证事件，但同样需要用于后续教学重估
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 't6-extra', activityId: 'ct03_semantics_guard',
      response: { kind: 'choice', text: '因为多人同时说话时原型在展厅表现不好，他们并未完全放弃语音。', answers: { decision: 'A' } },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    const re = (await call(`/api/v1/accounts/${id}/window/reestimate`, { trigger: 'after_lesson' }, 'POST')).json
    expect(re.invalidated).toBeGreaterThan(0)
    const { getDb } = await import('./db.mjs')
    const conn = (await import('./v3db.mjs')).ensureV3Schema(getDb())
    const inv = conn.prepare("SELECT invalidated_reason FROM lesson_cache WHERE account_id = ? AND status = 'invalidated'").all(id)
    expect(inv[0].invalidated_reason).toContain('learning_feedback_changed')
    // 模型失败：job failed + 诚实状态；计划层回退到已审核替代（种子课）不循环熟题
    const gen = await import('./v3gen.mjs')
    const boom = await gen.startGenerationJob(id, { objectiveId: 'O-K115-03', chat: async () => { throw new Error('provider down') }, await: true })
    expect(boom.status).toBe('failed')
    // 冷却：同目标自动重射被拦（§7 撤出候选）；force 可显式重试
    const cooled = await gen.startGenerationJob(id, { objectiveId: 'O-K115-03', chat: async () => JSON.stringify(goodPkg), await: true })
    expect(cooled.cooledDown).toBe(true)
    const jobs = (await call(`/api/v1/accounts/${id}/generation`)).json.jobs
    expect(jobs.find((j) => j.status === 'failed')).toBeTruthy()
    // 生成关闭时窗口诚实告知（默认防误计费）
    const w2 = (await call(`/api/v1/accounts/${id}/window`)).json
    expect(w2.slots.every((s) => s.status !== 'generating')).toBe(true)
  }, 30000)
})

// ==================================================================
// W5 / T7：口语 —— 跟读与自主表达证据分离；噪声低置信争议不降级；人审签署才升级
// ==================================================================
describe('W5/T7 口语与真实材料', () => {
  async function uploadOral(id, tag, mime = 'audio/wav') {
    const intent = (await call(`/api/v1/accounts/${id}/oral/intent`, {
      activityId: 'les_l3_oral_recap', mime, bytes: 1024, durationMs: 45_000,
    }, 'POST')).json
    expect(intent.token).toBeTruthy()
    const put = await call(`/api/v1/accounts/${id}/oral/${intent.mediaId}`, makeWav(900), 'PUT', new URLSearchParams({ token: intent.token }))
    expect(put.json.playable).toBe(true)
    return intent.mediaId
  }

  it('上传→作答：机器只是建议、口语状态保持未测；自由复述与跟读证据分离', async () => {
    const id = await mkAccount('W5-T7')
    const media = await uploadOral(id, 'free-recall')
    const r = await call(`/api/v1/accounts/${id}/attempts/oral`, {
      attemptId: 'oral-free-1', mediaId: media, activityId: 'les_l3_oral_recap',
      transcript: '团队预期人们选更安静的路线，实际有人走向拥挤的房间；地图按设计正常，假设不完整；下一步问访客为什么。',
      transcriptOrigin: 'asr',
      conditions: { firstExposure: true, hintLevel: 0, lookupUsed: false, responseMode: 'oral_recording' },
    }, 'POST')
    expect(r.status).toBe(200)
    expect(r.json.evaluationStatus).toBe('evaluated')
    expect(r.json.machineFeedback.note).toContain('不用于口语认证')
    expect(r.json.transcriptVersions[0].origin).toBe('asr')
    const ev = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K190-01`)).json
    expect(ev.states.filter((s) => s.skill === 'speaking').every((s) => s.state === 'unmeasured')).toBe(true)
    // 跟读类（另一活动、另一媒体）：证据按活动分开记，互不兑换
    const media2 = await uploadOral(id, 'shadowing')
    const r2 = await call(`/api/v1/accounts/${id}/attempts/oral`, {
      attemptId: 'oral-shadow-1', mediaId: media2, activityId: 'diag_d3_oral_typed',
      transcript: 'The team expected a quieter route, but some visitors walked to the crowded rooms.',
      conditions: { firstExposure: true, hintLevel: 0, lookupUsed: false, responseMode: 'oral_recording' },
    }, 'POST')
    expect(r2.json.evaluationStatus).toBe('evaluated')
    const ev2 = (await call(`/api/v1/accounts/${id}/evidence`)).json
    expect(ev2.states.filter((s) => s.skill === 'speaking').every((s) => s.state === 'unmeasured')).toBe(true)
    // 回放：只有所有者能取
    const audio = await call(`/api/v1/accounts/${id}/oral/${media}/audio`)
    expect(audio.json.audioBase64).toBeTruthy()
    const other = await mkAccount('W5-他人')
    expect((await call(`/api/v1/accounts/${other}/oral/${media}/audio`)).status).toBe(404)
  })

  it('噪声低置信 → 争议不降级；用户可纠转写且原版保留；人审签署才升级口语状态', async () => {
    const id = await mkAccount('W5-T7噪声')
    const media = await uploadOral(id, 'noisy')
    const r = await call(`/api/v1/accounts/${id}/attempts/oral`, {
      attemptId: 'oral-noisy-1', mediaId: media, activityId: 'les_l3_oral_recap',
      transcript: '呃 the team expect… 安静 route… but 拥挤…',
      transcriptOrigin: 'asr',
      conditions: { firstExposure: true, hintLevel: 0, lookupUsed: false, responseMode: 'oral_recording', transcriptReliability: 'low' },
    }, 'POST')
    expect(r.json.evaluationStatus).toBe('disputed')
    expect(r.json.nextAction).toBe('review_transcript')
    const ev = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K190-01`)).json
    expect(ev.states[0].flags).toContain('disputed')
    const c = await call(`/api/v1/accounts/${id}/oral/${media}/transcript`, {
      text: '团队预期更安静的路线，但有人走向拥挤的房间；地图正常，假设不完整。',
    }, 'POST')
    expect(c.json.versions.length).toBe(2)
    expect(c.json.versions[0].origin).toBe('asr')
    expect(c.json.versions[1].origin).toBe('user_corrected')
    const rev = await call(`/api/v1/accounts/${id}/oral-reviews`, {
      attemptId: 'oral-noisy-1', mediaId: media,
      dimensions: { '信息与关系': 2, '可理解度': 2, '语言资源': 1, '组织与互动': 2 },
      objectiveResults: { 'O-K190-01': 'met', 'O-K190-02': 'partial' }, // 21 §5：实际测到的项才可计
      evidenceRefs: ['00:12-00:18 假设不完整一句清楚'],
      evaluator: '真人复核（抽样）', note: '按 18 §7 量表，噪声不影响关系判定',
    }, 'POST')
    expect(rev.json.signed).toBe(true)
    expect(rev.json.certifiedObjectives).toEqual(['O-K190-01'])
    const ev2 = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K190-01`)).json
    expect(ev2.states[0].state).toBe('trained')
    expect(ev2.states[0].flags.join(',')).not.toContain('disputed')
    expect((await call(`/api/v1/accounts/${id}/oral-reviews`, { evaluator: 'x', dimensions: {} }, 'POST')).status).toBe(400)
    // 对争议中的 attempt 再发 content-report：不撞事件主键（500 回归）
    const rep = await call(`/api/v1/accounts/${id}/content-reports`, { attemptId: 'oral-noisy-1', description: '补报' }, 'POST')
    expect(rep.status).toBe(200)
    // 删除录音：DB 行与文件一并移除，回放 404
    const del = await call(`/api/v1/accounts/${id}/oral/${media}`, {}, 'DELETE')
    expect(del.json.deleted).toBe(true)
    expect((await call(`/api/v1/accounts/${id}/oral/${media}/audio`)).status).toBe(404)
  })

  it('真实素材门：license 未确认/不可播 → 不可用于认证（A7）', async () => {
    const { mediaUsableForCertification } = await import('./v3oral.mjs')
    const id = await mkAccount('W5-素材门')
    const media = await uploadOral(id, 'ok')
    expect(mediaUsableForCertification(media).usable).toBe(true)
    const { getDb } = await import('./db.mjs')
    const conn = (await import('./v3db.mjs')).ensureV3Schema(getDb())
    conn.prepare(
      `INSERT INTO media_assets (media_id, account_id, kind, source_type, license_status, playable, created_at)
       VALUES ('m_yt_candidate', ?, 'real_material', 'youtube', 'unverified', 0, ?)`).run(id, Date.now())
    const verdict = mediaUsableForCertification('m_yt_candidate')
    expect(verdict.usable).toBe(false)
    expect(verdict.reason).toBe('LICENSE_UNCONFIRMED')
  })
})

// ==================================================================
// W6 / T9 工具包：先预注册后施测；机制只并排原始作品，不做效果宣称
// ==================================================================
describe('W6/T9 试学工具包', () => {
  it('预注册→观察→对比：陌生性计数、家族一致性、原始作品与条件保留', async () => {
    const id = await mkAccount('W6-T9')
    // 早期作答（早于预注册 → 之后不能计入观察）。用不同活动，保持基线材料的陌生性
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 't9-pre', activityId: 'ct01_which_probe',
      response: { kind: 'choice', text: 'A 的 which 指投影仪这台设备；B 的 which 指投影仪坏掉这件事，后半解释后果。', answers: { which_a: 'DEVICE', which_b: 'EVENT', tail_role: 'B' } },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    // F7：先预注册（作答必须晚于预注册，事后补录不计入）
    const reg0 = (await call(`/api/v1/accounts/${id}/trials`, {
      label: '课堂主张抓取·首周', skill: 'reading',
      baselineTask: { taskFamilyId: 'sensor_stage_lights_read_B', materialRef: 'baseline-m1', dimensions: ['对象归属', '限制保留'] },
      postTask: { taskFamilyId: 'film_lobby_read_C', materialRef: 'post-n1', dimensions: ['对象归属', '限制保留'] },
    }, 'POST')).json
    expect(reg0.trialId).toBeTruthy()
    // 事后补录被拒：预注册"之前"的作答观察 → 400
    expect((await call(`/api/v1/accounts/${id}/trials/${reg0.trialId}/observations`, { phase: 'baseline', attemptId: 't9-pre' }, 'POST')).status).toBe(400)
    // 正式作答（晚于预注册）
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 't9-base', activityId: 'les_l1_sensor_read',
      response: { kind: 'text', text: '出问题的是实验室里准的那颗传感器；现在可用于室内测试；安装被推迟到灯光检查。' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 't9-post', activityId: 'rep_film_postpone_read',
      response: { kind: 'text', text: '保留视觉序列，推迟配音测试；原因是环境吵，不能推出影片本身差。' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    // 再注册一份（同家族 → 400；缺维度 → 400）
    expect((await call(`/api/v1/accounts/${id}/trials`, { label: 'x', skill: 'reading', baselineTask: { taskFamilyId: 'a', materialRef: 'm1', dimensions: ['d'] }, postTask: { taskFamilyId: 'a', materialRef: 'm2', dimensions: ['主张与限制'] } }, 'POST')).status).toBe(400)
    expect((await call(`/api/v1/accounts/${id}/trials`, { label: 'x', skill: 'reading', baselineTask: { taskFamilyId: 'a', materialRef: 'm1' }, postTask: { taskFamilyId: 'b', materialRef: 'm2', dimensions: ['主张与限制'] } }, 'POST')).status).toBe(400)
    const reg = reg0
    // 观察：家族不匹配 → 400；practice_only（未绑版本化材料）→ 记录但恒不计入（R7）
    expect((await call(`/api/v1/accounts/${id}/trials/${reg.trialId}/observations`, { phase: 'baseline', attemptId: 't9-post' }, 'POST')).status).toBe(400)
    const baseObs = (await call(`/api/v1/accounts/${id}/trials/${reg.trialId}/observations`, { phase: 'baseline', attemptId: 't9-base', support: { hintLevel: 0, transcriptShown: false } }, 'POST')).json
    expect(baseObs.counted).toBe(false)
    expect(baseObs.exposureNote).toContain('practice_only')
    expect((await call(`/api/v1/accounts/${id}/trials/${reg.trialId}/observations`, { phase: 'post', attemptId: 't9-post', materialWasNovel: true }, 'POST')).json.counted).toBe(false)
    // 对比：原始作品 + 支持条件 + 预注册量表，verdict 留白给人工
    const cmp = (await call(`/api/v1/accounts/${id}/trials/${reg.trialId}/compare`)).json
    expect(cmp.baseline.response.text).toContain('实验室')
    expect(cmp.post.conditions.firstExposure).toBe(true)
    expect(cmp.registration.post.dimensions).toEqual(['对象归属', '限制保留'])
    expect(cmp.verdict).toBeNull()
    expect(cmp.sameCondition).toBe(false) // R7：双方均为 practice_only，不构成正式比较
    expect(cmp.note).toContain('熟题提速不算达标')
    // 未注册的观察 → 404
    expect((await call(`/api/v1/accounts/${id}/trials/nope/observations`, { phase: 'baseline', attemptId: 't9-base' }, 'POST')).status).toBe(404)
  })

  it('C3 残留：材料版本绑定、服务端曝光核对覆盖自报、条件不同不标同条件', async () => {
    const id = await mkAccount('W6-C3')
    // 材料版本绑定：先注册（materialVersion=99）后施测——完整预注册顺序
    const regV = (await call(`/api/v1/accounts/${id}/trials`, {
      label: '版本绑定', skill: 'reading',
      baselineTask: { taskFamilyId: 'projector_reference_probe', materialRef: 'm1', materialVersion: 99, activityId: 'ct01_which_probe', dimensions: ['所指'] },
      postTask: { taskFamilyId: 'exhibit_hardware_reference', materialRef: 'm2', dimensions: ['所指'] },
    }, 'POST')).json
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'c3-b1', activityId: 'ct01_which_probe',
      response: { kind: 'choice', text: 'A 的 which 指投影仪这台设备；B 的 which 指投影仪坏掉这件事，后半解释后果。', answers: { which_a: 'DEVICE', which_b: 'EVENT', tail_role: 'B' } },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    expect((await call(`/api/v1/accounts/${id}/trials/${regV.trialId}/observations`, { phase: 'baseline', attemptId: 'c3-b1' }, 'POST')).json.error).toContain('TRIAL_MATERIAL_VERSION_MISMATCH')
    // 版本正确（用零曝光的 ct02）→ 通过并计数
    const regOk = (await call(`/api/v1/accounts/${id}/trials`, {
      label: '版本正确', skill: 'reading',
      baselineTask: { taskFamilyId: 'exhibit_hardware_reference', materialRef: 'm1', materialVersion: 2, activityId: 'ct02_nested_which', dimensions: ['所指'] },
      postTask: { taskFamilyId: 'voice_decision_semantics', materialRef: 'm2', materialVersion: 2, activityId: 'ct03_semantics_guard', dimensions: ['语义'] },
    }, 'POST')).json
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'c3-t2', activityId: 'ct02_nested_which',
      response: { kind: 'choice', text: '第一处 which 指媒体实验室最近买了设备；第二处指更换电源并继续展出这件事。', answers: { which_1: 'LAB', which_2: 'POWER', software_why: 'RUNNING_OK' } },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    const regOkObs = (await call(`/api/v1/accounts/${id}/trials/${regOk.trialId}/observations`, { phase: 'baseline', attemptId: 'c3-t2' }, 'POST')).json
    expect(regOkObs.counted).toBe(false) // R7：ct02 在公开注册表中，不能当本人留出（留出须 holdout 材料）
    expect(regOkObs.exposureNote).toContain('公开注册表')
    // 服务端曝光核对覆盖自报：同一活动第二次作答仍自报"陌生" → 服务端改判不计入。
    // R7：注册带版本化绑定 → measurement 档 → 曝光核对才生效
    const regEx = (await call(`/api/v1/accounts/${id}/trials`, {
      label: '曝光核对', skill: 'reading',
      baselineTask: { taskFamilyId: 'exhibit_hardware_reference', materialRef: 'm1', materialVersion: 2, activityId: 'ct02_nested_which', dimensions: ['所指'] },
      postTask: { taskFamilyId: 'voice_decision_semantics', materialRef: 'm2', materialVersion: 2, activityId: 'ct03_semantics_guard', dimensions: ['语义'] },
    }, 'POST')).json
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'c3-b2', activityId: 'ct02_nested_which',
      response: { kind: 'choice', text: '第一处 which 指实验室；第二处指换电源继续展出这件事。', answers: { which_1: 'LAB', which_2: 'POWER', software_why: 'RUNNING_OK' } },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    const exObs = (await call(`/api/v1/accounts/${id}/trials/${regEx.trialId}/observations`, { phase: 'baseline', attemptId: 'c3-b2', materialWasNovel: true }, 'POST')).json
    expect(exObs.counted).toBe(false) // 服务端判定：该材料此前已作答过
    expect(exObs.exposureNote).toContain('已曝光')
    // 条件不同 → 不标同条件：baseline hintLevel 0，post hintLevel 2
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'c3-p1', activityId: 'ct03_semantics_guard',
      response: { kind: 'choice', text: '团队保留了手势，暂缓语音；因为展厅里多人同时说话时原型表现不好，他们并未完全放弃语音。', answers: { decision: 'A' } },
      conditions: { firstExposure: true, hintLevel: 2, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    await call(`/api/v1/accounts/${id}/trials/${regEx.trialId}/observations`, { phase: 'post', attemptId: 'c3-p1', materialWasNovel: true }, 'POST')
    const cmp = (await call(`/api/v1/accounts/${id}/trials/${regEx.trialId}/compare`)).json
    expect(cmp.sameCondition).toBe(false)
    expect(cmp.comparabilityNote).toContain('不构成同条件比较')
  })
})

// ==================================================================
// 复审 20 号报告 F1–F8 失败路径回归（每条对应报告 §3 的复现）
// ==================================================================
describe('C2 课程音频（21 §6.1/§6.2）', () => {
  it('清单与 WAV 一致且可分发：sha256 四关、synthetic 标注全程、逐段意义依据齐、转写不随音频下发', async () => {
    await call('/api/v1/map')
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const audio = await import('./v3audio.mjs')
    const mf = audio.loadAudioManifest()
    expect(mf.assets.length).toBeGreaterThanOrEqual(2)
    const assetDir = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'audio')
    for (const entry of mf.assets) {
      expect(['lesson_audio', 'real_material']).toContain(entry.kind)
      expect(entry.sourceType).toBe(entry.kind === 'real_material' ? 'real' : 'synthetic')
      expect(entry.licenseStatus).toBe('confirmed')
      expect(entry.durationMs).toBeGreaterThan(10_000) // 真实时长（WAV 头解析），不是 HTTP 200
      if (entry.kind === 'lesson_audio') {
        expect(entry.segments.length).toBeGreaterThanOrEqual(4)
        for (const seg of entry.segments) expect(seg.meaningBasis.length).toBeGreaterThan(5) // 21 §6.1 逐段意义依据
      }
      // 完整性四关：真文件过；坏哈希/坏许可/空字节各归各的失败
      const buf = readFileSync(join(assetDir, entry.file ?? entry.mediaId + '.wav'))
      expect(audio.verifyAudioEntry(entry, buf)).toBe('ok')
      expect(audio.verifyAudioEntry({ ...entry, sha256: 'deadbeef' }, buf)).toBe('hash_mismatch')
      expect(audio.verifyAudioEntry({ ...entry, licenseStatus: 'unverified' }, buf)).toBe('unlicensed')
      expect(audio.verifyAudioEntry(entry, Buffer.alloc(0))).toBe('empty')
    }
    // 清单绑定的每个活动都真实存在且声明了对应 audioRef
    const acts = (await import('./data/v3-activities.json')).default.activities
    const byId = new Map(acts.map((a) => [a.activityId, a]))
    for (const entry of mf.assets) {
      for (const aid of entry.activityIds) expect(byId.get(aid)?.audioRef).toBe(entry.mediaId)
    }
    expect(byId.get('diag_d2_listen_sim').audioRef).toBeTruthy()
    expect(byId.get('sim_audio_noaudio_fixture').audioRef).toBeUndefined() // F1 夹具：无音频文字模拟仍在
    // 分发路由：synthetic 标注到响应；转写不随音频下发（首听隐藏）；未知 id 404
    const r = await call('/api/v1/media/aud_d2_library_v1')
    expect(r.status).toBe(200)
    expect(r.json.synthetic).toBe(true)
    expect(r.json.speakerLabel).toContain('synthetic')
    expect(r.json.transcript).toBeUndefined()
    expect(Buffer.from(r.json.audioBase64, 'base64').length).toBeGreaterThan(100_000)
    expect((await call('/api/v1/media/aud_nope')).status).toBe(404)
    // 真实账户取 L2 课包：活动带 audio 描述（synthetic 声源标注透传到前端）
    const acc = await mkAccount('C2-音频')
    const pkg = (await call(`/api/v1/accounts/${acc}/lessons/les-listening-v1`)).json
    const l2 = pkg.activities.find((a) => a.activityId === 'les_l2_museum_map_audio')
    expect(l2.audio.synthetic).toBe(true)
    expect(l2.audio.mediaId).toBe('aud_l2_museum_v1')
    expect(l2.fixtureNotice).toBeNull() // 有音频的活动不再是"文字模拟"fixture
  })

  it('真实外部材料（21 §6.3）：来源/许可/哈希三核可分发；合成/真实在响应中可辨', async () => {
    await call('/api/v1/map')
    const audio = await import('./v3audio.mjs')
    const real = audio.audioByMediaId('real_cylinder_weakness_richards')
    expect(real.kind).toBe('real_material')
    expect(real.license).toContain('Public Domain')
    expect(real.sourceUrl).toContain('archive.org')
    expect(real.candidateStatus).toContain('pending_listen_check') // 听校未做，不得进课程
    expect(real.activityIds).toEqual([])
    const r = await call('/api/v1/media/real_cylinder_weakness_richards')
    expect(r.status).toBe(200)
    expect(r.json.synthetic).toBe(false) // 与合成件可辨
    expect(r.json.author).toBe('Robert Hallowell Richards')
    expect(r.json.license).toContain('Public Domain')
    expect(Buffer.from(r.json.audioBase64, 'base64').length).toBe(real.bytes)
  })
})

describe('分档状态（21 §6.1：复杂度不同的表现不能互相覆盖）', () => {
  it('不同复杂度带各存一行；base 综合行按最弱档合并；易档通过盖不住嵌套档失败', async () => {
    const id = await mkAccount('分档-1')
    const { getDb } = await import('./db.mjs')
    const conn = (await import('./v3db.mjs')).ensureV3Schema(getDb())
    const { recomputeStates } = await import('./v3evidence.mjs')
    // 两个带的真实事件：band1 独立通过、band3 失败一次（嵌套档不足）
    const mk = (i, band, pass) => conn.prepare(
      `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
         kind, condition, pass, basis, created_at) VALUES (?,?,?,?,?,?, 'observed', 'first_independent', ?, ?, ?)`)
      .run(id, `ev-bd-${i}`, `att-bd-${i}`, 'O-K115-01', 'reading', band, pass ? 1 : 0,
        JSON.stringify({ taskFamilyId: `fam-${i}`, evaluator: 'deterministic-contract-v1' }), 1000 + i)
    mk(1, 'band1', true)
    mk(2, 'band1', true) // band1 两次独立 → 该带 independent
    mk(3, 'band3', true)
    mk(4, 'band3', false) // band3 一次失败 → 该带带失败痕迹
    recomputeStates(id)
    const rows = conn.prepare('SELECT * FROM learner_states WHERE account_id=? AND objective_id=? ORDER BY complexity').all(id, 'O-K115-01')
    const b1 = rows.find((r) => r.complexity === 'band1')
    const b3 = rows.find((r) => r.complexity === 'band3')
    const base = rows.find((r) => r.complexity === 'base')
    expect(b1.state).toBe('independent') // 易档：两次独立通过 → independent
    expect(b3.state).toBe('trained') // 嵌套档：只有一次通过 → trained（两带互不覆盖）
    expect(base.state).toBe('trained') // 综合=最弱档：band1 的 independent 不掩盖 band3 的 trained
    expect(JSON.parse(b1.flags)).toEqual([]) // band3 的失败痕迹不串到 band1
  })
})

describe('复审二轮（子代理审出）回归', () => {
  it('P1：内容耗尽账户的 /window 不崩溃——生成关闭时槽位如实标 generation_disabled', async () => {
    const id = await mkAccount('复审-window')
    await call('/api/v1/map') // 自给自足：不依赖其它测试先播种账本
    await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }, 'rq-w1')
    // 这条路径曾抛 "job is not defined"（catch 落空后无条件 push）
    const r = await call(`/api/v1/accounts/${id}/window`)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.json.slots)).toBe(true)
    expect(r.json.slots.length).toBeGreaterThan(0)
    const statuses = r.json.slots.map((s) => s.status)
    expect(statuses.some((s) => ['generation_disabled', 'ready', 'candidate_position_only', 'generating', 'generation_cooldown'].includes(s))).toBe(true)
  })

  it('P2①②：否定扫描的分句截断与 not only 例外——跨句"没有"与递进句不再误伤；P2③双否定转争议', async () => {
    const id = await mkAccount('复审-否定')
    // ct03 已转封闭选择（R3）；否定扫描的回归用专用夹具（全 negationAware 的开放题，判题器同一条路）
    const post = (attemptId, text) => call(`/api/v1/accounts/${id}/attempts`, {
      attemptId, activityId: 'neg_scan_fixture',
      response: { kind: 'text', text },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    // ① 跨分句的"没有"属于上一分句，不得否定"保留了手势"
    const clause = await post('rv-clause', '因为展厅里没有足够空间，团队保留了手势，暂缓语音，多人同时说话时表现不好；他们并未放弃语音，仍想再测试。')
    expect(clause.json.pass).toBe(true)
    expect(clause.json.objectiveResults['O-K115-03']).toBe('met')
    // ② "not only ... but also" 是递进：kept gestures 不被 not 否定
    const notOnly = await post('rv-notonly', 'so they not only kept gestures but also postponed voice control, because it failed when several groups spoke at once; they still want to explore it.')
    expect(notOnly.json.pass).toBe(true)
    // ③ 双否定（"并不是不保留"类）机器定不了极性 → 争议，不硬判
    const dbl = await post('rv-dblneg', '团队并不是不保留手势，语音也不是被放弃——只是展厅里多人说话时表现不好，他们想再测试。')
    expect(dbl.json.evaluationStatus).toBe('disputed')
  })

  it('P2：delay 阶段未预注册 → 400，不能事后指派任意作答', async () => {
    const id = await mkAccount('复审-delay')
    const reg = (await call(`/api/v1/accounts/${id}/trials`, {
      label: '只有基线后测', skill: 'reading',
      baselineTask: { taskFamilyId: 'projector_reference_probe', materialRef: 'm1', dimensions: ['所指'] },
      postTask: { taskFamilyId: 'exhibit_hardware_reference', materialRef: 'm2', dimensions: ['所指'] },
    }, 'POST')).json
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'rv-delay-att', activityId: 'ct03_semantics_guard',
      response: { kind: 'choice', text: '团队保留了手势，暂缓语音；多人说话表现不好；并未放弃语音。', answers: { decision: 'A' } },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    const r = await call(`/api/v1/accounts/${id}/trials/${reg.trialId}/observations`, { phase: 'delay', attemptId: 'rv-delay-att' }, 'POST')
    expect(r.json.error).toContain('TRIAL_DELAY_NOT_PREREGISTERED')
  })

  it('P3：生成活动按账户隔离——他人不能对 A 的私有生成活动作答', async () => {
    const { getDb } = await import('./db.mjs')
    const conn = (await import('./v3db.mjs')).ensureV3Schema(getDb())
    const { registerGeneratedActivities } = await import('./v3gen.mjs')
    const owner = await mkAccount('复审-gen-主')
    const other = await mkAccount('复审-gen-他人')
    const [actId] = registerGeneratedActivities('job_rv_scope', [{
      taskFamilyId: 'rv_scope_fam', prompt: 'Private probe: the schedule changed twice. 问：改了几次？', hints: [],
      objectiveIds: ['O-K184-02'], skillByObjective: { 'O-K184-02': 'reading' },
      conditionsSpec: ['firstExposure', 'hintLevel', 'transcriptShown', 'playCount', 'lookupUsed', 'responseMode'],
      relations: [{ id: 'twice', label: '改了两次', anyOf: ['twice', '两次'], required: true }, { id: 'sched', label: '日程', anyOf: ['schedule', '日程'], required: true }],
    }])
    conn.prepare("INSERT INTO generation_jobs (account_id, job_id, objective_id, input_spec, contract_version, status, created_at) VALUES (?, 'job_rv_scope', 'O-K184-02', '{}', 'GEN_CONTRACT_V1', 'succeeded', ?)").run(owner, Date.now())
    const ok = await call(`/api/v1/accounts/${owner}/attempts`, {
      attemptId: 'rv-gen-owner', activityId: actId,
      response: { kind: 'text', text: '改了两次日程 schedule' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    expect(ok.status).toBe(200)
    const leak = await call(`/api/v1/accounts/${other}/attempts`, {
      attemptId: 'rv-gen-other', activityId: actId,
      response: { kind: 'text', text: '改了两次日程 schedule' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    expect(leak.status).toBe(404)
  })
})

describe('复审回归 F1–F8', () => {
  it('31 收口·定义快照冻结：重放按作答时落库的定义快照判模态，不读当前定义；无快照旧行回退', async () => {
    const { getDb } = await import('./db.mjs')
    const conn = (await import('./v3db.mjs')).ensureV3Schema(getDb())
    const ev = await import('./v3evidence.mjs')
    const id = await mkAccount('快照冻结')
    const now = Date.now()
    // 同一活动 id 的两次作答，携带**不同**冻结快照（模拟作答发生在不同内容版本）；
    // 当前注册表无论该活动定义如何，重放都按各自快照归属
    const mkAttempt = (attemptId, snapshot, skill) => {
      conn.prepare(`INSERT INTO learner_attempts_v3 (account_id, attempt_id, session_id, activity_id, activity_version,
        objective_ids, task_family_id, role, response_kind, response, conditions, evaluation_status,
        evaluation, disputed_reason, body_hash, created_at, activity_snapshot)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, attemptId, '', 'some_activity_vX', 1, JSON.stringify(['O-K184-02']), 'frozen_fam', 'practice', 'text',
          '{"kind":"text","text":"x"}', '{}', 'evaluated', '{}', null, 'h' + attemptId, now, JSON.stringify(snapshot))
      conn.prepare(`INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
        kind, condition, pass, basis, created_at) VALUES (?,?,?,?,?,?,'observed','first_independent',1,?,?)`)
        .run(id, `ev_${attemptId}`, attemptId, 'O-K184-02', skill, 'base', '{}', now + 1)
    }
    mkAttempt('snap-text', { simulatesAudio: true, audioRef: null, complexityBand: null, skillByObjective: { 'O-K184-02': 'listening' } }, 'listening') // 文字模拟 → reading
    mkAttempt('snap-audio', { simulatesAudio: true, audioRef: 'aud_some_real', complexityBand: null, skillByObjective: { 'O-K184-02': 'listening' } }, 'listening') // 带音频 → listening
    ev.recomputeStates(id)
    const states = conn.prepare("SELECT skill, state FROM learner_states WHERE account_id = ? AND objective_id = 'O-K184-02'").all(id)
    expect(states.some((s) => s.skill === 'reading')).toBe(true)   // 快照无 audioRef → reading 槽
    expect(states.some((s) => s.skill === 'listening')).toBe(true) // 快照有 audioRef → listening 槽
  })
  it('F1/R3/R4：无音频文字模拟与开放题都不产生能力事件；有播放记录的合成音频听力=受限定证据；无录音不产生口语证据', async () => {
    const id = await mkAccount('F1-模态')
    // 夹具：simulatesAudio 但**无 audioRef**，且是开放文本 → keyword 练习：不写任何事件
    // （"改判 reading"的历史语义被 R3 收紧为"不写证据"——原 semantics 由 closed 活动承接）
    const noaudio = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'f1-noaudio', activityId: 'sim_audio_noaudio_fixture',
      response: { kind: 'text', text: 'it crashed at school，学校里直接崩了' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: true, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    expect(noaudio.status).toBe(200)
    expect(noaudio.json.pass).toBe(true)
    expect(noaudio.json.practiceOnly).toBe(true)
    let ev = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K184-02`)).json
    expect(ev.states.length).toBe(0) // 无音频文字模拟：听力 reading 都不写
    // R4：有音频的听力题**没播放过就提交 → 400**（不产生任何听力进度）
    const noPlay = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'f1-noplay', activityId: 'les_l2_museum_map_audio',
      response: { kind: 'text', text: '地图按设计正常工作，不完整的是对访客需求的假设。' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 0, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    expect(noPlay.status).toBe(400)
    expect(noPlay.json.error).toContain('ISSUED_TASK_REQUIRED')
    // 诊断 D2 带合成音频：先播放（服务端事件）→ 听力证据成立（封顶 trained），事件标注真实音源
    await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }, 'rq-f1')
    ev = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K184-01`)).json
    expect(ev.states.some((st) => st.skill === 'listening' && ['trained', 'tentative'].includes(st.state))).toBe(false)
    const syntheticEv = ev.recentEvents.find((e) => e.basis?.audio === 'synthetic' && e.basis?.playbackVerified)
    expect(syntheticEv).toBeUndefined() // keyword-only audio is practice, not comprehension evidence
    // F5 交叉：文字作答声明 oral_recording 但没带录音 → 拒绝
    expect((await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'f1-oral-nomedia', activityId: 'les_l3_oral_recap',
      response: { kind: 'text', text: 'x' },
      conditions: { firstExposure: true, hintLevel: 0, lookupUsed: false, responseMode: 'oral_recording' },
    }, 'POST')).json.error).toContain('ORAL_RECORDING_REQUIRED')
  })

  it('F4/R3/D0-1：CT03 槽位判题——决策由槽位锁定；缺槽/错选/争议理由/文本后门都不放行；R1 逐目标映射 A/B 分离', async () => {
    const id = await mkAccount('F4-反例')
    const post = (attemptId, text, answers = { decision: 'A' }) => call(`/api/v1/accounts/${id}/attempts`, {
      attemptId, activityId: 'ct03_semantics_guard',
      response: { kind: 'choice', text, answers },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    // 正确槽位 + 理由 → pass；但理由是开放文本，词表判不了语义冲突 → **不参与 met 认证**（29 号 A1）
    const good = await post('f4-good', '因为多人说话时这个原型在展厅里表现不好，他们想再测试；他们并未完全放弃语音。')
    expect(good.json.pass).toBe(true)
    expect(good.json.objectiveResults['O-K115-03']).toBe('partial') // 选择定位成功、理由本次未测
    expect(good.json.slotResults[0].status).toBe('correct')
    // A1 成对回归：空理由 / 反向同义改述 / 正常改述 —— 一律 partial（不 met、也不算失败连败）
    const emptyReason = await post('f4-empty', '')
    expect(emptyReason.json.pass).toBe(true)
    expect(emptyReason.json.objectiveResults['O-K115-03']).toBe('partial')
    const synReason = await post('f4-synreason', '他们搁置手势，采用语音，因为多人同时说话，仍想探索。')
    expect(synReason.json.objectiveResults['O-K115-03']).toBe('partial') // 理由与选项冲突也拦不住，所以不认证
    expect(synReason.json.evaluationStatus).toBe('evaluated')
    // 缺槽（只有理由没有选择）→ unmet：选择对错由槽位决定，理由写得再好也代替不了
    const bag = await post('f4-bag', 'gesture delay crowded still want', {})
    expect(bag.json.pass).toBe(false)
    expect(bag.json.slotResults[0].status).toBe('missing')
    expect(bag.json.objectiveResults['O-K115-03']).toBe('unmet')
    // 角色反转选 B → unmet（选项空间里这就是另一个答案，不需要词表反推）
    const swapped = await post('f4-swap', '因为展厅里多人同时说话。', { decision: 'B' })
    expect(swapped.json.pass).toBe(false)
    expect(swapped.json.objectiveResults['O-K115-03']).toBe('unmet')
    // 同义反转（"搁置手势，采用语音"）选 B → 一样 unmet（代号与语义都在同一答案空间里判定）
    const synSwapped = await post('f4-syn', '他们搁置手势，采用语音，因为多人同时说话，仍想探索。', { decision: 'B' })
    expect(synSwapped.json.pass).toBe(false)
    // 过度推广出现在理由里 → mustNot 仍拦（选项对也不能带"所有语音都失败"）
    const over = await post('f4-over', '因为所有语音系统在拥挤处都失败。')
    expect(over.json.pass).toBe(false)
    // 理由双否定 → 争议：即使槽位对，也不给 met（26 号 N1：理由争议不认证）
    const amb = await post('f4-amb', '只是展厅里多人同时说话时表现不好；他们并不是不仍想再测试。')
    expect(amb.json.evaluationStatus).toBe('disputed')
    // D0-1：封闭槽位题不再收自由文本提交——"a b c d" 全选的老后门以 400 关闭
    const textOnly = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'f4-textonly', activityId: 'ct03_semantics_guard',
      response: { kind: 'text', text: 'a b c d DEVICE EVENT B' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    expect(textOnly.status).toBe(400)
    expect(textOnly.json.error).toContain('CLOSED_STRUCTURED_REQUIRED')
    // CT01 三槽同理：自由文本口号（无结构化答案）→ 400，不再有"词袋蒙混"路径
    const slogan = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'f4-slogan', activityId: 'ct01_which_probe',
      response: { kind: 'text', text: 'which 都是指前面的东西。' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    expect(slogan.status).toBe(400)
    // R1（24 号）：逐目标映射——alpha 只归 A、beta 只归 B 时，只答 alpha = A met、B unmet（不再混算）
    const ab = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'f4-ab', activityId: 'ab_map_fixture',
      response: { kind: 'text', text: '出问题的是实验室里准、舞台灯下不准的那颗传感器。' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    expect(ab.status).toBe(200)
    expect(ab.json.objectiveResults['O-K115-01']).toBe('met')
    expect(ab.json.objectiveResults['O-K115-03']).toBe('unmet')
  })

  it('N1/D0-1 槽位反例（纯函数）：全选/错序/漏槽/未知选项/多给都不通过；单槽正确只影响其归属目标；N2 串题与泄题修复', async () => {
    const { evaluateAttempt } = await import('./v3evidence.mjs')
    // 双目标双槽：alpha 槽只归 O-A，beta 槽只归 O-B（逐目标隔离的最小再现）
    const act = {
      activityId: 'unit_slots', version: 1, objectiveIds: ['O-A', 'O-B'],
      evaluationContract: {
        dimensions: ['d'],
        slots: [
          { slotId: 'alpha', prompt: '第一空', options: ['X', 'Y'], accept: 'X', objectiveIds: ['O-A'] },
          { slotId: 'beta', prompt: '第二空', options: ['P', 'Q'], accept: 'Q', objectiveIds: ['O-B'] },
        ],
      },
    }
    const sub = (answers) => evaluateAttempt(act, { kind: 'choice', text: '', answers })
    // 全对 → pass，逐目标 met
    expect(sub({ alpha: 'X', beta: 'Q' }).evaluation.pass).toBe(true)
    // 全选（把每个槽塞成数组）→ 槽 multiple，不通过
    const all = sub({ alpha: ['X', 'Y'], beta: ['P', 'Q'] })
    expect(all.evaluation.pass).toBe(false)
    expect(all.evaluation.slotResults.map((s) => s.status)).toEqual(['multiple', 'multiple'])
    // 错序（两空交换）→ 都错
    expect(sub({ alpha: 'Q', beta: 'X' }).evaluation.slotResults.map((s) => s.status)).toEqual(['invalid', 'invalid'])
    // 漏槽 → missing，不通过
    expect(sub({ alpha: 'X' }).evaluation.pass).toBe(false)
    expect(sub({ alpha: 'X' }).evaluation.slotResults[1].status).toBe('missing')
    // 未知选项 → invalid
    expect(sub({ alpha: 'Z', beta: 'Q' }).evaluation.slotResults[0].status).toBe('invalid')
    // 单槽正确只影响对应目标：alpha 对 beta 错 = O-A met、O-B unmet（不再混算）
    const half = sub({ alpha: 'X', beta: 'P' })
    expect(half.evaluation.objectiveResults['O-A']).toBe('met')
    expect(half.evaluation.objectiveResults['O-B']).toBe('unmet')
    expect(half.evaluation.evaluatorVersion).toBe('deterministic-contract-v2')
    expect(half.evaluation.reasonAssessed).toBe(true) // 无 reason 合同的纯封闭题：选择即认证

    // N2（26 号）：ct02 题面不再串入 L2 的"地图/假设"，格式示例不再给出答案序列
    const registry = JSON.parse((await (await import('node:fs/promises')).readFile(new URL('./data/v3-activities.json', import.meta.url), 'utf8')))
    const ct02 = (Array.isArray(registry) ? registry : registry.activities).find((a) => a.activityId === 'ct02_nested_which')
    expect(ct02.prompt).not.toContain('ASSUMPTION')
    expect(ct02.prompt).not.toContain('例：LAB')
    expect(ct02.evaluationContract.slots.some((s) => s.slotId === 'software_why' && s.accept === 'RUNNING_OK')).toBe(true)
    expect(ct02.prompt).toContain('running normally') // 第三问的答案在材料里有据可查
  })

  it('F6：诊断乱序拒绝；幂等重放不二次推进', async () => {
    const id = await mkAccount('F6-诊断')
    const diag = (await call(`/api/v1/accounts/${id}/diagnostics`, { requestId: 'rq-f6' }, 'POST')).json
    expect((await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'f6-skip', sessionId: diag.diagnosticId, activityId: 'diag_d2_listen_sim',
      response: { kind: 'text', text: 'x' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')).json.error).toContain('DIAGNOSTIC_STEP_MISMATCH')
    const d1 = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'f6-d1', sessionId: diag.diagnosticId, activityId: 'diag_d1_read',
      response: { kind: 'text', text: ANSWERS.rich_d1 },
      conditions: { firstExposure: true, hintLevel: 0, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    expect(d1.json.diagnostic.step).toBe('D2')
    const replay = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'f6-d1', sessionId: diag.diagnosticId, activityId: 'diag_d1_read',
      response: { kind: 'text', text: ANSWERS.rich_d1 },
      conditions: { firstExposure: true, hintLevel: 0, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    expect(replay.json.replayed).toBe(true)
    expect(replay.json.diagnostic.step).toBe('D2') // 没有第二次推进
    const forged = await call(`/api/v1/accounts/${id}/attempts`, {attemptId:'f6-d1',sessionId:diag.diagnosticId,activityId:'diag_d1_read',response:{kind:'text',text:'different'},conditions:{firstExposure:true,hintLevel:0,lookupUsed:false,responseMode:'typed_summary'}},'POST')
    expect(forged.status).toBe(409)
    expect(forged.json.error).toContain('ATTEMPT_REPLAY_MISMATCH')
  })

  it('诊断 disputed 不静默卡死：note 带可执行指引、disputedReason 暴露；换自然说法后可判定（2026-09-30 实测事故）', async () => {
    const id = await mkAccount('诊断-争议')
    const diag = (await call(`/api/v1/accounts/${id}/diagnostics`, { requestId: 'rq-disp' }, 'POST')).json
    const cond = { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' }
    // D1 fail → D1b pass → D2
    await call(`/api/v1/accounts/${id}/attempts`, { attemptId: 'disp-d1', sessionId: diag.diagnosticId, activityId: 'diag_d1_read', response: { kind: 'text', text: ANSWERS.fail_d1 }, conditions: cond }, 'POST')
    const d1b = (await call(`/api/v1/accounts/${id}/attempts`, { attemptId: 'disp-d1b', sessionId: diag.diagnosticId, activityId: 'diag_d1b_contrast', response: { kind: 'text', text: ANSWERS.pass_d1b }, conditions: cond }, 'POST')).json
    expect(d1b.diagnostic.step).toBe('D2')
    // R4：听力作答前先落服务端播放事件
    await playTask(id, d1b.diagnostic.activity)
    // 学习者原话（当天实测卡死）："并不是说不能用 AI 找文章"——双重否定让 use_case 的唯一锚点极性定不了
    const stuck = (await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'disp-d2a', taskId: d1b.diagnostic.activity.taskId, sessionId: diag.diagnosticId, activityId: 'diag_d2_listen_sim',
      response: { kind: 'text', text: '最终的评价是：使用 AI 做搜索时，最后还是需要自己人工去 check source。并不是说不能用 AI 找文章，而是需要做很强的人工检测和审核。' },
      conditions: cond,
    }, 'POST')).json
    expect(stuck.evaluationStatus).toBe('disputed')
    expect(stuck.disputedReason).toBe('NEGATION_AMBIGUOUS')
    expect(stuck.diagnostic.step).toBe('D2') // 不推进、不降级
    expect(stuck.diagnostic.note).toContain('重新提交') // 指引必须到达前端（之前被丢弃）
    // 同义改写（"出来非常多的内容"）→ 干净判定，流程正常走到 D2b 对照复核
    const redo = (await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'disp-d2b', taskId: d1b.diagnostic.activity.taskId, sessionId: diag.diagnosticId, activityId: 'diag_d2_listen_sim',
      response: { kind: 'text', text: '一开始输入 topic 会出来非常多的内容，但后来发现里面的 source 很多是不正确的，或者是编造的；所以最后还是要自己人工去 check source。' },
      conditions: cond,
    }, 'POST')).json
    expect(redo.evaluationStatus).toBe('evaluated')
    expect(redo.diagnostic.step).toBe('D2b')
  })

  it('诊断会话恢复：latest 取最近未完成场；重开废弃旧场；完成后 latest 为空', async () => {
    const id = await mkAccount('诊断-恢复')
    expect((await call(`/api/v1/accounts/${id}/diagnostics/latest`)).json.diagnostic).toBeNull()
    const s1 = (await call(`/api/v1/accounts/${id}/diagnostics`, { requestId: 'rq-res1' }, 'POST')).json
    expect((await call(`/api/v1/accounts/${id}/diagnostics/latest`)).json.diagnostic.diagnosticId).toBe(s1.diagnosticId)
    // 重开：旧场服务端废弃，latest 唯一指向新场
    const s2 = (await call(`/api/v1/accounts/${id}/diagnostics`, { requestId: 'rq-res2' }, 'POST')).json
    expect((await call(`/api/v1/accounts/${id}/diagnostics/latest`)).json.diagnostic.diagnosticId).toBe(s2.diagnosticId)
    expect((await call(`/api/v1/accounts/${id}/diagnostics/${s1.diagnosticId}`)).json.status).toBe('abandoned')
    const abandoned = await call(`/api/v1/accounts/${id}/attempts`,{attemptId:'abandoned-new',sessionId:s1.diagnosticId,activityId:s1.activity.activityId,response:{kind:'text',text:'test'},conditions:{firstExposure:true,hintLevel:0,lookupUsed:false,responseMode:'typed_summary'}},'POST')
    expect(abandoned.status).toBe(400)
    expect(abandoned.json.error).toContain('DIAGNOSTIC_SESSION_NOT_OPEN')
    // requestId 幂等重放：同 requestId 再开返回原会话，不新开一场
    expect((await call(`/api/v1/accounts/${id}/diagnostics`, { requestId: 'rq-res2' }, 'POST')).json.diagnosticId).toBe(s2.diagnosticId)
    // 做完一场：latest 回空，下次进页面回到开始态
    const cond = { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' }
    let cur = s2
    const script = { D1: ANSWERS.rich_d1, D2: ANSWERS.pass_d2, D2b: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }
    for (let i = 0; cur.status === 'open' && cur.activity && i < 6; i++) {
      if (cur.activity.audio) await playTask(id, cur.activity)
      cur = (await call(`/api/v1/accounts/${id}/attempts`, {
        attemptId: `res-${cur.step}`, taskId: cur.activity.taskId, sessionId: cur.diagnosticId, activityId: cur.activity.activityId,
        response: { kind: 'text', text: script[cur.step] }, conditions: cond,
      }, 'POST')).json.diagnostic
    }
    expect(cur.status).toBe('completed')
    expect((await call(`/api/v1/accounts/${id}/diagnostics/latest`)).json.diagnostic).toBeNull()
  })

  it('复审 AUTO-000001-A1：槽位对+理由未测 = 中性参与（提交→GET evidence 端到端）——整目标不升级、不计连败；纯封闭题正常升级', async () => {
    const id = await mkAccount('A1-中性')
    const post = (attemptId, activityId, text, answers) => call(`/api/v1/accounts/${id}/attempts`, {
      attemptId, activityId,
      response: { kind: 'choice', text, answers },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    // ct03（带 reason 合同）：选 A + 空理由 → partial + slotOnly 中性
    const r1 = (await post('a1-ct03-empty', 'ct03_semantics_guard', '', { decision: 'A' })).json
    expect(r1.objectiveResults['O-K115-03']).toBe('partial')
    // ct01（纯封闭，无 reason 合同）：三槽全对 → met，正常升级
    const r2 = (await post('a1-ct01-full', 'ct01_which_probe', '', { which_a: 'DEVICE', which_b: 'EVENT', tail_role: 'B' })).json
    expect(r2.objectiveResults['O-K115-02']).toBe('met')
    // 端到端：GET evidence 断言最终状态
    const statesOf = async () => (await call(`/api/v1/accounts/${id}/evidence`)).json.states
    let states = await statesOf()
    const s03 = states.find((s) => s.objectiveId === 'O-K115-03' && s.skill === 'reading')
    const s02 = states.find((s) => s.objectiveId === 'O-K115-02' && s.skill === 'reading')
    // O-K115-03（只有 ct03 partial 证据）：不升 trained——中性参与，未测就是未测
    expect(s03?.state ?? 'absent').not.toBe('trained')
    expect(s03?.state ?? 'absent').not.toBe('independent')
    expect(s03?.flags ?? []).not.toContain('needs_repair') // 不计连败
    // O-K115-02（ct01 全对，reasonAssessed=true）：正常升级 trained
    expect(s02?.state).toBe('trained')
    // 冲突理由再提交：仍然中性（不升级、不因连败挂 needs_repair）
    await post('a1-ct03-conflict', 'ct03_semantics_guard', '他们搁置手势，采用语音，因为多人同时说话，仍想探索。', { decision: 'A' })
    states = await statesOf()
    expect(states.find((s) => s.objectiveId === 'O-K115-03' && s.skill === 'reading')?.state ?? 'absent').not.toBe('trained')
    expect(states.find((s) => s.objectiveId === 'O-K115-03' && s.skill === 'reading')?.flags ?? []).not.toContain('needs_repair')
  })

  it('R5 补丁：刷新后同 attemptId 不同内容 → 自动落下一轮 take 不 409；同内容幂等重放不重复入库', async () => {
    const id = await mkAccount('R5-刷新')
    // 用户实测场景：les-relations-v1 首活动，答错 → 刷新页面（take 计数丢失）→ 改答重提，同一首轮 attemptId
    const post = (attemptId, text) => call(`/api/v1/accounts/${id}/attempts`, {
      attemptId, activityId: 'les_l1_sensor_read',
      response: { kind: 'text', text },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    const baseId = 'les-les-relations-v1-les_l1_sensor_read'
    const first = (await post(baseId, '他们做了一个展览。')).json
    expect(first.pass).toBe(false)
    expect(first.attemptIdUsed).toBe(baseId)
    // 网络重试：同 ID 同内容 → 幂等重放，不落新行、不推进
    const retrySame = (await post(baseId, '他们做了一个展览。')).json
    expect(retrySame.replayed).toBe(true)
    expect(retrySame.attemptIdUsed).toBe(baseId)
    // 刷新后改答重提：同 ID 不同内容 → 服务端自动 bump 到 -t2，学生不被 409 卡住
    const fixed = (await post(baseId, '出问题的是实验室里看起来准、在舞台灯下不稳的那颗传感器；先在室内继续测；灯光检查前不装到现场——这不是永久禁用。')).json
    expect(fixed.replayed).toBeUndefined()
    expect(fixed.attemptIdUsed).toBe(`${baseId}-t2`)
    expect(fixed.pass).toBe(true)
    // 29 号 A2 验收：Y 的**网络重发**必须幂等回到同一条 -t2 记录，绝不能再落 -t3
    const fixedReplay = (await post(baseId, '出问题的是实验室里看起来准、在舞台灯下不稳的那颗传感器；先在室内继续测；灯光检查前不装到现场——这不是永久禁用。')).json
    expect(fixedReplay.replayed).toBe(true)
    expect(fixedReplay.attemptIdUsed).toBe(`${baseId}-t2`)
    // -t2 再网络重试 → 幂等；再改内容 → bump -t3（向上递增到空闲为止）
    expect((await post(`${baseId}-t2`, '出问题的是实验室里看起来准、在舞台灯下不稳的那颗传感器；先在室内继续测；灯光检查前不装到现场——这不是永久禁用。')).json.replayed).toBe(true)
    const third = (await post(baseId, '另一个新答案。')).json
    expect(third.attemptIdUsed).toBe(`${baseId}-t3`)
    // 落库核验：同 ID 系列只有 3 行（首轮 + 2 次真正的新作答），重试没有制造重复
    const { getDb } = await import('./db.mjs')
    const conn = (await import('./v3db.mjs')).ensureV3Schema(getDb())
    const rows = conn.prepare("SELECT attempt_id FROM learner_attempts_v3 WHERE account_id = ? AND activity_id = 'les_l1_sensor_read' ORDER BY attempt_id").all(id)
    expect(rows.map((r) => r.attempt_id)).toEqual([baseId, `${baseId}-t2`, `${baseId}-t3`])
  })

  it('F2：完成课程立即重算且不再推荐已完成课；重复完成不重复更新', async () => {
    const id = await mkAccount('F2-推进')
    await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.fail_d2, D2b: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }, 'rq-f2')
    await call(`/api/v1/accounts/${id}/lessons/les-listening-v1`)
    // R4：听力活动先落播放事件
    const issuedL2 = (await call(`/api/v1/accounts/${id}/lessons/les-listening-v1`)).json.activities.find(a => a.activityId === 'les_l2_museum_map_audio')
    await playTask(id, issuedL2)
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'f2-l2a', taskId: issuedL2.taskId, activityId: 'les_l2_museum_map_audio',
      response: { kind: 'text', text: '地图按设计正常工作，不完整的是对访客需求的假设；有访客以为里面有意思才走向拥挤的房间。' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'f2-l2b', activityId: 'les_l2b_museum_transcript',
      response: { kind: 'text', text: 'that 从句修饰地图；because 解释部分访客的动机；Could we ask visitors why they chose that route?' },
      conditions: { firstExposure: true, transcriptShown: true, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    const done = (await call(`/api/v1/accounts/${id}/lessons/les-listening-v1/complete`, {}, 'POST')).json
    expect(done.planCompleted).toBe(true)
    expect(done.decision).toBeTruthy()
    const again = (await call(`/api/v1/accounts/${id}/lessons/les-listening-v1/complete`, {}, 'POST')).json
    expect(again.replanNeeded).toBe(false)
    const plan = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
    expect(plan.lesson?.lessonId ?? '').not.toBe('les-listening-v1')
    // R2：新推荐（若有课）的目标必须属于课的实际可测目标——不借无关课填空
    if (plan.lesson?.lessonId) {
      const lessons = (await call('/api/v1/lessons')).json.lessons
      const served = lessons.find((l) => l.lessonId === plan.lesson.lessonId)
      expect(served.objectiveIds).toContain(plan.primaryGoal)
    }
  })

  it('F5：无录音不能签口语；内容不过关不给证据', async () => {
    const id = await mkAccount('F5-签署')
    await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'f5-read', activityId: 'les_l1_sensor_read',
      response: { kind: 'text', text: '出问题的是实验室里准的那颗传感器；现在可用于室内测试；安装被推迟到灯光检查。' },
      conditions: { firstExposure: true, hintLevel: 0, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    const rev = await call(`/api/v1/accounts/${id}/oral-reviews`, {
      attemptId: 'f5-read', mediaId: 'm_nonexistent',
      dimensions: { '信息与关系': 0, '可理解度': 3, '语言资源': 0, '组织与互动': 0 },
      objectiveResults: { 'O-K190-01': 'met' }, evaluator: 'x',
    }, 'POST')
    expect(rev.status).toBe(404) // 无录音 → 不能签
    const intent = (await call(`/api/v1/accounts/${id}/oral/intent`, { activityId: 'les_l3_oral_recap', mime: 'audio/webm', bytes: 1024, durationMs: 45000 }, 'POST')).json
    await call(`/api/v1/accounts/${id}/oral/${intent.mediaId}`, makeWav(900), 'PUT', new URLSearchParams({ token: intent.token }))
    await call(`/api/v1/accounts/${id}/attempts/oral`, {
      attemptId: 'f5-oral', mediaId: intent.mediaId, activityId: 'les_l3_oral_recap',
      transcript: 'anything', transcriptOrigin: 'user_typed',
      conditions: { firstExposure: true, hintLevel: 0, lookupUsed: false, responseMode: 'oral_recording' },
    }, 'POST')
    const rev2 = await call(`/api/v1/accounts/${id}/oral-reviews`, {
      attemptId: 'f5-oral', mediaId: intent.mediaId,
      dimensions: { '信息与关系': 0, '可理解度': 3, '语言资源': 0, '组织与互动': 0 },
      objectiveResults: { 'O-K190-01': 'met' }, evaluator: 'x',
    }, 'POST')
    expect(rev2.json.signed).toBe(false) // 内容门：发音清晰不能覆盖内容失败
    const ev = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K190-01`)).json
    expect(ev.states.some((st) => st.skill === 'speaking' && st.state !== 'unmeasured')).toBe(false)
  })

  it('F8：开关字符串 0 不启用；直接接口也被拒', async () => {
    const id = await mkAccount('F8-开关')
    process.env.ENGLISHFORGE_V4_GENERATION = '0'
    try {
      const r = await call(`/api/v1/accounts/${id}/generation/start`, { objectiveId: 'O-K115-01' }, 'POST')
      expect(r.status).toBe(409)
      expect(r.json.error).toContain('GENERATION_DISABLED')
    } finally { delete process.env.ENGLISHFORGE_V4_GENERATION }
  })
})
