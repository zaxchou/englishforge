import { issueTask } from './v3tasks.mjs'
// W3：可学习的纵向课程（docs/curriculum-v4/15 §7 课程包契约、§5 内容状态机）。
//
// 不变量：
// · 课程包按版本管理：published 版本不可改写（trigger 强制），修订开新版本；
// · 学习者可见的课包永远不含 holdout 答案、完整校对稿或隐藏评分要点；
//   提示按层展开（hintStages），揭晓动作由客户端逐层请求；
// · human_review='pending' 的课在 API/前端都带“开发样本”标记 —— 结构质量门
//   全过也只是可走通的样本，不冒充人审签署的正式课（18 §8）；
// · 撤回课程不删历史：撤回触发受影响尝试的证据复核事件。
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApiError } from './db.mjs'
import { ensureV3Schema } from './v3db.mjs'
import { requireAccount } from './v3api.mjs'
import { getStoredAttempt, activityById, publicActivity } from './v3evidence.mjs'
import { audioPublicInfo } from './v3audio.mjs'
import { seedMap } from './v3map.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LESSON_SEED = resolve(HERE, 'data', 'v3-lessons.json')

let lessonSeedCache = null
function loadLessonSeed() {
  if (!lessonSeedCache) lessonSeedCache = JSON.parse(readFileSync(LESSON_SEED, 'utf8'))
  return lessonSeedCache
}

// ---------------------------------------------------------------- 质量门（15 §7）

/** 结构质量门：机器可验的部分。语言事实核验、音频、人审签署不在其中 —— 缺了它们不许标 signed */
export function runQualityGates(lesson, conn = ensureV3Schema()) {
  const gates = {}
  gates.schemaComplete = !!(lesson.lessonId && lesson.title && lesson.whyNow && lesson.strategyId
    && Array.isArray(lesson.activities) && lesson.activities.length > 0)
  gates.objectivesExist = (lesson.objectiveIds ?? []).length > 0 && (lesson.objectiveIds ?? []).every((oid) =>
    conn.prepare('SELECT 1 FROM objective_versions WHERE objective_id = ?').get(oid))
  gates.activitiesExist = (lesson.activities ?? []).every((a) => {
    const act = activityById(a.activityId)
    return act && (!a.version || act.version === a.version) && a.role === act.role
      && !act.holdout // holdout 永不作为课内活动
  })
  gates.holdoutIsolated = !lesson.activities?.some((a) => activityById(a.activityId)?.holdout)
  gates.sourceRefsPresent = (lesson.sourceRefs ?? []).length > 0
  // 语义家族不重复：同一家族的多步只允许“听→看校对稿”这类条件升级（15 §7 同材料换皮才算重复）
  const byFamily = {}
  for (const a of lesson.activities ?? []) (byFamily[activityById(a.activityId)?.taskFamilyId] ??= []).push(activityById(a.activityId))
  gates.noDuplicateFamily = Object.values(byFamily).every((acts) =>
    acts.length === 1 || acts.every((act) => act?.transcriptShownByDefault) || acts.some((act) => act?.transcriptShownByDefault))
  gates.allPassed = Object.values(gates).every(Boolean)
  return gates
}

