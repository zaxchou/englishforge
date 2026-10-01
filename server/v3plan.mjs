// W2：决策规则 v1 —— 先可解释、可回放，再谈优化（docs/curriculum-v4/15 §6）。
//
// 固定优先序：①剔除无效材料 → ②争议先复核不降级 → ③多假设给最短区分任务 →
// ④选相关、前置已备、薄弱且能打开后继的目标 → ⑤避开最近家族与已斩掉同层 →
// ⑥难度只升一个维度 → ⑦按状态选策略 → ⑧取课或诚实等待 → ⑨记录被排除候选。
// 同分排序：目标重要性 → 前置解除数 → 较少重复 → 目标 ID —— 同一快照必得同一决策。
import { ApiError } from './db.mjs'
import { ensureV3Schema, getMeta, nextCounter } from './v3db.mjs'
import { requireAccount } from './v3api.mjs'
import { activityById, loadActivities } from './v3evidence.mjs'
import { seedMap, rowToObjective } from './v3map.mjs'
import { getLesson, seedLessons, lessonForStrategy, lessonForObjective, lessonApplicable, completedLessonIds } from './v3lessons.mjs'

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
  seedMap()
  seedLessons()
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
       snapshot, candidates, primary_goal, strategy_id, reason, hypotheses, uncertain_areas, lesson_ref,
       served_lesson_id, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    accountId, decisionId, requestId ?? null, triggerEvent ?? null, snapshot.mapVersion, snapshot.evidenceVersion,
    JSON.stringify(snapshot), JSON.stringify(decision.candidates), decision.primaryGoal, decision.strategyId,
    decision.reason, JSON.stringify(decision.hypotheses), JSON.stringify(decision.uncertainAreas),
    // 40-P1：lesson 与 fallback 一起留档（备用选择与主目标分开存储）；decisionView 对旧形状诚实兼容
    JSON.stringify({ lesson: decision.lesson, fallback: decision.fallback ?? null }), decision.lesson?.lessonId ?? null, decision.status, Date.now(),
  )
  const row = conn.prepare('SELECT * FROM plan_decisions WHERE account_id = ? AND decision_id = ?').get(accountId, decisionId)
  return decisionView(row)
}

// ---------------------------------------------------------------- 快照（回放的根据）

