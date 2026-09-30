// W4：按需生成供给（docs/curriculum-v4/15 §7 生成质量门、§11.5、§6⑧）。
//
// 铁律：
// · 生成走后台 job，绝不在学习者作答请求里调长模型（§8）；
// · 本模块自带**独立的版本化生成/审核合同**（GEN_CONTRACT_V1）—— 旧 content-ai 的
//   REVIEW_SYSTEM 以旧教材主张为不可质疑标准，与新课程的语言事实核验不兼容，
//   这里不引用它，也不复用它的提示词（15 §1 语义冲突条款）；
// · 质量门任一关键门失败 → 拒收并记录原因；重试有上限；仍失败则撤出候选，
//   计划层诚实显示"内容不足"，不循环熟题凑数（§7）；
// · 需要人审的生成（新语法解释/未核验目标）只到 ready，不自动 published（§5）；
// · 课窗 = 接下来 2 节完整课 + ≤4 个候选位置，每课后重估；新证据可作废缓存课，
//   作废留原因（T6）。
import { ensureV3Schema, getMeta, setMeta } from './v3db.mjs'
import { ApiError } from './db.mjs'
import { rowToObjective } from './v3map.mjs'
import { runQualityGates, lessonForStrategy, lessonForObjective } from './v3lessons.mjs'
import { decide } from './v3plan.mjs'
import { chatJson } from './llm.mjs'

export const GEN_CONTRACT_V1 = {
  version: 'gen-contract-v1',
  note: '新课程生成/审核合同：语言事实以 objective.sourceRefs 声明的公开资料为准；讲解风格沿用本书"做动作的/挨动作的"式白话，禁语法术语；与旧 content-ai 流水线无关。',
  system: [
    '你是这套成人英语课程的**出题与讲课模块**。给一个能力目标和学习证据摘要，产出一个课程包 JSON。',
    '硬性要求：',
    '1) 只输出 JSON：{"title","whyNow","teachingNote","explanationKind":"established|new",',
    '   "activities":[{"taskFamilyId","prompt","hints":[],"relations":[{"id","label","anyOf":[],"required"}],"mustNot":[]}],',
    '   "sourceRefs":[{"ref","claim"}]}；不要 markdown 包装。',
    '2) 每个活动至少 2 个 required 关系，可接受答案用 anyOf 关键词表达（中英文都可）。',
    '3) teachingNote 用白话讲关系（像"做动作的/挨动作的"），**禁止**主格/宾格/物主代词/三单/谓语/从句这类术语。',
    '4) sourceRefs 至少 1 条，指向该目标声明过的来源（G/C/T 代号）。',
    '5) 素材是**虚构教学情境**，不得声称真实项目/讲座；不得与给定"最近用过的家族"重复。',
  ].join('\n'),
}

const MAX_RETRIES = 2 // 首次 + 2 次重试
const WINDOW_LESSONS = 2
const WINDOW_CANDIDATES = 4

// ---------------------------------------------------------------- 活动：生成题的存取（与静态注册表同形）

function getGeneratedActivity(id) {
  const row = ensureV3Schema().prepare('SELECT definition FROM generated_activities WHERE activity_id = ?').get(id)
  return row ? JSON.parse(row.definition) : null
}

export function registerGeneratedActivities(jobId, activities) {
  const conn = ensureV3Schema()
  const ins = conn.prepare('INSERT OR REPLACE INTO generated_activities (activity_id, version, job_id, definition, created_at) VALUES (?,?,?,?,?)')
  const now = Date.now()
  const ids = []
  for (let i = 0; i < activities.length; i++) {
    const a = activities[i]
    const activityId = a.activityId || `gen_${jobId}_${i}`
    const def = {
      activityId, version: 1, role: a.role || 'practice', taskFamilyId: a.taskFamilyId,
      objectiveIds: a.objectiveIds, skillByObjective: a.skillByObjective,
      responseKind: 'text', prompt: a.prompt, hints: a.hints ?? [],
      conditionsSpec: ['firstExposure', 'hintLevel', 'transcriptShown', 'playCount', 'lookupUsed', 'responseMode'],
      evaluationContract: { dimensions: a.dimensions ?? a.relations.map((r) => r.label), relations: a.relations, mustNot: a.mustNot ?? [] },
      generated: true,
    }
    ins.run(activityId, 1, jobId, JSON.stringify(def), now)
    ids.push(activityId)
  }
  return ids
}