/** 种子落库：走 draft→checking→(gates)→ready→published 状态机，published 行不再改写 */
export function seedLessons() {
  const conn = ensureV3Schema()
  seedMap() // 课程包引用目标版本：先把账本播下去（幂等）
  const seed = loadLessonSeed()
  let published = 0
  for (const lesson of seed.lessons) {
    const exists = conn.prepare('SELECT 1 FROM lesson_versions WHERE lesson_id = ? AND version = ?')
      .get(lesson.lessonId, lesson.version)
    if (exists) continue
    const gates = runQualityGates(lesson, conn)
    if (!gates.allPassed) throw new Error('LESSON_GATES_FAILED: ' + lesson.lessonId + ' ' + JSON.stringify(gates))
    // 15 §5：质量门过了也只是 ready；进入学习队列必须经 publish（显式 acknowledge，无签署时为 dev_only 通道）
    conn.prepare(
      `INSERT INTO lesson_versions (account_scope, lesson_id, version, title, why_now, teaching_note, strategy_id,
         objective_ids, difficulty_dims, activity_refs, next_candidates, source_refs, holdout_ref, quality_gates,
         human_review, release_channel, content_status, created_at)
       VALUES ('global',?,?,?,?,?,?,?,?,?,?,?,?,?,'pending','dev_only','ready',?)`,
    ).run(
      lesson.lessonId, lesson.version, lesson.title, lesson.whyNow, lesson.teachingNote ?? null, lesson.strategyId,
      JSON.stringify(lesson.objectiveIds ?? []), JSON.stringify(lesson.difficultyDims ?? []),
      JSON.stringify(lesson.activities ?? []), JSON.stringify(lesson.nextCandidates ?? []),
      JSON.stringify(lesson.sourceRefs ?? []), lesson.holdoutRef ?? null, JSON.stringify(gates),
      Date.now(),
    )
    publishLesson(lesson.lessonId, { acknowledgeUnreviewed: true, by: 'seed' })
    published++
  }
  return { lessons: seed.lessons.length, seeded: published, holdoutNote: seed.lessons.find((l) => l.holdoutNote)?.holdoutNote ?? null }
}

function rowToLesson(r) {
  return {
    lessonId: r.lesson_id, version: r.version, title: r.title, whyNow: r.why_now,
    strategyId: r.strategy_id, objectiveIds: JSON.parse(r.objective_ids || '[]'),
    difficultyDims: JSON.parse(r.difficulty_dims || '[]'), activities: JSON.parse(r.activity_refs || '[]'),
    nextCandidates: JSON.parse(r.next_candidates || '[]'), sourceRefs: JSON.parse(r.source_refs || '[]'),
    teachingNote: r.teaching_note, holdoutRef: r.holdout_ref, qualityGates: JSON.parse(r.quality_gates || '{}'),
    humanReview: r.human_review, releaseChannel: r.release_channel, contentStatus: r.content_status,
    accountScope: r.account_scope ?? 'global',
    withdrawnReason: r.withdrawn_reason, createdAt: r.created_at,
  }
}

export function getLesson(lessonId, version = null) {
  const conn = ensureV3Schema()
  const row = version
    ? conn.prepare('SELECT * FROM lesson_versions WHERE lesson_id = ? AND version = ?').get(lessonId, version)
    : conn.prepare('SELECT * FROM lesson_versions WHERE lesson_id = ? ORDER BY version DESC').get(lessonId)
  return row ? rowToLesson(row) : null
}

// ---------------------------------------------------------------- 学习者可见课包

/**
 * GET /lessons/:lessonId：只返回 published；无 holdout 答案与深层提示；
 * 提示以课包 hintStages 为唯一来源、只带第一层；unlockAfter 门控的活动未解锁时不出现。
 */
