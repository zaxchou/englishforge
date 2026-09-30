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
  return {
    activityId: a.activityId, version: a.version, role: a.role, taskFamilyId: a.taskFamilyId,
    objectiveIds: a.objectiveIds, responseKind: a.responseKind, prompt: a.prompt, hints: a.hints,
    simulatesAudio: !!a.simulatesAudio, conditionsSpec: a.conditionsSpec,
    oralTask: !!a.oralEvidenceDeferred,
    fixtureNotice: a.simulatesAudio || a.oralEvidenceDeferred || a.locating || a.holdout
      ? '开发 fixture：仅用于验收，正式材料见 18 号文档的发布检查表' : null,
  }
}

// ---------------------------------------------------------------- 评估（确定性合同）

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[，。！？、；：""''（）,.!?;:'"()]/g, ' ').replace(/\s+/g, ' ')
}

export function evaluateAttempt(activity, response) {
  const c = activity.evaluationContract
  if (!c) return { status: 'pending', evaluation: null }
  const text = norm(typeof response === 'string' ? response : response?.text)
  const relations = c.relations.map((r) => ({ id: r.id, label: r.label, required: !!r.required, hit: r.anyOf.some((k) => text.includes(norm(k))) }))
  const violated = (c.mustNot ?? []).filter((m) => m.anyOf.some((k) => text.includes(norm(k)))).map((m) => m.label)
  const requiredOk = relations.filter((r) => r.required).every((r) => r.hit)
  const pass = requiredOk && violated.length === 0
  return {
    status: 'evaluated',
    evaluation: {
      pass,
      dimensions: c.dimensions,
      relations,
      mustNotViolations: violated,
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
    return attemptResult(conn, accountId, prev, activityById(prev.activity_id))
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
    JSON.stringify({ kind: payload.response?.kind ?? 'text', text: responseText }),
    JSON.stringify(effectiveConditions), evalStatus, JSON.stringify(evaluation), null, hash, ts,
  )

  const attemptRow = conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id = ? AND attempt_id = ?').get(accountId, attemptId)

  if (evalStatus === 'disputed' && evaluation?.reason === 'TRANSCRIPT_LOW_CONFIDENCE') {
    // 坏转写：追加争议事件（不降级、留待复核），机器不给结论
    for (const oid of activity.objectiveIds) {
      conn.prepare(
        `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
           kind, condition, pass, basis, created_at) VALUES (?,?,?,?,?,?,'dispute','transcript_low_confidence',NULL,?,?)`)
        .run(accountId, `ev_dispute_${attemptId}_${oid}`, attemptId, oid,
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

function attemptResult(conn, accountId, row, activity) {
  const evaluation = JSON.parse(row.evaluation || 'null')
  const isHoldout = activity?.role === 'holdout'
  return {
    attemptId: row.attempt_id,
    saved: true,
    evaluationStatus: row.evaluation_status,
    // holdout 只给结论：维度命中会泄露保留题的评分要点
    pass: evaluation ? evaluation.pass : null,
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
    const skill = activity.skillByObjective?.[oid] ?? 'reading'
    conn.prepare(
      `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
         kind, condition, pass, basis, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      accountId, `ev_${attemptRow.attempt_id}_${oid}`, attemptRow.attempt_id, oid, skill, 'base',
      'observed', condition, evaluation.pass ? 1 : 0,
      JSON.stringify({ role: activity.role, taskFamilyId: activity.taskFamilyId, evaluator: evaluation.evaluator ?? null,
        confidence: evaluation.confidence ?? null, oralDeferred: !!activity.oralEvidenceDeferred,
        locating: !!activity.locating }),
      Date.now(),
    )
    // 被斩掉的目标又独立失败 → 追加 repair 事件（决策层据此开局部短修复，不批量重刷）
    if (!evaluation.pass) {
      const st = conn.prepare('SELECT flags FROM learner_states WHERE account_id=? AND objective_id=? AND skill=? AND complexity=?')
        .get(accountId, oid, skill, 'base')
      if (st && JSON.parse(st.flags || '[]').includes('waived_by_user')) {
        conn.prepare(
          `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
             kind, condition, pass, basis, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(accountId, `ev_${attemptRow.attempt_id}_${oid}_repair`, attemptRow.attempt_id, oid, skill, 'base',
          'repair', condition, 0, JSON.stringify({ cause: 'waived_objective_failed' }), Date.now())
      }
    }
  }
}

// ---------------------------------------------------------------- 状态回放（evidence_events → learner_states）

/** 从事件流重建该账户全部 learner_states。
 *  争议语义（15 §5）：只追加 dispute、暂停更新、状态冻结在争议前的值 —— 不当场丢证据；
 *  复核结束再更正（dispute_cleared）或撤回（W3+ 的复核结论，追加反向事件）。 */
export function recomputeStates(accountId) {
  const conn = ensureV3Schema()
  const events = conn.prepare('SELECT * FROM evidence_events WHERE account_id = ? ORDER BY created_at, evidence_id').all(accountId)

  const acc = new Map() // key obj|skill → {state, flags:Set, independentFamilies:Set, failStreak}
  const slot = (obj, skill) => {
    const k = obj + '|' + skill
    if (!acc.has(k)) acc.set(k, { objectiveId: obj, skill, state: 'unmeasured', flags: new Set(), independentFamilies: new Set(), failStreak: 0 })
    return acc.get(k)
  }
  const openDisputeAt = new Map() // slot key → 争议提出时间（该时刻后的争议材料事件不再计入）

  for (const e of events) {
    const s = slot(e.objective_id, e.skill)
    const key = e.objective_id + '|' + e.skill
    if (e.kind === 'waive') { s.flags.add('waived_by_user'); continue }
    if (e.kind === 'dispute') { s.flags.add('disputed'); if (!openDisputeAt.has(key)) openDisputeAt.set(key, e.created_at); continue }
    if (e.kind === 'dispute_cleared') { s.flags.delete('disputed'); openDisputeAt.delete(key); continue }
    if (e.kind === 'repair') { s.flags.add('needs_repair'); continue }
    if (e.kind !== 'observed') continue
    const basis = JSON.parse(e.basis || '{}')
    const frozen = openDisputeAt.has(key) && e.created_at >= openDisputeAt.get(key)
    if (frozen && basis.evaluator !== 'human') continue // 争议后的事件暂停计入……
    if (frozen && basis.evaluator === 'human') {
      // ……除非这是复核结论（人审）：解除争议冻结并清除争议标志（15 §5 复核结束再更正）
      s.flags.delete('disputed')
      openDisputeAt.delete(key)
    }
    if (basis.oralDeferred) continue // 口语证据在真录音（W5）前不升级状态

    if (e.pass) {
      s.failStreak = 0
      const rank = STATE_RANK[s.state]
      if (basis.locating) { if (rank < 1) s.state = 'tentative'; continue } // 定位题不算掌握证据
      if (e.condition === 'transcript_shown') { if (rank < 2) s.state = 'trained'; continue } // 看稿成功≤trained，且已重定向到 reading
      if (e.condition === 'hinted' || e.condition === 'supported') { if (rank < 2) s.state = 'trained'; continue }
      // first_independent
      s.independentFamilies.add(basis.taskFamilyId ?? '?')
      if (basis.role === 'transfer' && s.independentFamilies.size >= 2) s.state = 'transferred'
      else if (s.independentFamilies.size >= 2) s.state = 'independent'
      else if (rank < 2) s.state = 'trained'
    } else {
      s.failStreak += 1
      if (s.failStreak >= 2) s.flags.add('needs_repair') // 两次同类失败先换策略，不硬刷
    }
  }

  const up = conn.prepare(
    `INSERT INTO learner_states (account_id, objective_id, skill, complexity, state, flags, evidence_version, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(account_id, objective_id, skill, complexity) DO UPDATE SET
       state=excluded.state, flags=excluded.flags, evidence_version=excluded.evidence_version, updated_at=excluded.updated_at`)
  const version = nextCounter(accountId, 'evidence')
  for (const s of acc.values()) {
    up.run(accountId, s.objectiveId, s.skill, 'base', s.state, JSON.stringify([...s.flags]), version, Date.now())
  }
  return { evidenceVersion: version, states: acc.size }
}

// ---------------------------------------------------------------- 免修与争议

/** POST /waivers：用户免修 = waived_by_user 标志，状态值不动，永远不会变成 retained */
export function waive(accountId, { objectiveId, skill, complexity = 'base', reason } = {}) {
  requireAccount(accountId)
  if (!objectiveId || !skill) throw new ApiError(400, 'WAVIER_NEEDS_OBJECTIVE_AND_SKILL')
  const conn = ensureV3Schema()
  conn.prepare(
    `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
       kind, condition, pass, basis, created_at)
     VALUES (?,?,NULL,?,?,?,'waive','user_waiver',NULL,?,?)`,
  ).run(accountId, `ev_waive_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, objectiveId, skill, complexity,
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
      insEvent.run(accountId, `ev_dispute_${t.attempt_id}_${oid}`, t.attempt_id, oid,
        act?.skillByObjective?.[oid] ?? 'reading', 'base', note, Date.now())
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
          act?.skillByObjective?.[oid] ?? 'reading', 'base', note, Date.now())
      }
    }
  }

  recomputeStates(accountId)
  return { reportId, certificationPaused: true, affectedAttempts: targets.length }
}

export function evidenceSummary(accountId, { objective, skill } = {}) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  let states = conn.prepare('SELECT * FROM learner_states WHERE account_id = ? ORDER BY objective_id, skill').all(accountId)
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