// ---------------------------------------------------------------- 质量门（§7，机器可验部分）

const TERM_BLACKLIST = ['主格', '宾格', '物主代词', '三单', '谓语', '从句', '定语', '状语', '系动词', '助动词', '过去分词', '现在分词']

export function validateGeneratedPackage(pkg, ctx) {
  const gates = {}
  gates.schemaComplete = !!(pkg && pkg.title && pkg.whyNow && pkg.teachingNote
    && Array.isArray(pkg.activities) && pkg.activities.length >= 2
    && pkg.activities.every((a) => a.prompt && Array.isArray(a.relations)))
  gates.answersConsistent = gates.schemaComplete && pkg.activities.every((a) =>
    a.relations.filter((r) => r.required).length >= 1
    && a.relations.every((r) => r.id && r.label && Array.isArray(r.anyOf) && r.anyOf.length >= 2))
  gates.sourcesUsable = Array.isArray(pkg.sourceRefs) && pkg.sourceRefs.length >= 1
    && pkg.sourceRefs.every((s) => s.ref && ctx.allowedSourceCodes.includes(String(s.ref).split(':')[0]))
  gates.explanationClean = typeof pkg.teachingNote === 'string'
    && !TERM_BLACKLIST.some((t) => pkg.teachingNote.includes(t))
    && pkg.activities.every((a) => !(a.explain && TERM_BLACKLIST.some((t) => a.explain.includes(t))))
  gates.familyFresh = Array.isArray(pkg.activities) && pkg.activities.every((a) =>
    a.taskFamilyId && !ctx.recentFamilies.includes(a.taskFamilyId))
  gates.holdoutIsolated = gates.schemaComplete && pkg.activities.every((a) => a.role !== 'holdout')
  gates.truncated = false // chatJson 解析失败根本到不了这里；截断=reject 上游
  gates.allPassed = ['schemaComplete', 'answersConsistent', 'sourcesUsable', 'explanationClean', 'familyFresh', 'holdoutIsolated']
    .every((k) => gates[k])
  return gates
}

function rejectReasons(gates) {
  return Object.entries(gates).filter(([k, v]) => !v && k !== 'allPassed' && k !== 'truncated')
    .map(([k]) => `${k} 未过`)
}

// ---------------------------------------------------------------- 任务

export function startGenerationJob(accountId, { objectiveId, strategyId, chat = chatJson, await: awaitIt = false } = {}) {
  const conn = ensureV3Schema()
  const dup = conn.prepare("SELECT job_id FROM generation_jobs WHERE account_id = ? AND objective_id = ? AND status IN ('queued','running')")
    .get(accountId, objectiveId)
  if (dup) return { jobId: dup.job_id, reused: true }
  const obj = conn.prepare('SELECT * FROM objective_versions WHERE objective_id = ? ORDER BY version DESC').get(objectiveId)
  if (!obj) throw new ApiError(404, 'OBJECTIVE_NOT_FOUND: ' + objectiveId)
  const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  conn.prepare(
    `INSERT INTO generation_jobs (account_id, job_id, objective_id, strategy_id, input_spec, contract_version,
       status, created_at) VALUES (?,?,?,?,?,?, 'queued', ?)`,
  ).run(accountId, jobId, objectiveId, strategyId ?? null,
    JSON.stringify({ objective: rowToObjective(obj), contract: GEN_CONTRACT_V1.version }),
    GEN_CONTRACT_V1.version, Date.now())
  const p = runJob(jobId, { chat })
  return awaitIt ? p : { jobId }
}

