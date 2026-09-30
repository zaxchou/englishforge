// W2：决策规则 v1 —— 先可解释、可回放，再谈优化（docs/curriculum-v4/15 §6）。
//
// 固定优先序：①剔除无效材料 → ②争议先复核不降级 → ③多假设给最短区分任务 →
// ④选相关、前置已备、薄弱且能打开后继的目标 → ⑤避开最近家族与已斩掉同层 →
// ⑥难度只升一个维度 → ⑦按状态选策略 → ⑧取课或诚实等待 → ⑨记录被排除候选。
// 同分排序：目标重要性 → 前置解除数 → 较少重复 → 目标 ID —— 同一快照必得同一决策。
import { ApiError } from './db.mjs'
import { ensureV3Schema, getMeta, nextCounter } from './v3db.mjs'
import { requireAccount } from './v3api.mjs'
import { activityById } from './v3evidence.mjs'
import { rowToObjective } from './v3map.mjs'

const STATE_RANK = { unmeasured: 0, tentative: 1, trained: 2, independent: 3, transferred: 4, retained: 5 }
const STRATEGY_LESSONS = {
  short_explain: 'les_l1_sensor_read',
  challenge_first: 'rep_film_postpone_read',
  short_repair: 'diag_d1b_contrast', // 定位题：只定位缺口，不算掌握证据
  discriminate_cause: 'diag_d1b_contrast',
  // sound_segmentation / oral_retrieval 需要真音频与真录音（W5），当前诚实等待：
  sound_segmentation: null,
  oral_retrieval: null,
}

export function getPlan(accountId) {
  requireAccount(accountId)
  const row = ensureV3Schema().prepare(
    'SELECT * FROM plan_decisions WHERE account_id = ? ORDER BY created_at DESC, decision_id DESC LIMIT 1').get(accountId)
  if (!row) {
    return {
      decision: null,
      note: '尚无决策：先 POST /diagnostics 做入口诊断（不做诊断不给推荐，不用旧题凑数）',
    }
  }
  return { decision: decisionView(row) }
}

export function recomputePlan(accountId, { requestId, triggerEvent } = {}) {
  return computePlan(accountId, { requestId, triggerEvent })
}

/** 每节后即重算。requestId 幂等；同账户决策天然串行（node:sqlite 同步执行） */
export function computePlan(accountId, { requestId, triggerEvent } = {}) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  if (requestId) {
    const prev = conn.prepare('SELECT * FROM plan_decisions WHERE account_id = ? AND request_id = ?').get(accountId, requestId)
    if (prev) return decisionView(prev)
  }

  const objectives = conn.prepare("SELECT * FROM objective_versions WHERE status != 'retired' ORDER BY objective_id").all().map(rowToObjective)
  const states = readStates(conn, accountId)
  const snapshot = buildSnapshot(conn, accountId, objectives, states)

  const decision = decide(objectives, states, snapshot)
  const decisionId = `pd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  conn.prepare(
    `INSERT INTO plan_decisions (account_id, decision_id, request_id, trigger_event, map_version, evidence_version,
       snapshot, candidates, primary_goal, strategy_id, reason, hypotheses, uncertain_areas, lesson_ref, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    accountId, decisionId, requestId ?? null, triggerEvent ?? null, snapshot.mapVersion, snapshot.evidenceVersion,
    JSON.stringify(snapshot), JSON.stringify(decision.candidates), decision.primaryGoal, decision.strategyId,
    decision.reason, JSON.stringify(decision.hypotheses), JSON.stringify(decision.uncertainAreas),
    JSON.stringify(decision.lesson), decision.status, Date.now(),
  )
  const row = conn.prepare('SELECT * FROM plan_decisions WHERE account_id = ? AND decision_id = ?').get(accountId, decisionId)
  return decisionView(row)
}

// ---------------------------------------------------------------- 快照（回放的根据）