export function serveLesson(accountId, lessonId) {
  requireAccount(accountId)
  const lesson = getLesson(lessonId)
  if (!lesson || lesson.contentStatus !== 'published') throw new ApiError(404, 'ACTIVITY_NOT_PUBLISHED: ' + lessonId)
  // C4 纵深防御：计划层选课已按 scope 过滤，这里再拦一次直连 ID 取他人定制课
  if (lesson.accountScope && lesson.accountScope !== 'global' && lesson.accountScope !== accountId) {
    throw new ApiError(404, 'ACTIVITY_NOT_PUBLISHED: ' + lessonId)
  }
  const conn = ensureV3Schema()
  const attempted = new Set(
    conn.prepare('SELECT DISTINCT activity_id FROM learner_attempts_v3 WHERE account_id = ?').all(accountId).map((r) => r.activity_id))
  const plan = conn.prepare('SELECT decision_id,created_at,served_at FROM plan_decisions WHERE account_id=? AND served_lesson_id=? ORDER BY created_at DESC LIMIT 1').get(accountId,lessonId)
  const resumeSince = plan ? (plan.served_at ?? plan.created_at) : Date.now()
  const currentAttempted = new Set(conn.prepare('SELECT DISTINCT activity_id FROM learner_attempts_v3 WHERE account_id=? AND created_at>=?').all(accountId,resumeSince).map(a=>a.activity_id))
  const visible = lesson.activities.filter((ref) => !ref.unlockAfter || currentAttempted.has(ref.unlockAfter))
  return {
    lessonId: lesson.lessonId,
    version: lesson.version,
    sessionKey: plan?.decision_id ?? '',
    title: lesson.title,
    whyNow: lesson.whyNow,
    teachingNote: lesson.teachingNote,
    strategyId: lesson.strategyId,
    objectiveIds: lesson.objectiveIds, // R2 验收用：推荐目标必须 ∈ 这里的可测目标
    difficultyDims: lesson.difficultyDims,
    devSampleNotice: lesson.releaseChannel === 'dev_only'
      ? '开发样本：结构质量门已过、人审未签署；音频课在原声制作前如实显示待制作（18 §8）'
      : null,
    activities: visible.map((ref) => {
      const act = activityById(ref.activityId)
      const stages = ref.hintStages ?? act?.hints ?? []
      const audio = audioPublicInfo(act)
      const last = conn.prepare('SELECT attempt_id,response FROM learner_attempts_v3 WHERE account_id=? AND activity_id=? AND activity_version=? AND created_at>=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(accountId,act.activityId,act.version,resumeSince)
      // D0-1：封闭槽位题只下发槽位结构（slotId/题干/合法选项），accept 绝不下发
      const slots = Array.isArray(act?.evaluationContract?.slots)
        ? act.evaluationContract.slots.map((s) => ({ slotId: s.slotId, prompt: s.prompt, options: s.options }))
        : null
      return {
        ...issueTask(accountId, act.activityId, '', null, { ...lesson, sessionKey: plan?.decision_id ?? '' }),
        resume: last ? { response: JSON.parse(last.response), result: getStoredAttempt(accountId,last.attempt_id) } : null,
        activityId: act.activityId,
        version: act.version,
        role: ref.role ?? act.role,
        prompt: act.prompt,
        simulatesAudio: !!act.simulatesAudio,
        oralTask: !!act.oralEvidenceDeferred,
        slots,
        reasonLabel: act?.evaluationContract?.reason?.label ?? null,
        audio, // synthetic 合成音频；转写不在这（首听隐藏），l2b 的校对稿在题面里
        conditionsSpec: act.conditionsSpec,
        // 与 publicActivity 同口径：看解析后的 manifest 行，audioRef 悬空（清单缺行）时如实显示 fixture
        fixtureNotice: (act.simulatesAudio || act.oralEvidenceDeferred) && !audio
          ? '开发 fixture：仅用于验收，正式材料见 18 号文档的发布检查表' : null,
        hintStageCount: stages.length,
        firstHint: stages[0] ?? null,
        gated: !!ref.unlockAfter,
      }
    }),
    sourceRefs: lesson.sourceRefs,
    nextCandidates: lesson.nextCandidates,
    holdout: lesson.holdoutRef ? { lessonId: lesson.holdoutRef, answersIncluded: false } : null,
  }
}

/** 逐层揭示提示：只有这个调用能把下一层提示发给学习者，并留下服务端揭示记录（覆盖自报） */
export function revealHint(accountId, lessonId, activityId, level) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  const lesson = getLesson(lessonId)
  if (!lesson || lesson.contentStatus !== 'published') throw new ApiError(404, 'ACTIVITY_NOT_PUBLISHED: ' + lessonId)
  const ref = lesson.activities.find((a) => a.activityId === activityId)
  const act = activityById(activityId)
  if (!ref || !act) throw new ApiError(404, 'ACTIVITY_NOT_IN_LESSON')
  const stages = ref.hintStages ?? act.hints ?? []
  if (level < 1 || level > stages.length) throw new ApiError(400, 'HINT_LEVEL_OUT_OF_RANGE')
  if (level > 1) { // 必须逐层：跳层揭示拒绝
    const have = conn.prepare('SELECT MAX(level) AS m FROM activity_support_events WHERE account_id=? AND activity_id=? AND kind=?')
      .get(accountId, activityId, 'hint')?.m ?? 0
    if (level > have + 1) throw new ApiError(400, 'HINT_LEVEL_SKIPPED')
  }
  conn.prepare('INSERT OR IGNORE INTO activity_support_events (account_id, activity_id, kind, level, created_at) VALUES (?,?,?,?,?)')
    .run(accountId, activityId, 'hint', level, Date.now())
  return { activityId, level, hint: stages[level - 1] }
}

