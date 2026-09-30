// W2：学习证据合同（docs/curriculum-v4/15 §4–§5、13 §14）。
//
// 核心不变量：
// · 尝试只追加且幂等：同 attemptId 同正文重放返回首次结果；同 ID 异正文 409；
// · 状态可从 evidence_events 重放重建；争议不是删除，而是追加 dispute 事件并暂停更新；
// · 一次正确不认证：首见独立成功只到 trained；≥2 个不同家族才 independent；
//   transfer 角色跨家族成功才 transferred；retained 在 W2 不可达（需要延迟任务）；
// · 不同技能不互升：字幕/校对稿下的表现记 reading，永不升级 listening；
//   口语证据在真录音接入前（W5）保持 unmeasured；
// · holdout 的答案与维度明细永不下发，推荐课永不引用 holdout。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApiError, getDb } from './db.mjs'
import { ensureV3Schema, getMeta, setMeta, nextCounter, getCounter } from './v3db.mjs'
import { requireAccount } from './v3api.mjs'
import { audioPublicInfo } from './v3audio.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ACT_PATH = resolve(HERE, 'data', 'v3-activities.json')

let actCache = null
export function loadActivities() {
  if (!actCache) actCache = JSON.parse(readFileSync(ACT_PATH, 'utf8'))
  return actCache.activities
}
export function activityById(id) {
  const staticHit = loadActivities().find((a) => a.activityId === id)
  if (staticHit) return staticHit
  try { // W4 生成活动落库后与静态注册表同形（静态优先，保证 fixture 稳定）
    const row = ensureV3Schema().prepare('SELECT definition FROM generated_activities WHERE activity_id = ?').get(id)
    return row ? JSON.parse(row.definition) : null
  } catch { return null }
}

/** 学习者可见的活动视图：没有评估合同、没有答案、没有关系清单 */
export function publicActivity(a) {
  if (!a) return null
  const audio = audioPublicInfo(a)
  return {
    activityId: a.activityId, version: a.version, role: a.role, taskFamilyId: a.taskFamilyId,
    objectiveIds: a.objectiveIds, responseKind: a.responseKind, prompt: a.prompt, hints: a.hints,
    simulatesAudio: !!a.simulatesAudio, conditionsSpec: a.conditionsSpec,
    oralTask: !!a.oralEvidenceDeferred,
    audio, // synthetic 合成音频（21 §6.2）：mediaId/声源标注/时长；无音频时为 null
    fixtureNotice: audio ? null
      : (a.simulatesAudio || a.oralEvidenceDeferred || a.locating || a.holdout)
        ? '开发 fixture：仅用于验收，正式材料见 18 号文档的发布检查表' : null,
  }
}

// ---------------------------------------------------------------- 评估（确定性合同）

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[，。！？、；：""''（）,.!?;:'"()]/g, ' ').replace(/\s+/g, ' ')
}

// 否定判定（21§4）：多字否定词与英文否定在 14 字窗口内都算；中文单字否定词只认锚点前 3 字
// 的紧邻——否则"表现不好 他们想再测试"里的"不"会把远处的"再测试"误标成否定（实测踩过）。
const NEGATION_STRONG = ['并非', '并未', '没有', '不是', '不再', '不会', '不能', '并不是', '并没有', '并不会', '不等于', '不算', '没完全', '未完全', "n't", 'never', 'neither']
const NEGATION_LIGHT = ['不', '没', '未', '无', '别']

function negatedAt(text, at) {
  const window = text.slice(Math.max(0, at - 14), at)
  if (NEGATION_STRONG.some((n) => window.includes(n))) return true
  if (/(^|[^a-z])not([^a-z]|$)/.test(window)) return true
  const adjacent = text.slice(Math.max(0, at - 3), at)
  return NEGATION_LIGHT.some((n) => adjacent.includes(n))
}