async function runJob(jobId, { chat }) {
  const conn = ensureV3Schema()
  const job = () => conn.prepare('SELECT * FROM generation_jobs WHERE job_id = ?').get(jobId)
  conn.prepare("UPDATE generation_jobs SET status = 'running', attempts = attempts + 1 WHERE job_id = ?").run(jobId)
  const started = Date.now()
  const spec = JSON.parse(job().input_spec)
  const objective = spec.objective

  const recentRows = conn.prepare('SELECT task_family_id FROM learner_attempts_v3 WHERE account_id = ? ORDER BY created_at DESC LIMIT 5')
    .all(job().account_id)
  const ctx = {
    recentFamilies: recentRows.map((r) => r.task_family_id).filter(Boolean),
    allowedSourceCodes: ['G1', 'G2', 'G3', 'G4', 'G5', 'C1', 'T'],
  }

  let lastReasons = []
  for (let attempt = 1; attempt <= 1 + MAX_RETRIES; attempt++) {
    try {
      const prompt = [
        GEN_CONTRACT_V1.system,
        `\n目标：${objective.objectiveId} ${objective.name}\n行为：${objective.behavior}\n边界：${objective.boundary}`,
        `可用来源代号：${ctx.allowedSourceCodes.join('、')}`,
        `最近用过的任务家族（不得重复）：${ctx.recentFamilies.join('、') || '（无）'}`,
      ].join('\n')
      let raw
      try {
        raw = await chat([{ role: 'user', content: prompt }], { maxTokens: 2000 })
      } catch (e) {
        // 模型服务失败：明确失败状态，不暗中循环旧题（§7）
        conn.prepare("UPDATE generation_jobs SET status = 'failed', reject_reasons = ?, latency_ms = ?, finished_at = ? WHERE job_id = ?")
          .run(JSON.stringify(['模型服务失败: ' + String(e.message).slice(0, 120)]), Date.now() - started, Date.now(), jobId)
        return { jobId, status: 'failed' }
      }
      let pkg
      try {
        pkg = typeof raw === 'string' ? JSON.parse(raw) : raw
      } catch {
        lastReasons = ['输出不是合法 JSON（疑似截断）']
        continue
      }
      const gates = validateGeneratedPackage(pkg, ctx)
      if (!gates.allPassed) {
        lastReasons = rejectReasons(gates)
        continue
      }
      // 拒收通过 → 落活动 + 建课包
      const activityIds = registerGeneratedActivities(jobId, pkg.activities.map((a) => ({
        ...a, objectiveIds: [objective.objectiveId],
        skillByObjective: { [objective.objectiveId]: primarySkill(objective) },
        role: 'practice',
      })))
      const lessonId = `gen-${objective.objectiveId.toLowerCase()}-v${Date.now().toString(36)}`
      const lessonSeed = {
        lessonId, version: 1, title: pkg.title, whyNow: pkg.whyNow, teachingNote: pkg.teachingNote,
        strategyId: spec.strategyId ?? 'short_explain',
        objectiveIds: [objective.objectiveId],
        difficultyDims: objective.complexityDims ?? [],
        activities: activityIds.map((id) => ({ activityId: id, role: 'practice', hintStages: (pkg.activities.find((x) => (x.activityId || `gen_${jobId}_${activityIds.indexOf(id)}`) === id)?.hints ?? []).slice(1) })),
        nextCandidates: [], sourceRefs: pkg.sourceRefs.map((s) => s.ref), holdoutRef: null,
      }
      const lg = runQualityGates(lessonSeed, conn)
      if (!lg.allPassed) { lastReasons = rejectReasons(lg); continue }
      insertGeneratedLesson(conn, lessonSeed, { jobId, model: job().model ?? 'llm', gates: lg })
      const needsSign = objective.verification !== 'claim_checked' || pkg.explanationKind === 'new'
      if (needsSign) {
        // 新解释/未核验目标：只到 ready，等签署（§5 更严格）；job 记 pending_review
        conn.prepare("UPDATE generation_jobs SET status = 'succeeded', output_lesson_id = ?, output_version = 1, validation = ?, latency_ms = ?, finished_at = ? WHERE job_id = ?")
          .run(lessonId, JSON.stringify({ gates: lg, published: false, pending: 'human_sign' }), Date.now() - started, Date.now(), jobId)
        return { jobId, status: 'succeeded', lessonId, published: false }
      }
      const { publishLesson } = await import('./v3lessons.mjs')
      publishLesson(lessonId, { acknowledgeUnreviewed: true, by: 'generator:' + jobId })
      conn.prepare("UPDATE generation_jobs SET status = 'succeeded', output_lesson_id = ?, output_version = 1, validation = ?, latency_ms = ?, finished_at = ? WHERE job_id = ?")
        .run(lessonId, JSON.stringify({ gates: lg, published: true, channel: 'dev_only' }), Date.now() - started, Date.now(), jobId)
      return { jobId, status: 'succeeded', lessonId, published: true }
    } catch (e) {
      lastReasons = ['管线异常: ' + String(e.message).slice(0, 160)]
    }
  }
  conn.prepare("UPDATE generation_jobs SET status = 'rejected', reject_reasons = ?, latency_ms = ?, finished_at = ? WHERE job_id = ?")
    .run(JSON.stringify(lastReasons), Date.now() - started, Date.now(), jobId)
  return { jobId, status: 'rejected', reasons: lastReasons }
}