function readStates(conn, accountId) {
  const map = new Map()
  for (const s of conn.prepare('SELECT * FROM learner_states WHERE account_id = ?').all(accountId)) {
    map.set(`${s.objective_id}|${s.skill}`, {
      objectiveId: s.objective_id, skill: s.skill, state: s.state, flags: JSON.parse(s.flags || '[]'),
    })
  }
  return map
}

function buildSnapshot(conn, accountId, objectives, states) {
  const recent = conn.prepare(
    'SELECT activity_id, task_family_id, role, objective_ids, evaluation_status, evaluation, created_at FROM learner_attempts_v3 WHERE account_id = ? ORDER BY created_at DESC LIMIT 10')
    .all(accountId).map((r) => ({
      activityId: r.activity_id, taskFamilyId: r.task_family_id, role: r.role,
      objectiveIds: JSON.parse(r.objective_ids || '[]'),
      pass: JSON.parse(r.evaluation || '{}')?.pass ?? null, createdAt: r.created_at,
    }))
  // 最近一场完成的入口诊断（D4 摘要）进快照：决策引用它，重放才成立
  const lastDiag = conn.prepare(
    "SELECT tentative FROM diagnostic_sessions WHERE account_id = ? AND status = 'completed' ORDER BY updated_at DESC LIMIT 1").get(accountId)
  return {
    mapVersion: 'map-v1',
    evidenceVersion: nextCounter2(conn, accountId),
    states: [...states.values()],
    recentAttempts: recent,
    diagnostic: lastDiag?.tentative ? JSON.parse(lastDiag.tentative) : null,
    disputedActivities: JSON.parse(getMeta(accountId, 'disputed_activities') || '[]'),
    waivers: [...states.values()].filter((s) => s.flags.includes('waived_by_user'))
      .map((s) => ({ objectiveId: s.objectiveId, skill: s.skill })),
    objectiveCount: objectives.length,
  }
}

function nextCounter2(conn, accountId) {
  // 只读版本号：不为快照自增（nextCounter 会 +1，这里偷个懒直接查）
  const row = conn.prepare('SELECT value FROM v3_counters WHERE account_id = ? AND name = ?').get(accountId, 'evidence')
  return row ? row.value : 0
}

// ---------------------------------------------------------------- 决策（纯函数，给定快照必可重放）