function readStates(conn, accountId) {
  const map = new Map()
  // 只读 base 聚合行（跨带最弱合并）；band 行是展示/审计粒度，不直接进决策
  for (const s of conn.prepare("SELECT * FROM learner_states WHERE account_id = ? AND complexity = 'base'").all(accountId)) {
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
    "SELECT tentative, updated_at FROM diagnostic_sessions WHERE account_id = ? AND status = 'completed' ORDER BY updated_at DESC LIMIT 1").get(accountId)
  return {
    mapVersion: 'map-v1',
    accountId,
    evidenceVersion: nextCounter2(conn, accountId),
    states: [...states.values()],
    recentAttempts: recent,
    diagnostic: lastDiag?.tentative ? JSON.parse(lastDiag.tentative) : null,
    diagnosticCreatedAt: lastDiag?.updated_at ?? 0,
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

  // ④–⑦ 前置：eligible 先算（⑤ 已斩掉的目标直接出列，同层同质练习不再进推荐）——
  // 多假设分支也要它的 eligibleRanked，窗口才不会在该分支塌缩成仅主目标（复审 P3）
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

  // ③ 多假设 → 最短区分任务。F2：诊断假设可被后续证据修正——只在诊断仍新鲜且区分目标
  // 还薄弱时生效；目标已 trained 说明假设已被学习消解，走正常排序（否则永久锁路线）
  const hypotheses = snapshot.diagnostic?.hypotheses ?? []
  const lastAttemptAt0 = snapshot.recentAttempts[0]?.createdAt ?? 0
  const diagFresh0 = !!snapshot.diagnosticCreatedAt && snapshot.diagnosticCreatedAt >= lastAttemptAt0
  if (diagFresh0 && hypotheses.length >= 2) {
    const target = eligible.find((o) => o.objectiveId === 'O-K115-01') ?? eligible[0] ?? live[0]
    if (target && STATE_RANK[stateOf(target.objectiveId).state] < 2) {
      return finalize({
        primaryGoal: target.objectiveId, strategyId: 'discriminate_cause',
        reason: `同一失败有两种合理解释（${hypotheses.join('、')}），先给最短的区分任务再定路线`,
        hypotheses, uncertainAreas: snapshot.diagnostic?.unmeasured ?? [], candidates,
        lessonActivityId: STRATEGY_LESSONS.discriminate_cause, snapshot, live, stateOf,
        accountId: snapshot.accountId, // F2：排除已完成课在这里同样生效（轨迹走查实测漏传导致已完成课被复推）
        eligibleRanked: eligible.map((o) => o.objectiveId),
      })
    }
  }

  // F2：诊断是可修正的假设。诊断晚于最近作答时才有路线发言权；且路线目标必须仍 eligible
  const lastAttemptAt = snapshot.recentAttempts[0]?.createdAt ?? 0
  const diag = snapshot.diagnostic
  const diagFresh = !!snapshot.diagnosticCreatedAt && snapshot.diagnosticCreatedAt >= lastAttemptAt
  const diagRouteApplicable = diagFresh && !!(diag?.primaryGoal && eligible.some((o) => o.objectiveId === diag.primaryGoal))
  const ranked = [...eligible].sort((a, b) => {
    // F3：eligibleRanked 与 exclusions 分离——下游（生成窗口）只消费前者
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
  const eligibleRanked = ranked.map((o) => o.objectiveId)
  if (!primary) {
    return {
      primaryGoal: null, strategyId: 'material_review', hypotheses, candidates,
      uncertainAreas: snapshot.diagnostic?.unmeasured ?? ['all_first_path'],
      reason: '当前候选材料均处争议复核或前置未就绪：不降级用户状态，等复核结束再推荐',
      lesson: null, fallback: null, status: 'ready', snapshot, eligibleRanked,
    }
  }

  // ⑦ 策略：修复 > 诊断路线 > 默认挑战先行
  const repair = findRepairTarget(snapshot, objectives)
  const repairTarget = repair?.objectiveId ?? null
  const repairProbe = repairTarget ? repairProbeFor(repairTarget) : null
  let strategyId, lessonActivityId, reason
  if (repairTarget && repairProbe) {
    strategyId = 'short_repair'
    // 探针要对着修复目标本身：取含该目标的诊断活动（写死的通用探针会答了也没用——
    // 轨迹走查实测：O-K190-01 的缺口被拿 O-K115-01 的对比探针"定位"，永远修不掉）
    lessonActivityId = repairProbe
    // needs_repair 也可能来自未免修目标的连败——文案跟事实一致（复审 P3）
    reason = repair.waived
      ? `复杂任务失败暴露 ${repairTarget} 的可靠缺口（该目标已被用户斩掉）：只开局部短修复定位，不批量重刷基础`
      : `复杂任务失败暴露 ${repairTarget} 的可靠缺口（连续两次未过）：只开局部短修复定位，不批量重刷`
  } else if (diagRouteApplicable && diag?.route) {
    // F2：诊断路线只在其目标仍 eligible 且诊断足够新时生效；否则按最新证据选择
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

  // finalGoal 只在**真的走了修复/诊断路线**时被覆盖——修复分支因无可闭合探针让位时，
  // 主目标也回到排序首（否则出现"主目标 A + 理由是 B"的错位展示）
  const finalGoal = (repairTarget && repairProbe) ? repairTarget
    : (diagRouteApplicable ? diag.primaryGoal : null) ?? primary.objectiveId
  return finalize({
    primaryGoal: finalGoal,
    strategyId, reason, hypotheses, candidates,
    lessonActivityId, snapshot, live, stateOf,
    uncertainAreas: diag?.unmeasured ?? ['listening_real_audio', 'speaking_free_oral', 'writing'],
    accountId: snapshot.accountId, eligibleRanked,
  })
}

function findRepairTarget(snapshot, objectives) {
  // 最近的 repair 事件来自哪个目标（快照里带最近尝试，不查库 —— 保证可回放）。
  // 返回 {objectiveId, waived}：needs_repair 不只来自免修目标（连败也会），文案要跟事实一致
  const ids = objectives.map((o) => o.objectiveId)
  for (const s of snapshot.states) {
    if (s.flags.includes('needs_repair') && ids.includes(s.objectiveId)) {
      return { objectiveId: s.objectiveId, waived: s.flags.includes('waived_by_user') }
    }
  }
  return null
}

/** 短修复探针 = 含修复目标的**可闭合**诊断活动里最短的那个（"短修复"就该用最短定位任务；
 * 口语/无音频模拟的探针不算数——F5：文字作答关闭不了口语缺口），找不到返回 null——
 * 修复分支让位给正常排序，缺口目标带着 needs_repair 在 notChosen 里如实显示 */
function repairProbeFor(repairTarget) {
  const relCount = (a) => (a.relations ?? a.evaluationContract?.relations ?? []).length
  const hits = loadActivities().filter((a) => a.role === 'diagnostic' && !a.holdout
    && !a.oralEvidenceDeferred && !(a.simulatesAudio && !a.audioRef)
    && (a.objectiveIds ?? []).includes(repairTarget))
    .sort((a, b) => relCount(a) - relCount(b) || (a.activityId < b.activityId ? -1 : 1))
  return hits[0]?.activityId ?? null
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

function finalize({ primaryGoal, strategyId, reason, hypotheses, candidates, lessonActivityId, snapshot, uncertainAreas, accountId, eligibleRanked }) {
  const activity = lessonActivityId ? activityById(lessonActivityId) : null
  if (lessonActivityId && !activity) throw new ApiError(500, 'REGISTRY_INCONSISTENT: ' + lessonActivityId)
  // R2（24 号）：**推荐目标必须属于课的实际可测目标**——lessonForObjective 天然匹配；
  // 策略兜底带 mustIncludeObjective 校验，不匹配就不借课。
  // fixture 探针同理：lessonActivityId 的活动必须真的测主目标，否则 content_pending，
  // 不能拿无关活动顶"下一题"（轨迹曾拿 les_l1_sensor_read 顶 O-K007-01）。
  const pkg = lessonForObjective(primaryGoal, { excludeCompletedFor: accountId })
    ?? lessonForStrategy(strategyId, { excludeCompletedFor: accountId, mustIncludeObjective: primaryGoal })
  const probeFits = activity && (activity.objectiveIds ?? []).includes(primaryGoal)
  // 诚实的状态三分：有课包→published（devSample 按 release channel）；主目标匹配的 fixture 活动→fixture_dev_only；都没有→content_pending
  let lesson
  if (pkg) {
    const full = pkg.lessonId ? getLesson(pkg.lessonId) : null
    lesson = {
      lessonId: pkg.lessonId,
      version: pkg.version, // R2 后仍要给前端真实版本（23 轨迹曾显示 vnull）
      activityId: activity && probeFits ? activity.activityId : null,
      role: activity && probeFits ? activity.role : null,
      status: 'published',
      devSample: !!pkg.devOnly, // dev_only 通道=开发样本；人审签署的 mainline 课不再标“未签署”
      // 38-S3：内容试验预览与推荐卡同源（quality_gates.contentPreview，生成发布时写入）
      contentPreview: full?.qualityGates?.contentPreview === true,
    }
  } else if (activity && probeFits) {
    lesson = { lessonId: null, activityId: activity.activityId, version: activity.version, role: activity.role, status: 'fixture_dev_only' }
  } else {
    lesson = { lessonId: null, activityId: null, status: 'content_pending', waitNotice: waitNotice(strategyId) }
  }
  // 40-P1：主目标没有现成内容时，给**与主目标分开**的备用迁移任务（不重复已完成、
  // 不要求付费生成或免修就能继续学），并解释为什么现在练它；完成后由完成重算重新定位。
  const fallback = pkg || lesson.lessonId ? null : fallbackLesson(accountId)
  return {
    primaryGoal, strategyId, reason,
    hypotheses,
    uncertainAreas,
    candidates,
    lesson,
    fallback,
    status: 'ready',
    eligibleRankedCandidates: eligibleRanked ?? [],
    snapshotVersion: snapshot.evidenceVersion,
  }
}

/** 40-P1 备用任务选择（与 primaryGoal 分开存储）：
 * ① 最近完成课的 nextCandidates 里仍可学的（链的自然延续——"趁热检验新情境"）；
 * ② 账户练过的方向上、未完成的可学课。
 * 两级都找不到才返回 null（那时今日卡只剩生成/免修出路，如实显示）。
 * 过滤与主推荐同口径：published、未完成、lessonApplicable、有可测目标。 */
function fallbackLesson(accountId) {
  if (!accountId) return null
  const conn = ensureV3Schema()
  const done = completedLessonIds(conn, accountId)
  const usable = (l) => l && l.contentStatus === 'published' && !done.has(l.lessonId)
    && lessonApplicable(accountId, l) && (l.objectiveIds ?? []).length > 0
  // ① 链的自然延续：最近完成课声明的后继
  const recentDone = conn.prepare(
    "SELECT served_lesson_id FROM plan_decisions WHERE account_id = ? AND status = 'completed' AND served_lesson_id IS NOT NULL ORDER BY created_at DESC LIMIT 3").all(accountId)
  for (const r of recentDone) {
    const from = getLesson(r.served_lesson_id)
    for (const nid of from?.nextCandidates ?? []) {
      const cand = getLesson(nid)
      if (usable(cand)) {
        return { lessonId: cand.lessonId, title: cand.title, objectiveIds: cand.objectiveIds ?? [],
          reason: `你刚完成的《${from.title}》还有一节后继迁移课，趁热在新情境里检验；当前主目标的课还在准备中。完成它之后会重新安排下一步。` }
      }
    }
  }
  // ② 练过的方向上、还没学过的课。"练过的方向"= 状态行 ∪ **全部完成课所测的目标**
  //（开放练习题只给练习反馈不写状态行；完成课集合不看"最近 3 个"——否则第 4 课完成后
  // 最早那节课的目标会被挤出集合，链的后继被误判为"无关方向"）
  const practiced = new Set(conn.prepare('SELECT DISTINCT objective_id FROM learner_states WHERE account_id = ?').all(accountId).map((r) => r.objective_id))
  const allDone = conn.prepare("SELECT served_lesson_id FROM plan_decisions WHERE account_id = ? AND status = 'completed' AND served_lesson_id IS NOT NULL").all(accountId)
  for (const r of allDone) {
    const l = getLesson(r.served_lesson_id)
    for (const oid of l?.objectiveIds ?? []) practiced.add(oid)
  }
  const rows = conn.prepare(
    "SELECT lesson_id FROM lesson_versions WHERE content_status = 'published' AND account_scope IN ('global', ?) ORDER BY rowid DESC").all(accountId)
  for (const r of rows) {
    const l = getLesson(r.lesson_id)
    if (!usable(l)) continue
    if ((l.objectiveIds ?? []).some((oid) => practiced.has(oid))) {
      return { lessonId: l.lessonId, title: l.title, objectiveIds: l.objectiveIds ?? [],
        reason: `《${l.title}》与你练过的方向相关、还没学过；当前主目标的课还在准备中，可以先练它，完成后再回来定位下一步。它练的不是主目标本身——主目标缺的能力不会被它补上，也不会被它记成掌握。` }
    }
  }
  return null
}

function waitNotice(strategyId) {
  if (strategyId === 'sound_segmentation') return '听力目标的主课要音频与听校配合：合成音频课已在准备/上线（如实标注 synthetic、听力证据受限），自然讲者版本仍待录制——先用下面的备用任务保持练习节奏，它不会把阅读结果记成听力。'
  if (strategyId === 'oral_retrieval') return 'L3 口述课需站内录音（W5 接入）：口语证据保持未测，不伪造成功'
  return '当前可用内容不足：等待经审核的材料，不塞同质题凑数'
}

function decisionView(row) {
  // 40-P1：lesson_ref 新形状 = {lesson, fallback}（旧形状直接是 lesson 对象——诚实兼容）
  const ref = JSON.parse(row.lesson_ref || 'null')
  let lesson = ref?.lesson ?? ref ?? null
  let fallback = (lesson?.lessonId ? null : ref?.fallback ?? null) // 主课在，就不摆备用
  if (lesson?.lessonId) {
    const pkg = getLesson(lesson.lessonId)
    if (!pkg || pkg.contentStatus !== 'published' || pkg.version !== lesson.version || !lessonApplicable(row.account_id,pkg)) {
      lesson.lessonId=null;lesson.status='content_pending';lesson.resumeAvailable=false
      lesson.waitNotice='当前材料已经变更或不再适合这次学习安排，请等待新的合格课程。'
    }
    // 38-S3：恢复的推荐卡与新鲜推荐同口径显示内容试验预览
    lesson.contentPreview = pkg?.qualityGates?.contentPreview === true
    lesson.resumeAvailable = !!lesson.lessonId && row.status !== 'completed' && !!pkg?.activities.some(a => ensureV3Schema().prepare('SELECT 1 FROM learner_attempts_v3 WHERE account_id=? AND activity_id=? AND created_at>=? LIMIT 1').get(row.account_id,a.activityId,row.served_at ?? row.created_at))
  } else if (fallback && row.served_lesson_id === fallback.lessonId && row.status !== 'completed') {
    // 学习者已打开备用任务（取课把它记为本次 served 课）：把它作为当前可学课呈现，续作/完成走正常流程
    const fbPkg = getLesson(fallback.lessonId)
    if (fbPkg && fbPkg.contentStatus === 'published' && lessonApplicable(row.account_id, fbPkg)) {
      lesson = {
        lessonId: fallback.lessonId, version: fbPkg.version, activityId: null, role: null,
        status: 'published', devSample: fbPkg.releaseChannel === 'dev_only',
        contentPreview: fbPkg.qualityGates?.contentPreview === true,
        fallbackTask: true, fallbackReason: fallback.reason,
      }
      lesson.resumeAvailable = !!fbPkg.activities.some(a => ensureV3Schema().prepare('SELECT 1 FROM learner_attempts_v3 WHERE account_id=? AND activity_id=? AND created_at>=? LIMIT 1').get(row.account_id,a.activity_id,row.served_at ?? row.created_at))
      fallback = null
    } else fallback = null
  }
  return {
    decisionId: row.decision_id,
    requestId: row.request_id,
    triggerEvent: row.trigger_event,
    mapVersion: row.map_version,
    learnerEvidenceVersion: row.evidence_version,
    primaryGoal: row.primary_goal,
    primarySkill: Object.entries(JSON.parse(ensureV3Schema().prepare('SELECT skills FROM objective_versions WHERE objective_id=? ORDER BY version DESC LIMIT 1').get(row.primary_goal)?.skills || '{}')).find(([,role])=>role==='primary')?.[0] ?? null,
    strategyId: row.strategy_id,
    reason: row.reason,
    hypotheses: JSON.parse(row.hypotheses || '[]'),
    uncertainAreas: JSON.parse(row.uncertain_areas || '[]'),
    lesson,
    fallback,
    notChosen: JSON.parse(row.candidates || '[]'),
    status: row.status,
    createdAt: row.created_at,
  }
}