function insertGeneratedLesson(conn, seed, { jobId, gates }) { // 已由 runJob 校验并通过质量门
  void jobId
  conn.prepare(
    `INSERT INTO lesson_versions (account_scope, lesson_id, version, title, why_now, teaching_note, strategy_id,
       objective_ids, difficulty_dims, activity_refs, next_candidates, source_refs, holdout_ref, quality_gates,
       human_review, release_channel, content_status, created_at)
     VALUES ('global',?,?,?,?,?,?,?,?,?,?,?,?,?,'pending','dev_only','ready',?)`,
  ).run(
    seed.lessonId, seed.version, seed.title, seed.whyNow, seed.teachingNote, seed.strategyId,
    JSON.stringify(seed.objectiveIds), JSON.stringify(seed.difficultyDims), JSON.stringify(seed.activities),
    JSON.stringify(seed.nextCandidates), JSON.stringify(seed.sourceRefs), seed.holdoutRef,
    JSON.stringify({ ...gates, generated: { jobId, contract: GEN_CONTRACT_V1.version } }), Date.now(),
  )
}

function primarySkill(objRow) {
  const skills = typeof objRow.skills === 'string' ? JSON.parse(objRow.skills || '{}') : (objRow.skills ?? {})
  return Object.keys(skills).find((k) => skills[k] === 'primary') ?? 'reading'
}

// ---------------------------------------------------------------- 课窗（2 完整课 + ≤4 候选）

/**
 * 每课后重估：目标位有已发布课 → 缓存；没有 → 起生成任务（同目标不重复排队）。
 * 返回窗口摘要（给前端"后继已备/正在准备"的诚实状态）。
 */