export function decide(objectives, states, snapshot) {
  const candidates = []
  const stateOf = (oid) => {
    const obj = objectives.find((o) => o.objectiveId === oid)
    const skill = primarySkill(obj)
    return states.get(`${oid}|${skill}`) ?? { state: 'unmeasured', flags: [] }
  }
  const primarySkill = (obj) => Object.keys(obj?.skills ?? {}).find((k) => obj.skills[k] === 'primary') ?? 'reading'
  const isWaived = (oid) => stateOf(oid).flags.includes('waived_by_user')
  const isDisputed = (oid) => stateOf(oid).flags.includes('disputed')
    || snapshot.disputedActivities.some((aid) => activityById(aid)?.objectiveIds.includes(oid))
  const needsRepair = (oid) => stateOf(oid).flags.includes('needs_repair')
  const prereqsOk = (obj) => obj.prerequisites.every((p) => {
    const st = stateOf(p)
    return ['trained', 'independent', 'transferred', 'retained'].includes(st.state) || st.flags.includes('waived_by_user')
  })
  const unlocks = (oid) => objectives.filter((o) => o.prerequisites.includes(oid)).length
  const recentFamilies = snapshot.recentAttempts.slice(0, 3).map((r) => r.taskFamilyId)
  const repetition = (obj) => snapshot.recentAttempts.filter((r) => r.objectiveIds.includes(obj.objectiveId)).length

  // ①② 材料有效性 / 争议复核
  const live = []
  for (const obj of objectives) {
    if (isDisputed(obj.objectiveId)) {
      candidates.push({ objectiveId: obj.objectiveId, reason: '材料争议复核中，先复核不降级（15 §6②）' })
      continue
    }
    live.push(obj)
  }

  // ③ 多假设 → 最短区分任务
  const hypotheses = snapshot.diagnostic?.hypotheses ?? []
  if (hypotheses.length >= 2) {
    const target = live.find((o) => o.objectiveId === 'O-K115-01') ?? live[0]
    return finalize({
      primaryGoal: target.objectiveId, strategyId: 'discriminate_cause',
      reason: `同一失败有两种合理解释（${hypotheses.join('、')}），先给最短的区分任务再定路线`,
      hypotheses, uncertainAreas: snapshot.diagnostic?.unmeasured ?? [], candidates,
      lessonActivityId: STRATEGY_LESSONS.discriminate_cause, snapshot, live, stateOf,
    })
  }

  // ④–⑦ 排序选主；⑤ 已斩掉的目标直接出列（同层同质练习不再进推荐）
  const eligible = live.filter((obj) => {
    if (isWaived(obj.objectiveId)) {
      candidates.push({ objectiveId: obj.objectiveId, reason: 'waived_by_user：同层同质练习移出队列（不批量重刷）；若复杂任务暴露缺口只开局部短修复' })
      return false
    }
    if (!prereqsOk(obj)) {
      candidates.push({ objectiveId: obj.objectiveId, reason: '前置证据未就绪（目标 ID 级前置，不是单元号）' })
      return false
    }
    return true
  })
  const ranked = [...eligible].sort((a, b) => {
    const imp = (o) => (o.firstPath ? 2 : 1)
    const weak = (o) => STATE_RANK[stateOf(o.objectiveId).state] ?? 0
    if (imp(b) !== imp(a)) return imp(b) - imp(a)               // 目标重要性
    if (weak(a) !== weak(b)) return weak(a) - weak(b)           // 证据薄弱优先
    if (unlocks(b.objectiveId) !== unlocks(a.objectiveId)) return unlocks(b.objectiveId) - unlocks(a.objectiveId) // 打开后继
    if (repetition(a) !== repetition(b)) return repetition(a) - repetition(b) // 较少重复
    return a.objectiveId < b.objectiveId ? -1 : 1               // 目标 ID 定死同分
  })
  for (const o of ranked.slice(1, 7)) {
    const st = stateOf(o.objectiveId).state
    candidates.push({
      objectiveId: o.objectiveId,
      reason: STATE_RANK[st] >= 2
        ? `${o.objectiveId} 已有 ${st} 级证据，路线不整条回退（14 §三种后继：保留已证实的层）`
        : `排序未选首：薄弱度 ${STATE_RANK[st]}、解锁 ${unlocks(o.objectiveId)}、近期重复 ${repetition(o)}`,
    })
  }

  const primary = ranked[0] ?? null
  if (!primary) {
    return {
      primaryGoal: null, strategyId: 'material_review', hypotheses, candidates,
      uncertainAreas: snapshot.diagnostic?.unmeasured ?? ['all_first_path'],
      reason: '当前候选材料均处争议复核或前置未就绪：不降级用户状态，等复核结束再推荐',
      lesson: null, fallback: null, status: 'ready', snapshot,
    }
  }

  // ⑦ 策略：修复 > 诊断路线 > 默认挑战先行
  const repairTarget = findRepairTarget(snapshot, objectives)
  const diag = snapshot.diagnostic
  let strategyId, lessonActivityId, reason
  if (repairTarget) {
    strategyId = 'short_repair'
    lessonActivityId = STRATEGY_LESSONS.short_repair
    reason = `复杂任务失败暴露 ${repairTarget} 的可靠缺口（该目标已被用户斩掉）：只开局部短修复定位，不批量重刷基础`
  } else if (diag?.route) {
    strategyId = diag.strategyId
    lessonActivityId = STRATEGY_LESSONS[diag.strategyId] ?? null
    reason = strategyReason(diag, stateOf)
  } else if (STATE_RANK[stateOf(primary.objectiveId).state] >= 2) {
    strategyId = 'challenge_first'
    lessonActivityId = STRATEGY_LESSONS.challenge_first
    reason = `${primary.objectiveId} 已有 trained 证据：挑战先行，证明即跳过基础（15 §6⑦）`
  } else {
    strategyId = 'short_explain'
    lessonActivityId = STRATEGY_LESSONS.short_explain
    reason = `${primary.objectiveId} 证据薄弱（${stateOf(primary.objectiveId).state}）且能打开 ${unlocks(primary.objectiveId)} 条后继：短讲后练`
  }

  return finalize({
    primaryGoal: repairTarget ?? diag?.primaryGoal ?? primary.objectiveId,
    strategyId, reason, hypotheses, candidates,
    lessonActivityId, snapshot, live, stateOf,
    uncertainAreas: diag?.unmeasured ?? ['listening_real_audio', 'speaking_free_oral', 'writing'],
  })
}

