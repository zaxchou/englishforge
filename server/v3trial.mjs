import { issueTask, taskForRecordedAttempt } from './v3tasks.mjs'
// W6：本人试学工具包（docs/curriculum-v4/13 §9 A10/T9、15 §10 T9、00 §4 P6）。
//
// 核心纪律：**先预注册，后施测**——基线/后测任务与评分维度在试学前冻结（13 §9：
// 不能试完后才选指标）；对比只认"同条件陌生材料"的作答（熟题提速不算达标，A10）；
// 原始作品与支持条件全程保留；本模块只做机制与记录，**不宣称任何学习效果**——
// 效果结论等真人两周试学后由人工判定。
import { randomBytes } from 'node:crypto'
import { ApiError } from './db.mjs'
import { ensureV3Schema } from './v3db.mjs'
import { requireAccount } from './v3api.mjs'
import { publicActivity, activityById } from './v3evidence.mjs'
import { activityFingerprint } from './v3gen.mjs'

// 试学注册表：trial_registrations（先于任何基线作答创建，注册后不可改任务定义）
function ensureTrialSchema(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS trial_registrations (
      account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      trial_id        TEXT NOT NULL,
      label           TEXT NOT NULL,
      skill           TEXT NOT NULL,
      baseline_task   TEXT NOT NULL,   -- JSON：{taskFamilyId, materialRef, dimensions, passRule}
      post_task       TEXT NOT NULL,   -- JSON：同规格陌生材料（不同讲者/内容/措辞）
      delay_task      TEXT,            -- JSON：数周后另一场景任务（可选）
      registered_at   INTEGER NOT NULL,
      PRIMARY KEY (account_id, trial_id)
    );
    CREATE TABLE IF NOT EXISTS trial_observations (
      account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      trial_id     TEXT NOT NULL,
      phase        TEXT NOT NULL,    -- baseline | post | delay
      attempt_id   TEXT NOT NULL,
      material_was_novel INTEGER NOT NULL DEFAULT 1, -- 非陌生材料的观察不计入对比
      support_snapshot TEXT NOT NULL,  -- JSON：字幕/提示/查词/播放次数（同条件判定的根据）
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (account_id, trial_id, phase)
    );
  `)
  return conn
}

/** 预注册：试学前冻结任务对（基线/后测/延迟）与评分维度。
 * R7（24 号）：正式测量必须绑定到**版本化材料**（activityId+materialVersion+量表维度），
 * 否则注册降级为 practice_only——观察仍记录，但 counted 恒 false，不进正式比较。 */
export function registerTrial(accountId, { label, skill, baselineTask, postTask, delayTask } = {}) {
  requireAccount(accountId)
  for (const [name, t] of [['baselineTask', baselineTask], ['postTask', postTask]]) {
    if (!t?.taskFamilyId || !t?.materialRef || !Array.isArray(t.dimensions) || !t.dimensions.length) {
      throw new ApiError(400, `TRIAL_REGISTRATION_INCOMPLETE: ${name} 需要 taskFamilyId/materialRef/dimensions`)
    }
  }
  if (baselineTask.taskFamilyId === postTask.taskFamilyId) {
    throw new ApiError(400, 'TRIAL_TASKS_MUST_DIFFER: 前后测不得同任务家族（陌生性要求）')
  }
  // R7：版本化绑定检查——activityId + materialVersion + 量表齐 → measurement；缺 → practice_only
  const versioned = (t) => !!t.activityId && Number.isFinite(t.materialVersion) && t.materialVersion > 0
  const mode = versioned(baselineTask) && versioned(postTask) ? 'measurement' : 'practice_only'
  // R7：同条件比较的前提是两阶段**同技能**（技能都不同就无从比较）
  if (skill && baselineTask.skill && postTask.skill && (baselineTask.skill !== postTask.skill || baselineTask.skill !== skill)) {
    throw new ApiError(400, 'TRIAL_SKILL_MISMATCH: 预注册技能与阶段任务技能不一致（可比性要求）')
  }
  const conn = ensureTrialSchema(ensureV3Schema())
  const trialId = `trial_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
  conn.prepare(
    `INSERT INTO trial_registrations (account_id, trial_id, label, skill, baseline_task, post_task, delay_task, registered_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(accountId, trialId, String(label || '未命名试学'), skill,
    JSON.stringify(baselineTask), JSON.stringify(postTask), delayTask ? JSON.stringify(delayTask) : null, Date.now())
  return {
    trialId, label, skill, mode, registeredAt: Date.now(),
    note: mode === 'measurement'
      ? '任务与量表已冻结且绑定版本化材料（13 §9：不能试完后才选指标）'
      : '未绑定版本化材料：仅练习记录，观察恒不计入正式比较（R7）',
  }
}

/** Formal issuance freezes the exposure cutoff before any current-task playback. */
export function issueTrialTask(accountId, trialId, phase) {
  requireAccount(accountId)
  if (!['baseline','post','delay'].includes(phase)) throw new ApiError(400,'TRIAL_PHASE_INVALID')
  const c = ensureTrialSchema(ensureV3Schema())
  const reg = c.prepare('SELECT * FROM trial_registrations WHERE account_id=? AND trial_id=?').get(accountId,trialId)
  if (!reg) throw new ApiError(404,'TRIAL_NOT_FOUND')
  const task = JSON.parse(reg[phase === 'baseline' ? 'baseline_task' : phase === 'post' ? 'post_task' : 'delay_task'] || 'null')
  const act = task && activityById(task.activityId)
  if (!act || act.version !== task.materialVersion || act.taskFamilyId !== task.taskFamilyId) throw new ApiError(400,'TRIAL_MATERIAL_INVALID')
  const skills = new Set(Object.values(act.skillByObjective ?? {}))
  if (!skills.has(reg.skill) || (task.skill && task.skill !== reg.skill)) throw new ApiError(400,'TRIAL_SKILL_MISMATCH')
  if (task.passRule !== 'all_slots' || !act.evaluationContract?.slots?.length || !Number.isFinite(act.complexityBand) || !act.evaluationContract || JSON.stringify(task.dimensions) !== JSON.stringify(act.evaluationContract.dimensions)) throw new ApiError(400,'TRIAL_RUBRIC_REQUIRED')
  const others = ['baseline_task','post_task','delay_task'].map(k=>JSON.parse(reg[k] || 'null')).filter(Boolean)
  if (others.some(t => JSON.stringify(t.dimensions) !== JSON.stringify(task.dimensions) || t.passRule !== task.passRule || activityById(t.activityId)?.complexityBand !== act.complexityBand || !Object.values(activityById(t.activityId)?.skillByObjective ?? {}).includes(reg.skill))) throw new ApiError(400,'TRIAL_TASKS_NOT_COMPARABLE')
  const need = phase === 'post' ? 'baseline' : phase === 'delay' ? 'post' : null
  if (need && !c.prepare('SELECT 1 FROM trial_observations WHERE account_id=? AND trial_id=? AND phase=?').get(accountId,trialId,need)) throw new ApiError(400,'TRIAL_PHASE_ORDER')
  if (c.prepare('SELECT 1 FROM trial_observations WHERE account_id=? AND trial_id=? AND phase=?').get(accountId,trialId,phase)) throw new ApiError(409,'TRIAL_PHASE_ALREADY_RECORDED')
  const issued = issueTask(accountId,act.activityId,'',{trialId,phase})
  const activity = publicActivity(act)
  activity.hints = [] // formal input does not reveal support or scoring anchors
  return { ...issued, activity, phase }
}

/** 记录观察：绑定 attempt（陌生材料才计入对比；support 快照用于同条件判定） */
export function recordObservation(accountId, { trialId, phase, attemptId, materialWasNovel = true, support = {} } = {}) {
  requireAccount(accountId)
  if (!['baseline', 'post', 'delay'].includes(phase)) throw new ApiError(400, 'TRIAL_PHASE_INVALID')
  const conn = ensureTrialSchema(ensureV3Schema())
  const reg = conn.prepare('SELECT * FROM trial_registrations WHERE account_id = ? AND trial_id = ?').get(accountId, trialId)
  if (!reg) throw new ApiError(404, 'TRIAL_NOT_FOUND: ' + trialId)
  const attempt = conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id = ? AND attempt_id = ?').get(accountId, attemptId)
  if (!attempt) throw new ApiError(404, 'ATTEMPT_NOT_FOUND: ' + attemptId)
  // F7：事后预注册不能计入既往作答——观察必须晚于预注册
  if (attempt.created_at < reg.registered_at) {
    throw new ApiError(400, 'TRIAL_OBSERVATION_PREDAATES_REGISTRATION: 该作答早于预注册，不能当试学观察（防事后补录）')
  }
  // F7：基线不可覆盖——同一 phase 已有记录时拒绝（纠错=新增带理由的更正记录）
  const existing = conn.prepare('SELECT rowid FROM trial_observations WHERE account_id = ? AND trial_id = ? AND phase = ?')
    .get(accountId, trialId, phase)
  if (existing) throw new ApiError(409, 'TRIAL_PHASE_ALREADY_RECORDED: 该阶段已有观察（append-only；纠错请另立记录并说明理由）')
  // C3（复审 P2）：delay 阶段必须预注册过 delay_task——"先注册后施测"对延迟测同样生效。
  // 这道门在阶段顺序之前：没有预注册的 delay 连"合法阶段"都不是
  const taskKey = phase === 'baseline' ? 'baseline_task' : phase === 'post' ? 'post_task' : 'delay_task'
  const task = JSON.parse(reg[taskKey] || 'null')
  if (!task || !task.taskFamilyId) {
    throw new ApiError(400, `TRIAL_${phase.toUpperCase()}_NOT_PREREGISTERED: 该阶段没有预注册任务（不能事后指派）`)
  }
  // 阶段顺序：post 需先有 baseline；delay 需先有 post
  const needPrev = phase === 'post' ? 'baseline' : phase === 'delay' ? 'post' : null
  if (needPrev && !conn.prepare('SELECT 1 FROM trial_observations WHERE account_id = ? AND trial_id = ? AND phase = ?')
    .get(accountId, trialId, needPrev)) {
    throw new ApiError(400, 'TRIAL_PHASE_ORDER: 先记录 ' + needPrev + ' 再记录 ' + phase)
  }
  // 陌生性核对：attempt 的任务家族必须与该 phase 预注册任务一致
  if (attempt.task_family_id !== task.taskFamilyId) {
    throw new ApiError(400, 'TRIAL_TASK_FAMILY_MISMATCH: 该 attempt 不是预注册的任务家族')
  }
  // C3（F7 残留）：材料版本绑定——预注册了 activityId / materialVersion 时逐一核对，
  // 防止"同名材料换版本"或"错材料"混进正式比较。版本以作答落库时的 activity_version
  // 为准（复审 P3：静态活动日后升版不该 retroactively 改判旧作答），缺失回落当前定义
  const issued = attempt.issued_task_id ? taskForRecordedAttempt(accountId,attempt) : null
  const actDef = issued?.definition ?? activityById(attempt.activity_id)
  const attemptVersion = attempt.activity_version ?? actDef?.version ?? 1
  if (task.activityId && attempt.activity_id !== task.activityId) {
    throw new ApiError(400, 'TRIAL_MATERIAL_MISMATCH: 该 attempt 不是预注册的材料')
  }
  if (task.materialVersion && attemptVersion !== task.materialVersion) {
    throw new ApiError(400, `TRIAL_MATERIAL_VERSION_MISMATCH: 预注册版本 ${task.materialVersion}，实际 ${attemptVersion}`)
  }
  // R7：注册档位——measurement（版本化绑定）才可能正式计入；practice_only 恒不计入
  const versioned = (t) => !!t.activityId && Number.isFinite(t.materialVersion) && t.materialVersion > 0
  const mode = versioned(JSON.parse(reg.baseline_task || '{}')) && versioned(JSON.parse(reg.post_task || '{}'))
    ? 'measurement' : 'practice_only'
  // R7：曝光核对=服务端全部记录的并集，覆盖自报——
  // ① 同活动既往作答；② 取过题/播过/看过提示（support 事件，"看了没答"也算曝光）；
  // ③ 内容指纹与既往作答材料相同（同稿改名现形）
  const validIssuance = issued?.trial_id === trialId && issued?.trial_phase === phase
  const cutoff = validIssuance ? issued.issued_at : attempt.created_at
  const priorAttempts = conn.prepare(
    'SELECT activity_id FROM learner_attempts_v3 WHERE account_id = ? AND attempt_id <> ? AND created_at <= ?')
    .all(accountId, attemptId, cutoff)
  const priorSupport = conn.prepare(
    "SELECT 1 AS x FROM activity_support_events WHERE account_id = ? AND activity_id = ? AND created_at <= ? LIMIT 1")
    .get(accountId, attempt.activity_id, cutoff)
  const priorTasks = conn.prepare("SELECT 1 FROM issued_tasks WHERE account_id=? AND activity_id=? AND task_id<>? AND issued_at<=? LIMIT 1").get(accountId,attempt.activity_id,issued?.task_id ?? '',cutoff)
  const thisFp = actDef ? activityFingerprint(actDef) : null
  const fpClash = thisFp && priorAttempts.some((p) => {
    const other = activityById(p.activity_id)
    return other && activityFingerprint(other) === thisFp && p.activity_id !== attempt.activity_id
  })
  const priorAudio = actDef?.audioRef && conn.prepare('SELECT 1 FROM task_media_deliveries d JOIN issued_tasks t ON t.task_id=d.task_id WHERE t.account_id=? AND d.media_id=? AND t.task_id<>? AND d.delivered_at<=? LIMIT 1').get(accountId,actDef.audioRef,issued?.task_id ?? '',cutoff)
  const exposed = !!priorAudio || priorAttempts.some((p) => p.activity_id === attempt.activity_id) || !!priorSupport || !!priorTasks || !!fpClash
  let counted = !!materialWasNovel
  let exposureNote = null
  if (attempt.evaluation_status !== 'evaluated') {
    counted=false
    exposureNote='作答尚未判定或存在争议：暂停正式计量，保留原始作品。'
  } else if (mode === 'practice_only') {
    counted = false
    exposureNote = '注册未绑定版本化材料（practice_only）：观察仅作练习记录，不计入正式比较（R7）'
  } else if (exposed) {
    counted = false
    exposureNote = `服务端记录显示该材料已曝光（${priorAttempts.some((p) => p.activity_id === attempt.activity_id) ? '已作答过' : priorSupport || priorTasks || priorAudio ? '已领取/分发/播放/看提示' : '与既往材料内容指纹相同'}）：不计入正式比较（覆盖自报）`
  } else if (actDef && actDef.holdout !== true) {
    // 已公开注册表材料不能当本人留出——正式留出必须从未公开的 holdout 池来（R7/21 §6.4）
    counted = false
    exposureNote = '该材料在公开注册表中（18/21 样例已对本人可见）：正式留出须用未公开 holdout 材料，不计入正式比较'
  } else if (!validIssuance) {
    counted = false
    exposureNote = '正式测量需要本阶段发卷任务；旧直接提交仅保存为练习记录'
  }
  conn.prepare(
    `INSERT INTO trial_observations (account_id, trial_id, phase, attempt_id, material_was_novel, support_snapshot, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(accountId, trialId, phase, attemptId, counted ? 1 : 0, JSON.stringify({ ...support, effectiveConditions: JSON.parse(attempt.conditions || '{}'), issuedTaskId: issued?.task_id ?? null, serverExposureNote: exposureNote, mode }), Date.now())
  return { ok: true, trialId, phase, counted, exposureNote }
}

/** 对比：同条件陌生材料前后测并排（原始作品 + 支持条件 + 分维度结论留白给人工）。
 * C3：可比性由服务端按关键支持条件判定——条件不同可展示，但不标"同条件"（20 号 F7 验收）。 */
const SAME_CONDITION_KEYS = ['firstExposure', 'transcriptShown', 'hintLevel', 'lookupUsed', 'playCount']
export function compareTrial(accountId, trialId) {
  requireAccount(accountId)
  const conn = ensureTrialSchema(ensureV3Schema())
  const reg = conn.prepare('SELECT * FROM trial_registrations WHERE account_id = ? AND trial_id = ?').get(accountId, trialId)
  if (!reg) throw new ApiError(404, 'TRIAL_NOT_FOUND: ' + trialId)
  const obs = conn.prepare('SELECT * FROM trial_observations WHERE account_id = ? AND trial_id = ?').all(accountId, trialId)
  const pick = (phase) => {
    const o = obs.find((x) => x.phase === phase)
    if (!o) return null
    const a = conn.prepare('SELECT * FROM learner_attempts_v3 WHERE account_id = ? AND attempt_id = ?').get(accountId, o.attempt_id)
    return a ? {
      attemptId: a.attempt_id, activityId: a.activity_id, response: JSON.parse(a.response || '{}'),
      conditions: JSON.parse(a.conditions || '{}'), evaluation: JSON.parse(a.evaluation || 'null'),
      counted: !!o.material_was_novel && a.evaluation_status === 'evaluated',
      originallyCounted: !!o.material_was_novel, evaluationStatus:a.evaluation_status,
      exclusionNote: a.evaluation_status !== 'evaluated' ? '作答存在争议或未判定，当前不计入比较；原观察保留。' : null, support: JSON.parse(o.support_snapshot || '{}'),
    } : null
  }
  const baseline = pick('baseline')
  const post = pick('post')
  const sameCondition = !!(baseline && post && baseline.counted && post.counted
    && SAME_CONDITION_KEYS.every((k) => JSON.stringify(baseline.conditions?.[k]) === JSON.stringify(post.conditions?.[k])))
  return {
    trialId, label: reg.label, skill: reg.skill,
    registration: { baseline: JSON.parse(reg.baseline_task), post: JSON.parse(reg.post_task), delay: reg.delay_task ? JSON.parse(reg.delay_task) : null },
    baseline, post, delay: pick('delay'),
    sameCondition,
    comparabilityNote: sameCondition
      ? '关键支持条件一致且双方均计为新材料：可并排人工比较'
      : '支持条件不同或材料非陌生：只作展示，不构成同条件比较',
    verdict: null,
    note: '机制只负责并排原始作品与条件；效果结论由人工按预注册量表判定——熟题提速不算达标（A10），N=1 只验证本人',
  }
}

export function listTrials(accountId) {
  requireAccount(accountId)
  const conn = ensureTrialSchema(ensureV3Schema())
  return conn.prepare('SELECT trial_id, label, skill, registered_at FROM trial_registrations WHERE account_id = ? ORDER BY registered_at DESC').all(accountId)
}