export function ensureWindow(accountId, { chat = chatJson } = {}) {
  const conn = ensureV3Schema()
  const objectives = conn.prepare("SELECT * FROM objective_versions WHERE status != 'retired' ORDER BY objective_id").all().map(rowToObjective)
  const snapshot = buildLiteSnapshot(conn, accountId)
  const decision = decide(objectives, readStates(conn, accountId), snapshot)
  const order = [decision.primaryGoal, ...snap((decision.candidates ?? []).map((n) => n.objectiveId))]
    .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, WINDOW_LESSONS + WINDOW_CANDIDATES)

  const slots = []
  order.forEach((oid, slot) => {
    const wantLesson = slot < WINDOW_LESSONS
    const cached = conn.prepare("SELECT * FROM lesson_cache WHERE account_id = ? AND objective_id = ? AND status = 'ready'")
      .get(accountId, oid)
    if (cached) {
      slots.push({ slot, objectiveId: oid, lessonId: cached.lesson_id, status: 'ready', kind: wantLesson ? 'lesson' : 'candidate' })
      return
    }
    const obj = objectives.find((o) => o.objectiveId === oid)
    const existing = (slot === 0 && snapshot.diagnostic?.strategyId && lessonForStrategy(snapshot.diagnostic.strategyId))
      || lessonForObjective(oid)
    if (existing?.lessonId) {
      cacheLesson(accountId, oid, existing.lessonId, 1, slot)
      slots.push({ slot, objectiveId: oid, lessonId: existing.lessonId, status: 'ready', kind: wantLesson ? 'lesson' : 'candidate' })
      return
    }
    if (!wantLesson) { slots.push({ slot, objectiveId: oid, status: 'candidate_position_only' }); return }
    if (!process.env.ENGLISHFORGE_V4_GENERATION) {
      // 生成默认关闭：诚实告知，不悄悄计费（16 §5：付费/模型使用要显式开启）
      slots.push({ slot, objectiveId: oid, status: 'generation_disabled', note: '设 ENGLISHFORGE_V4_GENERATION=1 开启按需生成' })
      return
    }
    const job = startGenerationJob(accountId, { objectiveId: oid, strategyId: obj?.strategies?.[0], chat })
    slots.push({ slot, objectiveId: oid, jobId: job.jobId, jobReused: !!job.reused, status: 'generating' })
  })
  return { accountId, windowVersion: getMeta(accountId, 'window_version') ?? 0, slots }
}

function snap(arr) { return Array.isArray(arr) ? arr : [] }

function readStates(conn, accountId) {
  const map = new Map()
  for (const s of conn.prepare('SELECT * FROM learner_states WHERE account_id = ?').all(accountId)) {
    map.set(`${s.objective_id}|${s.skill}`, { objectiveId: s.objective_id, skill: s.skill, state: s.state, flags: JSON.parse(s.flags || '[]') })
  }
  return map
}

function buildLiteSnapshot(conn, accountId) {
  const recent = conn.prepare('SELECT activity_id, task_family_id, role, objective_ids, evaluation, created_at FROM learner_attempts_v3 WHERE account_id = ? ORDER BY created_at DESC LIMIT 10').all(accountId)
    .map((r) => ({ activityId: r.activity_id, taskFamilyId: r.task_family_id, role: r.role, objectiveIds: JSON.parse(r.objective_ids || '[]'), pass: JSON.parse(r.evaluation || '{}')?.pass ?? null, createdAt: r.created_at }))
  const lastDiag = conn.prepare("SELECT tentative FROM diagnostic_sessions WHERE account_id = ? AND status = 'completed' ORDER BY updated_at DESC LIMIT 1").get(accountId)
  return {
    mapVersion: 'map-v1', evidenceVersion: evVersion(conn, accountId), states: [...readStates(conn, accountId).values()],
    recentAttempts: recent, diagnostic: lastDiag?.tentative ? JSON.parse(lastDiag.tentative) : null,
    disputedActivities: JSON.parse(getMeta(accountId, 'disputed_activities') || '[]'),
    waivers: [...readStates(conn, accountId).values()].filter((s) => s.flags.includes('waived_by_user')).map((s) => ({ objectiveId: s.objectiveId, skill: s.skill })),
    objectiveCount: 0,
  }
}

function evVersion(conn, accountId) {
  const row = conn.prepare('SELECT value FROM v3_counters WHERE account_id = ? AND name = ?').get(accountId, 'evidence')
  return row ? row.value : 0
}