function findRepairTarget(snapshot, objectives) {
  // 最近的 repair 事件来自哪个目标（快照里带最近尝试，不查库 —— 保证可回放）
  const ids = objectives.map((o) => o.objectiveId)
  for (const s of snapshot.states) {
    if (s.flags.includes('needs_repair') && ids.includes(s.objectiveId)) return s.objectiveId
  }
  return null
}

function strategyReason(diag, stateOf) {
  switch (diag.route) {
    case 'L1': return `D1 文字关系未过（${diag.hypotheses.join('、') || '关系层缺口'}）：L1 结构对照先行，词不认识先补词义`
    case 'L2': return '文字能辨认但新音频首听漏结论：L2 声音/语流支线；文字证据保留，不整条回退'
    case 'L3': return '理解成立但脱稿只出关键词：L3 检索与组织训练，不继续堆选择题（A3）'
    case 'challenge_first': return '诊断全过：挑战先行，证明即跳过；下一步转入陌生迁移（L4）'
    default: return `按诊断路线 ${diag.route} 继续`
  }
}

function finalize({ primaryGoal, strategyId, reason, hypotheses, candidates, lessonActivityId, snapshot, uncertainAreas }) {
  const activity = lessonActivityId ? activityById(lessonActivityId) : null
  if (lessonActivityId && !activity) throw new ApiError(500, 'REGISTRY_INCONSISTENT: ' + lessonActivityId)
  return {
    primaryGoal, strategyId, reason,
    hypotheses,
    uncertainAreas,
    candidates,
    lesson: activity
      ? { activityId: activity.activityId, version: activity.version, role: activity.role, status: 'fixture_dev_only' }
      : { activityId: null, status: 'content_pending', waitNotice: waitNotice(strategyId) },
    fallback: null,
    status: 'ready',
    snapshotVersion: snapshot.evidenceVersion,
  }
}

function waitNotice(strategyId) {
  if (strategyId === 'sound_segmentation') return 'L2 原声音频课未制作（W5 前无原声）：诚实等待，不回退旧题伪装课程'
  if (strategyId === 'oral_retrieval') return 'L3 口述课需站内录音（W5 接入）：口语证据保持未测，不伪造成功'
  return '当前可用内容不足：等待经审核的材料，不塞同质题凑数'
}

function decisionView(row) {
  return {
    decisionId: row.decision_id,
    requestId: row.request_id,
    triggerEvent: row.trigger_event,
    mapVersion: row.map_version,
    learnerEvidenceVersion: row.evidence_version,
    primaryGoal: row.primary_goal,
    strategyId: row.strategy_id,
    reason: row.reason,
    hypotheses: JSON.parse(row.hypotheses || '[]'),
    uncertainAreas: JSON.parse(row.uncertain_areas || '[]'),
    lesson: JSON.parse(row.lesson_ref || 'null'),
    notChosen: JSON.parse(row.candidates || '[]'),
    status: row.status,
    createdAt: row.created_at,
  }
}