// ---------------------------------------------------------------- 完成 / 撤回 / 发布

/**
 * 课内活动全部有作答后调用：计划 served→completed，并**立即产生新的推荐决策**（F2：
 * 完成事件→重算→合格候选；重复完成不重复更新）。完成只认本次会话：作答须发生在
 * 取课（served）之后，且活动版本与课包一致。
 */
export function completeLesson(accountId, lessonId) {
  requireAccount(accountId)
  const conn = ensureV3Schema()
  const lesson = getLesson(lessonId)
  if (!lesson || lesson.contentStatus !== 'published') throw new ApiError(404, 'ACTIVITY_NOT_PUBLISHED: ' + lessonId)
  const plan = conn.prepare(
    "SELECT * FROM plan_decisions WHERE account_id = ? AND status = 'served' AND served_lesson_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(accountId, lessonId)
  // F2：重复完成幂等——该课已有 completed 决策就直接返回，不报错不重复更新
  const alreadyDone = conn.prepare(
    'SELECT 1 FROM plan_decisions WHERE account_id = ? AND trigger_event = ? LIMIT 1')
    .get(accountId, `lessonCompleted:${lessonId}`)
  if (!plan && alreadyDone) {
    return { ok: true, lessonId, planCompleted: true, replanNeeded: false, replanNote: '该课的完成重算已存在（不重复更新）' }
  }
  // F2：完成绑定本次课程会话——须有 served 记录，且作答晚于取课、版本一致
  if (!plan) throw new ApiError(400, 'LESSON_NOT_SERVED: 先取课（GET lessons/:id）再完成')
  const servedAt = plan.served_at ?? plan.created_at
  const attempted = new Set(
    conn.prepare('SELECT DISTINCT activity_id FROM learner_attempts_v3 WHERE account_id = ? AND created_at >= ?')
      .all(accountId, servedAt).map((r) => r.activity_id))
  const attemptVersions = new Map(conn.prepare('SELECT activity_id, activity_version FROM learner_attempts_v3 WHERE account_id = ? AND created_at >= ? ORDER BY created_at, rowid').all(accountId,servedAt).map(r=>[r.activity_id,r.activity_version]))
  const versionMismatch = lesson.activities
    .filter((ref) => attempted.has(ref.activityId))
    .filter((ref) => {
      const act = activityById(ref.activityId)
      return act && (act.version !== ref.version || attemptVersions.get(ref.activityId) !== act.version)
    })
    .map((ref) => ref.activityId)
  const missing = lesson.activities.filter((ref) => !attempted.has(ref.activityId)).map((ref) => ref.activityId)
  if (missing.length) throw new ApiError(400, 'LESSON_INCOMPLETE: 取课后未完成 ' + missing.join(','))
  if (versionMismatch.length) throw new ApiError(400, 'LESSON_VERSION_MISMATCH: ' + versionMismatch.join(','))
  // F2：重复完成不重复更新——同一 trigger 的决策已存在就直接返回
  const trigger = `lessonCompleted:${lessonId}`
  const dup = conn.prepare('SELECT decision_id FROM plan_decisions WHERE account_id = ? AND trigger_event = ? ORDER BY created_at DESC LIMIT 1')
    .get(accountId, trigger)
  const replanNeeded = !dup
  if (replanNeeded) {
    conn.prepare("UPDATE plan_decisions SET status = 'completed' WHERE account_id = ? AND decision_id = ?")
      .run(accountId, plan.decision_id)
  }
  return { ok: true, lessonId, planCompleted: !!plan, replanNeeded, replanNote: replanNeeded ? undefined : '该课的完成重算已存在（不重复更新）' }
}

/** 撤回课程（15 §5）：停止新分发 + 受影响尝试的证据复核事件（不删历史）。需显式 confirm 防误触 */
export function withdrawLesson(lessonId, reason, confirm) {
  if (confirm !== lessonId) throw new ApiError(400, 'WITHDRAW_NEEDS_CONFIRM: confirm 必须等于 lessonId（防误触；身份鉴权在多人版前另建）')
  const conn = ensureV3Schema()
  const lesson = getLesson(lessonId)
  if (!lesson) throw new ApiError(404, 'ACTIVITY_NOT_PUBLISHED: ' + lessonId)
  conn.prepare("UPDATE lesson_versions SET content_status = 'withdrawn', withdrawn_reason = ? WHERE lesson_id = ?")
    .run('WITHDRAWN: ' + String(reason || '').slice(0, 300), lessonId)
  const insEvent = conn.prepare(
    `INSERT INTO evidence_events (account_id, evidence_id, attempt_id, objective_id, skill, complexity,
       kind, condition, pass, basis, created_at) VALUES (?,?,?,?,?,?,'dispute','lesson_withdrawn',NULL,?,?)`)
  const basis = JSON.stringify({ reason: String(reason || ''), lessonId })
  const now = Date.now()
  let n = 0
  for (const ref of lesson.activities) {
    const act = activityById(ref.activityId)
    const rows = conn.prepare('SELECT account_id, attempt_id, objective_ids FROM learner_attempts_v3 WHERE activity_id = ?').all(ref.activityId)
    for (const r of rows) {
      for (const oid of JSON.parse(r.objective_ids || '[]')) {
        const skill = act?.skillByObjective?.[oid]
        if (!skill) continue // 技能映射缺失就不乱冻结别的技能槽
        insEvent.run(r.account_id, `ev_recheck_${lessonId}_${r.attempt_id}_${oid}`, r.attempt_id, oid, skill, 'base', basis, now)
        n++
      }
    }
  }
  return { ok: true, lessonId, affectedRecheckEvents: n }
}

function completedLessonIds(conn, accountId) {
  if (!accountId) return new Set()
  return new Set(
    conn.prepare("SELECT DISTINCT served_lesson_id FROM plan_decisions WHERE account_id = ? AND status = 'completed' AND served_lesson_id IS NOT NULL")
      .all(accountId).map((r) => r.served_lesson_id))
}

/**
 * ready→published 的显式发布：人审签署过的走 mainline；无人审时必须 acknowledgeUnreviewed，
 * 记为 dev_only 通道（计划与前端都会带“开发样本”标记）。
 */
export function publishLesson(lessonId, { acknowledgeUnreviewed = false, by = 'operator' } = {}) {
  const conn = ensureV3Schema()
  const lesson = getLesson(lessonId)
  if (!lesson) throw new ApiError(404, 'LESSON_NOT_FOUND: ' + lessonId)
  if (lesson.contentStatus !== 'ready') throw new ApiError(400, 'LESSON_NOT_READY: ' + lesson.contentStatus)
  const signed = lesson.humanReview === 'signed'
  if (!signed && !acknowledgeUnreviewed) throw new ApiError(400, 'PUBLISH_NEEDS_REVIEW_OR_ACK: 无人审签署时必须显式 acknowledgeUnreviewed')
  const channel = signed ? 'mainline' : 'dev_only'
  conn.prepare("UPDATE lesson_versions SET content_status = 'published', release_channel = ?, quality_gates = ? WHERE lesson_id = ?")
    .run(channel, JSON.stringify({ ...lesson.qualityGates, publishedBy: by, publishedAt: Date.now() }), lessonId)
  return { ok: true, lessonId, releaseChannel: channel }
}

/** F3：按主目标找已发布课（排除本账户已完成；返回真实版本）。个人定制内容不跨账户复用 */
export function lessonForObjective(objectiveId, { excludeCompletedFor = null } = {}) {
  const conn = ensureV3Schema()
  seedLessons()
  const done = completedLessonIds(conn, excludeCompletedFor)
  // C4：scope 过滤——公共课（global）+ 本账户的定制课；别人的定制课不可见
  const scope = excludeCompletedFor ?? '__no_account__'
  const rows = conn.prepare(
    `SELECT lesson_id, version, release_channel, objective_ids FROM lesson_versions
     WHERE content_status = 'published' AND account_scope IN ('global', ?)
     ORDER BY (release_channel = 'mainline') DESC, version DESC`).all(scope)
  for (const r of rows) {
    if (!JSON.parse(r.objective_ids || '[]').includes(objectiveId)) continue
    if (done.has(r.lesson_id)) continue // F2：已完成课不再当新课推荐；只剩已完成课时诚实返回无内容
    // R2（24 号）：带上课的实际可测目标，调用方校验"推荐目标 ∈ 课的目标"
    return { lessonId: r.lesson_id, version: r.version, devOnly: r.release_channel === 'dev_only',
      objectiveIds: JSON.parse(r.objective_ids || '[]') }
  }
  return null
}

/** 人审签署（只有一个方向：pending→signed）。签署是人对内容的结论，机器不得代签 */
export function signLesson(lessonId, { reviewer, note } = {}) {
  if (!reviewer) throw new ApiError(400, 'SIGN_NEEDS_REVIEWER')
  const conn = ensureV3Schema()
  const lesson = getLesson(lessonId)
  if (!lesson) throw new ApiError(404, 'LESSON_NOT_FOUND: ' + lessonId)
  conn.prepare("UPDATE lesson_versions SET human_review = 'signed', release_channel = 'mainline' WHERE lesson_id = ?")
    .run(lessonId)
  conn.prepare("UPDATE lesson_versions SET quality_gates = ? WHERE lesson_id = ?")
    .run(JSON.stringify({ ...lesson.qualityGates, humanSign: { reviewer: String(reviewer).slice(0, 100), note: String(note || '').slice(0, 300), at: Date.now() } }), lessonId)
  return { ok: true, lessonId, humanReview: 'signed' }
}

/** 供计划层用：策略 → 课程包。优先人审签署的 mainline 课；dev_only 课作为开发样本兜底；排除已完成。
 * R2（24 号）：策略只是排序偏好——返回带 objectiveIds，**调用方必须校验主目标 ∈ 课的可测目标**，
 * 不许借另一目标的课填空。 */
export function lessonForStrategy(strategyId, { excludeCompletedFor = null, mustIncludeObjective = null } = {}) {
  const conn = ensureV3Schema()
  seedLessons() // 幂等：课程包与账本一样随用随播种
  const done = completedLessonIds(conn, excludeCompletedFor)
  const scope = excludeCompletedFor ?? '__no_account__' // C4：同 lessonForObjective 的范围过滤
  const rows = conn.prepare(
    `SELECT lesson_id, version, release_channel, objective_ids FROM lesson_versions
     WHERE content_status = 'published' AND strategy_id = ? AND account_scope IN ('global', ?)
     ORDER BY (release_channel = 'mainline') DESC, version DESC`).all(strategyId, scope)
  for (const r of rows) {
    if (done.has(r.lesson_id)) continue // F2：同上
    const objectiveIds = JSON.parse(r.objective_ids || '[]')
    if (mustIncludeObjective && !objectiveIds.includes(mustIncludeObjective)) continue // R2：目标不匹配的课不借
    return { lessonId: r.lesson_id, version: r.version, devOnly: r.release_channel === 'dev_only', objectiveIds }
  }
  return null
}

export function listLessons() {
  seedLessons()
  return ensureV3Schema().prepare('SELECT * FROM lesson_versions ORDER BY lesson_id, version').all().map(rowToLesson)
}

/** 供计划层用：策略 → 可发布课程包（返回 lessonId；没有就 null，让计划层诚实等待） */
