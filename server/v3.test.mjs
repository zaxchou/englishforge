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

async function runDiagnostic(accountId, script, requestId) {
  let cur = (await call(`/api/v1/accounts/${accountId}/diagnostics`, { requestId }, 'POST')).json
  const responses = []
  let guard = 0
  while (cur.status === 'open' && cur.activity && guard++ < 8) {
    const r = await call(`/api/v1/accounts/${accountId}/attempts`, {
      attemptId: `${requestId}-${cur.step}`,
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
    expect(plan.primaryGoal).toBe('O-K184-03')
    expect(plan.strategyId).toBe('challenge_first')
    expect(plan.lesson.activityId).toBe('rep_film_postpone_read')
    expect(plan.reason).toBeTruthy()
    const dropped = plan.notChosen.find((n) => n.objectiveId === 'O-K115-01')
    expect(dropped.reason).toContain('证据')
  })

  it('P2 文字会声音卡 → L2 声音支线；文字证据保留，音频课诚实等待', async () => {
    const id = await mkAccount('T2-文字会声音卡')
    const { session } = await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.fail_d2, D2b: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }, 'rq-p2')
    expect(session.tentative.route).toBe('L2')
    expect(session.tentative.hypotheses).toContain('sound_segmentation_or_realtime')
    const plan = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
    expect(plan.primaryGoal).toBe('O-K007-02')
    expect(plan.strategyId).toBe('sound_segmentation')
    expect(plan.lesson.status).toBe('content_pending') // 原声未制作：等待，不回退旧题伪装课程
    const dropped = plan.notChosen.find((n) => n.objectiveId === 'O-K115-01')
    expect(dropped.reason).toContain('不整条回退')
    // 文字层证据保留
    const ev = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K115-01`)).json
    expect(ev.states[0].state).toBe('trained')
  })

  it('P3 理解会口述卡 → L3 检索/表达支线；口语证据诚实保持未测', async () => {
    const id = await mkAccount('T2-理解会口述卡')
    const { session } = await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.pass_d2, D3: ANSWERS.fail_d3 }, 'rq-p3')
    expect(session.tentative.route).toBe('L3')
    const plan = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
    expect(plan.primaryGoal).toBe('O-K190-01')
    expect(plan.strategyId).toBe('oral_retrieval')
    expect(plan.lesson.status).toBe('content_pending')
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
    // D1 失败 + D1b 定位成功：最多 tentative，不算 trained（17 §3：D1b 不是掌握证据）
    expect(ev.states[0].state).toBe('tentative')
  })
})

// ==================================================================
// W2 / T3：争议与坏材料 —— 用户不降级，holdout 不被污染
// ==================================================================
describe('W2/T3 争议与坏材料', () => {
  it('报告坏题 → 该次证据争议、状态不降级、材料隔离', async () => {
    const id = await mkAccount('T3-坏题')
    const { responses } = await runDiagnostic(id, { D1: ANSWERS.rich_d1, D2: ANSWERS.pass_d2, D3: ANSWERS.pass_d3 }, 'rq-t3')
    const before = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K115-01`)).json
    expect(before.states[0].state).toBe('trained')

    const d1Attempt = responses.find((r) => r.dimensions)?.attemptId
    const rep = await call(`/api/v1/accounts/${id}/content-reports`, {
      attemptId: d1Attempt, location: 'D1 第 2 问', description: 'that 从句限定对象存在歧义',
    }, 'POST')
    expect(rep.status).toBe(200)
    expect(rep.json.certificationPaused).toBe(true)

    const after = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K115-01`)).json
    expect(after.states[0].state).toBe('trained') // 不降级
    expect(after.states[0].flags).toContain('disputed') // 只挂争议
    expect(after.disputedAttempts.length).toBeGreaterThan(0)
    // 后续推荐：避开争议材料，不降级用户
    const plan = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: 'rq-t3-plan' }, 'POST')).json.decision
    const allNotChosen = plan.notChosen.map((n) => n.objectiveId).join(',')
    expect(allNotChosen).toContain('O-K115-01')
    expect(plan.notChosen.find((n) => n.objectiveId === 'O-K115-01').reason).toContain('争议')
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
    expect(ev.states[0].state).toBe('trained')
  })
})

// ==================================================================
// W2 / 附加：幂等、条件校验、诚实未实现
// ==================================================================
describe('W2/附加 幂等与诚实状态', () => {
  it('attemptId 幂等：同正文重放返回首次结果；异正文 409；缺条件 400', async () => {
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
    const r3 = await call(`/api/v1/accounts/${id}/attempts`, { ...body, response: { kind: 'text', text: '别的回答' } }, 'POST')
    expect(r3.status).toBe(409)
    expect(r3.json.error).toContain('REQUEST_ID_REUSED_WITH_DIFFERENT_BODY')
    const r4 = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: 'idem-2', activityId: 'diag_d1_read', response: { kind: 'text', text: 'x' },
      conditions: { firstExposure: true },
    }, 'POST')
    expect(r4.status).toBe(400)
  })

  it('课程包与录音接口诚实未实现（W3/W5），不伪造', async () => {
    const id = await mkAccount('W2-未实现')
    expect((await call(`/api/v1/accounts/${id}/lessons/any`, {}, 'GET')).status).toBe(501)
    expect((await call(`/api/v1/accounts/${id}/oral`, {}, 'POST')).status).toBe(501)
    const empty = (await call(`/api/v1/accounts/${id}/plan`)).json
    expect(empty.decision).toBeNull()
    expect(empty.note).toContain('入口诊断')
  })
})