export function evaluateAttempt(activity, response) {
  const c = activity.evaluationContract
  if (!c) return { status: 'pending', evaluation: null }
  const text = norm(typeof response === 'string' ? response : response?.text)
  // 锚点命中扫描（21§4 收尾）：同一锚点可能出现多次，逐次看前置 14 字窗口里的否定词。
  // mode: 'any' 出现即命中 | 'nonNegated' 至少一次非否定出现（关系为真才会说的话）
  // | 'negated' 至少一次否定语境出现（关系本身是"否定了某主张"，如"并未放弃"）
  const anchorHit = (needle, mode) => {
    let from = 0
    let sawNonNeg = false
    let sawNeg = false
    while (true) {
      const at = text.indexOf(needle, from)
      if (at < 0) break
      if (negatedAt(text, at)) sawNeg = true
      else sawNonNeg = true
      from = at + needle.length
    }
    if (mode === 'nonNegated') return sawNonNeg
    if (mode === 'negated') return sawNeg
    return sawNonNeg || sawNeg
  }
  const modeOf = (r) => (r.polarity === 'negated' ? 'negated' : (r.negationAware ? 'nonNegated' : 'any'))
  const relations = c.relations.map((r) => ({
    id: r.id, label: r.label, required: !!r.required,
    hit: r.anyOf.some((k) => anchorHit(norm(k), modeOf(r))),
  }))
  // mustNot 否定语境守卫（F4/21§4）：“并未完全放弃”不是“完全放弃”。至少一次非否定出现才算违规；
  // 活动可用 mustNotNegationGuard:false 显式退出守卫（现为所有库内活动的默认开）
  const mustNotMode = c.mustNotNegationGuard === false ? 'any' : 'nonNegated'
  const violated = (c.mustNot ?? []).filter((m) => m.anyOf.some((k) => anchorHit(norm(k), mustNotMode))).map((m) => m.label)
  const requiredOk = relations.filter((r) => r.required).every((r) => r.hit)
  const pass = requiredOk && violated.length === 0
  // 逐目标结果（F4/21§1）：活动级 pass 只控流程；每个目标按其归属关系单独判
  const tagOf = (r) => r.objectiveIds ?? activity.objectiveIds // 未标注的关系保持旧行为（全部归属）
  const objectiveResults = {}
  for (const oid of activity.objectiveIds) {
    const mine = relations.filter((r) => tagOf(r).includes(oid))
    const iViolated = (c.mustNot ?? []).some((m) => (m.objectiveIds ?? activity.objectiveIds).includes(oid) &&
      violated.includes(m.label))
    if (!mine.length || (c.unmeasuredObjectives ?? []).includes(oid)) { objectiveResults[oid] = 'unmeasured'; continue }
    const req = mine.filter((r) => r.required)
    const hits = req.filter((r) => r.hit).length
    if (iViolated) objectiveResults[oid] = 'unmet'
    else if (req.length && hits === req.length) objectiveResults[oid] = 'met'
    else if (hits > 0 || mine.some((r) => r.hit)) objectiveResults[oid] = 'partial'
    else objectiveResults[oid] = 'unmet'
  }
  return {
    status: 'evaluated',
    evaluation: {
      pass,
      dimensions: c.dimensions,
      relations,
      mustNotViolations: violated,
      objectiveResults,
      evaluator: 'deterministic-contract-v1',
      confidence: 'fixture', // 开发合同，不是校准过的评分器
    },
  }
}

// ---------------------------------------------------------------- 尝试落库

const STATE_RANK = { unmeasured: 0, tentative: 1, trained: 2, independent: 3, transferred: 4, retained: 5 }

function disputedActivities(accountId) {
  return JSON.parse(getMeta(accountId, 'disputed_activities') || '[]')
}

function bodyHash(payload) {
  return createHash('sha256').update(JSON.stringify({
    a: payload.activityId, r: payload.response ?? null, c: payload.conditions ?? null,
  })).digest('hex')
}

/**
 * POST /api/v1/accounts/:id/attempts 的实现。
 * 先落库再评估；返回里只有结论，没有答案 —— holdout 更是只给 pass/fail。
 */