export function cacheLesson(accountId, objectiveId, lessonId, version, slot) {
  ensureV3Schema().prepare(
    `INSERT OR IGNORE INTO lesson_cache (account_id, objective_id, lesson_id, version, slot, status, created_at)
     VALUES (?,?,?,?,?,'ready',?)`).run(accountId, objectiveId, lessonId, version, slot, Date.now())
}

/**
 * T6：新证据作废缓存。每课后（或显式触发）比对证据版本：缓存建立时的证据版本
 * 已过期 → invalidated + 原因；作废计数进指标。
 */
export function reestimateWindow(accountId, trigger = 'manual') {
  const conn = ensureV3Schema()
  const currentVersion = evVersion(conn, accountId)
  const rows = conn.prepare("SELECT rowid, objective_id, lesson_id, slot, created_at FROM lesson_cache WHERE account_id = ? AND status = 'ready'").all(accountId)
  let invalidated = 0
  for (const r of rows) {
    // 缓存建立后若证据前进（任何新尝试/事件），旧缓存课必须重估（可保留也可作废；v1 从严：一律作废重算）
    const eventsAfter = conn.prepare('SELECT COUNT(*) AS n FROM evidence_events WHERE account_id = ? AND created_at > ?')
      .get(accountId, r.created_at).n
    if (eventsAfter > 0) {
      conn.prepare("UPDATE lesson_cache SET status = 'invalidated', invalidated_reason = ? WHERE rowid = ?")
        .run(`evidence_changed:${currentVersion}:trigger=${trigger}`, r.rowid)
      invalidated++
    }
  }
  const v = (getMeta(accountId, 'window_version') ?? 0) + 1
  setMeta(accountId, 'window_version', v)
  return { windowVersion: v, invalidated, currentVersion }
}

// ---------------------------------------------------------------- 指标（§7：时延/费用/拒收/弃用）

export function generationMetrics(accountId) {
  const conn = ensureV3Schema()
  const one = (sql, ...a) => conn.prepare(sql).get(...a)
  const jobs = one(`SELECT COUNT(*) AS n FROM generation_jobs WHERE account_id = ?`, accountId).n
  const ok = one(`SELECT COUNT(*) AS n FROM generation_jobs WHERE account_id = ? AND status = 'succeeded'`, accountId).n
  const rejected = one(`SELECT COUNT(*) AS n FROM generation_jobs WHERE account_id = ? AND status = 'rejected'`, accountId).n
  const failed = one(`SELECT COUNT(*) AS n FROM generation_jobs WHERE account_id = ? AND status = 'failed'`, accountId).n
  const lat = one(`SELECT AVG(latency_ms) AS v, SUM(cost_tokens) AS t FROM generation_jobs WHERE account_id = ? AND finished_at IS NOT NULL`, accountId)
  const inv = one(`SELECT COUNT(*) AS n FROM lesson_cache WHERE account_id = ? AND status = 'invalidated'`, accountId).n
  const running = conn.prepare(`SELECT job_id, objective_id, status FROM generation_jobs WHERE account_id = ? AND status IN ('queued','running')`).all(accountId)
  return {
    jobs, succeeded: ok, rejected, failed,
    rejectionRate: jobs ? +(rejected / jobs).toFixed(2) : 0,
    avgLatencyMs: Math.round(lat.v ?? 0),
    totalCostTokens: lat.t ?? 0,
    invalidatedCache: inv,
    inFlight: running,
    note: '费用按 token 记账（真实模型调用时写入）；开发 fixture 调用 token 记 0',
  }
}

export function listJobs(accountId, limit = 20) {
  return ensureV3Schema().prepare('SELECT job_id, objective_id, strategy_id, status, attempts, output_lesson_id, validation, reject_reasons, latency_ms, cost_tokens, created_at, finished_at FROM generation_jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(accountId, limit)
}

