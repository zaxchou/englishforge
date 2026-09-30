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
import { activityById } from './v3evidence.mjs'

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

/** 预注册：试学前冻结任务对（基线/后测/延迟）与评分维度 */
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
  const conn = ensureTrialSchema(ensureV3Schema())
  const trialId = `trial_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
  conn.prepare(
    `INSERT INTO trial_registrations (account_id, trial_id, label, skill, baseline_task, post_task, delay_task, registered_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(accountId, trialId, String(label || '未命名试学'), skill,
    JSON.stringify(baselineTask), JSON.stringify(postTask), delayTask ? JSON.stringify(delayTask) : null, Date.now())
  return { trialId, label, skill, registeredAt: Date.now(), note: '任务与量表已冻结（13 §9：不能试完后才选指标）' }
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
  const actDef = activityById(attempt.activity_id)
  const attemptVersion = attempt.activity_version ?? actDef?.version ?? 1
  if (task.activityId && attempt.activity_id !== task.activityId) {
    throw new ApiError(400, 'TRIAL_MATERIAL_MISMATCH: 该 attempt 不是预注册的材料')
  }
  if (task.materialVersion && attemptVersion !== task.materialVersion) {
    throw new ApiError(400, `TRIAL_MATERIAL_VERSION_MISMATCH: 预注册版本 ${task.materialVersion}，实际 ${attemptVersion}`)
  }
  // C3（F7 残留）：曝光核对由服务端判定，覆盖自报——同一材料在此观察前被该账户作答过
  // 一次，材料就不再陌生（materialWasNovel 自报 true 也不计入正式比较）
  const prior = conn.prepare(
    'SELECT COUNT(*) AS n FROM learner_attempts_v3 WHERE account_id = ? AND activity_id = ? AND attempt_id <> ? AND created_at <= ?')
    .get(accountId, attempt.activity_id, attemptId, attempt.created_at).n
  let exposureNote = null
  if (prior > 0 && materialWasNovel) {
    materialWasNovel = false
    exposureNote = `该材料此前已被作答 ${prior} 次：服务端判定非陌生，不计入正式比较（覆盖自报）`
  }
  conn.prepare(
    `INSERT INTO trial_observations (account_id, trial_id, phase, attempt_id, material_was_novel, support_snapshot, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(accountId, trialId, phase, attemptId, materialWasNovel ? 1 : 0, JSON.stringify({ ...support, serverExposureNote: exposureNote }), Date.now())
  return { ok: true, trialId, phase, counted: !!materialWasNovel, exposureNote }
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
      counted: !!o.material_was_novel, support: JSON.parse(o.support_snapshot || '{}'),
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