export function recordAttempt(accountId, payload = {}) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  const attemptId = String(payload.attemptId || '')
  if (!attemptId) throw new ApiError(400, 'ATTEMPT_ID_REQUIRED')
  const activity = activityById(String(payload.activityId || ''))
  if (!activity) throw new ApiError(404, 'ACTIVITY_NOT_PUBLISHED: ' + payload.activityId)

  // 幂等：同 ID 同正文 → 原样返回首次结果；同 ID 异正文 → 冲突，绝不覆盖原始作答
  const hash = bodyHash(payload)
  const prev = conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id = ? AND attempt_id = ?').get(accountId, attemptId)
  if (prev) {
    if (prev.body_hash !== hash) throw new ApiError(409, 'REQUEST_ID_REUSED_WITH_DIFFERENT_BODY: ' + attemptId)
    // F6：幂等重放返回首次结果且标记 replayed —— 调用方不得再次推进诊断/流程
    return { ...attemptResult(conn, accountId, prev, activityById(prev.activity_id)), replayed: true }
  }

  // F1：声明口语录音作答就必须真的带了录音引用（缺录音不得产生口语证据）
  if (payload.conditions?.responseMode === 'oral_recording' && !payload.response?.mediaId) {
    throw new ApiError(400, 'ORAL_RECORDING_REQUIRED: responseMode=oral_recording 需要 mediaId')
  }
  const conditions = payload.conditions ?? null
  if (!conditions || typeof conditions !== 'object') throw new ApiError(400, 'CONDITIONS_REQUIRED')
  for (const k of activity.conditionsSpec ?? []) {
    if (!(k in conditions)) throw new ApiError(400, 'CONDITIONS_INCOMPLETE: missing ' + k)
  }
  // 服务端覆盖客户端自报（15 §12）：首见看库里有没有作答过；提示层数看揭示记录；
  // 默认给稿的活动 transcriptShown 强制为 true。客户端谎报"无提示首见"换不来独立证据。
  const hintRevealed = conn.prepare(
    'SELECT COALESCE(MAX(level), 0) AS m FROM activity_support_events WHERE account_id = ? AND activity_id = ? AND kind = ?')
    .get(accountId, activity.activityId, 'hint')?.m ?? 0
  const seenBefore = !!conn.prepare('SELECT 1 FROM learner_attempts_v3 WHERE account_id = ? AND activity_id = ?')
    .get(accountId, activity.activityId)
  const effectiveConditions = { ...conditions }
  effectiveConditions.hintLevel = Math.max(Number(conditions.hintLevel ?? 0) || 0, hintRevealed)
  effectiveConditions.transcriptShown = !!conditions.transcriptShown || !!activity.transcriptShownByDefault
  effectiveConditions.firstExposure = !!conditions.firstExposure && !seenBefore
  // 客户端自报不提升证据：角色/家族/目标/版本一律以服务端注册表为准
  const responseText = String(payload.response?.text ?? payload.response ?? '').slice(0, 4000)
  const disputedSet = disputedActivities(accountId)

  let evaluation, evalStatus
  if (disputedSet.includes(activity.activityId)) {
    evalStatus = 'disputed'
    evaluation = { reason: 'ACTIVITY_DISPUTED', evaluator: null }
  } else {
    const r = evaluateAttempt(activity, responseText)
    evaluation = r.evaluation
    evalStatus = r.status
    if (conditions.transcriptReliability === 'low') { // 转写低置信：争议，不扣能力（13 §6/A6）
      evalStatus = 'disputed'
      evaluation = { reason: 'TRANSCRIPT_LOW_CONFIDENCE', evaluator: evaluation?.evaluator ?? null }
    }
  }

  const ts = Date.now()
  conn.prepare(
    `INSERT INTO learner_attempts_v3 (account_id, attempt_id, session_id, activity_id, activity_version,
       objective_ids, task_family_id, role, response_kind, response, conditions, evaluation_status,
       evaluation, disputed_reason, body_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    accountId, attemptId, String(payload.sessionId || ''), activity.activityId, activity.version,
    JSON.stringify(activity.objectiveIds), activity.taskFamilyId, activity.role, activity.responseKind,
    JSON.stringify({ kind: payload.response?.kind ?? 'text', text: responseText, mediaId: payload.response?.mediaId ?? null }),
    JSON.stringify(effectiveConditions), evalStatus, JSON.stringify(evaluation), null, hash, ts,
  )

  const attemptRow = conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id = ? AND attempt_id = ?').get(accountId, attemptId)

  if (evalStatus === 'disputed' && evaluation?.reason === 'TRANSCRIPT_LOW_CONFIDENCE') {
    // 坏转写：追加争议事件（不降级、留待复核），机器不给结论
    for (const oid of activity.objectiveIds) {
      conn.prepare(
        `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
           kind, condition, pass, basis, created_at) VALUES (?,?,?,?,?,?,'dispute','transcript_low_confidence',NULL,?,?)`)
        .run(accountId, `ev_dispute_tx_${attemptId}_${oid}`, attemptId, oid,
          activity.skillByObjective?.[oid] ?? 'reading', 'base',
          JSON.stringify({ reason: 'TRANSCRIPT_LOW_CONFIDENCE' }), ts)
    }
    recomputeStates(accountId)
  }
  if (evalStatus === 'evaluated') {
    appendObservedEvents(conn, accountId, attemptRow, activity, effectiveConditions)
    recomputeStates(accountId)
  }

  return attemptResult(conn, accountId, attemptRow, activity)
}

/** F6：幂等重放——attemptId 已存在时返回首次结果（不推进任何流程） */
export function getStoredAttempt(accountId, attemptId) {
  const conn = ensureV3Schema()
  const row = conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id = ? AND attempt_id = ?').get(accountId, attemptId)
  if (!row) return null
  return { ...attemptResult(conn, accountId, row, activityById(row.activity_id)), replayed: true }
}

function attemptResult(conn, accountId, row, activity) {
  const evaluation = JSON.parse(row.evaluation || 'null')
  const isHoldout = activity?.role === 'holdout'
  return {
    attemptId: row.attempt_id,
    saved: true,
    evaluationStatus: row.evaluation_status,
    // holdout 只给结论：维度命中会泄露保留题的评分要点
    pass: evaluation ? evaluation.pass : null,
    // F4/21§1：逐目标结果 met/partial/unmet/unmeasured/disputed —— 未问的目标就是 unmeasured
    objectiveResults: isHoldout ? undefined : (evaluation?.objectiveResults ?? undefined),
    dimensions: isHoldout ? undefined : (evaluation?.relations ?? undefined),
    mustNotViolations: isHoldout ? undefined : evaluation?.mustNotViolations,
    evidenceEventIds: conn.prepare('SELECT evidence_id FROM evidence_events WHERE account_id = ? AND attempt_id = ?')
      .all(accountId, row.attempt_id).map((r) => r.evidence_id),
    nextAction: row.evaluation_status === 'disputed' ? 'review_transcript'
      : row.evaluation_status === 'pending' ? 'wait' : 'continue',
  }
}

function appendObservedEvents(conn, accountId, attemptRow, activity, conditions) {
  const evaluation = JSON.parse(attemptRow.evaluation || '{}')
  const firstIndependent = !!conditions.firstExposure && !(conditions.hintLevel > 0)
    && !conditions.transcriptShown && !conditions.lookupUsed
  const condition = firstIndependent ? 'first_independent'
    : conditions.transcriptShown ? 'transcript_shown'
      : conditions.hintLevel > 0 ? 'hinted' : 'supported'
  for (const oid of activity.objectiveIds) {
    // F4/21§1：未测到的目标不写事件（unmeasured 就是 unmeasured，不搭车）
    const perObj = evaluation.objectiveResults?.[oid]
    if (perObj === 'unmeasured') continue
    let skill = activity.skillByObjective?.[oid] ?? 'reading'
    const basisExtra = {}
    // F1：**没有音频**的文字模拟只可测阅读——listening 证据重定向到 reading，原样可追溯。
    // 有 audioRef（synthetic 合成音频，21 §6.2）就是真声音任务：listening 证据成立，
    // 事件里记 audio:'synthetic' 可追溯（不得冒充自然讲者材料）。
    if (activity.simulatesAudio && !activity.audioRef && skill === 'listening') {
      skill = 'reading'
      basisExtra.textSimAudioRedirected = true
    }
    if (activity.audioRef) basisExtra.audio = 'synthetic'
    // F1：复杂度分档（目标父组的复杂度带），不同带的表现不互相覆盖
    const complexity = complexityBandFor(conn, oid)
    conn.prepare(
      `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
         kind, condition, pass, basis, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      accountId, `ev_${attemptRow.attempt_id}_${oid}`, attemptRow.attempt_id, oid, skill, complexity,
      'observed', condition, (perObj === 'met') ? 1 : 0,
      JSON.stringify({ role: activity.role, taskFamilyId: activity.taskFamilyId, evaluator: evaluation.evaluator ?? null,
        confidence: evaluation.confidence ?? null, oralDeferred: !!activity.oralEvidenceDeferred,
        locating: !!activity.locating, perObjective: perObj, ...basisExtra }),
      Date.now(),
    )
    // 被斩掉的目标又失败 → repair 事件（决策层据此开局部短修复，不批量重刷）
    if (perObj === 'unmet' || perObj === 'partial' && evaluation.pass === false) {
      const st = conn.prepare('SELECT flags FROM learner_states WHERE account_id=? AND objective_id=? AND skill=? AND complexity=?')
        .get(accountId, oid, skill, 'base') // 状态聚合槽
      if (st && JSON.parse(st.flags || '[]').includes('waived_by_user')) {
        conn.prepare(
          `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
             kind, condition, pass, basis, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(accountId, `ev_${attemptRow.attempt_id}_${oid}_repair`, attemptRow.attempt_id, oid, skill, complexity,
          'repair', condition, 0, JSON.stringify({ cause: 'waived_objective_failed' }), Date.now())
      }
    }
  }
}

/** 目标 → 复杂度带（父组定义；查不到回落 'base'）。事件与人审都落真实带槽 */
export function complexityBandFor(conn, objectiveId) {
  const row = conn.prepare('SELECT g.complexity_band AS band FROM objective_versions o JOIN coverage_groups g ON g.group_id = o.parent_group WHERE o.objective_id = ? ORDER BY o.version DESC LIMIT 1')
    .get(objectiveId)
  return row?.band ? `band${row.band}` : 'base'
}

// ---------------------------------------------------------------- 状态回放（evidence_events → learner_states）

/** 从事件流重建该账户全部 learner_states。
 *  争议语义（15 §5）：只追加 dispute、暂停更新、状态冻结在争议前的值 —— 不当场丢证据；
 *  复核结束再更正（dispute_cleared）或撤回（W3+ 的复核结论，追加反向事件）。 */
export function recomputeStates(accountId) {
  const conn = ensureV3Schema()
  const events = conn.prepare('SELECT * FROM evidence_events WHERE account_id = ? ORDER BY created_at, evidence_id').all(accountId)
  // F1 历史重算：事件只追加不改写；重放时按活动**当前定义**纠正模态错位
  // （旧事件把文字模拟音频记成 listening —— 重放归位到 reading，原始事件保留可追溯）
  const activityOf = (() => {
    const m = new Map(
      conn.prepare('SELECT attempt_id, activity_id FROM learner_attempts_v3 WHERE account_id = ?').all(accountId)
        .map((r) => [r.attempt_id, r.activity_id]))
    return (attemptId) => (attemptId && m.get(attemptId) ? activityById(m.get(attemptId)) : null)
  })()

  // 分档槽位（21 §6.1/F1 验收）：每个 目标×技能×复杂度带 一个真实状态行——不同带的表现互不覆盖；
  // base 聚合槽按"最弱带"保守合并（易档通过盖不住嵌套档失败），标志并集——决策层读 base 不回退
  const acc = new Map() // key obj|skill|band → {state, flags:Set, independentFamilies:Set, failStreak}
  const baseAcc = new Map() // key obj|skill → 跨带聚合槽（最弱状态 + 标志并集）
  const slot = (obj, skill, band) => {
    const k = obj + '|' + skill + '|' + (band || 'base')
    if (!acc.has(k)) acc.set(k, {
      objectiveId: obj, skill, band: band || 'base', state: 'unmeasured', flags: new Set(),
      independentFamilies: new Set(), failStreak: 0, hasObserved: false, lastRepairAt: 0, lastPassAt: 0,
    })
    return acc.get(k)
  }
  const baseOf = (obj, skill) => {
    const k = obj + '|' + skill
    if (!baseAcc.has(k)) baseAcc.set(k, { objectiveId: obj, skill, state: 'unmeasured', observedRank: null, flags: new Set() })
    return baseAcc.get(k)
  }
  const addFlag = (obj, skill, band, flag) => {
    slot(obj, skill, band).flags.add(flag)
    baseOf(obj, skill).flags.add(flag)
  }
  const openDisputeAt = new Map() // slot key → 争议提出时间（该时刻后的争议材料事件不再计入）

  for (const e of events) {
    const band = e.complexity || 'base'
    const s = slot(e.objective_id, e.skill, band) // 真实槽位：事件发生在哪个带就记哪个带
    const key = e.objective_id + '|' + e.skill
    if (e.kind === 'waive') { addFlag(e.objective_id, e.skill, band, 'waived_by_user'); continue }
    if (e.kind === 'dispute') { addFlag(e.objective_id, e.skill, band, 'disputed'); if (!openDisputeAt.has(key)) openDisputeAt.set(key, e.created_at); continue }
    if (e.kind === 'dispute_cleared') { s.flags.delete('disputed'); baseOf(e.objective_id, e.skill).flags.delete('disputed'); openDisputeAt.delete(key); continue }
    if (e.kind === 'repair') { s.lastRepairAt = Math.max(s.lastRepairAt, e.created_at); continue } // 是否仍需修复在回放末尾判
    if (e.kind !== 'observed') continue
    const basis = JSON.parse(e.basis || '{}')
    // F1 重算：**无音频**的文字模拟历史 listening 事件 → reading 槽位；带 audioRef 的保持 listening
    let skill = e.skill
    const actDef = activityOf(e.attempt_id)
    if (actDef?.simulatesAudio && !actDef.audioRef && skill === 'listening') skill = 'reading'
    const s2 = slot(e.objective_id, skill, band)
    const frozen = openDisputeAt.has(e.objective_id + '|' + skill) && e.created_at >= (openDisputeAt.get(e.objective_id + '|' + skill) ?? 0)
    if (frozen && basis.evaluator !== 'human') continue // 争议后的事件暂停计入……
    if (frozen && basis.evaluator === 'human') {
      // ……除非这是复核结论（人审）：解除争议冻结并清除争议标志（15 §5 复核结束再更正）
      s2.flags.delete('disputed')
      baseOf(e.objective_id, skill).flags.delete('disputed')
      openDisputeAt.delete(e.objective_id + '|' + skill)
    }
    if (basis.oralDeferred) continue // 口语证据在真录音（W5）前不升级状态
    s2.hasObserved = true

    if (e.pass) {
      s2.failStreak = 0
      s2.lastPassAt = Math.max(s2.lastPassAt, e.created_at)
      const rank = STATE_RANK[s2.state]
      if (basis.locating) { if (rank < 1) s2.state = 'tentative'; continue } // 定位题不算掌握证据
      if (e.condition === 'transcript_shown') { if (rank < 2) s2.state = 'trained'; continue } // 看稿成功≤trained，且已重定向到 reading
      if (e.condition === 'hinted' || e.condition === 'supported') { if (rank < 2) s2.state = 'trained'; continue }
      // first_independent
      s2.independentFamilies.add(basis.taskFamilyId ?? '?')
      if (basis.role === 'transfer' && s2.independentFamilies.size >= 2) s2.state = 'transferred'
      else if (s2.independentFamilies.size >= 2) s2.state = 'independent'
      else if (rank < 2) s2.state = 'trained'
    } else {
      s2.failStreak += 1
      // needs_repair 不在这里挂：标志在回放结束后按**最终**连败判定——再次成功会自然过期，
      // 否则一次历史连败让 short_repair 永远锁住推荐（轨迹走查实测踩过）
    }
  }
  // 回放结束判定换策略建议：最终连败 ≥2，或 repair 事件之后（该槽）再无通过——
  // 修复建议会过期，不永续锁推荐（轨迹走查实测：repair 标志永续导致 short_repair 死循环）
  for (const s of acc.values()) {
    if (s.failStreak >= 2 || (s.lastRepairAt && s.lastRepairAt > s.lastPassAt)) s.flags.add('needs_repair')
  }

  // base 聚合：状态只在**有作答证据**的带里取最弱（免修/争议这类纯标志槽不把状态拖回 unmeasured）；
  // 标志并集（任何带的 waived/disputed/needs_repair 都要在综合行可见）
  for (const s of acc.values()) {
    const b = baseOf(s.objectiveId, s.skill)
    if (s.hasObserved && (b.observedRank === null || STATE_RANK[s.state] < b.observedRank)) {
      b.observedRank = STATE_RANK[s.state]
      b.state = s.state
    }
    for (const f of s.flags) b.flags.add(f)
  }
  for (const [k, b] of baseAcc) {
    if (b.observedRank === null && !b.flags.size) baseAcc.delete(k) // 无证据无标志不落行
  }

  const up = conn.prepare(
    `INSERT INTO learner_states (account_id, objective_id, skill, complexity, state, flags, evidence_version, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(account_id, objective_id, skill, complexity) DO UPDATE SET
       state=excluded.state, flags=excluded.flags, evidence_version=excluded.evidence_version, updated_at=excluded.updated_at`)
  const version = nextCounter(accountId, 'evidence')
  for (const s of acc.values()) {
    up.run(accountId, s.objectiveId, s.skill, s.band, s.state, JSON.stringify([...s.flags]), version, Date.now())
  }
  for (const b of baseAcc.values()) {
    // base 行不再来自事件回放，而是跨带聚合——名称保留 'base' 供决策层稳定读取
    up.run(accountId, b.objectiveId, b.skill, 'base', b.state, JSON.stringify([...b.flags]), version, Date.now())
  }
  return { evidenceVersion: version, states: acc.size + baseAcc.size }
}

// ---------------------------------------------------------------- 免修与争议

/** POST /waivers：用户免修 = waived_by_user 标志，状态值不动，永远不会变成 retained */
export function waive(accountId, { objectiveId, skill, complexity, reason } = {}) {
  requireAccount(accountId)
  if (!objectiveId || !skill) throw new ApiError(400, 'WAVIER_NEEDS_OBJECTIVE_AND_SKILL')
  const conn = ensureV3Schema()
  // 事件带父组复杂度带（审计粒度）；状态聚合槽仍是 'base'（recompute 的聚合口径）
  const bandComplexity = complexity || complexityBandFor(conn, objectiveId)
  complexity = 'base'
  conn.prepare(
    `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
       kind, condition, pass, basis, created_at)
     VALUES (?,?,NULL,?,?,?,'waive','user_waiver',NULL,?,?)`,
  ).run(accountId, `ev_waive_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, objectiveId, skill, bandComplexity,
    JSON.stringify({ reason: String(reason || '').slice(0, 500) }), Date.now())
  recomputeStates(accountId)
  const st = conn.prepare('SELECT * FROM learner_states WHERE account_id=? AND objective_id=? AND skill=? AND complexity=?')
    .get(accountId, objectiveId, skill, complexity)
  return {
    ok: true,
    state: st?.state ?? 'unmeasured',
    flags: JSON.parse(st?.flags || '[]'),
    note: 'waived_by_user 只把同层同质练习移出推荐，不等于 retained，也不是认证',
  }
}

/** POST /content-reports：报告坏题/坏转写 → 追加争议、暂停该材料证据，不降级用户 */
export function reportContent(accountId, { attemptId, activityId, location, description } = {}) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  const reportId = `cr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const targets = []
  if (attemptId) {
    const row = conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id=? AND attempt_id=?').get(accountId, attemptId)
    if (!row) throw new ApiError(404, 'ATTEMPT_NOT_FOUND: ' + attemptId)
    targets.push(row)
  } else if (activityId) {
    targets.push(...conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id=? AND activity_id=?').all(accountId, activityId))
  } else throw new ApiError(400, 'REPORT_NEEDS_ATTEMPT_OR_ACTIVITY')

  const insEvent = conn.prepare(
    `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
       kind, condition, pass, basis, created_at) VALUES (?,?,?,?,?,?,'dispute','content_report',NULL,?,?)`)
  const note = JSON.stringify({ reportId, location: String(location || '').slice(0, 300), description: String(description || '').slice(0, 500) })

  for (const t of targets) {
    if (t.evaluation_status !== 'disputed') {
      conn.prepare("UPDATE learner_attempts_v3 SET evaluation_status='disputed', disputed_reason=? WHERE account_id=? AND attempt_id=?")
        .run('CONTENT_REPORT: ' + String(description || location || '').slice(0, 300), accountId, t.attempt_id)
    }
    const act = activityById(t.activity_id)
    for (const oid of JSON.parse(t.objective_ids || '[]')) {
      // 争议事件落在目标的真实复杂度带上（和作答事件同槽），不写 'base'——聚合槽只由回放生成
      insEvent.run(accountId, `ev_dispute_${t.attempt_id}_${oid}`, t.attempt_id, oid,
        act?.skillByObjective?.[oid] ?? 'reading', complexityBandFor(conn, oid), note, Date.now())
    }
  }

  // 活动级报告：隔离该材料（含 holdout），之后的尝试自动进 disputed
  if (activityId) {
    const list = JSON.parse(getMeta(accountId, 'disputed_activities') || '[]')
    if (!list.includes(activityId)) list.push(activityId)
    setMeta(accountId, 'disputed_activities', JSON.stringify(list))
    if (!targets.length) { // 没有历史尝试也要挂争议标志
      const act = activityById(activityId)
      for (const oid of act?.objectiveIds ?? []) {
        insEvent.run(accountId, `ev_dispute_act_${reportId}_${oid}`, null, oid,
          act?.skillByObjective?.[oid] ?? 'reading', complexityBandFor(conn, oid), note, Date.now())
      }
    }
  }

  recomputeStates(accountId)
  return { reportId, certificationPaused: true, affectedAttempts: targets.length }
}

export function evidenceSummary(accountId, { objective, skill } = {}) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  // complexity 入排序：同目标同技能的带行/聚合行顺序确定（band1 < band2 < … < base）
  let states = conn.prepare('SELECT * FROM learner_states WHERE account_id = ? ORDER BY objective_id, skill, complexity').all(accountId)
  if (objective) states = states.filter((s) => s.objective_id === objective)
  if (skill) states = states.filter((s) => s.skill === skill)
  const events = conn.prepare('SELECT evidence_id, attempt_id, objective_id, skill, kind, condition, pass, basis, created_at FROM evidence_events WHERE account_id = ? ORDER BY created_at').all(accountId)
  return {
    evidenceVersion: getCounter(accountId, 'evidence'),
    states: states.map((s) => ({
      objectiveId: s.objective_id, skill: s.skill, complexity: s.complexity, state: s.state,
      flags: JSON.parse(s.flags || '[]'), updatedAt: s.updated_at,
    })),
    disputedAttempts: conn.prepare("SELECT attempt_id, activity_id, disputed_reason FROM learner_attempts_v3 WHERE account_id=? AND evaluation_status='disputed'").all(accountId),
    recentEvents: events.slice(-20).map((e) => ({ ...e, basis: JSON.parse(e.basis || '{}') })),
    note: '状态可由 evidence_events 重放重建；disputed 只暂停更新，不删除历史',
  }
}
